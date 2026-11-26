import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAllowlistedWorkerEnv,
  onSidecarProcessEvent,
  resolveWindowsSystemExecutable,
  runLineJsonWorker,
  runningSidecarProcessIds,
  terminateSidecarProcesses,
  type SidecarProcessEvent,
} from "@causoryn/sidecar-ipc";
import { runCargoBuild } from "../adapters/rust/src/cargo.js";

/**
 * Registry of the running sidecar processes of a thread (@causoryn/sidecar-ipc):
 * every child the shared IPC core (runLineJsonWorker) or the Rust adapter's
 * cargo build starts is recorded with the tree-kill hook its runner uses, the
 * thread's listeners learn its pid when it starts and when it exits, and
 * terminateSidecarProcesses stops all of them with their own hooks. The index
 * worker's inventory analysis mode uses it to stop its sidecars when an
 * analysis is cancelled and to tell the main thread which pids to kill when
 * the worker itself is gone.
 */

const IS_WIN = process.platform === "win32";
const CHILD_ENV = buildAllowlistedWorkerEnv(["SystemRoot", "PATH", "TEMP", "TMP"]);
/** Never answers and never exits on its own. */
const LONG_RUNNING = "setInterval(() => {}, 1000);";
/** Answers one line and exits. */
const ANSWERING = 'process.stdout.write(JSON.stringify({ ok: true }) + "\\n");';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function recordEvents(): SidecarProcessEvent[] {
  const events: SidecarProcessEvent[] = [];
  const unsubscribe = onSidecarProcessEvent((event) => events.push(event));
  cleanups.push(unsubscribe);
  return events;
}

function killQuietly(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
}

async function spawnedPid(events: readonly SidecarProcessEvent[]): Promise<number> {
  let pid: number | undefined;
  await vi.waitFor(
    () => {
      pid = events.find((event) => event.type === "spawned")?.pid;
      expect(pid).toBeDefined();
    },
    { timeout: 10_000 },
  );
  cleanups.push(() => killQuietly(pid));
  return pid as number;
}

describe("sidecar process registry", () => {
  it("records a sidecar started by runLineJsonWorker and reports its exit", async () => {
    const events = recordEvents();
    let runningAtStart: readonly number[] = [];
    const unsubscribe = onSidecarProcessEvent((event) => {
      if (event.type === "spawned") runningAtStart = runningSidecarProcessIds();
    });
    cleanups.push(unsubscribe);

    const outcome = await runLineJsonWorker({
      command: process.execPath,
      args: ["-e", ANSWERING],
      env: CHILD_ENV,
      requestPayload: { id: "registry-answer" },
      requestTimeoutMs: 30_000,
    });
    expect(outcome.status).toBe("ok");
    const pid = await spawnedPid(events);
    expect(runningAtStart).toContain(pid);
    await vi.waitFor(() => {
      expect(events).toContainEqual({ type: "exited", pid });
    });
    expect(runningSidecarProcessIds()).not.toContain(pid);
  });

  it("terminateSidecarProcesses stops a running sidecar with its runner's tree-kill hook and resolves once it exited", async () => {
    const events = recordEvents();
    const hookCalls: Array<number | undefined> = [];
    const outcome = runLineJsonWorker({
      command: process.execPath,
      args: ["-e", LONG_RUNNING],
      env: CHILD_ENV,
      requestPayload: { id: "registry-terminate" },
      requestTimeoutMs: 120_000,
      onKillChild: (child: ChildProcess) => {
        hookCalls.push(child.pid);
      },
    });
    const pid = await spawnedPid(events);
    expect(runningSidecarProcessIds()).toContain(pid);

    await terminateSidecarProcesses(10_000);
    expect(hookCalls).toEqual([pid]);
    expect(events).toContainEqual({ type: "exited", pid });
    expect(runningSidecarProcessIds()).not.toContain(pid);
    // The runner sees its worker gone (the next request uses a fresh process).
    expect((await outcome).status).toBe("unavailable");
  });

  it("keeps a sidecar recorded after its runner gave up on it until the process has really exited", async () => {
    const events = recordEvents();
    let releaseHook!: () => void;
    const hookDone = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const outcome = await runLineJsonWorker({
      command: process.execPath,
      args: ["-e", LONG_RUNNING],
      env: CHILD_ENV,
      requestPayload: { id: "registry-timeout" },
      requestTimeoutMs: 300,
      // The direct kill follows only once this "tree kill" has settled.
      onKillChild: () => hookDone,
    });
    expect(outcome.status).toBe("timeout");
    const pid = await spawnedPid(events);
    // The runner removed its listeners; the process still runs and is still recorded.
    expect(runningSidecarProcessIds()).toContain(pid);
    expect(events).not.toContainEqual({ type: "exited", pid });

    releaseHook();
    await vi.waitFor(
      () => {
        expect(events).toContainEqual({ type: "exited", pid });
      },
      { timeout: 10_000 },
    );
    expect(runningSidecarProcessIds()).not.toContain(pid);
  });

  it("records the cargo build process with its tree-kill hook (taskkill /T on Windows)", async () => {
    const crate = realpathSync(mkdtempSync(path.join(os.tmpdir(), "causoryn-registry-crate-")));
    cleanups.push(() => rmSync(crate, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const manifestPath = path.join(crate, "Cargo.toml");
    writeFileSync(manifestPath, '[package]\nname = "fixture"\nversion = "0.0.0"\n', "utf8");
    const taskkill = IS_WIN ? resolveWindowsSystemExecutable("taskkill.exe") : undefined;
    const started: string[] = [];
    const events = recordEvents();

    const build = runCargoBuild({
      manifestPath,
      targetDir: path.join(crate, "target"),
      timeoutMs: 120_000,
      cargoExecutable: process.execPath,
      spawnFn: (command, args, options) => {
        started.push(command === taskkill ? "taskkill" : "cargo");
        // The "cargo" process is a long-running stand-in; taskkill is the real one.
        return command === taskkill
          ? spawn(command, [...args], options)
          : spawn(process.execPath, ["-e", LONG_RUNNING], options);
      },
    });
    const pid = await spawnedPid(events);
    expect(runningSidecarProcessIds()).toContain(pid);

    await terminateSidecarProcesses(10_000);
    expect(started).toEqual(IS_WIN ? ["cargo", "taskkill"] : ["cargo"]);
    expect(events).toContainEqual({ type: "exited", pid });
    expect(runningSidecarProcessIds()).not.toContain(pid);
    expect((await build).status).not.toBe(0);
  });
});
