import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkspaceAccessPolicy } from "@causoryn/workspace";
import { afterEach, describe, expect, it } from "vitest";

import { IndexingError } from "../src/errors.js";
import { collectInventory, collectInventoryAsync, MAX_INVENTORY_DEPTH } from "../src/inventory.js";

/**
 * Ignore-matching work of one inventory run is bounded as a whole (Claude
 * Security F32): every policy decision reports its matcher steps, the run stops
 * with `indexing/limit-exceeded` once their sum passes a total budget, and a path
 * the policy could not decide within its per-pass budget is never left out
 * silently: the run reports how many there were and stops.
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

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function caughtAsync(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A 24-level `a/a/…` chain with one file below it, plus an ordinary file at the root. */
function seedChain(root: string): string {
  const chain = Array.from({ length: 24 }, () => "a");
  mkdirSync(path.join(root, ...chain), { recursive: true });
  writeFileSync(path.join(root, ...chain, "deep.ts"), "export const deep = 1;\n");
  writeFileSync(path.join(root, "app.ts"), "export const app = 1;\n");
  return chain.join("/");
}

/** Patterns whose ignore pass over the chain exhausts the per-pass budget around depth 15 (1.7M steps at 24). */
function craftedPatterns(): string[] {
  const literals = Array.from({ length: 16 }, () => "a").join("/");
  return Array.from({ length: 3_000 }, (_, i) => `**/${literals}/b${String(i).padStart(4, "0")}`);
}

describe("inventory — ignore work budget (F32)", () => {
  it("stops with limit-exceeded, and says so, when the policy cannot decide a path within its budget", async () => {
    const root = makeDir("causoryn-inv-budget-");
    seedChain(root);
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root], extraIgnore: craftedPatterns() });

    for (const error of [
      caught(() => collectInventory(policy, root, 1_000)),
      await caughtAsync(() => collectInventoryAsync(policy, root, 1_000)),
    ]) {
      expect(error).toBeInstanceOf(IndexingError);
      expect((error as IndexingError).code).toBe("indexing/limit-exceeded");
      expect((error as IndexingError).message).toMatch(/1 path\(s\)/);
      expect((error as IndexingError).message).toMatch(/work budget/);
    }
  });

  it("stops with limit-exceeded once the run's total ignore work passes its budget", async () => {
    const root = makeDir("causoryn-inv-total-");
    mkdirSync(path.join(root, "src"));
    for (let i = 0; i < 20; i += 1) {
      writeFileSync(path.join(root, "src", `file-${String(i).padStart(2, "0")}.ts`), `export const v${String(i)} = 1;\n`);
    }
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });

    for (const error of [
      caught(() => collectInventory(policy, root, 1_000, MAX_INVENTORY_DEPTH, 5_000)),
      await caughtAsync(() => collectInventoryAsync(policy, root, 1_000, 64, MAX_INVENTORY_DEPTH, 5_000)),
    ]) {
      expect(error).toBeInstanceOf(IndexingError);
      expect((error as IndexingError).code).toBe("indexing/limit-exceeded");
      expect((error as IndexingError).message).toMatch(/total ignore matching work budget \(5000 steps\)/);
    }
  });

  it("indexes an ordinary tree unchanged under the default budgets", async () => {
    const root = makeDir("causoryn-inv-ordinary-");
    const chain = seedChain(root);
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });

    const sync = collectInventory(policy, root, 1_000).map((entry) => entry.relativePath);
    const asyncPaths = (await collectInventoryAsync(policy, root, 1_000)).map((entry) => entry.relativePath);
    expect(sync).toEqual([`${chain}/deep.ts`, "app.ts"]);
    expect(asyncPaths).toEqual(sync);
  });
});
