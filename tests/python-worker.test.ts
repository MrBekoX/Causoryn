/**
 * Python sidecar worker kabul testleri — M1-Python (TŞ v2.1 §7, §22, §23).
 *
 * Sözleşme: native/python-worker/PROTOCOL.md (protokol v1 — roslyn-worker
 * PROTOCOL.md v1 deseni). Pozitif + negatif + partial üçlüsü, kaynak
 * sınırları, dekoratör route kuralları (TŞ §7: Python AST + framework
 * rules, seçili L3) ve determinizm invariant'ı (TŞ §8 invariant vi) burada
 * kanıtlanır. TŞ §22: "Python selected route; unresolved dynamic import;
 * deterministic export" golden testleri.
 *
 * Çözümleme dürüstlük kuralları (PROTOCOL.md resolution tablosu):
 *  - aynı modülde tanımlı sembol → verified (AST isim bağlamı),
 *  - import edilen modül sembolü → heuristic (tam type inference YOK),
 *  - çözülemeyen → unresolved + açık UnknownExternal node; uydurma kenar yok.
 *
 * Ön koşul: python 3.13.9 (PATH). Worker saf stdlib'tir (derleme yok);
 * worker.py yoksa suite AÇIKÇA fail eder — eksik teslimat sessiz skip ile
 * geçiştirilmez. Skip yalnızca python bulunamadığında meşrudur
 * (koşulamadı olarak raporlanır).
 *
 * Güvenlik notu (proje kırmızı çizgisi 6): süreç koşumları spawnSync ile
 * LİTERAL "python" + ARGÜMAN DİZİSİ ve shell: false ile yapılır; worker
 * script yolu repo içi SABİT yol constant'ıdır; istek içeriği yalnızca
 * stdin üzerinden taşınır; girdi asla komut satırına interpole edilmez.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { EDGE_KIND_SET, NODE_KIND_SET, RESOLUTION_SET } from "@causoryn/domain";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_SCRIPT = join(REPO_ROOT, "native", "python-worker", "worker.py");
const FIXTURE_DIR = join(REPO_ROOT, "examples", "fixture-python-app");

const FIXTURE_FILES = [
  "app.py",
  "services/orders_service.py",
  "repositories/order_repository.py",
] as const;

/* ------------------------------------------------------------------ */
/* Protokol tipleri (PROTOCOL.md v1 yanıt şeması)                      */
/* ------------------------------------------------------------------ */

interface Span {
  relativePath: string;
  startLine: number;
  endLine: number;
  sourceHash: string;
}

interface Evidence {
  kind: string;
  span?: Span;
  analyzerId: string;
  analyzerVersion: string;
  rationale: string;
}

interface NodeRef {
  kind: string;
  qualifiedName: string;
  relativePath?: string | null;
}

interface WorkerNode {
  kind: string;
  qualifiedName: string;
  language?: string;
  relativePath?: string | null;
  span?: { startLine: number; endLine: number };
  attributes: Record<string, unknown>;
}

interface WorkerEdge {
  kind: string;
  from: NodeRef;
  to: NodeRef;
  resolution: string;
  evidence: Evidence[];
  ambiguity?: { candidates: string[]; reason: string };
}

interface WorkerResponse {
  id: unknown;
  protocolVersion?: string;
  status: string;
  worker?: { analyzerId: string; analyzerVersion: string };
  capabilities?: Record<string, unknown>;
  coverageRatio?: number;
  unsupportedConstructs?: string[];
  warnings?: string[];
  diagnostics?: Array<{
    relativePath: string;
    code: string;
    message: string;
    line: number;
  }>;
  nodes?: WorkerNode[];
  edges?: WorkerEdge[];
  evidence?: Evidence[];
  error?: { code: string; message: string };
}

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */

/** Satır-bazlı istek(ler)i gönderir; (yanıt satırları, stderr, exit) döner. */
function runWorker(requests: unknown[]): {
  lines: string[];
  stderr: string;
  exitCode: number;
} {
  const input =
    requests.map((request) => JSON.stringify(request)).join("\n") + "\n";
  const result = spawnSync("python", [WORKER_SCRIPT], {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const lines = stdout
    .split("\n")
    .filter((line) => line.trim().length > 0);
  return {
    lines,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode: result.status ?? -1,
  };
}

function runRaw(rawStdin: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("python", [WORKER_SCRIPT], {
    input: rawStdin,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode: result.status ?? -1,
  };
}

function parseLine(line: string): WorkerResponse {
  return JSON.parse(line) as WorkerResponse;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fixture(relativePath: string): string {
  return readFileSync(join(FIXTURE_DIR, relativePath), "utf8");
}

function fixtureLine(relativePath: string, needle: string): number {
  const lines = fixture(relativePath).split("\n");
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) {
    throw new Error(`fixture satırı bulunamadı: ${relativePath} '${needle}'`);
  }

  return index + 1;
}

function findEdge(
  response: WorkerResponse | null,
  predicate: (edge: WorkerEdge) => boolean,
): WorkerEdge | undefined {
  return (response?.edges ?? []).find(predicate);
}

/* ------------------------------------------------------------------ */
/* Bootstrap: python var mı? Worker script var mı?                     */
/* ------------------------------------------------------------------ */

const pythonCheck = spawnSync("python", ["--version"], {
  encoding: "utf8",
  shell: false,
});
const pythonAvailable = pythonCheck.status === 0;
if (!pythonAvailable) {
  console.error(
    "[python-worker] python bulunamadı — Python worker kabul testleri skip edilir (koşulamadı olarak raporlanır; PROTOCOL.md §7)",
  );
} else if (!existsSync(WORKER_SCRIPT)) {
  // Denetim disiplini (roslyn-worker.test.ts ile aynı): koşulabilen ortamda
  // eksik teslimat sessiz yeşile geçiştirilemez.
  throw new Error(
    `python worker script bulunamadı: ${WORKER_SCRIPT} — eksik teslimat testleri fail etmeli`,
  );
}

/* ------------------------------------------------------------------ */
/* Testler                                                             */
/* ------------------------------------------------------------------ */

// Python yokluğunda koşulamayan blok: meşru skip (PROTOCOL.md §7).
describe.skipIf(!pythonAvailable)("tests/python-worker (M1-Python)", () => {
  let positive: WorkerResponse | null = null;
  let positiveRawLine = "";

  beforeAll(() => {
    const run = runWorker([
      {
        id: "fixture-orders-1",
        type: "analyze",
        protocolVersion: "1",
        files: FIXTURE_FILES.map((relativePath) => ({
          path: relativePath,
          content: fixture(relativePath),
        })),
      },
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.lines.length).toBe(1);
    positiveRawLine = run.lines[0] ?? "";
    positive = parseLine(positiveRawLine);
  });

  it("pozitif: status ready, protokol v1, worker kimliği python-worker", () => {
    expect(positive?.status).toBe("ready");
    expect(positive?.protocolVersion).toBe("1");
    expect(positive?.id).toBe("fixture-orders-1");
    expect(positive?.worker?.analyzerId).toBe("python-worker");
    expect(positive?.worker?.analyzerVersion).toBe("0.1.0");
    expect(positive?.diagnostics).toEqual([]);
  });

  it("pozitif: capabilities TŞ §7 sözleşmesiyle taşınır", () => {
    expect(positive?.capabilities?.astParse).toBe(true);
    expect(positive?.capabilities?.symbolResolution).toBe(true);
    expect(positive?.capabilities?.containsEdges).toBe(true);
    expect(positive?.capabilities?.callEdges).toBe(true);
    expect(positive?.capabilities?.importEdges).toBe(false);
    expect(positive?.capabilities?.frameworkLinkers).toBe(false);
    expect(positive?.capabilities?.routeDetection).toBe(
      "python-decorator-route-pattern",
    );
  });

  it("pozitif: node kümesi — 21 node, katalog türleriyle", () => {
    const nodes = positive?.nodes ?? [];
    expect(nodes.length).toBe(21);
    for (const node of nodes) {
      expect(NODE_KIND_SET.has(node.kind)).toBe(true);
      expect(node.language).toBe("python");
    }

    const byQualifiedName = new Map(nodes.map((n) => [n.qualifiedName, n]));
    // File node'ları: qualifiedName = relativePath (roslyn kuralıyla aynı).
    for (const relativePath of FIXTURE_FILES) {
      const fileNode = byQualifiedName.get(relativePath);
      expect(fileNode?.kind).toBe("File");
      expect(fileNode?.attributes["sourceHash"]).toBe(sha256Hex(fixture(relativePath)));
    }
    // Function node'ları (async def dahil — audit_order).
    const expectedFunctions = [
      "app.get_orders",
      "app.add_order",
      "services.orders_service._validate_order",
      "services.orders_service.create_order",
      "services.orders_service.list_orders",
      "services.orders_service.audit_order",
      "repositories.order_repository.save",
      "repositories.order_repository.all_orders",
    ];
    for (const qualifiedName of expectedFunctions) {
      expect(byQualifiedName.get(qualifiedName)?.kind).toBe("Function");
    }
    // Class + Method node'ları.
    expect(byQualifiedName.get("repositories.order_repository.OrderRepository")?.kind).toBe(
      "Class",
    );
    expect(
      byQualifiedName.get("repositories.order_repository.OrderRepository.save")?.kind,
    ).toBe("Method");
    expect(
      byQualifiedName.get("repositories.order_repository.OrderRepository._stamp")?.kind,
    ).toBe("Method");
    // Endpoint node'ları: "{VERB} {path}" qualifiedName kuralı (roslyn kuralıyla aynı).
    const getOrders = byQualifiedName.get("GET /orders");
    expect(getOrders?.kind).toBe("Endpoint");
    expect(getOrders?.attributes["method"]).toBe("GET");
    expect(getOrders?.attributes["path"]).toBe("/orders");
    expect(getOrders?.relativePath).toBe("app.py");
    const postOrders = byQualifiedName.get("POST /orders");
    expect(postOrders?.kind).toBe("Endpoint");
    expect(postOrders?.attributes["method"]).toBe("POST");
    expect(postOrders?.attributes["path"]).toBe("/orders");
    // UnknownExternal: çözümsüz çağrı hedefleri açık node'dur (uydurma yok).
    expect(byQualifiedName.get("logger.info")?.kind).toBe("UnknownExternal");
    expect(byQualifiedName.get("list")?.kind).toBe("UnknownExternal");
    expect(byQualifiedName.get("_ORDERS.values")?.kind).toBe("UnknownExternal");
  });

  it("pozitif: CONTAINS kenarları verified + AST span kanıtlı", () => {
    const contains = (positive?.edges ?? []).filter((edge) => edge.kind === "CONTAINS");
    expect(contains.length).toBe(11);
    for (const edge of contains) {
      expect(edge.resolution).toBe("verified");
      expect(edge.evidence.length).toBeGreaterThan(0);
      expect(edge.evidence[0]?.kind).toBe("ast-span");
      expect(edge.evidence[0]?.analyzerId).toBe("python-worker");
    }
    // Örnek kanıt: Class → Method kenarı, span._stamp bildirim satırını taşır.
    const stampContains = findEdge(
      positive,
      (edge) =>
        edge.kind === "CONTAINS" &&
        edge.from.qualifiedName === "repositories.order_repository.OrderRepository" &&
        edge.to.qualifiedName === "repositories.order_repository.OrderRepository._stamp",
    );
    expect(stampContains?.evidence[0]?.span?.relativePath).toBe(
      "repositories/order_repository.py",
    );
    expect(stampContains?.evidence[0]?.span?.startLine).toBe(
      fixtureLine("repositories/order_repository.py", "def _stamp"),
    );
    expect(stampContains?.evidence[0]?.span?.sourceHash).toBe(
      sha256Hex(fixture("repositories/order_repository.py")),
    );
    expect(stampContains?.evidence[0]?.rationale).toBe(
      "CONTAINS: the method declaration repositories.order_repository.OrderRepository._stamp " +
        "in repositories/order_repository.py was matched with AST span evidence.",
    );
  });

  it("node span: Function/Method/Class nodes carry their declaration lines (= CONTAINS evidence span)", () => {
    const nodes = positive?.nodes ?? [];
    const declarations = nodes.filter((node) =>
      ["Function", "Method", "Class"].includes(node.kind),
    );
    expect(declarations.length).toBe(11);
    for (const node of declarations) {
      const contains = findEdge(
        positive,
        (edge) =>
          edge.kind === "CONTAINS" &&
          edge.to.kind === node.kind &&
          edge.to.qualifiedName === node.qualifiedName,
      );
      const evidenceSpan = contains?.evidence[0]?.span;
      expect(node.span, node.qualifiedName).toEqual({
        startLine: evidenceSpan?.startLine,
        endLine: evidenceSpan?.endLine,
      });
    }
    const stamp = nodes.find(
      (node) => node.qualifiedName === "repositories.order_repository.OrderRepository._stamp",
    );
    expect(stamp?.span?.startLine).toBe(
      fixtureLine("repositories/order_repository.py", "def _stamp"),
    );
    for (const node of nodes.filter((candidate) =>
      ["File", "Endpoint", "UnknownExternal"].includes(candidate.kind),
    )) {
      expect(node.span, `${node.kind} ${node.qualifiedName}`).toBeUndefined();
    }
  });

  it("node span: a node declared twice (property getter + setter) covers both declarations", () => {
    const source = [
      "class Ledger:", // 1
      "    @property", // 2
      "    def amount(self):", // 3
      "        return 1", // 4
      "", // 5
      "    @amount.setter", // 6
      "    def amount(self, value):", // 7
      "        pass", // 8
      "",
    ].join("\n");
    const run = runWorker([
      {
        id: "span-widen",
        type: "analyze",
        files: [{ path: "ledger.py", content: source }],
      },
    ]);
    const response = parseLine(run.lines[0] ?? "");
    const amount = response.nodes?.find(
      (node) => node.kind === "Method" && node.qualifiedName === "ledger.Ledger.amount",
    );
    expect(amount?.span).toEqual({ startLine: 3, endLine: 8 });
    const ledger = response.nodes?.find((node) => node.qualifiedName === "ledger.Ledger");
    expect(ledger?.span).toEqual({ startLine: 1, endLine: 8 });
  });

  it("pozitif: aynı modülde tanımlı hedef → verified CALLS", () => {
    const expectedVerified: Array<[string, string]> = [
      [
        "services.orders_service.create_order",
        "services.orders_service._validate_order",
      ],
      [
        "repositories.order_repository.OrderRepository.save",
        "repositories.order_repository.save",
      ],
      [
        "repositories.order_repository.OrderRepository.save",
        "repositories.order_repository.OrderRepository._stamp",
      ],
    ];
    for (const [fromQn, toQn] of expectedVerified) {
      const edge = findEdge(
        positive,
        (candidate) =>
          candidate.kind === "CALLS" &&
          candidate.from.qualifiedName === fromQn &&
          candidate.to.qualifiedName === toQn,
      );
      expect(edge, `verified CALLS eksik: ${fromQn} → ${toQn}`).toBeDefined();
      expect(edge?.resolution).toBe("verified");
      expect(edge?.evidence.length).toBeGreaterThan(0);
      expect(edge?.evidence[0]?.kind).toBe("ast-span");
      expect(edge?.evidence[0]?.span?.sourceHash).toBe(
        sha256Hex(fixture(edge?.evidence[0]?.span?.relativePath ?? "")),
      );
    }
    // Çağrı noktası kanıtı: create_order → _validate_order satır içerikle eşleşir.
    const validateCall = findEdge(
      positive,
      (edge) =>
        edge.kind === "CALLS" &&
        edge.from.qualifiedName === "services.orders_service.create_order" &&
        edge.to.qualifiedName === "services.orders_service._validate_order",
    );
    expect(validateCall?.evidence[0]?.span?.relativePath).toBe("services/orders_service.py");
    // Çağrı noktası: 4 boşluklu gövde satırı — def bildirim satırıyla karışmaz.
    expect(validateCall?.evidence[0]?.span?.startLine).toBe(
      fixtureLine("services/orders_service.py", "    _validate_order(order)"),
    );
    // Evidence rationale is plain English runtime text.
    expect(validateCall?.evidence[0]?.rationale).toBe(
      "CALLS: services.orders_service.create_order → services.orders_service._validate_order " +
        "resolved via the AST name binding of '_validate_order' defined in the same module (verified).",
    );
  });

  it("pozitif: import edilen modül sembolü → heuristic CALLS + ambiguity", () => {
    const expectedHeuristic: Array<[string, string]> = [
      ["app.get_orders", "services.orders_service.list_orders"],
      ["app.add_order", "services.orders_service.create_order"],
      ["services.orders_service.create_order", "repositories.order_repository.save"],
      ["services.orders_service.list_orders", "repositories.order_repository.all_orders"],
    ];
    for (const [fromQn, toQn] of expectedHeuristic) {
      const edge = findEdge(
        positive,
        (candidate) =>
          candidate.kind === "CALLS" &&
          candidate.from.qualifiedName === fromQn &&
          candidate.to.qualifiedName === toQn,
      );
      expect(edge, `heuristic CALLS eksik: ${fromQn} → ${toQn}`).toBeDefined();
      expect(edge?.resolution).toBe("heuristic");
      expect(edge?.ambiguity?.reason.length ?? 0).toBeGreaterThan(0);
      expect(edge?.ambiguity?.reason).toBe(
        "imported module symbol; Python name binding is dynamic, so no definitive resolution was made",
      );
      expect(edge?.evidence.length).toBeGreaterThan(0);
      expect(edge?.evidence[0]?.rationale).toBe(
        `CALLS: ${fromQn} → ${toQn} resolved through an imported module symbol ` +
          "(heuristic; no full type inference).",
      );
    }
  });

  it("pozitif: çözülemeyen çağrı → unresolved + açık UnknownExternal (uydurma yok)", () => {
    const unresolved = (positive?.edges ?? []).filter(
      (edge) => edge.kind === "CALLS" && edge.resolution === "unresolved",
    );
    expect(unresolved.length).toBe(5);
    const targets = unresolved.map((edge) => edge.to.qualifiedName).sort();
    expect(targets).toEqual([
      "ValueError",
      "_ORDERS.values",
      "isinstance",
      "list",
      "logger.info",
    ]);
    for (const edge of unresolved) {
      expect(edge.to.kind).toBe("UnknownExternal");
      expect(edge.evidence.length).toBeGreaterThan(0);
      expect(edge.evidence[0]?.kind).toBe("ast-span");
    }
    const loggerCall = findEdge(
      positive,
      (edge) =>
        edge.kind === "CALLS" && edge.to.qualifiedName === "logger.info",
    );
    expect(loggerCall?.from.qualifiedName).toBe("app.get_orders");
    expect(loggerCall?.evidence[0]?.rationale).toBe(
      "CALLS: app.get_orders → logger.info could not be resolved (unresolved); " +
        "no fabricated target was produced.",
    );
    expect(loggerCall?.evidence[0]?.span?.relativePath).toBe("app.py");
    expect(loggerCall?.evidence[0]?.span?.startLine).toBe(
      // Çağrı satırı özgün iğne: başlıktaki yorum da "logger.info" içerir.
      fixtureLine("app.py", 'logger.info("siparişler sorgulandı")'),
    );
  });

  it("pozitif: Endpoint node + verified ROUTES_TO (route-attribute kanıtı)", () => {
    const routesTo = (positive?.edges ?? []).filter((edge) => edge.kind === "ROUTES_TO");
    expect(routesTo.length).toBe(2);
    for (const edge of routesTo) {
      expect(edge.from.kind).toBe("Endpoint");
      expect(edge.resolution).toBe("verified");
      expect(edge.evidence[0]?.kind).toBe("route-attribute");
      expect(edge.evidence[0]?.analyzerId).toBe("python-worker");
    }
    const getRoute = findEdge(
      positive,
      (edge) =>
        edge.kind === "ROUTES_TO" &&
        edge.from.qualifiedName === "GET /orders" &&
        edge.to.qualifiedName === "app.get_orders",
    );
    expect(getRoute).toBeDefined();
    expect(getRoute?.evidence[0]?.span?.relativePath).toBe("app.py");
    expect(getRoute?.evidence[0]?.span?.startLine).toBe(
      fixtureLine("app.py", '@app.get("/orders")'),
    );
    const postRoute = findEdge(
      positive,
      (edge) =>
        edge.kind === "ROUTES_TO" &&
        edge.from.qualifiedName === "POST /orders" &&
        edge.to.qualifiedName === "app.add_order",
    );
    expect(postRoute?.evidence[0]?.span?.startLine).toBe(
      fixtureLine("app.py", '@app.post("/orders")'),
    );
  });

  it("pozitif: evidence bütünlüğü — her kenar kanıtlı, hash'ler dosya içeriğiyle eşleşir", () => {
    const edges = positive?.edges ?? [];
    expect(edges.length).toBe(25);
    const contentHashes = new Map<string, string>(
      FIXTURE_FILES.map((relativePath) => [relativePath, sha256Hex(fixture(relativePath))]),
    );
    for (const edge of edges) {
      expect(RESOLUTION_SET.has(edge.resolution)).toBe(true);
      expect(EDGE_KIND_SET.has(edge.kind)).toBe(true);
      if (edge.resolution === "verified") {
        // TŞ §8 invariant (i): verified kenar en az bir geçerli evidence taşır.
        expect(edge.evidence.length).toBeGreaterThan(0);
      }
      for (const item of edge.evidence) {
        expect(item.analyzerId).toBe("python-worker");
        expect(item.analyzerVersion).toBe("0.1.0");
        expect(item.rationale.length).toBeGreaterThan(0);
        const span = item.span;
        if (span !== undefined) {
          expect(span.sourceHash).toBe(contentHashes.get(span.relativePath));
          expect(span.startLine).toBeGreaterThan(0);
          expect(span.endLine).toBeGreaterThanOrEqual(span.startLine);
        }
      }
    }
  });

  it("pozitif: coverageRatio = verified/toplam kenar (16/25 → 0.64)", () => {
    const edges = positive?.edges ?? [];
    const verified = edges.filter((edge) => edge.resolution === "verified").length;
    expect(positive?.coverageRatio).toBeCloseTo(verified / edges.length, 4);
    expect(positive?.coverageRatio).toBe(0.64);
  });

  it("determinizm: aynı istek iki koşumda bayt-bayt aynı yanıt satırı", () => {
    const second = runWorker([
      {
        id: "fixture-orders-1",
        type: "analyze",
        protocolVersion: "1",
        files: FIXTURE_FILES.map((relativePath) => ({
          path: relativePath,
          content: fixture(relativePath),
        })),
      },
    ]);
    expect(second.exitCode).toBe(0);
    expect(second.lines.length).toBe(1);
    expect(second.lines[0]).toBe(positiveRawLine);
  });

  it("dekoratör varyantları: router + Flask route methods + non-literal path uyarısı", () => {
    const routesSource = [
      "from fastapi import APIRouter",
      "from flask import Flask",
      "",
      "router = APIRouter()",
      "flask_app = Flask(__name__)",
      "",
      '@router.get("/items")',
      "def list_items():",
      "    return []",
      "",
      '@router.post("/items")',
      "def create_item():",
      "    return {}",
      "",
      '@flask_app.route("/legacy", methods=["GET", "POST"])',
      "def legacy_handler():",
      "    return []",
      "",
      '@flask_app.route("/health")',
      "def health():",
      '    return {"ok": True}',
      "",
      '@flask_app.delete("/items/{item_id}")',
      "def delete_item(item_id):",
      "    return item_id",
      "",
      'prefix = "/not-literal"',
      "",
      "@flask_app.get(prefix)",
      "def not_literal_route():",
      "    return []",
      "",
    ].join("\n");

    const run = runWorker([
      {
        id: "decorator-variants-1",
        type: "analyze",
        protocolVersion: "1",
        files: [{ path: "routes.py", content: routesSource }],
      },
    ]);
    expect(run.exitCode).toBe(0);
    const response = parseLine(run.lines[0] ?? "");
    expect(response.status).toBe("ready");

    const endpoints = (response.nodes ?? []).filter((node) => node.kind === "Endpoint");
    const endpointNames = endpoints.map((node) => node.qualifiedName).sort();
    expect(endpointNames).toEqual([
      "DELETE /items/{item_id}",
      "GET /health",
      "GET /items",
      "GET /legacy",
      "POST /items",
      "POST /legacy",
    ]);
    // Flask route methods listesi → method başına bir Endpoint (Flask varsayılanı GET).
    const legacy = endpoints.filter((node) => node.attributes["path"] === "/legacy");
    expect(legacy.map((node) => node.attributes["method"]).sort()).toEqual(["GET", "POST"]);
    // methods olmadan Flask route → GET varsayılanı.
    const health = endpoints.find((node) => node.attributes["path"] === "/health");
    expect(health?.attributes["method"]).toBe("GET");

    const routesTo = (response.edges ?? []).filter((edge) => edge.kind === "ROUTES_TO");
    expect(routesTo.length).toBe(6);
    for (const edge of routesTo) {
      expect(edge.resolution).toBe("verified");
      expect(edge.evidence[0]?.kind).toBe("route-attribute");
    }
    // Non-literal dekoratör yolu: endpoint ÜRETİLMEZ, açık uyarı yazılır.
    expect(endpointNames).not.toContain("GET /not-literal");
    expect(
      (response.warnings ?? []).some(
        (w) =>
          w ===
          "routes.py: the route path of decorator 'flask_app.get' is not a literal string; " +
            "no endpoint was produced for routes.not_literal_route",
      ),
    ).toBe(true);
    const legacyRoute = routesTo.find((edge) => edge.from.qualifiedName === "GET /legacy");
    expect(legacyRoute?.evidence[0]?.rationale).toBe(
      "ROUTES_TO: flask_app.route('/legacy', methods=['GET', 'POST']) is bound to handler " +
        "routes.legacy_handler (verified).",
    );
  });

  it("negatif: eksik id → INVALID_ARGUMENT + id null", () => {
    const run = runWorker([{ type: "analyze", files: [{ path: "a.py", content: "x = 1" }] }]);
    expect(run.exitCode).toBe(0);
    const response = parseLine(run.lines[0] ?? "");
    expect(response.status).toBe("error");
    expect(response.id).toBeNull();
    expect(response.error?.code).toBe("INVALID_ARGUMENT");
  });

  it("negatif: bilinmeyen type / protocolVersion / üst-düzey alan → INVALID_ARGUMENT + id echo", () => {
    const unknownType = runWorker([{ id: 7, type: "rewrite", files: [{ path: "a.py", content: "x = 1" }] }]);
    const typeResponse = parseLine(unknownType.lines[0] ?? "");
    expect(typeResponse.status).toBe("error");
    expect(typeResponse.id).toBe(7);
    expect(typeResponse.error?.code).toBe("INVALID_ARGUMENT");
    expect(typeResponse.error?.message).toBe("type must be 'analyze': 'rewrite'");

    const unknownVersion = runWorker([
      { id: "v2", type: "analyze", protocolVersion: "2", files: [{ path: "a.py", content: "x = 1" }] },
    ]);
    expect(parseLine(unknownVersion.lines[0] ?? "").error?.code).toBe("INVALID_ARGUMENT");
    expect(parseLine(unknownVersion.lines[0] ?? "").error?.message).toBe(
      "unsupported protocolVersion: '2'",
    );

    const unknownField = runWorker([
      {
        id: "f1",
        type: "analyze",
        files: [{ path: "a.py", content: "x = 1" }],
        referenceDirs: ["/tmp"],
      },
    ]);
    expect(parseLine(unknownField.lines[0] ?? "").error?.code).toBe("INVALID_ARGUMENT");
    expect(parseLine(unknownField.lines[0] ?? "").error?.message).toBe(
      "unknown request field(s): referenceDirs",
    );
  });

  it("negatif: files eksik/boş + yol ihlalleri → INVALID_ARGUMENT", () => {
    const base = { id: "paths", type: "analyze", protocolVersion: "1" };
    const cases: unknown[] = [
      { ...base }, // files eksik
      { ...base, files: [] }, // files boş
      { ...base, files: [{ path: "a.py" }] }, // content eksik
      { ...base, files: [{ path: "a.py", content: "x = 1", extra: true }] }, // bilinmeyen alan
      { ...base, files: [{ path: "../escape.py", content: "x = 1" }] }, // .. kaçışı
      { ...base, files: [{ path: "/abs.py", content: "x = 1" }] }, // mutlak yol
      { ...base, files: [{ path: "C:/abs.py", content: "x = 1" }] }, // sürücü harfi
      { ...base, files: [{ path: "a\\b.py", content: "x = 1" }] }, // backslash (POSIX sözleşmesi)
      { ...base, files: [{ path: "a//b.py", content: "x = 1" }] }, // boş segment
      {
        ...base,
        files: [
          { path: "a.py", content: "x = 1" },
          { path: "a.py", content: "y = 2" },
        ],
      }, // duplicate yol
      { ...base, files: [{ path: "a.py", content: "x = 1" }], maxNodes: 0 }, // maxNodes aralık dışı
    ];
    const expectedMessages = [
      "files must be a non-empty array",
      "files must be a non-empty array",
      "files[0].content must be a string",
      "files[0] contains unknown field(s): extra",
      "files[].path escapes the workspace root ('..'): ../escape.py",
      "files[].path must not be an absolute path: /abs.py",
      "files[].path must not be an absolute path with a drive letter: C:/abs.py",
      "files[].path must be a POSIX path (backslashes are not accepted): a\\b.py",
      "files[].path contains an empty segment: a//b.py",
      "the same source path was given twice: a.py",
      "maxNodes must be in the range 1..250000: 0",
    ];
    expect(expectedMessages.length).toBe(cases.length);
    const run = runWorker(cases);
    expect(run.exitCode).toBe(0);
    expect(run.lines.length).toBe(cases.length);
    run.lines.forEach((line, index) => {
      const response = parseLine(line);
      expect(response.status).toBe("error");
      expect(response.error?.code).toBe("INVALID_ARGUMENT");
      expect(response.id).toBe("paths");
      expect(response.error?.message).toBe(expectedMessages[index]);
    });
  });

  it("negatif: bozuk JSON satırı → id null hata yanıtı; worker yaşamaya devam eder", () => {
    const run = runRaw('{"id": "kırık", "type": "analyze",\n{"id":"sonra","type":"analyze","protocolVersion":"1","files":[{"path":"a.py","content":"x = 1"}]}\n');
    expect(run.exitCode).toBe(0);
    const lines = run.stdout.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBe(2);
    const broken = parseLine(lines[0] ?? "");
    expect(broken.status).toBe("error");
    expect(broken.id).toBeNull();
    expect(broken.error?.code).toBe("INVALID_ARGUMENT");
    expect(broken.error?.message.startsWith("line is not valid JSON: ")).toBe(true);
    const after = parseLine(lines[1] ?? "");
    expect(after.status).toBe("ready");
    expect(after.id).toBe("sonra");
  });

  it("negatif: derin iç içe JSON satırı (RecursionError) → id null hata yanıtı; worker yaşamaya devam eder", () => {
    // Takım denetimi bulgusu: json.loads yalnızca ValueError yakalıyordu;
    // 5000 katman iç içe dizi decoder'da RecursionError fırlatıp süreci
    // öldürüyordu (exit=1, 0 yanıt) — 'bozuk satır döngüyü düşürmez'
    // sözleşmesi ihlali. Regresyon kilidi: çökme yok, düzgün hata yanıtı
    // var, döngü sonraki isteği işler.
    const deepJson = "[".repeat(5000) + "]".repeat(5000);
    const run = runRaw(
      `${deepJson}\n{"id":"sonra","type":"analyze","protocolVersion":"1","files":[{"path":"a.py","content":"x = 1"}]}\n`,
    );
    expect(run.exitCode).toBe(0);
    const lines = run.stdout.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBe(2);
    const broken = parseLine(lines[0] ?? "");
    expect(broken.status).toBe("error");
    expect(broken.id).toBeNull();
    expect(broken.error?.code).toBe("INVALID_ARGUMENT");
    const after = parseLine(lines[1] ?? "");
    expect(after.status).toBe("ready");
    expect(after.id).toBe("sonra");
  });

  it("negatif: boş satırlar sessizce atlanır", () => {
    const run = runRaw('\n\n{"id":"b","type":"analyze","protocolVersion":"1","files":[{"path":"a.py","content":"x = 1"}]}\n\n');
    expect(run.exitCode).toBe(0);
    const lines = run.stdout.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBe(1);
    expect(parseLine(lines[0] ?? "").id).toBe("b");
  });

  it("negatif: 2 MB dosya içeriği → LIMIT_EXCEEDED", () => {
    const run = runWorker([
      {
        id: "limit-content",
        type: "analyze",
        protocolVersion: "1",
        files: [{ path: "big.py", content: "x".repeat(2_000_001) }],
      },
    ]);
    const response = parseLine(run.lines[0] ?? "");
    expect(response.status).toBe("error");
    expect(response.id).toBe("limit-content");
    expect(response.error?.code).toBe("LIMIT_EXCEEDED");
    expect(response.error?.message).toBe(
      "file content size limit exceeded: big.py (2000001 > 2000000 bytes)",
    );
  });

  it("negatif: 5001 dosya → LIMIT_EXCEEDED", () => {
    const files = Array.from({ length: 5_001 }, (_, index) => ({
      path: `mod_${String(index)}.py`,
      content: "x = 1\n",
    }));
    const run = runWorker([
      { id: "limit-count", type: "analyze", protocolVersion: "1", files },
    ]);
    const response = parseLine(run.lines[0] ?? "");
    expect(response.status).toBe("error");
    expect(response.error?.code).toBe("LIMIT_EXCEEDED");
    expect(response.error?.message).toBe("file count limit exceeded: 5001 > 5000");
  });

  it("partial: sözdizimi hatası → status partial + dosya/satır taşıyan tanı; sağlam dosyanın grafiği üretilir", () => {
    const broken = "def broken(:\n    pass\n";
    const run = runWorker([
      {
        id: "partial-1",
        type: "analyze",
        protocolVersion: "1",
        files: [
          { path: "broken.py", content: broken },
          { path: "ok.py", content: "def fine():\n    return 1\n" },
        ],
      },
    ]);
    expect(run.exitCode).toBe(0);
    const response = parseLine(run.lines[0] ?? "");
    expect(response.status).toBe("partial");
    expect(response.diagnostics?.length).toBeGreaterThan(0);
    const diagnostic = response.diagnostics?.[0];
    expect(diagnostic?.relativePath).toBe("broken.py");
    expect(diagnostic?.line).toBe(1);
    expect(diagnostic?.code.length).toBeGreaterThan(0);
    // Graph yine üretilir: iki File node + sağlam dosyanın bildirimi.
    const nodes = response.nodes ?? [];
    const byQualifiedName = new Map(nodes.map((node) => [node.qualifiedName, node]));
    expect(byQualifiedName.get("broken.py")?.kind).toBe("File");
    expect(byQualifiedName.get("ok.py")?.kind).toBe("File");
    expect(byQualifiedName.get("ok.fine")?.kind).toBe("Function");
    // Bozuk dosyadan bildirim/kenar uydurulmaz.
    expect(byQualifiedName.get("broken.broken")).toBeUndefined();
  });

  it("partial: maxNodes bütçesi → RESPONSE_TRUNCATED tanısı + dangling kenar yok", () => {
    const run = runWorker([
      {
        id: "truncate-1",
        type: "analyze",
        protocolVersion: "1",
        maxNodes: 5,
        files: FIXTURE_FILES.map((relativePath) => ({
          path: relativePath,
          content: fixture(relativePath),
        })),
      },
    ]);
    expect(run.exitCode).toBe(0);
    const response = parseLine(run.lines[0] ?? "");
    expect(response.status).toBe("partial");
    expect((response.nodes ?? []).length).toBeLessThanOrEqual(5);
    expect(
      (response.diagnostics ?? []).some((d) => d.code === "RESPONSE_TRUNCATED"),
    ).toBe(true);
    expect(
      (response.diagnostics ?? []).find((d) => d.code === "RESPONSE_TRUNCATED")?.message,
    ).toBe(
      "node budget exceeded: 5 nodes published; the excess nodes and the edges " +
        "whose endpoints were not published were dropped",
    );
    // Kesilen node'lara işaret eden dangling kenar bırakılmaz.
    const kept = new Set((response.nodes ?? []).map((node) => node.qualifiedName));
    for (const edge of response.edges ?? []) {
      expect(kept.has(edge.from.qualifiedName)).toBe(true);
      expect(kept.has(edge.to.qualifiedName)).toBe(true);
    }
  });

  it("savunma: aşırı derin iç içe yapı → parser SyntaxError → per-file partial tanı; worker yaşar", () => {
    // Takım denetimi bulgusu: worker içi derinlik sayacı tipik koşumda
    // tetiklenmez; GERÇEK savunma CPython parser'ının yapısal sınırıdır
    // ('too many levels of indentation' → SyntaxError). Bu test o
    // savunma yolunu kilitler: çökme yok, dürüst partial tanı var.
    const depth = 500;
    const lines: string[] = [];
    for (let index = 0; index < depth; index += 1) {
      lines.push(`${"    ".repeat(index)}if x:`);
    }
    lines.push(`${"    ".repeat(depth)}pass`);
    const run = runWorker([
      {
        id: "deep-nesting-1",
        type: "analyze",
        protocolVersion: "1",
        files: [{ path: "deep.py", content: `${lines.join("\n")}\n` }],
      },
    ]);
    expect(run.exitCode).toBe(0);
    const response = parseLine(run.lines[0] ?? "");
    expect(response.status).toBe("partial");
    const diagnostic = response.diagnostics?.[0];
    expect(diagnostic?.relativePath).toBe("deep.py");
    expect(diagnostic?.code).toBe("SyntaxError");
    expect((diagnostic?.line ?? 0)).toBeGreaterThan(0);
    // Bozuk dosyadan yalnızca File node (L0); uydurma bildirim yok.
    const nodes = response.nodes ?? [];
    expect(nodes.find((node) => node.qualifiedName === "deep.py")?.kind).toBe("File");
    expect(nodes.every((node) => node.kind !== "Function")).toBe(true);
  });

  it("dekoratör: Name olmayan taşıyıcı → açık uyarı, sessiz kesim yok", () => {
    // Takım denetimi bulgusu: @routers['main'].get('/x') gibi basit-ad
    // olmayan taşıyıcılar sessizce atlanıyordu; literal olmayan YOL gibi
    // açık uyarıyla raporlanmalıdır ('sessiz kesim yoktur' disiplini).
    const source = [
      'routers = {"main": object()}',
      "",
      '@routers["main"].get("/x")',
      "def handler():",
      "    return []",
      "",
    ].join("\n");
    const run = runWorker([
      {
        id: "non-name-carrier-1",
        type: "analyze",
        protocolVersion: "1",
        files: [{ path: "carriers.py", content: source }],
      },
    ]);
    expect(run.exitCode).toBe(0);
    const response = parseLine(run.lines[0] ?? "");
    expect(response.status).toBe("ready");
    const endpoints = (response.nodes ?? []).filter((node) => node.kind === "Endpoint");
    expect(endpoints).toEqual([]);
    expect(
      (response.warnings ?? []).some(
        (warning) =>
          warning.includes("is not a simple name") && warning.includes("no endpoint was produced for"),
      ),
    ).toBe(true);
  });

  it("protokol: stderr UTF-8 kodlanır — PYTHONIOENCODING olmasa bile (locale'e düşmez)", () => {
    // Takım denetimi bulgusu: log() text-mode locale codec ile yazıyordu;
    // PYTHONIOENCODING setli olmayan ortamlarda (denetim sondası) Windows
    // piped stderr cp1254'e düşüp Türkçe metni bozuyordu. Test, env'den
    // PYTHONIOENCODING'i ÇIKARARAK koşar: worker kendi stderr'ini UTF-8'e
    // sabitlemelidir (reconfigure) — parent env'e güvenmez.
    const envWithoutIoEncoding: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key !== "PYTHONIOENCODING" && value !== undefined) {
        envWithoutIoEncoding[key] = value;
      }
    }
    const result = spawnSync("python", [WORKER_SCRIPT], {
      input: "",
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
      env: envWithoutIoEncoding,
    });
    expect(result.status).toBe(0);
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    // The start line carries a non-ASCII em dash: a locale-codec fallback
    // (e.g. cp1254) would garble it into U+FFFD when read back as UTF-8.
    expect(stderr).toContain("worker started — protocol v1, analyzer python-worker v0.1.0");
    expect(stderr).not.toContain("\ufffd");
  });

  it("protokol: EOF sonrası exit 0, stderr logları stdout'a sızmaz", () => {
    const run = runRaw("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr.length).toBeGreaterThan(0);
    expect(run.stderr).toContain("[python-worker]");
    expect(run.stderr).toContain("[python-worker] EOF — worker exiting normally");
  });

  it("language: worker runtime text (rationales, warnings, diagnostics, errors, stderr) is English", () => {
    const turkishLetters = /[çğıöşüÇĞİÖŞÜ]/;
    const run = runWorker([
      {
        id: "english-1",
        type: "analyze",
        protocolVersion: "1",
        files: [
          ...FIXTURE_FILES.map((relativePath) => ({
            path: relativePath,
            content: fixture(relativePath),
          })),
          { path: "broken.py", content: "def broken(:\n    pass\n" },
          {
            path: "carriers.py",
            content: 'routers = {}\n@routers["main"].get("/x")\ndef h():\n    return 1\n',
          },
        ],
      },
      { id: "english-2", type: "rewrite", files: [{ path: "a.py", content: "x = 1" }] },
      { id: "english-3", type: "analyze", files: [{ path: "../a.py", content: "x = 1" }] },
      {
        id: "english-4",
        type: "analyze",
        maxNodes: 1,
        files: [{ path: "a.py", content: "def f():\n    g()\n" }],
      },
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.lines.length).toBe(4);
    const texts: string[] = [];
    for (const line of run.lines) {
      const response = parseLine(line);
      texts.push(...(response.warnings ?? []), ...(response.unsupportedConstructs ?? []));
      for (const diagnostic of response.diagnostics ?? []) texts.push(diagnostic.message);
      for (const edge of response.edges ?? []) {
        for (const item of edge.evidence) texts.push(item.rationale);
        if (edge.ambiguity !== undefined) texts.push(edge.ambiguity.reason);
      }
      if (response.error !== undefined) texts.push(response.error.message);
    }
    texts.push(...run.stderr.split("\n"));
    expect(texts.length).toBeGreaterThan(10);
    expect(texts.filter((text) => turkishLetters.test(text))).toEqual([]);
  });
});
