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

function unescapeTomlString(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) {
    throw new CausorynCliError("cli/malformed-toml", `Geçersiz TOML string değeri: ${raw}`);
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
      throw new CausorynCliError("cli/malformed-toml", "Kapanmamış TOML kaçış dizisi");
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
          throw new CausorynCliError("cli/malformed-toml", `Geçersiz \\u kaçışı: ${hex}`);
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
          `Bozuk TOML (satır ${String(lineNumber)}): eşleşmeyen ']' karakteri`,
        );
      }
    } else if (ch === "{") {
      state.braceDepth += 1;
    } else if (ch === "}") {
      state.braceDepth -= 1;
      if (state.braceDepth < 0) {
        throw new CausorynCliError(
          "cli/malformed-toml",
          `Bozuk TOML (satır ${String(lineNumber)}): eşleşmeyen '}' karakteri`,
        );
      }
    }
    i += 1;
  }

  if (inBasic || inLiteral) {
    throw new CausorynCliError(
      "cli/malformed-toml",
      `Bozuk TOML (satır ${String(lineNumber)}): kapanmamış string tırnağı`,
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
        `Bozuk TOML (satır ${String(lineNumber)}): kapanmamış dizi-tablo başlığı`,
      );
    }
    const inner = effectiveCode.slice(2, -2).trim();
    if (inner.length === 0 || inner.includes("[") || inner.includes("]")) {
      throw new CausorynCliError(
        "cli/malformed-toml",
        `Bozuk TOML (satır ${String(lineNumber)}): geçersiz dizi-tablo başlığı`,
      );
    }
    return `[${inner}]`;
  }

  if (!effectiveCode.endsWith("]")) {
    throw new CausorynCliError(
      "cli/malformed-toml",
      `Bozuk TOML (satır ${String(lineNumber)}): kapanmamış tablo başlığı`,
    );
  }
  const inner = effectiveCode.slice(1, -1).trim();
  if (inner.length === 0 || inner.includes("[") || inner.includes("]")) {
    throw new CausorynCliError(
      "cli/malformed-toml",
      `Bozuk TOML (satır ${String(lineNumber)}): geçersiz tablo başlığı`,
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
  }

  const builders: RawSectionBuilder[] = [{ header: null, lines: [] }];
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
      throw new CausorynCliError("cli/malformed-toml", "İç TOML ayrıştırıcı hatası");
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
          `Bozuk TOML (satır ${String(lineNumber)}): dengesiz tablo başlığı`,
        );
      }
      const header = parseTableHeaderCode(effectiveCode, lineNumber);
      if (header !== null && !header.startsWith("[")) {
        if (seenStandardTables.has(header)) {
          throw new CausorynCliError(
            "cli/malformed-toml",
            `Bozuk TOML (satır ${String(lineNumber)}): mükerrer tablo başlığı [${header}]`,
          );
        }
        seenStandardTables.add(header);
      }
      builders.push({ header, lines: [line] });
      continue;
    }

    const eqIdx = findTopLevelEquals(effectiveCode);
    if (eqIdx <= 0) {
      throw new CausorynCliError(
        "cli/malformed-toml",
        `Bozuk TOML (satır ${String(lineNumber)}): anahtar = değer ataması bekleniyordu`,
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
        `Bozuk TOML (satır ${String(lineNumber)}): eksik anahtar veya değer`,
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
      "Bozuk TOML: dosya sonunda kapanmamış çok-satırlı değer veya dizi/tablo",
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
    });
  }

  return { eol, sections };
}

export function validateTomlStructure(rawToml: string): void {
  parseTomlDocument(rawToml);
}

function renderCausorynSections(spec: CodexMcpServerSpec): TomlSection[] {
  const timeoutSec = spec.startupTimeoutSec ?? DEFAULT_STARTUP_TIMEOUT_SEC;
  const formattedArgs = spec.args.map((arg) => formatTomlBasicString(arg)).join(", ");
  const mainLines = [
    `[${CAUSORYN_TABLE}]`,
    `command = ${formatTomlBasicString(spec.command)}`,
    `args = [${formattedArgs}]`,
    `startup_timeout_sec = ${String(timeoutSec)}`,
  ];

  const out: TomlSection[] = [
    {
      header: CAUSORYN_TABLE,
      leadingComments: [],
      lines: mainLines,
    },
  ];

  const envEntries = spec.env !== undefined ? Object.entries(spec.env) : [];
  if (envEntries.length > 0) {
    envEntries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const envLines = [
      `[${CAUSORYN_ENV_TABLE}]`,
      ...envEntries.map(([k, v]) => `${formatTomlKey(k)} = ${formatTomlBasicString(v)}`),
    ];
    out.push({
      header: CAUSORYN_ENV_TABLE,
      leadingComments: [],
      lines: envLines,
    });
  }

  return out;
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

  const outputSections: TomlSection[] = [];
  let inserted = false;

  const hasExistingMain = parsed.sections.some((s) => s.header === CAUSORYN_TABLE);

  for (const section of parsed.sections) {
    if (section.header === CAUSORYN_TABLE) {
      if (!inserted) {
        const firstReplacement = replacement[0];
        if (firstReplacement !== undefined) {
          outputSections.push({
            header: firstReplacement.header,
            leadingComments: section.leadingComments,
            lines: firstReplacement.lines,
          });
          for (let i = 1; i < replacement.length; i += 1) {
            const extra = replacement[i];
            if (extra !== undefined) outputSections.push(extra);
          }
        }
        inserted = true;
      }
      continue;
    }

    if (section.header === CAUSORYN_ENV_TABLE) {
      // Yeni env varsa yukarıda replacement ile eklendi; eski env düşürülür.
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

function parseTomlStringArray(rawValue: string): string[] {
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new CausorynCliError("cli/malformed-toml", `TOML dizi bekleniyordu: ${rawValue}`);
  }
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
        items.push(unescapeTomlString(piece));
      }
      current = "";
      continue;
    }
    current += ch;
  }

  const tail = current.trim();
  if (tail.length > 0) {
    items.push(unescapeTomlString(tail));
  }
  return items;
}

export function readCodexMcpServer(rawToml: string): ParsedCodexMcpServer | null {
  const parsed = parseTomlDocument(rawToml);
  const target = parsed.sections.find((s) => s.header === CAUSORYN_TABLE);
  if (target === undefined) {
    return null;
  }

  let command: string | null = null;
  let args: string[] = [];
  let startupTimeoutSec: number | null = null;

  const state: ScanState = {
    inMultilineBasic: false,
    inMultilineLiteral: false,
    bracketDepth: 0,
    braceDepth: 0,
  };

  let pendingAssignment = "";
  for (let i = 1; i < target.lines.length; i += 1) {
    const line = target.lines[i] ?? "";
    const { effectiveCode } = scanTomlLine(line, i + 1, state);
    if (effectiveCode.length === 0) continue;
    pendingAssignment =
      pendingAssignment.length === 0 ? effectiveCode : `${pendingAssignment} ${effectiveCode}`;
    if (state.bracketDepth > 0 || state.braceDepth > 0) {
      continue;
    }

    const eqIdx = findTopLevelEquals(pendingAssignment);
    const assignment = pendingAssignment;
    pendingAssignment = "";
    if (eqIdx <= 0) continue;

    const key = assignment.slice(0, eqIdx).trim();
    const val = assignment.slice(eqIdx + 1).trim();
    if (key === "command") {
      command = unescapeTomlString(val);
    } else if (key === "args") {
      args = parseTomlStringArray(val);
    } else if (key === "startup_timeout_sec") {
      const parsedNum = Number.parseInt(val, 10);
      if (Number.isFinite(parsedNum)) {
        startupTimeoutSec = parsedNum;
      }
    }
  }

  if (command === null) {
    return null;
  }
  return { command, args, startupTimeoutSec };
}
