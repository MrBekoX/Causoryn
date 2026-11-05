/**
 * Cross-boundary entegrasyon testi — sprint-2 B8 (TŞ v2.1 §7, §9, §23/4).
 *
 * Sprint kapısı kriterleri (wiki/sprint-2.md B8):
 *  1. TS adapter (fixture-ts-orders) VE csharp-roslyn adapter
 *     (fixture-csharp-orders, GERÇEK dotnet worker spawn) çıktıları
 *     packages/domain sözleşmelerine (createSnapshot girdisi + SnapshotSchema)
 *     doğrulanır.
 *  2. Her iki dilde endpoint → service → repository kanıt zinciri, evidence
 *     satır İÇERİKLERİYLE (fixture diskten okunarak) doğrulanır:
 *     span.sourceHash = sha256(disk içeriği) ve span.startLine satırı
 *     beklenen çağrı/kayıt metnini içerir.
 *  3. İki dilin çıktısı TEK GraphRepository snapshot'ına beslenir: dangling
 *     edge yok; iki bağımsız kurulum aynı canonical JSON'ı üretir (TŞ §8
 *     invariant vi).
 *  4. Degradasyon: worker yoksa motor ÇÖKMEZ — L0/L1 fallback uçtan uca
 *     (adapter → repository publish) kanıtlanır; coverage explicitly
 *     raporlanır (B2 fallback'inin B8 uçtan uca doğrulaması).
 *  5. Stale: yeni snapshot yayımlanınca eski snapshot stale=true ile ID'den
 *     sorgulanabilir (TŞ §9; sprint kapısı kriteri 2).
 *
 * Güvenlik notu (proje kırmızı çizgisi 6): dotnet koşumları spawnSync ile
 * LİTERAL "dotnet" + ARGÜMAN DİZİSİ ve shell: false ile yapılır; worker DLL
 * yolu repo içi SABİT constant'tır; girdi asla komut satırına interpole
 * edilmez. Testler salt okunurdur: fixture diskten okunur, depoya hiçbir
 * şey yazılmaz (ADR-008); repository bellek içidir.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRoslynWorkerBinary } from "./roslyn-worker-build.js";

import {
  createEdge,
  createSnapshot,
  evidenceId,
  nodeId,
  sha256Hex,
  SnapshotSchema,
  snapshotCanonicalJson,
  utf8Encode,
  type Evidence,
  type GraphNode,
  type NodeRef,
  type SnapshotEdgeInput,
  type SnapshotEvidenceInput,
  type SnapshotGraph,
  type SnapshotNodeInput,
} from "@causoryn/domain";
import { InMemoryGraphRepository } from "@causoryn/graph";
import {
  analyzeTypeScriptProgram,
  type TypeScriptAdapterResult,
} from "@causoryn/adapter-typescript";
/**
 * Not: @causoryn/adapter-csharp-roslyn sprint-2'de eklendiği için kök
 * package-lock ve node_modules linki henüz yok (npm install orkestratör
 * yetkisindedir); repo konvansiyonu olan göreli src import'u kullanılır
 * (adapter test klasörleriyle aynı çözümleme yolu).
 */
import {
  analyzeCSharpWorkspace,
  type RoslynAdapterResult,
} from "../adapters/csharp-roslyn/src/index.js";

/* ------------------------------------------------------------------ */
/* Sabitler                                                            */
/* ------------------------------------------------------------------ */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = join(REPO_ROOT, "native", "roslyn-worker");
const WORKER_DLL = join(
  WORKER_DIR,
  "bin",
  "Debug",
  "net10.0",
  "Causoryn.RoslynWorker.dll",
);
const TS_FIXTURE_DIR = join(REPO_ROOT, "examples", "fixture-ts-orders");
const CS_FIXTURE_DIR = join(REPO_ROOT, "examples", "fixture-csharp-orders");

/** Domain saat okumaz: deterministik sabit zaman damgaları (TŞ §8 invariant vi). */
const FIXED_CREATED_AT = "2026-11-05T00:00:00.000Z";
const FIXED_PUBLISHED_AT = "2026-11-05T00:00:05.000Z";
const FIXED_CONFIG_HASH = "cross-boundary-b8-config";
const UNIFIED_WORKSPACE_ID = "w-crossboundary-b8";

/* ------------------------------------------------------------------ */
/* Salt-okunur fixture erişimi                                          */
/* ------------------------------------------------------------------ */

interface FixtureFile {
  readonly relativePath: string;
  readonly content: string;
  readonly sourceHash: string;
}

/** Uzantıya göre özyinelemeli, deterministik sıralı fixture envanteri.
 *  `baseDir` mutlak dizindir; `prefix` workspace-relative POSIX yol önekidir.
 *  Girdi yalnızca readdir çıktısından türetilir (kullanıcı girdisi yok). */
function collectFixtureFiles(
  baseDir: string,
  extension: string,
  prefix = "",
): FixtureFile[] {
  const out: FixtureFile[] = [];
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolutePath = resolve(baseDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFixtureFiles(absolutePath, extension, relativePath));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      const content = readFileSync(absolutePath, "utf8");
      out.push({
        relativePath,
        content,
        sourceHash: sha256Hex(utf8Encode(content)),
      });
    }
  }
  return out.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/* Bootstrap: worker binary (B1/B2 ile aynı disiplin)                   */
/* ------------------------------------------------------------------ */

/**
 * Derleme sonucu KONTROL EDİLİR: dotnet mevcutken build her turda koşturulur
 * (incremental); başarısız derleme explicit Error → suite FAIL. Skip YALNIZCA
 * dotnet bulunamadığında meşrudur (koşulamadı raporu; B1 bootstrap kuralı).
 */
const dotnetCheck = spawnSync("dotnet", ["--version"], {
  encoding: "utf8",
  shell: false,
});
const workerReady = dotnetCheck.status === 0;

if (!workerReady) {
  console.error(
    "[cross-boundary] dotnet SDK bulunamadı — C# worker blokları koşulamadı (çalıştırılamadı olarak raporlanır)",
  );
}

beforeAll(
  () => {
    if (!workerReady) return;
    // Build serileştirme: roslyn-worker.test.ts ve csharp-roslyn-adapter
    // paralel fork'larda aynı `dotnet build` çağrısını yapar; eşzamanlı
    // MSBuild obj/ ara DLL'ine yarışır (CS2012 → exit=1, bizzat yeniden
    // üretildi) ve kaybeden suite FAIL'e düşer. Ortak kilitli builder:
    // komut/parametreler aynı, yalnızca yarış kaldırılır.
    const build = buildRoslynWorkerBinary();
    if (build.status !== 0 || !existsSync(WORKER_DLL)) {
      // MSBuild hataları stdout'a yazılır; gerçek neden gizlenmesin.
      throw new Error(
        `worker derlemesi başarısız (exit=${String(build.status)}) — B8 testleri eski binary'ye karşı koşulmaz` +
          (build.stderr ? ` [stderr]: ${build.stderr.slice(0, 400)}` : "") +
          (build.stdout ? ` [stdout]: ${build.stdout.slice(-400)}` : ""),
      );
    }
  },
  360_000,
);

/* ------------------------------------------------------------------ */
/* Adapter koşumları                                                    */
/* ------------------------------------------------------------------ */

const tsFixture = collectFixtureFiles(TS_FIXTURE_DIR, ".ts");
const csFixture = collectFixtureFiles(CS_FIXTURE_DIR, ".cs");

function runTsAdapter(workspaceId: string): TypeScriptAdapterResult {
  return analyzeTypeScriptProgram({
    workspaceId,
    rootDir: TS_FIXTURE_DIR,
    sources: tsFixture.map((file) => ({
      relativePath: file.relativePath,
      content: file.content,
    })),
  });
}

function runCsAdapter(workspaceId: string): Promise<RoslynAdapterResult> {
  return analyzeCSharpWorkspace({
    workspaceId,
    files: csFixture.map((file) => ({
      path: file.relativePath,
      content: file.content,
    })),
  });
}

/* ------------------------------------------------------------------ */
/* Kanıt zinciri doğrulama yardımcıları                                 */
/* ------------------------------------------------------------------ */

interface EdgeQuery {
  readonly kind: SnapshotEdgeInput["kind"];
  readonly fromQualifiedName: string;
  readonly toQualifiedName: string;
}

function findChainEdge(
  edges: readonly SnapshotEdgeInput[],
  query: EdgeQuery,
): SnapshotEdgeInput {
  const hit = edges.find(
    (edge) =>
      edge.kind === query.kind &&
      edge.from.qualifiedName === query.fromQualifiedName &&
      edge.to.qualifiedName === query.toQualifiedName,
  );
  expect(
    hit,
    `kenar bulunamadı: ${query.kind} ${query.fromQualifiedName} → ${query.toQualifiedName}`,
  ).toBeDefined();
  return hit as SnapshotEdgeInput;
}

/**
 * Zincir kanıtı (B8 kriteri 2): kenar verified, ≥1 kanıt; kanıt span'inin
 * sourceHash'i DISKTEN okunan dosya karmasıyla birebir; span.startLine
 * satırı beklenen metni içerir (satır içerik doğrulaması).
 */
function assertCitesFileLine(
  edge: SnapshotEdgeInput,
  files: ReadonlyMap<string, FixtureFile>,
  analyzerId: string,
  needle: string,
): void {
  expect(edge.resolution, "zincir kenarı verified olmalı").toBe("verified");
  const evidence = edge.evidence ?? [];
  expect(evidence.length, "verified kenar ≥1 kanıt (TŞ §8 invariant i)").toBeGreaterThan(0);
  const withSpan = evidence.find((item) => item.span !== undefined);
  expect(withSpan, "kanıtta SourceSpan yok").toBeDefined();
  const span = withSpan?.span;
  if (span === undefined) return;

  const file = files.get(span.relativePath);
  expect(file, `span dosyası envanterde değil: ${span.relativePath}`).toBeDefined();
  // Kanıt karması = sha256(diskten okunan gerçek dosya içeriği).
  expect(span.sourceHash).toBe(file?.sourceHash);

  const lines = (file?.content ?? "").split("\n");
  const lineText = lines[span.startLine - 1];
  expect(
    lineText?.includes(needle),
    `${span.relativePath}:${String(span.startLine)} satırı '${needle}' içermeli ama: ${lineText ?? "(satır yok)"}`,
  ).toBe(true);
  expect(withSpan?.analyzerId).toBe(analyzerId);
  expect(withSpan?.rationale.length).toBeGreaterThan(0);
}

/* ------------------------------------------------------------------ */
/* Birleşik snapshot inşası (IndexService.runPipeline kongresiyle aynı)  */
/* ------------------------------------------------------------------ */

interface AdapterOutput {
  readonly state: "ready" | "partial";
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly nodes: readonly SnapshotNodeInput[];
  readonly edges: readonly SnapshotEdgeInput[];
  readonly evidence: readonly SnapshotEvidenceInput[];
}

function nodeRefKey(ref: NodeRef): string {
  // Domain node kimlik anahtarı (snapshot.ts nodeKey ile aynı alan üçlüsü).
  return `${ref.kind}\u0000${ref.qualifiedName}\u0000${ref.relativePath ?? "\u0000"}`;
}

/** attributes JSON uyumluluk denetimi (canonical JSON'a yazılabilir olmalı). */
function assertJsonValue(value: unknown): void {
  const walk = (node: unknown): void => {
    if (node === null) return;
    const type = typeof node;
    if (type === "string" || type === "boolean") return;
    if (type === "number") {
      expect(Number.isFinite(node), "attributes sonlu olmayan sayı içeremez").toBe(true);
      return;
    }
    if (type === "object") {
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      const record = node as Record<string, unknown>;
      for (const child of Object.values(record)) walk(child);
      return;
    }
    throw new Error(`Snapshot JSON'e serileştirilemez değer: ${type}`);
  };
  walk(value);
}

function toGraphNode(
  workspaceId: string,
  input: SnapshotNodeInput,
  sourceHashByPath: ReadonlyMap<string, string>,
): GraphNode {
  const relativePath = input.relativePath;
  const location =
    relativePath === undefined
      ? undefined
      : {
          relativePath,
          startLine: 1,
          endLine: 1,
          sourceHash: sourceHashByPath.get(relativePath) ?? "",
        };
  if (location !== undefined && location.sourceHash.length === 0) {
    throw new Error(
      `adapter node'u envanterde olmayan dosyaya işaret ediyor: ${relativePath}`,
    );
  }
  return {
    id: nodeId({
      workspaceId,
      kind: input.kind,
      qualifiedName: input.qualifiedName,
      ...(input.relativePath === undefined ? {} : { relativePath: input.relativePath }),
    }),
    kind: input.kind,
    qualifiedName: input.qualifiedName,
    ...(input.language === undefined ? {} : { language: input.language }),
    ...(location === undefined ? {} : { location }),
    attributes: { ...(input.attributes ?? {}) },
  };
}

function toEvidence(workspaceId: string, input: SnapshotEvidenceInput): Evidence {
  return {
    id: evidenceId({
      workspaceId,
      kind: input.kind,
      ...(input.span === undefined ? {} : { span: input.span }),
      analyzerId: input.analyzerId,
      analyzerVersion: input.analyzerVersion,
      rationale: input.rationale,
    }),
    kind: input.kind,
    ...(input.span === undefined ? {} : { span: { ...input.span } }),
    analyzerId: input.analyzerId,
    analyzerVersion: input.analyzerVersion,
    rationale: input.rationale,
  };
}

interface UnifiedSetup {
  readonly repository: InMemoryGraphRepository;
  readonly snapshot: SnapshotGraph;
}

/** Kayıtlı workspace taşıyan boş birleşik repository (stale testi paylaşır). */
function createUnifiedRepository(): InMemoryGraphRepository {
  const repository = new InMemoryGraphRepository();
  repository.registerWorkspace({
    id: UNIFIED_WORKSPACE_ID,
    rootPath: REPO_ROOT.replace(/\\/g, "/"),
    createdAt: FIXED_CREATED_AT,
  });
  return repository;
}

/**
 * İki dilin çıktısını TEK GraphRepository build'ine besler (TŞ §9 atomik
 * publish kongresi: registerWorkspace → beginBuild → add* → publish).
 * Workspace node + Workspace→File CONTAINS kenarları IndexService kuralıyla
 * eklenir; kenar uçları node haritasından çözülür (dangling yok).
 * `target` verilirse AYNI repository'ye ikinci revizyon yayımlanır (stale).
 */
function publishUnifiedSnapshot(
  outputs: readonly AdapterOutput[],
  revisionSequence: number,
  target?: InMemoryGraphRepository,
): UnifiedSetup {
  const repository = target ?? createUnifiedRepository();
  const build = repository.beginBuild({
    workspaceId: UNIFIED_WORKSPACE_ID,
    revision: { id: "cross-boundary", sequence: revisionSequence },
    configHash: FIXED_CONFIG_HASH,
    analyzerFingerprint: "cross-boundary-b8@0.1.0",
    createdAt: FIXED_CREATED_AT,
  });

  // Envanter karmaları: node.location.sourceHash kongresi (IndexService ile aynı).
  const sourceHashByPath = new Map<string, string>(
    [...tsFixture, ...csFixture].map((file) => [file.relativePath, file.sourceHash]),
  );

  // 1) Workspace node (her zaman).
  const workspaceNode: GraphNode = {
    id: nodeId({
      workspaceId: UNIFIED_WORKSPACE_ID,
      kind: "Workspace",
      qualifiedName: UNIFIED_WORKSPACE_ID,
    }),
    kind: "Workspace",
    qualifiedName: UNIFIED_WORKSPACE_ID,
    attributes: {},
  };
  repository.addNode(build.buildId, workspaceNode);

  // 2) Adapter node'ları (iki dil tek kimlik haritasında).
  const nodeByKey = new Map<string, GraphNode>();
  for (const output of outputs) {
    for (const nodeInput of output.nodes) {
      const key = nodeRefKey(nodeInput);
      if (nodeByKey.has(key)) {
        throw new Error(`iki dil aynı node kimliğini üretti: ${key}`);
      }
      const node = toGraphNode(UNIFIED_WORKSPACE_ID, nodeInput, sourceHashByPath);
      nodeByKey.set(key, node);
      repository.addNode(build.buildId, node);
    }
  }

  // 3) Kanıtlar + kenarlar (uçlar node haritasından çözülür).
  for (const output of outputs) {
    for (const edgeInput of output.edges) {
      const from = nodeByKey.get(nodeRefKey(edgeInput.from));
      const to = nodeByKey.get(nodeRefKey(edgeInput.to));
      if (from === undefined || to === undefined) {
        const missing = from === undefined ? edgeInput.from : edgeInput.to;
        throw new Error(`adapter kenarı bilinmeyen node'a işaret ediyor: ${nodeRefKey(missing)}`);
      }
      const evidenceIds: string[] = [];
      for (const evidenceInput of edgeInput.evidence ?? []) {
        const evidence = toEvidence(UNIFIED_WORKSPACE_ID, evidenceInput);
        repository.addEvidence(build.buildId, evidence);
        evidenceIds.push(evidence.id);
      }
      repository.addEdge(
        build.buildId,
        createEdge({
          workspaceId: UNIFIED_WORKSPACE_ID,
          kind: edgeInput.kind,
          from: from.id,
          to: to.id,
          resolution: edgeInput.resolution,
          evidenceIds,
          ...(edgeInput.ambiguity === undefined
            ? {}
            : {
                ambiguity: {
                  candidates: [...edgeInput.ambiguity.candidates],
                  reason: edgeInput.ambiguity.reason,
                },
              }),
        }),
      );
    }
    for (const evidenceInput of output.evidence) {
      repository.addEvidence(build.buildId, toEvidence(UNIFIED_WORKSPACE_ID, evidenceInput));
    }
  }

  // 4) CONTAINS: Workspace → her File node (envanter kanıtlı; IndexService kuralı).
  for (const output of outputs) {
    for (const nodeInput of output.nodes) {
      if (nodeInput.kind !== "File" || nodeInput.relativePath === undefined) continue;
      const fileNode = nodeByKey.get(nodeRefKey(nodeInput));
      const sourceHash = sourceHashByPath.get(nodeInput.relativePath);
      if (fileNode === undefined || sourceHash === undefined) {
        throw new Error(`File node envanterle eşleşmedi: ${nodeInput.relativePath}`);
      }
      const inventoryInput: SnapshotEvidenceInput = {
        kind: "inventory",
        span: {
          relativePath: nodeInput.relativePath,
          startLine: 1,
          endLine: 1,
          sourceHash,
        },
        analyzerId: "causoryn-crossboundary-b8",
        analyzerVersion: "0.1.0",
        rationale: "cross-boundary envanter: iki dilin kaynak dosya envanteri",
      };
      const inventoryEvidence = toEvidence(UNIFIED_WORKSPACE_ID, inventoryInput);
      repository.addEvidence(build.buildId, inventoryEvidence);
      repository.addEdge(
        build.buildId,
        createEdge({
          workspaceId: UNIFIED_WORKSPACE_ID,
          kind: "CONTAINS",
          from: workspaceNode.id,
          to: fileNode.id,
          resolution: "verified",
          evidenceIds: [inventoryEvidence.id],
        }),
      );
    }
  }

  // 5) Durum: her iki dil ready değilse partial (en zayıf halka kuralı).
  const state = outputs.every((output) => output.state === "ready") ? "ready" : "partial";
  const snapshot = repository.publish(build.buildId, state, FIXED_PUBLISHED_AT);
  return { repository, snapshot };
}

function toAdapterOutput(result: TypeScriptAdapterResult | RoslynAdapterResult): AdapterOutput {
  return {
    state: result.state,
    analyzerId: result.analyzerId,
    analyzerVersion: result.analyzerVersion,
    nodes: result.nodes,
    edges: result.edges,
    // TS adapter kanıtları yalnızca kenar içi taşır; üst düzey evidence
    // yalnızca Roslyn worker çıktısında vardır (PROTOCOL.md v1).
    evidence: "evidence" in result ? result.evidence : [],
  };
}

/* ------------------------------------------------------------------ */
/* B8/1a — TypeScript zinciri (fixture-ts-orders)                       */
/* ------------------------------------------------------------------ */

describe("B8 cross-boundary: TS zinciri (fixture-ts-orders)", () => {
  const tsResult = runTsAdapter("w-crossboundary-ts");
  const files = new Map(tsFixture.map((file) => [file.relativePath, file]));
  const TS_ANALYZER_ID = "ts-adapter";

  it("adapter ready döner ve çıktı createSnapshot (domain sözleşmesi) ile tüketilir", () => {
    expect(tsResult.state).toBe("ready");
    expect(tsResult.diagnostics).toEqual([]);
    // Domain sözleşmesi: createSnapshot girdisi — invariant'lar kurucuda zorlanır.
    const snapshot = createSnapshot({
      workspaceId: "w-crossboundary-ts",
      revision: { id: "b8-ts", sequence: 1 },
      configHash: FIXED_CONFIG_HASH,
      analyzerFingerprint: `${tsResult.analyzerId}@${tsResult.analyzerVersion}`,
      state: tsResult.state,
      createdAt: FIXED_CREATED_AT,
      nodes: tsResult.nodes,
      edges: tsResult.edges,
    });
    for (const attribute of snapshot.nodes.map((node) => node.attributes)) {
      assertJsonValue(attribute);
    }
    expect(snapshot.edges.length).toBe(tsResult.edges.length);
    expect(snapshot.nodes.length).toBe(tsResult.nodes.length);
    // SnapshotSchema savunma katmanı: yayımlanabilir biçim TŞ §8 şemasına uyar.
    expect(SnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it("ROUTES_TO: POST /orders Endpoint → ordersRoute Handler; kanıt route kayıt satırını içerir", () => {
    const edge = findChainEdge(tsResult.edges, {
      kind: "ROUTES_TO",
      fromQualifiedName: "POST /orders",
      toQualifiedName: "ordersRoute",
    });
    assertCitesFileLine(edge, files, TS_ANALYZER_ID, 'router.post("/orders"');
  });

  it("CALLS: createOrdersRoute → OrdersService.create; kanıt çağrı satırını içerir", () => {
    const edge = findChainEdge(tsResult.edges, {
      kind: "CALLS",
      fromQualifiedName: "createOrdersRoute",
      toQualifiedName: "OrdersService.create",
    });
    assertCitesFileLine(edge, files, TS_ANALYZER_ID, "ordersService.create(");
  });

  it("CALLS: OrdersService.create → OrderRepository.save; kanıt çağrı satırını içerir", () => {
    const edge = findChainEdge(tsResult.edges, {
      kind: "CALLS",
      fromQualifiedName: "OrdersService.create",
      toQualifiedName: "OrderRepository.save",
    });
    assertCitesFileLine(edge, files, TS_ANALYZER_ID, "this.repository.save(");
  });
});

/* ------------------------------------------------------------------ */
/* B8/1b — C# zinciri (fixture-csharp-orders, gerçek worker spawn)      */
/* ------------------------------------------------------------------ */

describe.skipIf(!workerReady)(
  "B8 cross-boundary: C# zinciri (fixture-csharp-orders, gerçek Roslyn worker)",
  () => {
    let csResult: RoslynAdapterResult | null = null;
    const files = new Map(csFixture.map((file) => [file.relativePath, file]));

    beforeAll(
      async () => {
        csResult = await runCsAdapter("w-crossboundary-cs");
      },
      120_000,
    );

    it("worker sağlıklı: ready + coverage 1; çıktı createSnapshot (domain sözleşmesi) ile tüketilir", () => {
      expect(csResult?.workerAvailable).toBe(true);
      expect(csResult?.state).toBe("ready");
      expect(csResult?.coverageRatio).toBe(1);
      const snapshot = createSnapshot({
        workspaceId: "w-crossboundary-cs",
        revision: { id: "b8-cs", sequence: 1 },
        configHash: FIXED_CONFIG_HASH,
        analyzerFingerprint: `${csResult?.analyzerId ?? "roslyn-worker"}@${csResult?.analyzerVersion ?? "0.1.0"}`,
        state: csResult?.state === "partial" ? "partial" : "ready",
        createdAt: FIXED_CREATED_AT,
        nodes: csResult?.nodes ?? [],
        edges: csResult?.edges ?? [],
        evidence: csResult?.evidence ?? [],
      });
      expect(snapshot.edges.length).toBe(csResult?.edges.length ?? -1);
      expect(SnapshotSchema.safeParse(snapshot).success).toBe(true);
    });

    it("ROUTES_TO: POST /api/Orders → OrdersController.Create; kanıt [HttpPost] satırını içerir", () => {
      const edge = findChainEdge(csResult?.edges ?? [], {
        kind: "ROUTES_TO",
        fromQualifiedName: "POST /api/Orders",
        toQualifiedName: "Causoryn.Fixture.Orders.Controllers.OrdersController.Create",
      });
      assertCitesFileLine(edge, files, "roslyn-worker", "[HttpPost]");
    });

    it("ROUTES_TO: GET /api/Orders/{id} → OrdersController.GetById; kanıt [HttpGet] satırını içerir", () => {
      const edge = findChainEdge(csResult?.edges ?? [], {
        kind: "ROUTES_TO",
        fromQualifiedName: "GET /api/Orders/{id}",
        toQualifiedName: "Causoryn.Fixture.Orders.Controllers.OrdersController.GetById",
      });
      assertCitesFileLine(edge, files, "roslyn-worker", '[HttpGet("{id}")]');
    });

    it("CALLS: OrdersController.Create → OrdersService.Create; kanıt çağrı satırını içerir", () => {
      const edge = findChainEdge(csResult?.edges ?? [], {
        kind: "CALLS",
        fromQualifiedName: "Causoryn.Fixture.Orders.Controllers.OrdersController.Create",
        toQualifiedName: "Causoryn.Fixture.Orders.Services.OrdersService.Create",
      });
      assertCitesFileLine(edge, files, "roslyn-worker", "_ordersService.Create(input)");
    });

    it("CALLS: OrdersService.Create → OrderRepository.Save; kanıt çağrı satırını içerir", () => {
      const edge = findChainEdge(csResult?.edges ?? [], {
        kind: "CALLS",
        fromQualifiedName: "Causoryn.Fixture.Orders.Services.OrdersService.Create",
        toQualifiedName: "Causoryn.Fixture.Orders.Repositories.OrderRepository.Save",
      });
      assertCitesFileLine(edge, files, "roslyn-worker", "_repository.Save(order)");
    });

    it("interface + implementation: IOrderRepository Interface node'u, OrderRepository onu gerçekler", () => {
      // Graph düzeyi: Interface node + CONTAINS File → Interface (verified).
      const interfaceNode = (csResult?.nodes ?? []).find(
        (node) =>
          node.kind === "Interface" &&
          node.qualifiedName === "Causoryn.Fixture.Orders.Repositories.IOrderRepository",
      );
      expect(interfaceNode, "IOrderRepository Interface node'u üretilmeli").toBeDefined();
      const contains = (csResult?.edges ?? []).find(
        (edge) =>
          edge.kind === "CONTAINS" &&
          edge.resolution === "verified" &&
          edge.from.qualifiedName === "Repositories/OrderRepository.cs" &&
          edge.to.qualifiedName ===
            "Causoryn.Fixture.Orders.Repositories.IOrderRepository",
      );
      expect(contains, "File → IOrderRepository CONTAINS kenarı yok").toBeDefined();
      // Kaynak düzeyi (diskten okuma): interface bildirimi + implementation bağı.
      const repositorySource = files.get("Repositories/OrderRepository.cs");
      expect(repositorySource?.content).toContain("public interface IOrderRepository");
      expect(repositorySource?.content).toContain(
        "public class OrderRepository : IOrderRepository",
      );
    });
  },
);

/* ------------------------------------------------------------------ */
/* B8/3 — Birleşik snapshot: TEK GraphRepository, dangling yok, determinizm */
/* ------------------------------------------------------------------ */

describe.skipIf(!workerReady)(
  "B8 cross-boundary: birleşik snapshot (tek GraphRepository)",
  () => {
    let first: UnifiedSetup | null = null;
    let firstCanonical = "";
    let secondCanonical = "";

    beforeAll(
      async () => {
        // Kurulum 1 ve 2: bağımsız adapter koşumları + bağımsız repository.
        // Domain saat okumadığı ve girdiler sabit olduğu için iki kurulumun
        // canonical JSON'ı birebir eşit olmalıdır (TŞ §8 invariant vi).
        const tsA = runTsAdapter(UNIFIED_WORKSPACE_ID);
        const csA = await runCsAdapter(UNIFIED_WORKSPACE_ID);
        first = publishUnifiedSnapshot([toAdapterOutput(tsA), toAdapterOutput(csA)], 1);
        firstCanonical = snapshotCanonicalJson(first.snapshot);

        const tsB = runTsAdapter(UNIFIED_WORKSPACE_ID);
        const csB = await runCsAdapter(UNIFIED_WORKSPACE_ID);
        const second = publishUnifiedSnapshot([toAdapterOutput(tsB), toAdapterOutput(csB)], 1);
        secondCanonical = snapshotCanonicalJson(second.snapshot);
      },
      300_000,
    );

    it("publish atomik: snapshot ready yayımlandı ve TŞ §8 şemasından geçer", () => {
      expect(first?.snapshot.meta.state).toBe("ready");
      expect(SnapshotSchema.safeParse(first?.snapshot).success).toBe(true);
      const latest = first?.repository.getLatestPublished(UNIFIED_WORKSPACE_ID);
      expect(latest?.snapshot.meta.id).toBe(first?.snapshot.meta.id);
      expect(latest?.stale).toBe(false);
    });

    it("dangling edge yok: her kenar ucu node kümesinde (TŞ §8 invariant ii)", () => {
      const nodeIds = new Set(first?.snapshot.nodes.map((node) => node.id));
      expect(nodeIds.size).toBeGreaterThan(0);
      for (const edge of first?.snapshot.edges ?? []) {
        expect(nodeIds.has(edge.from), `dangling from: ${edge.id}`).toBe(true);
        expect(nodeIds.has(edge.to), `dangling to: ${edge.id}`).toBe(true);
      }
      // verified kenarların tamamı ≥1 kanıt taşır (TŞ §8 invariant i).
      for (const edge of first?.snapshot.edges ?? []) {
        if (edge.resolution !== "verified") continue;
        expect(edge.evidenceIds.length).toBeGreaterThan(0);
      }
    });

    it("birleşik snapshot'ta iki dilin zinciri bir arada: POST /orders (TS) ve POST /api/Orders (C#)", () => {
      const byId = new Map(first?.snapshot.nodes.map((node) => [node.id, node]));
      const routes = (first?.snapshot.edges ?? []).filter(
        (edge) => edge.kind === "ROUTES_TO",
      );
      const endpoints = routes
        .map((edge) => byId.get(edge.from)?.qualifiedName ?? "")
        .sort();
      expect(endpoints).toContain("POST /orders");
      expect(endpoints).toContain("POST /api/Orders");
      // İki dilin CALLS katmanı da tek snapshot'ta; hedefler ayrı node'lardır.
      const calls = (first?.snapshot.edges ?? []).filter((edge) => edge.kind === "CALLS");
      const callTargets = calls.map((edge) => byId.get(edge.to)?.qualifiedName ?? "");
      expect(callTargets).toContain("OrdersService.create");
      expect(callTargets).toContain("Causoryn.Fixture.Orders.Services.OrdersService.Create");
      expect(callTargets).toContain("OrderRepository.save");
      expect(callTargets).toContain(
        "Causoryn.Fixture.Orders.Repositories.OrderRepository.Save",
      );
    });

    it("determinizm: iki bağımsız kurulum aynı canonical JSON (TŞ §8 invariant vi)", () => {
      expect(firstCanonical.length).toBeGreaterThan(0);
      expect(firstCanonical).toBe(secondCanonical);
    });
  },
);

/* ------------------------------------------------------------------ */
/* B8/4 — Degradasyon: worker yoksa motor çökmez + explicit coverage    */
/* ------------------------------------------------------------------ */

describe("B8 cross-boundary: degradasyon (worker yok → L0/L1, motor ayakta)", () => {
  let fallback: RoslynAdapterResult | null = null;
  let degraded: UnifiedSetup | null = null;

  beforeAll(
    async () => {
      // Worker yok senaryosu: olmayan DLL yolu (config kuralı; spawn sabit
      // komut + sabit argüman dizisi, yalnızca yol config'den farklı).
      fallback = await analyzeCSharpWorkspace({
        workspaceId: "w-crossboundary-degraded",
        files: csFixture.map((file) => ({
          path: file.relativePath,
          content: file.content,
        })),
        options: {
          workerDllPath: join(WORKER_DIR, "bin", "Debug", "net10.0", "olmayan-worker.dll"),
          requestTimeoutMs: 30_000,
        },
      });
      // Uçtan uca (B2 fallback'inin B8 doğrulaması): fallback çıktısı
      // repository publish kongresine beslenir — motor çökmez.
      degraded = publishUnifiedSnapshot([toAdapterOutput(fallback)], 1);
    },
    120_000,
  );

  it("adapter fallback: workerAvailable=false, partial, coverage 0, sembol yok", () => {
    expect(fallback?.workerAvailable).toBe(false);
    expect(fallback?.state).toBe("partial");
    expect(fallback?.coverageRatio).toBe(0);
    expect(fallback?.edges).toEqual([]);
    expect(fallback?.evidence).toEqual([]);
    // L0/L1: File node'ları korunur (sourceHash kanıtlı), sembol üretilmez.
    expect(fallback?.nodes.length).toBe(csFixture.length);
    for (const node of fallback?.nodes ?? []) {
      expect(node.kind).toBe("File");
      expect(node.attributes?.["sourceHash"]).toBe(
        csFixture.find((file) => file.relativePath === node.relativePath)?.sourceHash,
      );
    }
    expect(
      fallback?.warnings.some(
        (warning) =>
          warning.includes("Roslyn worker kullanılamıyor") && warning.includes("L0/L1"),
      ),
      "explicit degradasyon warning'i yok",
    ).toBe(true);
  });

  it("uçtan uca: fallback çıktısı publish edilir (partial), motor çökmez, snapshot sorgulanır", () => {
    expect(degraded?.snapshot.meta.state).toBe("partial");
    const read = degraded?.repository.getSnapshot(degraded.snapshot.meta.id);
    expect(read).toBeDefined();
    expect(read?.snapshot.meta.id).toBe(degraded?.snapshot.meta.id);
    // Degradasyon kapsamı: yalnızca File düzeyi node'lar + Workspace.
    const kinds = (degraded?.snapshot.nodes ?? []).map((node) => node.kind);
    expect(kinds.every((kind) => kind === "Workspace" || kind === "File")).toBe(true);
    expect(kinds.filter((kind) => kind === "File").length).toBe(csFixture.length);
  });

  it("explicit coverage raporu: kayıp coverage açık sayılarla raporlanır", () => {
    // Motorun degradasyon raporu sözleşmesi (B8 kriteri 1): worker yoksa
    // kayıp coverage explicit — uydurma sembol/kenar YOK.
    const report = {
      workerAvailable: fallback?.workerAvailable ?? true,
      coverageRatio: fallback?.coverageRatio ?? 1,
      analyzedLanguages: ["csharp"],
      coveredFiles: (fallback?.nodes ?? []).filter((node) => node.kind === "File").length,
      symbolLevelNodes: (fallback?.nodes ?? []).filter((node) => node.kind !== "File")
        .length,
      inferredEdges: fallback?.edges.length ?? -1,
      warnings: fallback?.warnings.length ?? 0,
    };
    expect(report.workerAvailable).toBe(false);
    expect(report.coverageRatio).toBe(0);
    expect(report.analyzedLanguages).toEqual(["csharp"]);
    expect(report.coveredFiles).toBe(csFixture.length);
    expect(report.symbolLevelNodes).toBe(0);
    expect(report.inferredEdges).toBe(0);
    expect(report.warnings).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* B8/5 — Stale: yeni yayın eski snapshot'ı stale=true yapar            */
/* ------------------------------------------------------------------ */

describe.skipIf(!workerReady)("B8 cross-boundary: stale semantiği (TŞ §9)", () => {
  it(
    "yeni snapshot yayımlanınca eski snapshot stale=true ile ID'den sorgulanır",
    async () => {
      // TEK repository: iki revizyon sırayla yayımlanır (TŞ §9 akışı).
      const repository = createUnifiedRepository();

      const tsA = runTsAdapter(UNIFIED_WORKSPACE_ID);
      const csA = await runCsAdapter(UNIFIED_WORKSPACE_ID);
      const first = publishUnifiedSnapshot(
        [toAdapterOutput(tsA), toAdapterOutput(csA)],
        1,
        repository,
      );
      const oldId = first.snapshot.meta.id;
      expect(repository.getSnapshot(oldId)?.stale).toBe(false);
      expect(repository.getLatestPublished(UNIFIED_WORKSPACE_ID)?.stale).toBe(false);

      const tsB = runTsAdapter(UNIFIED_WORKSPACE_ID);
      const csB = await runCsAdapter(UNIFIED_WORKSPACE_ID);
      const second = publishUnifiedSnapshot(
        [toAdapterOutput(tsB), toAdapterOutput(csB)],
        2,
        repository,
      );
      const newId = second.snapshot.meta.id;
      expect(newId, "revizyon sırası snapshot kimliğine girer").not.toBe(oldId);

      // Eski snapshot hâlâ ID ile SORGULANABİLİR ve stale=true taşır.
      const oldRead = repository.getSnapshot(oldId);
      expect(oldRead).toBeDefined();
      expect(oldRead?.snapshot.meta.id).toBe(oldId);
      expect(oldRead?.stale).toBe(true);
      // En son yayın yeni snapshot'tır ve stale=false.
      const latest = repository.getLatestPublished(UNIFIED_WORKSPACE_ID);
      expect(latest?.snapshot.meta.id).toBe(newId);
      expect(latest?.stale).toBe(false);
    },
    300_000,
  );
});
