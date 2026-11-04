/**
 * Indexing hata semantiği (TŞ v2.1 §9, §10.1 eşlemesi mcp-server'da).
 * Kodlar `indexing/` ad alanındadır; MCP katmanı bu kodları sabit tool
 * hata kodlarına çevirir:
 *   indexing/root-not-authorized → WORKSPACE_NOT_AUTHORIZED
 *   indexing/path-denied         → PATH_DENIED
 *   indexing/limit-exceeded      → LIMIT_EXCEEDED
 *   indexing/unsupported-mode    → INVALID_ARGUMENT
 *   indexing/internal            → INTERNAL_ERROR
 *
 * `indexing/unsupported-mode` (sprint-2 B6): JobManager yalnızca "full"
 * iş türünü yürütür; "incremental" Live Architecture dilimidir (sprint-2
 * B7). Açık reddetme, sessizce full koşturma yerine tercih edilir
 * (ADR-010: çalışmayan şey Done yazılmaz). MCP yüzeyinde sabit uzantı
 * kodu INVALID_ARGUMENT'a eşlenir (K-008 gerekçesiyle mevcut tabloda).
 */
export type IndexingErrorCode =
  | "indexing/root-not-authorized"
  | "indexing/path-denied"
  | "indexing/limit-exceeded"
  | "indexing/unsupported-mode"
  | "indexing/internal";

export class IndexingError extends Error {
  readonly code: IndexingErrorCode;

  constructor(code: IndexingErrorCode, message: string) {
    super(message);
    this.name = "IndexingError";
    this.code = code;
  }
}
