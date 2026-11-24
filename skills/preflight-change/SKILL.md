---
name: preflight-change
description: Run deterministic pre-change blast-radius, contract compatibility, and candidate test-plan analysis with causoryn_preflight_change before editing shared symbols, routes, schemas, or multi-module code.
---

# preflight-change — Pre-Change Impact, Contract & Test Plan Runbook

Use this skill **before** modifying existing functions, classes, endpoints, database schemas,
or public contracts so your edit plan is grounded in verified static graph evidence rather
than guesswork. Every tool named here is part of the default `core` tool profile.

## Step-by-Step Procedure

1. **Ensure Snapshot Freshness**
   - Call `causoryn_status` `{"action": "inspect"}`. If no snapshot is published (`INDEX_NOT_READY`) or `data.index.latestSnapshot.stale` is `true` after recent file edits, call `causoryn_status` `{"action": "refresh", "mode": "incremental"}` first and poll `causoryn_status` `{"action": "inspect", "jobId": "<jobId>"}` until the job is `done`.
2. **Resolve Target Identifiers**
   - If you only have partial symbol names, resolve exact qualified names or node IDs with `causoryn_find_symbols` `{"query": "<partial name>"}` and confirm them with `causoryn_get_symbol_context` `{"symbolId": "<node id or exact qualifiedName>"}`.
3. **Generate the Candidate-Only Preflight Manifest**
   - Call `causoryn_preflight_change` `{"intent": "<concise description of the planned change>", "targetSymbols": ["<resolved symbol>"], "targetFiles": ["<workspace-relative path>"]}` (`targetSymbols` and `targetFiles` are each optional, but give at least one).
   - Inspect the returned manifest:
     - `preflightId`: **keep this ID** in your working notes to pass into `causoryn_verify_change` after editing.
     - `candidateOnly`: always `true` — preflight never edits code and never claims exhaustive runtime completeness.
     - `requiresDisambiguation` / `candidateTargets`: if `true`, narrow ambiguous targets and re-run `causoryn_preflight_change` instead of guessing.
     - `impactCandidates` keep `certainty` (`direct | indirect | possible`) and edge `resolution` (`verified | heuristic | unresolved`) in separate fields.
     - `testPlanId` (`testplan:<sha256>`) and the embedded `testPlan`: candidate tests derived without running anything.
     - `limitations` and `warnings`: surface these explicitly when summarizing risk.
4. **Deepen Analysis When Needed**
   - Impact paths only: `causoryn_preflight_change` `{"include": ["impact"], "targetSymbols": ["<resolved symbol>"], "maxDepth": 4}` returns reverse-dependency `paths` and `affectedNodes` across callers and consumers (do not pass `intent` or `targetFiles` with this form).
   - Test plan only, for a preflight you already ran in this server session: `causoryn_preflight_change` `{"include": ["test-plan"], "preflightId": "<preflightId>"}` lists `direct`, `call-site`, and `naming` test `candidates` plus `missingCoverageCandidates`.
   - Contract pairs (OpenAPI, AsyncAPI, JSON Schema, SQL, or `.proto`): `causoryn_contracts` `{"action": "check", "contracts": [{"name": "<label>", "base": "<old spec path>", "target": "<new spec path>"}]}` (`CONTRACT_PARSE_FAILED` indicates malformed spec syntax).
   - Contract drift with producer/consumer impact: `causoryn_contracts` `{"action": "drift", "base": ["<old spec path>"], "target": ["<new spec path>"], "anchorFiles": ["<source file that produces or consumes the contract>"]}`.
   - Exact source lines behind a critical dependency edge: `causoryn_get_evidence` `{"id": "<edge or evidence id>"}`.

## Strict Honesty Boundaries

- **Read-only guarantee:** `causoryn_preflight_change` never modifies files and never executes tests, including its `include: ["test-plan"]` form.
- **No 100% impact claims:** Static analysis cannot observe dynamic reflection or unindexed external consumers; always preserve `heuristic` / `possible` / `unknown` qualifiers verbatim.
