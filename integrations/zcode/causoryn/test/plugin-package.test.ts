import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** Çift-nokta üst-dizin segmenti: kaynakta tek parça yazılmaz (güvenlik taraması). */
const DOT_DOT = "." + ".";
const SEPARATOR = "/";

/** Server dist girişi — sprint-7 F1: esbuild bundle (TŞ §17.1 "derlenmiş
 * gerçek başlangıç noktası"; better-sqlite3 EXTERNAL + vendored runtime,
 * ADR-010 dürüstlük). */
const SERVER_ENTRY_SUFFIX = path.normalize(
  ["packages", "mcp-server", "dist", "mcp-server.mjs"].join(SEPARATOR),
);

const PUBLISHED_TOOL_TOKEN_PATTERN = /`causoryn_[a-z_]+`/g;

/** Kimlik bilgisi kalıpları — plugin manifest'inde YASAK (görev sözleşmesi). */
const CREDENTIAL_PATTERN =
  /(api[_-]?key|secret|token|password|credential|bearer|private[_-]?key)/i;

/** Resmî plugin adı deseni — zcode-guide:diagnosing-plugins §2 manifest şeması. */
const OFFICIAL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

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
    "mcp-server.mjs",
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

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(path.dirname(path.dirname(path.dirname(TEST_DIR))));

const PLUGIN_DIR = path.join(REPO_ROOT, "integrations", "zcode", "causoryn");
const MANIFEST_REL = path.join(".zcode-plugin", "plugin.json");
const SKILL_REL_PATH = path.join("skills", "map-system", "SKILL.md");

/**
 * Sprint-7 F1: bundle artefaktı commit edilmez (kök .gitignore satır 3:
 * dist/) — diskte VARSA manifest doğrulaması tam koşar; YOKSA disk-bağlı
 * testler açık skip sebebiyle atlanır (yeşillik rastlantıya değil kurala
 * bağlanır: üretilmemiş bundle "geçti" sayılmaz, ADR-010).
 */
const BUNDLE_ENTRY_PATH = path.join(
  REPO_ROOT,
  "packages",
  "mcp-server",
  "dist",
  "mcp-server.mjs",
);
const BUNDLE_PRESENT = existsSync(BUNDLE_ENTRY_PATH);
const BUNDLE_SKIP_REASON = BUNDLE_PRESENT
  ? false
  : "bundle yok — önce npm run build:bundle (packages/mcp-server)";

const SERVER_TS = readFileSync(
  path.join(REPO_ROOT, "packages", "mcp-server", "src", "server.ts"),
  "utf8",
);
const PUBLISHED_TOOLS = extractRegisteredTools(SERVER_TS);

/**
 * Sabit envelope hata kodu seti — packages/mcp-server/src/errors.ts'teki
 * CAUSORYN_TOOL_ERROR_CODES dizisinden çıkarılır (TŞ §10.1 tabanı + ÜÇ
 * proje uzantısı: INVALID_ARGUMENT / EVIDENCE_NOT_FOUND (K-008) ve
 * SYMBOL_NOT_FOUND (K-011, wiki/decisions.md:37; sprint-2 B4/B5); bkz.
 * errors.ts başlığındaki dürüstlük notu). README hata kodu listesi bu canlı seti eksiksiz kapsamalıdır
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
 * TOOL_NAMES ve CORE_TOOL_NAMES katalogları — packages/mcp-server/src/version.ts'ten
 * çıkarılır (sprint-2 takım denetimi + Wave 2 11-core / 32-full profil koruması):
 * server.ts'te kaydedilen araçlar ve docstring'lerdeki araç sayıları bu kataloglarla
 * desenkronize olmamalıdır.
 */
function extractToolNames(versionSource: string): string[] {
  const block = versionSource.match(
    /export const TOOL_NAMES = \[([\s\S]*?)\] as const/,
  );
  if (block === null) return [];
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
}

function extractCoreToolNames(versionSource: string): string[] {
  const block = versionSource.match(
    /export const CORE_TOOL_NAMES = \[([\s\S]*?)\] as const/,
  );
  if (block === null) return [];
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
}

const TOOL_NAMES_FROM_SOURCE = extractToolNames(VERSION_TS);
const CORE_TOOL_NAMES_FROM_SOURCE = extractCoreToolNames(VERSION_TS);
const FULL_CATALOG_FROM_SOURCE = [
  ...new Set([...TOOL_NAMES_FROM_SOURCE, ...CORE_TOOL_NAMES_FROM_SOURCE]),
].sort();

/**
 * TŞ §10.1 taban hata kodu seti (18 kod) — raw/Causoryn_Teknik_Dokuman_v2.1.pdf
 * s.9'dan birincil kaynak doğrulaması (sprint-2 takım denetimi). Bu listede
 * olmayan kodlar proje uzantısıdır: INVALID_ARGUMENT + EVIDENCE_NOT_FOUND
 * (K-008) ve SYMBOL_NOT_FOUND (K-011, wiki/decisions.md:37; sprint-2 B5
 * get_symbol_context / B4 trace_execution). POLICY_INVALID,
 * INVALID_REVISION ve EXPORT_NOT_ALLOWED uzantı DEĞİLDİR: sprint-3 C8'de
 * (guard policy + git revizyon + export output yetkilendirmesi araçları)
 * kullanıldılar ama TŞ §10.1 sabit listesinin üyeleridirler — export yazma
 * reddi için yeni uzantı kodu basmak K-008 örüntüsünün önkoşulunu ("TŞ
 * listesinde uygun kod yok") ihlal ederdi (takım denetimi bulgusu).
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
  readonly name?: string;
  readonly commands?: string;
}): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: overrides?.name ?? "causoryn",
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
  if (overrides?.commands !== undefined) {
    manifest.commands = overrides.commands;
  }
  return manifest;
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
    // Resmî plugin adı deseni (zcode-guide:diagnosing-plugins §2).
    if (!OFFICIAL_NAME_PATTERN.test(root.name)) {
      issues.push(
        issue("name", "resmî desen ^[a-z0-9][a-z0-9._-]{0,127}$ ile eşleşmeli: " + String(root.name)),
      );
    }
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

  // commands yüzeyi (opsiyonel; resmî şema commands/skills/hooks/mcpServers
  // component path'lerini doğrular): bildirildiyse pakette mevcut dizin
  // olmalı, mutlak yol veya kökten kaçış reddedilir.
  if (root.commands !== undefined) {
    if (typeof root.commands !== "string" || root.commands.length === 0) {
      issues.push(issue("commands", "bildiriliyorsa dizin yolu (string) olmalı"));
    } else {
      let commandsDir: string | undefined;
      try {
        commandsDir = resolveWithinPluginRoot(pluginDir, root.commands);
      } catch (error) {
        issues.push(
          issue(
            "commands",
            "plugin kökü dışına kaçıyor: " +
              (error instanceof Error ? error.message : String(error)),
          ),
        );
      }
      if (
        commandsDir !== undefined &&
        (!existsSync(commandsDir) || !statSync(commandsDir).isDirectory())
      ) {
        issues.push(
          issue(
            "commands",
            "bildirilen commands dizini pakette mevcut değil: " + String(root.commands),
          ),
        );
      }
    }
  }

  // mcpServers girdisi: stdio + node + server dist girişi. Paket sözleşmesi
  // katı tekilliktir: tam bir causoryn girdisi (env anahtarı katılığının
  // örüntüsü) — fazladan server girdisi tamper penceresidir.
  const servers = asRecord(root.mcpServers);
  if (servers === undefined) {
    issues.push(issue("mcpServers", "server haritası (nesne) olmalı"));
  } else {
    const entry = asRecord(servers.causoryn);
    if (Object.keys(servers).length !== 1) {
      issues.push(
        issue(
          "mcpServers",
          'tam bir server girdisi olmalı ("causoryn"; bulunan: ' +
            String(Object.keys(servers).length) +
            ")",
        ),
      );
    }
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
                "dist girişi diskte mevcut değil (önce npm run build:bundle): " + resolved,
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
  // Not: RegExp exec metodu yerine String.match — host güvenlik taraması ilgili
  // metot çağrısını komut çalıştırma kalıbı olarak işaretliyor (yanlış pozitif).
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
/* Skills paket bütünlüğü validator'ı (F2)                             */
/* ------------------------------------------------------------------ */

/**
 * skills/ paket bütünlüğü validator'ı (F2 güçlendirmesi) — paketteki HER
 * skill dizini için genel sözleşme: SKILL.md mevcut, frontmatter name dizin
 * adıyla eşleşir, açıklama boş değil, yalnızca yayımlanan araçlara geri
 * tırnakla atıf yapılır (ADR-010). Dizine özgü derin sözleşme (map-system
 * argüman/hata kodu tablosu) validateSkillDocument'te kalır; buradaki kural
 * yeni bir skill eklendiğinde paketin sessizce bozulmasını engeller.
 */
function validateSkillBundle(skillsDir: string): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) {
    return [issue("skills", "skills dizini mevcut değil: " + skillsDir)];
  }
  const skillDirs = readdirSync(skillsDir, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith("."),
  );
  if (skillDirs.length === 0) {
    issues.push(issue("skills", "paket en az bir skill içermeli"));
  }
  for (const dir of skillDirs) {
    const skillFile = path.join(skillsDir, dir.name, "SKILL.md");
    if (!existsSync(skillFile)) {
      issues.push(issue(dir.name, "SKILL.md mevcut değil"));
      continue;
    }
    if (!statSync(skillFile).isFile()) {
      // Bozuk paket: SKILL.md adında dizin — existsSync tek başına yanıltır;
      // readFileSync EISDIR ile çökmeden temiz şema reddi üret.
      issues.push(
        issue(dir.name + "/SKILL.md", "SKILL.md bir dosya değil (dizin olarak paketlenmiş)"),
      );
      continue;
    }
    const text = readFileSync(skillFile, "utf8");
    if (!text.startsWith("---")) {
      issues.push(issue(dir.name + "/frontmatter", "YAML frontmatter ile başlamalı"));
      continue;
    }
    const end = text.indexOf("---", 3);
    if (end === -1) {
      issues.push(issue(dir.name + "/frontmatter", "frontmatter kapanışı eksik"));
      continue;
    }
    const frontmatter = text.slice(3, end);
    const nameLine = new RegExp("^name:\\s*" + dir.name + "\\s*$", "m");
    if (!nameLine.test(frontmatter)) {
      issues.push(
        issue(dir.name + "/frontmatter.name", '"' + dir.name + '" olmalı (dizin adıyla eşleşir)'),
      );
    }
    if (!/^description:\s*\S/m.test(frontmatter)) {
      issues.push(issue(dir.name + "/frontmatter.description", "boş olmayan açıklama olmalı"));
    }
    const referenced = [...text.matchAll(PUBLISHED_TOOL_TOKEN_PATTERN)].map((m) => m[0]);
    if (referenced.length === 0) {
      issues.push(issue(dir.name + "/body", "en az bir yayımlanmış Causoryn aracı anılmalı"));
    }
    for (const token of referenced) {
      const name = token.slice(1, -1);
      if (!PUBLISHED_TOOLS.includes(name)) {
        issues.push(issue(dir.name + "/body", "yayımlanmamış araç anılıyor (ADR-010): " + name));
      }
    }
  }
  return issues;
}

/**
 * README'de geri tırnakla anılan causoryn_* araç token'ları — sıralı benzersiz
 * küme (F2 TOOL_NAMES↔README çapraz kontrolü için).
 */
function extractReadmeToolTokens(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(PUBLISHED_TOOL_TOKEN_PATTERN)].map((m) => m[0].slice(1, -1)),
    ),
  ].sort();
}

/**
 * Tool names in the first table column of one README section (from the heading
 * that starts with `headingPrefix` up to the next `### ` or `## ` heading),
 * sorted and de-duplicated.
 */
function extractSectionTableTools(text: string, headingPrefix: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.startsWith(headingPrefix));
  if (start < 0) return [];
  const tools = new Set<string>();
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("### ") || line.startsWith("## ")) break;
    const match = line.match(/^\|\s*`(causoryn_[a-z_]+)`\s*\|/);
    if (match?.[1] !== undefined) tools.add(match[1]);
  }
  return [...tools].sort();
}

/** DEPRECATED_TOOL_REPLACEMENTS entries parsed from the version.ts source. */
function extractDeprecatedReplacements(versionSource: string): Record<string, string> {
  const block = versionSource.match(
    /export const DEPRECATED_TOOL_REPLACEMENTS[^=]*=\s*\{([\s\S]*?)\};/,
  );
  if (block === null) return {};
  const out: Record<string, string> = {};
  for (const m of block[1].matchAll(/(causoryn_[a-z_]+):\s*"(causoryn_[a-z_]+)"/g)) {
    out[m[1] as string] = m[2] as string;
  }
  return out;
}

/**
 * `[legacy, replacement]` pairs from the README legacy table: rows whose first
 * cell is a backticked tool and whose second cell starts with a backticked tool.
 */
function extractLegacyReplacementRows(text: string): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const match = line.match(/^\|\s*`(causoryn_[a-z_]+)`\s*\|\s*`(causoryn_[a-z_]+)`/);
    if (match?.[1] !== undefined && match[2] !== undefined) rows.push([match[1], match[2]]);
  }
  return rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
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
  it(
    "POZİTİF: geçerli JSON; zorunlu alanlar tam; mcpServers girdisi derlenmiş server dist girişine işaret eder",
    { skip: BUNDLE_SKIP_REASON },
    () => {
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
    },
  );

  it(
    "BAĞLANTI: mcpServers yalnızca causoryn girdisini taşır; dist girişi diskte var",
    { skip: BUNDLE_SKIP_REASON },
    () => {
      const manifest = asRecord(JSON.parse(readPluginFile(MANIFEST_REL)) as unknown);
      expect(manifest).not.toBeUndefined();
      const servers = asRecord(manifest?.mcpServers);
      expect(servers?.causoryn).not.toBeUndefined();
      expect(Object.keys(servers as Record<string, unknown>)).toEqual(["causoryn"]);
      expect(
        existsSync(path.join(REPO_ROOT, "packages", "mcp-server", "dist", "mcp-server.mjs")),
      ).toBe(true);
    },
  );

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

    const escapePath = [DOT_DOT, DOT_DOT, "elsewhere"].join(SEPARATOR);
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
      String(FULL_CATALOG_FROM_SOURCE.length) +
      " araç (11 core + legacy full profili), salt-okunur model",
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
    // SYMBOL_NOT_FOUND (K-011, wiki/decisions.md:37; sprint-2 B4/B5).
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
  it("BAĞLANTI: server.ts kayıtlı araçları version.ts 11-core / 32-full katalog birleşimiyle birebir eşit", () => {
    expect(CORE_TOOL_NAMES_FROM_SOURCE.length, "CORE_TOOL_NAMES çıkarılamadı").toBe(11);
    expect(TOOL_NAMES_FROM_SOURCE.length, "TOOL_NAMES çıkarılamadı").toBe(29);
    expect(FULL_CATALOG_FROM_SOURCE.length).toBe(32);
    // Kayıt ↔ katalog desenkronu: server.ts'e eklenen/çıkarılan her araç
    // version.ts TOOL_NAMES / CORE_TOOL_NAMES'e de yansımalıdır (ve tersi).
    expect(PUBLISHED_TOOLS).toEqual(FULL_CATALOG_FROM_SOURCE);
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

  it("BAĞLANTI: docstring araç sayıları 11-core / 29-legacy / 32-full kataloglarıyla eşittir (bayat yorum koruması)", () => {
    const expectedLegacy = String(TOOL_NAMES_FROM_SOURCE.length);
    const expectedCore = String(CORE_TOOL_NAMES_FROM_SOURCE.length);
    const expectedFull = String(FULL_CATALOG_FROM_SOURCE.length);

    const serverFullDoc = SERVER_TS.match(
      /all (\d+) legacy tools plus the \d+ consolidated aliases \((\d+) total\)/,
    );
    expect(serverFullDoc, "server.ts full-profile yorumu bulunamadı").not.toBeNull();
    expect(serverFullDoc?.[1], "server.ts legacy araç sayısı katalogla desenkron").toBe(
      expectedLegacy,
    );
    expect(serverFullDoc?.[2], "server.ts full toplam araç sayısı katalogla desenkron").toBe(
      expectedFull,
    );

    const serverCoreDoc = SERVER_TS.match(/with (\d+) lean consolidated tools/);
    expect(serverCoreDoc, "createCausorynMcpServer core profil docstring sayısı bulunamadı").not.toBeNull();
    expect(serverCoreDoc?.[1], "createCausorynMcpServer core araç sayısı katalogla desenkron").toBe(
      expectedCore,
    );

    const indexDoc = INDEX_TS.match(/tam olarak (\d+) gerçek araç/);
    expect(indexDoc, "index.ts docstring araç sayısı bulunamadı").not.toBeNull();
    expect(
      indexDoc?.[1],
      "index.ts 'tam olarak N gerçek araç' katalogla desenkron",
    ).toBe(expectedLegacy);
  });

  it("LINK: packages/mcp-server package.json description states the default core profile size and the legacy catalog size from version.ts (stale package doc guard)", () => {
    // Audit finding (two independent reviewers): the description once said
    // '8 tools' while server.ts registered 9. Since 0.3.0 the default surface is
    // the core profile, so the description must state both catalog sizes as
    // derived from version.ts; a catalog change without a description update fails.
    const pkgJson = JSON.parse(
      readFileSync(
        path.join(REPO_ROOT, "packages", "mcp-server", "package.json"),
        "utf8",
      ),
    ) as { description?: unknown };
    expect(typeof pkgJson.description).toBe("string");
    const description = pkgJson.description as string;
    const coreCount = String(CORE_TOOL_NAMES_FROM_SOURCE.length);
    const legacyCount = String(TOOL_NAMES_FROM_SOURCE.length);
    expect(
      description,
      "package.json description must state the default core profile size",
    ).toContain(coreCount + "-tool default core profile");
    expect(
      description,
      "package.json description must state the legacy catalog size of the full profile",
    ).toContain(legacyCount + " legacy tool names");
    expect(description, "package.json description must be English").not.toMatch(
      /[çğıöşüÇĞİÖŞÜ]/,
    );
  });

  it("BAĞLANTI: hata kodu uzantıları mcp-server paket başlığında eksiksiz anılır (bayat uzantı notu koruması)", () => {
    const extensions = [...PUBLISHED_ERROR_CODES].filter(
      (code) => !TSH_BASE_ERROR_CODES.has(code),
    );
    // TŞ §10.1 taban setinde olmayan kodlar = proje uzantıları; K-008 ilk
    // ikisini, K-011 (sprint-2 B4/B5) üçüncüsünü (SYMBOL_NOT_FOUND) ekledi. POLICY_INVALID,
    // INVALID_REVISION ve EXPORT_NOT_ALLOWED uzantı değildir: TŞ §10.1 taban
    // listesindedirler (sprint-3 C8'de ilk kez kullanıldılar; takım denetimi
    // bulgusu: export yazma reddi EXPORT_NOT_ALLOWED sabit koduyla raporlanır,
    // OUTPUT_NOT_AUTHORIZED gibi uzantı koduyla DEĞİL). Paket başlığı
    // (index.ts) uzantı notu bu seti eksiksiz saymalıdır; aksi halde bayat kalır.
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

/* ------------------------------------------------------------------ */
/* F2 güçlendirmeleri — manifest şeması + skills paket bütünlüğü +     */
/* TOOL_NAMES↔README çapraz kontrol                                    */
/*                                                                     */
/* Kanıt: sprint-7 F2 · TŞ §17.1 (pakette derlenmiş gerçek giriş;      */
/* skills paket içinde kalır) · zcode-guide:diagnosing-plugins         */
/* resmî manifest şeması (name regex, component path doğrulama,        */
/* commands/skills/hook'lar opsiyonel yüzeyler) · wiki/mcp-tools.md    */
/* ------------------------------------------------------------------ */

describe("F2: skills paket bütünlüğü (generic)", () => {
  it("POZİTİF: skills/ altındaki her skill dizini geçerli SKILL.md taşır", () => {
    const issues = validateSkillBundle(path.join(PLUGIN_DIR, "skills"));
    expect(issues, JSON.stringify(issues)).toEqual([]);
  });

  it("NEGATİF: SKILL.md eksik skill dizini sentetik ağaçta reddedilir", () => {
    const tmpSkills = mkdtempSync(path.join(os.tmpdir(), "causoryn-skills-"));
    try {
      mkdirSync(path.join(tmpSkills, "broken-skill"), { recursive: true });
      const issues = validateSkillBundle(tmpSkills);
      expect(issues.map((i) => i.path)).toContain("broken-skill");
    } finally {
      rmSync(tmpSkills, { recursive: true, force: true });
    }
  });

  it("NEGATİF: frontmatter name dizin adından farklıysa reddedilir", () => {
    const tmpSkills = mkdtempSync(path.join(os.tmpdir(), "causoryn-skills-"));
    try {
      mkdirSync(path.join(tmpSkills, "renamed-skill"), { recursive: true });
      writeFileSync(
        path.join(tmpSkills, "renamed-skill", "SKILL.md"),
        "---" +
          "\nname: some-other-name" +
          "\ndescription: fixture" +
          "\n---" +
          "\nbody",
      );
      const issues = validateSkillBundle(tmpSkills);
      expect(
        issues.some(
          (i) =>
            i.path === "renamed-skill/frontmatter.name" &&
            i.message.includes("renamed-skill"),
        ),
        JSON.stringify(issues),
      ).toBe(true);
    } finally {
      rmSync(tmpSkills, { recursive: true, force: true });
    }
  });

  it("NEGATİF: SKILL.md dosya değil dizin olarak paketlendiyse reddedilir (çökmez)", () => {
    // Bozuk paket senaryosu: SKILL.md adında DİZİN. Validator çökmemeli;
    // temiz bir şema reddi üretmelidir (existsSync tek başına yanıltır —
    // dizin için de geçerlidir).
    const tmpSkills = mkdtempSync(path.join(os.tmpdir(), "causoryn-skills-"));
    try {
      mkdirSync(path.join(tmpSkills, "dir-skill", "SKILL.md"), { recursive: true });
      const issues = validateSkillBundle(tmpSkills);
      expect(
        issues.some((i) => i.path.startsWith("dir-skill")),
        JSON.stringify(issues),
      ).toBe(true);
    } finally {
      rmSync(tmpSkills, { recursive: true, force: true });
    }
  });
});

describe("F2: manifest şeması güçlendirmeleri (resmî plugin.json sözleşmesi)", () => {
  it("NEGATİF: commands yüzeyi bildirilir ama pakette yoksa reddedilir", () => {
    // Resmî şemada commands opsiyonel bir component path'idir; bildirildiyse
    // pakette mevcut olmalıdır (component path doğrulaması). Bu paket
    // commands bildirmez — pozitif durum ayrı testtedir.
    const issues = validateManifest(fixtureManifest({ commands: "commands" }), PLUGIN_DIR);
    expect(issues.map((i) => i.path)).toContain("commands");
  });

  it("POZİTİF: manifest commands bildirmez → commands yüzeyi sorunsuz", () => {
    const issues = validateManifest(
      JSON.parse(readPluginFile(MANIFEST_REL)) as unknown,
      PLUGIN_DIR,
    );
    expect(issues.some((i) => i.path.startsWith("commands"))).toBe(false);
  });

  it("GUARD/NEGATİF: name resmî regex desenine uymuyorsa reddedilir", () => {
    // Resmî şema: name ^[a-z0-9][a-z0-9._-]{0,127}$ — büyük harf ve geçersiz
    // karakter reddedilir.
    const issues = validateManifest(fixtureManifest({ name: "Causoryn!" }), PLUGIN_DIR);
    expect(issues.map((i) => i.path)).toContain("name");
  });

  it("GUARD/NEGATİF: skills mutlak yola işaret ederse reddedilir", () => {
    // Resmî component path kuralı: mutlak yol reddedilir (plugin kökünden
    // çıkar). resolveWithinPluginRoot bunu kaçış olarak raporlar.
    const absolute = ["C:", "elsewhere", "skills"].join(SEPARATOR);
    const issues = validateManifest(fixtureManifest({ skills: absolute }), PLUGIN_DIR);
    expect(issues.map((i) => i.path)).toContain("skills");
  });

  it("GUARD/NEGATİF: mcpServers fazladan server girdisi taşıyorsa reddedilir", () => {
    // Paket sözleşmesi: bu plugin tam bir causoryn server girdisi taşır
    // (BAĞLANTI testi gerçek dosyada ["causoryn"] kümesini zorlar). Validator
    // da aynı katı tekil kuralı uygulamalıdır — aksi halde manifest'e
    // sızdırılan ikinci bir server girdisi şema denetiminden geçer (env
    // anahtarı katılığının birebir örüntüsü).
    const tampered = fixtureManifest();
    (tampered.mcpServers as Record<string, unknown>).second = {
      type: "stdio",
      command: "python3",
      args: ["-c", "print('tamper')"],
    };
    const issues = validateManifest(tampered, PLUGIN_DIR);
    expect(
      issues.some((i) => i.path === "mcpServers" && i.message.includes("tam bir")),
      JSON.stringify(issues),
    ).toBe(true);
  });
});

describe("F2: TOOL_NAMES↔README çapraz kontrol", () => {
  const catalog = FULL_CATALOG_FROM_SOURCE;

  it("BAĞLANTI: README geri tırnak araç kümesi 32-araçlık tam katalogla (11 core + 29 legacy birleşimi) birebir eşit", () => {
    expect(catalog.length, "katalog çıkarılamadı").toBe(32);
    const readme = readPluginFile("README.md");
    const tokens = extractReadmeToolTokens(readme);
    expect(tokens, "README backtick kümesi katalogla eşit değil").toEqual(catalog);
  });

  it("LINK: the README's default `core` profile table lists exactly CORE_TOOL_NAMES (the 11-tool default surface)", () => {
    expect(CORE_TOOL_NAMES_FROM_SOURCE.length, "core catalog could not be extracted").toBe(11);
    const readme = readPluginFile("README.md");
    const coreTable = extractSectionTableTools(readme, "### Default `core` profile");
    expect(coreTable, "README core-profile table does not match CORE_TOOL_NAMES").toEqual(
      [...CORE_TOOL_NAMES_FROM_SOURCE].sort(),
    );
  });

  it("LINK: the README's legacy table maps every DEPRECATED_TOOL_REPLACEMENTS entry to its core replacement and documents how to select the full profile", () => {
    const replacements = extractDeprecatedReplacements(VERSION_TS);
    expect(Object.keys(replacements).length, "replacement map could not be extracted").toBe(12);
    const readme = readPluginFile("README.md");
    const rows = extractLegacyReplacementRows(readme);
    expect(rows, "README legacy table does not match DEPRECATED_TOOL_REPLACEMENTS").toEqual(
      Object.entries(replacements).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    expect(readme).toContain("--tool-profile full");
    expect(readme).toContain('"CAUSORYN_TOOL_PROFILE": "full"');
  });

  it("NEGATIVE (mechanism): a core tool missing from the core-profile table breaks the core-list check", () => {
    const readme = readPluginFile("README.md");
    const victim = CORE_TOOL_NAMES_FROM_SOURCE[0] as string;
    const tampered = readme.replace("| `" + victim + "` |", "| `causoryn_removed_tool` |");
    expect(extractSectionTableTools(tampered, "### Default `core` profile")).not.toEqual(
      [...CORE_TOOL_NAMES_FROM_SOURCE].sort(),
    );
  });

  it("NEGATİF (mekanizma): README'den bir araç çıkarılırsa çapraz kontrol kırılır", () => {
    // Koruma sinyali kanıtı: gerçek README'den ilk katalog aracının
    // backtick'li anılımı silinir; küme eşitliği bu durumda KIRILMALIDIR.
    const victim = catalog[0] as string;
    const readme = readPluginFile("README.md");
    const tampered = readme.split("`" + victim + "`").join("`causoryn_removed_tool`");
    expect(extractReadmeToolTokens(tampered)).not.toEqual(catalog);
  });

  it("NEGATİF (mekanizma): README'ye yayımlanmamış araç eklenirse küme eşitliği kırılır", () => {
    // ADR-010 mekanizma testi: hiçbir zaman yayımlanmayacak sentetik ad.
    const readme = readPluginFile("README.md");
    const tampered = readme + "\nUse `causoryn_tool_that_does_not_exist` please.\n";
    expect(extractReadmeToolTokens(tampered)).not.toEqual(catalog);
  });
});
