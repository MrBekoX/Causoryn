import { describe, expect, it } from "vitest";

import {
  escapeMarkdownBlock,
  escapeMarkdownInline,
  escapeMarkdownTableCell,
  escapeMermaidLabel,
  markdownCodeSpan,
} from "../src/markup-escape.js";

/**
 * Output-context escaping helpers for Markdown and Mermaid documents.
 *
 * Every helper is exercised with fixed examples and with a seeded,
 * deterministic property run over hostile fragments (fence markers, Mermaid
 * directives, HTML, links, autolinks, control characters, every line-ending
 * form). The properties state the contract of each output context:
 * - nothing that can introduce structure survives unescaped;
 * - the escaped text still decodes back to the (normalised) original value.
 */

// Built from code points so no editor or tool turns them into raw line terminators.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const REPLACEMENT = String.fromCharCode(0xfffd);
/** Any line terminator that must not survive in a single-line context. */
const LINE_TERMINATORS = new RegExp("[\\r\\n\\u2028\\u2029]");

const HOSTILE_FRAGMENTS: readonly string[] = [
  "`",
  "```",
  "````mermaid",
  "~~~",
  "#",
  "## Fake heading",
  "\n",
  "\r",
  "\r\n",
  LINE_SEPARATOR,
  PARAGRAPH_SEPARATOR,
  "\t",
  " ",
  "    ",
  "<script>alert(1)</script >",
  "<img src=x onerror=alert(1)>",
  "![beacon](https://evil.test/b.png)",
  "[click](javascript:alert(1))",
  "<https://evil.test>",
  "|",
  "\\",
  "\\\\",
  ">",
  "> quote",
  "%%{init: {'theme':'dark'}}%%",
  "%%",
  "click m0 call alert(1)",
  "click m0 href \"https://evil.test\"",
  '"]',
  "\"",
  "'",
  "&",
  "&#96;",
  "&lt;",
  "#35;",
  "#quot;",
  "{",
  "}",
  "[",
  "]",
  "(",
  ")",
  "www.evil.test",
  "HTTPS://Evil.Test/x",
  "http://a.test",
  "ftp://files.test",
  "\u0000",
  "\u001b[31m",
  "\u007f",
  "\u0085",
  "a",
  "Z9",
  "Öğrenci",
  "🚀",
  "*",
  "_",
  ":",
  ";",
  "%",
  "-",
  "1.",
];

/** mulberry32: small deterministic PRNG so the property run is reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hostileSamples(count: number, seed: number): string[] {
  const next = prng(seed);
  const samples: string[] = [...HOSTILE_FRAGMENTS];
  for (let i = 0; i < count; i += 1) {
    const parts = 1 + Math.floor(next() * 8);
    let value = "";
    for (let p = 0; p < parts; p += 1) {
      value += HOSTILE_FRAGMENTS[Math.floor(next() * HOSTILE_FRAGMENTS.length)] ?? "";
    }
    samples.push(value);
  }
  return samples;
}

const SAMPLES = hostileSamples(600, 0x5eed);

/** CommonMark: a backslash before ASCII punctuation is an escape. */
const ASCII_PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

/** Characters that must never appear unescaped in Markdown text output. */
const MARKDOWN_STRUCTURAL = "\\`[]()#!|<>~";

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** Independent oracle for the single-line normalisation. */
function expectedInline(value: string): string {
  let out = "";
  let pendingSpace = false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x0d || code === 0x0a || code === 0x09 || code === 0x2028 || code === 0x2029) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += isControl(code) ? REPLACEMENT : (value[i] ?? "");
  }
  if (pendingSpace) out += " ";
  return out;
}

/** Independent oracle for the multi-line normalisation (structure kept). */
function expectedBlock(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x0d) {
      out += "\n";
      if (value.charCodeAt(i + 1) === 0x0a) i += 1;
      continue;
    }
    if (code === 0x0a || code === 0x2028 || code === 0x2029) {
      out += "\n";
      continue;
    }
    if (code === 0x09) {
      out += "\t";
      continue;
    }
    out += isControl(code) ? REPLACEMENT : (value[i] ?? "");
  }
  return out;
}

function unescapeMarkdown(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] ?? "";
    const nextCh = value[i + 1];
    if (ch === "\\" && nextCh !== undefined && ASCII_PUNCTUATION.includes(nextCh)) {
      out += nextCh;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Returns the first structural character that is not backslash-escaped. */
function firstUnescapedStructural(value: string): string | undefined {
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] ?? "";
    if (ch === "\\") {
      const nextCh = value[i + 1];
      if (nextCh === undefined || !ASCII_PUNCTUATION.includes(nextCh)) return "\\";
      i += 1;
      continue;
    }
    if (MARKDOWN_STRUCTURAL.includes(ch)) return ch;
  }
  return undefined;
}

const RAW_AUTOLINK = /(?:https?|ftp):\/\/|www\./i;

describe("escapeMarkdownInline", () => {
  it("leaves plain text untouched", () => {
    expect(escapeMarkdownInline("plain text 123 Öğrenci 🚀 OrdersService.create")).toBe(
      "plain text 123 Öğrenci 🚀 OrdersService.create",
    );
  });

  it("backslash-escapes code, fence, heading, HTML, link, image, table and escape characters", () => {
    expect(escapeMarkdownInline("a`b")).toBe("a\\`b");
    expect(escapeMarkdownInline("```")).toBe("\\`\\`\\`");
    expect(escapeMarkdownInline("~~~")).toBe("\\~\\~\\~");
    expect(escapeMarkdownInline("# h")).toBe("\\# h");
    expect(escapeMarkdownInline("<img src=x>")).toBe("\\<img src=x\\>");
    expect(escapeMarkdownInline("![a](b)")).toBe("\\!\\[a\\]\\(b\\)");
    expect(escapeMarkdownInline("a|b")).toBe("a\\|b");
    expect(escapeMarkdownInline("a\\b")).toBe("a\\\\b");
  });

  it("flattens every line-ending form and tabs into single spaces", () => {
    expect(
      escapeMarkdownInline(`x\r\ny\rz\nw${LINE_SEPARATOR}v${PARAGRAPH_SEPARATOR}u`),
    ).toBe("x y z w v u");
    expect(escapeMarkdownInline("a\t\t\nb")).toBe("a b");
  });

  it("defangs bare autolinks so a GFM viewer renders them as text", () => {
    expect(escapeMarkdownInline("https://evil.test/x")).toBe("https\\://evil.test/x");
    expect(escapeMarkdownInline("HTTP://X")).toBe("HTTP\\://X");
    expect(escapeMarkdownInline("ftp://h")).toBe("ftp\\://h");
    expect(escapeMarkdownInline("see www.evil.test")).toBe("see www\\.evil.test");
  });

  it("replaces control characters with U+FFFD", () => {
    expect(escapeMarkdownInline("a\u0000b\u001bc\u007fd\u0085")).toBe(
      `a${REPLACEMENT}b${REPLACEMENT}c${REPLACEMENT}d${REPLACEMENT}`,
    );
  });

  it("property: no structural character, line break or raw autolink survives, and the text round-trips", () => {
    for (const sample of SAMPLES) {
      const escaped = escapeMarkdownInline(sample);
      expect(escaped, JSON.stringify(sample)).not.toMatch(LINE_TERMINATORS);
      expect(firstUnescapedStructural(escaped), JSON.stringify(sample)).toBeUndefined();
      expect(RAW_AUTOLINK.test(escaped), JSON.stringify(sample)).toBe(false);
      expect(unescapeMarkdown(escaped), JSON.stringify(sample)).toBe(expectedInline(sample));
    }
  });
});

describe("escapeMarkdownTableCell", () => {
  it("is safe inside a GFM table row: pipes are escaped and the row cannot be split", () => {
    expect(escapeMarkdownTableCell("a|b\nc")).toBe("a\\|b c");
    for (const sample of SAMPLES) {
      const cell = escapeMarkdownTableCell(sample);
      expect(cell).not.toMatch(/(?<!\\)(?:\\\\)*\|/);
      expect(cell).not.toMatch(/[\r\n]/);
      expect(unescapeMarkdown(cell)).toBe(expectedInline(sample));
    }
  });
});

describe("escapeMarkdownBlock", () => {
  it("keeps the line structure and normalises CR/CRLF to LF", () => {
    expect(escapeMarkdownBlock("line1\r\nline2\rline3\nline4")).toBe("line1\nline2\nline3\nline4");
  });

  it("neutralises fences, headings, blockquotes, links and HTML on every line", () => {
    expect(escapeMarkdownBlock("```mermaid\nclick x\n```")).toBe(
      "\\`\\`\\`mermaid\nclick x\n\\`\\`\\`",
    );
    expect(escapeMarkdownBlock("- item [x](y)\n# Fake\n> quote\n~~~")).toBe(
      "- item \\[x\\]\\(y\\)\n\\# Fake\n\\> quote\n\\~\\~\\~",
    );
    expect(escapeMarkdownBlock("x\r```\r<b>")).toBe("x\n\\`\\`\\`\n\\<b\\>");
  });

  it("property: every line is inline-safe and the block round-trips", () => {
    for (const sample of SAMPLES) {
      const escaped = escapeMarkdownBlock(sample);
      expect(escaped).not.toMatch(new RegExp("[\\r\\u2028\\u2029]"));
      for (const line of escaped.split("\n")) {
        expect(firstUnescapedStructural(line), JSON.stringify(sample)).toBeUndefined();
        expect(RAW_AUTOLINK.test(line)).toBe(false);
      }
      expect(unescapeMarkdown(escaped), JSON.stringify(sample)).toBe(expectedBlock(sample));
    }
  });
});

describe("markdownCodeSpan", () => {
  it("wraps identifiers in a code span whose fence is longer than any backtick run", () => {
    expect(markdownCodeSpan("abc")).toBe("`abc`");
    expect(markdownCodeSpan("a`b")).toBe("``a`b``");
    expect(markdownCodeSpan("`a")).toBe("`` `a ``");
    expect(markdownCodeSpan("a``b`")).toBe("``` a``b` ```");
    expect(markdownCodeSpan("x\ny")).toBe("`x y`");
    expect(markdownCodeSpan("")).toBe("` `");
    expect(markdownCodeSpan("<b>|[x](y)")).toBe("`<b>|[x](y)`");
  });

  it("property: the CommonMark code span content equals the normalised value", () => {
    for (const sample of SAMPLES) {
      const span = markdownCodeSpan(sample);
      expect(span).not.toMatch(LINE_TERMINATORS);
      const fence = /^`+/.exec(span)?.[0] ?? "";
      expect(fence.length).toBeGreaterThan(0);
      expect(span.endsWith(fence)).toBe(true);
      let content = span.slice(fence.length, span.length - fence.length);
      // The fence must not occur inside the content (otherwise the span closes early).
      const runs = content.match(/`+/g) ?? [];
      for (const run of runs) expect(run.length).not.toBe(fence.length);
      if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") {
        content = content.slice(1, -1);
      }
      const expected = expectedInline(sample);
      expect(content, JSON.stringify(sample)).toBe(expected === "" ? " " : expected);
    }
  });
});

function decodeMermaidLabel(label: string): string {
  return label
    .replace(/#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function expectedMermaid(value: string): string {
  return expectedInline(value).replace(/\s{2,}/g, " ").trim();
}

describe("escapeMermaidLabel", () => {
  it("uses Mermaid entity codes for structural characters and HTML entities for markup", () => {
    expect(escapeMermaidLabel("a&b")).toBe("a&amp;b");
    expect(escapeMermaidLabel("C#")).toBe("C#35;");
    expect(escapeMermaidLabel('"x"')).toBe("&quot;x&quot;");
    expect(escapeMermaidLabel("<x>")).toBe("&lt;x&gt;");
    expect(escapeMermaidLabel("`x`")).toBe("#96;x#96;");
    expect(escapeMermaidLabel("a|b[c]")).toBe("a#124;b#91;c#93;");
  });

  it("neutralises Mermaid directives and statement injection", () => {
    expect(escapeMermaidLabel("%%{init: {'theme':'dark'}}%%")).toBe(
      "#37;#37;#123;init: #123;'theme':'dark'#125;#125;#37;#37;",
    );
    expect(escapeMermaidLabel('x"]\nclick m0 call alert(1)\n%%')).toBe(
      "x&quot;#93; click m0 call alert(1) #37;#37;",
    );
  });

  it("flattens whitespace and clips before escaping (no partial entity)", () => {
    expect(escapeMermaidLabel("  a \r\n\n b  ")).toBe("a b");
    expect(escapeMermaidLabel("abcdefgh", 5)).toBe("abcd…");
    expect(escapeMermaidLabel("&&&&&&&", 3)).toBe("&amp;&amp;…");
  });

  it("property: no quote, fence, directive or line-break character survives and the label decodes back", () => {
    for (const sample of SAMPLES) {
      const label = escapeMermaidLabel(sample);
      expect(label, JSON.stringify(sample)).not.toMatch(/["`%{}[\]|<>]/);
      expect(label, JSON.stringify(sample)).not.toMatch(LINE_TERMINATORS);
      expect(label.replace(/#\d+;/g, ""), JSON.stringify(sample)).not.toContain("#");
      expect(label.replace(/&(?:amp|lt|gt|quot);/g, ""), JSON.stringify(sample)).not.toContain("&");
      expect(decodeMermaidLabel(label), JSON.stringify(sample)).toBe(expectedMermaid(sample));
    }
  });
});
