import { describe, expect, it, vi } from "vitest";

import {
  diffContentSets,
  RENAME_MATCHING_BUDGET,
  type CompareContentSet,
  type CompareNode,
} from "../src/compare.js";

/**
 * Rename matching bounds (security scan F5 / CWE-407 and F25 / CWE-1333).
 *
 * The node lists of a compare content set come from the analysed repository
 * (a committed `.causoryn/architecture-snapshot.json` blob, or the engine's
 * analysis of repository source), so their size and text are attacker
 * controlled. diffContentSets runs synchronously on the MCP main thread:
 * - F5: rename matching scored every removed node against every added node
 *   with no bound. It now has a deterministic work budget; above it, renames
 *   are not detected and a `rename-matching-skipped` warning is reported.
 * - F25: the camel-case tokenizer used `/([A-Z]+)([A-Z][a-z])/g`, which
 *   backtracks quadratically on a long uppercase run. It is now a linear scan.
 *
 * The tests use counters and bounded inputs, never wall-clock time.
 */

function fn(qualifiedName: string, extra: Partial<CompareNode> = {}): CompareNode {
  return { kind: "Function", qualifiedName, ...extra };
}

function contentSet(nodes: readonly CompareNode[]): CompareContentSet {
  return { nodes, edges: [] };
}

/** Deterministic PRNG (LCG) for the bounded differential inputs. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * The tokenizer this module replaced, kept as the reference oracle. Only ever
 * called on the short bounded inputs below (its backtracking is quadratic).
 */
function legacyTokenize(text: string): string[] {
  const bounded = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  return bounded.match(/[a-z0-9]+/g) ?? [];
}

function legacyJaccard(a: string, b: string): number {
  if (a === b) return 1;
  const left = new Set(legacyTokenize(a));
  const right = new Set(legacyTokenize(b));
  if (left.size === 0 && right.size === 0) return 1;
  const union = new Set<string>([...left, ...right]);
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / union.size;
}

const ALPHABET = [
  "a", "b", "z", "A", "B", "Z", "0", "9", " ", "_", "-", ".", "(", ")", ":",
  "é", "İ", "K", "ß", "Σ",
];

function randomText(next: () => number): string {
  const length = 1 + Math.floor(next() * 24);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[Math.floor(next() * ALPHABET.length)] ?? "a";
  }
  // Compare node fields must not be blank.
  return out.trim().length === 0 ? `${out}q` : out;
}

const FIXED_TOKENIZER_CASES: readonly string[] = [
  "HTTPServer",
  "getHTTPResponse",
  "ABCd",
  "ABcDEf",
  "A1B",
  "aB1C",
  "parseXMLToJSON",
  "IOError",
  "x",
  "X",
  "XX",
  "İstanbulCity",
  "KelvinScale",
  "createPurchaseOrder",
  "snake_case_NAME",
  "Z".repeat(30),
  `${"Q".repeat(20)}r`,
];

describe("rename tokenizer (F25: linear, byte-identical to the regex tokenizer)", () => {
  it("runs no regular expression over long repository text", () => {
    const originalExec = RegExp.prototype.exec;
    const longRuns: string[] = [];
    // Observe every regex execution. Over a long input the original is not
    // called (that is the quadratic case); it reports "no match" instead so
    // the old implementation finishes and fails the assertion below.
    const spy = vi
      .spyOn(RegExp.prototype, "exec")
      .mockImplementation(function (this: RegExp, input: string) {
        if (input.length >= 100_000) {
          longRuns.push(`/${this.source}/ over ${String(input.length)} characters`);
          return null;
        }
        return originalExec.call(this, input);
      });
    let diff;
    try {
      const upper = "Z".repeat(200_000);
      diff = diffContentSets(
        contentSet([
          fn(`legacy.${upper}`, {
            relativePath: "src/handler.ts",
            signature: `${"A".repeat(300_000)} shared`,
          }),
        ]),
        contentSet([
          fn(`current.${upper}`, {
            relativePath: "src/handler.ts",
            signature: `${"B".repeat(300_000)} shared`,
          }),
        ]),
      );
    } finally {
      spy.mockRestore();
    }

    expect(longRuns).toEqual([]);
    expect(diff.renamed).toHaveLength(1);
    expect(diff.renamed[0]?.components).toEqual({ baseName: 1, signature: 1 / 3, path: 1 });
    expect(diff.renamed[0]?.confidence).toBe("high");
  });

  it("scores signatures and base names exactly like the regex tokenizer on bounded inputs", () => {
    const next = lcg(0x5eed_f25);
    const pairs: [string, string][] = [];
    for (const left of FIXED_TOKENIZER_CASES) {
      for (const right of FIXED_TOKENIZER_CASES) pairs.push([left, right]);
    }
    for (let i = 0; i < 400; i += 1) pairs.push([randomText(next), randomText(next)]);

    for (const [left, right] of pairs) {
      // Same base name and path: the pair always scores ≥ 0.65 and is
      // reported, so the signature component is observable.
      const bySignature = diffContentSets(
        contentSet([fn("old.handle", { relativePath: "src/h.ts", signature: left })]),
        contentSet([fn("new.handle", { relativePath: "src/h.ts", signature: right })]),
      );
      expect(bySignature.renamed[0]?.components.signature, `${left} | ${right}`).toBe(
        legacyJaccard(left, right),
      );

      // Base name without '.' or '/': same signature and path keep the pair
      // reported, so the base-name component is observable.
      const leftBase = left.replace(/[./]/g, "_");
      const rightBase = right.replace(/[./]/g, "_");
      const byBaseName = diffContentSets(
        contentSet([fn(`old.${leftBase}`, { relativePath: "src/h.ts", signature: "s()" })]),
        contentSet([fn(`new.${rightBase}`, { relativePath: "src/h.ts", signature: "s()" })]),
      );
      expect(byBaseName.renamed[0]?.components.baseName, `${leftBase} | ${rightBase}`).toBe(
        legacyJaccard(leftBase, rightBase),
      );
    }
  });
});

describe("rename matching budget (F5: bounded, controlled fallback)", () => {
  it("detects renames and reports no warning under the budget", () => {
    const warnings: string[] = [];
    const diff = diffContentSets(
      contentSet([fn("pkg.alphaItem1"), fn("pkg.alphaItem2")]),
      contentSet([fn("pkg.alphaItem1Moved"), fn("pkg.alphaItem2Moved")]),
      { onWarning: (warning) => warnings.push(warning) },
    );
    expect(warnings).toEqual([]);
    expect(diff.renamed.map((match) => [match.from.qualifiedName, match.to.qualifiedName])).toEqual([
      ["pkg.alphaItem1", "pkg.alphaItem1Moved"],
      ["pkg.alphaItem2", "pkg.alphaItem2Moved"],
    ]);
  });

  it("skips rename matching with a warning when same-kind candidate pairs exceed the pair budget", () => {
    // 1500 removed × 1500 added Functions = 2,250,000 candidate pairs. Every
    // pair shares the "alpha" token, so each one would be scored.
    const n = 1500;
    const base = contentSet(Array.from({ length: n }, (_, i) => fn(`pkg.alphaItem${String(i)}`)));
    const target = contentSet(
      Array.from({ length: n }, (_, i) => fn(`pkg.alphaItem${String(i)}Moved`)),
    );
    const warnings: string[] = [];
    const diff = diffContentSets(base, target, { onWarning: (warning) => warnings.push(warning) });

    expect(warnings).toHaveLength(1);
    expect(diff.renamed).toEqual([]);
    expect(diff.uncertain).toEqual([]);
    expect(diff.removed).toHaveLength(n);
    expect(diff.added).toHaveLength(n);
    expect(diff.summary.renamed).toBe(0);
    expect(diff.summary.removed).toBe(n);
    expect(diff.summary.added).toBe(n);

    expect(n * n).toBeGreaterThan(RENAME_MATCHING_BUDGET.maxCandidatePairs);
    expect(warnings[0]).toBe(
      `rename-matching-skipped: ${String(n * n)} same-kind removed/added candidate pairs exceed ` +
        `the rename matching budget of ${String(RENAME_MATCHING_BUDGET.maxCandidatePairs)} pairs; ` +
        "renames were not detected, so removed and added nodes are reported as they are",
    );

    // Deterministic: the same input gives the same diff and warning.
    const again: string[] = [];
    expect(diffContentSets(base, target, { onWarning: (warning) => again.push(warning) })).toEqual(
      diff,
    );
    expect(again).toEqual(warnings);
  });

  it("skips rename matching with a warning when token comparisons exceed the work budget", () => {
    // 200 × 200 = 40,000 pairs (under the pair budget), but each signature
    // carries 1,600 tokens: scoring every pair needs ~64M token comparisons.
    const n = 200;
    const tokens = Array.from({ length: 1600 }, (_, j) => `t${String(j)}`).join(" ");
    const node = (side: string, i: number): CompareNode =>
      fn(`pkg.${side}Handler${String(i)}`, {
        relativePath: "src/handlers.ts",
        signature: `${tokens} ${side}${String(i)}`,
      });
    const base = contentSet(Array.from({ length: n }, (_, i) => node("old", i)));
    const target = contentSet(Array.from({ length: n }, (_, i) => node("new", i)));
    const warnings: string[] = [];
    const diff = diffContentSets(base, target, { onWarning: (warning) => warnings.push(warning) });

    expect(warnings).toHaveLength(1);
    expect(diff.renamed).toEqual([]);
    expect(diff.uncertain).toEqual([]);
    expect(diff.removed).toHaveLength(n);
    expect(diff.added).toHaveLength(n);

    expect(n * n).toBeLessThanOrEqual(RENAME_MATCHING_BUDGET.maxCandidatePairs);
    expect(warnings[0]).toMatch(
      new RegExp(
        `^rename-matching-skipped: ${String(n * n)} same-kind removed/added candidate pairs need up to ` +
          `(\\d+) token comparisons, over the rename matching budget of ` +
          `${String(RENAME_MATCHING_BUDGET.maxTokenComparisons)}; renames were not detected, ` +
          "so removed and added nodes are reported as they are$",
      ),
    );
    const needed = Number(/need up to (\d+) token/.exec(warnings[0] ?? "")?.[1]);
    expect(needed).toBeGreaterThan(RENAME_MATCHING_BUDGET.maxTokenComparisons);
  });

  it("skips rename matching once a shared pair budget across diffs is spent", () => {
    // One call (e.g. a timeline) runs several diffs against one shared budget.
    const shared = {
      maxCandidatePairs: 6,
      maxTokenComparisons: 1_000_000,
      usedCandidatePairs: 0,
      usedTokenComparisons: 0,
    };
    const warnings: string[] = [];
    const onWarning = (warning: string): void => {
      warnings.push(warning);
    };
    const base = contentSet([fn("pkg.alphaItem1"), fn("pkg.alphaItem2")]);
    const target = contentSet([fn("pkg.alphaItem1Moved"), fn("pkg.alphaItem2Moved")]);

    // 2 × 2 = 4 pairs per diff: the first fits (4 of 6), the second does not (2 left).
    const first = diffContentSets(base, target, { onWarning, sharedBudget: shared });
    const second = diffContentSets(base, target, { onWarning, sharedBudget: shared });

    expect(first.renamed).toHaveLength(2);
    expect(second.renamed).toEqual([]);
    expect(second.removed).toHaveLength(2);
    expect(second.added).toHaveLength(2);
    expect(warnings).toEqual([
      "rename-matching-skipped: 4 same-kind removed/added candidate pairs exceed the 2 pairs left of " +
        "this call's cumulative rename matching budget of 6 pairs; renames were not detected, so removed " +
        "and added nodes are reported as they are",
    ]);
    expect(shared.usedCandidatePairs).toBe(4);
  });

  it("skips rename matching once a shared token-comparison budget across diffs is spent", () => {
    const shared = {
      maxCandidatePairs: 1_000_000,
      maxTokenComparisons: 20,
      usedCandidatePairs: 0,
      usedTokenComparisons: 0,
    };
    const warnings: string[] = [];
    const onWarning = (warning: string): void => {
      warnings.push(warning);
    };
    const base = contentSet([fn("pkg.alphaItem1"), fn("pkg.alphaItem2")]);
    const target = contentSet([fn("pkg.alphaItem1Moved"), fn("pkg.alphaItem2Moved")]);

    // Per diff: 4 pairs + min(2 · (2 + 2), 2 · (3 + 3)) = 12 token comparisons.
    const first = diffContentSets(base, target, { onWarning, sharedBudget: shared });
    const second = diffContentSets(base, target, { onWarning, sharedBudget: shared });

    expect(first.renamed).toHaveLength(2);
    expect(second.renamed).toEqual([]);
    expect(warnings).toEqual([
      "rename-matching-skipped: 4 same-kind removed/added candidate pairs need up to 12 token comparisons, " +
        "over the 8 left of this call's cumulative rename matching budget of 20; renames were not detected, " +
        "so removed and added nodes are reported as they are",
    ]);
    expect(shared.usedTokenComparisons).toBe(12);
  });

  it("keeps different-kind nodes out of the pair count", () => {
    // 1500 removed Functions × 1500 added Classes: no pair is a rename
    // candidate (kinds differ), so nothing exceeds the budget.
    const n = 1500;
    const warnings: string[] = [];
    const diff = diffContentSets(
      contentSet(Array.from({ length: n }, (_, i) => fn(`pkg.alphaItem${String(i)}`))),
      contentSet(
        Array.from({ length: n }, (_, i) => ({
          kind: "Class" as const,
          qualifiedName: `pkg.alphaItem${String(i)}`,
        })),
      ),
      { onWarning: (warning) => warnings.push(warning) },
    );
    expect(warnings).toEqual([]);
    expect(diff.renamed).toEqual([]);
    expect(diff.removed).toHaveLength(n);
    expect(diff.added).toHaveLength(n);
  });
});
