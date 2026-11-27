import { createSnapshot, type SnapshotGraph, type SnapshotNodeInput } from "@causoryn/domain";
import { RENAME_MATCHING_BUDGET } from "@causoryn/graph";
import { describe, expect, it } from "vitest";

import { verifyChange } from "../src/index.js";

/**
 * When rename matching is skipped because the change is above its work budget
 * (Claude Security F5), the graph-diff check reports renames as removed + added
 * nodes. That must be visible in the check's limitations, never silent.
 */

function fn(qualifiedName: string, relativePath: string): SnapshotNodeInput {
  return {
    kind: "Function",
    qualifiedName,
    relativePath,
    language: "typescript",
    location: { relativePath, startLine: 1, endLine: 2, sourceHash: `sha256:${qualifiedName}` },
  };
}

function snapshot(nodes: readonly SnapshotNodeInput[]): SnapshotGraph {
  return createSnapshot({
    workspaceId: "ws-rename-budget",
    revision: { id: "rev", sequence: 1 },
    configHash: "cfg",
    analyzerFingerprint: "fp",
    state: "ready",
    createdAt: "2026-11-26T00:00:00.000Z",
    nodes,
    edges: [],
  });
}

function functions(prefix: string, count: number): SnapshotNodeInput[] {
  return Array.from({ length: count }, (_, i) => {
    const id = String(i).padStart(4, "0");
    return fn(`${prefix}.fn${id}`, `src/${prefix}/f${id}.ts`);
  });
}

describe("verifyChange — rename matching above its budget", () => {
  it("records the skipped rename matching in the graph-diff limitations", () => {
    // Same-kind pairs above the budget: every removed node is a rename candidate
    // of every added node.
    const side = Math.ceil(Math.sqrt(RENAME_MATCHING_BUDGET.maxCandidatePairs)) + 1;
    const report = verifyChange({
      baseSnapshot: snapshot(functions("before", side)),
      targetSnapshot: snapshot(functions("after", side)),
      checks: ["graph-diff"],
    });

    expect(report.checks.graphDiff.status).toBe("evaluated");
    expect(report.checks.graphDiff.diffSummary.renamed).toBe(0);
    expect(report.checks.graphDiff.limitations.some((line) => line.includes("rename-matching-skipped"))).toBe(
      true,
    );
    expect(report.limitations.some((line) => line.includes("rename-matching-skipped"))).toBe(true);
  });

  it("adds no such limitation below the budget", () => {
    const report = verifyChange({
      baseSnapshot: snapshot(functions("before", 20)),
      targetSnapshot: snapshot(functions("after", 20)),
      checks: ["graph-diff"],
    });
    expect(report.limitations.some((line) => line.includes("rename-matching-skipped"))).toBe(false);
  });
});
