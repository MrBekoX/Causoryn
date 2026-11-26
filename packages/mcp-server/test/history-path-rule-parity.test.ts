import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkspaceAccessPolicy } from "@causoryn/workspace";
import { afterEach, describe, expect, it } from "vitest";

import { pathRuleFilter } from "../src/history-commit-analysis.js";

/**
 * The history inventory filter decides which committed files are analyzed from
 * git objects. It must give the same ignore answer as WorkspaceAccessPolicy:
 * the secret / VCS deny rules also match look-alike spellings, and every
 * decision runs under the policy's work budget, a budget that runs out excluding
 * the file (fail closed) instead of matching without bound.
 */

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop() as string, { recursive: true, force: true });
  }
});

function policyConfig(options: { extraIgnore?: string[] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "causoryn-history-parity-"));
  cleanups.push(root);
  return WorkspaceAccessPolicy.create({ allowRoots: [root], ...options }).config;
}

describe("history pathRuleFilter — parity with the workspace policy", () => {
  it("excludes look-alike spellings of the secret / VCS deny rules", () => {
    const ruleOf = pathRuleFilter(policyConfig());
    // U+0131 dotless i: NTFS upper-cases it to "I", so this is .git there.
    expect(ruleOf(".gıt/hooks/post-checkout.ts")).toBe("excluded");
    expect(ruleOf("src/.GIT/x.ts")).toBe("excluded");
    expect(ruleOf("src/app.ts")).toBe("included");
  });

  it("rules a path whose ignore decision runs out of budget undecided (reported, never dropped silently)", () => {
    const chain = Array.from({ length: 32 }, () => "a").join("/");
    const extraIgnore = Array.from({ length: 200 }, (_, i) => `**/${chain}/b${String(i).padStart(4, "0")}`);
    const ruleOf = pathRuleFilter(policyConfig({ extraIgnore }));
    const deep = `${Array.from({ length: 128 }, () => "a").join("/")}/file.ts`;

    expect(ruleOf(deep)).toBe("undecided");
    // The budget belongs to one decision: an ordinary path is still decided normally.
    expect(ruleOf("src/app.ts")).toBe("included");
  });
});
