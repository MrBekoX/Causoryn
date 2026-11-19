---
name: preflight-change
description: Run deterministic pre-change blast-radius, contract compatibility, and candidate test-plan analysis with causoryn_preflight_change before editing shared symbols, routes, schemas, or multi-module code.
---

# preflight-change — Pre-Change Impact, Contract & Test Plan Runbook

Use this skill **before** modifying existing functions, classes, endpoints, database schemas,
or public contracts so your edit plan is grounded in verified static graph evidence rather
than guesswork.

## Step-by-Step Procedure

1. **Ensure Snapshot Freshness**
   - Check `causoryn_index_status`. If no snapshot is published (`INDEX_NOT_READY`) or the snapshot is stale after recent file edits, run `causoryn_refresh_index` first.
2. **Resolve Target Identifiers**
   - If you only have partial symbol names, resolve exact qualified names or node IDs via `causoryn_find_symbols` and `causoryn_get_symbol_context`.
3. **Generate the Candidate-Only Preflight Manifest**
   - Call `causoryn_preflight_change` with:
     - `intent`: concise description of the planned change
     - `targetSymbols` and/or `targetFiles`: workspace-relative paths or resolved symbol identifiers
   - Inspect the returned manifest:
     - `preflightId`: **keep this ID** in your working notes to pass into `causoryn_verify_change` after editing!
     - `candidateOnly`: always `true` — preflight never edits code and never claims exhaustive runtime completeness.
     - `requiresDisambiguation` / `candidateTargets`: if `true`, narrow ambiguous targets and re-run `causoryn_preflight_change` instead of guessing.
     - Impact items keep `certainty` (`direct | indirect | possible`) and edge `resolution` (`verified | heuristic | unresolved`) in separate fields.
     - `testPlanId`: content-addressed reference (`testplan:<sha256>`) matching `causoryn_derive_test_plan`.
     - `limitations` and `warnings`: surface these explicitly when summarizing risk.
4. **Deepen Analysis When Needed**
   - Call `causoryn_analyze_impact` when you need full reverse-BFS `impactPaths` across callers and consumers.
   - Call `causoryn_check_contracts` (`contracts: [{ name, base, target }]`) or `causoryn_detect_contract_drift` when modifying OpenAPI, AsyncAPI, JSON Schema, SQL, or `.proto` files (`CONTRACT_PARSE_FAILED` indicates malformed spec syntax).
   - Call `causoryn_derive_test_plan` to inspect `direct`, `call-site`, and `naming` test candidates plus `missingCoverageCandidates`.
   - Call `causoryn_get_evidence` to inspect exact source lines backing critical dependency edges.

## Strict Honesty Boundaries

- **Read-only guarantee:** `causoryn_preflight_change` and `causoryn_derive_test_plan` never modify files and never execute tests.
- **No 100% impact claims:** Static analysis cannot observe dynamic reflection or unindexed external consumers; always preserve `heuristic` / `possible` / `unknown` qualifiers verbatim.
