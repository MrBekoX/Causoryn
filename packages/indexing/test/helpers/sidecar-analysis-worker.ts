import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parentPort } from "node:worker_threads";

import type { InventoryAnalysisResult, InventoryAnalysisTask } from "../../src/index-worker-core.js";
import { serveInventoryAnalysisRequests } from "../../src/index-worker-serve.js";
import {
  ANSWERING_SIDECAR,
  CHILD_ENV,
  FAKE_GRANDCHILD,
  FAKE_SIDECAR,
  never,
  startSidecar,
  whenExists,
} from "./fake-sidecar.js";

/**
 * Inventory analysis worker entry for the sidecar tests: the real request
 * loop of the index worker's inventory analysis mode
 * (serveInventoryAnalysisRequests) with an analysis that starts a fake
 * sidecar through the shared IPC core (runLineJsonWorker, so the sidecar is
 * in the thread's sidecar registry like a real adapter's). `task.workspaceId`
 * picks the behavior, `task.rootPath` is a directory the fake sidecars write
 * their pid files to:
 * - answer: the sidecar answers and exits; the analysis succeeds.
 * - hang: the sidecar runs until killed; the analysis never ends (the worker stays responsive).
 * - busy: the sidecar runs; the worker then spins synchronously (it never reads a message again).
 * - crash / oom: the sidecar runs; the worker then crashes / exhausts its heap.
 * - tree: the sidecar starts a grandchild (like `go run`); the worker then crashes.
 * - blocked: no sidecar; the worker blocks in a long synchronous child process call (spawnSync).
 * Every start of the worker appends a line to CAUSORYN_TEST_SIDECAR_WORKER_STARTS when set.
 */

const startsLog = process.env["CAUSORYN_TEST_SIDECAR_WORKER_STARTS"];
if (startsLog !== undefined && startsLog.length > 0) appendFileSync(startsLog, "start\n", "utf8");

const RESULT: InventoryAnalysisResult = {
  contentSetJson: '{"nodes":[],"edges":[]}',
  state: "ready",
  analyzerFingerprint: "sidecar-stub",
  fileCount: 0,
  warningCount: 0,
};

async function analyze(task: InventoryAnalysisTask): Promise<InventoryAnalysisResult> {
  const pidFile = path.join(task.rootPath, "sidecar.pid");
  switch (task.workspaceId) {
    case "answer":
      await startSidecar(ANSWERING_SIDECAR, pidFile);
      return RESULT;
    case "hang":
      void startSidecar(FAKE_SIDECAR, pidFile);
      return never();
    case "busy":
      void startSidecar(FAKE_SIDECAR, pidFile);
      await whenExists(pidFile);
      for (;;) {
        // Spins without ever yielding, like a long synchronous analyzer phase.
      }
    case "crash":
    case "tree":
      void (task.workspaceId === "tree"
        ? startSidecar(FAKE_SIDECAR, pidFile, FAKE_GRANDCHILD)
        : startSidecar(FAKE_SIDECAR, pidFile));
      await whenExists(task.workspaceId === "tree" ? `${pidFile}.grandchild` : pidFile);
      setTimeout(() => {
        throw new Error("injected analysis worker crash after starting a sidecar");
      }, 0);
      return never();
    case "oom": {
      void startSidecar(FAKE_SIDECAR, pidFile);
      await whenExists(pidFile);
      const keep: number[][] = [];
      for (;;) keep.push(new Array<number>(100_000).fill(Math.random()));
    }
    case "blocked":
      writeFileSync(path.join(task.rootPath, "blocked"), "", "utf8");
      spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 8000);"], { stdio: "ignore", env: CHILD_ENV });
      return RESULT;
    default:
      throw new Error(`unknown sidecar stub mode ${task.workspaceId}`);
  }
}

if (parentPort !== null) serveInventoryAnalysisRequests(parentPort, analyze);
