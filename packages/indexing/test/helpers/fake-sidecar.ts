import { existsSync } from "node:fs";

import { buildAllowlistedWorkerEnv, runLineJsonWorker } from "@causoryn/sidecar-ipc";

/**
 * Fake sidecar processes for the worker sidecar tests: long-running Node
 * processes started through the shared IPC core (runLineJsonWorker), so they
 * are in the starting thread's sidecar registry like a real adapter's.
 * Shared by helpers/sidecar-analysis-worker.ts and
 * helpers/sidecar-index-job-worker.ts (no side effects on import).
 */

/** Records its pid (written atomically enough for the test: one small write), optionally starts a grandchild, then runs. */
export const FAKE_SIDECAR = [
  'const fs = require("node:fs");',
  "const [pidFile, grandchildCode] = process.argv.slice(1);",
  "fs.writeFileSync(pidFile, String(process.pid));",
  "if (grandchildCode) {",
  '  require("node:child_process").spawn(process.execPath, ["-e", grandchildCode, pidFile + ".grandchild"], { stdio: "ignore" });',
  "}",
  "setInterval(() => {}, 1000);",
].join("\n");
export const FAKE_GRANDCHILD = [
  'const fs = require("node:fs");',
  "fs.writeFileSync(process.argv[1], String(process.pid));",
  "setInterval(() => {}, 1000);",
].join("\n");
export const ANSWERING_SIDECAR = [
  'require("node:fs").writeFileSync(process.argv[1], String(process.pid));',
  'process.stdout.write(JSON.stringify({ ok: true }) + "\\n");',
].join("\n");

export const CHILD_ENV = buildAllowlistedWorkerEnv(["SystemRoot", "PATH", "TEMP", "TMP"]);

export function startSidecar(script: string, pidFile: string, ...extra: string[]): Promise<unknown> {
  return runLineJsonWorker({
    command: process.execPath,
    args: ["-e", script, pidFile, ...extra],
    env: CHILD_ENV,
    requestPayload: { id: "fake-sidecar" },
    requestTimeoutMs: 600_000,
  });
}

export async function whenExists(file: string): Promise<void> {
  while (!existsSync(file)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function never(): Promise<never> {
  return new Promise<never>(() => {});
}
