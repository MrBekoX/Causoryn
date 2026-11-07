/**
 * Sözleşme keşfi hata tipleri — TŞ v2.1 §11 (Architecture Contracts ve
 * Contract Drift, s.11–12) ve sprint-5 D1.
 *
 * Hata kodu tablosu (proje uzantısı örüntüsü: K-008/K-011/K-012 gibi açık
 * kod disiplini; tümü "contracts/" ad alanındadır):
 * - contracts/invalid-input:      çekirdeğe bozuk girdi (workspaceId/text)
 * - contracts/file-not-authorized: WorkspaceAccessPolicy kararı reddi —
 *   policy dışı dosya OKUNMAZ (kırmızı çizgi 2: salt-okunur workspace)
 * - contracts/limit-exceeded:      boyut kotası / node kotası (alias bombası
 *   şüphesi dahil; TŞ §19 kaynak tüketimi)
 * - contracts/depth-exceeded:      derinlik sınırı (metin taraması ve
 *   çözümlenmiş yapı üzerinden ikili savunma)
 * - contracts/spec-yaml-invalid:   YAML sözdizimi hatası
 * - contracts/spec-json-invalid:   JSON sözdizimi hatası
 * - contracts/spec-invalid:        şema ihlali (openapi/paths eksik, kök
 *   eşleme değil vb.)
 * - contracts/unsupported-spec:    bilinen ama desteklenmeyen sürüm
 *   (OpenAPI 2.x/Swagger, AsyncAPI ≥3 düz çizgi dışı)
 */

export type ContractErrorCode =
  | "contracts/invalid-input"
  | "contracts/file-not-authorized"
  | "contracts/limit-exceeded"
  | "contracts/depth-exceeded"
  | "contracts/spec-yaml-invalid"
  | "contracts/spec-json-invalid"
  | "contracts/spec-invalid"
  | "contracts/unsupported-spec";

export class ContractDiscoveryError extends Error {
  constructor(
    readonly code: ContractErrorCode,
    message: string,
    readonly issues?: readonly string[],
  ) {
    super(message);
    this.name = "ContractDiscoveryError";
  }
}
