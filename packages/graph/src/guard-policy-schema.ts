import { z } from "zod";
import { parse as parseYaml, YAMLParseError, type ErrorCode as YamlErrorCode } from "yaml";
import { EDGE_KINDS, type EdgeKind } from "@causoryn/domain";

/**
 * Architecture Guard policy DSL şeması — TŞ v2.1 §12, sprint-3 C2.
 *
 * `.causoryn/architecture.rules.yaml` yerel deklaratif kural dosyası ve
 * `.causoryn/architecture.baseline.yaml` suppression/baseline dosyası için
 * parse + Zod doğrulama katmanı. Kural değerlendirme çekirdeği
 * (`guard.ts`) saf ve deterministiktir; bu dosya yalnızca ham YAML metnini
 * doğrulanmış, derlenmiş (glob'ları hazır) yapıya çevirir.
 *
 * Belgelenmiş normalizasyon kararları (TŞ §12: "Rules globs, case
 * sensitivity, namespace/path normalizasyonu belgelenir"):
 * - Glob söz dizimi YALNIZCA `**`, `*`, `?` destekler; `{a,b}`, `[...]`,
 *   `(...)` gibi alternasyon/sınıf söz dizimi açıkça reddedilir
 *   (guard/pattern-unsupported-syntax). Bu, ReDoS kırmızı çizgisinin
 *   (karmaşık desen kotası + uzunluk sınırı) yapısal parçasıdır.
 * - Globlar büyük/küçük harfe DUYARLIDIR (bayrak yok): workspace yolları
 *   adaptörler tarafından workspace'in kanonik yazımıyla taşınır; platform
 *   bağımlı case-folding determinizmi bozar.
 * - `**` ayraçları aşar (`**` + `/X/` + `**` deseni kök seviyesindeki `X/`
 *   ile de eşleşir),
 *   `*` tek segment içinde, `?` tek karakterde kalır.
 * - Eşleşme yüzeyi node başına iki adaydır: `location.relativePath`
 *   (`\` → `/` normalize edilerek) ve `qualifiedName`. İkisinden biri
 *   eşleşirse node eşleşmiştir. Nokta ile ayrılmış qualifiedName'ler path
 *   glob'uyla eşleşmez; bu nedenle path tabanlı kurallar location gerektirir.
 * - Suppression girişlerinde `reason`, `owner`, `date` ZORUNLUDUR
 *   (TŞ §12: "neden/sahip/tarih bilgisi zorunlu kılınabilir" — bu tasarımda
 *   zorunlu kılınmıştır); Zod refine eksik/boş alanı şema reddiyle düşürür.
 * - Resource and disclosure bounds (TŞ §19 untrusted repository input,
 *   TŞ §20 budgets): YAML aliases are not supported (`maxAliasCount: 0`;
 *   an alias is a policy error, never an unmapped exception); YAML parse
 *   errors carry the error code, line and column but no source text; rule,
 *   suppression and edgeKinds list sizes, identifier/free-text lengths and
 *   the number of reported schema issues are capped (constants below).
 *
 * Bu modül fs/thread/saat okumaz; dosya okuma MCP/servis katmanının işidir.
 */

// ---------------------------------------------------------------------------
// Hata tipi
// ---------------------------------------------------------------------------

/**
 * Policy/baseline doğrulama hatası. Kod tablosu:
 * - guard/policy-yaml-invalid, guard/baseline-yaml-invalid: YAML sözdizimi
 * - guard/policy-invalid, guard/baseline-invalid: şema ihlali
 * - guard/pattern-too-long: glob uzunluk sınırı
 * - guard/pattern-too-complex: glob wildcard kotası
 * - guard/pattern-unsupported-syntax: desteklenmeyen glob söz dizimi
 * - guard/invalid-input: guard çekirdeğine bozuk girdi
 */
export class GuardError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly issues?: readonly string[],
  ) {
    super(message);
    this.name = "GuardError";
  }
}

// ---------------------------------------------------------------------------
// Glob derleyici — güvenlik sınırları (kırmızı çizgi 6: ReDoS'a karşı sınırlı)
// ---------------------------------------------------------------------------

/** Tek glob deseninin azami uzunluğu. */
export const MAX_GLOB_LENGTH = 256;

/** Tek glob desenindeki azami `*`/`?` sayısı (karmaşıklık kotası). */
export const MAX_GLOB_WILDCARDS = 32;

/**
 * Derlenen glob: `source` özgün deseni korur (gerekçe/hata mesajları için),
 * `matches` düz metin üzerinde büyük/küçük harfe duyarlı tam eşleşme yapar.
 */
export interface GuardGlob {
  readonly source: string;
  matches(value: string): boolean;
}

/** DSL gramerinde desteklenmeyen regex/glob metakarakterleri. */
const UNSUPPORTED_GLOB_CHARS = new Set([
  "\\",
  "{",
  "}",
  "[",
  "]",
  "(",
  ")",
  "|",
  "^",
  "$",
  "+",
  "!",
]);

/**
 * Glob belirteci. Eşleşme regex DERLEMEDEN, belirteçler üzerinde NFA
 * simülasyonu (dinamik programlama) ile yapılır; bu yüzden "niceleyici
 * içeren grup" (eski `**` + `/` derlemesi) hiçbir koşulda üretilmez.
 */
type GlobToken =
  | { readonly type: "lit"; readonly ch: string }
  | { readonly type: "star" }
  | { readonly type: "qmark" }
  | { readonly type: "globstarSlash" }
  | { readonly type: "globstar" };

function tokenizeGlob(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === undefined) break; // noUncheckedIndexedAccess güvencesi
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          tokens.push({ type: "globstarSlash" });
          i += 3;
        } else {
          tokens.push({ type: "globstar" });
          i += 2;
        }
      } else {
        tokens.push({ type: "star" });
        i += 1;
      }
    } else if (ch === "?") {
      tokens.push({ type: "qmark" });
      i += 1;
    } else {
      tokens.push({ type: "lit", ch });
      i += 1;
    }
  }
  return tokens;
}

/**
 * Belirteç dizisini değer üzerinde simüle eder. Ulaşılabilir konum
 * kümesi boolean diziyle taşınır; her belirteç O(değer uzunluğu) geçişte
 * çözülür, toplam O(belirteç × uzunluk) — GERİ İZLEME YOK. `**` + `/`
 * grubunun
 * çoklu eşleşme belirsizliği (eski regex gerçeklemesinde combinatorial
 * backtracking patlatan durum) burada tek doğrusal geçişte kapanır.
 */
function matchGlobTokens(
  tokens: readonly GlobToken[],
  value: string,
): boolean {
  const n = value.length;
  let current = new Array<boolean>(n + 1).fill(false);
  let next = new Array<boolean>(n + 1).fill(false);
  current[0] = true;

  for (const token of tokens) {
    next.fill(false);
    switch (token.type) {
      case "lit": {
        const ch = token.ch;
        for (let j = 0; j < n; j += 1) {
          if (current[j] && value[j] === ch) next[j + 1] = true;
        }
        break;
      }
      case "qmark": {
        for (let j = 0; j < n; j += 1) {
          if (current[j] && value[j] !== "/") next[j + 1] = true;
        }
        break;
      }
      case "globstar": {
        // Sıfır veya daha çok karakter (ayraç dahil): önek kapanışı.
        let open = false;
        for (let j = 0; j <= n; j += 1) {
          if (current[j]) open = true;
          next[j] = open;
        }
        break;
      }
      case "star": {
        // Sıfır veya daha çok karakter, '/' yok: eşleşme herhangi ulaşılabilir
        // konumda başlar, ilk '/'te biter.
        let open = false;
        for (let j = 0; j <= n; j += 1) {
          if (current[j]) open = true;
          next[j] = open;
          if (j < n && value[j] === "/") open = false;
        }
        break;
      }
      case "globstarSlash": {
        // Sıfır dizin (boş tüketim) VEYA sondaki karakteri '/' olan önek
        // (`**/` ≡ eski regex karşılığı (?:.*/)? — ancak regex üretilmez).
        let prefixReachable = false; // current[0..j-1] içinde ulaşılabilir var mı
        for (let j = 0; j <= n; j += 1) {
          if (j > 0 && value[j - 1] === "/" && prefixReachable) {
            next[j] = true;
          }
          if (current[j]) {
            next[j] = true;
            prefixReachable = true;
          }
        }
        break;
      }
    }
    const swap = current;
    current = next;
    next = swap;
  }

  return current[n] === true; // noUncheckedIndexedAccess: undefined → false
}

/**
 * Glob desenini güvenlik sınırlarına tabi tutup derler. Gramer: `**` +
 * `/` ("sıfır veya daha çok dizin/"), `**` (her şey), `*` (segment içi), `?`
 * (tek karakter); geri kalan her karakter birebir literal.
 *
 * ReDoS notu (kırmızı çizgi 6): eşleşme regex DERLEMEDEN NFA simülasyonuyla
 * O(belirteç × değer uzunluğu) doğrusal geçişte yapılır — geri izleme yok,
 * niceleyici içeren grup üretimi yok. Eski regex gerçeklemesinde `**`
 * + `/` derlemesi `.*` niceleyicisi içeren bir grubdu; kotalara uyan desenlerde bile
 * combinatorial backtracking patlatıyordu (ölçüm: 12 grup × 20 segment =
 * 6744 ms; 16 grup × 2500 segment dakikalarca bitmedi). Uzunluk/wildcard
 * kotaları savunma derinliği olarak korunur; artık tek başına yeterli
 * güvenlik iddiası taşımazlar, eşleştiricinin doğrusallığı taşır.
 */
export function compileGuardGlob(pattern: string): GuardGlob {
  if (pattern.length > MAX_GLOB_LENGTH) {
    throw new GuardError(
      "guard/pattern-too-long",
      `Glob pattern is too long (${pattern.length} > ${MAX_GLOB_LENGTH})`,
    );
  }
  let wildcards = 0;
  for (const ch of pattern) {
    if (ch === "*" || ch === "?") wildcards += 1;
    if (UNSUPPORTED_GLOB_CHARS.has(ch)) {
      throw new GuardError(
        "guard/pattern-unsupported-syntax",
        `Unsupported character in glob pattern: '${ch}' (only **, * and ? are supported)`,
      );
    }
  }
  if (pattern.includes("***")) {
    throw new GuardError(
      "guard/pattern-unsupported-syntax",
      "Three or more consecutive '*' characters are not supported in a glob pattern",
    );
  }
  if (wildcards > MAX_GLOB_WILDCARDS) {
    throw new GuardError(
      "guard/pattern-too-complex",
      `Glob pattern is too complex (${wildcards} wildcards > ${MAX_GLOB_WILDCARDS})`,
    );
  }

  const tokens = tokenizeGlob(pattern);
  return {
    source: pattern,
    matches(value: string): boolean {
      return matchGlobTokens(tokens, value);
    },
  };
}

// ---------------------------------------------------------------------------
// YAML şemaları (Zod)
// ---------------------------------------------------------------------------

export type GuardSeverity = "error" | "warning" | "info";
export type GuardRuleType = "no-cycles" | "forbidden-dependency";
/** no-cycles kapsamı: hangi node türleri döngü analizine girer. */
export type GuardScope = "modules" | "files" | "all";

/**
 * Maximum number of rules in one policy file. Evaluation cost grows with
 * rules × graph size (every rule scans all edges or runs an SCC pass).
 */
export const MAX_POLICY_RULES = 500;

/**
 * Maximum number of suppression entries in one baseline file. Each finding
 * is matched against the suppression list, so the cost grows with
 * findings × suppressions; one entry can cover many findings via globs.
 */
export const MAX_BASELINE_SUPPRESSIONS = 1000;

/** Maximum length of identifier-like fields: rule id, suppression ruleId, owner. */
export const MAX_GUARD_IDENTIFIER_LENGTH = 256;

/** Maximum length of free-text fields: rule description, suppression reason. */
export const MAX_GUARD_TEXT_LENGTH = 2048;

/** Maximum number of schema issues carried by a GuardError (message and `issues`). */
export const MAX_REPORTED_SCHEMA_ISSUES = 20;

/** Maximum length of one reported schema issue; longer issue texts are truncated. */
const MAX_ISSUE_TEXT_LENGTH = 200;

const SeveritySchema = z.enum(["error", "warning", "info"]);
const ScopeSchema = z.enum(["modules", "files", "all"]);
const EdgeKindSchema = z.enum(EDGE_KINDS);

/**
 * edgeKinds list: at least one entry and never more entries than there are
 * edge kinds (each kind can be listed once; the list is not deduplicated).
 */
const EdgeKindListSchema = z
  .array(EdgeKindSchema)
  .min(1)
  .max(EDGE_KINDS.length, `edgeKinds may list at most ${String(EDGE_KINDS.length)} entries`);

/**
 * Boş/yalnızca boşluk string reddi — domain paketindeki requireNonEmpty
 * kuralıyla aynı semantik (değer kırpılmaz, olduğu gibi taşınır).
 */
const isNotBlank = (value: string): boolean => value.trim().length > 0;
const NOT_BLANK = { message: "Field must not be empty or whitespace-only" };

const NonEmptyString = z.string().refine(isNotBlank, NOT_BLANK);

/** NonEmptyString with an upper length bound. */
function boundedNonEmptyString(maxLength: number): z.ZodType<string> {
  return z
    .string()
    .max(maxLength, `Field must be at most ${String(maxLength)} characters`)
    .refine(isNotBlank, NOT_BLANK);
}

const RuleIdSchema = boundedNonEmptyString(MAX_GUARD_IDENTIFIER_LENGTH);

const DescriptionSchema = z
  .string()
  .max(MAX_GUARD_TEXT_LENGTH, `description must be at most ${String(MAX_GUARD_TEXT_LENGTH)} characters`);

const NoCyclesRuleSchema = z.strictObject({
  id: RuleIdSchema,
  type: z.literal("no-cycles"),
  scope: ScopeSchema.optional(),
  /**
   * Belirtilmezse varsayılan [CALLS, IMPORTS]. Kaynak notu: TŞ §12 yalnızca
   * "Tarjan SCC ile cycle detection" der; hangi kenar türlerinin varsayılan
   * olacağı bu paketin TASARIM KARARIDIR (belgelenmiş yorum, TŞ atfı
   * değildir). Başka EDGE_KINDS değerleri de seçilebilir (örn. INHERITS);
   * liste boş olamaz.
   */
  edgeKinds: EdgeKindListSchema.optional(),
  severity: SeveritySchema,
  description: DescriptionSchema.optional(),
});

const ForbiddenDependencyRuleSchema = z.strictObject({
  id: RuleIdSchema,
  type: z.literal("forbidden-dependency"),
  // NonEmptyString: boş from/to '^$' glob'una derlenip kuralı sessiz ölü
  // girdi yapmaz; şema reddiyle yüzeye çıkar.
  // Glob length is bounded by compileGuardGlob (MAX_GLOB_LENGTH).
  from: NonEmptyString,
  to: NonEmptyString,
  edgeKinds: EdgeKindListSchema,
  severity: SeveritySchema,
  description: DescriptionSchema.optional(),
});

const PolicySchema = z
  .strictObject({
    version: z.literal(1),
    rules: z
      .discriminatedUnion("type", [NoCyclesRuleSchema, ForbiddenDependencyRuleSchema])
      .array()
      .max(MAX_POLICY_RULES, `a policy may define at most ${String(MAX_POLICY_RULES)} rules`),
  })
  .superRefine((policy, ctx) => {
    const seen = new Set<string>();
    for (const rule of policy.rules) {
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate rule id: ${rule.id}`,
          path: ["rules"],
        });
      }
      seen.add(rule.id);
    }
  });

// Baseline/suppression şeması — reason/owner/date ZORUNLU (Zod refine ile).

const BASELINE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidCalendarDate(value: string): boolean {
  if (!BASELINE_DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  return (
    asUtc.getUTCFullYear() === year &&
    asUtc.getUTCMonth() === month - 1 &&
    asUtc.getUTCDate() === day
  );
}

const SuppressionSchema = z.strictObject({
  ruleId: RuleIdSchema,
  /** ZORUNLU: neden baskılanıyor (TŞ §12 yönetişim koşulu). */
  reason: boundedNonEmptyString(MAX_GUARD_TEXT_LENGTH),
  /** ZORUNLU: kim üstleniyor. */
  owner: boundedNonEmptyString(MAX_GUARD_IDENTIFIER_LENGTH),
  /** ZORUNLU: hangi tarihte kaydedildi (YYYY-MM-DD, geçerli takvim günü). */
  date: z
    .string()
    .refine(isValidCalendarDate, {
      message: "date must be a valid calendar day in YYYY-MM-DD format",
    }),
  // NonEmptyString: boş from/to '^$' glob'una derlenip baskılamayı sessizce
  // no-op yapmaz; şema reddiyle yüzeye çıkar.
  from: NonEmptyString.optional(),
  to: NonEmptyString.optional(),
});

const BaselineSchema = z.strictObject({
  version: z.literal(1),
  suppressions: SuppressionSchema.array().max(
    MAX_BASELINE_SUPPRESSIONS,
    `a baseline may define at most ${String(MAX_BASELINE_SUPPRESSIONS)} suppressions`,
  ),
});

// ---------------------------------------------------------------------------
// Normalize edilmiş (derlenmiş) çıktı tipleri
// ---------------------------------------------------------------------------

export interface NoCyclesRule {
  readonly id: string;
  readonly type: "no-cycles";
  readonly severity: GuardSeverity;
  readonly scope: GuardScope;
  readonly edgeKinds: readonly EdgeKind[];
  readonly description?: string;
}

export interface ForbiddenDependencyRule {
  readonly id: string;
  readonly type: "forbidden-dependency";
  readonly severity: GuardSeverity;
  readonly from: GuardGlob;
  readonly to: GuardGlob;
  readonly edgeKinds: readonly EdgeKind[];
  readonly description?: string;
}

export type ArchitectureRule = NoCyclesRule | ForbiddenDependencyRule;

export interface ArchitecturePolicy {
  readonly version: 1;
  readonly rules: readonly ArchitectureRule[];
}

export interface SuppressionEntry {
  readonly ruleId: string;
  readonly reason: string;
  readonly owner: string;
  readonly date: string;
  readonly from?: GuardGlob;
  readonly to?: GuardGlob;
}

export interface ArchitectureBaseline {
  readonly version: 1;
  readonly suppressions: readonly SuppressionEntry[];
}

/** no-cycles varsayılan kenar türleri — TASARIM KARARI (TŞ §12 yalnızca "Tarjan SCC ile cycle detection" der). */
const DEFAULT_NO_CYCLES_EDGE_KINDS: readonly EdgeKind[] = ["CALLS", "IMPORTS"];

// ---------------------------------------------------------------------------
// Parse + doğrulama
// ---------------------------------------------------------------------------

/**
 * YAML parse options: aliases are disabled (`maxAliasCount: 0`, so alias
 * expansion cannot multiply the document) and parser warnings are not
 * written to stderr (`logLevel: "error"`; warnings embed source excerpts).
 */
const YAML_PARSE_OPTIONS = { maxAliasCount: 0, logLevel: "error" } as const;

/** Generic reasons per yaml error code; the parser's own message embeds source text. */
const YAML_ERROR_REASONS: Partial<Record<YamlErrorCode, string>> = {
  BAD_INDENT: "bad indentation",
  BAD_DQ_ESCAPE: "invalid escape sequence in a double-quoted string",
  BAD_SCALAR_START: "a plain scalar cannot start with this character",
  BLOCK_AS_IMPLICIT_KEY: "nested mapping is not allowed in a compact mapping",
  BLOCK_IN_FLOW: "block collection is not allowed inside a flow collection",
  DUPLICATE_KEY: "mapping keys must be unique",
  KEY_OVER_1024_CHARS: "implicit key is longer than 1024 characters",
  MISSING_CHAR: "missing closing character",
  MULTILINE_IMPLICIT_KEY: "implicit keys must be on a single line",
  MULTIPLE_DOCS: "the file must contain a single YAML document",
  RESOURCE_EXHAUSTION: "document exceeds the parser resource limits",
  TAB_AS_INDENT: "tabs are not allowed as indentation",
  UNEXPECTED_TOKEN: "unexpected token",
};

/** Describes a YAML parse error by code and position only (no source excerpt). */
function describeYamlParseError(error: YAMLParseError): string {
  const reason = YAML_ERROR_REASONS[error.code] ?? "invalid YAML syntax";
  const position = error.linePos?.[0];
  const where =
    position === undefined
      ? ""
      : ` at line ${String(position.line)}, column ${String(position.col)}`;
  return `YAML could not be parsed: ${error.code} (${reason})${where}`;
}

function parseYamlOrThrow(text: string, yamlErrorCode: string): unknown {
  let document: unknown;
  try {
    document = parseYaml(text, YAML_PARSE_OPTIONS);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      throw new GuardError(yamlErrorCode, describeYamlParseError(error));
    }
    // The yaml library raises ReferenceError only while resolving aliases
    // (disabled, unresolved or excessive alias use).
    if (error instanceof ReferenceError) {
      throw new GuardError(
        yamlErrorCode,
        "YAML could not be parsed: aliases (*name) are not supported in policy and baseline files; write the referenced value out in full",
      );
    }
    throw error;
  }
  return document;
}

function truncateIssue(text: string): string {
  return text.length <= MAX_ISSUE_TEXT_LENGTH
    ? text
    : `${text.slice(0, MAX_ISSUE_TEXT_LENGTH)}... (truncated)`;
}

function requireSchema<T>(
  schema: z.ZodType<T>,
  document: unknown,
  code: string,
): T {
  const result = schema.safeParse(document);
  if (!result.success) {
    const allIssues = result.error.issues;
    const issues = allIssues
      .slice(0, MAX_REPORTED_SCHEMA_ISSUES)
      .map((issue) => truncateIssue(`${issue.path.join(".") || "(root)"}: ${issue.message}`));
    const omitted = allIssues.length - issues.length;
    const suffix = omitted > 0 ? `; ... and ${String(omitted)} more issue(s)` : "";
    throw new GuardError(
      code,
      `Schema validation failed: ${issues.join("; ")}${suffix}`,
      issues,
    );
  }
  return result.data;
}

/** Glob alanlarını derler; güvenlik hata kodlarını aynen yüzeye taşır. */
function compileOrThrow(pattern: string, context: string): GuardGlob {
  try {
    return compileGuardGlob(pattern);
  } catch (error) {
    if (error instanceof GuardError) {
      throw new GuardError(error.code, `${context}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * `.causoryn/architecture.rules.yaml` metnini doğrular ve derler.
 * Geçersiz YAML → guard/policy-yaml-invalid; şema ihlali →
 * guard/policy-invalid; güvensiz glob → ilgili guard/pattern-* kodu.
 */
export function parseArchitecturePolicy(yamlText: string): ArchitecturePolicy {
  const document = parseYamlOrThrow(yamlText, "guard/policy-yaml-invalid");
  const raw = requireSchema(PolicySchema, document, "guard/policy-invalid");

  const rules: ArchitectureRule[] = raw.rules.map((rule) => {
    if (rule.type === "no-cycles") {
      const normalized: NoCyclesRule = {
        id: rule.id,
        type: rule.type,
        severity: rule.severity,
        scope: rule.scope ?? "all",
        edgeKinds: rule.edgeKinds ?? DEFAULT_NO_CYCLES_EDGE_KINDS,
        ...(rule.description === undefined ? {} : { description: rule.description }),
      };
      return normalized;
    }
    return {
      id: rule.id,
      type: rule.type,
      severity: rule.severity,
      from: compileOrThrow(rule.from, `rule ${rule.id} (from)`),
      to: compileOrThrow(rule.to, `rule ${rule.id} (to)`),
      edgeKinds: [...rule.edgeKinds],
      ...(rule.description === undefined ? {} : { description: rule.description }),
    };
  });

  return { version: 1, rules };
}

/**
 * `.causoryn/architecture.baseline.yaml` metnini doğrular ve derler.
 * reason/owner/date Zorunludur; eksik/boş alan veya geçersiz tarih →
 * guard/baseline-invalid. from/to verilirse güvenlik sınırlarından geçer.
 */
export function parseArchitectureBaseline(
  yamlText: string,
): ArchitectureBaseline {
  const document = parseYamlOrThrow(yamlText, "guard/baseline-yaml-invalid");
  const raw = requireSchema(BaselineSchema, document, "guard/baseline-invalid");

  const suppressions: SuppressionEntry[] = raw.suppressions.map((entry) => {
    const normalized: SuppressionEntry = {
      ruleId: entry.ruleId,
      reason: entry.reason,
      owner: entry.owner,
      date: entry.date,
      ...(entry.from === undefined ? {} : { from: compileOrThrow(entry.from, `suppression ${entry.ruleId} (from)`) }),
      ...(entry.to === undefined ? {} : { to: compileOrThrow(entry.to, `suppression ${entry.ruleId} (to)`) }),
    };
    return normalized;
  });

  return { version: 1, suppressions };
}
