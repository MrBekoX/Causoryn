/**
 * Worker süreç yönetimi — spawn, istek yazma, satır-bazlı framing ve
 * per-request timeout (M1-Python; native/python-worker/PROTOCOL.md v1).
 *
 * csharp-roslyn worker-process.ts deseni birebir uyarlanır:
 * - analyze başına YENİ worker süreci (long-lived daemon değil) — yarım
 *   yanıt/çökme diğer isteklere sızmaz (TŞ §7 adapter izolasyonu).
 * - Framing: stdout parça-parça gelir; satır buffer'ında birleştirilir,
 *   "\n" görülen kadarını satır sayar, KALAN kısmi satır buffer'da korunur.
 *   Newline hiç gelmezse (yarı yanıt) buffer asla yanıt sayılmaz → timeout
 *   devreye girer → süreç kill edilir.
 * - Yanıt buffer bütçesi: sınır aşımı → süreç kill + L0/L1 fallback.
 * - stdin EPIPE: worker erken ölürse istek yazımı 'error' üretebilir;
 *   handler'sız error node sürecini çökertir (denetim bulgusu düzeltmesi)
 *   — hata bilinçli yutulur, exit handler fallback'i yürütür.
 *
 * Güvenlik (kırmızı çizgi 6): komut LİTERAL "python" (config override'lı),
 * argümanlar SABİT ["-B", workerScriptPath]; istek içeriği yalnızca stdin
 * üzerinden taşınır.
 */
import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import {
  DEFAULT_RESPONSE_MAX_CHARS,
  WORKER_ENV_ALLOWLIST,
  WORKER_IO_ENCODING,
  type SpawnFunction,
} from "./types.js";

/**
 * Worker alt sürecine geçilecek minimum ortamı kurar: yalnızca
 * WORKER_ENV_ALLOWLIST'teki parent değişkenleri taşınır; PYTHONPATH
 * taşınmaz — worker saf stdlib'tir, ortam determinizmi etkileyemez.
 * PYTHONIOENCODING parent değerinden BAĞIMSIZ olarak "utf-8" sabitlenir
 * (takım denetimi bulgusu: piped stderr locale kod sayfasına düşüp Türkçe
 * log metnini bozuyordu; worker da kendi tarafında reconfigure eder).
 */
function buildWorkerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of WORKER_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined && value.length > 0) {
      env[key] = value;
    }
  }
  env["PYTHONIOENCODING"] = WORKER_IO_ENCODING;
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

export interface RunWorkerAnalyzeInput {
  readonly pythonCommand: string;
  readonly workerScriptPath: string;
  /** Tek analyze isteği (JSON'a serileştirilir; stdin'e tek satır yazılır). */
  readonly requestPayload: unknown;
  readonly requestTimeoutMs: number;
  /** Birikmiş yanıt buffer'ı için char üst sınırı; tanımsızsa 64M. */
  readonly responseMaxChars?: number;
  /** Test enjeksiyonu; default node:child_process.spawn. */
  readonly spawnProcess?: SpawnFunction;
}

export function runWorkerAnalyze(input: RunWorkerAnalyzeInput): Promise<WorkerRunOutcome> {
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

    let child: ChildProcess;
    try {
      child = spawnProcess(
        input.pythonCommand,
        // "-B": __pycache__ bytecode yazımı kapalı — worker salt-okunur
        // disiplinine savunma derinliği. Argümanlar SABİT dizidir.
        ["-B", input.workerScriptPath],
        { stdio: ["pipe", "pipe", "pipe"], env: buildWorkerEnv() },
      );
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
      // Yanıt buffer bütçesi: tek yanıt satırı sınırsız büyüyemesin —
      // aşım → süreç kill + L0/L1 fallback.
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
    // handler'sız error uncaught exception'a dönüşür ve motoru çökertir.
    // Hata bilinçli olarak yutulur — exit handler fallback'i yürütür.
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
