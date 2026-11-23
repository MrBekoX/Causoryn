import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_VERSION, TOOL_NAMES } from "../packages/mcp-server/src/version.js";
import { CLONE_MAX_ATTEMPTS } from "./security-release/helpers/bundle-client.js";
import { buildFixtureModel } from "./bench-release/fixture.js";

/**
 * Sprint-7 F8+F9 release dokümantasyon doğrulama testi.
 *
 * Kapsam: docs/architecture.md (güncel paket haritası), docs/tool-contracts.md
 * (29 araç sözleşme tablosu), docs/compatibility-matrix.md (host × sonuç
 * matrisi), CHANGELOG.md (Keep a Changelog, 0.1.0 sürüm kararı) ve
 * docs/implementation-status.md (tüm fazların nihai dürüst tablosu).
 *
 * Testler salt okunurdur — depoya hiçbir şey yazılmaz (ADR-008). TOOL_NAMES ve
 * SERVER_VERSION derlenen sunucu kaynağından
 * (packages/mcp-server/src/version.js) import edilir: doküman iddiaları
 * YAYIMLANAN gerçek araç kümesiyle çapraz doğrulanır (ADR-010: doküman
 * yayımlanmamış bir aracı tanıtamaz).
 */

const DOC_PATHS = {
  architecture: fileURLToPath(
    new URL("../docs/architecture.md", import.meta.url),
  ),
  toolContracts: fileURLToPath(
    new URL("../docs/tool-contracts.md", import.meta.url),
  ),
  compatibility: fileURLToPath(
    new URL("../docs/compatibility-matrix.md", import.meta.url),
  ),
  changelog: fileURLToPath(new URL("../CHANGELOG.md", import.meta.url)),
  status: fileURLToPath(
    new URL("../docs/implementation-status.md", import.meta.url),
  ),
  claudeDoc: fileURLToPath(
    new URL("../docs/hosts/claude-code.md", import.meta.url),
  ),
  codexDoc: fileURLToPath(new URL("../docs/hosts/codex.md", import.meta.url)),
  antigravityDoc: fileURLToPath(
    new URL("../docs/hosts/antigravity.md", import.meta.url),
  ),
  zcodeHostDoc: fileURLToPath(
    new URL("../docs/hosts/zcode.md", import.meta.url),
  ),
  docsIndexTr: fileURLToPath(new URL("../docs/README.md", import.meta.url)),
  docsIndexEn: fileURLToPath(new URL("../docs/en/README.md", import.meta.url)),
  cliConfigTr: fileURLToPath(
    new URL("../docs/cli-and-configuration.md", import.meta.url),
  ),
  langAnalyzersTr: fileURLToPath(
    new URL("../docs/language-analyzers.md", import.meta.url),
  ),
  zcodeReadme: fileURLToPath(
    new URL("../integrations/zcode/causoryn/README.md", import.meta.url),
  ),
  zcodeMarketplace: fileURLToPath(
    new URL(
      "../integrations/zcode/.claude-plugin/marketplace.json",
      import.meta.url,
    ),
  ),
  rootPkg: fileURLToPath(new URL("../package.json", import.meta.url)),
} as const;

function readDoc(name: keyof typeof DOC_PATHS): string {
  const p = DOC_PATHS[name];
  expect(existsSync(p), "release dokümanı diskte olmalı").toBe(true);
  return readFileSync(p, "utf8");
}

/**
 * Benchmark medyanını KELİME SINIRLI eşler (denetim bulgusu, düşük):
 * düz substring `includes("5.3 ms")` sentetik "15.3 ms"i de yakalar ve
 * `includes("10.7")` "110.7"yi de eşler. `(?<!\d)5\.3(?!\d) ms` deseni
 * her iki yanlış-pozitifi dışarıda bırakır (Node 24 / V8 lookbehind).
 */
function medianRegex(median: string): RegExp {
  const escaped = median.replace(".", "\\.");
  return new RegExp(`(?<!\\d)${escaped}(?!\\d) ms`);
}

/**
 * tool-contracts.md sözleşme tablolarındaki `causoryn_*` araç adlarını çıkarır.
 * Yalnızca "## Çekirdek" ve "## Wiki" sözleşme bölümleri taranır; dosyanın
 * DIĞER tabloları (yazma izin matrisi vb.) bu ayrıştırıcıya girmez.
 */
function parseToolContractsTable(text: string): string[] {
  const listed: string[] = [];
  let inContractTable = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      inContractTable = line.startsWith("## Çekirdek") || line.startsWith("## Wiki");
      continue;
    }
    if (!inContractTable) continue;
    const m = line.match(/^\|\s*`?(causoryn_[a-z_0-9]+)`?\s*\|/);
    if (m !== null && m[1] !== undefined) listed.push(m[1]);
  }
  return listed;
}

/** compatibility-matrix.md tablo satırını host adına göre bulur. */
function matrixRowFor(text: string, host: string): string | undefined {
  return text
    .split("\n")
    .find(
      (l) =>
        l.match(/^\|/) !== null &&
        l.includes(host) &&
        l.match(/^\|\s*-{3,}/) === null,
    );
}

describe("F8: release doküman envanteri — tüm dosyalar var", () => {
  it("docs/architecture.md, tool-contracts.md, compatibility-matrix.md mevcut", () => {
    expect(existsSync(DOC_PATHS.architecture)).toBe(true);
    expect(existsSync(DOC_PATHS.toolContracts)).toBe(true);
    expect(existsSync(DOC_PATHS.compatibility)).toBe(true);
  });

  it("CHANGELOG.md ve docs/implementation-status.md mevcut", () => {
    expect(existsSync(DOC_PATHS.changelog)).toBe(true);
    expect(existsSync(DOC_PATHS.status)).toBe(true);
  });

  it("docs/hosts/: 4 host kılavuzu mevcut (claude-code.md, codex.md, antigravity.md, zcode.md)", () => {
    expect(existsSync(DOC_PATHS.claudeDoc)).toBe(true);
    expect(existsSync(DOC_PATHS.codexDoc)).toBe(true);
    expect(existsSync(DOC_PATHS.antigravityDoc)).toBe(true);
    expect(existsSync(DOC_PATHS.zcodeHostDoc)).toBe(true);
  });

  it("docs/ ana indeks, CLI/konfigürasyon, 5-dil analizör rehberleri ve ZCode marketplace belgeleri mevcut", () => {
    expect(existsSync(DOC_PATHS.docsIndexTr)).toBe(true);
    expect(existsSync(DOC_PATHS.docsIndexEn)).toBe(true);
    expect(existsSync(DOC_PATHS.cliConfigTr)).toBe(true);
    expect(existsSync(DOC_PATHS.langAnalyzersTr)).toBe(true);
    expect(existsSync(DOC_PATHS.zcodeReadme)).toBe(true);
    expect(existsSync(DOC_PATHS.zcodeMarketplace)).toBe(true);
    const marketplace = JSON.parse(
      readFileSync(DOC_PATHS.zcodeMarketplace, "utf8"),
    ) as { plugins?: Array<{ name?: string; version?: string }> };
    expect(marketplace.plugins?.[0]?.name).toBe("causoryn");
  });
});

describe("F8: docs/tool-contracts.md — TOOL_NAMES ile birebir küme eşitliği", () => {
  it("tablo TAM OLARAK TOOL_NAMES'teki aracı içerir (eksik/fazla yok)", () => {
    const text = readDoc("toolContracts");
    const listed = parseToolContractsTable(text);
    expect(listed).toHaveLength(TOOL_NAMES.length);
    expect([...listed].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("standart envelope ve hata kodu bölümünü taşıyor (TŞ §10.1 sabit set referansı)", () => {
    const text = readDoc("toolContracts");
    expect(text).toContain("schemaVersion");
    expect(text).toContain("WORKSPACE_NOT_AUTHORIZED");
    expect(text).toContain("CONTRACT_PARSE_FAILED");
  });
});

describe("NEGATİF: tool-contracts.md yayımlanmamış araç reklamlayamaz", () => {
  it("tablodaki her araç adı TOOL_NAMES üyesidir (boş/hayali araç yok — ADR-010)", () => {
    const text = readDoc("toolContracts");
    const listed = parseToolContractsTable(text);
    const known = new Set<string>(TOOL_NAMES);
    const unknown = listed.filter((t) => !known.has(t));
    expect(unknown).toEqual([]);
  });

  it("causoryn_refresh_index full ve incremental modlarını, scope açık reddini ve B7 Partial sınırını belgeler (ADR-010)", () => {
    const text = readDoc("toolContracts");
    const row = text
      .split("\n")
      .find((l) => l.startsWith("| `causoryn_refresh_index`"));
    expect(row).toBeTruthy();
    expect(row).toContain("full");
    expect(row).toContain("incremental");
    expect(row).toContain("scope");
  });
});

describe("F8: docs/compatibility-matrix.md — host × sonuç matrisi", () => {
  it("dört host satırı içerir: Claude Code, Codex, ZCode, Antigravity", () => {
    const text = readDoc("compatibility");
    for (const host of ["Claude Code", "Codex", "ZCode", "Antigravity"]) {
      expect(matrixRowFor(text, host), "host satırı eksik").toBeTruthy();
    }
  });

  it("araç sayısını yayımlanan katalogla aynı tutar (29)", () => {
    const text = readDoc("compatibility");
    expect(text).toContain("29");
    expect(text).toContain(String(TOOL_NAMES.length));
  });

  it("stdout temizliği kolonunu taşır (kırmızı kural 4)", () => {
    const text = readDoc("compatibility");
    expect(text.toLowerCase()).toContain("stdout");
    expect(text.toLowerCase()).toContain("stderr");
  });
});

describe("NEGATİF: compatibility-matrix.md koşulmayan hostu geçmiş sayamaz", () => {
  it("Antigravity satırı NOT RUN olarak işaretli; PASS iddiası YOK (TŞ §22 + kırmızı kural 5)", () => {
    const text = readDoc("compatibility");
    const row = matrixRowFor(text, "Antigravity");
    expect(row).toBeTruthy();
    expect(row).toMatch(/NOT RUN/i);
    expect(row).not.toMatch(/PASS/i);
  });

  it("ZCode satırı gerçek GUI kurulumu iddia etmez (yalnızca manifest doğrulama — kırmızı kural 6)", () => {
    const text = readDoc("compatibility");
    const row = matrixRowFor(text, "ZCode");
    expect(row).toBeTruthy();
    expect(row).toMatch(/manifest/i);
  });

  it("kök allowRoots yetkisi, sır ve tek-dosya dağıtım iddiası YOK", () => {
    const text = readDoc("compatibility");
    expect(text).not.toMatch(
      /allowRoots["']?\s*:\s*\[\s*["']?(\/|[A-Za-z]:[\/\\]?)["']?\s*\]/,
    );
    expect(text).not.toMatch(
      /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._-]{20,})/,
    );
    expect(text).not.toMatch(
      /(tek[- ]dosya dağıt|single[- ]file (distribution|bundle))/i,
    );
  });
});

describe("F9 / K-022: sürüm kararı — 0.2.3 Pre-1.0 Public Preview (1.0.0 DEĞİL)", () => {
  it("CHANGELOG.md Keep a Changelog formatında, [0.2.3] - tarih, [0.2.2] - tarih, [0.2.1] - tarih, [0.2.0] - tarih ve tarihsel [0.1.0] - tarih girişli", () => {
    const text = readDoc("changelog");
    expect(text).toContain("Keep a Changelog");
    expect(text).toMatch(/^## \[0\.2\.3\] - \d{4}-\d{2}-\d{2}$/m);
    expect(text).toMatch(/^## \[0\.2\.2\] - \d{4}-\d{2}-\d{2}$/m);
    expect(text).toMatch(/^## \[0\.2\.1\] - \d{4}-\d{2}-\d{2}$/m);
    expect(text).toMatch(/^## \[0\.2\.0\] - \d{4}-\d{2}-\d{2}$/m);
    expect(text).toMatch(/^## \[0\.1\.0\] - \d{4}-\d{2}-\d{2}$/m);
  });

  it("kök package.json version === SERVER_VERSION === 0.2.3 (karar üç yüzeyde tutarlı)", () => {
    const pkg = JSON.parse(readFileSync(DOC_PATHS.rootPkg, "utf8")) as {
      version?: string;
    };
    expect(pkg.version).toBe("0.2.3");
    expect(pkg.version).toBe(SERVER_VERSION);
  });

  it("karar gerekçesi CHANGELOG'da ADR-010 ve K-022 atfıyla yazılı", () => {
    const text = readDoc("changelog");
    expect(text).toContain("ADR-010");
    expect(text).toContain("0.2.3");
    expect(text).toContain("K-022");
  });
});

describe("NEGATİF: 1.0.0 yayımlanmış ilan EDİLEMEZ (ADR-010)", () => {
  it("CHANGELOG'da yayımlanmış 1.0.0 sürüm başlığı YOK", () => {
    const text = readDoc("changelog");
    expect(text).not.toMatch(/^## \[1\.0\.0\]/m);
  });

  it("implementation-status.md B7 hâlâ Partial olarak raporlanır (Done yükseltmesi yok)", () => {
    const text = readDoc("status");
    expect(text).toMatch(/\| B7 \|[^\n]*\*\*Partial\*\*/);
  });
});

describe("F8: docs/architecture.md güncel paket haritası", () => {
  it("Faz D/E paketleri ve host/app/native bileşenleri tabloda", () => {
    const text = readDoc("architecture");
    for (const pkg of [
      "`packages/contracts`",
      "`packages/preflight`",
      "`packages/verification`",
      "`packages/wiki`",
      "`apps/visualizer`",
      "`native/roslyn-worker`",
    ]) {
      expect(text).toContain(pkg);
    }
  });

  it("bayat olusturulmayan-paketler iddiası kaldırılmış", () => {
    const text = readDoc("architecture");
    expect(text).not.toContain("OLUŞTURULMAYAN");
  });
});

describe("F8: docs/implementation-status.md — Sprint 7 final bölümü", () => {
  it("Sprint 7 bölümü + F8/F9 karar kaydı taşıyor", () => {
    const text = readDoc("status");
    expect(text).toMatch(/^## Sprint 7 — Faz F: Cross-host Release/m);
    expect(text).toContain("F9");
    expect(text).toContain("0.1.0");
    expect(text).toContain("Sprint 7 açık kalemleri");
  });
});

/**
 * F8 FİNAL turu (2026-11-10): Faz F'nin ikinci koşum dalgası
 * (60735ff bundle, 1d2a450 host dokümanları, e3d0bc2 security/benchmark)
 * host CLI sürümlerini, F6 test sayılarını ve F7 ölçüm medyanlarını
 * GÜNCELLEDİ. Bu blok, b85ffff'te yazılan F8 dokümanlarının bayat
 * iddialarla (claude 2.1.319, F6 26/26, 2026-11-08 medyanları) GERİ
 * GELMEMESİNİ kilitleyen sürüm-kapısıdır. Pinlenen sayılar docs/benchmarks.md
 * 2026-11-10 koşumu ve docs/security-pass.md final turuyla aynıdır; yeni bir
 * benchmark/güvenlik turu bu değerleri değiştirirse bu test ve dokümanlar
 * birlikte güncellenir.
 */
describe("F8 FİNAL turu (2026-11-10 yeniden doğrulama) — bayat iddia geri gelemez", () => {
  it("compatibility-matrix final host koşumlarını yansıtır: güncel claude iddiası 2.1.322; bayat 'CLI 2.1.319' iddiası YOK (tarihsel anım serbest)", () => {
    const text = readDoc("compatibility");
    expect(text).toContain("2026-11-10");
    expect(text).toContain("**2.1.322**");
    const claudeRow = matrixRowFor(text, "Claude Code");
    expect(claudeRow).toBeTruthy();
    expect(claudeRow).toMatch(/2\.1\.322/);
    expect(claudeRow).not.toMatch(/CLI 2\.1\.319/);
  });

  it("compatibility-matrix F6/F7 kanıtları final değerlerle güncel: 32/32 + 36/36 + 5 spawn oturumu + npm run bench + 2026-11-10 medyanları", () => {
    const text = readDoc("compatibility");
    expect(text).toContain("32/32");
    expect(text).toContain("**36/36**");
    expect(text).toContain("5 bağımsız spawn");
    expect(text).toContain("npm run bench");
    expect(text).toMatch(medianRegex("11.8"));
    expect(text).toMatch(medianRegex("13.0"));
    expect(text).toMatch(medianRegex("10.7"));
  });

  it("CHANGELOG [0.1.0] benchmark medyanları docs/benchmarks.md final koşumuyla aynı; bayat 2026-11-08 medyanları YOK", () => {
    const text = readDoc("changelog");
    expect(text).toMatch(medianRegex("11.8"));
    expect(text).toMatch(medianRegex("13.0"));
    expect(text).toMatch(medianRegex("10.7"));
    expect(text).not.toMatch(medianRegex("5.3"));
    expect(text).not.toMatch(medianRegex("8.2"));
    expect(text).not.toMatch(medianRegex("5.7"));
    expect(text).toContain("5 bağımsız spawn");
    expect(text).not.toContain("4 bağımsız spawn");
  });

  it("implementation-status Sprint 7 final dal koşumlarını taşır: F6 32/32, F7 yeni medyan + cold index, claude 2.1.322, final commit'ler 60735ff/e3d0bc2", () => {
    const text = readDoc("status");
    expect(text).toContain("32/32");
    expect(text).toContain("16370.3");
    expect(text).toContain("11.8");
    expect(text).toContain("2.1.322");
    expect(text).toContain("60735ff");
    expect(text).toContain("e3d0bc2");
    expect(text).toContain("2026-11-10");
  });

  it("docs/architecture.md build sözleşmesi benchmark ayrışmasını beyan eder (npm run bench + tests/bench-release dışlaması)", () => {
    const text = readDoc("architecture");
    expect(text).toContain("npm run bench");
    expect(text).toContain("tests/bench-release");
  });
});

/**
 * DENETİM DÖNGÜSÜ (bulgu, orta): implementation-status.md Sprint 7 açık
 * kalemleri madde 6, "F9 sayımının 12 kaleminin CHANGELOG [Unreleased]
 * 1.0.0 kapılarına işlendiğini" iddia eder. Bu blok o çapraz referansı
 * pinler: [Unreleased] bölümü F9 sayımındaki HER kalemi bir bullet'ta
 * taşımak zorundadır. Kırmızı koşum, eksik kalemlerin (wiki yüzey
 * boşlukları, visualizer, bundle fidelity, per-file parse reuse, SQL
 * rename) somut eksik listesiydi — dokümanlar güncellenince yeşile döner.
 */
describe("DENETİM DÖNGÜSÜ: CHANGELOG [Unreleased] 1.0.0 kapıları F9 sayımını eksiksiz kapsar", () => {
  function unreleasedSection(): string {
    const text = readDoc("changelog");
    const start = text.indexOf("## [Unreleased]");
    const end = text.indexOf("## [0.2.3]");
    expect(start, "## [Unreleased] başlığı olmalı").toBeGreaterThanOrEqual(0);
    expect(end, "## [0.2.3] başlığı olmalı").toBeGreaterThan(start);
    return text.slice(start, end);
  }

  it("F9 kalemi 9 — wiki yüzey boşlukları: wiki_search filtreleri + WIKI_NOTE_CONFLICT kaydı + incremental yayım yeniden yazımı", () => {
    const u = unreleasedSection();
    expect(u).toMatch(/wiki_search|wiki arama/i);
    expect(u).toMatch(/WIKI_NOTE_CONFLICT/);
    expect(u).toMatch(/incremental wiki|link\/FTS/i);
  });

  it("F9 kalemi 11 — visualizer: gerçek tarayıcı koşusu + viewer HTML MCP yüzeyi", () => {
    const u = unreleasedSection();
    expect(u).toMatch(/visualizer/i);
    expect(u).toMatch(/tarayıcı|MCP yüzeyi/i);
  });

  it("F9 kalemi 12 — bundle fidelity: default lib .d.ts → partial düşüşü", () => {
    const u = unreleasedSection();
    expect(u).toMatch(/default lib|\.d\.ts/i);
  });

  it("F9 kalem 5 alt kalemi — per-file parse reuse (B7) ve kalem 7 alt kalemi — K-015(3) SQL rename → unknown", () => {
    const u = unreleasedSection();
    expect(u).toMatch(/per-file parse reuse/i);
    expect(u).toMatch(/SQL RENAME|rename/i);
  });
});

/**
 * DENETİM DÖNGÜSÜ (bulgu, düşük): medyan assertion'larının hassasiyeti.
 * Eski yaklaşım düz substring'ti; "15.3 ms" dizesi "5.3 ms"i İÇERİR ve
 * "110.7" dizesi "10.7"yi İÇERİR — yani gelecekteki meşru bir medyan
 * yanlış kırmızıya düşerdi. Bu blok kusuru sentetik dizeyle kanıtlar ve
 * medianRegex'in kelime-sınırlı davranışını pinler.
 */
describe("DENETİM DÖNGÜSÜ: medyan regex'i kelime-sınırlıdır (sentetik kanıt)", () => {
  it("eski substring yaklaşımı '15.3 ms'i yanlış yakalardı; medianRegex yakalamaz", () => {
    // Kusur kanıtı: includes tabanlı eski yaklaşım false-pozitif üretir.
    expect("15.3 ms".includes("5.3 ms")).toBe(true);
    // Düzeltilmiş davranış: kelime-sınırlı regex dışarıda bırakır.
    expect(medianRegex("5.3").test("15.3 ms")).toBe(false);
    expect(medianRegex("5.3").test("5.3 ms")).toBe(true);
    expect(medianRegex("5.3").test("5.31 ms")).toBe(false);
  });

  it("eski substring '110.7'de '10.7'yi eşlerdi; medianRegex eşlemez", () => {
    expect("110.7".includes("10.7")).toBe(true);
    expect(medianRegex("10.7").test("110.7 ms")).toBe(false);
    expect(medianRegex("10.7").test("10.7 ms")).toBe(true);
  });
});

/**
 * DENETİM DÖNGÜSÜ (güvenlik analisti bulgusu, düşük): docs/security-pass.md
 * "korunan klon disiplini" satırı cloneBundleTo'nun yeniden deneme sayısını
 * "3 denemeli" yazıyordu; kod 5'ti (tests/security-release/helpers/
 * bundle-client.ts — "eski 3 denemelik" yorumu 3'ün bayat sayı olduğunu
 * teyit eder). Kanıt dokümanındaki mekanizma doğruydu, sayı kodla
 * uyuşmuyordu. Bu blok doküman iddiasını kodun yayımlanmış sabitiyle
 * (CLONE_MAX_ATTEMPTS) çapraz pinler: deneme sayısı hangi yönde değişirse
 * doküman + bu test birlikte güncellenmek zorundadır (ADR-010 — kanıt
 * dokümanı kodun yayımlanan değerinden sapan bir sayı taşıyamaz).
 */
describe("DENETİM DÖNGÜSÜ: security-pass.md klon yeniden deneme sayısı kodla uyumlu", () => {
  it("docs/security-pass.md cloneBundleTo 'N denemeli' iddiası CLONE_MAX_ATTEMPTS ile birebir", () => {
    const text = readFileSync(
      fileURLToPath(new URL("../docs/security-pass.md", import.meta.url)),
      "utf8",
    );
    const claim = text.match(/cloneBundleTo[^\n]*?(\d+) denemeli/);
    expect(claim, "korunan klon disiplini satırı 'N denemeli' iddiası taşımalı").not.toBeNull();
    const statedAttempts = Number(claim?.[1]);
    expect(Number.isNaN(statedAttempts), "iddia sayısal olmalı").toBe(false);
    expect(statedAttempts).toBe(CLONE_MAX_ATTEMPTS);
  });
});

/**
 * DENETİM DÖNGÜSÜ (bağımsız denetçi bulguları, düşük): (1) docs/benchmarks.md
 * fixture sha256 literali hiçbir testle sabitlenmemişti — benchmark.test.ts
 * yalnızca koşum-içi determinizmi kanıtlıyor (modelAgain.hash ===
 * report.fixtureHash; ikisi de yeniden hesaplanır), fixture üreticisi
 * değişirse kanıt dokümanındaki literal sessizce bayatlıyordu
 * (CLONE_MAX_ATTEMPTS piniyle aynı bayatlık sınıfı). Bu blok literali GERÇEK
 * üretici çıktısıyla (buildFixtureModel(1000).hash) çapraz pinler; medyan ve
 * soğuk indeks satırları da release-docs kapsamına alınır (benchmarks.md bu
 * dosyada hiç okunmuyordu). (2) security-pass.md scanForCredentials satır
 * aralığı CLONE_MAX_ATTEMPTS bloğu eklenince kaymıştı; aralık iddiası artık
 * kaynak dilimin gerçekten tarayıcıyı gösterdiğinin kanıtıyla pinlenir
 * (ADR-010: kanıt dokümanı kodun yayınlanan konumundan sapamaz).
 */
describe("DENETİM DÖNGÜSÜ: benchmarks.md fixture sha256 + security-pass.md satır aralığı", () => {
  function readRepoDoc(relativeUrl: string): string {
    return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf8");
  }

  it("docs/benchmarks.md fixture sha256 literali === buildFixtureModel(1000).hash (gerçek üretici çıktısı)", () => {
    const claim = readRepoDoc("../docs/benchmarks.md").match(/sha256:\s*`([0-9a-f]{64})`/);
    expect(claim, "benchmarks.md'de fixture sha256 literali bulunmalı").not.toBeNull();
    expect(claim?.[1]).toBe(buildFixtureModel(1000).hash);
  });

  it("benchmarks.md medyan + soğuk indeks satırları 2026-11-10 pinli değerlerle aynı (11.8/13.0/10.7/16370.3)", () => {
    // benchmarks.md birimi tablo BAŞLIĞINDA taşır ("Medyan (ms)"); hücreler
    // çıplak sayıdır — bu yüzden pin kolon-biçimli hücre regex'i kullanır
    // ("| <değer> |"), CHANGELOG'daki "N ms" medianRegex'inden farklıdır.
    const benchMedianCell = (median: string): RegExp =>
      new RegExp(`\\|\\s*${median.replace(".", "\\.")}\\s*\\|`);
    const text = readRepoDoc("../docs/benchmarks.md");
    expect(text).toMatch(benchMedianCell("11.8"));
    expect(text).toMatch(benchMedianCell("13.0"));
    expect(text).toMatch(benchMedianCell("10.7"));
    expect(text).toContain("16370.3");
  });

  it("security-pass.md scanForCredentials satır aralığı bundle-client.ts'te gerçekten tarayıcıyı gösterir", () => {
    const text = readRepoDoc("../docs/security-pass.md");
    const claim = text.match(
      /`scanForCredentials` \(`tests\/security-release\/helpers\/bundle-client\.ts:(\d+)-(\d+)`\)/,
    );
    expect(claim, "security-pass.md scanForCredentials satır aralığı taşımalı").not.toBeNull();
    const start = Number(claim?.[1]);
    const end = Number(claim?.[2]);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThanOrEqual(start);
    const sourceLines = readRepoDoc(
      "../tests/security-release/helpers/bundle-client.ts",
    ).split("\n");
    const referencedSlice = sourceLines.slice(start - 1, end).join("\n");
    expect(referencedSlice, "aralık CREDENTIAL_PATTERNS tanımını içermeli").toContain(
      "export const CREDENTIAL_PATTERNS",
    );
    expect(referencedSlice, "aralık scanForCredentials tanımını içermeli").toContain(
      "export function scanForCredentials",
    );
  });
});

/**
 * BAĞIMSIZ DENETİM DÖNGÜSÜ (2026-11-18): Sprint-8 çok-dil genişlemesi ve
 * 2026-11-17/18 denetim turu sonrasında dokümanlar ile gerçek kod/bundle yüzeyi
 * arasındaki bayatlıkları kapatan tam parite pinleri.
 */
describe("BAĞIMSIZ DENETİM DÖNGÜSÜ (2026-11-18): doküman↔kod tam parite pini", () => {
  const DOT_DOT = "." + ".";
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), DOT_DOT);
  const OVERVIEW_PATH = path.join(REPO_ROOT, "docs", "project-overview.tr-en.md");
  const SECURITY_PASS_PATH = path.join(REPO_ROOT, "docs", "security-pass.md");
  const BUNDLE_MANIFEST_PATH = path.join(
    REPO_ROOT,
    "packages",
    "mcp-server",
    "dist",
    "bundle-manifest.json",
  );
  const TSCONFIG_PATH = path.join(REPO_ROOT, "tsconfig.json");
  const ANTIGRAVITY_TEST_PATH = path.join(
    REPO_ROOT,
    "integrations",
    "antigravity",
    "causoryn",
    "test",
    "antigravity-plugin.test.ts",
  );

  function sleepSyncLocal(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  function readManifestBundleShaWithRetry(): string | null {
    if (!existsSync(BUNDLE_MANIFEST_PATH)) return null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (!existsSync(BUNDLE_MANIFEST_PATH)) return null;
        const parsed = JSON.parse(readFileSync(BUNDLE_MANIFEST_PATH, "utf8")) as {
          files?: Record<string, string>;
        };
        const sha = parsed.files?.["mcp-server.mjs"];
        if (typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha)) {
          return sha;
        }
        lastError = new Error("bundle-manifest.json içinde geçerli mcp-server.mjs sha256 yok");
      } catch (error) {
        lastError = error;
      }
      if (attempt < 2) sleepSyncLocal(1_500);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  it("docs/architecture.md: 5 dil adapter'ı, 4 native sidecar, 18 npm workspace paketi, 14 tsconfig referansı, sidecar-ipc, packages/causoryn ve secret-scan kapısıyla senkron; bayat ifadeler yok", () => {
    const text = readDoc("architecture");
    for (const adapter of [
      "`adapters/typescript`",
      "`adapters/csharp-roslyn`",
      "`adapters/python`",
      "`adapters/go`",
      "`adapters/rust`",
    ]) {
      expect(text).toContain(adapter);
    }
    for (const sidecar of [
      "`native/roslyn-worker`",
      "`native/python-worker`",
      "`native/go-worker`",
      "`native/rust-worker`",
    ]) {
      expect(text).toContain(sidecar);
    }
    expect(text).toContain("`packages/sidecar-ipc`");
    expect(text).toContain("`packages/causoryn`");
    expect(text).toContain("storage.dataDbPath");
    expect(text).toContain(".github/workflows/ci.yml");

    const tsconfig = JSON.parse(readFileSync(TSCONFIG_PATH, "utf8")) as {
      references?: Array<{ path?: string }>;
    };
    expect(tsconfig.references).toHaveLength(14);
    expect(text).toMatch(/\b18\b[^\n]*workspace paket/i);
    expect(text).toMatch(/tsconfig\.json[^\n]*\b14\b[^\n]*refer/i);

    const rootPkg = JSON.parse(readFileSync(DOC_PATHS.rootPkg, "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(rootPkg.scripts?.["secret-scan"]).toBe("node scripts/secret-scan.mjs");
    expect(text).toContain("npm run secret-scan");
    expect(text).toContain("mcp_config.json");
    expect(text).toContain("scripts/mcp-server.mjs");

    expect(text).not.toContain("9 doğrudan reference");
    expect(text).not.toContain("12 doğrudan referans");
    expect(text).not.toContain("TS+C# yönlendirme");
  });

  it("docs/tool-contracts.md: 10 alanlı envelope (error dahil), annotations/readOnlyHint, InMemoryGraphRepository + storage.dataDbPath, snapshot formatı, PreflightManifestStore ve export view açık reddi yazılı", () => {
    const text = readDoc("toolContracts");
    const envelopeHeadingIndex = text.indexOf("## Standart envelope");
    const nextHeadingIndex = text.indexOf("\n## ", envelopeHeadingIndex + 1);
    expect(envelopeHeadingIndex).toBeGreaterThanOrEqual(0);
    const envelopeSection = text.slice(
      envelopeHeadingIndex,
      nextHeadingIndex > envelopeHeadingIndex ? nextHeadingIndex : text.length,
    );
    expect(envelopeSection).toContain("`error`");
    expect(envelopeSection).toContain("annotations");
    expect(envelopeSection).toContain("readOnlyHint");

    expect(text).toContain("InMemoryGraphRepository");
    expect(text).toContain("storage.dataDbPath");
    expect(text).toContain("architecture-snapshot.json");
    expect(text).toContain("PreflightManifestStore");
    expect(text).toMatch(/view[^\n]*INVALID_ARGUMENT|INVALID_ARGUMENT[^\n]*view/i);
  });

  it("docs/security-pass.md: bundle sha256 manifest ile birebir eşleşir ve child_process notu 4 sidecar + git-read.ts + cargo.ts yüzeyini açıklar", () => {
    expect(existsSync(SECURITY_PASS_PATH)).toBe(true);
    const text = readFileSync(SECURITY_PASS_PATH, "utf8");

    const bundleClaim = text.match(/Bundle kimliği:[^\n]*`([0-9a-f]{64})`/);
    expect(bundleClaim, "security-pass.md Bundle kimliği sha256 taşımalı").not.toBeNull();

    const manifestSha = readManifestBundleShaWithRetry();
    if (manifestSha !== null) {
      expect(bundleClaim?.[1]).toBe(manifestSha);
    }

    expect(text).toContain("git-read.ts");
    expect(text).toContain("cargo.ts");
    expect(text).toContain("worker-process.ts");
    for (const sidecarRef of ["csharp-roslyn", "python", "go", "rust"]) {
      expect(text).toContain(sidecarRef);
    }
    expect(text).not.toContain("bundle'da 2 meşru kullanım vardır");
  });

  it("docs/project-overview.tr-en.md: yasak bayat iddialar, yanlış satır atıfları ve yazım hataları tamamen giderilmiş", () => {
    expect(existsSync(OVERVIEW_PATH)).toBe(true);
    const text = readFileSync(OVERVIEW_PATH, "utf8");

    // 1) Python worker argümanları: -I yok, yalnız -B
    expect(text).not.toContain("python -I -B");
    expect(text).toContain("python -B");

    // 2) SYMBOL_NOT_FOUND K-011 kaydı
    expect(text).not.toContain("SYMBOL_NOT_FOUND kayıtsız");
    expect(text).not.toContain("`SYMBOL_NOT_FOUND` kayıtsız");
    expect(text).not.toMatch(/still ADR-uncovered|not yet ADR-covered/i);

    // 3) ROUTES_TO beş dilde daima verified DEĞİL (C# heuristic, Go heuristic/unresolved olabilir)
    expect(text).not.toMatch(/ROUTES_TO\s+\*\*?her dilde daima verified/i);
    expect(text).not.toContain("ROUTES_TO edges are always verified + evidenced in all five languages");
    expect(text).toContain("WorkerAnalyzer.cs:1475-1508");
    expect(text).toContain("routes.go:120-170");

    // 4) secret-scan mevcut
    expect(text).not.toMatch(/adanmış secret-scan script(?:'i)? yok/i);
    expect(text).not.toContain("no dedicated secret-scan script");
    expect(text).toContain("scripts/secret-scan.mjs");
    expect(text).toContain("npm run secret-scan");

    // 5) C# frameworkLinkers: "aspnet-core-route-attributes (L3)" (Track 2 K-022 güncellemesi)
    expect(text).not.toContain('frameworkLinkers: "none"');
    expect(text).not.toContain('frameworkLinkers:"none"');
    expect(text).not.toContain('frameworkLinkers: "yok"');
    expect(text).toContain("aspnet-core-route-attributes (L3)");

    // 6) Doğru kaynak satır atıfları
    expect(text).not.toContain("snapshot.ts:8-21");
    expect(text).not.toContain("validation.ts:10-14");
    expect(text).toContain("ids.ts:147-161");
    expect(text).toContain("snapshot.ts:22-35");
    expect(text).toContain("snapshot.ts:379-397");
    expect(text).toContain("validation.ts:23-27");
    expect(text).not.toContain("docs/architecture.md:11-18");
    expect(text).toContain("docs/architecture.md:13-22");
    expect(text).not.toMatch(/docs\/tool-contracts\.md:40,\s*72/);
    expect(text).toContain("docs/tool-contracts.md:45,72");
    expect(text).toContain("docs/tool-contracts.md:45, 72");
    expect(text).not.toContain("services.ts:696-712");
    expect(text).not.toContain("services.ts:704-722");
    expect(text).toContain("services.ts:698-716,765-771");
    expect(text).toContain("services.ts:698-716, 765-771");
    expect(text).not.toContain("output-policy.ts:11-15, 27-48");

    // 7) K-012 Phase C (Phase D değil) + cursor yazım hatası düzeltmesi
    expect(text).not.toContain("Phase D added no fourth extension");
    expect(text).toMatch(/K-012[^\n]*Phase C/);
    expect(text).not.toContain("{v:1,o:<int> as base64url");
    expect(text).toContain("{v:1,o:<int>}");
    expect(text).not.toContain("wiki/index.md:5-27");
    expect(text).toContain("wiki/index.md:5-28");
  });

  it("docs/project-overview.tr-en.md: TR ve EN bölümleri simetrik olarak 18 workspace paketi, sidecar-ipc, packages/causoryn, storage.dataDbPath, CI iş akışı, MCP annotations ve Antigravity sahnelemesini taşır", () => {
    const text = readFileSync(OVERVIEW_PATH, "utf8").replace(/\r\n/g, "\n");
    const splitMarker = "\n# English\n";
    const splitIdx = text.indexOf(splitMarker);
    expect(splitIdx, "TR / EN ayırıcı başlığı bulunmalı").toBeGreaterThan(0);

    const trSection = text.slice(0, splitIdx);
    const enSection = text.slice(splitIdx);

    for (const half of [trSection, enSection]) {
      expect(half).toContain("d197f21");
      expect(half).toContain("4c9c188");
      expect(half).toContain("typescript");
      expect(half).toContain("esbuild");
      expect(half).toContain("18");
      expect(half).toContain("sidecar-ipc");
      expect(half).toContain("causoryn setup");
      expect(half).toContain("storage.dataDbPath");
      expect(half).toContain(".github/workflows/ci.yml");
      expect(half).toContain("K-020");
      expect(half).toContain("K-021");
      expect(half).toContain("SCHEMA_VERSION");
      expect(half).toContain("readOnlyHint");
      expect(half).toContain("K-011");
      expect(half).toContain("UNSUPPORTED_LANGUAGE");
      expect(half).toContain("InMemoryGraphRepository");
      expect(half).toContain("PreflightManifestStore");
      expect(half).toContain("openWikiStores");
      expect(half).toContain("mcp_config.json");
      expect(half).toContain("mcp.json");
      expect(half).toContain("scripts/mcp-server.mjs");
      expect(half).toContain("NOT RUN");
      expect(half).toContain("wiki/index.md:5-28");
      expect(half).toContain("docs/architecture.md:13-22");
      expect(half).toContain("output-policy.ts:11-48");
      expect(half).toContain("services.ts:698-716");
      expect(half).toContain("aspnet-core-route-attributes (L3)");
      expect(half).toContain("0.2.3");
      expect(half).toContain("K-022");
    }
    expect(text).not.toContain('SERVER_VERSION="0.1.0"');
    expect(text).not.toMatch(/npm audit --json`?\s*→\s*\*\*9 moderate\*\*/);
  });

  it("CHANGELOG.md ve docs/implementation-status.md: secret-scan + npm audit (0 açık) kapanış notu ve antigravity-plugin.test.ts satır sayısı diskle senkron", () => {
    const changelog = readDoc("changelog");
    const start = changelog.indexOf("## [Unreleased]");
    const end = changelog.indexOf("## [0.2.3]");
    expect(end, "## [0.2.3] başlığı olmalı").toBeGreaterThan(start);
    const unreleased = changelog.slice(start, end);
    expect(unreleased).toContain("Rate-limit/concurrency resource budget (K-010 kapsam dışı beyanı)");
    expect(unreleased).toContain("scripts/secret-scan.mjs");
    expect(unreleased).toMatch(/0\s+(?:güvenlik açığı|vulnerabilit)/i);

    const status = readDoc("status");
    const actualAntigravityTestLines = readFileSync(ANTIGRAVITY_TEST_PATH, "utf8")
      .replace(/\r\n/g, "\n")
      .replace(/\n$/, "")
      .split("\n").length;
    expect(status).toContain(`antigravity-plugin.test.ts\` (${String(actualAntigravityTestLines)} satır`);
    expect(status).not.toContain("antigravity-plugin.test.ts` (495 satır");
    expect(status).toContain("scripts/secret-scan.mjs");
  });

  it("K-022 açık kaynak yönetişim dosyaları, temiz doküman yüzeyi (0 kişisel yol) ve wiki paritesi sağlanmış", () => {
    const governanceFiles = [
      "SECURITY.md",
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      path.join(".github", "dependabot.yml"),
      path.join(".github", "PULL_REQUEST_TEMPLATE.md"),
      path.join(".github", "ISSUE_TEMPLATE", "bug_report.yml"),
      path.join(".github", "ISSUE_TEMPLATE", "feature_request.yml"),
      path.join(".github", "ISSUE_TEMPLATE", "config.yml"),
    ];
    for (const rel of governanceFiles) {
      expect(existsSync(path.join(REPO_ROOT, rel)), `yönetişim dosyası eksik: ${rel}`).toBe(true);
    }

    if (existsSync(path.join(REPO_ROOT, "wiki"))) {
      const sprint8 = readFileSync(path.join(REPO_ROOT, "wiki", "sprint-8.md"), "utf8");
      expect(sprint8).not.toContain("Go L2+L3");
      expect(sprint8).toContain("Go L1/heuristic+L3");

      const decisions = readFileSync(path.join(REPO_ROOT, "wiki", "decisions.md"), "utf8");
      expect(decisions).toContain("K-022");
      const wikiLog = readFileSync(path.join(REPO_ROOT, "wiki", "log.md"), "utf8");
      expect(wikiLog).toContain("K-022");
    }

    const zcodeMarketplace = JSON.parse(readFileSync(DOC_PATHS.zcodeMarketplace, "utf8")) as {
      owner?: { name?: string; url?: string };
      plugins?: Array<{ version?: string }>;
    };
    expect(zcodeMarketplace.owner?.name).toBe("Causoryn Contributors");
    expect(zcodeMarketplace.plugins?.[0]?.version).toBe("0.2.3");

    const rootReadme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    const pkgReadme = readFileSync(path.join(REPO_ROOT, "packages", "causoryn", "README.md"), "utf8");
    for (const readme of [rootReadme, pkgReadme]) {
      expect(readme).toContain("0.2.3");
      expect(readme).toMatch(/Pre-1\.0 Public Preview/i);
      expect(readme).not.toContain("single zero-compile npm package");
      expect(readme).toContain("crates.io");
      expect(readme).toContain("SECURITY.md");
      expect(readme).toContain("CONTRIBUTING.md");
      expect(readme).toContain("CODE_OF_CONDUCT.md");
      expect(readme).toContain("THIRD-PARTY-NOTICES.md");
      expect(readme).toContain("## Why Causoryn?");
      expect(readme).toContain("11.8 ms");
      expect(readme).toContain("13.0 ms");
      expect(readme).toContain("10.7 ms");
    }
    expect(rootReadme).toContain("```mermaid");
    expect(rootReadme).toContain("examples/fixture-ts-orders");
    expect(rootReadme).toContain("causoryn_preflight_change");

    const userFacingDocs = [
      "README.md",
      path.join("packages", "causoryn", "README.md"),
      "CHANGELOG.md",
      path.join("docs", "compatibility-matrix.md"),
      path.join("docs", "implementation-status.md"),
      path.join("docs", "project-overview.tr-en.md"),
      path.join("adapters", "go", "README.md"),
      path.join("examples", "fixture-go-app", "README.md"),
      path.join("integrations", "zcode", "causoryn", "README.md"),
      path.join("integrations", "antigravity", "causoryn", "README.md"),
    ];
    const personalUser = "ber" + "ka";
    const localRepoPathRe = new RegExp("D:[\\\\/]Cau" + "soryn", "i");
    const localToolsPathRe = new RegExp("D:[\\\\/]to" + "ols", "i");
    for (const rel of userFacingDocs) {
      const text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect(text, `${rel} kişisel kullanıcı adı içeremez`).not.toContain(personalUser);
      expect(text, `${rel} yerel repo sürücü yolu içeremez`).not.toMatch(localRepoPathRe);
      expect(text, `${rel} yerel tools sürücü yolu içeremez`).not.toMatch(localToolsPathRe);
    }
  });

  it("docs/compatibility-matrix.md: Antigravity satırı $schema'sız plugin.json + mcp_config.json + mcp.json + README.md + sahnelenmiş scripts/mcp-server.mjs stdio el sıkışması gerçekliğiyle senkron; ilgili sayfalarda README.md kayıtlı", () => {
    const text = readDoc("compatibility");
    const row = matrixRowFor(text, "Antigravity");
    expect(row).toBeTruthy();
    expect(row).toContain("`plugin.json` (`$schema`'sız yerel yükleyici uyumlu)");
    expect(row).toContain("`mcp_config.json`");
    expect(row).toContain("`mcp.json`");
    expect(row).toContain("`README.md`");
    expect(row).toContain("sahnelenmiş `scripts/mcp-server.mjs`");
    expect(row).toContain(
      "doğrudan `stdio` el sıkışması (29 araç) `antigravity-plugin.test.ts` ile doğrulandı; `agy` CLI kurulum/smoke NOT RUN",
    );
    expect(row).not.toContain("TŞ §17.1'den birebir yazıldı ve statik testlerle denetlendi");

    const antigravityReadmePath = path.join(
      REPO_ROOT,
      "integrations",
      "antigravity",
      "causoryn",
      "README.md",
    );
    expect(existsSync(antigravityReadmePath)).toBe(true);
    const relatedIdx = text.indexOf("## İlgili sayfalar");
    expect(relatedIdx).toBeGreaterThanOrEqual(0);
    expect(text.slice(relatedIdx)).toContain("`integrations/antigravity/causoryn/README.md`");
  });

  it("TR / EN tam dokümantasyon paritesi: 16 TR dokümanın her birinin docs/en/ karşılığı mevcut, kırık yerel markdown linki yok, EN tool-contracts 29 aracı ve EN security-pass/benchmarks pinli hashleri taşır", () => {
    const bilingualPairs: ReadonlyArray<readonly [string, string]> = [
      ["docs/README.md", "docs/en/README.md"],
      ["docs/architecture.md", "docs/en/architecture.md"],
      ["docs/cli-and-configuration.md", "docs/en/cli-and-configuration.md"],
      ["docs/language-analyzers.md", "docs/en/language-analyzers.md"],
      ["docs/tool-contracts.md", "docs/en/tool-contracts.md"],
      ["docs/wiki-spec.md", "docs/en/wiki-spec.md"],
      ["docs/compatibility-matrix.md", "docs/en/compatibility-matrix.md"],
      ["docs/security-pass.md", "docs/en/security-pass.md"],
      ["docs/benchmarks.md", "docs/en/benchmarks.md"],
      ["docs/implementation-status.md", "docs/en/implementation-status.md"],
      ["docs/BACKLOG.md", "docs/en/BACKLOG.md"],
      ["docs/adr/ADR-002-no-llm.md", "docs/en/adr/ADR-002-no-llm.md"],
      ["docs/hosts/claude-code.md", "docs/en/hosts/claude-code.md"],
      ["docs/hosts/codex.md", "docs/en/hosts/codex.md"],
      ["docs/hosts/antigravity.md", "docs/en/hosts/antigravity.md"],
      ["docs/hosts/zcode.md", "docs/en/hosts/zcode.md"],
    ];

    const personalUser = "ber" + "ka";
    const localRepoPathRe = new RegExp("D:[\\\\/]Cau" + "soryn", "i");
    const localToolsPathRe = new RegExp("D:[\\\\/]to" + "ols", "i");

    for (const [trRel, enRel] of bilingualPairs) {
      const trAbs = path.join(REPO_ROOT, ...trRel.split("/"));
      const enAbs = path.join(REPO_ROOT, ...enRel.split("/"));
      expect(existsSync(trAbs), `TR doküman eksik: ${trRel}`).toBe(true);
      expect(existsSync(enAbs), `EN doküman eksik: ${enRel}`).toBe(true);

      for (const [docRel, docAbs] of [[trRel, trAbs], [enRel, enAbs]] as const) {
        const content = readFileSync(docAbs, "utf8");
        expect(content.trim().length, `${docRel} boş olamaz`).toBeGreaterThan(200);
        expect(content, `${docRel} kişisel kullanıcı adı içeremez`).not.toContain(personalUser);
        expect(content, `${docRel} yerel sürücü yolu içeremez`).not.toMatch(localRepoPathRe);
        expect(content, `${docRel} yerel tools yolu içeremez`).not.toMatch(localToolsPathRe);
        expect(content, `${docRel} 1.0.0 yayınlandı iddiası taşıyamaz`).not.toMatch(/^## \[1\.0\.0\]/m);

        // Göreli markdown link kontrolü (kod blokları dışındaki [etiket](hedef) linkleri):
        const strippedCode = content.replace(/```[\s\S]*?```/g, "");
        const linkRe = /\[[^\]]+\]\(([^)#\s]+)(?:#[^)]*)?\)/g;
        let m: RegExpExecArray | null;
        while ((m = linkRe.exec(strippedCode)) !== null) {
          const href = m[1] ?? "";
          if (
            href.length === 0 ||
            href.startsWith("http://") ||
            href.startsWith("https://") ||
            href.startsWith("mailto:") ||
            href.startsWith("file://")
          ) {
            continue;
          }
          const resolvedLink = path.resolve(path.dirname(docAbs), href);
          expect(
            existsSync(resolvedLink),
            `${docRel} içinde kırık göreli link: (${href}) -> ${resolvedLink}`,
          ).toBe(true);
        }
      }
    }

    // EN tool-contracts.md: 29 aracın tamamını içerir
    const enToolsText = readFileSync(path.join(REPO_ROOT, "docs", "en", "tool-contracts.md"), "utf8");
    const enListedTools: string[] = [];
    let inEnContractSection = false;
    for (const line of enToolsText.split(/\r?\n/)) {
      if (line.startsWith("## ")) {
        inEnContractSection = line.startsWith("## Core") || line.startsWith("## Wiki");
        continue;
      }
      if (!inEnContractSection) continue;
      const match = line.match(/^\|\s*`?(causoryn_[a-z_0-9]+)`?\s*\|/);
      if (match?.[1]) enListedTools.push(match[1]);
    }
    expect(enListedTools).toHaveLength(TOOL_NAMES.length);
    expect([...enListedTools].sort()).toEqual([...TOOL_NAMES].sort());

    // TR ve EN tool-contracts.md: INDEXED_ADAPTERS gerçek runtime analyzerId kimliklerini taşır
    const trToolsText = readDoc("toolContracts");
    for (const toolsDoc of [trToolsText, enToolsText]) {
      for (const runtimeId of [
        "`ts-adapter`",
        "`roslyn-worker`",
        "`python-worker`",
        "`go-worker`",
        "`rust-worker`",
        "`express+nextjs`",
      ]) {
        expect(toolsDoc).toContain(runtimeId);
      }
    }

    // EN compatibility-matrix.md: 4 host + Antigravity NOT RUN dürüstlüğü
    const enCompat = readFileSync(path.join(REPO_ROOT, "docs", "en", "compatibility-matrix.md"), "utf8");
    for (const host of ["Claude Code", "Codex", "ZCode", "Antigravity"]) {
      expect(matrixRowFor(enCompat, host), `EN matriste ${host} eksik`).toBeTruthy();
    }
    const enAntigravityRow = matrixRowFor(enCompat, "Antigravity");
    expect(enAntigravityRow).toMatch(/NOT RUN/i);
    expect(enAntigravityRow).not.toMatch(/PASS/i);

    // EN security-pass.md: güncel bundle sha256 ve CLONE_MAX_ATTEMPTS
    const enSec = readFileSync(path.join(REPO_ROOT, "docs", "en", "security-pass.md"), "utf8");
    const manifestSha = readManifestBundleShaWithRetry();
    if (manifestSha !== null) {
      expect(enSec).toContain(manifestSha);
    }

    // EN benchmarks.md: gerçek fixture sha256 + medyanlar
    const enBench = readFileSync(path.join(REPO_ROOT, "docs", "en", "benchmarks.md"), "utf8");
    expect(enBench).toContain(buildFixtureModel(1000).hash);
    expect(enBench).toContain("11.8");
    expect(enBench).toContain("13.0");
    expect(enBench).toContain("10.7");
    expect(enBench).toContain("16370.3");

    // EN implementation-status.md: B7 Partial kalır (ADR-010)
    const enStatus = readFileSync(path.join(REPO_ROOT, "docs", "en", "implementation-status.md"), "utf8");
    expect(enStatus).toMatch(/\|\s*B7\s*\|[^\n]*\*\*Partial\*\*/);
  });
});
