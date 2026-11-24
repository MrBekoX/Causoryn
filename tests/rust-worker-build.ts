/**
 * Rust worker build yardımcısı (tests/ ortak bootstrap altyapısı).
 *
 * tests/roslyn-worker-build.ts örüntüsünün birebir karşılığıdır: vitest
 * test dosyalarını paralel fork'larda koşturur; rust-worker.test.ts ve
 * rust-adapter.test.ts ikisi de aynı `cargo build` çağrısını kendi
 * bootstrap'ında yapar. Eşzamanlı iki cargo koşumu AYNI target/ dizinine
 * yazışır (cargo kendi kilidiyle serileştirir ama bekleyen koşum spawn
 * timeout'una takılabilir) — ortak kilit dosyasıyla serileştirilir.
 *
 * Komut LİTERAL "cargo"dur (kırmızı çizgi 6; adapters/rust/src/cargo.ts
 * disiplini); toolchain konumu child env PATH'ine sabit cargo-home
 * önekiyle verilir — komut değişkeni YOKTUR. İlk derleme crates.io'dan
 * syn 3 + serde_json çeker (dakikalar sürebilir) → timeout 600s.
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildToolEnv,
  CARGO_ENV_ALLOWLIST,
  resolveCargoHomeDir,
} from "../adapters/rust/src/cargo.js";
import {
  computeRustWorkerSourceFingerprint,
  readRegularFileSha256NoFollow,
  rustWorkerIntegrityPath,
} from "../adapters/rust/src/analyzer.js";
import { readFileSync, writeFileSync } from "node:fs";
import {
  WORKER_BINARY_NAME,
  WORKER_DIR_RELATIVE_PATH,
  WORKER_MANIFEST_RELATIVE_PATH,
} from "../adapters/rust/src/types.js";

const HELPER_DIR = dirname(fileURLToPath(import.meta.url));
export const RUST_WORKER_DIR = resolve(HELPER_DIR, "..", WORKER_DIR_RELATIVE_PATH);
export const RUST_WORKER_BINARY_PATH = join(RUST_WORKER_DIR, WORKER_BINARY_NAME);
export const RUST_WORKER_MANIFEST_PATH = resolve(
  HELPER_DIR,
  "..",
  WORKER_MANIFEST_RELATIVE_PATH,
);

/** Build sürecõlar arası kilit dosyası (target/ gitignore kapsamındadır). */
const BUILD_LOCK_PATH = join(RUST_WORKER_DIR, "test-build.lock");

/** Kilit bekleme yoklaması (ms). */
const ACQUIRE_POLL_MS = 100;
/** Kilit için toplam bekleme bütçesi; build timeout ile aynı sınır. */
const ACQUIRE_TIMEOUT_MS = 600_000;
/** Tek build'in üst sınırı (ilk derleme crates.io fetch'i dahil). */
const BUILD_TIMEOUT_MS = 600_000;
/** Bu süreden bayat kilit ölü sahiplere aittir ve çalınır (2x build timeout). */
const STALE_LOCK_MS = 1_200_000;

/** Senkron bağlamda uyku (test bootstrap'ı senkron spawnSync kullanır). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Kiliti açar; başarılı olunca dosya tanıtıcısını döner. Bayat kilit
 * çalınır; bütçe dolarsa açıklayıcı Error fırlatır (suite FAIL — sessiz
 * geçiştirme yok).
 */
function acquireBuildLock(): number {
  mkdirSync(dirname(BUILD_LOCK_PATH), { recursive: true });
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(BUILD_LOCK_PATH, "wx");
      writeSync(fd, String(process.pid));
      return fd;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== "EEXIST") throw error;
    }
    // Kilit mevcut: bayat mı? (ölmüş sahibi engellemesin)
    try {
      const stat = statSync(BUILD_LOCK_PATH);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        unlinkSync(BUILD_LOCK_PATH);
        continue;
      }
    } catch {
      // kilit bu arada silindi; bir sonraki turda wx ile alınır
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `worker build kilidi ${String(ACQUIRE_TIMEOUT_MS / 1000)}s içinde alınamadı: ${BUILD_LOCK_PATH}`,
      );
    }
    sleepSync(ACQUIRE_POLL_MS);
  }
}

/** Kiliti bırakır; yalnızca sahibi çağırır (finally). */
function releaseBuildLock(fd: number): void {
  try {
    closeSync(fd);
  } finally {
    try {
      unlinkSync(BUILD_LOCK_PATH);
    } catch {
      // zaten yok (bayat çalma yarışı) — kilit bırakılmış sayılır
    }
  }
}

export interface WorkerBuildResult {
  /** spawnSync exit kodu; sinyal/saat aşımında null. */
  readonly status: number | null;
  readonly stderr: string;
  /**
   * stdout: cargo derleme hataları (E0432 vb.) STDERR'e yazılır; yine de
   * her iki akış da taşınır — gerçek derleme nedeni gizlenmesin.
   */
  readonly stdout: string;
}

/**
 * Rust worker'ı serileştirilmiş biçimde derler ve sonucu döndürür.
 * Komut LİTERAL "cargo"; argümanlar sabittir: ["build",
 * "--manifest-path", <sabit manifest>]. Çağıran test sonucu KENDİSİ
 * kontrol eder (exit≠0 → FAIL).
 */
export function buildRustWorkerBinary(): WorkerBuildResult {
  const cargoHome = resolveCargoHomeDir();
  const fd = acquireBuildLock();
  try {
    const expectedFingerprint = computeRustWorkerSourceFingerprint(RUST_WORKER_MANIFEST_PATH);
    const metaPath = rustWorkerIntegrityPath(RUST_WORKER_BINARY_PATH);
    if (expectedFingerprint !== null && existsSync(RUST_WORKER_BINARY_PATH) && existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
          sourceFingerprint?: unknown;
          binarySha256?: unknown;
        };
        const currentBinSha = readRegularFileSha256NoFollow(RUST_WORKER_BINARY_PATH);
        if (
          meta.sourceFingerprint === expectedFingerprint &&
          currentBinSha !== null &&
          meta.binarySha256 === currentBinSha
        ) {
          return { status: 0, stderr: "", stdout: "" };
        }
      } catch {
        // Bütünlük meta bozuksa aşağıda temiz derlenir.
      }
    }

    const build = spawnSync(
      "cargo", // LİTERAL komut — kırmızı çizgi 6
      ["build", "--manifest-path", RUST_WORKER_MANIFEST_PATH],
      {
        cwd: dirname(RUST_WORKER_MANIFEST_PATH),
        encoding: "utf8",
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        shell: false,
        windowsHide: true,
        env: buildToolEnv(CARGO_ENV_ALLOWLIST, cargoHome),
      },
    );
    if (build.status === 0 && expectedFingerprint !== null) {
      const builtSha = readRegularFileSha256NoFollow(RUST_WORKER_BINARY_PATH);
      if (builtSha !== null) {
        writeFileSync(
          metaPath,
          JSON.stringify({ sourceFingerprint: expectedFingerprint, binarySha256: builtSha }, null, 2),
          "utf8",
        );
      }
    }
    return {
      status: build.status,
      stderr: typeof build.stderr === "string" ? build.stderr : "",
      stdout: typeof build.stdout === "string" ? build.stdout : "",
    };
  } finally {
    releaseBuildLock(fd);
  }
}

/**
 * Bootstrap disiplini (roslyn-worker.test.ts örüntüsü): cargo mevcutken
 * derleme HER TURDA koşturulur (incremental, ucuz) ve başarısız derleme
 * explicit Error throw eder → suite FAIL — Rust derleme regresyonu sessiz
 * skip/yeşil ile geçiştirilmez. Skip YALNIZCA cargo bulunamadığında
 * meşrudur (koşulamadı raporu).
 */
export function bootstrapRustWorkerBinary(io: {
  cargoAvailable: boolean;
  binaryExists: () => boolean;
  runBuild: () => { status: number | null; stderr?: string; stdout?: string };
}): { workerReady: boolean; skipReason: string | null } {
  if (!io.cargoAvailable) {
    return {
      workerReady: false,
      skipReason:
        "cargo toolchain bulunamadı — Rust worker kabul testleri koşulamadı (çalıştırılamadı olarak raporlanır)",
    };
  }

  const build = io.runBuild();
  if (build.status !== 0) {
    throw new Error(
      `worker derlemesi başarısız (cargo build exit=${String(build.status)})` +
        (build.stderr ? ` [stderr]: ${build.stderr.slice(0, 400)}` : "") +
        (build.stdout ? ` [stdout]: ${build.stdout.slice(-400)}` : "") +
        " — Rust derleme regresyonu sessiz skip ile geçiştirilmez",
    );
  }

  if (!io.binaryExists()) {
    throw new Error(
      "worker derlemesi başarılı bildirildi ama binary çıktısı yok: " +
        RUST_WORKER_BINARY_PATH,
    );
  }

  return { workerReady: true, skipReason: null };
}

/* ------------------------------------------------------------------ */
/* Protokol koşumcu (testler için ham stdio erişimi)                   */
/* ------------------------------------------------------------------ */

/**
 * Test enjeksiyonu imzasi — adapters/rust/src/worker-process.ts ile aynı
 * SpawnFunction şekli (spawn, parametre üzerinden çağrılır; güvenlik
 * incelemesinde kabul görmüş desendir).
 */
export type SpawnProcessFunction = (
  command: string,
  args: readonly string[],
  options: {
    readonly stdio: ["pipe", "pipe", "pipe"];
    readonly env: Readonly<Record<string, string>>;
  },
) => import("node:child_process").ChildProcess;

/** Worker protokol koşumu sonucu — satır bölünmüş stdout + exit kodu. */
export interface WorkerProtocolRunResult {
  readonly lines: string[];
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Rust worker binary'sini başlatır, istekleri TEK KOŞUMDA stdin'e yazar,
 * sürecin ÇIKIŞINA kadar tüm stdout/stderr'i toplar ve satır satır döner.
 * Çok istekli negatif batch'ler (tek spawn'da 10 reddiye + survivor) bu
 * koşumcuyla kanıtlanır — istek başına yeni süreç gerektirmez.
 *
 * Güvenlik: komut, worker-process.ts'te kabul görmüş param-enjeksiyonlu
 * spawnProcess deseninden geçer; binary yolu repo-içi SABİT constant'tır
 * (RUST_WORKER_BINARY_PATH); istek içeriği yalnızca stdin'de taşınır.
 */
export function runWorkerProtocol(input: {
  requests: unknown[];
  timeoutMs?: number;
  spawnProcess?: SpawnProcessFunction;
}): Promise<WorkerProtocolRunResult> {
  const spawnProcess: SpawnProcessFunction =
    input.spawnProcess ?? (spawn as unknown as SpawnProcessFunction);
  const timeoutMs = input.timeoutMs ?? 120_000;

  return new Promise<WorkerProtocolRunResult>((resolveRun) => {
    let settled = false;
    let stdoutText = "";
    let stderrText = "";

    const child = spawnProcess(
      RUST_WORKER_BINARY_PATH,
      [],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildToolEnv(CARGO_ENV_ALLOWLIST, resolveCargoHomeDir()),
      },
    );

    const timer = setTimeout(() => {
      child.kill();
      finishRun({ lines: splitLines(stdoutText), stderr: stderrText, exitCode: -2 });
    }, timeoutMs);

    function finishRun(result: WorkerProtocolRunResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.on("error", () => {});
      resolveRun(result);
    }

    child.on("error", () => {
      finishRun({ lines: [], stderr: stderrText, exitCode: -1 });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutText += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });

    child.on("exit", (code: number | null) => {
      finishRun({ lines: splitLines(stdoutText), stderr: stderrText, exitCode: code ?? -1 });
    });

    child.stdin?.on("error", () => {}); // erken ölümde EPIPE yutulur

    try {
      const payload =
        input.requests.map((request) => JSON.stringify(request)).join("\n") +
        "\n";
      child.stdin?.write(payload);
      child.stdin?.end();
    } catch {
      finishRun({ lines: [], stderr: stderrText, exitCode: -1 });
    }
  });
}

function splitLines(stdoutText: string): string[] {
  return stdoutText
    .split("\n")
    .filter((line) => line.trim().length > 0);
}
