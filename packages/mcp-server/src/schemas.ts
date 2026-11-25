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
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;
const OBSERVED_RUN_ARRAY_CEILING = 200;

const nonBlankString = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "value must not be blank",
  });

const FLOW_BOUNDARIES = [
  "ROUTES_TO",
  "CALLS",
  "PRODUCES_CONTRACT",
  "CONSUMES_CONTRACT",
  "CONTAINS",
] as const;

const workspaceIdField = () => z.string().min(1).optional().describe("Workspace ID.");

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
  jobId: z.string().min(1).optional().describe("Job ID to inspect."),
  workspace: z.string().min(1).optional().describe("Workspace path to check."),
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
      kinds: z.array(z.string().min(1)).optional().describe("Graph node kinds."),
      pathPrefix: z.string().min(1).optional().describe("Relative POSIX path prefix."),
    })
    .optional()
    .describe("Map node filters."),
  maxNodes: z.number().int().positive().optional().describe("Max nodes per page."),
  cursor: z.string().min(1).optional().describe("Pagination cursor."),
  audience: z
    .enum(["beginner", "intermediate", "maintainer"])
    .optional()
    .describe("Onboarding audience (default maintainer)."),
  limits: z
    .record(z.string(), z.number().int().positive())
    .optional()
    .describe("Onboarding caps (entryPointLimit, topModuleCount, maxLearningSteps, maxCriticalFlows)."),
});

export const FindSymbolsToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  query: z.string().min(1).describe("Symbol name or substring."),
  kind: z.enum(NODE_KINDS).optional().describe("Node kind filter."),
  limit: z.number().int().positive().optional().describe("Max matches."),
});

export const GetSymbolContextToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  symbolId: z.string().min(1).describe("Node ID or exact qualifiedName."),
  edgeKinds: z.array(z.string().min(1)).optional().describe("Edge kinds filter."),
  depth: z.number().int().positive().optional().describe("Traversal depth (default 1)."),
});

export const TraceToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  mode: z
    .enum(["execution", "business-flow"])
    .optional()
    .describe("execution (default) or business-flow."),
  entrypoint: z.string().min(1).optional().describe("Start node ID, symbol, or endpoint."),
  flowSeed: z.string().min(1).optional().describe("Business-flow seed alias."),
  maxDepth: z.number().int().min(0).optional().describe("Max depth (default 6, clamped)."),
  maxPaths: z.number().int().min(0).optional().describe("Max paths (default 25, clamped)."),
  boundaries: z.enum(FLOW_BOUNDARIES).array().min(1).optional().describe("Flow edge kinds."),
  maxHops: z.number().int().positive().optional().describe("Max flow hops."),
  maxFlows: z.number().int().positive().optional().describe("Max flows."),
  maxNodes: z.number().int().positive().optional().describe("Max visited nodes."),
});

export const GetAgentContextToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  task: z.string().min(1).describe("Task or symbol search query."),
  tokenBudget: z.number().int().positive().describe("Token budget for results."),
  maxProximityDepth: z.number().int().positive().optional().describe("Graph proximity depth."),
  candidateScope: z.string().min(1).optional().describe("Reserved scope (omit)."),
});

export const PreflightChangeCoreInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  intent: z.string().min(1).optional().describe("Planned change description."),
  targetSymbols: z.array(z.string().min(1)).min(1).optional().describe("Target symbol IDs or names."),
  targetFiles: z.array(z.string().min(1)).min(1).optional().describe("Target relative file paths."),
  include: z
    .array(z.enum(["impact", "test-plan"]))
    .min(1)
    .optional()
    .describe("Focused sections: impact, test-plan."),
  baseSnapshot: z.string().min(1).optional().describe("Baseline snapshot ID."),
  preflightId: z.string().min(1).optional().describe("Existing preflight ID."),
  edgeKinds: z.array(z.string().min(1)).optional().describe("Impact edge kinds."),
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
  evidenceRef: nonBlankString.describe("Test report reference."),
  evidenceSha256: z
    .string()
    .regex(SHA256_HEX, "evidenceSha256 must be a 64-character lowercase hex sha256")
    .optional()
    .describe("Report SHA-256 hex."),
  evidenceIds: z
    .array(nonBlankString)
    .min(1)
    .max(OBSERVED_RUN_ARRAY_CEILING)
    .optional()
    .describe("Supporting evidence IDs."),
  observedCount: z.number().int().min(1).describe("Reported test count."),
  passedCount: z.number().int().min(0).optional().describe("Reported passed count."),
  failedCount: z.number().int().min(0).optional().describe("Reported failed count."),
  testNames: z
    .array(nonBlankString)
    .min(1)
    .max(OBSERVED_RUN_ARRAY_CEILING)
    .optional()
    .describe("Executed test names or IDs."),
});

export const VerifyChangeCoreInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  preflightId: z.string().min(1).optional().describe("Preflight manifest ID."),
  baseSnapshot: z.string().min(1).optional().describe("Baseline snapshot ID."),
  baseRef: z.string().min(1).optional().describe("Trusted git ref for rules (default HEAD)."),
  targetRevision: z.literal("working-tree").optional().describe("Target revision (working-tree)."),
  checks: z
    .enum(["architecture", "contracts", "graph-diff", "test-plan"])
    .array()
    .min(1)
    .optional()
    .describe("Checks (default architecture, graph-diff, test-plan)."),
  observedTestRun: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Host test run record ({state, evidenceRef, observedCount, passedCount?, failedCount?})."),
});

export const VerifyChangeToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  preflightId: z.string().min(1).optional().describe("Preflight manifest ID."),
  baseSnapshot: z.string().min(1).optional().describe("Baseline snapshot ID."),
  baseRef: z.string().min(1).optional().describe("Trusted git ref for rules (default HEAD)."),
  targetRevision: z.literal("working-tree").optional().describe("Target revision (working-tree)."),
  checks: z
    .enum(["architecture", "contracts", "graph-diff", "test-plan"])
    .array()
    .min(1)
    .optional()
    .describe("Checks (default architecture, graph-diff, test-plan)."),
  observedTestRun: ObservedTestRunToolInputSchema.optional().describe("Host test run record."),
});

export const ContractsToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  action: z.enum(["check", "drift"]).optional().describe("check (default) or drift."),
  contracts: z
    .array(
      z.strictObject({
        name: z.string().min(1).optional().describe("Pair label."),
        base: z.string().min(1).describe("Baseline spec path."),
        target: z.string().min(1).describe("Target spec path."),
      }),
    )
    .min(1)
    .max(DIFFERENTIATION_TOOL_MAX_ITEMS)
    .optional()
    .describe("Contract pairs for check."),
  snapshotId: z.string().min(1).optional().describe("Snapshot ID anchor."),
  base: z.array(z.string().min(1)).min(1).max(DIFFERENTIATION_TOOL_MAX_ITEMS).optional().describe("Base spec paths."),
  target: z.array(z.string().min(1)).min(1).max(DIFFERENTIATION_TOOL_MAX_ITEMS).optional().describe("Target spec paths."),
  scope: z.array(z.string().min(1)).min(1).optional().describe("MatchKey filter."),
  anchorFiles: z
    .array(z.string().min(1))
    .min(1)
    .max(DIFFERENTIATION_TOOL_MAX_ITEMS)
    .optional()
    .describe("Anchor source files."),
});

export const GetEvidenceToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  id: z.string().min(1).describe("Node, edge, evidence, or finding ID."),
});

/**
 * Lean core wire schema for causoryn_export_documentation (<= 1,800 chars total tool entry).
 * Full fail-closed annotations validation still executes inside exportDocumentationTool.
 */
export const ExportDocumentationCoreInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  format: z.enum(EXPORT_DOCUMENTATION_FORMATS).describe("Output format."),
  outputDir: z.string().min(1).describe("Output dir (<slug>-<hash12>/exports)."),
  fileName: z.string().min(1).optional().describe("File name."),
  view: z.string().min(1).optional().describe("architecture, interactive, or full."),
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
  workspace: z.string().min(1).optional().describe("Workspace path to check."),
});

export const WorkspaceSummaryToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
});

export const IndexStatusToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  jobId: z.string().min(1).optional().describe("Job ID to inspect."),
});

export const RefreshIndexToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  mode: z.enum(["full", "incremental"]).describe("Indexing mode."),
  scope: z.string().min(1).optional().describe("Reserved scope (omit)."),
});

export const TraceExecutionToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  entrypoint: z.string().min(1).describe("Start node ID, symbol, or endpoint."),
  maxDepth: z.number().int().min(0).optional().describe("Max depth (default 6, clamped)."),
  maxPaths: z.number().int().min(0).optional().describe("Max paths (default 25, clamped)."),
});

export const TraceBusinessFlowToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  flowSeed: z.string().min(1).describe("Start node ID or exact qualifiedName."),
  boundaries: z.enum(FLOW_BOUNDARIES).array().min(1).optional().describe("Flow edge kinds."),
  maxHops: z.number().int().positive().optional().describe("Max hops."),
  maxFlows: z.number().int().positive().optional().describe("Max flows."),
  maxNodes: z.number().int().positive().optional().describe("Max visited nodes."),
});

export const AnalyzeImpactToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  targets: z.array(z.string().min(1)).min(1).describe("Target node IDs or qualifiedNames."),
  depth: z.number().int().positive().optional().describe("Max traversal depth."),
  maxPaths: z.number().int().positive().optional().describe("Max impact paths."),
  maxNodes: z.number().int().positive().optional().describe("Max affected nodes."),
  edgeKinds: z.array(z.string().min(1)).optional().describe("Edge kinds filter."),
});

export const CheckArchitectureToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  policyId: z.string().min(1).optional().describe("Reserved policyId (omit)."),
  scope: z.string().min(1).optional().describe("Reserved scope (omit)."),
});

export const CompareArchitectureToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  baseRef: z.string().min(1).describe("Baseline git ref or working-tree."),
  targetRef: z.string().min(1).describe("Target git ref or working-tree."),
});

export const GenerateOnboardingToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  audience: z.enum(["beginner", "intermediate", "maintainer"]).describe("Onboarding audience."),
  focus: z.string().min(1).optional().describe("Reserved focus (omit)."),
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
    .array(
      z.strictObject({
        name: z.string().min(1).optional().describe("Pair label."),
        base: z.string().min(1).describe("Baseline spec path."),
        target: z.string().min(1).describe("Target spec path."),
      }),
    )
    .min(1)
    .max(DIFFERENTIATION_TOOL_MAX_ITEMS)
    .describe("Contract version pairs."),
  snapshotId: z.string().min(1).optional().describe("Snapshot ID anchor."),
});

export const DetectContractDriftToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  base: z.array(z.string().min(1)).min(1).max(DIFFERENTIATION_TOOL_MAX_ITEMS).describe("Base spec paths."),
  target: z.array(z.string().min(1)).min(1).max(DIFFERENTIATION_TOOL_MAX_ITEMS).describe("Target spec paths."),
  scope: z.array(z.string().min(1)).min(1).optional().describe("MatchKey filter."),
  anchorFiles: z
    .array(z.string().min(1))
    .min(1)
    .max(DIFFERENTIATION_TOOL_MAX_ITEMS)
    .optional()
    .describe("Anchor source files."),
});

export const DeriveTestPlanToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  changeSet: z
    .strictObject({
      changedSymbols: z.array(z.string().min(1)).min(1).optional().describe("Changed symbols."),
      changedFiles: z.array(z.string().min(1)).min(1).optional().describe("Changed file paths."),
    })
    .optional()
    .describe("Changed symbols or files."),
  preflightId: z.string().min(1).optional().describe("Preflight manifest ID."),
  maxDepth: z.number().int().positive().optional().describe("Max call-site depth."),
  maxCandidates: z.number().int().positive().optional().describe("Max test candidates."),
});

export const ArchitectureTimelineToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  refs: z
    .array(z.string().min(1))
    .min(2)
    .max(TIMELINE_MAX_REFS)
    .optional()
    .describe("Explicit git refs list."),
  range: z
    .strictObject({
      from: z.string().min(1).describe("Start git ref."),
      to: z.string().min(1).describe("End git ref."),
    })
    .optional()
    .describe("Bounded git history range."),
  maxRevisions: z.number().int().min(2).optional().describe("Max sampled revisions."),
  maxRangeWalk: z.number().int().min(2).optional().describe("Max commits walked."),
  granularity: z.string().min(1).optional().describe("Reserved granularity (omit)."),
});

export const WikiBuildToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  mode: z.enum(["full", "incremental"]).describe("Wiki build mode."),
  scope: z.string().min(1).optional().describe("Reserved scope (omit)."),
  revision: z.string().min(1).optional().describe("Optional revision label."),
});

export const WikiGetTreeToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  snapshotId: z.string().min(1).optional().describe("WikiSnapshot ID."),
  parentId: z.string().min(1).optional().describe("Subtree root page ID."),
  depth: z.number().int().min(1).max(8).optional().describe("Subtree depth (1-8)."),
  limit: z.number().int().min(1).optional().describe("Page size (default 50, max 200)."),
  cursor: z.string().min(1).optional().describe("Pagination cursor."),
});

export const WikiGetPageToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  pageId: z.string().min(1).describe("Wiki page ID."),
  snapshotId: z.string().min(1).optional().describe("WikiSnapshot ID."),
  sections: z.array(z.string().min(1)).optional().describe("Section keys filter."),
  limit: z.number().int().min(1).optional().describe("Max sections per page."),
  cursor: z.string().min(1).optional().describe("Pagination cursor."),
});

export const WikiSearchToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  query: z.string().describe("Full-text search query."),
  snapshotId: z.string().min(1).optional().describe("WikiSnapshot ID."),
  limit: z.number().int().min(1).optional().describe("Max results per page."),
  cursor: z.string().min(1).optional().describe("Pagination cursor."),
  kinds: z.array(WikiPageKindSchema).optional().describe("Reserved kind filter (omit)."),
  scope: z.string().min(1).optional().describe("Reserved scope filter (omit)."),
  language: z.string().min(1).optional().describe("Reserved language filter (omit)."),
  revision: z.string().min(1).optional().describe("Reserved revision filter (omit)."),
  resolution: z.enum(["verified", "heuristic", "unresolved"]).optional().describe("Reserved resolution filter (omit)."),
});

export const WikiGetLinksToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  pageId: z.string().min(1).describe("Wiki page ID."),
  direction: z.enum(["incoming", "outgoing", "both"]).default("both").describe("Link direction."),
  linkKinds: z.array(WikiLinkKindSchema).optional().describe("Link kinds filter."),
  snapshotId: z.string().min(1).optional().describe("WikiSnapshot ID."),
  limit: z.number().int().min(1).optional().describe("Max links per page."),
  cursor: z.string().min(1).optional().describe("Pagination cursor."),
});

export const WikiGetVersionsToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  pageId: z.string().min(1).optional().describe("Optional page ID."),
  refs: z.array(z.string().min(1)).min(1).max(WIKI_TOOL_MAX_LIMIT).optional().describe("Git refs to resolve."),
  limit: z.number().int().min(1).optional().describe("Max entries per page."),
  cursor: z.string().min(1).optional().describe("Pagination cursor."),
});

export const WikiDiffToolInputSchema = z.strictObject({
  workspaceId: workspaceIdField(),
  base: z.string().min(1).describe("Baseline WikiSnapshot ID or revision."),
  target: z.string().min(1).describe("Target WikiSnapshot ID or revision."),
  pageId: z.string().min(1).optional().describe("Single page ID filter."),
});
