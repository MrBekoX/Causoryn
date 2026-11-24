import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCausorynContext, type CausorynContext } from "@causoryn/mcp-server";

/**
 * Finding 7 (plan Task 2.5): on a warm start with an existing published
 * snapshot, tools answer instantly from that snapshot while a background
 * incremental refresh runs in the indexing worker; an edited file is picked
 * up without an explicit refresh call, and an unchanged tree ends `reused`.
 */

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "causoryn-warm-start-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function setup(): { readonly config: Record<string, unknown>; readonly sourceFile: string } {
  const workspaceDir = path.join(tempRoot, "workspace");
  const dataDir = path.join(tempRoot, "data");
  mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const sourceFile = path.join(workspaceDir, "src", "billing.ts");
  writeFileSync(
    sourceFile,
    "export function computeTotal(amount: number): number { return amount + 1; }\n",
    "utf8",
  );
  const dbPath = path.join(dataDir, "graph.sqlite");
  return {
    config: {
      workspaceId: "ws_warm",
      allowRoots: [workspaceDir],
      storage: { dataDbPath: dbPath },
    },
    sourceFile,
  };
}

const quietLogger = (): void => {};

async function waitForLatestJob(context: CausorynContext): Promise<NonNullable<ReturnType<CausorynContext["jobManager"]["latest"]>>> {
  const started = context.jobManager.latest();
  expect(started).toBeDefined();
  return context.jobManager.waitForJob(started!.jobId);
}

describe("warm start: background freshness check", { timeout: 120_000 }, () => {
  it("serves the existing snapshot immediately, then publishes the edited file without an explicit refresh", async () => {
    const { config, sourceFile } = setup();

    const cold = createCausorynContext(config, { deferAutoIndex: true, logger: quietLogger });
    let firstSnapshotId: string;
    try {
      cold.startDeferredIndex?.();
      const coldJob = await waitForLatestJob(cold);
      expect(coldJob.status).toBe("done");
      firstSnapshotId = coldJob.snapshotId as string;
    } finally {
      cold.close();
    }

    writeFileSync(
      sourceFile,
      "export function computeTotalWarmEdit(amount: number): number { return amount * 2; }\n",
      "utf8",
    );

    const logs: string[] = [];
    const warm = createCausorynContext(config, {
      deferAutoIndex: true,
      logger: (message) => logs.push(message),
    });
    try {
      // Before the deferred start: no job, the previous snapshot is served.
      expect(warm.jobManager.latest()).toBeUndefined();
      expect(warm.repository.getLatestPublished("ws_warm")?.snapshot.meta.id).toBe(firstSnapshotId);

      const t0 = performance.now();
      warm.startDeferredIndex?.();
      expect(performance.now() - t0).toBeLessThan(250);

      const queued = warm.jobManager.latest();
      expect(queued).toBeDefined();
      expect(queued?.mode).toBe("incremental");
      expect(["queued", "running"]).toContain(queued?.status);
      expect(warm.getActiveIndexJob?.()).not.toBeNull();
      // Tools are not blocked on a warm start.
      await warm.waitForInitialIndex?.({ timeoutMs: 1 });
      expect(logs.some((line) => /background freshness check started/.test(line))).toBe(true);

      const finished = await waitForLatestJob(warm);
      expect(finished.status).toBe("done");
      expect(finished.executionMode).toBe("worker");
      expect(finished.snapshotId).not.toBe(firstSnapshotId);
      const latest = warm.repository.getLatestPublished("ws_warm");
      expect(latest?.snapshot.meta.id).toBe(finished.snapshotId);
      expect(latest?.stale).toBe(false);
      expect(latest?.snapshot.nodes.some((node) => node.qualifiedName === "computeTotalWarmEdit")).toBe(
        true,
      );
      expect(warm.getActiveIndexJob?.()).toBeNull();
    } finally {
      warm.close();
    }

    // Unchanged tree: the freshness check ends `reused` (no new snapshot).
    const again = createCausorynContext(config, { deferAutoIndex: true, logger: quietLogger });
    try {
      const before = again.repository.getLatestPublished("ws_warm")?.snapshot.meta.id;
      again.startDeferredIndex?.();
      const check = await waitForLatestJob(again);
      expect(check.status).toBe("reused");
      expect((check as unknown as Record<string, unknown>)["outcome"]).toBe("unchanged");
      expect(check.snapshotId).toBe(before);
    } finally {
      again.close();
    }
  });
});
