import type { EdgeKind, NodeKind, Resolution } from "./graph-kinds.js";

/**
 * Unified Evidence & Knowledge Graph domain tipleri — TŞ v2.1 §8'deki
 * arayüzlerin bire bir TS karşılığı. Alanlar salt okunur tutulur; snapshot
 * immutability'si (ADR-005) tip düzeyinde desteklenir.
 */

/** Kanıt/bağlantının statik çözümleme güven düzeyi. */
export type ResolutionLevel = Resolution;

/** Kaynak dosya üzerindeki konum kanıtı (TŞ §8 SourceSpan). */
export interface SourceSpan {
  readonly relativePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly sourceHash: string;
}

/** Kanıt kaydı (TŞ §8 Evidence). */
export interface Evidence {
  readonly id: string;
  readonly kind: string;
  readonly span?: SourceSpan;
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly rationale: string;
}

/** Graph düğümü (TŞ §8 GraphNode). */
export interface GraphNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly qualifiedName: string;
  readonly language?: string;
  readonly location?: SourceSpan;
  readonly attributes: Readonly<Record<string, unknown>>;
}

/** Graph kenarı (TŞ §8 GraphEdge). */
export interface GraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly resolution: Resolution;
  readonly evidenceIds: readonly string[];
  readonly ambiguity?: {
    readonly candidates: readonly string[];
    readonly reason: string;
  };
}

/**
 * Snapshot sürüm referansı. Not: TŞ §8 `RevisionRef` tipini ayrıca
 * tanımlamıyor; bu minimal yorum Faz A görev 3'teki Zod şemasıyla
 * netleştirilecek (şu an belgelenmiş tahmin olarak işaretlidir).
 */
export interface RevisionRef {
  readonly id: string;
  readonly sequence: number;
}

/** Değişmez graph snapshot'ı (TŞ §8 GraphSnapshot, ADR-005). */
export interface GraphSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly revision: RevisionRef;
  readonly configHash: string;
  readonly analyzerFingerprint: string;
  readonly state: "building" | "ready" | "partial" | "failed";
  readonly createdAt: string;
}
