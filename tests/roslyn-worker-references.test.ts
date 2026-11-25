/**
 * Roslyn worker reference loading: per-file isolation of metadata loading,
 * non-regular / empty DLL entries, DOTNET_ROOT validation and linked
 * ancestors of request referenceDirs.
 *
 * Processes are started with spawn/spawnSync, a literal executable and an
 * argument array (shell: false); request content travels on stdin only.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildRoslynWorkerBinary } from "./roslyn-worker-build.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DLL = join(REPO_ROOT, "native", "roslyn-worker", "bin", "Debug", "net10.0", "Causoryn.RoslynWorker.dll");

interface WorkerResponse {
  id: unknown;
  status: string;
  warnings?: string[];
  edges?: Array<{ kind: string; from: { qualifiedName: string }; to: { qualifiedName: string }; resolution: string }>;
  error?: { code: string; message: string };
}

const dotnetAvailable = spawnSync("dotnet", ["--version"], { encoding: "utf8", shell: false }).status === 0;
if (!dotnetAvailable) {
  console.error("[roslyn-worker-references] dotnet SDK not found: reference loading tests were not run (reported as not executed)");
} else {
  const build = buildRoslynWorkerBinary();
  if (build.status !== 0 || !existsSync(WORKER_DLL)) {
    throw new Error(
      `worker build failed (exit=${String(build.status)}); tests are not run against a stale binary` +
        (build.stdout ? ` [stdout]: ${build.stdout.slice(-400)}` : ""),
    );
  }
}

function runWorker(
  request: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>> = process.env,
  timeoutMs = 120_000,
): { response: WorkerResponse | undefined; timedOut: boolean } {
  const result = spawnSync("dotnet", ["exec", WORKER_DLL], {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    env: { ...env },
    timeout: timeoutMs,
  });
  const line = (typeof result.stdout === "string" ? result.stdout : "")
    .split("\n")
    .find((candidate) => candidate.trim().length > 0);
  return {
    response: line === undefined ? undefined : (JSON.parse(line) as WorkerResponse),
    timedOut: result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT",
  };
}

const CLIENT_SOURCE = [
  "namespace Consumer;",
  "public class Client : Causoryn.RoslynWorker.WorkerInfo",
  "{",
  "}",
  "",
].join("\n");

function analyzeRequest(id: string, referenceDirs?: string[]): Record<string, unknown> {
  return {
    id,
    type: "analyze",
    protocolVersion: "1",
    files: [{ path: "Client.cs", content: CLIENT_SOURCE }],
    ...(referenceDirs === undefined ? {} : { referenceDirs }),
  };
}

function inheritsResolution(response: WorkerResponse | undefined): string | undefined {
  return response?.edges?.find(
    (edge) =>
      edge.kind === "INHERITS" &&
      edge.from.qualifiedName === "Consumer.Client" &&
      edge.to.qualifiedName === "Causoryn.RoslynWorker.WorkerInfo",
  )?.resolution;
}

/** Holds an exclusive (no sharing) handle on `path` in a separate Windows process. */
async function lockExclusively(path: string): Promise<ChildProcess> {
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$f = [System.IO.File]::Open($env:CAUSORYN_LOCK_PATH, 'Open', 'Read', 'None'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Seconds 300",
    ],
    { shell: false, env: { ...process.env, CAUSORYN_LOCK_PATH: path }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  await new Promise<void>((resolveLock, rejectLock) => {
    const timer = setTimeout(() => rejectLock(new Error("exclusive lock was not acquired in time")), 60_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("locked")) {
        clearTimeout(timer);
        resolveLock();
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      rejectLock(new Error("lock process exited early"));
    });
  });
  return child;
}

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

describe.skipIf(!dotnetAvailable)("roslyn worker reference loading", () => {
  it(
    "a reference DLL that cannot be opened is skipped with a warning and the analysis still completes",
    async () => {
      const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
      if (isRoot) return; // permissions do not stop root

      const fakeDotnet = tempDir("causoryn-fake-dotnet-");
      const refDir = join(fakeDotnet, "packs", "Microsoft.NETCore.App.Ref", "10.0.0", "ref", "net10.0");
      mkdirSync(refDir, { recursive: true });
      copyFileSync(WORKER_DLL, join(refDir, "Good.dll"));
      const unreadable = join(refDir, "Unreadable.dll");
      copyFileSync(WORKER_DLL, unreadable);

      let locker: ChildProcess | undefined;
      try {
        if (process.platform === "win32") {
          locker = await lockExclusively(unreadable);
          // The lock is held: a normal open fails now.
          expect(() => closeSync(openSync(unreadable, "r"))).toThrow();
        } else {
          chmodSync(unreadable, 0o000);
        }
        const { response } = runWorker(analyzeRequest("unreadable-ref"), { ...process.env, DOTNET_ROOT: fakeDotnet });
        expect(response?.status).not.toBe("error");
        expect(response?.error).toBeUndefined();
        expect(
          (response?.warnings ?? []).some(
            (warning) => warning.includes("Unreadable.dll") && warning.includes("could not be loaded"),
          ),
        ).toBe(true);
      } finally {
        locker?.kill();
        if (process.platform !== "win32") chmodSync(unreadable, 0o600);
        if (locker !== undefined) {
          await new Promise((settle) => setTimeout(settle, 500));
        }
      }
    },
    180_000,
  );

  it(
    "empty and non-regular .dll entries of a referenceDir are skipped without blocking the worker",
    () => {
      const refs = tempDir("causoryn-refs-");
      copyFileSync(WORKER_DLL, join(refs, "Causoryn.RoslynWorker.dll"));
      writeFileSync(join(refs, "Empty.dll"), "");
      if (process.platform !== "win32") {
        spawnSync("mkfifo", [join(refs, "Fifo.dll")], { shell: false });
      }
      const { response, timedOut } = runWorker(analyzeRequest("fifo-ref", [refs]), process.env, 60_000);
      expect(timedOut).toBe(false);
      expect(response?.status).not.toBe("error");
      expect(inheritsResolution(response)).toBe("verified");
    },
    120_000,
  );

  it(
    "a referenceDir below an ancestor link to a remote path is rejected; a local ancestor link is followed",
    () => {
      const base = tempDir("causoryn-ref-link-");
      const realRefs = join(base, "real", "refs");
      mkdirSync(realRefs, { recursive: true });
      copyFileSync(WORKER_DLL, join(realRefs, "Causoryn.RoslynWorker.dll"));

      let localLink = false;
      try {
        symlinkSync(join(base, "real"), join(base, "local-link"), process.platform === "win32" ? "junction" : "dir");
        localLink = true;
      } catch {
        // link creation needs privileges in some sandboxes
      }
      if (localLink) {
        const local = runWorker(analyzeRequest("ancestor-local", [join(base, "local-link", "refs")]));
        expect(inheritsResolution(local.response)).toBe("verified");
      }

      let remoteLink = false;
      try {
        // POSIX keeps the target text as written; Windows needs the symlink privilege.
        symlinkSync(
          process.platform === "win32" ? "\\\\unc-host.invalid\\share" : "//unc-host.invalid/share",
          join(base, "remote-link"),
          "dir",
        );
        remoteLink = true;
      } catch {
        // no symlink privilege: the lexical rule is covered by the DOTNET_ROOT test
      }
      if (remoteLink) {
        const remote = runWorker(analyzeRequest("ancestor-remote", [join(base, "remote-link", "refs")]));
        expect(remote.response?.status).not.toBe("error");
        expect(
          (remote.response?.warnings ?? []).some((warning) =>
            warning.includes("an ancestor directory links to a remote or device path"),
          ),
        ).toBe(true);
      }
    },
    180_000,
  );

  it(
    "a relative or UNC DOTNET_ROOT is ignored before any file system access",
    () => {
      for (const dotnetRoot of ["relative-dotnet-root", "\\\\unc-host.invalid\\share\\dotnet", "//unc-host.invalid/share/dotnet"]) {
        const { response } = runWorker(analyzeRequest(`dotnet-root-${dotnetRoot.length}`), {
          ...process.env,
          DOTNET_ROOT: dotnetRoot,
        });
        expect(response?.status).not.toBe("error");
        expect(
          (response?.warnings ?? []).some((warning) =>
            warning.includes("DOTNET_ROOT is not a fully qualified local path and was ignored"),
          ),
        ).toBe(true);
      }
    },
    240_000,
  );
});
