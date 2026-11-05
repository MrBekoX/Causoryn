/**
 * Roslyn worker build yardımcısı (tests/ ortak bootstrap altyapısı).
 *
 * KÖK NEDEN (kırmızı kapı kanıtı, 2026-11-05): vitest test dosyalarını
 * paralel fork'larda koşturur; roslyn-worker.test.ts, cross-boundary.test.ts
 * ve csharp-roslyn-adapter.test.ts üçü de aynı `dotnet build
 * native/roslyn-worker` çağrısını kendi bootstrap'ında yapar. Eşzamanlı
 * iki MSBuild koşumu aynı `obj/Debug/net10.0` ara DLL'ine yazışır ve
 * kaybeden `CSC : error CS2012 (... being used by another process)` ile
 * exit=1 döner — bizzat yeniden üretildi (iki eşzamanlı build: biri 0,
 * biri 1). Bu bir C# derleme regresyonu DEĞİLDİR; suiteleri FAIL'e
 * düşüren build yarışıdır.
 *
 * ÇÖZÜM: build'i sürecõlar arası bir kilit dosyasıyla serileştirmek.
 * Komut, parametreler ve kanonik çıktı yolu DEĞİŞMEZ; her test dosyası
 * hâlâ KENDİ build sonucunu alır ve kontrol eder (B1/B2/B8 "build her
 * turda koşturulur ve sonucu kontrol edilir" sözleşmesi korunur). İlk
 * gerçek build'den sonra bekleyen koşumlar up-to-date kontrolüyle saniyeler
 * içinde döner. Gerçek bir C# derleme regresyonu bu düzende de üç dosyada
 * da FAIL üretir — sessiz skip yoktur.
 *
 * Kilit dosyası `obj/test-build.lock` altındadır (gitignore: obj/).
 * `openSync(wx)` atomik oluştur kullanılır; bu yüzden var olan bir
 * sembolik link üzerinden yazma YOKTUR (CWE-59 disiplini) — link varsa
 * acquire başarısız olur, bayatlarsa unlink edilip yeniden denenir.
 * Kilit >10 dk bayatsa ölü sahiptir (spawnSync timeout 300s) ve çalınır.
 */

import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_DIR = dirname(fileURLToPath(import.meta.url));
export const WORKER_DIR = resolve(HELPER_DIR, "..", "native", "roslyn-worker");

/** Build sürecõlar arası kilit dosyası (obj/ gitignore kapsamındadır). */
const BUILD_LOCK_PATH = join(WORKER_DIR, "obj", "test-build.lock");

/** Kilit bekleme yoklaması (ms). */
const ACQUIRE_POLL_MS = 100;
/** Kilit için toplam bekleme bütçesi; build timeout ile aynı sınır. */
const ACQUIRE_TIMEOUT_MS = 300_000;
/** Tek build'in üst sınırı (üç test dosyasındaki mevcut değerle aynı). */
const BUILD_TIMEOUT_MS = 300_000;
/** Bu süreden bayat kilit ölü sahiplere aittir ve çalınır (2x build timeout). */
const STALE_LOCK_MS = 600_000;

/** Senkron bağlamda uyku (test bootstrap'ı senkron spawnSync kullanır). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Kiliti açar; başarılı olunda dosya tanıtıcısını döner. Bayat kilit
 * çalınır; bütçe dolarsa açıklayıcı Error fırlatır (suite FAIL — sessiz
 * geçiştirme yok).
 */
function acquireBuildLock(): number {
  mkdirSync(dirname(BUILD_LOCK_PATH), { recursive: true });
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(BUILD_LOCK_PATH, "wx");
      writeSync(fd, String(process.pid));
      return fd;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== "EEXIST") throw error;
    }
    // Kilit mevcut: bayat mı? (ölmüş sahibi engellemesin)
    try {
      const stat = statSync(BUILD_LOCK_PATH);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
        unlinkSync(BUILD_LOCK_PATH);
        continue;
      }
    } catch {
      // kilit bu arada silindi; bir sonraki turda wx ile alınır
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `worker build kilidi ${String(ACQUIRE_TIMEOUT_MS / 1000)}s içinde alınamadı: ${BUILD_LOCK_PATH}`,
      );
    }
    sleepSync(ACQUIRE_POLL_MS);
  }
}

/** Kiliti bırakır; yalnızca sahibi çağırır (finally). */
function releaseBuildLock(fd: number): void {
  try {
    closeSync(fd);
  } finally {
    try {
      unlinkSync(BUILD_LOCK_PATH);
    } catch {
      // zaten yok (bayat çalma yarışı) — kilit bırakılmış sayılır
    }
  }
}

export interface WorkerBuildResult {
  /** spawnSync exit kodu; sinyal/saat aşımında null. */
  readonly status: number | null;
  readonly stderr: string;
  /**
   * stdout: MSBuild/CSC hataları (CS2012, MSB3027…) STDERR DEĞİL stdout'a
   * yazılır; bootstrap hata mesajlarının gerçek nedeni gösterebilmesi için
   * taşınır (kırmızı kapı çıktısında boş stderr kök nedeni gizlemişti).
   */
  readonly stdout: string;
}

/**
 * Roslyn worker'ı serileştirilmiş biçimde derler ve sonucu döndürür.
 * Build komutu/parametreleri üç test dosyasındaki mevcut çağrıyla
 * birebir aynıdır (`dotnet build <WORKER_DIR>`); yalnızca eşzamanlılık
 * kaldırılır. Çağıran test sonucu KENDİSİ kontrol eder (exit≠0 → FAIL).
 */
export function buildRoslynWorkerBinary(): WorkerBuildResult {
  const fd = acquireBuildLock();
  try {
    const build = spawnSync("dotnet", ["build", WORKER_DIR], {
      encoding: "utf8",
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    });
    return {
      status: build.status,
      stderr: typeof build.stderr === "string" ? build.stderr : "",
      stdout: typeof build.stdout === "string" ? build.stdout : "",
    };
  } finally {
    releaseBuildLock(fd);
  }
}
