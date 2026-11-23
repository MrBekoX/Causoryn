# ADR-002 — No-LLM Strict Boundary

> **Language:** [Türkçe](../../adr/ADR-002-no-llm.md) | **English** · [Documentation Hub](../README.md)
>
> **Evidence base:** Technical Specification (TS) v2.1 §1 (Red Line), §3.1, §3.2, §19, §24 · `wiki/decisions.md` ADR-002, K-023 · `wiki/architecture.md`
> **Status:** **Accepted** (foundational engine boundary; updated for `v0.2.2` Pre-1.0 Public Preview with `K-023` hybrid architecture boundary and verification proof)
> **Date:** 2026-11-02 (initial record), 2026-11-20 (`v0.2.0` verification), 2026-11-23 (`v0.2.2` / `K-023` hybrid boundary clarification); originates from TS v2.1 (2026-10-31)

## Context

Causoryn is an evidence-backed **Unified Evidence & Knowledge Graph** engine for
repositories and monorepos (TS v2.1 §1). Page 1 of the Technical Specification
establishes an immutable architectural red line:

> "No LLM shall ever be executed or invoked inside Causoryn. …
> Causoryn produces local, deterministic analysis, graphs, verification, and
> structured tool output. It contains no LLM API, model router, model
> adapter/provider, inference server, embedding model, API key prompt, or
> host-model selection logic." (TS v2.1, p. 1)

Interpretation, planning, code editing, and tool orchestration belong strictly
to the host-selected model (`Antigravity`, `Claude Code`, `Codex`,
`ZCode (GLM)`) (TS §3.1 responsibility matrix). Causoryn produces **structured,
evidenced data** only: MCP tools return evidence-backed data. The
MCP server never initiates `sampling`, `elicitation`, or outbound model calls;
and Causoryn is never a client of any text-generation or embedding service
(TS §3.1 boundary contract).

## Decision

The Causoryn engine **contains zero LLM, embedding, vector-database, or model
API dependencies** and never performs local or remote model inference on any
code path.

### Prohibited Dependencies & Constructs (TS §3.2, Immutable)

- LLM inference/provider SDKs such as `openai`, `@anthropic-ai/sdk`,
  `@google/generative-ai`, `langchain`, or any equivalent client library.
- `ModelProvider`, `LLMRouter`, `InferenceService`, `EmbeddingService`,
  automatic model weight downloads, or local Ollama/vLLM/Transformers runtimes.
- Model API key environment variables, provider endpoint settings, or
  token/credit billing screens.
- Vector databases or embedding models for RAG. All symbol and documentation
  search is implemented via compiler/AST symbols, bounded graph traversal, exact
  matching, **SQLite FTS5** (`symbol_fts` and `wiki_fts`), and documented
  lexical ranking.

### Practical Engineering Consequences

1. Graph `Evidence` originates exclusively from static language analyzers
   (TypeScript Compiler API, C# Roslyn, Python `ast`, Go `go/parser`, Rust
   `syn 3`), contract/config parsers, and verifiable file/git-commit spans;
   host-model prose can never be indexed as `verified` evidence (TS §3.2).
2. Retrieval and search rely strictly on deterministic primitives: compiler/AST
   symbol tables, graph neighborhood queries, and SQLite FTS5.
3. `packages/mcp-server` serves the host environment unidirectionally over
   `stdio`: `stdout` carries exclusively MCP JSON-RPC frames, while all logs go
   to `stderr` (TS §10.1).
4. Across all **18 npm workspace packages + the monorepo root** (19
   `package.json` manifests) in `v0.2.2`, runtime and build dependencies are
   infrastructure libraries for analysis and packaging: `zod`,
   `@modelcontextprotocol/sdk`, `better-sqlite3`, `yaml`, `typescript`, and
   `esbuild` (and the published `packages/causoryn` package declares
   `"dependencies": {}` — zero external npm dependencies).

### `v0.2.2` (`K-023`) Architecture Exports and Optional Annotations

`causoryn_export_documentation` can render a portal from the static evidence
graph. A caller can add summaries, domain groups, flows, tours, decisions, and
risks through optional `annotations`. The `architecture-blueprint` skill guides
an external host LLM to prepare that input. The validator checks its schema and
whether its references exist and belong to the relevant graph or projection
(`moduleId`, `nodeId`, `evidenceId`, `keyFiles`). Invalid input returns
`INVALID_ARGUMENT`. The caller remains responsible for the accuracy of the prose.

### Scope of Determinism

The same renderer version, snapshot including metadata, format, view, options,
and annotation input produce byte-identical supported architecture artifacts.
Static graph analysis takes file contents, workspace and ignore settings,
analyzer versions, and toolchain versions and availability as inputs. New
builds can change metadata such as `createdAt`, publication times, and revisions.
MCP `requestId`, background job progress, and latency reflect runtime state.
Optional host-generated prose is a variable input to the renderer. See
`packages/graph/test/architecture-export.test.ts` and
`packages/mcp-server/src/{context.ts,server.ts,services.ts}`.

## Rationale

- **Core determinism:** Canonical graph ordering and identities are reproducible
  for equivalent inputs (TS §8 invariant vi). Annotations are renderer inputs.
  Graph evidence for `verified` edges comes from static sources.
- **Evidence integrity (`ADR-004`):** Every `verified` edge must cite a
  verifiable file path, 1-based line span, and SHA-256 `sourceHash` — a bar
  probabilistic completions cannot satisfy.
- **Privacy and threat model:** Causoryn analyzes the workspace locally and
  sends no source code to model APIs or telemetry services (TS §19). An external
  host’s data handling depends on its own configuration and provider.
- **Clean separation of concerns (TS §3.1, K-023):** Semantic reasoning and
  narrative synthesis live in the host agent; static measurement, fail-closed
  grounding verification, and deterministic layout live in Causoryn.

## Consequences & `v0.2.2` Verification Proof

- **Honest static boundaries (`ADR-010`):** Static analysis gaps are never
  masked with LLM guesses; they are reported transparently via `heuristic` (+
  `ambiguity`), `unresolved` (`UnknownExternal`), `coverage`, and `warnings`
  (see [5-Language Analyzers](../language-analyzers.md)).
- **Manifest & SBOM verification:** `tests/smoke.test.ts` asserts that banned
  LLM packages never appear in workspace `package.json` manifests. Furthermore,
  the **35-file** deterministic bundle manifest
  (`packages/mcp-server/dist/bundle-manifest.json`, covering `mcp-server.mjs`,
  `mcp-server.mjs.LEGAL.txt`, `node_modules/better-sqlite3/LICENSE`, and N-API
  v10 prebuilds), `packages/causoryn/THIRD-PARTY-NOTICES.md`, and the CycloneDX
  1.5 SBOM generated by `scripts/generate-sbom.mjs` contain zero AI/inference
  packages.
- **F6 behavioral zero-network proof (`net-guard.cjs`):** In the release
  security suite (`tests/security-release/helpers/net-guard.cjs`; see
  [Security Audit](../security-pass.md)), the bundled MCP server is spawned with
  `NODE_OPTIONS="--require .../net-guard.cjs"`, intercepting and denying all
  in-process Node.js outbound network APIs (`dns`, `net`, `tls`, `http`,
  `https`, `fetch`, `WebSocket`) while logging any attempt to `CAUSORYN_NETLOG`.
  The F6 session discovers 29 registrations through `tools/list`, then calls
  `causoryn_workspace_summary` and HTML export. `CAUSORYN_NETLOG` remains
  **0 bytes** in that session.
  *(Documented scope boundary: `net-guard.cjs` hooks in-process Node network
  APIs; child-process spawning is separately constrained to static command
  allowlists — read-only `git`, offline sidecars, and Rust's optional one-time
  cold `cargo build --locked` fetch from `crates.io`.)*

## Related Decisions & Documentation

- `ADR-001` Model-agnostic Core · `ADR-004` Evidence First · `ADR-008` Read-only Workspace Default · `ADR-010` Incomplete Feature Never Advertised as Done (TS §24; internal index: `wiki/decisions.md`)
- [Architecture Overview](../architecture.md) · [5-Language Analyzers](../language-analyzers.md) · [Security Audit](../security-pass.md)
