/**
 * Worker süreç yönetimi — spawn, istek yazma, satır-bazlı framing ve
 * per-request timeout (M1-Rust; native/rust-worker PROTOCOL.md v1).
 *
 * Süreç yaşam döngüsü kararı (csharp-roslyn önceliğiyle aynı): adapter,
 * analyze başına YENİ bir worker süreci başlatır (long-lived daemon değil).
 * Gerekçe: timeout/çökme durumunda paylaşılan durum yok → restart sorunu
 * yapısal olarak yok; tek istek başına süreç, yarım yanıt/çökme
 * senaryolarının diğer isteklere sızmasını imkânsız kılar (TŞ §7 adapter
 * izolasyonu). Daemonizasyon ayrı dilim işidir.
 *
 * Framing: stdout parça-parça gelir; satır buffer'ında birleştirilir,
 * "\n" görülen kadarını satır sayar, KALAN kısmi satır buffer'da korunur.
 * Newline hiç gelmezse (yarı yanıt) buffer asla yanıt sayılmaz → timeout
 * devreye girer → süreç kill edilir.
 *
 * Güvenlik (kırmızı çizgi 6): komut LİTERAL "causoryn-rust-worker"
 * binary adıdır; tam yolu options.workerDir sabit repo-içi yoldan
 * türetilir ve CHILD env PATH'ine ÖNEKLENİR (libuv, komut adını child
 * env PATH'inden çözümler). Argümanlar boş sabit dizidir; istek içeriği
 * yalnızca stdin üzerinden taşınır; kullanıcı girdisi komut satırına
 * HİÇBIR yolla interpole edilmez.
 */
import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import { delimiter as pathDelimiter } from "node:path";
import {
  buildToolEnv,
  isSafeCommandPath,
  WORKER_ENV_ALLOWLIST,
} from "./cargo.js";
import { DEFAULT_RESPONSE_MAX_CHARS, type SpawnFunction } from "./types.js";

/**
 * Worker alt sürecine geçilecek minimum ortamı kurar: allowlist'teki
 * parent değişkenleri taşınır; PATH'in başına worker binary dizini
 * ÖNEKLENİR (literal binary adı bu dizinden çözümlensin diye).
 */
function buildWorkerEnv(workerDir: string): Record<string, string> {
  const env = buildToolEnv(WORKER_ENV_ALLOWLIST, null);
  const currentPath = env["PATH"] ?? "";
  env["PATH"] = workerDir + pathDelimiter + currentPath;
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
  /**
   * Worker binary dizini (SABİT repo-içi yol: native/rust-worker/target/
   * debug). Komut, bu dizinden çözümlenen LİTERAL binary adıdır.
   */
  readonly workerDir: string;
  /**
   * LİTERAL worker binary adı (platforma göre "causoryn-rust-worker.exe"
   * / "causoryn-rust-worker"). Sabit constant'tır; config override'ı
   * workerDir üzerinden yapılır.
   */
  readonly workerBinaryName: string;
  /** Tek analyze isteği (JSON'a serileştirilir; stdin'e tek satır yazılır). */
  readonly requestPayload: unknown;
  readonly requestTimeoutMs: number;
  /**
   * Birikmiş yanıt buffer'ı için char üst sınırı. Tanımsızsa
   * DEFAULT_RESPONSE_MAX_CHARS (64M — istek bütçesinin aynası).
   */
  readonly responseMaxChars?: number;
  /**
   * Birikmiş stderr için char üst sınırı; tanımsızsa 64M (yanıt
   * bütçesinin aynası). Güvenlik bulgusu karşılığı: worker stderr'i
   * timeout penceresinde sınırsız birikemez — aşım → süreç kill +
   * L0/L1 fallback; saklanan kuyruk baştan bütçeye kırpılır.
   */
  readonly stderrMaxChars?: number;
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

    // Savunma: binary adı ve dizin güvenlik filtresinden geçmeli; aksi
    // halde süreç hiç başlatılmaz (statik güvenlik bulgusu savunma katmanı).
    if (
      !isSafeCommandPath(input.workerBinaryName) ||
      !isSafeCommandPath(input.workerDir)
    ) {
      resolveOutcome({
        status: "unavailable",
        response: null,
        stderr: "",
        detail: "geçersiz worker binary yolu (güvenlik filtresi reddetti)",
      });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawnProcess(
        input.workerBinaryName,
        [],
        { stdio: ["pipe", "pipe", "pipe"], env: buildWorkerEnv(input.workerDir) },
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
      // Güvenlik bulgusu karşılığı: stderr, timeout penceresinde sınırsız
      // birikemez — yanıt bütçesinin stderr karşılığı. Aşım → süreç kill
      // + L0/L1 fallback; saklanan kuyruk baştan bütçeye kırpılır.
      const incoming = chunk.toString("utf8");
      const stderrMaxChars = input.stderrMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS;
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
