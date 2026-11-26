import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Total work budgets of one ignore discovery run (F46 / F49):
 * - every pattern attempt of the directory pruning (pruned children included)
 *   is charged, with the steps the matcher really takes, to the match-work
 *   budget; every pattern attempt of the negation-conflict check (a dropped,
 *   conflicting entry pays like any other) to the negation-work budget; and
 *   every directory entry the walks examine to the directory-entry budget;
 * - running out of match work or directory entries stops the walk there (the
 *   patterns accepted so far are kept); running out of negation work keeps
 *   every later entry without the conflict check (more is ignored, nothing a
 *   pattern names is indexed), and discovery goes on;
 * - `limitReached` names the budget and the same input always stops at the
 *   same place.
 */

const matcherAttempts = vi.hoisted(() => ({ count: 0 }));

vi.mock("@causoryn/workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@causoryn/workspace")>();
  return {
    ...actual,
    matchesIgnorePatternWithBudget: (...args: Parameters<typeof actual.matchesIgnorePatternWithBudget>) => {
      matcherAttempts.count += 1;
      return actual.matchesIgnorePatternWithBudget(...args);
    },
    findMatchingIgnorePatternWithBudget: (...args: Parameters<typeof actual.findMatchingIgnorePatternWithBudget>) => {
      const matched = actual.findMatchingIgnorePatternWithBudget(...args);
      const patterns = args[2];
      // Attempts made: up to the matched pattern, or every pattern (also when the budget ran out).
      const index = patterns.findIndex((pattern) => (typeof pattern === "string" ? pattern : pattern.pattern) === matched);
      matcherAttempts.count += matched === undefined ? patterns.length : index + 1;
      return matched;
    },
  };
});

import { IGNORE_PATTERN_ATTEMPT_STEPS } from "@causoryn/workspace";

import { buildWorkspaceAutoConfig } from "../src/index.js";
import {
  MAX_DISCOVERY_DIRECTORY_ENTRIES,
  MAX_DISCOVERY_MATCH_WORK,
  MAX_DISCOVERY_NEGATION_WORK,
  discoverWorkspaceIgnoreConfig,
} from "../src/workspace-ignore-discovery.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "..", "..", "..");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
beforeEach(() => {
  matcherAttempts.count = 0;
});

/** Every attempt costs at least IGNORE_PATTERN_ATTEMPT_STEPS, so a budget bounds the attempts. */
function attemptBound(...budgets: number[]): number {
  return budgets.reduce((sum, budget) => sum + Math.ceil(budget / IGNORE_PATTERN_ATTEMPT_STEPS) + 1, 0);
}

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

function makeNegationAttackRepo(prefix: string, nestedFiles: number): string {
  const repo = makeRepo(prefix);
  writeFileSync(path.join(repo, ".gitignore"), negationConflictLines(3_936).join("\n"), "utf8");
  for (let nested = 0; nested < nestedFiles; nested += 1) {
    const nestedDir = path.join(repo, `pkg${String(nested)}`);
    mkdirSync(nestedDir);
    writeFileSync(path.join(nestedDir, ".gitignore"), negationConflictLines(3_936).join("\n"), "utf8");
  }
  // A nested .gitignore after the hostile ones: still read (the walk goes on).
  mkdirSync(path.join(repo, "zz-late"));
  writeFileSync(path.join(repo, "zz-late", ".gitignore"), "late-secret.txt\n", "utf8");
  return repo;
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
    expect(matcherAttempts.count).toBeLessThanOrEqual(attemptBound(200_000, MAX_DISCOVERY_NEGATION_WORK));
  });

  it("with the default budgets, costly prune patterns against many pruned siblings stay bounded", () => {
    const costly = Array.from({ length: 500 }, (_, index) => `*${"a*".repeat(7)}z${String(index)}${"b".repeat(400)}`);
    const repo = makeRepo("causoryn-ign-budget-f49-default-");
    writeFileSync(path.join(repo, ".gitignore"), [...costly, "x*/"].join("\n"), "utf8");
    for (let index = 0; index < 600; index += 1) mkdirSync(path.join(repo, `x${"a".repeat(200)}${String(index)}`));
    const result = discoverWorkspaceIgnoreConfig(repo);
    expect(matcherAttempts.count).toBeLessThanOrEqual(attemptBound(MAX_DISCOVERY_MATCH_WORK, MAX_DISCOVERY_NEGATION_WORK));
    expect(result.extraIgnore).toContain("x*/");
  });

  it("stops at the same place for the same input (deterministic outcome)", () => {
    const repo = makePrunedSiblingsRepo(300);
    const first = discoverWorkspaceIgnoreConfig(repo, { budgets: { maxDirectoryEntries: 120 } });
    const second = discoverWorkspaceIgnoreConfig(repo, { budgets: { maxDirectoryEntries: 120 } });
    expect(second).toEqual(first);
    expect(first.limitReached).toBe("directory-entries");
  });
});

describe("ignore discovery — negation-conflict budget (F46)", () => {
  it("dropped, conflicting entries are charged; once the budget runs out later entries are kept without the check", () => {
    const repo = makeRepo("causoryn-ign-budget-neg-");
    const lines = negationConflictLines(600);
    writeFileSync(path.join(repo, ".gitignore"), lines.join("\n"), "utf8");
    const unchecked = discoverWorkspaceIgnoreConfig(repo);
    // Within the budget every entry conflicts with the last negation and is dropped.
    expect(unchecked.limitReached).toBeUndefined();
    expect(unchecked.extraIgnore).toEqual([]);

    matcherAttempts.count = 0;
    const result = discoverWorkspaceIgnoreConfig(repo, { budgets: { maxNegationWork: 100_000 } });
    expect(result.limitReached).toBe("negation-work");
    expect(matcherAttempts.count).toBeLessThanOrEqual(attemptBound(100_000, MAX_DISCOVERY_MATCH_WORK));
    // Conservative outcome: the last entry is ignored rather than silently dropped.
    expect(result.extraIgnore).toContain(lines[lines.length - 1]);
  });

  it("with the default budgets, the F46 attack shape is bounded", () => {
    const repo = makeNegationAttackRepo("causoryn-ign-budget-neg-default-", 4);
    const result = discoverWorkspaceIgnoreConfig(repo);
    expect(result.limitReached).toBe("negation-work");
    expect(matcherAttempts.count).toBeLessThanOrEqual(attemptBound(MAX_DISCOVERY_MATCH_WORK, MAX_DISCOVERY_NEGATION_WORK));
    // The kept, unchecked entries fill the 1,000-pattern cap (more is ignored, not less).
    expect(result.extraIgnore.length).toBe(1_000);
  });

  it("a run-out negation budget does not stop the walk: later nested .gitignore files are still read", () => {
    const repo = makeRepo("causoryn-ign-budget-neg-walk-");
    writeFileSync(path.join(repo, ".gitignore"), negationConflictLines(300).join("\n"), "utf8");
    mkdirSync(path.join(repo, "zz-late"));
    writeFileSync(path.join(repo, "zz-late", ".gitignore"), "late-secret.txt\n", "utf8");
    const result = discoverWorkspaceIgnoreConfig(repo, { budgets: { maxNegationWork: 50_000 } });
    expect(result.limitReached).toBe("negation-work");
    expect(result.extraIgnore).toContain("zz-late/**/late-secret.txt");
    expect(result.refinedDefaultIgnore).toBeDefined();
  });

  it("buildWorkspaceAutoConfig reports a reached budget on stderr (logger), and startup goes on", () => {
    const repo = makeNegationAttackRepo("causoryn-ign-budget-log-", 4);
    const logs: string[] = [];
    const config = buildWorkspaceAutoConfig({
      roots: [repo],
      autoDataDir: false,
      logger: (message) => logs.push(message),
    });
    expect(config.allowRoots).toEqual([repo]);
    expect(logs.some((line) => line.includes("ignore discovery") && line.includes("negation-work"))).toBe(true);
  });
});

describe("ignore discovery — normal repositories are unaffected", () => {
  it("this monorepo is discovered without reaching any budget", () => {
    const result = discoverWorkspaceIgnoreConfig(REPO_ROOT);
    expect(result.limitReached).toBeUndefined();
    expect(result.extraIgnore.length).toBeGreaterThan(0);
  });

  it("the default budgets are the documented constants", () => {
    expect(MAX_DISCOVERY_DIRECTORY_ENTRIES).toBe(200_000);
    expect(MAX_DISCOVERY_MATCH_WORK).toBe(300_000_000);
    expect(MAX_DISCOVERY_NEGATION_WORK).toBe(20_000_000);
    expect(IGNORE_PATTERN_ATTEMPT_STEPS).toBe(8);
  });
});
