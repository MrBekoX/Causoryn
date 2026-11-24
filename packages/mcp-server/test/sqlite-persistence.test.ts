import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryGraphRepository } from "@causoryn/graph";
import { nodeId } from "@causoryn/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CausorynConfigError,
  EnvelopeSchema,
  createCausorynContext,
  createCausorynMcpServer,
} from "../src/index.js";
import type { CausorynContext } from "../src/index.js";

/**
 * Kalıcı SQLite graph veri kökü (storage.dataDbPath), Agent GPS FTS5 ayağı
 * (symbolSearch), causoryn_refresh_index(mode="incremental") ve map_system L3
 * Test düğümü desteği testleri.
 *
 * Kanıt: TŞ v2.1 §9 (SQLite + symbol_fts, atomik publish, incremental hash
 * karşılaştırması), §10.2 (refresh_index mode=full|incremental), §15 (Agent
 * GPS FTS5 ayağı), §16 (map_system L3), §20 + ADR-008 (kaynak ağacı dışına
 * izinli data-root yazımı, fail-closed doğrulama).
 */

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(path.dirname(PKG_DIR));
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");
const FIXED_NOW = "2026-11-18T10:00:00.000Z";

interface ClientPair {
  readonly client: Client;
  readonly context: CausorynContext;
  readonly close: () => Promise<void>;
}

async function connectClient(context: CausorynContext): Promise<ClientPair> {
  const server = createCausorynMcpServer(context, {
    toolProfile: "full",
    outputSchemaProfile: "full",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "vitest-sqlite-persistence", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    context,
    close: async () => {
      await client.close();
      await server.close();
      context.close();
    },
  };
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

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-sqlite-persist-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("SQLite kalıcılık, Agent GPS FTS5, incremental refresh ve map_system L3 Test", { timeout: 60_000 }, () => {
  it("1) negatif güvenlik (fail-closed): storage.dataDbPath göreli yol / null byte / eksik üst dizin / allowRoots içi → CausorynConfigError", () => {
    const expectConfigIssue = (rawConfig: Record<string, unknown>, pattern: RegExp): void => {
      let caught: unknown;
      try {
        createCausorynContext(rawConfig);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CausorynConfigError);
      expect((caught as CausorynConfigError).message).toMatch(pattern);
    };

    // Göreli yol reddedilir.
    expectConfigIssue(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        autoIndex: false,
        storage: { dataDbPath: "goreli/graph.sqlite" },
      },
      /storage\.dataDbPath must be an absolute path/,
    );

    // Null byte reddedilir.
    expectConfigIssue(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        autoIndex: false,
        storage: { dataDbPath: `${path.join(tempRoot, "bad")}\0graph.sqlite` },
      },
      /storage\.dataDbPath must not contain a NUL byte/,
    );

    // Boş allowRoots reddedilir.
    expectConfigIssue(
      {
        workspaceId: "default",
        allowRoots: [],
        autoIndex: false,
        storage: { dataDbPath: path.join(tempRoot, "graph.sqlite") },
      },
      /allowRoots is empty/,
    );

    // Üst dizini mevcut olmayan yol reddedilir.
    expectConfigIssue(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        autoIndex: false,
        storage: { dataDbPath: path.join(tempRoot, "yok-dizin", "graph.sqlite") },
      },
      /parent directory does not exist/,
    );

    // Üst dizini normal dosya olan yol reddedilir.
    const regularFile = path.join(tempRoot, "duz-dosya.txt");
    writeFileSync(regularFile, "icerik", "utf8");
    expectConfigIssue(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        autoIndex: false,
        storage: { dataDbPath: path.join(regularFile, "graph.sqlite") },
      },
      /parent path is not a directory/,
    );

    // allowRoots[0] içindeki yol reddedilir (ADR-008 kaynak ağacı yazım yasağı).
    expectConfigIssue(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        autoIndex: false,
        storage: { dataDbPath: path.join(FIXTURE_ROOT, "graph.sqlite") },
      },
      /inside an authorized workspace root/,
    );

    // Çok köklü yapılandırmada allowRoots[1] içindeki yol da reddedilir.
    const secondRoot = path.join(tempRoot, "ikinci-workspace");
    mkdirSync(secondRoot, { recursive: true });
    expectConfigIssue(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT, secondRoot],
        autoIndex: false,
        storage: { dataDbPath: path.join(secondRoot, "graph.sqlite") },
      },
      /inside an authorized workspace root/,
    );
  });

  it("2) sunucu yeniden başlatma kalıcılığı: storage.dataDbPath yayımlanmış snapshot'ı yeniden indekslemeden korur; autoIndex=false açılışta sorgular hemen çalışır", async () => {
    const dataDbPath = path.join(tempRoot, "persisted-graph.sqlite");
    const logsStart1: string[] = [];

    const ctx1 = createCausorynContext(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        autoIndex: true,
        storage: { dataDbPath },
      },
      { clock: () => FIXED_NOW, logger: (msg) => logsStart1.push(msg) },
    );
    const pair1 = await connectClient(ctx1);
    let persistedSnapshotId = "";
    try {
      const summary1 = expectEnvelope(
        await callTool(pair1.client, "causoryn_workspace_summary", {}),
      );
      expect(summary1.status).toBe("ok");
      persistedSnapshotId = summary1.snapshotId as string;
      expect(persistedSnapshotId).toMatch(/^snapshot:/);
      expect(logsStart1.some((msg) => msg.startsWith("index ready:"))).toBe(true);
    } finally {
      await pair1.close();
    }

    // Sunucu #2 (autoIndex: true): kalıcı snapshot yeniden indekslenmeden yüklenir.
    const logsStart2: string[] = [];
    const ctx2 = createCausorynContext(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        autoIndex: true,
        storage: { dataDbPath },
      },
      {
        clock: () => "2026-11-18T11:00:00.000Z",
        logger: (msg) => logsStart2.push(msg),
      },
    );
    try {
      expect(
        logsStart2.some(
          (msg) =>
            msg.includes("persistent index loaded:") && msg.includes(persistedSnapshotId),
        ),
      ).toBe(true);
      expect(logsStart2.some((msg) => msg.startsWith("index ready:"))).toBe(false);
      expect(ctx2.repository.getLatestPublished("default")?.snapshot.meta.id).toBe(
        persistedSnapshotId,
      );
    } finally {
      ctx2.close();
    }

    // Sunucu #3 (autoIndex: false): soğuk açılışta bile SQLite'tan anında sorgulanır.
    const ctx3 = createCausorynContext(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        autoIndex: false,
        storage: { dataDbPath },
      },
      { clock: () => "2026-11-18T12:00:00.000Z", logger: () => {} },
    );
    const pair3 = await connectClient(ctx3);
    try {
      const summary3 = expectEnvelope(
        await callTool(pair3.client, "causoryn_workspace_summary", {}),
      );
      expect(summary3.status).toBe("ok");
      expect(summary3.snapshotId).toBe(persistedSnapshotId);

      const symbols3 = expectEnvelope(
        await callTool(pair3.client, "causoryn_find_symbols", {
          query: "OrdersService",
        }),
      );
      expect(symbols3.status).toBe("ok");
      expect(symbols3.snapshotId).toBe(persistedSnapshotId);
      const hits = (symbols3.data as Record<string, unknown>).hits as Array<
        Record<string, unknown>
      >;
      expect(hits.map((h) => h.qualifiedName)).toContain("OrdersService");
      expect(hits.map((h) => h.qualifiedName)).toContain("OrdersService.create");
    } finally {
      await pair3.close();
    }
  });

  it("3) çok-dilli snapshot korunumu: async refresh_index(mode=full) ile üretilen .ts + .py snapshot'ı autoIndex=true yeniden başlatmada senkron L0 ile ezilmez", async () => {
    const wsRoot = path.join(tempRoot, "polyglot-ws");
    mkdirSync(path.join(wsRoot, "src"), { recursive: true });
    writeFileSync(
      path.join(wsRoot, "src", "orders.ts"),
      "export class OrdersGateway { submitOrder(id: string): string { return id; } }\n",
      "utf8",
    );
    writeFileSync(
      path.join(wsRoot, "src", "billing.py"),
      "class BillingEngine:\n    def charge_invoice(self, amount: int) -> bool:\n        return amount > 0\n",
      "utf8",
    );
    const dataDbPath = path.join(tempRoot, "polyglot.sqlite");

    const ctx1 = createCausorynContext(
      {
        workspaceId: "poly",
        allowRoots: [wsRoot],
        autoIndex: true,
        storage: { dataDbPath },
      },
      { clock: () => FIXED_NOW, logger: () => {} },
    );
    const pair1 = await connectClient(ctx1);
    let richSnapshotId = "";
    let richFingerprint = "";
    try {
      const refresh = expectEnvelope(
        await callTool(pair1.client, "causoryn_refresh_index", { mode: "full" }),
      );
      expect(refresh.status).toBe("ok");
      const jobId = (refresh.data as Record<string, unknown>).jobId as string;
      const finished = await ctx1.jobManager.waitForJob(jobId);
      expect(finished.status).toBe("done");

      const latest = ctx1.repository.getLatestPublished("poly");
      expect(latest).toBeDefined();
      richSnapshotId = latest!.snapshot.meta.id;
      richFingerprint = latest!.snapshot.meta.analyzerFingerprint;
      expect(richFingerprint).not.toContain("sync-run-degraded");

      const pySymbols = expectEnvelope(
        await callTool(pair1.client, "causoryn_find_symbols", { query: "BillingEngine" }),
      );
      const hits = (pySymbols.data as Record<string, unknown>).hits as Array<
        Record<string, unknown>
      >;
      expect(hits.map((h) => h.qualifiedName)).toContain("src.billing.BillingEngine");
      expect(hits.map((h) => h.qualifiedName)).toContain(
        "src.billing.BillingEngine.charge_invoice",
      );
    } finally {
      await pair1.close();
    }

    // Sunucu #2 (autoIndex: true): zengin çok-dilli snapshot korunur, L0 ile ezilmez.
    const ctx2 = createCausorynContext(
      {
        workspaceId: "poly",
        allowRoots: [wsRoot],
        autoIndex: true,
        storage: { dataDbPath },
      },
      { clock: () => "2026-11-18T11:30:00.000Z", logger: () => {} },
    );
    const pair2 = await connectClient(ctx2);
    try {
      const reloaded = ctx2.repository.getLatestPublished("poly");
      expect(reloaded?.snapshot.meta.id).toBe(richSnapshotId);
      expect(reloaded?.snapshot.meta.analyzerFingerprint).toBe(richFingerprint);
      expect(reloaded?.snapshot.meta.analyzerFingerprint).not.toContain("sync-run-degraded");

      const pySymbols2 = expectEnvelope(
        await callTool(pair2.client, "causoryn_find_symbols", { query: "BillingEngine" }),
      );
      const hits2 = (pySymbols2.data as Record<string, unknown>).hits as Array<
        Record<string, unknown>
      >;
      expect(hits2.map((h) => h.qualifiedName)).toContain("src.billing.BillingEngine");
      expect(hits2.map((h) => h.qualifiedName)).toContain(
        "src.billing.BillingEngine.charge_invoice",
      );
    } finally {
      await pair2.close();
    }
  });

  it("4) ortak SQLite veri kökü: storage.dataDbPath ve wiki.dataDbPath aynı dosyayı paylaştığında wiki_build + workspace_summary + close sorunsuz çalışır", async () => {
    const sharedDbPath = path.join(tempRoot, "shared-store.sqlite");

    const ctx1 = createCausorynContext(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        autoIndex: true,
        storage: { dataDbPath: sharedDbPath },
        wiki: { dataDbPath: sharedDbPath },
      },
      { clock: () => FIXED_NOW, logger: () => {} },
    );
    const pair1 = await connectClient(ctx1);
    let graphSnapshotId = "";
    let wikiSnapshotId = "";
    try {
      const wikiBuilt = expectEnvelope(
        await callTool(pair1.client, "causoryn_wiki_build", { mode: "full" }),
      );
      expect(wikiBuilt.status).toBe("ok");
      const wikiData = wikiBuilt.data as Record<string, unknown>;
      wikiSnapshotId = wikiData.wikiSnapshotId as string;
      expect(wikiSnapshotId).toMatch(/^wiki:/);

      const summary = expectEnvelope(
        await callTool(pair1.client, "causoryn_workspace_summary", {}),
      );
      expect(summary.status).toBe("ok");
      graphSnapshotId = summary.snapshotId as string;
      expect(wikiData.graphSnapshotId).toBe(graphSnapshotId);

      const tree = expectEnvelope(
        await callTool(pair1.client, "causoryn_wiki_get_tree", {}),
      );
      expect(tree.status).toBe("ok");
    } finally {
      await pair1.close();
    }

    // İkinci açılışta hem graph hem wiki aynı SQLite dosyasından okunur.
    const ctx2 = createCausorynContext(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        autoIndex: false,
        storage: { dataDbPath: sharedDbPath },
        wiki: { dataDbPath: sharedDbPath },
      },
      { clock: () => "2026-11-18T13:00:00.000Z", logger: () => {} },
    );
    const pair2 = await connectClient(ctx2);
    try {
      const summary2 = expectEnvelope(
        await callTool(pair2.client, "causoryn_workspace_summary", {}),
      );
      expect(summary2.snapshotId).toBe(graphSnapshotId);

      const tree2 = expectEnvelope(
        await callTool(pair2.client, "causoryn_wiki_get_tree", {}),
      );
      expect((tree2.data as Record<string, unknown>).wikiSnapshotId).toBe(wikiSnapshotId);
    } finally {
      await pair2.close();
    }
  });

  it("5) Agent GPS FTS5 ayağı: storage.dataDbPath ile fts legsApplied içinde aktifleşir; varsayılan InMemoryGraphRepository ile degradedLegs içinde kalır", async () => {
    const sqlitePath = path.join(tempRoot, "agent-gps.sqlite");
    const sqliteCtx = createCausorynContext(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        autoIndex: true,
        storage: { dataDbPath: sqlitePath },
      },
      { clock: () => FIXED_NOW, logger: () => {} },
    );
    const sqlitePair = await connectClient(sqliteCtx);
    try {
      const gps = expectEnvelope(
        await callTool(sqlitePair.client, "causoryn_get_agent_context", {
          task: "OrdersService",
          tokenBudget: 2048,
        }),
      );
      expect(gps.status).toBe("ok");
      const data = gps.data as Record<string, unknown>;
      const legsApplied = data.legsApplied as string[];
      const degradedLegs = (data.degradedLegs as Array<Record<string, unknown>>).map(
        (d) => d.leg as string,
      );
      expect(legsApplied).toContain("fts");
      expect(degradedLegs).not.toContain("fts");

      const items = data.contextItems as Array<Record<string, unknown>>;
      expect(
        items.some((item) => {
          const legs = item.legs as string[];
          const scores = item.scores as Record<string, number>;
          return legs.includes("fts") && (scores.fts ?? 0) > 0;
        }),
      ).toBe(true);
    } finally {
      await sqlitePair.close();
    }

    const memCtx = createCausorynContext(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        autoIndex: true,
      },
      { clock: () => FIXED_NOW, logger: () => {} },
    );
    const memPair = await connectClient(memCtx);
    try {
      const gpsMem = expectEnvelope(
        await callTool(memPair.client, "causoryn_get_agent_context", {
          task: "OrdersService",
          tokenBudget: 2048,
        }),
      );
      const memData = gpsMem.data as Record<string, unknown>;
      const memLegsApplied = memData.legsApplied as string[];
      const memDegradedLegs = (memData.degradedLegs as Array<Record<string, unknown>>).map(
        (d) => d.leg as string,
      );
      expect(memLegsApplied).not.toContain("fts");
      expect(memDegradedLegs).toContain("fts");
    } finally {
      await memPair.close();
    }
  });

  it("6) causoryn_refresh_index(mode=incremental): değişimsiz no-op snapshotId korur; .ts değişimi ve SQLite yeniden başlatma sonrası revision.sequence çakışmasız artar; senkron L0 yükseltilir", async () => {
    const wsRoot = path.join(tempRoot, "inc-ws");
    mkdirSync(path.join(wsRoot, "src"), { recursive: true });
    const serviceFile = path.join(wsRoot, "src", "service.ts");
    writeFileSync(
      serviceFile,
      "export class OrderProcessor { processOne(): number { return 1; } }\n",
      "utf8",
    );
    const dataDbPath = path.join(tempRoot, "inc-graph.sqlite");

    // Oturum #1: ilk senkron index (sequence=1) → değişimsiz incremental no-op → .ts değişimi (sequence=2).
    const ctx1 = createCausorynContext(
      {
        workspaceId: "inc",
        allowRoots: [wsRoot],
        autoIndex: true,
        storage: { dataDbPath },
      },
      { clock: () => FIXED_NOW, logger: () => {} },
    );
    const pair1 = await connectClient(ctx1);
    let snapshotSeq1 = "";
    let snapshotSeq2 = "";
    try {
      const initialSummary = expectEnvelope(
        await callTool(pair1.client, "causoryn_workspace_summary", {}),
      );
      snapshotSeq1 = initialSummary.snapshotId as string;
      expect(
        ((initialSummary.data as Record<string, unknown>).revision as Record<string, unknown>)
          .sequence,
      ).toBe(1);

      // Değişiklik yokken incremental → no-op uyarısı, aynı snapshotId.
      const noOpRefresh = expectEnvelope(
        await callTool(pair1.client, "causoryn_refresh_index", { mode: "incremental" }),
      );
      const noOpJobId = (noOpRefresh.data as Record<string, unknown>).jobId as string;
      const noOpFinished = await ctx1.jobManager.waitForJob(noOpJobId);
      // No-op: nothing published -> `reused` / `unchanged`, never `done`.
      expect(noOpFinished.status).toBe("reused");
      expect(noOpFinished.outcome).toBe("unchanged");
      expect(noOpFinished.snapshotId).toBe(snapshotSeq1);
      expect(noOpFinished.warnings.some((w) => w.includes("incremental no-op"))).toBe(true);

      // .ts dosyası değiştiğinde incremental → yeni snapshotId ve sequence=2.
      writeFileSync(
        serviceFile,
        "export class OrderProcessor { processOne(): number { return 2; } processBatch(): number { return 10; } }\n",
        "utf8",
      );
      const rebuildRefresh = expectEnvelope(
        await callTool(pair1.client, "causoryn_refresh_index", { mode: "incremental" }),
      );
      const rebuildJobId = (rebuildRefresh.data as Record<string, unknown>).jobId as string;
      const rebuildFinished = await ctx1.jobManager.waitForJob(rebuildJobId);
      expect(rebuildFinished.status).toBe("done");
      snapshotSeq2 = rebuildFinished.snapshotId as string;
      expect(snapshotSeq2).not.toBe(snapshotSeq1);

      const summary2 = expectEnvelope(
        await callTool(pair1.client, "causoryn_workspace_summary", {}),
      );
      expect(summary2.snapshotId).toBe(snapshotSeq2);
      expect(
        ((summary2.data as Record<string, unknown>).revision as Record<string, unknown>)
          .sequence,
      ).toBe(2);
    } finally {
      await pair1.close();
    }

    // Oturum #2: aynı SQLite yeniden açılır → .ts tekrar değişir → sequence=3 (UNIQUE çakışması yok).
    const ctx2 = createCausorynContext(
      {
        workspaceId: "inc",
        allowRoots: [wsRoot],
        autoIndex: true,
        storage: { dataDbPath },
      },
      { clock: () => "2026-11-18T14:00:00.000Z", logger: () => {} },
    );
    const pair2 = await connectClient(ctx2);
    try {
      expect(ctx2.repository.getLatestPublished("inc")?.snapshot.meta.id).toBe(snapshotSeq2);

      writeFileSync(
        serviceFile,
        "export class OrderProcessor { processOne(): number { return 3; } finalizeOrder(): boolean { return true; } }\n",
        "utf8",
      );
      const restartRefresh = expectEnvelope(
        await callTool(pair2.client, "causoryn_refresh_index", { mode: "incremental" }),
      );
      const restartJobId = (restartRefresh.data as Record<string, unknown>).jobId as string;
      const restartFinished = await ctx2.jobManager.waitForJob(restartJobId);
      expect(restartFinished.status).toBe("done");
      const snapshotSeq3 = restartFinished.snapshotId as string;
      expect(snapshotSeq3).not.toBe(snapshotSeq2);

      const summary3 = expectEnvelope(
        await callTool(pair2.client, "causoryn_workspace_summary", {}),
      );
      expect(summary3.snapshotId).toBe(snapshotSeq3);
      expect(
        ((summary3.data as Record<string, unknown>).revision as Record<string, unknown>)
          .sequence,
      ).toBe(3);

      const found = expectEnvelope(
        await callTool(pair2.client, "causoryn_find_symbols", {
          query: "OrderProcessor.finalizeOrder",
        }),
      );
      const hits = (found.data as Record<string, unknown>).hits as Array<
        Record<string, unknown>
      >;
      expect(hits.map((h) => h.qualifiedName)).toContain("OrderProcessor.finalizeOrder");
    } finally {
      await pair2.close();
    }

    // Senkron L0 başlangıç snapshot'ı (.ts + .py) üzerinde değişimsiz incremental → tam analize yükseltir.
    const upgradeRoot = path.join(tempRoot, "inc-upgrade-ws");
    mkdirSync(path.join(upgradeRoot, "src"), { recursive: true });
    writeFileSync(
      path.join(upgradeRoot, "src", "api.ts"),
      "export function healthCheck(): string { return 'healthy'; }\n",
      "utf8",
    );
    writeFileSync(
      path.join(upgradeRoot, "src", "tasks.py"),
      "def sync_inventory(count: int) -> int:\n    return count + 1\n",
      "utf8",
    );
    const upgradeDb = path.join(tempRoot, "inc-upgrade.sqlite");
    const ctxUpgrade = createCausorynContext(
      {
        workspaceId: "inc-up",
        allowRoots: [upgradeRoot],
        autoIndex: true,
        storage: { dataDbPath: upgradeDb },
      },
      { clock: () => FIXED_NOW, logger: () => {} },
    );
    const pairUpgrade = await connectClient(ctxUpgrade);
    try {
      const before = ctxUpgrade.repository.getLatestPublished("inc-up")!;
      expect(before.snapshot.meta.analyzerFingerprint).toContain("sync-run-degraded");

      const upRefresh = expectEnvelope(
        await callTool(pairUpgrade.client, "causoryn_refresh_index", {
          mode: "incremental",
        }),
      );
      const upJobId = (upRefresh.data as Record<string, unknown>).jobId as string;
      const upFinished = await ctxUpgrade.jobManager.waitForJob(upJobId);
      expect(upFinished.status).toBe("done");
      expect(upFinished.snapshotId).not.toBe(before.snapshot.meta.id);

      const after = ctxUpgrade.repository.getLatestPublished("inc-up")!;
      expect(after.snapshot.meta.analyzerFingerprint).not.toContain("sync-run-degraded");
    } finally {
      await pairUpgrade.close();
    }
  });

  it("7) causoryn_map_system L3 düzeyi Test düğümlerini içerir", async () => {
    const repo = new InMemoryGraphRepository();
    repo.registerWorkspace({
      id: "default",
      rootPath: FIXTURE_ROOT,
      createdAt: FIXED_NOW,
    });
    const build = repo.beginBuild({
      workspaceId: "default",
      revision: { id: "working-tree", sequence: 1 },
      configHash: "cfg-l3-test",
      analyzerFingerprint: "fp2|ts-adapter@0.1.0",
      createdAt: FIXED_NOW,
    });
    repo.addNode(build.buildId, {
      id: nodeId({ workspaceId: "default", kind: "Workspace", qualifiedName: "default" }),
      kind: "Workspace",
      qualifiedName: "default",
      attributes: { rootPath: FIXTURE_ROOT },
    });
    repo.addNode(build.buildId, {
      id: nodeId({
        workspaceId: "default",
        kind: "Method",
        qualifiedName: "OrdersService.create",
        relativePath: "src/orders.ts",
      }),
      kind: "Method",
      qualifiedName: "OrdersService.create",
      language: "typescript",
      location: {
        relativePath: "src/orders.ts",
        startLine: 1,
        endLine: 5,
        sourceHash: "hash-orders",
      },
      attributes: { relativePath: "src/orders.ts" },
    });
    repo.addNode(build.buildId, {
      id: nodeId({
        workspaceId: "default",
        kind: "Test",
        qualifiedName: "orders.test.createsOrder",
        relativePath: "test/orders.test.ts",
      }),
      kind: "Test",
      qualifiedName: "orders.test.createsOrder",
      language: "typescript",
      location: {
        relativePath: "test/orders.test.ts",
        startLine: 1,
        endLine: 8,
        sourceHash: "hash-test",
      },
      attributes: { relativePath: "test/orders.test.ts" },
    });
    repo.publish(build.buildId, "ready", FIXED_NOW);

    const ctx = createCausorynContext(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        autoIndex: false,
      },
      { repository: repo, clock: () => FIXED_NOW, logger: () => {} },
    );
    const pair = await connectClient(ctx);
    try {
      const mapAll = expectEnvelope(
        await callTool(pair.client, "causoryn_map_system", { level: "L3" }),
      );
      expect(mapAll.status).toBe("ok");
      const nodes = ((mapAll.data as Record<string, unknown>).nodes ?? []) as Array<
        Record<string, unknown>
      >;
      expect(nodes.map((n) => n.qualifiedName)).toContain("OrdersService.create");
      expect(nodes.map((n) => n.qualifiedName)).toContain("orders.test.createsOrder");

      const mapTestsOnly = expectEnvelope(
        await callTool(pair.client, "causoryn_map_system", {
          level: "L3",
          filters: { kinds: ["Test"] },
        }),
      );
      const testNodes = ((mapTestsOnly.data as Record<string, unknown>).nodes ?? []) as Array<
        Record<string, unknown>
      >;
      expect(testNodes).toHaveLength(1);
      expect(testNodes[0]?.kind).toBe("Test");
      expect(testNodes[0]?.qualifiedName).toBe("orders.test.createsOrder");
    } finally {
      await pair.close();
    }
  });

  it("7) Security Analysis #2: sürücü kökü allowRoots sınırı, -wal yan dizin/symlink reddi ve get_agent_context NUL byte dayanıklılığı", async () => {
    const driveRoot = path.parse(tempRoot).root;
    const dbPathInSameDrive = path.join(tempRoot, "drive-boundary.sqlite");

    // (a) allowRoots bir dosya sistemi/sürücü kökü ("D:\\" veya "/") olduğunda bile
    //     altındaki dataDbPath fail-closed CausorynConfigError ile reddedilmelidir.
    expect(() =>
      createCausorynContext({
        workspaceId: "default",
        allowRoots: [driveRoot],
        autoIndex: false,
        storage: { dataDbPath: dbPathInSameDrive },
      }),
    ).toThrow(CausorynConfigError);

    // (b) SQLite yan dosyası (-wal) dizin ise fail-closed reddedilir.
    const walDirDbPath = path.join(tempRoot, "wal-dir-attack.sqlite");
    mkdirSync(`${walDirDbPath}-wal`, { recursive: true });
    expect(() =>
      createCausorynContext({
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        autoIndex: false,
        storage: { dataDbPath: walDirDbPath },
      }),
    ).toThrow(CausorynConfigError);

    // (c) Dosya düzeyi sarkan (dangling) symlink ve -wal symlink (Linux CI ve ayrıcalıklı Windows'ta koşar).
    const wsCopy = path.join(tempRoot, "ws-copy");
    mkdirSync(wsCopy, { recursive: true });
    const danglingDbLink = path.join(tempRoot, "dangling-link.sqlite");
    let fileSymlinkSupported = true;
    try {
      symlinkSync(path.join(wsCopy, "injected-nonexistent.sqlite"), danglingDbLink, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EPERM" || code === "EACCES") {
        fileSymlinkSupported = false;
      } else {
        throw error;
      }
    }
    if (fileSymlinkSupported) {
      expect(() =>
        createCausorynContext({
          workspaceId: "default",
          allowRoots: [wsCopy],
          autoIndex: false,
          storage: { dataDbPath: danglingDbLink },
        }),
      ).toThrow(CausorynConfigError);

      const walSymlinkDb = path.join(tempRoot, "wal-symlink.sqlite");
      const victimInWs = path.join(wsCopy, "victim.ts");
      writeFileSync(victimInWs, "export const x = 1;\n", "utf8");
      symlinkSync(victimInWs, `${walSymlinkDb}-wal`, "file");
      expect(() =>
        createCausorynContext({
          workspaceId: "default",
          allowRoots: [wsCopy],
          autoIndex: false,
          storage: { dataDbPath: walSymlinkDb },
        }),
      ).toThrow(CausorynConfigError);
    }

    // (d) causoryn_get_agent_context task alanında gömülü NUL byte (\u0000) INTERNAL_ERROR üretmez.
    const cleanDbPath = path.join(tempRoot, "fts-nul-safe.sqlite");
    const ctx = createCausorynContext(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        autoIndex: true,
        storage: { dataDbPath: cleanDbPath },
      },
      { clock: () => FIXED_NOW, logger: () => {} },
    );
    const pair = await connectClient(ctx);
    try {
      const res = expectEnvelope(
        await callTool(pair.client, "causoryn_get_agent_context", {
          task: "Orders\u0000Service",
          tokenBudget: 2048,
        }),
      );
      expect(res.status).toBe("ok");
    } finally {
      await pair.close();
    }
  });
});
