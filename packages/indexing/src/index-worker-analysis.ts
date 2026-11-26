import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SHARE_ENV, Worker, type WorkerOptions } from "node:worker_threads";

import { IndexingError, type IndexingErrorCode } from "./errors.js";
import type { IndexProgressEvent } from "./index-service.js";
import type {
  InventoryAnalysisRequest,
  InventoryAnalysisResult,
  InventoryAnalysisTask,
  InventoryAnalysisWorkerData,
  InventoryAnalysisWorkerMessage,
} from "./index-worker-core.js";
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
 * Failure handling: aborting `signal` terminates the worker and rejects with
 * the signal's reason. A worker that cannot start, runs out of memory,
 * crashes, exits or sends an unexpected message rejects with
 * InventoryAnalysisWorkerError; such a run settles only after the thread has
 * exited, so no analysis outlives it. An analysis error raised inside the
 * worker rejects with an IndexingError carrying the worker's code and
 * message (the worker stays usable).
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

export interface InventoryAnalysisWorkerOptions {
  /** V8 old-generation heap limit of the worker in MiB (`resourceLimits.maxOldGenerationSizeMb`). */
  readonly maxHeapMb: number;
  /** Aborting terminates the worker; the run rejects with `signal.reason`. */
  readonly signal?: AbortSignal;
  /** Every progress event of the worker's scratch index (phase boundaries). */
  readonly onProgress?: (event: IndexProgressEvent) => void;
  /** Worker entry override (validated like IndexJobManagerOptions.workerEntryPath). */
  readonly workerEntryPath?: string;
}

/** Input of runInventoryAnalysisInWorker. */
export type InventoryAnalysisWorkerInput = InventoryAnalysisTask;

/** An idle worker is terminated after this long without a run. */
const IDLE_WORKER_TTL_MS = 30_000;
/** Idle workers kept at most (one per concurrent analysis is enough). */
const MAX_IDLE_WORKERS = 2;

interface ResolvedEntry {
  readonly kind: "js" | "ts-source";
  readonly path: string;
}

interface IdleWorker {
  readonly worker: Worker;
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

function spawnAnalysisWorker(entry: ResolvedEntry, maxHeapMb: number): Worker {
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
  return worker;
}

/** An idle worker started with `key`, taken out of the idle list. */
function takeIdleWorker(key: string): Worker | undefined {
  const index = idleWorkers.findIndex((idle) => idle.key === key);
  if (index < 0) return undefined;
  const [idle] = idleWorkers.splice(index, 1);
  if (idle === undefined) return undefined;
  clearTimeout(idle.timer);
  idle.worker.off("exit", idle.onExit);
  idle.worker.ref();
  return idle.worker;
}

/** Keeps `worker` for a later run (unreferenced); the longest idle one goes when enough are kept. */
function releaseIdleWorker(worker: Worker, key: string): void {
  while (idleWorkers.length >= MAX_IDLE_WORKERS) {
    const oldest = idleWorkers.shift();
    if (oldest === undefined) break;
    clearTimeout(oldest.timer);
    oldest.worker.off("exit", oldest.onExit);
    void oldest.worker.terminate().catch(() => undefined);
  }
  worker.unref();
  const forget = (): void => {
    const index = idleWorkers.findIndex((candidate) => candidate.worker === worker);
    if (index < 0) return;
    const [idle] = idleWorkers.splice(index, 1);
    if (idle !== undefined) {
      clearTimeout(idle.timer);
      worker.off("exit", idle.onExit);
    }
  };
  const timer = setTimeout(() => {
    forget();
    void worker.terminate().catch(() => undefined);
  }, IDLE_WORKER_TTL_MS);
  timer.unref();
  // An idle worker that dies is forgotten.
  worker.once("exit", forget);
  idleWorkers.push({ worker, key, timer, onExit: forget });
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
  if (signal?.aborted === true) return Promise.reject(signal.reason as Error);
  const entry = resolveAnalysisWorkerEntry(options.workerEntryPath);
  if (entry === undefined) {
    return Promise.reject(
      new InventoryAnalysisWorkerError("unavailable", "the index worker entry point was not found"),
    );
  }
  const key = `${entry.kind}\0${entry.path}\0${String(options.maxHeapMb)}`;
  let worker = takeIdleWorker(key);
  if (worker === undefined) {
    try {
      worker = spawnAnalysisWorker(entry, options.maxHeapMb);
    } catch (error) {
      return Promise.reject(
        new InventoryAnalysisWorkerError(
          "unavailable",
          `the analysis worker could not be started: ${errorMessageOf(error)}`,
        ),
      );
    }
  }
  const running = worker;
  const taskId = nextTaskId;
  nextTaskId += 1;

  return new Promise<InventoryAnalysisResult>((resolve, reject) => {
    let settled = false;
    // A failure ends the worker; the run settles once the thread has exited.
    let failure: { readonly error: unknown } | undefined;
    const detach = (): void => {
      running.off("message", onMessage);
      running.off("messageerror", onMessageError);
      running.off("error", onError);
      running.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
    };
    const succeed = (settle: () => void): void => {
      if (settled || failure !== undefined) return;
      settled = true;
      detach();
      releaseIdleWorker(running, key);
      settle();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      failure ??= { error };
      void running.terminate().catch(() => undefined);
    };
    const onAbort = (): void => {
      fail(signal?.reason);
    };
    const onMessage = (raw: unknown): void => {
      const message = raw as Partial<InventoryAnalysisWorkerMessage> | null;
      if (message === null || typeof message !== "object" || message.taskId !== taskId) {
        fail(new InventoryAnalysisWorkerError("protocol", "the analysis worker sent an unexpected message"));
        return;
      }
      switch (message.type) {
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
    const onExit = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      detach();
      reject(
        (failure?.error ??
          new InventoryAnalysisWorkerError(
            "exited",
            `the analysis worker exited without a result (exit code ${String(exitCode)})`,
            exitCode,
          )) as Error,
      );
    };

    running.on("message", onMessage);
    running.on("messageerror", onMessageError);
    running.on("error", onError);
    running.on("exit", onExit);
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
