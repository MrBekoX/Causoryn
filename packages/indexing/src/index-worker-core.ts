import { isMainThread, parentPort, workerData } from "node:worker_threads";

import type { GraphRepository, PublishableState } from "@causoryn/graph";
import {
  WorkspaceAccessPolicy,
  type WorkspacePolicyConfig,
} from "@causoryn/workspace";

import { IndexingError } from "./errors.js";
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
 */
export async function runIndexWorkerTask(
  payload: IndexWorkerTaskInput,
  onProgress: IndexProgressCallback | undefined,
  SqliteRepoCtor: SqliteRepositoryConstructor,
  onLeaseEvent?: (event: BuildLeaseEvent) => void,
): Promise<IndexWorkerResultSummary> {
  const repository = new SqliteRepoCtor(payload.dbPath);
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
    repository.close();
  }
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
 * Starts the `worker_threads` indexing loop using a statically injected
 * `SqliteGraphRepository` constructor. Idempotent per worker thread.
 */
export function startIndexWorker(SqliteRepoCtor: SqliteRepositoryConstructor): void {
  if (workerStarted) return;
  if (isMainThread || parentPort === null) return;
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
  const payload = workerData;
  void (async () => {
    try {
      const result = await runIndexWorkerTask(
        payload,
        (event) => {
          const progressMsg: IndexWorkerMessage = {
            type: "progress",
            phase: event.phase,
            completed: event.completed,
            total: event.total,
            message: event.message,
          };
          port.postMessage(progressMsg);
        },
        SqliteRepoCtor,
        (event) => {
          const leaseMsg: IndexWorkerMessage = {
            type: "lease",
            event: event.type,
            leaseId: event.leaseId,
          };
          port.postMessage(leaseMsg);
        },
      );
      const doneMsg: IndexWorkerMessage = { type: "done", result };
      port.postMessage(doneMsg);
    } catch (error) {
      const code = error instanceof IndexingError ? error.code : "indexing/internal";
      const message = error instanceof Error ? error.message : String(error);
      const errorMsg: IndexWorkerMessage = { type: "error", code, message };
      port.postMessage(errorMsg);
    }
  })();
}
