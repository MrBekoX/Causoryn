# Causoryn Performance Benchmarks

**Language / Dil:** [Türkçe](../benchmarks.md) | English

> Evidence: `raw/Causoryn_Teknik_Dokuman_v2.1.pdf` §21 (p.22): "On a 1,000-TS-file fixture: warm `workspace_summary` < 1 s, small graph neighborhood < 500 ms, bounded 200-node map < 2 s." The specification explicitly defines these numbers as **design targets, not achieved test results**. Accordingly, the target column below is provided strictly as a **reference**, and only actually measured values are reported.
> ADR-010 honesty rule: anything unmeasured is never reported as measured — any row hitting an environment interruption or call deadline is recorded as `not measured (<reason>)`.

## Current Performance Scope (`v0.2.3`)

The F7 table below records the historical November 10, 2026 synthetic 1,000-file fixture run. Subsequent releases added four core execution improvements for large workspaces: `v0.2.1` deferred initial indexing to a background job after the MCP handshake and batched SQLite bulk writes in transactions; `v0.2.2` introduced a bounded (up to 4-entry) `PRAGMA data_version`-guarded warm snapshot cache plus default clustered architecture views (with the raw dump available via `view="full"`); and `v0.2.3` (`K-024`) added non-blocking `collectInventoryAsync` scanning (yielding every 64 entries) alongside a zero-RegExp polynomial-time glob matcher. No synthetic or unmeasured timings have been added for these later optimizations — the F7 table reports only actually executed measurements. [Release notes](../../CHANGELOG.md) · [Tool contracts](tool-contracts.md)

## Methodology

- Fixture: deterministic synthetic TypeScript workspace, 1,000 files (generator: `tests/bench-release/fixture.ts`; identical `fileCount` → byte-for-byte identical content; sha256: `2b14c5ab89f5f1c2059f3152d5da6156d726d9d498343acd2fbf2aea64e8d958`).
- Measured at the MCP protocol layer (`client.callTool` over `@modelcontextprotocol/sdk` `InMemoryTransport`); timing via `process.hrtime.bigint()`; each measurement runs 1 unmeasured warm-up call + N timed runs and reports the median; a per-call deadline breach or exception marks the row `'not measured'`.
- Per-call deadline: 30000 ms.
- Cold index (informational): no fixed wall-clock SLA is promised in Spec §21; measured: 16370.3 ms (1,000 files).
- Snapshot state: `ready`; adapter diagnostics (Spec §21 `parse_errors` metric): `0` (diagnostic-free fixture; `state=ready`).
- Environment: node v24.16.0, win32 10.0.26300 x64, CPU: Intel(R) Core(TM) i7-10750H CPU @ 2.60GHz, memory: 32 GB.
- Reproduction: `CAUSORYN_BENCH_WRITE_DOCS=1 npm run bench` (config: `vitest.bench.config.ts`; the default `vitest` run excludes `tests/bench-release/**` and never writes to the repository — ADR-008 read-only test discipline).

## Results — Run 2026-11-10T19:29:35.301Z

| Measurement | Tool Call | Target (Spec §21 reference — design target, not result) | Runs (ms, N=3) | Median (ms) | Assessment |
|---|---|---|---|---|---|
| workspace_summary_warm | `causoryn_workspace_summary` {} | < 1000 ms | 11.9 / 11.0 / 11.8 | 11.8 | within target (reference < 1000 ms) |
| graph_neighborhood_small | `causoryn_get_symbol_context` { symbolId: <first class>, depth: 1 } | < 500 ms | 13.0 / 14.9 / 12.3 | 13.0 | within target (reference < 500 ms) |
| map_system_200 | `causoryn_map_system` { level: "L2", maxNodes: 200 } | < 2000 ms | 20.5 / 10.7 / 9.3 | 10.7 | within target (reference < 2000 ms) |

## Notes

- Measurements span the full MCP protocol call path: engine query execution, Zod input validation, and structured envelope serialization are all included in the elapsed time.
- Individual samples are sensitive to host machine load. Use the **Median (ms)** column for comparisons. The same `fileCount` and generator produce identical fixture bytes. Timing depends on the measurement environment.
- The fixture SHA-256 literal is cross-pinned against `buildFixtureModel(1000).hash` in `tests/release-docs.test.ts` so the documented hash cannot silently drift if the generator changes.

## Related Pages

- [architecture.md](architecture.md) — build and benchmark separation contract (`vitest.bench.config.ts`)
- [compatibility-matrix.md](compatibility-matrix.md) — host compatibility and performance evidence summary
- [security-pass.md](security-pass.md) — F6 packaged-bundle security matrix
- [implementation-status.md](implementation-status.md) — Sprint 7 F7 evidence record
