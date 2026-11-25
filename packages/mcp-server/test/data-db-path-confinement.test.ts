import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * storage.dataDbPath / wiki.dataDbPath confinement: UNC and Win32 device
 * declarations are rejected before any filesystem call, Windows name aliases
 * (data streams, trailing dots, device names) are rejected, and a declaration
 * that reaches a UNC/device target through a link is rejected before the link
 * is followed.
 */

const fsSpies = vi.hoisted(() => ({
  realpathSync: vi.fn(),
  statSync: vi.fn(),
  lstatSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const forward =
    <T extends (...args: never[]) => unknown>(fn: T) =>
    (...args: Parameters<T>): ReturnType<T> =>
      fn(...args) as ReturnType<T>;
  fsSpies.realpathSync.mockImplementation(forward(actual.realpathSync));
  fsSpies.statSync.mockImplementation(forward(actual.statSync));
  fsSpies.lstatSync.mockImplementation(forward(actual.lstatSync));
  const realpathSpy = Object.assign(fsSpies.realpathSync, { native: actual.realpathSync.native });
  return { ...actual, realpathSync: realpathSpy, statSync: fsSpies.statSync, lstatSync: fsSpies.lstatSync };
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { isUncOrDevicePath } from "@causoryn/workspace";

import { CausorynConfigError, createCausorynContext } from "../src/index.js";

const IS_WIN = process.platform === "win32";

const UNC_AND_DEVICE_DB_PATHS = [
  "\\\\10.0.0.1\\share\\graph.sqlite",
  "//evil.local/share/graph.sqlite",
  "\\\\?\\UNC\\server\\share\\graph.sqlite",
  "\\\\.\\pipe\\graph.sqlite",
  "\\??\\C:\\data\\graph.sqlite",
] as const;

let base: string;
let root: string;
let dataDir: string;

const CAN_CREATE_FILE_SYMLINK: boolean = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), "causoryn-dbpath-probe-"));
  try {
    writeFileSync(path.join(probe, "t.txt"), "probe");
    symlinkSync(path.join(probe, "t.txt"), path.join(probe, "l.txt"), "file");
    return readFileSync(path.join(probe, "l.txt"), "utf8") === "probe";
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})();

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), "causoryn-dbpath-"));
  root = path.join(base, "workspace");
  dataDir = path.join(base, "data");
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(root, "src", "app.ts"), "export const a = 1;\n");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

beforeEach(() => {
  fsSpies.realpathSync.mockClear();
  fsSpies.statSync.mockClear();
  fsSpies.lstatSync.mockClear();
});

function configError(rawConfig: unknown): CausorynConfigError {
  let thrown: unknown;
  try {
    const context = createCausorynContext(rawConfig, { logger: () => {} });
    context.close();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CausorynConfigError);
  return thrown as CausorynConfigError;
}

function fsCallArgs(): string[] {
  return [fsSpies.realpathSync, fsSpies.statSync, fsSpies.lstatSync].flatMap((spy) =>
    spy.mock.calls.map((call) => String(call[0] ?? "")),
  );
}

describe("validateDataDbPath — UNC and Win32 device declarations", () => {
  it("rejects storage.dataDbPath and wiki.dataDbPath before any filesystem call on them", () => {
    for (const field of ["storage", "wiki"] as const) {
      for (const dbPath of UNC_AND_DEVICE_DB_PATHS) {
        fsSpies.realpathSync.mockClear();
        fsSpies.statSync.mockClear();
        fsSpies.lstatSync.mockClear();
        const error = configError({
          workspaceId: "ws_dbpath",
          allowRoots: [root],
          autoIndex: false,
          [field]: { dataDbPath: dbPath },
        });
        expect(error.message, `${field}: ${dbPath}`).toMatch(/UNC or Win32 device/);
        for (const arg of fsCallArgs()) {
          expect(isUncOrDevicePath(arg), `fs call must not receive ${arg}`).toBe(false);
        }
      }
    }
  });
});

describe("validateDataDbPath — Windows name aliases and link targets", () => {
  it.skipIf(!IS_WIN)("rejects data streams, trailing dots and device names in the declaration", () => {
    for (const dbPath of [
      path.join(dataDir, "graph.sqlite:stream"),
      path.join(dataDir, "graph.sqlite."),
      path.join(dataDir, "NUL"),
      `${dataDir}.\\graph.sqlite`,
    ]) {
      const error = configError({
        workspaceId: "ws_dbpath",
        allowRoots: [root],
        autoIndex: false,
        storage: { dataDbPath: dbPath },
      });
      expect(error.message, dbPath).toMatch(/colon|dot or a space|reserved Windows device name/);
    }
  });

  it.skipIf(!IS_WIN || !CAN_CREATE_FILE_SYMLINK)(
    "rejects a declaration that reaches a UNC target through a directory or file link",
    () => {
      const linkedDir = path.join(base, "linked-data");
      symlinkSync("\\\\127.0.0.1\\causoryn-none\\", linkedDir, "dir");
      const linkedFile = path.join(dataDir, "linked.sqlite");
      symlinkSync("\\\\127.0.0.1\\causoryn-none\\graph.sqlite", linkedFile, "file");
      const sideFile = path.join(dataDir, "side.sqlite");
      symlinkSync("\\\\127.0.0.1\\causoryn-none\\side.sqlite-wal", `${sideFile}-wal`, "file");
      for (const dbPath of [path.join(linkedDir, "graph.sqlite"), linkedFile, sideFile]) {
        const error = configError({
          workspaceId: "ws_dbpath",
          allowRoots: [root],
          autoIndex: false,
          wiki: { dataDbPath: dbPath },
        });
        expect(error.message, dbPath).toMatch(/UNC or Win32 device target/);
      }
    },
  );

  it("keeps accepting an ordinary declaration outside the workspace", () => {
    const context = createCausorynContext(
      {
        workspaceId: "ws_dbpath",
        allowRoots: [root],
        autoIndex: false,
        storage: { dataDbPath: path.join(dataDir, "graph.sqlite") },
      },
      { logger: () => {} },
    );
    context.close();
  });
});
