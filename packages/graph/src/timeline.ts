import path from "node:path";

import type { CompareContentSet, CompareNode } from "./compare.js";
import { API_SURFACE_NODE_KINDS, diffContentSets } from "./compare.js";
import { GraphRepositoryError } from "./errors.js";
import {
  assertValidGitRef,
  readGitBlob,
  runGit,
  type RunGitOptions,
} from "./git-read.js";

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
 * - Kapsam notu: TŞ §13'teki tam trend göstergeleri (layer violations,
 *   cycles, public contract breaking candidates, module coupling, test
 *   impact adayları) revizyon başına guard/snapshot analizi gerektirir; bu
 *   çekirdek, görev kapsamı gereği compare çıktısından türeyen node/edge/API
 *   değişim sayılarını üretir (ihlal trendi sprint-6 E5 dilimi). Yine aynı
 *   bölüm gereği hiçbir ölçü tek "kalite skoruna" indirgenmez.
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
  | { readonly status: "analyzed"; readonly contentSet: CompareContentSet }
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
      `${name} tamsayı ve >= ${minimum} olmalı: ${String(requested)}`,
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
      `maxRevisions tamsayı ve >= ${MIN_MAX_REVISIONS} olmalı: ${String(maxRevisions)}`,
    );
  }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new GraphRepositoryError(
      "timeline/invalid-limit",
      `count tamsayı ve >= 0 olmalı: ${String(count)}`,
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
      `Nokta içeriği 'analyzed' veya 'unanalyzed' olmalı: ${point.ref}`,
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
        `Analiz edilmiş nokta içerik sözleşmesi bozuk (${point.ref}): ${shapeError}`,
      );
    }
  } else if (
    typeof content.reason !== "string" ||
    content.reason.length === 0
  ) {
    throw new GraphRepositoryError(
      "timeline/invalid-input",
      `unanalyzed nokta neden (reason) metni taşımali: ${point.ref}`,
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
      "points bir dizi olmalı",
    );
  }
  if (points.length < MIN_MAX_REVISIONS) {
    throw new GraphRepositoryError(
      "timeline/insufficient-points",
      `Zaman çizgisi en az ${MIN_MAX_REVISIONS} nokta gerektirir (${points.length} verildi)`,
    );
  }
  const seenRefs = new Set<string>();
  for (const point of points) {
    assertPointContract(point);
    if (seenRefs.has(point.ref)) {
      throw new GraphRepositoryError(
        "timeline/duplicate-ref",
        `Ref iki kez verildi: ${point.ref}`,
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
  let analyzedCount = 0;
  let unanalyzedCount = 0;
  selection.forEach((sourceIndex, index) => {
    const point = points[sourceIndex];
    if (point === undefined) {
      throw new GraphRepositoryError(
        "timeline/invalid-input",
        `Seçim indeksi nokta dizisi dışında: ${String(sourceIndex)}`,
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
      });
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
  });
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
    "Annotated tag nesnesinde geçerli 'object' başlığı yok",
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
          `Ref çözümlenemedi: ${ref}`,
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
      `Ref bir commit/tag değil (tür: ${type}): ${ref}`,
    );
  }
  throw new GraphRepositoryError(
    "timeline/invalid-range",
    `Tag zinciri ${MAX_TAG_PEEL_DEPTH} derinliği aştı: ${ref}`,
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
      `Aralık uçları aynı olamaz: ${from}`,
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
        `from ('${from}') — '${to}' ref'inin ilk-ebeveyn zincirinde bulunamadı (kök commit'e ulaşıldı)`,
      );
    }
    cursorId = firstParent;
    chain.push(cursorId);
    if (chain.length > maxRangeWalk) {
      throw new GraphRepositoryError(
        "timeline/invalid-range",
        `Geçmiş yürüyüşü maxRangeWalk=${maxRangeWalk} sınırını aştı; from ('${from}') bu sınır içinde bulunamadı`,
      );
    }
    cursorRaw = await runGit(repoRoot, ["cat-file", "commit", cursorId], options);
  }
  chain.reverse();
  return chain;
}

/**
 * Bir ref'teki mimari snapshot blob'unu okur ve içerik sonucuna çevirir.
 * Blob yoksa / JSON değilse / şekli bozuksa nokta `unanalyzed` döner
 * (uydurma içerik ÜRETİLMEZ); git altyapı hataları ürün hatası olarak
 * yükselir.
 */
export async function readTimelinePointFromGit(
  repoRoot: string,
  ref: string,
  options?: RunGitOptions,
): Promise<TimelinePointContent> {
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
  return { status: "analyzed", contentSet: set };
}

/**
 * Yüzeysel şekil denetimi: katalog doğrulaması (türlerin EDGE/NODE_KIND
 * kataloğuna uyumu) BİLİNLİKLE yapılmaz — derin doğrulama tek kaynak olarak
 * compare.ts'in diffContentSets sözleşmesine devredilir; ihlal aralıkta
 * `unanalyzed-interval` olarak raporlanır.
 */
function describeManifestShapeError(parsed: unknown): string | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "kök bir nesne olmalı";
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.nodes)) return "nodes bir dizi değil";
  if (!Array.isArray(record.edges)) return "edges bir dizi değil";
  for (const node of record.nodes) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      return "node girişi bir nesne değil";
    }
    const nodeRecord = node as Record<string, unknown>;
    if (typeof nodeRecord.kind !== "string" || nodeRecord.kind.length === 0) {
      return "node 'kind' alanı boş olmayan metin olmalı";
    }
    if (
      typeof nodeRecord.qualifiedName !== "string" ||
      nodeRecord.qualifiedName.length === 0
    ) {
      return "node 'qualifiedName' alanı boş olmayan metin olmalı";
    }
    // TŞ §19 (depo güvenilmez girdi): relativePath ve signature, compare'in
    // pathSegmentSet/tokenize katmanlarına .split/.replace ile girer; türü
    // doğrulanmayan değer orada GraphRepositoryError sözleşmesi DIŞI bir
    // TypeError üretir. undefined YOKLUK demektir; varsa metin zorunludur.
    if (
      nodeRecord.relativePath !== undefined &&
      typeof nodeRecord.relativePath !== "string"
    ) {
      return "node 'relativePath' alanı varsa metin olmalı";
    }
    if (
      nodeRecord.signature !== undefined &&
      typeof nodeRecord.signature !== "string"
    ) {
      return "node 'signature' alanı varsa metin olmalı";
    }
  }
  for (const edge of record.edges) {
    if (edge === null || typeof edge !== "object" || Array.isArray(edge)) {
      return "edge girişi bir nesne değil";
    }
    const edgeRecord = edge as Record<string, unknown>;
    if (typeof edgeRecord.kind !== "string" || edgeRecord.kind.length === 0) {
      return "edge 'kind' alanı boş olmayan metin olmalı";
    }
    if (typeof edgeRecord.resolution !== "string") {
      return "edge 'resolution' alanı metin olmalı";
    }
    for (const side of ["from", "to"] as const) {
      const endpoint = edgeRecord[side];
      if (endpoint === null || typeof endpoint !== "object" || Array.isArray(endpoint)) {
        return `edge '${side}' ucu bir nesne değil`;
      }
      const endpointRecord = endpoint as Record<string, unknown>;
      if (
        typeof endpointRecord.kind !== "string" ||
        typeof endpointRecord.qualifiedName !== "string" ||
        endpointRecord.qualifiedName.length === 0
      ) {
        return `edge '${side}' ucu kind/qualifiedName taşımali`;
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
 */
export async function buildArchitectureTimelineFromGit(
  repoRoot: string,
  input: TimelineGitInput,
  options?: RunGitOptions,
): Promise<ArchitectureTimeline> {
  if (!path.isAbsolute(repoRoot)) {
    throw new GraphRepositoryError(
      "compare/invalid-repo-root",
      `repoRoot mutlak yol olmalı: ${repoRoot}`,
    );
  }
  const hasRefs = input.refs !== undefined;
  const hasRange = input.range !== undefined;
  if (hasRefs === hasRange) {
    throw new GraphRepositoryError(
      "timeline/invalid-input",
      "refs veya range'ten tam olarak BİRİ verilmelidir",
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
        `Zaman çizgisi en az ${MIN_MAX_REVISIONS} ref gerektirir (${refs.length} verildi)`,
      );
    }
    const seen = new Set<string>();
    for (const ref of refs) {
      assertValidGitRef(ref);
      if (seen.has(ref)) {
        throw new GraphRepositoryError(
          "timeline/duplicate-ref",
          `Ref iki kez verildi: ${ref}`,
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
        "range tanımsız olamaz",
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
        `Aralık tek commit'e çözümlendi (from ve to aynı nesneyi gösteriyor): ` +
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

  const points: TimelinePointInput[] = [];
  for (let index = 0; index < identifiers.length; index++) {
    const ref = identifiers[index];
    if (ref === undefined) continue; // imkânsız; savunma katmanı
    if (!selectedSet.has(index)) {
      // Örnekleme sınırı: içeriği OKUMA — yalnızca yapısal yer tutucu.
      // (Refs modunda ref'in varlığı seçimden ÖNCE zaten doğrulandı; burada
      // yalnızca pahalı içerik okuması atlanır.)
      points.push({
        ref,
        content: { status: "unanalyzed", reason: "skipped-by-sampling" },
      });
      continue;
    }
    const content = await readTimelinePointFromGit(repoRoot, ref, options);
    points.push({ ref, content });
  }

  return buildArchitectureTimeline({
    points,
    maxRevisions,
    maxRangeWalk,
  });
}
