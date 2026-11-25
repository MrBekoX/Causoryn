import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TIMELINE_MAX_REFS } from "@causoryn/graph";
import { describe, expect, it } from "vitest";

import { createCausorynContext, createCausorynMcpServer } from "../src/index.js";
import { ArchitectureTimelineToolInputSchema } from "../src/schemas.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");

/**
 * MCP tool input bounds: every free-form string and array accepted by a tool
 * has a finite upper bound, so a single call cannot make the server do
 * unbounded work (e.g. one git process per timeline ref) or hold unbounded
 * input in memory.
 */

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
