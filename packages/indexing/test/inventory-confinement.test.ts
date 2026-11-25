import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkspaceAccessPolicy } from "@causoryn/workspace";
import { afterEach, describe, expect, it } from "vitest";

import { IndexingError } from "../src/errors.js";
import { collectInventory, collectInventoryAsync, MAX_INVENTORY_DEPTH } from "../src/inventory.js";

/**
 * Inventory confinement: directory entries that are links (symbolic links,
 * junctions) or other non-regular files are skipped before any policy call
 * stats or resolves them, and directory nesting is bounded explicitly.
 */

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function makeDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

const CAN_CREATE_FILE_SYMLINK: boolean = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), "causoryn-inv-probe-"));
  try {
    writeFileSync(path.join(probe, "t.txt"), "probe");
    symlinkSync(path.join(probe, "t.txt"), path.join(probe, "l.txt"), "file");
    return readFileSync(path.join(probe, "l.txt"), "utf8") === "probe";
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})();

/** Wraps a policy and records every candidate path handed to checkPath/checkFile. */
function recordingPolicy(policy: WorkspaceAccessPolicy): {
  readonly policy: WorkspaceAccessPolicy;
  readonly candidates: string[];
} {
  const candidates: string[] = [];
  const proxy = new Proxy(policy, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if ((property === "checkPath" || property === "checkFile") && typeof value === "function") {
        return (root: string, candidate: string, ...rest: unknown[]) => {
          candidates.push(candidate);
          return (value as (...args: unknown[]) => unknown).call(target, root, candidate, ...rest);
        };
      }
      return value;
    },
  });
  return { policy: proxy, candidates };
}

function canonicalRootOf(policy: WorkspaceAccessPolicy, root: string): string {
  const decision = policy.authorizeRoot(root);
  if (!decision.allowed) throw new Error(`root not authorized: ${decision.reason}`);
  return decision.canonicalRoot;
}

describe("collectInventory — link entries", () => {
  it("skips directory links without handing them to the policy (sync and async)", async () => {
    const root = makeDir("causoryn-inv-links-");
    const outside = makeDir("causoryn-inv-outside-");
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "app.ts"), "export const a = 1;\n");
    writeFileSync(path.join(outside, "secret.ts"), "export const s = 1;\n");
    symlinkSync(outside, path.join(root, "linked-outside"), "junction");
    symlinkSync(path.join(root, "src"), path.join(root, "linked-inside"), "junction");

    const real = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    const canonicalRoot = canonicalRootOf(real, root);

    const sync = recordingPolicy(real);
    const syncEntries = collectInventory(sync.policy, canonicalRoot, 100);
    expect(syncEntries.map((entry) => entry.relativePath)).toEqual(["src/app.ts"]);
    expect(sync.candidates.filter((candidate) => candidate.startsWith("linked-"))).toEqual([]);

    const asyncRun = recordingPolicy(real);
    const asyncEntries = await collectInventoryAsync(asyncRun.policy, canonicalRoot, 100, 1);
    expect(asyncEntries.map((entry) => entry.relativePath)).toEqual(["src/app.ts"]);
    expect(asyncRun.candidates.filter((candidate) => candidate.startsWith("linked-"))).toEqual([]);
  });

  it.skipIf(!CAN_CREATE_FILE_SYMLINK)("skips file links without handing them to the policy", async () => {
    const root = makeDir("causoryn-inv-filelinks-");
    writeFileSync(path.join(root, "app.ts"), "export const a = 1;\n");
    // Explicit link type: the default type detection would stat the target.
    symlinkSync(path.join(root, "app.ts"), path.join(root, "alias.ts"), "file");
    symlinkSync(path.join(root, "missing-target.ts"), path.join(root, "dangling.ts"), "file");

    const real = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    const canonicalRoot = canonicalRootOf(real, root);
    const sync = recordingPolicy(real);
    expect(collectInventory(sync.policy, canonicalRoot, 100).map((entry) => entry.relativePath)).toEqual([
      "app.ts",
    ]);
    expect(sync.candidates).not.toContain("alias.ts");
    expect(sync.candidates).not.toContain("dangling.ts");

    const asyncRun = recordingPolicy(real);
    const asyncEntries = await collectInventoryAsync(asyncRun.policy, canonicalRoot, 100, 1);
    expect(asyncEntries.map((entry) => entry.relativePath)).toEqual(["app.ts"]);
    expect(asyncRun.candidates).not.toContain("alias.ts");
  });
});

describe("collectInventory — directory depth limit", () => {
  function nestedTree(levels: number): string {
    const root = makeDir("causoryn-inv-depth-");
    let current = root;
    for (let level = 1; level <= levels; level += 1) {
      current = path.join(current, `d${String(level)}`);
      mkdirSync(current);
      writeFileSync(path.join(current, `f${String(level)}.ts`), `export const v${String(level)} = ${String(level)};\n`);
    }
    return root;
  }

  it("uses a generous default limit", () => {
    expect(MAX_INVENTORY_DEPTH).toBeGreaterThanOrEqual(64);
  });

  it("walks a tree exactly at the limit", async () => {
    const root = nestedTree(4);
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    const canonicalRoot = canonicalRootOf(policy, root);
    expect(collectInventory(policy, canonicalRoot, 100, 4)).toHaveLength(4);
    expect(await collectInventoryAsync(policy, canonicalRoot, 100, 1, 4)).toHaveLength(4);
  });

  it("fails with limit-exceeded instead of truncating a deeper tree", async () => {
    const root = nestedTree(5);
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    const canonicalRoot = canonicalRootOf(policy, root);

    let syncError: unknown;
    try {
      collectInventory(policy, canonicalRoot, 100, 4);
    } catch (error) {
      syncError = error;
    }
    expect(syncError).toBeInstanceOf(IndexingError);
    expect((syncError as IndexingError).code).toBe("indexing/limit-exceeded");
    expect((syncError as IndexingError).message).toContain("d1/d2/d3/d4/d5");

    await expect(collectInventoryAsync(policy, canonicalRoot, 100, 1, 4)).rejects.toMatchObject({
      code: "indexing/limit-exceeded",
    });
  });

  it("does not count ignored subtrees, which are pruned before descending", () => {
    const root = nestedTree(2);
    let current = path.join(root, "node_modules");
    for (let level = 0; level < 6; level += 1) {
      current = path.join(current, `n${String(level)}`);
    }
    mkdirSync(current, { recursive: true });
    writeFileSync(path.join(current, "deep.js"), "module.exports = 1;\n");
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    const canonicalRoot = canonicalRootOf(policy, root);
    expect(collectInventory(policy, canonicalRoot, 100, 3).map((entry) => entry.relativePath)).toEqual([
      "d1/d2/f2.ts",
      "d1/f1.ts",
    ]);
  });
});
