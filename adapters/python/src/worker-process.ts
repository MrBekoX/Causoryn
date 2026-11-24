/**
 * Worker süreç yönetimi — spawn, istek yazma, satır-bazlı framing ve
 * per-request timeout (M1-Python; native/python-worker/PROTOCOL.md v1).
 *
 * Ortak IPC çekirdeği (@causoryn/sidecar-ipc) üzerinden yürütülür:
 * - analyze başına YENİ worker süreci (long-lived daemon değil).
 * - Allowlist tabanlı minimal child env + sabit PYTHONIOENCODING="utf-8"
 *   override'ı (PYTHONPATH taşınmaz; worker saf stdlib'tir).
 * - Satır-bazlı NDJSON framing, per-request timeout, responseMaxChars ve
 *   stderrMaxChars bütçeleri, stdin EPIPE yutma.
 *
 * Güvenlik (kırmızı çizgi 6): komut LİTERAL "python" (config override'lı),
 * argümanlar SABİT ["-I", "-B", "-X", "utf8", workerScriptPath]; istek içeriği yalnızca stdin
 * üzerinden taşınır.
 */
import { dirname } from "node:path";
import {
  buildAllowlistedWorkerEnv,
  isFullyQualifiedPath,
  collectUntrustedRoots,
  resolveWorkerCommand,
  runLineJsonWorker,
  withSanitizedPath,
  workerUnavailable,
  type WorkerRunOutcome,
} from "@causoryn/sidecar-ipc";
import {
  DEFAULT_RESPONSE_MAX_CHARS,
  WORKER_ENV_ALLOWLIST,
  WORKER_IO_ENCODING,
  type SpawnFunction,
} from "./types.js";

export type { WorkerRunOutcome } from "@causoryn/sidecar-ipc";

export interface RunWorkerAnalyzeInput {
  readonly pythonCommand: string;
  readonly workerScriptPath: string;
  /** Tek analyze isteği (JSON'a serileştirilir; stdin'e tek satır yazılır). */
  readonly requestPayload: unknown;
  readonly requestTimeoutMs: number;
  /** Birikmiş yanıt buffer'ı için char üst sınırı; tanımsızsa 64M. */
  readonly responseMaxChars?: number;
  /**
   * Birikmiş stderr için char üst sınırı; tanımsızsa 64M (yanıt
   * bütçesinin aynası). Aşım → süreç kill + L0/L1 fallback; saklanan
   * kuyruk baştan bütçeye kırpılır.
   */
  readonly stderrMaxChars?: number;
  /** Test enjeksiyonu; default node:child_process.spawn. */
  readonly spawnProcess?: SpawnFunction;
  /**
   * Analyzed workspace root(s): PATH entries inside them are never used to
   * resolve the python executable (the process cwd is always included).
   */
  readonly untrustedRoots?: readonly string[];
}

export function runWorkerAnalyze(
  input: RunWorkerAnalyzeInput,
): Promise<WorkerRunOutcome> {
  if (!isFullyQualifiedPath(input.workerScriptPath)) {
    return Promise.resolve(
      workerUnavailable(
        `worker process was not started: the worker script path must be absolute (got: ${input.workerScriptPath})`,
      ),
    );
  }
  const untrustedRoots = collectUntrustedRoots(input.untrustedRoots ?? []);
  const env = withSanitizedPath(
    buildAllowlistedWorkerEnv(WORKER_ENV_ALLOWLIST, {
      PYTHONIOENCODING: WORKER_IO_ENCODING,
    }),
    untrustedRoots,
  );
  // Absolute executable: a bare name would be searched in the cwd first on Windows.
  const resolved = resolveWorkerCommand(input.pythonCommand, env, untrustedRoots);
  if ("detail" in resolved) {
    return Promise.resolve(workerUnavailable(resolved.detail));
  }
  return runLineJsonWorker({
    command: resolved.command,
    // "-I": isolated mode (ignores PYTHONPATH/PYTHON* env vars and omits cwd & user-site from sys.path)
    // "-B": disable __pycache__ bytecode writes (read-only discipline)
    // "-X utf8": enforce UTF-8 stdio/stderr on Windows even under -I
    args: ["-I", "-B", "-X", "utf8", input.workerScriptPath],
    env,
    cwd: dirname(input.workerScriptPath),
    requestPayload: input.requestPayload,
    requestTimeoutMs: input.requestTimeoutMs,
    responseMaxChars: input.responseMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS,
    stderrMaxChars: input.stderrMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS,
    ...(input.spawnProcess !== undefined
      ? { spawnProcess: input.spawnProcess }
      : {}),
  });
}
