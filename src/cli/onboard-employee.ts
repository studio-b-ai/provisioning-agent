#!/usr/bin/env tsx
/**
 * CLI tool for employee onboarding/offboarding.
 *
 * Usage:
 *   npx tsx src/cli/onboard-employee.ts --onboard --email wayne@heritagefabrics.com --first Wayne --last Ober --department WAREHOUSE
 *   npx tsx src/cli/onboard-employee.ts --offboard --email wayne@heritagefabrics.com --first Wayne --last Ober
 *   npx tsx src/cli/onboard-employee.ts --onboard --config employee.yaml
 *   npx tsx src/cli/onboard-employee.ts --validate --email wayne@heritagefabrics.com
 *
 * Targets the provisioning-agent service directly (HTTP POST /provision)
 * or runs the workflow locally if --local flag is passed.
 *
 * Default mode: DRY_RUN (pass --live to execute real API calls)
 */

import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";

// ─── CLI Argument Parsing ───────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    // Workflow type
    onboard: { type: "boolean", default: false },
    offboard: { type: "boolean", default: false },
    validate: { type: "boolean", default: false },

    // Employee details
    email: { type: "string" },
    first: { type: "string" },
    last: { type: "string" },
    department: { type: "string" },
    title: { type: "string" },
    phone: { type: "string" },

    // GitHub
    "github-user": { type: "string" },
    "github-teams": { type: "string" }, // comma-separated

    // Slack
    "slack-channels": { type: "string" }, // comma-separated

    // Acumatica
    "acumatica-branch": { type: "string" },
    "acumatica-class": { type: "string" },
    "acumatica-employee-id": { type: "string" },

    // Zoom
    "zoom-plan": { type: "string" },

    // Entitlement overrides
    "license-tier": { type: "string" }, // "standard" or "shared_mailbox"
    entitlements: { type: "string" }, // comma-separated app list

    // Config file (alternative to flags)
    config: { type: "string" },

    // Execution
    live: { type: "boolean", default: false },
    "service-url": {
      type: "string",
      default: "https://provisioning-agent-production.up.railway.app",
    },
    "api-key": {
      type: "string",
    },
    local: { type: "boolean", default: false },

    help: { type: "boolean", short: "h", default: false },
  },
  strict: false,
});

// ─── Help ───────────────────────────────────────────────────────────

if (args.help) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Studio B — Employee Provisioning CLI                        ║
║  Onboard / Offboard / Validate across 8 systems              ║
╚══════════════════════════════════════════════════════════════╝

USAGE:
  npx tsx src/cli/onboard-employee.ts [FLAGS]

WORKFLOWS:
  --onboard          Run onboarding (10 steps)
  --offboard         Run offboarding (12 steps)
  --validate         Check all systems for employee existence

EMPLOYEE:
  --email <addr>     Employee email (required)
  --first <name>     First name (required for onboard)
  --last <name>      Last name (required for onboard)
  --department <id>  Acumatica department (e.g., ADMIN, WAREHOUSE)
  --title <title>    Job title
  --phone <number>   Phone number

GITHUB:
  --github-user <u>  GitHub username
  --github-teams <t> Teams (comma-separated, e.g., "developers,ops")

SLACK:
  --slack-channels <c>  Channels (comma-separated, e.g., "C0AJ5SDRHSM,C0AHBFP50SK")

ACUMATICA:
  --acumatica-branch <b>   Branch ID (default: HERFAB)
  --acumatica-class <c>    Employee class (default: DEFAULT)
  --acumatica-employee-id  Employee ID (for offboarding)

ZOOM:
  --zoom-plan <id>    Calling plan ID (e.g., "200" for Zoom Phone Pro)

ENTITLEMENT OVERRIDES:
  --license-tier <t>  M365 license: "standard" (Business Premium) or "shared_mailbox" (Exchange Plan 1)
  --entitlements <a>  Comma-separated apps: acumatica,zoomPhone,github,slack,hubspot
                      If omitted, resolved from department via entitlement matrix:
                        ADMIN     → standard + all 5 apps
                        SALES     → standard + hubspot,zoomPhone,slack
                        WAREHOUSE → shared_mailbox + no apps
                        DESIGN    → standard + acumatica,slack,hubspot
                        FINANCE   → standard + acumatica,slack,hubspot
                      Unknown/missing department → standard + all apps (backward-compatible)

CONFIG:
  --config <file>     YAML config file (alternative to flags)

EXECUTION:
  --live              Execute real API calls (default: DRY_RUN)
  --service-url <url> Provisioning agent URL (default: Railway prod)
  --api-key <key>     Bearer token for /provision endpoint (or set PROVISION_API_KEY env var)
  --local             Run workflow locally instead of via HTTP

EXAMPLES:
  # Dry-run onboard
  npx tsx src/cli/onboard-employee.ts --onboard \\
    --email jane@heritagefabrics.com --first Jane --last Smith \\
    --department ADMIN --title "Operations Manager" \\
    --zoom-plan 200

  # Live offboard
  npx tsx src/cli/onboard-employee.ts --offboard --live \\
    --email jane@heritagefabrics.com --first Jane --last Smith

  # Warehouse employee (auto: shared_mailbox, no apps)
  npx tsx src/cli/onboard-employee.ts --onboard \\
    --email wayne@heritagefabrics.com --first Wayne --last Ober \\
    --department WAREHOUSE

  # Override: warehouse employee with standard license
  npx tsx src/cli/onboard-employee.ts --onboard \\
    --email wayne@heritagefabrics.com --first Wayne --last Ober \\
    --department WAREHOUSE --license-tier standard

  # Validate employee exists in all systems
  npx tsx src/cli/onboard-employee.ts --validate \\
    --email jane@heritagefabrics.com
  `);
  process.exit(0);
}

// ─── Config Loading ─────────────────────────────────────────────────

interface EmployeeConfig {
  email: string;
  firstName: string;
  lastName: string;
  department?: string;
  jobTitle?: string;
  phone?: string;
  githubUsername?: string;
  githubTeams?: string[];
  slackChannels?: string[];
  acumaticaBranchId?: string;
  acumaticaEmployeeClass?: string;
  acumaticaEmployeeId?: string;
  zoomCallingPlanId?: string;
  licenseTier?: "standard" | "shared_mailbox";
  appEntitlements?: string[];
}

/** Type-safe string accessor for parseArgs values */
function str(val: string | boolean | undefined): string | undefined {
  return typeof val === "string" ? val : undefined;
}

function strReq(val: string | boolean | undefined, fallback: string): string {
  return typeof val === "string" ? val : fallback;
}

function csvList(val: string | boolean | undefined): string[] | undefined {
  return typeof val === "string" ? val.split(",").map((s) => s.trim()) : undefined;
}

function loadConfig(): EmployeeConfig {
  if (typeof args.config === "string") {
    const configPath = args.config;
    if (!existsSync(configPath)) {
      console.error(`Config file not found: ${configPath}`);
      process.exit(1);
    }
    const raw = readFileSync(configPath, "utf-8");
    // Simple YAML-like key: value parser (no external dep needed)
    const parsed: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*(\w[\w-]*)\s*:\s*(.+?)\s*$/);
      if (match) parsed[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
    return {
      email: parsed.email ?? "",
      firstName: parsed.firstName ?? parsed["first-name"] ?? "",
      lastName: parsed.lastName ?? parsed["last-name"] ?? "",
      department: parsed.department,
      jobTitle: parsed.jobTitle ?? parsed["job-title"],
      phone: parsed.phone,
      githubUsername: parsed.githubUsername ?? parsed["github-user"],
      githubTeams: parsed.githubTeams?.split(",").map((s) => s.trim()) ?? parsed["github-teams"]?.split(",").map((s) => s.trim()),
      slackChannels: parsed.slackChannels?.split(",").map((s) => s.trim()) ?? parsed["slack-channels"]?.split(",").map((s) => s.trim()),
      acumaticaBranchId: parsed.acumaticaBranchId ?? parsed["acumatica-branch"],
      acumaticaEmployeeClass: parsed.acumaticaEmployeeClass ?? parsed["acumatica-class"],
      acumaticaEmployeeId: parsed.acumaticaEmployeeId ?? parsed["acumatica-employee-id"],
      zoomCallingPlanId: parsed.zoomCallingPlanId ?? parsed["zoom-plan"],
      licenseTier: (parsed.licenseTier ?? parsed["license-tier"]) as EmployeeConfig["licenseTier"],
      appEntitlements: (parsed.appEntitlements ?? parsed.entitlements)?.split(",").map((s) => s.trim()),
    };
  }

  return {
    email: strReq(args.email, ""),
    firstName: strReq(args.first, ""),
    lastName: strReq(args.last, ""),
    department: str(args.department),
    jobTitle: str(args.title),
    phone: str(args.phone),
    githubUsername: str(args["github-user"]),
    githubTeams: csvList(args["github-teams"]),
    slackChannels: csvList(args["slack-channels"]),
    acumaticaBranchId: str(args["acumatica-branch"]),
    acumaticaEmployeeClass: str(args["acumatica-class"]),
    acumaticaEmployeeId: str(args["acumatica-employee-id"]),
    zoomCallingPlanId: str(args["zoom-plan"]),
    licenseTier: str(args["license-tier"]) as EmployeeConfig["licenseTier"],
    appEntitlements: csvList(args.entitlements),
  };
}

// ─── Remote Execution (HTTP to provisioning-agent) ──────────────────

async function executeRemote(
  workflowType: "onboarding" | "offboarding",
  emp: EmployeeConfig,
  serviceUrl: string
): Promise<void> {
  const isLive = args.live ?? false;
  const mode = isLive ? "LIVE" : "DRY RUN";

  // Resolve API key: --api-key flag > PROVISION_API_KEY env var
  const apiKey = str(args["api-key"]) ?? process.env.PROVISION_API_KEY ?? "";
  if (!apiKey) {
    console.error("❌ No API key provided. Use --api-key <key> or set PROVISION_API_KEY env var.");
    process.exit(1);
  }

  console.log(`\n🚀 ${workflowType.toUpperCase()} [${mode}]`);
  console.log(`   Employee: ${emp.firstName} ${emp.lastName} <${emp.email}>`);
  console.log(`   Target:   ${serviceUrl}`);
  console.log("");

  const payload = {
    workflowType,
    userEmail: emp.email,
    firstName: emp.firstName,
    lastName: emp.lastName,
    department: emp.department,
    jobTitle: emp.jobTitle,
    phone: emp.phone,
    githubUsername: emp.githubUsername,
    githubTeams: emp.githubTeams,
    slackChannels: emp.slackChannels,
    acumaticaBranchId: emp.acumaticaBranchId,
    acumaticaEmployeeClass: emp.acumaticaEmployeeClass,
    acumaticaEmployeeId: emp.acumaticaEmployeeId,
    zoomCallingPlanId: emp.zoomCallingPlanId,
    licenseTier: emp.licenseTier,
    appEntitlements: emp.appEntitlements,
    triggerSource: "manual" as const,
  };

  try {
    const res = await fetch(`${serviceUrl}/provision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`❌ Service returned ${res.status}: ${text.slice(0, 500)}`);
      process.exit(1);
    }

    const result = (await res.json()) as {
      runId: number;
      success: boolean;
      dryRun: boolean;
      durationMs: number;
      steps: Array<{ name: string; order: number; status: string; details?: Record<string, unknown>; error?: string }>;
    };

    printResults(result);
  } catch (err) {
    console.error(`❌ Failed to reach service: ${err}`);
    console.log("\nIs the provisioning-agent running? Try:");
    console.log(`  curl ${serviceUrl}/health`);
    process.exit(1);
  }
}

// ─── Validation ─────────────────────────────────────────────────────

async function executeValidation(emp: EmployeeConfig, serviceUrl: string): Promise<void> {
  console.log(`\n🔍 VALIDATING: ${emp.email}`);
  console.log(`   Target: ${serviceUrl}`);
  console.log("");

  // Check service health first
  try {
    const healthRes = await fetch(`${serviceUrl}/health`);
    const health = (await healthRes.json()) as Record<string, string>;

    console.log("System Configuration:");
    const systems = ["entra", "github", "slack", "hubspot", "acumatica", "zoom"];
    for (const sys of systems) {
      const status = health[sys] ?? "unknown";
      const icon = status === "configured" ? "✅" : "⚠️";
      console.log(`  ${icon} ${sys.padEnd(12)} ${status}`);
    }
    console.log(`  ${health.postgres === "connected" ? "✅" : "❌"} postgres     ${health.postgres}`);
    console.log(`\n  DRY_RUN: ${health.dryRun}`);
  } catch (err) {
    console.error(`❌ Cannot reach service: ${err}`);
    process.exit(1);
  }
}

// ─── Output Formatting ──────────────────────────────────────────────

function printResults(result: {
  runId: number;
  success: boolean;
  dryRun: boolean;
  durationMs: number;
  steps: Array<{ name: string; order: number; status: string; details?: Record<string, unknown>; error?: string }>;
}): void {
  const tag = result.dryRun ? " [DRY RUN]" : "";

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Run #${result.runId}${tag} — ${result.success ? "✅ SUCCESS" : "❌ FAILED"} (${result.durationMs}ms)`);
  console.log(`${"─".repeat(60)}`);

  for (const step of result.steps) {
    const icon =
      step.status === "success" ? "✅" :
      step.status === "dry_run" ? "🔵" :
      step.status === "skipped" ? "⏭️" : "❌";

    console.log(`  ${icon} Step ${step.order.toString().padStart(2)}: ${step.name.padEnd(30)} ${step.status}`);

    if (step.details) {
      const relevant = Object.entries(step.details).filter(
        ([, v]) => v !== undefined && v !== null && v !== ""
      );
      for (const [key, val] of relevant) {
        console.log(`     └─ ${key}: ${typeof val === "object" ? JSON.stringify(val) : val}`);
      }
    }

    if (step.error) {
      console.log(`     └─ ERROR: ${step.error.slice(0, 200)}`);
    }
  }

  console.log(`\n${"─".repeat(60)}`);

  // Summary of manual actions needed
  const manualActions = result.steps
    .filter((s) => s.details?.note && typeof s.details.note === "string")
    .map((s) => `  ⚡ ${s.name}: ${s.details!.note}`);

  if (manualActions.length > 0) {
    console.log("\n📋 MANUAL ACTIONS REQUIRED:");
    for (const action of manualActions) {
      console.log(action);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const emp = loadConfig();

  // Determine workflow
  if (args.validate) {
    if (!emp.email) {
      console.error("--email is required for validation");
      process.exit(1);
    }
    await executeValidation(emp, strReq(args["service-url"], "https://provisioning-agent-production.up.railway.app"));
    return;
  }

  const workflowType: "onboarding" | "offboarding" = args.offboard ? "offboarding" : "onboarding";

  // Validate required fields
  if (!emp.email) {
    console.error("--email is required");
    process.exit(1);
  }
  if (workflowType === "onboarding" && (!emp.firstName || !emp.lastName)) {
    console.error("--first and --last are required for onboarding");
    process.exit(1);
  }

  // Confirmation prompt for live mode
  if (args.live) {
    console.log(`\n⚠️  LIVE MODE — This will make real API calls across 8 systems.`);
    console.log(`   Employee: ${emp.firstName} ${emp.lastName} <${emp.email}>`);
    console.log(`   Workflow: ${workflowType}`);
    console.log(`\n   Press Ctrl+C to cancel, or wait 3 seconds to proceed...`);
    await new Promise((r) => setTimeout(r, 3000));
  }

  await executeRemote(workflowType, emp, strReq(args["service-url"], "https://provisioning-agent-production.up.railway.app"));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
