import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { tokenizeBraceSource } from "../src/index-service.js";

/**
 * The early-cutoff tokenizer (tokenizeBraceSource) must stay linear in the
 * length of its input (security finding F8, CWE-407): in JS/TS mode every `/`
 * after a regex-prefix token such as `(` or `[` starts a regex literal scan,
 * and a scan that finds no closing `/` on its line used to be thrown away, so
 * the next `/` scanned the same line tail again. One line of `(/[` repeated
 * cost about n^2/6 character reads (some 6.7e11 for a 2 MB file) on the
 * indexer and, through causoryn_verify_change, on the MCP main thread.
 *
 * The cost is measured deterministically: the source is a String object whose
 * own charCodeAt counts the character reads (no wall clock). The tokens must
 * stay byte-identical to the previous tokenizer, which is kept below as the
 * reference (a verbatim copy of the tokenizer before the fix).
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Character reads allowed per input character (the old tokenizer needed about 1,500 on the attack input below). */
const READS_PER_CHAR_BUDGET = 8;

/** A source whose charCodeAt calls are counted. */
function countingSource(text: string): { readonly source: string; readonly reads: () => number } {
  let reads = 0;
  const boxed = new String(text);
  Object.defineProperty(boxed, "charCodeAt", {
    value: (index: number): number => {
      reads += 1;
      return text.charCodeAt(index);
    },
  });
  return { source: boxed as unknown as string, reads: () => reads };
}

function readsPerChar(text: string, isJsTs: boolean): number {
  const counted = countingSource(text);
  tokenizeBraceSource(counted.source, { isJsTs });
  return counted.reads() / Math.max(1, text.length);
}

/* ------------------------------------------------------------------ */
/* Reference: the tokenizer before the fix (verbatim, for equivalence)  */
/* ------------------------------------------------------------------ */

function isIdentCharCode(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 36
  );
}

function isAsciiAlphaCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

const JS_REGEX_PREFIX_TOKENS = new Set([
  "(", "[", "{", "}", ";", ",", ":", "?", "=", "=>", "!", "~", "+", "-", "*", "/", "%", "&", "|", "^", "<", ">",
  "->", "::", "return", "throw", "case", "in", "instanceof", "typeof", "void", "delete", "new", "yield", "await",
  "of", "else", "do", "export", "default",
]);

function referenceTokenize(content: string, options: { readonly isJsTs?: boolean } = {}): string[] {
  const isJsTs = options.isJsTs ?? false;
  const tokens: string[] = [];
  const len = content.length;
  const templateBraceDepthStack: number[] = [];
  let i = 0;

  const scanJsTemplateChunk = (startIndex: number): void => {
    let cur = startIndex + 1;
    while (cur < len) {
      const code = content.charCodeAt(cur);
      if (code === 92) {
        cur = Math.min(len, cur + 2);
        continue;
      }
      if (code === 96) {
        cur += 1;
        tokens.push(content.slice(startIndex, cur));
        i = cur;
        return;
      }
      if (code === 36 && cur + 1 < len && content.charCodeAt(cur + 1) === 123) {
        cur += 2;
        tokens.push(content.slice(startIndex, cur));
        templateBraceDepthStack.push(0);
        i = cur;
        return;
      }
      cur += 1;
    }
    tokens.push(content.slice(startIndex, len));
    i = len;
  };

  while (i < len) {
    const ch = content.charCodeAt(i);
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
      i += 1;
      continue;
    }
    if (ch === 47 && i + 1 < len && content.charCodeAt(i + 1) === 47) {
      i += 2;
      while (i < len && content.charCodeAt(i) !== 10) i += 1;
      continue;
    }
    if (ch === 47 && i + 1 < len && content.charCodeAt(i + 1) === 42) {
      i += 2;
      while (i + 1 < len && !(content.charCodeAt(i) === 42 && content.charCodeAt(i + 1) === 47)) {
        i += 1;
      }
      i = Math.min(len, i + 2);
      continue;
    }
    if (isJsTs && ch === 47) {
      const prev = tokens[tokens.length - 1];
      if (prev === undefined || JS_REGEX_PREFIX_TOKENS.has(prev)) {
        const start = i;
        let cur = i + 1;
        let inCharClass = false;
        let closed = false;
        while (cur < len) {
          const code = content.charCodeAt(cur);
          if (code === 10 || code === 13) {
            break;
          }
          if (code === 92) {
            if (cur + 1 < len && content.charCodeAt(cur + 1) !== 10 && content.charCodeAt(cur + 1) !== 13) {
              cur += 2;
            } else {
              break;
            }
            continue;
          }
          if (code === 91) {
            inCharClass = true;
            cur += 1;
            continue;
          }
          if (code === 93) {
            inCharClass = false;
            cur += 1;
            continue;
          }
          if (code === 47 && !inCharClass) {
            cur += 1;
            while (cur < len && isAsciiAlphaCode(content.charCodeAt(cur))) {
              cur += 1;
            }
            closed = true;
            break;
          }
          cur += 1;
        }
        if (closed) {
          tokens.push(content.slice(start, cur));
          i = cur;
          continue;
        }
      }
      tokens.push("/");
      i += 1;
      continue;
    }
    if (ch === 96) {
      if (isJsTs) {
        scanJsTemplateChunk(i);
        continue;
      }
      const start = i;
      i += 1;
      while (i < len && content.charCodeAt(i) !== 96) {
        i += 1;
      }
      if (i < len) i += 1;
      tokens.push(content.slice(start, i));
      continue;
    }
    if (isJsTs && templateBraceDepthStack.length > 0) {
      if (ch === 123) {
        templateBraceDepthStack[templateBraceDepthStack.length - 1] =
          (templateBraceDepthStack[templateBraceDepthStack.length - 1] ?? 0) + 1;
        tokens.push("{");
        i += 1;
        continue;
      }
      if (ch === 125) {
        const depth = templateBraceDepthStack[templateBraceDepthStack.length - 1] ?? 0;
        if (depth > 0) {
          templateBraceDepthStack[templateBraceDepthStack.length - 1] = depth - 1;
          tokens.push("}");
          i += 1;
          continue;
        }
        templateBraceDepthStack.pop();
        scanJsTemplateChunk(i);
        continue;
      }
    }
    if (ch === 34 || ch === 39) {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < len) {
        const cur = content.charCodeAt(i);
        if (cur === 92) {
          i = Math.min(len, i + 2);
          continue;
        }
        if (cur === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push(content.slice(start, i));
      continue;
    }
    if (isIdentCharCode(ch)) {
      const start = i;
      i += 1;
      while (i < len && isIdentCharCode(content.charCodeAt(i))) i += 1;
      tokens.push(content.slice(start, i));
      continue;
    }
    if (i + 1 < len) {
      const pair = content.slice(i, i + 2);
      if (pair === "=>" || pair === "::" || pair === "->" || pair === "++" || pair === "--" || pair === "</") {
        tokens.push(pair);
        i += 2;
        continue;
      }
    }
    tokens.push(content[i]!);
    i += 1;
  }
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Inputs                                                               */
/* ------------------------------------------------------------------ */

/** The finding's attack line: every `/` follows `(`, and the `[` it opens never closes. */
function attackLine(repeats: number): string {
  return "(/[".repeat(repeats);
}

/** Other shapes of unclosed regex candidates that share one line tail. */
const ADVERSARIAL_INPUTS: ReadonlyArray<readonly [string, string]> = [
  ["(/[ repeated", attackLine(3_000)],
  ["[/ repeated (the char class opened by the candidate itself)", "[/".repeat(4_500)],
  ["= /[ repeated", "= /[".repeat(2_250)],
  ["return /[ repeated", "return /[ ".repeat(900)],
  ["(/[ repeated with a trailing backslash before the line end", `${attackLine(3_000)}\\\n${attackLine(10)}`],
  ["(/[ repeated on many lines", `${attackLine(300)}\n`.repeat(10)],
  ["(/[ repeated with CRLF line ends", `${attackLine(300)}\r\n`.repeat(10)],
  ["(/\\[ escapes between the candidates", "(/\\[[".repeat(1_800)],
];

/** Realistic snippets around regex literals, division, templates, JSX and comments. */
const SNIPPETS: readonly string[] = [
  'const r = /"/g; export function f(a: number, b: number) { return a / b; }',
  "const re = /[/]+/; const x = a / b / c; const y = (a) / 2;",
  "export const t = `a${b}/c${ { x: 1 }.x }d`; const q = /`/;",
  "if (/^\\d+$/.test(v)) { return v.split(/\\s*,\\s*/); }",
  "const z = x ? /a/ : /b/; arr.map((s) => s.replace(/[\\]/]/g, ''));",
  "// comment with / slashes\n/* block / comment */ const k = 1 / 2;",
  "const jsx = <div className=\"a/b\">/path/</div>;",
  "x = {}/2; y = [1]; z = (/q/)",
  "a = {}/2; b = [(/x/)];",
  "const d = 4 /\n 2; const e = (/[\n/]/);",
  "label: for (;;) { break label; } const f = /\\//;",
  "s = 'it\\'s / fine'; t = \"a\\\"/b\"; u = /['\"]/;",
  "type T = Array<{ a: number }>; const g = <T,>(v: T) => v;",
  "export default /re/i; yield /y/; await /w/; typeof /t/;",
];

function sourceFilesUnder(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) sourceFilesUnder(full, out);
    else if (/\.(?:ts|tsx|js|mjs|cs|go|rs)$/.test(name)) out.push(full);
  }
}

/** Seeded PRNG (mulberry32): the same cases on every run. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const FUZZ_ALPHABET = [
  "(", "/", "[", "]", "\\", "\n", "\r", " ", "a", "1", '"', "'", "`", "{", "}", "$", "${", "*", ";", "=", "g",
  "<", ">", "=>", "return ", "//", "/*", "*/", ")",
];

describe("tokenizeBraceSource (early-cutoff interface surface lexer)", () => {
  it("scans the finding's attack line in linear time (counted character reads)", () => {
    const text = attackLine(3_000);
    expect(readsPerChar(text, true)).toBeLessThanOrEqual(READS_PER_CHAR_BUDGET);
  });

  it.each(ADVERSARIAL_INPUTS)("stays linear on %s", (_name, text) => {
    expect(readsPerChar(text, true)).toBeLessThanOrEqual(READS_PER_CHAR_BUDGET);
  });

  it("the cost per character does not grow with the input length", () => {
    const small = readsPerChar(attackLine(1_000), true);
    const large = readsPerChar(attackLine(8_000), true);
    expect(large).toBeLessThanOrEqual(small + 1);
  });

  it.each(ADVERSARIAL_INPUTS)("produces the previous tokens for %s", (_name, text) => {
    expect(tokenizeBraceSource(text, { isJsTs: true })).toEqual(referenceTokenize(text, { isJsTs: true }));
  });

  it("produces the previous tokens for realistic regex, division, template and JSX snippets", () => {
    for (const snippet of SNIPPETS) {
      for (const isJsTs of [true, false]) {
        expect(tokenizeBraceSource(snippet, { isJsTs }), snippet).toEqual(referenceTokenize(snippet, { isJsTs }));
      }
    }
  });

  it("produces the previous tokens for every source file of this repository", () => {
    const files: string[] = [];
    for (const top of ["packages", "adapters", "integrations", "tests", "native", "examples"]) {
      sourceFilesUnder(path.join(REPO_ROOT, top), files);
    }
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const isJsTs = /\.(?:ts|tsx|js|mjs)$/.test(file);
      const actual = tokenizeBraceSource(content, { isJsTs });
      const expected = referenceTokenize(content, { isJsTs });
      if (actual.length !== expected.length || actual.some((tok, index) => tok !== expected[index])) {
        expect(actual, path.relative(REPO_ROOT, file)).toEqual(expected);
      }
    }
  });

  it("produces the previous tokens for 20,000 seeded random inputs", () => {
    const random = prng(0xf8);
    for (let index = 0; index < 20_000; index += 1) {
      const length = Math.floor(random() * 48);
      let text = "";
      for (let k = 0; k < length; k += 1) {
        text += FUZZ_ALPHABET[Math.floor(random() * FUZZ_ALPHABET.length)];
      }
      const actual = tokenizeBraceSource(text, { isJsTs: true });
      const expected = referenceTokenize(text, { isJsTs: true });
      if (actual.length !== expected.length || actual.some((tok, k) => tok !== expected[k])) {
        expect(actual, JSON.stringify(text)).toEqual(expected);
      }
    }
  });
});
