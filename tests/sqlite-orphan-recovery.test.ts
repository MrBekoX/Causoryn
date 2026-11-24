import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IndexJobManager, IndexService } from "@causoryn/indexing";
import {
  SCHEMA_VERSION,
  SqliteGraphRepository,
  defaultIsPidAlive,
} from "@causoryn/storage-sqlite";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

/**
 * Wave 1 Track C (Task 1.7 + SQLite CVE defense-in-depth) — TDD verification suite.
 *
 * Covers:
 * 1. Schema v3 + SQLite CVE defense-in-depth (PRAGMA page_size = 4096 on new DBs,
 *    PRAGMA busy_timeout = 5000, default FTS5 detail=full, v2 -> v3 migration).
 * 2. Orphan `building` row recovery:
 *    - Legacy v0.2.4 crash (building row with NO lease) + file edit -> recovers orphan,
 *      publishes a new snapshot, and clears `stale` to `false`.
 *    - Expired lease (`expires_at <= nowIso`) -> recovers orphan and clears lease.
 *    - Dead-PID lease (`isPidAlive: () => false`) -> recovers orphan and clears lease.
 * 3. Live peer lease protection:
 *    - Future `expires_at` + live PID -> NEVER overwrites peer build; returns
 *      `waitingForPeer: true`, `peerStatus: "waiting_for_peer"`, `reused: true`,
 *      `published: false`, and an honest warning.
 * 4. Lease heartbeat & cleanup on publish / failBuild.
 */

const WS = "ws_orphan_recovery";
const T0 = "2026-11-24T10:00:00.000Z";
const T1 = "2026-11-24T10:00:05.000Z";
const T2 = "2026-11-24T10:01:00.000Z";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "causoryn-orphan-recovery-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function createTempWorkspace(): {
  readonly workspaceDir: string;
  readonly dbPath: string;
  readonly sourceFile: string;
} {
  const workspaceDir = path.join(tempRoot, "workspace");
  const dataDir = path.join(tempRoot, "data");
  mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const sourceFile = path.join(workspaceDir, "src", "billing.ts");
  writeFileSync(
    sourceFile,
    "export function computeTotalV1(amount: number): number { return amount + 1; }\n",
    "utf8",
  );
  return {
    workspaceDir,
    dbPath: path.join(dataDir, "graph.sqlite"),
    sourceFile,
  };
}

describe("Task 1.7 — SQLite schema v4, CVE defense-in-depth, build leases & orphan recovery", { timeout: 30_000 }, () => {
  it("new DB sets SCHEMA_VERSION=4, PRAGMA page_size=4096, busy_timeout=5000, build_leases table, and keeps symbol_fts detail=full", () => {
    expect(SCHEMA_VERSION).toBe(4);
    const dbPath = path.join(tempRoot, "fresh.sqlite");
    const repo = new SqliteGraphRepository(dbPath);
    try {
      const probe = new Database(dbPath, { readonly: true });
      try {
        expect(probe.pragma("user_version", { simple: true })).toBe(4);
        expect(probe.pragma("page_size", { simple: true })).toBe(4096);
        expect(probe.pragma("journal_mode", { simple: true })).toBe("wal");

        const tables = (
          probe
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all() as Array<{ name: string }>
        ).map((row) => row.name);
        expect(tables).toContain("build_leases");

        const ftsDef = probe
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='symbol_fts'")
          .get() as { sql: string } | undefined;
        expect(ftsDef?.sql).toBeDefined();
        expect(ftsDef?.sql.toLowerCase()).not.toContain("detail=none");
      } finally {
        probe.close();
      }
    } finally {
      repo.close();
    }
  });

  it("migrates a v2 database with existing published snapshot and orphan building row cleanly to v3", () => {
    const dbPath = path.join(tempRoot, "legacy-v2.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE files (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, relative_path)
      );
      CREATE TABLE snapshots (
        sid INTEGER PRIMARY KEY,
        id TEXT UNIQUE,
        build_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL,
        revision_sequence INTEGER NOT NULL,
        config_hash TEXT NOT NULL,
        analyzer_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('building','ready','partial','failed')),
        created_at TEXT NOT NULL,
        published_at TEXT,
        failure_reason TEXT
      );
      INSERT INTO workspaces (id, root_path, created_at) VALUES ('${WS}', '/tmp/ws', '${T0}');
      INSERT INTO snapshots (build_id, workspace_id, revision_id, revision_sequence, config_hash, analyzer_fingerprint, state, created_at)
      VALUES ('build-legacy-crash', '${WS}', 'working-tree', 2, 'cfg', 'fp', 'building', '${T0}');
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const repo = new SqliteGraphRepository(dbPath);
    try {
      const recovery = repo.recoverOrphanBuilds(WS, { nowIso: T1 });
      expect(recovery.recoveredBuildIds).toEqual(["build-legacy-crash"]);
      expect(recovery.clearedLease).toBe(false);
      const recovered = repo.getBuild("build-legacy-crash");
      expect(recovered?.state).toBe("failed");
      expect(recovered?.failureReason).toBe("orphan-build-recovered");
    } finally {
      repo.close();
    }
  });

  it("crashed v0.2.4 orphan building row (no lease) + file edit -> refresh / runIndexAsync recovers orphan, publishes NEW snapshot, and stale becomes false", async () => {
    const { workspaceDir, dbPath, sourceFile } = createTempWorkspace();
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [workspaceDir] });

    // 1) Initial clean index -> snapshot #1 published (stale: false).
    const repo1 = new SqliteGraphRepository(dbPath);
    let firstSnapshotId = "";
    try {
      const service1 = new IndexService({
        workspaceId: WS,
        policy,
        repository: repo1,
        clock: () => T0,
        limits: { maxFiles: 100 },
        tolerateConcurrentPublishRace: true,
      });
      const initial = await service1.runIndexAsync(workspaceDir);
      expect(initial.published).toBe(true);
      expect(initial.stale).toBe(false);
      firstSnapshotId = initial.snapshotId;

      // 2) Simulate a v0.2.4 process crash mid-build: open a `building` row with NO lease row!
      const orphanBuild = repo1.beginBuild({
        workspaceId: WS,
        revision: { id: "working-tree", sequence: 2 },
        configHash: "legacy-cfg",
        analyzerFingerprint: "legacy-fp",
        createdAt: T0,
      });
      expect(repo1.getActiveBuildLease(WS)).toBeUndefined();
      expect(repo1.getLatestPublished(WS)?.stale).toBe(true);
      expect(orphanBuild.state).toBe("building");
    } finally {
      repo1.close();
    }

    // 3) Edit source file while the orphan `building` row sits in SQLite.
    writeFileSync(
      sourceFile,
      "export function computeTotalV2Recovered(amount: number): number { return amount * 3; }\n",
      "utf8",
    );

    // 4) New process opens the DB and runs refresh via IndexJobManager (runIndexAsync):
    //    must recover the orphan row, publish a NEW snapshot containing computeTotalV2Recovered,
    //    and clear stale to false!
    const repo2 = new SqliteGraphRepository(dbPath);
    try {
      const service2 = new IndexService({
        workspaceId: WS,
        policy,
        repository: repo2,
        clock: () => T1,
        limits: { maxFiles: 100 },
        tolerateConcurrentPublishRace: true,
      });
      const jobManager = new IndexJobManager({
        indexService: service2,
        policy,
        clock: () => T1,
      });

      const job = jobManager.refreshIndex(workspaceDir, { mode: "full" });
      const finished = await jobManager.waitForJob(job.jobId);

      expect(finished.status).toBe("done");
      expect(finished.stale).toBe(false);
      expect(finished.snapshotId).not.toBeNull();
      expect(finished.snapshotId).not.toBe(firstSnapshotId);

      const latest = repo2.getLatestPublished(WS);
      expect(latest).toBeDefined();
      expect(latest?.stale).toBe(false);
      expect(latest?.snapshot.meta.id).toBe(finished.snapshotId);
      const symbolNames = latest?.snapshot.nodes.map((n) => n.qualifiedName) ?? [];
      expect(symbolNames).toContain("computeTotalV2Recovered");
      expect(repo2.getActiveBuildLease(WS)).toBeUndefined();
    } finally {
      repo2.close();
    }
  });

  it("expired lease (expires_at <= nowIso) -> recovered cleanly and publishes new snapshot", async () => {
    const { workspaceDir, dbPath, sourceFile } = createTempWorkspace();
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [workspaceDir] });
    const repo = new SqliteGraphRepository(dbPath);
    try {
      let currentTime = T0;
      const service = new IndexService({
        workspaceId: WS,
        policy,
        repository: repo,
        clock: () => currentTime,
        limits: { maxFiles: 100 },
        tolerateConcurrentPublishRace: true,
      });
      const first = await service.runIndexAsync(workspaceDir);
      expect(first.published).toBe(true);

      // Simulate peer that acquired a 30s lease at T0 and stalled until T2 (+60s).
      const stalledBuild = repo.beginBuild({
        workspaceId: WS,
        revision: { id: "working-tree", sequence: 2 },
        configHash: "stalled-cfg",
        analyzerFingerprint: "stalled-fp",
        createdAt: T0,
      });
      const acquired = repo.acquireBuildLease({
        workspaceId: WS,
        buildId: stalledBuild.buildId,
        leaseId: "lease-stalled",
        ownerPid: process.pid,
        hostLabel: "codex",
        nowIso: T0,
        ttlMs: 30_000,
      });
      expect(acquired.acquired).toBe(true);
      expect(repo.getLatestPublished(WS)?.stale).toBe(true);

      writeFileSync(
        sourceFile,
        "export function afterExpiredLease(): number { return 99; }\n",
        "utf8",
      );

      // Advance clock past TTL (T2 = T0 + 60s > T0 + 30s).
      currentTime = T2;
      const recovered = await service.runIndexAsync(workspaceDir);
      expect(recovered.published).toBe(true);
      expect(recovered.stale).toBe(false);
      expect(recovered.waitingForPeer).toBeUndefined();
      expect(recovered.snapshotId).not.toBe(first.snapshotId);
      expect(repo.getBuild(stalledBuild.buildId)?.state).toBe("failed");
      expect(repo.getBuild(stalledBuild.buildId)?.failureReason).toBe("orphan-build-recovered");
      expect(repo.getActiveBuildLease(WS)).toBeUndefined();
    } finally {
      repo.close();
    }
  });

  it("dead-PID lease (expires_at in future, isPidAlive: () => false) -> recovered cleanly", async () => {
    const { workspaceDir, dbPath, sourceFile } = createTempWorkspace();
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [workspaceDir] });
    const repo = new SqliteGraphRepository(dbPath);
    try {
      const serviceInit = new IndexService({
        workspaceId: WS,
        policy,
        repository: repo,
        clock: () => T0,
        limits: { maxFiles: 100 },
      });
      const first = await serviceInit.runIndexAsync(workspaceDir);
      expect(first.published).toBe(true);

      // Simulate crashed peer whose lease has NOT expired yet, but PID is dead.
      const deadBuild = repo.beginBuild({
        workspaceId: WS,
        revision: { id: "working-tree", sequence: 2 },
        configHash: "dead-cfg",
        analyzerFingerprint: "dead-fp",
        createdAt: T0,
      });
      const acquired = repo.acquireBuildLease({
        workspaceId: WS,
        buildId: deadBuild.buildId,
        leaseId: "lease-dead-pid",
        ownerPid: 424242,
        hostLabel: "claude-code",
        nowIso: T0,
        ttlMs: 60_000,
      });
      expect(acquired.acquired).toBe(true);

      writeFileSync(
        sourceFile,
        "export function afterDeadPid(): number { return 77; }\n",
        "utf8",
      );

      const serviceRecovery = new IndexService({
        workspaceId: WS,
        policy,
        repository: repo,
        clock: () => T1,
        limits: { maxFiles: 100 },
        isPidAlive: (pid) => pid === process.pid,
      });
      const result = await serviceRecovery.runIndexAsync(workspaceDir);
      expect(result.published).toBe(true);
      expect(result.stale).toBe(false);
      expect(result.snapshotId).not.toBe(first.snapshotId);
      expect(repo.getBuild(deadBuild.buildId)?.state).toBe("failed");
      expect(repo.getBuild(deadBuild.buildId)?.failureReason).toBe("orphan-build-recovered");
      expect(repo.getActiveBuildLease(WS)).toBeUndefined();
    } finally {
      repo.close();
    }
  });

  it("LIVE peer lease (expires_at in future + isPidAlive: () => true) -> does NOT overwrite peer build and returns waitingForPeer: true / peerStatus: waiting_for_peer", async () => {
    const { workspaceDir, dbPath, sourceFile } = createTempWorkspace();
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [workspaceDir] });
    const repo = new SqliteGraphRepository(dbPath);
    try {
      const serviceA = new IndexService({
        workspaceId: WS,
        policy,
        repository: repo,
        clock: () => T0,
        limits: { maxFiles: 100 },
        tolerateConcurrentPublishRace: true,
      });
      const first = await serviceA.runIndexAsync(workspaceDir);
      expect(first.published).toBe(true);

      // Live peer opens build #2 and holds a valid non-expired lease.
      const peerBuild = repo.beginBuild({
        workspaceId: WS,
        revision: { id: "working-tree", sequence: 2 },
        configHash: "peer-cfg",
        analyzerFingerprint: "peer-fp",
        createdAt: T1,
      });
      const lease = repo.acquireBuildLease({
        workspaceId: WS,
        buildId: peerBuild.buildId,
        leaseId: "lease-live-peer",
        ownerPid: 98765,
        hostLabel: "claude-code",
        nowIso: T1,
        ttlMs: 30_000,
      });
      expect(lease.acquired).toBe(true);

      writeFileSync(
        sourceFile,
        "export function editedDuringLivePeer(): number { return 123; }\n",
        "utf8",
      );

      // Peer B runs while Peer A's lease is LIVE (isPidAlive returns true, T1 < expiresAt).
      const serviceB = new IndexService({
        workspaceId: WS,
        policy,
        repository: repo,
        clock: () => T1,
        limits: { maxFiles: 100 },
        tolerateConcurrentPublishRace: true,
        isPidAlive: () => true,
      });
      const deferred = await serviceB.runIndexAsync(workspaceDir);

      expect(deferred.published).toBe(false);
      expect(deferred.reused).toBe(true);
      expect(deferred.waitingForPeer).toBe(true);
      expect(deferred.peerStatus).toBe("waiting_for_peer");
      expect(deferred.snapshotId).toBe(first.snapshotId);
      expect(deferred.stale).toBe(true);
      expect(deferred.peerLease?.leaseId).toBe("lease-live-peer");
      expect(deferred.peerLease?.hostLabel).toBe("claude-code");
      expect(deferred.warnings.some((w) => w.includes("waiting_for_peer"))).toBe(true);

      // Peer A's build and lease MUST remain intact!
      expect(repo.getBuild(peerBuild.buildId)?.state).toBe("building");
      expect(repo.getActiveBuildLease(WS)?.leaseId).toBe("lease-live-peer");

      // Clean up peer build -> lease is also cleaned up automatically by failBuild.
      repo.failBuild(peerBuild.buildId, "peer cancelled");
      expect(repo.getActiveBuildLease(WS)).toBeUndefined();
    } finally {
      repo.close();
    }
  });

  it("defaultIsPidAlive identifies current process as alive and non-positive PIDs as dead", () => {
    expect(defaultIsPidAlive(process.pid)).toBe(true);
    expect(defaultIsPidAlive(0)).toBe(false);
    expect(defaultIsPidAlive(-1)).toBe(false);
  });

  it("incremental no-op recovers an orphan building row so stale returns to false", async () => {
    const { workspaceDir, dbPath } = createTempWorkspace();
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [workspaceDir] });
    const repo = new SqliteGraphRepository(dbPath);
    try {
      const service = new IndexService({
        workspaceId: WS,
        policy,
        repository: repo,
        clock: () => T0,
        limits: { maxFiles: 100 },
      });
      const initial = await service.runIndexAsync(workspaceDir);
      expect(initial.published).toBe(true);
      expect(initial.stale).toBe(false);

      // Inject orphan building row (no lease) without editing any file.
      repo.beginBuild({
        workspaceId: WS,
        revision: { id: "working-tree", sequence: 2 },
        configHash: "orphan-cfg",
        analyzerFingerprint: "orphan-fp",
        createdAt: T0,
      });
      expect(repo.getLatestPublished(WS)?.stale).toBe(true);

      const noOp = await service.runIncrementalIndexAsync(workspaceDir);
      expect(noOp.published).toBe(false);
      expect(noOp.stale).toBe(false);
      expect(repo.getLatestPublished(WS)?.stale).toBe(false);
    } finally {
      repo.close();
    }
  });

  it("heartbeat interval renews the build lease while a build is active and releases cleanly on completion", async () => {
    const { workspaceDir, dbPath } = createTempWorkspace();
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [workspaceDir] });
    const repo = new SqliteGraphRepository(dbPath);
    try {
      let tick = 0;
      const advancingClock = (): string => {
        const ms = Date.parse(T0) + tick * 1000;
        tick += 1;
        return new Date(ms).toISOString();
      };

      // Use a repository proxy that delays addNode slightly? Easier: verify directly via
      // SqliteGraphRepository renew + IndexService hostLabel + clean release on sync/async runs.
      const observedLeases: Array<string | null> = [];
      const origPublish = repo.publish.bind(repo);
      repo.publish = (buildId, state, publishedAt) => {
        const active = repo.getActiveBuildLease(WS);
        observedLeases.push(active?.hostLabel ?? null);
        expect(active).toBeDefined();
        expect(active?.buildId).toBe(buildId);
        expect(active?.ownerPid).toBe(process.pid);
        return origPublish(buildId, state, publishedAt);
      };

      const service = new IndexService({
        workspaceId: WS,
        policy,
        repository: repo,
        clock: advancingClock,
        limits: { maxFiles: 100 },
        hostLabel: "antigravity",
        leaseTtlMs: 30_000,
        leaseHeartbeatIntervalMs: 10_000,
      });

      const result = await service.runIndexAsync(workspaceDir);
      expect(result.published).toBe(true);
      expect(result.stale).toBe(false);
      expect(observedLeases).toEqual(["antigravity"]);
      expect(repo.getActiveBuildLease(WS)).toBeUndefined();
    } finally {
      repo.close();
    }
  });
});
