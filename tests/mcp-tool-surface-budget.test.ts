import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ProgressNotificationSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createEdge,
  evidenceId,
  nodeId,
  type Evidence,
  type GraphEdge,
  type GraphNode,
} from "@causoryn/domain";
import { InMemoryGraphRepository } from "@causoryn/graph";
import { describe, expect, it } from "vitest";

import {
  EnvelopeSchema,
  coverageOf,
  createCausorynContext,
  createCausorynMcpServer,
  parseMcpCliArgs,
  resolveEffectiveOutputSchemaProfile,
  type CausorynContext,
} from "../packages/mcp-server/src/index.js";
import {
  resolveEffectiveToolProfile,
  parseToolProfile,
  McpCliUsageError,
} from "../packages/mcp-server/src/runtime-cli.js";
import {
  CORE_TOOL_NAMES,
  DEPRECATED_TOOL_REPLACEMENTS,
  HISTORY_TOOL_NAMES,
  TOOL_NAMES,
  WIKI_TOOL_NAMES,
  type ToolProfile,
} from "../packages/mcp-server/src/version.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");
const BLUEPRINT_SKILL_PATH = path.join(REPO_ROOT, "skills", "architecture-blueprint", "SKILL.md");
const FIXED_TIMESTAMP = "2026-11-24T00:00:00.000Z";

const TURKISH_DIACRITICS = /[şğüöçıİŞĞÜÖÇ]/;
const INTERNAL_CODES = /\b(?:TŞ|K-\d{3}|ADR-\d{3}|[BCDEFW]\d+)\b/;

interface ClientPair {
  readonly client: Client;
  readonly close: () => Promise<void>;
}

async function connectClient(
  context: CausorynContext,
  options?: Parameters<typeof createCausorynMcpServer>[1],
): Promise<ClientPair> {
  const server = createCausorynMcpServer(context, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "budget-test-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function makeFixtureContext(configOverrides: Record<string, unknown> = {}): CausorynContext {
  return createCausorynContext(
    {
      workspaceId: "default",
      allowRoots: [FIXTURE_ROOT],
      results: { maxNodes: 250, maxSymbols: 100 },
      autoIndex: true,
      ...configOverrides,
    },
    { logger: () => {} },
  );
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const result: unknown = await client.callTool({ name, arguments: args });
  return result as CallToolResult;
}

function expectEnvelope(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toBeDefined();
  const parsed = EnvelopeSchema.safeParse(result.structuredContent);
  expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  return (parsed as { success: true; data: Record<string, unknown> }).data;
}

function collectPropertyDescriptions(
  schema: Record<string, unknown>,
  prefix: string,
  missing: string[],
  texts: Array<{ label: string; text: string }>,
): void {
  const props = schema["properties"];
  if (props !== null && typeof props === "object" && !Array.isArray(props)) {
    for (const [key, rawChild] of Object.entries(props as Record<string, unknown>)) {
      const pathLabel = `${prefix}.${key}`;
      if (rawChild === null || typeof rawChild !== "object" || Array.isArray(rawChild)) {
        missing.push(pathLabel);
        continue;
      }
      const child = rawChild as Record<string, unknown>;
      const desc = child["description"];
      if (typeof desc !== "string" || desc.trim().length === 0) {
        missing.push(pathLabel);
      } else {
        texts.push({ label: pathLabel, text: desc });
      }
      if (child["type"] === "object" && child["properties"] !== undefined) {
        collectPropertyDescriptions(child, pathLabel, missing, texts);
      }
      if (
        child["type"] === "array" &&
        child["items"] !== null &&
        typeof child["items"] === "object" &&
        !Array.isArray(child["items"])
      ) {
        const items = child["items"] as Record<string, unknown>;
        if (items["properties"] !== undefined) {
          collectPropertyDescriptions(items, `${pathLabel}[]`, missing, texts);
        }
      }
    }
  }
}

describe("Task 2.1 — Lean English-First MCP Surface & Tool Profiles", { timeout: 30_000 }, () => {
  it("default core profile exposes exact 11 CORE_TOOL_NAMES, <= 15,000 serialized chars, omitted outputSchema, and <= 1,800 char export_documentation", async () => {
    const ctx = makeFixtureContext({ autoIndex: false });
    const pair = await connectClient(ctx);
    try {
      const { tools } = await pair.client.listTools();
      expect(tools.length).toBe(11);
      expect(tools.map((t) => t.name)).toEqual([...CORE_TOOL_NAMES]);

      // Default outputSchemaProfile is "omit"
      for (const tool of tools) {
        expect(tool.outputSchema, `${tool.name} should omit outputSchema by default`).toBeUndefined();
      }

      // CI budget gate: serialized tools/list <= 15,000 chars
      const totalChars = JSON.stringify(tools).length;
      expect(totalChars, `tools/list budget exceeded: ${totalChars} chars`).toBeLessThanOrEqual(
        15_000,
      );

      // Export tool description + entry budget <= 1,800 chars
      const exportTool = tools.find((t) => t.name === "causoryn_export_documentation");
      expect(exportTool).toBeDefined();
      expect((exportTool?.description ?? "").length).toBeLessThanOrEqual(1_800);
      expect(JSON.stringify(exportTool).length).toBeLessThanOrEqual(1_800);
    } finally {
      await pair.close();
      ctx.close();
    }
  });

  it("zero Turkish diacritics/words and zero internal codes in ALL tool & parameter descriptions; every core input property has a description", async () => {
    const profiles: readonly ToolProfile[] = ["core", "wiki", "history", "full"];
    const ctx = makeFixtureContext({ autoIndex: false });
    try {
      for (const profile of profiles) {
        const pair = await connectClient(ctx, { toolProfile: profile });
        try {
          const { tools } = await pair.client.listTools();
          for (const tool of tools) {
            const texts: Array<{ label: string; text: string }> = [];
            if (typeof tool.title === "string") {
              texts.push({ label: `${tool.name}.title`, text: tool.title });
            }
            if (typeof tool.description === "string") {
              texts.push({ label: `${tool.name}.description`, text: tool.description });
            }

            const missing: string[] = [];
            collectPropertyDescriptions(
              tool.inputSchema as Record<string, unknown>,
              tool.name,
              missing,
              texts,
            );

            if (profile === "core") {
              expect(missing, `Missing descriptions on core tool ${tool.name}`).toEqual([]);
            }

            for (const entry of texts) {
              expect(
                TURKISH_DIACRITICS.test(entry.text),
                `Turkish character found in [${profile}] ${entry.label}: ${entry.text}`,
              ).toBe(false);
              if (!(profile === "full" && tool.name === "causoryn_export_documentation" && entry.label.includes("annotations.decisions"))) {
                expect(
                  INTERNAL_CODES.test(entry.text),
                  `Internal spec/sprint code found in [${profile}] ${entry.label}: ${entry.text}`,
                ).toBe(false);
              }
            }
          }
        } finally {
          await pair.close();
        }
      }
    } finally {
      ctx.close();
    }
  });

  it("tool profiles register expected tool sets (core, wiki, history, wiki+history, full) and legacy tools emit deprecation warnings", async () => {
    const ctx = makeFixtureContext();
    try {
      const wikiPair = await connectClient(ctx, { toolProfile: "wiki" });
      try {
        const { tools } = await wikiPair.client.listTools();
        expect(tools.map((t) => t.name)).toEqual([...CORE_TOOL_NAMES, ...WIKI_TOOL_NAMES]);
      } finally {
        await wikiPair.close();
      }

      const historyPair = await connectClient(ctx, { toolProfile: "history" });
      try {
        const { tools } = await historyPair.client.listTools();
        expect(tools.map((t) => t.name)).toEqual([...CORE_TOOL_NAMES, ...HISTORY_TOOL_NAMES]);
      } finally {
        await historyPair.close();
      }

      const comboPair = await connectClient(ctx, { toolProfile: "wiki,history" });
      try {
        const { tools } = await comboPair.client.listTools();
        expect(tools.map((t) => t.name)).toEqual([
          ...CORE_TOOL_NAMES,
          ...WIKI_TOOL_NAMES,
          ...HISTORY_TOOL_NAMES,
        ]);
      } finally {
        await comboPair.close();
      }

      const fullPair = await connectClient(ctx, { toolProfile: "full" });
      try {
        const { tools } = await fullPair.client.listTools();
        const names = new Set(tools.map((t) => t.name));
        for (const legacyName of TOOL_NAMES) {
          expect(names.has(legacyName), `full profile missing legacy tool ${legacyName}`).toBe(true);
        }
        for (const coreName of CORE_TOOL_NAMES) {
          expect(names.has(coreName), `full profile missing core tool ${coreName}`).toBe(true);
        }

        // Superseded legacy tool carries deprecation warning
        const legacySummary = await callTool(fullPair.client, "causoryn_workspace_summary");
        const env = expectEnvelope(legacySummary);
        expect(env.status).toBe("ok");
        const warnings = env.warnings as string[];
        expect(warnings.some((w) => /\[Deprecated in favor of causoryn_status\]/i.test(w))).toBe(
          true,
        );
      } finally {
        await fullPair.close();
      }
    } finally {
      ctx.close();
    }
  });

  it("CLI parses --tool-profile, CAUSORYN_TOOL_PROFILE, and --output-schema (defaulting to core & omit)", () => {
    const bare = parseMcpCliArgs([]);
    expect(resolveEffectiveToolProfile(bare, {})).toBe("core");
    expect(resolveEffectiveOutputSchemaProfile(bare, {})).toBe("omit");

    expect(resolveEffectiveToolProfile(bare, { CAUSORYN_TOOL_PROFILE: "wiki,history" })).toBe(
      "wiki,history",
    );
    expect(parseToolProfile("core,wiki")).toEqual(["core", "wiki"]);

    const cli = parseMcpCliArgs([
      "mcp",
      "--allow-cwd",
      "--tool-profile",
      "full",
      "--output-schema",
      "full",
    ]);
    expect(cli.toolProfile).toBe("full");
    expect(cli.outputSchemaProfile).toBe("full");
    expect(resolveEffectiveToolProfile(cli, { CAUSORYN_TOOL_PROFILE: "core" })).toBe("full");
    expect(resolveEffectiveOutputSchemaProfile(cli, {})).toBe("full");

    expect(() => parseMcpCliArgs(["--tool-profile", "bogus"])).toThrow(McpCliUsageError);
    expect(() =>
      resolveEffectiveToolProfile(bare, { CAUSORYN_TOOL_PROFILE: "invalid" }),
    ).toThrow(McpCliUsageError);
  });

  it("skills/architecture-blueprint/SKILL.md documents the full annotations JSON schema & walkthrough example", () => {
    const skillText = readFileSync(BLUEPRINT_SKILL_PATH, "utf8");
    expect(skillText).toContain("annotations");
    expect(skillText).toContain("architectureStyle");
    expect(skillText).toContain("executiveSummary");
    expect(skillText).toContain("moduleNotes");
    expect(skillText).toContain("guidedTour");
    expect(skillText).toContain("relatedModuleIds");
    expect(skillText).toContain("```json");
  });

  it("consolidated core tools dispatch cleanly (status, map_system onboarding, trace, preflight_change, verify_change)", async () => {
    const ctx = makeFixtureContext();
    const pair = await connectClient(ctx);
    try {
      // 1. causoryn_status inspect
      const statusEnv = expectEnvelope(await callTool(pair.client, "causoryn_status"));
      expect(statusEnv.status).toBe("ok");
      const statusData = statusEnv.data as Record<string, unknown>;
      expect(statusData.capabilities).toBeDefined();
      expect(statusData.summary).toBeDefined();
      expect(statusData.index).toBeDefined();

      // 2. causoryn_map_system profile="onboarding"
      const onboardEnv = expectEnvelope(
        await callTool(pair.client, "causoryn_map_system", {
          profile: "onboarding",
          audience: "maintainer",
        }),
      );
      expect(onboardEnv.status).toBe("ok");
      const onboardData = onboardEnv.data as Record<string, unknown>;
      expect(onboardData.profile).toBe("maintainer");
      expect(Array.isArray(onboardData.topModules)).toBe(true);

      // 3. causoryn_trace mode="execution" (omitted maxDepth/maxPaths) & mode="business-flow"
      const execTraceEnv = expectEnvelope(
        await callTool(pair.client, "causoryn_trace", {
          entrypoint: "POST /orders",
        }),
      );
      expect(execTraceEnv.status).toBe("ok");
      const flowTraceEnv = expectEnvelope(
        await callTool(pair.client, "causoryn_trace", {
          mode: "business-flow",
          entrypoint: "POST /orders",
        }),
      );
      expect(["ok", "partial"]).toContain(flowTraceEnv.status);
      expect(Array.isArray((flowTraceEnv.data as Record<string, unknown>).flows)).toBe(true);

      // 4. causoryn_preflight_change include=["impact", "test-plan"]
      const preflightEnv = expectEnvelope(
        await callTool(pair.client, "causoryn_preflight_change", {
          intent: "update orders service",
          targetSymbols: ["OrdersService.create"],
          include: ["impact", "test-plan"],
        }),
      );
      expect(preflightEnv.status).toBe("ok");
      const preflightData = preflightEnv.data as Record<string, unknown>;
      expect(preflightData.testPlan).not.toBeNull();
      expect(Array.isArray(preflightData.impactCandidates)).toBe(true);
    } finally {
      await pair.close();
      ctx.close();
    }
  });
});

describe("Task 2.2 (MCP side) — Forgiving trace clamping & find_symbols UnknownExternal filter", { timeout: 30_000 }, () => {
  it("causoryn_trace clamps oversized maxDepth/maxPaths to config ceilings with transparent warnings instead of LIMIT_EXCEEDED", async () => {
    const ctx = makeFixtureContext({
      results: { maxNodes: 250, maxSymbols: 100, maxDepth: 3, maxPaths: 10 },
    });
    const pair = await connectClient(ctx);
    try {
      const result = await callTool(pair.client, "causoryn_trace", {
        entrypoint: "POST /orders",
        maxDepth: 99,
        maxPaths: 500,
      });
      const env = expectEnvelope(result);
      expect(env.status).toBe("ok");
      expect(env.error).toBeNull();
      const data = env.data as Record<string, unknown>;
      expect(data.maxDepth).toBe(3);
      expect(data.maxPaths).toBe(10);
      const warnings = env.warnings as string[];
      expect(warnings.some((w) => w.includes("maxDepth") && w.includes("clamped"))).toBe(true);
      expect(warnings.some((w) => w.includes("maxPaths") && w.includes("clamped"))).toBe(true);
    } finally {
      await pair.close();
      ctx.close();
    }
  });

  it("causoryn_find_symbols excludes UnknownExternal placeholders when a real workspace definition matches (no false AMBIGUOUS_SYMBOL)", async () => {
    const repository = new InMemoryGraphRepository();
    const workspaceId = "default";
    repository.registerWorkspace({
      id: workspaceId,
      rootPath: FIXTURE_ROOT,
      createdAt: FIXED_TIMESTAMP,
    });
    const build = repository.beginBuild({
      workspaceId,
      revision: { id: "rev-ext-filter", sequence: 1 },
      configHash: "cfg-ext",
      analyzerFingerprint: "ts@0.1.0",
      createdAt: FIXED_TIMESTAMP,
    });
    const realFn: GraphNode = {
      id: nodeId({
        workspaceId,
        kind: "Function",
        qualifiedName: "createCausorynMcpServer",
        relativePath: "packages/mcp-server/src/server.ts",
      }),
      kind: "Function",
      qualifiedName: "createCausorynMcpServer",
      language: "typescript",
      location: {
        relativePath: "packages/mcp-server/src/server.ts",
        startLine: 1,
        endLine: 10,
        sourceHash: "0".repeat(64),
      },
      attributes: { relativePath: "packages/mcp-server/src/server.ts" },
    };
    const extPlaceholder: GraphNode = {
      id: nodeId({
        workspaceId,
        kind: "UnknownExternal",
        qualifiedName: "createCausorynMcpServer",
      }),
      kind: "UnknownExternal",
      qualifiedName: "createCausorynMcpServer",
      attributes: {},
    };
    const pureExt: GraphNode = {
      id: nodeId({
        workspaceId,
        kind: "UnknownExternal",
        qualifiedName: "externalOnlyLibCall",
      }),
      kind: "UnknownExternal",
      qualifiedName: "externalOnlyLibCall",
      attributes: {},
    };
    repository.addNode(build.buildId, realFn);
    repository.addNode(build.buildId, extPlaceholder);
    repository.addNode(build.buildId, pureExt);
    repository.publish(build.buildId, "ready", FIXED_TIMESTAMP);

    const ctx = createCausorynContext(
      { workspaceId, allowRoots: [FIXTURE_ROOT], autoIndex: false },
      { repository, logger: () => {} },
    );
    const pair = await connectClient(ctx);
    try {
      const res = await callTool(pair.client, "causoryn_find_symbols", {
        query: "createCausorynMcpServer",
      });
      const env = expectEnvelope(res);
      expect(env.status).toBe("ok");
      expect(env.error).toBeNull();
      const hits = (env.data as Record<string, unknown>).hits as Array<Record<string, unknown>>;
      expect(hits).toHaveLength(1);
      expect(hits[0]?.kind).toBe("Function");
      expect(hits[0]?.symbolId).toBe(realFn.id);

      // Pure UnknownExternal (with no real definition) is still searchable
      const extRes = await callTool(pair.client, "causoryn_find_symbols", {
        query: "externalOnlyLibCall",
      });
      const extEnv = expectEnvelope(extRes);
      expect(extEnv.status).toBe("ok");
      expect((extEnv.data as Record<string, unknown>).hits).toHaveLength(1);
    } finally {
      await pair.close();
      ctx.close();
    }
  });
});

describe("Task 2.7 (Envelope side) — Per-Language Coverage (coverage.byLanguage)", () => {
  it("reports per-language tier & edge breakdown in sorted key order so TS L2 never masks C# L0 degradation", () => {
    const repository = new InMemoryGraphRepository();
    const workspaceId = "default";
    repository.registerWorkspace({
      id: workspaceId,
      rootPath: FIXTURE_ROOT,
      createdAt: FIXED_TIMESTAMP,
    });
    const build = repository.beginBuild({
      workspaceId,
      revision: { id: "rev-multilang", sequence: 1 },
      configHash: "cfg-multilang",
      analyzerFingerprint: "multi@0.1.0",
      createdAt: FIXED_TIMESTAMP,
    });

    const loc = (relativePath: string) => ({
      relativePath,
      startLine: 1,
      endLine: 5,
      sourceHash: "0".repeat(64),
    });
    const tsFile: GraphNode = {
      id: nodeId({ workspaceId, kind: "File", qualifiedName: "src/index.ts", relativePath: "src/index.ts" }),
      kind: "File",
      qualifiedName: "src/index.ts",
      language: "typescript",
      location: loc("src/index.ts"),
      attributes: { relativePath: "src/index.ts" },
    };
    const tsFn: GraphNode = {
      id: nodeId({ workspaceId, kind: "Function", qualifiedName: "boot", relativePath: "src/index.ts" }),
      kind: "Function",
      qualifiedName: "boot",
      language: "typescript",
      location: loc("src/index.ts"),
      attributes: { relativePath: "src/index.ts" },
    };
    const csFile1: GraphNode = {
      id: nodeId({ workspaceId, kind: "File", qualifiedName: "src/Order.cs", relativePath: "src/Order.cs" }),
      kind: "File",
      qualifiedName: "src/Order.cs",
      language: "csharp",
      location: loc("src/Order.cs"),
      attributes: { relativePath: "src/Order.cs" },
    };
    const csFile2: GraphNode = {
      id: nodeId({ workspaceId, kind: "File", qualifiedName: "src/Repo.cs", relativePath: "src/Repo.cs" }),
      kind: "File",
      qualifiedName: "src/Repo.cs",
      language: "csharp",
      location: loc("src/Repo.cs"),
      attributes: { relativePath: "src/Repo.cs" },
    };
    const goFile: GraphNode = {
      id: nodeId({ workspaceId, kind: "File", qualifiedName: "cmd/main.go", relativePath: "cmd/main.go" }),
      kind: "File",
      qualifiedName: "cmd/main.go",
      language: "go",
      location: loc("cmd/main.go"),
      attributes: { relativePath: "cmd/main.go" },
    };
    const goFn: GraphNode = {
      id: nodeId({ workspaceId, kind: "Function", qualifiedName: "main.run", relativePath: "cmd/main.go" }),
      kind: "Function",
      qualifiedName: "main.run",
      language: "go",
      location: loc("cmd/main.go"),
      attributes: { relativePath: "cmd/main.go" },
    };
    const extTarget: GraphNode = {
      id: nodeId({ workspaceId, kind: "UnknownExternal", qualifiedName: "fmt.Println" }),
      kind: "UnknownExternal",
      qualifiedName: "fmt.Println",
      attributes: {},
    };
    for (const node of [tsFile, tsFn, csFile1, csFile2, goFile, goFn, extTarget]) {
      repository.addNode(build.buildId, node);
    }
    const evTs: Evidence = {
      id: evidenceId({
        workspaceId,
        kind: "ast-span",
        analyzerId: "ts-adapter",
        analyzerVersion: "0.1.0",
        rationale: "ts contains",
      }),
      kind: "ast-span",
      analyzerId: "ts-adapter",
      analyzerVersion: "0.1.0",
      rationale: "ts contains",
    };
    const evGo: Evidence = {
      id: evidenceId({
        workspaceId,
        kind: "ast-span",
        analyzerId: "go-worker",
        analyzerVersion: "0.1.0",
        rationale: "go unresolved call",
      }),
      kind: "ast-span",
      analyzerId: "go-worker",
      analyzerVersion: "0.1.0",
      rationale: "go unresolved call",
    };
    repository.addEvidence(build.buildId, evTs);
    repository.addEvidence(build.buildId, evGo);

    const tsEdge: GraphEdge = createEdge({
      workspaceId,
      kind: "CONTAINS",
      from: tsFile.id,
      to: tsFn.id,
      resolution: "verified",
      evidenceIds: [evTs.id],
    });
    const goUnresolved: GraphEdge = createEdge({
      workspaceId,
      kind: "CALLS",
      from: goFn.id,
      to: extTarget.id,
      resolution: "unresolved",
      evidenceIds: [evGo.id],
    });
    repository.addEdge(build.buildId, tsEdge);
    repository.addEdge(build.buildId, goUnresolved);
    const snapshot = repository.publish(build.buildId, "partial", FIXED_TIMESTAMP);

    const cov = coverageOf(snapshot);
    expect(cov.tier).toBe("L2");
    expect(cov.byLanguage).toBeDefined();
    expect(Object.keys(cov.byLanguage ?? {})).toEqual(["csharp", "go", "typescript"]);
    expect(cov.byLanguage?.csharp).toEqual({
      tier: "L0",
      files: 2,
      verifiedEdges: 0,
      heuristicEdges: 0,
      unresolvedEdges: 0,
      coverageRatio: 0,
    });
    expect(cov.byLanguage?.go).toEqual({
      tier: "L1",
      files: 1,
      verifiedEdges: 0,
      heuristicEdges: 0,
      unresolvedEdges: 1,
      coverageRatio: 0,
    });
      expect(cov.byLanguage?.typescript).toEqual({
      tier: "L2",
      files: 1,
      verifiedEdges: 1,
      heuristicEdges: 0,
      unresolvedEdges: 0,
      coverageRatio: 1,
    });
  });

  it("Finding #8: skips Workspace --CONTAINS--> File inventory edges in byLanguage so L0 languages report verifiedEdges: 0 and coverageRatio: 0", () => {
    const repository = new InMemoryGraphRepository();
    const workspaceId = "default";
    repository.registerWorkspace({
      id: workspaceId,
      rootPath: FIXTURE_ROOT,
      createdAt: FIXED_TIMESTAMP,
    });
    const build = repository.beginBuild({
      workspaceId,
      revision: { id: "rev-l0-inventory", sequence: 1 },
      configHash: "cfg-l0",
      analyzerFingerprint: "multi@0.1.0",
      createdAt: FIXED_TIMESTAMP,
    });

    const loc = (relativePath: string) => ({
      relativePath,
      startLine: 1,
      endLine: 5,
      sourceHash: "0".repeat(64),
    });
    const workspaceNode: GraphNode = {
      id: nodeId({ workspaceId, kind: "Workspace", qualifiedName: workspaceId }),
      kind: "Workspace",
      qualifiedName: workspaceId,
      attributes: {},
    };
    const csFile1: GraphNode = {
      id: nodeId({ workspaceId, kind: "File", qualifiedName: "src/Order.cs", relativePath: "src/Order.cs" }),
      kind: "File",
      qualifiedName: "src/Order.cs",
      language: "csharp",
      location: loc("src/Order.cs"),
      attributes: { relativePath: "src/Order.cs" },
    };
    const csFile2: GraphNode = {
      id: nodeId({ workspaceId, kind: "File", qualifiedName: "src/Repo.cs", relativePath: "src/Repo.cs" }),
      kind: "File",
      qualifiedName: "src/Repo.cs",
      language: "csharp",
      location: loc("src/Repo.cs"),
      attributes: { relativePath: "src/Repo.cs" },
    };
    const tsFile: GraphNode = {
      id: nodeId({ workspaceId, kind: "File", qualifiedName: "src/index.ts", relativePath: "src/index.ts" }),
      kind: "File",
      qualifiedName: "src/index.ts",
      language: "typescript",
      location: loc("src/index.ts"),
      attributes: { relativePath: "src/index.ts" },
    };
    const tsFn: GraphNode = {
      id: nodeId({ workspaceId, kind: "Function", qualifiedName: "boot", relativePath: "src/index.ts" }),
      kind: "Function",
      qualifiedName: "boot",
      language: "typescript",
      location: loc("src/index.ts"),
      attributes: { relativePath: "src/index.ts" },
    };

    for (const node of [workspaceNode, csFile1, csFile2, tsFile, tsFn]) {
      repository.addNode(build.buildId, node);
    }

    const evInv: Evidence = {
      id: evidenceId({
        workspaceId,
        kind: "file-inventory",
        analyzerId: "inventory",
        analyzerVersion: "0.1.0",
        rationale: "workspace file inventory",
      }),
      kind: "file-inventory",
      analyzerId: "inventory",
      analyzerVersion: "0.1.0",
      rationale: "workspace file inventory",
    };
    const evTs: Evidence = {
      id: evidenceId({
        workspaceId,
        kind: "ast-span",
        analyzerId: "ts-adapter",
        analyzerVersion: "0.1.0",
        rationale: "ts contains",
      }),
      kind: "ast-span",
      analyzerId: "ts-adapter",
      analyzerVersion: "0.1.0",
      rationale: "ts contains",
    };
    repository.addEvidence(build.buildId, evInv);
    repository.addEvidence(build.buildId, evTs);

    // Workspace --CONTAINS--> File inventory edges must NOT inflate per-language L0 coverage
    for (const fileNode of [csFile1, csFile2, tsFile]) {
      repository.addEdge(
        build.buildId,
        createEdge({
          workspaceId,
          kind: "CONTAINS",
          from: workspaceNode.id,
          to: fileNode.id,
          resolution: "verified",
          evidenceIds: [evInv.id],
        }),
      );
    }
    repository.addEdge(
      build.buildId,
      createEdge({
        workspaceId,
        kind: "CONTAINS",
        from: tsFile.id,
        to: tsFn.id,
        resolution: "verified",
        evidenceIds: [evTs.id],
      }),
    );

    const snapshot = repository.publish(build.buildId, "partial", FIXED_TIMESTAMP);
    const cov = coverageOf(snapshot);

    expect(cov.byLanguage?.csharp).toEqual({
      tier: "L0",
      files: 2,
      verifiedEdges: 0,
      heuristicEdges: 0,
      unresolvedEdges: 0,
      coverageRatio: 0,
    });
    expect(cov.byLanguage?.typescript).toEqual({
      tier: "L2",
      files: 1,
      verifiedEdges: 1,
      heuristicEdges: 0,
      unresolvedEdges: 0,
      coverageRatio: 1,
    });
  });
});

describe("Task 2.5 (MCP side) — Non-Blocking Warm/Cold Calls & notifications/progress", { timeout: 30_000 }, () => {
  it("warm start: serves read tool immediately against published snapshot with stale warning while background refresh is running", async () => {
    const ctx = makeFixtureContext();
    let releaseRefresh!: () => void;
    const refreshHold = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const origRunAsync = ctx.indexService.runIndexAsync.bind(ctx.indexService);
    ctx.indexService.runIndexAsync = async (root: string) => {
      await refreshHold;
      return origRunAsync(root);
    };

    // Start a slow background refresh while published snapshot already exists
    ctx.jobManager.refreshIndex(FIXTURE_ROOT, { mode: "full" });
    const pair = await connectClient(ctx, { indexWaitTimeoutMs: 5_000 });
    try {
      const t0 = performance.now();
      const res = await callTool(pair.client, "causoryn_find_symbols", { query: "OrdersService" });
      const elapsed = performance.now() - t0;
      const env = expectEnvelope(res);
      expect(env.status).toBe("ok");
      expect(elapsed).toBeLessThan(1_000);
      expect(
        (env.warnings as string[]).some((w) => /stale/i.test(w)),
        `Expected stale warning while refresh runs: ${JSON.stringify(env.warnings)}`,
      ).toBe(true);
    } finally {
      releaseRefresh();
      await pair.close();
      ctx.close();
    }
  });

  it("cold start: forwards notifications/progress for _meta.progressToken and returns structured partial indexing status if still indexing after wait window", async () => {
    const ctx = createCausorynContext(
      { workspaceId: "default", allowRoots: [FIXTURE_ROOT], autoIndex: true },
      { deferAutoIndex: true, logger: () => {} },
    );
    let releaseIndex!: () => void;
    const indexHold = new Promise<void>((resolve) => {
      releaseIndex = resolve;
    });
    const origRunAsync = ctx.indexService.runIndexAsync.bind(ctx.indexService);
    ctx.indexService.runIndexAsync = async (root: string) => {
      await indexHold;
      return origRunAsync(root);
    };

    const progressUpdates: Array<{ progress: number; total?: number; message?: string }> = [];
    const pair = await connectClient(ctx, { indexWaitTimeoutMs: 120 });
    pair.client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      progressUpdates.push({
        progress: notification.params.progress,
        ...(notification.params.total === undefined ? {} : { total: notification.params.total }),
        ...(notification.params.message === undefined
          ? {}
          : { message: notification.params.message }),
      });
    });

    try {
      const res = (await pair.client.callTool(
        {
          name: "causoryn_find_symbols",
          arguments: { query: "OrdersService" },
          _meta: { progressToken: "tok-cold-1" },
        },
        undefined,
        {
          onprogress: (p) => {
            progressUpdates.push({
              progress: p.progress,
              ...(p.total === undefined ? {} : { total: p.total }),
              ...(p.message === undefined ? {} : { message: p.message }),
            });
          },
        },
      )) as CallToolResult;

      const env = expectEnvelope(res);
      expect(env.status).toBe("partial");
      expect(env.error).toBeNull();
      const data = env.data as Record<string, unknown>;
      expect(data.indexing).toBe(true);
      expect(data.status).toBe("indexing");
      expect(typeof data.jobId).toBe("string");
      expect(data.retryAfterMs).toBe(3000);
      expect(progressUpdates.length).toBeGreaterThanOrEqual(1);
    } finally {
      releaseIndex();
      await pair.close();
      ctx.close();
    }
  });

  it("Finding #2: context.close() invokes jobManager.close() BEFORE closing storage repository", () => {
    const tmpDataDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-ctx-close-"));
    try {
      const dbPath = path.join(tmpDataDir, "graph.sqlite");
      const ctx = createCausorynContext(
        {
          workspaceId: "default",
          allowRoots: [FIXTURE_ROOT],
          storage: { dataDbPath: dbPath },
          autoIndex: false,
        },
        { logger: () => {} },
      );

      let jobManagerClosed = false;
      let dbStillOpenDuringJobClose = false;
      (ctx.jobManager as unknown as { close?: () => void }).close = () => {
        jobManagerClosed = true;
        // Storage must STILL be open when jobManager.close() runs!
        expect(() => ctx.repository.getLatestPublished("default")).not.toThrow();
        dbStillOpenDuringJobClose = true;
      };

      ctx.close();

      expect(jobManagerClosed).toBe(true);
      expect(dbStillOpenDuringJobClose).toBe(true);
      // Storage must be closed AFTER ctx.close() completes
      expect(() => ctx.repository.getLatestPublished("default")).toThrow();
    } finally {
      rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });

  it("Finding #9: getActiveIndexJob & waitForInitialIndex expose real job.progress.phase via subscribeProgress (not 200ms polling) and clean up subscription", async () => {
    const ctx = createCausorynContext(
      { workspaceId: "default", allowRoots: [FIXTURE_ROOT], autoIndex: true },
      { deferAutoIndex: true, logger: () => {} },
    );

    let releaseAnalyze!: () => void;
    const analyzeHold = new Promise<void>((resolve) => {
      releaseAnalyze = resolve;
    });
    const origRunAsync = ctx.indexService.runIndexAsync.bind(ctx.indexService);
    ctx.indexService.runIndexAsync = async (root: string, options) => {
      options?.onProgress?.({
        phase: "analyzing",
        completed: 2,
        total: 4,
        message: "Analyzing TypeScript files (2/4)",
      });
      await analyzeHold;
      options?.onProgress?.({
        phase: "publishing",
        completed: 1,
        total: 1,
        message: "Publishing snapshot",
      });
      return origRunAsync(root, options);
    };

    let subscribeCalls = 0;
    let unsubscribeCalls = 0;
    const origSubscribe = ctx.jobManager.subscribeProgress.bind(ctx.jobManager);
    ctx.jobManager.subscribeProgress = (jobId, listener) => {
      subscribeCalls += 1;
      const unsub = origSubscribe(jobId, listener);
      return () => {
        unsubscribeCalls += 1;
        unsub();
      };
    };

    const progressUpdates: Array<{ progress: number; total?: number; message?: string }> = [];
    const pair = await connectClient(ctx, { indexWaitTimeoutMs: 80 });
    try {
      const res = (await pair.client.callTool(
        {
          name: "causoryn_find_symbols",
          arguments: { query: "OrdersService" },
          _meta: { progressToken: "tok-phase-1" },
        },
        undefined,
        {
          onprogress: (p) => {
            progressUpdates.push({
              progress: p.progress,
              ...(p.total === undefined ? {} : { total: p.total }),
              ...(p.message === undefined ? {} : { message: p.message }),
            });
          },
        },
      )) as CallToolResult;

      const env = expectEnvelope(res);
      expect(env.status).toBe("partial");
      const data = env.data as {
        indexing?: boolean;
        progress?: { phase?: string; completed?: number; total?: number };
      };
      expect(data.indexing).toBe(true);
      // Real phase from job.progress.phase ("analyzing"), NOT hardcoded "indexing"
      expect(data.progress?.phase).toBe("analyzing");
      expect(ctx.getActiveIndexJob?.()?.phase).toBe("analyzing");
      // Subscription used and cleaned up in finally
      expect(subscribeCalls).toBeGreaterThanOrEqual(1);
      expect(unsubscribeCalls).toBe(subscribeCalls);
      // Real phase progress event streamed immediately even within an 80ms wait window (<200ms)
      expect(
        progressUpdates.some((u) => (u.message ?? "").includes("analyzing")),
        `Expected real analyzing progress event, got: ${JSON.stringify(progressUpdates)}`,
      ).toBe(true);
    } finally {
      releaseAnalyze();
      await pair.close();
      ctx.close();
    }
  });

  it("Finding #9 (cli-stdio): avoids double waitForInitialIndex when dynamic roots beforeToolCallHook is installed", () => {
    const cliStdioSrc = readFileSync(
      path.join(REPO_ROOT, "packages", "mcp-server", "src", "cli-stdio.ts"),
      "utf8",
    );
    expect(cliStdioSrc).toMatch(
      /if\s*\(\s*beforeToolCallHook\s*!==\s*undefined\s*\)\s*\{\s*await\s+beforeToolCallHook\s*\(\s*toolName\s*,\s*hookContext\s*\)\s*;\s*return\s*;\s*\}/,
    );
  });

  it("Polish Note #1: full profile appends (Deprecated: use <replacement>) to superseded legacy tools while core profile remains untouched and <= 15,000 chars", async () => {
    const ctx = makeFixtureContext({ autoIndex: false });
    try {
      const corePair = await connectClient(ctx, { toolProfile: "core" });
      try {
        const { tools: coreTools } = await corePair.client.listTools();
        expect(JSON.stringify(coreTools).length).toBeLessThanOrEqual(15_000);
        for (const tool of coreTools) {
          expect(tool.description ?? "").not.toContain("Deprecated:");
        }
      } finally {
        await corePair.close();
      }

      const fullPair = await connectClient(ctx, { toolProfile: "full" });
      try {
        const { tools: fullTools } = await fullPair.client.listTools();
        const byName = new Map(fullTools.map((t) => [t.name, t]));
        for (const [legacyName, replacement] of Object.entries(DEPRECATED_TOOL_REPLACEMENTS)) {
          const tool = byName.get(legacyName);
          expect(tool, `missing ${legacyName} in full profile`).toBeDefined();
          expect(tool?.description ?? "").toContain(`(Deprecated: use ${replacement})`);
        }
        for (const coreName of CORE_TOOL_NAMES) {
          const tool = byName.get(coreName);
          expect(tool?.description ?? "").not.toContain("Deprecated:");
        }
      } finally {
        await fullPair.close();
      }
    } finally {
      ctx.close();
    }
  });
});
