export interface ProvisioningRequest {
  workflowType: "onboarding" | "offboarding";
  userEmail: string;
  firstName: string;
  lastName: string;
  department?: string;
  jobTitle?: string;
  phone?: string;
  githubUsername?: string;
  githubTeams?: string[];
  slackChannels?: string[];
  /** Acumatica branch (defaults to HERFAB) */
  acumaticaBranchId?: string;
  /** Acumatica employee class (defaults to DEFAULT) */
  acumaticaEmployeeClass?: string;
  /** Zoom calling plan ID (e.g., "200" for Zoom Phone Pro) */
  zoomCallingPlanId?: string;
  /** Acumatica Employee ID — used for offboarding lookup */
  acumaticaEmployeeId?: string;
  triggerSource: "webhook" | "manual" | "api";
}

export interface StepResult {
  name: string;
  order: number;
  status: "success" | "failed" | "skipped" | "dry_run";
  details?: Record<string, unknown>;
  error?: string;
}

export interface WorkflowResult {
  runId: number;
  workflowType: string;
  userEmail: string;
  success: boolean;
  steps: StepResult[];
  dryRun: boolean;
  durationMs: number;
  error?: string;
}
