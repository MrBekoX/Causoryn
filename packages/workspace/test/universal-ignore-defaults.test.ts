import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BINARY_EXTENSIONS,
  DEFAULT_IGNORE_PATTERNS,
  WorkspaceAccessPolicy,
  matchesIgnorePattern,
  parseWorkspacePolicyConfig,
} from "../src/index.js";

// Causoryn v0.2.3 — Universal Safe Ignore & Binary Defaults (AC-3, AC-4).
//
// Kırmızı çizgiler:
// - TŞ §20'deki 7 zorunlu default ignore deseni bire bir korunur (`**/bin/**` dahil).
// - `**/build/**` ve `**/out/**` default listeye EKLENMEZ (`src/build/keep.ts` izinli kalır).
// - Yalnızca kesin (unambiguous) ekosistem cache/vendor/minified dizin ve desenleri ile
//   kaynak-dışı paket/ML/sourcemap uzantıları varsayılan kara listeye eklenir.

const TS_SECTION_20_PATTERNS = [
  "**/.git/**",
  "**/node_modules/**",
  "**/bin/**",
  "**/obj/**",
  "**/dist/**",
  "**/.env*",
  "**/*.pem",
] as const;

const NEW_UNIVERSAL_IGNORE_DIRS = [
  "vendor",
  "Pods",
  ".gradle",
  ".angular",
  ".expo",
  ".idea",
  ".dart_tool",
  ".terraform",
  ".tox",
  ".nox",
  ".parcel-cache",
  ".vite",
] as const;

const NEW_UNIVERSAL_IGNORE_PATTERNS = [
  ...NEW_UNIVERSAL_IGNORE_DIRS.map((dir) => `**/${dir}/**`),
  "**/*.min.js",
  "**/*.min.mjs",
] as const;

const NEW_UNIVERSAL_BINARY_EXTENSIONS = [
  ".map",
  ".pyo",
  ".whl",
  ".egg",
  ".dmg",
  ".pkg",
  ".deb",
  ".rpm",
  ".iso",
  ".parquet",
  ".feather",
  ".arrow",
  ".h5",
  ".onnx",
  ".pt",
  ".pth",
  ".safetensors",
  ".ckpt",
  ".tflite",
  ".gguf",
] as const;

function makeTempWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "causoryn-univ-defaults-"));
}

describe("v0.2.3 evrensel güvenli ignore ve binary varsayılanları", () => {
  it("TŞ §20'deki 7 zorunlu default ignore desenini bire bir korur ve build/out'u eklemez", () => {
    for (const required of TS_SECTION_20_PATTERNS) {
      expect(DEFAULT_IGNORE_PATTERNS, `TŞ §20 deseni korunmalı: ${required}`).toContain(required);
    }
    expect(DEFAULT_IGNORE_PATTERNS).not.toContain("**/build/**");
    expect(DEFAULT_IGNORE_PATTERNS).not.toContain("**/out/**");

    const parsed = parseWorkspacePolicyConfig({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.ignore).toEqual(DEFAULT_IGNORE_PATTERNS);
    expect(parsed.config.binaryExtensions).toEqual(DEFAULT_BINARY_EXTENSIONS);
  });

  it("src/build/keep.ts ve src/out/keep.ts varsayılan politikada izinli kalır", () => {
    const root = makeTempWorkspace();
    try {
      mkdirSync(path.join(root, "src", "build"), { recursive: true });
      mkdirSync(path.join(root, "src", "out"), { recursive: true });
      writeFileSync(path.join(root, "src", "build", "keep.ts"), "export const keepBuild = 1;\n");
      writeFileSync(path.join(root, "src", "out", "keep.ts"), "export const keepOut = 2;\n");

      const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
      expect(policy.checkFile(root, "src/build/keep.ts").allowed).toBe(true);
      expect(policy.checkFile(root, "src/out/keep.ts").allowed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("yeni evrensel ekosistem cache/vendor dizinleri ile *.min.js / *.min.mjs varsayılan olarak reddedilir", () => {
    for (const pattern of NEW_UNIVERSAL_IGNORE_PATTERNS) {
      expect(DEFAULT_IGNORE_PATTERNS, `eksik default ignore deseni: ${pattern}`).toContain(pattern);
    }

    const root = makeTempWorkspace();
    try {
      for (const dir of NEW_UNIVERSAL_IGNORE_DIRS) {
        mkdirSync(path.join(root, dir, "sub"), { recursive: true });
        writeFileSync(path.join(root, dir, "sub", "sample.ts"), "export const x = 1;\n");
        mkdirSync(path.join(root, "apps", "web", dir), { recursive: true });
        writeFileSync(path.join(root, "apps", "web", dir, "nested.ts"), "export const y = 2;\n");
      }
      mkdirSync(path.join(root, "assets"), { recursive: true });
      writeFileSync(path.join(root, "assets", "bundle.min.js"), "var a=1;");
      writeFileSync(path.join(root, "assets", "bundle.min.mjs"), "export const a=1;");
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(path.join(root, "src", "app.js"), "export const app = 1;\n");
      writeFileSync(path.join(root, "src", "app.mjs"), "export const appMjs = 2;\n");

      const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
      for (const dir of NEW_UNIVERSAL_IGNORE_DIRS) {
        const rootDecision = policy.checkPath(root, `${dir}/sub/sample.ts`);
        expect(rootDecision.allowed, `${dir} kök altında reddedilmeli`).toBe(false);
        const nestedDecision = policy.checkPath(root, `apps/web/${dir}/nested.ts`);
        expect(nestedDecision.allowed, `${dir} alt dizinde reddedilmeli`).toBe(false);
      }

      expect(policy.checkFile(root, "assets/bundle.min.js").allowed).toBe(false);
      expect(policy.checkFile(root, "assets/bundle.min.mjs").allowed).toBe(false);
      expect(policy.checkFile(root, "src/app.js").allowed).toBe(true);
      expect(policy.checkFile(root, "src/app.mjs").allowed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("yeni paket/ML/sourcemap ikili uzantıları DEFAULT_BINARY_EXTENSIONS içinde yer alır ve reddedilir", () => {
    for (const ext of NEW_UNIVERSAL_BINARY_EXTENSIONS) {
      expect(DEFAULT_BINARY_EXTENSIONS, `eksik binary uzantı: ${ext}`).toContain(ext);
    }

    const root = makeTempWorkspace();
    try {
      mkdirSync(path.join(root, "artifacts"), { recursive: true });
      for (const ext of NEW_UNIVERSAL_BINARY_EXTENSIONS) {
        writeFileSync(path.join(root, "artifacts", `sample${ext}`), "BIN");
      }
      writeFileSync(path.join(root, "artifacts", "MODEL.ONNX"), "BIN");
      writeFileSync(path.join(root, "artifacts", "app.js.MAP"), "{}");
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(path.join(root, "src", "index.ts"), "export const ok = true;\n");

      const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
      for (const ext of NEW_UNIVERSAL_BINARY_EXTENSIONS) {
        const decision = policy.checkFile(root, `artifacts/sample${ext}`);
        expect(decision.allowed, `uzantı reddedilmeli: ${ext}`).toBe(false);
        if (!decision.allowed) {
          expect(decision.code).toBe("workspace/path-denied");
          expect(decision.rule).toBe(ext);
        }
      }

      // Case-insensitive uzantı denetimi:
      expect(policy.checkFile(root, "artifacts/MODEL.ONNX").allowed).toBe(false);
      expect(policy.checkFile(root, "artifacts/app.js.MAP").allowed).toBe(false);
      // Normal kaynak dosya izinli:
      expect(policy.checkFile(root, "src/index.ts").allowed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("v0.2.3 SEC-01 & SEC-05: polinomik glob eşleyici (ReDoS yok) ve önbellek dayanıklılığı", () => {
  it("SEC-01: geri izleme patlaması üreten *a*a...*b desenini < 50 ms içinde deterministik eşler", () => {
    const adversarial = `${"*a".repeat(25)}*b`;
    const candidate = "a".repeat(45);

    const t0 = performance.now();
    expect(matchesIgnorePattern(candidate, false, adversarial)).toBe(false);
    expect(matchesIgnorePattern(`dir/${candidate}`, false, `dir/${adversarial}`)).toBe(false);
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs, `ReDoS şüphesi: ${elapsedMs.toFixed(1)} ms`).toBeLessThan(50);
    expect(matchesIgnorePattern(`${candidate}b`, false, adversarial)).toBe(true);
  });

  it("SEC-01: RegExp özel karakterlerini literal olarak ve ** / dirOnly semantiğini bire bir korur", () => {
    expect(matchesIgnorePattern("src/[id]/page.ts", false, "src/[id]/*.ts")).toBe(true);
    expect(matchesIgnorePattern("src/i/page.ts", false, "src/[id]/*.ts")).toBe(false);
    expect(matchesIgnorePattern("a+b(1)$^.{x}.ts", false, "a+b(1)$^.{x}.ts")).toBe(true);
    expect(matchesIgnorePattern("frontend/build", true, "frontend/**/build/")).toBe(true);
    expect(matchesIgnorePattern("frontend/build", false, "frontend/**/build/")).toBe(false);
    expect(matchesIgnorePattern("frontend/a/b/build", true, "frontend/**/build/")).toBe(true);
    expect(matchesIgnorePattern("x", false, "**")).toBe(true);
    expect(matchesIgnorePattern("a/b/c", false, "**")).toBe(true);
    expect(matchesIgnorePattern("pkg/dist", true, "pkg/dist/**")).toBe(true);
    expect(matchesIgnorePattern("pkg/dist/a/b.js", false, "pkg/dist/**")).toBe(true);
  });

  it("SEC-05: 1500+ benzersiz desenle önbellek thrashing olmadan hızlı çalışır", () => {
    const patterns: string[] = [];
    for (let i = 0; i < 1_500; i += 1) {
      patterns.push(`pkg-${String(i).padStart(4, "0")}/**/gen-*.tmp`);
    }
    const t0 = performance.now();
    for (let round = 0; round < 3; round += 1) {
      for (const p of patterns) {
        expect(matchesIgnorePattern("src/app.ts", false, p)).toBe(false);
      }
    }
    expect(matchesIgnorePattern("pkg-0750/sub/gen-1.tmp", false, patterns[750] as string)).toBe(true);
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(200);
  });
});
