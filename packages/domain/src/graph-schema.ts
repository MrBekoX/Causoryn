import { z } from "zod";

import { EDGE_KINDS, NODE_KINDS, RESOLUTIONS } from "./graph-kinds.js";

/**
 * Unified Evidence & Knowledge Graph Zod şemaları — TŞ v2.1 §8'deki
 * arayüzlerin bire bir çalışma zamanı doğrulaması.
 *
 * İki invariant şema düzeyinde kodlanır:
 * - (i)  `verified` kenar en az bir kanıt taşır (GraphEdgeSchema, ADR-004).
 * - (ii) Snapshot düzeyinde dangling edge ve duplicate kimlik reddedilir
 *        (SnapshotSchema.superRefine). Kurucu (`createSnapshot`) aynı
 *        invariant'ları ek olarak zorlar; şema, dışarıdan gelen (kalıcı
 *        depodan/MCP girdisinden) snapshot verisi için savunma katmanıdır.
 *
 * `Evidence.kind` bilinçli olarak serbest string'dir: TŞ §8 arayüzü
 * `kind: string` der ve kanıt türü listesi ("runtime-trace" koşullu madde
 * dahil) kapalı bir enum olarak zorlanmaz.
 */

export const NodeKindSchema = z.enum(NODE_KINDS);

/**
 * Boş/yalnızca boşluk string reddi — ids.ts'teki `requireNonEmpty`
 * kuralıyla aynı semantiği şema düzeyine taşır (çıktı değeri kırpılmaz).
 */
const NonEmptyString = z.string().refine((value) => value.trim().length > 0, {
  message: "Field must not be empty or whitespace-only",
});

export const EdgeKindSchema = z.enum(EDGE_KINDS);

export const ResolutionSchema = z.enum(RESOLUTIONS);

/** Kaynak dosya üzerindeki konum kanıtı (TŞ §8 SourceSpan). */
export const SourceSpanSchema = z
  .strictObject({
    relativePath: NonEmptyString,
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    sourceHash: NonEmptyString,
  })
  .refine((span) => span.endLine >= span.startLine, {
    message: "endLine must not be less than startLine",
    path: ["endLine"],
  });

/** Kanıt kaydı (TŞ §8 Evidence). */
export const EvidenceSchema = z.strictObject({
  id: NonEmptyString,
  kind: NonEmptyString,
  span: SourceSpanSchema.optional(),
  analyzerId: NonEmptyString,
  analyzerVersion: NonEmptyString,
  rationale: NonEmptyString,
});

/** Graph düğümü (TŞ §8 GraphNode). */
export const GraphNodeSchema = z.strictObject({
  id: NonEmptyString,
  kind: NodeKindSchema,
  qualifiedName: NonEmptyString,
  language: NonEmptyString.optional(),
  location: SourceSpanSchema.optional(),
  attributes: z.record(z.string(), z.unknown()),
});

/** Graph kenarı (TŞ §8 GraphEdge) + invariant (i). */
export const GraphEdgeSchema = z
  .strictObject({
    id: NonEmptyString,
    from: NonEmptyString,
    to: NonEmptyString,
    kind: EdgeKindSchema,
    resolution: ResolutionSchema,
    evidenceIds: z.array(NonEmptyString),
    ambiguity: z
      .strictObject({
        candidates: z.array(NonEmptyString).min(1),
        reason: NonEmptyString,
      })
      .optional(),
  })
  .superRefine((edge, ctx) => {
    if (edge.resolution === "verified" && edge.evidenceIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        message:
          "A verified edge must carry at least one piece of evidence",
        path: ["evidenceIds"],
      });
    }
  });

/**
 * Snapshot üst verisi (TŞ §8 GraphSnapshot). `createdAt` ISO 8601 UTC
 * bekler; alan koşucu tarafından taşınır ve deterministik ID türetimine
 * KATILMAZ (bkz. snapshot.ts).
 */
export const GraphSnapshotMetaSchema = z.strictObject({
  id: NonEmptyString,
  workspaceId: NonEmptyString,
  revision: z.strictObject({
    id: NonEmptyString,
    sequence: z.number().int().min(0),
  }),
  configHash: NonEmptyString,
  analyzerFingerprint: NonEmptyString,
  state: z.enum(["building", "ready", "partial", "failed"]),
  createdAt: z.iso.datetime(),
});

/**
 * Bütün snapshot: üst veri + node/edge/evidence kümesi. Invariant (ii)
 * burada snapshot düzeyinde zorlanır: her kenar ucu bilinen bir node'a,
 * her kanıt referansı bilinen bir evidence kaydına işaret etmelidir;
 * kimlikler küme içinde tekil olmalıdır.
 */
export const SnapshotSchema = z
  .strictObject({
    meta: GraphSnapshotMetaSchema,
    nodes: z.array(GraphNodeSchema),
    edges: z.array(GraphEdgeSchema),
    evidence: z.array(EvidenceSchema),
  })
  .superRefine((snapshot, ctx) => {
    const nodeIds = new Set<string>();
    for (const node of snapshot.nodes) {
      if (nodeIds.has(node.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate node id: ${node.id}`,
          path: ["nodes"],
        });
      }
      nodeIds.add(node.id);
    }

    const evidenceIds = new Set<string>();
    for (const evidence of snapshot.evidence) {
      if (evidenceIds.has(evidence.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate evidence id: ${evidence.id}`,
          path: ["evidence"],
        });
      }
      evidenceIds.add(evidence.id);
    }

    const edgeIds = new Set<string>();
    for (const edge of snapshot.edges) {
      if (edgeIds.has(edge.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate edge id: ${edge.id}`,
          path: ["edges"],
        });
      }
      edgeIds.add(edge.id);

      if (!nodeIds.has(edge.from)) {
        ctx.addIssue({
          code: "custom",
          message: `Edge endpoint points to an unknown node (dangling): ${edge.from}`,
          path: ["edges"],
        });
      }
      if (!nodeIds.has(edge.to)) {
        ctx.addIssue({
          code: "custom",
          message: `Edge endpoint points to an unknown node (dangling): ${edge.to}`,
          path: ["edges"],
        });
      }
      for (const evidenceId of edge.evidenceIds) {
        if (!evidenceIds.has(evidenceId)) {
          ctx.addIssue({
            code: "custom",
            message: `Edge evidence points to an unknown evidence record: ${evidenceId}`,
            path: ["edges"],
          });
        }
      }
    }
  });
