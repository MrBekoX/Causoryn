/**
 * GraphRepository sözleşme hatası — TŞ v2.1 §8/§9, ADR-005.
 *
 * Hem bellek içi hem SQLite gerçekleme bu tipi fırlatır; arayüzü tüketen
 * katmanlar (indexing, mcp-server) tek hata tipiyle çalışır. MCP hata
 * kodlarına eşleme mcp-server katmanındadır; bu paket `graph/...`
 * (sözleşme), `storage/...` (SQLite gerçeklemesine özgü) ve `guard/...`
 * (Architecture Guard policy/baseline doğrulama — guard-policy-schema.ts,
 * sabit tablolu kod listesi) ön eklerini üretir.
 */
export class GraphRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GraphRepositoryError";
  }
}
