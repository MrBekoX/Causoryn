/**
 * Domain katmanı hata tipi (TŞ v2.1 §8 invariant ihlalleri).
 *
 * Not: MCP hata kodlarına eşleme `packages/mcp-server` katmanında yapılır;
 * domain yalnızca `domain/...` kodlarını üretir (bağımlılık sınırı 1: domain
 * hiçbir MCP/adapter paketini import etmez).
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
