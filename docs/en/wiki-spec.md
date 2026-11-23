# Living Wiki Engine — Design & Implementation Specification

> **Language:** [Türkçe](../wiki-spec.md) | **English**
>
> **Evidence:** `raw/Causoryn_Teknik_Dokuman_v2.1.pdf` (Technical Specification v2.1) — §16A pp. 14–18, §10 pp. 9–10, §8–§9 pp. 8–9, §19–§20 pp. 21–22, §23 p. 23, §24–§25 pp. 23–24 · `wiki/mcp-tools.md` · `wiki/scope.md` · `wiki/sprint-4.md` · `packages/wiki/src/*` · `packages/storage-sqlite/src/*` · `packages/mcp-server/src/services-wiki.ts`

> **STATUS (`v0.2.2` Pre-1.0 Public Preview — ADR-010 Honesty Summary):**
> - **Shipped core & MCP surface:** The pure `@causoryn/wiki` projection engine (`projectWiki`, `projectWikiIncremental`, `resolveWikiLinks`, `buildWikiLinkIndex`, `WikiSearchStore`, `AnnotationOverlayEngine`, `exportWikiOffline`, `computeWikiCoverageDeltas`, `computeWikiContractChanges`), `@causoryn/storage-sqlite` (`SqliteWikiStore`: `wiki_snapshots`, `wiki_pages`, `wiki_page_sections`, `wiki_links`, `wiki_page_versions`, `wiki_annotations`, `wiki_aliases`, `wiki_fts`), and **all 7 MCP Wiki tools** in `packages/mcp-server/src/services-wiki.ts` are registered in the server.
> - **Data-root provisioning & `.git`-less `working-tree` compatibility (K-021):** Alongside explicit `wiki.dataDbPath` configuration, `causoryn mcp --allow-cwd --auto-data-dir [--client <id>]` (and dynamic MCP `roots/list` workspace binding in desktop IDEs) automatically provisions an out-of-tree SQLite database at `~/.causoryn/workspaces/<slug>-<hash12>/graph[-<client>].sqlite`. Furthermore, in workspaces without a `.git` directory (such as exported source archives), the `working-tree` revision resolves directly without spawning `git`.
> - **Open 1.0.0 release gates:** (1) Extra filter fields on `causoryn_wiki_search` (`kinds`, `scope`, `language`, `revision`, `resolution`) are declared in the schema but explicitly rejected with `INVALID_ARGUMENT` on the v0.2.2 MCP surface (and the unpopulated `proximity` rank leg is honestly reported via `skippedRankLegs`); (2) `WIKI_NOTE_CONFLICT` is fully implemented as `wiki/annotation-conflict` in `AnnotationOverlayEngine`, while its registration in MCP `CAUSORYN_TOOL_ERROR_CODES` is deferred until local note CLI/UI write flows ship in 1.0.0 (K-014); (3) automatic Wiki rebuilds on `causoryn_refresh_index` (`wiki.autoBuildOnSnapshot`) and `causoryn_export_documentation(view="wiki")` MCP wiring remain open 1.0.0 items (Wiki rebuilds are triggered explicitly via `causoryn_wiki_build`, and `view="wiki"` returns `INVALID_ARGUMENT`); incremental `wiki_build` preserves unchanged page `contentHash` values while writing a complete `WikiSnapshot` row set per publication in SQLite.

## 1. Purpose and Scope

The Living Wiki Engine is Causoryn's **cross-cutting** 19th deliverable, unifying the 18 core architectural intelligence capabilities into a navigable, versioned project Wiki. The Wiki is **not** a separate code analysis engine; it is a deterministic, versioned, queryable **projection** of the Unified Evidence & Knowledge Graph (ADR-011: *Living Wiki as Graph Projection*, Technical Specification §24).

The same graph snapshot and template version produce the same WikiSnapshot ID. The pure projection takes `builtAt` as an input. The MCP server gets the build and publication timestamps from its runtime clock, so timestamp fields can vary across builds. Evidence and page content derive from the source graph.

- **Source of truth**: authorized source code + `GraphSnapshot` + Git revisions + contract files. Human annotations and host-model narrative proposals never replace the source of truth (§16A).
- **Relationship to the 18 core features**: The Wiki replaces none of the 18 features; it aggregates them into a unified navigation surface (§2.3, §25 item 10). Core engines for Architecture Map, Impact Analysis, Contracts, Verification, and Onboarding operate independently; the Wiki renders their evidence-backed projection.
- **Governing ADRs**: ADR-011 (Graph Projection), ADR-012 (Generated/Overlay Separation), and ADR-013 (Wiki Revision & Link Integrity), together with ADR-004 (Evidence First), ADR-005 (Immutable Snapshots), ADR-008 (Read-only Workspace Default), and ADR-010 (Incomplete Feature Never Advertised as Done).
- **Locked tool catalog**: 22 core tools + 7 Wiki tools = **29 MCP tools** (§2.3, `wiki/mcp-tools.md`).

## 2. Wiki Page Kinds and Purpose

### 2.1 Default Page Tree (Technical Specification §16A.1)

Every workspace Wiki exposes 12 root categories in taxonomy order (`packages/wiki/src/taxonomy.ts` `WIKI_ROOT_CATEGORIES`):

```
Workspace Wiki
├── Overview                  # repository, languages, scope, unknowns
├── Architecture              # L0–L4 layer/module/component summaries
├── Projects & Modules        # per-module components + dependencies
├── APIs & Entry Points       # endpoints, handlers, route links
├── Business Flows            # end-to-end flows (e.g., checkout/order)
├── Events & Integrations     # producers/consumers, async contracts
├── Data & Schemas            # entities, tables, read/write access
├── Contracts & Policies      # API/event/schema contracts, policies
├── Tests & Quality           # test nodes, TESTS edges, coverage gaps
├── Architecture Timeline     # commit-based evolution / ADR references
├── Onboarding                # learning paths, critical modules
└── Unresolved & Coverage     # unresolved edges, UnknownExternal nodes
```

### 2.2 Page Kinds (`kind`) and Graph Sources

Supported page kinds (§16A.1, p. 16): `overview | architecture | project | module | component | symbol | api | business_flow | event | data | contract | policy | test | timeline | onboarding | coverage`.

| `kind` | Purpose | Primary Graph Source |
|---|---|---|
| `overview` | Summary of repository, languages, node/edge/evidence counts | `Workspace` / `Repository` / `Project` nodes |
| `architecture` | L0–L4 layer/module/component breakdown | `CONTAINS` / `DEPENDS_ON` edges + layer node counts |
| `project` | Project-level module inventory and ownership | `Project` / `Module` nodes |
| `module` | Per-module components and inbound/outbound dependencies | `Module` nodes + `CONTAINS` + `DEPENDS_ON` |
| `component` | Component (class/service cluster) detail | `Class` / `Interface` / `Function` nodes |
| `symbol` | Individual symbol declaration, relations, and evidence | Symbol nodes + `CALLS` / `IMPORTS` |
| `api` | Endpoint routes, handlers, and contract links | `Endpoint` / `Handler` + `ROUTES_TO` / `HANDLES` |
| `business_flow` | End-to-end flow (e.g., checkout/order) | Execution / Business Flow projection |
| `event` | Event/topic/queue publishers and subscribers | `Event` / `Topic` / `Queue` + `PUBLISHES` / `SUBSCRIBES` |
| `data` | Database tables, schemas, and reader/writer edges | `Database` / `Table` / `Column` + `READS` / `WRITES` |
| `contract` | API, event, and schema contract definitions | `ApiContract` / `EventContract` / `SchemaContract` / `ContractVersion` |
| `policy` | Architectural guard rules, drift, and suppressions | Guard policy + baseline suppression data |
| `test` | Test inventory, `TESTS` edges, and coverage gaps | `Test` nodes + `TESTS` edges |
| `timeline` | Commit-level architectural evolution | Git revisions + `CHANGED_IN` |
| `onboarding` | Topological learning path and high-centrality modules | Onboarding Mode output |
| `coverage` | Unresolved edges, `UnknownExternal` nodes, parser gaps | `unresolved` edges + `UnknownExternal` nodes |

When a page kind is not supported by a workspace's active adapters, the page returns `unsupported` or `partial` coverage rather than fabricated prose (`packages/wiki/src/projection.ts`: root categories whose inputs live outside `GraphSnapshot` — `business_flow`, `timeline`, and `onboarding` — honestly report `no_data`, while child pages materialize via `WIKI_CHILD_PAGE_SOURCES` for `module`, `api`, `event`, `data`, and `contract` nodes).

### 2.3 Page Generation Principles (§16A.1)

1. **No module or endpoint page is ever generated without backing graph nodes.** Empty category pages carry `coverage.status: "no_data"` and `generatedMarkdown: ""`; filler prose is never synthesized.
2. Every page exposes: `kind, pageId, parentId, title, route, graphSnapshotId, wikiSnapshotId, coverage, freshness, sourceRefs`.
3. `pageId` is derived deterministically via SHA-256 from **canonical graph identity + page kind** (`wikiRootPageIdFor`, `wikiChildPageId`), preserving stable identity across display title or slug formatting changes.
4. When a rename or relocation cannot be resolved with certainty, `wiki_aliases` records a `candidate_redirect` entry rather than silently guessing (see `WikiPageAlias`, §3.6, and `resolveWikiLinks`, §3.3).

## 3. Data Model — Zod Schemas

Field names follow the Technical Specification §16A.7 (p. 17) entity catalog: `WikiSnapshot, WikiPage, WikiPageSection, WikiLink, WikiPageVersion, WikiAnnotation, WikiPageAlias, WikiSearchIndex`. Runtime Zod schemas (`z.strictObject`) live in `packages/wiki/src/{schema.ts,links.ts,overlay.ts,search-schema.ts}` and map 1-to-1 to the `wiki_*` SQLite table family in `packages/storage-sqlite/src/{wiki-schema.ts,wiki-store.ts}`, incorporating all finalized K-013 decisions.

### 3.0 Common Types (§8, p. 8)

```ts
import { z } from "zod";

// Technical Specification §8: Resolution — `verified` is static/checker proof, NOT a runtime guarantee.
export const WikiResolutionSchema = z.enum(["verified", "heuristic", "unresolved"]);

// Reference to a Graph Evidence/SourceSpan (§8). Evidence without a source span is never fabricated
// into a fake location; affected sections degrade to `partial` with a warning.
export const EvidenceRefSchema = z.strictObject({
  evidenceId: z.string(),
  relativePath: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  sourceHash: z.string(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
```

### 3.1 WikiSnapshot (§16A.7)

```ts
// K-013 #1: aligned 1-to-1 with GraphSnapshot.state; there is no separate "error" enum value.
export const WikiSnapshotStatusSchema = z.enum(["building", "ready", "partial", "failed"]);

export const WikiSnapshotSchema = z.strictObject({
  id: z.string(),               // wikiSnapshotId — deterministically derived from graphSnapshotId + WIKI_TEMPLATE_VERSION
  workspaceId: z.string(),
  graphSnapshotId: z.string(),  // immutable source snapshot (ADR-005); only ready/partial snapshots are projectable (§9)
  revisionRef: z.string(),      // Git commit SHA or working-tree revision descriptor (§16A.4)
  status: WikiSnapshotStatusSchema,
  builtAt: z.iso.datetime(),    // ISO 8601 UTC from injected clock; excluded from deterministic snapshot ID hash
  templateVersion: z.string(),  // versioned generated Markdown templates (§16A.7)
});
export type WikiSnapshot = z.infer<typeof WikiSnapshotSchema>;
```

Two-level versioning (§16A.4): **GraphSnapshot** → deterministically derived **WikiSnapshot** (`deriveWikiSnapshotId`). Git commit SHAs provide immutable revision identity while branches/tags act as moving aliases. For dirty workspaces or workspaces without a `.git` directory, `working-tree` / revision descriptors (`treeFingerprint + configHash + analyzerVersion`) are used so projection and `working-tree` version lookups work cleanly even outside Git repositories.

### 3.2 WikiPage and WikiPageSection (§16A.7, §16A.1)

```ts
export const WikiPageKindSchema = z.enum([
  "overview", "architecture", "project", "module", "component", "symbol", "api",
  "business_flow", "event", "data", "contract", "policy", "test", "timeline",
  "onboarding", "coverage",
]);

// K-013 #3: finalized coverage and freshness enums.
export const CoverageStatusSchema = z.enum(["complete", "partial", "unsupported", "no_data"]);
export const FreshnessSchema = z.enum(["fresh", "stale"]);

export const WikiPageSchema = z.strictObject({
  id: z.string(),                    // pageId — SHA-256 over canonical graph identity + kind (§16A.1)
  wikiSnapshotId: z.string(),
  kind: WikiPageKindSchema,
  parentId: z.string().nullable(),   // null on the 12 root category pages
  title: z.string(),
  slug: z.string(),
  route: z.string(),
  contentHash: z.string(),           // deterministic hash over section payloads — incremental invalidation key (§16A.10)
  freshness: FreshnessSchema,
  coverage: z.strictObject({
    status: CoverageStatusSchema,
    detail: z.string().optional(),
  }),
});
export type WikiPage = z.infer<typeof WikiPageSchema>;

export const WikiPageSectionStatusSchema = z.enum(["ok", "partial", "no_data"]); // K-013 #3

export const WikiPageSectionSchema = z.strictObject({
  id: z.string(),
  pageId: z.string(),
  sectionKey: z.string(),             // fixed template section key versioned by WIKI_TEMPLATE_VERSION
  generatedMarkdown: z.string(),      // strictly source-derived; never edited manually (ADR-012)
  evidenceRefs: z.array(EvidenceRefSchema),
  status: WikiPageSectionStatusSchema,
});
export type WikiPageSection = z.infer<typeof WikiPageSectionSchema>;
```

Rule (§16A.7): `WikiPage` carries **only source-derived section data**, and generated Markdown templates are version-locked via `WIKI_TEMPLATE_VERSION`. `WikiProjectionSchema` enforces unique page/section IDs and referential integrity (`section.pageId` and `page.parentId`) via `superRefine`.

### 3.3 WikiLink (§16A.2, §16A.7)

```ts
export const WikiLinkKindSchema = z.enum([
  "PARENT_OF", "DOCUMENTS", "DEPENDS_ON", "CALLS", "IMPLEMENTS", "PRODUCES",
  "CONSUMES", "TESTED_BY", "FLOWS_TO", "RELATED_CONTRACT", "CHANGED_IN",
]);

export const WikiLinkSchema = z
  .strictObject({
    id: z.string(),
    wikiSnapshotId: z.string(),
    fromPageId: z.string(),
    toPageId: z.string().nullable(), // K-013 #4: unresolved targets are preserved with toPageId=null
    kind: WikiLinkKindSchema,
    resolution: WikiResolutionSchema,
    evidenceRefs: z.array(EvidenceRefSchema), // every verified link requires ≥1 EvidenceRef (§16A.7, ADR-004)
  });
export type WikiLink = z.infer<typeof WikiLinkSchema>;
```

Behavioral rules (`packages/wiki/src/links.ts`, §16A.2 + K-013 #4):

- Every link traces back to a `GraphEdge`, contract relationship, or taxonomy parent; if a `verified` graph edge has no spanned `EvidenceRef`, its Wiki link downgrades to `heuristic` with an explicit warning (verified links are never faked).
- **Backlinks are derived automatically in O(1) via a reverse index** (`buildWikiLinkIndex`); duplicate reciprocal link rows are never stored (ADR-013).
- If a link target is removed or cannot be resolved, the link row is **not** silently dropped: it is persisted with `toPageId: null`, excluded from target backlink buckets, and paired with a **`brokenLinkDiagnostics`** record (`{ linkId, fromPageId, toRef, kind, reason }`, K-013 #4).
- Links resolved through an alias with `matchConfidence < 1` automatically cap `verified` resolution down to `heuristic`.
- Rendering URLs/anchors always enforces normalized `pageId` slugs, permitted routes, and HTML escaping.

### 3.4 WikiPageVersion (§16A.4, §16A.7)

```ts
export const WikiPageVersionSchema = z.strictObject({
  pageId: z.string(),
  wikiSnapshotId: z.string(),
  revisionRef: z.string(),     // immutable commit SHA or working-tree descriptor
  contentHash: z.string(),
  linkSetHash: z.string(),     // outbound link-set integrity hash (ADR-013)
  templateVersion: z.string(), // §16A.4 minimum version metadata
  coverage: z.strictObject({ status: CoverageStatusSchema }),
});
export type WikiPageVersion = z.infer<typeof WikiPageVersionSchema>;
```

Version boundaries: under shallow clones, pruned Git objects, data migrations, or revisions for which no `WikiSnapshot` exists in the data-root, queries return `availability: "not_available"` with `notAvailableReason`; historical versions do not imply infinite retention. Git ref verification uses strictly read-only `git cat-file -t` **without `git checkout`, `reset`, or `clean`** (Red Line 3), while `working-tree` resolves directly without requiring `.git`.

### 3.5 WikiAnnotation — Overlay Layer (§16A.6, §16A.7)

Every Wiki page separates two layers (ADR-012: Generated/Overlay Separation, `packages/wiki/src/overlay.ts`):

- **Generated layer**: deterministically projected from `GraphSnapshot`; regenerated freely on every rebuild and **never edited by hand**.
- **Overlay layer**: human notes, team rationale, external links, and user-accepted host-model proposals.

```ts
export const AnnotationAuthorKindSchema = z.enum(["human", "host_model_proposal"]);
export const AnnotationOriginSchema = z.enum([
  "human_note",            // human/team note
  "external_link",         // external reference link
  "host_model_proposal",   // host-model text explicitly accepted by a user — verified MUST remain false
]);

export const WikiAnnotationSchema = z.strictObject({
  id: z.string().min(1),
  stablePageId: z.string().min(1),       // survives deterministic page regeneration (§16A.6)
  sectionKey: z.string().min(1),         // target section; rendered OUTSIDE generatedMarkdown
  authorKind: AnnotationAuthorKindSchema,
  origin: AnnotationOriginSchema.optional(),
  verified: z.boolean().optional(),      // superRefine forbids verified=true when origin=host_model_proposal (§16A.6)
  body: z.string(),
  annotationVersion: z.number().int().nonnegative(), // optimistic concurrency CAS (§16A.6)
  updatedAt: z.iso.datetime(),
});
export type WikiAnnotation = z.infer<typeof WikiAnnotationSchema>;
```

Rules (§16A.6 + `AnnotationOverlayEngine`):

- `WikiAnnotation` rows live in an isolated `wiki_annotations` table (with no foreign-key cascade from generated `wiki_*` snapshot tables); rebuilding generated pages **never overwrites or deletes** annotations.
- Creating or editing annotations requires a **separate local UI/CLI workflow** with explicit user consent. **No MCP tool writes annotations** — none of the 7 published Wiki MCP tools mutate notes (see §5.2).
- If a user optionally accepts prose drafted by a host LLM, it is stored with `authorKind: "host_model_proposal"`, `origin: "host_model_proposal"`, and `verified: false`, rendered with a distinct visual header separate from human notes. Causoryn itself never invokes any LLM (Red Line 1).
- Human notes without source-code backing never acquire `Evidence` provenance status.
- When a page is removed or renamed to a new identity, annotations are never deleted: `markAnnotationOrphans` derives `orphan: true` against the current `pageId` set, and if the page returns with the same deterministic `pageId`, orphan recovery happens automatically with zero writes (§19).
- Optimistic concurrency: `AnnotationOverlayEngine.updateAnnotation` enforces atomic compare-and-swap via `expectedAnnotationVersion`, throwing `wiki/annotation-conflict` on version mismatch.
- Including manual notes in exports defaults to **opt-in** (`includeManualNotesInExport: false`, §20).

### 3.6 WikiPageAlias (§16A.1, §16A.7)

```ts
export const WikiPageAliasSchema = z.object({
  oldPageId: z.string(),
  candidateNewPageId: z.string().nullable(),
  reason: z.string(),                          // e.g., rename, relocation
  matchConfidence: z.number().min(0).max(1),   // < 1 downgrades resolved verified links to heuristic
});
export type WikiPageAlias = z.infer<typeof WikiPageAliasSchema>;
```

Uncertain renames/relocations are stored as `candidate_redirect` entries in `wiki_aliases` (`packages/wiki/src/links.ts` `WikiAliasEntry`); **ambiguous matches are never silently promoted to verified links**.

### 3.7 WikiSearchIndex — FTS5 (§16A.3, §16A.7)

FTS5 indexed columns (`wiki_fts`, `packages/wiki/src/search-store.ts`): `title, qualified_symbol, api_route, module, tags, body` (`manualNotes` search inclusion is opt-in per §20: `wiki.includeManualNotesInSearch: false`).

Search ranking (`packages/wiki/src/search-ranking.ts`, §16A.3): **exact symbol/route match > title > module > BM25/FTS5 body rank > graph proximity** (with deterministic `pageId` lexical tie-breaking). Relevance transparency is provided via `matchedFields` (computed across six static column-scoped FTS queries) and `evidenceIds`; opaque vector/embedding scores never appear because Causoryn uses **zero embedding services** (Red Line 1). When graph proximity distances are not supplied, `skippedRankLegs` honestly reports the skipped leg. Query normalization, FTS phrase escaping (`escapeFtsPhrase` bound via prepared parameters), and cursor/limit bounds (default 50, cap 200 — K-013 #5) are enforced on every search.

## 4. MCP Tool Contracts — 7 Wiki Tools

### 4.1 Standard Envelope and Error Codes (§10.1)

All 7 Wiki tools return the standard 10-field `EnvelopeSchema` (§16A.8): `schemaVersion` (`"2.0"`), `requestId`, `workspaceId`, `snapshotId` (the served `WikiSnapshot` ID), `status` (`ok | partial | error`), `coverage` (populated from the source `GraphSnapshot` on `wiki_build`; `null` on the 6 read tools), `warnings`, `data`, `nextCursor` (identical to `data.nextCursor` across all 5 paginated Wiki tools), and `error` (`{code, message, retryable, userAction} | null`). `stdout` carries only MCP protocol traffic; logs go to `stderr` (Red Line 4). Stack traces never enter MCP responses. All 7 tools declare MCP `annotations`: `causoryn_wiki_build` sets `readOnlyHint: false`, and the 6 query tools set `readOnlyHint: true`.

Error code governance (`packages/mcp-server/src/errors.ts`, `services-wiki.ts`, K-014):

- **Active fixed error codes (`WIKI_TOOL_ERROR_CODES_USED`):** `WORKSPACE_NOT_AUTHORIZED`, `PATH_DENIED`, `INDEX_NOT_READY`, `EVIDENCE_NOT_FOUND` (when an explicit `snapshotId` is not found), `LIMIT_EXCEEDED`, `INVALID_ARGUMENT`, `INVALID_REVISION`, `WIKI_PAGE_NOT_FOUND` (Spec §10.1 fixed code for unknown `pageId`/`parentId`), `EXPORT_NOT_ALLOWED` (mapped for offline export authorization denials), and `INTERNAL_ERROR`.
- **Intentionally unused / deferred Spec §10.1 Wiki codes (K-014 honesty note):**
  - `WIKI_REVISION_NOT_AVAILABLE`: Unresolvable Git aliases return `INVALID_REVISION` (K-013 #6), while valid Git revisions without a stored `WikiSnapshot` report `availability: "not_available"` + `notAvailableReason` in `data.versions` rather than throwing an error.
  - `WIKI_BROKEN_LINK`: Per K-013 #4, broken links are modeled as **diagnostic data** (`toPageId: null` + `brokenLinkDiagnostics`), not tool errors.
  - `WIKI_NOTE_CONFLICT`: Optimistic concurrency CAS conflicts are implemented in core `AnnotationOverlayEngine.updateAnnotation` (`wiki/annotation-conflict`); registering `WIKI_NOTE_CONFLICT` in MCP `CAUSORYN_TOOL_ERROR_CODES` / `TOOL_ERROR_GUIDANCE` is tracked as an open 1.0.0 item alongside local note CLI/UI write flows because none of the 7 MCP tools write annotations.

### 4.2 Tools

Input and output schemas below reflect Technical Specification §10.2 (p. 10), §16A.8 (p. 17), and the exact `v0.2.2` schemas in `packages/mcp-server/src/services-wiki.ts`. Each output schema describes the `envelope.data` payload.

#### 4.2.1 `causoryn_wiki_build`

- **Purpose**: Projects the published `GraphSnapshot` for the authorized workspace into a `WikiSnapshot` and publishes it atomically (§16A.8).
- **Permission**: ✍️ **WRITES (`readOnlyHint: false`) — strictly to Causoryn's authorized data-root SQLite** (`config.wiki.dataDbPath` or `--auto-data-dir`; returns `PATH_DENIED` if unconfigured). **Never writes to workspace source files** (§5.2).

```ts
export const WikiBuildInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  mode: z.enum(["full", "incremental"]),      // K-013 #2
  scope: z.string().min(1).optional(),        // explicitly rejected with INVALID_ARGUMENT in v0.2.2 (ADR-010)
  revision: z.string().min(1).optional(),     // defaults to graph.meta.revision.id
});

export const WikiBuildDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  graphSnapshotId: z.string(),
  revisionRef: z.string(),
  status: z.enum(["ready", "partial"]),
  mode: z.enum(["full", "incremental"]),      // actual executed mode
  fallbackReason: z.string().optional(),      // populated when incremental gracefully falls back to full
  pagesRegenerated: z.number().int().nonnegative(),
  sectionsRegenerated: z.number().int().nonnegative(),
  linksRegenerated: z.number().int().nonnegative(),
  brokenLinks: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});
```

- **Error codes**: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY` (no published `ready`/`partial` `GraphSnapshot`), `PATH_DENIED` (`wiki.dataDbPath` unconfigured — default deny), `INVALID_ARGUMENT` (when `scope` is passed), `INTERNAL_ERROR`.
- **Behavior**: Only `ready`/`partial` `GraphSnapshot`s enter projection; pages, sections, links, page versions, and `wiki_fts` are written into a `building` row and flipped atomically in one SQLite transaction via `publishWiki` (or marked `failed` via `failWikiBuild` on error). Re-running against the same `graphSnapshotId` is an idempotent no-op. `mode="incremental"` regenerates only affected `pageId`s (preserving unchanged `contentHash` values) and falls back gracefully to `mode="full"` + `fallbackReason` when prior snapshot/graph state is unavailable.

#### 4.2.2 `causoryn_wiki_get_tree`

- **Purpose**: Hierarchy and deterministic page ordering (§16A.8); 12-category navigation tree (§10.2).
- **Permission**: 🔒 **READ-ONLY (`readOnlyHint: true`).**

```ts
export const WikiGetTreeInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  snapshotId: z.string().min(1).optional(),         // defaults to latest published WikiSnapshot
  parentId: z.string().min(1).optional(),           // subtree root
  depth: z.number().int().min(1).max(8).optional(), // subtree depth cap
  limit: z.number().int().min(1).optional(),        // K-013 #5: default 50, max 200
  cursor: z.string().min(1).optional(),
});

export const WikiTreeNodeSchema = z.strictObject({
  pageId: z.string(),
  kind: WikiPageKindSchema,
  parentId: z.string().nullable(),
  title: z.string(),
  route: z.string(),
  coverage: z.strictObject({ status: CoverageStatusSchema }), // no_data categories listed without filler (§16A.1)
  freshness: FreshnessSchema,
  childCount: z.number().int().nonnegative(),
  depth: z.number().int().positive(),
});

export const WikiGetTreeDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  graphSnapshotId: z.string(),
  stale: z.boolean(),
  nodes: z.array(WikiTreeNodeSchema),
  totalNodes: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
```

- **Error codes**: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND` (unknown `parentId`), `EVIDENCE_NOT_FOUND` (unknown explicit `snapshotId`), `INVALID_ARGUMENT` (malformed cursor), `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

#### 4.2.3 `causoryn_wiki_get_page`

- **Purpose**: Page sections, provenance, coverage, and source refs (§16A.8); generated blocks, evidence, and freshness (§10.2).
- **Permission**: 🔒 **READ-ONLY (`readOnlyHint: true`).**

```ts
export const WikiGetPageInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  pageId: z.string().min(1),
  snapshotId: z.string().min(1).optional(),
  sections: z.array(z.string().min(1)).optional(), // sectionKey filter
  limit: z.number().int().min(1).optional(),       // section pagination (default 50, max 200)
  cursor: z.string().min(1).optional(),
});

export const WikiGetPageDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  graphSnapshotId: z.string(),
  stale: z.boolean(),
  page: z.strictObject({
    pageId: z.string(),
    kind: WikiPageKindSchema,
    parentId: z.string().nullable(),
    title: z.string(),
    slug: z.string(),
    route: z.string(),
    contentHash: z.string(),
    freshness: FreshnessSchema,
    coverage: z.strictObject({
      status: CoverageStatusSchema,
      detail: z.string().optional(),
    }),
  }),
  sourceRefs: z.array(EvidenceRefSchema),       // deduplicated provenance across all sections of the page
  sections: z.array(WikiPageSectionSchema),     // generated layer (ADR-012)
  sectionsTotal: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
```

- **Overlay note**: `WikiAnnotation` records are not returned on this MCP surface (§16A.6: separate local UI/CLI flow).
- **Error codes**: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `EVIDENCE_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

#### 4.2.4 `causoryn_wiki_search`

- **Purpose**: FTS5 and symbol/route matching with pagination (§16A.8, §10.2).
- **Permission**: 🔒 **READ-ONLY (`readOnlyHint: true`).** Secret/ignored files never enter the Wiki index or snippets (§19).

```ts
export const WikiSearchInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  query: z.string(),                              // normalized and FTS phrase-escaped (§16A.3)
  snapshotId: z.string().min(1).optional(),
  limit: z.number().int().min(1).optional(),      // K-013 #5: default 50, max 200
  cursor: z.string().min(1).optional(),
  // Declared per §16A.3 but explicitly rejected with INVALID_ARGUMENT in v0.2.2 (ADR-010):
  kinds: z.array(WikiPageKindSchema).optional(),
  scope: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  revision: z.string().min(1).optional(),
  resolution: z.enum(["verified", "heuristic", "unresolved"]).optional(),
});

export const WikiSearchHitSchema = z.strictObject({
  pageId: z.string(),
  kind: WikiPageKindSchema,
  title: z.string(),
  route: z.string(),
  freshness: FreshnessSchema,
  qualifiedSymbol: z.string().nullable(),
  apiRoute: z.string().nullable(),
  module: z.string().nullable(),
  snippet: z.string(),
  matchedFields: z.array(z.enum(["title", "qualifiedSymbol", "apiRoute", "module", "tags", "body"])),
  evidenceIds: z.array(z.string()),
});
```

- **Ranking guarantee**: Exact symbol/route matches (such as `CreateOrder`) always rank **above** generic FTS body matches (§16A.10 acceptance gate). Because graph `proximity` is not populated on the v0.2.2 MCP surface, it is honestly listed in `skippedRankLegs`.
- **Token budget**: Returns compact snippets and metadata; full section bodies are fetched on demand via `causoryn_wiki_get_page` (§16A.3).
- **Error codes**: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `EVIDENCE_NOT_FOUND` (unknown `snapshotId`), `INVALID_ARGUMENT` (empty query, malformed cursor, or unimplemented extra filter fields), `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

#### 4.2.5 `causoryn_wiki_get_links`

- **Purpose**: Outgoing links, reverse-index backlinks, and evidence (§16A.8, §10.2).
- **Permission**: 🔒 **READ-ONLY (`readOnlyHint: true`).**

```ts
export const WikiGetLinksInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  pageId: z.string().min(1),
  direction: z.enum(["incoming", "outgoing", "both"]).default("both"),
  linkKinds: z.array(WikiLinkKindSchema).optional(),
  snapshotId: z.string().min(1).optional(),
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

export const WikiGetLinksDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  graphSnapshotId: z.string(),
  stale: z.boolean(),
  pageId: z.string(),
  direction: z.enum(["incoming", "outgoing", "both"]),
  outgoing: z.array(WikiLinkSchema),
  incoming: z.array(WikiLinkSchema),  // derived in O(1) from the reverse index (§16A.2, ADR-013)
  brokenLinkDiagnostics: z.array(BrokenLinkDiagnosticSchema), // K-013 #4: toPageId=null rows
  totalMatching: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
```

- **Error codes**: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `EVIDENCE_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR` (broken links are returned in `brokenLinkDiagnostics`, not thrown — K-013 #4).

#### 4.2.6 `causoryn_wiki_get_versions`

- **Purpose**: Accessible Git and snapshot revisions (§16A.8); commit and `working-tree` Wiki versions (§10.2).
- **Permission**: 🔒 **READ-ONLY (`readOnlyHint: true`).** Git inspection is strictly read-only (`git cat-file -t` with `shell: false`; zero `checkout`/`reset`/`clean`), and `working-tree` resolves directly even when no `.git` directory is present.

```ts
export const WikiGetVersionsInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  pageId: z.string().min(1).optional(),                 // page version history if set; snapshot revisions otherwise
  refs: z.array(z.string().min(1)).min(1).max(200).optional(), // commit SHA / branch / tag / working-tree
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

export const WikiVersionEntrySchema = z.strictObject({
  pageId: z.string().nullable(),
  revisionRef: z.string(),
  wikiSnapshotId: z.string().nullable(),
  builtAt: z.string().nullable(),
  availability: z.enum(["available", "not_available"]),
  notAvailableReason: z.string().optional(),
  contentHash: z.string().optional(),
  linkSetHash: z.string().optional(),
  templateVersion: z.string().optional(),
  coverage: z.strictObject({ status: CoverageStatusSchema }).optional(),
});
```

- **Error codes**: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND` (`pageId` absent in the snapshot), `INVALID_REVISION` (malformed or unresolvable Git ref — K-013 #6), `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

#### 4.2.7 `causoryn_wiki_diff`

- **Purpose**: Page, section, link, coverage, and contract differences across Wiki snapshots/revisions (§16A.8, §10.2).
- **Permission**: 🔒 **READ-ONLY (`readOnlyHint: true`).** Diffs read isolated `WikiSnapshot` records without touching the working tree (§16A.10).

```ts
export const WikiDiffInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  base: z.string().min(1),               // wikiSnapshotId or latest published revisionRef — required
  target: z.string().min(1),             // wikiSnapshotId or latest published revisionRef — required
  pageId: z.string().min(1).optional(),  // optional single-page scope filter
});

export const WikiDiffDataSchema = z.strictObject({
  base: z.string(),
  target: z.string(),
  baseWikiSnapshotId: z.string(),
  targetWikiSnapshotId: z.string(),
  addedPages: z.array(z.string()),
  removedPages: z.array(z.string()),
  changedSections: z.array(z.strictObject({
    pageId: z.string(),
    sectionKey: z.string(),
  })),
  addedLinks: z.array(WikiLinkSchema),
  removedLinks: z.array(WikiLinkSchema),
  contractChanges: z.array(z.strictObject({ // K-013 #7 (finalized in Sprint 5 D7)
    contractId: z.string(),
    changeKind: z.enum(["added", "removed", "modified"]),
    summary: z.string(),
  })),
  coverageDelta: z.array(z.strictObject({   // K-013 #3
    pageId: z.string(),
    previous: CoverageStatusSchema,
    current: CoverageStatusSchema,
    reason: z.string().optional(),
  })),
  unresolvedDifferences: z.array(z.strictObject({ pageId: z.string(), reason: z.string() })),
});
```

- **Partial uncertainty**: When either base or target `WikiSnapshot` is `partial`, `envelope.status` is `"partial"`; if either backing `GraphSnapshot` is no longer present in the graph repository, `contractChanges` returns `[]` with an explicit warning (§16A.5, K-013 #7).
- **Error codes**: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND` (`pageId` absent from both snapshots), `INVALID_REVISION` (`base` or `target` could not be resolved), `INVALID_ARGUMENT`, `INTERNAL_ERROR`.

### 4.3 Optional MCP Resources

Optional resource URI template: `causoryn://wiki/{workspaceId}/{pageId}?snapshot={wikiSnapshotId}` (§16A.8). In `v0.2.2`, MCP `resources` are not published; the portable baseline contract is the 7 MCP tools above. Interactive UI extensions (such as MCP Apps) are deferred until cross-host support is verified and are never advertised prematurely (ADR-010).

## 5. Write Permissions: Data-Root Rule and Permission Matrix

### 5.1 `wiki_build` Writes Strictly to the Authorized Data-Root

- `wiki_build` requires explicit workspace authorization and **can never write to source files** (§16A.8, ADR-008).
- The SQLite data-root is provisioned in one of two ways:
  1. **Explicit configuration (`wiki.dataDbPath`):** Validated fail-closed at startup by `validateDataDbPath` (`packages/mcp-server/src/context.ts:230-357`) — must be an absolute path with no null bytes, an existing parent directory, non-symlink/verified SQLite `-wal`/`-shm`/`-journal` sidecars (CWE-59), and a `realpathSync` location strictly outside every `allowRoots` entry.
  2. **Zero-config CLI / Plugin mode (`--auto-data-dir`, K-021):** `buildWorkspaceAutoConfig` (`packages/mcp-server/src/runtime-cli.ts:871-996`) resolves the base data directory (`--data-dir` > `ZCODE_PLUGIN_DATA` > `~/.causoryn`) and provisions `~/.causoryn/workspaces/<slug>-<hash12>/graph[-<client>].sqlite` for both `storage.dataDbPath` and `wiki.dataDbPath` (with `0o700` permissions, pre-create ancestor symlink checks, and post-create `realpathSync` TOCTOU verification).
- `LLM_* / API_KEY / MODEL_PROVIDER` configuration keys are forbidden (Red Line 1).
- Offline Wiki export (`exportWikiOffline`, `packages/wiki/src/export.ts`) is completely separate from `wiki.dataDbPath` and writes atomically (`.tmp` + `rename`) **only** to directories authorized by `OutputAccessPolicy` (`output.allowedOutputDirs`), emitting self-contained HTML with a strict CSP (`default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`), URL defanging, no `file://` links, and zero remote CDN/telemetry assets (§16A.9).

### 5.2 Write-Permission Matrix

| Tool / Flow | Write Permission | Permitted Write Target | Reference |
|---|---|---|---|
| `causoryn_wiki_build` | ✅ YES (`readOnlyHint: false`) | Authorized Causoryn SQLite data-root only (`wiki.dataDbPath` or `--auto-data-dir`) | §16A.8, §19, K-021 |
| `causoryn_wiki_get_tree` | ❌ NO (`readOnlyHint: true`) | — (read-only) | §16A.8 |
| `causoryn_wiki_get_page` | ❌ NO (`readOnlyHint: true`) | — (read-only) | §16A.8 |
| `causoryn_wiki_search` | ❌ NO (`readOnlyHint: true`) | — (read-only) | §16A.8 |
| `causoryn_wiki_get_links` | ❌ NO (`readOnlyHint: true`) | — (read-only) | §16A.8 |
| `causoryn_wiki_get_versions` | ❌ NO (`readOnlyHint: true`) | — (read-only; Git read-only + `.git`-less `working-tree`) | §16A.8, Red Line 3 |
| `causoryn_wiki_diff` | ❌ NO (`readOnlyHint: true`) | — (read-only; working tree untouched) | §16A.8, §16A.10 |
| `causoryn_refresh_index` | ✅ (index, `readOnlyHint: false`) | Causoryn graph index only (`InMemoryGraphRepository` / `storage.dataDbPath`); Wiki rebuilds are invoked explicitly via `causoryn_wiki_build` in v0.2.2 | §10.2, ADR-010 |
| `causoryn_export_documentation` | ✅ (export, `readOnlyHint: false`) | Explicitly authorized `output.allowedOutputDirs` only (architecture views are available, `view="wiki"` explicitly returns `INVALID_ARGUMENT`) | §10.2, §16A.9, ADR-010 |
| Wiki note create/update | ✅ (consented local flow) | **No MCP tool**; core `AnnotationOverlayEngine` implemented, local UI/CLI surface tracked for 1.0.0 | §16A.6, §10.2, K-014 |

Summary: **Out of the 7 Wiki MCP tools, only `causoryn_wiki_build` writes**, and strictly to the external SQLite data-root; the remaining 6 tools are purely read-only.

## 6. Reuse Principle: `refresh_index` and `export_documentation`

Technical Specification §10.2 + §16A.8 catalog design principle (and honest `v0.2.2` implementation status):

1. **Separate `wiki_refresh` and `wiki_export` MCP tools are NEVER created** — keeping the published catalog locked at 22 + 7 = 29 tools.
2. **Specification target vs. `v0.2.2` surface (ADR-010):**
   - Technical Specification §20 envisions automatic Wiki refresh after `causoryn_refresh_index` (`wiki.autoBuildOnSnapshot: true`) and offline Wiki export through `causoryn_export_documentation(view="wiki")`.
   - The core includes `projectWikiIncremental` and `exportWikiOffline`. On the MCP surface, invoke `causoryn_wiki_build` to project the Wiki. v0.2.2 supports the `architecture`, HTML-only `interactive`, and `full` views for architecture exports. `view="wiki"` explicitly returns `INVALID_ARGUMENT`. [Tool contracts](tool-contracts.md)
3. **Incremental pipeline (`packages/wiki/src/incremental.ts`, §16A.5):** `diffWikiGraphs` computes affected root and child `pageId`s between consecutive `GraphSnapshot`s → unaffected pages preserve their exact `contentHash` and section payloads → the new `WikiSnapshot` and `wiki_fts` publish atomically in a single SQLite transaction → until publication completes, concurrent readers continue serving the previous `WikiSnapshot` with `stale: true`.
4. Manual annotation editing remains isolated from MCP read tools in user-consented local CLI/UI flows (§10.2, §16A.6).

Target configuration model (§20; in `v0.2.2`, the active runtime server config key is `wiki.dataDbPath` — see [CLI & Configuration](cli-and-configuration.md)):

```yaml
wiki:
  dataDbPath: "/abs/path/outside-workspace/graph.sqlite" # or auto-provisioned via --auto-data-dir
  # Technical Specification §20 target 1.0.0 extensions:
  enabled: true
  autoBuildOnSnapshot: true
  includeManualNotesInSearch: false
  includeManualNotesInExport: false
  historicalSnapshotRetention: "metadata_and_derivatives" # raw source is never stored
  offlineExportDefault: true
```

Observability metrics (§21 target): `wiki_projection_duration, wiki_pages_regenerated, wiki_fts_update_duration, wiki_broken_links, wiki_stale_queries, wiki_orphaned_notes` (`pagesRegenerated` and `brokenLinks` are already returned directly in `causoryn_wiki_build` responses).

## 7. Test and Acceptance Criteria (Technical Specification §16A.10)

| Test Area | Acceptance Criterion |
|---|---|
| Hierarchy | Navigation from TS Orders fixture across Overview → APIs → POST /orders → Service, with explicit `no_data`/`partial` states |
| Bidirectional links | Every `from -> to` link is discoverable via target backlink queries in the same snapshot, with `EvidenceRef`s on `verified` links |
| Search ranking | Exact symbol match (e.g., `CreateOrder`) ranks strictly above generic FTS body matches |
| Versioning | Diffs across two fixture Git commits report accurate added/removed/changed pages and links while **leaving the user working tree untouched** |
| Incremental build | Modifying a single service regenerates only affected pages while independent page `contentHash` values remain identical |
| Manual annotations | Two consecutive rebuilds leave manual notes byte-for-byte intact; renames mark notes `orphan` with **zero data loss** |
| Uncertainty honesty | Unresolved dynamic imports report `partial`/`unresolved` and never impersonate `verified` links |
| Security | Offline HTML enforces XSS escaping + strict CSP + URL defanging; broken-link diagnostics preserved; secret exclusion applied to all snippets (§22, §19) |

Every Wiki tool adheres to the positive + negative + partial test triad (§23 Definition of Done; see [Implementation Status](implementation-status.md)).

## 8. Resolved Design Decisions (K-013) & Open 1.0.0 Items

> **RESOLVED (2026-11-05, K-013 + Sprint 5 D7):** All 7 pre-implementation design questions originally tracked in §8 were resolved under **K-013** and codified across `packages/wiki`, `packages/storage-sqlite`, and `packages/mcp-server`:

1. **`WikiSnapshot.status` value set (K-013 #1):** `building | ready | partial | failed` — identical to §8 `GraphSnapshot.state`; there is no separate `"error"` status string, and failures surface via `warnings` + fixed tool error codes.
2. **`wiki_build mode` enum values (K-013 #2):** `full | incremental`; internal engine `full-rebuild` fallbacks map cleanly to `mode: "full"` + `fallbackReason` on the MCP surface.
3. **`freshness`, `CoverageStatus`, `section status`, and `coverageDelta` shape (K-013 #3):** `freshness = fresh | stale`, `CoverageStatus = complete | partial | unsupported | no_data` (`no_data` is never padded with synthetic prose), section status `ok | partial | no_data`, and `coverageDelta` item shape `{ pageId, previous, current, reason? }`.
4. **Broken-link target storage representation (K-013 #4):** `WikiLink` rows are retained with `toPageId: null` (never silently deleted and never placed into backlink buckets) **and** paired with `brokenLinkDiagnostics` entries.
5. **Cursor format and pagination limits (K-013 #5):** Reuses the shared opaque `base64url` `{ "v": 1, "o": <int> }` cursor codec; default `limit = 50`, hard cap `200`, `nextCursor = null` on the final page.
6. **`wiki_get_versions` branch/tag alias resolution (K-013 #6):** Resolved via read-only `git cat-file -t` (with `working-tree` resolved directly without requiring `.git`); unresolvable refs return `INVALID_REVISION`, whereas valid refs without a stored `WikiSnapshot` return `availability: "not_available"`.
7. **`contractChanges` diff payload (K-013 #7, finalized in Sprint 5 D7):** `{ contractId, changeKind: "added" | "removed" | "modified", summary }`, computed across contract node surfaces (`ApiContract`/`EventContract`/`SchemaContract`/`ContractVersion`) of the backing `GraphSnapshot`s.

**Remaining open Wiki items gated for `1.0.0` (synced with `CHANGELOG.md` `[Unreleased]`):**

- Enabling the extra `causoryn_wiki_search` filters (`kinds`, `scope`, `language`, `revision`, `resolution`) and feeding the graph `proximity` rank leg on the MCP surface.
- Registering `WIKI_NOTE_CONFLICT` in MCP `CAUSORYN_TOOL_ERROR_CODES` / `TOOL_ERROR_GUIDANCE` when local note CLI/UI write surfaces ship (K-014).
- Wiring `causoryn_export_documentation(view="wiki")` and `wiki.autoBuildOnSnapshot` on the MCP surface, plus incremental SQLite row-sharing optimization across `WikiSnapshot` publications.

## 9. Related Documentation

- [Documentation Index](README.md) — entry point for all English and Turkish documentation
- [MCP Tool Contracts](tool-contracts.md) — all 29 published tools, 10-field envelope, 15 error codes, and write-permission matrix
- [Architecture Overview](architecture.md) — package map, SQLite `wiki_*` schema family, and dependency boundaries
- [CLI & Configuration](cli-and-configuration.md) — `wiki.dataDbPath`, `--auto-data-dir`, and workspace authorization
- [Implementation Status](implementation-status.md) — Phase C2 (Sprint 4 W1–W8) and Phase D (D7) verification evidence
- [Türkçe Spesifikasyon](../wiki-spec.md) — Turkish counterpart of this specification
- Historical/primary source references: `raw/Causoryn_Teknik_Dokuman_v2.1.pdf` §16A (pp. 14–18) · `wiki/mcp-tools.md` · `wiki/scope.md` · `wiki/sprint-4.md` · `wiki/decisions.md` (ADR-004/005/008/010/011/012/013, K-013, K-014, K-021, K-022)
