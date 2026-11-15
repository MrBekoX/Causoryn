/**
 * Go sidecar worker + adapter kabul testleri — M1-Go dilimi.
 *
 * Sözleşme: native/go-worker/PROTOCOL.md (protokol v1; Roslyn worker
 * PROTOCOL.md v1 deseni). Pozitif + negatif + partial üçlüsü, kaynak
 * sınırları (TŞ §9 resource budget; K-010), AST derinlik savunması ve
 * determinizm invariant'ı (TŞ §8 invariant vi) burada kanıtlanır.
 *
 * Ön koşul: Go toolchain. Worker derlemesi bootstrap'ta HER TURDA
 * koşturulup KONTROL EDİLİR; go bulunamazsa suite skip edilir
 * (koşulamadı olarak raporlanır — PROTOCOL.md §7 disiplini). Derleme
 * regresyonu sessiz skip ile geçiştirilmez: build başarısızlığı açık
 * Error → suite FAIL.
 *
 * Güvenlik notu (proje kırmızı çizgi 6 + statik güvenlik): süreç koşumları
 * node:child_process spawnSync/spawn ile INLINE LITERAL çalıştırılabilir +
 * SABİT argüman dizisi ve shell: false ile yapılır (statik güvenlik kuralı: spawn
 * komutu const identifier dahi olsa DEĞİL, yalnızca inline string
 * literal olur). Go binary yolu kod-içi sabit literal'dır; bu dosyada
 * ortam değişkeni OKUNMAZ ve hiçbir dış değer çalıştırılabilir konumuna
 * geçmez. Sahte worker süreçleri `node -e <string>` yerine gitignore'daki
 * bin/ altında SABİT yollu .cjs betik dosyalarıyla başlatılır. Kaynak
 * içerikleri asla komut satırına taşınmaz — yalnızca stdin JSON'da.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createSnapshot } from "@causoryn/domain";
import {
  analyzeGoWorkspace,
  runGoWorkerAnalyze,
  type GoAdapterResult,
} from "../src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKER_DIR = join(REPO_ROOT, "native", "go-worker");
const WORKER_BIN_DIR = join(WORKER_DIR, "bin");
const FIXTURE_DIR = join(REPO_ROOT, "examples", "fixture-go-app");

const FIXTURE_FILES = [
  "main.go",
  "services/orders_service.go",
  "repositories/orders_repository.go",
] as const;

/* ------------------------------------------------------------------ */
/* Güvenlik: tüm süreç koşumları inline literal komut kanallarından geçer*/
/* ------------------------------------------------------------------ */

/** Sabit Go toolchain yolu (bu makinenin kanıtlanmış yolu; DATA amaçlı). */
const GO_TOOLCHAIN_EXE = "go";

/** Adapter option DATA'sı: çözümlenmiş go yolu (spawn'da doğrudan kullanılmaz). */
const GO_BINARY = existsSync(GO_TOOLCHAIN_EXE) ? GO_TOOLCHAIN_EXE : "go";

/**
 * Tüm test spawn'ları BU yardımcıdan geçer: her spawnSync çağrısında
 * komut INLINE STRING LITERAL'dır; args dizi elemanları çağrı noktasında
 * sabittir; shell yoktur.
 */
function spawnGo(
  args: readonly string[],
  opts: { cwd?: string; input?: string; timeout?: number },
): ReturnType<typeof spawnSync> {
  if (existsSync(GO_TOOLCHAIN_EXE)) {
    return spawnSync("go", args, { ...opts, encoding: "utf8", shell: false });
  }
  return spawnSync("go", args, { ...opts, encoding: "utf8", shell: false });
}

/* ------------------------------------------------------------------ */
/* Sahte worker betikleri (gitignore'daki bin/ altında SABİT yollar)    */
/* ------------------------------------------------------------------ */

const FAKE_HALFLINE_PATH = join(WORKER_BIN_DIR, "fake-halfline.cjs");
const FAKE_CRASH_PATH = join(WORKER_BIN_DIR, "fake-crash.cjs");
const FAKE_ERROR_PATH = join(WORKER_BIN_DIR, "fake-error.cjs");

function writeFakeScripts(): void {
  mkdirSync(WORKER_BIN_DIR, { recursive: true });
  // Yarı satır yazıp newline OLMADAN bekleyen süreç (framing sınırı).
  writeFileSync(
    FAKE_HALFLINE_PATH,
    "process.stdout.write('{\"id\":\"x\"}'); setTimeout(() => {}, 60000);\n",
    "utf8",
  );
  // Anında stderr yazıp çıkan süreç (worker crash fallback).
  writeFileSync(
    FAKE_CRASH_PATH,
    "process.stderr.write('sahte go worker cakildi'); process.exit(1);\n",
    "utf8",
  );
  // Geçerli PROTOCOL.md v1 hata yanıtı yazıp çıkan süreç.
  writeFileSync(
    FAKE_ERROR_PATH,
    "process.stdout.write(JSON.stringify({ id: 'analyze:adapter-go-worker-error', protocolVersion: '1', status: 'error', error: { code: 'LIMIT_EXCEEDED', message: 'dosya sayısı sınırı aşıldı: 5001 > 5000' } }) + '\\n'); process.exit(0);\n",
    "utf8",
  );
}

writeFakeScripts();

/* ------------------------------------------------------------------ */
/* Bootstrap: go var mı? Build HER TURDA koşturulur ve sonucu          */
/* KONTROL EDİLİR (roslyn-worker.test.ts kabul düzeniyle aynı disiplin).*/
/* ------------------------------------------------------------------ */

const goCheck = spawnGo(["version"], {});
const goAvailable = goCheck.status === 0;
if (!goAvailable) {
  console.error(
    "[go-adapter] Go toolchain bulunamadı — M1 kabul testleri skip edilir (koşulamadı olarak raporlanır; PROTOCOL.md §7)",
  );
} else {
  // go run her istekte derleme yapar; GOCACHE bu koşumda ısıtılır.
  // Go build cache prosesler-arası güvenlidir (kilitli) — ek kilit
  // dosyası gerekmez (roslyn MSBuild yarışının Go karşılığı yoktur).
  const warm = spawnGo(["build", "./..."], {
    cwd: WORKER_DIR,
    timeout: 600_000,
  });
  if (warm.status !== 0) {
    throw new Error(
      `go worker derlemesi başarısız (exit=${String(warm.status)}) — M1 testleri eski binary'ye karşı koşulmaz` +
        (typeof warm.stderr === "string" && warm.stderr.length > 0
          ? ` [stderr]: ${warm.stderr.slice(0, 400)}`
          : "") +
        (typeof warm.stdout === "string" && warm.stdout.length > 0
          ? ` [stdout]: ${warm.stdout.slice(-400)}`
          : ""),
    );
  }
  mkdirSync(WORKER_BIN_DIR, { recursive: true });
}

/** Binary-mode adapter testi için SABİT repo-içi binary yolu (bin/ ignore). */
const WORKER_TEST_BINARY = join(WORKER_BIN_DIR, "go-worker-test.exe");

if (goAvailable) {
  const buildBinary = spawnGo(["build", "-o", WORKER_TEST_BINARY, "./cmd/worker"], {
    cwd: WORKER_DIR,
    timeout: 600_000,
  });
  if (buildBinary.status !== 0 || !existsSync(WORKER_TEST_BINARY)) {
    throw new Error(
      `go worker test binary derlemesi başarısız (exit=${String(buildBinary.status)})` +
        (typeof buildBinary.stderr === "string" && buildBinary.stderr.length > 0
          ? ` [stderr]: ${buildBinary.stderr.slice(0, 400)}`
          : ""),
    );
  }
}

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
  capabilities?: {
    astParse: boolean;
    symbolResolution: boolean;
    containsEdges: boolean;
    callEdges: boolean;
    importEdges: boolean;
    routeDetection: string;
    frameworkLinkers: boolean;
  };
  diagnostics?: Array<{
    relativePath: string;
    code: string;
    message: string;
    line: number;
  }>;
  nodes?: WorkerNode[];
  edges?: WorkerEdge[];
  evidence?: Evidence[];
  warnings?: string[];
  unsupportedConstructs?: string[];
  coverageRatio?: number;
  error?: { code: string; message: string };
}

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */

/** Satır-bazlı istek(ler)i gerçek worker'a (go run) gönderir. */
function runWorker(requests: unknown[]): {
  lines: string[];
  stderr: string;
  exitCode: number;
} {
  const input =
    requests.map((request) => JSON.stringify(request)).join("\n") + "\n";
  const result = spawnGo(["run", "./cmd/worker"], {
    cwd: WORKER_DIR,
    input,
    timeout: 300_000,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const lines = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  return { lines, stderr, exitCode: result.status ?? -1 };
}

function parseResponse(line: string): WorkerResponse {
  return JSON.parse(line) as WorkerResponse;
}

function fixtureFiles(): Array<{ path: string; content: string }> {
  return FIXTURE_FILES.map((relativePath) => ({
    path: relativePath,
    content: readFileSync(join(FIXTURE_DIR, relativePath), "utf8"),
  }));
}

function findEdge(
  edges: WorkerEdge[] | undefined,
  kind: string,
  fromQualifiedName: string,
  toQualifiedName: string,
): WorkerEdge | undefined {
  return (edges ?? []).find(
    (edge) =>
      edge.kind === kind &&
      edge.from.qualifiedName === fromQualifiedName &&
      edge.to.qualifiedName === toQualifiedName,
  );
}

/** Evidence span hash'i fixture dosya içeriğinin SHA-256'sıyla eşleşmeli. */
function contentHash(relativePath: string): string {
  return createHash("sha256")
    .update(readFileSync(join(FIXTURE_DIR, relativePath), "utf8"), "utf8")
    .digest("hex");
}

/** Sentetik Go kaynakları — heuristic tablo birim senaryoları (parse-only). */
const SYNTHETIC = {
  interface_: [
    {
      path: "iface.go",
      content: [
        "package main",
        "",
        "type Notifier interface {",
        "\tNotify(msg string)",
        "}",
        "",
        "func sendNotification(n Notifier) {",
        '\tn.Notify("order-created")',
        "}",
        "",
      ].join("\n"),
    },
  ],
  ambiguous: [
    {
      path: "ambiguous.go",
      content: [
        "package main",
        "",
        "type A struct{}",
        "",
        "type B struct{}",
        "",
        "func (a *A) DoIt() {}",
        "",
        "func (b *B) DoIt() {}",
        "",
        "func run(x *A) {",
        "\tx.DoIt()",
        "}",
        "",
      ].join("\n"),
    },
  ],
  builtin: [
    {
      path: "builtin.go",
      content: [
        "package main",
        "",
        "func measure(xs []string) int {",
        "\ttotal := len(xs)",
        "\treturn total",
        "}",
        "",
      ].join("\n"),
    },
  ],
  routes: [
    {
      path: "routes.go",
      content: [
        "package main",
        "",
        'import "net/http"',
        "",
        "func pingHandler(w http.ResponseWriter, _ *http.Request) {}",
        "func createUser(w http.ResponseWriter, _ *http.Request) {}",
        "func listUsers(w http.ResponseWriter, _ *http.Request) {}",
        "",
        "func registerRoutes(mux *http.ServeMux, r routeGroup, e engineX, c chorus) {",
        '\tmux.HandleFunc("/ping", pingHandler)',
        '\tr.GET("/ping", pingHandler)',
        '\te.POST("/users", createUser)',
        '\tc.Get("/users", listUsers)',
        '\thttp.HandleFunc("/health", pingHandler)',
        "}",
        "",
      ].join("\n"),
    },
  ],
  selectorHandler: [
    {
      path: "admin.go",
      content: [
        "package main",
        "",
        'import "net/http"',
        "",
        "type AdminServer struct{}",
        "",
        "func (s *AdminServer) Status(w http.ResponseWriter, _ *http.Request) {}",
        "",
        "func registerAdmin(s *AdminServer) {",
        '\thttp.HandleFunc("/admin/status", s.Status)',
        "}",
        "",
      ].join("\n"),
    },
  ],
  inlineHandler: [
    {
      path: "inline.go",
      content: [
        "package main",
        "",
        'import "net/http"',
        "",
        "func registerInline() {",
        '\thttp.HandleFunc("/inline", func(w http.ResponseWriter, _ *http.Request) {',
        "\t\tw.WriteHeader(http.StatusOK)",
        "\t})",
        "}",
        "",
      ].join("\n"),
    },
  ],
  syntaxError: [
    {
      path: "broken.go",
      content: "package main\n\nfunc broken( {\n",
    },
    {
      path: "valid.go",
      content: "package main\n\nfunc intact() {}\n",
    },
  ],
  deep: [
    {
      path: "deep.go",
      content:
        "package main\n\nfunc deep() int {\n\treturn " +
        "(".repeat(1100) +
        "1" +
        ")".repeat(1100) +
        "\n}\n",
    },
  ],
} as const;

/* ------------------------------------------------------------------ */
/* 1) Worker protokolü — gerçek go koşumu (pozitif + negatif + partial) */
/* ------------------------------------------------------------------ */

const workerSuite = describe.skipIf(!goAvailable)(
  "native/go-worker protokolü (M1-Go)",
  () => {
    let fixture: WorkerResponse | null = null;

    beforeAll(
      () => {
        const request = {
          id: "m1-fixture",
          type: "analyze",
          protocolVersion: "1",
          files: fixtureFiles(),
        };
        const run = runWorker([request]);
        expect(run.exitCode).toBe(0);
        expect(run.lines).toHaveLength(1);
        fixture = parseResponse(run.lines[0] ?? "");
      },
      600_000,
    );

    it("pozitif: tek satır yanıt, status ready, protokol başlıkları", () => {
      expect(fixture?.status).toBe("ready");
      expect(fixture?.protocolVersion).toBe("1");
      expect(fixture?.id).toBe("m1-fixture");
      expect(fixture?.worker?.analyzerId).toBe("go-worker");
      expect(fixture?.worker?.analyzerVersion).toBe("0.1.0");
      expect(fixture?.capabilities?.astParse).toBe(true);
      // Dürüstlük: go/types semantik çözümleme bu dilimde YOK.
      expect(fixture?.capabilities?.symbolResolution).toBe(false);
      expect(fixture?.capabilities?.containsEdges).toBe(true);
      expect(fixture?.capabilities?.callEdges).toBe(true);
      expect(fixture?.capabilities?.importEdges).toBe(false);
      expect(fixture?.capabilities?.frameworkLinkers).toBe(false);
      expect(fixture?.capabilities?.routeDetection).toBe(
        "go-http-handlefunc-and-gin-echo-chi-registration-pattern",
      );
    });

    it("pozitif: node kataloğu — 27 node, tür dağılımı TŞ §8 içinde", () => {
      const nodes = fixture?.nodes ?? [];
      expect(nodes).toHaveLength(27);
      const allowedKinds = new Set([
        "File",
        "Class",
        "Interface",
        "Type",
        "Function",
        "Method",
        "Endpoint",
        "UnknownExternal",
      ]);
      for (const node of nodes) {
        expect(allowedKinds.has(node.kind)).toBe(true);
        expect(node.language).toBe("go");
        expect(node.qualifiedName.length).toBeGreaterThan(0);
      }
      const count = (kind: string): number =>
        nodes.filter((node) => node.kind === kind).length;
      expect(count("File")).toBe(3);
      expect(count("Class")).toBe(3);
      expect(count("Function")).toBe(8);
      expect(count("Method")).toBe(4);
      expect(count("Endpoint")).toBe(3);
      expect(count("UnknownExternal")).toBe(6);
      // File node sourceHash attribute'u gerçek dosya içeriğinin SHA-256'sı.
      const mainFile = nodes.find(
        (node) => node.kind === "File" && node.qualifiedName === "main.go",
      );
      expect(mainFile?.attributes["sourceHash"]).toBe(contentHash("main.go"));
    });

    it("pozitif: CONTAINS — File→Function/Class ve Class→Method, hepsi verified", () => {
      const contains = (fixture?.edges ?? []).filter(
        (edge) => edge.kind === "CONTAINS",
      );
      // main.go 6 func + repositories 5 (2 Class, 1 Function, 2 Method)
      // + services 4 (1 Class, 1 Function, 2 Method) = 15 File→decl;
      // 4 Class→Method = 19.
      expect(contains).toHaveLength(19);
      for (const edge of contains) {
        expect(edge.resolution).toBe("verified");
        expect(edge.evidence.length).toBeGreaterThan(0);
        expect(edge.evidence[0]?.kind).toBe("ast-span");
        expect(edge.evidence[0]?.analyzerId).toBe("go-worker");
      }
      expect(
        findEdge(fixture?.edges, "CONTAINS", "main.go", "main.ordersHandler"),
      ).toBeDefined();
      expect(
        findEdge(fixture?.edges, "CONTAINS", "main.go", "main.newOrderService"),
      ).toBeDefined();
      expect(
        findEdge(
          fixture?.edges,
          "CONTAINS",
          "services/orders_service.go",
          "services.OrdersService",
        ),
      ).toBeDefined();
      expect(
        findEdge(
          fixture?.edges,
          "CONTAINS",
          "services.OrdersService",
          "services.OrdersService.GetOrders",
        ),
      ).toBeDefined();
      expect(
        findEdge(
          fixture?.edges,
          "CONTAINS",
          "repositories.OrdersRepository",
          "repositories.OrdersRepository.Save",
        ),
      ).toBeDefined();
    });

    it("pozitif: CALLS — aynı package bare ident verified", () => {
      const verifiedPairs: Array<[string, string]> = [
        ["main.ordersHandler", "main.newOrderService"],
        ["main.ordersHandler", "main.writeJSON"],
        ["main.createOrderHandler", "main.newOrderService"],
        ["main.createOrderHandler", "main.writeJSON"],
        ["main.healthHandler", "main.writeJSON"],
      ];
      for (const [from, to] of verifiedPairs) {
        const edge = findEdge(fixture?.edges, "CALLS", from, to);
        expect(edge, `CALLS ${from} → ${to}`).toBeDefined();
        expect(edge?.resolution).toBe("verified");
        const span = edge?.evidence[0]?.span;
        expect(span?.relativePath).toBe("main.go");
        expect(span?.sourceHash).toBe(contentHash("main.go"));
      }
    });

    it("pozitif: CALLS — package-qualified (analiz setindeki package) heuristic", () => {
      const qualified = findEdge(
        fixture?.edges,
        "CALLS",
        "main.newOrderService",
        "services.NewOrdersService",
      );
      expect(qualified).toBeDefined();
      expect(qualified?.resolution).toBe("heuristic");
      expect(qualified?.ambiguity).toBeDefined();
      expect(
        findEdge(
          fixture?.edges,
          "CALLS",
          "main.newOrderService",
          "repositories.NewOrdersRepository",
        )?.resolution,
      ).toBe("heuristic");
    });

    it("pozitif: CALLS — benzersiz metot adı kuralı heuristic (zincir ucu dahil)", () => {
      const chain: Array<[string, string, string, number]> = [
        ["main.ordersHandler", "services.OrdersService.GetOrders", "main.go", 39],
        ["main.createOrderHandler", "services.OrdersService.Create", "main.go", 45],
        [
          "services.OrdersService.GetOrders",
          "repositories.OrdersRepository.FindAll",
          "services/orders_service.go",
          24,
        ],
        [
          "services.OrdersService.Create",
          "repositories.OrdersRepository.Save",
          "services/orders_service.go",
          30,
        ],
      ];
      for (const [from, to, path, line] of chain) {
        const edge = findEdge(fixture?.edges, "CALLS", from, to);
        expect(edge, `CALLS ${from} → ${to}`).toBeDefined();
        expect(edge?.resolution).toBe("heuristic");
        expect(edge?.ambiguity).toBeDefined();
        expect(edge?.evidence[0]?.span?.relativePath).toBe(path);
        expect(edge?.evidence[0]?.span?.startLine).toBe(line);
      }
    });

    it("pozitif: CALLS — analiz seti dışı selector'lar dürüst çözümlenir", () => {
      // Analiz seti dışı package: heuristic + UnknownExternal hedef.
      const external = findEdge(fixture?.edges, "CALLS", "main.main", "log.Fatal");
      expect(external).toBeDefined();
      expect(external?.resolution).toBe("heuristic");
      expect(external?.to.kind).toBe("UnknownExternal");
      expect(external?.to.relativePath ?? null).toBeNull();
      // Zincirli external akış: temel import üzerinden heuristic.
      const encoderChain = (fixture?.edges ?? []).find(
        (candidate) =>
          candidate.kind === "CALLS" &&
          candidate.to.qualifiedName === "json.NewEncoder(w).Encode",
      );
      expect(encoderChain).toBeDefined();
      expect(encoderChain?.resolution).toBe("heuristic");
      // Tip çözümsüz selector-call ifadeleri: unresolved — uydurma hedef yok.
      const unresolvedTexts = [
        "w.Header",
        "w.Header().Set",
        "srv.ListenAndServe",
      ];
      for (const text of unresolvedTexts) {
        const edge = (fixture?.edges ?? []).find(
          (candidate) =>
            candidate.kind === "CALLS" &&
            candidate.to.kind === "UnknownExternal" &&
            candidate.to.qualifiedName === text,
        );
        expect(edge, `unresolved CALLS ${text}`).toBeDefined();
        expect(edge?.resolution).toBe("unresolved");
      }
    });

    it("pozitif: CALLS evidence satır span'leri fixture metniyle eşleşir", () => {
      // ordersHandler gövdesi: 38 newOrderService, 39 writeJSON+GetOrders.
      const toService = findEdge(
        fixture?.edges,
        "CALLS",
        "main.ordersHandler",
        "main.newOrderService",
      );
      expect(toService?.evidence[0]?.span?.startLine).toBe(38);
      const writeJson = findEdge(
        fixture?.edges,
        "CALLS",
        "main.healthHandler",
        "main.writeJSON",
      );
      expect(writeJson?.evidence[0]?.span?.startLine).toBe(56);
    });

    it("pozitif: ROUTES_TO — http.HandleFunc kayıtları Endpoint + verified kenar", () => {
      const routes = (fixture?.edges ?? []).filter(
        (edge) => edge.kind === "ROUTES_TO",
      );
      expect(routes).toHaveLength(3);
      const endpoint = (qualifiedName: string): WorkerNode | undefined =>
        (fixture?.nodes ?? []).find(
          (node) =>
            node.kind === "Endpoint" && node.qualifiedName === qualifiedName,
        );
      const star = endpoint("* /orders");
      expect(star?.attributes["method"]).toBe("*");
      expect(star?.attributes["path"]).toBe("/orders");
      const byPath = findEdge(
        fixture?.edges,
        "ROUTES_TO",
        "* /orders",
        "main.ordersHandler",
      );
      expect(byPath?.resolution).toBe("verified");
      expect(byPath?.evidence[0]?.kind).toBe("route-registration");
      expect(byPath?.evidence[0]?.span?.startLine).toBe(60);
      expect(byPath?.evidence[0]?.span?.relativePath).toBe("main.go");
      expect(
        findEdge(
          fixture?.edges,
          "ROUTES_TO",
          "* /orders/create",
          "main.createOrderHandler",
        )?.evidence[0]?.span?.startLine,
      ).toBe(61);
      expect(
        findEdge(fixture?.edges, "ROUTES_TO", "* /health", "main.healthHandler")
          ?.evidence[0]?.span?.startLine,
      ).toBe(62);
    });

    it("pozitif: coverageRatio ve edge toplamı", () => {
      const edges = fixture?.edges ?? [];
      expect(edges).toHaveLength(39);
      // verified = 19 CONTAINS + 5 CALLS + 3 ROUTES_TO = 27; 27/39 = 0.6923
      expect(fixture?.coverageRatio).toBe(0.6923);
    });

    it("pozitif: evidence dedupe — kenar kanıtları tekil listede toplanır", () => {
      const evidence = fixture?.evidence ?? [];
      expect(evidence.length).toBeGreaterThan(0);
      const keys = evidence.map((item) =>
        JSON.stringify([item.kind, item.span ?? null, item.rationale]),
      );
      expect(new Set(keys).size).toBe(keys.length);
      const edgeEvidenceCount = (fixture?.edges ?? []).reduce(
        (total, edge) => total + edge.evidence.length,
        0,
      );
      // Dedupe: aynı span'i paylaşan kenar kanıtları listede tekilleşir;
      // kenar-evidence toplamı >= tekil liste olmalı.
      expect(edgeEvidenceCount).toBeGreaterThanOrEqual(evidence.length);
    });

    it("pozitif: id echo — string ve sayı id birebir döner", () => {
      const run = runWorker([
        { id: "metin-id", type: "analyze", files: [...SYNTHETIC.builtin] },
        { id: 7, type: "analyze", files: [...SYNTHETIC.builtin] },
      ]);
      expect(run.exitCode).toBe(0);
      expect(run.lines).toHaveLength(2);
      expect(parseResponse(run.lines[0] ?? "").id).toBe("metin-id");
      expect(parseResponse(run.lines[1] ?? "").id).toBe(7);
    });

    it("negatif: bozuk JSON → id null + INVALID_ARGUMENT; worker sonraki satırla yaşamaya devam eder", () => {
      const run = runWorker([
        "{bozuk-json",
        { id: "sonraki", type: "analyze", files: [...SYNTHETIC.builtin] },
      ]);
      expect(run.exitCode).toBe(0);
      expect(run.lines).toHaveLength(2);
      const broken = parseResponse(run.lines[0] ?? "");
      expect(broken.status).toBe("error");
      expect(broken.id).toBeNull();
      expect(broken.error?.code).toBe("INVALID_ARGUMENT");
      const next = parseResponse(run.lines[1] ?? "");
      expect(next.status).toBe("ready");
      expect(next.id).toBe("sonraki");
    });

    it("negatif: kesin şema — bilinmeyen alan / eksik id / bilinmeyen type / kötü protocolVersion", () => {
      const run = runWorker([
        { id: "x1", type: "analyze", files: [...SYNTHETIC.builtin], extra: true },
        {
          id: "x2",
          type: "analyze",
          protocolVersion: "1",
          files: [{ path: "a.go", content: "package a", extra: 1 }],
        },
        { type: "analyze", files: [...SYNTHETIC.builtin] },
        { id: "x4", type: "refactor", files: [...SYNTHETIC.builtin] },
        { id: "x5", type: "analyze", protocolVersion: "2", files: [...SYNTHETIC.builtin] },
        { id: "x6", type: "analyze" },
        { id: "x7", type: "analyze", files: [] },
      ]);
      expect(run.exitCode).toBe(0);
      expect(run.lines).toHaveLength(7);
      for (const line of run.lines) {
        expect(parseResponse(line).error?.code).toBe("INVALID_ARGUMENT");
      }
      expect(parseResponse(run.lines[2] ?? "").id).toBeNull();
    });

    it("negatif: yol sözleşmesi — '..' / mutlak / duplicate / boş / nokta segment reddedilir", () => {
      const run = runWorker([
        { id: "y1", type: "analyze", files: [{ path: "../escape.go", content: "package a" }] },
        { id: "y2", type: "analyze", files: [{ path: "/etc/x.go", content: "package a" }] },
        { id: "y3", type: "analyze", files: [{ path: "C:/x.go", content: "package a" }] },
        {
          id: "y4",
          type: "analyze",
          files: [
            { path: "a.go", content: "package a" },
            { path: "a.go", content: "package a" },
          ],
        },
        { id: "y5", type: "analyze", files: [{ path: "dir/./x.go", content: "package a" }] },
        { id: "y6", type: "analyze", files: [{ path: "", content: "package a" }] },
      ]);
      expect(run.exitCode).toBe(0);
      expect(run.lines).toHaveLength(6);
      for (const line of run.lines) {
        expect(parseResponse(line).error?.code).toBe("INVALID_ARGUMENT");
      }
    });

    it("negatif: LIMIT_EXCEEDED — 5001 dosya ve 2MB üstü içerik", () => {
      const many = Array.from({ length: 5001 }, (_, index) => ({
        path: `gen/file${String(index)}.go`,
        content: "package gen",
      }));
      const big =
        "package big\n\nvar x = `" + "x".repeat(2 * 1024 * 1024) + "`\n";
      const run = runWorker([
        { id: "z1", type: "analyze", files: many },
        { id: "z2", type: "analyze", files: [{ path: "big.go", content: big }] },
      ]);
      expect(run.exitCode).toBe(0);
      expect(run.lines).toHaveLength(2);
      expect(parseResponse(run.lines[0] ?? "").error?.code).toBe("LIMIT_EXCEEDED");
      expect(parseResponse(run.lines[1] ?? "").error?.code).toBe("LIMIT_EXCEEDED");
    }, 180_000);

    it("negatif: maxNodes aralık dışı INVALID_ARGUMENT", () => {
      const run = runWorker([
        { id: "m1", type: "analyze", files: [...SYNTHETIC.builtin], maxNodes: 0 },
        { id: "m2", type: "analyze", files: [...SYNTHETIC.builtin], maxNodes: 250001 },
      ]);
      expect(run.lines).toHaveLength(2);
      expect(parseResponse(run.lines[0] ?? "").error?.code).toBe("INVALID_ARGUMENT");
      expect(parseResponse(run.lines[1] ?? "").error?.code).toBe("INVALID_ARGUMENT");
    });

    it("partial: maxNodes kırpma — RESPONSE_TRUNCATED tanısı, dangling kenar yok", () => {
      const source = [
        "package main",
        "",
        "func f1() {}",
        "func f2() {}",
        "func f3() {}",
        "func f4() {}",
        "func f5() {}",
        "func f6() {}",
        "",
      ].join("\n");
      const run = runWorker([
        {
          id: "trim",
          type: "analyze",
          protocolVersion: "1",
          files: [{ path: "trim.go", content: source }],
          maxNodes: 2,
        },
      ]);
      const response = parseResponse(run.lines[0] ?? "");
      expect(response.status).toBe("partial");
      expect(response.nodes).toHaveLength(2);
      // Kanonik sıra: File < Function → File(trim.go) + Function(main.f1) kalır.
      expect(response.nodes?.[0]?.qualifiedName).toBe("trim.go");
      expect(response.nodes?.[1]?.qualifiedName).toBe("main.f1");
      // Uçları kırpılan kenarlar düşer: yalnız File CONTAINS main.f1 kalır.
      expect(response.edges).toHaveLength(1);
      expect(response.edges?.[0]?.to.qualifiedName).toBe("main.f1");
      expect(
        (response.diagnostics ?? []).some(
          (diagnostic) => diagnostic.code === "RESPONSE_TRUNCATED",
        ),
      ).toBe(true);
    });

    it("partial: sözdizimi hatası → diagnostics + graph yine üretilir", () => {
      const run = runWorker([
        { id: "syn", type: "analyze", files: [...SYNTHETIC.syntaxError] },
      ]);
      const response = parseResponse(run.lines[0] ?? "");
      expect(response.status).toBe("partial");
      const parseDiag = (response.diagnostics ?? []).find(
        (diagnostic) => diagnostic.code === "GOPARSE",
      );
      expect(parseDiag?.relativePath).toBe("broken.go");
      expect(parseDiag?.line ?? 0).toBeGreaterThanOrEqual(1);
      // Kısmen parse edilen dosya + sağlam dosya katkı vermeye devam eder.
      expect(
        (response.nodes ?? []).some((node) => node.qualifiedName === "valid.go"),
      ).toBe(true);
      expect(
        findEdge(response.edges, "CONTAINS", "valid.go", "main.intact"),
      ).toBeDefined();
    });

    it("partial: AST derinlik savunması — 1100 derinlik GO_AST_DEPTH + partial", () => {
      const run = runWorker([
        { id: "deep", type: "analyze", files: [...SYNTHETIC.deep] },
      ]);
      const response = parseResponse(run.lines[0] ?? "");
      expect(response.status).toBe("partial");
      expect(
        (response.diagnostics ?? []).some(
          (diagnostic) => diagnostic.code === "GO_AST_DEPTH",
        ),
      ).toBe(true);
      expect(
        (response.nodes ?? []).some((node) => node.qualifiedName === "deep.go"),
      ).toBe(true);
    });

    it("birim: arayüz metodu çağrısı → heuristic (UnknownExternal hedef + arayüz adayı)", () => {
      const run = runWorker([
        { id: "iface", type: "analyze", files: [...SYNTHETIC.interface_] },
      ]);
      const response = parseResponse(run.lines[0] ?? "");
      expect(response.status).toBe("ready");
      const edge = (response.edges ?? []).find(
        (candidate) =>
          candidate.kind === "CALLS" &&
          candidate.to.qualifiedName === "n.Notify",
      );
      expect(edge).toBeDefined();
      expect(edge?.resolution).toBe("heuristic");
      expect(edge?.to.kind).toBe("UnknownExternal");
      expect(edge?.ambiguity?.candidates).toContain("main.Notifier.Notify");
    });

    it("birim: çok adaylı metot adı → unresolved + aday listesi", () => {
      const run = runWorker([
        { id: "amb", type: "analyze", files: [...SYNTHETIC.ambiguous] },
      ]);
      const response = parseResponse(run.lines[0] ?? "");
      const edge = (response.edges ?? []).find(
        (candidate) =>
          candidate.kind === "CALLS" &&
          candidate.to.qualifiedName === "x.DoIt",
      );
      expect(edge).toBeDefined();
      expect(edge?.resolution).toBe("unresolved");
      expect(edge?.ambiguity?.candidates).toEqual([
        "main.A.DoIt",
        "main.B.DoIt",
      ]);
    });

    it("birim: builtin çağrılar CALLS üretmez", () => {
      const run = runWorker([
        { id: "bif", type: "analyze", files: [...SYNTHETIC.builtin] },
      ]);
      const response = parseResponse(run.lines[0] ?? "");
      const calls = (response.edges ?? []).filter(
        (edge) => edge.kind === "CALLS",
      );
      expect(calls).toHaveLength(0);
    });

    it("birim: gin/echo/chi kayıt kalıpları → Endpoint + verified ROUTES_TO", () => {
      const run = runWorker([
        { id: "routes", type: "analyze", files: [...SYNTHETIC.routes] },
      ]);
      const response = parseResponse(run.lines[0] ?? "");
      expect(response.status).toBe("ready");
      const routeEdge = (
        path: string,
        handler: string,
      ): WorkerEdge | undefined =>
        (response.edges ?? []).find(
          (candidate) =>
            candidate.kind === "ROUTES_TO" &&
            candidate.from.qualifiedName === path &&
            candidate.to.qualifiedName === handler,
        );
      expect(routeEdge("* /ping", "main.pingHandler")?.resolution).toBe("verified");
      expect(routeEdge("GET /ping", "main.pingHandler")?.resolution).toBe("verified");
      expect(routeEdge("POST /users", "main.createUser")?.resolution).toBe("verified");
      expect(routeEdge("GET /users", "main.listUsers")?.resolution).toBe("verified");
      expect(routeEdge("* /health", "main.pingHandler")?.resolution).toBe("verified");
      const endpointNode = (response.nodes ?? []).find(
        (node) =>
          node.kind === "Endpoint" && node.qualifiedName === "GET /users",
      );
      expect(endpointNode?.attributes["method"]).toBe("GET");
      expect(endpointNode?.attributes["path"]).toBe("/users");
    });

    it("birim: selector handler (s.Status) → heuristic ROUTES_TO Method node", () => {
      const run = runWorker([
        { id: "sel", type: "analyze", files: [...SYNTHETIC.selectorHandler] },
      ]);
      const response = parseResponse(run.lines[0] ?? "");
      const edge = (response.edges ?? []).find(
        (candidate) =>
          candidate.kind === "ROUTES_TO" &&
          candidate.from.qualifiedName === "* /admin/status",
      );
      expect(edge).toBeDefined();
      expect(edge?.resolution).toBe("heuristic");
      expect(edge?.to.qualifiedName).toBe("main.AdminServer.Status");
      expect(edge?.ambiguity).toBeDefined();
    });

    it("partial: inline anonim handler → Endpoint korunur, ROUTES_TO yok + uyarı", () => {
      const run = runWorker([
        { id: "inline", type: "analyze", files: [...SYNTHETIC.inlineHandler] },
      ]);
      const response = parseResponse(run.lines[0] ?? "");
      expect(response.status).toBe("partial");
      expect(
        (response.nodes ?? []).some(
          (node) =>
            node.kind === "Endpoint" && node.qualifiedName === "* /inline",
        ),
      ).toBe(true);
      expect(
        (response.edges ?? []).some(
          (edge) =>
            edge.kind === "ROUTES_TO" &&
            edge.from.qualifiedName === "* /inline",
        ),
      ).toBe(false);
      expect((response.warnings ?? []).length).toBeGreaterThan(0);
      expect(response.unsupportedConstructs ?? []).toContain(
        "inline-anonymous-route-handlers",
      );
    });

    it("determinizm: aynı istek iki koşumda birebir aynı yanıt satırı", () => {
      const request = {
        id: "det",
        type: "analyze",
        protocolVersion: "1",
        files: fixtureFiles(),
      };
      const first = runWorker([request]);
      const second = runWorker([request]);
      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(first.lines[0]).toBe(second.lines[0]);
    }, 180_000);
  },
);

void workerSuite;

/* ------------------------------------------------------------------ */
/* 2) Adapter — analyzeGoWorkspace (gerçek worker koşumu)              */
/* ------------------------------------------------------------------ */

const adapterSuite = describe.skipIf(!goAvailable)(
  "@causoryn/adapter-go (M1-Go)",
  () => {
    let positive: GoAdapterResult | null = null;
    let positiveDeterminismJson = "";

    beforeAll(
      async () => {
        positive = await analyzeGoWorkspace({
          workspaceId: "adapter-m1-go",
          files: fixtureFiles(),
          options: { goBinaryPath: GO_BINARY },
        });
        positiveDeterminismJson = JSON.stringify(
          await analyzeGoWorkspace({
            workspaceId: "adapter-m1-go",
            files: fixtureFiles(),
            options: { goBinaryPath: GO_BINARY },
          }),
        );
      },
      600_000,
    );

    it("pozitif: worker hazır, state ready, workerAvailable true", () => {
      expect(positive).not.toBeNull();
      expect(positive?.state).toBe("ready");
      expect(positive?.workerAvailable).toBe(true);
      expect(positive?.analyzerId).toBe("go-worker");
      expect(positive?.coverageRatio).toBe(0.6923);
    });

    it("pozitif: capabilities TŞ §7 sözleşmesiyle taşınır", () => {
      expect(positive?.capabilities.astParse).toBe(true);
      expect(positive?.capabilities.symbolResolution).toBe(false);
      expect(positive?.capabilities.containsEdges).toBe(true);
      expect(positive?.capabilities.callEdges).toBe(true);
      expect(positive?.capabilities.importEdges).toBe(false);
      expect(positive?.capabilities.frameworkLinkers).toBe(false);
      expect(positive?.capabilities.routeDetection).toBe(
        "go-http-handlefunc-and-gin-echo-chi-registration-pattern",
      );
    });

    it("pozitif: zincir CALLS kenarları + evidence kanıtlanır", () => {
      const verified = (positive?.edges ?? []).find(
        (edge) =>
          edge.kind === "CALLS" &&
          edge.from.qualifiedName === "main.ordersHandler" &&
          edge.to.qualifiedName === "main.newOrderService",
      );
      expect(verified).toBeDefined();
      expect(verified?.resolution).toBe("verified");
      expect(verified?.evidence?.length ?? 0).toBeGreaterThan(0);
      expect(verified?.evidence?.[0]?.span?.relativePath).toBe("main.go");
      expect(verified?.evidence?.[0]?.span?.startLine).toBe(38);
      expect(verified?.evidence?.[0]?.analyzerId).toBe("go-worker");

      const heuristic = (positive?.edges ?? []).find(
        (edge) =>
          edge.kind === "CALLS" &&
          edge.from.qualifiedName === "services.OrdersService.GetOrders" &&
          edge.to.qualifiedName === "repositories.OrdersRepository.FindAll",
      );
      expect(heuristic).toBeDefined();
      expect(heuristic?.resolution).toBe("heuristic");
    });

    it("pozitif: sonuç createSnapshot kurucusuna beslenebilir (domain uyumu)", () => {
      const snapshot = createSnapshot({
        workspaceId: "adapter-m1-go-snapshot",
        revision: { id: "rev-m1-go", sequence: 0 },
        configHash: "adapter-m1-go-config",
        analyzerFingerprint: `go-worker@${positive?.analyzerVersion ?? "0.1.0"}`,
        state: positive?.state === "partial" ? "partial" : "ready",
        createdAt: "2026-11-15T00:00:00.000Z",
        nodes: positive?.nodes ?? [],
        edges: positive?.edges ?? [],
        evidence: positive?.evidence ?? [],
      });
      expect(snapshot.edges.length).toBe(39);
      expect(snapshot.nodes.length).toBe(27);
      const verifiedCalls = snapshot.edges.filter(
        (edge) => edge.kind === "CALLS" && edge.resolution === "verified",
      );
      expect(verifiedCalls.length).toBe(5);
      for (const edge of verifiedCalls) {
        expect(edge.evidenceIds.length).toBeGreaterThan(0);
      }
      expect(
        snapshot.edges.some(
          (edge) => edge.kind === "ROUTES_TO" && edge.resolution === "verified",
        ),
      ).toBe(true);
    });

    it("pozitif: aynı girdi → birebir aynı sonuç JSON (determinizm)", () => {
      expect(JSON.stringify(positive)).toBe(positiveDeterminismJson);
    });

    it("pozitif: binary-mode (önceden derlenmiş binary) birebir aynı graph üretir", async () => {
      expect(existsSync(WORKER_TEST_BINARY)).toBe(true);
      const viaBinary = await analyzeGoWorkspace({
        workspaceId: "adapter-m1-go",
        files: fixtureFiles(),
        options: { goWorkerBinaryPath: WORKER_TEST_BINARY },
      });
      expect(viaBinary.workerAvailable).toBe(true);
      expect(viaBinary.state).toBe("ready");
      expect(JSON.stringify(viaBinary)).toBe(JSON.stringify(positive));
    }, 120_000);
  },
);

void adapterSuite;

/* ------------------------------------------------------------------ */
/* 3) Graceful fallback — sahte süreçler ve girdi reddiyeleri          */
/*    (go gerektirmez; motor izolasyonu kanıtı)                        */
/* ------------------------------------------------------------------ */

describe("adapters/go graceful fallback (M1-Go)", () => {
  it("negatif: olmayan worker binary → motor çökmez, partial + L0/L1 + explicit warning", async () => {
    const result = await analyzeGoWorkspace({
      workspaceId: "adapter-go-negative",
      files: fixtureFiles(),
      options: {
        goWorkerBinaryPath: join(WORKER_DIR, "bin-olmayan-worker.exe"),
        requestTimeoutMs: 30_000,
      },
    });
    expect(result.workerAvailable).toBe(false);
    expect(result.state).toBe("partial");
    expect(result.coverageRatio).toBe(0);
    expect(result.edges).toEqual([]);
    expect(result.evidence).toEqual([]);
    // L0/L1 düşüş: File node'ları korunur, sembol düzeyi üretilmez.
    expect(result.nodes.length).toBe(FIXTURE_FILES.length);
    expect(result.nodes.every((node) => node.kind === "File")).toBe(true);
    expect(
      result.warnings.some(
        (warning) =>
          warning.includes("Go worker kullanılamıyor") &&
          warning.includes("L0/L1"),
      ),
    ).toBe(true);
  }, 60_000);

  it("partial: yarı satır yanıt → timeout + kill + L0/L1 fallback", async () => {
    const capture: { child: ChildProcess | null } = { child: null };
    const result = await analyzeGoWorkspace({
      workspaceId: "adapter-go-halfline",
      files: fixtureFiles(),
      options: {
        requestTimeoutMs: 400,
        goWorkerBinaryPath: "sahte-worker",
        spawnProcess: (command, args, options) => {
          void command;
          void args;
          capture.child = spawn("node", [FAKE_HALFLINE_PATH], options);
          return capture.child;
        },
      },
    });
    expect(result.workerAvailable).toBe(false);
    expect(result.state).toBe("partial");
    expect(result.coverageRatio).toBe(0);
    expect(capture.child).not.toBeNull();
    expect(capture.child?.killed).toBe(true);
    expect(
      result.warnings.some((warning) => warning.includes("zaman aşımı")),
    ).toBe(true);
  });

  it("partial: anında çöken worker → unavailable fallback, çökmez", async () => {
    const result = await analyzeGoWorkspace({
      workspaceId: "adapter-go-crash",
      files: fixtureFiles(),
      options: {
        requestTimeoutMs: 30_000,
        goWorkerBinaryPath: "sahte-worker",
        spawnProcess: (command, args, options) => {
          void command;
          void args;
          return spawn("node", [FAKE_CRASH_PATH], options);
        },
      },
    });
    expect(result.workerAvailable).toBe(false);
    expect(result.state).toBe("partial");
    expect(result.nodes.length).toBe(FIXTURE_FILES.length);
    expect(
      result.warnings.some((warning) => warning.includes("cakildi")),
    ).toBe(true);
  });

  it("partial: çöken worker + büyük payload → stdin EPIPE yarışı motor çökmez", async () => {
    const bigContent =
      'package big\n\nvar x = "' + "x".repeat(200 * 1024) + '"\n';
    const result = await analyzeGoWorkspace({
      workspaceId: "adapter-go-crash-bigpayload",
      files: [{ path: "Big/Big.go", content: bigContent }, ...fixtureFiles()],
      options: {
        requestTimeoutMs: 30_000,
        goWorkerBinaryPath: "sahte-worker",
        spawnProcess: (command, args, options) => {
          void command;
          void args;
          return spawn("node", [FAKE_CRASH_PATH], options);
        },
      },
    });
    expect(result.workerAvailable).toBe(false);
    expect(result.state).toBe("partial");
    expect(result.nodes.length).toBe(FIXTURE_FILES.length + 1);
  });

  it("partial: worker status:'error' yanıtı → hata kodu warnings'e taşınır", async () => {
    const result = await analyzeGoWorkspace({
      workspaceId: "adapter-go-worker-error",
      files: fixtureFiles(),
      options: {
        requestTimeoutMs: 30_000,
        goWorkerBinaryPath: "sahte-worker",
        spawnProcess: (command, args, options) => {
          void command;
          void args;
          return spawn("node", [FAKE_ERROR_PATH], options);
        },
      },
    });
    expect(result.workerAvailable).toBe(false);
    expect(result.state).toBe("partial");
    expect(result.coverageRatio).toBe(0);
    expect(
      result.warnings.some(
        (warning) =>
          warning.includes("LIMIT_EXCEEDED") &&
          warning.includes("dosya sayısı sınırı"),
      ),
    ).toBe(true);
    expect(result.nodes.length).toBe(FIXTURE_FILES.length);
  });

  it("negatif girdi: boş workspaceId ve mutlak yol DomainError ile reddedilir", async () => {
    await expect(
      analyzeGoWorkspace({ workspaceId: "", files: fixtureFiles() }),
    ).rejects.toThrowError(/workspaceId/);
    await expect(
      analyzeGoWorkspace({
        workspaceId: "adapter-go-invalid",
        files: [{ path: "D:/outside/x.go", content: "package x" }],
      }),
    ).rejects.toThrowError(/Mutlak kaynak yolu/);
  });

  it("negatif girdi: '..' kaçışı ve duplicate path adapter API yüzeyinde reddedilir", async () => {
    await expect(
      analyzeGoWorkspace({
        workspaceId: "adapter-go-escape",
        files: [{ path: "../escape.go", content: "package x" }],
      }),
    ).rejects.toThrowError(/kök dışına çıkıyor/);
    await expect(
      analyzeGoWorkspace({
        workspaceId: "adapter-go-duplicate",
        files: [
          { path: "a.go", content: "package a" },
          { path: "a.go", content: "package a" },
        ],
      }),
    ).rejects.toThrowError(/iki kez verildi/);
  });
});

/* ------------------------------------------------------------------ */
/* 4) worker-process birim davranışları (go gerektirmez)               */
/* ------------------------------------------------------------------ */

/** Stdout'a geçerli bir protokol yanıtı yazıp kapanan sentetik süreç. */
function makeSyntheticChild(responseLine: string): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter();
  const childRecord = child as unknown as Record<string, unknown>;
  childRecord.stdout = stdout;
  childRecord.stderr = stderr;
  childRecord.stdin = Object.assign(stdin, {
    write: () => true,
    end: () => {},
  });
  childRecord.killed = false;
  childRecord.exitCode = null;
  childRecord.signalCode = null;
  childRecord.kill = () => true;
  queueMicrotask(() => {
    stdout.emit("data", Buffer.from(`${responseLine}\n`, "utf8"));
  });
  return child;
}

describe("worker-process env sınırlaması (M1-Go)", () => {
  it("spawn options yalnızca allowlist ortam taşır; parent gizli değişkenleri miraslanmaz", async () => {
    const captured: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly options: {
        readonly stdio: ["pipe", "pipe", "pipe"];
        readonly env: Readonly<Record<string, string>>;
        readonly cwd?: string;
      };
    }> = [];

    // Sentinel: parent env'de "gizli" bir anahtar; worker env'ine GEÇMEMELİ.
    const previousSecret = process.env["CAUSORYN_TEST_SECRET"];
    process.env["CAUSORYN_TEST_SECRET"] = "token-abc-123";
    try {
      const outcome = await runGoWorkerAnalyze({
        goBinaryPath: GO_BINARY,
        goWorkerBinaryPath: "",
        workerDir: WORKER_DIR,
        requestPayload: { id: "env-probe" },
        requestTimeoutMs: 5_000,
        spawnProcess: (callbackCommand, callbackArgs, callbackOptions) => {
          captured.push({
            command: callbackCommand,
            args: callbackArgs,
            options: callbackOptions,
          });
          return makeSyntheticChild(
            JSON.stringify({
              id: "env-probe",
              protocolVersion: "1",
              status: "ready",
            }),
          );
        },
      });
      expect(outcome.status).toBe("ok");

      expect(captured).toHaveLength(1);
      const spawnOptions = captured[0]?.options;
      if (spawnOptions === undefined) {
        throw new Error("spawn options yakalanamadı");
      }
      // go run yolu: SABİT argüman dizisi + SABİT cwd.
      expect(captured[0]?.args).toEqual(["run", "./cmd/worker"]);
      expect(spawnOptions.cwd).toBe(WORKER_DIR);
      expect(spawnOptions.env).toBeDefined();
      // Allowlist dışı parent değişkeni worker'a GEÇMEZ.
      expect(spawnOptions.env["CAUSORYN_TEST_SECRET"]).toBeUndefined();
      // go çalışması için gerekenler korunur.
      expect(spawnOptions.env["PATH"]).toBeDefined();
    } finally {
      if (previousSecret === undefined) delete process.env["CAUSORYN_TEST_SECRET"];
      else process.env["CAUSORYN_TEST_SECRET"] = previousSecret;
    }
  });

  it("binary-mode spawn: argüman dizisi boş", async () => {
    const captured: Array<{
      readonly args: readonly string[];
      readonly cwd?: string | undefined;
    }> = [];
    await runGoWorkerAnalyze({
      goBinaryPath: GO_BINARY,
      goWorkerBinaryPath: join(WORKER_BIN_DIR, "built-worker.exe"),
      workerDir: WORKER_DIR,
      requestPayload: { id: "bin-probe" },
      requestTimeoutMs: 5_000,
      spawnProcess: (callbackCommand, callbackArgs, callbackOptions) => {
        void callbackCommand;
        captured.push({ args: callbackArgs, cwd: callbackOptions.cwd });
        return makeSyntheticChild(
          JSON.stringify({
            id: "bin-probe",
            protocolVersion: "1",
            status: "ready",
          }),
        );
      },
    });
    expect(captured[0]?.args).toEqual([]);
    expect(captured[0]?.cwd).toBe(WORKER_DIR);
  });

  it("responseMaxChars aşan tek yanıt satırı süreç kill + unavailable fallback üretir", async () => {
    const oversizedValidJson = JSON.stringify({
      id: "cap-probe",
      protocolVersion: "1",
      status: "ready",
      pad: "x".repeat(200),
    });
    const killed: Array<boolean> = [];
    const outcome = await runGoWorkerAnalyze({
      goBinaryPath: GO_BINARY,
      goWorkerBinaryPath: "",
      workerDir: WORKER_DIR,
      requestPayload: { id: "cap-probe" },
      requestTimeoutMs: 5_000,
      responseMaxChars: 64,
      spawnProcess: () => {
        const child = makeSyntheticChild(oversizedValidJson);
        const record = child as unknown as Record<string, unknown>;
        record.kill = () => {
          killed.push(true);
          return true;
        };
        return child;
      },
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.detail).toContain("sınır");
    expect(killed.length).toBe(1);
  });

  it("sınır altındaki yanıt normal ok ile döner (pozitif kontrol)", async () => {
    const outcome = await runGoWorkerAnalyze({
      goBinaryPath: GO_BINARY,
      goWorkerBinaryPath: "",
      workerDir: WORKER_DIR,
      requestPayload: { id: "cap-ok" },
      requestTimeoutMs: 5_000,
      responseMaxChars: 4_096,
      spawnProcess: () =>
        makeSyntheticChild(
          JSON.stringify({ id: "cap-ok", protocolVersion: "1", status: "ready" }),
        ),
    });
    expect(outcome.status).toBe("ok");
  });

  /**
   * Sentetik worker: önce verilen stderr parçalarını, sonra (istendiyse)
   * geçerli protokol yanıtını stdout'a yazar; süreç kapanmaz (timeout
   * penceresi canlı kalmalı — sınırsız birikim senaryosu).
   */
  function makeStderrChild(io: {
    stderrChunks?: string[];
    stdoutResponseLine?: string;
    pid?: number;
  }): ChildProcess {
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = new EventEmitter();
    const record = child as unknown as Record<string, unknown>;
    record.stdout = stdout;
    record.stderr = stderr;
    record.stdin = Object.assign(stdin, {
      write: () => true,
      end: () => {},
    });
    record.pid = io.pid;
    record.killed = false;
    record.exitCode = null;
    record.signalCode = null;
    record.kill = () => true;
    queueMicrotask(() => {
      for (const chunk of io.stderrChunks ?? []) {
        stderr.emit("data", Buffer.from(chunk, "utf8"));
      }
      if (io.stdoutResponseLine !== undefined) {
        stdout.emit("data", Buffer.from(`${io.stdoutResponseLine}\n`, "utf8"));
      }
    });
    return child;
  }

  it("negatif: stderr bütçesi aşımı → süreç kill + unavailable (sınırsız stderr birikimi savunması)", async () => {
    const killed: boolean[] = [];
    const outcome = await runGoWorkerAnalyze({
      goBinaryPath: GO_BINARY,
      goWorkerBinaryPath: "",
      workerDir: WORKER_DIR,
      requestPayload: { id: "stderr-cap" },
      requestTimeoutMs: 300,
      stderrMaxChars: 64,
      spawnProcess: () => {
        const child = makeStderrChild({
          stderrChunks: ["a".repeat(40), "b".repeat(40)],
        });
        const record = child as unknown as Record<string, unknown>;
        record.kill = () => {
          killed.push(true);
          return true;
        };
        return child;
      },
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.detail).toContain("sınırını aştı");
    // Saklanan kuyruk bütçeye kırpılır: birikim sınırsız büyüyemez.
    expect(outcome.stderr.length).toBeLessThanOrEqual(64);
    expect(killed.length).toBe(1);
  });

  it("pozitif kontrol: bütçe altındaki stderr yanıtla birlikte taşınır", async () => {
    const outcome = await runGoWorkerAnalyze({
      goBinaryPath: GO_BINARY,
      goWorkerBinaryPath: "",
      workerDir: WORKER_DIR,
      requestPayload: { id: "stderr-ok" },
      requestTimeoutMs: 5_000,
      stderrMaxChars: 4_096,
      spawnProcess: () =>
        makeStderrChild({
          stderrChunks: ["[go-worker] normal log\n"],
          stdoutResponseLine: JSON.stringify({
            id: "stderr-ok",
            protocolVersion: "1",
            status: "ready",
          }),
        }),
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.stderr).toContain("normal log");
  });

  it("timeout: go run modunda süreç sonlandırma AĞAÇ-KILL'dir — torun worker dahil (win32)", async () => {
    if (process.platform !== "win32") {
      // Ağaç-kill savunması win32'ye özeldir; diğer platformlarda mevcut
      // doğrudan kill davranışı korunur (dal koşullaması testte de açık).
      expect(true).toBe(true);
      return;
    }
    const spawned: Array<{ command: string; args: readonly string[] }> = [];
    const killed: boolean[] = [];
    const outcome = await runGoWorkerAnalyze({
      goBinaryPath: GO_BINARY,
      goWorkerBinaryPath: "",
      workerDir: WORKER_DIR,
      requestPayload: { id: "tree-kill" },
      requestTimeoutMs: 300,
      spawnProcess: (command, args) => {
        spawned.push({ command, args: [...args] });
        const child = makeStderrChild({ pid: 4242 });
        const record = child as unknown as Record<string, unknown>;
        record.kill = () => {
          killed.push(true);
          return true;
        };
        return child;
      },
    });
    expect(outcome.status).toBe("timeout");
    // Doğrudan kill her koşulda uygulanır (ağaç-kill ek savunmadır).
    expect(killed.length).toBe(1);
    // İkinci spawn: LİTERAL "taskkill" + SADECE kendi çocuğumuzun sayısal
    // pid'i (/T ağaç, /F zorla). Kullanıcı girdisi interpole edilmez.
    expect(spawned.length).toBe(2);
    expect(spawned[1]?.command).toBe("taskkill");
    expect(spawned[1]?.args).toEqual(["/pid", "4242", "/T", "/F"]);
  });

  it("timeout: binary modda ağaç-kill YOKTUR — tek spawn, yalnızca doğrudan kill", async () => {
    const spawned: Array<{ command: string }> = [];
    const outcome = await runGoWorkerAnalyze({
      goBinaryPath: GO_BINARY,
      goWorkerBinaryPath: join(WORKER_BIN_DIR, "built-worker.exe"),
      workerDir: WORKER_DIR,
      requestPayload: { id: "tree-kill-binary" },
      requestTimeoutMs: 300,
      spawnProcess: (command) => {
        spawned.push({ command });
        return makeStderrChild({ pid: 4243 });
      },
    });
    expect(outcome.status).toBe("timeout");
    expect(spawned.length).toBe(1);
  });
});
