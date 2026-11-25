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
 * Security (red line 6): the command is the configured Python command or the
 * first default candidate found on PATH (see resolvePythonWorkerCommand),
 * always resolved to an absolute path; the arguments are fixed
 * ["-I", "-B", "-X", "utf8", workerScriptPath]; request content only travels
 * over stdin.
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
  DEFAULT_PYTHON_COMMAND,
  DEFAULT_RESPONSE_MAX_CHARS,
  WORKER_ENV_ALLOWLIST,
  WORKER_IO_ENCODING,
  defaultPythonCommandCandidates,
  type SpawnFunction,
} from "./types.js";

export type { WorkerRunOutcome } from "@causoryn/sidecar-ipc";

type CommandResolution = { readonly command: string } | { readonly detail: string };

/**
 * Picks the Python executable. An explicit command is resolved as-is (no other
 * candidate is tried). DEFAULT_PYTHON_COMMAND tries the default candidates of
 * `platform` in order (POSIX: python3, then python; win32: python) and uses
 * the first one `resolveCommand` finds.
 */
export function resolvePythonWorkerCommand(
  pythonCommand: string,
  resolveCommand: (command: string) => CommandResolution,
  platform: NodeJS.Platform = process.platform,
): CommandResolution {
  if (pythonCommand !== DEFAULT_PYTHON_COMMAND) {
    return resolveCommand(pythonCommand);
  }
  const candidates = defaultPythonCommandCandidates(platform);
  for (const candidate of candidates) {
    const resolved = resolveCommand(candidate);
    if ("command" in resolved) return resolved;
  }
  return {
    detail: `worker process was not started: none of the default Python commands (${candidates.join(", ")}) was found on PATH outside the analyzed workspace`,
  };
}

export interface RunWorkerAnalyzeInput {
  /** Explicit Python command, used as-is; omitted or DEFAULT_PYTHON_COMMAND selects the default candidates. */
  readonly pythonCommand?: string;
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
  const resolved = resolvePythonWorkerCommand(
    input.pythonCommand ?? DEFAULT_PYTHON_COMMAND,
    (command) => resolveWorkerCommand(command, env, untrustedRoots),
  );
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
