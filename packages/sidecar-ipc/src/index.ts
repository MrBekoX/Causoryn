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
 */
import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

/** Tek yanıt satırı ve stderr birikimi için varsayılan karakter bütçesi (64 MiB). */
export const DEFAULT_RESPONSE_MAX_CHARS = 64 * 1024 * 1024;

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
  /** Çalışmakta olan çocuk süreç sonlandırılırken çağrılan ek temizlik kancası. */
  readonly onKillChild?: (child: ChildProcess) => void;
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

/**
 * Tek satır JSON istek/yanıt protokolüyle çalışan sidecar worker sürecini
 * başlatır, bütçe ve zaman aşımı sınırlarıyla izler ve ilk geçerli JSON
 * satırında sonlandırır.
 */
export function runLineJsonWorker(
  input: RunLineJsonWorkerInput,
): Promise<WorkerRunOutcome> {
  if (
    input.cwd !== undefined &&
    (input.cwd.trim().length === 0 || input.cwd.includes("\0"))
  ) {
    return Promise.resolve({
      status: "unavailable",
      response: null,
      stderr: "",
      detail: "worker süreci başlatılamadı: geçersiz veya boş cwd",
    });
  }

  const spawnProcess: SidecarSpawnFunction = input.spawnProcess ?? defaultSpawn;
  const responseMaxChars = input.responseMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS;
  const stderrMaxChars = input.stderrMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS;

  return new Promise<WorkerRunOutcome>((resolveOutcome) => {
    let settled = false;
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
      if (
        closing !== null &&
        !alreadyExited &&
        !closing.killed &&
        closing.exitCode === null &&
        closing.signalCode === null
      ) {
        closing.kill();
        input.onKillChild?.(closing);
      }
      closing?.removeAllListeners();
      closing?.stdout?.removeAllListeners();
      closing?.stderr?.removeAllListeners();
      closing?.on("error", () => {});
      resolveOutcome(outcome);
    };

    const spawnOptions: SidecarSpawnOptions =
      input.cwd !== undefined
        ? {
            stdio: ["pipe", "pipe", "pipe"],
            env: input.env,
            cwd: input.cwd,
            shell: false,
            windowsHide: true,
          }
        : {
            stdio: ["pipe", "pipe", "pipe"],
            env: input.env,
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
        detail: `worker süreci başlatılamadı: ${detail}`,
      });
      return;
    }

    const timer = setTimeout(() => {
      finish(
        {
          status: "timeout",
          response: null,
          stderr: stderrText,
          detail: `worker ${String(input.requestTimeoutMs)} ms içinde yanıt vermedi (zaman aşımı); süreç sonlandırıldı — sonraki istek taze süreçle yürütülür`,
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
          detail: `worker süreci başlatılamadı: ${detail}`,
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
            detail: `worker stderr çıktısı ${String(stderrMaxChars)} karakter sınırını aştı; süreç sonlandırıldı — sonraki istek taze süreçle ve L0/L1 fallback ile yürütülür`,
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
            detail: `worker yanıt satırı ${String(responseMaxChars)} karakter sınırını aştı; süreç sonlandırıldı — sonraki istek taze süreçle ve L0/L1 fallback ile yürütülür`,
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
              detail: `worker yanıtı geçerli JSON değil: ${detail}`,
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

    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      finish(
        {
          status: "unavailable",
          response: null,
          stderr: stderrText,
          detail:
            signal !== null
              ? `worker sinyal ile sonlandı (${signal})`
              : `worker çıktı (exit=${String(code ?? "bilinmiyor")}); stderr: ${stderrText.slice(0, 200).trim() || "(boş)"}`,
        },
        child,
        true,
      );
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
          detail: `istek worker'a yazılamadı: ${detail}`,
        },
        child,
      );
    }
  });
}
