/**
 * cargo toolchain yardımcıları — @causoryn/adapter-rust (M1-Rust).
 *
 * Kırmızı çizgi 6 (spawn güvenliği) — LİTERAL komut disiplini: bu modül
 * spawn çağrılarının TAMAMINDA SABİT LİTERAL komut ("cargo") kullanır;
 * toolchain konumu komut argümanı DEĞİL, child env PATH'ine ÖNEKLENEN
 * sabit dizindir (cargo-home). Argümanlar tamamen sabittir:
 * ["build", "--manifest-path", <repo-içi sabit manifest yolu>] — shell
 * YOKTUR; kaynak içerikleri yalnızca stdin üzerinden taşınır (worker istek
 * gövdesinde). statik güvenlik bulgusu (değişken komut → spawn) için üç savunma
 * katmanı:
 *   1. Komut her yerde LİTERAL "cargo"; konum override'ı CAUSORYN_CARGO_HOME
 *      env'iyle PATH öneki olarak yapılır (yol filtresinden geçmek zorunda).
 *   2. isSafeDirPath: override dizininde kontrol/kabuk meta karakterleri
 *      reddedilir (shell:false olsa da savunma).
 *   3. "cargo" PATH'te yoksa cargo-home dizini PATH'e öneklemeyle eklenir;
 *      hiçbiri yoksa probe/build başarısız → adapter açık warning ile
 *      L0/L1'e düşer (motor çökmez).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { delimiter, join } from "node:path";

/**
 * cargo build alt sürecine geçilen ortam değişkeni allowlist'i (savunma
 * derinliği; csharp-roslyn WORKER_ENV_ALLOWLIST karşılığı): cargo'nun
 * ÇALIŞMASI için gereken küçüktür — PATH (rustc/linker), SystemRoot,
 * COMSPEC, TEMP/TMP (Windows süreç altyapısı), USERPROFILE/HOME
 * (cargo registry + .cargo konumu), CARGO_HOME/RUSTUP_HOME. Allowlist
 * dışı değerler (token/anahtar) sürece taşınmaz.
 */
export const CARGO_ENV_ALLOWLIST = [
  "PATH",
  "SystemRoot",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
  "CARGO_HOME",
  "RUSTUP_HOME",
] as const;

/** Worker alt süreci (yürütülebilir binary) için daraltılmış allowlist. */
export const WORKER_ENV_ALLOWLIST = [
  "PATH",
  "SystemRoot",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
] as const;

/**
 * cargo build çıktı birikimi için varsayılan akış üst sınırı (char).
 * Worker yanıt bütçesinin (DEFAULT_RESPONSE_MAX_CHARS, 64M) aynasıdır —
 * güvenlik bulgusu karşılığı: build çıktısı timeout penceresinde
 * sınırsız birikemez.
 */
export const DEFAULT_BUILD_OUTPUT_MAX_CHARS = 64 * 1024 * 1024;

/**
 * cargo build spawn enjeksiyonu imzası (yalnızca testler) — adapters/rust
 * SpawnFunction deseninin cargo stdio'suna (ignore|pipe|pipe) uyarlanan
 * karşılığı; default node:child_process.spawn.
 */
export type CargoSpawnFunction = (
  command: string,
  args: readonly string[],
  options: {
    readonly stdio: ["ignore", "pipe", "pipe"];
    readonly env: Readonly<Record<string, string>>;
  },
) => ChildProcess;

/**
 * Dizin güvenlik filtresi (savunma katmanı 2): boş/aşırı uzun değerler,
 * kontrol karakterleri ve kabuk meta karakterleri reddedilir.
 * shell:false ile zaten kabuk yorumlaması yoktur; bu katman, PATH öneki
 * dizininin süreç başlatılmadan FİLTRElenmesini sağlar.
 */
export function isSafeCommandPath(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
    if ("<>|&;^$`\"'".includes(ch)) return false;
  }
  return true;
}

/**
 * cargo-home dizinini çözümler: (1) CAUSORYN_CARGO_HOME env override'ı
 * (config kuralı — güvenlik filtresinden geçmek zorunda), (2)
 * %USERPROFILE%\.cargo\bin / $HOME/.cargo/bin sabit aday yolu. Hiçbiri
 * yoksa null — çağıran PATH'siz default PATH ile devam eder ya da düşer.
 */
export function resolveCargoHomeDir(): string | null {
  const override = process.env["CAUSORYN_CARGO_HOME"];
  if (override !== undefined && override.trim().length > 0) {
    return isSafeCommandPath(override) ? override : null;
  }
  const home = process.env["USERPROFILE"] ?? process.env["HOME"];
  if (home !== undefined && home.length > 0) {
    return join(home, ".cargo", "bin");
  }
  return null;
}

/**
 * Tool süreçleri için allowlist'li ortam kurar; cargo-home dizini
 * biliniyorsa PATH'in başına ÖNEKLENİR — böylece LİTERAL "cargo" komutu
 * PATH çözümlemesiyle o dizinden bulunur (komut değişkeni YOKTUR).
 */
export function buildToolEnv(
  allowlist: readonly string[],
  prependDir: string | null,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined && value.length > 0) {
      env[key] = value;
    }
  }
  if (prependDir !== null && isSafeCommandPath(prependDir)) {
    env["PATH"] = prependDir + delimiter + (env["PATH"] ?? "");
  }
  return env;
}

function probeCargo(): boolean {
  const cargoHome = resolveCargoHomeDir();
  const probe = spawnSync("cargo", ["--version"], {
    encoding: "utf8",
    shell: false,
    timeout: 15_000,
    env: buildToolEnv(CARGO_ENV_ALLOWLIST, cargoHome),
  });
  return probe.status === 0;
}

/**
 * cargo toolchain'i kullanılabilir mi? LİTERAL "cargo" komutu PATH
 * (öncelikli olarak cargo-home önekli) üzerinden çözümlenerek yoklanır.
 */
export function isCargoAvailable(): boolean {
  return probeCargo();
}

/** cargo build koşum sonucu — adapter fallback kararı buna göre verir. */
export interface CargoBuildOutcome {
  /** exit kodu; spawn hatası / sinyal / zaman aşımında null. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Süreç başlatılamadıysa (ENOENT vb.) insan-okur sebep; yoksa boş. */
  readonly spawnError: string;
}

/**
 * cargo build zaman aşımında doğrudan cargo sürecinin ÖTESİNDE rustc/
 * codegen TORUN süreçlerini de sonlandırır (win32): LİTERAL "taskkill" +
 * /pid <KENDİ çocuğumuzun sayısal pid'i> /T (ağaç) /F (zorla) — go
 * worker taskkill deseninin (adapters/go worker-process killProcessTree)
 * cargo build karşılığı. Torunlar finite süreçlerdir (derleme bitince
 * kendiliklerinden çıkarlar); ağaç-kill savunma derinliğidir. pid kullanıcı
 * girdisi DEĞİLDİR; shell yoktur; argümanlar istek içeriğinden
 * türetilmez (kırmızı çizgi 6). taskkill başlatılamazsa doğrudan kill
 * zaten uygulanmıştır.
 */
function killBuildTree(spawnFn: CargoSpawnFunction, child: ChildProcess | null): void {
  if (process.platform !== "win32") return;
  const pid = child?.pid;
  if (pid === undefined) return;
  try {
    const killer = spawnFn(
      "taskkill", // LİTERAL komut — kırmızı çizgi 6
      ["/pid", String(pid), "/T", "/F"],
      { stdio: ["ignore", "pipe", "pipe"], env: buildToolEnv(CARGO_ENV_ALLOWLIST, null) },
    );
    killer.on("error", () => {}); // taskkill yoksa/hata verirse doğrudan kill yeterli
    killer.once("exit", () => {
      killer.removeAllListeners();
    });
  } catch {
    // spawnFn enjeksiyonları senkron patlayabilir; doğrudan kill uygulanmıştır.
  }
}

/**
 * cargo build'i LİTERAL "cargo" komutu + sabit argümanlarla çalıştırır
 * (shell yok; child env allowlist'li ve cargo-home PATH ön ekli).
 * Zaman aşımında süreç kill edilir (win32'de ağaç-kill ile) ve
 * status=null döner; çağıran bunu "derlenemedi" olarak raporlar.
 */
export function runCargoBuild(input: {
  manifestPath: string;
  timeoutMs: number;
  /**
   * Her çıktı akışı (stdout/stderr) için char üst sınırı; tanımsızsa 64M
   * (worker yanıt bütçesinin aynası). Güvenlik bulgusu karşılığı: cargo
   * build çıktısı timeout penceresinde sınırsız birikemez — aşım → süreç
   * kill + status:null; saklanan kuyruk baştan bütçeye kırpılır.
   */
  outputMaxChars?: number;
  /** Test enjeksiyonu; default node:child_process.spawn. */
  spawnFn?: CargoSpawnFunction;
}): Promise<CargoBuildOutcome> {
  const spawnFn = input.spawnFn ?? spawn;
  const outputMaxChars = input.outputMaxChars ?? DEFAULT_BUILD_OUTPUT_MAX_CHARS;
  return new Promise((resolveBuild) => {
    let settled = false;
    let stdoutText = "";
    let stderrText = "";
    let child: import("node:child_process").ChildProcess | null = null;

    const finish = (outcome: CargoBuildOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.removeAllListeners();
      child?.stdout?.removeAllListeners();
      child?.stderr?.removeAllListeners();
      child?.on("error", () => {}); // temizlik sonrası olaylar yutulur
      resolveBuild(outcome);
    };

    const timer = setTimeout(() => {
      child?.kill();
      // win32: rustc/codegen torun süreçleri de sonlandırılır (savunma
      // derinliği; go worker taskkill deseni).
      killBuildTree(spawnFn, child);
      finish({
        status: null,
        stdout: stdoutText,
        stderr: stderrText,
        spawnError: `cargo build ${String(input.timeoutMs)} ms içinde tamamlanmadı (zaman aşımı); süreç sonlandırıldı`,
      });
    }, input.timeoutMs);

    try {
      child = spawnFn(
        "cargo", // LİTERAL komut — kırmızı çizgi 6
        ["build", "--manifest-path", input.manifestPath],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: buildToolEnv(CARGO_ENV_ALLOWLIST, resolveCargoHomeDir()),
        },
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      finish({
        status: null,
        stdout: "",
        stderr: "",
        spawnError: `cargo süreci başlatılamadı: ${detail}`,
      });
      return;
    }

    child.on("error", (error: Error) => {
      const detail = error instanceof Error ? error.message : String(error);
      finish({
        status: null,
        stdout: stdoutText,
        stderr: stderrText,
        spawnError: `cargo süreci başlatılamadı: ${detail}`,
      });
    });

    /** Tek akış için bütçeli biriktirici (stdout/stderr ortak disiplin). */
    const accumulate = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const incoming = chunk.toString("utf8");
      const current = stream === "stdout" ? stdoutText : stderrText;
      if (current.length + incoming.length > outputMaxChars) {
        const capped = (current + incoming).slice(0, outputMaxChars);
        if (stream === "stdout") stdoutText = capped;
        else stderrText = capped;
        child?.kill();
        finish({
          status: null,
          stdout: stdoutText,
          stderr: stderrText,
          spawnError: `cargo build ${stream} çıktısı ${String(outputMaxChars)} karakter sınırını aştı; süreç sonlandırıldı`,
        });
        return;
      }
      if (stream === "stdout") stdoutText += incoming;
      else stderrText += incoming;
    };

    child.stdout?.on("data", accumulate("stdout"));
    child.stderr?.on("data", accumulate("stderr"));

    child.on("exit", (code: number | null) => {
      finish({
        status: code,
        stdout: stdoutText,
        stderr: stderrText,
        spawnError: "",
      });
    });
  });
}
