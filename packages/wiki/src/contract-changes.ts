import type { ContractChangeRecord } from "@causoryn/contracts";
import {
  canonicalJson,
  sha256Hex,
  utf8Encode,
  type GraphNode,
  type SnapshotGraph,
} from "@causoryn/domain";

import { WikiProjectionError } from "./errors.js";

/**
 * wiki_diff contractChanges saf çekirdeği — K-013(7) kesinleşmesi (sprint-5
 * D7; wiki/decisions.md K-013 #7; TŞ §16A.4 wiki_diff çıktısındaki
 * contractChanges alanının veri gövdesi).
 *
 * ÜRETİCİ SÖZLEŞMESİ: packages/contracts contract-drift.ts
 * `ContractChangeRecord` — {contractId, changeKind: added|removed|modified,
 * summary}. D3 çekirdeği (detectContractDrift) bu kaydı iki DiscoveryOutput
 * üzerinden KURAL DEĞERLENDİRMESİYLE üretir; bu modül ise iki WikiSnapshot'ın
 * ARKA GRAPH SNAPSHOT'larının SÖZLEŞME NODE YÜZEYLERİNİ karşılaştırır ve AYNI
 * gövdeyi üretir. Bu katman backward-safe/breaking KARARI VERMEZ — o D2/D3'ün
 * işidir; burada yalnızca node yüzey farkı dürüstçe raporlanır.
 *
 * Sözleşme node türleri projection.ts CONTRACT_NODE_KINDS ile aynıdır
 * (ApiContract/EventContract/SchemaContract/ContractVersion — TŞ §8 kataloğu
 * ve wiki Child Sources "contract" pageKind eşlemesi).
 *
 * Semantik (D3/D2 ile hizalı, deterministik):
 * - Kimlik (contractId): domain nodeId sözleşmesi — D1 ContractCandidate.
 *   contractId karşılık anahtarı DEĞİLDİR: D2 stableKey'in endpoint-olmayan
 *   dalı gibi "<nodeKind> <qualifiedName>" anahtarıyla eşleşir (graph node
 *   yüzeyi method/route'u yazılmış alan olarak taşımaz; rota/metot düzeyi
 *   ayrım D2/D3 yüzeyinde kalır).
 * - added: anahtar yalnızca target'ta → contractId = TARGET kimliği.
 * - removed: anahtar yalnızca base'de → contractId = BASE kimliği (D3 kuralı:
 *   "değişiklik sonrasında geçerli kimlik" — hedefte kimlik yoktur).
 * - modified: anahtar her iki tarafta ve içerik karması farklı → contractId =
 *   TARGET kimliği (aynı D3 kuralı). Aynı karma → unchanged, raporlanmaz.
 *   (D3 ile uyumlu: içerik birebir aynıysa kural bulgusu da üretilmez.)
 * - Bir anahtar bir tarafta birden çok kez görünüyorsa kanonik contractId
 *   sırasında İLK kayıt kazanır (D2 first-wins örüntüsü).
 * - summary: deterministik tek satır; modified kaydında base/target karma
 *   parçaları (12 hex) taşınır — özet uydurma değil, yüzey karmalarının
 *   türevidir.
 * - Çıktı (contractId, changeKind, summary) kod noktası sırasıyla kanoniktir
 *   (D3 compareChangeRecords ile aynı anahtar); girdi dizi sırasından
 *   bağımsızdır (TŞ §8 invariant vi: aynı giriş → aynı çıktı JSON).
 *
 * SAF ÇEKİRDEK: fs/thread/saat/rastgele okumaz; MCP türü import etmez;
 * @causoryn/contracts yalnızca ÜRETİCİ SÖZLEŞME TİPİ için tüketilir.
 */

/** Sözleşme yüzeyine sayılan node türleri (projection.ts ile aynı küme). */
export const WIKI_CONTRACT_NODE_KINDS: readonly string[] = [
  "ApiContract",
  "EventContract",
  "SchemaContract",
  "ContractVersion",
];

const WIKI_CONTRACT_NODE_KIND_SET: ReadonlySet<string> = new Set(
  WIKI_CONTRACT_NODE_KINDS,
);

/** Modified summary'sindeki karma parça uzunluğu (okunabilirlik; determinizmi etkilemez). */
const SUMMARY_HASH_PREFIX = 12;

/**
 * Tek sözleşme node'unun karşılaştırma yüzeyi. `contractId` domain
 * nodeId'dir (D1 sözleşmesi); `contentHash` kimlik DIŞI içeriğin
 * (kind/qualifiedName/language/location/attributes) canonical JSON karmaşıdır.
 */
export interface WikiContractNodeSurface {
  readonly contractId: string;
  readonly nodeKind: string;
  readonly qualifiedName: string;
  readonly contentHash: string;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** D3 compareChangeRecords ile aynı kanonik sıralama anahtarı. */
function compareChangeRecords(a: ContractChangeRecord, b: ContractChangeRecord): number {
  return (
    compareStrings(a.contractId, b.contractId) ||
    compareStrings(a.changeKind, b.changeKind) ||
    compareStrings(a.summary, b.summary)
  );
}

/** Yüzey kaydı doğrulaması — bozuk girdi çekirdeğe SOKULMAZ (açık reddi). */
function assertSurface(
  value: readonly WikiContractNodeSurface[],
  label: string,
): readonly WikiContractNodeSurface[] {
  if (!Array.isArray(value)) {
    throw new WikiProjectionError(
      "wiki/invalid-contract-surface",
      `${label} contract surface failed validation (wiki/invalid-contract-surface): must be an array`,
    );
  }
  for (const entry of value) {
    for (const field of ["contractId", "nodeKind", "qualifiedName", "contentHash"] as const) {
      const fieldValue = entry?.[field];
      if (typeof fieldValue !== "string" || fieldValue.length === 0) {
        throw new WikiProjectionError(
          "wiki/invalid-contract-surface",
          `${label} contract surface failed validation (wiki/invalid-contract-surface): ${field} must be a non-empty string`,
        );
      }
    }
  }
  return value;
}

/**
 * Node'un kimlik dışı içeriğinin karması: kind/qualifiedName/language/
 * location/attributes canonical JSON'u (id bilinçli olarak dışarıdadır —
 * kimlik contractId zaten taşır; içerik farkı karmayı değiştirir).
 * attributes Readonly<Record<string, unknown>> türündedir; canonicalJson
 * JsonValue kataloğuyla çalıştığından depoda kurulu ev çağrısı deseni
 * (services-wiki canonicalJson kullanımı) ile taşınır — içerik aynıdır,
 * yalnızca statik tip kataloğa oturtulur.
 */
function nodeContentHash(node: GraphNode): string {
  const content = {
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    ...(node.language === undefined ? {} : { language: node.language }),
    ...(node.location === undefined ? {} : { location: node.location }),
    attributes: node.attributes,
  };
  return sha256Hex(
    utf8Encode(canonicalJson(content as unknown as Parameters<typeof canonicalJson>[0])),
  );
}

/**
 * Graph snapshot'ının sözleşme node yüzeyi: WIKI_CONTRACT_NODE_KINDS
 * türündeki node'lar, contractId'ye göre kanonik sırada (girdi dizi
 * sırasından bağımsızlık; TŞ §8 invariant iv/vi).
 */
export function wikiContractSurfaceOf(
  graph: SnapshotGraph,
): readonly WikiContractNodeSurface[] {
  return graph.nodes
    .filter((node) => WIKI_CONTRACT_NODE_KIND_SET.has(node.kind))
    .map((node) => ({
      contractId: node.id,
      nodeKind: node.kind,
      qualifiedName: node.qualifiedName,
      contentHash: nodeContentHash(node),
    }))
    .sort((a, b) => compareStrings(a.contractId, b.contractId));
}

/**
 * İki sözleşme yüzeyi arasındaki K-013(7) kayıtlarını üretir: her anahtar
 * (nodeKind + qualifiedName) için added/removed/modified kararı; değişmeyen
 * anahtarlar raporlanmaz; boş yüzeyler boş döner (uydurma kayıt yok).
 */
export function computeWikiContractChanges(
  base: readonly WikiContractNodeSurface[],
  target: readonly WikiContractNodeSurface[],
): readonly ContractChangeRecord[] {
  assertSurface(base, "base");
  assertSurface(target, "target");

  // first-wins (kanonik contractId sırası): aynı anahtarlı kayıtlarda ilk
  // kazanır — girdi sırasından bağımsızlık için yüzeyler kanonik gezilir.
  const firstWinsBySurface = (
    surface: readonly WikiContractNodeSurface[],
  ): Map<string, WikiContractNodeSurface> => {
    const byKey = new Map<string, WikiContractNodeSurface>();
    for (const entry of [...surface].sort((a, b) =>
      compareStrings(a.contractId, b.contractId),
    )) {
      const key = `${entry.nodeKind} ${entry.qualifiedName}`;
      if (!byKey.has(key)) byKey.set(key, entry);
    }
    return byKey;
  };

  const baseByKey = firstWinsBySurface(base);
  const targetByKey = firstWinsBySurface(target);

  const changes: ContractChangeRecord[] = [];
  const keys = new Set<string>([...baseByKey.keys(), ...targetByKey.keys()]);
  for (const key of [...keys].sort(compareStrings)) {
    const baseEntry = baseByKey.get(key);
    const targetEntry = targetByKey.get(key);

    if (baseEntry === undefined && targetEntry !== undefined) {
      changes.push({
        contractId: targetEntry.contractId,
        changeKind: "added",
        summary: `${targetEntry.qualifiedName} added: new entry in the target WikiSnapshot's graph contract surface`,
      });
      continue;
    }
    if (baseEntry !== undefined && targetEntry === undefined) {
      changes.push({
        contractId: baseEntry.contractId,
        changeKind: "removed",
        summary: `${baseEntry.qualifiedName} removed: no entry in the target WikiSnapshot's graph contract surface`,
      });
      continue;
    }
    if (
      baseEntry !== undefined &&
      targetEntry !== undefined &&
      baseEntry.contentHash !== targetEntry.contentHash
    ) {
      // D3 kimlik kuralı: değişiklik sonrasında geçerli kimlik = TARGET.
      changes.push({
        contractId: targetEntry.contractId,
        changeKind: "modified",
        summary:
          `${targetEntry.qualifiedName} modified: contract content hash changed ` +
          `(base=${baseEntry.contentHash.slice(0, SUMMARY_HASH_PREFIX)} → ` +
          `target=${targetEntry.contentHash.slice(0, SUMMARY_HASH_PREFIX)})`,
      });
    }
    // Her iki tarafta ve aynı karma → unchanged; K-013(7) kaydı ÜRETİLMEZ.
  }

  return [...changes].sort(compareChangeRecords);
}
