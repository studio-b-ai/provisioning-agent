import pino from "pino";
import { config } from "../lib/config.js";
import * as graph from "../lib/graph.js";
import { LICENSE_SKUS, APP_GROUPS, resolveEntitlements } from "../lib/graph.js";
import type { AppEntitlement } from "../lib/graph.js";
import * as github from "../lib/github-org.js";
import * as slack from "../lib/slack.js";
import * as hubspot from "../lib/hubspot.js";
import * as acumatica from "../lib/acumatica.js";
import * as zoom from "../lib/zoom.js";
import * as jamf from "../lib/jamf.js";
import { createRun, completeRun } from "../lib/db.js";
import { executeWorkflow, type WorkflowStep } from "./common.js";
import type { ProvisioningRequest, WorkflowResult } from "../types.js";

const logger = pino({ level: config.logLevel });

export async function runOnboarding(req: ProvisioningRequest): Promise<WorkflowResult> {
  const start = Date.now();
  const fullName = `${req.firstName} ${req.lastName}`;

  // Track Entra user ID across steps (set by step 1, consumed by steps 2+)
  let entraUserId: string | null = null;

  // Resolved after Step 1 — determines which app steps (4-8) run
  let entitlements: Set<AppEntitlement> | null = null;

  /** Check if user is entitled to an app. Returns true if entitlements
   *  haven't been resolved yet (backward-compatible). */
  const entitled = (app: AppEntitlement): boolean =>
    entitlements === null || entitlements.has(app);

  const steps: WorkflowStep[] = [
    // ─── Step 1: Entra ID (identity foundation) ──────────────────
    {
      name: "Create Entra ID user",
      order: 1,
      execute: async () => {
        const result = await graph.createUser({
          displayName: fullName,
          mailNickname: req.userEmail.split("@")[0],
          userPrincipalName: req.userEmail,
          password: `Welcome${Date.now().toString(36)}!`,
          accountEnabled: true,
          department: req.department,
          jobTitle: req.jobTitle,
          usageLocation: "US",
        });
        entraUserId = result?.id ?? null;
        return { entraUserId };
      },
    },
    // ─── Step 2: M365 License ────────────────────────────────────
    {
      name: "Assign M365 license",
      order: 2,
      execute: async () => {
        const userId = entraUserId ?? "dry-run-user";
        const tier = req.licenseTier ?? "standard";
        const sku = LICENSE_SKUS[tier];
        await graph.assignLicense(userId, sku.skuId);
        return { license: sku.displayName, tier, skuId: sku.skuId, userId };
      },
    },
    // ─── Step 3: Entra Security Groups + Entitlement Resolution ──
    {
      name: "Add to Entra security groups",
      order: 3,
      execute: async () => {
        const userId = entraUserId ?? "dry-run-user";

        // Add to department + all-employees groups
        const deptGroups = ["all-employees", req.department?.toLowerCase() ?? "general"];
        for (const g of deptGroups) {
          await graph.addToGroup(g, userId);
        }

        // Add to APP-* entitlement groups specified in the request
        const requestedApps = req.appEntitlements ?? [];
        const addedAppGroups: string[] = [];
        for (const app of requestedApps) {
          const group = APP_GROUPS[app];
          if (group) {
            await graph.addToGroup(group.groupId, userId);
            addedAppGroups.push(group.displayName);
          }
        }

        // Resolve entitlements: if appEntitlements was explicitly passed
        // in the request, use those directly (avoids Graph query on dry-run
        // users that don't exist yet). Otherwise query actual group membership.
        if (requestedApps.length > 0) {
          entitlements = new Set(requestedApps as AppEntitlement[]);
          logger.info({ entitlements: [...entitlements] }, "Using request-specified entitlements");
        } else {
          entitlements = await resolveEntitlements(userId);
        }

        return {
          departmentGroups: deptGroups,
          appGroups: addedAppGroups,
          entitlements: [...entitlements],
        };
      },
      optional: true,
    },
    // ─── Step 4: Acumatica Employee (requires APP-Acumatica) ─────
    {
      name: "Create Acumatica Employee",
      order: 4,
      execute: async () => {
        if (!entitled("acumatica")) {
          return { skipped: true, reason: "User not in APP-Acumatica group" };
        }
        const result = await acumatica.createEmployee({
          firstName: req.firstName,
          lastName: req.lastName,
          email: req.userEmail,
          department: req.department,
          jobTitle: req.jobTitle,
          phone: req.phone,
          branchId: req.acumaticaBranchId,
          employeeClass: req.acumaticaEmployeeClass,
        });
        return {
          acumaticaEmployeeId: result?.employeeId,
          note: "Acumatica user account (login/roles) requires manual setup — REST API limitation",
        };
      },
      optional: true,
    },
    // ─── Step 5: Zoom Phone (requires APP-Zoom-Phone) ────────────
    {
      name: "Provision Zoom Phone",
      order: 5,
      execute: async () => {
        if (!entitled("zoomPhone")) {
          return { skipped: true, reason: "User not in APP-Zoom-Phone group" };
        }
        const result = await zoom.provisionPhoneUser(
          req.userEmail,
          req.zoomCallingPlanId
        );
        return {
          zoomUserId: result.zoomUserId,
          phoneEnabled: result.phoneEnabled,
          callingPlanAssigned: result.callingPlanAssigned,
          phoneNumber: result.phoneNumber,
          note: !result.zoomUserId
            ? "User must sign in via SSO first to create Zoom account"
            : undefined,
        };
      },
      optional: true,
    },
    // ─── Step 6: GitHub Org (requires APP-GitHub) ────────────────
    {
      name: "Invite to GitHub org",
      order: 6,
      execute: async () => {
        if (!entitled("github")) {
          return { skipped: true, reason: "User not in APP-GitHub group" };
        }
        const sent = await github.inviteToOrg(req.userEmail);
        if (req.githubTeams?.length) {
          for (const team of req.githubTeams) {
            await github.addToTeam(team, req.githubUsername ?? req.userEmail.split("@")[0]);
          }
        }
        return { invited: sent, teams: req.githubTeams };
      },
      optional: true,
    },
    // ─── Step 7: Slack (requires APP-Slack) ──────────────────────
    {
      name: "Set up Slack account",
      order: 7,
      execute: async () => {
        if (!entitled("slack")) {
          return { skipped: true, reason: "User not in APP-Slack group" };
        }
        logger.info({ email: req.userEmail }, "Slack user creation requires manual invitation or SCIM provisioning");
        if (req.slackChannels?.length) {
          const slackUserId = await slack.lookupUserByEmail(req.userEmail);
          if (slackUserId) {
            for (const ch of req.slackChannels) {
              await slack.inviteToChannel(ch, slackUserId);
            }
            return { slackUserId, channels: req.slackChannels };
          }
        }
        return { note: "Manual Slack invitation needed", channels: req.slackChannels };
      },
      optional: true,
    },
    // ─── Step 8: HubSpot Contact (requires APP-HubSpot) ──────────
    {
      name: "Create HubSpot contact",
      order: 8,
      execute: async () => {
        if (!entitled("hubspot")) {
          return { skipped: true, reason: "User not in APP-HubSpot group" };
        }
        const contactId = await hubspot.createContact(
          req.userEmail,
          req.firstName,
          req.lastName,
          {
            jobtitle: req.jobTitle ?? "",
            company: "Heritage Fabrics",
          }
        );
        return { hubspotContactId: contactId };
      },
      optional: true,
    },
    // ─── Step 9: Jamf Enrollment ─────────────────────────────────
    {
      name: "Send Jamf enrollment",
      order: 9,
      execute: async () => {
        const sent = await jamf.sendEnrollmentInvitation(req.userEmail);
        return { enrolled: sent };
      },
      optional: true,
    },
    // ─── Step 10: Notification ───────────────────────────────────
    {
      name: "Send welcome notification",
      order: 10,
      execute: async () => {
        const sent = await slack.postProvisioningNotice(
          "onboarding",
          fullName,
          req.userEmail,
          [],
          config.dryRun
        );
        return { notified: sent };
      },
      optional: true,
    },
  ];

  const runId = await createRun(
    "onboarding",
    req.userEmail,
    fullName,
    req.triggerSource,
    config.dryRun,
    steps.length
  );

  const results = await executeWorkflow(runId, "onboarding", req.userEmail, steps);
  const durationMs = Date.now() - start;
  const allSucceeded = results.every((r) => r.status === "success" || r.status === "dry_run" || r.status === "skipped");

  await completeRun(
    runId,
    allSucceeded ? "completed" : "failed",
    results.filter((r) => r.status === "success" || r.status === "dry_run").length,
    results.find((r) => r.status === "failed")?.name,
    results.find((r) => r.status === "failed")?.error
  );

  // Post final summary notification with actual step results
  await slack.postProvisioningNotice("onboarding", fullName, req.userEmail, results, config.dryRun);

  return {
    runId,
    workflowType: "onboarding",
    userEmail: req.userEmail,
    success: allSucceeded,
    steps: results,
    dryRun: config.dryRun,
    durationMs,
  };
}
