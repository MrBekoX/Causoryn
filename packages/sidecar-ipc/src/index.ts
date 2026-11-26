/**
 * @causoryn/sidecar-ipc — ortak sidecar worker süreç IPC çekirdeği
 * (TŞ v2.1 §7 adapter izolasyonu, §9 resource budget).
 *
 * Dört dilin sidecar adapter'larının (csharp-roslyn, python, go, rust)
 * paylaştığı süreç yönetimi disiplini:
 * - analyze başına taze süreç (long-lived daemon değil; durum sızıntısı yok).
 * - Allowlist tabanlı minimal child env + deterministik override desteği.
 * - Satır-bazlı NDJSON stdout framing (kısmi parça biriktirme, boş satır atlama,
 *   ilk tam JSON satırında çözümleme).
 * - Per-request timeout + responseMaxChars + stderrMaxChars karakter bütçeleri.
 * - stdin EPIPE yutma (erken çöken worker motoru düşürmez) ve onKillChild
 *   kancası (örn. Go `go run` modunda ağaç-kill).
 * - Per-thread registry of the running sidecar processes with their
 *   tree-kill hooks (registerSidecarProcess / terminateSidecarProcesses /
 *   onSidecarProcessEvent), so a thread can stop all of them at once and
 *   report their pids.
 */
import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  isFullyQualifiedPath,
  resolveExecutable,
  sanitizePathValue,
  withoutCwdExecutableSearch,
} from "./executable.js";

export {
  collectUntrustedRoots,
  isFullyQualifiedPath,
  isWithinUntrustedRoots,
  processCwdUntrustedRoot,
  readPathVariable,
  resolveExecutable,
  resolveWindowsSystemExecutable,
  sanitizePathValue,
  trustedSearchDirectories,
  trustedWorkingDirectory,
  withoutCwdExecutableSearch,
  type ExecutableSearchEnv,
  type ResolveExecutableOptions,
} from "./executable.js";

/** Tek yanıt satırı ve stderr birikimi için varsayılan karakter bütçesi (64 MiB). */
export const DEFAULT_RESPONSE_MAX_CHARS = 64 * 1024 * 1024;

/**
 * How long a tree-kill hook may run before the direct kill is applied anyway
 * (a hung `taskkill` must not leave the worker running).
 */
export const DEFAULT_KILL_FALLBACK_MS = 5_000;

/** Time stdout gets to drain after 'exit' when 'close' does not follow. */
export const EXIT_DRAIN_GRACE_MS = 1_000;

/**
 * Tree-kill hook: terminates the child's whole process tree (e.g. Windows
 * `taskkill /T /F`). It may return a promise that settles once the tree
 * kill has finished.
 */
export type ProcessTreeKill = (child: ChildProcess) => void | PromiseLike<void>;

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Terminates a running child process. Without a tree-kill hook the child is
 * killed directly. With a hook, the hook runs FIRST and the direct kill only
 * follows once the hook has settled (or after `fallbackMs`, or right away
 * when the hook throws or returns nothing): killing the parent first would
 * leave its own children without a live parent, and `taskkill /T` can then
 * no longer find them. Never throws.
 */
export function terminateChildProcess(
  child: ChildProcess,
  treeKill?: ProcessTreeKill,
  fallbackMs: number = DEFAULT_KILL_FALLBACK_MS,
): void {
  const directKill = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill();
    } catch {
      // The process is already gone or cannot be signalled.
    }
  };
  if (treeKill === undefined) {
    directKill();
    return;
  }
  let pending: void | PromiseLike<void>;
  try {
    pending = treeKill(child);
  } catch {
    directKill();
    return;
  }
  if (!isPromiseLike(pending)) {
    directKill();
    return;
  }
  let settled = false;
  const afterTreeKill = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(fallbackTimer);
    directKill();
  };
  // Both callbacks run asynchronously, after fallbackTimer is initialized.
  const fallbackTimer = setTimeout(afterTreeKill, fallbackMs);
  fallbackTimer.unref();
  Promise.resolve(pending).then(afterTreeKill, afterTreeKill);
}

/* ------------------------------------------------------------------ */
/* Running sidecar processes of this thread                            */
/* ------------------------------------------------------------------ */

/** A sidecar process of this thread was started, or has exited. */
export interface SidecarProcessEvent {
  readonly type: "spawned" | "exited";
  readonly pid: number;
}

export type SidecarProcessListener = (event: SidecarProcessEvent) => void;

interface RegisteredSidecarProcess {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly treeKill: ProcessTreeKill | undefined;
  readonly killFallbackMs: number;
  readonly exited: Promise<void>;
  readonly markExited: () => void;
}

/**
 * Sidecar processes started on this thread that have not exited yet (module
 * state, so one registry per thread: a worker thread has its own).
 */
const runningSidecarProcesses = new Map<ChildProcess, RegisteredSidecarProcess>();
const sidecarProcessListeners = new Set<SidecarProcessListener>();

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function notifySidecarProcessListeners(event: SidecarProcessEvent): void {
  for (const listener of [...sidecarProcessListeners]) {
    try {
      listener(event);
    } catch {
      // A listener never breaks process management.
    }
  }
}

/**
 * Records a started sidecar process together with the tree-kill hook its
 * runner terminates it with, so terminateSidecarProcesses can stop it the
 * same way and the thread's listeners learn its pid. It is forgotten once it
 * exits. A runner that removes all listeners of `child` (for example after its
 * answer) calls watchSidecarProcessExit again. A child without a pid (its
 * spawn failed) is not recorded. Never throws.
 */
export function registerSidecarProcess(
  child: ChildProcess,
  treeKill?: ProcessTreeKill,
  killFallbackMs: number = DEFAULT_KILL_FALLBACK_MS,
): void {
  try {
    const pid = child.pid;
    if (pid === undefined || runningSidecarProcesses.has(child) || hasChildExited(child)) return;
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      markExited = (): void => {
        if (runningSidecarProcesses.get(child)?.pid !== pid) return;
        runningSidecarProcesses.delete(child);
        resolve();
        notifySidecarProcessListeners({ type: "exited", pid });
      };
    });
    runningSidecarProcesses.set(child, { child, pid, treeKill, killFallbackMs, exited, markExited });
    notifySidecarProcessListeners({ type: "spawned", pid });
    watchSidecarProcessExit(child);
  } catch {
    // An unusual child object (a test double) is simply not recorded.
  }
}

/**
 * (Re)attaches the registry's exit listener to a recorded sidecar process: a
 * runner calls it after `removeAllListeners()` on the child. Never throws.
 */
export function watchSidecarProcessExit(child: ChildProcess): void {
  const entry = runningSidecarProcesses.get(child);
  if (entry === undefined) return;
  try {
    if (hasChildExited(child)) {
      entry.markExited();
      return;
    }
    child.once("exit", entry.markExited);
  } catch {
    // An unusual child object (a test double) is simply not watched.
  }
}

/** Subscribes to this thread's sidecar process events; returns the unsubscribe function. */
export function onSidecarProcessEvent(listener: SidecarProcessListener): () => void {
  sidecarProcessListeners.add(listener);
  return () => {
    sidecarProcessListeners.delete(listener);
  };
}

/** Pids of the sidecar processes of this thread that have not exited yet. */
export function runningSidecarProcessIds(): number[] {
  return [...runningSidecarProcesses.values()].map((entry) => entry.pid);
}

/**
 * Terminates every running sidecar process of this thread with the tree-kill
 * hook its runner registered (terminateChildProcess: the hook first, then the
 * direct kill) and resolves once all of them have exited, or after `waitMs`.
 * Never rejects.
 */
export function terminateSidecarProcesses(waitMs: number): Promise<void> {
  const entries = [...runningSidecarProcesses.values()];
  if (entries.length === 0) return Promise.resolve();
  for (const entry of entries) {
    terminateChildProcess(entry.child, entry.treeKill, entry.killFallbackMs);
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    void Promise.all(entries.map((entry) => entry.exited)).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Worker spawn seçenekleri; shell her zaman kapalıdır, cwd yalnızca tanımlıyken eklenir. */
export interface SidecarSpawnOptions {
  readonly stdio: ["pipe", "pipe", "pipe"];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly shell: false;
  readonly windowsHide: true;
}

/** Sidecar worker süreç başlatıcı imzası (test enjeksiyonu uyumlu). */
export type SidecarSpawnFunction = (
  command: string,
  args: readonly string[],
  options: SidecarSpawnOptions,
) => ChildProcess;

/** Worker koşum sonucu — tüm sidecar adapter'ların ortak dönüş sözleşmesi. */
export interface WorkerRunOutcome {
  /** ok = geçerli ilk satır alındı; unavailable = başlatılamadı/çöktü; timeout = yanıt süresi aşıldı. */
  readonly status: "ok" | "unavailable" | "timeout";
  /** status=ok iken ilk satırın JSON parse edilmiş hâli; değilse null. */
  readonly response: unknown;
  /** Sürecin stderr çıktısı (bütçe dahilinde; fallback warning'lerine kaynak olur). */
  readonly stderr: string;
  /** İnsan-okur sebep — result.warnings içine aynen yazılır. */
  readonly detail: string;
}

export interface RunLineJsonWorkerInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Tek analyze isteği (JSON'a serileştirilir; stdin'e tek satır yazılır). */
  readonly requestPayload: unknown;
  readonly requestTimeoutMs: number;
  /** Birikmiş yanıt satırı için char üst sınırı; tanımsızsa 64 MiB. */
  readonly responseMaxChars?: number;
  /** Birikmiş stderr için char üst sınırı; tanımsızsa 64 MiB. */
  readonly stderrMaxChars?: number;
  /** Test enjeksiyonu; default node:child_process.spawn. */
  readonly spawnProcess?: SidecarSpawnFunction;
  /**
   * Tree-kill hook used when a still-running child is terminated; it runs
   * before the direct kill (see terminateChildProcess).
   */
  readonly onKillChild?: ProcessTreeKill;
  /** Delay before the direct kill when onKillChild has not settled; default DEFAULT_KILL_FALLBACK_MS. */
  readonly killFallbackMs?: number;
}

export interface ResolveCausorynAssetRootOptions {
  readonly maxWalkDepth?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Sidecar worker kaynaklarının kök dizinini (`native/` ağacını barındıran
 * dizin) hem monorepo düzeninde (derinlik 3) hem de paketlenmiş tek-dosya
 * bundle düzeninde (derinlik 1) çözümler.
 */
export function resolveCausorynAssetRoot(
  importMetaUrl: string,
  options?: ResolveCausorynAssetRootOptions,
): string {
  const env = options?.env ?? process.env;
  const envOverride = env["CAUSORYN_ASSET_ROOT"];
  if (envOverride !== undefined && envOverride.trim().length > 0) {
    return path.resolve(envOverride.trim());
  }

  const startDir = path.dirname(fileURLToPath(importMetaUrl));
  const maxWalkDepth = options?.maxWalkDepth ?? 4;
  let dir = startDir;
  for (let depth = 0; depth <= maxWalkDepth; depth += 1) {
    if (existsSync(path.join(dir, "native", "python-worker", "worker.py"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return path.dirname(path.dirname(path.dirname(startDir)));
}

/**
 * Worker alt sürecine geçilecek minimum ortamı kurar: yalnızca allowlist'teki
 * boş-olmayan parent değişkenleri kopyalanır (gizli anahtar/token sızmaz);
 * varsa overrides değerleri üstüne koşulsuz uygulanır.
 */
export function buildAllowlistedWorkerEnv(
  allowlist: readonly string[],
  overrides?: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined && value.length > 0) {
      env[key] = value;
    }
  }
  if (overrides !== undefined) {
    for (const [key, value] of Object.entries(overrides)) {
      env[key] = value;
    }
  }
  return env;
}

/** `unavailable` outcome without starting a process. */
export function workerUnavailable(detail: string): WorkerRunOutcome {
  return { status: "unavailable", response: null, stderr: "", detail };
}

/**
 * Returns `env` with its PATH sanitized (empty, relative and untrusted-root
 * entries removed) so tools started by the worker cannot be picked up from
 * the analyzed workspace either.
 */
export function withSanitizedPath(
  env: Readonly<Record<string, string>>,
  untrustedRoots: readonly string[],
): Record<string, string> {
  const next: Record<string, string> = { ...env };
  for (const key of Object.keys(next)) {
    if (key.toUpperCase() !== "PATH") continue;
    const sanitized = sanitizePathValue(next[key] ?? "", untrustedRoots);
    if (sanitized.length > 0) next[key] = sanitized;
    else delete next[key];
  }
  return next;
}

/**
 * Resolves a configured worker command to an absolute executable using the
 * child's PATH (never the cwd, never an untrusted-root PATH entry).
 */
export function resolveWorkerCommand(
  command: string,
  env: Readonly<Record<string, string>>,
  untrustedRoots: readonly string[],
): { readonly command: string } | { readonly detail: string } {
  const resolved = resolveExecutable(command, { env, untrustedRoots });
  if (resolved === null) {
    return {
      detail: `worker process was not started: executable "${command}" was not found on PATH outside the analyzed workspace (relative paths are not accepted)`,
    };
  }
  return { command: resolved };
}

/**
 * Tek satır JSON istek/yanıt protokolüyle çalışan sidecar worker sürecini
 * başlatır, bütçe ve zaman aşımı sınırlarıyla izler ve ilk geçerli JSON
 * satırında sonlandırır.
 */
export function runLineJsonWorker(
  input: RunLineJsonWorkerInput,
): Promise<WorkerRunOutcome> {
  // Bare or relative command names are refused: on Windows they are looked
  // up in the child cwd before PATH. Callers resolve tools with
  // resolveExecutable() first.
  if (!isFullyQualifiedPath(input.command)) {
    return Promise.resolve({
      status: "unavailable",
      response: null,
      stderr: "",
      detail: `worker process was not started: the command must be an absolute path (got: ${input.command})`,
    });
  }
  if (
    input.cwd !== undefined &&
    (input.cwd.trim().length === 0 || input.cwd.includes("\0"))
  ) {
    return Promise.resolve({
      status: "unavailable",
      response: null,
      stderr: "",
      detail: "worker process could not be started: invalid or empty cwd",
    });
  }

  const spawnProcess: SidecarSpawnFunction = input.spawnProcess ?? defaultSpawn;
  const responseMaxChars = input.responseMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS;
  const stderrMaxChars = input.stderrMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS;

  return new Promise<WorkerRunOutcome>((resolveOutcome) => {
    let settled = false;
    let exitDrainTimer: ReturnType<typeof setTimeout> | undefined;
    let stderrText = "";
    let buffer = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const finish = (
      outcome: WorkerRunOutcome,
      closing: ChildProcess | null,
      alreadyExited = false,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitDrainTimer !== undefined) clearTimeout(exitDrainTimer);
      if (
        closing !== null &&
        !alreadyExited &&
        !closing.killed &&
        closing.exitCode === null &&
        closing.signalCode === null
      ) {
        terminateChildProcess(closing, input.onKillChild, input.killFallbackMs);
      }
      closing?.removeAllListeners();
      closing?.stdout?.removeAllListeners();
      closing?.stderr?.removeAllListeners();
      closing?.on("error", () => {});
      // The registry keeps tracking the process until it has really exited.
      if (closing !== null) watchSidecarProcessExit(closing);
      resolveOutcome(outcome);
    };

    const childEnv = withoutCwdExecutableSearch(input.env);
    const spawnOptions: SidecarSpawnOptions =
      input.cwd !== undefined
        ? {
            stdio: ["pipe", "pipe", "pipe"],
            env: childEnv,
            cwd: input.cwd,
            shell: false,
            windowsHide: true,
          }
        : {
            stdio: ["pipe", "pipe", "pipe"],
            env: childEnv,
            shell: false,
            windowsHide: true,
          };

    let child: ChildProcess;
    try {
      child = spawnProcess(input.command, input.args, spawnOptions);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      resolveOutcome({
        status: "unavailable",
        response: null,
        stderr: "",
        detail: `worker process could not be started: ${detail}`,
      });
      return;
    }
    registerSidecarProcess(child, input.onKillChild, input.killFallbackMs);

    const timer = setTimeout(() => {
      finish(
        {
          status: "timeout",
          response: null,
          stderr: stderrText,
          detail: `worker did not respond within ${String(input.requestTimeoutMs)} ms (timeout); the process was terminated and the next request uses a fresh process`,
        },
        child,
      );
    }, input.requestTimeoutMs);

    child.on("error", (error: Error) => {
      const detail = error instanceof Error ? error.message : String(error);
      finish(
        {
          status: "unavailable",
          response: null,
          stderr: stderrText,
          detail: `worker process could not be started: ${detail}`,
        },
        child,
      );
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const incoming = stderrDecoder.write(chunk);
      if (stderrText.length + incoming.length > stderrMaxChars) {
        stderrText = (stderrText + incoming).slice(0, stderrMaxChars);
        finish(
          {
            status: "unavailable",
            response: null,
            stderr: stderrText,
            detail: `worker stderr output exceeded the ${String(stderrMaxChars)} character limit; the process was terminated and the next request uses a fresh process with L0/L1 fallback`,
          },
          child,
        );
        return;
      }
      stderrText += incoming;
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      const incoming = stdoutDecoder.write(chunk);
      if (buffer.length + incoming.length > responseMaxChars) {
        finish(
          {
            status: "unavailable",
            response: null,
            stderr: stderrText,
            detail: `worker response line exceeded the ${String(responseMaxChars)} character limit; the process was terminated and the next request uses a fresh process with L0/L1 fallback`,
          },
          child,
        );
        return;
      }

      buffer += incoming;
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) return;

        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length === 0) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          finish(
            {
              status: "unavailable",
              response: null,
              stderr: stderrText,
              detail: `worker response is not valid JSON: ${detail}`,
            },
            child,
          );
          return;
        }

        finish(
          {
            status: "ok",
            response: parsed,
            stderr: stderrText,
            detail: "",
          },
          child,
        );
        return;
      }
    });

    // 'exit' can fire before the last stdout chunk has been read: a worker that
    // answers, then sees EOF on stdin and exits 0 would otherwise lose its
    // response. The early-exit outcome is therefore reported on 'close' (all
    // stdio delivered), or EXIT_DRAIN_GRACE_MS after 'exit' when 'close' does
    // not follow (for example a grandchild still holds the pipe).
    const reportExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(
        {
          status: "unavailable",
          response: null,
          stderr: stderrText,
          detail:
            signal !== null
              ? `worker terminated by signal (${signal})`
              : `worker exited (exit=${String(code ?? "unknown")}); stderr: ${stderrText.slice(0, 200).trim() || "(empty)"}`,
        },
        child,
        true,
      );
    };
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      exitDrainTimer = setTimeout(() => reportExit(code, signal), EXIT_DRAIN_GRACE_MS);
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      reportExit(code, signal);
    });

    child.stdin?.on("error", () => {});

    try {
      child.stdin?.write(JSON.stringify(input.requestPayload) + "\n");
      child.stdin?.end();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      finish(
        {
          status: "unavailable",
          response: null,
          stderr: stderrText,
          detail: `request could not be written to the worker: ${detail}`,
        },
        child,
      );
    }
  });
}
