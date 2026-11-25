import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  createCausorynContext,
  createCausorynMcpServer,
  createDynamicCausorynContext,
  type CausorynContext,
} from "../src/index.js";

/**
 * roots/list_changed rebinding vs in-flight tool calls.
 *
 * A tool call is pinned to the context generation that was active when its
 * handler started: a rebind during the call neither switches the call to the
 * new workspace nor closes the old context (and its SQLite connection) under
 * it. The old generation is closed once its last in-flight call settles.
 * All tests are deterministic: they use controlled promises or a rebind
 * triggered synchronously inside the handler, never timing.
 */

interface StubContext {
  readonly context: CausorynContext;
  readonly closeCount: () => number;
}

function stubContext(workspaceId: string): StubContext {
  let closes = 0;
  const repository = { marker: `repo-${workspaceId}` };
  const context = {
    config: { workspaceId, allowRoots: [] },
    repository,
    logger: (): void => {},
    close: (): void => {
      closes += 1;
    },
  } as unknown as CausorynContext;
  return { context, closeCount: () => closes };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("DynamicCausorynContext — per-call pinning across rebind", () => {
  it("an in-flight call keeps its context after rebind; the old context closes only when the call settles", async () => {
    const a = stubContext("alpha");
    const b = stubContext("beta");
    const dynamic = createDynamicCausorynContext(a.context);
    const gate = deferred();

    const call = dynamic.runPinned(async () => {
      const before = dynamic.config.workspaceId;
      await gate.promise;
      return { before, after: dynamic.config.workspaceId, repository: dynamic.repository };
    });

    dynamic.rebind(b.context);
    // Outside the pinned call the new binding is visible immediately.
    expect(dynamic.config.workspaceId).toBe("beta");
    expect(dynamic.current).toBe(b.context);
    // The old context still serves the in-flight call: not closed yet.
    expect(a.closeCount()).toBe(0);

    gate.resolve();
    const result = await call;
    expect(result.before).toBe("alpha");
    expect(result.after).toBe("alpha");
    expect(result.repository).toBe(a.context.repository);
    expect(a.closeCount()).toBe(1);

    // A call that starts after the rebind runs against the new context.
    const later = await dynamic.runPinned(async () => dynamic.config.workspaceId);
    expect(later).toBe("beta");
    expect(b.closeCount()).toBe(0);
    dynamic.close();
    expect(b.closeCount()).toBe(1);
  });

  it("closes the old context exactly once after the LAST of several in-flight calls settles, also when a call rejects", async () => {
    const a = stubContext("alpha");
    const b = stubContext("beta");
    const dynamic = createDynamicCausorynContext(a.context);
    const first = deferred();
    const second = deferred();

    const callOne = dynamic.runPinned(async () => {
      await first.promise;
      return dynamic.config.workspaceId;
    });
    const callTwo = dynamic.runPinned(async () => {
      await second.promise;
      throw new Error(`failed in ${dynamic.config.workspaceId}`);
    });

    dynamic.rebind(b.context);
    first.resolve();
    expect(await callOne).toBe("alpha");
    expect(a.closeCount()).toBe(0);

    second.resolve();
    await expect(callTwo).rejects.toThrow("failed in alpha");
    expect(a.closeCount()).toBe(1);
    dynamic.close();
  });

  it("closes an idle intermediate generation immediately on a second rebind while the first one is still in flight", async () => {
    const a = stubContext("alpha");
    const b = stubContext("beta");
    const c = stubContext("gamma");
    const dynamic = createDynamicCausorynContext(a.context);
    const gate = deferred();
    const call = dynamic.runPinned(async () => {
      await gate.promise;
      return dynamic.config.workspaceId;
    });

    dynamic.rebind(b.context);
    dynamic.rebind(c.context);
    expect(b.closeCount()).toBe(1);
    expect(a.closeCount()).toBe(0);
    expect(dynamic.config.workspaceId).toBe("gamma");

    gate.resolve();
    expect(await call).toBe("alpha");
    expect(a.closeCount()).toBe(1);
    expect(c.closeCount()).toBe(0);
    dynamic.close();
    expect(c.closeCount()).toBe(1);
  });

  it("close() while a call is in flight defers closing the active context until the call settles", async () => {
    const a = stubContext("alpha");
    const dynamic = createDynamicCausorynContext(a.context);
    const gate = deferred();
    const call = dynamic.runPinned(async () => {
      await gate.promise;
      return dynamic.config.workspaceId;
    });
    dynamic.close();
    expect(a.closeCount()).toBe(0);
    gate.resolve();
    expect(await call).toBe("alpha");
    expect(a.closeCount()).toBe(1);
    // Idempotent: a second close does not close the context twice.
    dynamic.close();
    expect(a.closeCount()).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* MCP server wiring: a rebind during a real tool call                */
/* ------------------------------------------------------------------ */

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});

function makeWorkspace(prefix: string, source: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `causoryn-pin-${prefix}-`));
  tempRoots.push(root);
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "index.ts"), source, "utf8");
  return root;
}

describe("createCausorynMcpServer + DynamicCausorynContext — tool calls are pinned", { timeout: 60_000 }, () => {
  it("a rebind triggered in the middle of causoryn_find_symbols neither switches the call's workspace nor closes its context early", async () => {
    const alphaRoot = makeWorkspace("alpha", "export function computeAlphaScore(): number {\n  return 1;\n}\n");
    const betaRoot = makeWorkspace("beta", "export function settleBetaInvoice(): number {\n  return 2;\n}\n");
    const alphaBase = createCausorynContext(
      { workspaceId: "alpha", allowRoots: [alphaRoot], autoIndex: true, results: { maxSymbols: 100 } },
      { logger: () => {} },
    );
    let alphaCloses = 0;
    const alphaClose = alphaBase.close;
    const alpha: CausorynContext = {
      ...alphaBase,
      close: () => {
        alphaCloses += 1;
        alphaClose();
      },
    };
    // The new binding has a much lower symbol ceiling: if the in-flight call
    // switched contexts mid-way it would read beta's config and fail.
    const beta = createCausorynContext(
      { workspaceId: "beta", allowRoots: [betaRoot], autoIndex: true, results: { maxSymbols: 1 } },
      { logger: () => {} },
    );
    const dynamic = createDynamicCausorynContext(alpha);

    let rebound = false;
    let alphaClosesDuringCall = -1;
    const repository = alpha.repository;
    const originalGetLatest = repository.getLatestPublished.bind(repository);
    repository.getLatestPublished = (workspaceId: string) => {
      if (!rebound) {
        rebound = true;
        // roots/list_changed handled while this call is in flight.
        dynamic.rebind(beta);
        alphaClosesDuringCall = alphaCloses;
      }
      return originalGetLatest(workspaceId);
    };

    const server = createCausorynMcpServer(dynamic, { toolProfile: "core" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "pinning-test", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({
        name: "causoryn_find_symbols",
        arguments: { workspaceId: "alpha", query: "computeAlphaScore", limit: 50 },
      })) as CallToolResult;
      const envelope = result.structuredContent as {
        status?: string;
        workspaceId?: string;
        data?: { hits?: Array<{ qualifiedName?: string }> };
      };
      expect(rebound).toBe(true);
      expect(alphaClosesDuringCall).toBe(0);
      expect(envelope.status, JSON.stringify(envelope)).toBe("ok");
      expect(envelope.workspaceId).toBe("alpha");
      expect((envelope.data?.hits ?? []).some((hit) => hit.qualifiedName?.includes("computeAlphaScore"))).toBe(true);
      // The pinned call finished: now the retired generation is closed.
      expect(alphaCloses).toBe(1);
      // Subsequent calls run against the new binding.
      const next = (await client.callTool({
        name: "causoryn_find_symbols",
        arguments: { workspaceId: "beta", query: "settleBetaInvoice" },
      })) as CallToolResult;
      const nextEnvelope = next.structuredContent as { status?: string; workspaceId?: string };
      expect(nextEnvelope.status).toBe("ok");
      expect(nextEnvelope.workspaceId).toBe("beta");
    } finally {
      await client.close();
      await server.close();
      dynamic.close();
    }
  });
});
