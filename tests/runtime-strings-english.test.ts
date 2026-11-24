import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Source-level gate: runtime strings (error messages, rationales, limitations,
 * reasons, diagnostics, stderr logs) produced by the MCP server services, the
 * preflight package and the verification package must be plain English and
 * must not leak internal tracker codes (spec section refs, decision ids,
 * sprint/phase ids).
 *
 * Every string literal and template-literal chunk in the covered source files
 * is checked. Code comments are not checked.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const COVERED_DIRS = [
  "packages/mcp-server/src",
  "packages/preflight/src",
  "packages/verification/src",
] as const;

/** Files in the covered dirs that are owned by other work streams. */
const EXCLUDED_FILES = new Set([
  "packages/mcp-server/src/runtime-cli.ts",
  "packages/mcp-server/src/cli-stdio.ts",
  "packages/mcp-server/src/context.ts",
  "packages/mcp-server/src/version.ts",
]);

const TURKISH_DIACRITICS = /[çğıöşüÇĞİÖŞÜ]/;
/** Turkish words that never occur in English runtime text (ASCII-only spellings). */
const TURKISH_ASCII_WORDS =
  /\b(?:veya|ile|icin|degil|aday|kenar|hedef|belirsiz|denetimi|istenen|istenmedi|bilinmeyen|yetkilendirilmedi|buldu|tavan|analiz|edilemedi|edilmedi|bulunamadi|cozulemedi)\b/i;
/** Internal spec/decision/sprint codes that must not reach users. */
const INTERNAL_CODES =
  /TŞ|§|\bK-\d{3}\b|\bADR-\d{3}\b|\b[BCDEFW]\d+\b|\bFaz [A-Z]\b|\bsprint-\d+\b/;

/**
 * Deliberately kept literals: the stderr ready marker is matched verbatim by
 * other entry points and test harnesses, so it is changed in one coordinated
 * step rather than per file.
 */
const ALLOWED_LITERALS = new Set(["causoryn mcp server hazir ("]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(rel));
    } else if (/\.(?:ts|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(rel);
    }
  }
  return out;
}

function collectStringChunks(relPath: string): Array<{ line: number; text: string }> {
  const absolute = join(REPO_ROOT, relPath);
  const source = readFileSync(absolute, "utf8");
  const file = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true);
  const chunks: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      chunks.push({
        line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        text: node.text,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return chunks;
}

describe("runtime strings of mcp-server services, preflight and verification are English", () => {
  const files = COVERED_DIRS.flatMap((dir) => listSourceFiles(dir))
    .map((path) => path.split(sep).join("/"))
    .filter((path) => !EXCLUDED_FILES.has(path))
    .sort();

  it("covers the expected source files", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("packages/mcp-server/src/services.ts");
    expect(files).toContain("packages/preflight/src/test-plan.ts");
    expect(files).toContain("packages/verification/src/verify-change.ts");
  });

  it("no string literal contains Turkish text or internal tracker codes", () => {
    const offenders: string[] = [];
    for (const path of files) {
      for (const { line, text } of collectStringChunks(path)) {
        if (ALLOWED_LITERALS.has(text)) continue;
        const reasons: string[] = [];
        if (TURKISH_DIACRITICS.test(text)) reasons.push("turkish-diacritics");
        if (TURKISH_ASCII_WORDS.test(text)) reasons.push("turkish-word");
        if (INTERNAL_CODES.test(text)) reasons.push("internal-code");
        if (reasons.length > 0) {
          offenders.push(`${relative(REPO_ROOT, join(REPO_ROOT, path))}:${String(line)} [${reasons.join(",")}] ${JSON.stringify(text)}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
