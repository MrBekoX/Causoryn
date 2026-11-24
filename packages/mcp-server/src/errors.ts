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
 * ADR durumu: `INVALID_ARGUMENT` + `EVIDENCE_NOT_FOUND` K-008 ile,
 * `SYMBOL_NOT_FOUND` ise K-011 (`wiki/decisions.md:37`) ile karara
 * bağlanmıştır.
 *
 * Rezerve sabit kod notu: `UNSUPPORTED_LANGUAGE` kodu TŞ §10.1 sabit taban
 * listesinden korunmuştur; mevcut dilimde adapter fallback mekanizması
 * nedeniyle servislerce fırlatılmaz (rezerve sabit kod).
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
 * Deterministic error-code -> (retryable, userAction) guidance table carried
 * on every error envelope.
 */
export const TOOL_ERROR_GUIDANCE: Readonly<
  Record<CausorynToolErrorCode, { readonly retryable: boolean; readonly userAction: string }>
> = {
  WORKSPACE_NOT_AUTHORIZED: {
    retryable: false,
    userAction:
      "Authorize the workspace root using --root <path>, --allow-cwd, MCP roots/list, or allowRoots in CAUSORYN_CONFIG",
  },
  PATH_DENIED: {
    retryable: false,
    userAction:
      "Verify the path stays within the authorized workspace root and is not excluded by ignore or binary rules",
  },
  INDEX_NOT_READY: {
    retryable: true,
    userAction: "Wait for indexing to finish (or run refresh_index) and retry",
  },
  AMBIGUOUS_SYMBOL: {
    retryable: false,
    userAction:
      "Narrow the query with kind, limit, or pathPrefix, or pick one of the returned candidate symbol IDs",
  },
  LIMIT_EXCEEDED: {
    retryable: false,
    userAction:
      "Lower the requested limit below the configured ceiling (e.g. maxNodes, maxSymbols, or maxFileBytes)",
  },
  INVALID_ARGUMENT: {
    retryable: false,
    userAction: "Fix the invalid input argument(s) and retry",
  },
  EVIDENCE_NOT_FOUND: {
    retryable: false,
    userAction:
      "Use node, edge, finding, or evidence IDs from the current snapshot; if stale, run refresh_index and retry",
  },
  SYMBOL_NOT_FOUND: {
    retryable: false,
    userAction:
      "Use symbolId values from map_system or find_symbols; if the codebase changed, run refresh_index and retry",
  },
  POLICY_INVALID: {
    retryable: false,
    userAction:
      "Fix .causoryn/architecture.rules.yaml (and .causoryn/architecture.baseline.yaml if present), or create the policy file if missing",
  },
  INVALID_REVISION: {
    retryable: false,
    userAction:
      "Provide a valid git commit, branch, tag, or working-tree ref with an analyzable architecture snapshot",
  },
  EXPORT_NOT_ALLOWED: {
    retryable: false,
    userAction:
      "Add the destination directory to output.allowedOutputDirs in the server configuration",
  },
  WIKI_PAGE_NOT_FOUND: {
    retryable: false,
    userAction:
      "Use pageId values returned by wiki_get_tree; if querying an older WikiSnapshot, retry against the latest snapshot",
  },
  CONTRACT_PARSE_FAILED: {
    retryable: false,
    userAction:
      "Fix the contract specification file (OpenAPI, AsyncAPI, JSON Schema, SQL, or Protobuf) or reduce its size below the configured limit",
  },
  UNSUPPORTED_LANGUAGE: {
    retryable: false,
    userAction: "Run get_capabilities to inspect supported language adapters and coverage levels",
  },
  INTERNAL_ERROR: {
    retryable: true,
    userAction: "Retry the request; if the error persists, inspect the server stderr logs",
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
