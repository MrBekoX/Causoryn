import path from "node:path";

import {
  canonicalJson,
  DomainError,
  EDGE_KIND_SET,
  RESOLUTION_SET,
  sha256Hex,
  utf8Encode,
  type GraphEdge,
  type GraphNode,
  type JsonValue,
  type SnapshotGraph,
} from "@causoryn/domain";

import type {
  CompareContentSet,
  CompareNode,
  CompareNodeIdentity,
} from "./compare.js";
import {
  API_SURFACE_NODE_KINDS,
  compareIdentityKey,
  diffContentSets,
} from "./compare.js";
import { GraphRepositoryError } from "./errors.js";
import {
  assertValidGitRef,
  readGitBlob,
  readGitTree,
  resolveGitCommitRef,
  runGit,
  WORKING_TREE_REF,
  type ReadGitTreeOptions,
  type RunGitOptions,
} from "./git-read.js";
import {
  GuardError,
  parseArchitectureBaseline,
  parseArchitecturePolicy,
  type ArchitectureBaseline,
  type ArchitecturePolicy,
} from "./guard-policy-schema.js";
import { findViolations } from "./guard.js";

/**
 * causoryn_architecture_timeline çekirdeği (sprint-3 C7, TŞ v2.1 §13/§10).
 *
 * TŞ §13 (Sayfa 12) Timeline sözleşmesi: "refs=[...] veya bounded
 * history-range için snapshot/diff özetleri hazırlanır. Her commit'i taramak
 * pahalıysa sampling ve maxRevisions uygulanır; analiz edilmeyen aralıklar
 * açık raporlanır." TŞ §10 (Sayfa 10) araç girdisi: refs/range, granularity.
 * TŞ §13'ün kırmızı çizgisi: "Ölçüler 'kalite skoru' olarak tek sayıya
 * indirgenmez" — çıktıda hiçbir bileşik skor alanı yoktur.
 *
 * Bölünme (compare.ts C3 diliminin sözleşmesiyle aynı):
 * - SAF ÇEKİRDEK `buildArchitectureTimeline`: sıralı revizyon noktaları
 *   (analiz edilmiş içerik kümesi veya analiz edilemedi kaydı) → ardışık
 *   diff özetleri, deterministik örnekleme ve aralık kayıtları. Saat okumaz,
 *   süreç başlatmaz; aynı girdi her zaman aynı JSON'u üretir.
 * - SPAWN KATMANI `buildArchitectureTimelineFromGit`: C3'ün salt-okunur git
 *   yardımcılarını (`runGit`, `readGitBlob` — git-read.ts) kullanır; shell
 *   interpolation yoktur, yalnızca `cat-file` alt komutları çalışır.
 *
 * Tasarım kararları (TŞ metninin deterministik yorumu — aşağıdaki SAYILAR ve
 * blob arayüzü TŞ'de sabitlenmemiştir; bu modül tarafından sabitlenir ve
 * testlerle kanıtlanır):
 * - Revizyon içeriği: her nokta, o ref'teki `.causoryn/architecture-snapshot.json`
 *   blob'undan (CompareContentSet sözleşmesindeki nodes/edges kayıtları)
 *   okunur. Blob yoksa / JSON değilse / şekli bozuksa nokta
 *   `unanalyzed` olur; kimse yerine sayı UYDURMAZ (TŞ: "analiz edilmeyen
 *   aralıklar açık raporlanır"). Şekil denetimi relativePath/signature tür
 *   kontrollerini kapsar (TŞ §19: depo güvenilmez girdidir; aksi hâlde
 *   compare'in pathSegmentSet/tokenize katmanında kodlanmamış TypeError
 *   üretir). İçerik karşılaştırma sözleşmesi ihlalleri (compare/* kodları)
 *   da aralığı `unanalyzed-interval` yapar; derin doğrulama tek kaynak
 *   olarak compare.ts'e devredilir (yeniden yazılmaz).
 * - Sampling: nokta sayısı maxRevisions'ı aşarsa uçlar (ilk+son) korunarak
 *   eşit aralıklı indeks seçimi yapılır (`selectSampledIndices`); atlanan
 *   noktalar `sampling.skipped` içinde açıkça listelenir. Seçilmeyen
 *   noktaların içeriği OKUNMAZ (maliyet sınırı TŞ'in sampling gerekçesidir).
 * - refs modu: ref sırası çağıranın verdiği sıradır (zaman sıralaması
 *   yapılmaz — `git log` beyaz liste dışıdır ve tarih sıralaması
 *   determinizmi zayıflatır). TÜM ref'ler örneklemeden ÖNCE çözümlenir:
 *   sampling'e takılan var olmayan ref sessiz atlamayla gizlenemez; aksi
 *   hâlde aynı girdi maxRevisions'a bağlı olarak farklı davranışırdı.
 * - range modu: `from`..`to` uçları commit/tag'e peel edilir; nokta listesi,
 *   `to`'dan `from`'a İLK-EBEVEYN zinciri yürüyüşüyle (merge'lerde birinci
 *   ebeveyn) bulunur ve eskiden yeniye sıralanır. Uçlar dahildir.
 *   `from` zincirde bulunamazsa veya yürüyüş maxRangeWalk sınırını aşarsa
 *   açık `timeline/invalid-range` reddi verilir (sessiz kırpma yok).
 * - İhlal trendi (sprint-6 E5): TŞ §13 trend göstergelerinden cycles ve
 *   layer violations (forbidden-dependency) dilimi bu çekirdekte
 *   GERÇEKLEŞTİRİLDİ — seçilen her noktanın içerik kümesi C2 guard
 *   kurallarıyla (`findViolations`) değerlendirilir; ihlal sayıları nokta
 *   başına ölçülür ve metrik başına AYRI dizilerde (`series`) döner.
 *   Yine aynı bölüm gereği hiçbir ölçü tek "kalite skoruna" indirgenmez;
 *   kalan gösterge adayları (public contract breaking candidates, module
 *   coupling, test impact adayları) bu dilimin kapsamı dışındadır.
 * - `granularity` (TŞ §10 girdisi) bu çekirdekte işlenmez; MCP zarfı dilimi
 *   nokta seçimine (commit/tag/milestone) bağlayacaktır.
 *
 * Hata kodları (GraphRepositoryError.code):
 * - timeline/invalid-input: refs/range modu belirsiz veya nokta kaydı bozuk.
 * - timeline/invalid-range: eş uçlar, commit olmayan uç, tag zinciri çok
 *   derin, from ilk-ebeveyn zincirinde yok, maxRangeWalk aşımı, aralığın tek
 *   commit'e çözümlenmesi.
 * - timeline/insufficient-points: zaman çizgisi en az 2 nokta ister.
 * - timeline/duplicate-ref: aynı ref listede iki kez.
 * - timeline/invalid-limit: maxRevisions/maxRangeWalk tamsayı ve alt sınırın
 *   altında.
 * - compare/invalid-ref, compare/ref-not-found, compare/invalid-repo-root,
 *   compare/git-*: C3 git-okuma katmanının kodları aynen korunur.
 */

/** Revizyon noktası başına mimari snapshot blob'u (git yolu, '/' ayıracı). */
export const TIMELINE_SNAPSHOT_BLOB_PATH = ".causoryn/architecture-snapshot.json";

/**
 * Explicit trust warning attached when a timeline point falls back to reading a
 * repo-committed `.causoryn/architecture-snapshot.json` git blob instead of a
 * locally verified snapshot (`snapshotLookup`) or local read-only git-tree
 * reconstruction (`reconstructFromGitTree`).
 */
export const TIMELINE_TRUST_WARNING_COMMITTED_GIT_BLOB =
  "snapshot-loaded-from-committed-git-blob" as const;

export type TimelineTrustWarning = typeof TIMELINE_TRUST_WARNING_COMMITTED_GIT_BLOB;

/**
 * Optional local trusted snapshot lookup seam (e.g., querying locally-indexed
 * SQLite snapshot history by canonical commit SHA). Returning `undefined` falls
 * through to `reconstructFromGitTree` and then to the legacy committed blob.
 */
export type TimelineSnapshotLookup = (
  commitSha: string,
  ref: string,
) => CompareContentSet | undefined | Promise<CompareContentSet | undefined>;

/**
 * Optional local source-tree reconstruction seam built on hardened read-only
 * `readGitTree`/`readGitBlob` access without trusting any repo-committed
 * `.causoryn/architecture-snapshot.json` file. Returning `undefined` falls
 * through to the legacy committed blob.
 */
export type TimelineReconstructFromGitTree = (
  repoRoot: string,
  ref: string,
) => Promise<CompareContentSet | undefined>;

/**
 * Options for `readTimelinePointFromGit` (backward-compatible superset of
 * `RunGitOptions`).
 */
export interface ReadTimelinePointOptions extends RunGitOptions {
  readonly snapshotLookup?: TimelineSnapshotLookup;
  readonly reconstructFromGitTree?: TimelineReconstructFromGitTree;
  /** Pre-resolved canonical commit SHA when already computed by the caller. */
  readonly commitSha?: string;
}

/** Node/edge dizilerini id'ye göre kanonik sıraya alır (determinizm). */
function byGraphId<T extends { readonly id: string }>(a: T, b: T): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** GraphNode → CompareNode kaydı (blob sözleşmesi; kimlik + tanımlı alanlar). */
function contentNodeOf(node: GraphNode): CompareNode {
  const attributes = node.attributes;
  return {
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    ...(node.location === undefined ? {} : { relativePath: node.location.relativePath }),
    ...(node.language === undefined ? {} : { language: node.language }),
    ...(Object.keys(attributes).length === 0 ? {} : { attributes }),
  };
}

/**
 * Kenar ucunu node kimliğine çözümler. Uç kimliği compareIdentityKey ile
 * bire bir eşleşmek ZORUNDADIR (kind + qualifiedName + relativePath) —
 * aksi hâlde compare'in dangling-edge doğrulaması kümeni reddeder.
 */
function contentIdentityOf(
  nodesById: ReadonlyMap<string, GraphNode>,
  nodeId: string,
  edgeKind: string,
): CompareNodeIdentity {
  const node = nodesById.get(nodeId);
  if (node === undefined) {
    throw new GraphRepositoryError(
      "compare/dangling-edge",
      `Edge endpoint does not match any snapshot node (${edgeKind}): ${nodeId}`,
    );
  }
  return {
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    ...(node.location === undefined ? {} : { relativePath: node.location.relativePath }),
  };
}

/**
 * Blob üreticisi (denetim bulgusu, orta): compare/timeline'ın tükettiği
 * `.causoryn/architecture-snapshot.json` sözleşmesini (CompareContentSet)
 * yayınlanmış bir SnapshotGraph'tan üretir. Tam snapshot canonical JSON'u
 * kenar uçlarını node-id string olarak taşır ve blob okuyucusu tarafından
 * reddedilir; bu fonksiyon uçları {kind, qualifiedName, relativePath}
 * kimlik nesnelerine çözümler.
 *
 * Çıktı canonical JSON'dur: node/edge girdi sırasından bağımsız, bit-bit
 * deterministik (TŞ §8 invariant vi). Saf fonksiyondur: saat okumaz, dosya
 * sistemine dokunmaz. Blob'un deponun ilgili revizyonuna yazılıp
 * commit'lenmesi KULLANICI sorumluluğundadır — motor kullanıcı workspace'ine
 * asla yazmaz (TŞ kırmızı çizgi: workspace salt okunur); üretici, izinli
 * export yazma katmanına verilecek içeriği hazırlar.
 */
export function serializeSnapshotContentSet(snapshot: SnapshotGraph): string {
  const nodesById = new Map<string, GraphNode>();
  for (const node of snapshot.nodes) {
    nodesById.set(node.id, node);
  }
  const contentSet: CompareContentSet = {
    nodes: [...snapshot.nodes].sort(byGraphId).map(contentNodeOf),
    edges: [...snapshot.edges].sort(byGraphId).map((edge: GraphEdge) => ({
      kind: edge.kind,
      from: contentIdentityOf(nodesById, edge.from, edge.kind),
      to: contentIdentityOf(nodesById, edge.to, edge.kind),
      resolution: edge.resolution,
    })),
  };
  // canonicalJson sınırı: CompareContentSet yapısısal olarak JSON'dur;
  // readonly arayüzün index-signature'ı tsconfig katmanında yoktur
  // (compare.ts'in attributes cast'iyle aynı serileştirme sınırı).
  return canonicalJson(contentSet as unknown as JsonValue);
}

/** Uygulanan sınırlar; istek tavanı aşarsa tavana kırpılır (bkz. impact.ts). */
export interface TimelineLimits {
  readonly maxRevisions: number;
  readonly maxRangeWalk: number;
}

/**
 * Varsayılan ve tavan sınırlar — "config" bu pakette modül sabitidir
 * (TŞ'de sayılar sabitlenmemiştir); mcp-server dilimi dış config'e
 * bağlarsa bu sabitler tavan olarak kalır.
 */
export const TIMELINE_DEFAULTS: TimelineLimits = {
  maxRevisions: 12,
  maxRangeWalk: 100,
};

export const TIMELINE_CEILINGS: TimelineLimits = {
  maxRevisions: 60,
  maxRangeWalk: 500,
};

const MIN_MAX_REVISIONS = 2;
const MIN_MAX_RANGE_WALK = 2;
/** Tag zinciri peel derinliği sınırı (tag→tag→... zincirlerine karşı). */
const MAX_TAG_PEEL_DEPTH = 5;

/** sha1 ve sha256 depoları (git 2.40+ sha256 backend) — yalnızca ayrıştırma. */
const SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Girdi tipleri
// ---------------------------------------------------------------------------

/** Tek revizyon noktasının içerik sonucu: analiz edildi ya da edilemedi. */
export type TimelinePointContent =
  | {
      readonly status: "analyzed";
      readonly contentSet: CompareContentSet;
      /** Set when snapshot content came from an untrusted repo-committed git blob. */
      readonly trustWarning?: TimelineTrustWarning;
    }
  | { readonly status: "unanalyzed"; readonly reason: string };

/** Saf çekirdek girdisi noktası. `ref` güvenlik deseniyle doğrulanır. */
export interface TimelinePointInput {
  readonly ref: string;
  readonly content: TimelinePointContent;
}

export interface BuildArchitectureTimelineInput {
  readonly points: readonly TimelinePointInput[];
  readonly maxRevisions?: number;
  /**
   * Yalnızca doğrulama/tavan kırpımı ve limits raporlaması için: git
   * yürüyüşünü KULLANAN katman spawn orkestratörüdür; saf çekirdek bu değeri
   * uygulanan limit olarak çıktıya yazar (denetlenebilirlik).
   */
  readonly maxRangeWalk?: number;
}

/** Spawn katmanı girdisi: refs listesi YA DA bounded commit aralığı. */
export interface TimelineGitInput {
  readonly refs?: readonly string[];
  readonly range?: { readonly from: string; readonly to: string };
  readonly maxRevisions?: number;
  readonly maxRangeWalk?: number;
  /**
   * Optional trusted local snapshot lookup by canonical commit SHA (checked
   * FIRST, before git-tree reconstruction or committed git-blob fallback).
   */
  readonly snapshotLookup?: TimelineSnapshotLookup;
  /**
   * Optional read-only git-tree reconstruction callback (checked SECOND,
   * before falling back to committed `.causoryn/architecture-snapshot.json`).
   */
  readonly reconstructFromGitTree?: TimelineReconstructFromGitTree;
}

// ---------------------------------------------------------------------------
// Çıktı tipleri
// ---------------------------------------------------------------------------

export interface ArchitectureTimelinePoint {
  /** Seçilmiş sıra içindeki konum (sampling sonrası). */
  readonly index: number;
  /** İstenen sıra içindeki konum (sampling öncesi). */
  readonly sourceIndex: number;
  readonly ref: string;
  readonly status: "analyzed" | "unanalyzed";
  /** Yalnızca analyzed: içerik kümesindeki mutlak node sayısı. */
  readonly nodeCount?: number;
  readonly edgeCount?: number;
  readonly apiSurfaceNodeCount?: number;
  /** Yalnızca unanalyzed: neden içerik analiz edilemedi (kodlu metin). */
  readonly unanalyzedReason?: string;
  /** Present when analyzed content came from an untrusted committed git blob. */
  readonly trustWarning?: TimelineTrustWarning;
}

/**
 * Diff özet sayıları — compare.ts `ArchitectureDiff.summary` alanlarından
 * birebir türetilir (yeniden hesaplanmaz, yeniden yorumlanmaz).
 */
export interface TimelineChangeSummary {
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly renamed: number;
  readonly uncertain: number;
  readonly unchangedNodes: number;
  readonly edgeAdded: number;
  readonly edgeRemoved: number;
  readonly edgeChanged: number;
  readonly edgeUnchanged: number;
  readonly apiSurfaceChanges: number;
}

/** İki seçilmiş ardışık nokta arasındaki diff özeti. */
export interface TimelineDiffInterval {
  readonly kind: "diff";
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly fromSourceIndex: number;
  readonly toSourceIndex: number;
  readonly fromRef: string;
  readonly toRef: string;
  readonly changes: TimelineChangeSummary;
}

/**
 * Analiz edilemeyen aralık: en az bir ucu `unanalyzed` veya içerik compare
 * sözleşmesini ihlal ediyor. HİÇBİR sayı taşımaz — uydurma interpolasyon
 * üretilmez (TŞ §13).
 */
export interface TimelineUnanalyzedInterval {
  readonly kind: "unanalyzed-interval";
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly fromSourceIndex: number;
  readonly toSourceIndex: number;
  readonly fromRef: string;
  readonly toRef: string;
  /** Kaynağı bilinen nedenler; `pair` = içerik sözleşme ihlali (kod+mesaj). */
  readonly reasons: {
    readonly from?: string;
    readonly to?: string;
    readonly pair?: string;
  };
}

export type TimelineInterval = TimelineDiffInterval | TimelineUnanalyzedInterval;

export interface TimelineSamplingReport {
  readonly applied: boolean;
  /** Uygulanan (tavana kırpılmış olabilecek) limit. */
  readonly maxRevisions: number;
  readonly requestedPoints: number;
  readonly selectedCount: number;
  /** Atlanan noktalar: hangileri okunmadı — açık rapor (TŞ §13). */
  readonly skipped: readonly {
    readonly sourceIndex: number;
    readonly ref: string;
  }[];
}

export interface ArchitectureTimeline {
  readonly requestedPoints: number;
  readonly analyzedPoints: number;
  readonly unanalyzedPoints: number;
  readonly points: readonly ArchitectureTimelinePoint[];
  readonly intervals: readonly TimelineInterval[];
  readonly sampling: TimelineSamplingReport;
  readonly limits: {
    readonly maxRevisions: number;
    readonly maxRangeWalk: number;
  };
  /** Propagated trust warnings collected from analyzed timeline points (empty when none). */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Saf çekirdek
// ---------------------------------------------------------------------------

const API_SURFACE_NODE_KIND_SET: ReadonlySet<string> = new Set(
  API_SURFACE_NODE_KINDS,
);

function resolveLimit(
  name: "maxRevisions" | "maxRangeWalk",
  requested: number | undefined,
  defaultValue: number,
  ceiling: number,
  minimum: number,
): number {
  if (requested === undefined) return defaultValue;
  if (
    typeof requested !== "number" ||
    !Number.isInteger(requested) ||
    requested < minimum
  ) {
    throw new GraphRepositoryError(
      "timeline/invalid-limit",
      `${name} must be an integer >= ${minimum}: ${String(requested)}`,
    );
  }
  return Math.min(requested, ceiling);
}

/**
 * Deterministik eşit aralıklı örnekleme: uçlar (ilk ve son indeks) her zaman
 * korunur; maxRevisions nokta seçilir. count <= limit ise tüm indeksler.
 * Aynı (count, limit) girdisi her zaman aynı indeks listesini üretir.
 */
export function selectSampledIndices(
  count: number,
  maxRevisions: number,
): readonly number[] {
  if (
    typeof maxRevisions !== "number" ||
    !Number.isInteger(maxRevisions) ||
    maxRevisions < MIN_MAX_REVISIONS
  ) {
    throw new GraphRepositoryError(
      "timeline/invalid-limit",
      `maxRevisions must be an integer >= ${MIN_MAX_REVISIONS}: ${String(maxRevisions)}`,
    );
  }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new GraphRepositoryError(
      "timeline/invalid-limit",
      `count must be an integer >= 0: ${String(count)}`,
    );
  }
  if (count <= maxRevisions) {
    return Array.from({ length: count }, (_, index) => index);
  }
  const selected: number[] = [];
  for (let step = 0; step < maxRevisions; step++) {
    const index = Math.floor((step * (count - 1)) / (maxRevisions - 1));
    if (selected[selected.length - 1] !== index) {
      selected.push(index);
    }
  }
  return selected;
}

function assertPointContract(point: TimelinePointInput): void {
  // TŞ §13 ref güven sözleşmesi compare ile aynı deseni kullanır; hata kodu
  // C3 katmanının kodudur (compare/invalid-ref).
  assertValidGitRef(point.ref);
  const content = point.content;
  if (
    content === null ||
    typeof content !== "object" ||
    (content.status !== "analyzed" && content.status !== "unanalyzed")
  ) {
    throw new GraphRepositoryError(
      "timeline/invalid-input",
      `Point content status must be 'analyzed' or 'unanalyzed': ${point.ref}`,
    );
  }
  if (content.status === "analyzed") {
    // TŞ §19: içerik güvenilmez kabul edilir. Şekil denetimi (relativePath/
    // signature türleri dahil) manifest okuyucusuyla TEK ortak fonksiyondan
    // yapılır; bozuk içerik diff katmanında kodlanmamış TypeError üretmeden
    // coded timeline/invalid-input ile reddedilir. Derin katalog doğrulaması
    // yine compare.ts'in diffContentSets sözleşmesine aittir.
    const shapeError = describeManifestShapeError(content.contentSet);
    if (shapeError !== null) {
      throw new GraphRepositoryError(
        "timeline/invalid-input",
        `Analyzed point content does not match the content contract (${point.ref}): ${shapeError}`,
      );
    }
    if (
      content.trustWarning !== undefined &&
      (typeof content.trustWarning !== "string" || content.trustWarning.length === 0)
    ) {
      throw new GraphRepositoryError(
        "timeline/invalid-input",
        `Analyzed point trustWarning, when present, must be a non-empty string: ${point.ref}`,
      );
    }
  } else if (
    typeof content.reason !== "string" ||
    content.reason.length === 0
  ) {
    throw new GraphRepositoryError(
      "timeline/invalid-input",
      `Unanalyzed point must carry a reason string: ${point.ref}`,
    );
  }
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

/**
 * Saf Architecture Timeline çekirdeği: sıralı revizyon noktaları →
 * sampling + ardışık diff özetleri + açık unanalyzed-interval kayıtları.
 * Derin dondurulmuş, deterministik (ADR-005 geleneği).
 */
export function buildArchitectureTimeline(
  input: BuildArchitectureTimelineInput,
): ArchitectureTimeline {
  const maxRevisions = resolveLimit(
    "maxRevisions",
    input.maxRevisions,
    TIMELINE_DEFAULTS.maxRevisions,
    TIMELINE_CEILINGS.maxRevisions,
    MIN_MAX_REVISIONS,
  );
  // Saf çekirdek yürüyüş yapmaz; değer yalnızca doğrulanır, kırpılır ve
  // limits içinde raporlanır (spawn katmanı aynı çözümleme işlevini kullanır).
  const maxRangeWalk = resolveLimit(
    "maxRangeWalk",
    input.maxRangeWalk,
    TIMELINE_DEFAULTS.maxRangeWalk,
    TIMELINE_CEILINGS.maxRangeWalk,
    MIN_MAX_RANGE_WALK,
  );

  const points = input.points;
  if (!Array.isArray(points)) {
    throw new GraphRepositoryError(
      "timeline/invalid-input",
      "points must be an array",
    );
  }
  if (points.length < MIN_MAX_REVISIONS) {
    throw new GraphRepositoryError(
      "timeline/insufficient-points",
      `A timeline needs at least ${MIN_MAX_REVISIONS} points (${points.length} given)`,
    );
  }
  const seenRefs = new Set<string>();
  for (const point of points) {
    assertPointContract(point);
    if (seenRefs.has(point.ref)) {
      throw new GraphRepositoryError(
        "timeline/duplicate-ref",
        `Ref was given more than once: ${point.ref}`,
      );
    }
    seenRefs.add(point.ref);
  }

  const selection = selectSampledIndices(points.length, maxRevisions);
  const selectedSet = new Set(selection);

  const skipped: { sourceIndex: number; ref: string }[] = [];
  for (let index = 0; index < points.length; index++) {
    if (!selectedSet.has(index)) {
      const point = points[index];
      if (point === undefined) continue; // imkânsız; savunma katmanı
      skipped.push({ sourceIndex: index, ref: point.ref });
    }
  }

  const pointsOut: ArchitectureTimelinePoint[] = [];
  const warnings: string[] = [];
  let analyzedCount = 0;
  let unanalyzedCount = 0;
  selection.forEach((sourceIndex, index) => {
    const point = points[sourceIndex];
    if (point === undefined) {
      throw new GraphRepositoryError(
        "timeline/invalid-input",
        `Selection index is outside the points array: ${String(sourceIndex)}`,
      );
    }
    const content = point.content;
    if (content.status === "analyzed") {
      const set = content.contentSet;
      const apiSurfaceNodeCount = set.nodes.filter(
        (node: CompareNode) => API_SURFACE_NODE_KIND_SET.has(node.kind),
      ).length;
      pointsOut.push({
        index,
        sourceIndex,
        ref: point.ref,
        status: "analyzed",
        nodeCount: set.nodes.length,
        edgeCount: set.edges.length,
        apiSurfaceNodeCount,
        ...(content.trustWarning === undefined
          ? {}
          : { trustWarning: content.trustWarning }),
      });
      if (content.trustWarning !== undefined) {
        warnings.push(
          `${content.trustWarning}: ref '${point.ref}' loaded from committed git blob (${TIMELINE_SNAPSHOT_BLOB_PATH}) rather than local engine verification`,
        );
      }
      analyzedCount += 1;
    } else {
      pointsOut.push({
        index,
        sourceIndex,
        ref: point.ref,
        status: "unanalyzed",
        unanalyzedReason: content.reason,
      });
      unanalyzedCount += 1;
    }
  });

  const intervals: TimelineInterval[] = [];
  for (let step = 1; step < selection.length; step++) {
    const fromSource = selection[step - 1];
    const toSource = selection[step];
    if (fromSource === undefined || toSource === undefined) continue;
    const fromPoint = points[fromSource];
    const toPoint = points[toSource];
    if (fromPoint === undefined || toPoint === undefined) continue;
    const base = {
      fromIndex: step - 1,
      toIndex: step,
      fromSourceIndex: fromSource,
      toSourceIndex: toSource,
      fromRef: fromPoint.ref,
      toRef: toPoint.ref,
    };
    const fromContent = fromPoint.content;
    const toContent = toPoint.content;
    if (fromContent.status !== "analyzed" || toContent.status !== "analyzed") {
      intervals.push({
        kind: "unanalyzed-interval",
        ...base,
        reasons: {
          ...(fromContent.status !== "analyzed"
            ? { from: fromContent.reason }
            : {}),
          ...(toContent.status !== "analyzed" ? { to: toContent.reason } : {}),
        },
      });
      continue;
    }
    try {
      // TEK yeniden kullanım noktası: diff özetleri compare.ts çekirdeğinden
      // gelir; bu modül sayıları yeniden hesaplamaz/yorumlamaz.
      const diff = diffContentSets(
        fromContent.contentSet,
        toContent.contentSet,
      );
      intervals.push({
        kind: "diff",
        ...base,
        changes: { ...diff.summary },
      });
    } catch (error) {
      // İçerik karşılaştırma sözleşmesini ihlal eden revizyon içeriği, o
      // aralığı analiz edilemez yapar (uydurma sayı üretmek yerine); diğer
      // hatalar ürün hatası olarak yükselir.
      if (error instanceof GraphRepositoryError && error.code.startsWith("compare/")) {
        intervals.push({
          kind: "unanalyzed-interval",
          ...base,
          reasons: { pair: `${error.code}: ${error.message}` },
        });
        continue;
      }
      throw error;
    }
  }

  return deepFreeze({
    requestedPoints: points.length,
    analyzedPoints: analyzedCount,
    unanalyzedPoints: unanalyzedCount,
    points: pointsOut,
    intervals,
    sampling: {
      applied: selection.length < points.length,
      maxRevisions,
      requestedPoints: points.length,
      selectedCount: selection.length,
      skipped,
    },
    limits: { maxRevisions, maxRangeWalk },
    warnings,
  });
}

// ---------------------------------------------------------------------------
// İhlal trendi — sprint-6 E5 (TŞ §13 ihlal trend göstergeleri: cycles +
// layer violations; kalite skoru tek sayıya indirgenmez)
// ---------------------------------------------------------------------------

/** Trend değerlendirmesinde policy blob'unun git yolu ('/' ayıracı). */
export const TIMELINE_POLICY_BLOB_PATH = ".causoryn/architecture.rules.yaml";

/** Trend değerlendirmesinde baseline (suppression) blob'unun git yolu. */
export const TIMELINE_BASELINE_BLOB_PATH = ".causoryn/architecture.baseline.yaml";

/** Trend metrikleri — C2 guard kural türleri (TŞ §12) ile bire bir. */
export type TimelineTrendMetric = "no-cycles" | "forbidden-dependency";

/** Spawn katmanının bir ref'ten okuduğu policy sonucu. */
export type TimelineTrendPolicyResult =
  | { readonly status: "ok"; readonly policy: ArchitecturePolicy }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly reason: string };

/** Spawn katmanının bir ref'ten okuduğu baseline sonucu (yoksa boş baseline). */
export type TimelineTrendBaselineResult =
  | { readonly status: "ok"; readonly baseline: ArchitectureBaseline }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly reason: string };

/** Tek trend noktası girdisi: içerik + o ref'in policy/baseline okuma sonucu. */
export interface TimelineTrendPointInput {
  readonly ref: string;
  readonly content: TimelinePointContent;
  readonly policy: TimelineTrendPolicyResult;
  readonly baseline: TimelineTrendBaselineResult;
}

export interface BuildTimelineViolationTrendInput {
  readonly points: readonly TimelineTrendPointInput[];
}

/** Tek noktanın trend değerlendirmesi: ölçüldü ya da ölçülemedi (+neden). */
export type TimelineTrendPointEvaluation =
  | {
      readonly index: number;
      readonly ref: string;
      readonly status: "evaluated";
      /** Değerlendirmede kullanılan policy kural sayısı. */
      readonly evaluatedRules: number;
      readonly noCyclesViolations: number;
      readonly noCyclesSuppressed: number;
      readonly forbiddenDependencyViolations: number;
      readonly forbiddenDependencySuppressed: number;
    }
  | {
      readonly index: number;
      readonly ref: string;
      readonly status: "unavailable";
      readonly reason: string;
    };

/** Seri değeri: ölçülmüş sayı ya da null + neden (uydurma sayı yok). */
export type TimelineTrendSeriesValue =
  | {
      readonly index: number;
      readonly ref: string;
      readonly count: number;
    }
  | {
      readonly index: number;
      readonly ref: string;
      readonly count: null;
      readonly reason: string;
    };

/** İki kullanılabilir (evaluated) nokta arasındaki gerçek ölçüm adımı. */
export interface TimelineTrendStep {
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly fromRef: string;
  readonly toRef: string;
  readonly fromCount: number;
  readonly toCount: number;
  readonly direction: "increasing" | "decreasing" | "flat";
}

export interface TimelineTrendSeries {
  readonly metric: TimelineTrendMetric;
  /** Seçilmiş noktalarla hizalı değerler; eksik nokta null + neden taşır. */
  readonly values: readonly TimelineTrendSeriesValue[];
  /**
   * Yalnızca İKİ ucu da evaluated olan nokta çiftlerinden gerçek ölçüm
   * adımları; eksik nokta üzerinden yön UYDURULMAZ. fromIndex/toIndex
   * seçilmiş konumları taşır — aradaki indekslerin atlandığı buradan
   * okunabilir.
   */
  readonly steps: readonly TimelineTrendStep[];
  /**
   * Uç karşılaştırması: İLK ve SON kullanılabilir değerin yönü. Ara
   * dalgalanmalar steps'tedir; kullanılabilir değer < 2 ise
   * "undetermined" (uydurma yön yok).
   */
  readonly direction: "increasing" | "decreasing" | "flat" | "undetermined";
}

/**
 * İhlal trendi çıktısı. Bilinçli olarak BİLEŞİK SKOR ALANI YOKTUR
 * (TŞ §13: ölçüler kalite skoru olarak tek sayıya indirgenmez) — metrik
 * başına ayrı dizi; nokta başına aktif + baskılanmış sayılar ayrı alanlar.
 */
export interface TimelineViolationTrend {
  readonly evaluatedPoints: number;
  readonly unavailablePoints: number;
  readonly points: readonly TimelineTrendPointEvaluation[];
  /** Metrik başına ayrı dizi; sıra sabittir: [no-cycles, forbidden-dependency]. */
  readonly series: readonly TimelineTrendSeries[];
}

/** Trend dahil timeline çıktısı (spawn katmanı sözleşmesi). */
export interface ArchitectureTimelineWithTrend extends ArchitectureTimeline {
  readonly trend: TimelineViolationTrend;
}

/** Baseline blob'u olmayan ref'ler boş baseline ile değerlendirilir. */
const EMPTY_TREND_BASELINE: ArchitectureBaseline = {
  version: 1,
  suppressions: [],
};

const TREND_METRICS: readonly TimelineTrendMetric[] = [
  "no-cycles",
  "forbidden-dependency",
];

/**
 * İçerik kümesinin sentetik snapshot içerik karması: guard bulgu üretiminde
 * snapshot.meta.id olarak kullanılır. Aynı içerik her zaman aynı kimliği
 * üretir (kripto hash yalnızca kimlik türetimi içindir — bir ölçüm/skor
 * değildir ve çıktıya taşınmaz).
 */
function contentSetHash(contentSet: CompareContentSet): string {
  try {
    return sha256Hex(utf8Encode(canonicalJson(contentSet as unknown as JsonValue)));
  } catch (error) {
    if (error instanceof DomainError) {
      throw new GraphRepositoryError(
        "compare/non-json-attribute",
        `Content set cannot be serialized to JSON: ${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * CompareContentSet → sentetik SnapshotGraph (C2 `findViolations` girdisi).
 * TEK yeniden kullanım ilkesi: node kimliği ve katalog doğrulaması
 * compare'in kimlik işlevinden (`compareIdentityKey`) gelir; kural
 * değerlendirmesi guard çekirdeğinden gelir — bu modül hiçbir kuralı veya
 * kimliği yeniden uygulamaz. Kodlanmamış TypeError yerine coded
 * GraphRepositoryError üretilir (TŞ §19: içerik güvenilmez girdidir).
 */
function convertContentSetToSnapshotGraph(
  contentSet: CompareContentSet,
): SnapshotGraph {
  const shapeError = describeManifestShapeError(contentSet);
  if (shapeError !== null) {
    throw new GraphRepositoryError(
      "timeline/trend-invalid-content",
      `Trend content does not match the content contract: ${shapeError}`,
    );
  }
  const nodeByKey = new Map<string, CompareNode>();
  for (const node of contentSet.nodes) {
    // compareIdentityKey aynı zamanda katalog türü + boş olmayan
    // qualifiedName denetimini yapar (compare/unknown-node-kind,
    // compare/empty-qualified-name).
    const key = compareIdentityKey(node);
    if (nodeByKey.has(key)) {
      throw new GraphRepositoryError(
        "compare/duplicate-node",
        `Duplicate node identity in the same content set: ${key}`,
      );
    }
    nodeByKey.set(key, node);
  }
  const graphNodes: GraphNode[] = [...nodeByKey.entries()].map(([key, node]) => {
    const relativePath = node.relativePath;
    return {
      id: key,
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      ...(node.language === undefined ? {} : { language: node.language }),
      // Sentetik span: guard yalnızca location.relativePath'i okur (glob
      // yol eşleşmesi); satır/hash alanları dolum (filler) değeridir ve
      // hiçbir bulguya girmez.
      ...(relativePath === undefined
        ? {}
        : {
            location: {
              relativePath,
              startLine: 1,
              endLine: 1,
              sourceHash: "timeline-trend-synthetic",
            },
          }),
      attributes: node.attributes ?? {},
    };
  });
  const edgeKeys = new Set<string>();
  const graphEdges: GraphEdge[] = [];
  for (const edge of contentSet.edges) {
    if (!EDGE_KIND_SET.has(edge.kind)) {
      throw new GraphRepositoryError(
        "compare/unknown-edge-kind",
        `Unknown edge kind: ${String(edge.kind)}`,
      );
    }
    if (!RESOLUTION_SET.has(edge.resolution)) {
      throw new GraphRepositoryError(
        "compare/unknown-resolution",
        `Unknown resolution value: ${String(edge.resolution)}`,
      );
    }
    const fromKey = compareIdentityKey(edge.from);
    const toKey = compareIdentityKey(edge.to);
    if (!nodeByKey.has(fromKey) || !nodeByKey.has(toKey)) {
      throw new GraphRepositoryError(
        "compare/dangling-edge",
        `Edge endpoint does not match any node in the set (${edge.kind}): ${
          nodeByKey.has(fromKey) ? toKey : fromKey
        }`,
      );
    }
    // Kenar kimliği compare sözleşmesiyle aynı: (kind, from, to); resolution
    // kimliğe girmez (compare/duplicate-edge tanımı).
    const edgeKey = canonicalJson([edge.kind, fromKey, toKey]);
    if (edgeKeys.has(edgeKey)) {
      throw new GraphRepositoryError(
        "compare/duplicate-edge",
        `Duplicate edge identity in the same content set: ${edgeKey}`,
      );
    }
    edgeKeys.add(edgeKey);
    graphEdges.push({
      id: edgeKey,
      from: fromKey,
      to: toKey,
      kind: edge.kind,
      resolution: edge.resolution,
      // İçerik kümesi sözleşmesi kanıt taşımaz; guard kanıt saymaz.
      evidenceIds: [],
    });
  }
  return {
    meta: {
      id: `timeline-trend:${contentSetHash(contentSet)}`,
      workspaceId: "timeline-trend",
      revision: { id: "timeline-trend", sequence: 0 },
      configHash: "timeline-trend",
      analyzerFingerprint: "timeline-trend",
      state: "ready",
      createdAt: "1970-01-01T00:00:00.000Z",
    },
    nodes: [...graphNodes].sort(byGraphId),
    edges: [...graphEdges].sort(byGraphId),
    evidence: [],
  };
}

/** Tek trend noktasını değerlendirir; içerik/policy sözleşme ihlali coded
 * 'unavailable' nedenine dönüşür (uydurma sayı yok), diğer hatalar ürün
 * hatası olarak yükselir. */
function evaluateTrendPoint(
  index: number,
  point: TimelineTrendPointInput,
): TimelineTrendPointEvaluation {
  assertValidGitRef(point.ref);
  const base = { index, ref: point.ref };
  if (point.content.status !== "analyzed") {
    return { ...base, status: "unavailable", reason: point.content.reason };
  }
  if (point.policy.status === "missing") {
    return {
      ...base,
      status: "unavailable",
      reason: `policy-not-found: ${TIMELINE_POLICY_BLOB_PATH}`,
    };
  }
  if (point.policy.status === "invalid") {
    return {
      ...base,
      status: "unavailable",
      reason: `policy-invalid: ${point.policy.reason}`,
    };
  }
  if (point.baseline.status === "invalid") {
    return {
      ...base,
      status: "unavailable",
      reason: `baseline-invalid: ${point.baseline.reason}`,
    };
  }
  try {
    const snapshot = convertContentSetToSnapshotGraph(point.content.contentSet);
    // TEK kural değerlendirme noktası: C2 guard çekirdeği.
    const findings = findViolations(
      snapshot,
      point.policy.policy,
      point.baseline.status === "ok" ? point.baseline.baseline : EMPTY_TREND_BASELINE,
    );
    let noCycles = 0;
    let noCyclesSuppressed = 0;
    let forbidden = 0;
    let forbiddenSuppressed = 0;
    for (const finding of findings) {
      if (finding.ruleType === "no-cycles") {
        if (finding.suppressed) noCyclesSuppressed += 1;
        else noCycles += 1;
      } else {
        if (finding.suppressed) forbiddenSuppressed += 1;
        else forbidden += 1;
      }
    }
    return {
      ...base,
      status: "evaluated",
      evaluatedRules: point.policy.policy.rules.length,
      noCyclesViolations: noCycles,
      noCyclesSuppressed,
      forbiddenDependencyViolations: forbidden,
      forbiddenDependencySuppressed: forbiddenSuppressed,
    };
  } catch (error) {
    // İçerik sözleşmesini ihlal eden revizyon içeriği o noktayı ölçülemez
    // yapar (diğer noktalar ve diff aralıkları etkilenmez); guard hataları
    // (policy/baseline) üstte ayrı neden olarak ele alınmıştır; kalan
    // hatalar ürün hatasıdır.
    if (
      error instanceof GraphRepositoryError &&
      (error.code.startsWith("compare/") ||
        error.code === "timeline/trend-invalid-content")
    ) {
      return {
        ...base,
        status: "unavailable",
        reason: `${error.code}: ${error.message}`,
      };
    }
    throw error;
  }
}

/**
 * Metrik başına ayrı seri: hizalı değerler + yalnızca gerçek ölçüm çiftleri
 * üzerinden adımlar + uç karşılaştırması. Saf ve deterministiktir.
 */
function buildTrendSeries(
  metric: TimelineTrendMetric,
  evaluations: readonly TimelineTrendPointEvaluation[],
): TimelineTrendSeries {
  const values: TimelineTrendSeriesValue[] = evaluations.map((evaluation) => {
    if (evaluation.status !== "evaluated") {
      return {
        index: evaluation.index,
        ref: evaluation.ref,
        count: null,
        reason: evaluation.reason,
      };
    }
    return {
      index: evaluation.index,
      ref: evaluation.ref,
      count:
        metric === "no-cycles"
          ? evaluation.noCyclesViolations
          : evaluation.forbiddenDependencyViolations,
    };
  });
  const steps: TimelineTrendStep[] = [];
  // previous yalnızca evaluated üyeye daraltılmış tip taşır (atanmadan önce
  // status guard'ı geçilidir; union'a geri genişletme ölçüm alanlarına
  // erişimi bozar).
  let previous:
    | Extract<TimelineTrendPointEvaluation, { status: "evaluated" }>
    | undefined;
  for (const evaluation of evaluations) {
    if (evaluation.status !== "evaluated") {
      // Zincir kırılmaz: sonraki evaluated nokta, sondaki evaluated noktayla
      // eşleşir; atlama fromIndex/toIndex'te görünür ve eksik nokta
      // values[]'te null + neden olarak ayrıca işaretlidir.
      continue;
    }
    const current = evaluation;
    const currentCount =
      metric === "no-cycles"
        ? current.noCyclesViolations
        : current.forbiddenDependencyViolations;
    if (previous !== undefined) {
      const previousCount =
        metric === "no-cycles"
          ? previous.noCyclesViolations
          : previous.forbiddenDependencyViolations;
      steps.push({
        fromIndex: previous.index,
        toIndex: current.index,
        fromRef: previous.ref,
        toRef: current.ref,
        fromCount: previousCount,
        toCount: currentCount,
        direction:
          currentCount > previousCount
            ? "increasing"
            : currentCount < previousCount
              ? "decreasing"
              : "flat",
      });
    }
    previous = current;
  }
  const available = values.filter(
    (value): value is { index: number; ref: string; count: number } =>
      value.count !== null,
  );
  let direction: TimelineTrendSeries["direction"] = "undetermined";
  if (available.length >= 2) {
    const first = available[0];
    const last = available[available.length - 1];
    if (first !== undefined && last !== undefined) {
      direction =
        last.count > first.count
          ? "increasing"
          : last.count < first.count
            ? "decreasing"
            : "flat";
    }
  }
  return { metric, values, steps, direction };
}

/**
 * Saf ihlal trendi çekirdeği (sprint-6 E5): seçilmiş milestone noktalarının
 * içeriklerini C2 guard kurallarıyla nokta başına değerlendirir; sonuç
 * nokta başına kayıtlar + metrik başına ayrı serilerdir. Saat/fs/spawn
 * okumaz; aynı girdi her zaman aynı JSON'u üretir. Hiçbir bileşik "kalite
 * skoru" üretilmez (TŞ §13 kırmızı çizgisi).
 *
 * Hata kodu (GraphRepositoryError.code):
 * - timeline/trend-invalid-input: points dizisi bozuk veya ref tekrarlı.
 * Nokta içi sözleşme ihlalleri hata DEĞİLDİR: o nokta coded 'unavailable'
 * olur (manifest bozuk, policy yok/bozuk, katalog dışı tür vb.).
 */
export function buildTimelineViolationTrend(
  input: BuildTimelineViolationTrendInput,
): TimelineViolationTrend {
  const points = input.points;
  if (!Array.isArray(points)) {
    throw new GraphRepositoryError(
      "timeline/trend-invalid-input",
      "points must be an array",
    );
  }
  if (points.length === 0) {
    throw new GraphRepositoryError(
      "timeline/trend-invalid-input",
      "a trend needs at least 1 point (0 given)",
    );
  }
  const seenRefs = new Set<string>();
  for (const point of points) {
    if (point === null || typeof point !== "object") {
      throw new GraphRepositoryError(
        "timeline/trend-invalid-input",
        "every point must be an object",
      );
    }
    if (typeof point.ref !== "string" || point.ref.length === 0) {
      throw new GraphRepositoryError(
        "timeline/trend-invalid-input",
        "point ref must be a non-empty string",
      );
    }
    if (seenRefs.has(point.ref)) {
      throw new GraphRepositoryError(
        "timeline/trend-invalid-input",
        `Ref was given more than once: ${point.ref}`,
      );
    }
    seenRefs.add(point.ref);
  }

  const evaluations = points.map((point, index) =>
    deepFreeze(evaluateTrendPoint(index, point)),
  );
  const trend = deepFreeze({
    evaluatedPoints: evaluations.filter(
      (evaluation) => evaluation.status === "evaluated",
    ).length,
    unavailablePoints: evaluations.filter(
      (evaluation) => evaluation.status === "unavailable",
    ).length,
    points: evaluations,
    series: TREND_METRICS.map((metric) =>
      buildTrendSeries(metric, evaluations),
    ),
  });
  return trend;
}

// ---------------------------------------------------------------------------
// Spawn katmanı — C3 salt-okunur git yardımcıları (git-read.ts)
// ---------------------------------------------------------------------------

function parseCommitParents(rawCommit: string): string[] {
  const parents: string[] = [];
  for (const line of rawCommit.split("\n")) {
    if (line === "") break; // başlık bloğu bitti
    if (line.startsWith("parent ")) {
      const sha = line.slice("parent ".length).trim();
      if (SHA_PATTERN.test(sha)) parents.push(sha);
    }
  }
  return parents;
}

function parseTagObjectTarget(rawTag: string): string {
  for (const line of rawTag.split("\n")) {
    if (line === "") break;
    if (line.startsWith("object ")) {
      const sha = line.slice("object ".length).trim();
      if (SHA_PATTERN.test(sha)) return sha;
      break;
    }
  }
  throw new GraphRepositoryError(
    "timeline/invalid-range",
    "Annotated tag object has no valid 'object' header",
  );
}

/**
 * Bir ref'i türü commit olan bir adresleyiciye (sha veya ref adı) peel eder.
 * Yalnızca salt-okunur `cat-file` kullanır (TŞ §13 güven sözleşmesi;
 * checkout/reset/clean imkânsız). Var olmayan ref → compare/ref-not-found;
 * commit/tag olmayan nesne ve çok derin tag zinciri → timeline/invalid-range.
 */
async function resolveCommitId(
  repoRoot: string,
  ref: string,
  options?: RunGitOptions,
): Promise<string> {
  // TŞ §13 güven sözleşmesi: dışarıdan gelen ref, argv'ya girmeden ÖNCE
  // biçim doğrulamasından geçer ('--' ile başlayan seçenek enjeksiyonu
  // dahil reddedilir). Hata kodu C3 katmanının kodudur.
  assertValidGitRef(ref);
  let current = ref;
  for (let depth = 0; depth <= MAX_TAG_PEEL_DEPTH; depth++) {
    let type: string;
    try {
      type = (await runGit(repoRoot, ["cat-file", "-t", current], options)).trim();
    } catch (error) {
      if (
        error instanceof GraphRepositoryError &&
        error.code === "compare/git-command-failed"
      ) {
        throw new GraphRepositoryError(
          "compare/ref-not-found",
          `Ref could not be resolved: ${ref}`,
        );
      }
      throw error;
    }
    if (type === "commit") return current;
    if (type === "tag") {
      const raw = await runGit(repoRoot, ["cat-file", "tag", current], options);
      current = parseTagObjectTarget(raw);
      continue;
    }
    throw new GraphRepositoryError(
      "timeline/invalid-range",
      `Ref is not a commit or tag (type: ${type}): ${ref}`,
    );
  }
  throw new GraphRepositoryError(
    "timeline/invalid-range",
    `Tag chain exceeded depth ${MAX_TAG_PEEL_DEPTH}: ${ref}`,
  );
}

/**
 * Bounded history-range: `to`'dan `from`'a ilk-ebeveyn zinciri yürüyüşü
 * (merge'lerde birinci ebeveyn). Uçlar dahil; sonuç eskiden yeniye sıralı
 * ref/sha etiketleridir ([from, ..., to]). TŞ §13 "bounded history-range":
 * yürüyüş maxRangeWalk commit ile sınırlıdır; sınır aşılır veya `from`
 * zincirde bulunamazsa açık ret verilir (sessiz kırpma yok).
 *
 * Özdeşlik kuralı: git nesneleri içerik adreslemelidir — ham commit nesnesi
 * içeriği eşit iki girdi aynı nesnedir. Böylece ürün katmanında hiçbir
 * kriptografik hash hesaplanmaz; zincir etiketleri git'in KENDİ ürettiği
 * sha'lar (parent/object satırları) ya da çağıranın ref adlarıdır.
 */
async function resolveRangeCommitChain(
  repoRoot: string,
  from: string,
  to: string,
  maxRangeWalk: number,
  options?: RunGitOptions,
): Promise<string[]> {
  if (from === to) {
    throw new GraphRepositoryError(
      "timeline/invalid-range",
      `Range endpoints must differ: ${from}`,
    );
  }
  const fromId = await resolveCommitId(repoRoot, from, options);
  const fromRaw = await runGit(repoRoot, ["cat-file", "commit", fromId], options);
  const tipId = await resolveCommitId(repoRoot, to, options);
  const chain: string[] = [tipId];
  let cursorId = tipId;
  let cursorRaw = await runGit(repoRoot, ["cat-file", "commit", cursorId], options);
  while (cursorRaw !== fromRaw) {
    const parents = parseCommitParents(cursorRaw);
    const firstParent = parents[0];
    if (firstParent === undefined) {
      throw new GraphRepositoryError(
        "timeline/invalid-range",
        `from ('${from}') was not found on the first-parent chain of '${to}' (reached the root commit)`,
      );
    }
    cursorId = firstParent;
    chain.push(cursorId);
    if (chain.length > maxRangeWalk) {
      throw new GraphRepositoryError(
        "timeline/invalid-range",
        `History walk exceeded maxRangeWalk=${maxRangeWalk}; from ('${from}') was not found within that limit`,
      );
    }
    cursorRaw = await runGit(repoRoot, ["cat-file", "commit", cursorId], options);
  }
  chain.reverse();
  return chain;
}

/**
 * Reconstructs a structural file-level `CompareContentSet` directly from
 * hardened read-only `readGitTree` / `readGitBlob` access without trusting any
 * committed `.causoryn/architecture-snapshot.json` blob.
 *
 * Suitable as a lightweight `reconstructFromGitTree` callback for repositories
 * that do not commit `.causoryn/architecture-snapshot.json`. Higher layers with
 * access to language adapters can supply a full AST-level reconstructor using
 * the same `reconstructFromGitTree` seam.
 */
export async function reconstructFileContentSetFromGitTree(
  repoRoot: string,
  ref: string,
  options?: ReadGitTreeOptions,
): Promise<CompareContentSet> {
  const entries = await readGitTree(repoRoot, ref, options);
  const nodes: CompareNode[] = [];
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    if (entry.path === TIMELINE_SNAPSHOT_BLOB_PATH) continue;
    const blobSha =
      entry.sha ??
      sha256Hex(utf8Encode(await readGitBlob(repoRoot, ref, entry.path, options)));
    nodes.push({
      kind: "File",
      qualifiedName: entry.path,
      relativePath: entry.path,
      attributes: { blobSha },
    });
  }
  return { nodes, edges: [] };
}

/**
 * Resolves a timeline point for `ref` using a strict trust hierarchy:
 * 1. `options.snapshotLookup(commitSha, ref)` — trusted locally-indexed
 *    snapshot (e.g., local SQLite history keyed by canonical commit SHA).
 *    ZERO `trustWarning`.
 * 2. `options.reconstructFromGitTree(repoRoot, ref)` — local reconstruction
 *    directly from hardened read-only `readGitTree`/`readGitBlob` source files
 *    without trusting any committed `.causoryn/architecture-snapshot.json`.
 *    ZERO `trustWarning`.
 * 3. Legacy fallback: read repo-committed `.causoryn/architecture-snapshot.json`
 *    via hardened `readGitBlob`. Attaches explicit
 *    `trustWarning: "snapshot-loaded-from-committed-git-blob"` so callers know
 *    the snapshot came from a repo-committed file rather than local engine
 *    verification.
 */
export async function readTimelinePointFromGit(
  repoRoot: string,
  ref: string,
  options?: ReadTimelinePointOptions,
): Promise<TimelinePointContent> {
  if (
    options?.snapshotLookup !== undefined &&
    typeof options.snapshotLookup !== "function"
  ) {
    throw new GraphRepositoryError(
      "timeline/invalid-input",
      "snapshotLookup must be a function",
    );
  }
  if (
    options?.reconstructFromGitTree !== undefined &&
    typeof options.reconstructFromGitTree !== "function"
  ) {
    throw new GraphRepositoryError(
      "timeline/invalid-input",
      "reconstructFromGitTree must be a function",
    );
  }

  // Tier 1: Trusted local snapshot lookup by canonical commit SHA (SQLite seam).
  if (options?.snapshotLookup !== undefined && ref !== WORKING_TREE_REF) {
    const commitSha =
      options.commitSha !== undefined && SHA_PATTERN.test(options.commitSha)
        ? options.commitSha
        : SHA_PATTERN.test(ref)
          ? ref
          : await resolveGitCommitRef(repoRoot, ref, options);
    const lookedUp = await options.snapshotLookup(commitSha, ref);
    if (lookedUp !== undefined) {
      const shapeError = describeManifestShapeError(lookedUp);
      if (shapeError !== null) {
        return {
          status: "unanalyzed",
          reason: `snapshot-lookup-invalid-shape: ${shapeError}`,
        };
      }
      return { status: "analyzed", contentSet: lookedUp };
    }
  }

  // Tier 2: Trusted local source-tree reconstruction via readGitTree/readGitBlob seam.
  if (options?.reconstructFromGitTree !== undefined) {
    const reconstructed = await options.reconstructFromGitTree(repoRoot, ref);
    if (reconstructed !== undefined) {
      const shapeError = describeManifestShapeError(reconstructed);
      if (shapeError !== null) {
        return {
          status: "unanalyzed",
          reason: `git-tree-reconstruct-invalid-shape: ${shapeError}`,
        };
      }
      return { status: "analyzed", contentSet: reconstructed };
    }
  }

  // Tier 3: Legacy fallback — repo-committed `.causoryn/architecture-snapshot.json` blob.
  let raw: string;
  try {
    raw = await readGitBlob(repoRoot, ref, TIMELINE_SNAPSHOT_BLOB_PATH, options);
  } catch (error) {
    if (
      error instanceof GraphRepositoryError &&
      error.code === "compare/blob-not-found"
    ) {
      return {
        status: "unanalyzed",
        reason: `manifest-not-found: ${TIMELINE_SNAPSHOT_BLOB_PATH}`,
      };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: "unanalyzed",
      reason: `manifest-not-json: ${detail}`,
    };
  }

  const shapeError = describeManifestShapeError(parsed);
  if (shapeError !== null) {
    return { status: "unanalyzed", reason: `manifest-invalid-shape: ${shapeError}` };
  }
  // Şekil denetimi başarıyla geçti; sözleşme tipleri buradan itibaren geçerli.
  const set = parsed as CompareContentSet;
  return {
    status: "analyzed",
    contentSet: set,
    trustWarning: TIMELINE_TRUST_WARNING_COMMITTED_GIT_BLOB,
  };
}

/**
 * Bir ref'teki guard policy dosyasını salt-okunur okur. Blob yoksa
 * `missing`; YAML/şema/glob çözümlemesi başarısızsa coded `invalid` döner
 * (uydurma policy üretmez — nokta trend'de ölçülemez işaretlenir). Diğer
 * git altyapı hataları ürün hatası olarak yükselir. Deterministik: aynı
 * blob her zaman aynı sonucu üretir.
 */
export async function readTimelineTrendPolicyFromGit(
  repoRoot: string,
  ref: string,
  options?: RunGitOptions,
): Promise<TimelineTrendPolicyResult> {
  let text: string;
  try {
    text = await readGitBlob(repoRoot, ref, TIMELINE_POLICY_BLOB_PATH, options);
  } catch (error) {
    if (
      error instanceof GraphRepositoryError &&
      error.code === "compare/blob-not-found"
    ) {
      return { status: "missing" };
    }
    throw error;
  }
  try {
    return { status: "ok", policy: parseArchitecturePolicy(text) };
  } catch (error) {
    if (error instanceof GuardError) {
      return { status: "invalid", reason: `${error.code}: ${error.message}` };
    }
    throw error;
  }
}

/**
 * Bir ref'teki baseline (suppression) dosyasını salt-okunur okur. Blob yoksa
 * boş baseline ile değerlendirme geçerlidir (suppression yönetişim yüzeyi
 * zorunlu değildir); bozuk blob coded `invalid` döner.
 */
export async function readTimelineTrendBaselineFromGit(
  repoRoot: string,
  ref: string,
  options?: RunGitOptions,
): Promise<TimelineTrendBaselineResult> {
  let text: string;
  try {
    text = await readGitBlob(repoRoot, ref, TIMELINE_BASELINE_BLOB_PATH, options);
  } catch (error) {
    if (
      error instanceof GraphRepositoryError &&
      error.code === "compare/blob-not-found"
    ) {
      return { status: "missing" };
    }
    throw error;
  }
  try {
    return { status: "ok", baseline: parseArchitectureBaseline(text) };
  } catch (error) {
    if (error instanceof GuardError) {
      return { status: "invalid", reason: `${error.code}: ${error.message}` };
    }
    throw error;
  }
}

/**
 * Yüzeysel şekil denetimi: katalog doğrulaması (türlerin EDGE/NODE_KIND
 * kataloğuna uyumu) BİLİNLİKLE yapılmaz — derin doğrulama tek kaynak olarak
 * compare.ts'in diffContentSets sözleşmesine devredilir; ihlal aralıkta
 * `unanalyzed-interval` olarak raporlanır.
 */
function describeManifestShapeError(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "root must be an object";
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.nodes)) return "nodes is not an array";
  if (!Array.isArray(record.edges)) return "edges is not an array";
  for (const node of record.nodes) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return "node entry is not an object";
    }
    const nodeRecord = node as Record<string, unknown>;
    if (typeof nodeRecord.kind !== "string" || nodeRecord.kind.length === 0) {
      return "node 'kind' must be a non-empty string";
    }
    if (
      typeof nodeRecord.qualifiedName !== "string" ||
      nodeRecord.qualifiedName.length === 0
    ) {
      return "node 'qualifiedName' must be a non-empty string";
    }
    // TŞ §19 (depo güvenilmez girdi): relativePath ve signature, compare'in
    // pathSegmentSet/tokenize katmanlarına .split/.replace ile girer; türü
    // doğrulanmayan değer orada GraphRepositoryError sözleşmesi DIŞI bir
    // TypeError üretir. undefined YOKLUK demektir; varsa metin zorunludur.
    if (
      nodeRecord.relativePath !== undefined &&
      typeof nodeRecord.relativePath !== "string"
    ) {
      return "node 'relativePath', when present, must be a string";
    }
    if (
      nodeRecord.signature !== undefined &&
      typeof nodeRecord.signature !== "string"
    ) {
      return "node 'signature', when present, must be a string";
    }
  }
  for (const edge of record.edges) {
    if (edge === null || typeof edge !== "object" || Array.isArray(edge)) {
      return "edge entry is not an object";
    }
    const edgeRecord = edge as Record<string, unknown>;
    if (typeof edgeRecord.kind !== "string" || edgeRecord.kind.length === 0) {
      return "edge 'kind' must be a non-empty string";
    }
    if (typeof edgeRecord.resolution !== "string") {
      return "edge 'resolution' must be a string";
    }
    for (const side of ["from", "to"] as const) {
      const endpoint = edgeRecord[side];
      if (endpoint === null || typeof endpoint !== "object" || Array.isArray(endpoint)) {
        return `edge '${side}' endpoint is not an object`;
      }
      const endpointRecord = endpoint as Record<string, unknown>;
      if (
        typeof endpointRecord.kind !== "string" ||
        typeof endpointRecord.qualifiedName !== "string" ||
        endpointRecord.qualifiedName.length === 0
      ) {
        return `edge '${side}' endpoint must carry kind and qualifiedName`;
      }
    }
  }
  return null;
}

/**
 * Spawn orkestrasyonu: refs listesi YA DA bounded aralık → seçilmiş
 * noktaların içerikleri salt-okunur git okumasıyla toplanır → saf çekirdek.
 * Seçilmeyen noktaların içeriği OKUNMAZ (sampling maliyet sınırı); bunlar
 * çekirdeğe yapısal yer tutucu olarak geçer ve çıktıda yalnızca
 * `sampling.skipped` içinde ref'leriyle listelenir.
 *
 * Sprint-6 E5: seçilmiş her nokta için policy/baseline blob'ları da
 * salt-okunur okunur ve içerik kümesi C2 guard kurallarıyla nokta başına
 * değerlendirilir (`trend` bölümü — ihlal trendi; kalite skoru alanı YOK).
 * Seçilmeyen noktalar trend'e girmez (trend hizalaması timeline noktalarıyla
 * bire birdir).
 */
export async function buildArchitectureTimelineFromGit(
  repoRoot: string,
  input: TimelineGitInput,
  options?: RunGitOptions,
): Promise<ArchitectureTimelineWithTrend> {
  if (!path.isAbsolute(repoRoot)) {
    throw new GraphRepositoryError(
      "compare/invalid-repo-root",
      `repoRoot must be an absolute path: ${repoRoot}`,
    );
  }
  const hasRefs = input.refs !== undefined;
  const hasRange = input.range !== undefined;
  if (hasRefs === hasRange) {
    throw new GraphRepositoryError(
      "timeline/invalid-input",
      "exactly one of refs or range must be given",
    );
  }
  if (
    input.snapshotLookup !== undefined &&
    typeof input.snapshotLookup !== "function"
  ) {
    throw new GraphRepositoryError(
      "timeline/invalid-input",
      "snapshotLookup must be a function",
    );
  }
  if (
    input.reconstructFromGitTree !== undefined &&
    typeof input.reconstructFromGitTree !== "function"
  ) {
    throw new GraphRepositoryError(
      "timeline/invalid-input",
      "reconstructFromGitTree must be a function",
    );
  }

  const maxRevisions = resolveLimit(
    "maxRevisions",
    input.maxRevisions,
    TIMELINE_DEFAULTS.maxRevisions,
    TIMELINE_CEILINGS.maxRevisions,
    MIN_MAX_REVISIONS,
  );
  const maxRangeWalk = resolveLimit(
    "maxRangeWalk",
    input.maxRangeWalk,
    TIMELINE_DEFAULTS.maxRangeWalk,
    TIMELINE_CEILINGS.maxRangeWalk,
    MIN_MAX_RANGE_WALK,
  );

  let identifiers: readonly string[];
  if (hasRefs) {
    const refs = input.refs ?? [];
    if (refs.length < MIN_MAX_REVISIONS) {
      throw new GraphRepositoryError(
        "timeline/insufficient-points",
        `A timeline needs at least ${MIN_MAX_REVISIONS} refs (${refs.length} given)`,
      );
    }
    const seen = new Set<string>();
    for (const ref of refs) {
      assertValidGitRef(ref);
      if (seen.has(ref)) {
        throw new GraphRepositoryError(
          "timeline/duplicate-ref",
          `Ref was given more than once: ${ref}`,
        );
      }
      seen.add(ref);
    }
    // TÜM ref'ler örneklemeden ÖNCE çözümlenir: aksi hâlde sampling'e takılan
    // var olmayan/commit olmayan ref sessizce 'skipped' listesine düşer ve
    // aynı girdi maxRevisions'a bağlı olarak farklı davranış gösterirdi.
    // Maliyet: ref başına birkaç salt-okunur cat-file çağrısı — TŞ §13'ün
    // sampling gerekçesi pahalı İÇERİK taramasıdır, ref çözümlemesi değil.
    for (const ref of refs) {
      await resolveCommitId(repoRoot, ref, options);
    }
    identifiers = refs;
  } else {
    const range = input.range;
    if (range === undefined) {
      throw new GraphRepositoryError(
        "timeline/invalid-input",
        "range must not be undefined",
      );
    }
    const chain = await resolveRangeCommitChain(
      repoRoot,
      range.from,
      range.to,
      maxRangeWalk,
      options,
    );
    if (chain.length < MIN_MAX_REVISIONS) {
      throw new GraphRepositoryError(
        "timeline/invalid-range",
        `Range resolved to a single commit (from and to point to the same object): ` +
          `${range.from}, ${range.to}`,
      );
    }
    // Zincir eskiden yeniye: [fromId, ..., tipId]. Uçlar çağıranın ref adını
    // taşır; ara noktalar git'in ürettiği sha etiketidir.
    identifiers = chain.map((id, position) => {
      if (position === 0) return range.from;
      if (position === chain.length - 1) return range.to;
      return id;
    });
  }

  const selection = selectSampledIndices(identifiers.length, maxRevisions);
  const selectedSet = new Set(selection);

  const pointOptions: ReadTimelinePointOptions = {
    ...(options ?? {}),
    ...(input.snapshotLookup === undefined ? {} : { snapshotLookup: input.snapshotLookup }),
    ...(input.reconstructFromGitTree === undefined
      ? {}
      : { reconstructFromGitTree: input.reconstructFromGitTree }),
  };

  const points: TimelinePointInput[] = [];
  const trendPoints: TimelineTrendPointInput[] = [];
  for (let index = 0; index < identifiers.length; index++) {
    const ref = identifiers[index];
    if (ref === undefined) continue; // imkânsız; savunma katmanı
    if (!selectedSet.has(index)) {
      // Örnekleme sınırı: içeriği OKUMA — yalnızca yapısal yer tutucu.
      // (Refs modunda ref'in varlığı seçimden ÖNCE zaten doğrulandı; burada
      // yalnızca pahalı içerik okuması atlanır. Trend de atlanan noktayı
      // OKUMAZ: trend noktaları seçilmiş noktalarla hizalıdır.)
      points.push({
        ref,
        content: { status: "unanalyzed", reason: "skipped-by-sampling" },
      });
      continue;
    }
    const content = await readTimelinePointFromGit(repoRoot, ref, pointOptions);
    points.push({ ref, content });
    // Sprint-6 E5: trend için policy/baseline blob'ları da aynı salt-okunur
    // okuma sözleşmesiyle alınır (nokta başına 2 ek cat-file; yalnızca
    // SEÇİLMİŞ noktalar için).
    trendPoints.push({
      ref,
      content,
      policy: await readTimelineTrendPolicyFromGit(repoRoot, ref, options),
      baseline: await readTimelineTrendBaselineFromGit(repoRoot, ref, options),
    });
  }

  const base = buildArchitectureTimeline({
    points,
    maxRevisions,
    maxRangeWalk,
  });
  const trend = buildTimelineViolationTrend({ points: trendPoints });
  return deepFreeze({ ...base, trend });
}
