import { z } from "zod";

import { FreshnessSchema, WikiPageKindSchema } from "./schema.js";

/**
 * Wiki arama sonuç şemaları — TŞ v2.1 §16A.3, docs/wiki-spec.md §3.7,
 * sprint-4 W4.
 *
 * Relevance açıklaması TŞ §16A.3'ün emriyle `matchedFields` (hangi FTS5
 * alanları eşleşti) ve `evidenceIds` (sayfa bölümlerinin kanıt
 * referansları) olarak döner; gizli vektör/embedding skoru YOKTUR
 * (kırmızı çizgi #1: embedding servisi yoktur). bm25 değeri dahili
 * sıralama ayağıdır ve sonuç sözleşmesine yazılmaz.
 */

/** wiki_fts FTS5 sütunlarının TŞ §16A.7 WikiSearchIndex alan adları
 * (camelCase); matchedFields ÇIKTI SIRASI bu kanonik sıradır. */
export const WIKI_SEARCH_MATCHED_FIELDS = [
  "title",
  "qualifiedSymbol",
  "apiRoute",
  "module",
  "tags",
  "body",
] as const;

export const WikiSearchMatchedFieldSchema = z.enum(
  WIKI_SEARCH_MATCHED_FIELDS,
);
export type WikiSearchMatchedField = z.infer<typeof WikiSearchMatchedFieldSchema>;

/** Atlanabilen sıralama ayakları. TŞ §16A.3 sıralaması: exact
 * sembol/route > başlık > modül > BM25 > graph yakınlığı; yakınlık ayağı
 * için ayak verisi (pageId → mesafe haritası) verilmezse ayak ATLANIR ve
 * skippedRankLegs içinde dürüst degrade notu döner (sprint-4 W4 partial
 * davranışı). */
export const WikiSearchSkippedRankLegSchema = z.enum(["graphProximity"]);
export type WikiSearchSkippedRankLeg = z.infer<
  typeof WikiSearchSkippedRankLegSchema
>;

export const WikiSearchHitSchema = z.strictObject({
  pageId: z.string(),
  kind: WikiPageKindSchema,
  title: z.string(),
  /** Erişilebilir sayfa yolu (TŞ §16A.3: sonuçlarda sayfa yolu var). */
  route: z.string(),
  freshness: FreshnessSchema,
  qualifiedSymbol: z.string().nullable(),
  apiRoute: z.string().nullable(),
  module: z.string().nullable(),
  /** FTS5 snippet() çıktısı; sabit biçim argümanlarıyla deterministik. */
  snippet: z.string(),
  /** FTS5 sütun düzeyinde eşleşme gerçeği; kanonik sırada. */
  matchedFields: z.array(WikiSearchMatchedFieldSchema),
  /** Sayfa bölümlerinin kanıt kimlikleri: tekrarsız + leksik sıralı. */
  evidenceIds: z.array(z.string()),
});
export type WikiSearchHit = z.infer<typeof WikiSearchHitSchema>;

export const WikiSearchResultSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  workspaceId: z.string(),
  /** Normalize edilmiş sorgu (trim + iç boşluk tek boşluk). */
  query: z.string(),
  /** Kaçışlı FTS5 MATCH phrase ifadesi (şeffaflık + determinizm). */
  matchExpression: z.string(),
  totalMatches: z.number().int().nonnegative(),
  hits: z.array(WikiSearchHitSchema),
  /** K-013 #5: son sayfada null; ara sayfalarda opak cursor. */
  nextCursor: z.string().nullable(),
  skippedRankLegs: z.array(WikiSearchSkippedRankLegSchema),
});
export type WikiSearchResult = z.infer<typeof WikiSearchResultSchema>;
