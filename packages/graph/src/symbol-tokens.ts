/**
 * LocAgent-style (ACL 2025) deterministic identifier & path tokenizer + safe SQLite FTS5
 * query builder.
 *
 * Design invariants:
 * - Pure O(n) linear scanning (zero backtracking / zero ReDoS).
 * - Splits file paths (`packages/mcp-server/src/server.ts`), camelCase (`registerTool`),
 *   PascalCase (`OrderService`), acronyms (`MCPServer` -> `mcp`, `server`), snake_case,
 *   and kebab-case into lowercased searchable tokens.
 * - Filters common natural-language stop words (EN + TR) when turning free-text queries
 *   into bounded FTS5 `OR` queries.
 * - Defense-in-depth for SQLite FTS5 query parsing: every FTS5 query term is strictly
 *   alphanumeric `[a-z0-9]+`, double-quoted, with ZERO raw FTS5 operators (`NEAR`, `NOT`,
 *   `^`, `*`, `:`), bounded to at most 16 terms. Upstream SQLite fixes (the bundled
 *   better-sqlite3 ships SQLite 3.54.1) are not a substitute for, nor a prerequisite of,
 *   this sanitization.
 */

const MAX_INPUT_CHARS = 4_096;
const MAX_TOKENS = 64;
const MAX_FTS5_QUERY_TERMS = 16;

const QUERY_STOP_WORDS: ReadonlySet<string> = new Set([
  // English natural-language filler words
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for",
  "from", "get", "has", "have", "how", "i", "in", "into", "is", "it", "its",
  "me", "my", "of", "on", "or", "our", "show", "that", "the", "their", "them",
  "there", "these", "this", "to", "us", "was", "we", "what", "when", "where",
  "which", "who", "why", "will", "with", "would", "you", "your",
  // Common code-extension noise when querying prose
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "cs", "py", "go", "rs",
  // Turkish natural-language filler words
  "bir", "bu", "da", "de", "en", "gib", "gibi", "hangi", "hem", "her", "ile",
  "icin", "için", "ise", "ki", "mi", "mu", "mı", "mü", "nasil", "nasıl", "ne",
  "neden", "nerede", "nereye", "olan", "olarak", "su", "şu", "ve", "veya", "ya",
]);

function isAsciiUpper(code: number): boolean {
  return code >= 65 && code <= 90;
}

function isAsciiLower(code: number): boolean {
  return code >= 97 && code <= 122;
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiAlnum(code: number): boolean {
  return isAsciiUpper(code) || isAsciiLower(code) || isAsciiDigit(code);
}

/**
 * Splits a single ASCII alphanumeric run along camelCase / PascalCase / acronym / digit
 * boundaries in O(n) time:
 * - `createCausorynMcpServer` -> `["create", "causoryn", "mcp", "server"]`
 * - `MCPServer` -> `["mcp", "server"]`
 * - `v2Handler` -> `["v2", "handler"]` (also keeps full lowered segment when helpful)
 */
function splitCamelSegment(segment: string): string[] {
  if (segment.length === 0) return [];
  const parts: string[] = [];
  let start = 0;

  for (let i = 1; i < segment.length; i += 1) {
    const prev = segment.charCodeAt(i - 1);
    const curr = segment.charCodeAt(i);
    const next = i + 1 < segment.length ? segment.charCodeAt(i + 1) : 0;

    // lower/digit -> Upper (e.g. `registerTool`, `v2Handler`)
    const lowerToUpper = (isAsciiLower(prev) || isAsciiDigit(prev)) && isAsciiUpper(curr);
    // Acronym boundary: Upper -> Upper followed by lower (e.g. `MCPServer` -> `MCP` + `Server`)
    const acronymSplit = isAsciiUpper(prev) && isAsciiUpper(curr) && isAsciiLower(next);

    if (lowerToUpper || acronymSplit) {
      parts.push(segment.slice(start, i).toLowerCase());
      start = i;
    }
  }
  parts.push(segment.slice(start).toLowerCase());
  return parts;
}

/**
 * Normalizes a Unicode string to ASCII-friendly lowercase tokens (folding Turkish
 * dotted/dotless letters so queries like `araçları` / `kaydediliyor` tokenize cleanly).
 */
function foldUnicodeToAsciiRuns(input: string): string {
  const clipped = input.length > MAX_INPUT_CHARS ? input.slice(0, MAX_INPUT_CHARS) : input;
  let out = "";
  for (let i = 0; i < clipped.length; i += 1) {
    const ch = clipped[i]!;
    switch (ch) {
      case "ç":
      case "Ç":
        out += ch === "Ç" ? "C" : "c";
        break;
      case "ğ":
      case "Ğ":
        out += ch === "Ğ" ? "G" : "g";
        break;
      case "ı":
      case "İ":
        out += ch === "İ" ? "I" : "i";
        break;
      case "ö":
      case "Ö":
        out += ch === "Ö" ? "O" : "o";
        break;
      case "ş":
      case "Ş":
        out += ch === "Ş" ? "S" : "s";
        break;
      case "ü":
      case "Ü":
        out += ch === "Ü" ? "U" : "u";
        break;
      default:
        out += ch;
        break;
    }
  }
  return out;
}

/**
 * Extracts unique, deterministic, lowercased identifier and path tokens from any
 * qualified symbol name, relative file path, or natural-language query.
 *
 * Keeps both individual split sub-tokens (`register`, `tool`, `server`) AND full
 * compound alphanumeric identifiers (`registertool`, `createcausorynmcpserver`)
 * so exact identifier queries rank highest while partial/natural-language queries match.
 */
export function tokenizeSymbolText(
  raw: string,
  options: { readonly stripStopWords?: boolean; readonly includeCompound?: boolean } = {},
): readonly string[] {
  const stripStopWords = options.stripStopWords ?? false;
  const includeCompound = options.includeCompound ?? true;
  const folded = foldUnicodeToAsciiRuns(raw);

  const tokens: string[] = [];
  const seen = new Set<string>();
  const pushToken = (tok: string): void => {
    if (tok.length < 2) return;
    if (stripStopWords && QUERY_STOP_WORDS.has(tok)) return;
    if (seen.has(tok)) return;
    if (tokens.length >= MAX_TOKENS) return;
    seen.add(tok);
    tokens.push(tok);
  };

  let runStart = -1;
  const flushRun = (end: number): void => {
    if (runStart < 0) return;
    const run = folded.slice(runStart, end);
    runStart = -1;
    if (run.length === 0) return;
    const lowered = run.toLowerCase();
    const parts = splitCamelSegment(run);
    if (includeCompound) {
      pushToken(lowered);
    }
    for (const part of parts) {
      pushToken(part);
      // Simple English plural stemming (`tools` -> `tool`, `handlers` -> `handler`)
      // for natural-language localization without external stemmer deps.
      if (part.length >= 4 && part.endsWith("s") && !part.endsWith("ss")) {
        pushToken(part.slice(0, -1));
      }
      // Common `-ed` / `-ing` verb forms (`registered` -> `register`, `indexing` -> `index`)
      if (part.length >= 6 && part.endsWith("ed")) {
        pushToken(part.slice(0, -2));
      }
    }
  };

  for (let i = 0; i < folded.length; i += 1) {
    const code = folded.charCodeAt(i);
    if (isAsciiAlnum(code)) {
      if (runStart < 0) runStart = i;
    } else {
      flushRun(i);
    }
  }
  flushRun(folded.length);

  return tokens;
}

/**
 * Formats a searchable FTS5 text payload combining the raw qualified name,
 * optional relative file path, and all split identifier/path tokens.
 */
export function buildSymbolFtsDocument(
  qualifiedName: string,
  relativePath?: string,
): string {
  const parts: string[] = [qualifiedName];
  if (relativePath !== undefined && relativePath.length > 0) {
    parts.push(relativePath);
  }
  const combined = parts.join(" ");
  const tokens = tokenizeSymbolText(combined, {
    stripStopWords: false,
    includeCompound: true,
  });
  return tokens.length === 0 ? combined : `${combined} ${tokens.join(" ")}`;
}

/**
 * Converts any user or natural-language query into a safe, injection-proof SQLite FTS5
 * `OR` MATCH expression using double-quoted strictly alphanumeric terms (zero wildcards,
 * zero raw FTS5 operators). Returns `null` when no searchable tokens exist.
 */
export function buildSafeFts5OrQuery(rawQuery: string): string | null {
  let tokens = tokenizeSymbolText(rawQuery, {
    stripStopWords: true,
    includeCompound: true,
  });
  if (tokens.length === 0) {
    tokens = tokenizeSymbolText(rawQuery, {
      stripStopWords: false,
      includeCompound: true,
    });
  }
  if (tokens.length === 0) {
    return null;
  }
  const bounded = tokens.slice(0, MAX_FTS5_QUERY_TERMS);
  return bounded.map((tok) => `"${tok}"`).join(" OR ");
}
