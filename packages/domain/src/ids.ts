import { canonicalJson, type JsonValue } from "./canonical-json.js";
import { DomainError } from "./errors.js";
import {
  EDGE_KIND_SET,
  NODE_KIND_SET,
  RESOLUTION_SET,
  type EdgeKind,
  type NodeKind,
  type Resolution,
} from "./graph-kinds.js";
import type { GraphEdge, SourceSpan } from "./graph-types.js";
import { sha256Hex } from "./sha256.js";
import { utf8Encode } from "./utf8.js";

/**
 * Deterministik ID üretimi — TŞ v2.1 §8 invariant (iii):
 * "workspace+relativePath+symbol identity ile deterministik ID".
 *
 * Tasarım kararları (Faz A görev 3 kapsamında Zod şemasıyla pekiştirilecek):
 * - Node kimliği = (workspaceId, kind, qualifiedName, relativePath|null).
 *   `kind` dörtlüye dahildir: aynı sembol adını taşıyan farklı türdeki
 *   düğümler çakışamaz. `attributes` kimliğe dahil DEĞİLDİR (ek açıklamadır).
 * - Edge kimliği = (workspaceId, kind, from, to); `resolution` kimliğin
 *   parçası değildir (güven düzeyi analiz sonucudur, kimlik değil).
 * - Evidence kimliği kanıt içeriğinden türetilir (kind, analyzer, span,
 *   rationale) ve workspace'e göre kapsamlanır.
 * - Tüm ID'ler `<tür>:<sha256-hex-64>` biçimindedir; karma, canonical JSON
 *   üzerinde UTF-8 kodlanmış SHA-256'dır.
 */

const ID_PREFIX = {
  node: "node",
  edge: "edge",
  evidence: "evidence",
} as const;

type IdKind = keyof typeof ID_PREFIX;

function requireNonEmpty(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new DomainError(
      "domain/empty-required-field",
      `Required field must not be empty: ${field}`,
    );
  }
}

function deterministicId(kind: IdKind, parts: readonly JsonValue[]): string {
  return `${ID_PREFIX[kind]}:${sha256Hex(utf8Encode(canonicalJson(parts)))}`;
}

/** Node kimlik girdisi (TŞ §8 invariant iii). */
export interface NodeIdInput {
  readonly workspaceId: string;
  readonly kind: NodeKind;
  readonly qualifiedName: string;
  readonly relativePath?: string;
}

/** Edge kimlik girdisi; resolution bilinçli olarak dahil değildir. */
export interface EdgeIdInput {
  readonly workspaceId: string;
  readonly kind: EdgeKind;
  readonly from: string;
  readonly to: string;
}

/** Evidence kimlik girdisi (TŞ §8 Evidence alanları). */
export interface EvidenceIdInput {
  readonly workspaceId: string;
  readonly kind: string;
  readonly span?: SourceSpan;
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly rationale: string;
}

/** Kenar oluşturma girdisi; ID motor tarafından üretilir. */
export interface CreateEdgeInput {
  readonly workspaceId: string;
  readonly kind: EdgeKind;
  readonly from: string;
  readonly to: string;
  readonly resolution: Resolution;
  readonly evidenceIds: readonly string[];
  readonly ambiguity?: {
    readonly candidates: readonly string[];
    readonly reason: string;
  };
}

function nodeIdUnchecked(input: NodeIdInput): string {
  return deterministicId("node", [
    input.workspaceId,
    input.kind,
    input.qualifiedName,
    input.relativePath ?? null,
  ]);
}

/** Node için deterministik ID üretir; tür kataloğuna göre doğrular. */
export function nodeId(input: NodeIdInput): string {
  requireNonEmpty("workspaceId", input.workspaceId);
  requireNonEmpty("qualifiedName", input.qualifiedName);
  if (!NODE_KIND_SET.has(input.kind)) {
    throw new DomainError(
      "domain/unknown-node-kind",
      `Unknown node kind: ${String(input.kind)}`,
    );
  }
  return nodeIdUnchecked(input);
}

function edgeIdUnchecked(input: EdgeIdInput): string {
  return deterministicId("edge", [
    input.workspaceId,
    input.kind,
    input.from,
    input.to,
  ]);
}

/** Edge için deterministik ID üretir; tür kataloğuna göre doğrular. */
export function edgeId(input: EdgeIdInput): string {
  requireNonEmpty("workspaceId", input.workspaceId);
  requireNonEmpty("from", input.from);
  requireNonEmpty("to", input.to);
  if (!EDGE_KIND_SET.has(input.kind)) {
    throw new DomainError(
      "domain/unknown-edge-kind",
      `Unknown edge kind: ${String(input.kind)}`,
    );
  }
  return edgeIdUnchecked(input);
}

function spanPart(span: SourceSpan): JsonValue {
  return {
    relativePath: span.relativePath,
    startLine: span.startLine,
    endLine: span.endLine,
    sourceHash: span.sourceHash,
  };
}

/** Evidence için deterministik ID üretir (içerik tabanlı). */
export function evidenceId(input: EvidenceIdInput): string {
  requireNonEmpty("workspaceId", input.workspaceId);
  requireNonEmpty("kind", input.kind);
  requireNonEmpty("analyzerId", input.analyzerId);
  requireNonEmpty("analyzerVersion", input.analyzerVersion);
  requireNonEmpty("rationale", input.rationale);
  return deterministicId("evidence", [
    input.workspaceId,
    input.kind,
    input.analyzerId,
    input.analyzerVersion,
    input.rationale,
    input.span === undefined ? null : spanPart(input.span),
  ]);
}

/**
 * GraphEdge inşa eder: ID'yi üretir ve TŞ §8 invariant (i)'yi zorlar —
 * `verified` kenar en az bir kanıt taşımak zorundadır (ADR-004 Evidence
 * First). `heuristic`/`unresolved` kenarlar kanıtsız kalabilir.
 */
export function createEdge(input: CreateEdgeInput): GraphEdge {
  requireNonEmpty("workspaceId", input.workspaceId);
  requireNonEmpty("from", input.from);
  requireNonEmpty("to", input.to);
  if (!EDGE_KIND_SET.has(input.kind)) {
    throw new DomainError(
      "domain/unknown-edge-kind",
      `Unknown edge kind: ${String(input.kind)}`,
    );
  }
  if (!RESOLUTION_SET.has(input.resolution)) {
    throw new DomainError(
      "domain/unknown-resolution",
      `Unknown resolution value: ${String(input.resolution)}`,
    );
  }
  if (input.resolution === "verified" && input.evidenceIds.length === 0) {
    throw new DomainError(
      "domain/verified-edge-requires-evidence",
      "A verified edge requires at least one piece of evidence",
    );
  }
  return {
    id: edgeIdUnchecked({
      workspaceId: input.workspaceId,
      kind: input.kind,
      from: input.from,
      to: input.to,
    }),
    from: input.from,
    to: input.to,
    kind: input.kind,
    resolution: input.resolution,
    evidenceIds: [...input.evidenceIds],
    ...(input.ambiguity === undefined
      ? {}
      : {
          ambiguity: {
            candidates: [...input.ambiguity.candidates],
            reason: input.ambiguity.reason,
          },
        }),
  };
}
