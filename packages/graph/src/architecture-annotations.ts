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
      message: "Alan boş veya yalnızca boşluk olamaz",
    });

export const ArchitectureDomainAnnotationSchema = z.strictObject({
  id: NonEmptyBounded(80),
  name: NonEmptyBounded(120),
  description: NonEmptyBounded(ANNOTATION_LIMITS.maxTextChars),
  layer: NonEmptyBounded(80).optional(),
  moduleIds: z.array(NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars)).min(1).max(100),
});

export const ArchitectureModuleNoteAnnotationSchema = z.strictObject({
  moduleId: NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars),
  summary: NonEmptyBounded(ANNOTATION_LIMITS.maxTextChars),
  responsibility: NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars).optional(),
  layer: NonEmptyBounded(80).optional(),
  keyFiles: z
    .array(NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars))
    .max(ANNOTATION_LIMITS.maxKeyFilesPerModule)
    .optional(),
});

export const ArchitectureFlowStepAnnotationSchema = z.strictObject({
  moduleId: NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars).optional(),
  nodeId: NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars).optional(),
  label: NonEmptyBounded(160),
  explanation: NonEmptyBounded(ANNOTATION_LIMITS.maxTextChars),
});

export const ArchitectureFlowAnnotationSchema = z.strictObject({
  id: NonEmptyBounded(80),
  title: NonEmptyBounded(160),
  description: NonEmptyBounded(ANNOTATION_LIMITS.maxTextChars),
  steps: z.array(ArchitectureFlowStepAnnotationSchema).min(1).max(ANNOTATION_LIMITS.maxFlowSteps),
});

export const ArchitectureGuidedTourStepSchema = z.strictObject({
  step: z.number().int().positive().max(1000),
  title: NonEmptyBounded(160),
  targetModuleId: NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars).optional(),
  targetNodeId: NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars).optional(),
  explanation: NonEmptyBounded(ANNOTATION_LIMITS.maxTextChars),
});

export const ArchitectureDecisionAnnotationSchema = z.strictObject({
  id: NonEmptyBounded(80),
  title: NonEmptyBounded(160),
  summary: NonEmptyBounded(ANNOTATION_LIMITS.maxTextChars),
  rationale: NonEmptyBounded(ANNOTATION_LIMITS.maxTextChars).optional(),
  relatedModuleIds: z
    .array(NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars))
    .max(ANNOTATION_LIMITS.maxRefsPerItem)
    .optional(),
  evidenceIds: z
    .array(NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars))
    .max(ANNOTATION_LIMITS.maxRefsPerItem)
    .optional(),
});

export const ArchitectureRiskAnnotationSchema = z.strictObject({
  id: NonEmptyBounded(80),
  title: NonEmptyBounded(160),
  severity: z.enum(["low", "medium", "high"]),
  summary: NonEmptyBounded(ANNOTATION_LIMITS.maxTextChars),
  relatedModuleIds: z
    .array(NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars))
    .max(ANNOTATION_LIMITS.maxRefsPerItem)
    .optional(),
  evidenceIds: z
    .array(NonEmptyBounded(ANNOTATION_LIMITS.maxShortChars))
    .max(ANNOTATION_LIMITS.maxRefsPerItem)
    .optional(),
});

export const ArchitectureAnnotationsSchema = z.strictObject({
  title: NonEmptyBounded(ANNOTATION_LIMITS.maxTitleChars).optional(),
  architectureStyle: NonEmptyBounded(ANNOTATION_LIMITS.maxStyleChars).optional(),
  executiveSummary: NonEmptyBounded(ANNOTATION_LIMITS.maxSummaryChars).optional(),
  domains: z.array(ArchitectureDomainAnnotationSchema).max(ANNOTATION_LIMITS.maxDomains).optional(),
  moduleNotes: z
    .array(ArchitectureModuleNoteAnnotationSchema)
    .max(ANNOTATION_LIMITS.maxModuleNotes)
    .optional(),
  flows: z.array(ArchitectureFlowAnnotationSchema).max(ANNOTATION_LIMITS.maxFlows).optional(),
  guidedTour: z
    .array(ArchitectureGuidedTourStepSchema)
    .max(ANNOTATION_LIMITS.maxGuidedTourSteps)
    .optional(),
  decisions: z
    .array(ArchitectureDecisionAnnotationSchema)
    .max(ANNOTATION_LIMITS.maxDecisions)
    .optional(),
  risks: z.array(ArchitectureRiskAnnotationSchema).max(ANNOTATION_LIMITS.maxRisks).optional(),
});

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

function invalidAnnotations(message: string): never {
  throw new GraphRepositoryError("export/invalid-annotations", message);
}

function normalizePosixPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

const EXCLUDED_GROUNDING_NODE_KINDS: ReadonlySet<string> = new Set([
  "Workspace",
  "Repository",
  "UnknownExternal",
]);

/**
 * Host-LLM anotasyonlarını hem Zod şemasına hem de gerçek snapshot/projeksiyon
 * kimliklerine karşı fail-closed doğrular ve deterministik kanonik forma çevirir.
 */
export function validateArchitectureAnnotations(
  raw: unknown,
  projection: ArchitectureProjection,
  snapshot: SnapshotGraph,
): ValidatedArchitectureAnnotations {
  const parsed = ArchitectureAnnotationsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const pathStr = issue ? issue.path.join(".") : "";
    invalidAnnotations(
      `Geçersiz mimari anotasyon şeması${pathStr.length > 0 ? ` (${pathStr})` : ""}: ${issue?.message ?? parsed.error.message}`,
    );
  }

  const input = parsed.data;
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

  const assertModuleExists = (id: string, ctx: string): void => {
    if (!moduleIds.has(id)) {
      invalidAnnotations(
        `Anotasyon bilinmeyen moduleId içeriyor (${ctx}): "${id}". Geçerli kimlikler için architectureSummary.moduleIds çıktısını kullanın.`,
      );
    }
  };
  const assertNodeExists = (id: string, ctx: string): void => {
    if (!activeSnapshotNodeIds.has(id)) {
      invalidAnnotations(`Anotasyon bilinmeyen veya kapsam-dışı nodeId içeriyor (${ctx}): "${id}"`);
    }
  };
  const assertEvidenceExists = (id: string, ctx: string): void => {
    if (!snapshotEvidenceIds.has(id)) {
      invalidAnnotations(`Anotasyon bilinmeyen evidenceId içeriyor (${ctx}): "${id}"`);
    }
  };

  // 1. Domains: unique id, valid moduleIds, disjoint partition across domains
  const seenDomainIds = new Set<string>();
  const claimedModules = new Set<string>();
  const domains: ArchitectureDomainAnnotation[] = [];
  for (const domain of input.domains ?? []) {
    if (seenDomainIds.has(domain.id)) {
      invalidAnnotations(`Tekrarlanan domain id: "${domain.id}"`);
    }
    seenDomainIds.add(domain.id);
    const dedupModules = uniqueSorted(domain.moduleIds);
    for (const modId of dedupModules) {
      assertModuleExists(modId, `domains[${domain.id}]`);
      if (claimedModules.has(modId)) {
        invalidAnnotations(`Modül birden fazla domain'e atanamaz: "${modId}"`);
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

  // 2. Module notes: unique moduleId, valid moduleId, valid keyFiles
  const seenNoteModules = new Set<string>();
  const moduleNotes: ArchitectureModuleNoteAnnotation[] = [];
  for (const note of input.moduleNotes ?? []) {
    if (seenNoteModules.has(note.moduleId)) {
      invalidAnnotations(`Tekrarlanan moduleNotes girişi: "${note.moduleId}"`);
    }
    seenNoteModules.add(note.moduleId);
    assertModuleExists(note.moduleId, "moduleNotes");
    const modFiles = moduleFilesById.get(note.moduleId);
    let normalizedKeyFiles: string[] | undefined;
    if (note.keyFiles !== undefined) {
      normalizedKeyFiles = uniqueSorted(note.keyFiles.map(normalizePosixPath));
      for (const relFile of normalizedKeyFiles) {
        const validInModule =
          modFiles !== undefined && modFiles.size > 0
            ? modFiles.has(relFile)
            : snapshotFilePaths.has(relFile);
        if (!validInModule) {
          invalidAnnotations(
            `Anotasyon modüle ait olmayan veya bilinmeyen keyFile yolu içeriyor (moduleNotes[${note.moduleId}]): "${relFile}"`,
          );
        }
      }
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

  // 3. Flows: unique id, valid step moduleId/nodeId (step order preserved!)
  const seenFlowIds = new Set<string>();
  const flows: ArchitectureFlowAnnotation[] = [];
  for (const flow of input.flows ?? []) {
    if (seenFlowIds.has(flow.id)) {
      invalidAnnotations(`Tekrarlanan flow id: "${flow.id}"`);
    }
    seenFlowIds.add(flow.id);
    for (const [idx, step] of flow.steps.entries()) {
      if (step.moduleId !== undefined) {
        assertModuleExists(step.moduleId, `flows[${flow.id}].steps[${String(idx)}]`);
      }
      if (step.nodeId !== undefined) {
        assertNodeExists(step.nodeId, `flows[${flow.id}].steps[${String(idx)}]`);
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

  // 4. Guided tour: sorted by step asc, title asc; valid moduleId/nodeId
  const guidedTour: ArchitectureGuidedTourStep[] = [];
  for (const [idx, stop] of (input.guidedTour ?? []).entries()) {
    if (stop.targetModuleId !== undefined) {
      assertModuleExists(stop.targetModuleId, `guidedTour[${String(idx)}]`);
    }
    if (stop.targetNodeId !== undefined) {
      assertNodeExists(stop.targetNodeId, `guidedTour[${String(idx)}]`);
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

  // 5. Decisions: unique id, valid relatedModuleIds & evidenceIds
  const seenDecisionIds = new Set<string>();
  const decisions: ArchitectureDecisionAnnotation[] = [];
  for (const dec of input.decisions ?? []) {
    if (seenDecisionIds.has(dec.id)) {
      invalidAnnotations(`Tekrarlanan decision id: "${dec.id}"`);
    }
    seenDecisionIds.add(dec.id);
    const relMods = dec.relatedModuleIds === undefined ? undefined : uniqueSorted(dec.relatedModuleIds);
    const evIds = dec.evidenceIds === undefined ? undefined : uniqueSorted(dec.evidenceIds);
    for (const m of relMods ?? []) assertModuleExists(m, `decisions[${dec.id}]`);
    for (const e of evIds ?? []) assertEvidenceExists(e, `decisions[${dec.id}]`);
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

  // 6. Risks: unique id, valid relatedModuleIds & evidenceIds
  const seenRiskIds = new Set<string>();
  const risks: ArchitectureRiskAnnotation[] = [];
  for (const risk of input.risks ?? []) {
    if (seenRiskIds.has(risk.id)) {
      invalidAnnotations(`Tekrarlanan risk id: "${risk.id}"`);
    }
    seenRiskIds.add(risk.id);
    const relMods = risk.relatedModuleIds === undefined ? undefined : uniqueSorted(risk.relatedModuleIds);
    const evIds = risk.evidenceIds === undefined ? undefined : uniqueSorted(risk.evidenceIds);
    for (const m of relMods ?? []) assertModuleExists(m, `risks[${risk.id}]`);
    for (const e of evIds ?? []) assertEvidenceExists(e, `risks[${risk.id}]`);
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
