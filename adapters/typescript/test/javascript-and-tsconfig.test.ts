import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  analyzeTypeScriptProgram,
  analyzeTypeScriptProgramWithFrameworks,
  type TsAdapterSourceFile,
  type TypeScriptAdapterInput,
  type TypeScriptAdapterResult,
} from "../src/index.js";
import type { SnapshotEdgeInput, SnapshotNodeInput } from "@causoryn/domain";

const VIRTUAL_ROOT = path.resolve(tmpdir(), "causoryn-v023-virtual-root");

function findNode(
  result: TypeScriptAdapterResult,
  kind: SnapshotNodeInput["kind"],
  qualifiedName: string,
  relativePath?: string,
): SnapshotNodeInput {
  const hit = result.nodes.find(
    (node) =>
      node.kind === kind &&
      node.qualifiedName === qualifiedName &&
      (relativePath === undefined || node.relativePath === relativePath),
  );
  if (hit === undefined) {
    const known = result.nodes
      .map((n) => `${n.kind}:${n.qualifiedName}@${n.relativePath ?? "-"}(${n.language ?? "-"})`)
      .join(", ");
    throw new Error(
      `Node not found: ${kind} ${qualifiedName} (${relativePath ?? "*"}). Existing: ${known}`,
    );
  }
  return hit;
}

function findEdge(
  result: TypeScriptAdapterResult,
  kind: SnapshotEdgeInput["kind"],
  fromQualifiedName: string,
  toQualifiedName: string,
): SnapshotEdgeInput | undefined {
  return result.edges.find(
    (edge) =>
      edge.kind === kind &&
      edge.from.qualifiedName === fromQualifiedName &&
      edge.to.qualifiedName === toQualifiedName,
  );
}

describe("Track 1 — Pure JavaScript (.js/.jsx/.mjs/.cjs) & Modern TS (.mts/.cts)", { timeout: 30_000 }, () => {
  it("analyzes pure JS (ESM + CommonJS require + JSX) as language='javascript' with ready state and verified IMPORTS + CALLS", () => {
    const sources: TsAdapterSourceFile[] = [
      {
        relativePath: "src/math.js",
        content: [
          "export function add(a, b) {",
          "  return a + b;",
          "}",
          "",
          "export class Calculator {",
          "  double(value) {",
          "    return add(value, value);",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
      {
        relativePath: "src/esm-entry.mjs",
        content: [
          'import { add, Calculator } from "./math.js";',
          "",
          "export function computeTotal(x) {",
          "  const calc = new Calculator();",
          "  return add(calc.double(x), 1);",
          "}",
          "",
        ].join("\n"),
      },
      {
        relativePath: "src/cjs-util.cjs",
        content: [
          "function multiply(a, b) {",
          "  return a * b;",
          "}",
          "",
          "module.exports = { multiply };",
          "",
        ].join("\n"),
      },
      {
        relativePath: "src/cjs-entry.cjs",
        content: [
          'const { multiply } = require("./cjs-util.cjs");',
          'const missing = require("./no-such-cjs-module");',
          "",
          "function scale(n) {",
          "  void missing;",
          "  return multiply(n, 3);",
          "}",
          "",
          "module.exports = { scale };",
          "",
        ].join("\n"),
      },
      {
        relativePath: "src/widget.jsx",
        content: [
          'import { add } from "./math";',
          "",
          "export function CounterWidget({ count }) {",
          "  const next = add(count, 1);",
          "  return <section>{next}</section>;",
          "}",
          "",
        ].join("\n"),
      },
    ];

    const result = analyzeTypeScriptProgram({
      workspaceId: "ws_pure_js",
      rootDir: VIRTUAL_ROOT,
      sources,
    });

    // Zero bogus TS7006 / TS17004 / TS2580 type-checking diagnostics on untyped JS.
    expect(result.state).toBe("ready");
    expect(result.diagnostics).toEqual([]);

    // Per-file language must be "javascript" on File AND declared symbols.
    for (const source of sources) {
      const fileNode = findNode(result, "File", source.relativePath, source.relativePath);
      expect(fileNode.language).toBe("javascript");
    }
    expect(findNode(result, "Function", "add", "src/math.js").language).toBe("javascript");
    expect(findNode(result, "Class", "Calculator", "src/math.js").language).toBe("javascript");
    expect(findNode(result, "Method", "Calculator.double", "src/math.js").language).toBe("javascript");
    expect(findNode(result, "Function", "computeTotal", "src/esm-entry.mjs").language).toBe("javascript");
    expect(findNode(result, "Function", "multiply", "src/cjs-util.cjs").language).toBe("javascript");
    expect(findNode(result, "Function", "scale", "src/cjs-entry.cjs").language).toBe("javascript");
    expect(findNode(result, "Function", "CounterWidget", "src/widget.jsx").language).toBe("javascript");

    // ESM IMPORTS verified.
    const esmImport = findEdge(result, "IMPORTS", "src/esm-entry.mjs", "src/math.js");
    expect(esmImport?.resolution).toBe("verified");

    // Extensionless JSX -> JS import verified.
    const jsxImport = findEdge(result, "IMPORTS", "src/widget.jsx", "src/math.js");
    expect(jsxImport?.resolution).toBe("verified");

    // CommonJS require("./cjs-util.cjs") -> verified IMPORTS edge with evidence.
    const cjsImport = findEdge(result, "IMPORTS", "src/cjs-entry.cjs", "src/cjs-util.cjs");
    expect(cjsImport?.resolution).toBe("verified");
    expect((cjsImport?.evidence ?? []).length).toBeGreaterThanOrEqual(1);

    // Unresolved CommonJS require -> explicit UnknownExternal + unresolved (no invented File).
    const missingCjs = findEdge(result, "IMPORTS", "src/cjs-entry.cjs", "./no-such-cjs-module");
    expect(missingCjs?.resolution).toBe("unresolved");
    expect(missingCjs?.to.kind).toBe("UnknownExternal");

    // Cross-file CALLS verified for both ESM and CommonJS.
    const esmCall = findEdge(result, "CALLS", "computeTotal", "Calculator.double");
    expect(esmCall?.resolution).toBe("verified");

    const cjsCall = findEdge(result, "CALLS", "scale", "multiply");
    expect(cjsCall?.resolution).toBe("verified");

    const jsxCall = findEdge(result, "CALLS", "CounterWidget", "add");
    expect(jsxCall?.resolution).toBe("verified");
  });

  it("reports syntactic errors honestly on broken JS while keeping sibling JS files indexed", () => {
    const result = analyzeTypeScriptProgram({
      workspaceId: "ws_broken_js",
      rootDir: VIRTUAL_ROOT,
      sources: [
        {
          relativePath: "src/good.js",
          content: "export function ok(v) { return v + 1; }\n",
        },
        {
          relativePath: "src/broken.js",
          content: "export function broken( { return === ;;\n",
        },
      ],
    });

    expect(result.state).toBe("partial");
    expect(result.diagnostics.some((d) => d.relativePath === "src/broken.js")).toBe(true);
    expect(result.diagnostics.some((d) => d.relativePath === "src/good.js")).toBe(false);
    expect(findNode(result, "Function", "ok", "src/good.js").language).toBe("javascript");
  });

  it("supports Express CommonJS require('express') and Next.js App Router .js/.jsx routes", () => {
    const expressRun = analyzeTypeScriptProgramWithFrameworks({
      workspaceId: "ws_express_cjs",
      rootDir: VIRTUAL_ROOT,
      sources: [
        {
          relativePath: "src/server.cjs",
          content: [
            'const express = require("express");',
            "const app = express();",
            "function healthHandler(req, res) {",
            "  return res;",
            "}",
            'app.get("/health", healthHandler);',
            "",
          ].join("\n"),
        },
      ],
    });

    expect(expressRun.result.state).toBe("ready");
    expect(expressRun.framework.detections.some((d) => d.framework === "express")).toBe(true);
    const expressEndpoint = findNode(expressRun.result, "Endpoint", "GET /health", "src/server.cjs");
    expect(expressEndpoint.language).toBe("javascript");
    expect(expressEndpoint.attributes?.["framework"]).toBe("express");
    const expressRoute = findEdge(expressRun.result, "ROUTES_TO", "GET /health", "healthHandler");
    expect(expressRoute?.resolution).toBe("verified");

    const nextRun = analyzeTypeScriptProgramWithFrameworks({
      workspaceId: "ws_next_js",
      rootDir: VIRTUAL_ROOT,
      sources: [
        {
          relativePath: "app/api/items/route.js",
          content: [
            "export async function GET() {",
            "  return [];",
            "}",
            "",
          ].join("\n"),
        },
        {
          relativePath: "app/items/page.jsx",
          content: [
            "export default function ItemsPage() {",
            "  return <main>Items</main>;",
            "}",
            "",
          ].join("\n"),
        },
      ],
    });

    expect(nextRun.result.state).toBe("ready");
    expect(nextRun.framework.detections.some((d) => d.framework === "nextjs")).toBe(true);
    const apiEndpoint = findNode(nextRun.result, "Endpoint", "GET /api/items", "app/api/items/route.js");
    expect(apiEndpoint.language).toBe("javascript");
    expect(apiEndpoint.attributes?.["framework"]).toBe("nextjs");
    expect(findEdge(nextRun.result, "ROUTES_TO", "GET /api/items", "GET")?.resolution).toBe("verified");
    expect(findEdge(nextRun.result, "ROUTES_TO", "GET /items", "ItemsPage")?.resolution).toBe("verified");
  });

  it("analyzes .mts and .cts files as language='typescript' with verified imports and calls", () => {
    const result = analyzeTypeScriptProgram({
      workspaceId: "ws_modern_ts",
      rootDir: VIRTUAL_ROOT,
      sources: [
        {
          relativePath: "src/math.mts",
          content: "export function addMts(a: number, b: number): number { return a + b; }\n",
        },
        {
          relativePath: "src/main.mts",
          content: [
            'import { addMts } from "./math.mjs";',
            "export function runMts(x: number): number { return addMts(x, 2); }",
            "",
          ].join("\n"),
        },
        {
          relativePath: "src/util.cts",
          content: "export function mulCts(a: number, b: number): number { return a * b; }\n",
        },
        {
          relativePath: "src/entry.cts",
          content: [
            'import { mulCts } from "./util.cjs";',
            "export function runCts(x: number): number { return mulCts(x, 3); }",
            "",
          ].join("\n"),
        },
      ],
    });

    expect(result.state).toBe("ready");
    expect(result.diagnostics).toEqual([]);
    expect(findNode(result, "File", "src/math.mts").language).toBe("typescript");
    expect(findNode(result, "File", "src/util.cts").language).toBe("typescript");
    expect(findNode(result, "Function", "addMts", "src/math.mts").language).toBe("typescript");
    expect(findNode(result, "Function", "mulCts", "src/util.cts").language).toBe("typescript");
    expect(findEdge(result, "IMPORTS", "src/main.mts", "src/math.mts")?.resolution).toBe("verified");
    expect(findEdge(result, "CALLS", "runMts", "addMts")?.resolution).toBe("verified");
    expect(findEdge(result, "IMPORTS", "src/entry.cts", "src/util.cts")?.resolution).toBe("verified");
    expect(findEdge(result, "CALLS", "runCts", "mulCts")?.resolution).toBe("verified");
  });
});

describe("Track 1 — Safe Read-Only tsconfig.json / jsconfig.json Loader & Path Aliases", { timeout: 30_000 }, () => {
  it("resolves root tsconfig.json JSONC with @/* paths, jsx: 'react-jsx', and extensionless directory barrel imports without TS2307/TS17004/TS2835", () => {
    const input = {
      workspaceId: "ws_tsconfig_root",
      rootDir: VIRTUAL_ROOT,
      configFiles: [
        {
          relativePath: "tsconfig.json",
          content: [
            "{",
            "  // Next.js / Vite style JSONC config",
            '  "compilerOptions": {',
            '    "jsx": "react-jsx",',
            '    "baseUrl": ".",',
            '    "paths": {',
            '      "@/*": ["./src/*"],',
            "    },",
            "  },",
            "}",
          ].join("\n"),
        },
      ],
      sources: [
        {
          relativePath: "src/lib/math.ts",
          content: "export function add(a: number, b: number): number { return a + b; }\n",
        },
        {
          relativePath: "src/utils/index.ts",
          content: "export function formatValue(n: number): string { return String(n); }\n",
        },
        {
          relativePath: "src/app/page.tsx",
          content: [
            'import { add } from "@/lib/math";',
            'import { formatValue } from "../utils";',
            "",
            "export default function Page(): string {",
            "  return formatValue(add(1, 2));",
            "}",
            "",
          ].join("\n"),
        },
      ],
    } satisfies TypeScriptAdapterInput;

    const result = analyzeTypeScriptProgram(input);

    expect(result.diagnostics.filter((d) => ["TS2307", "TS17004", "TS2835"].includes(d.code))).toEqual([]);
    expect(result.state).toBe("ready");
    expect(findEdge(result, "IMPORTS", "src/app/page.tsx", "src/lib/math.ts")?.resolution).toBe("verified");
    expect(findEdge(result, "IMPORTS", "src/app/page.tsx", "src/utils/index.ts")?.resolution).toBe("verified");
    expect(findEdge(result, "CALLS", "Page", "add")?.resolution).toBe("verified");
    expect(findEdge(result, "CALLS", "Page", "formatValue")?.resolution).toBe("verified");
  });

  it("scopes monorepo nested frontend/tsconfig.json and backend/tsconfig.json independently without alias bleeding", () => {
    const result = analyzeTypeScriptProgram({
      workspaceId: "ws_monorepo_configs",
      rootDir: VIRTUAL_ROOT,
      configFiles: [
        {
          relativePath: "frontend/tsconfig.json",
          content: JSON.stringify({
            compilerOptions: {
              jsx: "preserve",
              paths: { "@/*": ["./src/*"] },
            },
          }),
        },
        {
          relativePath: "backend/tsconfig.json",
          content: JSON.stringify({
            compilerOptions: {
              paths: { "@/*": ["./lib/*"] },
            },
          }),
        },
      ],
      sources: [
        {
          relativePath: "frontend/src/util.ts",
          content: "export function frontUtil(): string { return 'front'; }\n",
        },
        {
          relativePath: "frontend/src/app.tsx",
          content: [
            'import { frontUtil } from "@/util";',
            "export function FrontApp(): string { return frontUtil(); }",
            "",
          ].join("\n"),
        },
        {
          relativePath: "backend/lib/util.ts",
          content: "export function backUtil(): string { return 'back'; }\n",
        },
        {
          relativePath: "backend/src/server.ts",
          content: [
            'import { backUtil } from "@/util";',
            "export function startServer(): string { return backUtil(); }",
            "",
          ].join("\n"),
        },
      ],
    });

    expect(result.state).toBe("ready");
    expect(result.diagnostics).toEqual([]);

    expect(findEdge(result, "IMPORTS", "frontend/src/app.tsx", "frontend/src/util.ts")?.resolution).toBe("verified");
    expect(findEdge(result, "IMPORTS", "frontend/src/app.tsx", "backend/lib/util.ts")).toBeUndefined();
    expect(findEdge(result, "CALLS", "FrontApp", "frontUtil")?.resolution).toBe("verified");

    expect(findEdge(result, "IMPORTS", "backend/src/server.ts", "backend/lib/util.ts")?.resolution).toBe("verified");
    expect(findEdge(result, "IMPORTS", "backend/src/server.ts", "frontend/src/util.ts")).toBeUndefined();
    expect(findEdge(result, "CALLS", "startServer", "backUtil")?.resolution).toBe("verified");
  });

  it("resolves jsconfig.json path aliases for plain JavaScript React projects", () => {
    const result = analyzeTypeScriptProgram({
      workspaceId: "ws_jsconfig",
      rootDir: VIRTUAL_ROOT,
      configFiles: [
        {
          relativePath: "jsconfig.json",
          content: JSON.stringify({
            compilerOptions: {
              baseUrl: ".",
              paths: {
                "~/*": ["./src/*"],
              },
            },
          }),
        },
      ],
      sources: [
        {
          relativePath: "src/components/Button.jsx",
          content: "export function Button({ label }) { return <button>{label}</button>; }\n",
        },
        {
          relativePath: "src/pages/Home.jsx",
          content: [
            'import { Button } from "~/components/Button";',
            "export function Home() { return Button({ label: 'Go' }); }",
            "",
          ].join("\n"),
        },
      ],
    });

    expect(result.state).toBe("ready");
    expect(result.diagnostics).toEqual([]);
    expect(findNode(result, "File", "src/pages/Home.jsx").language).toBe("javascript");
    expect(findEdge(result, "IMPORTS", "src/pages/Home.jsx", "src/components/Button.jsx")?.resolution).toBe("verified");
    expect(findEdge(result, "CALLS", "Home", "Button")?.resolution).toBe("verified");
  });

  it("supports extends chain inside rootDir and degrades safely on circular, traversal, prototype pollution, malformed, and >256KB configs", () => {
    // 1) Valid extends chain strictly inside rootDir.
    const validExtends = analyzeTypeScriptProgram({
      workspaceId: "ws_extends_valid",
      rootDir: VIRTUAL_ROOT,
      configFiles: [
        {
          relativePath: "tsconfig.base.json",
          content: JSON.stringify({
            compilerOptions: {
              baseUrl: ".",
              paths: { "@core/*": ["./src/core/*"] },
            },
          }),
        },
        {
          relativePath: "tsconfig.json",
          content: JSON.stringify({
            extends: "./tsconfig.base.json",
            compilerOptions: {
              jsx: "preserve",
            },
          }),
        },
      ],
      sources: [
        {
          relativePath: "src/core/id.ts",
          content: "export function makeId(): string { return 'id-1'; }\n",
        },
        {
          relativePath: "src/index.ts",
          content: [
            'import { makeId } from "@core/id";',
            "export function main(): string { return makeId(); }",
            "",
          ].join("\n"),
        },
      ],
    });
    expect(validExtends.state).toBe("ready");
    expect(findEdge(validExtends, "IMPORTS", "src/index.ts", "src/core/id.ts")?.resolution).toBe("verified");

    // 2) Circular extends terminates safely with warning.
    const circular = analyzeTypeScriptProgram({
      workspaceId: "ws_extends_cycle",
      rootDir: VIRTUAL_ROOT,
      configFiles: [
        {
          relativePath: "tsconfig.json",
          content: JSON.stringify({ extends: "./tsconfig.b.json" }),
        },
        {
          relativePath: "tsconfig.b.json",
          content: JSON.stringify({ extends: "./tsconfig.json" }),
        },
      ],
      sources: [
        {
          relativePath: "src/a.ts",
          content: "export const a = 1;\n",
        },
      ],
    });
    expect(circular.state).toBe("ready");
    expect(circular.warnings.length).toBeGreaterThan(0);

    // 3) Traversal extends + prototype pollution keys + bare package extends:
    //    never escapes rootDir, never pollutes Object.prototype, still resolves safe sibling paths.
    const malicious = analyzeTypeScriptProgram({
      workspaceId: "ws_malicious_tsconfig",
      rootDir: VIRTUAL_ROOT,
      configFiles: [
        {
          relativePath: "tsconfig.json",
          content: [
            "{",
            '  "extends": "../../../etc/passwd",',
            '  "compilerOptions": {',
            '    "baseUrl": ".",',
            '    "paths": {',
            '      "__proto__": { "pollutedKey": ["./evil/*"] },',
            '      "constructor": ["./evil/*"],',
            '      "prototype": ["./evil/*"],',
            '      "@escape/*": ["../../outside/*"],',
            '      "@/*": ["./src/*"]',
            "    }",
            "  }",
            "}",
          ].join("\n"),
        },
      ],
      sources: [
        {
          relativePath: "src/safe.ts",
          content: "export function safeFn(): number { return 42; }\n",
        },
        {
          relativePath: "src/app.ts",
          content: [
            'import { safeFn } from "@/safe";',
            "export function run(): number { return safeFn(); }",
            "",
          ].join("\n"),
        },
      ],
    });
    expect((Object.prototype as Record<string, unknown>)["pollutedKey"]).toBeUndefined();
    expect(malicious.state).toBe("ready");
    expect(malicious.warnings.length).toBeGreaterThan(0);
    expect(malicious.warnings.some((w) => w.includes("@escape/*"))).toBe(true);
    expect(findEdge(malicious, "IMPORTS", "src/app.ts", "src/safe.ts")?.resolution).toBe("verified");

    // 4) Malformed JSONC and >256KB tsconfig degrade safely without throwing.
    const malformed = analyzeTypeScriptProgram({
      workspaceId: "ws_malformed_tsconfig",
      rootDir: VIRTUAL_ROOT,
      configFiles: [
        {
          relativePath: "tsconfig.json",
          content: "{ this is not valid jsonc {{{",
        },
      ],
      sources: [{ relativePath: "src/ok.ts", content: "export const ok = 1;\n" }],
    });
    expect(malformed.state).toBe("ready");
    expect(malformed.warnings.length).toBeGreaterThan(0);

    const oversized = analyzeTypeScriptProgram({
      workspaceId: "ws_oversized_tsconfig",
      rootDir: VIRTUAL_ROOT,
      configFiles: [
        {
          relativePath: "tsconfig.json",
          content: `{"compilerOptions":{"paths":{"@/*":["./src/*"]}}} // ${"x".repeat(300_000)}`,
        },
      ],
      sources: [{ relativePath: "src/ok.ts", content: "export const ok = 1;\n" }],
    });
    expect(oversized.state).toBe("ready");
    expect(oversized.warnings.length).toBeGreaterThan(0);
  });

  it("safe disk fallback loads real tsconfig.json and rejects symlink tsconfig escape (CWE-59)", () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "causoryn-tsconfig-disk-"));
    const outsideDir = mkdtempSync(path.join(tmpdir(), "causoryn-tsconfig-outside-"));
    try {
      mkdirSync(path.join(tempRoot, "src", "lib"), { recursive: true });
      writeFileSync(
        path.join(tempRoot, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: { "@/*": ["./src/*"] },
          },
        }),
        "utf8",
      );
      const mathSrc = "export function add(a: number, b: number): number { return a + b; }\n";
      const appSrc = 'import { add } from "@/lib/math";\nexport function run(): number { return add(2, 3); }\n';
      writeFileSync(path.join(tempRoot, "src", "lib", "math.ts"), mathSrc, "utf8");
      writeFileSync(path.join(tempRoot, "src", "app.ts"), appSrc, "utf8");

      // Disk fallback when configFiles is omitted.
      const diskResult = analyzeTypeScriptProgram({
        workspaceId: "ws_disk_tsconfig",
        rootDir: tempRoot,
        sources: [
          { relativePath: "src/lib/math.ts", content: mathSrc },
          { relativePath: "src/app.ts", content: appSrc },
        ],
      });
      expect(diskResult.state).toBe("ready");
      expect(findEdge(diskResult, "IMPORTS", "src/app.ts", "src/lib/math.ts")?.resolution).toBe("verified");

      // Symlink escape check: symlinked tsconfig.json pointing outside tempRoot MUST be rejected!
      const symlinkRoot = mkdtempSync(path.join(tmpdir(), "causoryn-tsconfig-sym-"));
      try {
        const secretCfg = path.join(outsideDir, "secret-tsconfig.json");
        writeFileSync(
          secretCfg,
          JSON.stringify({
            compilerOptions: {
              baseUrl: ".",
              paths: { "@secret/*": ["./src/*"] },
            },
          }),
          "utf8",
        );
        let symlinkCreated = false;
        try {
          symlinkSync(secretCfg, path.join(symlinkRoot, "tsconfig.json"), "file");
          symlinkCreated = true;
        } catch {
          // On Windows without Developer Mode / admin privilege, file symlinks may return EPERM.
        }
        if (symlinkCreated) {
          const symResult = analyzeTypeScriptProgram({
            workspaceId: "ws_symlink_tsconfig",
            rootDir: symlinkRoot,
            sources: [
              { relativePath: "src/lib/math.ts", content: mathSrc },
              {
                relativePath: "src/app.ts",
                content: 'import { add } from "@secret/lib/math";\nexport function run(): number { return add(1, 2); }\n',
              },
            ],
          });
          // Symlink config MUST NOT have resolved @secret/lib/math!
          expect(findEdge(symResult, "IMPORTS", "src/app.ts", "src/lib/math.ts")).toBeUndefined();
          expect(symResult.warnings.length).toBeGreaterThan(0);
        }
      } finally {
        rmSync(symlinkRoot, { recursive: true, force: true });
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("is byte-deterministic regardless of sources and configFiles input order", () => {
    const sources: TsAdapterSourceFile[] = [
      { relativePath: "frontend/src/util.js", content: "export function hi(n) { return n; }\n" },
      { relativePath: "frontend/src/app.jsx", content: 'import { hi } from "@/util";\nexport function App() { return <div>{hi(1)}</div>; }\n' },
      { relativePath: "backend/lib/util.ts", content: "export function ok(): number { return 1; }\n" },
      { relativePath: "backend/src/srv.ts", content: 'import { ok } from "@/util";\nexport function run(): number { return ok(); }\n' },
    ];
    const configFiles: TsAdapterSourceFile[] = [
      { relativePath: "frontend/jsconfig.json", content: JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }) },
      { relativePath: "backend/tsconfig.json", content: JSON.stringify({ compilerOptions: { paths: { "@/*": ["./lib/*"] } } }) },
    ];

    const forward = analyzeTypeScriptProgram({
      workspaceId: "ws_det",
      rootDir: VIRTUAL_ROOT,
      sources,
      configFiles,
    });
    const reversed = analyzeTypeScriptProgram({
      workspaceId: "ws_det",
      rootDir: VIRTUAL_ROOT,
      sources: [...sources].reverse(),
      configFiles: [...configFiles].reverse(),
    });

    expect(forward.state).toBe("ready");
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });
});
