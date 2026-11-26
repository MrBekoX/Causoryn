import {
  appendFileSync,
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
  readBoundedTextFile,
  readBoundedTextFileSync,
  type BoundedFileReadOptions,
  type BoundedFileReadResult,
} from "../src/index.js";

/**
 * Check-then-open races and I/O ordering for the shared bounded reader.
 * `node:fs` and `node:fs/promises` are wrapped so that (1) every path-taking
 * call made while `io.recording` is set is recorded, and (2) test hooks run
 * immediately before/after open(2) and after fstat. Races are therefore
 * deterministic on every OS, and the ordering of metadata I/O is observable.
 */
const io = vi.hoisted(() => ({
  recording: false,
  calls: [] as Array<{ readonly op: string; readonly target: string }>,
  beforeOpen: undefined as ((target: string) => void) | undefined,
  afterOpen: undefined as ((target: string) => void) | undefined,
  afterFstat: undefined as (() => void) | undefined,
  /** Report every inode as 0, as some Windows network/virtual filesystems do. */
  zeroInodes: false,
  /** lstat of this path reports a different inode (a file swapped after fstat). */
  spoofInodeOf: undefined as string | undefined,
  hooksRun: 0,
}));

const foldCase = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);

/** lstat result with the inode bumped when `target` is `io.spoofInodeOf`. */
function maybeSpoofInode<T>(target: unknown, stats: T): T {
  const spoofed = io.spoofInodeOf;
  if (spoofed === undefined || foldCase(String(target)) !== foldCase(spoofed)) return stats;
  const copy = Object.create(Object.getPrototypeOf(stats) as object) as Record<string, unknown>;
  Object.assign(copy, stats);
  copy["ino"] = typeof copy["ino"] === "bigint" ? (copy["ino"] as bigint) + 1n : (copy["ino"] as number) + 1;
  return copy as T;
}

function record(op: string, target: unknown): void {
  if (io.recording) io.calls.push({ op, target: String(target) });
}

/** Copy of a Stats/BigIntStats object with `ino` zeroed when `io.zeroInodes` is set. */
function maybeZeroInode<T>(stats: T): T {
  if (!io.zeroInodes || typeof stats !== "object" || stats === null) return stats;
  const copy = Object.create(Object.getPrototypeOf(stats) as object) as Record<string, unknown>;
  Object.assign(copy, stats);
  copy["ino"] = typeof copy["ino"] === "bigint" ? 0n : 0;
  return copy as T;
}

function runHook(hook: ((target: string) => void) | undefined, target: unknown): void {
  if (hook === undefined) return;
  hook(String(target));
  io.hooksRun += 1;
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const lstatSync = ((...args: Parameters<typeof actual.lstatSync>) => {
    record("lstat", args[0]);
    return maybeSpoofInode(args[0], maybeZeroInode(actual.lstatSync(...args)));
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
    const hook = io.beforeOpen;
    io.beforeOpen = undefined;
    runHook(hook, args[0]);
    const fd = actual.openSync(...args);
    const after = io.afterOpen;
    io.afterOpen = undefined;
    runHook(after, args[0]);
    return fd;
  }) as typeof actual.openSync;
  const fstatSync = ((...args: Parameters<typeof actual.fstatSync>) => {
    const result = maybeZeroInode(actual.fstatSync(...args));
    const hook = io.afterFstat;
    io.afterFstat = undefined;
    if (hook !== undefined) runHook(() => hook(), "");
    return result;
  }) as typeof actual.fstatSync;
  const overrides = { lstatSync, statSync, realpathSync, readlinkSync, openSync, fstatSync };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  type Handle = Awaited<ReturnType<typeof actual.open>>;
  const wrapHandle = (handle: Handle): Handle =>
    new Proxy(handle, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property === "stat") {
          return async (...args: unknown[]) => {
            const result: unknown = maybeZeroInode(
              await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args),
            );
            const hook = io.afterFstat;
            io.afterFstat = undefined;
            if (hook !== undefined) runHook(() => hook(), "");
            return result;
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
  const lstat = (async (...args: Parameters<typeof actual.lstat>) => {
    record("lstat", args[0]);
    return maybeSpoofInode(args[0], maybeZeroInode(await actual.lstat(...args)));
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
    const hook = io.beforeOpen;
    io.beforeOpen = undefined;
    runHook(hook, args[0]);
    const handle = await actual.open(...args);
    const after = io.afterOpen;
    io.afterOpen = undefined;
    runHook(after, args[0]);
    return wrapHandle(handle);
  }) as typeof actual.open;
  const overrides = { lstat, stat, realpath, readlink, open };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

const tempDirs: string[] = [];

function createTempDir(label: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `causoryn-bounded-race-${label}-`)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  io.recording = false;
  io.calls = [];
  io.beforeOpen = undefined;
  io.afterOpen = undefined;
  io.afterFstat = undefined;
  io.zeroInodes = false;
  io.spoofInodeOf = undefined;
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
  options?: BoundedFileReadOptions,
) => Promise<BoundedFileReadResult>;

const READERS: ReadonlyArray<readonly [string, Reader]> = [
  ["async", readBoundedTextFile],
  ["sync", (absolutePath, maxBytes, options) => Promise.resolve(readBoundedTextFileSync(absolutePath, maxBytes, options))],
];

const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);

function isSameOrInside(container: string, target: string): boolean {
  const c = fold(container);
  const t = fold(target);
  return t === c || t.startsWith(c.endsWith(path.sep) ? c : c + path.sep);
}

interface SwapFixture {
  readonly root: string;
  readonly target: string;
  /** Replaces `<root>/cfg` with a junction/symlink to a directory outside the root. */
  readonly swap: () => void;
  /** Puts the original `<root>/cfg` back (the attacker hides the swap again). */
  readonly restore: () => void;
}

function makeSwapFixture(label: string): SwapFixture {
  const root = createTempDir(`${label}-root`);
  const outside = createTempDir(`${label}-outside`);
  const cfg = path.join(root, "cfg");
  const moved = path.join(root, "moved-cfg");
  mkdirSync(cfg);
  writeFileSync(path.join(cfg, "a.yaml"), "inside: 1\n", "utf8");
  writeFileSync(path.join(outside, "a.yaml"), "outside: 1\n", "utf8");
  return {
    root,
    target: path.join(cfg, "a.yaml"),
    swap: () => {
      renameSync(cfg, moved);
      symlinkSync(outside, cfg, "junction");
    },
    restore: () => {
      unlinkSync(cfg);
      renameSync(moved, cfg);
    },
  };
}

describe.each(READERS)("bounded-file-read races (%s)", (_label, read) => {
  it("a directory swapped for a junction before open and restored after it is rejected (identity bound to the descriptor)", async () => {
    const fixture = makeSwapFixture("swap-restore");
    io.beforeOpen = () => fixture.swap();
    io.afterOpen = () => fixture.restore();

    expect(await read(fixture.target, 1024, { root: fixture.root })).toEqual({
      status: "rejected",
      reason: "identity-changed",
    });
    expect(io.hooksRun).toBe(2);
  });

  it("a file replaced by a different regular file before open is rejected", async () => {
    const fixture = makeSwapFixture("replace");
    io.beforeOpen = () => {
      const staged = path.join(fixture.root, "staged.yaml");
      writeFileSync(staged, "replaced: 1\n", "utf8");
      unlinkSync(fixture.target);
      renameSync(staged, fixture.target);
    };

    expect(await read(fixture.target, 1024, { root: fixture.root })).toEqual({
      status: "rejected",
      reason: "identity-changed",
    });
    expect(io.hooksRun).toBe(1);
  });

  it("a path that names a different file after fstat is caught by the post-open re-verification (every OS)", async () => {
    const fixture = makeSwapFixture("post-fstat-spoof");
    // The descriptor already matched the pre-open lstat; only the re-walk can see the change.
    io.afterFstat = () => {
      io.spoofInodeOf = fixture.target;
    };

    expect(await read(fixture.target, 1024, { root: fixture.root })).toEqual({
      status: "rejected",
      reason: "identity-changed",
    });
    expect(io.hooksRun).toBe(1);
  });

  // Windows refuses to rename a directory or replace a file while a handle
  // inside it is open, so these real swaps are only possible on POSIX.
  it.skipIf(process.platform === "win32")("a directory swapped for a symlink after fstat is caught by the post-open re-verification", async () => {
    const fixture = makeSwapFixture("post-fstat-swap");
    io.afterFstat = () => fixture.swap();

    expect(await read(fixture.target, 1024, { root: fixture.root })).toEqual({
      status: "rejected",
      reason: "identity-changed",
    });
    expect(io.hooksRun).toBe(1);
  });

  it.skipIf(process.platform === "win32")("a file replaced by a different regular file after fstat is caught by the post-open re-verification", async () => {
    const fixture = makeSwapFixture("post-fstat-replace");
    io.afterFstat = () => {
      const staged = path.join(fixture.root, "staged.yaml");
      writeFileSync(staged, "replaced: 1\n", "utf8");
      renameSync(staged, fixture.target);
    };

    expect(await read(fixture.target, 1024, { root: fixture.root })).toEqual({
      status: "rejected",
      reason: "identity-changed",
    });
    expect(io.hooksRun).toBe(1);
  });

  it("a file that grows after fstat is read at most maxBytes + 1 bytes and reported too-large", async () => {
    const fixture = makeSwapFixture("grow");
    io.afterFstat = () => appendFileSync(fixture.target, "x".repeat(256 * 1024), "utf8");

    expect(await read(fixture.target, 64, { root: fixture.root })).toEqual({ status: "too-large", bytes: 65 });
    expect(io.hooksRun).toBe(1);
  });

  it("an untouched file still reads normally through the wrapped fs", async () => {
    const fixture = makeSwapFixture("control");
    expect(await read(fixture.target, 1024, { root: fixture.root })).toMatchObject({
      status: "ok",
      text: "inside: 1\n",
    });
    expect(io.hooksRun).toBe(0);
  });
});

describe.each(READERS)("bounded-file-read with unknown (zero) inodes (%s)", (_label, read) => {
  it("an alias spelling never matches the root by a zero inode, so a path outside the root is not remapped into it", async () => {
    const root = createTempDir("zero-ino-root");
    const other = createTempDir("zero-ino-other");
    mkdirSync(path.join(root, "x"));
    mkdirSync(path.join(other, "x"));
    writeFileSync(path.join(root, "x", "f.txt"), "root\n", "utf8");
    writeFileSync(path.join(other, "x", "f.txt"), "other\n", "utf8");

    io.zeroInodes = true;
    expect(await read(path.join(other, "x", "f.txt"), 1024, { root })).toEqual({
      status: "rejected",
      reason: "outside-root",
    });
  });
});

describe.each(READERS)("bounded-file-read ordering (%s)", (_label, read) => {
  for (const mode of ["explicit root", "filesystem root"] as const) {
    it(`${mode}: an intermediate link is lstat'd top-down and nothing below it is touched`, async () => {
      const root = createTempDir("order-root");
      const outside = createTempDir("order-outside");
      mkdirSync(path.join(root, "a"));
      mkdirSync(path.join(outside, "c"));
      writeFileSync(path.join(outside, "c", "file.txt"), "outside\n", "utf8");
      const link = path.join(root, "a", "link");
      symlinkSync(outside, link, "junction");
      const target = path.join(link, "c", "file.txt");

      io.recording = true;
      const result = await read(target, 1024, mode === "explicit root" ? { root } : undefined);
      io.recording = false;

      expect(result).toEqual({ status: "rejected", reason: "unsafe-component" });
      // The first I/O on anything below the root is the lstat of its direct child.
      const belowRoot = io.calls.filter((call) => isSameOrInside(root, call.target) && fold(call.target) !== fold(root));
      expect(belowRoot[0]).toEqual({ op: "lstat", target: path.join(root, "a") });
      // The link itself is only lstat'd; no I/O reaches it otherwise or anything below it.
      const touchingLink = io.calls.filter((call) => isSameOrInside(link, call.target));
      expect(touchingLink).toEqual([{ op: "lstat", target: link }]);
      expect(io.calls.some((call) => call.op === "open")).toBe(false);
    });
  }

  it("components are lstat'd strictly top-down before the file is opened", async () => {
    const root = createTempDir("order-ok");
    mkdirSync(path.join(root, "a", "b"), { recursive: true });
    const target = path.join(root, "a", "b", "f.txt");
    writeFileSync(target, "ok\n", "utf8");

    io.recording = true;
    const result = await read(target, 1024, { root });
    io.recording = false;

    expect(result).toMatchObject({ status: "ok", text: "ok\n" });
    const firstOpen = io.calls.findIndex((call) => call.op === "open");
    const beforeOpen = io.calls
      .slice(0, firstOpen)
      .filter((call) => isSameOrInside(root, call.target) && fold(call.target) !== fold(root));
    expect(beforeOpen).toEqual([
      { op: "lstat", target: path.join(root, "a") },
      { op: "lstat", target: path.join(root, "a", "b") },
      { op: "lstat", target },
    ]);
  });
});
