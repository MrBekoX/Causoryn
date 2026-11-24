import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_GO_BINARY_PATH,
  DEFAULT_REQUEST_TIMEOUT_MS as DEFAULT_GO_TIMEOUT_MS,
  GO_ADAPTER_ID,
  GO_ADAPTER_VERSION,
} from "@causoryn/adapter-go";
import {
  DEFAULT_PYTHON_COMMAND,
  DEFAULT_REQUEST_TIMEOUT_MS as DEFAULT_PY_TIMEOUT_MS,
  DEFAULT_RESPONSE_MAX_CHARS as DEFAULT_PY_MAX_CHARS,
  PYTHON_WORKER_ADAPTER_ID,
  PYTHON_WORKER_ADAPTER_VERSION,
} from "@causoryn/adapter-python";
import { WORKER_BINARY_NAME } from "@causoryn/adapter-rust";
import { GraphRepositoryError, InMemoryGraphRepository } from "@causoryn/graph";
import { SqliteGraphRepository } from "@causoryn/storage-sqlite";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

import {
  IndexService,
  IndexingError,
  buildAnalyzerFingerprint,
} from "../src/index.js";

/**
 * K-021 Track 2 — Çoklu-süreç SQLite yarış kurtarma testleri.
 *
 * Aynı SQLite dosyasını (WAL + busy_timeout=5000) paylaşan iki ayrı
 * SqliteGraphRepository örneği üzerinden:
 * - tolerateConcurrentPublishRace=false (varsayılan) iken UNIQUE snapshot
 *   çakışmasının eskisi gibi IndexingError("indexing/internal") fırlattığı,
 * - tolerateConcurrentPublishRace=true iken graph/publish-failed yarışında
 *   kaybeden build satırının failBuild ile temizlendiği (asılı 'building'
 *   satırı kalmadığı, stale=false korunduğu) ve mevcut yayımlanmış
 *   snapshot'ın published=false ile zarifçe döndürüldüğü,
 * - graph/build-already-active yarışında (runIndex, runIndexAsync,
 *   runIncrementalIndexAsync) yayımlanmış snapshot varsa onun yeniden
 *   kullanıldığı; hiç yayımlanmış snapshot yoksa hata fırlatıldığı (fail-closed)
 * gerçek SQLite dosyası üzerinde doğrulanır.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.dirname(TEST_DIR);
const REPO_ROOT = path.dirname(path.dirname(PKG_DIR));

const T0 = "2026-11-19T10:00:00.000Z";
const T1 = "2026-11-19T10:00:05.000Z";

interface TempArena {
  readonly baseDir: string;
  readonly workspaceDir: string;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly cleanup: () => void;
}

function createTempArena(): TempArena {
  const baseDir = mkdtempSync(path.join(tmpdir(), "causoryn-mp-race-"));
  const workspaceDir = path.join(baseDir, "workspace");
  const dataDir = path.join(baseDir, "data");
  mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(workspaceDir, "src", "orders.ts"),
    [
      "export interface Order { readonly id: string; readonly total: number; }",
      "export function createOrder(id: string, total: number): Order {",
      "  return { id, total };",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const dbPath = path.join(dataDir, "graph.sqlite");
  return {
    baseDir,
    workspaceDir,
    dataDir,
    dbPath,
    cleanup: () => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

function createPolicy(workspaceDir: string): WorkspaceAccessPolicy {
  return WorkspaceAccessPolicy.create({ allowRoots: [workspaceDir] });
}

describe("IndexService — çoklu-süreç SQLite yarış kurtarması", { timeout: 30_000 }, () => {
  it("varsayılan modda (tolerateConcurrentPublishRace=false) eşzamanlı publish çakışması IndexingError fırlatır", () => {
    const arena = createTempArena();
    const repoA = new SqliteGraphRepository(arena.dbPath);
    const repoB = new SqliteGraphRepository(arena.dbPath);
    try {
      const policy = createPolicy(arena.workspaceDir);
      const serviceA = new IndexService({
        workspaceId: "default",
        policy,
        repository: repoA,
        clock: () => T0,
        limits: { maxFiles: 100 },
      });
      const serviceB = new IndexService({
        workspaceId: "default",
        policy,
        repository: repoB,
        clock: () => T1,
        limits: { maxFiles: 100 },
      });

      const first = serviceA.runIndex(arena.workspaceDir);
      expect(first.published).toBe(true);

      expect(() => serviceB.runIndex(arena.workspaceDir)).toThrow(IndexingError);
    } finally {
      repoA.close();
      repoB.close();
      arena.cleanup();
    }
  });

  it("runIndex: tolerateConcurrentPublishRace=true iken graph/publish-failed yarışında building satırını temizler ve yayımlanmış snapshot'a döner", () => {
    const arena = createTempArena();
    const repoA = new SqliteGraphRepository(arena.dbPath);
    const repoB = new SqliteGraphRepository(arena.dbPath);
    try {
      const policy = createPolicy(arena.workspaceDir);
      // İki servis de boş veritabanı anında açılır (her ikisinde runCount === 0).
      const serviceA = new IndexService({
        workspaceId: "default",
        policy,
        repository: repoA,
        clock: () => T0,
        limits: { maxFiles: 100 },
        tolerateConcurrentPublishRace: true,
      });
      const serviceB = new IndexService({
        workspaceId: "default",
        policy,
        repository: repoB,
        clock: () => T1,
        limits: { maxFiles: 100 },
        tolerateConcurrentPublishRace: true,
      });

      const winner = serviceA.runIndex(arena.workspaceDir);
      expect(winner.published).toBe(true);
      expect(winner.state).toBe("ready");

      const recovered = serviceB.runIndex(arena.workspaceDir);
      expect(recovered.published).toBe(false);
      expect(recovered.snapshotId).toBe(winner.snapshotId);
      expect(recovered.snapshot.meta.id).toBe(winner.snapshotId);
      expect(recovered.state).toBe("ready");
      expect(recovered.stale).toBe(false);
      expect(
        recovered.warnings.some((w) => w.includes("concurrent") && w.includes("snapshot")),
      ).toBe(true);

      // SQLite içinde asılı 'building' satırı kalmamalı (stale === false).
      const latestFromA = repoA.getLatestPublished("default");
      expect(latestFromA?.snapshot.meta.id).toBe(winner.snapshotId);
      expect(latestFromA?.stale).toBe(false);

      // Dosya değiştiğinde serviceB güncel sequence üzerinden yeni snapshot yayımlayabilmeli.
      writeFileSync(
        path.join(arena.workspaceDir, "src", "orders.ts"),
        "export function createOrderV2(id: string): string { return id; }\n",
        "utf8",
      );
      const next = serviceB.runIndex(arena.workspaceDir);
      expect(next.published).toBe(true);
      expect(next.snapshotId).not.toBe(winner.snapshotId);
      expect(next.snapshot.meta.revision.sequence).toBe(2);
    } finally {
      repoA.close();
      repoB.close();
      arena.cleanup();
    }
  });

  it("runIndexAsync ve runIncrementalIndexAsync: graph/publish-failed yarışında building satırını temizler ve mevcut snapshot'ı döner", async () => {
    const arena = createTempArena();
    // Senkron başlangıçta sync-run-degraded üretmesi için bir .cs dosyası ekleyelim;
    // böylece iki ayrı süreçteki runIncrementalIndexAsync aynı anda tam analize yükseltmeye çalışır.
    writeFileSync(
      path.join(arena.workspaceDir, "src", " billing.cs".trim()),
      "namespace Demo { public class Billing {} }\n",
      "utf8",
    );
    const repoA = new SqliteGraphRepository(arena.dbPath);
    const repoB = new SqliteGraphRepository(arena.dbPath);
    try {
      const policy = createPolicy(arena.workspaceDir);
      const stubAnalyzeCSharp = async () => ({
        analyzerId: "roslyn-worker" as const,
        analyzerVersion: "0.1.0",
        workerAvailable: false,
        state: "partial" as const,
        coverageRatio: 0,
        capabilities: {
          astParse: false,
          symbolResolution: false,
          containsEdges: false,
          callEdges: false,
          importEdges: false,
          routeDetection: "worker-unavailable",
          frameworkLinkers: false,
        },
        unsupportedConstructs: [],
        nodes: [
          {
            kind: "File" as const,
            qualifiedName: "src/billing.cs",
            language: "csharp",
            relativePath: "src/billing.cs",
          },
        ],
        edges: [],
        evidence: [],
        diagnostics: [],
        warnings: ["roslyn worker test stub fallback"],
      });

      const serviceA = new IndexService({
        workspaceId: "default",
        policy,
        repository: repoA,
        clock: () => T0,
        limits: { maxFiles: 100 },
        csharp: { analyzeCSharp: stubAnalyzeCSharp },
        tolerateConcurrentPublishRace: true,
      });
      const serviceB = new IndexService({
        workspaceId: "default",
        policy,
        repository: repoB,
        clock: () => T1,
        limits: { maxFiles: 100 },
        csharp: { analyzeCSharp: stubAnalyzeCSharp },
        tolerateConcurrentPublishRace: true,
      });

      const winnerAsync = await serviceA.runIndexAsync(arena.workspaceDir);
      expect(winnerAsync.published).toBe(true);

      const loserAsync = await serviceB.runIndexAsync(arena.workspaceDir);
      expect(loserAsync.published).toBe(false);
      expect(loserAsync.snapshotId).toBe(winnerAsync.snapshotId);
      expect(loserAsync.stale).toBe(false);
      expect(
        loserAsync.warnings.some((w) => w.includes("concurrent") && w.includes("snapshot")),
      ).toBe(true);

      // Şimdi dosya değiştirip iki yeni servis örneğiyle runIncrementalIndexAsync yarışını sınayalım.
      writeFileSync(
        path.join(arena.workspaceDir, "src", "orders.ts"),
        "export function updatedOrder(): number { return 42; }\n",
        "utf8",
      );
      const repoC = new SqliteGraphRepository(arena.dbPath);
      const repoD = new SqliteGraphRepository(arena.dbPath);
      try {
        // Both runs see the change concurrently. Since Task 1.7 follow-up
        // (finding 6) the build lease is claimed BEFORE analysis, so the two
        // can no longer analyze at the same time (the former barrier that
        // forced both into analysis would now deadlock by design): exactly
        // one analyzes and publishes, the other waits for the live peer and
        // reuses its snapshot without analyzing (outcome reused_peer).
        let analyzeCalls = 0;
        const countingAnalyze = async () => {
          analyzeCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return stubAnalyzeCSharp();
        };

        const syncServiceC = new IndexService({
          workspaceId: "default",
          policy,
          repository: repoC,
          clock: () => T0,
          limits: { maxFiles: 100 },
          csharp: { analyzeCSharp: countingAnalyze },
          tolerateConcurrentPublishRace: true,
          peerPollIntervalMs: 20,
        });
        const syncServiceD = new IndexService({
          workspaceId: "default",
          policy,
          repository: repoD,
          clock: () => T1,
          limits: { maxFiles: 100 },
          csharp: { analyzeCSharp: countingAnalyze },
          tolerateConcurrentPublishRace: true,
          peerPollIntervalMs: 20,
        });

        const [incC, incD] = await Promise.all([
          syncServiceC.runIncrementalIndexAsync(arena.workspaceDir),
          syncServiceD.runIncrementalIndexAsync(arena.workspaceDir),
        ]);
        const publishedFlags = [incC.published, incD.published].sort();
        expect(publishedFlags).toEqual([false, true]);
        expect([incC.outcome, incD.outcome].sort()).toEqual(["published", "reused_peer"]);
        expect(analyzeCalls).toBe(1);
        expect(incC.snapshotId).toBe(incD.snapshotId);
        expect(repoC.getLatestPublished("default")?.stale).toBe(false);
      } finally {
        repoC.close();
        repoD.close();
      }
    } finally {
      repoA.close();
      repoB.close();
      arena.cleanup();
    }
  });

  it("graph/build-already-active yarışında yayımlanmış snapshot varsa runIndex, runIndexAsync ve runIncrementalIndexAsync zarifçe döner", async () => {
    const arena = createTempArena();
    const repoA = new SqliteGraphRepository(arena.dbPath);
    const repoB = new SqliteGraphRepository(arena.dbPath);
    try {
      const policy = createPolicy(arena.workspaceDir);
      const serviceA = new IndexService({
        workspaceId: "default",
        policy,
        repository: repoA,
        clock: () => T0,
        limits: { maxFiles: 100 },
        tolerateConcurrentPublishRace: true,
      });
      const initial = serviceA.runIndex(arena.workspaceDir);
      expect(initial.published).toBe(true);

      const serviceB = new IndexService({
        workspaceId: "default",
        policy,
        repository: repoB,
        clock: () => T1,
        limits: { maxFiles: 100 },
        tolerateConcurrentPublishRace: true,
        // Async runs now wait for a live peer; bound the wait for this test.
        peerPollIntervalMs: 20,
        peerWaitTimeoutMs: 200,
      });

      // Dosya değiştirilir ve repoA sequence=2 için aktif bir 'building' satırı + canlı lease açar.
      writeFileSync(
        path.join(arena.workspaceDir, "src", "orders.ts"),
        "export function activeBuildOrder(): string { return 'v2'; }\n",
        "utf8",
      );
      const activeBuild = repoA.beginBuild({
        workspaceId: "default",
        revision: { id: "working-tree", sequence: 2 },
        configHash: "cfg-hash",
        analyzerFingerprint: "fp-test",
        createdAt: T1,
      });
      repoA.acquireBuildLease({
        workspaceId: "default",
        buildId: activeBuild.buildId,
        leaseId: "lease-live-peer-a",
        ownerPid: process.pid,
        hostLabel: "claude-code",
        nowIso: T1,
        ttlMs: 30_000,
      });

      const syncFallback = serviceB.runIndex(arena.workspaceDir);
      expect(syncFallback.published).toBe(false);
      expect(syncFallback.outcome).toBe("peer_busy");
      expect(syncFallback.reused).toBe(true);
      expect(syncFallback.waitingForPeer).toBe(true);
      expect(syncFallback.peerStatus).toBe("waiting_for_peer");
      expect(syncFallback.snapshotId).toBe(initial.snapshotId);
      expect(syncFallback.stale).toBe(true);
      expect(
        syncFallback.warnings.some((w) => w.includes("concurrent") && w.includes("snapshot")),
      ).toBe(true);

      const asyncFallback = await serviceB.runIndexAsync(arena.workspaceDir);
      expect(asyncFallback.published).toBe(false);
      expect(asyncFallback.outcome).toBe("peer_busy");
      expect(asyncFallback.waitingForPeer).toBe(true);
      expect(asyncFallback.peerStatus).toBe("waiting_for_peer");
      expect(asyncFallback.snapshotId).toBe(initial.snapshotId);
      expect(asyncFallback.stale).toBe(true);

      const incFallback = await serviceB.runIncrementalIndexAsync(arena.workspaceDir);
      expect(incFallback.published).toBe(false);
      expect(incFallback.outcome).toBe("peer_busy");
      expect(incFallback.waitingForPeer).toBe(true);
      expect(incFallback.peerStatus).toBe("waiting_for_peer");
      expect(incFallback.snapshotId).toBe(initial.snapshotId);
      expect(incFallback.stale).toBe(true);

      repoA.failBuild(activeBuild.buildId, "test cleanup");
    } finally {
      repoA.close();
      repoB.close();
      arena.cleanup();
    }
  });

  it("hiç yayımlanmış snapshot yokken (latest === undefined) graph/build-already-active hatası yutulmaz (fail-closed)", () => {
    const arena = createTempArena();
    const repoA = new SqliteGraphRepository(arena.dbPath);
    const repoB = new SqliteGraphRepository(arena.dbPath);
    try {
      const policy = createPolicy(arena.workspaceDir);
      repoA.registerWorkspace({
        id: "default",
        rootPath: arena.workspaceDir,
        createdAt: T0,
      });
      const active = repoA.beginBuild({
        workspaceId: "default",
        revision: { id: "working-tree", sequence: 1 },
        configHash: "cfg-hash",
        analyzerFingerprint: "fp-test",
        createdAt: T0,
      });
      repoA.acquireBuildLease({
        workspaceId: "default",
        buildId: active.buildId,
        leaseId: "lease-live-peer-initial",
        ownerPid: process.pid,
        hostLabel: "codex",
        nowIso: T0,
        ttlMs: 30_000,
      });

      const serviceB = new IndexService({
        workspaceId: "default",
        policy,
        repository: repoB,
        clock: () => T1,
        limits: { maxFiles: 100 },
        tolerateConcurrentPublishRace: true,
      });

      expect(() => serviceB.runIndex(arena.workspaceDir)).toThrow(GraphRepositoryError);
      repoA.failBuild(active.buildId, "test cleanup");
    } finally {
      repoA.close();
      repoB.close();
      arena.cleanup();
    }
  });

  it(
    "çok adımlı sequence ilerlemesinde geride kalan süreç (runIndex, runIndexAsync, runIncrementalIndexAsync) bayat sequence yerine N+1 yayımlar ve eşzamanlı kopyaları tekilleştirir",
    { timeout: 120_000 },
    async () => {
    const arena = createTempArena();
    const repoA = new SqliteGraphRepository(arena.dbPath);
    const repoB = new SqliteGraphRepository(arena.dbPath);
    try {
      const policy = createPolicy(arena.workspaceDir);
      const serviceA = new IndexService({
        workspaceId: "default",
        policy,
        repository: repoA,
        clock: () => T0,
        limits: { maxFiles: 100 },
        tolerateConcurrentPublishRace: true,
      });
      const serviceB = new IndexService({
        workspaceId: "default",
        policy,
        repository: repoB,
        clock: () => T1,
        limits: { maxFiles: 100 },
        tolerateConcurrentPublishRace: true,
      });

      const ordersPath = path.join(arena.workspaceDir, "src", "orders.ts");

      // Adım 1: serviceA sequence=1 yayımlar (serviceB hâlâ runCount=0).
      const resA1 = serviceA.runIndex(arena.workspaceDir);
      expect(resA1.published).toBe(true);
      expect(resA1.snapshot.meta.revision.sequence).toBe(1);

      // Adım 2: dosya değişir -> serviceA sequence=2 yayımlar.
      writeFileSync(ordersPath, "export function orderStep2(): number { return 2; }\n", "utf8");
      const resA2 = serviceA.runIndex(arena.workspaceDir);
      expect(resA2.published).toBe(true);
      expect(resA2.snapshot.meta.revision.sequence).toBe(2);

      // Adım 3: dosyalar hâlâ v2 iken gerideki serviceB (runCount=0) koşar ->
      // birebir aynı içerik/fingerprint/configHash olduğundan sequence=2 ile tekilleşmeli!
      const resB2Dup = serviceB.runIndex(arena.workspaceDir);
      expect(resB2Dup.published).toBe(false);
      expect(resB2Dup.snapshotId).toBe(resA2.snapshotId);
      expect(resB2Dup.stale).toBe(false);

      // Adım 4: serviceA sequence=3 ve sequence=4'e ilerler (serviceB runCount=2'de kalır).
      writeFileSync(ordersPath, "export function orderStep3(): number { return 3; }\n", "utf8");
      const resA3 = serviceA.runIndex(arena.workspaceDir);
      expect(resA3.snapshot.meta.revision.sequence).toBe(3);

      writeFileSync(ordersPath, "export function orderStep4(): number { return 4; }\n", "utf8");
      const resA4 = serviceA.runIndex(arena.workspaceDir);
      expect(resA4.snapshot.meta.revision.sequence).toBe(4);

      // Adım 5: dosya v5 olur -> geride kalan serviceB (runCount=2 < latest=4) koştuğunda
      // sequence=3 DEĞİL sequence=5 yayımlamalı (stale=false, getLatestPublished v5 döner)!
      writeFileSync(ordersPath, "export function orderStep5(): number { return 5; }\n", "utf8");
      const resB5 = serviceB.runIndex(arena.workspaceDir);
      expect(resB5.published).toBe(true);
      expect(resB5.snapshot.meta.revision.sequence).toBe(5);
      expect(resB5.stale).toBe(false);
      expect(repoA.getLatestPublished("default")?.snapshot.meta.id).toBe(resB5.snapshotId);
      expect(repoA.getLatestPublished("default")?.stale).toBe(false);

      // Adım 6: async yolda da aynı monotonik ilerleme korunmalı (serviceB -> 6, 7; gerideki serviceA -> 8).
      writeFileSync(ordersPath, "export function orderStep6(): number { return 6; }\n", "utf8");
      const resB6 = await serviceB.runIndexAsync(arena.workspaceDir);
      expect(resB6.snapshot.meta.revision.sequence).toBe(6);

      writeFileSync(ordersPath, "export function orderStep7(): number { return 7; }\n", "utf8");
      const resB7 = await serviceB.runIndexAsync(arena.workspaceDir);
      expect(resB7.snapshot.meta.revision.sequence).toBe(7);

      writeFileSync(ordersPath, "export function orderStep8(): number { return 8; }\n", "utf8");
      const resA8 = await serviceA.runIncrementalIndexAsync(arena.workspaceDir);
      expect(resA8.published).toBe(true);
      expect(resA8.snapshot.meta.revision.sequence).toBe(8);
      expect(resA8.stale).toBe(false);
      expect(repoB.getLatestPublished("default")?.snapshot.meta.id).toBe(resA8.snapshotId);
      expect(repoB.getLatestPublished("default")?.stale).toBe(false);
    } finally {
      repoA.close();
      repoB.close();
      arena.cleanup();
    }
  });
});

describe(
  "IndexService — dinamik CAUSORYN_ASSET_ROOT keşfi ve Rust yazılabilir önbellek geçişi",
  { timeout: 30_000 },
  () => {
    it("CAUSORYN_ASSET_ROOT ile C# düz sidecar DLL, Python worker.py ve Go workerDir varsayılanlarını dinamik çözer", async () => {
      const tempRoot = mkdtempSync(path.join(tmpdir(), "causoryn-idx-asset-"));
      const fakeAssetRoot = path.join(tempRoot, "bundled-assets");
      const workspaceDir = path.join(tempRoot, "workspace");

      const savedEnv = {
        CAUSORYN_ASSET_ROOT: process.env["CAUSORYN_ASSET_ROOT"],
        CAUSORYN_ROSLYN_WORKER_DLL: process.env["CAUSORYN_ROSLYN_WORKER_DLL"],
        CAUSORYN_PYTHON_WORKER_SCRIPT: process.env["CAUSORYN_PYTHON_WORKER_SCRIPT"],
        CAUSORYN_GO_WORKER_BIN: process.env["CAUSORYN_GO_WORKER_BIN"],
        CAUSORYN_GO_WORKER_DIR: process.env["CAUSORYN_GO_WORKER_DIR"],
      };

      try {
        mkdirSync(path.join(fakeAssetRoot, "native", "python-worker"), { recursive: true });
        mkdirSync(path.join(fakeAssetRoot, "native", "roslyn-worker"), { recursive: true });
        mkdirSync(path.join(fakeAssetRoot, "native", "go-worker"), { recursive: true });
        mkdirSync(path.join(workspaceDir, "src"), { recursive: true });

        copyFileSync(
          path.join(REPO_ROOT, "native", "python-worker", "worker.py"),
          path.join(fakeAssetRoot, "native", "python-worker", "worker.py"),
        );
        const flatDllPath = path.join(
          fakeAssetRoot,
          "native",
          "roslyn-worker",
          "Causoryn.RoslynWorker.dll",
        );
        writeFileSync(flatDllPath, "flat-dll-placeholder", "utf8");

        writeFileSync(
          path.join(workspaceDir, "src", "billing.cs"),
          "namespace Demo { public class Billing {} }\n",
          "utf8",
        );
        writeFileSync(
          path.join(workspaceDir, "src", "billing.py"),
          "def compute_total(x: int) -> int:\n    return x\n",
          "utf8",
        );
        writeFileSync(
          path.join(workspaceDir, "src", "billing.go"),
          "package billing\nfunc Total() int { return 1 }\n",
          "utf8",
        );

        process.env["CAUSORYN_ASSET_ROOT"] = fakeAssetRoot;
        delete process.env["CAUSORYN_ROSLYN_WORKER_DLL"];
        delete process.env["CAUSORYN_PYTHON_WORKER_SCRIPT"];
        delete process.env["CAUSORYN_GO_WORKER_BIN"];
        delete process.env["CAUSORYN_GO_WORKER_DIR"];

        let seenWorkerDllPath: string | undefined;
        const captureAnalyzeCSharp = async (input: {
          readonly options?: { readonly workerDllPath?: string };
        }) => {
          seenWorkerDllPath = input.options?.workerDllPath;
          return {
            analyzerId: "roslyn-worker" as const,
            analyzerVersion: "0.1.0",
            workerAvailable: false,
            state: "partial" as const,
            coverageRatio: 0,
            capabilities: {
              astParse: false,
              symbolResolution: false,
              containsEdges: false,
              callEdges: false,
              importEdges: false,
              routeDetection: "worker-unavailable",
              frameworkLinkers: false,
            },
            unsupportedConstructs: [],
            nodes: [
              {
                kind: "File" as const,
                qualifiedName: "src/billing.cs",
                language: "csharp",
                relativePath: "src/billing.cs",
              },
            ],
            edges: [],
            evidence: [],
            diagnostics: [],
            warnings: ["stub csharp fallback"],
          };
        };

        const missingPyCmd = "causoryn-missing-python-bin";
        const missingGoCmd = "causoryn-missing-go-bin";

        const repo1 = new InMemoryGraphRepository();
        const service1 = new IndexService({
          workspaceId: "asset-test",
          policy: createPolicy(workspaceDir),
          repository: repo1,
          clock: () => T0,
          limits: { maxFiles: 100 },
          csharp: { analyzeCSharp: captureAnalyzeCSharp },
          python: { pythonCommand: missingPyCmd },
          go: { goBinaryPath: missingGoCmd },
        });

        const res1 = await service1.runIndexAsync(workspaceDir);
        expect(seenWorkerDllPath).toBe(flatDllPath);

        const expectedFp1 = buildAnalyzerFingerprint({
          typescript: null,
          csharp: {
            analyzerId: "roslyn-worker",
            version: "0.1.0",
            discovery: "worker-unavailable",
            refPacks: null,
            settings: {
              dotnetCommand: "dotnet",
              requestTimeoutMs: 30_000,
              workerDllPath: flatDllPath,
            },
          },
          python: {
            analyzerId: PYTHON_WORKER_ADAPTER_ID,
            version: PYTHON_WORKER_ADAPTER_VERSION,
            status: "worker-unavailable",
            settings: {
              pythonCommand: missingPyCmd,
              requestTimeoutMs: DEFAULT_PY_TIMEOUT_MS,
              workerScriptPath: path.join(fakeAssetRoot, "native", "python-worker", "worker.py"),
              responseMaxChars: DEFAULT_PY_MAX_CHARS,
            },
          },
          go: {
            analyzerId: GO_ADAPTER_ID,
            version: GO_ADAPTER_VERSION,
            status: "worker-unavailable",
            settings: {
              goBinaryPath: missingGoCmd,
              goWorkerBinaryPath: "",
              workerDir: path.join(fakeAssetRoot, "native", "go-worker"),
              requestTimeoutMs: DEFAULT_GO_TIMEOUT_MS,
            },
          },
        });
        expect(res1.snapshot.meta.analyzerFingerprint).toBe(expectedFp1);

        // Düz Causoryn.RoslynWorker.dll yoksa bin/Debug/net10.0 yoluna düşmeli:
        rmSync(flatDllPath, { force: true });
        let seenFallbackDllPath: string | undefined;
        const repo2 = new InMemoryGraphRepository();
        const service2 = new IndexService({
          workspaceId: "asset-test-2",
          policy: createPolicy(workspaceDir),
          repository: repo2,
          clock: () => T1,
          limits: { maxFiles: 100 },
          csharp: {
            analyzeCSharp: async (input) => {
              seenFallbackDllPath = input.options?.workerDllPath;
              return captureAnalyzeCSharp(input);
            },
          },
          python: { pythonCommand: DEFAULT_PYTHON_COMMAND },
          go: { goBinaryPath: DEFAULT_GO_BINARY_PATH },
        });
        service2.runIndex(workspaceDir);
        await service2.runIndexAsync(workspaceDir);
        expect(seenFallbackDllPath).toBe(
          path.join(
            fakeAssetRoot,
            "native",
            "roslyn-worker",
            "bin",
            "Debug",
            "net10.0",
            "Causoryn.RoslynWorker.dll",
          ),
        );
      } finally {
        for (const [key, val] of Object.entries(savedEnv)) {
          if (val === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = val;
          }
        }
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });

    it("options.rust.workerDir ve CAUSORYN_RUST_WORKER_DIR verilmediğinde workerDir zorlamaz; analyzeRustWorkspace yazılabilir önbellek ikilisini kullanır", async () => {
      const realBuiltWorker = path.join(
        REPO_ROOT,
        "native",
        "rust-worker",
        "target",
        "debug",
        WORKER_BINARY_NAME,
      );
      if (!existsSync(realBuiltWorker) && process.platform === "win32") {
        // Windows'ta derlenmiş .exe yoksa test dürüstçe atlanır.
        return;
      }

      const tempRoot = mkdtempSync(path.join(tmpdir(), "causoryn-idx-rust-cache-"));
      const fakeAssetRoot = path.join(tempRoot, "readonly-bundle-assets");
      const writableRustTargetDir = path.join(tempRoot, "writable-rust-cache");
      const cachedDebugDir = path.join(writableRustTargetDir, "debug");
      const workspaceDir = path.join(tempRoot, "workspace");

      const savedEnv = {
        CAUSORYN_ASSET_ROOT: process.env["CAUSORYN_ASSET_ROOT"],
        CAUSORYN_RUST_TARGET_DIR: process.env["CAUSORYN_RUST_TARGET_DIR"],
        CAUSORYN_RUST_WORKER_DIR: process.env["CAUSORYN_RUST_WORKER_DIR"],
      };

      try {
        // Asset kökünde rust-worker ikilisi YOK ama bütünlük parmak izi için Cargo.toml var;
        // yürütülebilir ikili ve doğrulanan .sha256.json kaydı yazılabilir önbellekte.
        mkdirSync(path.join(fakeAssetRoot, "native", "python-worker"), { recursive: true });
        writeFileSync(
          path.join(fakeAssetRoot, "native", "python-worker", "worker.py"),
          "# marker\n",
          "utf8",
        );
        const fakeRustManifest = path.join(fakeAssetRoot, "native", "rust-worker", "Cargo.toml");
        mkdirSync(path.dirname(fakeRustManifest), { recursive: true });
        writeFileSync(
          fakeRustManifest,
          '[package]\nname = "causoryn-rust-worker"\nversion = "0.1.0"\n',
          "utf8",
        );
        mkdirSync(cachedDebugDir, { recursive: true });
        mkdirSync(path.join(workspaceDir, "src"), { recursive: true });

        const cachedBinaryPath = path.join(cachedDebugDir, WORKER_BINARY_NAME);
        if (existsSync(realBuiltWorker)) {
          copyFileSync(realBuiltWorker, cachedBinaryPath);
          if (process.platform !== "win32") {
            chmodSync(cachedBinaryPath, 0o755);
          }
        } else {
          const fakeUnixWorker = [
            "#!/usr/bin/env node",
            'const fs = require("node:fs");',
            'const req = JSON.parse(fs.readFileSync(0, "utf8").trim());',
            "const res = {",
            "  id: req.id,",
            '  status: "ready",',
            "  coverageRatio: 1,",
            "  capabilities: { astParse: true, symbolResolution: true, containsEdges: true, callEdges: true, importEdges: true, routeDetection: \"none\", frameworkLinkers: false },",
            "  unsupportedConstructs: [],",
            "  warnings: [],",
            "  diagnostics: [],",
            '  nodes: [{ kind: "File", qualifiedName: "src/lib.rs", language: "rust", relativePath: "src/lib.rs" }, { kind: "Function", qualifiedName: "compute_shipping", language: "rust", relativePath: "src/lib.rs" }],',
            "  edges: [],",
            "  evidence: [],",
            "};",
            "process.stdout.write(JSON.stringify(res) + \"\\n\");",
            "",
          ].join("\n");
          writeFileSync(cachedBinaryPath, fakeUnixWorker, "utf8");
          chmodSync(cachedBinaryPath, 0o755);
        }

        const {
          computeRustWorkerSourceFingerprint,
          readRegularFileSha256NoFollow,
          rustWorkerIntegrityPath,
        } = await import("../../../adapters/rust/src/analyzer.js");
        const sourceFingerprint = computeRustWorkerSourceFingerprint(fakeRustManifest);
        const binarySha256 = readRegularFileSha256NoFollow(cachedBinaryPath);
        expect(sourceFingerprint).not.toBeNull();
        expect(binarySha256).not.toBeNull();
        writeFileSync(
          rustWorkerIntegrityPath(cachedBinaryPath),
          JSON.stringify({ sourceFingerprint, binarySha256 }, null, 2),
          "utf8",
        );

        writeFileSync(
          path.join(workspaceDir, "src", "lib.rs"),
          "pub fn compute_shipping(weight: i64) -> i64 { weight * 2 }\n",
          "utf8",
        );

        process.env["CAUSORYN_ASSET_ROOT"] = fakeAssetRoot;
        process.env["CAUSORYN_RUST_TARGET_DIR"] = writableRustTargetDir;
        delete process.env["CAUSORYN_RUST_WORKER_DIR"];

        // 1) Varsayılan (workerDir override edilmemiş): önbellekteki ikili bulunup semboller çıkarılmalı!
        const repoImplicit = new InMemoryGraphRepository();
        const serviceImplicit = new IndexService({
          workspaceId: "rust-cache-implicit",
          policy: createPolicy(workspaceDir),
          repository: repoImplicit,
          clock: () => T0,
          limits: { maxFiles: 100 },
        });
        const implicitRun = await serviceImplicit.runIndexAsync(workspaceDir);
        expect(implicitRun.state).toBe("ready");
        expect(
          implicitRun.snapshot.nodes.some(
            (n) => n.kind === "Function" && n.qualifiedName.includes("compute_shipping"),
          ),
        ).toBe(true);

        // 2) Açık options.rust.workerDir verildiğinde ise override onurlandırılmalı (önbelleğe düşmemeli):
        const repoExplicit = new InMemoryGraphRepository();
        const serviceExplicit = new IndexService({
          workspaceId: "rust-cache-explicit",
          policy: createPolicy(workspaceDir),
          repository: repoExplicit,
          clock: () => T1,
          limits: { maxFiles: 100 },
          rust: { workerDir: path.join(tempRoot, "missing-explicit-worker-dir") },
        });
        const explicitRun = await serviceExplicit.runIndexAsync(workspaceDir);
        expect(explicitRun.state).toBe("partial");
        expect(explicitRun.snapshot.meta.analyzerFingerprint).toContain(
          "ruststate=worker-unavailable",
        );
      } finally {
        for (const [key, val] of Object.entries(savedEnv)) {
          if (val === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = val;
          }
        }
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  },
);
