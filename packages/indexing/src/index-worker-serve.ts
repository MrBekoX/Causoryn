import type { MessagePort } from "node:worker_threads";

import { onSidecarProcessEvent, terminateSidecarProcesses } from "@causoryn/sidecar-ipc";

import { IndexingError } from "./errors.js";
import type { BuildLeaseEvent, IndexProgressCallback } from "./index-service.js";
import type {
  IndexWorkerCancelRequest,
  IndexWorkerMessage,
  IndexWorkerResultSummary,
  IndexWorkerTaskInput,
  InventoryAnalysisCancelRequest,
  InventoryAnalysisRequest,
  InventoryAnalysisResult,
  InventoryAnalysisTask,
  InventoryAnalysisWorkerMessage,
} from "./index-worker-core.js";

/**
 * Worker-side request loop of the index worker's inventory analysis mode
 * (the protocol types live in index-worker-core.ts). Kept free of the
 * analyzers so a test worker can serve the same protocol with its own
 * analysis function.
 *
 * Sidecar processes: every sidecar process the analysis starts on this
 * thread (the adapters' shared IPC core records it in the thread's sidecar
 * registry, @causoryn/sidecar-ipc) is reported to the main thread with a
 * `sidecar` message when it starts and when it exits, so the main thread can
 * kill what is left once the worker is gone (it crashed, ran out of memory or
 * was terminated). A `cancel` request stops all of them with the adapters'
 * own tree-kill hooks (terminateSidecarProcesses) and is answered with
 * `cancelled` once they have exited (or after CANCEL_SIDECAR_EXIT_WAIT_MS);
 * the main thread then terminates the worker. The running analysis itself is
 * not interrupted: the worker is not reused after a cancel.
 *
 * The index job mode (serveIndexJob) follows the same rules for its sidecar
 * processes: it reports their pids with `sidecar` messages, and a `cancel`
 * request aborts the job's signal (the job closes its data store, so it
 * publishes nothing more), stops the sidecars and is answered with
 * `cancelled`.
 */

/** Runs one inventory analysis (InventoryAnalysisTask → InventoryAnalysisResult). */
export type InventoryAnalysisFunction = (
  task: InventoryAnalysisTask,
  onProgress?: IndexProgressCallback,
) => Promise<InventoryAnalysisResult>;

/**
 * How long a cancelled worker waits for its sidecar processes to exit before
 * it answers `cancelled` (shorter than the main thread's grace period, so the
 * answer normally arrives before the worker is terminated).
 */
export const CANCEL_SIDECAR_EXIT_WAIT_MS = 750;

function isInventoryAnalysisRequest(value: unknown): value is InventoryAnalysisRequest {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<InventoryAnalysisRequest>;
  const task = record.task as Partial<InventoryAnalysisTask> | undefined;
  return (
    record.type === "analyze" &&
    typeof record.taskId === "number" &&
    task !== null &&
    typeof task === "object" &&
    typeof task.workspaceId === "string" &&
    typeof task.rootPath === "string" &&
    typeof task.fixedClockIso === "string" &&
    task.policyConfig !== null &&
    typeof task.policyConfig === "object" &&
    task.limits !== null &&
    typeof task.limits === "object" &&
    Array.isArray(task.entries)
  );
}

function isCancelRequest(value: unknown): value is InventoryAnalysisCancelRequest {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<InventoryAnalysisCancelRequest>;
  return record.type === "cancel" && typeof record.taskId === "number";
}

/**
 * Serves `analyze` and `cancel` requests on `port` (see the module comment):
 * every `analyze` request is answered with `progress` messages and then one
 * `analysis-done` or `error` message, all carrying the request's taskId;
 * requests run one after another.
 */
export function serveInventoryAnalysisRequests(port: MessagePort, analyze: InventoryAnalysisFunction): void {
  let queue: Promise<void> = Promise.resolve();
  let currentTaskId = -1;
  const post = (message: InventoryAnalysisWorkerMessage): void => {
    port.postMessage(message);
  };
  onSidecarProcessEvent((event) => {
    post({ type: "sidecar", taskId: currentTaskId, event: event.type, pid: event.pid });
  });
  const serve = async (request: InventoryAnalysisRequest): Promise<void> => {
    const { taskId } = request;
    currentTaskId = taskId;
    try {
      const result = await analyze(request.task, (event) => {
        post({
          type: "progress",
          taskId,
          phase: event.phase,
          completed: event.completed,
          total: event.total,
          message: event.message,
        });
      });
      post({ type: "analysis-done", taskId, result });
    } catch (error) {
      post({
        type: "error",
        taskId,
        code: error instanceof IndexingError ? error.code : "indexing/internal",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      currentTaskId = -1;
    }
  };
  port.on("message", (raw: unknown) => {
    if (isCancelRequest(raw)) {
      const { taskId } = raw;
      void terminateSidecarProcesses(CANCEL_SIDECAR_EXIT_WAIT_MS).then(() => {
        post({ type: "cancelled", taskId });
      });
      return;
    }
    if (!isInventoryAnalysisRequest(raw)) {
      const taskId = (raw as { taskId?: unknown } | null)?.taskId;
      post({
        type: "error",
        taskId: typeof taskId === "number" ? taskId : -1,
        code: "indexing/internal",
        message: "Invalid inventory analysis request",
      });
      return;
    }
    queue = queue.then(() => serve(raw));
  });
}

/** What an index job gets from serveIndexJob besides its payload. */
export interface IndexJobHooks {
  readonly onProgress: IndexProgressCallback;
  readonly onLeaseEvent: (event: BuildLeaseEvent) => void;
  /**
   * Aborted when the main thread cancels the job (its job manager closed):
   * the job must then write and publish nothing more.
   */
  readonly signal: AbortSignal;
}

/** Runs one index job (IndexWorkerTaskInput → IndexWorkerResultSummary). */
export type IndexJobFunction = (
  payload: IndexWorkerTaskInput,
  hooks: IndexJobHooks,
) => Promise<IndexWorkerResultSummary>;

function isIndexWorkerCancelRequest(value: unknown): value is IndexWorkerCancelRequest {
  return value !== null && typeof value === "object" && (value as Partial<IndexWorkerCancelRequest>).type === "cancel";
}

/**
 * Runs the index job `payload` with `run` on `port` (the index job mode of the
 * worker): `progress` and `lease` messages while it runs, then one `done` or
 * `error` message. Every sidecar process the job starts on this thread (the
 * shared registry of @causoryn/sidecar-ipc) is reported with `sidecar`
 * messages, so the main thread can kill what is left once it gives the worker
 * up. A `cancel` request aborts the job's signal first (the job then stops
 * writing), stops the sidecar processes with the adapters' own tree-kill hooks
 * (terminateSidecarProcesses) and is answered with `cancelled` once they have
 * exited (or after CANCEL_SIDECAR_EXIT_WAIT_MS); the main thread terminates
 * the worker then. Listening for `cancel` does not keep the thread alive: it
 * still exits once its job is over.
 */
export function serveIndexJob(port: MessagePort, payload: IndexWorkerTaskInput, run: IndexJobFunction): void {
  const post = (message: IndexWorkerMessage): void => {
    port.postMessage(message);
  };
  const controller = new AbortController();
  onSidecarProcessEvent((event) => {
    post({ type: "sidecar", event: event.type, pid: event.pid });
  });
  port.on("message", (raw: unknown) => {
    if (!isIndexWorkerCancelRequest(raw)) return;
    controller.abort();
    void terminateSidecarProcesses(CANCEL_SIDECAR_EXIT_WAIT_MS).then(() => {
      post({ type: "cancelled" });
    });
  });
  port.unref();
  void (async () => {
    try {
      const result = await run(payload, {
        onProgress: (event) => {
          post({
            type: "progress",
            phase: event.phase,
            completed: event.completed,
            total: event.total,
            message: event.message,
          });
        },
        onLeaseEvent: (event) => {
          post({ type: "lease", event: event.type, leaseId: event.leaseId });
        },
        signal: controller.signal,
      });
      post({ type: "done", result });
    } catch (error) {
      post({
        type: "error",
        code: error instanceof IndexingError ? error.code : "indexing/internal",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}
