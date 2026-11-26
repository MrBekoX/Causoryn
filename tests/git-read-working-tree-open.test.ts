/**
 * readGitBlob(root, "working-tree", path) opens a working-tree file after an
 * lstat that saw a regular file. A FIFO swapped in after that lstat must not
 * tie up a threadpool thread in open(): where the platform defines them the
 * file is opened with O_NONBLOCK (a FIFO open returns at once) and O_NOCTTY
 * (a terminal device never becomes the controlling terminal), next to
 * O_RDONLY|O_NOFOLLOW; the post-open handle check then refuses anything that
 * is not a regular file.
 *
 * The flag test runs on every platform: node:fs constants are mocked so the
 * O_* bits only POSIX defines are present (and stripped again before the real
 * open where the platform does not know them). The real FIFO test is
 * POSIX-only and guarded by a deadline and a writer that unblocks a stuck
 * reader, so it cannot hang CI.
 */
import { execFile as execFileCallback } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
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
import { readGitBlob } from "../packages/graph/src/git-read.js";

const execFile = promisify(execFileCallback);

type AnyStats = Stats | BigIntStats;

const hooks = vi.hoisted(() => ({
  /** O_* bits the mocked constants add because this platform does not define them. */
  fakeBits: 0,
  opened: [] as Array<{ readonly file: string; readonly flags: unknown }>,
  /** Replaces the lstat result for one path (pass-through when undefined). */
  lstat: undefined as undefined | ((file: string, real: unknown) => unknown),
  /** Replaces what FileHandle.stat() reports for the opened file. */
  handleStat: undefined as undefined | ((real: unknown) => unknown),
}));

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
  hooks.fakeBits = fake;
  const constants = { ...actual.constants, ...extra };
  return { ...actual, constants, default: { ...actual, constants } };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const lstat = async (file: import("node:fs").PathLike, options?: import("node:fs").StatOptions) => {
    const real = await actual.lstat(file, options);
    return hooks.lstat === undefined ? real : (hooks.lstat(String(file), real) ?? real);
  };
  const open = async (
    file: import("node:fs").PathLike,
    flags?: string | number,
    mode?: import("node:fs").Mode,
  ) => {
    hooks.opened.push({ file: String(file), flags });
    const handle = await actual.open(file, typeof flags === "number" ? flags & ~hooks.fakeBits : flags, mode);
    const override = hooks.handleStat;
    if (override !== undefined) {
      const realStat = handle.stat.bind(handle);
      Object.defineProperty(handle, "stat", {
        value: async (options?: import("node:fs").StatOptions) => override(await realStat(options as never)),
      });
    }
    return handle;
  };
  return { ...actual, lstat, open };
});

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
afterEach(() => {
  hooks.opened.length = 0;
  hooks.lstat = undefined;
  hooks.handleStat = undefined;
});

function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === "";
}

function withKind(real: AnyStats, kind: "file" | "fifo"): AnyStats {
  return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as AnyStats, real, {
    isFile: () => kind === "file",
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => kind === "fifo",
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

describe("working-tree blob reads: open flags (every platform)", () => {
  it("opens the file read-only with O_NOFOLLOW, O_NONBLOCK and O_NOCTTY where the platform defines them", async () => {
    const root = tempDir("causoryn-wt-open-flags-");
    const file = path.join(root, "a.txt");
    writeFileSync(file, "content\n", "utf8");

    expect(await readGitBlob(root, "working-tree", "a.txt")).toBe("content\n");

    const opens = hooks.opened.filter((entry) => samePath(entry.file, file));
    expect(opens).toHaveLength(1);
    const flags = opens[0]!.flags;
    expect(typeof flags).toBe("number");
    const required =
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOCTTY ?? 0);
    // The mocked constants define all three bits on every platform.
    expect(fsConstants.O_NONBLOCK).toBeDefined();
    expect(fsConstants.O_NOCTTY).toBeDefined();
    expect((flags as number) & required).toBe(required);
    expect((flags as number) & (fsConstants.O_WRONLY | fsConstants.O_RDWR)).toBe(0);
  });

  it("refuses an opened handle that is not a regular file", async () => {
    const root = tempDir("causoryn-wt-open-kind-");
    writeFileSync(path.join(root, "a.txt"), "content\n", "utf8");
    hooks.handleStat = (real) => withKind(real as AnyStats, "fifo");

    const error = await rejection(() => readGitBlob(root, "working-tree", "a.txt"));

    expect(error.code).toBe("compare/invalid-blob-path");
    expect(error.message).toContain("not a regular file");
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

describe.skipIf(process.platform === "win32")("working-tree blob reads: a FIFO swapped in after lstat (POSIX)", () => {
  it("opens it without blocking and refuses it", async () => {
    const root = tempDir("causoryn-wt-open-fifo-");
    const fifo = path.join(root, "a.txt");
    await execFile("mkfifo", [fifo]);
    // lstat reports the regular file that was there a moment ago.
    hooks.lstat = (file, real) => (samePath(file, fifo) ? withKind(real as AnyStats, "file") : undefined);
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        readGitBlob(root, "working-tree", "a.txt").then(
          () => ({ settled: "resolved" as const }),
          (error: unknown) => ({ settled: "rejected" as const, error }),
        ),
        new Promise<{ readonly settled: "timeout" }>((resolve) => {
          timer = setTimeout(() => resolve({ settled: "timeout" }), FIFO_DEADLINE_MS);
        }),
      ]);
      expect(outcome.settled).toBe("rejected");
      const error = (outcome as { readonly error: unknown }).error;
      expect(error).toBeInstanceOf(GraphRepositoryError);
      expect((error as GraphRepositoryError).code).toBe("compare/invalid-blob-path");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      unblockReaders(fifo);
    }
  }, 15_000);
});
