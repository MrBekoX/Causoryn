import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * IndexService without a configured Python command hands the adapter its
 * default (python3, then python on POSIX; python on win32), and a configured
 * command reaches the adapter unchanged. The worker spawn is captured, so the
 * fake executables on PATH are never started.
 */

const received: Array<string | undefined> = [];
const started: string[] = [];

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const record = child as unknown as Record<string, unknown>;
  record["stdout"] = new EventEmitter();
  record["stderr"] = new EventEmitter();
  record["stdin"] = Object.assign(new EventEmitter(), { write: () => true, end: () => {} });
  record["killed"] = false;
  record["exitCode"] = null;
  record["signalCode"] = null;
  record["kill"] = () => true;
  queueMicrotask(() => child.emit("exit", 1, null));
  return child;
}

vi.mock("@causoryn/adapter-python", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@causoryn/adapter-python")>();
  return {
    ...actual,
    analyzePythonWorkspace: async (input: Parameters<typeof actual.analyzePythonWorkspace>[0]) => {
      received.push(input.options?.pythonCommand);
      return actual.analyzePythonWorkspace({
        ...input,
        options: {
          ...input.options,
          spawnProcess: (command) => {
            started.push(command);
            return fakeChild();
          },
        },
      });
    },
  };
});

import { DEFAULT_PYTHON_COMMAND } from "@causoryn/adapter-python";
import { InMemoryGraphRepository } from "@causoryn/graph";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { IndexService } from "../packages/indexing/src/index.js";

const IS_WIN = process.platform === "win32";
const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

function fakeExecutable(dir: string, name: string): string {
  const file = path.join(dir, IS_WIN ? `${name}.exe` : name);
  writeFileSync(file, IS_WIN ? "not a real executable" : "#!/bin/sh\nexit 1\n", "utf8");
  if (!IS_WIN) chmodSync(file, 0o755);
  return file;
}

async function indexWithPath(
  binDir: string,
  python: { readonly pythonCommand?: string } | undefined,
): Promise<{ readonly received: string | undefined; readonly started: string | undefined }> {
  received.length = 0;
  started.length = 0;
  const root = tempDir("causoryn-pycmd-ws-");
  writeFileSync(path.join(root, "app.py"), "def main():\n    return 1\n", "utf8");
  const service = new IndexService({
    workspaceId: "pycmd",
    policy: WorkspaceAccessPolicy.create({ allowRoots: [root] }),
    repository: new InMemoryGraphRepository(),
    clock: () => "2026-11-24T00:00:00.000Z",
    limits: { maxFiles: 100 },
    ...(python !== undefined ? { python } : {}),
  });
  const saved = process.env["PATH"];
  process.env["PATH"] = binDir;
  try {
    await service.runIndexAsync(root);
  } finally {
    if (saved === undefined) delete process.env["PATH"];
    else process.env["PATH"] = saved;
  }
  expect(received).toHaveLength(1);
  return { received: received[0], started: started[0] };
}

describe("IndexService default Python command", () => {
  it("passes the adapter default when nothing is configured and an explicit command as-is", async () => {
    const bin = tempDir("causoryn-pycmd-bin-");
    const python3 = fakeExecutable(bin, "python3");
    const python = fakeExecutable(bin, "python");

    const byDefault = await indexWithPath(bin, undefined);
    expect(byDefault.received).toBe(DEFAULT_PYTHON_COMMAND);
    expect(byDefault.started).toBe(IS_WIN ? python : python3);

    const explicit = await indexWithPath(bin, { pythonCommand: "python" });
    expect(explicit.received).toBe("python");
    expect(explicit.started).toBe(python);
  }, 120_000);
});
