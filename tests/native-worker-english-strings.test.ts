import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Source-level gate: every string literal in the native analysis workers
 * (Roslyn C#, Go, Rust and the Python worker) must be plain English, because
 * worker text (protocol errors, evidence rationales, ambiguity reasons,
 * warnings, diagnostics, stderr logs) reaches users and agents verbatim.
 *
 * The check runs a small per-language lexer over the sources: comments are
 * skipped (they may stay in any language), and Python string-expression
 * statements (docstrings) count as comments because their value is discarded
 * at runtime. Every other string literal, char literal and interpolated or
 * raw string is checked.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const NATIVE_DIR = "native";
const SKIPPED_DIRS = new Set(["bin", "obj", "target", "node_modules", "__pycache__"]);

type Lang = "cs" | "go" | "rs" | "py";

const TURKISH_LETTERS = /[çğıöşüÇĞİÖŞÜ]/;
/** Turkish words spelled without diacritics that never occur in the English worker text. */
const TURKISH_ASCII_WORDS =
  /\b(?:veya|ile|icin|degil|yok|olmali|olmalidir|girdisi|reddedildi|atlandi|gecersiz|bilinmeyen|desteklenen|bulunamadi|cozulemedi|cozumlenemedi|edilemedi|uretilmedi|cagri|anonim|uydurma|dizin|paket|zorunlu|zorunludur|alani|sayisi|siniri|asildi|bayt|yanit|istek|kaynak|dosya)\b/i;
/** Internal spec/decision tracker codes must not reach users either. */
const INTERNAL_CODES = /TŞ|§|\bK-\d{3}\b/;

interface StringLiteral {
  readonly line: number;
  readonly text: string;
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/**
 * Returns the string literals of `source`, skipping comments (and, for
 * Python, string-expression statements such as docstrings).
 */
function lexStringLiterals(source: string, lang: Lang): StringLiteral[] {
  const out: StringLiteral[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  // Python statement tracking: bracket depth and whether only whitespace or
  // comments were seen since the last logical line break.
  let depth = 0;
  let atStatementStart = true;

  const advance = (count = 1): void => {
    for (let k = 0; k < count && i < n; k += 1) {
      if (source[i] === "\n") line += 1;
      i += 1;
    }
  };
  const readQuoted = (close: string, escapes: boolean): string => {
    let text = "";
    while (i < n && !source.startsWith(close, i)) {
      if (escapes && source[i] === "\\") {
        text += source.slice(i, i + 2);
        advance(2);
        continue;
      }
      text += source[i];
      advance();
    }
    advance(close.length);
    return text;
  };
  const restOfLineIsBlank = (from: number): boolean => {
    for (let k = from; k < n; k += 1) {
      const ch = source[k];
      if (ch === "\n") return true;
      if (ch === "#") return true;
      if (ch !== " " && ch !== "\t" && ch !== "\r") return false;
    }
    return true;
  };

  while (i < n) {
    const c = source[i] as string;
    const c2 = source[i + 1];

    if (lang === "py") {
      if (c === "#") {
        while (i < n && source[i] !== "\n") advance();
        continue;
      }
      const prefix = /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(source.slice(i, i + 5));
      if (prefix !== null && !isIdentChar(source[i - 1])) {
        const startLine = line;
        const statementStart = atStatementStart && depth === 0;
        advance(prefix[0].length);
        const text = readQuoted(prefix[2] as string, true);
        const isExpressionStatement = statementStart && restOfLineIsBlank(i);
        if (!isExpressionStatement) out.push({ line: startLine, text });
        atStatementStart = false;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if ((c === ")" || c === "]" || c === "}") && depth > 0) depth -= 1;
      if (c === "\n") {
        if (depth === 0 && source[i - 1] !== "\\") atStatementStart = true;
      } else if (c === ";" && depth === 0) {
        atStatementStart = true;
      } else if (c !== " " && c !== "\t" && c !== "\r") {
        atStatementStart = false;
      }
      advance();
      continue;
    }

    // C-family comments.
    if (c === "/" && c2 === "/") {
      while (i < n && source[i] !== "\n") advance();
      continue;
    }
    if (c === "/" && c2 === "*") {
      let nesting = 1;
      advance(2);
      while (i < n && nesting > 0) {
        if (lang === "rs" && source[i] === "/" && source[i + 1] === "*") {
          nesting += 1;
          advance(2);
        } else if (source[i] === "*" && source[i + 1] === "/") {
          nesting -= 1;
          advance(2);
        } else {
          advance();
        }
      }
      continue;
    }

    if (lang === "go") {
      if (c === "`") {
        const startLine = line;
        advance();
        out.push({ line: startLine, text: readQuoted("`", false) });
        continue;
      }
      if (c === '"' || c === "'") {
        const startLine = line;
        advance();
        out.push({ line: startLine, text: readQuoted(c, true) });
        continue;
      }
    }

    if (lang === "rs") {
      const rawString = /^b?r(#*)"/.exec(source.slice(i, i + 32));
      if (rawString !== null && !isIdentChar(source[i - 1])) {
        const startLine = line;
        advance(rawString[0].length);
        out.push({ line: startLine, text: readQuoted(`"${rawString[1] ?? ""}`, false) });
        continue;
      }
      if (c === '"' || (c === "b" && c2 === '"' && !isIdentChar(source[i - 1]))) {
        const startLine = line;
        advance(c === "b" ? 2 : 1);
        out.push({ line: startLine, text: readQuoted('"', true) });
        continue;
      }
      if (c === "'") {
        // Char literal ('x', '\n', '\u{..}') or a lifetime ('a).
        if (c2 === "\\") {
          const startLine = line;
          advance();
          out.push({ line: startLine, text: readQuoted("'", true) });
          continue;
        }
        const codePoint = source.codePointAt(i + 1) ?? 0;
        const width = codePoint > 0xffff ? 2 : 1;
        if (source[i + 1 + width] === "'") {
          out.push({ line, text: source.slice(i + 1, i + 1 + width) });
          advance(2 + width);
          continue;
        }
        advance();
        continue;
      }
    }

    if (lang === "cs") {
      const rawString = /^\$*("{3,})/.exec(source.slice(i, i + 16));
      if (rawString !== null) {
        const startLine = line;
        advance(rawString[0].length);
        out.push({ line: startLine, text: readQuoted(rawString[1] as string, false) });
        continue;
      }
      const opener = /^(\$@|@\$|@|\$)?"/.exec(source.slice(i, i + 3));
      if (opener !== null) {
        const verbatim = (opener[1] ?? "").includes("@");
        const interpolated = (opener[1] ?? "").includes("$");
        const startLine = line;
        advance(opener[0].length);
        let text = "";
        let holeDepth = 0;
        while (i < n) {
          const ch = source[i] as string;
          if (interpolated && holeDepth === 0 && ch === "{" && source[i + 1] === "{") {
            text += "{";
            advance(2);
            continue;
          }
          if (interpolated && ch === "{") {
            holeDepth += 1;
          } else if (interpolated && holeDepth > 0 && ch === "}") {
            holeDepth -= 1;
          } else if (interpolated && holeDepth > 0 && ch === '"') {
            // Nested string literal inside an interpolation hole.
            text += ch;
            advance();
            text += readQuoted('"', true);
            text += '"';
            continue;
          } else if (verbatim && ch === '"' && source[i + 1] === '"') {
            text += '"';
            advance(2);
            continue;
          } else if (ch === '"') {
            advance();
            break;
          } else if (!verbatim && ch === "\\") {
            text += source.slice(i, i + 2);
            advance(2);
            continue;
          }
          text += ch;
          advance();
        }
        out.push({ line: startLine, text });
        continue;
      }
      if (c === "'") {
        const startLine = line;
        advance();
        out.push({ line: startLine, text: readQuoted("'", true) });
        continue;
      }
    }

    advance();
  }
  return out;
}

function langOf(name: string): Lang | null {
  if (name.endsWith(".cs")) return "cs";
  if (name.endsWith(".go")) return "go";
  if (name.endsWith(".rs")) return "rs";
  if (name.endsWith(".py")) return "py";
  return null;
}

function listNativeSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) out.push(...listNativeSources(rel));
    } else if (langOf(entry.name) !== null) {
      out.push(rel);
    }
  }
  return out.sort();
}

describe("native worker string-literal lexer", () => {
  it("C#: skips comments, reads regular, verbatim, interpolated, raw and char literals", () => {
    const source = [
      '// "commented ç"',
      '/* "block ş" */',
      'var a = "plain ğ";',
      'var b = @"verbatim ""ı"" here";',
      'var c = $"hole {Name(\\"x\\")} ö {{braces}}";',
      'var d = $"""raw ü""";',
      "var e = 'ç';",
    ].join("\n");
    const texts = lexStringLiterals(source, "cs").map((literal) => literal.text);
    expect(texts.some((text) => text.includes("commented") || text.includes("block"))).toBe(false);
    expect(texts.some((text) => text.includes("plain ğ"))).toBe(true);
    expect(texts.some((text) => text.includes('verbatim "ı" here'))).toBe(true);
    expect(texts.some((text) => text.includes("ö {braces}"))).toBe(true);
    expect(texts).toContain("raw ü");
    expect(texts).toContain("ç");
  });

  it("Go: skips comments, reads interpreted, raw and rune literals", () => {
    const source = ['// "ç"', 'x := "a \\" ğ"', "y := `raw\nı`", "z := 'ş'"].join("\n");
    const literals = lexStringLiterals(source, "go");
    expect(literals.map((literal) => literal.text)).toEqual(['a \\" ğ', "raw\nı", "ş"]);
    // The raw string spans lines 3-4, so the rune literal sits on line 5.
    expect(literals[2]?.line).toBe(5);
  });

  it("Rust: skips nested comments and lifetimes, reads strings, raw strings and chars", () => {
    const source = [
      '/* outer /* "inner ç" */ still comment */',
      "fn f<'a>(x: &'a str) -> &'a str { x }",
      'let a = "esc \\" ğ";',
      'let b = r#"raw "ı" here"#;',
      "let c = 'ş';",
      "let d = '\\n';",
    ].join("\n");
    const texts = lexStringLiterals(source, "rs").map((literal) => literal.text);
    expect(texts).toEqual(['esc \\" ğ', 'raw "ı" here', "ş", "\\n"]);
  });

  it("Python: skips comments and docstrings, reads assigned, f- and implicitly concatenated strings", () => {
    const source = [
      '"""Module docstring ç."""',
      "# comment 'ş'",
      "def f(x):",
      '    """Function docstring ğ."""',
      "    message = f\"value {', '.join(x)} ı\"",
      "    parts = (",
      '        "first ö "',
      "        'second ü'",
      "    )",
      "    return message",
    ].join("\n");
    const texts = lexStringLiterals(source, "py").map((literal) => literal.text);
    expect(texts.some((text) => text.includes("docstring"))).toBe(false);
    expect(texts.some((text) => text.includes("comment"))).toBe(false);
    expect(texts).toContain("value {', '.join(x)} ı");
    expect(texts).toContain("first ö ");
    expect(texts).toContain("second ü");
  });
});

describe("native worker runtime strings are English", () => {
  const files = listNativeSources(NATIVE_DIR);

  it("covers every native worker", () => {
    expect(files).toContain("native/roslyn-worker/WorkerAnalyzer.cs");
    expect(files).toContain("native/roslyn-worker/ReferenceResolver.cs");
    expect(files).toContain("native/roslyn-worker/Program.cs");
    expect(files).toContain("native/go-worker/cmd/worker/main.go");
    expect(files).toContain("native/go-worker/internal/analyze/analyze.go");
    expect(files).toContain("native/rust-worker/src/analyzer.rs");
    expect(files).toContain("native/rust-worker/src/protocol.rs");
    expect(files).toContain("native/python-worker/worker.py");
    for (const file of files) {
      const lang = langOf(file) as Lang;
      const literals = lexStringLiterals(readFileSync(join(REPO_ROOT, file), "utf8"), lang);
      expect(literals.length, `${file} yielded no string literals`).toBeGreaterThan(0);
    }
  });

  it("no string literal contains Turkish text or internal tracker codes", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lang = langOf(file) as Lang;
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      for (const { line, text } of lexStringLiterals(source, lang)) {
        const reasons: string[] = [];
        if (TURKISH_LETTERS.test(text)) reasons.push("turkish-letters");
        if (TURKISH_ASCII_WORDS.test(text)) reasons.push("turkish-word");
        if (INTERNAL_CODES.test(text)) reasons.push("internal-code");
        if (reasons.length > 0) {
          offenders.push(`${file}:${String(line)} [${reasons.join(",")}] ${JSON.stringify(text.slice(0, 160))}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
