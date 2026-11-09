import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_VERSION, TOOL_NAMES } from "../packages/mcp-server/src/version.js";

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
