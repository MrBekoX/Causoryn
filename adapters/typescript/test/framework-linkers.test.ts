import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Framework linkers test üçlüleri (sprint-2 B3; TŞ v2.1 §7 L3 linker katmanı).
 *
 * Pozitif: fixture-ts-express (`app.get/post` + `router.get` kayıtları) ve
 * fixture-ts-nextjs (App Router `route.ts` fiil exportları + `page.tsx`
 * default export) üzerinden ROUTES_TO kenarları — Endpoint node'ları
 * `framework` öznitelikli, kanıt span'ları fixture satır içerikleriyle
 * birebir eşleşir.
 * Negatif: framework olmayan projede (Express importu yok, App Router kural
 * dosyası yok) `extractFrameworkEdges` HİÇbir detection/node/edge/diagnostic
 * üretmez; Faz A jenerik `<x>.<verb>` davranışı korunur (framework özniteliği
 * yok).
 * Partial: bilinmeyen App Router export şekli → kenar YOK, node icat EDİLMEZ,
 * FRAMEWORK_PATTERN_UNKNOWN tanı notu düşer.
 * Determinizm: aynı girdi → bit-bit aynı çıktı; girdi sırası çıktıyı
 * değiştirmez (TŞ §8 invariant vi).
 *
 * Testler salt okunurdur: fixture diskten okunur, hatalı senaryolar bellekte
 * üretilir; depoya hiçbir şey yazılmaz (ADR-008).
 */

import {
  analyzeTypeScriptProgram,
  analyzeTypeScriptProgramWithFrameworks,
  extractFrameworkEdges,
  TS_ADAPTER_ANALYZER_ID,
  type FrameworkEdgesResult,
  type TypeScriptAdapterInput,
  type TypeScriptAdapterResult,
} from "../src/index.js";
import { createSnapshot, sha256Hex, utf8Encode } from "@causoryn/domain";
import type { SnapshotEdgeInput, SnapshotNodeInput } from "@causoryn/domain";

/* ------------------------------------------------------------------ */
/* Salt-okunur fixture erişimi (same-root sınır denetimi)              */
/* ------------------------------------------------------------------ */

const ADAPTER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REPO_ROOT = path.resolve(ADAPTER_DIR, "..", "..");
const EXAMPLES_ROOT = path.join(REPO_ROOT, "examples");
const EXPRESS_FIXTURE_ROOT = path.join(EXAMPLES_ROOT, "fixture-ts-express");
const NEXTJS_FIXTURE_ROOT = path.join(EXAMPLES_ROOT, "fixture-ts-nextjs");

interface FixtureFile {
  readonly relativePath: string;
  readonly content: string;
}

function resolveWithin(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  const boundary = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(boundary)) {
    throw new Error(`Fixture kökü dışına erişim reddedildi: ${relativePath}`);
  }
  return target;
}

function collectFixtureFiles(root: string, dir: string, prefix: string): FixtureFile[] {
  const out: FixtureFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isDirectory()) continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectFixtureFiles(root, resolveWithin(root, rel), rel));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push({
        relativePath: rel,
        content: readFileSync(resolveWithin(root, rel), "utf8"),
      });
    }
  }
  return out.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
}

function loadFixture(root: string, workspaceId: string): TypeScriptAdapterInput {
  return {
    workspaceId,
    rootDir: root,
    sources: collectFixtureFiles(root, root, ""),
  };
}

/**
 * Hermetik Express tip shim'i (yalnızca test girdisinde; diskte dosya yok).
 *
 * Bu makinede kök node_modules'ında tip içermeyen bir express JS paketi var;
 * modül çözümlemesi fixture kökünden yukarı yürüdüğü için fixture aksi halde
 * host ortamına bağımlı kalır (TS7016 → partial). Shim, çözümlemeyi bellek-içi
 * çantada (rootDir/node_modules/express) tutar: her ortamda BİT-BİT aynı
 * girdi → aynı çıktı (TŞ §8 invariant vi). Konvansiyonel Express yüzeyinin
 * yalnızca fixture'ın kullandığı kısmı tanımlanır.
 */
const EXPRESS_TYPE_SHIM: readonly FixtureFile[] = [
  {
    relativePath: "node_modules/express/package.json",
    content: JSON.stringify({
      name: "express",
      version: "0.0.0-fixture-shim",
      main: "index.js",
      types: "index.d.ts",
    }),
  },
  {
    relativePath: "node_modules/express/index.d.ts",
    content: [
      "export interface Request {",
      "  body?: unknown;",
      "}",
      "",
      "export interface Response {",
      "  json(payload: unknown): void;",
      "}",
      "",
      "export type Handler = (request: Request, response: Response) => void;",
      "",
      "export interface Express {",
      "  get(path: string, handler: Handler): Express;",
      "  post(path: string, handler: Handler): Express;",
      "}",
      "",
      "export interface Router {",
      "  get(path: string, handler: Handler): Router;",
      "  post(path: string, handler: Handler): Router;",
      "}",
      "",
      "export function express(): Express;",
      "export function Router(): Router;",
      "export default express;",
      "",
    ].join("\n"),
  },
];

/** Express fixture'ını hermetik yükle: disk kaynakları + tip shim'i. */
function loadExpressFixture(workspaceId: string): TypeScriptAdapterInput {
  return {
    workspaceId,
    rootDir: EXPRESS_FIXTURE_ROOT,
    sources: [
      ...collectFixtureFiles(EXPRESS_FIXTURE_ROOT, EXPRESS_FIXTURE_ROOT, ""),
      ...EXPRESS_TYPE_SHIM,
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Sonuç sorgu yardımcıları                                            */
/* ------------------------------------------------------------------ */

function findNode(
  result: TypeScriptAdapterResult,
  kind: string,
  qualifiedName: string,
): SnapshotNodeInput {
  const node = result.nodes.find(
    (candidate) =>
      candidate.kind === kind && candidate.qualifiedName === qualifiedName,
  );
  if (node === undefined) {
    const known = result.nodes
      .map((n) => `${n.kind}|${n.qualifiedName}|${n.relativePath ?? "-"}`)
      .join(", ");
    throw new Error(
      `${kind} "${qualifiedName}" node'u bulunamadı. Mevcut: ${known}`,
    );
  }
  return node;
}

function sameRef(a: SnapshotNodeInput, b: SnapshotNodeInput): boolean {
  return (
    a.kind === b.kind &&
    a.qualifiedName === b.qualifiedName &&
    a.relativePath === b.relativePath
  );
}

function frameworkEdge(
  gateway: FrameworkEdgesResult,
  fromQualifiedName: string,
  toQualifiedName: string,
): SnapshotEdgeInput {
  const edge = gateway.edges.find(
    (candidate) =>
      candidate.kind === "ROUTES_TO" &&
      candidate.from.kind === "Endpoint" &&
      candidate.from.qualifiedName === fromQualifiedName &&
      candidate.to.qualifiedName === toQualifiedName,
  );
  if (edge === undefined) {
    const summary = gateway.edges
      .map(
        (e) =>
          `${e.kind} ${e.from.kind}:${e.from.qualifiedName} -> ${e.to.kind}:${e.to.qualifiedName}`,
      )
      .join("; ");
    throw new Error(
      `${fromQualifiedName} -> ${toQualifiedName} ROUTES_TO kenarı bulunamadı. Kenarlar: ${summary}`,
    );
  }
  return edge;
}

/** Kanıt span'ının satır içeriği + sourceHash'i kaynakla birebir doğrulanır. */
function edgeCitesLine(
  sources: readonly FixtureFile[],
  edge: SnapshotEdgeInput,
  needle: string,
): boolean {
  const sourceByPath = new Map(
    sources.map((source) => [source.relativePath, source]),
  );
  for (const evidence of edge.evidence ?? []) {
    const span = evidence.span;
    if (span === undefined) continue;
    const source = sourceByPath.get(span.relativePath);
    if (source === undefined) continue;
    expect(span.sourceHash).toBe(sha256Hex(utf8Encode(source.content)));
    expect(evidence.analyzerId).toBe(TS_ADAPTER_ANALYZER_ID);
    expect(evidence.rationale.length).toBeGreaterThan(0);
    const lines = source.content.split("\n");
    for (let line = span.startLine; line <= span.endLine; line += 1) {
      const text = lines[line - 1];
      if (text !== undefined && text.includes(needle)) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Pozitif: Express route → Endpoint + ROUTES_TO                       */
/* ------------------------------------------------------------------ */

describe("extractFrameworkEdges — pozitif (Express: fixture-ts-express)", () => {
  const input = loadExpressFixture("w_fx_express");
  const sources = input.sources;
  const gateway = extractFrameworkEdges(input);
  const main = analyzeTypeScriptProgram(input);

  it("Express'i import tabanlı algılar; detection basis kaynak yollarını taşır", () => {
    expect(gateway.detections).toHaveLength(1);
    const detection = gateway.detections[0] as (typeof gateway.detections)[number];
    expect(detection.framework).toBe("express");
    expect([...detection.basis].sort()).toEqual([
      "import:express@src/app.ts",
      "import:express@src/routes/admin-routes.ts",
    ]);
  });

  it("app.get/post + router.get kayıtları için üç verified ROUTES_TO kenarı üretir", () => {
    expect(gateway.edges).toHaveLength(3);

    const getUsers = frameworkEdge(gateway, "GET /products", "listProductsHandler");
    expect(getUsers.resolution).toBe("verified");
    expect(
      edgeCitesLine(sources, getUsers, 'app.get("/products"'),
    ).toBe(true);

    const postUsers = frameworkEdge(gateway, "POST /products", "createProductHandler");
    expect(postUsers.resolution).toBe("verified");
    expect(
      edgeCitesLine(sources, postUsers, 'app.post("/products"'),
    ).toBe(true);

    const adminStats = frameworkEdge(gateway, "GET /admin/stats", "getAdminStatsHandler");
    expect(adminStats.resolution).toBe("verified");
    expect(
      edgeCitesLine(sources, adminStats, 'router.get("/admin/stats"'),
    ).toBe(true);
  });

  it("kenar kanıtları route-attribute türündedir ve handler bağlamını taşır", () => {
    const edge = frameworkEdge(gateway, "GET /products", "listProductsHandler");
    expect(edge.evidence).toHaveLength(1);
    expect((edge.evidence ?? [])[0]?.kind).toBe("route-attribute");
    const span = (edge.evidence ?? [])[0]?.span;
    expect(span?.relativePath).toBe("src/app.ts");
  });

  it("Endpoint node'ları framework özniteliklidir ve kayıt dosyasına aittir", () => {
    const byName = new Map(
      gateway.nodes.map((node) => [node.qualifiedName, node]),
    );
    expect(byName.size).toBe(3);

    const get = byName.get("GET /products");
    expect(get?.kind).toBe("Endpoint");
    expect(get?.relativePath).toBe("src/app.ts");
    expect(get?.attributes?.["framework"]).toBe("express");
    expect(get?.attributes?.["method"]).toBe("GET");
    expect(get?.attributes?.["path"]).toBe("/products");

    const admin = byName.get("GET /admin/stats");
    expect(admin?.relativePath).toBe("src/routes/admin-routes.ts");
    expect(admin?.attributes?.["framework"]).toBe("express");
  });

  it("iyi biçimli Express kayıtları framework düzeyinde tanı üretmez", () => {
    expect(gateway.diagnostics).toEqual([]);
  });

  it("ana analiz aynı Endpoint'leri framework özniteliğiyle üretir; handler'lar Function node'dur", () => {
    const endpoint = findNode(main, "Endpoint", "GET /products");
    expect(endpoint.attributes?.["framework"]).toBe("express");
    expect(endpoint.attributes?.["method"]).toBe("GET");

    const handler = findNode(main, "Function", "listProductsHandler");
    expect(handler.relativePath).toBe("src/handlers/product-handlers.ts");

    // Faz A jenerik kalıbı kırılmadı: aynı kayıt jenerik fazca da yakalanır,
    // kanıt birleştirilerek TEK evidence kaydında toplanır (dedupe).
    const routes = main.edges.filter(
      (edge) =>
        edge.kind === "ROUTES_TO" &&
        sameRef(edge.from, endpoint) &&
        edge.to.qualifiedName === "listProductsHandler",
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]?.resolution).toBe("verified");
    expect((routes[0]?.evidence ?? []).length).toBe(1);
  });

  it("hermetik girdi: host node_modules'undan bağımsız olarak ready ve tanısız", () => {
    // Tip shim'i çözümlemeyi fixture kökünde tutar; host ortamındaki express
    // paketinden bağımsız olarak analiz ready + tanısızdır.
    expect(main.state).toBe("ready");
    expect(main.diagnostics).toEqual([]);
    for (const name of ["GET /products", "POST /products", "GET /admin/stats"]) {
      const routes = main.edges.filter(
        (edge) =>
          edge.kind === "ROUTES_TO" &&
          edge.from.kind === "Endpoint" &&
          edge.from.qualifiedName === name,
      );
      expect(routes).toHaveLength(1);
      expect(routes[0]?.resolution).toBe("verified");
    }
  });

  it("çıktı domain snapshot sözleşmesine uyar: dangling edge yok, duplicate yok", () => {
    const snapshot = createSnapshot({
      workspaceId: "w_fx_express",
      revision: { id: "rev-framework", sequence: 1 },
      configHash: "config-hash-test",
      analyzerFingerprint: "ts-adapter@0.1.0",
      state: main.state === "partial" ? "partial" : "ready",
      createdAt: "2026-11-04T00:00:00.000Z",
      nodes: main.nodes,
      edges: main.edges,
    });
    expect(snapshot.nodes.length).toBe(main.nodes.length);
    expect(snapshot.edges.length).toBe(main.edges.length);
  });
});

/* ------------------------------------------------------------------ */
/* Pozitif: Next.js App Router → Endpoint + ROUTES_TO                  */
/* ------------------------------------------------------------------ */

describe("extractFrameworkEdges — pozitif (Next.js: fixture-ts-nextjs)", () => {
  const input = loadFixture(NEXTJS_FIXTURE_ROOT, "w_fx_nextjs");
  const sources = input.sources;
  const gateway = extractFrameworkEdges(input);
  const main = analyzeTypeScriptProgram(input);

  it("App Router kural dosyalarını algılar; detection basis dosya kuralıdır", () => {
    expect(gateway.detections).toHaveLength(1);
    const detection = gateway.detections[0] as (typeof gateway.detections)[number];
    expect(detection.framework).toBe("nextjs");
    expect([...detection.basis].sort()).toEqual([
      "file-convention:app/api/users/route.ts",
      "file-convention:app/users/page.tsx",
    ]);
  });

  it("route.ts fiil exportları ve page.tsx default exportu için verified ROUTES_TO üretir", () => {
    expect(gateway.edges).toHaveLength(3);

    const getRoute = frameworkEdge(gateway, "GET /api/users", "GET");
    expect(getRoute.resolution).toBe("verified");
    expect(edgeCitesLine(sources, getRoute, "export async function GET")).toBe(true);

    const postRoute = frameworkEdge(gateway, "POST /api/users", "POST");
    expect(postRoute.resolution).toBe("verified");
    expect(edgeCitesLine(sources, postRoute, "export async function POST")).toBe(true);

    const pageRoute = frameworkEdge(gateway, "GET /users", "UsersPage");
    expect(pageRoute.resolution).toBe("verified");
    expect(
      edgeCitesLine(sources, pageRoute, "export default function UsersPage"),
    ).toBe(true);
  });

  it("Endpoint node'ları dosya kuralından türetilen yol + framework özniteliği taşır", () => {
    const byName = new Map(
      gateway.nodes.map((node) => [node.qualifiedName, node]),
    );
    expect(byName.size).toBe(3);

    const apiGet = byName.get("GET /api/users");
    expect(apiGet?.kind).toBe("Endpoint");
    expect(apiGet?.relativePath).toBe("app/api/users/route.ts");
    expect(apiGet?.attributes?.["framework"]).toBe("nextjs");
    expect(apiGet?.attributes?.["path"]).toBe("/api/users");

    const page = byName.get("GET /users");
    expect(page?.relativePath).toBe("app/users/page.tsx");
    expect(page?.attributes?.["method"]).toBe("GET");
  });

  it("iyi biçimli kural dosyaları framework düzeyinde tanı üretmez; ana analiz ready'dir", () => {
    expect(gateway.diagnostics).toEqual([]);
    expect(main.state).toBe("ready");
    expect(main.diagnostics).toEqual([]);
  });

  it("handler'lar analiz setindeki gerçek sembollerdir (uydurma node yok)", () => {
    const getFn = findNode(main, "Function", "GET");
    expect(getFn.relativePath).toBe("app/api/users/route.ts");
    const page = findNode(main, "Function", "UsersPage");
    expect(page.relativePath).toBe("app/users/page.tsx");
  });

  it("ana analiz Endpoint'leri framework özniteliğiyle üretir (ROUTES_TO dedupe korunur)", () => {
    const endpoint = findNode(main, "Endpoint", "GET /users");
    expect(endpoint.attributes?.["framework"]).toBe("nextjs");
    const routes = main.edges.filter(
      (edge) => edge.kind === "ROUTES_TO" && sameRef(edge.from, endpoint),
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]?.resolution).toBe("verified");
    expect((routes[0]?.evidence ?? []).length).toBe(1);
  });

  it("çıktı domain snapshot sözleşmesine uyar", () => {
    const snapshot = createSnapshot({
      workspaceId: "w_fx_nextjs",
      revision: { id: "rev-framework", sequence: 1 },
      configHash: "config-hash-test",
      analyzerFingerprint: "ts-adapter@0.1.0",
      state: main.state === "partial" ? "partial" : "ready",
      createdAt: "2026-11-04T00:00:00.000Z",
      nodes: main.nodes,
      edges: main.edges,
    });
    expect(snapshot.nodes.length).toBe(main.nodes.length);
    expect(snapshot.edges.length).toBe(main.edges.length);
  });
});

/* ------------------------------------------------------------------ */
/* Negatif: framework olmayan projede framework kenarı üretilmez       */
/* ------------------------------------------------------------------ */

describe("extractFrameworkEdges — negatif (framework olmayan proje)", () => {
  // Express importu YOK; jenerik `<x>.<verb>` kalıbı yerel Router ile var.
  const input: TypeScriptAdapterInput = {
    workspaceId: "w_fx_plain",
    rootDir: EXPRESS_FIXTURE_ROOT,
    sources: [
      {
        relativePath: "src/router.ts",
        content: [
          "export class Router {",
          "  get(path: string, handler: () => void): void {",
          "    void path;",
          "    handler();",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
      {
        relativePath: "src/app.ts",
        content: [
          'import { Router } from "./router.js";',
          "",
          "const router = new Router();",
          "",
          "function listThings(): void {}",
          "",
          'router.get("/things", listThings);',
          "",
        ].join("\n"),
      },
    ],
  };

  const gateway = extractFrameworkEdges(input);
  const main = analyzeTypeScriptProgram(input);

  it("gateway hiçbir detection/node/edge/diagnostic üretmez", () => {
    expect(gateway.detections).toEqual([]);
    expect(gateway.nodes).toEqual([]);
    expect(gateway.edges).toEqual([]);
    expect(gateway.diagnostics).toEqual([]);
  });

  it("Faz A jenerik davranışı korunur: ROUTES_TO üretilir ama framework özniteliği YOKTUR", () => {
    const endpoint = findNode(main, "Endpoint", "GET /things");
    expect(endpoint.attributes?.["method"]).toBe("GET");
    expect(endpoint.attributes?.["path"]).toBe("/things");
    expect("framework" in (endpoint.attributes ?? {})).toBe(false);
    const routes = main.edges.filter(
      (edge) => edge.kind === "ROUTES_TO" && sameRef(edge.from, endpoint),
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]?.resolution).toBe("verified");
  });

  it("fixture-ts-orders (Faz A fixture'ı) gateway'de boş kalır; POST /orders özniteliği değişmez", () => {
    const ordersRoot = path.join(EXAMPLES_ROOT, "fixture-ts-orders");
    const ordersInput = loadFixture(ordersRoot, "w_fx_orders");
    const ordersGateway = extractFrameworkEdges(ordersInput);
    expect(ordersGateway.detections).toEqual([]);
    expect(ordersGateway.edges).toEqual([]);
    expect(ordersGateway.nodes).toEqual([]);
    expect(ordersGateway.diagnostics).toEqual([]);

    const ordersMain = analyzeTypeScriptProgram(ordersInput);
    const endpoint = findNode(ordersMain, "Endpoint", "POST /orders");
    expect(endpoint.attributes?.["method"]).toBe("POST");
    expect("framework" in (endpoint.attributes ?? {})).toBe(false);
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* Express attribution kapsamı (receiver tabanlı) — denetim bulgusu 2  */
/* ------------------------------------------------------------------ */

describe("extractFrameworkEdges — Express attribution kapsamı (receiver tabanlı)", () => {
  // Proje-geneli attribution, Express OLMAYAN client.get kaydını da express
  // etiketliyordu. Doğru davranış: yalnızca Express instance'ına bağlanan
  // receiver'lar (express() / express.Router() / Router()) framework
  // özniteliği alır; diğer `<x>.<verb>` kalıpları Faz A jenerik üretiminde
  // kalır (etiketsiz, kenarlı).
  const input: TypeScriptAdapterInput = {
    workspaceId: "w_fx_express_scope",
    rootDir: EXPRESS_FIXTURE_ROOT,
    sources: [
      ...EXPRESS_TYPE_SHIM,
      {
        relativePath: "src/handlers.ts",
        content: [
          "export function usersHandler(): void {}",
          "export function onFetchDone(): void {}",
          "export function createApiClient(): {",
          "  get(path: string, cb: () => void): void;",
          "} {",
          "  return {",
          "    get: (_path: string, cb: () => void) => {",
          "      cb();",
          "    },",
          "  };",
          "}",
          "",
        ].join("\n"),
      },
      {
        relativePath: "src/app.ts",
        content: [
          'import express from "express";',
          'import { usersHandler } from "./handlers.js";',
          "",
          "const app = express();",
          "",
          'app.get("/users", usersHandler);',
          "",
        ].join("\n"),
      },
      {
        relativePath: "src/client.ts",
        content: [
          'import { createApiClient, onFetchDone } from "./handlers.js";',
          "",
          "const client = createApiClient();",
          "",
          'client.get("/external-url", onFetchDone);',
          "",
        ].join("\n"),
      },
    ],
  };

  const gateway = extractFrameworkEdges(input);
  const main = analyzeTypeScriptProgram(input);

  it("gateway yalnızca express instance kayıtlarını taşır; client.get dışlanır", () => {
    expect(gateway.detections.map((detection) => detection.framework)).toEqual([
      "express",
    ]);
    expect(gateway.edges).toHaveLength(1);
    const edge = gateway.edges[0] as (typeof gateway.edges)[number];
    expect(edge.from.qualifiedName).toBe("GET /users");
    expect(edge.to.qualifiedName).toBe("usersHandler");
    expect(gateway.nodes.map((node) => node.qualifiedName)).toEqual([
      "GET /users",
    ]);
  });

  it("client.get jenerik Faz A üretiminde kalır: Endpoint var, framework etiketi YOK", () => {
    const endpoint = findNode(main, "Endpoint", "GET /external-url");
    expect("framework" in (endpoint.attributes ?? {})).toBe(false);
    const routes = main.edges.filter(
      (edge) => edge.kind === "ROUTES_TO" && sameRef(edge.from, endpoint),
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]?.resolution).toBe("verified");

    const usersEndpoint = findNode(main, "Endpoint", "GET /users");
    expect(usersEndpoint.attributes?.["framework"]).toBe("express");
  });
});

/* ------------------------------------------------------------------ */
/* Partial: bilinmeyen framework pattern'i → kenar yok + tanı notu     */
/* ------------------------------------------------------------------ */

describe("extractFrameworkEdges — partial (bilinmeyen framework pattern'i)", () => {
  const input: TypeScriptAdapterInput = {
    workspaceId: "w_fx_partial",
    rootDir: EXPRESS_FIXTURE_ROOT,
    sources: [
      {
        relativePath: "app/api/unknown/route.ts",
        content: [
          "// App Router kural dosyası ama tanınmayan export şekli.",
          "export const handler = async (): Promise<number> => 42;",
          "",
        ].join("\n"),
      },
      {
        relativePath: "app/legacy/page.tsx",
        content: [
          "// Anonim default export: linker sembol icat edemez (uydurma yasak).",
          'export default () => ({ label: "legacy" });',
          "",
        ].join("\n"),
      },
      {
        relativePath: "src/lib/util.ts",
        content: "export function util(): number {\n  return 1;\n}\n",
      },
    ],
  };

  const gateway = extractFrameworkEdges(input);
  const main = analyzeTypeScriptProgram(input);

  it("kural dosyaları nextjs olarak algılanır (detection ayrı: dosya kuralı sağlam)", () => {
    expect(gateway.detections).toHaveLength(1);
    const detection = gateway.detections[0] as (typeof gateway.detections)[number];
    expect(detection.framework).toBe("nextjs");
    expect([...detection.basis].sort()).toEqual([
      "file-convention:app/api/unknown/route.ts",
      "file-convention:app/legacy/page.tsx",
    ]);
  });

  it("bilinmeyen pattern için kenar YOK, node icat EDİLMEZ", () => {
    expect(gateway.edges).toEqual([]);
    expect(gateway.nodes).toEqual([]);
    expect(main.edges.filter((edge) => edge.kind === "ROUTES_TO")).toEqual([]);
  });

  it("her bilinmeyen kural dosyası için FRAMEWORK_PATTERN_UNKNOWN tanı notu düşer", () => {
    expect(gateway.diagnostics).toHaveLength(2);
    const paths = gateway.diagnostics.map((d) => d.relativePath).sort();
    expect(paths).toEqual([
      "app/api/unknown/route.ts",
      "app/legacy/page.tsx",
    ]);
    for (const diagnostic of gateway.diagnostics) {
      expect(diagnostic.code).toBe("FRAMEWORK_PATTERN_UNKNOWN");
      expect(diagnostic.line).toBeGreaterThanOrEqual(1);
      expect(diagnostic.message.length).toBeGreaterThan(0);
    }
  });

  it("tanı notu ana analize taşınır (state partial) ve sağlam dosya tanısız kalır", () => {
    expect(main.state).toBe("partial");
    const frameworkNotes = main.diagnostics.filter(
      (d) => d.code === "FRAMEWORK_PATTERN_UNKNOWN",
    );
    expect(frameworkNotes).toHaveLength(2);
    expect(
      main.diagnostics.every(
        (d) => d.relativePath !== "src/lib/util.ts",
      ),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Birleşik giriş: tek koşum, iki dilim — denetim bulgusu 3            */
/* ------------------------------------------------------------------ */

describe("analyzeTypeScriptProgramWithFrameworks — tek koşum iki çıktı", () => {
  // extractFrameworkEdges tüm analizi baştan koşturur; iki API'yi birlikte
  // çağıran istemci 2x derleme maliyeti öder. Birleşik giriş TEK koşumla
  // iki dilimi döndürür ve ikisiyle bit-bit eşdeğerdir.
  it("express girdisinde result ve framework dilimleri ayrı API'lerle bit-bit aynı", () => {
    const input = loadExpressFixture("w_fx_combined_express");
    const combined = analyzeTypeScriptProgramWithFrameworks(input);
    expect(JSON.stringify(combined.result)).toBe(
      JSON.stringify(analyzeTypeScriptProgram(input)),
    );
    expect(JSON.stringify(combined.framework)).toBe(
      JSON.stringify(extractFrameworkEdges(input)),
    );
  }, 30_000);

  it("next.js girdisinde eşdeğerlik korunur", () => {
    const input = loadFixture(NEXTJS_FIXTURE_ROOT, "w_fx_combined_next");
    const combined = analyzeTypeScriptProgramWithFrameworks(input);
    expect(JSON.stringify(combined.result)).toBe(
      JSON.stringify(analyzeTypeScriptProgram(input)),
    );
    expect(JSON.stringify(combined.framework)).toBe(
      JSON.stringify(extractFrameworkEdges(input)),
    );
  }, 30_000);

  it("framework olmayan girdide de eşdeğerlik korunur", () => {
    const input = loadFixture(path.join(EXAMPLES_ROOT, "fixture-ts-orders"), "w_fx_combined_orders");
    const combined = analyzeTypeScriptProgramWithFrameworks(input);
    expect(JSON.stringify(combined.result)).toBe(
      JSON.stringify(analyzeTypeScriptProgram(input)),
    );
    expect(JSON.stringify(combined.framework)).toBe(
      JSON.stringify(extractFrameworkEdges(input)),
    );
    expect(combined.framework.edges).toEqual([]);
    expect(combined.framework.detections).toEqual([]);
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* Determinizm (TŞ §8 invariant vi)                                    */
/* ------------------------------------------------------------------ */

describe("extractFrameworkEdges — determinizm", () => {
  const expressInput = loadExpressFixture("w_fx_express");
  const nextInput = loadFixture(NEXTJS_FIXTURE_ROOT, "w_fx_nextjs");

  it(
    "her fixture: iki gateway koşumu bit-bit aynı",
    () => {
      expect(JSON.stringify(extractFrameworkEdges(expressInput))).toBe(
        JSON.stringify(extractFrameworkEdges(expressInput)),
      );
      expect(JSON.stringify(extractFrameworkEdges(nextInput))).toBe(
        JSON.stringify(extractFrameworkEdges(nextInput)),
      );
    },
    30_000,
  );

  it(
    "her fixture: iki ana analiz koşumu bit-bit aynı",
    () => {
      expect(JSON.stringify(analyzeTypeScriptProgram(expressInput))).toBe(
        JSON.stringify(analyzeTypeScriptProgram(expressInput)),
      );
      expect(JSON.stringify(analyzeTypeScriptProgram(nextInput))).toBe(
        JSON.stringify(analyzeTypeScriptProgram(nextInput)),
      );
    },
    30_000,
  );

  it(
    "girdi dosya sırası değişse bile çıktı aynı kalır",
    () => {
      for (const input of [expressInput, nextInput]) {
        const shuffled: TypeScriptAdapterInput = {
          ...input,
          sources: [...input.sources].reverse(),
        };
        expect(JSON.stringify(extractFrameworkEdges(shuffled))).toBe(
          JSON.stringify(extractFrameworkEdges(input)),
        );
        expect(JSON.stringify(analyzeTypeScriptProgram(shuffled))).toBe(
          JSON.stringify(analyzeTypeScriptProgram(input)),
        );
      }
    },
    30_000,
  );
});
