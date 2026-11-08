/**
 * @causoryn/verification — verify_change çekirdeği (sprint-6 E1).
 *
 * causoryn_verify_change: preflightId (D4 manifesti, enjekte çözümleyiciden)
 * veya beyan edilen değişiklik kapsamı ↔ çalışma ağacı projeksiyonu
 * (targetSnapshot) karşılaştırması; architecture (C2 guard kuralları —
 * packages/graph findViolations), contracts (D2/D3 compatibility+drift
 * kayıtlarının sınıflama eşlemesi), graph-diff (packages/graph
 * diffContentSets) ve test-plan (packages/preflight deriveTestPlan)
 * denetimlerini taşıyan byte-deterministik rapor (TŞ v2.1 §10.4).
 *
 * Dürüstlük sözleşmesi: no_findings güvenli/kod garantisi değildir (her
 * raporda sabit verdictNote); test koşucusu çalıştırılmaz, `observed`
 * yalnızca kanıtla (evidenceIds/reportRef) kabul edilir — kanıtsız koşum
 * iddiası invalid-input ile reddedilir (TŞ §10.4/§15, Faz E kapısı).
 *
 * Saf çekirdektir: fs/thread/saat/rastgelelik okumaz, MCP türlerini import
 * etmez; çalışma ağacı WorkspaceAccessPolicy üzerinden üretilen
 * targetSnapshot olarak girer, kapsam dosyaları authorizeFile kararı
 * olmadan kullanılamaz (fail-closed). MCP zarfı packages/mcp-server
 * katmanındadır (E-diliminin MCP yüzey dilimi).
 */
export { VerificationError } from "./errors.js";
export type { VerificationErrorCode } from "./errors.js";

export {
  OBSERVED_TEST_RUN_SCHEMA,
  TEST_RUN_STATUS_SCHEMA,
  formatZodIssues,
} from "./test-status-schema.js";

export { verifyChange, serializeVerificationReport } from "./verify-change.js";

export {
  NO_FINDINGS_CORE_DISCLAIMER,
  NO_FINDINGS_DISCLAIMER,
  VERIFY_CHECK_NAMES,
  VERIFY_VERDICT_RULES,
} from "./types.js";
export type {
  ArchitectureCheckResult,
  ContractsCheckResult,
  GraphDiffCheckResult,
  ObservedTestRun,
  PreflightAlignment,
  PreflightAlignmentTarget,
  TestPlanCheckResult,
  VerificationReport,
  VerifyCheckName,
  VerifyChangeInput,
  VerifyCheckStatus,
  VerifyContractDriftEntry,
  VerifyFileAuthorizationDecision,
  VerifyFileAuthorizer,
  VerifyTargetRevision,
  VerifyTestCandidateStatus,
  VerifyTestStatus,
  VerifyVerdict,
  VerifyVerdictRule,
  VerifyVerdictRuleId,
} from "./types.js";
