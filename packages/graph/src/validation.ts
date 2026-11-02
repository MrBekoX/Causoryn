import {
  DomainError,
  EDGE_KIND_SET,
  NODE_KIND_SET,
  RESOLUTION_SET,
  canonicalJson,
  edgeId,
  evidenceId,
  nodeId,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type JsonValue,
  type SourceSpan,
} from "@causoryn/domain";

import { GraphRepositoryError } from "./errors.js";

/**
 * GraphRepository girdi doğrulaması — bellek içi ve SQLite gerçeklemenin
 * ORTAK sözleşme katmanı (TŞ v2.1 §8 invariant i/ii/iii, ADR-004).
 *
 * Determinizm koruması: depoya verilen her node/edge/evidence kimliği,
 * domain türetim formülüyle yeniden hesaplanır ve uyuşmayan kimlik reddedilir
 * (`graph/*-id-mismatch`). Böylece "aynı girdi → aynı Graph JSON" invariant'ı
 * depo girişinde zorlanır; bu aynı zamanda bellek ↔ SQLite round-trip
 * eşitliğinin ön koşuludur.
 *
 * Node kimlik eşleşmesi ve konum: GraphNode tipinde kimlik `relativePath`
 * alanı yoktur; kimlik `relativePath` bileşeni `node.location.relativePath`
 * ile aynıdır (kongre). Konumsuz node kimliği relativePath'siz türetilir.
 */

export function requireNonEmptyField(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GraphRepositoryError(
      "graph/empty-required-field",
      `Zorunlu alan boş veya boşluk olamaz: ${field}`,
    );
  }
  return value;
}

/** ISO 8601'e çözümlenebilen zaman damgası zorunluluğu (katı tip denetimi publish/finalize'dadır). */
export function requireTimestamp(field: string, value: unknown): string {
  const text = requireNonEmptyField(field, value);
  if (Number.isNaN(Date.parse(text))) {
    throw new GraphRepositoryError(
      "graph/invalid-timestamp",
      `Zaman damgası çözümlenemedi: ${field}=${text}`,
    );
  }
  return text;
}

function requirePositiveInt(field: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new GraphRepositoryError(
      "graph/invalid-span",
      `Alan pozitif tam sayı olmalı: ${field}=${String(value)}`,
    );
  }
}

export function validateSpan(field: string, spanValue: SourceSpan): void {
  requireNonEmptyField(`${field}.relativePath`, spanValue.relativePath);
  requireNonEmptyField(`${field}.sourceHash`, spanValue.sourceHash);
  requirePositiveInt(`${field}.startLine`, spanValue.startLine);
  requirePositiveInt(`${field}.endLine`, spanValue.endLine);
  if (spanValue.endLine < spanValue.startLine) {
    throw new GraphRepositoryError(
      "graph/invalid-span",
      `endLine, startLine'dan küçük olamaz: ${field}`,
    );
  }
}

function assertJsonSerializable(field: string, value: unknown): void {
  try {
    canonicalJson(value as JsonValue);
  } catch (error) {
    if (error instanceof DomainError) {
      throw new GraphRepositoryError(
        "graph/attributes-not-json",
        `${field} JSON'e serileştirilemiyor: ${error.message}`,
      );
    }
    throw error;
  }
}

/** Node kimliğinin relativePath bileşeni: kongre gereği location.relativePath. */
export function nodeIdentityRelativePath(node: GraphNode): string | undefined {
  return node.location === undefined ? undefined : node.location.relativePath;
}

/** Node sözleşme doğrulaması: tip kataloğu + JSON güvenliği + ID türetimi. */
export function validateNode(workspaceId: string, node: GraphNode): void {
  requireNonEmptyField("node.id", node.id);
  requireNonEmptyField("node.qualifiedName", node.qualifiedName);
  if (!NODE_KIND_SET.has(node.kind)) {
    throw new GraphRepositoryError(
      "graph/unknown-node-kind",
      `Bilinmeyen node türü: ${String(node.kind)}`,
    );
  }
  if (node.language !== undefined) {
    requireNonEmptyField("node.language", node.language);
  }
  if (node.location !== undefined) {
    validateSpan("node.location", node.location);
  }
  assertJsonSerializable("node.attributes", node.attributes);

  const relativePath = nodeIdentityRelativePath(node);
  const derived = nodeId({
    workspaceId,
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    ...(relativePath === undefined ? {} : { relativePath }),
  });
  if (derived !== node.id) {
    throw new GraphRepositoryError(
      "graph/node-id-mismatch",
      `Node kimliği deterministik türetimle uyuşmuyor: ${node.id}`,
    );
  }
}

/** Evidence sözleşme doğrulaması: alanlar + ID türetimi. */
export function validateEvidence(
  workspaceId: string,
  evidence: Evidence,
): void {
  requireNonEmptyField("evidence.id", evidence.id);
  requireNonEmptyField("evidence.kind", evidence.kind);
  requireNonEmptyField("evidence.analyzerId", evidence.analyzerId);
  requireNonEmptyField("evidence.analyzerVersion", evidence.analyzerVersion);
  requireNonEmptyField("evidence.rationale", evidence.rationale);
  if (evidence.span !== undefined) {
    validateSpan("evidence.span", evidence.span);
  }
  const derived = evidenceId({
    workspaceId,
    kind: evidence.kind,
    ...(evidence.span === undefined ? {} : { span: evidence.span }),
    analyzerId: evidence.analyzerId,
    analyzerVersion: evidence.analyzerVersion,
    rationale: evidence.rationale,
  });
  if (derived !== evidence.id) {
    throw new GraphRepositoryError(
      "graph/evidence-id-mismatch",
      `Evidence kimliği deterministik türetimle uyuşmuyor: ${evidence.id}`,
    );
  }
}

/**
 * Edge sözleşme doğrulaması (şekil + invariant i). Uçların varlığı
 * (invariant ii — `graph/dangling-edge`) gerçekleme katmanında, bu işlevden
 * ÖNCE denetlenir; kimlik türetimi de `validateEdgeIdentity` ile uçlar
 * çözüldükten sonra koşar. Kanıt referanslarının varlığı publish anında
 * denetlenir: kanıtlar kenardan sonra eklenebilir.
 */
export function validateEdgeShape(edge: GraphEdge): void {
  requireNonEmptyField("edge.id", edge.id);
  requireNonEmptyField("edge.from", edge.from);
  requireNonEmptyField("edge.to", edge.to);
  if (!EDGE_KIND_SET.has(edge.kind)) {
    throw new GraphRepositoryError(
      "graph/unknown-edge-kind",
      `Bilinmeyen edge türü: ${String(edge.kind)}`,
    );
  }
  if (!RESOLUTION_SET.has(edge.resolution)) {
    throw new GraphRepositoryError(
      "graph/unknown-resolution",
      `Bilinmeyen resolution değeri: ${String(edge.resolution)}`,
    );
  }
  if (!Array.isArray(edge.evidenceIds)) {
    throw new GraphRepositoryError(
      "graph/invalid-edge",
      `edge.evidenceIds dizi olmalı: ${edge.id}`,
    );
  }
  for (const evidenceRef of edge.evidenceIds) {
    requireNonEmptyField("edge.evidenceIds[]", evidenceRef);
  }
  if (edge.resolution === "verified" && edge.evidenceIds.length === 0) {
    throw new GraphRepositoryError(
      "graph/verified-edge-requires-evidence",
      "verified kenar en az bir kanıt gerektirir (TŞ §8 invariant i, ADR-004)",
    );
  }
  if (edge.ambiguity !== undefined) {
    if (edge.ambiguity.candidates.length === 0) {
      throw new GraphRepositoryError(
        "graph/invalid-ambiguity",
        `ambiguity.candidates boş olamaz: ${edge.id}`,
      );
    }
    for (const candidate of edge.ambiguity.candidates) {
      requireNonEmptyField("edge.ambiguity.candidates[]", candidate);
    }
    requireNonEmptyField("edge.ambiguity.reason", edge.ambiguity.reason);
  }
}

/** Edge kimliği deterministik türetimle uyuşmalı (invariant iii). */
export function validateEdgeIdentity(
  workspaceId: string,
  edge: GraphEdge,
): void {
  const derived = edgeId({
    workspaceId,
    kind: edge.kind,
    from: edge.from,
    to: edge.to,
  });
  if (derived !== edge.id) {
    throw new GraphRepositoryError(
      "graph/edge-id-mismatch",
      `Edge kimliği deterministik türetimle uyuşmuyor: ${edge.id}`,
    );
  }
}
