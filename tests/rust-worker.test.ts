/**
 * Rust sidecar worker kabul testleri — M1-Rust (TŞ v2.1 §7, §23 örüntüsü).
 *
 * Sözleşme: native/rust-worker/PROTOCOL.md (protokol v1).
 * Pozitif + negatif + partial üçlüsü, kaynak sınırları (TŞ §9 resource
 * budget), AST derinlik savunması ve determinizm invariant'ı (TŞ §8
 * invariant vi) burada kanıtlanır. CALLS resolution üçlüsü — aynı modülde
 * doğrudan fn çağrısı → verified; metot çağrısı (trait dispatch
 * çözümsüz) → heuristic; hiçbir aday bulunamayan → unresolved +
 * UnknownExternal (uydurma hedef yok) — fixture kanıtıyla burada
 * sabitlenir.
 *
 * Ön koşul: cargo toolchain (Rust 1.100 windows-gnu). Worker binary'si
 * yoksa test kendi derler; cargo bulunamazsa suite skip edilir
 * (koşulamadı olarak raporlanır).
 *
 * Güvenlik notu (proje kırmızı çizgisi 6): süreç koşumları
 * tests/rust-worker-build.ts'teki runWorkerProtocol koşumcusundan geçer;
 * binary yolu repo-içi SABİT constant, argüman dizisi BOŞ ve shell
 * kullanılmaz; istek içeriği yalnızca stdin üzerinden taşınır; kullanıcı/
 * istemci girdisi asla komut satırına interpole edilmez.
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { isCargoAvailable } from "../adapters/rust/src/cargo.js";
import {
  bootstrapRustWorkerBinary,
  buildRustWorkerBinary,
  runWorkerProtocol,
  type WorkerProtocolRunResult,
  RUST_WORKER_BINARY_PATH,
  RUST_WORKER_MANIFEST_PATH,
} from "./rust-worker-build.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(REPO_ROOT, "examples", "fixture-rust-app");

const FIXTURE_FILES = [
  "main.rs",
  "repositories.rs",
  "services.rs",
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

/** Satır-bazlı istek(ler)i TEK koşumda gönderir; sonuçları toplar. */
async function runWorker(requests: unknown[]): Promise<WorkerProtocolRunResult> {
  return runWorkerProtocol({ requests });
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

function findNode(
  response: WorkerResponse | null,
  predicate: (node: WorkerNode) => boolean,
): WorkerNode | undefined {
  return (response?.nodes ?? []).find(predicate);
}

/* ------------------------------------------------------------------ */
/* Bootstrap: cargo var mı? Build HER TURDA koşturulur ve sonucu       */
/* KONTROL EDİLİR (roslyn-worker.test.ts disiplini).                   */
/* ------------------------------------------------------------------ */

const cargoAvailable = isCargoAvailable();
if (!cargoAvailable) {
  console.error(
    "[rust-worker] cargo toolchain bulunamadı — kabul testleri skip edilir (koşulamadı olarak raporlanır)",
  );
}
const bootstrapResult = bootstrapRustWorkerBinary({
  cargoAvailable,
  binaryExists: () => existsSync(RUST_WORKER_BINARY_PATH),
  runBuild: buildRustWorkerBinary,
});
const workerReady = bootstrapResult.workerReady;

/* ------------------------------------------------------------------ */
/* Test durumu                                                         */
/* ------------------------------------------------------------------ */

describe.skipIf(!workerReady)("rust-worker M1 (PROTOCOL.md v1)", () => {
  const files = FIXTURE_FILES.map((relativePath) => ({
    path: relativePath,
    content: fixture(relativePath),
  }));

  const analyzeRequest = {
    id: "fixture-rust-1",
    type: "analyze",
    protocolVersion: "1",
    files,
  };

  let analyzeExit = -1;
  let analyzeStderr = "";
  let analyzeLine = "";
  let analyzeResponse: WorkerResponse | null = null;
  let determinismLine = "";

  let negativeById: Record<string, WorkerResponse> = {};
  let malformed: WorkerProtocolRunResult = {
    lines: [],
    stderr: "",
    exitCode: -1,
  };

  let partialResponse: WorkerResponse | null = null;
  let bigFileResponse: WorkerResponse | null = null;
  let manyFilesResponse: WorkerResponse | null = null;
  let depthRun: WorkerProtocolRunResult = {
    lines: [],
    stderr: "",
    exitCode: -1,
  };
  let enumRun: WorkerResponse | null = null;
  let bareCrossFileRun: WorkerResponse | null = null;

  let cargoTomlVersion = "";

  beforeAll(
    async () => {
      // 1) Pozitif koşu + determinizm koşusu.
      const run1 = await runWorker([analyzeRequest]);
      analyzeExit = run1.exitCode;
      analyzeStderr = run1.stderr;
      analyzeLine = run1.lines[0] ?? "";
      analyzeResponse = parseLine(analyzeLine);
      determinismLine = (await runWorker([analyzeRequest])).lines[0] ?? "";

      // 2) Negatif batch (tek spawn'da 10 reddiye).
      const smallFile = { path: "Gen/File.rs", content: "fn g() { }" };
      const negativeRequests = [
        { id: "neg-empty-files", type: "analyze", files: [] },
        { id: "neg-missing-files", type: "analyze" },
        {
          id: "neg-dotdot",
          type: "analyze",
          files: [{ path: "../escape.rs", content: "fn x() { }" }],
        },
        {
          id: "neg-duplicate",
          type: "analyze",
          files: [
            { path: "a.rs", content: "fn a() { }" },
            { path: "a.rs", content: "fn a() { }" },
          ],
        },
        {
          id: "neg-unknown-field",
          type: "analyze",
          unknownField: 1,
          files: [smallFile],
        },
        // id BİLİNÇLİ YOK: eksik id reddi bu istekle kanıtlanır.
        { type: "analyze", files: [smallFile] },
        {
          id: "neg-file-unknown-field",
          type: "analyze",
          files: [{ path: "a.rs", content: "fn a() { }", extra: true }],
        },
        {
          id: "neg-absolute-path",
          type: "analyze",
          files: [{ path: "D:/outside/file.rs", content: "fn x() { }" }],
        },
        { id: "neg-unknown-type", type: "summarize", files: [smallFile] },
        {
          id: "neg-bad-version",
          type: "analyze",
          protocolVersion: "99",
          files: [smallFile],
        },
      ];
      negativeById = {};
      for (const line of (await runWorker(negativeRequests)).lines) {
        const response = parseLine(line);
        const key = typeof response.id === "string" ? response.id : "(id-yok)";
        negativeById[key] = response;
      }

      // 3) Bozuk JSON + ardından geçerli istek (worker yaşama kanıtı).
      malformed = await runWorker(["{bu json degil", analyzeRequest] as unknown[]);

      // 4) Partial: sözdizimi hatası.
      const partialRun = await runWorker([
        {
          id: "partial-syntax-error",
          type: "analyze",
          protocolVersion: "1",
          files: [
            {
              path: "Broken/Broken.rs",
              content: "pub fn broken( {\n    let x = 1;\n}\n",
            },
          ],
        },
      ]);
      partialResponse = partialRun.lines[0]
        ? parseLine(partialRun.lines[0])
        : null;

      // 5) Kaynak sınırları (TŞ §9 resource budget).
      //    3 MB içerik: satır limitinin altında, dosya içerik limitinin
      //    üstünde → per-file LIMIT_EXCEEDED beklenir.
      const bigContent = `fn big() { /* ${"x".repeat(3 * 1024 * 1024)} */ }`;
      const bigRun = await runWorker([
        {
          id: "limit-big-file",
          type: "analyze",
          protocolVersion: "1",
          files: [{ path: "Big/Big.rs", content: bigContent }],
        },
      ]);
      bigFileResponse = bigRun.lines[0] ? parseLine(bigRun.lines[0]) : null;

      const manyFiles = Array.from({ length: 5001 }, (_, index) => ({
        path: `Gen/File${index}.rs`,
        content: "fn g() { }",
      }));
      const manyRun = await runWorker([
        {
          id: "limit-many-files",
          type: "analyze",
          protocolVersion: "1",
          files: manyFiles,
        },
      ]);
      manyFilesResponse = manyRun.lines[0] ? parseLine(manyRun.lines[0]) : null;

      // 6) AST derinlik savunması: 5000 katmanlı parantez ifadesi. syn
      //    parse'ı ya başarıyla tamamlar ya da PARSE_ERROR tanısı üretir —
      //    her iki durumda da worker süreç olarak HAYATTA KALMALI ve tek
      //    geçerli yanıt satırı dönmelidir (çökme kabul edilmez).
      const depthCount = 5000;
      depthRun = await runWorker([
        {
          id: "depth-deep-expression",
          type: "analyze",
          protocolVersion: "1",
          files: [
            {
              path: "Deep/Deep.rs",
              content: `fn deep() { let x = ${"(".repeat(depthCount)}1${")".repeat(depthCount)}; }`,
            },
          ],
        },
      ]);

      // 7) enum → Class node kuralı (inline küçük kaynak).
      const enumRunRaw = await runWorker([
        {
          id: "enum-class",
          type: "analyze",
          protocolVersion: "1",
          files: [
            {
              path: "inline.rs",
              content:
                "pub enum Status {\n    Active,\n    Archived,\n}\n",
            },
          ],
        },
      ]);
      enumRun = enumRunRaw.lines[0] ? parseLine(enumRunRaw.lines[0]) : null;

      // 8) Bare çağrının başka dosyada eşleşmesi → heuristic (import
      //    kanıtı yok — isim tablosu eşleşmesi). İki dosyalı inline küme.
      const bareRun = await runWorker([
        {
          id: "bare-cross-file",
          type: "analyze",
          protocolVersion: "1",
          files: [
            { path: "lib_a.rs", content: "pub fn helper() -> u32 { 1 }\n" },
            {
              path: "lib_b.rs",
              content: "pub fn caller() -> u32 {\n    helper()\n}\n",
            },
          ],
        },
      ]);
      bareCrossFileRun = bareRun.lines[0] ? parseLine(bareRun.lines[0]) : null;

      // 9) Sürüm senkron dayanağı: Cargo.toml [package] version okunur.
      const cargoToml = readFileSync(RUST_WORKER_MANIFEST_PATH, "utf8");
      cargoTomlVersion =
        /^\s*version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1] ?? "";
    },
    300_000,
  );

  /* ---------------- Pozitif: protokol zarfı ---------------- */

  it("pozitif: worker exit 0 ve tek satır yanıt", () => {
    expect(analyzeExit).toBe(0);
    expect(analyzeLine).not.toBe("");
    expect(analyzeStderr).toContain("[rust-worker]");
  });

  it("pozitif: id echo + protocolVersion + status ready", () => {
    expect(analyzeResponse?.id).toBe("fixture-rust-1");
    expect(analyzeResponse?.protocolVersion).toBe("1");
    expect(analyzeResponse?.status).toBe("ready");
  });

  it("pozitif: tanı yok ve analyzerId rust-worker", () => {
    expect(analyzeResponse?.diagnostics).toEqual([]);
    expect(analyzeResponse?.worker?.analyzerId).toBe("rust-worker");
  });

  it("pozitif: capabilities TŞ §7 sözleşmesi (route L3 beyanı)", () => {
    expect(analyzeResponse?.capabilities?.astParse).toBe(true);
    expect(analyzeResponse?.capabilities?.symbolResolution).toBe(true);
    expect(analyzeResponse?.capabilities?.containsEdges).toBe(true);
    expect(analyzeResponse?.capabilities?.callEdges).toBe(true);
    expect(analyzeResponse?.capabilities?.importEdges).toBe(false);
    expect(analyzeResponse?.capabilities?.frameworkLinkers).toBe(false);
    expect(analyzeResponse?.capabilities?.routeDetection).toBe(
      "rust-attribute-macro-route-pattern",
    );
    expect(analyzeResponse?.unsupportedConstructs).toContain(
      "trait-method-dispatch",
    );
  });

  it("pozitif: tüm node/edge türleri ve resolution TŞ §8 kataloğunda", () => {
    const nodeKinds = new Set([
      "Workspace", "Repository", "Project", "Module", "Package", "File",
      "Namespace", "Class", "Interface", "Type", "Function", "Method",
      "Endpoint", "Handler", "Event", "Topic", "Queue", "Database", "Table",
      "Column", "ApiContract", "EventContract", "SchemaContract",
      "ContractVersion", "Test", "Config", "UnknownExternal",
    ]);
    const edgeKinds = new Set([
      "CONTAINS", "IMPORTS", "DECLARES", "CALLS", "REFERENCES", "IMPLEMENTS",
      "INHERITS", "INJECTS", "ROUTES_TO", "READS", "WRITES", "PUBLISHES",
      "SUBSCRIBES", "HANDLES", "PRODUCES_CONTRACT", "CONSUMES_CONTRACT",
      "VALIDATES", "TESTS", "DEPENDS_ON", "CONFIGURES",
    ]);
    for (const node of analyzeResponse?.nodes ?? []) {
      expect(nodeKinds.has(node.kind)).toBe(true);
    }
    for (const edge of analyzeResponse?.edges ?? []) {
      expect(edgeKinds.has(edge.kind)).toBe(true);
      expect(["verified", "heuristic", "unresolved"]).toContain(
        edge.resolution,
      );
      if (edge.resolution === "verified") {
        expect(edge.evidence.length).toBeGreaterThan(0);
      }
    }
  });

  it("pozitif: File node'ları sourceHash kanıtlı ve language rust", () => {
    for (const relativePath of FIXTURE_FILES) {
      const fileNode = findNode(
        analyzeResponse,
        (node) =>
          node.kind === "File" && node.qualifiedName === relativePath,
      );
      expect(fileNode).toBeDefined();
      expect(fileNode?.language).toBe("rust");
      expect(fileNode?.attributes.sourceHash).toBe(sha256Hex(fixture(relativePath)));
    }
  });

  it("pozitif: Class/Interface/Function/Method node kümeleri (struct→Class, trait→Interface)", () => {
    expect(
      findNode(analyzeResponse, (n) => n.kind === "Class" && n.qualifiedName === "crate::services::OrdersService"),
    ).toBeDefined();
    expect(
      findNode(analyzeResponse, (n) => n.kind === "Class" && n.qualifiedName === "crate::repositories::Order"),
    ).toBeDefined();
    expect(
      findNode(analyzeResponse, (n) => n.kind === "Class" && n.qualifiedName === "crate::repositories::OrderRepository"),
    ).toBeDefined();
    expect(
      findNode(analyzeResponse, (n) => n.kind === "Interface" && n.qualifiedName === "crate::repositories::OrderStore"),
    ).toBeDefined();
    expect(
      findNode(analyzeResponse, (n) => n.kind === "Function" && n.qualifiedName === "crate::list_orders"),
    ).toBeDefined();
    expect(
      findNode(analyzeResponse, (n) => n.kind === "Method" && n.qualifiedName === "crate::services::OrdersService::create"),
    ).toBeDefined();
    expect(
      findNode(analyzeResponse, (n) => n.kind === "Method" && n.qualifiedName === "crate::repositories::OrderStore::save"),
    ).toBeDefined();
    expect(
      findNode(analyzeResponse, (n) => n.kind === "Method" && n.qualifiedName === "crate::repositories::OrderRepository::save"),
    ).toBeDefined();
  });

  it("pozitif: CONTAINS File→tip ve tip→Method (L2)", () => {
    expect(
      findEdge(
        analyzeResponse,
        (edge) =>
          edge.kind === "CONTAINS" &&
          edge.from.kind === "File" &&
          edge.from.qualifiedName === "services.rs" &&
          edge.to.kind === "Class" &&
          edge.to.qualifiedName === "crate::services::OrdersService",
      ),
    ).toBeDefined();
    expect(
      findEdge(
        analyzeResponse,
        (edge) =>
          edge.kind === "CONTAINS" &&
          edge.from.kind === "Interface" &&
          edge.from.qualifiedName === "crate::repositories::OrderStore" &&
          edge.to.kind === "Method" &&
          edge.to.qualifiedName === "crate::repositories::OrderStore::save",
      ),
    ).toBeDefined();
    expect(
      findEdge(
        analyzeResponse,
        (edge) =>
          edge.kind === "CONTAINS" &&
          edge.from.kind === "Class" &&
          edge.from.qualifiedName === "crate::repositories::OrderRepository" &&
          edge.to.kind === "Method" &&
          edge.to.qualifiedName === "crate::repositories::OrderRepository::save",
      ),
    ).toBeDefined();
  });

  /* ---------------- Kabül kanıtı: CALLS resolution üçlüsü ---------------- */

  it("pozitif: CALLS aynı-modül doğrudan çağrı verified + satır/sourceHash kanıtı", () => {
    const expectedLine = fixtureLine("main.rs", 'create_audit_entry("list_orders")');
    const edge = findEdge(
      analyzeResponse,
      (edge) =>
        edge.kind === "CALLS" &&
        edge.from.qualifiedName === "crate::list_orders" &&
        edge.to.qualifiedName === "crate::create_audit_entry",
    );
    expect(edge).toBeDefined();
    expect(edge?.resolution).toBe("verified");
    const span = edge?.evidence[0]?.span;
    expect(span?.relativePath).toBe("main.rs");
    expect(span?.startLine).toBe(expectedLine);
    expect(span?.sourceHash).toBe(sha256Hex(fixture("main.rs")));
    expect(edge?.evidence[0]?.analyzerId).toBe("rust-worker");
  });

  it("pozitif: CALLS nitelikli yol çağrıları verified (OrdersService::new, OrderRepository::new)", () => {
    expect(
      findEdge(
        analyzeResponse,
        (edge) =>
          edge.kind === "CALLS" &&
          edge.from.qualifiedName === "crate::list_orders" &&
          edge.to.kind === "Method" &&
          edge.to.qualifiedName === "crate::services::OrdersService::new" &&
          edge.resolution === "verified",
      ),
    ).toBeDefined();
    expect(
      findEdge(
        analyzeResponse,
        (edge) =>
          edge.kind === "CALLS" &&
          edge.from.qualifiedName === "crate::services::OrdersService::new" &&
          edge.to.kind === "Method" &&
          edge.to.qualifiedName === "crate::repositories::OrderRepository::new" &&
          edge.resolution === "verified",
      ),
    ).toBeDefined();
  });

  it("pozitif: CALLS metot çağrısı → heuristic (trait dispatch bu dilimde çözülmez)", () => {
    const edge = findEdge(
      analyzeResponse,
      (edge) =>
        edge.kind === "CALLS" &&
        edge.from.qualifiedName === "crate::list_orders" &&
        edge.to.qualifiedName === "crate::services::OrdersService::list",
    );
    expect(edge).toBeDefined();
    expect(edge?.resolution).toBe("heuristic");
    expect(edge?.evidence[0]?.rationale.length).toBeGreaterThan(0);
  });

  it("pozitif: CALLS belirsiz metot çağrısı → heuristic + ambiguity (trait + impl adayı)", () => {
    const edge = findEdge(
      analyzeResponse,
      (edge) =>
        edge.kind === "CALLS" &&
        edge.from.qualifiedName === "crate::services::OrdersService::create" &&
        edge.to.qualifiedName === "crate::repositories::OrderRepository::save",
    );
    expect(edge).toBeDefined();
    expect(edge?.resolution).toBe("heuristic");
    expect(edge?.ambiguity?.candidates).toEqual([
      "crate::repositories::OrderRepository::save",
      "crate::repositories::OrderStore::save",
    ]);
    expect(edge?.ambiguity?.reason.length).toBeGreaterThan(0);
  });

  it("pozitif: CALLS çözülemeyen çağrı → unresolved + UnknownExternal (uydurma hedef yok)", () => {
    const edge = findEdge(
      analyzeResponse,
      (edge) =>
        edge.kind === "CALLS" &&
        edge.from.qualifiedName === "crate::create_audit_entry" &&
        edge.to.kind === "UnknownExternal" &&
        edge.to.qualifiedName === "std::env::var",
    );
    expect(edge).toBeDefined();
    expect(edge?.resolution).toBe("unresolved");
    expect(edge?.to.relativePath).toBeUndefined();
  });

  it("pozitif: bare çağrı başka dosyada tek adayla eşleşirse heuristic", () => {
    const edge = findEdge(
      bareCrossFileRun,
      (edge) =>
        edge.kind === "CALLS" &&
        edge.from.qualifiedName === "crate::lib_b::caller" &&
        edge.to.qualifiedName === "crate::lib_a::helper",
    );
    expect(edge).toBeDefined();
    expect(edge?.resolution).toBe("heuristic");
  });

  it("pozitif: enum → Class node (bildirim kuralı)", () => {
    const node = findNode(
      enumRun,
      (n) => n.kind === "Class" && n.qualifiedName === "crate::inline::Status",
    );
    expect(node).toBeDefined();
  });

  /* ---------------- L3: ROUTES_TO ---------------- */

  it("pozitif: ROUTES_TO GET /orders→list_orders verified + endpoint öznitelikleri", () => {
    const expectedLine = fixtureLine("main.rs", '#[get("/orders")]');
    const edge = findEdge(
      analyzeResponse,
      (edge) =>
        edge.kind === "ROUTES_TO" &&
        edge.from.kind === "Endpoint" &&
        edge.from.qualifiedName === "GET /orders" &&
        edge.to.kind === "Function" &&
        edge.to.qualifiedName === "crate::list_orders",
    );
    expect(edge?.resolution).toBe("verified");
    expect(edge?.evidence[0]?.kind).toBe("route-attribute");
    expect(edge?.evidence[0]?.span?.relativePath).toBe("main.rs");
    expect(edge?.evidence[0]?.span?.startLine).toBe(expectedLine);
    const endpoint = findNode(
      analyzeResponse,
      (node) =>
        node.kind === "Endpoint" && node.qualifiedName === "GET /orders",
    );
    expect(endpoint?.attributes.method).toBe("GET");
    expect(endpoint?.attributes.path).toBe("/orders");
  });

  it("pozitif: ROUTES_TO POST /orders→create_order verified", () => {
    expect(
      findEdge(
        analyzeResponse,
        (edge) =>
          edge.kind === "ROUTES_TO" &&
          edge.from.qualifiedName === "POST /orders" &&
          edge.to.qualifiedName === "crate::create_order",
      ),
    ).toBeDefined();
  });

  it("pozitif: coverageRatio 0-1 arası ve verified oranını yansıtır", () => {
    const edges = analyzeResponse?.edges ?? [];
    const verified = edges.filter((edge) => edge.resolution === "verified").length;
    expect(edges.length).toBeGreaterThan(0);
    const expected = Math.round((verified / edges.length) * 10_000) / 10_000;
    expect(analyzeResponse?.coverageRatio).toBe(expected);
  });

  it("pozitif: evidence kayıtları rationale + analyzerVersion taşır", () => {
    for (const evidence of analyzeResponse?.evidence ?? []) {
      expect(evidence.rationale.length).toBeGreaterThan(0);
      expect(evidence.analyzerVersion).toBe(
        analyzeResponse?.worker?.analyzerVersion,
      );
    }
  });

  /* ---------------- Sürüm senkronu ---------------- */

  it("sürüm: analyzerVersion Cargo.toml <package>.version ile senkron", () => {
    expect(cargoTomlVersion).not.toBe("");
    expect(analyzeResponse?.worker?.analyzerVersion).toBe(cargoTomlVersion);
  });

  /* ---------------- Negatif: istek düzeyi reddiyeler ---------------- */

  it("negatif: files [] ve eksik files → INVALID_ARGUMENT", () => {
    expect(negativeById["neg-empty-files"]?.status).toBe("error");
    expect(negativeById["neg-empty-files"]?.error?.code).toBe("INVALID_ARGUMENT");
    expect(negativeById["neg-missing-files"]?.status).toBe("error");
    expect(negativeById["neg-missing-files"]?.error?.code).toBe("INVALID_ARGUMENT");
  });

  it("negatif: '..' segmenti ve mutlak yol → INVALID_ARGUMENT", () => {
    expect(negativeById["neg-dotdot"]?.error?.code).toBe("INVALID_ARGUMENT");
    expect(negativeById["neg-absolute-path"]?.error?.code).toBe("INVALID_ARGUMENT");
  });

  it("negatif: duplicate path → INVALID_ARGUMENT", () => {
    expect(negativeById["neg-duplicate"]?.error?.code).toBe("INVALID_ARGUMENT");
  });

  it("negatif: bilinmeyen üst-düzey alan strict reddi → INVALID_ARGUMENT", () => {
    expect(negativeById["neg-unknown-field"]?.error?.code).toBe("INVALID_ARGUMENT");
  });

  it("negatif: files[] girdisinde bilinmeyen alan strict reddi → INVALID_ARGUMENT", () => {
    expect(negativeById["neg-file-unknown-field"]?.error?.code).toBe("INVALID_ARGUMENT");
  });

  it("negatif: id eksik → INVALID_ARGUMENT", () => {
    expect(negativeById["(id-yok)"]?.status).toBe("error");
    expect(negativeById["(id-yok)"]?.error?.code).toBe("INVALID_ARGUMENT");
  });

  it("negatif: bilinmeyen type ve protocolVersion → INVALID_ARGUMENT", () => {
    expect(negativeById["neg-unknown-type"]?.error?.code).toBe("INVALID_ARGUMENT");
    expect(negativeById["neg-bad-version"]?.error?.code).toBe("INVALID_ARGUMENT");
  });

  it("negatif: bozuk JSON → id null hata yanıtı; worker yaşamaya devam eder", () => {
    expect(malformed.lines.length).toBe(2);
    const malformedResponse = parseLine(malformed.lines[0] ?? "");
    expect(malformedResponse.status).toBe("error");
    expect(malformedResponse.id).toBeNull();
    const survivor = parseLine(malformed.lines[1] ?? "");
    expect(survivor.id).toBe("fixture-rust-1");
    expect(survivor.status).toBe("ready");
  });

  /* ---------------- Kaynak sınırları ---------------- */

  it("limit: 3 MB dosya içeriği → LIMIT_EXCEEDED", () => {
    expect(bigFileResponse?.status).toBe("error");
    expect(bigFileResponse?.error?.code).toBe("LIMIT_EXCEEDED");
    expect(bigFileResponse?.id).toBe("limit-big-file");
  });

  it("limit: 5001 dosya → LIMIT_EXCEEDED", () => {
    expect(manyFilesResponse?.status).toBe("error");
    expect(manyFilesResponse?.error?.code).toBe("LIMIT_EXCEEDED");
    expect(manyFilesResponse?.id).toBe("limit-many-files");
  });

  /* ---------------- AST derinlik savunması ---------------- */

  it("derinlik: 5000 katmanlı ifade worker'ı çökertmez, tek geçerli yanıt döner", () => {
    expect(depthRun.exitCode).toBe(0);
    expect(depthRun.lines.length).toBe(1);
    const response = parseLine(depthRun.lines[0] ?? "");
    expect(["ready", "partial"]).toContain(response.status);
    // syn parse derinliği aşarsa PARSE_ERROR tanısı üretilir (sessiz kesim
    // yok); parse başarılı olursa status ready olur — ikisi de meşru.
    if (response.status === "partial") {
      expect(
        (response.diagnostics ?? []).some((diag) => diag.code === "PARSE_ERROR"),
      ).toBe(true);
    }
  });

  /* ---------------- Partial ---------------- */

  it("partial: sözdizimi hatası → status partial + dosya/satırlı tanı", () => {
    expect(partialResponse?.status).toBe("partial");
    expect(
      (partialResponse?.diagnostics ?? []).some(
        (diag) => diag.relativePath === "Broken/Broken.rs" && diag.line >= 1,
      ),
    ).toBe(true);
  });

  /* ---------------- Determinizm ---------------- */

  it("determinizm: aynı girdi → birebir aynı yanıt satırı", () => {
    expect(determinismLine).toBe(analyzeLine);
  });
});

/* ------------------------------------------------------------------ */
/* Bootstrap davranışı (derleme regresyonu disiplini — gerçek IO'suz)  */
/* ------------------------------------------------------------------ */

describe("bootstrapRustWorkerBinary (derleme regresyonu disiplini)", () => {
  it("build başarısızlığında explicit Error throw eder — sessiz skip yok", () => {
    expect(() =>
      bootstrapRustWorkerBinary({
        cargoAvailable: true,
        binaryExists: () => true,
        runBuild: () => ({ status: 1, stderr: "error[E0432]: test hatası" }),
      }),
    ).toThrowError(/worker derlemesi başarısız/);
  });

  it("derleme 'başarılı' ama binary yoksa throw eder", () => {
    expect(() =>
      bootstrapRustWorkerBinary({
        cargoAvailable: true,
        binaryExists: () => false,
        runBuild: () => ({ status: 0 }),
      }),
    ).toThrowError(/binary çıktısı yok/);
  });

  it("cargo yokken meşru skip: workerReady=false, skipReason dolu, build ÇAĞRILMAZ", () => {
    let buildCalls = 0;
    const result = bootstrapRustWorkerBinary({
      cargoAvailable: false,
      binaryExists: () => true,
      runBuild: () => {
        buildCalls += 1;
        return { status: 0 };
      },
    });
    expect(result.workerReady).toBe(false);
    expect(result.skipReason).toContain("cargo");
    expect(buildCalls).toBe(0);
  });

  it("başarılı derleme + binary → workerReady=true, skipReason yok", () => {
    const result = bootstrapRustWorkerBinary({
      cargoAvailable: true,
      binaryExists: () => true,
      runBuild: () => ({ status: 0 }),
    });
    expect(result.workerReady).toBe(true);
    expect(result.skipReason).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Node bütçesi (RESPONSE_TRUNCATED) + sembol-yoğun girdi savunmaları  */
/* (go/python node bütçesi deseninin rust karşılığı — güvenlik bulgusu)*/
/* ------------------------------------------------------------------ */

describe.skipIf(!workerReady)("rust-worker node bütçesi (PROTOCOL.md maxNodes)", () => {
  let invalidById: Record<string, WorkerResponse> = {};
  let truncatedResponse: WorkerResponse | null = null;
  let truncatedLine = "";
  let truncatedDeterminismLine = "";
  /** 8000-kenarlı yoğun koşumun son ölçümü (fonksiyonel doğrulama için). */
  let denseResponse: WorkerResponse | null = null;
  /** min-of-3 ölçekleme oranı: t(8000) / t(1000) — duvar-saati gürültüsüne karşı. */
  let denseScaleRatio = -1;

  /** 13 node üreten küçük küme: File + 11 Function + 1 UnknownExternal. */
  const budgetFile = {
    path: "Budget/Budget.rs",
    content:
      Array.from({ length: 10 }, (_, i) => `fn target_0${i}() { }`).join("\n") +
      "\nfn caller() {\n    missing_helper();\n}\n",
  };

  beforeAll(
    async () => {
      // 1) Geçersiz maxNodes reddiyeleri + üst sınır kabulü (tek koşum).
      const invalidRequests = [
        { id: "budget-zero", type: "analyze", maxNodes: 0, files: [budgetFile] },
        { id: "budget-over", type: "analyze", maxNodes: 250001, files: [budgetFile] },
        { id: "budget-float", type: "analyze", maxNodes: 1.5, files: [budgetFile] },
        { id: "budget-bool", type: "analyze", maxNodes: true, files: [budgetFile] },
        {
          id: "budget-boundary-ok",
          type: "analyze",
          maxNodes: 250000,
          files: [budgetFile],
        },
      ];
      invalidById = {};
      for (const line of (await runWorker(invalidRequests)).lines) {
        const response = parseLine(line);
        const key = typeof response.id === "string" ? response.id : "(id-yok)";
        invalidById[key] = response;
      }

      // 2) Kırpma: 13 node'lu kümeye maxNodes 5 → RESPONSE_TRUNCATED.
      const truncatedRequest = {
        id: "budget-truncated",
        type: "analyze",
        maxNodes: 5,
        files: [budgetFile],
      };
      truncatedLine = (await runWorker([truncatedRequest])).lines[0] ?? "";
      truncatedResponse = truncatedLine ? parseLine(truncatedLine) : null;
      truncatedDeterminismLine =
        (await runWorker([truncatedRequest])).lines[0] ?? "";

      // 3) Sembol-yoğun girdi: 8000 AYRI aynı-modül çağrısı → 8000 ayrı
      //    kenar. push_edge doğrusal taramayla O(E²) yakar; indeksle O(E
      //    log E) olmalı. Eşik MUTLAK DEĞİL: paralel CI yükünde duvar-saati
      //    ölçümü 4x'e kadar şişer (gözlem: düzeltilmiş kodda bile yük
      //    altında 10,2 sn / boşta 2,5 sn) ve küçük bir kontrol koşumu
      //    yükü temsil etmez (gözlem: yük altında kontrol 53 ms, yoğun
      //    10.387 ms). Ölçekleme oranı kullanılır: AYNI şekle sahip iki
      //    yoğunluk (8000 / 1000) ardışık koşturulur; O(E²) ~16x oran
      //    üretir, O(E log E) ~4-7x'te kalır. min-of-3, en az gürültülü
      //    tekrarı seçer. Kırmızı kanıt: düzeltme öncesi aynı makinede
      //    8000-kenarlı koşum 16,159 ms ölçülmüştü (1000'lik koşum
      //    ~0,4 sn — oran ~40x).
      const pad = (index: number): string => String(index).padStart(4, "0");
      const symbol = (index: number): string =>
        `dense_target_${pad(index)}_aabbccddeeff`;
      const denseFile = (count: number): { path: string; content: string } => ({
        path: "Dense/Dense.rs",
        content:
          Array.from({ length: count }, (_, i) => `fn ${symbol(i)}() { }`).join(
            "\n",
          ) +
          `\nfn dense_caller() {\n${Array.from(
            { length: count },
            (_, i) => `    ${symbol(i)}();`,
          ).join("\n")}\n}\n`,
      });
      const denseRequest = (count: number) => ({
        id: `dense-calls-${count}`,
        type: "analyze",
        protocolVersion: "1",
        files: [denseFile(count)],
      });
      const scaleRatios: number[] = [];
      for (let rep = 0; rep < 3; rep += 1) {
        const bigStart = Date.now();
        const bigRun = await runWorker([denseRequest(8000)]);
        const bigElapsed = Date.now() - bigStart;
        const smallStart = Date.now();
        await runWorker([denseRequest(1000)]);
        const smallElapsed = Date.now() - smallStart;
        scaleRatios.push(bigElapsed / Math.max(smallElapsed, 1));
        if (rep === 0) {
          denseResponse = bigRun.lines[0] ? parseLine(bigRun.lines[0]) : null;
        }
      }
      denseScaleRatio = Math.min(...scaleRatios);
    },
    300_000,
  );

  it("negatif: maxNodes 0 ve 250001 → INVALID_ARGUMENT aralık mesajı", () => {
    expect(invalidById["budget-zero"]?.status).toBe("error");
    expect(invalidById["budget-zero"]?.error?.code).toBe("INVALID_ARGUMENT");
    expect(invalidById["budget-zero"]?.error?.message).toContain("1..250000");
    expect(invalidById["budget-over"]?.status).toBe("error");
    expect(invalidById["budget-over"]?.error?.code).toBe("INVALID_ARGUMENT");
    expect(invalidById["budget-over"]?.error?.message).toContain("250000");
  });

  it("negatif: maxNodes tam sayı değilse (float/bool) → INVALID_ARGUMENT", () => {
    for (const id of ["budget-float", "budget-bool"]) {
      expect(invalidById[id]?.error?.code).toBe("INVALID_ARGUMENT");
      expect(invalidById[id]?.error?.message).toContain("tam sayı");
    }
  });

  it("sınır: maxNodes 250000 (üst sınır) kabul edilir, kırpılmayan küme ready döner", () => {
    expect(invalidById["budget-boundary-ok"]?.status).toBe("ready");
    expect(invalidById["budget-boundary-ok"]?.diagnostics ?? []).toEqual([]);
  });

  it("partial: maxNodes 5 → RESPONSE_TRUNCATED + dangling kenar yok + evidence filtreli", () => {
    const response = truncatedResponse;
    expect(response?.status).toBe("partial");
    expect(response?.nodes?.length).toBe(5);
    const truncatedDiagnostic = (response?.diagnostics ?? []).find(
      (diag) => diag.code === "RESPONSE_TRUNCATED",
    );
    expect(truncatedDiagnostic).toBeDefined();
    expect(truncatedDiagnostic?.message).toContain("dangling yok");
    // Dangling yok: her kenar ucunun node'u yayımlanmış kümede olmalı.
    const published = new Set(
      (response?.nodes ?? []).map(
        (node) => `${node.kind}|${node.qualifiedName}|${node.relativePath ?? ""}`,
      ),
    );
    for (const edge of response?.edges ?? []) {
      for (const endpoint of [edge.from, edge.to]) {
        expect(
          published.has(
            `${endpoint.kind}|${endpoint.qualifiedName}|${endpoint.relativePath ?? ""}`,
          ),
        ).toBe(true);
      }
    }
    // Evidence, yalnızca yayımlanan kenarların taşıdığı kanıtlardan oluşur.
    const edgeEvidence = new Set(
      (response?.edges ?? []).flatMap((edge) =>
        edge.evidence.map((ev) => JSON.stringify(ev)),
      ),
    );
    const responseEvidence = (response?.evidence ?? []).map((ev) =>
      JSON.stringify(ev),
    );
    expect(responseEvidence.length).toBeGreaterThan(0);
    for (const ev of responseEvidence) {
      expect(edgeEvidence.has(ev)).toBe(true);
    }
  });

  it("determinizm: kırpılmış yanıt da birebir tekrarlanabilir", () => {
    expect(truncatedDeterminismLine).toBe(truncatedLine);
  });

  it("yoğun girdi: 8000 ayrı çağrı tek koşumda tamamlanır (push_edge O(E²) savunması)", () => {
    expect(denseResponse?.status).toBe("ready");
    const callEdges = (denseResponse?.edges ?? []).filter(
      (edge) => edge.kind === "CALLS" && edge.resolution === "verified",
    );
    expect(callEdges.length).toBe(8000);
    // Ölçekleme eşiği (duvar-saati gürültüsüne karşı min-of-3): doğrusal
    // tarama (O(E²)) 8000/1000 oranında ~16x+ ölçekler; indeksli erişim
    // sabit maliyetler yüzünden ~4-7x'te kalır. Kırmızı kanıt: düzeltme
    // öncesi aynı makinede 8000'lik koşum 16,159 ms, 1000'lik ~400 ms
    // (oran ~40x) ölçülmüştü — bu eşik oranı o koşumda kırmızıya düşer.
    expect(denseScaleRatio).toBeGreaterThan(0);
    expect(denseScaleRatio).toBeLessThan(12);
  }, 120_000);
});
