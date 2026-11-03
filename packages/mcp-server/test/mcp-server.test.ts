import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * MCP server protokol düzeyi test üçlüleri (TŞ v2.1 §10, §25/6; sprint-1
 * görev 6). SDK 1.32.2 InMemoryTransport + Client ile:
 * - initialize + tools/list (tam olarak 4 araç; her biri inputSchema +
 *   outputSchema taşır),
 * - her araç için pozitif tools/call (fixture workspace),
 * - negatif: yetkisiz workspace → WORKSPACE_NOT_AUTHORIZED, geçersiz
 *   argüman → INVALID_ARGUMENT, INDEX_NOT_READY, LIMIT_EXCEEDED,
 *   AMBIGUOUS_SYMBOL,
 * - partial: boş workspace coverage.
 *
 * Envelope sözleşmesi (wiki/mcp-tools.md + TŞ §10.1): schemaVersion,
 * requestId, workspaceId, snapshotId, status, coverage, warnings, data,
 * nextCursor + sabit hata kodları. Testler salt okunurdur (ADR-008);
 * geçici fixture'lar yalnızca os.tmpdir() altında yaşar.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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

  it("tools/list: tam olarak 4 araç; her biri inputSchema + outputSchema taşır", async () => {
    const pair = await connectClient(makeContext());
    try {
      const { tools } = await pair.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      expect(TOOL_NAMES).toEqual([
        "causoryn_get_capabilities",
        "causoryn_workspace_summary",
        "causoryn_map_system",
        "causoryn_find_symbols",
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
      expect(ts?.levels).toEqual({ astParse: "L1", symbolResolution: "L2", frameworkLinkers: "yok" });
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
      // Framework tespiti Faz A'da boş; alan mevcut (TŞ §10.2 summary).
      expect(Array.isArray(data.frameworks)).toBe(true);
      const languages = data.languages as Array<Record<string, unknown>>;
      const tsLanguage = languages.find((l) => l.language === "typescript");
      expect((tsLanguage?.files as number)).toBeGreaterThan(0);
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

  it("hata kodu seti sabittir (TŞ §10.1 + tek proje uzantısı INVALID_ARGUMENT)", () => {
    // TŞ §10.1 listesinde INVALID_ARGUMENT YOKTUR; görev sözleşmesi geçersiz
    // girdi için sabit bir envelope kodu istediği üzere proje uzantısı
    // olarak dahil edilmiştir (bkz. src/errors.ts başlığı).
    expect([...CAUSORYN_TOOL_ERROR_CODES].sort()).toEqual(
      [
        "WORKSPACE_NOT_AUTHORIZED",
        "PATH_DENIED",
        "INDEX_NOT_READY",
        "AMBIGUOUS_SYMBOL",
        "LIMIT_EXCEEDED",
        "INVALID_ARGUMENT",
        "UNSUPPORTED_LANGUAGE",
        "INTERNAL_ERROR",
      ].sort(),
    );
  });
});
