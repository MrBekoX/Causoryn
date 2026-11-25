import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fsSpies = vi.hoisted(() => ({
  realpathSync: vi.fn(),
  statSync: vi.fn(),
  lstatSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const guardAndForward = <T extends (...args: never[]) => unknown>(
    name: string,
    fn: T,
  ) =>
    (...args: Parameters<T>): ReturnType<T> => {
      const firstArg = String(args[0] ?? "");
      if (/^(?:\\\\|\/\/|\/\\|\\\/)/.test(firstArg)) {
        throw new Error(`TEST_GUARD_VIOLATION: fs.${name} invoked on UNC/device path: ${firstArg}`);
      }
      return fn(...args) as ReturnType<T>;
    };
  fsSpies.realpathSync.mockImplementation(guardAndForward("realpathSync", actual.realpathSync));
  fsSpies.statSync.mockImplementation(guardAndForward("statSync", actual.statSync));
  fsSpies.lstatSync.mockImplementation(guardAndForward("lstatSync", actual.lstatSync));
  return {
    ...actual,
    realpathSync: fsSpies.realpathSync,
    statSync: fsSpies.statSync,
    lstatSync: fsSpies.lstatSync,
  };
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertNotUncOrDevicePath,
  isUncOrDevicePath,
  OutputAccessPolicy,
  OutputPolicyError,
  WorkspaceAccessPolicy,
  WorkspacePolicyError,
} from "@causoryn/workspace";

const UNC_AND_DEVICE_PATHS = [
  "\\\\10.0.0.1\\share",
  "\\\\10.0.0.1\\share\\repo",
  "//evil.local/share",
  "//evil.local/share/repo",
  "\\\\?\\UNC\\server\\share",
  "\\\\.\\pipe\\test",
  "\\\\.\\PhysicalDrive0",
  "/\\evil\\share",
  "\\/evil/share",
  "\\\\?\\C:\\Windows\\System32",
] as const;

describe("path-safety — Windows UNC & Win32 device lexical pre-check (Task 1.3)", () => {
  let validDir: string;

  beforeAll(() => {
    validDir = mkdtempSync(path.join(tmpdir(), "causoryn-path-safety-"));
    writeFileSync(path.join(validDir, "hello.ts"), "export const ok = true;\n", "utf8");
  });

  afterAll(() => {
    if (validDir !== undefined) {
      rmSync(validDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    fsSpies.realpathSync.mockClear();
    fsSpies.statSync.mockClear();
    fsSpies.lstatSync.mockClear();
  });

  it("lexically detects all UNC, mixed-slash network, and Win32 device prefixes without touching fs", () => {
    for (const rawPath of UNC_AND_DEVICE_PATHS) {
      expect(isUncOrDevicePath(rawPath), `must detect: ${rawPath}`).toBe(true);
      expect(() => assertNotUncOrDevicePath(rawPath, "root")).toThrowError(/UNC or Win32 device/);
    }

    for (const safePath of [
      "",
      ".",
      "/",
      "src/index.ts",
      "C:\\Users\\dev\\repo",
      "/home/dev/repo",
      validDir,
    ]) {
      expect(isUncOrDevicePath(safePath), `must allow local path: ${safePath}`).toBe(false);
      expect(() => assertNotUncOrDevicePath(safePath)).not.toThrow();
    }

    expect(fsSpies.realpathSync).not.toHaveBeenCalled();
    expect(fsSpies.statSync).not.toHaveBeenCalled();
    expect(fsSpies.lstatSync).not.toHaveBeenCalled();
  });

  it("canary: fs.realpathSync spy observes real calls for valid local paths", () => {
    const outPolicy = OutputAccessPolicy.create([validDir]);
    expect(fsSpies.realpathSync).toHaveBeenCalled();
    fsSpies.realpathSync.mockClear();

    const dirDecision = outPolicy.authorizeDirectory(validDir);
    expect(dirDecision.allowed).toBe(true);
    expect(fsSpies.realpathSync).toHaveBeenCalledTimes(1);

    fsSpies.realpathSync.mockClear();
    const wsPolicy = WorkspaceAccessPolicy.create({ allowRoots: [validDir] });
    expect(fsSpies.realpathSync).toHaveBeenCalledTimes(1);

    fsSpies.realpathSync.mockClear();
    const rootDecision = wsPolicy.authorizeRoot(validDir);
    expect(rootDecision.allowed).toBe(true);
    expect(fsSpies.realpathSync).toHaveBeenCalledTimes(1);
  });

  it("OutputAccessPolicy.create rejects UNC/device paths BEFORE any realpathSync/statSync/lstatSync call", () => {
    for (const uncPath of UNC_AND_DEVICE_PATHS) {
      fsSpies.realpathSync.mockClear();
      fsSpies.statSync.mockClear();
      fsSpies.lstatSync.mockClear();

      let thrown: unknown;
      try {
        OutputAccessPolicy.create([uncPath]);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `OutputAccessPolicy.create(${uncPath}) must throw`).toBeInstanceOf(
        OutputPolicyError,
      );
      expect((thrown as OutputPolicyError).code).toBe("workspace/output-policy-invalid");
      expect(fsSpies.realpathSync, `realpathSync must NOT be called for ${uncPath}`).not.toHaveBeenCalled();
      expect(fsSpies.statSync, `statSync must NOT be called for ${uncPath}`).not.toHaveBeenCalled();
      expect(fsSpies.lstatSync, `lstatSync must NOT be called for ${uncPath}`).not.toHaveBeenCalled();
    }
  });

  it("OutputAccessPolicy.authorizeDirectory and authorizeFile reject UNC/device paths BEFORE any fs call", () => {
    const policy = OutputAccessPolicy.create([validDir]);

    for (const uncPath of UNC_AND_DEVICE_PATHS) {
      fsSpies.realpathSync.mockClear();
      fsSpies.statSync.mockClear();
      fsSpies.lstatSync.mockClear();

      const dirDecision = policy.authorizeDirectory(uncPath);
      expect(dirDecision.allowed).toBe(false);
      if (!dirDecision.allowed) {
        expect(dirDecision.code).toBe("workspace/output-path-denied");
        expect(dirDecision.rule).toBe("unc-or-device-path");
      }
      expect(fsSpies.realpathSync, `authorizeDirectory realpathSync for ${uncPath}`).not.toHaveBeenCalled();
      expect(fsSpies.statSync, `authorizeDirectory statSync for ${uncPath}`).not.toHaveBeenCalled();
      expect(fsSpies.lstatSync, `authorizeDirectory lstatSync for ${uncPath}`).not.toHaveBeenCalled();

      const fileDecision = policy.authorizeFile(uncPath, "out.html");
      expect(fileDecision.allowed).toBe(false);
      if (!fileDecision.allowed) {
        expect(fileDecision.code).toBe("workspace/output-path-denied");
        expect(fileDecision.rule).toBe("unc-or-device-path");
      }
      expect(fsSpies.realpathSync, `authorizeFile realpathSync for ${uncPath}`).not.toHaveBeenCalled();
      expect(fsSpies.statSync, `authorizeFile statSync for ${uncPath}`).not.toHaveBeenCalled();
      expect(fsSpies.lstatSync, `authorizeFile lstatSync for ${uncPath}`).not.toHaveBeenCalled();
    }
  });

  it("WorkspaceAccessPolicy.create rejects UNC/device allowRoots BEFORE any realpathSync/statSync/lstatSync call", () => {
    for (const uncPath of UNC_AND_DEVICE_PATHS) {
      fsSpies.realpathSync.mockClear();
      fsSpies.statSync.mockClear();
      fsSpies.lstatSync.mockClear();

      let thrown: unknown;
      try {
        WorkspaceAccessPolicy.create({ allowRoots: [uncPath] });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `WorkspaceAccessPolicy.create(${uncPath}) must throw`).toBeInstanceOf(
        WorkspacePolicyError,
      );
      expect((thrown as WorkspacePolicyError).code).toBe("workspace/policy-invalid");
      expect(fsSpies.realpathSync, `realpathSync must NOT be called for ${uncPath}`).not.toHaveBeenCalled();
      expect(fsSpies.statSync, `statSync must NOT be called for ${uncPath}`).not.toHaveBeenCalled();
      expect(fsSpies.lstatSync, `lstatSync must NOT be called for ${uncPath}`).not.toHaveBeenCalled();
    }
  });

  it("WorkspaceAccessPolicy.authorizeRoot, checkPath, and checkFile reject UNC/device paths BEFORE any fs call on them", () => {
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [validDir] });

    for (const uncPath of UNC_AND_DEVICE_PATHS) {
      // 1) UNC as rootPath in authorizeRoot / checkPath / checkFile -> ZERO fs calls at all
      fsSpies.realpathSync.mockClear();
      fsSpies.statSync.mockClear();
      fsSpies.lstatSync.mockClear();

      const rootDecision = policy.authorizeRoot(uncPath);
      expect(rootDecision.allowed).toBe(false);
      if (!rootDecision.allowed) {
        expect(rootDecision.code).toBe("workspace/root-not-authorized");
        expect(rootDecision.rule).toBe("unc-or-device-path");
      }

      const checkRootDecision = policy.checkPath(uncPath, "hello.ts");
      expect(checkRootDecision.allowed).toBe(false);
      if (!checkRootDecision.allowed) {
        expect(checkRootDecision.code).toBe("workspace/root-not-authorized");
        expect(checkRootDecision.rule).toBe("unc-or-device-path");
      }

      expect(fsSpies.realpathSync, `root realpathSync for ${uncPath}`).not.toHaveBeenCalled();
      expect(fsSpies.statSync, `root statSync for ${uncPath}`).not.toHaveBeenCalled();
      expect(fsSpies.lstatSync, `root lstatSync for ${uncPath}`).not.toHaveBeenCalled();

      // 2) UNC as candidatePath with valid root -> ZERO fs calls touching uncPath
      fsSpies.realpathSync.mockClear();
      fsSpies.statSync.mockClear();
      fsSpies.lstatSync.mockClear();

      const candDecision = policy.checkPath(validDir, uncPath);
      expect(candDecision.allowed).toBe(false);
      if (!candDecision.allowed) {
        expect(candDecision.code).toBe("workspace/path-denied");
        expect(candDecision.rule).toBe("unc-or-device-path");
      }

      const fileDecision = policy.checkFile(validDir, uncPath);
      expect(fileDecision.allowed).toBe(false);
      if (!fileDecision.allowed) {
        expect(fileDecision.code).toBe("workspace/path-denied");
        expect(fileDecision.rule).toBe("unc-or-device-path");
      }

      for (const spy of [fsSpies.realpathSync, fsSpies.statSync, fsSpies.lstatSync]) {
        for (const callArgs of spy.mock.calls) {
          const arg = String(callArgs[0] ?? "");
          expect(
            isUncOrDevicePath(arg),
            `fs spy MUST NEVER receive UNC/device path, got: ${arg}`,
          ).toBe(false);
        }
      }
    }
  });
});
