/**
 * @causoryn/preflight — Preflight çekirdeği (sprint-5 D6 dilimi).
 *
 * derive_test_plan: TESTS kenarları + test-dosyası isimlendirme bağlamı +
 * değişen CALLS noktalarından deterministik test adayları (TŞ v2.1 §15
 * Test Intelligence). Saf çekirdektir: saat okumaz, MCP türlerini import
 * etmez, çalıştırma iddiası üretmez; MCP zarfı packages/mcp-server
 * katmanındadır (D4 ile kabolanacaktır).
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
