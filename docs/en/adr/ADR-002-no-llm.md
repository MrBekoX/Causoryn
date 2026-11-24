# Architecture Decision: No-LLM Strict Boundary

> **Language:** [Türkçe](../../adr/ADR-002-no-llm.md) | **English** · [Documentation Hub](../README.md)
>
> **Status:** Accepted (foundational engine invariant, active across `v0.2.4` and all pre-1.0 releases)

## Context

Causoryn is a local, deterministic, evidence-backed code graph and change-verification engine for repositories and monorepos. From the outset, Causoryn enforces a strict architectural separation between **static code measurement** and **LLM reasoning**:

- No LLM is ever executed or invoked inside Causoryn.
- Causoryn contains no LLM API client, model router, provider adapter, local inference server, embedding model, vector database, API key prompt, or host-model selection logic.
- Interpretation, planning, code editing, and tool orchestration belong strictly to the external host coding agent (`Antigravity`, `Claude Code`, `Codex`, `ZCode (GLM)`).
- The MCP server never initiates `sampling`, `elicitation`, or outbound model API calls.

## Decision

The Causoryn engine contains **zero LLM, embedding, vector-database, or model API dependencies** and performs zero local or remote model inference on any execution path.

### Prohibited Dependencies & Constructs

- LLM provider/orchestration SDKs (`openai`, `@anthropic-ai/sdk`, `@google/generative-ai`, `langchain`, or equivalents).
- `ModelProvider`, `LLMRouter`, `InferenceService`, `EmbeddingService`, model weight downloads, or local Ollama/vLLM/Transformers runtimes.
- Model API key environment variables, provider endpoint settings, or token/credit billing UI.
- Vector databases or embedding-based RAG. All code localization and documentation search run strictly on deterministic primitives: compiler/AST symbol tables, bounded graph traversal, path + identifier tokenization (`camelCase`/`PascalCase`/`snake_case`/`kebab-case`), **SQLite FTS5 BM25** (`symbol_fts` and `wiki_fts`), and structural degree scoring.

### Practical Engineering Consequences

1. **Verifiable static evidence:** Graph `Evidence` originates exclusively from static language analyzers (TypeScript Compiler API, C# Roslyn, Python `ast`, Go `go/parser`, Rust `syn` 3), contract/config parsers, and verifiable file/Git-commit spans; host-model prose can never be indexed as `verified` evidence.
2. **Clean `stdio` transport:** `packages/mcp-server` communicates unidirectionally over `stdio`: `stdout` carries exclusively MCP JSON-RPC 2.0 frames, while all diagnostics go to `stderr`.
3. **Minimal infrastructure dependency footprint:** Across all 18 npm workspace packages + the monorepo root (19 `package.json` manifests), runtime and build dependencies are strictly analysis and packaging libraries (`zod`, `@modelcontextprotocol/sdk`, `better-sqlite3`, `yaml`, `typescript`, `esbuild`), and the published `packages/causoryn` package declares `"dependencies": {}`.

### Hybrid Architecture Portals & Optional Host Annotations

`causoryn_export_documentation` renders deterministic architecture portals directly from the static evidence graph with zero model calls. A caller (typically the external host coding agent guided by `skills/architecture-blueprint/SKILL.md`) may optionally supply structured `annotations` (domains, module notes, flows, guided tours, decisions, and risks). Causoryn validates the schema, size budgets, and graph/projection references (`moduleId`, `nodeId`, `evidenceId`, `keyFiles`) fail-closed in a single pass (collecting up to 25 errors under `INVALID_ARGUMENT`) while remaining 100% LLM-free. Factual accuracy of caller-supplied prose remains the caller's responsibility. See [Prompting & Architecture Portals](../prompting-and-architecture-portals.md).

### Scope of Determinism

- Identical renderer version, snapshot (including metadata), format, view, effective options, and validated annotations produce **byte-identical** architecture artifacts.
- Static graph snapshots depend on file contents, workspace/ignore configuration, analyzer versions, and toolchain availability; streaming SHA-256 snapshot IDs (`computeStreamingSnapshotId`) exclude wall-clock build timestamps so clean full builds and early-cutoff incremental builds produce identical snapshot IDs.
- Runtime fields such as `requestId`, timestamps, job progress, and caller-supplied prose can vary across sessions.

## Rationale

- **Evidence integrity:** Every `verified` edge cites a verifiable file path, 1-based line span, and SHA-256 `sourceHash` — a bar probabilistic completions cannot satisfy.
- **Privacy and threat model:** Causoryn analyzes repositories locally and transmits zero source code to model APIs or telemetry services.
- **Clean separation of concerns:** Semantic reasoning and narrative synthesis live in the host coding agent; static measurement, fail-closed reference validation, and deterministic layout live in Causoryn.

## Verification Proof

- **Manifest & SBOM checks:** `tests/smoke.test.ts` asserts that banned LLM packages never appear in workspace manifests; the 36-file `bundle-manifest.json`, `THIRD-PARTY-NOTICES.md`, and CycloneDX 1.5 SBOM contain zero AI/inference dependencies.
- **Zero-network behavioral proof (`net-guard.cjs`):** The packaged-bundle security suite (`tests/security-release/helpers/net-guard.cjs`; see [Security Audit](../security-pass.md)) spawns the compiled MCP server with `NODE_OPTIONS="--require .../net-guard.cjs"`, intercepting and denying all in-process Node.js outbound network APIs (`dns`, `net`, `tls`, `http`, `https`, `fetch`, `WebSocket`). Across a full handshake, index, and export session, `CAUSORYN_NETLOG` remains **0 bytes**. *(Child-process spawning is separately restricted to static allowlists — isolated read-only `git`, offline sidecars, and Rust's optional cold `cargo build --locked` crate fetch.)*

## Related Documentation

- [Architecture Overview](../architecture.md) · [5-Language Analyzers](../language-analyzers.md)
- [Prompting & Architecture Portals](../prompting-and-architecture-portals.md) · [Security Audit](../security-pass.md)
