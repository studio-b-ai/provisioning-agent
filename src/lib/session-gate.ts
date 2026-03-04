// ─── Acumatica API Session Gate ─────────────────────────────────────────────
// Redis-based distributed semaphore preventing "API Login Limit" errors
// by coordinating concurrent Acumatica sessions across Railway services.
//
// Uses a Redis sorted set with TTL-based lease expiration and atomic Lua scripts.
// Graceful degradation: if Redis is unreachable, services operate without coordination.

import type { Redis } from "ioredis";
import { randomUUID } from "crypto";
import type { Logger } from "pino";

const GATE_KEY = "acumatica:session-gate";

// ── Lua Scripts (atomic Redis operations) ────────────────────────────────────

// Prune expired leases, then acquire if under capacity
const ACQUIRE_LUA = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  local count = redis.call('ZCARD', KEYS[1])
  if count < tonumber(ARGV[2]) then
    redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
    return 1
  end
  return 0
`;

const RELEASE_LUA = `
  return redis.call('ZREM', KEYS[1], ARGV[1])
`;

const RENEW_LUA = `
  local exists = redis.call('ZSCORE', KEYS[1], ARGV[1])
  if exists then
    redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
    return 1
  end
  return 0
`;

const STATUS_LUA = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  return redis.call('ZRANGE', KEYS[1], 0, -1)
`;

// ── Types ────────────────────────────────────────────────────────────────────

export interface SessionGateOptions {
  serviceId: string;
  maxConcurrent?: number;      // default 2
  leaseTtlMs?: number;         // default 120_000 (2 min)
  acquireTimeoutMs?: number;   // default 90_000 (90 sec)
  pollIntervalMs?: number;     // default 2_000 (2 sec)
}

export interface Lease {
  id: string;
  acquiredAt: number;
  expiresAt: number;
  degraded: boolean;
}

export class SessionGateTimeoutError extends Error {
  serviceId: string;
  waitMs: number;
  activeHolders: string[];

  constructor(serviceId: string, waitMs: number, activeHolders: string[]) {
    super(`Session gate timeout after ${waitMs}ms — all ${activeHolders.length} slots occupied`);
    this.name = "SessionGateTimeoutError";
    this.serviceId = serviceId;
    this.waitMs = waitMs;
    this.activeHolders = activeHolders;
  }
}

// ── Session Gate ─────────────────────────────────────────────────────────────

export class AcumaticaSessionGate {
  private readonly serviceId: string;
  private readonly maxConcurrent: number;
  private readonly leaseTtlMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly redis: Redis;
  private readonly log: Logger;
  private readonly activeLeases = new Set<string>();
  private degraded = false;

  constructor(redis: Redis, log: Logger, opts: SessionGateOptions) {
    this.redis = redis;
    this.log = log.child({ module: "session-gate" });
    this.serviceId = opts.serviceId;
    this.maxConcurrent = opts.maxConcurrent ?? parseInt(process.env.SESSION_GATE_MAX || "2", 10);
    this.leaseTtlMs = opts.leaseTtlMs ?? 120_000;
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? 90_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
  }

  private degradedLease(): Lease {
    const lease: Lease = {
      id: `${this.serviceId}:degraded:${randomUUID()}`,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + this.leaseTtlMs,
      degraded: true,
    };
    this.activeLeases.add(lease.id);
    return lease;
  }

  async acquire(): Promise<Lease> {
    if (this.degraded) return this.degradedLease();

    const leaseId = `${this.serviceId}:${randomUUID()}`;
    const started = Date.now();

    while (true) {
      const now = Date.now();
      const elapsed = now - started;

      if (elapsed > this.acquireTimeoutMs) {
        let holders: string[] = [];
        try {
          holders = await this.redis.eval(STATUS_LUA, 1, GATE_KEY, String(now)) as string[];
        } catch { /* best effort */ }

        this.log.error({ serviceId: this.serviceId, waitMs: elapsed, holders }, "session-gate:timeout");
        throw new SessionGateTimeoutError(this.serviceId, elapsed, holders);
      }

      try {
        const expiresAt = now + this.leaseTtlMs;
        const acquired = await this.redis.eval(
          ACQUIRE_LUA, 1, GATE_KEY,
          String(now),
          String(this.maxConcurrent),
          String(expiresAt),
          leaseId
        );

        if (acquired === 1) {
          const lease: Lease = { id: leaseId, acquiredAt: now, expiresAt, degraded: false };
          this.activeLeases.add(leaseId);

          let activeCount: number | string = "?";
          try {
            const members = await this.redis.eval(STATUS_LUA, 1, GATE_KEY, String(now)) as string[];
            activeCount = members.length;
          } catch { /* best effort */ }

          this.log.info({ leaseId, serviceId: this.serviceId, waitMs: elapsed, activeCount }, "session-gate:acquired");
          return lease;
        }

        // Slot not available — wait and retry
        if (elapsed === 0 || elapsed % 10_000 < this.pollIntervalMs) {
          this.log.debug({ serviceId: this.serviceId, waitMs: elapsed, maxConcurrent: this.maxConcurrent }, "session-gate:waiting");
        }
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      } catch (err) {
        if (err instanceof SessionGateTimeoutError) throw err;
        this.log.warn({ serviceId: this.serviceId, err }, "session-gate:degraded — Redis error during acquire");
        this.degraded = true;
        return this.degradedLease();
      }
    }
  }

  async release(lease: Lease): Promise<void> {
    if (!lease) return;
    this.activeLeases.delete(lease.id);
    if (lease.degraded || this.degraded) return;

    try {
      await this.redis.eval(RELEASE_LUA, 1, GATE_KEY, lease.id);
      const heldMs = Date.now() - lease.acquiredAt;

      let activeCount: number | string = "?";
      try {
        const members = await this.redis.eval(STATUS_LUA, 1, GATE_KEY, String(Date.now())) as string[];
        activeCount = members.length;
      } catch { /* best effort */ }

      this.log.info({ leaseId: lease.id, serviceId: this.serviceId, heldMs, activeCount }, "session-gate:released");
    } catch (err) {
      this.log.warn({ leaseId: lease.id, err }, "session-gate:release-failed");
    }
  }

  async renew(lease: Lease, extensionMs?: number): Promise<void> {
    if (!lease || lease.degraded || this.degraded) return;
    const newExpiry = Date.now() + (extensionMs ?? this.leaseTtlMs);
    try {
      const renewed = await this.redis.eval(RENEW_LUA, 1, GATE_KEY, lease.id, String(newExpiry));
      if (renewed === 1) {
        lease.expiresAt = newExpiry;
        this.log.debug({ leaseId: lease.id, newExpiry: new Date(newExpiry).toISOString() }, "session-gate:renewed");
      } else {
        this.log.warn({ leaseId: lease.id }, "session-gate:renew-failed — lease expired");
      }
    } catch (err) {
      this.log.warn({ leaseId: lease.id, err }, "session-gate:renew-error");
    }
  }

  async withSession<T>(fn: (lease: Lease) => Promise<T>): Promise<T> {
    const lease = await this.acquire();
    try {
      return await fn(lease);
    } finally {
      await this.release(lease);
    }
  }

  async status(): Promise<{ active: number; max: number; holders: string[]; degraded: boolean }> {
    if (this.degraded) {
      return { active: this.activeLeases.size, max: this.maxConcurrent, holders: Array.from(this.activeLeases), degraded: true };
    }
    try {
      const holders = await this.redis.eval(STATUS_LUA, 1, GATE_KEY, String(Date.now())) as string[];
      return { active: holders.length, max: this.maxConcurrent, holders, degraded: false };
    } catch {
      return { active: this.activeLeases.size, max: this.maxConcurrent, holders: Array.from(this.activeLeases), degraded: true };
    }
  }

  async shutdown(): Promise<void> {
    for (const leaseId of Array.from(this.activeLeases)) {
      await this.release({ id: leaseId, acquiredAt: 0, expiresAt: 0, degraded: false });
    }
    this.activeLeases.clear();
  }
}
