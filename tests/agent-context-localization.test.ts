import { describe, expect, it } from "vitest";

import {
  createSnapshot,
  nodeId,
  type NodeKind,
  type SnapshotEdgeInput,
  type SnapshotGraph,
  type SnapshotNodeInput,
  type SourceSpan,
} from "@causoryn/domain";
import {
  analyzeImpact,
  generateAgentContext,
  GraphRepositoryError,
  projectArchitecture,
  validateArchitectureAnnotations,
  type SymbolSearchHit,
  type SymbolSearchStore,
} from "@causoryn/graph";

const WS = "ws_locagent_remediation";
const CREATED_AT = "2026-11-24T10:00:00.000Z";

function span(relativePath: string, startLine = 1, endLine = 20): SourceSpan {
  return {
    relativePath,
    startLine,
    endLine,
    sourceHash: `sha256:${relativePath}:${String(startLine)}`,
  };
}

function nid(kind: NodeKind, qualifiedName: string, relativePath?: string): string {
  return nodeId({
    workspaceId: WS,
    kind,
    qualifiedName,
    ...(relativePath === undefined ? {} : { relativePath }),
  });
}

function ev(relativePath: string, rationale: string, startLine = 1) {
  return {
    kind: "static-analysis",
    span: span(relativePath, startLine, startLine + 2),
    analyzerId: "causoryn/typescript",
    analyzerVersion: "0.3.0",
    rationale,
  };
}

const DISTRACTOR_NAMES = [
  "a_alpha",
  "a_adapter",
  "b_bravo",
  "b_buffer",
  "c_charlie",
  "d_delta",
  "e_echo",
  "f_foxtrot",
  "g_golf",
  "h_hotel",
  "i_india",
  "j_juliet",
  "k_kilo",
  "l_lima",
  "m_mike",
  "n_november",
  "o_oscar",
  "p_papa",
  "q_quebec",
  "z_zeta",
] as const;

/**
 * Realistic multi-package monorepo fixture mirroring Causoryn's own layout:
 * - Workspace root connected to every File via CONTAINS
 * - packages/mcp-server/src/server.ts (createCausorynMcpServer, registerTool)
 * - packages/mcp-server/src/envelope.ts (buildEnvelope)
 * - packages/mcp-server/src/cli.ts (startCli -> createCausorynMcpServer, imports server.ts)
 * - packages/core/src/contracts.ts (IToolHandler, BaseToolHandler) + CHA IMPLEMENTS/INHERITS
 * - 20 distractor files (a_alpha.ts .. z_zeta.ts), including several under packages/mcp-server/src/
 *   whose names sort alphabetically BEFORE server.ts!
 */
function buildMonorepoFixture(): SnapshotGraph {
  const wsNode: SnapshotNodeInput = {
    kind: "Workspace",
    qualifiedName: WS,
  };
  const serverFile: SnapshotNodeInput = {
    kind: "File",
    qualifiedName: "packages/mcp-server/src/server.ts",
    relativePath: "packages/mcp-server/src/server.ts",
    location: span("packages/mcp-server/src/server.ts", 1, 180),
    language: "typescript",
  };
  const createServerFn: SnapshotNodeInput = {
    kind: "Function",
    qualifiedName: "createCausorynMcpServer",
    relativePath: "packages/mcp-server/src/server.ts",
    location: span("packages/mcp-server/src/server.ts", 15, 95),
    language: "typescript",
  };
  const registerToolFn: SnapshotNodeInput = {
    kind: "Function",
    qualifiedName: "registerTool",
    relativePath: "packages/mcp-server/src/server.ts",
    location: span("packages/mcp-server/src/server.ts", 98, 160),
    language: "typescript",
  };
  const envelopeFile: SnapshotNodeInput = {
    kind: "File",
    qualifiedName: "packages/mcp-server/src/envelope.ts",
    relativePath: "packages/mcp-server/src/envelope.ts",
    location: span("packages/mcp-server/src/envelope.ts", 1, 90),
    language: "typescript",
  };
  const buildEnvelopeFn: SnapshotNodeInput = {
    kind: "Function",
    qualifiedName: "buildEnvelope",
    relativePath: "packages/mcp-server/src/envelope.ts",
    location: span("packages/mcp-server/src/envelope.ts", 10, 60),
    language: "typescript",
  };
  const cliFile: SnapshotNodeInput = {
    kind: "File",
    qualifiedName: "packages/mcp-server/src/cli.ts",
    relativePath: "packages/mcp-server/src/cli.ts",
    location: span("packages/mcp-server/src/cli.ts", 1, 70),
    language: "typescript",
  };
  const startCliFn: SnapshotNodeInput = {
    kind: "Function",
    qualifiedName: "startCli",
    relativePath: "packages/mcp-server/src/cli.ts",
    location: span("packages/mcp-server/src/cli.ts", 12, 55),
    language: "typescript",
  };
  const runtimeFile: SnapshotNodeInput = {
    kind: "File",
    qualifiedName: "packages/mcp-server/src/runtime.ts",
    relativePath: "packages/mcp-server/src/runtime.ts",
    location: span("packages/mcp-server/src/runtime.ts", 1, 50),
    language: "typescript",
  };

  // CHA hierarchy: IToolHandler <-(IMPLEMENTS)- McpToolHandler <-(CALLS)- dispatchTool
  //                BaseToolHandler <-(INHERITS)- SpecialToolHandler <-(CALLS)- dispatchTool
  const contractsFile: SnapshotNodeInput = {
    kind: "File",
    qualifiedName: "packages/core/src/contracts.ts",
    relativePath: "packages/core/src/contracts.ts",
    location: span("packages/core/src/contracts.ts", 1, 40),
    language: "typescript",
  };
  const toolIface: SnapshotNodeInput = {
    kind: "Interface",
    qualifiedName: "IToolHandler",
    relativePath: "packages/core/src/contracts.ts",
    location: span("packages/core/src/contracts.ts", 3, 15),
    language: "typescript",
  };
  const baseClass: SnapshotNodeInput = {
    kind: "Class",
    qualifiedName: "BaseToolHandler",
    relativePath: "packages/core/src/contracts.ts",
    location: span("packages/core/src/contracts.ts", 17, 38),
    language: "typescript",
  };
  const handlersFile: SnapshotNodeInput = {
    kind: "File",
    qualifiedName: "packages/mcp-server/src/handlers.ts",
    relativePath: "packages/mcp-server/src/handlers.ts",
    location: span("packages/mcp-server/src/handlers.ts", 1, 80),
    language: "typescript",
  };
  const implClass: SnapshotNodeInput = {
    kind: "Class",
    qualifiedName: "McpToolHandler",
    relativePath: "packages/mcp-server/src/handlers.ts",
    location: span("packages/mcp-server/src/handlers.ts", 5, 35),
    language: "typescript",
  };
  const subClass: SnapshotNodeInput = {
    kind: "Class",
    qualifiedName: "SpecialToolHandler",
    relativePath: "packages/mcp-server/src/handlers.ts",
    location: span("packages/mcp-server/src/handlers.ts", 38, 65),
    language: "typescript",
  };
  const dispatchFn: SnapshotNodeInput = {
    kind: "Function",
    qualifiedName: "dispatchTool",
    relativePath: "packages/mcp-server/src/handlers.ts",
    location: span("packages/mcp-server/src/handlers.ts", 67, 79),
    language: "typescript",
  };

  const nodes: SnapshotNodeInput[] = [
    wsNode,
    serverFile,
    createServerFn,
    registerToolFn,
    envelopeFile,
    buildEnvelopeFn,
    cliFile,
    startCliFn,
    runtimeFile,
    contractsFile,
    toolIface,
    baseClass,
    handlersFile,
    implClass,
    subClass,
    dispatchFn,
  ];

  const fileNodesForWorkspace: SnapshotNodeInput[] = [
    serverFile,
    envelopeFile,
    cliFile,
    runtimeFile,
    contractsFile,
    handlersFile,
  ];

  const edges: SnapshotEdgeInput[] = [];

  // 20 distractor files: first 5 even sit inside packages/mcp-server/src/ to prove
  // directory-only alphabetical winners (a_alpha.ts, a_adapter.ts, ...) do NOT beat server.ts!
  for (const [idx, name] of DISTRACTOR_NAMES.entries()) {
    const dir = idx < 5 ? "packages/mcp-server/src" : "packages/utils/src";
    const relPath = `${dir}/${name}.ts`;
    const distractorFile: SnapshotNodeInput = {
      kind: "File",
      qualifiedName: relPath,
      relativePath: relPath,
      location: span(relPath, 1, 25),
      language: "typescript",
    };
    const distractorFn: SnapshotNodeInput = {
      kind: "Function",
      qualifiedName: `${name}Helper`,
      relativePath: relPath,
      location: span(relPath, 3, 20),
      language: "typescript",
    };
    nodes.push(distractorFile, distractorFn);
    fileNodesForWorkspace.push(distractorFile);
    edges.push({
      kind: "CONTAINS",
      from: distractorFile,
      to: distractorFn,
      resolution: "verified",
      evidence: [ev(relPath, `CONTAINS: ${name}Helper`)],
    });
  }

  // Workspace --CONTAINS--> every File
  for (const fileNode of fileNodesForWorkspace) {
    edges.push({
      kind: "CONTAINS",
      from: wsNode,
      to: fileNode,
      resolution: "verified",
      evidence: [ev(fileNode.relativePath ?? "workspace", "Workspace inventory containment")],
    });
  }

  // Core structural edges around server.ts, envelope.ts, cli.ts, runtime.ts, handlers.ts
  edges.push(
    {
      kind: "CONTAINS",
      from: serverFile,
      to: createServerFn,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/server.ts", "declares createCausorynMcpServer", 15)],
    },
    {
      kind: "CONTAINS",
      from: serverFile,
      to: registerToolFn,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/server.ts", "declares registerTool", 98)],
    },
    {
      kind: "CONTAINS",
      from: envelopeFile,
      to: buildEnvelopeFn,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/envelope.ts", "declares buildEnvelope", 10)],
    },
    {
      kind: "CONTAINS",
      from: cliFile,
      to: startCliFn,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/cli.ts", "declares startCli", 12)],
    },
    {
      kind: "CONTAINS",
      from: contractsFile,
      to: toolIface,
      resolution: "verified",
      evidence: [ev("packages/core/src/contracts.ts", "declares IToolHandler", 3)],
    },
    {
      kind: "CONTAINS",
      from: contractsFile,
      to: baseClass,
      resolution: "verified",
      evidence: [ev("packages/core/src/contracts.ts", "declares BaseToolHandler", 17)],
    },
    {
      kind: "CONTAINS",
      from: handlersFile,
      to: implClass,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/handlers.ts", "declares McpToolHandler", 5)],
    },
    {
      kind: "CONTAINS",
      from: handlersFile,
      to: subClass,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/handlers.ts", "declares SpecialToolHandler", 38)],
    },
    {
      kind: "CONTAINS",
      from: handlersFile,
      to: dispatchFn,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/handlers.ts", "declares dispatchTool", 67)],
    },
    // Non-CONTAINS dependency edges making server.ts & envelope.ts real architectural hubs
    {
      kind: "IMPORTS",
      from: serverFile,
      to: envelopeFile,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/server.ts", "imports envelope.ts", 2)],
    },
    {
      kind: "IMPORTS",
      from: cliFile,
      to: serverFile,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/cli.ts", "imports server.ts", 1)],
    },
    {
      kind: "IMPORTS",
      from: runtimeFile,
      to: serverFile,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/runtime.ts", "imports server.ts", 1)],
    },
    {
      kind: "IMPORTS",
      from: handlersFile,
      to: envelopeFile,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/handlers.ts", "imports envelope.ts", 1)],
    },
    {
      kind: "CALLS",
      from: startCliFn,
      to: createServerFn,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/cli.ts", "calls createCausorynMcpServer", 24)],
    },
    {
      kind: "CALLS",
      from: createServerFn,
      to: registerToolFn,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/server.ts", "calls registerTool", 42)],
    },
    {
      kind: "CALLS",
      from: registerToolFn,
      to: buildEnvelopeFn,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/server.ts", "calls buildEnvelope", 120)],
    },
    // CHA edges
    {
      kind: "IMPLEMENTS",
      from: implClass,
      to: toolIface,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/handlers.ts", "McpToolHandler implements IToolHandler", 5)],
    },
    {
      kind: "INHERITS",
      from: subClass,
      to: baseClass,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/handlers.ts", "SpecialToolHandler extends BaseToolHandler", 38)],
    },
    {
      kind: "CALLS",
      from: dispatchFn,
      to: implClass,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/handlers.ts", "dispatchTool invokes McpToolHandler", 70)],
    },
    {
      kind: "CALLS",
      from: dispatchFn,
      to: subClass,
      resolution: "verified",
      evidence: [ev("packages/mcp-server/src/handlers.ts", "dispatchTool invokes SpecialToolHandler", 74)],
    },
  );

  return createSnapshot({
    workspaceId: WS,
    revision: { id: "rev-loc-1", sequence: 1 },
    configHash: "cfg-loc",
    analyzerFingerprint: "fp-loc",
    state: "ready",
    createdAt: CREATED_AT,
    nodes,
    edges,
  });
}

/** Simulates a phrase-matching store (returns hits only on substring/term match). */
function makePhraseSymbolStore(snapshot: SnapshotGraph): SymbolSearchStore {
  return {
    indexSymbols: () => undefined,
    searchSymbols: (query: string, limit = 50, snapshotId?: string): readonly SymbolSearchHit[] => {
      if (snapshotId !== undefined && snapshotId !== snapshot.meta.id) return [];
      const q = query.trim().toLowerCase();
      if (q.length === 0) return [];
      const hits: SymbolSearchHit[] = [];
      for (const node of snapshot.nodes) {
        if (node.kind === "Workspace") continue;
        const text = `${node.qualifiedName} ${node.location?.relativePath ?? ""}`.toLowerCase();
        if (text.includes(q)) {
          hits.push({ symbol: node.qualifiedName, nodeId: node.id, snapshotId: snapshot.meta.id });
        }
      }
      return hits.slice(0, limit);
    },
  };
}

describe("Wave 2 Track 2B — LocAgent localization, CHA impact, & multi-error annotations", () => {
  const snapshot = buildMonorepoFixture();

  it("English natural-language query 'Where are MCP tools registered?' surfaces server.ts in top 3 (in-memory & with symbolSearch)", () => {
    const inMemory = generateAgentContext(snapshot, {
      task: "Where are MCP tools registered?",
      tokenBudget: 4096,
    });
    const top3InMemory = inMemory.contextItems.slice(0, 3);
    expect(top3InMemory.length).toBeGreaterThanOrEqual(2);
    expect(
      top3InMemory.some(
        (item) =>
          item.relativePath === "packages/mcp-server/src/server.ts" ||
          item.qualifiedName === "packages/mcp-server/src/server.ts",
      ),
    ).toBe(true);
    // Specifically verify registerTool or server.ts itself ranks ahead of alphabetical distractors
    expect(
      top3InMemory.some((item) => item.qualifiedName === "registerTool" || item.qualifiedName === "packages/mcp-server/src/server.ts"),
    ).toBe(true);
    // Workspace root must NEVER appear in localization results
    expect(inMemory.contextItems.some((item) => item.kind === "Workspace")).toBe(false);
    // Unrelated utils distractors must NOT flood via Workspace --CONTAINS--> File
    expect(
      inMemory.contextItems.some((item) => item.relativePath?.startsWith("packages/utils/")),
    ).toBe(false);

    // Also verify with SymbolSearchStore attached
    const withStore = generateAgentContext(snapshot, {
      task: "Where are MCP tools registered?",
      tokenBudget: 4096,
      symbolSearch: makePhraseSymbolStore(snapshot),
    });
    const top3WithStore = withStore.contextItems.slice(0, 3);
    expect(
      top3WithStore.some(
        (item) =>
          item.relativePath === "packages/mcp-server/src/server.ts" ||
          item.qualifiedName === "packages/mcp-server/src/server.ts",
      ),
    ).toBe(true);
  });

  it("Turkish natural-language query 'MCP araçları nerede kaydediliyor?' surfaces server.ts in top 5", () => {
    const result = generateAgentContext(snapshot, {
      task: "MCP araçları nerede kaydediliyor?",
      tokenBudget: 4096,
    });
    const top5 = result.contextItems.slice(0, 5);
    expect(top5.length).toBeGreaterThanOrEqual(2);
    expect(
      top5.some(
        (item) =>
          item.relativePath === "packages/mcp-server/src/server.ts" ||
          item.qualifiedName === "packages/mcp-server/src/server.ts",
      ),
    ).toBe(true);
    // Alphabetical leaf distractor a_alpha.ts must NOT beat hub server.ts / createCausorynMcpServer
    const serverIdx = result.contextItems.findIndex(
      (item) => item.relativePath === "packages/mcp-server/src/server.ts",
    );
    const alphaIdx = result.contextItems.findIndex(
      (item) => item.relativePath === "packages/mcp-server/src/a_alpha.ts",
    );
    expect(serverIdx).toBeGreaterThanOrEqual(0);
    if (alphaIdx >= 0) {
      expect(serverIdx).toBeLessThan(alphaIdx);
    }
    expect(result.contextItems.some((item) => item.kind === "Workspace")).toBe(false);
  });

  it("analyzeImpact on server.ts excludes Workspace root, excludes sibling noise, and finds importers + callers of declared symbols", () => {
    const serverFileId = nid(
      "File",
      "packages/mcp-server/src/server.ts",
      "packages/mcp-server/src/server.ts",
    );
    const impact = analyzeImpact(snapshot, { targets: [serverFileId] });

    // Workspace root MUST NEVER appear in default impact
    expect(impact.affectedNodes.some((n) => n.kind === "Workspace")).toBe(false);
    expect(impact.paths.some((p) => p.endpointKind === "Workspace")).toBe(false);
    expect(impact.paths.every((p) => p.edges.every((e) => e.kind !== "CONTAINS"))).toBe(true);

    // Unrelated distractors MUST NOT appear
    expect(impact.affectedNodes.some((n) => n.qualifiedName.includes("a_alpha"))).toBe(false);

    // Real dependents: cli.ts & runtime.ts (IMPORTS) and startCli (CALLS createCausorynMcpServer declared in server.ts)
    const affectedNames = impact.affectedNodes.map((n) => n.qualifiedName);
    expect(affectedNames).toContain("packages/mcp-server/src/cli.ts");
    expect(affectedNames).toContain("packages/mcp-server/src/runtime.ts");
    expect(affectedNames).toContain("startCli");
  });

  it("analyzeImpact traverses CHA IMPLEMENTS & INHERITS edges from interfaces/base classes to implementors and their callers", () => {
    const ifaceImpact = analyzeImpact(snapshot, { targets: ["IToolHandler"] });
    const ifaceAffected = ifaceImpact.affectedNodes.map((n) => n.qualifiedName);
    expect(ifaceAffected).toContain("McpToolHandler");
    expect(ifaceAffected).toContain("dispatchTool");
    expect(ifaceImpact.affectedNodes.some((n) => n.kind === "Workspace")).toBe(false);

    const implNode = ifaceImpact.affectedNodes.find((n) => n.qualifiedName === "McpToolHandler");
    expect(implNode).toMatchObject({ certainty: "direct", resolution: "verified", minDepth: 1 });
    const callerNode = ifaceImpact.affectedNodes.find((n) => n.qualifiedName === "dispatchTool");
    expect(callerNode).toMatchObject({ certainty: "indirect", resolution: "verified", minDepth: 2 });

    const baseImpact = analyzeImpact(snapshot, { targets: ["BaseToolHandler"] });
    const baseAffected = baseImpact.affectedNodes.map((n) => n.qualifiedName);
    expect(baseAffected).toContain("SpecialToolHandler");
    expect(baseAffected).toContain("dispatchTool");
  });

  it("validateArchitectureAnnotations collects ALL 4 broken IDs/fields in a single fail-closed error", () => {
    const projection = projectArchitecture(snapshot);
    const validMod = projection.modules[0];
    if (validMod === undefined) throw new Error("expected at least one projected module");

    let caught: unknown;
    try {
      validateArchitectureAnnotations(
        {
          domains: [
            {
              id: "dom-broken",
              name: "Broken Domain",
              description: "Points at nonexistent module",
              moduleIds: ["mod:broken-domain-1"],
            },
          ],
          moduleNotes: [
            {
              moduleId: validMod.id,
              summary: "Has nonexistent keyFile",
              keyFiles: ["packages/nonexistent/ghost-file-2.ts"],
            },
          ],
          guidedTour: [
            {
              step: 1,
              title: "Broken Node Stop",
              targetNodeId: "node:broken-node-3",
              explanation: "Points at nonexistent node",
            },
          ],
          decisions: [
            {
              id: "dec-1",
              title: "Broken Evidence Decision",
              summary: "Points at nonexistent evidence",
              evidenceIds: ["ev:broken-evidence-4"],
            },
          ],
        },
        projection,
        snapshot,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GraphRepositoryError);
    const err = caught as GraphRepositoryError;
    expect(err.code).toBe("export/invalid-annotations");
    expect(err.message).toContain("mod:broken-domain-1");
    expect(err.message).toContain("packages/nonexistent/ghost-file-2.ts");
    expect(err.message).toContain("node:broken-node-3");
    expect(err.message).toContain("ev:broken-evidence-4");
  });
});
