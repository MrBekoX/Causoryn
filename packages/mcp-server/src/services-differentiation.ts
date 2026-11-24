import {
  ContractDiscoveryError,
  checkContractCompatibility,
  detectContractDrift,
  discoverContractsFromTexts,
  matchContractEdges,
  scanServiceAnchors,
  readContractFiles,
  type ContractCompatibilityFinding,
  type ContractPairEvaluation,
  type DiscoveryOutput,
  type ServiceAnchor,
} from "@causoryn/contracts";
import {
  GraphRepositoryError,
  traceBusinessFlow as traceBusinessFlowCore,
  type FlowTrace,
} from "@causoryn/graph";
import {
  PreflightError,
  buildPreflightManifest,
  deriveTestPlan as deriveTestPlanCore,
  resolveSourceRevision,
  type PreflightManifest,
  type TestPlanResult,
} from "@causoryn/preflight";
import { canonicalJson, sha256Hex, utf8Encode, type JsonValue } from "@causoryn/domain";
import { z } from "zod";

import { CausorynToolError, type CausorynToolErrorCode } from "./errors.js";
import { buildEnvelope, type Envelope } from "./envelope.js";
import {
  coverageOf,
  envelopeStatusOf,
  requireAuthorizedWorkspace,
  requireSnapshot,
  resolveSymbolNode,
  staleWarningOf,
  type ServiceDeps,
} from "./services.js";
import { graphErrorToToolError } from "./services-architecture.js";
import type { VerificationServiceDeps } from "./services-verification.js";

/**
 * Faz D uygulama servisleri (sprint-5 D2/D3/D4/D5/D6 — Differentiation
 * çekirdeklerinin MCP yüzeyi; TŞ v2.1 §10.2 araç kataloğu, §10.3 preflight
 * manifest gövdesi, §11 Architecture Contracts/Contract Drift, §14 Business
 * Flow Intelligence, §15 Test Intelligence).
 *
 * Ortal davranış services.ts/services-architecture.ts ile birebir aynıdır:
 * workspace yetkilendirmesi ilk adım (WORKSPACE_NOT_AUTHORIZED), yayınlanmış
 * snapshot gerektiren araçlar INDEX_NOT_READY, çıktılar deterministiktir
 * (TŞ §8 invariant iv/vi: aynı girdi → aynı çıktı JSON).
 *
 * TŞ §10.2 alan adı sadakati (PDF Sayfa 9–10, pdftotext ile birincil
 * kaynaktan doğrulandı):
 * - causoryn_trace_business_flow: "flowSeed, boundaries?, maxHops" →
 *   `flowSeed`/`boundaries?`/`maxHops?` birebir; TŞ §20 maxFlows/maxNodes
 *   kaynak bütçesi de açıktır (çekirdek FLOW_LIMIT_CEILINGS tavanıyla
 *   kırpılır ve rationale + truncated ile raporlar).
 * - causoryn_preflight_change: "intent, targetSymbols/files?, baseSnapshot?"
 *   → `intent` (zorunlu), `targetSymbols?`/`targetFiles?`, `baseSnapshot?`
 *   birebir; §10.3 örneğinin includeContracts/includeTestPlan/maxDepth
 *   alanları da şemadadır.
 * - causoryn_check_contracts: "contracts?, snapshotId?" → `contracts?`
 *   (TŞ'de şekilsiz; bu dilimde sözleşme SÜRÜM ÇİFTİ {name?, base, target}
 *   olarak tanımlanır — D2 çekirdeği checkContractCompatibility(base,
 *   targetDiscoveryOutput) girdisine bire bir eşlenir), `snapshotId?` →
 *   envelope anchored published snapshot (verilmezse en son yayınlanmış).
 * - causoryn_detect_contract_drift: "base, target, scope?" → `base`/`target`
 *   (spec dosyası listeleri), `scope?` (matchKey daraltması);
 *   `anchorFiles?` TŞ kataloğunda sayılmayan BELGELİ ektir —
 *   PRODUCES/CONSUMES_CONTRACT etki grafı tüketici ankrajları olmadan
 *   üretilemez; verilmezse tüm değişiklikler unconsumedChanges'e düşer
 *   (TŞ §11 "(6) unresolved consumers" dürüstlük hükmü).
 * - causoryn_derive_test_plan: "changeSet/preflightId?" → `changeSet?`
 *   ({changedSymbols?, changedFiles?}); `preflightId?` BEYANLI ama bu dilimde
 *   ÇÖZÜMLENMEZ (süreç-içi PreflightManifestStore yalnızca verify_change
 *   içindir; derive_test_plan bu dilimde preflightId çözmez) → şemayı geçen
 *   değer AÇIK INVALID_ARGUMENT ile reddedilir (ADR-010 sessiz yok sayma yok;
 *   candidateScope/focus/granularity açık-ret örüntüsü).
 *
 * SALT-OKUNUR disiplin (kırmızı çizgiler 2/3): sözleşme keşfi yalnızca
 * WorkspaceAccessPolicy.checkFile kararıyla dosya okur (readContractFiles:
 * traversal/symlink/TOCTOU savunmaları pakettedir); kaynak ağacına YAZMA
 * YOKTUR; git checkout/reset/clean yoktur; preflight_change manifest'in
 * candidateOnly=true alanıyla da KANITLANIR ve hiçbir koşulda dosya
 * yazmaz (buildPreflightManifest saf çekirdektir; sourceRevision tamamen
 * salt-okunur dosya okumasıyla çözülür — resolveSourceRevision).
 */

/* ------------------------------------------------------------------ */
/* Hata eşlemeleri (paket kodları → sabit tool kodu; tek nokta)        */
/* ------------------------------------------------------------------ */

/**
 * @causoryn/contracts ContractDiscoveryError → sabit tool hata kodu.
 * CONTRACT_PARSE_FAILED TŞ §10.1 SABİT kodudur (s.9; birincil kaynak
 * doğrulaması plugin-package.test.ts TSH_BASE_ERROR_CODES) ve bu dilimde
 * İLK KEZ kullanılır: spec parse/şema reddi = contracts/spec-* kodları.
 * Uzantı kodu BASILMAZ (K-008 örüntüsü: TŞ listesinde uygun kod varsa
 * uzantı kodu basılmaz).
 */
export function contractErrorToToolError(
  error: { readonly code: string; readonly message: string },
  log?: (message: string) => void,
): CausorynToolError {
  const code = error.code;
  if (code === "contracts/invalid-input") {
    return new CausorynToolError("INVALID_ARGUMENT", error.message);
  }
  // Salt-okunur spec erişim reddi (policy/traversal/ignore/realpath):
  // yol sınıfı hata → TŞ sabit PATH_DENIED.
  if (code === "contracts/file-not-authorized") {
    return new CausorynToolError("PATH_DENIED", error.message);
  }
  if (code === "contracts/limit-exceeded" || code === "contracts/depth-exceeded") {
    return new CausorynToolError("LIMIT_EXCEEDED", error.message);
  }
  if (
    code === "contracts/spec-yaml-invalid" ||
    code === "contracts/spec-json-invalid" ||
    code === "contracts/spec-invalid" ||
    code === "contracts/unsupported-spec"
  ) {
    return new CausorynToolError("CONTRACT_PARSE_FAILED", error.message);
  }
  log?.(`contract error code ${code} mapped to INTERNAL_ERROR: ${error.message}`);
  return new CausorynToolError(
    "INTERNAL_ERROR",
    "Unexpected internal error; see the server logs for details",
  );
}

/**
 * @causoryn/preflight PreflightError → sabit tool hata kodu (paket başlığı
 * kod tablosunun MCP karşılığı): invalid-input → INVALID_ARGUMENT (K-008),
 * snapshot-state → INDEX_NOT_READY, file-not-authorized → PATH_DENIED.
 */
export function preflightErrorToToolError(error: {
  readonly code: string;
  readonly message: string;
}): CausorynToolError {
  const code = error.code;
  if (code === "preflight/invalid-input") {
    return new CausorynToolError("INVALID_ARGUMENT", error.message);
  }
  if (code === "preflight/snapshot-state") {
    return new CausorynToolError("INDEX_NOT_READY", error.message);
  }
  if (code === "preflight/file-not-authorized") {
    return new CausorynToolError("PATH_DENIED", error.message);
  }
  return new CausorynToolError(
    "INTERNAL_ERROR",
    "Unexpected internal error; see the server logs for details",
  );
}

/** Paket hatalarını sabit tool kodlarına eşleyerek koşturur (senkron). */
function runDifferentiation<T>(logger: (message: string) => void, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ContractDiscoveryError) {
      throw contractErrorToToolError(error, logger);
    }
    if (error instanceof GraphRepositoryError) {
      throw graphErrorToToolError(error, logger);
    }
    if (error instanceof PreflightError) {
      throw preflightErrorToToolError(error);
    }
    throw error;
  }
}

/** Eşzamansız (fs Promise) işleri aynı eşlemeyle koşturur. */
async function runDifferentiationAsync<T>(
  logger: (message: string) => void,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ContractDiscoveryError) {
      throw contractErrorToToolError(error, logger);
    }
    if (error instanceof GraphRepositoryError) {
      throw graphErrorToToolError(error, logger);
    }
    if (error instanceof PreflightError) {
      throw preflightErrorToToolError(error);
    }
    throw error;
  }
}

/** TŞ §14 iş akışı sözcüğü — şema enum'u çekirdek sabitiyle aynı kümedir. */
const FLOW_BOUNDARIES = [
  "ROUTES_TO",
  "CALLS",
  "PRODUCES_CONTRACT",
  "CONSUMES_CONTRACT",
  "CONTAINS",
] as const;

/* ------------------------------------------------------------------ */
/* Ortak çıktı şemaları                                                */
/* ------------------------------------------------------------------ */

const ContractClassificationSchema = z.enum([
  "backward-safe",
  "risk",
  "breaking_candidate",
  "unknown",
]);

const ContractEvidenceSpanSchema = z.strictObject({
  relativePath: z.string(),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
});

const CompatibilityFindingSchema = z.strictObject({
  ruleId: z.string(),
  classification: ContractClassificationSchema,
  summary: z.string(),
  property: z.string().optional(),
  evidence: z.array(ContractEvidenceSpanSchema),
});

const PairEvaluationSchema = z.strictObject({
  matchKey: z.string(),
  sourceKind: z.string(),
  nodeKind: z.string(),
  name: z.string(),
  changeKind: z.enum(["added", "removed", "modified", "unchanged"]),
  baseContractId: z.string().optional(),
  targetContractId: z.string().optional(),
  classification: ContractClassificationSchema,
  findings: z.array(CompatibilityFindingSchema),
});

/** K-013(7) contractChanges gövdesi (WikiDiff'teki WikiContractChangeSchema
 * ile aynı üç alan; üretici sözleşme contracts contract-drift.ts). */
const ContractChangeRecordSchema = z.strictObject({
  contractId: z.string(),
  changeKind: z.enum(["added", "removed", "modified"]),
  summary: z.string(),
});

const DriftItemSchema = z.strictObject({
  matchKey: z.string(),
  contractId: z.string(),
  name: z.string(),
  changeKind: ContractChangeRecordSchema.shape.changeKind,
  summary: z.string(),
  findings: z.array(CompatibilityFindingSchema),
});

const ImpactedEdgeSchema = z.strictObject({
  matchKey: z.string(),
  side: z.enum(["base", "target"]),
  changeKind: ContractChangeRecordSchema.shape.changeKind,
  classification: ContractClassificationSchema,
  edgeKind: z.enum(["PRODUCES_CONTRACT", "CONSUMES_CONTRACT"]),
  fromSymbol: z.string(),
  toContractId: z.string(),
  resolution: z.enum(["verified", "heuristic"]),
  matchBasis: z.enum(["route", "topic-id", "name-exact", "name-similarity"]),
  evidence: z.array(ContractEvidenceSpanSchema),
});

/**
 * TŞ §19/§20 resource budget tavanı (güvenlik denetimi bulgusu): her eleman
 * policy-kontrollü salt-okunur dosya okuma + parse (dosya başına 1 MiB kota)
 * açar; contracts çifti başına 2 dosya + O(contracts×anchors) eşleştirme
 * koşar ve checkContracts'taki Promise.all eşzamanlılığı bu tavanla sınırlı
 * kalır. Wiki refs tavanı (WIKI_TOOL_MAX_LIMIT=200, services-wiki.ts) tek
 * git cat-file çözümlemesi bütçesidir; dosya okuma+parse bütçesi daha dar
 * tutulur. Dilim kararı: TŞ §10.2 bu dizilere sayı vermez; tek kullanıcılı
 * stdio dilimi (TŞ §25/2) için 25 eleman.
 */
export const DIFFERENTIATION_TOOL_MAX_ITEMS = 25;

/* ------------------------------------------------------------------ */
/* D2 — causoryn_check_contracts                                       */
/* ------------------------------------------------------------------ */

export const CheckContractsInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /**
   * TŞ §10.2 "contracts?" — bu dilimde sözleşme SÜRÜM ÇİFTİ: base/target
   * yetkili kök-göreceli spec dosyaları (OpenAPI/AsyncAPI/JSON Schema/SQL/
   * proto); keşif WorkspaceAccessPolicy ile salt okunur yapılır.
   */
  contracts: z
    .array(
      z.strictObject({
        name: z.string().min(1).optional(),
        base: z.string().min(1),
        target: z.string().min(1),
      }),
    )
    .min(1)
    .max(DIFFERENTIATION_TOOL_MAX_ITEMS),
  /** TŞ §10.2 "snapshotId?" — envelope çapası; yoksa en son yayınlanmış. */
  snapshotId: z.string().min(1).optional(),
});

export const CheckContractsDataSchema = z.strictObject({
  snapshotId: z.string(),
  pairs: z.array(
    z.strictObject({
      name: z.string().optional(),
      baseFile: z.string(),
      targetFile: z.string(),
      classification: ContractClassificationSchema,
      evaluations: z.array(PairEvaluationSchema),
      unattachedFindings: z.array(CompatibilityFindingSchema),
    }),
  ),
  summary: z.strictObject({
    pairCount: z.number().int().nonnegative(),
    evaluationsCount: z.number().int().nonnegative(),
    byClassification: z.strictObject({
      backwardSafe: z.number().int().nonnegative(),
      risk: z.number().int().nonnegative(),
      breakingCandidate: z.number().int().nonnegative(),
      unknown: z.number().int().nonnegative(),
    }),
  }),
});

/** Envelope çapası: snapshotId verilirse o, verilmezse en son yayınlanmış. */
function resolveEnvelopeSnapshot(
  deps: ServiceDeps,
  workspaceId: string,
  snapshotId: string | undefined,
): ReturnType<typeof requireSnapshot> {
  if (snapshotId === undefined) {
    return requireSnapshot(deps, workspaceId);
  }
  const read = deps.repository.getSnapshot(snapshotId);
  if (read === undefined || read.snapshot.meta.workspaceId !== workspaceId) {
    throw new CausorynToolError(
      "INVALID_REVISION",
      `snapshotId could not be resolved: ${snapshotId} — it must be a snapshot ID published for this workspace`,
    );
  }
  return read;
}

/**
 * causoryn_check_contracts (TŞ §10.2 "Architecture Contracts değerlendirmesi";
 * sprint-5 D2): sözleşme sürüm çiftlerini keşfeder (salt okunur) ve
 * checkContractCompatibility çekirdeğiyle backward-safe/risk/
 * breaking_candidate/unknown sınıflaması üretir. Sınıflama statik delildir:
 * serializer/framework davranışı bilinemediğinde unknown üretilir ve
 * breaking delilini GİZLEMEZ (bulgular ayrı ayrı taşınır — TŞ §11).
 */
export async function checkContracts(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof CheckContractsInputSchema>,
): Promise<Envelope> {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  const root = requireAuthorizedWorkspace(deps, workspaceId);
  const read = resolveEnvelopeSnapshot(deps, workspaceId, input.snapshotId);

  const pairs = await Promise.all(
    input.contracts.map(async (pair) => {
      const files = await runDifferentiationAsync(deps.logger, () =>
        readContractFiles(root, deps.policy, [pair.base, pair.target]),
      );
      // Denetim bulgusu: readContractFiles policy'nin KANONİK POSIX
      // relativePath'ini taşır; ham kullanıcı girdisiyle filtre yapmak
      // ('./openapi.yaml' gibi yazımlarda) dosya okunup parse edilse bile
      // eşleşmezdi → sessiz boş keşif → uydurma 'backward-safe'. Eşleme
      // policy kararının kanonik yoluyla yapılır; ret kararı
      // readContractFiles içinde ContractDiscoveryError olarak fırlatıldığı
      // için buraya yalnızca allowed kararlar ulaşır.
      const baseDecision = deps.policy.checkFile(root, pair.base);
      const targetDecision = deps.policy.checkFile(root, pair.target);
      const baseRelative =
        baseDecision.allowed && baseDecision.relativePath !== "." ? baseDecision.relativePath : pair.base;
      const targetRelative =
        targetDecision.allowed && targetDecision.relativePath !== "." ? targetDecision.relativePath : pair.target;
      const baseOutput: DiscoveryOutput = runDifferentiation(deps.logger, () =>
        discoverContractsFromTexts(
          workspaceId,
          files.filter((file) => file.relativePath === baseRelative),
        ),
      );
      const targetOutput: DiscoveryOutput = runDifferentiation(deps.logger, () =>
        discoverContractsFromTexts(
          workspaceId,
          files.filter((file) => file.relativePath === targetRelative),
        ),
      );
      const report = runDifferentiation(deps.logger, () =>
        checkContractCompatibility(baseOutput, targetOutput),
      );
      return {
        ...(pair.name === undefined ? {} : { name: pair.name }),
        baseFile: baseRelative,
        targetFile: targetRelative,
        classification: report.classification,
        evaluations: report.evaluations.map(evaluationOf),
        unattachedFindings: report.unattachedFindings.map(findingOf),
      };
    }),
  );

  const byClassification = { backwardSafe: 0, risk: 0, breakingCandidate: 0, unknown: 0 };
  let evaluationsCount = 0;
  for (const pair of pairs) {
    for (const evaluation of pair.evaluations) {
      evaluationsCount += 1;
      if (evaluation.classification === "backward-safe") byClassification.backwardSafe += 1;
      else if (evaluation.classification === "risk") byClassification.risk += 1;
      else if (evaluation.classification === "breaking_candidate") {
        byClassification.breakingCandidate += 1;
      } else {
        byClassification.unknown += 1;
      }
    }
  }

  const warnings = staleWarningOf(read);
  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: read.snapshot.meta.id,
    status: envelopeStatusOf(read),
    coverage: coverageOf(read.snapshot),
    warnings,
    data: {
      snapshotId: read.snapshot.meta.id,
      pairs,
      summary: {
        pairCount: pairs.length,
        evaluationsCount,
        byClassification,
      },
    },
  });
}

function findingOf(finding: ContractCompatibilityFinding): z.infer<typeof CompatibilityFindingSchema> {
  return {
    ruleId: finding.ruleId,
    classification: finding.classification,
    summary: finding.summary,
    ...(finding.property === undefined ? {} : { property: finding.property }),
    evidence: finding.evidence.map((span) => ({ ...span })),
  };
}

function evaluationOf(
  evaluation: ContractPairEvaluation,
): z.infer<typeof PairEvaluationSchema> {
  return {
    matchKey: evaluation.matchKey,
    sourceKind: evaluation.sourceKind,
    nodeKind: evaluation.nodeKind,
    name: evaluation.name,
    changeKind: evaluation.changeKind,
    ...(evaluation.baseContractId === undefined ? {} : { baseContractId: evaluation.baseContractId }),
    ...(evaluation.targetContractId === undefined
      ? {}
      : { targetContractId: evaluation.targetContractId }),
    classification: evaluation.classification,
    findings: evaluation.findings.map(findingOf),
  };
}

/* ------------------------------------------------------------------ */
/* D3 — causoryn_detect_contract_drift                                 */
/* ------------------------------------------------------------------ */

export const DetectContractDriftInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** TŞ §10.2 "base": base sürümünün spec dosyaları (kök-göreceli);
   * her eleman 1 salt-okunur dosya okuma+parse açar → DIFFERENTIATION_TOOL_MAX_ITEMS tavanı. */
  base: z.array(z.string().min(1)).min(1).max(DIFFERENTIATION_TOOL_MAX_ITEMS),
  /** TŞ §10.2 "target": hedef sürümün spec dosyaları (aynı tavan). */
  target: z.array(z.string().min(1)).min(1).max(DIFFERENTIATION_TOOL_MAX_ITEMS),
  /** TŞ §10.2 "scope?": raporu bu matchKey'lere daraltır (tam eşleşme). */
  scope: z.array(z.string().min(1)).min(1).optional(),
  /**
   * TŞ kataloğunda sayılmayan BELGELİ ek: tüketici/üretici ankraj taraması
   * için servis kaynak dosyaları. Verilmezse etki grafı boş kalır ve TÜM
   * değişiklikler unconsumedChanges'e düşer (unresolved consumers).
   * Tavan: her eleman dosya okuma + ankraj taraması açar
   * (DIFFERENTIATION_TOOL_MAX_ITEMS).
   */
  anchorFiles: z
    .array(z.string().min(1))
    .min(1)
    .max(DIFFERENTIATION_TOOL_MAX_ITEMS)
    .optional(),
});

export const DetectContractDriftDataSchema = z.strictObject({
  snapshotId: z.string(),
  contractChanges: z.array(ContractChangeRecordSchema),
  breakingCandidates: z.array(DriftItemSchema),
  risks: z.array(DriftItemSchema),
  unknowns: z.array(DriftItemSchema),
  impactedEdges: z.array(ImpactedEdgeSchema),
  unconsumedChanges: z.array(ContractChangeRecordSchema),
  unattachedFindings: z.array(CompatibilityFindingSchema),
  rationale: z.array(z.string()),
  summary: z.strictObject({
    changedCount: z.number().int().nonnegative(),
    breakingCount: z.number().int().nonnegative(),
    riskCount: z.number().int().nonnegative(),
    unknownCount: z.number().int().nonnegative(),
    impactedEdgeCount: z.number().int().nonnegative(),
    unconsumedCount: z.number().int().nonnegative(),
  }),
});

/** Ankraj sembolü: dosya adı (son uzantısı kesik) — deterministik türetim. */
function anchorSymbolOf(relativePath: string): string {
  const posix = relativePath.replace(/\\/g, "/");
  const base = posix.slice(posix.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return base;
  return base.slice(0, dot);
}

/**
 * causoryn_detect_contract_drift (TŞ §10.2 "Contract Drift Detection";
 * sprint-5 D3): iki sürümün spec dosyalarını keşfeder, (verilmişse) ankraj
 * dosyalarından PRODUCES/CONSUMES kenar adayları tarar ve detectContractDrift
 * çekirdeğiyle K-013(7) contractChanges + üç sınıflama alanı + etki grafı +
 * unresolved-consumers raporu üretir. `scope` matchKey daraltmasıdır: eşleşen
 * anahtarın çiftine ait kimlikler dışındaki kayıtlar rapordan düşer (sessiz
 * düşürme değil — istenmiş daraltma; rationale korunur ve notla işaretlenir).
 */
export async function detectContractDriftTool(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof DetectContractDriftInputSchema>,
): Promise<Envelope> {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  const root = requireAuthorizedWorkspace(deps, workspaceId);
  const read = requireSnapshot(deps, workspaceId);

  const result = await runDifferentiationAsync(deps.logger, async () => {
    const baseFiles = await readContractFiles(root, deps.policy, input.base);
    const targetFiles = await readContractFiles(root, deps.policy, input.target);
    const base = discoverContractsFromTexts(workspaceId, baseFiles);
    const target = discoverContractsFromTexts(workspaceId, targetFiles);

    const anchors: ServiceAnchor[] = [];
    if (input.anchorFiles !== undefined) {
      const anchorFiles = await readContractFiles(root, deps.policy, input.anchorFiles);
      for (const file of anchorFiles) {
        anchors.push(
          ...scanServiceAnchors(file.relativePath, file.text, anchorSymbolOf(file.relativePath)),
        );
      }
    }
    const baseEdges = matchContractEdges(base.contracts, anchors);
    const targetEdges = matchContractEdges(target.contracts, anchors);
    return { base, target, drift: detectContractDrift({ base, target, baseEdges, targetEdges }) };
  });

  const drift = result.drift;

  // scope daraltması: eşleşen matchKey'lerin çift kimlikleri (base/target
  // contractId'ler) hesaplanır ve tüm değişim dizileri bu kümeyle filtrelenir.
  let contractChanges = [...drift.contractChanges];
  let breakingCandidates = [...drift.breakingCandidates];
  let risks = [...drift.risks];
  let unknowns = [...drift.unknowns];
  let impactedEdges = [...drift.impactedEdges];
  let unconsumedChanges = [...drift.unconsumedChanges];
  const rationale = [...drift.rationale];
  if (input.scope !== undefined) {
    const scopedKeys = new Set(input.scope);
    const scopedContractIds = new Set<string>();
    // Denetim bulgusu: checkContractCompatibility çekirdek içinde (contract-
    // drift.ts) zaten koştu; aynı girdiyi ikinci kez değerlendirmek yerine
    // drift sonucunun evaluations alanından türetilir.
    for (const evaluation of drift.evaluations) {
      if (!scopedKeys.has(evaluation.matchKey)) continue;
      if (evaluation.baseContractId !== undefined) scopedContractIds.add(evaluation.baseContractId);
      if (evaluation.targetContractId !== undefined) {
        scopedContractIds.add(evaluation.targetContractId);
      }
    }
    contractChanges = contractChanges.filter((record) => scopedContractIds.has(record.contractId));
    const keepItem = (item: { matchKey: string }): boolean => scopedKeys.has(item.matchKey);
    breakingCandidates = breakingCandidates.filter(keepItem);
    risks = risks.filter(keepItem);
    unknowns = unknowns.filter(keepItem);
    impactedEdges = impactedEdges.filter(keepItem);
    unconsumedChanges = unconsumedChanges.filter((record) =>
      scopedContractIds.has(record.contractId),
    );
    rationale.push(
      `scope filter applied: ${String(input.scope.length)} matchKey(s); records of non-matching pairs were dropped from the report`,
    );
  }

  const warnings = staleWarningOf(read);
  if (input.anchorFiles === undefined && contractChanges.length > 0) {
    warnings.push(
      "anchorFiles not provided: consumer/producer anchors could not be scanned; the impact graph is empty and every change is listed in unconsumedChanges (unresolved consumers)",
    );
  }

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: read.snapshot.meta.id,
    status: envelopeStatusOf(read),
    coverage: coverageOf(read.snapshot),
    warnings,
    data: {
      snapshotId: read.snapshot.meta.id,
      contractChanges,
      breakingCandidates,
      risks,
      unknowns,
      impactedEdges,
      unconsumedChanges,
      unattachedFindings: drift.unattachedFindings.map(findingOf),
      rationale,
      summary: {
        // contractChanges backward-safe değişiklikleri de taşır (sınıflama
        // alanları ayrıdır); değişen çift sayısının dürüst karşılığı budur.
        changedCount: contractChanges.length,
        breakingCount: breakingCandidates.length,
        riskCount: risks.length,
        unknownCount: unknowns.length,
        impactedEdgeCount: impactedEdges.length,
        unconsumedCount: unconsumedChanges.length,
      },
    },
  });
}

/* ------------------------------------------------------------------ */
/* D6 — causoryn_derive_test_plan (+ planId sözleşmesi)                */
/* ------------------------------------------------------------------ */

const TestPlanEdgeRefSchema = z.strictObject({
  edgeId: z.string(),
  kind: z.string(),
  from: z.string(),
  to: z.string(),
  resolution: z.enum(["verified", "heuristic", "unresolved"]),
  evidenceIds: z.array(z.string()),
});

const TestPlanCandidateSchema = z.strictObject({
  candidateId: z.string(),
  testNodeId: z.string(),
  testQualifiedName: z.string(),
  testKind: z.string(),
  changedNodeId: z.string(),
  changedQualifiedName: z.string(),
  matchLevel: z.enum(["direct", "naming", "call-site"]),
  resolution: z.enum(["verified", "heuristic", "unresolved"]),
  depth: z.number().int().nonnegative(),
  reason: z.string(),
  evidenceIds: z.array(z.string()),
  edges: z.array(TestPlanEdgeRefSchema),
});

/**
 * D6 çıktısı + planId. planId içerik adreslidir: "testplan:" + plan gövdesinin
 * canonical JSON SHA-256 karması (preflightId örüntüsü; uydurma kimlik yok —
 * aynı plan iki koşumda aynı kimliği taşır ve preflight_change'in
 * testPlanId referansı bu kimlikle bire bir eşleşir).
 */
export const TestPlanDataSchema = z.strictObject({
  planId: z.string().regex(/^testplan:[0-9a-f]{64}$/),
  snapshotId: z.string(),
  identifiedSymbols: z.array(
    z.strictObject({
      nodeId: z.string(),
      kind: z.string(),
      qualifiedName: z.string(),
    }),
  ),
  unresolvedSymbols: z.array(
    z.strictObject({ target: z.string(), reason: z.string() }),
  ),
  candidates: z.array(TestPlanCandidateSchema),
  missingCoverageCandidates: z.array(
    z.strictObject({
      nodeId: z.string(),
      kind: z.string(),
      qualifiedName: z.string(),
      reason: z.string(),
    }),
  ),
  summary: z.strictObject({
    direct: z.number().int().nonnegative(),
    naming: z.number().int().nonnegative(),
    callSite: z.number().int().nonnegative(),
    totalCandidates: z.number().int().nonnegative(),
    missingCoverageCandidates: z.number().int().nonnegative(),
  }),
  truncated: z.boolean(),
  truncatedBy: z.array(z.enum(["maxCandidates", "maxDepth"])),
  limits: z.strictObject({
    maxDepth: z.number().int().positive(),
    maxCandidates: z.number().int().positive(),
  }),
  rationales: z.array(z.string()),
});

/** Araç yüzeyi adıyla aynı şema (causoryn_derive_test_plan outputSchema). */
export const DeriveTestPlanDataSchema = TestPlanDataSchema;

/** D6 çıktısının içerik adresli kimliği (deterministik; domain örüntüsü). */
export function testPlanIdOf(plan: TestPlanResult): string {
  return `testplan:${sha256Hex(utf8Encode(canonicalJson(testPlanJsonValue(plan))))}`;
}

function testPlanJsonValue(plan: TestPlanResult): JsonValue {
  return {
    snapshotId: plan.snapshotId,
    identifiedSymbols: plan.identifiedSymbols.map((symbol) => ({
      nodeId: symbol.nodeId,
      kind: symbol.kind,
      qualifiedName: symbol.qualifiedName,
    })),
    unresolvedSymbols: plan.unresolvedSymbols.map((entry) => ({
      target: entry.target,
      reason: entry.reason,
    })),
    candidates: plan.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      testNodeId: candidate.testNodeId,
      testQualifiedName: candidate.testQualifiedName,
      testKind: candidate.testKind,
      changedNodeId: candidate.changedNodeId,
      changedQualifiedName: candidate.changedQualifiedName,
      matchLevel: candidate.matchLevel,
      resolution: candidate.resolution,
      depth: candidate.depth,
      reason: candidate.reason,
      evidenceIds: [...candidate.evidenceIds],
      edges: candidate.edges.map((edge) => ({
        edgeId: edge.edgeId,
        kind: edge.kind,
        from: edge.from,
        to: edge.to,
        resolution: edge.resolution,
        evidenceIds: [...edge.evidenceIds],
      })),
    })),
    missingCoverageCandidates: plan.missingCoverageCandidates.map((entry) => ({
      nodeId: entry.nodeId,
      kind: entry.kind,
      qualifiedName: entry.qualifiedName,
      reason: entry.reason,
    })),
    summary: {
      direct: plan.summary.direct,
      naming: plan.summary.naming,
      callSite: plan.summary.callSite,
      totalCandidates: plan.summary.totalCandidates,
      missingCoverageCandidates: plan.summary.missingCoverageCandidates,
    },
    truncated: plan.truncated,
    truncatedBy: [...plan.truncatedBy],
    limits: { maxDepth: plan.limits.maxDepth, maxCandidates: plan.limits.maxCandidates },
    rationales: [...plan.rationales],
  };
}

function testPlanDataOf(plan: TestPlanResult): z.infer<typeof TestPlanDataSchema> {
  return {
    planId: testPlanIdOf(plan),
    snapshotId: plan.snapshotId,
    identifiedSymbols: plan.identifiedSymbols.map((symbol) => ({ ...symbol })),
    unresolvedSymbols: plan.unresolvedSymbols.map((entry) => ({ ...entry })),
    candidates: plan.candidates.map((candidate) => ({
      ...candidate,
      evidenceIds: [...candidate.evidenceIds],
      edges: candidate.edges.map((edge) => ({ ...edge, evidenceIds: [...edge.evidenceIds] })),
    })),
    missingCoverageCandidates: plan.missingCoverageCandidates.map((entry) => ({ ...entry })),
    summary: { ...plan.summary },
    truncated: plan.truncated,
    truncatedBy: [...plan.truncatedBy],
    limits: { ...plan.limits },
    rationales: [...plan.rationales],
  };
}

export const DeriveTestPlanInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** Changed symbol/file scope (mutually exclusive with preflightId). */
  changeSet: z
    .strictObject({
      changedSymbols: z.array(z.string().min(1)).min(1).optional(),
      changedFiles: z.array(z.string().min(1)).min(1).optional(),
    })
    .optional(),
  /** Preflight manifest ID stored in the server's in-memory PreflightManifestStore. */
  preflightId: z.string().min(1).optional(),
  /** Resource budget limits (capped by TEST_PLAN_LIMIT_CEILINGS). */
  maxDepth: z.number().int().positive().optional(),
  maxCandidates: z.number().int().positive().optional(),
});

/**
 * causoryn_derive_test_plan: derives deterministic test candidates from TESTS
 * edges, naming heuristics, and CALLS chains. Accepts either an explicit
 * `changeSet` or a `preflightId` stored in `deps.preflightStore`.
 * Never executes tests and never claims test execution status.
 */
export function deriveTestPlan(
  deps: VerificationServiceDeps,
  requestId: string,
  input: z.infer<typeof DeriveTestPlanInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  const root = requireAuthorizedWorkspace(deps, workspaceId);

  const changeSet = input.changeSet;
  if (input.preflightId !== undefined && changeSet !== undefined) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "changeSet and preflightId cannot both be provided; supply exactly one",
    );
  }
  if (input.preflightId === undefined && changeSet === undefined) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "Either changeSet (changedSymbols and/or changedFiles) or preflightId is required",
    );
  }

  let read = requireSnapshot(deps, workspaceId);
  let resolvedChangedSymbols: readonly string[] | undefined = changeSet?.changedSymbols;
  let resolvedChangedFiles: readonly string[] | undefined = changeSet?.changedFiles;

  if (input.preflightId !== undefined) {
    const manifest = deps.preflightStore?.get(input.preflightId);
    if (manifest === undefined) {
      throw new CausorynToolError(
        "INVALID_ARGUMENT",
        `preflightId not found or expired in this server process: ${input.preflightId}; run causoryn_preflight_change first or provide changeSet directly`,
      );
    }

    const baseSnapshotRead = deps.repository.getSnapshot(manifest.baseSnapshotId);
    if (baseSnapshotRead !== undefined) {
      if (baseSnapshotRead.snapshot.meta.workspaceId !== workspaceId) {
        throw new CausorynToolError(
          "INVALID_ARGUMENT",
          `preflightId belongs to a different workspace: ${input.preflightId}`,
        );
      }
      read = baseSnapshotRead;
    }

    const snapshotNodeIds = new Set(read.snapshot.nodes.map((node) => node.id));
    const symbols = new Set<string>();
    const files = new Set<string>();

    for (const target of manifest.identifiedTargets) {
      if (target.origin === "file") {
        const decision = deps.policy.checkFile(root, target.qualifiedName);
        if (!decision.allowed) {
          throw new CausorynToolError(
            "PATH_DENIED",
            `preflight target file is not authorized: ${target.qualifiedName}${decision.reason ? ` (${decision.reason})` : ""}`,
          );
        }
        files.add(decision.relativePath ?? target.qualifiedName);
      } else {
        symbols.add(snapshotNodeIds.has(target.nodeId) ? target.nodeId : target.qualifiedName);
      }
    }
    for (const unresolved of manifest.candidateTargets) {
      symbols.add(unresolved.target);
    }

    const sortedSymbols = [...symbols].sort();
    const sortedFiles = [...files].sort();
    if (sortedSymbols.length === 0 && sortedFiles.length === 0) {
      throw new CausorynToolError(
        "INVALID_ARGUMENT",
        `preflightId ${input.preflightId} contains no target symbols or files to derive a test plan from`,
      );
    }
    resolvedChangedSymbols = sortedSymbols.length > 0 ? sortedSymbols : undefined;
    resolvedChangedFiles = sortedFiles.length > 0 ? sortedFiles : undefined;
  }

  const plan = runDifferentiation(deps.logger, () =>
    deriveTestPlanCore(read.snapshot, {
      ...(resolvedChangedSymbols === undefined ? {} : { changedSymbols: resolvedChangedSymbols }),
      ...(resolvedChangedFiles === undefined ? {} : { changedFiles: resolvedChangedFiles }),
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
      ...(input.maxCandidates === undefined ? {} : { maxCandidates: input.maxCandidates }),
    }),
  );

  const warnings = staleWarningOf(read);
  if (plan.truncated) {
    warnings.push(
      `test plan truncated by limits (${plan.truncatedBy.join(", ")}); more candidates may exist (raise the limits; ceilings are set by the resource budget)`,
    );
  }

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: read.snapshot.meta.id,
    status: envelopeStatusOf(read),
    coverage: coverageOf(read.snapshot),
    warnings,
    data: testPlanDataOf(plan),
  });
}

/* ------------------------------------------------------------------ */
/* D4 — causoryn_preflight_change                                      */
/* ------------------------------------------------------------------ */

export const PreflightChangeInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** TŞ §10.2 "intent" — zorunlu; yalnızca etiket normalizasyonuna girer. */
  intent: z.string().min(1),
  /** TŞ §10.2 "targetSymbols?": node kimliği veya TAM qualifiedName. */
  targetSymbols: z.array(z.string().min(1)).min(1).optional(),
  /** TŞ §10.2 "files?": kök-göreceli dosya hedefleri (policy ile yetkilenir). */
  targetFiles: z.array(z.string().min(1)).min(1).optional(),
  /** TŞ §10.2 "baseSnapshot?": manifest tabanı; yoksa en son yayınlanmış. */
  baseSnapshot: z.string().min(1).optional(),
  /** TŞ §10.3 örneği: includeContracts/includeTestPlan (default: katılır). */
  includeContracts: z.boolean().optional(),
  includeTestPlan: z.boolean().optional(),
  /** §10.3 örneğindeki maxDepth + TŞ §20 impact passthrough sınırları. */
  maxDepth: z.number().int().positive().optional(),
  maxPaths: z.number().int().positive().optional(),
  maxNodes: z.number().int().positive().optional(),
  maxDisambiguationCandidates: z.number().int().positive().optional(),
});

const PreflightManifestDataSchema = z.strictObject({
  preflightId: z.string().regex(/^preflight:[0-9a-f]{64}$/),
  baseSnapshotId: z.string(),
  intentLabel: z.string(),
  candidateOnly: z.literal(true),
  identifiedTargets: z.array(
    z.strictObject({
      nodeId: z.string(),
      kind: z.string(),
      qualifiedName: z.string(),
      origin: z.enum(["symbol", "file"]),
    }),
  ),
  impactCandidates: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.string(),
      qualifiedName: z.string(),
      certainty: z.enum(["direct", "indirect", "possible"]),
      resolution: z.enum(["verified", "heuristic", "unresolved"]),
      minDepth: z.number().int().nonnegative(),
      pathCount: z.number().int().nonnegative(),
      pathEvidenceIds: z.array(z.string()),
      targetNodeIds: z.array(z.string()),
    }),
  ),
  contractChecks: z.array(
    z.strictObject({
      contractId: z.string(),
      status: z.enum(["at_risk", "backward_safe", "unknown"]),
      classification: ContractClassificationSchema,
      summary: z.string().optional(),
    }),
  ),
  testPlanId: z.string().optional(),
  requiresDisambiguation: z.boolean(),
  candidateTargets: z.array(
    z.strictObject({
      target: z.string(),
      reason: z.string(),
      candidates: z.array(
        z.strictObject({
          nodeId: z.string(),
          kind: z.string(),
          qualifiedName: z.string(),
          matchBasis: z.enum(["exact-name", "suffix-segment"]),
        }),
      ),
    }),
  ),
  limitations: z.array(z.string()),
  sourceRevision: z
    .strictObject({
      kind: z.literal("working-tree"),
      head: z.string(),
      dirty: z.boolean().optional(),
    })
    .optional(),
});

export const PreflightChangeDataSchema = PreflightManifestDataSchema.extend({
  /** testPlanId'nin referansı: gömülü D6 planı (includeTestPlan=false → null). */
  testPlan: TestPlanDataSchema.nullable(),
});

/**
 * causoryn_preflight_change (TŞ §10.2/§10.3; sprint-5 D4): intent + hedef
 * kümesinden ADAY Preflight Manifest üretir. KOD YAZMAZ — candidateOnly
 * sabit true'dur ve manifest yanıt gövdesinde döner ve süreç-içi
 * PreflightManifestStore'da (bellek-içi, FIFO 200; diske yazmaz) tutulur
 * (kaynak ağacına hiçbir yazma yoktur; red çizgisi 2). Bileşim: analyzeImpact (packages/
 * graph) → impactCandidates; D6 deriveTestPlan → testPlanId + gömülü plan;
 * resolveSourceRevision (salt-okunur dosya okuması, komut çalıştırma yok) →
 * sourceRevision; hedef dosyalar WorkspaceAccessPolicy.checkFile kararı
 * olmadan KULLANILMAZ (fail-closed). Sembole bağlanamayan hedef
 * requiresDisambiguation + candidateTargets ile raporlanır; otomatik
 * kesinleştirme YOKTUR (TŞ §10.3).
 *
 * contractChecks bu dilimde Motor İÇİNDEN türetilemez (preflight girdisinde
 * sözleşme sürüm çifti yoktur; D2/D3 sürüm çiftlerini açık girdiyle alır) —
 * boş geçildiği dürüst limitation ile raporlanır; istemciden contract check
 * kaydı KABUL EDİLMEZ (host modelin sınıflama enjeksiyonu engellenir:
 * "Server yalnızca statik delili ifade eder", TŞ §11).
 */
export async function preflightChange(
  deps: VerificationServiceDeps,
  requestId: string,
  input: z.infer<typeof PreflightChangeInputSchema>,
): Promise<Envelope> {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  const root = requireAuthorizedWorkspace(deps, workspaceId);
  const read =
    input.baseSnapshot === undefined
      ? requireSnapshot(deps, workspaceId)
      : resolveEnvelopeSnapshot(deps, workspaceId, input.baseSnapshot);

  // sourceRevision: SALT-OKUNUR dosya okumasıyla HEAD çözümü (komut
  // çalıştırma YOK — kırmızı çizgi 3'ün en katı yorumu). Git'siz workspace
  // hata DEĞİLDİR: limitation ile manifest üretilir.
  const revision = await resolveSourceRevision(root);

  const hostLimitations: string[] = [...revision.limitations];
  let plan: TestPlanResult | undefined;
  if (input.includeTestPlan !== false) {
    // D6 planı manifest'in testPlanId referansının GERÇEK karşılığıdır.
    plan = runDifferentiation(deps.logger, () =>
      deriveTestPlanCore(read.snapshot, {
        ...(input.targetSymbols === undefined ? {} : { changedSymbols: input.targetSymbols }),
        ...(input.targetFiles === undefined ? {} : { changedFiles: input.targetFiles }),
      }),
    );
  } else {
    hostLimitations.push(
      "test plan not derived (includeTestPlan=false); no testPlanId is attached to the manifest",
    );
  }
  if (input.includeContracts === false) {
    hostLimitations.push(
      "contract check not requested (includeContracts=false); contractChecks left empty",
    );
  } else {
    // Dürüst boşluk: sözleşme denetimi kaydı için D2/D3 sürüm çifti girdisi
    // gerekir; preflight girdisi taşımadığından kayıt ÜRETİLMEZ (uydurma yok).
    hostLimitations.push(
      "no contract check record derived: the preflight input has no contract version pair (contractChecks is empty; use causoryn_check_contracts or causoryn_detect_contract_drift to evaluate contracts)",
    );
  }

  const manifest: PreflightManifest = runDifferentiation(deps.logger, () =>
    buildPreflightManifest(read.snapshot, {
      intent: input.intent,
      ...(input.targetSymbols === undefined ? {} : { targetSymbols: input.targetSymbols }),
      ...(input.targetFiles === undefined ? {} : { targetFiles: input.targetFiles }),
      // exactOptionalPropertyTypes: explicit undefined geçilemez — alan
      // verilmemişse özellik HİÇ yazılmaz (TŞ §10.3 örneği default'ları
      // çekirdekte: includeContracts/includeTestPlan varsayılan katılır).
      ...(input.includeContracts === undefined ? {} : { includeContracts: input.includeContracts }),
      ...(input.includeTestPlan === undefined ? {} : { includeTestPlan: input.includeTestPlan }),
      // Sözleşme denetimi kaydı yalnızca Motor'dan gelir; istemci
      // sınıflaması kabul edilmez (bu dilimde motor kaydı da yoktur —
      // yukarıdaki limitation notunun karşılığı).
      contractChecks: [],
      ...(plan === undefined ? {} : { testPlanId: testPlanIdOf(plan) }),
      limitations: hostLimitations,
      ...(revision.sourceRevision === undefined ? {} : { sourceRevision: revision.sourceRevision }),
      impactLimits: {
        ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
        ...(input.maxPaths === undefined ? {} : { maxPaths: input.maxPaths }),
        ...(input.maxNodes === undefined ? {} : { maxNodes: input.maxNodes }),
      },
      ...(input.maxDisambiguationCandidates === undefined
        ? {}
        : { maxDisambiguationCandidates: input.maxDisambiguationCandidates }),
      // Dosya yetkilendirmesi: WorkspaceAccessPolicy kararı fail-closed
      // çekirdeğe enjekte edilir (red kararı manifest'i DÜŞÜRÜR).
      authorizeFile: (file) => {
        const decision = deps.policy.checkFile(root, file);
        return decision.allowed
          ? {
              allowed: true,
              ...(decision.relativePath === undefined ? {} : { relativePath: decision.relativePath }),
            }
          : {
              allowed: false,
              ...(decision.code === undefined ? {} : { code: decision.code }),
              ...(decision.reason === undefined ? {} : { reason: decision.reason }),
            };
      },
    }),
  );

  // Sprint-6 Faz E: manifest süreç-içi PreflightManifestStore'a kaydedilir
  // (preflightId çözümünün kaynağı — causoryn_verify_change). Yanıt gövdesi
  // davranışı DEĞİŞMEZ: manifest yine yalnızca yanıt + depo; kaynak ağaca/
  // veri köküne yazma yoktur (deps.preflightStore eski ServiceDeps
  // gerçekleyen testlerde undefined olabilir — opsiyonel, sessiz geçilir).
  deps.preflightStore?.put(manifest);

  const warnings = staleWarningOf(read);
  if (manifest.requiresDisambiguation) {
    warnings.push(
      `${String(manifest.candidateTargets.length)} target(s) could not be linked to a single symbol; candidateTargets are only candidates and are not resolved automatically`,
    );
  }

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: read.snapshot.meta.id,
    status: envelopeStatusOf(read),
    coverage: coverageOf(read.snapshot),
    warnings,
    data: {
      preflightId: manifest.preflightId,
      baseSnapshotId: manifest.baseSnapshotId,
      intentLabel: manifest.intentLabel,
      candidateOnly: manifest.candidateOnly,
      identifiedTargets: manifest.identifiedTargets.map((target) => ({ ...target })),
      impactCandidates: manifest.impactCandidates.map((candidate) => ({
        ...candidate,
        pathEvidenceIds: [...candidate.pathEvidenceIds],
        targetNodeIds: [...candidate.targetNodeIds],
      })),
      contractChecks: manifest.contractChecks.map((check) => ({
        ...check,
        ...(check.summary === undefined ? {} : { summary: check.summary }),
      })),
      ...(manifest.testPlanId === undefined ? {} : { testPlanId: manifest.testPlanId }),
      requiresDisambiguation: manifest.requiresDisambiguation,
      candidateTargets: manifest.candidateTargets.map((entry) => ({
        target: entry.target,
        reason: entry.reason,
        candidates: entry.candidates.map((candidate) => ({ ...candidate })),
      })),
      limitations: [...manifest.limitations],
      ...(manifest.sourceRevision === undefined
        ? {}
        : {
            sourceRevision: {
              kind: manifest.sourceRevision.kind,
              head: manifest.sourceRevision.head,
              ...(manifest.sourceRevision.dirty === undefined ? {} : { dirty: manifest.sourceRevision.dirty }),
            },
          }),
      testPlan: plan === undefined ? null : testPlanDataOf(plan),
    },
  });
}

/* ------------------------------------------------------------------ */
/* D5 — causoryn_trace_business_flow                                   */
/* ------------------------------------------------------------------ */

export const TraceBusinessFlowInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** TŞ §10.2 "flowSeed": node kimliği veya TAM qualifiedName. */
  flowSeed: z.string().min(1),
  /** TŞ §10.2 "boundaries?": BUSINESS_FLOW_EDGE_KINDS boş olmayan alt kümesi. */
  boundaries: z.enum(FLOW_BOUNDARIES).array().min(1).optional(),
  /** TŞ §10.2 "maxHops" + TŞ §20 maxFlows/maxNodes (tavanlar çekirdekte). */
  maxHops: z.number().int().positive().optional(),
  maxFlows: z.number().int().positive().optional(),
  maxNodes: z.number().int().positive().optional(),
});

const FlowNodeRefSchema = z.strictObject({
  nodeId: z.string(),
  kind: z.string(),
  qualifiedName: z.string(),
});

const FlowEdgeRefSchema = z.strictObject({
  edgeId: z.string(),
  kind: z.string(),
  from: z.string(),
  to: z.string(),
  direction: z.enum(["forward", "reverse"]),
  evidenceIds: z.array(z.string()),
});

const FlowSegmentSchema = z.strictObject({
  segmentId: z.string(),
  certainty: z.enum(["verified", "heuristic", "possible", "gap"]),
  resolution: z.enum(["verified", "heuristic", "unresolved"]).nullable(),
  edge: FlowEdgeRefSchema.nullable(),
  from: FlowNodeRefSchema,
  to: FlowNodeRefSchema.nullable(),
  reason: z.string().optional(),
});

const FlowTraceSchema = z.strictObject({
  flowId: z.string(),
  seedNodeId: z.string(),
  chainKinds: z.array(z.enum(["request", "event"])),
  hopCount: z.number().int().nonnegative(),
  certainty: z.enum(["verified", "heuristic", "possible", "gap"]),
  resolution: z.enum(["verified", "heuristic", "unresolved"]).nullable(),
  hasGap: z.boolean(),
  truncated: z.boolean(),
  truncatedBy: z.array(z.enum(["maxHops", "maxFlows", "maxNodes"])),
  terminalNode: FlowNodeRefSchema,
  segments: z.array(FlowSegmentSchema),
  evidenceIds: z.array(z.string()),
});

export const TraceBusinessFlowDataSchema = z.strictObject({
  workspaceId: z.string(),
  snapshotId: z.string(),
  seed: FlowNodeRefSchema.nullable(),
  unresolvedSeed: z.strictObject({ seed: z.string(), reason: z.string() }).nullable(),
  flows: z.array(FlowTraceSchema),
  summary: z.strictObject({
    totalFlows: z.number().int().nonnegative(),
    segmentCounts: z.strictObject({
      verified: z.number().int().nonnegative(),
      heuristic: z.number().int().nonnegative(),
      possible: z.number().int().nonnegative(),
      gap: z.number().int().nonnegative(),
    }),
  }),
  truncated: z.boolean(),
  truncatedBy: z.array(z.enum(["maxHops", "maxFlows", "maxNodes"])),
  limits: z.strictObject({
    maxHops: z.number().int().positive(),
    maxFlows: z.number().int().positive(),
    maxNodes: z.number().int().positive(),
  }),
  rationales: z.array(z.string()),
});

function flowTraceOf(flow: FlowTrace): z.infer<typeof FlowTraceSchema> {
  return {
    flowId: flow.flowId,
    seedNodeId: flow.seedNodeId,
    chainKinds: [...flow.chainKinds],
    hopCount: flow.hopCount,
    certainty: flow.certainty,
    resolution: flow.resolution,
    hasGap: flow.hasGap,
    truncated: flow.truncated,
    truncatedBy: [...flow.truncatedBy],
    terminalNode: { ...flow.terminalNode },
    segments: flow.segments.map((segment) => ({
      segmentId: segment.segmentId,
      certainty: segment.certainty,
      resolution: segment.resolution,
      edge:
        segment.edge === null
          ? null
          : {
              edgeId: segment.edge.edgeId,
              kind: segment.edge.kind,
              from: segment.edge.from,
              to: segment.edge.to,
              direction: segment.edge.direction,
              evidenceIds: [...segment.edge.evidenceIds],
            },
      from: { ...segment.from },
      to: segment.to === null ? null : { ...segment.to },
      ...(segment.reason === undefined ? {} : { reason: segment.reason }),
    })),
    evidenceIds: [...flow.evidenceIds],
  };
}

/**
 * causoryn_trace_business_flow (TŞ §10.2 "Cross-component Business Flow";
 * §14; sprint-5 D5): flowSeed'den iş akışı zincirlerini — ROUTES_TO/CALLS/
 * PRODUCES_CONTRACT/CONSUMES_CONTRACT/CONTAINS kenarları üzerinde bounded
 * BFS + kontrat node'larında ters yön izleme — FlowSegment[] olarak üretir.
 * Her segment kendi certainty/resolution'ını taşır; kopukluklar uydurma
 * köprüyle DEĞİL gap segmentiyle raporlanır (status partial). Seed çözümleme
 * get_symbol_context/trace_execution sözleşmesiyle aynıdır: belirsiz ad
 * AMBIGUOUS_SYMBOL + adaylar, bilinmeyen ad SYMBOL_NOT_FOUND.
 */
export function traceBusinessFlow(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof TraceBusinessFlowInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);
  const read = requireSnapshot(deps, workspaceId);
  const snapshot = read.snapshot;

  // Seed çözümleme: MCP yüzeyi ortak sözleşme (SYMBOL_NOT_FOUND /
  // AMBIGUOUS_SYMBOL + adaylar); çözülen NODE KİMLİĞİ çekirdeğe verilir —
  // çekirdeğin kendi unresolvedSeed yolu id girdisinde imkânsızdır.
  const seed = resolveSymbolNode(snapshot, input.flowSeed);

  const result = runDifferentiation(deps.logger, () =>
    traceBusinessFlowCore(snapshot, {
      flowSeed: seed.id,
      ...(input.boundaries === undefined ? {} : { boundaries: input.boundaries }),
      ...(input.maxHops === undefined ? {} : { maxHops: input.maxHops }),
      ...(input.maxFlows === undefined ? {} : { maxFlows: input.maxFlows }),
      ...(input.maxNodes === undefined ? {} : { maxNodes: input.maxNodes }),
    }),
  );

  const warnings = staleWarningOf(read);
  const gapFlowCount = result.flows.filter((flow) => flow.hasGap).length;
  if (gapFlowCount > 0) {
    warnings.push(
      `${String(gapFlowCount)} flow(s) contain a gap segment: the exact flow is unknown because of runtime feature flags, reflection, dynamic dispatch, or missing edges; the break is reported as a gap segment, NOT bridged with a guessed edge`,
    );
  }
  if (result.truncated) {
    warnings.push(
      `flow discovery truncated by limits (${result.truncatedBy.join(", ")}); more flows may exist (raise the limits; ceilings are set by the resource budget)`,
    );
  }

  const status: "ok" | "partial" =
    read.snapshot.meta.state === "partial" || result.truncated || gapFlowCount > 0
      ? "partial"
      : "ok";

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: snapshot.meta.id,
    status,
    coverage: coverageOf(snapshot),
    warnings,
    data: {
      workspaceId,
      snapshotId: snapshot.meta.id,
      seed:
        result.seed === null
          ? null
          : {
              nodeId: result.seed.nodeId,
              kind: result.seed.kind,
              qualifiedName: result.seed.qualifiedName,
            },
      unresolvedSeed:
        result.unresolvedSeed === null
          ? null
          : { seed: result.unresolvedSeed.seed, reason: result.unresolvedSeed.reason },
      flows: result.flows.map(flowTraceOf),
      summary: {
        totalFlows: result.summary.totalFlows,
        segmentCounts: { ...result.summary.segmentCounts },
      },
      truncated: result.truncated,
      truncatedBy: [...result.truncatedBy],
      limits: { ...result.limits },
      rationales: [...result.rationales],
    },
  });
}

/* ------------------------------------------------------------------ */
/* Kullanılan sabit kodlar (errors.ts alt kümesi; yeni uzantı YOK)     */
/* ------------------------------------------------------------------ */

/** Bu dilimde kullanılan sabit kodlar (CONTRACT_PARSE_FAILED TŞ §10.1 sabit
 * kodunun İLK kullanımıdır; bkz. errors.ts başlığındaki kod notu). */
export const DIFFERENTIATION_TOOL_ERROR_CODES_USED: readonly CausorynToolErrorCode[] = [
  "WORKSPACE_NOT_AUTHORIZED",
  "PATH_DENIED",
  "INDEX_NOT_READY",
  "AMBIGUOUS_SYMBOL",
  "LIMIT_EXCEEDED",
  "INVALID_ARGUMENT",
  "SYMBOL_NOT_FOUND",
  "INVALID_REVISION",
  "CONTRACT_PARSE_FAILED",
  "INTERNAL_ERROR",
];
