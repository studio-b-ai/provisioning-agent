import pino from "pino";
import { config } from "../lib/config.js";
import * as graph from "../lib/graph.js";
import * as github from "../lib/github-org.js";
import * as slack from "../lib/slack.js";
import * as hubspot from "../lib/hubspot.js";
import * as jamf from "../lib/jamf.js";
import { createRun, completeRun } from "../lib/db.js";
import { executeWorkflow, type WorkflowStep } from "./common.js";
import type { ProvisioningRequest, WorkflowResult } from "../types.js";

const logger = pino({ level: config.logLevel });

export async function runOnboarding(req: ProvisioningRequest): Promise<WorkflowResult> {
  const start = Date.now();
  const fullName = `${req.firstName} ${req.lastName}`;

  const steps: WorkflowStep[] = [
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
        return { entraUserId: result?.id };
      },
    },
    {
      name: "Assign M365 license",
      order: 2,
      execute: async () => {
        // M365 Business Basic SKU ID (placeholder — real SKU varies per tenant)
        await graph.assignLicense("dry-run-user", "05e9a617-0261-4cee-bb36-b41cc5a41ab6");
        return { license: "M365 Business Basic" };
      },
    },
    {
      name: "Add to Entra security groups",
      order: 3,
      execute: async () => {
        // Placeholder group IDs — real IDs from Kevin's tenant
        const groups = ["all-employees", req.department?.toLowerCase() ?? "general"];
        for (const g of groups) {
          await graph.addToGroup(g, "dry-run-user");
        }
        return { groups };
      },
      optional: true,
    },
    {
      name: "Invite to GitHub org",
      order: 4,
      execute: async () => {
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
    {
      name: "Set up Slack account",
      order: 5,
      execute: async () => {
        // Slack user creation requires admin API — log for manual action
        logger.info({ email: req.userEmail }, "Slack user creation requires manual invitation or SCIM provisioning");
        if (req.slackChannels?.length) {
          const slackUserId = await slack.lookupUserByEmail(req.userEmail);
          if (slackUserId) {
            for (const ch of req.slackChannels) {
              await slack.inviteToChannel(ch, slackUserId);
            }
          }
        }
        return { note: "Manual Slack invitation needed", channels: req.slackChannels };
      },
      optional: true,
    },
    {
      name: "Create HubSpot contact",
      order: 6,
      execute: async () => {
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
    {
      name: "Send Jamf enrollment",
      order: 7,
      execute: async () => {
        const sent = await jamf.sendEnrollmentInvitation(req.userEmail);
        return { enrolled: sent };
      },
      optional: true,
    },
    {
      name: "Send welcome notification",
      order: 8,
      execute: async () => {
        const sent = await slack.postProvisioningNotice(
          "onboarding",
          fullName,
          req.userEmail,
          [], // Will be filled in after all steps
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

  // Post summary notification with actual step results
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
