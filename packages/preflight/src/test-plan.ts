import {
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type Resolution,
  type SnapshotGraph,
} from "@causoryn/domain";

import { PreflightError } from "./errors.js";

/**
 * causoryn_derive_test_plan çekirdeği — sprint-5 D6.
 *
 * Sözleşme (TŞ v2.1 §15, Sayfa 13 — birincil kaynaktan pdftotext
 * çıkarımıyla doğrulandı): "TESTS edge'leri, test naming/framework
 * bindings, changed call sites, impacted contracts üzerinden test
 * adayları çıkarılır. Her öneri reason, evidenceIds, matchLevel,
 * missingCoverageCandidate taşır. 'Bu testler geçti' ifadesi ancak
 * gerçek test raporu kanıtı varsa gösterilir. Causoryn kendi kendine
 * build/restore/test komutu çalıştırmaz." TŞ §3.1 sorumluluk matrisi:
 * "Testleri çalıştırma → Hayır; varsayılan yalnızca test planı üretir."
 *
 * Tasarım kararları (TŞ metninin deterministik yorumu):
 * - Üç sinyal, tek birleşik aday kümesi:
 *   1. direct       : değişen node'a gelen TESTS kenarları (kenar başına
 *     aday; depth 1; resolution = kenarın resolution'ı; evidence =
 *     kenar kanıtları).
 *   2. call-site    : değişen SEMBOLLERden ters CALLS BFS'i (impact.ts
 *     örüntüsü; basit yollar, edge.id kanonik genişleme sırası); kind=Test
 *     node'a ulaşan zincir adaydır, test node'undan ileri gidilmez;
 *     resolution zincirin en zayıf halkası, evidence yolun birleşik
 *     kanıtıdır. Değişen DOSYALAR call-site kökü değildir (dosya
 *     çağrılamaz).
 *   3. naming       : değişen dosya adı/sembol adı ile snapshot'taki
 *     test-affinity dosya yollarının (X.test.ts, X.spec.ts, XTests.cs
 *     kalıpları — bkz. testAffinityBase) isim bağlamı; resolution daima
 *     "heuristic", depth 0, kenar/kanıt yok — dosya adı benzerliği tek
 *     başına kanıt değildir (düşük güven).
 * - Birleşme: aynı (changedNodeId, testNodeId) çifti tek adayda çözülür;
 *   en güçlü sinyalin matchLevel/depth/edges/reason taşınır
 *   (direct > call-site > naming), evidenceIds tüm sinyallerin tekrarsız
 *   birleşimidir. File node'una bağlanan naming adayının testKind'i
 *   "File"dır; Test node'una bağlanabilirse testKind "Test"tir.
 * - missingCoverageCandidates: hiçbir incoming TESTS kenarı bilmeyen
 *   değişen semboller. Bu bir COVERAGE GAP ADAYLIĞIDIR: test varlığı/
 *   yokluğu doğrulanmaz, yalnızca graf üzerinde TESTS kenarı
 *   bulunmadığı raporlanır.
 * - Kırmızı çizgi: çıktıda "bu test çalıştırıldı/geçti" türünden
 *   ÇALIŞTIRMA İDDİASI ÜRETİLMEZ (test test-plan.test.ts ile denetlenir).
 *   Sonuç yalnızca aday + gerekçe (reason) + kanıt referansı taşır; test
 *   koşusu bu çekirdeğin sorumluluğu değildir (TŞ §15).
 * - Sınırlar (TŞ §20 resource budget örüntüsü): maxDepth (call-site BFS
 *   derinliği), maxCandidates (tutulacak aday sayısı). İstek tavanı
 *   aşarsa tavana kırpılır ve rationale düşer; hangi tavanın vurulduğu
 *   truncatedBy ile raporlanır.
 * - Saf fonksiyon: girdi yalnızca SnapshotGraph + DeriveTestPlanInput;
 *   saat okumaz, rastgelelik kullanmaz, MCP türlerini import etmez. Tüm
 *   çıktı dizileri kanonik sıralı → aynı girdi iki koşumda bit-bit aynı
 *   JSON'u üretir; girdi dizi sırası çıktıyı değiştirmez.
 */

/** TŞ v2.1 §20 (Sayfa 22) resource budget tavanları (impact örüntüsü). */
export const TEST_PLAN_LIMIT_CEILINGS: TestPlanAppliedLimits = {
  maxDepth: 6,
  maxCandidates: 50,
};

/** İstek yapılmadığında uygulanan varsayılanlar. */
export const TEST_PLAN_DEFAULTS: TestPlanAppliedLimits = {
  maxDepth: 3,
  maxCandidates: 20,
};

/**
 * Eşleşme düzeyi (sprint-5 D6): direct — TESTS kenarı; naming — test
 * dosyası isimlendirme bağlamı; call-site — değişen çağrı noktası
 * üzerinden CALLS zinciri.
 */
export type TestPlanMatchLevel = "direct" | "naming" | "call-site";

/** Aday sinyal gücü: direct > call-site > naming (birleşme önceliği). */
type MatchLevelStrength = 3 | 2 | 1;

const MATCH_LEVEL_STRENGTH: Readonly<
  Record<TestPlanMatchLevel, MatchLevelStrength>
> = { direct: 3, "call-site": 2, naming: 1 };

/** Kesme nedeni: hangi resource budget tavanı vuruldu (TŞ §20). */
export type TestPlanTruncatedBy = "maxCandidates" | "maxDepth";

/** Uygulanan sınırlar; istek tavanı aşarsa tavana kırpılır. */
export interface TestPlanAppliedLimits {
  readonly maxDepth: number;
  readonly maxCandidates: number;
}

/** deriveTestPlan girdisi (sprint-5 D6: değişen sembol/dosya seti). */
export interface DeriveTestPlanInput {
  /**
   * Değişen semboller: yayımlanmış node kimliği (`node:...`) veya TAM
   * qualifiedName. Belirsiz ad otomatik kesinleştirilmez; adaylarla
   * `unresolvedSymbols`'a yazılır (impact.ts:342-375 ile aynı sözleşme).
   */
  readonly changedSymbols?: readonly string[];
  /**
   * Değişen dosyalar: depo-göreli yol. Snapshot'taqualifiedName'i bu yola
   * eşit (TS adapter convention'ı: analyzer.ts:545) veya
   * location.relativePath'i bu yola eşit File node'u aranır.
   */
  readonly changedFiles?: readonly string[];
  /** call-site BFS derinlik sınırı (tavan: TEST_PLAN_LIMIT_CEILINGS). */
  readonly maxDepth?: number;
  /** Tutulacak toplam aday sınırı (tavan: TEST_PLAN_LIMIT_CEILINGS). */
  readonly maxCandidates?: number;
}

/** Aday yolundaki tek kenar referansı (ImpactEdgeRef örüntüsü). */
export interface TestPlanEdgeRef {
  readonly edgeId: string;
  readonly kind: EdgeKind;
  readonly from: string;
  readonly to: string;
  readonly resolution: Resolution;
  readonly evidenceIds: readonly string[];
}

/** Çözümlenmiş değişen sembol referansı. */
export interface TestPlanSymbolRef {
  readonly nodeId: string;
  readonly kind: NodeKind;
  readonly qualifiedName: string;
}

/**
 * Tek test adayı: TŞ §15 "Her öneri reason, evidenceIds, matchLevel ...
 * taşır" sözleşmesinin bire bir karşılığı. Adaylık iddiasıdır; testin
 * çalıştırıldığı/geçtiği ASLA iddia edilmez.
 */
export interface TestPlanCandidate {
  /** Kanonik aday kimliği: testplan:0001, testplan:0002, ... */
  readonly candidateId: string;
  readonly testNodeId: string;
  readonly testQualifiedName: string;
  readonly testKind: NodeKind;
  /** Adayı üreten değişen node (sembol veya dosya node'u). */
  readonly changedNodeId: string;
  readonly changedQualifiedName: string;
  readonly matchLevel: TestPlanMatchLevel;
  /** Zincirin/kenarın çözümleme düzeyi; naming daima heuristic. */
  readonly resolution: Resolution;
  /** direct: 1; call-site: zincir kenar sayısı; naming: 0. */
  readonly depth: number;
  /** Gerekçe — deterministik Türkçe metin; çalıştırma iddiası taşımaz. */
  readonly reason: string;
  /** Birleşik kanıt kimlikleri: tekrarsız, kanonik sırada. */
  readonly evidenceIds: readonly string[];
  /** Sinyali üreten kenar zinciri (en güçlü sinyalinki); naming'de boş. */
  readonly edges: readonly TestPlanEdgeRef[];
}

/** Coverage gap adayı: hiç incoming TESTS kenarı bilmeyen değişen sembol. */
export interface TestPlanMissingCoverageCandidate {
  readonly nodeId: string;
  readonly kind: NodeKind;
  readonly qualifiedName: string;
  readonly reason: string;
}

/** Çözülemeyen/belirsiz değişen sembol + neden (otomatik kesinleştirme yok). */
export interface TestPlanUnresolvedSymbol {
  readonly target: string;
  readonly reason: string;
}

/** Özet: matchLevel başına aday sayıları + coverage gap sayısı. */
export interface TestPlanSummary {
  readonly direct: number;
  readonly naming: number;
  readonly callSite: number;
  readonly totalCandidates: number;
  readonly missingCoverageCandidates: number;
}

/**
 * Test planı sonucu. Sözleşme: yalnızca aday + gerekçe; boş plan bile
 * `rationales` ile açıkça gerekçelenir (negatif senaryo TŞ §20 "analiz
 * edilmeyen aralıklar açık raporlanır" örüntüsüyle aynı dürüstlük ilkesi).
 */
export interface TestPlanResult {
  readonly snapshotId: string;
  readonly identifiedSymbols: readonly TestPlanSymbolRef[];
  readonly unresolvedSymbols: readonly TestPlanUnresolvedSymbol[];
  readonly candidates: readonly TestPlanCandidate[];
  readonly missingCoverageCandidates: readonly TestPlanMissingCoverageCandidate[];
  readonly summary: TestPlanSummary;
  readonly truncated: boolean;
  readonly truncatedBy: readonly TestPlanTruncatedBy[];
  readonly limits: TestPlanAppliedLimits;
  readonly rationales: readonly string[];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Güç sıralaması: verified en güçlü, unresolved en zayıf (TŞ §13). */
const RESOLUTION_STRENGTH: Readonly<Record<Resolution, number>> = {
  verified: 3,
  heuristic: 2,
  unresolved: 1,
};

function weakestResolution(a: Resolution, b: Resolution): Resolution {
  return RESOLUTION_STRENGTH[a] <= RESOLUTION_STRENGTH[b] ? a : b;
}

function requireLimit(
  name: string,
  requested: number | undefined,
  ceiling: number,
  rationales: string[],
): number {
  if (requested === undefined) return ceiling;
  if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) {
    throw new PreflightError(
      "preflight/invalid-input",
      `${name} pozitif tam sayı olmalı: ${String(requested)}`,
    );
  }
  if (requested > ceiling) {
    rationales.push(
      `${name}=${String(requested)} istenen değeri tavana (${String(ceiling)}) indirildi (TŞ §20 resource budget)`,
    );
    return ceiling;
  }
  return requested;
}

function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

/** Son uzantıyı keser; gizli dosya (.rc) korumasıyla. */
function stripLastExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return name;
  return name.slice(0, idx);
}

/**
 * Snapshot dosya yolundan test-affinity taban adı: "X.test.ts" → "X",
 * "X.spec.ts" → "X", "XTests.cs" → "X". Affinity yoksa null. Kalıp
 * kümesi bilinçli olarak küçük ve case-sensitive tutulmuştur; genişletme
 * bu dokümanda belirtilmedikçe yapılmaz (RedDoS/telef belirsizliği yok:
 * desenler sabit son ek karşılaştırmasıdır, regex kullanılmaz).
 */
function testAffinityBase(filePath: string): string | null {
  const stem = stripLastExtension(basenameOf(filePath));
  for (const marker of [".test", ".spec", ".tests"]) {
    if (stem.length > marker.length && stem.endsWith(marker)) {
      return stem.slice(0, stem.length - marker.length);
    }
  }
  for (const suffix of ["Tests", "Test", "Spec"]) {
    if (stem.length > suffix.length && stem.endsWith(suffix)) {
      return stem.slice(0, stem.length - suffix.length);
    }
  }
  return null;
}

/** Değişen dosya yolundan isim bağlamı tabanı: "src/a/X.ts" → "X". */
function changedFileBase(path: string): string {
  return stripLastExtension(basenameOf(path));
}

/** Sembol adının son nokta segmenti: "A.B.XService" → "XService". */
function lastSegment(qualifiedName: string): string {
  const idx = qualifiedName.lastIndexOf(".");
  return idx === -1 ? qualifiedName : qualifiedName.slice(idx + 1);
}

/** File node'unun yol karşılığı (TS adapter convention'ı önceliklidir). */
function filePathOf(node: GraphNode): string {
  return node.qualifiedName.includes("/")
    ? node.qualifiedName
    : (node.location?.relativePath ?? node.qualifiedName);
}

function toEdgeRef(edge: GraphEdge): TestPlanEdgeRef {
  return {
    edgeId: edge.id,
    kind: edge.kind,
    from: edge.from,
    to: edge.to,
    resolution: edge.resolution,
    evidenceIds: [...edge.evidenceIds].sort(cmp),
  };
}

/** Birleşme öncesi ham sinyal: (changedNodeId, testNodeId) çifti başına. */
interface RawSignal {
  readonly testNodeId: string;
  readonly testQualifiedName: string;
  readonly testKind: NodeKind;
  readonly changedNodeId: string;
  readonly matchLevel: TestPlanMatchLevel;
  readonly strength: MatchLevelStrength;
  readonly resolution: Resolution;
  readonly depth: number;
  readonly reason: string;
  readonly edgeRefs: readonly TestPlanEdgeRef[];
  readonly evidenceIds: readonly string[];
}

/** call-site BFS kısmi zinciri (impact.ts PartialPath örüntüsü). */
interface PartialCallChain {
  readonly nodes: readonly string[];
  readonly edgeRefs: readonly TestPlanEdgeRef[];
  readonly weakest: Resolution;
}

/**
 * Test planını türetir: değişen sembol/dosya kümesi → TESTS + naming +
 * call-site sinyalleri → birleşik, kanonik sıralı test adayları +
 * coverage gap adayları + açık gerekçeler. Çalıştırma iddiası üretmez.
 */
export function deriveTestPlan(
  snapshot: SnapshotGraph,
  input: DeriveTestPlanInput,
): TestPlanResult {
  // 1) Snapshot durumu: yalnızca ready/partial (impact.ts ile aynı kural).
  const state = snapshot.meta?.state;
  if (state !== "ready" && state !== "partial") {
    throw new PreflightError(
      "preflight/snapshot-state",
      `test planı yalnızca ready/partial snapshot üzerinde türetilir; snapshot durumu: ${String(state)}`,
    );
  }

  // 2) Hedef girdisi: en az bir üye; boş/blank reddedilir; tekilleştirme
  //    kanonik sırada (girdi sırası çıktıyı değiştirmemeli).
  const rawSymbols = input.changedSymbols ?? [];
  const rawFiles = input.changedFiles ?? [];
  if (rawSymbols.length === 0 && rawFiles.length === 0) {
    throw new PreflightError(
      "preflight/invalid-input",
      "changedSymbols/changedFiles kümesi boş olamaz: en az bir değişen sembol veya dosya gerekli",
    );
  }
  for (const target of rawSymbols) {
    if (typeof target !== "string" || target.trim().length === 0) {
      throw new PreflightError(
        "preflight/invalid-input",
        `changedSymbols üyesi boş/blank olamaz: ${String(target)}`,
      );
    }
  }
  for (const file of rawFiles) {
    if (typeof file !== "string" || file.trim().length === 0) {
      throw new PreflightError(
        "preflight/invalid-input",
        `changedFiles üyesi boş/blank olamaz: ${String(file)}`,
      );
    }
  }
  const uniqueSymbols = [...new Set(rawSymbols)].sort(cmp);
  const uniqueFiles = [...new Set(rawFiles)].sort(cmp);

  // 3) Sınırlar: tavan aşılırsa kırpılır ve rationale düşer (TŞ §20).
  const rationales: string[] = [];
  const limits: TestPlanAppliedLimits = {
    maxDepth: requireLimit(
      "maxDepth",
      input.maxDepth,
      TEST_PLAN_LIMIT_CEILINGS.maxDepth,
      rationales,
    ),
    maxCandidates: requireLimit(
      "maxCandidates",
      input.maxCandidates,
      TEST_PLAN_LIMIT_CEILINGS.maxCandidates,
      rationales,
    ),
  };

  // 4) Node/kenar endeksleri: id → node; TESTS ve CALLS ters komşulukları
  //    (edge.id kanonik sırasında — deterministik genişleme).
  const nodeById = new Map<string, GraphNode>();
  for (const node of snapshot.nodes) nodeById.set(node.id, node);
  const incomingTests = new Map<string, GraphEdge[]>();
  const incomingCalls = new Map<string, GraphEdge[]>();
  for (const edge of snapshot.edges) {
    if (edge.kind === "TESTS") {
      const list = incomingTests.get(edge.to);
      if (list === undefined) incomingTests.set(edge.to, [edge]);
      else list.push(edge);
    } else if (edge.kind === "CALLS") {
      const list = incomingCalls.get(edge.to);
      if (list === undefined) incomingCalls.set(edge.to, [edge]);
      else list.push(edge);
    }
  }
  for (const list of incomingTests.values()) list.sort((a, b) => cmp(a.id, b.id));
  for (const list of incomingCalls.values()) list.sort((a, b) => cmp(a.id, b.id));

  // 5) Sembol çözümleme: önce node kimliği, sonra tam qualifiedName; 0
  //    eşleşme → unresolved, >1 eşleşme → belirsiz (adaylarla; otomatik
  //    kesinleştirme YOK — TŞ §10.3 örüntüsü).
  const identifiedSymbols: TestPlanSymbolRef[] = [];
  const unresolvedSymbols: TestPlanUnresolvedSymbol[] = [];
  for (const target of uniqueSymbols) {
    const byId = nodeById.get(target);
    if (byId !== undefined) {
      identifiedSymbols.push({
        nodeId: byId.id,
        kind: byId.kind,
        qualifiedName: byId.qualifiedName,
      });
      continue;
    }
    const byName = snapshot.nodes.filter((node) => node.qualifiedName === target);
    if (byName.length === 1) {
      const node = byName[0] as GraphNode;
      identifiedSymbols.push({
        nodeId: node.id,
        kind: node.kind,
        qualifiedName: node.qualifiedName,
      });
      continue;
    }
    if (byName.length === 0) {
      const reason = `hedef çözülemedi: "${target}" — node kimliği veya tam qualifiedName olarak yayınlanmış snapshot'ta bulunamadı`;
      unresolvedSymbols.push({ target, reason });
      rationales.push(reason);
    } else {
      const candidateIds = byName.map((node) => node.id).sort(cmp);
      const reason = `hedef belirsiz: "${target}" tam qualifiedName ${String(byName.length)} node ile eşleşti (${candidateIds.join(", ")}); node kimliği ile hedefleyin`;
      unresolvedSymbols.push({ target, reason });
      rationales.push(reason);
    }
  }
  identifiedSymbols.sort((a, b) => cmp(a.nodeId, b.nodeId));
  unresolvedSymbols.sort((a, b) => cmp(a.target, b.target));

  // 6) Değişen dosyaların File node'larıyla eşleşmesi (qualifiedName veya
  //    location.relativePath üzerinden; birden fazla eşleşme savunmada
  //    id sırasının ilkiyle çözülür).
  const fileNodeByPath = new Map<string, GraphNode>();
  for (const node of snapshot.nodes) {
    if (node.kind !== "File") continue;
    const path = filePathOf(node);
    const existing = fileNodeByPath.get(path);
    if (existing === undefined || cmp(existing.id, node.id) > 0) {
      fileNodeByPath.set(path, node);
    }
  }
  const matchedFileNodes: GraphNode[] = [];
  for (const file of uniqueFiles) {
    const node = fileNodeByPath.get(file);
    if (node === undefined) {
      rationales.push(
        `değişen dosya eşleşmedi: "${file}" — snapshot'ta bu yolla File node yok; sinyal üretilmedi`,
      );
    } else {
      matchedFileNodes.push(node);
    }
  }
  matchedFileNodes.sort((a, b) => cmp(a.id, b.id));

  // 7) Değişen node kümesi: çözümlenen semboller + eşleşen dosya node'ları.
  const changedNodes: GraphNode[] = [];
  for (const symbol of identifiedSymbols) {
    const node = nodeById.get(symbol.nodeId);
    if (node !== undefined) changedNodes.push(node);
  }
  changedNodes.push(...matchedFileNodes);
  changedNodes.sort((a, b) => cmp(a.id, b.id));

  // 8) Sinyal 1 — direct: değişen her node'a gelen TESTS kenarları.
  const rawSignals: RawSignal[] = [];
  for (const changed of changedNodes) {
    for (const edge of incomingTests.get(changed.id) ?? []) {
      const test = nodeById.get(edge.from);
      if (test === undefined) continue; // savunma: snapshot'tan gelen id
      rawSignals.push({
        testNodeId: test.id,
        testQualifiedName: test.qualifiedName,
        testKind: test.kind,
        changedNodeId: changed.id,
        matchLevel: "direct",
        strength: MATCH_LEVEL_STRENGTH.direct,
        resolution: edge.resolution,
        depth: 1,
        reason: `direct: "${test.qualifiedName}" (${test.kind}), değişen "${changed.qualifiedName}" ile TESTS kenarıyla bağlı (kenar: ${edge.id}, resolution: ${edge.resolution})`,
        edgeRefs: [toEdgeRef(edge)],
        evidenceIds: [...edge.evidenceIds],
      });
    }
  }

  // 9) Sinyal 2 — call-site: değişen SEMBOLLERden ters CALLS BFS (basit
  //    yollar, edge.id kanonik sırası). Test node'una ulaşan zincir adaydır;
  //    test node'undan ileri genişlenmez; node başına tek (en kısa) zincir
  //    tutulur. Değişen dosyalar bu taramanın kökü değildir.
  const callSiteRecorded = new Set<string>();
  const truncatedBy = new Set<TestPlanTruncatedBy>();
  let signalBudgetReached = false;
  for (const symbol of identifiedSymbols) {
    if (signalBudgetReached) break;
    const rootKind = nodeById.get(symbol.nodeId)?.kind;
    if (rootKind === "Test") continue; // kök zaten test node'u: sinyal yok
    const enqueued = new Set<string>([symbol.nodeId]);
    const queue: PartialCallChain[] = [
      { nodes: [symbol.nodeId], edgeRefs: [], weakest: "verified" },
    ];
    let head = 0;
    while (head < queue.length) {
      const partial = queue[head] as PartialCallChain;
      head += 1;
      const current = partial.nodes[partial.nodes.length - 1] as string;
      for (const edge of incomingCalls.get(current) ?? []) {
        const next = edge.from;
        if (partial.nodes.includes(next)) continue; // basit yol
        const nextDepth = partial.edgeRefs.length + 1;
        if (nextDepth > limits.maxDepth) {
          truncatedBy.add("maxDepth");
          continue;
        }
        const nextNode = nodeById.get(next);
        if (nextNode === undefined) continue; // savunma: dangling
        const weakest = weakestResolution(partial.weakest, edge.resolution);
        if (nextNode.kind === "Test") {
          const recordKey = `${symbol.nodeId}\u0000${next}`;
          if (!callSiteRecorded.has(recordKey)) {
            callSiteRecorded.add(recordKey);
            if (rawSignals.length >= limits.maxCandidates) {
              signalBudgetReached = true;
              truncatedBy.add("maxCandidates");
              break;
            }
            const chainIds = [...partial.edgeRefs, toEdgeRef(edge)]
              .map((ref) => ref.edgeId)
              .join(" → ");
            rawSignals.push({
              testNodeId: nextNode.id,
              testQualifiedName: nextNode.qualifiedName,
              testKind: nextNode.kind,
              changedNodeId: symbol.nodeId,
              matchLevel: "call-site",
              strength: MATCH_LEVEL_STRENGTH["call-site"],
              resolution: weakest,
              depth: nextDepth,
              reason: `call-site: "${nextNode.qualifiedName}" testi, değişen "${symbol.qualifiedName}" sembolüne ${String(nextDepth)} adımlık CALLS zinciriyle ulaşıyor (en zayıf resolution: ${weakest}; zincir: ${chainIds})`,
              edgeRefs: [...partial.edgeRefs, toEdgeRef(edge)],
              evidenceIds: [...partial.edgeRefs, toEdgeRef(edge)].flatMap(
                (ref) => ref.evidenceIds,
              ),
            });
          }
          continue; // test node'undan ileri gidilmez
        }
        if (enqueued.has(next)) continue;
        enqueued.add(next);
        queue.push({
          nodes: [...partial.nodes, next],
          edgeRefs: [...partial.edgeRefs, toEdgeRef(edge)],
          weakest,
        });
      }
      if (signalBudgetReached) break;
    }
  }

  // 10) Sinyal 3 — naming: değişen dosya adı/sembol adı ↔ snapshot test
  //     dosyası isim bağlamı. Tabanlar (base) → test-affinity yollar
  //     kanonik sıralı; resolution daima heuristic; kenar/kanıt yok.
  const testBaseToPath = new Map<string, string[]>();
  const testNodeByPath = new Map<string, GraphNode[]>();
  for (const node of snapshot.nodes) {
    if (node.kind === "File") {
      const base = testAffinityBase(filePathOf(node));
      if (base !== null) {
        const list = testBaseToPath.get(base);
        if (list === undefined) testBaseToPath.set(base, [filePathOf(node)]);
        else if (!list.includes(filePathOf(node))) list.push(filePathOf(node));
      }
    } else if (node.kind === "Test" && node.location !== undefined) {
      const path = node.location.relativePath;
      const list = testNodeByPath.get(path);
      if (list === undefined) testNodeByPath.set(path, [node]);
      else list.push(node);
      // Test node'unun kendi yolu da isim bağlamı haritasına katılır:
      // File node'u olmayan test yolları da naming ile çözülebilir.
      const base = testAffinityBase(path);
      if (base !== null) {
        const bases = testBaseToPath.get(base);
        if (bases === undefined) testBaseToPath.set(base, [path]);
        else if (!bases.includes(path)) bases.push(path);
      }
    }
  }
  for (const list of testBaseToPath.values()) list.sort(cmp);
  for (const list of testNodeByPath.values()) {
    list.sort((a, b) => cmp(a.qualifiedName, b.qualifiedName));
  }

  // Taban → üreten değişen node'lar (sembol adı segmenti + dosya adı tabanı).
  const baseOrigins = new Map<string, Set<string>>();
  const addOrigin = (base: string, nodeId: string): void => {
    const set = baseOrigins.get(base);
    if (set === undefined) baseOrigins.set(base, new Set([nodeId]));
    else set.add(nodeId);
  };
  for (const symbol of identifiedSymbols) {
    addOrigin(lastSegment(symbol.qualifiedName), symbol.nodeId);
  }
  for (const node of matchedFileNodes) {
    addOrigin(changedFileBase(filePathOf(node)), node.id);
  }

  for (const base of [...baseOrigins.keys()].sort(cmp)) {
    const originIds = baseOrigins.get(base) ?? new Set<string>();
    const paths = testBaseToPath.get(base) ?? [];
    for (const path of paths) {
      const testNodes = testNodeByPath.get(path) ?? [];
      const fileNode = fileNodeByPath.get(path);
      const targets: GraphNode[] =
        testNodes.length > 0 ? testNodes : fileNode === undefined ? [] : [fileNode];
      for (const target of targets) {
        for (const originId of [...originIds].sort(cmp)) {
          const originNode = nodeById.get(originId);
          if (originNode === undefined) continue;
          if (target.id === originId) continue; // kendine isim bağlamı adayı yok
          rawSignals.push({
            testNodeId: target.id,
            testQualifiedName: target.qualifiedName,
            testKind: target.kind,
            changedNodeId: originId,
            matchLevel: "naming",
            strength: MATCH_LEVEL_STRENGTH.naming,
            resolution: "heuristic",
            depth: 0,
            reason: `naming: "${path}" yolu, değişen "${base}" adıyla test-dosyası isimlendirme kalıbında eşleşti (heuristic — düşük güven; dosya adı benzerliği tek başına kanıt değildir)`,
            edgeRefs: [],
            evidenceIds: [],
          });
        }
      }
    }
  }

  // 11) Birleşme: (changedNodeId, testNodeId) başına tek aday; en güçlü
  //     sinyal kazanır, evidence birleşimi tüm sinyallerden toplanır.
  const grouped = new Map<string, RawSignal[]>();
  for (const signal of rawSignals) {
    const key = `${signal.changedNodeId}\u0000${signal.testNodeId}`;
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [signal]);
    else list.push(signal);
  }

  const merged: TestPlanCandidate[] = [];
  for (const signals of grouped.values()) {
    const sorted = [...signals].sort((a, b) => {
      if (a.strength !== b.strength) return b.strength - a.strength;
      if (a.depth !== b.depth) return a.depth - b.depth;
      const aEdge = a.edgeRefs[0]?.edgeId ?? "";
      const bEdge = b.edgeRefs[0]?.edgeId ?? "";
      const edgeGap = cmp(aEdge, bEdge);
      if (edgeGap !== 0) return edgeGap;
      return cmp(a.reason, b.reason);
    });
    const strongest = sorted[0];
    if (strongest === undefined) continue;
    const evidence = new Set<string>();
    for (const signal of sorted) {
      for (const id of signal.evidenceIds) evidence.add(id);
    }
    const changedNode = nodeById.get(strongest.changedNodeId);
    if (changedNode === undefined) continue; // savunma
    merged.push({
      candidateId: "", // kanonik sıralamadan SONRA atanır (adım 12)
      testNodeId: strongest.testNodeId,
      testQualifiedName: strongest.testQualifiedName,
      testKind: strongest.testKind,
      changedNodeId: strongest.changedNodeId,
      changedQualifiedName: changedNode.qualifiedName,
      matchLevel: strongest.matchLevel,
      resolution: strongest.resolution,
      depth: strongest.depth,
      reason: strongest.reason,
      evidenceIds: [...evidence].sort(cmp),
      edges: strongest.edgeRefs,
    });
  }

  // 12) Kanonik aday sırası + kimlik ataması; maxCandidates bütçesi.
  merged.sort((a, b) => {
    const changedGap = cmp(a.changedNodeId, b.changedNodeId);
    if (changedGap !== 0) return changedGap;
    const strengthGap =
      MATCH_LEVEL_STRENGTH[b.matchLevel] - MATCH_LEVEL_STRENGTH[a.matchLevel];
    if (strengthGap !== 0) return strengthGap;
    const testGap = cmp(a.testNodeId, b.testNodeId);
    if (testGap !== 0) return testGap;
    return cmp(a.candidateId, b.candidateId);
  });
  let candidates = merged;
  if (merged.length > limits.maxCandidates) {
    candidates = merged.slice(0, limits.maxCandidates);
    truncatedBy.add("maxCandidates");
  }
  candidates = candidates.map((candidate, index) => ({
    ...candidate,
    candidateId: `testplan:${String(index + 1).padStart(4, "0")}`,
  }));

  // 13) missingCoverageCandidates: hiç incoming TESTS kenarı bilmeyen
  //     değişen semboller (coverage gap ADAYI — varlık/yokluk kanıtı yok).
  const missingCoverageCandidates: TestPlanMissingCoverageCandidate[] = [];
  for (const symbol of identifiedSymbols) {
    if ((incomingTests.get(symbol.nodeId) ?? []).length > 0) continue;
    missingCoverageCandidates.push({
      nodeId: symbol.nodeId,
      kind: symbol.kind,
      qualifiedName: symbol.qualifiedName,
      reason: `missing-coverage: değişen "${symbol.qualifiedName}" sembolüne işaret eden TESTS kenarı yok — coverage gap adayı (bu bir adaylıktır; test varlığı/yokluğu doğrulanmamıştır)`,
    });
  }
  missingCoverageCandidates.sort((a, b) => {
    const nameGap = cmp(a.qualifiedName, b.qualifiedName);
    return nameGap !== 0 ? nameGap : cmp(a.nodeId, b.nodeId);
  });

  // 14) Gerekçeler: sinyalsiz eşleşen dosyalar + boş plan notu.
  const candidateChangedIds = new Set(candidates.map((c) => c.changedNodeId));
  for (const node of matchedFileNodes) {
    if (!candidateChangedIds.has(node.id)) {
      rationales.push(
        `değişen dosya sinyalsiz: "${filePathOf(node)}" File node'u eşleşti; TESTS/naming/CALLS sinyali üretmedi`,
      );
    }
  }
  if (candidates.length === 0) {
    rationales.push(
      "test planı boş: değişiklik kümesinden yapısal sinyalle türetilecek test adayı yok (bu bir adaylık boşluğudur; çalıştırma kararı kullanıcı/host akışına aittir)",
    );
  }

  // 15) Özet + kesme raporu (sabit kanonik sıra — TŞ §20 örüntüsü).
  const summary: TestPlanSummary = {
    direct: candidates.filter((c) => c.matchLevel === "direct").length,
    naming: candidates.filter((c) => c.matchLevel === "naming").length,
    callSite: candidates.filter((c) => c.matchLevel === "call-site").length,
    totalCandidates: candidates.length,
    missingCoverageCandidates: missingCoverageCandidates.length,
  };
  const truncatedByOrder: TestPlanTruncatedBy[] = ["maxCandidates", "maxDepth"];
  const truncatedByList = truncatedByOrder.filter((reason) => truncatedBy.has(reason));
  const uniqueRationales = [...new Set(rationales)].sort(cmp);

  return {
    snapshotId: snapshot.meta.id,
    identifiedSymbols,
    unresolvedSymbols,
    candidates,
    missingCoverageCandidates,
    summary,
    truncated: truncatedByList.length > 0,
    truncatedBy: truncatedByList,
    limits,
    rationales: uniqueRationales,
  };
}
