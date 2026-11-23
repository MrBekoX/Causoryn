# 5-Language Analyzers, Honest Resolution Discipline & Sidecar Protocol

> **Language:** [Türkçe](../language-analyzers.md) | **English**
>
> **Evidence base:** `packages/indexing/src/{index.ts,index-service.ts,inventory.ts,fingerprint.ts}`, `packages/workspace/src/ignore-matcher.ts`, `packages/mcp-server/src/workspace-ignore-discovery.ts`, `packages/sidecar-ipc/src/index.ts`, `adapters/typescript/src/{analyzer.ts,tsconfig-loader.ts}`, `adapters/{csharp-roslyn,python,go,rust}/src/*`, `native/{roslyn-worker,python-worker,go-worker,rust-worker}/PROTOCOL.md` (TS v2.1 §6, §7, §8, §9, §15, §23 · `ADR-004` · `ADR-010` · `K-018`..`K-024`).

Causoryn combines analyses of **TypeScript / JavaScript**, **C# (.NET / Roslyn)**, **Python**, **Go**, and **Rust** in a single **Unified Evidence & Knowledge Graph**. Analyzers derive results from syntax, symbols, and supported framework rules without making model calls (`ADR-002`). `verified` edges require source evidence, and other matches carry their resolution status explicitly (`ADR-004`, `ADR-010`, `K-018`).

Polyglot indexing merges pathless external or virtual nodes that share an ID across analyzers into a canonical record. File-bound collisions surface as errors (`packages/indexing/src/index-service.ts`). Equivalent analysis depends on equivalent analyzer and toolchain conditions as well as file inputs and effective configuration. Missing runtimes, changed reference packs, or timeouts can change coverage and diagnostics.

---

## 1. 5-Language Capability Matrix (`INDEXED_ADAPTERS`)

Published by `causoryn_get_capabilities` directly from `INDEXED_ADAPTERS` (`packages/indexing/src/index.ts`):

| Language | `analyzerId` (`version`) | Execution Model | `astParse` (`L1`) | `symbolResolution` (`L2`) | `frameworkLinkers` / Routes & Tests (`L3`) | Emitted Edge Kinds |
|---|---|---|---|---|---|---|
| **TypeScript / JavaScript** | `ts-adapter` (`0.1.0`) | In-process (`adapters/typescript`, TS Compiler API `5.9.3`; `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`, `allowJs: true`, `checkJs: false`, `jsx: Preserve`, confined `tsconfig.json`/`jsconfig.json`) | `L1` | `L2` (full `TypeChecker` semantic resolution; ESM + CommonJS `require`/`exports`/`module.exports`) | `express+nextjs` (TS/JS/CJS) + generic `<x>.<verb>` routes + BDD `Test` nodes & `TESTS` edges | `CONTAINS`, `IMPORTS`, `CALLS`, `ROUTES_TO`, `TESTS` |
| **C# / .NET** | `roslyn-worker` (`0.1.0`) | Sidecar (`adapters/csharp-roslyn` ↔ `native/roslyn-worker`) | `L1` | `L2` (Roslyn `SemanticModel` — full semantic sidecar) | `aspnet-core-route-attributes (L3)` (Controller `[Route]`/`[Http*]` + Minimal API `MapGet`/…) | `CONTAINS`, `CALLS`, `ROUTES_TO` (`importEdges: false`) |
| **Python** | `python-worker` (`0.1.0`) | Sidecar (`adapters/python` ↔ `native/python-worker/worker.py`) | `L1` | `L2` (AST lexical/class scope; no full type inference) | `decorator-route-pattern (L3)` (FastAPI/Starlette `@app.get`/… + Flask `@app.route`) | `CONTAINS`, `CALLS`, `ROUTES_TO` (`importEdges: false`) |
| **Go** | `go-worker` (`0.1.0`) | Sidecar (`adapters/go` ↔ `native/go-worker/cmd/worker`) | `L1` | `heuristic-only (semantik L2 yok)` (`symbolResolution: false`) | `http-router-registration (L3)` (`net/http` `Handle`/`HandleFunc` + `gin`/`echo`/`chi`) | `CONTAINS`, `CALLS`, `ROUTES_TO` (`importEdges: false`) |
| **Rust** | `rust-worker` (`0.1.0`) | Sidecar (`adapters/rust` ↔ `native/rust-worker`) | `L1` | `heuristic-heavy` (`syn 3.0.10` AST + deterministic symbol table) | `attribute-macro-route (L3)` (Actix-Web / Axum / Rocket HTTP verb macros) | `CONTAINS`, `CALLS`, `ROUTES_TO` (`importEdges: false`) |

### Capability Tiers (`L0` – `L3`) & Envelope `coverage.tier`

- **`L0` (Inventory & File Provenance):** Every policy-admitted file produces a `File` node carrying a UTF-8 SHA-256 `sourceHash` and a `verified` `Workspace → File` `CONTAINS` edge.
- **`L1` (AST & Declarations):** Extracts `Class`, `Interface` (interfaces/traits), `Type` (structs/enums/type aliases), `Function`, and `Method` declarations with structural `CONTAINS` edges.
- **`L2` (Symbol & Call Resolution):** Resolves `CALLS` (and `IMPORTS` in TypeScript) to in-workspace symbols or explicit `UnknownExternal` nodes.
- **`L3` (Framework Routes & Test Links):** Extracts HTTP `Endpoint` nodes, `Endpoint → Handler` (`ROUTES_TO`) edges, and TypeScript BDD `Test → Target` (`TESTS`) edges.
- **Envelope `coverage.tier` computation (`coverageOf`):** Reports `L2` when the snapshot contains TS, JS, C#, or Python AST/symbol nodes, `L1` when only Go or Rust AST/symbol nodes are present, and `L0` when only inventory `File` nodes exist.
- **Synchronous startup vs asynchronous refresh:** The synchronous startup bridge (`runIndex`) never spawns child processes — TypeScript and JavaScript run in-process at full L1–L3 depth while sidecar files initially appear as `L0` `File` nodes (`sync-run-degraded` + explicit warning). Invoking `causoryn_refresh_index` (`runIndexAsync` / `runIncrementalIndexAsync`) executes all 5 language adapters and merges their outputs into a single unified snapshot.

---

## 2. TypeScript / JavaScript Universal Analysis, `tsconfig.json` / `jsconfig.json` & Non-Blocking Inventory

### 2.1 TypeScript, JavaScript & CommonJS (`ts-adapter`)

`adapters/typescript` analyzes both TypeScript and JavaScript repositories inside the same in-process TypeScript Compiler API (`5.9.3`) engine:

- **Full extension coverage & language tagging:** `.ts`, `.tsx`, `.mts`, `.cts` files are classified as `language: "typescript"`, while `.js`, `.jsx`, `.mjs`, `.cjs` files are classified as `language: "javascript"`. The compiler runs with `allowJs: true`, `checkJs: false`, and `jsx: Preserve`, extracting AST declarations, symbols, and call graphs cleanly without emitting false type-checking noise on untyped JavaScript.
- **ESM + CommonJS extraction:** Alongside standard ES modules (`import`/`export`), literal `require("./module")` calls emit `IMPORTS` edges and top-level `exports.<fn> = ...`, `module.exports.<fn> = ...`, and `module.exports = function <name>(...)` assignments materialize exported function/symbol nodes.
- **JS/CJS Express & Next.js App Router linkers:** The Express linker tracks both ESM `import express from "express"` and CommonJS `const express = require("express")` / `express.Router()` / `Router()` bindings to emit `Endpoint → Handler` (`ROUTES_TO`) edges; the Next.js App Router linker covers `app/**/route.{ts,tsx,js,jsx,mjs,cjs}` and `page.{ts,tsx,js,jsx}`.

### 2.2 Confined `tsconfig.json` / `jsconfig.json` Loader (`tsconfig-loader.ts`)

`adapters/typescript/src/tsconfig-loader.ts` resolves path aliases and compiler settings in real-world monorepo and application codebases within strict security boundaries (`ADR-008`, `CWE-22`, `CWE-59`):

- **Supported options & JSONC parsing:** Parses JSONC (comments and trailing commas) via `ts.parseConfigFileTextToJson` with zero `eval` or plugin execution, extracting only safe `compilerOptions` (`baseUrl`, `paths` such as `@/*` and `~/*` up to 200 entries, `moduleResolution`, `module`, `target`, `jsx`, `experimentalDecorators`, `verbatimModuleSyntax`). When `baseUrl` or `paths` is present without an explicit `moduleResolution`, Causoryn selects `Bundler`; otherwise `NodeNext`. Prototype-pollution keys (`__proto__`, `constructor`, `prototype`) are rejected.
- **Root-confined `extends` & nested monorepo configs:** Supports up to 64 directory-scoped configs (`ScopedTsConfig`). `extends` chains stay strictly confined inside the workspace root (depth ≤ 5, ≤ 16 entries per file, global visit budget of 128, cycle detection).
- **Confined compiler host (`configureConfinedCompilerHost`):** Closes `ts.sys` host-filesystem escape. Disk reads are strictly restricted to (a) in-memory `WorkspaceAccessPolicy`-approved `entries`, (b) bundled `lib*.d.ts` declarations (`CAUSORYN_TS_LIB_DIR`), and (c) `.d.ts`/`.d.mts`/`.d.cts`/`package.json` files inside in-root `node_modules`.
- **TOCTOU-safe disk fallback & incremental cache invalidation:** Disk fallback enforces `lstatSync` + `realpathSync` + `openSync(O_RDONLY | O_NOFOLLOW)` + `fstatSync` (`dev`, `ino`, and size ≤ 256 KB verification). `isIndexRelevantFile` in `packages/indexing/src/index-service.ts` automatically invalidates the incremental index cache whenever `tsconfig.json` or `jsconfig.json` is edited or deleted.

### 2.3 Non-Blocking `collectInventoryAsync` & Smart Ignore Engine

- **Event-loop-friendly scanning (`collectInventoryAsync`):** `collectInventoryAsync` in `packages/indexing/src/inventory.ts` yields to the Node.js event loop (`setImmediate`) every 64 processed entries (`yieldEvery = 64`) while producing a byte-identical sorted `InventoryEntry[]` to synchronous `collectInventory`, preventing background indexing from starving MCP requests on large repositories.
- **Smart `.gitignore` + `.git/info/exclude` + nested `.gitignore` & smart `bin/`:** `packages/mcp-server/src/workspace-ignore-discovery.ts` merges root `.gitignore`, non-symlink `.git/info/exclude`, and budget-bounded nested `.gitignore` rules; when `ignore` is not explicitly overridden, it refines blunt `**/bin/**` into `.NET`-specific output patterns (`**/bin/{Debug,Release,x64,x86,AnyCPU}/**` plus `<projDir>/bin/**` for detected `.csproj`/`.fsproj`/`.vbproj` projects) so Node `bin/*.ts|js` and Rust `src/bin/*.rs` remain indexed.
- **Polynomial zero-RegExp matcher (`ignore-matcher.ts`):** `packages/workspace/src/ignore-matcher.ts` uses a two-pointer polynomial-time glob matcher with zero `RegExp` execution, structurally eliminating ReDoS backtracking.

---

## 3. Honest Edge Resolution Discipline (`K-018`, `ADR-004`, `ADR-010`)

No analyzer in Causoryn ever guesses a plausible target symbol as `verified`, and no worker ever generates node/edge IDs (all canonical SHA-256 IDs are computed centrally by `packages/domain` during `createSnapshot`).

1. **`verified`:** Proven statically by a compiler semantic model or direct syntactic attachment. Every `verified` edge **must** carry ≥1 `Evidence` item (`relativePath`, 1-based `startLine`/`endLine`, `sourceHash`, `analyzerId`, `analyzerVersion`, `rationale`); violations are rejected across domain constructors, Zod schemas, and SQLite repository invariants.
2. **`heuristic` (+ `ambiguity`):** Backed by deterministic lexical/import/unique-method rules without full static type proof; carries `ambiguity: { candidates: [...], reason: "..." }`.
3. **`unresolved` (`UnknownExternal`):** Unresolvable expressions, dynamic dispatch, or unindexed external calls materialize an explicit `UnknownExternal` target node — guaranteeing **zero dangling edges** and **zero fabricated targets**.

### 3.1 Per-Language `CALLS` Resolution Rules

| Language | `verified` Condition | `heuristic` (+ `ambiguity`) Condition | `unresolved` (`UnknownExternal`) Condition |
|---|---|---|---|
| **TypeScript / JavaScript** | `TypeChecker` resolves the call/constructor signature to an analyzed symbol (or an external `lib*.d.ts` / `node_modules` declaration represented as `UnknownExternal`), across ESM and CommonJS `require`/`exports`. | Relative module candidate or `node:*` builtin module match on `IMPORTS` edges. | `TypeChecker` cannot resolve any symbol (`any`/dynamic receiver → `UnknownExternal`). |
| **C# (Roslyn)** | Roslyn `SemanticModel` resolves the target method/constructor (in-set or external BCL/NuGet `UnknownExternal`). | Well-known name fallback when reference assemblies are absent. | Overload ambiguity, error symbols, or dynamic/reflection calls. |
| **Python** | Target is defined in the **same module**: module-level `def`/class, `self.<method>`, or `SameModuleClass.<method>`. | Target is an imported symbol (`import` / `from ... import`, in-set or external — Python bindings are dynamic and no full type inference runs). | Calls on local variables/parameters, builtins (`len`, `list`), or undefined identifiers. |
| **Go** | Bare identifier call matching a top-level `func` in the **same package** *(local variable shadowing cannot be distinguished from AST alone — documented boundary)*. *(Go builtins such as `len`/`make` emit no edge.)* | In-set `pkg.Func` call, external imported package selector, unique method name across the analyzed set (`x.M()`), or interface method match. | Multi-candidate ambiguous `x.M()` (with candidate list) or unknown identifier/selector. |
| **Rust** | (a) Bare `fn` call defined in the same file/module; (b) qualified path (`A::b`, `mod::A::b`) with a **single** match in the analyzed symbol table *(leading module segments are not semantically resolved — documented)*. | Receiver method call (`x.foo()`, no trait dispatch), cross-file bare call with single candidate, or multi-candidate qualified path. | Zero candidates in analyzed sources (`std::env::var`, `Vec::new`, etc.). |

### 3.2 Per-Language `ROUTES_TO` & `TESTS` Rules

`ROUTES_TO` edges are **not** uniformly `verified` across all five languages — each analyzer assigns the exact resolution warranted by its static proof:

- **TypeScript / JavaScript (`verified`):**
  - Generic `<receiver>.<verb>("/path", handler)` calls (`get`, `post`, `put`, `patch`, `delete`, `head`, `options`).
  - **Express linker (`express`):** Tracks intra-file ESM/CJS `express()`, `express.Router()`, and named `Router()` bindings (`framework: "express"`). *(Cross-file imported Express instances still emit generic routes without the framework attribute.)*
  - **Next.js App Router linker (`nextjs`):** Resolves exported HTTP verb handlers in `app/**/route.{ts,tsx,js,jsx,mjs,cjs}` / `src/app/**/route.{ts,tsx,js,jsx,mjs,cjs}` and named `default export` components in `page.{ts,tsx,js,jsx}` via `TypeChecker`. Anonymous default exports or unrecognized files never invent symbols; they record `FRAMEWORK_PATTERN_UNKNOWN` diagnostics.
- **Python (`verified`):** FastAPI/Starlette `@carrier.get("/path")` verb decorators and Flask `@carrier.route("/path", methods=[...])` decorators are syntactically attached to the decorated `def`/`async def`, always emitting `verified` (`route-attribute`) edges. Non-literal route paths or complex subscripted carriers emit explicit `warnings` rather than failing silently.
- **Rust (`verified`):** Actix-Web, Axum, and Rocket attribute macros (`#[get("/path")]`, `#[post("/path")]`, etc.) attach directly to the target `fn` item, always emitting `verified` (`route-attribute`) edges.
- **C# ASP.NET Core (`verified` or `heuristic`):** Controller `[Route]` + `[HttpGet]`/`[HttpPost]`/… attributes and Minimal API `MapGet`/`MapPost`/… calls (`WorkerAnalyzer.cs:1475-1508`) emit `verified` when Roslyn resolves the attribute/extension types to `Microsoft.AspNetCore.*`. When `Microsoft.AspNetCore.App.Ref` is unavailable on the host machine, they degrade honestly to **`heuristic` (+ `ambiguity`)** via the well-known-name rule.
- **Go (`verified`, `heuristic`, or `unresolved`):** Across `net/http` (`Handle`, `HandleFunc` with method `"*"`) and `gin`/`echo`/`chi` verb registrations (`routes.go:120-170`), a same-package named handler function emits `verified`, a selector handler expression emits **`heuristic` or `unresolved`**, an unknown bare handler emits **`unresolved` (`UnknownExternal`)**, and an inline anonymous `func` literal preserves the `Endpoint` node without emitting a `ROUTES_TO` edge (recording an explicit warning).
- **BDD Test Extraction (`Test` & `TESTS`):** The TypeScript analyzer extracts BDD test blocks as `Test` nodes and emits `verified` `TESTS` edges whenever a `Test` body calls a non-`Test` workspace symbol (`adapters/typescript/src/analyzer.ts`), powering the `direct` signal in `causoryn_derive_test_plan`. Sidecar `TESTS` edge extraction for C#, Python, Go, and Rust remains tracked as an open item in `0.2.3`.

---

## 4. `@causoryn/sidecar-ipc` NDJSON Protocol (v1) & Process Isolation

All four sidecar adapters (`csharp-roslyn`, `python`, `go`, `rust`) share the zero-dependency `@causoryn/sidecar-ipc` process runner:

- **Fresh process per request:** Causoryn spawns a clean short-lived worker per `analyze` run — eliminating cross-request state leakage — and terminates it as soon as the first complete JSON response line is parsed.
- **Shell-free fixed command execution (`shell: false`):** File paths and source contents are **never** interpolated into command-line arguments; payloads travel exclusively over `stdin` as single-line UTF-8 JSON (`type: "analyze"`, `protocolVersion: "1"`).
- **Minimal allowlisted environment (`buildAllowlistedWorkerEnv`):** Parent secrets, cloud credentials, and API keys are never inherited by worker processes. Only minimal toolchain variables (`PATH`, `HOME`/`USERPROFILE`, `TEMP`/`TMP`, `DOTNET_ROOT`, `GOPATH`/`GOCACHE`, `CARGO_HOME`/`RUSTUP_HOME`, etc.) are forwarded. The Python adapter intentionally omits `PYTHONPATH` for determinism and pins `PYTHONIOENCODING=utf-8`.
- **Process-tree termination & `stdin` `EPIPE` safety:** Early worker exits cannot crash the MCP server via unhandled `EPIPE` errors. On timeout, `onKillChild` terminates the worker; on Windows, `go run` and `cargo build` grandchild processes (`worker.exe`, `rustc.exe`) are cleaned up via literal `taskkill /pid <pid> /T /F`.

### Protocol Resource Quotas & Timeouts (`PROTOCOL.md` v1)

| Quota / Parameter | Limit | Enforcement Behavior |
|---|---|---|
| `MaxRequestLine` (`MaxRequestLineBytes` / `MaxRequestLineChars`) | **64 MB** (`64,000,000` / `64 MiB`) | Oversized input line is discarded through `\n`; worker replies with `id: null` + `LIMIT_EXCEEDED` and stays alive. |
| `MaxFileCount` | **5,000** files / request | Request rejected with `LIMIT_EXCEEDED`. |
| `MaxFileContentBytes` | **2,000,000** bytes (2 MB) / file | Aligned with default `CAUSORYN_CONFIG.maxFileBytes`; rejected with `LIMIT_EXCEEDED`. |
| `MaxResponseNodes` (`maxNodes`) | **250,000** nodes / response (`1..250000`) | Excess nodes and any edges incident to omitted nodes are dropped (zero dangling edges), emitting `RESPONSE_TRUNCATED` + `status: "partial"`. |
| `responseMaxChars` & `stderrMaxChars` (`sidecar-ipc`) | **64 MiB** (`67,108,864` chars) | Exceeding the stdout line or stderr buffer ceiling kills the worker and triggers graceful `L0`/`L1` fallback. |
| Request / Build Timeouts | **30 s** (C#, Python, Rust analyze) · **120 s** (Go `go run`) · **600 s** (Rust cold `cargo build`) | Kills the process tree on timeout and degrades that language to `L0`/`L1` fallback. |

### Graceful `L0`/`L1` Fallback

When an optional toolchain (`dotnet`, `python`, `go`, `cargo`) is absent, crashes, or times out, the server **never crashes**:
- Affected files remain in the published snapshot as `sourceHash`-evidenced `File` nodes (`WORKER_UNAVAILABLE_CAPABILITIES`).
- Snapshot state becomes `partial`, adapter `coverageRatio` reports `0`, and `warnings` records the exact fallback reason (inspectable anytime via `npx causoryn@latest doctor`).

---

## 5. Runtime, Compilation & Offline Requirements Matrix

| Component / Analyzer | Runtime Requirement | Compilation Model | Network / Offline Behavior |
|---|---|---|---|
| **TypeScript / JavaScript + Core SQLite** | **Node.js >= 24** | Zero-compile (`dist/mcp-server.mjs` + N-API v10 `better-sqlite3` prebuilds + bundled `dist/typescript-lib/lib*.d.ts`) | Local operation after setup |
| **C# / Roslyn** (`roslyn-worker`) | **.NET 10 runtime** (`dotnet exec`) | Precompiled deterministic Release `Causoryn.RoslynWorker.dll` (`Microsoft.CodeAnalysis.CSharp` `5.12.0`, zero `.pdb` or `.resources.dll` files) | Local operation after setup |
| **Python** (`python-worker`) | **Python 3.10+** (recommended / CI: **Python 3.11+ / 3.12**) | Zero-compile (`python -B worker.py`, pure stdlib `ast`, zero pip packages, zero `__pycache__` writes) | Local operation after setup |
| **Go** (`go-worker`) | **Go 1.22+** | On-demand local `go run ./cmd/worker` (cached in `GOCACHE`) or prebuilt `CAUSORYN_GO_WORKER_BIN` (pure stdlib `go/parser`; zero external modules in `go.mod`) | Local operation after setup |
| **Rust** (`rust-worker`) | **Rust / Cargo** (`edition = 2021`) | On-demand `cargo build --locked` into `~/.causoryn/cache/rust-worker-target` (or `CAUSORYN_RUST_TARGET_DIR`) | The first build may need network access to fetch uncached `Cargo.lock` dependencies (`syn 3`, `serde_json`, `proc-macro2`, etc.). A prebuilt worker binary runs locally. |

---

## 6. `fp2` `analyzerFingerprint` Cache Invalidation & Internal `0.1.0` Protocol Versions

### 6.1 Deterministic `fp2` Fingerprint Schema

To prevent persistent SQLite snapshots from serving stale results across toolchain or reference-pack changes, `packages/indexing/src/fingerprint.ts` computes the positional `fp2` fingerprint:

```text
fp2|ts-adapter@0.1.0|roslyn-worker@0.1.0|refpack=<pack>@<version>@<tfmDir>;...|refsrc=<source>|opts=<sha256-16>
   [|python-worker@0.1.0|pystate=<status>|pyopts=<sha256-16>]
   [|go-worker@0.1.0|gostate=<status>|goopts=<sha256-16>]
   [|rust-worker@0.1.0|ruststate=<status>|rustopts=<sha256-16>]
```

- **Conditional language blocks:** Python, Go, and Rust blocks are omitted entirely when the workspace contains zero files for that language, preserving bit-identical fingerprints for TS/C# repositories.
- **Reference-pack & runtime-state fidelity:** C# records the exact loaded `.NET` / `ASP.NET Core` reference packs (`refpack=...`, `fallback-corelib`, or `unavailable`) and discovery source (`env-dotnet-root`, `worker-discovered`, `worker-unavailable`, `sync-run-degraded`); Python, Go, and Rust record `WorkerRunStatus` (`ready`, `worker-unavailable`, `sync-run-degraded`) plus the first 16 hex chars of the canonical-JSON SHA-256 of effective adapter options (`opts`).
- **Automatic cache invalidation:** Because `snapshotId = SHA-256(canonicalJson([workspaceId, revision.id, revision.sequence, configHash, analyzerFingerprint, contentHash]))`, installing a previously missing toolchain (`worker-unavailable` → `ready`) or upgrading `.NET` reference packs changes `analyzerFingerprint` and automatically triggers a fresh snapshot build (`matchesPublishedSnapshotInputs`).

### 6.2 Why Internal Analyzer Protocol Versions Remain `0.1.0`

While the distribution package (`causoryn`), MCP server (`SERVER_VERSION`), and indexing coordinator (`INDEXING_VERSION`) are at `0.2.3`, all five internal analyzer versions (`ts-adapter@0.1.0`, `roslyn-worker@0.1.0`, `python-worker@0.1.0`, `go-worker@0.1.0`, `rust-worker@0.1.0`, `Causoryn.RoslynWorker.csproj`, and `native/rust-worker/Cargo.toml`) intentionally remain pinned to **`0.1.0`**:

1. `analyzerVersion` is hashed directly into every `Evidence` record (`evidenceId`) and embedded in `fp2` `analyzerFingerprint`.
2. Bumping `analyzerVersion` on packaging-only releases when AST/semantic extraction semantics and NDJSON `protocolVersion: "1"` have not changed would needlessly invalidate every persisted SQLite graph cache and churn evidence hashes.
3. Internal analyzer versions therefore version **analyzer extraction semantics**, independently of the `causoryn` `0.2.3` package release.

---

## Related Documentation

- [Documentation Hub](README.md) · [Architecture Overview](architecture.md)
- [CLI & Configuration Reference](cli-and-configuration.md) · [MCP Tool Contracts](tool-contracts.md)
- [ADR-002: No-LLM Strict Boundary](adr/ADR-002-no-llm.md) · [Security Audit](security-pass.md) · [Benchmarks](benchmarks.md)
