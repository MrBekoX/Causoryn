/**
 * CAU-09 (CWE-400): the git metadata reader in git-repository-layout.ts must
 * never block on a special file and never read one. It decides on the opened
 * descriptor, not on a path-based check made before the open (CodeQL
 * js/file-system-race): each metadata file is opened first with
 * O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_NOCTTY where the platform defines them (a
 * FIFO open returns at once), the handle must be a regular file (a directory
 * reads as absent), and a post-open lstat must show that the path still names
 * that file and is no link (Windows has no O_NOFOLLOW). This all happens
 * before git is started, so the git subprocess timeout cannot cover a blocked
 * open.
 *
 * The fs-level tests run on every platform through a pass-through mock of
 * node:fs/promises (and node:fs constants that define the POSIX-only O_* bits
 * everywhere); the real FIFO tests are POSIX-only and guarded by a timeout
 * (and a writer that unblocks a stuck reader) so they cannot hang CI.
 */
import { execFile as execFileCallback } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type BigIntStats,
  type StatOptions,
  type Stats,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { GraphRepositoryError } from "../packages/graph/src/errors.js";
import {
  resetGitRuntimeCachesForTesting,
  resolveGitCommitRef,
  setGitProcessRunnerForTesting,
} from "../packages/graph/src/git-read.js";
import { validateRepositoryLayout } from "../packages/graph/src/git-repository-layout.js";

const execFile = promisify(execFileCallback);

type AnyStats = Stats | BigIntStats;

const fsHooks = vi.hoisted(() => ({
  /** O_* bits the mocked node:fs constants add because this platform does not define them. */
  fakeBits: 0,
  /** Replaces the lstat result for one path (pass-through when undefined). */
  lstat: undefined as undefined | ((file: string, real: unknown, options?: import("node:fs").StatOptions) => unknown),
  /**
   * Runs before the real lstat: a returned value is the result (no real lstat),
   * a thrown error is the failure, undefined passes through.
   */
  beforeLstat: undefined as undefined | ((file: string, options?: import("node:fs").StatOptions) => unknown),
  /** Link text for a simulated symbolic link (undefined: real readlink). */
  readlink: undefined as undefined | ((file: string) => string | undefined),
  /**
   * Runs before the real realpath: a returned value is the result, a thrown
   * error is the failure, undefined passes through.
   */
  beforeRealpath: undefined as undefined | ((file: string) => string | undefined),
  /** Runs before the real open: a thrown error is the failure, otherwise the real open runs. */
  beforeOpen: undefined as undefined | ((file: string) => void),
  /** Replaces what FileHandle.stat() reports for a file opened at `file`. */
  handleStat: undefined as undefined | ((file: string, real: unknown) => unknown),
  opened: [] as Array<{ readonly file: string; readonly flags: unknown }>,
  /** Files whose opened handle was read from. */
  read: [] as string[],
  /** Files whose opened handle was closed. */
  closed: [] as string[],
  /** Path operations in call order ("open" or "lstat" / "lstat-bigint"). */
  events: [] as Array<{ readonly op: "open" | "lstat" | "lstat-bigint"; readonly file: string }>,
}));

// Defines O_NOFOLLOW, O_NONBLOCK and O_NOCTTY on every platform (Windows has
// none of them), so the open flags are checked everywhere; the mocked open
// strips the made-up bits again before the real open.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const extra: Record<string, number> = {};
  let fake = 0;
  // Bits unused by any O_*/UV_FS_O_* constant Node defines on Windows.
  const candidates: ReadonlyArray<readonly [string, number]> = [
    ["O_NOFOLLOW", 0x0100_0000],
    ["O_NONBLOCK", 0x0200_0000],
    ["O_NOCTTY", 0x0400_0000],
  ];
  for (const [name, bit] of candidates) {
    if ((actual.constants as unknown as Record<string, number | undefined>)[name] === undefined) {
      extra[name] = bit;
      fake |= bit;
    }
  }
  fsHooks.fakeBits = fake;
  const constants = { ...actual.constants, ...extra };
  return { ...actual, constants, default: { ...actual, constants } };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const lstat = async (file: import("node:fs").PathLike, options?: import("node:fs").StatOptions) => {
    fsHooks.events.push({ op: options?.bigint === true ? "lstat-bigint" : "lstat", file: String(file) });
    const replaced = fsHooks.beforeLstat?.(String(file), options);
    if (replaced !== undefined) return replaced;
    const real = await actual.lstat(file, options);
    return fsHooks.lstat === undefined ? real : (fsHooks.lstat(String(file), real, options) ?? real);
  };
  const readlink = async (file: import("node:fs").PathLike, options?: unknown) => {
    const text = fsHooks.readlink?.(String(file));
    if (text !== undefined) return text;
    return actual.readlink(file, options as never);
  };
  const realpath = async (file: import("node:fs").PathLike, options?: unknown) => {
    const replaced = fsHooks.beforeRealpath?.(String(file));
    if (replaced !== undefined) return replaced;
    return actual.realpath(file, options as never);
  };
  const open = async (
    file: import("node:fs").PathLike,
    flags?: string | number,
    mode?: import("node:fs").Mode,
  ) => {
    const name = String(file);
    fsHooks.opened.push({ file: name, flags });
    fsHooks.events.push({ op: "open", file: name });
    fsHooks.beforeOpen?.(name);
    const handle = await actual.open(file, typeof flags === "number" ? flags & ~fsHooks.fakeBits : flags, mode);
    const realStat = handle.stat.bind(handle);
    const realRead = handle.read.bind(handle) as (...args: unknown[]) => Promise<unknown>;
    const realClose = handle.close.bind(handle);
    Object.defineProperty(handle, "stat", {
      value: async (options?: import("node:fs").StatOptions) => {
        const real = await realStat(options as never);
        return fsHooks.handleStat === undefined ? real : (fsHooks.handleStat(name, real) ?? real);
      },
    });
    Object.defineProperty(handle, "read", {
      value: async (...args: unknown[]) => {
        fsHooks.read.push(name);
        return realRead(...args);
      },
    });
    Object.defineProperty(handle, "close", {
      value: async () => {
        fsHooks.closed.push(name);
        return realClose();
      },
    });
    return handle;
  };
  return { ...actual, lstat, readlink, realpath, open };
});

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
afterEach(() => {
  fsHooks.lstat = undefined;
  fsHooks.beforeLstat = undefined;
  fsHooks.readlink = undefined;
  fsHooks.beforeRealpath = undefined;
  fsHooks.beforeOpen = undefined;
  fsHooks.handleStat = undefined;
  fsHooks.opened.length = 0;
  fsHooks.read.length = 0;
  fsHooks.closed.length = 0;
  fsHooks.events.length = 0;
  setGitProcessRunnerForTesting(undefined);
  resetGitRuntimeCachesForTesting();
});

function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === "";
}

/** A minimal `.git` directory: enough metadata for validateRepositoryLayout. */
function fakeRepository(prefix: string): { readonly root: string; readonly gitDir: string } {
  const root = tempDir(prefix);
  const gitDir = path.join(root, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  return { root, gitDir };
}

/** Copy of `real` that answers like a FIFO (same dev/ino/mode fields otherwise). */
function asFifo(real: AnyStats): AnyStats {
  return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as AnyStats, real, {
    isFile: () => false,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => true,
  });
}

/** Copy of `real` that names a different inode (the file was swapped after lstat). */
function withOtherInode(real: AnyStats): AnyStats {
  const ino = typeof real.ino === "bigint" ? real.ino + 1n : real.ino + 1;
  return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as AnyStats, real, { ino });
}

/** Copy of `real` that answers like a regular file. */
function asRegularFile(real: AnyStats): AnyStats {
  return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as AnyStats, real, {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
  });
}

async function rejection(action: () => Promise<unknown>): Promise<GraphRepositoryError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(GraphRepositoryError);
    return error as GraphRepositoryError;
  }
  throw new Error("expected a GraphRepositoryError rejection");
}

/** Stats that answer like a symbolic link (fields copied from a real directory). */
function symlinkStats(options?: StatOptions): AnyStats {
  const template = options?.bigint === true ? lstatSync(os.tmpdir(), { bigint: true }) : lstatSync(os.tmpdir());
  return Object.assign(Object.create(Object.getPrototypeOf(template) as object) as AnyStats, template, {
    isFile: () => false,
    isDirectory: () => false,
    isSymbolicLink: () => true,
    isFIFO: () => false,
  });
}

/**
 * Simulates symbolic links (path, link text) on every platform: lstat reports
 * a link and readlink returns the text; every other path is the real one.
 * Relative link text needs no privilege this way on Windows.
 */
function simulateLinks(links: ReadonlyArray<readonly [string, string]>): void {
  const textOf = (file: string): string | undefined => links.find(([at]) => samePath(at, file))?.[1];
  fsHooks.beforeLstat = (file, options) => (textOf(file) === undefined ? undefined : symlinkStats(options));
  fsHooks.readlink = textOf;
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated failure`), { code });
}

/** A refusal names neither `location` nor its JSON-escaped spelling. */
function expectNotNamed(message: string, location: string): void {
  expect(message).not.toContain(location);
  expect(message).not.toContain(JSON.stringify(location).slice(1, -1));
}

/** <holder>/root with a minimal .git directory (HEAD, objects/info). */
function nestedRepository(prefix: string): { readonly holder: string; readonly root: string; readonly gitDir: string } {
  const holder = tempDir(prefix);
  const root = path.join(holder, "root");
  const gitDir = path.join(root, ".git");
  mkdirSync(path.join(gitDir, "objects", "info"), { recursive: true });
  writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  return { holder, root, gitDir };
}

function gitDirectoryAt(dir: string): void {
  mkdirSync(path.join(dir, "objects"), { recursive: true });
  writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/main\n", "utf8");
}

/** True once `file` has been opened in this test: a change made "after the open". */
function openedAlready(file: string): boolean {
  return fsHooks.opened.some((entry) => samePath(entry.file, file));
}

/** Copy of `real` that answers like a directory. */
function asDirectory(real: AnyStats): AnyStats {
  return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as AnyStats, real, {
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    isFIFO: () => false,
  });
}

function only(files: readonly string[], file: string): string[] {
  return files.filter((entry) => samePath(entry, file));
}

interface CommondirRepository {
  readonly root: string;
  readonly gitDir: string;
  readonly commondir: string;
}

/** A `.git/commondir` file with `content` (".\n": the git directory itself). */
function repositoryWithCommondir(prefix: string, content: string): CommondirRepository {
  const { root, gitDir } = fakeRepository(prefix);
  const commondir = path.join(gitDir, "commondir");
  writeFileSync(commondir, content, "utf8");
  return { root, gitDir, commondir };
}

/**
 * The reader opens first and decides on the descriptor (CodeQL
 * js/file-system-race: no path-based check before a path-based open). Tests
 * written for the former order (lstat, then open, then compare) are rewritten
 * below to assert the same security properties under the new order; each
 * rewritten test says what it replaces.
 */
describe("git metadata reader: decides on the opened descriptor (CAU-09, every platform)", () => {
  // New: the order itself. The bounded reader makes no lstat of the path
  // before it opens it; its own (bigint) lstat follows the open and only
  // re-verifies the opened file. The walk's plain lstat of each component
  // ("lstat" events) is the link check of the path and is not the reader's.
  it("opens a metadata file before its own lstat of that path", async () => {
    const { root, commondir } = repositoryWithCommondir("causoryn-meta-order-", ".\n");

    await validateRepositoryLayout(root, "rev-parse");

    const own = fsHooks.events.filter((event) => event.op !== "lstat" && samePath(event.file, commondir));
    expect(own.map((event) => event.op)).toEqual(["open", "lstat-bigint"]);
  });

  // Replaces "opens metadata files read-only with O_NOFOLLOW and O_NONBLOCK
  // where the platform defines them": O_NOCTTY is added (a terminal device
  // never becomes the controlling terminal), and the mocked constants define
  // all three bits on every platform, so a dropped flag fails here on Windows
  // too, not only on POSIX CI.
  it("opens metadata files read-only with O_NOFOLLOW, O_NONBLOCK and O_NOCTTY where the platform defines them", async () => {
    const { root, gitDir, commondir } = repositoryWithCommondir("causoryn-meta-flags-", ".\n");

    const layout = await validateRepositoryLayout(root, "rev-parse");

    expect(samePath(layout.commonDir, gitDir)).toBe(true);
    const opens = fsHooks.opened.filter((entry) => samePath(entry.file, commondir));
    expect(opens).toHaveLength(1);
    const flags = opens[0]!.flags;
    expect(typeof flags).toBe("number");
    expect(fsConstants.O_NOFOLLOW).toBeDefined();
    expect(fsConstants.O_NONBLOCK).toBeDefined();
    expect(fsConstants.O_NOCTTY).toBeDefined();
    const required =
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOCTTY ?? 0);
    expect((flags as number) & required).toBe(required);
    expect((flags as number) & (fsConstants.O_WRONLY | fsConstants.O_RDWR)).toBe(0);
    expect(only(fsHooks.closed, commondir)).toHaveLength(1);
  });

  // Replaces "never opens a metadata file that lstat does not report as a
  // regular file": the file is now opened first, non-blocking (flags test
  // above; the real FIFO tests below show the open returns at once), so the
  // property asserted is that a descriptor that is not a regular file is
  // refused, never read, and closed.
  it("refuses, never reads and closes a metadata file whose opened descriptor is a FIFO", async () => {
    const { root, commondir } = repositoryWithCommondir("causoryn-meta-fifo-mock-", ".\n");
    fsHooks.handleStat = (file, real) => (samePath(file, commondir) ? asFifo(real as AnyStats) : undefined);

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("commondir");
    expect(error.message).toContain("is not a regular file");
    expect(only(fsHooks.read, commondir)).toEqual([]);
    expect(only(fsHooks.closed, commondir)).toHaveLength(1);
  });

  // Replaces "refuses a metadata file whose opened handle is not the file
  // lstat saw": the identity is now checked after the open, by an lstat of the
  // path against the descriptor (dev, ino), which also refuses a link or a
  // special file at the path (Windows has no O_NOFOLLOW, so its open follows a
  // final link). Each change below happens only once the file is open, where a
  // check made before the open cannot see it.
  const afterOpen: ReadonlyArray<readonly [string, (real: AnyStats, options?: StatOptions) => AnyStats]> = [
    ["another file (other inode)", (real) => withOtherInode(real)],
    ["a symbolic link", (_real, options) => symlinkStats(options)],
    ["a FIFO", (real) => asFifo(real)],
  ];
  for (const [what, swapped] of afterOpen) {
    it(`refuses, never reads and closes a metadata file whose path names ${what} once it is open`, async () => {
      const { root, commondir } = repositoryWithCommondir("causoryn-meta-swap-mock-", ".\n");
      fsHooks.lstat = (file, real, options) =>
        samePath(file, commondir) && openedAlready(commondir) ? swapped(real as AnyStats, options) : undefined;

      const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

      expect(error.code).toBe("compare/repository-refused");
      expect(error.message).toContain("commondir");
      expect(error.message).toContain("changed while it was read");
      expect(only(fsHooks.read, commondir)).toEqual([]);
      expect(only(fsHooks.closed, commondir)).toHaveLength(1);
    });
  }

  it("refuses a metadata file whose path is gone once it is open", async () => {
    const { root, commondir } = repositoryWithCommondir("causoryn-meta-gone-mock-", ".\n");
    fsHooks.beforeLstat = (file) => {
      if (samePath(file, commondir) && openedAlready(commondir)) throw errnoError("ENOENT");
      return undefined;
    };

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("commondir");
    expect(error.message).toContain("changed while it was read");
    expect(only(fsHooks.read, commondir)).toEqual([]);
    expect(only(fsHooks.closed, commondir)).toHaveLength(1);
  });

  // Replaces the "never opened" half of "a directory where a metadata file is
  // expected is still treated as absent": a directory is now opened read-only
  // (it cannot block) and judged by its descriptor, so the test asserts that
  // it reads as absent and is never read.
  it("a directory where a metadata file is expected is still treated as absent", async () => {
    const { root, gitDir } = fakeRepository("causoryn-meta-dir-");
    const commondir = path.join(gitDir, "commondir");
    mkdirSync(commondir);

    const layout = await validateRepositoryLayout(root, "rev-parse");

    expect(samePath(layout.commonDir, gitDir)).toBe(true);
    expect(only(fsHooks.read, commondir)).toEqual([]);
  });

  // The commondir below names a directory that does not exist: had it been
  // read, the layout would be refused; read as absent, it is accepted.
  it("a metadata file whose opened descriptor is a directory reads as absent and is never read", async () => {
    const { root, gitDir, commondir } = repositoryWithCommondir("causoryn-meta-dir-handle-", "missing-common\n");
    fsHooks.handleStat = (file, real) => (samePath(file, commondir) ? asDirectory(real as AnyStats) : undefined);

    const layout = await validateRepositoryLayout(root, "rev-parse");

    expect(samePath(layout.commonDir, gitDir)).toBe(true);
    expect(only(fsHooks.read, commondir)).toEqual([]);
    expect(only(fsHooks.closed, commondir)).toHaveLength(1);
  });

  for (const code of ["ENOENT", "ENOTDIR", "EISDIR"]) {
    it(`reads a metadata file as absent when its open fails with ${code}`, async () => {
      const { root, gitDir, commondir } = repositoryWithCommondir(
        `causoryn-meta-open-${code.toLowerCase()}-`,
        "missing-common\n",
      );
      fsHooks.beforeOpen = (file) => {
        if (samePath(file, commondir)) throw errnoError(code);
      };

      const layout = await validateRepositoryLayout(root, "rev-parse");

      expect(samePath(layout.commonDir, gitDir)).toBe(true);
    });
  }

  // O_NOFOLLOW makes the open of a final-component link fail with ELOOP.
  it("refuses a metadata file whose open fails with ELOOP (a link at the path) as not a regular file", async () => {
    const { root, commondir } = repositoryWithCommondir("causoryn-meta-open-eloop-", ".\n");
    fsHooks.beforeOpen = (file) => {
      if (samePath(file, commondir)) throw errnoError("ELOOP");
    };

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("commondir");
    expect(error.message).toContain("is not a regular file");
  });

  // Only a missing entry or a directory reads as absent: git may still read a
  // file this check could not open.
  it("refuses a metadata file whose open fails with EACCES and names the error code", async () => {
    const { root, commondir } = repositoryWithCommondir("causoryn-meta-open-eacces-", ".\n");
    fsHooks.beforeOpen = (file) => {
      if (samePath(file, commondir)) throw errnoError("EACCES");
    };

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("commondir");
    expect(error.message).toContain("could not be opened as a regular file");
    expect(error.message).toContain("EACCES");
  });
});

/* ------------------------------------------------------------------ */
/* '..' after a link: physical (POSIX git) vs lexical (Git for Windows) */
/* ------------------------------------------------------------------ */

/**
 * Simulated relative links, so the POSIX layouts run on every platform:
 * git on POSIX applies '..' to the directory a link resolved to, Git for
 * Windows folds it lexically first; a path whose two readings differ is
 * refused.
 */
describe("git metadata paths: '..' after a link is applied to the link target (simulated links, every platform)", () => {
  it("refuses an alternates entry '../l/..' where .git/l is a relative link out of the repository", async () => {
    const { holder, root, gitDir } = nestedRepository("causoryn-meta-dotdot-alt-");
    mkdirSync(path.join(holder, "other", ".git", "objects", "info"), { recursive: true });
    simulateLinks([[path.join(gitDir, "l"), path.join("..", "..", "other", ".git", "objects", "info")]]);
    // Lexically .git/objects/../l/.. = .git; physically <holder>/other/.git/objects.
    writeFileSync(path.join(gitDir, "objects", "info", "alternates"), "../l/..\n", "utf8");

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("objects/info/alternates");
    expectNotNamed(error.message, path.join(holder, "other"));
  });

  it("refuses a .git file 'gitdir: l/../evil' where <root>/l is a relative link (decoy <root>/evil)", async () => {
    const holder = tempDir("causoryn-meta-dotdot-gitfile-");
    const root = path.join(holder, "root");
    gitDirectoryAt(path.join(root, "evil"));
    gitDirectoryAt(path.join(holder, "x", "deep", "evil"));
    mkdirSync(path.join(holder, "x", "deep", "x"), { recursive: true });
    simulateLinks([[path.join(root, "l"), path.join("..", "x", "deep", "x")]]);
    writeFileSync(path.join(root, ".git"), "gitdir: l/../evil\n", "utf8");

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("gitdir pointer");
    expectNotNamed(error.message, path.join(holder, "x"));
  });

  it("refuses a commondir 'l/..' where .git/l is a relative link into another git directory", async () => {
    const { holder, root, gitDir } = nestedRepository("causoryn-meta-dotdot-commondir-");
    gitDirectoryAt(path.join(holder, "other", ".git"));
    mkdirSync(path.join(holder, "other", ".git", "info"), { recursive: true });
    simulateLinks([[path.join(gitDir, "l"), path.join("..", "..", "other", ".git", "info")]]);
    writeFileSync(path.join(gitDir, "commondir"), "l/..\n", "utf8");

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("commondir");
    expectNotNamed(error.message, path.join(holder, "other"));
  });

  // Regression guard for the Win32 reading: the physical reading stays inside
  // the repository here, the lexical one (Git for Windows) leaves it.
  it("also refuses when only the lexical reading leaves the repository", async () => {
    const { holder, root, gitDir } = nestedRepository("causoryn-meta-dotdot-lexical-");
    mkdirSync(path.join(gitDir, "objects", "pack"), { recursive: true });
    mkdirSync(path.join(root, "store"), { recursive: true });
    mkdirSync(path.join(holder, "store"), { recursive: true });
    simulateLinks([[path.join(gitDir, "l"), path.join(gitDir, "objects", "pack")]]);
    // Physically .git/objects/pack/../../.. + store = <root>/store;
    // lexically .git/l/../../../store = <holder>/store.
    writeFileSync(path.join(gitDir, "objects", "info", "alternates"), "../l/../../../store\n", "utf8");

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("objects/info/alternates");
  });

  // config.c handle_path_include: a relative include is joined onto the
  // directory part of the including file's path as git spelled it, so a
  // config file that is itself a link does not move its includes' base.
  it("checks a nested relative include next to a linked config file, where git reads it", async () => {
    const { holder, root, gitDir } = nestedRepository("causoryn-meta-include-base-");
    const stage = path.join(holder, "stage");
    mkdirSync(stage, { recursive: true });
    writeFileSync(path.join(stage, "inc.cfg"), "[include]\n\tpath = nested.cfg\n", "utf8");
    writeFileSync(path.join(stage, "nested.cfg"), "[user]\n\tname = Harmless\n", "utf8");
    writeFileSync(path.join(gitDir, "nested.cfg"), "[include]\n\tpath = //127.0.0.1/causoryn-unused-share/cfg\n", "utf8");
    simulateLinks([[path.join(gitDir, "inc.cfg"), path.join(stage, "inc.cfg")]]);
    writeFileSync(path.join(gitDir, "config"), "[include]\n\tpath = inc.cfg\n", "utf8");

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("network or device path");
  });

  it("accepts a link followed by '..' when both readings name the same directory", async () => {
    const { root, gitDir } = nestedRepository("causoryn-meta-dotdot-same-");
    mkdirSync(path.join(gitDir, "store", "objects", "info"), { recursive: true });
    simulateLinks([[path.join(gitDir, "l"), path.join(gitDir, "store")]]);
    writeFileSync(path.join(gitDir, "objects", "info", "alternates"), "../l/objects/info/..\n", "utf8");

    const layout = await validateRepositoryLayout(root, "rev-parse");

    expect(layout.kind).toBe("git-directory");
  });
});

/**
 * A ".." after a part that does not exist yet cannot be judged: git on POSIX
 * applies it to whatever is created there before git runs, and a symbolic
 * link created there moves it to the link's target. Both readings agreeing
 * on the folded path today proves nothing about that, so it is refused.
 */
describe("git metadata paths: a '..' after a part that does not exist is refused (every platform)", () => {
  it("refuses a config include 'nope/../later.cfg' whose 'nope' does not exist", async () => {
    const { root, gitDir } = fakeRepository("causoryn-meta-missing-dotdot-include-");
    writeFileSync(path.join(gitDir, "config"), "[include]\n\tpath = nope/../later.cfg\n", "utf8");

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("include.path");
    expect(error.message).toContain('"nope/../later.cfg"');
  });

  it("refuses an alternates entry '../nope/../store' whose 'nope' does not exist", async () => {
    const { root, gitDir } = nestedRepository("causoryn-meta-missing-dotdot-alt-");
    writeFileSync(path.join(gitDir, "objects", "info", "alternates"), "../nope/../store\n", "utf8");

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("objects/info/alternates");
    expect(error.message).toContain('"../nope/../store"');
  });

  it("still accepts a missing entry without a '..' after it", async () => {
    const { root, gitDir } = nestedRepository("causoryn-meta-missing-plain-");
    writeFileSync(path.join(gitDir, "config"), "[include]\n\tpath = nope/later.cfg\n", "utf8");
    writeFileSync(path.join(gitDir, "objects", "info", "alternates"), "../nope/store\n", "utf8");

    const layout = await validateRepositoryLayout(root, "rev-parse");

    expect(layout.kind).toBe("git-directory");
  });
});

/* ------------------------------------------------------------------ */
/* lstat failures other than "missing" (every platform)                */
/* ------------------------------------------------------------------ */

describe("git metadata reader: only a missing entry reads as absent (every platform)", () => {
  it("refuses when lstat on the way to a metadata file fails with EACCES", async () => {
    const { root, gitDir } = fakeRepository("causoryn-meta-eacces-walk-");
    const commondir = path.join(gitDir, "commondir");
    writeFileSync(commondir, ".\n", "utf8");
    fsHooks.beforeLstat = (file) => {
      if (samePath(file, commondir)) throw errnoError("EACCES");
      return undefined;
    };

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("commondir");
    expect(error.message).toContain("EACCES");
  });

  // The bounded reader's own (bigint) lstat now follows its open (see the
  // descriptor tests above); a failure there other than "missing" is still a
  // refusal that names the error code.
  it("refuses when the bounded reader's own post-open lstat of a metadata file fails with EPERM", async () => {
    const { root, gitDir } = fakeRepository("causoryn-meta-eperm-read-");
    const commondir = path.join(gitDir, "commondir");
    writeFileSync(commondir, ".\n", "utf8");
    fsHooks.beforeLstat = (file, options) => {
      if (samePath(file, commondir) && options?.bigint === true) throw errnoError("EPERM");
      return undefined;
    };

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("commondir");
    expect(error.message).toContain("EPERM");
  });

  for (const code of ["ENOENT", "ENOTDIR"]) {
    it(`still treats ${code} from lstat as a missing metadata file`, async () => {
      const { root, gitDir } = fakeRepository(`causoryn-meta-${code.toLowerCase()}-`);
      const commondir = path.join(gitDir, "commondir");
      fsHooks.beforeLstat = (file) => {
        if (samePath(file, commondir)) throw errnoError(code);
        return undefined;
      };

      const layout = await validateRepositoryLayout(root, "rev-parse");

      expect(samePath(layout.commonDir, gitDir)).toBe(true);
    });
  }

  // The objects directory's realpath is where its alternates are read: an
  // error other than "missing" must not skip the objects and alternates checks.
  it("refuses when the objects directory cannot be resolved (EACCES) instead of skipping its checks", async () => {
    const { root, gitDir } = nestedRepository("causoryn-meta-eacces-objects-");
    const outsideStore = tempDir("causoryn-meta-eacces-objects-store-");
    writeFileSync(path.join(gitDir, "objects", "info", "alternates"), `${outsideStore}\n`, "utf8");
    const objects = path.join(gitDir, "objects");
    fsHooks.beforeRealpath = (file) => {
      if (samePath(file, objects)) throw errnoError("EACCES");
      return undefined;
    };

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("the objects directory");
    expect(error.message).toContain("EACCES");
    expectNotNamed(error.message, outsideStore);
  });

  for (const code of ["ENOENT", "ENOTDIR"]) {
    it(`still treats ${code} from the objects directory's realpath as a missing objects directory`, async () => {
      const { root, gitDir } = nestedRepository(`causoryn-meta-${code.toLowerCase()}-objects-`);
      const objects = path.join(gitDir, "objects");
      fsHooks.beforeRealpath = (file) => {
        if (samePath(file, objects)) throw errnoError(code);
        return undefined;
      };

      const layout = await validateRepositoryLayout(root, "rev-parse");

      expect(layout.kind).toBe("git-directory");
    });
  }
});

/* ------------------------------------------------------------------ */
/* Refusal messages name metadata text, never resolved outside paths    */
/* ------------------------------------------------------------------ */

describe("git metadata refusals do not name resolved locations outside the workspace (every platform)", () => {
  // The include text names no outside path: every outside location in the
  // refusal would come from resolving it (through .git/in), so none may appear.
  it("names neither an outside link nor its target when an include reaches it through a link in the root", async () => {
    const { root, gitDir } = fakeRepository("causoryn-meta-msg-netlink-");
    const outside = tempDir("causoryn-meta-msg-netlink-outside-");
    simulateLinks([
      [path.join(gitDir, "in"), outside],
      [path.join(outside, "l"), "//127.0.0.1/causoryn-unused-share/x"],
    ]);
    writeFileSync(path.join(gitDir, "config"), "[include]\n\tpath = in/l/x.cfg\n", "utf8");

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("network or device path");
    expect(error.message).toContain('"in/l/x.cfg"');
    expectNotNamed(error.message, outside);
    expect(error.message).not.toContain("causoryn-unused-share");
  });

  // Here the include text itself spells the outside link (with '/' on every
  // platform, so on POSIX it is the link's own path). The refusal quotes that
  // text as written; outside the quote it names neither the link nor its target.
  it("names an outside link that leads to a network path only inside the quoted include text", async () => {
    const { root, gitDir } = fakeRepository("causoryn-meta-msg-netlink-abs-");
    const outside = tempDir("causoryn-meta-msg-netlink-abs-outside-");
    const outsideLink = path.join(outside, "l");
    simulateLinks([[outsideLink, "//127.0.0.1/causoryn-unused-share/x"]]);
    const includeText = `${outsideLink.replace(/\\/g, "/")}/x.cfg`;
    writeFileSync(path.join(gitDir, "config"), `[include]\n\tpath = ${includeText}\n`, "utf8");

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("network or device path");
    const quoted = JSON.stringify(includeText);
    expect(error.message).toContain(quoted);
    expectNotNamed(error.message.split(quoted).join(""), outsideLink);
    expect(error.message).not.toContain("causoryn-unused-share");
  });

  // The included file is made a FIFO through its opened descriptor (formerly
  // through lstat): the reader now decides "not a regular file" on the
  // descriptor, and the refusal must still not name the outside location.
  it("names an included config outside the root by its include text, not its resolved path", async () => {
    const { root, gitDir } = fakeRepository("causoryn-meta-msg-include-");
    const outside = tempDir("causoryn-meta-msg-include-outside-");
    const included = path.join(outside, "x.cfg");
    writeFileSync(included, "[user]\n\tname = x\n", "utf8");
    symlinkSync(outside, path.join(gitDir, "linked"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(path.join(gitDir, "config"), "[include]\n\tpath = linked/x.cfg\n", "utf8");
    fsHooks.handleStat = (file, real) => (samePath(file, included) ? asFifo(real as AnyStats) : undefined);

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("not a regular file");
    expect(error.message).toContain('"linked/x.cfg"');
    expectNotNamed(error.message, outside);
  });
});

/* ------------------------------------------------------------------ */
/* Real FIFOs (POSIX only)                                             */
/* ------------------------------------------------------------------ */

const FIFO_DEADLINE_MS = 3_000;

/** Opens the FIFO for writing (non-blocking) so a reader stuck in open() returns. */
function unblockReaders(fifo: string): void {
  try {
    closeSync(openSync(fifo, fsConstants.O_WRONLY | (fsConstants.O_NONBLOCK ?? 0)));
  } catch {
    // ENXIO: no reader is waiting.
  }
}

async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ readonly settled: "rejected"; readonly error: unknown } | { readonly settled: "resolved" | "timeout" }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ readonly settled: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: "timeout" }), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => ({ settled: "resolved" as const }),
        (error: unknown) => ({ settled: "rejected" as const, error }),
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe.skipIf(process.platform === "win32")("git metadata reader: real FIFOs are refused without blocking (CAU-09, POSIX)", () => {
  const fifoCases: ReadonlyArray<readonly [string, (gitDir: string) => string]> = [
    ["commondir", (gitDir) => path.join(gitDir, "commondir")],
    ["config", (gitDir) => path.join(gitDir, "config")],
    ["objects/info/alternates", (gitDir) => {
      mkdirSync(path.join(gitDir, "objects", "info"), { recursive: true });
      return path.join(gitDir, "objects", "info", "alternates");
    }],
  ];

  for (const [label, place] of fifoCases) {
    it(`a FIFO at ${label} is refused before git starts`, async () => {
      const { root, gitDir } = fakeRepository("causoryn-meta-fifo-");
      const fifo = place(gitDir);
      await execFile("mkfifo", [fifo]);
      const gitCalls: Array<readonly string[]> = [];
      setGitProcessRunnerForTesting((_file, args) => {
        gitCalls.push(args);
        return Promise.reject(new Error("git must not start"));
      });
      try {
        const outcome = await settleWithin(resolveGitCommitRef(root, "HEAD"), FIFO_DEADLINE_MS);
        expect(outcome.settled).toBe("rejected");
        const error = (outcome as { readonly error: unknown }).error;
        expect(error).toBeInstanceOf(GraphRepositoryError);
        expect((error as GraphRepositoryError).code).toBe("compare/repository-refused");
        expect((error as GraphRepositoryError).message).toContain("not a regular file");
        expect(gitCalls.filter((args) => args.includes("-C"))).toEqual([]);
      } finally {
        unblockReaders(fifo);
      }
    }, 15_000);
  }

  it("a FIFO swapped in after lstat is opened non-blocking and refused", async () => {
    const { root, gitDir } = fakeRepository("causoryn-meta-fifo-swap-");
    const commondir = path.join(gitDir, "commondir");
    await execFile("mkfifo", [commondir]);
    // lstat reports the regular file that was there a moment ago.
    fsHooks.lstat = (file, real) => (samePath(file, commondir) ? asRegularFile(real as AnyStats) : undefined);
    try {
      const outcome = await settleWithin(validateRepositoryLayout(root, "rev-parse"), FIFO_DEADLINE_MS);
      expect(outcome.settled).toBe("rejected");
      const error = (outcome as { readonly error: unknown }).error;
      expect(error).toBeInstanceOf(GraphRepositoryError);
      expect((error as GraphRepositoryError).code).toBe("compare/repository-refused");
    } finally {
      unblockReaders(commondir);
    }
  }, 15_000);
});
