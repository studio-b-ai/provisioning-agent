/**
 * Microsoft Graph API client — DRY_RUN aware.
 *
 * When DRY_RUN=true (default), all mutation methods log the intended action
 * but skip actual API execution. Read operations still attempt real calls
 * if credentials are configured.
 */

import { ConfidentialClientApplication } from "@azure/msal-node";
import pino from "pino";
import { config } from "./config.js";

const logger = pino({ level: config.logLevel });

let msalClient: ConfidentialClientApplication | null = null;
let accessToken: string | null = null;
let tokenExpiresAt = 0;

function getMsalClient(): ConfidentialClientApplication {
  if (!msalClient) {
    if (!config.entraTenantId || !config.entraClientId || !config.entraClientSecret) {
      throw new Error("Entra ID credentials not configured");
    }
    msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: config.entraClientId,
        clientSecret: config.entraClientSecret,
        authority: `https://login.microsoftonline.com/${config.entraTenantId}`,
      },
    });
  }
  return msalClient;
}

async function getToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiresAt - 60_000) {
    return accessToken;
  }

  const client = getMsalClient();
  const result = await client.acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"],
  });

  if (!result?.accessToken) throw new Error("Failed to acquire Graph token");
  accessToken = result.accessToken;
  tokenExpiresAt = result.expiresOn?.getTime() ?? Date.now() + 3600_000;
  return accessToken;
}

async function graphFetch(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const token = await getToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph API ${method} ${endpoint}: ${res.status} ${text.slice(0, 300)}`);
  }

  if (res.status === 204) return {};
  return res.json();
}

// ─── DRY_RUN aware methods ──────────────────────────────────────────

export interface NewUser {
  displayName: string;
  mailNickname: string;
  userPrincipalName: string;
  password: string;
  accountEnabled: boolean;
  department?: string;
  jobTitle?: string;
  usageLocation?: string;
}

export async function createUser(user: NewUser): Promise<{ id: string } | null> {
  if (config.dryRun) {
    logger.info({ action: "createUser", user: user.userPrincipalName, dryRun: true }, "[DRY RUN] Would create Entra user");
    return { id: `dry-run-${Date.now()}` };
  }

  const result = await graphFetch("POST", "/users", {
    displayName: user.displayName,
    mailNickname: user.mailNickname,
    userPrincipalName: user.userPrincipalName,
    passwordProfile: {
      password: user.password,
      forceChangePasswordNextSignIn: true,
    },
    accountEnabled: user.accountEnabled,
    department: user.department,
    jobTitle: user.jobTitle,
    usageLocation: user.usageLocation ?? "US",
  });

  return result as { id: string };
}

export async function disableUser(userId: string): Promise<void> {
  if (config.dryRun) {
    logger.info({ action: "disableUser", userId, dryRun: true }, "[DRY RUN] Would disable Entra user");
    return;
  }

  await graphFetch("PATCH", `/users/${userId}`, { accountEnabled: false });
}

export async function assignLicense(userId: string, skuId: string): Promise<void> {
  if (config.dryRun) {
    logger.info({ action: "assignLicense", userId, skuId, dryRun: true }, "[DRY RUN] Would assign license");
    return;
  }

  await graphFetch("POST", `/users/${userId}/assignLicense`, {
    addLicenses: [{ skuId, disabledPlans: [] }],
    removeLicenses: [],
  });
}

export async function removeLicense(userId: string, skuId: string): Promise<void> {
  if (config.dryRun) {
    logger.info({ action: "removeLicense", userId, skuId, dryRun: true }, "[DRY RUN] Would remove license");
    return;
  }

  await graphFetch("POST", `/users/${userId}/assignLicense`, {
    addLicenses: [],
    removeLicenses: [skuId],
  });
}

export async function addToGroup(groupId: string, userId: string): Promise<void> {
  if (config.dryRun) {
    logger.info({ action: "addToGroup", groupId, userId, dryRun: true }, "[DRY RUN] Would add user to group");
    return;
  }

  await graphFetch("POST", `/groups/${groupId}/members/$ref`, {
    "@odata.id": `https://graph.microsoft.com/v1.0/users/${userId}`,
  });
}

export async function removeFromGroup(groupId: string, userId: string): Promise<void> {
  if (config.dryRun) {
    logger.info({ action: "removeFromGroup", groupId, userId, dryRun: true }, "[DRY RUN] Would remove user from group");
    return;
  }

  await graphFetch("DELETE", `/groups/${groupId}/members/${userId}/$ref`);
}

export async function revokeSignInSessions(userId: string): Promise<void> {
  if (config.dryRun) {
    logger.info({ action: "revokeSignInSessions", userId, dryRun: true }, "[DRY RUN] Would revoke sign-in sessions");
    return;
  }

  await graphFetch("POST", `/users/${userId}/revokeSignInSessions`);
}

export async function getUser(userPrincipalName: string): Promise<Record<string, unknown> | null> {
  if (!config.entraTenantId || !config.entraClientId) {
    logger.info({ action: "getUser", userPrincipalName, dryRun: true }, "[DRY RUN] Entra not configured — skipping lookup");
    return null;
  }

  try {
    return (await graphFetch("GET", `/users/${userPrincipalName}`)) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err, userPrincipalName }, "User lookup failed");
    return null;
  }
}

export function isConfigured(): boolean {
  return !!(config.entraTenantId && config.entraClientId && config.entraClientSecret);
}
