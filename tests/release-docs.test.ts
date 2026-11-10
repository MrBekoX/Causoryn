import { existsSync, readFileSync } from "node:fs";
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

  it("docs/hosts/: claude-code.md + codex.md + antigravity.md mevcut", () => {
    expect(existsSync(DOC_PATHS.claudeDoc)).toBe(true);
    expect(existsSync(DOC_PATHS.codexDoc)).toBe(true);
    expect(existsSync(DOC_PATHS.antigravityDoc)).toBe(true);
  });

  it("PARTIAL yüzey (dürüst durum): docs/hosts 3 sayfa iken matris 4 hostu kapsar; ZCode integrations README + dev marketplace ile belgeli", () => {
    // ZCode'un host kılavuzu docs/hosts/ altında DEĞİLDİR: kurulum GUI adımıdır
    // (CLI yok — F2 bulgusu) ve dokümanı integrations/zcode/causoryn/README.md'dir.
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

  it("causoryn_refresh_index incremental destekliyor gibi SUNULAMAZ (açık ret ADR-010 kaydı korunur)", () => {
    const text = readDoc("toolContracts");
    const row = text
      .split("\n")
      .find((l) => l.startsWith("| `causoryn_refresh_index`"));
    expect(row).toBeTruthy();
    expect(row).toContain("incremental");
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

describe("F9: sürüm kararı — 0.1.0 public snapshot (1.0.0 DEĞİL)", () => {
  it("CHANGELOG.md Keep a Changelog formatında ve [0.1.0] - tarih girişli", () => {
    const text = readDoc("changelog");
    expect(text).toContain("Keep a Changelog");
    expect(text).toMatch(/^## \[0\.1\.0\] - \d{4}-\d{2}-\d{2}$/m);
  });

  it("kök package.json version === SERVER_VERSION === 0.1.0 (karar üç yüzeyde tutarlı)", () => {
    const pkg = JSON.parse(readFileSync(DOC_PATHS.rootPkg, "utf8")) as {
      version?: string;
    };
    expect(pkg.version).toBe("0.1.0");
    expect(pkg.version).toBe(SERVER_VERSION);
  });

  it("karar gerekçesi CHANGELOG'da ADR-010 atfıyla yazılı", () => {
    const text = readDoc("changelog");
    expect(text).toContain("ADR-010");
    expect(text).toContain("0.1.0");
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
    const end = text.indexOf("## [0.1.0]");
    expect(start, "## [Unreleased] başlığı olmalı").toBeGreaterThanOrEqual(0);
    expect(end, "## [0.1.0] başlığı olmalı").toBeGreaterThan(start);
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
