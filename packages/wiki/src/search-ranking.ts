import type { Freshness, WikiPageKind } from "./schema.js";
import type { WikiSearchMatchedField, WikiSearchSkippedRankLeg } from "./search-schema.js";

/**
 * Wiki arama sıralama çekirdeği — TŞ v2.1 §16A.3, sprint-4 W4.
 *
 * Sıralama ayakları (K-013/TŞ §16A.3 önceliği, yüksekten düşüğe):
 * 1. exact sembol/route eşleşmesi (sorgu, qualifiedSymbol/apiRoute'a
 *    büyük-küçük harf duyarsız BÜTÜN eşitlik)
 * 2. başlık (case-insensitive substring)
 * 3. modül (case-insensitive substring)
 * 4. BM25/FTS5 içerik skoru (FTS5 bm25(): daha küçük/daha negatif = daha
 *    iyi; yalnızca içerik katkısı — alan önceliği 1–3 ayaklarıyla
 *    kodlandığından bm25() alan ağırlıksız kullanılır)
 * 5. graph yakınlığı (opsiyonel: pageId → mesafe haritası; küçük = yakın).
 *    Ayak verisi verilmezse ayak ATLANIR ve skippedRankLegs'e
 *    "graphProximity" yazılır (dürüst degrade — sprint-4 W4 partial).
 *
 * Tie-break leksiktir: (başlık, pageId) kod-birim karşılaştırma ile
 * (localeCompare KULLANILMAZ — locale bağımlılığı determinizmi bozar).
 * Sonuç: aynı girdi kümesi her zaman aynı toplam sırayı üretir.
 *
 * Saf çekirdek: MCP türü import etmez; depo erişimi search-store.ts'tedir.
 */

/** Depodan gelen aday kayıt — search-store.ts doldurur; matchedFields
 * FTS5 sütun düzeyi eşleşme gerçeğidir (bkz. search-schema.ts). */
export interface WikiSearchCandidate {
  pageId: string;
  kind: WikiPageKind;
  title: string;
  route: string;
  freshness: Freshness;
  qualifiedSymbol: string | null;
  apiRoute: string | null;
  module: string | null;
  snippet: string;
  matchedFields: readonly WikiSearchMatchedField[];
  /** FTS5 bm25() değeri; daha küçük (negatif) = daha iyi eşleşme. */
  bm25Rank: number;
}

export interface WikiSearchRankingOptions {
  /** Normalize edilmiş sorgu (normalizeWikiSearchQuery çıktısı). */
  query: string;
  /** Graph yakınlık ayak verisi: pageId → mesafe (küçük = yakın). */
  proximity?: ReadonlyMap<string, number>;
}

export interface WikiSearchRanking {
  ordered: WikiSearchCandidate[];
  skippedRankLegs: WikiSearchSkippedRankLeg[];
}

/** Case-insensitive kıyas için sabit küçük harfe indirgeme. JS
 * toLowerCase() locale-parametresiz Unicode varsayılan kuralını izler:
 * aynı girdi her yerde aynı çıktıyı verir (determinizm invariant'ı). */
function foldCase(value: string): string {
  return value.toLowerCase();
}

interface RankLegs {
  exact: 0 | 1;
  title: 0 | 1;
  module: 0 | 1;
  bm25Rank: number;
  proximity: number | null;
}

const NO_RANK_LEGS: readonly WikiSearchSkippedRankLeg[] = [];
const PROXIMITY_SKIPPED: readonly WikiSearchSkippedRankLeg[] = [
  "graphProximity",
];

function computeLegs(
  candidate: WikiSearchCandidate,
  normalizedQuery: string,
  proximity: ReadonlyMap<string, number> | undefined,
): RankLegs {
  const foldedQuery = foldCase(normalizedQuery);
  const exact =
    (candidate.qualifiedSymbol !== null &&
      foldCase(candidate.qualifiedSymbol) === foldedQuery) ||
    (candidate.apiRoute !== null && foldCase(candidate.apiRoute) === foldedQuery);
  const title = foldCase(candidate.title).includes(foldedQuery);
  const module =
    candidate.module !== null &&
    foldCase(candidate.module).includes(foldedQuery);
  const proximityValue =
    proximity === undefined
      ? null
      : (proximity.get(candidate.pageId) ?? Number.POSITIVE_INFINITY);
  return {
    exact: exact ? 1 : 0,
    title: title ? 1 : 0,
    module: module ? 1 : 0,
    bm25Rank: candidate.bm25Rank,
    proximity: proximityValue,
  };
}

/** Kod-birim leksik kıyas (deterministik; locale yok). */
function compareLexicographic(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareCandidates(
  a: RankLegs,
  aCandidate: WikiSearchCandidate,
  b: RankLegs,
  bCandidate: WikiSearchCandidate,
): number {
  if (a.exact !== b.exact) return b.exact - a.exact;
  if (a.title !== b.title) return b.title - a.title;
  if (a.module !== b.module) return b.module - a.module;
  if (a.bm25Rank !== b.bm25Rank) return a.bm25Rank - b.bm25Rank;
  if (a.proximity !== null || b.proximity !== null) {
    const aProximity = a.proximity ?? Number.POSITIVE_INFINITY;
    const bProximity = b.proximity ?? Number.POSITIVE_INFINITY;
    if (aProximity !== bProximity) return aProximity - bProximity;
  }
  const byTitle = compareLexicographic(aCandidate.title, bCandidate.title);
  if (byTitle !== 0) return byTitle;
  return compareLexicographic(aCandidate.pageId, bCandidate.pageId);
}

/**
 * Adayları TŞ §16A.3 ayak önceliğiyle deterministik sıralar. Girdi dizisi
 * DEĞİŞTİRİLMEZ (kopya üzerinde sıralama). Yakınlık haritası yoksa
 * `skippedRankLegs: ["graphProximity"]` döner; harita var ama bir adayın
 * pageId'si haritada yoksa o aday bu ayakta en kötü (sonsuz mesafe)
 * sayılır.
 */
export function rankWikiSearchCandidates(
  candidates: readonly WikiSearchCandidate[],
  options: WikiSearchRankingOptions,
): WikiSearchRanking {
  const proximity = options.proximity;
  const legs = candidates.map((candidate) => ({
    candidate,
    legs: computeLegs(candidate, options.query, proximity),
  }));
  legs.sort((a, b) =>
    compareCandidates(a.legs, a.candidate, b.legs, b.candidate),
  );
  return {
    ordered: legs.map((entry) => entry.candidate),
    skippedRankLegs: proximity === undefined ? [...PROXIMITY_SKIPPED] : [...NO_RANK_LEGS],
  };
}
