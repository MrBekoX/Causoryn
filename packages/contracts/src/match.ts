import { compareEdges } from "./order.js";
import type {
  ContractCandidate,
  ContractEdgeCandidate,
  ContractEvidenceSpan,
  ServiceAnchor,
} from "./types.js";

/**
 * Saf eşleştirme çekirdeği — TŞ §11: "Farklı kaynaklar arasında
 * produces/consumes edge'i yalnızca net isim, route veya schema kimliği
 * varsa verified; isim benzerliğine dayalı eşleşmeler heuristic olur."
 *
 * Kurallar (belgeli, deterministik; girdi sırasından bağımsız çıktı):
 * 1. openapi sözleşmesi × endpoint ankrajı: method eşit VE route şekli
 *    eşdeğer VE sabit segmentler birebir → verified PRODUCES (basis route).
 *    Param segmentleri ({x} / :y) çapraz eşleşir; literal case farkı →
 *    heuristic (basis name-similarity). Segman sayısı farklı → kenar yok.
 * 2. asyncapi sözleşmesi × producer/consumer ankrajı: topic birebir →
 *    verified (basis topic-id); yön çelişkisi (consumer ↔ publish-only) →
 *    heuristic CONSUMES/PRODUCES. Farklı topic → kenar yok.
 * 3. sql sözleşmesi × table ankrajı: ham isim birebir → verified CONSUMES
 *    (basis name-exact); yalnızca case/separator normalize eşitliği →
 *    heuristic (basis name-similarity). Diğer zayıf benzerlik kenar ÜRETMEZ.
 * 4. Kaynak türü sınırı: endpoint↔openapi, producer/consumer↔asyncapi,
 *    table↔sql dışı çiftler eşleşmez (json-schema/protobuf SchemaContract
 *    adayları bu çekirdekte kenar üretmez). TŞ §11'in "schema kimliği"
 *    verified tabanı D1'de henüz ÜRETİLMİYOR: schema-id tabanlı bağlama,
 *    ServiceAnchor'a schemaId alanının eklenmesiyle D2/D3 diliminde
 *    kapanacaktır (bkz. types.ts ServiceAnchor seam notu).
 * 5. Aynı (edgeKind, fromSymbol, toContractId) için birden fazla aday
 *    doğarsa verified > heuristic kazanır; kanıtlar birleştirilir.
 */

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[-_.:(){}/]/gu, "");
}

function routeSegments(route: string): string[] {
  return route.split("/").filter((segment) => segment.length > 0);
}

function isParamSegment(segment: string): boolean {
  return segment.startsWith("{") || segment.startsWith(":");
}

/**
 * Route şekil eşdeğerliği: segment sayısı eşit; her segment ya çift taraflı
 * param ya birebir aynı literal.
 */
function routesShapeEqual(a: string, b: string): boolean {
  const sa = routeSegments(a);
  const sb = routeSegments(b);
  if (sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i += 1) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined || y === undefined) return false;
    if (isParamSegment(x) && isParamSegment(y)) continue;
    if (x !== y) return false;
  }
  return true;
}

/** Route literal'leri (param adları hariç) birebir eşit mi. */
function routeLiteralsExact(a: string, b: string): boolean {
  const sa = routeSegments(a);
  const sb = routeSegments(b);
  if (sa.length !== sb.length) return false;
  for (let i = 0; i < sa.length; i += 1) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined || y === undefined) return false;
    if (isParamSegment(x) !== isParamSegment(y)) return false;
    if (isParamSegment(x) && isParamSegment(y)) continue;
    if (x !== y) return false;
  }
  return true;
}

function evidenceKey(span: ContractEvidenceSpan): string {
  return span.relativePath + ":" + String(span.startLine) + ":" + String(span.endLine);
}

function mergeEvidence(
  primary: ContractEvidenceSpan,
  secondary: ContractEvidenceSpan,
): ContractEvidenceSpan[] {
  const merged: ContractEvidenceSpan[] = [];
  const seen = new Set<string>();
  for (const span of [primary, secondary]) {
    const key = evidenceKey(span);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(span);
    }
  }
  return merged;
}

interface PendingEdge {
  readonly edgeKind: ContractEdgeCandidate["edgeKind"];
  readonly fromSymbol: string;
  readonly toContractId: string;
  readonly resolution: ContractEdgeCandidate["resolution"];
  readonly matchBasis: ContractEdgeCandidate["matchBasis"];
  readonly evidence: ContractEvidenceSpan[];
}

export function matchContractEdges(
  contracts: readonly ContractCandidate[],
  anchors: readonly ServiceAnchor[],
): ContractEdgeCandidate[] {
  const pending = new Map<string, PendingEdge>();

  const put = (edge: PendingEdge): void => {
    const key = edge.edgeKind + "|" + edge.fromSymbol + "|" + edge.toContractId;
    const existing = pending.get(key);
    if (existing === undefined) {
      pending.set(key, edge);
      return;
    }
    // verified > heuristic kazanır; kanıtlar sıra korunarak birleştirilir.
    const winner =
      existing.resolution === "verified" || edge.resolution !== "verified" ? existing : edge;
    const loser = winner === existing ? edge : existing;
    const merged: ContractEvidenceSpan[] = [];
    const seen = new Set<string>();
    for (const span of [...winner.evidence, ...loser.evidence]) {
      const spanKey = evidenceKey(span);
      if (!seen.has(spanKey)) {
        seen.add(spanKey);
        merged.push(span);
      }
    }
    pending.set(key, { ...winner, evidence: merged });
  };

  for (const contract of contracts) {
    if (contract.sourceKind === "openapi" && contract.method !== undefined && contract.route !== undefined) {
      for (const anchor of anchors) {
        if (anchor.anchorKind !== "endpoint") continue;
        if (anchor.method === undefined || anchor.route === undefined) continue;
        if (anchor.method.toUpperCase() !== contract.method.toUpperCase()) continue;

        if (routesShapeEqual(anchor.route, contract.route) && routeLiteralsExact(anchor.route, contract.route)) {
          put({
            edgeKind: "PRODUCES_CONTRACT",
            fromSymbol: anchor.symbol,
            toContractId: contract.contractId,
            resolution: "verified",
            matchBasis: "route",
            evidence: mergeEvidence(anchor.evidence, contract.evidence),
          });
          continue;
        }
        if (normalizeName(anchor.route) === normalizeName(contract.route)) {
          put({
            edgeKind: "PRODUCES_CONTRACT",
            fromSymbol: anchor.symbol,
            toContractId: contract.contractId,
            resolution: "heuristic",
            matchBasis: "name-similarity",
            evidence: mergeEvidence(anchor.evidence, contract.evidence),
          });
        }
      }
      continue;
    }

    if (contract.sourceKind === "asyncapi" && contract.topic !== undefined) {
      for (const anchor of anchors) {
        if (anchor.topic === undefined) continue;
        if (anchor.topic !== contract.topic) continue; // net topic kimliği; zayıf benzerlik kenar üretmez
        const isProducer = anchor.anchorKind === "producer";
        const isConsumer = anchor.anchorKind === "consumer";
        if (!isProducer && !isConsumer) continue;
        const direction = contract.channelDirection;
        const directionMatch =
          (isProducer && direction === "publish") || (isConsumer && direction === "subscribe");
        put({
          edgeKind: isProducer ? "PRODUCES_CONTRACT" : "CONSUMES_CONTRACT",
          fromSymbol: anchor.symbol,
          toContractId: contract.contractId,
          resolution: directionMatch ? "verified" : "heuristic",
          matchBasis: "topic-id",
          evidence: mergeEvidence(anchor.evidence, contract.evidence),
        });
      }
      continue;
    }

    if (contract.sourceKind === "sql" && contract.name.length > 0) {
      for (const anchor of anchors) {
        if (anchor.anchorKind !== "table") continue;
        const table = anchor.table;
        if (table === undefined) continue;
        if (table === contract.name) {
          put({
            edgeKind: "CONSUMES_CONTRACT",
            fromSymbol: anchor.symbol,
            toContractId: contract.contractId,
            resolution: "verified",
            matchBasis: "name-exact",
            evidence: mergeEvidence(anchor.evidence, contract.evidence),
          });
          continue;
        }
        if (normalizeName(table) === normalizeName(contract.name)) {
          put({
            edgeKind: "CONSUMES_CONTRACT",
            fromSymbol: anchor.symbol,
            toContractId: contract.contractId,
            resolution: "heuristic",
            matchBasis: "name-similarity",
            evidence: mergeEvidence(anchor.evidence, contract.evidence),
          });
        }
      }
    }
  }

  return [...pending.values()]
    .sort(compareEdges)
    .map((edge) => ({
      edgeKind: edge.edgeKind,
      fromSymbol: edge.fromSymbol,
      toContractId: edge.toContractId,
      resolution: edge.resolution,
      matchBasis: edge.matchBasis,
      evidence: edge.evidence,
    }));
}
