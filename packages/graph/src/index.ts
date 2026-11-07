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
// Business Flow çekirdeği — sprint-5 D5 (TŞ §14). Saf motordur; MCP zarfı
// mcp-server katmanındadır. Paket girişi yüzeyi analyzeImpact kardeş
// düzeniyle bire bir (takım denetimi bulgusu 3: export yüzeyi zorunludur).
export {
  BUSINESS_FLOW_EDGE_KINDS,
  FLOW_LIMIT_CEILINGS,
  traceBusinessFlow,
} from "./business-flow.js";
export type {
  FlowAppliedLimits,
  FlowCertainty,
  FlowChainKind,
  FlowEdgeDirection,
  FlowEdgeRef,
  FlowNodeRef,
  FlowSeedRef,
  FlowSegment,
  FlowSegmentCounts,
  FlowTrace,
  FlowTruncatedBy,
  FlowUnresolvedSeed,
  TraceBusinessFlowInput,
  TraceBusinessFlowResult,
} from "./business-flow.js";
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
// Agent GPS çekirdeği — sprint-3 C4 (TŞ §15). Paket girişi yüzeyi C8 aracı
// kaydı için zorunludur; generateOnboarding (index.ts:25) ve analyzeImpact
// (index.ts:40) kardeş düzeniyle bire bir (denetim bulgusu 1).
export {
  AGENT_CONTEXT_LIMIT_CEILINGS,
  generateAgentContext,
} from "./agent-context.js";
export type {
  AgentContextAppliedLimits,
  AgentContextInput,
  AgentContextItem,
  AgentContextLeg,
  AgentContextResult,
  AgentContextScores,
  DegradedLeg,
  FileFreshness,
} from "./agent-context.js";
// Documentation export çekirdeği — sprint-3 C6 (TŞ §16). SAF serializer'lar
// (json/markdown/mermaid/html) + OutputAccessPolicy ile yetkilendirilmiş
// atomik yazma katmanı; MCP zarfı mcp-server katmanındadır (C8 kaydı).
export {
  EXPORT_DEFAULT_FILE_NAMES,
  EXPORT_DOCUMENTATION_FORMATS,
  exportDocumentationFormatSchema,
  serializeDocumentation,
  serializeDocumentationHtml,
  serializeDocumentationJson,
  serializeDocumentationMarkdown,
  serializeDocumentationMermaid,
  writeDocumentation,
} from "./export.js";
export type {
  ExportDocumentationFormat,
  WriteDocumentationInput,
  WriteDocumentationResult,
} from "./export.js";
// Architecture Timeline çekirdeği — sprint-3 C7 (TŞ §13). Saf motor +
// salt-okunur git spawn katmanı; MCP zarfı mcp-server katmanındadır.
// Paket yüzeyi compare/impact/guard/agent-context kardeş düzeniyle bire bir.
export {
  TIMELINE_CEILINGS,
  TIMELINE_DEFAULTS,
  TIMELINE_SNAPSHOT_BLOB_PATH,
  buildArchitectureTimeline,
  buildArchitectureTimelineFromGit,
  readTimelinePointFromGit,
  selectSampledIndices,
  serializeSnapshotContentSet,
} from "./timeline.js";
export type {
  ArchitectureTimeline,
  ArchitectureTimelinePoint,
  BuildArchitectureTimelineInput,
  TimelineChangeSummary,
  TimelineDiffInterval,
  TimelineGitInput,
  TimelineInterval,
  TimelineLimits,
  TimelinePointContent,
  TimelinePointInput,
  TimelineSamplingReport,
  TimelineUnanalyzedInterval,
} from "./timeline.js";
