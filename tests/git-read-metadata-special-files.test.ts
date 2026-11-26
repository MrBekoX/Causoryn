/**
 * CAU-09 (CWE-400): the git metadata reader in git-repository-layout.ts must
 * never block on a special file. Each metadata file is checked with lstat
 * first (regular files only), opened with O_RDONLY|O_NOFOLLOW|O_NONBLOCK where
 * the platform defines them, and the opened handle must be the same file
 * (dev, ino) the lstat saw. This all happens before git is started, so the git
 * subprocess timeout cannot cover a blocked open.
 *
 * The fs-level ordering tests run on every platform through a pass-through
 * mock of node:fs/promises; the real FIFO tests are POSIX-only and guarded by
 * a timeout (and a writer that unblocks a stuck reader) so they cannot hang CI.
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
  /** Replaces the lstat result for one path (pass-through when undefined). */
  lstat: undefined as undefined | ((file: string, real: unknown) => unknown),
  /**
   * Runs before the real lstat: a returned value is the result (no real lstat),
   * a thrown error is the failure, undefined passes through.
   */
  beforeLstat: undefined as undefined | ((file: string, options?: import("node:fs").StatOptions) => unknown),
  /** Link text for a simulated symbolic link (undefined: real readlink). */
  readlink: undefined as undefined | ((file: string) => string | undefined),
  opened: [] as Array<{ readonly file: string; readonly flags: unknown }>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const lstat = async (file: import("node:fs").PathLike, options?: import("node:fs").StatOptions) => {
    const replaced = fsHooks.beforeLstat?.(String(file), options);
    if (replaced !== undefined) return replaced;
    const real = await actual.lstat(file, options);
    return fsHooks.lstat === undefined ? real : (fsHooks.lstat(String(file), real) ?? real);
  };
  const readlink = async (file: import("node:fs").PathLike, options?: unknown) => {
    const text = fsHooks.readlink?.(String(file));
    if (text !== undefined) return text;
    return actual.readlink(file, options as never);
  };
  const open = async (
    file: import("node:fs").PathLike,
    flags?: string | number,
    mode?: import("node:fs").Mode,
  ) => {
    fsHooks.opened.push({ file: String(file), flags });
    return actual.open(file, flags, mode);
  };
  return { ...actual, lstat, readlink, open };
});

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
afterEach(() => {
  fsHooks.lstat = undefined;
  fsHooks.beforeLstat = undefined;
  fsHooks.readlink = undefined;
  fsHooks.opened.length = 0;
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

describe("git metadata reader: lstat before open (CAU-09, every platform)", () => {
  it("never opens a metadata file that lstat does not report as a regular file", async () => {
    const { root, gitDir } = fakeRepository("causoryn-meta-fifo-mock-");
    const commondir = path.join(gitDir, "commondir");
    writeFileSync(commondir, ".\n", "utf8");
    fsHooks.lstat = (file, real) => (samePath(file, commondir) ? asFifo(real as AnyStats) : undefined);

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("not a regular file");
    expect(fsHooks.opened.filter((entry) => samePath(entry.file, commondir))).toEqual([]);
  });

  it("refuses a metadata file whose opened handle is not the file lstat saw", async () => {
    const { root, gitDir } = fakeRepository("causoryn-meta-swap-mock-");
    const commondir = path.join(gitDir, "commondir");
    writeFileSync(commondir, ".\n", "utf8");
    fsHooks.lstat = (file, real) => (samePath(file, commondir) ? withOtherInode(real as AnyStats) : undefined);

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("changed while it was read");
  });

  it("opens metadata files read-only with O_NOFOLLOW and O_NONBLOCK where the platform defines them", async () => {
    const { root, gitDir } = fakeRepository("causoryn-meta-flags-");
    const commondir = path.join(gitDir, "commondir");
    writeFileSync(commondir, ".\n", "utf8");

    const layout = await validateRepositoryLayout(root, "rev-parse");

    expect(samePath(layout.commonDir, gitDir)).toBe(true);
    const opens = fsHooks.opened.filter((entry) => samePath(entry.file, commondir));
    expect(opens).toHaveLength(1);
    const flags = opens[0]!.flags;
    expect(typeof flags).toBe("number");
    const required = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
    expect((flags as number) & required).toBe(required);
    expect((flags as number) & (fsConstants.O_WRONLY | fsConstants.O_RDWR)).toBe(0);
  });

  it("a directory where a metadata file is expected is still treated as absent", async () => {
    const { root, gitDir } = fakeRepository("causoryn-meta-dir-");
    mkdirSync(path.join(gitDir, "commondir"));

    const layout = await validateRepositoryLayout(root, "rev-parse");

    expect(samePath(layout.commonDir, gitDir)).toBe(true);
    expect(fsHooks.opened.filter((entry) => samePath(entry.file, path.join(gitDir, "commondir")))).toEqual([]);
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

  it("refuses when the bounded reader's own lstat of a metadata file fails with EPERM", async () => {
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
});

/* ------------------------------------------------------------------ */
/* Refusal messages name metadata text, never resolved outside paths    */
/* ------------------------------------------------------------------ */

describe("git metadata refusals do not name resolved locations outside the workspace (every platform)", () => {
  it("does not name a link outside the root, nor its target, when it leads to a network path", async () => {
    const { root, gitDir } = fakeRepository("causoryn-meta-msg-netlink-");
    const outside = tempDir("causoryn-meta-msg-netlink-outside-");
    const outsideLink = path.join(outside, "l");
    simulateLinks([[outsideLink, "\\\\127.0.0.1\\causoryn-unused-share\\x"]]);
    writeFileSync(
      path.join(gitDir, "config"),
      `[include]\n\tpath = ${outsideLink.replace(/\\/g, "/")}/x.cfg\n`,
      "utf8",
    );

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("network or device path");
    expectNotNamed(error.message, outsideLink);
    expect(error.message).not.toContain("causoryn-unused-share");
  });

  it("names an included config outside the root by its include text, not its resolved path", async () => {
    const { root, gitDir } = fakeRepository("causoryn-meta-msg-include-");
    const outside = tempDir("causoryn-meta-msg-include-outside-");
    const included = path.join(outside, "x.cfg");
    writeFileSync(included, "[user]\n\tname = x\n", "utf8");
    symlinkSync(outside, path.join(gitDir, "linked"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(path.join(gitDir, "config"), "[include]\n\tpath = linked/x.cfg\n", "utf8");
    fsHooks.lstat = (file, real) => (samePath(file, included) ? asFifo(real as AnyStats) : undefined);

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
