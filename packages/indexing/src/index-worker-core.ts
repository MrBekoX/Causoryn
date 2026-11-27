import { isMainThread, parentPort, workerData } from "node:worker_threads";

import {
  InMemoryGraphRepository,
  serializeSnapshotContentSet,
  type GraphRepository,
  type PublishableState,
} from "@causoryn/graph";
import {
  WorkspaceAccessPolicy,
  type WorkspacePolicyConfig,
} from "@causoryn/workspace";

import { IndexingError } from "./errors.js";
import type { InventoryEntry } from "./inventory.js";
import {
  IndexService,
  type BuildLeaseEvent,
  type BuildLeaseInfo,
  type GoIndexOptions,
  type IndexDiagnostic,
  type IndexLimits,
  type IndexPeerStatus,
  type IndexProgressCallback,
  type IndexProgressPhase,
  type IndexRunOutcome,
  type IndexRunResult,
  type PythonIndexOptions,
  type RustIndexOptions,
} from "./index-service.js";
import { serveIndexJob, serveInventoryAnalysisRequests } from "./index-worker-serve.js";

/**
 * Pure dependency-injected indexing worker core (Task 2.5 — Node.js `worker_threads` + SQLite WAL).
 *
 * Intentionally contains ZERO dynamic `import(...)` calls so bundlers (esbuild) keep the
 * entire ESM module graph flat and eager without wrapping `zod` in lazy `__esm` thunks.
 * Bundled production workers (`packages/mcp-server/src/index-worker-entry.ts`) statically
 * import `SqliteGraphRepository` and invoke `startIndexWorker(SqliteGraphRepository)`.
 */

export interface IndexWorkerTaskInput {
  readonly dbPath: string;
  readonly rootPath: string;
  readonly mode: "full" | "incremental";
  readonly changeSet: readonly string[];
  readonly workspaceId: string;
  readonly policyConfig: WorkspacePolicyConfig;
  readonly limits: IndexLimits;
  readonly csharp?: {
    readonly dotnetCommand?: string;
    readonly requestTimeoutMs?: number;
    readonly workerDllPath?: string;
  };
  readonly python?: PythonIndexOptions;
  readonly go?: GoIndexOptions;
  readonly rust?: RustIndexOptions;
  readonly tolerateConcurrentPublishRace?: boolean;
  readonly hostLabel?: string;
  readonly leaseTtlMs?: number;
  readonly leaseHeartbeatIntervalMs?: number;
  /** Main thread's process instance id (lease owner identity shared by the process). */
  readonly processInstanceId?: string;
  readonly peerWaitTimeoutMs?: number;
  readonly leaseStaleCeilingMs?: number;
  /** Optional fixed ISO timestamp for deterministic clock injection in tests. */
  readonly fixedClockIso?: string;
  /**
   * Shared cancel flag of the job (an Int32 at index 0; non-zero = cancelled).
   * The job manager sets it synchronously before it releases the job's build
   * lease; the job reads it without its event loop (Atomics.load) before it
   * persists file facts and inside its publish transaction, so it holds even
   * while the job is in a synchronous segment that cannot read `cancel`.
   */
  readonly cancelFlag?: SharedArrayBuffer;
}

export interface IndexWorkerResultSummary {
  readonly snapshotId: string;
  readonly stale: boolean;
  readonly fileCount: number;
  readonly tsFileCount: number;
  readonly csFileCount: number;
  readonly state: PublishableState;
  readonly warnings: readonly string[];
  readonly diagnostics: readonly IndexDiagnostic[];
  readonly published: boolean;
  /** Explicit run outcome (see `IndexRunOutcome`); only `published` publishes. */
  readonly outcome?: IndexRunOutcome;
  readonly reanalyzedFiles?: number;
  readonly cachedFiles?: number;
  readonly earlyCutoffApplied?: boolean;
  readonly peerStatus?: IndexPeerStatus;
  readonly waitingForPeer?: boolean;
  readonly reused?: boolean;
  readonly peerLease?: BuildLeaseInfo;
}

/**
 * Inventory analysis mode of the index worker. A worker started with this
 * workerData serves `analyze` requests one at a time: for each it runs a
 * scratch `IndexService` over an in-memory repository on the request's
 * inventory entries (e.g. the files of a git commit read from its objects)
 * and answers with the serialized content set of the snapshot it built.
 * Nothing is published to a data store; the mode needs no SQLite connection.
 * The worker stays alive between requests, so a caller can reuse it.
 */
export interface InventoryAnalysisWorkerData {
  readonly kind: "inventory-analysis";
}

/** One analysis of the inventory analysis mode. */
export interface InventoryAnalysisTask {
  readonly workspaceId: string;
  /** Canonical workspace root the entries are relative to. */
  readonly rootPath: string;
  readonly policyConfig: WorkspacePolicyConfig;
  readonly limits: IndexLimits;
  /** Inventory contract of `IndexServiceOptions.inventorySource`. */
  readonly entries: readonly InventoryEntry[];
  /** Clock of the scratch index (the caller's time, so results stay deterministic). */
  readonly fixedClockIso: string;
}

export interface InventoryAnalysisResult {
  /** `serializeSnapshotContentSet` of the built snapshot. */
  readonly contentSetJson: string;
  readonly state: PublishableState;
  readonly analyzerFingerprint: string;
  readonly fileCount: number;
  readonly warningCount: number;
}

/** Main thread → inventory analysis worker. */
export interface InventoryAnalysisRequest {
  readonly type: "analyze";
  readonly taskId: number;
  readonly task: InventoryAnalysisTask;
}

/**
 * Main thread → inventory analysis worker: stop the sidecar processes of the
 * running analysis (the worker is terminated afterwards; see
 * index-worker-serve.ts).
 */
export interface InventoryAnalysisCancelRequest {
  readonly type: "cancel";
  readonly taskId: number;
}

/**
 * Inventory analysis worker → main thread (every message names its request;
 * a `sidecar` message names the request that was running, or -1).
 */
export type InventoryAnalysisWorkerMessage =
  | {
      /** A sidecar process of the worker started or exited (its pid, for the main thread's cleanup). */
      readonly type: "sidecar";
      readonly taskId: number;
      readonly event: "spawned" | "exited";
      readonly pid: number;
    }
  | {
      /** Answer to a `cancel` request: the worker's sidecar processes were stopped. */
      readonly type: "cancelled";
      readonly taskId: number;
    }
  | {
      readonly type: "progress";
      readonly taskId: number;
      readonly phase: IndexProgressPhase;
      readonly completed: number;
      readonly total: number;
      readonly message: string;
    }
  | {
      readonly type: "analysis-done";
      readonly taskId: number;
      readonly result: InventoryAnalysisResult;
    }
  | {
      readonly type: "error";
      readonly taskId: number;
      readonly code: string;
      readonly message: string;
    };

/**
 * Main thread → index job worker: the job is given up (its job manager
 * closed). The worker closes the job's data store, so the run writes and
 * publishes nothing more, stops its sidecar processes and answers
 * `cancelled`; the main thread terminates it then (see serveIndexJob).
 */
export interface IndexWorkerCancelRequest {
  readonly type: "cancel";
}

export type IndexWorkerMessage =
  | {
      readonly type: "progress";
      readonly phase: IndexProgressPhase;
      readonly completed: number;
      readonly total: number;
      readonly message: string;
    }
  | {
      /** The worker acquired/released the workspace build lease (main thread renews it). */
      readonly type: "lease";
      readonly event: "acquired" | "released";
      readonly leaseId: string;
    }
  | {
      /** A sidecar process of the worker started or exited (its pid, for the main thread's cleanup). */
      readonly type: "sidecar";
      readonly event: "spawned" | "exited";
      readonly pid: number;
    }
  | {
      /** Answer to a `cancel` request: the job's data store is closed and its sidecar processes were stopped. */
      readonly type: "cancelled";
    }
  | {
      readonly type: "done";
      readonly result: IndexWorkerResultSummary;
    }
  | {
      readonly type: "error";
      readonly message: string;
      readonly code: string;
    };

export interface CloseableGraphRepository extends GraphRepository {
  close(): void;
}

export type SqliteRepositoryConstructor = new (
  dbPath: string,
) => CloseableGraphRepository;

function summarizeRunResult(result: IndexRunResult): IndexWorkerResultSummary {
  return {
    snapshotId: result.snapshotId,
    stale: result.stale,
    fileCount: result.fileCount,
    tsFileCount: result.tsFileCount,
    csFileCount: result.csFileCount,
    state: result.state,
    warnings: [...result.warnings],
    diagnostics: result.diagnostics.map((d) => ({ ...d })),
    published: result.published,
    outcome: result.outcome,
    ...(result.reanalyzedFiles === undefined
      ? {}
      : { reanalyzedFiles: result.reanalyzedFiles }),
    ...(result.cachedFiles === undefined
      ? {}
      : { cachedFiles: result.cachedFiles }),
    ...(result.earlyCutoffApplied === undefined
      ? {}
      : { earlyCutoffApplied: result.earlyCutoffApplied }),
    ...(result.peerStatus === undefined ? {} : { peerStatus: result.peerStatus }),
    ...(result.waitingForPeer === undefined
      ? {}
      : { waitingForPeer: result.waitingForPeer }),
    ...(result.reused === undefined ? {} : { reused: result.reused }),
    ...(result.peerLease === undefined ? {} : { peerLease: { ...result.peerLease } }),
  };
}

/**
 * Executes a single indexing task using a dedicated single-writer SQLite WAL connection
 * supplied via `SqliteRepoCtor`.
 *
 * Aborting `signal` cancels the task: its connection is closed at once, so the run
 * writes and publishes nothing more (it fails at its next data store access) while
 * its sidecar processes are being stopped; the job manager that aborts it has
 * already released its build lease and settled the job. `payload.cancelFlag` covers
 * the time before the abort can be seen: the run checks it (and the signal) before
 * it persists file facts and inside its publish transaction (IndexServiceOptions.
 * isCancelled). A task that is already cancelled does not start.
 */
export async function runIndexWorkerTask(
  payload: IndexWorkerTaskInput,
  onProgress: IndexProgressCallback | undefined,
  SqliteRepoCtor: SqliteRepositoryConstructor,
  onLeaseEvent?: (event: BuildLeaseEvent) => void,
  signal?: AbortSignal,
): Promise<IndexWorkerResultSummary> {
  const cancelFlag =
    payload.cancelFlag instanceof SharedArrayBuffer && payload.cancelFlag.byteLength >= 4
      ? new Int32Array(payload.cancelFlag, 0, 1)
      : undefined;
  const isCancelled = (): boolean =>
    signal?.aborted === true || (cancelFlag !== undefined && Atomics.load(cancelFlag, 0) !== 0);
  if (isCancelled()) {
    throw new IndexingError("indexing/internal", "Indexing job cancelled before it started");
  }
  const repository = new SqliteRepoCtor(payload.dbPath);
  let repositoryClosed = false;
  const closeRepository = (): void => {
    if (repositoryClosed) return;
    repositoryClosed = true;
    repository.close();
  };
  const onAbort = (): void => {
    try {
      closeRepository();
    } catch {
      // The connection is unusable either way.
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const policy = WorkspaceAccessPolicy.create(payload.policyConfig);
    const clock =
      payload.fixedClockIso !== undefined
        ? () => payload.fixedClockIso as string
        : () => new Date().toISOString();
    const service = new IndexService({
      workspaceId: payload.workspaceId,
      policy,
      repository,
      clock,
      limits: payload.limits,
      ...(payload.csharp === undefined ? {} : { csharp: payload.csharp }),
      ...(payload.python === undefined ? {} : { python: payload.python }),
      ...(payload.go === undefined ? {} : { go: payload.go }),
      ...(payload.rust === undefined ? {} : { rust: payload.rust }),
      ...(payload.tolerateConcurrentPublishRace === undefined
        ? {}
        : { tolerateConcurrentPublishRace: payload.tolerateConcurrentPublishRace }),
      ...(payload.hostLabel === undefined ? {} : { hostLabel: payload.hostLabel }),
      ...(payload.leaseTtlMs === undefined ? {} : { leaseTtlMs: payload.leaseTtlMs }),
      ...(payload.leaseHeartbeatIntervalMs === undefined
        ? {}
        : { leaseHeartbeatIntervalMs: payload.leaseHeartbeatIntervalMs }),
      ...(payload.processInstanceId === undefined
        ? {}
        : { processInstanceId: payload.processInstanceId }),
      ...(payload.peerWaitTimeoutMs === undefined
        ? {}
        : { peerWaitTimeoutMs: payload.peerWaitTimeoutMs }),
      ...(payload.leaseStaleCeilingMs === undefined
        ? {}
        : { leaseStaleCeilingMs: payload.leaseStaleCeilingMs }),
      ...(onLeaseEvent === undefined ? {} : { onLeaseEvent }),
      ...(signal === undefined && cancelFlag === undefined ? {} : { isCancelled }),
    });

    const runOptions = onProgress === undefined ? {} : { onProgress };
    const result =
      payload.mode === "incremental"
        ? await service.runIncrementalIndexAsync(
            payload.rootPath,
            payload.changeSet,
            runOptions,
          )
        : await service.runIndexAsync(payload.rootPath, runOptions);

    return summarizeRunResult(result);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    closeRepository();
  }
}

/** Runs one inventory analysis (in the analysis worker, or in-process for tests). */
export async function runInventoryAnalysisTask(
  task: InventoryAnalysisTask,
  onProgress?: IndexProgressCallback,
): Promise<InventoryAnalysisResult> {
  const service = new IndexService({
    workspaceId: task.workspaceId,
    policy: WorkspaceAccessPolicy.create(task.policyConfig),
    repository: new InMemoryGraphRepository(),
    clock: () => task.fixedClockIso,
    limits: task.limits,
    inventorySource: () => Promise.resolve(task.entries),
  });
  const run = await service.runIndexAsync(
    task.rootPath,
    onProgress === undefined ? {} : { onProgress },
  );
  return {
    contentSetJson: serializeSnapshotContentSet(run.snapshot),
    state: run.state,
    analyzerFingerprint: run.snapshot.meta.analyzerFingerprint,
    fileCount: run.fileCount,
    warningCount: run.warnings.length,
  };
}

/** workerData of the inventory analysis mode. */
export function isInventoryAnalysisWorkerData(value: unknown): value is InventoryAnalysisWorkerData {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Partial<InventoryAnalysisWorkerData>).kind === "inventory-analysis"
  );
}

export function isWorkerTaskPayload(value: unknown): value is IndexWorkerTaskInput {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<IndexWorkerTaskInput>;
  return (
    typeof record.dbPath === "string" &&
    typeof record.rootPath === "string" &&
    (record.mode === "full" || record.mode === "incremental") &&
    typeof record.workspaceId === "string"
  );
}

let workerStarted = false;

export function hasIndexWorkerStarted(): boolean {
  return workerStarted;
}

export function markIndexWorkerStarted(): void {
  workerStarted = true;
}

/**
 * Serves the inventory analysis mode in this worker thread (workerData is
 * InventoryAnalysisWorkerData) with runInventoryAnalysisTask: see
 * serveInventoryAnalysisRequests (index-worker-serve.ts) for the protocol,
 * the sidecar process reports and the `cancel` request. Idempotent per
 * worker thread.
 */
export function startInventoryAnalysisWorker(): void {
  if (workerStarted) return;
  if (isMainThread || parentPort === null) return;
  workerStarted = true;
  serveInventoryAnalysisRequests(parentPort, runInventoryAnalysisTask);
}

/**
 * Starts the `worker_threads` indexing loop using a statically injected
 * `SqliteGraphRepository` constructor. Idempotent per worker thread. A
 * worker started with InventoryAnalysisWorkerData serves the inventory
 * analysis mode instead (it uses no SQLite connection). The job runs under
 * serveIndexJob (index-worker-serve.ts): progress, lease and result messages,
 * sidecar process reports and the `cancel` request.
 */
export function startIndexWorker(SqliteRepoCtor: SqliteRepositoryConstructor): void {
  if (workerStarted) return;
  if (isMainThread || parentPort === null) return;
  if (isInventoryAnalysisWorkerData(workerData)) {
    startInventoryAnalysisWorker();
    return;
  }
  workerStarted = true;
  const port = parentPort;
  if (!isWorkerTaskPayload(workerData)) {
    const errorMsg: IndexWorkerMessage = {
      type: "error",
      code: "indexing/internal",
      message: "Invalid indexing worker payload",
    };
    port.postMessage(errorMsg);
    return;
  }
  serveIndexJob(port, workerData, (payload, hooks) =>
    runIndexWorkerTask(payload, hooks.onProgress, SqliteRepoCtor, hooks.onLeaseEvent, hooks.signal),
  );
}
