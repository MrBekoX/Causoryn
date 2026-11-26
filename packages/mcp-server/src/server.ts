import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { NODE_KINDS } from "@causoryn/domain";
import { z } from "zod";

import type { ActiveIndexJobInfo, CausorynContext } from "./context.js";
import { CausorynToolError } from "./errors.js";
import {
  buildEnvelope,
  envelopeOutputSchema,
  errorEnvelope,
  type Envelope,
} from "./envelope.js";
import {
  AnalyzeImpactToolInputSchema,
  ArchitectureTimelineToolInputSchema,
  CheckArchitectureToolInputSchema,
  CheckContractsToolInputSchema,
  CompareArchitectureToolInputSchema,
  ContractsToolInputSchema,
  DeriveTestPlanToolInputSchema,
  DetectContractDriftToolInputSchema,
  ExportDocumentationCoreInputSchema,
  FindSymbolsToolInputSchema,
  GenerateOnboardingToolInputSchema,
  GetAgentContextToolInputSchema,
  GetCapabilitiesToolInputSchema,
  GetEvidenceToolInputSchema,
  GetSymbolContextToolInputSchema,
  IndexStatusToolInputSchema,
  MapSystemToolInputSchema,
  ObservedTestRunToolInputSchema,
  PreflightChangeCoreInputSchema,
  PreflightChangeToolInputSchema,
  RefreshIndexToolInputSchema,
  StatusToolInputSchema,
  TraceBusinessFlowToolInputSchema,
  TraceExecutionToolInputSchema,
  TraceToolInputSchema,
  VerifyChangeCoreInputSchema,
  VerifyChangeToolInputSchema,
  WikiBuildToolInputSchema,
  WikiDiffToolInputSchema,
  WikiGetLinksToolInputSchema,
  WikiGetPageToolInputSchema,
  WikiGetTreeToolInputSchema,
  WikiGetVersionsToolInputSchema,
  WikiSearchToolInputSchema,
  WorkspaceSummaryToolInputSchema,
} from "./schemas.js";
import {
  AmbiguityDataSchema,
  CapabilitiesDataSchema,
  FindSymbolsDataSchema,
  GetEvidenceDataSchema,
  GetSymbolContextDataSchema,
  IndexStatusDataSchema,
  MapDataSchema,
  RefreshIndexDataSchema,
  TraceExecutionDataSchema,
  WorkspaceSummaryDataSchema,
  findSymbols,
  getCapabilities,
  getEvidence,
  getSymbolContext,
  indexStatus,
  mapSystem,
  refreshIndex,
  requireAuthorizedWorkspace,
  traceExecution,
  workspaceSummary,
} from "./services.js";
import {
  AnalyzeImpactDataSchema,
  ArchitectureTimelineDataSchema,
  CheckArchitectureDataSchema,
  CompareArchitectureDataSchema,
  ExportDocumentationDataSchema,
  ExportDocumentationInputSchema,
  GenerateOnboardingDataSchema,
  GetAgentContextDataSchema,
  analyzeImpactTool,
  architectureTimeline,
  checkArchitecture,
  compareArchitecture,
  exportDocumentationTool,
  generateOnboardingTool,
  getAgentContext,
} from "./services-architecture.js";
import {
  WikiBuildDataSchema,
  WikiDiffDataSchema,
  WikiGetLinksDataSchema,
  WikiGetPageDataSchema,
  WikiGetTreeDataSchema,
  WikiGetVersionsDataSchema,
  WikiSearchDataSchema,
  wikiBuild,
  wikiDiff,
  wikiGetLinks,
  wikiGetPage,
  wikiGetTree,
  wikiGetVersions,
  wikiSearch,
} from "./services-wiki.js";
import {
  CheckContractsDataSchema,
  DetectContractDriftDataSchema,
  DeriveTestPlanDataSchema,
  PreflightChangeDataSchema,
  TraceBusinessFlowDataSchema,
  checkContracts,
  detectContractDriftTool,
  deriveTestPlan,
  preflightChange,
  traceBusinessFlow,
} from "./services-differentiation.js";
import {
  VerifyChangeDataSchema,
  verifyChangeTool,
} from "./services-verification.js";
import {
  CORE_TOOL_NAMES,
  DEPRECATED_TOOL_REPLACEMENTS,
  HISTORY_TOOL_NAMES,
  SERVER_NAME,
  SERVER_VERSION,
  TOOL_NAMES,
  TOOL_PROFILES,
  WIKI_TOOL_NAMES,
  type ToolProfile,
} from "./version.js";

/**
 * MCP protocol adapter exposing Causoryn's deterministic, read-only codebase
 * intelligence tools with selectable tool profiles (`core`, `wiki`, `history`,
 * `full`) and non-blocking cold/warm indexing behavior.
 */

const DEFAULT_INDEX_RETRY_AFTER_MS = 3_000;
const DEFAULT_SERVER_INDEX_WAIT_MS = 15_000;

const NON_BLOCKING_BOOT_TOOLS: ReadonlySet<string> = new Set([
  "causoryn_status",
  "causoryn_get_capabilities",
  "causoryn_index_status",
  "causoryn_refresh_index",
]);

const TOOL_PROFILE_SET: ReadonlySet<string> = new Set<string>(TOOL_PROFILES);

const StatusInspectDataSchema = z.strictObject({
  capabilities: CapabilitiesDataSchema,
  authorized: z.boolean(),
  indexing: z.boolean(),
  retryAfterMs: z.number().int().positive().optional(),
  index: IndexStatusDataSchema,
  summary: WorkspaceSummaryDataSchema.nullable(),
});

const StatusToolDataSchema = z.union([StatusInspectDataSchema, RefreshIndexDataSchema]);

const MapSystemConsolidatedDataSchema = z.union([MapDataSchema, GenerateOnboardingDataSchema]);

const TraceConsolidatedDataSchema = z.union([
  AmbiguityDataSchema,
  TraceExecutionDataSchema,
  TraceBusinessFlowDataSchema,
]);

const PreflightConsolidatedDataSchema = z.union([
  PreflightChangeDataSchema,
  AnalyzeImpactDataSchema,
  DeriveTestPlanDataSchema,
]);

const ContractsConsolidatedDataSchema = z.union([
  CheckContractsDataSchema,
  DetectContractDriftDataSchema,
]);

interface ToolRegistration {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly openWorldHint: boolean;
  };
  readonly handler: (requestId: string, args: unknown) => Envelope | Promise<Envelope>;
}

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

function envelopeResult(envelope: Envelope): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

function normalizeProfiles(raw: ToolProfile | string | readonly ToolProfile[] | undefined): readonly ToolProfile[] {
  if (raw === undefined) {
    return ["core"];
  }
  const tokens = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
  if (tokens.length === 0) {
    return ["core"];
  }
  const out: ToolProfile[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!TOOL_PROFILE_SET.has(token)) {
      throw new Error(
        `Invalid toolProfile "${token}"; valid profiles: ${TOOL_PROFILES.join(", ")}`,
      );
    }
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token as ToolProfile);
    }
  }
  return out;
}

/** Optional capability of a rebindable context (see createDynamicCausorynContext). */
interface ToolCallPinning {
  runPinned<T>(work: () => Promise<T> | T): Promise<T>;
}

function toolCallPinningOf(context: CausorynContext): ToolCallPinning | undefined {
  const candidate: CausorynContext & Partial<ToolCallPinning> = context;
  return typeof candidate.runPinned === "function"
    ? (candidate as ToolCallPinning)
    : undefined;
}

function activeIndexingJobOf(context: CausorynContext): ActiveIndexJobInfo | null {
  if (context.getActiveIndexJob !== undefined) {
    return context.getActiveIndexJob();
  }
  const jobs = context.jobManager.jobs();
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    const job = jobs[i];
    if (job !== undefined && (job.status === "running" || job.status === "queued")) {
      return {
        jobId: job.jobId,
        status: job.status,
        progressPercent: job.progressPercent,
        phase: job.progress?.phase ?? (job.status === "queued" ? "queued" : "indexing"),
      };
    }
  }
  return null;
}

function withAppendedWarning(envelope: Envelope, warning: string): Envelope {
  return buildEnvelope({
    requestId: envelope.requestId,
    workspaceId: envelope.workspaceId,
    snapshotId: envelope.snapshotId,
    status: envelope.status,
    coverage: envelope.coverage,
    warnings: [...envelope.warnings, warning],
    data: envelope.data,
    nextCursor: envelope.nextCursor,
    error: envelope.error,
  });
}

function resolveProfileToolNames(profiles: readonly ToolProfile[]): readonly string[] {
  if (profiles.includes("full")) {
    // Full profile registers all 29 legacy tools plus the 3 consolidated aliases (32 total).
    const fullSet = new Set<string>(TOOL_NAMES);
    const out: string[] = [...TOOL_NAMES];
    for (const coreName of CORE_TOOL_NAMES) {
      if (!fullSet.has(coreName)) {
        fullSet.add(coreName);
        out.push(coreName);
      }
    }
    return out;
  }
  const out: string[] = [...CORE_TOOL_NAMES];
  const seen = new Set<string>(out);
  if (profiles.includes("wiki")) {
    for (const name of WIKI_TOOL_NAMES) {
      if (!seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  if (profiles.includes("history")) {
    for (const name of HISTORY_TOOL_NAMES) {
      if (!seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out;
}

function runStatusTool(
  context: CausorynContext,
  requestId: string,
  input: z.infer<typeof StatusToolInputSchema>,
  activeToolNames: readonly string[],
): Envelope {
  if (input.action === "refresh") {
    return refreshIndex(context, requestId, {
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      mode: input.mode ?? "incremental",
    });
  }

  const capEnvelope = getCapabilities(context, requestId, {
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
  });
  const capData = capEnvelope.data as z.infer<typeof CapabilitiesDataSchema>;
  const capabilities = {
    ...capData,
    tools: [...activeToolNames],
  };

  const targetWorkspaceId = input.workspaceId ?? context.config.workspaceId;
  if (context.config.allowRoots.length === 0 && input.workspaceId === undefined) {
    return buildEnvelope({
      requestId,
      workspaceId: targetWorkspaceId,
      snapshotId: null,
      status: "ok",
      coverage: null,
      warnings: [
        "No workspace root is authorized yet; configure --root, --allow-cwd, MCP roots/list, or allowRoots in CAUSORYN_CONFIG.",
      ],
      data: {
        capabilities,
        authorized: false,
        indexing: false,
        index: {
          workspaceId: targetWorkspaceId,
          jobId: null,
          job: null,
          latestSnapshot: null,
        },
        summary: null,
      },
    });
  }

  requireAuthorizedWorkspace(context, targetWorkspaceId);
  const idxEnvelope = indexStatus(context, requestId, {
    workspaceId: targetWorkspaceId,
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
  });
  const idxData = idxEnvelope.data as z.infer<typeof IndexStatusDataSchema>;
  const activeJob = activeIndexingJobOf(context);
  const summaryEnvelope =
    idxData.latestSnapshot !== null
      ? workspaceSummary(context, requestId, { workspaceId: targetWorkspaceId })
      : null;
  const summaryData =
    summaryEnvelope === null
      ? null
      : (summaryEnvelope.data as z.infer<typeof WorkspaceSummaryDataSchema>);

  const status: "ok" | "partial" =
    summaryData === null && activeJob !== null
      ? "partial"
      : idxEnvelope.status === "partial"
        ? "partial"
        : "ok";

  return buildEnvelope({
    requestId,
    workspaceId: targetWorkspaceId,
    snapshotId: idxEnvelope.snapshotId,
    status,
    coverage: idxEnvelope.coverage,
    warnings: idxEnvelope.warnings,
    data: {
      capabilities,
      authorized: true,
      indexing: activeJob !== null,
      ...(activeJob !== null && summaryData === null
        ? { retryAfterMs: DEFAULT_INDEX_RETRY_AFTER_MS }
        : {}),
      index: idxData,
      summary: summaryData,
    },
  });
}

function buildAllRegistrations(
  context: CausorynContext,
  options: {
    readonly isFullProfile: boolean;
    readonly activeToolNames: readonly string[];
  },
): ReadonlyMap<string, ToolRegistration> {
  const registrations: ToolRegistration[] = [
    {
      name: "causoryn_status",
      title: "Workspace Status & Refresh",
      description:
        "Inspect server capabilities, workspace summary, coverage tiers, and index job progress (action='inspect', default), or queue an incremental/full re-index job (action='refresh').",
      inputSchema: StatusToolInputSchema,
      outputSchema: envelopeOutputSchema(StatusToolDataSchema),
      annotations: WRITE_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        runStatusTool(
          context,
          requestId,
          args as z.infer<typeof StatusToolInputSchema>,
          options.activeToolNames,
        ),
    },
    {
      name: "causoryn_get_capabilities",
      title: "Server Capabilities",
      description:
        "Return supported language adapters, coverage tiers, server limits, protocol revision, and tool names without requiring a snapshot.",
      inputSchema: GetCapabilitiesToolInputSchema,
      outputSchema: envelopeOutputSchema(CapabilitiesDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        getCapabilities(context, requestId, args as z.infer<typeof GetCapabilitiesToolInputSchema>),
    },
    {
      name: "causoryn_workspace_summary",
      title: "Workspace Summary",
      description:
        "Return project file counts, languages, frameworks, entrypoints, and edge resolution breakdown from the published snapshot.",
      inputSchema: WorkspaceSummaryToolInputSchema,
      outputSchema: envelopeOutputSchema(WorkspaceSummaryDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        workspaceSummary(context, requestId, args as z.infer<typeof WorkspaceSummaryToolInputSchema>),
    },
    {
      name: "causoryn_index_status",
      title: "Index Status",
      description:
        "Report the latest published snapshot, staleness flag, and background indexing job progress or diagnostics.",
      inputSchema: IndexStatusToolInputSchema,
      outputSchema: envelopeOutputSchema(IndexStatusDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        indexStatus(context, requestId, args as z.infer<typeof IndexStatusToolInputSchema>),
    },
    {
      name: "causoryn_refresh_index",
      title: "Refresh Index",
      description:
        "Queue a background full or incremental snapshot build and return its jobId immediately; writes only to Causoryn's own data store.",
      inputSchema: RefreshIndexToolInputSchema,
      outputSchema: envelopeOutputSchema(RefreshIndexDataSchema),
      annotations: WRITE_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        refreshIndex(context, requestId, args as z.infer<typeof RefreshIndexToolInputSchema>),
    },
    {
      name: "causoryn_map_system",
      title: "Architecture Map",
      description:
        "Return a paginated L0-L3 graph map, or set profile='onboarding' for entrypoints, central modules, learning order, and risk areas.",
      inputSchema: MapSystemToolInputSchema,
      outputSchema: envelopeOutputSchema(MapSystemConsolidatedDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) => {
        const parsed = args as z.infer<typeof MapSystemToolInputSchema>;
        if (parsed.profile === "onboarding") {
          let validatedLimits:
            | {
                readonly entryPointLimit?: number;
                readonly topModuleCount?: number;
                readonly maxLearningSteps?: number;
                readonly maxCriticalFlows?: number;
              }
            | undefined;
          if (parsed.limits !== undefined) {
            const allowedLimitKeys = new Set([
              "entryPointLimit",
              "topModuleCount",
              "maxLearningSteps",
              "maxCriticalFlows",
            ]);
            for (const key of Object.keys(parsed.limits)) {
              if (!allowedLimitKeys.has(key)) {
                throw new CausorynToolError(
                  "INVALID_ARGUMENT",
                  `Unknown onboarding limit key: ${key}`,
                );
              }
            }
            validatedLimits = {
              ...(parsed.limits["entryPointLimit"] === undefined
                ? {}
                : { entryPointLimit: parsed.limits["entryPointLimit"] }),
              ...(parsed.limits["topModuleCount"] === undefined
                ? {}
                : { topModuleCount: parsed.limits["topModuleCount"] }),
              ...(parsed.limits["maxLearningSteps"] === undefined
                ? {}
                : { maxLearningSteps: parsed.limits["maxLearningSteps"] }),
              ...(parsed.limits["maxCriticalFlows"] === undefined
                ? {}
                : { maxCriticalFlows: parsed.limits["maxCriticalFlows"] }),
            };
          }
          return generateOnboardingTool(context, requestId, {
            ...(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }),
            audience: parsed.audience ?? "maintainer",
            ...(validatedLimits === undefined ? {} : { limits: validatedLimits }),
          });
        }
        let validatedFilters:
          | {
              readonly kinds?: z.infer<typeof FindSymbolsToolInputSchema>["kind"][];
              readonly pathPrefix?: string;
            }
          | undefined;
        if (parsed.filters !== undefined) {
          if (parsed.filters.kinds !== undefined) {
            const nodeKindSet = new Set<string>(NODE_KINDS);
            const invalidKinds = parsed.filters.kinds.filter((k) => !nodeKindSet.has(k));
            if (invalidKinds.length > 0) {
              throw new CausorynToolError(
                "INVALID_ARGUMENT",
                `Invalid node kind(s) in filters.kinds: ${invalidKinds.join(", ")}`,
              );
            }
          }
          validatedFilters = {
            ...(parsed.filters.kinds === undefined
              ? {}
              : { kinds: parsed.filters.kinds as z.infer<typeof FindSymbolsToolInputSchema>["kind"][] }),
            ...(parsed.filters.pathPrefix === undefined
              ? {}
              : { pathPrefix: parsed.filters.pathPrefix }),
          };
        }
        return mapSystem(context, requestId, {
          ...(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }),
          ...(parsed.level === undefined ? {} : { level: parsed.level }),
          ...(validatedFilters === undefined
            ? {}
            : {
                filters: {
                  ...(validatedFilters.kinds === undefined
                    ? {}
                    : { kinds: validatedFilters.kinds as (typeof NODE_KINDS)[number][] }),
                  ...(validatedFilters.pathPrefix === undefined
                    ? {}
                    : { pathPrefix: validatedFilters.pathPrefix }),
                },
              }),
          ...(parsed.maxNodes === undefined ? {} : { maxNodes: parsed.maxNodes }),
          ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
        });
      },
    },
    {
      name: "causoryn_find_symbols",
      title: "Find Symbols",
      description:
        "Search qualified symbol names by exact, prefix, or substring match with optional kind filter and disambiguation candidates.",
      inputSchema: FindSymbolsToolInputSchema,
      outputSchema: envelopeOutputSchema(AmbiguityDataSchema.or(FindSymbolsDataSchema)),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        findSymbols(context, requestId, args as z.infer<typeof FindSymbolsToolInputSchema>),
    },
    {
      name: "causoryn_get_symbol_context",
      title: "Symbol Context",
      description:
        "Return a symbol node, bounded neighbor edges filtered by edgeKinds, and supporting source-span evidence records.",
      inputSchema: GetSymbolContextToolInputSchema,
      outputSchema: envelopeOutputSchema(AmbiguityDataSchema.or(GetSymbolContextDataSchema)),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        getSymbolContext(context, requestId, args as z.infer<typeof GetSymbolContextToolInputSchema>),
    },
    {
      name: "causoryn_trace",
      title: "Execution & Business Flow Trace",
      description:
        "Trace deterministic call paths over CALLS/ROUTES_TO edges (mode='execution', default) or cross-component request/event/contract flows (mode='business-flow') with explicit per-edge resolution and evidence.",
      inputSchema: TraceToolInputSchema,
      outputSchema: envelopeOutputSchema(TraceConsolidatedDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) => {
        const parsed = args as z.infer<typeof TraceToolInputSchema>;
        const target = parsed.entrypoint ?? parsed.flowSeed;
        if (target === undefined) {
          throw new CausorynToolError(
            "INVALID_ARGUMENT",
            "Provide entrypoint (or flowSeed) with a node ID, qualified symbol name, or endpoint.",
          );
        }
        if (parsed.mode === "business-flow") {
          return traceBusinessFlow(context, requestId, {
            ...(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }),
            flowSeed: target,
            ...(parsed.boundaries === undefined ? {} : { boundaries: parsed.boundaries }),
            ...(parsed.maxHops === undefined ? {} : { maxHops: parsed.maxHops }),
            ...(parsed.maxFlows === undefined ? {} : { maxFlows: parsed.maxFlows }),
            ...(parsed.maxNodes === undefined ? {} : { maxNodes: parsed.maxNodes }),
          });
        }
        return traceExecution(context, requestId, {
          ...(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }),
          entrypoint: target,
          ...(parsed.maxDepth === undefined ? {} : { maxDepth: parsed.maxDepth }),
          ...(parsed.maxPaths === undefined ? {} : { maxPaths: parsed.maxPaths }),
        });
      },
    },
    {
      name: "causoryn_trace_execution",
      title: "Execution Flow Trace",
      description:
        "Trace bounded CALLS and ROUTES_TO call paths from an endpoint or symbol with explicit verified, heuristic, and unresolved labels.",
      inputSchema: TraceExecutionToolInputSchema,
      outputSchema: envelopeOutputSchema(AmbiguityDataSchema.or(TraceExecutionDataSchema)),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        traceExecution(context, requestId, args as z.infer<typeof TraceExecutionToolInputSchema>),
    },
    {
      name: "causoryn_trace_business_flow",
      title: "Business Flow Trace",
      description:
        "Trace cross-component request, event, and contract flows from a seed symbol, reporting discontinuities honestly as gap segments.",
      inputSchema: TraceBusinessFlowToolInputSchema,
      outputSchema: envelopeOutputSchema(TraceBusinessFlowDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        traceBusinessFlow(
          context,
          requestId,
          args as z.infer<typeof TraceBusinessFlowToolInputSchema>,
        ),
    },
    {
      name: "causoryn_analyze_impact",
      title: "Impact Analysis",
      description:
        "Compute bounded reverse-dependency impact paths from target symbols with separate certainty and edge resolution labels.",
      inputSchema: AnalyzeImpactToolInputSchema,
      outputSchema: envelopeOutputSchema(AnalyzeImpactDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        analyzeImpactTool(context, requestId, args as z.infer<typeof AnalyzeImpactToolInputSchema>),
    },
    {
      name: "causoryn_check_architecture",
      title: "Architecture Guard",
      description:
        "Evaluate .causoryn/architecture.rules.yaml rules (cycle and forbidden-dependency checks) and optional baseline suppressions on the published snapshot.",
      inputSchema: CheckArchitectureToolInputSchema,
      outputSchema: envelopeOutputSchema(CheckArchitectureDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: async (requestId, args) =>
        checkArchitecture(context, requestId, args as z.infer<typeof CheckArchitectureToolInputSchema>),
    },
    {
      name: "causoryn_compare_architecture",
      title: "Architecture Diff",
      description:
        "Compare two git refs or working-tree architecture snapshots for added, removed, changed, renamed symbols and API surface changes. Never modifies the workspace or git state; commits analyzed from their git objects are cached under the data root.",
      inputSchema: CompareArchitectureToolInputSchema,
      outputSchema: envelopeOutputSchema(CompareArchitectureDataSchema),
      // Writes its commit-analysis cache under the data root (never the workspace).
      annotations: WRITE_TOOL_ANNOTATIONS,
      handler: async (requestId, args) =>
        compareArchitecture(
          context,
          requestId,
          args as z.infer<typeof CompareArchitectureToolInputSchema>,
        ),
    },
    {
      name: "causoryn_get_agent_context",
      title: "Agent Context Search",
      description:
        "Rank relevant symbols and files for a query using exact-symbol, graph-proximity, contract, freshness, and full-text search signals within tokenBudget.",
      inputSchema: GetAgentContextToolInputSchema,
      outputSchema: envelopeOutputSchema(GetAgentContextDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        getAgentContext(context, requestId, args as z.infer<typeof GetAgentContextToolInputSchema>),
    },
    {
      name: "causoryn_generate_onboarding",
      title: "Onboarding Report",
      description:
        "Generate structured onboarding data (entrypoints, central modules, learning order, critical flows, tests, and risk areas) for a chosen audience.",
      inputSchema: GenerateOnboardingToolInputSchema,
      outputSchema: envelopeOutputSchema(GenerateOnboardingDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        generateOnboardingTool(
          context,
          requestId,
          args as z.infer<typeof GenerateOnboardingToolInputSchema>,
        ),
    },
    {
      name: "causoryn_export_documentation",
      title: "Export Documentation",
      description:
        'Export snapshot to outputDir (json|markdown|mermaid|html|snapshot); view: architecture, interactive (offline HTML, causoryn-architecture-interactive.html), or full. LLM-free: (1) format:"json" view:"architecture" for architectureSummary.moduleIds, (2) annotations + format:"html" view:"interactive" (see architecture-blueprint skill), or omit annotations.',
      inputSchema: options.isFullProfile
        ? ExportDocumentationInputSchema
        : ExportDocumentationCoreInputSchema,
      outputSchema: envelopeOutputSchema(ExportDocumentationDataSchema),
      annotations: WRITE_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        exportDocumentationTool(
          context,
          requestId,
          args as z.infer<typeof ExportDocumentationInputSchema>,
        ),
    },
    {
      name: "causoryn_preflight_change",
      title: "Preflight Change",
      description:
        "Generate a read-only preflight manifest with impact candidates and derived test plans; optionally narrow via include: ['impact', 'test-plan'].",
      inputSchema: options.isFullProfile
        ? PreflightChangeToolInputSchema
        : PreflightChangeCoreInputSchema,
      outputSchema: envelopeOutputSchema(PreflightConsolidatedDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: async (requestId, args) => {
        const parsed = args as z.infer<typeof PreflightChangeToolInputSchema>;
        const include = parsed.include;
        if (
          include !== undefined &&
          include.length === 1 &&
          include[0] === "test-plan" &&
          parsed.preflightId !== undefined &&
          parsed.targetSymbols === undefined &&
          parsed.targetFiles === undefined
        ) {
          return deriveTestPlan(context, requestId, {
            ...(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }),
            preflightId: parsed.preflightId,
            ...(parsed.maxDepth === undefined ? {} : { maxDepth: parsed.maxDepth }),
            ...(parsed.maxCandidates === undefined ? {} : { maxCandidates: parsed.maxCandidates }),
          });
        }
        if (
          include !== undefined &&
          include.length === 1 &&
          include[0] === "impact" &&
          parsed.intent === undefined &&
          parsed.targetSymbols !== undefined &&
          parsed.targetFiles === undefined
        ) {
          return analyzeImpactTool(context, requestId, {
            ...(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }),
            targets: parsed.targetSymbols,
            ...(parsed.maxDepth === undefined ? {} : { depth: parsed.maxDepth }),
            ...(parsed.maxPaths === undefined ? {} : { maxPaths: parsed.maxPaths }),
            ...(parsed.maxNodes === undefined ? {} : { maxNodes: parsed.maxNodes }),
            ...(parsed.edgeKinds === undefined ? {} : { edgeKinds: parsed.edgeKinds }),
          });
        }
        if (parsed.intent === undefined && include === undefined) {
          throw new CausorynToolError(
            "INVALID_ARGUMENT",
            "intent is required for preflight change analysis (or pass include=['impact'|'test-plan'])",
          );
        }
        const effectiveIncludeTestPlan =
          include !== undefined ? include.includes("test-plan") : parsed.includeTestPlan;
        return preflightChange(context, requestId, {
          ...(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }),
          intent: parsed.intent ?? "change-analysis",
          ...(parsed.targetSymbols === undefined ? {} : { targetSymbols: parsed.targetSymbols }),
          ...(parsed.targetFiles === undefined ? {} : { targetFiles: parsed.targetFiles }),
          ...(parsed.baseSnapshot === undefined ? {} : { baseSnapshot: parsed.baseSnapshot }),
          ...(parsed.includeContracts === undefined
            ? {}
            : { includeContracts: parsed.includeContracts }),
          ...(effectiveIncludeTestPlan === undefined
            ? {}
            : { includeTestPlan: effectiveIncludeTestPlan }),
          ...(parsed.maxDepth === undefined ? {} : { maxDepth: parsed.maxDepth }),
          ...(parsed.maxPaths === undefined ? {} : { maxPaths: parsed.maxPaths }),
          ...(parsed.maxNodes === undefined ? {} : { maxNodes: parsed.maxNodes }),
          ...(parsed.maxDisambiguationCandidates === undefined
            ? {}
            : { maxDisambiguationCandidates: parsed.maxDisambiguationCandidates }),
        });
      },
    },
    {
      name: "causoryn_contracts",
      title: "Contract Compatibility & Drift",
      description:
        "Evaluate contract spec version pairs for breaking/risk/safe compatibility (action='check', default) or detect drift with producer/consumer impact (action='drift').",
      inputSchema: ContractsToolInputSchema,
      outputSchema: envelopeOutputSchema(ContractsConsolidatedDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) => {
        const parsed = args as z.infer<typeof ContractsToolInputSchema>;
        if (parsed.action === "drift") {
          if (parsed.base === undefined || parsed.target === undefined) {
            throw new CausorynToolError(
              "INVALID_ARGUMENT",
              "base and target spec file arrays are required when action is 'drift'",
            );
          }
          return detectContractDriftTool(context, requestId, {
            ...(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }),
            base: parsed.base,
            target: parsed.target,
            ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
            ...(parsed.anchorFiles === undefined ? {} : { anchorFiles: parsed.anchorFiles }),
          });
        }
        if (parsed.contracts === undefined) {
          throw new CausorynToolError(
            "INVALID_ARGUMENT",
            "contracts array is required when action is 'check'",
          );
        }
        return checkContracts(context, requestId, {
          ...(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }),
          contracts: parsed.contracts,
          ...(parsed.snapshotId === undefined ? {} : { snapshotId: parsed.snapshotId }),
        });
      },
    },
    {
      name: "causoryn_check_contracts",
      title: "Check Contracts",
      description:
        "Evaluate OpenAPI, AsyncAPI, JSON Schema, SQL, or Protobuf spec version pairs for backward-safe, risk, breaking_candidate, or unknown compatibility.",
      inputSchema: CheckContractsToolInputSchema,
      outputSchema: envelopeOutputSchema(CheckContractsDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        checkContracts(context, requestId, args as z.infer<typeof CheckContractsToolInputSchema>),
    },
    {
      name: "causoryn_detect_contract_drift",
      title: "Detect Contract Drift",
      description:
        "Detect contract drift between base and target specs, map producer/consumer edges from anchorFiles, and report unconsumed changes.",
      inputSchema: DetectContractDriftToolInputSchema,
      outputSchema: envelopeOutputSchema(DetectContractDriftDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        detectContractDriftTool(
          context,
          requestId,
          args as z.infer<typeof DetectContractDriftToolInputSchema>,
        ),
    },
    {
      name: "causoryn_verify_change",
      title: "Verify Changes",
      description:
        "Verify working-tree changes read-only against a preflightId or baseSnapshot across architecture rules, graph-diff, and test-plan checks without running tests.",
      inputSchema: options.isFullProfile
        ? VerifyChangeToolInputSchema
        : VerifyChangeCoreInputSchema,
      outputSchema: envelopeOutputSchema(VerifyChangeDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) => {
        const raw = args as z.infer<typeof VerifyChangeCoreInputSchema>;
        let validatedObservedTestRun: z.infer<typeof ObservedTestRunToolInputSchema> | undefined;
        if (raw.observedTestRun !== undefined) {
          const check = ObservedTestRunToolInputSchema.safeParse(raw.observedTestRun);
          if (!check.success) {
            throw new CausorynToolError(
              "INVALID_ARGUMENT",
              `Invalid observedTestRun: ${check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            );
          }
          validatedObservedTestRun = check.data;
        }
        const parsed: z.infer<typeof VerifyChangeToolInputSchema> = {
          ...(raw.workspaceId === undefined ? {} : { workspaceId: raw.workspaceId }),
          ...(raw.preflightId === undefined ? {} : { preflightId: raw.preflightId }),
          ...(raw.baseSnapshot === undefined ? {} : { baseSnapshot: raw.baseSnapshot }),
          ...(raw.baseRef === undefined ? {} : { baseRef: raw.baseRef }),
          ...(raw.targetRevision === undefined ? {} : { targetRevision: raw.targetRevision }),
          ...(raw.checks === undefined ? {} : { checks: raw.checks }),
          ...(validatedObservedTestRun === undefined
            ? {}
            : { observedTestRun: validatedObservedTestRun }),
        };
        if (
          parsed.preflightId === undefined &&
          parsed.baseSnapshot === undefined &&
          parsed.checks !== undefined &&
          parsed.checks.length === 1 &&
          parsed.checks[0] === "architecture"
        ) {
          const workspaceId = parsed.workspaceId ?? context.config.workspaceId;
          requireAuthorizedWorkspace(context, workspaceId);
          const latest = context.repository.getLatestPublished(workspaceId);
          if (latest === undefined) {
            throw new CausorynToolError(
              "INDEX_NOT_READY",
              `No published snapshot available for workspace: ${workspaceId}`,
            );
          }
          return verifyChangeTool(context, requestId, {
            ...parsed,
            baseSnapshot: latest.snapshot.meta.id,
          });
        }
        return verifyChangeTool(context, requestId, parsed);
      },
    },
    {
      name: "causoryn_derive_test_plan",
      title: "Derive Test Plan",
      description:
        "Derive deterministic test candidates from a changeSet or preflightId using TESTS edges, call-site chains, and naming heuristics without executing tests.",
      inputSchema: DeriveTestPlanToolInputSchema,
      outputSchema: envelopeOutputSchema(DeriveTestPlanDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        deriveTestPlan(context, requestId, args as z.infer<typeof DeriveTestPlanToolInputSchema>),
    },
    {
      name: "causoryn_get_evidence",
      title: "Evidence Provenance",
      description:
        "Retrieve deterministic evidence chain (source spans, contextRefs, partial/missingFields) for a node, edge, evidence, or finding ID (EVIDENCE_NOT_FOUND if missing).",
      inputSchema: GetEvidenceToolInputSchema,
      outputSchema: envelopeOutputSchema(GetEvidenceDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        getEvidence(context, requestId, args as z.infer<typeof GetEvidenceToolInputSchema>),
    },
    {
      name: "causoryn_architecture_timeline",
      title: "Architecture Timeline",
      description:
        "Build a sampled architecture evolution timeline and per-metric rule violation trends across explicit git refs or a bounded history range. Never modifies the workspace or git state; commits analyzed from their git objects are cached under the data root.",
      inputSchema: ArchitectureTimelineToolInputSchema,
      outputSchema: envelopeOutputSchema(ArchitectureTimelineDataSchema),
      // Writes its commit-analysis cache under the data root (never the workspace).
      annotations: WRITE_TOOL_ANNOTATIONS,
      handler: async (requestId, args) =>
        architectureTimeline(
          context,
          requestId,
          args as z.infer<typeof ArchitectureTimelineToolInputSchema>,
        ),
    },
    {
      name: "causoryn_wiki_build",
      title: "Build Living Wiki",
      description:
        "Generate and atomically publish a deterministic WikiSnapshot into the configured wiki SQLite data store (full or incremental mode).",
      inputSchema: WikiBuildToolInputSchema,
      outputSchema: envelopeOutputSchema(WikiBuildDataSchema),
      annotations: WRITE_TOOL_ANNOTATIONS,
      handler: async (requestId, args) =>
        wikiBuild(context, requestId, args as z.infer<typeof WikiBuildToolInputSchema>),
    },
    {
      name: "causoryn_wiki_get_tree",
      title: "Wiki Page Tree",
      description:
        "Read the hierarchical wiki page tree with coverage, freshness, child counts, depth cap, and cursor pagination.",
      inputSchema: WikiGetTreeToolInputSchema,
      outputSchema: envelopeOutputSchema(WikiGetTreeDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        wikiGetTree(context, requestId, args as z.infer<typeof WikiGetTreeToolInputSchema>),
    },
    {
      name: "causoryn_wiki_get_page",
      title: "Wiki Page",
      description:
        "Read a single generated wiki page with section filtering, evidence provenance, source references, and cursor pagination.",
      inputSchema: WikiGetPageToolInputSchema,
      outputSchema: envelopeOutputSchema(WikiGetPageDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        wikiGetPage(context, requestId, args as z.infer<typeof WikiGetPageToolInputSchema>),
    },
    {
      name: "causoryn_wiki_search",
      title: "Wiki Search",
      description:
        "Search generated wiki pages using escaped multi-field FTS5 ranking with matched fields, evidence IDs, and cursor pagination.",
      inputSchema: WikiSearchToolInputSchema,
      outputSchema: envelopeOutputSchema(WikiSearchDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        wikiSearch(context, requestId, args as z.infer<typeof WikiSearchToolInputSchema>),
    },
    {
      name: "causoryn_wiki_get_links",
      title: "Wiki Page Links",
      description:
        "Inspect outgoing and incoming wiki links with resolution, evidence references, and broken-link diagnostics.",
      inputSchema: WikiGetLinksToolInputSchema,
      outputSchema: envelopeOutputSchema(WikiGetLinksDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        wikiGetLinks(context, requestId, args as z.infer<typeof WikiGetLinksToolInputSchema>),
    },
    {
      name: "causoryn_wiki_get_versions",
      title: "Wiki Versions",
      description:
        "List available published WikiSnapshot revisions or page versions and resolve optional git refs read-only.",
      inputSchema: WikiGetVersionsToolInputSchema,
      outputSchema: envelopeOutputSchema(WikiGetVersionsDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: async (requestId, args) =>
        wikiGetVersions(
          context,
          requestId,
          args as z.infer<typeof WikiGetVersionsToolInputSchema>,
        ),
    },
    {
      name: "causoryn_wiki_diff",
      title: "Wiki Diff",
      description:
        "Diff two published WikiSnapshots for added/removed pages, changed sections, link deltas, coverage deltas, and contract changes.",
      inputSchema: WikiDiffToolInputSchema,
      outputSchema: envelopeOutputSchema(WikiDiffDataSchema),
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
      handler: (requestId, args) =>
        wikiDiff(context, requestId, args as z.infer<typeof WikiDiffToolInputSchema>),
    },
  ];

  const byName = new Map<string, ToolRegistration>();
  for (const reg of registrations) {
    byName.set(reg.name, reg);
  }
  return byName;
}

export type OutputSchemaProfile = "full" | "omit";

export interface BeforeToolCallContext {
  readonly toolName: string;
  readonly progressToken?: string | number;
  readonly sendProgress: (update: {
    readonly progress: number;
    readonly total?: number;
    readonly message?: string;
  }) => Promise<void>;
  readonly signal: AbortSignal;
}

export interface CreateCausorynServerOptions {
  readonly outputSchemaProfile?: OutputSchemaProfile;
  readonly toolProfile?: ToolProfile | string | readonly ToolProfile[];
  readonly indexWaitTimeoutMs?: number;
  readonly beforeToolCall?: (
    toolName: string,
    hookContext?: BeforeToolCallContext,
  ) => void | Promise<void>;
}

/**
 * Binds CausorynContext to an MCP McpServer using the selected tool profile
 * (defaults to `core` with 11 lean consolidated tools and `outputSchemaProfile: "omit"`).
 */
export function createCausorynMcpServer(
  context: CausorynContext,
  options: CreateCausorynServerOptions = {},
): McpServer {
  const outputSchemaProfile: OutputSchemaProfile = options.outputSchemaProfile ?? "omit";
  const profiles = normalizeProfiles(options.toolProfile ?? context.config.toolProfile ?? "core");
  const isFullProfile = profiles.includes("full");
  const activeToolNames = resolveProfileToolNames(profiles);
  const allRegistrations = buildAllRegistrations(context, {
    isFullProfile,
    activeToolNames,
  });

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  for (const name of activeToolNames) {
    const registration = allRegistrations.get(name);
    if (registration === undefined) continue;
    const deprecatedReplacement = DEPRECATED_TOOL_REPLACEMENTS[registration.name];
    const effectiveDescription =
      isFullProfile && deprecatedReplacement !== undefined
        ? `${registration.description} (Deprecated: use ${deprecatedReplacement})`
        : registration.description;

    server.registerTool(
      registration.name,
      {
        title: registration.title,
        description: effectiveDescription,
        inputSchema: registration.inputSchema,
        ...(outputSchemaProfile === "full" ? { outputSchema: registration.outputSchema } : {}),
        annotations: registration.annotations,
      },
      async (args, extra) => {
        const requestId = String(extra.requestId);
        const progressToken = extra._meta?.progressToken;
        const hookContext: BeforeToolCallContext = {
          toolName: registration.name,
          ...(progressToken === undefined ? {} : { progressToken }),
          signal: extra.signal,
          sendProgress: async (update) => {
            if (progressToken === undefined) return;
            try {
              await extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: update.progress,
                  ...(update.total === undefined ? {} : { total: update.total }),
                  ...(update.message === undefined ? {} : { message: update.message }),
                },
              });
            } catch {
              // Best-effort notification: never crash tool invocation on transport close.
            }
          },
        };

        try {
          if (options.beforeToolCall !== undefined) {
            await options.beforeToolCall(registration.name, hookContext);
          } else if (
            !NON_BLOCKING_BOOT_TOOLS.has(registration.name) &&
            context.waitForInitialIndex !== undefined
          ) {
            await context.waitForInitialIndex({
              timeoutMs: options.indexWaitTimeoutMs ?? DEFAULT_SERVER_INDEX_WAIT_MS,
              signal: extra.signal,
              ...(progressToken === undefined
                ? {}
                : {
                    onProgress: (update) =>
                      hookContext.sendProgress({
                        progress: update.progress,
                        total: update.total,
                        message: update.message,
                      }),
                  }),
            });
          }

          const runHandler = async (): Promise<Envelope> => {
            let envelope = await registration.handler(requestId, args);

            if (envelope.status !== "error") {
              if (deprecatedReplacement !== undefined) {
                envelope = withAppendedWarning(
                  envelope,
                  `[Deprecated in favor of ${deprecatedReplacement}] Legacy tool ${registration.name} will be removed in a future release.`,
                );
              }
              if (
                !registration.name.startsWith("causoryn_wiki_") &&
                envelope.snapshotId !== null &&
                activeIndexingJobOf(context) !== null &&
                !envelope.warnings.some((w) => /stale/i.test(w))
              ) {
                envelope = withAppendedWarning(
                  envelope,
                  "stale=true: background re-indexing is currently running; serving latest published snapshot",
                );
              }
            }

            if (outputSchemaProfile === "omit") {
              registration.outputSchema.parse(envelope);
            }
            return envelope;
          };
          // A rebindable context (MCP roots binder) pins the whole handler to
          // one context generation, so a roots/list_changed rebind during an
          // await cannot switch this call to another workspace or close its
          // database under it.
          const pinning = toolCallPinningOf(context);
          const envelope =
            pinning === undefined ? await runHandler() : await pinning.runPinned(runHandler);
          return envelopeResult(envelope);
        } catch (error) {
          if (error instanceof CausorynToolError) {
            if (
              error.code === "INDEX_NOT_READY" &&
              !registration.name.startsWith("causoryn_wiki_")
            ) {
              const activeJob = activeIndexingJobOf(context);
              if (activeJob !== null) {
                const indexingEnvelope = buildEnvelope({
                  requestId,
                  workspaceId: context.config.workspaceId,
                  snapshotId: null,
                  status: "partial",
                  coverage: null,
                  warnings: [
                    `Workspace indexing is still in progress (jobId=${activeJob.jobId}, phase=${activeJob.phase}, progress=${String(activeJob.progressPercent)}%). Retry after ${String(DEFAULT_INDEX_RETRY_AFTER_MS)}ms or check causoryn_status.`,
                  ],
                  data: {
                    indexing: true,
                    status: "indexing",
                    jobId: activeJob.jobId,
                    progress: {
                      phase: activeJob.phase,
                      completed: activeJob.progressPercent,
                      total: 100,
                    },
                    retryAfterMs: DEFAULT_INDEX_RETRY_AFTER_MS,
                  },
                });
                return envelopeResult(indexingEnvelope);
              }
            }
            context.logger(
              `tool ${registration.name} envelope error: ${error.code}: ${error.message}`,
            );
            return envelopeResult(
              errorEnvelope(requestId, context.config.workspaceId, null, error),
            );
          }
          const detail = error instanceof Error ? error.message : String(error);
          context.logger(`tool ${registration.name} unexpected error: ${detail}`);
          return envelopeResult(
            errorEnvelope(
              requestId,
              context.config.workspaceId,
              null,
              new CausorynToolError(
                "INTERNAL_ERROR",
                `Unexpected internal error; inspect server stderr logs (requestId: ${requestId})`,
              ),
            ),
          );
        }
      },
    );
  }
  return server;
}
