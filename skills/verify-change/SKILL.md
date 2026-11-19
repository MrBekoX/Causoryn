---
name: verify-change
description: Verify working-tree code modifications after editing by running causoryn_verify_change, causoryn_check_architecture, and contract drift checks with byte-deterministic, evidence-backed reporting.
---

# verify-change — Post-Change Architectural & Contract Verification Runbook

Use this skill **after** making working-tree edits (and running relevant tests in the host
terminal) to verify architectural boundaries, graph diffs, and test-plan coverage against
the pre-change baseline.

## Step-by-Step Procedure

1. **Run `causoryn_verify_change`**
   - Pass `preflightId` (from an earlier `causoryn_preflight_change` call in the same MCP server session) or an explicit `baseSnapshot` ID. At least one is required; if both are supplied they must match the same base snapshot.
   - If you executed tests via host tools and have a verifiable evidence reference (`evidenceRef`), supply host test observations honestly; otherwise leave test execution status at its default `not_run`.
2. **Interpret the Verification Verdict & Checks**
   - Deterministic verdicts: `no_findings` | `review_required` | `blocking_findings` | `inconclusive`.
   - Four check surfaces:
     - `architecture`: evaluates `.causoryn/architecture.rules.yaml` (`no-cycles` SCC + `forbidden-dependency` globs). If no policy file exists in the workspace, it reports `not_evaluated` rather than failing.
     - `contracts`: `causoryn_verify_change` reports `not_evaluated` when no spec-pair inputs exist on this surface; run `causoryn_check_contracts` or `causoryn_detect_contract_drift` directly whenever API/schema specs changed!
     - `graph-diff`: added, removed, and modified symbols/edges between the base snapshot and the working-tree projection.
     - `test-plan`: maps candidate tests from `causoryn_derive_test_plan` with honest run status (`not_run` vs evidence-backed `observed`).
3. **Follow-Up Diagnostics**
   - If `architecture` reports rule violations or `POLICY_INVALID`, call `causoryn_check_architecture` directly and inspect offending edges with `causoryn_get_evidence`.
   - To compare committed git revisions (`baseRef` vs `targetRef`), call `causoryn_compare_architecture` (`INVALID_REVISION` indicates an unresolvable ref or missing snapshot blob).

## Strict Honesty Boundaries

- **Writes no code, runs no tests:** `causoryn_verify_change` only verifies static projections; it never alters the working tree and never executes a test runner.
- **`no_findings` is not a blanket guarantee:** Always report `incompleteChecks`, `disclaimers`, and `warnings` alongside the verdict, and never claim tests `"passed"` when their status is `not_run`.
