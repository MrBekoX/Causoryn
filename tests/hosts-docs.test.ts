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
  antigravityDoc: fileURLToPath(
    new URL("../docs/hosts/antigravity.md", import.meta.url),
  ),
  zcodeDoc: fileURLToPath(
    new URL("../docs/hosts/zcode.md", import.meta.url),
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

function readAntigravityDoc(): string {
  expect(
    existsSync(DOCS.antigravityDoc),
    "docs/hosts/antigravity.md mevcut olmalı",
  ).toBe(true);
  return readFileSync(DOCS.antigravityDoc, "utf8");
}

/** Yeni bağımlılıksız senkron bekleme (denemeler arası; pencere kapanması). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** readConsistentManifestPair'a verilen okuma çifti. */
interface ManifestPairRead {
  /** Manifest'te beyanlı mcp-server.mjs sha256'sı (yarım okumada undefined). */
  readonly recorded: string | undefined;
  /** Diskteki mcp-server.mjs'in gerçekte hesaplanan sha256'sı. */
  readonly actual: string;
  /** Tutarlılık kanıtlandıysa prebuild beyanı için tüm manifest girdileri. */
  readonly manifestFiles: Record<string, string>;
}

/**
 * Manifest↔bundle çift-okuması için torn-read guard'ı (denetim bulgusu:
 * teorik flaky yüzeyi). Vitest paralel koşumda bundle.test.ts beforeAll'ı
 * dist'i YERİNDE yeniden yazabilir (rmSync + parça parça yazım penceresi —
 * cloneBundleTo docstring'inde belgelenen aynı yarış sınıfı); bu testin
 * canlı okuması yarım manifest (JSON SyntaxError) veya yarım bundle (hash
 * uyuşmazlığı) görebilir. Okuma çifti tutarlı gelene kadar kısa senkron
 * beklemelerle yeniden denenir; denemeler tükenirse son hata fırlatılır.
 * readPair enjekte edilebilir: dosyanın sonundaki sentetik testler
 * yakınsamayı, okuma-hatası yeniden denemesini ve tükenmeyi kanıtlar.
 */
export function readConsistentManifestPair(
  readPair: () => ManifestPairRead,
  options: { readonly attempts?: number; readonly sleep?: (ms: number) => void } = {},
): ManifestPairRead & { readonly recorded: string } {
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? sleepSync;
  let lastError: unknown = undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const pair = readPair();
      if (typeof pair.recorded === "string" && pair.recorded === pair.actual) {
        return { recorded: pair.recorded, actual: pair.actual, manifestFiles: pair.manifestFiles };
      }
      lastError = new Error(
        `manifest↔bundle sha256 uyuşmazlığı (koşut rebuild penceresi): manifest=${String(pair.recorded)} dosya=${pair.actual}`,
      );
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) sleep(1_500);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
    "manifest sha256 == gerçek dosya sha256 (determinizm partial doğrulaması; torn-read guard'lı)",
    () => {
      // Koşut rebuild penceresine karşı guard (denetim bulgusu): vitest
      // paralel koşumda bundle.test.ts beforeAll'ı dist'i yeniden yazabilir;
      // yarım manifest (JSON SyntaxError) veya yarım bundle (hash
      // uyuşmazlığı) okuması yeniden denenir — cloneBundleTo disipliniyle
      // aynı yarış sınıfı; sentetik yakınsama testleri dosyanın sonunda.
      const { recorded, actual, manifestFiles } = readConsistentManifestPair(() => {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          files: Record<string, string>;
        };
        return {
          recorded: manifest.files["mcp-server.mjs"],
          actual: createHash("sha256")
            .update(readFileSync(DOCS.bundleEntry))
            .digest("hex"),
          manifestFiles: manifest.files,
        };
      });
      expect(recorded).toMatch(/^[0-9a-f]{64}$/);
      expect(recorded).toBe(actual);
      // External native binding manifest'te beyanlı (esbuild .node gömemez — ADR-010):
      expect(
        Object.keys(manifestFiles).some((k) =>
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

  it("claude-code.md: kök allowRoots yetkisi, sır, 'tek dosya' dağıtım iddiası ve kişisel/yerel makine yolu YOK", () => {
    const text = readClaudeDoc();
    expect(text).not.toMatch(ROOT_GRANT);
    expect(text).not.toMatch(SECRET);
    expect(text).not.toMatch(SINGLE_FILE_CLAIM);
    expect(text).not.toMatch(/D:[\\/]Causoryn/i);
    expect(text).not.toMatch(/D:[\\/]tools/i);
    expect(text).not.toContain("ber" + "ka");
  });

  it("codex.md: kök allowRoots yetkisi, sır, 'tek dosya' dağıtım iddiası ve kişisel/yerel makine yolu YOK", () => {
    const text = readCodexDoc();
    expect(text).not.toMatch(ROOT_GRANT);
    expect(text).not.toMatch(SECRET);
    expect(text).not.toMatch(SINGLE_FILE_CLAIM);
    expect(text).not.toMatch(/D:[\\/]Causoryn/i);
    expect(text).not.toMatch(/D:[\\/]tools/i);
    expect(text).not.toContain("ber" + "ka");
  });

  it("antigravity.md: kişisel/yerel makine yolu YOK ve bare stdio.ts vs packaged cli-stdio.ts ayrımı açık", () => {
    const text = readAntigravityDoc();
    expect(text).not.toMatch(/D:[\\/]Causoryn/i);
    expect(text).not.toMatch(/D:[\\/]tools/i);
    expect(text).not.toContain("ber" + "ka");
    expect(text).toContain("cli-stdio.ts");
    expect(text).toContain("--allow-cwd");
    expect(text).toContain("--auto-data-dir");
    expect(text).toContain("npx causoryn@0.2.3 setup");
  });

  it("K-021/K-022: claude-code.md ve codex.md 0.2.3 setup + 2026-11-19 güncel CLI kanıtlarını (claude 2.1.328, codex 0.169.0) taşır", () => {
    const claudeText = readClaudeDoc();
    expect(claudeText).toContain("npx causoryn@0.2.3 setup");
    expect(claudeText).toContain("2.1.328");
    expect(claudeText).toContain("2026-11-19");
    expect(claudeText).toContain("plugin validate --strict");

    const codexText = readCodexDoc();
    expect(codexText).toContain("npx causoryn@0.2.3 setup");
    expect(codexText).toContain("0.169.0");
    expect(codexText).toContain("2026-11-19");
    expect(codexText).toContain("plugin marketplace add");
  });

  it("zcode.md: ZCode CLI setup (npx causoryn@0.2.3 setup --client zcode --yes), deneysel marketplace ve GUI NOT RUN dürüstlüğünü belgeler; kişisel yol/sır YOK", () => {
    expect(existsSync(DOCS.zcodeDoc), "docs/hosts/zcode.md mevcut olmalı").toBe(true);
    const zcodeText = readFileSync(DOCS.zcodeDoc, "utf8");
    expect(zcodeText).not.toMatch(ROOT_GRANT);
    expect(zcodeText).not.toMatch(SECRET);
    expect(zcodeText).not.toMatch(SINGLE_FILE_CLAIM);
    expect(zcodeText).not.toMatch(/D:[\\/]Causoryn/i);
    expect(zcodeText).not.toMatch(/D:[\\/]tools/i);
    expect(zcodeText).not.toContain("ber" + "ka");
    expect(zcodeText).toContain("npx causoryn@0.2.3 setup --client zcode --yes");
    expect(zcodeText).toContain(".zcode/cli/config.json");
    expect(zcodeText).toContain("ZCODE_PLUGIN_ROOT");
    expect(zcodeText).toContain("ZCODE_PROJECT_DIR");
    expect(zcodeText).toContain("ZCODE_PLUGIN_DATA");
    expect(zcodeText).toContain("NOT RUN");
  });
});

/**
 * Torn-read guard'ı sentetik kanıtı (denetim bulgusu: teorik flaky yüzeyi).
 * Yarış penceresi (bundle.test.ts beforeAll rmSync + parça parça yazım)
 * deterministik olarak zorlanamadığından guard'ın davranışı enjekte
 * edilmiş okuma çiftleriyle kanıtlanır: uyuşmazlık → yeniden deneme →
 * yakınsama; okuma hatası → yeniden deneme; deneme tükenmesi → explicit
 * hata (cloneBundleTo'nun manifest-doğrulamalı klon disipliniyle aynı sınıf).
 */
describe("torn-read guard'ı: koşut rebuild penceresine karşı çift-okuma yakınsaması", () => {
  it("birinci okuma yarım snapshot (uyuşmazlık), ikinci okuma tutarlı → ikinci çift döner; arada tam 1 bekleme", () => {
    const reads: ManifestPairRead[] = [
      {
        recorded: "torn-hash",
        actual: "fresh-hash",
        manifestFiles: { "mcp-server.mjs": "torn-hash" },
      },
      {
        recorded: "fresh-hash",
        actual: "fresh-hash",
        manifestFiles: { "mcp-server.mjs": "fresh-hash", "prebuilds/win32-x64.node": "native" },
      },
    ];
    const sleeps: number[] = [];
    const result = readConsistentManifestPair(
      () => reads.shift() as ManifestPairRead,
      { sleep: (ms) => sleeps.push(ms) },
    );
    expect(result.recorded).toBe("fresh-hash");
    expect(result.manifestFiles["mcp-server.mjs"]).toBe("fresh-hash");
    expect(sleeps).toEqual([1_500]);
  });

  it("yarım manifest (JSON SyntaxError) okuma hatası da yeniden deneme tetikler", () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = readConsistentManifestPair(() => {
      calls += 1;
      if (calls === 1) throw new SyntaxError("Unexpected end of JSON input");
      return { recorded: "stable", actual: "stable", manifestFiles: {} };
    }, { sleep: (ms) => sleeps.push(ms) });
    expect(result.recorded).toBe("stable");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1_500]);
  });

  it("denemeler tükenirse explicit hata fırlatır (tam attempts okuma, attempts-1 bekleme)", () => {
    let calls = 0;
    const sleeps: number[] = [];
    expect(() => {
      readConsistentManifestPair(() => {
        calls += 1;
        return { recorded: `r${String(calls)}`, actual: `a${String(calls)}`, manifestFiles: {} };
      }, { attempts: 3, sleep: (ms) => sleeps.push(ms) });
    }).toThrow(/uyuşmazlığı/);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1_500, 1_500]);
  });
});
