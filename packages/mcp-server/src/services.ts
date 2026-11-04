import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { GraphRepository, SnapshotRead } from "@causoryn/graph";
import {
  NODE_KINDS,
  type Evidence,
  type GraphNode,
  type SnapshotGraph,
} from "@causoryn/domain";
import { INDEXED_ADAPTERS } from "@causoryn/indexing";
import type { WorkspaceAccessPolicy } from "@causoryn/workspace";
import { z } from "zod";

import { decodeCursor, encodeCursor } from "./cursor.js";
import type { CausorynServerConfig } from "./config.js";
import { CausorynToolError } from "./errors.js";
import { buildEnvelope, type Coverage, type Envelope } from "./envelope.js";
import { SCHEMA_VERSION, SERVER_NAME, SERVER_VERSION, TOOL_NAMES } from "./version.js";

/**
 * ApplicationService katmanı — TŞ v2.1 §5/§10: MCP server input validation,
 * authorization ve limitleri BURADA uygular; iş mantığı graph snapshot
 * üzerinden yürür, parser detayı sızmaz (wiki/architecture.md sınır 3).
 *
 * Ortal davranış:
 * 1. workspaceId → config.workspaceId ile eşleşmezse WORKSPACE_NOT_AUTHORIZED
 *    (tek workspace modeli, TŞ §20 allowRoots sözleşmesi).
 * 2. allowRoots[0] her çağrıda WorkspaceAccessPolicy.authorizeRoot ile
 *    yeniden doğrulanır; reddi → WORKSPACE_NOT_AUTHORIZED.
 * 3. Snapshot gerektiren araçlar getLatestPublished yoksa INDEX_NOT_READY.
 * 4. Limitler config'den gelir; aşımı LIMIT_EXCEEDED (TŞ §19/§20).
 * 5. Sıralama her yerde deterministiktir (TŞ §8 invariant iv/vi).
 */

export interface ServiceDeps {
  readonly config: CausorynServerConfig;
  readonly policy: WorkspaceAccessPolicy;
  readonly repository: GraphRepository;
}

/* ------------------------------------------------------------------ */
/* Ortak yardımcılar                                                   */
/* ------------------------------------------------------------------ */

function requireAuthorizedWorkspace(deps: ServiceDeps, workspaceId: string): string {
  if (workspaceId !== deps.config.workspaceId) {
    throw new CausorynToolError(
      "WORKSPACE_NOT_AUTHORIZED",
      `workspaceId yetkili workspace kaydında yok: ${workspaceId}`,
    );
  }
  const declaredRoot = deps.config.allowRoots[0];
  if (declaredRoot === undefined) {
    throw new CausorynToolError(
      "WORKSPACE_NOT_AUTHORIZED",
      "sunucu konfigürasyonunda allowRoot beyanı yok (explicit authorization, TŞ §9/§20)",
    );
  }
  const decision = deps.policy.authorizeRoot(declaredRoot);
  if (!decision.allowed) {
    throw new CausorynToolError(
      "WORKSPACE_NOT_AUTHORIZED",
      `workspace kökü yetkilendirilmedi (${decision.code}): ${decision.reason}`,
    );
  }
  return decision.canonicalRoot;
}

function requireSnapshot(deps: ServiceDeps, workspaceId: string): SnapshotRead {
  const read = deps.repository.getLatestPublished(workspaceId);
  if (read === undefined) {
    throw new CausorynToolError(
      "INDEX_NOT_READY",
      `workspace için yayınlanmış snapshot yok: ${workspaceId}; indeksleme tamamlanmadan sorgu yapılamaz`,
    );
  }
  return read;
}

function coverageOf(snapshot: SnapshotGraph): Coverage {
  const totalEdges = snapshot.edges.length;
  const unresolvedEdges = snapshot.edges.filter((edge) => edge.resolution === "unresolved").length;
  const resolvedEdges = totalEdges - unresolvedEdges;
  const hasTypeScriptNodes = snapshot.nodes.some((node) => node.language === "typescript");
  const coverageRatio =
    totalEdges === 0 ? 0 : Math.round((resolvedEdges / totalEdges) * 10_000) / 10_000;
  return {
    tier: hasTypeScriptNodes ? "L2" : "L0",
    resolvedEdges,
    unresolvedEdges,
    totalEdges,
    coverageRatio,
  };
}

function staleWarningOf(read: SnapshotRead): string[] {
  const warnings: string[] = [];
  if (read.stale) {
    warnings.push("yayınlanmış snapshot bayat (stale=true); yeniden indeksleme önerilir");
  }
  if (read.snapshot.meta.state === "partial") {
    warnings.push(
      "snapshot partial durumda; coverage eksik olabilir (boş kaynak, parse tanıları veya kapsam dışı dosyalar)",
    );
  }
  return warnings;
}

function envelopeStatusOf(read: SnapshotRead): "ok" | "partial" {
  return read.snapshot.meta.state === "partial" ? "partial" : "ok";
}

function countEdgesByKind(snapshot: SnapshotGraph): Record<string, number> {
  const counts = new Map<string, number>();
  for (const edge of snapshot.edges) {
    counts.set(edge.kind, (counts.get(edge.kind) ?? 0) + 1);
  }
  const out: Record<string, number> = {};
  for (const key of [...counts.keys()].sort()) {
    out[key] = counts.get(key) ?? 0;
  }
  return out;
}

function nodeIdentityRelativePath(node: GraphNode): string | undefined {
  if (typeof node.attributes.relativePath === "string") {
    return node.attributes.relativePath;
  }
  return node.location === undefined ? undefined : node.location.relativePath;
}

/* ------------------------------------------------------------------ */
/* get_capabilities                                                    */
/* ------------------------------------------------------------------ */

export const GetCapabilitiesInputSchema = z.strictObject({
  /** Doğrulanacak workspace kökü (verilirse allowRoot'a karşı denetlenir). */
  workspace: z.string().min(1).optional(),
});

export const CapabilitiesDataSchema = z.strictObject({
  server: z.strictObject({
    name: z.string(),
    version: z.string(),
    schemaVersion: z.string(),
  }),
  protocol: z.strictObject({ revision: z.string() }),
  adapters: z.array(
    z.strictObject({
      language: z.string(),
      analyzerId: z.string(),
      version: z.string(),
      levels: z.strictObject({
        astParse: z.string(),
        symbolResolution: z.string(),
        frameworkLinkers: z.string(),
      }),
    }),
  ),
  limits: z.strictObject({
    maxFiles: z.number().int().positive(),
    maxFileBytes: z.number().int().positive(),
    maxNodes: z.number().int().positive(),
    maxSymbols: z.number().int().positive(),
  }),
  tools: z.array(z.string()),
});

export function getCapabilities(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof GetCapabilitiesInputSchema>,
): Envelope {
  if (input.workspace !== undefined) {
    const decision = deps.policy.authorizeRoot(input.workspace);
    if (!decision.allowed) {
      throw new CausorynToolError(
        "WORKSPACE_NOT_AUTHORIZED",
        `workspace kökü yetkilendirilmedi (${decision.code}): ${decision.reason}`,
      );
    }
  }
  return buildEnvelope({
    requestId,
    workspaceId: deps.config.workspaceId,
    snapshotId: null,
    status: "ok",
    coverage: null,
    warnings: [],
    data: {
      server: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        schemaVersion: SCHEMA_VERSION,
      },
      protocol: { revision: LATEST_PROTOCOL_VERSION },
      adapters: INDEXED_ADAPTERS.map((adapter) => ({
        language: adapter.language,
        analyzerId: adapter.analyzerId,
        version: adapter.version,
        levels: {
          astParse: adapter.levels.astParse,
          symbolResolution: adapter.levels.symbolResolution,
          frameworkLinkers: adapter.levels.frameworkLinkers,
        },
      })),
      limits: {
        maxFiles: deps.config.index.maxFiles,
        maxFileBytes: deps.config.maxFileBytes,
        maxNodes: deps.config.results.maxNodes,
        maxSymbols: deps.config.results.maxSymbols,
      },
      tools: [...TOOL_NAMES],
    },
  });
}

/* ------------------------------------------------------------------ */
/* workspace_summary                                                   */
/* ------------------------------------------------------------------ */

export const WorkspaceSummaryInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
});

export const WorkspaceSummaryDataSchema = z.strictObject({
  workspaceId: z.string(),
  revision: z.strictObject({ id: z.string(), sequence: z.number().int() }),
  snapshotState: z.string(),
  rootPath: z.string(),
  nodeCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  evidenceCount: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  languages: z.array(
    z.strictObject({ language: z.string(), files: z.number().int().nonnegative() }),
  ),
  frameworks: z.array(z.string()),
  entrypoints: z.array(z.string()),
  edgesByKind: z.record(z.string(), z.number().int().nonnegative()),
  resolutions: z.strictObject({
    verified: z.number().int().nonnegative(),
    heuristic: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
  }),
});

export function workspaceSummary(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof WorkspaceSummaryInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  const rootPath = requireAuthorizedWorkspace(deps, workspaceId);
  const read = requireSnapshot(deps, workspaceId);
  const snapshot = read.snapshot;
  const fileNodes = snapshot.nodes.filter((node) => node.kind === "File");
  const tsFileNodes = fileNodes.filter((node) => node.language === "typescript");
  const entrypoints = snapshot.nodes
    .filter((node) => node.kind === "Endpoint" || node.kind === "Handler")
    .map((node) => node.qualifiedName)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const languages = tsFileNodes.some((node) => node.language === "typescript")
    ? [
        {
          language: "typescript",
          files: tsFileNodes.length,
        },
      ]
    : [];
  // Framework linker'ları (sprint-2 B3) Endpoint node'larına framework
  // özniteliği yazar; özet bu özniteliklerden türetilir — hard-coded []
  // değildir (denetim bulgusu 1 düzeltmesi).
  const frameworks = [
    ...new Set(
      snapshot.nodes
        .filter((node) => node.kind === "Endpoint")
        .map((node) => node.attributes.framework)
        .filter((value): value is string => typeof value === "string"),
    ),
  ].sort((a, b) => (a < b ? -1 : 1));

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: snapshot.meta.id,
    status: envelopeStatusOf(read),
    coverage: coverageOf(snapshot),
    warnings: staleWarningOf(read),
    data: {
      workspaceId,
      revision: { id: snapshot.meta.revision.id, sequence: snapshot.meta.revision.sequence },
      snapshotState: snapshot.meta.state,
      rootPath,
      nodeCount: snapshot.nodes.length,
      edgeCount: snapshot.edges.length,
      evidenceCount: snapshot.evidence.length,
      fileCount: fileNodes.length,
      languages,
      frameworks,
      entrypoints,
      edgesByKind: countEdgesByKind(snapshot),
      resolutions: {
        verified: snapshot.edges.filter((edge) => edge.resolution === "verified").length,
        heuristic: snapshot.edges.filter((edge) => edge.resolution === "heuristic").length,
        unresolved: snapshot.edges.filter((edge) => edge.resolution === "unresolved").length,
      },
    },
  });
}

/* ------------------------------------------------------------------ */
/* map_system                                                          */
/* ------------------------------------------------------------------ */

export const MapSystemInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** TŞ §16 harita hiyerarşisi; L4 (akış) Faz A'da desteklenmez. */
  level: z.enum(["L0", "L1", "L2", "L3", "L4"]).optional(),
  filters: z
    .strictObject({
      kinds: z.array(z.enum(NODE_KINDS)).optional(),
      pathPrefix: z.string().min(1).optional(),
    })
    .optional(),
  maxNodes: z.number().int().positive().optional(),
  cursor: z.string().min(1).optional(),
});

/** Harita düzeyi → node tür kümesi (TŞ §16 L0 repository … L3 method/type/endpoint). */
const MAP_LEVEL_KINDS: Readonly<Record<"L0" | "L1" | "L2" | "L3", readonly string[]>> = {
  L0: ["Workspace", "Repository", "Project"],
  L1: ["Module", "Package", "File", "Namespace", "Config"],
  L2: ["Class", "Interface", "Type"],
  L3: ["Function", "Method", "Handler", "Endpoint"],
};

export const MapDataSchema = z.strictObject({
  workspaceId: z.string(),
  level: z.string(),
  filters: z.strictObject({
    kinds: z.array(z.string()).nullable(),
    pathPrefix: z.string().nullable(),
  }),
  totalNodes: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  truncated: z.boolean(),
  nodes: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.string(),
      qualifiedName: z.string(),
      language: z.string().optional(),
      location: z
        .strictObject({
          relativePath: z.string(),
          startLine: z.number().int(),
          endLine: z.number().int(),
        })
        .optional(),
      relativePath: z.string().optional(),
    }),
  ),
  edges: z.array(
    z.strictObject({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      kind: z.string(),
      resolution: z.string(),
    }),
  ),
});

export function mapSystem(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof MapSystemInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);
  const read = requireSnapshot(deps, workspaceId);
  const snapshot = read.snapshot;

  const level = input.level ?? "L2";
  if (level === "L4") {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "L4 akış haritası Faz A'da desteklenmiyor (L0–L3 kullanın)",
    );
  }
  const maxNodes = input.maxNodes ?? deps.config.results.maxNodes;
  if (maxNodes > deps.config.results.maxNodes) {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `maxNodes=${String(maxNodes)} results.maxNodes tavanını (${String(deps.config.results.maxNodes)}) aşıyor`,
    );
  }
  let offset = 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor);
    if (decoded === null) {
      throw new CausorynToolError("INVALID_ARGUMENT", "cursor çözümlenemedi (bozuk veya eski biçim)");
    }
    offset = decoded;
  }

  const levelKinds = new Set(MAP_LEVEL_KINDS[level]);
  const filterKinds =
    input.filters?.kinds === undefined ? undefined : new Set<string>(input.filters.kinds);
  const pathPrefix = input.filters?.pathPrefix;
  const matched = snapshot.nodes
    .filter((node) => {
      if (!levelKinds.has(node.kind)) return false;
      if (filterKinds !== undefined && !filterKinds.has(node.kind)) return false;
      if (pathPrefix !== undefined) {
        const relativePath = nodeIdentityRelativePath(node);
        if (relativePath === undefined || !relativePath.startsWith(pathPrefix)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (a.qualifiedName !== b.qualifiedName) return a.qualifiedName < b.qualifiedName ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const page = matched.slice(offset, offset + maxNodes);
  const nextCursor = offset + maxNodes < matched.length ? encodeCursor(offset + maxNodes) : null;
  const pageIds = new Set(page.map((node) => node.id));
  const pageEdges = snapshot.edges.filter((edge) => pageIds.has(edge.from) && pageIds.has(edge.to));

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: snapshot.meta.id,
    status: envelopeStatusOf(read),
    coverage: coverageOf(snapshot),
    warnings: staleWarningOf(read),
    nextCursor,
    data: {
      workspaceId,
      level,
      filters: {
        kinds: input.filters?.kinds === undefined ? null : [...input.filters.kinds].sort(),
        pathPrefix: pathPrefix ?? null,
      },
      totalNodes: matched.length,
      returned: page.length,
      truncated: nextCursor !== null,
      nodes: page.map((node) => ({
        id: node.id,
        kind: node.kind,
        qualifiedName: node.qualifiedName,
        ...(node.language === undefined ? {} : { language: node.language }),
        ...(node.location === undefined
          ? {}
          : {
              location: {
                relativePath: node.location.relativePath,
                startLine: node.location.startLine,
                endLine: node.location.endLine,
              },
            }),
        ...(nodeIdentityRelativePath(node) === undefined
          ? {}
          : { relativePath: nodeIdentityRelativePath(node) as string }),
      })),
      edges: pageEdges.map((edge) => ({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        resolution: edge.resolution,
      })),
    },
  });
}

/* ------------------------------------------------------------------ */
/* find_symbols                                                        */
/* ------------------------------------------------------------------ */

export const FindSymbolsInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  query: z.string().min(1),
  kind: z.enum(NODE_KINDS).optional(),
  limit: z.number().int().positive().optional(),
});

interface SymbolHit {
  readonly symbolId: string;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly language?: string;
  readonly relativePath?: string;
}

export const AmbiguityDataSchema = z.strictObject({
  candidates: z.array(
    z.strictObject({
      symbolId: z.string(),
      qualifiedName: z.string(),
      kind: z.string(),
      relativePath: z.string().optional(),
    }),
  ),
});

export const FindSymbolsDataSchema = z.strictObject({
  query: z.string(),
  totalMatches: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  hits: z.array(
    z.strictObject({
      symbolId: z.string(),
      qualifiedName: z.string(),
      kind: z.string(),
      language: z.string().optional(),
      relativePath: z.string().optional(),
    }),
  ),
});

function hitOf(node: GraphNode): SymbolHit {
  const relativePath = nodeIdentityRelativePath(node);
  return {
    symbolId: node.id,
    qualifiedName: node.qualifiedName,
    kind: node.kind,
    ...(node.language === undefined ? {} : { language: node.language }),
    ...(relativePath === undefined ? {} : { relativePath }),
  };
}

export function findSymbols(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof FindSymbolsInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);
  const read = requireSnapshot(deps, workspaceId);
  const snapshot = read.snapshot;

  const needle = input.query.trim().toLowerCase();
  if (needle.length === 0) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "query yalnızca boşluk olamaz; aranacak simge adını verin",
    );
  }
  const limit = input.limit ?? deps.config.results.maxSymbols;
  if (limit > deps.config.results.maxSymbols) {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `limit=${String(limit)} results.maxSymbols tavanını (${String(deps.config.results.maxSymbols)}) aşıyor`,
    );
  }

  // Derecelendirme: tam eşleşme (0) → önek (1) → içerir (2); bağlar
  // qualifiedName + symbolId ile çözülür (deterministik, TŞ §8 invariant iv).
  const rankOf = (qualifiedName: string): 0 | 1 | 2 | undefined => {
    const lowered = qualifiedName.toLowerCase();
    if (lowered === needle) return 0;
    if (lowered.startsWith(needle)) return 1;
    if (lowered.includes(needle)) return 2;
    return undefined;
  };
  const matches = snapshot.nodes
    .map((node) => ({ node, rank: rankOf(node.qualifiedName) }))
    .filter(
      (entry): entry is { node: GraphNode; rank: 0 | 1 | 2 } =>
        entry.rank !== undefined && (input.kind === undefined || entry.node.kind === input.kind),
    )
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.node.qualifiedName !== b.node.qualifiedName) {
        return a.node.qualifiedName < b.node.qualifiedName ? -1 : 1;
      }
      return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0;
    });

  // AMBIGUOUS_SYMBOL: tam ad eşleşmesi birden çok node'a çözülüyorsa istek
  // belirsizdir; adaylar döner (TŞ §10.1 + §10.3 requiresDisambiguation).
  const exactMatches = matches.filter((entry) => entry.rank === 0);
  if (exactMatches.length > 1) {
    throw new CausorynToolError(
      "AMBIGUOUS_SYMBOL",
      `"${input.query.trim()}" sorgusu ${String(exactMatches.length)} farklı simge düğümüne tam eşleşti; kind/limit/pathPrefix ile daraltın`,
      {
        candidates: exactMatches.map((entry) => {
          const hit = hitOf(entry.node);
          return {
            symbolId: hit.symbolId,
            qualifiedName: hit.qualifiedName,
            kind: hit.kind,
            ...(hit.relativePath === undefined ? {} : { relativePath: hit.relativePath }),
          };
        }),
      },
    );
  }

  const hits = matches.slice(0, limit).map((entry) => hitOf(entry.node));
  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: snapshot.meta.id,
    status: envelopeStatusOf(read),
    coverage: coverageOf(snapshot),
    warnings: staleWarningOf(read),
    data: {
      query: input.query,
      totalMatches: matches.length,
      returned: hits.length,
      hits,
    },
  });
}

/* ------------------------------------------------------------------ */
/* get_evidence                                                        */
/* ------------------------------------------------------------------ */

export const GetEvidenceInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /**
   * Sorgulanan graph kimliği (TŞ §10.2 "node/edge/finding IDs"): Faz A'da
   * node:<hex> | edge:<hex> | evidence:<hex>; finding kimliği bu dilimde
   * üretilmez (Faz B+ kapsamı).
   */
  id: z.string().min(1),
});

/** Kaynak span (TŞ §8 SourceSpan) — get_evidence çıktı bileşeni. */
export const EvidenceSpanSchema = z.strictObject({
  relativePath: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  sourceHash: z.string(),
});

/** Kanıt kaydı (TŞ §8 Evidence) — get_evidence çıktı bileşeni. */
export const EvidenceRecordSchema = z.strictObject({
  id: z.string(),
  kind: z.string(),
  span: EvidenceSpanSchema.optional(),
  analyzerId: z.string(),
  analyzerVersion: z.string(),
  rationale: z.string(),
});

export const GetEvidenceDataSchema = z.strictObject({
  id: z.string(),
  /** Kimliğin snapshot'taki türü; node/edge bağlam alanlarını ayırt eder. */
  idKind: z.enum(["node", "edge", "evidence"]),
  /** idKind="node" için sorgulanan düğümün özeti. */
  node: z
    .strictObject({
      id: z.string(),
      kind: z.string(),
      qualifiedName: z.string(),
    })
    .optional(),
  /** idKind="edge" için kenarın uçları ve çözümleme düzeyi. */
  edge: z
    .strictObject({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      kind: z.string(),
      resolution: z.string(),
    })
    .optional(),
  evidence: z.array(EvidenceRecordSchema),
});

function evidenceRecordOf(item: Evidence): z.infer<typeof EvidenceRecordSchema> {
  return {
    id: item.id,
    kind: item.kind,
    ...(item.span === undefined ? {} : { span: { ...item.span } }),
    analyzerId: item.analyzerId,
    analyzerVersion: item.analyzerVersion,
    rationale: item.rationale,
  };
}

function evidenceByIdOf(snapshot: SnapshotGraph): Map<string, Evidence> {
  return new Map(snapshot.evidence.map((item) => [item.id, item]));
}

function sortedById(items: readonly Evidence[]): readonly Evidence[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * causoryn_get_evidence (TŞ §10.2 "Evidence Graph provenance"; sprint-1
 * görev 7): verilen node/edge/evidence kimliğinin kanıt dizisini döndürür
 * (relativePath, startLine/endLine, sourceHash, analyzerId, rationale).
 *
 * Semantik (Faz A sözleşmesi):
 * - EDGE: kenarın kendi evidenceIds kayıtları (TŞ §8'de kanıt bağı kenar
 *   üzerindedir; verified kenar ≥1 kanıt — invariant i).
 * - NODE: komşu kenarların (from veya to = id) kanıtları; tekrarsız ve
 *   kanıt ID'sine göre kanonik düzende. Komşusu olmayan düğüm (ör. boş
 *   workspace'taki Workspace node'u) BOŞ dizi döndürür — kimlik mevcut
 *   olduğundan EVIDENCE_NOT_FOUND değildir.
 * - EVIDENCE: kanıt kaydının kendisi tek elemanlık dizi olarak döner.
 * - Hiçbiri değilse sabit proje uzantısı kodu EVIDENCE_NOT_FOUND.
 */
export function getEvidence(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof GetEvidenceInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);
  const read = requireSnapshot(deps, workspaceId);
  const snapshot = read.snapshot;
  const id = input.id;

  const envelopeBase = {
    requestId,
    workspaceId,
    snapshotId: snapshot.meta.id,
    coverage: coverageOf(snapshot),
    warnings: staleWarningOf(read),
  };

  // 1) Node kimliği: komşu kenar kanıtları (deterministik, tekrarsız).
  const node = snapshot.nodes.find((candidate) => candidate.id === id);
  if (node !== undefined) {
    const evidenceById = evidenceByIdOf(snapshot);
    const seen = new Set<string>();
    const items: Evidence[] = [];
    for (const edge of snapshot.edges) {
      if (edge.from !== id && edge.to !== id) continue;
      for (const evidenceId of edge.evidenceIds) {
        if (seen.has(evidenceId)) continue;
        const record = evidenceById.get(evidenceId);
        if (record === undefined) continue;
        seen.add(evidenceId);
        items.push(record);
      }
    }
    return buildEnvelope({
      ...envelopeBase,
      status: envelopeStatusOf(read),
      data: {
        id,
        idKind: "node",
        node: {
          id: node.id,
          kind: node.kind,
          qualifiedName: node.qualifiedName,
        },
        evidence: sortedById(items).map(evidenceRecordOf),
      },
    });
  }

  // 2) Edge kimliği: kenarın kendi kanıtları.
  const edge = snapshot.edges.find((candidate) => candidate.id === id);
  if (edge !== undefined) {
    const evidenceById = evidenceByIdOf(snapshot);
    const items = edge.evidenceIds
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((record): record is Evidence => record !== undefined);
    return buildEnvelope({
      ...envelopeBase,
      status: envelopeStatusOf(read),
      data: {
        id,
        idKind: "edge",
        edge: {
          id: edge.id,
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          resolution: edge.resolution,
        },
        evidence: sortedById(items).map(evidenceRecordOf),
      },
    });
  }

  // 3) Evidence kimliğinin kendisi.
  const record = snapshot.evidence.find((item) => item.id === id);
  if (record !== undefined) {
    return buildEnvelope({
      ...envelopeBase,
      status: envelopeStatusOf(read),
      data: {
        id,
        idKind: "evidence",
        evidence: [evidenceRecordOf(record)],
      },
    });
  }

  // 4) Bulunamayan kimlik → sabit hata kodu (görev sözleşmesi; TŞ §10.1
  //    listesinde olmayan proje uzantısı — bkz. errors.ts başlığı).
  throw new CausorynToolError(
    "EVIDENCE_NOT_FOUND",
    `kimlik yayınlanmış snapshot'ta bulunamadı: ${id}; node/edge kimliklerini map_system/find_symbols çıktısından alın`,
  );
}
