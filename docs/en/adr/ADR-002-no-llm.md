# ADR-002 — No-LLM Strict Boundary

> **Language:** [Türkçe](../../adr/ADR-002-no-llm.md) | **English** · [Documentation Hub](../README.md)
>
> **Evidence base:** Technical Specification (TS) v2.1 §1 (Red Line), §3.1, §3.2, §19, §24 · `wiki/decisions.md` ADR-002 · `wiki/architecture.md`
> **Status:** **Accepted** (foundational specification mandate; verification evidence updated for `v0.2.0` Pre-1.0 Public Preview)
> **Date:** 2026-11-02 (initial record), 2026-11-20 (`v0.2.0` verification update); originates from TS v2.1 (2026-10-31)

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
evidenced data** only: MCP tool responses are deterministic data payloads; the
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
   `syn 2`), contract/config parsers, and verifiable file/git-commit spans;
   host-model prose can never be indexed as `verified` evidence (TS §3.2).
2. Retrieval and search rely strictly on deterministic primitives: compiler/AST
   symbol tables, graph neighborhood queries, and SQLite FTS5.
3. `packages/mcp-server` serves the host environment unidirectionally over
   `stdio`: `stdout` carries exclusively MCP JSON-RPC frames, while all logs go
   to `stderr` (TS §10.1).
4. Across all **18 npm workspace packages + the monorepo root** (19
   `package.json` manifests) in `v0.2.0`, runtime and build dependencies are
   strictly deterministic infrastructure libraries: `zod`,
   `@modelcontextprotocol/sdk`, `better-sqlite3`, `yaml`, `typescript`, and
   `esbuild` (and the published `packages/causoryn` package declares
   `"dependencies": {}` — zero external npm dependencies).

## Rationale

- **Determinism:** Identical inputs must yield byte-identical Graph JSON (TS §8
  invariant vi). Probabilistic LLM outputs would destroy snapshot determinism
  and reproducibility.
- **Evidence integrity (`ADR-004`):** Every `verified` edge must cite a
  verifiable file path, 1-based line span, and SHA-256 `sourceHash` — a bar
  probabilistic completions cannot satisfy.
- **Privacy & threat model:** Analysis executes locally with zero source-code
  exfiltration to third-party model APIs or telemetry endpoints (TS §19).
- **Clean separation of concerns (TS §3.1):** Reasoning and code synthesis live
  in the host agent; static measurement and proof live in Causoryn.

## Consequences & `v0.2.0` Verification Proof

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
  Across full 29-tool sessions, `CAUSORYN_NETLOG` remains **0 bytes**.
  *(Documented scope boundary: `net-guard.cjs` hooks in-process Node network
  APIs; child-process spawning is separately constrained to static command
  allowlists — read-only `git`, offline sidecars, and Rust's optional one-time
  cold `cargo build --locked` fetch from `crates.io`.)*

## Related Decisions & Documentation

- `ADR-001` Model-agnostic Core · `ADR-004` Evidence First · `ADR-008` Read-only Workspace Default · `ADR-010` Incomplete Feature Never Advertised as Done (TS §24; internal index: `wiki/decisions.md`)
- [Architecture Overview](../architecture.md) · [5-Language Analyzers](../language-analyzers.md) · [Security Audit](../security-pass.md)
