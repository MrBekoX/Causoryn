import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * MCP server protokol düzeyi test üçlüleri (TŞ v2.1 §10, §25/6-7; sprint-1
 * görev 6-7). SDK 1.32.2 InMemoryTransport + Client ile:
 * - initialize + tools/list (tam olarak 5 araç; her biri inputSchema +
 *   outputSchema taşır),
 * - her araç için pozitif tools/call (fixture workspace),
 * - negatif: yetkisiz workspace → WORKSPACE_NOT_AUTHORIZED, geçersiz
 *   argüman → INVALID_ARGUMENT, INDEX_NOT_READY, LIMIT_EXCEEDED,
 *   AMBIGUOUS_SYMBOL, bilinmeyen kimlik → EVIDENCE_NOT_FOUND,
 * - partial: boş workspace coverage.
 *
 * Sprint-1 görev 7 ENTİGRASYON KANITI: fixture graph'ından
 * OrdersService.create → OrderRepository.save CALLS kenarı MCP araçlarıyla
 * (find_symbols → map_system) bulunur; causoryn_get_evidence çıktısındaki
 * span (relativePath + startLine/endLine + sourceHash) testin DISKTEN
 * okuduğu fixture dosyasının gerçek içeriğiyle birebir doğrulanır
 * (TŞ v2.1 §25/7, ADR-004 Evidence First).
 *
 * Envelope sözleşmesi (wiki/mcp-tools.md + TŞ §10.1): schemaVersion,
 * requestId, workspaceId, snapshotId, status, coverage, warnings, data,
 * nextCursor + sabit hata kodları. Testler salt okunurdur (ADR-008);
 * geçici fixture'lar yalnızca os.tmpdir() altında yaşar.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { sha256Hex, utf8Encode } from "@causoryn/domain";
import type { GraphRepository } from "@causoryn/graph";
import { describe, expect, it } from "vitest";

import {
  CAUSORYN_TOOL_ERROR_CODES,
  EnvelopeSchema,
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_NAMES,
  createCausorynContext,
  createCausorynMcpServer,
} from "../src/index.js";
import type { CausorynContext } from "../src/index.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");

interface ClientPair {
  readonly client: Client;
  readonly close: () => Promise<void>;
}

/** Context'i SDK InMemory transport üzerinden bir Client'a bağlar. */
async function connectClient(context: CausorynContext): Promise<ClientPair> {
  const server = createCausorynMcpServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "vitest-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function makeContext(
  configOverrides: Record<string, unknown> = {},
): CausorynContext {
  return createCausorynContext({
    workspaceId: "default",
    allowRoots: [FIXTURE_ROOT],
    results: { maxNodes: 250, maxSymbols: 100 },
    autoIndex: true,
    ...configOverrides,
  });
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  // SDK callTool dönüşü task-uzantılı birleşim tipidir; test yalnızca
  // klasik CallToolResult dalını kullanır.
  const result: unknown = await client.callTool({ name, arguments: args });
  return result as CallToolResult;
}

/** Yanıtı envelope şemasına zorlar; başarıda envelope'u döndürür. */
function expectEnvelope(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toBeDefined();
  const parsed = EnvelopeSchema.safeParse(result.structuredContent);
  expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  return (parsed as { success: true; data: Record<string, unknown> }).data;
}

describe("MCP server — protokol düzeyi", () => {
  it("initialize: serverInfo causoryn@<sürüm> beyan eder", async () => {
    const pair = await connectClient(makeContext());
    try {
      const info = pair.client.getServerVersion();
      expect(info?.name).toBe(SERVER_NAME);
      expect(info?.name).toBe("causoryn");
      expect(info?.version).toBe(SERVER_VERSION);
    } finally {
      await pair.close();
    }
  });

  it("tools/list: tam olarak 5 araç; her biri inputSchema + outputSchema taşır", async () => {
    const pair = await connectClient(makeContext());
    try {
      const { tools } = await pair.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      expect(TOOL_NAMES).toEqual([
        "causoryn_get_capabilities",
        "causoryn_workspace_summary",
        "causoryn_map_system",
        "causoryn_find_symbols",
        "causoryn_get_evidence",
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema, `${tool.name} inputSchema yok`).toBeDefined();
        expect(tool.outputSchema, `${tool.name} outputSchema yok`).toBeDefined();
        expect(tool.description, `${tool.name} açıklamasız`).toBeTruthy();
      }
    } finally {
      await pair.close();
    }
  });

  it("pozitif get_capabilities: adapter düzeyleri + config limitleri + protocol", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_get_capabilities");
      const envelope = expectEnvelope(result);
      expect(envelope.schemaVersion).toBe("2.0");
      expect(envelope.status).toBe("ok");
      expect(envelope.snapshotId).toBeNull();
      expect(Array.isArray(envelope.warnings)).toBe(true);
      expect(typeof envelope.requestId).toBe("string");
      expect((envelope.requestId as string).length).toBeGreaterThan(0);

      const data = envelope.data as Record<string, unknown>;
      const adapters = data.adapters as Array<Record<string, unknown>>;
      const ts = adapters.find((a) => a.language === "typescript");
      expect(ts).toBeDefined();
      expect(ts?.analyzerId).toBe("ts-adapter");
      expect(ts?.levels).toEqual({
        astParse: "L1",
        symbolResolution: "L2",
        frameworkLinkers: "express+nextjs",
      });
      const limits = data.limits as Record<string, unknown>;
      expect(limits.maxNodes).toBe(250);
      expect(limits.maxSymbols).toBe(100);
      expect(data.tools).toEqual([...TOOL_NAMES]);
      const protocol = data.protocol as Record<string, unknown>;
      expect(typeof protocol.revision).toBe("string");
    } finally {
      await pair.close();
    }
  });

  it("pozitif workspace_summary: graph'tan türetilmiş proje/framework/coverage özeti", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_workspace_summary");
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("ok");
      expect(envelope.workspaceId).toBe("default");
      const snapshotId = envelope.snapshotId as string;
      expect(typeof snapshotId).toBe("string");
      expect(snapshotId.startsWith("snapshot:")).toBe(true);

      const coverage = envelope.coverage as Record<string, unknown>;
      expect((coverage.resolvedEdges as number)).toBeGreaterThan(0);
      expect(coverage.tier).toBe("L2");

      const data = envelope.data as Record<string, unknown>;
      expect((data.nodeCount as number)).toBeGreaterThan(0);
      expect((data.edgeCount as number)).toBeGreaterThan(0);
      const edgesByKind = data.edgesByKind as Record<string, number>;
      expect((edgesByKind.CALLS ?? 0)).toBeGreaterThan(0);
      expect((edgesByKind.CONTAINS ?? 0)).toBeGreaterThan(0);
      const entrypoints = data.entrypoints as string[];
      expect(entrypoints).toContain("POST /orders");
      // fixture-ts-orders framework-bağımsız Router taşır: framework etiketi
      // yoktur (denetim bulgusu 1 regresyon pimi — alan mevcut, boş).
      expect(data.frameworks).toEqual([]);
      const languages = data.languages as Array<Record<string, unknown>>;
      const tsLanguage = languages.find((l) => l.language === "typescript");
      expect((tsLanguage?.files as number)).toBeGreaterThan(0);
    } finally {
      await pair.close();
    }
  });

  it("pozitif workspace_summary (framework): express fixture'ından frameworks türetilir", async () => {
    // Denetim bulgusu 1: map_system/summary frameworks alanı hard-coded []
    // idi; snapshot'taki framework öznitelikli Endpoint node'larından
    // türetilmeli. Express fixture'ında diskte tip shim'i olmadığından
    // TS7016 tanısı state'i partial yapar; framework kenarları buna rağmen
    // üretilir (adapter davranışı — bulgu 2 sonrası receiver kapsamlı).
    const expressRoot = path.join(REPO_ROOT, "examples", "fixture-ts-express");
    const pair = await connectClient(
      makeContext({ allowRoots: [expressRoot], workspaceId: "express-fx" }),
    );
    try {
      const result = await callTool(pair.client, "causoryn_workspace_summary");
      const envelope = expectEnvelope(result);
      expect(envelope.workspaceId).toBe("express-fx");

      const data = envelope.data as Record<string, unknown>;
      expect(data.frameworks).toEqual(["express"]);
      const entrypoints = data.entrypoints as string[];
      expect(entrypoints).toContain("GET /products");
      expect(entrypoints).toContain("GET /admin/stats");
    } finally {
      await pair.close();
    }
  });

  it("pozitif map_system: level/maxNodes/cursor ile deterministik sayfalama", async () => {
    const pair = await connectClient(makeContext());
    try {
      const first = await callTool(pair.client, "causoryn_map_system", {
        level: "L1",
        maxNodes: 2,
      });
      const firstEnvelope = expectEnvelope(first);
      const firstData = firstEnvelope.data as Record<string, unknown>;
      const pageOneNodes = firstData.nodes as Array<Record<string, unknown>>;
      expect(pageOneNodes.length).toBe(2);
      expect(firstData.totalNodes).toBeGreaterThanOrEqual(5);
      expect(firstData.truncated).toBe(true);
      const cursorOne = firstEnvelope.nextCursor as string | null;
      expect(typeof cursorOne).toBe("string");
      expect(cursorOne?.length).toBeGreaterThan(0);
      for (const node of pageOneNodes) {
        expect(["Module", "Package", "File", "Namespace", "Config"]).toContain(node.kind);
      }

      const second = await callTool(pair.client, "causoryn_map_system", {
        level: "L1",
        maxNodes: 2,
        cursor: cursorOne as string,
      });
      const secondEnvelope = expectEnvelope(second);
      const secondData = secondEnvelope.data as Record<string, unknown>;
      const pageTwoNodes = secondData.nodes as Array<Record<string, unknown>>;
      expect(pageTwoNodes.length).toBe(2);
      const seen = new Set(pageOneNodes.map((n) => n.id));
      for (const node of pageTwoNodes) {
        expect(seen.has(node.id), "sayfalar arasında node tekrarı").toBe(false);
        seen.add(node.id as string);
      }

      // Determinizm: aynı istek → aynı data (TŞ §8 invariant vi).
      const repeat = await callTool(pair.client, "causoryn_map_system", {
        level: "L1",
        maxNodes: 2,
      });
      const repeatEnvelope = expectEnvelope(repeat);
      expect(repeatEnvelope.data).toEqual(firstEnvelope.data);
      expect(repeatEnvelope.nextCursor).toBe(cursorOne);

      // Tüm sayfalar tüketildiğinde nextCursor null'a iner.
      let cursor: string | null = cursorOne;
      let guard = 0;
      let lastData: Record<string, unknown> = secondData;
      while (cursor !== null && guard < 50) {
        const page = await callTool(pair.client, "causoryn_map_system", {
          level: "L1",
          maxNodes: 2,
          cursor,
        });
        const envelope = expectEnvelope(page);
        lastData = envelope.data as Record<string, unknown>;
        cursor = envelope.nextCursor as string | null;
        guard += 1;
      }
      expect(cursor).toBeNull();
      const collected = lastData.totalNodes as number;
      expect(collected).toBeGreaterThanOrEqual(5);
      // L3 haritası sembol düzeyini taşır.
      const l3 = await callTool(pair.client, "causoryn_map_system", { level: "L3" });
      const l3Envelope = expectEnvelope(l3);
      const l3Data = l3Envelope.data as Record<string, unknown>;
      const l3Names = (l3Data.nodes as Array<Record<string, unknown>>).map(
        (n) => n.qualifiedName as string,
      );
      expect(l3Names).toContain("OrdersService.create");
      expect(l3Names).toContain("POST /orders");
    } finally {
      await pair.close();
    }
  });

  it("pozitif find_symbols: query/kind/limit; deterministik sıralama", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_find_symbols", {
        query: "order",
        kind: "Class",
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      const hits = data.hits as Array<Record<string, unknown>>;
      expect(hits.length).toBeGreaterThanOrEqual(2);
      for (const hit of hits) {
        expect(hit.kind).toBe("Class");
        expect(String(hit.qualifiedName).toLowerCase()).toContain("order");
        expect(String(hit.symbolId).startsWith("node:")).toBe(true);
      }
      const names = hits.map((h) => h.qualifiedName as string);
      expect(names).toContain("OrdersService");
      expect(names).toContain("OrderRepository");
      // Deterministik sıralama: qualifiedName artan.
      const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      expect(names).toEqual(sorted);

      const limited = await callTool(pair.client, "causoryn_find_symbols", {
        query: "o",
        limit: 3,
      });
      const limitedEnvelope = expectEnvelope(limited);
      const limitedData = limitedEnvelope.data as Record<string, unknown>;
      expect((limitedData.hits as unknown[]).length).toBeLessThanOrEqual(3);
      expect((limitedData.totalMatches as number)).toBeGreaterThan(3);
    } finally {
      await pair.close();
    }
  });

  /** find_symbols ile tek isimli Method node'unun kimliğini çeker. */
  async function symbolIdOf(client: Client, query: string): Promise<string> {
    const result = await callTool(client, "causoryn_find_symbols", {
      query,
      kind: "Method",
    });
    const envelope = expectEnvelope(result);
    const hits = (envelope.data as Record<string, unknown>).hits as Array<
      Record<string, unknown>
    >;
    expect(hits.length, `${query} için tek isabet beklenirdi`).toBe(1);
    return hits[0]?.symbolId as string;
  }

  it(
    "pozitif get_evidence: OrdersService.create → OrderRepository.save CALLS kenarı kanıtı " +
      "fixture dosyasının GERÇEK içeriğiyle doğrulanır (sprint-1 görev 7 entegrasyon kanıtı)",
    async () => {
      const pair = await connectClient(makeContext());
      try {
        // 1) Zincir uçları MCP üzerinden bulunur (TŞ v2.1 §25/4 zinciri).
        const createId = await symbolIdOf(pair.client, "OrdersService.create");
        const saveId = await symbolIdOf(pair.client, "OrderRepository.save");
        expect(createId).not.toBe(saveId);

        // 2) CALLS kenarı map_system (L3) üzerinden bulunur.
        const map = await callTool(pair.client, "causoryn_map_system", {
          level: "L3",
          maxNodes: 250,
        });
        const mapEnvelope = expectEnvelope(map);
        const mapEdges = (mapEnvelope.data as Record<string, unknown>)
          .edges as Array<Record<string, unknown>>;
        const callsEdge = mapEdges.find(
          (edge) => edge.kind === "CALLS" && edge.from === createId && edge.to === saveId,
        );
        expect(
          callsEdge,
          "OrdersService.create → OrderRepository.save CALLS kenarı L3 haritada yok",
        ).toBeDefined();
        expect(callsEdge?.resolution).toBe("verified");
        const edgeId = callsEdge?.id as string;

        // 3) get_evidence: kenarın kanıt dizisi döner.
        const result = await callTool(pair.client, "causoryn_get_evidence", { id: edgeId });
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("ok");
        expect(typeof envelope.snapshotId).toBe("string");
        const data = envelope.data as Record<string, unknown>;
        expect(data.id).toBe(edgeId);
        expect(data.idKind).toBe("edge");
        const edgeInfo = data.edge as Record<string, unknown>;
        expect(edgeInfo.id).toBe(edgeId);
        expect(edgeInfo.from).toBe(createId);
        expect(edgeInfo.to).toBe(saveId);
        expect(edgeInfo.kind).toBe("CALLS");
        expect(edgeInfo.resolution).toBe("verified");

        const evidence = data.evidence as Array<Record<string, unknown>>;
        expect(evidence.length).toBeGreaterThanOrEqual(1);
        const semantic = evidence.find((entry) => entry.kind === "semantic-symbol");
        expect(semantic, "semantic-symbol kandı yok").toBeDefined();
        expect(semantic?.analyzerId).toBe("ts-adapter");
        expect(typeof semantic?.analyzerVersion).toBe("string");
        expect((semantic?.rationale as string).length).toBeGreaterThan(0);
        expect(semantic?.rationale as string).toContain("CALLS");
        expect(semantic?.id as string).toMatch(/^evidence:[0-9a-f]{64}$/);

        // 4) ENTİGRASYON KANITI: span, fixture dosyasının GERÇEK içeriğiyle
        //    doğrulanır — test dosyayı DISKTEN okur (TŞ v2.1 §25/7).
        const span = semantic?.span as Record<string, unknown>;
        expect(span.relativePath).toBe("src/services/orders-service.ts");
        const absolutePath = path.join(FIXTURE_ROOT, "src", "services", "orders-service.ts");
        const content = readFileSync(absolutePath, "utf8");
        // sourceHash dosya içeriğinin SHA-256 karmasıyla birebir eşleşir.
        expect(span.sourceHash).toBe(sha256Hex(utf8Encode(content)));
        const lines = content.split("\n");
        const startLine = span.startLine as number;
        const endLine = span.endLine as number;
        expect(startLine).toBeGreaterThanOrEqual(1);
        expect(endLine).toBeGreaterThanOrEqual(startLine);
        expect(endLine).toBeLessThanOrEqual(lines.length);
        const covered = lines.slice(startLine - 1, endLine).join("\n");
        expect(
          covered.includes("this.repository.save("),
          `span satırları (${String(startLine)}-${String(endLine)}) çağrıyı içermeli: ${JSON.stringify(covered)}`,
        ).toBe(true);
      } finally {
        await pair.close();
      }
    },
  );

  it("pozitif get_evidence: node kimliği komşu kenar kanıtlarını deterministik döndürür", async () => {
    const pair = await connectClient(makeContext());
    try {
      const createId = await symbolIdOf(pair.client, "OrdersService.create");

      const byNode = await callTool(pair.client, "causoryn_get_evidence", { id: createId });
      const envelope = expectEnvelope(byNode);
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      expect(data.id).toBe(createId);
      expect(data.idKind).toBe("node");
      const nodeInfo = data.node as Record<string, unknown>;
      expect(nodeInfo.id).toBe(createId);
      expect(nodeInfo.kind).toBe("Method");
      expect(nodeInfo.qualifiedName).toBe("OrdersService.create");
      expect(data.edge).toBeUndefined();

      const evidence = data.evidence as Array<Record<string, unknown>>;
      expect(evidence.length).toBeGreaterThanOrEqual(1);
      // Node kanıtı komşu kenarlardan gelir: CONTAINS + CALLS kanıtları
      // görünmeli (TŞ §8'de kanıt bağı kenar üzerindedir; düğüm kanıtı
      // Faz A'da komşu kenar kanıtlarıyla tanımlanır).
      const rationales = evidence.map((entry) => entry.rationale as string);
      expect(rationales.some((text) => text.includes("CALLS"))).toBe(true);
      expect(rationales.some((text) => text.includes("CONTAINS"))).toBe(true);
      // Kanıt ID'leri tekrarsız ve deterministik düzende.
      const ids = evidence.map((entry) => entry.id as string);
      expect(new Set(ids).size).toBe(ids.length);
      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);

      // Determinizm: aynı istek → aynı data (TŞ §8 invariant vi).
      const repeat = await callTool(pair.client, "causoryn_get_evidence", { id: createId });
      expect(expectEnvelope(repeat).data).toEqual(data);
    } finally {
      await pair.close();
    }
  });

  it("negatif get_evidence: bilinmeyen kimlik → EVIDENCE_NOT_FOUND; yetkisiz workspace reddi", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_get_evidence", {
        id: "node:0000000000000000000000000000000000000000000000000000000000000000",
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("error");
      expect(envelope.snapshotId).toBeNull();
      const error = envelope.error as Record<string, unknown>;
      expect(error.code).toBe("EVIDENCE_NOT_FOUND");
      expect(error.retryable).toBe(false);
      expect((error.userAction as string).length).toBeGreaterThan(0);

      // Kenar/evidence biçimli bilinmeyen kimlikler de aynı kodu verir.
      const asEdge = await callTool(pair.client, "causoryn_get_evidence", {
        id: "edge:yok",
      });
      expect((expectEnvelope(asEdge).error as Record<string, unknown>).code).toBe(
        "EVIDENCE_NOT_FOUND",
      );

      // Workspace yetkisi kimlik aramasından ÖNCE denetlenir.
      const authz = await callTool(pair.client, "causoryn_get_evidence", {
        workspaceId: "baska-workspace",
        id: "node:abc",
      });
      expect((expectEnvelope(authz).error as Record<string, unknown>).code).toBe(
        "WORKSPACE_NOT_AUTHORIZED",
      );
    } finally {
      await pair.close();
    }
  });

  it("negatif: yetkisiz workspace → WORKSPACE_NOT_AUTHORIZED", async () => {
    const pair = await connectClient(
      makeContext({ allowRoots: [] }),
    );
    try {
      const result = await callTool(pair.client, "causoryn_workspace_summary");
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("error");
      const error = envelope.error as Record<string, unknown>;
      expect(error.code).toBe("WORKSPACE_NOT_AUTHORIZED");
      expect(envelope.snapshotId).toBeNull();

      const caps = await callTool(pair.client, "causoryn_get_capabilities", {
        workspace: "D:\\baska\\yer",
      });
      const capsEnvelope = expectEnvelope(caps);
      expect((capsEnvelope.error as Record<string, unknown>).code).toBe(
        "WORKSPACE_NOT_AUTHORIZED",
      );
    } finally {
      await pair.close();
    }
  });

  it("negatif: yayınlanmış snapshot yok → INDEX_NOT_READY", async () => {
    const pair = await connectClient(makeContext({ autoIndex: false }));
    try {
      // Her araç şemaya uygun minimal argümanla çağrılır: snapshot yokluğu
      // INDEX_NOT_READY üretir; şema reddi (protokol isError) değil.
      const minimalArgs: Record<string, Record<string, unknown>> = {
        causoryn_workspace_summary: {},
        causoryn_map_system: {},
        causoryn_find_symbols: { query: "x" },
        causoryn_get_evidence: { id: "node:olmayan" },
      };
      for (const [name, args] of Object.entries(minimalArgs)) {
        const result = await callTool(pair.client, name, args);
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("error");
        expect((envelope.error as Record<string, unknown>).code).toBe("INDEX_NOT_READY");
      }
    } finally {
      await pair.close();
    }
  });

  it("negatif: geçersiz argüman → INVALID_ARGUMENT envelope", async () => {
    const pair = await connectClient(makeContext());
    try {
      const blank = await callTool(pair.client, "causoryn_find_symbols", { query: "   " });
      const blankEnvelope = expectEnvelope(blank);
      expect((blankEnvelope.error as Record<string, unknown>).code).toBe("INVALID_ARGUMENT");

      const badCursor = await callTool(pair.client, "causoryn_map_system", {
        level: "L1",
        cursor: "kesinlikle-gecerli-degil",
      });
      const badCursorEnvelope = expectEnvelope(badCursor);
      expect((badCursorEnvelope.error as Record<string, unknown>).code).toBe(
        "INVALID_ARGUMENT",
      );
    } finally {
      await pair.close();
    }
  });

  it("negatif: tavan üstü maxNodes → LIMIT_EXCEEDED", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_map_system", {
        level: "L1",
        maxNodes: 251,
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("error");
      expect((envelope.error as Record<string, unknown>).code).toBe("LIMIT_EXCEEDED");
    } finally {
      await pair.close();
    }
  });

  it("negatif: aynı qualifiedName birden fazla node → AMBIGUOUS_SYMBOL + adaylar", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "causoryn-ambiguous-"));
    try {
      mkdirSync(path.join(root, "src", "a"), { recursive: true });
      mkdirSync(path.join(root, "src", "b"), { recursive: true });
      const repoSource =
        "export class Repo {\n  save(): number {\n    return 1;\n  }\n}\n";
      writeFileSync(path.join(root, "src", "a", "repo.ts"), repoSource, "utf8");
      writeFileSync(path.join(root, "src", "b", "repo.ts"), repoSource, "utf8");
      writeFileSync(
        path.join(root, "src", "main.ts"),
        [
          "import { Repo as RepoA } from \"./a/repo.js\";",
          "import { Repo as RepoB } from \"./b/repo.js\";",
          "const a = new RepoA();",
          "const b = new RepoB();",
          "console.log(a.save(), b.save());",
          "",
        ].join("\n"),
        "utf8",
      );
      const pair = await connectClient(
        makeContext({ workspaceId: "amb", allowRoots: [root] }),
      );
      try {
        const result = await callTool(pair.client, "causoryn_find_symbols", {
          workspaceId: "amb",
          query: "Repo.save",
        });
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("error");
        expect((envelope.error as Record<string, unknown>).code).toBe("AMBIGUOUS_SYMBOL");
        const data = envelope.data as Record<string, unknown>;
        const candidates = data.candidates as Array<Record<string, unknown>>;
        expect(candidates.length).toBe(2);
        for (const candidate of candidates) {
          expect(candidate.qualifiedName).toBe("Repo.save");
          expect(typeof candidate.relativePath).toBe("string");
        }
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("negatif: protokol düzeyinde geçersiz girdi SDK tarafından isError ile reddedilir", async () => {
    const pair = await connectClient(makeContext());
    try {
      const invalid = await callTool(pair.client, "causoryn_find_symbols", { query: "" });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toBeUndefined();

      const unknown = await callTool(pair.client, "causoryn_bilinmeyen_arac");
      expect(unknown.isError).toBe(true);
    } finally {
      await pair.close();
    }
  });

  it("partial: boş workspace → snapshot'a bağlı üç araçta da status partial + sıfır coverage", async () => {
    const emptyRoot = mkdtempSync(path.join(tmpdir(), "causoryn-empty-mcp-"));
    try {
      const pair = await connectClient(
        makeContext({ workspaceId: "empty", allowRoots: [emptyRoot] }),
      );
      try {
        // Sprint-1 kuralı: her araç için pozitif + negatif + partial üçlüsü.
        // get_capabilities snapshot'a bağlı olmadığından partial üçlüsü
        // yalnızca bu üç araç için anlamlıdır.
        const summary = await callTool(pair.client, "causoryn_workspace_summary");
        const summaryEnvelope = expectEnvelope(summary);
        expect(summaryEnvelope.status).toBe("partial");
        expect((summaryEnvelope.warnings as unknown[]).length).toBeGreaterThanOrEqual(1);
        const summaryCoverage = summaryEnvelope.coverage as Record<string, unknown>;
        expect(summaryCoverage.resolvedEdges).toBe(0);
        expect(summaryCoverage.unresolvedEdges).toBe(0);
        const summaryData = summaryEnvelope.data as Record<string, unknown>;
        expect(summaryData.nodeCount).toBe(1); // yalnızca Workspace node'u
        expect(summaryData.edgeCount).toBe(0);

        const map = await callTool(pair.client, "causoryn_map_system", { level: "L0" });
        const mapEnvelope = expectEnvelope(map);
        expect(mapEnvelope.status).toBe("partial");
        expect((mapEnvelope.warnings as unknown[]).length).toBeGreaterThanOrEqual(1);
        const mapCoverage = mapEnvelope.coverage as Record<string, unknown>;
        expect(mapCoverage.totalEdges).toBe(0);
        const mapData = mapEnvelope.data as Record<string, unknown>;
        expect(mapData.totalNodes).toBe(1);
        expect((mapData.nodes as unknown[]).length).toBe(1);
        expect(mapEnvelope.nextCursor).toBeNull();

        const find = await callTool(pair.client, "causoryn_find_symbols", { query: "x" });
        const findEnvelope = expectEnvelope(find);
        expect(findEnvelope.status).toBe("partial");
        expect((findEnvelope.warnings as unknown[]).length).toBeGreaterThanOrEqual(1);
        const findData = findEnvelope.data as Record<string, unknown>;
        expect(findData.totalMatches).toBe(0);
        expect((findData.hits as unknown[]).length).toBe(0);

        // partial get_evidence: Workspace node'u mevcuttur (kimlik bulunur)
        // ama kenarsızdır → kanıt dizisi BOŞ döner; EVIDENCE_NOT_FOUND değildir.
        const l0 = await callTool(pair.client, "causoryn_map_system", { level: "L0" });
        const l0Data = expectEnvelope(l0).data as Record<string, unknown>;
        const l0Nodes = l0Data.nodes as Array<Record<string, unknown>>;
        expect(l0Nodes.length).toBe(1);
        const workspaceId0 = l0Nodes[0]?.id as string;
        const evidence = await callTool(pair.client, "causoryn_get_evidence", {
          workspaceId: "empty",
          id: workspaceId0,
        });
        const evidenceEnvelope = expectEnvelope(evidence);
        expect(evidenceEnvelope.status).toBe("partial");
        const evidenceData = evidenceEnvelope.data as Record<string, unknown>;
        expect(evidenceData.idKind).toBe("node");
        expect((evidenceData.evidence as unknown[]).length).toBe(0);
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("hata envelope'u retryable + userAction taşır (TŞ §10.1)", async () => {
    const pair = await connectClient(makeContext({ autoIndex: false }));
    try {
      const result = await callTool(pair.client, "causoryn_workspace_summary");
      const envelope = expectEnvelope(result);
      const error = envelope.error as Record<string, unknown>;
      expect(error.code).toBe("INDEX_NOT_READY");
      // TŞ §10.1: "Tekrar denenebilirlik ve kullanici aksiyonu belirtilir."
      expect(typeof error.retryable).toBe("boolean");
      expect(typeof error.userAction).toBe("string");
      expect((error.userAction as string).length).toBeGreaterThan(0);
    } finally {
      await pair.close();
    }
  });

  it("negatif: geçersiz config reddedilir (göreli allowRoot)", () => {
    let caught: unknown;
    try {
      createCausorynContext({ workspaceId: "x", allowRoots: ["goreli-yol"] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it("hata kodu seti sabittir (TŞ §10.1 + proje uzantıları INVALID_ARGUMENT, EVIDENCE_NOT_FOUND)", () => {
    // TŞ §10.1 listesinde INVALID_ARGUMENT ve EVIDENCE_NOT_FOUND YOKTUR;
    // görev sözleşmeleri geçersiz girdi ve bulunamayan kimlik için sabit
    // envelope kodları istediğinden ikisi proje uzantısı olarak dahil
    // edilmiştir (bkz. src/errors.ts başlığı).
    expect([...CAUSORYN_TOOL_ERROR_CODES].sort()).toEqual(
      [
        "WORKSPACE_NOT_AUTHORIZED",
        "PATH_DENIED",
        "INDEX_NOT_READY",
        "AMBIGUOUS_SYMBOL",
        "LIMIT_EXCEEDED",
        "INVALID_ARGUMENT",
        "EVIDENCE_NOT_FOUND",
        "UNSUPPORTED_LANGUAGE",
        "INTERNAL_ERROR",
      ].sort(),
    );
  });

  it("güvenlik: INTERNAL_ERROR ham hata mesajını istemciye yansıtmaz; ayrıntı yalnızca stderr logdadır", async () => {
    // Depodan fırlayan HAM Error (sürücü/kütüphane mesajı: tablo adı,
    // mutlak yol gibi iç detaylar taşıyabilir) — CausorynToolError değil.
    const SECRET =
      "SQLITE_CONSTRAINT: table nodes has no column named kind at D:\\gizli\\yol\\index.sqlite";
    const logs: string[] = [];
    const throwingRepo = {
      getLatestPublished: () => {
        throw new Error(SECRET);
      },
    } as unknown as GraphRepository;
    const context = createCausorynContext(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        results: { maxNodes: 250, maxSymbols: 100 },
        autoIndex: false,
      },
      { repository: throwingRepo, logger: (message) => logs.push(message) },
    );
    const pair = await connectClient(context);
    try {
      const result = await callTool(pair.client, "causoryn_workspace_summary");
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("error");
      const error = envelope.error as Record<string, unknown>;
      expect(error.code).toBe("INTERNAL_ERROR");
      expect(error.retryable).toBe(true);

      const message = error.message as string;
      // Ham sürücü/kütüphane mesajı ve içindeki iç detaylar istemciye sızmaz.
      expect(message).not.toContain("SQLITE_CONSTRAINT");
      expect(message).not.toContain("nodes");
      expect(message).not.toContain("D:\\gizli");
      // Genel mesaj, envelope'daki requestId ile korelasyonlu olur.
      expect(message).toContain(envelope.requestId as string);
      // Tam ayrıntı yalnızca enjekte edilen logger'a (stderr) gider.
      const joined = logs.join("\n");
      expect(joined).toContain("causoryn_workspace_summary");
      expect(joined).toContain(SECRET);
    } finally {
      await pair.close();
    }
  });

  it("güvenlik: Error olmayan fırlayan değer için de ham içerik istemciye sızdırılmaz", async () => {
    const logs: string[] = [];
    const throwingRepo = {
      getLatestPublished: () => {
        // Yalnızca Error olmayan değer fırlatan uygulama kodunu taklit eder.
        throw "gizli-deger-42";
      },
    } as unknown as GraphRepository;
    const context = createCausorynContext(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        results: { maxNodes: 250, maxSymbols: 100 },
        autoIndex: false,
      },
      { repository: throwingRepo, logger: (message) => logs.push(message) },
    );
    const pair = await connectClient(context);
    try {
      const result = await callTool(pair.client, "causoryn_workspace_summary");
      const envelope = expectEnvelope(result);
      const error = envelope.error as Record<string, unknown>;
      expect(error.code).toBe("INTERNAL_ERROR");
      expect(error.message).not.toContain("gizli-deger-42");
      expect(logs.join("\n")).toContain("gizli-deger-42");
    } finally {
      await pair.close();
    }
  });
});
