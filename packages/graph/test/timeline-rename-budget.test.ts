import { describe, expect, it } from "vitest";

import { RENAME_MATCHING_BUDGET, type CompareContentSet, type CompareNode } from "../src/compare.js";
import { buildArchitectureTimeline } from "../src/timeline.js";

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
});
