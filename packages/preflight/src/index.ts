/**
 * @causoryn/preflight — Preflight çekirdeği (sprint-5 D6 + D4 dilimleri).
 *
 * D6 — derive_test_plan: TESTS kenarları + test-dosyası isimlendirme
 * bağlamı + değişen CALLS noktalarından deterministik test adayları
 * (TŞ v2.1 §15 Test Intelligence). Saf çekirdektir: saat okumaz, MCP
 * türlerini import etmez, çalıştırma iddiası üretmez; MCP zarfı
 * packages/mcp-server katmanındadır.
 *
 * D4 — build_preflight_manifest: intent + hedef kümesi → Preflight Manifest
 * birleştirme katmanı (TŞ v2.1 §10.2/§10.3). packages/graph analyzeImpact
 * çağrısıyla impactCandidates + certainty türetilir; D2/D3 sözleşme
 * değerlendirme kayıtları TŞ status sözlüğüne eşlenir; testPlanId (D6 çıktısı
 * referansı), limitations ve git-read salt-okunur sourceRevision birleştirilir.
 * Sembole bağlanamayan hedef requiresDisambiguation + aday listesiyle
 * raporlanır (otomatik kesinleştirme YOK). Manifest yalnızca ADAYDIR:
 * buildPreflightManifest hiçbir koşulda kod yazmaz/dosya değiştirmez
 * (candidateOnly sabit true; test manifest.test.ts ile kanıtlanır).
 */
export { PreflightError } from "./errors.js";
export {
  TEST_PLAN_DEFAULTS,
  TEST_PLAN_LIMIT_CEILINGS,
  deriveTestPlan,
} from "./test-plan.js";
export type {
  DeriveTestPlanInput,
  TestPlanAppliedLimits,
  TestPlanCandidate,
  TestPlanEdgeRef,
  TestPlanMatchLevel,
  TestPlanMissingCoverageCandidate,
  TestPlanResult,
  TestPlanSymbolRef,
  TestPlanSummary,
  TestPlanTruncatedBy,
  TestPlanUnresolvedSymbol,
} from "./test-plan.js";
export {
  buildPreflightManifest,
  PREFLIGHT_MANIFEST_DEFAULTS,
  PREFLIGHT_MANIFEST_LIMITS,
} from "./manifest.js";
export type {
  FileAuthorizationDecision,
  FileAuthorizer,
  PreflightContractCheck,
  PreflightContractCheckInput,
  PreflightContractClassification,
  PreflightContractStatus,
  PreflightDisambiguationCandidate,
  PreflightDisambiguationEntry,
  PreflightIdentifiedTarget,
  PreflightImpactCandidate,
  PreflightImpactLimits,
  PreflightManifest,
  PreflightManifestInput,
  PreflightSourceRevision,
} from "./manifest.js";
export { resolveSourceRevision } from "./source-revision.js";
export type { SourceRevisionResolution } from "./source-revision.js";
