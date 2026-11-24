import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  DEFAULT_PYTHON_COMMAND,
  PYTHON_COMMAND_CANDIDATES,
  analyzePythonWorkspace,
  defaultPythonCommandCandidates,
  resolvePythonWorkerCommand,
  runWorkerAnalyze,
} from "../adapters/python/src/index.js";
import {
  PYTHON_COMMAND_CANDIDATES as DOCTOR_PYTHON_COMMAND_CANDIDATES,
  runDoctor,
  type ToolchainProbeFn,
  type ToolchainProbeOutcome,
} from "../packages/causoryn/src/index.js";

/**
 * Default Python command: `causoryn doctor` and the Python adapter try the
 * same commands in the same order (POSIX: python3, then python; win32:
 * python). An explicitly configured command is used as-is.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_SCRIPT = path.join(REPO_ROOT, "native", "python-worker", "worker.py");
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

/** Writes a fake executable that is never started (spawn is injected); returns its absolute path. */
function fakeExecutable(dir: string, name: string): string {
  const file = path.join(dir, IS_WIN ? `${name}.exe` : name);
  writeFileSync(file, IS_WIN ? "not a real executable" : "#!/bin/sh\nexit 1\n", "utf8");
  if (!IS_WIN) chmodSync(file, 0o755);
  return file;
}

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
  queueMicrotask(() => {
    (record["stdout"] as EventEmitter).emit(
      "data",
      Buffer.from('{"id":"x","protocolVersion":"1","status":"ready"}\n', "utf8"),
    );
  });
  return child;
}

async function withPath<T>(pathValue: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env["PATH"];
  process.env["PATH"] = pathValue;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env["PATH"];
    else process.env["PATH"] = saved;
  }
}

/** Command the adapter would start for `pythonCommand` with PATH = `binDir` (spawn is captured). */
async function startedCommand(binDir: string, pythonCommand: string | undefined): Promise<string | null> {
  const started: string[] = [];
  const outcome = await withPath(binDir, () =>
    runWorkerAnalyze({
      ...(pythonCommand !== undefined ? { pythonCommand } : {}),
      workerScriptPath: WORKER_SCRIPT,
      requestPayload: { id: "x" },
      requestTimeoutMs: 5_000,
      spawnProcess: (command) => {
        started.push(command);
        return fakeChild();
      },
    }),
  );
  if (started.length === 0) {
    expect(outcome.status).toBe("unavailable");
    return null;
  }
  expect(started).toHaveLength(1);
  return started[0] ?? null;
}

describe("default Python command candidates (platform independent)", () => {
  it("POSIX tries python3 then python; win32 tries python only", () => {
    expect(PYTHON_COMMAND_CANDIDATES).toEqual({ posix: ["python3", "python"], win32: ["python"] });
    for (const platform of ["linux", "darwin", "freebsd"] as const) {
      expect(defaultPythonCommandCandidates(platform), platform).toEqual(["python3", "python"]);
    }
    expect(defaultPythonCommandCandidates("win32")).toEqual(["python"]);
    expect(defaultPythonCommandCandidates()).toEqual(
      IS_WIN ? ["python"] : ["python3", "python"],
    );
  });

  it("causoryn doctor pins exactly the adapter's candidate list", () => {
    expect(DOCTOR_PYTHON_COMMAND_CANDIDATES).toEqual(PYTHON_COMMAND_CANDIDATES);
  });

  it("the default command uses the first candidate found; an explicit command is resolved as-is", () => {
    const resolverFor = (found: Readonly<Record<string, string>>, calls: string[]) =>
      (command: string) => {
        calls.push(command);
        const hit = found[command];
        return hit !== undefined ? { command: hit } : { detail: `executable "${command}" was not found` };
      };
    const both = { python3: "/usr/bin/python3", python: "/usr/bin/python" };

    let calls: string[] = [];
    expect(resolvePythonWorkerCommand(DEFAULT_PYTHON_COMMAND, resolverFor(both, calls), "linux")).toEqual({
      command: "/usr/bin/python3",
    });
    expect(calls).toEqual(["python3"]);

    calls = [];
    expect(
      resolvePythonWorkerCommand(DEFAULT_PYTHON_COMMAND, resolverFor({ python: "/usr/bin/python" }, calls), "darwin"),
    ).toEqual({ command: "/usr/bin/python" });
    expect(calls).toEqual(["python3", "python"]);

    // Explicit commands are used as-is, without trying other candidates.
    calls = [];
    expect(resolvePythonWorkerCommand("python", resolverFor(both, calls), "linux")).toEqual({
      command: "/usr/bin/python",
    });
    expect(calls).toEqual(["python"]);
    calls = [];
    const explicitMissing = resolvePythonWorkerCommand("python3.13", resolverFor(both, calls), "linux");
    expect(explicitMissing).toEqual({ detail: 'executable "python3.13" was not found' });
    expect(calls).toEqual(["python3.13"]);

    // win32 keeps trying `python` only.
    calls = [];
    const win = resolvePythonWorkerCommand(
      DEFAULT_PYTHON_COMMAND,
      resolverFor({ python3: "C:\\Py\\python3.exe" }, calls),
      "win32",
    );
    expect(calls).toEqual(["python"]);
    expect("detail" in win && win.detail).toMatch(/python/);

    // Nothing found: the detail names every candidate that was tried.
    calls = [];
    const none = resolvePythonWorkerCommand(DEFAULT_PYTHON_COMMAND, resolverFor({}, calls), "linux");
    expect(calls).toEqual(["python3", "python"]);
    expect("detail" in none && none.detail).toMatch(
      /worker process was not started: none of the default Python commands \(python3, python\) was found on PATH outside the analyzed workspace/,
    );
  });

  it("causoryn doctor probes the same candidates in the same order and stops at the first command that exists", () => {
    const sandbox = tempDir("causoryn-doctor-pycmd-");
    const home = path.join(sandbox, "home");
    mkdirSync(home, { recursive: true });
    const notFound: ToolchainProbeOutcome = { available: false, version: null, detail: "ENOENT", failure: "not-found" };
    const ok = (output: string): ToolchainProbeOutcome => ({ available: true, version: output, detail: "ok", output });
    const doctor = (platform: NodeJS.Platform, python: Readonly<Record<string, ToolchainProbeOutcome>>) => {
      const seen: string[] = [];
      const probe: ToolchainProbeFn = (command) => {
        if (command === "python" || command === "python3") {
          seen.push(command);
          return python[command] ?? notFound;
        }
        return notFound;
      };
      const report = runDoctor({
        homeDir: home,
        codexHomeDir: path.join(home, ".codex"),
        packageRoot: path.join(sandbox, "pkg"),
        nodeVersion: "24.19.2",
        platform,
        probeToolchain: probe,
      });
      return { python: report.toolchains.python, seen };
    };

    // A python3-only POSIX host (stock Ubuntu / macOS): doctor and adapter both use python3.
    const py3Only = doctor("linux", { python3: ok("Python 3.12.3") });
    expect(py3Only.seen).toEqual(["python3"]);
    expect(py3Only.python.status).toBe("ok");
    expect(py3Only.python.version).toBe("3.12.3");
    expect(py3Only.python.detail).toContain("python3");

    // Only `python`: python3 is not found, so python is used.
    const pyOnly = doctor("darwin", { python: ok("Python 3.11.9") });
    expect(pyOnly.seen).toEqual(["python3", "python"]);
    expect(pyOnly.python.status).toBe("ok");
    expect(pyOnly.python.version).toBe("3.11.9");

    // python3 exists but is unusable: the adapter would start it, so doctor reports it
    // instead of falling back to a different interpreter.
    const brokenPy3 = doctor("linux", {
      python3: { available: false, version: null, detail: "pyenv: python3: command not found", failure: "exited" },
      python: ok("Python 3.12.4"),
    });
    expect(brokenPy3.seen).toEqual(["python3"]);
    expect(brokenPy3.python.status).toBe("absent");
    expect(brokenPy3.python.detail).toContain("`python3 --version`");

    const oldPy3 = doctor("linux", { python3: ok("Python 3.8.10"), python: ok("Python 3.12.4") });
    expect(oldPy3.seen).toEqual(["python3"]);
    expect(oldPy3.python.status).toBe("warn");

    // Neither exists: absent, and the detail names what was tried.
    const none = doctor("linux", {});
    expect(none.seen).toEqual(["python3", "python"]);
    expect(none.python.status).toBe("absent");
    expect(none.python.detail).toMatch(/Not found .*python3, python/);

    // win32 probes `python` only.
    const win = doctor("win32", { python3: ok("Python 3.12.4") });
    expect(win.seen).toEqual(["python"]);
    expect(win.python.status).toBe("absent");
  });
});

describe("Python adapter default command resolution with fake executables on PATH", () => {
  it.runIf(IS_WIN)("win32: the default starts python.exe even when python3.exe is first on PATH; an explicit python3 is used as-is", async () => {
    const first = tempDir("causoryn-pycmd-a-");
    const second = tempDir("causoryn-pycmd-b-");
    const python3 = fakeExecutable(first, "python3");
    const python = fakeExecutable(second, "python");
    const pathValue = [first, second].join(path.delimiter);
    expect(await startedCommand(pathValue, undefined)).toBe(python);
    expect(await startedCommand(pathValue, DEFAULT_PYTHON_COMMAND)).toBe(python);
    expect(await startedCommand(pathValue, "python3")).toBe(python3);
  });

  it.skipIf(IS_WIN)("POSIX: python3 wins over python, python is the fallback, an explicit python is used as-is", async () => {
    const both = tempDir("causoryn-pycmd-both-");
    const python3 = fakeExecutable(both, "python3");
    const python = fakeExecutable(both, "python");
    expect(await startedCommand(both, undefined)).toBe(python3);
    expect(await startedCommand(both, DEFAULT_PYTHON_COMMAND)).toBe(python3);
    expect(await startedCommand(both, "python")).toBe(python);

    const onlyPython = tempDir("causoryn-pycmd-py-");
    const lonePython = fakeExecutable(onlyPython, "python");
    expect(await startedCommand(onlyPython, undefined)).toBe(lonePython);

    const onlyPython3 = tempDir("causoryn-pycmd-py3-");
    const lonePython3 = fakeExecutable(onlyPython3, "python3");
    expect(await startedCommand(onlyPython3, undefined)).toBe(lonePython3);
    // An explicit command is not replaced by another candidate.
    expect(await startedCommand(onlyPython3, "python")).toBeNull();
  });

  it("with no candidate on PATH nothing is started and the warning names the commands that were tried", async () => {
    const empty = tempDir("causoryn-pycmd-empty-");
    expect(await startedCommand(empty, undefined)).toBeNull();
    const result = await withPath(empty, () =>
      analyzePythonWorkspace({
        workspaceId: "pycmd-none",
        files: [{ path: "app.py", content: "x = 1\n" }],
        options: { spawnProcess: () => fakeChild() },
      }),
    );
    expect(result.workerAvailable).toBe(false);
    const expected = defaultPythonCommandCandidates().join(", ");
    expect(result.warnings[0]).toContain(`none of the default Python commands (${expected}) was found`);
  });
});
