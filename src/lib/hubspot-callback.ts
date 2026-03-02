/**
 * HubSpot Callback Module â Updates Employee Onboarding tickets
 * with provisioning results from the provisioning-agent.
 *
 * Responsibilities:
 *   1. Update ticket stage (Requested â Provisioning â Accounts Created / Failed)
 *   2. Set provisioning_status + provisioning_run_id on the ticket
 *   3. Add a timeline note summarising step outcomes
 *   4. Move ticket to "Complete" or "Failed" stage based on result
 */

import pino from "pino";
import { config } from "./config.js";

const logger = pino({ level: config.logLevel });

const API_BASE = "https://api.hubapi.com";

// âââ Pipeline Stage IDs (Employee Onboarding pipeline 876698717) ââââââââ

export const PIPELINE_ID = "876698717";

export const STAGES = {
  REQUESTED: "1314110372",
  APPROVED: "1314110373",
  PROVISIONING: "1314110374",
  ACCOUNTS_CREATED: "1314110038",
  HARDWARE_PENDING: "1314110039",
  COMPLETE: "1314110375",
  FAILED: "1314110040",
} as const;

// âââ Types ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

export interface TicketUpdateResult {
  ticketId: string;
  stage: string;
  provisioningStatus: string;
  noteId?: string;
  error?: string;
}

export interface StepOutcome {
  name: string;
  success: boolean;
  dryRun: boolean;
  durationMs?: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface ProvisioningOutcome {
  runId: number;
  ticketId: string;
  employeeEmail: string;
  employeeName: string;
  status: "success" | "partial" | "failed";
  steps: StepOutcome[];
  totalDurationMs: number;
}

// âââ Internal helpers âââââââââââââââââââââââââââââââââââââââââââââââââââ

function getToken(): string {
  return config.hubspotApiKey;
}

async function hubspotFetch(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const token = getToken();
  if (!token) {
    throw new Error("HUBSPOT_API_KEY not configured");
  }

  const url = `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `HubSpot ${method} ${endpoint}: ${res.status} ${text.slice(0, 300)}`
    );
  }

  if (res.status === 204) return {};
  return res.json();
}

// âââ Stage mapping ââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function stageForStatus(
  status: "success" | "partial" | "failed"
): string {
  switch (status) {
    case "success":
      return STAGES.ACCOUNTS_CREATED;
    case "partial":
      return STAGES.ACCOUNTS_CREATED; // still created, just some optional steps failed
    case "failed":
      return STAGES.FAILED;
  }
}

// âââ Build timeline note ââââââââââââââââââââââââââââââââââââââââââââââââ

function buildNote(outcome: ProvisioningOutcome): string {
  const header =
    outcome.status === "success"
      ? `â Provisioning COMPLETE for ${outcome.employeeName}`
      : outcome.status === "partial"
        ? `â ï¸ Provisioning PARTIAL for ${outcome.employeeName}`
        : `â Provisioning FAILED for ${outcome.employeeName}`;

  const lines = [
    header,
    `Email: ${outcome.employeeEmail}`,
    `Run ID: ${outcome.runId}`,
    `Duration: ${(outcome.totalDurationMs / 1000).toFixed(1)}s`,
    "",
    "Step Results:",
    ...outcome.steps.map((s) => {
      const icon = s.success ? "â" : "â";
      const dry = s.dryRun ? " [DRY RUN]" : "";
      const dur = s.durationMs ? ` (${s.durationMs}ms)` : "";
      const err = s.error ? ` â ${s.error}` : "";
      return `  ${icon} ${s.name}${dry}${dur}${err}`;
    }),
  ];

  return lines.join("\n");
}

// âââ Public API âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

/**
 * Check if callback functionality is configured
 * (requires same HUBSPOT_API_KEY as the contact-creation module)
 */
export function isConfigured(): boolean {
  return !!config.hubspotApiKey;
}

/**
 * Move a ticket to the "Provisioning" stage (called when workflow starts)
 */
export async function markProvisioning(
  ticketId: string,
  runId: number
): Promise<TicketUpdateResult> {
  if (config.dryRun) {
    logger.info(
      { ticketId, runId, dryRun: true },
      "[DRY RUN] Would mark ticket as Provisioning"
    );
    return {
      ticketId,
      stage: STAGES.PROVISIONING,
      provisioningStatus: "running",
    };
  }

  try {
    await hubspotFetch("PATCH", `/crm/v3/objects/tickets/${ticketId}`, {
      properties: {
        hs_pipeline: PIPELINE_ID,
        hs_pipeline_stage: STAGES.PROVISIONING,
        provisioning_status: "running",
        provisioning_run_id: String(runId),
      },
    });

    logger.info(
      { ticketId, runId },
      "Ticket moved to Provisioning stage"
    );

    return {
      ticketId,
      stage: STAGES.PROVISIONING,
      provisioningStatus: "running",
    };
  } catch (err) {
    logger.error(
      { err, ticketId, runId },
      "Failed to mark ticket as Provisioning"
    );
    return {
      ticketId,
      stage: "unknown",
      provisioningStatus: "running",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Report final provisioning outcome to the HubSpot ticket.
 * Updates stage, provisioning_status, provisioning_run_id, and adds a note.
 */
export async function reportOutcome(
  outcome: ProvisioningOutcome
): Promise<TicketUpdateResult> {
  const { ticketId, runId, status } = outcome;
  const targetStage = stageForStatus(status);

  if (config.dryRun) {
    logger.info(
      { ticketId, runId, status, targetStage, dryRun: true },
      "[DRY RUN] Would report provisioning outcome to ticket"
    );
    return {
      ticketId,
      stage: targetStage,
      provisioningStatus: status,
    };
  }

  try {
    // 1. Update ticket properties + stage
    await hubspotFetch("PATCH", `/crm/v3/objects/tickets/${ticketId}`, {
      properties: {
        hs_pipeline_stage: targetStage,
        provisioning_status: status,
        provisioning_run_id: String(runId),
      },
    });

    logger.info(
      { ticketId, runId, status, targetStage },
      "Ticket updated with provisioning outcome"
    );

    // 2. Add a note with detailed step results
    let noteId: string | undefined;
    try {
      const noteBody = buildNote(outcome);
      const noteResult = (await hubspotFetch(
        "POST",
        "/crm/v3/objects/notes",
        {
          properties: {
            hs_timestamp: new Date().toISOString(),
            hs_note_body: noteBody,
          },
          associations: [
            {
              to: { id: ticketId },
              types: [
                {
                  associationCategory: "HUBSPOT_DEFINED",
                  associationTypeId: 18, // note-to-ticket
                },
              ],
            },
          ],
        }
      )) as { id: string };

      noteId = noteResult.id;
      logger.info(
        { ticketId, noteId },
        "Provisioning note added to ticket"
      );
    } catch (noteErr) {
      // Note creation is non-critical â log but don't fail the callback
      logger.warn(
        { err: noteErr, ticketId },
        "Failed to add provisioning note (non-critical)"
      );
    }

    return {
      ticketId,
      stage: targetStage,
      provisioningStatus: status,
      noteId,
    };
  } catch (err) {
    logger.error(
      { err, ticketId, runId, status },
      "Failed to report provisioning outcome"
    );
    return {
      ticketId,
      stage: "unknown",
      provisioningStatus: status,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Move ticket to Complete stage (final step after hardware etc.)
 */
export async function markComplete(ticketId: string): Promise<boolean> {
  if (config.dryRun) {
    logger.info(
      { ticketId, dryRun: true },
      "[DRY RUN] Would mark ticket as Complete"
    );
    return true;
  }

  try {
    await hubspotFetch("PATCH", `/crm/v3/objects/tickets/${ticketId}`, {
      properties: {
        hs_pipeline_stage: STAGES.COMPLETE,
      },
    });
    logger.info({ ticketId }, "Ticket marked Complete");
    return true;
  } catch (err) {
    logger.error({ err, ticketId }, "Failed to mark ticket Complete");
    return false;
  }
}

/**
 * Look up a ticket by ID and return its current properties
 * (useful for the webhook handler to extract employee details)
 */
export async function getTicket(
  ticketId: string
): Promise<Record<string, string> | null> {
  try {
    const result = (await hubspotFetch(
      "GET",
      `/crm/v3/objects/tickets/${ticketId}?properties=` +
        [
          "subject",
          "hs_pipeline_stage",
          "employee_email",
          "employee_first_name",
          "employee_last_name",
          "employee_department",
          "employee_job_title",
          "employee_start_date",
          "employee_phone",
          "employee_github_username",
          "provisioning_run_id",
          "provisioning_status",
        ].join(",")
    )) as { id: string; properties: Record<string, string> };

    return { id: result.id, ...result.properties };
  } catch (err) {
    logger.error({ err, ticketId }, "Failed to fetch ticket");
    return null;
  }
}
