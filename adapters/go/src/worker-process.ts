/**
 * Go worker süreç yönetimi — spawn, istek yazma, satır-bazlı framing ve
 * per-request timeout (M1-Go; native/go-worker/PROTOCOL.md v1).
 *
 * Ortak IPC çekirdeği (@causoryn/sidecar-ipc) üzerinden yürütülür:
 * - goWorkerBinaryPath VERİLMİŞSE: [binaryPath, []] — önceden derlenmiş binary.
 * - DEĞİLSE: [goBinaryPath, ["run", "./cmd/worker"]] + cwd=workerDir ve
 *   win32'de onKillChild ile ağaç-kill (torun worker temizliği).
 * Komut her iki modda config sabitidir; kullanıcı girdisi asla komut satırına
 * interpole edilmez (kırmızı çizgi 6).
 */
import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import {
  buildAllowlistedWorkerEnv,
  isFullyQualifiedPath,
  collectUntrustedRoots,
  resolveWindowsSystemExecutable,
  resolveWorkerCommand,
  runLineJsonWorker,
  withSanitizedPath,
  workerUnavailable,
  type WorkerRunOutcome,
} from "@causoryn/sidecar-ipc";
import {
  DEFAULT_RESPONSE_MAX_CHARS,
  WORKER_ENV_ALLOWLIST,
  type SpawnFunction,
} from "./types.js";

export type { WorkerRunOutcome } from "@causoryn/sidecar-ipc";

/**
 * go run modunda (goWorkerBinaryPath boşken) worker, go tool'unun TORUN
 * sürecidir: doğrudan kill yalnızca `go` sürecini öldürür; derlenen analiz
 * worker'ı arka planda kalmasın diye win32'de %SystemRoot%\System32\taskkill.exe
 * (absolute path) + kendi çocuğumuzun sayısal pid'i (/T ağaç, /F zorla)
 * uygulanır (kırmızı çizgi 6).
 */
const GO_ISOLATION_ENV_OVERRIDES = {
  GOTOOLCHAIN: "local",
  GOWORK: "off",
  GOPROXY: "off",
} as const;

function killProcessTree(
  spawnProcess: SpawnFunction,
  closing: ChildProcess,
  env: Readonly<Record<string, string>>,
): void {
  if (process.platform !== "win32") return;
  const pid = closing.pid;
  if (pid === undefined) return;
  // Absolute %SystemRoot%System32	askkill.exe with its own directory as
  // cwd: a bare "taskkill" would be looked up in the cwd first.
  const taskkill = resolveWindowsSystemExecutable("taskkill.exe");
  try {
    const killer = spawnProcess(
      taskkill,
      ["/pid", String(pid), "/T", "/F"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        cwd: dirname(taskkill),
        shell: false,
        windowsHide: true,
      },
    );
    killer.on("error", () => {});
    killer.once("exit", () => {
      killer.removeAllListeners();
    });
  } catch {
    // spawnProcess enjeksiyonları senkron patlayabilir; doğrudan kill uygulanmıştır.
  }
}

export interface RunGoWorkerAnalyzeInput {
  readonly goBinaryPath: string;
  /** Boş değilse önceden derlenmiş binary modu (args boş dizi). */
  readonly goWorkerBinaryPath: string;
  /** go module kökü — SABİT cwd (kullanıcı girdisi değildir). */
  readonly workerDir: string;
  /** Tek analyze isteği (JSON'a serileştirilir; stdin'e tek satır yazılır). */
  readonly requestPayload: unknown;
  readonly requestTimeoutMs: number;
  /** Tek yanıt satırı üst sınırı (char); aşım → kill + fallback. */
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
   * resolve the go executable (the process cwd is always included).
   */
  readonly untrustedRoots?: readonly string[];
}

export function runGoWorkerAnalyze(
  input: RunGoWorkerAnalyzeInput,
): Promise<WorkerRunOutcome> {
  const spawnProcess: SpawnFunction = input.spawnProcess ?? defaultSpawn;
  const isBinaryMode = input.goWorkerBinaryPath.length > 0;
  const args = isBinaryMode
    ? ([] as string[])
    : (["run", "./cmd/worker"] as string[]);
  if (!isFullyQualifiedPath(input.workerDir)) {
    return Promise.resolve(
      workerUnavailable(
        `worker process was not started: the Go worker directory must be absolute (got: ${input.workerDir})`,
      ),
    );
  }
  const untrustedRoots = collectUntrustedRoots(input.untrustedRoots ?? []);
  const env = withSanitizedPath(
    buildAllowlistedWorkerEnv(WORKER_ENV_ALLOWLIST, GO_ISOLATION_ENV_OVERRIDES),
    untrustedRoots,
  );
  let command: string;
  if (isBinaryMode) {
    if (!isFullyQualifiedPath(input.goWorkerBinaryPath)) {
      return Promise.resolve(
        workerUnavailable(
          `worker process was not started: the prebuilt Go worker binary path must be absolute (got: ${input.goWorkerBinaryPath})`,
        ),
      );
    }
    command = input.goWorkerBinaryPath;
  } else {
    // Absolute executable: a bare name would be searched in the cwd first on Windows.
    const resolved = resolveWorkerCommand(input.goBinaryPath, env, untrustedRoots);
    if ("detail" in resolved) {
      return Promise.resolve(workerUnavailable(resolved.detail));
    }
    command = resolved.command;
  }

  return runLineJsonWorker({
    command,
    args,
    env,
    cwd: input.workerDir,
    requestPayload: input.requestPayload,
    requestTimeoutMs: input.requestTimeoutMs,
    responseMaxChars: input.responseMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS,
    stderrMaxChars: input.stderrMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS,
    spawnProcess,
    ...(!isBinaryMode
      ? {
          onKillChild: (closing: ChildProcess) => {
            killProcessTree(spawnProcess, closing, env);
          },
        }
      : {}),
  });
}
