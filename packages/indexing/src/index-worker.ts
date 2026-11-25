import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { IndexingError } from "./errors.js";
import type { BuildLeaseEvent, IndexProgressCallback } from "./index-service.js";
import {
  hasIndexWorkerStarted,
  isWorkerTaskPayload,
  markIndexWorkerStarted,
  runIndexWorkerTask as runIndexWorkerTaskCore,
  startIndexWorker,
  type CloseableGraphRepository,
  type IndexWorkerMessage,
  type IndexWorkerResultSummary,
  type IndexWorkerTaskInput,
  type SqliteRepositoryConstructor,
} from "./index-worker-core.js";

/**
 * Direct dev / Vitest `worker_threads` entrypoint for `packages/indexing`.
 *
 * NOT imported by `@causoryn/indexing`'s barrel `src/index.ts` or by bundled
 * `dist/mcp-server.mjs` (bundled builds use `packages/mcp-server/src/index-worker-entry.ts`
 * with static `SqliteGraphRepository` injection). Keeping the dev-only
 * `import("@causoryn/storage-sqlite")` isolated to this standalone file prevents
 * esbuild from wrapping `zod` in lazy `__esm` thunks inside `mcp-server.mjs`.
 */

export type {
  CloseableGraphRepository,
  IndexWorkerMessage,
  IndexWorkerResultSummary,
  IndexWorkerTaskInput,
  SqliteRepositoryConstructor,
};
export { startIndexWorker };

interface StorageSqliteExports {
  readonly SqliteGraphRepository: SqliteRepositoryConstructor;
}

async function loadDefaultSqliteRepositoryCtor(): Promise<SqliteRepositoryConstructor> {
  const loaded = (await import("@causoryn/storage-sqlite")) as Partial<StorageSqliteExports>;
  if (typeof loaded.SqliteGraphRepository !== "function") {
    throw new IndexingError(
      "indexing/internal",
      "SqliteGraphRepository export not found in @causoryn/storage-sqlite",
    );
  }
  return loaded.SqliteGraphRepository;
}

export async function runIndexWorkerTask(
  payload: IndexWorkerTaskInput,
  onProgress?: IndexProgressCallback,
  SqliteRepoCtor?: SqliteRepositoryConstructor,
  onLeaseEvent?: (event: BuildLeaseEvent) => void,
): Promise<IndexWorkerResultSummary> {
  const RepoCtor = SqliteRepoCtor ?? (await loadDefaultSqliteRepositoryCtor());
  return runIndexWorkerTaskCore(payload, onProgress, RepoCtor, onLeaseEvent);
}

function isSameFileUrl(urlA: string, urlB: string): boolean {
  try {
    const pathA = path.resolve(fileURLToPath(urlA));
    const pathB = path.resolve(fileURLToPath(urlB));
    return process.platform === "win32"
      ? pathA.toLowerCase() === pathB.toLowerCase()
      : pathA === pathB;
  } catch {
    return urlA === urlB;
  }
}

interface DirectBootstrapWorkerData {
  readonly __causorynBootstrap?: unknown;
  readonly __workerEntryUrl?: unknown;
}

function shouldAutoStartDirectWorker(): boolean {
  if (isMainThread || parentPort === null || !isWorkerTaskPayload(workerData)) {
    return false;
  }
  const raw = workerData as IndexWorkerTaskInput & DirectBootstrapWorkerData;
  if (raw.__causorynBootstrap === true) {
    return (
      typeof raw.__workerEntryUrl === "string" &&
      isSameFileUrl(raw.__workerEntryUrl, import.meta.url)
    );
  }
  return import.meta.url.endsWith("/index-worker.js");
}

if (shouldAutoStartDirectWorker()) {
  const port = parentPort;
  queueMicrotask(() => {
    if (hasIndexWorkerStarted() || port === null) return;
    void (async () => {
      try {
        const SqliteRepoCtor = await loadDefaultSqliteRepositoryCtor();
        startIndexWorker(SqliteRepoCtor);
      } catch (error) {
        if (hasIndexWorkerStarted()) return;
        markIndexWorkerStarted();
        const code = error instanceof IndexingError ? error.code : "indexing/internal";
        const message = error instanceof Error ? error.message : String(error);
        const errorMsg: IndexWorkerMessage = { type: "error", code, message };
        port.postMessage(errorMsg);
      }
    })();
  });
}
