/**
 * Worker süreç yönetimi — spawn, istek yazma, satır-bazlı framing ve
 * per-request timeout (sprint-2 / B2; PROTOCOL.md v1).
 *
 * Ortak IPC çekirdeği (@causoryn/sidecar-ipc) üzerinden yürütülür:
 * - analyze başına YENİ worker süreci (long-lived daemon değil; durum sızıntısı yok).
 * - Allowlist tabanlı minimal child env (WORKER_ENV_ALLOWLIST).
 * - Satır-bazlı NDJSON framing, per-request timeout, responseMaxChars ve
 *   stderrMaxChars bütçeleri, stdin EPIPE yutma.
 *
 * Güvenlik (kırmızı çizgi 6): komut LİTERAL "dotnet" (config override'lı),
 * argümanlar SABİT ["exec", workerDllPath]; istek içeriği yalnızca stdin
 * üzerinden taşınır.
 */
import { dirname } from "node:path";
import {
  buildAllowlistedWorkerEnv,
  runLineJsonWorker,
  type WorkerRunOutcome,
} from "@causoryn/sidecar-ipc";
import {
  DEFAULT_RESPONSE_MAX_CHARS,
  WORKER_ENV_ALLOWLIST,
  type SpawnFunction,
} from "./types.js";

export type { WorkerRunOutcome } from "@causoryn/sidecar-ipc";

export interface RunWorkerAnalyzeInput {
  readonly dotnetCommand: string;
  readonly workerDllPath: string;
  /** Tek analyze isteği (JSON'a serileştirilir; stdin'e tek satır yazılır). */
  readonly requestPayload: unknown;
  readonly requestTimeoutMs: number;
  /**
   * Güvenlik bulgusu 4: birikmiş yanıt buffer'ı için char üst sınırı.
   * Tanımsızsa DEFAULT_RESPONSE_MAX_CHARS (64M — istek bütçesinin aynası).
   */
  readonly responseMaxChars?: number;
  /**
   * Birikmiş stderr için char üst sınırı; tanımsızsa DEFAULT_RESPONSE_MAX_CHARS.
   * Aşım → süreç kill + L0/L1 fallback; saklanan kuyruk baştan bütçeye kırpılır.
   */
  readonly stderrMaxChars?: number;
  /** Test enjeksiyonu; default node:child_process.spawn. */
  readonly spawnProcess?: SpawnFunction;
}

const DOTNET_ISOLATION_ENV_OVERRIDES = {
  DOTNET_STARTUP_HOOKS: "",
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_NOLOGO: "1",
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
} as const;

export function runWorkerAnalyze(
  input: RunWorkerAnalyzeInput,
): Promise<WorkerRunOutcome> {
  return runLineJsonWorker({
    command: input.dotnetCommand,
    args: ["exec", input.workerDllPath],
    env: buildAllowlistedWorkerEnv(
      WORKER_ENV_ALLOWLIST,
      DOTNET_ISOLATION_ENV_OVERRIDES,
    ),
    cwd: dirname(input.workerDllPath),
    requestPayload: input.requestPayload,
    requestTimeoutMs: input.requestTimeoutMs,
    responseMaxChars: input.responseMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS,
    stderrMaxChars: input.stderrMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS,
    ...(input.spawnProcess !== undefined
      ? { spawnProcess: input.spawnProcess }
      : {}),
  });
}
