/**
 * Sabit tool hata kodları (TŞ v2.1 §10.1) — Faz A/B dilimlerinin kullandığı
 * alt küme + sprint-3 Faz C dilimi eklemeleri + ÜÇ proje uzantısı.
 * Kodlar envelope.error.code ile taşınır; stack trace MCP sonucuna
 * yazılmaz (TŞ §10.1).
 *
 * Sprint-3 Faz C diliminde kod tablosuna ÜÇ giriş eklendi (hepsi birincil
 * kaynak raw/Causoryn_Teknik_Dokuman_v2.1.pdf s.9 §10.1 sabit listesinden
 * doğrulanmıştır — takım denetimi bulgusu sonrası yeniden çıkarıldı):
 * - POLICY_INVALID: TŞ §10.1 SABİT listesinde ZATEN vardır; bu dilimde ilk
 *   kez kullanıldı (causoryn_check_architecture: `.causoryn/
 *   architecture.rules.yaml` / baseline YAML çözümleme ve şema reddi +
 *   policy dosyası yokluğu — packages/graph guard-policy-schema.ts
 *   `guard/...` kodlarının MCP eşlemesi).
 * - INVALID_REVISION: TŞ §10.1 SABİT listesinde ZATEN vardır; bu dilimde
 *   ilk kez kullanıldı (causoryn_compare_architecture /
 *   causoryn_architecture_timeline: çözümlenemeyen ref ya da ref'te
 *   analiz edilebilir `.causoryn/architecture-snapshot.json` blob'u yok —
 *   git-read/timeline `compare/*` + `timeline/invalid-range` kodlarının
 *   MCP eşlemesi).
 * - EXPORT_NOT_ALLOWED: TŞ §10.1 SABİT listesinde ZATEN vardır; bu dilimde
 *   ilk kez kullanıldı (causoryn_export_documentation: hedef dizinin
 *   beyanlı output.allowedOutputDirs listesinde olmaması — @causoryn/
 *   workspace OutputAccessPolicy `workspace/output-not-authorized`
 *   kararının MCP eşlemesi). Takım denetimi bulgusu: export yazma reddi için
 *   YENİ bir uzantı kodu (OUTPUT_NOT_AUTHORIZED) basmak K-008 örüntüsünün
 *   önkoşulunu ("TŞ listesinde uygun kod yok") ihlal ederdi — adı ve TŞ
 *   §16 konumu gereği EXPORT_NOT_ALLOWED tam karşılıktır.
 * - WIKI_PAGE_NOT_FOUND: TŞ §10.1 SABİT listesinde ZATEN vardır (s.9,
 *   birincil kaynak doğrulaması: plugin-package.test.ts
 *   TSH_BASE_ERROR_CODES); sprint-4 W5'te (Faz C2 Living Wiki) İLK KEZ
 *   kullanıldı — WikiSnapshot'ta olmayan sayfa/parentId/pageId kimlikleri
 *   bu sabit kodla raporlanır (takım denetimi bulgusu: sayfa kimliği için
 *   EVIDENCE_NOT_FOUND uzantı kodunu kullanmak K-008 örüntüsünün
 *   önkoşulunu ihlal ederdi; TŞ listesinde bire bir kod vardı).
 *   WIKI_REVISION_NOT_AVAILABLE ve WIKI_BROKEN_LINK TŞ sabit kodları bu
 *   dilimde HÂLÂ kullanılmaz: revizyon çözümlemesi K-013 #6 ile
 *   INVALID_REVISION'a, bozuk link ise hata değil veri yüzeyine
 *   (brokenLinkDiagnostics, K-013 #4) gider.
 * - CONTRACT_PARSE_FAILED: TŞ §10.1 SABİT listesinde ZATEN vardır (s.9,
 *   birincil kaynak doğrulaması: plugin-package.test.ts
 *   TSH_BASE_ERROR_CODES); sprint-5 Faz D'de (D2/D3 sözleşme araçları:
 *   causoryn_check_contracts, causoryn_detect_contract_drift) İLK KEZ
 *   kullanıldı — spec dosyasının parse/şema reddi (packages/contracts
 *   ContractDiscoveryError "contracts/spec-yaml-invalid" |
 *   "contracts/spec-json-invalid" | "contracts/spec-invalid" |
 *   "contracts/unsupported-spec" kodlarının MCP eşlemesi). Yeni uzantı
 *   kodu basılmaz: TŞ listesinde bire bir kod vardır (K-008 örüntüsü).
 *
 * Uzantı notu (dürüstlük): TŞ §10.1 sabit kod listesinde INVALID_ARGUMENT,
 * EVIDENCE_NOT_FOUND ve SYMBOL_NOT_FOUND YOKTUR. Görev sözleşmeleri
 * (1) geçersiz araç girdisi, (2) causoryn_get_evidence'ta bulunamayan
 * kimlik (sprint-1 görev 7), (3) causoryn_get_symbol_context'te
 * bulunamayan sembol (sprint-2 B5) için sabit envelope kodları istediğinden
 * üçü proje uzantısı olarak eklenmiştir; şema reddi SDK düzeyinde isError
 * dönerken, şemayı geçen anlamsal girdi hataları INVALID_ARGUMENT ile,
 * snapshot'ta olmayan node/edge/evidence kimlikleri EVIDENCE_NOT_FOUND ile,
 * snapshot'ta olmayan sembol kimlik/adları SYMBOL_NOT_FOUND ile raporlanır.
 * Beyanlı olmayan output hedefi ise EXPORT_NOT_ALLOWED (sabit) ile
 * raporlanır — uzantı kodu gerektirmez.
 *
 * ADR durumu: K-008 karar kaydı (wiki/decisions.md) YALNIZCA ilk iki
 * uzantıyı (INVALID_ARGUMENT + EVIDENCE_NOT_FOUND) karara bağlar;
 * SYMBOL_NOT_FOUND henüz kayıtsızdır. wiki/decisions.md'e K-008'i
 * genişleten yeni ADR girişinin işlenmesi orkestratöre aittir (wiki yazımı
 * ajan dışı — sprint-2 takım denetimi bulgusu, commit öncesi süreç kalemi).
 */
export const CAUSORYN_TOOL_ERROR_CODES = [
  "WORKSPACE_NOT_AUTHORIZED",
  "PATH_DENIED",
  "INDEX_NOT_READY",
  "AMBIGUOUS_SYMBOL",
  "LIMIT_EXCEEDED",
  "INVALID_ARGUMENT",
  "EVIDENCE_NOT_FOUND",
  "SYMBOL_NOT_FOUND",
  "POLICY_INVALID",
  "INVALID_REVISION",
  "EXPORT_NOT_ALLOWED",
  "WIKI_PAGE_NOT_FOUND",
  "CONTRACT_PARSE_FAILED",
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
  EVIDENCE_NOT_FOUND: {
    retryable: false,
    userAction:
      "map_system/find_symbols çıktısındaki node/edge kimliklerini kullanın; eski bir snapshot kimliği sorgulandıysa refresh_index sonrası güncel kimlikle yeniden deneyin",
  },
  SYMBOL_NOT_FOUND: {
    retryable: false,
    userAction:
      "map_system/find_symbols çıktısındaki symbolId değerlerini kullanın; eski bir snapshot kimliği sorgulandıysa refresh_index sonrası güncel kimlikle yeniden deneyin",
  },
  POLICY_INVALID: {
    retryable: false,
    userAction:
      ".causoryn/architecture.rules.yaml politikasını (ve verilmişse architecture.baseline.yaml'i) düzeltin; dosya mevcut değilse oluşturun",
  },
  INVALID_REVISION: {
    retryable: false,
    userAction:
      "geçerli bir commit/tag/branch ref'i (veya working-tree) kullanın; ref'te analiz edilebilir .causoryn/architecture-snapshot.json blob'u yoksa o revizyonda snapshot yayınlayın",
  },
  EXPORT_NOT_ALLOWED: {
    retryable: false,
    userAction:
      "hedef dizini sunucu config'inin output.allowedOutputDirs beyanına ekletin (explicit izinli output listesi, TŞ §16 export güvenliği)",
  },
  WIKI_PAGE_NOT_FOUND: {
    retryable: false,
    userAction:
      "wiki_get_tree çıktısındaki pageId değerlerini kullanın; eski bir WikiSnapshot kimliği sorgulandıysa güncel snapshot ile yeniden deneyin",
  },
  CONTRACT_PARSE_FAILED: {
    retryable: false,
    userAction:
      "spec dosyasını (OpenAPI/AsyncAPI/JSON Schema/SQL/proto) düzeltin; kota aşımıysa dosyayı küçültün — desteklenen şema ve sınırlar get_capabilities belgelerindedir",
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
