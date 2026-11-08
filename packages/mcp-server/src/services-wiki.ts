import {
  canonicalJson,
  sha256Hex,
  utf8Encode,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type SnapshotGraph,
} from "@causoryn/domain";
import {
  GraphRepositoryError,
  WORKING_TREE_REF,
  assertValidGitRef,
  runGit,
} from "@causoryn/graph";
import {
  WikiStoreError,
  SqliteWikiStore,
  type WikiFtsDocInput,
  type WikiLinkInput,
  type WikiPageInput,
  type WikiPageSectionInput,
  type WikiPageVersionInput,
  type WikiSnapshotRead,
} from "@causoryn/storage-sqlite";
import {
  BrokenLinkDiagnosticSchema,
  CoverageStatusSchema,
  EvidenceRefSchema,
  FreshnessSchema,
  WikiLinkKindSchema,
  WikiLinkSchema,
  WikiPageKindSchema,
  WikiPageSectionSchema,
  WikiProjectionError,
  WikiSearchError,
  WikiSearchResultSchema,
  WIKI_TEMPLATE_VERSION,
  buildWikiLinkIndex,
  computeWikiContractChanges,
  computeWikiCoverageDeltas,
  deriveWikiSnapshotId,
  projectWiki,
  projectWikiIncremental,
  resolveWikiLinks,
  wikiChildPageId,
  wikiContractSurfaceOf,
  type WikiLinkDraft,
  type WikiPageKind,
  type WikiProjection,
  type WikiSearchStore,
} from "@causoryn/wiki";
import { z } from "zod";

import { decodeCursor, encodeCursor } from "./cursor.js";
import { CausorynToolError, type CausorynToolErrorCode } from "./errors.js";
import { buildEnvelope, type Envelope } from "./envelope.js";
import {
  coverageOf,
  requireAuthorizedWorkspace,
  requireSnapshot,
  type ServiceDeps,
} from "./services.js";

/**
 * Wiki uygulama servisleri (sprint-4 W5 — W1–W4 çekirdeklerinin MCP yüzeyi;
 * TŞ v2.1 §16A.8 araç tablosu, §16A.1–§16A.4 davranış sözleşmeleri; K-013).
 *
 * Ortal davranış services.ts/services-architecture.ts ile aynıdır: workspace
 * yetkilendirmesi ilk adım (WORKSPACE_NOT_AUTHORIZED), çıktılar
 * deterministiktir (TŞ §8 invariant iv/vi), yazma disiplini beyanlıdır.
 *
 * Yazma izni (TŞ §16A.8 + wiki/mcp-tools.md yazma izin matrisi): 7 araçtan
 * yalnızca causoryn_wiki_build yazar ve YALNIZCA izinli Causoryn data-root
 * SQLite dosyasına (config.wiki.dataDbPath beyanı; beyan yoksa default deny
 * → PATH_DENIED). Kaynak workspace dosyalarına yazma imkânsızdır: veri kökü
 * başlangıçta allowRoot köklerinin DIŞINDA doğrulanır (context.ts). Diğer
 * altı araç salt okunurdur.
 *
 * Hata kodu tablosu (K-008 örüntüsü: uzantı kodu yalnızca TŞ listesinde
 * uygun kod yoksa basılır): wiki snapshot'ta olmayan sayfa/parentId/pageId
 * kimlikleri → WIKI_PAGE_NOT_FOUND (TŞ §10.1 SABİT kodu, s.9 — takım
 * denetimi bulgusuyla EVIDENCE_NOT_FOUND uzantı kodundan düzeltildi;
 * errors.ts başlığında ilk-kullanım kaydı var). WikiSnapshot kimliği
 * bulunamadığı durumlar EVIDENCE_NOT_FOUND'ta kalır (sayfa DEĞİL snapshot
 * kimliği — wiki-spec §4.2.5 "snapshot yok" durumu için TŞ'de özel kod
 * yoktur). Çözülemeyen revision/alias → INVALID_REVISION (K-013 #6 —
 * WIKI_REVISION_NOT_AVAILABLE yerine; alias kararına bire bir bağlıdır).
 * Bozuk link HATA DEĞİLDİR: WIKI_BROKEN_LINK yerine brokenLinkDiagnostics
 * veri yüzeyi (K-013 #4 — kayıt korunur + diagnostics üretilir, TŞ §16A.2
 * "hedef sessizce kaybolmaz"). Yayımlanmış wiki/graph snapshot yokluğu →
 * INDEX_NOT_READY; data-root beyansız yazma → PATH_DENIED; limit aşımı →
 * LIMIT_EXCEEDED; beyanlı ama desteklenmeyen filtreler → INVALID_ARGUMENT
 * (ADR-010 açık ret).
 *
 * Envelope snapsti: Wiki araçlarında envelope.snapshotId SERVİS EDİLEN
 * WikiSnapshot kimliğidir (diğer araçlarda graph snapshot kimliği taşınır —
 * Wiki araçlarının gerçeklik kaynağı WikiSnapshot'tır, sapma belgelenmiştir).
 * envelope.coverage yalnızca wiki_build'te dolum yapar (kaynak graph
 * snapshot'ının çözümlenme istatistiği); WikiSnapshotRead graph gövdesi
 * taşımadığından okuma araçlarında coverage null'dur (uydurma oran yok).
 * envelope.nextCursor sayfalı beş wiki aracında (get_tree/get_page/search/
 * get_links/get_versions) data.nextCursor ile AYNI değeri taşır — TŞ §10.1
 * standart envelope alanıdır ve map_system önceli izlenir; son sayfada her
 * iki düzeyde de null'dur (takım denetimi bulgusu 3).
 *
 * Determinizm: aynı girdiler → aynı WikiSnapshot JSON (TŞ §16A; wiki_build
 * builtAt'i saat enjeksiyonundan alır, kimliğe KATILMAZ — packages/wiki
 * content-hash sözleşmesi). Sayfalama K-013 #5: opak cursor (packages/
 * mcp-server/src/cursor.ts), limit default 50, max 200, nextCursor son
 * sayfada null.
 */

/** K-013 #5 limit değerleri. */
export const WIKI_TOOL_DEFAULT_LIMIT = 50;
export const WIKI_TOOL_MAX_LIMIT = 200;

/* ------------------------------------------------------------------ */
/* Ortak yardımcılar                                                   */
/* ------------------------------------------------------------------ */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireWikiStore(deps: ServiceDeps): SqliteWikiStore {
  if (deps.wikiStore === null) {
    throw new CausorynToolError(
      "INDEX_NOT_READY",
      "wiki veri kökü yapılandırılmamış (config wiki.dataDbPath beyanı yok); WikiSnapshot üretilip yayımlanmadan wiki okuma araçları kullanılamaz",
    );
  }
  return deps.wikiStore;
}

/** wiki_build yazma hedefi: beyan yoksa PATH_DENIED (default deny). */
function requireWikiStoreForWrite(deps: ServiceDeps): SqliteWikiStore {
  if (deps.wikiStore === null) {
    throw new CausorynToolError(
      "PATH_DENIED",
      "izinli wiki veri kökü beyanı yok (config wiki.dataDbPath); wiki_build yalnızca beyanlı Causoryn data-root'una yazabilir (default deny, TŞ §16A.8) ve kaynak workspace dosyalarına ASLA yazmaz",
    );
  }
  return deps.wikiStore;
}

/**
 * Publish edilmiş WikiSnapshot çözümü: snapshotId verilirse kimlik+workspace
 * (cross-workspace okuma yok; bulanamayan kimlik EVIDENCE_NOT_FOUND),
 * verilmezse workspace'in en güncel publish edilmiş snapshot'ı (yoksa
 * INDEX_NOT_READY — TŞ §9 publish kuralı).
 */
function requirePublishedWiki(
  deps: ServiceDeps,
  workspaceId: string,
  snapshotId?: string,
): WikiSnapshotRead {
  const wikiStore = requireWikiStore(deps);
  if (snapshotId !== undefined) {
    const read = wikiStore.readWikiSnapshot(snapshotId);
    if (read === undefined || read.snapshot.workspaceId !== workspaceId) {
      throw new CausorynToolError(
        "EVIDENCE_NOT_FOUND",
        `WikiSnapshot bulunamadı (workspace kapsamında): ${snapshotId}; wiki_get_tree/wiki_search çıktısındaki wikiSnapshotId değerlerini kullanın`,
      );
    }
    return read;
  }
  const latest = wikiStore.getLatestPublishedWiki(workspaceId);
  if (latest === undefined) {
    throw new CausorynToolError(
      "INDEX_NOT_READY",
      `workspace için yayımlanmış WikiSnapshot yok: ${workspaceId}; causoryn_wiki_build ile üretin`,
    );
  }
  return latest;
}

/**
 * TŞ §9 eski snapshot servisi: WikiSnapshot'ın kaynak graph'ı, workspace'in
 * en güncel yayınlanmış graph snapshot'ı DEĞİLSE wiki bayattır (stale=true).
 */
function wikiStaleOf(deps: ServiceDeps, wiki: WikiSnapshotRead): boolean {
  const latestGraph = deps.repository.getLatestPublished(wiki.snapshot.workspaceId);
  return (
    latestGraph !== undefined &&
    latestGraph.snapshot.meta.id !== wiki.snapshot.graphSnapshotId
  );
}

function wikiWarnings(deps: ServiceDeps, wiki: WikiSnapshotRead): string[] {
  const warnings: string[] = [];
  if (wikiStaleOf(deps, wiki)) {
    warnings.push(
      `WikiSnapshot bayat (stale=true): kaynak graph snapshot ${wiki.snapshot.graphSnapshotId} workspace'in en güncel yayınlanmış snapshot'ı değil; yeniden wiki_build önerilir`,
    );
  }
  if (wiki.snapshot.status === "partial") {
    warnings.push(
      "WikiSnapshot partial durumda; coverage eksik olabilir (TŞ §16A.5: ready/partial statüsü belirtilir)",
    );
  }
  return warnings;
}

function wikiEnvelopeStatus(wiki: WikiSnapshotRead): "ok" | "partial" {
  return wiki.snapshot.status === "partial" ? "partial" : "ok";
}

/** K-013 #5: opak cursor → offset; bozuk cursor INVALID_ARGUMENT. */
function requireCursorOffset(cursor: string): number {
  const offset = decodeCursor(cursor);
  if (offset === null) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "cursor çözülemedi; önceki yanıtın nextCursor değerini aynen kullanın",
    );
  }
  return offset;
}

/** K-013 #5 limit sözleşmesi: 1..200; aşımı LIMIT_EXCEEDED. */
function requireLimit(limit: number | undefined): number {
  const effective = limit ?? WIKI_TOOL_DEFAULT_LIMIT;
  if (effective > WIKI_TOOL_MAX_LIMIT) {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `limit ${String(effective)} max ${String(WIKI_TOOL_MAX_LIMIT)} tavanını aşıyor (K-013 #5); limiti düşürün`,
    );
  }
  return effective;
}

function pageWindow<T>(options: {
  readonly items: readonly T[];
  readonly limit: number;
  readonly cursor?: string | undefined;
}): { readonly window: readonly T[]; readonly nextCursor: string | null } {
  const offset = options.cursor === undefined ? 0 : requireCursorOffset(options.cursor);
  const window = options.items.slice(offset, offset + options.limit);
  const nextCursor =
    offset + options.limit < options.items.length
      ? encodeCursor(offset + options.limit)
      : null;
  return { window, nextCursor };
}

/* ------------------------------------------------------------------ */
/* Wiki çekirdek hataları → sabit tool kodu eşlemesi                   */
/* ------------------------------------------------------------------ */

interface WikiErrorContext {
  /** wiki_search'ta explicit snapshotId verilip verilmediği. */
  readonly snapshotIdGiven?: boolean;
}

/**
 * Wiki çekirdek sözleşme kodları → sabit tool hata kodu. Eşleme tek
 * noktadadır; modül kodları istemciye SIZMAZ (mesaj taşınır, kod sabittir).
 * Ortam hata sınıfı (storage-corrupt / publish-failed / driver-error)
 * INTERNAL_ERROR'a eşlenirken ORİJİNAL mesaj deps.logger'a (stderr) yazılır.
 */
export function wikiErrorToToolError(
  error: unknown,
  deps: ServiceDeps,
  context: WikiErrorContext = {},
): CausorynToolError {
  const code =
    error instanceof WikiStoreError ||
    error instanceof WikiProjectionError ||
    error instanceof WikiSearchError ||
    error instanceof GraphRepositoryError
      ? error.code
      : undefined;
  if (code !== undefined) {
    // Girdi/şema ihlalleri — istemci girdisini düzeltmelidir.
    // wiki/invalid-contract-surface (sprint-5 D7, K-013(7)): packages/wiki
    // contract-changes.ts assertSurface açık reddi — sözleşme yüzeyi
    // kaydının zorunlu string alanları (contractId/nodeKind/qualifiedName/
    // contentHash) boş veya eksik. MCP yolunda bugün ulaşılamazdır (yüzey
    // wikiContractSurfaceOf'tan üretilir: node.id/qualifiedName domain
    // NonEmptyString sözleşmesi, contentHash sha256) — eşleme savunma
    // derinliğidir: ortam hata kovasına (INTERNAL_ERROR + mesaj gizlemesi)
    // düşmek yerine girdi-ihlali sınıfında taşınır (K-008 örüntüsü; yeni
    // uzantı kodu İSTENMEZ, mevcut INVALID_ARGUMENT sabit kodu).
    if (
      code === "wiki/invalid-field" ||
      code === "wiki/invalid-input" ||
      code === "wiki/empty-query" ||
      code === "wiki/invalid-cursor" ||
      code === "wiki/invalid-limit" ||
      code === "wiki/invalid-coverage-delta" ||
      code === "wiki/invalid-contract-surface"
    ) {
      return new CausorynToolError("INVALID_ARGUMENT", errorText(error));
    }
    if (code === "wiki/snapshot-not-found") {
      return context.snapshotIdGiven === true
        ? new CausorynToolError("EVIDENCE_NOT_FOUND", errorText(error))
        : new CausorynToolError("INDEX_NOT_READY", errorText(error));
    }
    if (code === "wiki/unknown-workspace") {
      return new CausorynToolError("WORKSPACE_NOT_AUTHORIZED", errorText(error));
    }
    if (code === "wiki/build-already-active") {
      return new CausorynToolError(
        "INDEX_NOT_READY",
        errorText(error),
      );
    }
    if (code === "wiki/snapshot-not-projectable") {
      return new CausorynToolError("INDEX_NOT_READY", errorText(error));
    }
    // Offline export çekirdeğinin yetkilendirme reddi kodları (güvenlik
    // analizi bulgusu 3 — latent eşleme kapatıldı; kayıt packages/wiki
    // errors.ts başlığı + export.ts hata kodu dokümantasyonunda).
    // Öncül: services-architecture.ts export/output-* eşlemesi —
    // EXPORT_NOT_ALLOWED TŞ §10.1 SABİT kodu, PATH_DENIED taban kod;
    // yeni uzantı kodu İSTENMEZ (K-008 örüntüsü).
    if (code === "wiki/output-not-authorized") {
      return new CausorynToolError("EXPORT_NOT_ALLOWED", errorText(error));
    }
    if (code === "wiki/output-path-denied") {
      return new CausorynToolError("PATH_DENIED", errorText(error));
    }
    // Revizyon çözümleme (git-read katmanı; K-013 #6).
    if (
      code === "compare/invalid-ref" ||
      code === "compare/ref-not-found" ||
      code === "compare/git-command-failed"
    ) {
      return new CausorynToolError("INVALID_REVISION", errorText(error));
    }
    // Kalan kodlar ortam/tutarlılık hata sınıfıdır (corrupt-row,
    // publish-failed, storage-corrupt, driver-error, build-not-active,
    // duplicate-*, projection-invariant-violation …): istemciye genel
    // mesaj, detay stderr loguna.
    deps.logger(`wiki sözleşme hatası ${code} INTERNAL_ERROR'a eşlendi: ${errorText(error)}`);
    return new CausorynToolError(
      "INTERNAL_ERROR",
      "Beklenmeyen iç hata; ayrıntılar sunucu loglarında",
    );
  }
  throw error;
}

/** Wiki çekirdek işini sabit hata eşlemesiyle koşturur (senkron). */
function runWiki<T>(deps: ServiceDeps, work: () => T, context?: WikiErrorContext): T {
  try {
    return work();
  } catch (error) {
    if (
      error instanceof WikiStoreError ||
      error instanceof WikiProjectionError ||
      error instanceof WikiSearchError ||
      error instanceof GraphRepositoryError
    ) {
      throw wikiErrorToToolError(error, deps, context);
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* W5-B — wiki_build destek üretimi (link taslakları, FTS dokümanları) */
/* ------------------------------------------------------------------ */

/** TŞ §16A.2 kenar türü → WikiLink türü eşlemesi (kanıtlı kenardan link).
 * Diğer kenar türlerinin sayfa düzeyi karşılığı bu dilimde ÜRETİLMEZ
 * (uydurma link yok — TŞ §16A.2: her ilişki kaynak GraphEdge taşır). */
const EDGE_TO_LINK_KIND: ReadonlyMap<string, "DEPENDS_ON" | "CALLS"> = new Map([
  ["DEPENDS_ON", "DEPENDS_ON"],
  ["CALLS", "CALLS"],
]);

/** CHILD_SOURCES node türü → sayfa türü (projection.ts ile aynı eşleme). */
const NODE_PAGE_KIND: ReadonlyMap<string, WikiPageKind> = new Map([
  ["Module", "module"],
  ["Endpoint", "api"],
  ["Event", "event"],
  ["Topic", "event"],
  ["Queue", "event"],
  ["Table", "data"],
  ["ApiContract", "contract"],
  ["EventContract", "contract"],
  ["SchemaContract", "contract"],
  ["ContractVersion", "contract"],
]);

/** Link kimliği: canonical JSON'dan sha256 (determinizm, TŞ §8 invariant vi). */
function wikiLinkId(kind: string, fromPageId: string, toRef: string): string {
  return `wikilink:${sha256Hex(utf8Encode(canonicalJson([kind, fromPageId, toRef])))}`;
}

/** Sayfanın giden link kümesi karması (TŞ §16A.4 WikiPageVersion.linkSetHash). */
function linkSetHashOf(
  links: readonly {
    readonly id: string;
    readonly kind: string;
    readonly toPageId: string | null;
    readonly resolution: string;
  }[],
): string {
  const payload = [...links]
    .map((link) => ({
      id: link.id,
      kind: link.kind,
      toPageId: link.toPageId,
      resolution: link.resolution,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256Hex(utf8Encode(canonicalJson(payload)));
}

/**
 * Graph + projeksiyondan WikiLink taslakları (K-013 #4 girdisi):
 * - PARENT_OF: taksonomi ağacı (root → alt sayfa; yapısal → heuristic,
 *   evidence yok — verified evidencesız YASAK, TŞ §16A.7).
 * - DEPENDS_ON/CALLS: iki ucu da sayfalı graph kenarları; resolution kenar
 *   resolution'ını taşır; span'sız kanıt referansa çevrilmez (kanıt varsa
 *   taşınır). verified kenarın span'lı kanıtı yoksa link heuristic'e DÜŞER
 *   + uyarı (doğrulanmış link taklidi yapılmaz, TŞ §16A.10).
 * Taslaklar link kimliğine göre kanonik sıralanır ve kimliğe göre
 * tekilleştirilir (aynı ikili için birden çok kenar tek link üretir).
 */
function buildLinkDrafts(
  graph: SnapshotGraph,
  projection: WikiProjection,
  downgradeWarnings: string[],
): readonly WikiLinkDraft[] {
  const drafts: WikiLinkDraft[] = [];
  // PARENT_OF — taksonomi ağacı (projection parentId zinciri zaten doğrulu).
  for (const page of projection.pages) {
    if (page.parentId === null) continue;
    drafts.push({
      id: wikiLinkId("PARENT_OF", page.parentId, page.id),
      fromPageId: page.parentId,
      toRef: page.id,
      kind: "PARENT_OF",
      resolution: "heuristic",
      evidenceRefs: [],
    });
  }

  // Kenar türevi linkler: iki ucu da sayfalı olan kenarlar.
  const pageIdByNodeKey = new Map<string, string>();
  for (const page of projection.pages) {
    if (page.parentId === null) continue;
    pageIdByNodeKey.set(`${page.kind}|${page.title}`, page.id);
  }
  const pageKeyOf = (node: GraphNode): string | undefined => {
    const kind = NODE_PAGE_KIND.get(node.kind);
    return kind === undefined ? undefined : `${kind}|${node.qualifiedName}`;
  };
  const nodesById = new Map<string, GraphNode>(graph.nodes.map((node) => [node.id, node]));
  const evidenceById = new Map<string, Evidence>(graph.evidence.map((item) => [item.id, item]));
  const sortedEdges: GraphEdge[] = [...graph.edges].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const edge of sortedEdges) {
    const linkKind = EDGE_TO_LINK_KIND.get(edge.kind);
    if (linkKind === undefined) continue;
    const fromNode = nodesById.get(edge.from);
    const toNode = nodesById.get(edge.to);
    if (fromNode === undefined || toNode === undefined) continue;
    const fromKey = pageKeyOf(fromNode);
    const toKey = pageKeyOf(toNode);
    if (fromKey === undefined || toKey === undefined) continue;
    const fromPageId = pageIdByNodeKey.get(fromKey);
    const toPageId = pageIdByNodeKey.get(toKey);
    if (fromPageId === undefined || toPageId === undefined) continue;

    // Span'lı kanıt referansları (kanonik: evidenceId sıralı; span'sız
    // kanıt uydurulmaz — packages/wiki EvidenceRef sözleşmesi).
    const refs: {
      evidenceId: string;
      relativePath: string;
      startLine: number;
      endLine: number;
      sourceHash: string;
    }[] = [];
    for (const evidenceId of edge.evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (evidence?.span === undefined) continue;
      if (refs.some((ref) => ref.evidenceId === evidence.id)) continue;
      refs.push({
        evidenceId: evidence.id,
        relativePath: evidence.span.relativePath,
        startLine: evidence.span.startLine,
        endLine: evidence.span.endLine,
        sourceHash: evidence.span.sourceHash,
      });
    }
    refs.sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0));

    let resolution = edge.resolution;
    if (resolution === "verified" && refs.length === 0) {
      resolution = "heuristic";
      downgradeWarnings.push(
        `Wiki link ${linkKind} (${fromNode.qualifiedName} → ${toNode.qualifiedName}): verified kenarın span'lı kanıtı yok — link heuristic'e düşürüldü (doğrulanmış taklit yapılmaz, TŞ §16A.10)`,
      );
    }
    drafts.push({
      id: wikiLinkId(linkKind, fromPageId, toPageId),
      fromPageId,
      toRef: toPageId,
      kind: linkKind,
      resolution,
      evidenceRefs: refs,
    });
  }

  // Kanonik sıra + tekilleştirme (aynı link kimliği iki kez gelmesin).
  drafts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const unique: WikiLinkDraft[] = [];
  for (const draft of drafts) {
    if (unique.some((entry) => entry.id === draft.id)) continue;
    unique.push(draft);
  }
  return unique;
}

/** Projeksiyondan FTS dokümanları (TŞ §16A.7 WikiSearchIndex alanları). */
function buildFtsDocs(projection: WikiProjection): WikiFtsDocInput[] {
  const sectionsByPage = new Map<string, string[]>();
  for (const section of projection.sections) {
    const list = sectionsByPage.get(section.pageId) ?? [];
    if (section.generatedMarkdown.length > 0) list.push(section.generatedMarkdown);
    sectionsByPage.set(section.pageId, list);
  }
  return projection.pages.map((page) => {
    const body = (sectionsByPage.get(page.id) ?? []).join("\n\n");
    return {
      pageId: page.id,
      title: page.title,
      // Alt sayfa başlığı node qualifiedName'idir (projection sözleşmesi);
      // kök kategori sayfalarının sembol/route/modül karşılığı YOKTUR.
      qualifiedSymbol: page.parentId === null ? null : page.title,
      apiRoute: page.kind === "api" ? page.title : null,
      module: page.kind === "module" ? page.title : null,
      tags: null,
      body: body.length > 0 ? body : null,
    };
  });
}

/** WikiPage (wiki çekirdeği) → WikiPageInput (storage sözleşmesi). */
function toWikiPageInput(page: WikiProjection["pages"][number]): WikiPageInput {
  return {
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
  };
}

/* ------------------------------------------------------------------ */
/* W5-1 — causoryn_wiki_build                                          */
/* ------------------------------------------------------------------ */

export const WikiBuildInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** K-013 #2: mode = full | incremental. incremental W6 motoruyla
   * (projectWikiIncremental) yürütülür: yalnızca ilişkili pageId'ler
   * yenilenir (TŞ §16A.5 madde 4); önceki WikiSnapshot/kaynak graph yoksa
   * veya motor fallback kararı verirse (reconciliation) graceful full
   * build + data.fallbackReason (denetim bulgusu 3/4). */
  mode: z.enum(["full", "incremental"]),
  /** TŞ §10.2 "scope?": bu dilimde desteklenmiyor (açık ret). */
  scope: z.string().min(1).optional(),
  /** TŞ §16A.4 revision descriptor; verilmezse graph meta revision.id. */
  revision: z.string().min(1).optional(),
});

export const WikiBuildDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  graphSnapshotId: z.string(),
  revisionRef: z.string(),
  status: z.enum(["ready", "partial"]),
  /**
   * YÜRÜTÜLEN mod (K-013 #2 enum; denetim bulgusu 4): motor içi
   * "full-rebuild" kararı yüzeyde mode="full" + fallbackReason olarak
   * eşlenir — enum dışı değer yüzeye sızmaz.
   */
  mode: z.enum(["full", "incremental"]),
  /** Yalnızca mode=full'a degrade edilmiş incremental isteğinde dolu. */
  fallbackReason: z.string().optional(),
  pagesRegenerated: z.number().int().nonnegative(),
  sectionsRegenerated: z.number().int().nonnegative(),
  linksRegenerated: z.number().int().nonnegative(),
  brokenLinks: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});

/**
 * causoryn_wiki_build (TŞ §16A.8; K-013 #1/#2/#4): yetkili workspace için
 * WikiProjection üretir ve YALNIZCA izinli data-root SQLite dosyasına
 * (wiki.dataDbPath) storage adapter (SqliteWikiStore) üzerinden, atomik
 * publish ile yazar. Kaynak workspace dosyalarına yazma imkânsızdır.
 *
 * - Kaynak: yalnızca ready/partial GraphSnapshot projeksiyona girer (TŞ §9);
 *   yayınlanmış graph yoksa INDEX_NOT_READY.
 * - mode=full: tüm sayfalar yeniden üretilir.
 * - mode=incremental (TŞ §16A.5 madde 4; W6 motoru
 *   projectWikiIncremental): bölüm → sayfa eşlemesiyle yalnızca ilişkili
 *   pageId'ler yenilenir; contentHash korunan sayfalar no-op'tur.
 *   Önceki WikiSnapshot yok ya da önceki kaynak graph okunamıyorsa
 *   graceful full build + data.fallbackReason (dürüst degrade; sessiz
 *   yok sayma yok). Motor içi "full-rebuild" kararı yüzeyde mode="full"
 *   + fallbackReason'a eşlenir (K-013 #2 enum disiplini; bulgusu 4).
 * - Sayfalar + bölümler + linkler + sayfa sürümleri + wiki_fts AYNI
 *   building satırına yazılır; publish tek transaction (TŞ §16A.5 madde 5);
 *   yazım hatasında failWikiBuild ile building satırı failed'a kapanır
 *   (K-013 #1: ayrı 'error' adı yok).
 * - K-013 #4: çözümlenemeyen link toPageId=null ile korunur + diagnostics
 *   üretilir; brokenLinks sayısı çıktıda raporlanır.
 * - Aynı graph snapshot için zaten yayımlanmış WikiSnapshot varsa ikinci
 *   build idempotent no-op'tur (aynı deterministik kimlik UNIQUE publish
 *   çökmesi yerine dürüstçe raporlanır).
 */
export async function wikiBuild(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof WikiBuildInputSchema>,
): Promise<Envelope> {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);

  if (input.scope !== undefined) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      `scope dar kapsamlı wiki build bu araç yüzeyinde desteklenmiyor (${input.scope}); wiki şimdilik tüm yayınlanmış snapshot için üretilir`,
    );
  }

  const graphRead = requireSnapshot(deps, workspaceId);
  const wikiStore = requireWikiStoreForWrite(deps);

  if (input.mode === "incremental") {
    return wikiBuildIncremental(
      deps,
      requestId,
      input,
      workspaceId,
      graphRead,
      wikiStore,
    );
  }
  return wikiBuildFull(
    deps,
    requestId,
    input,
    workspaceId,
    graphRead,
    wikiStore,
    undefined,
  );
}

/** Degrade uyarısının tek metni (testler /full-rebuild|tam yeniden build/ eşler). */
function incrementalFallbackWarning(reason: string): string {
  return `incremental build desteklenmedi → tam yeniden build (full-rebuild) yapıldı: ${reason}`;
}

/**
 * mode=incremental yürütmesi (TŞ §16A.5 madde 4-6; denetim bulgusu 3).
 * Önceki WikiSnapshot ve onun kaynak graph'ı çözülür; ikisi de elverişliyse
 * W6 motoru (projectWikiIncremental) çalışır — preserved sayfaların satır
 * içerikleri önceki snapshot ile bit-bit aynıdır (contentHash koruması).
 * Elverişsizse graceful full build + fallbackReason.
 */
async function wikiBuildIncremental(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof WikiBuildInputSchema>,
  workspaceId: string,
  graphRead: Awaited<ReturnType<typeof requireSnapshot>>,
  wikiStore: SqliteWikiStore,
): Promise<Envelope> {
  const existing = wikiStore.getLatestPublishedWiki(workspaceId);
  if (existing === undefined) {
    return wikiBuildFull(
      deps,
      requestId,
      input,
      workspaceId,
      graphRead,
      wikiStore,
      "mode=incremental istendi ancak workspace için yayımlanmış WikiSnapshot yok; ilk build full olarak yürütüldü",
    );
  }

  const previousGraphRead = deps.repository.getSnapshot(
    existing.snapshot.graphSnapshotId,
  );
  if (previousGraphRead === undefined) {
    return wikiBuildFull(
      deps,
      requestId,
      input,
      workspaceId,
      graphRead,
      wikiStore,
      `önceki WikiSnapshot'ın kaynak graph snapshot'ı okunamıyor (${existing.snapshot.graphSnapshotId}); TŞ §16A.5 gereği tam yeniden build gereklidir`,
    );
  }

  // Idempotent no-op: aynı graph snapshot → aynı deterministik wiki
  // kimliği (TŞ §16A.4); UNIQUE publish çökmesi yerine dürüst rapor.
  const deterministicWikiId = deriveWikiSnapshotId(graphRead.snapshot.meta.id);
  if (existing.snapshot.id === deterministicWikiId) {
    const brokenExisting = existing.links.filter((link) => link.toPageId === null).length;
    const idempotentWarnings = [
      `aynı graph snapshot için WikiSnapshot zaten yayımlanmış (${existing.snapshot.id}); idempotent no-op — sayfalar yeniden üretilmedi (TŞ §16A.4 deterministik türetim)`,
      ...wikiWarnings(deps, existing),
    ];
    return buildEnvelope({
      requestId,
      workspaceId,
      snapshotId: existing.snapshot.id,
      status: wikiEnvelopeStatus(existing),
      coverage: coverageOf(graphRead.snapshot),
      warnings: idempotentWarnings,
      data: {
        wikiSnapshotId: existing.snapshot.id,
        graphSnapshotId: existing.snapshot.graphSnapshotId,
        revisionRef: existing.snapshot.revisionRef,
        status: existing.snapshot.status,
        mode: "incremental",
        pagesRegenerated: 0,
        sectionsRegenerated: 0,
        linksRegenerated: 0,
        brokenLinks: brokenExisting,
        warnings: idempotentWarnings,
      },
    });
  }

  // W6 motoru: bölümler önceki projeksiyon okumasından, graph'lar
  // kalıcı depo okumalarından gelir (TŞ §16A.5 madde 4: yalnızca ilişkili
  // pageId'ler yenilenir; contentHash koruması motor sözleşmesidir).
  const engine = runWiki(deps, () =>
    projectWikiIncremental({
      previous: projectionViewOf(existing),
      previousGraph: previousGraphRead.snapshot,
      nextGraph: graphRead.snapshot,
      builtAt: deps.clock(),
      ...(input.revision === undefined ? {} : { revisionRef: input.revision }),
    }),
  );
  if (engine.report.mode === "full-rebuild") {
    // Bulgusu 4 eşlemesi: motor içi "full-rebuild" → yüzeyde mode="full"
    // + fallbackReason (enum dışı değer sızmaz).
    return wikiBuildFull(
      deps,
      requestId,
      input,
      workspaceId,
      graphRead,
      wikiStore,
      engine.report.reason,
    );
  }

  const downgradeWarnings: string[] = [];
  const drafts = buildLinkDrafts(graphRead.snapshot, engine.projection, downgradeWarnings);
  const resolution = runWiki(deps, () =>
    resolveWikiLinks(drafts, {
      wikiSnapshotId: engine.projection.snapshot.id,
      pages: engine.projection.pages.map((page) => ({
        id: page.id,
        slug: page.slug,
        route: page.route,
      })),
    }),
  );

  const builtAt = deps.clock();
  const { published, brokenLinks } = writeAndPublishWikiProjection({
    deps,
    wikiStore,
    workspaceId,
    projection: engine.projection,
    resolution,
    builtAt,
  });

  // Rapor (denetim bulgusu 3 kanıt yüzeyi): yalnızca motorun seçtiği
  // pageId'ler yenilendi; preserved sayfalar önceki içerikle taşındı.
  const regeneratedSet = new Set(engine.report.regeneratedPageIds);
  const sectionsRegenerated = engine.projection.sections.filter(
    (section) => regeneratedSet.has(section.pageId),
  ).length;
  const warnings: string[] = [
    ...engine.projection.warnings,
    ...downgradeWarnings,
  ];
  if (brokenLinks > 0) {
    warnings.push(
      `${String(brokenLinks)} Wiki linki hedefi çözümlenemedi; kayıtlar toPageId=null ile korundu ve brokenLinkDiagnostics üretildi (K-013 #4)`,
    );
  }

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: published.snapshot.id,
    status: published.snapshot.status === "partial" ? "partial" : "ok",
    coverage: coverageOf(graphRead.snapshot),
    warnings,
    data: {
      wikiSnapshotId: published.snapshot.id,
      graphSnapshotId: published.snapshot.graphSnapshotId,
      revisionRef: published.snapshot.revisionRef,
      status: published.snapshot.status,
      mode: "incremental",
      pagesRegenerated: engine.report.regeneratedPageIds.length,
      sectionsRegenerated,
      linksRegenerated: published.links.length,
      brokenLinks,
      warnings: [...warnings],
    },
  });
}

/**
 * Projeksiyonu building WikiSnapshot satırlarına yazar ve publish eder —
 * wikiBuildIncremental ile wikiBuildFull gövdelerindeki birebir kopyanın
 * TEK noktaya alınması (denetim bulgusu: takım denetimi bulgusu 4'ün
 * (publishWiki hatasında failWikiBuild) iki kopyada ayrı ayrı sürülmesi
 * drift riskini kanıtlıyordu). Yürütme sırası ve semantik kopyayla
 * birebirdir: beginWikiBuild → addWikiPage/addWikiPageSection/addWikiLink
 * → sayfa sürümleri (linkSetHash) → FTS → publish durumu denetimi →
 * publishWiki (builtAt yayın saati ayrı deps.clock() okumasıdır, eski
 * davranışla aynı). Hata durumunda building satırı failed'a kapanır
 * (K-013 #1); CausorynToolError olduğu gibi çıkar, wiki çekirdek hatası
 * wikiErrorToToolError ile sabit koda eşlenir.
 */
function writeAndPublishWikiProjection(options: {
  readonly deps: ServiceDeps;
  readonly wikiStore: SqliteWikiStore;
  readonly workspaceId: string;
  readonly projection: WikiProjection;
  readonly resolution: ReturnType<typeof resolveWikiLinks>;
  readonly builtAt: string;
}): {
  readonly published: ReturnType<SqliteWikiStore["publishWiki"]>;
  readonly brokenLinks: number;
} {
  const { deps, wikiStore, workspaceId, projection, resolution, builtAt } = options;
  const sid = runWiki(deps, () =>
    wikiStore.beginWikiBuild({
      workspaceId,
      graphSnapshotId: projection.snapshot.graphSnapshotId,
      revisionRef: projection.snapshot.revisionRef,
      templateVersion: WIKI_TEMPLATE_VERSION,
      createdAt: builtAt,
    }),
  );

  try {
    for (const page of projection.pages) {
      wikiStore.addWikiPage(sid, toWikiPageInput(page));
    }
    for (const section of projection.sections) {
      const sectionInput: WikiPageSectionInput = {
        id: section.id,
        pageId: section.pageId,
        sectionKey: section.sectionKey,
        generatedMarkdown: section.generatedMarkdown,
        evidenceRefs: section.evidenceRefs.map((ref) => ({ ...ref })),
        status: section.status,
      };
      wikiStore.addWikiPageSection(sid, sectionInput);
    }
    for (const link of resolution.links) {
      const linkInput: WikiLinkInput = {
        id: link.id,
        fromPageId: link.fromPageId,
        toPageId: link.toPageId,
        kind: link.kind,
        resolution: link.resolution,
        evidenceRefs: link.evidenceRefs.map((ref) => ({ ...ref })),
      };
      wikiStore.addWikiLink(sid, linkInput);
    }
    const linksByPage = new Map<
      string,
      { id: string; kind: string; toPageId: string | null; resolution: string }[]
    >();
    for (const link of resolution.links) {
      const list = linksByPage.get(link.fromPageId) ?? [];
      list.push(link);
      linksByPage.set(link.fromPageId, list);
    }
    for (const page of projection.pages) {
      const pageLinks = linksByPage.get(page.id) ?? [];
      const versionInput: WikiPageVersionInput = {
        pageId: page.id,
        revisionRef: projection.snapshot.revisionRef,
        contentHash: page.contentHash,
        linkSetHash: linkSetHashOf(pageLinks),
        templateVersion: WIKI_TEMPLATE_VERSION,
        coverage: { status: page.coverage.status },
      };
      wikiStore.addWikiPageVersion(sid, versionInput);
    }
    wikiStore.indexWikiFts(sid, buildFtsDocs(projection));

    // K-013 #1: projeksiyon durumu yalnızca ready/partial olabilir (kaynak
    // graph ready/partial); publish sözleşmesi birebir eşlenir.
    const publishStatus = projection.snapshot.status;
    if (publishStatus !== "ready" && publishStatus !== "partial") {
      throw new CausorynToolError(
        "INDEX_NOT_READY",
        `Wiki projeksiyonu publish edilemez durumda: ${publishStatus} (TŞ §9 publish kuralı)`,
      );
    }
    const published = runWiki(deps, () =>
      wikiStore.publishWiki(sid, projection.snapshot.id, publishStatus, deps.clock()),
    );
    return {
      published,
      brokenLinks: resolution.brokenLinkDiagnostics.length,
    };
  } catch (error) {
    // K-013 #1: building satırı failed'a kapanır (ayrı 'error' adı yok);
    // yarım WikiSnapshot okuma yollarında asla görünmez. Takım denetimi
    // bulgusu 4: publishWiki hatası DAHİL — aksi halde building satırı
    // açık kalır ve aynı graph snapshot için wiki/build-already-active
    // kilidi kalıcılaşır (INDEX_NOT_READY telafi yolunu kapatır).
    try {
      wikiStore.failWikiBuild(sid, errorText(error));
    } catch (failError) {
      deps.logger(`wiki_build failWikiBuild başarısız: ${errorText(failError)}`);
    }
    if (error instanceof CausorynToolError) throw error;
    throw wikiErrorToToolError(error, deps);
  }
}

/**
 * mode=full çekirdeği (eski wikiBuild gövdesi). `fallbackReason` verildiğinde
 * istek incremental'den degrade edilmiştir: uyarı + data.fallbackReason
 * taşınır ve data.mode="full" yazılır (denetim bulgusu 3/4).
 */
async function wikiBuildFull(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof WikiBuildInputSchema>,
  workspaceId: string,
  graphRead: Awaited<ReturnType<typeof requireSnapshot>>,
  wikiStore: SqliteWikiStore,
  fallbackReason: string | undefined,
): Promise<Envelope> {
  const projection = runWiki(deps, () =>
    projectWiki(graphRead.snapshot, {
      builtAt: deps.clock(),
      ...(input.revision === undefined ? {} : { revisionRef: input.revision }),
    }),
  );

  // Idempotent no-op: aynı graph snapshot + templateVersion → aynı wiki
  // kimliği (TŞ §16A.4 iki düzey sürüm); zaten yayımlanmışsa yeniden üretim
  // gerekmez (UNIQUE publish çökmesi yerine dürüst rapor).
  const existing = wikiStore.getLatestPublishedWiki(workspaceId);
  if (existing !== undefined && existing.snapshot.id === projection.snapshot.id) {
    const brokenExisting = existing.links.filter((link) => link.toPageId === null).length;
    const idempotentWarnings = [
      ...(fallbackReason === undefined
        ? []
        : [incrementalFallbackWarning(fallbackReason)]),
      `aynı graph snapshot için WikiSnapshot zaten yayımlanmış (${existing.snapshot.id}); idempotent no-op — sayfalar yeniden üretilmedi (TŞ §16A.4 deterministik türetim)`,
      ...wikiWarnings(deps, existing),
    ];
    return buildEnvelope({
      requestId,
      workspaceId,
      snapshotId: existing.snapshot.id,
      status: wikiEnvelopeStatus(existing),
      coverage: coverageOf(graphRead.snapshot),
      warnings: idempotentWarnings,
      data: {
        wikiSnapshotId: existing.snapshot.id,
        graphSnapshotId: existing.snapshot.graphSnapshotId,
        revisionRef: existing.snapshot.revisionRef,
        status: existing.snapshot.status,
        mode: "full",
        ...(fallbackReason === undefined ? {} : { fallbackReason }),
        pagesRegenerated: 0,
        sectionsRegenerated: 0,
        linksRegenerated: 0,
        brokenLinks: brokenExisting,
        // Takım denetimi bulgusu 8: data.warnings daima-boş DEĞİLDİR —
        // envelope uyarılarıyla aynı içerik taşınır (wiki-spec §4.2.1).
        warnings: idempotentWarnings,
      },
    });
  }

  const downgradeWarnings: string[] = [];
  const drafts = buildLinkDrafts(graphRead.snapshot, projection, downgradeWarnings);
  const resolution = runWiki(deps, () =>
    resolveWikiLinks(drafts, {
      wikiSnapshotId: projection.snapshot.id,
      pages: projection.pages.map((page) => ({
        id: page.id,
        slug: page.slug,
        route: page.route,
      })),
    }),
  );

  const builtAt = deps.clock();
  const { published, brokenLinks } = writeAndPublishWikiProjection({
    deps,
    wikiStore,
    workspaceId,
    projection,
    resolution,
    builtAt,
  });

  const warnings: string[] = [
    ...(fallbackReason === undefined
      ? []
      : [incrementalFallbackWarning(fallbackReason)]),
    ...projection.warnings,
    ...downgradeWarnings,
  ];
  if (brokenLinks > 0) {
    warnings.push(
      `${String(brokenLinks)} Wiki linki hedefi çözümlenemedi; kayıtlar toPageId=null ile korundu ve brokenLinkDiagnostics üretildi (K-013 #4)`,
    );
  }

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: published.snapshot.id,
    status: published.snapshot.status === "partial" ? "partial" : "ok",
    coverage: coverageOf(graphRead.snapshot),
    warnings,
    data: {
      wikiSnapshotId: published.snapshot.id,
      graphSnapshotId: published.snapshot.graphSnapshotId,
      revisionRef: published.snapshot.revisionRef,
      status: published.snapshot.status,
      mode: "full",
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
      pagesRegenerated: published.pages.length,
      sectionsRegenerated: published.sections.length,
      linksRegenerated: published.links.length,
      brokenLinks,
      // Takım denetimi bulgusu 8: data.warnings daima-boş DEĞİLDİR —
      // envelope uyarılarıyla aynı içerik taşınır (wiki-spec §4.2.1).
      warnings: [...warnings],
    },
  });
}

/* ------------------------------------------------------------------ */
/* W5-2 — causoryn_wiki_get_tree                                       */
/* ------------------------------------------------------------------ */

export const WikiGetTreeInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** Yoksa workspace'in en güncel yayımlanmış WikiSnapshot'ı. */
  snapshotId: z.string().min(1).optional(),
  /** Alt ağaç kökü; verilmezse köklerden itibaren tam ağaç. */
  parentId: z.string().min(1).optional(),
  /** Alt ağaç derinlik tavanı (wiki-spec §4.2.2: 1..8). */
  depth: z.number().int().min(1).max(8).optional(),
  /** K-013 #5: default 50, max 200. */
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

export const WikiTreeNodeSchema = z.strictObject({
  pageId: z.string(),
  kind: WikiPageKindSchema,
  parentId: z.string().nullable(),
  title: z.string(),
  route: z.string(),
  coverage: z.strictObject({ status: CoverageStatusSchema }),
  freshness: FreshnessSchema,
  childCount: z.number().int().nonnegative(),
  depth: z.number().int().positive(),
});

export const WikiGetTreeDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  graphSnapshotId: z.string(),
  stale: z.boolean(),
  nodes: z.array(WikiTreeNodeSchema),
  totalNodes: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});

/**
 * causoryn_wiki_get_tree (TŞ §16A.8 "Hiyerarşi ve sayfa sıralaması; salt
 * okunur"): sayfa ağacı hiyerarşi + childCount + coverage/freshness ile
 * deterministik sırada (depo position sırası = taksonomi + pageId) döner.
 * depth: köklerden (veya parentId alt ağacından) itibaren derinlik tavanı.
 * no_data kategoriler dolgusuz LİSTELENİR (TŞ §16A.1: boş kategori
 * doldurulmaz — coverage.status raporu yeterlidir).
 */
export function wikiGetTree(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof WikiGetTreeInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);
  const wiki = requirePublishedWiki(deps, workspaceId, input.snapshotId);
  const limit = requireLimit(input.limit);

  const data = runWiki(deps, () => {
    const childCountByParent = new Map<string, number>();
    for (const page of wiki.pages) {
      if (page.parentId === null) continue;
      childCountByParent.set(
        page.parentId,
        (childCountByParent.get(page.parentId) ?? 0) + 1,
      );
    }
    const childrenByParent = new Map<string, string[]>();
    for (const page of wiki.pages) {
      const key = page.parentId ?? "";
      const list = childrenByParent.get(key) ?? [];
      list.push(page.id);
      childrenByParent.set(key, list);
    }
    const pageById = new Map(wiki.pages.map((page) => [page.id, page]));

    let subtreeRoots: string[];
    if (input.parentId === undefined) {
      subtreeRoots = wiki.pages.filter((page) => page.parentId === null).map((page) => page.id);
    } else {
      const root = pageById.get(input.parentId);
      if (root === undefined || root.wikiSnapshotId !== wiki.snapshot.id) {
        throw new CausorynToolError(
          "WIKI_PAGE_NOT_FOUND",
          `parentId bu WikiSnapshot'ta bulunamadı: ${input.parentId}`,
        );
      }
      subtreeRoots = [root.id];
    }

    const maxDepth = input.depth ?? Number.MAX_SAFE_INTEGER;
    const ordered: { pageId: string; depth: number }[] = [];
    const queue: { pageId: string; depth: number }[] = subtreeRoots.map((pageId) => ({
      pageId,
      depth: 1,
    }));
    while (queue.length > 0) {
      const entry = queue.shift();
      if (entry === undefined) break;
      if (entry.depth > maxDepth) continue;
      ordered.push(entry);
      const children = childrenByParent.get(entry.pageId) ?? [];
      for (const child of [...children].sort()) {
        queue.push({ pageId: child, depth: entry.depth + 1 });
      }
    }

    const nodes = ordered.map((entry) => {
      const page = pageById.get(entry.pageId);
      if (page === undefined) {
        throw new CausorynToolError(
          "INTERNAL_ERROR",
          "Wiki ağaç sıralaması tutarsız (sayfa bulunamadı)",
        );
      }
      return {
        pageId: page.id,
        kind: page.kind,
        parentId: page.parentId,
        title: page.title,
        route: page.route,
        coverage: { status: page.coverage.status },
        freshness: page.freshness,
        childCount: childCountByParent.get(page.id) ?? 0,
        depth: entry.depth,
      };
    });

    const { window, nextCursor } = pageWindow({ items: nodes, limit, cursor: input.cursor });
    return {
      nodes: window,
      totalNodes: nodes.length,
      nextCursor,
    };
  });

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: wiki.snapshot.id,
    status: wikiEnvelopeStatus(wiki),
    coverage: null,
    warnings: wikiWarnings(deps, wiki),
    // Takım denetimi bulgusu 3: TŞ §10.1 standart envelope nextCursor'u
    // sayfalı yanitlarda data.nextCursor ile AYNI değeri taşır (map_system
    // önceli; son sayfada her iki düzeyde de null).
    nextCursor: data.nextCursor,
    data: {
      wikiSnapshotId: wiki.snapshot.id,
      graphSnapshotId: wiki.snapshot.graphSnapshotId,
      stale: wikiStaleOf(deps, wiki),
      nodes: data.nodes,
      totalNodes: data.totalNodes,
      nextCursor: data.nextCursor,
    },
  });
}

/* ------------------------------------------------------------------ */
/* W5-3 — causoryn_wiki_get_page                                       */
/* ------------------------------------------------------------------ */

export const WikiGetPageInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  pageId: z.string().min(1),
  snapshotId: z.string().min(1).optional(),
  /** sectionKey filtresi (wiki-spec §4.2.3). */
  sections: z.array(z.string().min(1)).optional(),
  /** Bölüm sayfalama (K-013 #5). */
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

export const WikiGetPageDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  graphSnapshotId: z.string(),
  stale: z.boolean(),
  page: z.strictObject({
    pageId: z.string(),
    kind: WikiPageKindSchema,
    parentId: z.string().nullable(),
    title: z.string(),
    slug: z.string(),
    route: z.string(),
    contentHash: z.string(),
    freshness: FreshnessSchema,
    coverage: z.strictObject({
      status: CoverageStatusSchema,
      detail: z.string().optional(),
    }),
  }),
  /** Sayfanın TÜM bölümlerinden türetilen provenance (tekrarsız, evidenceId
   * leksik sıralı); sections filtresinden bağımsız tam kümeyi taşır. */
  sourceRefs: z.array(EvidenceRefSchema),
  sections: z.array(WikiPageSectionSchema),
  sectionsTotal: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});

/**
 * causoryn_wiki_get_page (TŞ §16A.8 "Sayfa bölümleri, provenance, coverage,
 * source refs; salt okunur"): generated layer bölümleri + evidenceRefs +
 * sourceRefs. Overlay (WikiAnnotation) BU ARAÇTA DÖNMEZ: TŞ §16A.6 overlay
 * okuma/yazma ayrı yerel UI/CLI + açık kullanıcı onayı akışıdır; anotasyon
 * yazan okuma aracı yoktur (docs/wiki-spec.md §5.2 izin matrisi).
 */
export function wikiGetPage(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof WikiGetPageInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);
  const wiki = requirePublishedWiki(deps, workspaceId, input.snapshotId);
  const limit = requireLimit(input.limit);

  const page = wiki.pages.find(
    (entry) => entry.id === input.pageId && entry.wikiSnapshotId === wiki.snapshot.id,
  );
  if (page === undefined) {
    throw new CausorynToolError(
      "WIKI_PAGE_NOT_FOUND",
      `Wiki sayfası bu WikiSnapshot'ta bulunamadı: ${input.pageId}; wiki_get_tree çıktısındaki pageId değerlerini kullanın`,
    );
  }

  const pageSections = wiki.sections.filter((section) => section.pageId === page.id);
  const filteredSections =
    input.sections === undefined
      ? pageSections
      : pageSections.filter((section) => input.sections?.includes(section.sectionKey) === true);

  // Tam sayfa provenance: bölüm kanıt referansları birleşimi (tekrarsız,
  // evidenceId leksik sıralı — determinizm).
  const sourceRefs = new Map<
    string,
    {
      evidenceId: string;
      relativePath: string;
      startLine: number;
      endLine: number;
      sourceHash: string;
    }
  >();
  for (const section of pageSections) {
    for (const ref of section.evidenceRefs) {
      if (!sourceRefs.has(ref.evidenceId)) {
        sourceRefs.set(ref.evidenceId, { ...ref });
      }
    }
  }
  const orderedSourceRefs = [...sourceRefs.values()].sort((a, b) =>
    a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0,
  );

  const { window, nextCursor } = pageWindow({
    items: filteredSections,
    limit,
    cursor: input.cursor,
  });

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: wiki.snapshot.id,
    status: wikiEnvelopeStatus(wiki),
    coverage: null,
    warnings: wikiWarnings(deps, wiki),
    // Takım denetimi bulgusu 3: envelope-düzeyi nextCursor data ile aynı.
    nextCursor,
    data: {
      wikiSnapshotId: wiki.snapshot.id,
      graphSnapshotId: wiki.snapshot.graphSnapshotId,
      stale: wikiStaleOf(deps, wiki),
      page: {
        pageId: page.id,
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
      },
      sourceRefs: orderedSourceRefs,
      sections: window.map((section) => ({
        id: section.id,
        pageId: section.pageId,
        sectionKey: section.sectionKey,
        generatedMarkdown: section.generatedMarkdown,
        evidenceRefs: section.evidenceRefs.map((ref) => ({ ...ref })),
        status: section.status,
      })),
      sectionsTotal: filteredSections.length,
      nextCursor,
    },
  });
}

/* ------------------------------------------------------------------ */
/* W5-4 — causoryn_wiki_search                                         */
/* ------------------------------------------------------------------ */

export const WikiSearchInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  query: z.string(),
  snapshotId: z.string().min(1).optional(),
  /** K-013 #5: default 50, max 200. */
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
  // --- TŞ §16A.3 filtre alanları: beyanlı ama bu dilimde DESTEKLENMİYOR
  // (W4 çekirdeği filtre almıyor) — şemayı geçen değerler AÇIK reddedilir
  // (ADR-010: sessiz yok sayma yok). ---
  kinds: z.array(WikiPageKindSchema).optional(),
  scope: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  revision: z.string().min(1).optional(),
  resolution: z.enum(["verified", "heuristic", "unresolved"]).optional(),
});

/** Arama çıktısı: W4 WikiSearchResult sözleşmesi + stale bayrağı. */
export const WikiSearchDataSchema = WikiSearchResultSchema.extend({
  stale: z.boolean(),
});

/**
 * causoryn_wiki_search (TŞ §16A.3, §16A.8 "FTS5 ve sembol eşleştirme,
 * filtre/pagination; salt okunur"): W4 WikiSearchStore çekirdeğiyle kaçışlı
 * çok alanlı FTS5 sorgu; sıralama exact sembol/route > başlık > modül >
 * BM25 > graph yakınlığı; relevance açıklaması matchedFields + evidenceIds.
 * Yakınlık ayağı verisi bu dilimde beslenmez → skippedRankLegs içinde
 * dürüst degrade notu döner (çekirdek sözleşmesi). matchedFields'e gizli
 * vektör/embedding skoru YAZILMAZ (kırmızı çizgi #1: embedding servisi yok).
 */
export function wikiSearch(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof WikiSearchInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);

  if (deps.wikiSearch === null) {
    // wiki.dataDbPath beyansız sunucuda ne wiki snapshot üretimi ne de
    // arama yüzeyi vardır: INDEX_NOT_READY dürüst koddur.
    throw new CausorynToolError(
      "INDEX_NOT_READY",
      "wiki veri kökü yapılandırılmamış (config wiki.dataDbPath beyanı yok); WikiSnapshot üretilip yayımlanmadan wiki arama kullanılamaz",
    );
  }
  const wikiSearchStore: WikiSearchStore = deps.wikiSearch;

  if (input.kinds !== undefined) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "kinds (pageKind) filtresi bu araç yüzeyinde henüz açılmadı (TŞ §16A.3 filtre seti W4/W5 dilimine aittir); sonucu istemci tarafında kind'a göre daraltın",
    );
  }
  if (input.scope !== undefined) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      `scope dar kapsamlı arama bu araç yüzeyinde desteklenmiyor (${input.scope})`,
    );
  }
  if (input.language !== undefined) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      `language filtresi bu araç yüzeyinde henüz açılmadı (${input.language})`,
    );
  }
  if (input.revision !== undefined) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      `revision filtresi bu araç yüzeyinde henüz açılmadı (${input.revision}); snapshotId ile wiki snapshot daraltması kullanılabilir`,
    );
  }
  if (input.resolution !== undefined) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      `resolution filtresi bu araç yüzeyinde henüz açılmadı (${input.resolution})`,
    );
  }

  // Explicit snapshotId: kimlik+workspace doğrulaması wiki store üzerinden
  // (bulanamayan kimlik EVIDENCE_NOT_FOUND); default: en güncel yayınlanmış
  // (yoksa INDEX_NOT_READY).
  const wiki = requirePublishedWiki(deps, workspaceId, input.snapshotId);
  const limit = requireLimit(input.limit);

  const result = runWiki(
    deps,
    () =>
      wikiSearchStore.search({
        workspaceId,
        query: input.query,
        limit,
        ...(input.snapshotId === undefined ? {} : { wikiSnapshotId: input.snapshotId }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }),
    { snapshotIdGiven: input.snapshotId !== undefined },
  );

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: result.wikiSnapshotId,
    status: wikiEnvelopeStatus(wiki),
    coverage: null,
    warnings: wikiWarnings(deps, wiki),
    // Takım denetimi bulgusu 3: envelope-düzeyi nextCursor data ile aynı.
    nextCursor: result.nextCursor,
    data: {
      ...result,
      stale: wikiStaleOf(deps, wiki),
    },
  });
}

/* ------------------------------------------------------------------ */
/* W5-5 — causoryn_wiki_get_links                                      */
/* ------------------------------------------------------------------ */

export const WikiGetLinksInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  pageId: z.string().min(1),
  /** TŞ §16A.2 direction örneği: "both" default (ADR-013: backlink ters
   * indeksten TÜRETİLİR, ikinci kayıt yazılmaz). */
  direction: z.enum(["incoming", "outgoing", "both"]).default("both"),
  linkKinds: z.array(WikiLinkKindSchema).optional(),
  snapshotId: z.string().min(1).optional(),
  /** K-013 #5: default 50, max 200. */
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

export const WikiGetLinksDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  graphSnapshotId: z.string(),
  stale: z.boolean(),
  pageId: z.string(),
  direction: z.enum(["incoming", "outgoing", "both"]),
  outgoing: z.array(WikiLinkSchema),
  incoming: z.array(WikiLinkSchema),
  /** K-013 #4: toPageId=null linklerden türetilen diagnostics; ham hedef
   * adı kalıcı modelde taşınmadığından toRef=null dürüstçe raporlanır. */
  brokenLinkDiagnostics: z.array(BrokenLinkDiagnosticSchema),
  totalMatching: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});

/**
 * causoryn_wiki_get_links (TŞ §16A.2, §16A.8 "Bağlantı/backlink ve evidence;
 * salt okunur"): outgoing + incoming (backlink ters indeksinden türetilmiş,
 * ADR-013) resolution + evidence ile; K-013 #4 broken-link diagnostics.
 * Sayfalama giden+gelen birleşik kanonik liste üzerindendir; pencere
 * yönüne geri ayrıştırılır (determinizm korunur).
 */
export function wikiGetLinks(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof WikiGetLinksInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);
  const wiki = requirePublishedWiki(deps, workspaceId, input.snapshotId);
  const limit = requireLimit(input.limit);

  const page = wiki.pages.find(
    (entry) => entry.id === input.pageId && entry.wikiSnapshotId === wiki.snapshot.id,
  );
  if (page === undefined) {
    throw new CausorynToolError(
      "WIKI_PAGE_NOT_FOUND",
      `Wiki sayfası bu WikiSnapshot'ta bulunamadı: ${input.pageId}; wiki_get_tree çıktısındaki pageId değerlerini kullanın`,
    );
  }

  const data = runWiki(deps, () => {
    // O(1) çift yönlü indeks (ADR-013; W3 çekirdeği).
    const index = buildWikiLinkIndex(
      wiki.links
        .filter((link) => link.wikiSnapshotId === wiki.snapshot.id)
        .map((link) => ({
          id: link.id,
          wikiSnapshotId: link.wikiSnapshotId,
          fromPageId: link.fromPageId,
          toPageId: link.toPageId,
          kind: link.kind,
          resolution: link.resolution,
          evidenceRefs: link.evidenceRefs.map((ref) => ({ ...ref })),
        })),
    );
    const matchesKind = (link: { kind: string }): boolean =>
      input.linkKinds === undefined || input.linkKinds.includes(link.kind as never);

    const outgoing = index.forwardLinks(page.id).filter(matchesKind);
    const incoming = index.backlinks(page.id).filter(matchesKind);
    const broken = index
      .brokenLinkDiagnostics()
      .filter((diagnostic) => diagnostic.fromPageId === page.id && matchesKind(diagnostic));

    // ADR-010 (sessiz yok sayma yok): direction girdisi İŞLEVSELDIR —
    // seçilmeyen yön hesaplanıp atılır; totalMatching yalnızca seçilen
    // yön(ler)i sayar (takım denetimi bulgusu 1).
    const sideSelected = (side: "outgoing" | "incoming"): boolean =>
      input.direction === "both" || input.direction === side;
    const combined: { side: "outgoing" | "incoming"; link: (typeof outgoing)[number] }[] = [
      ...(sideSelected("outgoing")
        ? outgoing.map((link) => ({ side: "outgoing" as const, link }))
        : []),
      ...(sideSelected("incoming")
        ? incoming.map((link) => ({ side: "incoming" as const, link }))
        : []),
    ];
    const { window, nextCursor } = pageWindow({
      items: combined,
      limit,
      cursor: input.cursor,
    });
    return {
      outgoing: window.filter((entry) => entry.side === "outgoing").map((entry) => entry.link),
      incoming: window.filter((entry) => entry.side === "incoming").map((entry) => entry.link),
      broken,
      totalMatching: combined.length,
      nextCursor,
    };
  });

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: wiki.snapshot.id,
    status: wikiEnvelopeStatus(wiki),
    coverage: null,
    warnings: wikiWarnings(deps, wiki),
    // Takım denetimi bulgusu 3: envelope-düzeyi nextCursor data ile aynı.
    nextCursor: data.nextCursor,
    data: {
      wikiSnapshotId: wiki.snapshot.id,
      graphSnapshotId: wiki.snapshot.graphSnapshotId,
      stale: wikiStaleOf(deps, wiki),
      pageId: page.id,
      direction: input.direction,
      outgoing: data.outgoing,
      incoming: data.incoming,
      brokenLinkDiagnostics: data.broken,
      totalMatching: data.totalMatching,
      nextCursor: data.nextCursor,
    },
  });
}

/* ------------------------------------------------------------------ */
/* W5-6 — causoryn_wiki_get_versions                                   */
/* ------------------------------------------------------------------ */

export const WikiGetVersionsInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** Verilirse sayfa sürümü (contentHash/linkSetHash/coverage ile);
   * verilmezse snapshot revizyon kaydı. */
  pageId: z.string().min(1).optional(),
  /** Commit SHA / branch / tag (branch hareketli takma ad, TŞ §16A.4);
   * K-013 #6: alias çözümlemesi salt-okunur git-read helper'ı ile.
   * TŞ §20 resource budget: 200 ref tavanı (her ref bir salt-okunur
   * cat-file çözümlemesi açar — takım denetimi bulgusu 6). */
  refs: z.array(z.string().min(1)).min(1).max(WIKI_TOOL_MAX_LIMIT).optional(),
  /** K-013 #5: default 50, max 200. */
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

export const WikiVersionEntrySchema = z.strictObject({
  pageId: z.string().nullable(),
  revisionRef: z.string(),
  wikiSnapshotId: z.string().nullable(),
  builtAt: z.string().nullable(),
  availability: z.enum(["available", "not_available"]),
  notAvailableReason: z.string().optional(),
  contentHash: z.string().optional(),
  linkSetHash: z.string().optional(),
  templateVersion: z.string().optional(),
  coverage: z.strictObject({ status: CoverageStatusSchema }).optional(),
});

export const WikiGetVersionsDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  stale: z.boolean(),
  versions: z.array(WikiVersionEntrySchema),
  nextCursor: z.string().nullable(),
});

/**
 * Salt-okunur git alias çözümlemesi (K-013 #6): ref biçim doğrulaması
 * (assertValidGitRef) + `git cat-file -t` (runGit beyaz listesi; shell
 * kapalı, checkout/reset/clean imkânsız). "working-tree" TŞ §13 tarafı
 * olarak git'siz çözülür.
 */
async function resolveRevisionAlias(
  repoRoot: string,
  ref: string,
): Promise<{ resolved: true; kind: string } | { resolved: false; reason: string }> {
  try {
    assertValidGitRef(ref);
  } catch (error) {
    return { resolved: false, reason: errorText(error) };
  }
  if (ref === WORKING_TREE_REF) {
    return { resolved: true, kind: "working-tree" };
  }
  try {
    const output = await runGit(repoRoot, ["cat-file", "-t", ref]);
    const kind = output.trim();
    if (kind.length === 0) {
      return { resolved: false, reason: `git cat-file -t boş çıktı döndürdü: ${ref}` };
    }
    return { resolved: true, kind };
  } catch (error) {
    return { resolved: false, reason: errorText(error) };
  }
}

/**
 * causoryn_wiki_get_versions (TŞ §16A.4, §16A.8 "Erişilebilir Git/snapshot
 * revizyonları; salt okunur"): veri kökünde TUTULAN yayımlanmış WikiSnapshot
 * revizyonu available raporlanır (pageId verilirse sayfa sürümü
 * contentHash/linkSetHash/templateVersion/coverage ile — TŞ §16A.4 WikiPageVersion
 * alanları). refs: K-013 #6 gereği her alias salt-okunur git-read ile
 * çözülür; çözülemeyen alias INVALID_REVISION döndürür (uydurma sürüm yok).
 * Veri kökünde revizyon kaydı olmayan çözümlenmiş ref → not_available +
 * gerekçe (shallow clone / cache eviction semantiğine uygun dürüst rapor;
 * geçmiş sayfanın varlığı sonsuz saklama taahhüdü değildir).
 */
export async function wikiGetVersions(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof WikiGetVersionsInputSchema>,
): Promise<Envelope> {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  const canonicalRoot = requireAuthorizedWorkspace(deps, workspaceId);
  const wiki = requirePublishedWiki(deps, workspaceId);
  const limit = requireLimit(input.limit);

  // Alias çözümlemesi ÖNCE: tek çözülemeyen ref tüm yanıtı
  // INVALID_REVISION yapar (compare_architecture geleneği; K-013 #6).
  let resolvedRefs: readonly { ref: string; kind: string }[] = [];
  if (input.refs !== undefined) {
    const resolved: { ref: string; kind: string }[] = [];
    for (const ref of input.refs) {
      const resolution = await resolveRevisionAlias(canonicalRoot, ref);
      if (!resolution.resolved) {
        throw new CausorynToolError(
          "INVALID_REVISION",
          `ref çözümlenemedi: ${ref} — ${resolution.reason}`,
        );
      }
      resolved.push({ ref, kind: resolution.kind });
    }
    resolvedRefs = resolved;
  }

  const versions: z.infer<typeof WikiVersionEntrySchema>[] = [];
  if (input.pageId !== undefined) {
    const version = wiki.versions.find((entry) => entry.pageId === input.pageId);
    if (version === undefined) {
      throw new CausorynToolError(
        "WIKI_PAGE_NOT_FOUND",
        `sayfa sürümü bu WikiSnapshot'ta bulunamadı: ${input.pageId}`,
      );
    }
    versions.push({
      pageId: version.pageId,
      revisionRef: version.revisionRef,
      wikiSnapshotId: wiki.snapshot.id,
      builtAt: wiki.snapshot.builtAt,
      availability: "available",
      contentHash: version.contentHash,
      linkSetHash: version.linkSetHash,
      templateVersion: version.templateVersion,
      coverage: { status: version.coverage.status },
    });
  } else {
    versions.push({
      pageId: null,
      revisionRef: wiki.snapshot.revisionRef,
      wikiSnapshotId: wiki.snapshot.id,
      builtAt: wiki.snapshot.builtAt,
      availability: "available",
    });
  }

  // refs: veri kökünde revizyon kaydı olanlar available; diğer çözümlenmiş
  // ref'ler not_available + gerekçe (TŞ §16A.4 not_available semantiği).
  for (const entry of resolvedRefs) {
    const held =
      versions.some(
        (version) => version.revisionRef === entry.ref && version.availability === "available",
      ) === true;
    if (held) continue;
    versions.push({
      pageId: null,
      revisionRef: entry.ref,
      wikiSnapshotId: null,
      builtAt: null,
      availability: "not_available",
      notAvailableReason:
        `çözümlenen revizyonda yayımlanmış WikiSnapshot kaydı yok (git ${entry.kind}); wiki_build koşusu bu revisionRef ile veri kökünde bulunamadı`,
    });
  }

  const { window, nextCursor } = pageWindow({ items: versions, limit, cursor: input.cursor });

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: wiki.snapshot.id,
    status: wikiEnvelopeStatus(wiki),
    coverage: null,
    warnings: wikiWarnings(deps, wiki),
    // Takım denetimi bulgusu 3: envelope-düzeyi nextCursor data ile aynı.
    nextCursor,
    data: {
      wikiSnapshotId: wiki.snapshot.id,
      stale: wikiStaleOf(deps, wiki),
      versions: window,
      nextCursor,
    },
  });
}

/* ------------------------------------------------------------------ */
/* W5-7 — causoryn_wiki_diff                                           */
/* ------------------------------------------------------------------ */

export const WikiDiffInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** wikiSnapshotId veya bu workspace'in yayımlanmış revisionRef'i. */
  base: z.string().min(1),
  target: z.string().min(1),
  /** Tek sayfa daraltması (wiki-spec §4.2.7). */
  pageId: z.string().min(1).optional(),
});

/** K-013 #7 gövdesi (sprint-5 D7'de kesinleşti): {contractId, changeKind, summary}
 * — üretici sözleşme packages/contracts contract-drift.ts ContractChangeRecord. */
export const WikiContractChangeSchema = z.strictObject({
  contractId: z.string(),
  changeKind: z.enum(["added", "removed", "modified"]),
  summary: z.string(),
});

export const WikiDiffDataSchema = z.strictObject({
  base: z.string(),
  target: z.string(),
  baseWikiSnapshotId: z.string(),
  targetWikiSnapshotId: z.string(),
  addedPages: z.array(z.string()),
  removedPages: z.array(z.string()),
  changedSections: z.array(
    z.strictObject({ pageId: z.string(), sectionKey: z.string() }),
  ),
  addedLinks: z.array(WikiLinkSchema),
  removedLinks: z.array(WikiLinkSchema),
  /** K-013 #7 gövdesi (D7): arka graph sözleşme yüzeyleri diff'i; kayıt
   * yoksa/arka graph çözümlenemediyse [] + dürüst not warnings'te. */
  contractChanges: z.array(WikiContractChangeSchema),
  /** K-013 #3 gövde: {previous, current, reason?}. */
  coverageDelta: z.array(
    z.strictObject({
      pageId: z.string(),
      previous: CoverageStatusSchema,
      current: CoverageStatusSchema,
      reason: z.string().optional(),
    }),
  ),
  unresolvedDifferences: z.array(
    z.strictObject({ pageId: z.string(), reason: z.string() }),
  ),
});

/**
 * WikiSnapshotRead → WikiProjection görünümü (W6 computeWikiCoverageDeltas
 * girdisi; alan kümeleri birebir uyumludur — uyarılar diff'in bir parçası
 * değildir, boş taşınır).
 */
function projectionViewOf(read: WikiSnapshotRead): WikiProjection {
  return {
    snapshot: {
      id: read.snapshot.id,
      workspaceId: read.snapshot.workspaceId,
      graphSnapshotId: read.snapshot.graphSnapshotId,
      revisionRef: read.snapshot.revisionRef,
      status: read.snapshot.status,
      builtAt: read.snapshot.builtAt,
      templateVersion: read.snapshot.templateVersion,
    },
    pages: read.pages.map((page) => ({
      id: page.id,
      wikiSnapshotId: page.wikiSnapshotId,
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
    })),
    sections: read.sections.map((section) => ({
      id: section.id,
      pageId: section.pageId,
      sectionKey: section.sectionKey,
      generatedMarkdown: section.generatedMarkdown,
      evidenceRefs: section.evidenceRefs.map((ref) => ({ ...ref })),
      status: section.status,
    })),
    warnings: [],
  };
}

/**
 * Diff tarafı çözümü: wikiSnapshotId (workspace kapsamlı kimlik okuması)
 * veya yayımlanmış revisionRef (yalnızca en güncel yayınlanmış WikiSnapshot'ın
 * revisionRef'i — veri kökü okuması tekil kimlikle sınırlıdır, sapma
 * dürüstçe INVALID_REVISION mesajında belgelenir). Çözülemeyen taraf
 * INVALID_REVISION (K-013 #6 geleneği).
 */
function resolveDiffSide(
  wikiStore: SqliteWikiStore,
  workspaceId: string,
  token: string,
): WikiSnapshotRead {
  const byId = wikiStore.readWikiSnapshot(token);
  if (byId !== undefined && byId.snapshot.workspaceId === workspaceId) {
    return byId;
  }
  const latest = wikiStore.getLatestPublishedWiki(workspaceId);
  if (latest !== undefined && latest.snapshot.revisionRef === token) {
    return latest;
  }
  throw new CausorynToolError(
    "INVALID_REVISION",
    `wiki diff tarafı çözümlenemedi: ${token} — wikiSnapshotId veya bu workspace'in yayımlanmış revisionRef'i olmalı (revisionRef yalnızca en güncel yayınlanmış WikiSnapshot için çözümlenir)`,
  );
}

function partialSectionCountByPage(
  read: WikiSnapshotRead,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const section of read.sections) {
    if (section.status !== "partial") continue;
    counts.set(section.pageId, (counts.get(section.pageId) ?? 0) + 1);
  }
  return counts;
}

/**
 * causoryn_wiki_diff (TŞ §16A.4, §16A.8 "Revision/snapshot sayfa farkları;
 * salt okunur"): iki WikiSnapshot arasında addedPages/removedPages/
 * changedSections/addedLinks/removedLinks/contractChanges/coverageDelta/
 * unresolvedDifferences.
 *
 * contractChanges K-013 #7 gövdesiyle ({contractId, changeKind:
 * added|removed|modified, summary} — üretici sözleşme packages/contracts
 * contract-drift.ts ContractChangeRecord; saf çekirdek packages/wiki
 * contract-changes.ts) İKİ WIKISNAPSHOT'IN ARKA GRAPH SNAPSHOT'LARININ
 * sözleşme node yüzeyleri (ApiContract/EventContract/SchemaContract/
 * ContractVersion — D1/D2 kayıtları) üzerinden hesaplanır. pageId
 * daraltmasında kayıt, kendi contract sayfasına (wikiChildPageId(workspaceId,
 * "contract", contractId)) eşleşiyorsa taşınır; bir kayıt yalnızca hedef
 * taraf kimliğini taşır (D3 kuralı), bu yüzden base taraf sayfasına
 * daraltılan modified kaydı görünmez (belgeli sınır). Arka graph
 * çözümlenemediğinde [] + çözümleme başarısızlığı uyarısı döner; iki
 * yüzeyde de sözleşme kaydı yoksa GERÇEK [] döner — boşluk notu taşımaz
 * (K-013(7) gövdesi kesinleşti; boş yüzey boş sonucun gerçek halidir).
 * coverageDelta K-013 #3 gövdesiyle ({previous, current, reason?}) sayfa
 * bazlı raporlanır. Tarihi karşılaştırma İZOLE WikiSnapshot okumalarıyladır;
 * working tree değişmez (TŞ §16A.10).
 */
export function wikiDiff(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof WikiDiffInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);
  const wikiStore = requireWikiStore(deps);

  const base = resolveDiffSide(wikiStore, workspaceId, input.base);
  const target = resolveDiffSide(wikiStore, workspaceId, input.target);

  const pageScope = input.pageId;
  const touchesScope = (pageId: string): boolean => pageScope === undefined || pageId === pageScope;

  if (pageScope !== undefined) {
    const inBase = base.pages.some((page) => page.id === pageScope);
    const inTarget = target.pages.some((page) => page.id === pageScope);
    if (!inBase && !inTarget) {
      throw new CausorynToolError(
        "WIKI_PAGE_NOT_FOUND",
        `pageId iki WikiSnapshot'ta da bulunamadı: ${pageScope}`,
      );
    }
  }

  const basePageIds = new Set(
    base.pages.filter((page) => touchesScope(page.id)).map((page) => page.id),
  );
  const targetPageIds = new Set(
    target.pages.filter((page) => touchesScope(page.id)).map((page) => page.id),
  );

  const addedPages = [...targetPageIds]
    .filter((pageId) => !basePageIds.has(pageId))
    .sort();
  const removedPages = [...basePageIds]
    .filter((pageId) => !targetPageIds.has(pageId))
    .sort();

  // changedSections: ortak sayfalarda bölüm içerik/kanıt/durum farkı —
  // İKİ YÖN: hedefte yeni/eklenen bölüm VE base'de var olup hedefte
  // silinmiş bölüm (denetim bulgusu: tek yönlü target gezisi silinen
  // sectionKey'leri atlıyordu; wiki-spec §4.2.7 changedSections şekli
  // korunur — ayrı bir removedSections alanı TŞ §16A.4 kümesinde YOKTUR).
  const baseSectionsByPage = new Map<string, WikiSnapshotRead["sections"][number][]>();
  for (const section of base.sections) {
    if (!touchesScope(section.pageId)) continue;
    const list = baseSectionsByPage.get(section.pageId) ?? [];
    list.push(section);
    baseSectionsByPage.set(section.pageId, list);
  }
  const targetSectionsByPage = new Map<string, WikiSnapshotRead["sections"][number][]>();
  for (const section of target.sections) {
    if (!touchesScope(section.pageId)) continue;
    const list = targetSectionsByPage.get(section.pageId) ?? [];
    list.push(section);
    targetSectionsByPage.set(section.pageId, list);
  }
  const changedSections: { pageId: string; sectionKey: string }[] = [];
  for (const section of target.sections) {
    if (!touchesScope(section.pageId)) continue;
    if (!basePageIds.has(section.pageId)) continue;
    const counterpart = (baseSectionsByPage.get(section.pageId) ?? []).find(
      (entry) => entry.sectionKey === section.sectionKey,
    );
    if (counterpart === undefined) {
      changedSections.push({ pageId: section.pageId, sectionKey: section.sectionKey });
      continue;
    }
    // Anahtar-sırasına duyarsız canonical karşılaştırma (denetim bulgusu:
    // depo okuma sözleşmesindeki sabit alan sırasına dayanan varsayımın
    // yerine savunma derinliği olarak canonicalJson kullanılır).
    const same =
      counterpart.generatedMarkdown === section.generatedMarkdown &&
      counterpart.status === section.status &&
      canonicalJson(
        counterpart.evidenceRefs as unknown as Parameters<typeof canonicalJson>[0],
      ) === canonicalJson(section.evidenceRefs as unknown as Parameters<typeof canonicalJson>[0]);
    if (!same) {
      changedSections.push({ pageId: section.pageId, sectionKey: section.sectionKey });
    }
  }
  for (const section of base.sections) {
    if (!touchesScope(section.pageId)) continue;
    if (!targetPageIds.has(section.pageId)) continue;
    const counterpart = (targetSectionsByPage.get(section.pageId) ?? []).find(
      (entry) => entry.sectionKey === section.sectionKey,
    );
    if (counterpart === undefined) {
      changedSections.push({ pageId: section.pageId, sectionKey: section.sectionKey });
    }
  }
  changedSections.sort(
    (a, b) =>
      (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0) ||
      (a.sectionKey < b.sectionKey ? -1 : a.sectionKey > b.sectionKey ? 1 : 0),
  );

  // Link farkı: kimlik kümesi; sayfa daraltmasında iki ucu da kapsama girer.
  const inDiffScope = (link: { fromPageId: string; toPageId: string | null }): boolean => {
    if (pageScope === undefined) return true;
    return link.fromPageId === pageScope || link.toPageId === pageScope;
  };
  const baseLinksById = new Map(
    base.links.filter(inDiffScope).map((link) => [link.id, link]),
  );
  const targetLinksById = new Map(
    target.links.filter(inDiffScope).map((link) => [link.id, link]),
  );
  const toLinkOutput = (link: (typeof target.links)[number]) => ({
    id: link.id,
    wikiSnapshotId: link.wikiSnapshotId,
    fromPageId: link.fromPageId,
    toPageId: link.toPageId,
    kind: link.kind,
    resolution: link.resolution,
    evidenceRefs: link.evidenceRefs.map((ref) => ({ ...ref })),
  });
  const addedLinks = [...targetLinksById.values()]
    .filter((link) => !baseLinksById.has(link.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(toLinkOutput);
  const removedLinks = [...baseLinksById.values()]
    .filter((link) => !targetLinksById.has(link.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(toLinkOutput);

  // coverageDelta: K-013 #3 gövdesi; W6 çekirdeği hesaplar (deterministik).
  const coverageDelta = runWiki(deps, () =>
    computeWikiCoverageDeltas(projectionViewOf(base), projectionViewOf(target)),
  )
    .filter((entry) => touchesScope(entry.pageId))
    .map((entry) => ({
      pageId: entry.pageId,
      previous: entry.delta.previous,
      current: entry.delta.current,
      ...(entry.delta.reason === undefined ? {} : { reason: entry.delta.reason }),
    }));

  // unresolvedDifferences: partial bölüm sayısı değişen ortak sayfalar
  // (belirsizlik artışı/azalışı dürüstçe raporlanır — TŞ §16A.10).
  const basePartial = partialSectionCountByPage(base);
  const targetPartial = partialSectionCountByPage(target);
  const unresolvedDifferences: { pageId: string; reason: string }[] = [];
  for (const pageId of [...basePageIds].sort()) {
    if (!targetPageIds.has(pageId)) continue;
    const before = basePartial.get(pageId) ?? 0;
    const after = targetPartial.get(pageId) ?? 0;
    if (before !== after) {
      unresolvedDifferences.push({
        pageId,
        reason: `partial bölüm sayısı ${String(before)} → ${String(after)}`,
      });
    }
  }

  // contractChanges (K-013 #7, sprint-5 D7 — GÖVDE KESİNLEŞTİ): iki
  // WikiSnapshot'ın arka graph snapshot'larının sözleşme node yüzeyleri
  // diff edilir. Arka graph ÇÖZÜMLENEMEZSE [] + çözümleme başarısızlığı
  // uyarısı döner (analiz edilemeyen durum açık raporlanır); İKİ YÜZEYDE DE
  // kayıt yoksa GERÇEK [] sessiz döner — boşluk "degrade notu" taşımaz,
  // çünkü {contractId, changeKind, summary} gövdesi artık kesindir
  // (K-013(7)); boş yüzey boş sonucun gerçek halidir (uydurma kayıt yok).
  // Sayfa daraltmasında kayıt, kendi contract sayfasına eşleşiyorsa taşınır
  // (D3 kimlik kuralı gereği kayıt hedef taraf kimliğini taşır; base taraf
  // sayfasına daraltılan modified kaydı görünmez — modül dokümanındaki
  // belgeli sınır).
  const contractWarnings: string[] = [];
  let contractChanges: {
    contractId: string;
    changeKind: "added" | "removed" | "modified";
    summary: string;
  }[] = [];
  const baseGraphRead = deps.repository.getSnapshot(base.snapshot.graphSnapshotId);
  const targetGraphRead = deps.repository.getSnapshot(target.snapshot.graphSnapshotId);
  if (baseGraphRead === undefined || targetGraphRead === undefined) {
    const missingSide =
      baseGraphRead === undefined
        ? `base (${base.snapshot.graphSnapshotId})`
        : `target (${target.snapshot.graphSnapshotId})`;
    contractWarnings.push(
      `contractChanges boş: ${missingSide} WikiSnapshot'ın arka graph snapshot'ı çözümlenemedi (yayımlanmış ready/partial graph yok); sözleşme yüzeyi karşılaştırılamadı (K-013 #7)`,
    );
  } else {
    const surfaceChanges = runWiki(deps, () =>
      computeWikiContractChanges(
        wikiContractSurfaceOf(baseGraphRead.snapshot),
        wikiContractSurfaceOf(targetGraphRead.snapshot),
      ),
    );
    if (pageScope === undefined) {
      contractChanges = [...surfaceChanges];
    } else {
      contractChanges = surfaceChanges
        .filter(
          (change) =>
            wikiChildPageId(workspaceId, "contract", change.contractId) === pageScope,
        )
        .map((change) => ({ ...change }));
    }
  }

  const warnings = [...contractWarnings];

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: target.snapshot.id,
    status: target.snapshot.status === "partial" || base.snapshot.status === "partial" ? "partial" : "ok",
    coverage: null,
    warnings,
    data: {
      base: input.base,
      target: input.target,
      baseWikiSnapshotId: base.snapshot.id,
      targetWikiSnapshotId: target.snapshot.id,
      addedPages,
      removedPages,
      changedSections,
      addedLinks,
      removedLinks,
      contractChanges,
      coverageDelta,
      unresolvedDifferences,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Yüzey yeniden çıkarımı (index.ts export'u için toplu liste)         */
/* ------------------------------------------------------------------ */

/** Bu dilimde kullanılan sabit kodlar (errors.ts'teki CAUSORYN_TOOL_ERROR_CODES
 * alt kümesi; yeni UZANTI kodu YOKTUR — WIKI_PAGE_NOT_FOUND TŞ §10.1 sabit
 * kodunun ilk kullanımıdır). */
export const WIKI_TOOL_ERROR_CODES_USED: readonly CausorynToolErrorCode[] = [
  "WORKSPACE_NOT_AUTHORIZED",
  "PATH_DENIED",
  "INDEX_NOT_READY",
  "EVIDENCE_NOT_FOUND",
  "LIMIT_EXCEEDED",
  "INVALID_ARGUMENT",
  "INVALID_REVISION",
  "WIKI_PAGE_NOT_FOUND",
  "INTERNAL_ERROR",
];

