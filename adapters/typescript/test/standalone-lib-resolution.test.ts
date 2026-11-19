import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuildBuild } from "esbuild";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { resolveTypeScriptLibDir } from "../src/analyzer.js";
import type {
  TypeScriptAdapterInput,
  TypeScriptAdapterResult,
} from "../src/types.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_DIR = path.dirname(TEST_DIR);
const ADAPTERS_ROOT = path.dirname(ADAPTER_DIR);
const REPO_ROOT = path.dirname(ADAPTERS_ROOT);
const ANALYZER_ENTRY = path.join(ADAPTER_DIR, "src", "analyzer.ts");
const MONOREPO_TS_LIB_DIR = path.join(
  REPO_ROOT,
  "node_modules",
  "typescript",
  "lib",
);

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function copyTypeScriptLibDtsFiles(targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(MONOREPO_TS_LIB_DIR, {
    withFileTypes: true,
  })) {
    if (
      entry.isFile() &&
      entry.name.startsWith("lib") &&
      entry.name.endsWith(".d.ts")
    ) {
      copyFileSync(
        path.join(MONOREPO_TS_LIB_DIR, entry.name),
        path.join(targetDir, entry.name),
      );
    }
  }
}

describe("resolveTypeScriptLibDir birim davranışları", () => {
  it("CAUSORYN_TS_LIB_DIR geçerli lib.es2022.full.d.ts içerdiğinde POSIX yolunu döner; eksikse yürüyüşe düşer", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-tslib-env-"));
    try {
      const envLibDir = path.join(tmpDir, "custom-lib");
      mkdirSync(envLibDir, { recursive: true });
      writeFileSync(
        path.join(envLibDir, "lib.es2022.full.d.ts"),
        "/// <reference no-default-lib=\"true\"/>\n",
        "utf8",
      );

      const entryUrl = pathToFileURL(
        path.join(tmpDir, "isolated", "dist", "mcp-server.mjs"),
      ).href;

      expect(
        resolveTypeScriptLibDir({
          importMetaUrl: entryUrl,
          env: { CAUSORYN_TS_LIB_DIR: `  ${envLibDir}  ` },
        }),
      ).toBe(toPosix(path.resolve(envLibDir)));

      const invalidEnvDir = path.join(tmpDir, "missing-lib");
      mkdirSync(invalidEnvDir, { recursive: true });
      const pkgLibDir = path.join(tmpDir, "isolated", "typescript-lib");
      mkdirSync(pkgLibDir, { recursive: true });
      writeFileSync(
        path.join(pkgLibDir, "lib.es2022.full.d.ts"),
        "/// <reference no-default-lib=\"true\"/>\n",
        "utf8",
      );

      expect(
        resolveTypeScriptLibDir({
          importMetaUrl: entryUrl,
          env: { CAUSORYN_TS_LIB_DIR: invalidEnvDir },
        }),
      ).toBe(toPosix(pkgLibDir));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("0..4 üst dizin yürüyüşünde typescript-lib, dist/typescript-lib ve node_modules/typescript/lib adaylarını sırasıyla bulur", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-tslib-walk-"));
    try {
      // 1) <pkg>/dist/typescript-lib (örn. <pkg>/scripts/causoryn.mjs üzerinden derinlik 1)
      const pkgA = path.join(tmpDir, "pkg-a");
      const pkgADistLib = path.join(pkgA, "dist", "typescript-lib");
      mkdirSync(pkgADistLib, { recursive: true });
      writeFileSync(
        path.join(pkgADistLib, "lib.es2022.full.d.ts"),
        "// stub\n",
        "utf8",
      );
      expect(
        resolveTypeScriptLibDir({
          importMetaUrl: pathToFileURL(
            path.join(pkgA, "scripts", "causoryn.mjs"),
          ).href,
          env: {},
        }),
      ).toBe(toPosix(pkgADistLib));

      // 2) <repo>/node_modules/typescript/lib (derinlik 3)
      const repoB = path.join(tmpDir, "repo-b");
      const repoBNmLib = path.join(
        repoB,
        "node_modules",
        "typescript",
        "lib",
      );
      mkdirSync(repoBNmLib, { recursive: true });
      writeFileSync(
        path.join(repoBNmLib, "lib.es2022.full.d.ts"),
        "// stub\n",
        "utf8",
      );
      expect(
        resolveTypeScriptLibDir({
          importMetaUrl: pathToFileURL(
            path.join(repoB, "adapters", "typescript", "dist", "analyzer.js"),
          ).href,
          env: {},
        }),
      ).toBe(toPosix(repoBNmLib));

      // 3) Hiçbir aday yoksa undefined döner
      expect(
        resolveTypeScriptLibDir({
          importMetaUrl: pathToFileURL(
            path.join(tmpDir, "empty", "d1", "d2", "d3", "d4", "entry.mjs"),
          ).href,
          env: {},
        }),
      ).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("file:///C:/ Windows URL biçimini POSIX sürücü yoluna normalize eder ve C:/ kökünde güvenle durur", () => {
    const spy = vi
      .spyOn(ts.sys, "fileExists")
      .mockImplementation(
        (candidatePath: string) =>
          candidatePath ===
          "C:/Program Files/Causoryn/typescript-lib/lib.es2022.full.d.ts",
      );
    try {
      expect(
        resolveTypeScriptLibDir({
          importMetaUrl:
            "file:///C:/Program%20Files/Causoryn/dist/mcp-server.mjs",
          env: {},
        }),
      ).toBe("C:/Program Files/Causoryn/typescript-lib");

      spy.mockReturnValue(false);
      expect(
        resolveTypeScriptLibDir({
          importMetaUrl: "file:///C:/only-root/entry.mjs",
          env: {},
        }),
      ).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("bozuk yüzde dizisi (%ZZ) içeren file:// URL'lerde URIError fırlatmaz ve üst dizin yürüyüşünü sürdürür", () => {
    const tmpDir = mkdtempSync(
      path.join(os.tmpdir(), "causoryn-tslib-percent-"),
    );
    try {
      const tsLibDir = path.join(tmpDir, "typescript-lib");
      mkdirSync(tsLibDir, { recursive: true });
      writeFileSync(
        path.join(tsLibDir, "lib.es2022.full.d.ts"),
        "// stub\n",
        "utf8",
      );

      const baseFileUrl = pathToFileURL(tmpDir).href.replace(/\/+$/, "");
      const malformedEntryUrl = `${baseFileUrl}/bad%ZZdir/mcp-server.mjs`;

      expect(() =>
        resolveTypeScriptLibDir({
          importMetaUrl: malformedEntryUrl,
          env: {},
        }),
      ).not.toThrow();
      expect(
        resolveTypeScriptLibDir({
          importMetaUrl: malformedEntryUrl,
          env: {},
        }),
      ).toBe(toPosix(tsLibDir));
      expect(
        resolveTypeScriptLibDir({
          importMetaUrl: "file:///C:/nonexistent%2/only.mjs",
          env: {},
        }),
      ).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("analyzer.ts içindeki sabitlenmiş satır numaralarını (classifyModuleSpecifier:1171, addRouteEdge:1625) kaydırmaz", () => {
    const lines = readFileSync(ANALYZER_ENTRY, "utf8").split(/\r?\n/);
    expect(lines[1170]).toBe("function classifyModuleSpecifier(");
    expect(lines[1624]).toBe(
      "  const addRouteEdge = (to: NodeRecord, evidence: SnapshotEvidenceInput): void => {",
    );
  });
});

describe("İzole os.tmpdir() standalone bundle içinde lib*.d.ts çözümlemesi", () => {
  it(
    "typescript-lib yokken state:partial + tanı üretir ve fonksiyon düğümünü korur; typescript-lib eklendiğinde state:ready ve diagnostics:[] döner",
    async () => {
      const tmpDir = mkdtempSync(
        path.join(os.tmpdir(), "causoryn-ts-standalone-"),
      );
      try {
        const pkgRoot = path.join(tmpDir, "pkg");
        const distDir = path.join(pkgRoot, "dist");
        const tsLibDir = path.join(pkgRoot, "typescript-lib");
        const workspaceDir = path.join(tmpDir, "sample-workspace");
        mkdirSync(distDir, { recursive: true });
        mkdirSync(workspaceDir, { recursive: true });

        const bundleOutfile = path.join(distDir, "standalone-analyzer.mjs");
        await esbuildBuild({
          entryPoints: [ANALYZER_ENTRY],
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node24",
          outfile: bundleOutfile,
          banner: {
            js: [
              'import { createRequire as __causorynCreateRequire } from "node:module";',
              'import { fileURLToPath as __causorynFileURLToPath } from "node:url";',
              "const require = __causorynCreateRequire(import.meta.url);",
              "const __filename = __causorynFileURLToPath(import.meta.url);",
              'const __dirname = __causorynFileURLToPath(new URL(".", import.meta.url));',
            ].join("\n"),
          },
        });

        const standaloneModule = (await import(
          pathToFileURL(bundleOutfile).href
        )) as {
          readonly analyzeTypeScriptProgram: (
            input: TypeScriptAdapterInput,
          ) => TypeScriptAdapterResult;
        };

        const sampleInput: TypeScriptAdapterInput = {
          workspaceId: "ws-standalone-lib",
          rootDir: workspaceDir,
          sources: [
            {
              relativePath: "src/index.ts",
              content: [
                "export type ComplexIndex = Promise<Record<string, ReadonlyArray<Map<string, Set<number>>>>>;",
                "",
                "export async function buildComplexIndex(key: string, value: number): ComplexIndex {",
                "  const setValues = new Set<number>([value]);",
                "  const mapEntry = new Map<string, Set<number>>([[key, setValues]]);",
                "  const items: ReadonlyArray<Map<string, Set<number>>> = [mapEntry];",
                "  const record: Record<string, ReadonlyArray<Map<string, Set<number>>>> = { [key]: items };",
                "  return Promise.resolve(record);",
                "}",
                "",
              ].join("\n"),
            },
          ],
        };

        const prevTsLibEnv = process.env["CAUSORYN_TS_LIB_DIR"];
        delete process.env["CAUSORYN_TS_LIB_DIR"];
        let partialResult: TypeScriptAdapterResult;
        let readyResult: TypeScriptAdapterResult;
        try {
          // 1) Partial: typescript-lib/ henüz kopyalanmadan önce yerleşik global tipler çözülemez → partial + tanı + AST fonksiyon düğümü korunur.
          partialResult = standaloneModule.analyzeTypeScriptProgram(sampleInput);

          // 2) Ready: typescript-lib/ kopyalandıktan sonra aynı bundle sıfır tanıyla ready üretir.
          copyTypeScriptLibDtsFiles(tsLibDir);
          readyResult = standaloneModule.analyzeTypeScriptProgram(sampleInput);
        } finally {
          if (prevTsLibEnv === undefined) {
            delete process.env["CAUSORYN_TS_LIB_DIR"];
          } else {
            process.env["CAUSORYN_TS_LIB_DIR"] = prevTsLibEnv;
          }
        }

        expect(partialResult.state).toBe("partial");
        expect(partialResult.diagnostics.length).toBeGreaterThan(0);
        expect(
          partialResult.nodes.some(
            (n) =>
              n.kind === "Function" && n.qualifiedName === "buildComplexIndex",
          ),
        ).toBe(true);

        expect(readyResult.diagnostics).toEqual([]);
        expect(readyResult.state).toBe("ready");
        expect(
          readyResult.nodes.some(
            (n) =>
              n.kind === "Function" && n.qualifiedName === "buildComplexIndex",
          ),
        ).toBe(true);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
