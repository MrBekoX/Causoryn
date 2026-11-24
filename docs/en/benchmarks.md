# Causoryn Performance Benchmarks

> **Language:** [Türkçe](../benchmarks.md) | **English** · [Documentation Hub](README.md)

**Measurement honesty rule:** Unmeasured numbers are never reported as measured results. Reference design targets below serve purely as comparison baselines; only actually executed measurements are reported in the results table.

## Current Runtime & Scalability Architecture

The table below preserves the dated November 10, 2026 synthetic 1,000-file TypeScript fixture benchmark. Subsequent runtime upgrades targeting warm latency, event-loop responsiveness, memory overhead, and incremental rebuilds include:

- **Warm startup metadata reads & streaming SHA-256 hashing:** `getLatestSnapshotMeta` avoids hydrating full graphs during startup; `computeStreamingSnapshotId` hashes nodes, edges, and evidence in a streaming pass without giant monolithic JSON string allocations; `MAX_PUBLISHED_CACHE_ENTRIES = 1` curbs warm RSS; `pruneOldSnapshots` retains the latest 2 published snapshots and removes orphan `symbol_fts` rows.
- **Non-blocking `worker_threads` WAL indexing:** Full and incremental analysis run off the MCP event loop in `dist/index-worker.mjs` over SQLite WAL (`PRAGMA busy_timeout=5000`), streaming `notifications/progress` while serving concurrent queries from existing snapshots.
- **Per-file incremental indexing (`file_facts`) with early cutoff:** Unchanged files reuse cached SQLite `file_facts`; comment/formatting/body-only edits that preserve `public_interface_hash` skip reverse dependents (early cutoff) and reuse the prior TypeScript `oldProgram`.
- **Non-blocking inventory & zero-RegExp matching:** `collectInventoryAsync` yields every 64 entries and `ignore-matcher.ts` runs in linear/polynomial time with zero `RegExp` backtracking.

No unmeasured timings are fabricated for these later improvements; the table below records only the executed 2026-11-10 fixture benchmark run.

## Methodology (1,000-File Synthetic Fixture)

- **Fixture:** Deterministic synthetic TypeScript workspace, 1,000 files (`tests/bench-release/fixture.ts`; identical `fileCount` produces byte-identical content; sha256: `2b14c5ab89f5f1c2059f3152d5da6156d726d9d498343acd2fbf2aea64e8d958`).
- **Measurement layer:** MCP protocol layer (`client.callTool` over `@modelcontextprotocol/sdk` `InMemoryTransport`), timed via `process.hrtime.bigint()`; 1 unmeasured warm-up call + N=3 timed runs reporting the median (per-call deadline: `30000 ms`).
- **Cold index (informational):** `16370.3 ms` (1,000 files), snapshot state `ready`, `0` parse diagnostics.
- **Environment:** Node.js `v24.16.0`, `win32 10.0.26300 x64`, Intel Core i7-10750H @ 2.60 GHz, 32 GB RAM.
- **Reproduction:** `CAUSORYN_BENCH_WRITE_DOCS=1 npm run bench` (`vitest.bench.config.ts`; excluded from default `npm test` so wall-clock measurements do not flake under parallel suite load).

## Results — Run 2026-11-10T19:29:35.301Z

| Measurement | Tool Call | Reference Design Target | Runs (ms, N=3) | Median (ms) | Assessment |
|---|---|---|---|---|---|
| `workspace_summary_warm` | `causoryn_workspace_summary` `{}` | < 1000 ms | 11.9 / 11.0 / 11.8 | 11.8 | within target (< 1000 ms) |
| `graph_neighborhood_small` | `causoryn_get_symbol_context` `{ symbolId: <first class>, depth: 1 }` | < 500 ms | 13.0 / 14.9 / 12.3 | 13.0 | within target (< 500 ms) |
| `map_system_200` | `causoryn_map_system` `{ level: "L2", maxNodes: 200 }` | < 2000 ms | 20.5 / 10.7 / 9.3 | 10.7 | within target (< 2000 ms) |

## Notes

- Measurements include full MCP protocol handling: Zod input validation, engine query execution, and structured envelope serialization.
- Individual samples vary with host load; compare using the **Median (ms)** column.
- The fixture SHA-256 digest is cross-pinned against `buildFixtureModel(1000).hash` in `tests/release-docs.test.ts` so the documented hash cannot silently drift.

## Related Pages

- [Architecture Overview](architecture.md) · [Host Compatibility Matrix](compatibility-matrix.md)
- [Security Audit](security-pass.md) · [Implementation Status](implementation-status.md)
