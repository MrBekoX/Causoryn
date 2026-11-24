import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * B9 — Sprint-2 açık kalemleri 3 ve 8'in kapatılması: C# adapter'ın
 * indexing pipeline entegrasyonu + analyzerFingerprint ref-pack şeması
 * (TŞ v2.1 §7/§8/§9; adapters/csharp-roslyn/README.md "Açık borç"
 * sözleşmesi).
 *
 * Pozitif (karışık workspace, GERÇEK dotnet worker koşumu):
 * fixture-ts-orders + fixture-csharp-orders tek kökte birleştirilir ve
 * IndexService.runIndexAsync TEK snapshot yayımlar — iki dilin node/kenar
 * katmanı tek graph'ta, dangling edge yok, verified kenarlar kanıtlı
 * (cross-boundary sözleşmesi; TŞ §8 invariant ii/i). analyzerFingerprint
 * fp2 şemasıyla adapter versiyonu + ref-pack sürümleri + discovery kaynağı
 * + ayarlar hash'ini taşır (README "Açık borç" sözleşmesi).
 *
 * Negatif (worker yok simülasyonu): olmayan workerDllPath ile
 * runIndexAsync → motor ÇÖKMEZ; TS analizi tam kalır, C# L0/L1 dosya
 * düzeyine düşer, explicit warning + partial yayımlanır; fingerprint
 * ref-pack'i dürüstçe "unavailable" işaretler.
 *
 * Partial (yalnızca .cs workspace): fixture-csharp-orders kökü → C#
 * sembol/Endpoint/ROUTES_TO katmanı üretilir; TS File node yok.
 *
 * Senkron köprü dürüstlüğü: runIndex async worker'ı bekleyemez — .cs'li
 * workspace'te senkron koşum C#'ı L0 envanter düzeyinde tutar ve bunu
 * explicit warning + partial state ile raporlar (uydurma sembol/kenar yok;
 * TŞ §7 "yalnızca kanıtlanabilen L0/L1 bilgisi sunulur").
 *
 * Testler depoya YAZMAZ: fixture'lar salt-okunur okunur, geçici kökler
 * os.tmpdir() altında kurulur ve silinir (ADR-008).
 */

import {
  ANALYZER_FINGERPRINT_SCHEMA_VERSION,
  buildAnalyzerFingerprint,
  extractRoslynRefPackContext,
  INDEXED_ADAPTERS,
  INDEXING_VERSION,
  IndexJobManager,
  IndexService,
  IndexingError,
} from "../src/index.js";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";
import { InMemoryGraphRepository } from "@causoryn/graph";
import { snapshotCanonicalJson } from "@causoryn/domain";
import { buildRoslynWorkerBinary } from "../../../tests/roslyn-worker-build.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const TS_FIXTURE = path.join(REPO_ROOT, "examples", "fixture-ts-orders");
const CS_FIXTURE = path.join(REPO_ROOT, "examples", "fixture-csharp-orders");
const WORKER_DLL = path.join(
  REPO_ROOT,
  "native",
  "roslyn-worker",
  "bin",
  "Debug",
  "net10.0",
  "Causoryn.RoslynWorker.dll",
);
const FIXED_NOW = "2026-11-05T00:00:00.000Z";

/* Bootstrap: dotnet var mı + worker binary (B1/B8 ile aynı kilitli builder). */
const dotnetCheck = spawnSync("dotnet", ["--version"], {
  encoding: "utf8",
  shell: false,
});
const workerReady = dotnetCheck.status === 0;

if (!workerReady) {
  console.error(
    "[indexing-b9] dotnet SDK bulunamadı — C# worker blokları koşulamadı (çalıştırılamadı olarak raporlanır)",
  );
}

/** Uzantıya göre özyinelemeli kopya: fixture içeriği geçici köke yazılır
 *  (fixture dizini salt-okunur kalır; depoya yazma yok). */
function copyFixtureInto(srcDir: string, destRoot: string, prefix = ""): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const source = path.resolve(srcDir, entry.name);
    const target = path.resolve(destRoot, relative);
    if (target !== destRoot && !target.startsWith(destRoot + path.sep)) {
      throw new Error(`kopya hedefi kök dışına çıkıyor: ${relative}`);
    }
    if (entry.isDirectory()) {
      mkdirSync(target, { recursive: true });
      copyFixtureInto(source, destRoot, relative);
    } else if (entry.isFile()) {
      copyFileSync(source, target);
    }
  }
}

function makeMixedRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "causoryn-b9-mixed-"));
  copyFixtureInto(TS_FIXTURE, root);
  copyFixtureInto(CS_FIXTURE, root);
  return root;
}

function makeService(
  repository: InMemoryGraphRepository,
  root: string,
  csharp?: {
    readonly dotnetCommand?: string;
    readonly requestTimeoutMs?: number;
    readonly workerDllPath?: string;
  },
  workspaceId = "default",
): IndexService {
  return new IndexService({
    workspaceId,
    policy: WorkspaceAccessPolicy.create({ allowRoots: [root] }),
    repository,
    clock: () => FIXED_NOW,
    limits: { maxFiles: 50_000 },
    ...(csharp === undefined ? {} : { csharp }),
  });
}

/* ------------------------------------------------------------------ */
/* Pozitif: karışık workspace → TEK snapshot (gerçek worker koşumu)     */
/* ------------------------------------------------------------------ */

describe.skipIf(!workerReady)(
  "IndexService.runIndexAsync — TS + C# tek snapshot (B9 pozitif, gerçek Roslyn worker)",
  () => {
    let mixedRoot = "";
    let firstRepository: InMemoryGraphRepository | null = null;
    let firstRun: Awaited<ReturnType<IndexService["runIndexAsync"]>> | null = null;
    let secondCanonical = "";

    beforeAll(
      async () => {
        // Build serileştirme: cross-boundary/roslyn-worker suite'leriyle
        // aynı kilitli builder (paralel fork'larda MSBuild obj yarışı yok).
        if (!existsSync(WORKER_DLL)) {
          const build = buildRoslynWorkerBinary();
          if (build.status !== 0 || !existsSync(WORKER_DLL)) {
            throw new Error(`worker derlemesi başarısız (exit=${String(build.status)})`);
          }
        }
        mixedRoot = makeMixedRoot();
        firstRepository = new InMemoryGraphRepository();
        const service = makeService(firstRepository, mixedRoot, undefined, "b9-mixed");
        firstRun = await service.runIndexAsync(mixedRoot);

        // Determinizm: bağımsız ikinci servis, aynı kök.
        const secondRepository = new InMemoryGraphRepository();
        const secondService = makeService(secondRepository, mixedRoot, undefined, "b9-mixed");
        const secondRun = await secondService.runIndexAsync(mixedRoot);
        secondCanonical = snapshotCanonicalJson(secondRun.snapshot);
      },
      600_000,
    );

    it("tek snapshot: iki dilin node katmanı bir arada, ready yayımlandı", () => {
      expect(firstRun).not.toBeNull();
      const run = firstRun as NonNullable<typeof firstRun>;
      expect(run.published).toBe(true);
      expect(run.snapshot.meta.state).toBe("ready");
      expect(run.csFileCount).toBe(4); // Program.cs + 3 fixture .cs
      const qualifiedNames = new Set(run.snapshot.nodes.map((n) => n.qualifiedName));
      // TS sembol katmanı (fixture-ts-orders).
      expect(qualifiedNames.has("OrdersService.create")).toBe(true);
      expect(qualifiedNames.has("OrderRepository.save")).toBe(true);
      // C# sembol katmanı (fixture-csharp-orders).
      expect(
        qualifiedNames.has("Causoryn.Fixture.Orders.Services.OrdersService.Create"),
      ).toBe(true);
      expect(
        qualifiedNames.has("Causoryn.Fixture.Orders.Repositories.OrderRepository.Save"),
      ).toBe(true);
      // Dil bayrakları: C# File node'ları language csharp taşır.
      const csFileNodes = run.snapshot.nodes.filter(
        (n) => n.kind === "File" && n.language === "csharp",
      );
      expect(csFileNodes.length).toBe(4);
      const tsFileNodes = run.snapshot.nodes.filter(
        (n) => n.kind === "File" && n.language === "typescript",
      );
      expect(tsFileNodes.length).toBeGreaterThan(0);
    });

    it("dangling edge yok + verified kenarlar kanıtlı + iki dilin zinciri tek graph'ta", () => {
      const run = firstRun as NonNullable<typeof firstRun>;
      const nodeIds = new Set(run.snapshot.nodes.map((n) => n.id));
      expect(nodeIds.size).toBeGreaterThan(0);
      for (const edge of run.snapshot.edges) {
        expect(nodeIds.has(edge.from), `dangling from: ${edge.id}`).toBe(true);
        expect(nodeIds.has(edge.to), `dangling to: ${edge.id}`).toBe(true);
        if (edge.resolution === "verified") {
          expect(edge.evidenceIds.length).toBeGreaterThanOrEqual(1);
        }
      }
      // İki dilin Endpoint→ROUTES_TO katmanı: POST /orders (TS) ve
      // POST /api/Orders (C#) TEK snapshot'ta.
      const byId = new Map(run.snapshot.nodes.map((n) => [n.id, n]));
      const endpointNames = run.snapshot.edges
        .filter((e) => e.kind === "ROUTES_TO")
        .map((e) => byId.get(e.from)?.qualifiedName ?? "")
        .sort();
      expect(endpointNames).toContain("POST /orders");
      expect(endpointNames).toContain("POST /api/Orders");
      // Workspace → File CONTAINS her iki dilin dosyalarını kapsar.
      const workspaceNode = run.snapshot.nodes.find(
        (n) => n.kind === "Workspace",
      );
      expect(workspaceNode).toBeDefined();
      const tsFileCount = run.snapshot.nodes.filter(
        (n) => n.kind === "File" && n.language === "typescript",
      ).length;
      expect(tsFileCount).toBeGreaterThan(0);
      const workspaceContains = run.snapshot.edges.filter(
        (e) => e.kind === "CONTAINS" && e.from === workspaceNode?.id,
      );
      expect(workspaceContains.length).toBe(4 + tsFileCount);
    });

    it("analyzerFingerprint fp2 şeması: adapter versiyonu + ref-pack sürümleri + discovery kaynağı + ayarlar hash'i", () => {
      const run = firstRun as NonNullable<typeof firstRun>;
      const fp = run.snapshot.meta.analyzerFingerprint;
      expect(fp.startsWith(`${ANALYZER_FINGERPRINT_SCHEMA_VERSION}|`)).toBe(true);
      const segments = fp.split("|");
      expect(segments).toContain("ts-adapter@0.1.0");
      expect(segments).toContain("roslyn-worker@0.1.0");
      // Ref-pack: worker healthy koştu → NETCore.App.Ref sürümü yüklü
      // (bu makinede packs dizini SDK ile gelir; ReferenceResolver.cs:144
      // formatı: "referans paketi yüklendi: <pack> <sürüm> (<tfmDir>)").
      const netCore = segments.find((s) => s.startsWith("refpack="));
      expect(netCore).toBeDefined();
      expect(netCore).toContain("Microsoft.NETCore.App.Ref@");
      const tfmDirPart = (netCore as string).split("@")[2] ?? "";
      expect(tfmDirPart.length).toBeGreaterThan(0);
      // Discovery kaynağı: DOTNET_ROOT tanımsız → worker host/standart yol
      // ile keşfetti (env etiketi yalnızca DOTNET_ROOT altındaysa).
      const refsrc = segments.find((s) => s.startsWith("refsrc="));
      expect(refsrc).toBeDefined();
      expect(["refsrc=worker-discovered", "refsrc=env-dotnet-root"]).toContain(refsrc);
      // Ayarlar hash'i: 16 hex karakter.
      const opts = segments.find((s) => s.startsWith("opts="));
      expect(opts).toMatch(/^opts=[0-9a-f]{16}$/);
    });

    it("determinizm: iki bağımsız kurulum aynı snapshot ID + canonical JSON (TŞ §8 invariant vi)", () => {
      const run = firstRun as NonNullable<typeof firstRun>;
      const firstCanonical = snapshotCanonicalJson(run.snapshot);
      expect(firstCanonical.length).toBeGreaterThan(0);
      expect(secondCanonical).toBe(firstCanonical);
      // Snapshot ID fingerprint + content'ten türetilir → canonical eşitliği
      // ID eşitliğine yol açar (ikinci servis runCount'ı bağımsız: sequence 1).
      expect(run.snapshot.meta.id.length).toBeGreaterThan(0);
    });

    it("negatif: olmayan worker DLL → motor ayakta, C# L0/L1 + explicit warning, fingerprint refpack=unavailable", async () => {
      const root = makeMixedRoot();
      try {
        const repository = new InMemoryGraphRepository();
        const service = makeService(
          repository,
          root,
          {
            workerDllPath: path.join(
              REPO_ROOT,
              "native",
              "roslyn-worker",
              "bin",
              "Debug",
              "net10.0",
              "olmayan-worker.dll",
            ),
          },
          "b9-degraded",
        );
        const run = await service.runIndexAsync(root);
        expect(run.published).toBe(true);
        // Degrade: partial + C# L0 File node'ları korunur, C# sembol yok.
        expect(run.snapshot.meta.state).toBe("partial");
        const names = new Set(run.snapshot.nodes.map((n) => n.qualifiedName));
        expect(names.has("OrdersService.create")).toBe(true); // TS dolu
        expect(
          names.has("Causoryn.Fixture.Orders.Services.OrdersService.Create"),
        ).toBe(false); // C# sembol üretilmedi (uydurma yok)
        const csFiles = run.snapshot.nodes.filter(
          (n) => n.kind === "File" && n.language === "csharp",
        );
        expect(csFiles.length).toBe(4);
        // Explicit degradasyon warning'i (adapter fallback sözleşmesi).
        expect(
          run.warnings.some(
            (w) => w.includes("Roslyn worker unavailable") && w.includes("L0/L1"),
          ),
        ).toBe(true);
        // Fingerprint dürüstçülüğü: ref-pack keşfi YAPILMADI.
        const segments = run.snapshot.meta.analyzerFingerprint.split("|");
        expect(segments).toContain("refpack=unavailable");
        expect(segments).toContain("refsrc=worker-unavailable");
        // Motor ayakta: snapshot sorgulanabilir.
        expect(repository.getLatestPublished("b9-degraded")?.stale).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);
  },
);

/* ------------------------------------------------------------------ */
/* Partial: yalnızca .cs workspace (gerçek worker koşumu)               */
/* ------------------------------------------------------------------ */

describe.skipIf(!workerReady)(
  "IndexService.runIndexAsync — yalnızca C# workspace (B9 partial üçlüsü)",
  () => {
    let repository: InMemoryGraphRepository;
    let run: Awaited<ReturnType<IndexService["runIndexAsync"]>> | null = null;

    beforeAll(async () => {
      repository = new InMemoryGraphRepository();
      const service = makeService(repository, CS_FIXTURE, undefined, "b9-csonly");
      run = await service.runIndexAsync(CS_FIXTURE);
    }, 300_000);

    it("yalnızca .cs workspace → C# node'ları, Endpoint + ROUTES_TO; TS File node yok", () => {
      expect(run).not.toBeNull();
      const runLocal = run as NonNullable<typeof run>;
      // Worker healthy: state ready, coverage 1 (fixture tümü kapsanır).
      expect(runLocal.snapshot.meta.state).toBe("ready");
      expect(runLocal.tsFileCount).toBe(0);
      expect(runLocal.csFileCount).toBe(4);
      const names = new Set(runLocal.snapshot.nodes.map((n) => n.qualifiedName));
      expect(
        names.has("Causoryn.Fixture.Orders.Controllers.OrdersController.Create"),
      ).toBe(true);
      // Endpoint + ROUTES_TO: controller attribute L3 route katmanı.
      const byId = new Map(runLocal.snapshot.nodes.map((n) => [n.id, n]));
      const endpoints = runLocal.snapshot.edges
        .filter((e) => e.kind === "ROUTES_TO")
        .map((e) => byId.get(e.from)?.qualifiedName ?? "");
      expect(endpoints).toContain("POST /api/Orders");
      expect(endpoints).toContain("GET /api/Orders/{id}");
      // TS analiz koşmadı: typescript File node yok.
      expect(
        runLocal.snapshot.nodes.some(
          (n) => n.kind === "File" && n.language === "typescript",
        ),
      ).toBe(false);
      // Envanter: README.md gibi TS/CS-dışı dosyalar files tablosunda kalır.
      expect(repository.listFiles("b9-csonly").some((f) => f.relativePath === "README.md"))
        .toBe(true);
      // Ref-pack bilgi kanıtı: worker warnings'te yükleme notu var
      // (fingerprint'in kaynağı — ReferenceResolver.cs:144 formatı).
      expect(
        runLocal.warnings.some(
          (w) => w.startsWith("referans paketi yüklendi: Microsoft.NETCore.App.Ref"),
        ),
      ).toBe(true);
    });

    it(
      "runIncrementalIndexAsync: TS/CS içeriği değişmediyse no-op; .cs değişirse rebuild",
      { timeout: 300_000 },
      async () => {
      // İki gerçek worker koşumu içerir (initial + rebuild); paralel fork
      // yükünde vitest default 5s yeterli değildir (suite kuralı: yalnızca
      // çalışma bütçesi, assertion gevşetmesi yok).
      const root = makeMixedRoot();
      try {
        const repo2 = new InMemoryGraphRepository();
        const service2 = makeService(repo2, root, undefined, "b9-inc");
        const initial = await service2.runIndexAsync(root);
        expect(initial.published).toBe(true);

        // No-op: değişiklik yok.
        const noop = await service2.runIncrementalIndexAsync(root, []);
        expect(noop.published).toBe(false);
        expect(noop.snapshotId).toBe(initial.snapshotId);

        // .cs içerik değişimi → YENİ snapshot (C# karma karşılaştırması).
        const controllerPath = path.join(root, "Controllers", "OrdersController.cs");
        const original = await import("node:fs").then((m) =>
          m.readFileSync(controllerPath, "utf8"),
        );
        const { writeFileSync } = await import("node:fs");
        writeFileSync(
          controllerPath,
          original + "\n// b9 incremental probe\n",
          "utf8",
        );
        const rebuilt = await service2.runIncrementalIndexAsync(root, [
          "Controllers/OrdersController.cs",
        ]);
        expect(rebuilt.published).toBe(true);
        expect(rebuilt.snapshotId).not.toBe(initial.snapshotId);
        expect(rebuilt.snapshot.meta.state).toBe("ready");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      },
    );
  },
);

/* ------------------------------------------------------------------ */
/* Senkron köprü dürüstlüğü: runIndex .cs'i L0'da tutar                */
/* ------------------------------------------------------------------ */

describe("IndexService.runIndex — senkron koşum C# derin analiz yürütmez (B9 köprü sözleşmesi)", () => {
  it("karışık workspace senkron koşum: TS dolu + C# L0 File node'ları + explicit warning + partial", async () => {
    const root = makeMixedRoot();
    try {
      const repository = new InMemoryGraphRepository();
      // Olmayan DLL ile koş: senkron yol adapter'a SPAWN ATMAMALI — spawn
      // atılsaydı fallback warning ("Roslyn worker unavailable")
      // warnings'e girerdi; köprü sözleşmesinde o uyarı YOKTUR.
      const service = makeService(
        repository,
        root,
        {
          workerDllPath: path.join(
            REPO_ROOT,
            "native",
            "roslyn-worker",
            "bin",
            "Debug",
            "net10.0",
            "olmayan-worker.dll",
          ),
        },
        "b9-sync",
      );
      const run = service.runIndex(root);
      expect(run.published).toBe(true);
      expect(run.snapshot.meta.state).toBe("partial");
      // TS sembol katmanı tam.
      const names = new Set(run.snapshot.nodes.map((n) => n.qualifiedName));
      expect(names.has("OrdersService.create")).toBe(true);
      // C#: yalnızca L0 File node'ları (uydurma sembol yok).
      const csFiles = run.snapshot.nodes.filter(
        (n) => n.kind === "File" && n.language === "csharp",
      );
      expect(csFiles.length).toBe(4);
      expect(
        names.has("Causoryn.Fixture.Orders.Services.OrdersService.Create"),
      ).toBe(false);
      // Explicit köprü warning: hangi yolun neden kullanılamadığı açıktır.
      expect(
        run.warnings.some(
          (w) =>
            w.includes("synchronous run cannot perform deep") &&
            w.includes("C#") &&
            w.includes("runIndexAsync"),
        ),
      ).toBe(true);
      // Spawn atılmadı: adapter fallback uyarısı yok.
      expect(
        run.warnings.some((w) => w.includes("Roslyn worker unavailable")),
      ).toBe(false);
      // Fingerprint: sync koşum worker keşfi yapmadı — dürüst etiket.
      const segments = run.snapshot.meta.analyzerFingerprint.split("|");
      expect(segments).toContain("refpack=unavailable");
      expect(segments).toContain("refsrc=sync-run-degraded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("yalnızca .cs'li workspace senkron koşum: workspace + C# File L0 + partial (motor çökmez)", () => {
    const repository = new InMemoryGraphRepository();
    const service = makeService(repository, CS_FIXTURE, undefined, "b9-sync-cs");
    const run = service.runIndex(CS_FIXTURE);
    expect(run.published).toBe(true);
    expect(run.snapshot.meta.state).toBe("partial");
    expect(run.tsFileCount).toBe(0);
    const csFiles = run.snapshot.nodes.filter(
      (n) => n.kind === "File" && n.language === "csharp",
    );
    expect(csFiles.length).toBe(4);
    expect(run.warnings.some((w) => w.includes("synchronous run cannot perform deep"))).toBe(true);
  }, 60_000);

  it("negatif: yetkisiz kök runIndexAsync'te de IndexingError ile reddedilir", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "causoryn-b9-auth-"));
    try {
      const service = new IndexService({
        workspaceId: "b9-auth",
        policy: WorkspaceAccessPolicy.create({ allowRoots: [] }),
        repository: new InMemoryGraphRepository(),
        clock: () => FIXED_NOW,
        limits: { maxFiles: 50_000 },
      });
      let caught: unknown;
      try {
        await service.runIndexAsync(root);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(IndexingError);
      expect((caught as IndexingError).code).toBe("indexing/root-not-authorized");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* get_capabilities yüzeyi: INDEXED_ADAPTERS metadata'sı                */
/* ------------------------------------------------------------------ */

describe("INDEXED_ADAPTERS — beş adapter kaydı (get_capabilities yüzeyi)", () => {
  it("csharp-roslyn kaydı gerçek yeteneklerle + TS kaydı değişmedi", () => {
    // M2 ile python/go/rust sidecar kayıtları eklendi (toplam 5; dil
    // metadata sözleşmesi index-service-multilang.test.ts'te ayrıca
    // doğrulanır). Kayıt sırası korunur: TS, C#, python, go, rust.
    expect(INDEXED_ADAPTERS).toHaveLength(5);
    const ts = INDEXED_ADAPTERS.find((a) => a.language === "typescript");
    expect(ts).toBeDefined();
    expect(ts?.analyzerId).toBe("ts-adapter");
    expect(ts?.version).toBe("0.1.0");
    expect(ts?.source).toBe("adapters/typescript");
    expect(ts?.levels.frameworkLinkers).toBe("express+nextjs");

    const cs = INDEXED_ADAPTERS.find((a) => a.language === "csharp");
    expect(cs).toBeDefined();
    expect(cs?.analyzerId).toBe("roslyn-worker");
    expect(cs?.version).toBe("0.1.0");
    expect(cs?.source).toBe("adapters/csharp-roslyn");
    // TŞ §7 seviye tablosu + K-019(1): C#/.NET → L2 + controller/minimal API L3.
    expect(cs?.levels.astParse).toBe("L1");
    expect(cs?.levels.symbolResolution).toBe("L2");
    expect(cs?.levels.frameworkLinkers).toBe("aspnet-core-route-attributes (L3)");
    // Denetim bulgusu: mcp-server get_capabilities yüzeyi yalnızca üç
    // levels alanını taşıyor (services.ts jobRecordOf/analytics map).
    // routeDetection alanı yüzeye ULAŞAMAYACAĞI için beyan edilmez
    // (ölü metadata yok; mcp-server kapsam dışı — alan ya yüzeyde ya yok).
    expect("routeDetection" in (cs?.levels ?? {})).toBe(false);
    expect(Object.keys(cs?.levels ?? {}).sort()).toEqual([
      "astParse",
      "frameworkLinkers",
      "symbolResolution",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* analyzerFingerprint fp2 — birim sözleşme                             */
/* ------------------------------------------------------------------ */

describe("analyzerFingerprint fp2 şeması (birim)", () => {
  it("extractRoslynRefPackContext: ReferenceResolver.cs:144 formatını ayrıştırır", () => {
    const original = process.env["DOTNET_ROOT"];
    delete process.env["DOTNET_ROOT"];
    try {
      const context = extractRoslynRefPackContext([
        "referans paketi yüklendi: Microsoft.AspNetCore.App.Ref 10.0.11 (C:\\Program Files\\dotnet\\packs\\Microsoft.AspNetCore.App.Ref\\10.0.11\\ref\\net10.0)",
        "referans paketi yüklendi: Microsoft.NETCore.App.Ref 10.0.11 (C:\\Program Files\\dotnet\\packs\\Microsoft.NETCore.App.Ref\\10.0.11\\ref\\net10.0)",
      ]);
      expect(context).not.toBeNull();
      expect(context?.packs).toHaveLength(2);
      // Pack adına göre sıralı (deterministik fingerprint).
      expect(context?.packs[0]?.pack).toBe("Microsoft.AspNetCore.App.Ref");
      expect(context?.packs[0]?.version).toBe("10.0.11");
      expect(context?.packs[1]?.pack).toBe("Microsoft.NETCore.App.Ref");
      // DOTNET_ROOT tanımsız → host/standart keşif etiketi.
      expect(context?.source).toBe("worker-discovered");
    } finally {
      if (original === undefined) delete process.env["DOTNET_ROOT"];
      else process.env["DOTNET_ROOT"] = original;
    }
  });

  it("extractRoslynRefPackContext: pack yoksa fallback-corelib, worker koşmadıysa null", () => {
    const original = process.env["DOTNET_ROOT"];
    delete process.env["DOTNET_ROOT"];
    try {
      const fallback = extractRoslynRefPackContext([
        "Microsoft.NETCore.App.Ref pack bulunamadı; çalışma zamanı düşüşü: yalnızca System.Private.CoreLib.dll referansı eklendi.",
      ]);
      expect(fallback).not.toBeNull();
      expect(fallback?.packs).toHaveLength(0);
      expect(fallback?.source).toBe("worker-discovered");

      expect(extractRoslynRefPackContext([])).toBeNull();
      expect(extractRoslynRefPackContext(["ilgisiz uyarı"])).toBeNull();
    } finally {
      if (original === undefined) delete process.env["DOTNET_ROOT"];
      else process.env["DOTNET_ROOT"] = original;
    }
  });

  it("buildAnalyzerFingerprint: deterministik; ayar değişimi opts hash'ini değiştirir (opts = geçilen ayarlar)", () => {
    const csharp = {
      analyzerId: "roslyn-worker",
      version: "0.1.0",
      discovery: "performed" as const,
      refPacks: {
        packs: [
          {
            pack: "Microsoft.NETCore.App.Ref",
            version: "10.0.11",
            tfmDir: "C:\\Program Files\\dotnet\\packs\\Microsoft.NETCore.App.Ref\\10.0.11\\ref\\net10.0",
          },
        ],
        source: "worker-discovered" as const,
      },
      settings: {
        dotnetCommand: "dotnet",
        requestTimeoutMs: 30_000,
        workerDllPath: "/workspace/native/roslyn-worker/bin/Debug/net10.0/Causoryn.RoslynWorker.dll",
      },
    };
    const a = buildAnalyzerFingerprint({
      typescript: { analyzerId: "ts-adapter", version: "0.1.0" },
      csharp,
    });
    const b = buildAnalyzerFingerprint({
      typescript: { analyzerId: "ts-adapter", version: "0.1.0" },
      csharp,
    });
    expect(a).toBe(b);
    expect(a.startsWith("fp3|")).toBe(true);
    expect(a.split("|")).toContain("ts-adapter@0.1.0");
    expect(a.split("|")).toContain("roslyn-worker@0.1.0");
    expect(a).toContain("Microsoft.NETCore.App.Ref@10.0.11");
    expect(a).toContain("refsrc=worker-discovered");

    const differentSettings = buildAnalyzerFingerprint({
      typescript: { analyzerId: "ts-adapter", version: "0.1.0" },
      csharp: {
        ...csharp,
        settings: { ...csharp.settings, requestTimeoutMs: 60_000 },
      },
    });
    expect(differentSettings).not.toBe(a);

    // Denetim bulgusu: opts hash'i IndexService'in adapter'a GEÇTİĞİ
    // ayarları kapsar — worker yanıt bütçesi (responseMaxChars) adapter
    // içindeki sabittir, IndexService geçmez; kopyalanması bayatma riski
    // üretirdi. Artık şemada yer almaz (README fp2 bölümüyle aynı).
    expect(a.split("|").some((s) => s.startsWith("opts="))).toBe(true);

    const workerUnavailable = buildAnalyzerFingerprint({
      typescript: { analyzerId: "ts-adapter", version: "0.1.0" },
      csharp: {
        analyzerId: "roslyn-worker",
        version: "0.1.0",
        discovery: "worker-unavailable",
        refPacks: null,
        settings: csharp.settings,
      },
    });
    expect(workerUnavailable.split("|")).toContain("refpack=unavailable");
    expect(workerUnavailable.split("|")).toContain("refsrc=worker-unavailable");

    // Denetim bulgusu: worker koştu ve HEALTHY döndü ama warnings'te
    // ref-pack satırı yok — worker YOKTU demek değildir; nötr etiket.
    const discoveryUnknown = buildAnalyzerFingerprint({
      typescript: { analyzerId: "ts-adapter", version: "0.1.0" },
      csharp: {
        analyzerId: "roslyn-worker",
        version: "0.1.0",
        discovery: "discovery-unknown",
        refPacks: null,
        settings: csharp.settings,
      },
    });
    expect(discoveryUnknown.split("|")).toContain("refpack=unavailable");
    expect(discoveryUnknown.split("|")).toContain("refsrc=discovery-unknown");
    expect(discoveryUnknown.split("|")).not.toContain("refsrc=worker-unavailable");

    // TS yok → ts segmenti olmaz.
    const csOnly = buildAnalyzerFingerprint({ typescript: null, csharp });
    expect(csOnly.split("|")).not.toContain("ts-adapter@0.1.0");
  });

  it("resolveDiscoverySource: DOTNET_ROOT sınır ayıracı ve büyük/küçük harf normalizasyonu (denetim bulgusu)", () => {
    const original = process.env["DOTNET_ROOT"];
    try {
      // Boundary: 'C:\\dotnet' kökü, 'C:\\dotnet-evil' altındaki yolu
      // env keşfi SANMAMALI (prefix ayıraçsız eşleşme false-positive).
      process.env["DOTNET_ROOT"] = "C:\\dotnet";
      const evil = extractRoslynRefPackContext([
        "referans paketi yüklendi: Microsoft.NETCore.App.Ref 10.0.11 (C:\\dotnet-evil\\packs\\Microsoft.NETCore.App.Ref\\10.0.11\\ref\\net10.0)",
      ]);
      expect(evil?.source).toBe("worker-discovered");

      // Windows büyük/küçük harf normalizasyonu: env 'c:\\dotnet' küçük
      // yazılsa da aynı kurulum kökü tanınmalı (ters yönde
      // false-negative güvenli ama bilgi kaybı gereksizdir).
      process.env["DOTNET_ROOT"] = "c:\\dotnet";
      const real = extractRoslynRefPackContext([
        "referans paketi yüklendi: Microsoft.NETCore.App.Ref 10.0.11 (C:\\dotnet\\packs\\Microsoft.NETCore.App.Ref\\10.0.11\\ref\\net10.0)",
      ]);
      expect(real?.source).toBe("env-dotnet-root");
    } finally {
      if (original === undefined) {
        delete process.env["DOTNET_ROOT"];
      } else {
        process.env["DOTNET_ROOT"] = original;
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Denetim bulgusu düzeltmeleri (B9 takip)                              */
/* ------------------------------------------------------------------ */

describe("runIndexAsync — boş workspace dürüstlüğü (denetim bulgusu B1)", () => {
  it("yalnızca kapsam-dışı dosyalı workspace → partial + kapsam uyarıları (senkron yolla aynı)", async () => {
    // Yalnızca README.md içeren kök: tsEntries=0 ve csEntries=0. Senkron
    // runPipeline bu girdiyi 'partial' + explicit uyarıyla yayımlar;
    // async yolun da AYNI dürüstlüğü raporlaması gerekir (coverage sıfır
    // iken 'ready' uydurması ADR-010/TŞ §7'ye aykırıdır).
    const root = mkdtempSync(path.join(tmpdir(), "causoryn-b9-empty-"));
    try {
      writeFileSync(path.join(root, "README.md"), "# dok\n", "utf8");
      const repository = new InMemoryGraphRepository();
      const service = makeService(repository, root, undefined, "b9-async-empty");
      const run = await service.runIndexAsync(root);
      expect(run.published).toBe(true);
      expect(run.snapshot.meta.state).toBe("partial");
      // Uyarı metni beş dil kapsamını taşır (M2 denetim bulgusu: kapsam
      // beş dile genişledi ama kullanıcıya yönelik erken-çıkış metni
      // yalnızca TypeScript/TSX/C# sayıyordu — geride kalmıştı).
      expect(
        run.warnings.some((w) =>
          w.includes("contains no analyzable TypeScript/TSX/C#/Python/Go/Rust sources"),
        ),
      ).toBe(true);
      expect(run.warnings.some((w) => w.includes("README.md"))).toBe(true);
      expect(run.tsFileCount).toBe(0);
      expect(run.csFileCount).toBe(0);
      // Snapshot tek Workspace node'uyla sorgulanabilir.
      expect(run.snapshot.nodes.map((n) => n.kind)).toEqual(["Workspace"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe.skipIf(!workerReady)(
  "IndexJobManager — refresh işi TAM pipeline koşar (denetim bulgusu B2+B5)",
  () => {
    it(
      "full job karışık workspace'te C# sembolleri üretir ve kayıt csFileCount taşır",
      async () => {
        const root = makeMixedRoot();
        try {
          const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
          const repository = new InMemoryGraphRepository();
          const indexService = makeService(repository, root, undefined, "b9-job");
          const tasks: Array<() => void> = [];
          const manager = new IndexJobManager({
            indexService,
            policy,
            clock: () => FIXED_NOW,
            // Manuel scheduler: task'ları elle boşalt (test kuyruğu).
            scheduler: (task) => {
              tasks.push(task);
            },
          });
          const record = manager.refreshIndex(root, { mode: "full" });
          for (const task of tasks.splice(0)) task();
          const final = await manager.waitForJob(record.jobId);

          expect(final.status).toBe("done");
          // B5: iş kaydı C# dosya sayısını taşır (index_status kaynağı).
          expect(final.csFileCount).toBe(4);
          // B2: refresh işi senkron L0 köprüsünü DEĞİL tam pipeline'ı
          // koşturur → C# sembol katmanı snapshot'ta.
          const latest = repository.getLatestPublished("b9-job");
          expect(latest).toBeDefined();
          const names = new Set(
            latest?.snapshot.nodes.map((n) => n.qualifiedName) ?? [],
          );
          expect(
            names.has("Causoryn.Fixture.Orders.Services.OrdersService.Create"),
          ).toBe(true);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      300_000,
    );
  },
);

describe("runIndexAsync — adapter sözleşme dışı hatasında files tablosu korunur (denetim bulgusu B10)", () => {
  it("adapter throw → hata rethrow; files upsert yapılmaz (sonraki incremental bayat graph'ı koruyamaz)", async () => {
    const root = makeMixedRoot();
    try {
      const repository = new InMemoryGraphRepository();
      // Test seam (adapter spawnProcess precedens'iyle aynı kural):
      // analyzeCSharp yalnızca test enjeksiyonu; prod varsayılan
      // analyzeCSharpWorkspace'dir. Stub her koşumda throw eder.
      const service = makeService(repository, root, undefined, "b9-seam");
      const serviceWithBoom = new IndexService({
        workspaceId: "b9-seam",
        policy: WorkspaceAccessPolicy.create({ allowRoots: [root] }),
        repository,
        clock: () => FIXED_NOW,
        limits: { maxFiles: 50_000 },
        csharp: {
          analyzeCSharp: async () => {
            throw new Error("b9-seam-boom");
          },
        },
      });
      let caught: unknown;
      try {
        await serviceWithBoom.runIndexAsync(root);
      } catch (error) {
        caught = error;
      }
      expect((caught as Error | undefined)?.message).toContain("b9-seam-boom");
      // Kritik iddia: files tablosu upsert'i adapter koşumundan SONRA
      // yapıldığı için throw yolunda envanter DOKUNULMAMIŞ kalır →
      // sonraki incremental karma karşılaştırması değişikliği gerçekten
      // görür ve bayat graph'ı 'değişiklik yok' sanarak koruyamaz.
      expect(repository.listFiles("b9-seam")).toHaveLength(0);
      // Aynı workspace'te sağlıklı koşum çalışır (motor ayakta).
      const recovered = await service.runIndexAsync(root);
      expect(recovered.published).toBe(true);
      expect(recovered.snapshot.meta.state).toBe("ready");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});

describe("sürüm ve manifest tutarlılığı (denetim bulgusu B9-sürüm)", () => {
  it("INDEXING_VERSION packages/indexing manifest sürümüyle aynıdır", () => {
    const manifest = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, "packages", "indexing", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(INDEXING_VERSION).toBe(manifest.version);
  });
});

describe("README fp2 örnek tutarlılığı (denetim bulgusu B8)", () => {
  it("adapters/csharp-roslyn/README.md fp1 formül kalıntısı taşımaz; fp2 kurulumunu gösterir", () => {
    const readme = readFileSync(
      path.join(REPO_ROOT, "adapters", "csharp-roslyn", "README.md"),
      "utf8",
    );
    // Eski fp1 örneği (KAPATILDI bölümüyle çelişen bayat kopya) kalmaz.
    expect(readme.includes("`roslyn-worker@${result.analyzerVersion}`")).toBe(
      false,
    );
    // fp2 kurgusu IndexService üzerinden örneklenir.
    expect(readme.includes("buildAnalyzerFingerprint")).toBe(true);
  });
});
