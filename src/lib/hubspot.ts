/**
 * HubSpot contact/owner management for provisioning — DRY_RUN aware.
 */

import pino from "pino";
import { config } from "./config.js";

const logger = pino({ level: config.logLevel });

const BASE = "https://api.hubapi.com";
const headers = (): Record<string, string> => ({
  Authorization: `Bearer ${config.hubspotApiKey}`,
  "Content-Type": "application/json",
});

export async function createContact(
  email: string,
  firstName: string,
  lastName: string,
  properties?: Record<string, string>
): Promise<string | null> {
  if (config.dryRun) {
    logger.info({ action: "createContact", email, dryRun: true }, "[DRY RUN] Would create HubSpot contact");
    return `dry-run-${Date.now()}`;
  }

  const res = await fetch(`${BASE}/crm/v3/objects/contacts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      properties: {
        email,
        firstname: firstName,
        lastname: lastName,
        ...properties,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logger.warn({ status: res.status, body: text.slice(0, 200) }, "HubSpot contact creation failed");
    return null;
  }

  const data = (await res.json()) as { id: string };
  return data.id;
}

export async function deactivateContact(contactId: string): Promise<boolean> {
  if (config.dryRun) {
    logger.info({ action: "deactivateContact", contactId, dryRun: true }, "[DRY RUN] Would archive HubSpot contact");
    return true;
  }

  const res = await fetch(`${BASE}/crm/v3/objects/contacts/${contactId}`, {
    method: "DELETE",
    headers: headers(),
  });

  return res.ok;
}

export async function findContactByEmail(email: string): Promise<string | null> {
  if (!config.hubspotApiKey) {
    logger.info({ email }, "[DRY RUN] HubSpot not configured — skipping contact lookup");
    return null;
  }

  const res = await fetch(`${BASE}/crm/v3/objects/contacts/search`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      filterGroups: [
        {
          filters: [{ propertyName: "email", operator: "EQ", value: email }],
        },
      ],
      limit: 1,
    }),
  });

  if (!res.ok) return null;
  const data = (await res.json()) as { results: Array<{ id: string }> };
  return data.results[0]?.id ?? null;
}

export function isConfigured(): boolean {
  return !!config.hubspotApiKey;
}
