# 5-Language Analyzers, Resolution Honesty & Sidecar Protocol

> **Language:** [Türkçe](../language-analyzers.md) | **English** · [Documentation Hub](README.md)
>
> **Source modules:** `packages/indexing/src/{index.ts,index-service.ts,index-worker.ts,inventory.ts,fingerprint.ts}`, `packages/workspace/src/ignore-matcher.ts`, `packages/mcp-server/src/workspace-ignore-discovery.ts`, `packages/sidecar-ipc/src/index.ts`, `adapters/typescript/src/{analyzer.ts,tsconfig-loader.ts}`, `adapters/{csharp-roslyn,python,go,rust}/src/*`, `native/{roslyn-worker,python-worker,go-worker,rust-worker}/PROTOCOL.md`.

Causoryn combines analyses of **TypeScript / JavaScript**, **C# (.NET / Roslyn)**, **Python**, **Go**, and **Rust** into a single **Unified Evidence & Knowledge Graph** with zero LLM calls. Every `verified` edge requires verifiable source-span evidence, and unresolved or ambiguous bindings carry explicit `heuristic` or `unresolved` labels. Every MCP response envelope also reports per-language fidelity via **`coverage.byLanguage`** so strong coverage in one language never masks `L0` fallback in another.

Polyglot indexing merges shared pathless external/virtual nodes (`UnknownExternal`) across adapters into a single canonical node while rejecting identity collisions for file-bound nodes.

---

## 1. 5-Language Capability Matrix (`INDEXED_ADAPTERS`)

| Language | `analyzerId` (`version`) | Execution Model | `astParse` (`L1`) | `symbolResolution` (`L2`) | `frameworkLinkers` / Routes & Tests (`L3`) | Emitted Edge Kinds |
|---|---|---|---|---|---|---|
| **TypeScript / JavaScript** | `ts-adapter` (`0.1.0`) | In-process (`adapters/typescript`, TS Compiler API `5.9.3`; `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`, `allowJs: true`, `checkJs: false`, `jsx: Preserve`, confined `tsconfig.json`/`jsconfig.json`, in-root monorepo workspace resolution, `oldProgram` reuse) | `L1` | `L2` (full `TypeChecker` semantic resolution; ESM + CommonJS `require`/`exports`/`module.exports`; CHA `INHERITS`/`IMPLEMENTS`) | `express+nextjs` (TS/JS/CJS) + generic `<x>.<verb>` routes + BDD `Test` nodes & `TESTS` edges | `CONTAINS`, `IMPORTS`, `CALLS`, `INHERITS`, `IMPLEMENTS`, `ROUTES_TO`, `TESTS` |
| **C# / .NET** | `roslyn-worker` (`0.1.0`) | Isolated sidecar (`dotnet exec`, `DOTNET_STARTUP_HOOKS=""`, worker `cwd`, read-only `obj/project.assets.json` NuGet discovery) | `L1` | `L2` (Roslyn `SemanticModel` + CHA `INHERITS`/`IMPLEMENTS`) | `aspnet-core-route-attributes (L3)` (Controller `[Route]`/`[Http*]` + Minimal API `MapGet`/…) | `CONTAINS`, `CALLS`, `INHERITS`, `IMPLEMENTS`, `ROUTES_TO` |
| **Python** | `python-worker` (`0.1.0`) | Isolated sidecar (`python -I -B -X utf8 worker.py` in worker `cwd`, pure stdlib `ast`) | `L1` | `L2` (AST lexical/class scope; no full type inference) | `decorator-route-pattern (L3)` (FastAPI/Starlette `@app.get`/… + Flask `@app.route`) | `CONTAINS`, `CALLS`, `ROUTES_TO` |
| **Go** | `go-worker` (`0.1.0`) | Isolated sidecar (`GOTOOLCHAIN=local`, `GOWORK=off`, `GOPROXY=off`, stdlib `go/parser` + `go/ast`, directory + `go.mod` package keying) | `L1` | `heuristic-only (semantik L2 yok)` (`symbolResolution: false`) | `http-router-registration (L3)` (`net/http` `Handle`/`HandleFunc` + `gin`/`echo`/`chi`) | `CONTAINS`, `CALLS`, `ROUTES_TO` |
| **Rust** | `rust-worker` (`0.1.0`) | Isolated sidecar (`syn` 3, trusted Cargo `cwd`, `CARGO_BUILD_RUSTC_WRAPPER=""`, `.sha256.json` binary pinning) | `L1` | `heuristic-heavy` (AST + symbol table; 2-segment suffix matches honestly labeled `heuristic`) | `attribute-macro-route (L3)` (Actix-Web / Axum / Rocket HTTP verb macros) | `CONTAINS`, `CALLS`, `ROUTES_TO` |

### Capability Tiers (`L0` – `L3`) & `coverage.byLanguage`

- **`L0` (Inventory & File Provenance):** Every policy-admitted file produces a `File` node carrying a UTF-8 SHA-256 `sourceHash` and a `verified` `Workspace -> File` `CONTAINS` edge.
- **`L1` (AST & Declarations):** Extracts `Class`, `Interface` (interfaces/traits), `Type` (structs/enums/type aliases), `Function`, and `Method` declarations with structural `CONTAINS` edges.
- **`L2` (Symbol, Hierarchy & Call Resolution):** Resolves `CALLS`, `IMPORTS` (TS/JS), and Class Hierarchy Analysis `INHERITS`/`IMPLEMENTS` edges (TS/JS and C#) to in-workspace symbols or explicit `UnknownExternal` nodes.
- **`L3` (Framework Routes & Test Links):** Extracts HTTP `Endpoint` nodes, `Endpoint -> Handler` (`ROUTES_TO`) edges, and TypeScript/JavaScript BDD `Test -> Target` (`TESTS`) edges.
- **Per-language breakdown (`coverage.byLanguage`):** Every snapshot-backed MCP envelope reports overall `coverage.tier` **and** per-language `{ tier, files, verifiedEdges, heuristicEdges, unresolvedEdges, coverageRatio }` so an unavailable sidecar toolchain in one language is immediately visible alongside `L2` TypeScript coverage.

---

## 2. TypeScript / JavaScript Analysis, Monorepo Workspaces, CHA & Non-Blocking Inventory

### 2.1 TypeScript, JavaScript, CommonJS & Monorepo Workspaces (`ts-adapter`)

- **Full extension coverage:** `.ts`, `.tsx`, `.mts`, `.cts` (`language: "typescript"`) and `.js`, `.jsx`, `.mjs`, `.cjs` (`language: "javascript"`) run in-process with `allowJs: true`, `checkJs: false`, and `jsx: Preserve`.
- **ESM + CommonJS:** Extracts ES module imports/exports, literal `require("./module")` imports, and `exports.<fn>` / `module.exports` declarations, plus Express (ESM + CJS) and Next.js App Router (`app/**/route.*`, `page.*`) routes.
- **In-root monorepo workspace resolution:** Discovers verified in-root `package.json` manifests (`name`, `exports`, `types`, `main`, `workspaces`) and resolves workspace package imports (such as `@scope/pkg` and subpath exports) directly to in-memory workspace sources — drastically reducing unresolved cross-package imports while still rejecting any symlink escaping `rootDir`.
- **Class Hierarchy Analysis (`INHERITS` / `IMPLEMENTS`):** Emits `TypeChecker`-verified `INHERITS` (`class A extends B`, `interface X extends Y`) and `IMPLEMENTS` (`class A implements C`) edges, propagated through `analyze_impact` and `causoryn_preflight_change`.
- **Incremental `oldProgram` reuse:** Long-lived worker indexing passes the previous `ts.Program` (`oldProgram`) to reuse unchanged `ts.SourceFile` ASTs alongside SQLite `file_facts` early-cutoff caching.

### 2.2 Confined `tsconfig.json` / `jsconfig.json` Loader (`tsconfig-loader.ts`)

- Parses JSONC (`baseUrl`, `paths`, `moduleResolution`, `module`, `target`, `jsx`, `experimentalDecorators`, `verbatimModuleSyntax`) with zero `eval` or plugin execution and prototype-pollution key rejection.
- Confines `extends` chains strictly inside `rootDir` (depth `<= 5`, cycle detection, up to 64 scoped configs) and confines the TS compiler & module-resolution host (`configureConfinedCompilerHost`) to approved workspace entries, bundled `typescript-lib`, and in-root `node_modules` declarations.
- Editing or deleting `tsconfig.json` / `jsconfig.json` automatically invalidates cached incremental facts.

### 2.3 Non-Blocking `collectInventoryAsync` & Smart Ignore Engine

- **`collectInventoryAsync`** (`packages/indexing/src/inventory.ts`) yields to the event loop (`setImmediate`) every 64 entries while producing byte-identical sorted output to synchronous `collectInventory`.
- **`workspace-ignore-discovery.ts`** merges root `.gitignore`, `.git/info/exclude`, and bounded nested `.gitignore` files on a polynomial-time zero-RegExp glob engine (`ignore-matcher.ts`), refining blunt `**/bin/**` into `.NET`-specific output patterns so Node `bin/*.ts|js` and Rust `src/bin/*.rs` sources stay indexed.

---

## 3. Honest Edge Resolution Discipline

No analyzer ever promotes an unverified guess to `verified`, and no worker invents node/edge IDs (all canonical SHA-256 IDs are computed centrally in `packages/domain`).

### 3.1 Per-Language `CALLS` & Hierarchy Resolution Rules

| Language | `verified` Condition | `heuristic` (+ `ambiguity`) Condition | `unresolved` (`UnknownExternal`) Condition |
|---|---|---|---|
| **TypeScript / JavaScript** | `TypeChecker` resolves calls, constructors, workspace imports, and `INHERITS`/`IMPLEMENTS` targets (ESM + CommonJS). | Relative module candidate or `node:*` builtin match on `IMPORTS`. | `TypeChecker` cannot resolve any symbol (`any`/dynamic receiver). |
| **C# (Roslyn)** | Roslyn `SemanticModel` resolves methods, constructors, and `INamedTypeSymbol.BaseType` / `Interfaces` (`INHERITS`/`IMPLEMENTS`), enriched by read-only `obj/project.assets.json` NuGet assembly discovery when present. | Well-known name fallback when reference assemblies are absent. | Overload ambiguity, error symbols, or dynamic/reflection calls. |
| **Python** | Target defined in the **same module** (module-level `def`/`class`, `self.<method>`, `SameModuleClass.<method>`). | Imported symbol (`import` / `from ... import` — dynamic bindings, no full type inference). | Calls on local variables/parameters, builtins (`len`, `list`), or undefined identifiers. |
| **Go** | Bare identifier call matching a top-level `func` in the **same directory package** (keyed by directory path + `go.mod` module path — multi-file packages resolve cleanly while distinct `package main` directories never cross-link falsely). *(Go builtins emit no edge.)* | In-set `pkg.Func` call, external imported package selector, unique method name (`x.M()`), or interface method match. | Multi-candidate ambiguous `x.M()` or unknown identifier/selector. |
| **Rust** | Same-module bare `fn` call or fully unambiguous local match. | 2-segment suffix matches (`Type::method` / `mod::fn` with `unverified-module-prefix-suffix-match` ambiguity), receiver method calls (`x.foo()`, no trait dispatch), cross-file bare calls, or multi-candidate paths. | Zero candidates in analyzed sources (`std::env::var`, `Vec::new`, etc.). |

### 3.2 Per-Language `ROUTES_TO` & `TESTS` Rules

- **TypeScript / JavaScript (`verified`):** Generic `<receiver>.<verb>("/path", handler)`, Express (`express()`/`Router()`), and Next.js App Router (`app/**/route.*`, `page.*`). BDD test blocks emit `Test` nodes and `verified` `TESTS` edges powering `derive_test_plan`'s `direct` signal.
- **Python (`verified`):** FastAPI/Starlette verb decorators and Flask `@app.route(...)`.
- **Rust (`verified`):** Actix-Web, Axum, and Rocket attribute macros (`#[get("/path")]`, etc.).
- **C# ASP.NET Core (`verified` or `heuristic`):** Controller `[Route]`/`[Http*]` attributes and Minimal API `MapGet`/… emit `verified` when `Microsoft.AspNetCore.App.Ref` resolves the types, or degrade honestly to `heuristic` otherwise.
- **Go (`verified`, `heuristic`, or `unresolved`):** Same-package named handlers emit `verified`; selector expressions emit `heuristic`/`unresolved`; unknown bare handlers emit `unresolved`; inline anonymous `func` literals keep the `Endpoint` node with a warning.
- **Sidecar `TESTS` edges:** Extracting `Test` nodes and `TESTS` edges in C#, Python, Go, and Rust remains tracked as an open `1.0.0` gate.

---

## 4. `@causoryn/sidecar-ipc` Protocol (v1) & Untrusted-Repo Process Isolation

All four sidecar adapters share `@causoryn/sidecar-ipc`:

- **Fresh isolated process per request:** Mandatory `shell: false`, `windowsHide: true`, and non-empty trusted `cwd` (never the untrusted repository root); payloads travel exclusively over `stdin` as single-line UTF-8 NDJSON (`protocolVersion: "1"`).
- **Hardened toolchain environments:**
  - **C# Roslyn:** `cwd: path.dirname(workerDllPath)`, `DOTNET_STARTUP_HOOKS=""`, telemetry opt-out.
  - **Python:** `python -I -B -X utf8 <workerScriptPath>` in worker `cwd` (isolated mode ignores `PYTHONPATH`, user site-packages, and cwd).
  - **Go:** `GOTOOLCHAIN=local`, `GOWORK=off`, `GOPROXY=off`, `GOENV` stripped from allowlist, trusted `workerDir` `cwd`.
  - **Rust:** Cargo probes and `--locked` builds run in `native/rust-worker` `cwd` with `CARGO_BUILD_RUSTC_WRAPPER=""`; binaries are pinned and verified via `causoryn-rust-worker.sha256.json` (`O_NOFOLLOW` + regular-file + SHA-256 check).
- **Resource quotas & graceful fallback:** `64 MB` max request line, `5,000` files/request, `2 MB` max file content, `250,000` max response nodes (`RESPONSE_TRUNCATED` + `partial`), `30 s` analyze timeout (`120 s` Go `go run`, `600 s` cold Rust Cargo build) with process-tree cleanup on timeout. Missing or failed toolchains degrade cleanly to `L0`/`L1` with explicit warnings.

---

## 5. `fp2` `analyzerFingerprint` Cache Invalidation

`packages/indexing/src/fingerprint.ts` computes the deterministic `fp2` fingerprint encoding active adapter versions, loaded `.NET`/ASP.NET reference packs, and worker run status/options hashes. Installing a previously missing toolchain or updating `.NET` reference packs changes `analyzerFingerprint` and automatically invalidates cached `file_facts` and snapshots. Internal analyzer extraction versions remain pinned at `0.1.0` independently of the `causoryn` package version whenever extraction semantics are unchanged, avoiding unnecessary cache churn.

---

## Related Documentation

- [Documentation Hub](README.md) · [Architecture Overview](architecture.md)
- [CLI & Configuration Reference](cli-and-configuration.md) · [MCP Tool Contracts](tool-contracts.md)
- [No-LLM Architecture Policy](adr/ADR-002-no-llm.md) · [Security Audit](security-pass.md) · [Benchmarks](benchmarks.md)
