import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, copyFileSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isCargoAvailable } from "../../../adapters/rust/src/cargo.js";

/**
 * M2 — Sprint-8 dilimi: Faz-1'de gelen üç dil adapter'ının (python, go,
 * rust) indexing pipeline entegrasyonu (TŞ v2.1 §7, §8, §9).
 *
 * Pozitif (karışık 5 dil workspace'i, GERÇEK worker koşumları):
 * fixture-ts-orders + fixture-csharp-orders + fixture-python-app +
 * fixture-go-app + fixture-rust-app tek kökte birleştirilir ve
 * IndexService.runIndexAsync TEK snapshot yayımlar — beş dilin
 * node/kenar katmanı tek graph'ta, dangling edge yok, verified kenarlar
 * kanıtlı, analyzerFingerprint koşuma katılan beş analyzer'ı taşır.
 *
 * Degrade (bir worker yok → diğerleri yaşar): olmayan python komutu ile
 * koşum → motor ÇÖKMEZ; TS/C#/Go/Rust analizi tam kalır, Python L0/L1 dosya
 * düzeyine düşer, explicit warning + partial yayımlanır.
 *
 * Degrade (üç yeni worker da yok): python/go/rust L0 File node'ları
 * korunur, sembol üretilmez (uydurma yok), TS analizi tam kalır.
 *
 * Senkron köprü dürüstlüğü: runIndex async worker'ları bekleyemez —
 * python/go/rust dosyaları senkron koşumda L0 envanter düzeyinde tutulur
 * ve explicit warning ile raporlanır; worker SPAWN EDİLMEZ (fallback
 * uyarısı YOKTUR — csharp köprü sözleşmesiyle aynı).
 *
 * Incremental: .py içerik değişimi yeniden yayın tetikler; değişimsiz
 * koşum no-op'tur.
 *
 * Testler depoya YAZMAZ: fixture'lar salt-okunur okunur, geçici kökler
 * os.tmpdir() altında kurulur ve silinir (ADR-008).
 */

import {
  INDEXED_ADAPTERS,
  IndexService,
} from "../src/index.js";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";
import { InMemoryGraphRepository } from "@causoryn/graph";
import { snapshotCanonicalJson } from "@causoryn/domain";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const TS_FIXTURE = path.join(REPO_ROOT, "examples", "fixture-ts-orders");
const CS_FIXTURE = path.join(REPO_ROOT, "examples", "fixture-csharp-orders");
const PY_FIXTURE = path.join(REPO_ROOT, "examples", "fixture-python-app");
const GO_FIXTURE = path.join(REPO_ROOT, "examples", "fixture-go-app");
const RS_FIXTURE = path.join(REPO_ROOT, "examples", "fixture-rust-app");
/** Çözümlenmiş Go çalıştırılabilir yolu: CAUSORYN_GO_BINARY veya PATH'teki "go". */
const GO_BINARY = process.env["CAUSORYN_GO_BINARY"]?.trim() || "go";
const FIXED_NOW = "2026-11-15T00:00:00.000Z";

/* ------------------------------------------------------------------ */
/* Toolchain yoklamaları: pozitif 5-dil bloğu GERÇEK worker koşumları  */
/* yapar — toolchain yokken 'ready' beklentisi SKIP değil FAIL olurdu. */
/* Repo disiplini (go-adapter/python-adapter/rust-adapter testlerindeki*/
/* skipIf + console.error örüntüsü): koşulamayan SKIP edilir.          */
/* ------------------------------------------------------------------ */

const pythonCheck = spawnSync("python", ["--version"], {
  encoding: "utf8",
  shell: false,
});
const pythonAvailable = pythonCheck.status === 0;
const goCheck = spawnSync(GO_BINARY, ["version"], {
  encoding: "utf8",
  shell: false,
});
const goAvailable = goCheck.status === 0;
const cargoAvailable = isCargoAvailable();
const missingToolchains = [
  pythonAvailable ? "" : "python",
  goAvailable ? "" : "go",
  cargoAvailable ? "" : "cargo",
].filter((name) => name !== "");
if (missingToolchains.length > 0) {
  console.error(
    `[index-service-multilang] toolchain bulunamadı (${missingToolchains.join(", ")}) — gerçek worker koşumu gerektiren pozitif/degrade testleri skip edilir (koşulamadı olarak raporlanır)`,
  );
}

/** Uzantıya göre özyinelemeli kopya (csharp B9 testindeki desen). */
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
  // Her fixture kendi ALT DİZİNİNE kopyalanır (ts/cs/py/go/rs): Windows
  // dosya sistemi büyük/küçük harf duyarsızdır — C# fixture'ının
  // Services//Repositories/ dizinleri ile python/go fixture'larının
  // services//repositories/ dizinleri tek kökte BİRLEŞİRDI (kopya
  // çakışması); alt dizin düzeni hem çakışmayı hem de dil başına kutsal
  // kök düzenini garanti eder (fixture dizinleri salt-okunur kalır).
  const root = mkdtempSync(path.join(tmpdir(), "causoryn-m2-mixed-"));
  for (const [sub, fixture] of [
    ["ts", TS_FIXTURE],
    ["cs", CS_FIXTURE],
    ["py", PY_FIXTURE],
    ["go", GO_FIXTURE],
    ["rs", RS_FIXTURE],
  ] as const) {
    const subRoot = path.join(root, sub);
    mkdirSync(subRoot, { recursive: true });
    copyFixtureInto(fixture, subRoot);
  }
  return root;
}

interface MultilangServiceConfig {
  readonly pythonCommand?: string;
  readonly goBinaryPath?: string;
  readonly rustWorkerDir?: string;
}

function makeService(
  repository: InMemoryGraphRepository,
  root: string,
  config: MultilangServiceConfig = {},
  workspaceId = "m2-mixed",
): IndexService {
  return new IndexService({
    workspaceId,
    policy: WorkspaceAccessPolicy.create({ allowRoots: [root] }),
    repository,
    clock: () => FIXED_NOW,
    limits: { maxFiles: 50_000 },
    ...(config.pythonCommand === undefined ? {} : { python: { pythonCommand: config.pythonCommand } }),
    ...(config.goBinaryPath === undefined ? {} : { go: { goBinaryPath: config.goBinaryPath } }),
    ...(config.rustWorkerDir === undefined ? {} : { rust: { workerDir: config.rustWorkerDir } }),
  });
}

/* ------------------------------------------------------------------ */
/* INDEXED_ADAPTERS — beş adapter kaydı (get_capabilities yüzeyi)       */
/* ------------------------------------------------------------------ */

describe("INDEXED_ADAPTERS — beş adapter kaydı (M2)", () => {
  it("python/go/rust kayıtları gerçek worker kimlikleri + dürüst seviyelerle", () => {
    expect(INDEXED_ADAPTERS.map((a) => a.language)).toEqual([
      "typescript",
      "csharp",
      "python",
      "go",
      "rust",
    ]);

    const py = INDEXED_ADAPTERS.find((a) => a.language === "python");
    expect(py).toBeDefined();
    expect(py?.analyzerId).toBe("python-worker");
    expect(py?.version).toBe("0.1.0");
    expect(py?.source).toBe("adapters/python");
    expect(py?.levels.astParse).toBe("L1");
    expect(py?.levels.symbolResolution).toBe("L2");
    // Python worker frameworkLinkers=false beyan eder; L3 route katmanı
    // (dekoratör örüntüsü) bilgisinin dürüst taşıyıcısıdır (worker.py:1026).
    expect(py?.levels.frameworkLinkers).toContain("L3");

    const go = INDEXED_ADAPTERS.find((a) => a.language === "go");
    expect(go).toBeDefined();
    expect(go?.analyzerId).toBe("go-worker");
    expect(go?.version).toBe("0.1.0");
    expect(go?.source).toBe("adapters/go");
    expect(go?.levels.astParse).toBe("L1");
    // Dürüstlük: go/types semantik çözümleme yok — worker
    // symbolResolution=false beyan eder (cmd/worker/main.go:80); metadata
    // "L2" UYDURMAZ.
    expect(go?.levels.symbolResolution).not.toBe("L2");
    expect(go?.levels.symbolResolution).toContain("heuristic");
    expect(go?.levels.frameworkLinkers).toContain("L3");

    const rust = INDEXED_ADAPTERS.find((a) => a.language === "rust");
    expect(rust).toBeDefined();
    expect(rust?.analyzerId).toBe("rust-worker");
    expect(rust?.version).toBe("0.1.0");
    expect(rust?.source).toBe("adapters/rust");
    expect(rust?.levels.astParse).toBe("L1");
    // Dürüst gösterim: syn tabanlı çözümleme heuristic-ağırlıklıdır
    // (native/rust-worker/PROTOCOL.md resolution tablosu).
    expect(rust?.levels.symbolResolution).toContain("heuristic");
    // L3: attribute-macro route örüntüsü (protocol.rs:23).
    expect(rust?.levels.frameworkLinkers).toContain("macro");
    expect(rust?.levels.frameworkLinkers).toContain("L3");
  });
});

/* ------------------------------------------------------------------ */
/* Pozitif: 5 dil tek snapshot (gerçek worker koşumları)                */
/* ------------------------------------------------------------------ */

// Pozitif blok ÜÇ GERÇEK worker koşumu gerektirir (python/go/cargo);
// herhangi biri yoksa state 'partial' olur ve 'ready' beklentisi sert
// kırılırdı — meşru skip (koşulamadı raporu) ile korunur.
describe.skipIf(!(pythonAvailable && goAvailable && cargoAvailable))(
  "IndexService.runIndexAsync — TS + C# + Python + Go + Rust TEK snapshot (M2 pozitif)",
  () => {
  let mixedRoot = "";
  let firstRun: Awaited<ReturnType<IndexService["runIndexAsync"]>> | null = null;
  let secondCanonical = "";

  beforeAll(
    async () => {
      mixedRoot = makeMixedRoot();
      const firstRepository = new InMemoryGraphRepository();
      const service = makeService(firstRepository, mixedRoot, { goBinaryPath: GO_BINARY }, "m2-real");
      firstRun = await service.runIndexAsync(mixedRoot);

      // Determinizm: bağımsız ikinci servis, aynı kök.
      const secondRepository = new InMemoryGraphRepository();
      const secondService = makeService(secondRepository, mixedRoot, { goBinaryPath: GO_BINARY }, "m2-real");
      const secondRun = await secondService.runIndexAsync(mixedRoot);
      secondCanonical = snapshotCanonicalJson(secondRun.snapshot);
    },
    600_000,
  );

  // Dosya başlığındaki sözleşme ("geçici kökler kurulur ve silinir"):
  // beforeAll'ın kurdugu kök afterAll'da silinir (denetim bulgusu: bu
  // blok kalmıyordu ve her tam süit koşumu os.tmpdir() altında bir
  // causoryn-m2-mixed-* kalıntısı bırakıyordu).
  afterAll(() => {
    if (mixedRoot !== "") {
      rmSync(mixedRoot, { recursive: true, force: true });
    }
  });

  it("tek snapshot: beş dilin node katmanı bir arada, ready yayımlandı", () => {
    expect(firstRun).not.toBeNull();
    const run = firstRun as NonNullable<typeof firstRun>;
    expect(run.published).toBe(true);
    expect(run.snapshot.meta.state).toBe("ready");
    expect(run.fileCount).toBeGreaterThan(0);

    const byLang = (lang: string): number =>
      run.snapshot.nodes.filter((n) => n.kind === "File" && n.language === lang).length;
    expect(byLang("python")).toBe(3); // app.py + services + repositories
    expect(byLang("go")).toBe(3); // main.go + services + repositories
    expect(byLang("rust")).toBe(3); // main.rs + services.rs + repositories.rs
    expect(byLang("csharp")).toBe(4);

    const names = new Set(run.snapshot.nodes.map((n) => n.qualifiedName));
    // Python sembol katmanı (modül adı alt dizin düzeninden: py.*).
    expect(names.has("py.app.get_orders")).toBe(true);
    expect(names.has("py.services.orders_service.create_order")).toBe(true);
    expect(names.has("py.repositories.order_repository.save")).toBe(true);
    // Go sembol katmanı (package temelli — yol bağımsız).
    expect(names.has("main.ordersHandler")).toBe(true);
    expect(names.has("main.newOrderService")).toBe(true);
    // Rust sembol katmanı (crate::rs:: modül öneki alt dizinden).
    expect(names.has("crate::rs::list_orders")).toBe(true);
    expect(names.has("crate::rs::services::OrdersService::create")).toBe(true);
    // TS + C# katmanları (B9 sözleşmesi bozulmadı).
    expect(names.has("OrdersService.create")).toBe(true);
    expect(names.has("Causoryn.Fixture.Orders.Services.OrdersService.Create")).toBe(true);
  });

  it("dangling edge yok + verified kenarlar kanıtlı + beş dilin zinciri tek graph'ta", () => {
    const run = firstRun as NonNullable<typeof firstRun>;
    const nodeIds = new Set(run.snapshot.nodes.map((n) => n.id));
    for (const edge of run.snapshot.edges) {
      expect(nodeIds.has(edge.from), `dangling from: ${edge.id}`).toBe(true);
      expect(nodeIds.has(edge.to), `dangling to: ${edge.id}`).toBe(true);
      if (edge.resolution === "verified") {
        expect(edge.evidenceIds.length).toBeGreaterThanOrEqual(1);
      }
    }
    const byId = new Map(run.snapshot.nodes.map((n) => [n.id, n]));
    const endpointNames = run.snapshot.edges
      .filter((e) => e.kind === "ROUTES_TO")
      .map((e) => byId.get(e.from)?.qualifiedName ?? "")
      .sort();
    // C# + Python route katmanları TEK snapshot'ta.
    expect(endpointNames).toContain("POST /api/Orders"); // C#
    expect(endpointNames).toContain("GET /orders"); // Python + Rust
    expect(endpointNames).toContain("POST /orders"); // Python + Rust
    expect(endpointNames).toContain("* /orders"); // Go (http.HandleFunc)
    expect(endpointNames).toContain("* /health"); // Go

    // CALLS zincirleri: her dilin en az bir verified çağrısı graph'ta.
    const verifiedCallTargets = new Set(
      run.snapshot.edges
        .filter((e) => e.kind === "CALLS" && e.resolution === "verified")
        .map((e) => byId.get(e.to)?.qualifiedName ?? ""),
    );
    // py: create_order → _validate_order AYNI modülde tanımlı (verified;
    // app.add_order → create_order ise import temelli heuristic'tir).
    expect(verifiedCallTargets.has("py.services.orders_service._validate_order")).toBe(true);
    expect(verifiedCallTargets.has("py.repositories.order_repository.save")).toBe(true); // py: Method.save → modül fn
    expect(verifiedCallTargets.has("crate::rs::create_audit_entry")).toBe(true); // rust
    expect(verifiedCallTargets.has("main.newOrderService")).toBe(true); // go

    // Workspace → File CONTAINS beş dilin dosyalarını kapsar.
    const workspaceNode = run.snapshot.nodes.find((n) => n.kind === "Workspace");
    expect(workspaceNode).toBeDefined();
    const contains = run.snapshot.edges.filter(
      (e) => e.kind === "CONTAINS" && e.from === workspaceNode?.id,
    );
    // 4 C# + tüm TS + 3 python + 3 go + 3 rust File node'u.
    const totalFileNodes = run.snapshot.nodes.filter((n) => n.kind === "File").length;
    expect(contains.length).toBe(totalFileNodes);
    expect(totalFileNodes).toBeGreaterThanOrEqual(4 + 3 + 3 + 3);
  });

  it("analyzerFingerprint: koşuma katılan beş analyzer segmenti + worker durumları + ayar hash'leri", () => {
    const run = firstRun as NonNullable<typeof firstRun>;
    const segments = run.snapshot.meta.analyzerFingerprint.split("|");
    expect(segments[0]).toBe("fp3");
    expect(segments).toContain("ts-adapter@0.1.0");
    expect(segments).toContain("roslyn-worker@0.1.0");
    expect(segments).toContain("python-worker@0.1.0");
    expect(segments).toContain("go-worker@0.1.0");
    expect(segments).toContain("rust-worker@0.1.0");
    // Worker durumları: hepsi healthy koştu.
    expect(segments).toContain("pystate=ready");
    expect(segments).toContain("gostate=ready");
    expect(segments).toContain("ruststate=ready");
    // Etkin ayar hash'leri: 16 hex.
    expect(segments.some((s) => /^pyopts=[0-9a-f]{16}$/.test(s))).toBe(true);
    expect(segments.some((s) => /^goopts=[0-9a-f]{16}$/.test(s))).toBe(true);
    expect(segments.some((s) => /^rustopts=[0-9a-f]{16}$/.test(s))).toBe(true);
  });

  it("determinizm: iki bağımsız kurulum aynı canonical JSON (TŞ §8 invariant vi)", () => {
    const run = firstRun as NonNullable<typeof firstRun>;
    const firstCanonical = snapshotCanonicalJson(run.snapshot);
    expect(firstCanonical.length).toBeGreaterThan(0);
    expect(secondCanonical).toBe(firstCanonical);
  });
});

/* ------------------------------------------------------------------ */
/* Degrade: bir worker yok → diğerleri yaşar. gostate/ruststate=ready  */
/* kanıtladığından go + cargo VARLIĞI gerektirir (python bilinçli      */
/* sahte-yoktur); eksikse meşru skip.                                  */
/* ------------------------------------------------------------------ */

describe.skipIf(!(goAvailable && cargoAvailable))(
  "IndexService.runIndexAsync — bir worker yok → diğerleri yaşar (M2 degrade)",
  () => {
  it("negatif (bir worker yok → diğerleri yaşar): olmayan python komutu → Python L0/L1, TS+C#+Go+Rust dolu", async () => {
    const root = makeMixedRoot();
    try {
      const repository = new InMemoryGraphRepository();
      const service = makeService(
        repository,
        root,
        { pythonCommand: "olmayan-python-komutu", goBinaryPath: GO_BINARY },
        "m2-degrade-py",
      );
      const run = await service.runIndexAsync(root);
      expect(run.published).toBe(true);
      expect(run.snapshot.meta.state).toBe("partial");
      const names = new Set(run.snapshot.nodes.map((n) => n.qualifiedName));
      // Python: yalnızca L0 File node'ları (uydurma sembol yok).
      const pyFiles = run.snapshot.nodes.filter(
        (n) => n.kind === "File" && n.language === "python",
      );
      expect(pyFiles.length).toBe(3);
      expect(names.has("py.app.get_orders")).toBe(false);
      // Diğerleri yaşadı: TS + C# + Go + Rust sembolleri üretilir.
      expect(names.has("OrdersService.create")).toBe(true);
      expect(names.has("Causoryn.Fixture.Orders.Services.OrdersService.Create")).toBe(true);
      expect(names.has("main.ordersHandler")).toBe(true);
      expect(names.has("crate::rs::list_orders")).toBe(true);
      // Explicit degradasyon warning'i (adapter fallback sözleşmesi).
      expect(
        run.warnings.some(
          (w) => w.includes("Python worker kullanılamıyor") && w.includes("L0/L1"),
        ),
      ).toBe(true);
      // Fingerprint dürüstçülüğü: Python worker koşamadı.
      const segments = run.snapshot.meta.analyzerFingerprint.split("|");
      expect(segments).toContain("pystate=worker-unavailable");
      expect(segments).toContain("gostate=ready");
      expect(segments).toContain("ruststate=ready");
      // Motor ayakta.
      expect(repository.getLatestPublished("m2-degrade-py")?.stale).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});

/* Degrade-all: HİÇBİR toolchain gerektirmez — üç worker komutu bilinçli
   'olmayan-*' adlardır, rust workerDir yoktur; TS analizi saf TS'tir. */
describe(
  "IndexService.runIndexAsync — üç yeni worker da yok (toolchain'siz koşar; M2 degrade)",
  () => {
  it("negatif (üç yeni worker da yok): py/go/rs L0 File node'ları + explicit warning; TS ayakta; motor çökmez", async () => {
    const root = makeMixedRoot();
    try {
      const repository = new InMemoryGraphRepository();
      const service = makeService(
        repository,
        root,
        {
          pythonCommand: "olmayan-python-komutu",
          goBinaryPath: "olmayan-go-komutu",
          rustWorkerDir: path.join(tmpdir(), "causoryn-m2-olmayan-rust-dir"),
        },
        "m2-degrade-all",
      );
      const run = await service.runIndexAsync(root);
      expect(run.published).toBe(true);
      expect(run.snapshot.meta.state).toBe("partial");
      const names = new Set(run.snapshot.nodes.map((n) => n.qualifiedName));
      // TS dolu; py/go/rs sembol YOK (uydurma yok), L0 File node'ları var.
      expect(names.has("OrdersService.create")).toBe(true);
      expect(names.has("py.app.get_orders")).toBe(false);
      expect(names.has("main.ordersHandler")).toBe(false);
      expect(names.has("crate::rs::list_orders")).toBe(false);
      for (const [lang, count] of [
        ["python", 3],
        ["go", 3],
        ["rust", 3],
      ] as const) {
        const files = run.snapshot.nodes.filter(
          (n) => n.kind === "File" && n.language === lang,
        );
        expect(files.length).toBe(count);
        for (const file of files) {
          expect(typeof file.attributes["sourceHash"]).toBe("string");
          expect((file.attributes["sourceHash"] as string).length).toBeGreaterThan(0);
        }
      }
      // Explicit fallback uyarıları (adapter sözleşmesi).
      expect(
        run.warnings.some((w) => w.includes("Python worker kullanılamıyor") && w.includes("L0/L1")),
      ).toBe(true);
      expect(
        run.warnings.some((w) => w.includes("Go worker kullanılamıyor") && w.includes("L0/L1")),
      ).toBe(true);
      expect(
        run.warnings.some(
          (w) =>
            (w.includes("Rust worker") || w.includes("cargo")) && w.includes("L0/L1"),
        ),
      ).toBe(true);
      // Fingerprint: üç worker da yok.
      const segments = run.snapshot.meta.analyzerFingerprint.split("|");
      expect(segments).toContain("pystate=worker-unavailable");
      expect(segments).toContain("gostate=worker-unavailable");
      expect(segments).toContain("ruststate=worker-unavailable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});

/* ------------------------------------------------------------------ */
/* Senkron köprü dürüstlüğü: runIndex py/go/rs'i L0'da tutar            */
/* ------------------------------------------------------------------ */

describe("IndexService.runIndex — senkron koşum Python/Go/Rust derin analiz yürütmez (M2 köprü sözleşmesi)", () => {
  it("karışık workspace senkron koşum: TS dolu + py/go/rs L0 + explicit warning + partial; worker SPAWN EDİLMEZ", () => {
    const root = makeMixedRoot();
    try {
      const repository = new InMemoryGraphRepository();
      // Olmayan worker ayarlarıyla koş: senkron yol adapter'lara SPAWN
      // ATMAMALI — spawn atılsaydı adapter fallback uyarıları
      // ("... kullanılamıyor") warnings'e girerdi; köprü sözleşmesinde
      // o uyarılar YOKTUR (csharp köprü testiyle aynı kural).
      const service = makeService(
        repository,
        root,
        {
          pythonCommand: "olmayan-python-komutu",
          goBinaryPath: "olmayan-go-komutu",
          rustWorkerDir: path.join(tmpdir(), "causoryn-m2-olmayan-rust-dir"),
        },
        "m2-sync",
      );
      const run = service.runIndex(root);
      expect(run.published).toBe(true);
      expect(run.snapshot.meta.state).toBe("partial");
      // TS sembol katmanı tam.
      const names = new Set(run.snapshot.nodes.map((n) => n.qualifiedName));
      expect(names.has("OrdersService.create")).toBe(true);
      // py/go/rs: yalnızca L0 File node'ları.
      expect(names.has("py.app.get_orders")).toBe(false);
      expect(names.has("main.ordersHandler")).toBe(false);
      expect(names.has("crate::rs::list_orders")).toBe(false);
      const pyFiles = run.snapshot.nodes.filter(
        (n) => n.kind === "File" && n.language === "python",
      );
      expect(pyFiles.length).toBe(3);
      const goFiles = run.snapshot.nodes.filter(
        (n) => n.kind === "File" && n.language === "go",
      );
      expect(goFiles.length).toBe(3);
      const rsFiles = run.snapshot.nodes.filter(
        (n) => n.kind === "File" && n.language === "rust",
      );
      expect(rsFiles.length).toBe(3);
      // Explicit köprü uyarıları: hangi yolun neden kullanılamadığı açık.
      for (const lang of ["Python", "Go", "Rust"]) {
        expect(
          run.warnings.some(
            (w) => w.includes(`synchronous run cannot perform deep ${lang} symbol analysis`) && w.includes("runIndexAsync"),
          ),
          `senkron köprü uyarısı eksik: ${lang}`,
        ).toBe(true);
      }
      // Spawn atılmadı: adapter fallback uyarıları yok.
      expect(run.warnings.some((w) => w.includes("worker kullanılamıyor"))).toBe(false);
      // Fingerprint: senkron koşum worker'ları başlatmadı — dürüst etiket.
      const segments = run.snapshot.meta.analyzerFingerprint.split("|");
      expect(segments).toContain("pystate=sync-run-degraded");
      expect(segments).toContain("gostate=sync-run-degraded");
      expect(segments).toContain("ruststate=sync-run-degraded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("incremental (senkron): .py içerik değişimi → YENİ snapshot; değişimsiz koşum no-op", () => {
    const root = makeMixedRoot();
    try {
      const repository = new InMemoryGraphRepository();
      const service = makeService(repository, root, {}, "m2-inc");
      const initial = service.runIndex(root);
      expect(initial.published).toBe(true);

      // No-op: değişiklik yok.
      const noop = service.runIncrementalIndex(root, []);
      expect(noop.published).toBe(false);
      expect(noop.snapshotId).toBe(initial.snapshotId);

      // .py içerik değişimi → YENİ snapshot (Python karma karşılaştırması).
      const pyPath = path.join(root, "py", "services", "orders_service.py");
      const original = readFileSync(pyPath, "utf8");
      writeFileSync(pyPath, original + "\n# m2 incremental probe\n", "utf8");
      const rebuilt = service.runIncrementalIndex(root, ["py/services/orders_service.py"]);
      expect(rebuilt.published).toBe(true);
      expect(rebuilt.snapshotId).not.toBe(initial.snapshotId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
