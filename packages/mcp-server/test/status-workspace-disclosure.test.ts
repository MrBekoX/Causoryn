import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { createCausorynContext, createCausorynMcpServer, EnvelopeSchema } from "../src/index.js";

/**
 * Claude Security F73 (also_at of F21): the `workspace` argument of
 * causoryn_status and causoryn_get_capabilities goes through
 * WorkspaceAccessPolicy.authorizeRoot, which decides lexically before any
 * filesystem access. A path outside the allowRoots gets one fixed error whether
 * it is a directory, a file or missing.
 */

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function makeDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

async function errorOf(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const parsed = EnvelopeSchema.safeParse(result.structuredContent);
  expect(parsed.success).toBe(true);
  const envelope = (parsed as { success: true; data: Record<string, unknown> }).data;
  expect(envelope.status).toBe("error");
  return envelope.error as Record<string, unknown>;
}

describe("causoryn_status / causoryn_get_capabilities — workspace argument (F73)", () => {
  it("answers every path outside the allowRoots with the same error", async () => {
    const root = makeDir("causoryn-status-root-");
    const outside = makeDir("causoryn-status-outside-");
    mkdirSync(path.join(outside, "dir"));
    writeFileSync(path.join(outside, "file.txt"), "x");
    const context = createCausorynContext({ workspaceId: "default", allowRoots: [root], autoIndex: false });
    const server = createCausorynMcpServer(context, { toolProfile: "full", outputSchemaProfile: "full" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "vitest-client", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      for (const tool of ["causoryn_status", "causoryn_get_capabilities"]) {
        const errors = [];
        for (const probe of [path.join(outside, "dir"), path.join(outside, "file.txt"), path.join(outside, "missing")]) {
          errors.push(await errorOf(client, tool, { workspace: probe }));
        }
        for (const error of errors) {
          expect(error.code, tool).toBe("WORKSPACE_NOT_AUTHORIZED");
          expect(error.message, tool).toBe(errors[0]?.message);
          expect(String(error.message)).not.toContain(outside);
        }
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
