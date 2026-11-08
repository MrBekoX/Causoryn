import {
  canonicalJson,
  sha256Hex,
  utf8Encode,
  type GraphNode,
  type JsonValue,
  type NodeKind,
  type SnapshotGraph,
} from "@causoryn/domain";
import { analyzeImpact, type ImpactAffectedNode } from "@causoryn/graph";

import { PreflightError } from "./errors.js";

/**
 * causoryn_preflight_change manifest çekirdeği — sprint-5 D4.
 *
 * Sözleşme (TŞ v2.1, pdftotext çıkarımı):
 * - §10.2 (Sayfa 10): girdi "intent, targetSymbols/files?, baseSnapshot?",
 *   çıktı "Preflight Manifest ve risk adayı".
 * - §10.3 (Sayfa 10-11): manifest gövdesi preflightId, baseSnapshotId,
 *   intentLabel, identifiedTargets, impactCandidates
 *   (id/pathEvidenceIds/certainty), contractChecks (contractId/status),
 *   testPlanId, limitations, sourceRevision (kind/head/dirty); "Preflight
 *   sadece olası etkiyi değerlendirir; kodu kendisi değiştirmez. Eğer hedef
 *   sadece doğal dilde verilmiş ve sembollere kesin bağlanamamışsa
 *   candidateTargets ve requiresDisambiguation sunar, yapay zekâ mantığıyla
 *   otomatik kesinleştirme yapmaz."
 * - §12 (Sayfa 4, özellik 12): "Kod değiştirilmeden önce etki/risk adayları,
 *   gerekli sözleşmeler, test planı ve baseline snapshot içeren Preflight
 *   Manifest."
 *
 * BİRLEŞTİRME KATMANI SÖZLEŞMESİ (sprint-5.md D4): bu çekirdek KOD YAZMAZ;
 * yalnızca aday manifest üretir (test manifest.test.ts, "candidate-only"
 * bloğu, üretime rağmen çalışma ağacının bit-bit aynı olduğunu kanıtlar).
 * Bileşenler:
 * - impactCandidates: packages/graph `analyzeImpact` çağrısıyla türetilir
 *   (modül yeniden YAZILMAZ; ters BFS + certainty/resolution ayrımı
 *   impact.ts sözleşmesinden gelir). impactLimits doğrulanması da impact
 *   katmanına aittir: geçersiz limit orada graph/impact-invalid-input ile
 *   reddedilir (MCP yüzeyinde INVALID_ARGUMENT'a eşlenir — K-008).
 * - contractChecks: D2/D3 (packages/contracts checkContractCompatibility /
 *   detectContractDrift) çıktısındaki sözleşme kimliği + sınıflama
 *   kayıtlarıdır; çekirdek bunları TŞ §10.3 status sözlüğüne deterministik
 *   eşler: breaking_candidate|risk → "at_risk", backward-safe →
 *   "backward_safe", unknown → "unknown". Kaynak sınıflama ayrıca korunur
 *   (iki alan ayrıdır; uydurma sınıflama yok). Sınıflama birlik kümesi,
 *   packages/contracts compatibility.ts ContractCompatibilityClassification
 *   ile aynıdır (paketler arası tip bağımlılığı kurulmadan yapısal eşleşme).
 * - testPlanId: D6 (deriveTestPlan) çıktısına REFERANSDIR; çekirdek test
 *   planı türetmez, kimliği aynen taşır.
 * - sourceRevision: git-read salt-okunur HEAD kaydı
 *   (bkz. source-revision.ts resolveSourceRevision); çekirdek doğrular ve
 *   aynen taşır. Verilmezse manifest limitation ile üretilir (git'siz
 *   workspace hayatta kalır — dürüst eksiklik raporu).
 * - Belirsiz hedef: analyzeImpact'un unresolvedTargets'ı üzerine deterministik
 *   aday araması yapılır (exact-name → suffix-segment; capped). Adaylar
 *   ADAYLIKTIR: identifiedTargets'a yazılmaz, otomatik kesinleştirme YOKTUR
 *   (TŞ §10.3). Hiç adayı bulunamayan hedef requiresDisambiguation=true +
 *   boş aday listesi + limitation ile raporlanır.
 *
 * Dosya yetkilendirmesi: hedef dosyalar authorizeFile kararı olmadan
 * KULLANILAMAZ (fail-closed; WorkspaceAccessPolicy.checkFile kararının
 * enjeksiyonu mcp-server/workspace katmanındadır). Red kararı →
 * preflight/file-not-authorized (yetki reddi; sessiz düşürme yok).
 *
 * SAF ÇEKİRDEK: fs/thread/saat/rastgele okumaz; MCP türlerini import etmez;
 * girdileri mutasyona uğratmaz. Tüm çıktı dizileri kanonik sıralı → aynı
 * girdi iki koşumda bit-bit aynı JSON'u üretir; girdi dizi sırası çıktıyı
 * değiştirmez (TŞ §8 invariant vi). preflightId, manifest gövdesinin
 * canonical JSON SHA-256 karmasıdır (domain ids.ts örüntüsü).
 */

/** TŞ §20 resource budget örüntüsü: aday liste tavanı. */
export const PREFLIGHT_MANIFEST_LIMITS = {
  maxDisambiguationCandidates: 50,
} as const;

/** İstek yapılmadığında uygulanan varsayılanlar. */
export const PREFLIGHT_MANIFEST_DEFAULTS = {
  maxDisambiguationCandidates: 10,
} as const;

/** Kaynak revizyon kaydı (TŞ §10.3 sourceRevision gövdesi). */
export interface PreflightSourceRevision {
  /** Yalnızca working-tree kind'ı bu çekirdekte anlamlıdır (TŞ örneği). */
  readonly kind: "working-tree";
  /** Git commit SHA'sı (4-64 hex; resolveSourceRevision üretir). */
  readonly head: string;
  /** Çalışma ağacı kirli mi (git status); belirlenemiyorsa yok. */
  readonly dirty?: boolean;
}

/** D2/D3 sınıflama sözlüğü (packages/contracts compatibility.ts ile aynı). */
export type PreflightContractClassification =
  | "backward-safe"
  | "risk"
  | "breaking_candidate"
  | "unknown";

/** TŞ §10.3 contractChecks.status sözlüğü (deterministik eşleme aşağıda). */
export type PreflightContractStatus = "at_risk" | "backward_safe" | "unknown";

/** D2/D3'ten gelen tek sözleşme denetim kaydı (çağrı katmanı eşler). */
export interface PreflightContractCheckInput {
  readonly contractId: string;
  readonly classification: PreflightContractClassification;
  readonly summary?: string;
}

/** Manifest'teki sözleşme denetimi: TŞ status + kaynak sınıflama birlikte. */
export interface PreflightContractCheck {
  readonly contractId: string;
  readonly status: PreflightContractStatus;
  readonly classification: PreflightContractClassification;
  readonly summary?: string;
}

/**
 * Yetkilendirme kararı (WorkspaceAccessPolicy.checkFile kararının yapısal
 * kopyası). allowed=false ise code/reason yetki reddi mesajına taşınır.
 */
export interface FileAuthorizationDecision {
  readonly allowed: boolean;
  /** Reddin politika kodu (ör. workspace/path-denied). */
  readonly code?: string;
  /** Reddin insan-okur gerekçesi. */
  readonly reason?: string;
  /** İzinli durumda kanonik kök-göreceli yol (politika döner). */
  readonly relativePath?: string;
}

/** Deterministik dosya yetkilendirme işlevi (saf; girdi dosya adı). */
export type FileAuthorizer = (file: string) => FileAuthorizationDecision;

/** analyzeImpact passthrough sınırları (tavanlar impact.ts'tedir). */
export interface PreflightImpactLimits {
  readonly maxDepth?: number;
  readonly maxPaths?: number;
  readonly maxNodes?: number;
}

/** buildPreflightManifest girdisi (TŞ §10.2 + birleştirme referansları). */
export interface PreflightManifestInput {
  /** Değişiklik niyeti (metin; boş/blank reddedilir). */
  readonly intent: string;
  /** Sembol hedefleri: node kimliği veya TAM qualifiedName. */
  readonly targetSymbols?: readonly string[];
  /** Dosya hedefleri: kök-göreceli yol; authorizeFile kararı zorunludur. */
  readonly targetFiles?: readonly string[];
  /** Sözleşme denetimlerinin manifest'e katılması (varsayılan: katılır). */
  readonly includeContracts?: boolean;
  /** Test planı referansının manifest'e katılması (varsayılan: katılır). */
  readonly includeTestPlan?: boolean;
  /** D2/D3 sözleşme değerlendirme kayıtları. */
  readonly contractChecks?: readonly PreflightContractCheckInput[];
  /** D6 deriveTestPlan çıktısı referansı. */
  readonly testPlanId?: string;
  /** Host katmanı katkı notları (limitations'a birleşir). */
  readonly limitations?: readonly string[];
  /** git-read salt-okunur HEAD kaydı (resolveSourceRevision çıktısı). */
  readonly sourceRevision?: PreflightSourceRevision;
  /** analyzeImpact passthrough sınırları. */
  readonly impactLimits?: PreflightImpactLimits;
  /** Hedef başına belirsizlik aday listesi sınırı. */
  readonly maxDisambiguationCandidates?: number;
  /** Dosya yetkilendirme kararı; targetFiles boş değilse ZORUNLU. */
  readonly authorizeFile?: FileAuthorizer;
}

/** TŞ §10.3 impactCandidates örneğinin (id/pathEvidenceIds/certainty) zengin karşılığı. */
export interface PreflightImpactCandidate {
  readonly id: string;
  readonly kind: NodeKind;
  readonly qualifiedName: string;
  /** Yapısal sınıflama: direct | indirect | possible (TŞ §13; %100 iddiası yok). */
  readonly certainty: "direct" | "indirect" | "possible";
  /** Güven ekseninde ayrı alan: verified | heuristic | unresolved. */
  readonly resolution: "verified" | "heuristic" | "unresolved";
  readonly minDepth: number;
  readonly pathCount: number;
  /** Temsilî yolun kanıtları (TŞ §10.3 pathEvidenceIds). */
  readonly pathEvidenceIds: readonly string[];
  readonly targetNodeIds: readonly string[];
}

/** Çözümlenmiş hedef; origin sembol mü dosya mı olduğunu ayırt eder. */
export interface PreflightIdentifiedTarget {
  readonly nodeId: string;
  readonly kind: NodeKind;
  readonly qualifiedName: string;
  readonly origin: "symbol" | "file";
}

/** Belirsizlik adayı: ADAYLIK — çözümleme değildir (TŞ §10.3). */
export interface PreflightDisambiguationCandidate {
  readonly nodeId: string;
  readonly kind: NodeKind;
  readonly qualifiedName: string;
  /** exact-name: tam qualifiedName eşleşmesi; suffix-segment: ".<hedef>" sonu. */
  readonly matchBasis: "exact-name" | "suffix-segment";
}

/** Bir hedefin belirsizlik kaydı + aday listesi. */
export interface PreflightDisambiguationEntry {
  readonly target: string;
  readonly reason: string;
  readonly candidates: readonly PreflightDisambiguationCandidate[];
}

/**
 * Preflight Manifest — yalnızca ADAY (candidateOnly sabit true). Bu değer
 * üretilirken hiçbir dosya yazılmaz, hiçbir komut çalıştırılmaz (TŞ §10.3;
 * ADR-007 preflight/verify ayrımı, ADR-008 salt-okunur workspace).
 */
export interface PreflightManifest {
  /** Gövde karması: preflight:<sha256-hex-64> (canonical JSON, deterministik). */
  readonly preflightId: string;
  readonly baseSnapshotId: string;
  /** Intent'in kanonik beyaz-boşluk normalizasyonu; anlamsal işleme yok. */
  readonly intentLabel: string;
  /** Sabit: bu kayıt yalnızca adaydır; yazma eylemi içeremez. */
  readonly candidateOnly: true;
  readonly identifiedTargets: readonly PreflightIdentifiedTarget[];
  readonly impactCandidates: readonly PreflightImpactCandidate[];
  readonly contractChecks: readonly PreflightContractCheck[];
  readonly testPlanId: string | undefined;
  readonly requiresDisambiguation: boolean;
  readonly candidateTargets: readonly PreflightDisambiguationEntry[];
  readonly limitations: readonly string[];
  readonly sourceRevision: PreflightSourceRevision | undefined;
}

const CLASSIFICATION_SET: ReadonlySet<string> = new Set([
  "backward-safe",
  "risk",
  "breaking_candidate",
  "unknown",
]);

/** TŞ §10.3 status eşlemesi (deterministik; kaynak sınıflama korunur). */
function statusOf(
  classification: PreflightContractClassification,
): PreflightContractStatus {
  switch (classification) {
    case "backward-safe":
      return "backward_safe";
    case "unknown":
      return "unknown";
    case "risk":
    case "breaking_candidate":
      return "at_risk";
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function requireNonBlankString(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PreflightError(
      "preflight/invalid-input",
      `${field} boş/blank olamaz: ${String(value)}`,
    );
  }
  return value;
}

function requireLimit(
  name: string,
  requested: number | undefined,
  ceiling: number,
  limitations: string[],
): number {
  if (requested === undefined) return ceiling;
  if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) {
    throw new PreflightError(
      "preflight/invalid-input",
      `${name} pozitif tam sayı olmalı: ${String(requested)}`,
    );
  }
  if (requested > ceiling) {
    limitations.push(
      `${name}=${String(requested)} istenen değeri tavana (${String(ceiling)}) indirildi (TŞ §20 resource budget)`,
    );
    return ceiling;
  }
  return requested;
}

/** File node'unun yol karşılığı (test-plan.ts filePathOf konvansiyonu). */
function filePathOf(node: GraphNode): string {
  return node.qualifiedName.includes("/")
    ? node.qualifiedName
    : (node.location?.relativePath ?? node.qualifiedName);
}

/**
 * Belirsiz hedef için deterministik aday araması: önce tam qualifiedName
 * eşleşmeleri (exact-name), hiç yoksa ".<hedef>" ile biten qualifiedName'ler
 * (suffix-segment). Sonuçlar ADAYDIR — çözümleme yapılmaz; liste tavana
 * kadar kırpılır ve kırpım limitation olarak raporlanır.
 */
function disambiguationCandidates(
  snapshot: SnapshotGraph,
  target: string,
  cap: number,
  limitations: string[],
): PreflightDisambiguationCandidate[] {
  const exact: PreflightDisambiguationCandidate[] = [];
  const suffix: PreflightDisambiguationCandidate[] = [];
  const suffixToken = `.${target}`;
  for (const node of snapshot.nodes) {
    const candidate: PreflightDisambiguationCandidate = {
      nodeId: node.id,
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      matchBasis: node.qualifiedName === target ? "exact-name" : "suffix-segment",
    };
    if (node.qualifiedName === target) exact.push(candidate);
    else if (node.qualifiedName.endsWith(suffixToken)) suffix.push(candidate);
  }
  const byName = (a: PreflightDisambiguationCandidate, b: PreflightDisambiguationCandidate): number => {
    const nameGap = cmp(a.qualifiedName, b.qualifiedName);
    return nameGap !== 0 ? nameGap : cmp(a.nodeId, b.nodeId);
  };
  exact.sort(byName);
  suffix.sort(byName);
  const chosen = exact.length > 0 ? exact : suffix;
  if (chosen.length > cap) {
    limitations.push(
      `aday listesi kırpıldı: "${target}" eşleşmesi ${String(chosen.length)} node buldu, tavan ${String(cap)}`,
    );
    return chosen.slice(0, cap);
  }
  return chosen;
}

function toImpactCandidate(affected: ImpactAffectedNode): PreflightImpactCandidate {
  return {
    id: affected.nodeId,
    kind: affected.kind,
    qualifiedName: affected.qualifiedName,
    certainty: affected.certainty,
    resolution: affected.resolution,
    minDepth: affected.minDepth,
    pathCount: affected.pathCount,
    pathEvidenceIds: affected.pathEvidenceIds,
    targetNodeIds: affected.targetNodeIds,
  };
}

/* ------------------------------------------------------------------ */
/* Kimlik gövdesi: canonical JSON için explicit JsonValue kurucuları   */
/* (domain snapshot.ts metaJsonValue örüntüsü; tip güvenli, cast yok). */
/* ------------------------------------------------------------------ */

function targetJsonValue(target: PreflightIdentifiedTarget): JsonValue {
  return {
    nodeId: target.nodeId,
    kind: target.kind,
    qualifiedName: target.qualifiedName,
    origin: target.origin,
  };
}

function candidateJsonValue(candidate: PreflightImpactCandidate): JsonValue {
  return {
    id: candidate.id,
    kind: candidate.kind,
    qualifiedName: candidate.qualifiedName,
    certainty: candidate.certainty,
    resolution: candidate.resolution,
    minDepth: candidate.minDepth,
    pathCount: candidate.pathCount,
    pathEvidenceIds: [...candidate.pathEvidenceIds],
    targetNodeIds: [...candidate.targetNodeIds],
  };
}

function contractCheckJsonValue(check: PreflightContractCheck): JsonValue {
  return {
    contractId: check.contractId,
    status: check.status,
    classification: check.classification,
    ...(check.summary === undefined ? {} : { summary: check.summary }),
  };
}

function disambiguationCandidateJsonValue(
  candidate: PreflightDisambiguationCandidate,
): JsonValue {
  return {
    nodeId: candidate.nodeId,
    kind: candidate.kind,
    qualifiedName: candidate.qualifiedName,
    matchBasis: candidate.matchBasis,
  };
}

function disambiguationEntryJsonValue(entry: PreflightDisambiguationEntry): JsonValue {
  return {
    target: entry.target,
    reason: entry.reason,
    candidates: entry.candidates.map(disambiguationCandidateJsonValue),
  };
}

function sourceRevisionJsonValue(revision: PreflightSourceRevision): JsonValue {
  return {
    kind: revision.kind,
    head: revision.head,
    ...(revision.dirty === undefined ? {} : { dirty: revision.dirty }),
  };
}

/** preflightId karmasına giren gövde (kimlik alanı hariç tüm manifest). */
function manifestBodyJsonValue(manifest: PreflightManifest): JsonValue {
  return {
    baseSnapshotId: manifest.baseSnapshotId,
    intentLabel: manifest.intentLabel,
    identifiedTargets: manifest.identifiedTargets.map(targetJsonValue),
    impactCandidates: manifest.impactCandidates.map(candidateJsonValue),
    contractChecks: manifest.contractChecks.map(contractCheckJsonValue),
    testPlanId: manifest.testPlanId ?? null,
    requiresDisambiguation: manifest.requiresDisambiguation,
    candidateTargets: manifest.candidateTargets.map(disambiguationEntryJsonValue),
    limitations: [...manifest.limitations],
    sourceRevision:
      manifest.sourceRevision === undefined
        ? null
        : sourceRevisionJsonValue(manifest.sourceRevision),
  };
}

/**
 * Preflight manifestini üretir: intent + hedef kümesi → analyzeImpact
 * (packages/graph) + sözleşme denetimi eşlemesi + test planı referansı +
 * sourceRevision → kanonik, deterministik ADAY manifest. Kod yazmaz; yalnızca
 * aday üretir (candidateOnly=true).
 */
export function buildPreflightManifest(
  snapshot: SnapshotGraph,
  input: PreflightManifestInput,
): PreflightManifest {
  // 1) Snapshot durumu: yalnızca ready/partial (impact.ts ile aynı kural;
  //    hata kodu paket sınırında preflight/... önekli olur).
  const state = snapshot.meta?.state;
  if (state !== "ready" && state !== "partial") {
    throw new PreflightError(
      "preflight/snapshot-state",
      `preflight manifest yalnızca ready/partial snapshot üzerinde üretilir; snapshot durumu: ${String(state)}`,
    );
  }

  // 2) Intent: boş/blank reddedilir; intentLabel kanonik beyaz-boşluk
  //    normalizasyonudur (anlamsal işleme/LLM yok — uydurma etiket yok).
  const intent = requireNonBlankString("intent", input.intent);
  const intentLabel = intent.trim().replace(/\s+/g, " ");

  // 3) Hedef kümesi: en az bir üye; tekilleştirme kanonik sırada (girdi
  //    sırası çıktıyı değiştirmemeli).
  const rawSymbols = input.targetSymbols ?? [];
  const rawFiles = input.targetFiles ?? [];
  if (rawSymbols.length === 0 && rawFiles.length === 0) {
    throw new PreflightError(
      "preflight/invalid-input",
      "targetSymbols/targetFiles kümesi boş olamaz: en az bir sembol veya dosya hedefi gerekli",
    );
  }
  for (const target of rawSymbols) {
    requireNonBlankString("targetSymbols üyesi", target);
  }
  for (const file of rawFiles) {
    requireNonBlankString("targetFiles üyesi", file);
  }
  const uniqueSymbols = [...new Set(rawSymbols)].sort(cmp);
  const uniqueFiles = [...new Set(rawFiles)].sort(cmp);

  // 4) Dosya yetkilendirmesi: fail-closed — targetFiles boş değilse
  //    authorizeFile zorunlu; red kararı yetki reddidir (sessiz düşürme yok).
  const limitations: string[] = [];
  const authorizedPaths: string[] = [];
  if (uniqueFiles.length > 0) {
    if (input.authorizeFile === undefined) {
      throw new PreflightError(
        "preflight/invalid-input",
        "targetFiles istendi ama authorizeFile sağlanmadı: hedef dosyalar yetkilendirme kararı olmadan kullanılamaz (fail-closed)",
      );
    }
    for (const file of uniqueFiles) {
      const decision = input.authorizeFile(file);
      if (!decision.allowed) {
        throw new PreflightError(
          "preflight/file-not-authorized",
          `hedef dosya yetkilendirilmedi: ${file}` +
            ` (${decision.code ?? "workspace/path-denied"})` +
            `${decision.reason === undefined ? "" : ` — ${decision.reason}`}`,
        );
      }
      authorizedPaths.push(decision.relativePath ?? file);
    }
    authorizedPaths.sort(cmp);
  }

  // 5) Sınır: belirsizlik aday tavanı (istek aşarsa kırpılır + limitation).
  const maxDisambiguationCandidates = requireLimit(
    "maxDisambiguationCandidates",
    input.maxDisambiguationCandidates,
    PREFLIGHT_MANIFEST_LIMITS.maxDisambiguationCandidates,
    limitations,
  );

  // 6) Dosya hedefleri → File node eşleşmesi (yetkilendirilmiş kanonik yol
  //    ile; birden fazla eşleşmede savunmada id sırasının ilki).
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
  for (const authorized of authorizedPaths) {
    const node = fileNodeByPath.get(authorized);
    if (node === undefined) {
      limitations.push(
        `değişen dosya snapshot'ta yok: "${authorized}" — File node eşleşmedi; aday üretilemez (uydurma yok)`,
      );
    } else {
      matchedFileNodes.push(node);
    }
  }
  matchedFileNodes.sort((a, b) => cmp(a.id, b.id));

  // 7) Etki analizi: packages/graph analyzeImpact YENİDEN KULLANILIR
  //    (ters BFS + certainty/resolution ayrımı impact.ts sözleşmesidir).
  //    Hedefler: sembol dizgileri (impact kendi çözümler) + eşleşen dosya
  //    node kimlikleri (dosya "çağrılabilir" değildir ama ters kenarla
  //    etki kökü olabilir).
  const impact = analyzeImpact(snapshot, {
    targets: [...uniqueSymbols, ...matchedFileNodes.map((node) => node.id)],
    ...(input.impactLimits?.maxDepth === undefined
      ? {}
      : { maxDepth: input.impactLimits.maxDepth }),
    ...(input.impactLimits?.maxPaths === undefined
      ? {}
      : { maxPaths: input.impactLimits.maxPaths }),
    ...(input.impactLimits?.maxNodes === undefined
      ? {}
      : { maxNodes: input.impactLimits.maxNodes }),
  });

  // 8) identifiedTargets: sembol kökleri (origin=symbol) + dosya kökleri
  //    (origin=file); kanonik (qualifiedName, nodeId) sırası. Etki kökü
  //    olarak analyzeImpact'a verilen dosya node'ları impact.targets'ta da
  //    görünür: aynı nodeId tek kayıtta birleşir ve dosya kökeni KAZANIR
  //    (daha özgün çözümleme).
  const matchedFileIds = new Set(matchedFileNodes.map((node) => node.id));
  const identifiedTargets: PreflightIdentifiedTarget[] = [
    ...impact.targets.map((target) => ({
      nodeId: target.nodeId,
      kind: target.kind,
      qualifiedName: target.qualifiedName,
      origin: matchedFileIds.has(target.nodeId)
        ? ("file" as const)
        : ("symbol" as const),
    })),
    ...matchedFileNodes
      .filter((node) => !impact.targets.some((target) => target.nodeId === node.id))
      .map((node) => ({
        nodeId: node.id,
        kind: node.kind,
        qualifiedName: filePathOf(node),
        origin: "file" as const,
      })),
  ].sort((a, b) => {
    const nameGap = cmp(a.qualifiedName, b.qualifiedName);
    return nameGap !== 0 ? nameGap : cmp(a.nodeId, b.nodeId);
  });

  // 9) impactCandidates: analyzeImpact affectedNodes'un TŞ §10.3 alan
  //    adlarıyla (id/pathEvidenceIds/certainty) zengin kopyası; sıra
  //    impact.ts'in kanonik sırasıdır.
  const impactCandidates = impact.affectedNodes.map(toImpactCandidate);

  // 10) Belirsiz hedefler: unresolvedTargets üzerine ADAY araması; otomatik
  //     kesinleştirme YOK (TŞ §10.3). Etki analizi yalnızca dosya kökleri
  //     çözüldüğünden, buradaki hedefler sembol dizgileridir.
  const candidateTargets: PreflightDisambiguationEntry[] = [];
  for (const unresolved of impact.unresolvedTargets) {
    const candidates = disambiguationCandidates(
      snapshot,
      unresolved.target,
      maxDisambiguationCandidates,
      limitations,
    );
    candidateTargets.push({
      target: unresolved.target,
      reason: unresolved.reason,
      candidates,
    });
    if (candidates.length === 0) {
      limitations.push(
        `aday bulunamadı: "${unresolved.target}" sembole bağlanamadı; aday listesi boş — çözümleme otomatik yapılmaz (TŞ §10.3)`,
      );
    }
  }
  const requiresDisambiguation = candidateTargets.length > 0;

  // 11) contractChecks: D2/D3 kayıtları → TŞ §10.3 status eşlemesi. Kaynak
  //     sınıflama ayrıca taşınır (uydurma/yonlendirme yok). includeContracts
  //     açıkça false ise denetim bırakılır ve bu durum limitation olarak
  //     raporlanır.
  const contractChecks: PreflightContractCheck[] = [];
  if (input.includeContracts === false) {
    limitations.push(
      "sözleşme denetimi istenmedi (includeContracts=false); contractChecks boş bırakıldı",
    );
  } else {
    const seenChecks = new Set<string>();
    for (const check of input.contractChecks ?? []) {
      const contractId = requireNonBlankString("contractChecks.contractId", check.contractId);
      if (
        typeof check.classification !== "string" ||
        !CLASSIFICATION_SET.has(check.classification)
      ) {
        throw new PreflightError(
          "preflight/invalid-input",
          `contractChecks.classification geçersiz (${contractId}): ${String(check.classification)}; beklenen değerler: backward-safe|risk|breaking_candidate|unknown`,
        );
      }
      const classification = check.classification as PreflightContractClassification;
      if (typeof check.summary !== "undefined") {
        requireNonBlankString(`contractChecks.summary (${contractId})`, check.summary);
      }
      const mapped: PreflightContractCheck = {
        contractId,
        status: statusOf(classification),
        classification,
        ...(check.summary === undefined ? {} : { summary: check.summary }),
      };
      const dedupeKey = canonicalJson([
        mapped.contractId,
        mapped.classification,
        mapped.summary ?? null,
      ]);
      if (!seenChecks.has(dedupeKey)) {
        seenChecks.add(dedupeKey);
        contractChecks.push(mapped);
      }
    }
    contractChecks.sort((a, b) => {
      const idGap = cmp(a.contractId, b.contractId);
      if (idGap !== 0) return idGap;
      const classGap = cmp(a.classification, b.classification);
      if (classGap !== 0) return classGap;
      // Tam eşitlik kırılımı: summary'si farklı iki kayıt (dedupe anahtarı
      // summary'yi kapsadığından bu noktada eşit çift yalnızca farklı
      // summary'den gelir) stable-sort tie'ında girdi sırasını KORUYAMAZ —
      // toplam sıra garantisi TŞ §8 invariant vi'nin gereğidir (girdi dizi
      // sırası çıktıyı değiştirmemeli; preflightId de onunla değişmemeli).
      return cmp(a.summary ?? "", b.summary ?? "");
    });
  }

  // 12) testPlanId: D6 çıktısına referans — aynen taşınır; includeTestPlan
  //     false ise bırakılır (bırakım limitation ile raporlanır), true iken
  //     referans yoksa dürüst limitation düşer.
  let testPlanId: string | undefined;
  if (typeof input.testPlanId !== "undefined") {
    const requestedPlanId = requireNonBlankString("testPlanId", input.testPlanId);
    if (input.includeTestPlan === false) {
      limitations.push(
        "testPlanId verildi ama includeTestPlan=false; test planı referansı manifest'e katılmadı",
      );
    } else {
      testPlanId = requestedPlanId;
    }
  } else if (input.includeTestPlan === true) {
    limitations.push(
      "testPlanId verilmedi: includeTestPlan=true iken test planı referansı (D6 deriveTestPlan çıktısı) manifest'e bağlanmadı",
    );
  }

  // 13) sourceRevision: git-read kaydı doğrulanır ve aynen taşınır;
  //     verilmezse manifest limitation ile üretilir (git'siz workspace
  //     hayatta kalır).
  let sourceRevision: PreflightSourceRevision | undefined;
  if (typeof input.sourceRevision !== "undefined") {
    const revision = input.sourceRevision;
    if (revision.kind !== "working-tree") {
      throw new PreflightError(
        "preflight/invalid-input",
        `sourceRevision.kind yalnızca "working-tree" olabilir: ${String(revision.kind)}`,
      );
    }
    const head = requireNonBlankString("sourceRevision.head", revision.head);
    if (!/^[0-9a-fA-F]{4,64}$/.test(head)) {
      throw new PreflightError(
        "preflight/invalid-input",
        `sourceRevision.head git commit SHA'sı olmalı (4-64 hex): ${head}`,
      );
    }
    if (typeof revision.dirty !== "undefined" && typeof revision.dirty !== "boolean") {
      throw new PreflightError(
        "preflight/invalid-input",
        `sourceRevision.dirty boolean olmalı: ${String(revision.dirty)}`,
      );
    }
    sourceRevision = {
      kind: "working-tree",
      head: head.toLowerCase(),
      ...(revision.dirty === undefined ? {} : { dirty: revision.dirty }),
    };
  } else {
    limitations.push(
      "sourceRevision verilmedi: git-read salt-okunur HEAD çözümlemesi bu manifest'e bağlanmadı",
    );
  }

  // 14) limitations: host katkısı + çekirdek notları + impact rationale'leri;
  //     tekrarsız, kanonik sırada (determinizm).
  for (const note of input.limitations ?? []) {
    limitations.push(requireNonBlankString("limitations üyesi", note));
  }
  limitations.push(...impact.rationales);
  const uniqueLimitations = [...new Set(limitations)].sort(cmp);

  // 15) Manifest gövdesi + preflightId (canonical JSON SHA-256; domain
  //     deterministicId örüntüsü). Gövde, kimlik HARİÇ tüm alanları kapsar:
  //     aynı bağlam → aynı kimlik; herhangi bir alan değişir → kimlik değişir.
  const manifest: PreflightManifest = {
    preflightId: "",
    baseSnapshotId: snapshot.meta.id,
    intentLabel,
    candidateOnly: true,
    identifiedTargets,
    impactCandidates,
    contractChecks,
    testPlanId,
    requiresDisambiguation,
    candidateTargets,
    limitations: uniqueLimitations,
    sourceRevision,
  };
  const contentHash = sha256Hex(
    utf8Encode(canonicalJson(manifestBodyJsonValue(manifest))),
  );
  return { ...manifest, preflightId: `preflight:${contentHash}` };
}
