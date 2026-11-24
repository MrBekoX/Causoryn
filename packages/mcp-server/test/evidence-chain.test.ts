import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  canonicalJson,
  createEdge,
  evidenceId,
  nodeId,
  type EdgeKind,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type SnapshotGraph,
} from "@causoryn/domain";
import {
  buildEvidenceChain,
  findViolations,
  parseArchitecturePolicy,
  resolveFindingById,
  type ArchitectureBaseline,
  type ArchitecturePolicy,
  type EvidenceChain,
  type GuardFinding,
} from "@causoryn/graph";
import { describe, expect, it } from "vitest";

import {
  EnvelopeSchema,
  createCausorynContext,
  createCausorynMcpServer,
} from "../src/index.js";
import type { CausorynContext } from "../src/index.js";

/**
 * Sprint-6 E4 — causoryn_get_evidence kanıt zinciri zenginleştirmesi.
 *
 * Kanıt: TŞ v2.1 §8 (Evidence arayüzü: relativePath, startLine/endLine,
 * sourceHash, analyzerId, analyzerVersion, rationale taşır), §10.2 araç
 * kataloğu ("causoryn_get_evidence | node/edge/finding IDs, limit? |
 * Evidence Graph provenance"; pdftotext ile birincil kaynaktan okundu),
 * §16 ("selection → get_evidence → kaynak dosya/satır").
 *
 * Üçlü (sprint çıkış kriteri):
 * - pozitif: CALLS kenarı → zincirde dosya+satır+sourceHash+analyzer+
 *   rationale dolu; bağlam referansları (uç node'lar/katçı kenar/bulgu)
 *   deterministik düzende;
 * - negatif: bilinmeyen kimlik → EVIDENCE_NOT_FOUND; bilinen ama kenarsız
 *   kimlik → BOŞ zincir AÇIK durum olarak (chain.empty=true);
 * - partial: rationale'suz (boş string) eski evidence → partial=true +
 *   missingFields=["rationale"]; span'sız kayıt → ["span"].
 *
 * Katman notu: rationale:"" domain şeması NonEmptyString tarafından
 * REDDEDİLDİĞİ için (graph-schema.ts savunma katmanı) rationale'suz eski
 * kayıt yalnızca SAF helper girdisinde (el yapımı SnapshotGraph) üretilebilir;
 * MCP yüzeyinde partial işareti şemaya uygun TEK yoldan (span'sız evidence —
 * EvidenceSchema'da span optional) kanıtlanır. Her iki dal da test edilir.
 *
 * Finding girdisi: finding kimlikleri snapshot'ta yaşamaz; workspace
 * policy'sinden findViolations ile DETERMİNİSTİK türetilir
 * (resolveFindingById). Policy yoksa/bozuksa POLICY_INVALID (check_
 * architecture ile aynı semantik), policy var ama kimlik eşleşmezse
 * EVIDENCE_NOT_FOUND.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const ORDERS_FIXTURE = path.join(REPO_ROOT, "examples", "fixture-ts-orders");

/* ------------------------------------------------------------------ */
/* Birim fikstürü — el yapımı SnapshotGraph (helper saf girdi)          */
/* ------------------------------------------------------------------ */

const SERVICE_SPAN = {
  relativePath: "src/services/orders-service.ts",
  startLine: 8,
  endLine: 12,
  sourceHash: "sha256:service-span",
};

const REPO_SPAN = {
  relativePath: "src/repositories/order-repository.ts",
  startLine: 2,
  endLine: 4,
  sourceHash: "sha256:repo-span",
};

function unitNode(
  id: string,
  qualifiedName: string,
  span: { relativePath: string; startLine: number; endLine: number; sourceHash: string },
): GraphNode {
  return {
    id,
    kind: "Method",
    qualifiedName,
    language: "typescript",
    location: { ...span },
    attributes: {},
  };
}

const NODE_A = unitNode("node:aaa", "OrdersService.create", SERVICE_SPAN);
const NODE_B = unitNode("node:bbb", "OrderRepository.save", REPO_SPAN);

const EV_CALLS: Evidence = {
  id: "evidence:ccc",
  kind: "semantic-symbol",
  span: { ...SERVICE_SPAN },
  analyzerId: "ts-adapter",
  analyzerVersion: "5.6.0",
  rationale: "CALLS kenarı semantic-symbol çözümlemesiyle doğrulandı",
};

const EV_CALLS_SECOND: Evidence = {
  id: "evidence:ddd",
  kind: "ast-span",
  span: { ...REPO_SPAN },
  analyzerId: "ts-adapter",
  analyzerVersion: "5.6.0",
  rationale: "Çağrı ifadesinin AST span kanıtı",
};

const EDGE_CALLS: GraphEdge = {
  id: "edge:eee",
  from: NODE_A.id,
  to: NODE_B.id,
  kind: "CALLS",
  resolution: "verified",
  evidenceIds: [EV_CALLS.id, EV_CALLS_SECOND.id],
};

function unitSnapshot(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  evidence: readonly Evidence[],
): SnapshotGraph {
  return {
    meta: {
      id: "snapshot:unit",
      workspaceId: "default",
      revision: { id: "rev-unit", sequence: 1 },
      configHash: "cfg-unit",
      analyzerFingerprint: "fp-unit",
      state: "ready",
      createdAt: "2026-11-08T00:00:00.000Z",
    },
    nodes: [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    edges: [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    evidence: [...evidence].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

const UNIT_SNAPSHOT = unitSnapshot([NODE_A, NODE_B], [EDGE_CALLS], [EV_CALLS, EV_CALLS_SECOND]);

/* ------------------------------------------------------------------ */
/* Birim fikstürü — guard policy (finding dalı)                         */
/* ------------------------------------------------------------------ */

const UNIT_POLICY_YAML = [
  "version: 1",
  "rules:",
  "  - id: services-must-not-call-repositories",
  "    type: forbidden-dependency",
  '    from: "**/services/**"',
  '    to: "**/repositories/**"',
  "    edgeKinds: [CALLS]",
  "    severity: error",
  "",
].join("\n");

const UNIT_BASELINE: ArchitectureBaseline = { version: 1 as const, suppressions: [] };

function unitPolicy(): ArchitecturePolicy {
  return parseArchitecturePolicy(UNIT_POLICY_YAML);
}

/* ------------------------------------------------------------------ */
/* Birim testler — packages/graph evidence-chain helper'ı               */
/* ------------------------------------------------------------------ */

describe("buildEvidenceChain (birim)", () => {
  it("pozitif: CALLS kenarı zincirinde dosya+satır+sourceHash+analyzer+rationale dolu; contextRefs uç node'ları taşır", () => {
    const chain = buildEvidenceChain({
      snapshot: UNIT_SNAPSHOT,
      target: { kind: "edge", id: EDGE_CALLS.id },
    });
    expect(chain).toBeDefined();
    const resolved = chain as EvidenceChain;
    expect(resolved.targetKind).toBe("edge");
    expect(resolved.targetId).toBe(EDGE_CALLS.id);
    expect(resolved.order).toBe("evidence-id-asc");
    expect(resolved.empty).toBe(false);
    expect(resolved.records.map((record) => record.id)).toEqual([
      EV_CALLS.id,
      EV_CALLS_SECOND.id,
    ]);

    const first = resolved.records[0] as EvidenceChain["records"][number];
    expect(first.span).toEqual({
      relativePath: SERVICE_SPAN.relativePath,
      startLine: SERVICE_SPAN.startLine,
      endLine: SERVICE_SPAN.endLine,
      sourceHash: SERVICE_SPAN.sourceHash,
    });
    expect(first.analyzerId).toBe("ts-adapter");
    expect(first.analyzerVersion).toBe("5.6.0");
    expect(first.rationale).toContain("CALLS");
    expect(first.partial).toBe(false);
    expect(first.missingFields).toEqual([]);

    // Bağlam referansları: kenarın İKİ ucu da node referansı olarak taşınır;
    // location relativePath+satırlarla doludur; sıralama deterministiktir.
    const refIds = first.contextRefs.map((ref) => ref.id);
    expect(refIds).toContain(NODE_A.id);
    expect(refIds).toContain(NODE_B.id);
    const refA = first.contextRefs.find((ref) => ref.id === NODE_A.id);
    expect(refA?.kind).toBe("node");
    expect(refA?.label).toBe("OrdersService.create");
    expect(refA?.location).toEqual({
      relativePath: SERVICE_SPAN.relativePath,
      startLine: SERVICE_SPAN.startLine,
      endLine: SERVICE_SPAN.endLine,
    });
    expect(refIds).toEqual([...refIds].sort());
    expect(resolved.partialCount).toBe(0);
  });

  it("pozitif: node hedefi komşu kenar kanıtlarını zincirler; katkı eden kenar + karşı uç contextRef'te", () => {
    const chain = buildEvidenceChain({
      snapshot: UNIT_SNAPSHOT,
      target: { kind: "node", id: NODE_A.id },
    });
    expect(chain).toBeDefined();
    const resolved = chain as EvidenceChain;
    expect(resolved.targetKind).toBe("node");
    expect(resolved.records.map((record) => record.id)).toEqual([
      EV_CALLS.id,
      EV_CALLS_SECOND.id,
    ]);
    const first = resolved.records[0] as EvidenceChain["records"][number];
    const edgeRef = first.contextRefs.find((ref) => ref.kind === "edge");
    expect(edgeRef?.id).toBe(EDGE_CALLS.id);
    expect(edgeRef?.label).toContain("CALLS");
    expect(edgeRef?.label).toContain("OrdersService.create");
    expect(edgeRef?.label).toContain("OrderRepository.save");
    // Kanıtın span'ı node A'nın dosyasından: counterpart node ref'i de var.
    expect(first.contextRefs.some((ref) => ref.id === NODE_B.id)).toBe(true);
  });

  it("negatif: bilinmeyen node/edge kimliği → undefined (servis katmanı EVIDENCE_NOT_FOUND verir)", () => {
    expect(
      buildEvidenceChain({
        snapshot: UNIT_SNAPSHOT,
        target: { kind: "node", id: "node:olmayan" },
      }),
    ).toBeUndefined();
    expect(
      buildEvidenceChain({
        snapshot: UNIT_SNAPSHOT,
        target: { kind: "edge", id: "edge:olmayan" },
      }),
    ).toBeUndefined();
    expect(
      buildEvidenceChain({
        snapshot: UNIT_SNAPSHOT,
        target: { kind: "evidence", id: "evidence:olmayan" },
      }),
    ).toBeUndefined();
  });

  it("açık durum: bilinen ama kenarsız node → BOŞ zincir (records [], empty=true)", () => {
    const loner = unitNode("node:loner", "Lonely.caller", SERVICE_SPAN);
    const chain = buildEvidenceChain({
      snapshot: unitSnapshot([loner, NODE_A], [], []),
      target: { kind: "node", id: loner.id },
    });
    expect(chain).toBeDefined();
    const resolved = chain as EvidenceChain;
    expect(resolved.records).toEqual([]);
    expect(resolved.empty).toBe(true);
    expect(resolved.recordCount).toBe(0);
    expect(resolved.partialCount).toBe(0);
  });

  it("partial: rationale'suz (boş string) eski evidence → partial=true + missingFields=['rationale']; span'sız → ['span']", () => {
    const legacyNoRationale: Evidence = {
      id: "evidence:legacy",
      kind: "ast-span",
      span: { ...SERVICE_SPAN },
      analyzerId: "ts-adapter",
      analyzerVersion: "5.6.0",
      rationale: "", // eski sürüm kaydı: rationale boş
    };
    const legacyNoSpan: Evidence = {
      id: "evidence:nospan",
      kind: "semantic-symbol",
      analyzerId: "ts-adapter",
      analyzerVersion: "5.6.0",
      rationale: "span taşınmayan eski kayıt",
    };
    const edge: GraphEdge = {
      id: "edge:legacy",
      from: NODE_A.id,
      to: NODE_B.id,
      kind: "CALLS",
      resolution: "verified",
      evidenceIds: [legacyNoRationale.id, legacyNoSpan.id],
    };
    const chain = buildEvidenceChain({
      snapshot: unitSnapshot(
        [NODE_A, NODE_B],
        [edge],
        [legacyNoRationale, legacyNoSpan],
      ),
      target: { kind: "edge", id: edge.id },
    });
    expect(chain).toBeDefined();
    const resolved = chain as EvidenceChain;
    const byId = new Map(resolved.records.map((record) => [record.id, record]));
    const noRationale = byId.get(legacyNoRationale.id);
    expect(noRationale?.partial).toBe(true);
    expect(noRationale?.missingFields).toEqual(["rationale"]);
    const noSpan = byId.get(legacyNoSpan.id);
    expect(noSpan?.partial).toBe(true);
    expect(noSpan?.missingFields).toEqual(["span"]);
    expect(noSpan?.span).toBeUndefined();
    expect(resolved.partialCount).toBe(2);
  });

  it("determinizm: aynı girdi → yapısal deep-equal + BAYT düzeyinde canonical JSON eşitliği", () => {
    const first = buildEvidenceChain({
      snapshot: UNIT_SNAPSHOT,
      target: { kind: "edge", id: EDGE_CALLS.id },
    });
    expect(first).toBeDefined();
    const firstChain = first as EvidenceChain;
    const second = buildEvidenceChain({
      snapshot: UNIT_SNAPSHOT,
      target: { kind: "edge", id: EDGE_CALLS.id },
    });
    expect(second).toBeDefined();
    const secondChain = second as EvidenceChain;
    expect(secondChain).toEqual(firstChain);
    // Bayt düzeyi serileştirme determinizmi (denetim bulgusu): zincirin
    // canonical JSON'u iki bağımsız koşumda birebir aynı bayt dizisidir.
    expect(canonicalJson(secondChain as never)).toBe(canonicalJson(firstChain as never));
    const nodeFirst = buildEvidenceChain({
      snapshot: UNIT_SNAPSHOT,
      target: { kind: "node", id: NODE_A.id },
    });
    expect(nodeFirst).toBeDefined();
    const nodeFirstChain = nodeFirst as EvidenceChain;
    const nodeSecond = buildEvidenceChain({
      snapshot: UNIT_SNAPSHOT,
      target: { kind: "node", id: NODE_A.id },
    });
    expect(nodeSecond).toBeDefined();
    const nodeSecondChain = nodeSecond as EvidenceChain;
    expect(nodeSecondChain).toEqual(nodeFirstChain);
    expect(canonicalJson(nodeSecondChain as never)).toBe(canonicalJson(nodeFirstChain as never));
  });

  it("pozitif: finding hedefi — findViolations bulgusunun kanıt zinciri + finding contextRef + uç node'lar", () => {
    const policy = unitPolicy();
    const violations = findViolations(UNIT_SNAPSHOT, policy, UNIT_BASELINE);
    expect(violations).toHaveLength(1);
    const finding = violations[0] as GuardFinding;
    expect(finding.from).toBe("OrdersService.create");
    expect(finding.to).toBe("OrderRepository.save");

    // resolveFindingById: aynı kimlik deterministik olarak geri bulunur.
    const resolved = resolveFindingById({
      snapshot: UNIT_SNAPSHOT,
      policy,
      baseline: UNIT_BASELINE,
      findingId: finding.id,
    });
    expect(resolved).toEqual(finding);
    expect(
      resolveFindingById({
        snapshot: UNIT_SNAPSHOT,
        policy,
        baseline: UNIT_BASELINE,
        findingId: `finding:${"0".repeat(64)}`,
      }),
    ).toBeUndefined();

    const chain = buildEvidenceChain({
      snapshot: UNIT_SNAPSHOT,
      target: { kind: "finding", finding },
    });
    expect(chain).toBeDefined();
    const resolvedChain = chain as EvidenceChain;
    expect(resolvedChain.targetKind).toBe("finding");
    expect(resolvedChain.targetId).toBe(finding.id);
    expect(resolvedChain.records.map((record) => record.id)).toEqual([
      EV_CALLS.id,
      EV_CALLS_SECOND.id,
    ]);
    const first = resolvedChain.records[0] as EvidenceChain["records"][number];
    const findingRef = first.contextRefs.find((ref) => ref.kind === "finding");
    expect(findingRef?.id).toBe(finding.id);
    expect(findingRef?.label).toContain("services-must-not-call-repositories");
    expect(first.contextRefs.some((ref) => ref.id === NODE_A.id)).toBe(true);
    expect(first.contextRefs.some((ref) => ref.id === NODE_B.id)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* MCP yüzey fikstürleri                                                */
/* ------------------------------------------------------------------ */

interface ClientPair {
  readonly client: Client;
  readonly context: CausorynContext;
  readonly close: () => Promise<void>;
}

async function connectClient(context: CausorynContext): Promise<ClientPair> {
  const server = createCausorynMcpServer(context, {
    toolProfile: "full",
    outputSchemaProfile: "full",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "vitest-evidence-chain-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    context,
    close: async () => {
      await client.close();
      await server.close();
      context.close();
    },
  };
}

function makeContext(
  configOverrides: Record<string, unknown> = {},
): CausorynContext {
  return createCausorynContext({
    workspaceId: "default",
    allowRoots: [ORDERS_FIXTURE],
    results: { maxNodes: 250, maxSymbols: 100 },
    autoIndex: true,
    ...configOverrides,
  });
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const result: unknown = await client.callTool({ name, arguments: args });
  return result as CallToolResult;
}

function expectEnvelope(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toBeDefined();
  const parsed = EnvelopeSchema.safeParse(result.structuredContent);
  expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  return (parsed as { success: true; data: Record<string, unknown> }).data;
}

function expectErrorOf(result: CallToolResult): Record<string, unknown> {
  const envelope = expectEnvelope(result);
  expect(envelope.status).toBe("error");
  const error = envelope.error as Record<string, unknown>;
  expect(typeof error.code).toBe("string");
  expect(typeof error.retryable).toBe("boolean");
  expect((error.userAction as string).length).toBeGreaterThan(0);
  return error;
}

/** Guard fikstürü: policy + services/repositories kaynakları (tmp'de). */
function makeGuardFixture(): { readonly root: string; readonly cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-evidence-chain-"));
  try {
    mkdirSync(path.join(root, ".causoryn"), { recursive: true });
    writeFileSync(
      path.join(root, ".causoryn", "architecture.rules.yaml"),
      UNIT_POLICY_YAML,
      "utf8",
    );
    mkdirSync(path.join(root, "src", "services"), { recursive: true });
    mkdirSync(path.join(root, "src", "repositories"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "services", "orders-service.ts"),
      [
        'import { OrderRepository } from "../repositories/order-repository.js";',
        "export class OrdersService {",
        "  private readonly repository: OrderRepository;",
        "  constructor(repository: OrderRepository) {",
        "    this.repository = repository;",
        "  }",
        "  create(): number {",
        "    return this.repository.save();",
        "  }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "src", "repositories", "order-repository.ts"),
      ["export class OrderRepository {", "  save(): number { return 1; }", "}", ""].join("\n"),
      "utf8",
    );
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Manuel snapshot yayın donanımı (faz-d/wiki-tools örüntüsü). */
const FIXED_NOW = "2026-11-08T12:00:00.000Z";

interface ManualNodeSpec {
  readonly kind: NodeKind;
  readonly qualifiedName: string;
  readonly relativePath: string;
}

function manualNodeId(spec: ManualNodeSpec): string {
  return nodeId({
    workspaceId: "default",
    kind: spec.kind,
    qualifiedName: spec.qualifiedName,
    relativePath: spec.relativePath,
  });
}

function publishManualGraph(
  context: CausorynContext,
  spec: {
    readonly from: ManualNodeSpec;
    readonly to: ManualNodeSpec;
    readonly evidence: {
      readonly id: string;
      readonly kind: string;
      readonly analyzerId: string;
      readonly analyzerVersion: string;
      readonly rationale: string;
      readonly span?: {
        readonly relativePath: string;
        readonly startLine: number;
        readonly endLine: number;
        readonly sourceHash: string;
      };
    };
  },
): string {
  const repo = context.repository;
  repo.registerWorkspace({
    id: "default",
    rootPath: context.config.allowRoots[0] as string,
    createdAt: FIXED_NOW,
  });
  const build = repo.beginBuild({
    workspaceId: "default",
    revision: { id: "rev-evidence-chain", sequence: 1 },
    configHash: "cfg-evidence-chain",
    analyzerFingerprint: "fp-evidence-chain",
    createdAt: FIXED_NOW,
  });
  const nodeOf = (node: ManualNodeSpec): GraphNode => ({
    id: manualNodeId(node),
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    location: {
      relativePath: node.relativePath,
      startLine: 1,
      endLine: 10,
      sourceHash: `sha256:${node.relativePath}`,
    },
    attributes: {},
  });
  repo.addNode(build.buildId, nodeOf(spec.from));
  repo.addNode(build.buildId, nodeOf(spec.to));
  const evidenceRecord: Evidence = {
    id: spec.evidence.id,
    kind: spec.evidence.kind,
    analyzerId: spec.evidence.analyzerId,
    analyzerVersion: spec.evidence.analyzerVersion,
    rationale: spec.evidence.rationale,
    ...(spec.evidence.span === undefined ? {} : { span: { ...spec.evidence.span } }),
  };
  repo.addEvidence(build.buildId, evidenceRecord);
  const edge: GraphEdge = createEdge({
    workspaceId: "default",
    kind: "CALLS" as EdgeKind,
    from: manualNodeId(spec.from),
    to: manualNodeId(spec.to),
    resolution: "verified",
    evidenceIds: [spec.evidence.id],
  });
  repo.addEdge(build.buildId, edge);
  const published = repo.publish(build.buildId, "ready", FIXED_NOW);
  return published.meta.id;
}

/* ------------------------------------------------------------------ */
/* MCP yüzey testleri — causoryn_get_evidence zenginleştirmesi          */
/* ------------------------------------------------------------------ */

describe("causoryn_get_evidence — kanıt zinciri (MCP yüzeyi)", { timeout: 30_000 }, () => {
  it("pozitif: CALLS kenarı → eski alanlar KORUNUR + partial/contextRefs/chain zenginleşmesi", async () => {
    const pair = await connectClient(makeContext());
    try {
      const symbolIdOf = async (query: string): Promise<string> => {
        const result = await callTool(pair.client, "causoryn_find_symbols", {
          query,
          limit: 10,
        });
        const envelope = expectEnvelope(result);
        const hits = (envelope.data as Record<string, unknown>).hits as Array<
          Record<string, unknown>
        >;
        expect(hits.length, `${query} için tek isabet beklenirdi`).toBe(1);
        return hits[0]?.symbolId as string;
      };
      const createId = await symbolIdOf("OrdersService.create");
      const saveId = await symbolIdOf("OrderRepository.save");

      const map = await callTool(pair.client, "causoryn_map_system", {
        level: "L3",
        maxNodes: 250,
      });
      const mapEdges = (expectEnvelope(map).data as Record<string, unknown>)
        .edges as Array<Record<string, unknown>>;
      const callsEdge = mapEdges.find(
        (edge) => edge.kind === "CALLS" && edge.from === createId && edge.to === saveId,
      );
      expect(callsEdge, "CALLS kenarı L3 haritada yok").toBeDefined();
      const edgeId = callsEdge?.id as string;

      const result = await callTool(pair.client, "causoryn_get_evidence", { id: edgeId });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      expect(data.idKind).toBe("edge");

      // GERİYE UYUM: eski alanlar aynen taşınır.
      const edgeInfo = data.edge as Record<string, unknown>;
      expect(edgeInfo.id).toBe(edgeId);
      expect(edgeInfo.from).toBe(createId);
      expect(edgeInfo.to).toBe(saveId);
      const evidence = data.evidence as Array<Record<string, unknown>>;
      expect(evidence.length).toBeGreaterThanOrEqual(1);
      const semantic = evidence.find((entry) => entry.kind === "semantic-symbol");
      expect(semantic, "semantic-symbol kanıtı yok").toBeDefined();
      expect(semantic?.analyzerId).toBe("ts-adapter");
      expect(typeof semantic?.analyzerVersion).toBe("string");
      expect((semantic?.rationale as string).length).toBeGreaterThan(0);
      const span = semantic?.span as Record<string, unknown>;
      expect(span.relativePath).toBe("src/services/orders-service.ts");
      expect(typeof span.startLine).toBe("number");
      expect(typeof span.endLine).toBe("number");
      expect(typeof span.sourceHash).toBe("string");

      // ZENGİNLEŞTİRME: partial/missingFields/contextRefs dolu gelir.
      expect(semantic?.partial).toBe(false);
      expect(semantic?.missingFields).toEqual([]);
      const contextRefs = semantic?.contextRefs as Array<Record<string, unknown>>;
      expect(contextRefs.length).toBeGreaterThanOrEqual(2);
      const refKinds = new Set(contextRefs.map((ref) => ref.kind));
      expect(refKinds.has("node")).toBe(true);
      const nodeRefs = contextRefs.filter((ref) => ref.kind === "node");
      for (const ref of nodeRefs) {
        expect(typeof ref.id).toBe("string");
        expect(typeof ref.label).toBe("string");
        const location = ref.location as Record<string, unknown> | undefined;
        if (location !== undefined) {
          expect(typeof location.relativePath).toBe("string");
          expect(typeof location.startLine).toBe("number");
          expect(typeof location.endLine).toBe("number");
        }
      }

      // CHAIN ÖZETİ: deterministik düzen + açık durum alanları.
      const chain = data.chain as Record<string, unknown>;
      expect(chain.targetKind).toBe("edge");
      expect(chain.targetId).toBe(edgeId);
      expect(chain.order).toBe("evidence-id-asc");
      expect(chain.recordCount).toBe(evidence.length);
      expect(chain.partialCount).toBe(0);
      expect(chain.empty).toBe(false);

      // Zincir sıralaması deterministiktir (kanıt ID'si asc).
      const ids = evidence.map((entry) => entry.id as string);
      expect(ids).toEqual([...ids].sort());
    } finally {
      await pair.close();
    }
  });

  it("negatif: bilinmeyen kimlik → EVIDENCE_NOT_FOUND (regresyon; davranış değişmedi)", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_get_evidence", {
        id: "node:0000000000000000000000000000000000000000000000000000000000000000",
      });
      const error = expectErrorOf(result);
      expect(error.code).toBe("EVIDENCE_NOT_FOUND");
      expect(error.retryable).toBe(false);
    } finally {
      await pair.close();
    }
  });

  it("açık durum: kenarsız Workspace node → evidence [] + chain.empty=true (EVIDENCE_NOT_FOUND değildir)", async () => {
    const emptyRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-empty-evidence-"));
    try {
      const pair = await connectClient(
        makeContext({ workspaceId: "empty", allowRoots: [emptyRoot] }),
      );
      try {
        const l0 = await callTool(pair.client, "causoryn_map_system", { level: "L0" });
        const l0Nodes = (expectEnvelope(l0).data as Record<string, unknown>)
          .nodes as Array<Record<string, unknown>>;
        expect(l0Nodes.length).toBe(1);
        const workspaceNodeId = l0Nodes[0]?.id as string;

        const result = await callTool(pair.client, "causoryn_get_evidence", {
          workspaceId: "empty",
          id: workspaceNodeId,
        });
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("partial");
        const data = envelope.data as Record<string, unknown>;
        expect(data.idKind).toBe("node");
        expect((data.evidence as unknown[]).length).toBe(0);
        const chain = data.chain as Record<string, unknown>;
        expect(chain.recordCount).toBe(0);
        expect(chain.empty).toBe(true);
        expect(chain.partialCount).toBe(0);
      } finally {
        await pair.close();
      }
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("partial: span'sız evidence'lı manuel snapshot → partial=true + missingFields=['span']", async () => {
    const pair = await connectClient(makeContext({ autoIndex: false }));
    try {
      const fromSpec: ManualNodeSpec = {
        kind: "Method",
        qualifiedName: "ManualService.caller",
        relativePath: "src/services/manual-service.ts",
      };
      const toSpec: ManualNodeSpec = {
        kind: "Method",
        qualifiedName: "ManualRepository.callee",
        relativePath: "src/repositories/manual-repository.ts",
      };
      publishManualGraph(pair.context, {
        from: fromSpec,
        to: toSpec,
        evidence: {
          id: evidenceId({
            workspaceId: "default",
            kind: "semantic-symbol",
            analyzerId: "manual-fixture",
            analyzerVersion: "0.0.0",
            rationale: "span taşınmayan eski sürüm kanıt kaydı",
          }),
          kind: "semantic-symbol",
          analyzerId: "manual-fixture",
          analyzerVersion: "0.0.0",
          rationale: "span taşınmayan eski sürüm kanıt kaydı",
          // span bilinçli YOK — EvidenceSchema'da optional (şemaya uygun tek
          // partial üretim yolu; rationale:"" şema tarafından reddedilir).
        },
      });

      const edgeTarget = createEdge({
        workspaceId: "default",
        kind: "CALLS",
        from: manualNodeId(fromSpec),
        to: manualNodeId(toSpec),
        resolution: "verified",
        evidenceIds: [
          evidenceId({
            workspaceId: "default",
            kind: "semantic-symbol",
            analyzerId: "manual-fixture",
            analyzerVersion: "0.0.0",
            rationale: "span taşınmayan eski sürüm kanıt kaydı",
          }),
        ],
      });

      const result = await callTool(pair.client, "causoryn_get_evidence", {
        id: edgeTarget.id,
      });
      const envelope = expectEnvelope(result);
      expect(envelope.status).toBe("ok");
      const data = envelope.data as Record<string, unknown>;
      const evidence = data.evidence as Array<Record<string, unknown>>;
      expect(evidence).toHaveLength(1);
      const record = evidence[0] as Record<string, unknown>;
      expect(record.span).toBeUndefined();
      expect(record.partial).toBe(true);
      expect(record.missingFields).toEqual(["span"]);
      expect((record.rationale as string).length).toBeGreaterThan(0);
      const chain = data.chain as Record<string, unknown>;
      expect(chain.partialCount).toBe(1);
      expect(chain.empty).toBe(false);
    } finally {
      await pair.close();
    }
  });

  it("negatif: finding kimliği + policy dosyası yok → POLICY_INVALID (check_architecture semantiği)", async () => {
    const pair = await connectClient(makeContext());
    try {
      const result = await callTool(pair.client, "causoryn_get_evidence", {
        id: `finding:${"0".repeat(64)}`,
      });
      const error = expectErrorOf(result);
      expect(error.code).toBe("POLICY_INVALID");
    } finally {
      await pair.close();
    }
  });

  it("negatif: policy var ama finding kimliği eşleşmiyor → EVIDENCE_NOT_FOUND", async () => {
    const fixture = makeGuardFixture();
    try {
      const pair = await connectClient(
        makeContext({ workspaceId: "guard", allowRoots: [fixture.root] }),
      );
      try {
        const result = await callTool(pair.client, "causoryn_get_evidence", {
          workspaceId: "guard",
          id: `finding:${"0".repeat(64)}`,
        });
        const error = expectErrorOf(result);
        expect(error.code).toBe("EVIDENCE_NOT_FOUND");
      } finally {
        await pair.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("pozitif: check_architecture bulgusu → get_evidence finding dalı (finding bloğu + kanıt zinciri)", async () => {
    const fixture = makeGuardFixture();
    try {
      const pair = await connectClient(
        makeContext({ workspaceId: "guard", allowRoots: [fixture.root] }),
      );
      try {
        const guard = await callTool(pair.client, "causoryn_check_architecture", {
          workspaceId: "guard",
        });
        const guardData = expectEnvelope(guard).data as Record<string, unknown>;
        const findings = guardData.findings as Array<Record<string, unknown>>;
        expect(findings).toHaveLength(1);
        const finding = findings[0] as Record<string, unknown>;
        const findingId = finding.id as string;
        expect(findingId.startsWith("finding:")).toBe(true);

        const result = await callTool(pair.client, "causoryn_get_evidence", {
          workspaceId: "guard",
          id: findingId,
        });
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("ok");
        const data = envelope.data as Record<string, unknown>;
        expect(data.idKind).toBe("finding");

        const findingBlock = data.finding as Record<string, unknown>;
        expect(findingBlock.id).toBe(findingId);
        expect(findingBlock.ruleId).toBe("services-must-not-call-repositories");
        expect(findingBlock.ruleType).toBe("forbidden-dependency");
        expect(findingBlock.severity).toBe("error");
        expect(findingBlock.from).toBe("OrdersService.create");
        expect(findingBlock.to).toBe("OrderRepository.save");
        expect(findingBlock.suppressed).toBe(false);

        const evidence = data.evidence as Array<Record<string, unknown>>;
        expect(evidence.length).toBeGreaterThanOrEqual(1);
        for (const record of evidence) {
          expect((record.rationale as string).length).toBeGreaterThan(0);
          const contextRefs = record.contextRefs as Array<Record<string, unknown>>;
          expect(contextRefs.some((ref) => ref.kind === "finding")).toBe(true);
        }
        const chain = data.chain as Record<string, unknown>;
        expect(chain.targetKind).toBe("finding");
        // Denetim bulgusu düzeltmesi: boş doğrulama yerine ÇÖZÜLEN bulgunun
        // kimliği chain özetinde SABİT olarak taşınır.
        expect(chain.targetId).toBe(findingId);
        expect(chain.empty).toBe(false);
      } finally {
        await pair.close();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("denetim bulgusu düzeltmesi: tools/list get_evidence açıklaması finding kimliği + zincir zenginleşmesini beyan eder", async () => {
    const pair = await connectClient(makeContext());
    try {
      const { tools } = await pair.client.listTools();
      const tool = tools.find((entry) => entry.name === "causoryn_get_evidence");
      expect(tool, "causoryn_get_evidence tools/list'te yok").toBeDefined();
      const description = tool?.description as string;
      expect(description.length).toBeGreaterThan(0);
      // LLM istemcisinin birincil sözleşmesi açıklamadır: TŞ §10.2 katalog
      // satırındaki "node/edge/finding IDs" yüzeyi + E4 zincir alanları
      // metinde BİYAN EDİLMEK ZORUNDADIR (bulgu: finding dalı fiilen
      // keşfedilemez kalıyordu).
      expect(description).toContain("finding");
      expect(description).toContain("partial");
      expect(description).toContain("missingFields");
      expect(description).toContain("contextRefs");
      expect(description).toContain("chain");
      expect(description).toContain("EVIDENCE_NOT_FOUND");
    } finally {
      await pair.close();
    }
  });
});
