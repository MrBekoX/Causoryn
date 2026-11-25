import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TIMELINE_MAX_REFS } from "@causoryn/graph";
import { describe, expect, it } from "vitest";

import { createCausorynContext, createCausorynMcpServer, refreshIndex } from "../src/index.js";
import { ArchitectureTimelineToolInputSchema } from "../src/schemas.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");

/**
 * MCP tool input bounds: every free-form string and array accepted by a tool
 * has a finite upper bound, so a single call cannot make the server do
 * unbounded work (e.g. one git process per timeline ref) or hold unbounded
 * input in memory.
 */

/** JSON-schema paths of strings without maxLength and arrays without maxItems. */
function unboundedPaths(schema: unknown, at: string): string[] {
  if (schema === null || typeof schema !== "object") return [];
  const node = schema as Record<string, unknown>;
  const found: string[] = [];
  if (
    node["type"] === "string" &&
    node["enum"] === undefined &&
    node["const"] === undefined &&
    typeof node["maxLength"] !== "number"
  ) {
    found.push(at);
  }
  if (node["type"] === "array") {
    if (typeof node["maxItems"] !== "number") found.push(`${at}[]`);
    found.push(...unboundedPaths(node["items"], `${at}[]`));
  }
  const properties = node["properties"];
  if (properties !== null && typeof properties === "object") {
    for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
      found.push(...unboundedPaths(child, `${at}.${key}`));
    }
  }
  for (const combinator of ["anyOf", "oneOf", "allOf"]) {
    const variants = node[combinator];
    if (Array.isArray(variants)) {
      variants.forEach((variant, index) => {
        found.push(...unboundedPaths(variant, `${at}<${combinator}${String(index)}>`));
      });
    }
  }
  return found;
}

describe("every tool input string and array is bounded", { timeout: 60_000 }, () => {
  it("core and full profiles: no string without maxLength and no array without maxItems", async () => {
    const context = createCausorynContext(
      { workspaceId: "default", allowRoots: [FIXTURE_ROOT], autoIndex: false },
      { logger: () => {} },
    );
    try {
      const offenders: string[] = [];
      for (const toolProfile of ["core", "full"] as const) {
        const server = createCausorynMcpServer(context, { toolProfile });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "bounds-walker", version: "0.0.0" });
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        try {
          const { tools } = await client.listTools();
          for (const tool of tools) {
            // The full-profile export_documentation input schema (annotations
            // payload) is defined and validated in services-architecture.ts.
            if (toolProfile === "full" && tool.name === "causoryn_export_documentation") continue;
            offenders.push(
              ...unboundedPaths(tool.inputSchema, `${toolProfile}:${tool.name}`),
            );
          }
        } finally {
          await client.close();
          await server.close();
        }
      }
      expect(offenders).toEqual([]);
    } finally {
      context.close();
    }
  });

  it("free-form text, identifiers and lists reject oversized values at the schema boundary", async () => {
    const schemas = await import("../src/schemas.js");
    const long = (length: number): string => "x".repeat(length);
    expect(
      schemas.FindSymbolsToolInputSchema.safeParse({ query: long(schemas.MAX_QUERY_LENGTH) }).success,
    ).toBe(true);
    expect(
      schemas.FindSymbolsToolInputSchema.safeParse({ query: long(schemas.MAX_QUERY_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(
      schemas.GetAgentContextToolInputSchema.safeParse({
        task: long(schemas.MAX_TEXT_LENGTH + 1),
        tokenBudget: 100,
      }).success,
    ).toBe(false);
    expect(
      schemas.MapSystemToolInputSchema.safeParse({ cursor: long(schemas.MAX_ID_LENGTH + 1) }).success,
    ).toBe(false);
    expect(
      schemas.PreflightChangeCoreInputSchema.safeParse({
        targetFiles: Array.from({ length: schemas.MAX_LIST_ITEMS + 1 }, (_, i) => `src/f${String(i)}.ts`),
      }).success,
    ).toBe(false);
    expect(
      schemas.VerifyChangeCoreInputSchema.safeParse({ baseRef: long(schemas.MAX_GIT_REF_LENGTH + 1) })
        .success,
    ).toBe(false);
    // Record-typed inputs bound their key count (values are validated downstream).
    expect(
      schemas.MapSystemToolInputSchema.safeParse({
        limits: Object.fromEntries(
          Array.from({ length: 5 }, (_, i) => [`k${String(i)}`, 1]),
        ),
      }).success,
    ).toBe(false);
    expect(
      schemas.VerifyChangeCoreInputSchema.safeParse({
        observedTestRun: Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [`k${String(i)}`, 1]),
        ),
      }).success,
    ).toBe(false);
  });
});

describe("causoryn_architecture_timeline input bounds", () => {
  const refsOf = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `v${String(index)}`);

  it("accepts up to TIMELINE_MAX_REFS refs and rejects one more at the schema boundary", () => {
    expect(
      ArchitectureTimelineToolInputSchema.safeParse({ refs: refsOf(TIMELINE_MAX_REFS) }).success,
    ).toBe(true);
    expect(
      ArchitectureTimelineToolInputSchema.safeParse({ refs: refsOf(TIMELINE_MAX_REFS + 1) })
        .success,
    ).toBe(false);
  });
});

describe("refresh requests are coalesced and the response says so", { timeout: 60_000 }, () => {
  it("a second identical refresh while the first is still queued returns the same jobId with a coalesced warning", async () => {
    const context = createCausorynContext(
      { workspaceId: "default", allowRoots: [FIXTURE_ROOT], autoIndex: false },
      { logger: () => {} },
    );
    try {
      // Both calls run synchronously, before the job queue starts draining.
      const first = refreshIndex(context, "req-refresh-1", { mode: "full" });
      const second = refreshIndex(context, "req-refresh-2", { mode: "full" });
      const firstData = first.data as { jobId: string; status: string };
      const secondData = second.data as { jobId: string; status: string };
      expect(first.warnings).toEqual([]);
      expect(secondData.jobId).toBe(firstData.jobId);
      expect(secondData.status).toBe("queued");
      expect(second.warnings).toEqual([
        `refresh request coalesced into queued job ${firstData.jobId} (1 merged request(s)); no new job was created`,
      ]);
      const done = await context.jobManager.waitForJob(firstData.jobId);
      expect(["done", "reused"]).toContain(done.status);
    } finally {
      context.close();
    }
  });
});

describe("onboarding limits over MCP", { timeout: 60_000 }, () => {
  it("causoryn_map_system profile=onboarding clamps oversized limits and reports onboarding/limit-clamped", async () => {
    const context = createCausorynContext(
      { workspaceId: "default", allowRoots: [FIXTURE_ROOT], autoIndex: true },
      { logger: () => {} },
    );
    const server = createCausorynMcpServer(context, { toolProfile: "core" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bounds-test", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: "causoryn_map_system",
        arguments: {
          profile: "onboarding",
          audience: "maintainer",
          limits: { maxLearningSteps: 1_000_000, entryPointLimit: 1_000_000 },
        },
      })) as CallToolResult;
      const envelope = result.structuredContent as {
        status?: string;
        data?: { warnings?: Array<{ code: string; message: string }>; learningOrder?: unknown[] };
      };
      expect(envelope.status, JSON.stringify(envelope)).toBe("ok");
      const clamped = (envelope.data?.warnings ?? []).filter(
        (warning) => warning.code === "onboarding/limit-clamped",
      );
      expect(clamped.map((warning) => warning.message)).toEqual([
        "entryPointLimit=1000000 exceeds the ceiling 100; clamped to 100",
        "maxLearningSteps=1000000 exceeds the ceiling 500; clamped to 500",
      ]);
    } finally {
      await client.close();
      await server.close();
      context.close();
    }
  });
});
