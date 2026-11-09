import { statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { BenchReport, MeasurementRow } from "./benchmark.js";

/**
 * F7 benchmark docs tablosu üretimi (docs/benchmarks.md).
 *
 * Dürüstlük sözleşmesi (TŞ v2.1 §21 + ADR-010): hedef değerler (<1 sn,
 * <500 ms, <2 sn) TŞ'de TASARIM HEDEFİ olarak verilmiştir — tabloda
 * REFERANS kolonu olarak taşınır, sonuç gibi sunulmaz. Değerlendirme
 * kolonu ölçülen medyanı hedef referansıyla karşılaştırır; ölçülemeyen
 * satır "not measured (<neden>)" olarak raporlanır, asla uydurulmaz.
 *
 * Yazım disiplini: writeBenchmarksDoc yalnızca basename whitelist'i
 * ("benchmarks.md") ve üst dizin adı ("docs") ile geçen yola yazar —
 * başka bir hedef yol explicit hata ile reddedilir (statik güvenlik kuralı;
 * ADR-008: normal vitest koşumu depoya yazmaz, yazım yalnızca
 * CAUSORYN_BENCH_WRITE_DOCS=1 ile açıkça istendiğinde olur).
 */

function formatMs(value: number): string {
  return value.toFixed(1);
}

function runsCell(row: MeasurementRow): string {
  if (row.runs === null) return "—";
  return row.runs.map((sample) => formatMs(sample)).join(" / ");
}

function medianCell(row: MeasurementRow): string {
  return row.medianMs === null ? "—" : formatMs(row.medianMs);
}

/** Değerlendirme: ölçülen medyan hedef referansıyla karşılaştırılır. */
function verdictCell(row: MeasurementRow): string {
  if (row.status !== "measured" || row.medianMs === null) {
    const reason = row.reason ?? "neden bildirilmedi";
    return `not measured (${reason}) — hedef aşıldı değil — ölçüm yok`;
  }
  if (row.medianMs < row.targetMs) {
    return `hedef içinde (referans < ${String(row.targetMs)} ms)`;
  }
  return (
    `hedef aşıldı (medyan ${formatMs(row.medianMs)} ms; ` +
    `referans < ${String(row.targetMs)} ms)`
  );
}

function rowLine(row: MeasurementRow): string {
  return [
    row.id,
    `\`${row.tool}\` ${row.call}`,
    `< ${String(row.targetMs)} ms`,
    runsCell(row),
    medianCell(row),
    verdictCell(row),
  ].join(" | ");
}

/**
 Koşum raporundan tam docs/benchmarks.md içeriğini üretir (yazım yapmaz).
 */
export function renderBenchmarksDoc(report: BenchReport): string {
  const lines: string[] = [];
  lines.push("# Causoryn Performans Benchmark — Faz F / Sprint 7 (F7)");
  lines.push("");
  lines.push(
    "> Kanıt: raw/Causoryn_Teknik_Dokuman_v2.1.pdf §21 (s.22): " +
      '"1.000 TS dosyası fixture üzerinde sıcak workspace_summary <1 sn, ' +
      "küçük graph neighborhood <500 ms, sınırlı 200 node map <2 sn\". " +
      "TŞ bu rakamları **tasarım hedefi** olarak verir ve açıkça şunu söyler: " +
      '"bu rakamlar tasarım hedefi, gerçekleşmiş test sonucu değildir". ' +
      "Dolayısıyla aşağıdaki hedef kolonu **referans**tır, sonuç değil; " +
      "tabloda yalnızca ölçülen değerler raporlanır.",
  );
  lines.push(
    "> ADR-010 dürüstlük kuralı: ölçülemeyen şey ölçülmüş yazılmaz — " +
      "ortam kesintisi/deadline aşımı olan satır `not measured (<neden>)` olarak raporlanır.",
  );
  lines.push("");
  lines.push("## Ölçüm yöntemi");
  lines.push("");
  lines.push(`- Fixture: deterministik sentetik TypeScript workspace, ${String(report.fileCount)} dosya ` +
    `(üretici: \`tests/bench-release/fixture.ts\`; aynı fileCount → bayt-bayt aynı içerik; sha256: \`${report.fixtureHash}\`).`);
  lines.push(`- ${report.timingMethod}.`);
  lines.push(`- Koşum başına çağrı deadline'ı: ${String(report.callDeadlineMs)} ms.`);
  lines.push(
    `- Soğuk indeks (bilgi amaçlı): sabit süre vaadi yoktur (TŞ §21); ` +
      (report.coldIndexMs === null
        ? "ölçülemedi."
        : `ölçülen: ${formatMs(report.coldIndexMs)} ms (${String(report.fileCount)} dosya).`),
  );
  lines.push(
    `- Snapshot durumu: ${report.indexState}; adapter tanısı (TŞ §21 parse_errors metriği): ` +
      `${String(report.diagnosticCount)}` +
      (report.diagnosticCount > 0
        ? ` — ilk tanılar: ${report.firstDiagnostics.join(" | ")}`
        : " (fixture tanısız; state=ready)"),
  );
  lines.push(
    `- Ortam: node ${report.environment.nodeVersion}, ${report.environment.platform}, ` +
      `CPU: ${report.environment.cpuModel}, bellek: ${String(Math.round(report.environment.totalMemBytes / (1024 * 1024 * 1024)))} GB.`,
  );
  lines.push(
    "- Yeniden üretim: `CAUSORYN_BENCH_WRITE_DOCS=1 npx vitest run tests/bench-release/benchmark.test.ts` " +
      "(varsayılan vitest koşumu depoya yazmaz — ADR-008 salt-okunur test disiplini).",
  );
  lines.push("");
  lines.push(`## Sonuçlar — koşum ${report.startedAt}`);
  lines.push("");
  lines.push(
    "| Ölçüm | Araç çağrısı | Hedef (TŞ §21 referans — tasarım hedefi, sonuç değil) | " +
      `Koşumlar (ms, N=${String(report.runsPerMeasurement)}) | Medyan (ms) | Değerlendirme |`,
  );
  lines.push("|---|---|---|---|---|---|");
  for (const row of report.rows) {
    lines.push(`| ${rowLine(row)} |`);
  }
  lines.push("");
  lines.push("## Notlar");
  lines.push("");
  lines.push(
    "- Ölçümler MCP protokol düzeyinde yapılmıştır: motor + input validasyonu + " +
      "envelope üretimi çağrı süresinin tamamı içindedir.",
  );
  lines.push(
    "- Tek koşum içi değerler makine yüküne duyarlıdır; karşılaştırma için " +
      "medyan kolonu esas alınır. Aynı girdi (fileCount + hash) her koşumda " +
      "birebir aynı fixture'ı üretir — ölçüm gürültüsü yalnızca zamandan gelir.",
  );
  lines.push("");
  return lines.join("\n");
}

/** Yalnızca docs/benchmarks.md hedefi kabul edilir (basename whitelist). */
export function writeBenchmarksDoc(docsPath: string, report: BenchReport): void {
  const resolved = path.resolve(docsPath);
  const base = path.basename(resolved);
  const parentName = path.basename(path.dirname(resolved));
  if (base !== "benchmarks.md" || parentName !== "docs") {
    throw new Error(
      `writeBenchmarksDoc yalnızca docs/benchmarks.md hedefini kabul eder (istenen: ${resolved})`,
    );
  }
  let parentIsDir = false;
  try {
    parentIsDir = statSync(path.dirname(resolved)).isDirectory();
  } catch {
    parentIsDir = false;
  }
  if (!parentIsDir) {
    throw new Error(
      `docs hedef dizini mevcut değil (yanlış repo kökü beyanı olabilir): ${path.dirname(resolved)}`,
    );
  }
  writeFileSync(resolved, renderBenchmarksDoc(report), "utf8");
}
