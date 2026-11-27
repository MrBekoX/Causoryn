import { describe, expect, it } from "vitest";

import {
  compileIgnorePattern,
  DEFAULT_IGNORE_PATTERNS,
  findMatchingIgnorePattern,
  findMatchingIgnorePatternWithBudget,
  IGNORE_PATTERN_ATTEMPT_STEPS,
  matchesIgnorePattern,
  matchesIgnorePatternWithBudget,
} from "@causoryn/workspace";

/**
 * The budgeted single-pattern matchers used by ignore discovery (F46 / F49
 * round 2) decide exactly like matchesIgnorePattern / findMatchingIgnorePattern
 * whenever the budget suffices, charge at least IGNORE_PATTERN_ATTEMPT_STEPS
 * per attempt, and report a run-out budget through `remaining < 0`.
 */

const PATTERNS: readonly string[] = [
  ...DEFAULT_IGNORE_PATTERNS,
  "*.log",
  "build/",
  "/dist",
  "src/**/generated/*.ts",
  "**/cache/**",
  "a?c",
  "*a*b*c",
  "docs/**",
  "**",
  "x/**/y/",
  "foo\\bar",
  "**/*.tsbuildinfo",
  "packages/*/node_modules/",
];

const CANDIDATES: ReadonlyArray<readonly [string, boolean]> = [
  ["src/app.log", false],
  ["build", true],
  ["build", false],
  ["dist", true],
  ["nested/dist", true],
  ["src/a/b/generated/x.ts", false],
  ["src/generated/x.ts", false],
  ["lib/cache/z", true],
  ["abc", false],
  ["aXbYc", false],
  ["docs", true],
  ["docs/a/b.md", false],
  ["x/y", true],
  ["x/1/2/y", true],
  ["foo/bar", false],
  ["packages/app/node_modules", true],
  ["node_modules/pkg", true],
  [".git/config", false],
  ["Src/App.LOG", false],
  ["", true],
];

describe("budgeted ignore matchers — parity with the unbudgeted ones", () => {
  it("matchesIgnorePatternWithBudget decides like matchesIgnorePattern with an ample budget", () => {
    for (const pattern of PATTERNS) {
      for (const [candidate, isDirectory] of CANDIDATES) {
        const budget = { remaining: 1_000_000 };
        const expected = matchesIgnorePattern(candidate, isDirectory, pattern);
        expect(matchesIgnorePatternWithBudget(candidate, isDirectory, pattern, budget), `${pattern} vs ${candidate}`).toBe(expected);
        expect(budget.remaining).toBeGreaterThanOrEqual(0);
        expect(1_000_000 - budget.remaining).toBeGreaterThanOrEqual(IGNORE_PATTERN_ATTEMPT_STEPS);
      }
    }
  });

  it("findMatchingIgnorePatternWithBudget returns the first matching pattern like findMatchingIgnorePattern", () => {
    for (const [candidate, isDirectory] of CANDIDATES) {
      const budget = { remaining: 1_000_000 };
      expect(findMatchingIgnorePatternWithBudget(candidate, isDirectory, PATTERNS, budget), candidate).toBe(
        findMatchingIgnorePattern(candidate, isDirectory, PATTERNS),
      );
    }
  });

  it("charges every attempt: the list variant spends at least one attempt cost per pattern tried", () => {
    const budget = { remaining: 1_000_000 };
    expect(findMatchingIgnorePatternWithBudget("no/match/here", true, ["a", "b", "c", "d"], budget)).toBeUndefined();
    expect(1_000_000 - budget.remaining).toBeGreaterThanOrEqual(4 * IGNORE_PATTERN_ATTEMPT_STEPS);
  });

  it("a run-out budget is reported through remaining < 0 and never as a match", () => {
    const tiny = { remaining: 3 };
    expect(matchesIgnorePatternWithBudget("a/b/c", true, "**", tiny)).toBe(false);
    expect(tiny.remaining).toBeLessThan(0);
    const listBudget = { remaining: IGNORE_PATTERN_ATTEMPT_STEPS };
    expect(findMatchingIgnorePatternWithBudget("a/b/c", true, ["x", "y", "**"], listBudget)).toBeUndefined();
    expect(listBudget.remaining).toBeLessThan(0);
  });

  it("decides like the unbudgeted matchers with compiled patterns as well", () => {
    const compiled = PATTERNS.map(compileIgnorePattern);
    for (const [candidate, isDirectory] of CANDIDATES) {
      for (const pattern of compiled) {
        expect(
          matchesIgnorePatternWithBudget(candidate, isDirectory, pattern, { remaining: 1_000_000 }),
          `${pattern.pattern} vs ${candidate}`,
        ).toBe(matchesIgnorePattern(candidate, isDirectory, pattern.pattern));
      }
      expect(findMatchingIgnorePatternWithBudget(candidate, isDirectory, compiled, { remaining: 1_000_000 }), candidate).toBe(
        findMatchingIgnorePattern(candidate, isDirectory, PATTERNS),
      );
    }
  });

  it("charges the real backtracking of a hostile pattern, not a fixed amount", () => {
    // A star followed by a long literal re-scans that literal at every start position.
    const hostile = `*${"a".repeat(100)}b`;
    const subject = "a".repeat(200);
    const cheap = { remaining: 10_000_000 };
    matchesIgnorePatternWithBudget(subject, false, "*.log", cheap);
    const costly = { remaining: 10_000_000 };
    matchesIgnorePatternWithBudget(subject, false, hostile, costly);
    expect(10_000_000 - costly.remaining).toBeGreaterThan(20 * (10_000_000 - cheap.remaining));
  });
});
