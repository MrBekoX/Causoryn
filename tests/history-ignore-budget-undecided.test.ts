import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  EnvelopeSchema,
  createCausorynContext,
  createCausorynMcpServer,
} from "../packages/mcp-server/src/index.js";
import { pathRuleFilter } from "../packages/mcp-server/src/history-commit-analysis.js";
import { WorkspaceAccessPolicy } from "../packages/workspace/src/index.js";

/**
 * History analysis reads committed files from git objects and filters them by
 * the workspace's ignore rules. A path those rules cannot decide within their
 * per-decision work budget (Claude Security F32) must not vanish silently: it
 * is counted among the commit's files that were not analyzed, as the on-disk
 * inventory reports such a path instead of dropping it.
 */

const CHAIN = Array.from({ length: 32 }, () => "a").join("/");
const ADVERSARIAL_IGNORE = Array.from({ length: 200 }, (_, i) => `**/${CHAIN}/b${String(i).padStart(4, "0")}`);
const DEEP_FILE = `${Array.from({ length: 128 }, () => "a").join("/")}/file.ts`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("history pathRuleFilter — a decision that runs out of budget", () => {
  it("is reported as undecided, not as excluded", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-history-undecided-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const config = WorkspaceAccessPolicy.create({ allowRoots: [root], extraIgnore: ADVERSARIAL_IGNORE }).config;
    const decide = pathRuleFilter(config);
    expect(decide(DEEP_FILE)).toBe("undecided");
    expect(decide("src/app.ts")).toBe("included");
    expect(decide("node_modules/x/index.ts")).toBe("excluded");
  });
});

/** A repository whose second commit adds DEEP_FILE through the index only (no long path on disk). */
function makeRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-history-undecided-repo-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const git = (args: string[], input?: string): string =>
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      ...(input === undefined ? {} : { input }),
    }).trim();
  git(["init", "-b", "main"]);
  git(["config", "user.email", "fixture@causoryn.local"]);
  git(["config", "user.name", "Causoryn Fixture"]);
  git(["config", "commit.gpgsign", "false"]);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "app.ts"), "export const app = 1;\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-m", "v1"]);
  git(["tag", "v1"]);
  const blob = git(["hash-object", "-w", "--stdin"], "export const deep = 1;\n");
  git(["update-index", "--add", "--cacheinfo", `100644,${blob},${DEEP_FILE}`]);
  git(["commit", "-m", "v2"]);
  git(["tag", "v2"]);
  return root;
}

describe("causoryn_compare_architecture — an undecided committed path is reported", () => {
  it("counts the path among the commit's files that were not analyzed", async () => {
    const root = makeRepo();
    const context = createCausorynContext(
      { workspaceId: "history-undecided", allowRoots: [root], autoIndex: false, extraIgnore: ADVERSARIAL_IGNORE },
      { logger: () => {} },
    );
    const server = createCausorynMcpServer(context, { toolProfile: "history" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "history-undecided-test", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(() => {
      void client.close();
      void server.close();
      context.close();
    });

    const result = (await client.callTool({
      name: "causoryn_compare_architecture",
      arguments: { baseRef: "v1", targetRef: "v2" },
    })) as CallToolResult;
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const parsed = EnvelopeSchema.safeParse(result.structuredContent);
    expect(parsed.success).toBe(true);
    const warnings = ((parsed as { success: true; data: Record<string, unknown> }).data.warnings ?? []) as string[];
    const note = warnings.find((line) => line.startsWith("'v2'") && line.includes("were not analyzed"));
    expect(note, JSON.stringify(warnings)).toBeDefined();
    expect(note).toContain("1 file(s)");
    expect(note).toContain("ignore rules could not decide");
  }, 120_000);
});
