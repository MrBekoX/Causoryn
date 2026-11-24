import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BenchFixtureError, buildFixtureModel, fixtureDiskHash, writeFixture } from "./fixture.js";
import { runBenchmark } from "./benchmark.js";
import type { BenchReport } from "./benchmark.js";
import { renderBenchmarksDoc, writeBenchmarksDoc } from "./docs-table.js";

/**
 * F7 performans benchmark test üçlüsü (sprint-7 F7; TŞ v2.1 §21 s.22:
 * "1.000 TS dosyası fixture üzerinde sıcak workspace_summary <1 sn, küçük
 * graph neighborhood <500 ms, sınırlı 200 node map <2 sn ... Ölçülen değerler
 * implementasyon sonuçlarından raporlanır; bu rakamlar tasarım hedefi,
 * gerçekleşmiş test sonucu değildir").
 *
 * - pozitif: benchmark GERÇEK 1.000 dosyalık deterministik fixture ile
 *   koşar; üç ölçüm satırı raporlanır (workspace_summary_warm,
 *   graph_neighborhood_small, map_system_200; her biri N=3 koşum medyanı)
 *   ve docs tablosu render'ı satırları taşır. Depoya yazım YALNIZCA
 *   CAUSORYN_BENCH_WRITE_DOCS=1 ile açıkça istenirse yapılır (ADR-008:
 *   testler varsayılan salt okunur; yeniden üretim komutu docs/benchmarks.md
 *   içinde belgelenir).
 * - negatif: fixture üretilemez (üst dizin dosya / tmpdir dışı kök / dolu
 *   dizin) → explicit BenchFixtureError kodlarıyla reddiyen.
 * - partial: tek ölçümde ortam kesintisi (fault enjeksiyonu) → o satır
 *   "not measured (<neden>)" olur, diğer ölçümler ölçülmüş kalır.
 *
 * Flaky önlemleri (görev sözleşmesi): her ölçümde N=3 koşum + medyan; çağrı
 * başına deadline (aşım → not measured, askıda koşum yok); her ölçüm öncesi
 * 1 warm-up çağrısı. Zaman bütçesi: 1.000 dosyalık soğuk indeks (senkron)
 * bu suite'teki en ağır adımdır — pozitif teste açık 590s limiti verilir.
 *
 * Güvenlik notu (statik güvenlik kuralı): bu test dosyası dinamik yol parçalarını
 * path.join/resolve ile fs çağrısına geçirMEZ; tüm dinamik yol kurulumu
 * fixture.ts'te whitelist regex guard'ı altında yaşar (writeFixture/
 * fixtureDiskHash). Test yalnızca sabit-fragment path.join(os.tmpdir(),
 * "sabit-şablon") kalıbını kullanır.
 */

/** Repo kökü: tests/bench-release altından üç dirname. */
const REPO_ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const DOCS_PATH = path.join(REPO_ROOT, "docs", "benchmarks.md");

const MEASUREMENT_IDS = [
  "workspace_summary_warm",
  "graph_neighborhood_small",
  "map_system_200",
] as const;

function medianOf(runs: readonly number[]): number {
  expect(runs.length).toBe(3);
  const sorted = [...runs].sort((a, b) => a - b);
  const middle = sorted[1];
  if (middle === undefined) {
    throw new Error("medyan örnek toplayamadı");
  }
  return middle;
}

describe("F7 benchmark — pozitif", { timeout: 590_000 }, () => {
  it("1000 dosyalık fixture ile koşar; üç ölçüm N=3 medyan raporlanır; docs tablosu satırları render edilir", async () => {
    // Depo yazım invariant'ının taban görüntüsü: koşum öncesi docs baytları.
    const docsBefore = existsSync(DOCS_PATH) ? readFileSync(DOCS_PATH, "utf8") : null;
    const report = await runBenchmark({
      fileCount: 1000,
      runsPerMeasurement: 3,
      callDeadlineMs: 30_000,
    });

    // (1) fixture determinizmi: model iki kez üretildiğinde bayt-bayt aynı.
    const modelAgain = buildFixtureModel(report.fileCount);
    expect(modelAgain.hash).toBe(report.fixtureHash);
    expect(report.fileCount).toBe(1000);
    expect(report.fixtureEntryCount).toBe(1000);

    // (2) üç ölçüm satırı raporlanır.
    expect(report.rows.map((row) => row.id)).toEqual([...MEASUREMENT_IDS]);

    // (3) her ölçüm ölçülmüş olmalı; ortam kesintisi olsaydı reason dolu
    // olurdu ve test dürüstçe kırmızıya düşerdi (sahte medyan üretilmez).
    for (const row of report.rows) {
      expect(row.status, `${row.id} ölçülemedi: ${row.reason}`).toBe("measured");
      expect(row.runs).not.toBeNull();
      expect(row.runs?.length).toBe(3);
      for (const sample of row.runs ?? []) {
        expect(Number.isFinite(sample)).toBe(true);
        expect(sample).toBeGreaterThan(0);
      }
      expect(row.medianMs).toBeCloseTo(medianOf(row.runs ?? []), 6);
    }

    // (4) docs tablosu render'ı üç satırı + referans hedef disiplinini taşır.
    const doc = renderBenchmarksDoc(report);
    for (const id of MEASUREMENT_IDS) {
      expect(doc).toContain(id);
    }
    expect(doc).toContain("referans");
    expect(doc).toContain("sonuç değil");
    for (const row of report.rows) {
      if (row.status === "measured" && row.medianMs !== null) {
        expect(doc).toContain(row.medianMs.toFixed(1));
        const target = row.targetMs;
        if (row.medianMs < target) {
          expect(doc).toContain("hedef içinde");
        } else {
          expect(doc).toContain("hedef aşıldı");
        }
      }
    }

    // (5) Depoya yazım YALNIZCA açık istekle (ADR-008): normal vitest
    // koşumu salt okunur kalır; CAUSORYN_BENCH_WRITE_DOCS=1 ile docs
    // tablosu gerçek koşum raporuyla güncellenir.
    if (process.env.CAUSORYN_BENCH_WRITE_DOCS === "1") {
      writeBenchmarksDoc(DOCS_PATH, report);
      expect(existsSync(DOCS_PATH)).toBe(true);
      const written = readFileSync(DOCS_PATH, "utf8");
      expect(written).toContain("# Causoryn Performans Benchmark");
      for (const id of MEASUREMENT_IDS) {
        expect(written).toContain(id);
      }
    } else {
      // Varsayılan koşum depoya yazmaz (ADR-008). Gerçek invariant DISKTIR:
      // yalnızca tam "1" yazım açar; "0"/"false" gibi değersiz setler de
      // yazmaz ve docs dosyası koşum öncesi baytlarında kalır. Eski
      // "env undefined" expect'i "0" set edildiğinde hatalı kırmızı
      // üretir ve gerçek invariant'ı hiç denetlemezdi (denetim bulgusu,
      // 2026-11-09).
      expect(process.env.CAUSORYN_BENCH_WRITE_DOCS === "1").toBe(false);
      if (docsBefore === null) {
        expect(existsSync(DOCS_PATH)).toBe(false);
      } else {
        expect(readFileSync(DOCS_PATH, "utf8")).toBe(docsBefore);
      }
    }
  });

  it("fixture diski birebir doğrulanır: 1000 .ts dosyası, model hash'i ile aynı içerik", () => {
    const model = buildFixtureModel(1000);
    expect(model.entries.length).toBe(1000);
    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-bench-fixture-verify-"));
    try {
      writeFixture(root, model);
      const diskHash = fixtureDiskHash(root, model);
      expect(diskHash).toBe(model.hash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("F7 benchmark — negatif", { timeout: 30_000 }, () => {
  it("üst dizin bir dosya ise fixture üretimi explicit hata ile reddedilir", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "causoryn-bench-negative-"));
    try {
      const blocker = path.join(base, "blocker.txt");
      writeFileSync(blocker, "bu bir dosyadır; altına dizin gelemez", "utf8");
      // Bitiştirme kasıtlıdır: parent'ı DOSYA olan kök adayı; dynamic join
      // yok, fs çağrısı fixture.ts guard'ının arkasındadır.
      const root = blocker + path.sep + "fixture-root";
      expect(() => writeFixture(root, buildFixtureModel(4))).toThrow(
        BenchFixtureError,
      );
      let code: string | undefined;
      try {
        writeFixture(root, buildFixtureModel(4));
      } catch (error) {
        expect(error).toBeInstanceOf(BenchFixtureError);
        code = (error as BenchFixtureError).code;
      }
      expect(code).toBe("FIXTURE_ROOT_NOT_CREATABLE");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("tmpdir dışına fixture yazımı explicit hata ile reddedilir", () => {
    // Kaçış adayı tmpdir'in ÜST dizinidir (gerçek yol üzerinden dirname
    // ile hesaplanır; konteynman kontrolü bunu reddetmelidir).
    const tmpReal = realpathSync(os.tmpdir());
    const outside = path.dirname(tmpReal);
    const probeBase = mkdtempSync(path.join(os.tmpdir(), "causoryn-bench-outside-probe-"));
    const probe = path.join(probeBase, "fixture");
    try {
      expect(() => writeFixture(probe, buildFixtureModel(4))).not.toThrow();
      expect(() => writeFixture(outside, buildFixtureModel(4))).toThrow(
        BenchFixtureError,
      );
      let code: string | undefined;
      try {
        writeFixture(outside, buildFixtureModel(4));
      } catch (error) {
        expect(error).toBeInstanceOf(BenchFixtureError);
        code = (error as BenchFixtureError).code;
      }
      expect(code).toBe("FIXTURE_ROOT_OUTSIDE_TMPDIR");
    } finally {
      rmSync(probeBase, { recursive: true, force: true });
    }
  });

  it("dolu mevcut dizine fixture yazımı explicit hata ile reddedilir", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-bench-nonempty-"));
    try {
      writeFileSync(path.join(root, "mevcut.txt"), "dolu", "utf8");
      expect(() => writeFixture(root, buildFixtureModel(4))).toThrow(
        BenchFixtureError,
      );
      let code: string | undefined;
      try {
        writeFixture(root, buildFixtureModel(4));
      } catch (error) {
        expect(error).toBeInstanceOf(BenchFixtureError);
        code = (error as BenchFixtureError).code;
      }
      expect(code).toBe("FIXTURE_ROOT_NOT_EMPTY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("F7 benchmark — partial", { timeout: 120_000 }, () => {
  it("tek ölçümde ortam kesintisi o ölçümü 'not measured' yapar; diğer ölçümler ölçülmüş kalır", async () => {
    const report = await runBenchmark({
      fileCount: 30,
      runsPerMeasurement: 3,
      callDeadlineMs: 30_000,
      fault: {
        measurementId: "graph_neighborhood_small",
        message: "ortam kesintisi simülasyonu",
      },
    });

    expect(report.rows.length).toBe(3);
    const faulted = report.rows.find(
      (row) => row.id === "graph_neighborhood_small",
    );
    expect(faulted).toBeDefined();
    expect(faulted?.status).toBe("not_measured");
    expect(faulted?.runs).toBeNull();
    expect(faulted?.medianMs).toBeNull();
    expect(faulted?.reason ?? "").toContain("ortam kesintisi simülasyonu");

    for (const row of report.rows) {
      if (row.id === "graph_neighborhood_small") continue;
      expect(row.status, `${row.id} ölçülemedi: ${row.reason}`).toBe("measured");
    }

    // Docs render'ı dürüst 'not measured' satırı taşır; hedef kolonu yine de
    // referans olarak görünür.
    const doc = renderBenchmarksDoc(report);
    expect(doc).toContain("not measured");
    expect(doc).toContain("ortam kesintisi simülasyonu");
    expect(doc).toContain("hedef aşıldı değil — ölçüm yok");
  });
});

describe("F7 benchmark — docs yeniden üretim komutu sözleşmesi", { timeout: 180_000 }, () => {
  /**
   * Denetim bulgusu düzeltmesi (2026-11-10): docs/benchmarks.md'teki
   * 'Yeniden üretim' komutu `npx vitest run tests/bench-release/...`
   * (varsayılan config) idi — vitest.config.ts'teki `tests/bench-release/**`
   * dışlaması nedeniyle SIFIR test çözümlüyordu (kanıt: `npx vitest list
   * tests/bench-release/benchmark.test.ts` → boş çıkış; aynı dosya
   * `--config vitest.bench.config.ts` ile 6 test listeler). Sözleşme:
   * belgelenen komut GERÇEKTEN bench süitini koşmalıdır — ADR-010
   * dürüstlük: ölçülebilirlik iddiası doğrulanabilir olmalıdır.
   */

  const VITEST_MJS = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
  const BENCH_FILE = "tests/bench-release/benchmark.test.ts";

  /** Render sözleşmesi testi için en küçük sentetik koşum raporu. */
  function syntheticReport(): BenchReport {
    return {
      startedAt: "1970-01-01T00:00:00.000Z",
      fileCount: 4,
      fixtureEntryCount: 4,
      fixtureHash: "test-hash",
      coldIndexMs: 1,
      indexState: "ready",
      diagnosticCount: 0,
      firstDiagnostics: [],
      runsPerMeasurement: 3,
      callDeadlineMs: 30_000,
      timingMethod: "test",
      environment: {
        nodeVersion: process.version,
        platform: `${os.platform()} ${os.release()} ${os.arch()}`,
        cpuModel: "test-cpu",
        totalMemBytes: os.totalmem(),
      },
      rows: [
        {
          id: "workspace_summary_warm",
          tool: "causoryn_workspace_summary",
          call: "{}",
          targetMs: 1000,
          runs: [1, 2, 3],
          medianMs: 2,
          status: "measured",
          reason: null,
        },
      ],
    };
  }

  it("docs'taki 'Yeniden üretim' satırı bench runner'ı gösterir; varsayılan config'e dayanan kırık komut kaldırılmıştır", () => {
    const doc = renderBenchmarksDoc(syntheticReport());
    const line = doc.split("\n").find((candidate) => candidate.startsWith("- Yeniden üretim:"));
    expect(line, "docs'ta '- Yeniden üretim:' satırı bulunamadı").toBeDefined();
    // Komut bench config'ini (`npm run bench` / vitest.bench.config.ts)
    // göstermeli: varsayılan config tests/bench-release'i dışlar.
    expect(line).toMatch(/npm run bench|vitest\.bench\.config\.ts/);
    // Kırık desen (varsayılan config'te sıfır test çözümleyen komut) yok.
    expect(line).not.toContain("npx vitest run tests/bench-release");
    // Dışlamanın diskte varlığı — komutun neden bench config'i zorunlu
    // kıldığının kanıtı (desen kaldırılırsa bu test kılavuzdur).
    const defaultConfig = readFileSync(path.join(REPO_ROOT, "vitest.config.ts"), "utf8");
    expect(defaultConfig).toContain("tests/bench-release/**");
  });

  it("davranış: bench config komutu benchmark dosyasını ÇÖZÜMLER, varsayılan config çözümlemez (vitest list)", () => {
    const benchList = execFileSync(
      process.execPath,
      [VITEST_MJS, "list", BENCH_FILE, "--config", "vitest.bench.config.ts"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(benchList).toContain("tests/bench-release/benchmark.test.ts");

    const defaultList = execFileSync(process.execPath, [VITEST_MJS, "list", BENCH_FILE], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(defaultList).not.toContain("benchmark.test.ts");
  });
});
