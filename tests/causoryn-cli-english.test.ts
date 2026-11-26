import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { readCodexMcpServer } from "../packages/causoryn/src/toml-patch.js";

/**
 * Regression guard: every user-facing runtime string of the `causoryn` CLI
 * package (setup, doctor, toml-patch, runtime staging, bin script, plugin
 * launcher, build/verify scripts) is plain English. Only string and template
 * literals are inspected (via the TypeScript AST), so code comments are out of
 * scope.
 */

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG_DIR = path.join(REPO_ROOT, "packages", "causoryn");
const TURKISH_LETTERS = /[çğıöşüÇĞİÖŞÜ]/;

function listSourceFiles(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out.sort();
}

interface LiteralHit {
  readonly where: string;
  readonly text: string;
}

function collectStringLiterals(file: string): LiteralHit[] {
  const source = readFileSync(file, "utf8");
  const kind = file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const label = path.relative(REPO_ROOT, file).replace(/\\/g, "/");
  const hits: LiteralHit[] = [];
  const push = (node: ts.Node, text: string): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    hits.push({ where: `${label}:${String(line)}`, text });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      push(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      push(node, [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("${}"));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("causoryn CLI package runtime strings are English", () => {
  const files = [
    ...listSourceFiles(path.join(PKG_DIR, "src"), [".ts"]),
    ...listSourceFiles(path.join(PKG_DIR, "scripts"), [".mjs"]),
  ];

  it("inspects the CLI sources and scripts", () => {
    const names = files.map((file) => path.relative(PKG_DIR, file).replace(/\\/g, "/"));
    for (const expected of [
      "src/cli.ts",
      "src/doctor.ts",
      "src/setup.ts",
      "src/toml-patch.ts",
      "src/runtime-stage.ts",
      "scripts/causoryn.mjs",
      "scripts/plugin-mcp-launcher.mjs",
      "scripts/build-package.mjs",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("has no Turkish text in any string or template literal", () => {
    const offenders = files
      .flatMap((file) => collectStringLiterals(file))
      .filter((hit) => TURKISH_LETTERS.test(hit.text));
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  it("detects Turkish literals while ignoring comments (mechanism check)", () => {
    const sf = ts.createSourceFile(
      "synthetic.ts",
      '// yorum: çalışma\nconst a = "kurulum onayı";\nconst b = `ok ${a} değil`;\nconst c = "fine";\n',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const texts: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) texts.push(node.text);
      else if (ts.isTemplateExpression(node)) texts.push(node.head.text + node.templateSpans.map((s) => s.literal.text).join(""));
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(texts.filter((text) => TURKISH_LETTERS.test(text))).toEqual(["kurulum onayı", "ok  değil"]);
  });
});

describe("causoryn TOML patch errors are English", () => {
  it("reports a non-array Codex `args` value in English (no Turkish letters needed to be Turkish)", () => {
    // CAU-12: the message names the location and key, never the raw value.
    let message = "";
    try {
      readCodexMcpServer('[mcp_servers.causoryn]\ncommand = "node"\nargs = "not-an-array"\n');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/^Malformed TOML \(line 3\): mcp_servers\.causoryn\.args must be an array of TOML strings$/);
    expect(message).not.toContain("not-an-array");
  });
});
