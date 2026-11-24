/**
 * Absolute executable resolution (Windows cwd-first search hardening).
 *
 * The same suite runs against both copies of the resolver:
 * packages/sidecar-ipc/src/executable.ts and
 * packages/graph/src/executable-resolution.ts.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as graphCopy from "../packages/graph/src/executable-resolution.js";
import * as sidecarCopy from "../packages/sidecar-ipc/src/executable.js";

const IS_WIN = process.platform === "win32";

function exeName(name: string): string {
  return IS_WIN ? `${name}.exe` : name;
}

/** Writes a fake runnable file (win32: any .exe file; POSIX: mode 0755). */
function writeRunnable(file: string): void {
  writeFileSync(file, IS_WIN ? "MZ-fake" : "#!/bin/sh\nexit 0\n", "utf8");
  if (!IS_WIN) chmodSync(file, 0o755);
}

async function withEnvAndCwd<T>(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string | null,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const savedCwd = process.cwd();
  if (cwd !== null) process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(savedCwd);
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

for (const [label, impl] of [
  ["sidecar-ipc", sidecarCopy],
  ["graph copy", graphCopy],
] as const) {
  describe(`executable resolution (${label})`, () => {
    let tmp: string;
    let workspace: string;
    let trustedBin: string;
    let otherBin: string;

    beforeAll(() => {
      tmp = mkdtempSync(path.join(os.tmpdir(), "causoryn-exe-resolve-"));
      workspace = path.join(tmp, "analyzed-repo");
      trustedBin = path.join(tmp, "trusted-bin");
      otherBin = path.join(tmp, "other-bin");
      mkdirSync(path.join(workspace, "bin"), { recursive: true });
      mkdirSync(trustedBin, { recursive: true });
      mkdirSync(otherBin, { recursive: true });
      // Planted tools in the analyzed repository root and its bin/ folder.
      for (const tool of ["git", "taskkill", "cargo", "faketool"]) {
        writeRunnable(path.join(workspace, exeName(tool)));
        writeRunnable(path.join(workspace, "bin", exeName(tool)));
      }
      writeRunnable(path.join(trustedBin, exeName("faketool")));
    });

    afterAll(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it("never picks a tool planted in the cwd / workspace; relative, empty and in-workspace PATH entries are ignored", async () => {
      const pathValue = [
        "",
        ".",
        "bin",
        IS_WIN ? "C:bin" : "./bin",
        path.join(workspace, "bin"),
        workspace,
        trustedBin,
      ].join(path.delimiter);
      const resolved = await withEnvAndCwd(
        { NoDefaultCurrentDirectoryInExePath: undefined },
        workspace,
        () =>
          impl.resolveExecutable("faketool", {
            env: { PATH: pathValue },
            untrustedRoots: [workspace],
          }),
      );
      expect(resolved).toBe(path.join(trustedBin, exeName("faketool")));
    });

    it("returns null instead of falling back to the cwd when no trusted PATH entry has the tool", async () => {
      const resolved = await withEnvAndCwd(
        { NoDefaultCurrentDirectoryInExePath: undefined },
        workspace,
        () =>
          impl.resolveExecutable("git", {
            env: { PATH: ["", ".", workspace, path.join(workspace, "bin")].join(path.delimiter) },
            untrustedRoots: [workspace],
          }),
      );
      expect(resolved).toBeNull();
    });

    it("resolves the real git / cargo from the process PATH, never the planted copies, with cwd = workspace", async () => {
      await withEnvAndCwd({ NoDefaultCurrentDirectoryInExePath: undefined }, workspace, () => {
        const roots = impl.collectUntrustedRoots([workspace]);
        for (const tool of ["git", "cargo"]) {
          const resolved = impl.resolveExecutable(tool, { untrustedRoots: roots });
          if (resolved === null) continue; // tool not installed on this machine
          expect(path.isAbsolute(resolved)).toBe(true);
          expect(impl.isWithinUntrustedRoots(resolved, [workspace])).toBe(false);
        }
      });
    });

    it("collectUntrustedRoots adds the process cwd, but never a filesystem root or the home directory", async () => {
      await withEnvAndCwd({}, workspace, () => {
        const roots = impl.collectUntrustedRoots([]);
        expect(roots.map((r) => r.toLowerCase())).toContain(path.resolve(workspace).toLowerCase());
      });
      await withEnvAndCwd({}, os.homedir(), () => {
        expect(impl.processCwdUntrustedRoot()).toBeNull();
      });
      await withEnvAndCwd({}, path.parse(os.tmpdir()).root, () => {
        expect(impl.processCwdUntrustedRoot()).toBeNull();
      });
    });

    it("refuses relative or drive-relative commands and passes fully qualified commands through", () => {
      expect(impl.resolveExecutable("./git")).toBeNull();
      expect(impl.resolveExecutable("bin/git")).toBeNull();
      expect(impl.resolveExecutable("..")).toBeNull();
      expect(impl.resolveExecutable("")).toBeNull();
      expect(impl.resolveExecutable(" git")).toBeNull();
      expect(impl.resolveExecutable("C:git", { platform: "win32" })).toBeNull();
      expect(impl.resolveExecutable("bin\\git", { platform: "win32" })).toBeNull();
      expect(impl.resolveExecutable("\\\\server\\share\\git.exe", { platform: "win32" })).toBeNull();
      const absolute = path.join(trustedBin, exeName("faketool"));
      expect(impl.resolveExecutable(absolute)).toBe(absolute);
    });

    it("win32 candidates mirror libuv: name with extension as-is, then .com/.exe; .cmd/.bat are never used", () => {
      if (!IS_WIN) return;
      const dir = path.join(tmp, "win-ext");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "onlycmd.cmd"), "@echo off\r\n", "utf8");
      writeFileSync(path.join(dir, "onlybat.bat"), "@echo off\r\n", "utf8");
      writeFileSync(path.join(dir, "comtool.com"), "x", "utf8");
      writeFileSync(path.join(dir, "noext"), "x", "utf8");
      writeFileSync(path.join(dir, "v1.2"), "x", "utf8");
      const env = { Path: dir }; // case-insensitive PATH key on win32
      expect(impl.resolveExecutable("onlycmd", { env })).toBeNull();
      expect(impl.resolveExecutable("onlybat", { env })).toBeNull();
      expect(impl.resolveExecutable("comtool", { env })).toBe(path.join(dir, "comtool.com"));
      expect(impl.resolveExecutable("noext", { env })).toBeNull();
      expect(impl.resolveExecutable("v1.2", { env })).toBe(path.join(dir, "v1.2"));
    });

    it("POSIX candidates must be executable regular files", () => {
      if (IS_WIN) return;
      const dir = path.join(tmp, "posix-mode");
      mkdirSync(path.join(dir, "dirtool"), { recursive: true });
      writeFileSync(path.join(dir, "plain"), "#!/bin/sh\n", { encoding: "utf8", mode: 0o644 });
      writeRunnable(path.join(dir, "runnable"));
      const env = { PATH: dir };
      expect(impl.resolveExecutable("plain", { env })).toBeNull();
      expect(impl.resolveExecutable("dirtool", { env })).toBeNull();
      expect(impl.resolveExecutable("runnable", { env })).toBe(path.join(dir, "runnable"));
    });

    it("sanitizePathValue keeps only fully qualified entries outside the untrusted roots", () => {
      const value = ["", ".", "rel", path.join(workspace, "bin"), trustedBin, otherBin].join(path.delimiter);
      expect(impl.sanitizePathValue(value, [workspace])).toBe(
        [trustedBin, otherBin].join(path.delimiter),
      );
    });

    it("trustedWorkingDirectory skips candidates inside untrusted roots and non-directories", () => {
      expect(
        impl.trustedWorkingDirectory([workspace, path.join(workspace, "bin"), "relative", trustedBin], [workspace]),
      ).toBe(trustedBin);
      expect(impl.trustedWorkingDirectory([workspace], [workspace])).toBeNull();
    });

    it("taskkill resolves to %SystemRoot%\\System32\\taskkill.exe with a C:\\Windows fallback", () => {
      expect(impl.resolveWindowsSystemExecutable("taskkill.exe", { SystemRoot: "D:\\Win" })).toBe(
        "D:\\Win\\System32\\taskkill.exe",
      );
      expect(impl.resolveWindowsSystemExecutable("taskkill.exe", { SYSTEMROOT: "E:\\W\\" })).toBe(
        "E:\\W\\System32\\taskkill.exe",
      );
      for (const bad of [{}, { SystemRoot: "relative\\win" }, { SystemRoot: "C:\\..\\x" }, { SystemRoot: "C:\\a;b" }]) {
        expect(impl.resolveWindowsSystemExecutable("taskkill.exe", bad)).toBe(
          "C:\\Windows\\System32\\taskkill.exe",
        );
      }
    });
  });
}
