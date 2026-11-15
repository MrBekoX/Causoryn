/**
 * Go worker süreç yönetimi — spawn, istek yazma, satır-bazlı framing ve
 * per-request timeout (M1-Go; native/go-worker/PROTOCOL.md v1).
 *
 * Süreç yaşam döngüsü kararı: adapter, analyze başına YENİ bir worker
 * süreci başlatır (long-lived daemon değil; Roslyn worker deseni ile aynı
 * gerekçeler — timeout/çökme durumunda paylaşılan durum yok, "restart"
 * = bir sonraki istekte taze süreç).
 *
 * Spawn kararı (PROTOCOL.md ve README'de belgeli):
 * - goWorkerBinaryPath VERİLMİŞSE: [binaryPath, []] — önceden derlenmiş
 *   binary (release/paketli kurulum; derleme kanıtı test bootstrap'ında).
 * - DEĞİLSE: [goBinaryPath, ["run", "./cmd/worker"]] + cwd=workerDir —
 *   `go run` her koşumda derler; GOCACHE ısındıktan sonra saniyeler içinde
 *   döner ve derleme hatası stderr'de açıkça görülür (unavailable fallback
 *   gerekçesine yazılır).
 * Komut her iki modda config sabitidir; kullanıcı girdisi asla komut
 * satırına interpole edilmez (kırmızı çizgi 6).
 *
 * Framing: stdout parça-parça gelir; satır buffer'ında birleştirilir,
 * "\n" görülen kadarı satır sayılır, KALAN kısmi satır buffer'da korunur.
 * Newline hiç gelmezse buffer asla yanıt sayılmaz → timeout devreye girer
 * → süreç kill edilir (Roslyn worker-process.ts ile birebir desen).
 */
import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import {
  DEFAULT_RESPONSE_MAX_CHARS,
  WORKER_ENV_ALLOWLIST,
  type SpawnFunction,
} from "./types.js";

/**
 * Worker alt sürecine geçilecek minimum ortamı kurar: yalnızca
 * WORKER_ENV_ALLOWLIST'teki parent değişkenleri taşınır (güvenlik bulgusu 1).
 */
function buildWorkerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of WORKER_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

/** Worker koşum sonucu — analyzer katmanı buna göre fallback kararır. */
export interface WorkerRunOutcome {
  /** ok = geçerli ilk satır alındı; unavailable = başlatılamadı/çöktü; timeout = yanıt süresi aşıldı. */
  readonly status: "ok" | "unavailable" | "timeout";
  /** status=ok iken ilk satırın JSON parse edilmiş hâli; değilse null. */
  readonly response: unknown;
  /** Sürecin stderr çıktısı (tümü; fallback warning'lerine kaynak olur). */
  readonly stderr: string;
  /** İnsan-okur sebep — result.warnings içine aynen yazılır. */
  readonly detail: string;
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
  /** Test enjeksiyonu; default node:child_process.spawn. */
  readonly spawnProcess?: SpawnFunction;
}

export function runGoWorkerAnalyze(
  input: RunGoWorkerAnalyzeInput,
): Promise<WorkerRunOutcome> {
  const spawnProcess: SpawnFunction = input.spawnProcess ?? defaultSpawn;

  return new Promise<WorkerRunOutcome>((resolveOutcome) => {
    let settled = false;
    let stderrText = "";
    let buffer = "";

    const finish = (outcome: WorkerRunOutcome, closing: ChildProcess | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (
        closing !== null &&
        !closing.killed &&
        closing.exitCode === null &&
        closing.signalCode === null
      ) {
        closing.kill();
      }
      closing?.removeAllListeners();
      closing?.stdout?.removeAllListeners();
      closing?.stderr?.removeAllListeners();
      closing?.on("error", () => {}); // temizlik sonrası hata olayları yutulur
      resolveOutcome(outcome);
    };

    // Spawn kararı: binary modu ya da `go run` (argümanlar SABİT dizi).
    const command =
      input.goWorkerBinaryPath.length > 0 ? input.goWorkerBinaryPath : input.goBinaryPath;
    const args =
      input.goWorkerBinaryPath.length > 0
        ? ([] as string[])
        : (["run", "./cmd/worker"] as string[]);

    let child: ChildProcess;
    try {
      child = spawnProcess(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildWorkerEnv(),
        cwd: input.workerDir,
      });
    } catch (error) {
      // spawnProcess enjeksiyonları senkron patlayabilir.
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
      stderrText += chunk.toString("utf8");
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      // Yanıt buffer bütçesi: aşım → süreç kill + L0/L1 fallback
      // (sınırsız buffer + sınırsız JSON.parse yerine; güvenlik bulgusu 4).
      const incoming = chunk.toString("utf8");
      const responseMaxChars = input.responseMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS;
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
      // Satır-bazlı framing: kısmi satır buffer'da KALIR; yalnızca "\n"
      // ile biten tam satır yanıt adayıdır.
      buffer += incoming;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) return;

      const line = buffer.slice(0, newlineIndex).trim();
      if (line.length === 0) return;

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
      );
    });

    // Worker erken ölürse stdin flush'ı EPIPE 'error' olayı üretir;
    // handler'sız hata node sürecinde uncaught exception olurdu. Hata
    // bilinçli olarak yutulur — exit handler fallback'i yürütür.
    child.stdin?.on("error", () => {});

    // İsteği stdin'e tek satır olarak yaz ve kapat (worker EOF'a kadar
    // çok istek okur; tek istek + end = bu koşumun bütçesi).
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
