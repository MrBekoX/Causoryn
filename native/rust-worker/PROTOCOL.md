# Rust Worker stdin/stdout Protocol — v1

> Field names match the `createSnapshot` INPUT contract in
> `packages/domain/src/snapshot.ts` (`SnapshotNodeInput` / `SnapshotEdgeInput` /
> `SnapshotEvidenceInput` — ID-less, with `NodeRef` endpoints). The wire pattern is the same as
> the Roslyn worker's (`native/roslyn-worker/PROTOCOL.md`); the differences are the parser —
> `syn` 3 from crates.io (`Cargo.lock` version `3.0.10`) — and the HONEST RESOLUTION LIMITS
> below. The source of truth for these rules is `src/analyzer.rs`.

**Causoryn Rust sidecar worker** — a local, deterministic Rust analyzer that runs no LLM. The
process reads requests line by line from stdin, answers each request with exactly one JSON line,
and never writes to the user's workspace (analysis is entirely in memory).

- **Transport:** local stdio; line-delimited JSON (every message is exactly one line).
- **Encoding:** UTF-8 without BOM; newlines inside JSON are `\n` escapes, so framing never breaks.
- **stdout discipline:** stdout carries ONLY protocol lines; all logs go to `stderr` (prefix
  `[rust-worker] `).
- **Encoding rule:** JSON keys are the domain field names (camelCase); optional fields are
  omitted instead of `null`. The only exception is `id`, which is an explicit `null` in error
  responses when the request line could not be parsed.
- **Dependency contract:** `syn` 3 for the AST, `serde_json` for JSON framing, and
  `proc-macro2` with the `span-locations` feature for source-line evidence. SHA-256 is
  implemented without a dependency (`src/sha256.rs`) and checked against the Node `crypto`
  digest in the acceptance tests.

## 1. Message framing

```
stdout ← {"id":...,"status":"ready",...}\n     (exactly one line per request)
stderr ← [rust-worker] ...                     (logs; not part of the protocol)
```

- The client starts the worker process and writes request lines to its stdin.
- Every non-empty line is a request; empty lines are skipped silently.
- The process exits with code `0` when the client closes stdin (EOF), and with `1` only if the
  stdio pipe itself breaks.
- The request loop runs on a separate thread with a 256 MB stack, so deeply nested ASTs end up
  either as a `PARSE_ERROR` diagnostic or as a completed analysis instead of a stack overflow
  (the counterpart of the Roslyn worker's two-layer defense).

## 2. Request — `type: "analyze"`

```json
{
  "id": "fixture-rust-1",
  "type": "analyze",
  "protocolVersion": "1",
  "files": [
    { "path": "main.rs", "content": "... source code ..." }
  ]
}
```

| Field | Type | Rule |
|---|---|---|
| `id` | string \| number | **Required.** Echoed verbatim in the response. |
| `type` | string | **Required.** Only `"analyze"` is supported. |
| `protocolVersion` | string | Optional. If present it must be `"1"`. |
| `maxNodes` | integer | Optional. Response node budget; must be within `1..MaxResponseNodes`, otherwise `INVALID_ARGUMENT`. Defaults to `MaxResponseNodes`. Booleans are rejected (JSON `true`/`false` are not numbers). |
| `files` | array | **Required, at least 1.** In-memory bag of Rust sources. |
| `files[].path` | string | **Required.** Workspace-relative POSIX path. Absolute paths and `""` / `.` / `..` segments are rejected. The same path cannot appear twice. |
| `files[].content` | string | **Required.** Full source text. |

An unknown field in the request object → `INVALID_ARGUMENT` (strict schema, the same discipline
as Zod `strictObject`); an unknown field in a `files[]` entry is rejected the same way.

### Resource limits (size limits only)

| Limit | Value | Behavior when exceeded |
|---|---|---|
| `MaxRequestLineBytes` | 64,000,000 bytes (a pessimistic upper bound for UTF-8) | The line is DISCARDED up to its newline; a response with `id: null` and `LIMIT_EXCEEDED` is written and the loop continues. |
| `MaxFileCount` | 5,000 files per request | Request rejected: `LIMIT_EXCEEDED`. |
| `MaxFileContentBytes` | 2,000,000 bytes per file (matches the server's default `maxFileBytes`) | Request rejected: `LIMIT_EXCEEDED`. |
| `MaxResponseNodes` | 250,000 nodes per response (can be lowered with `maxNodes`) | The extra nodes are NOT emitted and edges whose endpoints were not emitted are dropped too (no dangling edges). The response gets a `RESPONSE_TRUNCATED` diagnostic and `status: "partial"` — truncation is never silent. |

The limits are fixed (not configurable per request in protocol v1) and keep the behavior
deterministic for identical input.

## 3. Response — `status: "ready" | "partial"`

When the analysis completes:

```json
{
  "id": "fixture-rust-1",
  "protocolVersion": "1",
  "status": "ready",
  "worker": { "analyzerId": "rust-worker", "analyzerVersion": "0.1.0" },
  "capabilities": {
    "astParse": true, "symbolResolution": true, "containsEdges": true,
    "callEdges": true, "importEdges": false,
    "routeDetection": "rust-attribute-macro-route-pattern",
    "frameworkLinkers": false
  },
  "coverageRatio": 0.7419,
  "unsupportedConstructs": [...],
  "warnings": [],
  "diagnostics": [{ "relativePath": "...", "code": "PARSE_ERROR", "message": "...", "line": 3 }],
  "nodes": [...], "edges": [...], "evidence": [...]
}
```

- `status: "ready"` → no diagnostics; `"partial"` → at least one diagnostic (when a parser fails,
  only what can be proven is reported). Diagnostic codes are analysis-level: `PARSE_ERROR` (`syn`
  parse error), `IMPL_UNKNOWN_TYPE` (an `impl` for a type not declared in the set is not
  modeled), `MACRO_ITEM_SKIPPED` (a top-level item defined by a macro is skipped),
  `RESPONSE_TRUNCATED` (the response node budget — `maxNodes` / `MaxResponseNodes` — was
  exceeded; edges whose endpoints were not emitted are dropped, no dangling edges). `line` is
  1-based, `0` if unknown.
- `coverageRatio` = verified edges / all edges (4 decimals, the TypeScript adapter rule); `0`
  when there are no edges.
- `evidence` = de-duplicated list of the evidence carried by the edges; each edge also carries
  the same records in its own `evidence` field.
- `capabilities.symbolResolution: true` refers to the deterministic name tables described below;
  there is no semantic resolver (no type checking, no trait dispatch, no `use` resolution).

### Node fields (domain GraphNode equivalent — no IDs)

```json
{
  "kind": "Class",
  "qualifiedName": "crate::services::OrdersService",
  "language": "rust",
  "relativePath": "services.rs",
  "attributes": {},
  "span": { "startLine": 4, "endLine": 9 }
}
```

- `span` — optional (protocol v1 stays compatible: clients ignore an unknown field, and an older
  worker simply omits it). The 1-based, inclusive line range of the declaration from the syn
  span of the item (`proc-macro2` `span-locations`, the same `span_lines` the evidence uses):
  the `fn` item for Function nodes, the `struct` / `enum` item for Class, the `trait` item for
  Interface, the `fn` inside an `impl` or `trait` for Method. syn item spans include the outer
  attributes and doc comments (`#[derive(..)]`, `///`), so the range starts at the first of them;
  it is the same range as the node's CONTAINS `ast-span` evidence. A node declared more than once
  in one file (one method name in two `impl` blocks of a type, for example `fmt` in `impl Display`
  and `impl Debug`) gets the smallest range that covers every declaration, so the result does
  not depend on visit order; `impl` blocks do not widen the `struct` / `enum` node itself. File,
  Endpoint and UnknownExternal nodes carry no `span`. The adapter
  (`adapters/rust/src/node-span.ts`) accepts it only as positive integers with
  `startLine <= endLine` inside the analyzed file and binds it to that file's `relativePath` and
  source hash as the node `location`; anything else is dropped with one warning and the node
  keeps its file anchor.
- `kind` — limited to the domain node catalog. Used kinds: `File`, `Class`, `Interface`,
  `Function`, `Method`, `Endpoint`, `UnknownExternal`.
- `qualifiedName` rules (deterministic, derived from the source):
  - Module path: take `relativePath`, drop the `.rs` suffix, split on `/`, drop a leading `src`
    segment, drop a trailing `main` / `lib` / `mod` segment, join the rest with `::` and prefix
    `crate::` (just `crate` when no segment is left). Example: `services.rs` → `crate::services`;
    `main.rs` → `crate`.
  - Free `fn` → `Function`: `<module>::<fn>`.
  - `struct` and `enum` → `Class`: `<module>::<Name>`.
  - `trait` → `Interface`: `<module>::<Trait>`.
  - `fn` inside an `impl` → `Method`: `<module>::<Type>::<fn>`; a method declaration inside a
    `trait` → `Method`: `<module>::<Trait>::<method>`.
  - UnknownExternal: the call text as written (for example `std::env::var`), the method name for
    an unresolved method call, or `(anonymous-call)` for a call whose callee is not a path (for
    example calling a closure or a returned function value).
  - Endpoint: `"METHOD PATH"` (for example `"GET /orders"`).
- `attributes` — File: `sourceHash` (SHA-256 of the UTF-8 content, 64 hex); Endpoint: `method`
  and `path` (with a leading `/`); other kinds: an empty object.
- Endpoint and UnknownExternal nodes carry no `relativePath`.

### Edge fields (domain GraphEdge equivalent — no IDs)

```json
{
  "kind": "CALLS",
  "from": { "kind": "Function", "qualifiedName": "crate::list_orders", "relativePath": "main.rs" },
  "to":   { "kind": "Method", "qualifiedName": "crate::services::OrdersService::list", "relativePath": "services.rs" },
  "resolution": "heuristic",
  "evidence": [ { "kind": "semantic-symbol", "span": {...}, "analyzerId": "rust-worker", "analyzerVersion": "0.1.0", "rationale": "..." } ]
}
```

- `from` / `to` use the domain **NodeRef** shape (kind + qualifiedName + relativePath); there is
  NO ID field. IDs are derived deterministically by the domain normalizer (`createSnapshot`).
  **The worker never generates identities.**
- Edge kinds produced: `CONTAINS`, `CALLS`, `ROUTES_TO`. IMPORTS edges (`use` → IMPORTS) are not
  produced (`capabilities.importEdges: false`).
- `ambiguity` (`{ candidates, reason }`) is present only where the resolution table says so.
- Edges with the same (kind, from, to, resolution) key are merged; their evidence lists are
  de-duplicated and sorted.

### Evidence fields (domain Evidence equivalent — no IDs)

```json
{
  "kind": "semantic-symbol",
  "span": { "relativePath": "main.rs", "startLine": 12, "endLine": 12, "sourceHash": "<sha256-hex>" },
  "analyzerId": "rust-worker",
  "analyzerVersion": "0.1.0",
  "rationale": "CALLS: ... (verified; syn AST, no semantic resolver)."
}
```

- `span` is always present; lines are 1-based and match the source file content exactly (the
  acceptance tests compute them from the file text).
- Evidence kinds: `ast-span` (CONTAINS and `unresolved` CALLS), `semantic-symbol` (`verified` and
  `heuristic` CALLS), `route-attribute` (ROUTES_TO).
- **Honesty note:** `syn` has no SEMANTIC resolver. The `semantic-symbol` evidence kind only fills
  the matching slot of the domain evidence kinds; the basis is always the AST plus deterministic
  name tables, and the rationale text says so.

### Resolution rules — honesty table

The worker builds four name tables from the declarations of the whole request: free functions
per module, free functions keyed by (last module segment, name), free functions by bare name,
and methods keyed by (owning type or trait name, method name) plus by bare method name. Calls
are resolved against these tables only; candidates are sorted. When several candidates exist,
no edge is drawn to any of them: the call is `unresolved`, its target is an UnknownExternal node,
and every candidate is listed in `ambiguity.candidates` and in the rationale.

| Call shape | Candidates | resolution | Target / ambiguity |
|---|---|---|---|
| Bare call `foo()` | a free `fn foo` in the SAME module (file) | `verified` | that Function |
| Bare call `foo()` | none in the same module, exactly one `fn foo` elsewhere in the set | `heuristic` | that Function (no import evidence) |
| Bare call `foo()` | none in the same module, several elsewhere | `unresolved` + ambiguity | UnknownExternal (no edge to any candidate); `candidates` lists all of them |
| Path call `a::B::c()` / `B::c()` | exactly one match on the LAST TWO segments (`B::c`: a method of type/trait `B`, or a free fn `c` in a module whose last segment is `B`) | `heuristic` + ambiguity | that symbol; `candidates` = `[it]`, `reason` starts with `unverified-module-prefix-suffix-match` because module prefixes and `use` imports are not checked |
| Path call | several matches on the last two segments | `unresolved` + ambiguity | UnknownExternal (no edge to any candidate); `candidates` lists all of them |
| Method call `x.foo()` | exactly one method named `foo` in the set | `heuristic` | that Method (the receiver type is not resolved) |
| Method call `x.foo()` | several methods named `foo` (for example a trait declaration and its `impl`) | `unresolved` + ambiguity | UnknownExternal (no edge to any candidate); `candidates` lists all of them |
| Any of the above | no candidate (for example `std::env::var`, `Vec::new`) | `unresolved` | UnknownExternal (call text or method name); **no invented target** |
| Callee that is not a path (closure call, `f()()`, ...) | — | `unresolved` | UnknownExternal `(anonymous-call)` |

`verified` CALLS edges come only from same-module bare calls. Qualified paths are never
`verified`, even with a single candidate, because the match ignores the module prefix (the unit
test `two_segment_suffix_match_emits_heuristic_with_explicit_ambiguity_never_verified` in
`src/analyzer.rs` pins this). CONTAINS edges are always `verified`.

**Route detection (L3):** an attribute whose last path segment is `get`, `post`, `put`, `delete`,
`patch`, `head`, `options`, `connect` or `trace` (case-insensitive; `actix_web::get` works too)
with a string-literal path, or `#[route("…", method = …)]` / `method(…)` (axum / actix / rocket
patterns), produces an Endpoint node and a `verified` `ROUTES_TO` edge to the attributed `fn`
(`route-attribute` evidence: the attribute is syntactically bound to the item). A path without a
leading `/` gets one.

### `unsupportedConstructs` (not modeled)

`trait-method-dispatch` (the receiver type of a method call is not resolved → heuristic),
`macro-defined-items` (macro bodies and macro-defined items are not walked; a diagnostic is
emitted), `use-import-resolution` (no IMPORTS), `cross-crate-symbol-resolution` (symbols outside
the set become UnknownExternal), `nested-fn-items` (bodies of nested fn/trait/impl items inside a
function are not walked), `struct-literal-references` (`Order { .. }` produces no edge).

## 4. Error response — `status: "error"`

```json
{
  "id": null,
  "protocolVersion": "1",
  "status": "error",
  "error": { "code": "INVALID_ARGUMENT", "message": "..." }
}
```

- Request-level problems (schema violation, absolute path, `..` escape, duplicate path, unknown
  `type`, unknown `protocolVersion`, malformed JSON) reject the whole request; the loop
  CONTINUES with the next line.
- `id` is echoed with the client's value when the line can be parsed, otherwise `null`. A
  malformed line never stops the loop.
- Error codes come only from the fixed set `INVALID_ARGUMENT`, `INTERNAL_ERROR`,
  `LIMIT_EXCEEDED` (resource limits, table above); the worker never invents its own codes.
- File-level parse problems are NOT errors → `status: "partial"` plus `diagnostics` (above).

## 5. Version fields

- `protocolVersion` is optional in requests; if present it must be `"1"`.
- Responses always carry `protocolVersion: "1"`; `worker.analyzerVersion` is kept in sync with
  `[package].version` in `Cargo.toml` (the acceptance test reads it from the manifest) and is
  written to `Evidence.analyzerVersion`. It is the internal analyzer version and is independent
  of the Causoryn package release version.
- A breaking change (field name or meaning) bumps the version; adding a new field does not.

## 6. Determinism contract

- Identical `files` input → byte-identical response line (the acceptance test compares two runs
  byte for byte).
- Sources are sorted by relativePath (ordinal); nodes are sorted by the canonical key
  (kind, qualifiedName, relativePath) and edges by (kind, from, to, resolution); no clock is
  read; only `BTreeMap` / `BTreeSet` ordered structures are used.

## 7. Acceptance run (fixture)

`examples/fixture-rust-app/` (3 files: `main.rs`, `services.rs`, `repositories.rs`) is sent over
stdin; acceptance tests are `tests/rust-worker.test.ts`
(`npx vitest run tests/rust-worker.test.ts`) and `adapters/rust/test/rust-adapter.test.ts`. When
`cargo` is available, the test bootstrap runs the (incremental) build on EVERY run and fails the
suite explicitly on a build error; a Rust build regression never passes as a silent skip. A skip is
legitimate only when `cargo` is not found (reported as not run). Rust unit tests: `cargo test` in
`native/rust-worker`.

- **Positive:** `GET /orders → list_orders` and `POST /orders → create_order` `ROUTES_TO` edges
  are `verified`; `list_orders → create_audit_entry` (same module) is a `verified` CALLS edge; the
  qualified-path calls `list_orders → OrdersService::new` and
  `OrdersService::new → OrderRepository::new` are `heuristic` with
  `ambiguity.candidates = [<the single match>]` and a reason containing
  `unverified-module-prefix-suffix-match`; the method call `service.list()` is `heuristic`; the
  `save` call is `unresolved` (no edge to either candidate) with ambiguity over the trait and
  `impl` candidates (`OrderRepository::save`, `OrderStore::save`); `std::env::var` is `unresolved` with an
  UnknownExternal target; a bare call that matches a single function in another file is
  `heuristic`; evidence lines match the fixture text; node and edge kinds stay within the domain
  catalog.
- **Negative:** empty / missing `files`, a `..` segment, an absolute path, a duplicate path, an
  unknown top-level field, an unknown `files[]` field, a missing `id`, an unknown `type`, an
  unknown `protocolVersion`, malformed JSON, or `maxNodes` out of range (0, 250001) or not an
  integer (1.5, `true`) → `INVALID_ARGUMENT` with the `id` echoed; the worker keeps running after
  a malformed line. Limits: 3 MB of content and 5001 files → `LIMIT_EXCEEDED`.
- **Partial:** a syntax error → `status: "partial"` with diagnostics carrying file and line; the
  graph is still produced.
- **Node budget:** `maxNodes` range and integer rejections give `INVALID_ARGUMENT`; the upper bound
  (`250000`) is accepted; `maxNodes: 5` on a 13-node set emits 5 nodes, drops edges whose endpoints
  were not emitted (no dangling edges), adds `RESPONSE_TRUNCATED` with `status: "partial"`, keeps
  only the evidence of emitted edges, and the truncated response repeats byte for byte. A
  symbol-heavy input (8,000 distinct same-module calls) finishes within the time budget in one run
  (`push_edge` uses a `BTreeMap` index — no O(E²) linear scan).
- **Determinism:** the same request gives a byte-identical response line in two runs.
