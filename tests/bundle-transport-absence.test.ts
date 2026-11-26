/**
 * The shipped MCP server bundles carry the stdio transport only.
 *
 * `@modelcontextprotocol/sdk` also ships HTTP server transports (Streamable HTTP, SSE,
 * the Express app helper) built on hono, @hono/node-server, express, raw-body and cors.
 * Those packages sit in package-lock.json as SDK dependencies, and their advisories show
 * up in dependency alerts, but none of their code may reach a bundle that the npm
 * tarball or the Antigravity plugin ships: Causoryn is a local stdio server and never
 * listens on HTTP.
 *
 * Both bundle builds (packages/mcp-server/scripts/build-bundle.mjs and
 * packages/causoryn/scripts/build-package.mjs) run esbuild with `minify: false`, so
 * esbuild writes a `// <path>` comment before the code of every bundled module. The
 * bundled module set is read from those comments. Each bundle must also contain a
 * module it is known to need (sentinel), so a build that drops the comments fails here
 * instead of passing with an empty module list. A last case bundles the SDK's HTTP
 * transports with the installed esbuild and checks that the same reading flags them.
 *
 * The bundles are build outputs (dist/ is not committed). A bundle that is not built is
 * skipped; run `npm run build`, `npm run build:bundle --workspace packages/mcp-server`
 * and `npm run build:package --workspace packages/causoryn` to cover all of them.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MCP_SERVER_DIR = path.join(REPO_ROOT, "packages", "mcp-server");

/** Packages that exist only for the SDK's HTTP transports (and their own dependencies). */
const FORBIDDEN_PACKAGES = [
  "hono",
  "@hono/node-server",
  "express",
  "express-rate-limit",
  "cors",
  "raw-body",
  "body-parser",
] as const;

/** SDK server modules that implement or wire an HTTP transport. */
const FORBIDDEN_SDK_SERVER_MODULE =
  /@modelcontextprotocol\/sdk\/dist\/[^/]+\/server\/(?:streamableHttp|webStandardStreamableHttp|sse|sseKeepAlive|express|requestBody|middleware\/[^/]+|auth\/.+)\.js$/;

/** A static import, dynamic import or require (also esbuild's `__require`) of a Node HTTP module. */
const NODE_HTTP_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|require\s*\(\s*)["'](?:node:)?(?:http|https|http2)["']/;

const SDK_STDIO_SERVER = "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js";

interface ShippedBundle {
  readonly relPath: string;
  /** A module path suffix the bundle must list, proving that the module comments are present. */
  readonly sentinel: string;
}

const SHIPPED_BUNDLES: readonly ShippedBundle[] = [
  { relPath: "packages/mcp-server/dist/mcp-server.mjs", sentinel: SDK_STDIO_SERVER },
  { relPath: "packages/mcp-server/dist/index-worker.mjs", sentinel: "src/index-worker-entry.ts" },
  { relPath: "packages/causoryn/dist/mcp-server.mjs", sentinel: SDK_STDIO_SERVER },
  { relPath: "packages/causoryn/dist/index-worker.mjs", sentinel: "src/index-worker-entry.ts" },
  { relPath: "integrations/antigravity/causoryn/scripts/mcp-server.mjs", sentinel: SDK_STDIO_SERVER },
];

/** esbuild's per-module comment: `// ../../node_modules/pkg/file.js`, `// src/stdio.ts`. */
const MODULE_PATH_COMMENT = /^\/\/ ((?:\.\.\/)*[\w@.-][^\s]*\.(?:[cm]?js|[cm]?ts|json))$/;

function bundledModulePaths(bundleText: string): string[] {
  const paths: string[] = [];
  for (const line of bundleText.split(/\r?\n/)) {
    const match = MODULE_PATH_COMMENT.exec(line);
    if (match?.[1] !== undefined) paths.push(match[1]);
  }
  return paths;
}

/** Every package a module path lies in, outermost first (`node_modules/a/node_modules/b/x.js` → a, b). */
function packagesOf(modulePath: string): string[] {
  return [...modulePath.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)].map((m) => m[1] ?? "");
}

interface TransportFindings {
  readonly forbiddenModules: string[];
  readonly httpImports: string[];
}

function findHttpTransport(bundleText: string): TransportFindings {
  const forbidden = new Set<string>(FORBIDDEN_PACKAGES);
  const forbiddenModules = bundledModulePaths(bundleText).filter(
    (modulePath) =>
      packagesOf(modulePath).some((pkg) => forbidden.has(pkg)) || FORBIDDEN_SDK_SERVER_MODULE.test(modulePath),
  );
  const httpImports = bundleText.split(/\r?\n/).filter((line) => NODE_HTTP_IMPORT.test(line));
  return { forbiddenModules, httpImports };
}

/**
 * Other suites rebuild these bundles while this one runs (build-bundle.mjs writes
 * atomically, build-package.mjs does not), so a read is repeated until two reads agree.
 */
function readSettled(filePath: string): string {
  let previous = readFileSync(filePath, "utf8");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = readFileSync(filePath, "utf8");
    if (current === previous) return current;
    previous = current;
  }
  return previous;
}

describe("shipped MCP bundles contain no HTTP transport (hono, @hono/node-server, express, Streamable HTTP/SSE)", () => {
  for (const bundle of SHIPPED_BUNDLES) {
    const absPath = path.join(REPO_ROOT, ...bundle.relPath.split("/"));
    const built = existsSync(absPath);
    it.skipIf(!built)(
      `${bundle.relPath}${built ? "" : " (skipped: not built, see the file header for the build commands)"}`,
      () => {
        const text = readSettled(absPath);
        const modules = bundledModulePaths(text);
        expect(
          modules.some((modulePath) => modulePath.endsWith(bundle.sentinel)),
          `${bundle.relPath} must list ${bundle.sentinel} in its esbuild module comments (was it minified?)`,
        ).toBe(true);
        expect(findHttpTransport(text)).toEqual({ forbiddenModules: [], httpImports: [] });
      },
    );
  }

  it("flags the SDK's HTTP transports when a bundle does include them (detector check with the installed esbuild)", async () => {
    const result = await build({
      absWorkingDir: MCP_SERVER_DIR,
      stdin: {
        contents: [
          'export { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";',
          'export { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";',
          'export { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";',
        ].join("\n"),
        resolveDir: MCP_SERVER_DIR,
        sourcefile: "http-transport-probe.ts",
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      write: false,
      minify: false,
      legalComments: "none",
      logLevel: "silent",
    });
    const text = result.outputFiles[0]?.text ?? "";
    const findings = findHttpTransport(text);
    const flaggedPackages = new Set(findings.forbiddenModules.flatMap(packagesOf));
    for (const pkg of ["hono", "@hono/node-server", "express", "raw-body"]) {
      expect(flaggedPackages.has(pkg), `${pkg} must be flagged`).toBe(true);
    }
    for (const sdkModule of ["server/streamableHttp.js", "server/sse.js", "server/express.js"]) {
      expect(
        findings.forbiddenModules.some((modulePath) => modulePath.endsWith(sdkModule)),
        `${sdkModule} must be flagged`,
      ).toBe(true);
    }
    expect(findings.httpImports.length).toBeGreaterThan(0);
  });
});
