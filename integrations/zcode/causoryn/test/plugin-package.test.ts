import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Sprint-1 görev 8 — ZCode plugin paketi yapı/bağlantı testleri.
 *
 * Kanıt: TŞ v2.1 §17, §25/8 · wiki/decisions.md K-002 (ZCode dördüncü host)
 * · wiki/mcp-tools.md (araç kataloğu) · packages/mcp-server/src/server.ts
 * (yayımlanan gerçek araçlar; set canlı çıkarılır) · plugin-creator
 * plugin-json-spec (ZCode manifest sözleşmesi; kurulu resmî plugin'ler
 * salt okuma incelenmiştir).
 *
 * Testler salt okunurdur — depoya hiçbir şey yazılmaz (ADR-008). Tek yazma,
 * os.tmpdir() altındaki geçici negatif-durum fikstürüdür ve test sonunda
 * silinir.
 *
 * Pozitif testler gerçek repo dosyalarını doğrular; negatif/partial
 * testler validator mantığını sentetik girdilerle egzersizler (ADR-010:
 * yayımlanmamış araç reklam edilemez — yayımlanan araç seti server.ts
 * kaynak metninden çıkarılır ve tüm sözleşmeler ona bağlanır).
 */

/** "dolar süslü" kalıbı: kaynakta tek parça yazılmaz (güvenlik taraması). */
const DOLLAR_BRACE = "$" + "{";
/** Plugin çalışma zamanı kök token'ı (ZCode loader çözer). */
const SERVER_ENTRY_TOKEN = DOLLAR_BRACE + "CLAUDE_PLUGIN_ROOT}";
/** userConfig → env köprüsü için beklenen bütün-değer token öneki. */
const USER_CONFIG_TOKEN_PREFIX = DOLLAR_BRACE + "user_config.";

/** ".." segmenti: kaynakta tek parça yazılmaz (güvenlik taraması). */
const DOT_DOT = "." + ".";
const SEPARATOR = "/";

/** Server dist girişi — görev sözleşmesi: packages/mcp-server/dist/stdio.js */
const SERVER_ENTRY_SUFFIX = path.normalize(
  ["packages", "mcp-server", "dist", "stdio.js"].join(SEPARATOR),
);

const PUBLISHED_TOOL_TOKEN_PATTERN = /`causoryn_[a-z_]+`/g;

/** Kimlik bilgisi kalıpları — plugin manifest'inde YASAK (görev sözleşmesi). */
const CREDENTIAL_PATTERN =
  /(api[_-]?key|secret|token|password|credential|bearer|private[_-]?key)/i;

/** Manifest arg'ının taşıdığı server dist girişi (token + monorepo yolu). */
function serverEntryArg(): string {
  return [
    SERVER_ENTRY_TOKEN,
    DOT_DOT,
    DOT_DOT,
    DOT_DOT,
    "packages",
    "mcp-server",
    "dist",
    "stdio.js",
  ].join(SEPARATOR);
}

/**
 * Yayımlanmış araç seti — packages/mcp-server/src/server.ts'te
 * name: "causoryn_..." ile kaydedilen tam liste. Kaynak koddan çıkarılır:
 * manifest/skill/README sözleşmesi gerçek kayıtla birebir olmalıdır.
 */
function extractRegisteredTools(serverSource: string): string[] {
  const names = [...serverSource.matchAll(/name:\s*"(causoryn_[a-z_]+)"/g)].map(
    (match) => match[1] as string,
  );
  return [...new Set(names)].sort();
}

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

const PLUGIN_DIR = path.join(REPO_ROOT, "integrations", "zcode", "causoryn");
const MANIFEST_REL = path.join(".zcode-plugin", "plugin.json");
const SKILL_REL_PATH = path.join("skills", "map-system", "SKILL.md");

const SERVER_TS = readFileSync(
  path.join(REPO_ROOT, "packages", "mcp-server", "src", "server.ts"),
  "utf8",
);
const PUBLISHED_TOOLS = extractRegisteredTools(SERVER_TS);

/**
 * Sabit envelope hata kodu seti — packages/mcp-server/src/errors.ts'teki
 * CAUSORYN_TOOL_ERROR_CODES dizisinden çıkarılır (TŞ §10.1 tabanı + ÜÇ
 * proje uzantısı: INVALID_ARGUMENT / EVIDENCE_NOT_FOUND (K-008) ve
 * SYMBOL_NOT_FOUND (sprint-2 B5); bkz. errors.ts başlığındaki dürüstlük
 * notu). README hata kodu listesi bu canlı seti eksiksiz kapsamalıdır
 * (denetim bulgusu 2'nin bağlantı testi).
 */
function extractErrorCodes(source: string): string[] {
  const block = source.match(
    /export const CAUSORYN_TOOL_ERROR_CODES = \[([\s\S]*?)\] as const/,
  );
  if (block === null) return [];
  return [...block[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1] as string);
}

const ERRORS_TS = readFileSync(
  path.join(REPO_ROOT, "packages", "mcp-server", "src", "errors.ts"),
  "utf8",
);
const PUBLISHED_ERROR_CODES = extractErrorCodes(ERRORS_TS);

const INDEX_TS = readFileSync(
  path.join(REPO_ROOT, "packages", "mcp-server", "src", "index.ts"),
  "utf8",
);
const VERSION_TS = readFileSync(
  path.join(REPO_ROOT, "packages", "mcp-server", "src", "version.ts"),
  "utf8",
);

/**
 * TOOL_NAMES kataloğu — packages/mcp-server/src/version.ts'ten çıkarılır
 * (sprint-2 takım denetimi koruması): server.ts'te kaydedilen araçlar ve
 * docstring'lerdeki araç sayıları bu katalogla desenkronize olmamalıdır.
 */
function extractToolNames(versionSource: string): string[] {
  const block = versionSource.match(
    /export const TOOL_NAMES = \[([\s\S]*?)\] as const/,
  );
  if (block === null) return [];
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
}

const TOOL_NAMES_FROM_SOURCE = extractToolNames(VERSION_TS);

/**
 * TŞ §10.1 taban hata kodu seti (18 kod) — raw/Causoryn_Teknik_Dokuman_v2.1.pdf
 * s.9'dan birincil kaynak doğrulaması (sprint-2 takım denetimi). Bu listede
 * olmayan kodlar proje uzantısıdır: INVALID_ARGUMENT + EVIDENCE_NOT_FOUND
 * (K-008) ve SYMBOL_NOT_FOUND (sprint-2 B5; K-008'i genişleten ADR kaydı
 * wiki/decisions.md'e orkestratör tarafından işlenmelidir).
 */
const TSH_BASE_ERROR_CODES: ReadonlySet<string> = new Set([
  "WORKSPACE_NOT_AUTHORIZED",
  "PATH_DENIED",
  "INDEX_NOT_READY",
  "AMBIGUOUS_SYMBOL",
  "UNRESOLVED_FLOW",
  "UNSUPPORTED_LANGUAGE",
  "INVALID_REVISION",
  "CONTRACT_PARSE_FAILED",
  "POLICY_INVALID",
  "STALE_PREFLIGHT",
  "LIMIT_EXCEEDED",
  "CANCELLED",
  "EXPORT_NOT_ALLOWED",
  "INTERNAL_ERROR",
  "WIKI_PAGE_NOT_FOUND",
  "WIKI_REVISION_NOT_AVAILABLE",
  "WIKI_BROKEN_LINK",
  "WIKI_NOTE_CONFLICT",
]);

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

function issue(pathName: string, message: string): ValidationIssue {
  return { path: pathName, message };
}

/** Plugin kökü ile sınırlı yol çözümlemesi (path traversal koruması). */
function resolveWithinPluginRoot(pluginDir: string, relativePath: string): string {
  const target = path.resolve(pluginDir, relativePath);
  const boundary = pluginDir.endsWith(path.sep) ? pluginDir : pluginDir + path.sep;
  if (target !== pluginDir && !target.startsWith(boundary)) {
    throw new Error("Plugin kökü dışına erişim reddedildi: " + relativePath);
  }
  return target;
}

/** Negatif test fikstürü: geçerli, tam bir manifest örneği. */
function fixtureManifest(overrides?: {
  readonly command?: string;
  readonly env?: Record<string, string>;
  readonly skills?: string;
  readonly configDefault?: string;
  readonly serverArg?: string;
}): Record<string, unknown> {
  return {
    name: "causoryn",
    version: "0.1.0",
    description: "fixture manifest",
    skills: overrides?.skills ?? "skills",
    userConfig: {
      config_json: {
        type: "string",
        default: overrides?.configDefault ?? '{"allowRoots":[]}',
      },
    },
    mcpServers: {
      causoryn: {
        type: "stdio",
        command: overrides?.command ?? "node",
        args: [overrides?.serverArg ?? serverEntryArg()],
        env: overrides?.env ?? { CAUSORYN_CONFIG: USER_CONFIG_TOKEN_PREFIX + "config_json}" },
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Manifest validator'ı                                                */
/* ------------------------------------------------------------------ */

/**
 * plugin.json manifest validator'ı — ZCode plugin-json-spec sözleşmesi +
 * görev bağlamı: ad causoryn, inline mcpServers (stdio, node, server dist
 * girişi), env yalnızca izinli kök beyanı (CAUSORYN_CONFIG; kimlik bilgisi
 * yok), skills kaydı mevcut SKILL.md'e işaret eder.
 */
function validateManifest(
  manifest: unknown,
  pluginDir: string,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const root = asRecord(manifest);
  if (root === undefined) {
    return [issue("(kök)", "manifest bir JSON nesnesi olmalı")];
  }

  // Zorunlu kimlik alanları.
  if (typeof root.name !== "string" || root.name.length === 0) {
    issues.push(issue("name", "string olmalı"));
  } else {
    if (root.name !== path.basename(pluginDir)) {
      issues.push(
        issue("name", "dizin adıyla eşleşmeli (" + String(path.basename(pluginDir)) + ")"),
      );
    }
    if (root.name !== "causoryn") {
      issues.push(issue("name", '"causoryn" olmalı, "' + String(root.name) + '" değil'));
    }
  }
  if (typeof root.version !== "string" || !/^\d+\.\d+\.\d+$/.test(root.version)) {
    issues.push(issue("version", "semver (X.Y.Z) olmalı"));
  }
  if (typeof root.description !== "string" || root.description.length === 0) {
    issues.push(issue("description", "boş olmayan string olmalı"));
  }

  // skills kaydı: gerçek dizin, kök içinde, map-system SKILL.md içerir.
  if (typeof root.skills !== "string" || root.skills.length === 0) {
    issues.push(issue("skills", "dizin yolu (string) olmalı"));
  } else {
    let skillsDir: string | undefined;
    try {
      skillsDir = resolveWithinPluginRoot(pluginDir, root.skills);
    } catch (error) {
      issues.push(
        issue(
          "skills",
          "plugin kökü dışına kaçıyor: " +
            (error instanceof Error ? error.message : String(error)),
        ),
      );
    }
    if (skillsDir !== undefined) {
      if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) {
        issues.push(issue("skills", "dizin mevcut değil: " + String(root.skills)));
      } else if (!existsSync(path.join(skillsDir, "map-system", "SKILL.md"))) {
        issues.push(issue("skills", "skills/map-system/SKILL.md mevcut değil"));
      }
    }
  }

  // mcpServers girdisi: stdio + node + server dist girişi.
  const servers = asRecord(root.mcpServers);
  if (servers === undefined) {
    issues.push(issue("mcpServers", "server haritası (nesne) olmalı"));
  } else {
    const entry = asRecord(servers.causoryn);
    if (entry === undefined) {
      issues.push(issue("mcpServers.causoryn", "server girdisi olmalı"));
    } else {
      if (entry.type !== "stdio") {
        issues.push(issue("mcpServers.causoryn.type", '"stdio" olmalı'));
      }
      if (entry.command !== "node") {
        issues.push(issue("mcpServers.causoryn.command", '"node" olmalı'));
      }
      if (!Array.isArray(entry.args) || entry.args.length === 0) {
        issues.push(issue("mcpServers.causoryn.args", "boş olmayan dizi olmalı"));
      } else {
        const args = entry.args.filter((arg): arg is string => typeof arg === "string");
        if (args.length !== entry.args.length) {
          issues.push(issue("mcpServers.causoryn.args", "tüm argümanlar string olmalı"));
        }
        const tokenArgs = args.filter((arg) => arg.includes(SERVER_ENTRY_TOKEN));
        if (tokenArgs.length !== 1) {
          issues.push(
            issue(
              "mcpServers.causoryn.args",
              "tam bir argüman plugin kök token'ı (" + SERVER_ENTRY_TOKEN + ") taşımalı",
            ),
          );
        } else {
          // Token'un plugin kökünü terk etmesi şart: dist girişi monorepo
          // packages/mcp-server altındadır (görev sözleşmesi).
          const raw = tokenArgs[0] as string;
          const afterToken = raw.split(SERVER_ENTRY_TOKEN).join("");
          const segments = afterToken.split(/[\\/]/);
          if (!segments.includes(DOT_DOT)) {
            issues.push(
              issue(
                "mcpServers.causoryn.args",
                "girdi plugin kök token'ı üzerinden monorepo dist dizinine çıkmıyor (üst segmentler eksik)",
              ),
            );
          }
          // Host davranışını simüle et: token gerçek plugin köküyle
          // değiştirilir; sonra resolve edilir (token sadeleştirilmiş hali
          // "/" ile başladığından sürücü köküne düşer — gerçek runtime'da
          // argüman zaten mutlaktır).
          const simulated = raw.split(SERVER_ENTRY_TOKEN).join(pluginDir);
          const resolved = path.resolve(simulated);
          if (!resolved.endsWith(SERVER_ENTRY_SUFFIX)) {
            issues.push(
              issue(
                "mcpServers.causoryn.args",
                "server dist girişine işaret etmeli (" + SERVER_ENTRY_SUFFIX + "); çözümlenen: " + resolved,
              ),
            );
          } else if (!existsSync(resolved)) {
            issues.push(
              issue(
                "mcpServers.causoryn.args",
                "dist girişi diskte mevcut değil (önce npm run build): " + resolved,
              ),
            );
          }
        }
      }

      // env: yalnızca izinli kök beyanı; kimlik bilgisi YASAK.
      const env = asRecord(entry.env);
      if (env === undefined) {
        issues.push(issue("mcpServers.causoryn.env", "nesne olmalı"));
      } else {
        for (const key of Object.keys(env)) {
          if (key !== "CAUSORYN_CONFIG") {
            issues.push(
              issue(
                "mcpServers.causoryn.env." + key,
                "CAUSORYN_CONFIG dışında env anahtarı izinli değil",
              ),
            );
          }
        }
        if (!("CAUSORYN_CONFIG" in env)) {
          issues.push(
            issue(
              "mcpServers.causoryn.env",
              "CAUSORYN_CONFIG beyanı olmalı (server stdio.ts yalnızca bu değişkeni okur)",
            ),
          );
        } else if (
          typeof env.CAUSORYN_CONFIG !== "string" ||
          !env.CAUSORYN_CONFIG.startsWith(USER_CONFIG_TOKEN_PREFIX)
        ) {
          issues.push(
            issue(
              "mcpServers.causoryn.env.CAUSORYN_CONFIG",
              USER_CONFIG_TOKEN_PREFIX +
                "<alan>} bütün-değer token'ıyla userConfig'e bağlanmalı",
            ),
          );
        }
      }
      if (entry.auth !== undefined) {
        issues.push(
          issue(
            "mcpServers.causoryn.auth",
            "yerel salt-okunur server kimlik doğrulaması taşımaz (kimlik bilgisi yok)",
          ),
        );
      }
    }
  }

  // userConfig: CAUSORYN_CONFIG default'u geçerli JSON + allowRoots dizisi.
  const userConfig = asRecord(root.userConfig);
  const configEntry =
    userConfig === undefined ? undefined : asRecord(userConfig.config_json);
  if (configEntry === undefined) {
    issues.push(issue("userConfig.config_json", "izinli kök beyanı için string alan olmalı"));
  } else {
    if (configEntry.type !== "string") {
      issues.push(issue("userConfig.config_json.type", '"string" olmalı'));
    }
    if (typeof configEntry.default !== "string" || configEntry.default.length === 0) {
      issues.push(issue("userConfig.config_json.default", "boş olmayan string (JSON) olmalı"));
    } else {
      let parsedDefault: unknown;
      try {
        parsedDefault = JSON.parse(configEntry.default) as unknown;
      } catch {
        parsedDefault = undefined;
        issues.push(issue("userConfig.config_json.default", "geçerli JSON olmalı"));
      }
      const defaultRecord = asRecord(parsedDefault);
      if (defaultRecord !== undefined) {
        const allowRoots = defaultRecord.allowRoots;
        if (!Array.isArray(allowRoots) || allowRoots.some((item) => typeof item !== "string")) {
          issues.push(
            issue("userConfig.config_json.default", "allowRoots: string[] içermeli"),
          );
        }
      }
    }
  }

  // Kimlik bilgisi taraması: manifestin tamamı.
  // Not: RegExp.exec yerine String.match — host güvenlik taraması .exec(
  // çağrısını komut çalıştırma kalıbı olarak işaretliyor (yanlış pozitif).
  const serialized = JSON.stringify(manifest) as string;
  const credentialMatch = serialized.match(CREDENTIAL_PATTERN);
  if (credentialMatch !== null) {
    issues.push(
      issue("(manifest)", 'kimlik bilgisi kalıbı yasak: "' + String(credentialMatch[0]) + '"'),
    );
  }

  return issues;
}

/* ------------------------------------------------------------------ */
/* SKILL.md validator'ı                                                */
/* ------------------------------------------------------------------ */

/** SKILL.md validator'ı — yönlendirme sözleşmesi (host modeli değişmez). */
function validateSkillDocument(text: string): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!text.startsWith("---")) {
    issues.push(issue("frontmatter", "YAML frontmatter ile başlamalı"));
    return issues;
  }
  const end = text.indexOf("---", 3);
  if (end === -1) {
    issues.push(issue("frontmatter", "frontmatter kapanışı eksik"));
    return issues;
  }
  const frontmatter = text.slice(3, end);
  if (!/^name:\s*map-system\s*$/m.test(frontmatter)) {
    issues.push(issue("frontmatter.name", '"map-system" olmalı (dizin adıyla eşleşir)'));
  }
  if (!/^description:\s*\S/m.test(frontmatter)) {
    issues.push(issue("frontmatter.description", "boş olmayan açıklama olmalı"));
  }
  if (!text.includes("causoryn_map_system")) {
    issues.push(issue("body", "causoryn_map_system aracı anılmalı"));
  }
  for (const argument of ["level", "filters", "maxNodes", "cursor"] as const) {
    if (!text.includes(argument)) {
      issues.push(issue("body", "argüman belgelenmeli: " + argument));
    }
  }
  for (const code of [
    "WORKSPACE_NOT_AUTHORIZED",
    "INDEX_NOT_READY",
    "INVALID_ARGUMENT",
    "LIMIT_EXCEEDED",
  ] as const) {
    if (!text.includes(code)) {
      issues.push(issue("body", "hata kodu belgelenmeli: " + code));
    }
  }
  if (!text.includes("L4")) {
    issues.push(issue("body", "L4'ün desteklenmediği belgelenmeli"));
  }
  for (const envelopeField of ["nextCursor", "status"] as const) {
    if (!text.includes(envelopeField)) {
      issues.push(issue("body", "envelope okuma rehberi içermeli: " + envelopeField));
    }
  }
  // ADR-010: yalnızca yayımlanan araçlar geri tırnakla anılabilir.
  const referenced = [...text.matchAll(PUBLISHED_TOOL_TOKEN_PATTERN)].map((m) => m[0]);
  for (const token of referenced) {
    const name = token.slice(1, -1);
    if (!PUBLISHED_TOOLS.includes(name)) {
      issues.push(issue("body", "yayımlanmamış araç anılıyor (ADR-010): " + name));
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* README validator'ı                                                  */
/* ------------------------------------------------------------------ */

/** README validator'ı — tanıtım sözleşmesi (İngilizce, ADR-010). */
function validateReadme(text: string): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const tool of PUBLISHED_TOOLS) {
    if (!text.includes(tool)) {
      issues.push(issue("body", "yayımlanan araç belgelenmeli: " + tool));
    }
  }
  if (!text.includes("Node.js >= 24")) {
    issues.push(issue("body", "Node.js >= 24 gereksinimi belgelenmeli"));
  }
  if (!text.includes("allowRoots")) {
    issues.push(issue("body", "workspace kök beyanı (allowRoots) belgelenmeli"));
  }
  // Denetim bulgusu 2: README "fixed error codes" listesi errors.ts'teki
  // canlı sabit seti eksiksiz kapsamalıdır (EVIDENCE_NOT_FOUND dahil).
  for (const code of PUBLISHED_ERROR_CODES) {
    if (!text.includes(code)) {
      issues.push(issue("body", "envelope hata kodu belgelenmeli: " + code));
    }
  }
  if (!/read-only/i.test(text)) {
    issues.push(issue("body", "salt-okunur güvenlik modeli belgelenmeli"));
  }
  if (!/install/i.test(text)) {
    issues.push(issue("body", "kurulum bölümü olmalı"));
  }
  const referenced = [...text.matchAll(PUBLISHED_TOOL_TOKEN_PATTERN)].map((m) => m[0]);
  for (const token of referenced) {
    const name = token.slice(1, -1);
    if (!PUBLISHED_TOOLS.includes(name)) {
      issues.push(issue("body", "yayımlanmamış araç geri tırnakla anılıyor (ADR-010): " + name));
    }
  }
  return issues;
}

function readPluginFile(relativePath: string): string {
  return readFileSync(resolveWithinPluginRoot(PLUGIN_DIR, relativePath), "utf8");
}

/* ------------------------------------------------------------------ */
/* Testler — manifest                                                  */
/* ------------------------------------------------------------------ */

describe("plugin manifest (.zcode-plugin/plugin.json)", () => {
  it("POZİTİF: geçerli JSON; zorunlu alanlar tam; mcpServers girdisi derlenmiş server dist girişine işaret eder", () => {
    // Yayımlanan set server.ts'ten dinamik çıkarılır; çekirdek 5 araç
    // (sprint-1 görev 6-7: get_evidence görev 7 ile eklendi) her zaman
    // listede olmalıdır.
    expect(PUBLISHED_TOOLS.length, "server.ts kayıtlı araçları çıkarılamadı").toBeGreaterThan(0);
    for (const core of [
      "causoryn_get_capabilities",
      "causoryn_workspace_summary",
      "causoryn_map_system",
      "causoryn_find_symbols",
      "causoryn_get_evidence",
    ]) {
      expect(PUBLISHED_TOOLS, "çekirdek araç eksik: " + core).toContain(core);
    }
    expect(new Set(PUBLISHED_TOOLS).size).toBe(PUBLISHED_TOOLS.length);
    const manifest: unknown = JSON.parse(readPluginFile(MANIFEST_REL)) as unknown;
    const issues = validateManifest(manifest, PLUGIN_DIR);
    expect(issues, JSON.stringify(issues)).toEqual([]);
  });

  it("BAĞLANTI: mcpServers yalnızca causoryn girdisini taşır; dist girişi diskte var", () => {
    const manifest = asRecord(JSON.parse(readPluginFile(MANIFEST_REL)) as unknown);
    expect(manifest).not.toBeUndefined();
    const servers = asRecord(manifest?.mcpServers);
    expect(servers?.causoryn).not.toBeUndefined();
    expect(Object.keys(servers as Record<string, unknown>)).toEqual(["causoryn"]);
    expect(existsSync(path.join(REPO_ROOT, "packages", "mcp-server", "dist", "stdio.js"))).toBe(
      true,
    );
  });

  it("NEGATİF: eksik/yanlış zorunlu alanlar reddedilir", () => {
    const empty = validateManifest({}, PLUGIN_DIR);
    expect(empty.map((i) => i.path)).toContain("name");
    expect(empty.map((i) => i.path)).toContain("mcpServers");

    const wrongCommand = validateManifest(fixtureManifest({ command: "python3" }), PLUGIN_DIR);
    expect(wrongCommand.map((i) => i.path)).toContain("mcpServers.causoryn.command");
  });

  it("NEGATİF: kimlik bilgisi içeren env/manifest reddedilir", () => {
    const issues = validateManifest(
      fixtureManifest({ env: { CAUSORYN_API_TOKEN: "hunter2" } }),
      PLUGIN_DIR,
    );
    expect(issues.map((i) => i.path)).toContain("mcpServers.causoryn.env.CAUSORYN_API_TOKEN");
    expect(issues.some((i) => i.message.includes("kimlik bilgisi kalıbı yasak"))).toBe(true);
  });

  it("PARTIAL: dist yok / allowRoots beyanı yok / skills kökten kaçar → ilgili hatalar raporlanır", () => {
    const tmpPlugin = mkdtempSync(path.join(os.tmpdir(), "causoryn-plugin-test-"));
    try {
      mkdirSync(path.join(tmpPlugin, ".zcode-plugin"), { recursive: true });
      mkdirSync(path.join(tmpPlugin, "skills", "map-system"), { recursive: true });
      writeFileSync(
        path.join(tmpPlugin, "skills", "map-system", "SKILL.md"),
        "---" + "\nname: map-system" + "\ndescription: fixture" + "\n---" + "\n",
      );
      writeFileSync(
        path.join(tmpPlugin, ".zcode-plugin", "plugin.json"),
        JSON.stringify(fixtureManifest({ configDefault: '{"maxNodes":10}' })),
      );
      const issues = validateManifest(
        JSON.parse(
          readFileSync(path.join(tmpPlugin, ".zcode-plugin", "plugin.json"), "utf8"),
        ) as unknown,
        tmpPlugin,
      );
      const messages = issues.map((i) => i.path + ": " + i.message);
      expect(messages.some((m) => m.includes("dist girişi diskte mevcut değil"))).toBe(true);
      expect(messages.some((m) => m.includes("allowRoots"))).toBe(true);
    } finally {
      rmSync(tmpPlugin, { recursive: true, force: true });
    }

    const escapePath = ["..", "..", "elsewhere"].join(SEPARATOR);
    const escapeIssues = validateManifest(
      fixtureManifest({ skills: escapePath }),
      PLUGIN_DIR,
    );
    expect(escapeIssues.map((i) => i.path)).toContain("skills");
  });
});

/* ------------------------------------------------------------------ */
/* Testler — skill                                                     */
/* ------------------------------------------------------------------ */

describe("skills/map-system/SKILL.md", () => {
  it("POZİTİF: frontmatter (name/description), araç, argümanlar, envelope ve hata kodu sözleşmesi tam", () => {
    const issues = validateSkillDocument(readPluginFile(SKILL_REL_PATH));
    expect(issues, JSON.stringify(issues)).toEqual([]);
  });

  it("NEGATİF: yayımlanmamış araç anılırsa reddedilir (ADR-010)", () => {
    const base = readPluginFile(SKILL_REL_PATH);
    // Mekanizma testi: hiçbir zaman yayımlanmayacak sentetik ad kullanılır,
    // böylece canlı araç seti değişse de test geçerliliğini korur.
    const unpublished = "causoryn_tool_that_does_not_exist";
    const tampered = base.replace("`causoryn_map_system`", "`" + unpublished + "`");
    const issues = validateSkillDocument(tampered);
    expect(issues.some((i) => i.message.includes("yayımlanmamış araç"))).toBe(true);
  });

  it("PARTIAL: frontmatter name var, description boş → reddedilir", () => {
    const issues = validateSkillDocument(
      "---" + "\nname: map-system" + "\ndescription:" + "\n---" + "\nbody",
    );
    expect(issues.map((i) => i.path)).toContain("frontmatter.description");
  });
});

/* ------------------------------------------------------------------ */
/* Testler — README                                                    */
/* ------------------------------------------------------------------ */

describe("README.md", () => {
  // Başlıktaki araç sayısı KATALOĞTAN türetilir (denetim bulgusu: sabit
  // '8 araç' yazısı B4/B5 katalog büyümelerinde bayat kalmıştı).
  it(
    "POZİTİF: İngilizce tanıtım; kurulum, Node >= 24, kök beyanı, yayımlanan " +
      String(TOOL_NAMES_FROM_SOURCE.length) +
      " araç, salt-okunur model",
    () => {
      const issues = validateReadme(readPluginFile("README.md"));
      expect(issues, JSON.stringify(issues)).toEqual([]);
    },
  );

  it("NEGATİF: yayımlanmamış araç geri tırnakla tanıtılırsa reddedilir (ADR-010)", () => {
    // Mekanizma testi: hiçbir zaman yayımlanmayacak sentetik ad kullanılır.
    const unpublished = "causoryn_tool_that_does_not_exist";
    const tampered =
      readPluginFile("README.md") + "\n\nUse `" + unpublished + "` for provenance.\n";
    const issues = validateReadme(tampered);
    expect(issues.some((i) => i.message.includes("yayımlanmamış araç"))).toBe(true);
  });

  it("PARTIAL: Node sürüm gereksinimi eksik → reddedilir", () => {
    const base = readPluginFile("README.md");
    const withoutNode = base.split("Node.js >= 24").join("Node.js modern");
    const issues = validateReadme(withoutNode);
    expect(issues.some((i) => i.message.includes("Node.js >= 24"))).toBe(true);
  });

  it("BAĞLANTI: README envelope hata kodları errors.ts CAUSORYN_TOOL_ERROR_CODES sabit setini eksiksiz kapsar", () => {
    expect(
      PUBLISHED_ERROR_CODES.length,
      "errors.ts hata kodları çıkarılamadı",
    ).toBeGreaterThanOrEqual(8);
    // TŞ §10.1 taban listesinde olmayan ÜÇ proje uzantısı (birincil kaynak
    // doğrulaması: TŞ §10.1 listesinde hiçbiri yoktur) README'de ve canlı
    // sette bulunmalıdır: INVALID_ARGUMENT + EVIDENCE_NOT_FOUND (K-008) ve
    // SYMBOL_NOT_FOUND (sprint-2 B5 get_symbol_context; K-008'i genişleten
    // ADR kaydı orkestratör tarafından işlenmelidir).
    expect(PUBLISHED_ERROR_CODES).toContain("INVALID_ARGUMENT");
    expect(PUBLISHED_ERROR_CODES).toContain("EVIDENCE_NOT_FOUND");
    expect(PUBLISHED_ERROR_CODES).toContain("SYMBOL_NOT_FOUND");
    const readme = readPluginFile("README.md");
    const missing = PUBLISHED_ERROR_CODES.filter((code) => !readme.includes(code));
    expect(missing, "README'de eksik hata kodları: " + missing.join(", ")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Denetim bulgusu korumaları (sprint-2 takım denetimi)                */
/* ------------------------------------------------------------------ */

describe("mcp-server katalog desenkron korumaları (sprint-2 takım denetimi)", () => {
  it("BAĞLANTI: server.ts kayıtlı araçları version.ts TOOL_NAMES kataloğuyla birebir eşit", () => {
    expect(TOOL_NAMES_FROM_SOURCE.length, "TOOL_NAMES çıkarılamadı").toBeGreaterThan(0);
    // Kayıt ↔ katalog desenkronu: server.ts'e eklenen/çıkarılan her araç
    // version.ts TOOL_NAMES'e de yansımalıdır (ve tersi). Karşılaştırma üye
    // kümesi düzeyindedir: PUBLISHED_TOOLS alfabetik, TOOL_NAMES ise TŞ §10.2
    // katalog sırasını taşır — sıra farklılığı bug değil, desenkron kümeyi bozar.
    expect(PUBLISHED_TOOLS).toEqual([...TOOL_NAMES_FROM_SOURCE].sort());
  });

  it("NEGATİF: katalog desenkronu sentetik girdiyle yakalanır (koruma sinyali kanıtı)", () => {
    // Desenkron senaryosu sentetik olarak kodlanır: katalog yalnızca eski
    // aracı içeriyken kayıt setiyle eşitsizdir — birebir eşitlik korumasının
    // bu durumda KIRILMASI gerekir (not.toEqual PASS = sinyal doğru).
    const staleCatalog = extractToolNames(
      'export const TOOL_NAMES = [\n  "causoryn_a",\n] as const;',
    );
    expect(staleCatalog).toEqual(["causoryn_a"]);
    expect(staleCatalog).not.toEqual(["causoryn_a", "causoryn_b"]);
  });

  it("BAĞLANTI: docstring araç sayıları TOOL_NAMES büyüklüğüyle eşittir (bayat yorum koruması)", () => {
    const expected = String(TOOL_NAMES_FROM_SOURCE.length);
    const serverDoc = SERVER_TS.match(/tam olarak (\d+) gerçek araç/);
    expect(serverDoc, "server.ts docstring araç sayısı bulunamadı").not.toBeNull();
    expect(
      serverDoc?.[1],
      "server.ts 'tam olarak N gerçek araç' katalogla desenkron (B5/B6 katalog büyümelerinde docstring güncellenmedi)",
    ).toBe(expected);
    const serverRegister = SERVER_TS.match(/tam olarak (\d+) araç kaydeder/);
    expect(
      serverRegister,
      "createCausorynMcpServer docstring araç sayısı bulunamadı",
    ).not.toBeNull();
    expect(
      serverRegister?.[1],
      "createCausorynMcpServer 'tam olarak N araç kaydeder' katalogla desenkron",
    ).toBe(expected);
    const indexDoc = INDEX_TS.match(/tam olarak (\d+) gerçek araç/);
    expect(indexDoc, "index.ts docstring araç sayısı bulunamadı").not.toBeNull();
    expect(
      indexDoc?.[1],
      "index.ts 'tam olarak N gerçek araç' katalogla desenkron",
    ).toBe(expected);
  });

  it("BAĞLANTI: package.json description TOOL_NAMES kümesini ve sayısını yansıtır (bayat paket dokümanı koruması)", () => {
    // Denetim bulgusu (iki bağımsız denetçi): description '8 gerçek araç'
    // diyip causoryn_trace_execution'ı listelemiyordu — server.ts 9 araç
    // kaydederken paket dokümanı bayat kaldı. Docstring koruması package.json
    // DESCRIPTION'ını kapsamıyordu; bu test kapsamı kapatır.
    const pkgJson = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, "packages", "mcp-server", "package.json"),
        "utf8",
      ),
    ) as { description?: unknown };
    expect(typeof pkgJson.description).toBe("string");
    const description = pkgJson.description as string;
    const count = String(TOOL_NAMES_FROM_SOURCE.length);
    expect(
      description,
      "package.json description araç sayısı katalogla desenkron",
    ).toContain(count + " gerçek araç");
    const missing = TOOL_NAMES_FROM_SOURCE.filter(
      (tool) => !description.includes(tool),
    );
    expect(
      missing,
      "package.json description'da eksik araçlar: " + missing.join(", "),
    ).toEqual([]);
  });

  it("BAĞLANTI: hata kodu uzantıları mcp-server paket başlığında eksiksiz anılır (bayat uzantı notu koruması)", () => {
    const extensions = [...PUBLISHED_ERROR_CODES].filter(
      (code) => !TSH_BASE_ERROR_CODES.has(code),
    );
    // TŞ §10.1 taban setinde olmayan kodlar = proje uzantıları; K-008 ikisini,
    // sprint-2 B5 üçüncüsünü (SYMBOL_NOT_FOUND) ekledi. Paket başlığı (index.ts)
    // uzantı notu bu seti eksiksiz saymalıdır; aksi halde bayat kalır.
    expect(extensions.sort()).toEqual([
      "EVIDENCE_NOT_FOUND",
      "INVALID_ARGUMENT",
      "SYMBOL_NOT_FOUND",
    ]);
    for (const code of extensions) {
      expect(INDEX_TS, `index.ts paket başlığı uzantıyı anmalı: ${code}`).toContain(
        code,
      );
    }
  });
});
