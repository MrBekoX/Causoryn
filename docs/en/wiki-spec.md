# Living Wiki Engine — Design & Implementation Specification

> **Language:** [Türkçe](../wiki-spec.md) | **English** · [Documentation Hub](README.md)
>
> **Source modules:** `packages/wiki/src/*`, `packages/storage-sqlite/src/{wiki-schema.ts,wiki-store.ts}`, `packages/mcp-server/src/services-wiki.ts`.

> **Current Pre-1.0 Status:**
> - **Implemented core & MCP surface:** The `@causoryn/wiki` projection engine (`projectWiki`, `projectWikiIncremental`, `resolveWikiLinks`, `buildWikiLinkIndex`, `WikiSearchStore`, `AnnotationOverlayEngine`, `exportWikiOffline`, `computeWikiCoverageDeltas`, `computeWikiContractChanges`), `@causoryn/storage-sqlite` (`SqliteWikiStore` + `wiki_*` + `wiki_fts` tables), and **all 7 Living Wiki MCP tools** are implemented and activated via `--tool-profile wiki`, `--tool-profile wiki,history`, or `--tool-profile full`.
> - **Shared data-root & `.git`-less `working-tree` support:** Alongside explicit `wiki.dataDbPath`, `causoryn mcp --allow-cwd --auto-data-dir` provisions a shared workspace SQLite database at `~/.causoryn/workspaces/<slug>-<hash12>/graph.sqlite` for both graph and wiki storage. In directories without `.git`, the `working-tree` revision resolves directly without spawning `git`.
> - **Open `1.0.0` release gates:** (1) Extra query filters on `causoryn_wiki_search` (`kinds`, `scope`, `language`, `revision`, `resolution`) are declared in the schema and explicitly rejected with `INVALID_ARGUMENT` until implemented; (2) `WIKI_NOTE_CONFLICT` is implemented internally in `AnnotationOverlayEngine` (`wiki/annotation-conflict`), while its MCP error-guidance entry is tracked alongside consented local note write flows; (3) automatic wiki rebuilds on index refresh (`wiki.autoBuildOnSnapshot`), `causoryn_export_documentation(view="wiki")` MCP wiring, and narrowed incremental SQLite link/FTS row rewrites remain open for `1.0.0`.

## 1. Purpose and Scope

The Living Wiki Engine projects Causoryn's Unified Evidence & Knowledge Graph into a deterministic, versioned, queryable 12-category SQLite + FTS5 project wiki. It is **not** a separate code analyzer — every generated section derives from an immutable `GraphSnapshot`, Git revision metadata, and contract nodes.

- **Living Wiki (`causoryn_wiki_*`):** Persistent, revisioned SQLite + FTS5 knowledge base queried incrementally over MCP (`--tool-profile wiki` or `full`).
- **Visual Architecture Portals (`causoryn_export_documentation`):** Standalone offline HTML/SVG/Mermaid/Markdown artifacts exported on demand to `output.allowedOutputDirs` ([Prompting & Architecture Portals Guide](prompting-and-architecture-portals.md)).
- **Generated vs. overlay separation:** Generated sections are regenerated freely on rebuild and never edited by hand; optional human notes or user-accepted host proposals live in an isolated `wiki_annotations` table and survive consecutive rebuilds intact.

## 2. Default Taxonomy & Page Kinds

Every workspace Wiki exposes **12 root categories** (`packages/wiki/src/taxonomy.ts` `WIKI_ROOT_CATEGORIES`):

```text
Workspace Wiki
├── Overview                  # repository, languages, scope, unknowns
├── Architecture              # L0–L4 layer/module/component summaries
├── Projects & Modules        # per-module components + dependencies
├── APIs & Entry Points       # endpoints, handlers, route links
├── Business Flows            # end-to-end flows
├── Events & Integrations     # producers/consumers, async contracts
├── Data & Schemas            # entities, tables, read/write access
├── Contracts & Policies      # API/event/schema contracts, policies
├── Tests & Quality           # test nodes, TESTS edges, coverage gaps
├── Architecture Timeline     # commit-based evolution
├── Onboarding                # learning paths, critical modules
└── Unresolved & Coverage     # unresolved edges, UnknownExternal nodes
```

Supported page kinds (`kind`): `overview | architecture | project | module | component | symbol | api | business_flow | event | data | contract | policy | test | timeline | onboarding | coverage`.

- Empty category pages carry `coverage.status: "no_data"` and `generatedMarkdown: ""` — filler prose is never synthesized.
- `pageId` is derived deterministically via SHA-256 from canonical graph identity + page kind so links and overlay notes remain stable across display-title changes.
- Uncertain renames/relocations are stored as `candidate_redirect` entries in `wiki_aliases` rather than silently promoted to `verified` links.

## 3. Core Data Model (`packages/wiki/src/`)

- **`WikiSnapshot`:** `{ id, workspaceId, graphSnapshotId, revisionRef, status: "building"|"ready"|"partial"|"failed", builtAt, templateVersion }`. Only `ready` or `partial` graph snapshots are projectable.
- **`WikiPage` & `WikiPageSection`:** Strict Zod schemas carrying `id`, `wikiSnapshotId`, `kind`, `parentId`, `title`, `slug`, `route`, `contentHash`, `freshness: "fresh"|"stale"`, `coverage: { status: "complete"|"partial"|"unsupported"|"no_data", detail? }`, and source-derived `sections` with `evidenceRefs`.
- **`WikiLink` (11 kinds):** `PARENT_OF`, `DOCUMENTS`, `DEPENDS_ON`, `CALLS`, `IMPLEMENTS`, `PRODUCES`, `CONSUMES`, `TESTED_BY`, `FLOWS_TO`, `RELATED_CONTRACT`, `CHANGED_IN`.
  - Every `verified` link requires at least one spanned `EvidenceRef` (otherwise downgraded honestly to `heuristic`).
  - Backlinks are derived in O(1) via a reverse index (`buildWikiLinkIndex`).
  - Unresolved targets are preserved with `toPageId: null` and paired with `brokenLinkDiagnostics` records rather than silently dropped.
- **`WikiPageVersion`:** Tracks `pageId`, `wikiSnapshotId`, `revisionRef`, `contentHash`, `linkSetHash`, `templateVersion`, and `coverage`. Missing revisions report `availability: "not_available"` with `notAvailableReason`.
- **`WikiAnnotation` (Overlay Layer):** Isolated `wiki_annotations` table supporting `authorKind: "human" | "host_model_proposal"` (host proposals always enforce `verified: false`), optimistic concurrency CAS via `expectedAnnotationVersion` (`wiki/annotation-conflict`), and non-destructive orphan tracking (`orphan: true` with automatic reconnect if the deterministic `pageId` returns). **No MCP tool mutates annotations**; editing notes belongs to a separate consented local workflow.
- **`WikiSearchIndex` (FTS5):** Indexes `title`, `qualified_symbol`, `api_route`, `module`, `tags`, `body` using escaped parameterized FTS5 queries ranked by exact symbol/route match > title > module > BM25 > graph proximity (zero embeddings).

## 4. MCP Tool Contracts — 7 Living Wiki Tools (`--tool-profile wiki` or `full`)

All 7 tools return the standard 10-field MCP envelope (`schemaVersion: "2.0"`). Only `causoryn_wiki_build` sets `readOnlyHint: false` (writing strictly to external SQLite); the remaining 6 tools are strictly read-only (`readOnlyHint: true`):

| Tool | `readOnlyHint` | Purpose & Key Fields |
|---|---|---|
| `causoryn_wiki_build` | `false` | Projects the latest published `GraphSnapshot` into a `WikiSnapshot` (`mode: "full" \| "incremental"`, optional `revision`; `scope` explicitly rejected) and publishes atomically to external SQLite (`wiki.dataDbPath` / shared `graph.sqlite`). |
| `causoryn_wiki_get_tree` | `true` | Paginated 12-category navigation tree (`parentId?`, `depth?`, `limit?` default 50 / cap 200, `cursor?`). |
| `causoryn_wiki_get_page` | `true` | Single page metadata, deduplicated `sourceRefs`, and section-paginated `generatedMarkdown` + `evidenceRefs` (`pageId`, `sections?`, `limit?`, `cursor?`). |
| `causoryn_wiki_search` | `true` | Phrase-escaped multi-column FTS5 search (`query`, `snapshotId?`, `limit?`, `cursor?`; exact symbol/route matches rank above generic body matches; unimplemented extra filter fields return `INVALID_ARGUMENT`). |
| `causoryn_wiki_get_links` | `true` | Outgoing links, O(1) reverse-indexed backlinks (`direction: "incoming"\|"outgoing"\|"both"`), `linkKinds?`, and `brokenLinkDiagnostics`. |
| `causoryn_wiki_get_versions` | `true` | Revision availability across stored `WikiSnapshot`s and read-only Git refs (`git cat-file -t` with hardened `-c` overrides; `working-tree` works without `.git`). |
| `causoryn_wiki_diff` | `true` | Read-only structural diff (`addedPages`, `removedPages`, `changedSections`, `addedLinks`, `removedLinks`, `contractChanges`, `coverageDelta`, `unresolvedDifferences`) between `base` and `target` snapshots/revisions. |

## 5. Write Permissions & Security Boundaries

- **Strictly out-of-tree SQLite:** `wiki.dataDbPath` is validated fail-closed via `validateDataDbPath` (absolute path, non-symlink including `-wal`/`-shm`/`-journal` sidecars, `realpathSync` strictly outside every `allowRoots` entry). Under `--auto-data-dir`, both graph and wiki share `~/.causoryn/workspaces/<slug>-<hash12>/graph.sqlite`.
- **Offline export (`exportWikiOffline`):** Writes atomically only inside `output.allowedOutputDirs`, emitting self-contained HTML with `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`, HTML escaping, URL defanging, Windows reserved device-name collision suffixing, and zero external resources.
- **Read-only Git:** `causoryn_wiki_get_versions` and `causoryn_wiki_diff` never modify the working tree or run `checkout`/`reset`/`clean`.

## 6. Related Documentation

- [Documentation Hub](README.md) · [5-Minute Quickstart Tutorial](tutorial-5-minutes.md)
- [MCP Tool Contracts](tool-contracts.md) · [Prompting & Architecture Portals Guide](prompting-and-architecture-portals.md)
- [Architecture Overview](architecture.md) · [CLI & Configuration](cli-and-configuration.md)
- [Implementation Status](implementation-status.md) · [Türkçe Spesifikasyon](../wiki-spec.md)
