/**
 * Wiki projeksiyon hatası — TŞ v2.1 §16A, ADR-011 (Living Wiki as Graph
 * Projection).
 *
 * MCP hata kodlarına eşleme `packages/mcp-server` katmanındadır (W5; denetim
 * kaydı: export modülünün `wiki/output-not-authorized`/`wiki/output-path-denied`
 * kodlarının EXPORT_NOT_ALLOWED/PATH_DENIED'e eşlenmesi henüz eklenmedi —
 * view=wiki kablolandığında services-wiki.ts'te eklenmelidir); bu paket
 * yalnızca `wiki/...` ön ekli kodlar üretir (bağımlılık sınırı güncel:
 * packages/wiki @causoryn/domain + zod'a bağlıdır; export modülü W8 ile
 * OutputAccessPolicy için @causoryn/workspace'a da bağlıdır — MCP türü
 * import etmez).
 */
export class WikiProjectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WikiProjectionError";
  }
}

/**
 * Wiki arama hatası — TŞ v2.1 §16A.3 (FTS5 arama), sprint-4 W4.
 *
 * Kod kümesi (sabit; W5 services katmanı MCP INVALID_ARGUMENT vb.'e
 * eşler — K-008/K-011 uzantı kodu seti genişletilmez):
 * - `wiki/empty-query`    : normalizasyon sonrası sorgu boş (açık reddi,
 *   TŞ §16A.3 "query normalizasyonu ... zorunludur")
 * - `wiki/invalid-limit`  : limit 1..MAX_WIKI_SEARCH_LIMIT dışı (K-013 #5:
 *   default 50, max 200)
 * - `wiki/invalid-cursor` : opak cursor çözülemedi (K-013 #5 codec)
 * - `wiki/invalid-field`  : workspaceId/proximity gibi girdi alanı geçersiz
 * - `wiki/snapshot-not-found` : workspace kapsamında publish edilmiş
 *   (ready/partial) WikiSnapshot çözülemedi
 * - `wiki/storage-corrupt`: depodan beklenen satır şekli bozuk (şema sapması)
 */
export class WikiSearchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WikiSearchError";
  }
}

/**
 * Wiki annotation overlay hatası — TŞ v2.1 §16A.6 (insan notlarının
 * korunması ve AI metni ayrımı), sprint-4 W7; docs/wiki-spec.md §3.5.
 *
 * Kod kümesi (sabit):
 * - `wiki/annotation-invalid`     : anotasyon girdisi şema/invariant reddi.
 *   author türleri K-013/wiki-spec §3.5: human | host_model_proposal;
 *   origin kümesi human_note | external_link | host_model_proposal;
 *   origin=host_model_proposal için verified=false kuralı (TŞ §16A.6)
 *   ve authorKind↔origin çapraz eşleşme kuralı burada zorlanır.
 * - `wiki/duplicate-annotation`   : aynı id ile ikinci create (PK; depo
 *   koduyla aynı ad — SqliteWikiStore.writeAnnotation).
 * - `wiki/annotation-not-found`   : explicit id ile çözülemeyen anotasyon.
 *   Silme/güncelleme yalnızca açık id ile yapılır; toplu/örtük silme
 *   API'si YOKTUR (reindex asla silmez — §16A.6). Cross-workspace erişim
 *   de not-found döner (satırın varlığı sızdırılmaz).
 * - `wiki/annotation-conflict`    : optimistic concurrency — beklenen
 *   annotationVersion güncel satırla uyuşmaz (TŞ §16A.6).
 *   MCP sabit karşılığı: WIKI_NOTE_CONFLICT — TŞ §10.1 sabit kod listesi
 *   (s.9) bu dilimde pdftotext ile doğrulandı ve listede bire bir kod
 *   VARDIR; docs/wiki-spec.md §4.1 de aynı kodu "annotationVersion
 *   optimistic concurrency çakışması" için işaret eder. K-008 örüntüsü
 *   gereği YENİ uzantı kodu (ör. ANNOTATION_CONFLICT) AÇILMADI: uzantı
 *   kodu önkoşulu "TŞ sabit listesinde uygun kod yok"tur ve burada
 *   bire bir kod vardır (packages/mcp-server/src/errors.ts'teki
 *   EXPORT_NOT_ALLOWED/WIKI_PAGE_NOT_FOUND örnekteleriyle aynı disiplin).
 *   Kodun MCP tablosuna (retryable/userAction ile) bağlanması, anotasyon
 *   yazma yüzeyi bir MCP aracı olarak açıldığında yapılır — v1.0'da 7
 *   wiki okuma aracı not YAZMAZ ve WIKI_NOTE_CONFLICT bu araçlarda
 *   dönmez (wiki-spec §4.1 kapsam notu); yazma akışı ayrı yerel UI/CLI'dır.
 *   Planlanan rehber kaydı: retryable=false (kör yeniden deneme aynı
 *   çakışmayı tekrarlar), userAction="anotasyonu yeniden okuyup güncel
 *   annotationVersion ile yeniden deneyin".
 * - `wiki/annotation-invalid-row` : depodan okunan satır overlay şemasına
 *   uymuyor (ör. şema dışı authorKind). Sessiz geçiş yoktur — §16A.10:
 *   doğrulanmış taklit üretilmez.
 */
export class AnnotationOverlayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AnnotationOverlayError";
  }
}
