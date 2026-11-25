import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  createSnapshot,
  sha256Hex,
  utf8Encode,
  type SnapshotGraph,
} from "@causoryn/domain";
import { SqliteWikiStore } from "@causoryn/storage-sqlite";

import {
  wikiProjectionCanonicalJson,
  wikiProjectionContentHash,
} from "../src/content-hash.js";
import { WikiProjectionError } from "../src/errors.js";
import {
  WikiGraphDiffSchema,
  WikiIncrementalBuildReportSchema,
  diffWikiGraphs,
  projectWikiIncremental,
} from "../src/incremental.js";
import { WikiPageKindSchema, type WikiProjection } from "../src/schema.js";
import { projectWiki } from "../src/projection.js";

/**
 * Incremental invalidation — test üçlüsü (TŞ v2.1 §16A.5 canlı güncelleme,
 * §16A.6 not koruma, §16A.10 İnkremental + "Kullanıcı notu" satırları;
 * wiki/sprint-4.md W6).
 *
 * Pozitif: tek dosya (module:billing) değişimi → yalnızca etkilenen pageId'ler
 * yenilenir (bölüm → sayfa eşlemesi); bağımsız sayfa contentHash'i bit-bit
 * korunur (§16A.10 "bağımsız sayfa contentHash'i korunur").
 * Negatif: aynı girdiyle ikinci build → sıfır yeniden yazım, tüm hash'ler
 * aynı; geçersiz girdi (builtAt, projectable olmayan state) red.
 * Partial: incremental desteklenmeyen değişiklik (parser config değişimi
 * §16A.5 reconciliation kuralı, bozuk previous, şablon sürümü, desteklenen
 * sayfa türü kümesi) → graceful full-rebuild + açık uyarı.
 *
 * Canonical eşitlik: incremental çıktı, aynı girdiyle üretilen full build
 * çıktısıyla bit-bit aynıdır (wikiProjectionCanonicalJson).
 *
 * Not koruma (§16A.6): W7 overlay store'u devrede olmadan manuel annotation
 * satırları doğrudan SQL ile yazılır; art arda İKİ reindex (A→B, B→C)
 * sonrasında satırlar bit-bit aynıdır (TŞ §16A.10 "Art arda iki reindex,
 * manuel notları değiştirmez"). Atomik publish: eski projeksiyon
 * sorgulanabilir kalır (stale=true semantiği: kaynak graphSnapshotId
 * güncel yayınlanmış graph'tan farklıdır — TŞ §16A.5 madde 6); building
 * satırları okuma yollarında görünmez; publish hatası depoyu değiştirmez.
 *
 * Not: bu test dosyası modülleri doğrudan import eder (src/index.ts,
 * W8 export dilimiyle eşzamanlı çalışma nedeniyle bilinçli olarak
 * dokunulmamıştır).
 */

const WS = "ws_incremental";
const CREATED_AT = "2026-11-06T09:00:00.000Z";
const T1 = "2026-11-06T09:05:00.000Z";
const T2 = "2026-11-06T09:10:00.000Z";
const T3 = "2026-11-06T09:15:00.000Z";
const T4 = "2026-11-06T09:20:00.000Z";
const REVISION_A = "rev-a";
const REVISION_B = "rev-b";
const REVISION_C = "rev-c";

function span(relativePath: string, startLine: number, endLine: number, tag: string) {
  return {
    relativePath,
    startLine,
    endLine,
    sourceHash: `sha256:${relativePath}:${startLine}:${tag}`,
  };
}

/** orders/billing/shipping fixture — TŞ §16A.10 tek-servis-değişimi sahnesi. */
function buildFixture(options: {
  readonly revision: string;
  readonly billingTag?: string;
  readonly removeOrdersDependsBilling?: boolean;
  readonly addBillingServiceClass?: boolean;
  readonly configHash?: string;
}): SnapshotGraph {
  const nodes: Parameters<typeof createSnapshot>[0]["nodes"] = [
    { kind: "Workspace", qualifiedName: "orders-service" },
    { kind: "Project", qualifiedName: "project:orders-service" },
    {
      kind: "Module",
      qualifiedName: "module:orders",
      location: span("src/orders/index.ts", 1, 5, "v1"),
      language: "typescript",
    },
    {
      kind: "Module",
      qualifiedName: "module:billing",
      // Tek dosya değişimi: yalnızca içerik karması değişir (kimlik aynı).
      location: span("src/billing/index.ts", 1, 5, options.billingTag ?? "v1"),
      language: "typescript",
    },
    {
      kind: "Module",
      qualifiedName: "module:shipping",
      location: span("src/shipping/index.ts", 1, 5, "v1"),
      language: "typescript",
    },
    {
      kind: "Endpoint",
      qualifiedName: "POST /orders",
      location: span("src/orders/routes.ts", 3, 7, "v1"),
      language: "typescript",
    },
    {
      kind: "Method",
      qualifiedName: "OrderService.CreateOrder",
      location: span("src/orders/order-service.ts", 12, 18, "v1"),
      language: "typescript",
    },
    {
      kind: "Table",
      qualifiedName: "table:orders",
      location: span("db/orders.sql", 1, 4, "v1"),
    },
    {
      kind: "UnknownExternal",
      qualifiedName: "external:paymentGateway",
    },
    ...(options.addBillingServiceClass === true
      ? [
          {
            kind: "Class" as const,
            qualifiedName: "BillingService",
            location: span("src/billing/billing-service.ts", 8, 20, "v2"),
            language: "typescript",
          },
        ]
      : []),
  ];

  const edges: Parameters<typeof createSnapshot>[0]["edges"] = [
    {
      kind: "CONTAINS",
      from: { kind: "Workspace", qualifiedName: "orders-service" },
      to: { kind: "Project", qualifiedName: "project:orders-service" },
      resolution: "verified",
      evidence: [
        {
          kind: "structural",
          span: span("package.json", 1, 10, "v1"),
          analyzerId: "typescript",
          analyzerVersion: "5.9.3",
          rationale: "Workspace kökünde proje bildirimi",
        },
      ],
    },
    {
      kind: "CONTAINS",
      from: { kind: "Project", qualifiedName: "project:orders-service" },
      to: { kind: "Module", qualifiedName: "module:orders" },
      resolution: "verified",
      evidence: [
        {
          kind: "structural",
          span: span("src/orders/index.ts", 1, 5, "v1"),
          analyzerId: "typescript",
          analyzerVersion: "5.9.3",
          rationale: "Proje dizininde orders modülü",
        },
      ],
    },
    {
      kind: "CONTAINS",
      from: { kind: "Project", qualifiedName: "project:orders-service" },
      to: { kind: "Module", qualifiedName: "module:billing" },
      resolution: "verified",
      evidence: [
        {
          kind: "structural",
          span: span("src/billing/index.ts", 1, 5, "v1"),
          analyzerId: "typescript",
          analyzerVersion: "5.9.3",
          rationale: "Proje dizininde billing modülü",
        },
      ],
    },
    {
      kind: "CONTAINS",
      from: { kind: "Project", qualifiedName: "project:orders-service" },
      to: { kind: "Module", qualifiedName: "module:shipping" },
      resolution: "verified",
      evidence: [
        {
          kind: "structural",
          span: span("src/shipping/index.ts", 1, 5, "v1"),
          analyzerId: "typescript",
          analyzerVersion: "5.9.3",
          rationale: "Proje dizininde shipping modülü",
        },
      ],
    },
    ...(options.removeOrdersDependsBilling === true
      ? []
      : [
          {
            kind: "DEPENDS_ON" as const,
            from: { kind: "Module" as const, qualifiedName: "module:orders" },
            to: { kind: "Module" as const, qualifiedName: "module:billing" },
            resolution: "heuristic" as const,
            evidence: [
              {
                kind: "import-graph",
                span: span("src/orders/order-service.ts", 1, 3, "v1"),
                analyzerId: "typescript",
                analyzerVersion: "5.9.3",
                rationale: "orders → billing import'u",
              },
            ],
          },
        ]),
    {
      // TŞ §16A.10 Belirsizlik: çözülemeyen kenar → partial bölüm.
      kind: "DEPENDS_ON",
      from: { kind: "Module", qualifiedName: "module:billing" },
      to: { kind: "Module", qualifiedName: "module:shipping" },
      resolution: "unresolved",
      evidence: [],
    },
    {
      kind: "ROUTES_TO",
      from: { kind: "Endpoint", qualifiedName: "POST /orders" },
      to: { kind: "Method", qualifiedName: "OrderService.CreateOrder" },
      resolution: "verified",
      evidence: [
        {
          kind: "route-binding",
          span: span("src/orders/routes.ts", 3, 7, "v1"),
          analyzerId: "typescript",
          analyzerVersion: "5.9.3",
          rationale: "POST /orders → CreateOrder",
        },
      ],
    },
    {
      kind: "READS",
      from: { kind: "Method", qualifiedName: "OrderService.CreateOrder" },
      to: { kind: "Table", qualifiedName: "table:orders" },
      resolution: "verified",
      evidence: [
        {
          kind: "data-access",
          span: span("src/orders/order-service.ts", 14, 16, "v1"),
          analyzerId: "typescript",
          analyzerVersion: "5.9.3",
          rationale: "orders tablosundan okuma",
        },
      ],
    },
    {
      kind: "CALLS",
      from: { kind: "Method", qualifiedName: "OrderService.CreateOrder" },
      to: { kind: "UnknownExternal", qualifiedName: "external:paymentGateway" },
      resolution: "unresolved",
      evidence: [],
    },
    ...(options.addBillingServiceClass === true
      ? [
          {
            kind: "CONTAINS" as const,
            from: { kind: "Module" as const, qualifiedName: "module:billing" },
            to: { kind: "Class" as const, qualifiedName: "BillingService" },
            resolution: "verified" as const,
            evidence: [
              {
                kind: "declaration",
                span: span("src/billing/billing-service.ts", 8, 20, "v2"),
                analyzerId: "typescript",
                analyzerVersion: "5.9.3",
                rationale: "Sınıf bildirimi billing modülünde",
              },
            ],
          },
        ]
      : []),
  ];

  return createSnapshot({
    workspaceId: WS,
    revision: { id: options.revision, sequence: 1 },
    configHash: options.configHash ?? "cfg-inc-001",
    analyzerFingerprint: "ts-adapter@1",
    state: "ready",
    createdAt: CREATED_AT,
    nodes,
    edges,
  });
}

const GRAPH_A = buildFixture({ revision: REVISION_A });
const GRAPH_B = buildFixture({
  revision: REVISION_B,
  billingTag: "v2",
  removeOrdersDependsBilling: true,
});
const GRAPH_C = buildFixture({
  revision: REVISION_C,
  billingTag: "v2",
  removeOrdersDependsBilling: true,
  addBillingServiceClass: true,
});
const GRAPH_B_CONFIG_CHANGED = buildFixture({
  revision: REVISION_B,
  billingTag: "v2",
  removeOrdersDependsBilling: true,
  configHash: "cfg-inc-002",
});

const PROJECTION_A = projectWiki(GRAPH_A, { builtAt: T1 });

function titleToPageId(projection: WikiProjection): Map<string, string> {
  return new Map(projection.pages.map((page) => [page.title, page.id]));
}

function pageHashes(projection: WikiProjection): Map<string, string> {
  return new Map(projection.pages.map((page) => [page.id, page.contentHash]));
}

function sectionMarkdowns(
  projection: WikiProjection,
): Map<string, string> {
  return new Map(
    projection.sections.map((section) => [
      `${section.pageId}/${section.sectionKey}`,
      section.generatedMarkdown,
    ]),
  );
}

/* ------------------------------------------------------------------ */
/* diffWikiGraphs — deterministik graph farkı                          */
/* ------------------------------------------------------------------ */

describe("diffWikiGraphs", () => {
  it("pozitif: tek node içerik değişimi + kenar silinmesi tam kümelerle raporlanır", () => {
    const diff = diffWikiGraphs(GRAPH_A, GRAPH_B);

    const billingNode = GRAPH_A.nodes.find(
      (node) => node.qualifiedName === "module:billing",
    );
    expect(billingNode).toBeDefined();
    expect(diff.changedNodeIds).toEqual([billingNode?.id]);

    // Silinen DEPENDS_ON orders→billing kenarı: uçlarından çözülür.
    const removedEdge = GRAPH_A.edges.find(
      (edge) =>
        edge.kind === "DEPENDS_ON" &&
        edge.from === GRAPH_A.nodes.find((n) => n.qualifiedName === "module:orders")?.id &&
        edge.to === GRAPH_A.nodes.find((n) => n.qualifiedName === "module:billing")?.id,
    );
    expect(removedEdge).toBeDefined();
    expect(diff.removedEdgeIds).toEqual([removedEdge?.id]);
    expect(diff.addedNodeIds).toEqual([]);
    expect(diff.addedEdgeIds).toEqual([]);
    expect(diff.empty).toBe(false);
  });

  it("negatif: aynı graph → boş diff (empty=true), tüm kümeler boş", () => {
    const diff = diffWikiGraphs(GRAPH_A, GRAPH_A);
    expect(diff.empty).toBe(true);
    expect(diff.changedNodeIds).toEqual([]);
    expect(diff.changedEdgeIds).toEqual([]);
    expect(diff.removedNodeIds).toEqual([]);
    expect(diff.configChanged).toBe(false);
    expect(diff.revisionChanged).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* projectWikiIncremental — seçim + contentHash koruması               */
/* ------------------------------------------------------------------ */

describe("projectWikiIncremental — seçim ve hash koruması", () => {
  it("pozitif: tek servis değişir → yalnızca etkilenen sayfalar yenilenir, bağımsız contentHash korunur", () => {
    const incremental = projectWikiIncremental({
      previous: PROJECTION_A,
      previousGraph: GRAPH_A,
      nextGraph: GRAPH_B,
      builtAt: T2,
    });

    expect(incremental.report.mode).toBe("incremental");
    const ids = titleToPageId(PROJECTION_A);
    const affected = new Set(incremental.report.affectedPageIds);
    const regenerated = new Set(incremental.report.regeneratedPageIds);

    // Bölüm → sayfa eşlemesinden seçim: değişen billing sayfası, silinen
    // DEPENDS_ON kenarının iki ucu (orders + billing) ve tüm GLOBAL kökler.
    expect(affected.has(ids.get("module:billing")!)).toBe(true);
    expect(affected.has(ids.get("module:orders")!)).toBe(true);
    for (const root of [
      "Overview",
      "Architecture",
      "Projects & Modules",
      "APIs & Entry Points",
      "Events & Integrations",
      "Data & Schemas",
      "Contracts & Policies",
      "Tests & Quality",
      "Unresolved & Coverage",
    ]) {
      expect(affected.has(ids.get(root)!)).toBe(true);
    }
    // CONSTANT kökler (no_data şablonları) seçilmez.
    for (const constantRoot of ["Business Flows", "Architecture Timeline", "Onboarding"]) {
      expect(affected.has(ids.get(constantRoot)!)).toBe(false);
    }
    // Değişmeyen komşu sayfa seçilmez (uzak uç kimliği aynı → görünen ad aynı).
    expect(affected.has(ids.get("module:shipping")!)).toBe(false);
    expect(affected.has(ids.get("POST /orders")!)).toBe(false);
    expect(affected.has(ids.get("table:orders")!)).toBe(false);

    // contentHash gerçekten değişenler: Overview (kenar sayımı),
    // module:orders (dependencies bölümü boşalır), module:billing.
    expect(regenerated).toEqual(
      new Set([
        ids.get("Overview"),
        ids.get("module:orders"),
        ids.get("module:billing"),
      ]),
    );

    // Diğer TÜM sayfaların contentHash'i bit-bit korunur + bölüm içerikleri
    // yeniden YAZILMAZ (no-op).
    const before = pageHashes(PROJECTION_A);
    const after = pageHashes(incremental.projection);
    const beforeSections = sectionMarkdowns(PROJECTION_A);
    const afterSections = sectionMarkdowns(incremental.projection);
    for (const [pageId, hash] of before) {
      if (regenerated.has(pageId)) continue;
      expect(after.get(pageId)).toBe(hash);
    }
    for (const [key, markdown] of beforeSections) {
      const pageId = key.slice(0, key.indexOf("/"));
      if (regenerated.has(pageId)) continue;
      expect(afterSections.get(key)).toBe(markdown);
    }

    // Yenilenenlerin hash'i gerçekten değişti.
    for (const pageId of regenerated) {
      expect(after.get(pageId)).not.toBe(before.get(pageId));
    }
  });

  it("negatif: aynı girdiyle ikinci build → sıfır yeniden yazım, tüm hash'ler aynı", () => {
    const noop = projectWikiIncremental({
      previous: PROJECTION_A,
      previousGraph: GRAPH_A,
      nextGraph: GRAPH_A,
      builtAt: T1,
    });

    expect(noop.report.mode).toBe("incremental");
    expect(noop.report.affectedPageIds).toEqual([]);
    expect(noop.report.regeneratedPageIds).toEqual([]);
    expect(noop.report.preservedPageIds).toEqual(
      PROJECTION_A.pages.map((page) => page.id).sort(),
    );
    // Sayfa sayısı ve bütün hash'ler korunur; çıktı previous ile bit-bit aynı.
    expect(noop.projection.pages).toHaveLength(PROJECTION_A.pages.length);
    expect(wikiProjectionCanonicalJson(noop.projection)).toBe(
      wikiProjectionCanonicalJson(PROJECTION_A),
    );
    expect(wikiProjectionContentHash(noop.projection)).toBe(
      wikiProjectionContentHash(PROJECTION_A),
    );
  });

  it("determinizm: aynı girdiyle iki incremental koşusu bit-bit aynı çıktı verir", () => {
    const first = projectWikiIncremental({
      previous: PROJECTION_A,
      previousGraph: GRAPH_A,
      nextGraph: GRAPH_B,
      builtAt: T2,
    });
    const second = projectWikiIncremental({
      previous: PROJECTION_A,
      previousGraph: GRAPH_A,
      nextGraph: GRAPH_B,
      builtAt: T2,
    });
    expect(wikiProjectionCanonicalJson(first.projection)).toBe(
      wikiProjectionCanonicalJson(second.projection),
    );
    // Denetim bulgusu 7: rapor gövdesi Zod şemasından geçer (pozitif).
    expect(WikiIncrementalBuildReportSchema.safeParse(first.report).success).toBe(
      true,
    );
    expect(WikiGraphDiffSchema.safeParse(first.report.diff).success).toBe(true);
    // Fallback raporu da şemadan geçer (mode=full-rebuild değeriyle).
    const fallback = projectWikiIncremental({
      previous: PROJECTION_A,
      previousGraph: GRAPH_A,
      nextGraph: GRAPH_B_CONFIG_CHANGED,
      builtAt: T2,
    });
    const fallbackParse = WikiIncrementalBuildReportSchema.safeParse(fallback.report);
    expect(fallbackParse.success).toBe(true);
    expect(
      fallbackParse.success === true ? fallbackParse.data.mode : undefined,
    ).toBe("full-rebuild");
  });
});

/* ------------------------------------------------------------------ */
/* Kök sayfa coverage.detail sözleşmesi (denetim bulgusu 1)            */
/* ------------------------------------------------------------------ */

describe("kök sayfa coverage.detail — desteklenmeyen tür yapısal detayı EZMEZ", () => {
  it("pozitif: business_flow/timeline desteklenmediğinde detail 'desteklenmiyor' metnidir (HEAD davranışı)", () => {
    const kinds = WikiPageKindSchema.options.filter(
      (kind) => kind !== "business_flow" && kind !== "timeline",
    );
    const proj = projectWiki(GRAPH_A, { builtAt: T1, supportedPageKinds: kinds });

    const flows = proj.pages.find((page) => page.title === "Business Flows");
    expect(flows?.coverage.status).toBe("unsupported");
    expect(flows?.coverage.detail).toBe(
      "page kind 'business_flow' is not supported by this adapter set",
    );

    const timeline = proj.pages.find(
      (page) => page.title === "Architecture Timeline",
    );
    expect(timeline?.coverage.status).toBe("unsupported");
    expect(timeline?.coverage.detail).toBe(
      "page kind 'timeline' is not supported by this adapter set",
    );

    // Desteklendiğinde yapısal no_data detayı döner (her iki koşul ayrı).
    const supported = projectWiki(GRAPH_A, { builtAt: T1 });
    const flowsSupported = supported.pages.find(
      (page) => page.title === "Business Flows",
    );
    expect(flowsSupported?.coverage.status).toBe("no_data");
    expect(flowsSupported?.coverage.detail).toBe(
      "end-to-end execution flow data is not carried in the GraphSnapshot",
    );
  });

  it("pozitif: incremental motoru AYNI detay sözleşmesini taşır (canonical eşitlik korunur)", () => {
    const kinds = WikiPageKindSchema.options.filter(
      (kind) => kind !== "business_flow" && kind !== "timeline",
    );
    const previous = projectWiki(GRAPH_A, { builtAt: T1, supportedPageKinds: kinds });
    // Aynı destek kümesiyle incremental koşu (küme değişimi fallback tetiklemez).
    const step = projectWikiIncremental({
      previous,
      previousGraph: GRAPH_A,
      nextGraph: GRAPH_B,
      builtAt: T2,
      supportedPageKinds: kinds,
    });
    const flows = step.projection.pages.find(
      (page) => page.title === "Business Flows",
    );
    expect(flows?.coverage.status).toBe("unsupported");
    expect(flows?.coverage.detail).toBe(
      "page kind 'business_flow' is not supported by this adapter set",
    );
    // Desteklenmeyen kök sayfa içeriği sabittir → hash korunur (no-op).
    expect(step.report.regeneratedPageIds).not.toContain(flows?.id);
  });
});

/* ------------------------------------------------------------------ */
/* diffWikiGraphs hata bacağı (denetim bulgusu 5)                      */
/* ------------------------------------------------------------------ */

describe("diffWikiGraphs — şema bozuk girdi reddi", () => {
  it("negatif: bozuk nextGraph/previousGraph WikiProjectionError (wiki/invalid-graph) ile reddedilir", () => {
    const brokenMeta = { ...GRAPH_A.meta } as Record<string, unknown>;
    delete brokenMeta["analyzerFingerprint"];
    const broken = {
      meta: brokenMeta,
      nodes: GRAPH_A.nodes,
      edges: GRAPH_A.edges,
      evidence: GRAPH_A.evidence,
    } as unknown as SnapshotGraph;

    expect(() => diffWikiGraphs(GRAPH_A, broken)).toThrow(WikiProjectionError);
    expect(() => diffWikiGraphs(broken, GRAPH_A)).toThrow(/previousGraph/);
    expect(() =>
      projectWikiIncremental({
        previous: PROJECTION_A,
        previousGraph: GRAPH_A,
        nextGraph: broken,
        builtAt: T2,
      }),
    ).toThrow(WikiProjectionError);
  });
});

/* ------------------------------------------------------------------ */
/* Canonical eşitlik: incremental ≡ full                               */
/* ------------------------------------------------------------------ */

describe("incremental ≡ full canonical eşitliği", () => {
  it("aynı girdi sonrası incremental çıktı, full build çıktısıyla bit-bit aynıdır", () => {
    const incremental = projectWikiIncremental({
      previous: PROJECTION_A,
      previousGraph: GRAPH_A,
      nextGraph: GRAPH_B,
      builtAt: T2,
    });
    const full = projectWiki(GRAPH_B, { builtAt: T2 });

    expect(wikiProjectionCanonicalJson(incremental.projection)).toBe(
      wikiProjectionCanonicalJson(full),
    );
    expect(wikiProjectionContentHash(incremental.projection)).toBe(
      wikiProjectionContentHash(full),
    );
  });

  it("ikinci adım (B→C) incremental çıktısı da full build ile bit-bit aynıdır", () => {
    const step1 = projectWikiIncremental({
      previous: PROJECTION_A,
      previousGraph: GRAPH_A,
      nextGraph: GRAPH_B,
      builtAt: T2,
    });
    const step2 = projectWikiIncremental({
      previous: step1.projection,
      previousGraph: GRAPH_B,
      nextGraph: GRAPH_C,
      builtAt: T3,
    });
    const fullC = projectWiki(GRAPH_C, { builtAt: T3 });
    expect(wikiProjectionCanonicalJson(step2.projection)).toBe(
      wikiProjectionCanonicalJson(fullC),
    );
  });
});

/* ------------------------------------------------------------------ */
/* Partial: incremental desteklenmeyen değişiklik → graceful rebuild   */
/* ------------------------------------------------------------------ */

describe("incremental desteklenmeyen durumlar — graceful full-rebuild", () => {
  it("parser config değişimi → full-rebuild + reconciliation uyarısı (TŞ §16A.5)", () => {
    const fallback = projectWikiIncremental({
      previous: PROJECTION_A,
      previousGraph: GRAPH_A,
      nextGraph: GRAPH_B_CONFIG_CHANGED,
      builtAt: T2,
    });
    expect(fallback.report.mode).toBe("full-rebuild");
    expect(fallback.report.reason).toMatch(/config/i);
    expect(fallback.report.warnings.some((w) => /config/i.test(w))).toBe(true);
    // Graceful: full rebuild çıktısı, doğrudan full build ile bit-bit aynı.
    expect(wikiProjectionCanonicalJson(fallback.projection)).toBe(
      wikiProjectionCanonicalJson(projectWiki(GRAPH_B_CONFIG_CHANGED, { builtAt: T2 })),
    );
  });

  it("previous projeksiyonun contentHash'i bölümleriyle uyuşmuyorsa → full-rebuild + uyarı", () => {
    const tamperedPages = PROJECTION_A.pages.map((page, index) =>
      index === 0 ? { ...page, contentHash: "sha256:tampered" } : page,
    );
    const tampered: WikiProjection = {
      snapshot: PROJECTION_A.snapshot,
      pages: tamperedPages,
      sections: PROJECTION_A.sections,
      warnings: PROJECTION_A.warnings,
    };
    const fallback = projectWikiIncremental({
      previous: tampered,
      previousGraph: GRAPH_A,
      nextGraph: GRAPH_B,
      builtAt: T2,
    });
    expect(fallback.report.mode).toBe("full-rebuild");
    expect(fallback.report.warnings.some((w) => /contentHash|karma/i.test(w))).toBe(true);
    expect(wikiProjectionCanonicalJson(fallback.projection)).toBe(
      wikiProjectionCanonicalJson(projectWiki(GRAPH_B, { builtAt: T2 })),
    );
  });

  it("şablon sürümü değişmiş previous → full-rebuild + uyarı", () => {
    const oldTemplate: WikiProjection = {
      snapshot: { ...PROJECTION_A.snapshot, templateVersion: "0.0.9" },
      pages: PROJECTION_A.pages,
      sections: PROJECTION_A.sections,
      warnings: PROJECTION_A.warnings,
    };
    const fallback = projectWikiIncremental({
      previous: oldTemplate,
      previousGraph: GRAPH_A,
      nextGraph: GRAPH_B,
      builtAt: T2,
    });
    expect(fallback.report.mode).toBe("full-rebuild");
    expect(fallback.report.warnings.some((w) => /template version changed/.test(w))).toBe(true);
  });

  it("desteklenen sayfa türü kümesi değişmişse → full-rebuild + uyarı", () => {
    const supportedKinds = WikiPageKindSchema.options.filter(
      (kind) => kind !== "test",
    );
    const fallback = projectWikiIncremental({
      previous: PROJECTION_A,
      previousGraph: GRAPH_A,
      nextGraph: GRAPH_B,
      builtAt: T2,
      supportedPageKinds: supportedKinds,
    });
    expect(fallback.report.mode).toBe("full-rebuild");
    expect(
      fallback.report.warnings.some((w) => /supported page kind set changed \(supportedPageKinds\)/.test(w)),
    ).toBe(true);
    expect(wikiProjectionCanonicalJson(fallback.projection)).toBe(
      wikiProjectionCanonicalJson(
        projectWiki(GRAPH_B, { builtAt: T2, supportedPageKinds: supportedKinds }),
      ),
    );
  });

  it("negatif: geçersiz builtAt ve projeksiyona girmeyen graph state açıkça reddedilir", () => {
    expect(() =>
      projectWikiIncremental({
        previous: PROJECTION_A,
        previousGraph: GRAPH_A,
        nextGraph: GRAPH_B,
        builtAt: "kasım",
      }),
    ).toThrow(WikiProjectionError);

    const buildingGraph = createSnapshot({
      workspaceId: WS,
      revision: { id: "rev-building", sequence: 1 },
      configHash: "cfg-inc-001",
      analyzerFingerprint: "ts-adapter@1",
      state: "building",
      createdAt: CREATED_AT,
      nodes: [{ kind: "Workspace", qualifiedName: "orders-service" }],
      edges: [],
    });
    expect(() =>
      projectWikiIncremental({
        previous: PROJECTION_A,
        previousGraph: GRAPH_A,
        nextGraph: buildingGraph,
        builtAt: T2,
      }),
    ).toThrow(/ready\/partial/);
  });
});

/* ------------------------------------------------------------------ */
/* SQLite: atomik publish, stale eski projeksiyon, not koruma          */
/* ------------------------------------------------------------------ */

const EMPTY_LINK_SET_HASH = sha256Hex(utf8Encode(canonicalJson([])));

const ANNOTATION_BODY = "Manuel not — İKİ reindex sonrası bit-bit korunmalı 🔒 äöü";
const ANNOTATION_ID = "annot-w6-1";
const ANNOTATION_UPDATED_AT = "2026-11-06T08:00:00.000Z";

/** W5 publish çekirdeği ile aynı transaction disiplini (linksiz minimal). */
function publishProjection(
  store: SqliteWikiStore,
  projection: WikiProjection,
  builtAt: string,
): void {
  const sid = store.beginWikiBuild({
    workspaceId: WS,
    graphSnapshotId: projection.snapshot.graphSnapshotId,
    revisionRef: projection.snapshot.revisionRef,
    templateVersion: projection.snapshot.templateVersion,
    createdAt: builtAt,
  });
  for (const page of projection.pages) {
    store.addWikiPage(sid, {
      id: page.id,
      kind: page.kind,
      parentId: page.parentId,
      title: page.title,
      slug: page.slug,
      route: page.route,
      contentHash: page.contentHash,
      freshness: page.freshness,
      coverage:
        page.coverage.detail === undefined
          ? { status: page.coverage.status }
          : { status: page.coverage.status, detail: page.coverage.detail },
    });
  }
  for (const section of projection.sections) {
    store.addWikiPageSection(sid, {
      id: section.id,
      pageId: section.pageId,
      sectionKey: section.sectionKey,
      generatedMarkdown: section.generatedMarkdown,
      evidenceRefs: section.evidenceRefs.map((ref) => ({ ...ref })),
      status: section.status,
    });
  }
  for (const page of projection.pages) {
    store.addWikiPageVersion(sid, {
      pageId: page.id,
      revisionRef: projection.snapshot.revisionRef,
      contentHash: page.contentHash,
      linkSetHash: EMPTY_LINK_SET_HASH,
      templateVersion: projection.snapshot.templateVersion,
      coverage: { status: page.coverage.status },
    });
  }
  const status = projection.snapshot.status;
  if (status !== "ready" && status !== "partial") {
    throw new Error(`publish edilemez projeksiyon durumu: ${status}`);
  }
  store.publishWiki(sid, projection.snapshot.id, status, builtAt);
}

function insertAnnotationRaw(dbPath: string, stablePageId: string): void {
  const raw = new Database(dbPath);
  try {
    // Doğrudan SQL ile overlay satırı (W7 store'u devrede değil);
    // değerler PARAMETRE ile bağlanır — SQL metnine katılmaz.
    raw
      .prepare(
        `INSERT INTO wiki_annotations
           (id, workspace_id, stable_page_id, section_key, author_kind,
            origin, verified, body, annotation_version, updated_at, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           (SELECT COALESCE(MAX(position), 0) + 1 FROM wiki_annotations))`,
      )
      .run(
        ANNOTATION_ID,
        WS,
        stablePageId,
        "dependencies",
        "human",
        "user",
        1,
        ANNOTATION_BODY,
        3,
        ANNOTATION_UPDATED_AT,
      );
  } finally {
    raw.close();
  }
}

function readAnnotationRaw(dbPath: string): Record<string, unknown> | undefined {
  const raw = new Database(dbPath);
  try {
    return raw
      .prepare(
        `SELECT id, workspace_id, stable_page_id, section_key, author_kind,
                origin, verified, body, annotation_version, updated_at
         FROM wiki_annotations WHERE id = ?`,
      )
      .get(ANNOTATION_ID) as Record<string, unknown> | undefined;
  } finally {
    raw.close();
  }
}

function withTempDb(action: (dbPath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "wiki-incremental-"));
  try {
    action(path.join(dir, "wiki.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("SQLite — atomik publish, stale, not koruma", () => {
  it("art arda iki reindex: eski projeksiyon sorgulanabilir kalır (stale) ve manuel not bit-bit korunur", () => {
    withTempDb((dbPath) => {
      const store = new SqliteWikiStore(dbPath);
      const seed = new Database(dbPath);
      seed
        .prepare(
          "INSERT INTO workspaces (id, root_path, created_at) VALUES (?, ?, ?)",
        )
        .run(WS, dbPath, CREATED_AT);
      seed.close();

      // 1) Full build A → publish.
      publishProjection(store, PROJECTION_A, T1);
      const pubA = store.getLatestPublishedWiki(WS);
      expect(pubA?.snapshot.id).toBe(PROJECTION_A.snapshot.id);

      const ordersPageId = PROJECTION_A.pages.find(
        (page) => page.title === "module:orders",
      )?.id;
      expect(ordersPageId).toBeDefined();
      insertAnnotationRaw(dbPath, ordersPageId!);

      // 2) REINDEX #1: incremental A→B → atomik publish (building→ready).
      const stepB = projectWikiIncremental({
        previous: PROJECTION_A,
        previousGraph: GRAPH_A,
        nextGraph: GRAPH_B,
        builtAt: T2,
      });
      publishProjection(store, stepB.projection, T2);
      const pubB = store.getLatestPublishedWiki(WS);
      expect(pubB?.snapshot.id).toBe(stepB.projection.snapshot.id);
      expect(pubB?.snapshot.graphSnapshotId).toBe(GRAPH_B.meta.id);

      // 3) REINDEX #2: incremental B→C → atomik publish.
      const stepC = projectWikiIncremental({
        previous: stepB.projection,
        previousGraph: GRAPH_B,
        nextGraph: GRAPH_C,
        builtAt: T3,
      });
      publishProjection(store, stepC.projection, T3);
      const pubC = store.getLatestPublishedWiki(WS);
      expect(pubC?.snapshot.id).toBe(stepC.projection.snapshot.id);

      // TŞ §16A.5 madde 6: eski projeksiyon sorgulanabilir kalır; stale=true
      // semantiği — eski wiki'nin kaynak graph'ı en güncel yayınlanmış
      // graph snapshot'tan farklıdır.
      const oldA = store.readWikiSnapshot(PROJECTION_A.snapshot.id);
      const oldB = store.readWikiSnapshot(stepB.projection.snapshot.id);
      expect(oldA).toBeDefined();
      expect(oldB).toBeDefined();
      expect(oldA?.pages).toHaveLength(PROJECTION_A.pages.length);
      expect(oldA?.snapshot.graphSnapshotId).toBe(GRAPH_A.meta.id);
      expect(oldA?.snapshot.graphSnapshotId).not.toBe(pubC?.snapshot.graphSnapshotId);
      expect(oldB?.snapshot.graphSnapshotId).not.toBe(pubC?.snapshot.graphSnapshotId);
      // Eski satırlar bozulmamıştır: A'nın page hash'leri bit-bit aynı.
      const oldAHashes = new Map(oldA?.pages.map((p) => [p.id, p.contentHash]));
      for (const [pageId, hash] of pageHashes(PROJECTION_A)) {
        expect(oldAHashes.get(pageId)).toBe(hash);
      }

      // TŞ §16A.10 "Kullanıcı notu": art arda İKİ reindex sonrası manuel
      // not bit-bit aynıdır (silinmez, üzerine yazılmaz, versiyon değişmez).
      const annotation = readAnnotationRaw(dbPath);
      expect(annotation).toBeDefined();
      expect(annotation?.["body"]).toBe(ANNOTATION_BODY);
      expect(annotation?.["annotation_version"]).toBe(3);
      expect(annotation?.["updated_at"]).toBe(ANNOTATION_UPDATED_AT);
      expect(annotation?.["stable_page_id"]).toBe(ordersPageId);
      expect(annotation?.["section_key"]).toBe("dependencies");
      expect(annotation?.["author_kind"]).toBe("human");
      expect(annotation?.["origin"]).toBe("user");
      expect(annotation?.["verified"]).toBe(1);

      store.close();
    });
  });

  it("atomik publish: building satırı okumalarda görünmez; publish hatası eski projeksiyonu bozmaz", () => {
    withTempDb((dbPath) => {
      const store = new SqliteWikiStore(dbPath);
      const seed = new Database(dbPath);
      seed
        .prepare(
          "INSERT INTO workspaces (id, root_path, created_at) VALUES (?, ?, ?)",
        )
        .run(WS, dbPath, CREATED_AT);
      seed.close();

      publishProjection(store, PROJECTION_A, T1);
      const stepB = projectWikiIncremental({
        previous: PROJECTION_A,
        previousGraph: GRAPH_A,
        nextGraph: GRAPH_B,
        builtAt: T2,
      });
      publishProjection(store, stepB.projection, T2);
      const stepC = projectWikiIncremental({
        previous: stepB.projection,
        previousGraph: GRAPH_B,
        nextGraph: GRAPH_C,
        builtAt: T3,
      });
      publishProjection(store, stepC.projection, T3);

      // Aynı deterministik WikiSnapshot kimliği için İKİNCİ publish:
      // building satırı açılır, sayfa yazılır — okumalar hâlâ eski
      // (yayımlanmış) snapshot'ı döndürür (building görünmez).
      const sid = store.beginWikiBuild({
        workspaceId: WS,
        graphSnapshotId: GRAPH_C.meta.id,
        revisionRef: REVISION_C,
        templateVersion: stepC.projection.snapshot.templateVersion,
        createdAt: T4,
      });
      store.addWikiPage(sid, {
        id: stepC.projection.pages[0]!.id,
        kind: stepC.projection.pages[0]!.kind,
        parentId: stepC.projection.pages[0]!.parentId,
        title: stepC.projection.pages[0]!.title,
        slug: stepC.projection.pages[0]!.slug,
        route: stepC.projection.pages[0]!.route,
        contentHash: stepC.projection.pages[0]!.contentHash,
        freshness: "fresh",
        coverage: { status: "no_data" },
      });
      const duringBuild = store.getLatestPublishedWiki(WS);
      expect(duringBuild?.snapshot.id).toBe(stepC.projection.snapshot.id);

      // Aynı wiki id UNIQUE → publish tek transaction içinde geri alınır.
      expect(() =>
        store.publishWiki(sid, stepC.projection.snapshot.id, "ready", T4),
      ).toThrow(/Wiki publish failed/i);
      expect(store.getLatestPublishedWiki(WS)?.snapshot.id).toBe(
        stepC.projection.snapshot.id,
      );
      expect(store.readWikiSnapshot(stepC.projection.snapshot.id)?.pages).toHaveLength(
        stepC.projection.pages.length,
      );

      // Building satırı dürüstçe failed'a kapatılır (K-013 #1); okumaya
      // yine girmez.
      store.failWikiBuild(sid, "test: duplicate publish reddi");
      const raw = new Database(dbPath);
      try {
        const failedCount = (
          raw
            .prepare(
              "SELECT COUNT(*) AS n FROM wiki_snapshots WHERE workspace_id = ? AND status = 'failed'",
            )
            .get(WS) as { n: number }
        ).n;
        expect(failedCount).toBe(1);
      } finally {
        raw.close();
      }
      expect(store.getLatestPublishedWiki(WS)?.snapshot.id).toBe(
        stepC.projection.snapshot.id,
      );

      store.close();
    });
  });
});
