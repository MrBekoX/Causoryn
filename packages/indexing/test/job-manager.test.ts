import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * IndexJobManager test üçlüleri (TŞ v2.1 §10.2 causoryn_refresh_index /
 * causoryn_index_status; sprint-2 B6).
 *
 * TŞ §10.2 sözleşmeleri (raw/Causoryn_Teknik_Dokuman_v2.1.pdf, s.9-10):
 * - causoryn_refresh_index (mode, scope?) → "Yeni snapshot işi"
 * - causoryn_index_status (jobId?) → "Snapshot, stale, job progress, diagnostics"
 *
 * Pozitif: refresh_index işi kuyruğa alınır ve arka planda (in-process,
 * default setImmediate scheduler) koşar; çağrı anında jobId döner, iş
 * tamamlandığında done + snapshot yayınlanır. jobId sayaç tabanlıdır ve
 * snapshot ID'sinin girdisine KATILMAZ (determinizm invariant'ı).
 * Negatif: yetkisiz kök senkron reddedilir (iş kaydı AÇILMAZ); incremental
 * mode B7 dilimine aittir — indexing/unsupported-mode ile reddedilir.
 * Partial: boş workspace → iş done + snapshotState partial + uyarı.
 *
 * Testler depoya YAZMAZ: fixture salt-okunur okunur (ADR-008); geçici
 * fixture'lar yalnızca os.tmpdir() altında yaşar ve test sonunda silinir.
 */

import {
  IndexJobManager,
  IndexService,
  IndexingError,
} from "../src/index.js";
import { InMemoryGraphRepository } from "@causoryn/graph";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");
const FIXED_NOW = "2026-11-02T00:00:00.000Z";

interface ManagerHarness {
  readonly manager: IndexJobManager;
  readonly repository: InMemoryGraphRepository;
  /** Varsayılan setImmediate yerine manuel kuyruk: task'lar elle boşaltılır. */
  readonly tasks: Array<() => void>;
}

function makeHarness(
  options: {
    readonly allowRoots?: readonly string[];
    readonly jobIdGenerator?: () => string;
    readonly maxJobs?: number;
  } = {},
): ManagerHarness {
  const allowRoots = options.allowRoots ?? [FIXTURE_ROOT];
  const policy = WorkspaceAccessPolicy.create({ allowRoots: [...allowRoots] });
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
    ...(options.jobIdGenerator === undefined
      ? {}
      : { jobIdGenerator: options.jobIdGenerator }),
    ...(options.maxJobs === undefined ? {} : { maxJobs: options.maxJobs }),
    // Manuel scheduler: her task kuyruğa girer; test dilediğinde boşaltır.
    scheduler: (task) => {
      tasks.push(task);
    },
  });
  return { manager, repository, tasks };
}

describe("IndexJobManager — refresh_index iş yönetimi (sprint-2 B6)", () => {
  it("pozitif: default scheduler ile jobId anında döner, iş arka planda done olur; snapshot yayımlanır", async () => {
    const allowRoots = [FIXTURE_ROOT];
    const policy = WorkspaceAccessPolicy.create({ allowRoots });
    const repository = new InMemoryGraphRepository();
    const indexService = new IndexService({
      workspaceId: "default",
      policy,
      repository,
      clock: () => FIXED_NOW,
      limits: { maxFiles: 50_000 },
    });
    // Varsayılan scheduler (setImmediate) — async davranışın kendisi test edilir.
    const manager = new IndexJobManager({
      indexService,
      policy,
      clock: () => FIXED_NOW,
    });

    const record = manager.refreshIndex(FIXTURE_ROOT, { mode: "full" });
    // İş başlatıldı ama henüz KOŞMADI: çağrı anında queued/running döner.
    expect(record.jobId).toBe("job-000001");
    expect(["queued", "running"]).toContain(record.status);
    expect(record.mode).toBe("full");
    expect(record.scope).toBeNull();
    expect(record.snapshotId).toBeNull();

    const inflight = manager.status(record.jobId);
    expect(inflight).toBeDefined();
    expect(["queued", "running"]).toContain(inflight?.status);

    const final = await manager.waitForJob(record.jobId);
    expect(final.status).toBe("done");
    expect(final.snapshotState).toBe("ready");
    expect(final.progressPercent).toBe(100);
    expect(final.stale).toBe(false);
    expect(final.fileCount).toBeGreaterThan(0);
    expect(final.tsFileCount).toBeGreaterThan(0);
    expect(final.diagnostics).toHaveLength(0);
    expect(final.createdAt).toBe(FIXED_NOW);
    expect(final.startedAt).toBe(FIXED_NOW);
    expect(final.finishedAt).toBe(FIXED_NOW);

    const latest = repository.getLatestPublished("default");
    expect(latest).toBeDefined();
    expect(final.snapshotId).toBe(latest?.snapshot.meta.id);
    expect(latest?.stale).toBe(false);
    // Varsayılan setImmediate + gerçek adapter: tam suite paralel yükünde
    // transform maliyeti değişken olduğundan açık test süresi verilir.
  }, 30_000);

  it("pozitif: jobId snapshot ID'sine karışmaz — farklı jobId üreticileri aynı snapshot ID'yi verir", async () => {
    const first = makeHarness({ jobIdGenerator: () => "job-aaa" });
    const second = makeHarness({ jobIdGenerator: () => "job-zzz" });

    const r1 = first.manager.refreshIndex(FIXTURE_ROOT, { mode: "full" });
    const r2 = second.manager.refreshIndex(FIXTURE_ROOT, { mode: "full" });
    expect(r1.jobId).toBe("job-aaa");
    expect(r2.jobId).toBe("job-zzz");

    for (const harness of [first, second]) {
      for (const task of harness.tasks.splice(0)) task();
    }
    const f1 = await first.manager.waitForJob(r1.jobId);
    const f2 = await second.manager.waitForJob(r2.jobId);

    expect(f1.status).toBe("done");
    // Snapshot ID yalnızca içerik girdilerinden (workspaceId, revision,
    // configHash, analyzerFingerprint, contentHash) türetilir; jobId işletim
    // kaydıdır ve graph JSON'a girmez (TŞ §8 invariant vi korunur).
    expect(f1.snapshotId).toBe(f2.snapshotId);
    const s1 = first.repository.getLatestPublished("default");
    const s2 = second.repository.getLatestPublished("default");
    expect(JSON.stringify(s1?.snapshot)).toBe(JSON.stringify(s2?.snapshot));
  });

  it("pozitif: sayaç tabanlı jobId deterministiktir ve işler sırayla koşar", async () => {
    const harness = makeHarness();
    const first = harness.manager.refreshIndex(FIXTURE_ROOT, { mode: "full" });
    const second = harness.manager.refreshIndex(FIXTURE_ROOT, { mode: "full" });

    // Manuel scheduler: hiçbir task boşaltılmadı → ikisi de kuyrukta.
    expect(first.status).toBe("queued");
    expect(second.status).toBe("queued");
    expect(first.jobId).toBe("job-000001");
    expect(second.jobId).toBe("job-000002");

    // Sırayla boşalt: sequential execution, her iş tamamlanır.
    for (const task of harness.tasks.splice(0)) task();
    const f1 = await harness.manager.waitForJob(first.jobId);
    const f2 = await harness.manager.waitForJob(second.jobId);
    expect(f1.status).toBe("done");
    expect(f2.status).toBe("done");
    expect(harness.manager.latest()?.jobId).toBe("job-000002");
  });

  it("negatif: yetkisiz kök senkron reddedilir ve iş kaydı AÇILMAZ", () => {
    const harness = makeHarness({ allowRoots: [] });
    let caught: unknown;
    try {
      harness.manager.refreshIndex(FIXTURE_ROOT, { mode: "full" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IndexingError);
    expect((caught as IndexingError).code).toBe("indexing/root-not-authorized");
    expect(harness.manager.latest()).toBeUndefined();
    expect(harness.tasks).toHaveLength(0);
  });

  it("negatif: incremental mode bu dilimde reddedilir (indexing/unsupported-mode; B7 Live Architecture)", () => {
    const harness = makeHarness();
    let caught: unknown;
    try {
      harness.manager.refreshIndex(FIXTURE_ROOT, { mode: "incremental" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IndexingError);
    expect((caught as IndexingError).code).toBe("indexing/unsupported-mode");
    expect(harness.manager.latest()).toBeUndefined();
  });

  it("negatif: waitForJob bilinmeyen jobId ile reddedilir", async () => {
    const harness = makeHarness();
    await expect(harness.manager.waitForJob("job-yok")).rejects.toThrow();
  });

  it("negatif: bilinmeyen jobId status() ile bulunamaz (undefined)", () => {
    const harness = makeHarness();
    expect(harness.manager.status("job-yok")).toBeUndefined();
  });

  it("partial: boş workspace → iş done + snapshotState partial + uyarılar", async () => {
    const emptyRoot = mkdtempSync(path.join(tmpdir(), "causoryn-job-empty-"));
    try {
      const harness = makeHarness({ allowRoots: [emptyRoot] });
      const record = harness.manager.refreshIndex(emptyRoot, { mode: "full" });
      for (const task of harness.tasks.splice(0)) task();
      const final = await harness.manager.waitForJob(record.jobId);
      expect(final.status).toBe("done");
      expect(final.snapshotState).toBe("partial");
      expect(final.progressPercent).toBe(100);
      expect(final.tsFileCount).toBe(0);
      expect(final.warnings.length).toBeGreaterThanOrEqual(1);
      expect(final.diagnostics).toHaveLength(0);
      const latest = harness.repository.getLatestPublished("default");
      expect(latest?.snapshot.meta.state).toBe("partial");
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("partial: bozuk TS dosyası → iş done + partial + diagnostics raporlanır (index_status diagnostics taşıması)", async () => {
    // Bozuk dosya senaryosu IndexService testinde kapsanıyor; burada iş
    // kaydının diagnostics'ı IndexRunResult'tan TAŞIYIP taşımadığını
    // doğruluyoruz (TŞ §10.2 index_status çıktısı: diagnostics).
    const root = mkdtempSync(path.join(tmpdir(), "causoryn-job-broken-"));
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(path.join(root, "src", "broken.ts"), "export class ((( \n", "utf8");
      const harness = makeHarness({ allowRoots: [root] });
      const record = harness.manager.refreshIndex(root, { mode: "full" });
      for (const task of harness.tasks.splice(0)) task();
      const final = await harness.manager.waitForJob(record.jobId);
      expect(final.status).toBe("done");
      expect(final.snapshotState).toBe("partial");
      expect(final.diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(final.diagnostics[0]?.relativePath).toContain("broken.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maxJobs aşımı: en eski iş kaydı FIFO düşer, bilinen jobId sorgusu undefined döner", async () => {
    const harness = makeHarness({ maxJobs: 2 });
    const r1 = harness.manager.refreshIndex(FIXTURE_ROOT, { mode: "full" });
    const r2 = harness.manager.refreshIndex(FIXTURE_ROOT, { mode: "full" });
    const r3 = harness.manager.refreshIndex(FIXTURE_ROOT, { mode: "full" });
    for (const task of harness.tasks.splice(0)) task();
    await harness.manager.waitForJob(r3.jobId);

    expect(harness.manager.status(r1.jobId)).toBeUndefined(); // evict edilen
    expect(harness.manager.status(r2.jobId)).toBeDefined();
    expect(harness.manager.status(r3.jobId)).toBeDefined();
    expect(harness.manager.latest()?.jobId).toBe(r3.jobId);
  });
});
