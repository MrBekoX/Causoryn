import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readOptionalBoundedTextFile,
  readOptionalBoundedTextFileSync,
  type BoundedTextReadOptions,
  type BoundedTextReadResult,
} from "../src/safe-file-read.js";

/**
 * CAU-05: path verification runs top-down from the root, so a link below the
 * root is rejected from its own lstat before any metadata I/O reaches a path
 * below it (on Windows such I/O could follow a junction to a network share).
 * Every path-taking fs call is recorded while `io.recording` is set; open(2)
 * also runs optional before/after hooks to stage a swap-and-restore race.
 */
const io = vi.hoisted(() => ({
  recording: false,
  calls: [] as Array<{ readonly op: string; readonly target: string }>,
  beforeOpen: undefined as (() => void) | undefined,
  afterOpen: undefined as (() => void) | undefined,
  hooksRun: 0,
}));

function record(op: string, target: unknown): void {
  if (io.recording) io.calls.push({ op, target: String(target) });
}

function runHook(slot: "beforeOpen" | "afterOpen"): void {
  const hook = io[slot];
  io[slot] = undefined;
  if (hook === undefined) return;
  hook();
  io.hooksRun += 1;
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const lstatSync = ((...args: Parameters<typeof actual.lstatSync>) => {
    record("lstat", args[0]);
    return actual.lstatSync(...args);
  }) as typeof actual.lstatSync;
  const statSync = ((...args: Parameters<typeof actual.statSync>) => {
    record("stat", args[0]);
    return actual.statSync(...args);
  }) as typeof actual.statSync;
  const realpathSync = Object.assign(
    ((...args: Parameters<typeof actual.realpathSync>) => {
      record("realpath", args[0]);
      return actual.realpathSync(...args);
    }) as typeof actual.realpathSync,
    {
      native: ((...args: Parameters<typeof actual.realpathSync.native>) => {
        record("realpath", args[0]);
        return actual.realpathSync.native(...args);
      }) as typeof actual.realpathSync.native,
    },
  );
  const readlinkSync = ((...args: Parameters<typeof actual.readlinkSync>) => {
    record("readlink", args[0]);
    return actual.readlinkSync(...args);
  }) as typeof actual.readlinkSync;
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    record("open", args[0]);
    runHook("beforeOpen");
    const fd = actual.openSync(...args);
    runHook("afterOpen");
    return fd;
  }) as typeof actual.openSync;
  const overrides = { lstatSync, statSync, realpathSync, readlinkSync, openSync };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const lstat = (async (...args: Parameters<typeof actual.lstat>) => {
    record("lstat", args[0]);
    return actual.lstat(...args);
  }) as typeof actual.lstat;
  const stat = (async (...args: Parameters<typeof actual.stat>) => {
    record("stat", args[0]);
    return actual.stat(...args);
  }) as typeof actual.stat;
  const realpath = (async (...args: Parameters<typeof actual.realpath>) => {
    record("realpath", args[0]);
    return actual.realpath(...args);
  }) as typeof actual.realpath;
  const readlink = (async (...args: Parameters<typeof actual.readlink>) => {
    record("readlink", args[0]);
    return actual.readlink(...args);
  }) as typeof actual.readlink;
  const open = (async (...args: Parameters<typeof actual.open>) => {
    record("open", args[0]);
    runHook("beforeOpen");
    const handle = await actual.open(...args);
    runHook("afterOpen");
    return handle;
  }) as typeof actual.open;
  const overrides = { lstat, stat, realpath, readlink, open };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

const tempDirs: string[] = [];

function createTempDir(label: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `causoryn-safe-read-order-${label}-`)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  io.recording = false;
  io.calls = [];
  io.beforeOpen = undefined;
  io.afterOpen = undefined;
  io.hooksRun = 0;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});

type Reader = (
  absolutePath: string,
  maxBytes: number,
  options?: BoundedTextReadOptions,
) => Promise<BoundedTextReadResult>;

const READERS: ReadonlyArray<readonly [string, Reader]> = [
  ["async", readOptionalBoundedTextFile],
  [
    "sync",
    (absolutePath, maxBytes, options) => Promise.resolve(readOptionalBoundedTextFileSync(absolutePath, maxBytes, options)),
  ],
];

const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);

function isSameOrInside(container: string, target: string): boolean {
  const c = fold(container);
  const t = fold(target);
  return t === c || t.startsWith(c.endsWith(path.sep) ? c : c + path.sep);
}

describe.each(READERS)("safe-file-read — top-down path verification (%s)", (_label, read) => {
  for (const mode of ["explicit root", "no root"] as const) {
    it(`${mode}: a junction below the root is rejected from its own lstat; nothing below it is touched`, async () => {
      const workspace = createTempDir("ws");
      const outside = createTempDir("outside");
      mkdirSync(path.join(workspace, "a"));
      mkdirSync(path.join(outside, "c"));
      writeFileSync(path.join(outside, "c", "rules.yaml"), "outside: 1\n", "utf8");
      const link = path.join(workspace, "a", "link");
      symlinkSync(outside, link, "junction");
      const target = path.join(link, "c", "rules.yaml");

      io.recording = true;
      const result = await read(target, 1024, mode === "explicit root" ? { root: workspace } : undefined);
      io.recording = false;

      expect(result).toEqual({ status: "missing" });
      const belowRoot = io.calls.filter(
        (call) => isSameOrInside(workspace, call.target) && fold(call.target) !== fold(workspace),
      );
      expect(belowRoot[0]).toEqual({ op: "lstat", target: path.join(workspace, "a") });
      expect(io.calls.filter((call) => isSameOrInside(link, call.target))).toEqual([{ op: "lstat", target: link }]);
    });
  }

  it("a directory swapped for a junction before open and restored after it is 'missing'", async () => {
    const workspace = createTempDir("swap-ws");
    const outside = createTempDir("swap-outside");
    const cfg = path.join(workspace, ".causoryn");
    const moved = path.join(workspace, "moved");
    mkdirSync(cfg);
    writeFileSync(path.join(cfg, "rules.yaml"), "inside: 1\n", "utf8");
    writeFileSync(path.join(outside, "rules.yaml"), "outside: 1\n", "utf8");
    io.beforeOpen = () => {
      renameSync(cfg, moved);
      symlinkSync(outside, cfg, "junction");
    };
    io.afterOpen = () => {
      unlinkSync(cfg);
      renameSync(moved, cfg);
    };

    expect(await read(path.join(cfg, "rules.yaml"), 1024, { root: workspace })).toEqual({ status: "missing" });
    expect(io.hooksRun).toBe(2);
    // Once restored, the same file reads normally.
    expect(await read(path.join(cfg, "rules.yaml"), 1024, { root: workspace })).toEqual({
      status: "ok",
      text: "inside: 1\n",
    });
  });
});
