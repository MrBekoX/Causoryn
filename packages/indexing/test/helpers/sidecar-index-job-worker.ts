import { writeFileSync } from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { runningSidecarProcessIds } from "@causoryn/sidecar-ipc";

import type { IndexWorkerResultSummary, IndexWorkerTaskInput } from "../../src/index-worker-core.js";
import { serveIndexJob, type IndexJobHooks } from "../../src/index-worker-serve.js";
import { ANSWERING_SIDECAR, FAKE_SIDECAR, never, startSidecar, whenExists } from "./fake-sidecar.js";

/**
 * Index job worker entry for the job manager sidecar tests: the real job
 * protocol of the index worker (serveIndexJob: progress / lease / done / error
 * messages, sidecar pid reports and the `cancel` request) with a stub job in
 * place of the IndexService run. The stub starts a fake sidecar through the
 * shared IPC core (so it is in the thread's sidecar registry like a real
 * adapter's). `payload.changeSet[0]` picks the behavior, `payload.rootPath` is
 * a directory the fake sidecars write their pid files to; when the job's
 * signal is aborted the stub writes `aborted` there.
 * - answer: the sidecar answers and exits; the job finishes.
 * - hang: the sidecar runs until killed; the job never ends (the worker stays responsive).
 * - busy: the sidecar runs; the worker then spins synchronously (it never reads a message again).
 * - crash: the sidecar runs; the worker then crashes.
 * - leak: the sidecar runs; the job finishes anyway and leaves it running.
 */

const SUMMARY: IndexWorkerResultSummary = {
  snapshotId: "snapshot:sidecar-stub",
  stale: false,
  fileCount: 0,
  tsFileCount: 0,
  csFileCount: 0,
  state: "ready",
  warnings: [],
  diagnostics: [],
  published: false,
  outcome: "unchanged",
};

async function whenNoSidecarRuns(): Promise<void> {
  while (runningSidecarProcessIds().length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function run(payload: IndexWorkerTaskInput, hooks: IndexJobHooks): Promise<IndexWorkerResultSummary> {
  const pidFile = path.join(payload.rootPath, "sidecar.pid");
  hooks.signal.addEventListener(
    "abort",
    () => {
      writeFileSync(path.join(payload.rootPath, "aborted"), "", "utf8");
    },
    { once: true },
  );
  const mode = payload.changeSet[0] ?? "";
  switch (mode) {
    case "answer":
      await startSidecar(ANSWERING_SIDECAR, pidFile);
      await whenNoSidecarRuns();
      return SUMMARY;
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
      void startSidecar(FAKE_SIDECAR, pidFile);
      await whenExists(pidFile);
      setTimeout(() => {
        throw new Error("injected index job worker crash after starting a sidecar");
      }, 0);
      return never();
    case "leak":
      void startSidecar(FAKE_SIDECAR, pidFile);
      await whenExists(pidFile);
      return SUMMARY;
    default:
      throw new Error(`unknown sidecar stub mode ${mode}`);
  }
}

if (parentPort !== null) serveIndexJob(parentPort, workerData as IndexWorkerTaskInput, run);
