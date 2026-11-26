import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkspaceAccessPolicy } from "@causoryn/workspace";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readContractFiles } from "../src/index.js";

/**
 * CAU-02: readContractFiles binds the policy decision to the descriptor it
 * reads. `open` and `readFile` from node:fs/promises are wrapped so a test
 * hook runs immediately before and after the real call for one chosen spec
 * file, which makes a check-then-open race deterministic on every OS.
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

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    runHook("beforeOpen", args[0]);
    const handle = await actual.open(...args);
    runHook("afterOpen", args[0]);
    return handle;
  }) as typeof actual.open;
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    runHook("beforeOpen", args[0]);
    const content = await actual.readFile(...args);
    runHook("afterOpen", args[0]);
    return content;
  }) as typeof actual.readFile;
  return { ...actual, open, readFile, default: { ...actual, open, readFile } };
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
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), `causoryn-contract-read-${label}-`)));
  cleanups.push(dir);
  return dir;
}

const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);
const samePath = (a: string, b: string): boolean => fold(path.resolve(a)) === fold(path.resolve(b));

const SPEC = "openapi: 3.1.0\ninfo:\n  title: inside\n  version: 1.0.0\npaths: {}\n";

interface Fixture {
  readonly root: string;
  readonly policy: WorkspaceAccessPolicy;
  readonly target: string;
  readonly swap: () => void;
  readonly restore: () => void;
}

/** `<root>/specs/openapi.yaml`; `swap` replaces `<root>/specs` with a junction to an outside directory. */
function makeFixture(label: string, maxFileBytes?: number): Fixture {
  const root = makeDir(`${label}-root`);
  const outside = makeDir(`${label}-outside`);
  const specs = path.join(root, "specs");
  const moved = path.join(root, "moved-specs");
  mkdirSync(specs);
  writeFileSync(path.join(specs, "openapi.yaml"), SPEC, "utf8");
  writeFileSync(path.join(outside, "openapi.yaml"), SPEC.replace("inside", "outside"), "utf8");
  const policy = WorkspaceAccessPolicy.create(
    maxFileBytes === undefined ? { allowRoots: [root] } : { allowRoots: [root], maxFileBytes },
  );
  return {
    root,
    policy,
    target: path.join(specs, "openapi.yaml"),
    swap: () => {
      renameSync(specs, moved);
      symlinkSync(outside, specs, "junction");
    },
    restore: () => {
      unlinkSync(specs);
      renameSync(moved, specs);
    },
  };
}

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

describe("readContractFiles — authorization bound to the opened descriptor", () => {
  it("a directory swapped for a junction before open and restored after it fails with contracts/file-not-authorized", async () => {
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

    await expect(readContractFiles(fixture.root, fixture.policy, ["specs/openapi.yaml"])).rejects.toMatchObject({
      code: "contracts/file-not-authorized",
    });
    expect(hooks.run).toBe(2);
  });

  it("a spec that grows past maxFileBytes after the policy check fails with contracts/limit-exceeded", async () => {
    const fixture = makeFixture("grow", 4096);
    hooks.beforeOpen = (target) => {
      if (!samePath(target, fixture.target)) return false;
      appendFileSync(fixture.target, `# ${"x".repeat(8192)}\n`, "utf8");
      return true;
    };

    await expect(readContractFiles(fixture.root, fixture.policy, ["specs/openapi.yaml"])).rejects.toMatchObject({
      code: "contracts/limit-exceeded",
    });
    expect(hooks.run).toBe(1);
  });

  it("a directory candidate fails with contracts/file-not-authorized instead of a raw EISDIR", async () => {
    const fixture = makeFixture("dir");

    await expect(readContractFiles(fixture.root, fixture.policy, ["specs"])).rejects.toMatchObject({
      code: "contracts/file-not-authorized",
    });
  });

  it("accepts a spec of exactly maxFileBytes and rejects one byte more", async () => {
    const exact = Buffer.byteLength(SPEC, "utf8");
    const fixture = makeFixture("boundary", exact);

    await expect(readContractFiles(fixture.root, fixture.policy, ["specs/openapi.yaml"])).resolves.toEqual([
      { relativePath: "specs/openapi.yaml", text: SPEC },
    ]);
    appendFileSync(fixture.target, "\n", "utf8");
    await expect(readContractFiles(fixture.root, fixture.policy, ["specs/openapi.yaml"])).rejects.toMatchObject({
      code: "contracts/limit-exceeded",
    });
  });

  it("an untouched spec is read with its exact text", async () => {
    const fixture = makeFixture("control");

    await expect(readContractFiles(fixture.root, fixture.policy, ["./specs/openapi.yaml"])).resolves.toEqual([
      { relativePath: "specs/openapi.yaml", text: SPEC },
    ]);
    expect(hooks.run).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "a FIFO spec fails with contracts/file-not-authorized without blocking",
    async () => {
      const fixture = makeFixture("fifo");
      const fifo = path.join(fixture.root, "specs", "pipe.yaml");
      expect(spawnSync("mkfifo", [fifo], { shell: false }).status).toBe(0);
      const releaser = startFifoReleaser(fifo, 2_500);
      try {
        const start = performance.now();
        await expect(readContractFiles(fixture.root, fixture.policy, ["specs/pipe.yaml"])).rejects.toMatchObject({
          code: "contracts/file-not-authorized",
        });
        expect(performance.now() - start).toBeLessThan(1_500);
      } finally {
        releaser.kill();
      }
    },
    10_000,
  );
});
