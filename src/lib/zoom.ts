/**
 * Zoom Phone provisioning — DRY_RUN aware.
 *
 * Uses Zoom Server-to-Server OAuth for API access.
 * Workflow: User exists (via Entra SSO) → Enable Zoom Phone → Assign calling plan → Assign number
 *
 * Key endpoints:
 *   POST /phone/users/{userId}               — Enable Zoom Phone for user
 *   POST /phone/users/{userId}/calling_plans  — Assign calling plan
 *   POST /phone/users/{userId}/phone_numbers  — Assign phone number
 *   GET  /phone/users/{userId}               — Get Zoom Phone user details
 *   DELETE /phone/users/{userId}              — Remove Zoom Phone from user
 *   GET  /phone/numbers                       — List available phone numbers
 *
 * Docs: https://developers.zoom.us/docs/api/rest/reference/phone/methods/
 */

import pino from "pino";
import { config } from "./config.js";

const logger = pino({ level: config.logLevel });

const ZOOM_BASE = "https://api.zoom.us/v2";
let accessToken: string | null = null;
let tokenExpiresAt = 0;

// ─── OAuth Token ────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiresAt - 60_000) {
    return accessToken;
  }

  const credentials = Buffer.from(
    `${config.zoomClientId}:${config.zoomClientSecret}`
  ).toString("base64");

  const res = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${config.zoomAccountId}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Zoom OAuth failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  logger.info("Zoom OAuth token acquired");
  return accessToken;
}

async function zoomFetch(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const token = await getToken();

  const res = await fetch(`${ZOOM_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Zoom ${method} ${endpoint}: ${res.status} ${text.slice(0, 300)}`);
  }

  if (res.status === 204) return {};
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return {};
}

// ─── User Lookup ────────────────────────────────────────────────────

export async function findZoomUser(email: string): Promise<string | null> {
  if (!config.zoomClientId) {
    logger.info({ email }, "[DRY RUN] Zoom not configured — skipping user lookup");
    return null;
  }

  try {
    const data = (await zoomFetch("GET", `/users/${encodeURIComponent(email)}`)) as {
      id?: string;
      status?: string;
    };
    return data?.id ?? null;
  } catch (err) {
    logger.warn({ err, email }, "Zoom user lookup failed — user may not exist yet");
    return null;
  }
}

// ─── Phone Provisioning ─────────────────────────────────────────────

export interface PhoneProvisioningResult {
  zoomUserId: string | null;
  phoneEnabled: boolean;
  callingPlanAssigned: boolean;
  phoneNumber: string | null;
}

/**
 * Full Zoom Phone provisioning flow:
 * 1. Lookup Zoom user by email (should exist via Entra SSO)
 * 2. Enable Zoom Phone for user
 * 3. Assign calling plan
 * 4. Assign phone number from pool (or let Zoom auto-assign)
 */
export async function provisionPhoneUser(
  email: string,
  callingPlanId?: string
): Promise<PhoneProvisioningResult> {
  const result: PhoneProvisioningResult = {
    zoomUserId: null,
    phoneEnabled: false,
    callingPlanAssigned: false,
    phoneNumber: null,
  };

  if (config.dryRun) {
    logger.info(
      { action: "provisionPhoneUser", email, dryRun: true },
      "[DRY RUN] Would provision Zoom Phone: enable → assign plan → assign number"
    );
    return {
      zoomUserId: `dry-run-${Date.now()}`,
      phoneEnabled: true,
      callingPlanAssigned: true,
      phoneNumber: "+1-555-DRY-RUN0",
    };
  }

  // Step 1: Find the Zoom user
  const zoomUserId = await findZoomUser(email);
  if (!zoomUserId) {
    logger.warn({ email }, "Zoom user not found — they may need to sign in via SSO first");
    return result;
  }
  result.zoomUserId = zoomUserId;

  // Step 2: Enable Zoom Phone
  try {
    await zoomFetch("POST", `/phone/users`, {
      email,
      // Calling plan type 200 = Zoom Phone Pro
      calling_plans: callingPlanId
        ? [{ type: callingPlanId }]
        : undefined,
    });
    result.phoneEnabled = true;
    logger.info({ zoomUserId, email }, "Zoom Phone enabled for user");
  } catch (err) {
    const errMsg = String(err);
    // 409 = user already has Zoom Phone
    if (errMsg.includes("409")) {
      logger.info({ email }, "Zoom Phone already enabled for user");
      result.phoneEnabled = true;
    } else {
      logger.error({ err, email }, "Failed to enable Zoom Phone");
      return result;
    }
  }

  // Step 3: Assign calling plan (if specified and not already assigned in step 2)
  if (callingPlanId && !result.callingPlanAssigned) {
    try {
      await zoomFetch("POST", `/phone/users/${zoomUserId}/calling_plans`, {
        calling_plans: [{ type: parseInt(callingPlanId, 10) }],
      });
      result.callingPlanAssigned = true;
      logger.info({ zoomUserId, callingPlanId }, "Calling plan assigned");
    } catch (err) {
      logger.warn({ err, zoomUserId }, "Calling plan assignment failed (may already be assigned)");
      result.callingPlanAssigned = true; // Treat as success if already assigned
    }
  }

  // Step 4: Get assigned phone number (Zoom may auto-assign)
  try {
    const phoneUser = (await zoomFetch("GET", `/phone/users/${zoomUserId}`)) as {
      phone_numbers?: Array<{ number: string }>;
    };
    result.phoneNumber = phoneUser?.phone_numbers?.[0]?.number ?? null;
    if (result.phoneNumber) {
      logger.info({ zoomUserId, phoneNumber: result.phoneNumber }, "Phone number assigned");
    }
  } catch (err) {
    logger.warn({ err, zoomUserId }, "Could not retrieve phone number assignment");
  }

  return result;
}

/**
 * Remove Zoom Phone from a user (offboarding).
 * Unassigns phone number and removes phone license.
 */
export async function deprovisionPhoneUser(email: string): Promise<boolean> {
  if (config.dryRun) {
    logger.info(
      { action: "deprovisionPhoneUser", email, dryRun: true },
      "[DRY RUN] Would remove Zoom Phone from user"
    );
    return true;
  }

  const zoomUserId = await findZoomUser(email);
  if (!zoomUserId) {
    logger.warn({ email }, "Zoom user not found for deprovisioning");
    return false;
  }

  try {
    // Remove Zoom Phone (unassigns number + removes calling plan)
    await zoomFetch("DELETE", `/phone/users/${zoomUserId}`);
    logger.info({ zoomUserId, email }, "Zoom Phone removed from user");
    return true;
  } catch (err) {
    logger.error({ err, email }, "Zoom Phone deprovisioning failed");
    return false;
  }
}

/**
 * List available (unassigned) phone numbers in the account.
 */
export async function listAvailableNumbers(): Promise<Array<{ id: string; number: string }>> {
  if (config.dryRun || !config.zoomClientId) {
    return [];
  }

  try {
    const data = (await zoomFetch("GET", "/phone/numbers?type=unassigned&page_size=30")) as {
      phone_numbers?: Array<{ id: string; number: string }>;
    };
    return data?.phone_numbers ?? [];
  } catch (err) {
    logger.warn({ err }, "Failed to list available Zoom phone numbers");
    return [];
  }
}

export function isConfigured(): boolean {
  return !!(config.zoomClientId && config.zoomClientSecret && config.zoomAccountId);
}
