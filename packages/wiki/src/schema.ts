import { z } from "zod";

/**
 * Wiki veri modeli Zod şemaları — docs/wiki-spec.md §3.0–§3.2 tasarım
 * taslaklarının K-013 kararlarıyla (wiki/decisions.md, 2026-11-05)
 * birebir kodlanmış çalışma zamanı doğrulaması. SQLite karşılıkları
 * (wiki_* tablo ailesi, TŞ §16A.7) sprint-4 W2'de kurulacaktır.
 *
 * K-013 ile sabitlenen değer kümeleri:
 * (1) WikiSnapshot.status = building|ready|partial|failed — TŞ §8
 *     GraphSnapshot.state ile birebir; ayrı "error" durum adı YOKTUR,
 *     hata bildirimi warnings + sabit hata kodlarıyla yapılır.
 * (3) freshness = fresh|stale; CoverageStatus = complete|partial|
 *     unsupported|no_data (§16A.1: no_data kategorisi ASLA doldurulmaz);
 *     section status = ok|partial|no_data.
 */

/** TŞ §8 Resolution — wiki-spec §3.0 ortak tipi. */
export const WikiResolutionSchema = z.enum(["verified", "heuristic", "unresolved"]);

/**
 * Kanıt referansı — wiki-spec §3.0 EvidenceRef. Graph tarafındaki Evidence
 * kaydına (TŞ §8) işaret eder; kanıtın kendisi graph'ta yaşar, wiki yalnızca
 * referans taşır. Span'sız Evidence için kanıt referansi üretilmez
 * (konumsuz kanıt uydurulmaz; ilgili bölüm `partial` + uyarı alır).
 */
export const EvidenceRefSchema = z.strictObject({
  evidenceId: z.string(),
  relativePath: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  sourceHash: z.string(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** K-013 (1): ayrı "error" değeri yoktur — bilinçli red testi vardır. */
export const WikiSnapshotStatusSchema = z.enum([
  "building",
  "ready",
  "partial",
  "failed",
]);
export type WikiSnapshotStatus = z.infer<typeof WikiSnapshotStatusSchema>;

/** K-013 (3): freshness kümesi. */
export const FreshnessSchema = z.enum(["fresh", "stale"]);
export type Freshness = z.infer<typeof FreshnessSchema>;

/** K-013 (3): CoverageStatus kümesi (TŞ §16A.1 + "complete" adı). */
export const CoverageStatusSchema = z.enum([
  "complete",
  "partial",
  "unsupported",
  "no_data",
]);
export type CoverageStatus = z.infer<typeof CoverageStatusSchema>;

/** K-013 (3): bölüm status kümesi. */
export const WikiPageSectionStatusSchema = z.enum(["ok", "partial", "no_data"]);
export type WikiPageSectionStatus = z.infer<typeof WikiPageSectionStatusSchema>;

/** Önerilen sayfa türleri — TŞ §16A.1 (s.16) bire bir liste. */
export const WikiPageKindSchema = z.enum([
  "overview",
  "architecture",
  "project",
  "module",
  "component",
  "symbol",
  "api",
  "business_flow",
  "event",
  "data",
  "contract",
  "policy",
  "test",
  "timeline",
  "onboarding",
  "coverage",
]);
export type WikiPageKind = z.infer<typeof WikiPageKindSchema>;

/** Sayfa kapsamı — wiki-spec §3.2 coverage gövdesi. */
export const WikiCoverageSchema = z.strictObject({
  status: CoverageStatusSchema,
  detail: z.string().optional(),
});
export type WikiCoverage = z.infer<typeof WikiCoverageSchema>;

/**
 * Wiki sayfası — TŞ §16A.7 WikiPage bire bir alan kümesi. `id` (pageId)
 * canonical graph identity + sayfa türünden türetilen sha256 karmasıdır
 * (§16A.1); `contentHash` bölüm içeriklerinin karmasıdır ve incremental
 * invalidation anahtarıdır (§16A.10, W6).
 */
export const WikiPageSchema = z.strictObject({
  id: z.string(),
  wikiSnapshotId: z.string(),
  kind: WikiPageKindSchema,
  parentId: z.string().nullable(),
  title: z.string(),
  slug: z.string(),
  route: z.string(),
  contentHash: z.string(),
  freshness: FreshnessSchema,
  coverage: WikiCoverageSchema,
});
export type WikiPage = z.infer<typeof WikiPageSchema>;

/**
 * Wiki sayfa bölümü — TŞ §16A.7 WikiPageSection. `generatedMarkdown`
 * yalnızca source-derived veri taşır; boş kategori `no_data` statüsünde ve
 * İÇERİKSİZ bırakılır (§16A.1: sanki analiz yapılmış gibi doldurulmaz).
 */
export const WikiPageSectionSchema = z.strictObject({
  id: z.string(),
  pageId: z.string(),
  sectionKey: z.string(),
  generatedMarkdown: z.string(),
  evidenceRefs: z.array(EvidenceRefSchema),
  status: WikiPageSectionStatusSchema,
});
export type WikiPageSection = z.infer<typeof WikiPageSectionSchema>;

/**
 * WikiSnapshot üst verisi — TŞ §16A.7 WikiSnapshot bire bir alan kümesi.
 * `id` kaynak graphSnapshotId + templateVersion'dan deterministik türetilir
 * (§16A.4 iki düzey sürüm: GraphSnapshot → WikiSnapshot). `builtAt` kimliğe
 * KATILMAZ (domain deseni: motor saat okumaz).
 */
export const WikiSnapshotSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  graphSnapshotId: z.string(),
  revisionRef: z.string(),
  status: WikiSnapshotStatusSchema,
  builtAt: z.iso.datetime(),
  templateVersion: z.string(),
});
export type WikiSnapshot = z.infer<typeof WikiSnapshotSchema>;

/**
 * Bütün wiki projeksiyonu: üst veri + kanonik düzende sayfalar + bölümler.
 * WikiLink kasıtlı olarak YOKTUR: çift yönlü link + backlink ters indeksi
 * sprint-4 W3 görevidir (TŞ §16A.2). Refine'lar: bölüm pageId'leri ve
 * alt sayfa parentId'leri bilinen sayfalara işaret etmelidir; kimlikler
 * küme içinde tekildir.
 */
export const WikiProjectionSchema = z
  .strictObject({
    snapshot: WikiSnapshotSchema,
    pages: z.array(WikiPageSchema),
    sections: z.array(WikiPageSectionSchema),
    warnings: z.array(z.string()),
  })
  .superRefine((projection, ctx) => {
    const pageIds = new Set<string>();
    for (const page of projection.pages) {
      if (pageIds.has(page.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Aynı kimlikte birden fazla sayfa: ${page.id}`,
          path: ["pages"],
        });
      }
      pageIds.add(page.id);
    }

    const sectionIds = new Set<string>();
    for (const section of projection.sections) {
      if (sectionIds.has(section.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Aynı kimlikte birden fazla bölüm: ${section.id}`,
          path: ["sections"],
        });
      }
      sectionIds.add(section.id);
      if (!pageIds.has(section.pageId)) {
        ctx.addIssue({
          code: "custom",
          message: `Bölüm bilinmeyen sayfaya işaret ediyor (dangling): ${section.pageId}`,
          path: ["sections"],
        });
      }
    }

    for (const page of projection.pages) {
      if (page.parentId !== null && !pageIds.has(page.parentId)) {
        ctx.addIssue({
          code: "custom",
          message: `Alt sayfa bilinmeyen ebeveyne işaret ediyor (dangling): ${page.parentId}`,
          path: ["pages"],
        });
      }
    }
  });
export type WikiProjection = z.infer<typeof WikiProjectionSchema>;
