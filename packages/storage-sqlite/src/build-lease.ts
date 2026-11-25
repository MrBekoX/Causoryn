import { randomUUID } from "node:crypto";
import os from "node:os";

/**
 * Build-lease liveness rule for the shared per-workspace SQLite database
 * (Task 1.7 acceptance criteria 2 and 3).
 *
 * A lease row records who is building: `owner_pid`, `hostname`
 * (`os.hostname()` of the owner), `owner_instance` (a per-process instance id)
 * and the heartbeat/TTL timestamps. An acquirer (or orphan recovery) decides
 * whether the current holder is still alive in this order:
 *
 * 1. Same host + same PID + same instance + the lease is registered as active
 *    in this process -> ALIVE (`local-build-active`), regardless of TTL.
 * 2. Heartbeat older than the hard staleness ceiling (default 10 minutes) ->
 *    DEAD (`stale-heartbeat`). This survives PID reuse and hung owners.
 * 3. Different (or unknown/NULL) hostname -> PIDs are meaningless across
 *    machines, so TTL only: ALIVE while `expires_at > now`
 *    (`foreign-host-ttl-valid`), otherwise DEAD (`foreign-host-ttl-expired`).
 * 4. Same host, different PID -> PID liveness is primary: ALIVE while the PID
 *    is alive (`pid-alive`) even if the TTL expired (the owner's heartbeat may
 *    be starved by a blocked event loop); DEAD as soon as the PID is gone
 *    (`pid-dead`).
 * 5. Same host, same PID, different/unknown instance -> the PID was reused by
 *    this process after the original owner died -> DEAD (`pid-reused`).
 * 6. Same host, same PID, same instance, not registered locally (e.g. the
 *    owning worker thread crashed and its release was lost, or the lease was
 *    taken by another thread whose registry this thread cannot see) -> TTL:
 *    ALIVE while unexpired (`same-process-ttl-valid`), else DEAD
 *    (`same-process-ttl-expired`). The main thread renews worker leases on
 *    its own connection, so a live worker never reaches this branch expired.
 */

/** Default hard staleness ceiling for lease heartbeats (10 minutes). */
export const DEFAULT_LEASE_STALE_CEILING_MS = 10 * 60_000;

/**
 * Default per-process lease owner instance id. Worker threads receive the
 * main thread's id explicitly so the whole process shares one instance id.
 */
export const PROCESS_LEASE_INSTANCE_ID: string = randomUUID();

export type BuildLeaseLivenessReason =
  | "local-build-active"
  | "stale-heartbeat"
  | "foreign-host-ttl-valid"
  | "foreign-host-ttl-expired"
  | "pid-alive"
  | "pid-dead"
  | "pid-reused"
  | "same-process-ttl-valid"
  | "same-process-ttl-expired";

export interface BuildLeaseLivenessInput {
  readonly leaseId: string;
  readonly ownerPid: number;
  readonly hostname: string | null;
  readonly ownerInstance: string | null;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
}

export interface BuildLeaseLivenessContext {
  readonly nowIso: string;
  /** Hostname of the evaluating process (default `os.hostname()`). */
  readonly hostname?: string;
  /** Instance id of the evaluating process (default `PROCESS_LEASE_INSTANCE_ID`). */
  readonly processInstanceId?: string;
  /** PID liveness predicate (default `defaultIsPidAlive`). */
  readonly isPidAlive?: (pid: number) => boolean;
  /**
   * Same-process registry probe: `true` when the lease is held by a build that
   * is active in this process, `undefined` when unknown. Never authoritative
   * for "dead"; an unknown same-process lease falls back to its TTL.
   */
  readonly isLocalLeaseActive?: (leaseId: string) => boolean | undefined;
  /** Hard staleness ceiling in ms (default `DEFAULT_LEASE_STALE_CEILING_MS`). */
  readonly staleCeilingMs?: number;
}

export interface BuildLeaseLiveness {
  readonly alive: boolean;
  readonly reason: BuildLeaseLivenessReason;
}

/**
 * Checks whether a local OS PID is alive using `process.kill(pid, 0)`.
 * - `pid <= 0` or non-integer -> false (never signals process group 0 / -1).
 * - Success or `EPERM` -> true (process exists).
 * - `ESRCH` / `EINVAL` / anything else -> false.
 */
export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === "EPERM";
  }
}

/** Current machine hostname used for lease identity. */
export function currentLeaseHostname(): string {
  return os.hostname();
}

function sameHostname(a: string, b: string): boolean {
  // Hostnames are case-insensitive (RFC 4343; Windows NetBIOS names).
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function isExpired(expiresAt: string, nowMs: number): boolean {
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return true;
  if (!Number.isFinite(nowMs)) return false;
  return expiresMs <= nowMs;
}

/** Normalizes an optional staleness ceiling; invalid values fall back to the default. */
export function resolveLeaseStaleCeilingMs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_LEASE_STALE_CEILING_MS;
}

/** Applies the documented liveness rule (see module header) to one lease row. */
export function evaluateBuildLeaseLiveness(
  lease: BuildLeaseLivenessInput,
  context: BuildLeaseLivenessContext,
): BuildLeaseLiveness {
  const nowMs = Date.parse(context.nowIso);
  const localHostname = context.hostname ?? currentLeaseHostname();
  const instance = context.processInstanceId ?? PROCESS_LEASE_INSTANCE_ID;
  const isPidAlive = context.isPidAlive ?? defaultIsPidAlive;
  const staleCeilingMs = resolveLeaseStaleCeilingMs(context.staleCeilingMs);

  const sameHost = lease.hostname !== null && sameHostname(lease.hostname, localHostname);
  const sameProcess =
    sameHost && lease.ownerPid === process.pid && lease.ownerInstance === instance;

  if (sameProcess && context.isLocalLeaseActive?.(lease.leaseId) === true) {
    return { alive: true, reason: "local-build-active" };
  }

  const heartbeatMs = Date.parse(lease.heartbeatAt);
  const heartbeatAgeMs =
    Number.isFinite(heartbeatMs) && Number.isFinite(nowMs)
      ? nowMs - heartbeatMs
      : Number.POSITIVE_INFINITY;
  if (heartbeatAgeMs > staleCeilingMs) {
    return { alive: false, reason: "stale-heartbeat" };
  }

  const expired = isExpired(lease.expiresAt, nowMs);
  if (!sameHost) {
    return expired
      ? { alive: false, reason: "foreign-host-ttl-expired" }
      : { alive: true, reason: "foreign-host-ttl-valid" };
  }

  if (lease.ownerPid !== process.pid) {
    return isPidAlive(lease.ownerPid)
      ? { alive: true, reason: "pid-alive" }
      : { alive: false, reason: "pid-dead" };
  }

  if (lease.ownerInstance !== instance) {
    return { alive: false, reason: "pid-reused" };
  }

  return expired
    ? { alive: false, reason: "same-process-ttl-expired" }
    : { alive: true, reason: "same-process-ttl-valid" };
}
