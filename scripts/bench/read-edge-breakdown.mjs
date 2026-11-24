#!/usr/bin/env node
/**
 * Child-process reader used by `real-repo-eval.mjs` for the CALLS edge
 * breakdown (`selfRepo.edgeBreakdown`).
 *
 * Opens Causoryn's own `graph.sqlite` (created by the server under test in
 * the benchmark's private temp data dir) read-only with the better-sqlite3
 * driver bundled inside the unpacked tarball (`dist/node_modules/better-sqlite3`),
 * counts the latest published snapshot via `calls-breakdown.mjs`, prints ONE
 * JSON object to stdout and exits.
 *
 * Why a separate process: a loaded native addon (`*.node`) stays locked on
 * Windows until its process exits, so loading the driver from the unpacked
 * tarball inside the benchmark process would block removing the temp
 * directory (EPERM). The benchmark spawns this script with `shell: false`.
 *
 * Usage: node scripts/bench/read-edge-breakdown.mjs <packageRoot> <graph.sqlite> [snapshotId]
 */
import { createRequire } from "node:module";
import path from "node:path";

import { computeEdgeBreakdown } from "./calls-breakdown.mjs";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [packageRoot, dbFile, snapshotId] = process.argv.slice(2);
if (typeof packageRoot !== "string" || packageRoot.length === 0 || typeof dbFile !== "string" || dbFile.length === 0) {
  fail("usage: read-edge-breakdown.mjs <packageRoot> <graph.sqlite> [snapshotId]");
}

let Database;
try {
  Database = createRequire(path.join(packageRoot, "dist", "mcp-server.mjs"))("better-sqlite3");
} catch (error) {
  fail(`could not load the tarball's bundled better-sqlite3 driver: ${error instanceof Error ? error.message : String(error)}`);
}

let db = null;
let json = null;
let failure = null;
try {
  db = new Database(dbFile, { readonly: true, fileMustExist: true });
  const breakdown = computeEdgeBreakdown(
    db,
    typeof snapshotId === "string" && snapshotId.length > 0 ? { snapshotId } : {},
  );
  json = JSON.stringify(breakdown);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  db?.close();
}
if (failure !== null) fail(failure);
process.stdout.write(`${json}\n`);
