# Go Worker stdin/stdout Protocol — v1

> Field names match the `createSnapshot` INPUT contract in
> `packages/domain/src/snapshot.ts` (`SnapshotNodeInput` / `SnapshotEdgeInput` /
> `SnapshotEvidenceInput` — ID-less, with `NodeRef` endpoints). The wire pattern follows
> `native/roslyn-worker/PROTOCOL.md` v1. The source of truth for the resolution rules below is
> `internal/analyze/analyze.go` and `internal/analyze/routes.go`.

**Causoryn Go sidecar worker** — a local, deterministic Go analyzer that runs no LLM. The
process reads requests line by line from stdin, answers each request with exactly one JSON line,
and never writes to the user's workspace (analysis is entirely in memory: `go/parser` receives
the sources from stdin and nothing is compiled on disk).

- **Transport:** local stdio; line-delimited JSON (every message is exactly one line).
- **Encoding:** UTF-8 without BOM; newlines inside JSON are `\n` escapes, so framing never breaks.
- **stdout discipline:** stdout carries ONLY protocol lines; all logs go to `stderr` (prefix
  `[go-worker] `).
- **Encoding rule:** JSON keys are the domain field names (camelCase); optional fields are
  omitted instead of `null`. The only exception is `id`, which is an explicit `null` in error
  responses when the request line could not be parsed.
- **Dependencies:** Go standard library only (`go/parser`, `go/ast`, `go/token`,
  `crypto/sha256`, `encoding/json`); `go.mod` declares no external module.

## 1. Message framing

```
stdout ← {"id":...,"status":"ready",...}\n     (exactly one line per request)
stderr ← [go-worker] ...                       (logs; not part of the protocol)
```

- The client starts the worker process and writes request lines to its stdin.
- Every non-empty line is a request; empty lines are skipped silently.
- The process exits with code `0` when the client closes stdin (EOF), and with `1` only if the
  stdio pipe itself breaks.
- A final non-empty line without a trailing newline is still processed as a request.

## 2. Request — `type: "analyze"`

```json
{
  "id": "fixture-go-1",
  "type": "analyze",
  "protocolVersion": "1",
  "files": [
    { "path": "cmd/app/main.go", "content": "... source code ..." }
  ],
  "moduleFiles": [
    { "relativePath": "go.mod", "content": "module example.com/app\n\ngo 1.27\n" }
  ],
  "maxNodes": 100000
}
```

| Field | Type | Rule |
|---|---|---|
| `id` | string \| number | **Required.** Echoed verbatim (as raw JSON) in the response. |
| `type` | string | **Required.** Only `"analyze"` is supported. |
| `protocolVersion` | string | Optional. If present it must be `"1"`. |
| `files` | array | **Required, at least 1.** In-memory bag of Go sources. |
| `files[].path` | string | **Required.** Workspace-relative POSIX path. Absolute paths (including drive letters) and `""` / `.` / `..` segments are rejected. The same path cannot appear twice. |
| `files[].content` | string | **Required.** Full source text. |
| `moduleFiles` | array | Optional. `go.mod` files used for exact import resolution (section 3, "Package identity"). At most `MaxFileCount` entries. |
| `moduleFiles[].relativePath` | string | **Required.** Workspace-relative POSIX path of the `go.mod` file (same path rules as `files[].path`; duplicates rejected). Note the key is `relativePath`, not `path`. |
| `moduleFiles[].content` | string | **Required.** Full `go.mod` text; only the `module` directive is read. |
| `maxNodes` | integer | Optional. Response node budget; must be within `1..MaxResponseNodes`, otherwise `INVALID_ARGUMENT`. Defaults to `MaxResponseNodes`. |

An unknown field in the request object, in `files[]` or in `moduleFiles[]` → `INVALID_ARGUMENT`
(strict schema, the same discipline as Zod `strictObject`).

The Causoryn indexing pipeline sends every `go.mod` file of the workspace inventory as
`moduleFiles` (`packages/indexing/src/index-service.ts`). Direct callers that omit it get the
weaker no-`go.mod` rules described below.

### Resource limits (size limits only)

| Limit | Value | Behavior when exceeded |
|---|---|---|
| `MaxRequestLineChars` | 64,000,000 chars | The line is DISCARDED up to its newline; a response with `id: null` and `LIMIT_EXCEEDED` is written and the loop continues. |
| `MaxFileCount` | 5,000 files per request (also applies to `moduleFiles`) | Request rejected: `LIMIT_EXCEEDED`. |
| `MaxFileContentBytes` | 2,000,000 bytes per file (UTF-8; also applies to `moduleFiles`) | Request rejected: `LIMIT_EXCEEDED`. |
| `MaxResponseNodes` | 250,000 nodes per response | When the hard ceiling or the request budget is reached, the extra nodes are NOT emitted and edges whose endpoints were not emitted are dropped too (no dangling edges). The response gets a `RESPONSE_TRUNCATED` diagnostic and `status: "partial"` — truncation is never silent. |

The limits are fixed (not configurable per request in protocol v1) and keep the behavior
deterministic for identical input. Function bodies whose AST walk depth exceeds 1000 are
EXCLUDED from call extraction; a `GO_AST_DEPTH` diagnostic and a warning are emitted once per
file and the result becomes `partial`.

## 3. Response — `status: "ready" | "partial"`

```json
{
  "id": "fixture-go-1",
  "protocolVersion": "1",
  "status": "ready",
  "worker": { "analyzerId": "go-worker", "analyzerVersion": "0.1.0" },
  "capabilities": {
    "astParse": true, "symbolResolution": false, "containsEdges": true,
    "callEdges": true, "importEdges": false,
    "routeDetection": "go-http-handlefunc-and-gin-echo-chi-registration-pattern",
    "frameworkLinkers": false
  },
  "coverageRatio": 0.6923,
  "unsupportedConstructs": [
    "semantic-type-resolution", "inline-anonymous-route-handlers",
    "builtin-function-calls", "closure-call-attribution"
  ],
  "warnings": ["..."],
  "diagnostics": [{ "relativePath": "...", "code": "GOPARSE", "message": "...", "line": 12 }],
  "nodes": [...], "edges": [...], "evidence": [...]
}
```

- `status: "ready"` → no diagnostics and no warnings; `"partial"` → at least one diagnostic or
  warning (when a parser fails, only what can be proven is reported). Diagnostics come from the
  `go/parser` `scanner.ErrorList` (code `GOPARSE`, 1-based line, `0` if unknown) and from
  `RESPONSE_TRUNCATED` / `GO_AST_DEPTH`.
- `coverageRatio` = verified edges / all edges (4 decimals; `1.0` when there are no edges).
- `evidence` = de-duplicated list of the evidence carried by the EMITTED edges; each edge also
  carries the same records in its own `evidence` field.
- `capabilities.symbolResolution: false` is an **honesty statement**: no `go/types` semantic
  model is used. The rules below are AST plus naming and path rules.

### Node fields (domain GraphNode equivalent — no IDs)

```json
{
  "kind": "Function",
  "qualifiedName": "services.NewOrdersService",
  "language": "go",
  "relativePath": "services/orders_service.go",
  "attributes": {}
}
```

- `kind` — limited to the domain node catalog; the worker cannot emit other kinds. Used kinds:
  `File`, `Class` (struct), `Interface`, `Type` (other type declarations), `Function` (top-level
  func), `Method` (func with a receiver), `Endpoint`, `UnknownExternal`.
- `qualifiedName` rules:
  - Top-level func: `<package>.<FuncName>` (e.g. `main.ordersHandler`).
  - Method: `<package>.<TypeName>.<MethodName>` (pointer receiver `*T` → `T`; generic receiver
    `T[...]` → base name; e.g. `services.OrdersService.GetOrders`).
  - Type: `<package>.<TypeName>` (struct → Class, interface → Interface, other → Type).
  - File: the `relativePath` itself.
  - Endpoint: `"<METHOD> <path>"` (e.g. `"* /orders"`, `"GET /users"`).
  - UnknownExternal: the source text of the call expression (e.g. `json.NewEncoder(w).Encode`)
    or the bare identifier.
  - `<package>` is the package clause name only. Two packages with the same name in different
    directories can therefore produce the same `qualifiedName`; their nodes stay distinct
    because the node key also includes `relativePath`.
- `attributes` — File: `sourceHash` (SHA-256 of the UTF-8 content, 64 hex); Endpoint: `method`
  and `path` (`http.HandleFunc` carries no HTTP verb, so `method` is `"*"`). `{}` for other kinds.

### Edge fields (domain GraphEdge equivalent — no IDs)

```json
{
  "kind": "CALLS",
  "from": { "kind": "Function", "qualifiedName": "main.ordersHandler", "relativePath": "main.go" },
  "to":   { "kind": "Method", "qualifiedName": "services.OrdersService.GetOrders", "relativePath": "services/orders_service.go" },
  "resolution": "heuristic",
  "evidence": [ { "kind": "ast-span", "span": {...}, "analyzerId": "go-worker", "analyzerVersion": "0.1.0", "rationale": "..." } ],
  "ambiguity": { "candidates": ["services.OrdersService.GetOrders"], "reason": "unique method name rule; ..." }
}
```

- `from` / `to` use the domain **NodeRef** shape (kind + qualifiedName + relativePath); there is
  NO ID field. IDs are derived deterministically by the domain normalizer (`createSnapshot`).
  **The worker never generates identities.**
- Edge kinds produced: `CONTAINS`, `CALLS`, `ROUTES_TO`. IMPORTS edges are not produced
  (`capabilities.importEdges: false`); import declarations are used only to resolve calls.
- UnknownExternal nodes carry NO `relativePath` (a symbol outside the analysis set has no file).
- Edges with the same (kind, from, to) are merged into one edge; their evidence is merged and
  de-duplicated.

### Evidence fields (domain Evidence equivalent — no IDs)

```json
{
  "kind": "ast-span",
  "span": { "relativePath": "main.go", "startLine": 38, "endLine": 38, "sourceHash": "<sha256-hex>" },
  "analyzerId": "go-worker",
  "analyzerVersion": "0.1.0",
  "rationale": "CALLS: ... (verified)."
}
```

- `span` is always present; lines are 1-based and match the source file content exactly.
- Evidence kinds: `ast-span` (CONTAINS and CALLS) and `route-registration` (ROUTES_TO).
  `route-registration` is the honest name for Go's route registration CALL pattern and must not
  be confused with C#'s `route-attribute` evidence; `Evidence.kind` is deliberately a free
  string in the domain schema.

### Package identity

- A Go package is keyed by **(directory of the file, package clause name)**. Files in the same
  directory with the same package clause form one package; packages with the same name in
  different directories (for example `cmd/api` and `cmd/worker`, both `package main`) are
  separate packages and are never linked to each other as `verified`.
- `_test` packages are not import targets, and `package main` is never an import target.
- `go.mod` module paths (from `moduleFiles`) map import paths to directories: an import path
  equal to a module path resolves to that module's root directory, and `<modulePath>/<sub>`
  resolves to `<moduleRoot>/<sub>`. When modules are nested, the longest matching module path
  wins.
- For an unaliased import resolved through `go.mod` to a directory that holds exactly one
  package, the declared package name is also accepted as the local name when it differs from
  the last path segment (for example directory `my-pkg` with `package mypkg`, or a `/v2` path).

### Resolution rules — honesty table

Bare identifier calls and selector calls (`X.Sel(...)`) are classified as follows. Builtins
(`len`, `make`, `append`, `new`, ... — `goBuiltins` in `model.go`) never produce an edge.

| # | Pattern | resolution | Target |
|---|---|---|---|
| 1 | Bare identifier; a top-level func with that name exists in the SAME package (same directory + same package name) | `verified` | Function node |
| 2 | Bare identifier; builtin | — | No edge |
| 3 | Bare identifier; no such func in the same package (a func with that name in another directory does not count) | `unresolved` | UnknownExternal(name) |
| 4 | `alias.F()` where `alias` is an import local name and the import path resolves through a `go.mod` module path to a directory holding exactly one package: `F` is a top-level func of that package | `verified` | Function node |
| 5 | Same as 4, but `F` is not defined in that package | `unresolved` | UnknownExternal(call text) |
| 6 | Import path resolves through `go.mod` to a directory holding several packages, and more than one of them defines `F` | `unresolved` + ambiguity (candidates) | UnknownExternal(call text) |
| 7 | Import path resolves through `go.mod`, but the directory is not in the analysis set (or holds several packages of which at most one defines `F`) | `heuristic` + ambiguity | UnknownExternal(call text) |
| 8 | Import path matches no `go.mod` module, and the caller's file lies under a directory governed by a provided `go.mod` (the import is a standard-library or third-party package) | `heuristic` + ambiguity | UnknownExternal(call text) |
| 9 | No `go.mod` governs the caller: the import matches exactly one workspace package, by directory suffix (import path equals or ends with `/<dir>`) or, failing that, by package name; `F` is defined there | `heuristic` + ambiguity (reason names the match rule) | Function node |
| 10 | Same as 9, but `F` is not defined in the matched package | `unresolved` | UnknownExternal(call text) |
| 11 | No `go.mod` governs the caller and the import matches several workspace packages: more than one defines `F` | `unresolved` + ambiguity (candidates) | UnknownExternal(call text) |
| 12 | Same as 11, but exactly one matched package defines `F` | `heuristic` + ambiguity (all directory candidates) | Function node |
| 13 | Same as 11, but none of them defines `F` | `unresolved` | UnknownExternal(call text) |
| 14 | No `go.mod` governs the caller and no workspace package matches (standard-library or third-party package) | `heuristic` + ambiguity | UnknownExternal(call text) |
| 15 | Chained selector whose leftmost base identifier is an import local name (e.g. `json.NewEncoder(w).Encode`) | `heuristic` + ambiguity | UnknownExternal(call text) |
| 16 | `x.M()` / `x.field.M()` where `x` is not an import name and exactly one method named `M` exists in the analysis set | `heuristic` + ambiguity | Method node (unique method name rule) |
| 17 | `x.M()` and methods named `M` exist on more than one type | `unresolved` + ambiguity (candidates) | UnknownExternal(call text) |
| 18 | `x.M()` and `M` is only an interface method name (no concrete method in the set) | `heuristic` + ambiguity (candidates = `Interface.M`) | UnknownExternal(call text) |
| 19 | Selector with no match at all, a selector whose base is not an identifier, or another call form (func literal call, generic instantiation, ...) | `unresolved` | UnknownExternal(call text) |

`verified` is used only in rows 1 and 4 (and for named route handlers, below). Row 1 matches the
name to a top-level func declaration in the same package scope through `go/ast`; local
shadowing cannot be told apart from the AST alone and is a documented boundary
(`semantic-type-resolution` in `unsupportedConstructs`). Row 4 requires the exact `go.mod`
module-path mapping; without `go.mod`, package-qualified calls are at most `heuristic`.
Candidate labels include the file path when two candidates share a `qualifiedName`.

### Route detection (L3)

Recognized registration calls (`routes.go`): a selector call `x.Name(...)` on an identifier where
`Name` is, case-insensitively, `Handle` or `HandleFunc` (method `"*"`), `GET`, `POST`, `PUT`,
`DELETE`, `PATCH`, `HEAD` or `OPTIONS` (so chi `Get` and gin/echo `GET` both match). Two guards
are required: (1) the first argument is a string literal starting with `/`, and (2) there are at
least two arguments. Recognized registration calls produce NO `CALLS` edge; they are fully
represented by the Endpoint node and its `ROUTES_TO` edge.

Handler resolution: an identifier naming a top-level func of the same package → `verified`; any
other identifier → `unresolved` (UnknownExternal); a selector or other expression → the CALLS
table above; a func literal (inline anonymous handler) → the Endpoint is KEPT, no `ROUTES_TO` is
produced, and a warning is added (`inline-anonymous-route-handlers`).

### `unsupportedConstructs` (not modeled)

`semantic-type-resolution` (no `go/types` — naming and path rules only),
`inline-anonymous-route-handlers`, `builtin-function-calls`, `closure-call-attribution` (calls
inside a func literal are attributed to the enclosing named function).

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
  `LIMIT_EXCEEDED`; the worker never invents its own codes. An unexpected panic is caught with
  `recover` → `INTERNAL_ERROR` response; the process keeps running.
- File-level parse problems are NOT errors → `status: "partial"` plus `diagnostics`; the graph
  is still produced from the parseable parts.

## 5. Version fields

- `protocolVersion` is optional in requests; if present it must be `"1"`.
- Responses always carry `protocolVersion: "1"`; `worker.analyzerVersion` matches the
  `AnalyzerVersion` constant in `model.go` (`0.1.0`) and is written to `Evidence.analyzerVersion`.
- A breaking change bumps the version; adding a new optional field (such as `moduleFiles`) does
  not.

## 6. Determinism contract

- Identical `files` and `moduleFiles` input → byte-identical response line (tested across two
  runs; `go run` and binary mode produce the same graph).
- Sources are sorted by relativePath; node, edge and evidence output is sorted by canonical
  keys; no clock is read; map iteration order never leaks into the output.

## 7. Acceptance runs

- **Fixture:** `examples/fixture-go-app/` (`main.go`, `services/orders_service.go`,
  `repositories/orders_repository.go`; its `go.mod` documents that the fixture is a real Go
  module). The acceptance suite `adapters/go/test/go-adapter.test.ts`
  (`npx vitest run adapters/go/test/go-adapter.test.ts`) sends the three `.go` files without
  `moduleFiles`. When Go is available its bootstrap builds the worker on every run
  (`go build ./...` and `-o bin/go-worker-test.exe`) and fails the suite explicitly on a build
  error; a skip is legitimate only when no Go toolchain is found (reported as not run).
  - **Positive:** `ordersHandler → newOrderService → OrdersService.GetOrders →
    OrdersRepository.FindAll` and `createOrderHandler → ... → Save`; same-package bare
    identifiers `verified`; package-qualified calls without `go.mod` and unique method names
    `heuristic`; untyped selector calls `unresolved`; `"* /orders"`, `"* /orders/create"` and
    `"* /health"` `ROUTES_TO` edges `verified`; node and edge kinds within the domain catalog;
    evidence lines match the fixture text.
  - **Package identity:** a multi-file package resolves cross-file calls in the same directory as
    `verified`; two `package main` directories never produce a cross-directory `verified` edge;
    with `moduleFiles`, a `<modulePath>/pkg` import resolves exactly (`verified`), and without
    `go.mod` a basename collision is never `verified` and carries explicit ambiguity.
  - **Negative:** empty / missing `files`, a `..` segment, an absolute path, a duplicate path, an
    unknown top-level field, an unknown `files[]` field, a missing `id`, an unknown `type`, an
    unknown `protocolVersion` or malformed JSON → `INVALID_ARGUMENT` with the `id` echoed; the
    worker keeps running after a malformed line. Limits: 2 MB of content and 5001 files →
    `LIMIT_EXCEEDED`; `maxNodes` out of range → `INVALID_ARGUMENT`.
  - **Partial:** syntax error → `status: "partial"` with `GOPARSE` diagnostics and the graph still
    produced; `maxNodes` truncation → `RESPONSE_TRUNCATED` without dangling edges; depth over 1000
    → `GO_AST_DEPTH`; inline anonymous handler → Endpoint kept plus a warning.
  - **Determinism:** the same request gives a byte-identical response line in two runs.
- **Go unit tests:** `go test ./...` in `native/go-worker` runs
  `internal/analyze/analyze_test.go` (multi-file packages, dual `package main` directories,
  `go.mod` exact resolution and basename-ambiguity honesty) and `cmd/worker/main_test.go`
  (`moduleFiles` request parsing).

When the full Causoryn indexer analyzes `examples/fixture-go-app`, it also sends the fixture's
`go.mod` (module `causoryn.fixture.go-orders`), so the package-qualified calls
`newOrderService → services.NewOrdersService` and
`newOrderService → repositories.NewOrdersRepository` resolve as `verified` through row 4.

## 8. Spawn modes (adapter side)

- **Default: `go run ./cmd/worker`** with `cwd` = `native/go-worker`. The worker source in the
  repository stays the single source of truth; builds are cached in `GOCACHE` (warm runs take
  seconds); build errors are visible on `stderr` and are recorded in the unavailable-fallback
  reason; no binary artifact has to ship. The first cold build can take over a minute, so the
  adapter's default request timeout is 120 s (`DEFAULT_REQUEST_TIMEOUT_MS` in
  `adapters/go/src/types.ts`).
- **Prebuilt binary:** the `goWorkerBinaryPath` option or the `CAUSORYN_GO_WORKER_BIN`
  environment variable → spawn `[binaryPath, []]`. Test convention:
  `go build -o native/go-worker/bin/go-worker-test.exe ./cmd/worker` (`bin/` is git-ignored).
- In both modes the command comes from configuration, the argument array is FIXED, there is no
  shell (`shell: false`), and request content travels only on stdin. The child environment is
  built from an allowlist with `GOTOOLCHAIN=local`, `GOWORK=off` and `GOPROXY=off`
  (`adapters/go/src/worker-process.ts`), so a workspace cannot trigger toolchain downloads,
  workspace-mode overrides or module fetches. On Windows in `go run` mode, the adapter kills the
  whole process tree (`taskkill /T /F`) so the compiled worker does not outlive `go`.
- When the worker is unavailable or fails, the adapter falls back to L0/L1 file-level output and
  says so in a warning.
