/**
 * Wiki projeksiyon hatası — TŞ v2.1 §16A, ADR-011 (Living Wiki as Graph
 * Projection).
 *
 * MCP hata kodlarına eşleme `packages/mcp-server` katmanındadır (W5); bu
 * paket yalnızca `wiki/...` ön ekli kodlar üretir (bağımlılık sınırı:
 * packages/wiki yalnızca @causoryn/domain'e bağlıdır, MCP türü import
 * etmez).
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
