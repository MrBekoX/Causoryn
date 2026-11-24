/**
 * cargo toolchain helpers — @causoryn/adapter-rust (M1-Rust).
 *
 * Spawn safety (red line 6):
 * - cargo is resolved to an ABSOLUTE path (cargo-home bin first, then PATH;
 *   never the cwd, never a PATH entry inside the analyzed workspace) and is
 *   started with fixed arguments and shell:false; source contents only
 *   travel over the worker's stdin.
 * - The worker crate is built from a staged copy in a Causoryn-controlled
 *   cache directory (buildRustWorkerFromStagedSource), so cargo and rustup
 *   config discovery never walks into the analyzed repository.
 * - isSafeCommandPath / isSafeAbsoluteDirPath filter override directories
 *   (control and shell meta characters) before any process is started.
 * - When cargo is missing the probe/build fails and the adapter falls back
 *   to L0/L1 with an explicit warning (the engine does not crash).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  isFullyQualifiedPath,
  isWithinUntrustedRoots,
  resolveExecutable,
  resolveWindowsSystemExecutable,
  sanitizePathValue,
  trustedWorkingDirectory,
} from "@causoryn/sidecar-ipc";
import { WORKER_BINARY_NAME } from "./types.js";

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
  "CARGO_TARGET_DIR",
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
    readonly cwd?: string;
    readonly shell?: false;
    readonly windowsHide?: true;
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
 * CARGO_HOME / RUSTUP_HOME için mutlak ve yerel dizin doğrulaması:
 * - boş / kontrol karakteri / kabuk meta karakteri reddedilir,
 * - UNC (\\host\share, //host/share) ve Win32 device (\\?\, \\.\) yolları reddedilir,
 * - göreli yollar (ör. ".cargo", "./evil") güvenilmeyen cwd'ye çözülebileceğinden reddedilir,
 * - ".." kaçış segmenti reddedilir.
 */
export function isSafeAbsoluteDirPath(value: string): boolean {
  if (!isSafeCommandPath(value)) return false;
  if (/^(?:\\\\|\/\/|\/\\|\\\/)/.test(value)) return false;
  const isAbs = value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value);
  if (!isAbs) return false;
  if (value.split(/[\\/]/).includes("..")) return false;
  return true;
}

/**
 * cargo-home dizinini çözümler: (1) CAUSORYN_CARGO_HOME env override'ı
 * (config kuralı — mutlak yerel yol filtresinden geçmek zorunda), (2)
 * %USERPROFILE%\.cargo\bin / $HOME/.cargo/bin sabit aday yolu. Hiçbiri
 * yoksa null — çağıran PATH'siz default PATH ile devam eder ya da düşer.
 */
export function resolveCargoHomeDir(): string | null {
  const override = process.env["CAUSORYN_CARGO_HOME"];
  if (override !== undefined && override.trim().length > 0) {
    const trimmed = override.trim();
    return isSafeAbsoluteDirPath(trimmed) ? trimmed : null;
  }
  const home = process.env["USERPROFILE"] ?? process.env["HOME"];
  if (home !== undefined && home.length > 0 && isSafeAbsoluteDirPath(home)) {
    return join(home, ".cargo", "bin");
  }
  return null;
}

/**
 * Tool süreçleri için allowlist'li ortam kurar; cargo-home dizini
 * biliniyorsa PATH'in başına ÖNEKLENİR — böylece LİTERAL "cargo" komutu
 * PATH çözümlemesiyle o dizinden bulunur (komut değişkeni YOKTUR).
 * Cargo toolchain ortamında CARGO_HOME/RUSTUP_HOME mutlak yerel yol
 * doğrulamasından geçer ve CARGO_BUILD_RUSTC_WRAPPER /
 * CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER zorla boşaltılır.
 */
export function buildToolEnv(
  allowlist: readonly string[],
  prependDir: string | null,
  untrustedRoots: readonly string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined && value.length > 0) {
      if (key === "CARGO_TARGET_DIR" && !isSafeCommandPath(value)) {
        continue;
      }
      if (
        (key === "CARGO_HOME" || key === "RUSTUP_HOME") &&
        !isSafeAbsoluteDirPath(value)
      ) {
        continue;
      }
      env[key] = value;
    }
  }
  if (allowlist.includes("CARGO_HOME")) {
    env["CARGO_BUILD_RUSTC_WRAPPER"] = "";
    env["CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER"] = "";
    env["RUSTC_WRAPPER"] = "";
    env["RUSTC_WORKSPACE_WRAPPER"] = "";
  }
  if (prependDir !== null && isSafeCommandPath(prependDir)) {
    env["PATH"] = prependDir + delimiter + (env["PATH"] ?? "");
  }
  if (env["PATH"] !== undefined) {
    // Tools cargo starts (rustc, linker) must not come from the workspace.
    const sanitized = sanitizePathValue(env["PATH"], untrustedRoots);
    if (sanitized.length > 0) env["PATH"] = sanitized;
    else delete env["PATH"];
  }
  return env;
}

export interface CargoResolutionOptions {
  /** cargo-home bin directory searched before PATH; default resolveCargoHomeDir(). */
  readonly cargoHomeDir?: string | null;
  /** Analyzed workspace root(s): PATH entries inside them are never searched. */
  readonly untrustedRoots?: readonly string[];
}

/**
 * Resolves cargo to an absolute executable: cargo-home bin first, then PATH;
 * never the cwd, never a PATH entry inside an untrusted root.
 */
export function resolveCargoExecutable(options: CargoResolutionOptions = {}): string | null {
  const cargoHome =
    options.cargoHomeDir !== undefined ? options.cargoHomeDir : resolveCargoHomeDir();
  return resolveExecutable("cargo", {
    env: process.env,
    untrustedRoots: options.untrustedRoots ?? [],
    prependDirs: cargoHome !== null && isSafeCommandPath(cargoHome) ? [cargoHome] : [],
  });
}

/**
 * cargo toolchain'i kullanılabilir mi? cargo is resolved to an absolute path
 * and probed with `--version` from its own directory (a trusted cwd: rustup
 * would otherwise read a `rust-toolchain.toml` from the cwd's ancestors).
 * process.cwd() asla miraslanmaz.
 */
export function isCargoAvailable(
  _manifestPath?: string,
  options: CargoResolutionOptions = {},
): boolean {
  const cargo = resolveCargoExecutable(options);
  if (cargo === null) return false;
  const untrustedRoots = options.untrustedRoots ?? [];
  const cwd = trustedWorkingDirectory([dirname(cargo)], untrustedRoots);
  if (cwd === null) return false;
  const probe = spawnSync(cargo, ["--version"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    cwd,
    timeout: 15_000,
    env: buildToolEnv(CARGO_ENV_ALLOWLIST, null, untrustedRoots),
  });
  return probe.status === 0;
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
 * codegen TORUN süreçlerini de sonlandırır (win32):
 * %SystemRoot%\System32\taskkill.exe (absolute, its own directory as cwd) +
 * /pid <KENDİ çocuğumuzun sayısal pid'i> /T (ağaç) /F (zorla). pid kullanıcı
 * girdisi DEĞİLDİR; shell yoktur. taskkill başlatılamazsa doğrudan kill
 * zaten uygulanmıştır.
 */
function killBuildTree(
  spawnFn: CargoSpawnFunction,
  child: ChildProcess | null,
  env: Readonly<Record<string, string>>,
): void {
  if (process.platform !== "win32") return;
  const pid = child?.pid;
  if (pid === undefined) return;
  const taskkill = resolveWindowsSystemExecutable("taskkill.exe");
  try {
    const killer = spawnFn(
      taskkill,
      ["/pid", String(pid), "/T", "/F"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        cwd: dirname(taskkill),
        shell: false,
        windowsHide: true,
      },
    );
    killer.on("error", () => {}); // taskkill yoksa/hata verirse doğrudan kill yeterli
    killer.once("exit", () => {
      killer.removeAllListeners();
    });
  } catch {
    // spawnFn enjeksiyonları senkron patlayabilir; doğrudan kill uygulanmıştır.
  }
}

function buildFailure(spawnError: string): Promise<CargoBuildOutcome> {
  return Promise.resolve({ status: null, stdout: "", stderr: "", spawnError });
}

/**
 * cargo build'i absolute cargo path + sabit argümanlarla çalıştırır
 * (shell yok; child env allowlist'li, PATH sanitized). cwd is the
 * manifest's directory, which must not be inside an untrusted root.
 * Zaman aşımında süreç kill edilir (win32'de ağaç-kill ile) ve
 * status=null döner; çağıran bunu "derlenemedi" olarak raporlar.
 */
export function runCargoBuild(input: {
  manifestPath: string;
  timeoutMs: number;
  /** Yazılabilir derleme hedef dizini (--target-dir + CARGO_TARGET_DIR); isSafeCommandPath ile doğrulanır. */
  targetDir?: string;
  /**
   * Her çıktı akışı (stdout/stderr) için char üst sınırı; tanımsızsa 64M
   * (worker yanıt bütçesinin aynası). Güvenlik bulgusu karşılığı: cargo
   * build çıktısı timeout penceresinde sınırsız birikemez — aşım → süreç
   * kill + status:null; saklanan kuyruk baştan bütçeye kırpılır.
   */
  outputMaxChars?: number;
  /** Explicit absolute cargo executable; default resolveCargoExecutable(). */
  cargoExecutable?: string;
  /** cargo-home bin directory searched before PATH. */
  cargoHomeDir?: string | null;
  /** Analyzed workspace root(s): cargo never runs with a cwd inside them. */
  untrustedRoots?: readonly string[];
  /** Test enjeksiyonu; default node:child_process.spawn. */
  spawnFn?: CargoSpawnFunction;
}): Promise<CargoBuildOutcome> {
  if (!isSafeCommandPath(input.manifestPath) || !isAbsolute(input.manifestPath)) {
    return buildFailure("cargo build refused: invalid manifestPath (it must be a safe absolute path)");
  }
  if (input.targetDir !== undefined && !isSafeCommandPath(input.targetDir)) {
    return buildFailure("cargo build refused: invalid CARGO_TARGET_DIR path");
  }
  const inheritedTargetDir = process.env["CARGO_TARGET_DIR"];
  if (
    input.targetDir === undefined &&
    inheritedTargetDir !== undefined &&
    inheritedTargetDir.length > 0 &&
    !isSafeCommandPath(inheritedTargetDir)
  ) {
    return buildFailure("cargo build refused: invalid CARGO_TARGET_DIR path in the environment");
  }
  const untrustedRoots = input.untrustedRoots ?? [];
  const cargoCwd = dirname(input.manifestPath);
  if (isWithinUntrustedRoots(cargoCwd, untrustedRoots)) {
    return buildFailure(
      `cargo build refused: the crate directory is inside the analyzed workspace (${cargoCwd})`,
    );
  }
  let cargo: string | null;
  if (input.cargoExecutable !== undefined) {
    cargo = isFullyQualifiedPath(input.cargoExecutable) ? input.cargoExecutable : null;
  } else {
    cargo = resolveCargoExecutable({
      ...(input.cargoHomeDir !== undefined ? { cargoHomeDir: input.cargoHomeDir } : {}),
      untrustedRoots,
    });
  }
  if (cargo === null) {
    return buildFailure(
      "cargo build was not started: cargo was not found on PATH or in the cargo home directory outside the analyzed workspace",
    );
  }
  const spawnFn = input.spawnFn ?? spawn;
  const outputMaxChars = input.outputMaxChars ?? DEFAULT_BUILD_OUTPUT_MAX_CHARS;
  const childEnv = buildToolEnv(
    CARGO_ENV_ALLOWLIST,
    input.cargoHomeDir !== undefined ? input.cargoHomeDir : resolveCargoHomeDir(),
    untrustedRoots,
  );
  if (input.targetDir !== undefined) {
    childEnv["CARGO_TARGET_DIR"] = input.targetDir;
  }
  const useLocked =
    input.targetDir !== undefined &&
    existsSync(join(cargoCwd, "Cargo.lock"));
  const cargoArgs = [
    "build",
    ...(useLocked ? ["--locked"] : []),
    "--manifest-path",
    input.manifestPath,
    ...(input.targetDir !== undefined ? ["--target-dir", input.targetDir] : []),
  ];

  return new Promise((resolveBuild) => {
    let settled = false;
    let stdoutText = "";
    let stderrText = "";
    let child: ChildProcess | null = null;

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
      killBuildTree(spawnFn, child, childEnv);
      finish({
        status: null,
        stdout: stdoutText,
        stderr: stderrText,
        spawnError: `cargo build did not finish within ${String(input.timeoutMs)} ms (timeout); the process was terminated`,
      });
    }, input.timeoutMs);

    try {
      child = spawnFn(cargo, cargoArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
        cwd: cargoCwd,
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      finish({
        status: null,
        stdout: "",
        stderr: "",
        spawnError: `cargo process could not be started: ${detail}`,
      });
      return;
    }

    child.on("error", (error: Error) => {
      const detail = error instanceof Error ? error.message : String(error);
      finish({
        status: null,
        stdout: stdoutText,
        stderr: stderrText,
        spawnError: `cargo process could not be started: ${detail}`,
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
          spawnError: `cargo build ${stream} output exceeded the ${String(outputMaxChars)} character limit; the process was terminated`,
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

/* ------------------------------------------------------------------ */
/* Staged worker build (outside the analyzed workspace)                */
/* ------------------------------------------------------------------ */

/**
 * Path with symlinks resolved for its nearest existing ancestor (the
 * remaining, not yet existing segments are appended lexically).
 */
function realpathOfNearestExisting(target: string): string {
  let current = resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return rest.length === 0 ? real : join(real, ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      rest.push(basename(current));
      current = parent;
    }
  }
}

function insideUntrusted(target: string, untrustedRoots: readonly string[]): boolean {
  return (
    isWithinUntrustedRoots(target, untrustedRoots) ||
    isWithinUntrustedRoots(realpathOfNearestExisting(target), untrustedRoots)
  );
}

/** Copies regular files of `srcDir` into `destDir` recursively (symlinks are skipped). */
function copyRegularTree(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const from = join(srcDir, entry.name);
    const to = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyRegularTree(from, to);
    } else if (entry.isFile()) {
      copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
    }
  }
}

function copyRegularFileIfPresent(from: string, to: string): void {
  const st = (() => {
    try {
      return lstatSync(from);
    } catch {
      return null;
    }
  })();
  if (st !== null && st.isFile()) {
    copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
  }
}

export interface StagedRustWorkerBuildInput {
  /** The packaged worker crate's Cargo.toml (read only; never built in place). */
  readonly sourceManifestPath: string;
  /** Causoryn-controlled cache directory (must be outside the workspace). */
  readonly cacheRoot: string;
  /** Where the freshly built binary is COPIED to (never hardlinked). */
  readonly destinationBinaryPath: string;
  /** Analyzed workspace root(s). */
  readonly untrustedRoots: readonly string[];
  readonly timeoutMs: number;
  readonly cargoHomeDir?: string | null;
  readonly cargoExecutable?: string;
  readonly outputMaxChars?: number;
  readonly spawnFn?: CargoSpawnFunction;
}

export interface StagedRustWorkerBuildOutcome {
  readonly ok: boolean;
  /** destinationBinaryPath when ok; otherwise null. */
  readonly binaryPath: string | null;
  /** English diagnostic when not ok. */
  readonly detail: string;
}

/**
 * Builds the Rust worker from a STAGED copy of its crate (Cargo.toml,
 * Cargo.lock, build.rs, src/**) inside a fresh directory under `cacheRoot`:
 * cargo's cwd is that directory, `--manifest-path` and `--target-dir` point
 * inside it and `--locked` is used. cargo config discovery and rustup's
 * toolchain-file discovery both walk the cwd's ancestors, so building in the
 * package directory (e.g. <repo>/node_modules/...) would read the analyzed
 * repository's `.cargo/config.toml` / `rust-toolchain.toml`. Every build uses
 * a new target directory, and the output is copied (not linked) to the
 * destination, so the result is always freshly produced bytes. Refuses to
 * build when the cache directory is inside the analyzed workspace.
 */
export async function buildRustWorkerFromStagedSource(
  input: StagedRustWorkerBuildInput,
): Promise<StagedRustWorkerBuildOutcome> {
  const fail = (detail: string): StagedRustWorkerBuildOutcome => ({ ok: false, binaryPath: null, detail });
  for (const [label, value] of [
    ["worker manifest path", input.sourceManifestPath],
    ["Rust build cache directory", input.cacheRoot],
    ["worker binary destination", input.destinationBinaryPath],
  ] as const) {
    if (!isSafeCommandPath(value) || !isFullyQualifiedPath(value)) {
      return fail(`Rust worker build refused: the ${label} must be a safe absolute path (got: ${value})`);
    }
  }
  for (const target of [input.cacheRoot, dirname(input.destinationBinaryPath)]) {
    if (insideUntrusted(target, input.untrustedRoots)) {
      return fail(
        `Rust worker build refused: the build cache directory (${target}) is inside the analyzed workspace; ` +
          "set CAUSORYN_RUST_TARGET_DIR to a directory outside the workspace",
      );
    }
  }
  const sourceDir = dirname(input.sourceManifestPath);
  const sourceManifest = lstatSync(input.sourceManifestPath, { throwIfNoEntry: false });
  if (sourceManifest === undefined || !sourceManifest.isFile()) {
    return fail(`Rust worker manifest not found: ${input.sourceManifestPath}`);
  }

  let stagingDir: string;
  try {
    const stagingParent = join(input.cacheRoot, "staging");
    mkdirSync(stagingParent, { recursive: true });
    stagingDir = mkdtempSync(join(stagingParent, "build-"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(`Rust worker build staging directory could not be created: ${detail}`);
  }
  const cleanup = (): void => {
    try {
      rmSync(stagingDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // best effort
    }
  };
  if (insideUntrusted(stagingDir, input.untrustedRoots)) {
    cleanup();
    return fail(`Rust worker build refused: the staging directory resolves inside the analyzed workspace (${stagingDir})`);
  }

  try {
    copyRegularFileIfPresent(input.sourceManifestPath, join(stagingDir, "Cargo.toml"));
    copyRegularFileIfPresent(join(sourceDir, "Cargo.lock"), join(stagingDir, "Cargo.lock"));
    copyRegularFileIfPresent(join(sourceDir, "build.rs"), join(stagingDir, "build.rs"));
    copyRegularTree(join(sourceDir, "src"), join(stagingDir, "src"));
  } catch (error) {
    cleanup();
    const detail = error instanceof Error ? error.message : String(error);
    return fail(`Rust worker crate could not be staged for the build: ${detail}`);
  }

  const targetDir = join(stagingDir, "target");
  const build = await runCargoBuild({
    manifestPath: join(stagingDir, "Cargo.toml"),
    targetDir,
    timeoutMs: input.timeoutMs,
    untrustedRoots: input.untrustedRoots,
    ...(input.cargoExecutable !== undefined ? { cargoExecutable: input.cargoExecutable } : {}),
    ...(input.cargoHomeDir !== undefined ? { cargoHomeDir: input.cargoHomeDir } : {}),
    ...(input.outputMaxChars !== undefined ? { outputMaxChars: input.outputMaxChars } : {}),
    ...(input.spawnFn !== undefined ? { spawnFn: input.spawnFn } : {}),
  });
  if (build.status !== 0) {
    cleanup();
    const tail =
      build.spawnError ||
      build.stderr.trim().slice(-300) ||
      build.stdout.trim().slice(-300) ||
      "(no output)";
    return fail(`cargo build failed (exit=${String(build.status ?? "unknown")}): ${tail}`);
  }

  const builtBinary = join(targetDir, "debug", WORKER_BINARY_NAME);
  const built = lstatSync(builtBinary, { throwIfNoEntry: false });
  if (built === undefined || !built.isFile()) {
    cleanup();
    return fail(`cargo build succeeded but the worker binary was not produced: ${builtBinary}`);
  }

  // Copy (never hardlink) into place: write a temporary sibling, then rename.
  const tmpBinary = `${input.destinationBinaryPath}.tmp-${String(process.pid)}-${randomBytes(6).toString("hex")}`;
  try {
    mkdirSync(dirname(input.destinationBinaryPath), { recursive: true });
    copyFileSync(builtBinary, tmpBinary, fsConstants.COPYFILE_EXCL);
    renameSync(tmpBinary, input.destinationBinaryPath);
  } catch (error) {
    rmSync(tmpBinary, { force: true });
    cleanup();
    const detail = error instanceof Error ? error.message : String(error);
    return fail(`freshly built Rust worker binary could not be copied into the cache: ${detail}`);
  }
  cleanup();
  return { ok: true, binaryPath: input.destinationBinaryPath, detail: "" };
}
