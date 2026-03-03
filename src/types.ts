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
  /**
   * M365 license tier to assign.
   *   "standard"       → M365 Business Premium (default for employees)
   *   "shared_mailbox"  → Exchange Online Plan 1 (functional mailboxes)
   * Defaults to "standard" if omitted.
   */
  licenseTier?: "standard" | "shared_mailbox";
  /**
   * APP-* Entra groups to add the user to during onboarding.
   * Drives which provisioning steps run (Steps 4-8).
   * If omitted, user's existing group memberships are used.
   * If no APP-* groups found at all, all apps are provisioned (backward-compatible).
   */
  appEntitlements?: Array<"acumatica" | "zoomPhone" | "github" | "slack" | "hubspot">;
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
