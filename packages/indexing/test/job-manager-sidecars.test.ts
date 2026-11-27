import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryGraphRepository } from "@causoryn/graph";
import { SqliteGraphRepository } from "@causoryn/storage-sqlite";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { IndexJobManager, IndexService } from "../src/index.js";
import { runIndexWorkerTask } from "../src/index-worker-core.js";

/**
 * Sidecar processes of an index job worker (security finding F33, CWE-404):
 * a full or incremental index job runs IndexService in a worker thread, and
 * the language adapters start their sidecar processes (Roslyn, Python, Go,
 * Rust, cargo) from that thread; their request timeouts and tree kills run on
 * the thread's event loop. Terminating the worker alone (close() on a roots
 * rebind or session end, or after the worker failed) used to leave those
 * processes running with no timeout, and on Windows the terminated thread
 * cannot finish exiting while such a child holds its stdio pipes.
 *
 * The job worker now reports the pid of every sidecar it starts and exits
 * (the shared registry of @causoryn/sidecar-ipc, like the history analysis
 * worker). close() first asks it to stop them itself (`cancel`: the job's
 * data store is closed, so a cancelled job publishes nothing, and the
 * adapters' own tree kills run) and terminates it after a short grace period;
 * whatever it still reports as running when the job manager gives it up is
 * killed from the main thread (System32 taskkill /T /F on Windows, SIGKILL
 * elsewhere). `onWorkerReleased` reports the thread's exit and those pids.
 *
 * The worker entry is helpers/sidecar-index-job-worker.ts: the real job
 * protocol (serveIndexJob) with a stub job that starts a fake sidecar (a
 * long-running Node process) through the shared IPC core.
 */

const FIXTURE_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "sidecar-index-job-worker.ts");
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TS_FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");
const FIXED_NOW = "2026-11-26T00:00:00.000Z";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

/** Whether `pid` is a running process (a zombie left for its dead parent thread is not running). */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
      return state !== "Z" && state !== "X";
    } catch {
      return false;
    }
  }
  if (process.platform === "darwin") {
    try {
      return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z");
    } catch {
      return false;
    }
  }
  return true;
}

/** Waits for a fake sidecar's pid file; the process is killed at cleanup whatever the test did. */
async function sidecarPid(file: string): Promise<number> {
  await vi.waitFor(
    () => {
      expect(existsSync(file) && readFileSync(file, "utf8").length > 0, `${file} was not written`).toBe(true);
    },
    { timeout: 30_000, interval: 20 },
  );
  const pid = Number(readFileSync(file, "utf8"));
  cleanups.push(() => {
    try {
      process.kill(pid);
    } catch {
      // Already gone (the expected case).
    }
  });
  return pid;
}

async function expectStopped(pid: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(isRunning(pid), `the fake sidecar ${String(pid)} is still running`).toBe(false);
    },
    { timeout: 10_000, interval: 50 },
  );
}

interface WorkerRelease {
  readonly jobId: string;
  readonly orphanedSidecarPids: readonly number[];
}

interface Harness {
  readonly manager: IndexJobManager;
  readonly released: Promise<WorkerRelease>;
  readonly jobId: string;
}

/** A job manager whose single job runs the stub worker in `mode`. */
function startJob(mode: string, dir: string): Harness {
  const policy = WorkspaceAccessPolicy.create({ allowRoots: [dir] });
  const indexService = new IndexService({
    workspaceId: "ws_sidecars",
    policy,
    repository: new InMemoryGraphRepository(),
    clock: () => FIXED_NOW,
    limits: { maxFiles: 10 },
  });
  let markReleased!: (release: WorkerRelease) => void;
  const released = new Promise<WorkerRelease>((resolve) => {
    markReleased = resolve;
  });
  const manager = new IndexJobManager({
    indexService,
    policy,
    clock: () => FIXED_NOW,
    // The stub worker never opens it; a path makes the job run in a worker thread.
    workerDbPath: path.join(dir, "unused.sqlite"),
    workerEntryPath: FIXTURE_WORKER,
    onWorkerReleased: markReleased,
  });
  cleanups.push(() => {
    manager.close();
  });
  const job = manager.refreshIndex(dir, { mode: "incremental", changeSet: [mode] });
  return { manager, released, jobId: job.jobId };
}

describe("IndexJobManager and the sidecar processes of its index job worker", { timeout: 90_000 }, () => {
  it("close() asks the running worker to stop its sidecar itself, settles the job at once and then terminates the worker", async () => {
    const dir = makeTempDir("causoryn-job-sidecar-hang-");
    const job = startJob("hang", dir);
    const pid = await sidecarPid(path.join(dir, "sidecar.pid"));
    expect(isRunning(pid)).toBe(true);
    expect(job.manager.status(job.jobId)?.executionMode).toBe("worker");

    const waiting = job.manager.waitForJob(job.jobId);
    job.manager.close();
    const record = await waiting;
    expect(record.status).toBe("failed");
    expect(record.error?.message).toMatch(/cancelled: job manager closed/);

    await expectStopped(pid);
    // The job was cancelled inside the worker (its data store is closed there)...
    expect(existsSync(path.join(dir, "aborted"))).toBe(true);
    // ...and the worker stopped the sidecar with the adapter's own kill path: nothing was left for the main thread.
    expect(await job.released).toEqual({ jobId: job.jobId, orphanedSidecarPids: [] });
  });

  it("a worker that never reads the cancel request is terminated after the grace period and the main thread kills its sidecar", async () => {
    const dir = makeTempDir("causoryn-job-sidecar-busy-");
    const job = startJob("busy", dir);
    const pid = await sidecarPid(path.join(dir, "sidecar.pid"));

    const waiting = job.manager.waitForJob(job.jobId);
    job.manager.close();
    expect((await waiting).status).toBe("failed");
    await expectStopped(pid);
    expect(await job.released).toEqual({ jobId: job.jobId, orphanedSidecarPids: [pid] });
  });

  it("the sidecar of a job worker that crashes is killed from the main thread and the job fails", async () => {
    const dir = makeTempDir("causoryn-job-sidecar-crash-");
    const job = startJob("crash", dir);
    const pid = await sidecarPid(path.join(dir, "sidecar.pid"));
    const record = await job.manager.waitForJob(job.jobId);
    expect(record.status).toBe("failed");
    expect(record.error?.message).toMatch(/injected index job worker crash/);
    await expectStopped(pid);
    expect(await job.released).toEqual({ jobId: job.jobId, orphanedSidecarPids: [pid] });
  });

  it("a sidecar a finished job left running is killed when its worker is terminated", async () => {
    const dir = makeTempDir("causoryn-job-sidecar-leak-");
    const job = startJob("leak", dir);
    const pid = await sidecarPid(path.join(dir, "sidecar.pid"));
    const record = await job.manager.waitForJob(job.jobId);
    expect(record.status).toBe("reused");
    await expectStopped(pid);
    expect(await job.released).toEqual({ jobId: job.jobId, orphanedSidecarPids: [pid] });
  });

  it("a normal job is unaffected: its sidecar answers and exits, the job finishes and nothing is killed", async () => {
    const dir = makeTempDir("causoryn-job-sidecar-answer-");
    const job = startJob("answer", dir);
    const record = await job.manager.waitForJob(job.jobId);
    expect(record.status).toBe("reused");
    expect(record.snapshotId).toBe("snapshot:sidecar-stub");
    const pid = await sidecarPid(path.join(dir, "sidecar.pid"));
    await expectStopped(pid);
    expect(await job.released).toEqual({ jobId: job.jobId, orphanedSidecarPids: [] });
    expect(existsSync(path.join(dir, "aborted"))).toBe(false);
  });
});

describe("runIndexWorkerTask cancellation (the worker side of a cancelled index job)", { timeout: 90_000 }, () => {
  function payload(dbPath: string) {
    return {
      dbPath,
      rootPath: TS_FIXTURE_ROOT,
      mode: "full" as const,
      changeSet: [],
      workspaceId: "ws_cancel",
      policyConfig: WorkspaceAccessPolicy.create({ allowRoots: [TS_FIXTURE_ROOT] }).config,
      limits: { maxFiles: 1_000 },
      fixedClockIso: FIXED_NOW,
    };
  }

  function latestPublished(dbPath: string): unknown {
    const repository = new SqliteGraphRepository(dbPath);
    try {
      return repository.getLatestPublished("ws_cancel");
    } finally {
      repository.close();
    }
  }

  it("a job whose signal is aborted mid-run publishes nothing", async () => {
    const dir = makeTempDir("causoryn-job-cancel-");
    const dbPath = path.join(dir, "index.sqlite");
    const controller = new AbortController();
    const run = runIndexWorkerTask(
      payload(dbPath),
      (event) => {
        if (event.phase === "analyzing") controller.abort();
      },
      SqliteGraphRepository,
      undefined,
      controller.signal,
    );
    await expect(run).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
    expect(latestPublished(dbPath)).toBeUndefined();
  });

  it("the same job without an abort publishes its snapshot (control)", async () => {
    const dir = makeTempDir("causoryn-job-uncancelled-");
    const dbPath = path.join(dir, "index.sqlite");
    const controller = new AbortController();
    const summary = await runIndexWorkerTask(payload(dbPath), undefined, SqliteGraphRepository, undefined, controller.signal);
    expect(summary.published).toBe(true);
    expect(latestPublished(dbPath)).toBeDefined();
  });

  it("a job whose signal is already aborted does not start", async () => {
    const dir = makeTempDir("causoryn-job-precancelled-");
    const dbPath = path.join(dir, "index.sqlite");
    const controller = new AbortController();
    controller.abort();
    await expect(
      runIndexWorkerTask(payload(dbPath), undefined, SqliteGraphRepository, undefined, controller.signal),
    ).rejects.toThrow(/cancelled/);
    expect(latestPublished(dbPath)).toBeUndefined();
  });
});
