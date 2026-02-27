export interface ProvisioningRequest {
  workflowType: "onboarding" | "offboarding";
  userEmail: string;
  firstName: string;
  lastName: string;
  department?: string;
  jobTitle?: string;
  githubUsername?: string;
  githubTeams?: string[];
  slackChannels?: string[];
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
