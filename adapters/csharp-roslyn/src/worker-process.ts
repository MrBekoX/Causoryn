/**
 * Worker süreç yönetimi — spawn, istek yazma, satır-bazlı framing ve
 * per-request timeout (sprint-2 / B2; PROTOCOL.md v1).
 *
 * Süreç yaşam döngüsü kararı: adapter, analyze başına YENİ bir worker
 * süreci başlatır (long-lived daemon değil). Gerekçe:
 * - timeout/çökme durumunda paylaşılan durum yok → restart sorunu yapısal
 *   olarak yok; "restart" = bir sonraki istekte taze süreç (politika
 *   README.md'de belgeli).
 * - tek istek başına süreç, worker'ın yarım yanıt/çökme senaryolarının
 *   diğer isteklere sızmasını imkânsız kılar (TŞ §7 adapter izolasyonu).
 * - dotnet exec + Roslyn derleme başlangıcı workspace büyüklüğüyle ölçekli;
 *   B2 dilimi tek kullanıcılı stdio senaryosu içindir; daemonizasyon
 *   ayrı dilim işidir (K-010 kapsamı gibi).
 *
 * Framing: stdout parça-parça gelir; satır buffer'ında birleştirilir,
 * "\n" görülen kadarını satır sayar, KALAN kısmi satır buffer'da korunur.
 * Newline hiç gelmezse (yarı yanıt) buffer asla yanıt sayılmaz → timeout
 * devreye girer → süreç kill edilir.
 *
 * Güvenlik (kırmızı çizgi 6): komut LİTERAL "dotnet" (config override'lı),
 * argümanlar SABİT ["exec", workerDllPath]; istek içeriği yalnızca stdin
 * üzerinden taşınır.
 */
import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import {
  DEFAULT_RESPONSE_MAX_CHARS,
  WORKER_ENV_ALLOWLIST,
  type SpawnFunction,
} from "./types.js";

/**
 * Worker alt sürecine geçilecek minimum ortamı kurar (güvenlik bulgusu 1):
 * yalnızca WORKER_ENV_ALLOWLIST'teki parent değişkenleri taşınır; anahtar/
 * token gibi allowlist dışı değerler süreç listesinden okunamaz.
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
        input.dotnetCommand,
        ["exec", input.workerDllPath],
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
      // Güvenlik bulgusu 4: yanıt buffer bütçesi. Sembol yoğunluğu yüksek
      // girdide tek yanıt satırı sınırsız büyüyemesin — buffer sınırı
      // aşarsa süreç kill edilir ve L0/L1 fallback devreye girer
      // (sınırsız buffer + sınırsız JSON.parse yerine).
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

    // Denetim bulgusu düzeltmesi: worker erken ölürse (crash) stdin flush'ı
    // EPIPE 'error' olayı üretir; handler'sız error node sürecinde uncaught
    // exception'a dönüşür ve motoru çökertir (TŞ §7 izolasyon garantisi).
    // Hata bilinçli olarak yutulur — exit handler fallback'i zaten yürütür.
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
