import pino from "pino";
import { config } from "../lib/config.js";
import { logStep, type StepLog } from "../lib/db.js";
import type { StepResult } from "../types.js";

const logger = pino({ level: config.logLevel });

export type StepFn = () => Promise<Record<string, unknown> | void>;

export interface WorkflowStep {
  name: string;
  order: number;
  execute: StepFn;
  /** If true, failure of this step does NOT stop the workflow */
  optional?: boolean;
}

export async function executeWorkflow(
  runId: number,
  workflowType: string,
  userEmail: string,
  steps: WorkflowStep[]
): Promise<StepResult[]> {
  const results: StepResult[] = [];

  for (const step of steps) {
    logger.info(
      { step: step.name, order: step.order, dryRun: config.dryRun },
      `Executing step: ${step.name}`
    );

    try {
      const details = await step.execute();

      const status = config.dryRun ? "dry_run" : "success";
      results.push({
        name: step.name,
        order: step.order,
        status,
        details: details as Record<string, unknown> | undefined,
      });

      const logEntry: StepLog = {
        runId,
        workflowType,
        userEmail,
        stepName: step.name,
        stepOrder: step.order,
        status,
        dryRun: config.dryRun,
        details: details as Record<string, unknown> | undefined,
      };
      await logStep(logEntry);

      logger.info({ step: step.name, status }, `Step complete: ${step.name}`);
    } catch (err) {
      const errorMsg = String(err);
      logger.error({ err, step: step.name }, `Step failed: ${step.name}`);

      results.push({
        name: step.name,
        order: step.order,
        status: "failed",
        error: errorMsg,
      });

      await logStep({
        runId,
        workflowType,
        userEmail,
        stepName: step.name,
        stepOrder: step.order,
        status: "failed",
        dryRun: config.dryRun,
        errorMessage: errorMsg,
      });

      // Stop workflow unless step is optional
      if (!step.optional) {
        logger.error({ step: step.name }, "Required step failed — stopping workflow");
        break;
      }
    }
  }

  return results;
}
