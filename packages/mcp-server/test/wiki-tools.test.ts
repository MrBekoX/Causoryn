import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { canonicalJson, sha256Hex, utf8Encode } from "@causoryn/domain";
import type { SqliteWikiStore } from "@causoryn/storage-sqlite";
import { WikiStoreError } from "@causoryn/storage-sqlite";
import { WikiProjectionError } from "@causoryn/wiki";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Wiki 7 araç MCP yüzeyi testleri — sprint-4 W5.
 *
 * Kanıt: TŞ v2.1 §16A.8 (s.17 — 7 araç tablosu: wiki_build yazma izni
 * "yalnızca izinli Causoryn data-root'a", diğer altısı salt okunur; standart
 * envelope + cursor/limit) · §16A.1 (taksonomi/no_data) · §16A.2 (linkler +
 * broken-link diagnostics) · §16A.3 (arama sıralaması: exact sembol/route >
 * başlık > modül > BM25 > yakınlık) · §16A.4 (get_versions + diff alan
 * kümesi) · §16A.10 (kabul: iki snapshot diff'i; exact route üstünlüğü) ·
 * K-013 kararları (wiki/decisions.md): mode=full|incremental, cursor
 * default 50/max 200, bozuk link toPageId=null + diagnostics,
 * get_versions alias çözümlemesi git-read ile (çözülemeyen →
 * INVALID_REVISION), contractChanges Faz D'ye kadar [] + degrade notu.
 *
 * Her araç için pozitif + negatif + partial üçlüsü (sprint-1 kuralı).
 * Wiki yazımı YALNIZCA os.tmpdir() altındaki izinli data-root SQLite
 * dosyasına gider (config wiki.dataDbPath beyanı); examples/fixture-ts-orders
 * salt okunur kullanılır (ADR-008). Diff testi fixture'ın os.tmpdir()
 * kopyası üzerinde çalışır — örnek fixture'a ASLA yazılmaz.
 */

import {
  CausorynConfigError,
  EnvelopeSchema,
  TOOL_NAMES,
  createCausorynContext,
  createCausorynMcpServer,
} from "../src/index.js";
import type { CausorynContext } from "../src/index.js";
import { wikiErrorToToolError } from "../src/services-wiki.js";
import type { ServiceDeps } from "../src/services.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");

/** Sabit saat: WikiSnapshot.builtAt determinizm testinin çapası. */
const FIXED_NOW = "2026-11-07T10:00:00.000Z";
const fixedClock = (): string => FIXED_NOW;

interface ClientPair {
  readonly client: Client;
  readonly context: CausorynContext;
  readonly close: () => Promise<void>;
}

/** Context'i SDK InMemory transport üzerinden bir Client'a bağlar. */
async function connectClient(context: CausorynContext): Promise<ClientPair> {
  const server = createCausorynMcpServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "vitest-wiki-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    context,
    close: async () => {
      await client.close();
      await server.close();
      // Wiki SQLite bağlantılarını kapat (Windows: açık tanıtıcı tmp
      // dizin silimini EPERM ile bloklar).
      context.close();
    },
  };
}

function makeContext(
  configOverrides: Record<string, unknown> = {},
  overrides: { readonly clock?: () => string } = {},
): CausorynContext {
  return createCausorynContext(
    {
      workspaceId: "default",
      allowRoots: [FIXTURE_ROOT],
      results: { maxNodes: 250, maxSymbols: 100 },
      autoIndex: true,
      wiki: { dataDbPath: path.join(tempRoot, "wiki-data.sqlite") },
      ...configOverrides,
    },
    { clock: fixedClock, ...overrides },
  );
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
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

function expectErrorOf(result: CallToolResult): Record<string, unknown> {
  const envelope = expectEnvelope(result);
  expect(envelope.status).toBe("error");
  const error = envelope.error as Record<string, unknown>;
  expect(typeof error.code).toBe("string");
  expect(typeof error.retryable).toBe("boolean");
  expect((error.userAction as string).length).toBeGreaterThan(0);
  return error;
}

/** wiki_build çağırır ve data gövdesini döndürür. */
async function buildWiki(
  client: Client,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await callTool(client, "causoryn_wiki_build", {
    mode: "full",
    ...args,
  });
  const envelope = expectEnvelope(result);
  expect(envelope.status).toBe("ok");
  return envelope.data as Record<string, unknown>;
}

/** Taksonomi sayfa kimliği türetimi (packages/wiki/src/projection.ts
 * deterministicId ile aynı kural: page:sha256(canonicalJson(parts))). */
function expectedRootPageId(key: string, kind: string): string {
  return `page:${sha256Hex(utf8Encode(canonicalJson(["default", "root", key, kind])))}`;
}

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-wiki-tools-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Katalog — 23 araç                                                   */
/* ------------------------------------------------------------------ */

describe("Wiki araç katalogu", { timeout: 60_000 }, () => {
  it("TOOL_NAMES 23 araçtır; 7 Wiki aracı TŞ §16A.8 sırasıyla sondadır", () => {
    expect(TOOL_NAMES).toHaveLength(23);
    expect(TOOL_NAMES.slice(16)).toEqual([
      "causoryn_wiki_build",
      "causoryn_wiki_get_tree",
      "causoryn_wiki_get_page",
      "causoryn_wiki_search",
      "causoryn_wiki_get_links",
      "causoryn_wiki_get_versions",
      "causoryn_wiki_diff",
    ]);
  });

  it("pozitif: tools/list 7 wiki aracını input/output şemalarıyla yayınlar", async () => {
    const pair = await connectClient(makeContext());
    try {
      const { tools } = await pair.client.listTools();
      const names = tools.map((tool) => tool.name);
      for (const name of TOOL_NAMES.slice(16)) {
        const tool = tools.find((entry) => entry.name === name);
        expect(tool, `${name} tools/list'te yok`).toBeDefined();
        expect(tool?.inputSchema).toBeDefined();
        expect(tool?.outputSchema).toBeDefined();
        expect((tool?.description ?? "").length).toBeGreaterThan(0);
      }
      expect(names.length).toBe(23);
    } finally {
      await pair.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* causoryn_wiki_build                                                 */
/* ------------------------------------------------------------------ */

describe("causoryn_wiki_build", { timeout: 60_000 }, () => {
  it("pozitif: fixture workspace'ten gerçek projeksiyon izinli data-root'a yazılır; kimlik deterministiktir; data.warnings doldurulur", async () => {
    const first = await connectClient(makeContext());
    try {
      const buildResult = await callTool(first.client, "causoryn_wiki_build", {
        mode: "full",
      });
      const envelope = expectEnvelope(buildResult);
      const dataOne = envelope.data as Record<string, unknown>;
      expect(String(dataOne.wikiSnapshotId)).toMatch(/^wiki:[0-9a-f]{64}$/);
      expect(String(dataOne.graphSnapshotId)).toMatch(/^snapshot:/);
      expect(dataOne.status === "ready" || dataOne.status === "partial").toBe(true);
      expect(Number(dataOne.pagesRegenerated)).toBeGreaterThan(0);
      expect(Number(dataOne.sectionsRegenerated)).toBeGreaterThan(0);
      expect(Number(dataOne.brokenLinks)).toBe(0);
      // TŞ §16A.8: evidence coverage döner (envelope.coverage).
      // wiki-spec §4.2.1 çıktısındaki warnings alanı daima-boş DEĞİLDİR:
      // gerçek uyarılarla doldurulur (takım denetimi bulgusu 8).
      expect(JSON.stringify(dataOne.warnings)).toBe(
        JSON.stringify(envelope.warnings),
      );
      const wikiOneId = String(dataOne.wikiSnapshotId);

      // Aynı giriş + aynı saat → aynı WikiSnapshot kimliği (ikinci bağımsız
      // veri kökü; TŞ §8 invariant vi).
      const second = await connectClient(
        makeContext({ wiki: { dataDbPath: path.join(tempRoot, "wiki-data-2.sqlite") } }),
      );
      try {
        const dataTwo = await buildWiki(second.client);
        expect(String(dataTwo.wikiSnapshotId)).toBe(wikiOneId);
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });

  it("pozitif: aynı graph snapshot için ikinci build idempotent no-op olur (UNIQUE publish çökmesi yerine dürüst rapor)", async () => {
    const pair = await connectClient(makeContext());
    try {
      const first = await buildWiki(pair.client);
      const secondResult = await callTool(pair.client, "causoryn_wiki_build", {
        mode: "full",
      });
      const envelope = expectEnvelope(secondResult);
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      expect(data.wikiSnapshotId).toBe(first.wikiSnapshotId);
      expect(Number(data.pagesRegenerated)).toBe(0);
      const warnings = envelope.warnings as string[];
      expect(warnings.some((warning) => warning.includes("idempotent"))).toBe(true);
      // data.warnings daima-boş değil: idempotent bildirimi taşır (bulgu 8).
      expect(JSON.stringify(data.warnings)).toBe(JSON.stringify(envelope.warnings));
      expect((data.warnings as string[]).length).toBeGreaterThan(0);
    } finally {
      await pair.close();
    }
  });

  it("negatif: scope INVALID_ARGUMENT; yabancı workspace WORKSPACE_NOT_AUTHORIZED (mode=incremental artık geçerli moddur — denetim bulgusu 3; davranışı wiki-build-incremental.test.ts kanıtlar)", async () => {
    const pair = await connectClient(makeContext());
    try {
      const scoped = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_build", {
          mode: "full",
          scope: "src/services",
        }),
      );
      expect(scoped.code).toBe("INVALID_ARGUMENT");

      const foreign = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_build", {
          mode: "full",
          workspaceId: "baska-workspace",
        }),
      );
      expect(foreign.code).toBe("WORKSPACE_NOT_AUTHORIZED");
    } finally {
      await pair.close();
    }
  });

  it("negatif: yayınlanmış graph snapshot yoksa INDEX_NOT_READY; izinli data-root beyanı yoksa yazma reddi", async () => {
    const noIndex = await connectClient(makeContext({ autoIndex: false }));
    try {
      const error = expectErrorOf(
        await callTool(noIndex.client, "causoryn_wiki_build", { mode: "full" }),
      );
      expect(error.code).toBe("INDEX_NOT_READY");
    } finally {
      await noIndex.close();
    }

    const noDataRoot = await connectClient(
      makeContext({ wiki: { dataDbPath: undefined } }),
    );
    try {
      const error = expectErrorOf(
        await callTool(noDataRoot.client, "causoryn_wiki_build", { mode: "full" }),
      );
      expect(error.code).toBe("PATH_DENIED");
      expect(String(error.message)).toContain("wiki.dataDbPath");
    } finally {
      await noDataRoot.close();
    }
  });

  it("negatif: wiki.dataDbPath göreli yol / workspace kökü içinde → sunucu başlamaz (CausorynConfigError)", () => {
    expect(
      () =>
        createCausorynContext(
          {
            workspaceId: "default",
            allowRoots: [FIXTURE_ROOT],
            autoIndex: false,
            wiki: { dataDbPath: "goreli/wiki.sqlite" },
          },
          { clock: fixedClock },
        ),
    ).toThrow(CausorynConfigError);

    expect(
      () =>
        createCausorynContext(
          {
            workspaceId: "default",
            allowRoots: [FIXTURE_ROOT],
            autoIndex: false,
            wiki: { dataDbPath: path.join(FIXTURE_ROOT, "wiki.sqlite") },
          },
          { clock: fixedClock },
        ),
    ).toThrow(/workspace/i);
  });

  it("negatif: publishWiki hatasında building satırı failed'a kapanır (kalıcı build-already-active kilidi YOK — takım denetimi bulgusu 4)", async () => {
    const context = makeContext();
    const realStore = context.wikiStore as SqliteWikiStore;
    const failCalls: number[] = [];
    const sabotage = {
      beginWikiBuild: (
        ...args: Parameters<SqliteWikiStore["beginWikiBuild"]>
      ) => realStore.beginWikiBuild(...args),
      addWikiPage: (
        ...args: Parameters<SqliteWikiStore["addWikiPage"]>
      ) => realStore.addWikiPage(...args),
      addWikiPageSection: (
        ...args: Parameters<SqliteWikiStore["addWikiPageSection"]>
      ) => realStore.addWikiPageSection(...args),
      addWikiLink: (...args: Parameters<SqliteWikiStore["addWikiLink"]>) =>
        realStore.addWikiLink(...args),
      addWikiPageVersion: (
        ...args: Parameters<SqliteWikiStore["addWikiPageVersion"]>
      ) => realStore.addWikiPageVersion(...args),
      indexWikiFts: (
        ...args: Parameters<SqliteWikiStore["indexWikiFts"]>
      ) => realStore.indexWikiFts(...args),
      publishWiki: (): never => {
        throw new WikiStoreError(
          "wiki/publish-failed",
          "sabotaj: test publish hatası",
        );
      },
      failWikiBuild: (
        ...args: Parameters<SqliteWikiStore["failWikiBuild"]>
      ) => {
        failCalls.push(args[0] as number);
        return realStore.failWikiBuild(...args);
      },
      readWikiSnapshot: (
        ...args: Parameters<SqliteWikiStore["readWikiSnapshot"]>
      ) => realStore.readWikiSnapshot(...args),
      getLatestPublishedWiki: (
        ...args: Parameters<SqliteWikiStore["getLatestPublishedWiki"]>
      ) => realStore.getLatestPublishedWiki(...args),
      searchWiki: (...args: Parameters<SqliteWikiStore["searchWiki"]>) =>
        realStore.searchWiki(...args),
    } as unknown as SqliteWikiStore;
    const sabotaged = { ...context, wikiStore: sabotage } as unknown as CausorynContext;
    const server = createCausorynMcpServer(sabotaged);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "publish-sabotage", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const error = expectErrorOf(
        await callTool(client, "causoryn_wiki_build", { mode: "full" }),
      );
      expect(error.code).toBe("INTERNAL_ERROR");
      // Düzeltme sonrası: publish hatasında da building satırı kapanır.
      expect(failCalls).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
      context.close();
    }

    // Kilitsizlik kanıtı: AYNI veri kökünde sağlıklı context ile yeni build
    // başarılı olmalı (wiki/build-already-active kalıcı kilit yok).
    const healthy = await connectClient(makeContext());
    try {
      const data = await buildWiki(healthy.client);
      expect(String(data.wikiSnapshotId)).toMatch(/^wiki:[0-9a-f]{64}$/);
      expect(Number(data.pagesRegenerated)).toBeGreaterThan(0);
    } finally {
      await healthy.close();
    }
  });

  it("negatif: beyanlı SQLite dosyası workspace köküne sembolik bağ ise sunucu başlamaz (takım denetimi bulgusu 5)", () => {
    // Gerçek içerik workspace kökÜNDE; beyanlı veri kökü yolu kök DIŞINDAN
    // o dosyaya sembolik bağdır — yazım kaynak ağacına sızardı.
    const wsRoot = path.join(tempRoot, "ws-symlink");
    mkdirSync(wsRoot, { recursive: true });
    const innerDb = path.join(wsRoot, "ic-gercek.sqlite");
    writeFileSync(innerDb, "", "utf8");
    const linkPath = path.join(tempRoot, "dis-bagli.sqlite");
    symlinkSync(innerDb, linkPath, "file");
    expect(() =>
      createCausorynContext(
        {
          workspaceId: "default",
          allowRoots: [wsRoot],
          autoIndex: false,
          wiki: { dataDbPath: linkPath },
        },
        { clock: fixedClock },
      ),
    ).toThrow(CausorynConfigError);
  });

  it("partial: kaynak graph partial ise WikiSnapshot partial yayımlanır ve uyarılar taşınır (K-013 #1)", async () => {
    // Analiz edilebilir kaynak içermeyen boş kök → graph partial publish.
    const emptyRoot = path.join(tempRoot, "empty-workspace");
    mkdirSync(path.join(emptyRoot, "docs"), { recursive: true });
    writeFileSync(path.join(emptyRoot, "docs", "notlar.md"), "# not\n", "utf8");
    const pair = await connectClient(
      makeContext({ allowRoots: [emptyRoot] }),
    );
    try {
      const result = await callTool(pair.client, "causoryn_wiki_build", {
        mode: "full",
      });
      const envelope = expectEnvelope(result);
      const data = envelope.data as Record<string, unknown>;
      expect(data.status).toBe("partial");
      // no_data dürüstlüğü: içerik uydurulmaz; uyarı yüzeyi boş kategori
      // raporunu taşır (TŞ §16A.1).
      expect(Array.isArray(envelope.warnings)).toBe(true);
    } finally {
      await pair.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* causoryn_wiki_get_tree                                              */
/* ------------------------------------------------------------------ */

async function connectWithWiki(): Promise<ClientPair> {
  const pair = await connectClient(makeContext());
  await buildWiki(pair.client);
  return pair;
}

describe("causoryn_wiki_get_tree", { timeout: 60_000 }, () => {
  it("pozitif: 12 kök kategori taksonomi sırasıyla döner; childCount ve overview pageId türetimi doğru", async () => {
    const pair = await connectWithWiki();
    try {
      const envelope = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_tree", {}),
      );
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      expect(String(data.wikiSnapshotId)).toMatch(/^wiki:/);
      expect(typeof data.graphSnapshotId).toBe("string");
      expect(data.stale).toBe(false);
      const nodes = data.nodes as Array<Record<string, unknown>>;
      expect(nodes.length).toBeGreaterThanOrEqual(12);
      // İlk 12 satır kök kategoriler (taksonomi sırası; TŞ §16A.1 ağacı).
      expect(nodes.slice(0, 12).map((node) => node.pageId)).toEqual([
        expectedRootPageId("overview", "overview"),
        expectedRootPageId("architecture", "architecture"),
        expectedRootPageId("projects-modules", "project"),
        expectedRootPageId("apis-entry-points", "api"),
        expectedRootPageId("business-flows", "business_flow"),
        expectedRootPageId("events-integrations", "event"),
        expectedRootPageId("data-schemas", "data"),
        expectedRootPageId("contracts-policies", "contract"),
        expectedRootPageId("tests-quality", "test"),
        expectedRootPageId("architecture-timeline", "timeline"),
        expectedRootPageId("onboarding", "onboarding"),
        expectedRootPageId("unresolved-coverage", "coverage"),
      ]);
      // Fixture'ta endpoint sayfası vardır: APIs & Entry Points çocuğu.
      const apisRoot = nodes.find(
        (node) => node.pageId === expectedRootPageId("apis-entry-points", "api"),
      );
      expect(Number(apisRoot?.childCount)).toBeGreaterThanOrEqual(1);
      // no_data kategorisi dolgusuz listelenir (business_flows: structural
      // no_data — TŞ §16A.1 "boş kategori doldurulmaz").
      const flowsRoot = nodes.find(
        (node) => node.pageId === expectedRootPageId("business-flows", "business_flow"),
      );
      const coverage = flowsRoot?.coverage as Record<string, unknown>;
      expect(coverage.status).toBe("no_data");
    } finally {
      await pair.close();
    }
  });

  it("negatif: yabancı workspace WORKSPACE_NOT_AUTHORIZED; bilinmeyen parentId EVIDENCE_NOT_FOUND; limit 201 LIMIT_EXCEEDED; bozuk cursor INVALID_ARGUMENT", async () => {
    const pair = await connectWithWiki();
    try {
      const foreign = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_get_tree", {
          workspaceId: "baska-workspace",
        }),
      );
      expect(foreign.code).toBe("WORKSPACE_NOT_AUTHORIZED");

      const missingParent = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_get_tree", {
          parentId: "page:olmayan",
        }),
      );
      // TŞ §10.1 sabit kodu (s.9): wiki sayfa kimliği bulunamadı.
      expect(missingParent.code).toBe("WIKI_PAGE_NOT_FOUND");

      const overLimit = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_get_tree", { limit: 201 }),
      );
      expect(overLimit.code).toBe("LIMIT_EXCEEDED");

      const badCursor = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_get_tree", { cursor: "!!!" }),
      );
      expect(badCursor.code).toBe("INVALID_ARGUMENT");
    } finally {
      await pair.close();
    }
  });

  it("partial: limit+cursor sayfalama deterministik ilerler; envelope-düzeyi nextCursor data ile eşittir; wiki storage beyanı yoksa INDEX_NOT_READY", async () => {
    const pair = await connectWithWiki();
    try {
      const first = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_tree", { limit: 3 }),
      );
      const firstData = first.data as Record<string, unknown>;
      const firstNodes = firstData.nodes as Array<Record<string, unknown>>;
      expect(firstNodes).toHaveLength(3);
      const cursorOne = firstData.nextCursor as string | null;
      expect(cursorOne).not.toBeNull();
      // Takım denetimi bulgusu 3: TŞ §10.1 standart envelope nextCursor'u
      // data.nextCursor ile aynı değeri taşır (map_system önceli).
      expect(first.nextCursor).toBe(cursorOne);

      const second = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_tree", {
          limit: 3,
          cursor: cursorOne as string,
        }),
      );
      const secondData = second.data as Record<string, unknown>;
      const secondNodes = secondData.nodes as Array<Record<string, unknown>>;
      expect(secondNodes).toHaveLength(3);
      expect(secondNodes[0]?.pageId).not.toBe(firstNodes[0]?.pageId);
      expect(String(secondData.wikiSnapshotId)).toBe(
        String(firstData.wikiSnapshotId),
      );
      expect(second.nextCursor).toBe(secondData.nextCursor);

      // Tam sayfa (limit tavanı altında toplam): her iki düzeyde de null.
      const full = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_tree", {}),
      );
      expect(full.nextCursor).toBeNull();
      expect((full.data as Record<string, unknown>).nextCursor).toBeNull();
    } finally {
      await pair.close();
    }

    const noStore = await connectClient(
      makeContext({ wiki: { dataDbPath: undefined } }),
    );
    try {
      const error = expectErrorOf(
        await callTool(noStore.client, "causoryn_wiki_get_tree", {}),
      );
      expect(error.code).toBe("INDEX_NOT_READY");
    } finally {
      await noStore.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* causoryn_wiki_get_page                                              */
/* ------------------------------------------------------------------ */

describe("causoryn_wiki_get_page", { timeout: 60_000 }, () => {
  it("pozitif: overview sayfası bölümleri + provenance ile okunur; api sayfası route/handler bölümleri taşır", async () => {
    const pair = await connectWithWiki();
    try {
      const overview = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_page", {
          pageId: expectedRootPageId("overview", "overview"),
        }),
      );
      expect(overview.status).toBe("ok");
      const overviewData = overview.data as Record<string, unknown>;
      const page = overviewData.page as Record<string, unknown>;
      expect(page.title).toBe("Overview");
      expect(page.kind).toBe("overview");
      expect(page.parentId).toBeNull();
      expect(String(overviewData.wikiSnapshotId)).toMatch(/^wiki:/);
      expect(typeof overviewData.graphSnapshotId).toBe("string");
      expect(overviewData.stale).toBe(false);
      const sections = overviewData.sections as Array<Record<string, unknown>>;
      expect(sections.map((section) => section.sectionKey)).toContain("summary");
      expect(Array.isArray(overviewData.sourceRefs)).toBe(true);

      // Fixture endpoint sayfası: tree'den bulunur.
      const tree = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_tree", {}),
      );
      const treeNodes = (tree.data as Record<string, unknown>).nodes as Array<
        Record<string, unknown>
      >;
      const apisRoot = treeNodes.find(
        (node) => node.pageId === expectedRootPageId("apis-entry-points", "api"),
      );
      const apiNode = treeNodes.find(
        (node) =>
          node.parentId === expectedRootPageId("apis-entry-points", "api") &&
          (apisRoot?.childCount as number) > 0,
      );
      expect(apiNode).toBeDefined();

      const apiPage = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_page", {
          pageId: apiNode?.pageId,
        }),
      );
      const apiData = apiPage.data as Record<string, unknown>;
      const apiPageBody = apiData.page as Record<string, unknown>;
      expect(apiPageBody.kind).toBe("api");
      const apiSections = apiData.sections as Array<Record<string, unknown>>;
      expect(apiSections.map((section) => section.sectionKey)).toEqual([
        "route",
        "handler",
      ]);
    } finally {
      await pair.close();
    }
  });

  it("negatif: bilinmeyen pageId EVIDENCE_NOT_FOUND; yabancı workspace WORKSPACE_NOT_AUTHORIZED", async () => {
    const pair = await connectWithWiki();
    try {
      const missing = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_get_page", {
          pageId: "page:olmayan",
        }),
      );
      // TŞ §10.1 sabit kodu (s.9): wiki sayfa kimliği bulunamadı.
      expect(missing.code).toBe("WIKI_PAGE_NOT_FOUND");

      const foreign = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_get_page", {
          pageId: expectedRootPageId("overview", "overview"),
          workspaceId: "baska-workspace",
        }),
      );
      expect(foreign.code).toBe("WORKSPACE_NOT_AUTHORIZED");
    } finally {
      await pair.close();
    }
  });

  it("partial: sections filtresi + bölüm sayfalama (limit 1, cursor zinciri) deterministiktir", async () => {
    const pair = await connectWithWiki();
    try {
      const tree = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_tree", {}),
      );
      const treeNodes = (tree.data as Record<string, unknown>).nodes as Array<
        Record<string, unknown>
      >;
      const apiNode = treeNodes.find(
        (node) => node.parentId === expectedRootPageId("apis-entry-points", "api"),
      );
      expect(apiNode).toBeDefined();

      const filtered = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_page", {
          pageId: apiNode?.pageId,
          sections: ["route"],
        }),
      );
      const filteredData = filtered.data as Record<string, unknown>;
      const filteredSections = filteredData.sections as Array<
        Record<string, unknown>
      >;
      expect(filteredSections).toHaveLength(1);
      expect(filteredSections[0]?.sectionKey).toBe("route");
      // sectionsTotal sayfalama tabanıdır: FİLTRELENMİŞ bölüm sayısı.
      expect(Number(filteredData.sectionsTotal)).toBe(1);

      const pageOne = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_page", {
          pageId: apiNode?.pageId,
          limit: 1,
        }),
      );
      const pageOneData = pageOne.data as Record<string, unknown>;
      expect((pageOneData.sections as unknown[]).length).toBe(1);
      const cursor = pageOneData.nextCursor as string | null;
      expect(cursor).not.toBeNull();

      const pageTwo = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_page", {
          pageId: apiNode?.pageId,
          limit: 1,
          cursor,
        }),
      );
      const pageTwoData = pageTwo.data as Record<string, unknown>;
      const pageTwoSections = pageTwoData.sections as Array<Record<string, unknown>>;
      expect(pageTwoSections).toHaveLength(1);
      expect(pageTwoSections[0]?.sectionKey).not.toBe(
        (pageOneData.sections as Array<Record<string, unknown>>)[0]?.sectionKey,
      );
      expect(pageTwoData.nextCursor).toBeNull();
    } finally {
      await pair.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* causoryn_wiki_search                                                */
/* ------------------------------------------------------------------ */

describe("causoryn_wiki_search", { timeout: 60_000 }, () => {
  it("pozitif: exact route sorgusu ('post /orders') endpoint sayfasını ilk sıraya koyar; matchedFields + evidenceIds döner (TŞ §16A.10 arama kabulü)", async () => {
    const pair = await connectWithWiki();
    try {
      const tree = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_tree", {}),
      );
      const treeNodes = (tree.data as Record<string, unknown>).nodes as Array<
        Record<string, unknown>
      >;
      const apiNode = treeNodes.find(
        (node) => node.parentId === expectedRootPageId("apis-entry-points", "api"),
      );
      expect(apiNode).toBeDefined();

      const result = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_search", {
          query: "post /orders",
        }),
      );
      expect(result.status).toBe("ok");
      const data = result.data as Record<string, unknown>;
      expect(data.stale).toBe(false);
      expect(String(data.matchExpression)).toBe('"post /orders"');
      expect(Number(data.totalMatches)).toBeGreaterThanOrEqual(1);
      const hits = data.hits as Array<Record<string, unknown>>;
      expect(hits.length).toBeGreaterThanOrEqual(1);
      // Exact route eşleşmesi genel FTS eşleşmesinin ÜSTÜNDE döner.
      expect(hits[0]?.pageId).toBe(apiNode?.pageId);
      const matchedFields = hits[0]?.matchedFields as string[];
      expect(Array.isArray(matchedFields)).toBe(true);
      expect(matchedFields.length).toBeGreaterThan(0);
      expect(Array.isArray(hits[0]?.evidenceIds)).toBe(true);
      expect(typeof hits[0]?.snippet).toBe("string");
      expect(data.nextCursor).toBeNull();
      // Takım denetimi bulgusu 3: envelope-düzeyi nextCursor data ile aynı
      // (sayfalı aramada da aynı yerleşim sözleşmesi).
      expect(result.nextCursor).toBe(data.nextCursor);
    } finally {
      await pair.close();
    }
  });

  it("negatif: boş sorgu INVALID_ARGUMENT; bozuk cursor INVALID_ARGUMENT; limit 201 LIMIT_EXCEEDED; beyanlı ama desteklenmeyen filtre INVALID_ARGUMENT", async () => {
    const pair = await connectWithWiki();
    try {
      const empty = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_search", { query: "   " }),
      );
      expect(empty.code).toBe("INVALID_ARGUMENT");

      const badCursor = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_search", {
          query: "orders",
          cursor: "!!!",
        }),
      );
      expect(badCursor.code).toBe("INVALID_ARGUMENT");

      const overLimit = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_search", {
          query: "orders",
          limit: 201,
        }),
      );
      expect(overLimit.code).toBe("LIMIT_EXCEEDED");

      const kindsFilter = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_search", {
          query: "orders",
          kinds: ["api"],
        }),
      );
      expect(kindsFilter.code).toBe("INVALID_ARGUMENT");
    } finally {
      await pair.close();
    }
  });

  it("partial: eşleşme yokken boş sonuç dürüst döner; yakınlık ayağı yoksa skippedRankLegs degrade notu taşınır", async () => {
    const pair = await connectWithWiki();
    try {
      const noMatch = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_search", {
          query: "zzzz-hiclik-aranmaz",
        }),
      );
      const noMatchData = noMatch.data as Record<string, unknown>;
      expect(Number(noMatchData.totalMatches)).toBe(0);
      expect((noMatchData.hits as unknown[]).length).toBe(0);
      expect(noMatchData.nextCursor).toBeNull();

      const ranked = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_search", { query: "orders" }),
      );
      const rankedData = ranked.data as Record<string, unknown>;
      expect(rankedData.skippedRankLegs).toEqual(["graphProximity"]);
    } finally {
      await pair.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* causoryn_wiki_get_links                                             */
/* ------------------------------------------------------------------ */

describe("causoryn_wiki_get_links", { timeout: 60_000 }, () => {
  it("pozitif: PARENT_OF outgoing linki hedef sayfanın backlink sorgusunda bulunur; resolution + broken diagnostics taşınır (TŞ §16A.10 çift yönlü kabul)", async () => {
    const pair = await connectWithWiki();
    try {
      const apisRootId = expectedRootPageId("apis-entry-points", "api");
      const rootLinks = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_links", {
          pageId: apisRootId,
          direction: "outgoing",
        }),
      );
      const rootData = rootLinks.data as Record<string, unknown>;
      const outgoing = rootData.outgoing as Array<Record<string, unknown>>;
      expect(outgoing.length).toBeGreaterThanOrEqual(1);
      const parentLink = outgoing.find((link) => link.kind === "PARENT_OF");
      expect(parentLink).toBeDefined();
      expect(String(parentLink?.resolution)).toBe("heuristic");
      expect(Array.isArray(parentLink?.evidenceRefs)).toBe(true);
      const childPageId = String(parentLink?.toPageId);
      expect((rootData.incoming as unknown[]).length).toBe(0);
      expect((rootData.brokenLinkDiagnostics as unknown[]).length).toBe(0);

      // Aynı link hedefin backlink sorgusunda (ADR-013: çift yönlülük
      // türetilir, kopyalanmaz).
      const childLinks = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_links", {
          pageId: childPageId,
        }),
      );
      const childData = childLinks.data as Record<string, unknown>;
      const incoming = childData.incoming as Array<Record<string, unknown>>;
      expect(incoming.map((link) => link.id)).toContain(parentLink?.id);
      expect((childData.outgoing as unknown[]).length).toBe(0);
    } finally {
      await pair.close();
    }
  });

  it("direction girdisi işlevseldir: incoming yalnız gelenleri, outgoing yalnız gidenleri döndürür ve totalMatching'i sınırlar (takım denetimi bulgusu 1)", async () => {
    const pair = await connectWithWiki();
    try {
      const apisRootId = expectedRootPageId("apis-entry-points", "api");

      // Kök sayfada direction=incoming: gidenler MASKELENMELİ (buggy
      // davranışta outgoing+incoming daima birlikte döner).
      const incomingOnly = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_links", {
          pageId: apisRootId,
          direction: "incoming",
        }),
      );
      const incomingData = incomingOnly.data as Record<string, unknown>;
      expect((incomingData.outgoing as unknown[]).length).toBe(0);
      expect(Number(incomingData.totalMatching)).toBe(0);

      // Aynı sayfada direction=outgoing: yalnız gidenler.
      const outgoingOnly = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_links", {
          pageId: apisRootId,
          direction: "outgoing",
        }),
      );
      const outgoingData = outgoingOnly.data as Record<string, unknown>;
      const outgoingList = outgoingData.outgoing as unknown[];
      expect(outgoingList.length).toBeGreaterThanOrEqual(1);
      expect((outgoingData.incoming as unknown[]).length).toBe(0);
      expect(Number(outgoingData.totalMatching)).toBe(outgoingList.length);

      // Çocuk sayfada yön seçimi: direction=outgoing gelenleri maskeLER
      // (çocuk sayfanın gideni yok → totalMatching 0); direction=incoming
      // backlink'i geri getirir (gidenler boş).
      const childId = String(
        (outgoingData.outgoing as Array<Record<string, unknown>>)[0]?.toPageId,
      );
      const childOutgoingOnly = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_links", {
          pageId: childId,
          direction: "outgoing",
        }),
      );
      const childData = childOutgoingOnly.data as Record<string, unknown>;
      expect((childData.outgoing as unknown[]).length).toBe(0);
      expect((childData.incoming as unknown[]).length).toBe(0);
      expect(Number(childData.totalMatching)).toBe(0);

      const childIncomingOnly = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_links", {
          pageId: childId,
          direction: "incoming",
        }),
      );
      const childIncomingData = childIncomingOnly.data as Record<string, unknown>;
      expect((childIncomingData.outgoing as unknown[]).length).toBe(0);
      expect(
        (childIncomingData.incoming as unknown[]).length,
      ).toBeGreaterThanOrEqual(1);
      expect(Number(childIncomingData.totalMatching)).toBe(
        (childIncomingData.incoming as unknown[]).length,
      );
    } finally {
      await pair.close();
    }
  });

  it("negatif: bilinmeyen pageId WIKI_PAGE_NOT_FOUND; geçersiz direction şema reddi (isError)", async () => {
    const pair = await connectWithWiki();
    try {
      const missing = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_get_links", {
          pageId: "page:olmayan",
        }),
      );
      // TŞ §10.1 sabit kodu (s.9): wiki sayfa kimliği bulunamadı.
      expect(missing.code).toBe("WIKI_PAGE_NOT_FOUND");

      const badDirection = await callTool(pair.client, "causoryn_wiki_get_links", {
        pageId: expectedRootPageId("overview", "overview"),
        direction: "yanlar",
      });
      expect(badDirection.isError).toBe(true);
    } finally {
      await pair.close();
    }
  });

  it("partial: linkKinds filtresi boş küme döndürür; limit+cursor penceresi totalMatching ile tutarlıdır", async () => {
    const pair = await connectWithWiki();
    try {
      const apisRootId = expectedRootPageId("apis-entry-points", "api");
      const filtered = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_links", {
          pageId: apisRootId,
          linkKinds: ["CALLS"],
        }),
      );
      const filteredData = filtered.data as Record<string, unknown>;
      expect((filteredData.outgoing as unknown[]).length).toBe(0);
      expect((filteredData.incoming as unknown[]).length).toBe(0);
      expect(Number(filteredData.totalMatching)).toBe(0);

      const paged = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_links", {
          pageId: apisRootId,
          direction: "outgoing",
          limit: 1,
        }),
      );
      const pagedData = paged.data as Record<string, unknown>;
      expect((pagedData.outgoing as unknown[]).length).toBe(1);
      expect(Number(pagedData.totalMatching)).toBeGreaterThanOrEqual(1);
      expect(typeof pagedData.nextCursor === "string" || pagedData.nextCursor === null).toBe(
        true,
      );
    } finally {
      await pair.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* causoryn_wiki_get_versions                                          */
/* ------------------------------------------------------------------ */

describe("causoryn_wiki_get_versions", { timeout: 60_000 }, () => {
  it("pozitif: yayımlanmış wiki revisionRef'i available döner; working-tree alias git-read ile çözülür; bilinmeyen ref not_available + gerekçe taşır", async () => {
    const pair = await connectWithWiki();
    try {
      const result = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_versions", {
          refs: ["working-tree", "HEAD"],
        }),
      );
      expect(result.status).toBe("ok");
      const data = result.data as Record<string, unknown>;
      const versions = data.versions as Array<Record<string, unknown>>;
      expect(versions.length).toBeGreaterThanOrEqual(2);
      const held = versions.find(
        (version) => version.revisionRef === "working-tree",
      );
      expect(held?.availability).toBe("available");
      expect(String(held?.wikiSnapshotId)).toMatch(/^wiki:/);
      expect(typeof held?.builtAt).toBe("string");
      const headEntry = versions.find((version) => version.revisionRef === "HEAD");
      expect(headEntry?.availability).toBe("not_available");
      expect(String(headEntry?.notAvailableReason).length).toBeGreaterThan(0);
      expect(headEntry?.wikiSnapshotId).toBeNull();
    } finally {
      await pair.close();
    }
  });

  it("negatif: refs dizisi 200 tavanını aşarsa şema reddi (TŞ §20 resource budget; takım denetimi bulgusu 6)", async () => {
    const pair = await connectWithWiki();
    try {
      const manyRefs = Array.from({ length: 201 }, (_, index) => `ref-${String(index)}`);
      const result = await callTool(pair.client, "causoryn_wiki_get_versions", {
        refs: manyRefs,
      });
      expect(result.isError).toBe(true);
      // Tavan ALTI kabul edilir: 200 çözülebilir ref (working-tree) şemayı
      // geçer; tutulan revizyon tekilleştirilir.
      const atLimit = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_versions", {
          refs: Array.from({ length: 200 }, () => "working-tree"),
        }),
      );
      const data = atLimit.data as Record<string, unknown>;
      const versions = data.versions as Array<Record<string, unknown>>;
      expect(versions.length).toBe(1);
      expect(versions[0]?.availability).toBe("available");
    } finally {
      await pair.close();
    }
  });

  it("negatif: çözülemeyen alias INVALID_REVISION döner (K-013 #6); biçim bozuk ref de INVALID_REVISION'dır", async () => {
    const pair = await connectWithWiki();
    try {
      const unknownRef = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_get_versions", {
          refs: ["boyle-bir-branch-yok"],
        }),
      );
      expect(unknownRef.code).toBe("INVALID_REVISION");

      const evilRef = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_get_versions", {
          refs: ["..%2Fevil"],
        }),
      );
      expect(evilRef.code).toBe("INVALID_REVISION");
    } finally {
      await pair.close();
    }
  });

  it("partial: pageId verilirse sayfa sürümü contentHash/linkSetHash/templateVersion/coverage ile döner; bilinmeyen pageId EVIDENCE_NOT_FOUND", async () => {
    const pair = await connectWithWiki();
    try {
      const overviewId = expectedRootPageId("overview", "overview");
      const result = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_get_versions", {
          pageId: overviewId,
        }),
      );
      const data = result.data as Record<string, unknown>;
      const versions = data.versions as Array<Record<string, unknown>>;
      expect(versions).toHaveLength(1);
      expect(versions[0]?.pageId).toBe(overviewId);
      expect(versions[0]?.availability).toBe("available");
      expect(String(versions[0]?.contentHash)).toMatch(/^[0-9a-f]{64}$/);
      expect(String(versions[0]?.linkSetHash)).toMatch(/^[0-9a-f]{64}$/);
      expect(versions[0]?.templateVersion).toBe("1.0.0");
      const coverage = versions[0]?.coverage as Record<string, unknown>;
      expect(typeof coverage.status).toBe("string");

      const missing = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_get_versions", {
          pageId: "page:olmayan",
        }),
      );
      // TŞ §10.1 sabit kodu (s.9): wiki sayfa kimliği bulunamadı.
      expect(missing.code).toBe("WIKI_PAGE_NOT_FOUND");
    } finally {
      await pair.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* causoryn_wiki_diff                                                  */
/* ------------------------------------------------------------------ */

/** Fixture'ın test kopyasında yeni bir endpoint dosyası + kaydı ekler
 * (örnek fixture'a dokunulmaz; kopya os.tmpdir() altındadır). */
function extendFixtureCopy(copyRoot: string): void {
  writeFileSync(
    path.join(copyRoot, "src", "routes", "shipments.ts"),
    [
      "/**",
      " * fixture-ts-orders — test kopyasına eklenen ikinci route katmanı.",
      " * */",
      "",
      'import { type Request, type Response, type RouteHandler } from "../http/router.js";',
      "",
      "export function createShipmentsRoute(): RouteHandler<{ id: string }> {",
      "  return (request: Request<{ id: string }>, response: Response): void => {",
      "    response.json({ id: request.body.id });",
      "  };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const appPath = path.join(copyRoot, "src", "app.ts");
  const appSource = existsSync(appPath)
    ? readFileSync(appPath, "utf8")
    : "";
  const extended = appSource
    .replace(
      'import { createOrdersRoute } from "./routes/orders.js";',
      'import { createOrdersRoute } from "./routes/orders.js";\nimport { createShipmentsRoute } from "./routes/shipments.js";',
    )
    .replace(
      'router.post("/orders", ordersRoute);',
      'router.post("/orders", ordersRoute);\nrouter.post("/shipments", createShipmentsRoute());',
    );
  writeFileSync(appPath, extended, "utf8");
}

/** Salt-okunur test git kurulumu: yalnız add/commit/branch (TŞ kırmızı
 * çizgi 3: checkout/reset/clean YOK — kopya test sahibidir). */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Working-tree parmak izi: .git hariç, path→sha256(içerik) kanonik dizisi
 * (TŞ §16A.10 'user working tree değişmez' kabulünün kanıt anahtarı). */
function workingTreeFingerprint(root: string): string {
  const entries: { readonly p: string; readonly h: string }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      if (dirent.name === ".git") continue;
      const relative = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
      if (dirent.isDirectory()) {
        walk(path.join(dir, dirent.name), relative);
        continue;
      }
      if (!dirent.isFile()) continue;
      entries.push({
        p: relative,
        h: sha256Hex(utf8Encode(readFileSync(path.join(dir, dirent.name), "utf8"))),
      });
    }
  };
  walk(root, "");
  return canonicalJson(
    entries.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0)) as never,
  );
}

describe("causoryn_wiki_diff", { timeout: 90_000 }, () => {
  it("pozitif: İKİ GIT COMMIT durumunun wiki'leri arasında addedPages/addedLinks/changedSections/coverageDelta doğru; diff working tree'yi DEĞİŞTİRMEZ (TŞ §16A.10 Sürüm kabulü; takım denetimi bulgusu 7)", async () => {
    // Fixture kopyası bir temp git deposudur: durum A commit 1, durum B
    // commit 2 (checkout yok — dosyalar doğrudan yazılır, her durum
    // commit'lenir; analiz yine çalışma ağacından yapılır).
    const copyRoot = path.join(tempRoot, "fixture-copy");
    cpSync(FIXTURE_ROOT, copyRoot, { recursive: true });
    git(copyRoot, "init");
    git(copyRoot, "config", "user.email", "vitest@example.com");
    git(copyRoot, "config", "user.name", "vitest");
    git(copyRoot, "add", "-A");
    git(copyRoot, "commit", "-m", "state-a");
    git(copyRoot, "branch", "state-a");

    const pair = await connectClient(makeContext({ allowRoots: [copyRoot] }));
    try {
      // Commit ref'leri çözülebilir (salt-okunur git-read; durum A ve B
      // gerçek commit'lerdir).
      const shaA = git(copyRoot, "rev-parse", "state-a").trim();
      expect(shaA).toMatch(/^[0-9a-f]{40}$/);

      const baseData = await buildWiki(pair.client);
      const baseWikiId = String(baseData.wikiSnapshotId);

      extendFixtureCopy(copyRoot);
      git(copyRoot, "add", "-A");
      git(copyRoot, "commit", "-m", "state-b");
      const shaB = git(copyRoot, "rev-parse", "HEAD").trim();
      expect(shaB).not.toBe(shaA);
      pair.context.indexService.runIndex(copyRoot);
      const targetData = await buildWiki(pair.client);
      const targetWikiId = String(targetData.wikiSnapshotId);
      expect(targetWikiId).not.toBe(baseWikiId);

      // Diff ÖNCESİ working-tree parmak izi: diff işlemi ağacı DEĞİŞTİRMEMELİ
      // (TŞ §16A.10: tarihi karşılaştırma izole snapshot üretimiyle yapılır).
      const fingerprintBefore = workingTreeFingerprint(copyRoot);

      const diff = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_diff", {
          base: baseWikiId,
          target: targetWikiId,
        }),
      );
      const data = diff.data as Record<string, unknown>;
      expect(data.baseWikiSnapshotId).toBe(baseWikiId);
      expect(data.targetWikiSnapshotId).toBe(targetWikiId);
      const addedPages = data.addedPages as string[];
      expect(addedPages.length).toBeGreaterThanOrEqual(1);
      expect(data.removedPages).toEqual([]);

      // Link farkı (takım denetimi bulgusu 7): yeni sayfa, apiler kök
      // sayfasına yeni bir PARENT_OF linki ekler; link silinmesi yok.
      const apisRootId = expectedRootPageId("apis-entry-points", "api");
      const addedLinks = data.addedLinks as Array<Record<string, unknown>>;
      expect(
        addedLinks.some(
          (link) =>
            link.kind === "PARENT_OF" &&
            link.fromPageId === apisRootId &&
            link.toPageId === addedPages[0],
        ),
      ).toBe(true);
      expect(data.removedLinks).toEqual([]);

      const changedSections = data.changedSections as Array<
        Record<string, unknown>
      >;
      // Overview summary bölümü graph sayımlarıyla değişir.
      expect(
        changedSections.some(
          (entry) =>
            entry.pageId === expectedRootPageId("overview", "overview") &&
            entry.sectionKey === "summary",
        ),
      ).toBe(true);
      // K-013 #7: contractChanges Faz D'ye kadar [] + dürüst degrade notu.
      expect(data.contractChanges).toEqual([]);
      const warnings = diff.warnings as string[];
      expect(
        warnings.some((warning) => warning.includes("Faz D")),
      ).toBe(true);
      // Yeni sayfa coverageDelta'ı: previous no_data → current (K-013 #3
      // gövdesi: {previous, current, reason?}; 16A.4).
      const coverageDelta = data.coverageDelta as Array<Record<string, unknown>>;
      const addedEntry = coverageDelta.find(
        (entry) => entry.pageId === addedPages[0],
      );
      expect(addedEntry).toBeDefined();
      expect(addedEntry?.previous).toBe("no_data");
      expect(
        addedEntry?.current === "complete" || addedEntry?.current === "partial",
      ).toBe(true);
      expect(typeof addedEntry?.reason).toBe("string");
      expect(Array.isArray(data.unresolvedDifferences)).toBe(true);

      // Working tree değişmez: diff sonrası parmak izi birebir aynı.
      expect(workingTreeFingerprint(copyRoot)).toBe(fingerprintBefore);
    } finally {
      await pair.close();
    }
  });

  it("negatif: çözülemeyen base/target INVALID_REVISION döner", async () => {
    const pair = await connectWithWiki();
    try {
      const missingBase = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_diff", {
          base: "wiki:deadbeef",
          target: "working-tree",
        }),
      );
      expect(missingBase.code).toBe("INVALID_REVISION");

      const missingTarget = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_diff", {
          base: "working-tree",
          target: "boyle-bir-revision-yok",
        }),
      );
      expect(missingTarget.code).toBe("INVALID_REVISION");
    } finally {
      await pair.close();
    }
  });

  it("partial: base === target boş diff; pageId daraltması tek sayfaya indirger", async () => {
    const pair = await connectWithWiki();
    try {
      const overviewId = expectedRootPageId("overview", "overview");
      const same = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_diff", {
          base: "working-tree",
          target: "working-tree",
        }),
      );
      const sameData = same.data as Record<string, unknown>;
      expect(sameData.addedPages).toEqual([]);
      expect(sameData.removedPages).toEqual([]);
      expect(sameData.changedSections).toEqual([]);
      expect(sameData.coverageDelta).toEqual([]);

      const scoped = expectEnvelope(
        await callTool(pair.client, "causoryn_wiki_diff", {
          base: "working-tree",
          target: "working-tree",
          pageId: overviewId,
        }),
      );
      const scopedData = scoped.data as Record<string, unknown>;
      expect(scopedData.baseWikiSnapshotId).toBe(
        scopedData.targetWikiSnapshotId,
      );

      const missingPage = expectErrorOf(
        await callTool(pair.client, "causoryn_wiki_diff", {
          base: "working-tree",
          target: "working-tree",
          pageId: "page:olmayan",
        }),
      );
      // TŞ §10.1 sabit kodu (s.9): wiki sayfa kimliği bulunamadı.
      expect(missingPage.code).toBe("WIKI_PAGE_NOT_FOUND");
    } finally {
      await pair.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Güvenlik denetimi bulguları                                         */
/* ------------------------------------------------------------------ */

describe("güvenlik denetimi bulguları", { timeout: 60_000 }, () => {
  it("negatif: çok köklü beyanda dataDbPath üst dizini allowRoots[1..] köküne junction ise sunucu başlamaz (symlink kaçışı çok köklü)", () => {
    // Gerçek içerik allowRoots[1] kökÜNDE; beyanlı dataDbPath üst dizini
    // lex kontrolün TÜM köklerine temiz (hiçbir kökün altında değil) AMA
    // junction ile ikinci kök içine çözülür. Gerçek yol denetimi de
    // TÜM allowRoots'u kapsamalıdır (lex kontrolün çok köklü karşılığı);
    // tek kök (allowRoots[0]) karşılaştırması allowRoots[1..] kaçışını
    // kapmaz. Windows'ta junction izinsiz kurulur ve realpathSync
    // tarafından çözülür — iki sürecin göreceği gerçek yol budur.
    const rootA = path.join(tempRoot, "ws-a");
    const rootB = path.join(tempRoot, "ws-b");
    mkdirSync(path.join(rootA, "src"), { recursive: true });
    mkdirSync(path.join(rootB, "src"), { recursive: true });
    writeFileSync(path.join(rootA, "src", "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(path.join(rootB, "src", "b.ts"), "export const b = 1;\n", "utf8");
    const realData = path.join(rootB, "wiki-data");
    mkdirSync(realData, { recursive: true });
    const decoyParent = path.join(tempRoot, "decoy-data");
    symlinkSync(realData, decoyParent, "junction");

    // Kırmızı koşusunda (bug davranışı) context AÇILIR ve wiki SQLite
    // bağlantısı junction içindeki hedefe açılır; handle açık kalırsa
    // afterEach rmSync EPERM ile patlar. Context'i yakala, açık kaldıysa
    // kapat, sonra beklentiyi doğrula (mevcut dosya disiplini).
    let context: CausorynContext | undefined;
    let caught: unknown;
    try {
      context = createCausorynContext(
        {
          workspaceId: "default",
          allowRoots: [rootA, rootB],
          autoIndex: false,
          wiki: { dataDbPath: path.join(decoyParent, "wiki.sqlite") },
        },
        { clock: fixedClock },
      );
    } catch (error) {
      caught = error;
    }
    context?.close();
    expect(caught).toBeInstanceOf(CausorynConfigError);
  });

  it("wikiErrorToToolError: wiki/output-not-authorized → EXPORT_NOT_ALLOWED; wiki/output-path-denied → PATH_DENIED", () => {
    // Latent eşleme: export çekirdeği (exportWikiOffline) bugün MCP
    // yüzeyinden çağrılmıyor; view=wiki kablolandığında güvenlik reddi
    // sinyali (yetkilendirme red kodları) INTERNAL_ERROR kovasına
    // DÜŞMEMELİDİR. Öncül: services-architecture.ts export/output-*
    // eşlemesi (EXPORT_NOT_ALLOWED/PATH_DENIED, K-008 örüntüsü — yeni
    // uzantı kodu istenmez); kayıt packages/wiki errors.ts başlığı ve
    // export.ts hata kodu dokümantasyonunda belgelenmiştir.
    const deps = { logger: (): void => {} } as unknown as ServiceDeps;

    const unauthorized = wikiErrorToToolError(
      new WikiProjectionError(
        "wiki/output-not-authorized",
        "output dizini kullanıcının beyan ettiği output listesinde değil (explicit authorization, TŞ §16)",
      ),
      deps,
    );
    expect(unauthorized.code).toBe("EXPORT_NOT_ALLOWED");
    expect(unauthorized.message).toContain("output dizini");

    const denied = wikiErrorToToolError(
      new WikiProjectionError(
        "wiki/output-path-denied",
        "dosya adı yol ayracı içeremez (alt dizin yazma izni yok)",
      ),
      deps,
    );
    expect(denied.code).toBe("PATH_DENIED");
    expect(denied.message).toContain("yol ayracı");
  });
});
