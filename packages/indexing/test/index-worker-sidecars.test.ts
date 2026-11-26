import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceAccessPolicy } from "@causoryn/workspace";

import {
  InventoryAnalysisWorkerError,
  runInventoryAnalysisInWorker,
  type InventoryAnalysisWorkerInput,
  type InventoryAnalysisWorkerRelease,
} from "../src/index-worker-analysis.js";

/**
 * Sidecar processes of the inventory analysis worker (CAU-01 follow-up): a
 * language adapter inside the worker starts sidecar processes, and their
 * timeout / tree kill runs on the worker's event loop. When a run is aborted
 * (its deadline) the worker is first asked to stop its sidecars itself
 * (cooperative cancel, the adapters' own tree-kill hooks) and is terminated
 * after a short grace period; the worker reports the pids of its sidecars, so
 * whatever is still running when the main thread gives the worker up (it
 * ignored the cancel, crashed or ran out of memory) is killed from the main
 * thread. On Windows that is also what lets such a thread exit at all: a
 * terminating worker cannot finish exiting while a child holds its stdio
 * pipes. A run that was given up settles within a bounded time even when its
 * thread cannot be stopped yet; `onWorkerReleased` tells the caller when the
 * thread is gone.
 *
 * The worker entry is helpers/sidecar-analysis-worker.ts: the real request
 * loop with a stub analysis that starts a fake sidecar (a long-running Node
 * process) through the shared IPC core.
 */

const FIXTURE_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "sidecar-analysis-worker.ts");
const STARTS_ENV = "CAUSORYN_TEST_SIDECAR_WORKER_STARTS";
const IS_WIN = process.platform === "win32";

const cleanups: Array<() => void> = [];
afterEach(() => {
  delete process.env[STARTS_ENV];
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

function input(mode: string, dir: string): InventoryAnalysisWorkerInput {
  return {
    workspaceId: mode,
    rootPath: dir,
    policyConfig: WorkspaceAccessPolicy.create({ allowRoots: [] }).config,
    limits: { maxFiles: 10 },
    entries: [],
    fixedClockIso: "2026-01-01T00:00:00.000Z",
  };
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

interface Run {
  readonly result: Promise<unknown>;
  readonly released: Promise<InventoryAnalysisWorkerRelease>;
}

function start(mode: string, dir: string, options: { readonly signal?: AbortSignal; readonly maxHeapMb?: number } = {}): Run {
  let markReleased!: (release: InventoryAnalysisWorkerRelease) => void;
  const released = new Promise<InventoryAnalysisWorkerRelease>((resolve) => {
    markReleased = resolve;
  });
  const result = runInventoryAnalysisInWorker(input(mode, dir), {
    maxHeapMb: options.maxHeapMb ?? 512,
    workerEntryPath: FIXTURE_WORKER,
    onWorkerReleased: markReleased,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  // Settled by the assertions; never an unhandled rejection meanwhile.
  result.catch(() => undefined);
  return { result, released };
}

describe("runInventoryAnalysisInWorker and the worker's sidecar processes", { timeout: 90_000 }, () => {
  it("an aborted run asks the worker to stop its sidecar itself, then terminates the worker", async () => {
    const dir = makeTempDir("causoryn-sidecar-hang-");
    const controller = new AbortController();
    const run = start("hang", dir, { signal: controller.signal });
    const pid = await sidecarPid(path.join(dir, "sidecar.pid"));
    expect(isRunning(pid)).toBe(true);

    const reason = new Error("stub deadline");
    controller.abort(reason);
    await expect(run.result).rejects.toBe(reason);
    // The worker stopped the sidecar with the adapter's own kill path: nothing was left for the main thread.
    expect(await run.released).toEqual({ orphanedSidecarPids: [] });
    await expectStopped(pid);
  });

  it("a worker that never reads the cancel request is terminated after the grace period and the main thread kills its sidecar", async () => {
    const dir = makeTempDir("causoryn-sidecar-busy-");
    const controller = new AbortController();
    const run = start("busy", dir, { signal: controller.signal });
    const pid = await sidecarPid(path.join(dir, "sidecar.pid"));

    const reason = new Error("stub deadline");
    controller.abort(reason);
    await expect(run.result).rejects.toBe(reason);
    expect(await run.released).toEqual({ orphanedSidecarPids: [pid] });
    await expectStopped(pid);
  });

  it("the sidecar of a worker that crashes is killed from the main thread", async () => {
    const dir = makeTempDir("causoryn-sidecar-crash-");
    const run = start("crash", dir);
    const pid = await sidecarPid(path.join(dir, "sidecar.pid"));
    await expect(run.result).rejects.toSatisfy(
      (error: unknown) => error instanceof InventoryAnalysisWorkerError && error.failure === "crashed",
    );
    expect(await run.released).toEqual({ orphanedSidecarPids: [pid] });
    await expectStopped(pid);
  });

  it("the sidecar of a worker that runs out of its heap limit is killed from the main thread", async () => {
    const dir = makeTempDir("causoryn-sidecar-oom-");
    const run = start("oom", dir, { maxHeapMb: 256 });
    const pid = await sidecarPid(path.join(dir, "sidecar.pid"));
    await expect(run.result).rejects.toSatisfy(
      (error: unknown) => error instanceof InventoryAnalysisWorkerError && error.failure === "out-of-memory",
    );
    expect(await run.released).toEqual({ orphanedSidecarPids: [pid] });
    await expectStopped(pid);
  });

  it.skipIf(!IS_WIN)("on Windows the main thread kills the sidecar's whole process tree (taskkill /T): no go-run-like grandchild survives", async () => {
    const dir = makeTempDir("causoryn-sidecar-tree-");
    const run = start("tree", dir);
    const pid = await sidecarPid(path.join(dir, "sidecar.pid"));
    const grandchild = await sidecarPid(path.join(dir, "sidecar.pid.grandchild"));
    await expect(run.result).rejects.toBeInstanceOf(InventoryAnalysisWorkerError);
    expect(await run.released).toEqual({ orphanedSidecarPids: [pid] });
    await expectStopped(pid);
    await expectStopped(grandchild);
  });

  it("a normal run is unaffected: its sidecar answers and exits, the worker is released before the result and reused", async () => {
    const dir = makeTempDir("causoryn-sidecar-answer-");
    const startsLog = path.join(dir, "starts.log");
    writeFileSync(startsLog, "", "utf8");
    process.env[STARTS_ENV] = startsLog;
    const order: string[] = [];
    const first = start("answer", dir);
    void first.released.then(() => order.push("released"));
    const result = await first.result;
    order.push("result");
    expect(result).toMatchObject({ state: "ready", analyzerFingerprint: "sidecar-stub" });
    expect(await first.released).toEqual({ orphanedSidecarPids: [] });
    expect(order).toEqual(["released", "result"]);
    const pid = await sidecarPid(path.join(dir, "sidecar.pid"));
    await expectStopped(pid);

    rmSync(path.join(dir, "sidecar.pid"));
    const second = start("answer", dir);
    await expect(second.result).resolves.toMatchObject({ state: "ready" });
    expect(await second.released).toEqual({ orphanedSidecarPids: [] });
    const starts = readFileSync(startsLog, "utf8").split("\n").filter((line) => line === "start");
    expect(starts).toHaveLength(1);
  });

  it("a run whose worker is blocked in a synchronous child process call settles within a bounded time; the release follows the thread's exit", async () => {
    const dir = makeTempDir("causoryn-sidecar-blocked-");
    const controller = new AbortController();
    // Its own heap limit: a fresh worker, not an idle one still finishing another test's sidecar.
    const run = start("blocked", dir, { signal: controller.signal, maxHeapMb: 520 });
    await vi.waitFor(
      () => {
        expect(existsSync(path.join(dir, "blocked"))).toBe(true);
      },
      { timeout: 30_000, interval: 20 },
    );
    const abortedAt = performance.now();
    let settledAt = 0;
    let releasedAt = 0;
    const settled = run.result.then(
      () => undefined,
      () => {
        settledAt = performance.now();
      },
    );
    void run.released.then(() => {
      releasedAt = performance.now();
    });
    const reason = new Error("stub deadline");
    controller.abort(reason);
    await expect(run.result).rejects.toBe(reason);
    await settled;
    // The blocking call (8 s) is still running: the run did not wait for it.
    expect(settledAt - abortedAt).toBeLessThan(4_000);
    expect(releasedAt).toBe(0);
    expect(await run.released).toEqual({ orphanedSidecarPids: [] });
    expect(releasedAt - abortedAt).toBeGreaterThan(5_000);
  });
});
