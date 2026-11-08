/**
 * Verification çekirdek hatası — sprint-6 E1 (TŞ v2.1 §10.4 verify_change).
 *
 * MCP hata kodlarına eşleme `packages/mcp-server` katmanındadır (E-diliminin
 * MCP yüzey dilimi); bu paket yalnızca `verification/...` ön ekli kodlar
 * üretir — packages/preflight/src/errors.ts'in `preflight/...` ve
 * packages/graph/src/errors.ts'in `graph/...` bağımlılık sınırıyla aynı
 * örüntü: paket MCP türü import etmez. Kod kümesi DERLEYİCİ düzeyinde
 * sabittir (union tipi; contracts/src/errors.ts disiplini):
 *
 * - `verification/invalid-input`        : boş/blank girdi, bilinmeyen check
 *   adı, preflightId + changedSymbols/changedFiles çelişkisi,
 *   authorizeFile'sız dosya hedefi (fail-closed), resolvePreflight'ın
 *   kimliği uyuşmayan manifest döndürmesi, kanıtsız observed test koşumu
 *   (iddia ile başarılı sayılmaz — TŞ §10.4).
 * - `verification/preflight-not-found`  : preflightId verildi ama çözümleyici
 *   yok veya çözümleyici manifest döndürmedi (sabit hata kodu; bilinmeyen
 *   kimlik için deterministik davranış).
 * - `verification/file-not-authorized`  : kapsam dosyası, enjekte edilen
 *   authorizeFile kararıyla reddedildi (WorkspaceAccessPolicy.checkFile
 *   kararının reddi sessizce düşürülmez; salt-okunur workspace disiplini).
 * - `verification/snapshot-state`       : verify yalnızca ready/partial
 *   snapshot'lar üzerinde çalışır (impact/preflight örüntüsü).
 */
export type VerificationErrorCode =
  | "verification/invalid-input"
  | "verification/preflight-not-found"
  | "verification/file-not-authorized"
  | "verification/snapshot-state";

export class VerificationError extends Error {
  constructor(
    readonly code: VerificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VerificationError";
  }
}
