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
export {
  analyzeImpact,
  DEFAULT_IMPACT_EDGE_KINDS,
  IMPACT_LIMIT_CEILINGS,
  MAX_IMPACT_EDGE_EVIDENCE_IDS,
  MAX_IMPACT_PATH_EVIDENCE_IDS,
} from "./impact.js";
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
  GIT_DEV_NULL,
  readGitBlob,
  readGitTree,
  resolveGitCommitRef,
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
  PruneSnapshotsResult,
  PublishableState,
  SnapshotBuildInfo,
  SnapshotBuildInput,
  SnapshotMetaSummary,
  SnapshotRead,
  SymbolIndexEntry,
  SymbolSearchHit,
  SymbolSearchStore,
  WorkspaceLanguageCoverageMeta,
  WorkspaceRecord,
  WorkspaceSummaryMeta,
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
// Evidence zinciri çekirdeği — sprint-6 E4 (TŞ §16 "selection → get_evidence
// → kaynak dosya/satır"). SAF helper; MCP zarfı mcp-server katmanındadır
// (kardeş düzen: findViolations exportu + C8 aracı kaydı ilkesi).
export { buildEvidenceChain, resolveFindingById } from "./evidence-chain.js";
export type {
  EvidenceChain,
  EvidenceChainContextRef,
  EvidenceChainLocation,
  EvidenceChainRecord,
  EvidenceChainTarget,
  FindingChainRef,
  ResolveFindingInput,
} from "./evidence-chain.js";
// Agent GPS çekirdeği — sprint-3 C4 (TŞ §15). Paket girişi yüzeyi C8 aracı
// kaydı için zorunludur; generateOnboarding (index.ts:25) ve analyzeImpact
// (index.ts:40) kardeş düzeniyle bire bir (denetim bulgusu 1).
export {
  AGENT_CONTEXT_CONTRACT_NODE_KINDS,
  AGENT_CONTEXT_LIMIT_CEILINGS,
  generateAgentContext,
} from "./agent-context.js";
export {
  buildSafeFts5OrQuery,
  buildSymbolFtsDocument,
  tokenizeSymbolText,
} from "./symbol-tokens.js";
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
// Documentation export çekirdeği — sprint-3 C6 (TŞ §16) + K-020 snapshot formatı. SAF serializer'lar
// (json/markdown/mermaid/html/snapshot) + OutputAccessPolicy ile yetkilendirilmiş
// atomik yazma katmanı; MCP zarfı mcp-server katmanındadır (C8 kaydı).
export {
  EXPORT_DEFAULT_FILE_NAMES,
  EXPORT_DOCUMENTATION_FORMATS,
  EXPORT_INTERACTIVE_HTML_FILE_NAME,
  exportDocumentationFormatSchema,
  serializeDocumentation,
  serializeDocumentationHtml,
  serializeDocumentationJson,
  serializeDocumentationMarkdown,
  serializeDocumentationMermaid,
  serializeDocumentationSnapshot,
  writeDocumentation,
} from "./export.js";
export type {
  ExportDocumentationFormat,
  WriteDocumentationArchitectureSummary,
  WriteDocumentationInput,
  WriteDocumentationResult,
} from "./export.js";
// Mimari görsel projeksiyon, katmanlı SVG yerleşim, Host-LLM anotasyonları ve portal export'ları (v0.2.2)
export {
  ANNOTATION_LIMITS,
  ArchitectureAnnotationsSchema,
  ArchitectureDecisionAnnotationSchema,
  ArchitectureDomainAnnotationSchema,
  ArchitectureFlowAnnotationSchema,
  ArchitectureFlowStepAnnotationSchema,
  ArchitectureGuidedTourStepSchema,
  ArchitectureModuleNoteAnnotationSchema,
  ArchitectureRiskAnnotationSchema,
  MAX_VALIDATION_ERRORS,
  validateArchitectureAnnotations,
} from "./architecture-annotations.js";
export type {
  ArchitectureAnnotations,
  ArchitectureDecisionAnnotation,
  ArchitectureDomainAnnotation,
  ArchitectureFlowAnnotation,
  ArchitectureGuidedTourStep,
  ArchitectureModuleNoteAnnotation,
  ArchitectureRiskAnnotation,
  ValidatedArchitectureAnnotations,
} from "./architecture-annotations.js";
export {
  ARCHITECTURE_DEFAULT_MAX_MODULES,
  ARCHITECTURE_MAX_MODULES,
  ARCHITECTURE_MIN_MODULES,
  ArchitectureProjectionOptionsSchema,
  projectArchitecture,
} from "./architecture-projection.js";
export type {
  ArchitectureProjection,
  ArchitectureProjectionOptions,
  ArchitectureSummaryStats,
  ExternalBoundarySummary,
  ExternalTargetSummary,
  ProjectedContract,
  ProjectedCycle,
  ProjectedEdgeKindCount,
  ProjectedEntrypoint,
  ProjectedEvidenceRecord,
  ProjectedFlow,
  ProjectedFlowStep,
  ProjectedLanguageCount,
  ProjectedModule,
  ProjectedModuleCounts,
  ProjectedModuleEdge,
  ProjectedResolutionCounts,
  ProjectedSymbolRef,
  RiskHotspot,
} from "./architecture-projection.js";
export {
  computeArchitectureLayout,
  renderArchitectureSvg,
  renderFlowStripSvg,
} from "./architecture-layout.js";
export type {
  ArchitectureSvgLayout,
  FlowStripStep,
  LayoutBand,
  PositionedModuleEdge,
  PositionedModuleNode,
  RenderArchitectureSvgOptions,
} from "./architecture-layout.js";
export {
  ARCHITECTURE_INTERACTIVE_CSP,
  ARCHITECTURE_ZERO_JS_CSP,
  EXPORT_DOCUMENTATION_VIEWS,
  exportDocumentationViewSchema,
  prepareArchitecture,
  serializeArchitectureHtml,
  serializeArchitectureJson,
  serializeArchitectureMarkdown,
  serializeArchitectureMermaid,
  serializeInteractiveArchitectureHtml,
} from "./architecture-export.js";
export type { ExportDocumentationView } from "./architecture-export.js";
// Architecture Timeline çekirdeği — sprint-3 C7 (TŞ §13) + sprint-6 E5 ihlal
// trendi. Saf motor + salt-okunur git spawn katmanı; MCP zarfı mcp-server
// katmanındadır. Paket yüzeyi compare/impact/guard/agent-context kardeş
// düzeniyle bire bir.
export {
  TIMELINE_BASELINE_BLOB_PATH,
  TIMELINE_CEILINGS,
  TIMELINE_DEFAULTS,
  TIMELINE_MAX_REFS,
  TIMELINE_POLICY_BLOB_PATH,
  TIMELINE_SNAPSHOT_BLOB_PATH,
  TIMELINE_TRUST_WARNING_COMMITTED_GIT_BLOB,
  buildArchitectureTimeline,
  buildArchitectureTimelineFromGit,
  buildTimelineViolationTrend,
  readTimelinePointFromGit,
  readTimelineTrendBaselineFromGit,
  readTimelineTrendPolicyFromGit,
  reconstructFileContentSetFromGitTree,
  selectSampledIndices,
  serializeSnapshotContentSet,
} from "./timeline.js";
export type {
  ArchitectureTimeline,
  ArchitectureTimelinePoint,
  ArchitectureTimelineWithTrend,
  BuildArchitectureTimelineInput,
  BuildTimelineViolationTrendInput,
  ReadTimelinePointOptions,
  TimelineChangeSummary,
  TimelineDiffInterval,
  TimelineGitInput,
  TimelineInterval,
  TimelineLimits,
  TimelinePointContent,
  TimelinePointInput,
  TimelineReconstructFromGitTree,
  TimelineSamplingReport,
  TimelineSnapshotLookup,
  TimelineTrendBaselineResult,
  TimelineTrendMetric,
  TimelineTrendPointEvaluation,
  TimelineTrendPointInput,
  TimelineTrendPolicyResult,
  TimelineTrendSeries,
  TimelineTrendSeriesValue,
  TimelineTrendStep,
  TimelineTrustWarning,
  TimelineUnanalyzedInterval,
  TimelineViolationTrend,
} from "./timeline.js";
