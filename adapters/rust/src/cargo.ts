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
import { spawn, spawnSync } from "node:child_process";
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
 * cargo build'i LİTERAL "cargo" komutu + sabit argümanlarla çalıştırır
 * (shell yok; child env allowlist'li ve cargo-home PATH ön ekli).
 * Zaman aşımında süreç kill edilir ve status=null döner; çağıran bunu
 * "derlenemedi" olarak raporlar.
 */
export function runCargoBuild(input: {
  manifestPath: string;
  timeoutMs: number;
}): Promise<CargoBuildOutcome> {
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
      finish({
        status: null,
        stdout: stdoutText,
        stderr: stderrText,
        spawnError: `cargo build ${String(input.timeoutMs)} ms içinde tamamlanmadı (zaman aşımı); süreç sonlandırıldı`,
      });
    }, input.timeoutMs);

    try {
      child = spawn(
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

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutText += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });

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
