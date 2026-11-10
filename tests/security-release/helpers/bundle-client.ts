import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Sprint-7 F6 güvenlik turu — bundle spawn istemcisi (tests/security-release).
 *
 * packages/mcp-server/test/bundle.test.ts'teki NDJSON satır-tamponu deseninin
 * F6'ya uyarlanmış hâlidir: güvenlik oturumları RASTGELE istek dizisiyle
 * çalışır; tüm stdout/stderr satırları sızıntı taraması için toplanır.
 *
 * Komut yürütme disiplini (statik güvenlik güvenlik incelemesiyle uyumlu): her iki
 * süreç çağrısı da KABUK OLMADAN, argüman listesiyle yapılır (shell:false,
 * sabit Node yürütülebilir'i, tamsayı id'li protokol istekleri). Kullanıcı
 * girdisi hiçbir komut satırına birleştirilmez (TŞ §19 "No shell
 * interpolation" kırmızı çizgisi).
 *
 * Paralellik notu: vitest test dosyalarını koşut çalıştırır; bundle.test.ts
 * beforeAll'da dist'i yeniden üretir (rmSync vendor penceresi). Bu nedenle
 * cloneBundleTo, kopyalama yarışına karşı yeniden denemelidir: başarısız
 * kopya → bundle yeniden üret (deterministik, bit-bit aynı) → tekrar dene.
 */

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
// helpers/ → security-release/ → tests/ → repo kökü (ÜÇ seviye yukarı).
export const REPO_ROOT = path.resolve(THIS_DIR, "..", "..", "..");
const PKG_DIR = path.join(REPO_ROOT, "packages", "mcp-server");
export const DIST_DIR = path.join(PKG_DIR, "dist");
export const BUNDLE_PATH = path.join(DIST_DIR, "mcp-server.mjs");
export const DIST_NODE_MODULES = path.join(DIST_DIR, "node_modules");
export const MANIFEST_PATH = path.join(DIST_DIR, "bundle-manifest.json");
export const BUILD_SCRIPT = path.join(PKG_DIR, "scripts", "build-bundle.mjs");
export const READY_MARKER = "causoryn mcp server hazir";

export interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

/** Envelope şemasının test yüzü (packages/mcp-server/src/envelope.ts ile aynı alanlar). */
export interface EnvelopeLike {
  readonly schemaVersion?: unknown;
  readonly status?: unknown;
  readonly data?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown } | null;
}

function runBuildSync(): void {
  // Argüman listesi + shell yok: sabit Node yürütülebilir'i, sabit script yolu.
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    cwd: PKG_DIR,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Yeni bağımlılıksız senkron bekleme (yeniden deneme arası; pencere kapanması). */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function sha256FileSync(absolutePath: string): string {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}

/**
 * Klon ↔ manifest bayt-kimliği doğrulaması (F6-K0 invariant'ının aynısı):
 * manifest'in her girişi klon kopyasında İKİNCİ kez hash'lenir. Gerekçe:
 * koşut bundle.test.ts beforeAll'ı dist vendor ağacını YERİNDE kurar
 * (build-bundle.mjs rmSync + parça parça cpSync); bu pencereye denk gelen
 * kopya EKSİK dosya kümesini cpSync HATASIZ taşır — eski 3 denemelik
 * yalnızca-fırlatma-tabanlı retry bu sessiz yarım snapshot'ı yakalayamadı
 * (gözlenen kırmızı: klon'da prebuilds/linux-x64.node ENOENT, manifest'te
 * giriş VAR). Kontrol dönüşten ÖNCE yapılır; uyuşmazlık yeniden deneme
 * tetikler, yarım klon asla "başarılı" ferağ edilmez.
 */
function cloneMatchesManifest(destDir: string): boolean {
  let files: Record<string, string>;
  try {
    const manifest = JSON.parse(readFileSync(path.join(destDir, "bundle-manifest.json"), "utf8")) as {
      files?: Record<string, string>;
    };
    files = manifest.files ?? {};
  } catch {
    return false;
  }
  const entries = Object.entries(files);
  if (entries.length === 0) return false;
  for (const [relativeKey, expectedHash] of entries) {
    try {
      if (sha256FileSync(path.join(destDir, ...relativeKey.split("/"))) !== expectedHash) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Bundle + vendored native çalışma zamanı + bundle-manifest.json'ı hedef
 * dizine kopyalar (manifest dahil: statik taramalar ve kimlik bağlama
 * testi TEK korunan klon anlık görüntüsünü okur — takım denetimi bulgusu 4);
 * dist yoksa üretir. cpSync yarışı (koşut dosyanın rmSync penceresi) iki
 * mekanizmayla iyileştirilir: (1) fırlatan kopya hatalarında yeniden üretim,
 * (2) cloneMatchesManifest sessiz yarım snapshot'ı yakalar → önceki denemenin
 * artıkları temizlenip kopya yenilenir. 5 deneme; denemeler arası kısa
 * senkron bekleme koşut rebuild penceresinin kapanmasına zaman tanır.
 */
export function cloneBundleTo(destDir: string): string {
  const target = path.join(destDir, "mcp-server.mjs");
  const maxAttempts = 5;
  let lastError: unknown = undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      if (
        !existsSync(BUNDLE_PATH) ||
        !existsSync(path.join(DIST_NODE_MODULES, "better-sqlite3", "package.json"))
      ) {
        runBuildSync();
      }
      // Yarım önceki denemenin artıkları üzerine değil temiz kopya.
      rmSync(path.join(destDir, "node_modules"), { recursive: true, force: true });
      copyFileSync(BUNDLE_PATH, target);
      cpSync(DIST_NODE_MODULES, path.join(destDir, "node_modules"), { recursive: true });
      copyFileSync(MANIFEST_PATH, path.join(destDir, "bundle-manifest.json"));
      if (!cloneMatchesManifest(destDir)) {
        throw new Error(
          "klon bundle-manifest.json ile uyuşmuyor (koşut rebuild penceresi) — yeniden denenecek",
        );
      }
      return target;
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < maxAttempts) sleepSync(1_500);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface SessionOptions {
  /** Spawn edilecek mcp-server.mjs yolu (klon). */
  readonly bundlePath: string;
  readonly cwd: string;
  readonly config: unknown;
  /** NODE_OPTIONS preload kancası (network guard) — mutlak, eğik çizgili yol. */
  readonly preloadRequirePath?: string;
  readonly netLogPath?: string;
}

export interface BundleSession {
  /** JSON-RPC isteği gönderir ve id eşleşen yanıtı bekler. */
  call(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage>;
  /** Tüm stdout satırları (ham, kırpılmamış — saflık testi bunları kullanır). */
  readonly stdoutLines: readonly string[];
  readonly stderrLines: readonly string[];
  /** stdout+stderr birleşik metin (sızıntı taraması için). */
  sessionText(): string;
  /** Alt sürecin OS pid'i (tanı testleri için; spawn başarısızsa -1). */
  readonly childPid: number;
  /** Süreci kapatır ve exit code döner. */
  close(): Promise<number | null>;
}

export async function startBundleSession(options: SessionOptions): Promise<BundleSession> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env["CAUSORYN_CONFIG"] = JSON.stringify(options.config);
  if (options.preloadRequirePath !== undefined) {
    const forward = options.preloadRequirePath.split(path.sep).join("/");
    if (/\s/.test(forward)) {
      throw new Error(`preload yolu boşluk içeriyor; NODE_OPTIONS boşlukla böler: ${forward}`);
    }
    const existing = env["NODE_OPTIONS"];
    env["NODE_OPTIONS"] = existing === undefined
      ? `--require ${forward}`
      : `${existing} --require ${forward}`;
  }
  if (options.netLogPath !== undefined) {
    env["CAUSORYN_NETLOG"] = options.netLogPath.split(path.sep).join("/");
  }

  const child: ChildProcess = spawn(process.execPath, [options.bundlePath], {
    cwd: options.cwd,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const pending = new Map<number, (message: JsonRpcMessage) => void>();
  let nextId = 0;

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`bundle hazır olmadı (60s). stderr=${JSON.stringify(stderrLines)}`)),
      60_000,
    );
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        stderrLines.push(trimmed);
        if (trimmed.includes(READY_MARKER)) {
          clearTimeout(timer);
          resolve();
        }
      }
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      reject(new Error(`bundle başlamadan kapandı. stderr=${JSON.stringify(stderrLines)}`));
    });
  });

  child.stdout?.setEncoding("utf8");
  let stdoutBuffer = "";
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf("\n");
      stdoutLines.push(line);
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const message = JSON.parse(trimmed) as JsonRpcMessage;
        const id = typeof message.id === "number" ? message.id : undefined;
        if (id !== undefined && pending.has(id)) {
          const resolvePending = pending.get(id);
          pending.delete(id);
          resolvePending?.(message);
        }
      } catch {
        // Saf olmayan satır: test tarafındaki stdout saflık assert'i yakalar.
      }
    }
  });

  await ready;

  // MCP el sıkışması (host davranışı, TŞ §10): initialize + initialized
  // bildirimi; sonraki call() id'leri 1'den başlar (initialize id=0).
  const initializeResponse = await new Promise<JsonRpcMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("initialize yanıtı 30s içinde gelmedi")), 30_000);
    pending.set(0, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "causoryn-f6-security-release", version: "0.0.0" },
        },
      })}\n`,
    );
  });
  if (initializeResponse.error !== undefined) {
    throw new Error(`initialize reddedildi: ${JSON.stringify(initializeResponse.error)}`);
  }
  child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  return {
    childPid: child.pid ?? -1,
    async call(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
      nextId += 1;
      const id = nextId;
      const response = await new Promise<JsonRpcMessage>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${method} (id=${String(id)}) yanıtı 60s içinde gelmedi`)),
          60_000,
        );
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin?.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });
      return response;
    },
    stdoutLines,
    stderrLines,
    sessionText(): string {
      return `${stdoutLines.join("\n")}\n${stderrLines.join("\n")}`;
    },
    close(): Promise<number | null> {
      return new Promise((resolve) => {
        // Çocuk süreç çağrıdan ÖNCE öldüyse 'close' olayı tekrar ateşlenmez;
        // yalnızca dinleyici eklemek promise'i sonsuza dek açık bırakırdı
        // (denetim bulgusu: test/afterAll timeout'u yanıltıcı "timeout"
        // hatasıyla dönerdi). exitCode/signalCode ile zaten-ölü durumu
        // anında çözülür; sinyalle ölümde exitCode null'dur.
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve(child.exitCode);
          return;
        }
        child.stdin?.end();
        child.on("close", (code) => resolve(code));
      });
    },
  };
}

/** result.structuredContent içindeki envelope'u çıkarır (yoksa hata). */
export function envelopeOf(message: JsonRpcMessage): EnvelopeLike {
  const result = message.result as { structuredContent?: unknown } | undefined;
  const envelope = result?.structuredContent;
  if (envelope === undefined || envelope === null || typeof envelope !== "object") {
    throw new Error(`structuredContent yok: ${JSON.stringify(message).slice(0, 400)}`);
  }
  return envelope as EnvelopeLike;
}

/** Error envelope'un sabit kodunu döner (TŞ §10.1 kod tablosu). */
export function errorCodeOf(envelope: EnvelopeLike): string {
  const code = envelope.error?.code;
  if (typeof code !== "string") {
    throw new Error(`error.code yok: ${JSON.stringify(envelope).slice(0, 400)}`);
  }
  return code;
}

/**
 * Kimlik bilgisi kalıbı tarayıcısı (TŞ §19 "Loglar raw source, token, path
 * veya environment secret içermemeli"). Her desen bilinen gerçek token
 * biçimidir; canary self-test'leri tarayıcının her sınıfı yakaladığını
 * kanıtlar (algılayıcının kırmızı- yeteneği).
 */
export interface CredentialMatch {
  readonly pattern: string;
  readonly index: number;
}

export const CREDENTIAL_PATTERNS: readonly { readonly name: string; readonly regex: RegExp }[] = [
  { name: "aws-access-key", regex: /AKIA[0-9A-Z]{16}/g },
  { name: "pem-private-key-block", regex: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { name: "github-token", regex: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: "slack-token", regex: /xox[baprs]-[0-9A-Za-z-]{10,}/g },
  { name: "openai-style-key", regex: /sk-[A-Za-z0-9]{20,}/g },
  { name: "google-api-key", regex: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "bearer-token", regex: /Bearer [A-Za-z0-9_.=+-]{25,}/g },
  {
    name: "secret-assignment-literal",
    regex: /(?:password|passwd|api_?key|secret_?key|access_?token|auth_?token)\s*[:=]\s*["'][^"']{12,}["']/gi,
  },
];

export function scanForCredentials(text: string): CredentialMatch[] {
  const matches: CredentialMatch[] = [];
  for (const pattern of CREDENTIAL_PATTERNS) {
    const found = text.match(pattern.regex) ?? [];
    for (const value of found) {
      const index = text.indexOf(value);
      matches.push({ pattern: pattern.name, index });
    }
  }
  return matches;
}

/**
 * HTML href/src öznitelik URL'lerini çıkarır (dış kaynak taraması).
 * Yalnızca bağlanılabilir kaynak konumları; metin düğümündeki düz metin
 * URL'ler ayrıca tüm-belge http(s) taramasıyla denetlenir.
 */
export function extractHrefSrcValues(html: string): string[] {
  const values: string[] = [];
  const attrRegex = /\b(?:href|src)\s*=\s*"([^"]*)"/gi;
  for (const match of html.matchAll(attrRegex)) {
    if (match[1] !== undefined) values.push(match[1]);
  }
  return values;
}

export function readBundleManifestFiles(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    files?: Record<string, string>;
  };
  if (manifest.files === undefined) throw new Error("bundle-manifest.json files alanı yok");
  return manifest.files;
}
