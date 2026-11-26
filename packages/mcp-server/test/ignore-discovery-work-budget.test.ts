import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Total work budgets of one ignore discovery run (F46 / F49):
 * - every pattern match of the negation-conflict check and of the directory
 *   pruning is charged to one match-work budget (a dropped, conflicting entry
 *   pays like any other), so per-file caps can no longer multiply into hundreds
 *   of millions of synchronous matches at startup;
 * - every directory entry examined by the walks (pruned or not) is charged to
 *   one directory-entry budget, so pruned siblings no longer escape the
 *   visited-directory and queue caps.
 * A budget that runs out stops discovery there with a controlled outcome: the
 * patterns accepted so far are kept, `limitReached` names the budget, and the
 * same input always stops at the same place.
 */

const matcherCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("@causoryn/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@causoryn/workspace")>();
  return {
    ...actual,
    matchesIgnorePattern: (...args: Parameters<typeof actual.matchesIgnorePattern>) => {
      matcherCalls.count += 1;
      return actual.matchesIgnorePattern(...args);
    },
    findMatchingIgnorePattern: (...args: Parameters<typeof actual.findMatchingIgnorePattern>) => {
      const [candidate, isDirectory, patterns] = args;
      for (const pattern of patterns) {
        matcherCalls.count += 1;
        if (actual.matchesIgnorePattern(candidate, isDirectory, pattern)) return pattern;
      }
      return undefined;
    },
  };
});

import { buildWorkspaceAutoConfig } from "../src/index.js";
import {
  DISCOVERY_MATCH_CALL_COST,
  MAX_DISCOVERY_DIRECTORY_ENTRIES,
  MAX_DISCOVERY_MATCH_WORK,
  discoverWorkspaceIgnoreConfig,
} from "../src/workspace-ignore-discovery.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "..", "..", "..");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
beforeEach(() => {
  matcherCalls.count = 0;
});

function makeRepo(prefix: string): string {
  const base = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(base);
  const repo = path.join(base, "repo");
  mkdirSync(repo, { recursive: true });
  return repo;
}

/** Many sibling directories that a prune pattern of the root .gitignore matches. */
function makePrunedSiblingsRepo(count: number, extraPatterns: readonly string[] = []): string {
  const repo = makeRepo("causoryn-ign-budget-pruned-");
  writeFileSync(path.join(repo, ".gitignore"), [...extraPatterns, "pruned-*/", ""].join("\n"), "utf8");
  for (let index = 0; index < count; index += 1) {
    mkdirSync(path.join(repo, `pruned-${String(index).padStart(4, "0")}`));
  }
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "src", "app.ts"), "export const a = 1;\n", "utf8");
  return repo;
}

/**
 * The F46 shape: 64 deep, wildcarded negations and thousands of distinct
 * entries that each conflict only with the last negation, so every entry is
 * checked against every negation target and dropped without using the
 * pattern budget.
 */
function negationConflictLines(entryCount: number): string[] {
  const lines: string[] = [];
  for (let target = 0; target < 64; target += 1) {
    lines.push(`!a/b/c/d/e/f/g/h/x${String(target)}*`);
  }
  for (let entry = 0; entry < entryCount; entry += 1) {
    lines.push(`a/b/c/d/e/f/g/h/x63*q${String(entry)}`);
  }
  return lines;
}

describe("ignore discovery — directory-entry budget (F49)", () => {
  it("counts pruned child directories: a repository of pruned siblings stops at the budget", () => {
    const repo = makePrunedSiblingsRepo(300);
    const result = discoverWorkspaceIgnoreConfig(repo, { budgets: { maxDirectoryEntries: 100 } });
    expect(result.limitReached).toBe("directory-entries");
    // The root .gitignore was accepted before the walk stopped.
    expect(result.extraIgnore).toContain("pruned-*/");
  });

  it("charges the prune matches of pruned children to the match-work budget", () => {
    const costly = Array.from({ length: 200 }, (_, index) => `*z${String(index)}*y*x*w*v*`);
    const repo = makePrunedSiblingsRepo(300, costly);
    const result = discoverWorkspaceIgnoreConfig(repo, { budgets: { maxMatchWork: 200_000 } });
    expect(result.limitReached).toBe("match-work");
    expect(matcherCalls.count).toBeLessThanOrEqual(Math.ceil(200_000 / DISCOVERY_MATCH_CALL_COST) + 1);
  });

  it("stops at the same place for the same input (deterministic outcome)", () => {
    const repo = makePrunedSiblingsRepo(300);
    const first = discoverWorkspaceIgnoreConfig(repo, { budgets: { maxDirectoryEntries: 120 } });
    const second = discoverWorkspaceIgnoreConfig(repo, { budgets: { maxDirectoryEntries: 120 } });
    expect(second).toEqual(first);
    expect(first.limitReached).toBe("directory-entries");
  });
});

describe("ignore discovery — negation-conflict match budget (F46)", () => {
  it("dropped, conflicting entries are charged: a small budget stops the parse", () => {
    const repo = makeRepo("causoryn-ign-budget-neg-");
    writeFileSync(path.join(repo, ".gitignore"), negationConflictLines(600).join("\n"), "utf8");
    const result = discoverWorkspaceIgnoreConfig(repo, { budgets: { maxMatchWork: 1_000_000 } });
    expect(result.limitReached).toBe("match-work");
    expect(matcherCalls.count).toBeLessThanOrEqual(Math.ceil(1_000_000 / DISCOVERY_MATCH_CALL_COST) + 1);
  });

  it("with the default budgets, the F46 attack shape is bounded by the documented match-work budget", () => {
    const repo = makeRepo("causoryn-ign-budget-neg-default-");
    writeFileSync(path.join(repo, ".gitignore"), negationConflictLines(3_936).join("\n"), "utf8");
    for (let nested = 0; nested < 4; nested += 1) {
      const nestedDir = path.join(repo, `pkg${String(nested)}`);
      mkdirSync(nestedDir);
      writeFileSync(path.join(nestedDir, ".gitignore"), negationConflictLines(3_936).join("\n"), "utf8");
    }
    const result = discoverWorkspaceIgnoreConfig(repo);
    expect(result.limitReached).toBe("match-work");
    expect(matcherCalls.count).toBeLessThanOrEqual(Math.ceil(MAX_DISCOVERY_MATCH_WORK / DISCOVERY_MATCH_CALL_COST) + 1);
  });

  it("buildWorkspaceAutoConfig reports a stopped discovery on stderr (logger), and startup goes on", () => {
    const repo = makeRepo("causoryn-ign-budget-log-");
    writeFileSync(path.join(repo, ".gitignore"), negationConflictLines(3_936).join("\n"), "utf8");
    for (let nested = 0; nested < 4; nested += 1) {
      const nestedDir = path.join(repo, `pkg${String(nested)}`);
      mkdirSync(nestedDir);
      writeFileSync(path.join(nestedDir, ".gitignore"), negationConflictLines(3_936).join("\n"), "utf8");
    }
    const logs: string[] = [];
    const config = buildWorkspaceAutoConfig({
      roots: [repo],
      autoDataDir: false,
      logger: (message) => logs.push(message),
    });
    expect(config.allowRoots).toEqual([repo]);
    expect(logs.some((line) => line.includes("ignore discovery") && line.includes("match-work"))).toBe(true);
  });
});

describe("ignore discovery — normal repositories are unaffected", () => {
  it("this monorepo is discovered without reaching either budget", () => {
    const result = discoverWorkspaceIgnoreConfig(REPO_ROOT);
    expect(result.limitReached).toBeUndefined();
    expect(result.extraIgnore.length).toBeGreaterThan(0);
  });

  it("the default budgets are the documented constants", () => {
    expect(MAX_DISCOVERY_DIRECTORY_ENTRIES).toBe(200_000);
    expect(MAX_DISCOVERY_MATCH_WORK).toBe(250_000_000);
    expect(DISCOVERY_MATCH_CALL_COST).toBe(100);
  });
});
