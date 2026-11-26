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
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkspaceAccessPolicy } from "@causoryn/workspace";
import { afterEach, describe, expect, it, vi } from "vitest";

import { collectInventory, collectInventoryAsync, type InventoryEntry } from "../src/inventory.js";

/**
 * CAU-02: the inventory's authorization decision is bound to the descriptor
 * it reads. `openSync` is wrapped so a test hook runs immediately before and
 * after the real open(2) of one chosen file, which makes a check-then-open
 * race deterministic on every OS. A hook returns true once it acted on the
 * path it was waiting for.
 */
const hooks = vi.hoisted(() => ({
  beforeOpen: undefined as ((target: string) => boolean) | undefined,
  afterOpen: undefined as ((target: string) => boolean) | undefined,
  run: 0,
}));

function runHook(slot: "beforeOpen" | "afterOpen", target: unknown): void {
  const hook = hooks[slot];
  if (hook !== undefined && hook(String(target))) {
    hooks[slot] = undefined;
    hooks.run += 1;
  }
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    runHook("beforeOpen", args[0]);
    const fd = actual.openSync(...args);
    runHook("afterOpen", args[0]);
    return fd;
  }) as typeof actual.openSync;
  return { ...actual, openSync, default: { ...actual, openSync } };
});

const cleanups: string[] = [];

afterEach(() => {
  hooks.beforeOpen = undefined;
  hooks.afterOpen = undefined;
  hooks.run = 0;
  while (cleanups.length > 0) {
    rmSync(cleanups.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function makeDir(label: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), `causoryn-inv-bind-${label}-`)));
  cleanups.push(dir);
  return dir;
}

const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);
const samePath = (a: string, b: string): boolean => fold(path.resolve(a)) === fold(path.resolve(b));

interface Fixture {
  readonly policy: WorkspaceAccessPolicy;
  readonly canonicalRoot: string;
  readonly target: string;
  readonly swap: () => void;
  readonly restore: () => void;
}

/** `<root>/src/a.ts` plus `<root>/keep.ts`; `swap` replaces `<root>/src` with a junction to an outside directory. */
function makeFixture(label: string): Fixture {
  const root = makeDir(`${label}-root`);
  const outside = makeDir(`${label}-outside`);
  const src = path.join(root, "src");
  const moved = path.join(root, "moved-src");
  mkdirSync(src);
  writeFileSync(path.join(src, "a.ts"), "export const inside = 1;\n", "utf8");
  writeFileSync(path.join(root, "keep.ts"), "export const keep = 1;\n", "utf8");
  writeFileSync(path.join(outside, "a.ts"), "export const outside = 'secret';\n", "utf8");
  const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
  const decision = policy.authorizeRoot(root);
  if (!decision.allowed) throw new Error(`root not authorized: ${decision.reason}`);
  return {
    policy,
    canonicalRoot: decision.canonicalRoot,
    target: path.join(src, "a.ts"),
    swap: () => {
      renameSync(src, moved);
      symlinkSync(outside, src, "junction");
    },
    restore: () => {
      unlinkSync(src);
      renameSync(moved, src);
    },
  };
}

type Collect = (policy: WorkspaceAccessPolicy, canonicalRoot: string) => Promise<InventoryEntry[]>;

const COLLECTORS: ReadonlyArray<readonly [string, Collect]> = [
  ["sync", (policy, canonicalRoot) => Promise.resolve(collectInventory(policy, canonicalRoot, 100))],
  ["async", (policy, canonicalRoot) => collectInventoryAsync(policy, canonicalRoot, 100, 1)],
];

/** Opens the FIFO's write end after `delayMs`, releasing a reader stuck in a blocking open(2). */
function startFifoReleaser(fifoPath: string, delayMs: number): ChildProcess {
  const script = [
    "const fs = require('node:fs');",
    "const [fifo, delay] = process.argv.slice(1);",
    "setTimeout(() => setInterval(() => {",
    "  try { fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch {}",
    "}, 50), Number(delay));",
  ].join("\n");
  return spawn(process.execPath, ["-e", script, fifoPath, String(delayMs)], { stdio: "ignore", shell: false });
}

describe.each(COLLECTORS)("collectInventory (%s) — authorization bound to the opened descriptor", (_label, collect) => {
  it("a directory swapped for a junction before open and restored after it is not indexed", async () => {
    const fixture = makeFixture("swap");
    hooks.beforeOpen = (target) => {
      if (!samePath(target, fixture.target)) return false;
      fixture.swap();
      return true;
    };
    hooks.afterOpen = (target) => {
      if (!samePath(target, fixture.target)) return false;
      fixture.restore();
      return true;
    };

    const entries = await collect(fixture.policy, fixture.canonicalRoot);

    expect(hooks.run).toBe(2);
    expect(entries.some((entry) => entry.content.includes("outside"))).toBe(false);
    expect(entries.map((entry) => entry.relativePath)).toEqual(["keep.ts"]);
  });

  it("untouched regular files keep their content, size and order", async () => {
    const fixture = makeFixture("control");
    const entries = await collect(fixture.policy, fixture.canonicalRoot);

    expect(hooks.run).toBe(0);
    expect(entries.map((entry) => [entry.relativePath, entry.content, entry.sizeBytes])).toEqual([
      ["keep.ts", "export const keep = 1;\n", 23],
      ["src/a.ts", "export const inside = 1;\n", 25],
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "a file replaced by a FIFO before open is skipped without blocking",
    async () => {
      const fixture = makeFixture("fifo");
      let releaser: ChildProcess | undefined;
      hooks.beforeOpen = (target) => {
        if (!samePath(target, fixture.target)) return false;
        unlinkSync(fixture.target);
        if (spawnSync("mkfifo", [fixture.target], { shell: false }).status !== 0) throw new Error("mkfifo failed");
        releaser = startFifoReleaser(fixture.target, 2_500);
        return true;
      };
      try {
        const start = performance.now();
        const entries = await collect(fixture.policy, fixture.canonicalRoot);
        expect(performance.now() - start).toBeLessThan(1_500);
        expect(hooks.run).toBe(1);
        expect(entries.map((entry) => entry.relativePath)).toEqual(["keep.ts"]);
      } finally {
        releaser?.kill();
      }
    },
    10_000,
  );
});
