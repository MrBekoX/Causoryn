import { describe, expect, it } from "vitest";

import {
  createSnapshot,
  type SnapshotGraph,
  type SnapshotNodeInput,
} from "@causoryn/domain";

import {
  validateArchitectureAnnotations,
} from "../src/architecture-annotations.js";
import { projectArchitecture } from "../src/architecture-projection.js";
import { GraphRepositoryError } from "../src/errors.js";

const WS = "ws_ann_multi_err";
const CREATED_AT = "2026-11-24T10:00:00.000Z";

function makeNode(
  kind: SnapshotNodeInput["kind"],
  qualifiedName: string,
  relativePath: string,
): SnapshotNodeInput {
  return {
    kind,
    qualifiedName,
    language: "typescript",
    location: {
      relativePath,
      startLine: 1,
      endLine: 20,
      sourceHash: `sha256:${relativePath}`,
    },
    attributes: {},
  };
}

function makeFixtureSnapshot(): SnapshotGraph {
  const apiFn = makeNode("Function", "handleOrder", "src/api/orders.ts");
  const svcFn = makeNode("Function", "createOrder", "src/orders/service.ts");
  return createSnapshot({
    workspaceId: WS,
    revision: { id: "rev-ann-1", sequence: 1 },
    configHash: "cfg-ann",
    analyzerFingerprint: "fp-ann",
    state: "ready",
    createdAt: CREATED_AT,
    nodes: [apiFn, svcFn],
    edges: [
      {
        kind: "CALLS",
        from: apiFn,
        to: svcFn,
        resolution: "verified",
        evidence: [
          {
            kind: "call-site",
            span: {
              relativePath: "src/api/orders.ts",
              startLine: 5,
              endLine: 5,
              sourceHash: "sha256:src/api/orders.ts",
            },
            analyzerId: "ts",
            analyzerVersion: "0.3.0",
            rationale: "api calls orders service",
          },
        ],
      },
    ],
  });
}

describe("validateArchitectureAnnotations — multi-error accumulation", () => {
  const snap = makeFixtureSnapshot();
  const proj = projectArchitecture(snap);
  const validMod = proj.modules[0]!;

  it("collects ALL broken graph-ID references across domains, moduleNotes, flows, guidedTour, decisions, and risks in one pass", () => {
    let caught: unknown;
    try {
      validateArchitectureAnnotations(
        {
          domains: [
            {
              id: "dom-1",
              name: "Domain One",
              description: "Desc",
              moduleIds: ["mod:missing-a", validMod.id],
            },
            {
              id: "dom-1",
              name: "Duplicate Domain",
              description: "Desc",
              moduleIds: [validMod.id],
            },
          ],
          moduleNotes: [
            {
              moduleId: "mod:missing-note",
              summary: "Bad note module",
            },
            {
              moduleId: validMod.id,
              summary: "Bad keyFile",
              keyFiles: ["src/nonexistent/bad-key-file.ts"],
            },
          ],
          flows: [
            {
              id: "flow-1",
              title: "Flow One",
              description: "Desc",
              steps: [
                {
                  moduleId: "mod:missing-flow-step",
                  nodeId: "node:missing-flow-node",
                  label: "Step 1",
                  explanation: "Expl",
                },
              ],
            },
          ],
          guidedTour: [
            {
              step: 1,
              title: "Tour Stop",
              targetModuleId: "mod:missing-tour-mod",
              targetNodeId: "node:missing-tour-node",
              explanation: "Expl",
            },
          ],
          decisions: [
            {
              id: "dec-1",
              title: "Decision 1",
              summary: "Summary",
              relatedModuleIds: ["mod:missing-dec-mod"],
              evidenceIds: ["ev:missing-dec-ev"],
            },
          ],
          risks: [
            {
              id: "risk-1",
              title: "Risk 1",
              severity: "high",
              summary: "Summary",
              relatedModuleIds: ["mod:missing-risk-mod"],
              evidenceIds: ["ev:missing-risk-ev"],
            },
          ],
        },
        proj,
        snap,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GraphRepositoryError);
    const err = caught as GraphRepositoryError;
    expect(err.code).toBe("export/invalid-annotations");
    for (const token of [
      "mod:missing-a",
      "dom-1",
      "mod:missing-note",
      "src/nonexistent/bad-key-file.ts",
      "mod:missing-flow-step",
      "node:missing-flow-node",
      "mod:missing-tour-mod",
      "node:missing-tour-node",
      "mod:missing-dec-mod",
      "ev:missing-dec-ev",
      "mod:missing-risk-mod",
      "ev:missing-risk-ev",
    ]) {
      expect(err.message).toContain(token);
    }
  });

  it("collects BOTH multiple Zod schema issues AND broken graph-ID references in a single pass", () => {
    let caught: unknown;
    try {
      validateArchitectureAnnotations(
        {
          title: "   ",
          risks: [
            {
              id: "risk-bad-sev",
              title: "Bad Severity",
              severity: "critical",
              summary: "Invalid enum",
              relatedModuleIds: ["mod:broken-alongside-zod"],
              evidenceIds: ["ev:broken-alongside-zod"],
            },
          ],
          guidedTour: [
            {
              step: -3,
              title: "Bad Step Number",
              targetNodeId: "node:broken-tour-alongside-zod",
              explanation: "Negative step + missing nodeId",
            },
          ],
        },
        proj,
        snap,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GraphRepositoryError);
    const err = caught as GraphRepositoryError;
    expect(err.code).toBe("export/invalid-annotations");
    // Zod issues reported
    expect(err.message).toContain("title");
    expect(err.message).toContain("risks.0.severity");
    expect(err.message).toContain("guidedTour.0.step");
    // Graph ID issues ALSO reported in the same pass!
    expect(err.message).toContain("mod:broken-alongside-zod");
    expect(err.message).toContain("ev:broken-alongside-zod");
    expect(err.message).toContain("node:broken-tour-alongside-zod");
  });

  it("caps collected errors at 25 and appends an explicit truncation summary line", () => {
    const missingModules = Array.from({ length: 32 }, (_, i) => `mod:missing-${String(i).padStart(2, "0")}`);
    let caught: unknown;
    try {
      validateArchitectureAnnotations(
        {
          domains: [
            {
              id: "dom-many",
              name: "Many Errors",
              description: "Triggers >25 validation errors",
              moduleIds: missingModules,
            },
          ],
        },
        proj,
        snap,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GraphRepositoryError);
    const err = caught as GraphRepositoryError;
    expect(err.code).toBe("export/invalid-annotations");
    // First 25 appear, 26th..32nd are truncated with summary mentioning 7 more errors
    expect(err.message).toContain("mod:missing-00");
    expect(err.message).toContain("mod:missing-24");
    expect(err.message).not.toContain("mod:missing-25");
    expect(err.message).toContain("7");
    expect(err.message).toContain("25");
  });

  it("reports whitespace-only fields with English Zod validation message (no Turkish string leak)", () => {
    let caught: unknown;
    try {
      validateArchitectureAnnotations(
        {
          title: "   ",
          executiveSummary: "\t\n ",
        },
        proj,
        snap,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GraphRepositoryError);
    const err = caught as GraphRepositoryError;
    expect(err.code).toBe("export/invalid-annotations");
    expect(err.message).toContain("Field must not be empty or whitespace-only");
    expect(err.message).not.toContain("Alan boş");
  });
});
