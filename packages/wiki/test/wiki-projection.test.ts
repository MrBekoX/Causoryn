import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  createSnapshot,
  type SnapshotGraph,
} from "@causoryn/domain";

import {
  CoverageStatusSchema,
  WikiPageSectionSchema,
  WikiProjectionError,
  WikiSnapshotSchema,
  computeCoverageDelta,
  computeWikiCoverageDeltas,
  projectWiki,
  wikiProjectionCanonicalJson,
  wikiProjectionContentHash,
  WIKI_ROOT_CATEGORIES,
  WIKI_TEMPLATE_VERSION,
  type WikiPage,
  type WikiPageKind,
  type WikiProjection,
} from "../src/index.js";
import {
  buildWikiRootCategorySections,
  wikiBuildContext,
  wikiSlugify,
  WIKI_ROOT_CATEGORY_TEMPLATES,
} from "../src/projection.js";

/**
 * WikiProjectionEngine — test üçlüsü (TŞ v2.1 §16A.1, §16A.5, §16A.7,
 * §16A.10; docs/wiki-spec.md §3.0–3.2; K-013 kararları; sprint-4 W1).
 *
 * Pozitif: TS Orders fixture'ından beklenen sayfa ağacı — 12 kök kategori
 * taksonomi sırasıyla, Overview → APIs & Entry Points → POST /orders →
 * OrderService gezintisi, evidence referanslı bölümler (§16A.10 Hiyerarşi
 * satırı), no_data kategorilerde uydurulmuş içerik YOK.
 * Negatif: boş snapshot → 12 kök kategori de no_data, sıfır alt sayfa;
 * building/failed graph → red; geçersiz bölüm/kapsam değeri → şema reddi
 * (K-013: ayrı "error" durum adı yoktur).
 * Partial: yalnızca TS adapter destekli sayfa türleri → desteklenmeyen
 * kategoriler unsupported + açık uyarı; çözülemeyen kenar → bölüm partial.
 *
 * Determinizm: aynı girdi → bit-bit aynı WikiSnapshot JSON; motor saat
 * okumaz (builtAt girdidir); içerik karması sha256(canonical JSON).
 */

const WS = "ws_wiki";
const CREATED_AT = "2026-11-05T09:00:00.000Z";
const BUILT_AT = "2026-11-05T09:05:00.000Z";
const REVISION_REF = "rev-wiki-001";

function span(relativePath: string, startLine: number, endLine: number) {
  return {
    relativePath,
    startLine,
    endLine,
    sourceHash: `sha256:${relativePath}:${startLine}`,
  };
}

interface FixtureOptions {
  readonly state?: SnapshotGraph["meta"]["state"];
  readonly reverseNodes?: boolean;
}

/** TŞ §16A.10 "TS Orders fixture" karşılığı — orders/billing/shipping modülleri. */
function buildOrdersFixture(options: FixtureOptions = {}): SnapshotGraph {
  const nodes = [
    { kind: "Workspace" as const, qualifiedName: "orders-service" },
    { kind: "Project" as const, qualifiedName: "project:orders-service" },
    {
      kind: "Module" as const,
      qualifiedName: "module:orders",
      location: span("src/orders/index.ts", 1, 5),
      language: "typescript",
    },
    {
      kind: "Module" as const,
      qualifiedName: "module:billing",
      location: span("src/billing/index.ts", 1, 5),
      language: "typescript",
    },
    {
      kind: "Module" as const,
      qualifiedName: "module:shipping",
      location: span("src/shipping/index.ts", 1, 5),
      language: "typescript",
    },
    {
      kind: "Class" as const,
      qualifiedName: "OrderService",
      location: span("src/orders/order-service.ts", 8, 20),
      language: "typescript",
    },
    {
      kind: "Class" as const,
      qualifiedName: "BillingService",
      location: span("src/billing/billing-service.ts", 8, 20),
      language: "typescript",
    },
    {
      kind: "Method" as const,
      qualifiedName: "OrderService.CreateOrder",
      location: span("src/orders/order-service.ts", 12, 18),
      language: "typescript",
    },
    {
      kind: "Method" as const,
      qualifiedName: "BillingService.Charge",
      location: span("src/billing/billing-service.ts", 12, 18),
      language: "typescript",
    },
    {
      kind: "Endpoint" as const,
      qualifiedName: "POST /orders",
      location: span("src/orders/routes.ts", 3, 7),
      language: "typescript",
    },
    {
      kind: "Endpoint" as const,
      qualifiedName: "POST /billing/charge",
      location: span("src/billing/routes.ts", 3, 7),
      language: "typescript",
    },
    {
      kind: "Table" as const,
      qualifiedName: "table:orders",
      location: span("db/orders.sql", 1, 4),
    },
    {
      kind: "UnknownExternal" as const,
      qualifiedName: "external:paymentGateway",
    },
  ];

  const orderedNodes = options.reverseNodes === true ? [...nodes].reverse() : nodes;

  return createSnapshot({
    workspaceId: WS,
    revision: { id: REVISION_REF, sequence: 1 },
    configHash: "cfg-wiki-001",
    analyzerFingerprint: "ts-adapter@1",
    state: options.state ?? "ready",
    createdAt: CREATED_AT,
    nodes: orderedNodes,
    edges: [
      {
        kind: "CONTAINS" as const,
        from: { kind: "Workspace" as const, qualifiedName: "orders-service" },
        to: { kind: "Project" as const, qualifiedName: "project:orders-service" },
        resolution: "verified" as const,
        evidence: [
          {
            kind: "structural",
            span: span("package.json", 1, 10),
            analyzerId: "typescript",
            analyzerVersion: "5.9.3",
            rationale: "Workspace kökünde proje bildirimi",
          },
        ],
      },
      {
        kind: "CONTAINS" as const,
        from: { kind: "Project" as const, qualifiedName: "project:orders-service" },
        to: { kind: "Module" as const, qualifiedName: "module:orders" },
        resolution: "verified" as const,
        evidence: [
          {
            kind: "structural",
            span: span("src/orders/index.ts", 1, 5),
            analyzerId: "typescript",
            analyzerVersion: "5.9.3",
            rationale: "Proje dizini altında modül klasörü",
          },
        ],
      },
      {
        kind: "CONTAINS" as const,
        from: { kind: "Module" as const, qualifiedName: "module:orders" },
        to: { kind: "Class" as const, qualifiedName: "OrderService" },
        resolution: "verified" as const,
        evidence: [
          {
            kind: "declaration",
            span: span("src/orders/order-service.ts", 8, 20),
            analyzerId: "typescript",
            analyzerVersion: "5.9.3",
            rationale: "Sınıf bildirimi modül dosyasında",
          },
        ],
      },
      {
        kind: "CONTAINS" as const,
        from: { kind: "Module" as const, qualifiedName: "module:billing" },
        to: { kind: "Class" as const, qualifiedName: "BillingService" },
        resolution: "verified" as const,
        evidence: [
          {
            kind: "declaration",
            span: span("src/billing/billing-service.ts", 8, 20),
            analyzerId: "typescript",
            analyzerVersion: "5.9.3",
            rationale: "Sınıf bildirimi modül dosyasında",
          },
        ],
      },
      {
        kind: "DECLARES" as const,
        from: { kind: "Class" as const, qualifiedName: "OrderService" },
        to: { kind: "Method" as const, qualifiedName: "OrderService.CreateOrder" },
        resolution: "verified" as const,
        evidence: [
          {
            kind: "declaration",
            span: span("src/orders/order-service.ts", 12, 18),
            analyzerId: "typescript",
            analyzerVersion: "5.9.3",
            rationale: "Metot bildirimi",
          },
        ],
      },
      {
        kind: "DECLARES" as const,
        from: { kind: "Class" as const, qualifiedName: "BillingService" },
        to: { kind: "Method" as const, qualifiedName: "BillingService.Charge" },
        resolution: "verified" as const,
        evidence: [
          {
            kind: "declaration",
            span: span("src/billing/billing-service.ts", 12, 18),
            analyzerId: "typescript",
            analyzerVersion: "5.9.3",
            rationale: "Metot bildirimi",
          },
        ],
      },
      {
        kind: "ROUTES_TO" as const,
        from: { kind: "Endpoint" as const, qualifiedName: "POST /orders" },
        to: {
          kind: "Method" as const,
          qualifiedName: "OrderService.CreateOrder",
        },
        resolution: "verified" as const,
        evidence: [
          {
            kind: "route-binding",
            span: span("src/orders/routes.ts", 3, 7),
            analyzerId: "typescript",
            analyzerVersion: "5.9.3",
            rationale: "POST /orders rotası CreateOrder'a bağlanıyor",
          },
        ],
      },
      {
        kind: "ROUTES_TO" as const,
        from: { kind: "Endpoint" as const, qualifiedName: "POST /billing/charge" },
        to: {
          kind: "Method" as const,
          qualifiedName: "BillingService.Charge",
        },
        resolution: "verified" as const,
        evidence: [
          {
            kind: "route-binding",
            span: span("src/billing/routes.ts", 3, 7),
            analyzerId: "typescript",
            analyzerVersion: "5.9.3",
            rationale: "POST /billing/charge rotası Charge'a bağlanıyor",
          },
        ],
      },
      {
        kind: "DEPENDS_ON" as const,
        from: { kind: "Module" as const, qualifiedName: "module:orders" },
        to: { kind: "Module" as const, qualifiedName: "module:billing" },
        resolution: "heuristic" as const,
        evidence: [
          {
            kind: "import-graph",
            span: span("src/orders/order-service.ts", 1, 3),
            analyzerId: "typescript",
            analyzerVersion: "5.9.3",
            rationale: "orders → billing import'u sezgisel eşleştirildi",
          },
        ],
      },
      {
        // TŞ §16A.10 Belirsizlik: dinamik import çözülemiyor → partial.
        kind: "DEPENDS_ON" as const,
        from: { kind: "Module" as const, qualifiedName: "module:billing" },
        to: { kind: "Module" as const, qualifiedName: "module:shipping" },
        resolution: "unresolved" as const,
        evidence: [],
      },
      {
        kind: "READS" as const,
        from: {
          kind: "Method" as const,
          qualifiedName: "OrderService.CreateOrder",
        },
        to: { kind: "Table" as const, qualifiedName: "table:orders" },
        resolution: "verified" as const,
        evidence: [
          {
            kind: "data-access",
            span: span("src/orders/order-service.ts", 14, 16),
            analyzerId: "typescript",
            analyzerVersion: "5.9.3",
            rationale: "orders tablosundan okuma",
          },
        ],
      },
      {
        kind: "CALLS" as const,
        from: {
          kind: "Method" as const,
          qualifiedName: "OrderService.CreateOrder",
        },
        to: {
          kind: "UnknownExternal" as const,
          qualifiedName: "external:paymentGateway",
        },
        resolution: "unresolved" as const,
        evidence: [],
      },
    ],
  });
}

function project(graph: SnapshotGraph, overrides: Record<string, unknown> = {}): WikiProjection {
  return projectWiki(graph, {
    builtAt: BUILT_AT,
    ...overrides,
  });
}

function pagesByKind(projection: WikiProjection, kind: WikiPage["kind"]): WikiPage[] {
  return projection.pages.filter((page) => page.kind === kind);
}

function sectionsOf(projection: WikiProjection, pageId: string) {
  return projection.sections.filter((section) => section.pageId === pageId);
}

describe("WikiProjectionEngine — pozitif (TS Orders fixture)", () => {
  const graph = buildOrdersFixture();
  const projection = project(graph);

  it("12 kök kategoriyi taksonomi sırasıyla üretir (TŞ §16A.1)", () => {
    const roots = projection.pages.filter((page) => page.parentId === null);
    expect(roots.map((page) => page.title)).toEqual(
      WIKI_ROOT_CATEGORIES.map((category) => category.title),
    );
    expect(roots).toHaveLength(12);
  });

  it("WikiSnapshot üst verisi K-013 şemasıyla tutarlıdır", () => {
    expect(projection.snapshot.workspaceId).toBe(WS);
    expect(projection.snapshot.graphSnapshotId).toBe(graph.meta.id);
    expect(projection.snapshot.revisionRef).toBe(REVISION_REF);
    expect(projection.snapshot.status).toBe("ready");
    expect(projection.snapshot.builtAt).toBe(BUILT_AT);
    expect(projection.snapshot.templateVersion).toBe(WIKI_TEMPLATE_VERSION);
    expect(projection.snapshot.id.startsWith("wiki:")).toBe(true);
    const parsed = WikiSnapshotSchema.safeParse(projection.snapshot);
    expect(parsed.success).toBe(true);
  });

  it("Overview → APIs → POST /orders → OrderService gezintisini kurar (§16A.10)", () => {
    const apiRoot = projection.pages.find((page) => page.title === "APIs & Entry Points");
    expect(apiRoot).toBeDefined();
    const apiRootId = apiRoot?.id as string;
    expect(apiRoot?.coverage.status).toBe("complete");

    const orderApi = pagesByKind(projection, "api").find(
      (page) => page.title === "POST /orders",
    );
    expect(orderApi).toBeDefined();
    expect(orderApi?.parentId).toBe(apiRootId);
    expect(orderApi?.freshness).toBe("fresh");

    const handlerSections = sectionsOf(projection, orderApi?.id as string).filter(
      (section) => section.sectionKey === "handler",
    );
    expect(handlerSections).toHaveLength(1);
    const handler = handlerSections[0];
    expect(handler?.status).toBe("ok");
    expect(handler?.generatedMarkdown).toContain("OrderService.CreateOrder");
    // Kanıt: bölüm, ROUTES_TO kenarının kanıtına işaret eder (§16A.7).
    expect(handler?.evidenceRefs).toHaveLength(1);
    const routeEdge = graph.edges.find(
      (edge) =>
        edge.kind === "ROUTES_TO" &&
        graph.nodes.find((node) => node.id === edge.from)?.qualifiedName ===
          "POST /orders",
    );
    expect(handler?.evidenceRefs[0]?.evidenceId).toBe(routeEdge?.evidenceIds[0]);
    expect(handler?.evidenceRefs[0]?.relativePath).toBe("src/orders/routes.ts");
  });

  it("modül sayfaları components/dependencies bölümlerini kanıtla doldurur", () => {
    const ordersModule = pagesByKind(projection, "module").find(
      (page) => page.title === "module:orders",
    );
    expect(ordersModule).toBeDefined();
    const sections = sectionsOf(projection, ordersModule?.id as string);
    const components = sections.find((section) => section.sectionKey === "components");
    const dependencies = sections.find((section) => section.sectionKey === "dependencies");
    expect(components?.status).toBe("ok");
    expect(components?.generatedMarkdown).toContain("OrderService");
    expect(components?.evidenceRefs.length).toBeGreaterThan(0);
    expect(dependencies?.status).toBe("ok");
    // heuristic kenar dürüstçe etiketlenir (doğrulanmış link taklidi yok).
    expect(dependencies?.generatedMarkdown).toContain("[heuristic]");
  });

  it("data kategorisi tablo sayfasını READS kanıtıyla üretir", () => {
    const dataRoot = projection.pages.find((page) => page.title === "Data & Schemas");
    expect(dataRoot?.coverage.status).toBe("complete");
    const tablePage = pagesByKind(projection, "data").find(
      (page) => page.title === "table:orders",
    );
    expect(tablePage).toBeDefined();
    const access = sectionsOf(projection, tablePage?.id as string).find(
      (section) => section.sectionKey === "readers-writers",
    );
    expect(access?.status).toBe("ok");
    expect(access?.generatedMarkdown).toContain("READS");
    expect(access?.evidenceRefs).toHaveLength(1);
  });

  it("verisi olmayan kategorileri no_data olarak bırakır, İÇERİK UYDURMAZ (§16A.1)", () => {
    const emptyTitles = [
      "Business Flows",
      "Events & Integrations",
      "Contracts & Policies",
      "Tests & Quality",
      "Architecture Timeline",
      "Onboarding",
    ];
    for (const title of emptyTitles) {
      const page = projection.pages.find((entry) => entry.title === title);
      expect(page, title).toBeDefined();
      expect(page?.coverage.status, title).toBe("no_data");
      for (const section of sectionsOf(projection, page?.id as string)) {
        expect(section.status, `${title}/${section.sectionKey}`).toBe("no_data");
        expect(section.generatedMarkdown, `${title}/${section.sectionKey}`).toBe("");
        expect(section.evidenceRefs, `${title}/${section.sectionKey}`).toHaveLength(0);
      }
    }
  });

  it("coverage kategorisi çözülemeyen kenarı dürüstçe raporlar", () => {
    const coverageRoot = projection.pages.find(
      (page) => page.title === "Unresolved & Coverage",
    );
    expect(coverageRoot).toBeDefined();
    const unresolved = sectionsOf(projection, coverageRoot?.id as string).find(
      (section) => section.sectionKey === "unresolved",
    );
    expect(unresolved?.status).toBe("ok");
    expect(unresolved?.generatedMarkdown).toContain("external:paymentGateway");
    expect(unresolved?.generatedMarkdown).toContain("2");
    // Kanıtsız unresolved kenar için kanıt referansi UYDURULMAZ.
    expect(unresolved?.evidenceRefs).toHaveLength(0);
  });

  it("çıktı bütün olarak WikiProjection şemasından geçer ve dondurulmuştur", () => {
    const canonical = wikiProjectionCanonicalJson(projection);
    expect(canonical).toBe(canonicalJson(JSON.parse(canonical)));
    expect(Object.isFrozen(projection.snapshot)).toBe(true);
    expect(Object.isFrozen(projection.pages[0])).toBe(true);
  });

  it("sayfa contentHash'leri bölüm içeriğinden türetilir", () => {
    for (const page of projection.pages) {
      expect(page.contentHash.length).toBe(64);
    }
    const apiRoot = projection.pages.find((page) => page.title === "APIs & Entry Points");
    const businessRoot = projection.pages.find(
      (page) => page.title === "Business Flows",
    );
    // Verili kategori ile boş kategorinin karması ayrışır.
    expect(apiRoot?.contentHash).not.toBe(businessRoot?.contentHash);
  });

  it("snapshot içerik karması deterministiktir (W6 anahtarı)", () => {
    const rebuilt = project(buildOrdersFixture());
    expect(wikiProjectionContentHash(rebuilt)).toBe(
      wikiProjectionContentHash(projection),
    );
    // İki koşum bit-bit aynı WikiSnapshot JSON'u üretir: içerik karması
    // builtAt/id/warnings'i dışarıda bıraktığından iddianın asıl kanıtı
    // kanonik JSON'un tamamının (snapshot + pages + sections + warnings)
    // karakter düzeyinde eşliğidir (takım denetimi bulgusu 3).
    expect(wikiProjectionCanonicalJson(rebuilt)).toBe(
      wikiProjectionCanonicalJson(projection),
    );
    // Node sırası değişse de sonuç aynı (motor kanonik sıralar).
    const reversed = project(buildOrdersFixture({ reverseNodes: true }));
    expect(wikiProjectionContentHash(reversed)).toBe(
      wikiProjectionContentHash(projection),
    );
    expect(wikiProjectionCanonicalJson(reversed)).toBe(
      wikiProjectionCanonicalJson(projection),
    );
  });
});

describe("WikiProjectionEngine — negatif", () => {
  it("boş snapshot → 12 kök kategori de no_data, sıfır alt sayfa", () => {
    const empty = createSnapshot({
      workspaceId: "ws_empty",
      revision: { id: "rev-empty", sequence: 0 },
      configHash: "cfg-empty",
      analyzerFingerprint: "ts-adapter@1",
      state: "ready",
      createdAt: CREATED_AT,
      nodes: [],
      edges: [],
    });
    const projection = project(empty);
    const roots = projection.pages.filter((page) => page.parentId === null);
    expect(roots).toHaveLength(12);
    for (const root of roots) {
      expect(root.coverage.status).toBe("no_data");
      for (const section of sectionsOf(projection, root.id)) {
        expect(section.status).toBe("no_data");
        expect(section.generatedMarkdown).toBe("");
      }
    }
    expect(projection.pages).toHaveLength(12);
    expect(projection.warnings).toHaveLength(0);
  });

  it("building/failed graph snapshot'ı projeksiyona girmez (§9)", () => {
    for (const state of ["building", "failed"] as const) {
      const graph = buildOrdersFixture({ state });
      expect(() => project(graph)).toThrowError(WikiProjectionError);
      expect(() => project(graph)).toThrowError(/ready|partial/);
    }
  });

  it("graph girdisi domain şemasından geçmiyorsa reddedilir", () => {
    const broken = {
      meta: { ...buildOrdersFixture().meta, configHash: undefined },
      nodes: [],
      edges: [],
      evidence: [],
    };
    expect(() => project(broken as unknown as SnapshotGraph)).toThrowError(
      WikiProjectionError,
    );
  });

  it("geçersiz bölüm/kapsam değerleri şema tarafından reddedilir (K-013)", () => {
    // K-013 (1): ayrı "error" durum adı YOK.
    expect(
      WikiSnapshotSchema.shape.status.safeParse("error").success,
    ).toBe(false);
    // K-013 (3): bölüm status kümesi ok|partial|no_data.
    expect(
      WikiPageSectionSchema.shape.status.safeParse("unsupported").success,
    ).toBe(false);
    expect(
      WikiPageSectionSchema.safeParse({
        id: "section:x",
        pageId: "page:x",
        sectionKey: "handler",
        generatedMarkdown: "içerik",
        evidenceRefs: [],
        status: "error",
      }).success,
    ).toBe(false);
    // CoverageStatus: complete|partial|unsupported|no_data dışı reddedilir.
    expect(CoverageStatusSchema.safeParse("filled").success).toBe(false);
  });

  it("geçersiz coverageDelta değeri reddedilir", () => {
    expect(() =>
      computeCoverageDelta("no_data" as never, "ERROR" as never),
    ).toThrowError(WikiProjectionError);
  });
});

describe("WikiProjectionEngine — partial (adapter yetmezliği + belirsizlik)", () => {
  it("desteklenmeyen sayfa türleri unsupported + açık uyarı alır, alt sayfa üretilmez", () => {
    const graph = buildOrdersFixture();
    const projection = project(graph, {
      // TS adapter: event/contract veri türlerini üretmiyor (Faz D kontratlar).
      supportedPageKinds: [
        "overview",
        "architecture",
        "project",
        "module",
        "api",
        "business_flow",
        "test",
        "timeline",
        "onboarding",
        "coverage",
      ] satisfies WikiPage["kind"][],
    });

    const unsupportedTitles = ["Events & Integrations", "Contracts & Policies"];
    for (const title of unsupportedTitles) {
      const page = projection.pages.find((entry) => entry.title === title);
      expect(page?.coverage.status, title).toBe("unsupported");
      expect(page?.coverage.detail, title).toContain("is not supported by this adapter set");
    }
    // Desteklenmeyen kategoride ALT sayfa üretilmez (kök sayfa unsupported
    // olarak ağaçta kalır — §16A.1 açık görünüm).
    expect(
      pagesByKind(projection, "event").filter((page) => page.parentId !== null),
    ).toHaveLength(0);
    expect(
      pagesByKind(projection, "contract").filter(
        (page) => page.parentId !== null,
      ),
    ).toHaveLength(0);
    // Uyarılar deterministik: kategori sırasına göre iki desteklenmeyen kategori.
    expect(projection.warnings.some((warning) => warning.includes("Events"))).toBe(true);
    expect(projection.warnings.some((warning) => warning.includes("Contracts"))).toBe(true);
  });

  it("çözülemeyen kenar bölümü partial yapar, doğrulanmış taklit yapılmaz (§16A.10)", () => {
    const graph = buildOrdersFixture();
    const projection = project(graph);
    const shipping = pagesByKind(projection, "module").find(
      (page) => page.title === "module:shipping",
    );
    expect(shipping).toBeDefined();
    const dependencies = sectionsOf(projection, shipping?.id as string).find(
      (section) => section.sectionKey === "dependencies",
    );
    expect(dependencies?.status).toBe("partial");
    // Gelen kenar: billing → shipping; karşı taraf dürüstçe adıyla yazar.
    expect(dependencies?.generatedMarkdown).toContain("module:billing");
    expect(dependencies?.generatedMarkdown).toContain("[unresolved]");
    expect(shipping?.coverage.status).toBe("partial");
  });

  it("coverageDelta iki projeksiyon arasındaki kapsam geçişini hesaplar (K-013)", () => {
    const before = project(buildOrdersFixture(), { builtAt: "2026-11-05T08:00:00.000Z" });
    // İkinci projeksiyon: event kategorisi artık destekleniyor (adapter geldi).
    const after = project(buildOrdersFixture());

    const deltas = computeWikiCoverageDeltas(before, after);
    // Fixture'da event/contract kategorileri zaten verisiz → değişim yok;
    // delta yalnızca kapsam durumu değişen sayfalar için üretilir.
    for (const entry of deltas) {
      expect(entry.delta.previous).not.toBe(entry.delta.current);
    }

    // Tek sayfa geçişi: no_data → complete, mekanik gerekçeli.
    const delta = computeCoverageDelta("no_data", "complete");
    expect(delta.previous).toBe("no_data");
    expect(delta.current).toBe("complete");

    const withReason = computeCoverageDelta("complete", "partial", "yeni unresolved kenar");
    expect(withReason.reason).toBe("yeni unresolved kenar");

    // Aynı girdi → aynı çıktı (determinizm; kanonik JSON karşılaştırması).
    const deltasJson = (): ReturnType<typeof canonicalJson> =>
      canonicalJson(
        JSON.parse(
          JSON.stringify(computeWikiCoverageDeltas(before, after)),
        ) as Parameters<typeof canonicalJson>[0],
      );
    expect(deltasJson()).toBe(deltasJson());
  });
});

describe("kök kategori şablonları invariant", () => {
  it("buildWikiRootCategorySections ile WIKI_ROOT_CATEGORY_TEMPLATES kategori başına sectionKey dizisi birebir eşittir (12/12 kapsam çift yönlü)", () => {
    // Denetim bulgusu: buildWikiRootCategorySections switch'i (desteklenen
    // kategori yolu) ile WIKI_ROOT_CATEGORY_TEMPLATES haritası
    // (wikiUnsupportedRootSections — desteklenmeyen kategori yolu) iki
    // yerde manuel senkronize tutulur; ayrışma durumunda iki yol farklı
    // bölüm setleri üretirdi. Bu test iki yolun bölüm dizisini kilitler.
    const ctx = wikiBuildContext(buildOrdersFixture());
    const coveredKinds = new Set<WikiPageKind>();
    for (const [kind, templateKeys] of WIKI_ROOT_CATEGORY_TEMPLATES) {
      const drafts = buildWikiRootCategorySections(ctx, kind);
      expect(
        drafts.map((draft) => draft.sectionKey),
        `kategori ${kind}: iki yolun sectionKey dizisi eşit değil`,
      ).toEqual(templateKeys);
      coveredKinds.add(kind);
    }
    // 12 kök kategorinin tamamı şablon haritasında kapsanır (çift yönlü).
    for (const category of WIKI_ROOT_CATEGORIES) {
      expect(coveredKinds.has(category.kind), `kategori ${category.kind} şablonsuz`).toBe(true);
    }
    expect(coveredKinds.size).toBe(WIKI_ROOT_CATEGORIES.length);
  });
});

describe("wikiSlugify — CodeQL #21 tire kırpma paritesi ve ReDoS koruması", () => {
  it("uç durumları (boş, yalnız tire, karma ayraç) ve 50k tireli girdileri O(n) sürede normalize eder", () => {
    expect(wikiSlugify("")).toBe("page");
    expect(wikiSlugify("---")).toBe("page");
    expect(wikiSlugify("///...")).toBe("page");
    expect(wikiSlugify("POST /orders")).toBe("post-orders");
    expect(wikiSlugify("---Foo___Bar---")).toBe("foo-bar");

    const start = performance.now();
    expect(wikiSlugify("-".repeat(50_000))).toBe("page");
    expect(wikiSlugify(`${"-".repeat(25_000)}orders${"-".repeat(25_000)}`)).toBe("orders");
    expect(wikiSlugify(`a${"-".repeat(50_000)}b`)).toBe("a-b");
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(250);
  });
});
