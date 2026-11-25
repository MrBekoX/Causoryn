import { NODE_KINDS } from "@causoryn/domain";
import { EXPORT_DOCUMENTATION_FORMATS, TIMELINE_MAX_REFS } from "@causoryn/graph";
import { WikiLinkKindSchema, WikiPageKindSchema } from "@causoryn/wiki";
import { z } from "zod";

import { DIFFERENTIATION_TOOL_MAX_ITEMS } from "./services-differentiation.js";
import { WIKI_TOOL_MAX_LIMIT } from "./services-wiki.js";

/**
 * English-first, concise MCP tool input schemas.
 *
 * Every input property carries a crisp 1-line description so MCP hosts
 * understand all arguments cleanly within the <= 15,000 char core tools/list budget.
 *
 * Input bounds: every free-form string has a maxLength and every array a
 * maxItems (generous but finite), so one call cannot hand the server
 * unbounded input. Record-typed inputs bound their key count; their values
 * are validated by the tool handler. Integer limits keep their documented
 * clamp-with-warning behaviour in the services.
 */

/** Opaque identifiers: workspace, snapshot, preflight, job, node, page IDs and cursors. */
export const MAX_ID_LENGTH = 512;
/** Git refs (same bound as the git ref validator). */
export const MAX_GIT_REF_LENGTH = 200;
/** Filesystem paths and path prefixes. */
export const MAX_PATH_LENGTH = 4096;
/** Symbol names, search queries, entrypoints and short labels. */
export const MAX_QUERY_LENGTH = 1024;
/** Free-form text (planned change intent, agent task). */
export const MAX_TEXT_LENGTH = 8192;
/** Lists of symbols, files, kinds and keys. */
export const MAX_LIST_ITEMS = 200;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const OBSERVED_RUN_ARRAY_CEILING = 200;

/**
 * Opaque identifier copied from an earlier response. The JSON schema
 * advertises the upper bound (maxLength); non-emptiness is enforced by the
 * validator with the same semantics as min(1) but is not repeated as
 * `minLength` in tools/list, which keeps the core listing within its
 * 15,000-character budget.
 */
const id = () =>
  z
    .string()
    .max(MAX_ID_LENGTH)
    .refine((value) => value.length > 0, {
      message: "Too small: expected string to have >=1 characters",
    });
const gitRef = () => z.string().min(1).max(MAX_GIT_REF_LENGTH);
const filePath = () => z.string().min(1).max(MAX_PATH_LENGTH);
const query = () => z.string().min(1).max(MAX_QUERY_LENGTH);
const text = () => z.string().min(1).max(MAX_TEXT_LENGTH);

const nonBlankString = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, {
      message: "value must not be blank",
    });

/**
 * Map-shaped input with a bounded key count; keys and values are validated
 * by the tool handler. Expressed as a catch-all object (JSON object keys are
 * always strings), which validates exactly like z.record(z.string(), value).
 */
const boundedRecord = <V extends z.ZodType>(value: V, maxKeys: number) =>
  z
    .object({})
    .catchall(value)
    .refine((record) => Object.keys(record).length <= maxKeys, {
      message: `at most ${String(maxKeys)} keys`,
    });

const FLOW_BOUNDARIES = [
  "ROUTES_TO",
  "CALLS",
  "PRODUCES_CONTRACT",
  "CONSUMES_CONTRACT",
  "CONTAINS",
] as const;

const VERIFY_CHECKS = ["architecture", "contracts", "graph-diff", "test-plan"] as const;

/** Onboarding limit keys accepted by causoryn_map_system profile=onboarding. */
const ONBOARDING_LIMIT_KEY_COUNT = 4;
/** Fields of the observedTestRun record (validated by ObservedTestRunToolInputSchema). */
const OBSERVED_TEST_RUN_FIELD_COUNT = 8;

const workspaceIdField = () => id().optional().describe("Workspace ID.");

/* ------------------------------------------------------------------ */
/* Core 11 Consolidated Tool Schemas                                   */
/* ------------------------------------------------------------------ */

export const StatusToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  action: z
    .enum(["inspect", "refresh"])
    .optional()
    .describe("inspect (default) or refresh."),
  mode: z.enum(["incremental", "full"]).optional().describe("Refresh mode (default incremental)."),
  jobId: id().optional().describe("Job ID to inspect."),
  workspace: filePath().optional().describe("Workspace path to check."),
});

export const MapSystemToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  profile: z
    .enum(["default", "onboarding"])
    .optional()
    .describe("default map or onboarding report."),
  level: z.enum(["L0", "L1", "L2", "L3", "L4"]).optional().describe("Map level L0-L3 (default L2)."),
  filters: z
    .strictObject({
      kinds: z.array(query()).max(MAX_LIST_ITEMS).optional().describe("Graph node kinds."),
      pathPrefix: filePath().optional().describe("Relative POSIX path prefix."),
    })
    .optional()
    .describe("Map node filters."),
  maxNodes: z.number().int().positive().optional().describe("Max nodes per page."),
  cursor: id().optional().describe("Pagination cursor."),
  audience: z
    .enum(["beginner", "intermediate", "maintainer"])
    .optional()
    .describe("Onboarding audience (default maintainer)."),
  limits: boundedRecord(z.number().int().positive(), ONBOARDING_LIMIT_KEY_COUNT)
    .optional()
    .describe("Onboarding caps (entryPointLimit, topModuleCount, maxLearningSteps, maxCriticalFlows)."),
});

export const FindSymbolsToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  query: query().describe("Symbol name or substring."),
  kind: z.enum(NODE_KINDS).optional().describe("Node kind filter."),
  limit: z.number().int().positive().optional().describe("Max matches."),
});

export const GetSymbolContextToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  symbolId: query().describe("Node ID or exact qualifiedName."),
  edgeKinds: z.array(query()).max(MAX_LIST_ITEMS).optional().describe("Edge kinds filter."),
  depth: z.number().int().positive().optional().describe("Traversal depth (default 1)."),
});

export const TraceToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  mode: z
    .enum(["execution", "business-flow"])
    .optional()
    .describe("execution (default) or business-flow."),
  entrypoint: query().optional().describe("Start node ID, symbol, or endpoint."),
  flowSeed: query().optional().describe("Business-flow seed alias."),
  maxDepth: z.number().int().min(0).optional().describe("Max depth (default 6, clamped)."),
  maxPaths: z.number().int().min(0).optional().describe("Max paths (default 25, clamped)."),
  boundaries: z
    .enum(FLOW_BOUNDARIES)
    .array()
    .min(1)
    .max(FLOW_BOUNDARIES.length)
    .optional()
    .describe("Flow edge kinds."),
  maxHops: z.number().int().positive().optional().describe("Max flow hops."),
  maxFlows: z.number().int().positive().optional().describe("Max flows."),
  maxNodes: z.number().int().positive().optional().describe("Max visited nodes."),
});

export const GetAgentContextToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  task: text().describe("Task or symbol search query."),
  tokenBudget: z.number().int().positive().describe("Token budget for results."),
  maxProximityDepth: z.number().int().positive().optional().describe("Graph proximity depth."),
  candidateScope: query().optional().describe("Reserved scope (omit)."),
});

export const PreflightChangeCoreInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  intent: text().optional().describe("Planned change description."),
  targetSymbols: z
    .array(query())
    .min(1)
    .max(MAX_LIST_ITEMS)
    .optional()
    .describe("Target symbol IDs or names."),
  targetFiles: z
    .array(filePath())
    .min(1)
    .max(MAX_LIST_ITEMS)
    .optional()
    .describe("Target relative file paths."),
  include: z
    .array(z.enum(["impact", "test-plan"]))
    .min(1)
    .max(2)
    .optional()
    .describe("Focused sections: impact, test-plan."),
  baseSnapshot: id().optional().describe("Baseline snapshot ID."),
  preflightId: id().optional().describe("Existing preflight ID."),
  edgeKinds: z.array(query()).max(MAX_LIST_ITEMS).optional().describe("Impact edge kinds."),
  maxDepth: z.number().int().positive().optional().describe("Max traversal depth."),
  maxPaths: z.number().int().positive().optional().describe("Max impact paths."),
  maxNodes: z.number().int().positive().optional().describe("Max affected nodes."),
  maxCandidates: z.number().int().positive().optional().describe("Max test candidates."),
});

export const PreflightChangeToolInputSchema = PreflightChangeCoreInputSchema.extend({
  includeContracts: z.boolean().optional().describe("Include contract checks."),
  includeTestPlan: z.boolean().optional().describe("Include test plan."),
  maxDisambiguationCandidates: z.number().int().positive().optional().describe("Max suggestions."),
});

export const ObservedTestRunToolInputSchema = z.strictObject({
  state: z.enum(["observed", "host_asserted"]).describe("Host status (saved as host_asserted)."),
  evidenceRef: nonBlankString(MAX_PATH_LENGTH).describe("Test report reference."),
  evidenceSha256: z
    .string()
    .regex(SHA256_HEX, "evidenceSha256 must be a 64-character lowercase hex sha256")
    .max(64)
    .optional()
    .describe("Report SHA-256 hex."),
  evidenceIds: z
    .array(nonBlankString(MAX_ID_LENGTH))
    .min(1)
    .max(OBSERVED_RUN_ARRAY_CEILING)
    .optional()
    .describe("Supporting evidence IDs."),
  observedCount: z.number().int().min(1).describe("Reported test count."),
  passedCount: z.number().int().min(0).optional().describe("Reported passed count."),
  failedCount: z.number().int().min(0).optional().describe("Reported failed count."),
  testNames: z
    .array(nonBlankString(MAX_QUERY_LENGTH))
    .min(1)
    .max(OBSERVED_RUN_ARRAY_CEILING)
    .optional()
    .describe("Executed test names or IDs."),
});

export const VerifyChangeCoreInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  preflightId: id().optional().describe("Preflight manifest ID."),
  baseSnapshot: id().optional().describe("Baseline snapshot ID."),
  baseRef: gitRef().optional().describe("Trusted git ref for rules (default HEAD)."),
  targetRevision: z.literal("working-tree").optional().describe("Target revision (working-tree)."),
  checks: z
    .enum(VERIFY_CHECKS)
    .array()
    .min(1)
    .max(VERIFY_CHECKS.length)
    .optional()
    .describe("Checks (default architecture, graph-diff, test-plan)."),
  observedTestRun: boundedRecord(z.unknown(), OBSERVED_TEST_RUN_FIELD_COUNT)
    .optional()
    .describe("Host test run record ({state, evidenceRef, observedCount, passedCount?, failedCount?})."),
});

export const VerifyChangeToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  preflightId: id().optional().describe("Preflight manifest ID."),
  baseSnapshot: id().optional().describe("Baseline snapshot ID."),
  baseRef: gitRef().optional().describe("Trusted git ref for rules (default HEAD)."),
  targetRevision: z.literal("working-tree").optional().describe("Target revision (working-tree)."),
  checks: z
    .enum(VERIFY_CHECKS)
    .array()
    .min(1)
    .max(VERIFY_CHECKS.length)
    .optional()
    .describe("Checks (default architecture, graph-diff, test-plan)."),
  observedTestRun: ObservedTestRunToolInputSchema.optional().describe("Host test run record."),
});

const ContractPairSchema = z.strictObject({
  name: query().optional().describe("Pair label."),
  base: filePath().describe("Baseline spec path."),
  target: filePath().describe("Target spec path."),
});

export const ContractsToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  action: z.enum(["check", "drift"]).optional().describe("check (default) or drift."),
  contracts: z
    .array(ContractPairSchema)
    .min(1)
    .max(DIFFERENTIATION_TOOL_MAX_ITEMS)
    .optional()
    .describe("Contract pairs for check."),
  snapshotId: id().optional().describe("Snapshot ID anchor."),
  base: z.array(filePath()).min(1).max(DIFFERENTIATION_TOOL_MAX_ITEMS).optional().describe("Base spec paths."),
  target: z.array(filePath()).min(1).max(DIFFERENTIATION_TOOL_MAX_ITEMS).optional().describe("Target spec paths."),
  scope: z.array(query()).min(1).max(MAX_LIST_ITEMS).optional().describe("MatchKey filter."),
  anchorFiles: z
    .array(filePath())
    .min(1)
    .max(DIFFERENTIATION_TOOL_MAX_ITEMS)
    .optional()
    .describe("Anchor source files."),
});

export const GetEvidenceToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  id: id().describe("Node, edge, evidence, or finding ID."),
});

/**
 * Lean core wire schema for causoryn_export_documentation (<= 1,800 chars total tool entry).
 * Full fail-closed annotations validation still executes inside exportDocumentationTool.
 */
export const ExportDocumentationCoreInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  format: z.enum(EXPORT_DOCUMENTATION_FORMATS).describe("Output format."),
  outputDir: filePath().describe("Output dir (<slug>-<hash12>/exports)."),
  fileName: z.string().min(1).max(255).optional().describe("File name."),
  view: z.string().min(1).max(64).optional().describe("architecture, interactive, or full."),
  options: z
    .strictObject({
      maxModules: z.number().int().min(1).max(200).optional().describe("Max modules."),
      pathPrefix: z.string().min(1).max(260).optional().describe("Path prefix."),
      includeTests: z.boolean().optional().describe("Include tests (default true)."),
    })
    .optional()
    .describe("Projection options."),
  annotations: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Annotations JSON (see architecture-blueprint skill)."),
});

/* ------------------------------------------------------------------ */
/* Extension & Legacy Tool Schemas (wiki, history, full profiles)      */
/* ------------------------------------------------------------------ */

export const GetCapabilitiesToolInputSchema = z.strictObject({
  workspace: filePath().optional().describe("Workspace path to check."),
});

export const WorkspaceSummaryToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
});

export const IndexStatusToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  jobId: id().optional().describe("Job ID to inspect."),
});

export const RefreshIndexToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  mode: z.enum(["full", "incremental"]).describe("Indexing mode."),
  scope: filePath().optional().describe("Reserved scope (omit)."),
});

export const TraceExecutionToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  entrypoint: query().describe("Start node ID, symbol, or endpoint."),
  maxDepth: z.number().int().min(0).optional().describe("Max depth (default 6, clamped)."),
  maxPaths: z.number().int().min(0).optional().describe("Max paths (default 25, clamped)."),
});

export const TraceBusinessFlowToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  flowSeed: query().describe("Start node ID or exact qualifiedName."),
  boundaries: z
    .enum(FLOW_BOUNDARIES)
    .array()
    .min(1)
    .max(FLOW_BOUNDARIES.length)
    .optional()
    .describe("Flow edge kinds."),
  maxHops: z.number().int().positive().optional().describe("Max hops."),
  maxFlows: z.number().int().positive().optional().describe("Max flows."),
  maxNodes: z.number().int().positive().optional().describe("Max visited nodes."),
});

export const AnalyzeImpactToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  targets: z
    .array(query())
    .min(1)
    .max(MAX_LIST_ITEMS)
    .describe("Target node IDs or qualifiedNames."),
  depth: z.number().int().positive().optional().describe("Max traversal depth."),
  maxPaths: z.number().int().positive().optional().describe("Max impact paths."),
  maxNodes: z.number().int().positive().optional().describe("Max affected nodes."),
  edgeKinds: z.array(query()).max(MAX_LIST_ITEMS).optional().describe("Edge kinds filter."),
});

export const CheckArchitectureToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  policyId: id().optional().describe("Reserved policyId (omit)."),
  scope: filePath().optional().describe("Reserved scope (omit)."),
});

export const CompareArchitectureToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  baseRef: gitRef().describe("Baseline git ref or working-tree."),
  targetRef: gitRef().describe("Target git ref or working-tree."),
});

export const GenerateOnboardingToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  audience: z.enum(["beginner", "intermediate", "maintainer"]).describe("Onboarding audience."),
  focus: query().optional().describe("Reserved focus (omit)."),
  limits: z
    .strictObject({
      entryPointLimit: z.number().int().positive().optional().describe("Max entrypoints."),
      topModuleCount: z.number().int().positive().optional().describe("Max top modules."),
      maxLearningSteps: z.number().int().positive().optional().describe("Max learning steps."),
      maxCriticalFlows: z.number().int().positive().optional().describe("Max critical flows."),
    })
    .optional()
    .describe("Onboarding limits."),
});

export const CheckContractsToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  contracts: z
    .array(ContractPairSchema)
    .min(1)
    .max(DIFFERENTIATION_TOOL_MAX_ITEMS)
    .describe("Contract version pairs."),
  snapshotId: id().optional().describe("Snapshot ID anchor."),
});

export const DetectContractDriftToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  base: z.array(filePath()).min(1).max(DIFFERENTIATION_TOOL_MAX_ITEMS).describe("Base spec paths."),
  target: z.array(filePath()).min(1).max(DIFFERENTIATION_TOOL_MAX_ITEMS).describe("Target spec paths."),
  scope: z.array(query()).min(1).max(MAX_LIST_ITEMS).optional().describe("MatchKey filter."),
  anchorFiles: z
    .array(filePath())
    .min(1)
    .max(DIFFERENTIATION_TOOL_MAX_ITEMS)
    .optional()
    .describe("Anchor source files."),
});

export const DeriveTestPlanToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  changeSet: z
    .strictObject({
      changedSymbols: z
        .array(query())
        .min(1)
        .max(MAX_LIST_ITEMS)
        .optional()
        .describe("Changed symbols."),
      changedFiles: z
        .array(filePath())
        .min(1)
        .max(MAX_LIST_ITEMS)
        .optional()
        .describe("Changed file paths."),
    })
    .optional()
    .describe("Changed symbols or files."),
  preflightId: id().optional().describe("Preflight manifest ID."),
  maxDepth: z.number().int().positive().optional().describe("Max call-site depth."),
  maxCandidates: z.number().int().positive().optional().describe("Max test candidates."),
});

export const ArchitectureTimelineToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  refs: z
    .array(gitRef())
    .min(2)
    .max(TIMELINE_MAX_REFS)
    .optional()
    .describe("Explicit git refs list."),
  range: z
    .strictObject({
      from: gitRef().describe("Start git ref."),
      to: gitRef().describe("End git ref."),
    })
    .optional()
    .describe("Bounded git history range."),
  maxRevisions: z.number().int().min(2).optional().describe("Max sampled revisions."),
  maxRangeWalk: z.number().int().min(2).optional().describe("Max commits walked."),
  granularity: query().optional().describe("Reserved granularity (omit)."),
});

export const WikiBuildToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  mode: z.enum(["full", "incremental"]).describe("Wiki build mode."),
  scope: filePath().optional().describe("Reserved scope (omit)."),
  revision: query().optional().describe("Optional revision label."),
});

export const WikiGetTreeToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  snapshotId: id().optional().describe("WikiSnapshot ID."),
  parentId: id().optional().describe("Subtree root page ID."),
  depth: z.number().int().min(1).max(8).optional().describe("Subtree depth (1-8)."),
  limit: z.number().int().min(1).optional().describe("Page size (default 50, max 200)."),
  cursor: id().optional().describe("Pagination cursor."),
});

export const WikiGetPageToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  pageId: id().describe("Wiki page ID."),
  snapshotId: id().optional().describe("WikiSnapshot ID."),
  sections: z.array(query()).max(MAX_LIST_ITEMS).optional().describe("Section keys filter."),
  limit: z.number().int().min(1).optional().describe("Max sections per page."),
  cursor: id().optional().describe("Pagination cursor."),
});

export const WikiSearchToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  query: z.string().max(MAX_QUERY_LENGTH).describe("Full-text search query."),
  snapshotId: id().optional().describe("WikiSnapshot ID."),
  limit: z.number().int().min(1).optional().describe("Max results per page."),
  cursor: id().optional().describe("Pagination cursor."),
  kinds: z
    .array(WikiPageKindSchema)
    .max(MAX_LIST_ITEMS)
    .optional()
    .describe("Reserved kind filter (omit)."),
  scope: filePath().optional().describe("Reserved scope filter (omit)."),
  language: query().optional().describe("Reserved language filter (omit)."),
  revision: query().optional().describe("Reserved revision filter (omit)."),
  resolution: z.enum(["verified", "heuristic", "unresolved"]).optional().describe("Reserved resolution filter (omit)."),
});

export const WikiGetLinksToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  pageId: id().describe("Wiki page ID."),
  direction: z.enum(["incoming", "outgoing", "both"]).default("both").describe("Link direction."),
  linkKinds: z
    .array(WikiLinkKindSchema)
    .max(MAX_LIST_ITEMS)
    .optional()
    .describe("Link kinds filter."),
  snapshotId: id().optional().describe("WikiSnapshot ID."),
  limit: z.number().int().min(1).optional().describe("Max links per page."),
  cursor: id().optional().describe("Pagination cursor."),
});

export const WikiGetVersionsToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  pageId: id().optional().describe("Optional page ID."),
  refs: z.array(gitRef()).min(1).max(WIKI_TOOL_MAX_LIMIT).optional().describe("Git refs to resolve."),
  limit: z.number().int().min(1).optional().describe("Max entries per page."),
  cursor: id().optional().describe("Pagination cursor."),
});

export const WikiDiffToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  base: id().describe("Baseline WikiSnapshot ID or revision."),
  target: id().describe("Target WikiSnapshot ID or revision."),
  pageId: id().optional().describe("Single page ID filter."),
});
