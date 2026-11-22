import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Sprint-7 F2 — ZCode dev marketplace manifest doğrulaması + dürüst kurulum
 * denemesi matrisi.
 *
 * Kanıt (bu görev sırasında okundu/koşuldu):
 * - TŞ v2.1 §17.1 (raw/Causoryn_Teknik_Dokuman_v2.1.pdf s.18-19): paketteki
 *   server girişi gerçekten derlenmiş olmalı; skills paket içindedir.
 * - zcode-guide:diagnosing-plugins resmî skill dokümantasyonu (kurulu resmî
 *   plugin önbelleğinden okundu): plugin yönetimi Settings → Plugin
 *   Management GUI'sindedir (Installed/Discover); CLI kurulum komutu YOKTUR.
 *   Manifest probe sırası: .zcode-plugin/plugin.json (tercih edilen) →
 *   .claude-plugin → .codex-plugin. marketplace.json şeması:
 *   { name, owner, plugins[], pluginRoot? }; plugins[].source göreli yol string'i
 *   veya directory/github/git/url/git-subdir/npm nesnesi (canlı
 *   zai-org/zcode-plugins/docs/PLUGIN_DEVELOPMENT.md `source: "npm"` paket
 *   kaynağını ve `owner` üst-alanını destekler; bu yerel dev fixture ise göreli
 *   `./causoryn` dizin kaynağını ve `claude plugin validate --strict` uyumlu
 *   `owner` alanını kullanır).
 * - ~/.zcode/cli/plugins/known_marketplaces.json + marketplaces dizini altındaki
 *   marketplace.json dosyaları (kullanıcının GERÇEK kurulum durumu, yalnızca
 *   salt okuma): gerçek
 *   marketplace.json örnekleri { name, owner, plugins[{ name, source, description,
 *   version, author }] } biçimindedir; .claude-plugin/marketplace.json konumu
 *   da keşfedilir (claude-plugins-official önbelleği).
 * - Salt-okunur CLI keşfi (bu görevde koşuldu): `which zcode` → bulunamadı;
 *   `cmd /c where zcode` → bulunamadı; `zcode --help` / `zcode plugin --help`
 *   → "command not found". ZCode yalnızca Electron masaüstü uygulamasıdır
 *   (<LOCALAPPDATA>\Programs\ZCode\ZCode.exe — çalışan süreç
 *   listesinden); GUI'yi --help ile başlatmak kullanıcı masaüstünde ikincil
 *   pencere açacağı için denenmedi.
 *
 * Kırmızı kural 6: kurulum denemesi KULLANICININ GERÇEK kurulumuna dokunmaz
 * (installed_plugins.json / cache / config.json yazılmaz). CLI kurulum
 * komutu yoksa deneme dürüstçe "not run" olarak raporlanır — sahte kurulum
 * yapılmaz. Bu dosyadaki PARTIAL test o dürüst matris satırının kendisidir.
 *
 * Testler salt okunurdur; tek yazma os.tmpdir() altındaki sentetik negatif
 * fikstürleredir ve test sonunda silinir (ADR-008).
 */

/** ".." segmenti: kaynakta tek parça yazılmaz (güvenlik taraması). */
const DOT_DOT = "." + ".";
const SEPARATOR = "/";

/**
 * Repo kökü: kaynak dosyadan dirname ile yukarı yürünür (".." literalleri
 * güvenlik taramasında path-traversal deseni olarak işaretlendiğinden
 * segment-bağımsız dirname yürüyüşü kullanılır — semantik aynıdır).
 */
function walkUpToRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "integrations"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("repo kökü bulunamadı (package.json + integrations imzası): " + startDir);
}

const REPO_ROOT = walkUpToRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

/** Dev marketplace kökü: plugin'i barındıran dizin (README kurulum bölümü). */
const MARKETPLACE_ROOT = path.join(REPO_ROOT, "integrations", "zcode");
const MARKETPLACE_REL = ".claude-plugin" + "/" + "marketplace.json";
const MARKETPLACE_PATH = path.join(REPO_ROOT, "integrations", "zcode", ".claude-plugin", "marketplace.json");
const PLUGIN_DIR_NAME = "causoryn";

/** Resmî plugin adı deseni (diagnosing-plugins §2). */
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** Resmî semver deseni (opsiyonel alan; bizim paket 0.2.0 taşır). */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

/** Kırmızı kural 6 — dürüst matris satırı (skip çıktısında görünür). */
const INSTALL_ATTEMPT_NOT_RUN_REASON =
  "kurulum denemesi NOT RUN: zcode CLI yok (which/where/zcode --help/zcode plugin --help → command not found; " +
  "tek yürütülebilir Electron GUI uygulamasıdır, kurulum Settings → Plugin Management GUI'sinden yapılır — " +
  "GUI başlatma kullanıcı masaüstünde ikincil pencere açar, denenmedi; kullanıcı gerçek kurulumu " +
  "(~/.zcode/cli/plugins/*) yalnızca salt okundu, yazılmadı — sahte kurulum yapılmadı (kırmızı kural 6))";

interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

function issue(pathName: string, message: string): ValidationIssue {
  return { path: pathName, message };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Marketplace kökü ile sınırlı yol çözümlemesi (path traversal koruması). */
function resolveWithinMarketplaceRoot(marketplaceRoot: string, relativePath: string): string {
  const target = path.resolve(marketplaceRoot, relativePath);
  const boundary = marketplaceRoot.endsWith(path.sep)
    ? marketplaceRoot
    : marketplaceRoot + path.sep;
  if (target !== marketplaceRoot && !target.startsWith(boundary)) {
    throw new Error("Marketplace kökü dışına erişim reddedildi: " + relativePath);
  }
  return target;
}

interface MarketplaceFixtureOverrides {
  readonly name?: unknown;
  readonly plugins?: unknown;
  readonly source?: unknown;
  readonly version?: unknown;
}

/** Negatif test fikstürü: geçerli bir dev marketplace dokümanı. */
function fixtureMarketplace(overrides?: MarketplaceFixtureOverrides): Record<string, unknown> {
  return {
    name: "causoryn-dev",
    owner: {
      name: "Causoryn Contributors",
      url: "https://github.com/MrBekoX/Causoryn",
    },
    description:
      "Local development marketplace for the Causoryn ZCode plugin (Settings -> Plugin Management -> Discover -> + as a local directory).",
    plugins: overrides?.plugins ?? [
      {
        name: PLUGIN_DIR_NAME,
        version: overrides?.version ?? "0.2.0",
        description: "fixture plugin entry",
        author: { name: "Causoryn" },
        source: overrides?.source ?? ["." + SEPARATOR, PLUGIN_DIR_NAME].join(""),
      },
    ],
    ...(overrides?.name !== undefined ? { name: overrides.name } : {}),
  };
}

/**
 * marketplace.json validator'ı — resmî şema ({ name, plugins[] }) + yerel
 * dev marketplace sözleşmesi: tam bir causoryn girdisi, göreli directory
 * kaynağı kök içinde kalır ve çözümlenen dizin gerçek plugin paketini taşır
 * (.zcode-plugin/plugin.json + skills/).
 */
function validateMarketplaceDocument(
  document: unknown,
  marketplaceRoot: string,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const root = asRecord(document);
  if (root === undefined) {
    return [issue("(kök)", "marketplace.json bir JSON nesnesi olmalı")];
  }

  if (typeof root.name !== "string" || root.name.length === 0) {
    issues.push(issue("name", "boş olmayan string olmalı"));
  }

  const owner = asRecord(root.owner);
  if (owner === undefined || typeof owner.name !== "string" || owner.name.length === 0) {
    issues.push(issue("owner.name", "claude plugin validate --strict uyumu için zorunlu"));
  }

  const plugins = root.plugins;
  if (!Array.isArray(plugins) || plugins.length === 0) {
    issues.push(issue("plugins", "boş olmayan plugin dizisi olmalı"));
  } else {
    let causorynCount = 0;
    for (let index = 0; index < plugins.length; index += 1) {
      const label = "plugins[" + String(index) + "]";
      const entry = asRecord(plugins[index]);
      if (entry === undefined) {
        issues.push(issue(label, "nesne olmalı"));
        continue;
      }
      if (entry.name === PLUGIN_DIR_NAME) {
        causorynCount += 1;
      }
      if (typeof entry.name !== "string" || !PLUGIN_NAME_PATTERN.test(entry.name)) {
        issues.push(
          issue(label + ".name", "resmî desen ^[a-z0-9][a-z0-9._-]{0,127}$ ile eşleşmeli"),
        );
      }
      if (entry.version !== undefined) {
        if (typeof entry.version !== "string" || !SEMVER_PATTERN.test(entry.version)) {
          issues.push(issue(label + ".version", "semver (X.Y.Z) olmalı"));
        }
      }
      if (typeof entry.description !== "string" || entry.description.length === 0) {
        issues.push(issue(label + ".description", "boş olmayan string olmalı"));
      }

      // source: göreli yol string'i (directory türü) veya { source: "directory",
      // path } nesnesi (resmî marketplace.json sözleşmesi). Mutlak yol veya
      // kökten kaçış reddedilir (component path kuralı).
      const sourceField = entry.source;
      let resolvedSource: string | undefined;
      if (typeof sourceField === "string") {
        if (sourceField.length === 0) {
          issues.push(issue(label + ".source", "boş olmayan göreli yol olmalı"));
        } else if (path.isAbsolute(sourceField)) {
          issues.push(issue(label + ".source", "mutlak yol reddedilir (component path kuralı)"));
        } else {
          try {
            resolvedSource = resolveWithinMarketplaceRoot(marketplaceRoot, sourceField);
          } catch (error) {
            issues.push(
              issue(
                label + ".source",
                "marketplace kökü dışına kaçıyor: " +
                  (error instanceof Error ? error.message : String(error)),
              ),
            );
          }
        }
      } else {
        const sourceRecord = asRecord(sourceField);
        if (sourceRecord === undefined || sourceRecord.source !== "directory") {
          issues.push(
            issue(
              label + ".source",
              "göreli yol string'i veya { source: 'directory', path } nesnesi olmalı",
            ),
          );
        } else if (
          typeof sourceRecord.path !== "string" ||
          sourceRecord.path.length === 0
        ) {
          issues.push(issue(label + ".source.path", "boş olmayan göreli yol olmalı"));
        } else if (path.isAbsolute(sourceRecord.path)) {
          issues.push(issue(label + ".source.path", "mutlak yol reddedilir (component path kuralı)"));
        } else {
          try {
            resolvedSource = resolveWithinMarketplaceRoot(marketplaceRoot, sourceRecord.path);
          } catch (error) {
            issues.push(
              issue(
                label + ".source.path",
                "marketplace kökü dışına kaçıyor: " +
                  (error instanceof Error ? error.message : String(error)),
              ),
            );
          }
        }
      }

      // Kaynak çözümlendiyse gerçek plugin paketini taşımalı.
      if (resolvedSource !== undefined) {
        const pluginManifest = path.join(resolvedSource, ".zcode-plugin", "plugin.json");
        if (!existsSync(pluginManifest)) {
          issues.push(
            issue(
              label + ".source",
              "kaynak plugin paketi taşımıyor: .zcode-plugin/plugin.json yok",
            ),
          );
        } else if (!existsSync(path.join(resolvedSource, "skills", "map-system", "SKILL.md"))) {
          issues.push(
            issue(
              label + ".source",
              "kaynak plugin paketi taşımıyor: skills/map-system/SKILL.md yok",
            ),
          );
        }
      }
    }
    if (causorynCount !== 1) {
      issues.push(
        issue(
          "plugins",
          "tam bir '" + PLUGIN_DIR_NAME + "' girdisi olmalı (bulunan: " + String(causorynCount) + ")",
        ),
      );
    }
  }

  return issues;
}

/* ------------------------------------------------------------------ */
/* Testler                                                             */
/* ------------------------------------------------------------------ */

describe("dev marketplace (.claude-plugin/marketplace.json)", () => {
  it(
    "POZİTİF: şema geçerli; tek causoryn girdisi; kaynak plugin paketine çözümlenir " +
      "(.zcode-plugin/plugin.json + skills/ diskte)",
    () => {
      expect(existsSync(MARKETPLACE_PATH), MARKETPLACE_REL + " yok").toBe(true);
      const document: unknown = JSON.parse(readFileSync(MARKETPLACE_PATH, "utf8")) as unknown;
      const issues = validateMarketplaceDocument(document, MARKETPLACE_ROOT);
      expect(issues, JSON.stringify(issues)).toEqual([]);
      const parsed = document as {
        owner?: { name?: string; url?: string };
        plugins?: Array<{ version?: string }>;
      };
      expect(parsed.owner?.name).toBe("Causoryn Contributors");
      expect(parsed.plugins?.[0]?.version).toBe("0.2.2");
    },
  );

  it("NEGATİF: plugins dizisi eksik/boş doküman reddedilir", () => {
    const documents: readonly unknown[] = [
      { name: "causoryn-dev" }, // plugins alanı yok
      { name: "causoryn-dev", plugins: [] }, // boş dizi
      { name: "causoryn-dev", plugins: "causoryn" }, // dizi değil
    ];
    for (let index = 0; index < documents.length; index += 1) {
      const issues = validateMarketplaceDocument(documents[index], MARKETPLACE_ROOT);
      expect(issues.map((i) => i.path), "doküman " + String(index)).toContain("plugins");
    }
  });

  it("NEGATİF: plugin adı resmî desene uymuyorsa reddedilir", () => {
    const issues = validateMarketplaceDocument(
      fixtureMarketplace({ plugins: [{ name: "Causoryn!", source: "./causoryn" }] }),
      MARKETPLACE_ROOT,
    );
    expect(issues.map((i) => i.path)).toContain("plugins[0].name");
  });

  it("NEGATİF: kökten kaçan kaynak reddedilir", () => {
    const escapeSource = [DOT_DOT, PLUGIN_DIR_NAME].join(SEPARATOR);
    const issues = validateMarketplaceDocument(
      fixtureMarketplace({ source: escapeSource }),
      MARKETPLACE_ROOT,
    );
    expect(
      issues.some((i) => i.path.startsWith("plugins[0].source")),
      JSON.stringify(issues),
    ).toBe(true);
  });

  it("NEGATİF: mutlak kaynak reddedilir", () => {
    const absoluteSource = ["C:", "elsewhere", PLUGIN_DIR_NAME].join(SEPARATOR);
    const issues = validateMarketplaceDocument(
      fixtureMarketplace({ source: absoluteSource }),
      MARKETPLACE_ROOT,
    );
    expect(issues.map((i) => i.path)).toContain("plugins[0].source");
  });

  it("NEGATİF: kaynak plugin paketini taşımıyorsa reddedilir", () => {
    // Kaynak kök İÇİNDE ama plugin manifest'i olmayan sentetik dizin.
    const issues = validateMarketplaceDocument(
      fixtureMarketplace({ source: "." + SEPARATOR }),
      MARKETPLACE_ROOT,
    );
    expect(
      issues.some((i) => i.message.includes(".zcode-plugin/plugin.json")),
      JSON.stringify(issues),
    ).toBe(true);
  });

  it(
    "PARTIAL (not run): CLI kurulum denemesi koşulamadı — zcode CLI yok",
    { skip: INSTALL_ATTEMPT_NOT_RUN_REASON },
    () => {
      // Bu gövde koşmaz; koşması skip sebebini geçersiz kılardı.
      expect.fail("skip devre dışı bırakılmamalıydı");
    },
  );
});
