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
 * call made while `io.recording` is set is recorded, (2) test hooks run
 * immediately before each lstat, before/after open(2) and after fstat, and
 * (3) `io.proc` can stand in for Linux procfs (`/proc/self/fd`). Races are
 * therefore deterministic on every OS, and the ordering of metadata I/O is
 * observable.
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
  /** Runs before every lstat (sync and async) with its target (not counted in hooksRun). */
  beforeLstat: undefined as ((target: string) => void) | undefined,
  /**
   * Stand-in for Linux procfs. `dir` is a real directory reported for an lstat
   * of `/proc/self/fd` (undefined: procfs is not mounted, ENOENT); `link`
   * answers readlink of `/proc/self/fd/<fd>` (an Error is thrown).
   */
  proc: undefined as
    | { readonly dir: string | undefined; readonly link: (fd: number) => string | Error }
    | undefined,
  hooksRun: 0,
}));

const PROC_SELF_FD = "/proc/self/fd";

function enoent(target: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${target}'`), { code: "ENOENT" });
}

/** The fake procfs answer for an lstat of `/proc/self/fd`, or undefined when the call is not for it. */
function fakeProcDir(target: unknown): { readonly dir: string } | undefined {
  if (io.proc === undefined || String(target) !== PROC_SELF_FD) return undefined;
  if (io.proc.dir === undefined) throw enoent(PROC_SELF_FD);
  return { dir: io.proc.dir };
}

/** The fake procfs answer for readlink of `/proc/self/fd/<fd>`, or undefined when not for it. */
function fakeProcLink(target: unknown): { readonly link: string } | undefined {
  const text = String(target);
  if (io.proc === undefined || !text.startsWith(`${PROC_SELF_FD}/`)) return undefined;
  const answer = io.proc.link(Number(text.slice(PROC_SELF_FD.length + 1)));
  if (answer instanceof Error) throw answer;
  return { link: answer };
}

/** Host platform, captured before any test stubs `process.platform`. */
const IS_WIN_HOST = process.platform === "win32";

const foldCase = (value: string): string => (IS_WIN_HOST ? value.toLowerCase() : value);

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
    io.beforeLstat?.(String(args[0]));
    const proc = fakeProcDir(args[0]);
    if (proc !== undefined) return actual.lstatSync(proc.dir, args[1]);
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
    const proc = fakeProcLink(args[0]);
    if (proc !== undefined) return proc.link;
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
    io.beforeLstat?.(String(args[0]));
    const proc = fakeProcDir(args[0]);
    if (proc !== undefined) return actual.lstat(proc.dir, args[1]);
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
    const proc = fakeProcLink(args[0]);
    if (proc !== undefined) return proc.link;
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

const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;

/** Makes the reader see `platform` (restored after each test); module-load constants keep the host's. */
function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...REAL_PLATFORM, value: platform });
}

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
  io.beforeLstat = undefined;
  io.proc = undefined;
  io.hooksRun = 0;
  Object.defineProperty(process, "platform", REAL_PLATFORM);
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

const fold = (value: string): string => (IS_WIN_HOST ? value.toLowerCase() : value);

function isSameOrInside(container: string, target: string): boolean {
  const c = fold(container);
  const t = fold(target);
  return t === c || t.startsWith(c.endsWith(path.sep) ? c : c + path.sep);
}

interface SwapFixture {
  readonly root: string;
  /** `<root>/cfg`, the component the attacker swaps. */
  readonly cfg: string;
  readonly target: string;
  /** The file the swapped-in link leads to (outside the root). */
  readonly outsideTarget: string;
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
    cfg,
    target: path.join(cfg, "a.yaml"),
    outsideTarget: path.join(outside, "a.yaml"),
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

/**
 * A toggling attacker (on Linux a renameat2(RENAME_EXCHANGE) loop) that wins
 * every path-based check: `<root>/cfg` is the real directory whenever it is
 * lstat'd itself, and the link whenever the file below it is lstat'd or
 * opened. The pre-open lstat, the fstat and the post-open re-walk then all
 * agree on the outside file, so only a check bound to the descriptor itself
 * can tell. Returns the cleanup that leaves the real directory in place.
 */
function toggleOnEveryCheck(fixture: SwapFixture): { readonly swaps: () => number; readonly stop: () => void } {
  let swapped = false;
  let swaps = 0;
  io.beforeLstat = (target) => {
    if (fold(target) === fold(fixture.cfg) && swapped) {
      fixture.restore();
      swapped = false;
    } else if (fold(target) === fold(fixture.target) && !swapped) {
      fixture.swap();
      swapped = true;
      swaps += 1;
    }
  };
  return {
    swaps: () => swaps,
    stop: () => {
      io.beforeLstat = undefined;
      if (swapped) fixture.restore();
      swapped = false;
    },
  };
}

/**
 * Linux procfs for the reader: on a Linux host the kernel answers; elsewhere
 * the reader is made to see Linux and `/proc/self/fd/<fd>` answers `location`
 * (what the kernel reports for the descriptor: its file's current path).
 */
function procReports(location: () => string): void {
  if (process.platform === "linux") return;
  stubPlatform("linux");
  io.proc = { dir: createTempDir("fake-proc-fd"), link: () => location() };
}

/** The reader sees Linux with a fake procfs on every host (edge cases the kernel cannot be made to produce). */
function fakeLinuxProc(proc: { readonly mounted: boolean; readonly link: (fd: number) => string | Error }): void {
  stubPlatform("linux");
  io.proc = { dir: proc.mounted ? createTempDir("fake-proc-fd") : undefined, link: proc.link };
}

function procFdReadlinks(): string[] {
  return io.calls
    .filter((call) => call.op === "readlink" && call.target.startsWith(`${PROC_SELF_FD}/`))
    .map((call) => call.target);
}

describe.each(READERS)("bounded-file-read descriptor location on Linux (%s)", (_label, read) => {
  it("a component toggled between directory and link around every check is rejected by the descriptor's kernel path", async () => {
    const fixture = makeSwapFixture("toggle");
    procReports(() => fixture.outsideTarget);
    const toggle = toggleOnEveryCheck(fixture);
    let result: BoundedFileReadResult;
    try {
      result = await read(fixture.target, 1024, { root: fixture.root });
    } finally {
      toggle.stop();
    }

    expect(result).toEqual({ status: "rejected", reason: "identity-changed" });
    expect(toggle.swaps()).toBeGreaterThan(0);
  });

  it("the descriptor's location is verified before its size: a toggled-in outside file's size is not reported", async () => {
    const fixture = makeSwapFixture("toggle-size");
    procReports(() => fixture.outsideTarget);
    const toggle = toggleOnEveryCheck(fixture);
    let result: BoundedFileReadResult;
    try {
      result = await read(fixture.target, 4, { root: fixture.root });
    } finally {
      toggle.stop();
    }

    expect(result).toEqual({ status: "rejected", reason: "identity-changed" });
  });

  it("a descriptor the kernel places at the verified path reads normally, and the check is made", async () => {
    const fixture = makeSwapFixture("proc-match");
    procReports(() => fixture.target);

    io.recording = true;
    const result = await read(fixture.target, 1024, { root: fixture.root });
    io.recording = false;

    expect(result).toMatchObject({ status: "ok", text: "inside: 1\n" });
    expect(procFdReadlinks()).toHaveLength(1);
    expect(procFdReadlinks()[0]).toMatch(/^\/proc\/self\/fd\/\d+$/);
  });

  it("a descriptor whose file was deleted (kernel path ends in ' (deleted)') is rejected", async () => {
    const fixture = makeSwapFixture("proc-deleted");
    fakeLinuxProc({ mounted: true, link: () => `${fixture.target} (deleted)` });

    expect(await read(fixture.target, 1024, { root: fixture.root })).toEqual({
      status: "rejected",
      reason: "identity-changed",
    });
  });

  it("a readlink failure while procfs is mounted is a rejection, not a silent fallback", async () => {
    const fixture = makeSwapFixture("proc-error");
    // e.g. ENAMETOOLONG for a descriptor whose real path is longer than a page.
    fakeLinuxProc({
      mounted: true,
      link: () => Object.assign(new Error("ENAMETOOLONG: name too long"), { code: "ENAMETOOLONG" }),
    });

    expect(await read(fixture.target, 1024, { root: fixture.root })).toEqual({
      status: "rejected",
      reason: "read-failed",
    });
  });

  it("without procfs the path-based checks decide alone (a normal file still reads)", async () => {
    const fixture = makeSwapFixture("proc-missing");
    fakeLinuxProc({ mounted: false, link: () => enoent(PROC_SELF_FD) });

    expect(await read(fixture.target, 1024, { root: fixture.root })).toMatchObject({
      status: "ok",
      text: "inside: 1\n",
    });
  });

  it("other platforms do not consult /proc (no descriptor path is available there)", async () => {
    const fixture = makeSwapFixture("proc-other-os");
    stubPlatform("darwin");
    io.proc = { dir: createTempDir("fake-proc-fd"), link: () => fixture.outsideTarget };

    io.recording = true;
    const result = await read(fixture.target, 1024, { root: fixture.root });
    io.recording = false;

    expect(result).toMatchObject({ status: "ok", text: "inside: 1\n" });
    expect(procFdReadlinks()).toEqual([]);
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
