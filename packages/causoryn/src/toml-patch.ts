import { insertMissingOwnedKeys } from "./owned-keys.js";
import {
  CausorynCliError,
  type CodexMcpServerSpec,
  type ParsedCodexMcpServer,
} from "./types.js";

/**
 * Codex `config.toml` için bağımlılıksız, fail-closed TOML doğrulayıcı ve
 * cerrahi `[mcp_servers.causoryn]` yama yardımcısı (`K-021`).
 *
 * Kurallar:
 * - Bozuk TOML (kapanmamış tırnak/dizi/tablo, `=` içermeyen çıplak satır,
 *   boş tablo başlığı veya mükerrer `[mcp_servers.causoryn]`) `cli/malformed-toml`
 *   ile fail-closed reddedilir.
 * - Yorumlar, üst düzey anahtarlar, komşu `[mcp_servers.<diğer>]` tabloları ve
 *   `[mcp_servers.causoryn.tools.*]` / onay alt-tabloları birebir korunur.
 */

interface TomlSection {
  /** Tablo başlığı adı (örn. `mcp_servers.causoryn`), preamble için `null`. */
  readonly header: string | null;
  /** Tablodan hemen önce gelen yorum satırları (sonraki tabloya ait üst yorumlar). */
  readonly leadingComments: readonly string[];
  /** Başlık satırı + gövde satırları. */
  readonly lines: readonly string[];
  /** 1-based line of `lines[0]` in the parsed document (absent for rendered sections). */
  readonly startLine?: number;
}

interface ParsedTomlDocument {
  readonly eol: "\n" | "\r\n";
  readonly sections: readonly TomlSection[];
}

const DEFAULT_STARTUP_TIMEOUT_SEC = 30;
const CAUSORYN_TABLE = "mcp_servers.causoryn";
const CAUSORYN_ENV_TABLE = "mcp_servers.causoryn.env";

export function formatTomlBasicString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] ?? "";
    const code = value.charCodeAt(i);
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === '"') {
      out += '\\"';
    } else if (ch === "\b") {
      out += "\\b";
    } else if (ch === "\f") {
      out += "\\f";
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  out += '"';
  return out;
}

/**
 * Where a TOML value sits: the key path and its line. Value errors name these
 * and never quote the value (CWE-209): env values and args are often
 * credentials, and the messages reach the setup / doctor output.
 */
interface TomlValueSite {
  readonly field: string;
  readonly line: number | null;
}

/** Site for parses whose errors are caught and never reported. */
const UNREPORTED_SITE: TomlValueSite = { field: "value", line: null };

function tomlValueError(site: TomlValueSite, problem: string): CausorynCliError {
  const where = site.line !== null ? ` (line ${String(site.line)})` : "";
  return new CausorynCliError("cli/malformed-toml", `Malformed TOML${where}: ${site.field} ${problem}`);
}

function unescapeTomlString(raw: string, site: TomlValueSite): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) {
    throw tomlValueError(site, "is not a valid TOML string");
  }
  const body = trimmed.slice(1, -1);
  let result = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] ?? "";
    if (ch !== "\\") {
      result += ch;
      continue;
    }
    i += 1;
    if (i >= body.length) {
      throw tomlValueError(site, "has an unterminated escape sequence");
    }
    const esc = body[i] ?? "";
    switch (esc) {
      case "\\":
        result += "\\";
        break;
      case '"':
        result += '"';
        break;
      case "n":
        result += "\n";
        break;
      case "r":
        result += "\r";
        break;
      case "t":
        result += "\t";
        break;
      case "b":
        result += "\b";
        break;
      case "f":
        result += "\f";
        break;
      case "u": {
        const hex = body.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw tomlValueError(site, "has an invalid \\u escape sequence");
        }
        result += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        result += esc;
        break;
    }
  }
  return result;
}

interface ScanState {
  inMultilineBasic: boolean;
  inMultilineLiteral: boolean;
  bracketDepth: number;
  braceDepth: number;
}

/**
 * Tek satırı tarayarak tırnak/parantez dengesini doğrular ve yorum öncesi
 * aktif içeriği döndürür.
 */
function scanTomlLine(
  line: string,
  lineNumber: number,
  state: ScanState,
): { readonly effectiveCode: string } {
  let i = 0;
  let inBasic = false;
  let inLiteral = false;
  let codeEnd = line.length;

  while (i < line.length) {
    if (state.inMultilineBasic) {
      if (line.startsWith('"""', i)) {
        state.inMultilineBasic = false;
        i += 3;
        continue;
      }
      if (line[i] === "\\") {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (state.inMultilineLiteral) {
      if (line.startsWith("'''", i)) {
        state.inMultilineLiteral = false;
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }

    if (inBasic) {
      if (line[i] === "\\") {
        i += 2;
        continue;
      }
      if (line[i] === '"') {
        inBasic = false;
      }
      i += 1;
      continue;
    }

    if (inLiteral) {
      if (line[i] === "'") {
        inLiteral = false;
      }
      i += 1;
      continue;
    }

    if (line.startsWith('"""', i)) {
      state.inMultilineBasic = true;
      i += 3;
      continue;
    }
    if (line.startsWith("'''", i)) {
      state.inMultilineLiteral = true;
      i += 3;
      continue;
    }
    const ch = line[i] ?? "";
    if (ch === '"') {
      inBasic = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inLiteral = true;
      i += 1;
      continue;
    }
    if (ch === "#") {
      codeEnd = i;
      break;
    }
    if (ch === "[") {
      state.bracketDepth += 1;
    } else if (ch === "]") {
      state.bracketDepth -= 1;
      if (state.bracketDepth < 0) {
        throw new CausorynCliError(
          "cli/malformed-toml",
          `Malformed TOML (line ${String(lineNumber)}): unmatched ']' character`,
        );
      }
    } else if (ch === "{") {
      state.braceDepth += 1;
    } else if (ch === "}") {
      state.braceDepth -= 1;
      if (state.braceDepth < 0) {
        throw new CausorynCliError(
          "cli/malformed-toml",
          `Malformed TOML (line ${String(lineNumber)}): unmatched '}' character`,
        );
      }
    }
    i += 1;
  }

  if (inBasic || inLiteral) {
    throw new CausorynCliError(
      "cli/malformed-toml",
      `Malformed TOML (line ${String(lineNumber)}): unterminated string quote`,
    );
  }

  return { effectiveCode: line.slice(0, codeEnd).trim() };
}

function parseTableHeaderCode(effectiveCode: string, lineNumber: number): string | null {
  if (!effectiveCode.startsWith("[")) {
    return null;
  }
  if (effectiveCode.startsWith("[[")) {
    if (!effectiveCode.endsWith("]]")) {
      throw new CausorynCliError(
        "cli/malformed-toml",
        `Malformed TOML (line ${String(lineNumber)}): unterminated array-of-tables header`,
      );
    }
    const inner = effectiveCode.slice(2, -2).trim();
    if (inner.length === 0 || inner.includes("[") || inner.includes("]")) {
      throw new CausorynCliError(
        "cli/malformed-toml",
        `Malformed TOML (line ${String(lineNumber)}): invalid array-of-tables header`,
      );
    }
    return `[${inner}]`;
  }

  if (!effectiveCode.endsWith("]")) {
    throw new CausorynCliError(
      "cli/malformed-toml",
      `Malformed TOML (line ${String(lineNumber)}): unterminated table header`,
    );
  }
  const inner = effectiveCode.slice(1, -1).trim();
  if (inner.length === 0 || inner.includes("[") || inner.includes("]")) {
    throw new CausorynCliError(
      "cli/malformed-toml",
      `Malformed TOML (line ${String(lineNumber)}): invalid table header`,
    );
  }
  return inner;
}

function findTopLevelEquals(code: string): number {
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i] ?? "";
    if (inBasic) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') inBasic = false;
      continue;
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === '"') {
      inBasic = true;
      continue;
    }
    if (ch === "'") {
      inLiteral = true;
      continue;
    }
    if (ch === "=") return i;
  }
  return -1;
}

function parseTomlDocument(rawToml: string): ParsedTomlDocument {
  const withoutBom = rawToml.startsWith("\uFEFF") ? rawToml.slice(1) : rawToml;
  const eol: "\n" | "\r\n" = withoutBom.includes("\r\n") ? "\r\n" : "\n";
  const rawLines = withoutBom.length === 0 ? [] : withoutBom.split(/\r?\n/);

  const state: ScanState = {
    inMultilineBasic: false,
    inMultilineLiteral: false,
    bracketDepth: 0,
    braceDepth: 0,
  };

  interface RawSectionBuilder {
    header: string | null;
    lines: string[];
    startLine: number;
  }

  const builders: RawSectionBuilder[] = [{ header: null, lines: [], startLine: 1 }];
  const seenStandardTables = new Set<string>();

  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const line = rawLines[idx] ?? "";
    const lineNumber = idx + 1;
    const wasContinuation =
      state.inMultilineBasic ||
      state.inMultilineLiteral ||
      state.bracketDepth > 0 ||
      state.braceDepth > 0;

    const { effectiveCode } = scanTomlLine(line, lineNumber, state);
    const currentBuilder = builders[builders.length - 1];
    if (currentBuilder === undefined) {
      throw new CausorynCliError("cli/malformed-toml", "Internal TOML parser error");
    }

    if (wasContinuation || effectiveCode.length === 0) {
      currentBuilder.lines.push(line);
      continue;
    }

    if (effectiveCode.startsWith("[")) {
      // Tablo başlığında bracketDepth scan sırasında +1/-1 ile 0'a dönmüş olmalı
      if (state.bracketDepth !== 0 || state.braceDepth !== 0) {
        throw new CausorynCliError(
          "cli/malformed-toml",
          `Malformed TOML (line ${String(lineNumber)}): unbalanced table header`,
        );
      }
      const header = parseTableHeaderCode(effectiveCode, lineNumber);
      if (header !== null && !header.startsWith("[")) {
        if (seenStandardTables.has(header)) {
          throw new CausorynCliError(
            "cli/malformed-toml",
            `Malformed TOML (line ${String(lineNumber)}): duplicate table header [${header}]`,
          );
        }
        seenStandardTables.add(header);
      }
      builders.push({ header, lines: [line], startLine: lineNumber });
      continue;
    }

    const eqIdx = findTopLevelEquals(effectiveCode);
    if (eqIdx <= 0) {
      throw new CausorynCliError(
        "cli/malformed-toml",
        `Malformed TOML (line ${String(lineNumber)}): expected a key = value assignment`,
      );
    }
    const keyPart = effectiveCode.slice(0, eqIdx).trim();
    const valuePart = effectiveCode.slice(eqIdx + 1).trim();
    if (
      keyPart.length === 0 ||
      (valuePart.length === 0 && !state.inMultilineBasic && !state.inMultilineLiteral)
    ) {
      throw new CausorynCliError(
        "cli/malformed-toml",
        `Malformed TOML (line ${String(lineNumber)}): missing key or value`,
      );
    }

    currentBuilder.lines.push(line);
  }

  if (
    state.inMultilineBasic ||
    state.inMultilineLiteral ||
    state.bracketDepth !== 0 ||
    state.braceDepth !== 0
  ) {
    throw new CausorynCliError(
      "cli/malformed-toml",
      "Malformed TOML: unterminated multi-line value, array, or inline table at end of file",
    );
  }

  // Bir sonraki tablo başlığının hemen üstündeki yorum satırlarını o tabloya bağla
  const sections: TomlSection[] = [];
  let pendingLeadingComments: string[] = [];

  for (let bIdx = 0; bIdx < builders.length; bIdx += 1) {
    const builder = builders[bIdx];
    if (builder === undefined) continue;
    const myLeading = pendingLeadingComments;
    pendingLeadingComments = [];

    const hasNextTable = bIdx + 1 < builders.length;
    const bodyLines = [...builder.lines];

    if (hasNextTable && bodyLines.length > 0) {
      const minKeep = builder.header === null ? 0 : 1;
      const detached: string[] = [];
      while (bodyLines.length > minKeep) {
        const tail = bodyLines[bodyLines.length - 1] ?? "";
        if (tail.trim().startsWith("#")) {
          detached.unshift(tail);
          bodyLines.pop();
        } else {
          break;
        }
      }
      // Yalnızca öncesinde boş satır varsa veya preamble tamamen yorumsa sonraki tabloya bağla
      if (detached.length > 0) {
        const prev = bodyLines[bodyLines.length - 1];
        if (prev === undefined || prev.trim().length === 0) {
          pendingLeadingComments = detached;
        } else {
          bodyLines.push(...detached);
        }
      }
    }

    sections.push({
      header: builder.header,
      leadingComments: myLeading,
      lines: bodyLines,
      startLine: builder.startLine,
    });
  }

  return { eol, sections };
}

export function validateTomlStructure(rawToml: string): void {
  parseTomlDocument(rawToml);
}

/**
 * Keys of `[mcp_servers.causoryn]` that Causoryn writes, in the order of a
 * fresh table. Every other key of an existing table is kept verbatim.
 */
const CAUSORYN_OWNED_TABLE_KEYS = ["command", "args", "startup_timeout_sec"] as const;

type CausorynOwnedTableKey = (typeof CAUSORYN_OWNED_TABLE_KEYS)[number];

function specStartupTimeoutSec(spec: CodexMcpServerSpec): number {
  return spec.startupTimeoutSec ?? DEFAULT_STARTUP_TIMEOUT_SEC;
}

function renderOwnedTableLine(key: CausorynOwnedTableKey, spec: CodexMcpServerSpec): string {
  switch (key) {
    case "command":
      return `command = ${formatTomlBasicString(spec.command)}`;
    case "args":
      return `args = [${spec.args.map((arg) => formatTomlBasicString(arg)).join(", ")}]`;
    case "startup_timeout_sec":
      return `startup_timeout_sec = ${String(specStartupTimeoutSec(spec))}`;
  }
}

/** Owned key (or "env") an assignment of the main table sets; null for a key Causoryn does not own. */
function ownedTableKeyOf(rawKey: string | null): CausorynOwnedTableKey | "env" | null {
  if (rawKey === null) return null;
  const first = splitTomlKeyPath(rawKey)?.[0];
  if (first === "env") return "env";
  return (CAUSORYN_OWNED_TABLE_KEYS as readonly string[]).includes(first ?? "")
    ? (first as CausorynOwnedTableKey)
    : null;
}

/** Whether an existing owned value already equals the spec value (then its line is kept verbatim). */
function ownedTableValueUnchanged(
  key: CausorynOwnedTableKey,
  rawValue: string,
  spec: CodexMcpServerSpec,
): boolean {
  try {
    switch (key) {
      case "command":
        return unescapeTomlString(rawValue, UNREPORTED_SITE) === spec.command;
      case "args": {
        const existing = parseTomlStringArray(rawValue, UNREPORTED_SITE);
        return existing.length === spec.args.length && existing.every((arg, i) => arg === spec.args[i]);
      }
      case "startup_timeout_sec":
        return parseTomlNumber(rawValue) === specStartupTimeoutSec(spec);
    }
  } catch {
    return false;
  }
}

/**
 * Rewrites an existing `[mcp_servers.causoryn]` table in place: the owned keys
 * get the spec values (a line whose value is already right stays verbatim; a
 * dotted key under an owned name is replaced too), env keys move to the env
 * sub-table, and every other key, comment and blank line keeps its text and
 * position. Missing owned keys are inserted where a fresh table has them.
 */
function rewriteCausorynMainTableLines(section: TomlSection, spec: CodexMcpServerSpec): string[] {
  interface BodyItem {
    readonly owned: CausorynOwnedTableKey | null;
    readonly lines: readonly string[];
  }
  const items: BodyItem[] = [];
  const seen = new Set<CausorynOwnedTableKey>();
  for (const unit of splitSectionUnits(section)) {
    const owner = ownedTableKeyOf(unit.key);
    if (owner === "env") continue;
    if (owner === null) {
      items.push({ owned: null, lines: unit.lines });
      continue;
    }
    // A repeated owned key is invalid TOML; only the first one is rewritten.
    if (seen.has(owner)) continue;
    seen.add(owner);
    const keepVerbatim =
      unit.key !== null &&
      unit.value !== null &&
      splitTomlKeyPath(unit.key)?.length === 1 &&
      ownedTableValueUnchanged(owner, unit.value, spec);
    items.push({ owned: owner, lines: keepVerbatim ? unit.lines : [renderOwnedTableLine(owner, spec)] });
  }
  const complete = insertMissingOwnedKeys(
    items,
    (item) => item.owned,
    CAUSORYN_OWNED_TABLE_KEYS,
    (key): BodyItem => ({
      owned: key as CausorynOwnedTableKey,
      lines: [renderOwnedTableLine(key as CausorynOwnedTableKey, spec)],
    }),
  );
  return [section.lines[0] ?? `[${CAUSORYN_TABLE}]`, ...complete.flatMap((item) => item.lines)];
}

function renderCausorynSections(spec: CodexMcpServerSpec): TomlSection[] {
  const mainLines = [
    `[${CAUSORYN_TABLE}]`,
    ...CAUSORYN_OWNED_TABLE_KEYS.map((key) => renderOwnedTableLine(key, spec)),
  ];

  const out: TomlSection[] = [
    {
      header: CAUSORYN_TABLE,
      leadingComments: [],
      lines: mainLines,
    },
  ];

  const envSection = renderCausorynEnvSection(spec.env);
  if (envSection !== null) {
    out.push(envSection);
  }

  return out;
}

/**
 * Renders `[mcp_servers.causoryn.env]` in the given key order (the caller keeps
 * the user's existing order so an unchanged env does not cause a rewrite).
 */
function renderCausorynEnvSection(
  env: Readonly<Record<string, string>> | undefined,
): TomlSection | null {
  const envEntries = env !== undefined ? Object.entries(env) : [];
  if (envEntries.length === 0) {
    return null;
  }
  return {
    header: CAUSORYN_ENV_TABLE,
    leadingComments: [],
    lines: [
      `[${CAUSORYN_ENV_TABLE}]`,
      ...envEntries.map(([k, v]) => `${formatTomlKey(k)} = ${formatTomlBasicString(v)}`),
    ],
  };
}

function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : formatTomlBasicString(key);
}

function trimTrailingBlankLines(lines: readonly string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && (copy[copy.length - 1] ?? "").trim().length === 0) {
    copy.pop();
  }
  return copy;
}

function serializeSections(sections: readonly TomlSection[], eol: "\n" | "\r\n"): string {
  const blocks: string[] = [];
  for (const section of sections) {
    const trimmedLines = trimTrailingBlankLines(section.lines);
    const combined = [...section.leadingComments, ...trimmedLines];
    if (section.header === null && combined.length === 0) {
      continue;
    }
    blocks.push(combined.join(eol));
  }
  if (blocks.length === 0) {
    return "";
  }
  return `${blocks.join(eol + eol)}${eol}`;
}

export function upsertCodexMcpServer(existingToml: string, spec: CodexMcpServerSpec): string {
  const parsed = parseTomlDocument(existingToml);
  const replacement = renderCausorynSections(spec);
  const envReplacement = renderCausorynEnvSection(spec.env);

  const outputSections: TomlSection[] = [];
  let inserted = false;

  const hasExistingMain = parsed.sections.some((s) => s.header === CAUSORYN_TABLE);
  // An existing env sub-table is rewritten in place (keeping its position and
  // leading comments); otherwise the new env sub-table follows the main table.
  const hasExistingEnv = parsed.sections.some((s) => s.header === CAUSORYN_ENV_TABLE);

  for (const section of parsed.sections) {
    if (section.header === CAUSORYN_TABLE) {
      if (!inserted) {
        const firstReplacement = replacement[0];
        if (firstReplacement !== undefined) {
          outputSections.push({
            header: firstReplacement.header,
            leadingComments: section.leadingComments,
            lines: rewriteCausorynMainTableLines(section, spec),
          });
          for (let i = 1; i < replacement.length; i += 1) {
            const extra = replacement[i];
            if (extra !== undefined && !(hasExistingEnv && extra.header === CAUSORYN_ENV_TABLE)) {
              outputSections.push(extra);
            }
          }
        }
        inserted = true;
      }
      continue;
    }

    if (section.header === CAUSORYN_ENV_TABLE) {
      if (envReplacement !== null && hasExistingMain) {
        outputSections.push({
          header: envReplacement.header,
          leadingComments: section.leadingComments,
          lines: envReplacement.lines,
        });
      }
      // Without a main table the env sub-table is (re)emitted with the replacement.
      continue;
    }

    if (
      !hasExistingMain &&
      !inserted &&
      section.header !== null &&
      section.header.startsWith(`${CAUSORYN_TABLE}.`)
    ) {
      outputSections.push(...replacement);
      inserted = true;
    }

    outputSections.push(section);
  }

  if (!inserted) {
    outputSections.push(...replacement);
  }

  return serializeSections(outputSections, parsed.eol);
}

export function removeCodexMcpServer(existingToml: string): {
  readonly content: string;
  readonly removed: boolean;
} {
  const parsed = parseTomlDocument(existingToml);
  let removed = false;
  const kept: TomlSection[] = [];

  for (const section of parsed.sections) {
    if (
      section.header === CAUSORYN_TABLE ||
      (section.header !== null && section.header.startsWith(`${CAUSORYN_TABLE}.`))
    ) {
      removed = true;
      continue;
    }
    kept.push(section);
  }

  if (!removed) {
    return { content: existingToml, removed: false };
  }
  return { content: serializeSections(kept, parsed.eol), removed: true };
}

function parseTomlStringArray(rawValue: string, site: TomlValueSite): string[] {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw tomlValueError(site, "must be an array of TOML strings");
  }
  const item = (piece: string): string => {
    try {
      return unescapeTomlString(piece, site);
    } catch {
      throw tomlValueError(site, "must be an array of TOML strings");
    }
  };
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];

  const items: string[] = [];
  let current = "";
  let inBasic = false;
  let inLiteral = false;

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i] ?? "";
    if (inBasic) {
      current += ch;
      if (ch === "\\" && i + 1 < inner.length) {
        i += 1;
        current += inner[i] ?? "";
        continue;
      }
      if (ch === '"') inBasic = false;
      continue;
    }
    if (inLiteral) {
      current += ch;
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === '"') {
      inBasic = true;
      current += ch;
      continue;
    }
    if (ch === "'") {
      inLiteral = true;
      current += ch;
      continue;
    }
    if (ch === ",") {
      const piece = current.trim();
      if (piece.length > 0) {
        items.push(item(piece));
      }
      current = "";
      continue;
    }
    current += ch;
  }

  const tail = current.trim();
  if (tail.length > 0) {
    items.push(item(tail));
  }
  return items;
}

/**
 * One piece of a section body: a `key = value` assignment with all of its raw
 * lines (a value can span lines), or a single blank / comment line
 * (`key` and `value` null).
 */
interface SectionUnit {
  readonly lines: readonly string[];
  readonly key: string | null;
  readonly value: string | null;
  /** 1-based document line of the unit's first line. */
  readonly line: number;
}

/** Splits a section body (header line skipped) into assignments and blank / comment lines. */
function splitSectionUnits(section: TomlSection): SectionUnit[] {
  const state: ScanState = {
    inMultilineBasic: false,
    inMultilineLiteral: false,
    bracketDepth: 0,
    braceDepth: 0,
  };
  const units: SectionUnit[] = [];
  let pending: { lines: string[]; code: string; line: number } | null = null;
  const firstLine = section.startLine ?? 1;

  for (let i = 1; i < section.lines.length; i += 1) {
    const line = section.lines[i] ?? "";
    const lineNumber = firstLine + i;
    const { effectiveCode } = scanTomlLine(line, lineNumber, state);
    const open =
      state.inMultilineBasic ||
      state.inMultilineLiteral ||
      state.bracketDepth > 0 ||
      state.braceDepth > 0;
    if (pending === null) {
      if (effectiveCode.length === 0 && !open) {
        units.push({ lines: [line], key: null, value: null, line: lineNumber });
        continue;
      }
      pending = { lines: [line], code: effectiveCode, line: lineNumber };
    } else {
      pending.lines.push(line);
      if (effectiveCode.length > 0) {
        pending.code = `${pending.code} ${effectiveCode}`;
      }
    }
    if (open) continue;

    const eqIdx = findTopLevelEquals(pending.code);
    units.push({
      lines: pending.lines,
      key: eqIdx > 0 ? pending.code.slice(0, eqIdx).trim() : null,
      value: eqIdx > 0 ? pending.code.slice(eqIdx + 1).trim() : null,
      line: pending.line,
    });
    pending = null;
  }
  if (pending !== null) {
    units.push({ lines: pending.lines, key: null, value: null, line: pending.line });
  }
  return units;
}

/**
 * Calls `onAssignment` for every top-level `key = value` of a section body
 * (header line skipped) with the document line where the assignment starts.
 */
function forEachSectionAssignment(
  section: TomlSection,
  onAssignment: (key: string, value: string, line: number) => void,
): void {
  for (const unit of splitSectionUnits(section)) {
    if (unit.key !== null && unit.value !== null) {
      onAssignment(unit.key, unit.value, unit.line);
    }
  }
}

/**
 * Splits a (possibly dotted) TOML key into its unquoted parts:
 * `env . "A.B"` gives `["env", "A.B"]`. Returns null for a key it cannot read.
 */
function splitTomlKeyPath(rawKey: string): string[] | null {
  const parts: string[] = [];
  for (const piece of splitTopLevel(rawKey, ".")) {
    const trimmed = piece.trim();
    if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
      try {
        parts.push(unescapeTomlString(trimmed, UNREPORTED_SITE));
      } catch {
        return null;
      }
    } else if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
      parts.push(trimmed);
    } else {
      return null;
    }
  }
  return parts.length > 0 ? parts : null;
}

const TOML_DECIMAL_NUMBER = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/;
const TOML_PREFIXED_INTEGER = /^0(?:x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/;

/** Reads a finite TOML integer or float (`30`, `1_000`, `45.5`, `0x1E`); null otherwise. */
function parseTomlNumber(rawValue: string): number | null {
  const trimmed = rawValue.trim();
  if (!TOML_DECIMAL_NUMBER.test(trimmed) && !TOML_PREFIXED_INTEGER.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed.replace(/_/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parses a single (bare or quoted) TOML key of `table`; dotted keys are
 * rejected. A key that cannot be read is reported by its line only: its text
 * may not be a key at all (a misplaced value).
 */
function parseTomlSimpleKey(rawKey: string, table: string, line: number | null): string {
  const trimmed = rawKey.trim();
  const site: TomlValueSite = { field: `a key of ${table}`, line };
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return unescapeTomlString(trimmed, site);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw tomlValueError(site, "is not supported (use a bare key such as API_KEY or a quoted key)");
  }
  return trimmed;
}

/** Report name of the env key `key` (bare, or TOML-quoted with control characters escaped). */
function envField(key: string): string {
  return `${CAUSORYN_ENV_TABLE}.${formatTomlKey(key)}`;
}

function parseTomlEnvValue(rawValue: string, site: TomlValueSite): string {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith('"') && !trimmed.startsWith("'")) {
    throw tomlValueError(site, "is not a TOML string (env values must be TOML strings)");
  }
  return unescapeTomlString(trimmed, site);
}

/** Splits `text` on top-level `separator` characters (outside strings, arrays and inline tables). */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inBasic = false;
  let inLiteral = false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (inBasic) {
      current += ch;
      if (ch === "\\" && i + 1 < text.length) {
        i += 1;
        current += text[i] ?? "";
      } else if (ch === '"') {
        inBasic = false;
      }
      continue;
    }
    if (inLiteral) {
      current += ch;
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === '"') {
      inBasic = true;
    } else if (ch === "'") {
      inLiteral = true;
    } else if (ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === "]" || ch === "}") {
      depth -= 1;
    } else if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Defines an own env entry (a plain assignment of `__proto__` would be swallowed). */
function setEnvEntry(env: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(env, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Parses an inline `{ KEY = "value", ... }` env table that starts on document line `line`. */
function parseTomlInlineEnvTable(rawValue: string, into: Record<string, string>, line: number): void {
  const trimmed = rawValue.trim();
  const tableSite: TomlValueSite = { field: `${CAUSORYN_TABLE}.env`, line };
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw tomlValueError(tableSite, 'must be an inline table of TOML strings (env = { KEY = "value" })');
  }
  let entryNumber = 0;
  for (const piece of splitTopLevel(trimmed.slice(1, -1), ",")) {
    if (piece.trim().length === 0) continue;
    entryNumber += 1;
    const eqIdx = findTopLevelEquals(piece);
    if (eqIdx <= 0) {
      throw tomlValueError(tableSite, `entry ${String(entryNumber)} is not a KEY = "value" pair`);
    }
    const key = parseTomlSimpleKey(piece.slice(0, eqIdx), `${CAUSORYN_TABLE}.env`, line);
    setEnvEntry(into, key, parseTomlEnvValue(piece.slice(eqIdx + 1), { field: envField(key), line }));
  }
}

export function readCodexMcpServer(rawToml: string): ParsedCodexMcpServer | null {
  const parsed = parseTomlDocument(rawToml);
  const target = parsed.sections.find((s) => s.header === CAUSORYN_TABLE);
  if (target === undefined) {
    return null;
  }

  const found: {
    command: string | null;
    args: string[];
    startupTimeoutSec: number | null;
    startupTimeoutSecRaw: string | undefined;
  } = {
    command: null,
    args: [],
    startupTimeoutSec: null,
    startupTimeoutSecRaw: undefined,
  };
  const env: Record<string, string> = {};

  forEachSectionAssignment(target, (key, val, line) => {
    const keyPath = splitTomlKeyPath(key);
    if (keyPath === null) return;
    const [first] = keyPath;
    if (first === "env") {
      if (keyPath.length === 1) {
        parseTomlInlineEnvTable(val, env, line);
        return;
      }
      if (keyPath.length > 2) {
        throw tomlValueError(
          { field: `${CAUSORYN_TABLE}.${keyPath.map(formatTomlKey).join(".")}`, line },
          `is not supported (env keys take one level: env.KEY or the [${CAUSORYN_ENV_TABLE}] table)`,
        );
      }
      const envKey = keyPath[1] as string;
      setEnvEntry(env, envKey, parseTomlEnvValue(val, { field: envField(envKey), line }));
      return;
    }
    if (keyPath.length !== 1) return;
    if (first === "command") {
      found.command = unescapeTomlString(val, { field: `${CAUSORYN_TABLE}.command`, line });
    } else if (first === "args") {
      found.args = parseTomlStringArray(val, { field: `${CAUSORYN_TABLE}.args`, line });
    } else if (first === "startup_timeout_sec") {
      found.startupTimeoutSec = parseTomlNumber(val);
      found.startupTimeoutSecRaw = val;
    }
  });

  const envSection = parsed.sections.find((s) => s.header === CAUSORYN_ENV_TABLE);
  if (envSection !== undefined) {
    forEachSectionAssignment(envSection, (key, val, line) => {
      const envKey = parseTomlSimpleKey(key, `[${CAUSORYN_ENV_TABLE}]`, line);
      setEnvEntry(env, envKey, parseTomlEnvValue(val, { field: envField(envKey), line }));
    });
  }

  if (found.command === null) {
    return null;
  }
  return {
    command: found.command,
    args: found.args,
    startupTimeoutSec: found.startupTimeoutSec,
    ...(found.startupTimeoutSecRaw !== undefined
      ? { startupTimeoutSecRaw: found.startupTimeoutSecRaw }
      : {}),
    env,
  };
}
