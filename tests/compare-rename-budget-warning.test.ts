import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { RENAME_MATCHING_BUDGET } from "../packages/graph/src/index.js";
import {
  EnvelopeSchema,
  createCausorynContext,
  createCausorynMcpServer,
} from "../packages/mcp-server/src/index.js";

/**
 * causoryn_compare_architecture: when rename matching is skipped because the
 * change is above its work budget (Claude Security F5), renames are reported
 * as removed + added nodes, and the envelope warnings must say so.
 *
 * Fresh commit analysis is off (historyMaxFreshAnalyses: 0), so both commit
 * points come from their committed snapshot files: the content sets are under
 * the test's control.
 */

const SNAPSHOT_FILE = path.join(".causoryn", "architecture-snapshot.json");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function functionSet(prefix: string, count: number): string {
  const nodes = Array.from({ length: count }, (_, i) => {
    const id = String(i).padStart(4, "0");
    return { kind: "Function", qualifiedName: `${prefix}.fn${id}`, relativePath: `src/${prefix}/f${id}.ts` };
  });
  return `${JSON.stringify({ nodes, edges: [] })}\n`;
}

function makeRepo(side: number): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-rename-budget-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: root, stdio: "pipe" });
  };
  const write = (relativePath: string, content: string): void => {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  };
  git("init", "-b", "main");
  git("config", "user.email", "fixture@causoryn.local");
  git("config", "user.name", "Causoryn Fixture");
  git("config", "commit.gpgsign", "false");
  write("src/index.ts", "export const v = 1;\n");
  write(SNAPSHOT_FILE, functionSet("before", side));
  git("add", "-A");
  git("commit", "-m", "v1");
  git("tag", "v1");
  write("src/index.ts", "export const v = 2;\n");
  write(SNAPSHOT_FILE, functionSet("after", side));
  git("add", "-A");
  git("commit", "-m", "v2");
  git("tag", "v2");
  return root;
}

async function compare(root: string, baseRef: string, targetRef: string): Promise<Record<string, unknown>> {
  const context = createCausorynContext(
    { workspaceId: "rename-budget", allowRoots: [root], autoIndex: false },
    { logger: () => {}, historyMaxFreshAnalyses: 0 },
  );
  const server = createCausorynMcpServer(context, { toolProfile: "history" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "rename-budget-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(() => {
    void client.close();
    void server.close();
    context.close();
  });
  const result = (await client.callTool({
    name: "causoryn_compare_architecture",
    arguments: { baseRef, targetRef },
  })) as CallToolResult;
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  const parsed = EnvelopeSchema.safeParse(result.structuredContent);
  expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  return (parsed as { success: true; data: Record<string, unknown> }).data;
}

describe("causoryn_compare_architecture — rename matching above its budget", () => {
  it("warns in the envelope when rename matching was skipped", async () => {
    const side = Math.ceil(Math.sqrt(RENAME_MATCHING_BUDGET.maxCandidatePairs)) + 1;
    const envelope = await compare(makeRepo(side), "v1", "v2");

    const warnings = envelope.warnings as string[];
    expect(warnings.some((line) => line.includes("rename-matching-skipped"))).toBe(true);
    const diff = (envelope.data as Record<string, unknown>).diff as Record<string, unknown>;
    const summary = diff.summary as Record<string, number>;
    expect(summary.renamed).toBe(0);
    expect(summary.removed).toBe(side);
    expect(summary.added).toBe(side);
  }, 120_000);
});
