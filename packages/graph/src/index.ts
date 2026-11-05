/**
 * @causoryn/graph — Graph depo katmanı (Faz A dilimi, sprint-1 görev 5).
 *
 * GraphRepository sözleşmesi (TŞ v2.1 §8/§9, ADR-004/005): building →
 * ready/partial atomik snapshot yayımlama, stale bayrağı, dangling/ID
 * türetim denetimleri. Bellek içi gerçekleme referanstır; SQLite
 * gerçekleme `packages/storage-sqlite` altındadır. Snapshot okuma
 * sorguları/traversal bu paketin sonraki dilimlerinde gelir.
 */
export { GraphRepositoryError } from "./errors.js";
export { deriveBuildId } from "./build-id.js";
export type { BuildIdInput } from "./build-id.js";
export { finalizeSnapshotGraph } from "./finalize.js";
export type { BuildContent, SnapshotMetaInput } from "./finalize.js";
export {
  nodeIdentityRelativePath,
  requireNonEmptyField,
  requireTimestamp,
  validateEdgeIdentity,
  validateEdgeShape,
  validateEvidence,
  validateNode,
} from "./validation.js";
export { InMemoryGraphRepository } from "./memory-repository.js";
export { generateOnboarding } from "./onboarding.js";
export type {
  GenerateOnboardingInput,
  LearningStep,
  OnboardingCriticalFlow,
  OnboardingEntry,
  OnboardingLimits,
  OnboardingModuleStat,
  OnboardingProfile,
  OnboardingReport,
  OnboardingRiskArea,
  OnboardingTestEntry,
  OnboardingUnknownEdges,
  OnboardingWarning,
} from "./onboarding.js";
export { analyzeImpact, IMPACT_LIMIT_CEILINGS } from "./impact.js";
export type {
  AnalyzeImpactInput,
  ImpactAffectedNode,
  ImpactAppliedLimits,
  ImpactCertainty,
  ImpactEdgeRef,
  ImpactPath,
  ImpactResult,
  ImpactSummary,
  ImpactSummaryCell,
  ImpactTargetRef,
  ImpactTruncatedBy,
  ImpactUnresolvedTarget,
} from "./impact.js";
export {
  API_SURFACE_NODE_KINDS,
  compareIdentityKey,
  diffContentSets,
} from "./compare.js";
export type {
  ArchitectureDiff,
  CompareContentSet,
  CompareEdge,
  CompareNode,
  CompareNodeIdentity,
  EdgeChange,
  NodeChange,
  RenameComponents,
  RenameConfidence,
  RenameMatch,
  UncertainMatch,
} from "./compare.js";
export {
  assertValidBlobPath,
  assertValidGitRef,
  readGitBlob,
  readGitTree,
  runGit,
  WORKING_TREE_REF,
} from "./git-read.js";
export type {
  GitTreeEntry,
  GitTreeEntryType,
  ReadGitTreeOptions,
  RunGitOptions,
} from "./git-read.js";
export type {
  FileRecord,
  GraphRepository,
  PublishableState,
  SnapshotBuildInfo,
  SnapshotBuildInput,
  SnapshotRead,
  SymbolIndexEntry,
  SymbolSearchHit,
  SymbolSearchStore,
  WorkspaceRecord,
} from "./repository.js";
// Architecture Guard çekirdeği — sprint-3 C2 (TŞ §12). findViolations saf
// motordur; MCP zarfı mcp-server katmanındadır.
export {
  compileGuardGlob,
  GuardError,
  MAX_GLOB_LENGTH,
  MAX_GLOB_WILDCARDS,
  parseArchitectureBaseline,
  parseArchitecturePolicy,
} from "./guard-policy-schema.js";
export type {
  ArchitectureBaseline,
  ArchitecturePolicy,
  ArchitectureRule,
  ForbiddenDependencyRule,
  GuardGlob,
  GuardRuleType,
  GuardScope,
  GuardSeverity,
  NoCyclesRule,
  SuppressionEntry,
} from "./guard-policy-schema.js";
export { findOrphanSuppressions, findViolations } from "./guard.js";
export type {
  GuardFinding,
  GuardFindingSuppression,
} from "./guard.js";
