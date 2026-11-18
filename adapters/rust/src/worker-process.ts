/**
 * Worker süreç yönetimi — spawn, istek yazma, satır-bazlı framing ve
 * per-request timeout (M1-Rust; native/rust-worker PROTOCOL.md v1).
 *
 * Ortak IPC çekirdeği (@causoryn/sidecar-ipc) üzerinden yürütülür:
 * - Spawn öncesi binary adı ve dizin güvenlik filtresinden (isSafeCommandPath)
 *   geçirilir; aksi halde süreç başlatılmaz.
 * - Allowlist tabanlı minimal child env + workerDir PATH öneklemesi.
 * - Satır-bazlı NDJSON framing, per-request timeout, responseMaxChars ve
 *   stderrMaxChars bütçeleri, stdin EPIPE yutma.
 *
 * Güvenlik (kırmızı çizgi 6): komut LİTERAL "causoryn-rust-worker" binary
 * adıdır; tam yolu options.workerDir sabit repo-içi yoldan türetilir ve
 * CHILD env PATH'ine ÖNEKLENİR. Argümanlar boş sabit dizidir; istek içeriği
 * yalnızca stdin üzerinden taşınır.
 */
import { delimiter as pathDelimiter } from "node:path";
import {
  buildAllowlistedWorkerEnv,
  runLineJsonWorker,
  type WorkerRunOutcome,
} from "@causoryn/sidecar-ipc";
import { isSafeCommandPath, WORKER_ENV_ALLOWLIST } from "./cargo.js";
import { DEFAULT_RESPONSE_MAX_CHARS, type SpawnFunction } from "./types.js";

export type { WorkerRunOutcome } from "@causoryn/sidecar-ipc";

function isSafeBinaryPath(value: string): boolean {
  return isSafeCommandPath(value);
}

/**
 * Worker alt sürecine geçilecek minimum ortamı kurar: allowlist'teki
 * parent değişkenleri taşınır; PATH'in başına worker binary dizini
 * ÖNEKLENİR (literal binary adı bu dizinden çözümlensin diye).
 */
function buildWorkerEnv(workerDir: string): Record<string, string> {
  const baseEnv = buildAllowlistedWorkerEnv(WORKER_ENV_ALLOWLIST);
  const currentPath = baseEnv["PATH"] ?? "";
  return buildAllowlistedWorkerEnv(WORKER_ENV_ALLOWLIST, {
    PATH: workerDir + pathDelimiter + currentPath,
  });
}

export interface RunWorkerAnalyzeInput {
  /**
   * Worker binary dizini (SABİT repo-içi yol: native/rust-worker/target/
   * debug). Komut, bu dizinden çözümlenen LİTERAL binary adıdır.
   */
  readonly workerDir: string;
  /**
   * LİTERAL worker binary adı (platforma göre "causoryn-rust-worker.exe"
   * / "causoryn-rust-worker"). Sabit constant'tır; config override'ı
   * workerDir üzerinden yapılır.
   */
  readonly workerBinaryName: string;
  /** Tek analyze isteği (JSON'a serileştirilir; stdin'e tek satır yazılır). */
  readonly requestPayload: unknown;
  readonly requestTimeoutMs: number;
  /**
   * Birikmiş yanıt buffer'ı için char üst sınırı. Tanımsızsa
   * DEFAULT_RESPONSE_MAX_CHARS (64M — istek bütçesinin aynası).
   */
  readonly responseMaxChars?: number;
  /**
   * Birikmiş stderr için char üst sınırı; tanımsızsa 64M (yanıt
   * bütçesinin aynası). Aşım → süreç kill + L0/L1 fallback; saklanan
   * kuyruk baştan bütçeye kırpılır.
   */
  readonly stderrMaxChars?: number;
  /** Test enjeksiyonu; default node:child_process.spawn. */
  readonly spawnProcess?: SpawnFunction;
}

export type RunRustWorkerAnalyzeInput = RunWorkerAnalyzeInput;

export function runWorkerAnalyze(
  input: RunWorkerAnalyzeInput,
): Promise<WorkerRunOutcome> {
  // Savunma: binary adı ve dizin güvenlik filtresinden geçmeli; aksi
  // halde süreç hiç başlatılmaz (statik güvenlik bulgusu savunma katmanı).
  if (
    !isSafeBinaryPath(input.workerBinaryName) ||
    !isSafeBinaryPath(input.workerDir)
  ) {
    return Promise.resolve({
      status: "unavailable",
      response: null,
      stderr: "",
      detail: "geçersiz worker binary yolu (güvenlik filtresi reddetti)",
    });
  }

  return runLineJsonWorker({
    command: input.workerBinaryName,
    args: [],
    env: buildWorkerEnv(input.workerDir),
    requestPayload: input.requestPayload,
    requestTimeoutMs: input.requestTimeoutMs,
    responseMaxChars: input.responseMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS,
    stderrMaxChars: input.stderrMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS,
    ...(input.spawnProcess !== undefined
      ? { spawnProcess: input.spawnProcess }
      : {}),
  });
}

export const runRustWorkerAnalyze = runWorkerAnalyze;
