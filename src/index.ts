import Fastify from "fastify";
import pino from "pino";
import { config } from "./lib/config.js";
import { initDatabase, getPool } from "./lib/db.js";
import * as graph from "./lib/graph.js";
import * as github from "./lib/github-org.js";
import * as slack from "./lib/slack.js";
import * as hubspot from "./lib/hubspot.js";
import * as hubspotCallback from "./lib/hubspot-callback.js";
import * as acumatica from "./lib/acumatica.js";
import * as zoom from "./lib/zoom.js";
import { runOnboarding } from "./workflows/onboarding.js";
import { runOffboarding } from "./workflows/offboarding.js";
import type { ProvisioningRequest, WorkflowResult } from "./types.js";
import type { ProvisioningOutcome, StepOutcome, PipelineType } from "./lib/hubspot-callback.js";

const logger = pino({ level: config.logLevel });
const app = Fastify({ logger: false });

// ─── Bearer Token Auth ──────────────────────────────────────────────

function validateBearerToken(
  request: { headers: Record<string, string | string[] | undefined> },
  reply: { code: (n: number) => { send: (body: unknown) => void } }
): boolean {
  if (!config.provisionApiKey) {
    logger.warn("PROVISION_API_KEY not set — all authenticated endpoints are BLOCKED");
    reply.code(503).send({
      error: "Service not configured",
      detail: "PROVISION_API_KEY environment variable is not set. All provisioning endpoints are disabled until a key is configured.",
    });
    return false;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader || typeof authHeader !== "string") {
    reply.code(401).send({ error: "Missing Authorization header" });
    return false;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || match[1] !== config.provisionApiKey) {
    reply.code(403).send({ error: "Invalid API key" });
    return false;
  }

  return true;
}

// ─── Health Check ────────────────────────────────────────────────────

app.get("/health", async () => {
  const checks: Record<string, string> = {
    status: "ok",
    service: "provisioning-agent",
    timestamp: new Date().toISOString(),
    dryRun: String(config.dryRun),
  };

  // Check Postgres
  try {
    const pool = getPool();
    await pool.query("SELECT 1");
    checks.postgres = "connected";
  } catch {
    checks.postgres = "unavailable";
    checks.status = "degraded";
  }

  // Check Entra ID
  checks.entra = graph.isConfigured() ? "configured" : "not configured (blocker: app registration)";

  // Check GitHub
  checks.github = github.isConfigured() ? "configured" : "not configured";

  // Check Slack
  checks.slack = slack.isConfigured() ? "configured" : "not configured";

  // Check HubSpot
  checks.hubspot = hubspot.isConfigured() ? "configured" : "not configured";
  checks.hubspotCallback = hubspotCallback.isConfigured()
    ? "configured"
    : "not configured (ticket pipeline callbacks disabled)";

  // Check Acumatica
  checks.acumatica = acumatica.isConfigured() ? "configured" : "not configured";

  // Check Zoom
  checks.zoom = zoom.isConfigured() ? "configured" : "not configured";

  return checks;
});

// ─── Metrics ─────────────────────────────────────────────────────────

app.get("/metrics", async () => {
  try {
    const pool = getPool();

    const runsRes = await pool.query(
      `SELECT id, workflow_type, user_email, user_name, trigger_source,
              dry_run, status, total_steps, completed_steps, failed_step,
              started_at, completed_at
       FROM provisioning_runs
       ORDER BY started_at DESC LIMIT 20`
    );

    const eventsRes = await pool.query(
      `SELECT workflow_type, step_name, status, dry_run, user_email, created_at
       FROM provisioning_events
       ORDER BY created_at DESC LIMIT 50`
    );

    const statsRes = await pool.query(`
      SELECT
        COUNT(*) as total_runs,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COUNT(*) FILTER (WHERE dry_run = true) as dry_runs,
        COUNT(*) FILTER (WHERE workflow_type = 'onboarding') as onboardings,
        COUNT(*) FILTER (WHERE workflow_type = 'offboarding') as offboardings
      FROM provisioning_runs
      WHERE started_at >= NOW() - INTERVAL '30 days'
    `);

    return {
      recentRuns: runsRes.rows,
      recentEvents: eventsRes.rows,
      thirtyDayStats: statsRes.rows[0] ?? {},
    };
  } catch (err) {
    return { error: "Database not available", details: String(err) };
  }
});

// ─── Manual Trigger ─────────────────────────────────────────────────

app.post<{
  Body: ProvisioningRequest;
}>("/provision", async (request, reply) => {
  if (!validateBearerToken(request, reply)) return;

  const body = request.body;

  if (!body?.userEmail || !body?.firstName || !body?.lastName) {
    return { error: "Missing required fields: userEmail, firstName, lastName" };
  }

  const req: ProvisioningRequest = {
    workflowType: body.workflowType ?? "onboarding",
    userEmail: body.userEmail,
    firstName: body.firstName,
    lastName: body.lastName,
    department: body.department,
    jobTitle: body.jobTitle,
    phone: body.phone,
    githubUsername: body.githubUsername,
    githubTeams: body.githubTeams,
    slackChannels: body.slackChannels,
    acumaticaBranchId: body.acumaticaBranchId,
    acumaticaEmployeeClass: body.acumaticaEmployeeClass,
    acumaticaEmployeeId: body.acumaticaEmployeeId,
    zoomCallingPlanId: body.zoomCallingPlanId,
    licenseTier: body.licenseTier,
    triggerSource: body.triggerSource ?? "manual",
  };

  logger.info(
    { workflow: req.workflowType, email: req.userEmail, dryRun: config.dryRun },
    "Provisioning request received"
  );

  if (req.workflowType === "onboarding") {
    const result = await runOnboarding(req);
    return result;
  } else if (req.workflowType === "offboarding") {
    const result = await runOffboarding(req);
    return result;
  }

  return { error: `Unknown workflow type: ${req.workflowType}` };
});

// ─── Helper: Map WorkflowResult → ProvisioningOutcome ──────────────

function toProvisioningOutcome(
  ticketId: string,
  employeeEmail: string,
  employeeName: string,
  result: WorkflowResult,
  pipelineType: PipelineType = "onboarding"
): ProvisioningOutcome {
  return {
    runId: result.runId,
    ticketId,
    employeeEmail,
    employeeName,
    pipelineType,
    status: result.success
      ? "success"
      : result.steps.some((s) => s.status === "success" || s.status === "dry_run")
        ? "partial"
        : "failed",
    steps: result.steps.map((s): StepOutcome => ({
      name: s.name,
      success: s.status === "success" || s.status === "dry_run",
      dryRun: s.status === "dry_run",
      details: s.details,
      error: s.error,
    })),
    totalDurationMs: result.durationMs,
  };
}

// ─── HubSpot Webhook Receiver ───────────────────────────────────────

app.post("/webhook/hubspot", async (request, reply) => {
  if (!validateBearerToken(request, reply)) return;

  if (!hubspotCallback.isConfigured()) {
    return {
      error: "HubSpot callback not configured",
      detail: "HUBSPOT_API_KEY not set — ticket pipeline callbacks disabled",
    };
  }

  // HubSpot workflow webhook sends a JSON body with ticketId
  // (configured in the HubSpot workflow "Send Webhook" action)
  const body = request.body as Record<string, unknown>;
  const ticketId = String(body.ticketId ?? body.objectId ?? "");

  if (!ticketId) {
    logger.warn({ body }, "Webhook missing ticketId/objectId");
    return { error: "Missing ticketId or objectId in webhook payload" };
  }

  logger.info({ ticketId }, "HubSpot webhook received");

  // 1. Fetch ticket to extract employee details + detect pipeline type
  const ticket = await hubspotCallback.getTicket(ticketId);
  if (!ticket) {
    logger.error({ ticketId }, "Could not fetch ticket — aborting");
    return { error: "Failed to fetch ticket", ticketId };
  }

  // Detect whether this is onboarding or offboarding based on the pipeline ID
  const pipelineType: PipelineType = hubspotCallback.detectPipelineType(
    ticket.hs_pipeline ?? ""
  );
  const isOffboarding = pipelineType === "offboarding";
  const verb = isOffboarding ? "Deprovisioning" : "Provisioning";

  logger.info(
    { ticketId, pipelineType, pipelineId: ticket.hs_pipeline },
    `Detected ${pipelineType} pipeline`
  );

  const employeeEmail = ticket.employee_email;
  const firstName = ticket.employee_first_name;
  const lastName = ticket.employee_last_name;

  if (!employeeEmail || !firstName || !lastName) {
    logger.error(
      { ticketId, employeeEmail, firstName, lastName },
      "Ticket missing required employee fields"
    );
    return {
      error: "Ticket missing required fields (employee_email, employee_first_name, employee_last_name)",
      ticketId,
      fields: { employeeEmail, firstName, lastName },
    };
  }

  const employeeName = `${firstName} ${lastName}`;

  // 2. Build ProvisioningRequest from ticket properties
  const req: ProvisioningRequest = {
    workflowType: isOffboarding ? "offboarding" : "onboarding",
    userEmail: employeeEmail,
    firstName,
    lastName,
    department: ticket.employee_department,
    jobTitle: ticket.employee_job_title,
    phone: ticket.employee_phone,
    githubUsername: ticket.employee_github_username,
    licenseTier: (ticket as Record<string, string>).employee_license_tier as ProvisioningRequest["licenseTier"],
    triggerSource: "webhook",
  };

  // 3. Mark ticket as "Provisioning" / "Deprovisioning" (non-blocking)
  try {
    await hubspotCallback.markProvisioning(ticketId, 0, pipelineType);
  } catch (err) {
    logger.warn({ err, ticketId }, `Failed to mark ticket as ${verb} (non-critical)`);
  }

  // 4. Notify Slack that provisioning/deprovisioning is starting
  try {
    const dryTag = config.dryRun ? " [DRY RUN]" : "";
    const emoji = isOffboarding ? "🔴" : "🔄";
    await slack.postMessage(
      config.slackDeploymentsChannel,
      `${emoji} *${verb} started*${dryTag}\n` +
        `Employee: *${employeeName}* (${employeeEmail})\n` +
        `HubSpot Ticket: #${ticketId}\n` +
        (isOffboarding && ticket.offboarding_reason
          ? `Reason: ${ticket.offboarding_reason}` +
            (ticket.offboarding_type ? ` (${ticket.offboarding_type})` : "") + "\n"
          : "") +
        (isOffboarding && ticket.employee_last_day
          ? `Last Day: ${ticket.employee_last_day}\n`
          : "") +
        `Trigger: HubSpot webhook`,
      config.dryRun
    );
  } catch (err) {
    logger.warn({ err, ticketId }, "Failed to post Slack start notification (non-critical)");
  }

  // 5. Run onboarding or offboarding workflow
  logger.info(
    { ticketId, email: employeeEmail, pipelineType, dryRun: config.dryRun },
    `Starting ${pipelineType} from HubSpot webhook`
  );

  const result = isOffboarding
    ? await runOffboarding(req)
    : await runOnboarding(req);

  // 6. Report outcome back to ticket
  const outcome = toProvisioningOutcome(
    ticketId, employeeEmail, employeeName, result, pipelineType
  );
  const callbackResult = await hubspotCallback.reportOutcome(outcome);

  // 7. Notify Slack with results
  try {
    const succeeded = result.steps.filter(
      (s) => s.status === "success" || s.status === "dry_run"
    ).length;
    const failed = result.steps.filter((s) => s.status === "failed").length;
    const skipped = result.steps.filter((s) => s.status === "skipped").length;
    const icon = result.success ? "✅" : failed > 0 ? "❌" : "⚠️";
    const dryTag = config.dryRun ? " [DRY RUN]" : "";
    const duration = (result.durationMs / 1000).toFixed(1);

    const stepSummary = result.steps
      .map((s) => {
        const sIcon = s.status === "success" || s.status === "dry_run" ? "✅" : s.status === "failed" ? "❌" : "⏭️";
        const dry = s.status === "dry_run" ? " _(dry run)_" : "";
        const err = s.error ? ` — ${s.error}` : "";
        return `  ${sIcon} ${s.name}${dry}${err}`;
      })
      .join("\n");

    await slack.postMessage(
      config.slackDeploymentsChannel,
      `${icon} *${verb} ${result.success ? "complete" : "failed"}*${dryTag}\n` +
        `Employee: *${employeeName}* (${employeeEmail})\n` +
        `HubSpot Ticket: #${ticketId} → ${callbackResult.stage === "unknown" ? "update failed" : "stage updated"}\n` +
        `Run ID: ${result.runId} | Duration: ${duration}s\n` +
        `Steps: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped\n\n` +
        stepSummary,
      config.dryRun
    );
  } catch (err) {
    logger.warn({ err, ticketId }, "Failed to post Slack completion notification (non-critical)");
  }

  logger.info(
    {
      ticketId,
      runId: result.runId,
      pipelineType,
      success: result.success,
      stage: callbackResult.stage,
      noteId: callbackResult.noteId,
    },
    "HubSpot webhook processing complete"
  );

  return {
    ticketId,
    pipelineType,
    runId: result.runId,
    status: result.success ? "completed" : "failed",
    dryRun: result.dryRun,
    steps: result.steps.length,
    stepsSucceeded: result.steps.filter(
      (s) => s.status === "success" || s.status === "dry_run"
    ).length,
    ticketStage: callbackResult.stage,
    ticketNoteId: callbackResult.noteId,
    durationMs: result.durationMs,
  };
});

// ─── Startup ────────────────────────────────────────────────────────

const start = async () => {
  try {
    await initDatabase();
    logger.info("Database initialized");
  } catch (err) {
    logger.warn({ err }, "Database init deferred — will retry on first request");
  }

  await app.listen({ port: config.port, host: "0.0.0.0" });
  logger.info(
    { port: config.port, dryRun: config.dryRun },
    "Provisioning Agent ready"
  );
};

start().catch((err) => {
  logger.error({ err }, "Startup failed");
  process.exit(1);
});
