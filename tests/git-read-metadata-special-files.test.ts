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
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type BigIntStats,
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
  opened: [] as Array<{ readonly file: string; readonly flags: unknown }>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const lstat = async (file: import("node:fs").PathLike, options?: import("node:fs").StatOptions) => {
    const real = await actual.lstat(file, options);
    return fsHooks.lstat === undefined ? real : (fsHooks.lstat(String(file), real) ?? real);
  };
  const open = async (
    file: import("node:fs").PathLike,
    flags?: string | number,
    mode?: import("node:fs").Mode,
  ) => {
    fsHooks.opened.push({ file: String(file), flags });
    return actual.open(file, flags, mode);
  };
  return { ...actual, lstat, open };
});

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
afterEach(() => {
  fsHooks.lstat = undefined;
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
