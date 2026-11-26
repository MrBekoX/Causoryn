import { describe, expect, it } from "vitest";

import { RENAME_MATCHING_BUDGET, type CompareContentSet, type CompareNode } from "../src/compare.js";
import { buildArchitectureTimeline, TIMELINE_RENAME_MATCHING_BUDGET } from "../src/timeline.js";

/**
 * A timeline interval whose rename matching is above its work budget
 * (Claude Security F5) reports renames as removed + added; the timeline's
 * warnings must say so for that interval instead of staying silent.
 */

function functions(prefix: string, count: number): CompareContentSet {
  const nodes: CompareNode[] = Array.from({ length: count }, (_, i) => {
    const id = String(i).padStart(4, "0");
    return { kind: "Function", qualifiedName: `${prefix}.fn${id}`, relativePath: `src/${prefix}/f${id}.ts` };
  });
  return { nodes, edges: [] };
}

describe("buildArchitectureTimeline — rename matching above its budget", () => {
  it("warns for the interval whose rename matching was skipped", () => {
    const side = Math.ceil(Math.sqrt(RENAME_MATCHING_BUDGET.maxCandidatePairs)) + 1;
    const timeline = buildArchitectureTimeline({
      points: [
        { ref: "v1", content: { status: "analyzed", contentSet: functions("before", side) } },
        { ref: "v2", content: { status: "analyzed", contentSet: functions("after", side) } },
        { ref: "v3", content: { status: "analyzed", contentSet: functions("after", side) } },
      ],
    });

    const skipped = timeline.warnings.filter((line) => line.includes("rename-matching-skipped"));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("'v1'");
    expect(skipped[0]).toContain("'v2'");
  });

  it("shares one cumulative rename budget across the intervals of one call", () => {
    // Each interval: 1300 removed × 1300 added = 1,690,000 pairs, under the
    // per-diff budget. Two intervals fit the call's cumulative budget; the
    // third would exceed it and is skipped with the same warning code, so a
    // long timeline cannot run dozens of budget-sized diffs back to back.
    const side = 1300;
    const timeline = buildArchitectureTimeline({
      points: ["s1", "s2", "s3", "s4"].map((prefix, i) => ({
        ref: `v${String(i + 1)}`,
        content: { status: "analyzed" as const, contentSet: functions(prefix, side) },
      })),
    });

    const renamedPerInterval = timeline.intervals.map((interval) =>
      interval.kind === "diff" ? interval.changes.renamed : -1,
    );
    expect(renamedPerInterval).toEqual([side, side, 0]);
    const skipped = timeline.warnings.filter((line) => line.includes("rename-matching-skipped"));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatch(/^interval 'v3'\.\.'v4': rename-matching-skipped: 1690000 same-kind /);
    expect(skipped[0]).toContain("cumulative rename matching budget");

    const pairs = side * side;
    expect(pairs).toBeLessThanOrEqual(RENAME_MATCHING_BUDGET.maxCandidatePairs);
    expect(2 * pairs).toBeLessThanOrEqual(TIMELINE_RENAME_MATCHING_BUDGET.maxCandidatePairs);
    expect(3 * pairs).toBeGreaterThan(TIMELINE_RENAME_MATCHING_BUDGET.maxCandidatePairs);
  });
});
