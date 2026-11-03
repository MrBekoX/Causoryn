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

import { IndexService, IndexingError } from "../src/index.js";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";
import { InMemoryGraphRepository } from "@causoryn/graph";
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

describe("IndexService — minimal pipeline (envanter → adapter → graph → snapshot)", () => {
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
