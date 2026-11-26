import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SHARE_ENV, Worker, type WorkerOptions } from "node:worker_threads";

import { IndexingError, type IndexingErrorCode } from "./errors.js";
import type { IndexProgressEvent } from "./index-service.js";
import type {
  InventoryAnalysisCancelRequest,
  InventoryAnalysisRequest,
  InventoryAnalysisResult,
  InventoryAnalysisTask,
  InventoryAnalysisWorkerData,
  InventoryAnalysisWorkerMessage,
} from "./index-worker-core.js";
import {
  SIDECAR_CANCEL_GRACE_MS,
  trackSidecarWorker,
  type SidecarTrackedWorker,
  type WorkerReaped,
} from "./index-worker-sidecars.js";
import { validateWorkerEntryPath } from "./job-manager.js";

/**
 * Main-thread side of the index worker's inventory analysis mode
 * (InventoryAnalysisWorkerData): runs a scratch index over given inventory
 * entries in a `worker_threads` worker, so a long synchronous analyzer phase
 * (the TypeScript program) never blocks the caller's event loop and its
 * memory stays in the worker's own V8 heap, capped by `maxHeapMb`.
 *
 * The worker is the existing index worker entry next to this module (the
 * same resolution as IndexJobManager): `index-worker.ts` from TypeScript
 * sources (dev / Vitest), `index-worker.js` from compiled output, and the
 * bundled `index-worker.mjs` next to `mcp-server.mjs`. No extra bundle entry.
 *
 * Reuse: a worker that answered is kept idle (unreferenced, so it never
 * keeps the process alive) for IDLE_WORKER_TTL_MS and serves the next run
 * with the same entry and heap limit, which saves the worker start and the
 * analyzers' warm-up. At most MAX_IDLE_WORKERS are kept (the longest idle
 * one is terminated first). The worker shares
 * the process environment (SHARE_ENV), so a reused worker sees the current
 * environment like a fresh one.
 *
 * Failure handling: aborting `signal` rejects with the signal's reason; the
 * worker is first sent a `cancel` request, so it stops its sidecar processes
 * with the adapters' own tree-kill hooks while its event loop still runs, and
 * it is terminated once it answered or after ANALYSIS_CANCEL_GRACE_MS. A
 * worker that cannot start, runs out of memory, crashes, exits or sends an
 * unexpected message rejects with InventoryAnalysisWorkerError (a worker that
 * is still running is terminated right away). Such a run settles once the
 * thread has exited, or FAILED_RUN_SETTLE_MS after it was given up when the
 * thread cannot be stopped yet (a synchronous native call such as spawnSync
 * delays termination until it returns): the thread may then outlive the
 * settled run, and `onWorkerReleased` tells the caller when it is gone. An
 * analysis error raised inside the worker rejects with an IndexingError
 * carrying the worker's code and message (the worker stays usable).
 *
 * Sidecar processes: the worker reports the pid of every sidecar process it
 * starts and of every one that exits (`sidecar` messages). Whatever it still
 * reports as running when this thread gives it up (it ignored the cancel,
 * crashed, ran out of memory, sent garbage, or an idle worker is retired) is
 * killed from this thread right away, together with the termination (on
 * Windows the whole process tree with the absolute System32 taskkill /T /F,
 * elsewhere SIGKILL); see trackSidecarWorker (index-worker-sidecars.ts),
 * which the index job worker of IndexJobManager shares.
 */

/** Why the analysis worker produced no result. */
export type InventoryAnalysisWorkerFailure =
  /** No worker entry was found, or the thread could not be created. */
  | "unavailable"
  /** The worker reached its heap limit (ERR_WORKER_OUT_OF_MEMORY). */
  | "out-of-memory"
  /** An uncaught error ended the worker. */
  | "crashed"
  /** The worker exited without a result. */
  | "exited"
  /** The worker sent a message that is not part of the protocol. */
  | "protocol";

export class InventoryAnalysisWorkerError extends Error {
  readonly failure: InventoryAnalysisWorkerFailure;
  /** The worker's exit code, when it exited. */
  readonly exitCode: number | undefined;

  constructor(failure: InventoryAnalysisWorkerFailure, message: string, exitCode?: number) {
    super(message);
    this.name = "InventoryAnalysisWorkerError";
    this.failure = failure;
    this.exitCode = exitCode;
  }
}

/** What onWorkerReleased reports about the thread a run used. */
export interface InventoryAnalysisWorkerRelease {
  /**
   * Sidecar processes the worker still reported as running when it was given
   * up or exited; they were killed from the calling thread (empty when the
   * worker stopped its sidecars itself, or went back to the idle pool).
   */
  readonly orphanedSidecarPids: readonly number[];
}

export interface InventoryAnalysisWorkerOptions {
  /** V8 old-generation heap limit of the worker in MiB (`resourceLimits.maxOldGenerationSizeMb`). */
  readonly maxHeapMb: number;
  /** Aborting cancels and then terminates the worker; the run rejects with `signal.reason`. */
  readonly signal?: AbortSignal;
  /** Every progress event of the worker's scratch index (phase boundaries). */
  readonly onProgress?: (event: IndexProgressEvent) => void;
  /** Worker entry override (validated like IndexJobManagerOptions.workerEntryPath). */
  readonly workerEntryPath?: string;
  /**
   * Called exactly once, when this run no longer occupies a worker thread:
   * right before a successful run (or one with an analysis error) settles,
   * since its worker went back to the idle pool; once the thread has exited
   * and its leftover sidecar processes were killed for a run that failed or
   * was aborted (possibly after the run settled); and right away when no
   * thread was started.
   */
  readonly onWorkerReleased?: (release: InventoryAnalysisWorkerRelease) => void;
}

/** Input of runInventoryAnalysisInWorker. */
export type InventoryAnalysisWorkerInput = InventoryAnalysisTask;

/** An idle worker is terminated after this long without a run. */
const IDLE_WORKER_TTL_MS = 30_000;
/** Idle workers kept at most (one per concurrent analysis is enough). */
const MAX_IDLE_WORKERS = 2;
/**
 * How long an aborted run's worker gets to stop its sidecar processes itself
 * (the `cancel` request) before it is terminated.
 */
const ANALYSIS_CANCEL_GRACE_MS = SIDECAR_CANCEL_GRACE_MS;
/**
 * A run that was aborted or failed settles at the latest this long after,
 * even when its thread has not exited yet (longer than
 * ANALYSIS_CANCEL_GRACE_MS, so a worker that can be stopped normally has
 * exited by then).
 */
const FAILED_RUN_SETTLE_MS = 2_000;

interface ResolvedEntry {
  readonly kind: "js" | "ts-source";
  readonly path: string;
}

/** A started analysis worker, followed for the sidecar processes it reports. */
type AnalysisWorker = SidecarTrackedWorker;

interface IdleWorker {
  readonly analysisWorker: AnalysisWorker;
  /** Entry and heap limit the worker was started with. */
  readonly key: string;
  readonly timer: NodeJS.Timeout;
  /** Forgets the worker when it exits while idle. */
  readonly onExit: () => void;
}

const idleWorkers: IdleWorker[] = [];
let nextTaskId = 1;

/**
 * ESM bootstrap for a worker started from TypeScript sources (Node 24+ type
 * stripping): resolves relative `.js` specifiers to their `.ts` sources and
 * imports the trusted `workerData.__workerEntryUrl` (same bootstrap as the
 * index job worker).
 */
const TS_WORKER_BOOTSTRAP_CODE = `
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { workerData } from "node:worker_threads";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (
        specifier.endsWith(".js") &&
        context.parentURL &&
        context.parentURL.startsWith("file:")
      ) {
        const parentDir = path.dirname(fileURLToPath(context.parentURL));
        const tsPath = path.resolve(parentDir, specifier.slice(0, -3) + ".ts");
        if (existsSync(tsPath)) {
          return nextResolve(pathToFileURL(tsPath).href, context);
        }
      }
      throw err;
    }
  },
});

await import(workerData.__workerEntryUrl);
`;

const FORWARDED_INDEXING_CODES: ReadonlySet<string> = new Set<IndexingErrorCode>([
  "indexing/root-not-authorized",
  "indexing/path-denied",
  "indexing/limit-exceeded",
  "indexing/unsupported-mode",
  "indexing/internal",
]);

function resolveAnalysisWorkerEntry(override: string | undefined): ResolvedEntry | undefined {
  if (override !== undefined) {
    const validated = validateWorkerEntryPath(override);
    if (validated === undefined) return undefined;
    return { kind: validated.endsWith(".ts") ? "ts-source" : "js", path: validated };
  }
  let selfPath: string;
  try {
    selfPath = fileURLToPath(import.meta.url);
  } catch {
    return undefined;
  }
  const selfDir = path.dirname(selfPath);
  const candidate = (name: string): string | undefined =>
    validateWorkerEntryPath(path.join(selfDir, name), selfDir);
  if (selfPath.endsWith(".ts")) {
    const tsWorker = candidate("index-worker.ts");
    return tsWorker === undefined ? undefined : { kind: "ts-source", path: tsWorker };
  }
  const order = selfPath.endsWith(".mjs")
    ? ["index-worker.mjs", "index-worker.js"]
    : ["index-worker.js", "index-worker.mjs"];
  for (const name of order) {
    const worker = candidate(name);
    if (worker !== undefined) return { kind: "js", path: worker };
  }
  return undefined;
}

function spawnAnalysisWorker(entry: ResolvedEntry, maxHeapMb: number): AnalysisWorker {
  const workerData: InventoryAnalysisWorkerData = { kind: "inventory-analysis" };
  const common: WorkerOptions = { env: SHARE_ENV, resourceLimits: { maxOldGenerationSizeMb: maxHeapMb } };
  const worker = entry.kind === "ts-source"
    ? new Worker(TS_WORKER_BOOTSTRAP_CODE, {
        ...common,
        eval: true,
        workerData: {
          ...workerData,
          __workerEntryUrl: pathToFileURL(entry.path).href,
          __causorynBootstrap: true,
        },
        execArgv: ["--experimental-transform-types", "--no-warnings"],
      })
    : new Worker(pathToFileURL(entry.path), { ...common, workerData });
  // A run reports the errors of its worker with its own listener; this one
  // keeps an error of an idle worker (which then exits and is forgotten)
  // from becoming an uncaught exception of the calling thread.
  worker.on("error", () => undefined);
  return trackSidecarWorker(worker);
}

/** An idle worker started with `key`, taken out of the idle list. */
function takeIdleWorker(key: string): AnalysisWorker | undefined {
  const index = idleWorkers.findIndex((idle) => idle.key === key);
  if (index < 0) return undefined;
  const [idle] = idleWorkers.splice(index, 1);
  if (idle === undefined) return undefined;
  clearTimeout(idle.timer);
  idle.analysisWorker.worker.off("exit", idle.onExit);
  idle.analysisWorker.worker.ref();
  return idle.analysisWorker;
}

/** Keeps `analysisWorker` for a later run (unreferenced); the longest idle one goes when enough are kept. */
function releaseIdleWorker(analysisWorker: AnalysisWorker, key: string): void {
  const { worker } = analysisWorker;
  while (idleWorkers.length >= MAX_IDLE_WORKERS) {
    const oldest = idleWorkers.shift();
    if (oldest === undefined) break;
    clearTimeout(oldest.timer);
    oldest.analysisWorker.worker.off("exit", oldest.onExit);
    oldest.analysisWorker.stop();
  }
  worker.unref();
  const forget = (): void => {
    const index = idleWorkers.findIndex((candidate) => candidate.analysisWorker === analysisWorker);
    if (index < 0) return;
    const [idle] = idleWorkers.splice(index, 1);
    if (idle !== undefined) {
      clearTimeout(idle.timer);
      worker.off("exit", idle.onExit);
    }
  };
  const timer = setTimeout(() => {
    forget();
    analysisWorker.stop();
  }, IDLE_WORKER_TTL_MS);
  timer.unref();
  // An idle worker that dies is forgotten.
  worker.once("exit", forget);
  idleWorkers.push({ analysisWorker, key, timer, onExit: forget });
}

function isAnalysisResult(value: unknown): value is InventoryAnalysisResult {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<InventoryAnalysisResult>;
  return (
    typeof record.contentSetJson === "string" &&
    (record.state === "ready" || record.state === "partial") &&
    typeof record.analyzerFingerprint === "string" &&
    typeof record.fileCount === "number" &&
    typeof record.warningCount === "number"
  );
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs one inventory analysis in an analysis worker thread (see the module comment). */
export function runInventoryAnalysisInWorker(
  input: InventoryAnalysisWorkerInput,
  options: InventoryAnalysisWorkerOptions,
): Promise<InventoryAnalysisResult> {
  const { signal } = options;
  let threadReleased = false;
  const releaseThread = (orphanedSidecarPids: readonly number[]): void => {
    if (threadReleased) return;
    threadReleased = true;
    try {
      options.onWorkerReleased?.({ orphanedSidecarPids });
    } catch {
      // The caller's hook never changes the run's outcome.
    }
  };
  const rejectWithoutThread = (error: unknown): Promise<never> => {
    releaseThread([]);
    return Promise.reject(error as Error);
  };
  if (signal?.aborted === true) return rejectWithoutThread(signal.reason);
  const entry = resolveAnalysisWorkerEntry(options.workerEntryPath);
  if (entry === undefined) {
    return rejectWithoutThread(
      new InventoryAnalysisWorkerError("unavailable", "the index worker entry point was not found"),
    );
  }
  const key = `${entry.kind}\0${entry.path}\0${String(options.maxHeapMb)}`;
  let analysisWorker = takeIdleWorker(key);
  if (analysisWorker === undefined) {
    try {
      analysisWorker = spawnAnalysisWorker(entry, options.maxHeapMb);
    } catch (error) {
      return rejectWithoutThread(
        new InventoryAnalysisWorkerError(
          "unavailable",
          `the analysis worker could not be started: ${errorMessageOf(error)}`,
        ),
      );
    }
  }
  const tracked = analysisWorker;
  const running = tracked.worker;
  const taskId = nextTaskId;
  nextTaskId += 1;

  return new Promise<InventoryAnalysisResult>((resolve, reject) => {
    let settled = false;
    // Set once the worker is given up (aborted or failed): it is terminated,
    // and the run settles when the thread is gone or FAILED_RUN_SETTLE_MS later.
    let failure: { readonly error: unknown } | undefined;
    let cancelling = false;
    let settleTimer: NodeJS.Timeout | undefined;
    let cancelTimer: NodeJS.Timeout | undefined;
    const detach = (): void => {
      running.off("message", onMessage);
      running.off("messageerror", onMessageError);
      running.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const terminate = (): void => {
      clearTimeout(cancelTimer);
      tracked.stop();
    };
    const settleFailure = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(settleTimer);
      detach();
      reject(error as Error);
    };
    const succeed = (settle: () => void): void => {
      if (settled || failure !== undefined) return;
      settled = true;
      detach();
      stopWatchingExit();
      releaseIdleWorker(tracked, key);
      releaseThread([]);
      settle();
    };
    /**
     * Gives the worker up with `error`: an aborted run (`cancel`) first asks
     * the worker to stop its sidecar processes and terminates it once it
     * answered or after ANALYSIS_CANCEL_GRACE_MS; any other failure
     * terminates it right away.
     */
    const giveUp = (error: unknown, cancel: boolean): void => {
      if (settled || failure !== undefined) return;
      failure = { error };
      settleTimer = setTimeout(() => {
        settleFailure(error);
      }, FAILED_RUN_SETTLE_MS);
      settleTimer.unref();
      if (!cancel) {
        terminate();
        return;
      }
      cancelling = true;
      const request: InventoryAnalysisCancelRequest = { type: "cancel", taskId };
      try {
        running.postMessage(request);
      } catch {
        terminate();
        return;
      }
      cancelTimer = setTimeout(terminate, ANALYSIS_CANCEL_GRACE_MS);
      cancelTimer.unref();
    };
    const fail = (error: unknown): void => {
      giveUp(error, false);
    };
    const onAbort = (): void => {
      giveUp(signal?.reason, true);
    };
    const onMessage = (raw: unknown): void => {
      const message = raw as Partial<InventoryAnalysisWorkerMessage> | null;
      // Sidecar reports are followed for the worker's whole life (trackSidecarWorker).
      if (message !== null && typeof message === "object" && message.type === "sidecar") return;
      if (message === null || typeof message !== "object" || message.taskId !== taskId) {
        fail(new InventoryAnalysisWorkerError("protocol", "the analysis worker sent an unexpected message"));
        return;
      }
      switch (message.type) {
        case "cancelled":
          // The worker stopped its sidecar processes: it can go now.
          if (cancelling) terminate();
          return;
        case "progress":
          try {
            options.onProgress?.({
              phase: message.phase as IndexProgressEvent["phase"],
              completed: Number(message.completed),
              total: Number(message.total),
              message: String(message.message),
            });
          } catch (error) {
            fail(error);
          }
          return;
        case "analysis-done": {
          const result = message.result;
          if (isAnalysisResult(result)) {
            succeed(() => {
              resolve(result);
            });
          } else {
            fail(new InventoryAnalysisWorkerError("protocol", "the analysis worker sent a malformed result"));
          }
          return;
        }
        case "error": {
          const code =
            typeof message.code === "string" && FORWARDED_INDEXING_CODES.has(message.code)
              ? (message.code as IndexingErrorCode)
              : "indexing/internal";
          const error = new IndexingError(code, String(message.message));
          succeed(() => {
            reject(error);
          });
          return;
        }
        default:
          fail(new InventoryAnalysisWorkerError("protocol", "the analysis worker sent an unexpected message"));
      }
    };
    const onMessageError = (error: unknown): void => {
      fail(
        new InventoryAnalysisWorkerError(
          "protocol",
          `an analysis worker message could not be read: ${errorMessageOf(error)}`,
        ),
      );
    };
    const onError = (error: Error & { code?: unknown }): void => {
      fail(
        error.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? new InventoryAnalysisWorkerError(
              "out-of-memory",
              `the analysis worker reached its heap limit of ${String(options.maxHeapMb)} MiB`,
            )
          : new InventoryAnalysisWorkerError("crashed", `the analysis worker failed: ${errorMessageOf(error)}`),
      );
    };
    // The thread is gone and its leftover sidecar processes were killed.
    const onReaped = ({ exitCode, orphanedSidecarPids }: WorkerReaped): void => {
      settleFailure(
        failure?.error ??
          new InventoryAnalysisWorkerError(
            "exited",
            `the analysis worker exited without a result (exit code ${String(exitCode)})`,
            exitCode,
          ),
      );
      releaseThread(orphanedSidecarPids);
    };

    running.on("message", onMessage);
    running.on("messageerror", onMessageError);
    running.on("error", onError);
    const stopWatchingExit = tracked.onReaped(onReaped);
    signal?.addEventListener("abort", onAbort, { once: true });
    const request: InventoryAnalysisRequest = { type: "analyze", taskId, task: input };
    try {
      running.postMessage(request);
    } catch (error) {
      fail(
        new InventoryAnalysisWorkerError(
          "unavailable",
          `the analysis request could not be sent: ${errorMessageOf(error)}`,
        ),
      );
    }
  });
}
