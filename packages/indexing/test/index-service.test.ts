import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * IndexService minimal pipeline test üçlüleri (TŞ v2.1 §9 Incremental
 * pipeline, §25/4-5; sprint-1 görev 6'nın indexing dilimi).
 *
 * Pozitif: fixture-ts-orders üzerinde dosya envanteri (WorkspaceAccessPolicy
 * ile) → TS adapter → graph inşası → atomik snapshot publish. Kontroller:
 * Workspace node + CONTAINS kenarları, verified CALLS kanıt zinciri,
 * envanter kayıtları, determinizm.
 * Negatif: yetkisiz kök reddedilir; maxFiles aşımı limit-exceeded'dır.
 * Partial: boş workspace → state "partial" + uyarı; bozuk TS dosyası
 * analizi düşürmez — diagnostics toplanır, sağlam dosya indekslenir.
 *
 * Testler depoya YAZMAZ: fixture examples/fixture-ts-orders salt-okunur
 * okunur (ADR-008); geçici fixture'lar yalnızca os.tmpdir() altında
 * oluşturulur ve her test sonunda silinir.
 */

import { IndexService, IndexingError, INDEXED_ADAPTERS } from "../src/index.js";
import { TS_ADAPTER_FRAMEWORK_LINKERS } from "@causoryn/adapter-typescript";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";
import { InMemoryGraphRepository } from "@causoryn/graph";
import type {
  SymbolIndexEntry,
  SymbolSearchHit,
  SymbolSearchStore,
} from "@causoryn/graph";
import { sha256Hex, utf8Encode } from "@causoryn/domain";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");
const FIXED_NOW = "2026-11-02T00:00:00.000Z";

const FIXTURE_BOUNDARY = FIXTURE_ROOT.endsWith(path.sep)
  ? FIXTURE_ROOT
  : FIXTURE_ROOT + path.sep;

/** Fixture kökü ile sınırlı okuma: resolve + kök sınırı doğrulaması. */
function resolveWithinFixture(relativePath: string): string {
  const target = path.resolve(FIXTURE_ROOT, relativePath);
  if (target !== FIXTURE_ROOT && !target.startsWith(FIXTURE_BOUNDARY)) {
    throw new Error(`Fixture kökü dışına erişim reddedildi: ${relativePath}`);
  }
  return target;
}

/** fixture-ts-orders'ın diskteki tüm dosyaları (göreli POSIX yolları). */
function collectFixtureFiles(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectFixtureFiles(resolveWithinFixture(rel), rel));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

function makeService(
  repository: InMemoryGraphRepository,
  options: { readonly workspaceId?: string; readonly maxFiles?: number } = {},
): IndexService {
  const workspaceId = options.workspaceId ?? "default";
  const policy = WorkspaceAccessPolicy.create({ allowRoots: [FIXTURE_ROOT] });
  return new IndexService({
    workspaceId,
    policy,
    repository,
    clock: () => FIXED_NOW,
    limits: { maxFiles: options.maxFiles ?? 50_000 },
  });
}

// Zaman bütçesi: bu suite'teki testler IndexService.runIndex → TS Program
// inşası (ts.createProgram) yürüten CPU-bağlı senkron testlerdir; İLK test
// ayrıca TypeScript derleyicisinin soğuk başlangıcını üstlenir. Tüm suite
// paralel worker'larla koştiğinde kontansiyon bu testleri vitest varsayılan
// 5000ms limitinin üzerine taşıyabilir (vitest 5, limiti aşan senkron testi
// assertion'lar geçse de reddeder). framework-linkers.test.ts ve
// job-manager.test.ts ile aynı kural: açık 30s limiti — assertion
// gevşetmesi yoktur, yalnızca yük altı çalışma bütçesi.
describe("IndexService — minimal pipeline (envanter → adapter → graph → snapshot)", { timeout: 30_000 }, () => {
  it("pozitif: fixture indekslenir; Workspace node + CONTAINS + verified CALLS zinciri snapshot'ta", () => {
    const repository = new InMemoryGraphRepository();
    const service = makeService(repository);
    const run = service.runIndex(FIXTURE_ROOT);

    expect(run.snapshot.meta.state).toBe("ready");
    expect(run.stale).toBe(false);
    expect(run.snapshotId).toBe(run.snapshot.meta.id);

    // Envanter: fixture'daki her dosya bir FileRecord oldu; TS alt kümesi
    // adapter'a gitti.
    const expectedFiles = collectFixtureFiles(FIXTURE_ROOT, "");
    const expectedTsFiles = expectedFiles.filter((f) => f.endsWith(".ts"));
    expect(expectedFiles.length).toBeGreaterThanOrEqual(5);
    expect(run.fileCount).toBe(expectedFiles.length);
    expect(run.tsFileCount).toBe(expectedTsFiles.length);
    const records = repository.listFiles("default");
    expect(records.map((r) => r.relativePath)).toEqual(expectedFiles);
    const serviceRecord = records.find(
      (r) => r.relativePath === "src/services/orders-service.ts",
    );
    const expectedHash = sha256Hex(
      utf8Encode(
        readFileSync(resolveWithinFixture("src/services/orders-service.ts"), "utf8"),
      ),
    );
    expect(serviceRecord?.contentHash).toBe(expectedHash);

    // Graph: Workspace node + her TS dosyası için CONTAINS kenarı.
    const workspaceNode = run.snapshot.nodes.find(
      (n) => n.kind === "Workspace" && n.qualifiedName === "default",
    );
    expect(workspaceNode).toBeDefined();
    const fileNodes = run.snapshot.nodes.filter((n) => n.kind === "File");
    expect(fileNodes.length).toBe(expectedTsFiles.length);
    const containsEdges = run.snapshot.edges.filter((e) => e.kind === "CONTAINS");
    // Adapter da File→sembol CONTAINS üretir; workspace düzeyi CONTAINS
    // tam olarak TS dosya sayısı kadardır ve hepsi Workspace node'dan çıkar.
    const workspaceContains = containsEdges.filter((e) => e.from === workspaceNode?.id);
    expect(containsEdges.length).toBeGreaterThan(expectedTsFiles.length);
    expect(workspaceContains.length).toBe(expectedTsFiles.length);
    for (const edge of workspaceContains) {
      expect(edge.from).toBe(workspaceNode?.id);
      expect(edge.evidenceIds.length).toBeGreaterThanOrEqual(1);
    }

    // Kanıt zinciri: OrdersService.create → OrderRepository.save (verified,
    // kanıtlı; TŞ §25/4). Snapshot birden çok CALLS kenarı içerir; zincir
    // kenarı uçlarının qualifiedName'leriyle aranır.
    const byId = new Map(run.snapshot.nodes.map((n) => [n.id, n]));
    const callsEdges = run.snapshot.edges.filter((e) => e.kind === "CALLS");
    const chainEdge = callsEdges.find(
      (e) =>
        byId.get(e.from)?.qualifiedName === "OrdersService.create" &&
        byId.get(e.to)?.qualifiedName === "OrderRepository.save",
    );
    expect(chainEdge).toBeDefined();
    expect(chainEdge?.resolution).toBe("verified");
    expect(chainEdge?.evidenceIds.length).toBe(1);
    const chainEvidenceId = chainEdge?.evidenceIds[0];
    const chainEvidence = run.snapshot.evidence.find((ev) => ev.id === chainEvidenceId);
    expect(chainEvidence?.span?.relativePath).toBe("src/services/orders-service.ts");
    expect(chainEvidence?.span?.startLine).toBeGreaterThan(0);

    // Endpoint + ROUTES_TO: POST /orders route kaydı (TŞ §25/4).
    const endpoint = run.snapshot.nodes.find((n) => n.kind === "Endpoint");
    expect(endpoint?.qualifiedName).toBe("POST /orders");
    expect(run.snapshot.edges.some((e) => e.kind === "ROUTES_TO")).toBe(true);
  });

  it("pozitif: determinizm — aynı girdiyle iki ayrı servis aynı snapshot ID ve JSON'u üretir", () => {
    const first = makeService(new InMemoryGraphRepository()).runIndex(FIXTURE_ROOT);
    const second = makeService(new InMemoryGraphRepository()).runIndex(FIXTURE_ROOT);
    expect(first.snapshot.meta.id).toBe(second.snapshot.meta.id);
    expect(JSON.stringify(first.snapshot)).toBe(JSON.stringify(second.snapshot));
  });

  it("negatif: allowRoot dışındaki kök indexing/root-not-authorized ile reddedilir", () => {
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [] });
    const service = new IndexService({
      workspaceId: "default",
      policy,
      repository: new InMemoryGraphRepository(),
      clock: () => FIXED_NOW,
      limits: { maxFiles: 50_000 },
    });
    let caught: unknown;
    try {
      service.runIndex(FIXTURE_ROOT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IndexingError);
    expect((caught as IndexingError).code).toBe("indexing/root-not-authorized");
  });

  it("negatif: maxFiles aşımı indexing/limit-exceeded ile reddedilir", () => {
    const service = makeService(new InMemoryGraphRepository(), { maxFiles: 2 });
    let caught: unknown;
    try {
      service.runIndex(FIXTURE_ROOT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IndexingError);
    expect((caught as IndexingError).code).toBe("indexing/limit-exceeded");
  });

  it("partial: boş workspace → state partial + uyarı; tek Workspace node'u", () => {
    const emptyRoot = mkdtempSync(path.join(tmpdir(), "causoryn-empty-"));
    try {
      const policy = WorkspaceAccessPolicy.create({ allowRoots: [emptyRoot] });
      const service = new IndexService({
        workspaceId: "empty",
        policy,
        repository: new InMemoryGraphRepository(),
        clock: () => FIXED_NOW,
        limits: { maxFiles: 50_000 },
      });
      const run = service.runIndex(emptyRoot);
      expect(run.snapshot.meta.state).toBe("partial");
      expect(run.warnings.length).toBeGreaterThanOrEqual(1);
      expect(run.tsFileCount).toBe(0);
      const nodeKinds = new Set(run.snapshot.nodes.map((n) => n.kind));
      expect(nodeKinds.has("Workspace")).toBe(true);
      expect(run.snapshot.edges.length).toBe(0);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("partial: bozuk TS dosyası analizi düşürmez — diagnostics toplanır, sağlam dosya indekslenir", () => {
    const root = mkdtempSync(path.join(tmpdir(), "causoryn-broken-"));
    try {
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(
        path.join(root, "src", "good.ts"),
        "export class Good { ping(): number { return 1; } }\n",
        "utf8",
      );
      writeFileSync(
        path.join(root, "src", "broken.ts"),
        "export class Broken { this is not === valid typescript ((( \n",
        "utf8",
      );
      const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
      const service = new IndexService({
        workspaceId: "broken",
        policy,
        repository: new InMemoryGraphRepository(),
        clock: () => FIXED_NOW,
        limits: { maxFiles: 50_000 },
      });
      const run = service.runIndex(root);
      expect(run.snapshot.meta.state).toBe("partial");
      expect(run.diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(run.warnings.some((w) => w.includes("broken.ts"))).toBe(true);
      const qualifiedNames = run.snapshot.nodes.map((n) => n.qualifiedName);
      expect(qualifiedNames).toContain("Good.ping");
      // Bozuk dosyanın düğümü (File node) yine de envanterde var; sınıf
      // düğümü üretilmemiş olabilir.
      expect(qualifiedNames).toContain("src/broken.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* runIncrementalIndex — Live Architecture dilimi (sprint-2 B7, TŞ §9) */
/* ------------------------------------------------------------------ */

describe("IndexService.runIncrementalIndex — karma tabanlı incremental (sprint-2 B7)", { timeout: 30_000 }, () => {
  const APP_V1 =
    "export interface Order { id: string; total: number }\n" +
    "export function createOrder(input: Order): Order { return { ...input } }\n";
  const APP_V2 =
    APP_V1 + 'export function exportedExtra(): string { return "extra"; }\n';

  function makeTempService(
    repository: InMemoryGraphRepository,
    root: string,
  ): IndexService {
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    return new IndexService({
      workspaceId: "default",
      policy,
      repository,
      clock: () => FIXED_NOW,
      limits: { maxFiles: 50_000 },
    });
  }

  /** Sınır denetimli fixture yazarı: tüm yollar kök içinde kalmak zorunda. */
  function makeTempRoot(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), "causoryn-incremental-"));
    for (const [relativePath, content] of Object.entries(files)) {
      if (relativePath.length === 0 || relativePath.includes("\0")) {
        throw new Error(`fixture yolu geçersiz: ${relativePath}`);
      }
      const absolute = path.resolve(root, relativePath);
      if (absolute === root || !absolute.startsWith(root + path.sep)) {
        throw new Error(`fixture yolu kök dışına çıkıyor: ${relativePath}`);
      }
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, "utf8");
    }
    return root;
  }

  it("pozitif: TS içerik değişimi → YENİ snapshot yayımlanır (published=true), değişen dosya yeniden analiz edilir", () => {
    const root = makeTempRoot({ "src/app.ts": APP_V1 });
    try {
      const repository = new InMemoryGraphRepository();
      const service = makeTempService(repository, root);
      const first = service.runIndex(root);
      expect(first.published).toBe(true);

      writeFileSync(path.join(root, "src", "app.ts"), APP_V2, "utf8");
      const second = service.runIncrementalIndex(root, ["src/app.ts"]);

      expect(second.published).toBe(true);
      expect(second.snapshotId).not.toBe(first.snapshotId);
      expect(second.snapshot.meta.revision.sequence).toBe(
        first.snapshot.meta.revision.sequence + 1,
      );
      // Değişen dosyanın YENİ sembolü graph'ta (yeniden analiz kanıtı).
      expect(
        second.snapshot.nodes.some((node) =>
          node.qualifiedName.includes("exportedExtra"),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pozitif (no-op): TS-dışı değişim → mevcut snapshot KORUNUR (published=false), files tablosu tazelenir", () => {
    const root = makeTempRoot({ "src/app.ts": APP_V1 });
    try {
      const repository = new InMemoryGraphRepository();
      const service = makeTempService(repository, root);
      const first = service.runIndex(root);

      writeFileSync(path.join(root, "README.md"), "# dok\n", "utf8");
      const second = service.runIncrementalIndex(root, ["README.md"]);

      expect(second.published).toBe(false);
      expect(second.snapshotId).toBe(first.snapshotId);
      expect(second.state).toBe("ready");
      expect(
        repository
          .listFiles("default")
          .some((file) => file.relativePath === "README.md"),
      ).toBe(true);
      expect(second.warnings.some((line) => line.includes("no-op"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pozitif: silinen TS dosyası → rebuild; yeni snapshot dosya node'unu içermez", () => {
    const root = makeTempRoot({
      "src/app.ts": APP_V1,
      "src/gone.ts": "export function leaving(): number { return 1; }\n",
    });
    try {
      const repository = new InMemoryGraphRepository();
      const service = makeTempService(repository, root);
      const first = service.runIndex(root);
      expect(
        first.snapshot.nodes.some((node) =>
          node.qualifiedName.includes("leaving"),
        ),
      ).toBe(true);

      rmSync(path.join(root, "src", "gone.ts"));
      const second = service.runIncrementalIndex(root, ["src/gone.ts"]);

      expect(second.published).toBe(true);
      expect(second.snapshotId).not.toBe(first.snapshotId);
      expect(
        second.snapshot.nodes.some((node) =>
          node.qualifiedName.includes("leaving"),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("negatif: yetkisiz kök incremental'de de IndexingError ile reddedilir", () => {
    const root = makeTempRoot({ "src/app.ts": APP_V1 });
    try {
      const policy = WorkspaceAccessPolicy.create({ allowRoots: [] });
      const service = new IndexService({
        workspaceId: "default",
        policy,
        repository: new InMemoryGraphRepository(),
        clock: () => FIXED_NOW,
        limits: { maxFiles: 50_000 },
      });
      let caught: unknown;
      try {
        service.runIncrementalIndex(root, ["src/app.ts"]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(IndexingError);
      expect((caught as IndexingError).code).toBe("indexing/root-not-authorized");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("determinizm: aynı içerik için incremental rebuild ile ilk-kez full koşumun graph içeriği birebir aynıdır", () => {
    // A: full(C1) → C2'ye değişim → incremental (rebuild)
    const rootA = makeTempRoot({ "src/app.ts": APP_V1 });
    // B: doğrudan full(C2)
    const rootB = makeTempRoot({ "src/app.ts": APP_V2 });
    try {
      const repoA = new InMemoryGraphRepository();
      const serviceA = makeTempService(repoA, rootA);
      serviceA.runIndex(rootA);
      writeFileSync(path.join(rootA, "src", "app.ts"), APP_V2, "utf8");
      const viaIncremental = serviceA.runIncrementalIndex(rootA, ["src/app.ts"]);

      const repoB = new InMemoryGraphRepository();
      const serviceB = makeTempService(repoB, rootB);
      const viaFull = serviceB.runIndex(rootB);

      // Snapshot ID revision.sequence içerdiğinden farklıdır (koşum sayısı);
      // graph İÇERİĞİ (node/edge/evidence) aynı girdiden birebir aynıdır.
      // Workspace node'un rootPath attribute'u temp dizin adını taşır —
      // karşılaştırma dışıdır (ortam yolu, içerik değil).
      expect(viaIncremental.published).toBe(true);
      expect(viaFull.published).toBe(true);
      const stripWorkspace = (nodes: readonly { readonly kind: string }[]): readonly unknown[] =>
        nodes.filter((node) => node.kind !== "Workspace");
      expect(JSON.stringify(stripWorkspace(viaIncremental.snapshot.nodes))).toBe(
        JSON.stringify(stripWorkspace(viaFull.snapshot.nodes)),
      );
      expect(JSON.stringify(viaIncremental.snapshot.edges)).toBe(
        JSON.stringify(viaFull.snapshot.edges),
      );
      expect(JSON.stringify(viaIncremental.snapshot.evidence)).toBe(
        JSON.stringify(viaFull.snapshot.evidence),
      );
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* Adapter metadata tutarlılığı (denetim bulgusu 1)                    */
/* ------------------------------------------------------------------ */

describe("INDEXED_ADAPTERS — adapter yetenek metadata'sı", () => {
  it("frameworkLinkers metadata'sı adapter'ın aktif linker beyanıyla tutarlıdır", () => {
    // B3 ile TS adapter framework linker'ları aktif oldu; metadata 'yok'
    // kalmıştı ve get_capabilities üzerinden MCP yüzeyine bayat değer
    // taşıyordu. Metadata artık adapter'ın TS_ADAPTER_FRAMEWORK_LINKERS
    // beyanından türetilir (tek doğruluk kaynağı).
    // B9 ile ikinci dil adapter'ı (csharp-roslyn) kaydedildi — kayıt
    // sırası korunur: ilk giriş TS, ikinci C# (index-service-csharp.test.ts
    // C# metadata sözleşmesini ayrıca doğrular).
    // M2 ile python/go/rust sidecar kayıtları eklendi (toplam 5; ayrıntılı
    // metadata sözleşmesi index-service-multilang.test.ts'te).
    expect(INDEXED_ADAPTERS).toHaveLength(5);
    const adapter = INDEXED_ADAPTERS[0] as (typeof INDEXED_ADAPTERS)[number];
    expect(adapter.language).toBe("typescript");
    expect(adapter.levels.frameworkLinkers).toBe("express+nextjs");
    expect(adapter.levels.frameworkLinkers).toBe(
      TS_ADAPTER_FRAMEWORK_LINKERS.join("+"),
    );
  });
});

/* ------------------------------------------------------------------ */
/* Güvenlik bulgusu 3: silinen dosya files tablosundan düşürülmeli     */
/* ------------------------------------------------------------------ */

describe("IndexService silme mutabakatı — güvenlik bulgusu 3", { timeout: 30_000 }, () => {
  function makeTmpWorkspace(): string {
    const root = mkdtempSync(path.join(tmpdir(), "causoryn-del-"));
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "a.ts"),
      "export class A { ping(): number { return 1; } }\n",
      "utf8",
    );
    writeFileSync(
      path.join(root, "src", "b.ts"),
      "export class B { pong(): number { return 2; } }\n",
      "utf8",
    );
    writeFileSync(path.join(root, "notes.md"), "# notlar\n", "utf8");
    return root;
  }

  /** allowRoot'u geçici kök olan servis (silme senaryoları kök-değişimlidir). */
  function makeTmpService(repository: InMemoryGraphRepository, root: string, workspaceId: string): IndexService {
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    return new IndexService({
      workspaceId,
      policy,
      repository,
      clock: () => FIXED_NOW,
      limits: { maxFiles: 50_000 },
    });
  }

  it("full runIndex: silinen dosyanın files kaydı düşürülür (ghost kayıt yok)", () => {
    const root = makeTmpWorkspace();
    try {
      const repository = new InMemoryGraphRepository();
      const service = makeTmpService(repository, root, "del-full");
      service.runIndex(root);
      expect(repository.listFiles("del-full").length).toBe(3);

      rmSync(path.join(root, "src", "a.ts"));
      service.runIndex(root);

      const paths = repository
        .listFiles("del-full")
        .map((record) => record.relativePath);
      expect(paths).toEqual(["notes.md", "src/b.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("incremental (silinen TS): yeniden yayımlanır ve files kaydı düşürülür", () => {
    const root = makeTmpWorkspace();
    try {
      const repository = new InMemoryGraphRepository();
      const service = makeTmpService(repository, root, "del-inc");
      service.runIndex(root);
      rmSync(path.join(root, "src", "a.ts"));

      const run = service.runIncrementalIndex(root, ["src/a.ts"]);
      expect(run.published).toBe(true);
      const paths = repository
        .listFiles("del-inc")
        .map((record) => record.relativePath);
      expect(paths).toEqual(["notes.md", "src/b.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("incremental no-op (silinen TS-dışı): snapshot korunur ama files kaydı düşürülür", () => {
    const root = makeTmpWorkspace();
    try {
      const repository = new InMemoryGraphRepository();
      const service = makeTmpService(repository, root, "del-noop");
      service.runIndex(root);
      rmSync(path.join(root, "notes.md"));

      const run = service.runIncrementalIndex(root, ["notes.md"]);
      expect(run.published).toBe(false);
      const paths = repository
        .listFiles("del-noop")
        .map((record) => record.relativePath);
      expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* Kalıcı depo uyumu: runCount başlangıcı, symbol_fts ve L0 yükseltme  */
/* ------------------------------------------------------------------ */

class SearchableInMemoryRepository
  extends InMemoryGraphRepository
  implements SymbolSearchStore
{
  readonly indexedBatches: Array<{
    readonly snapshotId: string;
    readonly entries: readonly SymbolIndexEntry[];
  }> = [];

  indexSymbols(snapshotId: string, entries: readonly SymbolIndexEntry[]): void {
    this.indexedBatches.push({ snapshotId, entries: [...entries] });
  }

  searchSymbols(
    query: string,
    limit = 20,
    snapshotId?: string,
  ): readonly SymbolSearchHit[] {
    const q = query.trim().toLowerCase();
    const hits: SymbolSearchHit[] = [];
    for (const batch of this.indexedBatches) {
      if (snapshotId !== undefined && batch.snapshotId !== snapshotId) continue;
      for (const entry of batch.entries) {
        if (entry.symbol.toLowerCase().includes(q)) {
          hits.push({
            symbol: entry.symbol,
            nodeId: entry.nodeId,
            snapshotId: batch.snapshotId,
          });
          if (hits.length >= limit) return hits;
        }
      }
    }
    return hits;
  }
}

describe("IndexService — kalıcı depo yeniden başlatma, symbol_fts ve L0 yükseltme", { timeout: 30_000 }, () => {
  it("yeniden başlatma: mevcut yayınlanmış snapshot varsa runCount onun revision.sequence değerinden başlar", () => {
    const repository = new InMemoryGraphRepository();
    const firstService = makeService(repository);
    const firstRun = firstService.runIndex(FIXTURE_ROOT);
    expect(firstRun.snapshot.meta.revision.sequence).toBe(1);

    const restartedService = makeService(repository);
    const secondRun = restartedService.runIndex(FIXTURE_ROOT);
    expect(secondRun.snapshot.meta.revision.sequence).toBe(2);
    expect(secondRun.snapshotId).not.toBe(firstRun.snapshotId);
  });

  it("symbol_fts beslemesi: SymbolSearchStore destekleyen depoda publish sonrası sembol düğümleri indekslenir", async () => {
    const repository = new SearchableInMemoryRepository();
    const service = makeService(repository);

    const syncRun = service.runIndex(FIXTURE_ROOT);
    expect(repository.indexedBatches).toHaveLength(1);
    expect(repository.indexedBatches[0]?.snapshotId).toBe(syncRun.snapshotId);

    const nodesById = new Map(syncRun.snapshot.nodes.map((n) => [n.id, n]));
    const syncEntries = repository.indexedBatches[0]?.entries ?? [];
    expect(syncEntries.length).toBeGreaterThan(0);
    for (const entry of syncEntries) {
      const node = nodesById.get(entry.nodeId);
      expect(node).toBeDefined();
      expect(node?.kind).not.toBe("Workspace");
      expect(node?.kind).not.toBe("File");
      expect(node?.kind).not.toBe("UnknownExternal");
      expect(entry.symbol).toBe(node?.qualifiedName);
    }
    expect(syncEntries.map((e) => e.symbol)).toContain("OrdersService");
    expect(syncEntries.map((e) => e.symbol)).toContain("OrdersService.create");

    const asyncRun = await service.runIndexAsync(FIXTURE_ROOT);
    expect(repository.indexedBatches).toHaveLength(2);
    expect(repository.indexedBatches[1]?.snapshotId).toBe(asyncRun.snapshotId);

    const emptyRoot = mkdtempSync(path.join(tmpdir(), "causoryn-fts-empty-"));
    try {
      const emptyRepo = new SearchableInMemoryRepository();
      const emptyPolicy = WorkspaceAccessPolicy.create({ allowRoots: [emptyRoot] });
      const emptyService = new IndexService({
        workspaceId: "empty-fts",
        policy: emptyPolicy,
        repository: emptyRepo,
        clock: () => FIXED_NOW,
        limits: { maxFiles: 50_000 },
      });
      emptyService.runIndex(emptyRoot);
      expect(emptyRepo.indexedBatches).toHaveLength(0);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("runIncrementalIndexAsync upgrade guard: sync-run-degraded L0 snapshot dosya değişmese de tam analize yükseltilir", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "causoryn-inc-upgrade-"));
    try {
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(
        path.join(root, "src", "app.ts"),
        "export function greetOrder(): string { return 'ok'; }\n",
        "utf8",
      );
      writeFileSync(
        path.join(root, "src", "worker.py"),
        "def compute_invoice(amount: int) -> int:\n    return amount * 2\n",
        "utf8",
      );
      const repository = new InMemoryGraphRepository();
      const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
      const service = new IndexService({
        workspaceId: "upgrade-ws",
        policy,
        repository,
        clock: () => FIXED_NOW,
        limits: { maxFiles: 50_000 },
      });

      const syncRun = service.runIndex(root);
      expect(syncRun.snapshot.meta.analyzerFingerprint).toContain("sync-run-degraded");

      const upgraded = await service.runIncrementalIndexAsync(root);
      expect(upgraded.published).toBe(true);
      expect(upgraded.snapshotId).not.toBe(syncRun.snapshotId);
      expect(upgraded.snapshot.meta.analyzerFingerprint).not.toContain("sync-run-degraded");

      const repeatNoOp = await service.runIncrementalIndexAsync(root);
      expect(repeatNoOp.published).toBe(false);
      expect(repeatNoOp.snapshotId).toBe(upgraded.snapshotId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("v0.2.1 polyglot: iki dil adapter'ı aynı relativePath=null UnknownExternal düğümünü (örn. Request) ürettiğinde çökmez, kanonik düğümü paylaşır", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "causoryn-polyglot-ext-"));
    try {
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(
        path.join(root, "src", "client.ts"),
        "export function sendReq() { return SharedExternalCall('/api'); }\n",
        "utf8",
      );
      writeFileSync(
        path.join(root, "src", "handler.py"),
        "def handle():\n    return SharedExternalCall('/api')\n",
        "utf8",
      );
      const repository = new InMemoryGraphRepository();
      const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
      const service = new IndexService({
        workspaceId: "polyglot-ws",
        policy,
        repository,
        clock: () => FIXED_NOW,
        limits: { maxFiles: 50_000 },
      });

      const run = await service.runIndexAsync(root);
      expect(run.snapshot.nodes.some((n) => n.kind === "File" && n.location?.relativePath === "src/client.ts")).toBe(true);
      expect(run.snapshot.nodes.some((n) => n.kind === "File" && n.location?.relativePath === "src/handler.py")).toBe(true);
      const sharedExternal = run.snapshot.nodes.filter(
        (n) => n.kind === "UnknownExternal" && n.qualifiedName === "SharedExternalCall",
      );
      expect(sharedExternal).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
