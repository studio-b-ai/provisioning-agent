/**
 * Slack user management + notifications — DRY_RUN aware for mutations.
 */

import pino from "pino";
import { config } from "./config.js";

const logger = pino({ level: config.logLevel });

async function slackApi(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.slackBotToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as Record<string, unknown>;
  if (!data.ok) {
    logger.warn({ method, error: data.error }, "Slack API error");
  }
  return data;
}

export async function postMessage(channel: string, text: string): Promise<boolean> {
  if (config.dryRun) {
    logger.info({ action: "postMessage", channel, textLen: text.length, dryRun: true }, "[DRY RUN] Would post Slack message");
    return true;
  }

  const data = await slackApi("chat.postMessage", { channel, text });
  return data.ok === true;
}

export async function inviteToChannel(channelId: string, userId: string): Promise<boolean> {
  if (config.dryRun) {
    logger.info({ action: "inviteToChannel", channelId, userId, dryRun: true }, "[DRY RUN] Would invite to Slack channel");
    return true;
  }

  const data = await slackApi("conversations.invite", {
    channel: channelId,
    users: userId,
  });
  return data.ok === true;
}

export async function removeFromChannel(channelId: string, userId: string): Promise<boolean> {
  if (config.dryRun) {
    logger.info({ action: "removeFromChannel", channelId, userId, dryRun: true }, "[DRY RUN] Would remove from Slack channel");
    return true;
  }

  const data = await slackApi("conversations.kick", {
    channel: channelId,
    user: userId,
  });
  return data.ok === true;
}

export async function deactivateUser(userId: string): Promise<boolean> {
  if (config.dryRun) {
    logger.info({ action: "deactivateUser", userId, dryRun: true }, "[DRY RUN] Would deactivate Slack user (requires admin API)");
    return true;
  }

  // Note: Deactivating users requires Slack Admin API (admin.users.remove)
  // which requires Enterprise Grid or Business+ plan
  logger.warn({ userId }, "Slack user deactivation requires admin API — manual action needed");
  return false;
}

export async function lookupUserByEmail(email: string): Promise<string | null> {
  if (!config.slackBotToken) {
    logger.info({ email, dryRun: true }, "[DRY RUN] Slack not configured — skipping user lookup");
    return null;
  }

  const data = await slackApi("users.lookupByEmail", { email });
  if (data.ok && data.user) {
    return (data.user as Record<string, unknown>).id as string;
  }
  return null;
}

export async function postProvisioningNotice(
  workflowType: "onboarding" | "offboarding",
  userName: string,
  userEmail: string,
  steps: Array<{ name: string; status: string }>,
  dryRun: boolean
): Promise<boolean> {
  const emoji = workflowType === "onboarding" ? "🟢" : "🔴";
  const verb = workflowType === "onboarding" ? "Onboarded" : "Offboarded";
  const tag = dryRun ? " [DRY RUN]" : "";

  const stepList = steps
    .map((s) => {
      const icon = s.status === "success" ? "✅" : s.status === "skipped" ? "⏭️" : "❌";
      return `  ${icon} ${s.name}: ${s.status}`;
    })
    .join("\n");

  const message =
    `${emoji} *${verb}: ${userName}*${tag}\n` +
    `Email: ${userEmail}\n\n` +
    `Steps:\n${stepList}`;

  return postMessage(config.slackDeploymentsChannel, message);
}

export function isConfigured(): boolean {
  return !!config.slackBotToken;
}
