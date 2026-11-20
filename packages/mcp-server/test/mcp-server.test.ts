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
import {
  createSnapshot,
  sha256Hex,
  utf8Encode,
  type SnapshotGraph,
  type SnapshotInput,
} from "@causoryn/domain";
import { InMemoryGraphRepository } from "@causoryn/graph";
import type { GraphRepository } from "@causoryn/graph";
import { describe, expect, it } from "vitest";

import {
  CAUSORYN_TOOL_ERROR_CODES,
  EnvelopeSchema,
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_NAMES,
  coverageOf,
  createCausorynContext,
  createCausorynMcpServer,
} from "../src/index.js";
import type { CausorynContext } from "../src/index.js";

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(path.dirname(PKG_DIR));
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

// Zaman bütçesi: her test makeContext() ile autoIndex'li taze bir bağlam
// kurar — yani her test tam bir TS Program inşası (IndexService.runIndex)
// yürüten CPU-bağlı çalışmadır; İLK test (initialize) derleyicinin soğuk
// başlangıcını da üstlenir. Suite paralel worker'larla koşarken
// kontansiyon vitest varsayılan 5000ms limitini aşabilir (vitest 5, limiti
// aşan senkron çalışmayı assertion'lar geçse de reddeder). job-manager.test.ts
// ve framework-linkers.test.ts ile aynı kural: açık 30s limiti — assertion
// gevşetmesi yoktur, yalnızca yük altı çalışma bütçesi.
describe("MCP server — protokol düzeyi", { timeout: 30_000 }, () => {
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

  it("tools/list: tam olarak 29 araç; her biri inputSchema + outputSchema taşır", async () => {
    const pair = await connectClient(makeContext());
    try {
      const { tools } = await pair.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      // Sıra TŞ §10.2 katalog sırası + §16A.8 Wiki ekidir: index_status +
      // refresh_index sprint-2 B6 ile, get_symbol_context sprint-2 B5 ile,
      // trace_execution sprint-2 B4 ile, Faz C'nin 7 aracı sprint-3 C8 ile,
      // Living Wiki'nin 7 aracı sprint-4 W5 ile, Faz D'nin 5 aracı sprint-5
      // D2-D6 ile, Faz E'nin causoryn_verify_change aracı sprint-6 E1-E3 ile
      // eklendi (TŞ §16A.8 tablo sırası: wiki_build başta, wiki_diff sonda;
      // Faz D/E satırları TŞ §10.2 katalog sırasını izler — trace_business_
      // flow trace_execution'dan sonra, preflight_change/check_contracts/
      // detect_contract_drift export_documentation ile get_evidence
      // arasında, verify_change detect_contract_drift ile derive_test_plan
      // arasında — PDF s.10 katalog satır sırası).
      expect(TOOL_NAMES).toEqual([
        "causoryn_get_capabilities",
        "causoryn_workspace_summary",
        "causoryn_index_status",
        "causoryn_refresh_index",
        "causoryn_map_system",
        "causoryn_find_symbols",
        "causoryn_get_symbol_context",
        "causoryn_trace_execution",
        "causoryn_trace_business_flow",
        "causoryn_analyze_impact",
        "causoryn_check_architecture",
        "causoryn_compare_architecture",
        "causoryn_get_agent_context",
        "causoryn_generate_onboarding",
        "causoryn_export_documentation",
        "causoryn_preflight_change",
        "causoryn_check_contracts",
        "causoryn_detect_contract_drift",
        "causoryn_verify_change",
        "causoryn_derive_test_plan",
        "causoryn_get_evidence",
        "causoryn_architecture_timeline",
        "causoryn_wiki_build",
        "causoryn_wiki_get_tree",
        "causoryn_wiki_get_page",
        "causoryn_wiki_search",
        "causoryn_wiki_get_links",
        "causoryn_wiki_get_versions",
        "causoryn_wiki_diff",
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
      // M2: INDEXED_ADAPTERS'ten beş adapter görünür (TS + C# + python/go/rust).
      expect(adapters.map((a) => a.language)).toEqual([
        "typescript",
        "csharp",
        "python",
        "go",
        "rust",
      ]);
      const ts = adapters.find((a) => a.language === "typescript");
      expect(ts).toBeDefined();
      expect(ts?.analyzerId).toBe("ts-adapter");
      expect(ts?.levels).toEqual({
        astParse: "L1",
        symbolResolution: "L2",
        frameworkLinkers: "express+nextjs",
      });
      const cs = adapters.find((a) => a.language === "csharp");
      expect(cs).toBeDefined();
      expect(cs?.analyzerId).toBe("roslyn-worker");
      expect(cs?.levels).toEqual({
        astParse: "L1",
        symbolResolution: "L2",
        frameworkLinkers: "aspnet-core-route-attributes (L3)",
      });
      const py = adapters.find((a) => a.language === "python");
      expect(py?.analyzerId).toBe("python-worker");
      expect(py?.levels).toEqual({
        astParse: "L1",
        symbolResolution: "L2",
        frameworkLinkers: "decorator-route-pattern (L3)",
      });
      const go = adapters.find((a) => a.language === "go");
      expect(go?.analyzerId).toBe("go-worker");
      // Dürüstlük: go worker semantik L2 çözümleme beyan ETMEZ.
      expect((go?.levels as Record<string, unknown>)["symbolResolution"]).toContain(
        "heuristic",
      );
      const rust = adapters.find((a) => a.language === "rust");
      expect(rust?.analyzerId).toBe("rust-worker");
      expect((rust?.levels as Record<string, unknown>)["symbolResolution"]).toBe(
        "heuristic-heavy",
      );
      expect((rust?.levels as Record<string, unknown>)["frameworkLinkers"]).toContain("L3");
      const limits = data.limits as Record<string, unknown>;
      expect(limits.maxNodes).toBe(250);
      expect(limits.maxSymbols).toBe(100);
      // Denetim bulgusu 10: hata metinleri istemciyi "results.maxDepth/
      // maxPaths tavanı"na yönlendirir (get_symbol_context/trace_execution
      // LIMIT_EXCEEDED) — tavanlar get_capabilities üzerinden keşfedilebilmeli.
      expect(limits.maxDepth).toBe(3);
      expect(limits.maxPaths).toBe(50);
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
        expect(summaryCoverage.tier).toBe("L0");
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
        expect(mapCoverage.tier).toBe("L0");
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

  it("hata kodu seti sabittir (TŞ §10.1 taban + üç proje uzantısı)", () => {
    // TŞ §10.1 taban listesi + ÜÇ proje uzantısı: INVALID_ARGUMENT +
    // EVIDENCE_NOT_FOUND (K-008; sprint-1 görev 7) ve SYMBOL_NOT_FOUND
    // (K-011; sprint-2 B4/B5 causoryn_get_symbol_context) — bkz. src/errors.ts
    // başlığı. POLICY_INVALID, INVALID_REVISION ve EXPORT_NOT_ALLOWED uzantı
    // DEĞİLDİR: TŞ §10.1 sabit listesindedirler ve sprint-3 C8'de (guard
    // policy + git revizyon + export output yetkilendirmesi araçları) ilk
    // kez kullanıldılar (takım denetimi bulgusu: export yazma reddi için
    // yeni uzantı kodu basmak K-008 örüntüsünün önkoşulunu ihlal ederdi).
    // WIKI_PAGE_NOT_FOUND aynı örüntüyledir: TŞ §10.1 sabit kodu, sprint-4
    // W5'te (Faz C2 wiki araçları; WikiSnapshot'ta olmayan sayfa kimliği)
    // İLK KEZ kullanıldı — takım denetimi bulgusuyla EVIDENCE_NOT_FOUND'dan
    // düzeltildi. CONTRACT_PARSE_FAILED da TŞ §10.1 sabit kodudur: sprint-5
    // Faz D'de (D2/D3 sözleşme araçları; contracts/spec-* parse/şema
    // reddinin MCP eşlemesi) İLK KEZ kullanıldı — uzantı kodu basılmaz.
    expect([...CAUSORYN_TOOL_ERROR_CODES].sort()).toEqual(
      [
        "WORKSPACE_NOT_AUTHORIZED",
        "PATH_DENIED",
        "INDEX_NOT_READY",
        "AMBIGUOUS_SYMBOL",
        "LIMIT_EXCEEDED",
        "INVALID_ARGUMENT",
        "EVIDENCE_NOT_FOUND",
        "SYMBOL_NOT_FOUND",
        "POLICY_INVALID",
        "INVALID_REVISION",
        "EXPORT_NOT_ALLOWED",
        "WIKI_PAGE_NOT_FOUND",
        "CONTRACT_PARSE_FAILED",
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

  /* ---------------------------------------------------------------- */
  /* sprint-2 B6: causoryn_refresh_index + causoryn_index_status       */
  /* ---------------------------------------------------------------- */

  it("pozitif refresh_index: tools/call anında jobId döner; iş arka planda done olur ve map_system yeni snapshot'tan okur", async () => {
    const context = makeContext();
    const pair = await connectClient(context);
    try {
      // autoIndex'in yayımladığı ilk snapshot (revision sequence 1).
      const before = await callTool(pair.client, "causoryn_workspace_summary");
      const beforeEnvelope = expectEnvelope(before);
      const initialSnapshotId = beforeEnvelope.snapshotId as string;

      // refresh_index HEMEN döner: iş kuyrukta/koşuyor, snapshot henüz yok.
      const refresh = await callTool(pair.client, "causoryn_refresh_index", {
        mode: "full",
      });
      const refreshEnvelope = expectEnvelope(refresh);
      expect(refreshEnvelope.status).toBe("ok");
      expect(refreshEnvelope.snapshotId).toBeNull();
      const refreshData = refreshEnvelope.data as Record<string, unknown>;
      const jobId = refreshData.jobId as string;
      expect(typeof jobId).toBe("string");
      expect(refreshData.mode).toBe("full");
      expect(refreshData.scope).toBeNull();
      expect(["queued", "running"]).toContain(refreshData.status);

      // Async kanıt: handler döndükten sonra iş bitene dek beklenir.
      const final = await context.jobManager.waitForJob(jobId);
      expect(final.status).toBe("done");

      // index_status(jobId): Snapshot, stale, job progress, diagnostics
      // (TŞ §10.2 index_status çıktı sözleşmesi).
      const status = await callTool(pair.client, "causoryn_index_status", { jobId });
      const statusEnvelope = expectEnvelope(status);
      expect(statusEnvelope.status).toBe("ok");
      const statusData = statusDataOf(statusEnvelope);
      expect(statusData.jobId).toBe(jobId);
      const job = statusData.job as Record<string, unknown>;
      expect(job.status).toBe("done");
      expect(job.snapshotState).toBe("ready");
      expect(job.progressPercent).toBe(100);
      expect(job.stale).toBe(false);
      expect(job.error).toBeNull();

      // Yeni snapshot yayımlandı: ID, revision sequence artışı nedeniyle
      // ilk snapshot'tan farklıdır ve map_system ARTIK yeni snapshot'ı okur.
      const latest = statusData.latestSnapshot as Record<string, unknown>;
      expect(latest.snapshotId).toBe(job.snapshotId);
      expect(job.snapshotId).not.toBe(initialSnapshotId);
      const map = await callTool(pair.client, "causoryn_map_system", { level: "L3" });
      const mapEnvelope = expectEnvelope(map);
      expect(mapEnvelope.snapshotId).toBe(job.snapshotId);
      const mapData = mapEnvelope.data as Record<string, unknown>;
      const qualifiedNames = (mapData.nodes as Array<Record<string, unknown>>).map(
        (n) => n.qualifiedName as string,
      );
      expect(qualifiedNames).toContain("OrdersService.create");
    } finally {
      await pair.close();
    }
  }, 30_000);

  it("pozitif index_status: jobId verilmezse en son iş raporlanır", async () => {
    const context = makeContext();
    const pair = await connectClient(context);
    try {
      const refresh = await callTool(pair.client, "causoryn_refresh_index", { mode: "full" });
      const jobId = (expectEnvelope(refresh).data as Record<string, unknown>).jobId as string;
      await context.jobManager.waitForJob(jobId);

      const status = await callTool(pair.client, "causoryn_index_status", {});
      const statusData = statusDataOf(expectEnvelope(status));
      expect(statusData.jobId).toBe(jobId);
      expect((statusData.job as Record<string, unknown>).status).toBe("done");
    } finally {
      await pair.close();
    }
  }, 30_000);

  it("negatif refresh_index: yetkisiz workspace → WORKSPACE_NOT_AUTHORIZED", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_refresh_index", {
        workspaceId: "baska-workspace",
        mode: "full",
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("error");
      expect((envelope.error as Record<string, unknown>).code).toBe(
        "WORKSPACE_NOT_AUTHORIZED",
      );
    } finally {
      await pair.close();
    }
  });

  it("pozitif refresh_index: mode=incremental tamamlanır; değişimsiz workspace'te no-op uyarısıyla mevcut snapshot korunur", async () => {
    const context = makeContext();
    const initialSnapshotId = context.repository.getLatestPublished("default")?.snapshot.meta.id;
    const pair = await connectClient(context);
    try {
      const result = await callTool(pair.client, "causoryn_refresh_index", {
        mode: "incremental",
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("ok");
      const refreshData = envelope.data as Record<string, unknown>;
      expect(refreshData.mode).toBe("incremental");
      const jobId = refreshData.jobId as string;

      await context.jobManager.waitForJob(jobId);

      const status = await callTool(pair.client, "causoryn_index_status", { jobId });
      const statusData = statusDataOf(expectEnvelope(status));
      const job = statusData.job as Record<string, unknown>;
      expect(job.status).toBe("done");
      expect(job.mode).toBe("incremental");
      expect(job.snapshotId).toBe(initialSnapshotId);
      expect((job.warnings as string[]).some((w) => w.includes("incremental no-op"))).toBe(true);
    } finally {
      await pair.close();
    }
  }, 30_000);

  it("negatif index_status: bilinmeyen jobId → INVALID_ARGUMENT (sabit hata kodu)", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_index_status", {
        jobId: "job-yok",
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("error");
      const error = envelope.error as Record<string, unknown>;
      expect(error.code).toBe("INVALID_ARGUMENT");
      expect(JSON.stringify(error.message)).toContain("job-yok");
    } finally {
      await pair.close();
    }
  });

  it("negatif refresh_index: scope bu dilimde desteklenmez → INVALID_ARGUMENT", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_refresh_index", {
        mode: "full",
        scope: "src/services",
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("error");
      expect((envelope.error as Record<string, unknown>).code).toBe("INVALID_ARGUMENT");
    } finally {
      await pair.close();
    }
  });

  it("partial index_status: boş workspace → iş done + snapshotState partial + envelope status partial", async () => {
    const emptyRoot = mkdtempSync(path.join(tmpdir(), "causoryn-mcp-status-empty-"));
    try {
      const context = makeContext({ allowRoots: [emptyRoot] });
      const pair = await connectClient(context);
      try {
        const refresh = await callTool(pair.client, "causoryn_refresh_index", {
          mode: "full",
        });
        const jobId = (expectEnvelope(refresh).data as Record<string, unknown>)
          .jobId as string;
        await context.jobManager.waitForJob(jobId);

        const status = await callTool(pair.client, "causoryn_index_status", { jobId });
        const envelope = expectEnvelope(status);
        expect(envelope.status).toBe("partial");
        const statusData = statusDataOf(envelope);
        const job = statusData.job as Record<string, unknown>;
        expect(job.status).toBe("done");
        expect(job.snapshotState).toBe("partial");
        expect((job.warnings as string[]).length).toBeGreaterThanOrEqual(1);
        const latest = statusData.latestSnapshot as Record<string, unknown>;
        expect(latest.state).toBe("partial");
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("index_status: iş ve snapshot hiç yokken (autoIndex=false) null alanlar + yönlendirici uyarı döner", async () => {
    const pair = await connectClient(makeContext({ autoIndex: false }));
    try {
      const status = await callTool(pair.client, "causoryn_index_status", {});
      const envelope = expectEnvelope(status);
      expect(envelope.status).toBe("ok");
      expect(envelope.snapshotId).toBeNull();
      const statusData = statusDataOf(envelope);
      expect(statusData.job).toBeNull();
      expect(statusData.latestSnapshot).toBeNull();
      expect(
        (envelope.warnings as string[]).some((w) => w.includes("refresh_index")),
      ).toBe(true);
    } finally {
      await pair.close();
    }
  });

  /* ---------------------------------------------------------------- */
  /* sprint-2 B5: causoryn_get_symbol_context                          */
  /* ---------------------------------------------------------------- */

  /** find_symbols üzerinden bir qualifiedName'un node kimliğini çözer. */
  async function symbolIdByQualifiedName(
    client: Client,
    qualifiedName: string,
  ): Promise<string> {
    const found = await callTool(client, "causoryn_find_symbols", {
      query: qualifiedName,
    });
    const hits = (expectEnvelope(found).data as Record<string, unknown>)
      .hits as Array<Record<string, unknown>>;
    const hit = hits.find((h) => h.qualifiedName === qualifiedName);
    expect(hit, `find_symbols ${qualifiedName} döndürmedi`).toBeDefined();
    return hit?.symbolId as string;
  }

  it("pozitif get_symbol_context: OrdersService.create relations + evidence dosya/satır taşır", async () => {
    const pair = await connectClient(makeContext());
    try {
      const symbolId = await symbolIdByQualifiedName(
        pair.client,
        "OrdersService.create",
      );

      const result = await callTool(pair.client, "causoryn_get_symbol_context", {
        symbolId,
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("ok");
      expect(envelope.snapshotId).not.toBeNull();

      const data = envelope.data as Record<string, unknown>;
      const symbol = data.symbol as Record<string, unknown>;
      expect(symbol.id).toBe(symbolId);
      expect(symbol.kind).toBe("Method");
      expect(symbol.qualifiedName).toBe("OrdersService.create");

      const nodes = data.nodes as Array<Record<string, unknown>>;
      const idByQn = new Map(
        nodes.map((n) => [n.qualifiedName as string, n.id as string]),
      );
      const edges = data.edges as Array<Record<string, unknown>>;

      // CALLS: OrdersService.create → OrderRepository.save (verified; TŞ §25/4).
      const calls = edges.find(
        (e) =>
          e.kind === "CALLS" &&
          e.from === symbolId &&
          e.to === idByQn.get("OrderRepository.save"),
      );
      expect(calls).toBeDefined();
      expect(calls?.resolution).toBe("verified");
      expect((calls?.evidenceIds as string[]).length).toBeGreaterThanOrEqual(1);

      // CONTAINS: OrdersService → OrdersService.create (yön: Class → Method).
      const contains = edges.find(
        (e) =>
          e.kind === "CONTAINS" &&
          e.from === idByQn.get("OrdersService") &&
          e.to === symbolId,
      );
      expect(contains).toBeDefined();

      // Deterministik sıralama: kenarlar id kanonik, kanıtlar id sıralı,
      // node'lar qualifiedName+id sıralı ve tekrarsız.
      const edgeIds = edges.map((e) => e.id as string);
      expect([...edgeIds].sort()).toEqual(edgeIds);
      const nodeIds = nodes.map((n) => n.id as string);
      expect(new Set(nodeIds).size).toBe(nodeIds.length);
      expect(nodeIds).toContain(symbolId);
      const evidence = data.evidence as Array<Record<string, unknown>>;
      const evidenceIds = evidence.map((ev) => ev.id as string);
      expect([...evidenceIds].sort()).toEqual(evidenceIds);
      expect(new Set(evidenceIds).size).toBe(evidenceIds.length);

      // CALLS kenarının kanıtı fixture dosyasının GERÇEK satırına işaret eder.
      const callsEvidence = evidence.find((ev) =>
        (calls?.evidenceIds as string[]).includes(ev.id as string),
      );
      expect(callsEvidence).toBeDefined();
      const span = callsEvidence?.span as Record<string, unknown>;
      expect(span.relativePath).toBe("src/services/orders-service.ts");
      expect(span.startLine).toBeGreaterThan(0);

      // Diskteki gerçek dosyanın ilgili satırı kanıt satır aralığıyla örtüşür
      // (sprint-1 görev 7 entegrasyon kanıtı kalıbı).
      const source = readFileSync(
        path.join(FIXTURE_ROOT, "src", "services", "orders-service.ts"),
        "utf8",
      ).split("\n");
      const lineText = source[(span.startLine as number) - 1] ?? "";
      expect(lineText).toContain("repository.save");

      // edgeKinds verilmediyse data.edgeKinds null'dır (tüm türler).
      expect(data.edgeKinds).toBeNull();
    } finally {
      await pair.close();
    }
  });

  it("pozitif get_symbol_context: depth büyütülünce context genişler ve üst katman node'ları gelir", async () => {
    const pair = await connectClient(makeContext());
    try {
      const symbolId = await symbolIdByQualifiedName(
        pair.client,
        "OrdersService.create",
      );
      const one = await callTool(pair.client, "causoryn_get_symbol_context", {
        symbolId,
        depth: 1,
      });
      const oneData = expectEnvelope(one).data as Record<string, unknown>;
      const oneQns = (oneData.nodes as Array<Record<string, unknown>>).map(
        (n) => n.qualifiedName as string,
      );

      const two = await callTool(pair.client, "causoryn_get_symbol_context", {
        symbolId,
        depth: 2,
      });
      const twoEnvelope = expectEnvelope(two);
      const twoData = twoEnvelope.data as Record<string, unknown>;
      const twoQns = (twoData.nodes as Array<Record<string, unknown>>).map(
        (n) => n.qualifiedName as string,
      );

      expect(twoData.depth).toBe(2);
      expect(oneQns).toContain("OrderRepository.save");
      // depth=2, depth=1'in katman 1 kümesini kapsar ve daha derin node'lar ekler.
      for (const qn of oneQns) expect(twoQns).toContain(qn);
      expect(twoQns.length).toBeGreaterThan(oneQns.length);
    } finally {
      await pair.close();
    }
  });

  it("pozitif get_symbol_context: edgeKinds filtresi yalnızca istenen türdeki kenarları döndürür", async () => {
    const pair = await connectClient(makeContext());
    try {
      const symbolId = await symbolIdByQualifiedName(
        pair.client,
        "OrdersService.create",
      );
      const result = await callTool(pair.client, "causoryn_get_symbol_context", {
        symbolId,
        edgeKinds: ["CALLS"],
      });
      const data = expectEnvelope(result).data as Record<string, unknown>;
      const edges = data.edges as Array<Record<string, unknown>>;
      expect(edges.length).toBeGreaterThanOrEqual(1);
      for (const edge of edges) expect(edge.kind).toBe("CALLS");
      // Filtre traversal'a da uygulanır: CALLS dışı komşular keşfedilmez.
      const qns = (data.nodes as Array<Record<string, unknown>>).map(
        (n) => n.qualifiedName as string,
      );
      expect(qns).toContain("OrderRepository.save");
      expect(data.edgeKinds).toEqual(["CALLS"]);
    } finally {
      await pair.close();
    }
  });

  it("negatif get_symbol_context: bilinmeyen kimlik/ad → SYMBOL_NOT_FOUND; geçersiz edgeKinds → INVALID_ARGUMENT", async () => {
    const pair = await connectClient(makeContext());
    try {
      const unknownId = await callTool(pair.client, "causoryn_get_symbol_context", {
        symbolId: "node:0000000000000000000000000000000000000000000000000000000000000000",
      });
      const unknownIdEnvelope = expectEnvelope(unknownId);
      expect(unknownIdEnvelope.status).toBe("error");
      const idError = unknownIdEnvelope.error as Record<string, unknown>;
      expect(idError.code).toBe("SYMBOL_NOT_FOUND");
      expect(idError.retryable).toBe(false);
      expect((idError.userAction as string).length).toBeGreaterThan(0);

      const unknownName = await callTool(pair.client, "causoryn_get_symbol_context", {
        symbolId: "NoSuchSymbolAnywhere",
      });
      expect(
        (expectEnvelope(unknownName).error as Record<string, unknown>).code,
      ).toBe("SYMBOL_NOT_FOUND");

      // Yetki denetimi kimlik aramasından ÖNCE gelir (tutarlılık).
      const authz = await callTool(pair.client, "causoryn_get_symbol_context", {
        workspaceId: "baska-workspace",
        symbolId: "x",
      });
      expect(
        (expectEnvelope(authz).error as Record<string, unknown>).code,
      ).toBe("WORKSPACE_NOT_AUTHORIZED");

      // edgeKinds şemayı geçer (string dizisi) ama EDGE_KINDS üyesi değilse
      // anlamsal reddiyen INVALID_ARGUMENT'dır (sprint-1 kalıbı).
      const symbolId = await symbolIdByQualifiedName(
        pair.client,
        "OrdersService.create",
      );
      const badKinds = await callTool(pair.client, "causoryn_get_symbol_context", {
        symbolId,
        edgeKinds: ["CALLS", "NO_SUCH_KIND"],
      });
      const badKindsEnvelope = expectEnvelope(badKinds);
      const kindsError = badKindsEnvelope.error as Record<string, unknown>;
      expect(kindsError.code).toBe("INVALID_ARGUMENT");
      expect(JSON.stringify(kindsError.message)).toContain("NO_SUCH_KIND");
    } finally {
      await pair.close();
    }
  });

  it("negatif get_symbol_context: depth results.maxDepth tavanını aşarsa LIMIT_EXCEEDED", async () => {
    const context = makeContext({ results: { maxNodes: 250, maxSymbols: 100, maxDepth: 2 } });
    const pair = await connectClient(context);
    try {
      const symbolId = await symbolIdByQualifiedName(
        pair.client,
        "OrdersService.create",
      );
      const result = await callTool(pair.client, "causoryn_get_symbol_context", {
        symbolId,
        depth: 3,
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("error");
      const error = envelope.error as Record<string, unknown>;
      expect(error.code).toBe("LIMIT_EXCEEDED");
      expect(JSON.stringify(error.message)).toContain("maxDepth");
    } finally {
      await pair.close();
    }
  });

  it("negatif get_symbol_context: qualifiedName birden çok node'a tam eşleşirse AMBIGUOUS_SYMBOL + aday listesi", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "causoryn-ambiguous-symbol-"));
    try {
      mkdirSync(path.join(root, "src", "a"), { recursive: true });
      mkdirSync(path.join(root, "src", "b"), { recursive: true });
      writeFileSync(
        path.join(root, "src", "a", "dup.ts"),
        "export class Dup { ping(): number { return 1; } }\n",
        "utf8",
      );
      writeFileSync(
        path.join(root, "src", "b", "dup.ts"),
        "export class Dup { pong(): number { return 2; } }\n",
        "utf8",
      );
      const pair = await connectClient(makeContext({ allowRoots: [root] }));
      try {
        const result = await callTool(pair.client, "causoryn_get_symbol_context", {
          symbolId: "Dup",
        });
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("error");
        const error = envelope.error as Record<string, unknown>;
        expect(error.code).toBe("AMBIGUOUS_SYMBOL");
        const candidates = envelope.data as {
          candidates?: Array<Record<string, unknown>>;
        };
        expect(candidates.candidates).toHaveLength(2);
        const paths = (candidates.candidates ?? [])
          .map((c) => c.relativePath as string)
          .sort();
        expect(paths).toEqual(["src/a/dup.ts", "src/b/dup.ts"]);
        for (const candidate of candidates.candidates ?? []) {
          expect(candidate.kind).toBe("Class");
          expect(candidate.qualifiedName).toBe("Dup");
          expect(typeof candidate.symbolId).toBe("string");
        }
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("partial get_symbol_context: istenen derinlikte kesilir → truncated=true + depth uyarısı", async () => {
    const pair = await connectClient(makeContext());
    try {
      const symbolId = await symbolIdByQualifiedName(
        pair.client,
        "OrdersService.create",
      );
      const result = await callTool(pair.client, "causoryn_get_symbol_context", {
        symbolId,
        depth: 1,
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      expect(data.truncated).toBe(true);
      expect(data.depth).toBe(1);
      expect(
        (envelope.warnings as string[]).some((w) => w.includes("depth")),
      ).toBe(true);
      // Kısmi sonuç yine de tutarlıdır: tüm kenar uçları nodes kümesindedir.
      const nodeIds = new Set(
        (data.nodes as Array<Record<string, unknown>>).map((n) => n.id as string),
      );
      for (const edge of data.edges as Array<Record<string, unknown>>) {
        expect(nodeIds.has(edge.from as string)).toBe(true);
        expect(nodeIds.has(edge.to as string)).toBe(true);
      }
    } finally {
      await pair.close();
    }
  });

  it("partial get_symbol_context: results.maxNodes tavanı → truncated + maxNodes uyarısı; kenar uçları nodes kümesinde kalır", async () => {
    const context = makeContext({ results: { maxNodes: 4, maxSymbols: 100 } });
    const pair = await connectClient(context);
    try {
      const symbolId = await symbolIdByQualifiedName(
        pair.client,
        "OrdersService.create",
      );
      const result = await callTool(pair.client, "causoryn_get_symbol_context", {
        symbolId,
        depth: 2,
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      expect(data.truncated).toBe(true);
      expect(
        (envelope.warnings as string[]).some((w) => w.includes("maxNodes")),
      ).toBe(true);
      const nodeIds = new Set(
        (data.nodes as Array<Record<string, unknown>>).map((n) => n.id as string),
      );
      expect(nodeIds.size).toBeLessThanOrEqual(4);
      for (const edge of data.edges as Array<Record<string, unknown>>) {
        expect(nodeIds.has(edge.from as string)).toBe(true);
        expect(nodeIds.has(edge.to as string)).toBe(true);
      }
    } finally {
      await pair.close();
    }
  });

  it("get_symbol_context: aktif build varken eski snapshot stale=true uyarısıyla servis edilir", async () => {
    const repository = new InMemoryGraphRepository();
    const context = createCausorynContext(
      {
        workspaceId: "default",
        allowRoots: [FIXTURE_ROOT],
        results: { maxNodes: 250, maxSymbols: 100 },
        autoIndex: true,
      },
      { repository },
    );
    // TŞ §9 stale semantiği: aynı/daha yüksek revizyon sırası için aktif
    // building varken eski yayın stale=true döner (memory-repository isStale).
    repository.beginBuild({
      workspaceId: "default",
      revision: { id: "working-tree", sequence: 2 },
      configHash: "stale-context-test",
      analyzerFingerprint: "test@0.0.0",
      createdAt: "2026-11-02T00:00:00.000Z",
    });
    const pair = await connectClient(context);
    try {
      const symbolId = await symbolIdByQualifiedName(
        pair.client,
        "OrdersService.create",
      );
      const result = await callTool(pair.client, "causoryn_get_symbol_context", {
        symbolId,
      });
      const envelope = expectEnvelope(result);
      // Eski snapshot HÂLÂ servis edilir (TŞ §9: uzun indeks süresinde eski
      // snapshot sorgulanabilmeli), stale uyarısı açıkça taşınır.
      expect(envelope.status).toBe("ok");
      expect(envelope.snapshotId).not.toBeNull();
      expect(
        (envelope.warnings as string[]).some((w) => w.includes("stale=true")),
      ).toBe(true);
      const data = envelope.data as Record<string, unknown>;
      expect((data.symbol as Record<string, unknown>).qualifiedName).toBe(
        "OrdersService.create",
      );
    } finally {
      await pair.close();
    }
  });
});

/** index_status data alanını tipli sözlük olarak döndürür (yardımcı). */
function statusDataOf(envelope: Record<string, unknown>): Record<string, unknown> {
  return envelope.data as Record<string, unknown>;
}

/** Sentetik çok-dil SnapshotGraph'ı InMemoryGraphRepository'ye yayımlayıp Context kurar. */
function contextWithPublishedSnapshot(
  input: Omit<SnapshotInput, "state"> & { readonly state: "ready" | "partial" },
): CausorynContext {
  const normalizedNodes = input.nodes.map((n) =>
    n.relativePath !== undefined && n.location === undefined
      ? {
          ...n,
          location: {
            relativePath: n.relativePath,
            startLine: 1,
            endLine: 1,
            sourceHash: `sha256:${n.relativePath}`,
          },
        }
      : n,
  );
  const snapshot: SnapshotGraph = createSnapshot({
    ...input,
    nodes: normalizedNodes,
  });
  const repository = new InMemoryGraphRepository();
  repository.registerWorkspace({
    id: input.workspaceId,
    rootPath: FIXTURE_ROOT,
    createdAt: input.createdAt,
  });
  const build = repository.beginBuild({
    workspaceId: input.workspaceId,
    revision: snapshot.meta.revision,
    configHash: snapshot.meta.configHash,
    analyzerFingerprint: snapshot.meta.analyzerFingerprint,
    createdAt: snapshot.meta.createdAt,
  });
  for (const node of snapshot.nodes) {
    repository.addNode(build.buildId, node);
  }
  for (const ev of snapshot.evidence) {
    repository.addEvidence(build.buildId, ev);
  }
  for (const edge of snapshot.edges) {
    repository.addEdge(build.buildId, edge);
  }
  repository.publish(build.buildId, input.state, "2026-11-18T00:00:01.000Z");
  return createCausorynContext(
    {
      workspaceId: input.workspaceId,
      allowRoots: [FIXTURE_ROOT],
      results: { maxNodes: 250, maxSymbols: 100 },
      autoIndex: false,
    },
    { repository, logger: () => {} },
  );
}

describe(
  "MCP server — yapısal annotations, dürüst açıklamalar ve çok-dil workspace_summary / coverageOf",
  { timeout: 30_000 },
  () => {
    it("tools/list: 29 aracın tamamı yapısal annotations taşır (3 yazma aracı readOnlyHint=false, 26 araç readOnlyHint=true)", async () => {
      const pair = await connectClient(makeContext({ autoIndex: false }));
      try {
        const { tools } = await pair.client.listTools();
        expect(tools.length).toBe(29);
        for (const tool of tools) {
          expect(tool.annotations, `${tool.name} annotations eksik`).toBeDefined();
          expect(tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBe(false);
          expect(tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBe(false);
          expect(typeof tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(
            "boolean",
          );
        }
        const writeTools = tools
          .filter((t) => t.annotations?.readOnlyHint === false)
          .map((t) => t.name)
          .sort();
        expect(writeTools).toEqual([
          "causoryn_export_documentation",
          "causoryn_refresh_index",
          "causoryn_wiki_build",
        ]);
        const readOnlyTools = tools
          .filter((t) => t.annotations?.readOnlyHint === true)
          .map((t) => t.name);
        expect(readOnlyTools.length).toBe(26);
      } finally {
        await pair.close();
      }
    });

    it("tools/list: refresh_index ve preflight_change açıklamaları süreç-içi bellek davranışını dürüstçe beyan eder", async () => {
      const pair = await connectClient(makeContext({ autoIndex: false }));
      try {
        const { tools } = await pair.client.listTools();
        const refreshTool = tools.find((t) => t.name === "causoryn_refresh_index");
        expect(refreshTool?.description).toContain("InMemoryGraphRepository");
        expect(refreshTool?.description).not.toContain(
          "Yalnızca Causoryn izinli data-root'una yazar.",
        );

        const preflightTool = tools.find((t) => t.name === "causoryn_preflight_change");
        expect(preflightTool?.description).toContain("PreflightManifestStore");
        expect(preflightTool?.description).toContain("FIFO 200");
      } finally {
        await pair.close();
      }
    });

    it("çok-dil workspace_summary ve coverageOf: Python ve C# sembol node'lu snapshot tier=L2 ve dil sayısını döner", async () => {
      const pyContext = contextWithPublishedSnapshot({
        workspaceId: "default",
        revision: { id: "working-tree", sequence: 1 },
        configHash: "cfg-py",
        analyzerFingerprint: "py@0.1.0",
        state: "ready",
        createdAt: "2026-11-18T00:00:00.000Z",
        nodes: [
          { kind: "Workspace", qualifiedName: "default" },
          {
            kind: "File",
            qualifiedName: "src/app.py",
            relativePath: "src/app.py",
            language: "python",
          },
          {
            kind: "Function",
            qualifiedName: "app.create_order",
            relativePath: "src/app.py",
            language: "python",
          },
          {
            kind: "Function",
            qualifiedName: "repo.save_order",
            relativePath: "src/app.py",
            language: "python",
          },
        ],
        edges: [
          {
            kind: "CONTAINS",
            from: { kind: "File", qualifiedName: "src/app.py", relativePath: "src/app.py" },
            to: {
              kind: "Function",
              qualifiedName: "app.create_order",
              relativePath: "src/app.py",
            },
            resolution: "verified",
            evidence: [
              {
                kind: "ast-symbol",
                span: {
                  relativePath: "src/app.py",
                  startLine: 1,
                  endLine: 4,
                  sourceHash: "sha256:py-app",
                },
                analyzerId: "python-worker",
                analyzerVersion: "0.1.0",
                rationale: "modül düzeyi def tanımı",
              },
            ],
          },
          {
            kind: "CALLS",
            from: {
              kind: "Function",
              qualifiedName: "app.create_order",
              relativePath: "src/app.py",
            },
            to: {
              kind: "Function",
              qualifiedName: "repo.save_order",
              relativePath: "src/app.py",
            },
            resolution: "heuristic",
          },
        ],
      });

      const pyPublished = pyContext.repository.getLatestPublished("default");
      expect(pyPublished).toBeDefined();
      expect(coverageOf(pyPublished!.snapshot)).toEqual({
        tier: "L2",
        resolvedEdges: 2,
        unresolvedEdges: 0,
        totalEdges: 2,
        coverageRatio: 1,
      });

      const pyPair = await connectClient(pyContext);
      try {
        const result = await callTool(pyPair.client, "causoryn_workspace_summary");
        const envelope = expectEnvelope(result);
        const coverage = envelope.coverage as Record<string, unknown>;
        expect(coverage.tier).toBe("L2");
        expect(coverage.totalEdges).toBe(2);
        expect(coverage.resolvedEdges).toBe(2);
        expect(coverage.unresolvedEdges).toBe(0);
        expect(coverage.coverageRatio).toBe(1);

        const data = envelope.data as Record<string, unknown>;
        expect(data.languages).toEqual([{ language: "python", files: 1 }]);
      } finally {
        await pyPair.close();
      }

      const csContext = contextWithPublishedSnapshot({
        workspaceId: "default",
        revision: { id: "working-tree", sequence: 1 },
        configHash: "cfg-cs",
        analyzerFingerprint: "cs@0.1.0",
        state: "ready",
        createdAt: "2026-11-18T00:00:00.000Z",
        nodes: [
          { kind: "Workspace", qualifiedName: "default" },
          {
            kind: "File",
            qualifiedName: "src/OrdersController.cs",
            relativePath: "src/OrdersController.cs",
            language: "csharp",
          },
          {
            kind: "Class",
            qualifiedName: "Orders.OrdersController",
            relativePath: "src/OrdersController.cs",
            language: "csharp",
          },
        ],
        edges: [],
      });

      const csPair = await connectClient(csContext);
      try {
        const result = await callTool(csPair.client, "causoryn_workspace_summary");
        const envelope = expectEnvelope(result);
        expect((envelope.coverage as Record<string, unknown>).tier).toBe("L2");
        expect((envelope.data as Record<string, unknown>).languages).toEqual([
          { language: "csharp", files: 1 },
        ]);
      } finally {
        await csPair.close();
      }
    });

    it("çok-dil workspace_summary ve coverageOf: Go ve Rust sembol node'lu snapshot tier=L1 döner (L2 uydurulmaz — ADR-010)", async () => {
      const goContext = contextWithPublishedSnapshot({
        workspaceId: "default",
        revision: { id: "working-tree", sequence: 1 },
        configHash: "cfg-go",
        analyzerFingerprint: "go@0.1.0",
        state: "ready",
        createdAt: "2026-11-18T00:00:00.000Z",
        nodes: [
          { kind: "Workspace", qualifiedName: "default" },
          {
            kind: "File",
            qualifiedName: "src/types-stub.ts",
            relativePath: "src/types-stub.ts",
            language: "typescript",
          },
          {
            kind: "File",
            qualifiedName: "cmd/main.go",
            relativePath: "cmd/main.go",
            language: "go",
          },
          {
            kind: "Function",
            qualifiedName: "main.HandleOrder",
            relativePath: "cmd/main.go",
            language: "go",
          },
        ],
        edges: [],
      });

      const goPublished = goContext.repository.getLatestPublished("default");
      expect(coverageOf(goPublished!.snapshot).tier).toBe("L1");

      const goPair = await connectClient(goContext);
      try {
        const result = await callTool(goPair.client, "causoryn_workspace_summary");
        const envelope = expectEnvelope(result);
        expect((envelope.coverage as Record<string, unknown>).tier).toBe("L1");
        expect((envelope.data as Record<string, unknown>).languages).toEqual([
          { language: "typescript", files: 1 },
          { language: "go", files: 1 },
        ]);
      } finally {
        await goPair.close();
      }

      const rustContext = contextWithPublishedSnapshot({
        workspaceId: "default",
        revision: { id: "working-tree", sequence: 1 },
        configHash: "cfg-rs",
        analyzerFingerprint: "rs@0.1.0",
        state: "ready",
        createdAt: "2026-11-18T00:00:00.000Z",
        nodes: [
          { kind: "Workspace", qualifiedName: "default" },
          {
            kind: "File",
            qualifiedName: "src/lib.rs",
            relativePath: "src/lib.rs",
            language: "rust",
          },
          {
            kind: "Function",
            qualifiedName: "orders::create",
            relativePath: "src/lib.rs",
            language: "rust",
          },
        ],
        edges: [],
      });

      const rustPair = await connectClient(rustContext);
      try {
        const result = await callTool(rustPair.client, "causoryn_workspace_summary");
        const envelope = expectEnvelope(result);
        expect((envelope.coverage as Record<string, unknown>).tier).toBe("L1");
        expect((envelope.data as Record<string, unknown>).languages).toEqual([
          { language: "rust", files: 1 },
        ]);
      } finally {
        await rustPair.close();
      }
    });

    it("L0 degrade workspace_summary ve coverageOf: yalnızca Workspace + File (+ UnknownExternal) varken tier=L0 ve diller INDEXED_ADAPTERS sırasındadır", async () => {
      const degradedContext = contextWithPublishedSnapshot({
        workspaceId: "default",
        revision: { id: "working-tree", sequence: 1 },
        configHash: "cfg-l0",
        analyzerFingerprint: "fallback@0.1.0",
        state: "partial",
        createdAt: "2026-11-18T00:00:00.000Z",
        nodes: [
          { kind: "Workspace", qualifiedName: "default" },
          {
            kind: "File",
            qualifiedName: "cmd/main.go",
            relativePath: "cmd/main.go",
            language: "go",
          },
          {
            kind: "File",
            qualifiedName: "src/app.py",
            relativePath: "src/app.py",
            language: "python",
          },
          {
            kind: "File",
            qualifiedName: "src/Api.cs",
            relativePath: "src/Api.cs",
            language: "csharp",
          },
          {
            kind: "File",
            qualifiedName: "src/index.ts",
            relativePath: "src/index.ts",
            language: "typescript",
          },
          {
            kind: "UnknownExternal",
            qualifiedName: "external.dep",
            language: "python",
          },
          {
            kind: "UnknownExternal",
            qualifiedName: "external.ts.dep",
            language: "typescript",
          },
        ],
        edges: [],
      });

      const degradedPublished = degradedContext.repository.getLatestPublished("default");
      expect(coverageOf(degradedPublished!.snapshot).tier).toBe("L0");

      const pair = await connectClient(degradedContext);
      try {
        const result = await callTool(pair.client, "causoryn_workspace_summary");
        const envelope = expectEnvelope(result);
        expect((envelope.coverage as Record<string, unknown>).tier).toBe("L0");
        expect((envelope.data as Record<string, unknown>).languages).toEqual([
          { language: "typescript", files: 1 },
          { language: "csharp", files: 1 },
          { language: "python", files: 1 },
          { language: "go", files: 1 },
        ]);
      } finally {
        await pair.close();
      }
    });

    it("çok-dil deterministik sıralama: INDEXED_ADAPTERS sırası + katalog dışı UTF-16 artan sıra; fixture-ts-orders files=5 korunur", async () => {
      const polyglotContext = contextWithPublishedSnapshot({
        workspaceId: "default",
        revision: { id: "working-tree", sequence: 1 },
        configHash: "cfg-poly",
        analyzerFingerprint: "poly@0.1.0",
        state: "ready",
        createdAt: "2026-11-18T00:00:00.000Z",
        nodes: [
          { kind: "Workspace", qualifiedName: "default" },
          { kind: "File", qualifiedName: "src/lib.rs", relativePath: "src/lib.rs", language: "rust" },
          { kind: "File", qualifiedName: "src/main.zig", relativePath: "src/main.zig", language: "zig" },
          { kind: "File", qualifiedName: "src/a.py", relativePath: "src/a.py", language: "python" },
          { kind: "File", qualifiedName: "src/b.py", relativePath: "src/b.py", language: "python" },
          { kind: "File", qualifiedName: "src/App.java", relativePath: "src/App.java", language: "java" },
          { kind: "File", qualifiedName: "src/index.ts", relativePath: "src/index.ts", language: "typescript" },
          { kind: "File", qualifiedName: "cmd/main.go", relativePath: "cmd/main.go", language: "go" },
          { kind: "File", qualifiedName: "src/Api.cs", relativePath: "src/Api.cs", language: "csharp" },
          { kind: "File", qualifiedName: "README.md", relativePath: "README.md" },
        ],
        edges: [],
      });

      const polyPair = await connectClient(polyglotContext);
      try {
        const result = await callTool(polyPair.client, "causoryn_workspace_summary");
        const envelope = expectEnvelope(result);
        expect((envelope.coverage as Record<string, unknown>).tier).toBe("L0");
        const data = envelope.data as Record<string, unknown>;
        expect(data.fileCount).toBe(9);
        expect(data.languages).toEqual([
          { language: "typescript", files: 1 },
          { language: "csharp", files: 1 },
          { language: "python", files: 2 },
          { language: "go", files: 1 },
          { language: "rust", files: 1 },
          { language: "java", files: 1 },
          { language: "zig", files: 1 },
        ]);
      } finally {
        await polyPair.close();
      }

      const tsPair = await connectClient(makeContext());
      try {
        const result = await callTool(tsPair.client, "causoryn_workspace_summary");
        const envelope = expectEnvelope(result);
        expect((envelope.coverage as Record<string, unknown>).tier).toBe("L2");
        expect((envelope.data as Record<string, unknown>).languages).toEqual([
          { language: "typescript", files: 5 },
        ]);
      } finally {
        await tsPair.close();
      }
    });
  },
);
