import { describe, expect, it } from "vitest";

import { compileIgnoreRuleSet, DEFAULT_IGNORE_PATTERNS, IGNORE_MATCH_WORK_BUDGET } from "../src/index.js";

/**
 * compileIgnoreRuleSet is the one ignore decision shared by WorkspaceAccessPolicy
 * and the other path filters (history inventory): exact matching first, then the
 * secret / VCS deny rules again with look-alike folding, all under one budget.
 */

describe("compileIgnoreRuleSet", () => {
  const rules = compileIgnoreRuleSet(DEFAULT_IGNORE_PATTERNS);
  const fresh = () => ({ remaining: IGNORE_MATCH_WORK_BUDGET });

  it("matches look-alike spellings of the configured secret / VCS deny rules", () => {
    expect(rules.match(".gıt/config", false, fresh())).toMatchObject({ kind: "matched", pattern: "**/.git/**" });
    expect(rules.match(".ｅnv.local", false, fresh())).toMatchObject({ kind: "matched", pattern: "**/.env*" });
    expect(rules.match("src/app.ts", false, fresh())).toEqual({ kind: "none" });
  });

  it("does not fold patterns that are not secret / VCS deny rules", () => {
    const custom = compileIgnoreRuleSet(["**/vendor/**"]);
    expect(custom.match(".gıt/config", false, fresh())).toEqual({ kind: "none" });
  });

  it("reports budget exhaustion for an unbounded decision", () => {
    const chain = Array.from({ length: 64 }, () => "a").join("/");
    const custom = compileIgnoreRuleSet(Array.from({ length: 50 }, (_, i) => `**/${chain}/b${String(i)}`));
    const deep = Array.from({ length: 200 }, () => "a").join("/");
    expect(custom.match(deep, true, { remaining: 10_000 })).toEqual({ kind: "budget-exhausted" });
  });
});
