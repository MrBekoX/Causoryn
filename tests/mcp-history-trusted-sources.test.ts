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
  type CausorynContext,
} from "../packages/mcp-server/src/index.js";

/**
 * History tools (history profile) must prefer a trusted source over the
 * repo-committed / working-tree `.causoryn/architecture-snapshot.json` file:
 * - `working-tree` is read from the local index's published snapshot (the
 *   engine's own analysis), never from the working-tree snapshot file, when a
 *   published snapshot exists.
 * - a commit ref is read from the local index when the indexed content is
 *   verified (via read-only git tree reads) to be exactly that commit's
 *   content; otherwise the engine analyzes the commit from its git objects.
 *   Only a commit the engine does not analyze (beyond the per-call budget, or
 *   with fresh analysis disabled) falls back to the committed file, flagged
 *   with `snapshot-loaded-from-committed-git-blob`.
 */

const TRUST_WARNING = "snapshot-loaded-from-committed-git-blob";
const GIT_OBJECTS_NOTE = "was analyzed from its git objects";
const BUDGET_ENV = "CAUSORYN_HISTORY_MAX_ANALYSES";
const SNAPSHOT_FILE = path.join(".causoryn", "architecture-snapshot.json");

const cleanups: Array<() => void> = [];
afterEach(() => {
  delete process.env[BUDGET_ENV];
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function poisonedSet(className: string, relativePath = "src/backdoor.ts"): string {
  return `${JSON.stringify(
    {
      nodes: [
        {
          kind: "Class",
          qualifiedName: className,
          relativePath,
          signature: `class ${className}`,
        },
      ],
      edges: [],
    },
    null,
    2,
  )}\n`;
}

interface Repo {
  readonly root: string;
  readonly write: (relativePath: string, content: string) => void;
}

/** v1: orders.ts + poisoned committed snapshot; v2: + billing.ts + another poisoned snapshot. */
function makeRepo(): Repo {
  const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-history-trust-"));
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
  write(
    "src/orders.ts",
    "export class OrdersService {\n  create(sku: string): string {\n    return `ord:${sku}`;\n  }\n}\n",
  );
  write(SNAPSHOT_FILE, poisonedSet("CommittedBackdoorV1"));
  git("add", "-A");
  git("commit", "-m", "v1");
  git("tag", "v1");
  write(
    "src/billing.ts",
    "export class BillingService {\n  charge(id: string): boolean {\n    return id.length > 0;\n  }\n}\n",
  );
  write(SNAPSHOT_FILE, poisonedSet("CommittedBackdoorV2"));
  git("add", "-A");
  git("commit", "-m", "v2");
  git("tag", "v2");
  return { root, write };
}

interface Session {
  readonly context: CausorynContext;
  readonly call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

async function openHistorySession(root: string, autoIndex: boolean): Promise<Session> {
  const context = createCausorynContext(
    { workspaceId: "history-trust", allowRoots: [root], autoIndex },
    { logger: () => {} },
  );
  const server = createCausorynMcpServer(context, { toolProfile: "history" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "history-trust-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(() => {
    void client.close();
    void server.close();
    context.close();
  });
  return {
    context,
    call: async (name, args) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      const parsed = EnvelopeSchema.safeParse(result.structuredContent);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
      const envelope = (parsed as { success: true; data: Record<string, unknown> }).data;
      expect(envelope.status, JSON.stringify(envelope)).not.toBe("error");
      return envelope;
    },
  };
}

function qualifiedNamesOf(changes: unknown): string[] {
  return (changes as Array<{ node: { qualifiedName: string } }>).map(
    (entry) => entry.node.qualifiedName,
  );
}

function indexedNodeCount(context: CausorynContext): number {
  const read = context.repository.getLatestPublished("history-trust");
  expect(read, "the fixture index must be published").toBeDefined();
  return read?.snapshot.nodes.length ?? -1;
}

describe("history tools use trusted sources before the committed snapshot file", { timeout: 120_000 }, () => {
  it("working-tree comes from the local index, not from an untrusted working-tree snapshot file", async () => {
    const repo = makeRepo();
    // Uncommitted, untrusted working-tree snapshot file (e.g. from a PR checkout).
    repo.write(SNAPSHOT_FILE, poisonedSet("WorkingTreeImplant", "lib/implant/hook.ts"));
    const session = await openHistorySession(repo.root, true);
    const nodeCount = indexedNodeCount(session.context);

    // causoryn_architecture_timeline accepts commit refs only (the core resolves
    // every ref to a commit before sampling), so the working-tree point is
    // exercised through causoryn_compare_architecture.
    const compareEnvelope = await session.call("causoryn_compare_architecture", {
      baseRef: "v1",
      targetRef: "working-tree",
    });
    const diff = (compareEnvelope.data as Record<string, unknown>).diff as Record<string, unknown>;
    // v1 is the engine's own analysis of that commit (git objects), not its
    // poisoned committed file: OrdersService is unchanged, BillingService added.
    const added = qualifiedNamesOf(diff.added);
    expect(added).not.toContain("OrdersService");
    expect(added).toContain("BillingService");
    expect(qualifiedNamesOf(diff.removed)).toEqual([]);
    expect(JSON.stringify(diff)).not.toContain("WorkingTreeImplant");
    expect(JSON.stringify(diff)).not.toContain("CommittedBackdoorV1");
    const compareWarnings = compareEnvelope.warnings as string[];
    // compare surfaces the trust status of each side: no side used a committed file.
    expect(compareWarnings.some((w) => w.includes(TRUST_WARNING))).toBe(false);
    expect(
      compareWarnings.some((w) => w.startsWith("'v1' (commit ") && w.includes(GIT_OBJECTS_NOTE)),
    ).toBe(true);
    expect(compareWarnings.some((w) => w.includes("local index snapshot"))).toBe(true);

    // Both sides working-tree: every node of the published index, none of the file.
    const selfEnvelope = await session.call("causoryn_compare_architecture", {
      baseRef: "working-tree",
      targetRef: "working-tree",
    });
    const selfDiff = (selfEnvelope.data as Record<string, unknown>).diff as Record<string, unknown>;
    expect((selfDiff.summary as Record<string, number>).unchangedNodes).toBe(nodeCount);
    expect(nodeCount).toBeGreaterThan(1);
    expect(JSON.stringify(selfDiff)).not.toContain("WorkingTreeImplant");
  });

  it("without a published index the working-tree file is used and explicitly flagged", async () => {
    const repo = makeRepo();
    repo.write(SNAPSHOT_FILE, poisonedSet("WorkingTreeImplant", "lib/implant/hook.ts"));
    const session = await openHistorySession(repo.root, false);

    const compareEnvelope = await session.call("causoryn_compare_architecture", {
      baseRef: "v1",
      targetRef: "working-tree",
    });
    const diff = (compareEnvelope.data as Record<string, unknown>).diff as Record<string, unknown>;
    expect(qualifiedNamesOf(diff.added)).toContain("WorkingTreeImplant");
    // v1 comes from the engine's analysis of the commit, not from its committed file.
    expect(qualifiedNamesOf(diff.removed)).toContain("OrdersService");
    expect(JSON.stringify(diff)).not.toContain("CommittedBackdoorV1");
    const warnings = compareEnvelope.warnings as string[];
    expect(warnings.some((w) => w.includes(TRUST_WARNING) && w.includes("'working-tree'"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.includes(TRUST_WARNING) && w.includes("'v1'"))).toBe(false);
    expect(
      warnings.some((w) => w.startsWith("'v1' (commit ") && w.includes(GIT_OBJECTS_NOTE)),
    ).toBe(true);
  });

  it("a commit whose content matches the local index is read from the index, not from its committed file", async () => {
    const repo = makeRepo();
    // Clean checkout of v2: the index is exactly v2's content.
    const session = await openHistorySession(repo.root, true);
    const nodeCount = indexedNodeCount(session.context);

    const compareEnvelope = await session.call("causoryn_compare_architecture", {
      baseRef: "v2",
      targetRef: "working-tree",
    });
    const diff = (compareEnvelope.data as Record<string, unknown>).diff as Record<string, unknown>;
    const summary = diff.summary as Record<string, number>;
    expect(summary.added).toBe(0);
    expect(summary.removed).toBe(0);
    expect(summary.changed).toBe(0);
    expect(summary.unchangedNodes).toBe(nodeCount);
    expect((compareEnvelope.warnings as string[]).some((w) => w.includes(TRUST_WARNING))).toBe(
      false,
    );

    const timelineEnvelope = await session.call("causoryn_architecture_timeline", {
      refs: ["v1", "v2"],
    });
    const timeline = (timelineEnvelope.data as Record<string, unknown>).timeline as Record<
      string,
      unknown
    >;
    const points = timeline.points as Array<Record<string, unknown>>;
    const v2 = points.find((point) => point.ref === "v2");
    expect(v2?.trustWarning).toBeUndefined();
    expect(v2?.nodeCount).toBe(nodeCount);
    // v1 is not the indexed commit: it is analyzed from its git objects.
    expect(points.find((point) => point.ref === "v1")?.trustWarning).toBeUndefined();
    const timelineWarnings = timelineEnvelope.warnings as string[];
    expect(
      timelineWarnings.some((w) => w.startsWith("'v2' (commit ") && w.includes("local index snapshot")),
    ).toBe(true);
    expect(
      timelineWarnings.some((w) => w.startsWith("'v1' (commit ") && w.includes(GIT_OBJECTS_NOTE)),
    ).toBe(true);
    const interval = (timeline.intervals as Array<Record<string, unknown>>)[0];
    expect(interval?.kind).toBe("diff");
    const changes = interval?.changes as Record<string, number>;
    // v1 → v2 adds src/billing.ts (File, BillingService, BillingService.charge).
    expect(changes.added).toBe(3);
    expect(changes.removed).toBe(0);
  });

  it("a commit is not served from the index once the working tree no longer matches it", async () => {
    const repo = makeRepo();
    const session = await openHistorySession(repo.root, true);
    // Edit after indexing: the index still reflects v2, but the files on disk
    // no longer prove it, so the commit cannot be verified and falls back.
    repo.write(
      "src/orders.ts",
      "export class OrdersService {\n  cancel(): void {}\n}\n",
    );

    const compareEnvelope = await session.call("causoryn_compare_architecture", {
      baseRef: "v2",
      targetRef: "working-tree",
    });
    const warnings = compareEnvelope.warnings as string[];
    // v2 is analyzed from its git objects instead of its committed file.
    expect(warnings.some((w) => w.includes(TRUST_WARNING))).toBe(false);
    expect(
      warnings.some((w) => w.startsWith("'v2' (commit ") && w.includes(GIT_OBJECTS_NOTE)),
    ).toBe(true);
    // The working-tree point is still the trusted index, with an honest freshness note.
    expect(warnings.some((w) => w.includes("changed on disk") && w.includes("causoryn_refresh_index"))).toBe(
      true,
    );
    const diff = (compareEnvelope.data as Record<string, unknown>).diff as Record<string, unknown>;
    expect(JSON.stringify(diff)).not.toContain("CommittedBackdoorV2");
    // The (stale) index still describes v2's content, which is what v2's analysis found.
    const summary = diff.summary as Record<string, number>;
    expect([summary.added, summary.removed, summary.changed]).toEqual([0, 0, 0]);
    expect(summary.unchangedNodes).toBe(indexedNodeCount(session.context));
  });

  it("the committed file stays the last fallback: a commit beyond the fresh-analysis budget is read from it with the trust warning", async () => {
    const repo = makeRepo();
    const session = await openHistorySession(repo.root, false);
    process.env[BUDGET_ENV] = "1";

    const timelineEnvelope = await session.call("causoryn_architecture_timeline", {
      refs: ["v1", "v2"],
    });
    const timeline = (timelineEnvelope.data as Record<string, unknown>).timeline as Record<
      string,
      unknown
    >;
    expect(timeline.analyzedPoints).toBe(2);
    const points = timeline.points as Array<Record<string, unknown>>;
    const v1 = points.find((point) => point.ref === "v1");
    const v2 = points.find((point) => point.ref === "v2");
    expect(v1?.trustWarning).toBeUndefined();
    expect(v2?.trustWarning).toBe(TRUST_WARNING);
    // CommittedBackdoorV2 is the only node of v2's committed file.
    expect(v2?.nodeCount).toBe(1);
    const warnings = timelineEnvelope.warnings as string[];
    expect(
      warnings.some((w) => w.startsWith("'v1' (commit ") && w.includes(GIT_OBJECTS_NOTE)),
    ).toBe(true);
    expect(
      warnings.some((w) =>
        w.includes(`budget of 1 fresh commit analyses (${BUDGET_ENV}) was used up: 'v2'`),
      ),
    ).toBe(true);
  });
});
