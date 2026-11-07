/**
 * Preflight çekirdek hatası — sprint-5 D6 (TŞ v2.1 §15 Test Intelligence,
 * §10.3 preflight).
 *
 * MCP hata kodlarına eşleme `packages/mcp-server` katmanındadır; bu paket
 * yalnızca `preflight/...` ön ekli kodlar üretir (impact.ts'in
 * `graph/...` örüntüsüyle aynı bağımlılık sınırı: paket MCP türü import
 * etmez). Kod kümesi sabittir:
 * - `preflight/invalid-input`   : boş/blank hedef kümesi, pozitif olmayan
 *   limit girdisi (MCP yüzeyinde INVALID_ARGUMENT'a eşlenir — K-008).
 * - `preflight/snapshot-state`  : test planı yalnızca ready/partial
 *   snapshot üzerinde çalışır (impact.ts:269-275 ile aynı kural).
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
