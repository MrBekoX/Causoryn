import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Runtime text produced by @causoryn/workspace (policy decisions' `reason`,
 * error messages, zod issue messages, matched-rule labels) must be plain
 * English and must not leak internal tracker codes. Every string literal and
 * template chunk in `src/` is scanned; comments are not.
 */

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

const TURKISH_LETTERS = /[çğıöşüÇĞİÖŞÜ]/u;
/** Turkish words that carry no Turkish-specific letters (ASCII-only spelling). */
const ASCII_TURKISH_WORDS =
  /\b(?:olmali|olamaz|degil|icin|veya|ile|bir|yok|kok|dosya|boyutu|deseni|elemani|bayt|uzanti|aday|yol|dizin|dizini)\b/iu;
const TRACKER_CODES = /TŞ|§|\bK-0\d\d\b/u;

interface Finding {
  readonly location: string;
  readonly text: string;
}

function collectFindings(file: string): Finding[] {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const text = node.text;
      if (
        TURKISH_LETTERS.test(text) ||
        ASCII_TURKISH_WORDS.test(text) ||
        TRACKER_CODES.test(text)
      ) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        findings.push({ location: `${path.basename(file)}:${String(line + 1)}`, text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

describe("@causoryn/workspace runtime strings", () => {
  it("contain no Turkish text and no internal tracker codes", () => {
    const files = readdirSync(SRC_DIR)
      .filter((name) => name.endsWith(".ts"))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    const findings = files.flatMap((name) => collectFindings(path.join(SRC_DIR, name)));
    expect(findings).toEqual([]);
  });
});
