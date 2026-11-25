/**
 * Escaping helpers for text rendered into Markdown and Mermaid documents.
 *
 * Values that come from an analysed repository (file paths, symbol and module
 * names) or from host-supplied annotations are untrusted text. When they are
 * written into a generated document they must render as literal text and must
 * never introduce document structure: raw HTML, links, images, autolinks,
 * code spans or fences, headings, blockquotes, table cells, extra lines, or
 * Mermaid statements and directives.
 *
 * There is exactly one helper per output context:
 * - `escapeMarkdownInline`: single-line text inside a paragraph, list item,
 *   heading or blockquote line.
 * - `escapeMarkdownTableCell`: one cell of a GFM table row.
 * - `escapeMarkdownBlock`: multi-line prose; the line structure is kept and
 *   every line is escaped like inline text.
 * - `markdownCodeSpan`: an identifier rendered as a Markdown code span.
 * - `escapeMermaidLabel`: text inside a double-quoted Mermaid label
 *   (`id["..."]`, `subgraph id["..."]`, `-->|"..."|`). Mermaid node and
 *   subgraph ids are never derived from untrusted text; callers generate
 *   them (`n0`, `m1`, `sg2`, ...).
 *
 * All helpers are pure and deterministic. Line endings follow CommonMark
 * (LF, CR, CRLF) plus U+2028/U+2029; other C0/C1 control characters and DEL
 * are replaced with U+FFFD (CommonMark already maps NUL to U+FFFD).
 */

const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/**
 * Markdown characters escaped with a backslash. CommonMark allows a backslash
 * escape before any ASCII punctuation character, so the escaped text renders
 * exactly as the original characters:
 * - `\` escape character itself
 * - `` ` `` and `~` code spans, backtick and tilde fences, strikethrough
 * - `[` `]` `(` `)` `!` links, images, reference definitions
 * - `<` `>` raw HTML, angle-bracket autolinks, blockquote markers
 * - `#` ATX headings
 * - `|` GFM table cell delimiters
 */
const MARKDOWN_SPECIAL_CHARACTERS = /[\\`~[\]()!<>#|]/g;

/** GFM extended autolinks (`https://`, `http://`, `ftp://`, `www.`). */
const AUTOLINK_SCHEME = /(https?|ftp)(?=:\/\/)/gi;
const AUTOLINK_WWW = /(www)(?=\.)/gi;

function isControlCharacter(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * Normalises line endings and control characters. `lineBreak` replaces every
 * line ending (CRLF counts once); `tab` replaces TAB. When `collapse` is set a
 * run of line endings/tabs becomes one replacement (single-line contexts).
 */
function normalizeText(
  value: string,
  lineBreak: string,
  tab: string,
  collapse: boolean,
): string {
  let out = "";
  let pendingBreak = false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    let replacement: string | undefined;
    if (code === 0x0d) {
      if (value.charCodeAt(i + 1) === 0x0a) i += 1;
      replacement = lineBreak;
    } else if (code === 0x0a || code === 0x2028 || code === 0x2029) {
      replacement = lineBreak;
    } else if (code === 0x09) {
      replacement = tab;
    }
    if (replacement !== undefined) {
      if (collapse) {
        pendingBreak = true;
      } else {
        out += replacement;
      }
      continue;
    }
    if (pendingBreak) {
      out += lineBreak;
      pendingBreak = false;
    }
    out += isControlCharacter(code) ? REPLACEMENT_CHARACTER : value.charAt(i);
  }
  if (pendingBreak) out += lineBreak;
  return out;
}

/** Escapes one already-normalised line (no line endings inside). */
function escapeMarkdownLine(line: string): string {
  return line
    .replace(MARKDOWN_SPECIAL_CHARACTERS, "\\$&")
    .replace(AUTOLINK_SCHEME, "$1\\")
    .replace(AUTOLINK_WWW, "$1\\");
}

/**
 * Single-line Markdown text: line endings and tabs collapse to one space,
 * control characters become U+FFFD, structural characters are
 * backslash-escaped and bare autolinks are defanged (`https\://`, `www\.`).
 * The result also escapes `|`, so it is safe inside a table cell.
 */
export function escapeMarkdownInline(value: string): string {
  return escapeMarkdownLine(normalizeText(value, " ", " ", true));
}

/**
 * One GFM table cell. Identical to `escapeMarkdownInline` (which already
 * escapes `|` and removes line endings); kept as a named entry point so each
 * call site states its output context.
 */
export function escapeMarkdownTableCell(value: string): string {
  return escapeMarkdownInline(value);
}

/**
 * Multi-line Markdown prose: CR and CRLF become LF and the line structure is
 * kept, while every line is escaped like inline text. No line can open a
 * fence, heading, blockquote, HTML block, link or image. Plain list markers
 * (`-`, `*`, `+`, `1.`) are not escaped, so simple lists still render.
 */
export function escapeMarkdownBlock(value: string): string {
  return normalizeText(value, "\n", "\t", false)
    .split("\n")
    .map(escapeMarkdownLine)
    .join("\n");
}

/**
 * Markdown code span for an identifier. The fence is one backtick longer
 * than the longest backtick run inside the value, and a padding space is
 * added when CommonMark would otherwise merge or strip characters. Line
 * endings collapse to one space. Code span content is literal (no HTML, no
 * links), so nothing else is escaped. Not meant for GFM table cells, where
 * `|` would still split the row.
 */
export function markdownCodeSpan(value: string): string {
  const content = normalizeText(value, " ", " ", true);
  if (content.length === 0) return "` `";
  let longestRun = 0;
  let run = 0;
  for (const ch of content) {
    run = ch === "`" ? run + 1 : 0;
    if (run > longestRun) longestRun = run;
  }
  const fence = "`".repeat(longestRun + 1);
  const needsPadding =
    content.startsWith("`") ||
    content.endsWith("`") ||
    (content.startsWith(" ") && content.endsWith(" ") && content.trim().length > 0);
  const pad = needsPadding ? " " : "";
  return `${fence}${pad}${content}${pad}${fence}`;
}

/**
 * Text inside a double-quoted Mermaid label. Whitespace (including every line
 * ending) collapses to single spaces and the value is trimmed, then clipped
 * to `maxLength` characters (with `…`) BEFORE escaping, so an entity is never
 * cut in half. Escaping:
 * - `&`, `<`, `>`, `"` become HTML entities (`&amp;` first);
 * - `#` and the Mermaid-significant characters `` ` `` `|` `[` `]` `%` `{`
 *   `}` become Mermaid entity codes (`#35;`, `#96;`, ...), which Mermaid
 *   decodes for display. This keeps a label from closing its quotes, opening
 *   a Markdown-string label, forming a `%%{...}%%` directive or comment, or
 *   starting a new statement such as `click`.
 */
export function escapeMermaidLabel(value: string, maxLength = Number.POSITIVE_INFINITY): string {
  const flat = normalizeText(value, " ", " ", true).replace(/\s{2,}/g, " ").trim();
  const clipped = flat.length > maxLength ? `${flat.slice(0, Math.max(0, maxLength - 1))}…` : flat;
  return clipped
    .replace(/&/g, "&amp;")
    .replace(/#/g, "#35;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/`/g, "#96;")
    .replace(/\|/g, "#124;")
    .replace(/\[/g, "#91;")
    .replace(/\]/g, "#93;")
    .replace(/%/g, "#37;")
    .replace(/\{/g, "#123;")
    .replace(/\}/g, "#125;");
}
