/**
 * Slack Module â User management and notifications via Slack Web API.
 *
 * Capabilities:
 *   - Lookup users by email
 *   - Invite users to channels
 *   - Post provisioning notices to #deployments
 *   - Post arbitrary messages (for lifecycle notifications)
 *   - Deactivate users (admin API â requires SCIM or Enterprise Grid)
 */

import pino from "pino";
import { config } from "./config.js";

const logger = pino({ level: config.logLevel });
const API_BASE = "https://slack.com/api";

// âââ Internal helpers âââââââââââââââââââââââââââââââââââââââââââââââââââ

async function slackFetch(
  method: string,
  body?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!config.slackBotToken) {
    throw new Error("SLACK_BOT_TOKEN not configured");
  }

  const res = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.slackBotToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await res.json()) as Record<string, unknown>;

  if (!data.ok) {
    throw new Error(`Slack ${method}: ${data.error ?? "unknown error"}`);
  }

  return data;
}

// âââ Public API âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

export function isConfigured(): boolean {
  return !!config.slackBotToken;
}

/**
 * Look up a Slack user by their email address.
 * Returns the Slack user ID or null if not found.
 */
export async function lookupUserByEmail(email: string): Promise<string | null> {
  try {
    const data = await slackFetch("users.lookupByEmail", { email });
    const user = data.user as { id: string } | undefined;
    return user?.id ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("users_not_found")) {
      logger.info({ email }, "Slack user not found by email");
      return null;
    }
    throw err;
  }
}

/**
 * Invite a user to a Slack channel by channel ID and user ID.
 */
export async function inviteToChannel(
  channelId: string,
  userId: string
): Promise<void> {
  try {
    await slackFetch("conversations.invite", {
      channel: channelId,
      users: userId,
    });
    logger.info({ channelId, userId }, "User invited to Slack channel");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "already_in_channel" is not an error
    if (msg.includes("already_in_channel")) {
      logger.info({ channelId, userId }, "User already in channel â OK");
      return;
    }
    throw err;
  }
}

/**
 * Post a generic message to a Slack channel.
 * When dryRun is true, logs the message but does not send it.
 */
export async function postMessage(
  channelId: string,
  text: string,
  dryRun: boolean = false
): Promise<string | null> {
  if (dryRun) {
    logger.info(
      { channelId, textLength: text.length, dryRun: true },
      "[DRY RUN] Would post Slack message"
    );
    return null;
  }

  const data = await slackFetch("chat.postMessage", {
    channel: channelId,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });

  const ts = (data as { ts?: string }).ts ?? null;
  logger.info({ channelId, ts }, "Slack message posted");
  return ts;
}

/**
 * Post a provisioning notice to the deployments channel.
 * Summarises the workflow outcome for the team.
 */
export async function postProvisioningNotice(
  type: "onboarding" | "offboarding",
  employeeName: string,
  employeeEmail: string,
  stepResults: Array<{ name: string; status: string; error?: string }>,
  dryRun: boolean
): Promise<boolean> {
  const channel = config.slackDeploymentsChannel;
  if (!channel) {
    logger.warn("No deployments channel configured â skipping notice");
    return false;
  }

  const succeeded = stepResults.filter(
    (s) => s.status === "success" || s.status === "dry_run"
  ).length;
  const failed = stepResults.filter((s) => s.status === "failed").length;
  const icon = failed === 0 ? "â" : "â ï¸";
  const verb = type === "onboarding" ? "onboarded" : "offboarded";
  const dryTag = dryRun ? " [DRY RUN]" : "";

  const stepLines = stepResults
    .map((s) => {
      const sIcon =
        s.status === "success" || s.status === "dry_run"
          ? "â"
          : s.status === "failed"
            ? "â"
            : "â­ï¸";
      const err = s.error ? ` â ${s.error}` : "";
      return `  ${sIcon} ${s.name}${err}`;
    })
    .join("\n");

  const text =
    `${icon} *Employee ${verb}*${dryTag}\n` +
    `*${employeeName}* (${employeeEmail})\n` +
    `${succeeded}/${stepResults.length} steps succeeded${failed > 0 ? `, ${failed} failed` : ""}\n\n` +
    stepLines;

  try {
    await postMessage(channel, text, dryRun);
    return true;
  } catch (err) {
    logger.error({ err, channel }, "Failed to post provisioning notice");
    return false;
  }
}

/**
 * Deactivate a Slack user. Requires admin.users:write scope
 * (Enterprise Grid / SCIM). Falls back to logging if not available.
 */
export async function deactivateUser(userId: string): Promise<boolean> {
  try {
    // admin.users.remove requires Enterprise Grid admin scope
    await slackFetch("admin.users.remove", {
      user_id: userId,
      // team_id would be required for Enterprise Grid
    });
    logger.info({ userId }, "Slack user deactivated");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Most workspaces don't have admin API â this is expected
    if (msg.includes("not_allowed") || msg.includes("missing_scope") || msg.includes("not_enterprise")) {
      logger.warn(
        { userId },
        "Cannot deactivate Slack user â admin API not available (manual step required)"
      );
      return false;
    }
    throw err;
  }
}
