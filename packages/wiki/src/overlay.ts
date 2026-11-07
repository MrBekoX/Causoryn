import { z } from "zod";

import { AnnotationOverlayError } from "./errors.js";

/**
 * Annotation overlay — TŞ v2.1 §16A.6 "İnsan notlarının korunması ve AI
 * metni ayrımı", §16A.7 WikiAnnotation eması; docs/wiki-spec.md §3.5;
 * wiki/sprint-4.md W7; ADR-012 (Generated/Overlay Separation).
 *
 * Sözleşme:
 * - AYRI KATMAN: anotasyonlar wiki_* generated tablolarından TAMAMEN
 *   ayrı bir tabloda (depo tarafında wiki_annotations — FK'sız) yaşar.
 *   Reindex yalnızca üretilmiş (generated) içeriği yeniler; bu modülün
 *   okuma dışında anotasyon satırına yazan TEK bir çağrısı yoktur ve
 *   bu yapısal garantidir (testlerle kanıtlanır: iki reindex sonrası
 *   satırlar bit-bit aynı — TŞ §16A.10 "Kullanıcı notu" kabul satırı).
 * - OPTIMISTIC CONCURRENCY: her anotasyonun annotationVersion'ı vardır;
 *   güncelleme beklenen sürümle CAS olarak yapılır (depo tarafında
 *   guarded UPDATE — tek atomik ifade). Uyuşmazlıkta sabit kod
 *   `wiki/annotation-conflict` (MCP sabit karşılığı WIKI_NOTE_CONFLICT;
 *   gerekçe bkz. errors.ts — yeni uzantı kodu açılmaz, K-008 örüntüsü).
 * - ORPHAN (türetilmiş durum): hedef sayfa güncel projeksiyonda yoksa
 *   anotasyon `orphan=true` İŞARETLENİR ama satırı SİLİNMEZ ve
 *   DEĞİŞMEZ (TŞ §16A.6: notlar silinmez; §16A.10: veri kaybı olmaz).
 *   pageId canonical graph identity + sayfa türünden deterministik
 *   türetildiği için hedef aynı kimlikle geri geldiğinde işaret
 *   otomatik olarak düşer (orphan recovery) — yeniden bağlama için
 *   YAZMA GEREKMEZ. Orphan durumu bilinçli olarak depolanmaz: W7
 *   kapsamında şema değişikliği yasaktır ve durum zaten tamamen
 *   (stablePageId, güncel projeksiyon) fonksiyonudur; saklamak yalnızca
 *   bayatlık (drift) riski yaratırdı.
 * - AI METNİ AYRIMI: authorKind human | host_model_proposal (K-013/
 *   wiki-spec §3.5). Host modeli önerisi yalnızca kullanıcı kabul ederse
 *   overlay'e girer; origin=host_model_proposal ve verified=false KALIR
 *   (TŞ §16A.6) — bu modül bir model çağırmaz (kırmızı çizgi #1), yalnızca
 *   kabul edilmiş öneriyi İNSAN notundan AYRI etiketle render eder.
 * - RENDER: overlay blokları generated içeriğin DIŞINA eklenir
 *   (wiki-spec §3.5: generatedMarkdown dışında render edilir);
 *   renderWikiPageWithOverlay ile sayfa kompozisyonu yapılır.
 * - DETERMİNİZM: aynı girdi → aynı çıktı. Motor saat okumaz (updatedAt
 *   çağıranın verir); küme/liste çıktıları (stablePageId, sectionKey, id)
 *   leksik sıralı; dönen tüm değerler deep-frozen.
 * - KİMLİK: annotation id çağıran katmanın (yerel UI/CLI) sorumluluğudur;
 *   tekilliği depo PK'ı zorlar (duplicate → wiki/duplicate-annotation).
 * - KATMAN SINIRI: bu paket depo tipini import etmez; depo sözleşmesi
 *   yapısal (structural) WikiAnnotationOverlayStore portu ile tanımlanır
 *   (SqliteWikiStore W7 ince bağlantısıyla bu portu bire bir sağlar).
 */

/* ---------------------------------------------------------------------------
 * Şema — wiki-spec §3.5 değer kümeleri
 * ------------------------------------------------------------------------- */

/** K-013/wiki-spec §3.5: author türleri. */
export const AnnotationAuthorKindSchema = z.enum([
  "human",
  "host_model_proposal",
]);
export type AnnotationAuthorKind = z.infer<typeof AnnotationAuthorKindSchema>;

/** wiki-spec §3.5 taslak kümesi: not içeriğinin kaynağı. */
export const AnnotationOriginSchema = z.enum([
  "human_note",
  "external_link",
  "host_model_proposal",
]);
export type AnnotationOrigin = z.infer<typeof AnnotationOriginSchema>;

/**
 * WikiAnnotation çalışma zamanı şeması. TŞ §16A.7 emasının üzerinde
 * wiki-spec §3.5 invariant'ları: origin=host_model_proposal için
 * verified=false KALIR ve host origin yalnızca host authorKind ile
 * bileşebilir (çift yönlü çapraz eşleşme).
 */
export const WikiAnnotationSchema = z
  .strictObject({
    id: z.string().min(1),
    stablePageId: z.string().min(1),
    sectionKey: z.string().min(1),
    authorKind: AnnotationAuthorKindSchema,
    origin: AnnotationOriginSchema.optional(),
    verified: z.boolean().optional(),
    body: z.string(),
    annotationVersion: z.number().int().nonnegative(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((annotation, ctx) => {
    for (const field of ["id", "stablePageId", "sectionKey"] as const) {
      if (annotation[field].trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          message: `${field} boş olamaz`,
          path: [field],
        });
      }
    }
    if (annotation.body.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "body boş olamaz",
        path: ["body"],
      });
    }
    // TŞ §16A.6: host_model_proposal için verified=false KALIR.
    if (
      annotation.origin === "host_model_proposal" &&
      annotation.verified === true
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "origin=host_model_proposal iken verified=true olamaz (TŞ §16A.6: verified=false kalır)",
        path: ["verified"],
      });
    }
    // Çapraz eşleşme: host origin ⟺ host authorKind.
    const hostOrigin = annotation.origin === "host_model_proposal";
    const hostAuthor = annotation.authorKind === "host_model_proposal";
    if (hostOrigin !== hostAuthor) {
      ctx.addIssue({
        code: "custom",
        message:
          "origin=host_model_proposal yalnızca authorKind=host_model_proposal ile bileşebilir (ve tersi)",
        path: ["authorKind"],
      });
    }
  });

/** Overlay anotasyonu — wiki-spec §3.5 WikiAnnotation okuma modeli. */
export interface WikiAnnotation {
  readonly id: string;
  readonly stablePageId: string;
  readonly sectionKey: string;
  readonly authorKind: AnnotationAuthorKind;
  readonly origin?: AnnotationOrigin;
  readonly verified?: boolean;
  readonly body: string;
  readonly annotationVersion: number;
  readonly updatedAt: string;
}

/** Orphan işaretli görünüm — `orphan` TÜRETİLMİŞ durumdur, depolanmaz. */
export interface WikiAnnotationView extends WikiAnnotation {
  readonly orphan: boolean;
}

/* ---------------------------------------------------------------------------
 * Depo portu — yapısal sözleşme (SqliteWikiStore bire bir sağlar)
 * ------------------------------------------------------------------------- */

/** Depo okuma satırı — SqliteWikiStore.WikiAnnotation ile aynı şekil. */
export interface WikiAnnotationRow {
  readonly id: string;
  readonly stablePageId: string;
  readonly sectionKey: string;
  readonly authorKind: string;
  readonly origin?: string;
  readonly verified?: boolean;
  readonly body: string;
  readonly annotationVersion: number;
  readonly updatedAt: string;
}

/** Depo yazma girdisi — SqliteWikiStore.WikiAnnotationInput ile aynı şekil. */
export interface WikiAnnotationWrite {
  readonly id: string;
  readonly stablePageId: string;
  readonly sectionKey: string;
  readonly authorKind: string;
  readonly origin?: string;
  readonly verified?: boolean;
  readonly body: string;
  readonly annotationVersion: number;
  readonly updatedAt: string;
}

/**
 * Depo CAS girdisi — `undefined` = alan değişmez; `origin`/`verified`
 * için `null` = temizle. Kimlik alanları (stablePageId/authorKind)
 * bilinçli olarak YOKTUR: değiştirilemezler.
 */
export interface WikiAnnotationUpdate {
  readonly id: string;
  readonly expectedAnnotationVersion: number;
  readonly body?: string;
  readonly sectionKey?: string;
  readonly origin?: string | null;
  readonly verified?: boolean | null;
}

/**
 * Anotasyon deposu portu. packages/wiki depo paketini import etmez;
 * SqliteWikiStore (storage-sqlite) bu portu yapısal olarak sağlar.
 * Hata sözleşmesi: atılan hatanın `code` alanı şu kümedendir —
 * wiki/duplicate-annotation, wiki/annotation-not-found,
 * wiki/annotation-conflict, wiki/invalid-field.
 */
export interface WikiAnnotationOverlayStore {
  getAnnotation(workspaceId: string, id: string): WikiAnnotationRow | undefined;
  listAnnotations(workspaceId: string): readonly WikiAnnotationRow[];
  writeAnnotation(workspaceId: string, annotation: WikiAnnotationWrite): void;
  updateAnnotation(
    workspaceId: string,
    input: WikiAnnotationUpdate,
    updatedAt: string,
  ): WikiAnnotationRow;
  deleteAnnotation(workspaceId: string, id: string): void;
}

/* ---------------------------------------------------------------------------
 * İç yardımcılar
 * ------------------------------------------------------------------------- */

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function schemaDetail(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

/**
 * Şema doğrulaması + deep-freeze. `notFoundCode`: girdi reddi için kod —
 * motor girdisi wiki/annotation-invalid, depo satırı
 * wiki/annotation-invalid-row (sessiz geçiş yok, §16A.10).
 */
function parseWikiAnnotation(value: unknown, invalidCode: string): WikiAnnotation {
  const parsed = WikiAnnotationSchema.safeParse(value);
  if (!parsed.success) {
    throw new AnnotationOverlayError(
      invalidCode,
      `WikiAnnotation şema doğrulaması başarısız: ${schemaDetail(parsed.error)}`,
    );
  }
  return deepFreeze(parsed.data as WikiAnnotation);
}

/** Depo hatasının `code` alanı (yapısal okuma — depo tipi import edilmez). */
function storeErrorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Depo kodu → overlay sabit kodu; bilinmeyen kod oldugu gibi fırlatılır. */
function mapStoreError(error: unknown): unknown {
  const code = storeErrorCode(error);
  if (code === "wiki/duplicate-annotation") {
    return new AnnotationOverlayError(
      "wiki/duplicate-annotation",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (code === "wiki/annotation-not-found") {
    return new AnnotationOverlayError(
      "wiki/annotation-not-found",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (code === "wiki/annotation-conflict") {
    return new AnnotationOverlayError(
      "wiki/annotation-conflict",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (code === "wiki/invalid-field") {
    return new AnnotationOverlayError(
      "wiki/annotation-invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
  return error;
}

/** Deterministik sıralama: (stablePageId, sectionKey, id) leksik. */
function compareAnnotation(a: WikiAnnotation, b: WikiAnnotation): number {
  if (a.stablePageId !== b.stablePageId) {
    return a.stablePageId < b.stablePageId ? -1 : 1;
  }
  if (a.sectionKey !== b.sectionKey) {
    return a.sectionKey < b.sectionKey ? -1 : 1;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}

/* ---------------------------------------------------------------------------
 * Saf çekirdek — orphan işaretleme ve render
 * ------------------------------------------------------------------------- */

/**
 * Orphan işaretleme (TÜRETİLMİŞ): hedef sayfa güncel sayfa kimliği
 * kümesinde yoksa `orphan=true`. Satırlar dokunulmaz; çıktı deep-frozen
 * ve (stablePageId, sectionKey, id) leksik sıralıdır. Hedef aynı
 * deterministic pageId ile geri geldiğinde aynı fonksiyon `orphan=false`
 * döndürür — otomatik yeniden bağlanma (orphan recovery) için yazma
 * gerekmez.
 */
export function markAnnotationOrphans(
  currentPageIds: readonly string[],
  annotations: readonly WikiAnnotation[],
): readonly WikiAnnotationView[] {
  const pageIds = new Set(currentPageIds);
  return deepFreeze(
    annotations
      .map((annotation) => ({
        ...annotation,
        orphan: !pageIds.has(annotation.stablePageId),
      }))
      .sort(compareAnnotation),
  );
}

/**
 * Tek anotasyonun overlay bloğu — generated içeriğin DIŞINA eklenen
 * markdown. AI metni ayrımı (TŞ §16A.6): host_model_proposal bloğu
 * "AI ÖNERİSİ" etiketi ve verified=false değeriyle İNSAN notundan
 * açıkça ayrışır. Deterministiktir: aynı girdi → aynı dize.
 */
export function renderAnnotationBlock(annotation: WikiAnnotation): string {
  const isHost = annotation.authorKind === "host_model_proposal";
  const label = isHost
    ? `AI ÖNERİSİ — host_model_proposal, verified=${
        annotation.verified === true ? "true" : "false"
      }`
    : "Overlay notu — human";
  const parts = [
    `sectionKey:\`${annotation.sectionKey}\``,
    `annotationId:\`${annotation.id}\``,
    `annotationVersion=${String(annotation.annotationVersion)}`,
  ];
  if (annotation.origin !== undefined) {
    parts.push(`origin=${annotation.origin}`);
  }
  if (!isHost && annotation.verified !== undefined) {
    parts.push(`verified=${annotation.verified ? "true" : "false"}`);
  }
  const header = `> **[${label}]** ${parts.join(" · ")}`;
  const bodyLines = annotation.body.split("\n").map((line) => `> ${line}`);
  return [header, ">", ...bodyLines].join("\n");
}

/**
 * Sayfa kompozisyonu: overlay blokları generated içeriğin DIŞINA
 * eklenir (wiki-spec §3.5). Overlay boşsa generated içerik BIT-BIT
 * aynen döner (dokunma yok).
 */
export function renderWikiPageWithOverlay(
  generatedMarkdown: string,
  overlayMarkdown: string,
): string {
  if (overlayMarkdown.length === 0) return generatedMarkdown;
  if (generatedMarkdown.length === 0) return overlayMarkdown;
  return `${generatedMarkdown}\n\n${overlayMarkdown}`;
}

/** Sayfa başına overlay görünümü — yalnızca ≥1 bağlı anotasyon olan sayfalar. */
export interface WikiPageAnnotationOverlay {
  readonly pageId: string;
  readonly attached: readonly WikiAnnotationView[];
  readonly renderedMarkdown: string;
}

/** Tam overlay raporu — sayfa sırası girdi projeksiyon sırasıdır. */
export interface WikiAnnotationOverlayReport {
  /** Tüm anotasyonlar, orphan işaretli, deterministik sıralı. */
  readonly annotations: readonly WikiAnnotationView[];
  readonly pages: readonly WikiPageAnnotationOverlay[];
  readonly orphaned: readonly WikiAnnotationView[];
}

/**
 * Sayfa dizisi + anotasyon kümesinden overlay raporu. Girdi sayfaları
 * yapısal olarak yalnızca `{ id }` ister — WikiProjection.pages dizisi
 * veya depo okumasının (SqliteWikiStore.readWikiSnapshot) pages dizisi
 * doğrudan geçer. Sayfa sırası girdi sırasıdır (rapor sırası bu yüzden
 * deterministiktir).
 */
export function buildAnnotationOverlay(
  pages: readonly { readonly id: string }[],
  annotations: readonly WikiAnnotation[],
): WikiAnnotationOverlayReport {
  const views = markAnnotationOrphans(
    pages.map((page) => page.id),
    annotations,
  );
  const attachedByPage = new Map<string, WikiAnnotationView[]>();
  const orphaned: WikiAnnotationView[] = [];
  for (const view of views) {
    if (view.orphan) {
      orphaned.push(view);
      continue;
    }
    const list = attachedByPage.get(view.stablePageId) ?? [];
    list.push(view);
    attachedByPage.set(view.stablePageId, list);
  }
  const pageOverlays: WikiPageAnnotationOverlay[] = [];
  for (const page of pages) {
    const attached = attachedByPage.get(page.id);
    if (attached === undefined) continue;
    pageOverlays.push(
      deepFreeze({
        pageId: page.id,
        attached,
        renderedMarkdown: attached.map(renderAnnotationBlock).join("\n\n"),
      }),
    );
  }
  return deepFreeze({
    annotations: views,
    pages: pageOverlays,
    orphaned,
  });
}

/* ---------------------------------------------------------------------------
 * Motor — depo bağlantılı overlay işlemleri
 * ------------------------------------------------------------------------- */

/** Anotasyon ekleme taslağı (sürüm 0'dan başlar; id çağıranın sorumluluğu). */
export interface WikiAnnotationDraft {
  readonly id: string;
  readonly stablePageId: string;
  readonly sectionKey: string;
  readonly authorKind: AnnotationAuthorKind;
  readonly origin?: AnnotationOrigin;
  readonly verified?: boolean;
  readonly body: string;
}

/** Güncelleme girdisi — beklenti alanı ZORUNLUDUR (optimistic concurrency). */
export interface WikiAnnotationUpdateInput {
  readonly id: string;
  readonly expectedAnnotationVersion: number;
  readonly body?: string;
  readonly sectionKey?: string;
  readonly origin?: AnnotationOrigin | null;
  readonly verified?: boolean | null;
}

/**
 * AnnotationOverlayEngine — overlay CRUD + orphan/overlay okuma.
 *
 * REINDEX SÖZLEŞMESİ: bu sınıfın reindex akışında ÇAĞRILMASI GEREKEN
 * hiçbir yazma yöntemi vardır; reindex yalnızca
 * `listAnnotations`/`listWithOverlayStatus` OKUMASI yapar. Generated
 * katmanın yenilenmesi (projectWiki/projectWikiIncremental + depo
 * publish'i) anotasyon satırlarına yapısal olarak dokunmaz.
 */
export class AnnotationOverlayEngine {
  private readonly store: WikiAnnotationOverlayStore;

  constructor(store: WikiAnnotationOverlayStore) {
    this.store = store;
  }

  /**
   * Yeni anotasyon (annotationVersion=0). Girdi şemadan geçmeden depoya
   * YAZILMAZ; duplicate id wiki/duplicate-annotation ile reddedilir.
   */
  addAnnotation(
    workspaceId: string,
    draft: WikiAnnotationDraft,
    updatedAt: string,
  ): WikiAnnotation {
    const candidate = parseWikiAnnotation(
      { ...draft, annotationVersion: 0, updatedAt },
      "wiki/annotation-invalid",
    );
    try {
      this.store.writeAnnotation(workspaceId, {
        id: candidate.id,
        stablePageId: candidate.stablePageId,
        sectionKey: candidate.sectionKey,
        authorKind: candidate.authorKind,
        ...(candidate.origin === undefined ? {} : { origin: candidate.origin }),
        ...(candidate.verified === undefined
          ? {}
          : { verified: candidate.verified }),
        body: candidate.body,
        annotationVersion: candidate.annotationVersion,
        updatedAt: candidate.updatedAt,
      });
    } catch (error) {
      throw mapStoreError(error);
    }
    return candidate;
  }

  /**
   * Optimistic concurrency güncellemesi (TŞ §16A.6). Akış: güncel satır
   * okunur (yoksa wiki/annotation-not-found) → patch merge edilir → merge
   * SONRASI invariant'lar şemadan geçirilir (wiki/annotation-invalid) →
   * depo CAS'ı sürümü ATOMİK doğrular (uyuşmazlıkta wiki/annotation-conflict)
   * → taze satır şemadan geçirilip döner. Sürüm her başarılı yazmada +1.
   */
  updateAnnotation(
    workspaceId: string,
    input: WikiAnnotationUpdateInput,
    updatedAt: string,
  ): WikiAnnotation {
    const currentRaw = this.store.getAnnotation(workspaceId, input.id);
    if (currentRaw === undefined) {
      throw new AnnotationOverlayError(
        "wiki/annotation-not-found",
        `Anotasyon bulunamadı: ${input.id}`,
      );
    }
    const current = parseWikiAnnotation(currentRaw, "wiki/annotation-invalid-row");
    // Merge: `undefined` = alan korunur; `null` (origin/verified) = temizle.
    const merged = {
      id: current.id,
      stablePageId: current.stablePageId,
      sectionKey: input.sectionKey ?? current.sectionKey,
      authorKind: current.authorKind,
      ...(input.origin === undefined
        ? current.origin === undefined
          ? {}
          : { origin: current.origin }
        : input.origin === null
          ? {}
          : { origin: input.origin }),
      ...(input.verified === undefined
        ? current.verified === undefined
          ? {}
          : { verified: current.verified }
        : input.verified === null
          ? {}
          : { verified: input.verified }),
      body: input.body ?? current.body,
      annotationVersion: current.annotationVersion,
      updatedAt,
    };
    parseWikiAnnotation(merged, "wiki/annotation-invalid");
    try {
      const row = this.store.updateAnnotation(workspaceId, input, updatedAt);
      return parseWikiAnnotation(row, "wiki/annotation-invalid-row");
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  /**
   * Explicit id ile silme. Toplu/örtük silme API'si YOKTUR: başka
   * workspace scope'undan silme denemesi not-found döner ve notu
   * silemez (workspace izolasyonu). Reindex bu yöntemi ASLA çağırmaz.
   */
  deleteAnnotation(workspaceId: string, id: string): void {
    try {
      this.store.deleteAnnotation(workspaceId, id);
    } catch (error) {
      throw mapStoreError(error);
    }
  }

  /** Tek anotasyon (şema doğrulanmış, frozen); yoksa undefined. */
  getAnnotation(workspaceId: string, id: string): WikiAnnotation | undefined {
    const row = this.store.getAnnotation(workspaceId, id);
    return row === undefined
      ? undefined
      : parseWikiAnnotation(row, "wiki/annotation-invalid-row");
  }

  /** Workspace'in tüm anotasyonları (depo position sırası; şema doğrulanmış). */
  listAnnotations(workspaceId: string): readonly WikiAnnotation[] {
    return this.store
      .listAnnotations(workspaceId)
      .map((row) => parseWikiAnnotation(row, "wiki/annotation-invalid-row"));
  }

  /**
   * Orphan işaretli okuma — reindex sonrası overlay durumunun tek okuma
   * yolu. `currentPageIds` güncel projeksiyonun sayfa kimlikleridir.
   * YAZMA YAPMAZ: orphan işareti türetilmiştir (bkz. markAnnotationOrphans).
   */
  listWithOverlayStatus(
    workspaceId: string,
    currentPageIds: readonly string[],
  ): readonly WikiAnnotationView[] {
    return markAnnotationOrphans(currentPageIds, this.listAnnotations(workspaceId));
  }
}
