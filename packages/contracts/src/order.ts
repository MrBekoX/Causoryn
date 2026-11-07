import type {
  ContractCandidate,
  ContractDiagnostic,
  ContractEdgeCandidate,
  ContractEvidenceSpan,
} from "./types.js";

/**
 * Kanonik sıralama karşılaştırıcıları — determinizm invariant'ı (TŞ §8
 * invariant vi: aynı girdi → aynı çıktı JSON). Tüm karşılaştırmalar kod
 * noktası (codepoint) sırasındadır; localeCompare ASLA kullanılmaz (yerel
 * ayara bağımlı sıralama determinizmi bozar).
 */

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareEvidence(a: ContractEvidenceSpan, b: ContractEvidenceSpan): number {
  return (
    compareStrings(a.relativePath, b.relativePath) ||
    a.startLine - b.startLine ||
    a.endLine - b.endLine
  );
}

export function compareContractCandidates(a: ContractCandidate, b: ContractCandidate): number {
  return (
    compareStrings(a.sourceKind, b.sourceKind) ||
    compareStrings(a.qualifiedName, b.qualifiedName) ||
    compareEvidence(a.evidence, b.evidence) ||
    compareStrings(a.route ?? "", b.route ?? "") ||
    compareStrings(a.method ?? "", b.method ?? "")
  );
}

export function compareDiagnostics(a: ContractDiagnostic, b: ContractDiagnostic): number {
  return (
    compareStrings(a.relativePath, b.relativePath) ||
    a.line - b.line ||
    compareStrings(a.code, b.code) ||
    compareStrings(a.message, b.message)
  );
}

export function compareEdges(a: ContractEdgeCandidate, b: ContractEdgeCandidate): number {
  return (
    compareStrings(a.edgeKind, b.edgeKind) ||
    compareStrings(a.fromSymbol, b.fromSymbol) ||
    compareStrings(a.toContractId, b.toContractId) ||
    compareStrings(a.matchBasis, b.matchBasis)
  );
}

export function sortUnique<T>(values: readonly T[], compare: (a: T, b: T) => number): T[] {
  const sorted = [...values].sort(compare);
  const out: T[] = [];
  for (const value of sorted) {
    const last = out[out.length - 1];
    if (last === undefined || compare(last, value) !== 0) {
      out.push(value);
    }
  }
  return out;
}
