import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IndexJobManager,
  IndexService,
  type IndexProgressEvent,
  type IndexRunResult,
} from "@causoryn/indexing";
import { SqliteGraphRepository } from "@causoryn/storage-sqlite";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

/**
 * Task 1.7 follow-up — shared index honesty:
 * - a job that did not publish is never reported as `done` / "Published";
 * - the build lease is claimed BEFORE analysis, a second builder waits for
 *   the live peer and reuses its snapshot without re-analyzing;
 * - a live same-host owner whose TTL expired is not treated as dead;
 * - heartbeats: phase-boundary renewals inside the run and a main-thread
 *   heartbeat for worker-held leases; a crashed worker's lease is released.
 */

const WS = "ws_shared_lease";
const T0 = "2026-11-24T12:00:00.000Z";
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FAKE_WORKER = path.join(TEST_DIR, "fixtures", "indexing", "fake-lease-worker.mjs");

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "causoryn-shared-lease-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

interface Arena {
  readonly workspaceDir: string;
  readonly dbPath: string;
  readonly policy: WorkspaceAccessPolicy;
}

function createArena(withCSharp: boolean): Arena {
  const workspaceDir = path.join(tempRoot, "workspace");
  const dataDir = path.join(tempRoot, "data");
  mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(workspaceDir, "src", "orders.ts"),
    "export function createOrder(id: string): string { return id; }\n",
    "utf8",
  );
  if (withCSharp) {
    writeFileSync(
      path.join(workspaceDir, "src", "billing.cs"),
      "namespace Demo { public class Billing {} }\n",
      "utf8",
    );
  }
  return {
    workspaceDir,
    dbPath: path.join(dataDir, "graph.sqlite"),
    policy: WorkspaceAccessPolicy.create({ allowRoots: [workspaceDir] }),
  };
}

/** C# analyzer stub: counts calls and can be held open to keep a build "in analysis". */
function makeCSharpStub() {
  let calls = 0;
  let release: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  const stub = {
    get calls(): number {
      return calls;
    },
    hold(): void {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release(): void {
      release();
    },
    analyze: async () => {
      calls += 1;
      await gate;
      return {
        analyzerId: "roslyn-worker" as const,
        analyzerVersion: "0.1.0",
        workerAvailable: false,
        state: "partial" as const,
        coverageRatio: 0,
        capabilities: {
          astParse: false,
          symbolResolution: false,
          containsEdges: false,
          callEdges: false,
          importEdges: false,
          routeDetection: "worker-unavailable",
          frameworkLinkers: false,
        },
        unsupportedConstructs: [],
        nodes: [
          {
            kind: "File" as const,
            qualifiedName: "src/billing.cs",
            language: "csharp",
            relativePath: "src/billing.cs",
          },
        ],
        edges: [],
        evidence: [],
        diagnostics: [],
        warnings: ["roslyn worker test stub"],
      };
    },
  };
  return stub;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition not reached in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function outcomeOf(result: IndexRunResult): unknown {
  return (result as unknown as { outcome?: unknown }).outcome;
}

describe("job honesty: a job that did not publish is never `done`", { timeout: 60_000 }, () => {
  it("full job -> done/published; unchanged incremental job -> reused/unchanged with an honest message", async () => {
    const arena = createArena(false);
    const repo = new SqliteGraphRepository(arena.dbPath);
    try {
      const service = new IndexService({
        workspaceId: WS,
        policy: arena.policy,
        repository: repo,
        clock: () => T0,
        limits: { maxFiles: 100 },
      });
      const manager = new IndexJobManager({
        indexService: service,
        policy: arena.policy,
        clock: () => T0,
        useWorkerThread: false,
      });
      const full = await manager.waitForJob(
        manager.refreshIndex(arena.workspaceDir, { mode: "full" }).jobId,
      );
      expect(full.status).toBe("done");
      expect((full as unknown as Record<string, unknown>)["outcome"]).toBe("published");
      expect((full as unknown as Record<string, unknown>)["published"]).toBe(true);
      expect(full.progress.message).toBe(`Published snapshot ${String(full.snapshotId)}`);

      const noop = await manager.waitForJob(
        manager.refreshIndex(arena.workspaceDir, { mode: "incremental" }).jobId,
      );
      expect(noop.status).toBe("reused");
      expect((noop as unknown as Record<string, unknown>)["outcome"]).toBe("unchanged");
      expect((noop as unknown as Record<string, unknown>)["published"]).toBe(false);
      expect(noop.snapshotId).toBe(full.snapshotId);
      expect(noop.progress.message).toBe(`No changes; snapshot ${String(full.snapshotId)} is current`);
      expect(noop.progress.message).not.toMatch(/Published/);
      manager.close();
    } finally {
      repo.close();
    }
  });

  it("worker-thread jobs carry the outcome through (unchanged incremental job is `reused`)", async () => {
    const arena = createArena(false);
    const repo = new SqliteGraphRepository(arena.dbPath);
    try {
      const service = new IndexService({
        workspaceId: WS,
        policy: arena.policy,
        repository: repo,
        clock: () => new Date().toISOString(),
        limits: { maxFiles: 100 },
        tolerateConcurrentPublishRace: true,
      });
      const manager = new IndexJobManager({
        indexService: service,
        policy: arena.policy,
        clock: () => new Date().toISOString(),
        workerDbPath: arena.dbPath,
      });
      const full = await manager.waitForJob(
        manager.refreshIndex(arena.workspaceDir, { mode: "full" }).jobId,
      );
      expect(full.executionMode).toBe("worker");
      expect(full.status).toBe("done");
      const noop = await manager.waitForJob(
        manager.refreshIndex(arena.workspaceDir, { mode: "incremental" }).jobId,
      );
      expect(noop.executionMode).toBe("worker");
      expect(noop.status).toBe("reused");
      expect((noop as unknown as Record<string, unknown>)["outcome"]).toBe("unchanged");
      expect(noop.progress.message).not.toMatch(/Published/);
      manager.close();
    } finally {
      repo.close();
    }
  });

  it("losing the concurrent publish race -> reused/reused_peer, never done (verification scenario)", async () => {
    const arena = createArena(false);
    const repoA = new SqliteGraphRepository(arena.dbPath);
    const repoB = new SqliteGraphRepository(arena.dbPath);
    try {
      const serviceA = new IndexService({
        workspaceId: WS,
        policy: arena.policy,
        repository: repoA,
        clock: () => T0,
        limits: { maxFiles: 100 },
        tolerateConcurrentPublishRace: true,
      });
      // Constructed before A publishes: B still believes sequence 1 is free.
      const serviceB = new IndexService({
        workspaceId: WS,
        policy: arena.policy,
        repository: repoB,
        clock: () => T0,
        limits: { maxFiles: 100 },
        tolerateConcurrentPublishRace: true,
      });
      const winner = serviceA.runIndex(arena.workspaceDir);
      expect(winner.published).toBe(true);

      const managerB = new IndexJobManager({
        indexService: serviceB,
        policy: arena.policy,
        clock: () => T0,
        useWorkerThread: false,
      });
      const lost = await managerB.waitForJob(
        managerB.refreshIndex(arena.workspaceDir, { mode: "full" }).jobId,
      );
      expect(lost.status).toBe("reused");
      expect((lost as unknown as Record<string, unknown>)["outcome"]).toBe("reused_peer");
      expect((lost as unknown as Record<string, unknown>)["published"]).toBe(false);
      expect(lost.snapshotId).toBe(winner.snapshotId);
      expect(lost.progress.message).toBe(
        `A concurrent build published snapshot ${winner.snapshotId} first; reused it`,
      );
      managerB.close();
    } finally {
      repoA.close();
      repoB.close();
    }
  });
});

describe("lease claimed before analysis: the second builder waits and reuses", { timeout: 60_000 }, () => {
  it("a second service waits for the live peer, emits waiting_for_peer and reuses its snapshot without analyzing", async () => {
    const arena = createArena(true);
    const repoA = new SqliteGraphRepository(arena.dbPath);
    const repoB = new SqliteGraphRepository(arena.dbPath);
    const stubA = makeCSharpStub();
    const stubB = makeCSharpStub();
    try {
      const serviceA = new IndexService({
        workspaceId: WS,
        policy: arena.policy,
        repository: repoA,
        clock: () => T0,
        limits: { maxFiles: 100 },
        csharp: { analyzeCSharp: stubA.analyze },
        tolerateConcurrentPublishRace: true,
      });
      const serviceB = new IndexService({
        workspaceId: WS,
        policy: arena.policy,
        repository: repoB,
        clock: () => T0,
        limits: { maxFiles: 100 },
        csharp: { analyzeCSharp: stubB.analyze },
        tolerateConcurrentPublishRace: true,
        peerPollIntervalMs: 20,
      });

      stubA.hold();
      const runA = serviceA.runIndexAsync(arena.workspaceDir);
      await waitUntil(() => stubA.calls === 1);
      // A is analyzing: the lease must already be held (claimed before analysis).
      expect(repoB.getActiveBuildLease(WS)).toBeDefined();

      const eventsB: IndexProgressEvent[] = [];
      const runB = serviceB.runIndexAsync(arena.workspaceDir, {
        onProgress: (event) => eventsB.push(event),
      });
      await waitUntil(() => eventsB.some((event) => event.phase === "waiting_for_peer"));
      expect(stubB.calls).toBe(0);

      stubA.release();
      const [resultA, resultB] = await Promise.all([runA, runB]);
      expect(resultA.published).toBe(true);
      expect(outcomeOf(resultA)).toBe("published");
      expect(resultB.published).toBe(false);
      expect(outcomeOf(resultB)).toBe("reused_peer");
      expect(resultB.snapshotId).toBe(resultA.snapshotId);
      expect(stubB.calls).toBe(0);
      expect(repoA.getActiveBuildLease(WS)).toBeUndefined();
      expect(repoA.getLatestPublished(WS)?.stale).toBe(false);
    } finally {
      stubA.release();
      repoA.close();
      repoB.close();
    }
  });

  it("a busy database while claiming the lease (peer holds the write lock) is retried, not fatal", async () => {
    const arena = createArena(false);
    const repo = new SqliteGraphRepository(arena.dbPath);
    try {
      let busyFailures = 0;
      const originalAcquire = repo.acquireBuildLease.bind(repo);
      repo.acquireBuildLease = (input) => {
        if (busyFailures < 2) {
          busyFailures += 1;
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        }
        return originalAcquire(input);
      };
      const service = new IndexService({
        workspaceId: WS,
        policy: arena.policy,
        repository: repo,
        clock: () => T0,
        limits: { maxFiles: 100 },
        peerPollIntervalMs: 10,
      });
      const result = await service.runIndexAsync(arena.workspaceDir);
      expect(busyFailures).toBe(2);
      expect(result.published).toBe(true);
      expect(outcomeOf(result)).toBe("published");
    } finally {
      repo.close();
    }
  });

  it("gives up after the configured max wait with outcome peer_busy and never analyzes", async () => {
    const arena = createArena(true);
    const repoA = new SqliteGraphRepository(arena.dbPath);
    const repoB = new SqliteGraphRepository(arena.dbPath);
    const stubA = makeCSharpStub();
    const stubB = makeCSharpStub();
    try {
      const serviceA = new IndexService({
        workspaceId: WS,
        policy: arena.policy,
        repository: repoA,
        clock: () => T0,
        limits: { maxFiles: 100 },
        csharp: { analyzeCSharp: stubA.analyze },
        tolerateConcurrentPublishRace: true,
      });
      const baseline = await serviceA.runIndexAsync(arena.workspaceDir);
      expect(baseline.published).toBe(true);
      writeFileSync(
        path.join(arena.workspaceDir, "src", "orders.ts"),
        "export function createOrderV2(id: string): string { return id; }\n",
        "utf8",
      );

      stubA.hold();
      const runA = serviceA.runIndexAsync(arena.workspaceDir);
      await waitUntil(() => stubA.calls === 2);

      const serviceB = new IndexService({
        workspaceId: WS,
        policy: arena.policy,
        repository: repoB,
        clock: () => T0,
        limits: { maxFiles: 100 },
        csharp: { analyzeCSharp: stubB.analyze },
        tolerateConcurrentPublishRace: true,
        peerPollIntervalMs: 20,
        peerWaitTimeoutMs: 250,
      });
      const resultB = await serviceB.runIndexAsync(arena.workspaceDir);
      expect(resultB.published).toBe(false);
      expect(outcomeOf(resultB)).toBe("peer_busy");
      expect(resultB.waitingForPeer).toBe(true);
      expect(resultB.snapshotId).toBe(baseline.snapshotId);
      expect(stubB.calls).toBe(0);

      stubA.release();
      const resultA = await runA;
      expect(resultA.published).toBe(true);
    } finally {
      stubA.release();
      repoA.close();
      repoB.close();
    }
  });

  it("a live same-host owner whose TTL expired (blocked for > TTL, injected clock) is NOT stolen from", async () => {
    const arena = createArena(true);
    const repoA = new SqliteGraphRepository(arena.dbPath);
    const repoB = new SqliteGraphRepository(arena.dbPath);
    const stubA = makeCSharpStub();
    const stubB = makeCSharpStub();
    try {
      const serviceA = new IndexService({
        workspaceId: WS,
        policy: arena.policy,
        repository: repoA,
        clock: () => T0,
        limits: { maxFiles: 100 },
        csharp: { analyzeCSharp: stubA.analyze },
        tolerateConcurrentPublishRace: true,
        leaseTtlMs: 30_000,
        // A's own timer never fires during the test: only a blocked owner remains.
        leaseHeartbeatIntervalMs: 3_600_000,
      });
      const baseline = await serviceA.runIndexAsync(arena.workspaceDir);
      writeFileSync(
        path.join(arena.workspaceDir, "src", "orders.ts"),
        "export function createOrderV3(id: string): string { return id; }\n",
        "utf8",
      );
      stubA.hold();
      const runA = serviceA.runIndexAsync(arena.workspaceDir);
      await waitUntil(() => stubA.calls === 2);
      const heldLease = repoA.getActiveBuildLease(WS);
      expect(heldLease).toBeDefined();

      // B observes the world 2 minutes later: A's lease is long past its 30 s TTL.
      const serviceB = new IndexService({
        workspaceId: WS,
        policy: arena.policy,
        repository: repoB,
        clock: () => "2026-11-24T12:02:00.000Z",
        limits: { maxFiles: 100 },
        csharp: { analyzeCSharp: stubB.analyze },
        tolerateConcurrentPublishRace: true,
        peerPollIntervalMs: 20,
        peerWaitTimeoutMs: 300,
      });
      const resultB = await serviceB.runIndexAsync(arena.workspaceDir);
      expect(outcomeOf(resultB)).toBe("peer_busy");
      expect(resultB.snapshotId).toBe(baseline.snapshotId);
      expect(stubB.calls).toBe(0);
      expect(repoB.getActiveBuildLease(WS)?.leaseId).toBe(heldLease?.leaseId);

      stubA.release();
      const resultA = await runA;
      expect(resultA.published).toBe(true);
    } finally {
      stubA.release();
      repoA.close();
      repoB.close();
    }
  });
});

describe("heartbeat does not depend on the analyzing thread", { timeout: 60_000 }, () => {
  it("renews the lease at phase boundaries even when the in-thread timer never fires", async () => {
    const arena = createArena(false);
    const repo = new SqliteGraphRepository(arena.dbPath);
    try {
      let tick = 0;
      const clock = (): string => new Date(Date.parse(T0) + 1_000 * tick++).toISOString();
      const renewals: string[] = [];
      const originalRenew = repo.renewBuildLease.bind(repo);
      repo.renewBuildLease = (workspaceId, leaseId, nowIso, ttlMs) => {
        renewals.push(nowIso);
        return originalRenew(workspaceId, leaseId, nowIso, ttlMs);
      };
      const service = new IndexService({
        workspaceId: WS,
        policy: arena.policy,
        repository: repo,
        clock,
        limits: { maxFiles: 100 },
        leaseHeartbeatIntervalMs: 3_600_000,
      });
      const result = await service.runIndexAsync(arena.workspaceDir);
      expect(result.published).toBe(true);
      expect(renewals.length).toBeGreaterThanOrEqual(2);
      expect([...renewals].sort()).toEqual(renewals);
    } finally {
      repo.close();
    }
  });

  it("the job manager renews a worker-held lease from the main thread while the worker's event loop is blocked", async () => {
    const arena = createArena(false);
    const repo = new SqliteGraphRepository(arena.dbPath);
    try {
      repo.registerWorkspace({ id: WS, rootPath: arena.workspaceDir, createdAt: T0 });
      const service = new IndexService({
        workspaceId: WS,
        policy: arena.policy,
        repository: repo,
        clock: () => new Date().toISOString(),
        limits: { maxFiles: 100 },
        leaseTtlMs: 600,
        leaseHeartbeatIntervalMs: 100,
      });
      const manager = new IndexJobManager({
        indexService: service,
        policy: arena.policy,
        clock: () => new Date().toISOString(),
        workerDbPath: arena.dbPath,
        workerEntryPath: FAKE_WORKER,
      });
      const job = manager.refreshIndex(arena.workspaceDir, {
        mode: "incremental",
        changeSet: ["fake:block=1500"],
      });
      const heartbeats = new Set<string>();
      let acquiredAt: string | undefined;
      let finished = false;
      const done = manager.waitForJob(job.jobId).finally(() => {
        finished = true;
      });
      while (!finished) {
        const lease = repo.getActiveBuildLease(WS);
        if (lease !== undefined) {
          acquiredAt ??= lease.acquiredAt;
          heartbeats.add(lease.heartbeatAt);
          // Never expired while the worker thread is blocked.
          expect(Date.parse(lease.expiresAt)).toBeGreaterThan(Date.now() - 150);
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      const record = await done;
      expect(acquiredAt).toBeDefined();
      const newest = Math.max(...[...heartbeats].map((value) => Date.parse(value)));
      expect(newest - Date.parse(acquiredAt as string)).toBeGreaterThanOrEqual(900);
      expect(heartbeats.size).toBeGreaterThanOrEqual(5);
      expect(record.status).toBe("reused");
      // Released by the main thread when the worker finished.
      expect(repo.getActiveBuildLease(WS)).toBeUndefined();
      manager.close();
    } finally {
      repo.close();
    }
  });

  it("a crashed worker's lease is released by the main thread and its building row is recovered", async () => {
    const arena = createArena(false);
    const repo = new SqliteGraphRepository(arena.dbPath);
    try {
      repo.registerWorkspace({ id: WS, rootPath: arena.workspaceDir, createdAt: T0 });
      const service = new IndexService({
        workspaceId: WS,
        policy: arena.policy,
        repository: repo,
        clock: () => new Date().toISOString(),
        limits: { maxFiles: 100 },
        leaseTtlMs: 30_000,
        leaseHeartbeatIntervalMs: 100,
      });
      const manager = new IndexJobManager({
        indexService: service,
        policy: arena.policy,
        clock: () => new Date().toISOString(),
        workerDbPath: arena.dbPath,
        workerEntryPath: FAKE_WORKER,
      });
      const record = await manager.waitForJob(
        manager.refreshIndex(arena.workspaceDir, {
          mode: "incremental",
          changeSet: ["fake:crash"],
        }).jobId,
      );
      expect(record.status).toBe("failed");
      expect(record.error?.message).toMatch(/exited unexpectedly/);
      expect(repo.getActiveBuildLease(WS)).toBeUndefined();
      const probe = new Database(arena.dbPath, { readonly: true });
      try {
        const rows = probe
          .prepare(
            "SELECT state, failure_reason FROM snapshots WHERE build_id LIKE 'fake-build-%'",
          )
          .all() as Array<{ state: string; failure_reason: string | null }>;
        expect(rows).toEqual([{ state: "failed", failure_reason: "orphan-build-recovered" }]);
      } finally {
        probe.close();
      }
      manager.close();
    } finally {
      repo.close();
    }
  });
});
