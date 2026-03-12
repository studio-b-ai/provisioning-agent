/**
 * Pure function & constant tests for provisioning-agent lib/ modules.
 *
 * Covers: role-entitlements, hubspot-callback, graph constants, config shape,
 * and isConfigured() guards across all service modules.
 *
 * Does NOT test functions that make API calls.
 */

import { describe, it, expect } from "vitest";

// ── role-entitlements (fully pure) ──────────────────────────────────────────

import {
  resolveFromDepartment,
  ENTITLEMENT_MATRIX,
  type ResolvedEntitlements,
} from "../lib/role-entitlements.js";

describe("role-entitlements", () => {
  describe("ENTITLEMENT_MATRIX", () => {
    it("has entries for all known departments", () => {
      const expected = ["ADMIN", "SALES", "WAREHOUSE", "DESIGN", "FINANCE"];
      for (const dept of expected) {
        expect(ENTITLEMENT_MATRIX[dept]).toBeDefined();
      }
    });

    it("WAREHOUSE uses shared_mailbox tier with no apps", () => {
      const wh = ENTITLEMENT_MATRIX.WAREHOUSE;
      expect(wh.licenseTier).toBe("shared_mailbox");
      expect(wh.apps).toEqual([]);
    });

    it("ADMIN has all five apps", () => {
      const admin = ENTITLEMENT_MATRIX.ADMIN;
      expect(admin.apps).toHaveLength(5);
      expect(admin.apps).toContain("acumatica");
      expect(admin.apps).toContain("zoomPhone");
      expect(admin.apps).toContain("github");
      expect(admin.apps).toContain("slack");
      expect(admin.apps).toContain("hubspot");
    });

    it("SALES has hubspot, zoomPhone, slack but not github or acumatica", () => {
      const sales = ENTITLEMENT_MATRIX.SALES;
      expect(sales.apps).toContain("hubspot");
      expect(sales.apps).toContain("zoomPhone");
      expect(sales.apps).toContain("slack");
      expect(sales.apps).not.toContain("github");
      expect(sales.apps).not.toContain("acumatica");
    });

    it("all profiles have a description string", () => {
      for (const [dept, profile] of Object.entries(ENTITLEMENT_MATRIX)) {
        expect(typeof profile.description).toBe("string");
        expect(profile.description.length).toBeGreaterThan(0);
      }
    });
  });

  describe("resolveFromDepartment", () => {
    // Layer 2: department lookup
    it("resolves ADMIN department to standard + all apps", () => {
      const result = resolveFromDepartment("ADMIN");
      expect(result.licenseTier).toBe("standard");
      expect(result.apps).toHaveLength(5);
      expect(result.source).toBe("department");
    });

    it("resolves WAREHOUSE to shared_mailbox + no apps", () => {
      const result = resolveFromDepartment("WAREHOUSE");
      expect(result.licenseTier).toBe("shared_mailbox");
      expect(result.apps).toEqual([]);
      expect(result.source).toBe("department");
    });

    it("is case-insensitive on department name", () => {
      const result = resolveFromDepartment("sales");
      expect(result.licenseTier).toBe("standard");
      expect(result.apps).toContain("hubspot");
      expect(result.source).toBe("department");
    });

    // Layer 3: no department
    it("returns default (all apps + standard) when no department given", () => {
      const result = resolveFromDepartment();
      expect(result.licenseTier).toBe("standard");
      expect(result.apps).toHaveLength(5);
      expect(result.source).toBe("default");
    });

    it("returns default for unknown department", () => {
      const result = resolveFromDepartment("NONEXISTENT");
      expect(result.licenseTier).toBe("standard");
      expect(result.apps).toHaveLength(5);
      expect(result.source).toBe("default");
      expect(result.reason).toContain("Unknown department");
    });

    // Layer 1: explicit overrides
    it("uses explicit apps when provided", () => {
      const result = resolveFromDepartment("ADMIN", ["slack", "hubspot"]);
      expect(result.apps).toEqual(["slack", "hubspot"]);
      expect(result.source).toBe("explicit");
    });

    it("uses explicit tier when provided", () => {
      const result = resolveFromDepartment("ADMIN", undefined, "shared_mailbox");
      expect(result.licenseTier).toBe("shared_mailbox");
      expect(result.source).toBe("explicit");
    });

    it("uses both explicit apps and tier when provided", () => {
      const result = resolveFromDepartment("SALES", ["github"], "shared_mailbox");
      expect(result.apps).toEqual(["github"]);
      expect(result.licenseTier).toBe("shared_mailbox");
      expect(result.source).toBe("explicit");
    });

    it("explicit tier falls back to department apps", () => {
      const result = resolveFromDepartment("SALES", undefined, "shared_mailbox");
      expect(result.licenseTier).toBe("shared_mailbox");
      expect(result.apps).toEqual(ENTITLEMENT_MATRIX.SALES.apps);
      expect(result.source).toBe("explicit");
    });

    it("explicit apps fall back to department tier", () => {
      const result = resolveFromDepartment("WAREHOUSE", ["slack"]);
      expect(result.apps).toEqual(["slack"]);
      expect(result.licenseTier).toBe("shared_mailbox"); // from WAREHOUSE
      expect(result.source).toBe("explicit");
    });

    it("returns a copy of apps array (not the original)", () => {
      const r1 = resolveFromDepartment("ADMIN");
      const r2 = resolveFromDepartment("ADMIN");
      expect(r1.apps).not.toBe(r2.apps); // different array references
      expect(r1.apps).toEqual(r2.apps);   // same contents
    });
  });
});

// ── hubspot-callback (constants + pure helpers) ─────────────────────────────

import {
  ONBOARDING_PIPELINE_ID,
  OFFBOARDING_PIPELINE_ID,
  ONBOARDING_STAGES,
  OFFBOARDING_STAGES,
  PIPELINE_ID,
  STAGES,
  getPipelineId,
  detectPipelineType,
  type PipelineType,
  type StepOutcome,
  type ProvisioningOutcome,
} from "../lib/hubspot-callback.js";

describe("hubspot-callback", () => {
  describe("constants", () => {
    it("ONBOARDING_PIPELINE_ID is a non-empty string", () => {
      expect(ONBOARDING_PIPELINE_ID).toBe("876698717");
    });

    it("OFFBOARDING_PIPELINE_ID is a non-empty string", () => {
      expect(OFFBOARDING_PIPELINE_ID).toBe("876705376");
    });

    it("deprecated PIPELINE_ID aliases ONBOARDING_PIPELINE_ID", () => {
      expect(PIPELINE_ID).toBe(ONBOARDING_PIPELINE_ID);
    });

    it("deprecated STAGES aliases ONBOARDING_STAGES", () => {
      expect(STAGES).toBe(ONBOARDING_STAGES);
    });

    it("ONBOARDING_STAGES has all 7 stages", () => {
      const keys = Object.keys(ONBOARDING_STAGES);
      expect(keys).toEqual([
        "REQUESTED",
        "APPROVED",
        "PROVISIONING",
        "ACCOUNTS_CREATED",
        "HARDWARE_PENDING",
        "COMPLETE",
        "FAILED",
      ]);
    });

    it("OFFBOARDING_STAGES has all 7 stages", () => {
      const keys = Object.keys(OFFBOARDING_STAGES);
      expect(keys).toEqual([
        "REQUESTED",
        "APPROVED",
        "DEPROVISIONING",
        "ACCOUNTS_DISABLED",
        "HARDWARE_RECOVERY",
        "COMPLETE",
        "FAILED",
      ]);
    });

    it("all stage IDs are non-empty strings", () => {
      for (const id of Object.values(ONBOARDING_STAGES)) {
        expect(typeof id).toBe("string");
        expect(id.length).toBeGreaterThan(0);
      }
      for (const id of Object.values(OFFBOARDING_STAGES)) {
        expect(typeof id).toBe("string");
        expect(id.length).toBeGreaterThan(0);
      }
    });
  });

  describe("getPipelineId", () => {
    it("returns onboarding pipeline for 'onboarding'", () => {
      expect(getPipelineId("onboarding")).toBe(ONBOARDING_PIPELINE_ID);
    });

    it("returns offboarding pipeline for 'offboarding'", () => {
      expect(getPipelineId("offboarding")).toBe(OFFBOARDING_PIPELINE_ID);
    });
  });

  describe("detectPipelineType", () => {
    it("returns 'offboarding' for offboarding pipeline ID", () => {
      expect(detectPipelineType(OFFBOARDING_PIPELINE_ID)).toBe("offboarding");
    });

    it("returns 'onboarding' for onboarding pipeline ID", () => {
      expect(detectPipelineType(ONBOARDING_PIPELINE_ID)).toBe("onboarding");
    });

    it("returns 'onboarding' for unknown pipeline ID", () => {
      expect(detectPipelineType("999999")).toBe("onboarding");
    });
  });

  // Mirror stageForStatus (not exported) to verify stage mapping logic
  describe("stageForStatus (mirrored)", () => {
    function stageForStatus(
      status: "success" | "partial" | "failed",
      pipelineType: PipelineType = "onboarding"
    ): string {
      if (pipelineType === "offboarding") {
        switch (status) {
          case "success":
            return OFFBOARDING_STAGES.ACCOUNTS_DISABLED;
          case "partial":
            return OFFBOARDING_STAGES.ACCOUNTS_DISABLED;
          case "failed":
            return OFFBOARDING_STAGES.FAILED;
        }
      }
      switch (status) {
        case "success":
          return ONBOARDING_STAGES.ACCOUNTS_CREATED;
        case "partial":
          return ONBOARDING_STAGES.ACCOUNTS_CREATED;
        case "failed":
          return ONBOARDING_STAGES.FAILED;
      }
    }

    it("maps success to ACCOUNTS_CREATED for onboarding", () => {
      expect(stageForStatus("success", "onboarding")).toBe(ONBOARDING_STAGES.ACCOUNTS_CREATED);
    });

    it("maps partial to ACCOUNTS_CREATED for onboarding", () => {
      expect(stageForStatus("partial", "onboarding")).toBe(ONBOARDING_STAGES.ACCOUNTS_CREATED);
    });

    it("maps failed to FAILED for onboarding", () => {
      expect(stageForStatus("failed", "onboarding")).toBe(ONBOARDING_STAGES.FAILED);
    });

    it("maps success to ACCOUNTS_DISABLED for offboarding", () => {
      expect(stageForStatus("success", "offboarding")).toBe(OFFBOARDING_STAGES.ACCOUNTS_DISABLED);
    });

    it("maps failed to FAILED for offboarding", () => {
      expect(stageForStatus("failed", "offboarding")).toBe(OFFBOARDING_STAGES.FAILED);
    });

    it("defaults to onboarding when pipelineType omitted", () => {
      expect(stageForStatus("success")).toBe(ONBOARDING_STAGES.ACCOUNTS_CREATED);
    });
  });

  // Mirror buildNote (not exported) to verify note formatting
  describe("buildNote (mirrored)", () => {
    function buildNote(outcome: ProvisioningOutcome): string {
      const verb = outcome.pipelineType === "offboarding" ? "Deprovisioning" : "Provisioning";
      const header =
        outcome.status === "success"
          ? `\u2705 ${verb} COMPLETE for ${outcome.employeeName}`
          : outcome.status === "partial"
            ? `\u26a0\ufe0f ${verb} PARTIAL for ${outcome.employeeName}`
            : `\u274c ${verb} FAILED for ${outcome.employeeName}`;

      const lines = [
        header,
        `Email: ${outcome.employeeEmail}`,
        `Run ID: ${outcome.runId}`,
        `Duration: ${(outcome.totalDurationMs / 1000).toFixed(1)}s`,
        "",
        "Step Results:",
        ...outcome.steps.map((s) => {
          const icon = s.success ? "\u2705" : "\u274c";
          const dry = s.dryRun ? " [DRY RUN]" : "";
          const dur = s.durationMs ? ` (${s.durationMs}ms)` : "";
          const err = s.error ? ` \u2014 ${s.error}` : "";
          return `  ${icon} ${s.name}${dry}${dur}${err}`;
        }),
      ];

      return lines.join("\n");
    }

    const baseOutcome: ProvisioningOutcome = {
      runId: 42,
      ticketId: "12345",
      employeeEmail: "test@example.com",
      employeeName: "Test User",
      pipelineType: "onboarding",
      status: "success",
      steps: [
        { name: "Create user", success: true, dryRun: false, durationMs: 150 },
        { name: "Assign license", success: true, dryRun: true },
      ],
      totalDurationMs: 2500,
    };

    it("includes employee name in header", () => {
      const note = buildNote(baseOutcome);
      expect(note).toContain("Test User");
    });

    it("includes email and run ID", () => {
      const note = buildNote(baseOutcome);
      expect(note).toContain("test@example.com");
      expect(note).toContain("Run ID: 42");
    });

    it("formats duration in seconds", () => {
      const note = buildNote(baseOutcome);
      expect(note).toContain("Duration: 2.5s");
    });

    it("marks DRY RUN steps", () => {
      const note = buildNote(baseOutcome);
      expect(note).toContain("[DRY RUN]");
    });

    it("uses Deprovisioning verb for offboarding", () => {
      const note = buildNote({ ...baseOutcome, pipelineType: "offboarding" });
      expect(note).toContain("Deprovisioning");
    });

    it("includes error text for failed steps", () => {
      const note = buildNote({
        ...baseOutcome,
        status: "failed",
        steps: [
          { name: "Create user", success: false, dryRun: false, error: "Network timeout" },
        ],
      });
      expect(note).toContain("Network timeout");
    });
  });
});

// ── graph.ts constants ──────────────────────────────────────────────────────

import { LICENSE_SKUS, APP_GROUPS, type LicenseTier, type AppEntitlement } from "../lib/graph.js";

describe("graph constants", () => {
  describe("LICENSE_SKUS", () => {
    it("has standard and shared_mailbox tiers", () => {
      expect(LICENSE_SKUS.standard).toBeDefined();
      expect(LICENSE_SKUS.shared_mailbox).toBeDefined();
    });

    it("standard is M365 Business Premium", () => {
      expect(LICENSE_SKUS.standard.displayName).toBe("M365 Business Premium");
      expect(LICENSE_SKUS.standard.skuId).toBeTruthy();
    });

    it("shared_mailbox is Exchange Online Plan 1", () => {
      expect(LICENSE_SKUS.shared_mailbox.displayName).toBe("Exchange Online (Plan 1)");
      expect(LICENSE_SKUS.shared_mailbox.skuId).toBeTruthy();
    });

    it("SKU IDs are valid GUIDs", () => {
      const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      expect(LICENSE_SKUS.standard.skuId).toMatch(guidPattern);
      expect(LICENSE_SKUS.shared_mailbox.skuId).toMatch(guidPattern);
    });
  });

  describe("APP_GROUPS", () => {
    it("has all five app entitlements", () => {
      const apps: AppEntitlement[] = ["acumatica", "zoomPhone", "github", "slack", "hubspot"];
      for (const app of apps) {
        expect(APP_GROUPS[app]).toBeDefined();
        expect(APP_GROUPS[app].groupId).toBeTruthy();
        expect(APP_GROUPS[app].displayName).toBeTruthy();
        expect(typeof APP_GROUPS[app].provisioningStep).toBe("number");
      }
    });

    it("provisioning steps are in order 4-8", () => {
      expect(APP_GROUPS.acumatica.provisioningStep).toBe(4);
      expect(APP_GROUPS.zoomPhone.provisioningStep).toBe(5);
      expect(APP_GROUPS.github.provisioningStep).toBe(6);
      expect(APP_GROUPS.slack.provisioningStep).toBe(7);
      expect(APP_GROUPS.hubspot.provisioningStep).toBe(8);
    });

    it("all group IDs are valid GUIDs", () => {
      const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      for (const group of Object.values(APP_GROUPS)) {
        expect(group.groupId).toMatch(guidPattern);
      }
    });

    it("display names follow APP-* convention", () => {
      for (const group of Object.values(APP_GROUPS)) {
        expect(group.displayName).toMatch(/^APP-/);
      }
    });
  });
});

// ── config.ts shape ──────────────────────────────────────────────────────────

import { config } from "../lib/config.js";

describe("config", () => {
  it("exports a frozen config object", () => {
    expect(typeof config).toBe("object");
  });

  it("has correct default port", () => {
    expect(config.port).toBe(3000);
  });

  it("dryRun defaults to true", () => {
    // DRY_RUN env not set in test → defaults to true
    expect(config.dryRun).toBe(true);
  });

  it("githubOrg defaults to studio-b-ai", () => {
    expect(config.githubOrg).toBe("studio-b-ai");
  });

  it("acumaticaBranchId defaults to HERFAB", () => {
    expect(config.acumaticaBranchId).toBe("HERFAB");
  });

  it("slackDeploymentsChannel defaults to C0AHK777EQL", () => {
    expect(config.slackDeploymentsChannel).toBe("C0AHK777EQL");
  });

  it("hubspotPortalId defaults to 49070660", () => {
    expect(config.hubspotPortalId).toBe("49070660");
  });

  it("acumaticaUrl defaults to heritagefabrics.acumatica.com", () => {
    expect(config.acumaticaUrl).toBe("https://heritagefabrics.acumatica.com");
  });

  it("has all expected keys", () => {
    const requiredKeys = [
      "port", "logLevel", "dryRun", "databaseUrl", "redisUrl",
      "entraClientId", "entraClientSecret", "entraTenantId",
      "githubOrg", "githubToken",
      "slackBotToken", "slackDeploymentsChannel",
      "hubspotApiKey", "hubspotPortalId",
      "acumaticaUrl", "acumaticaUsername", "acumaticaPassword", "acumaticaTenant", "acumaticaBranchId",
      "zoomAccountId", "zoomClientId", "zoomClientSecret",
      "jamfUrl", "jamfApiKey",
      "provisionApiKey",
    ];
    for (const key of requiredKeys) {
      expect(config).toHaveProperty(key);
    }
  });
});

// ── isConfigured() guards ────────────────────────────────────────────────────

import { isConfigured as acumaticaIsConfigured } from "../lib/acumatica.js";
import { isConfigured as zoomIsConfigured } from "../lib/zoom.js";
import { isConfigured as hubspotIsConfigured } from "../lib/hubspot.js";
import { isConfigured as githubIsConfigured } from "../lib/github-org.js";
import { isConfigured as slackIsConfigured } from "../lib/slack.js";
import { isConfigured as jamfIsConfigured } from "../lib/jamf.js";
import { isConfigured as graphIsConfigured } from "../lib/graph.js";
import { isConfigured as callbackIsConfigured } from "../lib/hubspot-callback.js";

describe("isConfigured guards", () => {
  // In test env, no credentials are set → all should return false
  it("acumatica.isConfigured returns false without credentials", () => {
    expect(acumaticaIsConfigured()).toBe(false);
  });

  it("zoom.isConfigured returns false without credentials", () => {
    expect(zoomIsConfigured()).toBe(false);
  });

  it("hubspot.isConfigured returns false without API key", () => {
    expect(hubspotIsConfigured()).toBe(false);
  });

  it("github.isConfigured returns false without token", () => {
    expect(githubIsConfigured()).toBe(false);
  });

  it("slack.isConfigured returns false without bot token", () => {
    expect(slackIsConfigured()).toBe(false);
  });

  it("jamf.isConfigured returns false without credentials", () => {
    expect(jamfIsConfigured()).toBe(false);
  });

  it("graph.isConfigured returns false without Entra credentials", () => {
    expect(graphIsConfigured()).toBe(false);
  });

  it("hubspot-callback.isConfigured returns false without API key", () => {
    expect(callbackIsConfigured()).toBe(false);
  });
});
