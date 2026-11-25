import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
} from "../src/safe-file-read.js";

/**
 * Check-then-open races for safe-file-read: the filesystem is changed in the
 * window between the pre-open path verification and open(2). The module's
 * `open`/`openSync` imports are wrapped so a test hook runs immediately
 * before the real open, which makes the race deterministic on every OS.
 */
const hooks = vi.hoisted(() => ({
  beforeOpen: undefined as ((target: string) => void) | undefined,
}));

function runBeforeOpenHook(target: unknown): void {
  const hook = hooks.beforeOpen;
  hooks.beforeOpen = undefined;
  hook?.(String(target));
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    runBeforeOpenHook(args[0]);
    return actual.openSync(...args);
  }) as typeof actual.openSync;
  return { ...actual, default: { ...actual, openSync }, openSync };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    runBeforeOpenHook(args[0]);
    return actual.open(...args);
  }) as typeof actual.open;
  return { ...actual, default: { ...actual, open }, open };
});

const POLICY_DIR = ".causoryn";
const POLICY_FILE = "architecture.rules.yaml";
const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), `causoryn-safe-read-race-${prefix}-`)),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  hooks.beforeOpen = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});

/** See safe-file-read.test.ts: opens the FIFO's write end after `delayMs`. */
function startFifoReleaser(fifoPath: string, delayMs: number): ChildProcess {
  const script = [
    "const fs = require('node:fs');",
    "const [fifo, delay] = process.argv.slice(1);",
    "setTimeout(() => setInterval(() => {",
    "  try { fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch {}",
    "}, 50), Number(delay));",
  ].join("\n");
  return spawn(process.execPath, ["-e", script, fifoPath, String(delayMs)], {
    stdio: "ignore",
    shell: false,
  });
}

interface SwapFixture {
  readonly workspace: string;
  readonly target: string;
  /** Replaces `<workspace>/.causoryn` with a junction/symlink to an outside directory. */
  readonly swapPolicyDir: () => void;
}

function makeSwapFixture(label: string): SwapFixture {
  const workspace = createTempDir(`${label}-ws`);
  const outside = createTempDir(`${label}-outside`);
  mkdirSync(path.join(workspace, POLICY_DIR));
  writeFileSync(path.join(workspace, POLICY_DIR, POLICY_FILE), "inside: 1\n", "utf8");
  writeFileSync(path.join(outside, POLICY_FILE), "outside: 1\n", "utf8");
  const policyDir = path.join(workspace, POLICY_DIR);
  return {
    workspace,
    target: path.join(policyDir, POLICY_FILE),
    swapPolicyDir: () => {
      renameSync(policyDir, path.join(workspace, "moved-policy-dir"));
      symlinkSync(outside, policyDir, "junction");
    },
  };
}

describe("safe-file-read — check-then-open races are detected after open", () => {
  it("async: an intermediate directory swapped for a junction/symlink before open is rejected", async () => {
    const fixture = makeSwapFixture("async");
    hooks.beforeOpen = () => fixture.swapPolicyDir();

    expect(await readOptionalBoundedTextFile(fixture.target, 1024)).toEqual({
      status: "missing",
    });
  });

  it("sync: an intermediate directory swapped for a junction/symlink before open is rejected", () => {
    const fixture = makeSwapFixture("sync");
    hooks.beforeOpen = () => fixture.swapPolicyDir();

    expect(readOptionalBoundedTextFileSync(fixture.target, 1024)).toEqual({
      status: "missing",
    });
  });

  it("with an explicit root, the same swap is rejected (async & sync)", async () => {
    const asyncFixture = makeSwapFixture("root-async");
    hooks.beforeOpen = () => asyncFixture.swapPolicyDir();
    expect(
      await readOptionalBoundedTextFile(asyncFixture.target, 1024, {
        root: asyncFixture.workspace,
      }),
    ).toEqual({ status: "missing" });

    const syncFixture = makeSwapFixture("root-sync");
    hooks.beforeOpen = () => syncFixture.swapPolicyDir();
    expect(
      readOptionalBoundedTextFileSync(syncFixture.target, 1024, {
        root: syncFixture.workspace,
      }),
    ).toEqual({ status: "missing" });
  });

  it("a file replaced by a different regular file before open is rejected (identity mismatch)", async () => {
    const fixture = makeSwapFixture("replace");
    const replaceFile = (): void => {
      const staged = path.join(fixture.workspace, "staged.yaml");
      writeFileSync(staged, "replaced: 1\n", "utf8");
      unlinkSync(fixture.target);
      renameSync(staged, fixture.target);
    };

    hooks.beforeOpen = replaceFile;
    expect(await readOptionalBoundedTextFile(fixture.target, 1024)).toEqual({
      status: "missing",
    });
    hooks.beforeOpen = replaceFile;
    expect(readOptionalBoundedTextFileSync(fixture.target, 1024)).toEqual({
      status: "missing",
    });
  });

  it.skipIf(process.platform === "win32")(
    "a regular file replaced by a FIFO before open neither blocks nor reads (O_NONBLOCK backstop)",
    async () => {
      const fixture = makeSwapFixture("fifo");
      let releaser: ChildProcess | undefined;
      const replaceWithFifo = (): void => {
        unlinkSync(fixture.target);
        const made = spawnSync("mkfifo", [fixture.target], { shell: false });
        if (made.status !== 0) throw new Error("mkfifo failed");
        // Releases a reader stuck in a blocking open(2), so a regression
        // fails the timing assertion instead of hanging the worker.
        releaser = startFifoReleaser(fixture.target, 2_500);
      };
      hooks.beforeOpen = replaceWithFifo;
      try {
        const start = performance.now();
        expect(await readOptionalBoundedTextFile(fixture.target, 1024)).toEqual({
          status: "missing",
        });
        expect(performance.now() - start).toBeLessThan(1_500);
      } finally {
        releaser?.kill();
      }
    },
    10_000,
  );

  it("an untouched file still reads normally through the wrapped open", async () => {
    const fixture = makeSwapFixture("control");
    expect(await readOptionalBoundedTextFile(fixture.target, 1024)).toEqual({
      status: "ok",
      text: "inside: 1\n",
    });
    expect(readOptionalBoundedTextFileSync(fixture.target, 1024)).toEqual({
      status: "ok",
      text: "inside: 1\n",
    });
  });
});
