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

// ─── Heritage Fabrics Tenant License Catalog ────────────────────────
//
// Discovered 2026-03-02 via Graph API subscribedSkus query.
// Two-tier model:
//   "standard"       → M365 Business Premium (full employee)
//   "shared_mailbox"  → Exchange Online Plan 1 (functional mailboxes)
//
// Free/auto-assigned licenses (Power Automate Free, Power BI Free)
// are handled by Entra group-based licensing — no explicit assignment needed.
//
export const LICENSE_SKUS = {
  /** M365 Business Premium — 22 seats. Default for all employees. */
  standard: {
    skuId: "f245ecc8-75af-4f8e-b61f-27d8114de5f3",
    displayName: "M365 Business Premium",
  },
  /** Exchange Online Plan 1 — 9 seats. For shared/functional mailboxes only. */
  shared_mailbox: {
    skuId: "4b9405b0-7788-4568-add1-99614e613b69",
    displayName: "Exchange Online (Plan 1)",
  },
} as const;

export type LicenseTier = keyof typeof LICENSE_SKUS;

// ─── App Entitlement Groups ─────────────────────────────────────────
//
// Entra ID security groups that drive which provisioning steps run.
// User must be a member of the group for the corresponding app to be
// provisioned. If no groups are assigned, ALL apps are provisioned
// (backward-compatible default).
//
export const APP_GROUPS = {
  acumatica: {
    groupId: "0ab34edb-cafe-46b9-bf74-6c45be5d895b",
    displayName: "APP-Acumatica",
    provisioningStep: 4,
  },
  zoomPhone: {
    groupId: "9704aa26-9ef9-41e0-aa14-72a187d5bfc1",
    displayName: "APP-Zoom-Phone",
    provisioningStep: 5,
  },
  github: {
    groupId: "cdb53678-264c-415d-b305-73de98f3e946",
    displayName: "APP-GitHub",
    provisioningStep: 6,
  },
  slack: {
    groupId: "615d58ac-220c-467e-995a-50ac7ee86ee4",
    displayName: "APP-Slack",
    provisioningStep: 7,
  },
  hubspot: {
    groupId: "1ac6c0b9-1046-4474-8629-702189893529",
    displayName: "APP-HubSpot",
    provisioningStep: 8,
  },
} as const;

export type AppEntitlement = keyof typeof APP_GROUPS;

/**
 * Resolve which apps a user is entitled to based on Entra group membership.
 * Returns the set of APP_GROUPS keys the user has.
 * If the user has NO APP-* groups, returns ALL apps (backward-compatible).
 */
export async function resolveEntitlements(userId: string): Promise<Set<AppEntitlement>> {
  const allApps = new Set<AppEntitlement>(Object.keys(APP_GROUPS) as AppEntitlement[]);

  if (config.dryRun && (!config.entraTenantId || !config.entraClientId)) {
    logger.info({ action: "resolveEntitlements", userId, dryRun: true }, "[DRY RUN] Entra not configured — granting all apps");
    return allApps;
  }

  try {
    const memberOf = await getUserGroupIds(userId);
    const appGroupIds = new Set(Object.values(APP_GROUPS).map((g) => g.groupId));
    const matched = new Set<AppEntitlement>();

    for (const [app, group] of Object.entries(APP_GROUPS)) {
      if (memberOf.has(group.groupId)) {
        matched.add(app as AppEntitlement);
      }
    }

    // If user has zero APP-* groups, grant all (backward-compatible)
    if (matched.size === 0) {
      logger.info({ userId }, "No APP-* groups found — granting all apps (backward-compatible)");
      return allApps;
    }

    logger.info(
      { userId, entitled: [...matched], skipped: [...allApps].filter((a) => !matched.has(a)) },
      "Resolved app entitlements from Entra groups"
    );
    return matched;
  } catch (err) {
    logger.warn({ err, userId }, "Failed to resolve entitlements — granting all apps as fallback");
    return allApps;
  }
}

/**
 * Get the set of group IDs a user belongs to.
 */
export async function getUserGroupIds(userId: string): Promise<Set<string>> {
  if (!config.entraTenantId || !config.entraClientId) {
    return new Set();
  }

  try {
    const result = (await graphFetch("POST", `/users/${userId}/getMemberObjects`, {
      securityEnabledOnly: true,
    })) as { value?: string[] };
    return new Set(result.value ?? []);
  } catch (err) {
    logger.warn({ err, userId }, "Failed to fetch user group memberships");
    return new Set();
  }
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

/**
 * Get the license SKU IDs currently assigned to a user.
 * Used by offboarding to remove ALL licenses regardless of tier.
 */
export async function getUserLicenses(userId: string): Promise<string[]> {
  if (!config.entraTenantId || !config.entraClientId) {
    logger.info({ action: "getUserLicenses", userId, dryRun: true }, "[DRY RUN] Entra not configured — returning empty");
    return [];
  }

  try {
    const result = (await graphFetch("GET", `/users/${userId}?$select=assignedLicenses`)) as {
      assignedLicenses?: Array<{ skuId: string }>;
    };
    return result.assignedLicenses?.map((l) => l.skuId) ?? [];
  } catch (err) {
    logger.warn({ err, userId }, "Failed to fetch user licenses");
    return [];
  }
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
