/**
 * Acumatica Employee provisioning — DRY_RUN aware.
 *
 * Creates Employee records with ContactInfo via REST API.
 * User account creation (login credentials, roles) is NOT supported by
 * the Acumatica REST API — that step is flagged for manual action.
 *
 * API: https://heritagefabrics.acumatica.com/entity/default/24.200.001/Employee
 */

import pino from "pino";
import type { Redis } from "ioredis";
import { config } from "./config.js";
import { AcumaticaSessionGate } from "./session-gate.js";

const logger = pino({ level: config.logLevel });

let sessionCookie: string | null = null;
let sessionExpiresAt = 0;
let _gate: AcumaticaSessionGate | undefined;

export function initAcumaticaGate(redis: Redis): void {
  _gate = new AcumaticaSessionGate(redis, logger, {
    serviceId: "provisioning-agent",
  });
}

async function gated<T>(fn: () => Promise<T>): Promise<T> {
  if (_gate) return _gate.withSession(fn);
  return fn();
}

// ─── Session Management ─────────────────────────────────────────────

async function authenticate(): Promise<string> {
  if (sessionCookie && Date.now() < sessionExpiresAt - 60_000) {
    return sessionCookie;
  }

  const res = await fetch(`${config.acumaticaUrl}/entity/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: config.acumaticaUsername,
      password: config.acumaticaPassword,
      tenant: config.acumaticaTenant,
    }),
  });

  if (!res.ok) {
    throw new Error(`Acumatica login failed: ${res.status} ${await res.text().catch(() => "")}`);
  }

  // Extract session cookie from Set-Cookie header
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/\.ASPXAUTH=([^;]+)/);
  if (!match) {
    throw new Error("Acumatica login succeeded but no session cookie returned");
  }

  sessionCookie = `.ASPXAUTH=${match[1]}`;
  sessionExpiresAt = Date.now() + 20 * 60_000; // 20-minute session
  logger.info("Acumatica session acquired");
  return sessionCookie;
}

async function acumaticaFetch(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const cookie = await authenticate();
  const url = `${config.acumaticaUrl}/entity/default/24.200.001${endpoint}`;

  const res = await fetch(url, {
    method,
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Acumatica ${method} ${endpoint}: ${res.status} ${text.slice(0, 300)}`);
  }

  if (res.status === 204) return {};
  return res.json();
}

async function logout(): Promise<void> {
  if (!sessionCookie) return;
  try {
    await fetch(`${config.acumaticaUrl}/entity/auth/logout`, {
      method: "POST",
      headers: { Cookie: sessionCookie },
    });
  } catch {
    // best-effort
  }
  sessionCookie = null;
  sessionExpiresAt = 0;
}

// ─── Employee CRUD ──────────────────────────────────────────────────

export interface NewEmployee {
  firstName: string;
  lastName: string;
  email: string;
  department?: string;
  jobTitle?: string;
  phone?: string;
  branchId?: string;
  employeeClass?: string;
}

export async function createEmployee(emp: NewEmployee): Promise<{ employeeId: string } | null> {
  if (config.dryRun) {
    logger.info(
      { action: "createEmployee", email: emp.email, name: `${emp.firstName} ${emp.lastName}`, dryRun: true },
      "[DRY RUN] Would create Acumatica Employee record"
    );
    return { employeeId: `dry-run-${Date.now()}` };
  }

  return gated(async () => {
    try {
      const result = await acumaticaFetch("PUT", "/Employee", {
        EmployeeName: { value: `${emp.firstName} ${emp.lastName}` },
        Status: { value: "Active" },
        ContactInfo: {
          FirstName: { value: emp.firstName },
          LastName: { value: emp.lastName },
          Email: { value: emp.email },
          ...(emp.phone ? { Phone1: { value: emp.phone }, Phone1Type: { value: "Business 1" } } : {}),
        },
        EmployeeSettings: {
          BranchID: { value: emp.branchId ?? config.acumaticaBranchId },
          DepartmentID: { value: emp.department ?? "ADMIN" },
          EmployeeClass: { value: emp.employeeClass ?? "DEFAULT" },
          Calendar: { value: "EASTERN" },
          CurrencyID: { value: "USD" },
          RouteEmails: { value: true },
        },
      }) as { EmployeeID?: { value: string } };

      const employeeId = result?.EmployeeID?.value;
      if (employeeId) {
        logger.info({ employeeId, email: emp.email }, "Acumatica Employee created");
      }
      return employeeId ? { employeeId } : null;
    } finally {
      await logout();
    }
  });
}

export async function deactivateEmployee(employeeId: string): Promise<boolean> {
  if (config.dryRun) {
    logger.info(
      { action: "deactivateEmployee", employeeId, dryRun: true },
      "[DRY RUN] Would deactivate Acumatica Employee"
    );
    return true;
  }

  return gated(async () => {
    try {
      await acumaticaFetch("PUT", "/Employee", {
        EmployeeID: { value: employeeId },
        Status: { value: "Inactive" },
      });
      logger.info({ employeeId }, "Acumatica Employee deactivated");
      return true;
    } catch (err) {
      logger.error({ err, employeeId }, "Acumatica Employee deactivation failed");
      return false;
    } finally {
      await logout();
    }
  });
}

export async function findEmployeeByEmail(email: string): Promise<string | null> {
  if (!config.acumaticaUrl || !config.acumaticaUsername) {
    logger.info({ email }, "[DRY RUN] Acumatica not configured — skipping employee lookup");
    return null;
  }

  return gated(async () => {
    try {
      const results = await acumaticaFetch(
        "GET",
        `/Employee?$filter=ContactInfo/Email eq '${encodeURIComponent(email)}'&$select=EmployeeID`
      ) as Array<{ EmployeeID?: { value: string } }>;

      return results?.[0]?.EmployeeID?.value ?? null;
    } catch (err) {
      logger.warn({ err, email }, "Acumatica employee lookup failed");
      return null;
    } finally {
      await logout();
    }
  });
}

export function isConfigured(): boolean {
  return !!(config.acumaticaUrl && config.acumaticaUsername && config.acumaticaPassword);
}
