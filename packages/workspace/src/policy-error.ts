/**
 * Workspace policy hata kodları (TŞ v2.1 §10.1 hata semantiği + §19 tehdit
 * modeli).
 *
 * Kodlar `workspace/...` ad alanındadır: MCP hata kodlarına (TŞ §10.1:
 * WORKSPACE_NOT_AUTHORIZED, PATH_DENIED, POLICY_INVALID, LIMIT_EXCEEDED)
 * eşleme `packages/mcp-server` katmanında yapılır — domain'in
 * `domain/...` kodlarına uygulanan sınırın aynısı (bağımlılık yönü korunur).
 */
export type PolicyErrorCode =
  /** TŞ §10.1 POLICY_INVALID: konfigürasyon şemayı geçemedi. */
  | "workspace/policy-invalid"
  /** TŞ §10.1 WORKSPACE_NOT_AUTHORIZED: kök kullanıcı tarafından beyan edilmedi. */
  | "workspace/root-not-authorized"
  /** TŞ §10.1 PATH_DENIED: traversal, ignore kuralı, symlink escape veya uzantı reddi. */
  | "workspace/path-denied"
  /** TŞ §10.1 LIMIT_EXCEEDED: dosya boyutu limiti aşıldı (TŞ §19 kaynak tüketimi). */
  | "workspace/limit-exceeded";

/** Politika katmanı hatası; deterministik koşullarda fırlatılır. */
export class WorkspacePolicyError extends Error {
  constructor(
    readonly code: PolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspacePolicyError";
  }
}
