import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { sha256Hex, utf8Encode } from "@causoryn/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EnvelopeSchema,
  createCausorynContext,
  createCausorynMcpServer,
} from "../src/index.js";
import type { CausorynContext } from "../src/index.js";

/**
 * Cross-Package Pre-1.0 Uçtan Uca (E2E) Doğrulama Testleri:
 * Track 1 (sidecar/altyapı) + Track 2 (adapter-typescript Test/TESTS + graph
 * snapshot export) + Track 3 (storage-sqlite kalıcılığı + indexing + mcp-server
 * araç yüzeyi) entegrasyonunu gerçek MCP Client + InMemoryTransport üzerinden
 * doğrular.
 */

const FIXED_NOW = "2026-11-18T16:00:00.000Z";

interface ClientSession {
  readonly client: Client;
  readonly context: CausorynContext;
  readonly close: () => Promise<void>;
}

async function connectMcpClient(context: CausorynContext): Promise<ClientSession> {
  const server = createCausorynMcpServer(context, {
    toolProfile: "full",
    outputSchemaProfile: "full",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pre-1-0-e2e-verifier", version: "1.0.0" });
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
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-pre-1-0-e2e-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("Pre-1.0 Cross-Track E2E — Test Intelligence + Snapshot Git Compare", { timeout: 60_000 }, () => {
  it("E2E 1: gerçek TS workspace'te map_system(L3, Test) Test düğümlerini döner; derive_test_plan verified direct + call-site adaylarını kanıtlarıyla üretir ve 'geçti' içermez", async () => {
    const wsRoot = path.join(tempRoot, "ts-orders-ws");
    const dataDir = path.join(tempRoot, "sqlite-data");
    mkdirSync(path.join(wsRoot, "src"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const ordersServiceSource = [
      "export interface CreatedOrder {",
      "  readonly id: string;",
      "  readonly sku: string;",
      "}",
      "",
      "export class OrdersService {",
      "  create(sku: string): CreatedOrder {",
      "    return { id: `ord-${sku}`, sku };",
      "  }",
      "}",
      "",
    ].join("\n");

    const ordersServiceTestSource = [
      'import { OrdersService } from "./orders-service.js";',
      "",
      "declare global {",
      "  function describe(title: string, fn: () => void): void;",
      "  function it(title: string, fn: () => void): void;",
      "}",
      "",
      "export function createOrderViaHelper(service: OrdersService, sku: string): string {",
      "  return service.create(sku).id;",
      "}",
      "",
      'describe("OrdersService", () => {',
      '  it("creates order directly", () => {',
      "    const service = new OrdersService();",
      '    service.create("sku-direct");',
      "  });",
      "",
      '  it("creates order via helper", () => {',
      "    const service = new OrdersService();",
      '    createOrderViaHelper(service, "sku-helper");',
      "  });",
      "});",
      "",
    ].join("\n");

    writeFileSync(path.join(wsRoot, "src", "orders-service.ts"), ordersServiceSource, "utf8");
    writeFileSync(
      path.join(wsRoot, "src", "orders-service.test.ts"),
      ordersServiceTestSource,
      "utf8",
    );

    const context = createCausorynContext(
      {
        workspaceId: "orders-e2e",
        allowRoots: [wsRoot],
        autoIndex: true,
        storage: { dataDbPath: path.join(dataDir, "graph.sqlite") },
      },
      { clock: () => FIXED_NOW, logger: () => {} },
    );

    const session = await connectMcpClient(context);
    try {
      // 1) map_system({ level: "L3", filters: { kinds: ["Test"] } }) -> Test node'ları döner
      const mapResult = await callTool(session.client, "causoryn_map_system", {
        level: "L3",
        filters: { kinds: ["Test"] },
      });
      const mapEnvelope = expectEnvelope(mapResult);
      expect(mapEnvelope.status).toBe("ok");
      const mapData = mapEnvelope.data as Record<string, unknown>;
      const testNodes = mapData.nodes as Array<Record<string, unknown>>;
      expect(testNodes.length).toBe(2);
      for (const node of testNodes) {
        expect(node.kind).toBe("Test");
        expect(node.relativePath).toBe("src/orders-service.test.ts");
      }
      const testNames = testNodes.map((n) => n.qualifiedName as string);
      expect(testNames).toContain("OrdersService > creates order directly");
      expect(testNames).toContain("OrdersService > creates order via helper");

      // 2) derive_test_plan({ changeSet: { changedSymbols: ["OrdersService.create"] } })
      const planResult = await callTool(session.client, "causoryn_derive_test_plan", {
        changeSet: { changedSymbols: ["OrdersService.create"] },
      });
      const planEnvelope = expectEnvelope(planResult);
      expect(planEnvelope.status).toBe("ok");

      const serializedPlanText = JSON.stringify(planResult);
      expect(serializedPlanText).not.toContain("geçti");
      expect(serializedPlanText).not.toMatch(/\bpassed\b/i);

      const planData = planEnvelope.data as Record<string, unknown>;
      const summary = planData.summary as Record<string, number>;
      expect(summary.direct).toBeGreaterThanOrEqual(1);
      expect(summary.callSite).toBeGreaterThanOrEqual(1);
      expect(summary.missingCoverageCandidates).toBe(0);

      const candidates = planData.candidates as Array<Record<string, unknown>>;
      const directCandidate = candidates.find(
        (c) =>
          c.testQualifiedName === "OrdersService > creates order directly" &&
          c.changedQualifiedName === "OrdersService.create",
      );
      expect(directCandidate).toBeDefined();
      expect(directCandidate?.matchLevel).toBe("direct");
      expect(directCandidate?.resolution).toBe("verified");
      expect(directCandidate?.testKind).toBe("Test");
      const directEvidenceIds = directCandidate?.evidenceIds as string[];
      expect(directEvidenceIds.length).toBeGreaterThanOrEqual(1);

      const helperCandidate = candidates.find(
        (c) =>
          c.testQualifiedName === "OrdersService > creates order via helper" &&
          c.changedQualifiedName === "OrdersService.create",
      );
      expect(helperCandidate).toBeDefined();
      expect(helperCandidate?.matchLevel).toBe("call-site");
      expect(helperCandidate?.resolution).toBe("verified");
      expect(helperCandidate?.depth).toBe(2);
      expect((helperCandidate?.evidenceIds as string[]).length).toBeGreaterThanOrEqual(1);

      // 3) Kanıt doğrulaması: direct TESTS kenarının kanıtı diskteki gerçek test dosyasıyla eşleşir
      const evidenceEnvelope = expectEnvelope(
        await callTool(session.client, "causoryn_get_evidence", {
          id: directEvidenceIds[0] as string,
        }),
      );
      expect(evidenceEnvelope.status).toBe("ok");
      const evidenceRecords = (evidenceEnvelope.data as Record<string, unknown>)
        .evidence as Array<Record<string, unknown>>;
      expect(evidenceRecords.length).toBe(1);
      const span = evidenceRecords[0]?.span as Record<string, unknown>;
      expect(span.relativePath).toBe("src/orders-service.test.ts");
      expect(span.sourceHash).toBe(sha256Hex(utf8Encode(ordersServiceTestSource)));

      // 4) Agent GPS FTS5 ayağı (storage.dataDbPath üzerinde symbol_fts aktif)
      const gpsEnvelope = expectEnvelope(
        await callTool(session.client, "causoryn_get_agent_context", {
          task: "OrdersService",
          tokenBudget: 2048,
        }),
      );
      expect(gpsEnvelope.status).toBe("ok");
      const gpsData = gpsEnvelope.data as Record<string, unknown>;
      expect(gpsData.legsApplied as string[]).toContain("fts");
    } finally {
      await session.close();
    }

    // 5) Soğuk yeniden başlatma (autoIndex: false): Test düğümleri, TESTS kenarları ve FTS kalıcıdır
    const coldContext = createCausorynContext(
      {
        workspaceId: "orders-e2e",
        allowRoots: [wsRoot],
        autoIndex: false,
        storage: { dataDbPath: path.join(dataDir, "graph.sqlite") },
      },
      { clock: () => "2026-11-18T17:00:00.000Z", logger: () => {} },
    );
    const coldSession = await connectMcpClient(coldContext);
    try {
      const coldPlanEnvelope = expectEnvelope(
        await callTool(coldSession.client, "causoryn_derive_test_plan", {
          changeSet: { changedSymbols: ["OrdersService.create"] },
        }),
      );
      expect(coldPlanEnvelope.status).toBe("ok");
      const coldSummary = (coldPlanEnvelope.data as Record<string, unknown>).summary as Record<
        string,
        number
      >;
      expect(coldSummary.direct).toBeGreaterThanOrEqual(1);
      expect(coldSummary.callSite).toBeGreaterThanOrEqual(1);
    } finally {
      await coldSession.close();
    }
  });

  it("E2E 2: gerçek Git deposunda export_documentation(format=snapshot) v1 commit -> kaynak değişimi + refresh_index -> v2 working-tree -> compare_architecture(HEAD, working-tree) round-trip", async () => {
    const repoDir = path.join(tempRoot, "git-repo");
    const exportDir = path.join(tempRoot, "authorized-exports");
    const dataDir = path.join(tempRoot, "git-sqlite-data");
    mkdirSync(path.join(repoDir, "src"), { recursive: true });
    mkdirSync(path.join(repoDir, ".causoryn"), { recursive: true });
    mkdirSync(exportDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    execFileSync("git", ["init"], { cwd: repoDir });

    const v1Source = [
      "export class OrdersService {",
      "  create(sku: string): string {",
      "    return `ord:${sku}`;",
      "  }",
      "}",
      "",
    ].join("\n");
    const serviceFilePath = path.join(repoDir, "src", "orders-service.ts");
    writeFileSync(serviceFilePath, v1Source, "utf8");

    const context = createCausorynContext(
      {
        workspaceId: "git-roundtrip",
        allowRoots: [repoDir],
        output: { allowedOutputDirs: [exportDir] },
        storage: { dataDbPath: path.join(dataDir, "graph.sqlite") },
        autoIndex: true,
      },
      { clock: () => FIXED_NOW, logger: () => {} },
    );

    const session = await connectMcpClient(context);
    try {
      // 1) v1 snapshot'ını izinli outputDir'e export et
      const exportV1Envelope = expectEnvelope(
        await callTool(session.client, "causoryn_export_documentation", {
          format: "snapshot",
          outputDir: exportDir,
        }),
      );
      expect(exportV1Envelope.status).toBe("ok");
      const exportV1Data = exportV1Envelope.data as Record<string, unknown>;
      expect(exportV1Data.format).toBe("snapshot");
      expect(exportV1Data.atomic).toBe(true);
      const exportedPathV1 = exportV1Data.path as string;
      expect(path.basename(exportedPathV1)).toBe("architecture-snapshot.json");

      // 2) Export edilen architecture-snapshot.json dosyasını <repo>/.causoryn/ altına kopyala ve commit'le
      const repoSnapshotPath = path.join(repoDir, ".causoryn", "architecture-snapshot.json");
      copyFileSync(exportedPathV1, repoSnapshotPath);

      execFileSync(
        "git",
        ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "add", "."],
        { cwd: repoDir },
      );
      execFileSync(
        "git",
        [
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.com",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "chore: commit v1 architecture snapshot",
        ],
        { cwd: repoDir },
      );

      // 3) Kaynak kodu güncelle (yeni metot + HTTP route kaydı) + incremental refresh_index
      const v2Source = [
        "export interface RouterLike {",
        "  post(routePath: string, handler: (sku: string) => string): void;",
        "}",
        "",
        "export class OrdersService {",
        "  create(sku: string): string {",
        "    return `ord:${sku}`;",
        "  }",
        "",
        "  cancel(orderId: string): boolean {",
        "    return orderId.length > 0;",
        "  }",
        "}",
        "",
        "export function createOrderHandler(sku: string): string {",
        "  return new OrdersService().create(sku);",
        "}",
        "",
        "export function registerOrderRoutes(router: RouterLike): void {",
        '  router.post("/orders", createOrderHandler);',
        "}",
        "",
      ].join("\n");
      writeFileSync(serviceFilePath, v2Source, "utf8");

      const refreshEnvelope = expectEnvelope(
        await callTool(session.client, "causoryn_refresh_index", {
          mode: "incremental",
        }),
      );
      expect(refreshEnvelope.status).toBe("ok");
      const jobId = (refreshEnvelope.data as Record<string, unknown>).jobId as string;
      const finishedJob = await session.context.jobManager.waitForJob(jobId);
      expect(finishedJob.status).toBe("done");

      const statusEnvelope = expectEnvelope(
        await callTool(session.client, "causoryn_index_status", { jobId }),
      );
      expect(statusEnvelope.status).toBe("ok");

      // 4) v2 snapshot'ını export et ve working-tree .causoryn/architecture-snapshot.json içine kopyala
      const exportV2Envelope = expectEnvelope(
        await callTool(session.client, "causoryn_export_documentation", {
          format: "snapshot",
          outputDir: exportDir,
        }),
      );
      expect(exportV2Envelope.status).toBe("ok");
      const exportedPathV2 = (exportV2Envelope.data as Record<string, unknown>).path as string;
      expect(readFileSync(exportedPathV2, "utf8")).not.toBe(
        readFileSync(repoSnapshotPath, "utf8"),
      );
      copyFileSync(exportedPathV2, repoSnapshotPath);

      // 5) causoryn_compare_architecture({ baseRef: "HEAD", targetRef: "working-tree" })
      const compareEnvelope = expectEnvelope(
        await callTool(session.client, "causoryn_compare_architecture", {
          baseRef: "HEAD",
          targetRef: "working-tree",
        }),
      );
      expect(compareEnvelope.status).toBe("ok");
      const compareData = compareEnvelope.data as Record<string, unknown>;
      expect(compareData.baseRef).toBe("HEAD");
      expect(compareData.targetRef).toBe("working-tree");

      const diff = compareData.diff as Record<string, unknown>;
      const summary = diff.summary as Record<string, number>;
      // v1: Workspace, File(src/orders-service.ts), Class(OrdersService), Method(OrdersService.create)
      // v2: File sourceHash değişti (changed=1), 3 düğüm değişmedi (unchangedNodes=3),
      //     6 yeni düğüm eklendi: Interface(RouterLike), Method(RouterLike.post),
      //     Method(OrdersService.cancel), Function(createOrderHandler),
      //     Function(registerOrderRoutes), Endpoint(POST /orders) (added=6, apiSurfaceChanges=1)
      expect(summary.added).toBe(6);
      expect(summary.removed).toBe(0);
      expect(summary.changed).toBe(1);
      expect(summary.renamed).toBe(0);
      expect(summary.unchangedNodes).toBe(3);
      expect(summary.edgeAdded).toBeGreaterThan(0);
      expect(summary.edgeRemoved).toBe(0);
      expect(summary.edgeUnchanged).toBe(3);
      expect(summary.apiSurfaceChanges).toBe(1);

      const addedNodes = (diff.added as Array<Record<string, unknown>>).map(
        (entry) => (entry.node as Record<string, unknown>).qualifiedName as string,
      );
      expect(addedNodes).toContain("OrdersService.cancel");
      expect(addedNodes).toContain("POST /orders");
    } finally {
      await session.close();
    }
  });
});
