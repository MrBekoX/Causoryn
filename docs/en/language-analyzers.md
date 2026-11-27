# 5-Language Analyzers, Honest Resolution Discipline & Sidecar Protocol

> **Language:** [Türkçe](../language-analyzers.md) | **English** · [Documentation Hub](README.md)
>
> **Status:** reflects Causoryn 0.3.2 (pre-1.0). Internal analyzer versions remain `0.1.0` (see §6).
>
> **Source modules:** `packages/indexing/src/{index.ts,index-service.ts,job-manager.ts,inventory.ts,fingerprint.ts}`, `packages/workspace/src/ignore-matcher.ts`, `packages/mcp-server/src/{services.ts,workspace-ignore-discovery.ts}`, `packages/sidecar-ipc/src/index.ts`, `adapters/typescript/src/{analyzer.ts,tsconfig-loader.ts}`, `adapters/{csharp-roslyn,python,go,rust}/src/*`, `native/{roslyn-worker,python-worker,go-worker,rust-worker}`.

Causoryn combines analyses of **TypeScript / JavaScript**, **C# (.NET / Roslyn)**, **Python**, **Go**, and **Rust** in one Unified Evidence & Knowledge Graph. Analyzers derive results from syntax, symbols, and supported framework rules without any model call. Every `verified` edge carries source evidence; every other match states its resolution (`heuristic` with `ambiguity`, or `unresolved`) explicitly. Each MCP envelope reports per-language fidelity in `coverage.byLanguage`, so strong TypeScript coverage never hides an L0 fallback in another language.

Polyglot indexing merges pathless external or virtual nodes that share an ID across analyzers (for example `UnknownExternal`) into one canonical record; identity collisions between file-bound nodes are reported as errors (`packages/indexing/src/index-service.ts`). Equal results require equal inputs: file contents, effective configuration, and the same analyzer and toolchain conditions. A missing runtime, a changed reference pack, or a timeout can change coverage and diagnostics.

---

## 1. Capability Matrix (`INDEXED_ADAPTERS`)

`causoryn_status` (`action: "inspect"`; in the `full` profile also `causoryn_get_capabilities`) publishes this table directly from `INDEXED_ADAPTERS` (`packages/indexing/src/index.ts`):

| Language | `analyzerId` (`version`) | Execution model | `astParse` | `symbolResolution` | `frameworkLinkers` (routes & tests) | Emitted edge kinds |
|---|---|---|---|---|---|---|
| **TypeScript / JavaScript** | `ts-adapter` (`0.1.0`) | In-process TypeScript Compiler API `5.9.3` (`.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`; `allowJs: true`, `checkJs: false`, `jsx: Preserve`) | `L1` | `L2` (`TypeChecker`; ESM + CommonJS; CHA) | `express+nextjs` + generic `<x>.<verb>` routes + BDD `Test` nodes / `TESTS` edges | `CONTAINS`, `IMPORTS`, `CALLS`, `INHERITS`, `IMPLEMENTS`, `ROUTES_TO`, `TESTS` |
| **C# / .NET** | `roslyn-worker` (`0.1.0`) | Sidecar: `adapters/csharp-roslyn` ↔ `native/roslyn-worker` (`dotnet exec`) | `L1` | `L2` (Roslyn `SemanticModel`; CHA) | `aspnet-core-route-attributes (L3)` (controller `[Route]`/`[Http*]` + Minimal API `MapGet`/…) | `CONTAINS`, `CALLS`, `INHERITS`, `IMPLEMENTS`, `ROUTES_TO` (`importEdges: false`) |
| **Python** | `python-worker` (`0.1.0`) | Sidecar: `adapters/python` ↔ `native/python-worker/worker.py` | `L1` | `L2` (lexical/class scope; no type inference) | `decorator-route-pattern (L3)` (FastAPI/Starlette `@app.get`/… + Flask `@app.route`) | `CONTAINS`, `CALLS`, `ROUTES_TO` (`importEdges: false`) |
| **Go** | `go-worker` (`0.1.0`) | Sidecar: `adapters/go` ↔ `native/go-worker/cmd/worker` | `L1` | `heuristic-only (no semantic L2)` (`symbolResolution: false`, no `go/types`) | `http-router-registration (L3)` (`net/http` `Handle`/`HandleFunc` + gin/echo/chi) | `CONTAINS`, `CALLS`, `ROUTES_TO` (`importEdges: false`) |
| **Rust** | `rust-worker` (`0.1.0`) | Sidecar: `adapters/rust` ↔ `native/rust-worker` | `L1` | `heuristic-heavy` (`syn` 3 AST + symbol table) | `attribute-macro-route (L3)` (Actix-Web / Axum / Rocket verb macros) | `CONTAINS`, `CALLS`, `ROUTES_TO` (`importEdges: false`) |

The Go label `heuristic-only (no semantic L2)` is the literal runtime string.

### Capability Tiers and Envelope Coverage

- **`L0` (inventory & file provenance):** every policy-admitted file becomes a `File` node with a UTF-8 SHA-256 `sourceHash` and a `verified` `Workspace → File` `CONTAINS` edge.
- **`L1` (AST & declarations):** `Class`, `Interface` (interfaces/traits), `Type` (structs/enums/aliases), `Function`, and `Method` declarations with structural `CONTAINS` edges.
- **`L2` (symbol, hierarchy & call resolution):** `CALLS`, `IMPORTS` (TS/JS), and class-hierarchy `INHERITS`/`IMPLEMENTS` (TS/JS and C#) resolved to in-workspace symbols or explicit `UnknownExternal` nodes.
- **`L3` (framework routes & test links):** HTTP `Endpoint` nodes, `Endpoint → Handler` `ROUTES_TO` edges, and TS/JS BDD `Test → Target` `TESTS` edges.
- **`coverage.tier` (`coverageOf`, `packages/mcp-server/src/services.ts`):** `L2` when the snapshot contains AST/symbol nodes in TypeScript, JavaScript, C#, or Python; `L1` when only Go or Rust AST/symbol nodes exist; `L0` when only inventory `File` nodes exist. `coverage.coverageRatio` is `(verified + heuristic) / totalEdges`.
- **`coverage.byLanguage`:** per language (sorted keys) `{ tier, files, verifiedEdges, heuristicEdges, unresolvedEdges, coverageRatio }`; a language with files but no AST/symbol nodes reports `L0`.
- **C# project model:** each `.csproj` (and the nearest `Directory.Build.props`, read read-only and never above the workspace root) becomes its own Roslyn compilation with its `ProjectReference` closure. SDK implicit global usings (`<ImplicitUsings>enable</ImplicitUsings>` for `Microsoft.NET.Sdk`, `.Web`, `.Worker` and the Windows desktop SDKs, per the Microsoft Learn table) and `<Using Include/Remove/Alias/Static>` items are applied in MSBuild import order. Not evaluated, with an explicit warning: most MSBuild conditions, `$(...)` properties, `<Choose>`, `<Import>`, `Directory.Build.targets`, and SDKs outside that table (for example Razor, BlazorWebAssembly, MSTest). Sources outside every project share one fallback compilation. A project keeps at most 512 global usings (SDK defaults first) and 512 `ProjectReference`s, with a warning past either cap, so an oversized project no longer makes the worker reject the whole request. A global using that cannot be one (not a dotted C# name, an alias that is not one identifier, static together with an alias, or characters outside the Basic Multilingual Plane, which C# identifiers cannot contain) is dropped with a warning; the request is not rejected.
- **Node locations:** symbol nodes in every language carry their real 1-based declaration span (TypeScript/JavaScript from the compiler; C#, Python, Go and Rust from the workers' optional `span` node field, validated by the adapter — a span that is not inside the analyzed file is dropped with a warning and the node keeps its file anchor). A symbol declared several times (overloads, `partial` classes, property getter/setter, two Go `init` functions, one Rust method name in two `impl` blocks) is widened to cover every declaration. Rust spans start at the doc comment or attribute, like the syn evidence spans. File, Endpoint and UnknownExternal nodes keep the file anchor (`startLine = endLine = 1`).
- **Synchronous bridge vs full pipeline:** the synchronous `runIndex` bridge (used only for programmatic, non-deferred startup) never spawns sidecars: TS/JS run at full depth, while `.cs`/`.py`/`.go`/`.rs` files appear as `L0` `File` nodes with a `sync-run-degraded` fingerprint state and an explicit warning. The stdio server defers startup and runs the full asynchronous pipeline (`runIndexAsync` / `runIncrementalIndexAsync`) in the background, which executes all five adapters and merges them into one snapshot.

---

## 2. TypeScript / JavaScript, Configuration Loading & Inventory

### 2.1 TypeScript, JavaScript, CommonJS & Monorepo Workspaces (`ts-adapter`)

- **Extensions and language tags:** `.ts`, `.tsx`, `.mts`, `.cts` → `language: "typescript"`; `.js`, `.jsx`, `.mjs`, `.cjs` → `language: "javascript"`. `checkJs: false` keeps untyped JavaScript free of type-checking noise.
- **Per-file module format:** each file is treated as ESM or CommonJS the way TypeScript decides it (`impliedNodeFormat`): by extension (`.mts`/`.mjs` ESM, `.cts`/`.cjs` CommonJS) and otherwise by the `type` field of the nearest in-root `package.json`. The confined compiler host exposes only that field of each workspace manifest, so `"type": "module"` packages no longer get false `TS1470` diagnostics for `import.meta`.
- **Declaration spans:** symbol nodes (`Function`, `Method`, `Class`, `Interface`, `Type`, `Handler`, …) carry their real declaration span (1-based `startLine`/`endLine`), so `location` points at the declaration rather than at the top of the file.
- **ESM + CommonJS:** alongside `import`/`export`, a literal `require("./module")` emits an `IMPORTS` edge, and top-level `exports.<fn> = …`, `module.exports.<fn> = …`, and `module.exports = function <name>(…)` produce exported function nodes.
- **Monorepo workspaces:** in-root `package.json` manifests (`name`, `exports`, `types`, `main`, `workspaces`; up to 256 manifests, scan depth 4) let workspace package imports such as `@scope/pkg` and subpath exports resolve to in-memory workspace sources. Symlinks that escape the root are rejected. The root `workspaces` include and exclude patterns are de-duplicated and capped at 256 (warning past the cap), pattern expansion stops once 256 manifest candidates are found, and one discovery run lists at most 2,048 distinct directories (one warning when the budget is spent).
- **Class Hierarchy Analysis:** `TypeChecker`-resolved `INHERITS` (`class A extends B`, `interface X extends Y`) and `IMPLEMENTS` (`class A implements C`) edges; impact analysis and `causoryn_preflight_change` follow them.
- **Incremental reuse:** incremental runs pass the previous `ts.Program` as `oldProgram` and combine it with the `file_facts` early-cutoff cache (see [Architecture Overview](architecture.md)).
- **Input bounds:** every program source file (bundled `lib*.d.ts` files excepted) is screened with an iterative nesting check before the parser, binder and checker see it. A file nested deeper than `MAX_SYNTAX_NESTING_DEPTH` (500 levels of what TypeScript handles recursively: among binary operators only `&&`, `||`, `??`, their assignment forms and destructuring assignments count, while comma, plain assignment, exponent, arithmetic, bitwise and comparison chains do not, so the `exports.a = exports.b = … = void 0` header of tsc/Babel CommonJS output is analysed normally; member and call chains and other nesting still count), or one whose parse overflows the stack, reaches the program as an empty module and is indexed at file level only, with an `ADAPTER_LIMIT` diagnostic (also on incremental runs); such a declaration file outside the analyzed sources only gets a warning. If creating the type checker still throws, every source is indexed at file level with an `ADAPTER_INTERNAL` diagnostic instead of the run failing. Qualified names longer than 512 characters (`MAX_QUALIFIED_NAME_CHARS`; File nodes excepted) are cut to a 200-character head plus `...<N chars, sha256 <16 hex>>`; shorter names, and therefore existing outputs, are unchanged. The analysis phases that walk whole files (calls and routes, heritage clauses, Express detection and route collection, `describe` / `it` test extraction) use an explicit stack, so long chains cannot overflow a phase either; a test file with a very long comma or assignment chain keeps its `Test` nodes whatever the stack size of the thread it is analysed on.

### 2.2 Confined `tsconfig.json` / `jsconfig.json` Loader (`tsconfig-loader.ts`)

- **Parsing:** JSONC (comments, trailing commas) via `ts.parseConfigFileTextToJson`, with no `eval` and no plugin execution. Only safe `compilerOptions` are read (`baseUrl`, `paths` up to 200 entries, `moduleResolution`, `module`, `target`, `jsx`, `experimentalDecorators`, `verbatimModuleSyntax`). When `baseUrl` or `paths` is present without an explicit `moduleResolution`, `Bundler` is selected; otherwise `NodeNext`. Keys `__proto__`, `constructor`, and `prototype` are rejected. Config files are capped at 256 KiB.
- **Root-confined `extends`:** up to 64 directory-scoped configs; `extends` chains stay inside the workspace root (depth ≤ 5, ≤ 16 entries per file, 128 total resolve visits, cycle detection).
- **`paths` alias probing:** in-memory alias targets are probed at most 64 per module specifier and 50,000 per analysis run (`MAX_VIRTUAL_ALIAS_PROBES_PER_SPECIFIER`, `MAX_VIRTUAL_ALIAS_PROBES_PER_RUN`); outcomes are memoized per (scoped config, specifier), and module resolution is memoized per (containing file, specifier), so the program hook and the `IMPORTS` phase do not resolve each pair twice. A spent budget leaves the import unresolved and records one warning; the analysis continues. Incremental runs reuse the previous program's ASTs but not its module resolutions, which are replayed from this run's memo in program order, so the budget is spent in the same order as on a full run and both produce the same `IMPORTS` when it runs out.
- **Confined compiler host (`configureConfinedCompilerHost`):** compiler and module-resolution reads are limited to (a) policy-approved workspace entries, (b) bundled `lib*.d.ts` declarations, and (c) `.d.ts`/`.d.mts`/`.d.cts`/`package.json` files inside in-root `node_modules`. Disk fallback uses `lstat` + `realpath` + `O_NOFOLLOW` open + `fstat` (`dev`, `ino`, size) identity checks.
- **Cache invalidation:** editing or deleting `tsconfig.json`, `jsconfig.json`, `go.mod`, or a workspace `package.json` marks the change as index-relevant and invalidates cached facts.

### 2.3 Non-Blocking `collectInventoryAsync` & Ignore Engine

- **`collectInventoryAsync`** (`packages/indexing/src/inventory.ts`) yields to the event loop (`setImmediate`) every 64 entries (`yieldEvery = 64`) and produces the same sorted `InventoryEntry[]` as the synchronous `collectInventory`.
- **Ignore discovery** (`packages/mcp-server/src/workspace-ignore-discovery.ts`) merges the root `.gitignore`, a non-symlink `.git/info/exclude`, and budget-bounded nested `.gitignore` files. Unless `ignore` is overridden, the blunt `**/bin/**` rule is refined to .NET output patterns (`**/bin/{Debug,Release,x64,x86,AnyCPU}/**` plus `<projDir>/bin/**` for detected `.csproj`/`.fsproj`/`.vbproj`), so Node `bin/*.ts|js` and Rust `src/bin/*.rs` stay indexed. One discovery run charges the steps the matcher really takes: the prune checks to `MAX_DISCOVERY_MATCH_WORK` (300,000,000 steps), the negation-conflict check to `MAX_DISCOVERY_NEGATION_WORK` (20,000,000 steps), and every examined directory entry to `MAX_DISCOVERY_DIRECTORY_ENTRIES` (200,000). A run that spends the match or directory-entry budget stops there and keeps the patterns it has accepted; one that spends the negation budget keeps later entries without the conflict check (more is ignored) and goes on. Either way a `[causoryn] ignore discovery …` line on `stderr` says what happened.
- **Matcher:** `packages/workspace/src/ignore-matcher.ts` is a two-pointer, polynomial-time glob matcher that executes no `RegExp` (no ReDoS backtracking). A policy decision matches a path and all its ancestors in one pass per pattern (anchored patterns as an automaton over the segments) with each ignore pass of the decision (lexical, canonical, native) bounded by its own `IGNORE_MATCH_WORK_BUDGET` (1,000,000 steps); a pass that runs out denies the path (rule `ignore-match-budget`). The inventory bounds the total ignore work of a run (`MAX_INVENTORY_IGNORE_WORK`, 10,000,000,000 steps) and never drops a path it could not decide: the run then ends with `indexing/limit-exceeded`. When configured, the deny rules `**/.git/**`, `**/.env*` and `**/*.pem` are matched again with look-alike folding (NFKD; combining marks and default-ignorable code points such as ZWJ, ZWSP, soft hyphen, word joiner and BOM dropped; upper- then lower-cased) on every platform, so `.GIT`, `.ENV.local` or `.gıt` are denied as well. The history inventory filter uses the same compiled decision (`compileIgnoreRuleSet`); a committed path it cannot decide within the budget is counted among the commit's files that were not analyzed instead of being dropped.

---

## 3. Honest Edge Resolution Discipline

No analyzer promotes a plausible guess to `verified`, and no worker generates node, edge, or evidence IDs: canonical SHA-256 IDs are computed centrally in `packages/domain` during `createSnapshot`.

1. **`verified`:** proven statically by a compiler semantic model or a direct syntactic attachment. Every `verified` edge must carry at least one `Evidence` item (`relativePath`, 1-based `startLine`/`endLine`, `sourceHash`, `analyzerId`, `analyzerVersion`, `rationale`); domain constructors, Zod schemas, and the SQLite repository reject violations.
2. **`heuristic` (+ `ambiguity`):** backed by deterministic lexical, import, or unique-name rules without full static type proof; carries `ambiguity: { candidates: [...], reason: "..." }`.
3. **`unresolved` (`UnknownExternal`):** unresolvable expressions, dynamic dispatch, or calls to unanalyzed code point to an explicit `UnknownExternal` node, so there are no dangling edges and no invented targets.

### 3.1 Per-Language `CALLS` & Hierarchy Rules

| Language | `verified` | `heuristic` (+ `ambiguity`) | `unresolved` (`UnknownExternal`) |
|---|---|---|---|
| **TypeScript / JavaScript** | `TypeChecker` resolves the call/constructor signature, workspace import, or `INHERITS`/`IMPLEMENTS` target to an analyzed symbol (declarations in bundled `lib*.d.ts` or `node_modules` become `UnknownExternal` targets), across ESM and CommonJS. | Relative module candidate or `node:*` builtin match on `IMPORTS` edges. | `TypeChecker` resolves no symbol (`any` or dynamic receiver). |
| **C# (Roslyn)** | `SemanticModel` resolves the method/constructor and `BaseType`/`Interfaces` (`INHERITS`/`IMPLEMENTS`); reference assemblies come from the .NET reference packs and, when present, from read-only `obj/project.assets.json` NuGet discovery. | Well-known-name fallback when reference assemblies are missing. | Overload ambiguity, error symbols, `dynamic`/reflection calls. |
| **Python** | Target defined in the **same module**: module-level `def`/`class`, `self.<method>`, or `SameModuleClass.<method>`. | Imported symbol (`import` / `from … import`, inside or outside the analyzed set; bindings are dynamic and no type inference runs). | Calls on local variables/parameters, builtins (`len`, `list`), undefined names. |
| **Go** | (a) Bare identifier call to a top-level `func` of the same package, where packages are keyed by **directory** (multi-file packages resolve; separate `package main` directories never cross-link). (b) `pkg.Func()` when the import path resolves through a `go.mod` **module path** to an analyzed directory holding exactly one package that defines `Func`. Local-variable shadowing cannot be distinguished from the AST alone; Go builtins (`len`, `make`) emit no edge. | Without a governing `go.mod`: directory-suffix or package-name match (never `verified`); unique method name across the analyzed set (`x.M()`); interface method name; selector on an imported external package; `go.mod`-resolved import whose directory is outside the analyzed set. | Function missing in the resolved package, several packages in one directory, ambiguous `x.M()` (candidates listed), unknown identifier or selector. |
| **Rust** | Bare `fn` call defined in the **same module**. | Qualified paths (`Type::method`, `mod::fn`): a single match on the last two segments is `heuristic` with `unverified-module-prefix-suffix-match` ambiguity, because module prefixes and `use` imports are not verified; a receiver method call (`x.foo()`, no trait dispatch) or a cross-file bare call with exactly one candidate is also `heuristic`. | No candidate in the analyzed sources (`std::env::var`, `Vec::new`, …). Several candidates (bare, qualified-path or method calls): `unresolved`, no edge to any candidate, every candidate listed in `ambiguity.candidates`. |

Sources: `adapters/typescript/src/analyzer.ts`, `native/roslyn-worker/WorkerAnalyzer.cs`, `native/python-worker/worker.py`, `native/go-worker/internal/analyze/analyze.go`, `native/rust-worker/src/analyzer.rs`.

### 3.2 Per-Language `ROUTES_TO` & `TESTS` Rules

`ROUTES_TO` is not uniformly `verified`; each analyzer assigns what its static proof supports:

- **TypeScript / JavaScript (`verified`):**
  - Generic `<receiver>.<verb>("/path", handler)` calls (`get`, `post`, `put`, `patch`, `delete`, `head`, `options`).
  - **Express (`express`):** intra-file ESM/CJS `express()`, `express.Router()`, and named `Router()` bindings add `framework: "express"`. Express instances imported from another file still produce generic routes without the framework attribute.
  - **Next.js App Router (`nextjs`):** exported HTTP verb handlers in `app/**/route.{ts,tsx,js,jsx,mjs,cjs}` (also under `src/app/`) and named default-export components in `page.{ts,tsx,js,jsx}`. Anonymous default exports or unrecognized files invent no symbol and record `FRAMEWORK_PATTERN_UNKNOWN` diagnostics.
- **Python (`verified`):** FastAPI/Starlette `@carrier.get("/path")` decorators and Flask `@carrier.route("/path", methods=[…])` attach syntactically to the decorated `def`/`async def` (`route-attribute` evidence). Non-literal paths or complex carriers produce explicit warnings.
- **Rust (`verified`):** Actix-Web, Axum, and Rocket attribute macros (`#[get("/path")]`, `#[route("…", method = …)]`, …) attach directly to the `fn` item.
- **C# ASP.NET Core (`verified` or `heuristic`):** controller `[Route]` + `[HttpGet]`/`[HttpPost]`/… attributes and Minimal API `MapGet`/`MapPost`/… calls are `verified` when Roslyn resolves the attribute or extension types to `Microsoft.AspNetCore.*`; without the `Microsoft.AspNetCore.App.Ref` pack they fall back to `heuristic` (+ `ambiguity`) through the well-known-name rule.
- **Go (`verified`, `heuristic`, or `unresolved`):** across `net/http` `Handle`/`HandleFunc` (method `"*"`) and gin/echo/chi verb registrations (`native/go-worker/internal/analyze/routes.go`), a same-package named handler is `verified`; a selector handler follows the `CALLS` table above; an unknown bare handler is `unresolved`; an inline `func` literal keeps the `Endpoint` node but emits no `ROUTES_TO` edge and records a warning.
- **Tests (`Test` & `TESTS`):** the TypeScript analyzer extracts BDD test blocks as `Test` nodes and emits `verified` `TESTS` edges when a test body calls a non-test workspace symbol; this powers the `direct` signal of test-plan derivation in `causoryn_preflight_change`. The C#, Python, Go, and Rust sidecars do not extract `TESTS` edges yet.

---

## 4. Sidecar Protocol (NDJSON v1) & Process Isolation

All four sidecar adapters use the zero-dependency `@causoryn/sidecar-ipc` runner (`packages/sidecar-ipc/src/index.ts`):

- **Fresh process per request:** a short-lived worker per `analyze` run, terminated as soon as the first complete JSON response line is parsed; no state crosses requests.
- **Fixed command, no shell:** every spawn uses `shell: false` and `windowsHide: true`. File paths and contents are never placed on the command line; the payload travels over `stdin` as one UTF-8 JSON line (`type: "analyze"`, `protocolVersion: "1"`). An empty or NUL-containing `cwd` is rejected without spawning; each adapter passes a trusted `cwd` inside Causoryn's own worker directory, never the analyzed repository.
- **Allowlisted environment (`buildAllowlistedWorkerEnv`):** parent secrets, cloud credentials, and API keys are not inherited. Each adapter forwards a small fixed list: `PATH`, `SystemRoot`, `COMSPEC`, `TEMP`, `TMP`, `USERPROFILE`, `HOME`, plus `DOTNET_ROOT`/`DOTNET_CLI_HOME` (C#) or `APPDATA`/`LOCALAPPDATA`/`GOPATH`/`GOROOT`/`GOCACHE`/`GOMODCACHE` (Go). The Cargo build additionally forwards `CARGO_HOME`/`RUSTUP_HOME` (absolute local paths only) and a validated `CARGO_TARGET_DIR`.
- **Per-toolchain hardening:**
  - **C#:** `dotnet exec` with `cwd` = the worker DLL directory; `DOTNET_STARTUP_HOOKS=""`, `DOTNET_CLI_TELEMETRY_OPTOUT=1`, `DOTNET_NOLOGO=1`, `DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1`. NuGet discovery reads `obj/project.assets.json` read-only, without following symlinks, with UNC guards and an 8 MB size cap, within a 20,000 file-system probe budget split fairly over the assets files (each may spend what is left divided by the files still to read, at most 10,000; the per-file stop warning names that share) (each package folder/directory pair is probed once; `packageFolders` entries with more than 256 path components are ignored before any probe, with a warning; at most 8 usable `packageFolders` entries per assets file are inspected, with a warning for the rest).
  - **Python:** `python -I -B -X utf8 worker.py` (on POSIX `python3` is tried before `python`) with `cwd` = the worker directory and `PYTHONIOENCODING=utf-8`; `PYTHONPATH` is never forwarded. Isolated mode (`-I`) implies `-E`, `-P`, and `-s` ([Python command-line docs](https://docs.python.org/3/using/cmdline.html)), so `PYTHON*` environment variables are ignored and neither the script directory (`sys._path0`) nor user site-packages is added to `sys.path`; `-B` prevents `.pyc` writes.
  - **Go:** `GOTOOLCHAIN=local`, `GOWORK=off`, `GOPROXY=off`; `GOENV` is not forwarded; `cwd` = `native/go-worker`. The adapter sends `go.mod` files as `moduleFiles` so the worker can resolve module paths.
  - **Rust:** `cargo` is probed from its own directory, and `cargo build --locked` runs on a staged copy of the worker crate (`Cargo.toml`, `Cargo.lock`, `build.rs`, `src/**`) inside the build cache (`CAUSORYN_RUST_TARGET_DIR`, default `~/.causoryn/cache/rust-worker-target`) with that copy as `cwd` and a fresh `--target-dir` inside it, so cargo and rustup config discovery never walks into the analyzed repository or the package directory; a cache directory inside the workspace is refused, and an explicitly configured worker directory (`CAUSORYN_RUST_WORKER_DIR`) is never built in place. Both run with `CARGO_BUILD_RUSTC_WRAPPER=""` and `CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER=""`. Before a cached worker binary is spawned it must match its `<binary>.sha256.json` side file (`sourceFingerprint` + `binarySha256`), read with `O_NOFOLLOW` as a regular file. The staged `Cargo.toml` gets its own `[workspace]` table, so cargo never adopts a `Cargo.toml` above the build cache as the workspace root. On Windows the build cache must resolve inside the user profile (Node cannot inspect ACLs there); a cache elsewhere is refused and Rust degrades to L0/L1 with a `Rust analyzer unavailable: …` warning.
- **Process-tree termination & `EPIPE` safety:** an early worker exit cannot crash the MCP server through an unhandled `EPIPE`. On timeout the worker is killed; on Windows, `go run` and `cargo build` grandchildren (`worker.exe`, `rustc.exe`) are cleaned up with `%SystemRoot%\System32\taskkill.exe /pid <pid> /T /F` (absolute path). An index job worker thread reports the sidecar processes it starts to a shared registry. When the job manager closes (roots rebind, session end), the worker is first asked to `cancel` (its adapters stop their sidecars) and is terminated on its answer or after 1 s; whenever a worker is given up (closed, crashed, failed or finished), every sidecar PID it still reports is killed from the main thread, the same path as for the history analysis worker.
- **Absolute executables:** `dotnet`, `python`, `go`, `cargo` and `git` are resolved to absolute paths by scanning `PATH` (`packages/sidecar-ipc/src/executable.ts`, with a self-contained copy in `packages/graph` for `git`); empty, relative, UNC/device and in-workspace `PATH` entries are skipped, so a file committed to the analyzed repository can never be started in place of the real tool, even when the server's own `cwd` is the repository.
- **English output:** worker warnings, rationales and diagnostics are plain English (for example `reference pack loaded: <pack> <version> (<tfmDir>)` from the Roslyn worker).

### Protocol Quotas & Timeouts

| Quota / parameter | Limit | Behavior |
|---|---|---|
| Max request line (`MaxRequestLineBytes` / `MaxRequestLineChars`) | About 64 MB: `64,000,000` (Go chars, Rust bytes) or `64 MiB` (C# chars, Python bytes) | The oversized line is discarded up to `\n`; the worker answers `id: null` + `LIMIT_EXCEEDED` and keeps running. |
| `MaxFileCount` | 5,000 files per request | Request rejected with `LIMIT_EXCEEDED`. |
| `MaxFileContentBytes` | 2,000,000 bytes per file | Matches the default `maxFileBytes`; rejected with `LIMIT_EXCEEDED`. |
| `MaxResponseNodes` (`maxNodes`) | 250,000 nodes per response (`1..250000`) | Excess nodes and edges touching them are dropped (no dangling edges); `RESPONSE_TRUNCATED` + `status: "partial"`. |
| `responseMaxChars` / `stderrMaxChars` | 64 MiB (`67,108,864` chars) each | Exceeding either kills the worker and triggers the L0/L1 fallback. |
| Copied source text per name | Go: 200 bytes for call text, 512 bytes for declared names, import paths, package names and directories · Python: 200 characters for rendered expressions, 512 for qualified names and route paths · Roslyn: 1,024 characters for names, call text, base types, route paths and candidates | A longer text is cut to a prefix plus a SHA-256 marker (`...#<12 hex>` in Go and Python, `~<16 hex>` in Roslyn), so bounded texts stay distinct and deterministic. Ordinary code is unaffected. |
| Ambiguity candidates | 64 per call site (Go, Roslyn); Go also at most 4,096 label bytes | Go lists the first sorted candidates and adds `candidatesTruncated` and `candidateCount`; Roslyn lists the first 64 in Roslyn's candidate order. Both say so in the reason. |
| Response size (Go, Python) | 40,000,000 bytes of serialized nodes, edges, evidence (counted twice) and warnings; a response line over 60,000,000 bytes | Once the budget is spent nothing more is admitted (File nodes excepted; edges never dangle), call extraction stops and the response gets `RESPONSE_TRUNCATED` + `status: "partial"`. An oversized line is answered with `LIMIT_EXCEEDED`. |
| Response size (Roslyn) | 60,000,000 serialized characters (everything emitted plus the envelope), at most 16,000,000 of them for compiler diagnostics | Later phases stop and further output is dropped: `RESPONSE_TRUNCATED` (`response size budget reached …`) + `status: "partial"`. |
| Truncated response and file facts | any diagnostic without a path | The files of the adapter language that reported it stay out of the `file_facts` cache (their cached facts are dropped); a path-less diagnostic that no adapter is charged with keeps the whole run out. An incremental run therefore never reuses truncated facts. |
| Python expression rendering | 256,000 source bytes per file and 1,000,000 per request (`MAX_RENDER_SOURCE_BYTES_PER_FILE`, `MAX_RENDER_SOURCE_BYTES_PER_REQUEST`) for expressions whose source exceeds 200 bytes | Past either budget such an expression is named by its source range (`<expression at path:line:col..end_line:end_col>`, distinct per expression). The source-segment fallback splits the file into lines once per pass, and an `ast.unparse` attempt that must hit the recursion limit is skipped; real code stays far below the budgets and its output is unchanged. |
| Go callee hashing | 4,000,000 hashed bytes of long callee texts per file (`MaxHashedBytesPerFile`) | Span groups are hashed in source order; past the budget a text gets the digest of its file and byte range, which still identifies it exactly. |
| Python route `methods` | 16 distinct entries per decorator | Duplicates are removed; entries past 16 are dropped with a warning. |
| Timeouts | 30 s (C#, Python, Rust analyze) · 120 s (Go `go run`) · 600 s (cold Rust `cargo build`) | The process tree is killed and the language degrades to L0/L1. |

### Graceful L0/L1 Fallback

When `dotnet`, `python`, `go`, or `cargo` is missing, crashes, or times out, the server keeps running: affected files stay in the snapshot as `sourceHash`-evidenced `File` nodes, the snapshot state becomes `partial`, that language's `coverage.byLanguage` entry shows the lower tier, and `warnings` records the reason. `npx causoryn@latest doctor` reports which toolchains are available.

---

## 5. Runtime Prerequisites

| Component | Runtime | Compilation model | Network behavior |
|---|---|---|---|
| **TypeScript / JavaScript + SQLite core** | Node.js >= 24 | None (`dist/mcp-server.mjs` + `better-sqlite3` prebuilds + bundled `dist/typescript-lib/lib*.d.ts`) | Local after installation |
| **C# / Roslyn** | .NET 10 runtime (`dotnet exec`) | Precompiled deterministic Release `Causoryn.RoslynWorker.dll` (`net10.0`, `Microsoft.CodeAnalysis.CSharp` `5.12.0`; no `.pdb` or `.resources.dll` files) | Local after installation |
| **Python** | Python 3.10+ (CI uses 3.12) | None (`worker.py`, stdlib `ast` only, no pip packages, no `__pycache__` writes) | Local after installation |
| **Go** | Go toolchain satisfying `native/go-worker/go.mod` (`go 1.26`; with `GOTOOLCHAIN=local` no newer toolchain is downloaded) | `go run ./cmd/worker` (cached in `GOCACHE`) or a prebuilt `CAUSORYN_GO_WORKER_BIN`; stdlib only, no external modules | Local after installation |
| **Rust** | Rust / Cargo (`edition = 2021`) | On-demand `cargo build --locked` into `~/.causoryn/cache/rust-worker-target` (or `CAUSORYN_RUST_TARGET_DIR`) | The first build may download uncached `Cargo.lock` crates (`syn` 3, `serde_json`, `proc-macro2`) from crates.io; afterwards the pinned binary runs locally |

---

## 6. `fp3` `analyzerFingerprint` & Internal Analyzer Versions

### 6.1 Fingerprint Schema

`packages/indexing/src/fingerprint.ts` computes the positional `fp3` fingerprint so persisted snapshots and `file_facts` are not reused across toolchain or reference-pack changes. `fp3` (0.3.0) replaces `fp2`: real TypeScript declaration spans, ESM/CJS module-format detection and the English evidence text changed analyzer output, so snapshots and `file_facts` written by earlier releases are not reused and the first 0.3.0 start re-indexes:

```text
fp3|ts-adapter@0.1.0|roslyn-worker@0.1.0|refpack=<pack>@<version>@<tfm>;...|refsrc=<source>|opts=<sha256-16>
   [|python-worker@0.1.0|pystate=<status>|pyopts=<sha256-16>]
   [|go-worker@0.1.0|gostate=<status>|goopts=<sha256-16>]
   [|rust-worker@0.1.0|ruststate=<status>|rustopts=<sha256-16>]
```

- **Conditional blocks:** the Python, Go, and Rust blocks are omitted when the workspace has no files in that language, so TS/C# fingerprints stay unchanged.
- **Reference packs and run state:** C# records the loaded .NET / ASP.NET Core reference packs (`refpack=…` with pack, version and only the target framework directory name such as `net8.0` — never the absolute reference-pack directory, which can contain the OS user name and would reach documentation exports — or `fallback-corelib`, or `unavailable`) and the discovery source (`refsrc=`, e.g. `worker-unavailable`, `discovery-unknown`, `sync-run-degraded`); Python, Go, and Rust record their worker status (`ready`, `worker-unavailable`, `sync-run-degraded`) and the first 16 hex characters of the SHA-256 of the effective adapter options.
- **Invalidation:** the snapshot ID hashes `[workspaceId, revision.id, revision.sequence, configHash, analyzerFingerprint, contentHash]`, so installing a missing toolchain (`worker-unavailable` → `ready`) or changing .NET reference packs yields a new fingerprint and a fresh build.

### 6.2 Why Internal Analyzer Versions Stay at `0.1.0`

The package and MCP server versions follow releases (0.3.0), but `ts-adapter`, `roslyn-worker`, `python-worker`, `go-worker`, and `rust-worker` (and `native/rust-worker/Cargo.toml`) stay at `0.1.0`:

1. `analyzerVersion` is part of every evidence record (and therefore of evidence IDs) and of the `fp3` fingerprint.
2. Bumping it on packaging-only releases, when extraction semantics and NDJSON `protocolVersion: "1"` did not change, would invalidate every persisted graph and churn evidence hashes.
3. Internal analyzer versions therefore track extraction semantics, independent of the package release.

---

## Related Documentation

- [Documentation Hub](README.md) · [Architecture Overview](architecture.md)
- [CLI & Configuration Reference](cli-and-configuration.md) · [MCP Tool Contracts](tool-contracts.md)
- [No-LLM decision record](adr/ADR-002-no-llm.md) · [Security Audit](security-pass.md) · [Benchmarks](benchmarks.md)
