# Living Wiki Engine — Design & Implementation Specification

> **Language:** [Türkçe](../wiki-spec.md) | **English** · [Documentation Hub](README.md)
>
> **Status:** reflects Causoryn 0.3.2 (default `core` tool profile; the Living Wiki tools are opt-in, see [§2](#2-enabling-the-wiki-tools-and-storage) and [CLI & Configuration](cli-and-configuration.md)).
>
> **Source modules:** `packages/wiki/src/*` (pure projection, links, search, overlay, export cores) · `packages/storage-sqlite/src/{wiki-schema.ts,wiki-store.ts}` (SQLite persistence) · `packages/mcp-server/src/services-wiki.ts` (MCP services) · `packages/mcp-server/src/server.ts` + `schemas.ts` (tool registration and input schemas) · `packages/mcp-server/src/version.ts` (`WIKI_TOOL_NAMES`, tool profiles).

> [!IMPORTANT]
> **The wiki tools are not in the default tool surface.** The default `core` profile lists 11 tools and none of the 7 `causoryn_wiki_*` tools. Start the server with **`--tool-profile wiki`** (or `--tool-profile wiki,history`, or `--tool-profile full`), or set the environment variable **`CAUSORYN_TOOL_PROFILE=wiki`**. The CLI flag wins over the environment variable; unknown profile names are rejected at startup. The wiki also needs a SQLite data root (`--auto-data-dir`, `--data-dir <path>`, or `wiki.dataDbPath`); without one, `causoryn_wiki_build` returns `PATH_DENIED` and the read tools return `INDEX_NOT_READY`.

> **Implementation summary (honest status):**
> - **Implemented:** the pure `@causoryn/wiki` engine (`projectWiki`, `projectWikiIncremental`, `diffWikiGraphs`, `resolveWikiLinks`, `buildWikiLinkIndex`, `WikiSearchStore`, `computeWikiCoverageDeltas`, `computeWikiContractChanges`, `AnnotationOverlayEngine`, `exportWikiOffline`); the `SqliteWikiStore` with the `wiki_*` table family and the `wiki_fts` FTS5 table; and all 7 MCP wiki tools under the `wiki` / `full` profiles.
> - **Partial:** `causoryn_wiki_build` emits only three of the eleven link kinds (`PARENT_OF`, `DEPENDS_ON`, `CALLS`); the page kinds `component`, `symbol` and `policy` are declared but never generated; `mode: "incremental"` preserves unchanged page content but still writes a complete row set for every new `WikiSnapshot`; `causoryn_wiki_get_versions` and the revision form of `causoryn_wiki_diff` only see the latest published `WikiSnapshot`.
> - **Not implemented:** the extra `causoryn_wiki_search` filters (`kinds`, `scope`, `language`, `revision`, `resolution`; declared and explicitly rejected with `INVALID_ARGUMENT`) and the graph-proximity rank leg; any MCP or CLI surface for annotations (the overlay engine is library-only, so `WIKI_NOTE_CONFLICT` is not an MCP error code); offline wiki export from MCP or the CLI (`causoryn_export_documentation(view="wiki")` returns `INVALID_ARGUMENT`); automatic wiki rebuild after re-indexing; wiki snapshot retention. Details in [§11](#11-limits-and-honest-gaps).

## Contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [Enabling the wiki tools and storage](#2-enabling-the-wiki-tools-and-storage)
3. [Page taxonomy and page kinds](#3-page-taxonomy-and-page-kinds)
4. [Identifiers, hashes and determinism](#4-identifiers-hashes-and-determinism)
5. [Data model (Zod schemas)](#5-data-model-zod-schemas)
6. [Projection, links and incremental invalidation](#6-projection-links-and-incremental-invalidation)
7. [Storage schema (`wiki_*`, `wiki_fts`)](#7-storage-schema-wiki_-wiki_fts)
8. [MCP tool contracts — 7 wiki tools](#8-mcp-tool-contracts--7-wiki-tools)
9. [Write permissions and security boundaries](#9-write-permissions-and-security-boundaries)
10. [Tests and acceptance criteria](#10-tests-and-acceptance-criteria)
11. [Limits and honest gaps](#11-limits-and-honest-gaps)
12. [Related documentation](#12-related-documentation)

## 1. Purpose and Scope

The Living Wiki Engine turns Causoryn's evidence graph into a navigable, versioned, searchable project wiki stored in SQLite with an FTS5 index. It is **not** a second code analyzer: every generated section is derived from a published, immutable `GraphSnapshot` (nodes, edges, evidence spans, contract nodes). The wiki reads no source files itself, so anything excluded from indexing never reaches it.

- **Living Wiki (`causoryn_wiki_*`):** a persistent, revisioned knowledge base with 12 root categories. `causoryn_wiki_build` projects and publishes a `WikiSnapshot`; the six read tools (`causoryn_wiki_get_tree`, `causoryn_wiki_get_page`, `causoryn_wiki_search`, `causoryn_wiki_get_links`, `causoryn_wiki_get_versions`, `causoryn_wiki_diff`) navigate it page by page, follow links and backlinks, run FTS5 search, and diff snapshots.
- **Visual Architecture Portals (`causoryn_export_documentation`, core profile):** standalone offline artifacts (`causoryn-architecture-interactive.html`, zero-JS `causoryn-architecture.html`, Mermaid `.mmd`, Architecture Brief `.md`, JSON blueprint) written on demand into `output.allowedOutputDirs`. This tool does not export the Living Wiki (`view: "wiki"` is rejected). See [Prompting & Architecture Portals Guide](prompting-and-architecture-portals.md).
- **Generated layer vs. overlay layer:** generated sections are rebuilt freely and never edited by hand. Human notes and user-accepted host-model proposals belong to a separate `wiki_annotations` overlay table that rebuilds never touch (see [§5.6](#56-wikiannotation--overlay-layer)).
- **Source of truth:** authorized source code → `GraphSnapshot` → `WikiSnapshot`. Annotations and host-model text never replace or upgrade graph evidence.
- **No model calls:** the wiki engine calls no LLM or embedding service; search ranking is FTS5 BM25 plus deterministic rules ([no-LLM policy](adr/ADR-002-no-llm.md)).
- **Determinism:** the same graph snapshot and template version produce the same `WikiSnapshot` ID, page IDs, section IDs, link IDs and content hashes. `builtAt` is an input to the pure projection; the MCP server takes it from its runtime clock, so timestamps differ between builds while identities do not.

## 2. Enabling the Wiki Tools and Storage

### 2.1 Tool profiles

Tool profiles are defined in `packages/mcp-server/src/version.ts` (`TOOL_PROFILES`, `WIKI_TOOL_NAMES`) and resolved in `server.ts` (`resolveProfileToolNames`) and `runtime-cli.ts` (`parseToolProfile`, `resolveEffectiveToolProfile`).

| Profile | Tools listed | Wiki tools |
|---|---|---|
| `core` (default) | 11 | none |
| `wiki` | 18 (11 core + 7 wiki) | all 7 |
| `wiki,history` | 20 (11 core + 7 wiki + 2 history) | all 7 |
| `full` | 32 (29 legacy names + `causoryn_status`, `causoryn_trace`, `causoryn_contracts`) | all 7 |

Selection order: `--tool-profile <list>` > `CAUSORYN_TOOL_PROFILE` > `CAUSORYN_CONFIG.toolProfile` > `core`. Profiles combine with commas. In `full`, superseded legacy tools carry a deprecation note; the wiki tools are not deprecated and behave identically in `wiki` and `full`.

### 2.2 Data root

`causoryn_wiki_build` writes, and the read tools read, a SQLite database outside every authorized workspace root:

1. **Zero-config (`--auto-data-dir` or `--data-dir <path>`):** `buildWorkspaceAutoConfig` (`runtime-cli.ts`) resolves the base directory (`--data-dir` > `~/.causoryn` for every host; `ZCODE_PLUGIN_DATA` only as a fallback when `~/.causoryn` is unusable) and sets both `storage.dataDbPath` and `wiki.dataDbPath` to the same file, `<base>/workspaces/<slug>-<hash12>/graph.sqlite`. All hosts share this one database, so a wiki built from one host is visible to every host that uses the same data directory. Directories are created with mode `0700` and checked to be strictly outside the authorized roots before and after creation.
2. **Explicit configuration:** set `wiki.dataDbPath` in `CAUSORYN_CONFIG` to an absolute path outside the workspace. It is validated at startup by `validateDataDbPath` (`context.ts`); see [§9](#9-write-permissions-and-security-boundaries).

The `wiki` configuration object accepts only `dataDbPath` (`config.ts`, strict schema); other keys are rejected at startup.

Example (zero-config, wiki tools enabled):

```bash
causoryn mcp --allow-cwd --auto-data-dir --tool-profile wiki
# or
CAUSORYN_TOOL_PROFILE=wiki causoryn mcp --allow-cwd --auto-data-dir
```

Typical call order: wait for the graph index (`causoryn_status`), call `causoryn_wiki_build` with `mode: "full"`, then use the read tools. The wiki is never rebuilt automatically; call `causoryn_wiki_build` again after a re-index (read tools report `stale: true` until you do).

## 3. Page Taxonomy and Page Kinds

### 3.1 Default page tree

Every workspace wiki has 12 root category pages in fixed taxonomy order (`packages/wiki/src/taxonomy.ts`, `WIKI_ROOT_CATEGORIES`). The category `key` feeds page-ID derivation; the route is `/wiki/<slug>` (slug = key).

```text
Workspace Wiki                 key / root kind
├── Overview                   overview / overview              # repository, languages, scope, unknowns
├── Architecture               architecture / architecture      # L0–L4 layer, module, component counts
├── Projects & Modules         projects-modules / project       # modules with components and dependencies
├── APIs & Entry Points        apis-entry-points / api          # endpoints, handlers, route links
├── Business Flows             business-flows / business_flow   # end-to-end flows (always no_data today)
├── Events & Integrations      events-integrations / event      # producers/consumers, async contracts
├── Data & Schemas             data-schemas / data              # databases, tables, columns, readers/writers
├── Contracts & Policies       contracts-policies / contract    # API/event/schema contracts
├── Tests & Quality            tests-quality / test             # test nodes, TESTS edges, coverage gaps
├── Architecture Timeline      architecture-timeline / timeline # commit history (always no_data today)
├── Onboarding                 onboarding / onboarding          # learning paths (always no_data today)
└── Unresolved & Coverage      unresolved-coverage / coverage   # unresolved edges, UnknownExternal nodes
```

### 3.2 Page kinds and graph sources

The page-kind enum (`WikiPageKindSchema`) has 16 values: `overview | architecture | project | module | component | symbol | api | business_flow | event | data | contract | policy | test | timeline | onboarding | coverage`. The table shows what the current projection (`packages/wiki/src/projection.ts`) actually generates.

| `kind` | Generated as | Graph source | Section keys |
|---|---|---|---|
| `overview` | root page | `Workspace` / `Repository` / `Project` nodes; node/edge/evidence counts; per-language node counts | `summary`, `languages` |
| `architecture` | root page | Node counts per layer: L0 `Repository`/`Workspace`, L1 `Project`/`Module`/`Package`, L2 `Class`/`Interface`/`Type`, L3 `Method`/`Function`/`Endpoint`/`Handler`, L4 contract nodes | `layers` |
| `project` | root page (Projects & Modules) | `Module` nodes with locations | `modules` |
| `module` | child page per `Module` node | `CONTAINS` (outgoing) and `DEPENDS_ON` (both directions) edges | `components`, `dependencies` |
| `api` | root page + child page per `Endpoint` node | root: endpoint list; child: route, language, location, `ROUTES_TO` / `HANDLES` edges | root `endpoints`; child `route`, `handler` |
| `event` | root page + child page per `Event` / `Topic` / `Queue` node | `PUBLISHES` (outgoing), `SUBSCRIBES` (incoming) | root `events`; child `publishers`, `subscribers` |
| `data` | root page + child page per `Table` node | root: `Database` / `Table` / `Column` counts; child: incoming `READS` / `WRITES` | root `schemas`; child `readers-writers` |
| `contract` | root page (Contracts & Policies) + child page per contract node | `ApiContract` / `EventContract` / `SchemaContract` / `ContractVersion` nodes and their attributes | root `contracts`; child `definition` |
| `test` | root page | `Test` nodes and `TESTS` edges | `tests`, `coverage-gaps` (always `no_data`) |
| `coverage` | root page | edges with `resolution: "unresolved"` and `UnknownExternal` nodes | `unresolved` |
| `business_flow`, `timeline`, `onboarding` | root page, structurally `no_data` | not carried in `GraphSnapshot` (flow, Git history and onboarding outputs come from other engines) | `flows`, `commits`, `path` |
| `component`, `symbol`, `policy` | **not generated** | declared in the enum and SQL `CHECK` constraint only | — |

There is no `policy` page: the "Contracts & Policies" root has kind `contract`, and guard-policy or baseline-suppression data is not projected into the wiki today.

### 3.3 Generation principles

1. **No page without backing graph nodes.** Child pages exist only for nodes listed in `WIKI_CHILD_PAGE_SOURCES`; empty categories are never padded.
2. **`no_data` stays empty.** A `no_data` section always has `generatedMarkdown: ""` and no evidence. Structural `no_data` roots (Business Flows, Architecture Timeline, Onboarding) carry an explanatory `coverage.detail`.
3. **Coverage roll-up** (`materializeWikiPage`): all sections `no_data` → page `no_data`; all `ok` → `complete`; otherwise `partial`. A section is `partial` when at least one contributing edge is `unresolved`.
4. **Unsupported kinds.** The pure engine accepts `supportedPageKinds`; categories outside that set become `unsupported` with a warning and no child pages. The MCP build does not pass this option, so every kind is treated as supported.
5. **Stable identity.** `pageId` derives from canonical graph identity + page kind, never from the display title or slug (see [§4](#4-identifiers-hashes-and-determinism)).
6. **Routes and slugs.** Child routes are `/wiki/<categorySlug>/<slug>`, where the slug is the node's qualified name reduced to `[a-z0-9-]`. Slug collisions inside a category get a deterministic suffix taken from the node ID.
7. **Every page exposes** `kind`, `pageId`, `parentId`, `title`, `route`, `coverage`, `freshness`, `contentHash`, and its `wikiSnapshotId` / `graphSnapshotId` through the read tools.

## 4. Identifiers, Hashes and Determinism

All hashes are SHA-256 over canonical JSON (sorted keys, no whitespace) from `@causoryn/domain`.

| Identifier | Derivation (code) |
|---|---|
| `wikiSnapshotId` | `wiki:` + sha256(`[graphSnapshotId, WIKI_TEMPLATE_VERSION]`) — `deriveWikiSnapshotId`; `WIKI_TEMPLATE_VERSION = "1.1.0"` |
| Root `pageId` | `page:` + sha256(`[workspaceId, "root", categoryKey, categoryKind]`) — `wikiRootPageIdFor` |
| Child `pageId` | `page:` + sha256(`[workspaceId, "node", pageKind, nodeId]`) — `wikiChildPageId` |
| Section `id` | `section:` + sha256(`[pageId, sectionKey]`) |
| Link `id` | `wikilink:` + sha256(`[kind, fromPageId, toRef]`) — `services-wiki.ts` |
| `contentHash` | sha256 over each section's `{sectionKey, generatedMarkdown, evidenceRefs, status}` in template order (`content-hash.ts`); page ID, title, slug and route are excluded, so renaming a display title does not change it |
| `linkSetHash` | sha256 over the page's outgoing links `{id, kind, toPageId, resolution}` sorted by ID |

- **Two-level versioning:** `GraphSnapshot` → deterministic `WikiSnapshot`. Re-running `causoryn_wiki_build` for a graph snapshot whose wiki is already the latest published one is an idempotent no-op (`pagesRegenerated: 0` plus a warning).
- **Template version:** changing a generated Markdown template requires bumping `WIKI_TEMPLATE_VERSION`, which changes every `wikiSnapshotId` and forces incremental builds to fall back to a full build. The version moved to `1.1.0` when the generated templates were translated to English, so a wiki published with an older template version is rebuilt on the next build.
- **`revisionRef`:** defaults to the graph snapshot's `revision.id`. The indexer records `working-tree` there, so unless `causoryn_wiki_build` is called with an explicit `revision` label, every `WikiSnapshot` has `revisionRef: "working-tree"`. The `revision` input is a free-form label; it is not resolved against Git.
- **Output order:** roots in taxonomy order, child pages by category then `pageId`; all core outputs are deep-frozen.

## 5. Data Model (Zod Schemas)

Runtime schemas live in `packages/wiki/src/{schema.ts,links.ts,overlay.ts,search-schema.ts}` and map to the `wiki_*` tables in `packages/storage-sqlite/src/wiki-schema.ts`. The excerpts below match the code.

### 5.1 Common types

```ts
// Resolution: "verified" means static/checker evidence, not a runtime guarantee.
export const WikiResolutionSchema = z.enum(["verified", "heuristic", "unresolved"]);

// Reference to a graph Evidence record with a source span. Evidence without a
// span is never turned into a fake location.
export const EvidenceRefSchema = z.strictObject({
  evidenceId: z.string(),
  relativePath: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  sourceHash: z.string(),
});
```

### 5.2 WikiSnapshot

```ts
// Same value set as GraphSnapshot.state; there is no separate "error" status.
export const WikiSnapshotStatusSchema = z.enum(["building", "ready", "partial", "failed"]);

export const WikiSnapshotSchema = z.strictObject({
  id: z.string(),               // deriveWikiSnapshotId(graphSnapshotId)
  workspaceId: z.string(),
  graphSnapshotId: z.string(),  // only ready/partial graph snapshots are projectable
  revisionRef: z.string(),      // graph revision.id ("working-tree") or the build's revision label
  status: WikiSnapshotStatusSchema,
  builtAt: z.iso.datetime(),    // injected clock; not part of any ID
  templateVersion: z.string(),  // WIKI_TEMPLATE_VERSION
});
```

The published status mirrors the source graph: a `ready` graph gives a `ready` wiki, a `partial` graph a `partial` wiki. `building` rows are invisible to readers; a build that throws is closed as `failed`.

### 5.3 WikiPage and WikiPageSection

```ts
export const CoverageStatusSchema = z.enum(["complete", "partial", "unsupported", "no_data"]);
export const FreshnessSchema = z.enum(["fresh", "stale"]);
export const WikiPageSectionStatusSchema = z.enum(["ok", "partial", "no_data"]);

export const WikiPageSchema = z.strictObject({
  id: z.string(),                    // pageId (see §4)
  wikiSnapshotId: z.string(),
  kind: WikiPageKindSchema,
  parentId: z.string().nullable(),   // null on the 12 root pages
  title: z.string(),                 // child pages: the node's qualifiedName
  slug: z.string(),
  route: z.string(),
  contentHash: z.string(),           // incremental invalidation key
  freshness: FreshnessSchema,
  coverage: z.strictObject({ status: CoverageStatusSchema, detail: z.string().optional() }),
});

export const WikiPageSectionSchema = z.strictObject({
  id: z.string(),
  pageId: z.string(),
  sectionKey: z.string(),            // fixed template key, versioned by WIKI_TEMPLATE_VERSION
  generatedMarkdown: z.string(),     // source-derived only; never edited by hand
  evidenceRefs: z.array(EvidenceRefSchema),
  status: WikiPageSectionStatusSchema,
});
```

`WikiProjectionSchema` (`{ snapshot, pages, sections, warnings }`) rejects duplicate page or section IDs, sections pointing at unknown pages, and child pages pointing at unknown parents. Page `freshness` is written as `fresh`; staleness is reported per response through the `stale` flag (see [§8.1](#81-shared-behavior)).

### 5.4 WikiLink and broken-link diagnostics

```ts
export const WikiLinkKindSchema = z.enum([
  "PARENT_OF", "DOCUMENTS", "DEPENDS_ON", "CALLS", "IMPLEMENTS", "PRODUCES",
  "CONSUMES", "TESTED_BY", "FLOWS_TO", "RELATED_CONTRACT", "CHANGED_IN",
]);

export const WikiLinkSchema = z.strictObject({
  id: z.string(),
  wikiSnapshotId: z.string(),
  fromPageId: z.string(),
  toPageId: z.string().nullable(),   // unresolved targets are kept with toPageId = null
  kind: WikiLinkKindSchema,
  resolution: WikiResolutionSchema,
  evidenceRefs: z.array(EvidenceRefSchema),
}).superRefine(/* a "verified" link without evidenceRefs is rejected */);

export const BrokenLinkDiagnosticSchema = z.strictObject({
  linkId: z.string(),
  fromPageId: z.string(),
  toRef: z.string().nullable(),      // raw target name; null when derived from stored rows
  kind: WikiLinkKindSchema,
  reason: z.string(),
});
```

Rules (`packages/wiki/src/links.ts`):

- A `verified` link must carry at least one `EvidenceRef`; the schema rejects violations. The build path downgrades a `verified` graph edge without span evidence to `heuristic` and adds a warning instead of producing an invalid link.
- **Backlinks are derived, not stored.** `buildWikiLinkIndex` builds forward and reverse maps from the single stored link row, so backlink lookup is O(1) and no reciprocal rows exist.
- **Broken links are data, not errors.** `resolveWikiLinks` resolves a draft's `toRef` in this order: page ID, slug, alias text, old-page-ID redirect. An unresolved target is kept with `toPageId: null`, excluded from backlink buckets, and reported in `brokenLinkDiagnostics`. A link resolved through an alias with `matchConfidence < 1` is capped from `verified` to `heuristic`.
- Drafts from an unknown source page and duplicate link IDs are rejected.

### 5.5 WikiPageVersion

Stored once per page per snapshot (`wiki_page_versions`, primary key `(wiki_snapshot_sid, page_id)`):

```ts
interface WikiPageVersion {
  pageId: string;
  wikiSnapshotId: string;
  revisionRef: string;
  contentHash: string;
  linkSetHash: string;       // outgoing link-set integrity hash
  templateVersion: string;
  coverage: { status: CoverageStatus };
}
```

History across revisions lives in separate `WikiSnapshot` rows. A queried revision with no stored `WikiSnapshot` is reported as `availability: "not_available"` with `notAvailableReason`; keeping old versions is not a retention guarantee.

### 5.6 WikiAnnotation — overlay layer

`packages/wiki/src/overlay.ts` separates two layers: the generated layer (rebuilt freely) and the overlay layer (human notes, external links, user-accepted host-model proposals).

```ts
export const AnnotationAuthorKindSchema = z.enum(["human", "host_model_proposal"]);
export const AnnotationOriginSchema = z.enum(["human_note", "external_link", "host_model_proposal"]);

export const WikiAnnotationSchema = z.strictObject({
  id: z.string().min(1),
  stablePageId: z.string().min(1),   // deterministic pageId the note is attached to
  sectionKey: z.string().min(1),     // rendered outside generatedMarkdown
  authorKind: AnnotationAuthorKindSchema,
  origin: AnnotationOriginSchema.optional(),
  verified: z.boolean().optional(),
  body: z.string(),                  // must not be blank
  annotationVersion: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
}).superRefine(/* see rules below */);
```

Rules (`AnnotationOverlayEngine`, `SqliteWikiStore`):

- Annotations live in `wiki_annotations`, which has no foreign key to the generated `wiki_*` tables; rebuilding pages never overwrites or deletes them.
- `origin: "host_model_proposal"` cannot have `verified: true`, and `origin: "host_model_proposal"` is allowed only with `authorKind: "host_model_proposal"` (and vice versa). Host proposals render with a distinct label, separate from human notes. Causoryn never calls a model to produce them.
- **Optimistic concurrency:** `addAnnotation` starts at version `0`; `updateAnnotation` performs an atomic compare-and-swap against `expectedAnnotationVersion` and raises `wiki/annotation-conflict` on mismatch (the intended MCP code `WIKI_NOTE_CONFLICT` is not registered, see [§8.2](#82-error-codes)). Each successful write increments the version.
- **Orphans:** `markAnnotationOrphans` derives `orphan: true` when `stablePageId` is absent from the current projection; the row is never deleted or changed. Because page IDs are deterministic, the flag clears automatically when the page returns, with no write.
- **Surface:** there is no MCP tool and no CLI command that reads or writes annotations. `causoryn_wiki_get_page` returns only the generated layer. The overlay is a tested library capability waiting for a consented local UI/CLI flow.

### 5.7 Aliases

`wiki_aliases` (`WikiAliasInput`: `pageId`, `alias`, `source`, `candidateNewPageId?`, `matchConfidence?` in `0..1`) records uncertain renames or relocations. `candidateNewPageId = null` marks an unresolved candidate redirect; ambiguous matches are never promoted to `verified`. `resolveWikiLinks` consumes aliases when given them, but the MCP build path does not write or pass aliases today.

### 5.8 WikiSearchIndex (FTS5)

`wiki_fts` indexes `title`, `qualified_symbol`, `api_route`, `module`, `tags`, `body`, with `page_id` and `wiki_snapshot_sid` as unindexed join keys. What the build writes (`buildFtsDocs`):

| Column | Value |
|---|---|
| `title` | page title |
| `qualified_symbol` | child pages: the node's qualified name (= title); root pages: null |
| `api_route` | `api` child pages: the endpoint's qualified name; otherwise null |
| `module` | `module` child pages: the module's qualified name; otherwise null |
| `tags` | always null |
| `body` | non-empty section Markdown joined; null if empty |

Annotations are never indexed.

## 6. Projection, Links and Incremental Invalidation

### 6.1 Full projection (`projectWiki`)

1. Validate the graph against the domain `SnapshotSchema`; reject non-ISO `builtAt` (`wiki/invalid-input`).
2. Accept only `ready` / `partial` graph snapshots (`wiki/snapshot-not-projectable` otherwise).
3. Build the 12 root pages from fixed section templates, then plan child pages from `WIKI_CHILD_PAGE_SOURCES` (`projects-modules` ← `Module`; `apis-entry-points` ← `Endpoint`; `events-integrations` ← `Event`/`Topic`/`Queue`; `data-schemas` ← `Table`; `contracts-policies` ← contract nodes).
4. Attach span evidence from contributing edges to each section (sorted by `evidenceId`).
5. Produce warnings from one shared generator (unsupported categories, `partial` sections), validate the whole projection against `WikiProjectionSchema`, and deep-freeze it.

### 6.2 Link generation in `causoryn_wiki_build`

`buildLinkDrafts` (`services-wiki.ts`) emits:

- **`PARENT_OF`** from each root page to each of its child pages, with `resolution: "heuristic"` and no evidence (structural taxonomy link).
- **`DEPENDS_ON` and `CALLS`** for graph edges of those kinds whose both endpoints have child pages. The link keeps the edge's resolution and span evidence; a `verified` edge without span evidence is downgraded to `heuristic` with a warning.

Multiple edges of the same kind between the same page pair collapse into one link. The other eight link kinds are declared in the schema and the SQL constraint but not produced. Because `CALLS` edges usually connect functions or methods, which do not have pages, `CALLS` links appear only when a `CALLS` edge connects two page-backed nodes. All drafts target pages from the same projection, so `brokenLinks` is normally `0`; the broken-link model is exercised by the core tests.

### 6.3 Incremental invalidation (`projectWikiIncremental`)

`mode: "incremental"` uses the previous published `WikiSnapshot` and its source graph snapshot:

1. `diffWikiGraphs` computes changed / added / removed node, edge and evidence IDs plus `configChanged`, `analyzerChanged`, `revisionChanged`, `stateChanged`.
2. **Fallback to full build** (reported as `mode: "full"` + `fallbackReason`, never silently) when: no published `WikiSnapshot` exists; the previous wiki's graph snapshot can no longer be read; the parser configuration or analyzer fingerprint changed; the template version changed; the supported-kind set changed; the previous projection fails integrity checks (missing sections, content hash mismatch, workspace or graph ID mismatch, a page to preserve is missing).
3. **Page selection:** any content change selects every graph-global root page (all roots except the three structural `no_data` roots). Changed, added or removed nodes, plus both endpoints of changed, added or removed edges, select their child pages.
4. **Content-hash guard:** selected pages are regenerated; if the new `contentHash` equals the old one the page counts as preserved. Unselected pages are carried over unchanged.
5. The result is canonically identical to a full build of the same graph (same templates, planner and warning generator).

`pagesRegenerated` counts pages whose content hash changed; `sectionsRegenerated` counts their sections. The write still stores a full row set (pages, sections, links, versions, FTS documents) for the new `WikiSnapshot`; narrowing these row rewrites is open work.

### 6.4 Diff computations

- `changedSections`: sections of pages present on both sides whose Markdown, status or evidence differ, plus section keys present on only one side.
- `addedLinks` / `removedLinks`: link-ID set difference.
- `coverageDelta` (`computeWikiCoverageDeltas`): pages whose `coverage.status` changed (with section-count reason), new pages (`previous: "no_data"`), and removed pages (`current: "no_data"`).
- `unresolvedDifferences`: common pages whose number of `partial` sections changed.
- `contractChanges` (`computeWikiContractChanges`): compares contract nodes of the two backing graph snapshots by `"<nodeKind> <qualifiedName>"`. `added` and `modified` records carry the target node ID, `removed` the base node ID; `modified` means the hash of kind, qualified name, language, location and attributes changed, and the summary includes both 12-character hash prefixes. If either backing graph snapshot is no longer stored, `contractChanges` is `[]` with a warning.

## 7. Storage Schema (`wiki_*`, `wiki_fts`)

Defined in `packages/storage-sqlite/src/wiki-schema.ts` and applied with the main schema (`user_version = 5`). All DDL and DML are static SQL with bound parameters.

| Table | Key | Notes |
|---|---|---|
| `wiki_snapshots` | `sid` (integer PK); `id` UNIQUE, NULL while building | `workspace_id`, `graph_snapshot_id`, `revision_ref`, `status` (`building\|ready\|partial\|failed`), `created_at`, `built_at`, `template_version`, `failure_reason`. A partial unique index allows only one `building` row per `(workspace_id, graph_snapshot_id)`. |
| `wiki_pages` | `(wiki_snapshot_sid, page_id)` | `kind` and `coverage_status` `CHECK` constraints; `parent_id` is a composite FK to the same table; `position` keeps canonical order. |
| `wiki_page_sections` | `(wiki_snapshot_sid, section_id)` | `generated_markdown`, `evidence_refs_json`, `status`; FK to the page. |
| `wiki_links` | `(wiki_snapshot_sid, link_id)` | `to_page_id` nullable (broken links); non-null targets are FK-checked; indexes on `from_page_id` and `to_page_id`. |
| `wiki_page_versions` | `(wiki_snapshot_sid, page_id)` | `revision_ref`, `content_hash`, `link_set_hash`, `template_version`, `coverage_status`. |
| `wiki_annotations` | `id` | Overlay: linked only to `workspaces`, not to any wiki snapshot. |
| `wiki_aliases` | `(workspace_id, page_id, alias)` | `source`, `candidate_new_page_id`, `match_confidence` (`0..1` `CHECK`). |
| `wiki_fts` | FTS5 virtual table | Columns from [§5.8](#58-wikisearchindex-fts5); no FK. |

Child tables cascade on snapshot deletion, but nothing deletes wiki snapshots today (see [§11](#11-limits-and-honest-gaps)).

**Build and publish sequence** (`writeAndPublishWikiProjection`): `beginWikiBuild` inserts a `building` row → pages, sections, links, page versions and FTS documents are written to that row → `publishWiki` sets `id`, `status` and `built_at` in one transaction. On any error the row is closed with `failWikiBuild` (`failed`), so a half-written snapshot is never readable and no stale `building` lock remains. Search uses a second, read-only connection to the same file.

## 8. MCP Tool Contracts — 7 Wiki Tools

Available only under `--tool-profile wiki`, `wiki,history` or `full` ([§2.1](#21-tool-profiles)). Input schemas are registered from `packages/mcp-server/src/schemas.ts` (`Wiki*ToolInputSchema`, identical in shape to the service schemas below); output data schemas come from `services-wiki.ts`. Every response is the standard 10-field envelope (`schemaVersion: "2.0"`). `outputSchema` is omitted from `tools/list` by default (`--output-schema full` publishes it); the server validates every envelope either way.

### 8.1 Shared behavior

- **Annotations:** `causoryn_wiki_build` has `readOnlyHint: false` (it writes only to the wiki SQLite data root); the six read tools have `readOnlyHint: true`. All seven have `destructiveHint: false`, `openWorldHint: false`.
- **Input validation:** arguments that do not match the registered strict input schema (unknown fields, wrong enum values, `limit < 1`, `depth > 8`, more than 200 `refs`) are rejected before the handler runs; the call returns `isError: true` rather than a Causoryn envelope.
- **Authorization first:** every tool checks the workspace (`workspaceId` defaults to the configured one) before anything else → `WORKSPACE_NOT_AUTHORIZED`.
- **Envelope fields:** `envelope.snapshotId` is the served **`WikiSnapshot`** ID (core tools put a graph snapshot ID there). `envelope.coverage` is populated only by `causoryn_wiki_build` (from the source graph); read tools return `null`. `envelope.status` is `partial` when the served wiki is `partial` (for `causoryn_wiki_diff`, when either side is).
- **Staleness:** a wiki is stale when its `graphSnapshotId` is not the workspace's latest published graph snapshot. Read tools then return `data.stale: true` (except `causoryn_wiki_diff`, which has no such field) and a warning recommending a rebuild.
- **Pagination:** opaque base64url cursor `{ "v": 1, "o": <offset> }`; `limit` default 50, maximum 200 (`LIMIT_EXCEEDED` above that); a malformed cursor gives `INVALID_ARGUMENT`; `nextCursor` is `null` on the last page and `envelope.nextCursor` equals `data.nextCursor` on the five paginated tools.
- **Snapshot selection:** an explicit `snapshotId` must be a published `WikiSnapshot` of the same workspace (`EVIDENCE_NOT_FOUND` otherwise); without it the latest published `WikiSnapshot` is used (`INDEX_NOT_READY` if none exists or no wiki data root is configured).
- **Indexing:** like other non-status tools, wiki tools wait up to `CAUSORYN_INDEX_WAIT_MS` for the first graph index. Unlike core tools, a wiki tool's `INDEX_NOT_READY` stays an error envelope (it is not converted into a `partial` "indexing" envelope), and wiki responses do not receive the background re-index `stale=true` warning that core tools get.
- **Strings:** field names, enum values and error codes are stable identifiers. Warning texts, `reason` / `summary` strings, error messages and generated Markdown labels are free text in plain English; do not parse free text.

### 8.2 Error codes

Codes used by the wiki services (`WIKI_TOOL_ERROR_CODES_USED` in `services-wiki.ts`, subset of the 15 codes in `packages/mcp-server/src/errors.ts`):

| Code | When |
|---|---|
| `WORKSPACE_NOT_AUTHORIZED` | Workspace not authorized (checked first) |
| `PATH_DENIED` | `causoryn_wiki_build` without a configured wiki data root (default deny) |
| `INDEX_NOT_READY` | No published graph snapshot (build); no published `WikiSnapshot` or no wiki data root (reads); a second build for the same graph snapshot is already running |
| `EVIDENCE_NOT_FOUND` | An explicit `snapshotId` is not a published `WikiSnapshot` of this workspace |
| `WIKI_PAGE_NOT_FOUND` | Unknown `pageId` / `parentId` in the served snapshot (for `causoryn_wiki_diff`: absent from both sides) |
| `INVALID_REVISION` | A Git ref in `causoryn_wiki_get_versions` cannot be resolved; a `causoryn_wiki_diff` side cannot be resolved |
| `INVALID_ARGUMENT` | `scope` on build; rejected search filters; empty query; malformed cursor; invalid core input |
| `LIMIT_EXCEEDED` | `limit` > 200 |
| `INTERNAL_ERROR` | Storage or consistency failures; the detail goes to stderr, not to the client |

Core error codes are mapped in one place (`wikiErrorToToolError`). It also maps the export codes `wiki/output-not-authorized` → `EXPORT_NOT_ALLOWED` and `wiki/output-path-denied` → `PATH_DENIED`, but no wiki tool calls the export core, so these are not reachable today.

Reserved wiki codes that are **not** registered as MCP error codes:

- `WIKI_REVISION_NOT_AVAILABLE`: unresolvable refs return `INVALID_REVISION`; valid refs without a stored `WikiSnapshot` are reported as `availability: "not_available"` data.
- `WIKI_BROKEN_LINK`: broken links are data (`toPageId: null` + `brokenLinkDiagnostics`), not errors.
- `WIKI_NOTE_CONFLICT`: the conflict exists in the core as `wiki/annotation-conflict`, but no MCP tool writes annotations, so the code is not registered.

### 8.3 `causoryn_wiki_build`

Projects the latest published `GraphSnapshot` of the workspace into a `WikiSnapshot` and publishes it atomically into the wiki data root. Never writes to workspace files.

```ts
export const WikiBuildInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  mode: z.enum(["full", "incremental"]),     // required
  scope: z.string().min(1).optional(),       // reserved: any value → INVALID_ARGUMENT
  revision: z.string().min(1).optional(),    // free-form revisionRef label; default graph revision.id
});

export const WikiBuildDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  graphSnapshotId: z.string(),
  revisionRef: z.string(),
  status: z.enum(["ready", "partial"]),
  mode: z.enum(["full", "incremental"]),     // executed mode
  fallbackReason: z.string().optional(),     // set when incremental fell back to full
  pagesRegenerated: z.number().int().nonnegative(),
  sectionsRegenerated: z.number().int().nonnegative(),
  linksRegenerated: z.number().int().nonnegative(),  // links written for the new snapshot
  brokenLinks: z.number().int().nonnegative(),
  warnings: z.array(z.string()),             // same content as envelope.warnings
});
```

- Full mode: `pagesRegenerated` / `sectionsRegenerated` / `linksRegenerated` are the totals written.
- Idempotent no-op: if the latest published `WikiSnapshot` already has the deterministic ID for the current graph snapshot, nothing is written and the counters are `0`.
- Errors: `WORKSPACE_NOT_AUTHORIZED`, `INVALID_ARGUMENT` (`scope`), `INDEX_NOT_READY`, `PATH_DENIED`, `INTERNAL_ERROR`.

### 8.4 `causoryn_wiki_get_tree`

Hierarchical page tree with coverage, freshness and child counts.

```ts
export const WikiGetTreeInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  snapshotId: z.string().min(1).optional(),
  parentId: z.string().min(1).optional(),            // subtree root; default: all 12 roots
  depth: z.number().int().min(1).max(8).optional(),  // depth cap; roots are depth 1
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

export const WikiTreeNodeSchema = z.strictObject({
  pageId: z.string(), kind: WikiPageKindSchema, parentId: z.string().nullable(),
  title: z.string(), route: z.string(),
  coverage: z.strictObject({ status: CoverageStatusSchema }),
  freshness: FreshnessSchema,
  childCount: z.number().int().nonnegative(),
  depth: z.number().int().positive(),
});

export const WikiGetTreeDataSchema = z.strictObject({
  wikiSnapshotId: z.string(), graphSnapshotId: z.string(), stale: z.boolean(),
  nodes: z.array(WikiTreeNodeSchema),
  totalNodes: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
```

Order is breadth-first: roots in taxonomy order, children sorted by `pageId`; pagination applies to that order. `no_data` categories are listed without filler. Errors: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `EVIDENCE_NOT_FOUND`, `WIKI_PAGE_NOT_FOUND` (unknown `parentId`), `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

### 8.5 `causoryn_wiki_get_page`

One page with its generated sections, evidence and source references.

```ts
export const WikiGetPageInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  pageId: z.string().min(1),
  snapshotId: z.string().min(1).optional(),
  sections: z.array(z.string().min(1)).optional(),   // sectionKey filter
  limit: z.number().int().min(1).optional(),         // sections per response
  cursor: z.string().min(1).optional(),
});

export const WikiGetPageDataSchema = z.strictObject({
  wikiSnapshotId: z.string(), graphSnapshotId: z.string(), stale: z.boolean(),
  page: z.strictObject({
    pageId: z.string(), kind: WikiPageKindSchema, parentId: z.string().nullable(),
    title: z.string(), slug: z.string(), route: z.string(), contentHash: z.string(),
    freshness: FreshnessSchema,
    coverage: z.strictObject({ status: CoverageStatusSchema, detail: z.string().optional() }),
  }),
  sourceRefs: z.array(EvidenceRefSchema),        // deduplicated over ALL sections, sorted by evidenceId
  sections: z.array(WikiPageSectionSchema),      // generated layer only, after filter + pagination
  sectionsTotal: z.number().int().nonnegative(), // sections matching the filter
  nextCursor: z.string().nullable(),
});
```

Annotations are not returned. Errors: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `EVIDENCE_NOT_FOUND`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

### 8.6 `causoryn_wiki_search`

Escaped FTS5 search over one published `WikiSnapshot`.

```ts
export const WikiSearchInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  query: z.string(),                          // trimmed, inner whitespace collapsed; empty → INVALID_ARGUMENT
  snapshotId: z.string().min(1).optional(),
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
  // Declared but not implemented: any value → INVALID_ARGUMENT
  kinds: z.array(WikiPageKindSchema).optional(),
  scope: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  revision: z.string().min(1).optional(),
  resolution: z.enum(["verified", "heuristic", "unresolved"]).optional(),
});

// data = WikiSearchResultSchema + stale
export const WikiSearchResultSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  workspaceId: z.string(),
  query: z.string(),                // normalized query
  matchExpression: z.string(),      // the escaped FTS5 phrase actually bound
  totalMatches: z.number().int().nonnegative(),
  hits: z.array(WikiSearchHitSchema),
  nextCursor: z.string().nullable(),
  skippedRankLegs: z.array(z.enum(["graphProximity"])),
});

export const WikiSearchHitSchema = z.strictObject({
  pageId: z.string(), kind: WikiPageKindSchema, title: z.string(), route: z.string(),
  freshness: FreshnessSchema,
  qualifiedSymbol: z.string().nullable(), apiRoute: z.string().nullable(), module: z.string().nullable(),
  snippet: z.string(),              // FTS5 snippet(): "[" … "]" markers, "…" ellipsis, 12 tokens
  matchedFields: z.array(z.enum(["title", "qualifiedSymbol", "apiRoute", "module", "tags", "body"])),
  evidenceIds: z.array(z.string()), // deduplicated evidence IDs from the page's sections
});
```

- **Query escaping:** the whole normalized query becomes one FTS5 phrase (`"..."`, inner quotes doubled) bound as a parameter, so operators such as `AND`, `OR`, `NEAR`, `*`, `:` are matched as text. Multi-word queries therefore match the words as an adjacent phrase.
- **Ranking** (`search-ranking.ts`), highest first: exact case-insensitive match of the query against `qualifiedSymbol` or `apiRoute` > query contained in the title > query contained in the module > FTS5 `bm25()` (unweighted) > graph proximity > tie-break by title, then `pageId` (code-unit comparison, no locale). The MCP service never supplies proximity data, so `skippedRankLegs` is always `["graphProximity"]`.
- **Relevance transparency:** `matchedFields` comes from six static column-filtered FTS5 queries; no hidden vector or embedding score exists.
- **Token budget:** hits carry snippets and metadata only; fetch full sections with `causoryn_wiki_get_page`.
- The full candidate set of the snapshot is ranked before pagination (suitable for wikis with hundreds of pages).
- Errors: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `EVIDENCE_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

### 8.7 `causoryn_wiki_get_links`

Outgoing links, derived backlinks and broken-link diagnostics for one page.

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
  wikiSnapshotId: z.string(), graphSnapshotId: z.string(), stale: z.boolean(),
  pageId: z.string(),
  direction: z.enum(["incoming", "outgoing", "both"]),
  outgoing: z.array(WikiLinkSchema),
  incoming: z.array(WikiLinkSchema),        // from the reverse index, not stored rows
  brokenLinkDiagnostics: z.array(BrokenLinkDiagnosticSchema),
  totalMatching: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
});
```

`direction` is applied: only the selected side(s) are returned and counted in `totalMatching`. Pagination runs over outgoing-then-incoming links; `brokenLinkDiagnostics` lists the page's own broken outgoing links (filtered by `linkKinds`, not paginated) with `toRef: null`, because stored rows do not keep the raw target name. Errors: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `EVIDENCE_NOT_FOUND`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

### 8.8 `causoryn_wiki_get_versions`

Revision availability for the latest published `WikiSnapshot`, with optional read-only Git ref resolution.

```ts
export const WikiGetVersionsInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  pageId: z.string().min(1).optional(),      // page version instead of snapshot revision
  refs: z.array(z.string().min(1)).min(1).max(200).optional(),
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

export const WikiGetVersionsDataSchema = z.strictObject({
  wikiSnapshotId: z.string(),
  stale: z.boolean(),
  versions: z.array(WikiVersionEntrySchema),
  nextCursor: z.string().nullable(),
});
```

- The first entry is always the latest published `WikiSnapshot` (`available`); with `pageId` it carries that page's `contentHash`, `linkSetHash`, `templateVersion` and `coverage`.
- Each `refs` entry is validated (`assertValidGitRef`) and resolved with `git cat-file -t` through the hardened read-only Git runner (`execFile`, `shell: false`, subcommand allowlist, `-c` overrides; see [Security Pass](security-pass.md)). `working-tree` resolves without spawning Git, so it works in directories without `.git`. One unresolvable ref fails the whole call with `INVALID_REVISION`.
- A resolved ref is `available` only if it equals the latest snapshot's `revisionRef` (by default `working-tree`); every other resolved ref is `not_available` with a reason. Older stored snapshots are not listed and there is no `snapshotId` input.
- Errors: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY`, `WIKI_PAGE_NOT_FOUND`, `INVALID_REVISION`, `INVALID_ARGUMENT`, `LIMIT_EXCEEDED`, `INTERNAL_ERROR`.

### 8.9 `causoryn_wiki_diff`

Structural differences between two published `WikiSnapshot`s. Reads stored rows only; never touches the working tree or Git.

```ts
export const WikiDiffInputSchema = z.strictObject({
  workspaceId: z.string().min(1).optional(),
  base: z.string().min(1),               // wikiSnapshotId, or revisionRef of the latest published wiki
  target: z.string().min(1),
  pageId: z.string().min(1).optional(),  // single-page scope
});

export const WikiDiffDataSchema = z.strictObject({
  base: z.string(), target: z.string(),
  baseWikiSnapshotId: z.string(), targetWikiSnapshotId: z.string(),
  addedPages: z.array(z.string()),
  removedPages: z.array(z.string()),
  changedSections: z.array(z.strictObject({ pageId: z.string(), sectionKey: z.string() })),
  addedLinks: z.array(WikiLinkSchema),
  removedLinks: z.array(WikiLinkSchema),
  contractChanges: z.array(z.strictObject({
    contractId: z.string(),
    changeKind: z.enum(["added", "removed", "modified"]),
    summary: z.string(),
  })),
  coverageDelta: z.array(z.strictObject({
    pageId: z.string(),
    previous: CoverageStatusSchema,
    current: CoverageStatusSchema,
    reason: z.string().optional(),
  })),
  unresolvedDifferences: z.array(z.strictObject({ pageId: z.string(), reason: z.string() })),
});
```

- Side resolution: a published `WikiSnapshot` ID of the workspace, or a string equal to the latest published snapshot's `revisionRef`. Since most snapshots share `revisionRef: "working-tree"`, use `wikiSnapshotId` values (from `causoryn_wiki_build` or `causoryn_wiki_get_tree`).
- `pageId` scope: page and section results are limited to that page, link results to links touching it, and `contractChanges` to records whose contract page ID equals it. A `removed` record carries the base ID and a `modified` record the target ID, so a base-only page scope may not show a `modified` record.
- Not paginated. `envelope.snapshotId` is the target ID; `envelope.status` is `partial` if either side is `partial`.
- Computation details: [§6.4](#64-diff-computations).
- Errors: `WORKSPACE_NOT_AUTHORIZED`, `INDEX_NOT_READY` (no wiki data root), `INVALID_REVISION`, `WIKI_PAGE_NOT_FOUND`, `INVALID_ARGUMENT`, `INTERNAL_ERROR`.

### 8.10 MCP resources

The design reserves a resource URI template `causoryn://wiki/{workspaceId}/{pageId}?snapshot={wikiSnapshotId}`. It is not implemented: the server advertises only the `tools` capability. MCP Apps or other interactive UI surfaces are not provided.

## 9. Write Permissions and Security Boundaries

### 9.1 Data-root rule

- `causoryn_wiki_build` writes only through `SqliteWikiStore` to the configured data root; it has no code path that writes workspace files.
- `validateDataDbPath` (`context.ts`) checks an explicit `wiki.dataDbPath` fail-closed at startup: absolute path; no null byte; at least one authorized root; lexically outside every root; parent directory exists; the database file and its `-wal`, `-shm`, `-journal` sidecars must not be directories, dangling symlinks are rejected, and the real paths of the parent and of every existing artifact must lie outside the real path of every root (symlink and junction escapes are rejected). Violations stop the server with a configuration error.
- Under `--auto-data-dir`, the directory checks of `buildWorkspaceAutoConfig` apply instead ([§2.2](#22-data-root)).
- The configuration has no model-provider or API-key settings (no-LLM policy).

### 9.2 Read-only Git

`causoryn_wiki_get_versions` runs only `git cat-file -t <ref>` via the shared read-only runner in `packages/graph/src/git-read.ts`; `causoryn_wiki_diff` runs no Git at all. Neither runs `checkout`, `reset` or `clean`. The runner's environment hardening (including `GIT_NO_LAZY_FETCH=1`, which needs Git 2.45 or newer to take effect) is described in the [Security Pass](security-pass.md).

### 9.3 Offline wiki export (library only)

`exportWikiOffline` (`packages/wiki/src/export.ts`) writes a self-contained wiki (`index.html`, `markdown/index.md`, one `.md` per page) and is separate from the data root:

- Target directories are authorized by `OutputAccessPolicy` (`output.allowedOutputDirs`); a rejected target gets no files and no subdirectories.
- Each file is written atomically through `OutputAccessPolicy.publishFile`: a temp file with a random name that the export creates itself in the target directory (`flag: "wx"`, mode `0600`, owner-only on POSIX), then a rename onto the target. The directory must stay the authorized, link-free directory up to the rename (otherwise `wiki/output-path-denied`, nothing published). Only that temp file is ever removed; an existing file at any other temp-like path, such as `<target>.tmp`, is never followed, removed or reused. The file set as a whole is not transactional: if a later file fails, earlier files remain.
- HTML: every dynamic value is escaped; CSP `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`; no scripts, external resources, CDN or telemetry; navigation only through same-document anchors; source paths shown as text, no `file://` links; raw `http(s)://` strings in body text are defanged.
- Markdown: table cells and headings are escaped; inline HTML and image embeds in section bodies are neutralized.
- File names: sanitized slugs with deterministic ID suffixes on collisions and for Windows reserved device names (`con`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`, …); remaining collisions are rejected, never overwritten.
- Annotations are not exported.

No MCP tool or CLI command calls this function today.

### 9.4 Write-permission matrix

| Tool / flow | Writes | Target |
|---|---|---|
| `causoryn_wiki_build` | yes (`readOnlyHint: false`) | Wiki SQLite data root only |
| `causoryn_wiki_get_tree`, `causoryn_wiki_get_page`, `causoryn_wiki_search`, `causoryn_wiki_get_links` | no (`readOnlyHint: true`) | — |
| `causoryn_wiki_get_versions` | no (`readOnlyHint: true`) | — (read-only Git; `working-tree` without Git) |
| `causoryn_wiki_diff` | no (`readOnlyHint: true`) | — (stored snapshots only) |
| `causoryn_status` with `action: "refresh"` (legacy `causoryn_refresh_index` in `full`) | yes | Graph index only; does not rebuild the wiki |
| `causoryn_export_documentation` | yes | `output.allowedOutputDirs` only; `view: "wiki"` → `INVALID_ARGUMENT` |
| Annotation create / update / delete | — | No MCP tool or CLI command; core `AnnotationOverlayEngine` only |

Of the seven wiki tools, only `causoryn_wiki_build` writes, and only to the external SQLite data root.

## 10. Tests and Acceptance Criteria

| Area | Acceptance criterion | Covered by |
|---|---|---|
| Hierarchy | The TypeScript orders fixture (`examples/fixture-ts-orders`) yields 12 roots in taxonomy order, child pages for modules / endpoints, and explicit `no_data` / `partial` states | `packages/wiki/test/wiki-projection.test.ts`, `packages/mcp-server/test/wiki-tools.test.ts` |
| Bidirectional links | Every outgoing link is found through the target's backlink query in the same snapshot; `verified` links carry evidence | `packages/wiki/test/wiki-links.test.ts`, `wiki-tools.test.ts` |
| Search ranking | An exact symbol or route match (for example `CreateOrder`, `post /orders`) ranks above generic body matches; `matchedFields` and `evidenceIds` are returned | `packages/wiki/test/wiki-search.test.ts`, `wiki-tools.test.ts` |
| Versioning | A diff between wikis built from two Git commits reports added pages, links, changed sections and coverage deltas and leaves the working tree untouched | `wiki-tools.test.ts` |
| Incremental build | Changing one service regenerates only affected pages; independent pages keep their `contentHash`; fallbacks report `fallbackReason` | `packages/wiki/test/wiki-incremental.test.ts`, `packages/mcp-server/test/wiki-build-incremental.test.ts` |
| Annotations | Two consecutive rebuilds leave annotation rows byte-for-byte intact; removed pages mark notes `orphan` without data loss; stale versions raise `wiki/annotation-conflict` | `packages/wiki/test/wiki-overlay.test.ts`, `packages/storage-sqlite/test/wiki-annotation-overlay.test.ts` |
| Uncertainty | Unresolved edges produce `partial` sections and are never shown as `verified` links | `wiki-projection.test.ts`, `wiki-links.test.ts` |
| Contract changes | `added` / `removed` / `modified` records and the missing-graph fallback | `packages/wiki/test/contract-changes.test.ts`, `wiki-tools.test.ts` |
| Storage | Atomic publish, `failed` on error, no lingering `building` lock, FK and `CHECK` constraints | `packages/storage-sqlite/test/wiki-store.test.ts`, `wiki-tools.test.ts` |
| Security | Data root inside the workspace or behind a symlink/junction stops the server; export HTML is escaped, CSP-restricted and makes no network requests | `wiki-tools.test.ts`, `packages/wiki/test/wiki-export.test.ts` |

Each wiki tool has positive, negative and partial-result cases in `wiki-tools.test.ts`. For current pass/fail evidence see [Implementation Status](implementation-status.md).

## 11. Limits and Honest Gaps

**Limits**

| Limit | Value |
|---|---|
| `limit` (tree, page sections, search, links, versions) | default 50, maximum 200 |
| `depth` (`causoryn_wiki_get_tree`) | 1–8 |
| `refs` (`causoryn_wiki_get_versions`) | 1–200 |
| Search snippet | 12 tokens |
| Template version | `1.1.0` |
| Concurrent builds | one `building` row per workspace and graph snapshot |

**Gaps (not implemented or partial)**

1. Search filters `kinds`, `scope`, `language`, `revision`, `resolution` are declared and rejected with `INVALID_ARGUMENT`; filter results on the client side. The graph-proximity rank leg is never fed.
2. Only `PARENT_OF`, `DEPENDS_ON` and `CALLS` links are generated; `DOCUMENTS`, `IMPLEMENTS`, `PRODUCES`, `CONSUMES`, `TESTED_BY`, `FLOWS_TO`, `RELATED_CONTRACT`, `CHANGED_IN` are schema-only. The `tags` search column is always empty.
3. Page kinds `component`, `symbol`, `policy` are never generated; Business Flows, Architecture Timeline and Onboarding are always `no_data`; the Tests & Quality `coverage-gaps` section is always `no_data`.
4. No automatic wiki rebuild after re-indexing (`wiki.autoBuildOnSnapshot` does not exist); call `causoryn_wiki_build` explicitly.
5. Incremental builds rewrite the full row set per `WikiSnapshot`.
6. No retention for wiki snapshots: every non-idempotent build adds a full row set to the database. Graph snapshot retention keeps only the two newest published graph snapshots, so after further re-indexes an incremental build falls back to full (previous graph gone) and `contractChanges` for older wiki pairs is `[]` with a warning.
7. `causoryn_wiki_get_versions` reports only the latest published `WikiSnapshot`; `causoryn_wiki_diff` resolves a `revisionRef` only for the latest one; `revisionRef` defaults to `working-tree` and is not tied to a Git commit.
8. No MCP or CLI surface for annotations; `WIKI_NOTE_CONFLICT` is not an MCP error code; annotations are not searchable or exportable (no `includeManualNotesInSearch` / `includeManualNotesInExport` options exist).
9. Offline wiki export is library-only; `causoryn_export_documentation(view="wiki")` returns `INVALID_ARGUMENT`.
10. Aliases (`wiki_aliases`) are not written or used by the build; rename detection is not active.
11. MCP resources for wiki pages are not published.
12. Warning, reason and summary texts, error messages and generated Markdown labels are English free text; clients should key on codes and enum values, not on message wording.
13. Planned configuration keys (`enabled`, `autoBuildOnSnapshot`, `includeManualNotesInSearch`, `includeManualNotesInExport`, `historicalSnapshotRetention`, `offlineExportDefault`) and planned metrics (`wiki_projection_duration`, `wiki_fts_update_duration`, `wiki_stale_queries`, `wiki_orphaned_notes`, …) do not exist; the strict config schema rejects these keys. `pagesRegenerated` and `brokenLinks` are reported in `causoryn_wiki_build` responses.

## 12. Related Documentation

- [Documentation Hub](README.md) · [5-Minute Quickstart Tutorial](tutorial-5-minutes.md)
- [MCP Tool Contracts](tool-contracts.md) — tool profiles, envelope, error codes, write-permission summary
- [CLI & Configuration](cli-and-configuration.md) — `--tool-profile`, `CAUSORYN_TOOL_PROFILE`, `--auto-data-dir`, `wiki.dataDbPath`, data directory layout
- [Architecture Overview](architecture.md) — package map and storage layout
- [Security Pass](security-pass.md) — read-only Git hardening and export safety
- [Prompting & Architecture Portals Guide](prompting-and-architecture-portals.md) — `causoryn_export_documentation`
- [Implementation Status](implementation-status.md) · [Türkçe Spesifikasyon](../wiki-spec.md)
