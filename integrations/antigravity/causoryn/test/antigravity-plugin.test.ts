import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Sprint-7 F5 — Antigravity plugin.json + mcp.json doküman örneği testleri.
 *
 * Kanıt: TŞ v2.1 §17.1 (Antigravity plugin birincil paket; plugin.json/mcp.json
 * örnek manifest'leri + "Eklenti paketinde scripts/mcp-server.mjs gerçekten
 * derlenmiş olmalı; root'taki kaynak TS dosyasına işaret edilemez" kuralı),
 * §17.4 (uyum/güven matrisi Antigravity satırı), §22 ("agy CLI yoksa
 * çalıştırılmadı diye açıkça raporla" — PDF s.23'te bu cümle §22 'Dikey
 * dilim kabul testi' paragrafını kapatır; hemen ardından '23.' başlığı
 * gelir: bölüm atfı §22'dir, §23 DEĞİL).
 *
 * TDD: bu test dosyası artefaktlardan ÖNCE yazıldı ve önce KIRMIZI koşuldu
 * (dosyalar yokken ENOENT ile düşüyordu); sonra plugin.json + mcp.json +
 * docs/hosts/antigravity.md yazılarak yeşile getirildi (DEVELOPMENT_FLOW).
 *
 * Üçlü kapsama (pozitif + negatif + partial):
 * - Pozitif: gerçek repo manifest'lerinin JSON parse + TŞ §17 zorunlu alan
 *   doğrulaması; derlenmiş .mjs bundle göstergesi (kaynak .ts işareti YASAK).
 * - Negatif: bozuk JSON ve yapısal olarak geçersiz manifest'ler sentetik
 *   tmpdir fikstürleriyle açık reddedilir.
 * - Partial (dürüstlük): docs/hosts/antigravity.md içindeki birebir NOT RUN
 *   beyanı assert edilir — agy CLI bu makinede YOK (Antigravity IDE kurulu,
 *   `agy` komutu yok: `bash: agy: command not found`), kurulum/smoke testleri
 *   KOŞULMADI; hiçbir koşum kanıtı üretilmez (ADR-010, kırmızı kural 5).
 *
 * Testler salt okunurdur; tek yazma os.tmpdir() altındaki geçici negatif
 * fikstürdür ve her test sonunda silinir (ADR-008).
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

const PLUGIN_DIR = path.join(REPO_ROOT, "integrations", "antigravity", "causoryn");
const PLUGIN_JSON_PATH = path.join(PLUGIN_DIR, "plugin.json");
const MCP_JSON_PATH = path.join(PLUGIN_DIR, "mcp.json");
const DOC_PATH = path.join(REPO_ROOT, "docs", "hosts", "antigravity.md");

/** TŞ §17.1 plugin.json örnek manifest'inin $schema değeri — birebir. */
const EXPECTED_SCHEMA = "https://antigravity.google/schemas/v1/plugin.json";

/** TŞ §17.1 örnek manifest'inin önerilen prompt'ları — birebir üçlü. */
const EXPECTED_SUGGESTED_PROMPTS = [
  "Map this workspace and show evidence for critical dependencies",
  "Run a change preflight for the selected endpoint",
  "Verify my working-tree changes against architecture contracts",
] as const;

/**
 * Dürüstlük beyanı — birebir metin. Dokümanda AYNEN bu cümle bulunmalıdır;
 * agy CLI bulunamadığından kurulum/smoke koşulmamıştır.
 */
const NOT_RUN_STATEMENT = "agy CLI bulunamadı — bu hostta kurulum/smoke koşulmadı";

/**
 * Plugin manifest'inde YASAK kalıplar (görev sözleşmesi): manifest hiçbir
 * kimlik bilgisi taşıyamaz; tüm yetkilendirme CAUSORYN_CONFIG ile
 * kullanıcı beyanıdır (TŞ §9/§20 default deny).
 */
const CREDENTIAL_PATTERN =
  /(api[_-]?key|secret|token|password|credential|bearer|private[_-]?key)/i;

/** "dolar süslü" kalıbı: kaynakta tek parça yazılmaz (güvenlik taraması;
 * zcode plugin testi konvansiyonu — bulgu 5). */
const DOLLAR_BRACE = "$" + "{";
/** Plugin kök token'ı — Antigravity yükleyicisi çözer (TŞ §17.1). */
const PLUGIN_ROOT_TOKEN = DOLLAR_BRACE + "PLUGIN_ROOT}";

/* ------------------------------------------------------------------ */
/* Yardımcılar: katı JSON parse + şema doğrulayıcılar                  */
/* ------------------------------------------------------------------ */

/**
 * Katı JSON parse: bozuk girdide etiketli AÇIK hata fırlatır (negatif
 * testlerin dayanağı). Ham metin döner; çağıran doğrulayıcıya verir.
 */
function parseJsonStrict(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: JSON parse başarısız — ${reason}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface AntigravityPluginManifest {
  $schema: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  suggestedPrompts: string[];
}

export interface AntigravityMcpManifest {
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}

/**
 * TŞ §17.1 plugin.json alan sözleşmesi. Eksik/yanlış alanda etiketli hata
 * (negatif testler bu hatayı sentetik girdilerle egzersizler).
 */
function validatePluginManifest(value: unknown, label: string): AntigravityPluginManifest {
  const rec = asRecord(value);
  if (rec === undefined) {
    throw new Error(`${label}: manifest bir JSON nesnesi olmalı`);
  }
  const stringFields: ReadonlyArray<[string, string]> = [
    ["$schema", EXPECTED_SCHEMA],
    ["name", "causoryn"],
    ["displayName", "Causoryn"],
  ];
  for (const [field, expected] of stringFields) {
    const actual = rec[field];
    if (typeof actual !== "string" || actual.length === 0) {
      throw new Error(`${label}: zorunlu string alan eksik veya boş — "${field}"`);
    }
    if (actual !== expected) {
      throw new Error(
        `${label}: "${field}" beklenen "${expected}", gelen "${actual}" (TŞ §17.1)`,
      );
    }
  }
  if (typeof rec.version !== "string" || !/^\d+\.\d+\.\d+$/.test(rec.version)) {
    throw new Error(`${label}: "version" semver olmalı (TŞ §17.1 örneği 0.1.0)`);
  }
  if (typeof rec.description !== "string" || rec.description.length === 0) {
    throw new Error(`${label}: "description" zorunlu (TŞ §17.1)`);
  }
  const prompts = rec.suggestedPrompts;
  if (
    !Array.isArray(prompts) ||
    prompts.length !== EXPECTED_SUGGESTED_PROMPTS.length ||
    prompts.some((p) => typeof p !== "string" || p.length === 0)
  ) {
    throw new Error(
      `${label}: "suggestedPrompts" TŞ §17.1 üçlüsüyle eşit uzunlukta string dizisi olmalı`,
    );
  }
  if (rec.mcpServers !== undefined) {
    throw new Error(
      `${label}: plugin.json mcpServers TAŞIMAZ — sunucu kablolaması mcp.json'dadır (Antigravity formatı, TŞ §17.1)`,
    );
  }
  return rec as unknown as AntigravityPluginManifest;
}

/**
 * TŞ §17.1 mcp.json alan sözleşmesi + gerçek sunucu sözleşmesi:
 * - mcpServers.engine.command "node" (LLM yok, yerel süreç — kırmızı kural 1);
 * - args derlenmiş .mjs bundle'ı gösterir; src/*.ts işareti YASAK (§17.1);
 * - "--data-dir" YOK: yayımlanan stdio girişi argv okumaz
 *   (packages/mcp-server/src/stdio.ts:31-46 yalnızca CAUSORYN_CONFIG okur);
 *   TŞ örneğindeki --data-dir sapması docs/hosts/antigravity.md'de belgelenir.
 */
function validateMcpManifest(value: unknown, label: string): AntigravityMcpManifest {
  const rec = asRecord(value);
  if (rec === undefined) {
    throw new Error(`${label}: manifest bir JSON nesnesi olmalı`);
  }
  const servers = asRecord(rec.mcpServers);
  if (servers === undefined) {
    throw new Error(`${label}: zorunlu alan eksik — "mcpServers"`);
  }
  const engine = asRecord(servers["engine"]);
  if (engine === undefined) {
    throw new Error(`${label}: mcpServers altında "engine" girdisi yok (TŞ §17.1 örneği)`);
  }
  if (engine.command !== "node") {
    throw new Error(`${label}: engine.command "node" olmalı, gelen "${String(engine.command)}"`);
  }
  const args = engine.args;
  if (!Array.isArray(args) || args.length === 0 || args.some((a) => typeof a !== "string")) {
    throw new Error(`${label}: engine.args boş olmayan string dizisi olmalı`);
  }
  const entry = args[0] as string;
  if (!entry.startsWith(PLUGIN_ROOT_TOKEN)) {
    throw new Error(`${label}: ilk arg ${PLUGIN_ROOT_TOKEN} token'ıyla başlamalı (TŞ §17.1)`);
  }
  if (!entry.endsWith("mcp-server.mjs")) {
    throw new Error(`${label}: giriş noktası derlenmiş mcp-server.mjs olmalı (TŞ §17.1)`);
  }
  if (args.some((a) => a.includes("src/") || a.endsWith(".ts"))) {
    throw new Error(
      `${label}: kaynak TS dosyasına işaret YASAK — derlenmiş bundle zorunlu (TŞ §17.1)`,
    );
  }
  if (args.some((a) => a === "--data-dir")) {
    throw new Error(
      `${label}: "--data-dir" yayımlanan sunucuda argv olarak OKUNMAZ (stdio.ts) — konfigürasyon CAUSORYN_CONFIG'tir`,
    );
  }
  const env = asRecord(engine.env);
  if (env === undefined) {
    throw new Error(`${label}: engine.env eksik — CAUSORYN_CONFIG default-deny beyanı gerekli`);
  }
  const rawConfig = env["CAUSORYN_CONFIG"];
  if (typeof rawConfig !== "string" || rawConfig.length === 0) {
    throw new Error(`${label}: env.CAUSORYN_CONFIG zorunlu`);
  }
  const parsedConfig = asRecord(parseJsonStrict(rawConfig, `${label} CAUSORYN_CONFIG`));
  if (parsedConfig === undefined) {
    throw new Error(`${label}: CAUSORYN_CONFIG bir JSON nesnesi olmalı`);
  }
  if (!Array.isArray(parsedConfig["allowRoots"])) {
    throw new Error(`${label}: CAUSORYN_CONFIG.allowRoots dizi olmalı (default deny: [])`);
  }
  return rec as unknown as AntigravityMcpManifest;
}

/* ------------------------------------------------------------------ */
/* Gerçek artefaktlar                                                  */
/* ------------------------------------------------------------------ */

const PLUGIN_JSON_RAW = readFileSync(PLUGIN_JSON_PATH, "utf8");
const MCP_JSON_RAW = readFileSync(MCP_JSON_PATH, "utf8");
const PLUGIN_MANIFEST = validatePluginManifest(
  parseJsonStrict(PLUGIN_JSON_RAW, "plugin.json"),
  "plugin.json",
);
const MCP_MANIFEST = validateMcpManifest(parseJsonStrict(MCP_JSON_RAW, "mcp.json"), "mcp.json");

/**
 * Sprint-7 F1: bundle commit edilmez (kök .gitignore satır 3: dist/) —
 * diskte VARSA repo-düzeni çözümlemesi tam koşar; YOKSA disk-bağlı
 * assertion'lar açık skip sebebiyle atlanır (ADR-010: üretilmemiş bundle
 * "geçti" sayılmaz).
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
  : ("bundle yok — önce npm run build:bundle (packages/mcp-server)" as const);

/** mcp.json'daki ilk arg'ın repo düzenindeki çözümlenmiş yolu. */
function resolvedBundleArg(): string {
  const firstArg = MCP_MANIFEST.mcpServers["engine"]?.args[0] ?? "";
  return path.resolve(PLUGIN_DIR, firstArg.slice(PLUGIN_ROOT_TOKEN.length + 1));
}

/* ------------------------------------------------------------------ */
/* Pozitif: gerçek manifest'ler — JSON parse + TŞ §17 alan doğrulaması */
/* ------------------------------------------------------------------ */

describe("antigravity plugin.json (TŞ §17.1)", () => {
  it("geçerli JSON'dur ve TŞ §17.1 örnek alanlarını birebir taşır", () => {
    expect(PLUGIN_MANIFEST.$schema).toBe(EXPECTED_SCHEMA);
    expect(PLUGIN_MANIFEST.name).toBe("causoryn");
    expect(PLUGIN_MANIFEST.displayName).toBe("Causoryn");
    expect(PLUGIN_MANIFEST.version).toBe("0.1.0");
    expect(PLUGIN_MANIFEST.description).toBe(
      "Local, evidence-backed codebase and change intelligence via MCP.",
    );
  });

  it("suggestedPrompts TŞ §17.1 üçlüsüyle birebir eşleşir", () => {
    expect(PLUGIN_MANIFEST.suggestedPrompts).toEqual([...EXPECTED_SUGGESTED_PROMPTS]);
  });

  it("sunucu kablolamasını İÇERMEZ — mcp.json ayrı dosyadır (Antigravity formatı)", () => {
    expect(PLUGIN_JSON_RAW.includes("mcpServers")).toBe(false);
  });

  it("kimlik bilgisi kalıbı TAŞIMAZ — yetkilendirme CAUSORYN_CONFIG ile kullanıcıdadır", () => {
    expect(CREDENTIAL_PATTERN.test(PLUGIN_JSON_RAW)).toBe(false);
    expect(CREDENTIAL_PATTERN.test(MCP_JSON_RAW)).toBe(false);
  });
});

describe("antigravity mcp.json (TŞ §17.1 + gerçek sunucu sözleşmesi)", () => {
  it("geçerli JSON'dur; mcpServers.engine stdio node sürecini tanımlar", () => {
    expect(MCP_MANIFEST.mcpServers["engine"]?.command).toBe("node");
    expect(MCP_MANIFEST.mcpServers["engine"]?.args.length).toBeGreaterThan(0);
  });

  it("giriş noktası ${PLUGIN_ROOT} altında derlenmiş mcp-server.mjs'tir; kaynak .ts YASAK", () => {
    const args = MCP_MANIFEST.mcpServers["engine"]?.args ?? [];
    expect(args.some((a) => a.startsWith(PLUGIN_ROOT_TOKEN) && a.endsWith("mcp-server.mjs"))).toBe(
      true,
    );
    expect(args.some((a) => a.endsWith(".ts") || a.includes("src/"))).toBe(false);
  });

  it("--data-dir argv TAŞIMAZ — yayımlanan sunucu argv okumaz (stdio.ts CAUSORYN_CONFIG okur)", () => {
    const args = MCP_MANIFEST.mcpServers["engine"]?.args ?? [];
    expect(args.includes("--data-dir")).toBe(false);
  });

  it("env.CAUSORYN_CONFIG default-deny (allowRoots: []) beyanı taşır", () => {
    const rawConfig = MCP_MANIFEST.mcpServers["engine"]?.env?.["CAUSORYN_CONFIG"];
    expect(typeof rawConfig).toBe("string");
    const parsed = JSON.parse(rawConfig ?? "") as Record<string, unknown>;
    expect(parsed["allowRoots"]).toEqual([]);
  });
});

describe("mcp.json → gerçek F1 bundle bağlantısı (repo düzeni, disk-bağlı)", () => {
  it.skipIf(BUNDLE_SKIP_REASON)(
    "çözümlenen arg yolu diskteki esbuild bundle'ına işaret eder",
    () => {
      expect(resolvedBundleArg()).toBe(BUNDLE_ENTRY_PATH);
      expect(existsSync(resolvedBundleArg())).toBe(true);
    },
  );
});

/* ------------------------------------------------------------------ */
/* Negatif: bozuk JSON ve yapısal olarak geçersiz manifest'ler         */
/* ------------------------------------------------------------------ */

describe("negatif durumlar: bozuk/eksik manifest'ler açık reddedilir", () => {
  it("bozuk JSON (kesik manifest) etiketli açık hatayla reddedilir", () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-antigravity-neg-"));
    try {
      const brokenPath = path.join(tmpRoot, "plugin-broken.json");
      writeFileSync(brokenPath, '{ "name": "causoryn", "version": ', "utf8");
      const raw = readFileSync(brokenPath, "utf8");
      expect(() => parseJsonStrict(raw, brokenPath)).toThrowError(/JSON parse başarısız/);
      expect(() => parseJsonStrict(raw, brokenPath)).toThrowError(/plugin-broken\.json/);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("geçerli JSON ama zorunlu alan eksik → alan adıyla reddedilir", () => {
    const missingName = { $schema: EXPECTED_SCHEMA, displayName: "Causoryn", version: "0.1.0" };
    expect(() => validatePluginManifest(missingName, "sentetik-plugin.json")).toThrowError(
      /"name"/,
    );
    const missingEngine = { mcpServers: {} };
    expect(() => validateMcpManifest(missingEngine, "sentetik-mcp.json")).toThrowError(
      /"engine"/,
    );
    const missingCommand = { mcpServers: { engine: { args: ["x"] } } };
    expect(() => validateMcpManifest(missingCommand, "sentetik-mcp.json")).toThrowError(
      /engine\.command/u,
    );
  });

  it("yanlış $schema / suggestedPrompts → TŞ §17.1 sapması olarak reddedilir", () => {
    const wrongSchema = {
      $schema: "https://example.org/other.json",
      name: "causoryn",
      displayName: "Causoryn",
      version: "0.1.0",
      description: "x",
      suggestedPrompts: [...EXPECTED_SUGGESTED_PROMPTS],
    };
    expect(() => validatePluginManifest(wrongSchema, "sentetik-plugin.json")).toThrowError(
      /schema.*TŞ §17\.1|beklenen/s,
    );
    const wrongPrompts = {
      $schema: EXPECTED_SCHEMA,
      name: "causoryn",
      displayName: "Causoryn",
      version: "0.1.0",
      description: "x",
      suggestedPrompts: ["tek prompt"],
    };
    expect(() => validatePluginManifest(wrongPrompts, "sentetik-plugin.json")).toThrowError(
      /suggestedPrompts/,
    );
  });

  it("kaynak TS dosyasına işaret eden mcp.json → TŞ §17.1 kuralıyla reddedilir", () => {
    const tsPointer = {
      mcpServers: {
        engine: {
          command: "node",
          args: [`${PLUGIN_ROOT_TOKEN}/../../../packages/mcp-server/src/stdio.ts`],
          env: { CAUSORYN_CONFIG: '{"allowRoots":[]}' },
        },
      },
    };
    expect(() => validateMcpManifest(tsPointer, "sentetik-mcp.json")).toThrowError(
      /derlenmiş|\.ts/,
    );
  });

  it("env.CAUSORYN_CONFIG bozuk JSON ise → açık reddedilir", () => {
    const badEnv = {
      mcpServers: {
        engine: {
          command: "node",
          args: [`${PLUGIN_ROOT_TOKEN}/scripts/mcp-server.mjs`],
          env: { CAUSORYN_CONFIG: "{not-json" },
        },
      },
    };
    expect(() => validateMcpManifest(badEnv, "sentetik-mcp.json")).toThrowError(
      /JSON parse başarısız/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Partial (dürüstlük): dokümandaki birebir NOT RUN beyanı             */
/* ------------------------------------------------------------------ */

describe("docs/hosts/antigravity.md — dürüstlük beyanı (TŞ §22)", () => {
  const DOC_RAW = readFileSync(DOC_PATH, "utf8");

  it("agy CLI bulunamadı beyanını BİREBİR taşır — kurulum/smoke koşulmadı", () => {
    expect(DOC_RAW.includes(NOT_RUN_STATEMENT)).toBe(true);
  });

  it("TŞ §17.1 agy komutlarını doküman örneği olarak listeler ve koşulmadığını söyler", () => {
    expect(DOC_RAW.includes("agy plugin validate --strict")).toBe(true);
    expect(DOC_RAW.includes("agy plugin install")).toBe(true);
    expect(DOC_RAW.includes("agy plugin list")).toBe(true);
    expect(DOC_RAW.includes("NOT RUN")).toBe(true);
  });

  it("plugin.json ve mcp.json örneklerini EKSİKSİZ içerir (stdio node girişi)", () => {
    expect(DOC_RAW.includes('"causoryn"')).toBe(true);
    expect(DOC_RAW.includes("mcp-server.mjs")).toBe(true);
    expect(DOC_RAW.includes("CAUSORYN_CONFIG")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Takım denetimi düzeltmeleri (bulgu 1–4): doküman içerik sözleşmesi  */
/* ------------------------------------------------------------------ */

const DOC_TEXT = readFileSync(DOC_PATH, "utf8");

describe("docs/hosts/antigravity.md — takım denetimi düzeltmeleri", () => {
  it("bulgu 1: TŞ §17.1 alıntısı birebir 'çalıştırılmış değildir'; çift olumsuz ('çalıştırılmamış değildir') YASAK", () => {
    expect(DOC_TEXT.includes("bu doküman hazırlanırken çalıştırılmış değildir")).toBe(true);
    expect(DOC_TEXT.includes("çalıştırılmamış değildir")).toBe(false);
  });

  it("bulgu 2: build:bundle talimatı kök script ile çelişmez — kök script yokken çıplak kök koşumu talimat edilmez", () => {
    // Gerçeklik temeli: build:bundle YALNIZCA @causoryn/mcp-server'da tanımlı
    // (packages/mcp-server/package.json scripts); kök package.json'da YOK
    // (denetim bulgusu: kökten koşum "Missing script" verir).
    const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(rootPkg.scripts?.["build:bundle"]).toBeUndefined();
    // Dokümandaki her koşum komutu workspace-nitelenmiş olmalı
    // (String.match eşleşme yokken null döner — [] ile normalleştir)
    const bare = DOC_TEXT.match(/npm run build:bundle(?!\s+--workspace packages\/mcp-server)/g);
    expect(bare ?? []).toEqual([]);
    expect(DOC_TEXT.includes("npm run build:bundle --workspace packages/mcp-server")).toBe(true);
  });

  it("bulgu 3: agy kuralının bölüm atfı §22'dir — PDF s.23'te cümle §22 'Dikey dilim kabul testi' paragrafını kapatır, hemen ardından '23.' başlığı gelir", () => {
    expect(DOC_TEXT.includes("TŞ §22 kuralı uygulanır")).toBe(true);
    expect(DOC_TEXT.includes('§22 "agy CLI yoksa çalıştırılmadı diye açıkça raporla"')).toBe(true);
    expect(DOC_TEXT.includes("TŞ §23 kuralı uygulanır")).toBe(false);
  });

  it("bulgu 4: TŞ §17.4 kavramı birebir 'özdeşliği iddia edilmez'; 'özelliği iddia edilmez' anlam kayması YASAK", () => {
    expect(DOC_TEXT.includes("host UI/permission özdeşliği iddia edilmez")).toBe(true);
    expect(DOC_TEXT.includes("özelliği iddia edilmez")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Test kaynağı taraması (bulgu 5): token kalıbı tek parça yazılmaz    */
/* ------------------------------------------------------------------ */

describe("test kaynağı taraması (bulgu 5): PLUGIN_ROOT token'ı tek parça string literal olarak YAZILMAZ", () => {
  it("bu dosyanın kaynağında token tek parça çift-tırnaklı literal olarak bulunmaz; DOLLAR_BRACE bölünmesi zorunludur (zcode konvansiyonu, güvenlik taraması)", () => {
    // Yasak kalıp da bölünerek kurulur — gard testi kendi aradığı literal ile
    // kendine takılmasın (ilk sürümün gerçek bulgusu).
    const forbiddenLiteral = '"' + DOLLAR_BRACE + 'PLUGIN_ROOT}"';
    const selfSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
    expect(selfSource.includes(forbiddenLiteral)).toBe(false);
    expect(selfSource.includes('"$" + "{"')).toBe(true);
  });
});
