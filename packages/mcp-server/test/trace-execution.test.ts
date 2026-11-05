import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * causoryn_trace_execution protokol düzeyi test üçlüsü (TŞ v2.1 §10.2
 * "entrypoint, maxDepth, maxPaths → Execution Flow, olası çağrı yolları";
 * §4.2 "statik kanıt ve bilinmeyen edge'ler ayrı"; §20 resource budget
 * maxDepth/maxPaths; sprint-2 B4).
 *
 * Kanıt zinciri notu (dürüstlük): fixture-ts-orders graph'ında TŞ §25/4
 * zinciri İKİ model parçasında yaşar — (1) Endpoint "POST /orders" →
 * Handler "ordersRoute" (ROUTES_TO, B3 çıktısı) ve (2) Function
 * "createOrdersRoute" → Method "OrdersService.create" → Method
 * "OrderRepository.save" (CALLS, verified). Handler → factory köprü kenarı
 * grafikte YOKTUR: adapter, arrow gövdesindeki çağrıları en yakın isimli
 * enclosing declaration'a atfeder (typescript-adapter.test.ts "CALLS:
 * createOrdersRoute → OrdersService.create verified" iddiası) ve uydurma
 * kenar yasaktır (TŞ §8). Bu yüzden pozitif testler zinciri iki
 * parçada — endpoint hop'u ve CALLS zinciri — kanıtlar.
 *
 * Resolution disiplini (görev sözleşmesi): her kenarın resolution düzeyi
 * KENDİ alanında taşınır; zincir etiketi (path.resolution) kenarlardan
 * türetilen en zayıf düzeydir — 'heuristic' kenar içeren zincir
 * 'heuristic' işaretlenir, verified gibi sunulmaz. 'unresolved' kenara
 * rastlayan zincir O NOKTADA biter (kenar yolda kalır, ötesi
 * genişletilmez) ve envelope status "partial" olur.
 *
 * Testler salt okunurdur (ADR-008); geçici fixture'lar yalnızca
 * os.tmpdir() altında yaşar.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createEdge,
  evidenceId,
  nodeId,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
} from "@causoryn/domain";
import { InMemoryGraphRepository } from "@causoryn/graph";
import { describe, expect, it } from "vitest";

import {
  EnvelopeSchema,
  createCausorynContext,
  createCausorynMcpServer,
} from "../src/index.js";
import type { CausorynContext } from "../src/index.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");
const FIXED_TIMESTAMP = "2026-01-01T00:00:00.000Z";

interface ClientPair {
  readonly client: Client;
  readonly close: () => Promise<void>;
}

/** Context'i SDK InMemory transport üzerinden bir Client'a bağlar. */
async function connectClient(context: CausorynContext): Promise<ClientPair> {
  const server = createCausorynMcpServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "vitest-trace-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function makeContext(configOverrides: Record<string, unknown> = {}): CausorynContext {
  return createCausorynContext(
    {
      workspaceId: "default",
      allowRoots: [FIXTURE_ROOT],
      results: { maxNodes: 250, maxSymbols: 100 },
      autoIndex: true,
      ...configOverrides,
    },
    { logger: () => {} },
  );
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const result: unknown = await client.callTool({ name, arguments: args });
  return result as CallToolResult;
}

/** Yanıtı envelope şemasına zorlar; başarıda envelope'u döndürür. */
function expectEnvelope(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toBeDefined();
  const parsed = EnvelopeSchema.safeParse(result.structuredContent);
  expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  return (parsed as { success: true; data: Record<string, unknown> }).data;
}

/** Hata envelope'u döndürür (isError false — hata envelope sözleşmesidir). */
function expectErrorEnvelope(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  const parsed = EnvelopeSchema.safeParse(result.structuredContent);
  expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  const envelope = (parsed as { success: true; data: Record<string, unknown> }).data;
  expect(envelope.status).toBe("error");
  expect(envelope.error).not.toBeNull();
  return envelope;
}

/** find_symbols ile tam isimli node'un kimliğini çeker. */
async function symbolIdOf(
  client: Client,
  qualifiedName: string,
): Promise<string> {
  const result = await callTool(client, "causoryn_find_symbols", {
    query: qualifiedName,
  });
  const envelope = expectEnvelope(result);
  const hits = (envelope.data as Record<string, unknown>).hits as Array<
    Record<string, unknown>
  >;
  const exact = hits.filter((hit) => hit.qualifiedName === qualifiedName);
  expect(exact.length, `${qualifiedName} için tek tam eşleşme beklenirdi`).toBe(1);
  return exact[0]?.symbolId as string;
}

/* ------------------------------------------------------------------ */
/* Sentetik snapshot yardımcıları (heuristic/döngü/unresolved-durdur)   */
/* ------------------------------------------------------------------ */

function synthNode(workspaceId: string, kind: NodeKind, qualifiedName: string): GraphNode {
  return {
    id: nodeId({ workspaceId, kind, qualifiedName }),
    kind,
    qualifiedName,
    attributes: {},
  };
}

function synthEvidence(workspaceId: string, rationale: string): Evidence {
  const kind = "ast-span";
  const analyzerId = "test-analyzer";
  const analyzerVersion = "0.0.0";
  return {
    id: evidenceId({ workspaceId, kind, analyzerId, analyzerVersion, rationale }),
    kind,
    analyzerId,
    analyzerVersion,
    rationale,
  };
}

function synthEdge(input: {
  workspaceId: string;
  from: string;
  to: string;
  resolution: "verified" | "heuristic" | "unresolved";
  evidenceIds: readonly string[];
}): GraphEdge {
  return createEdge({
    workspaceId: input.workspaceId,
    kind: "CALLS",
    from: input.from,
    to: input.to,
    resolution: input.resolution,
    evidenceIds: input.evidenceIds,
    ...(input.resolution === "heuristic"
      ? {
          ambiguity: {
            candidates: [input.to],
            reason: "sentetik heuristic kenar (bilinen kural dayanağı)",
          },
        }
      : {}),
  });
}

/**
 * Sentetik CALLS graph'ı yayınlar:
 *
 *   Entry --verified--> Mid --heuristic--> Leaf
 *          |              |
 *          |              +--verified--> Entry   (döngü)
 *          +--unresolved--> dynTarget --verified--> Leaf
 *
 * 'dynTarget' arkasındaki verified kenar BİLİMLİ olarak eklenmiştir:
 * unresolved kenarda zincir durmalı; ötesindeki Leaf'e ULAŞMAMALIDIR
 * (uydurma değil — zincir durdurma sözleşmesinin sinyal kanıtı).
 */
async function publishSyntheticCallGraph(): Promise<CausorynContext> {
  const repository = new InMemoryGraphRepository();
  const workspaceId = "default";
  repository.registerWorkspace({
    id: workspaceId,
    rootPath: FIXTURE_ROOT,
    createdAt: FIXED_TIMESTAMP,
  });
  const entry = synthNode(workspaceId, "Method", "Entry");
  const mid = synthNode(workspaceId, "Method", "Mid");
  const leaf = synthNode(workspaceId, "Method", "Leaf");
  const dynTarget = synthNode(workspaceId, "UnknownExternal", "dynTarget");

  const evEntryMid = synthEvidence(workspaceId, "CALLS: Entry -> Mid (sentetik verified)");
  const evMidLeaf = synthEvidence(workspaceId, "CALLS: Mid -> Leaf (sentetik heuristic)");
  const evMidEntry = synthEvidence(workspaceId, "CALLS: Mid -> Entry (sentetik döngü kenarı)");
  const evEntryDyn = synthEvidence(workspaceId, "CALLS: Entry -> dynTarget (sentetik unresolved)");
  const evDynLeaf = synthEvidence(workspaceId, "CALLS: dynTarget -> Leaf (sentetik verified)");

  const build = repository.beginBuild({
    workspaceId,
    revision: { id: "rev-synth-trace", sequence: 1 },
    configHash: "synth-trace-config-hash",
    analyzerFingerprint: "synth-trace-analyzer-fingerprint",
    createdAt: FIXED_TIMESTAMP,
  });
  for (const node of [entry, mid, leaf, dynTarget]) repository.addNode(build.buildId, node);
  for (const evidence of [evEntryMid, evMidLeaf, evMidEntry, evEntryDyn, evDynLeaf]) {
    repository.addEvidence(build.buildId, evidence);
  }
  const edges = [
    synthEdge({
      workspaceId,
      from: entry.id,
      to: mid.id,
      resolution: "verified",
      evidenceIds: [evEntryMid.id],
    }),
    synthEdge({
      workspaceId,
      from: mid.id,
      to: leaf.id,
      resolution: "heuristic",
      evidenceIds: [evMidLeaf.id],
    }),
    synthEdge({
      workspaceId,
      from: mid.id,
      to: entry.id,
      resolution: "verified",
      evidenceIds: [evMidEntry.id],
    }),
    synthEdge({
      workspaceId,
      from: entry.id,
      to: dynTarget.id,
      resolution: "unresolved",
      evidenceIds: [evEntryDyn.id],
    }),
    synthEdge({
      workspaceId,
      from: dynTarget.id,
      to: leaf.id,
      resolution: "verified",
      evidenceIds: [evDynLeaf.id],
    }),
  ];
  for (const edge of edges) repository.addEdge(build.buildId, edge);
  repository.publish(build.buildId, "ready", FIXED_TIMESTAMP);

  return createCausorynContext(
    {
      workspaceId,
      allowRoots: [FIXTURE_ROOT],
      results: { maxNodes: 250, maxSymbols: 100 },
      autoIndex: false,
    },
    { repository, logger: () => {} },
  );
}

/** Path kaydını okumayı kolaylaştıran yardımcı tipler (test içi). */
interface PathView {
  readonly index: number;
  readonly resolution: string;
  readonly nodeIds: readonly string[];
  readonly edges: Array<Record<string, unknown>>;
  readonly stoppedReason: string;
}

function pathsOf(data: Record<string, unknown>): PathView[] {
  return data.paths as unknown as PathView[];
}

/** nodeIds zincirini qualifiedName zincirine çevirir (nodes listesinden). */
function chainOf(
  data: Record<string, unknown>,
  path: PathView,
): string[] {
  const nodes = data.nodes as Array<Record<string, unknown>>;
  const byId = new Map(nodes.map((node) => [node.id as string, node.qualifiedName as string]));
  return path.nodeIds.map((id) => {
    const name = byId.get(id);
    expect(name, `node ${id} data.nodes içinde yok`).toBeDefined();
    return name as string;
  });
}

/* ------------------------------------------------------------------ */
/* Testler                                                             */
/* ------------------------------------------------------------------ */

describe(
  "causoryn_trace_execution — protokol düzeyi (sprint-2 B4)",
  { timeout: 30_000 },
  () => {
    it(
      "pozitif: endpoint entrypoint 'POST /orders' → ROUTES_TO hop'u; kenar başına evidence " +
        "(TŞ §25/4 zincirinin endpoint parçası, B3 çıktısı)",
      async () => {
        const pair = await connectClient(makeContext());
        try {
          const result = await callTool(pair.client, "causoryn_trace_execution", {
            entrypoint: "POST /orders",
            maxDepth: 3,
            maxPaths: 10,
          });
          const envelope = expectEnvelope(result);
          expect(envelope.status).toBe("ok");
          expect(String(envelope.snapshotId).startsWith("snapshot:")).toBe(true);

          const data = envelope.data as Record<string, unknown>;
          const entrypoint = data.entrypoint as Record<string, unknown>;
          expect(entrypoint.kind).toBe("Endpoint");
          expect(entrypoint.qualifiedName).toBe("POST /orders");
          expect(data.maxDepth).toBe(3);
          expect(data.maxPaths).toBe(10);
          expect(data.truncated).toBe(false);

          const paths = pathsOf(data);
          expect(paths.length).toBe(1);
          const path = paths[0] as PathView;
          expect(chainOf(data, path)).toEqual(["POST /orders", "ordersRoute"]);
          expect(path.edges.length).toBe(1);
          const edge = path.edges[0] as Record<string, unknown>;
          // Kenarın resolution'u KENDİ alanında (ayrı alan sözleşmesi).
          expect(edge.kind).toBe("ROUTES_TO");
          expect(edge.resolution).toBe("verified");
          expect(path.resolution).toBe("verified");
          expect(path.stoppedReason).toBe("leaf");

          // Kenar başına evidence: kanıt kimlikleri + kayıtları.
          const evidenceIds = edge.evidenceIds as string[];
          expect(evidenceIds.length).toBeGreaterThanOrEqual(1);
          const evidence = data.evidence as Array<Record<string, unknown>>;
          const byId = new Map(evidence.map((item) => [item.id as string, item]));
          for (const id of evidenceIds) {
            const record = byId.get(id);
            expect(record, `evidence ${id} data.evidence içinde yok`).toBeDefined();
            expect(record?.kind).toBe("route-attribute");
            const span = record?.span as Record<string, unknown>;
            expect(span.relativePath).toBe("src/app.ts");
          }

          // Determinizm: aynı istek → aynı data (TŞ §8 invariant vi).
          const repeat = await callTool(pair.client, "causoryn_trace_execution", {
            entrypoint: "POST /orders",
            maxDepth: 3,
            maxPaths: 10,
          });
          expect((expectEnvelope(repeat).data as Record<string, unknown>)).toEqual(data);
        } finally {
          await pair.close();
        }
      },
    );

    it(
      "pozitif: sembol entrypoint'ten CALLS zinciri — createOrdersRoute → OrdersService.create → " +
        "OrderRepository.save (TŞ §25/4 zincirinin service→repository parçası); " +
        "kenar başına evidence; unresolved dal status'u partial yapar",
      async () => {
        const pair = await connectClient(makeContext());
        try {
          const result = await callTool(pair.client, "causoryn_trace_execution", {
            entrypoint: "createOrdersRoute",
            maxDepth: 3,
            maxPaths: 10,
          });
          const envelope = expectEnvelope(result);
          // String → UnknownExternal çağrısı unresolved olduğundan zincir orada
          // biter: envelope status "partial" (görev sözleşmesi).
          expect(envelope.status).toBe("partial");

          const data = envelope.data as Record<string, unknown>;
          const entrypoint = data.entrypoint as Record<string, unknown>;
          expect(entrypoint.kind).toBe("Function");
          expect(entrypoint.qualifiedName).toBe("createOrdersRoute");

          const paths = pathsOf(data);
          // Üç basit yol: Response.json dalı, save dalı, String dalı.
          expect(paths.length).toBe(3);

          // (a) service → repository dalı: iki verified CALLS kenarı.
          const savePath = paths.find(
            (candidate) =>
              chainOf(data, candidate).join(" -> ") ===
              "createOrdersRoute -> OrdersService.create -> OrderRepository.save",
          );
          expect(savePath, "save dalı bulunamadı").toBeDefined();
          expect(savePath?.resolution).toBe("verified");
          expect(savePath?.stoppedReason).toBe("leaf");
          const saveEdges = savePath?.edges ?? [];
          expect(saveEdges.length).toBe(2);
          for (const edge of saveEdges) {
            expect(edge.kind).toBe("CALLS");
            expect(edge.resolution).toBe("verified");
            expect((edge.evidenceIds as string[]).length).toBeGreaterThanOrEqual(1);
          }

          // Kenar başına evidence: save kenarının kanıtı çağrı satırının
          // dosyasına işaret eder (semantic-symbol kanıt türü).
          const evidence = data.evidence as Array<Record<string, unknown>>;
          const byId = new Map(evidence.map((item) => [item.id as string, item]));
          const saveEdge = saveEdges[1] as Record<string, unknown>;
          const saveEvidenceIds = saveEdge.evidenceIds as string[];
          for (const id of saveEvidenceIds) {
            const record = byId.get(id);
            expect(record, `evidence ${id} data.evidence içinde yok`).toBeDefined();
            expect(record?.kind).toBe("semantic-symbol");
            expect((record?.span as Record<string, unknown>).relativePath).toBe(
              "src/services/orders-service.ts",
            );
          }

          // (b) unresolved dal: zincir String'te DURUR; kenar resolution'u
          // kendi alanında "unresolved", zincir etiketi "unresolved".
          const unresolvedPath = paths.find(
            (candidate) => candidate.resolution === "unresolved",
          );
          expect(unresolvedPath, "unresolved dal bulunamadı").toBeDefined();
          expect(chainOf(data, unresolvedPath as PathView)).toEqual([
            "createOrdersRoute",
            "OrdersService.create",
            "String",
          ]);
          const unresolvedEdge = (unresolvedPath?.edges ?? [])[1] as Record<string, unknown>;
          expect(unresolvedEdge.resolution).toBe("unresolved");
          // Zincir etiketiyle kenar etiketi karışmaz: aynı yolda İLK kenar
          // verified kalır, zincir en zayıf düzeyi taşır.
          expect((unresolvedPath?.edges ?? [])[0]?.resolution).toBe("verified");
          expect(unresolvedPath?.stoppedReason).toBe("unresolved-edge");

          // (c) Response.json dalı verified; uydurma devam yok.
          const responsePath = paths.find(
            (candidate) =>
              chainOf(data, candidate).join(" -> ") ===
              "createOrdersRoute -> Response.json",
          );
          expect(responsePath, "Response.json dalı bulunamadı").toBeDefined();
          expect(responsePath?.resolution).toBe("verified");

          // Tüm kanıt kimlikleri en az bir kenarın evidenceIds'inde geçer.
          const referenced = new Set<string>();
          for (const path of paths) {
            for (const edge of path.edges) {
              for (const id of edge.evidenceIds as string[]) referenced.add(id);
            }
          }
          for (const record of evidence) {
            expect(referenced.has(record.id as string)).toBe(true);
          }
        } finally {
          await pair.close();
        }
      },
    );

    it("pozitif: yaprak entrypoint (OrderRepository.save) tek boş yol döndürür; truncation yok", async () => {
      const pair = await connectClient(makeContext());
      try {
        const result = await callTool(pair.client, "causoryn_trace_execution", {
          entrypoint: "OrderRepository.save",
          maxDepth: 3,
          maxPaths: 10,
        });
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("ok");
        const data = envelope.data as Record<string, unknown>;
        const paths = pathsOf(data);
        expect(paths.length).toBe(1);
        expect((paths[0] as PathView).edges.length).toBe(0);
        expect((paths[0] as PathView).stoppedReason).toBe("leaf");
        expect((paths[0] as PathView).resolution).toBe("verified");
        expect(data.truncated).toBe(false);
        const saveId = await symbolIdOf(pair.client, "OrderRepository.save");
        expect((paths[0] as PathView).nodeIds).toEqual([saveId]);
      } finally {
        await pair.close();
      }
    });

    it("negatif: bilinmeyen entrypoint → SYMBOL_NOT_FOUND (B5 ile aynı sabit kod; retryable/userAction dolu)", async () => {
      const pair = await connectClient(makeContext());
      try {
        const result = await callTool(pair.client, "causoryn_trace_execution", {
          entrypoint: "NoSuchEntryPointAnywhere",
          maxDepth: 3,
          maxPaths: 10,
        });
        const envelope = expectErrorEnvelope(result);
        const error = envelope.error as Record<string, unknown>;
        expect(error.code).toBe("SYMBOL_NOT_FOUND");
        expect(error.retryable).toBe(false);
        expect((error.userAction as string).length).toBeGreaterThan(0);

        // Yetki denetimi kimlik aramasından ÖNCE gelir (B5 tutarlılığı).
        const authz = await callTool(pair.client, "causoryn_trace_execution", {
          workspaceId: "baska-workspace",
          entrypoint: "POST /orders",
          maxDepth: 3,
          maxPaths: 10,
        });
        expect(
          (expectErrorEnvelope(authz).error as Record<string, unknown>).code,
        ).toBe("WORKSPACE_NOT_AUTHORIZED");

        // Yayınlanmış snapshot yok → INDEX_NOT_READY (sorgu aracı sözleşmesi).
        const noIndexContext = createCausorynContext(
          {
            workspaceId: "default",
            allowRoots: [FIXTURE_ROOT],
            autoIndex: false,
          },
          { logger: () => {} },
        );
        const emptyPair = await connectClient(noIndexContext);
        try {
          const notReady = await callTool(emptyPair.client, "causoryn_trace_execution", {
            entrypoint: "POST /orders",
            maxDepth: 3,
            maxPaths: 10,
          });
          expect(
            (expectErrorEnvelope(notReady).error as Record<string, unknown>).code,
          ).toBe("INDEX_NOT_READY");
        } finally {
          await emptyPair.close();
        }
      } finally {
        await pair.close();
      }
    });

    it("negatif: maxDepth=0 / maxPaths=0 → INVALID_ARGUMENT; tavan üstü → LIMIT_EXCEEDED; negatif değer şema reddi", async () => {
      const pair = await connectClient(makeContext());
      try {
        const zeroDepth = await callTool(pair.client, "causoryn_trace_execution", {
          entrypoint: "POST /orders",
          maxDepth: 0,
          maxPaths: 10,
        });
        expect(
          (expectErrorEnvelope(zeroDepth).error as Record<string, unknown>).code,
        ).toBe("INVALID_ARGUMENT");

        const zeroPaths = await callTool(pair.client, "causoryn_trace_execution", {
          entrypoint: "POST /orders",
          maxDepth: 2,
          maxPaths: 0,
        });
        expect(
          (expectErrorEnvelope(zeroPaths).error as Record<string, unknown>).code,
        ).toBe("INVALID_ARGUMENT");

        // Config tavanı: results.maxDepth=3 (default), results.maxPaths=50.
        const overDepth = await callTool(pair.client, "causoryn_trace_execution", {
          entrypoint: "POST /orders",
          maxDepth: 4,
          maxPaths: 10,
        });
        expect(
          (expectErrorEnvelope(overDepth).error as Record<string, unknown>).code,
        ).toBe("LIMIT_EXCEEDED");

        const overPaths = await callTool(pair.client, "causoryn_trace_execution", {
          entrypoint: "POST /orders",
          maxDepth: 2,
          maxPaths: 51,
        });
        expect(
          (expectErrorEnvelope(overPaths).error as Record<string, unknown>).code,
        ).toBe("LIMIT_EXCEEDED");

        // Negatif değer şema düzeyinde reddedilir (SDK protokol hatası;
        // structuredContent taşımaz).
        const negative = await callTool(pair.client, "causoryn_trace_execution", {
          entrypoint: "POST /orders",
          maxDepth: -1,
          maxPaths: 10,
        });
        expect(negative.isError).toBe(true);
      } finally {
        await pair.close();
      }
    });

    it("negatif: belirsiz ad birden çok node'a tam eşleşirse AMBIGUOUS_SYMBOL + aday listesi", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "causoryn-trace-ambiguous-"));
      try {
        mkdirSync(path.join(root, "src", "a"), { recursive: true });
        mkdirSync(path.join(root, "src", "b"), { recursive: true });
        writeFileSync(
          path.join(root, "src", "a", "dup.ts"),
          "export class Dup { ping(): number { return 1; } }\n",
          "utf8",
        );
        writeFileSync(
          path.join(root, "src", "b", "dup.ts"),
          "export class Dup { pong(): number { return 2; } }\n",
          "utf8",
        );
        const pair = await connectClient(
          makeContext({ allowRoots: [root], workspaceId: "dup-fx" }),
        );
        try {
          const result = await callTool(pair.client, "causoryn_trace_execution", {
            workspaceId: "dup-fx",
            entrypoint: "Dup",
            maxDepth: 2,
            maxPaths: 10,
          });
          const envelope = expectErrorEnvelope(result);
          const error = envelope.error as Record<string, unknown>;
          expect(error.code).toBe("AMBIGUOUS_SYMBOL");
          // Aday listesi (TŞ §10.3 requiresDisambiguation deseni).
          const candidates = (envelope.data as Record<string, unknown>).candidates as Array<
            Record<string, unknown>
          >;
          expect(candidates.length).toBe(2);
          for (const candidate of candidates) {
            expect(candidate.qualifiedName).toBe("Dup");
            expect(candidate.kind).toBe("Class");
            expect(String(candidate.symbolId).startsWith("node:")).toBe(true);
          }
        } finally {
          await pair.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("partial: unresolved CALLS kenarında zincir o noktada biter + status partial (görev sözleşmesi)", async () => {
      const pair = await connectClient(makeContext());
      try {
        const result = await callTool(pair.client, "causoryn_trace_execution", {
          entrypoint: "OrdersService.create",
          maxDepth: 2,
          maxPaths: 10,
        });
        const envelope = expectEnvelope(result);
        expect(envelope.status).toBe("partial");
        // Uyarı da taşınır (TŞ §10.1 örneği: unresolved akış uyarı listesinde).
        expect(
          (envelope.warnings as string[]).some((warning) =>
            warning.toLowerCase().includes("unresolved"),
          ),
        ).toBe(true);

        const data = envelope.data as Record<string, unknown>;
        const paths = pathsOf(data);
        expect(paths.length).toBe(2);

        const savePath = paths.find(
          (candidate) =>
            chainOf(data, candidate).join(" -> ") ===
            "OrdersService.create -> OrderRepository.save",
        );
        expect(savePath).toBeDefined();
        expect(savePath?.resolution).toBe("verified");
        expect(savePath?.stoppedReason).toBe("leaf");

        const unresolvedPath = paths.find(
          (candidate) => candidate.stoppedReason === "unresolved-edge",
        );
        expect(unresolvedPath).toBeDefined();
        expect(chainOf(data, unresolvedPath as PathView)).toEqual([
          "OrdersService.create",
          "String",
        ]);
        // Zincir durduruldu: unresolved kenar YOLDA kalır, ötesi yok.
        expect((unresolvedPath?.edges ?? []).length).toBe(1);
        expect((unresolvedPath?.edges ?? [])[0]?.resolution).toBe("unresolved");
        expect(unresolvedPath?.resolution).toBe("unresolved");
        expect(data.truncated).toBe(false);
      } finally {
        await pair.close();
      }
    });

    it(
      "resolution ayrımı (sentetik): heuristic kenarlı zincir 'heuristic' işaretlenir — " +
        "verified gibi sunulmaz; unresolved kenar ötesindeki verified kenara ulaşmayı engeller",
      async () => {
        const context = await publishSyntheticCallGraph();
        const pair = await connectClient(context);
        try {
          const result = await callTool(pair.client, "causoryn_trace_execution", {
            entrypoint: "Entry",
            maxDepth: 3,
            maxPaths: 10,
          });
          const envelope = expectEnvelope(result);
          // unresolved dal var → partial.
          expect(envelope.status).toBe("partial");
          const warnings = envelope.warnings as string[];
          expect(
            warnings.some((warning) => warning.includes("heuristic")),
            "heuristic zincir uyarısı beklenirdi",
          ).toBe(true);

          const data = envelope.data as Record<string, unknown>;
          const paths = pathsOf(data);
          // İki MAKSİMAL basit yol: Entry→Mid→Leaf (heuristic) ve
          // Entry→dynTarget (unresolved durur). "Entry→Mid" ayrı yol DEĞİLDİR:
          // Leaf'e uzatılabilen bir önektir (maksimal yol semantiği).
          expect(paths.length).toBe(2);

          const heuristicPath = paths.find(
            (candidate) =>
              chainOf(data, candidate).join(" -> ") === "Entry -> Mid -> Leaf",
          );
          expect(heuristicPath, "heuristic dal bulunamadı").toBeDefined();
          // Zincir etiketi en zayıf kenar: heuristic — verified DEĞİL.
          expect(heuristicPath?.resolution).toBe("heuristic");
          expect((heuristicPath?.edges ?? [])[0]?.resolution).toBe("verified");
          expect((heuristicPath?.edges ?? [])[1]?.resolution).toBe("heuristic");

          // Döngü koruması (visited): hiçbir yol aynı node'u iki kez içermez;
          // Mid→Entry döngü kenarı yolları sonsuza götürmez (sonlu yol kümesi).
          for (const path of paths) {
            expect(new Set(path.nodeIds).size).toBe(path.nodeIds.length);
          }

          // Unresolved durdurma: dynTarget'ın ARKASINDAKİ verified kenara
          // (dynTarget → Leaf) zincir ULAŞMAZ; yol Entry→dynTarget'te biter.
          const dynPath = paths.find(
            (candidate) => chainOf(data, candidate).join(" -> ") === "Entry -> dynTarget",
          );
          expect(dynPath, "unresolved duran dal bulunamadı").toBeDefined();
          expect(dynPath?.stoppedReason).toBe("unresolved-edge");
          expect((dynPath?.nodeIds ?? []).length).toBe(2);
          const leaked = paths.some(
            (candidate) =>
              candidate !== heuristicPath &&
              chainOf(data, candidate).includes("Leaf"),
          );
          expect(leaked, "unresolved kenarın ötesindeki Leaf'e sızmamalı").toBe(false);
        } finally {
          await pair.close();
        }
      },
    );

    it("maxPaths aşımı: yol sayısı sınırlı kesilir → truncated=true + uyarı (deterministik ön kes)", async () => {
      const pair = await connectClient(makeContext());
      try {
        const result = await callTool(pair.client, "causoryn_trace_execution", {
          entrypoint: "createOrdersRoute",
          maxDepth: 3,
          maxPaths: 2,
        });
        const envelope = expectEnvelope(result);
        const data = envelope.data as Record<string, unknown>;
        const paths = pathsOf(data);
        expect(paths.length).toBe(2);
        expect(data.truncated).toBe(true);
        expect(
          (envelope.warnings as string[]).some((warning) =>
            warning.includes("maxPaths"),
          ),
        ).toBe(true);
        // Determinizm: aynı istek → aynı kesim (TŞ §8 invariant vi).
        const repeat = await callTool(pair.client, "causoryn_trace_execution", {
          entrypoint: "createOrdersRoute",
          maxDepth: 3,
          maxPaths: 2,
        });
        expect(expectEnvelope(repeat).data).toEqual(data);
      } finally {
        await pair.close();
      }
    });
  },
);
