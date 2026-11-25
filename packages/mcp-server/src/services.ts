import path from "node:path";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import {
  buildEvidenceChain,
  GuardError,
  parseArchitectureBaseline,
  parseArchitecturePolicy,
  resolveFindingById,
  type EvidenceChain,
  type EvidenceChainRecord,
  type GraphRepository,
  type GuardFinding,
  type SnapshotRead,
  type SymbolSearchStore,
  type WorkspaceSummaryMeta,
} from "@causoryn/graph";
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
import type { SqliteWikiStore } from "@causoryn/storage-sqlite";
import type { WikiSearchStore } from "@causoryn/wiki";
import type { OutputAccessPolicy, WorkspaceAccessPolicy } from "@causoryn/workspace";
import { z } from "zod";

import { decodeCursor, encodeCursor } from "./cursor.js";
import type { CausorynServerConfig } from "./config.js";
import { CausorynToolError } from "./errors.js";
import { buildEnvelope, type Coverage, type Envelope, type LanguageCoverage } from "./envelope.js";
import {
  readOptionalBoundedTextFileSync,
  type BoundedTextReadResult,
} from "./safe-file-read.js";
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
  /** Agent GPS FTS5 sembol arama yüzeyi (SQLite symbol_fts; yoksa/null ise degrade). */
  readonly symbolSearch?: SymbolSearchStore | null;
  /** Sprint-2 B6: causoryn_refresh_index / causoryn_index_status iş yönetimi. */
  readonly jobManager: IndexJobManager;
  /**
   * Sprint-3 C6/C8: export çıktı yetkilendirmesi. Beyanlı output dizini yoksa
   * null (default deny) — causoryn_export_documentation EXPORT_NOT_ALLOWED
   * döner. CausorynContext bu alanı config.output.allowedOutputDirs'tan kurar.
   */
  readonly outputPolicy: OutputAccessPolicy | null;
  /**
   * Sprint-4 W5: wiki projeksiyon deposu + FTS arama yüzeyi. wiki.dataDbPath
   * beyanı yoksa ikisi de null (default deny): wiki_build PATH_DENIED, wiki
   * okuma araçları INDEX_NOT_READY döner.
   */
  readonly wikiStore: SqliteWikiStore | null;
  readonly wikiSearch: WikiSearchStore | null;
  /**
   * Saat kaynağı (domain deseni): wiki_build builtAt buradan okur;
   * CausorynContext.clock ile aynı örnek.
   */
  readonly clock: () => string;
  /**
   * stderr hedefli logger (CausorynContext.logger'dan yapısal gelir): graf
   * sözleşme hataları INTERNAL_ERROR'a eşlenirken orijinal mesaj BURADA
   * loglanır — istemciye genel mesaj gider, detay kaybolmaz (TŞ §10.1).
   */
  readonly logger: (message: string) => void;
}

/* ------------------------------------------------------------------ */
/* Ortak yardımcılar                                                   */
/* ------------------------------------------------------------------ */

/**
 * Yetki denetimi (TŞ §9/§20 explicit authorization): workspaceId yapılandırılmış
 * tek workspace ile eşleşmeli ve allowRoots[0] her çağrıda politikaya karşı
 * yeniden doğrulanmalıdır. Faz C servisleri (services-architecture.ts) de
 * aynı sırayı izler: yetki ÖNCE, snapshot sonra.
 */
export function requireAuthorizedWorkspace(deps: ServiceDeps, workspaceId: string): string {
  if (workspaceId !== deps.config.workspaceId) {
    throw new CausorynToolError(
      "WORKSPACE_NOT_AUTHORIZED",
      `workspaceId is not an authorized workspace: ${workspaceId}`,
    );
  }
  const declaredRoot = deps.config.allowRoots[0];
  if (declaredRoot === undefined) {
    throw new CausorynToolError(
      "WORKSPACE_NOT_AUTHORIZED",
      "the server configuration declares no allowRoot (explicit authorization is required)",
    );
  }
  const decision = deps.policy.authorizeRoot(declaredRoot);
  if (!decision.allowed) {
    throw new CausorynToolError(
      "WORKSPACE_NOT_AUTHORIZED",
      `workspace root not authorized (${decision.code}): ${decision.reason}`,
    );
  }
  return decision.canonicalRoot;
}

/** Yayımlanmış snapshot sözleşmesi: yoksa INDEX_NOT_READY (TŞ §10.1). */
export function requireSnapshot(deps: ServiceDeps, workspaceId: string): SnapshotRead {
  const read = deps.repository.getLatestPublished(workspaceId);
  if (read === undefined) {
    throw new CausorynToolError(
      "INDEX_NOT_READY",
      `no published snapshot for workspace: ${workspaceId}; queries are unavailable until indexing completes`,
    );
  }
  return read;
}

const L2_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript",
  "javascript",
  "csharp",
  "python",
]);
const L1_LANGUAGES: ReadonlySet<string> = new Set(["go", "rust"]);
const ADAPTER_LANGUAGE_ORDER: ReadonlyMap<string, number> = new Map(
  INDEXED_ADAPTERS.map((adapter, index) => [adapter.language, index]),
);

const WORKSPACE_DEFINITION_KINDS: ReadonlySet<string> = new Set([
  "Function",
  "Class",
  "Method",
  "Interface",
  "Type",
  "TypeAlias",
  "Variable",
  "Enum",
  "Module",
  "Namespace",
  "Struct",
  "Trait",
  "Endpoint",
  "Handler",
  "Test",
]);

function isAstOrSymbolNode(node: GraphNode): boolean {
  return (
    node.kind !== "Workspace" &&
    node.kind !== "File" &&
    node.kind !== "UnknownExternal"
  );
}

/**
 * Snapshot'tan coverage istatistiği (envelope.coverage; katalogla aynı tanım).
 *
 * Dürüstlük notu: `resolvedEdges = totalEdges - unresolvedEdges` (`verified + heuristic`
 * toplamıdır); MCP envelope `coverage.coverageRatio` bu nedenle
 * `(verified + heuristic) / totalEdges` iken, sidecar worker protokol çıktılarındaki
 * `coverageRatio` `verified / totalEdges` oranıdır.
 *
 * Per-language breakdown (`byLanguage`) is computed deterministically in sorted
 * language key order so a single TypeScript file never masks L0 degradation in
 * C#, Python, Go, or Rust.
 */
export function coverageOf(snapshot: SnapshotGraph): Coverage {
  const totalEdges = snapshot.edges.length;
  const unresolvedEdges = snapshot.edges.filter((edge) => edge.resolution === "unresolved").length;
  const resolvedEdges = totalEdges - unresolvedEdges;
  const hasL2AstNodes = snapshot.nodes.some(
    (node) =>
      isAstOrSymbolNode(node) &&
      typeof node.language === "string" &&
      L2_LANGUAGES.has(node.language),
  );
  const hasL1AstNodes = snapshot.nodes.some(
    (node) =>
      isAstOrSymbolNode(node) &&
      typeof node.language === "string" &&
      L1_LANGUAGES.has(node.language),
  );
  const tier: Coverage["tier"] = hasL2AstNodes ? "L2" : hasL1AstNodes ? "L1" : "L0";
  const coverageRatio =
    totalEdges === 0 ? 0 : Math.round((resolvedEdges / totalEdges) * 10_000) / 10_000;

  interface MutableLangBucket {
    files: number;
    hasAstSymbols: boolean;
    verifiedEdges: number;
    heuristicEdges: number;
    unresolvedEdges: number;
  }
  const buckets = new Map<string, MutableLangBucket>();
  const ensureBucket = (lang: string): MutableLangBucket => {
    let bucket = buckets.get(lang);
    if (bucket === undefined) {
      bucket = {
        files: 0,
        hasAstSymbols: false,
        verifiedEdges: 0,
        heuristicEdges: 0,
        unresolvedEdges: 0,
      };
      buckets.set(lang, bucket);
    }
    return bucket;
  };

  const nodeById = new Map<string, GraphNode>();
  for (const node of snapshot.nodes) {
    nodeById.set(node.id, node);
    if (typeof node.language === "string" && node.language.length > 0) {
      const bucket = ensureBucket(node.language);
      if (node.kind === "File") {
        bucket.files += 1;
      } else if (isAstOrSymbolNode(node)) {
        bucket.hasAstSymbols = true;
      }
    }
  }

  for (const edge of snapshot.edges) {
    const fromNode = nodeById.get(edge.from);
    const toNode = nodeById.get(edge.to);
    if (fromNode?.kind === "Workspace" && edge.kind === "CONTAINS") {
      continue;
    }
    const lang =
      typeof fromNode?.language === "string" && fromNode.language.length > 0
        ? fromNode.language
        : typeof toNode?.language === "string" && toNode.language.length > 0
          ? toNode.language
          : undefined;
    if (lang === undefined) continue;
    const bucket = ensureBucket(lang);
    if (edge.resolution === "verified") {
      bucket.verifiedEdges += 1;
    } else if (edge.resolution === "heuristic") {
      bucket.heuristicEdges += 1;
    } else {
      bucket.unresolvedEdges += 1;
    }
  }

  const byLanguage: Record<string, LanguageCoverage> = {};
  const sortedLanguages = [...buckets.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const lang of sortedLanguages) {
    const bucket = buckets.get(lang) as MutableLangBucket;
    const langTier: LanguageCoverage["tier"] = !bucket.hasAstSymbols
      ? "L0"
      : L2_LANGUAGES.has(lang)
        ? "L2"
        : "L1";
    const langTotal = bucket.verifiedEdges + bucket.heuristicEdges + bucket.unresolvedEdges;
    const langResolved = bucket.verifiedEdges + bucket.heuristicEdges;
    const langRatio =
      langTotal === 0 ? 0 : Math.round((langResolved / langTotal) * 10_000) / 10_000;
    byLanguage[lang] = {
      tier: langTier,
      files: bucket.files,
      verifiedEdges: bucket.verifiedEdges,
      heuristicEdges: bucket.heuristicEdges,
      unresolvedEdges: bucket.unresolvedEdges,
      coverageRatio: langRatio,
    };
  }

  return {
    tier,
    resolvedEdges,
    unresolvedEdges,
    totalEdges,
    coverageRatio,
    byLanguage,
  };
}

/** stale/partial uyarıları (envelope.warnings; TŞ §9 eski snapshot servisi). */
function staleWarningFromState(state: string, stale: boolean): string[] {
  const warnings: string[] = [];
  if (stale) {
    warnings.push("the published snapshot is stale (stale=true); re-indexing is recommended");
  }
  if (state === "partial") {
    warnings.push(
      "snapshot is partial; coverage may be incomplete (empty sources, parse diagnostics, or out-of-scope files)",
    );
  }
  return warnings;
}

/** Envelope status çözümü: snapshot meta.state partial ise "partial". */
function envelopeStatusFromState(state: string): "ok" | "partial" {
  return state === "partial" ? "partial" : "ok";
}

function compareLanguageOrder(a: string, b: string): number {
  const rankA = ADAPTER_LANGUAGE_ORDER.get(a);
  const rankB = ADAPTER_LANGUAGE_ORDER.get(b);
  if (rankA !== undefined && rankB !== undefined) {
    return rankA - rankB;
  }
  if (rankA !== undefined) return -1;
  if (rankB !== undefined) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Zero-hydration `Coverage` builder matching `coverageOf(snapshot)` bit-for-bit
 * from aggregated `WorkspaceSummaryMeta`.
 */
function coverageFromSummaryMeta(meta: WorkspaceSummaryMeta): Coverage {
  const totalEdges = meta.edgeCount;
  const unresolvedEdges = meta.resolutions.unresolved;
  const resolvedEdges = totalEdges - unresolvedEdges;
  const hasL2AstNodes = meta.languageCoverage.some(
    (entry) => entry.hasNonFileSymbols && L2_LANGUAGES.has(entry.language),
  );
  const hasL1AstNodes = meta.languageCoverage.some(
    (entry) => entry.hasNonFileSymbols && L1_LANGUAGES.has(entry.language),
  );
  const tier: Coverage["tier"] = hasL2AstNodes ? "L2" : hasL1AstNodes ? "L1" : "L0";
  const coverageRatio =
    totalEdges === 0 ? 0 : Math.round((resolvedEdges / totalEdges) * 10_000) / 10_000;

  const byLanguage: Record<string, LanguageCoverage> = {};
  const sortedCoverage = [...meta.languageCoverage].sort((a, b) =>
    a.language < b.language ? -1 : a.language > b.language ? 1 : 0,
  );
  for (const entry of sortedCoverage) {
    const langTier: LanguageCoverage["tier"] = !entry.hasNonFileSymbols
      ? "L0"
      : L2_LANGUAGES.has(entry.language)
        ? "L2"
        : "L1";
    const langTotal = entry.verifiedEdges + entry.heuristicEdges + entry.unresolvedEdges;
    const langResolved = entry.verifiedEdges + entry.heuristicEdges;
    const langRatio =
      langTotal === 0 ? 0 : Math.round((langResolved / langTotal) * 10_000) / 10_000;
    byLanguage[entry.language] = {
      tier: langTier,
      files: entry.files,
      verifiedEdges: entry.verifiedEdges,
      heuristicEdges: entry.heuristicEdges,
      unresolvedEdges: entry.unresolvedEdges,
      coverageRatio: langRatio,
    };
  }

  return {
    tier,
    resolvedEdges,
    unresolvedEdges,
    totalEdges,
    coverageRatio,
    byLanguage,
  };
}

/** stale/partial uyarıları (envelope.warnings; TŞ §9 eski snapshot servisi). */
export function staleWarningOf(read: SnapshotRead): string[] {
  return staleWarningFromState(read.snapshot.meta.state, read.stale);
}

/** Envelope status çözümü: snapshot meta.state partial ise "partial". */
export function envelopeStatusOf(read: SnapshotRead): "ok" | "partial" {
  return envelopeStatusFromState(read.snapshot.meta.state);
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
    // Denetim bulgusu 10: get_symbol_context/trace_execution LIMIT_EXCEEDED
    // dayanağı olan tavanlar keşfedilebilir olmalı (hata metinleri istemciyi
    // "results.maxDepth/maxPaths tavanı"na yönlendirir).
    maxDepth: z.number().int().positive(),
    maxPaths: z.number().int().positive(),
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
        `workspace root not authorized (${decision.code}): ${decision.reason}`,
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
        maxDepth: deps.config.results.maxDepth,
        maxPaths: deps.config.results.maxPaths,
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

  if (deps.repository.getLatestWorkspaceSummaryMeta !== undefined) {
    const summaryMeta = deps.repository.getLatestWorkspaceSummaryMeta(workspaceId);
    if (summaryMeta === undefined) {
      throw new CausorynToolError(
        "INDEX_NOT_READY",
        `no published snapshot for workspace: ${workspaceId}; queries are unavailable until indexing completes`,
      );
    }
    const languages = [...summaryMeta.languages]
      .sort((a, b) => compareLanguageOrder(a.language, b.language))
      .map((entry) => ({
        language: entry.language,
        files: entry.files,
      }));
    const edgesByKind: Record<string, number> = {};
    for (const key of Object.keys(summaryMeta.edgesByKind).sort()) {
      edgesByKind[key] = summaryMeta.edgesByKind[key] ?? 0;
    }
    return buildEnvelope({
      requestId,
      workspaceId,
      snapshotId: summaryMeta.snapshotId,
      status: envelopeStatusFromState(summaryMeta.state),
      coverage: coverageFromSummaryMeta(summaryMeta),
      warnings: staleWarningFromState(summaryMeta.state, summaryMeta.stale),
      data: {
        workspaceId,
        revision: {
          id: summaryMeta.revisionId,
          sequence: summaryMeta.revisionSequence,
        },
        snapshotState: summaryMeta.state,
        rootPath,
        nodeCount: summaryMeta.nodeCount,
        edgeCount: summaryMeta.edgeCount,
        evidenceCount: summaryMeta.evidenceCount,
        fileCount: summaryMeta.fileCount,
        languages,
        frameworks: [...summaryMeta.frameworks],
        entrypoints: [...summaryMeta.entrypoints],
        edgesByKind,
        resolutions: {
          verified: summaryMeta.resolutions.verified,
          heuristic: summaryMeta.resolutions.heuristic,
          unresolved: summaryMeta.resolutions.unresolved,
        },
      },
    });
  }

  const read = requireSnapshot(deps, workspaceId);
  const snapshot = read.snapshot;
  const fileNodes = snapshot.nodes.filter((node) => node.kind === "File");
  const languageCounts = new Map<string, number>();
  for (const node of fileNodes) {
    if (typeof node.language === "string" && node.language.length > 0) {
      languageCounts.set(node.language, (languageCounts.get(node.language) ?? 0) + 1);
    }
  }
  const entrypoints = snapshot.nodes
    .filter((node) => node.kind === "Endpoint" || node.kind === "Handler")
    .map((node) => node.qualifiedName)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const languages = [...languageCounts.keys()]
    .sort(compareLanguageOrder)
    .map((language) => ({
      language,
      files: languageCounts.get(language) ?? 0,
    }));
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
  status: z.enum(["queued", "running", "done", "reused", "failed"]),
  outcome: z.enum(["published", "unchanged", "reused_peer", "peer_busy", "failed"]).nullable(),
  published: z.boolean(),
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

const MAX_JOB_DIAGNOSTICS_IN_RESPONSE = 50;
const MAX_JOB_WARNINGS_IN_RESPONSE = 50;

function jobRecordOf(job: IndexJobRecord): z.infer<typeof IndexJobRecordSchema> {
  const truncatedDiagnostics = Math.max(0, job.diagnostics.length - MAX_JOB_DIAGNOSTICS_IN_RESPONSE);
  const truncatedWarnings = Math.max(0, job.warnings.length - MAX_JOB_WARNINGS_IN_RESPONSE);
  const warnings = job.warnings.slice(0, MAX_JOB_WARNINGS_IN_RESPONSE);
  if (truncatedDiagnostics > 0 || truncatedWarnings > 0) {
    warnings.push(
      `[truncated] ${String(truncatedDiagnostics)} more diagnostic(s) and ${String(truncatedWarnings)} more warning(s) omitted due to the response budget (max ${String(MAX_JOB_DIAGNOSTICS_IN_RESPONSE)})`,
    );
  }
  return {
    jobId: job.jobId,
    mode: job.mode,
    scope: job.scope,
    status: job.status,
    outcome: job.outcome,
    published: job.published,
    progressPercent: job.progressPercent,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    snapshotId: job.snapshotId,
    snapshotState: job.snapshotState,
    stale: job.stale,
    fileCount: job.fileCount,
    tsFileCount: job.tsFileCount,
    diagnostics: job.diagnostics.slice(0, MAX_JOB_DIAGNOSTICS_IN_RESPONSE).map((item) => ({
      relativePath: item.relativePath,
      code: item.code,
      message: item.message,
      line: item.line,
    })),
    warnings,
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
        `unknown jobId: ${input.jobId}; the record was evicted (maxJobs) or no such job was started; call without jobId to get the latest job`,
      );
    }
  } else {
    job = deps.jobManager.latest();
  }

  if (deps.repository.getLatestWorkspaceSummaryMeta !== undefined) {
    const summaryMeta = deps.repository.getLatestWorkspaceSummaryMeta(workspaceId);
    const warnings =
      summaryMeta === undefined
        ? ["no published snapshot yet; start a snapshot job with refresh_index"]
        : staleWarningFromState(summaryMeta.state, summaryMeta.stale);

    return buildEnvelope({
      requestId,
      workspaceId,
      snapshotId: summaryMeta?.snapshotId ?? job?.snapshotId ?? null,
      // Durum aracı: yanıtın kendisi her zaman "ok"; snapshot durumu partial
      // ise katalogla tutarlı biçimde "partial" taşınır.
      status: summaryMeta === undefined ? "ok" : envelopeStatusFromState(summaryMeta.state),
      coverage: summaryMeta === undefined ? null : coverageFromSummaryMeta(summaryMeta),
      warnings,
      data: {
        workspaceId,
        jobId: job?.jobId ?? null,
        job: job === undefined ? null : jobRecordOf(job),
        latestSnapshot:
          summaryMeta === undefined
            ? null
            : {
                snapshotId: summaryMeta.snapshotId,
                state: summaryMeta.state,
                stale: summaryMeta.stale,
                nodeCount: summaryMeta.nodeCount,
                edgeCount: summaryMeta.edgeCount,
                evidenceCount: summaryMeta.evidenceCount,
              },
      },
    });
  }

  const read = deps.repository.getLatestPublished(workspaceId);
  const warnings = read === undefined
    ? [
        "no published snapshot yet; start a snapshot job with refresh_index",
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
  /** TŞ §10.2 "mode": full = tam yeniden indeksleme; incremental = karma tabanlı artımlı indeksleme (ve senkron L0 yükseltmesi). */
  mode: z.enum(["full", "incremental"]),
  /** TŞ §10.2 "scope?": dar kapsamlı refresh; araç yüzeyinde henüz desteklenmez. */
  scope: z.string().min(1).optional(),
});

/** Yeni iş kaydının başlangıç görünümü (TŞ §10.2 "Yeni snapshot işi"). */
export const RefreshIndexDataSchema = z.strictObject({
  jobId: z.string(),
  mode: z.enum(["full", "incremental"]),
  scope: z.string().nullable(),
  status: z.enum(["queued", "running", "done", "reused", "failed"]),
  progressPercent: z.number().int().min(0).max(100),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
});

/**
 * causoryn_refresh_index (TŞ §10.2 "Yeni snapshot işi"; sprint-2 B6 + B7).
 *
 * ASYNC sözleşmesi: çağrı işi kuyruğa alır ve ANINDA jobId döner (envelope
 * snapshotId null — iş henüz snapshot üretmedi); iş in-process arka planda
 * ilerler ve causoryn_index_status(jobId) ile izlenir.
 *
 * Yazma sınırı (wiki/mcp-tools.md yazma izin matrisi): indeks yalnızca
 * Causoryn'in kendi graph deposuna (varsayılan süreç-içi InMemoryGraphRepository
 * veya storage.dataDbPath ile beyanlı SQLite veri kökü) yazılır; kaynak
 * workspace dosyalarına yazılmaz — kök, her çağrıda requireAuthorizedWorkspace
 * ile allowRoot'a karşı yeniden doğrulanır ve JobManager ayrıca
 * WorkspaceAccessPolicy.authorizeRoot ile senkron reddeder (yetkisiz kök iş
 * kaydı AÇMAZ → WORKSPACE_NOT_AUTHORIZED).
 *
 * mode/scope: mode="full" ve mode="incremental" desteklenir ("incremental"
 * IndexService.runIncrementalIndexAsync koşturur). "scope" desteklenmez ve
 * açık INVALID_ARGUMENT ile reddedilir (ADR-010; kod K-008 uzantı setinden).
 */
export function refreshIndex(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof RefreshIndexInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  const canonicalRoot = requireAuthorizedWorkspace(deps, workspaceId);
  if (input.scope !== undefined) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      `scoped re-indexing is not supported by this tool (${input.scope}); use mode=full|incremental for a full or incremental re-index`,
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
    // A freshly created job never carries coalescedRequests; a value means
    // this request joined an identical job that was already queued.
    warnings:
      started.coalescedRequests === undefined
        ? []
        : [
            `refresh request coalesced into queued job ${started.jobId} (${String(started.coalescedRequests)} merged request(s)); no new job was created`,
          ],
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
 * TEK KOPYA ilkesi (denetim bulgusu): services-verification.ts aynı tabloyu
 * buradan yeniden kullanır; kopyalama sapma riskiydi.
 */
export function indexingErrorToToolError(
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
        `Unexpected internal error; see the server logs for details (requestId: ${requestId})`,
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

/** Harita düzeyi → node tür kümesi (TŞ §16 L0 repository … L3 method/type/endpoint/test). */
const MAP_LEVEL_KINDS: Readonly<Record<"L0" | "L1" | "L2" | "L3", readonly string[]>> = {
  L0: ["Workspace", "Repository", "Project"],
  L1: ["Module", "Package", "File", "Namespace", "Config"],
  L2: ["Class", "Interface", "Type"],
  L3: ["Function", "Method", "Handler", "Endpoint", "Test"],
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
      "the L4 flow map is not supported yet (use L0–L3)",
    );
  }
  const maxNodes = input.maxNodes ?? deps.config.results.maxNodes;
  if (maxNodes > deps.config.results.maxNodes) {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `maxNodes=${String(maxNodes)} exceeds the results.maxNodes ceiling (${String(deps.config.results.maxNodes)})`,
    );
  }
  let offset = 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor);
    if (decoded === null) {
      throw new CausorynToolError("INVALID_ARGUMENT", "cursor could not be decoded (corrupt or outdated format)");
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
      "query must not be only whitespace; provide the symbol name to search for",
    );
  }
  const limit = input.limit ?? deps.config.results.maxSymbols;
  if (limit > deps.config.results.maxSymbols) {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `limit=${String(limit)} exceeds the results.maxSymbols ceiling (${String(deps.config.results.maxSymbols)})`,
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
  const rawMatches = snapshot.nodes
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

  // When one or more real workspace definition symbols match the query (and the
  // caller did not explicitly filter for kind="UnknownExternal"), exclude
  // shadowed UnknownExternal placeholders from disambiguation and hits so
  // external call stubs never cause false AMBIGUOUS_SYMBOL errors.
  const realWorkspaceNames = new Set<string>();
  let hasRealWorkspaceMatch = false;
  for (const entry of rawMatches) {
    if (WORKSPACE_DEFINITION_KINDS.has(entry.node.kind)) {
      hasRealWorkspaceMatch = true;
      realWorkspaceNames.add(entry.node.qualifiedName.toLowerCase());
    }
  }
  const matches =
    input.kind === undefined && hasRealWorkspaceMatch
      ? rawMatches.filter(
          (entry) =>
            entry.node.kind !== "UnknownExternal" ||
            !realWorkspaceNames.has(entry.node.qualifiedName.toLowerCase()),
        )
      : rawMatches;

  // AMBIGUOUS_SYMBOL: multiple distinct exact matches require disambiguation.
  const exactMatches = matches.filter((entry) => entry.rank === 0);
  const realExactMatches = exactMatches.filter((entry) =>
    WORKSPACE_DEFINITION_KINDS.has(entry.node.kind),
  );
  const disambiguationMatches =
    input.kind === undefined && realExactMatches.length > 0
      ? exactMatches.filter((entry) => entry.node.kind !== "UnknownExternal")
      : exactMatches;
  if (disambiguationMatches.length > 1) {
    throw new CausorynToolError(
      "AMBIGUOUS_SYMBOL",
      `Query "${input.query.trim()}" matched ${String(disambiguationMatches.length)} distinct symbol nodes; narrow with kind/limit or select a candidate symbolId`,
      {
        candidates: disambiguationMatches.map((entry) => {
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

/** E4 zincir bağlam referansı (TŞ §16 "selection → get_evidence → kaynak
 * dosya/satır"): kanıt kaydını taşıyan graf bağlamı — katkı eden kenar /
 * karşı uç node / bulgu. location sourceHash TAŞIMAZ (taşıyıcı kaydın
 * span'ı yetkili konum kanıtıdır). */
export const EvidenceChainContextRefSchema = z.strictObject({
  kind: z.enum(["node", "edge", "finding"]),
  id: z.string(),
  label: z.string(),
  location: z
    .strictObject({
      relativePath: z.string(),
      startLine: z.number().int(),
      endLine: z.number().int(),
    })
    .optional(),
});

/** Kanıt kaydı (TŞ §8 Evidence) — kanıt taşıyan araçların çıktı bileşeni.
 * get_symbol_context (B5) bu şemayı get_evidence tanımından ÖNCE kullandığı
 * için tanım ortak bölgeye taşındı (const TDZ'si modül yükleme sırasını
 * zorlar).
 *
 * Sprint-6 E4 zenginleştirmesi (geriye uyumlu): partial/missingFields/
 * contextRefs OPTIONAL alanlar olarak eklendi; mevcut alanlar aynen
 * korunur ve alanları doldurmayan üreticilerin (get_symbol_context,
 * trace_execution, analyze_impact, derive_test_plan) çıktısı DEĞİŞMEZ.
 * Alanları yalnızca causoryn_get_evidence doldurur (zincir yüzeyi). */
export const EvidenceRecordSchema = z.strictObject({
  id: z.string(),
  kind: z.string(),
  span: EvidenceSpanSchema.optional(),
  analyzerId: z.string(),
  analyzerVersion: z.string(),
  rationale: z.string(),
  /** E4: eksik sözleşme alanı işareti (span'sız / rationale'suz eski kayıt). */
  partial: z.boolean().optional(),
  /** E4: alfabetik eksik alan listesi ("rationale" | "span"). */
  missingFields: z.array(z.string()).optional(),
  /** E4: bağlı graf bağlam referansları — (kind, id) bayt-artan, tekrarsız. */
  contextRefs: z.array(EvidenceChainContextRefSchema).optional(),
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
 * Sembol çözümleme (node kimliği YA DA TAM qualifiedName): 0 eşleşme →
 * SYMBOL_NOT_FOUND (K-011), >1 → AMBIGUOUS_SYMBOL + adaylar (find_symbols
 * AmbiguityDataSchema formu). trace_execution/get_symbol_context B4/B5 ve
 * sprint-5 Faz D causoryn_trace_business_flow (D5) ortak çözümleme
 * sözleşmesidir: belirsiz ad otomatik kesinleştirilmez (TŞ §10.3).
 */
export function resolveSymbolNode(
  snapshot: SnapshotGraph,
  symbolId: string,
): GraphNode {
  const byId = snapshot.nodes.find((node) => node.id === symbolId);
  if (byId !== undefined) return byId;
  const byNameAll = snapshot.nodes.filter((node) => node.qualifiedName === symbolId);
  const hasRealDefinition = byNameAll.some((node) =>
    WORKSPACE_DEFINITION_KINDS.has(node.kind),
  );
  const byName = hasRealDefinition
    ? byNameAll.filter((node) => node.kind !== "UnknownExternal")
    : byNameAll;
  if (byName.length === 0) {
    throw new CausorynToolError(
      "SYMBOL_NOT_FOUND",
      `Symbol not found in published snapshot: ${symbolId}; inspect node IDs from causoryn_map_system or causoryn_find_symbols`,
    );
  }
  if (byName.length > 1) {
    throw new CausorynToolError(
      "AMBIGUOUS_SYMBOL",
      `Query "${symbolId}" matched ${String(byName.length)} distinct symbol nodes; select one of the returned candidate symbolIds`,
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
        `invalid edgeKinds value(s): ${invalid.join(", ")}; edgeKinds must be a subset of EDGE_KINDS`,
      );
    }
    allowedKinds = new Set(input.edgeKinds);
  }

  // 2) depth tavanı (config; TŞ §20 resource budget) → LIMIT_EXCEEDED.
  const depth = input.depth ?? 1;
  if (depth > deps.config.results.maxDepth) {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `depth=${String(depth)} exceeds the results.maxDepth ceiling (${String(deps.config.results.maxDepth)})`,
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
      `context truncated at the results.maxNodes ceiling (${String(maxNodes)}); narrow it with depth or edgeKinds`,
    );
  }
  if (truncatedByDepth) {
    warnings.push(
      `context truncated at the requested depth=${String(depth)}; deeper neighbors exist (increase depth, up to results.maxDepth)`,
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

const DEFAULT_TRACE_MAX_DEPTH = 6;
const DEFAULT_TRACE_MAX_PATHS = 25;

export const TraceExecutionInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  /**
   * Starting node ID ("node:<hex>"), qualified symbol name, or framework
   * endpoint name ("POST /orders").
   */
  entrypoint: z.string().min(1),
  /**
   * Maximum edge depth (default 6). 0 is rejected with INVALID_ARGUMENT;
   * values above config results.maxDepth are clamped with a warning.
   */
  maxDepth: z.number().int().min(0).optional(),
  /**
   * Maximum paths to return (default 25). 0 is rejected with INVALID_ARGUMENT;
   * values above config results.maxPaths are clamped with a warning.
   */
  maxPaths: z.number().int().min(0).optional(),
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

  // 1) Bound validation: 0 is INVALID_ARGUMENT; values above server config
  //    ceilings are clamped with transparent warnings instead of crashing.
  if (input.maxDepth === 0) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "maxDepth=0 is invalid: at least 1 edge depth is required",
    );
  }
  if (input.maxPaths === 0) {
    throw new CausorynToolError(
      "INVALID_ARGUMENT",
      "maxPaths=0 is invalid: at least 1 path is required",
    );
  }
  const depthCeiling = deps.config.results.maxDepth;
  const pathsCeiling = deps.config.results.maxPaths;
  const requestedDepth = input.maxDepth ?? DEFAULT_TRACE_MAX_DEPTH;
  const requestedPaths = input.maxPaths ?? DEFAULT_TRACE_MAX_PATHS;
  const effectiveMaxDepth = Math.min(requestedDepth, depthCeiling);
  const effectiveMaxPaths = Math.min(requestedPaths, pathsCeiling);
  const clampedWarnings: string[] = [];
  if (input.maxDepth !== undefined && input.maxDepth > depthCeiling) {
    clampedWarnings.push(
      `maxDepth=${String(input.maxDepth)} exceeds server ceiling results.maxDepth=${String(depthCeiling)}; clamped to ${String(effectiveMaxDepth)}`,
    );
  }
  if (input.maxPaths !== undefined && input.maxPaths > pathsCeiling) {
    clampedWarnings.push(
      `maxPaths=${String(input.maxPaths)} exceeds server ceiling results.maxPaths=${String(pathsCeiling)}; clamped to ${String(effectiveMaxPaths)}`,
    );
  }

  // 2) Resolve entrypoint (node ID or exact qualifiedName).
  const start = resolveSymbolNode(snapshot, input.entrypoint);

  // 3) Deterministic DFS path walk.
  const { paths, truncatedByPaths, truncatedByDepth } = walkCallPaths(
    snapshot,
    start.id,
    effectiveMaxDepth,
    effectiveMaxPaths,
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

  const warnings = [...staleWarningOf(read), ...clampedWarnings];
  if (anyUnresolved) {
    warnings.push(
      `${String(unresolvedPathCount)} path(s) stopped at an unresolved edge; unresolved edges are kept separate from verified/heuristic edges`,
    );
  }
  if (heuristicPathCount > 0) {
    warnings.push(
      `${String(heuristicPathCount)} path(s) include heuristic edges and are labeled "heuristic" rather than verified`,
    );
  }
  if (truncatedByPaths) {
    warnings.push(
      `paths truncated at maxPaths=${String(effectiveMaxPaths)}; additional paths may exist (raise maxPaths up to results.maxPaths)`,
    );
  }
  if (truncatedByDepth) {
    warnings.push(
      `call chain truncated at maxDepth=${String(effectiveMaxDepth)}; deeper edges exist (raise maxDepth up to results.maxDepth)`,
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
      maxDepth: effectiveMaxDepth,
      maxPaths: effectiveMaxPaths,
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
   * Sorgulanan graph kimliği (TŞ §10.2 "node/edge/finding IDs, limit?"):
   * node:<hex> | edge:<hex> | evidence:<hex> | finding:<hex>.
   *
   * Sprint-6 E4: finding kimliği desteği EKLENDİ. Finding kimlikleri
   * snapshot'ta yaşamaz (guard.ts: kimlik kural + ihlal kimliğinden
   * türetilir); workspace kökündeki policy dosyasından deterministik
   * türetilerek çözülür (resolveFindingById). Policy yokluğu/bozukluğu
   * POLICY_INVALID, byte tavanı aşımı LIMIT_EXCEEDED (checkArchitecture
   * semantiğiyle aynı), türetilen bulgularla eşleşmeyen kimlik ise
   * EVIDENCE_NOT_FOUND'dır. Katalogdaki "limit?" alanı bu dilimde
   * bilinçli olarak açılmadı (görev kapsamı dışı — açık karar).
   */
  id: z.string().min(1),
});

/** E4 finding özet bloğu (TŞ §12 finding sözleşmesinin zincir yüzü). */
export const GetEvidenceFindingSchema = z.strictObject({
  id: z.string(),
  ruleId: z.string(),
  ruleType: z.string(),
  severity: z.string(),
  /** İhlal kaynağı node'un qualifiedName'i (no-cycles'ta SCC temsilcisi). */
  from: z.string(),
  /** İhlal hedefi node'un qualifiedName'i. */
  to: z.string(),
  /** Baseline suppression eşleşti mi (yönetişim raporlaması). */
  suppressed: z.boolean(),
  /** Yalnızca no-cycles: SCC üyelerinin qualifiedName'leri (sıralı). */
  cycle: z.array(z.string()).optional(),
});

/** E4 zincir özeti: deterministik düzen + AÇIK boş/partial durumu
 * (TŞ §8 invariant vi; "kimlik bilinir ama kanıt yok" durumunun dürüst
 * raporlanması — EVIDENCE_NOT_FOUND değildir). */
export const EvidenceChainSummarySchema = z.strictObject({
  targetKind: z.enum(["node", "edge", "evidence", "finding"]),
  /** Çözülen hedefin kimliği (istekteki id ile birebir; takım denetimi
   * bulgusu: finding dalında hangi bulgunun çözüldüğü açık taşınır). */
  targetId: z.string(),
  /** Kayıt sıralaması sözleşmesi: kanıt kimliği bayt-artan. */
  order: z.literal("evidence-id-asc"),
  recordCount: z.number().int().nonnegative(),
  /** Eksik alanlı (partial) kayıt sayısı. */
  partialCount: z.number().int().nonnegative(),
  /** Zincir boş mu (bilinen kimlik, sıfır kanıt). */
  empty: z.boolean(),
});

export const GetEvidenceDataSchema = z.strictObject({
  id: z.string(),
  /** Kimliğin snapshot'taki türü; bağlam alanlarını ayırt eder. */
  idKind: z.enum(["node", "edge", "evidence", "finding"]),
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
  /** idKind="finding" için bulgunun özeti (TŞ §12 sözleşmesinden). */
  finding: GetEvidenceFindingSchema.optional(),
  /** E4: zenginleştirilmiş kanıt zinciri (eski alanlar korunur). */
  evidence: z.array(EvidenceRecordSchema),
  /** E4: zincir özeti — her yanıtta taşınır (açık boş/partial durumu). */
  chain: EvidenceChainSummarySchema,
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

/* ------------------------------------------------------------------ */
/* get_evidence — E4 kanıt zinciri yardımcıları                         */
/* ------------------------------------------------------------------ */

/** Finding kimliği öneki (guard.ts makeFindingId sözleşmesi). */
const FINDING_ID_PREFIX = "finding:";
const EVIDENCE_POLICY_DIR = ".causoryn";
const EVIDENCE_POLICY_FILE = "architecture.rules.yaml";
const EVIDENCE_BASELINE_FILE = "architecture.baseline.yaml";

/**
 * Policy/baseline dosyasını TŞ §20 "dosya başına byte" bütçesiyle SENKRON
 * olarak tek fd üzerinden sınırlı okur (CWE-367 TOCTOU'ya karşı
 * openSync+fstatSync+bounded readSync).
 */
function readOptionalPolicyTextSync(
  absolutePath: string,
  maxBytes: number,
): BoundedTextReadResult {
  return readOptionalBoundedTextFileSync(absolutePath, maxBytes);
}

/**
 * E4 finding dalı: finding kimliğini workspace policy'sinden
 * DETERMİNİSTİK türeterek çözer (resolveFindingById → findViolations).
 * Hata semantiği checkArchitecture ile birebir aynıdır: policy yokluğu/
 * çözümleme reddi → POLICY_INVALID (sabit; guard/* eşlemesi), byte tavanı
 * aşımı → LIMIT_EXCEEDED. Türetilen bulgularla eşleşmeyen kimlik →
 * EVIDENCE_NOT_FOUND (deterministik lookup isabeti; uydurma yoktur).
 */
function resolveFindingFromWorkspace(
  deps: ServiceDeps,
  canonicalRoot: string,
  snapshot: SnapshotGraph,
  findingId: string,
): GuardFinding {
  const maxPolicyBytes = deps.config.maxFileBytes;
  const policyRead = readOptionalPolicyTextSync(
    path.join(canonicalRoot, EVIDENCE_POLICY_DIR, EVIDENCE_POLICY_FILE),
    maxPolicyBytes,
  );
  if (policyRead.status === "too-large") {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `${EVIDENCE_POLICY_DIR}/${EVIDENCE_POLICY_FILE} exceeds the config.maxFileBytes ceiling (${String(maxPolicyBytes)} bytes) for a single file; shrink the policy file or split its rules`,
    );
  }
  if (policyRead.status !== "ok") {
    throw new CausorynToolError(
      "POLICY_INVALID",
      `finding ID could not be resolved: policy file not found: ${EVIDENCE_POLICY_DIR}/${EVIDENCE_POLICY_FILE} (relative to the workspace root); finding IDs are derived from the workspace policy, so create the rules file or take IDs from causoryn_check_architecture output`,
    );
  }
  const baselineRead = readOptionalPolicyTextSync(
    path.join(canonicalRoot, EVIDENCE_POLICY_DIR, EVIDENCE_BASELINE_FILE),
    maxPolicyBytes,
  );
  if (baselineRead.status === "too-large") {
    throw new CausorynToolError(
      "LIMIT_EXCEEDED",
      `${EVIDENCE_POLICY_DIR}/${EVIDENCE_BASELINE_FILE} exceeds the config.maxFileBytes ceiling (${String(maxPolicyBytes)} bytes) for a single file; shrink the baseline file`,
    );
  }
  let finding: GuardFinding;
  try {
    const policy = parseArchitecturePolicy(policyRead.text);
    const baseline =
      baselineRead.status === "ok"
        ? parseArchitectureBaseline(baselineRead.text)
        : { version: 1 as const, suppressions: [] };
    const resolved = resolveFindingById({
      snapshot,
      policy,
      baseline,
      findingId,
    });
    if (resolved === undefined) {
      throw new CausorynToolError(
        "EVIDENCE_NOT_FOUND",
        `finding ID does not match any finding derived from the workspace policy: ${findingId}; take finding IDs from causoryn_check_architecture output (the policy file may have changed since the findings were produced)`,
      );
    }
    finding = resolved;
  } catch (error) {
    // GuardError → POLICY_INVALID (graphErrorToToolError'ın guard/*
    // eşlemesinin yerel karşılığı; servisler arası döngü import'undan
    // kaçınmak için tek kod burada eşlenir).
    if (error instanceof CausorynToolError) throw error;
    if (error instanceof GuardError) {
      throw new CausorynToolError("POLICY_INVALID", error.message);
    }
    throw error;
  }
  return finding;
}

/** Zincir kaydını çıktı formuna taşır (E4 alanlarıyla birlikte). */
function chainRecordToOutput(
  record: EvidenceChainRecord,
): z.infer<typeof EvidenceRecordSchema> {
  return {
    id: record.id,
    kind: record.kind,
    ...(record.span === undefined ? {} : { span: { ...record.span } }),
    analyzerId: record.analyzerId,
    analyzerVersion: record.analyzerVersion,
    rationale: record.rationale,
    partial: record.partial,
    missingFields: [...record.missingFields],
    contextRefs: record.contextRefs.map((ref) => ({
      kind: ref.kind,
      id: ref.id,
      label: ref.label,
      ...(ref.location === undefined ? {} : { location: { ...ref.location } }),
    })),
  };
}

/** Zincir özetini çıktı formuna taşır (açık boş/partial durumu). */
function chainSummaryToOutput(chain: EvidenceChain): z.infer<typeof EvidenceChainSummarySchema> {
  return {
    targetKind: chain.targetKind,
    targetId: chain.targetId,
    order: chain.order,
    recordCount: chain.recordCount,
    partialCount: chain.partialCount,
    empty: chain.empty,
  };
}

/**
 * Savunma: hedef kimliği yukarıdaki dalda bulunduğu için zincir tanımsız
 * olamaz; yine de tanımsızsa dürüst sabit kodla düş (INTERNAL_ERROR
 * uydurulmaz).
 */
function requireChain(chain: EvidenceChain | undefined): EvidenceChain {
  if (chain === undefined) {
    throw new CausorynToolError(
      "EVIDENCE_NOT_FOUND",
      "evidence chain could not be built: the target ID was not found in the published snapshot",
    );
  }
  return chain;
}

/**
 * causoryn_get_evidence (TŞ §10.2 "Evidence Graph provenance"; sprint-1
 * görev 7; sprint-6 E4 zenginleştirmesi): verilen node/edge/evidence/
 * finding kimliğinin KANIT ZİNCİRİNİ döndürür.
 *
 * Semantik (Faz A tabanı korunur; E4 zenginleştirme):
 * - EDGE: kenarın kendi evidenceIds kayıtları (TŞ §8'de kanıt bağı kenar
 *   üzerindedir; verified kenar ≥1 kanıt — invariant i). Bağlam: kenarın
 *   uç node'ları.
 * - NODE: komşu kenarların (from veya to = id) kanıtları; tekrarsız ve
 *   kanıt kimliğine göre kanonik düzende. Bağlam: katkı eden kenar +
 *   karşı uç node. Komşusu olmayan düğüm (ör. boş workspace'taki
 *   Workspace node'u) BOŞ zincir döndürür (chain.empty=true) — kimlik
 *   mevcut olduğundan EVIDENCE_NOT_FOUND değildir.
 * - EVIDENCE: kanıt kaydının kendisi; bağlam: bu kanıtı kullanan kenarlar.
 * - FINDING (E4, TŞ §10.2 "node/edge/finding IDs"): bulgu kimlikleri
 *   snapshot'ta yaşamaz; workspace policy'sinden deterministik türetilir
 *   (resolveFindingFromWorkspace). Policy yokluğu/bozukluğu POLICY_INVALID,
 *   byte tavanı aşımı LIMIT_EXCEEDED (checkArchitecture semantiği), eşleşen
 *   bulgu yoksa EVIDENCE_NOT_FOUND.
 * - Eksik alanlar UYDURULMAZ: span'sız / rationale'suz eski kayıtlar
 *   partial=true + missingFields ile AÇIK işaretlenir (TŞ §16 "kaynak
 *   dosya/satır" akışı için dürüstlük).
 * - Hiçbiri değilse sabit proje uzantısı kodu EVIDENCE_NOT_FOUND.
 */
export function getEvidence(
  deps: ServiceDeps,
  requestId: string,
  input: z.infer<typeof GetEvidenceInputSchema>,
): Envelope {
  const workspaceId = input.workspaceId ?? deps.config.workspaceId;
  const canonicalRoot = requireAuthorizedWorkspace(deps, workspaceId);
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
    const chain = requireChain(
      buildEvidenceChain({ snapshot, target: { kind: "node", id } }),
    );
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
        evidence: chain.records.map(chainRecordToOutput),
        chain: chainSummaryToOutput(chain),
      },
    });
  }

  // 2) Edge kimliği: kenarın kendi kanıtları.
  const edge = snapshot.edges.find((candidate) => candidate.id === id);
  if (edge !== undefined) {
    const chain = requireChain(
      buildEvidenceChain({ snapshot, target: { kind: "edge", id } }),
    );
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
        evidence: chain.records.map(chainRecordToOutput),
        chain: chainSummaryToOutput(chain),
      },
    });
  }

  // 3) Evidence kimliğinin kendisi; bağlam: kanıtı kullanan kenarlar.
  const record = snapshot.evidence.find((item) => item.id === id);
  if (record !== undefined) {
    const chain = requireChain(
      buildEvidenceChain({ snapshot, target: { kind: "evidence", id } }),
    );
    return buildEnvelope({
      ...envelopeBase,
      status: envelopeStatusOf(read),
      data: {
        id,
        idKind: "evidence",
        evidence: chain.records.map(chainRecordToOutput),
        chain: chainSummaryToOutput(chain),
      },
    });
  }

  // 4) Finding kimliği (E4): workspace policy'sinden deterministik türetme;
  //    yalnızca finding:<...> biçimli kimlikler bu dala girer — node/edge/
  //    evidence sorguları workspace dosyalarına ASLA dokunmaz.
  if (id.startsWith(FINDING_ID_PREFIX)) {
    const finding = resolveFindingFromWorkspace(deps, canonicalRoot, snapshot, id);
    const chain = requireChain(
      buildEvidenceChain({ snapshot, target: { kind: "finding", finding } }),
    );
    return buildEnvelope({
      ...envelopeBase,
      status: envelopeStatusOf(read),
      data: {
        id,
        idKind: "finding",
        finding: {
          id: finding.id,
          ruleId: finding.ruleId,
          ruleType: finding.ruleType,
          severity: finding.severity,
          from: finding.from,
          to: finding.to,
          suppressed: finding.suppressed,
          ...(finding.cycle === undefined ? {} : { cycle: [...finding.cycle] }),
        },
        evidence: chain.records.map(chainRecordToOutput),
        chain: chainSummaryToOutput(chain),
      },
    });
  }

  // 5) Bulunamayan kimlik → sabit hata kodu (görev sözleşmesi; TŞ §10.1
  //    listesinde olmayan proje uzantısı — bkz. errors.ts başlığı).
  throw new CausorynToolError(
    "EVIDENCE_NOT_FOUND",
    `ID not found in the published snapshot: ${id}; take node/edge IDs from map_system/find_symbols and finding IDs from causoryn_check_architecture output`,
  );
}
