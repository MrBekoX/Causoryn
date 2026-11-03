/**
 * Indexing hata semantiği (TŞ v2.1 §9, §10.1 eşlemesi mcp-server'da).
 * Kodlar `indexing/` ad alanındadır; MCP katmanı bu kodları sabit tool
 * hata kodlarına çevirir:
 *   indexing/root-not-authorized → WORKSPACE_NOT_AUTHORIZED
 *   indexing/path-denied         → PATH_DENIED
 *   indexing/limit-exceeded      → LIMIT_EXCEEDED
 *   indexing/internal            → INTERNAL_ERROR
 */
export type IndexingErrorCode =
  | "indexing/root-not-authorized"
  | "indexing/path-denied"
  | "indexing/limit-exceeded"
  | "indexing/internal";

export class IndexingError extends Error {
  readonly code: IndexingErrorCode;

  constructor(code: IndexingErrorCode, message: string) {
    super(message);
    this.name = "IndexingError";
    this.code = code;
  }
}
