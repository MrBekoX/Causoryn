/**
 * Roslyn sidecar worker kabul testleri — sprint-2 B1 (TŞ v2.1 §7, §23).
 *
 * Sözleşme: native/roslyn-worker/PROTOCOL.md (protokol v1).
 * Pozitif + negatif + partial üçlüsü, kaynak sınırları (TŞ §9 resource
 * budget, K-010: yalnızca boyut limitleri), AST derinlik savunması ve
 * determinizm invariant'ı (TŞ §8 invariant vi) burada kanıtlanır.
 *
 * Ön koşul: dotnet SDK. Worker binary'si yoksa test kendi derler; dotnet
 * bulunamazsa suite skip edilir (koşulamadı olarak raporlanır).
 *
 * Güvenlik notu (proje kırmızı çizgisi 6): süreç koşumları node:child_process
 * spawnSync ile LİTERAL çalıştırılabilir ("dotnet") + ARGÜMAN DİZİSİ ve
 * shell: false ile yapılır; DLL yolu repo içi SABİT yol constant'ıdır;
 * kullanıcı/istemci girdisi asla komut satırına interpole edilmez.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = join(REPO_ROOT, "native", "roslyn-worker");
const WORKER_DLL = join(
  WORKER_DIR,
  "bin",
  "Debug",
  "net10.0",
  "Causoryn.RoslynWorker.dll",
);
const FIXTURE_DIR = join(REPO_ROOT, "examples", "fixture-csharp-orders");

const FIXTURE_FILES = [
  "Program.cs",
  "Controllers/OrdersController.cs",
  "Services/OrdersService.cs",
  "Repositories/OrderRepository.cs",
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
  diagnostics?: Array<{
    relativePath: string;
    code: string;
    message: string;
    line: number;
  }>
  nodes?: WorkerNode[];
  edges?: WorkerEdge[];
  evidence?: Evidence[];
  warnings?: string[];
  coverageRatio?: number;
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
  const result = spawnSync("dotnet", ["exec", WORKER_DLL], {
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
/* Bootstrap: dotnet var mı? Build HER TURDA koşturulur ve sonucu      */
/* KONTROL EDİLİR (denetim bulgusu düzeltmesi).                        */
/* ------------------------------------------------------------------ */

/**
 * Denetim bulgusu düzeltmesi: build sonucu KONTROL EDİLİR. dotnet
 * mevcutken derleme her turda koşturulur (incremental, ucuz); başarısız
 * derleme explicit Error throw eder → suite FAIL — C# derleme regresyonu
 * sessiz skip/yeşil ile geçiştirilmez (kırmızı kanıt: bozuk csproj +
 * eksik DLL ile eski kod "31 skipped + vitest exit 0" üretiyordu).
 * Skip YALNIZCA dotnet bulunamadığında meşrudur (koşulamadı raporu;
 * TŞ §23 "çalıştırılamadı diye açıkça raporla" prensibi).
 */
export function bootstrapWorkerBinary(io: {
  dotnetAvailable: boolean;
  dllExists: () => boolean;
  runBuild: () => { status: number | null; stderr?: string };
}): { workerReady: boolean; skipReason: string | null } {
  if (!io.dotnetAvailable)
  {
    return {
      workerReady: false,
      skipReason:
        "dotnet SDK bulunamadı — Roslyn worker kabul testleri koşulamadı (çalıştırılamadı olarak raporlanır)",
    };
  }

  const build = io.runBuild();
  if (build.status !== 0)
  {
    throw new Error(
      `worker derlemesi başarısız (dotnet build exit=${String(build.status)})` +
        (build.stderr ? `: ${build.stderr.slice(0, 400)}` : "") +
        " — C# derleme regresyonu sessiz skip ile geçiştirilmez",
    );
  }

  if (!io.dllExists())
  {
    throw new Error(
      "worker derlemesi başarılı bildirildi ama DLL çıktısı yok: " + WORKER_DLL,
    );
  }

  return { workerReady: true, skipReason: null };
}

const dotnetCheck = spawnSync("dotnet", ["--version"], {
  encoding: "utf8",
  shell: false,
});
const bootstrapResult = bootstrapWorkerBinary({
  dotnetAvailable: dotnetCheck.status === 0,
  dllExists: () => existsSync(WORKER_DLL),
  runBuild: () => {
    const build = spawnSync("dotnet", ["build", WORKER_DIR], {
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    });
    return {
      status: build.status,
      stderr: typeof build.stderr === "string" ? build.stderr : "",
    };
  },
});
const workerReady = bootstrapResult.workerReady;

/* ------------------------------------------------------------------ */
/* Test durumu                                                         */
/* ------------------------------------------------------------------ */

describe.skipIf(!workerReady)("roslyn-worker B1 (PROTOCOL.md v1)", () => {
  const files = FIXTURE_FILES.map((relativePath) => ({
    path: relativePath,
    content: fixture(relativePath),
  }));

  const analyzeRequest = {
    id: "fixture-orders-1",
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
  let malformed: { lines: string[]; exitCode: number } = {
    lines: [],
    exitCode: -1,
  };

  let partialResponse: WorkerResponse | null = null;
  let bigFileResponse: WorkerResponse | null = null;
  let manyFilesResponse: WorkerResponse | null = null;
  let depthRun: { lines: string[]; exitCode: number } = {
    lines: [],
    exitCode: -1,
  };

  let csprojVersion = "";

  beforeAll(
    () => {
      // 1) Pozitif koşu + determinizm koşusu.
      const run1 = runWorker([analyzeRequest]);
      analyzeExit = run1.exitCode;
      analyzeStderr = run1.stderr;
      analyzeLine = run1.lines[0] ?? "";
      analyzeResponse = parseLine(analyzeLine);
      determinismLine = runWorker([analyzeRequest]).lines[0] ?? "";

      // 2) Negatif batch (tek spawn'da 10 reddiye).
      const smallFile = { path: "Gen/File.cs", content: "class G { }" };
      const negativeRequests = [
        { id: "neg-empty-files", type: "analyze", files: [] },
        { id: "neg-missing-files", type: "analyze" },
        {
          id: "neg-dotdot",
          type: "analyze",
          files: [{ path: "../escape.cs", content: "class X { }" }],
        },
        {
          id: "neg-duplicate",
          type: "analyze",
          files: [
            { path: "a.cs", content: "class A { }" },
            { path: "a.cs", content: "class A { }" },
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
          files: [{ path: "a.cs", content: "class A { }", extra: true }],
        },
        {
          id: "neg-absolute-path",
          type: "analyze",
          files: [{ path: "D:/outside/file.cs", content: "class X { }" }],
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
      for (const line of runWorker(negativeRequests).lines) {
        const response = parseLine(line);
        const key = typeof response.id === "string" ? response.id : "(id-yok)";
        negativeById[key] = response;
      }

      // 3) Bozuk JSON + ardından geçerli istek (worker yaşama kanıtı).
      malformed = runWorker(["{bu json degil", analyzeRequest] as unknown[]);

      // 4) Partial: sözdizimi hatası.
      const partialRun = runWorker([
        {
          id: "partial-syntax-error",
          type: "analyze",
          protocolVersion: "1",
          files: [
            {
              path: "Broken/Broken.cs",
              content:
                "namespace Broken;\npublic class Broken\n{\n    public void Run( {\n}\n",
            },
          ],
        },
      ]);
      partialResponse = partialRun.lines[0]
        ? parseLine(partialRun.lines[0])
        : null;

      // 5) Kaynak sınırları (TŞ §9 resource budget, K-010 boyut limitleri).
      //    3 MB içerik: satır limitinin altında, dosya içerik limitinin
      //    üstünde → per-file LIMIT_EXCEEDED beklenir.
      const bigContent = `class Big { } /* ${"x".repeat(3 * 1024 * 1024)} */`;
      const bigRun = runWorker([
        {
          id: "limit-big-file",
          type: "analyze",
          protocolVersion: "1",
          files: [{ path: "Big/Big.cs", content: bigContent }],
        },
      ]);
      bigFileResponse = bigRun.lines[0] ? parseLine(bigRun.lines[0]) : null;

      const manyFiles = Array.from({ length: 5001 }, (_, index) => ({
        path: `Gen/File${index}.cs`,
        content: "class G { }",
      }));
      const manyRun = runWorker([
        {
          id: "limit-many-files",
          type: "analyze",
          protocolVersion: "1",
          files: manyFiles,
        },
      ]);
      manyFilesResponse = manyRun.lines[0] ? parseLine(manyRun.lines[0]) : null;

      // 6) AST derinlik savunması: derin parantezli ifade gezinme derinlik
      //    sınırını aşar; worker süreç olarak HAYATTA KALMALI ve tanı
      //    üretmelidir (StackOverflow ile çökme kabul edilmez).
      const depthCount = 5000;
      depthRun = runWorker([
        {
          id: "depth-deep-expression",
          type: "analyze",
          protocolVersion: "1",
          files: [
            {
              path: "Deep/Deep.cs",
              content: `class Deep { int X = ${"(".repeat(depthCount)}1${")".repeat(depthCount)}; }\n`,
            },
          ],
        },
      ]);

      // 7) Sürüm senkron dayanağı: csproj <Version> okunur.
      const csproj = readFileSync(
        join(WORKER_DIR, "Causoryn.RoslynWorker.csproj"),
        "utf8",
      );
      csprojVersion = /<Version>([^<]+)<\/Version>/.exec(csproj)?.[1] ?? "";
    },
    120_000,
  );

  /* ---------------- Pozitif: protokol zarfı ---------------- */

  it("pozitif: worker exit 0 ve tek satır yanıt", () => {
    expect(analyzeExit).toBe(0);
    expect(analyzeLine).not.toBe("");
    expect(analyzeStderr).toContain("[roslyn-worker]");
  });

  it("pozitif: id echo + protocolVersion + status ready", () => {
    expect(analyzeResponse?.id).toBe("fixture-orders-1");
    expect(analyzeResponse?.protocolVersion).toBe("1");
    expect(analyzeResponse?.status).toBe("ready");
  });

  it("pozitif: tanı yok ve analyzerId roslyn-worker", () => {
    expect(analyzeResponse?.diagnostics).toEqual([]);
    expect(analyzeResponse?.worker?.analyzerId).toBe("roslyn-worker");
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

  it("pozitif: CONTAINS File→Class ve Class→Method (L2)", () => {
    expect(
      findEdge(
        analyzeResponse,
        (edge) =>
          edge.kind === "CONTAINS" &&
          edge.from.kind === "File" &&
          edge.from.qualifiedName === "Controllers/OrdersController.cs" &&
          edge.to.kind === "Class" &&
          edge.to.qualifiedName ===
            "Causoryn.Fixture.Orders.Controllers.OrdersController",
      ),
    ).toBeDefined();
    expect(
      findEdge(
        analyzeResponse,
        (edge) =>
          edge.kind === "CONTAINS" &&
          edge.to.kind === "Method" &&
          edge.to.qualifiedName ===
            "Causoryn.Fixture.Orders.Services.OrdersService.Create",
      ),
    ).toBeDefined();
  });

  it("pozitif: CONTAINS property bildirimi (Method yaklaşımı)", () => {
    expect(
      findEdge(
        analyzeResponse,
        (edge) =>
          edge.kind === "CONTAINS" &&
          edge.to.kind === "Method" &&
          edge.to.qualifiedName ===
            "Causoryn.Fixture.Orders.Repositories.Order.Id",
      ),
    ).toBeDefined();
  });

  /* ---------------- Kabül kanıtı: CALLS zinciri ---------------- */

  it("pozitif: CALLS OrdersController.GetById→OrdersService.GetById (verified)", () => {
    const edge = findEdge(
      analyzeResponse,
      (edge) =>
        edge.kind === "CALLS" &&
        edge.from.qualifiedName ===
          "Causoryn.Fixture.Orders.Controllers.OrdersController.GetById" &&
        edge.to.qualifiedName ===
          "Causoryn.Fixture.Orders.Services.OrdersService.GetById",
    );
    expect(edge).toBeDefined();
    expect(edge?.resolution).toBe("verified");
  });

  it("pozitif: zincir kanıt satırı ve sourceHash fixture ile eşleşiyor", () => {
    const expectedLine = fixtureLine(
      "Controllers/OrdersController.cs",
      "_ordersService.GetById(id)",
    );
    const edge = findEdge(
      analyzeResponse,
      (edge) =>
        edge.kind === "CALLS" &&
        edge.from.qualifiedName ===
          "Causoryn.Fixture.Orders.Controllers.OrdersController.GetById",
    );
    const span = edge?.evidence[0]?.span;
    expect(span?.relativePath).toBe("Controllers/OrdersController.cs");
    expect(span?.startLine).toBe(expectedLine);
    expect(span?.sourceHash).toBe(
      sha256Hex(fixture("Controllers/OrdersController.cs")),
    );
    expect(edge?.evidence[0]?.analyzerId).toBe("roslyn-worker");
  });

  it("pozitif: CALLS OrdersService.GetById→OrderRepository.GetAll satır eşleşmeli", () => {
    const expectedLine = fixtureLine(
      "Services/OrdersService.cs",
      "_repository.GetAll()",
    );
    const edge = findEdge(
      analyzeResponse,
      (edge) =>
        edge.kind === "CALLS" &&
        edge.from.qualifiedName ===
          "Causoryn.Fixture.Orders.Services.OrdersService.GetById" &&
        edge.to.qualifiedName ===
          "Causoryn.Fixture.Orders.Repositories.OrderRepository.GetAll",
    );
    expect(edge?.resolution).toBe("verified");
    expect(edge?.evidence[0]?.span?.startLine).toBe(expectedLine);
  });

  it("pozitif: CALLS OrdersService.Create→OrderRepository.Save satır eşleşmeli", () => {
    const expectedLine = fixtureLine(
      "Services/OrdersService.cs",
      "_repository.Save(order)",
    );
    const edge = findEdge(
      analyzeResponse,
      (edge) =>
        edge.kind === "CALLS" &&
        edge.from.qualifiedName ===
          "Causoryn.Fixture.Orders.Services.OrdersService.Create" &&
        edge.to.qualifiedName ===
          "Causoryn.Fixture.Orders.Repositories.OrderRepository.Save",
    );
    expect(edge?.resolution).toBe("verified");
    expect(edge?.evidence[0]?.span?.startLine).toBe(expectedLine);
  });

  it("pozitif: CALLS OrdersService.Create→Class Order (new Order)", () => {
    expect(
      findEdge(
        analyzeResponse,
        (edge) =>
          edge.kind === "CALLS" &&
          edge.from.qualifiedName ===
            "Causoryn.Fixture.Orders.Services.OrdersService.Create" &&
          edge.to.kind === "Class" &&
          edge.to.qualifiedName ===
            "Causoryn.Fixture.Orders.Repositories.Order",
      ),
    ).toBeDefined();
  });

  it("pozitif: CALLS OrdersController.Create→OrdersService.Create", () => {
    expect(
      findEdge(
        analyzeResponse,
        (edge) =>
          edge.kind === "CALLS" &&
          edge.from.qualifiedName ===
            "Causoryn.Fixture.Orders.Controllers.OrdersController.Create" &&
          edge.to.qualifiedName ===
            "Causoryn.Fixture.Orders.Services.OrdersService.Create",
      ),
    ).toBeDefined();
  });

  /* ---------------- L3: ROUTES_TO ---------------- */

  it("pozitif: ROUTES_TO GET /api/Orders/{id}→GetById verified + öznitelikler", () => {
    const edge = findEdge(
      analyzeResponse,
      (edge) =>
        edge.kind === "ROUTES_TO" &&
        edge.from.kind === "Endpoint" &&
        edge.from.qualifiedName === "GET /api/Orders/{id}" &&
        edge.to.qualifiedName ===
          "Causoryn.Fixture.Orders.Controllers.OrdersController.GetById",
    );
    expect(edge?.resolution).toBe("verified");
    const endpoint = (analyzeResponse?.nodes ?? []).find(
      (node) =>
        node.kind === "Endpoint" &&
        node.qualifiedName === "GET /api/Orders/{id}",
    );
    expect(endpoint?.attributes.method).toBe("GET");
    expect(endpoint?.attributes.path).toBe("/api/Orders/{id}");
  });

  it("pozitif: ROUTES_TO POST /api/Orders→Create (şablonsuz fiil özniteliği)", () => {
    expect(
      findEdge(
        analyzeResponse,
        (edge) =>
          edge.kind === "ROUTES_TO" &&
          edge.from.qualifiedName === "POST /api/Orders" &&
          edge.to.qualifiedName ===
            "Causoryn.Fixture.Orders.Controllers.OrdersController.Create",
      ),
    ).toBeDefined();
  });

  it("pozitif: ROUTES_TO GET /health→Program.Health (minimal API, verified)", () => {
    const edge = findEdge(
      analyzeResponse,
      (edge) =>
        edge.kind === "ROUTES_TO" &&
        edge.from.kind === "Endpoint" &&
        edge.from.qualifiedName === "GET /health" &&
        edge.to.kind === "Function" &&
        edge.to.qualifiedName === "Program.Health",
    );
    expect(edge?.resolution).toBe("verified");
  });

  it("pozitif: top-level DI çağrıları CALLS üretmiyor (uydurma kenar yok)", () => {
    const diEdges = (analyzeResponse?.edges ?? []).filter(
      (edge) =>
        edge.kind === "CALLS" &&
        edge.to.kind === "UnknownExternal" &&
        /AddScoped|AddControllers|MapControllers|CreateBuilder/.test(
          edge.to.qualifiedName,
        ),
    );
    expect(diEdges).toEqual([]);
  });

  it("pozitif: evidence kayıtları rationale + analyzerVersion taşır", () => {
    for (const evidence of analyzeResponse?.evidence ?? []) {
      expect(evidence.rationale.length).toBeGreaterThan(0);
      expect(evidence.analyzerVersion).toBe(
        analyzeResponse?.worker?.analyzerVersion,
      );
    }
  });

  /* ---------------- Sürüm senkronu (bulgu #8) ---------------- */

  it("sürüm: analyzerVersion csproj <Version> ile senkron", () => {
    expect(csprojVersion).not.toBe("");
    expect(analyzeResponse?.worker?.analyzerVersion).toBe(csprojVersion);
  });

  /* ---------------- Negatif: istek düzeyi reddiyeler ---------------- */

  it("negatif: files [] ve eksik files → INVALID_ARGUMENT", () => {
    expect(negativeById["neg-empty-files"]?.status).toBe("error");
    expect(negativeById["neg-empty-files"]?.error?.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(negativeById["neg-missing-files"]?.status).toBe("error");
    expect(negativeById["neg-missing-files"]?.error?.code).toBe(
      "INVALID_ARGUMENT",
    );
  });

  it("negatif: '..' segmenti ve mutlak yol → INVALID_ARGUMENT", () => {
    expect(negativeById["neg-dotdot"]?.error?.code).toBe("INVALID_ARGUMENT");
    expect(negativeById["neg-absolute-path"]?.error?.code).toBe(
      "INVALID_ARGUMENT",
    );
  });

  it("negatif: duplicate path → INVALID_ARGUMENT", () => {
    expect(negativeById["neg-duplicate"]?.error?.code).toBe(
      "INVALID_ARGUMENT",
    );
  });

  it("negatif: bilinmeyen üst-düzey alan strict reddi → INVALID_ARGUMENT", () => {
    expect(negativeById["neg-unknown-field"]?.error?.code).toBe(
      "INVALID_ARGUMENT",
    );
  });

  it("negatif: files[] girdisinde bilinmeyen alan strict reddi → INVALID_ARGUMENT", () => {
    expect(negativeById["neg-file-unknown-field"]?.error?.code).toBe(
      "INVALID_ARGUMENT",
    );
  });

  it("negatif: id eksik → INVALID_ARGUMENT", () => {
    expect(negativeById["(id-yok)"]?.status).toBe("error");
    expect(negativeById["(id-yok)"]?.error?.code).toBe("INVALID_ARGUMENT");
  });

  it("negatif: bilinmeyen type ve protocolVersion → INVALID_ARGUMENT", () => {
    expect(negativeById["neg-unknown-type"]?.error?.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(negativeById["neg-bad-version"]?.error?.code).toBe(
      "INVALID_ARGUMENT",
    );
  });

  it("negatif: bozuk JSON → id null hata yanıtı; worker yaşamaya devam eder", () => {
    expect(malformed.lines.length).toBe(2);
    const malformedResponse = parseLine(malformed.lines[0] ?? "");
    expect(malformedResponse.status).toBe("error");
    expect(malformedResponse.id).toBeNull();
    const survivor = parseLine(malformed.lines[1] ?? "");
    expect(survivor.id).toBe("fixture-orders-1");
    expect(survivor.status).toBe("ready");
  });

  /* ---------------- Kaynak sınırları (bulgu #3) ---------------- */

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

  /* ---------------- AST derinlik savunması (bulgu #4) ---------------- */

  it("derinlik: 5000 katmanlı ifade worker'ı çökertmez, ADAPTER_INTERNAL tanısı üretir", () => {
    expect(depthRun.exitCode).toBe(0);
    expect(depthRun.lines.length).toBe(1);
    const response = parseLine(depthRun.lines[0] ?? "");
    expect(response.status).toBe("partial");
    // İki guard katmanı da tanı üretir: derleme tanı aşaması guard'ı
    // (satır bilinmiyorsa 0) ve VisitNode gezinme guard'ı (gerçek satır).
    const depthDiag = (response.diagnostics ?? []).find(
      (diag) => diag.code === "ADAPTER_INTERNAL" && diag.line > 0,
    );
    expect(depthDiag).toBeDefined();
    expect(depthDiag?.relativePath).toBe("Deep/Deep.cs");
    expect(depthDiag?.message).toContain("derin");
  });

  /* ---------------- Partial ---------------- */

  it("partial: sözdizimi hatası → status partial + dosya/satırlı tanı", () => {
    expect(partialResponse?.status).toBe("partial");
    expect(
      (partialResponse?.diagnostics ?? []).some(
        (diag) => diag.relativePath === "Broken/Broken.cs" && diag.line >= 1,
      ),
    ).toBe(true);
  });

  /* ---------------- Determinizm ---------------- */

  it("determinizm: aynı girdi → birebir aynı yanıt satırı", () => {
    expect(determinismLine).toBe(analyzeLine);
  });
});

/* ------------------------------------------------------------------ */
/* Bootstrap davranışı (denetim bulgusu düzeltmesi — gerçek IO'suz)    */
/* ------------------------------------------------------------------ */

describe("bootstrapWorkerBinary (derleme regresyonu disiplini)", () => {
  it("build başarısızlığında explicit Error throw eder — sessiz skip yok", () => {
    expect(() =>
      bootstrapWorkerBinary({
        dotnetAvailable: true,
        dllExists: () => true,
        runBuild: () => ({ status: 1, stderr: "error CS0001: test hatası" }),
      }),
    ).toThrowError(/worker derlemesi başarısız/);
  });

  it("derleme 'başarılı' ama DLL yoksa throw eder", () => {
    expect(() =>
      bootstrapWorkerBinary({
        dotnetAvailable: true,
        dllExists: () => false,
        runBuild: () => ({ status: 0 }),
      }),
    ).toThrowError(/DLL çıktısı yok/);
  });

  it("dotnet yokken meşru skip: workerReady=false, skipReason dolu, build ÇAĞRILMAZ", () => {
    let buildCalls = 0;
    const result = bootstrapWorkerBinary({
      dotnetAvailable: false,
      dllExists: () => true,
      runBuild: () => {
        buildCalls += 1;
        return { status: 0 };
      },
    });
    expect(result.workerReady).toBe(false);
    expect(result.skipReason).toContain("dotnet");
    expect(buildCalls).toBe(0);
  });

  it("başarılı derleme + DLL → workerReady=true, skipReason yok", () => {
    const result = bootstrapWorkerBinary({
      dotnetAvailable: true,
      dllExists: () => true,
      runBuild: () => ({ status: 0 }),
    });
    expect(result.workerReady).toBe(true);
    expect(result.skipReason).toBeNull();
  });
});
