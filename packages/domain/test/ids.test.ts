import { describe, expect, it } from "vitest";

import { DomainError } from "../src/errors.js";
import {
  createEdge,
  edgeId,
  evidenceId,
  nodeId,
  type CreateEdgeInput,
  type EdgeIdInput,
  type EvidenceIdInput,
  type NodeIdInput,
} from "../src/ids.js";

const baseNode: NodeIdInput = {
  workspaceId: "ws-1",
  kind: "Class",
  qualifiedName: "OrdersService",
  relativePath: "src/orders/orders.service.ts",
};

function domainErrorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    return (err as DomainError).code;
  }
  throw new Error("DomainError beklenmişti ama fırlatılmadı");
}

describe("nodeId", () => {
  it("pozitif: deterministiktir ve node:<hex64> biçimindedir (TŞ §8 invariant iii)", () => {
    const a = nodeId(baseNode);
    const b = nodeId(baseNode);
    expect(a).toBe(b);
    expect(a).toMatch(/^node:[0-9a-f]{64}$/);
  });

  it("pozitif: kimlik bileşenlerinden herhangi biri değişince ID değişir", () => {
    const variants: NodeIdInput[] = [
      { ...baseNode, workspaceId: "ws-2" },
      { ...baseNode, kind: "Module" },
      { ...baseNode, qualifiedName: "BillingService" },
      { ...baseNode, relativePath: "src/billing/billing.service.ts" },
    ];
    const base = nodeId(baseNode);
    const ids = variants.map((v) => nodeId(v));
    expect(new Set([base, ...ids]).size).toBe(5);
  });

  it("negatif: bilinmeyen node türü DomainError fırlatır", () => {
    const bad = { ...baseNode, kind: "Gateway" } as unknown as NodeIdInput;
    expect(domainErrorCode(() => nodeId(bad))).toBe(
      "domain/unknown-node-kind",
    );
  });

  it("negatif: boş workspaceId veya qualifiedName DomainError fırlatır", () => {
    expect(
      domainErrorCode(() => nodeId({ ...baseNode, workspaceId: " " })),
    ).toBe("domain/empty-required-field");
    expect(
      domainErrorCode(() => nodeId({ ...baseNode, qualifiedName: "" })),
    ).toBe("domain/empty-required-field");
  });

  it("partial: relativePath verilmediğinde de deterministik ID üretilir", () => {
    const { relativePath: _omit, ...withoutPath } = baseNode;
    expect(nodeId(withoutPath)).toMatch(/^node:[0-9a-f]{64}$/);
    expect(nodeId(withoutPath)).toBe(nodeId(withoutPath));
  });
});

const baseEdge: EdgeIdInput = {
  workspaceId: "ws-1",
  kind: "CALLS",
  from: "node:aa",
  to: "node:bb",
};

describe("edgeId", () => {
  it("pozitif: deterministiktir ve edge:<hex64> biçimindedir", () => {
    expect(edgeId(baseEdge)).toBe(edgeId(baseEdge));
    expect(edgeId(baseEdge)).toMatch(/^edge:[0-9a-f]{64}$/);
  });

  it("negatif: bilinmeyen edge türü DomainError fırlatır", () => {
    // Çalışma zamanı sınırında (MCP girdisi gibi) tip denetimini atlayan
    // değer gelebilir; "CALLS_AT" kasıtlı olarak katalog dışıdır.
    const hostileInput = { ...baseEdge, kind: "CALLS_AT" } as unknown as EdgeIdInput;
    expect(domainErrorCode(() => edgeId(hostileInput))).toBe(
      "domain/unknown-edge-kind",
    );
  });

  it("negatif: boş from/to DomainError fırlatır", () => {
    expect(domainErrorCode(() => edgeId({ ...baseEdge, from: "" }))).toBe(
      "domain/empty-required-field",
    );
    expect(domainErrorCode(() => edgeId({ ...baseEdge, to: " " }))).toBe(
      "domain/empty-required-field",
    );
  });

  it("partial: ID yalnızca (workspace, tür, from, to) dörtlüsüne duyarlıdır — resolution ID girdisi bile değildir", () => {
    // Tür girdi listesinde değildir; EdgeIdInput tipinde resolution bulunmaz,
    // bu yüzden aynı kimlik farklı güven düzeyleriyle yeniden hesaplanabilir.
    const inputs: EdgeIdInput[] = [
      baseEdge,
      { ...baseEdge, kind: "IMPORTS" },
      { ...baseEdge, from: "node:cc", to: "node:aa" },
    ];
    const ids = inputs.map((i) => edgeId(i));
    expect(new Set(ids).size).toBe(3);
    expect(edgeId(baseEdge)).toBe(edgeId(baseEdge));
  });
});

const baseEvidence: EvidenceIdInput = {
  workspaceId: "ws-1",
  kind: "ast-span",
  analyzerId: "ts-adapter",
  analyzerVersion: "0.1.0",
  span: {
    relativePath: "src/orders/orders.service.ts",
    startLine: 10,
    endLine: 24,
    sourceHash: "abc123",
  },
  rationale: "Metot bildirimi AST span üzerinden eşleştirildi",
};

describe("evidenceId", () => {
  it("pozitif: deterministiktir ve evidence:<hex64> biçimindedir", () => {
    expect(evidenceId(baseEvidence)).toBe(evidenceId(baseEvidence));
    expect(evidenceId(baseEvidence)).toMatch(/^evidence:[0-9a-f]{64}$/);
  });

  it("pozitif: span veya rationale değişince ID değişir", () => {
    const base = evidenceId(baseEvidence);
    const otherSpan = evidenceId({
      ...baseEvidence,
      span: { ...baseEvidence.span!, endLine: 25 },
    });
    const otherReason = evidenceId({ ...baseEvidence, rationale: "farklı" });
    expect(new Set([base, otherSpan, otherReason]).size).toBe(3);
  });

  it("negatif: boş analyzerId DomainError fırlatır", () => {
    expect(
      domainErrorCode(() => evidenceId({ ...baseEvidence, analyzerId: "" })),
    ).toBe("domain/empty-required-field");
  });

  it("partial: span'sız kanıt da deterministik ID alır (span opsiyoneldir)", () => {
    const { span: _omit, ...withoutSpan } = baseEvidence;
    expect(evidenceId(withoutSpan)).toMatch(/^evidence:[0-9a-f]{64}$/);
    expect(evidenceId(withoutSpan)).toBe(evidenceId(withoutSpan));
  });
});

const baseCreate: CreateEdgeInput = {
  workspaceId: "ws-1",
  kind: "CALLS",
  from: nodeId(baseNode),
  to: "node:cc",
  resolution: "verified",
  evidenceIds: [evidenceId(baseEvidence)],
};

describe("createEdge", () => {
  it("pozitif: verified kenarı kanıtla inşa eder ve ID'yi kendisi üretir (ADR-004 Evidence First)", () => {
    const edge = createEdge(baseCreate);
    expect(edge.id).toBe(
      edgeId({
        workspaceId: baseCreate.workspaceId,
        kind: baseCreate.kind,
        from: baseCreate.from,
        to: baseCreate.to,
      }),
    );
    expect(edge.resolution).toBe("verified");
    expect(edge.evidenceIds).toEqual(baseCreate.evidenceIds);
  });

  it("negatif: verified kenar kanıtsız inşa edilemez (TŞ §8 invariant i)", () => {
    expect(
      domainErrorCode(() => createEdge({ ...baseCreate, evidenceIds: [] })),
    ).toBe("domain/verified-edge-requires-evidence");
  });

  it("partial: heuristic/unresolved kenarlar kanıtsız kalabilir", () => {
    const heuristic = createEdge({ ...baseCreate, resolution: "heuristic", evidenceIds: [] });
    const unresolved = createEdge({ ...baseCreate, resolution: "unresolved", evidenceIds: [] });
    expect(heuristic.evidenceIds).toEqual([]);
    expect(unresolved.resolution).toBe("unresolved");
    // Aynı kimlik: resolution kimliğe dahil değildir.
    expect(heuristic.id).toBe(unresolved.id);
  });

  it("negatif: bilinmeyen resolution DomainError fırlatır", () => {
    const bad = {
      ...baseCreate,
      resolution: "proven",
    } as unknown as CreateEdgeInput;
    expect(domainErrorCode(() => createEdge(bad))).toBe(
      "domain/unknown-resolution",
    );
  });
});
