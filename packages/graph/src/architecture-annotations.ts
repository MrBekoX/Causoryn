import { z } from "zod";

import type { SnapshotGraph } from "@causoryn/domain";

import { GraphRepositoryError } from "./errors.js";
import type { ArchitectureProjection } from "./architecture-projection.js";

/**
 * Host-LLM mimari anotasyon şeması ve fail-closed doğrulama katmanı (Yaklaşım B).
 *
 * Causoryn çekirdeği %100 deterministik ve LLM-free kalır (ADR-002 / kırmızı
 * çizgi 1). Platformdaki LLM (Claude Code, Codex, Antigravity, ZCode) önce
 * Causoryn MCP araçlarıyla projeyi keşfeder, ardından bu şemaya uyan kanıt-temelli
 * anotasyonları `causoryn_export_documentation` aracına geçirir.
 *
 * Güvenlik ve doğruluk garantileri:
 * 1. Kaynak bütçesi: tüm diziler ve metin alanları sıkı üst sınırlıdır (DoS yok).
 * 2. Fail-closed grounding: her `moduleId`, `nodeId`, `evidenceId` ve `keyFiles`
 *    yolu gerçek projeksiyon/snapshot üzerinde doğrulanır; uydurma bileşen veya
 *    dosya yolu `export/invalid-annotations` (MCP: `INVALID_ARGUMENT`) ile reddedilir.
 * 3. Kanonik normalizasyon: girdinin sırasından bağımsız deterministik sıralama.
 */

export const ANNOTATION_LIMITS = {
  maxTitleChars: 160,
  maxSummaryChars: 2000,
  maxStyleChars: 120,
  maxDomains: 24,
  maxModuleNotes: 120,
  maxFlows: 20,
  maxFlowSteps: 24,
  maxGuidedTourSteps: 30,
  maxDecisions: 24,
  maxRisks: 24,
  maxKeyFilesPerModule: 12,
  maxRefsPerItem: 24,
  maxTextChars: 1200,
  maxShortChars: 240,
} as const;

const NonEmptyBounded = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v.trim().length > 0, {
      message: "Field must not be empty or whitespace-only",
    });

export const ArchitectureDomainAnnotationSchema = z
  .strictObject({
    id: NonEmptyBounded(80).describe("Unique slug identifier for this logical domain/subsystem (e.g., 'auth', 'billing')."),
    name: NonEmptyBounded(120).describe("Human-readable domain or subsystem display name."),
    description: NonEmptyBounded(ANNOTATION_LIMITS.maxTextChars).describe(
      "Evidence-grounded summary of the domain's responsibility and boundaries.",
    ),
    layer: NonEmptyBounded(80)
      .optional()
      .describe("Optional architectural layer label (e.g., 'Presentation', 'Application', 'Domain', 'Infrastructure')."),
    moduleIds: z
      .array(NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars))
      .min(1)
      .max(100)
      .describe("Disjoint list of canonical moduleIds taken verbatim from architectureSummary.moduleIds (each moduleId may appear in at most one domain)."),
  })
  .describe("Logical domain or layer cluster grouping canonical architecture modules.");

export const ArchitectureModuleNoteAnnotationSchema = z
  .strictObject({
    moduleId: NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars).describe(
      "Canonical moduleId taken verbatim from architectureSummary.moduleIds.",
    ),
    summary: NonEmptyBounded(ANNOTATION_LIMITS.maxTextChars).describe(
      "Concise, evidence-grounded summary of what this module does.",
    ),
    responsibility: NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars)
      .optional()
      .describe("Short single-phrase architectural responsibility label for the module card."),
    layer: NonEmptyBounded(80)
      .optional()
      .describe("Optional architectural layer classification for this module."),
    keyFiles: z
      .array(NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars))
      .max(ANNOTATION_LIMITS.maxKeyFilesPerModule)
      .optional()
      .describe("Verified relative workspace file paths belonging to this module in the snapshot (validated fail-closed)."),
  })
  .describe("Per-module explanation card grounded in Causoryn MCP evidence.");

export const ArchitectureFlowStepAnnotationSchema = z
  .strictObject({
    moduleId: NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars)
      .optional()
      .describe("Optional canonical moduleId from architectureSummary.moduleIds highlighted by this step."),
    nodeId: NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars)
      .optional()
      .describe("Optional verified snapshot graph nodeId returned by Causoryn MCP tools."),
    label: NonEmptyBounded(160).describe("Short step title or action label."),
    explanation: NonEmptyBounded(ANNOTATION_LIMITS.maxTextChars).describe(
      "Evidence-grounded explanation of what happens at this step in the flow.",
    ),
  })
  .describe("Single ordered step inside an end-to-end execution or business flow.");

export const ArchitectureFlowAnnotationSchema = z
  .strictObject({
    id: NonEmptyBounded(80).describe("Unique slug identifier for this flow (e.g., 'checkout-request')."),
    title: NonEmptyBounded(160).describe("Human-readable title of the end-to-end request or business flow."),
    description: NonEmptyBounded(ANNOTATION_LIMITS.maxTextChars).describe(
      "High-level overview of the trigger, path, and outcome of this flow.",
    ),
    steps: z
      .array(ArchitectureFlowStepAnnotationSchema)
      .min(1)
      .max(ANNOTATION_LIMITS.maxFlowSteps)
      .describe("Ordered list of traced steps referencing verified moduleIds and/or nodeIds."),
  })
  .describe("End-to-end execution or business flow rendered in the interactive portal and Markdown brief.");

export const ArchitectureGuidedTourStepSchema = z
  .strictObject({
    step: z
      .number()
      .int()
      .positive()
      .max(1000)
      .describe("1-based sequential onboarding stop number."),
    title: NonEmptyBounded(160).describe("Short headline for this onboarding tour stop."),
    targetModuleId: NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars)
      .optional()
      .describe("Optional canonical moduleId from architectureSummary.moduleIds to spotlight."),
    targetNodeId: NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars)
      .optional()
      .describe("Optional verified snapshot graph nodeId to spotlight."),
    explanation: NonEmptyBounded(ANNOTATION_LIMITS.maxTextChars).describe(
      "Onboarding narrative explaining why a newcomer should inspect this module or symbol now.",
    ),
  })
  .describe("Ordered stop in the interactive Guided Onboarding Tour.");

export const ArchitectureDecisionAnnotationSchema = z
  .strictObject({
    id: NonEmptyBounded(80).describe("Unique decision identifier (e.g., 'ADR-001' or 'DEC-01')."),
    title: NonEmptyBounded(160).describe("Short title summarizing the architectural decision."),
    summary: NonEmptyBounded(ANNOTATION_LIMITS.maxTextChars).describe(
      "Concrete description of the observed architectural decision.",
    ),
    rationale: NonEmptyBounded(ANNOTATION_LIMITS.maxTextChars)
      .optional()
      .describe("Optional rationale or trade-off explanation grounded in repository evidence."),
    relatedModuleIds: z
      .array(NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars))
      .max(ANNOTATION_LIMITS.maxRefsPerItem)
      .optional()
      .describe("Optional canonical moduleIds from architectureSummary.moduleIds affected by this decision."),
    evidenceIds: z
      .array(NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars))
      .max(ANNOTATION_LIMITS.maxRefsPerItem)
      .optional()
      .describe("Optional verified evidenceIds returned by causoryn_get_evidence (validated fail-closed)."),
  })
  .describe("Observed architectural decision linked to verified modules and evidence.");

export const ArchitectureRiskAnnotationSchema = z
  .strictObject({
    id: NonEmptyBounded(80).describe("Unique risk identifier (e.g., 'RISK-01')."),
    title: NonEmptyBounded(160).describe("Short title summarizing the structural or coverage risk."),
    severity: z
      .enum(["low", "medium", "high"])
      .describe("Risk severity level ('low', 'medium', or 'high')."),
    summary: NonEmptyBounded(ANNOTATION_LIMITS.maxTextChars).describe(
      "Evidence-grounded explanation of the risk (e.g., SCC cycle, fan-in hotspot, unresolved dynamic edges).",
    ),
    relatedModuleIds: z
      .array(NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars))
      .max(ANNOTATION_LIMITS.maxRefsPerItem)
      .optional()
      .describe("Optional canonical moduleIds from architectureSummary.moduleIds impacted by this risk."),
    evidenceIds: z
      .array(NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars))
      .max(ANNOTATION_LIMITS.maxRefsPerItem)
      .optional()
      .describe("Optional verified evidenceIds returned by causoryn_get_evidence (validated fail-closed)."),
  })
  .describe("Observed architectural, coupling, or coverage risk linked to verified modules and evidence.");

export const ArchitectureAnnotationsSchema = z
  .strictObject({
    title: NonEmptyBounded(ANNOTATION_LIMITS.maxTitleChars)
      .optional()
      .describe("Custom portal/brief title summarizing the target system."),
    architectureStyle: NonEmptyBounded(ANNOTATION_LIMITS.maxStyleChars)
      .optional()
      .describe("Observed architecture pattern label (e.g., 'Modular Monolith', 'Clean Architecture + Microservices')."),
    executiveSummary: NonEmptyBounded(ANNOTATION_LIMITS.maxSummaryChars)
      .optional()
      .describe("2–4 sentence synthesis of core subsystems, stack, and explicit coverage/unresolved caveats."),
    domains: z
      .array(ArchitectureDomainAnnotationSchema)
      .max(ANNOTATION_LIMITS.maxDomains)
      .optional()
      .describe("Disjoint logical subsystem/layer groupings referencing canonical architectureSummary.moduleIds."),
    moduleNotes: z
      .array(ArchitectureModuleNoteAnnotationSchema)
      .max(ANNOTATION_LIMITS.maxModuleNotes)
      .optional()
      .describe("Per-module responsibilities, summaries, and verified keyFiles for canonical moduleIds."),
    flows: z
      .array(ArchitectureFlowAnnotationSchema)
      .max(ANNOTATION_LIMITS.maxFlows)
      .optional()
      .describe("2–6 traced end-to-end execution or business flows referencing verified moduleIds/nodeIds."),
    guidedTour: z
      .array(ArchitectureGuidedTourStepSchema)
      .max(ANNOTATION_LIMITS.maxGuidedTourSteps)
      .optional()
      .describe("Numbered onboarding walkthrough sequence highlighting canonical modules or symbols."),
    decisions: z
      .array(ArchitectureDecisionAnnotationSchema)
      .max(ANNOTATION_LIMITS.maxDecisions)
      .optional()
      .describe("Observed architectural decisions backed by relatedModuleIds and evidenceIds."),
    risks: z
      .array(ArchitectureRiskAnnotationSchema)
      .max(ANNOTATION_LIMITS.maxRisks)
      .optional()
      .describe("Concrete architectural or coverage risks backed by relatedModuleIds and evidenceIds."),
  })
  .describe(
    "Optional Host-LLM annotations synthesized from Causoryn MCP evidence and validated fail-closed against the published snapshot (omit for a pure structural model-free export).",
  );

export type ArchitectureAnnotations = z.infer<typeof ArchitectureAnnotationsSchema>;
export type ArchitectureDomainAnnotation = z.infer<typeof ArchitectureDomainAnnotationSchema>;
export type ArchitectureModuleNoteAnnotation = z.infer<
  typeof ArchitectureModuleNoteAnnotationSchema
>;
export type ArchitectureFlowAnnotation = z.infer<typeof ArchitectureFlowAnnotationSchema>;
export type ArchitectureGuidedTourStep = z.infer<typeof ArchitectureGuidedTourStepSchema>;
export type ArchitectureDecisionAnnotation = z.infer<typeof ArchitectureDecisionAnnotationSchema>;
export type ArchitectureRiskAnnotation = z.infer<typeof ArchitectureRiskAnnotationSchema>;

export interface ValidatedArchitectureAnnotations {
  readonly title?: string;
  readonly architectureStyle?: string;
  readonly executiveSummary?: string;
  readonly domains: readonly ArchitectureDomainAnnotation[];
  readonly moduleNotes: readonly ArchitectureModuleNoteAnnotation[];
  readonly flows: readonly ArchitectureFlowAnnotation[];
  readonly guidedTour: readonly ArchitectureGuidedTourStep[];
  readonly decisions: readonly ArchitectureDecisionAnnotation[];
  readonly risks: readonly ArchitectureRiskAnnotation[];
}

function cmpStr(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(cmpStr);
}

export const MAX_VALIDATION_ERRORS = 25;

/** Upper bound on raw array inspection during fallback error accumulation (DoS guard). */
const MAX_RAW_SECTION_SCAN = 256;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function extractNonEmptyStrings(value: unknown, maxScan: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const limit = Math.min(value.length, maxScan);
  for (let i = 0; i < limit; i += 1) {
    const s = nonEmptyString(value[i]);
    if (s !== undefined) out.push(s);
  }
  return out;
}

function invalidAnnotations(message: string): never {
  throw new GraphRepositoryError("export/invalid-annotations", message);
}

function normalizePosixPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized.charCodeAt(start) === 47) start += 1;
  while (end > start && normalized.charCodeAt(end - 1) === 47) end -= 1;
  return normalized.slice(start, end);
}

const EXCLUDED_GROUNDING_NODE_KINDS: ReadonlySet<string> = new Set([
  "Workspace",
  "Repository",
  "UnknownExternal",
]);

/**
 * Host-LLM anotasyonlarını hem Zod şemasına hem de gerçek snapshot/projeksiyon
 * kimliklerine karşı fail-closed doğrular ve deterministik kanonik forma çevirir.
 *
 * Tek geçişte TÜM Zod şema sorunlarını VE TÜM kırık grafik/modül/sembol/kanıt/dosya
 * referans hatalarını toplar (en fazla `MAX_VALIDATION_ERRORS = 25`, aşılırsa özet
 * satırıyla) ve tek bir eyleme dönüştürülebilir `export/invalid-annotations` hatası atar.
 */
export function validateArchitectureAnnotations(
  raw: unknown,
  projection: ArchitectureProjection,
  snapshot: SnapshotGraph,
): ValidatedArchitectureAnnotations {
  const errors: string[] = [];
  let totalErrorCount = 0;
  const recordError = (message: string): void => {
    totalErrorCount += 1;
    if (errors.length < MAX_VALIDATION_ERRORS) {
      errors.push(message);
    }
  };

  // 1) Zod schema validation: collect ALL issues (do not stop on issue[0]).
  const parsed = ArchitectureAnnotationsSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const pathStr = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      recordError(`${pathStr}: ${issue.message}`);
    }
  }

  // 2) Build active grounding index from projection + snapshot.
  const moduleIds = new Set(projection.modules.map((m) => m.id));
  const moduleFilesById = new Map<string, ReadonlySet<string>>(
    projection.modules.map((m) => [m.id, new Set(m.files.map(normalizePosixPath))]),
  );
  const activeProjectedFiles = new Set<string>();
  for (const mod of projection.modules) {
    for (const f of mod.files) activeProjectedFiles.add(normalizePosixPath(f));
  }
  const activeSnapshotNodeIds = new Set<string>();
  const snapshotFilePaths = new Set<string>();
  for (const node of snapshot.nodes) {
    if (EXCLUDED_GROUNDING_NODE_KINDS.has(node.kind)) continue;
    if (node.location?.relativePath !== undefined) {
      const norm = normalizePosixPath(node.location.relativePath);
      snapshotFilePaths.add(norm);
      if (activeProjectedFiles.size === 0 || activeProjectedFiles.has(norm)) {
        activeSnapshotNodeIds.add(node.id);
      }
    } else if (projection.summary.pathPrefixApplied === undefined) {
      activeSnapshotNodeIds.add(node.id);
    }
  }
  const snapshotEvidenceIds = new Set(snapshot.evidence.map((e) => e.id));

  const checkModuleExists = (id: string, fieldPath: string): void => {
    if (!moduleIds.has(id)) {
      recordError(
        `${fieldPath}: unknown moduleId "${id}" (use canonical IDs from architectureSummary.moduleIds)`,
      );
    }
  };
  const checkNodeExists = (id: string, fieldPath: string): void => {
    if (!activeSnapshotNodeIds.has(id)) {
      recordError(`${fieldPath}: unknown or out-of-scope nodeId "${id}"`);
    }
  };
  const checkEvidenceExists = (id: string, fieldPath: string): void => {
    if (!snapshotEvidenceIds.has(id)) {
      recordError(`${fieldPath}: unknown evidenceId "${id}"`);
    }
  };
  const checkKeyFiles = (modId: string, keyFiles: readonly string[], fieldPath: string): void => {
    const modFiles = moduleFilesById.get(modId);
    for (const relFile of keyFiles) {
      const validInModule =
        modFiles !== undefined && modFiles.size > 0
          ? modFiles.has(relFile)
          : snapshotFilePaths.has(relFile);
      if (!validInModule) {
        recordError(
          `${fieldPath}: unknown or out-of-module keyFile "${relFile}" for module "${modId}"`,
        );
      }
    }
  };

  // Helper to throw one consolidated fail-closed error when any issue was collected.
  const throwIfErrors = (): void => {
    if (totalErrorCount > 0 || !parsed.success) {
      const count = Math.max(totalErrorCount, 1);
      const header = `Invalid architecture annotations (${String(count)} ${count === 1 ? "error" : "errors"}):`;
      const lines = errors.map((err, i) => `  ${String(i + 1)}. ${err}`);
      if (totalErrorCount > MAX_VALIDATION_ERRORS) {
        lines.push(
          `  ... and ${String(totalErrorCount - MAX_VALIDATION_ERRORS)} more error(s) (truncated at ${String(MAX_VALIDATION_ERRORS)})`,
        );
      }
      invalidAnnotations(`${header}\n${lines.join("\n")}`);
    }
  };

  // 3) If Zod failed on a plain-object payload, STILL inspect all sections defensively so
  //    both schema errors and broken graph-ID references are reported in a single pass.
  if (!parsed.success) {
    if (isPlainRecord(raw)) {
      const seenDomainIds = new Set<string>();
      const claimedModules = new Set<string>();
      if (Array.isArray(raw["domains"])) {
        const rawDomains = raw["domains"];
        const limit = Math.min(rawDomains.length, MAX_RAW_SECTION_SCAN);
        for (let idx = 0; idx < limit; idx += 1) {
          const item = rawDomains[idx];
          if (!isPlainRecord(item)) continue;
          const domId = nonEmptyString(item["id"]);
          const label = domId ?? String(idx);
          if (domId !== undefined) {
            if (seenDomainIds.has(domId)) {
              recordError(`domains[${String(idx)}].id: duplicate domain id "${domId}"`);
            }
            seenDomainIds.add(domId);
          }
          for (const modId of uniqueSorted(extractNonEmptyStrings(item["moduleIds"], MAX_RAW_SECTION_SCAN))) {
            checkModuleExists(modId, `domains[${label}].moduleIds`);
            if (claimedModules.has(modId)) {
              recordError(
                `domains[${label}].moduleIds: module "${modId}" is already assigned to another domain`,
              );
            }
            claimedModules.add(modId);
          }
        }
      }

      const seenNoteModules = new Set<string>();
      if (Array.isArray(raw["moduleNotes"])) {
        const rawNotes = raw["moduleNotes"];
        const limit = Math.min(rawNotes.length, MAX_RAW_SECTION_SCAN);
        for (let idx = 0; idx < limit; idx += 1) {
          const item = rawNotes[idx];
          if (!isPlainRecord(item)) continue;
          const modId = nonEmptyString(item["moduleId"]);
          if (modId !== undefined) {
            if (seenNoteModules.has(modId)) {
              recordError(`moduleNotes[${String(idx)}].moduleId: duplicate moduleNotes entry "${modId}"`);
            }
            seenNoteModules.add(modId);
            checkModuleExists(modId, `moduleNotes[${String(idx)}].moduleId`);
            const keyFiles = uniqueSorted(
              extractNonEmptyStrings(item["keyFiles"], ANNOTATION_LIMITS.maxKeyFilesPerModule * 2).map(
                normalizePosixPath,
              ),
            );
            checkKeyFiles(modId, keyFiles, `moduleNotes[${modId}].keyFiles`);
          }
        }
      }

      const seenFlowIds = new Set<string>();
      if (Array.isArray(raw["flows"])) {
        const rawFlows = raw["flows"];
        const limit = Math.min(rawFlows.length, MAX_RAW_SECTION_SCAN);
        for (let idx = 0; idx < limit; idx += 1) {
          const item = rawFlows[idx];
          if (!isPlainRecord(item)) continue;
          const flowId = nonEmptyString(item["id"]);
          const label = flowId ?? String(idx);
          if (flowId !== undefined) {
            if (seenFlowIds.has(flowId)) {
              recordError(`flows[${String(idx)}].id: duplicate flow id "${flowId}"`);
            }
            seenFlowIds.add(flowId);
          }
          if (Array.isArray(item["steps"])) {
            const stepsLimit = Math.min(item["steps"].length, MAX_RAW_SECTION_SCAN);
            for (let sIdx = 0; sIdx < stepsLimit; sIdx += 1) {
              const step = item["steps"][sIdx];
              if (!isPlainRecord(step)) continue;
              const stepMod = nonEmptyString(step["moduleId"]);
              const stepNode = nonEmptyString(step["nodeId"]);
              if (stepMod !== undefined) {
                checkModuleExists(stepMod, `flows[${label}].steps[${String(sIdx)}].moduleId`);
              }
              if (stepNode !== undefined) {
                checkNodeExists(stepNode, `flows[${label}].steps[${String(sIdx)}].nodeId`);
              }
            }
          }
        }
      }

      if (Array.isArray(raw["guidedTour"])) {
        const rawTour = raw["guidedTour"];
        const limit = Math.min(rawTour.length, MAX_RAW_SECTION_SCAN);
        for (let idx = 0; idx < limit; idx += 1) {
          const stop = rawTour[idx];
          if (!isPlainRecord(stop)) continue;
          const targetMod = nonEmptyString(stop["targetModuleId"]);
          const targetNode = nonEmptyString(stop["targetNodeId"]);
          if (targetMod !== undefined) {
            checkModuleExists(targetMod, `guidedTour[${String(idx)}].targetModuleId`);
          }
          if (targetNode !== undefined) {
            checkNodeExists(targetNode, `guidedTour[${String(idx)}].targetNodeId`);
          }
        }
      }

      const seenDecisionIds = new Set<string>();
      if (Array.isArray(raw["decisions"])) {
        const rawDecisions = raw["decisions"];
        const limit = Math.min(rawDecisions.length, MAX_RAW_SECTION_SCAN);
        for (let idx = 0; idx < limit; idx += 1) {
          const dec = rawDecisions[idx];
          if (!isPlainRecord(dec)) continue;
          const decId = nonEmptyString(dec["id"]);
          const label = decId ?? String(idx);
          if (decId !== undefined) {
            if (seenDecisionIds.has(decId)) {
              recordError(`decisions[${String(idx)}].id: duplicate decision id "${decId}"`);
            }
            seenDecisionIds.add(decId);
          }
          for (const m of uniqueSorted(extractNonEmptyStrings(dec["relatedModuleIds"], MAX_RAW_SECTION_SCAN))) {
            checkModuleExists(m, `decisions[${label}].relatedModuleIds`);
          }
          for (const e of uniqueSorted(extractNonEmptyStrings(dec["evidenceIds"], MAX_RAW_SECTION_SCAN))) {
            checkEvidenceExists(e, `decisions[${label}].evidenceIds`);
          }
        }
      }

      const seenRiskIds = new Set<string>();
      if (Array.isArray(raw["risks"])) {
        const rawRisks = raw["risks"];
        const limit = Math.min(rawRisks.length, MAX_RAW_SECTION_SCAN);
        for (let idx = 0; idx < limit; idx += 1) {
          const risk = rawRisks[idx];
          if (!isPlainRecord(risk)) continue;
          const riskId = nonEmptyString(risk["id"]);
          const label = riskId ?? String(idx);
          if (riskId !== undefined) {
            if (seenRiskIds.has(riskId)) {
              recordError(`risks[${String(idx)}].id: duplicate risk id "${riskId}"`);
            }
            seenRiskIds.add(riskId);
          }
          for (const m of uniqueSorted(extractNonEmptyStrings(risk["relatedModuleIds"], MAX_RAW_SECTION_SCAN))) {
            checkModuleExists(m, `risks[${label}].relatedModuleIds`);
          }
          for (const e of uniqueSorted(extractNonEmptyStrings(risk["evidenceIds"], MAX_RAW_SECTION_SCAN))) {
            checkEvidenceExists(e, `risks[${label}].evidenceIds`);
          }
        }
      }
    }
    throwIfErrors();
  }

  const input = parsed.data!;

  // 4. Domains: unique id, valid moduleIds, disjoint partition across domains
  const seenDomainIds = new Set<string>();
  const claimedModules = new Set<string>();
  const domains: ArchitectureDomainAnnotation[] = [];
  for (const [idx, domain] of (input.domains ?? []).entries()) {
    if (seenDomainIds.has(domain.id)) {
      recordError(`domains[${String(idx)}].id: duplicate domain id "${domain.id}"`);
    }
    seenDomainIds.add(domain.id);
    const dedupModules = uniqueSorted(domain.moduleIds);
    for (const modId of dedupModules) {
      checkModuleExists(modId, `domains[${domain.id}].moduleIds`);
      if (claimedModules.has(modId)) {
        recordError(
          `domains[${domain.id}].moduleIds: module "${modId}" is already assigned to another domain`,
        );
      }
      claimedModules.add(modId);
    }
    domains.push({
      id: domain.id,
      name: domain.name,
      description: domain.description,
      ...(domain.layer === undefined ? {} : { layer: domain.layer }),
      moduleIds: dedupModules,
    });
  }
  domains.sort((a, b) => cmpStr(a.id, b.id));

  // 5. Module notes: unique moduleId, valid moduleId, valid keyFiles
  const seenNoteModules = new Set<string>();
  const moduleNotes: ArchitectureModuleNoteAnnotation[] = [];
  for (const [idx, note] of (input.moduleNotes ?? []).entries()) {
    if (seenNoteModules.has(note.moduleId)) {
      recordError(
        `moduleNotes[${String(idx)}].moduleId: duplicate moduleNotes entry "${note.moduleId}"`,
      );
    }
    seenNoteModules.add(note.moduleId);
    checkModuleExists(note.moduleId, `moduleNotes[${String(idx)}].moduleId`);
    let normalizedKeyFiles: string[] | undefined;
    if (note.keyFiles !== undefined) {
      normalizedKeyFiles = uniqueSorted(note.keyFiles.map(normalizePosixPath));
      checkKeyFiles(note.moduleId, normalizedKeyFiles, `moduleNotes[${note.moduleId}].keyFiles`);
    }
    moduleNotes.push({
      moduleId: note.moduleId,
      summary: note.summary,
      ...(note.responsibility === undefined ? {} : { responsibility: note.responsibility }),
      ...(note.layer === undefined ? {} : { layer: note.layer }),
      ...(normalizedKeyFiles === undefined ? {} : { keyFiles: normalizedKeyFiles }),
    });
  }
  moduleNotes.sort((a, b) => cmpStr(a.moduleId, b.moduleId));

  // 6. Flows: unique id, valid step moduleId/nodeId (step order preserved!)
  const seenFlowIds = new Set<string>();
  const flows: ArchitectureFlowAnnotation[] = [];
  for (const [idx, flow] of (input.flows ?? []).entries()) {
    if (seenFlowIds.has(flow.id)) {
      recordError(`flows[${String(idx)}].id: duplicate flow id "${flow.id}"`);
    }
    seenFlowIds.add(flow.id);
    for (const [stepIdx, step] of flow.steps.entries()) {
      if (step.moduleId !== undefined) {
        checkModuleExists(step.moduleId, `flows[${flow.id}].steps[${String(stepIdx)}].moduleId`);
      }
      if (step.nodeId !== undefined) {
        checkNodeExists(step.nodeId, `flows[${flow.id}].steps[${String(stepIdx)}].nodeId`);
      }
    }
    flows.push({
      id: flow.id,
      title: flow.title,
      description: flow.description,
      steps: flow.steps.map((s) => ({
        ...(s.moduleId === undefined ? {} : { moduleId: s.moduleId }),
        ...(s.nodeId === undefined ? {} : { nodeId: s.nodeId }),
        label: s.label,
        explanation: s.explanation,
      })),
    });
  }
  flows.sort((a, b) => cmpStr(a.id, b.id));

  // 7. Guided tour: sorted by step asc, title asc; valid moduleId/nodeId
  const guidedTour: ArchitectureGuidedTourStep[] = [];
  for (const [idx, stop] of (input.guidedTour ?? []).entries()) {
    if (stop.targetModuleId !== undefined) {
      checkModuleExists(stop.targetModuleId, `guidedTour[${String(idx)}].targetModuleId`);
    }
    if (stop.targetNodeId !== undefined) {
      checkNodeExists(stop.targetNodeId, `guidedTour[${String(idx)}].targetNodeId`);
    }
    guidedTour.push({
      step: stop.step,
      title: stop.title,
      ...(stop.targetModuleId === undefined ? {} : { targetModuleId: stop.targetModuleId }),
      ...(stop.targetNodeId === undefined ? {} : { targetNodeId: stop.targetNodeId }),
      explanation: stop.explanation,
    });
  }
  guidedTour.sort((a, b) => {
    if (a.step !== b.step) return a.step - b.step;
    const t = cmpStr(a.title, b.title);
    if (t !== 0) return t;
    const m = cmpStr(a.targetModuleId ?? "", b.targetModuleId ?? "");
    if (m !== 0) return m;
    const n = cmpStr(a.targetNodeId ?? "", b.targetNodeId ?? "");
    if (n !== 0) return n;
    return cmpStr(a.explanation, b.explanation);
  });

  // 8. Decisions: unique id, valid relatedModuleIds & evidenceIds
  const seenDecisionIds = new Set<string>();
  const decisions: ArchitectureDecisionAnnotation[] = [];
  for (const [idx, dec] of (input.decisions ?? []).entries()) {
    if (seenDecisionIds.has(dec.id)) {
      recordError(`decisions[${String(idx)}].id: duplicate decision id "${dec.id}"`);
    }
    seenDecisionIds.add(dec.id);
    const relMods = dec.relatedModuleIds === undefined ? undefined : uniqueSorted(dec.relatedModuleIds);
    const evIds = dec.evidenceIds === undefined ? undefined : uniqueSorted(dec.evidenceIds);
    for (const m of relMods ?? []) checkModuleExists(m, `decisions[${dec.id}].relatedModuleIds`);
    for (const e of evIds ?? []) checkEvidenceExists(e, `decisions[${dec.id}].evidenceIds`);
    decisions.push({
      id: dec.id,
      title: dec.title,
      summary: dec.summary,
      ...(dec.rationale === undefined ? {} : { rationale: dec.rationale }),
      ...(relMods === undefined ? {} : { relatedModuleIds: relMods }),
      ...(evIds === undefined ? {} : { evidenceIds: evIds }),
    });
  }
  decisions.sort((a, b) => cmpStr(a.id, b.id));

  // 9. Risks: unique id, valid relatedModuleIds & evidenceIds
  const seenRiskIds = new Set<string>();
  const risks: ArchitectureRiskAnnotation[] = [];
  for (const [idx, risk] of (input.risks ?? []).entries()) {
    if (seenRiskIds.has(risk.id)) {
      recordError(`risks[${String(idx)}].id: duplicate risk id "${risk.id}"`);
    }
    seenRiskIds.add(risk.id);
    const relMods = risk.relatedModuleIds === undefined ? undefined : uniqueSorted(risk.relatedModuleIds);
    const evIds = risk.evidenceIds === undefined ? undefined : uniqueSorted(risk.evidenceIds);
    for (const m of relMods ?? []) checkModuleExists(m, `risks[${risk.id}].relatedModuleIds`);
    for (const e of evIds ?? []) checkEvidenceExists(e, `risks[${risk.id}].evidenceIds`);
    risks.push({
      id: risk.id,
      title: risk.title,
      severity: risk.severity,
      summary: risk.summary,
      ...(relMods === undefined ? {} : { relatedModuleIds: relMods }),
      ...(evIds === undefined ? {} : { evidenceIds: evIds }),
    });
  }
  risks.sort((a, b) => cmpStr(a.id, b.id));

  // Fail-closed: if ANY schema or grounding error was collected, reject completely.
  throwIfErrors();

  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.architectureStyle === undefined ? {} : { architectureStyle: input.architectureStyle }),
    ...(input.executiveSummary === undefined ? {} : { executiveSummary: input.executiveSummary }),
    domains,
    moduleNotes,
    flows,
    guidedTour,
    decisions,
    risks,
  };
}
