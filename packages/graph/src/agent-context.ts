import type { GraphNode, NodeKind, SnapshotGraph } from "@causoryn/domain";

import { GraphRepositoryError } from "./errors.js";
import type { SymbolSearchHit, SymbolSearchStore } from "./repository.js";
import { tokenizeSymbolText } from "./symbol-tokens.js";
import { nodeIdentityRelativePath } from "./validation.js";

/**
 * causoryn_get_agent_context çekirdeği (Agent GPS) — TŞ v2.1 §15 (Sayfa 13);
 * §10.2 (Sayfa 10) araç girdisi "task, candidateScope?, tokenBudget"; çıktı
 * "AI Agent GPS, rationale, omissions". Sprint-3 C4.
 *
 * Sözleşme (TŞ §15): "Host modelin aktardığı görev metni yalnızca arama
 * sorgusu verisi olarak değerlendirilir. Ranking: exact symbol/route match →
 * graph proximity → contract relevance → recency → test relevance → FTS5
 * lexical match. tokenBudget yaklaşık karakter/token maliyetiyle uygulanır ve
 * estimatedTokens adıyla raporlanır; host tokenizer ile kesin eşitlik iddiası
 * yoktur. contextItems dosya yolu, dar span, reason, evidence ve omittedCount
 * sunar."
 *
 * Bu dilimin sıralı ayakları (sprint-3 C4 kapsamı; TŞ'nin "test relevance"
 * ayağı Test Intelligence dilimine aittir ve burada YOKTUR):
 *   1. exact-symbol    — birebir sembol eşleşmesi
 *   2. graph-proximity — birebir eşleşen sembolden bağlantı derinliği (BFS)
 *   3. contract        — kontrat yüzey sinyali (sprint-5 D7 ile GERÇEĞE
 *                        BAĞLANDI: girdi kaynağı (a) açık contractSymbols
 *                        ve (b) snapshot'ın sözleşme node yüzeyi — ikisinin
 *                        birleşimi; hiçbiri yoksa ayak atlanır, hata ÇIKMAZ)
 *   4. freshness       — dosya updatedAt tazeliği (sıralama ayakı; tek başına
 *                        aday ÜRETMEZ)
 *   5. fts             — symbol_fts lexical eşleşme (depo verilmezse atlanır)
 *
 * Tasarım kararları (TŞ metninin deterministik yorumu):
 * - Görev metni YALNIZCA arama verisidir: normalize edilmiş token kümesine
 *   indirilir ve çıktıya AYNEN YAZILMAZ (yalnızca queryTokens taşınır).
 *   rationale/reason alanları sabit şablonlardır; görev metni ve repo içi
 *   serbest metin hiçbir şablona interpolasyon edilmez (TŞ §15 prompt
 *   injection önlemi: repo kodundaki talimatlar sistem talimatı gibi
 *   gösterilmez).
 * - exact-symbol: görev tokenı, node'un terminal isim segmentinin
 *   camelCase/snake_case/kebab-case alt tokenlarıyla BİREBİR (case-insensitive,
 *   alt-dize eşleşmesi YOK) eşitse eşleşir. "orders" ≠ "order"; birebirlik
 *   böyledir.
 * - graph-proximity: exact seed'lerden her iki yönde bounded BFS; proximity
 *   skoru 1/(1+minDepth) (seed depth 0 → 1, depth 1 → 0.5). Keşif ayakları
 *   exact/proximity/contract/fts'tir; freshness keşif YAPMAZ, yalnızca sıralar.
 * - contract: contractSymbols kümesindeki qualifiedName'ler arasında terminal
 *   alt tokenları görev tokenlarıyla KESİŞEN node'lara 1 puan (kontrat ilgisi
 *   görevle ilişkili olmak zorundadır). Küme iki kaynaktan BİRLEŞİR:
 *   (a) çağıranın verdiği input.contractSymbols; (b) snapshot'ın SÖZLEŞME
 *   NODE YÜZEYİ (AGENT_CONTEXT_CONTRACT_NODE_KINDS türlerindeki node'ların
 *   qualifiedName'leri — D1/D2 sözleşme kayıtları grafiğe ingeste edildiğinde
 *   ayak KENDİ KENDİNİ dolar ve degradedLegs'ten çıkar; sprint-5 D7,
 *   K-013(7) sonrası). İki kaynak da boşsa ayak degradedLegs'te raporlanır,
 *   sonuç üretimine engel olmaz (degrade davranış korunur).
 * - freshness: node'un location.relativePath'i fileFreshness eşlemesinde varsa
 *   skor; distinct updatedAt değerleri leksik DESC rank'lenir ve skor
 *   (distinctCount - rank) / distinctCount olur (en yeni = 1; ISO-8601 tek tip
 *   biçim varsayımıyla leksik = kronolojik). Bu çekirdek saat OKUMAZ: mutlak
 *   "güncel/eski" yargısı yoktur, yalnızca adaylar arası göreli sıralama.
 * - fts: SymbolSearchStore (FTS5 gerçeklemesi) verilmişse görev metni depoya
 *   verilir (sorgu sözdizimi güvenliği depo sorumluluğudur); isabetler depo
 *   relevance sırasına göre 1/rank puan alır; snapshot'ta olmayan nodeId
 *   düşürülür ve rationale ile raporlanır.
 * - Sıralama: ayak sırasına göre leksik kompozit — (exact desc, proximity
 *   desc, contract desc, freshness desc, fts desc), tie-break kanonik
 *   [qualifiedName, kind, nodeId]. Erken ayak geç ayakı HER ZAMAN yener.
 * - tokenBudget: uygulanır bütçe = istek (tavan aşarsa tavana kırpılır +
 *   rationale; < 1 veya tam sayı değilse AÇIK REDDİ — 0 bütçe boş paket değil
 *   hatadır). Paket sıralı dolar: bir adayın estimatedTokens'u kalan bütçeye
 *   sığmazsa kesilir ve KALAN TÜM adaylar omittedCount'a yazılır.
 *   estimatedTokens açık formüldür: ceil(item JSON karakter sayısı / 4) —
 *   item'ın kendi estimatedTokens alanı formüle GİRMEZ; host tokenizer ile
 *   eşitlik iddiası yoktur (TŞ §15).
 * - Degrade davranış: mevcut olmayan ayaklar (contract/freshness/fts girdisi
 *   yok) atlanır ve degradedLegs listesinde {leg, reason} olarak raporlanır;
 *   asla hata fırlatmaz.
 * - Saf fonksiyon: saat okumaz, rastgelelik kullanmaz, girdi dizilerinin
 *   sırasına bağlı değildir (tüm komşuluklar ve çıktılar kanonik sıradadır).
 *   Aynı girdi iki koşumda bit-bit aynı JSON'u üretir.
 */

/** TŞ v2.1 §20 (Sayfa 22) resource budget tavanlarının GPS dilimi. */
export interface AgentContextAppliedLimits {
  /** Paket token bütçesi tavanı (estimatedTokens, chars/4). */
  readonly tokenBudget: number;
  /** graph-proximity BFS derinlik tavanı. */
  readonly maxProximityDepth: number;
}

export const AGENT_CONTEXT_LIMIT_CEILINGS: AgentContextAppliedLimits = {
  tokenBudget: 4096,
  maxProximityDepth: 4,
};

/** Verilmediğinde kullanılan varsayılanlar (tavanların altında). */
const DEFAULT_TOKEN_BUDGET = 2048;
const DEFAULT_PROXIMITY_DEPTH = 2;

/** graph-proximity BFS ayrık keşif tavanı (TŞ §20 maxNodes düzeni). */
const MAX_PROXIMITY_NODES = 250;

/** FTS arama çağrısı isabet tavanı. */
const MAX_FTS_HITS = 50;

/** Multi-token FTS fallback query cap (when full-phrase search returns 0 hits). */
const MAX_FTS_FALLBACK_TOKENS = 8;

/** Tek contextItem'ın taşıyacağı kanıt kimliği tavanı. */
const MAX_ITEM_EVIDENCE_IDS = 8;

/** Maximum character length scanned per identifier segment (matches symbol-tokens.ts O(n) guard). */
const MAX_IDENTIFIER_SCAN_CHARS = 4_096;

/** Maximum distinct query concepts evaluated per task (matches symbol-tokens.ts MAX_TOKENS). */
const MAX_QUERY_CONCEPTS = 64;

/** Root container kinds excluded from code localization & proximity BFS traversal. */
const PROXIMITY_EXCLUDED_NODE_KINDS: ReadonlySet<string> = new Set([
  "Workspace",
  "Repository",
]);

/** Query tokens indicating explicit interest in tests, specs, fixtures, or mocks. */
const TEST_INTENT_TOKENS: ReadonlySet<string> = new Set([
  "test",
  "tests",
  "spec",
  "specs",
  "fixture",
  "fixtures",
  "vitest",
  "jest",
  "mock",
]);

/** Concept-weight decay for 1-hop reverse-caller propagation from matched UnknownExternal nodes. */
const UNKNOWN_EXTERNAL_CALLER_PROPAGATION = 0.9;

/** Final-score priority multipliers favoring production source over test files & external stubs. */
const PRIORITY_MULTIPLIER_PRODUCTION = 1.0;
const PRIORITY_MULTIPLIER_TEST = 0.45;
const PRIORITY_MULTIPLIER_UNKNOWN_EXTERNAL = 0.35;

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Pure O(n) test-path detector (Windows + POSIX safe, zero regexes):
 * matches `test/` / `tests/` / `__tests__/` path segments or `*.test.*` / `*.spec.*` / `*.tests.*`
 * filenames without misclassifying production files like `packages/preflight/src/test-plan.ts`.
 */
function isTestPath(rawPath: string | undefined): boolean {
  if (rawPath === undefined || rawPath.length === 0) return false;
  const normalized = rawPath.replace(/\\/g, "/").toLowerCase();
  if (
    normalized.startsWith("test/") ||
    normalized.startsWith("tests/") ||
    normalized.startsWith("__tests__/") ||
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.includes("/__tests__/")
  ) {
    return true;
  }
  const lastSlash = normalized.lastIndexOf("/");
  const fileName = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const dotIdx = fileName.lastIndexOf(".");
  const stem = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
  return stem.endsWith(".test") || stem.endsWith(".spec") || stem.endsWith(".tests");
}

function isTestSourceNode(node: GraphNode): boolean {
  if (node.kind === "Test") return true;
  if (isTestPath(nodeIdentityRelativePath(node))) return true;
  return node.kind === "File" && isTestPath(node.qualifiedName);
}

function hasTestIntent(
  queryTokens: readonly string[],
  concepts: readonly QueryConcept[],
): boolean {
  if (queryTokens.some((token) => TEST_INTENT_TOKENS.has(token))) {
    return true;
  }
  return concepts.some((concept) =>
    concept.exactForms.some((form) => TEST_INTENT_TOKENS.has(form)),
  );
}

/**
 * Sözleşme node türleri (sprint-5 D7): contract ayakının SNAPSHOT
 * kaynağı — bu türlerdeki node'ların qualifiedName'leri contractSymbols
 * kümesine BİRLEŞİR (D1/D2 sözleşme kayıtları grafiğe geldiğinde ayak
 * otomatik dolar). Küme wiki projeksiyonundaki sözleşme yüzeyiyle
 * (packages/wiki projection.ts CONTRACT_NODE_KINDS) ve compare.ts
 * API_SURFACE sözleşme alt kümesiyle aynıdır (TŞ §8 kataloğu).
 */
export const AGENT_CONTEXT_CONTRACT_NODE_KINDS: readonly NodeKind[] = [
  "ApiContract",
  "EventContract",
  "SchemaContract",
  "ContractVersion",
];

const AGENT_CONTEXT_CONTRACT_NODE_KIND_SET: ReadonlySet<string> = new Set(
  AGENT_CONTEXT_CONTRACT_NODE_KINDS,
);

/** Sıralı ayak kimlikleri; LEG_ORDER sırası = öncelik sırası. */
export type AgentContextLeg =
  | "exact-symbol"
  | "graph-proximity"
  | "contract"
  | "freshness"
  | "fts";

const LEG_ORDER: readonly AgentContextLeg[] = [
  "exact-symbol",
  "graph-proximity",
  "contract",
  "freshness",
  "fts",
];

/** Dosya tazelik kaydı: çağıran envanterden (TŞ §9 files.updatedAt) taşınır. */
export interface FileFreshness {
  readonly relativePath: string;
  readonly updatedAt: string;
}

/**
 * Agent GPS girdisi (TŞ §10.2 task/candidateScope/tokenBudget çekirdek
 * karşılığı). "candidateScope" MCP yüzey parametresi çekirdeğe henüz
 * eklenmedi: aday evresi şimdilik tüm snapshot'tır; C8 araç kaydının
 * gerekçelendirmesi beklenir (onboarding "focus" kararının aynısı).
 */
export interface AgentContextInput {
  /** Görev metni = arama sorgusu (yalnızca arama verisi; çıktıya yazılmaz). */
  readonly task: string;
  /** Paket token bütçesi (estimatedTokens, chars/4). Varsayılan 2048. */
  readonly tokenBudget?: number;
  /** graph-proximity BFS derinliği. Varsayılan 2, tavan 4. */
  readonly maxProximityDepth?: number;
  /**
   * Kontrat yüzey sembolleri (açık girdi; opsiyonel). Snapshot'ın sözleşme
   * node yüzeyiyle (AGENT_CONTEXT_CONTRACT_NODE_KINDS) BİRLEŞİR — snapshot
   * kayıtları tek başına ayak açmaya yeter (sprint-5 D7). İki kaynak da
   * boşsa ayak atlanır (degradedLegs).
   */
  readonly contractSymbols?: readonly string[];
  /** symbol_fts deposu (SQLite gerçeklemesi; yoksa ayak atlanır). */
  readonly symbolSearch?: SymbolSearchStore;
  /** Dosya updatedAt eşlemesi (yoksa freshness ayakı atlanır). */
  readonly fileFreshness?: readonly FileFreshness[];
}

/** Ayak × skor tablosu; her aday için ayak başına katkı puanı. */
export interface AgentContextScores {
  readonly exact: number;
  readonly proximity: number;
  readonly contract: number;
  readonly freshness: number;
  readonly fts: number;
}

/** Atlanan (degrade) ayak + nedeni; hata değil, raporlanan eksiklik. */
export interface DegradedLeg {
  readonly leg: AgentContextLeg;
  readonly reason: string;
}

/**
 * Tek bağlam öğesi (TŞ §15 contextItems: dosya yolu, dar span, reason,
 * evidence). estimatedTokens = ceil(item JSON karakter sayısı / 4; alanın
 * kendisi ölçüme girmez).
 */
export interface AgentContextItem {
  readonly nodeId: string;
  readonly kind: GraphNode["kind"];
  readonly qualifiedName: string;
  readonly relativePath?: string;
  /** Dar span: node'un kaynak konumu (yalnızca satır aralığı). */
  readonly span?: { readonly startLine: number; readonly endLine: number };
  /** Katkı veren ayaklar; kanonik ayak (öncelik) sırasında. */
  readonly legs: readonly AgentContextLeg[];
  readonly scores: AgentContextScores;
  /** proximity BFS derinliği (seed 0); proximity katkısı yoksa yoktur. */
  readonly proximityDepth?: number;
  /** Açıklanabilirlik: parent kenar (veya seed için temas kenarları) kanıtları. */
  readonly evidenceIds: readonly string[];
  /** Sabit şablon gerekçe (görev metni asla interpole edilmez). */
  readonly reason: string;
  readonly estimatedTokens: number;
}

/** Agent GPS sonucu: paket + muhasebe (TŞ §10.2 "rationale, omissions"). */
export interface AgentContextResult {
  readonly snapshotId: string;
  readonly snapshotState: SnapshotGraph["meta"]["state"];
  /** Normalize edilmiş (lowercase, ayrıştırılmış) distinct sorgu tokenları. */
  readonly queryTokens: readonly string[];
  /** Uygulanan (clamp sonrası) token bütçesi. */
  readonly tokenBudget: number;
  /** Paket toplam estimatedTokens: dahil item'ların toplamı (chars/4). */
  readonly estimatedTokens: number;
  readonly contextItems: readonly AgentContextItem[];
  /** Bütçe yüzünden pakete alınamayan aday sayısı. */
  readonly omittedCount: number;
  /** Bütçe öncesi toplam aday sayısı. */
  readonly candidateCount: number;
  /** Girdisi verilen ve koşan ayaklar (kanonik sıra). */
  readonly legsApplied: readonly AgentContextLeg[];
  /** Girdisi verilmediği için atlanan ayaklar + nedeni (hata değil). */
  readonly degradedLegs: readonly DegradedLeg[];
  readonly rationales: readonly string[];
}

/** Aday başına dahili birikim; çıktı tipi değil, hesap ara yapısı. */
interface Candidate {
  readonly node: GraphNode;
  readonly scores: {
    exact: number;
    proximity: number;
    contract: number;
    freshness: number;
    fts: number;
  };
  readonly legs: Set<AgentContextLeg>;
  /** proximity BFS derinliği; undefined = BFS ile ulaşilmadı. */
  depth?: number;
  /** BFS'e giren kenarın kimliği (evidence kaynağı). */
  parentEdgeId?: string;
  /** LocAgent internal tie-breaking signals (never serialized onto public schema). */
  coverageRatio: number;
  identifierOrBasenameBoost: number;
  structuralImportance: number;
}

interface QueryConcept {
  readonly id: number;
  readonly meaningful: boolean;
  readonly exactForms: readonly string[];
  readonly stemmedForms: readonly string[];
}

interface NodeTokenProfile {
  readonly primaryExact: ReadonlySet<string>;
  readonly primaryStemmed: ReadonlySet<string>;
  readonly pathExact: ReadonlySet<string>;
  readonly pathStemmed: ReadonlySet<string>;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Kanonik tie-break: [qualifiedName, kind, nodeId]. */
function compareNodeKey(a: GraphNode, b: GraphNode): number {
  if (a.qualifiedName !== b.qualifiedName) {
    return a.qualifiedName < b.qualifiedName ? -1 : 1;
  }
  if (a.kind !== b.kind) {
    return a.kind < b.kind ? -1 : 1;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}

/**
 * Görev metnini arama token kümesine indirir: harf/rakam dışı her karakter
 * ayraçtır; lowercase (toLowerCase locale'siz deterministiktir); distinct ve
 * ilk-görülme sırasında döner.
 */
function tokenizeTask(task: string): string[] {
  const parts = task.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return [...new Set(parts.filter((part) => part.length > 0))];
}

function isAsciiUpper(code: number): boolean {
  return code >= 65 && code <= 90;
}

function isAsciiLower(code: number): boolean {
  return code >= 97 && code <= 122;
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/**
 * Pure O(n) exact (unstemmed, non-compound) camelCase/PascalCase/ACRONYM/Unicode
 * identifier splitter with zero regex backtracking.
 * - "HTTPServer" -> ["http", "server"]
 * - "XMLHttpRequest" -> ["xml", "http", "request"]
 * - "getURLPath" -> ["get", "url", "path"]
 * - "OrdersService" -> ["orders", "service"]
 * - "ORDER_STATUS" -> ["order", "status"]
 */
function splitExactIdentifierTokens(raw: string): string[] {
  const clipped =
    raw.length > MAX_IDENTIFIER_SCAN_CHARS
      ? raw.slice(0, MAX_IDENTIFIER_SCAN_CHARS)
      : raw;
  const runs = clipped.split(/[^\p{L}\p{N}]+/u);
  const out: string[] = [];
  for (const run of runs) {
    if (run.length === 0) continue;
    let start = 0;
    for (let i = 1; i < run.length; i += 1) {
      const prev = run.charCodeAt(i - 1);
      const curr = run.charCodeAt(i);
      const next = i + 1 < run.length ? run.charCodeAt(i + 1) : 0;
      const lowerToUpper =
        (isAsciiLower(prev) || isAsciiDigit(prev)) && isAsciiUpper(curr);
      const acronymSplit =
        isAsciiUpper(prev) && isAsciiUpper(curr) && isAsciiLower(next);
      if (lowerToUpper || acronymSplit) {
        out.push(run.slice(start, i).toLowerCase());
        start = i;
      }
    }
    out.push(run.slice(start).toLowerCase());
  }
  return out;
}

/**
 * Extracts normalized POSIX directory segments and extension-stripped basename
 * from any Windows or POSIX relative file path (never reduces `.ts` files to `"ts"`).
 */
function extractPathParts(rawPath: string): {
  readonly directories: string;
  readonly basename: string;
} {
  const normalized = rawPath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  const directories = lastSlash >= 0 ? normalized.slice(0, lastSlash) : "";
  const fileName = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const dotIndex = fileName.lastIndexOf(".");
  const basename = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  return { directories, basename };
}

/** qualifiedName'in terminal segmenti (non-File semboller): harf/rakam/alt-tire dışına böl, sonuncu. */
function terminalIdentifier(qualifiedName: string): string {
  const parts = qualifiedName
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? qualifiedName;
}

/**
 * Builds deduplicated query concepts from the raw task text using both exact
 * unstemmed tokens and LocAgent stemmed tokens from `tokenizeSymbolText`.
 */
function buildQueryConcepts(rawTask: string): {
  readonly concepts: readonly QueryConcept[];
  readonly meaningfulCount: number;
  readonly ftsFallbackTokens: readonly string[];
} {
  const rawWords = rawTask
    .split(/[^\p{L}\p{N}]+/u)
    .filter((part) => part.length > 0);
  const concepts: QueryConcept[] = [];
  const seenKeys = new Set<string>();
  let nextId = 0;

  for (const word of rawWords) {
    if (concepts.length >= MAX_QUERY_CONCEPTS) break;
    const exactParts = splitExactIdentifierTokens(word);
    for (const part of exactParts) {
      if (concepts.length >= MAX_QUERY_CONCEPTS) break;
      if (part.length === 0 || seenKeys.has(part)) continue;
      seenKeys.add(part);
      const stemmedMeaningful = tokenizeSymbolText(part, {
        stripStopWords: true,
        includeCompound: false,
      });
      const stemmedAll = tokenizeSymbolText(part, {
        stripStopWords: false,
        includeCompound: false,
      });
      const isStopWord = stemmedMeaningful.length === 0 && stemmedAll.length > 0;
      const meaningful = !isStopWord;
      const stemmedForms = meaningful ? stemmedMeaningful : stemmedAll;
      concepts.push({
        id: nextId,
        meaningful,
        exactForms: [part],
        stemmedForms: stemmedForms.length > 0 ? stemmedForms : [part],
      });
      nextId += 1;
    }
  }

  const meaningfulCount = concepts.reduce(
    (sum, c) => sum + (c.meaningful ? 1 : 0),
    0,
  );
  const ftsFallbackTokens = tokenizeSymbolText(rawTask, {
    stripStopWords: true,
    includeCompound: false,
  }).slice(0, MAX_FTS_FALLBACK_TOKENS);

  return { concepts, meaningfulCount, ftsFallbackTokens };
}

/**
 * Builds the LocAgent token profile for a graph node:
 * - `File` nodes tokenize full path directories AND extension-stripped basename
 *   (NEVER reduced to extension `"ts"`).
 * - Non-`File` symbols tokenize their own identifier as primary tokens and their
 *   `relativePath` (directories + basename) as corroborating path context.
 */
function buildNodeTokenProfile(node: GraphNode): NodeTokenProfile {
  const relPath = nodeIdentityRelativePath(node);
  if (node.kind === "File") {
    const filePath = relPath ?? node.qualifiedName;
    const { directories, basename } = extractPathParts(filePath);
    const primaryExact = new Set(splitExactIdentifierTokens(basename));
    const primaryStemmed = new Set(
      tokenizeSymbolText(basename, { stripStopWords: false, includeCompound: false }),
    );
    const pathExact = new Set(splitExactIdentifierTokens(directories));
    const pathStemmed = new Set(
      tokenizeSymbolText(directories, { stripStopWords: false, includeCompound: false }),
    );
    return { primaryExact, primaryStemmed, pathExact, pathStemmed };
  }

  const terminal = terminalIdentifier(node.qualifiedName);
  const primaryExact = new Set(splitExactIdentifierTokens(terminal));
  const primaryStemmed = new Set(
    tokenizeSymbolText(terminal, { stripStopWords: false, includeCompound: false }),
  );
  if (relPath === undefined) {
    return {
      primaryExact,
      primaryStemmed,
      pathExact: new Set(),
      pathStemmed: new Set(),
    };
  }
  const { directories, basename } = extractPathParts(relPath);
  const pathText = directories.length > 0 ? `${directories} ${basename}` : basename;
  const pathExact = new Set(splitExactIdentifierTokens(pathText));
  const pathStemmed = new Set(
    tokenizeSymbolText(pathText, { stripStopWords: false, includeCompound: false }),
  );
  return { primaryExact, primaryStemmed, pathExact, pathStemmed };
}

function invalidInput(message: string): GraphRepositoryError {
  return new GraphRepositoryError("graph/agent-context-invalid-input", message);
}

/** Girdi doğrulama + clamp: uygulanacak limitleri üretir, rationale yazar. */
function resolveLimits(
  input: AgentContextInput,
  rationales: string[],
): { tokenBudget: number; maxProximityDepth: number } {
  const tokenBudget = input.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  if (
    typeof tokenBudget !== "number" ||
    !Number.isInteger(tokenBudget) ||
    tokenBudget < 1
  ) {
    throw invalidInput(
      `tokenBudget must be a positive integer (0 and fractional values are rejected): ${String(tokenBudget)}`,
    );
  }
  const maxProximityDepth = input.maxProximityDepth ?? DEFAULT_PROXIMITY_DEPTH;
  if (
    typeof maxProximityDepth !== "number" ||
    !Number.isInteger(maxProximityDepth) ||
    maxProximityDepth < 1
  ) {
    throw invalidInput(
      `maxProximityDepth must be a positive integer: ${String(maxProximityDepth)}`,
    );
  }
  let appliedBudget = tokenBudget;
  let appliedDepth = maxProximityDepth;
  if (appliedBudget > AGENT_CONTEXT_LIMIT_CEILINGS.tokenBudget) {
    rationales.push(
      `tokenBudget=${String(tokenBudget)} exceeds the ceiling and was clamped to ${String(AGENT_CONTEXT_LIMIT_CEILINGS.tokenBudget)} (resource budget)`,
    );
    appliedBudget = AGENT_CONTEXT_LIMIT_CEILINGS.tokenBudget;
  }
  if (appliedDepth > AGENT_CONTEXT_LIMIT_CEILINGS.maxProximityDepth) {
    rationales.push(
      `maxProximityDepth=${String(maxProximityDepth)} exceeds the ceiling and was clamped to ${String(AGENT_CONTEXT_LIMIT_CEILINGS.maxProximityDepth)} (resource budget)`,
    );
    appliedDepth = AGENT_CONTEXT_LIMIT_CEILINGS.maxProximityDepth;
  }
  return { tokenBudget: appliedBudget, maxProximityDepth: appliedDepth };
}

/** Opsiyonel girdilerin çalışma zamanı şekil denetimi (JS çağıran koruması). */
function validateOptionalInputs(input: AgentContextInput): void {
  if (input.contractSymbols !== undefined) {
    if (!Array.isArray(input.contractSymbols)) {
      throw invalidInput("contractSymbols must be an array");
    }
    for (const symbol of input.contractSymbols) {
      if (typeof symbol !== "string") {
        throw invalidInput(
          `contractSymbols entries must be strings: ${String(symbol)}`,
        );
      }
    }
  }
  if (input.symbolSearch !== undefined) {
    if (
      input.symbolSearch === null ||
      typeof input.symbolSearch.searchSymbols !== "function"
    ) {
      throw invalidInput("symbolSearch must implement the SymbolSearchStore contract");
    }
  }
  if (input.fileFreshness !== undefined) {
    if (!Array.isArray(input.fileFreshness)) {
      throw invalidInput("fileFreshness must be an array");
    }
    for (const record of input.fileFreshness) {
      if (
        record === null ||
        typeof record !== "object" ||
        typeof record.relativePath !== "string" ||
        typeof record.updatedAt !== "string"
      ) {
        throw invalidInput(
          "fileFreshness entries must be {relativePath: string, updatedAt: string}",
        );
      }
    }
  }
}

/** BFS komşuluk girdisi: kenar kimliği + karşı uç. */
interface ProximityNeighbor {
  readonly edgeId: string;
  readonly other: string;
}

/**
 * Agent GPS bağlam paketini üretir: görev metnini arama sorgusu olarak
 * sıralı ayaklarla puanlar, bütçeye kadar paketler. Saf ve deterministiktir;
 * JSON'a serileştirilebilir.
 */
export function generateAgentContext(
  snapshot: SnapshotGraph,
  input: AgentContextInput,
): AgentContextResult {
  // 1) Girdi sözleşmesi: görev metni zorunlu ve boş olmayan arama verisidir.
  if (typeof input.task !== "string" || input.task.trim().length === 0) {
    throw invalidInput("task must be a non-empty task description (it is used as the search query)");
  }
  validateOptionalInputs(input);

  // 2) Snapshot durumu: yalnızca yayımlanabilir snapshot işlenir (kardeş
  //    analyzeImpact/generateOnboarding ile aynı koruma; building okuma
  //    yollarında görünmez, failed yayın akışına girmez).
  const state = snapshot.meta.state;
  if (state !== "ready" && state !== "partial") {
    throw new GraphRepositoryError(
      "graph/agent-context-snapshot-state",
      `agent context only runs on a ready or partial snapshot; snapshot state: ${String(state)}`,
    );
  }

  const rationales: string[] = [];
  const { tokenBudget, maxProximityDepth } = resolveLimits(input, rationales);
  const queryTokens = tokenizeTask(input.task);

  // 3) Ayak uygunluğu: girdisi olmayan ayaklar degrade edilir (hata değil).
  const degradedLegs: DegradedLeg[] = [];
  // contract ayakının girdisi İKİ kaynağın BİRLEŞİMİDİR (sprint-5 D7):
  // (a) açık input.contractSymbols, (b) snapshot'ın sözleşme node yüzeyi.
  // Yüzey türetimi kanoniktir: node türüne göre seçim + qualifiedName'e
  // göre sıralı-tekrarsız (girdi dizi sırasından bağımsızlık).
  const snapshotContractSymbols = [...new Set(
    snapshot.nodes
      .filter((node) => AGENT_CONTEXT_CONTRACT_NODE_KIND_SET.has(node.kind))
      .map((node) => node.qualifiedName),
  )].sort(cmp);
  const contractProvided =
    (input.contractSymbols !== undefined && input.contractSymbols.length > 0) ||
    snapshotContractSymbols.length > 0;
  const freshnessProvided =
    input.fileFreshness !== undefined && input.fileFreshness.length > 0;
  const ftsProvided = input.symbolSearch !== undefined;
  if (!contractProvided) {
    degradedLegs.push({
      leg: "contract",
      reason:
        "contract leg skipped: the snapshot has no contract records (the ApiContract/EventContract/SchemaContract/ContractVersion surface is empty) and no contractSymbols were given (this is not an error)",
    });
  }
  if (!freshnessProvided) {
    degradedLegs.push({
      leg: "freshness",
      reason:
        "freshness leg skipped: no fileFreshness was given (no per-file updatedAt mapping)",
    });
  }
  if (!ftsProvided) {
    degradedLegs.push({
      leg: "fts",
      reason:
        "fts leg skipped: no symbolSearch store was given (symbol_fts unavailable)",
    });
  }
  const legsApplied: AgentContextLeg[] = LEG_ORDER.filter((leg) => {
    if (leg === "contract") return contractProvided;
    if (leg === "freshness") return freshnessProvided;
    if (leg === "fts") return ftsProvided;
    return true; // exact-symbol ve graph-proximity çekirdek ayaklardır.
  });

  if (queryTokens.length === 0) {
    rationales.push(
      "the task text produced no search tokens; no leg can match an empty query set",
    );
  }

  // 4) Node/edge indexes + structural importance (non-CONTAINS degree, canonical order).
  const nodesById = new Map<string, GraphNode>();
  for (const node of snapshot.nodes) nodesById.set(node.id, node);
  const sortedNodes = [...snapshot.nodes].sort(compareNodeKey);
  const sortedEdges = [...snapshot.edges].sort((a, b) => cmp(a.id, b.id));

  const evidenceByEdgeId = new Map<string, readonly string[]>();
  const incidentEvidence = new Map<string, string[]>();
  const nonContainsInDegree = new Map<string, number>();
  const nonContainsOutDegree = new Map<string, number>();
  const directContainedByFile = new Map<string, string[]>();
  const containingFileIdByNodeId = new Map<string, string>();
  const fileNodeByPath = new Map<string, GraphNode>();
  const incomingCallsToExternal = new Map<string, string[]>();

  for (const node of sortedNodes) {
    if (node.kind !== "File") continue;
    const rel = nodeIdentityRelativePath(node) ?? node.qualifiedName;
    fileNodeByPath.set(rel.replace(/\\/g, "/"), node);
  }

  for (const edge of sortedEdges) {
    evidenceByEdgeId.set(edge.id, edge.evidenceIds);
    for (const endpointId of [edge.from, edge.to]) {
      const list = incidentEvidence.get(endpointId) ?? [];
      list.push(...edge.evidenceIds);
      incidentEvidence.set(endpointId, list);
    }
    if (edge.kind === "CONTAINS") {
      const fromNode = nodesById.get(edge.from);
      const toNode = nodesById.get(edge.to);
      if (
        fromNode?.kind === "File" &&
        toNode !== undefined &&
        !PROXIMITY_EXCLUDED_NODE_KINDS.has(toNode.kind) &&
        toNode.kind !== "File"
      ) {
        const list = directContainedByFile.get(fromNode.id);
        if (list === undefined) {
          directContainedByFile.set(fromNode.id, [toNode.id]);
        } else {
          list.push(toNode.id);
        }
        if (!containingFileIdByNodeId.has(toNode.id)) {
          containingFileIdByNodeId.set(toNode.id, fromNode.id);
        }
      }
      continue;
    }
    if (edge.kind === "CALLS") {
      const toNode = nodesById.get(edge.to);
      if (toNode?.kind === "UnknownExternal") {
        const callers = incomingCallsToExternal.get(toNode.id);
        if (callers === undefined) {
          incomingCallsToExternal.set(toNode.id, [edge.from]);
        } else {
          callers.push(edge.from);
        }
      }
    }
    nonContainsOutDegree.set(edge.from, (nonContainsOutDegree.get(edge.from) ?? 0) + 1);
    nonContainsInDegree.set(edge.to, (nonContainsInDegree.get(edge.to) ?? 0) + 1);
  }

  const structuralImportanceByNodeId = new Map<string, number>();
  for (const node of sortedNodes) {
    let inDeg = nonContainsInDegree.get(node.id) ?? 0;
    const outDeg = nonContainsOutDegree.get(node.id) ?? 0;
    if (node.kind === "File") {
      for (const childId of directContainedByFile.get(node.id) ?? []) {
        inDeg += 0.5 * (nonContainsInDegree.get(childId) ?? 0);
      }
    }
    structuralImportanceByNodeId.set(node.id, Math.log1p(inDeg * 2 + outDeg));
  }

  const candidates = new Map<string, Candidate>();
  const getCandidate = (node: GraphNode): Candidate => {
    const existing = candidates.get(node.id);
    if (existing !== undefined) return existing;
    const created: Candidate = {
      node,
      scores: { exact: 0, proximity: 0, contract: 0, freshness: 0, fts: 0 },
      legs: new Set<AgentContextLeg>(),
      coverageRatio: 0,
      identifierOrBasenameBoost: 0,
      structuralImportance: structuralImportanceByNodeId.get(node.id) ?? 0,
    };
    candidates.set(node.id, created);
    return created;
  };

  // 5) exact-symbol & LocAgent lexical localization leg:
  //    Full path + basename + camelCase/acronym tokenization (never reduces `.ts` to `"ts"`),
  //    multi-token concept coverage, exact basename/identifier boost, and 1-hop File rollup.
  const { concepts, meaningfulCount, ftsFallbackTokens } = buildQueryConcepts(input.task);
  const conceptDenominator = meaningfulCount > 0 ? meaningfulCount : concepts.length;
  const profilesByNodeId = new Map<string, NodeTokenProfile>();
  for (const node of sortedNodes) {
    profilesByNodeId.set(node.id, buildNodeTokenProfile(node));
  }

  // Per-node concept match weight map (0.5 = path/dir or child rollup, 1.0 = primary symbol/basename)
  const matchedConceptWeightsByNodeId = new Map<string, Map<number, number>>();
  const primaryMatchedConceptsByNodeId = new Map<string, Set<number>>();

  const matchesAny = (
    tokenSet: ReadonlySet<string>,
    forms: readonly string[],
  ): boolean => {
    for (const form of forms) {
      if (tokenSet.has(form)) return true;
    }
    return false;
  };

  if (concepts.length > 0) {
    interface NodeLexicalEval {
      readonly node: GraphNode;
      readonly exactPrimary: Set<number>;
      readonly exactPath: Set<number>;
      readonly stemmedPrimary: Set<number>;
      readonly stemmedPath: Set<number>;
      readonly meaningfulExactPrimary: number;
      readonly meaningfulExactPath: number;
      readonly meaningfulStemmedPrimary: number;
      readonly meaningfulStemmedPath: number;
    }

    const evals: NodeLexicalEval[] = [];
    let exactSeedCount = 0;

    for (const node of sortedNodes) {
      if (PROXIMITY_EXCLUDED_NODE_KINDS.has(node.kind)) continue;
      const profile = profilesByNodeId.get(node.id);
      if (profile === undefined) continue;

      const exactPrimary = new Set<number>();
      const exactPath = new Set<number>();
      const stemmedPrimary = new Set<number>();
      const stemmedPath = new Set<number>();
      let meaningfulExactPrimary = 0;
      let meaningfulExactPath = 0;
      let meaningfulStemmedPrimary = 0;
      let meaningfulStemmedPath = 0;

      for (const concept of concepts) {
        if (matchesAny(profile.primaryExact, concept.exactForms)) {
          exactPrimary.add(concept.id);
          if (concept.meaningful) meaningfulExactPrimary += 1;
          continue;
        }
        if (matchesAny(profile.pathExact, concept.exactForms)) {
          exactPath.add(concept.id);
          if (concept.meaningful) meaningfulExactPath += 1;
        }
        if (concept.meaningful && matchesAny(profile.primaryStemmed, concept.stemmedForms)) {
          stemmedPrimary.add(concept.id);
          meaningfulStemmedPrimary += 1;
          continue;
        }
        if (
          concept.meaningful &&
          !exactPath.has(concept.id) &&
          matchesAny(profile.pathStemmed, concept.stemmedForms)
        ) {
          stemmedPath.add(concept.id);
          meaningfulStemmedPath += 1;
        }
      }

      const qualifiesExact =
        node.kind === "File"
          ? meaningfulCount > 0
            ? meaningfulExactPrimary + meaningfulExactPath > 0
            : exactPrimary.size + exactPath.size > 0
          : meaningfulCount > 0
            ? meaningfulExactPrimary > 0
            : exactPrimary.size > 0;

      if (qualifiesExact) {
        exactSeedCount += 1;
      }

      evals.push({
        node,
        exactPrimary,
        exactPath,
        stemmedPrimary,
        stemmedPath,
        meaningfulExactPrimary,
        meaningfulExactPath,
        meaningfulStemmedPrimary,
        meaningfulStemmedPath,
      });
    }

    for (const ev of evals) {
      const isFile = ev.node.kind === "File";
      const qualifiesExact = isFile
        ? meaningfulCount > 0
          ? ev.meaningfulExactPrimary + ev.meaningfulExactPath > 0
          : ev.exactPrimary.size + ev.exactPath.size > 0
        : meaningfulCount > 0
          ? ev.meaningfulExactPrimary > 0
          : ev.exactPrimary.size > 0;

      const stemmedPrimaryHits = ev.meaningfulStemmedPrimary;
      const pathHits = ev.meaningfulExactPath + ev.meaningfulStemmedPath;
      const qualifiesStemmed =
        stemmedPrimaryHits >= 2 ||
        (stemmedPrimaryHits >= 1 && pathHits >= 1) ||
        (exactSeedCount === 0 && (stemmedPrimaryHits >= 1 || (isFile && ev.meaningfulStemmedPath >= 1)));

      if (!qualifiesExact && !qualifiesStemmed) continue;

      const weights = new Map<number, number>();
      const primarySet = new Set<number>();

      // Primary symbol / basename matches always earn 1.0 per matched concept.
      for (const cid of ev.exactPrimary) {
        weights.set(cid, 1);
        primarySet.add(cid);
      }
      for (const cid of ev.stemmedPrimary) {
        if (!weights.has(cid)) {
          weights.set(cid, 1);
          primarySet.add(cid);
        }
      }

      // Directory / path context earns 0.5 for concepts not already matched in primary identifier.
      const allowPathBonus = isFile || primarySet.size > 0;
      if (allowPathBonus) {
        for (const cid of ev.exactPath) {
          if (!weights.has(cid)) {
            weights.set(cid, 0.5);
          }
        }
        for (const cid of ev.stemmedPath) {
          if (!weights.has(cid)) {
            weights.set(cid, 0.5);
          }
        }
      }

      if (weights.size === 0) continue;

      let totalScore = 0;
      let meaningfulMatched = 0;
      for (const [cid, w] of weights) {
        totalScore += w;
        const concept = concepts[cid];
        if (concept !== undefined && (meaningfulCount === 0 || concept.meaningful)) {
          meaningfulMatched += 1;
        }
      }

      matchedConceptWeightsByNodeId.set(ev.node.id, weights);
      primaryMatchedConceptsByNodeId.set(ev.node.id, primarySet);

      const candidate = getCandidate(ev.node);
      candidate.scores.exact = totalScore;
      candidate.identifierOrBasenameBoost = primarySet.size;
      candidate.coverageRatio =
        conceptDenominator > 0 ? meaningfulMatched / conceptDenominator : 0;
      candidate.legs.add("exact-symbol");
    }

    // 1-hop File --CONTAINS--> Symbol concept rollup: a File defining matched symbols
    // inherits concept coverage so file-level localization (e.g., server.ts) ranks cleanly
    // above directory-only distractors even when the file's own basename doesn't repeat
    // every symbol token.
    for (const [fileId, childIds] of directContainedByFile) {
      const fileNode = nodesById.get(fileId);
      if (fileNode === undefined) continue;
      const childPrimaryConcepts = new Set<number>();
      for (const childId of childIds) {
        const childPrimary = primaryMatchedConceptsByNodeId.get(childId);
        if (childPrimary === undefined) continue;
        for (const cid of childPrimary) childPrimaryConcepts.add(cid);
      }
      if (childPrimaryConcepts.size === 0) continue;

      const existingWeights =
        matchedConceptWeightsByNodeId.get(fileId) ?? new Map<number, number>();
      let changed = false;
      for (const cid of childPrimaryConcepts) {
        const prev = existingWeights.get(cid);
        if (prev === undefined) {
          existingWeights.set(cid, 0.5);
          changed = true;
        } else if (prev < 0.75) {
          // Upgrade directory-only 0.5 match to 0.75 when a declared symbol inside this file
          // literally matches the concept in its identifier!
          existingWeights.set(cid, 0.75);
          changed = true;
        }
      }
      if (!changed) continue;

      matchedConceptWeightsByNodeId.set(fileId, existingWeights);
      let totalScore = 0;
      let meaningfulMatched = 0;
      for (const [cid, w] of existingWeights) {
        totalScore += w;
        const concept = concepts[cid];
        if (concept !== undefined && (meaningfulCount === 0 || concept.meaningful)) {
          meaningfulMatched += 1;
        }
      }
      const candidate = getCandidate(fileNode);
      candidate.scores.exact = totalScore;
      candidate.coverageRatio =
        conceptDenominator > 0 ? meaningfulMatched / conceptDenominator : 0;
      candidate.legs.add("exact-symbol");
    }

    // 1-hop reverse-caller propagation from matched UnknownExternal nodes:
    // when a query matches an external API call (e.g. `McpServer.registerTool`),
    // propagate its matched concept weights (scaled by 0.9) 1 hop backward along
    // incoming CALLS edges to production callers and their containing File.
    const mergePropagatedWeights = (
      targetNode: GraphNode,
      sourceWeights: ReadonlyMap<number, number>,
    ): void => {
      const existingWeights =
        matchedConceptWeightsByNodeId.get(targetNode.id) ?? new Map<number, number>();
      let changed = false;
      for (const [cid, w] of sourceWeights) {
        const propagated = roundScore(w * UNKNOWN_EXTERNAL_CALLER_PROPAGATION);
        const prev = existingWeights.get(cid);
        if (prev === undefined || prev < propagated) {
          existingWeights.set(cid, propagated);
          changed = true;
        }
      }
      if (!changed) return;

      matchedConceptWeightsByNodeId.set(targetNode.id, existingWeights);
      let totalScore = 0;
      let meaningfulMatched = 0;
      for (const [cid, w] of existingWeights) {
        totalScore += w;
        const concept = concepts[cid];
        if (concept !== undefined && (meaningfulCount === 0 || concept.meaningful)) {
          meaningfulMatched += 1;
        }
      }
      const candidate = getCandidate(targetNode);
      candidate.scores.exact = roundScore(totalScore);
      candidate.coverageRatio =
        conceptDenominator > 0 ? meaningfulMatched / conceptDenominator : 0;
      candidate.legs.add("exact-symbol");
    };

    for (const node of sortedNodes) {
      if (node.kind !== "UnknownExternal") continue;
      const extWeights = matchedConceptWeightsByNodeId.get(node.id);
      if (extWeights === undefined || extWeights.size === 0) continue;
      const callerIds = incomingCallsToExternal.get(node.id);
      if (callerIds === undefined) continue;
      for (const callerId of callerIds) {
        const callerNode = nodesById.get(callerId);
        if (
          callerNode === undefined ||
          PROXIMITY_EXCLUDED_NODE_KINDS.has(callerNode.kind) ||
          callerNode.kind === "UnknownExternal" ||
          isTestSourceNode(callerNode)
        ) {
          continue;
        }
        mergePropagatedWeights(callerNode, extWeights);
        const containingFileId = containingFileIdByNodeId.get(callerNode.id);
        const callerRel = nodeIdentityRelativePath(callerNode);
        const fileNode =
          (containingFileId !== undefined ? nodesById.get(containingFileId) : undefined) ??
          (callerRel !== undefined
            ? fileNodeByPath.get(callerRel.replace(/\\/g, "/"))
            : undefined);
        if (
          fileNode !== undefined &&
          fileNode.id !== callerNode.id &&
          !isTestSourceNode(fileNode)
        ) {
          mergePropagatedWeights(fileNode, extWeights);
        }
      }
    }
  }

  // 6) graph-proximity leg: bounded BFS from lexical seeds.
  //    Excludes Workspace/Repository hubs AND reverse CONTAINS upward hops so unrelated
  //    sibling files can never flood top-K via 2-hop `File <- Workspace -> OtherFile`.
  const adjacency = new Map<string, ProximityNeighbor[]>();
  for (const node of sortedNodes) adjacency.set(node.id, []);
  for (const edge of sortedEdges) {
    const fromNode = nodesById.get(edge.from);
    const toNode = nodesById.get(edge.to);
    if (fromNode === undefined || toNode === undefined) continue;
    if (
      PROXIMITY_EXCLUDED_NODE_KINDS.has(fromNode.kind) ||
      PROXIMITY_EXCLUDED_NODE_KINDS.has(toNode.kind)
    ) {
      continue;
    }
    if (edge.kind === "CONTAINS") {
      // Forward CONTAINS (e.g., File -> Symbol, Class -> Method) stays traversable from
      // a matched container; upward reverse CONTAINS (Symbol/File -> Container) is excluded.
      adjacency.get(edge.from)?.push({ edgeId: edge.id, other: edge.to });
      continue;
    }
    adjacency.get(edge.from)?.push({ edgeId: edge.id, other: edge.to });
    adjacency.get(edge.to)?.push({ edgeId: edge.id, other: edge.from });
  }
  for (const neighbors of adjacency.values()) {
    neighbors.sort((a, b) => cmp(a.edgeId, b.edgeId));
  }
  const seeds = sortedNodes.filter((node) => candidates.has(node.id));
  const proximityTruncated = runProximityBfs(
    seeds,
    adjacency,
    nodesById,
    maxProximityDepth,
    getCandidate,
  );
  if (proximityTruncated) {
    rationales.push(
      `graph-proximity ceiling reached: exploration was limited to ${String(MAX_PROXIMITY_NODES)} nodes (resource budget)`,
    );
  }

  // 7) contract ayakı: kontrat yüzeyinde görev tokenlarıyla kesişen semboller.
  //    Küme = açık girdi ∪ snapshot sözleşme yüzeyi (kanonik birleşim).
  if (contractProvided) {
    const contractSet = new Set<string>([
      ...(input.contractSymbols ?? []),
      ...snapshotContractSymbols,
    ]);
    if (queryTokens.length === 0) {
      rationales.push(
        "contract: an empty query set cannot intersect any contract (leg ran, no contribution)",
      );
    }
    for (const node of sortedNodes) {
      if (!contractSet.has(node.qualifiedName)) continue;
      const profile = profilesByNodeId.get(node.id);
      if (profile === undefined) continue;
      const intersects = queryTokens.some((token) => profile.primaryExact.has(token));
      if (!intersects) continue;
      const candidate = getCandidate(node);
      candidate.scores.contract = 1;
      candidate.legs.add("contract");
    }
  }

  // 8) fts ayakı: SymbolSearchStore sorgusu, depo relevance sırasıyla.
  //    Falls back to bounded per-token queries when full-prose search returns 0 hits
  //    (e.g., backing store uses exact-phrase matching) and aggregates multi-token hits.
  if (ftsProvided && input.symbolSearch !== undefined) {
    if (queryTokens.length === 0) {
      rationales.push(
        "fts: the store was not queried for an empty query set (leg ran, no contribution)",
      );
    } else {
      const primaryHits = input.symbolSearch.searchSymbols(
        input.task,
        MAX_FTS_HITS,
        snapshot.meta.id,
      );
      let droppedUnknown = 0;

      if (primaryHits.length > 0 || ftsFallbackTokens.length <= 1) {
        const seen = new Set<string>();
        let rank = 0;
        for (const hit of primaryHits) {
          if (seen.has(hit.nodeId)) continue;
          seen.add(hit.nodeId);
          const node = nodesById.get(hit.nodeId);
          if (node === undefined) {
            droppedUnknown += 1;
            continue;
          }
          if (PROXIMITY_EXCLUDED_NODE_KINDS.has(node.kind)) continue;
          rank += 1;
          const candidate = getCandidate(node);
          // Depo sırası relevance sırasıdır: ilk isabet en güçlü (1/rank).
          if (candidate.scores.fts < 1 / rank) candidate.scores.fts = 1 / rank;
          candidate.legs.add("fts");
        }
      } else {
        // Multi-token fallback for natural-language queries on phrase-only stores.
        const perTokenLimit = Math.min(20, MAX_FTS_HITS);
        const aggregated = new Map<
          string,
          { node: GraphNode; matchedQueries: number; bestRank: number }
        >();
        const unknownIds = new Set<string>();
        for (const token of ftsFallbackTokens) {
          const tokenHits: readonly SymbolSearchHit[] =
            input.symbolSearch.searchSymbols(token, perTokenLimit, snapshot.meta.id);
          const seenInToken = new Set<string>();
          let rank = 0;
          for (const hit of tokenHits) {
            if (seenInToken.has(hit.nodeId)) continue;
            seenInToken.add(hit.nodeId);
            const node = nodesById.get(hit.nodeId);
            if (node === undefined) {
              unknownIds.add(hit.nodeId);
              continue;
            }
            if (PROXIMITY_EXCLUDED_NODE_KINDS.has(node.kind)) continue;
            rank += 1;
            const prev = aggregated.get(node.id);
            if (prev === undefined) {
              aggregated.set(node.id, { node, matchedQueries: 1, bestRank: rank });
            } else {
              prev.matchedQueries += 1;
              if (rank < prev.bestRank) prev.bestRank = rank;
            }
          }
        }
        droppedUnknown = unknownIds.size;
        for (const entry of aggregated.values()) {
          const candidate = getCandidate(entry.node);
          const coverageComponent = entry.matchedQueries / ftsFallbackTokens.length;
          const rankComponent = 1 / entry.bestRank;
          const ftsScore = coverageComponent * 0.8 + rankComponent * 0.2;
          if (candidate.scores.fts < ftsScore) candidate.scores.fts = ftsScore;
          candidate.legs.add("fts");
        }
      }

      if (droppedUnknown > 0) {
        rationales.push(
          `fts: dropped ${String(droppedUnknown)} hit(s) whose nodeId is not in the snapshot`,
        );
      }
    }
  }

  // 9) freshness ayakı: göreli tazelik skoru (keşif yapmaz, yalnızca sıralar).
  if (freshnessProvided && input.fileFreshness !== undefined) {
    // Aynı relativePath iki kez verildiyse leksik en büyük (en yeni) kazanır.
    const fileUpdatedAt = new Map<string, string>();
    for (const record of input.fileFreshness) {
      if (record.relativePath.length === 0 || record.updatedAt.length === 0) {
        continue; // boş kayıtlar yok sayılır (belgelenmiş davranış)
      }
      const existing = fileUpdatedAt.get(record.relativePath);
      if (existing === undefined || cmp(record.updatedAt, existing) > 0) {
        fileUpdatedAt.set(record.relativePath, record.updatedAt);
      }
    }
    // Distinct timestamp'ler leksik DESC (ISO-8601 tek tip biçim varsayımı:
    // leksik = kronolojik). Çekirdek saat okumaz; göreli sıralama yeter.
    const distinct = [...new Set(fileUpdatedAt.values())].sort(cmp).reverse();
    const scoreOfTimestamp = new Map<string, number>();
    distinct.forEach((timestamp, index) => {
      scoreOfTimestamp.set(
        timestamp,
        (distinct.length - index) / distinct.length,
      );
    });
    for (const node of sortedNodes) {
      const relativePath = nodeIdentityRelativePath(node);
      if (relativePath === undefined) continue;
      const updatedAt = fileUpdatedAt.get(relativePath);
      if (updatedAt === undefined) continue;
      const score = scoreOfTimestamp.get(updatedAt);
      if (score === undefined) continue;
      // freshness keşif yapmaz: yalnızca keşif ayaklarının açtığı adaylara
      // katkı yazar (aksi halde her taze dosya her sorguya aday olurdu).
      const candidate = candidates.get(node.id);
      if (candidate === undefined) continue;
      candidate.scores.freshness = score;
      candidate.legs.add("freshness");
    }
  }

  // 10) Production-source priority multiplier & sıralama:
  //     When the query does not explicitly ask about tests, prioritize production
  //     source nodes (1.0) over test files/nodes (0.45) and UnknownExternal stubs (0.35).
  const queryMentionsTests = hasTestIntent(queryTokens, concepts);
  for (const candidate of candidates.values()) {
    const multiplier =
      candidate.node.kind === "UnknownExternal"
        ? PRIORITY_MULTIPLIER_UNKNOWN_EXTERNAL
        : !queryMentionsTests && isTestSourceNode(candidate.node)
          ? PRIORITY_MULTIPLIER_TEST
          : PRIORITY_MULTIPLIER_PRODUCTION;
    if (multiplier !== 1) {
      candidate.scores.exact = roundScore(candidate.scores.exact * multiplier);
      candidate.scores.proximity = roundScore(candidate.scores.proximity * multiplier);
      candidate.scores.contract = roundScore(candidate.scores.contract * multiplier);
      candidate.scores.freshness = roundScore(candidate.scores.freshness * multiplier);
      candidate.scores.fts = roundScore(candidate.scores.fts * multiplier);
    }
  }

  // Sıralama: ayak sırasına göre leksik kompozit + LocAgent relevance/structural tie-breakers + kanonik fallback.
  const ranked = [...candidates.values()].sort((a, b) => {
    const byScores =
      b.scores.exact - a.scores.exact ||
      b.scores.proximity - a.scores.proximity ||
      b.scores.contract - a.scores.contract ||
      b.scores.freshness - a.scores.freshness ||
      b.scores.fts - a.scores.fts;
    if (byScores !== 0) return byScores;
    const byLocAgent =
      b.coverageRatio - a.coverageRatio ||
      b.identifierOrBasenameBoost - a.identifierOrBasenameBoost ||
      b.structuralImportance - a.structuralImportance;
    if (byLocAgent !== 0) return byLocAgent;
    return compareNodeKey(a.node, b.node);
  });

  if (ranked.length === 0) {
    rationales.push(
      `the ${String(queryTokens.length)} task token(s) produced no candidates in any leg; returning an empty context`,
    );
  }

  // 11) Paketleme: bütçe sıralı dolar; ilk sığmayan adayda kesilir ve kalan
  //     adayların tamamı omittedCount'a yazılır. estimatedTokens açık formül:
  //     ceil(item JSON karakter sayısı / 4) — alanın kendisi ölçüme girmez
  //     (TŞ §15: host tokenizer ile kesin eşitlik iddiası yoktur).
  const contextItems: AgentContextItem[] = [];
  let totalEstimatedTokens = 0;
  let omittedCount = 0;
  for (const candidate of ranked) {
    const item = buildItem(candidate, evidenceByEdgeId, incidentEvidence);
    if (totalEstimatedTokens + item.estimatedTokens <= tokenBudget) {
      contextItems.push(item);
      totalEstimatedTokens += item.estimatedTokens;
    } else {
      omittedCount = ranked.length - contextItems.length;
      rationales.push(
        `tokenBudget exhausted: ${String(omittedCount)} candidate(s) left out of the package (applied budget ${String(tokenBudget)})`,
      );
      break;
    }
  }

  return {
    snapshotId: snapshot.meta.id,
    snapshotState: state,
    queryTokens,
    tokenBudget,
    estimatedTokens: totalEstimatedTokens,
    contextItems,
    omittedCount,
    candidateCount: ranked.length,
    legsApplied,
    degradedLegs,
    rationales,
  };
}

/**
 * Bütçeli BFS: exact seed'lerden her iki yönde, depth ve ayrık keşif tavanlı.
 * Dönüş: keşif tavanı vurulduysa true. Komşuluklar edge.id kanonik düzeninde
 * taranır; seed'ler kanonik node sırasıyla kuyruğa girer → deterministik.
 */
function runProximityBfs(
  seeds: readonly GraphNode[],
  adjacency: ReadonlyMap<string, readonly ProximityNeighbor[]>,
  nodesById: ReadonlyMap<string, GraphNode>,
  maxDepth: number,
  getCandidate: (node: GraphNode) => Candidate,
): boolean {
  const visited = new Set<string>();
  for (const seed of seeds) {
    visited.add(seed.id);
    const candidate = getCandidate(seed);
    candidate.scores.proximity = 1; // depth 0 → 1/(1+0)
    candidate.legs.add("graph-proximity");
    candidate.depth = 0;
  }
  const queue: { id: string; depth: number; parentEdgeId: string }[] = [];
  for (const seed of seeds) {
    queue.push({ id: seed.id, depth: 0, parentEdgeId: "" });
  }
  let head = 0;
  let discovered = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    if (current === undefined) break;
    if (current.depth >= maxDepth) continue;
    for (const neighbor of adjacency.get(current.id) ?? []) {
      if (visited.has(neighbor.other)) continue;
      if (discovered >= MAX_PROXIMITY_NODES) return true;
      visited.add(neighbor.other);
      discovered += 1;
      const targetNode = nodesById.get(neighbor.other);
      if (targetNode === undefined) continue; // savunma: dangling kurucuda engelli
      const depth = current.depth + 1;
      const candidate = getCandidate(targetNode);
      candidate.scores.proximity = 1 / (1 + depth);
      candidate.legs.add("graph-proximity");
      candidate.depth = depth;
      candidate.parentEdgeId = neighbor.edgeId;
      queue.push({ id: neighbor.other, depth, parentEdgeId: neighbor.edgeId });
    }
  }
  return false;
}

/** Item inşası: alan sırası çıktı JSON determinizmini sabitler. */
function buildItem(
  candidate: Candidate,
  evidenceByEdgeId: ReadonlyMap<string, readonly string[]>,
  incidentEvidence: ReadonlyMap<string, readonly string[]>,
): AgentContextItem {
  const node = candidate.node;
  const relativePath = nodeIdentityRelativePath(node);
  const location = node.location;
  const legs: AgentContextLeg[] = LEG_ORDER.filter((leg) =>
    candidate.legs.has(leg),
  );
  const evidenceIds = resolveEvidenceIds(
    candidate,
    evidenceByEdgeId,
    incidentEvidence,
  );
  const reason = resolveReason(candidate);
  const body: Omit<AgentContextItem, "estimatedTokens"> = {
    nodeId: node.id,
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    ...(relativePath === undefined ? {} : { relativePath }),
    ...(location === undefined
      ? {}
      : { span: { startLine: location.startLine, endLine: location.endLine } }),
    legs,
    scores: {
      exact: candidate.scores.exact,
      proximity: candidate.scores.proximity,
      contract: candidate.scores.contract,
      freshness: candidate.scores.freshness,
      fts: candidate.scores.fts,
    },
    ...(candidate.depth === undefined
      ? {}
      : { proximityDepth: candidate.depth }),
    evidenceIds,
    reason,
  };
  return {
    ...body,
    estimatedTokens: Math.ceil(JSON.stringify(body).length / 4),
  };
}

/**
 * Kanıt kaynağı: BFS parent kenarı; seed/pathsiz aday için temas kenarları.
 * Karar (denetim bulgusu 4): dizi BOŞ OLABİLİR ve bu meşrudur — kenarsız
 * exact seed (temas kenarı yok) veya kanıtsız heuristic/unresolved parent
 * kenar durumunda evidenceIds=[] döner. Kanıt yalnızca graph'taki gerçek
 * Evidence kayıtlarından gelir; boşluk asla uydurma kanıtla doldurulmaz
 * (kırmızı çizgi: uydurma geçiş yok). TŞ §15 contextItems'ın "evidence"
 * sunma sözleşmesi boş diziyle de sağlanır (alan mevcut, içerik gerçek);
 * boş kanıtın araç yüzeyinde ayrıca raporlanıp raporlanmayacağı C8'in
 * kesimine aittir.
 */
function resolveEvidenceIds(
  candidate: Candidate,
  evidenceByEdgeId: ReadonlyMap<string, readonly string[]>,
  incidentEvidence: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const raw =
    candidate.depth !== undefined &&
    candidate.depth >= 1 &&
    candidate.parentEdgeId !== undefined &&
    candidate.parentEdgeId.length > 0
      ? (evidenceByEdgeId.get(candidate.parentEdgeId) ?? [])
      : (incidentEvidence.get(candidate.node.id) ?? []);
  return [...new Set(raw)].sort(cmp).slice(0, MAX_ITEM_EVIDENCE_IDS);
}

/** Katkı veren en güçlü (erken) ayaka göre SABİT şablon reason. */
function resolveReason(candidate: Candidate): string {
  for (const leg of LEG_ORDER) {
    if (!candidate.legs.has(leg)) continue;
    switch (leg) {
      case "exact-symbol":
        return "exact-symbol: task tokens exactly match the symbol name tokens";
      case "graph-proximity": {
        const depth = candidate.depth ?? 0;
        return `graph-proximity: connected to an exactly matched symbol at edge depth ${String(depth)}`;
      }
      case "contract":
        return "contract: contract surface symbol that shares tokens with the task";
      case "freshness":
        return "freshness: ranked by file freshness";
      case "fts":
        return "fts: symbol_fts match";
    }
  }
  // Ulaşılamaz: aday en az bir ayakla oluşur.
  return "agent-context: structural candidate";
}
