import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Sprint-7 F3+F4 host dokümantasyon doğrulama testi (docs/hosts/ yüzeyi).
 *
 * Smoke testlerin kalıcı yüzeyi budur: docs/hosts/ altındaki host kılavuzları,
 * gerçek CLI davranışına göre yazılmış örnek blokları İÇERİR ve bundle
 * artifact'ı gerçekten var OLUR. Testler salt okunurdur — depoya hiçbir şey
 * yazılmaz (ADR-008); gerçek `claude mcp` / `codex mcp` çağrıları bu testin
 * parçası DEĞİLDİR (kullanıcı config'ine dokunmamak için ayrı ve manuel
 * koşulur; kanıtları görev raporundadır).
 */

/**
 * Beyaz liste: yalnızca bu sabit, literal yollar okunur. Her yol import.meta.url
 * üzerinden LITERAL göreceli URL specifier ile çözümlenir; dinamik yol
 * parametresi / path.resolve(path.join(...)) zinciri yoktur — path traversal
 * yüzeyi tasarım gereği yoktur (statik güvenlik kuralı: whitelist doğrulaması).
 */
const DOCS = {
  claudeDoc: fileURLToPath(
    new URL("../docs/hosts/claude-code.md", import.meta.url),
  ),
  codexDoc: fileURLToPath(
    new URL("../docs/hosts/codex.md", import.meta.url),
  ),
  bundleEntry: fileURLToPath(
    new URL("../packages/mcp-server/dist/mcp-server.mjs", import.meta.url),
  ),
  sqlitePrebuild: fileURLToPath(
    new URL(
      "../packages/mcp-server/dist/node_modules/better-sqlite3/prebuilds/win32-x64.node",
      import.meta.url,
    ),
  ),
} as const;

/**
 * Paylaşılan okuma yardımcıları: beyaz listeli yol + varlık ön-koşulu.
 */
function readClaudeDoc(): string {
  expect(
    existsSync(DOCS.claudeDoc),
    "docs/hosts/claude-code.md mevcut olmalı",
  ).toBe(true);
  return readFileSync(DOCS.claudeDoc, "utf8");
}

function readCodexDoc(): string {
  expect(existsSync(DOCS.codexDoc), "docs/hosts/codex.md mevcut olmalı").toBe(
    true,
  );
  return readFileSync(DOCS.codexDoc, "utf8");
}

/**
 * F1 bundle artifact — taze-checkout'a dayanıklı yüzey (denetim bulgusu 3):
 * dist/ commit edilmediği için artifact testleri koşulludur (it.runIf);
 * onların yerine HER ZAMAN koşan "partial bacağı" bundle'ın ÜRETİLEBİLİRLİĞİNİ
 * doğrular (build script + package.json script + esbuild bağımlılığı). Böylece
 * test zinciri build:bundle koşulmayan ortamda kırmızıya düşmez; artifact
 * varken determinizm hash karşıtlamasıyla partial doğrulanır.
 */
describe("F1 bundle artifact (üretilebilirlik + koşullu determinizm)", () => {
  const buildScript = fileURLToPath(
    new URL("../packages/mcp-server/scripts/build-bundle.mjs", import.meta.url),
  );
  const mcpPkg = fileURLToPath(
    new URL("../packages/mcp-server/package.json", import.meta.url),
  );
  const rootPkg = fileURLToPath(
    new URL("../package.json", import.meta.url),
  );
  const manifestPath = fileURLToPath(
    new URL("../packages/mcp-server/dist/bundle-manifest.json", import.meta.url),
  );
  const artifactBuilt = existsSync(DOCS.bundleEntry);

  it("HER ZAMAN (partial bacağı): bundle üretilebilir — build-bundle.mjs + build:bundle + esbuild", () => {
    expect(existsSync(buildScript)).toBe(true);
    const pkg = JSON.parse(readFileSync(mcpPkg, "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["build:bundle"]).toBeTruthy();
    const root = JSON.parse(readFileSync(rootPkg, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(root.dependencies?.esbuild).toMatch(/^\^?0\.28\./);
  });

  it.runIf(artifactBuilt)("dist/mcp-server.mjs mevcut", () => {
    expect(existsSync(DOCS.bundleEntry)).toBe(true);
  });

  it.runIf(artifactBuilt)(
    "manifest sha256 == gerçek dosya sha256 (determinizm partial doğrulaması)",
    () => {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        files: Record<string, string>;
      };
      const recorded = manifest.files["mcp-server.mjs"];
      expect(recorded).toMatch(/^[0-9a-f]{64}$/);
      expect(recorded).toBe(
        createHash("sha256")
          .update(readFileSync(DOCS.bundleEntry))
          .digest("hex"),
      );
      // External native binding manifest'te beyanlı (esbuild .node gömemez — ADR-010):
      expect(
        Object.keys(manifest.files).some((k) =>
          k.includes("prebuilds/win32-x64.node"),
        ),
      ).toBe(true);
    },
  );

  it.runIf(artifactBuilt)(
    "external better-sqlite3 win32-x64 prebuild diskte (dist/node_modules)",
    () => {
      expect(existsSync(DOCS.sqlitePrebuild)).toBe(true);
    },
  );
});

/** F3: Claude Code host kılavuzu. */
describe("docs/hosts/claude-code.md (F3)", () => {
  it("mevcut ve stdio launch komutunu içeriyor", () => {
    const text = readClaudeDoc();
    expect(text).toContain("packages/mcp-server/dist/mcp-server.mjs");
    expect(text).toContain("node");
  });

  it(".mcp.json proje-scoped örnek bloğu içeriyor (mcpServers.causoryn)", () => {
    const text = readClaudeDoc();
    // .mcp.json örneği proje kökünde payload biçimi:
    // { "mcpServers": { "causoryn": { "command": "node", "args": [...] } } }
    expect(text).toContain('"mcpServers"');
    expect(text).toContain('"causoryn"');
    expect(text).toContain('"command"');
    expect(text).toContain('"args"');
  });

  it("`claude mcp add` local-scope örneği içeriyor (global config'e dokunma)", () => {
    const text = readClaudeDoc();
    expect(text).toContain("claude mcp add");
    // -s/--scope local vurgusu: ~/.claude.json'a yalnızca çalıştırılan
    // projenin anahtarı yazılır.
    expect(text).toMatch(/-s\s+local|--scope\s+local/);
  });

  it("`claude mcp list` doğrulama ve `claude mcp remove` temizlik adımlarını içeriyor", () => {
    const text = readClaudeDoc();
    expect(text).toContain("claude mcp list");
    expect(text).toContain("claude mcp remove");
  });

  it("stdout hijyeni notu içeriyor (loglar stderr, kırmızı kural 4)", () => {
    const text = readClaudeDoc();
    expect(text).toContain("stderr");
    expect(text).toContain("stdout");
  });

  it("smoke protokolü CLAUDE_CONFIG_DIR yönlendirmesi + dürüst kalıntı notu içeriyor (denetim bulgusu 1)", () => {
    const text = readClaudeDoc();
    // Kırmızı kural 6'yı birebir sağlayan yol: kayıtlar geçici config
    // dizinine yazılır, gerçek ~/.claude.json'a hiçbir şey yazılmaz.
    expect(text).toContain("CLAUDE_CONFIG_DIR");
    // Dürüstlük: yönlendirmesiz akışta CLI'nin bırakabildiği boş proje-defteri
    // kalıntısı (mcpServers: {} girdisi) açıkça belgelenmelidir.
    expect(text).toContain("kalıntı");
  });

  it("kanıt satırı 2.1.322 doğrulamasını taşıyor (2026-11-10 yeniden koşu)", () => {
    const text = readClaudeDoc();
    expect(text).toContain("2.1.322");
    expect(text).toContain("2026-11-10");
  });

  it("negatif davranış kanıtı: geçersiz komut yolu list'te Failed to connect yüzeyiyle raporlanır", () => {
    const text = readClaudeDoc();
    // 2.1.322 canlı koşu (2026-11-10): node Z:/definitely/not/here.mjs →
    // "✘ Failed to connect — CONNECTION_CLOSED" (host, hatayı dürüst gösterir).
    expect(text).toContain("Failed to connect");
    expect(text).toContain("CONNECTION_CLOSED");
  });
});

/** F4: Codex host kılavuzu. */
describe("docs/hosts/codex.md (F4)", () => {
  it("mevcut ve stdio launch komutunu içeriyor", () => {
    const text = readCodexDoc();
    expect(text).toContain("packages/mcp-server/dist/mcp-server.mjs");
    expect(text).toContain("node");
  });

  it("config.toml [mcp_servers.causoryn] blok örneği içeriyor", () => {
    const text = readCodexDoc();
    expect(text).toContain("[mcp_servers.causoryn]");
    expect(text).toContain("command");
    expect(text).toContain("args");
  });

  it("`codex mcp add` / `list` / `remove` yaşam döngüsü örneği içeriyor", () => {
    const text = readCodexDoc();
    expect(text).toContain("codex mcp add");
    expect(text).toContain("codex mcp list");
    expect(text).toContain("codex mcp remove");
    // Smoke disiplini: belirgin -smoke adı ile add→list→remove (config temiz kalır).
    expect(text).toContain("causoryn-smoke");
  });

  it("stdout hijyeni notu içeriyor (loglar stderr, kırmızı kural 4)", () => {
    const text = readCodexDoc();
    expect(text).toContain("stderr");
    expect(text).toContain("stdout");
  });

  it("CAUSORYN_CONFIG env ilkesini belgeliyor (TŞ §20)", () => {
    const text = readCodexDoc();
    expect(text).toContain("CAUSORYN_CONFIG");
  });

  it("config.toml yeniden serileştirme uyarısı + yedek önerisi içeriyor (2026-11-10 canlı bulgu)", () => {
    const text = readCodexDoc();
    // 0.163.0 canlı koşu: add/remove TOML'u yeniden yazdı — komşu blokun
    // env sırası ve sayı biçimi değişti (byte-değişmezlik YOK). Kırmızı
    // kural 6 disiplini: smoke öncesi yedek, sonrası hash doğrulaması.
    expect(text).toContain("yeniden serileştirir");
    expect(text).toContain("yedek");
  });

  it("negatif davranış farkı belgeli: codex mcp list health-check yapmaz (claude'un aksine)", () => {
    const text = readCodexDoc();
    // 0.163.0 canlı koşu: geçersiz yol (node Z:/definitely/not/here.mjs)
    // list'te enabled görünür — spawn doğrulaması YOK; dürüst sınırlar.
    expect(text).toContain("health-check yapmaz");
  });
});

/**
 * NEGATİF yüzey (denetim bulgusu 2 / TŞ §23 DoD (3) negatif ayağı): host
 * dokümanları yanlış veya tehlikeli iddia TAŞIMAMALIDIR.
 */
describe("NEGATİF: host dokümanları yanlış/tehlikeli iddia taşımaz", () => {
  // Kök-düzey workspace yetkilendirmesi deseni: allowRoots ["/"], ["C:/"],
  // ["D:\\"] vb. — hiçbir kökün bütününe yetki verilmesini tarif etmemeli
  // (TŞ §9/§25 en-dar-kapsam ilkesi; meşru alt-dizin örneği eşleşmez).
  const ROOT_GRANT =
    /allowRoots["']?\s*:\s*\[\s*["']?(\/|[A-Za-z]:[\/\\]?)["']?\s*\]/;
  // Sır deseni: API anahtarı / token benzeri literal hiçbir örnekte yer almaz.
  const SECRET =
    /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._-]{20,})/;
  // Yanlış paketleme iddiası: F1 "tek dosya" DEĞİLDİR (esbuild native .node
  // gömemez — ADR-010). Affirmatif "tek dosya dağıtım" iddiası geçemez;
  // dokümanlardaki '"tek dosya" değil' inkârı bilinçli olarak EŞLEŞMEZ.
  const SINGLE_FILE_CLAIM =
    /(tek[- ]dosya dağıt|single[- ]file (distribution|bundle))/i;

  it("claude-code.md: kök allowRoots yetkisi, sır ve 'tek dosya' dağıtım iddiası YOK", () => {
    const text = readClaudeDoc();
    expect(text).not.toMatch(ROOT_GRANT);
    expect(text).not.toMatch(SECRET);
    expect(text).not.toMatch(SINGLE_FILE_CLAIM);
  });

  it("codex.md: kök allowRoots yetkisi, sır ve 'tek dosya' dağıtım iddiası YOK", () => {
    const text = readCodexDoc();
    expect(text).not.toMatch(ROOT_GRANT);
    expect(text).not.toMatch(SECRET);
    expect(text).not.toMatch(SINGLE_FILE_CLAIM);
  });
});
