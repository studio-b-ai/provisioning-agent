/**
 * Role-Based Entitlement Matrix — maps department to M365 license tier + app entitlements.
 *
 * Resolution priority (3-layer cascade):
 *   1. Explicit appEntitlements/licenseTier in request → use those (API/CLI override)
 *   2. Department lookup in ENTITLEMENT_MATRIX        → use department defaults
 *   3. No department or unknown department             → all apps + standard (backward-compatible)
 *
 * Pure function — no I/O, no side effects. Easy to test and audit.
 */

import type { AppEntitlement, LicenseTier } from "./graph.js";

// ─── Department Profile ──────────────────────────────────────────────

export interface DepartmentProfile {
  licenseTier: LicenseTier;
  apps: AppEntitlement[];
  description: string;
}

// ─── Entitlement Matrix ──────────────────────────────────────────────
//
// Heritage Fabrics department → license + app mapping.
// Confirmed by Kevin 2026-03-10.
//

export const ENTITLEMENT_MATRIX: Record<string, DepartmentProfile> = {
  ADMIN: {
    licenseTier: "standard",
    apps: ["acumatica", "zoomPhone", "github", "slack", "hubspot"],
    description: "Full access — all apps + Business Premium",
  },
  SALES: {
    licenseTier: "standard",
    apps: ["hubspot", "zoomPhone", "slack"],
    description: "CRM + phone + messaging",
  },
  WAREHOUSE: {
    licenseTier: "shared_mailbox",
    apps: [],
    description: "Exchange Plan 1 only — comms via WMS app banner",
  },
  DESIGN: {
    licenseTier: "standard",
    apps: ["acumatica", "slack", "hubspot"],
    description: "ERP + messaging + CRM",
  },
  FINANCE: {
    licenseTier: "standard",
    apps: ["acumatica", "slack", "hubspot"],
    description: "ERP + messaging + CRM",
  },
};

// ─── Resolved Entitlements ───────────────────────────────────────────

export interface ResolvedEntitlements {
  licenseTier: LicenseTier;
  apps: AppEntitlement[];
  /** Where the resolution came from — for audit logging */
  source: "explicit" | "department" | "default";
  /** Human-readable description of why these entitlements were chosen */
  reason: string;
}

// ─── All apps constant (backward-compatible default) ─────────────────

const ALL_APPS: AppEntitlement[] = [
  "acumatica",
  "zoomPhone",
  "github",
  "slack",
  "hubspot",
];

// ─── Resolver ────────────────────────────────────────────────────────

/**
 * Resolve license tier + app entitlements for an employee.
 *
 * @param department      - Employee department (e.g., "ADMIN", "WAREHOUSE")
 * @param explicitApps    - Explicit app list from API/CLI (layer 1 override)
 * @param explicitTier    - Explicit license tier from API/CLI (layer 1 override)
 */
export function resolveFromDepartment(
  department?: string,
  explicitApps?: AppEntitlement[],
  explicitTier?: LicenseTier
): ResolvedEntitlements {
  // Layer 1: Explicit overrides — if EITHER is provided, use explicit mode.
  // Missing explicit values fall through to department/default for that field.
  if (explicitApps?.length || explicitTier) {
    const deptProfile = department
      ? ENTITLEMENT_MATRIX[department.toUpperCase()]
      : undefined;

    return {
      licenseTier:
        explicitTier ??
        deptProfile?.licenseTier ??
        "standard",
      apps: explicitApps?.length
        ? explicitApps
        : deptProfile?.apps ?? ALL_APPS,
      source: "explicit",
      reason: explicitApps?.length && explicitTier
        ? `Explicit override: tier=${explicitTier}, apps=[${explicitApps.join(", ")}]`
        : explicitTier
          ? `Explicit tier=${explicitTier}, apps from ${deptProfile ? `department ${department}` : "default (all)"}`
          : `Explicit apps=[${explicitApps!.join(", ")}], tier from ${deptProfile ? `department ${department}` : "default (standard)"}`,
    };
  }

  // Layer 2: Department lookup
  if (department) {
    const profile = ENTITLEMENT_MATRIX[department.toUpperCase()];
    if (profile) {
      return {
        licenseTier: profile.licenseTier,
        apps: [...profile.apps],
        source: "department",
        reason: `Department ${department.toUpperCase()}: ${profile.description}`,
      };
    }

    // Known department but not in matrix — fall through to default
    return {
      licenseTier: "standard",
      apps: [...ALL_APPS],
      source: "default",
      reason: `Unknown department "${department}" — using default (all apps + standard)`,
    };
  }

  // Layer 3: No department — backward-compatible default
  return {
    licenseTier: "standard",
    apps: [...ALL_APPS],
    source: "default",
    reason: "No department specified — using default (all apps + standard)",
  };
}
