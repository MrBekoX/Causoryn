import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname as osHostname, tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nodeId } from "@causoryn/domain";

import * as storage from "../src/index.js";
import { SqliteGraphRepository, applySchema } from "../src/index.js";

/**
 * Task 1.7 follow-up — lease identity (hostname + owner instance), the
 * PID-primary liveness rule, schema v5 + forward guard, the non-blocking
 * heartbeat connection and the legacy `graph-<client>.sqlite` migration.
 */

const WS = "ws_lease_rule";
const T0 = "2026-11-24T10:00:00.000Z";
/** T0 + 45 s: past a 30 s TTL, well below the 10 min staleness ceiling. */
const T_PAST_TTL = "2026-11-24T10:00:45.000Z";
/** T0 + 11 min: past the default 10 min staleness ceiling. */
const T_PAST_CEILING = "2026-11-24T10:11:00.000Z";
const OTHER_LIVE_PID = 4_000_001;

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "causoryn-lease-rule-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function openRepo(name = "graph.sqlite"): SqliteGraphRepository {
  const repo = new SqliteGraphRepository(path.join(tempDir, name));
  repo.registerWorkspace({ id: WS, rootPath: "/tmp/ws", createdAt: T0 });
  return repo;
}

function holdLease(
  repo: SqliteGraphRepository,
  input: {
    readonly leaseId: string;
    readonly ownerPid: number;
    readonly hostname?: string;
    readonly processInstanceId?: string;
    readonly nowIso?: string;
  },
): void {
  const acquired = repo.acquireBuildLease({
    workspaceId: WS,
    buildId: `pending:${input.leaseId}`,
    leaseId: input.leaseId,
    ownerPid: input.ownerPid,
    nowIso: input.nowIso ?? T0,
    ttlMs: 30_000,
    ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
    ...(input.processInstanceId === undefined
      ? {}
      : { processInstanceId: input.processInstanceId }),
  });
  expect(acquired.acquired).toBe(true);
}

function tryAcquire(
  repo: SqliteGraphRepository,
  nowIso: string,
  extra: Record<string, unknown> = {},
) {
  return repo.acquireBuildLease({
    workspaceId: WS,
    buildId: "pending:challenger",
    leaseId: "lease-challenger",
    ownerPid: process.pid,
    nowIso,
    ttlMs: 30_000,
    ...extra,
  });
}

describe("build lease identity and schema v5", () => {
  it("records os.hostname() and a per-process owner instance on every lease", () => {
    const repo = openRepo();
    try {
      holdLease(repo, { leaseId: "lease-a", ownerPid: process.pid });
      const lease = repo.getActiveBuildLease(WS) as unknown as Record<string, unknown>;
      expect(lease["hostname"]).toBe(osHostname());
      expect(typeof lease["ownerInstance"]).toBe("string");
      expect(String(lease["ownerInstance"]).length).toBeGreaterThan(0);
    } finally {
      repo.close();
    }
  });

  it("new databases are stamped user_version 5 with hostname/owner_instance lease columns", () => {
    const file = path.join(tempDir, "fresh.sqlite");
    new SqliteGraphRepository(file).close();
    const probe = new Database(file, { readonly: true });
    try {
      expect(probe.pragma("user_version", { simple: true })).toBe(5);
      const columns = (
        probe.prepare("SELECT name FROM pragma_table_info('build_leases')").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(columns).toContain("hostname");
      expect(columns).toContain("owner_instance");
    } finally {
      probe.close();
    }
  });

  it("migrates a v4 database (no lease identity columns) to v5 and keeps old lease rows readable", () => {
    const file = path.join(tempDir, "legacy-v4.sqlite");
    new SqliteGraphRepository(file).close();
    const raw = new Database(file);
    raw.exec(`
      ALTER TABLE build_leases DROP COLUMN hostname;
      ALTER TABLE build_leases DROP COLUMN owner_instance;
      INSERT INTO workspaces (id, root_path, created_at) VALUES ('${WS}', '/tmp/ws', '${T0}');
      INSERT INTO build_leases (workspace_id, build_id, lease_id, owner_pid, host_label, acquired_at, heartbeat_at, expires_at)
      VALUES ('${WS}', 'pending:old', 'lease-v4', 4242, 'codex', '${T0}', '${T0}', '2026-11-24T10:00:30.000Z');
      PRAGMA user_version = 4;
    `);
    raw.close();

    const repo = new SqliteGraphRepository(file);
    try {
      const lease = repo.getActiveBuildLease(WS) as unknown as Record<string, unknown>;
      expect(lease["leaseId"]).toBe("lease-v4");
      expect(lease["hostname"]).toBeNull();
      expect(lease["ownerInstance"]).toBeNull();
      // Unknown host (NULL) -> TTL only: still valid at T0, expired at T_PAST_TTL.
      expect(tryAcquire(repo, T0).acquired).toBe(false);
      expect(tryAcquire(repo, T_PAST_TTL).acquired).toBe(true);
    } finally {
      repo.close();
    }
    const probe = new Database(file, { readonly: true });
    try {
      expect(probe.pragma("user_version", { simple: true })).toBe(5);
    } finally {
      probe.close();
    }
  });

  it("applySchema refuses a database stamped with a newer user_version (typed error, file untouched)", () => {
    const file = path.join(tempDir, "future.sqlite");
    const db = new Database(file);
    try {
      db.pragma("user_version = 99");
      let thrown: unknown;
      try {
        applySchema(db);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as { code?: unknown }).code).toBe("storage/schema-too-new");
      expect((thrown as Error).message).toMatch(/schema v99 is newer than this Causoryn build supports \(v5\)/);
      expect(db.pragma("user_version", { simple: true })).toBe(99);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all();
      expect(tables).toEqual([]);
    } finally {
      db.close();
    }
    expect(() => new SqliteGraphRepository(file)).toThrow(/newer than this Causoryn build supports/);
  });

  it("readSqliteUserVersion probes read-only and returns undefined for a missing file", () => {
    const read = (storage as unknown as {
      readSqliteUserVersion?: (p: string) => number | undefined;
    }).readSqliteUserVersion;
    expect(typeof read).toBe("function");
    const missing = path.join(tempDir, "missing.sqlite");
    expect(read?.(missing)).toBeUndefined();
    expect(readdirSync(tempDir)).not.toContain("missing.sqlite");
    const file = path.join(tempDir, "v99.sqlite");
    const db = new Database(file);
    db.pragma("user_version = 99");
    db.close();
    expect(read?.(file)).toBe(99);
  });
});

describe("liveness rule: PID primary on the same host, TTL only across hosts", () => {
  it("same host + live PID + EXPIRED TTL -> holder is alive (a blocked owner is not stolen from)", () => {
    const repo = openRepo();
    try {
      holdLease(repo, { leaseId: "lease-blocked", ownerPid: OTHER_LIVE_PID });
      const attempt = tryAcquire(repo, T_PAST_TTL, {
        isPidAlive: (pid: number) => pid === OTHER_LIVE_PID,
      });
      expect(attempt.acquired).toBe(false);
      expect(repo.getActiveBuildLease(WS)?.leaseId).toBe("lease-blocked");
    } finally {
      repo.close();
    }
  });

  it("same host + dead PID + FRESH TTL -> recoverable immediately", () => {
    const repo = openRepo();
    try {
      holdLease(repo, { leaseId: "lease-dead", ownerPid: OTHER_LIVE_PID });
      const attempt = tryAcquire(repo, T0, { isPidAlive: () => false });
      expect(attempt.acquired).toBe(true);
      expect(repo.getActiveBuildLease(WS)?.leaseId).toBe("lease-challenger");
    } finally {
      repo.close();
    }
  });

  it("foreign host + expired TTL -> recovered even though the PID looks alive locally", () => {
    const repo = openRepo();
    try {
      holdLease(repo, {
        leaseId: "lease-foreign",
        ownerPid: OTHER_LIVE_PID,
        hostname: "some-other-machine",
      });
      const attempt = tryAcquire(repo, T_PAST_TTL, { isPidAlive: () => true });
      expect(attempt.acquired).toBe(true);
    } finally {
      repo.close();
    }
  });

  it("foreign host + fresh TTL -> alive even though the PID is not alive locally", () => {
    const repo = openRepo();
    try {
      holdLease(repo, {
        leaseId: "lease-foreign-fresh",
        ownerPid: OTHER_LIVE_PID,
        hostname: "some-other-machine",
      });
      const attempt = tryAcquire(repo, T0, { isPidAlive: () => false });
      expect(attempt.acquired).toBe(false);
    } finally {
      repo.close();
    }
  });

  it("heartbeat older than the hard staleness ceiling -> dead even with a live PID (PID reuse guard)", () => {
    const repo = openRepo();
    try {
      holdLease(repo, { leaseId: "lease-ancient", ownerPid: OTHER_LIVE_PID });
      expect(
        tryAcquire(repo, T_PAST_CEILING, { isPidAlive: () => true }).acquired,
      ).toBe(true);
    } finally {
      repo.close();
    }
  });

  it("the staleness ceiling is configurable", () => {
    const repo = openRepo();
    try {
      holdLease(repo, { leaseId: "lease-ceiling", ownerPid: OTHER_LIVE_PID });
      expect(
        tryAcquire(repo, T_PAST_TTL, { isPidAlive: () => true, staleCeilingMs: 40_000 })
          .acquired,
      ).toBe(true);
    } finally {
      repo.close();
    }
  });

  it("same PID but a different owner instance -> PID reuse, recoverable immediately", () => {
    const repo = openRepo();
    try {
      holdLease(repo, {
        leaseId: "lease-previous-process",
        ownerPid: process.pid,
        processInstanceId: "instance-of-a-dead-process",
      });
      expect(tryAcquire(repo, T0).acquired).toBe(true);
    } finally {
      repo.close();
    }
  });

  it("same process + registered active build + expired TTL -> alive; unregistered same-process lease -> TTL", () => {
    const repo = openRepo();
    try {
      holdLease(repo, {
        leaseId: "lease-local",
        ownerPid: process.pid,
        processInstanceId: "instance-local",
      });
      const registered = tryAcquire(repo, T_PAST_TTL, {
        processInstanceId: "instance-local",
        isLocalLeaseActive: (leaseId: string) => leaseId === "lease-local" || undefined,
      });
      expect(registered.acquired).toBe(false);

      const unregisteredFresh = tryAcquire(repo, T0, {
        processInstanceId: "instance-local",
        isLocalLeaseActive: () => undefined,
      });
      expect(unregisteredFresh.acquired).toBe(false);

      const unregisteredExpired = tryAcquire(repo, T_PAST_TTL, {
        processInstanceId: "instance-local",
        isLocalLeaseActive: () => undefined,
      });
      expect(unregisteredExpired.acquired).toBe(true);
    } finally {
      repo.close();
    }
  });

  it("recoverOrphanBuilds applies the same rule: a live same-host owner keeps its building row past the TTL", () => {
    const repo = openRepo();
    try {
      const build = repo.beginBuild({
        workspaceId: WS,
        revision: { id: "working-tree", sequence: 1 },
        configHash: "cfg",
        analyzerFingerprint: "fp",
        createdAt: T0,
      });
      const acquired = repo.acquireBuildLease({
        workspaceId: WS,
        buildId: build.buildId,
        leaseId: "lease-live-build",
        ownerPid: OTHER_LIVE_PID,
        nowIso: T0,
        ttlMs: 30_000,
      });
      expect(acquired.acquired).toBe(true);

      const kept = repo.recoverOrphanBuilds(WS, {
        nowIso: T_PAST_TTL,
        isPidAlive: (pid) => pid === OTHER_LIVE_PID,
      });
      expect(kept.recoveredBuildIds).toEqual([]);
      expect(kept.clearedLease).toBe(false);
      expect(repo.getBuild(build.buildId)?.state).toBe("building");

      const recovered = repo.recoverOrphanBuilds(WS, {
        nowIso: T_PAST_TTL,
        isPidAlive: () => false,
      });
      expect(recovered.recoveredBuildIds).toEqual([build.buildId]);
      expect(recovered.clearedLease).toBe(true);
    } finally {
      repo.close();
    }
  });
});

describe("non-blocking heartbeat connection", () => {
  it("renews on its own connection, reports a lost lease, and returns 'busy' instead of blocking", () => {
    const repo = openRepo();
    try {
      holdLease(repo, { leaseId: "lease-hb", ownerPid: process.pid });
      const heartbeat = (
        repo as unknown as {
          openBuildLeaseHeartbeat: (o?: { busyTimeoutMs?: number }) => {
            renew: (ws: string, id: string, now: string, ttl: number) => string;
            release: (ws: string, id: string) => void;
            close: () => void;
          };
        }
      ).openBuildLeaseHeartbeat({ busyTimeoutMs: 20 });
      try {
        expect(heartbeat.renew(WS, "lease-hb", T_PAST_TTL, 30_000)).toBe("renewed");
        expect(repo.getActiveBuildLease(WS)?.heartbeatAt).toBe(T_PAST_TTL);
        expect(heartbeat.renew(WS, "lease-unknown", T_PAST_TTL, 30_000)).toBe("lost");

        const blocker = new Database(path.join(tempDir, "graph.sqlite"));
        try {
          blocker.prepare("BEGIN IMMEDIATE").run();
          const started = performance.now();
          expect(heartbeat.renew(WS, "lease-hb", T_PAST_TTL, 30_000)).toBe("busy");
          expect(performance.now() - started).toBeLessThan(1_000);
          blocker.prepare("ROLLBACK").run();
        } finally {
          blocker.close();
        }

        heartbeat.release(WS, "lease-hb");
        expect(repo.getActiveBuildLease(WS)).toBeUndefined();
      } finally {
        heartbeat.close();
      }
    } finally {
      repo.close();
    }
  });
});

describe("write transactions take the write lock up front (BEGIN IMMEDIATE)", () => {
  it("publish cannot be broken by a heartbeat commit landing during its read phase", () => {
    const repo = openRepo();
    try {
      const build = repo.beginBuild({
        workspaceId: WS,
        revision: { id: "working-tree", sequence: 1 },
        configHash: "cfg",
        analyzerFingerprint: "fp",
        createdAt: T0,
      });
      repo.addNode(build.buildId, {
        id: nodeId({ workspaceId: WS, kind: "Workspace", qualifiedName: WS }),
        kind: "Workspace",
        qualifiedName: WS,
        attributes: {},
      });
      const acquired = repo.acquireBuildLease({
        workspaceId: WS,
        buildId: build.buildId,
        leaseId: "lease-publisher",
        ownerPid: process.pid,
        nowIso: T0,
        ttlMs: 30_000,
      });
      expect(acquired.acquired).toBe(true);
      const heartbeat = (
        repo as unknown as {
          openBuildLeaseHeartbeat: (o?: { busyTimeoutMs?: number }) => {
            renew: (ws: string, id: string, now: string, ttl: number) => string;
            close: () => void;
          };
        }
      ).openBuildLeaseHeartbeat({ busyTimeoutMs: 20 });
      const internals = repo as unknown as {
        readBuildContent: (sid: number) => unknown;
      };
      const originalRead = internals.readBuildContent.bind(repo);
      const renewDuringPublish: string[] = [];
      internals.readBuildContent = (sid: number) => {
        // The main-thread heartbeat fires while publish is reading the build.
        renewDuringPublish.push(heartbeat.renew(WS, "lease-publisher", T_PAST_TTL, 30_000));
        return originalRead(sid);
      };
      try {
        const graph = repo.publish(build.buildId, "ready", T_PAST_TTL);
        expect(graph.meta.id).toMatch(/^snapshot:/);
      } finally {
        internals.readBuildContent = originalRead;
        heartbeat.close();
      }
      // The heartbeat waited/backed off instead of invalidating publish's snapshot.
      expect(renewDuringPublish).toEqual(["busy"]);
    } finally {
      repo.close();
    }
  });
});

describe("legacy graph-<client>.sqlite migration", () => {
  function makeLegacyDb(name: string, workspaceRoot: string, mtimeSec: number): string {
    // `workspaceRoot` is stored as a marker file record to identify the copy.
    const file = path.join(tempDir, name);
    const repo = new SqliteGraphRepository(file);
    try {
      repo.registerWorkspace({ id: WS, rootPath: "/legacy/ws", createdAt: T0 });
      repo.upsertFile({
        workspaceId: WS,
        relativePath: workspaceRoot,
        contentHash: "hash",
        sizeBytes: 1,
        updatedAt: T0,
      });
    } finally {
      repo.close();
    }
    // Stamp as a v4 database (pre lease-identity columns) like v0.2.4 left it.
    const raw = new Database(file);
    raw.exec(`
      ALTER TABLE build_leases DROP COLUMN hostname;
      ALTER TABLE build_leases DROP COLUMN owner_instance;
      PRAGMA user_version = 4;
    `);
    raw.close();
    utimesSync(file, mtimeSec, mtimeSec);
    return file;
  }

  it("copies the newest VALID legacy DB once via online backup, keeps the legacy files, then migrates to v5", async () => {
    const migrate = (storage as unknown as {
      migrateLegacyWorkspaceDatabase?: (target: string) => Promise<Record<string, unknown>>;
    }).migrateLegacyWorkspaceDatabase;
    expect(typeof migrate).toBe("function");

    makeLegacyDb("graph-claude-code.sqlite", "/legacy/older", 1_700_000_000);
    makeLegacyDb("graph-codex.sqlite", "/legacy/newest-valid", 1_700_000_500);
    const broken = path.join(tempDir, "graph-antigravity.sqlite");
    writeFileSync(broken, "this is not a sqlite database at all".repeat(64));
    utimesSync(broken, 1_700_001_000, 1_700_001_000);
    const future = path.join(tempDir, "graph-gemini.sqlite");
    const futureDb = new Database(future);
    futureDb.pragma("user_version = 99");
    futureDb.close();
    utimesSync(future, 1_700_002_000, 1_700_002_000);

    const target = path.join(tempDir, "graph.sqlite");
    const result = await migrate!(target);
    expect(result["migrated"]).toBe(true);
    expect(result["source"]).toBe(path.join(tempDir, "graph-codex.sqlite"));

    const names = readdirSync(tempDir);
    expect(names).toContain("graph.sqlite");
    expect(names).toContain("graph-claude-code.sqlite");
    expect(names).toContain("graph-codex.sqlite");
    expect(names).toContain("graph-antigravity.sqlite");
    expect(names.some((n) => n.includes(".migrating-"))).toBe(false);

    const repo = new SqliteGraphRepository(target);
    try {
      expect(repo.listFiles(WS).map((file) => file.relativePath)).toEqual([
        "/legacy/newest-valid",
      ]);
    } finally {
      repo.close();
    }
    const probe = new Database(target, { readonly: true });
    try {
      expect(probe.pragma("user_version", { simple: true })).toBe(5);
    } finally {
      probe.close();
    }

    const again = await migrate!(target);
    expect(again["migrated"]).toBe(false);
    expect(again["reason"]).toBe("target-exists");
  });

  it("does nothing when no legacy file exists", async () => {
    const result = await storage.migrateLegacyWorkspaceDatabase(path.join(tempDir, "graph.sqlite"));
    expect(result.migrated).toBe(false);
    expect(readdirSync(tempDir)).toEqual([]);
  });
});
