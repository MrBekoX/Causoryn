/**
 * Preflight çekirdek hatası — sprint-5 D4 + D6 (TŞ v2.1 §10.2/§10.3
 * preflight, §15 Test Intelligence).
 *
 * MCP hata kodlarına eşleme `packages/mcp-server` katmanındadır; bu paket
 * yalnızca `preflight/...` ön ekli kodlar üretir (impact.ts'in
 * `graph/...` örüntüsüyle aynı bağımlılık sınırı: paket MCP türü import
 * etmez). Kod kümesi sabittir:
 * - `preflight/invalid-input`      : boş/blank intent/hedef kümesi,
 *   pozitif olmayan limit girdisi, authorizeFile'sız dosya hedefi,
 *   geçersiz sourceRevision/contractChecks kaydı (MCP yüzeyinde
 *   INVALID_ARGUMENT'a eşlenir — K-008).
 * - `preflight/snapshot-state`     : manifest/test planı yalnızca
 *   ready/partial snapshot üzerinde çalışır (impact.ts:269-275 ile aynı
 *   kural).
 * - `preflight/file-not-authorized`: hedef dosya, authorizeFile yetki
 *   kararıyla reddedildi (fail-closed; sprint-5 D4 — WorkspaceAccessPolicy
 *   kararının reddi sessizce düşürülmez, TŞ §10.3 "kodu kendisi
 *   değiştirmez" + salt-okunur workspace disiplini).
 */
export class PreflightError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PreflightError";
  }
}
