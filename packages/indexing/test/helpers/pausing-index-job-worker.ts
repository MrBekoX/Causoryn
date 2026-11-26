import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import { SqliteGraphRepository } from "@causoryn/storage-sqlite";

import { runIndexWorkerTask, type IndexWorkerTaskInput } from "../../src/index-worker-core.js";
import { serveIndexJob } from "../../src/index-worker-serve.js";

/**
 * Index job worker entry for the cancellation tests: the real job protocol
 * (serveIndexJob) running the real index job (runIndexWorkerTask: IndexService
 * over SQLite), with one injected hook. When the job reports the progress phase
 * named in `payload.changeSet[0]` (JSON `{ pauseAt, controlDir }`; a full run
 * ignores its change set) the thread blocks SYNCHRONOUSLY, without ever
 * returning to its event loop: like a job inside its last synchronous segment
 * (graph build, file facts, publish) it cannot read a `cancel` message. It
 * writes `paused` into controlDir and continues once the test writes `resume`
 * there.
 */

interface PauseControl {
  readonly pauseAt: string;
  readonly controlDir: string;
}

const payload = workerData as IndexWorkerTaskInput;
const control = JSON.parse(payload.changeSet[0] ?? "{}") as PauseControl;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let paused = false;

function pauseSynchronously(): void {
  writeFileSync(path.join(control.controlDir, "paused"), "", "utf8");
  while (!existsSync(path.join(control.controlDir, "resume"))) {
    Atomics.wait(sleeper, 0, 0, 20);
  }
}

if (parentPort !== null) {
  serveIndexJob(parentPort, payload, (job, hooks) =>
    runIndexWorkerTask(
      job,
      (event) => {
        hooks.onProgress(event);
        if (!paused && event.phase === control.pauseAt) {
          paused = true;
          pauseSynchronously();
        }
      },
      SqliteGraphRepository,
      hooks.onLeaseEvent,
      hooks.signal,
    ),
  );
}
