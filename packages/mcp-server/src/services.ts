import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { GraphRepository, SnapshotRead } from "@causoryn/graph";
import {
  EDGE_KINDS,
  NODE_KINDS,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type SnapshotGraph,
} from "@causoryn/domain";
import {
  INDEXED_ADAPTERS,
  IndexingError,
  type IndexJobRecord,
} from "@causoryn/indexing";
import type { IndexJobManager } from "@causoryn/indexing";
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
  /** Sprint-2 B6: causoryn_refresh_index / causoryn_index_status iş yönetimi. */
  readonly jobManager: IndexJobManager;
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
/* index_status (sprint-2 B6)                                          */
/* ------------------------------------------------------------------ */

export const IndexStatusInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /**
   * Sorgulanacak iş kimliği (TŞ §10.2 "jobId?"): verilmezse EN SON
   * başlatılan iş raporlanır; hiç iş başlamadıysa job null döner.
   */
  jobId: z.string().min(1).optional(),
});

/** İş kaydı (TŞ §10.2 index_status çıktısı: job progress + diagnostics). */
export const IndexJobRecordSchema = z.strictObject({
  jobId: z.string(),
  mode: z.enum(["full", "incremental"]),
  scope: z.string().nullable(),
  status: z.enum(["queued", "running", "done", "failed"]),
  progressPercent: z.number().int().min(0).max(100),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  snapshotId: z.string().nullable(),
  snapshotState: z.enum(["ready", "partial"]).nullable(),
  stale: z.boolean(),
  fileCount: z.number().int().nonnegative().nullable(),
  tsFileCount: z.number().int().nonnegative().nullable(),
  diagnostics: z.array(
    z.strictObject({
      relativePath: z.string(),
      code: z.string(),
      message: z.string(),
      line: z.number().int(),
    }),
  ),
  warnings: z.array(z.string()),
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
});

/** Güncel yayın (TŞ §10.2 index_status çıktısı: Snapshot + stale). */
export const LatestSnapshotSchema = z.strictObject({
  snapshotId: z.string(),
  state: z.string(),
  stale: z.boolean(),
  nodeCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  evidenceCount: z.number().int().nonnegative(),
});

export const IndexStatusDataSchema = z.strictObject({
  workspaceId: z.string(),
  /** Sorgulanan (jobId verilmediyse en son) işin kimliği; iş yoksa null. */
  jobId: z.string().nullable(),
  job: IndexJobRecordSchema.nullable(),
  latestSnapshot: LatestSnapshotSchema.nullable(),
});

function jobRecordOf(job: IndexJobRecord): z.infer<typeof IndexJobRecordSchema> {
  return {
    jobId: job.jobId,
    mode: job.mode,
    scope: job.scope,
    status: job.status,
    progressPercent: job.progressPercent,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    snapshotId: job.snapshotId,
    snapshotState: job.snapshotState,
    stale: job.stale,
    fileCount: job.fileCount,
    tsFileCount: job.tsFileCount,
    diagnostics: job.diagnostics.map((item) => ({
      relativePath: item.relativePath,
      code: item.code,
      message: item.message,
      line: item.line,
    })),
    warnings: [...job.warnings],
    error: job.error === null ? null : { code: job.error.code, message: job.error.message },
  };
}

/**
 * causoryn_index_status (TŞ §10.2 "Snapshot, stale, job progress,
 * diagnostics"; sprint-2 B6). jobId verilirse o iş, verilmezse en son iş
 * raporlanır; yanında güncel yayın (latestSnapshot) + stale bayrağı döner.
 *
 * Durum aracı olduğundan yayınlanmış snapshot yokluğunda HATA fırlatmaz
 * (INDEX_NOT_READY sorgu araçlarının sözleşmesidir): job/latestSnapshot
 * null döner ve envelope.warnings refresh_index'e yönlendirir.
 * jobId verildiyse bilinmeyen kimlik sabit INVALID_ARGUMENT koduyla reddedilir
 * (K-008 uzantı kodu; yeni kod eklenmedi).
 */
export function indexStatus(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof IndexStatusInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);

  let job: IndexJobRecord | undefined;
  if (input.jobId !== undefined) {
    job = deps.jobManager.status(input.jobId);
    if (job === undefined) {
      throw new CausorynToolError(
        "INVALID_ARGUMENT",
        `bilinmeyen jobId: ${input.jobId}; kayıt düşmüş (maxJobs) veya hiç böyle bir iş başlatılmadı — jobId'siz çağrı en son işi döndürür`,
      );
    }
  } else {
    job = deps.jobManager.latest();
  }

  const read = deps.repository.getLatestPublished(workspaceId);
  const warnings = read === undefined
    ? [
        "yayınlanmış snapshot yok; refresh_index ile yeni snapshot işi başlatın",
      ]
    : staleWarningOf(read);

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: read?.snapshot.meta.id ?? job?.snapshotId ?? null,
    // Durum aracı: yanıtın kendisi her zaman "ok"; snapshot durumu partial
    // ise katalogla tutarlı biçimde "partial" taşınır.
    status: read === undefined ? "ok" : envelopeStatusOf(read),
    coverage: read === undefined ? null : coverageOf(read.snapshot),
    warnings,
    data: {
      workspaceId,
      jobId: job?.jobId ?? null,
      job: job === undefined ? null : jobRecordOf(job),
      latestSnapshot:
        read === undefined
          ? null
          : {
              snapshotId: read.snapshot.meta.id,
              state: read.snapshot.meta.state,
              stale: read.stale,
              nodeCount: read.snapshot.nodes.length,
              edgeCount: read.snapshot.edges.length,
              evidenceCount: read.snapshot.evidence.length,
            },
    },
  });
}

/* ------------------------------------------------------------------ */
/* refresh_index (sprint-2 B6)                                         */
/* ------------------------------------------------------------------ */

export const RefreshIndexInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /** TŞ §10.2 "mode": full = tam yeniden indeksleme; incremental B7 dilimi. */
  mode: z.enum(["full", "incremental"]),
  /** TŞ §10.2 "scope?": dar kapsamlı refresh; bu dilimde desteklenmez. */
  scope: z.string().min(1).optional(),
});

/** Yeni iş kaydının başlangıç görünümü (TŞ §10.2 "Yeni snapshot işi"). */
export const RefreshIndexDataSchema = z.strictObject({
  jobId: z.string(),
  mode: z.enum(["full", "incremental"]),
  scope: z.string().nullable(),
  status: z.enum(["queued", "running", "done", "failed"]),
  progressPercent: z.number().int().min(0).max(100),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
});

/**
 * causoryn_refresh_index (TŞ §10.2 "Yeni snapshot işi"; sprint-2 B6).
 *
 * ASYNC sözleşmesi: çağrı işi kuyruğa alır ve ANINDA jobId döner (envelope
 * snapshotId null — iş henüz snapshot üretmedi); iş in-process arka planda
 * ilerler ve causoryn_index_status(jobId) ile izlenir.
 *
 * Yazma sınırı (wiki/mcp-tools.md yazma izin matrisi): indeks yalnızca
 * Causoryn izinli data-root'una yazılır — kök, her çağrıda
 * requireAuthorizedWorkspace ile allowRoot'a karşı yeniden doğrulanır ve
 * JobManager ayrıca WorkspaceAccessPolicy.authorizeRoot ile senkron
 * reddeder (yetkisiz kök iş kaydı AÇMAZ → WORKSPACE_NOT_AUTHORIZED).
 *
 * mode/scope: bu dilimde yalnızca mode="full" yürütülür; "incremental" ve
 * scope Live Architecture (sprint-2 B7) dilimine aittir — sessizce yok
 * saymak yerine açık INVALID_ARGUMENT reddi (ADR-010: çalışmayan şey
 * Done yazılmaz; kod K-008 uzantı setinden).
 */
export function refreshIndex(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof RefreshIndexInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  const canonicalRoot = requireAuthorizedWorkspace(deps, workspaceId);
  if (input.mode === "incremental") {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "mode=incremental bu dilimde yürütülemiyor; incremental yeniden indeksleme Live Architecture (sprint-2 B7) diliminde gelecek",
    );
  }
  if (input.scope !== undefined) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      `scope dar kapsamlı yeniden indeksleme bu dilimde desteklenmiyor (${input.scope}); Live Architecture (sprint-2 B7) diliminde değerlendirilecek`,
    );
  }

  let started: IndexJobRecord;
  try {
    started = deps.jobManager.refreshIndex(canonicalRoot, { mode: input.mode });
  } catch (error) {
    if (error instanceof IndexingError) {
      throw indexingErrorToToolError(error, requestId);
    }
    throw error;
  }

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: null,
    status: "ok",
    coverage: null,
    warnings: [],
    data: {
      jobId: started.jobId,
      mode: started.mode,
      scope: started.scope,
      status: started.status,
      progressPercent: started.progressPercent,
      createdAt: started.createdAt,
      startedAt: started.startedAt,
    },
  });
}

/**
 * IndexingError → sabit tool hata kodu eşlemesi (TŞ §10.1; kod tablosu
 * packages/indexing/src/errors.ts başlığındaki belgelenen eşlemenin aynısı).
 */
function indexingErrorToToolError(
  error: IndexingError,
  requestId: string,
): CausorynToolError {
  switch (error.code) {
    case "indexing/root-not-authorized":
      return new CausorynToolError("WORKSPACE_NOT_AUTHORIZED", error.message);
    case "indexing/path-denied":
      return new CausorynToolError("PATH_DENIED", error.message);
    case "indexing/limit-exceeded":
      return new CausorynToolError("LIMIT_EXCEEDED", error.message);
    case "indexing/unsupported-mode":
      return new CausorynToolError("INVALID_ARGUMENT", error.message);
    case "indexing/internal":
      return new CausorynToolError(
        "INTERNAL_ERROR",
        `Beklenmeyen iç hata; ayrıntılar sunucu loglarında (requestId: ${requestId})`,
      );
  }
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

/** Kaynak span (TŞ §8 SourceSpan) — get_evidence/get_symbol_context bileşeni. */
export const EvidenceSpanSchema = z.strictObject({
  relativePath: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  sourceHash: z.string(),
});

/** Kanıt kaydı (TŞ §8 Evidence) — kanıt taşıyan araçların çıktı bileşeni.
 * get_symbol_context (B5) bu şemayı get_evidence tanımından ÖNCE kullandığı
 * için tanım ortak bölgeye taşındı (const TDZ'si modül yükleme sırasını
 * zorlar). */
export const EvidenceRecordSchema = z.strictObject({
  id: z.string(),
  kind: z.string(),
  span: EvidenceSpanSchema.optional(),
  analyzerId: z.string(),
  analyzerVersion: z.string(),
  rationale: z.string(),
});

/* ------------------------------------------------------------------ */
/* get_symbol_context (sprint-2 B5)                                    */
/* ------------------------------------------------------------------ */

export const GetSymbolContextInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /**
   * Sembol kimliği (TŞ §10.2 "symbolId"): yayımlanmış node kimliği
   * ("node:<hex>") YA DA qualifiedName tam adı kabul edilir. Ad birden çok
   * node'a tam eşleşirse AMBIGUOUS_SYMBOL + adaylar döner (TŞ §10.3
   * requiresDisambiguation deseni; find_symbols ile aynı aday formu).
   */
  symbolId: z.string().min(1),
  /**
   * Kenar tür filtresi (TŞ §10.2 "edgeKinds?"): EDGE_KINDS alt kümesi.
   * Şema düzeyinde string kabul edilir; EDGE_KINDS üyesi olmayan değer
   * anlamsal reddiyen INVALID_ARGUMENT ile reddedilir (sprint-1 kalıbı:
   * şemayı geçen anlamsal hatalar envelope kodu taşır).
   */
  edgeKinds: z.array(z.string().min(1)).optional(),
  /** Traversal derinliği (TŞ §10.2 "depth?"): varsayılan 1; tavan
   * results.maxDepth (TŞ §20 resource budget). */
  depth: z.number().int().positive().optional(),
});

/** Context node kaydı (map_system node formuyla aynı alanlar). */
export const SymbolContextNodeSchema = z.strictObject({
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
});

/** Context kenar kaydı: uçlar + kanıt kimlikleri (TŞ §8 kanıt bağı kenarda). */
export const SymbolContextEdgeSchema = z.strictObject({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.string(),
  resolution: z.string(),
  evidenceIds: z.array(z.string()),
});

export const GetSymbolContextDataSchema = z.strictObject({
  workspaceId: z.string(),
  /** Sorgulanan sembol node'u (context merkezi). */
  symbol: SymbolContextNodeSchema,
  /** Uygulanan traversal derinliği. */
  depth: z.number().int().positive(),
  /** Uygulanan kenar tür filtresi; verilmediyse null (tüm EDGE_KINDS). */
  edgeKinds: z.array(z.string()).nullable(),
  /** Derinlik/maxNodes sınırında kesildi mi (TŞ §20 truncated sözleşmesi). */
  truncated: z.boolean(),
  /** Context node sayısı (symbol dahil). */
  totalNodes: z.number().int().nonnegative(),
  /** Sembol + keşfedilen komşular; qualifiedName+id sıralı, tekrarsız. */
  nodes: z.array(SymbolContextNodeSchema),
  /** Context kenarları: uçları nodes kümesinde, id kanonik sırada. */
  edges: z.array(SymbolContextEdgeSchema),
  /** Kenarların kanıt kayıtları: tekrarsız, id sıralı (TŞ §10.2 evidence). */
  evidence: z.array(EvidenceRecordSchema),
});

/**
 * symbolId çözümleme (TŞ §10.2 "symbolId"): önce yayımlanmış node kimliği,
 * bulunamazsa qualifiedName tam adı. Ad 0 node'a çözülürse SYMBOL_NOT_FOUND
 * (K-008 uzantı kodu), >1 node'a çözülürse AMBIGUOUS_SYMBOL + adaylar
 * (TŞ §10.3) fırlatır.
 */
function resolveSymbolNode(snapshot: SnapshotGraph, symbolId: string): GraphNode {
  const byId = snapshot.nodes.find((node) => node.id === symbolId);
  if (byId !== undefined) return byId;
  const byName = snapshot.nodes.filter((node) => node.qualifiedName === symbolId);
  if (byName.length === 0) {
    throw new CausorynToolError(
      "SYMBOL_NOT_FOUND",
      `sembol yayınlanmış snapshot'ta bulunamadı: ${symbolId}; node kimliklerini map_system/find_symbols çıktısından alın`,
    );
  }
  if (byName.length > 1) {
    throw new CausorynToolError(
      "AMBIGUOUS_SYMBOL",
      `"${symbolId}" sorgusu ${String(byName.length)} farklı sembol düğümüne tam eşleşti; adaylardan birinin symbolId'sini kullanın veya kind/pathPrefix ile daraltın`,
      // Aday formu find_symbols AmbiguityDataSchema ile birebir aynıdır
      // (symbolId/qualifiedName/kind/relativePath); language gibi ek node
      // alanları aday şemasına taşınmaz.
      {
        candidates: byName.map((node) => {
          const hit = hitOf(node);
          return {
            symbolId: hit.symbolId,
            qualifiedName: hit.qualifiedName,
            kind: hit.kind,
            ...(hit.relativePath === undefined
              ? {}
              : { relativePath: hit.relativePath }),
          };
        }),
      },
    );
  }
  return byName[0] as GraphNode;
}

/**
 * causoryn_get_symbol_context (TŞ §10.2 "Code Explorer relations +
 * evidence"; sprint-2 B5): sembol node'u + istenen derinliğe kadar komşu
 * kenarlar (edgeKinds filtreli; filtre traversal'a da uygulanır) + her
 * kenarın kanıt kayıtları.
 *
 * Determinizm (TŞ §8 invariant iv/vi): kenarlar id kanonik sırada toplanır
 * ve döner; node'lar qualifiedName+id sıralı; kanıtlar id sıralı ve
 * tekrarsız; BFS frontier sıralı işlenir — aynı giriş aynı yanıtı üretir.
 *
 * Tutarlılık sözleşmesi: dönen her kenarın uçları nodes kümesindedir
 * (results.maxNodes tavanına ulaşıldığında yeni komşu eklenmez ve o
 * node'un kenarları toplanmaz; kesme data.truncated + warnings ile
 * raporlanır — TŞ §20 "Her analiz sonucu ... truncated sunar").
 * Eski snapshot, build sürerken stale=true uyarısıyla servis edilir
 * (TŞ §9; staleWarningOf).
 */
export function getSymbolContext(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof GetSymbolContextInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);
  const read = requireSnapshot(deps, workspaceId);
  const snapshot = read.snapshot;

  // 1) edgeKinds anlamsal doğrulama: her üye EDGE_KINDS'te olmalı.
  let allowedKinds: ReadonlySet<string> | null = null;
  if (input.edgeKinds !== undefined) {
    const known = new Set<string>(EDGE_KINDS);
    const invalid = input.edgeKinds.filter((kind) => !known.has(kind));
    if (invalid.length > 0) {
      throw new CausorynToolError(
        "INVALID_ARGUMENT",
        `geçersiz edgeKinds üyesi(leri): ${invalid.join(", ")}; edgeKinds EDGE_KINDS alt kümesi olmalı`,
      );
    }
    allowedKinds = new Set(input.edgeKinds);
  }

  // 2) depth tavanı (config; TŞ §20 resource budget) → LIMIT_EXCEEDED.
  const depth = input.depth ?? 1;
  if (depth > deps.config.results.maxDepth) {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `depth=${String(depth)} results.maxDepth tavanını (${String(deps.config.results.maxDepth)}) aşıyor`,
    );
  }

  // 3) Sembolü çöz (ID → qualifiedName; belirsizlik adaylarla reddedilir).
  const start = resolveSymbolNode(snapshot, input.symbolId);

  // 4) Komşuluk haritası: izinli kenarlar, snapshot id kanonik sırasında.
  const incidentByNode = new Map<string, GraphEdge[]>();
  for (const edge of snapshot.edges) {
    if (allowedKinds !== null && !allowedKinds.has(edge.kind)) continue;
    for (const endpoint of [edge.from, edge.to]) {
      const list = incidentByNode.get(endpoint);
      if (list === undefined) {
        incidentByNode.set(endpoint, [edge]);
      } else {
        list.push(edge);
      }
    }
  }

  // 5) BFS: depth katman genişletme; frontier ve keşif sırası deterministik.
  const visited = new Set<string>([start.id]);
  const collectedEdgeIds = new Set<string>();
  const collectedEdges: GraphEdge[] = [];
  const maxNodes = deps.config.results.maxNodes;
  let frontier: string[] = [start.id];
  let cappedByMaxNodes = false;
  for (let level = 0; level < depth; level += 1) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      // Cap'te node ya TAM genişletilir ya hiç girilmez: kenar uçları
      // daima nodes kümesinde kalır (tutarlılık sözleşmesi).
      if (visited.size >= maxNodes) {
        cappedByMaxNodes = true;
        break;
      }
      let nodeRejected = false;
      for (const edge of incidentByNode.get(nodeId) ?? []) {
        const other = edge.from === nodeId ? edge.to : edge.from;
        if (!visited.has(other)) {
          if (visited.size >= maxNodes) {
            cappedByMaxNodes = true;
            nodeRejected = true;
            break;
          }
          visited.add(other);
          next.push(other);
        }
        if (!collectedEdgeIds.has(edge.id)) {
          collectedEdgeIds.add(edge.id);
          collectedEdges.push(edge);
        }
      }
      if (nodeRejected) break;
    }
    // Deterministik sonraki katman (id sıralı).
    frontier = next.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (cappedByMaxNodes) break;
  }

  // 6) Kesme raporu: istenen depth'te duruldu ve keşfedilmemiş komşu kaldıysa
  //    (veya maxNodes cap'i vurduysa) truncated=true + uyarı (TŞ §20).
  let truncatedByDepth = false;
  if (!cappedByMaxNodes) {
    depthCheck: for (const nodeId of frontier) {
      for (const edge of incidentByNode.get(nodeId) ?? []) {
        const other = edge.from === nodeId ? edge.to : edge.from;
        if (!visited.has(other)) {
          truncatedByDepth = true;
          break depthCheck;
        }
      }
    }
  }
  const truncated = truncatedByDepth || cappedByMaxNodes;

  // 7) Context node'ları: qualifiedName+id sıralı (map_system ile aynı kalıp).
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const contextNodes: GraphNode[] = [];
  for (const id of visited) {
    const node = nodeById.get(id);
    if (node !== undefined) contextNodes.push(node);
  }
  contextNodes.sort((a, b) => {
    if (a.qualifiedName !== b.qualifiedName) {
      return a.qualifiedName < b.qualifiedName ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // 8) Kenarların kanıtları: tekrarsız, id sıralı (get_evidence kalıbı).
  const evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]));
  const evidenceSet = new Set<string>();
  const evidence: Evidence[] = [];
  for (const edge of collectedEdges) {
    for (const id of edge.evidenceIds) {
      if (evidenceSet.has(id)) continue;
      const record = evidenceById.get(id);
      if (record === undefined) continue;
      evidenceSet.add(id);
      evidence.push(record);
    }
  }
  evidence.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const warnings = staleWarningOf(read);
  if (cappedByMaxNodes) {
    warnings.push(
      `context results.maxNodes tavanıyla kesildi (${String(maxNodes)}); depth/edgeKinds ile daraltın`,
    );
  }
  if (truncatedByDepth) {
    warnings.push(
      `context istenen depth=${String(depth)} sınırında kesildi; daha derin komşular mevcut (depth'i artırın, tavan results.maxDepth)`,
    );
  }

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: snapshot.meta.id,
    status: envelopeStatusOf(read),
    coverage: coverageOf(snapshot),
    warnings,
    data: {
      workspaceId,
      symbol: symbolNodeOf(start),
      depth,
      edgeKinds: allowedKinds === null ? null : [...allowedKinds].sort(),
      truncated,
      totalNodes: contextNodes.length,
      nodes: contextNodes.map(symbolNodeOf),
      edges: [...collectedEdges]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((edge) => ({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          resolution: edge.resolution,
          evidenceIds: [...edge.evidenceIds],
        })),
      evidence: evidence.map(evidenceRecordOf),
    },
  });
}

/** Context node çıktı kaydı (map_system node formu). */
function symbolNodeOf(node: GraphNode): z.infer<typeof SymbolContextNodeSchema> {
  const relativePath = nodeIdentityRelativePath(node);
  return {
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
    ...(relativePath === undefined ? {} : { relativePath }),
  };
}

/* ------------------------------------------------------------------ */
/* trace_execution (sprint-2 B4)                                       */
/* ------------------------------------------------------------------ */

export const TraceExecutionInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /**
   * Çağrı zincirinin başlangıç noktası (TŞ §10.2 "entrypoint"): yayımlanmış
   * node kimliği ("node:<hex>") YA DA qualifiedName kabul edilir. Framework
   * endpoint adları ("POST /orders" — B3 linker ROUTES_TO çıktıları) ve
   * sembol adları bu yolla çözülür; ad birden çok node'a tam eşleşirse
   * AMBIGUOUS_SYMBOL + adaylar, hiçbir node'a eşleşmezse SYMBOL_NOT_FOUND
   * döner (get_symbol_context ile aynı çözümleme sözleşmesi).
   */
  entrypoint: z.string().min(1),
  /**
   * Yol uzunluğu sınırı — kenar sayısı (TŞ §20 resource budget "maxDepth").
   * Şema 0'a izin verir; 0 anlamsal girdi hatasıdır → INVALID_ARGUMENT
   * (görev sözleşmesi). Tavan results.maxDepth aşılırsa LIMIT_EXCEEDED.
   */
  maxDepth: z.number().int().min(0),
  /**
   * Döndürülecek azami yol sayısı (TŞ §20 resource budget "maxPaths").
   * Şema 0'a izin verir; 0 → INVALID_ARGUMENT. Tavan results.maxPaths
   * aşılırsa LIMIT_EXCEEDED. Sınır keşif sırasında vurulursa sonuç
   * truncated=true + uyarıyla döner.
   */
  maxPaths: z.number().int().min(0),
});

/** Yol kenarı: resolution düzeyi KENDİ alanında taşınır (karıştırma yasak). */
export const TracePathEdgeSchema = z.strictObject({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: z.string(),
  resolution: z.string(),
  evidenceIds: z.array(z.string()),
});

export const TracePathSchema = z.strictObject({
  /** 0 tabanlı, deterministik DFS keşif sırası (aynı girdi → aynı sıra). */
  index: z.number().int().nonnegative(),
  /**
   * Zincir etiketi: yolun EN ZAYIF kenar resolution'ı — tüm kenarlar
   * verified ise "verified"; herhangi bir heuristic kenar varsa "heuristic";
   * herhangi bir unresolved kenar varsa "unresolved". Kenar düzeyi
   * resolution alanlarıyla KARIŞTIRILMAZ: heuristic kenarlı zincir
   * "heuristic" işaretlenir, verified gibi sunulmaz (görev sözleşmesi;
   * TŞ §4.2 "statik kanıt ve bilinmeyen edge'ler ayrı").
   */
  resolution: z.enum(["verified", "heuristic", "unresolved"]),
  /** Zincir düğümleri; length === edges.length + 1, [0] entrypoint. */
  nodeIds: z.array(z.string()),
  /** Sıralı kenar listesi; resolution her kenarın kendi alanındadır. */
  edges: z.array(TracePathEdgeSchema),
  /**
   * Yolun neden bittiği: "leaf" = gidecek yeni node kalmadı; "max-depth" =
   * maxDepth sınırında duruldu ve gidecek komşu vardı; "unresolved-edge" =
   * son kenar unresolved olduğundan zincir O NOKTADA bitti (ötesi
   * genişletilmedi; kenar yolun içinde kalır).
   */
  stoppedReason: z.enum(["leaf", "max-depth", "unresolved-edge"]),
});

export const TraceExecutionDataSchema = z.strictObject({
  workspaceId: z.string(),
  /** Çözümlenen giriş node'u (endpoint veya sembol). */
  entrypoint: SymbolContextNodeSchema,
  /** Uygulanan sınırlar (doğrulanmış değerler). */
  maxDepth: z.number().int().positive(),
  maxPaths: z.number().int().positive(),
  /** Döndürülen yol sayısı. */
  pathCount: z.number().int().nonnegative(),
  /** maxPaths veya maxDepth keşfi kestiyse true (TŞ §20 truncated sözleşmesi). */
  truncated: z.boolean(),
  paths: z.array(TracePathSchema),
  /** Yollardaki tüm node'lar: qualifiedName+id sıralı, tekrarsız. */
  nodes: z.array(SymbolContextNodeSchema),
  /** Kenarların kanıt kayıtları: tekrarsız, id sıralı (get_symbol_context kalıbı). */
  evidence: z.array(EvidenceRecordSchema),
});

/** Zincir etiketi: kenar resolution'larından en zayıf düzey. */
function chainResolutionOf(
  resolutions: readonly string[],
): "verified" | "heuristic" | "unresolved" {
  if (resolutions.includes("unresolved")) return "unresolved";
  if (resolutions.includes("heuristic")) return "heuristic";
  return "verified";
}

/** Yürüyüşün ürettiği ham yol kaydı. */
interface TraceWalkPath {
  readonly nodeIds: readonly string[];
  readonly edges: readonly GraphEdge[];
  readonly stoppedReason: "leaf" | "max-depth" | "unresolved-edge";
}

interface TraceWalkResult {
  readonly paths: readonly TraceWalkPath[];
  /** maxPaths sınırı dışında kaydedilmemiş en az bir yol vardı. */
  readonly truncatedByPaths: boolean;
  /** Bir node maxDepth sınırında, gidecek komşusu varken durduruldu. */
  readonly truncatedByDepth: boolean;
}

/**
 * Deterministik DFS basit-yol sayımı (TŞ §8 invariant iv/vi).
 *
 * - Çağrı zinciri kenarları: CALLS (çağrı) + ROUTES_TO (endpoint → handler;
 *   endpoint entrypoint'leri graph'ta yalnızca B3 linker'ın ROUTES_TO
 *   kenarıyla bağlanır — diğer kenar türleri zincire girmez).
 * - Komşuluk snapshot'ın id kanonik sırasında kurulur; successor'lar o
 *   sırada taranır → aynı girdi aynı yol kümesini ve sırasını üretir.
 * - Döngü koruması: yol-başına visited kümesi (basit yollar; bir yol aynı
 *   node'u iki kez içermez).
 * - Unresolved kenar: zincir O NOKTADA biter — kenar yolun içinde kalır,
 *   hedefinin çıkış kenarları genişletilmez (TŞ §4.2: bilinmeyen kenarlar
 *   ayrı; uydurma devam yok). Heuristic kenar: zincir DEVAM eder ama yol
 *   etiketi en zayıf düzeye düşer (chainResolutionOf).
 * - maxPaths: kayıt anında sınır doluysa "kap dışında en az bir yol daha
 *   vardı" notuyla keşif tamamen durur (truncatedByPaths) — kısmi sonuç
 *   açıkça işaretlenir, sessiz kesme yapılmaz.
 */
function walkCallPaths(
  snapshot: SnapshotGraph,
  startId: string,
  maxDepth: number,
  maxPaths: number,
): TraceWalkResult {
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of snapshot.edges) {
    if (edge.kind !== "CALLS" && edge.kind !== "ROUTES_TO") continue;
    const list = outgoing.get(edge.from);
    if (list === undefined) {
      outgoing.set(edge.from, [edge]);
    } else {
      list.push(edge);
    }
  }

  const paths: TraceWalkPath[] = [];
  let truncatedByPaths = false;
  let truncatedByDepth = false;

  const tryRecord = (path: TraceWalkPath): boolean => {
    if (paths.length >= maxPaths) {
      // Sınır doluyken kaydedilecek YOL VARDI → kısmi sonuç açık işaretlenir.
      truncatedByPaths = true;
      return false;
    }
    paths.push(path);
    return true;
  };

  const walk = (
    currentId: string,
    nodeIds: readonly string[],
    edges: readonly GraphEdge[],
    visited: ReadonlySet<string>,
  ): void => {
    if (truncatedByPaths) return;
    const successors = (outgoing.get(currentId) ?? []).filter(
      (edge) => !visited.has(edge.to),
    );
    if (edges.length >= maxDepth) {
      if (successors.length > 0) truncatedByDepth = true;
      tryRecord({
        nodeIds,
        edges,
        stoppedReason: successors.length > 0 ? "max-depth" : "leaf",
      });
      return;
    }
    if (successors.length === 0) {
      tryRecord({ nodeIds, edges, stoppedReason: "leaf" });
      return;
    }
    for (const edge of successors) {
      if (truncatedByPaths) return;
      const nextEdges = [...edges, edge];
      if (edge.resolution === "unresolved") {
        tryRecord({
          nodeIds: [...nodeIds, edge.to],
          edges: nextEdges,
          stoppedReason: "unresolved-edge",
        });
        continue;
      }
      walk(
        edge.to,
        [...nodeIds, edge.to],
        nextEdges,
        new Set([...visited, edge.to]),
      );
    }
  };

  walk(startId, [startId], [], new Set<string>([startId]));
  return { paths, truncatedByPaths, truncatedByDepth };
}

/**
 * causoryn_trace_execution (TŞ §10.2 "Execution Flow, olası çağrı yolları";
 * sprint-2 B4): entrypoint'ten başlayan çağrı zincirlerini — CALLS ve
 * ROUTES_TO kenarları üzerinde sınırlı, deterministik DFS ile — yol listesi
 * olarak döndürür.
 *
 * Resolution disiplini (görev sözleşmesi): her kenarın resolution düzeyi
 * KENDİ alanında taşınır (TracePathEdgeSchema.resolution); zincir etiketi
 * (TracePathSchema.resolution) kenarlardan türetilen EN ZAYIF düzeydir ve
 * ayrı bir alandır — heuristic kenarlı zincir "heuristic" işaretlenir,
 * verified gibi sunulmaz. Unresolved kenara rastlayan zincir o noktada
 * biter ve envelope status "partial" olur (TŞ §10.1 örneği: status
 * "partial" + unresolved akış uyarısı).
 *
 * Determinizm (TŞ §8 invariant iv/vi): komşuluk + successor taraması
 * snapshot id kanonik sırasında; node çıktıları qualifiedName+id sıralı;
 * kanıtlar tekrarsız id sıralı — aynı girdi aynı yanıtı üretir.
 * Sınırlar (TŞ §20): maxDepth/maxPaths config tavanlarıyla sınırlıdır
 * (LIMIT_EXCEEDED); kesme data.truncated + warnings ile açık raporlanır.
 */
export function traceExecution(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof TraceExecutionInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  requireAuthorizedWorkspace(deps, workspaceId);
  const read = requireSnapshot(deps, workspaceId);
  const snapshot = read.snapshot;

  // 1) Sınır doğrulama: 0 anlamsal girdi hatası; tavan aşımı LIMIT_EXCEEDED.
  if (input.maxDepth === 0) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "maxDepth=0 geçersiz: en az 1 kenar derinlik gerekli (tavan results.maxDepth)",
    );
  }
  if (input.maxPaths === 0) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "maxPaths=0 geçersiz: en az 1 yol gerekli (tavan results.maxPaths)",
    );
  }
  if (input.maxDepth > deps.config.results.maxDepth) {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `maxDepth=${String(input.maxDepth)} results.maxDepth tavanını (${String(deps.config.results.maxDepth)}) aşıyor`,
    );
  }
  if (input.maxPaths > deps.config.results.maxPaths) {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `maxPaths=${String(input.maxPaths)} results.maxPaths tavanını (${String(deps.config.results.maxPaths)}) aşıyor`,
    );
  }

  // 2) Entrypoint çözümleme (ID → qualifiedName; belirsizlik adaylarla
  //    reddedilir — get_symbol_context ile aynı sözleşme).
  const start = resolveSymbolNode(snapshot, input.entrypoint);

  // 3) Deterministik DFS yol sayımı.
  const { paths, truncatedByPaths, truncatedByDepth } = walkCallPaths(
    snapshot,
    start.id,
    input.maxDepth,
    input.maxPaths,
  );

  // 4) Yollardaki node'lar: qualifiedName+id sıralı, tekrarsız
  //    (get_symbol_context çıktı kalıbı).
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const usedNodeIds = new Set<string>();
  for (const path of paths) {
    for (const id of path.nodeIds) usedNodeIds.add(id);
  }
  const contextNodes: GraphNode[] = [];
  for (const id of usedNodeIds) {
    const node = nodeById.get(id);
    if (node !== undefined) contextNodes.push(node);
  }
  contextNodes.sort((a, b) => {
    if (a.qualifiedName !== b.qualifiedName) {
      return a.qualifiedName < b.qualifiedName ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // 5) Kenarların kanıtları: tekrarsız, id sıralı (get_symbol_context kalıbı).
  const evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]));
  const evidenceSeen = new Set<string>();
  const evidence: Evidence[] = [];
  for (const path of paths) {
    for (const edge of path.edges) {
      for (const id of edge.evidenceIds) {
        if (evidenceSeen.has(id)) continue;
        const record = evidenceById.get(id);
        if (record === undefined) continue;
        evidenceSeen.add(id);
        evidence.push(record);
      }
    }
  }
  evidence.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // 6) Durum + uyarılar: unresolved kenar zinciri tamamlanmadı gösterir →
  //    status "partial" (görev sözleşmesi; TŞ §10.1 örneğiyle tutarlı).
  const anyUnresolved = paths.some((path) =>
    path.edges.some((edge) => edge.resolution === "unresolved"),
  );
  const unresolvedPathCount = paths.filter((path) =>
    path.edges.some((edge) => edge.resolution === "unresolved"),
  ).length;
  const heuristicPathCount = paths.filter((path) =>
    path.edges.some((edge) => edge.resolution === "heuristic"),
  ).length;

  const warnings = staleWarningOf(read);
  if (anyUnresolved) {
    warnings.push(
      `${String(unresolvedPathCount)} yol unresolved kenarda durduruldu; bilinmeyen kenarlar verified/heuristic kenarlardan ayrı raporlanır ve zincir o noktada biter (TŞ §4.2)`,
    );
  }
  if (heuristicPathCount > 0) {
    warnings.push(
      `${String(heuristicPathCount)} yol heuristic kenar içeriyor; bu yollar "heuristic" etiketlidir ve verified gibi sunulmaz`,
    );
  }
  if (truncatedByPaths) {
    warnings.push(
      `yol sayısı maxPaths=${String(input.maxPaths)} sınırıyla kesildi; kesilmeyen yollar mevcut olabilir (maxPaths'i artırın, tavan results.maxPaths)`,
    );
  }
  if (truncatedByDepth) {
    warnings.push(
      `zincir maxDepth=${String(input.maxDepth)} sınırında kesildi; daha derin devam mevcut (maxDepth'i artırın, tavan results.maxDepth)`,
    );
  }

  const status: "ok" | "partial" =
    read.snapshot.meta.state === "partial" || anyUnresolved ? "partial" : "ok";

  return buildEnvelope({
    requestId,
    workspaceId,
    snapshotId: snapshot.meta.id,
    status,
    coverage: coverageOf(snapshot),
    warnings,
    data: {
      workspaceId,
      entrypoint: symbolNodeOf(start),
      maxDepth: input.maxDepth,
      maxPaths: input.maxPaths,
      pathCount: paths.length,
      truncated: truncatedByPaths || truncatedByDepth,
      paths: paths.map((path, index) => ({
        index,
        resolution: chainResolutionOf(path.edges.map((edge) => edge.resolution)),
        nodeIds: [...path.nodeIds],
        edges: path.edges.map((edge) => ({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
          resolution: edge.resolution,
          evidenceIds: [...edge.evidenceIds],
        })),
        stoppedReason: path.stoppedReason,
      })),
      nodes: contextNodes.map(symbolNodeOf),
      evidence: evidence.map(evidenceRecordOf),
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
