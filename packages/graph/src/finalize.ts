import {
  DomainError,
  createSnapshot,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type NodeRef,
  type SnapshotEdgeInput,
  type SnapshotEvidenceInput,
  type SnapshotGraph,
  type SnapshotNodeInput,
} from "@causoryn/domain";

import { GraphRepositoryError } from "./errors.js";
import { nodeIdentityRelativePath } from "./validation.js";

/**
 * Publish/okuma çekirdeği: birikmiş node/edge/evidence kümesini domain
 * `createSnapshot` sözleşmesine çevirir. Final snapshot kimliği, içerik
 * karması ve tüm invariant denetimleri (dangling yok, verified kanıtlı,
 * duplicate yok, kanonik düzen, derin dondurma) BURADA tek noktadan
 * gerçeklenir — bellek içi gerçekleme publish'te, SQLite gerçekleme hem
 * publish'te hem her okumada bu işlevi kullanır. Böylece iki gerçekleme
 * birebir aynı canonical çıktıyı üretir (invariant vi) ve SQLite'tan
 * geri okunan her snapshot domain doğrulamasından geçmiş olur.
 */

/** Snapshot meta girdisi (publish: ready/partial; okuma: satırdaki durum). */
export interface SnapshotMetaInput {
  readonly workspaceId: string;
  readonly revision: { readonly id: string; readonly sequence: number };
  readonly configHash: string;
  readonly analyzerFingerprint: string;
  readonly createdAt: string;
  readonly state: SnapshotGraph["meta"]["state"];
}

/** Birikmiş içerik; GraphNode/GraphEdge/Evidence domain biçimindedir. */
export interface BuildContent {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly evidence: readonly Evidence[];
}

function toNodeRef(node: GraphNode): NodeRef {
  const relativePath = nodeIdentityRelativePath(node);
  return {
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    ...(relativePath === undefined ? {} : { relativePath }),
  };
}

function toEvidenceInput(item: Evidence): SnapshotEvidenceInput {
  return {
    kind: item.kind,
    ...(item.span === undefined ? {} : { span: item.span }),
    analyzerId: item.analyzerId,
    analyzerVersion: item.analyzerVersion,
    rationale: item.rationale,
  };
}

function mapDomainError(error: DomainError): GraphRepositoryError {
  const code = error.code.startsWith("domain/")
    ? `graph/${error.code.slice("domain/".length)}`
    : error.code;
  return new GraphRepositoryError(code, error.message);
}

export function finalizeSnapshotGraph(
  meta: SnapshotMetaInput,
  content: BuildContent,
): SnapshotGraph {
  const nodeIndex = new Map<string, GraphNode>(
    content.nodes.map((node) => [node.id, node]),
  );
  const evidenceIndex = new Map<string, Evidence>(
    content.evidence.map((item) => [item.id, item]),
  );

  const nodeInputs: SnapshotNodeInput[] = content.nodes.map((node) => {
    const relativePath = nodeIdentityRelativePath(node);
    return {
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      ...(relativePath === undefined ? {} : { relativePath }),
      ...(node.language === undefined ? {} : { language: node.language }),
      ...(node.location === undefined ? {} : { location: node.location }),
      attributes: node.attributes,
    };
  });

  const edgeInputs: SnapshotEdgeInput[] = content.edges.map((edge) => {
    const from = nodeIndex.get(edge.from);
    const to = nodeIndex.get(edge.to);
    if (from === undefined || to === undefined) {
      const missing = from === undefined ? edge.from : edge.to;
      throw new GraphRepositoryError(
        "graph/dangling-edge",
        `Kenar ucu bilinmeyen node'a işaret ediyor (${edge.id}): ${missing}`,
      );
    }
    const evidence: SnapshotEvidenceInput[] = edge.evidenceIds.map((ref) => {
      const item = evidenceIndex.get(ref);
      if (item === undefined) {
        throw new GraphRepositoryError(
          "graph/unknown-evidence-ref",
          `Kenar bilinmeyen kanıta işaret ediyor (${edge.id}): ${ref}`,
        );
      }
      return toEvidenceInput(item);
    });
    return {
      kind: edge.kind,
      from: toNodeRef(from),
      to: toNodeRef(to),
      resolution: edge.resolution,
      evidence,
      ...(edge.ambiguity === undefined
        ? {}
        : {
            ambiguity: {
              candidates: [...edge.ambiguity.candidates],
              reason: edge.ambiguity.reason,
            },
          }),
    };
  });

  const evidenceInputs: SnapshotEvidenceInput[] = content.evidence.map(
    (item) => toEvidenceInput(item),
  );

  try {
    return createSnapshot({
      workspaceId: meta.workspaceId,
      revision: { id: meta.revision.id, sequence: meta.revision.sequence },
      configHash: meta.configHash,
      analyzerFingerprint: meta.analyzerFingerprint,
      state: meta.state,
      createdAt: meta.createdAt,
      nodes: nodeInputs,
      edges: edgeInputs,
      evidence: evidenceInputs,
    });
  } catch (error) {
    if (error instanceof DomainError) {
      throw mapDomainError(error);
    }
    throw error;
  }
}
