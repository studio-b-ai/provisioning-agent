/**
 * GitHub Organization membership management — DRY_RUN aware.
 */

import { Octokit } from "@octokit/rest";
import pino from "pino";
import { config } from "./config.js";

const logger = pino({ level: config.logLevel });

function getOctokit(): Octokit {
  if (!config.githubToken) throw new Error("GITHUB_TOKEN not configured");
  return new Octokit({ auth: config.githubToken });
}

export async function inviteToOrg(email: string, role: "member" | "admin" = "member"): Promise<boolean> {
  if (config.dryRun) {
    logger.info({ action: "inviteToOrg", email, org: config.githubOrg, role, dryRun: true }, "[DRY RUN] Would invite to GitHub org");
    return true;
  }

  try {
    const octokit = getOctokit();
    await octokit.orgs.createInvitation({
      org: config.githubOrg,
      email,
      role: role === "admin" ? "admin" : "direct_member",
    });
    logger.info({ email, org: config.githubOrg }, "GitHub org invitation sent");
    return true;
  } catch (err) {
    logger.error({ err, email }, "GitHub invitation failed");
    return false;
  }
}

export async function removeFromOrg(username: string): Promise<boolean> {
  if (config.dryRun) {
    logger.info({ action: "removeFromOrg", username, org: config.githubOrg, dryRun: true }, "[DRY RUN] Would remove from GitHub org");
    return true;
  }

  try {
    const octokit = getOctokit();
    await octokit.orgs.removeMember({
      org: config.githubOrg,
      username,
    });
    logger.info({ username, org: config.githubOrg }, "Removed from GitHub org");
    return true;
  } catch (err) {
    logger.error({ err, username }, "GitHub removal failed");
    return false;
  }
}

export async function addToTeam(teamSlug: string, username: string): Promise<boolean> {
  if (config.dryRun) {
    logger.info({ action: "addToTeam", teamSlug, username, dryRun: true }, "[DRY RUN] Would add to GitHub team");
    return true;
  }

  try {
    const octokit = getOctokit();
    await octokit.teams.addOrUpdateMembershipForUserInOrg({
      org: config.githubOrg,
      team_slug: teamSlug,
      username,
      role: "member",
    });
    return true;
  } catch (err) {
    logger.error({ err, teamSlug, username }, "GitHub team add failed");
    return false;
  }
}

export function isConfigured(): boolean {
  return !!config.githubToken;
}
