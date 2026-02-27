import Fastify from "fastify";
import pino from "pino";
import { config } from "./lib/config.js";
import { initDatabase, getPool } from "./lib/db.js";
import * as graph from "./lib/graph.js";
import * as github from "./lib/github-org.js";
import * as slack from "./lib/slack.js";
import * as hubspot from "./lib/hubspot.js";
import { runOnboarding } from "./workflows/onboarding.js";
import { runOffboarding } from "./workflows/offboarding.js";
import type { ProvisioningRequest } from "./types.js";

const logger = pino({ level: config.logLevel });
const app = Fastify({ logger: false });

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
}>("/provision", async (request) => {
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
    githubUsername: body.githubUsername,
    githubTeams: body.githubTeams,
    slackChannels: body.slackChannels,
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

// ─── HubSpot Webhook Receiver ───────────────────────────────────────

app.post("/webhook/hubspot", async (request) => {
  // HubSpot ticket webhook handler
  // Triggers onboarding/offboarding when tickets are created with specific pipeline/stage
  const body = request.body as Array<Record<string, unknown>> | Record<string, unknown>;
  const events = Array.isArray(body) ? body : [body];

  logger.info({ eventCount: events.length }, "HubSpot webhook received");

  const results = [];
  for (const event of events) {
    logger.info({ event }, "Processing webhook event");
    // Future: Parse ticket properties, determine workflow type, trigger provisioning
    results.push({
      eventType: event.subscriptionType,
      objectId: event.objectId,
      status: "acknowledged",
      note: "Webhook processing not yet implemented — awaiting ticket pipeline configuration",
    });
  }

  return { processed: results.length, results };
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
