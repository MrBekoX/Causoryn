/**
 * Sabit tool hata kodları (TŞ v2.1 §10.1) — Faz A diliminin kullandığı
 * alt küme + TEK proje uzantısı. Kodlar envelope.error.code ile taşınır;
 * stack trace MCP sonucuna yazılmaz (TŞ §10.1).
 *
 * Uzantı notu (dürüstlük): TŞ §10.1 sabit kod listesinde INVALID_ARGUMENT
 * YOKTUR. Görev sözleşmesi geçersiz araç girdisi için sabit bir envelope
 * kodu istediğinden INVALID_ARGUMENT proje uzantısı olarak eklenmiştir;
 * şema reddi SDK düzeyinde isError dönerken, şemayı geçen anlamsal
 * girdi hataları bu kodla raporlanır. TŞ listesine dönüş kararı
 * wiki/decisions.md'e ADR olarak işlenmelidir (wiki yazımı ajan dışı).
 */
export const CAUSORYN_TOOL_ERROR_CODES = [
  "WORKSPACE_NOT_AUTHORIZED",
  "PATH_DENIED",
  "INDEX_NOT_READY",
  "AMBIGUOUS_SYMBOL",
  "LIMIT_EXCEEDED",
  "INVALID_ARGUMENT",
  "UNSUPPORTED_LANGUAGE",
  "INTERNAL_ERROR",
] as const;

export type CausorynToolErrorCode = (typeof CAUSORYN_TOOL_ERROR_CODES)[number];

/**
 * TŞ §10.1: "Tekrar denenebilirlik ve kullanici aksiyonu belirtilir."
 * Kod → (retryable, userAction) eşlemesi sabittir ve deterministiktir;
 * her hata envelope'unda yapısal alan olarak taşınır.
 */
export const TOOL_ERROR_GUIDANCE: Readonly<
  Record<CausorynToolErrorCode, { readonly retryable: boolean; readonly userAction: string }>
> = {
  WORKSPACE_NOT_AUTHORIZED: {
    retryable: false,
    userAction:
      "workspace kökünü kullanici onayli allowRoot listesine ekletin (causoryn workspace authorize akışı)",
  },
  PATH_DENIED: {
    retryable: false,
    userAction: "yolun ignore kurallarıyla reddedilip reddedilmediğini kontrol edin",
  },
  INDEX_NOT_READY: {
    retryable: true,
    userAction: "indeksleme (refresh_index) tamamlandıktan sonra yeniden deneyin",
  },
  AMBIGUOUS_SYMBOL: {
    retryable: false,
    userAction: "sorguyu kind/limit/pathPrefix ile daraltın veya adaylardan birini seçin",
  },
  LIMIT_EXCEEDED: {
    retryable: false,
    userAction: "istek limitini config tavanının altına düşürün (maxNodes/maxSymbols)",
  },
  INVALID_ARGUMENT: {
    retryable: false,
    userAction: "geçersiz girdiyi düzeltip yeniden deneyin",
  },
  UNSUPPORTED_LANGUAGE: {
    retryable: false,
    userAction: "get_capabilities ile desteklenen dil adapter'larını kontrol edin",
  },
  INTERNAL_ERROR: {
    retryable: true,
    userAction: "yeniden deneyin; sorun sürerse stderr loglarını inceleyin",
  },
};

/** Sabit rehber kaydından retryable/userAction kopyalar (deterministik). */
export function toolErrorGuidance(code: CausorynToolErrorCode): {
  readonly retryable: boolean;
  readonly userAction: string;
} {
  return TOOL_ERROR_GUIDANCE[code];
}

/**
 * Uygulama servisi hataları. `details` verilirse envelope.data'ya yazılır
 * (örn. AMBIGUOUS_SYMBOL adayları — TŞ §10.3 requiresDisambiguation
 * deseni); aksi halde hata envelope'unda data null'dır.
 */
export class CausorynToolError extends Error {
  readonly code: CausorynToolErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: CausorynToolErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "CausorynToolError";
    this.code = code;
    this.details = details;
  }
}
