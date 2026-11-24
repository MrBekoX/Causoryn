import { startIndexWorker } from "@causoryn/indexing";
import { SqliteGraphRepository } from "@causoryn/storage-sqlite";

/**
 * Bundled off-thread indexing worker entrypoint.
 * Statically binds `SqliteGraphRepository` so `esbuild` bundles the SQLite
 * storage layer into `dist/index-worker.mjs` with zero dynamic specifier
 * imports at runtime (only native `better-sqlite3` remains external).
 */
startIndexWorker(SqliteGraphRepository);
