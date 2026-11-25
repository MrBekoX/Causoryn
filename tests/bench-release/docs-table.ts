import { statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { BenchReport, MeasurementRow } from "./benchmark.js";

/**
 * Renders docs/benchmarks.md (Turkish) from a benchmark run report.
 *
 * Honesty contract: the target values (< 1 s, < 500 ms, < 2 s) are design
 * targets from the original design document. They are rendered as a
 * reference column, never as results. The verdict column compares the
 * measured median with that reference; a row that could not be measured is
 * rendered as "not measured (<reason>)" and no number is invented for it.
 *
 * The page structure follows the hand-maintained docs/benchmarks.md: the
 * fixture section is generated from the report, while the runtime notes and
 * the real-repository evaluation section are kept verbatim (they are not
 * produced by this benchmark run).
 *
 * Write discipline: writeBenchmarksDoc only writes to a path whose basename
 * is "benchmarks.md" inside a directory named "docs". A normal test run
 * never writes to the repository; writing happens only when explicitly
 * requested with CAUSORYN_BENCH_WRITE_DOCS=1.
 */

function formatMs(value: number): string {
  return value.toFixed(1);
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function runsCell(row: MeasurementRow): string {
  if (row.runs === null) return "—";
  return row.runs.map((sample) => formatMs(sample)).join(" / ");
}

function medianCell(row: MeasurementRow): string {
  return row.medianMs === null ? "—" : formatMs(row.medianMs);
}

/** Verdict: the measured median compared with the reference target. */
function verdictCell(row: MeasurementRow): string {
  if (row.status !== "measured" || row.medianMs === null) {
    const reason = row.reason ?? "neden bildirilmedi";
    return `not measured (${reason}) — hedef aşıldı değil — ölçüm yok`;
  }
  if (row.medianMs < row.targetMs) {
    return `hedef içinde (< ${String(row.targetMs)} ms)`;
  }
  return (
    `hedef aşıldı (medyan ${formatMs(row.medianMs)} ms; ` +
    `referans < ${String(row.targetMs)} ms)`
  );
}

function rowLine(row: MeasurementRow): string {
  return [
    `\`${row.id}\``,
    `\`${row.tool}\` \`${row.call}\``,
    `< ${String(row.targetMs)} ms`,
    runsCell(row),
    medianCell(row),
    verdictCell(row),
  ].join(" | ");
}

const HONESTY_RULE: readonly string[] = [
  "**Ölçüm dürüstlüğü kuralı:** Ölçülmemiş sayılar asla ölçülmüş sonuç olarak raporlanmaz. Fixture tablosundaki referans tasarım hedefleri karşılaştırma tabanıdır, ulaşılmış sonuç değildir; yalnızca fiilen koşulmuş ölçümler raporlanır. Çağrı deadline'ına takılan veya bir ortam kesintisine uğrayan satır, sayı yerine `not measured (<reason>)` olarak kaydedilir. Başkasının ölçtüğü değerler kaynaklarıyla etiketlenir.",
];

const RUNTIME_BULLETS: readonly string[] = [
  "- **Sıcak başlangıçta metadata okuma ve akış halinde SHA-256 hash'leme:** `getLatestSnapshotMeta`, başlangıçta grafların tamamının belleğe yüklenmesini önler; `computeStreamingSnapshotId` düğümleri, kenarları ve kanıtları dev, tek parça JSON dizgileri ayırmadan tek bir akış geçişinde hash'ler; `MAX_PUBLISHED_CACHE_ENTRIES = 1` sıcak RSS'i sınırlar; `pruneOldSnapshots` yayımlanmış son 2 snapshot'ı tutar ve yetim `symbol_fts` satırlarını siler.",
  "- **Bloklamayan `worker_threads` WAL indeksleme:** Tam ve artımlı analiz, MCP event loop'unun dışında, `dist/index-worker.mjs` içinde SQLite WAL (`PRAGMA busy_timeout=5000`) üzerinde çalışır; `notifications/progress` akışı yayımlarken eşzamanlı sorguları mevcut snapshot'lardan yanıtlar.",
  "- **Erken kesmeli (early cutoff) dosya başına artımlı indeksleme (`file_facts`):** Değişmeyen dosyalar önbelleğe alınmış SQLite `file_facts` kayıtlarını yeniden kullanır; `public_interface_hash` değerini koruyan yalnızca yorum/biçimlendirme/gövde düzenlemeleri ters bağımlıları atlar (erken kesme) ve önceki TypeScript `oldProgram`'ı yeniden kullanır.",
  "- **Bloklamayan envanter ve sıfır-RegExp eşleme:** `collectInventoryAsync` her 64 girdide bir kontrolü bırakır ve `ignore-matcher.ts` sıfır `RegExp` geri izlemesiyle doğrusal/polinom zamanda çalışır.",
];

const NOTES: readonly string[] = [
  "- Ölçümler MCP protokol işlemenin tamamını içerir: Zod girdi doğrulaması, motor sorgusunun yürütülmesi ve yapılandırılmış envelope serileştirmesi.",
  "- Tek tek örnekler host yüküne göre değişir; karşılaştırma için **Medyan (ms)** sütununu kullanın. Süre, ölçüm ortamına bağlıdır.",
  "- Fixture SHA-256 özeti `tests/release-docs.test.ts` içinde `buildFixtureModel(1000).hash` ile çapraz pinlenmiştir; böylece belgelenen hash sessizce kayamaz.",
];

/** Real-repository evaluation section, kept verbatim from docs/benchmarks.md. */
const REAL_REPO_SECTION: readonly string[] = [
  "## Gerçek depo değerlendirmesi (scripts/bench/real-repo-eval.mjs)",
  "",
  "[`scripts/bench/real-repo-eval.mjs`](../scripts/bench/real-repo-eval.mjs), paketi tam olarak kullanıcıların aldığı biçimiyle değerlendirir. Yerel `packages/causoryn/dist/` dizinini hiçbir zaman doğrudan okumaz:",
  "",
  "1. `packages/causoryn` üzerinde `npm pack --pack-destination <tmp>` çalıştırır (veya `--tarball <path>` alır), tarball'ı yeni bir geçici dizine açar ve tarball SHA-256'sını ve `dist/mcp-server.mjs` SHA-256'sını rapora kaydeder.",
  "2. Açılmış `scripts/causoryn.mjs mcp --allow-cwd --auto-data-dir --data-dir <tmp>` sürecini başlatır ve bir MCP host'u gibi stdio üzerinde JSON-RPC 2.0 ile onunla konuşur.",
  "3. Yalnızca Node.js yerleşiklerini kullanır, her alt süreç için `shell: false` kullanır, analiz edilen depoyu salt okunur kabul eder, fixture'ları yalnızca geçici dizinlere yazar ve her geçici dizini bir `finally` bloğunda siler.",
  "",
  "### Neleri ölçer",
  "",
  "**Bölüm 1 — kendi deposu** (Causoryn monorepo'su veya `--repo <path>`):",
  "",
  "- Soğuk `initialize` el sıkışması, `tools/list` araç sayısı ve serileştirilmiş boyutu.",
  "- Soğuk tam indeksin duvar saati süresi, sunucu sürecinin tepe RSS değeri ve en kötü ana iş parçacığı event loop takılması; bu sonuncusu, arka plan indekslemesi çalışırken her 250 ms'de bir `causoryn_status` çağrılarak ölçülür.",
  "- Envelope `coverage` içinden genel unresolved kenar oranı (`unresolvedEdges / totalEdges`, tüm kenar türleri) ve dil başına `coverage.byLanguage` tablosu.",
  "- **CALLS kenar dağılımı ve dil başına unresolved oranı** (bkz. [aşağıda](#calls-kenar-dağılımı-ve-dil-başına-unresolved-oranı)).",
  "- Hâlâ `UnknownExternal`'da sonlanan workspace içi importlar (workspace paket kapsamları ve göreli belirteçler).",
  "- Kod konumlandırma kontrolü: \"Where are MCP tools registered?\" sorusu için `causoryn_get_agent_context` içinde `packages/mcp-server/src/server.ts` dosyasının sırası.",
  "- `causoryn_find_symbols(\"createCausorynMcpServer\")`, `AMBIGUOUS_SYMBOL` olmadan gerçek fonksiyonu döner.",
  "- `server.ts` üzerinde `causoryn_preflight_change`, etki adayı olarak hiçbir `Workspace` düğümü döndürmez.",
  "- Retention GC sonrasında SQLite veritabanı boyutu ve aynı veri dizinine karşı sıcak yeniden başlatma el sıkışması.",
  "",
  "**Bölüm 2 — karşılaştırmalı (head-to-head) demo** (`examples/fixture-ts-orders`, geçici bir dizine kopyalanır ve tek kullanımlık bir git deposuna commit edilir): `OrderRepository` / `.save(` için sabit dizgeli bir arama çok adımlı rota ve test dosyalarını kaçırırken, `OrderRepository.save` üzerinde `causoryn_preflight_change` doğrulanmış çağıranlar `OrdersService.create` ve `createOrdersRoute`'u, rota testini doğrulanmış bir etki olarak ve bir çağrı noktası test planı adayını döndürmelidir; varsayılan `causoryn_verify_change`, `not_requested` kontratlarla ve güven uyarısı olmadan `no_findings` kararını raporlamalıdır.",
  "",
  "**Bölüm 3 — çok dilli çağrı grafı dürüstlük fixture'ları** (adını Judge çağrı grafı sağlamlık çalışmasından, ISSTA 2019, alır):",
  "",
  "- TypeScript workspace monorepo'su: sıfır unresolved kenar, doğrulanmış `INHERITS` / `IMPLEMENTS` ve `PaymentGateway`'den `StripeGateway`'e sınıf hiyerarşisi (CHA) etkisi.",
  "- Go: aynı paket içi çok dosyalı çağrı doğrulanır, `go.mod` üzerinden paketler arası çağrı doğrulanır ve iki `package main` dizini arasında yanlış kenar oluşmaz.",
  "- Rust: iki segmentli yol çağrısı `heuristic` kalır, aynı dosya içi çağrı `verified` olur.",
  "",
  "Araç zinciri `PATH` üzerinde değilse veya worker `L0` düzeyine düşerse bir Go veya Rust fixture'ı `SKIPPED` olarak raporlanır (ve kapıyı başarısız kılmaz); rapor hangisi olduğunu belirtir.",
  "",
  "### Nasıl çalıştırılır",
  "",
  "```bash",
  "# packages/causoryn'i paketle ve üç bölümün tamamını çalıştır",
  "node scripts/bench/real-repo-eval.mjs",
  "",
  "# Mevcut bir tarball'ı değerlendir ve tam JSON raporunu sakla",
  "node scripts/bench/real-repo-eval.mjs --tarball path/to/causoryn-0.3.0.tgz --json out/eval.json",
  "",
  "# Yalnızca kendi deposu bölümü, daha uzun indeksleme zaman aşımıyla",
  "node scripts/bench/real-repo-eval.mjs --skip-head-to-head --skip-judge --timeout-ms 600000",
  "```",
  "",
  "| Seçenek | Anlamı |",
  "|---|---|",
  "| `--tarball <path>` | `npm pack` çalıştırmak yerine mevcut bir `causoryn-*.tgz` dosyasını değerlendirir |",
  "| `--repo <path>` | Kendi deposu bölümünün hedef kökü (varsayılan: monorepo kökü) |",
  "| `--json <outPath>` | Tam yapılandırılmış raporu JSON olarak yazar |",
  "| `--timeout-ms <ms>` | Workspace başına indeksleme zaman aşımı (varsayılan `300000`, en az `5000`) |",
  "| `--skip-self-repo` / `--skip-head-to-head` / `--skip-judge` | Bölüm 1 / 2 / 3'ü atlar |",
  "",
  "Gereksinimler: Node.js >= 24 ve `PATH` üzerinde `git` (Bölüm 2); `go` ve `cargo` isteğe bağlıdır (Bölüm 3). Markdown raporu stdout'a, ilerleme satırları stderr'e gider; genel kapı başarısız olduğunda çıkış kodu `1` olur. Windows'ta `tar`'ın Windows `tar.exe`'ye çözümlenmesi için betiği PowerShell'den veya `cmd`'den çalıştırın; Git Bash ile gelen GNU `tar`, arşiv yolundaki `C:` ifadesini uzak bir host olarak yorumlar.",
  "",
  "### SLO kapıları",
  "",
  "Aşağıdakilerden herhangi biri başarısız olursa genel kapı başarısız olur (eşikler betikteki `SLO` sabitinden gelir):",
  "",
  "| Kontrol | Geçme koşulu |",
  "|---|---|",
  "| `tools/list` araç sayısı (varsayılan `core` profili) | tam olarak `11` |",
  "| `tools/list` serileştirilmiş boyutu | <= 15,000 karakter |",
  "| Soğuk indeks sırasında azami event loop takılması | < 500 ms |",
  "| Genel unresolved kenar yüzdesi (tüm kenar türleri) | < %10.0 |",
  "| `causoryn_get_agent_context` içinde `server.ts` sırası | <= #3 |",
  "| `find_symbols(\"createCausorynMcpServer\")` | `AMBIGUOUS_SYMBOL` yok, gerçek fonksiyon mevcut |",
  "| `preflight_change(server.ts)` | 0 `Workspace` düğümü |",
  "| Sıcak yeniden başlatma el sıkışması | < 1,000 ms |",
  "| Bölüm 2 karşılaştırmalı demo | tüm kontroller geçer |",
  "| Bölüm 3 fixture'ları | `PASS` veya `SKIPPED` |",
  "",
  "Soğuk el sıkışma, soğuk indeks süresi, tepe RSS, SQLite boyutu, workspace içi unresolved importlar ve CALLS dağılımı bilgi amaçlıdır ve kapıyı hiçbir zaman değiştirmez.",
  "",
  "### CALLS kenar dağılımı ve dil başına unresolved oranı",
  "",
  "Genel unresolved kenar yüzdesi her `verified` veya `heuristic` kenarı çözümlenmiş sayar; bu yüzden bir iyileşmenin nereden geldiğini göstermez. Özellikle TypeScript analizörü (`adapters/typescript/src/analyzer.ts`), TypeScript checker çağrılan fonksiyonu analiz edilen dosyaların dışındaki bir bildirime (örneğin bir test framework doğrulamasına veya bir standart kütüphane metoduna) çözümlediğinde **bir `UnknownExternal` düğümüne `verified` CALLS kenarı** üretir. Böyle bir kenar, bir kütüphaneye, çalışma zamanına veya test framework'üne yapılan doğru etiketlenmiş bir çağrıdır; bir proje sembolüne çözümlenmiş bir çağrı değildir. Hiç çözümlenemeyen bir çağrı hedefi, bir `UnknownExternal` düğümüne `unresolved` CALLS kenarı olur. Checker'ın düğüm olarak modellenmeyen yerel hedeflere (callback parametreleri, closure'lar, nesne literal'leri, hemen çağrılan fonksiyonlar) çözümlediği çağrılar kenar üretmez; dolayısıyla iki sayımın hiçbirine girmez.",
  "",
  "Bunu görünür kılmak için Bölüm 1 artık soğuk sunucu süreci çıktıktan sonra benchmark'ın geçici veri dizinindeki Causoryn'in kendi `graph.sqlite` dosyasını okur. Veritabanı, açılmış tarball'ın içinde paketlenen `better-sqlite3` sürücüsüyle salt okunur (`readonly: true, fileMustExist: true`) açılır; bu yüzden betik hiçbir bağımlılık eklemez. Okuma kısa ömürlü bir alt süreçte ([`scripts/bench/read-edge-breakdown.mjs`](../scripts/bench/read-edge-breakdown.mjs)) yapılır, çünkü Windows yüklenmiş bir native addon'u süreci çıkana kadar kilitli tutar ve bu, geçici dizinin silinmesini engellerdi. Yalnızca **yayımlanmış en son snapshot** sayılır (motorun workspace özetiyle aynı sıralama) ve bu, `causoryn_status`'un raporladığı snapshot kimliği olmalıdır; aksi hâlde dağılım, nedeniyle birlikte ölçülmedi olarak raporlanır.",
  "",
  "CALLS kenarları dört kovaya ayrılır (sayılar ve tüm CALLS kenarlarının yüzdesi):",
  "",
  "| Kova | Tanım |",
  "|---|---|",
  "| `verifiedInternal` | `resolution = verified`, hedef düğüm bir proje sembolüdür (`UnknownExternal` dışındaki herhangi bir tür) |",
  "| `verifiedExternal` | `resolution = verified`, hedef düğüm türü `UnknownExternal`'dır (kütüphane / çalışma zamanı / test framework çağrısı) |",
  "| `heuristic` | `resolution = heuristic` |",
  "| `unresolved` | `resolution = unresolved` |",
  "",
  "**Dil başına unresolved oranı**, sayılarla birlikte `unresolved kenarlar / o dile atfedilen tüm kenarlar` biçimindedir. Bir kenar kaynak düğümünün diline, o yoksa hedef düğümünün diline atfedilir; `Workspace --CONTAINS-->` kenarları ve dili olmayan düğümler arasındaki kenarlar \"(no language)\" olarak listelenir. Bu, motorun `coverage.byLanguage` için kullandığı kuralın aynısıdır ve betik veritabanı sayımlarını aynı snapshot'ın MCP `coverage` değeriyle çapraz kontrol eder (`consistencyWithMcpCoverage`). Markdown raporu her iki tabloyu \"CALLS Edge Resolution Breakdown\" ve \"Unresolved Edge Ratio by Language\" başlıkları altında, `verifiedExternal` çağrılarının çözümlenmiş iç kenarlar olmadığını belirten bir notun yanında yazdırır.",
  "",
  "Yeni JSON alanları (`--json` ile yazılır; başlık değerleri `selfRepo.unresolvedEdgePct` ve `selfRepo.slos` değişmez):",
  "",
  "```text",
  "selfRepo.edgeBreakdown = {",
  "  available: true,",
  "  source, databaseFile, workspaceId, snapshotId, snapshotState,",
  "  totalEdges, unresolvedEdges, unresolvedPct,",
  "  calls: { total, verifiedInternal, verifiedExternal, heuristic, unresolved,",
  "           pct: { verifiedInternal, verifiedExternal, heuristic, unresolved } },",
  "  byLanguage: { <language>: { totalEdges, verifiedEdges, heuristicEdges, unresolvedEdges,",
  "                              unresolvedPct, calls: { ...same shape as calls } } },",
  "  unattributed: { totalEdges, unresolvedEdges },",
  "  consistencyWithMcpCoverage: { compared, totalsMatch, mismatchedLanguages }",
  "}",
  "// veya ölçülemediğinde:",
  "selfRepo.edgeBreakdown = { available: false, reason }",
  "```",
  "",
  "Yüzdeler iki ondalık basamağa yuvarlanır ve payda 0 olduğunda `null` olur. Sayım mantığı [`scripts/bench/calls-breakdown.mjs`](../scripts/bench/calls-breakdown.mjs) içindedir ve motorun kendi dil başına toplulaştırmasıyla eşitlik dahil, gerçek şemalı bir SQLite veritabanına karşı [`tests/bench-calls-breakdown.test.ts`](../tests/bench-calls-breakdown.test.ts) içinde birim testine tabidir.",
  "",
  "### Bağımsız doğrulama değerleri (2026-11-24, paketlenmiş tarball)",
  "",
  "Bu alt bölümdeki değerler, **2026-11-24'te paketlenmiş tarball üzerinde yapılan bağımsız bir doğrulama koşumundan** gelir ve v0.2.4 üzerindeki aynı ölçümle karşılaştırılmıştır. Bu değerler CI tarafından veya bu depoda kaydedilmiş bir koşum tarafından üretilmemiştir; başlık değerinin bağlamı içinde okunabilmesi için raporlandığı haliyle aktarılmıştır.",
  "",
  "- Genel unresolved kenar oranı (tüm kenar türleri): betikte kayıtlı v0.2.4 tabanındaki (`V024_BASELINE`) %33.5'e karşı **%1.92 (761 / 39,578 kenar)**. Sayı doğrudur, ancak değişimin büyük kısmı dış çağrıların nasıl etiketlendiğindedir.",
  "- CALLS kenarları, v0.2.4 → 2026-11-24 doğrulaması:",
  "",
  "| CALLS kovası | v0.2.4 | 2026-11-24 doğrulaması |",
  "|---|---|---|",
  "| `unresolved` | 12,629 | 745 |",
  "| `verifiedExternal` (verified, hedef `UnknownExternal`) | 8,200 | 16,434 |",
  "| `verifiedInternal` (verified, hedef bir proje sembolü) | 6,999 | 9,756 |",
  "",
  "- Bu raporlanan değerler üzerinde aritmetik: unresolved CALLS 11,884 azaldı; `verifiedExternal` 8,234 arttı (bu azalmanın yaklaşık %70'i) ve `verifiedInternal` 2,757 arttı (yaklaşık %23). Doğrulama `heuristic` CALLS sayılarını raporlamadığı için kalan kısım burada bir kovaya atfedilmez.",
  "- En büyük `verifiedExternal` hedefleri `globalExpect` (1,866 kenar), `JestAssertion.toBe` (1,551) ve `Array.push` gibi kütüphane ve test çağrılarıydı.",
  "- Dil başına unresolved oranı (tüm kenar türleri): Rust %63 (243 / 384), Python %51, C# %33, Go %18. Sayılar yalnızca Rust için raporlandı. Doğrulamaya göre TypeScript dışındaki analizörler v0.2.4'e göre çok az değişti; kendi deposu çoğunlukla TypeScript olduğu için genel değere TypeScript kenarları hâkimdir.",
  "",
  "`node scripts/bench/real-repo-eval.mjs --json <out>` yeniden çalıştırıldığında, test edilen tarball için bu dağılımlar (`selfRepo.edgeBreakdown`) üretilir.",
  "",
  "## İlgili sayfalar",
  "",
  "- [Mimari Genel Bakış](architecture.md) · [Host Uyumluluk Matrisi](compatibility-matrix.md)",
  "- [Güvenlik Denetimi](security-pass.md) · [Uygulama Durumu](implementation-status.md)",
  "- [Dil Analizörleri](language-analyzers.md) — dil başına `verified` / `heuristic` / `unresolved` koşulları · [Araç Sözleşmeleri](tool-contracts.md) — envelope `coverage` ve `coverage.byLanguage`",
];

/** Renders the full docs/benchmarks.md content from a run report (does not write). */
export function renderBenchmarksDoc(report: BenchReport): string {
  const runDate = report.startedAt.slice(0, 10);
  const files = formatCount(report.fileCount);
  const lines: string[] = [];
  lines.push("# Causoryn Performans Benchmark'ları");
  lines.push("");
  lines.push(
    "> **Dil / Language:** **Türkçe** | [English](en/benchmarks.md) · [Dokümantasyon Merkezi](README.md)",
  );
  lines.push(">");
  lines.push(
    `> **Durum:** Bu sayfa iki ayrı benchmark'ı belgeler: sentetik ${files} dosyalık fixture ` +
      `mikro-benchmark'ı (\`npm run bench\`, son koşum ${runDate}) ve paketlenmiş tarball üzerinde ` +
      "çalışan [gerçek depo değerlendirmesi](#gerçek-depo-değerlendirmesi-scriptsbenchreal-repo-evalmjs) " +
      "(`scripts/bench/real-repo-eval.mjs`); ikincisi CALLS kenarlarını hedefe göre ayırır ve " +
      "unresolved oranını dil başına raporlar.",
  );
  lines.push("");
  lines.push(...HONESTY_RULE);
  lines.push("");
  lines.push("## Güncel Çalışma Zamanı ve Ölçeklenebilirlik Mimarisi");
  lines.push("");
  lines.push(
    `Aşağıdaki fixture tablosu, ${runDate} tarihli sentetik ${files} dosyalık TypeScript fixture ` +
      "benchmark koşumunu kaydeder. Sıcak gecikmeyi, event loop yanıt verebilirliğini, bellek yükünü " +
      "ve artımlı yeniden derlemeleri belirleyen çalışma zamanı özellikleri şunlardır:",
  );
  lines.push("");
  lines.push(...RUNTIME_BULLETS);
  lines.push("");
  lines.push(
    `Fixture tablosu yalnızca ${runDate} tarihinde fiilen koşulmuş ölçümü kaydeder. Süreç bütününe ` +
      "ait sayıların (el sıkışma, soğuk indeks, event loop takılması, RSS, SQLite boyutu) paketlenmiş " +
      "tarball'a karşı ölçüldüğü yer, aşağıdaki gerçek depo değerlendirmesidir.",
  );
  lines.push("");
  lines.push(`## Sentetik ${files} Dosyalık Fixture Benchmark'ı`);
  lines.push("");
  lines.push("### Ölçüm Yöntemi");
  lines.push("");
  lines.push(
    `- **Fixture:** Deterministik sentetik TypeScript workspace, ${files} dosya ` +
      "(`tests/bench-release/fixture.ts`; aynı `fileCount` bayt düzeyinde aynı içeriği üretir; " +
      `sha256: \`${report.fixtureHash}\`).`,
  );
  lines.push(
    "- **Ölçüm katmanı:** MCP protokol katmanı (`@modelcontextprotocol/sdk` `InMemoryTransport` " +
      "üzerinden `client.callTool`), süre `process.hrtime.bigint()` ile ölçülür; 1 ölçülmeyen ısınma " +
      `çağrısı + medyanı raporlanan N=${String(report.runsPerMeasurement)} ölçülen koşum (çağrı başına ` +
      `deadline: \`${String(report.callDeadlineMs)} ms\`). Deadline aşımı veya istisna satırı ` +
      "`not measured` olarak işaretler.",
  );
  lines.push(
    `- **Referans hedefler:** tablodaki hedefler (${files} dosyalık bir TypeScript fixture üzerinde ` +
      "sıcak workspace özeti < 1 sn, küçük graf komşuluğu < 500 ms, 200 düğümle sınırlı harita < 2 sn) " +
      "orijinal tasarım dokümanındaki tasarım hedefleridir, sonuç değildir.",
  );
  lines.push(
    "- **Soğuk indeks (bilgi amaçlı):** " +
      (report.coldIndexMs === null
        ? "ölçülemedi"
        : `\`${formatMs(report.coldIndexMs)} ms\` (${files} dosya)`) +
      "; soğuk indeksleme için sabit bir duvar saati SLA'sı vaat edilmez. " +
      `Snapshot durumu \`${report.indexState}\`, \`${String(report.diagnosticCount)}\` ayrıştırma tanısı` +
      (report.diagnosticCount > 0
        ? ` (ilk tanılar: ${report.firstDiagnostics.join(" | ")}).`
        : " (tanısız fixture)."),
  );
  lines.push(
    `- **Ortam:** Node.js \`${report.environment.nodeVersion}\`, \`${report.environment.platform}\`, ` +
      `${report.environment.cpuModel}, ` +
      `${String(Math.round(report.environment.totalMemBytes / (1024 * 1024 * 1024)))} GB RAM.`,
  );
  lines.push(
    "- **Yeniden üretim:** `CAUSORYN_BENCH_WRITE_DOCS=1 npm run bench` (`vitest.bench.config.ts`). " +
      "Varsayılan `npm test` koşumu, duvar saati ölçümleri paralel süit yükü altında kararsızlaşmasın " +
      "diye `tests/bench-release/**`'ı dışlar ve varsayılan koşum depoya hiçbir zaman yazmaz.",
  );
  lines.push("");
  lines.push(`### Sonuçlar — Koşum ${report.startedAt}`);
  lines.push("");
  lines.push(
    "| Ölçüm | Araç çağrısı | Referans tasarım hedefi | " +
      `Koşumlar (ms, N=${String(report.runsPerMeasurement)}) | Medyan (ms) | Değerlendirme |`,
  );
  lines.push("|---|---|---|---|---|---|");
  for (const row of report.rows) {
    lines.push(`| ${rowLine(row)} |`);
  }
  lines.push("");
  if (report.rows.some((row) => row.tool === "causoryn_workspace_summary")) {
    lines.push(
      "`causoryn_workspace_summary` ölçülen araç adıdır; 0.3.0'dan itibaren varsayılan `core` profili " +
        "aynı veriyi `causoryn_status` (`action: \"inspect\"`) üzerinden sunar ve legacy ad `full` " +
        "profilinde kullanılabilir kalır.",
    );
    lines.push("");
  }
  lines.push("### Notlar");
  lines.push("");
  lines.push(...NOTES);
  lines.push("");
  lines.push(...REAL_REPO_SECTION);
  lines.push("");
  return lines.join("\n");
}

/** Only the docs/benchmarks.md target is accepted (basename allowlist). */
export function writeBenchmarksDoc(docsPath: string, report: BenchReport): void {
  const resolved = path.resolve(docsPath);
  const base = path.basename(resolved);
  const parentName = path.basename(path.dirname(resolved));
  if (base !== "benchmarks.md" || parentName !== "docs") {
    throw new Error(
      `writeBenchmarksDoc only accepts the docs/benchmarks.md target (requested: ${resolved})`,
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
      `the docs target directory does not exist (wrong repository root?): ${path.dirname(resolved)}`,
    );
  }
  writeFileSync(resolved, renderBenchmarksDoc(report), "utf8");
}
