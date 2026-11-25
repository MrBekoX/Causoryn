# Causoryn Performance Benchmarks

> **Language:** [Türkçe](../benchmarks.md) | **English** · [Documentation Hub](README.md)
>
> **Status:** reflects Causoryn 0.3.0. This page documents two separate benchmarks: the synthetic 1,000-file fixture micro-benchmark (`npm run bench`, last executed 2026-11-10) and the packed-tarball [real-repository evaluation](#real-repository-evaluation-scriptsbenchreal-repo-evalmjs) (`scripts/bench/real-repo-eval.mjs`), which now splits CALLS edges by target and reports the unresolved ratio per language.

**Measurement honesty rule:** Unmeasured numbers are never reported as measured results. The reference design targets in the fixture table are comparison baselines, not achieved results; only executed measurements are reported. A row that hits its call deadline or an environment interruption is recorded as `not measured (<reason>)` instead of a number. Figures measured by someone else are labelled with their source.

## Current Runtime & Scalability Architecture

The fixture table below preserves the dated November 10, 2026 synthetic 1,000-file TypeScript fixture benchmark. Later runtime changes targeting warm latency, event-loop responsiveness, memory overhead, and incremental rebuilds include:

- **Warm startup metadata reads & streaming SHA-256 hashing:** `getLatestSnapshotMeta` avoids hydrating full graphs during startup; `computeStreamingSnapshotId` hashes nodes, edges, and evidence in a streaming pass without giant monolithic JSON string allocations; `MAX_PUBLISHED_CACHE_ENTRIES = 1` curbs warm RSS; `pruneOldSnapshots` retains the latest 2 published snapshots and removes orphan `symbol_fts` rows.
- **Non-blocking `worker_threads` WAL indexing:** Full and incremental analysis run off the MCP event loop in `dist/index-worker.mjs` over SQLite WAL (`PRAGMA busy_timeout=5000`), streaming `notifications/progress` while serving concurrent queries from existing snapshots.
- **Per-file incremental indexing (`file_facts`) with early cutoff:** Unchanged files reuse cached SQLite `file_facts`; comment/formatting/body-only edits that preserve `public_interface_hash` skip reverse dependents (early cutoff) and reuse the prior TypeScript `oldProgram`.
- **Non-blocking inventory & zero-RegExp matching:** `collectInventoryAsync` yields every 64 entries and `ignore-matcher.ts` runs in linear/polynomial time with zero `RegExp` backtracking.

No timings are reported for these later changes in the fixture table; it records only the executed 2026-11-10 run. The real-repository evaluation below is the place where whole-process numbers (handshake, cold index, event-loop stall, RSS, SQLite size) are measured against the packed tarball.

## Synthetic 1,000-File Fixture Benchmark

### Methodology

- **Fixture:** Deterministic synthetic TypeScript workspace, 1,000 files (`tests/bench-release/fixture.ts`; identical `fileCount` produces byte-identical content; sha256: `2b14c5ab89f5f1c2059f3152d5da6156d726d9d498343acd2fbf2aea64e8d958`).
- **Measurement layer:** MCP protocol layer (`client.callTool` over `@modelcontextprotocol/sdk` `InMemoryTransport`), timed via `process.hrtime.bigint()`; 1 unmeasured warm-up call + N=3 timed runs reporting the median (per-call deadline: `30000 ms`). A deadline breach or exception marks the row `not measured`.
- **Reference targets:** the targets in the table (warm workspace summary < 1 s, small graph neighborhood < 500 ms, bounded 200-node map < 2 s on a 1,000-file TypeScript fixture) are design targets from the original design document, not results.
- **Cold index (informational):** `16370.3 ms` (1,000 files); no fixed wall-clock SLA is promised for cold indexing. Snapshot state `ready`, `0` parse diagnostics (diagnostic-free fixture).
- **Environment:** Node.js `v24.16.0`, `win32 10.0.26300 x64`, Intel Core i7-10750H @ 2.60 GHz, 32 GB RAM.
- **Reproduction:** `CAUSORYN_BENCH_WRITE_DOCS=1 npm run bench` (`vitest.bench.config.ts`). The default `npm test` run excludes `tests/bench-release/**` so wall-clock measurements do not flake under parallel suite load, and the default run never writes to the repository.

### Results — Run 2026-11-10T19:29:35.301Z

| Measurement | Tool Call | Reference Design Target | Runs (ms, N=3) | Median (ms) | Assessment |
|---|---|---|---|---|---|
| `workspace_summary_warm` | `causoryn_workspace_summary` `{}` | < 1000 ms | 11.9 / 11.0 / 11.8 | 11.8 | within target (< 1000 ms) |
| `graph_neighborhood_small` | `causoryn_get_symbol_context` `{ symbolId: <first class>, depth: 1 }` | < 500 ms | 13.0 / 14.9 / 12.3 | 13.0 | within target (< 500 ms) |
| `map_system_200` | `causoryn_map_system` `{ level: "L2", maxNodes: 200 }` | < 2000 ms | 20.5 / 10.7 / 9.3 | 10.7 | within target (< 2000 ms) |

`causoryn_workspace_summary` was the tool name at the time of the run; in 0.3.0 the default `core` profile exposes the same data through `causoryn_status` (`action: "inspect"`), and the legacy name remains available in the `full` profile.

### Notes

- Measurements include full MCP protocol handling: Zod input validation, engine query execution, and structured envelope serialization.
- Individual samples vary with host load; compare using the **Median (ms)** column. Timing depends on the measurement environment.
- The fixture SHA-256 digest is cross-pinned against `buildFixtureModel(1000).hash` in `tests/release-docs.test.ts` so the documented hash cannot silently drift.

## Real-repository evaluation (scripts/bench/real-repo-eval.mjs)

[`scripts/bench/real-repo-eval.mjs`](../../scripts/bench/real-repo-eval.mjs) evaluates the package exactly as users receive it. It never reads the local `packages/causoryn/dist/` directly:

1. It runs `npm pack --pack-destination <tmp>` on `packages/causoryn` (or takes `--tarball <path>`), unpacks the tarball into a fresh temporary directory, and records the tarball SHA-256 and the `dist/mcp-server.mjs` SHA-256 in the report.
2. It spawns the unpacked `scripts/causoryn.mjs mcp --allow-cwd --auto-data-dir --data-dir <tmp>` and talks to it over JSON-RPC 2.0 on stdio, like an MCP host.
3. It uses Node.js built-ins only, `shell: false` for every child process, treats the analyzed repository as read-only, writes fixtures only into temporary directories, and removes every temporary directory in a `finally` block.

### What it measures

**Section 1 — self-repository** (the Causoryn monorepo, or `--repo <path>`):

- Cold `initialize` handshake, `tools/list` tool count and serialized size.
- Cold full index wall time, peak RSS of the server process, and the worst main-thread event-loop stall, measured by pinging `causoryn_status` every 250 ms while the background index runs.
- Overall unresolved edge ratio from the envelope `coverage` (`unresolvedEdges / totalEdges`, all edge kinds), plus the per-language `coverage.byLanguage` table.
- **CALLS edge breakdown and unresolved ratio per language** (see [below](#calls-edge-breakdown-and-per-language-unresolved-ratio)).
- Workspace-internal imports that still end at `UnknownExternal` (workspace package scopes and relative specifiers).
- A code-localization check: rank of `packages/mcp-server/src/server.ts` in `causoryn_get_agent_context` for "Where are MCP tools registered?".
- `causoryn_find_symbols("createCausorynMcpServer")` returns the real function without `AMBIGUOUS_SYMBOL`.
- `causoryn_preflight_change` on `server.ts` returns no `Workspace` node as an impact candidate.
- SQLite database size after retention GC, and the warm-restart handshake against the same data directory.

**Section 2 — head-to-head demo** (`examples/fixture-ts-orders`, copied to a temp directory and committed to a throwaway git repository): a fixed-string search for `OrderRepository` / `.save(` misses the multi-hop route and test files, while `causoryn_preflight_change` on `OrderRepository.save` must return the verified callers `OrdersService.create` and `createOrdersRoute`, the route test as a verified impact, and a call-site test-plan candidate; the default `causoryn_verify_change` must report verdict `no_findings` with contracts `not_requested` and no trust warning.

**Section 3 — multi-language call-graph honesty fixtures** (named after the Judge call-graph soundness study, ISSTA 2019):

- TypeScript workspace monorepo: zero unresolved edges, verified `INHERITS` / `IMPLEMENTS`, and class-hierarchy (CHA) impact from `PaymentGateway` to `StripeGateway`.
- Go: same-package multi-file call verified, `go.mod` cross-package call verified, and no false edge between two `package main` directories.
- Rust: a two-segment path call stays `heuristic`, a same-file call is `verified`.

A Go or Rust fixture is reported as `SKIPPED` (and does not fail the gate) when the toolchain is not on `PATH` or the worker degrades to `L0`; the report says which.

### How to run

```bash
# Pack packages/causoryn and run all three sections
node scripts/bench/real-repo-eval.mjs

# Evaluate an existing tarball and keep the full JSON report
node scripts/bench/real-repo-eval.mjs --tarball path/to/causoryn-0.3.0.tgz --json out/eval.json

# Self-repository section only, with a longer indexing timeout
node scripts/bench/real-repo-eval.mjs --skip-head-to-head --skip-judge --timeout-ms 600000
```

| Option | Meaning |
|---|---|
| `--tarball <path>` | Evaluate an existing `causoryn-*.tgz` instead of running `npm pack` |
| `--repo <path>` | Self-repository target root (default: the monorepo root) |
| `--json <outPath>` | Write the full structured report as JSON |
| `--timeout-ms <ms>` | Per-workspace indexing timeout (default `300000`, minimum `5000`) |
| `--skip-self-repo` / `--skip-head-to-head` / `--skip-judge` | Skip Section 1 / 2 / 3 |

Requirements: Node.js >= 24 and `git` on `PATH` (Section 2); `go` and `cargo` are optional (Section 3). The Markdown report goes to stdout and progress lines go to stderr; the exit code is `1` when the overall gate fails. On Windows, run it from PowerShell or `cmd` so that `tar` resolves to the Windows `tar.exe`; the GNU `tar` shipped with Git Bash treats `C:` in an archive path as a remote host.

### SLO gates

The overall gate fails if any of these fails (thresholds from the `SLO` constant in the script):

| Check | Pass condition |
|---|---|
| `tools/list` tool count (default `core` profile) | exactly `11` |
| `tools/list` serialized size | <= 15,000 characters |
| Max event-loop stall during cold index | < 500 ms |
| Overall unresolved edge % (all edge kinds) | < 10.0% |
| `server.ts` rank in `causoryn_get_agent_context` | <= #3 |
| `find_symbols("createCausorynMcpServer")` | no `AMBIGUOUS_SYMBOL`, real function present |
| `preflight_change(server.ts)` | 0 `Workspace` nodes |
| Warm restart handshake | < 1,000 ms |
| Section 2 head-to-head | all checks pass |
| Section 3 fixtures | `PASS` or `SKIPPED` |

Cold handshake, cold index time, peak RSS, SQLite size, workspace-internal unresolved imports, and the CALLS breakdown are informational and never change the gate.

### CALLS edge breakdown and per-language unresolved ratio

The overall unresolved edge % treats every `verified` or `heuristic` edge as resolved, so it does not show where an improvement comes from. In particular, the TypeScript analyzer (`adapters/typescript/src/analyzer.ts`) emits a **`verified` CALLS edge to an `UnknownExternal` node** when the TypeScript checker resolves the callee to a declaration outside the analyzed files, for example a test-framework assertion or a standard-library method. Such an edge is a correctly labelled call into a library, runtime, or test framework; it is not a call resolved to a project symbol. A callee that cannot be resolved at all becomes an `unresolved` CALLS edge to an `UnknownExternal` node. Calls the checker resolves to local targets that are not modelled as nodes (callback parameters, closures, object literals, immediately invoked functions) produce no edge, so they are not part of either count.

To make this visible, Section 1 now reads Causoryn's own `graph.sqlite` in the benchmark's temporary data directory after the cold server process has exited. The database is opened read-only (`readonly: true, fileMustExist: true`) with the `better-sqlite3` driver bundled inside the unpacked tarball, so the script adds no dependency; the read runs in a short-lived child process ([`scripts/bench/read-edge-breakdown.mjs`](../../scripts/bench/read-edge-breakdown.mjs)) because Windows keeps a loaded native addon locked until its process exits, which would block removing the temporary directory. Only the **latest published snapshot** is counted (same ordering as the engine's workspace summary), and it must be the snapshot id that `causoryn_status` reported; otherwise the breakdown is reported as not measured, with the reason.

CALLS edges are split into four buckets (counts and % of all CALLS edges):

| Bucket | Definition |
|---|---|
| `verifiedInternal` | `resolution = verified`, target node is a project symbol (any kind other than `UnknownExternal`) |
| `verifiedExternal` | `resolution = verified`, target node kind is `UnknownExternal` (library / runtime / test-framework call) |
| `heuristic` | `resolution = heuristic` |
| `unresolved` | `resolution = unresolved` |

The **unresolved ratio per language** is `unresolved edges / all edges attributed to that language`, with counts. An edge is attributed to the language of its source node, else of its target node; `Workspace --CONTAINS-->` edges and edges between language-less nodes are listed as "(no language)". This is the same rule the engine uses for `coverage.byLanguage`, and the script cross-checks its database counts against the MCP `coverage` of the same snapshot (`consistencyWithMcpCoverage`). The Markdown report prints both tables under "CALLS Edge Resolution Breakdown" and "Unresolved Edge Ratio by Language", next to a note that `verifiedExternal` calls are not resolved internal edges.

New JSON fields (written with `--json`; the headline `selfRepo.unresolvedEdgePct` and `selfRepo.slos` are unchanged):

```text
selfRepo.edgeBreakdown = {
  available: true,
  source, databaseFile, workspaceId, snapshotId, snapshotState,
  totalEdges, unresolvedEdges, unresolvedPct,
  calls: { total, verifiedInternal, verifiedExternal, heuristic, unresolved,
           pct: { verifiedInternal, verifiedExternal, heuristic, unresolved } },
  byLanguage: { <language>: { totalEdges, verifiedEdges, heuristicEdges, unresolvedEdges,
                              unresolvedPct, calls: { ...same shape as calls } } },
  unattributed: { totalEdges, unresolvedEdges },
  consistencyWithMcpCoverage: { compared, totalsMatch, mismatchedLanguages }
}
// or, when it could not be measured:
selfRepo.edgeBreakdown = { available: false, reason }
```

Percentages are rounded to two decimals and are `null` when the denominator is 0. The counting logic lives in [`scripts/bench/calls-breakdown.mjs`](../../scripts/bench/calls-breakdown.mjs) and is unit-tested against a real-schema SQLite database, including parity with the engine's own per-language aggregation, in [`tests/bench-calls-breakdown.test.ts`](../../tests/bench-calls-breakdown.test.ts).

### Independent verification figures (2026-11-24, packed tarball)

The figures in this subsection come from an **independent verification run on the packed tarball on 2026-11-24**, compared with the same measurement on v0.2.4. They were not produced by the CI or by a run recorded in this repository; they are reproduced as reported so the headline can be read in context.

- Overall unresolved edge ratio (all edge kinds): **1.92% (761 / 39,578 edges)**, versus 33.5% in the v0.2.4 baseline recorded in the script (`V024_BASELINE`). The number is correct, but most of the change is in how external calls are labelled.
- CALLS edges, v0.2.4 → 2026-11-24 verification:

| CALLS bucket | v0.2.4 | 2026-11-24 verification |
|---|---|---|
| `unresolved` | 12,629 | 745 |
| `verifiedExternal` (verified, target `UnknownExternal`) | 8,200 | 16,434 |
| `verifiedInternal` (verified, target is a project symbol) | 6,999 | 9,756 |

- Arithmetic on these reported figures: unresolved CALLS fell by 11,884; `verifiedExternal` grew by 8,234 (about 70% of that reduction) and `verifiedInternal` by 2,757 (about 23%). The verification did not report `heuristic` CALLS counts, so the remaining part is not attributed here.
- The largest `verifiedExternal` targets were library and test calls such as `globalExpect` (1,866 edges), `JestAssertion.toBe` (1,551), and `Array.push`.
- Unresolved ratio per language (all edge kinds): Rust 63% (243 / 384), Python 51%, C# 33%, Go 18%. Counts were reported only for Rust. According to the verification, the non-TypeScript analyzers changed little versus v0.2.4; the overall figure is dominated by TypeScript edges because the self-repository is mostly TypeScript.

Re-running `node scripts/bench/real-repo-eval.mjs --json <out>` produces these breakdowns (`selfRepo.edgeBreakdown`) for the tarball under test.

## Related Pages

- [Architecture Overview](architecture.md) · [Host Compatibility Matrix](compatibility-matrix.md)
- [Security Audit](security-pass.md) · [Implementation Status](implementation-status.md)
- [Language Analyzers](language-analyzers.md) — `verified` / `heuristic` / `unresolved` conditions per language · [Tool Contracts](tool-contracts.md) — envelope `coverage` and `coverage.byLanguage`
