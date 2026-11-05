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
