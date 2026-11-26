import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { IndexingError } from "../src/errors.js";
import {
  InventoryAnalysisWorkerError,
  runInventoryAnalysisInWorker,
  type InventoryAnalysisWorkerInput,
} from "../src/index-worker-analysis.js";

/**
 * runInventoryAnalysisInWorker (the index worker's inventory analysis mode,
 * main-thread side): a worker that answered is reused for the next run with
 * the same entry and heap limit, it sees the current process environment,
 * an analysis error keeps it usable, and an aborted run terminates it.
 * The worker entries here are small protocol stubs written per test.
 */

const ENV_NAME = "CAUSORYN_TEST_ANALYSIS_WORKER_ENV";

const cleanups: Array<() => void> = [];
afterEach(() => {
  delete process.env[ENV_NAME];
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

/**
 * A stub analysis worker: appends a line to `starts` when it loads; answers
 * `analyze` requests with an empty content set whose fingerprint carries
 * the environment variable, or with an error when the root is "fail".
 */
function stubWorker(): { readonly entry: string; readonly starts: () => number } {
  const dir = makeTempDir("causoryn-analysis-worker-stub-");
  const starts = path.join(dir, "starts.log");
  writeFileSync(starts, "", "utf8");
  const entry = path.join(dir, "stub-worker.mjs");
  writeFileSync(
    entry,
    [
      'import { appendFileSync } from "node:fs";',
      'import { parentPort } from "node:worker_threads";',
      `appendFileSync(${JSON.stringify(starts)}, "start\\n");`,
      'parentPort.on("message", (request) => {',
      '  if (request.task.rootPath === "fail") {',
      '    parentPort.postMessage({ type: "error", taskId: request.taskId, code: "indexing/limit-exceeded", message: "stub limit" });',
      "    return;",
      "  }",
      '  if (request.task.rootPath === "hang") return;',
      '  if (request.task.rootPath === "late-crash") {',
      '    parentPort.postMessage({ type: "analysis-done", taskId: request.taskId, result: { contentSetJson: "{}", state: "ready", analyzerFingerprint: "late", fileCount: 0, warningCount: 0 } });',
      '    throw new Error("stub crash after its answer");',
      "  }",
      '  parentPort.postMessage({ type: "progress", taskId: request.taskId, phase: "analyzing", completed: 0, total: 1, message: "stub" });',
      "  parentPort.postMessage({",
      '    type: "analysis-done",',
      "    taskId: request.taskId,",
      `    result: { contentSetJson: "{\\"nodes\\":[],\\"edges\\":[]}", state: "ready", analyzerFingerprint: String(process.env[${JSON.stringify(ENV_NAME)}]), fileCount: 0, warningCount: 0 },`,
      "  });",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    entry,
    starts: () => readFileSync(starts, "utf8").split("\n").filter((line) => line === "start").length,
  };
}

function input(rootPath: string): InventoryAnalysisWorkerInput {
  return {
    workspaceId: "stub",
    rootPath,
    policyConfig: WorkspaceAccessPolicy.create({ allowRoots: [] }).config,
    limits: { maxFiles: 10 },
    entries: [],
    fixedClockIso: "2026-01-01T00:00:00.000Z",
  };
}

describe("runInventoryAnalysisInWorker", () => {
  it("reuses the worker that answered for the next run, which sees the current environment", async () => {
    const stub = stubWorker();
    const progress: string[] = [];
    process.env[ENV_NAME] = "first";
    const first = await runInventoryAnalysisInWorker(input("ok"), {
      maxHeapMb: 64,
      workerEntryPath: stub.entry,
      onProgress: (event) => progress.push(event.message),
    });
    expect(first.analyzerFingerprint).toBe("first");
    expect(progress).toEqual(["stub"]);

    process.env[ENV_NAME] = "second";
    const second = await runInventoryAnalysisInWorker(input("ok"), { maxHeapMb: 64, workerEntryPath: stub.entry });
    expect(second.analyzerFingerprint).toBe("second");
    expect(stub.starts()).toBe(1);

    // Another heap limit is another worker.
    await runInventoryAnalysisInWorker(input("ok"), { maxHeapMb: 72, workerEntryPath: stub.entry });
    expect(stub.starts()).toBe(2);
  });

  it("an analysis error inside the worker is an IndexingError and keeps the worker usable", async () => {
    const stub = stubWorker();
    await expect(
      runInventoryAnalysisInWorker(input("fail"), { maxHeapMb: 64, workerEntryPath: stub.entry }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof IndexingError && error.code === "indexing/limit-exceeded" && error.message === "stub limit",
    );
    const after = await runInventoryAnalysisInWorker(input("ok"), { maxHeapMb: 64, workerEntryPath: stub.entry });
    expect(after.state).toBe("ready");
    expect(stub.starts()).toBe(1);
  });

  it("an aborted run terminates its worker and rejects with the abort reason; the next run starts a new worker", async () => {
    const stub = stubWorker();
    await runInventoryAnalysisInWorker(input("ok"), { maxHeapMb: 64, workerEntryPath: stub.entry });
    const controller = new AbortController();
    const reason = new Error("stub deadline");
    const pending = runInventoryAnalysisInWorker(input("hang"), {
      maxHeapMb: 64,
      workerEntryPath: stub.entry,
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await runInventoryAnalysisInWorker(input("ok"), { maxHeapMb: 64, workerEntryPath: stub.entry });
    expect(stub.starts()).toBe(2);
  });

  it("an idle worker that crashes after its answer does not throw on the calling thread", async () => {
    const stub = stubWorker();
    const result = await runInventoryAnalysisInWorker(input("late-crash"), { maxHeapMb: 64, workerEntryPath: stub.entry });
    expect(result.analyzerFingerprint).toBe("late");
    // Give the worker's error event time to arrive: without a listener it
    // would be an uncaught exception of this thread (an unhandled error here).
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  it("a missing worker entry is unavailable", async () => {
    const dir = makeTempDir("causoryn-analysis-worker-missing-");
    await expect(
      runInventoryAnalysisInWorker(input("ok"), { maxHeapMb: 64, workerEntryPath: path.join(dir, "missing.mjs") }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof InventoryAnalysisWorkerError && error.failure === "unavailable",
    );
  });
});
