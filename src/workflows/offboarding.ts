import pino from "pino";
import { config } from "../lib/config.js";
import * as graph from "../lib/graph.js";
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

export async function runOffboarding(req: ProvisioningRequest): Promise<WorkflowResult> {
  const start = Date.now();
  const fullName = `${req.firstName} ${req.lastName}`;

  const steps: WorkflowStep[] = [
    // ─── Step 1: Disable Entra Account (blocks all SSO) ─────────
    {
      name: "Disable Entra ID account",
      order: 1,
      execute: async () => {
        const user = await graph.getUser(req.userEmail);
        if (user?.id) {
          await graph.disableUser(user.id as string);
        }
        return { disabled: true, entraUserId: user?.id };
      },
    },
    // ─── Step 2: Revoke Sessions (immediate lockout) ─────────────
    {
      name: "Revoke sign-in sessions",
      order: 2,
      execute: async () => {
        const user = await graph.getUser(req.userEmail);
        if (user?.id) {
          await graph.revokeSignInSessions(user.id as string);
        }
        return { sessionsRevoked: true };
      },
    },
    // ─── Step 3: Remove M365 Licenses ────────────────────────────
    {
      name: "Remove M365 licenses",
      order: 3,
      execute: async () => {
        const user = await graph.getUser(req.userEmail);
        if (user?.id) {
          await graph.removeLicense(user.id as string, "05e9a617-0261-4cee-bb36-b41cc5a41ab6");
        }
        return { licensesRemoved: true };
      },
      optional: true,
    },
    // ─── Step 4: Remove from Entra Groups ────────────────────────
    {
      name: "Remove from Entra groups",
      order: 4,
      execute: async () => {
        const user = await graph.getUser(req.userEmail);
        if (user?.id) {
          const groups = ["all-employees", req.department?.toLowerCase() ?? "general"];
          for (const g of groups) {
            await graph.removeFromGroup(g, user.id as string);
          }
        }
        return { groupsRemoved: true };
      },
      optional: true,
    },
    // ─── Step 5: Deactivate Acumatica Employee ───────────────────
    {
      name: "Deactivate Acumatica Employee",
      order: 5,
      execute: async () => {
        // Try to find by employee ID first, then by email
        let employeeId = req.acumaticaEmployeeId ?? null;
        if (!employeeId) {
          employeeId = await acumatica.findEmployeeByEmail(req.userEmail);
        }
        if (employeeId) {
          await acumatica.deactivateEmployee(employeeId);
          return { acumaticaEmployeeId: employeeId, deactivated: true };
        }
        return {
          note: "Acumatica Employee not found — may need manual deactivation",
          acumaticaUserNote: "Acumatica user account (login) requires manual disabling",
        };
      },
      optional: true,
    },
    // ─── Step 6: Remove Zoom Phone ───────────────────────────────
    {
      name: "Remove Zoom Phone",
      order: 6,
      execute: async () => {
        const removed = await zoom.deprovisionPhoneUser(req.userEmail);
        return { zoomPhoneRemoved: removed };
      },
      optional: true,
    },
    // ─── Step 7: Remove from GitHub Org ──────────────────────────
    {
      name: "Remove from GitHub org",
      order: 7,
      execute: async () => {
        if (req.githubUsername) {
          await github.removeFromOrg(req.githubUsername);
        } else {
          logger.info({ email: req.userEmail }, "No GitHub username — skipping org removal");
        }
        return { removed: !!req.githubUsername, username: req.githubUsername };
      },
      optional: true,
    },
    // ─── Step 8: Deactivate Slack Account ────────────────────────
    {
      name: "Deactivate Slack account",
      order: 8,
      execute: async () => {
        const slackUserId = await slack.lookupUserByEmail(req.userEmail);
        if (slackUserId) {
          await slack.deactivateUser(slackUserId);
        }
        return { slackUserId, deactivated: !!slackUserId };
      },
      optional: true,
    },
    // ─── Step 9: Archive HubSpot Contact ─────────────────────────
    {
      name: "Archive HubSpot contact",
      order: 9,
      execute: async () => {
        const contactId = await hubspot.findContactByEmail(req.userEmail);
        if (contactId) {
          await hubspot.deactivateContact(contactId);
        }
        return { hubspotContactId: contactId, archived: !!contactId };
      },
      optional: true,
    },
    // ─── Step 10: Device Wipe ────────────────────────────────────
    {
      name: "Initiate device wipe",
      order: 10,
      execute: async () => {
        logger.info({ email: req.userEmail }, "Device wipe requires manual serial number lookup");
        return { note: "Manual device wipe required" };
      },
      optional: true,
    },
    // ─── Step 11: Mailbox Forwarding ─────────────────────────────
    {
      name: "Set mailbox forwarding",
      order: 11,
      execute: async () => {
        logger.info({ email: req.userEmail }, "Mailbox forwarding requires Exchange admin action");
        return { note: "Manual mailbox forwarding setup needed" };
      },
      optional: true,
    },
    // ─── Step 12: Notification ───────────────────────────────────
    {
      name: "Send offboarding notification",
      order: 12,
      execute: async () => {
        const sent = await slack.postProvisioningNotice(
          "offboarding",
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
    "offboarding",
    req.userEmail,
    fullName,
    req.triggerSource,
    config.dryRun,
    steps.length
  );

  const results = await executeWorkflow(runId, "offboarding", req.userEmail, steps);
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
  await slack.postProvisioningNotice("offboarding", fullName, req.userEmail, results, config.dryRun);

  return {
    runId,
    workflowType: "offboarding",
    userEmail: req.userEmail,
    success: allSucceeded,
    steps: results,
    dryRun: config.dryRun,
    durationMs,
  };
}
