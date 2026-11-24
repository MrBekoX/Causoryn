# Decision Record: No LLM / Embedding / Model Dependencies

> **Language:** [Türkçe](../../adr/ADR-002-no-llm.md) | **English** · [Documentation Hub](../README.md)
>
> **Status:** Accepted — foundational engine boundary, current for Causoryn 0.3.0 (pre-1.0).
> **Dates:** recorded 2026-11-02; re-verified 2026-11-20 and 2026-11-23 (host-written annotations and MCP `.describe()` guidance); reviewed again for 0.3.0 (tool profiles, `worker_threads` indexing).

## Context

Causoryn is an evidence-backed code graph and change-verification engine for repositories and monorepos. Its founding design sets one non-negotiable rule:

> No LLM is ever executed or invoked inside Causoryn. Causoryn produces local, deterministic analysis, graphs, verification, and structured tool output. It contains no LLM API, model router, model adapter or provider, inference server, embedding model, API key prompt, or host-model selection logic.

The responsibilities are split explicitly:

- **Host coding agent** (`Antigravity`, `Claude Code`, `Codex`, `ZCode (GLM)`): interpretation, planning, code editing, and tool orchestration, using whatever model the host is configured with.
- **Causoryn:** structured, evidence-backed data only. MCP tools return graph facts, evidence, verification verdicts, and deterministic artifacts.

The MCP server never initiates `sampling`, `elicitation`, or any outbound model call; it registers only the `tools` capability (`packages/mcp-server/src/server.ts`). Causoryn is never a client of a text-generation or embedding service.

## Decision

The Causoryn engine **contains zero LLM, embedding, vector-database, or model-API dependencies** and performs no local or remote model inference on any code path.

### Prohibited Dependencies & Constructs

- LLM inference or orchestration SDKs such as `openai`, `@anthropic-ai/sdk`, `@google/generative-ai`, `langchain`, or any equivalent client library.
- `ModelProvider`, `LLMRouter`, `InferenceService`, `EmbeddingService`, automatic model-weight downloads, or local Ollama / vLLM / Transformers runtimes.
- Model API key environment variables, provider endpoint settings, or token/credit billing screens.
- Vector databases or embedding models for retrieval. Symbol and documentation search use compiler/AST symbol tables, bounded graph traversal, exact matching, path and identifier tokenization (`camelCase` / `PascalCase` / `snake_case` / `kebab-case`), and **SQLite FTS5** with `bm25` ranking (`symbol_fts`, `wiki_fts`).

## Consequences

1. **Evidence comes only from static sources.** Graph `Evidence` originates from the static analyzers (TypeScript Compiler API, C# Roslyn, Python `ast`, Go `go/parser`, Rust `syn` 3), contract/config parsers, and verifiable file or Git-commit spans. Host-model prose can never become `verified` evidence.
2. **Deterministic retrieval.** Search and localization rely on symbol tables, graph neighborhoods, and FTS5 — results are reproducible for equal inputs.
3. **One-way `stdio` service.** `packages/mcp-server` serves the host over `stdio`: `stdout` carries only MCP JSON-RPC frames; all logs go to `stderr`.
4. **Small dependency footprint.** Across the 18 npm workspace packages and the monorepo root (19 `package.json` manifests), the only external dependencies are analysis, storage, protocol, and build/test tooling: `zod`, `@modelcontextprotocol/sdk`, `better-sqlite3`, `yaml`, `typescript`, `esbuild`, `vitest`, `eslint`, `typescript-eslint`, and `@types/*`. The published `packages/causoryn` package declares `"dependencies": {}`.
5. **Static gaps stay visible.** When static analysis cannot prove a binding, Causoryn reports it as `heuristic` (+ `ambiguity`), `unresolved` (`UnknownExternal`), lower `coverage` tiers, and `warnings` instead of filling the gap with a guess (see [5-Language Analyzers](../language-analyzers.md)).
6. **Semantic synthesis belongs to the host.** Narratives such as module summaries or guided tours must come from the host agent (see the next section); Causoryn only validates and renders them.

### Boundary for Host-Written Architecture Annotations

`causoryn_export_documentation` renders architecture portals directly from the static evidence graph without any model call. A caller — usually the host coding agent, guided by `skills/architecture-blueprint/SKILL.md` and by the `.describe()` documentation on every input field — may optionally pass structured `annotations` (title, architecture style, executive summary, domains, module notes, flows, guided tour, decisions, risks). The recommended flow is two passes: first read `architectureSummary.moduleIds` with `format: "json"`, then send evidence-grounded annotations with `format: "html"`, `view: "interactive"`.

Causoryn's side of the boundary:

- validates the annotation schema and size budgets;
- checks every referenced `moduleId`, `nodeId`, `evidenceId`, and `keyFiles` entry against the active graph and projection, fail-closed, collecting up to 25 errors per call under `INVALID_ARGUMENT` (`packages/graph/src/architecture-annotations.ts`);
- never generates, rewrites, or "improves" the prose.

The factual accuracy of caller-supplied prose remains the caller's responsibility. Annotated output is still produced by a deterministic renderer; the annotations are simply one of its inputs. See [Prompting & Architecture Portals](../prompting-and-architecture-portals.md) for deterministic and annotated prompt patterns.

### Scope of Determinism

- The same renderer version, snapshot (including metadata), format, view, effective options, and validated annotations produce **byte-identical** architecture artifacts (`packages/graph/test/architecture-export.test.ts`).
- Static graph snapshots depend on file contents, workspace and ignore settings, analyzer versions, and toolchain versions and availability. Snapshot IDs are streaming SHA-256 digests (`computeStreamingSnapshotId`) that exclude wall-clock time, so a clean full build and an early-cutoff incremental build of the same inputs share one snapshot ID.
- New builds can change metadata such as `createdAt`, publication time, and revision. MCP `requestId`, background job progress, and latency reflect runtime state. Optional host-written prose is a variable input to the renderer.

## Rationale

- **Reproducibility:** canonical graph ordering and identities are reproducible for equivalent inputs; a probabilistic component would break that.
- **Evidence integrity:** every `verified` edge cites a file path, a 1-based line span, and a SHA-256 `sourceHash` — a bar that generated text cannot meet.
- **Privacy and threat model:** Causoryn analyzes the workspace locally and sends no source code to model APIs or telemetry services. How an external host handles data depends on its own configuration and provider.
- **Separation of concerns:** semantic reasoning and narrative synthesis live in the host agent; static measurement, fail-closed reference validation, and deterministic layout live in Causoryn.

## Enforcement & Verification

| Check | What it proves | Where |
|---|---|---|
| Banned-dependency test | `openai`, `@anthropic-ai/sdk`, `@google/generative-ai`, and `langchain` appear in no workspace `package.json` (root, all packages and adapters, `packages/causoryn`, `integrations/zcode/causoryn`) | `tests/smoke.test.ts` |
| Bundle manifest & notices | The 36-entry `packages/mcp-server/dist/bundle-manifest.json` (`mcp-server.mjs`, `index-worker.mjs`, `mcp-server.mjs.LEGAL.txt`, vendored `better-sqlite3` and its prebuilds), `packages/causoryn/THIRD-PARTY-NOTICES.md`, and the CycloneDX 1.5 SBOM from `scripts/generate-sbom.mjs` list no AI or inference package | `packages/mcp-server/scripts/build-bundle.mjs`, `scripts/generate-sbom.mjs` |
| Static network scan | The bundle contains no network transport imports or calls (`node:http`, `node:https`, `node:net`, `node:tls`, `node:dgram`, `node:dns`, `fetch(`, `XMLHttpRequest`, `WebSocket`) | static network group of `tests/security-release/f6-security-release.test.ts` |
| Behavioral zero-network session | The bundled server is spawned with `NODE_OPTIONS="--require …/net-guard.cjs"`, which logs and denies in-process `dns`, `net`, `tls`, `http`, `https`, `fetch`, and `WebSocket` use. The session lists 32 tools through `tools/list` (`full` profile), calls `causoryn_workspace_summary` and an HTML export, and the net log stays **0 bytes** | `tests/security-release/helpers/net-guard.cjs` + network-denied group of the same test file; see [Security Audit](../security-pass.md) |
| Server capabilities | The MCP server advertises only `tools`; it has no sampling or elicitation handler | `packages/mcp-server/src/server.ts` |

Scope note: `net-guard.cjs` hooks in-process Node.js network APIs. Child processes are constrained separately to fixed command allowlists — read-only `git`, the offline sidecars, and the Rust worker's optional one-time cold `cargo build --locked`, which may download crates from crates.io.

## Related Documentation

- Related design decisions: model-agnostic core, evidence first, read-only workspace by default, and "an incomplete feature is never advertised as Done" (see [Architecture Overview](../architecture.md) and [Implementation Status](../implementation-status.md)).
- [5-Language Analyzers](../language-analyzers.md) · [Prompting & Architecture Portals](../prompting-and-architecture-portals.md) · [Security Audit](../security-pass.md)
