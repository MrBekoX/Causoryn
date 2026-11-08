import { ContractDiscoveryError } from "./errors.js";
import {
  checkContractCompatibility,
  type ContractChangeKind,
  type ContractCompatibilityClassification,
  type ContractCompatibilityFinding,
  type ContractCompatibilityReport,
  type ContractPairEvaluation,
} from "./compatibility.js";
import { compareEdges, compareStrings } from "./order.js";
import { isPlainObject } from "./parse-safety.js";
import type {
  ContractEdgeCandidate,
  ContractEvidenceSpan,
  DiscoveryOutput,
} from "./types.js";

/**
 * Contract drift çekirdeği — TŞ v2.1 §11 drift algoritmasının (4)-(6)
 * adımları ve sprint-5 D3 (`causoryn_detect_contract_drift` aracının saf
 * çekirdeği; MCP yüzeyi ayrı dilimdir).
 *
 * TŞ §11 (pdftotext s.11 doğrulaması): "(4) compatibility rules;
 * (5) PRODUCES_CONTRACT/CONSUMES_CONTRACT üzerinden etki grafini bala;
 * (6) findings + evidence + unresolved consumers ... üret." ve "DB kolon
 * kaldırma → tüketiciler için aday etki".
 *
 * GİRDİ SÖZLEŞMESİ: iki sürümün keşif çıktıları (base/target
 * DiscoveryOutput) + her sürüme ait produces/consumes kenar adayları
 * (matchContractEdges çıktısı). Kenarlar D1 sözleşmesini taşır:
 * toContractId ilgili sürümün nodeId'idir (aynı sözleşmenin farklı sürüm
 * dosyaları ayrık kimlik alır — types.ts).
 *
 * ÇIKTI SÖZLEŞMESİ:
 * - contractChanges: K-013(7) wiki_diff gövdesinin ÜRETİCİSİDİR ve TAM
 *   üç alandır: {contractId, changeKind: added|removed|modified, summary}.
 *   contractId seçim kuralı (deterministik): target'ta varsa TARGET
 *   kimliği (added/modified); yoksa BASE kimliği (removed) — "değişiklik
 *   sonrasında geçerli kimlik" ilkesi.
 * - breakingCandidates / risks / unknowns: TŞ §11 sınıflamaları AYRI
 *   alanlarda; bir değişiklik aggregate sınıflamasına göre TAM BİR alana
 *   girer (karışmaz). Alanlar değişen (changeKind != unchanged) çiftleri
 *   taşır; her item kural adı + kanıtlı findings içerir.
 * - impactedEdges: etki grafı — değişen sözleşmeleri işaret eden kenarlar;
 *   KENARIN KENDİ evidence'ı ve çözünürlüğü (verified/heuristic) ASLA
 *   yükseltilmeden aynen taşınır; her kayıt hangi değişiklikten
 *   (matchKey) ve hangi sürüm tarafından (side: base|target) etkilendiğini
 *   söyler. backward-safe değişiklikler de kaydedilir (sınıflama alanında
 *   bulunur, filtreleme tüketicinin işidir).
 * - unconsumedChanges: tüketici kenarı (CONSUMES_CONTRACT) bulunamayan
 *   değişiklikler — TŞ §11'in "unresolved consumers" dürüstlük hükmü:
 *   etki değerlendirilemedi SESSİZE DÜŞÜRÜLMEZ, ayrı raporlanır.
 * - rationale: sayaç özeti + değişiklik-yok notu + unchanged çiftlerdeki
 *   değerlendirme notları (serializer-unknown vb.) + unconsumed/unattached
 *   açıklamaları. Boş drift durumunda bile gerekçe taşınır.
 *
 * SAF ÇEKİRDEK: fs/thread/saat/rastgele okumaz; girdileri mutasyona
 * uğratmaz; tüm sıralamalar kod noktası sırasındadır (TŞ §8 invariant vi:
 * aynı giriş → aynı çıktı JSON).
 */

/** K-013(7) wiki_diff contractChanges gövdesi — bu modül üreticidir. */
export interface ContractChangeRecord {
  readonly contractId: string;
  readonly changeKind: "added" | "removed" | "modified";
  readonly summary: string;
}

/** Sınıflama alanlarındaki tekil değişiklik (kural adı + kanıt birlikte). */
export interface ContractDriftItem {
  readonly matchKey: string;
  readonly contractId: string;
  readonly name: string;
  readonly changeKind: "added" | "removed" | "modified";
  readonly summary: string;
  readonly findings: readonly ContractCompatibilityFinding[];
}

/** Etki grafı kaydı: değişen sözleşmeyi işaret eden bir graph kenarı. */
export interface ContractEdgeImpact {
  /** Hangi değişiklik (ContractPairEvaluation.matchKey ile birleşir). */
  readonly matchKey: string;
  /** Kenarın hangi sürümden geldiği. */
  readonly side: "base" | "target";
  readonly changeKind: "added" | "removed" | "modified";
  /** Değişikliğin aggregate sınıflaması (alan ayrımı bozulmaz; etikettir). */
  readonly classification: ContractCompatibilityClassification;
  readonly edgeKind: ContractEdgeCandidate["edgeKind"];
  readonly fromSymbol: string;
  readonly toContractId: string;
  /** D1 çözünürlüğü ASLA yükseltilmez (verified/heuristic aynen). */
  readonly resolution: ContractEdgeCandidate["resolution"];
  readonly matchBasis: ContractEdgeCandidate["matchBasis"];
  /** Kenarın kendi kanıtı (TŞ §11: etki grafı kenar evidence'ıyla). */
  readonly evidence: readonly ContractEvidenceSpan[];
}

export interface ContractDriftResult {
  /** K-013(7) üretici kayıtları (deterministik sıralı). */
  readonly contractChanges: readonly ContractChangeRecord[];
  /** breaking_candidate sınıflı değişiklikler (ayrı alan). */
  readonly breakingCandidates: readonly ContractDriftItem[];
  /** risk sınıflı değişiklikler (ayrı alan). */
  readonly risks: readonly ContractDriftItem[];
  /** unknown sınıflı değişiklikler (ayrı alan). */
  readonly unknowns: readonly ContractDriftItem[];
  /** PRODUCES_CONTRACT/CONSUMES_CONTRACT etki grafı. */
  readonly impactedEdges: readonly ContractEdgeImpact[];
  /** Tüketici kenarı bulunamayan değişiklikler (unresolved consumers). */
  readonly unconsumedChanges: readonly ContractChangeRecord[];
  /** D2 raporundan geçen, hiçbir çifte bağlanamayan bulgular. */
  readonly unattachedFindings: readonly ContractCompatibilityFinding[];
  /**
   * D2 uyumluluk raporunun çift değerlendirmeleri (raporun kendisi sonuçta
   * ayrıca taşınmaz; scope daraltması gibi tüketenlerin İKİNCİ KEZ
   * checkContractCompatibility koşmasın diye yeniden kullanılır — denetim
   * bulgusu). Deterministik sıralı (matchKey).
   */
  readonly evaluations: readonly ContractPairEvaluation[];
  /** Sayaç özeti + dürüstlük notları (deterministik içerik). */
  readonly rationale: readonly string[];
}

export interface ContractDriftInput {
  readonly base: DiscoveryOutput;
  readonly target: DiscoveryOutput;
  readonly baseEdges: readonly ContractEdgeCandidate[];
  readonly targetEdges: readonly ContractEdgeCandidate[];
}

/* ------------------------------------------------------------------ */
/* Girdi doğrulama (açık reddi; uydurma yok)                           */
/* ------------------------------------------------------------------ */

function assertDiscoveryOutput(value: unknown, label: string): void {
  if (!isPlainObject(value) || !Array.isArray(value["contracts"]) || !Array.isArray(value["diagnostics"])) {
    throw new ContractDiscoveryError(
      "contracts/invalid-input",
      `${label} DiscoveryOutput doğrulanamadı (contracts/invalid-input): contracts ve diagnostics dizileri zorunludur`,
    );
  }
}

/** Kenar alanlarının kabul edilen değer kümeleri (types.ts sözleşmeleri). */
const EDGE_KINDS: ReadonlySet<string> = new Set(["PRODUCES_CONTRACT", "CONSUMES_CONTRACT"]);
const EDGE_RESOLUTIONS: ReadonlySet<string> = new Set(["verified", "heuristic"]);
const EDGE_MATCH_BASES: ReadonlySet<string> = new Set(["route", "topic-id", "name-exact", "name-similarity"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Kanıt span doğrulaması (1 tabanlı satır aralığı) — kenar kanıtsız etki
 * kaydı ÜRETMEZ (TŞ §8 Evidence First; ADR-004).
 */
function assertEvidenceSpans(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ContractDiscoveryError(
      "contracts/invalid-input",
      `${label} kenarı evidence'sız olamaz (contracts/invalid-input): en az bir kanıt span zorunludur (Evidence First)`,
    );
  }
  for (const span of value) {
    if (!isPlainObject(span) || !isNonEmptyString(span["relativePath"])) {
      throw new ContractDiscoveryError(
        "contracts/invalid-input",
        `${label} kenarı evidence span doğrulanamadı (contracts/invalid-input): relativePath boş olmayan string olmalıdır`,
      );
    }
    const startLine = span["startLine"];
    const endLine = span["endLine"];
    if (
      !Number.isInteger(startLine) ||
      !Number.isInteger(endLine) ||
      (startLine as number) < 1 ||
      (endLine as number) < (startLine as number)
    ) {
      throw new ContractDiscoveryError(
        "contracts/invalid-input",
        `${label} kenarı evidence span doğrulanamadı (contracts/invalid-input): startLine/endLine 1 tabanlı tam sayı ve startLine ≤ endLine olmalıdır`,
      );
    }
  }
}

/**
 * Kenar girdi doğrulaması — tüm D1 kenar alanları (edgeKind/resolution/
 * matchBasis/evidence) denetlenir; bozuk veya kanıtsız kenar çekirdeğe
 * SOKULMAZ (açık reddi; uydurma etki kaydı yok).
 */
function assertEdges(value: readonly ContractEdgeCandidate[], label: string): readonly ContractEdgeCandidate[] {
  if (!Array.isArray(value)) {
    throw new ContractDiscoveryError(
      "contracts/invalid-input",
      `${label} kenar listesi (contracts/invalid-input): dizi olmalıdır`,
    );
  }
  for (const edge of value) {
    if (!isPlainObject(edge)) {
      throw new ContractDiscoveryError(
        "contracts/invalid-input",
        `${label} kenar adayı doğrulanamadı (contracts/invalid-input): kenar bir eşleme (object) olmalıdır`,
      );
    }
    if (!isNonEmptyString(edge["fromSymbol"]) || !isNonEmptyString(edge["toContractId"])) {
      throw new ContractDiscoveryError(
        "contracts/invalid-input",
        `${label} kenar adayı doğrulanamadı (contracts/invalid-input): fromSymbol/toContractId boş olmayan string olmalıdır`,
      );
    }
    if (!EDGE_KINDS.has(edge["edgeKind"] as string)) {
      throw new ContractDiscoveryError(
        "contracts/invalid-input",
        `${label} kenar adayı doğrulanamadı (contracts/invalid-input): edgeKind PRODUCES_CONTRACT|CONSUMES_CONTRACT olmalıdır`,
      );
    }
    if (!EDGE_RESOLUTIONS.has(edge["resolution"] as string)) {
      throw new ContractDiscoveryError(
        "contracts/invalid-input",
        `${label} kenar adayı doğrulanamadı (contracts/invalid-input): resolution verified|heuristic olmalıdır`,
      );
    }
    if (!EDGE_MATCH_BASES.has(edge["matchBasis"] as string)) {
      throw new ContractDiscoveryError(
        "contracts/invalid-input",
        `${label} kenar adayı doğrulanamadı (contracts/invalid-input): matchBasis route|topic-id|name-exact|name-similarity olmalıdır`,
      );
    }
    assertEvidenceSpans(edge["evidence"], label);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */

const ASSESSMENT_MARKER_RULES: ReadonlySet<string> = new Set([
  "serializer-unknown",
  "discovery-partial",
  "no-change-detected",
]);

function isChanged(changeKind: ContractChangeKind): boolean {
  return changeKind === "added" || changeKind === "removed" || changeKind === "modified";
}

function changeKindOf(evaluation: ContractPairEvaluation): "added" | "removed" | "modified" {
  return evaluation.changeKind as "added" | "removed" | "modified";
}

/** K-013(7) summary: deterministik tek satır — "<name> <changeKind>: <ruleId'ler>". */
function summaryOf(evaluation: ContractPairEvaluation): string {
  const ruleIds = evaluation.findings.map((finding) => finding.ruleId).join(", ");
  return `${evaluation.name} ${changeKindOf(evaluation)}: ${ruleIds}`;
}

function changeRecordOf(evaluation: ContractPairEvaluation): ContractChangeRecord | undefined {
  const contractId = evaluation.targetContractId ?? evaluation.baseContractId;
  if (contractId === undefined) return undefined;
  return {
    contractId,
    changeKind: changeKindOf(evaluation),
    summary: summaryOf(evaluation),
  };
}

function driftItemOf(evaluation: ContractPairEvaluation): ContractDriftItem | undefined {
  const record = changeRecordOf(evaluation);
  if (record === undefined) return undefined;
  return {
    matchKey: evaluation.matchKey,
    contractId: record.contractId,
    name: evaluation.name,
    changeKind: record.changeKind,
    summary: record.summary,
    findings: evaluation.findings,
  };
}

function compareChangeRecords(a: ContractChangeRecord, b: ContractChangeRecord): number {
  return (
    compareStrings(a.contractId, b.contractId) ||
    compareStrings(a.changeKind, b.changeKind) ||
    compareStrings(a.summary, b.summary)
  );
}

function compareImpacts(a: ContractEdgeImpact, b: ContractEdgeImpact): number {
  return (
    compareStrings(a.matchKey, b.matchKey) ||
    compareStrings(a.side, b.side) ||
    compareStrings(a.edgeKind, b.edgeKind) ||
    compareStrings(a.fromSymbol, b.fromSymbol) ||
    compareStrings(a.toContractId, b.toContractId) ||
    compareStrings(a.matchBasis, b.matchBasis) ||
    compareStrings(a.resolution, b.resolution)
  );
}

/* ------------------------------------------------------------------ */
/* Çekirdek                                                            */
/* ------------------------------------------------------------------ */

/**
 * İki sürüm arasındaki drift'i hesaplar: D2 uyumluluk raporu üzerine
 * (a) K-013(7) contractChanges üretimi, (b) üç sınıflama alanına ayrıştırma,
 * (c) kenar tabanlı etki grafı, (d) unresolved-consumer dürüstlük kaydı.
 */
export function detectContractDrift(input: ContractDriftInput): ContractDriftResult {
  assertDiscoveryOutput(input.base, "base");
  assertDiscoveryOutput(input.target, "target");
  const baseEdges = assertEdges(input.baseEdges, "baseEdges");
  const targetEdges = assertEdges(input.targetEdges, "targetEdges");

  const report: ContractCompatibilityReport = checkContractCompatibility(input.base, input.target);

  const contractChanges: ContractChangeRecord[] = [];
  const breakingCandidates: ContractDriftItem[] = [];
  const risks: ContractDriftItem[] = [];
  const unknowns: ContractDriftItem[] = [];
  const impactedEdges: ContractEdgeImpact[] = [];
  const unconsumedChanges: ContractChangeRecord[] = [];
  const unconsumedNotes: string[] = [];
  const unchangedNotes: string[] = [];

  let changedPairs = 0;
  let unchangedPairs = 0;

  // Kenarlar deterministik sırada işlenir (girdi sırasından bağımsızlık).
  const sortedBaseEdges = [...baseEdges].sort(compareEdges);
  const sortedTargetEdges = [...targetEdges].sort(compareEdges);

  for (const evaluation of report.evaluations) {
    if (!isChanged(evaluation.changeKind)) {
      unchangedPairs += 1;
      const markers = evaluation.findings
        .filter((finding) => ASSESSMENT_MARKER_RULES.has(finding.ruleId))
        .map((finding) => finding.ruleId);
      if (markers.length > 0) {
        unchangedNotes.push(
          `${evaluation.matchKey}: değişiklik yok; değerlendirme notu: ${markers.join(", ")}`,
        );
      }
      continue;
    }

    changedPairs += 1;
    const record = changeRecordOf(evaluation);
    if (record !== undefined) contractChanges.push(record);
    const item = driftItemOf(evaluation);
    const matchKey = evaluation.matchKey;
    const baseContractId = evaluation.baseContractId ?? "";
    const targetContractId = evaluation.targetContractId ?? "";

    // (b) Üç sınıflama alanı: aggregate sınıflamaya göre TAM BİR alan.
    if (item !== undefined) {
      if (evaluation.classification === "breaking_candidate") breakingCandidates.push(item);
      else if (evaluation.classification === "risk") risks.push(item);
      else if (evaluation.classification === "unknown") unknowns.push(item);
      // backward-safe: yalnızca contractChanges + etki grafı; sınıflama alanı YOK.
    }

    // (c) Etki grafı: değişen sözleşmeyi işaret eden kenarlar (iki sürüm).
    let hasConsumerEdge = false;
    for (const edge of sortedBaseEdges) {
      if (baseContractId.length === 0 || edge.toContractId !== baseContractId) continue;
      if (edge.edgeKind === "CONSUMES_CONTRACT") hasConsumerEdge = true;
      impactedEdges.push({
        matchKey,
        side: "base",
        changeKind: changeKindOf(evaluation),
        classification: evaluation.classification,
        edgeKind: edge.edgeKind,
        fromSymbol: edge.fromSymbol,
        toContractId: edge.toContractId,
        resolution: edge.resolution,
        matchBasis: edge.matchBasis,
        evidence: edge.evidence,
      });
    }
    for (const edge of sortedTargetEdges) {
      if (targetContractId.length === 0 || edge.toContractId !== targetContractId) continue;
      if (edge.edgeKind === "CONSUMES_CONTRACT") hasConsumerEdge = true;
      impactedEdges.push({
        matchKey,
        side: "target",
        changeKind: changeKindOf(evaluation),
        classification: evaluation.classification,
        edgeKind: edge.edgeKind,
        fromSymbol: edge.fromSymbol,
        toContractId: edge.toContractId,
        resolution: edge.resolution,
        matchBasis: edge.matchBasis,
        evidence: edge.evidence,
      });
    }

    // (d) Unresolved consumers: tüketici kenarı yoksa etki değerlendirilemedi.
    if (!hasConsumerEdge && record !== undefined) {
      unconsumedChanges.push(record);
      unconsumedNotes.push(
        `unconsumed: ${matchKey} — tüketici kenarı (CONSUMES_CONTRACT) bulunamadı; tüketici etkisi değerlendirilemedi`,
      );
    }
  }

  const rationale: string[] = [
    `karşılaştırılan çift: ${String(report.evaluations.length)}; değişen: ${String(changedPairs)}; değişmeyen: ${String(unchangedPairs)}`,
  ];
  if (changedPairs === 0) {
    rationale.push("yapısal değişiklik bulunamadı; drift boş");
  }
  rationale.push(...unchangedNotes);
  rationale.push(...unconsumedNotes);
  for (const finding of report.unattachedFindings) {
    rationale.push(`unattached bulgu: ${finding.ruleId} — ${finding.summary}`);
  }

  return {
    contractChanges: [...contractChanges].sort(compareChangeRecords),
    breakingCandidates: [...breakingCandidates].sort((a, b) => compareStrings(a.matchKey, b.matchKey)),
    risks: [...risks].sort((a, b) => compareStrings(a.matchKey, b.matchKey)),
    unknowns: [...unknowns].sort((a, b) => compareStrings(a.matchKey, b.matchKey)),
    impactedEdges: impactedEdges.sort(compareImpacts),
    unconsumedChanges: [...unconsumedChanges].sort(compareChangeRecords),
    unattachedFindings: report.unattachedFindings,
    evaluations: report.evaluations,
    rationale,
  };
}
