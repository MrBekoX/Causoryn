import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

/**
 * WorkspaceWatcher test üçlüleri — Live Architecture (TŞ v2.1 §9
 * "Incremental pipeline" + §16A.5 Canlı güncelleme; sprint-2 B7).
 *
 * TŞ §9 sözleşmeleri:
 * - "FS watcher 300–1000 ms debounce" → debounceMs aralığı zorunludur;
 *   testler bandın ALT SINIRI olan 300 ms ile koşar (config gereği daha
 *   kısaya izin yoktur) ve sabit sleep yerine koşul beklemesi (polling
 *   + deadline) kullanır — flaky test yoktur.
 * - "allowlist/ignore ... fingerprint" → watcher olayları WorkspaceAccessPolicy
 *   kararıyla süzer (ignore dizindeki değişim iş AÇMAZ) ve içerik karması
 *   değişmeyen (touch) olayları atlar (no-op skip).
 * - "package.json/tsconfig/.sln/.csproj ve policy değişince bağımlı alanlar
 *   invalid edilir" → tetikleyici dosya değişimi FULL rebuild açar.
 * - "Uzun indeks süresinde eski snapshot sorgulanabilmeli, stale=true açıkça
 *   belirtilmeli" → pozitif test eski snapshot ID'nin getSnapshot ile
 *   stale=true döndüğünü kanıtlar (sprint-2 çıkış kriteri).
 * - §16A.5/6: watcher hatası motoru düşürmez; log + degrade + reconciliation
 *   (tam tarama) işi açılır.
 *
 * Denetim bulgu testleri (takım denetimi, 2026-11-05):
 * - log/onError seam'i fırlatsa bile watcher exception SIZMAZ (uncaught
 *   exception yolu kapatılır; degrade/start sözleşmeleri log hatasından
 *   bağımsız tutar).
 * - hashWorkspaceFile TŞ §19 TOCTOU sözleşmesi: açma sonrası politika
 *   yeniden denetimi — gerçek yolu kök dışına çıkan yol hash'lenmez.
 * - straggler (mükerrer/geç gelen OS olayı) ikinci iş AÇMAZ: flush'lanan
 *   yolların karmaları optimist işlenir; manuel scheduler ile deterministik
 *   kanıtlanır.
 *
 * Testler depoya YAZMAZ: geçici fixture'lar yalnızca os.tmpdir() altında
 * yaşar ve test sonunda silinir (ADR-008).
 */

import {
  hashWorkspaceFile,
  IndexJobManager,
  IndexService,
  WorkspaceWatcher,
  type WorkspaceWatcherStats,
} from "../src/index.js";
import { InMemoryGraphRepository } from "@causoryn/graph";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";
import { sha256Hex, utf8Encode } from "@causoryn/domain";

const DEBOUNCE_MS = 300; // TŞ §9 bandının [300,1000] alt sınırı
const FIXED_NOW = "2026-11-04T00:00:00.000Z";
const WAIT_DEADLINE_MS = 15_000;
const POLL_INTERVAL_MS = 25;

const APP_V1 =
  "export interface Order { id: string; total: number }\n" +
  "export function createOrder(input: Order): Order { return { ...input } }\n";
const APP_V2 =
  APP_V1 + 'export function exportedExtra(): string { return "extra"; }\n';

/** Koşul beklemesi: sabit sleep YOK; deadline aşımında etiketli hata. */
async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = WAIT_DEADLINE_MS,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`koşul zaman aşımı (${label}; ${String(timeoutMs)} ms)`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Negatif bekleme: `probe` koşulu quietMs boyunca DOĞRUYSA test geçer;
 * koşul bozulursa (beklenmedik iş açıldıysa) anında reddeder.
 */
async function expectConditionHolds(
  probe: () => boolean,
  label: string,
  quietMs: number,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (!probe()) {
      throw new Error(`beklenmedik durum değişimi: ${label}`);
    }
    if (Date.now() - start >= quietMs) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

interface StubWatchHandle {
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
  emitError(error: Error): void;
}

function makeStubHandle(): StubWatchHandle {
  let errorListener: ((error: Error) => void) | undefined;
  return {
    close: () => undefined,
    on: (_event, listener) => {
      errorListener = listener;
      return undefined;
    },
    emitError: (error) => errorListener?.(error),
  };
}

interface Harness {
  readonly root: string;
  readonly repository: InMemoryGraphRepository;
  readonly manager: IndexJobManager;
  readonly watcher: WorkspaceWatcher;
  readonly logs: readonly string[];
  /** Manuel scheduler kuyruğu (manualScheduler: true olan harness'ta dolu). */
  readonly tasks: Array<() => void>;
}

function makeHarness(
  options: {
    readonly extraIgnore?: readonly string[];
    readonly watchFactory?: (
      root: string,
      listener: (event: string, filename: string | null) => void,
    ) => { close(): void; on(event: "error", listener: (error: Error) => void): unknown };
    /** İşleri elle boşalt: straggler testi işin KUYRUKTA beklediği anı gerektirir. */
    readonly manualScheduler?: boolean;
    /** Fırlatan log seam'i (denetim bulgusu 1: exception sızmaz sözleşmesi). */
    readonly logImpl?: (line: string) => void;
    /** Fırlatan onError seam'i (denetim bulgusu 1). */
    readonly onErrorImpl?: (error: Error) => void;
  } = {},
): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "causoryn-watcher-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "app.ts"), APP_V1, "utf8");
  const policy = WorkspaceAccessPolicy.create({
    allowRoots: [root],
    ...(options.extraIgnore === undefined ? {} : { extraIgnore: [...options.extraIgnore] }),
  });
  const repository = new InMemoryGraphRepository();
  const indexService = new IndexService({
    workspaceId: "default",
    policy,
    repository,
    clock: () => FIXED_NOW,
    limits: { maxFiles: 50_000 },
  });
  const tasks: Array<() => void> = [];
  const manager = new IndexJobManager({
    indexService,
    policy,
    clock: () => FIXED_NOW,
    ...(options.manualScheduler === true
      ? { scheduler: (task: () => void) => tasks.push(task) }
      : {}),
  });
  const logs: string[] = [];
  const watcher = new WorkspaceWatcher({
    rootPath: root,
    policy,
    jobManager: manager,
    repository,
    workspaceId: "default",
    clock: () => FIXED_NOW,
    debounceMs: DEBOUNCE_MS,
    log: options.logImpl ?? ((line) => logs.push(line)),
    ...(options.onErrorImpl === undefined ? {} : { onError: options.onErrorImpl }),
    ...(options.watchFactory === undefined ? {} : { watchFactory: options.watchFactory }),
  });
  return { root, repository, manager, watcher, logs, tasks };
}

async function runInitialFullIndex(harness: Harness): Promise<string> {
  const record = harness.manager.refreshIndex(harness.root, { mode: "full" });
  // Manuel scheduler'lı harness'ta işi koştur; default scheduler'da kuyruk boştur.
  for (const task of harness.tasks.splice(0)) task();
  const done = await harness.manager.waitForJob(record.jobId);
  expect(done.status).toBe("done");
  const latest = harness.repository.getLatestPublished("default");
  expect(latest).toBeDefined();
  expect(latest?.stale).toBe(false);
  return latest?.snapshot.meta.id as string;
}

function statsOf(watcher: WorkspaceWatcher): WorkspaceWatcherStats {
  return watcher.stats();
}

async function cleanup(harness: Harness): Promise<void> {
  harness.watcher.stop();
  rmSync(harness.root, { recursive: true, force: true });
}

describe("WorkspaceWatcher — Live Architecture (sprint-2 B7)", { timeout: 30_000 }, () => {
  it(
    "pozitif: izinli dosya değişimi → debounce sonrası YENİ snapshot yayımlanır; eski snapshot stale=true ile sorgulanabilir",
    async () => {
      const harness = makeHarness();
      try {
        const firstId = await runInitialFullIndex(harness);
        harness.watcher.start();
        expect(harness.watcher.state).toBe("watching");

        writeFileSync(path.join(harness.root, "src", "app.ts"), APP_V2, "utf8");

        // Koşul beklemesi: yeni snapshot yayımlanana dek (sabit sleep yok).
        let secondId: string | undefined;
        await waitFor(() => {
          const latest = harness.repository.getLatestPublished("default");
          secondId = latest?.snapshot.meta.id;
          return secondId !== undefined && secondId !== firstId;
        }, "yeni snapshot yayımlanmadı");

        // Çıkış kriteri: eski snapshot HALÂ SORGULANABİLİR ve stale=true.
        const old = harness.repository.getSnapshot(firstId);
        expect(old).toBeDefined();
        expect(old?.stale).toBe(true);
        expect(old?.snapshot.meta.id).toBe(firstId);
        const fresh = harness.repository.getSnapshot(secondId as string);
        expect(fresh).toBeDefined();
        expect(fresh?.stale).toBe(false);

        // Graph güncellemesi kanıtı: değişen dosyadan YENİ sembol node'u çıktı.
        const hasNewSymbol = fresh?.snapshot.nodes.some((node) =>
          node.qualifiedName.includes("exportedExtra"),
        );
        expect(hasNewSymbol).toBe(true);

        // Watcher'ın açtığı iş: incremental mod + changeSet taşır.
        const incrementalJobs = harness.manager
          .jobs()
          .filter((job) => job.mode === "incremental");
        expect(incrementalJobs).toHaveLength(1);
        expect(incrementalJobs[0]?.status).toBe("done");
        expect(incrementalJobs[0]?.changeSet).toContain("src/app.ts");
        expect(statsOf(harness.watcher).jobsEnqueued).toBe(1);
        // Kesin sayaç iddiası sakin pencerede doğrulanır: iş bittikten sonra
        // 2 debounce penceresi boyunca ek iş AÇILMAZ (geç gelen OS olayı
        // optimist fingerprint sayesinde no-op düşer; denetim bulgusu 3).
        await expectConditionHolds(
          () => statsOf(harness.watcher).jobsEnqueued === 1,
          "pozitif: iş sonrası beklenmedik ek iş açıldı",
          DEBOUNCE_MS * 2 + 250,
        );
      } finally {
        await cleanup(harness);
      }
    },
  );

  it(
    "negatif: policy dışı (ignore) dizindeki değişim olayı süzülür; snapshot DEĞİŞMEZ ve iş açılmaz",
    async () => {
      const harness = makeHarness({ extraIgnore: ["secrets/**"] });
      try {
        mkdirSync(path.join(harness.root, "secrets"), { recursive: true });
        writeFileSync(path.join(harness.root, "secrets", "leak.ts"), "export const k = 1;\n", "utf8");
        const firstId = await runInitialFullIndex(harness);
        // Ignore dizin envantere girmemiş olmalı (politika kararı).
        expect(
          harness.repository
            .listFiles("default")
            .some((file) => file.relativePath.startsWith("secrets/")),
        ).toBe(false);

        harness.watcher.start();
        writeFileSync(path.join(harness.root, "secrets", "leak.ts"), "export const k = 2;\n", "utf8");

        // Kanıt: olay gerçekten geldi VE politika kararıyla düşürüldü.
        await waitFor(() => statsOf(harness.watcher).eventsFiltered >= 1, "olay süzülme kanıtı yok");

        // Debounce penceresinin 2 katı + marj boyunca iş AÇILMAZ ve snapshot DEĞİŞMEZ.
        await expectConditionHolds(
          () => statsOf(harness.watcher).jobsEnqueued === 0,
          "ignore dizini iş açtı",
          DEBOUNCE_MS * 2 + 250,
        );
        const latest = harness.repository.getLatestPublished("default");
        expect(latest?.snapshot.meta.id).toBe(firstId);
        expect(latest?.stale).toBe(false);
        expect(statsOf(harness.watcher).noOpSkipped + statsOf(harness.watcher).jobsEnqueued).toBe(0);
      } finally {
        await cleanup(harness);
      }
    },
  );

  it(
    "partial: debounce penceresinde çok değişiklik → TEK incremental reindex işi açılır",
    async () => {
      const harness = makeHarness();
      try {
        const firstId = await runInitialFullIndex(harness);
        harness.watcher.start();
        // Başlangıç sakinliği: setup yazımlarının kuyruğu boşalsın (koşulla).
        await waitFor(
          () => statsOf(harness.watcher).pendingPaths === 0 && statsOf(harness.watcher).jobsEnqueued === 0,
          "başlangıç sakinliği",
        );
        await expectConditionHolds(
          () => statsOf(harness.watcher).jobsEnqueued === 0,
          "başlangıç olayı iş açtı",
          DEBOUNCE_MS + 150,
        );

        // Debounce penceresi içinde 5 dosyalık değişiklik (hızlı art arda).
        writeFileSync(path.join(harness.root, "src", "app.ts"), APP_V2, "utf8");
        for (let i = 1; i <= 4; i += 1) {
          writeFileSync(
            path.join(harness.root, "src", `extra${String(i)}.ts`),
            `export const value${String(i)} = ${String(i)};\n`,
            "utf8",
          );
        }

        await waitFor(() => statsOf(harness.watcher).jobsEnqueued >= 1, "reindex işi açılmadı");
        const job = harness.manager.latest();
        expect(job).toBeDefined();
        const done = await harness.manager.waitForJob(job?.jobId as string);
        expect(done.status).toBe("done");

        expect(statsOf(harness.watcher).jobsEnqueued).toBe(1);
        expect(statsOf(harness.watcher).pendingPaths).toBe(0);
        expect(done.mode).toBe("incremental");
        expect(done.changeSet).toHaveLength(5);
        expect(done.changeSet).toContain("src/app.ts");
        expect(done.changeSet).toContain("src/extra1.ts");

        const latest = harness.repository.getLatestPublished("default");
        expect(latest?.snapshot.meta.id).not.toBe(firstId);
        // "TEK reindex" iddiası sakin pencerede doğrulanır (denetim bulgusu 3).
        await expectConditionHolds(
          () => statsOf(harness.watcher).jobsEnqueued === 1,
          "partial: iş sonrası beklenmedik ek iş açıldı",
          DEBOUNCE_MS * 2 + 250,
        );
      } finally {
        await cleanup(harness);
      }
    },
  );

  it(
    "invalidation: tsconfig.json değişimi → FULL rebuild işi açılır (TŞ §9 tetikleyicisi)",
    async () => {
      const harness = makeHarness();
      try {
        const firstId = await runInitialFullIndex(harness);
        harness.watcher.start();
        await waitFor(
          () => statsOf(harness.watcher).pendingPaths === 0 && statsOf(harness.watcher).jobsEnqueued === 0,
          "başlangıç sakinliği",
        );

        writeFileSync(
          path.join(harness.root, "tsconfig.json"),
          '{"compilerOptions":{"strict":true}}\n',
          "utf8",
        );

        await waitFor(() => statsOf(harness.watcher).jobsEnqueued >= 1, "invalidation işi açılmadı");
        const job = harness.manager.latest();
        expect(job).toBeDefined();
        const done = await harness.manager.waitForJob(job?.jobId as string);
        expect(done.status).toBe("done");
        expect(done.mode).toBe("full");
        expect(done.changeSet).toContain("tsconfig.json");

        const latest = harness.repository.getLatestPublished("default");
        expect(latest?.snapshot.meta.id).not.toBe(firstId);
        expect(harness.repository.getSnapshot(firstId)?.stale).toBe(true);
      } finally {
        await cleanup(harness);
      }
    },
  );

  it(
    "fingerprint no-op: içeriği DEĞİŞMEYEN (touch) olay iş AÇMAZ, noOpSkipped sayılır",
    async () => {
      const harness = makeHarness();
      try {
        const firstId = await runInitialFullIndex(harness);
        harness.watcher.start();
        await waitFor(
          () => statsOf(harness.watcher).pendingPaths === 0 && statsOf(harness.watcher).jobsEnqueued === 0,
          "başlangıç sakinliği",
        );

        // AYNI içerik yeniden yazılır (touch benzeri): karma değişmez.
        writeFileSync(path.join(harness.root, "src", "app.ts"), APP_V1, "utf8");

        await waitFor(() => statsOf(harness.watcher).noOpSkipped >= 1, "no-op kaydı tutulmadı");
        await expectConditionHolds(
          () => statsOf(harness.watcher).jobsEnqueued === 0,
          "no-op değişim iş açtı",
          DEBOUNCE_MS * 2 + 250,
        );
        const latest = harness.repository.getLatestPublished("default");
        expect(latest?.snapshot.meta.id).toBe(firstId);
      } finally {
        await cleanup(harness);
      }
    },
  );

  it(
    "watcher hatası motoru düşürmez (1/2): watch kurulumu patlarsa start fırlatmaz, degrade + reconciliation full işi açılır",
    async () => {
      const harness = makeHarness({
        watchFactory: () => {
          throw new Error("recursive watch bu platformda yok (test simülasyonu)");
        },
      });
      try {
        expect(() => harness.watcher.start()).not.toThrow();
        expect(harness.watcher.state).toBe("degraded");
        expect(harness.watcher.stats().errors).toBe(1);
        expect(harness.logs.some((line) => line.includes("watch-kurulumu"))).toBe(true);

        // Reconciliation: tam tarama işi açılır ve motor çalışmaya devam eder.
        const latest = harness.manager.latest();
        expect(latest?.mode).toBe("full");
        const done = await harness.manager.waitForJob(latest?.jobId as string);
        expect(done.status).toBe("done");
      } finally {
        await cleanup(harness);
      }
    },
  );

  it(
    "watcher hatası motoru düşürmez (2/2): çalışırken error olayı → degrade + reconciliation; stop sonrası olay yok sayılır",
    async () => {
      const handle = makeStubHandle();
      const harness = makeHarness({ watchFactory: () => handle });
      try {
        harness.watcher.start();
        expect(harness.watcher.state).toBe("watching");

        handle.emitError(new Error("EMFILE: too many open files (test simülasyonu)"));
        expect(harness.watcher.state).toBe("degraded");
        expect(harness.watcher.stats().errors).toBe(1);
        expect(harness.logs.some((line) => line.includes("EMFILE"))).toBe(true);

        const latest = harness.manager.latest();
        expect(latest?.mode).toBe("full");
        const done = await harness.manager.waitForJob(latest?.jobId as string);
        expect(done.status).toBe("done");

        // Degrade sonrası stop çağrısı güvenli ve idempotenttir.
        harness.watcher.stop();
        expect(() => harness.watcher.stop()).not.toThrow();
        expect(harness.watcher.state).toBe("stopped");
      } finally {
        await cleanup(harness);
      }
    },
  );

  it("debounce aralık sözleşmesi: 300–1000 ms dışı değer reddedilir (TŞ §9)", () => {
    const harness = makeHarness();
    try {
      const base = {
        rootPath: harness.root,
        policy: WorkspaceAccessPolicy.create({ allowRoots: [harness.root] }),
        jobManager: harness.manager,
        repository: harness.repository,
        workspaceId: "default",
        clock: () => FIXED_NOW,
        log: () => undefined,
      };
      expect(() => new WorkspaceWatcher({ ...base, debounceMs: 299 })).toThrow(RangeError);
      expect(() => new WorkspaceWatcher({ ...base, debounceMs: 1001 })).toThrow(RangeError);
      expect(() => new WorkspaceWatcher({ ...base, debounceMs: 0 })).toThrow(RangeError);
      // Aralık içi değer ve default kabul edilir.
      expect(() => new WorkspaceWatcher({ ...base, debounceMs: 300 })).not.toThrow();
      expect(() => new WorkspaceWatcher({ ...base, debounceMs: 1000 })).not.toThrow();
      expect(() => new WorkspaceWatcher(base)).not.toThrow();
    } finally {
      cleanup(harness);
    }
  });

  it("yaşam döngüsü: start → stop idempotent; stop sonrası state stopped", async () => {
    const harness = makeHarness();
    try {
      await runInitialFullIndex(harness);
      harness.watcher.start();
      expect(harness.watcher.state).toBe("watching");
      harness.watcher.stop();
      expect(harness.watcher.state).toBe("stopped");
      expect(() => harness.watcher.stop()).not.toThrow();
    } finally {
      await cleanup(harness);
    }
  });

  it(
    "denetim bulgusu 1: log/onError seam'i FIRLATSA bile watcher exception sızmaz; degrade sözleşmesi bozulmaz",
    async () => {
      const throwingLog = (line: string): void => {
        throw new Error(`log-pipe patladı: ${line.slice(0, 24)}`);
      };
      const throwingOnError = (): void => {
        throw new Error("onError dinleyicisi patladı");
      };
      const handle = makeStubHandle();
      const harness = makeHarness({
        logImpl: throwingLog,
        onErrorImpl: throwingOnError,
        watchFactory: () => handle,
      });
      try {
        // start() başarı yolundaki log çağrısı fırlasa bile FIRLATMAZ.
        expect(() => harness.watcher.start()).not.toThrow();
        expect(harness.watcher.state).toBe("watching");

        // fs.watch 'error' olay zincirindeki degrade: log + onError fırlatsa
        // da EventEmitter dispatch'ine exception SIzmaz (uncaughtException
        // yolu kapalı) ve reconciliation sözleşmesi aynen çalışır.
        expect(() =>
          handle.emitError(new Error("EMFILE: too many open files (test simülasyonu)")),
        ).not.toThrow();
        expect(harness.watcher.state).toBe("degraded");
        expect(harness.watcher.stats().errors).toBe(1);

        const latest = harness.manager.latest();
        expect(latest?.mode).toBe("full");
        const done = await harness.manager.waitForJob(latest?.jobId as string);
        expect(done.status).toBe("done");
      } finally {
        await cleanup(harness);
      }
    },
  );

  it(
    "denetim bulgusu 2 (TOCTOU): hashWorkspaceFile açma sonrası politika yeniden denetimi yapar; gerçek yolu kök dışına çıkan yol hash'lenmez",
    (ctx) => {
      const root = mkdtempSync(path.join(tmpdir(), "causoryn-hash-check-"));
      const outside = mkdtempSync(path.join(tmpdir(), "causoryn-hash-outside-"));
      try {
        mkdirSync(path.join(root, "src"), { recursive: true });
        const allowedContent = "export const allowed = 1;\n";
        writeFileSync(path.join(root, "src", "app.ts"), allowedContent, "utf8");
        const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
        const maxBytes = policy.config.maxFileBytes;

        // Pozitif: izinli dosya envanter karmasıyla AYNI algoritmayla hash'lenir.
        expect(hashWorkspaceFile(policy, root, "src/app.ts", maxBytes)).toBe(
          sha256Hex(utf8Encode(allowedContent)),
        );

        // TOCTOU senaryosunun deterministik eşleniği: olay anında kök İÇİNDE
        // görünen ad, gerçek yolu kök DIŞINA çözümlenir (Windows'ta ayrıcalık
        // gerektirmeyen junction; POSIX'te dizin sembolik bağı).
        mkdirSync(path.join(outside, "lib"), { recursive: true });
        const outsideContent = "export const smuggled = 2;\n";
        writeFileSync(path.join(outside, "lib", "app.ts"), outsideContent, "utf8");
        const linkPath = path.join(root, "src", "jlink");
        try {
          symlinkSync(
            path.join(outside, "lib"),
            linkPath,
            process.platform === "win32" ? "junction" : "dir",
          );
        } catch (error) {
          ctx.skip(`bağ oluşturulamadı (platform ayrıcalık kısıtı): ${String(error)}`);
        }
        // Post-open yeniden denetim: realpath kök dışı → HASH'LENMEZ (null).
        expect(hashWorkspaceFile(policy, root, "src/jlink/app.ts", maxBytes)).toBeNull();
        // Karşılaştırma: aynı içerik kök içindeyse hash'lenirdi.
        expect(hashWorkspaceFile(policy, root, "src/app.ts", maxBytes)).not.toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it(
    "denetim bulgusu 3 (straggler): flush sonrası gelen mükerrer olay ikinci iş AÇMAZ (optimist fingerprint)",
    async () => {
      let listener: ((event: string, filename: string | null) => void) | undefined;
      const handle = makeStubHandle();
      const harness = makeHarness({
        manualScheduler: true,
        watchFactory: (_root, captured) => {
          listener = captured;
          return handle;
        },
      });
      try {
        const firstId = await runInitialFullIndex(harness);
        harness.watcher.start();

        // Stub factory gerçek FS'yi izlemez: HER İKİ olay da seam üzerinden
        // verilir (OS zamanlamasından bağımsız, deterministik).
        writeFileSync(path.join(harness.root, "src", "app.ts"), APP_V2, "utf8");
        listener?.("change", "src\\app.ts");
        await waitFor(() => statsOf(harness.watcher).jobsEnqueued >= 1, "ilk iş açılmadı");
        // Manuel scheduler: iş KUYRUKTA bekliyor, koşmadı — kritik pencere.
        expect(harness.manager.latest()?.status).toBe("queued");

        // OS straggler'i: AYNI içerik için ikinci olay, iş koşmadan gelir.
        listener?.("change", "src\\app.ts");
        await waitFor(
          () => statsOf(harness.watcher).noOpSkipped >= 1,
          "straggler coalesce edilmedi: ikinci iş açıldı",
        );
        expect(statsOf(harness.watcher).jobsEnqueued).toBe(1);
        expect(statsOf(harness.watcher).pendingPaths).toBe(0);

        // İş koşar; snapshot yine güncellenir (davranış kaybı yok).
        for (const task of harness.tasks.splice(0)) task();
        const done = await harness.manager.waitForJob(
          harness.manager.latest()?.jobId as string,
        );
        expect(done.status).toBe("done");
        const latest = harness.repository.getLatestPublished("default");
        expect(latest?.snapshot.meta.id).not.toBe(firstId);
      } finally {
        await cleanup(harness);
      }
    },
  );
});
