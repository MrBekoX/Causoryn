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

/**
 * go run modunda (goWorkerBinaryPath boşken) worker, go tool'unun TORUN
 * sürecidir: doğrudan kill yalnızca `go` sürecini öldürür; derlenen analiz
 * worker'ı arka planda kalmasın diye win32'de LİTERAL "taskkill" + kendi
 * çocuğumuzun sayısal pid'i (/T ağaç, /F zorla) uygulanır (kırmızı çizgi 6).
 */
function killProcessTree(
  spawnProcess: SpawnFunction,
  closing: ChildProcess,
): void {
  if (process.platform !== "win32") return;
  const pid = closing.pid;
  if (pid === undefined) return;
  try {
    const killer = spawnProcess(
      "taskkill", // LİTERAL komut — kırmızı çizgi 6
      ["/pid", String(pid), "/T", "/F"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildAllowlistedWorkerEnv(WORKER_ENV_ALLOWLIST),
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
}

export function runGoWorkerAnalyze(
  input: RunGoWorkerAnalyzeInput,
): Promise<WorkerRunOutcome> {
  const spawnProcess: SpawnFunction = input.spawnProcess ?? defaultSpawn;
  const isBinaryMode = input.goWorkerBinaryPath.length > 0;
  const command = isBinaryMode ? input.goWorkerBinaryPath : input.goBinaryPath;
  const args = isBinaryMode
    ? ([] as string[])
    : (["run", "./cmd/worker"] as string[]);

  return runLineJsonWorker({
    command,
    args,
    env: buildAllowlistedWorkerEnv(WORKER_ENV_ALLOWLIST),
    cwd: input.workerDir,
    requestPayload: input.requestPayload,
    requestTimeoutMs: input.requestTimeoutMs,
    responseMaxChars: input.responseMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS,
    stderrMaxChars: input.stderrMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS,
    spawnProcess,
    ...(!isBinaryMode
      ? {
          onKillChild: (closing: ChildProcess) => {
            killProcessTree(spawnProcess, closing);
          },
        }
      : {}),
  });
}
