import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeTypeScriptProgram,
  type TsAdapterSourceFile,
  type TypeScriptAdapterResult,
} from "../src/index.js";

/**
 * Module-format detection (ESM vs CommonJS) must follow TypeScript's own
 * rules for `module: node16/nodenext`: `.mts`/`.cts` force the format, and
 * `.ts`/`.tsx` follow the nearest `package.json` `"type"` field. A file in an
 * ESM package that uses `import.meta` must not produce TS1470 ("not allowed in
 * files which will build into CommonJS output"), while a genuine CommonJS
 * package that misuses `import.meta` still must (the diagnostic is not
 * filtered, the format is detected).
 *
 * Disk fixtures live only under os.tmpdir() and are removed after each test;
 * the analyzer itself never writes.
 */

const IMPORT_META_SOURCE = "export const here: string = import.meta.url;\n";
const NODENEXT_TSCONFIG = JSON.stringify({
  compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true },
});
/** Causoryn-style solution root: no compilerOptions, only project references. */
const SOLUTION_TSCONFIG = JSON.stringify({
  files: [],
  references: [{ path: "packages/esm-pkg" }, { path: "packages/cjs-pkg" }],
});

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeFixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), "causoryn-module-format-"));
  tempRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return root;
}

function pick(
  files: Readonly<Record<string, string>>,
  predicate: (relativePath: string) => boolean,
): TsAdapterSourceFile[] {
  return Object.entries(files)
    .filter(([relativePath]) => predicate(relativePath))
    .map(([relativePath, content]) => ({ relativePath, content }));
}

const isSource = (p: string): boolean => /\.(?:ts|mts|cts)$/.test(p);
const isTsConfig = (p: string): boolean => p.endsWith("tsconfig.json");
const isPackageJson = (p: string): boolean => p.endsWith("package.json");

/** Mirrors the indexing call shape: sources + tsconfig files in memory, package.json via safe disk discovery. */
function analyzeOnDisk(files: Readonly<Record<string, string>>): TypeScriptAdapterResult {
  const root = writeFixture(files);
  return analyzeTypeScriptProgram({
    workspaceId: "ws-module-format",
    rootDir: root,
    sources: pick(files, isSource),
    configFiles: pick(files, isTsConfig),
  });
}

function ts1470Paths(result: TypeScriptAdapterResult): string[] {
  return result.diagnostics
    .filter((diagnostic) => diagnostic.code === "TS1470")
    .map((diagnostic) => diagnostic.relativePath)
    .sort();
}

// CPU-bound ts.createProgram runs: explicit budget for parallel-suite load
// (same convention as framework-linkers.test.ts); assertions are not relaxed.
describe("TypeScript adapter: ESM/CommonJS module-format detection", { timeout: 60_000 }, () => {
  it("ESM package (package.json type=module, nodenext) using import.meta yields no TS1470", () => {
    const result = analyzeOnDisk({
      "package.json": JSON.stringify({ name: "esm-app", type: "module" }),
      "tsconfig.json": NODENEXT_TSCONFIG,
      "src/here.ts": IMPORT_META_SOURCE,
    });
    expect(ts1470Paths(result)).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.state).toBe("ready");
  });

  it("CommonJS package misusing import.meta still reports TS1470 (diagnostic is not filtered)", () => {
    const result = analyzeOnDisk({
      "package.json": JSON.stringify({ name: "cjs-app" }),
      "tsconfig.json": NODENEXT_TSCONFIG,
      "src/here.ts": IMPORT_META_SOURCE,
    });
    expect(ts1470Paths(result)).toEqual(["src/here.ts"]);
    expect(result.state).toBe("partial");
  });

  it("nearest package.json decides per package in a monorepo with a reference-only root tsconfig", () => {
    const result = analyzeOnDisk({
      "package.json": JSON.stringify({
        name: "mono",
        private: true,
        type: "module",
        workspaces: ["packages/*"],
      }),
      "tsconfig.json": SOLUTION_TSCONFIG,
      "packages/esm-pkg/package.json": JSON.stringify({ name: "esm-pkg", type: "module" }),
      "packages/esm-pkg/src/a.ts": IMPORT_META_SOURCE,
      "packages/cjs-pkg/package.json": JSON.stringify({ name: "cjs-pkg", type: "commonjs" }),
      "packages/cjs-pkg/src/b.ts": IMPORT_META_SOURCE,
      "tools/root-script.ts": IMPORT_META_SOURCE,
    });
    expect(ts1470Paths(result)).toEqual(["packages/cjs-pkg/src/b.ts"]);
  });

  it(".mts forces ESM inside a CommonJS package and .cts forces CommonJS inside an ESM package", () => {
    const cjs = analyzeOnDisk({
      "package.json": JSON.stringify({ name: "cjs-app" }),
      "tsconfig.json": NODENEXT_TSCONFIG,
      "src/forced-esm.mts": IMPORT_META_SOURCE,
    });
    expect(ts1470Paths(cjs)).toEqual([]);

    const esm = analyzeOnDisk({
      "package.json": JSON.stringify({ name: "esm-app", type: "module" }),
      "tsconfig.json": NODENEXT_TSCONFIG,
      "src/forced-cjs.cts": IMPORT_META_SOURCE,
    });
    expect(ts1470Paths(esm)).toEqual(["src/forced-cjs.cts"]);
  });

  it("in-memory packageFiles drive the same detection without any disk access", () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "mono", private: true, type: "module" }),
      "tsconfig.json": SOLUTION_TSCONFIG,
      "packages/esm-pkg/package.json": JSON.stringify({ name: "esm-pkg", type: "module" }),
      "packages/esm-pkg/src/a.ts": IMPORT_META_SOURCE,
      "packages/cjs-pkg/package.json": JSON.stringify({ name: "cjs-pkg" }),
      "packages/cjs-pkg/src/b.ts": IMPORT_META_SOURCE,
    };
    const result = analyzeTypeScriptProgram({
      workspaceId: "ws-module-format-memory",
      rootDir: path.resolve(tmpdir(), "causoryn-module-format-virtual-root"),
      sources: pick(files, isSource),
      configFiles: pick(files, isTsConfig),
      packageFiles: pick(files, isPackageJson),
    });
    expect(ts1470Paths(result)).toEqual(["packages/cjs-pkg/src/b.ts"]);
  });

  it("detection is deterministic", () => {
    const files = {
      "package.json": JSON.stringify({ name: "esm-app", type: "module" }),
      "tsconfig.json": NODENEXT_TSCONFIG,
      "src/here.ts": IMPORT_META_SOURCE,
    };
    expect(JSON.stringify(analyzeOnDisk(files))).toBe(JSON.stringify(analyzeOnDisk(files)));
  });
});
