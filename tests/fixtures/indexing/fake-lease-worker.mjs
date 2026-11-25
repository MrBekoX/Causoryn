// Test-only stand-in for the indexing worker (used by tests/indexing-shared-lease.test.ts).
// It exercises the IndexJobManager <-> worker lease contract without running a real
// analysis: it inserts a build lease row the way IndexService does, reports it to the
// main thread, then either BLOCKS its own event loop (heartbeat starvation) or CRASHES.
// The scenario is selected through the changeSet entry "fake:block=<ms>" or "fake:crash".
import { randomUUID } from "node:crypto";
import os from "node:os";
import { parentPort, workerData } from "node:worker_threads";

import Database from "better-sqlite3";

const port = parentPort;
const payload = workerData;
const token = Array.isArray(payload.changeSet) ? String(payload.changeSet[0] ?? "") : "";
const scenario = token.startsWith("fake:block=") ? "fake:block" : token;
const blockMs = scenario === "fake:block" ? Number(token.slice("fake:block=".length)) : 0;
const db = new Database(payload.dbPath);
db.pragma("busy_timeout = 5000");

const leaseId = randomUUID();
const nowIso = new Date().toISOString();
const ttlMs = payload.leaseTtlMs ?? 30_000;
const buildId = `fake-build-${leaseId}`;
db.prepare(
  `INSERT INTO build_leases
     (workspace_id, build_id, lease_id, owner_pid, host_label, hostname, owner_instance,
      acquired_at, heartbeat_at, expires_at)
   VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
).run(
  payload.workspaceId,
  buildId,
  leaseId,
  process.pid,
  os.hostname(),
  payload.processInstanceId ?? null,
  nowIso,
  nowIso,
  new Date(Date.parse(nowIso) + ttlMs).toISOString(),
);
if (scenario === "fake:crash") {
  db.prepare(
    `INSERT INTO snapshots (build_id, workspace_id, revision_id, revision_sequence, config_hash,
                            analyzer_fingerprint, state, created_at)
     VALUES (?, ?, 'working-tree', 99, 'cfg', 'fp', 'building', ?)`,
  ).run(buildId, payload.workspaceId, nowIso);
}
db.close();

port.postMessage({ type: "lease", event: "acquired", leaseId });

if (scenario === "fake:crash") {
  // Simulates a worker that dies mid-build while holding the lease.
  setTimeout(() => {
    process.exit(3);
  }, 50);
} else {
  // Simulates a long synchronous analysis: this thread's own timers cannot run.
  setTimeout(() => {
    const blockUntil = Date.now() + blockMs;
    while (Date.now() < blockUntil) {
      // busy wait
    }
    port.postMessage({
      type: "done",
      result: {
        snapshotId: "snapshot:fake",
        stale: false,
        fileCount: 0,
        tsFileCount: 0,
        csFileCount: 0,
        state: "ready",
        warnings: [],
        diagnostics: [],
        published: false,
        outcome: "unchanged",
        leaseIdForTest: leaseId,
      },
    });
  }, 20);
}
