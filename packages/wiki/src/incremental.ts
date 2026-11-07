import {
  canonicalJson,
  SnapshotSchema,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type JsonValue,
  type SnapshotGraph,
} from "@causoryn/domain";
import { z } from "zod";

import { wikiPageContentHash } from "./content-hash.js";
import { WikiProjectionError } from "./errors.js";
import {
  buildWikiNodePageSections,
  buildWikiRootCategorySections,
  deriveWikiSnapshotId,
  materializeWikiPage,
  planWikiChildPages,
  projectWiki,
  wikiBuildContext,
  wikiProjectionWarnings,
  wikiRootPageIdFor,
  wikiStructuralNoDataDetail,
  wikiUnsupportedRootSections,
} from "./projection.js";
import {
  WikiPageKindSchema,
  WikiProjectionSchema,
  type CoverageStatus,
  type WikiPage,
  type WikiPageKind,
  type WikiPageSection,
  type WikiProjection,
  type WikiSnapshot,
} from "./schema.js";
import { WIKI_ROOT_CATEGORIES, WIKI_TEMPLATE_VERSION } from "./taxonomy.js";

/**
 * Incremental invalidation — TŞ v2.1 §16A.5 "Canlı güncelleme /
 * dependency-aware invalidation" (madde 4-6) ve §16A.10 İnkremental kabul
 * satırı ("Sadece bir servis değişince etkilenen sayfalar yenilenir,
 * bağımsız sayfa contentHash'i korunur"); wiki/sprint-4.md W6.
 *
 * Sözleşme:
 * - BÖLÜM → SAYFA EŞLEMESİ: değişen GraphSnapshot girdisinde yalnızca
 *   etkilenen pageId'ler yenilenir. Seçim kuralı:
 *     · Değişen/eklenen/silinen node → o node'un alt sayfası.
 *     · Değişen/eklenen/silinen kenar → iki ucunun sayfaları (bölüm
 *       satırları kenar uçlarının görünen adlarını taşır; görünen ad
 *       node kimliğinde olduğundan uzak uç drift'i kimlik değişimidir ve
 *       aynı kurala düşer).
 *     · Herhangi bir graph içerik değişimi → GLOBAL kök sayfalar
 *       (Overview özet sayımları, dil sayımları, katman/modül/endpoint/
 *       olay/şema/sözleşme listeleri, test ve unresolved raporları tüm
 *       graph'ın agregatlarıdır). Yalnızca sabit no_data şablonu taşıyan
 *       kökler (Business Flows / Architecture Timeline / Onboarding)
 *       SEÇİLMEZ.
 *   Seçimde aşırı kapsama hash korumasıyla no-op'a düşer; küçük kaçırma
 *   YOKTUR (yukarıdaki kural alt sayfa içeriğinin tüm girdilerini kapsar).
 * - CONTENTHASH KORUMASI: seçilen sayfa yeniden üretilir; contentHash
 *   öncekiyle aynıysa sayfa no-op'tur (preserved) — kalıcı katmana
 *   YENİDEN YAZILMAZ (report.preservedPageIds, §16A.10).
 * - ATOMİK PUBLISH DİSLİPLİNİ: bu fonksiyon saf çekirdektir; yayımlama
 *   arayan katmandadır ve depo sözleşmesi (building satırı → tek
 *   transaction publish, TŞ §16A.5 madde 5) değişmeden kullanılır. Eski
 *   WikiSnapshot satırları publish'te silinmez: sorgular eski projeksiyonu
 *   okumaya devam eder; bayatlık (stale=true) kaynak graphSnapshotId
 *   farkından türetilir (madde 6).
 * - GRACEFUL FULL-REBUILD (§16A.5 son paragraf): incremental
 *   desteklenmeyen her durumda (parser config/analyzer parmak izi
 *   değişimi → reconciliation scan, şablon sürümü değişimi, desteklenen
 *   sayfa türü kümesi değişimi, önceki projeksiyonun bütünlüğünün
 *   doğrulanamaması) tam yeniden build yapılır ve AÇIK UYARI üretilir;
 *   sessiz kısmi sonuç yoktur (TŞ §16A.10: doğrulanmış taklit yok).
 * - CANONICAL EŞİTLİK: aynı girdi sonrası incremental çıktı, full build
 *   çıktısıyla bit-bit aynıdır (aynı şablonlar, aynı planlayıcı, aynı
 *   uyarı üreticisi paylaşılır).
 * - DETERMİNİZM: aynı girdiler → aynı rapor + aynı WikiSnapshot JSON;
 *   kümeler leksik sıralı döner; saat okunmaz (builtAt girdidir).
 */

/** İki GraphSnapshot arasındaki deterministik içerik farkı. */
export interface WikiGraphDiff {
  /** Aynı kimlik, farklı içerik (canonical JSON kıyası). */
  readonly changedNodeIds: readonly string[];
  readonly addedNodeIds: readonly string[];
  readonly removedNodeIds: readonly string[];
  /** Kenar kimliği uçlardan türediğinden aynı kimlikli kenarın
   * resolution/evidence farkı "changed" olarak raporlanır. */
  readonly changedEdgeIds: readonly string[];
  readonly addedEdgeIds: readonly string[];
  readonly removedEdgeIds: readonly string[];
  /** Kanıt kimliği içerikten türediğinden yalnızca küme farkı vardır. */
  readonly addedEvidenceIds: readonly string[];
  readonly removedEvidenceIds: readonly string[];
  /** TŞ §16A.5: parser config değişimi reconciliation scan gerektirir. */
  readonly configChanged: boolean;
  readonly analyzerChanged: boolean;
  /** Revision değişimi sayfa içeriğini etkilemez (snapshot üst verisidir). */
  readonly revisionChanged: boolean;
  readonly stateChanged: boolean;
  /** Hiçbir fark yok (no-op incremental koşusu). */
  readonly empty: boolean;
}

/**
 * WikiGraphDiff çalışma zamanı şeması (denetim bulgusu 7): rapor gövdesi
 * Zod ile doğrulanır; MCP yüzeyine bağlanırken tüketici bu şemayı
 * çıktı sözleşmesi olarak kullanabilir. NOT: motor içi `mode` değeri
 * "full-rebuild" K-013 #2 wiki_build mode enum'una (full|incremental)
 * AİT DEĞİLDİR — MCP yüzeyi mode="full" + fallbackReason alanıyla
 * eşler (packages/mcp-server services-wiki.ts wikiBuild).
 */
export const WikiGraphDiffSchema = z.strictObject({
  changedNodeIds: z.array(z.string()),
  addedNodeIds: z.array(z.string()),
  removedNodeIds: z.array(z.string()),
  changedEdgeIds: z.array(z.string()),
  addedEdgeIds: z.array(z.string()),
  removedEdgeIds: z.array(z.string()),
  addedEvidenceIds: z.array(z.string()),
  removedEvidenceIds: z.array(z.string()),
  configChanged: z.boolean(),
  analyzerChanged: z.boolean(),
  revisionChanged: z.boolean(),
  stateChanged: z.boolean(),
  empty: z.boolean(),
});

/** projectWikiIncremental raporu — deterministik sayfa seçimi + no-op dökümü. */
export interface WikiIncrementalBuildReport {
  readonly mode: "incremental" | "full-rebuild";
  /** Seçim/fallback gerekçesi (insan okur; testler kalıp eşler). */
  readonly reason: string;
  /** Girdi graph farkı (kanıt: seçim bu fark üzerinden kuruldu). */
  readonly diff: WikiGraphDiff;
  /** Bölüm → sayfa eşlemesinden seçilen sayfalar (leksik sıralı). */
  readonly affectedPageIds: readonly string[];
  /** contentHash gerçekten değişenler (kalıcı katmana yazılacaklar). */
  readonly regeneratedPageIds: readonly string[];
  /** Hash korunanlar — yeniden YAZILMAZ (no-op, §16A.10). */
  readonly preservedPageIds: readonly string[];
  /** Uyarılar: fallback gerekçesi + projeksiyon uyarıları. */
  readonly warnings: readonly string[];
}

/** Rapor gövdesinin çalışma zamanı şeması (denetim bulgusu 7). */
export const WikiIncrementalBuildReportSchema = z.strictObject({
  mode: z.enum(["incremental", "full-rebuild"]),
  reason: z.string().min(1),
  diff: WikiGraphDiffSchema,
  affectedPageIds: z.array(z.string()),
  regeneratedPageIds: z.array(z.string()),
  preservedPageIds: z.array(z.string()),
  warnings: z.array(z.string()),
});

export interface WikiIncrementalBuild {
  readonly projection: WikiProjection;
  readonly report: WikiIncrementalBuildReport;
}

export interface WikiIncrementalInput {
  /** Yayımlanmış önceki projeksiyon (aynı workspace, aynı şablon sürümü). */
  readonly previous: WikiProjection;
  /** Önceki projeksiyonun türetildiği graph (previous.snapshot.graphSnapshotId). */
  readonly previousGraph: SnapshotGraph;
  /** Değişen yeni GraphSnapshot (ready/partial). */
  readonly nextGraph: SnapshotGraph;
  /** ISO 8601 UTC zaman etiketi; kimliğe katılmaz (motor saat okumaz). */
  readonly builtAt: string;
  readonly revisionRef?: string;
  readonly supportedPageKinds?: readonly WikiPageKind[];
}

const BuiltAtSchema = z.iso.datetime();
const SupportedKindsSchema = z.array(WikiPageKindSchema);

function byString(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort(byString);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/* ---------------------------------------------------------------------------
 * Graph diff — node/edge kimliği domain'den deterministik türediği için
 * aynı kimlikli kayıtlar içerik kıyasıyla "changed" olur; node attributes
 * ve node location ile edge resolution/evidenceIds kimlik DIŞI alanlardır
 * (packages/domain ids.ts) ve tam olarak bu alanların değişimi "changed"
 * kümesini doldurur.
 * ------------------------------------------------------------------------- */

function nodeJsonValue(node: GraphNode): JsonValue {
  return {
    id: node.id,
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    ...(node.language === undefined ? {} : { language: node.language }),
    ...(node.location === undefined
      ? {}
      : {
          location: {
            relativePath: node.location.relativePath,
            startLine: node.location.startLine,
            endLine: node.location.endLine,
            sourceHash: node.location.sourceHash,
          },
        }),
    attributes: JSON.parse(canonicalJson(node.attributes as never)) as JsonValue,
  };
}

function edgeJsonValue(edge: GraphEdge): JsonValue {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    resolution: edge.resolution,
    evidenceIds: [...edge.evidenceIds],
    ...(edge.ambiguity === undefined
      ? {}
      : {
          ambiguity: {
            candidates: [...edge.ambiguity.candidates],
            reason: edge.ambiguity.reason,
          },
        }),
  };
}

/**
 * İki GraphSnapshot arasındaki deterministik fark. Her iki graph da domain
 * şemasından geçirilir (dangling/duplicate invariant'ları kalıcı depodan
 * gelen veri için de geçerlidir).
 */
export function diffWikiGraphs(
  previousGraph: SnapshotGraph,
  nextGraph: SnapshotGraph,
): WikiGraphDiff {
  for (const [label, graph] of [
    ["previousGraph", previousGraph],
    ["nextGraph", nextGraph],
  ] as const) {
    const parsed = SnapshotSchema.safeParse(graph);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new WikiProjectionError(
        "wiki/invalid-graph",
        `${label} şema doğrulaması başarısız: ${detail}`,
      );
    }
  }

  const diffById = <T extends { readonly id: string }>(
    previous: readonly T[],
    next: readonly T[],
    contentOf: (item: T) => string,
  ): { changed: string[]; added: string[]; removed: string[] } => {
    const prevById = new Map(previous.map((item) => [item.id, item]));
    const nextById = new Map(next.map((item) => [item.id, item]));
    const changed: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];
    for (const [id, prevItem] of prevById) {
      const nextItem = nextById.get(id);
      if (nextItem === undefined) {
        removed.push(id);
      } else if (contentOf(prevItem) !== contentOf(nextItem)) {
        changed.push(id);
      }
    }
    for (const id of nextById.keys()) {
      if (!prevById.has(id)) added.push(id);
    }
    return {
      changed: sortedStrings(changed),
      added: sortedStrings(added),
      removed: sortedStrings(removed),
    };
  };

  const nodes = diffById(previousGraph.nodes, nextGraph.nodes, (node) =>
    canonicalJson(nodeJsonValue(node)),
  );
  const edges = diffById(previousGraph.edges, nextGraph.edges, (edge) =>
    canonicalJson(edgeJsonValue(edge)),
  );

  const prevEvidence = new Set(
    previousGraph.evidence.map((item: Evidence) => item.id),
  );
  const nextEvidence = new Set(nextGraph.evidence.map((item: Evidence) => item.id));
  const addedEvidenceIds = sortedStrings(
    [...nextEvidence].filter((id) => !prevEvidence.has(id)),
  );
  const removedEvidenceIds = sortedStrings(
    [...prevEvidence].filter((id) => !nextEvidence.has(id)),
  );

  const configChanged =
    previousGraph.meta.configHash !== nextGraph.meta.configHash;
  const analyzerChanged =
    previousGraph.meta.analyzerFingerprint !== nextGraph.meta.analyzerFingerprint;
  const revisionChanged =
    previousGraph.meta.revision.id !== nextGraph.meta.revision.id ||
    previousGraph.meta.revision.sequence !== nextGraph.meta.revision.sequence;
  const stateChanged = previousGraph.meta.state !== nextGraph.meta.state;

  const empty =
    nodes.changed.length === 0 &&
    nodes.added.length === 0 &&
    nodes.removed.length === 0 &&
    edges.changed.length === 0 &&
    edges.added.length === 0 &&
    edges.removed.length === 0 &&
    addedEvidenceIds.length === 0 &&
    removedEvidenceIds.length === 0 &&
    !configChanged &&
    !analyzerChanged &&
    !revisionChanged &&
    !stateChanged;

  return deepFreeze({
    changedNodeIds: nodes.changed,
    addedNodeIds: nodes.added,
    removedNodeIds: nodes.removed,
    changedEdgeIds: edges.changed,
    addedEdgeIds: edges.added,
    removedEdgeIds: edges.removed,
    addedEvidenceIds,
    removedEvidenceIds,
    configChanged,
    analyzerChanged,
    revisionChanged,
    stateChanged,
    empty,
  });
}

/* ---------------------------------------------------------------------------
 * Bölüm → sayfa bağımlılık sınıfları (projection.ts şablonlarıyla birebir)
 * ------------------------------------------------------------------------- */

/**
 * GLOBAL kök sayfalar: bölümleri tüm graph'ın agregatlarını taşır
 * (sayım/liste). CONST kök sayfalar: yalnızca sabit no_data şablonu
 * (business_flow/timeline/onboarding verisi GraphSnapshot'ta taşınmaz).
 * Alt sayfa türleri (module/api-alt/event-alt/data/contract) kök değil;
 * seçim kuralı planWikiChildPages üzerinden çalışır.
 */
const ROOT_PAGE_DEPENDENCY: Readonly<
  Partial<Record<WikiPageKind, "graph-global" | "constant">>
> = {
  overview: "graph-global",
  architecture: "graph-global",
  project: "graph-global",
  api: "graph-global",
  business_flow: "constant",
  event: "graph-global",
  data: "graph-global",
  contract: "graph-global",
  test: "graph-global",
  timeline: "constant",
  onboarding: "constant",
  coverage: "graph-global",
};

/* ---------------------------------------------------------------------------
 * Önceki projeksiyon bütünlüğü + desteklenen tür kümesi karşılaştırması
 * ------------------------------------------------------------------------- */

function groupSectionsByPage(
  sections: readonly WikiPageSection[],
): Map<string, WikiPageSection[]> {
  const byPage = new Map<string, WikiPageSection[]>();
  for (const section of sections) {
    const list = byPage.get(section.pageId) ?? [];
    list.push(section);
    byPage.set(section.pageId, list);
  }
  return byPage;
}

/** Sayfa contentHash ↔ bölüm içerik tutarlılığı (bozuk previous saptama). */
function previousContentIntegrityFailure(previous: WikiProjection): string | null {
  const sectionsByPage = groupSectionsByPage(previous.sections);
  for (const page of previous.pages) {
    const sections = sectionsByPage.get(page.id);
    if (sections === undefined) {
      return `önceki projeksiyonda sayfanın bölümleri eksik: ${page.id}`;
    }
    if (wikiPageContentHash(sections) !== page.contentHash) {
      return `önceki sayfa contentHash'i bölümleriyle uyuşmuyor (contentHash bozuk/tağyiç edilmiş): ${page.id}`;
    }
  }
  return null;
}

/**
 * Fallback gerekçesi döndürür; null → incremental güvenli. Kontroller:
 * şema, previous↔previousGraph eşleşmesi, workspace, şablon sürümü,
 * parser config/analyzer (§16A.5 reconciliation), desteklenen sayfa türü
 * kümesi ve sayfa contentHash ↔ bölüm içerik tutarlılığı.
 */
function previousIntegrityFailure(
  previous: WikiProjection,
  previousGraph: SnapshotGraph,
  nextGraph: SnapshotGraph,
  nextSupportedKinds: ReadonlySet<WikiPageKind>,
): string | null {
  const previousParse = WikiProjectionSchema.safeParse(previous);
  if (!previousParse.success) {
    return "önceki projeksiyon şema doğrulaması geçemedi; içeriğe güvenilmez";
  }
  if (previous.snapshot.graphSnapshotId !== previousGraph.meta.id) {
    return `previous projeksiyon previousGraph'tan türetilmemiş (graphSnapshotId uyuşmuyor: ${previous.snapshot.graphSnapshotId} != ${previousGraph.meta.id})`;
  }
  if (previous.snapshot.workspaceId !== nextGraph.meta.workspaceId) {
    return `workspace değişti (${previous.snapshot.workspaceId} → ${nextGraph.meta.workspaceId}); cross-workspace taşima uydurma kimlik üretir`;
  }
  if (previous.snapshot.templateVersion !== WIKI_TEMPLATE_VERSION) {
    return `üretim şablonu sürümü değişti (templateVersion ${previous.snapshot.templateVersion} != ${WIKI_TEMPLATE_VERSION}); tüm sayfa hash'leri tanım gereği değişir`;
  }

  const contentFailure = previousContentIntegrityFailure(previous);
  if (contentFailure !== null) return contentFailure;

  // Desteklenen sayfa türü kümesi: önceki projeksiyonun unsupported kök
  // kategorilerinden türetilir; yeni kümeden farklıysa parametre değişmiştir.
  const previousRootByPageId = new Map(
    previous.pages
      .filter((page) => page.parentId === null)
      .map((page) => [page.id, page]),
  );
  const previouslyUnsupported: WikiPageKind[] = [];
  const currentlyUnsupported: WikiPageKind[] = [];
  for (const category of WIKI_ROOT_CATEGORIES) {
    const rootPage = previousRootByPageId.get(
      wikiRootPageIdFor(nextGraph.meta.workspaceId, category.key, category.kind),
    );
    if (rootPage !== undefined && rootPage.coverage.status === "unsupported") {
      previouslyUnsupported.push(category.kind);
    }
    if (!nextSupportedKinds.has(category.kind)) {
      currentlyUnsupported.push(category.kind);
    }
  }
  if (
    canonicalJson(sortedStrings(previouslyUnsupported)) !==
    canonicalJson(sortedStrings(currentlyUnsupported))
  ) {
    return `desteklenen sayfa türü kümesi değişti (supportedPageKinds); önceki unsupported=${canonicalJson(sortedStrings(previouslyUnsupported))} yeni=${canonicalJson(sortedStrings(currentlyUnsupported))}`;
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * projectWikiIncremental
 * ------------------------------------------------------------------------- */

/**
 * Rapor gövdesi savunma katmanı (denetim bulgusu 7): şemadan geçmeyen
 * rapor asla döndürülmez — motor çıktısı kendi sözleşmesini doğrular.
 */
function requireValidReport(
  report: WikiIncrementalBuildReport,
): WikiIncrementalBuildReport {
  const parsed = WikiIncrementalBuildReportSchema.safeParse(report);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new WikiProjectionError(
      "wiki/report-invariant-violation",
      `WikiIncrementalBuildReport invariant ihlali: ${detail}`,
    );
  }
  return report;
}

export function projectWikiIncremental(
  input: WikiIncrementalInput,
): WikiIncrementalBuild {
  // 1) Girdi savunma katmanı.
  const builtAtParse = BuiltAtSchema.safeParse(input.builtAt);
  if (!builtAtParse.success) {
    throw new WikiProjectionError(
      "wiki/invalid-input",
      "builtAt ISO 8601 UTC datetime olmalıdır",
    );
  }
  const supportedKinds: ReadonlySet<WikiPageKind> = new Set(
    input.supportedPageKinds === undefined
      ? WikiPageKindSchema.options
      : (() => {
          const kindsParse = SupportedKindsSchema.safeParse(input.supportedPageKinds);
          if (!kindsParse.success) {
            throw new WikiProjectionError(
              "wiki/invalid-input",
              "supportedPageKinds geçerli WikiPageKind değerleri içermelidir",
            );
          }
          return kindsParse.data;
        })(),
  );

  // 2) Yalnızca ready/partial hedef snapshot projeksiyona girer (TŞ §9) —
  //    full build ile AYNI koşul ve AYNI hata kodu.
  const nextState = input.nextGraph.meta.state;
  if (nextState !== "ready" && nextState !== "partial") {
    throw new WikiProjectionError(
      "wiki/snapshot-not-projectable",
      `Yalnızca ready/partial GraphSnapshot WikiSnapshot'a projeksiyonlanabilir (TŞ §9); gelen durum: ${nextState}`,
    );
  }

  // 3) Deterministik graph farkı (her iki graph şema doğrulamasından geçer).
  const diff = diffWikiGraphs(input.previousGraph, input.nextGraph);

  // 4) Fallback gerekçesi + graceful full-rebuild (§16A.5 son paragraf).
  const workspaceId = input.nextGraph.meta.workspaceId;
  const integrityFailure = previousIntegrityFailure(
    input.previous,
    input.previousGraph,
    input.nextGraph,
    supportedKinds,
  );
  const fallbackReason =
    integrityFailure ??
    (diff.configChanged || diff.analyzerChanged
      ? `parser yapılandırması veya analyzer parmak izi değişti (configHash/analyzerFingerprint); TŞ §16A.5 gereği reconciliation scan ile tam yeniden build gereklidir (configChanged=${String(diff.configChanged)}, analyzerChanged=${String(diff.analyzerChanged)})`
      : null);
  if (fallbackReason !== null) {
    return fullRebuildFallback(input, diff, fallbackReason);
  }

  const previous = input.previous;
  const ctx = wikiBuildContext(input.nextGraph);
  const wikiSnapshotId = deriveWikiSnapshotId(input.nextGraph.meta.id);
  const revisionRef = input.revisionRef ?? input.nextGraph.meta.revision.id;
  if (revisionRef.trim().length === 0) {
    throw new WikiProjectionError(
      "wiki/invalid-input",
      "revisionRef boş olamaz",
    );
  }

  // 5) Deterministik sayfa seçimi (bölüm → sayfa eşlemesi).
  const contentChanged =
    diff.changedNodeIds.length + diff.addedNodeIds.length + diff.removedNodeIds.length >
      0 ||
    diff.changedEdgeIds.length + diff.addedEdgeIds.length + diff.removedEdgeIds.length >
      0 ||
    diff.addedEvidenceIds.length + diff.removedEvidenceIds.length > 0;

  const affected = new Set<string>();
  if (contentChanged) {
    // GLOBAL kök sayfalar: herhangi bir içerik değişimi agregatları bozar.
    for (const category of WIKI_ROOT_CATEGORIES) {
      if (
        supportedKinds.has(category.kind) &&
        ROOT_PAGE_DEPENDENCY[category.kind] === "graph-global"
      ) {
        affected.add(
          wikiRootPageIdFor(workspaceId, category.key, category.kind),
        );
      }
    }
    // Değişen/eklenen/silinen kenarların uçları + değişen node'lar → alt
    // sayfalar (alt sayfa yalnızca kendi node'unu ve onun kenarlarının uç
    // görünen adlarını okur; görünen ad kimlikte olduğundan kural tamdır).
    const touchedNodes = new Set<string>([
      ...diff.changedNodeIds,
      ...diff.addedNodeIds,
      ...diff.removedNodeIds,
    ]);
    const edgeEndpoints = new Map<string, { from: string; to: string }>();
    for (const graph of [input.previousGraph, input.nextGraph]) {
      for (const edge of graph.edges) {
        edgeEndpoints.set(edge.id, { from: edge.from, to: edge.to });
      }
    }
    for (const edgeId of [
      ...diff.changedEdgeIds,
      ...diff.addedEdgeIds,
      ...diff.removedEdgeIds,
    ]) {
      const endpoints = edgeEndpoints.get(edgeId);
      if (endpoints === undefined) continue;
      touchedNodes.add(endpoints.from);
      touchedNodes.add(endpoints.to);
    }
    for (const entry of planWikiChildPages(input.nextGraph, supportedKinds)) {
      if (touchedNodes.has(entry.node.id)) {
        affected.add(entry.pageId);
      }
    }
  }

  // 6) Sayfa inşası: seçilenler yeniden üretilir; hash koruması no-op'u
  //    belirler (§16A.10: bağımsız sayfa contentHash'i korunur).
  const previousPageById = new Map(previous.pages.map((page) => [page.id, page]));
  const previousSectionsByPage = groupSectionsByPage(previous.sections);
  const pages: WikiPage[] = [];
  const sections: WikiPageSection[] = [];
  const regenerated: string[] = [];
  const preserved: string[] = [];

  const pushMaterialized = (
    materialized: { page: WikiPage; sections: readonly WikiPageSection[] },
    previousContentHash: string | undefined,
  ): void => {
    pages.push(materialized.page);
    sections.push(...materialized.sections);
    if (
      previousContentHash === undefined ||
      previousContentHash !== materialized.page.contentHash
    ) {
      regenerated.push(materialized.page.id);
    } else {
      preserved.push(materialized.page.id);
    }
  };

  const pushPreserved = (pageId: string, identity?: Partial<WikiPage>): boolean => {
    const previousPage = previousPageById.get(pageId);
    if (previousPage === undefined) return false;
    pages.push({ ...previousPage, wikiSnapshotId, ...identity });
    sections.push(...(previousSectionsByPage.get(pageId) ?? []));
    preserved.push(pageId);
    return true;
  };

  // Kök sayfalar: taksonomi sırasıyla.
  for (const category of WIKI_ROOT_CATEGORIES) {
    const pageId = wikiRootPageIdFor(workspaceId, category.key, category.kind);
    if (!affected.has(pageId)) {
      const carried = pushPreserved(pageId);
      if (!carried) {
        return fullRebuildFallback(
          input,
          diff,
          `önceki projeksiyonda korunacak kök sayfa eksik: ${pageId}`,
        );
      }
      continue;
    }
    const supported = supportedKinds.has(category.kind);
    const drafts = supported
      ? buildWikiRootCategorySections(ctx, category.kind)
      : wikiUnsupportedRootSections(category.kind);
    // HEAD semantiği (denetim bulgusu 1): yapısal detay yalnızca
    // desteklenen kategoride; unsupported detail ezilmez.
    const structuralDetail = supported
      ? wikiStructuralNoDataDetail(category.kind)
      : undefined;
    pushMaterialized(
      materializeWikiPage({
        pageId,
        wikiSnapshotId,
        kind: category.kind,
        parentId: null,
        title: category.title,
        slug: category.slug,
        route: `/wiki/${category.slug}`,
        sections: drafts,
        ...(supported
          ? {}
          : {
              coverageOverride: "unsupported" as CoverageStatus,
              coverageDetail: `sayfa türü '${category.kind}' bu adapter kümesi tarafından desteklenmiyor`,
            }),
        ...(structuralDetail === undefined ? {} : { coverageDetail: structuralDetail }),
      }),
      previousPageById.get(pageId)?.contentHash,
    );
  }

  // Alt sayfalar: paylaşılan planlayıcının kanonik sırasıyla.
  for (const entry of planWikiChildPages(input.nextGraph, supportedKinds)) {
    if (!affected.has(entry.pageId)) {
      const carried = pushPreserved(entry.pageId, {
        // Kimlik kitaplığı: değişmeyen node'un görünen adı/slug'ı aynıdır;
        // yine de güncel plandan mühürlenir (slug çakışması çözümü
        // sürümler arasında deterministik kalır).
        parentId: entry.parentId,
        title: entry.node.qualifiedName,
        slug: entry.slug,
        route: entry.route,
      });
      if (!carried) {
        return fullRebuildFallback(
          input,
          diff,
          `önceki projeksiyonda korunacak alt sayfa eksik: ${entry.pageId}`,
        );
      }
      continue;
    }
    const drafts = buildWikiNodePageSections(ctx, entry.kind, entry.node);
    pushMaterialized(
      materializeWikiPage({
        pageId: entry.pageId,
        wikiSnapshotId,
        kind: entry.kind,
        parentId: entry.parentId,
        title: entry.node.qualifiedName,
        slug: entry.slug,
        route: entry.route,
        sections: drafts,
      }),
      previousPageById.get(entry.pageId)?.contentHash,
    );
  }

  // 7) Snapshot üst verisi + uyarılar (full build ile AYNI üretici).
  const snapshot: WikiSnapshot = {
    id: wikiSnapshotId,
    workspaceId,
    graphSnapshotId: input.nextGraph.meta.id,
    revisionRef,
    status: nextState,
    builtAt: input.builtAt,
    templateVersion: WIKI_TEMPLATE_VERSION,
  };
  const projection: WikiProjection = {
    snapshot,
    pages,
    sections,
    warnings: wikiProjectionWarnings(pages, sections, supportedKinds, workspaceId),
  };

  const projectionParse = WikiProjectionSchema.safeParse(projection);
  if (!projectionParse.success) {
    const detail = projectionParse.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new WikiProjectionError(
      "wiki/projection-invariant-violation",
      `WikiProjection invariant ihlali: ${detail}`,
    );
  }

  return deepFreeze({
    projection,
    report: requireValidReport({
      mode: "incremental" as const,
      reason:
        affected.size === 0
          ? "graph farkı yok; hiçbir sayfa seçilmedi (no-op incremental)"
          : `bölüm → sayfa eşlemesinden ${String(affected.size)} sayfa seçildi; contentHash korumasıyla ${String(regenerated.length)} yenilendi`,
      diff,
      affectedPageIds: sortedStrings(affected),
      regeneratedPageIds: sortedStrings(regenerated),
      preservedPageIds: sortedStrings(preserved),
      warnings: [...projection.warnings],
    }),
  });
}

/**
 * Graceful tam yeniden build: çıktı projectWiki ile birebir (aynı girdi
 * alanları taşınır); uyarı açık — sessiz kısmi sonuç yoktur (§16A.10).
 */
function fullRebuildFallback(
  input: WikiIncrementalInput,
  diff: WikiGraphDiff,
  reason: string,
): WikiIncrementalBuild {
  const projection = projectWiki(input.nextGraph, {
    builtAt: input.builtAt,
    ...(input.revisionRef === undefined ? {} : { revisionRef: input.revisionRef }),
    ...(input.supportedPageKinds === undefined
      ? {}
      : { supportedPageKinds: input.supportedPageKinds }),
  });
  const previousHashByPageId = new Map(
    input.previous.pages.map((page) => [page.id, page.contentHash]),
  );
  const regenerated: string[] = [];
  const preserved: string[] = [];
  for (const page of projection.pages) {
    const previousHash = previousHashByPageId.get(page.id);
    if (previousHash === undefined || previousHash !== page.contentHash) {
      regenerated.push(page.id);
    } else {
      preserved.push(page.id);
    }
  }
  const warnings = [
    `incremental build desteklenmedi → tam yeniden build (full-rebuild) yapıldı: ${reason}`,
    ...projection.warnings,
  ];
  return deepFreeze({
    projection,
    report: requireValidReport({
      mode: "full-rebuild" as const,
      reason,
      diff,
      affectedPageIds: [],
      regeneratedPageIds: sortedStrings(regenerated),
      preservedPageIds: sortedStrings(preserved),
      warnings,
    }),
  });
}
