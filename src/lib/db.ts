import pg from "pg";
import pino from "pino";

const logger = pino({ level: "info" });

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

export async function initDatabase(): Promise<void> {
  const p = getPool();

  await p.query(`
    CREATE TABLE IF NOT EXISTS provisioning_events (
      id SERIAL PRIMARY KEY,
      workflow_type VARCHAR(20) NOT NULL,
      user_email VARCHAR(255) NOT NULL,
      user_name VARCHAR(255),
      step_name VARCHAR(100) NOT NULL,
      step_order INTEGER NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      dry_run BOOLEAN NOT NULL DEFAULT true,
      details JSONB,
      error_message TEXT,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_prov_email ON provisioning_events(user_email);
    CREATE INDEX IF NOT EXISTS idx_prov_workflow ON provisioning_events(workflow_type);
    CREATE INDEX IF NOT EXISTS idx_prov_created ON provisioning_events(created_at);
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS provisioning_runs (
      id SERIAL PRIMARY KEY,
      workflow_type VARCHAR(20) NOT NULL,
      user_email VARCHAR(255) NOT NULL,
      user_name VARCHAR(255),
      trigger_source VARCHAR(50),
      dry_run BOOLEAN NOT NULL DEFAULT true,
      status VARCHAR(20) NOT NULL DEFAULT 'running',
      total_steps INTEGER NOT NULL DEFAULT 0,
      completed_steps INTEGER NOT NULL DEFAULT 0,
      failed_step VARCHAR(100),
      error_message TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_run_email ON provisioning_runs(user_email);
  `);

  logger.info("Provisioning database tables initialized");
}

export interface StepLog {
  runId: number;
  workflowType: string;
  userEmail: string;
  stepName: string;
  stepOrder: number;
  status: "success" | "failed" | "skipped" | "dry_run";
  dryRun: boolean;
  details?: Record<string, unknown>;
  errorMessage?: string;
}

export async function logStep(step: StepLog): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO provisioning_events
     (workflow_type, user_email, step_name, step_order, status, dry_run, details, error_message, started_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
    [
      step.workflowType,
      step.userEmail,
      step.stepName,
      step.stepOrder,
      step.status,
      step.dryRun,
      step.details ? JSON.stringify(step.details) : null,
      step.errorMessage ?? null,
    ]
  );
}

export async function createRun(
  workflowType: string,
  userEmail: string,
  userName: string,
  triggerSource: string,
  dryRun: boolean,
  totalSteps: number
): Promise<number> {
  const p = getPool();
  const res = await p.query(
    `INSERT INTO provisioning_runs
     (workflow_type, user_email, user_name, trigger_source, dry_run, total_steps)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [workflowType, userEmail, userName, triggerSource, dryRun, totalSteps]
  );
  return res.rows[0].id as number;
}

export async function completeRun(
  runId: number,
  status: "completed" | "failed",
  completedSteps: number,
  failedStep?: string,
  errorMessage?: string
): Promise<void> {
  const p = getPool();
  await p.query(
    `UPDATE provisioning_runs
     SET status = $1, completed_steps = $2, failed_step = $3, error_message = $4, completed_at = NOW()
     WHERE id = $5`,
    [status, completedSteps, failedStep ?? null, errorMessage ?? null, runId]
  );
}
