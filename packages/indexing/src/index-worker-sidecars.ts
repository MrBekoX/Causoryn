import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { Worker } from "node:worker_threads";

import {
  buildAllowlistedWorkerEnv,
  DEFAULT_KILL_FALLBACK_MS,
  resolveWindowsSystemExecutable,
  withoutCwdExecutableSearch,
} from "@causoryn/sidecar-ipc";

/**
 * Main-thread side of the sidecar processes of an index worker thread, shared
 * by the inventory analysis worker (index-worker-analysis.ts) and the index
 * job worker (IndexJobManager, job-manager.ts).
 *
 * The worker reports the pid of every sidecar process it starts and of every
 * one that exits (`sidecar` messages; index-worker-serve.ts). Whatever it
 * still reports as running when this thread gives it up (it ignored a cancel,
 * crashed, ran out of memory, sent garbage, finished, or is retired) is killed
 * from this thread right away, together with the termination: on Windows the
 * whole process tree with `%SystemRoot%\System32\taskkill.exe /pid <pid> /T /F`
 * (absolute path, no shell, numeric pid only), elsewhere the process with
 * SIGKILL. It cannot wait for the thread's exit: on Windows a terminating
 * worker cannot finish exiting while a child it started still holds the stdio
 * pipes it reads, and the worker's own timeouts and tree kills no longer run.
 * A thread that ran out of memory says so only at its exit, so while a worker
 * reports running sidecars its thread is checked every
 * SIDECAR_WATCH_INTERVAL_MS (`getHeapStatistics()` fails with
 * ERR_WORKER_NOT_RUNNING once it stopped) and the sidecars of a stopped thread
 * are killed. Known limit: a pid the worker had not reported as exited yet
 * could in theory have been reused by the time it is killed.
 */

/**
 * How long a cancelled worker gets to stop its sidecar processes itself (the
 * `cancel` request) before it is terminated. Longer than the worker's own wait
 * for its sidecars (CANCEL_SIDECAR_EXIT_WAIT_MS).
 */
export const SIDECAR_CANCEL_GRACE_MS = 1_000;
/** Upper bound for killing one leftover sidecar process tree (a hung taskkill). */
const ORPHAN_KILL_TIMEOUT_MS = DEFAULT_KILL_FALLBACK_MS;
/** How often a worker that reports running sidecar processes is checked for a stopped thread. */
const SIDECAR_WATCH_INTERVAL_MS = 1_000;

/** Exit of a worker thread, after its leftover sidecar processes were killed. */
export interface WorkerReaped {
  readonly exitCode: number;
  /** Sidecar processes killed from this thread because the worker left them running. */
  readonly orphanedSidecarPids: readonly number[];
}

/** A started worker thread, followed for the sidecar processes it reports. */
export interface SidecarTrackedWorker {
  readonly worker: Worker;
  /**
   * Gives the worker up: terminates the thread and kills, from this thread,
   * the sidecar processes it still reports as running. Both are needed: on
   * Windows a terminating worker cannot finish exiting while a child process
   * it started still holds the stdio pipes it reads (its 'exit' waits for the
   * child), and the worker's own timeouts and tree kills no longer run.
   */
  readonly stop: () => void;
  /**
   * Calls `listener` once the thread has exited and its leftover sidecar
   * processes were killed (soon, when that already happened); returns the
   * unsubscribe function.
   */
  readonly onReaped: (listener: (reaped: WorkerReaped) => void) => () => void;
}

/** A `sidecar` message of the worker (its pid validated), or undefined for any other message. */
export function sidecarEventOf(
  raw: unknown,
): { readonly event: "spawned" | "exited"; readonly pid: number } | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const message = raw as { readonly type?: unknown; readonly event?: unknown; readonly pid?: unknown };
  if (message.type !== "sidecar") return undefined;
  if (message.event !== "spawned" && message.event !== "exited") return undefined;
  const pid = message.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return undefined;
  return { event: message.event, pid };
}

/**
 * Kills a sidecar process a worker left behind: on Windows its whole tree with
 * the absolute System32 taskkill (`/pid <pid> /T /F`, no shell; resolves once
 * taskkill has finished or after ORPHAN_KILL_TIMEOUT_MS), elsewhere the
 * process with SIGKILL. Never rejects.
 */
export function killOrphanedSidecar(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const taskkill = resolveWindowsSystemExecutable("taskkill.exe");
    let killer: ChildProcess;
    try {
      killer = spawn(taskkill, ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        cwd: path.dirname(taskkill),
        env: withoutCwdExecutableSearch(buildAllowlistedWorkerEnv(["SystemRoot", "windir"])),
        shell: false,
        windowsHide: true,
      });
    } catch {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // taskkill is already gone.
      }
      done();
    }, ORPHAN_KILL_TIMEOUT_MS);
    timer.unref();
    killer.once("error", done);
    killer.once("exit", done);
  });
}

/**
 * Follows the `sidecar` messages of `worker` for its whole life: stop() kills
 * the sidecar processes it still reports as running (and any it reports
 * afterwards) and terminates the thread; whatever is still reported when the
 * thread exits is killed too.
 */
export function trackSidecarWorker(worker: Worker): SidecarTrackedWorker {
  const runningSidecars = new Set<number>();
  const killedSidecars: number[] = [];
  const kills: Array<Promise<void>> = [];
  const listeners = new Set<(reaped: WorkerReaped) => void>();
  let stopped = false;
  let exited = false;
  let reaped: WorkerReaped | undefined;
  let watch: NodeJS.Timeout | undefined;
  let probing = false;
  const killRunningSidecars = (): void => {
    for (const pid of [...runningSidecars].sort((a, b) => a - b)) {
      runningSidecars.delete(pid);
      killedSidecars.push(pid);
      kills.push(killOrphanedSidecar(pid));
    }
  };
  const stopWatching = (): void => {
    clearInterval(watch);
    watch = undefined;
  };
  // While the worker reports running sidecars, check that its thread still
  // runs: a thread that ran out of memory reports nothing until its exit,
  // and on Windows that exit waits for those very sidecars. A thread that no
  // longer runs JavaScript rejects getHeapStatistics with
  // ERR_WORKER_NOT_RUNNING (a busy one answers, a blocked one does not
  // answer yet: neither is taken for dead).
  const probeThread = (): void => {
    if (probing) return;
    if (runningSidecars.size === 0 || exited) {
      stopWatching();
      return;
    }
    probing = true;
    worker.getHeapStatistics().then(
      () => {
        probing = false;
      },
      (error: unknown) => {
        probing = false;
        if ((error as { code?: unknown } | null)?.code !== "ERR_WORKER_NOT_RUNNING") return;
        stopped = true;
        stopWatching();
        killRunningSidecars();
      },
    );
  };
  const watchWhileSidecarsRun = (): void => {
    if (runningSidecars.size === 0 || exited) {
      stopWatching();
      return;
    }
    if (watch !== undefined) return;
    watch = setInterval(probeThread, SIDECAR_WATCH_INTERVAL_MS);
    watch.unref();
  };
  worker.on("message", (raw: unknown) => {
    const event = sidecarEventOf(raw);
    if (event === undefined) return;
    if (event.event === "exited") {
      runningSidecars.delete(event.pid);
    } else {
      runningSidecars.add(event.pid);
      // Started while the worker was being stopped: nobody else will stop it.
      if (stopped) killRunningSidecars();
    }
    watchWhileSidecarsRun();
  });
  worker.once("exit", (exitCode: number) => {
    exited = true;
    stopWatching();
    killRunningSidecars();
    void Promise.all(kills).then(() => {
      const done: WorkerReaped = { exitCode, orphanedSidecarPids: [...killedSidecars] };
      reaped = done;
      for (const listener of [...listeners]) listener(done);
      listeners.clear();
    });
  });
  const stop = (): void => {
    stopped = true;
    killRunningSidecars();
    void worker.terminate().catch(() => undefined);
  };
  const onReaped = (listener: (done: WorkerReaped) => void): (() => void) => {
    if (reaped !== undefined) {
      const done = reaped;
      queueMicrotask(() => {
        listener(done);
      });
      return () => undefined;
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return { worker, stop, onReaped };
}
