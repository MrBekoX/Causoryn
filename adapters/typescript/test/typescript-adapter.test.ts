import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * TypeScript Language Adapter test üçlüleri (TŞ v2.1 §7, §7.1, §8, §25/4;
 * sprint-1 görev 4).
 *
 * Pozitif: fixture-ts-orders üzerinden POST /orders → OrdersService →
 * repository kanıt zinciri (dosya+satır içerikleri fixture ile birebir
 * eşleşir) + CONTAINS/IMPORTS/CALLS/ROUTES_TO kenarları + domain
 * invariant'ları.
 * Negatif: uydurulmuş kenar YOK — çözülemeyen çağrı/import için açık
 * UnknownExternal node + resolution=unresolved; uydurma Function/Method
 * node'u icat edilmez; geçersiz girdi DomainError ile reddedilir.
 * Partial: tek dosyadaki parse hatası analizi düşürmez; diagnostics
 * toplanır; sağlıklı zincir ayakta kalır.
 * Determinizm: aynı girdi → bit-bit aynı graph JSON (TŞ §8 invariant vi).
 *
 * Testler salt okunurdur: fixture diskten okunur, hatalı dosya içeriği
 * bellekte üretilir; depoya hiçbir şey yazılmaz (ADR-008). Tüm disk
 * okumaları same-root sınır denetiminden geçer (path traversal koruması).
 */

import {
  TS_ADAPTER_ANALYZER_ID,
  analyzeTypeScriptProgram,
  type TypeScriptAdapterResult,
} from "../src/index.js";
import {
  createSnapshot,
  DomainError,
  sha256Hex,
  snapshotCanonicalJson,
  utf8Encode,
} from "@causoryn/domain";
import type { SnapshotEdgeInput, SnapshotNodeInput } from "@causoryn/domain";

/* ------------------------------------------------------------------ */
/* Salt-okunur fixture erişimi (same-root sınır denetimi)              */
/* ------------------------------------------------------------------ */

const ADAPTER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const REPO_ROOT = path.resolve(ADAPTER_DIR, "..", "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");

/** Fixture kökü ile sınırlı okuma: hedef resolve edilir, kök altında kaldığı doğrulanır. */
function resolveWithinFixture(relativePath: string): string {
  const target = path.resolve(FIXTURE_ROOT, relativePath);
  const boundary = FIXTURE_ROOT.endsWith(path.sep)
    ? FIXTURE_ROOT
    : FIXTURE_ROOT + path.sep;
  if (target !== FIXTURE_ROOT && !target.startsWith(boundary)) {
    throw new Error(`Fixture kökü dışına erişim reddedildi: ${relativePath}`);
  }
  return target;
}

interface FixtureFile {
  readonly relativePath: string;
  readonly content: string;
}

function collectFixtureFiles(dir: string, prefix: string): FixtureFile[] {
  const out: FixtureFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isDirectory()) continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectFixtureFiles(resolveWithinFixture(rel), rel));
    } else if (entry.name.endsWith(".ts")) {
      out.push({
        relativePath: rel,
        content: readFileSync(resolveWithinFixture(rel), "utf8"),
      });
    }
  }
  return out.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
}

function loadFixtureSources(): {
  workspaceId: string;
  rootDir: string;
  sources: FixtureFile[];
} {
  return {
    workspaceId: "w_fixture_orders",
    rootDir: FIXTURE_ROOT,
    sources: collectFixtureFiles(FIXTURE_ROOT, ""),
  };
}

const WORKSPACE_ID = "w_fixture_orders";

/* ------------------------------------------------------------------ */
/* Result sorgu yardımcıları                                           */
/* ------------------------------------------------------------------ */

function nodeKeyOf(node: SnapshotNodeInput): string {
  return `${node.kind}|${node.qualifiedName}|${node.relativePath ?? "-"}`;
}

function findNode(
  result: TypeScriptAdapterResult,
  kind: string,
  qualifiedName: string,
): SnapshotNodeInput {
  const node = result.nodes.find(
    (candidate) =>
      candidate.kind === kind && candidate.qualifiedName === qualifiedName,
  );
  if (node === undefined) {
    const known = result.nodes.map(nodeKeyOf).join(", ");
    throw new Error(
      `${kind} "${qualifiedName}" node'u bulunamadı. Mevcut: ${known}`,
    );
  }
  return node;
}

function sameRef(a: SnapshotNodeInput, b: SnapshotNodeInput): boolean {
  return (
    a.kind === b.kind &&
    a.qualifiedName === b.qualifiedName &&
    a.relativePath === b.relativePath
  );
}

function edgesBetween(
  result: TypeScriptAdapterResult,
  kind: string,
  from: SnapshotNodeInput,
  to: SnapshotNodeInput,
): SnapshotEdgeInput[] {
  return result.edges.filter(
    (edge) => edge.kind === kind && sameRef(edge.from, from) && sameRef(edge.to, to),
  );
}

interface EvidenceCheck {
  readonly sourceByPath: Map<string, FixtureFile>;
}

function edgeCitesLine(
  check: EvidenceCheck,
  edge: SnapshotEdgeInput,
  needle: string,
): boolean {
  for (const evidence of edge.evidence ?? []) {
    const span = evidence.span;
    if (span === undefined) continue;
    const source = check.sourceByPath.get(span.relativePath);
    if (source === undefined) continue;
    // sourceHash = sha256(dosya içeriği) kanıtı fixture ile birebir eşleşmelidir.
    expect(span.sourceHash).toBe(sha256Hex(utf8Encode(source.content)));
    expect(evidence.analyzerId).toBe("ts-adapter");
    expect(evidence.rationale.length).toBeGreaterThan(0);
    const lines = source.content.split("\n");
    for (let line = span.startLine; line <= span.endLine; line += 1) {
      const text = lines[line - 1];
      if (text !== undefined && text.includes(needle)) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Pozitif: POST /orders → OrdersService → repository kanıt zinciri    */
/* ------------------------------------------------------------------ */

describe("analyzeTypeScriptProgram — pozitif (fixture kanıt zinciri)", () => {
  const fixture = loadFixtureSources();
  const check: EvidenceCheck = {
    sourceByPath: new Map(fixture.sources.map((s) => [s.relativePath, s])),
  };
  const result = analyzeTypeScriptProgram(fixture);

  it("ready durumunda döner ve sağlıklı fixture için diagnostics üretmez", () => {
    expect(result.analyzerId).toBe(TS_ADAPTER_ANALYZER_ID);
    expect(result.state).toBe("ready");
    expect(result.diagnostics).toEqual([]);
    expect(result.coverageRatio).toBeGreaterThan(0);
  });

  it("her kaynak dosya için File node'u üretir", () => {
    for (const source of fixture.sources) {
      const fileNode = findNode(result, "File", source.relativePath);
      expect(fileNode.relativePath).toBe(source.relativePath);
    }
  });

  it("CONTAINS: dosya → sembol kenarı verified ve kanıt satırı bildirimi içerir", () => {
    const serviceFile = findNode(result, "File", "src/services/orders-service.ts");
    const serviceClass = findNode(result, "Class", "OrdersService");
    const contains = edgesBetween(result, "CONTAINS", serviceFile, serviceClass);
    expect(contains).toHaveLength(1);
    expect(contains[0]?.resolution).toBe("verified");
    expect((contains[0]?.evidence ?? []).length).toBeGreaterThanOrEqual(1);
    expect(
      edgeCitesLine(check, contains[0] as SnapshotEdgeInput, "export class OrdersService"),
    ).toBe(true);
  });

  it("CONTAINS: sınıf → method kenarı verified üretir", () => {
    const serviceClass = findNode(result, "Class", "OrdersService");
    const createMethod = findNode(result, "Method", "OrdersService.create");
    const contains = edgesBetween(result, "CONTAINS", serviceClass, createMethod);
    expect(contains).toHaveLength(1);
    expect(contains[0]?.resolution).toBe("verified");
  });

  it("IMPORTS: dosya → dosya kenarı verified; kanıt satırı import beyanıdır", () => {
    const app = findNode(result, "File", "src/app.ts");
    const serviceFile = findNode(result, "File", "src/services/orders-service.ts");
    const imports = edgesBetween(result, "IMPORTS", app, serviceFile);
    expect(imports).toHaveLength(1);
    expect(imports[0]?.resolution).toBe("verified");
    expect(
      edgeCitesLine(check, imports[0] as SnapshotEdgeInput, 'from "./services/orders-service.js"'),
    ).toBe(true);
  });

  it("CALLS: createOrdersRoute → OrdersService.create verified; kanıt satırı çağrıyı içerir", () => {
    const routeFn = findNode(result, "Function", "createOrdersRoute");
    const createMethod = findNode(result, "Method", "OrdersService.create");
    const calls = edgesBetween(result, "CALLS", routeFn, createMethod);
    expect(calls).toHaveLength(1);
    const edge = calls[0] as SnapshotEdgeInput;
    expect(edge.resolution).toBe("verified");
    expect((edge.evidence ?? []).some((e) => e.kind === "semantic-symbol")).toBe(true);
    expect(edgeCitesLine(check, edge, "ordersService.create(")).toBe(true);
  });

  it("CALLS: OrdersService.create → OrderRepository.save verified; kanıt satırı çağrıyı içerir", () => {
    const createMethod = findNode(result, "Method", "OrdersService.create");
    const saveMethod = findNode(result, "Method", "OrderRepository.save");
    const calls = edgesBetween(result, "CALLS", createMethod, saveMethod);
    expect(calls).toHaveLength(1);
    const edge = calls[0] as SnapshotEdgeInput;
    expect(edge.resolution).toBe("verified");
    expect(edgeCitesLine(check, edge, "this.repository.save(")).toBe(true);
  });

  it("ROUTES_TO: POST /orders Endpoint node'u → Handler verified; kanıt route kaydıdır", () => {
    const endpoint = findNode(result, "Endpoint", "POST /orders");
    expect(endpoint.attributes?.["method"]).toBe("POST");
    expect(endpoint.attributes?.["path"]).toBe("/orders");
    expect(endpoint.relativePath).toBe("src/app.ts");

    const handler = findNode(result, "Handler", "ordersRoute");
    const routes = edgesBetween(result, "ROUTES_TO", endpoint, handler);
    expect(routes).toHaveLength(1);
    const edge = routes[0] as SnapshotEdgeInput;
    expect(edge.resolution).toBe("verified");
    expect((edge.evidence ?? []).some((e) => e.kind === "route-attribute")).toBe(true);
    expect(edgeCitesLine(check, edge, 'router.post("/orders"')).toBe(true);
  });

  it("verified kenarların tamamı ≥1 kanıt taşır; span'ler fixture seti içindedir (TŞ §8 invariant i)", () => {
    const fixturePaths = new Set(fixture.sources.map((s) => s.relativePath));
    for (const edge of result.edges) {
      if (edge.resolution !== "verified") continue;
      expect((edge.evidence ?? []).length).toBeGreaterThan(0);
      for (const evidence of edge.evidence ?? []) {
        if (evidence.span === undefined) continue;
        expect(fixturePaths.has(evidence.span.relativePath)).toBe(true);
        expect(evidence.analyzerId).toBe("ts-adapter");
        expect(evidence.rationale.length).toBeGreaterThan(0);
      }
    }
  });

  it("çıktı domain snapshot'ına dönüşür: dangling edge yok, duplicate yok (invariant ii)", () => {
    const snapshot = createSnapshot({
      workspaceId: WORKSPACE_ID,
      revision: { id: "rev-test", sequence: 1 },
      configHash: "config-hash-test",
      analyzerFingerprint: "ts-adapter@0.1.0",
      state: result.state === "partial" ? "partial" : "ready",
      createdAt: "2026-11-02T00:00:00.000Z",
      nodes: result.nodes,
      edges: result.edges,
    });
    expect(snapshot.edges.length).toBe(result.edges.length);
    expect(snapshot.nodes.length).toBe(result.nodes.length);
    const callCount = snapshot.edges.filter((edge) => edge.kind === "CALLS").length;
    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});

/* ------------------------------------------------------------------ */
/* Determinizm (TŞ §8 invariant vi)                                    */
/* ------------------------------------------------------------------ */

describe("analyzeTypeScriptProgram — determinizm", () => {
  it("aynı girdi → bit-bit aynı sonuç JSON'u", () => {
    const fixture = loadFixtureSources();
    const a = analyzeTypeScriptProgram(fixture);
    const b = analyzeTypeScriptProgram(fixture);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  }, 30_000);

  it("girdi dosya sırası değişse bile çıktı aynı kalır", () => {
    const fixture = loadFixtureSources();
    const shuffled = { ...fixture, sources: [...fixture.sources].reverse() };
    const a = analyzeTypeScriptProgram(fixture);
    const b = analyzeTypeScriptProgram(shuffled);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  }, 30_000);

  it("aynı girdiden üretilen snapshot'ların canonical JSON'u bit-bit aynıdır", () => {
    const fixture = loadFixtureSources();
    const result = analyzeTypeScriptProgram(fixture);
    const build = () =>
      createSnapshot({
        workspaceId: WORKSPACE_ID,
        revision: { id: "rev-test", sequence: 1 },
        configHash: "config-hash-test",
        analyzerFingerprint: "ts-adapter@0.1.0",
        state: result.state === "partial" ? "partial" : "ready",
        createdAt: "2026-11-02T00:00:00.000Z",
        nodes: result.nodes,
        edges: result.edges,
      });
    expect(snapshotCanonicalJson(build())).toBe(snapshotCanonicalJson(build()));
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* Negatif: uydurulmuş kenar yok + geçersiz girdi reddi                */
/* ------------------------------------------------------------------ */

describe("analyzeTypeScriptProgram — negatif (uydurma kenar yasak)", () => {
  const sources = [
    {
      relativePath: "src/broken-ref.ts",
      content: [
        'import { helper } from "./missing-module.js";',
        'import { join } from "node:path";',
        "",
        "export function boom(): void {",
        "  mysteryHelper();",
        "  void helper;",
        "  void join;",
        "}",
        "",
      ].join("\n"),
    },
  ];

  const result = analyzeTypeScriptProgram({
    workspaceId: "w_neg",
    rootDir: FIXTURE_ROOT,
    sources,
  });

  it("çözülemeyen çağrı için uydurulmuş verified CALLS kenarı üretmez; açık unresolved UnknownExternal verir", () => {
    const callEdges = result.edges.filter((edge) => edge.kind === "CALLS");
    expect(callEdges).toHaveLength(1);
    const edge = callEdges[0] as SnapshotEdgeInput;
    expect(edge.from.qualifiedName).toBe("boom");
    expect(edge.to.kind).toBe("UnknownExternal");
    expect(edge.to.qualifiedName).toBe("mysteryHelper");
    expect(edge.resolution).toBe("unresolved");
  });

  it("var olmayan sembollere Function/Method node'u icat etmez", () => {
    const invented = result.nodes.filter(
      (node) =>
        node.kind !== "UnknownExternal" &&
        (node.qualifiedName.includes("mysteryHelper") ||
          node.qualifiedName.includes("missing-module")),
    );
    expect(invented).toEqual([]);
  });

  it("çözülemeyen import açık UnknownExternal + unresolved; Node builtin bilinen kural ile heuristic'dir", () => {
    const unresolvedImports = result.edges.filter(
      (edge) => edge.kind === "IMPORTS" && edge.resolution === "unresolved",
    );
    expect(unresolvedImports).toHaveLength(1);
    expect(unresolvedImports[0]?.to.kind).toBe("UnknownExternal");
    expect(unresolvedImports[0]?.to.qualifiedName).toBe("./missing-module.js");

    const builtinImports = result.edges.filter(
      (edge) => edge.kind === "IMPORTS" && edge.to.qualifiedName === "node:path",
    );
    expect(builtinImports).toHaveLength(1);
    const builtinEdge = builtinImports[0] as SnapshotEdgeInput;
    expect(builtinEdge.to.kind).toBe("UnknownExternal");
    expect(builtinEdge.resolution).toBe("heuristic");
    expect(builtinEdge.ambiguity?.candidates).toContain("node:path");
  });

  it("durum partial bildirilir ve tanılar yalnızca hatalı dosyadan toplanır", () => {
    expect(result.state).toBe("partial");
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics.every((d) => d.relativePath === "src/broken-ref.ts")).toBe(true);
  });

  it("geçersiz girdi DomainError ile reddedilir", () => {
    expect(() =>
      analyzeTypeScriptProgram({ workspaceId: "  ", rootDir: FIXTURE_ROOT, sources }),
    ).toThrow(DomainError);
    expect(() =>
      analyzeTypeScriptProgram({
        workspaceId: "w_dup",
        rootDir: FIXTURE_ROOT,
        sources: [
          { relativePath: "a.ts", content: "export const a = 1;\n" },
          { relativePath: "a.ts", content: "export const b = 2;\n" },
        ],
      }),
    ).toThrow(DomainError);
    expect(() =>
      analyzeTypeScriptProgram({
        workspaceId: "w_esc",
        rootDir: FIXTURE_ROOT,
        sources: [
          { relativePath: "../escape.ts", content: "export const x = 1;\n" },
        ],
      }),
    ).toThrow(DomainError);
  });
});

/* ------------------------------------------------------------------ */
/* Partial: hata içeren dosya izolasyonu                               */
/* ------------------------------------------------------------------ */

describe("analyzeTypeScriptProgram — partial (hata izolasyonu)", () => {
  const fixture = loadFixtureSources();
  const corrupted = {
    relativePath: "src/broken.ts",
    content: "export class Broken {\n  this is not valid typescript (((\n",
  };
  const result = analyzeTypeScriptProgram({
    workspaceId: WORKSPACE_ID,
    rootDir: FIXTURE_ROOT,
    sources: [...fixture.sources, corrupted],
  });

  it("parse hatası analizi çökertmez; hata toplanıp diagnostics ile raporlanır", () => {
    expect(result.state).toBe("partial");
    const brokenDiagnostics = result.diagnostics.filter(
      (d) => d.relativePath === "src/broken.ts",
    );
    expect(brokenDiagnostics.length).toBeGreaterThanOrEqual(1);
    expect(brokenDiagnostics[0]?.line).toBeGreaterThanOrEqual(1);
    expect(brokenDiagnostics[0]?.message.length).toBeGreaterThan(0);
  });

  it("hatalı dosyanın SADECE kendi tanıları vardır; sağlıklı dosyalar tanısız kalır", () => {
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.relativePath).toBe("src/broken.ts");
    }
  });

  it("sağlıklı zincir ayakta kalır: POST /orders zinciri ve CALLS kanıtları hâlâ verified", () => {
    const endpoint = findNode(result, "Endpoint", "POST /orders");
    const handler = findNode(result, "Handler", "ordersRoute");
    const routes = edgesBetween(result, "ROUTES_TO", endpoint, handler);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.resolution).toBe("verified");

    const createMethod = findNode(result, "Method", "OrdersService.create");
    const saveMethod = findNode(result, "Method", "OrderRepository.save");
    const calls = edgesBetween(result, "CALLS", createMethod, saveMethod);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.resolution).toBe("verified");
  });

  it("hatalı dosya için File node'u yine üretilir (kısmi bilgi açık raporlanır)", () => {
    const brokenFile = result.nodes.find(
      (node) => node.kind === "File" && node.qualifiedName === "src/broken.ts",
    );
    expect(brokenFile).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* Denetim bulgusu: `new X()` instantiation çözümlemesi                */
/* ------------------------------------------------------------------ */

describe("analyzeTypeScriptProgram — instantiation (new X) çözümlemesi", () => {
  const sources = [
    {
      relativePath: "src/lib/repo.ts",
      content: [
        "export class Repo {",
        "  save(value: number): number {",
        "    return value;",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    {
      relativePath: "src/app/boot.ts",
      content: [
        'import { Repo } from "../lib/repo.js";',
        "",
        "export class Boot {",
        "  start(): number {",
        "    const repo = new Repo();",
        "    return repo.save(1);",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
  ];

  const result = analyzeTypeScriptProgram({
    workspaceId: "w_new_expr",
    rootDir: FIXTURE_ROOT,
    sources,
  });

  const edgeSummary = (): string =>
    JSON.stringify(
      result.edges.map(
        (edge) =>
          `${edge.kind} ${edge.from.qualifiedName}->${edge.to.kind}:${edge.to.qualifiedName}`,
      ),
    );

  it("pozitif: başka dosyadan new Repo() → mevcut Class Repo node'una verified CALLS kenarı", () => {
    const start = findNode(result, "Method", "Boot.start");
    const repoClass = findNode(result, "Class", "Repo");
    expect(repoClass.relativePath).toBe("src/lib/repo.ts");
    const instantiations = result.edges.filter(
      (edge) =>
        edge.kind === "CALLS" &&
        sameRef(edge.from, start) &&
        sameRef(edge.to, repoClass),
    );
    expect(
      instantiations.length,
      `CALLS kenarları: ${edgeSummary()}`,
    ).toBe(1);
    expect(instantiations[0]?.resolution).toBe("verified");
  });

  it("negatif: analiz setindeki sınıf için UnknownExternal çoğaltma node'u üretilmez", () => {
    const duplicated = result.nodes.filter(
      (node) =>
        node.kind === "UnknownExternal" && node.qualifiedName === "Repo",
    );
    expect(
      duplicated,
      `nodes: ${JSON.stringify(result.nodes.map(nodeKeyOf))}`,
    ).toEqual([]);
  });
});

describe("analyzeTypeScriptProgram — dış sınıf instantiation'ı (regresyon koruması)", () => {
  const sources = [
    {
      relativePath: "src/external-user.ts",
      content: [
        "export class Wrapper {",
        "  build(url: string): string {",
        "    const parsed = new URL(url);",
        "    return parsed.protocol;",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
  ];

  const result = analyzeTypeScriptProgram({
    workspaceId: "w_new_ext",
    rootDir: FIXTURE_ROOT,
    sources,
  });

  it("lib.dom sınıfı (URL) hâlâ açık UnknownExternal'dır; sahte Class node'u icat edilmez", () => {
    const calls = result.edges.filter((edge) => edge.kind === "CALLS");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to.kind).toBe("UnknownExternal");
    expect(calls[0]?.to.qualifiedName).toBe("URL");
    const fakeClass = result.nodes.filter(
      (node) => node.kind === "Class" && node.qualifiedName === "URL",
    );
    expect(fakeClass).toEqual([]);
  });
});
