---
name: verify-change
description: Verify working-tree code modifications after editing by running causoryn_verify_change (architecture rules, graph diff, test plan) and causoryn_contracts drift checks with byte-deterministic, evidence-backed reporting.
---

# verify-change — Post-Change Architectural & Contract Verification Runbook

Use this skill **after** making working-tree edits (and running relevant tests in the host
terminal) to verify architectural boundaries, graph diffs, and test-plan coverage against
the pre-change baseline. Every tool used by default here is part of the default `core`
tool profile.

## Step-by-Step Procedure

1. **Run `causoryn_verify_change`**
   - Pass `preflightId` (from an earlier `causoryn_preflight_change` call in the same MCP server session) or an explicit `baseSnapshot` ID: `causoryn_verify_change` `{"preflightId": "<preflightId>"}` or `causoryn_verify_change` `{"baseSnapshot": "<snapshotId>"}`. At least one is required (except for the standalone architecture check in step 3); if both are supplied they must match the same base snapshot.
   - Narrow the surfaces with `checks` (any of `architecture`, `contracts`, `graph-diff`, `test-plan`; default `architecture`, `graph-diff`, `test-plan`) and pick the trusted git ref for rule files with `baseRef` (default `HEAD`).
   - If you executed tests via host tools and have a verifiable evidence reference, report them honestly: `causoryn_verify_change` `{"preflightId": "<preflightId>", "observedTestRun": {"state": "host_asserted", "evidenceRef": "<test report path or CI run URL>", "observedCount": 12, "passedCount": 12, "failedCount": 0}}`. Otherwise omit `observedTestRun`; test execution status then stays `not_run`.
2. **Interpret the Verification Verdict & Checks**
   - Deterministic verdicts: `no_findings` | `review_required` | `blocking_findings` | `inconclusive`.
   - Rule provenance: `rulesProvenance` names where `.causoryn/architecture.rules.yaml` and the baseline were read from (`source`, `ref`, `commit`, `refOrigin`). If the rules file is not committed at the trusted base ref, or that ref cannot be read (no git repository, no commits), the rules come from the working tree: the report carries `trustWarning` and `rulesProvenance.source: "working-tree"`, and a result without findings is `review_required` (rule `untrusted-rules`), never `no_findings`. Commit the rules file, or pass a `baseRef` that contains it, to get a trusted result.
   - Four check surfaces:
     - `architecture`: evaluates `.causoryn/architecture.rules.yaml` (`no-cycles` SCC + `forbidden-dependency` globs). If no policy file exists in the workspace, it reports `not_evaluated` rather than failing.
     - `contracts`: reports `not_evaluated` when no spec-pair inputs exist on this surface; run `causoryn_contracts` directly whenever API/schema specs changed (see step 3).
     - `graph-diff`: added, removed, and modified symbols/edges between the base snapshot and the working-tree projection.
     - `test-plan`: maps candidate tests from the preflight test plan with honest run status (`not_run`, or `host_asserted` when you supplied `observedTestRun` — Causoryn records it as a host claim, never as engine-verified). Evidence IDs you pass in `observedTestRun.evidenceIds` appear only under `tests` / `checks.testPlan.run`, never in the report's top-level `evidenceIds`.
3. **Follow-Up Diagnostics**
   - If `architecture` reports rule violations or `POLICY_INVALID`, re-run the rules alone against the latest snapshot with `causoryn_verify_change` `{"checks": ["architecture"]}` and inspect offending edges with `causoryn_get_evidence` `{"id": "<edge or finding id>"}`.
   - If API/schema specs changed, check the pair with `causoryn_contracts` `{"action": "check", "contracts": [{"base": "<old spec path>", "target": "<new spec path>"}]}`.
   - For spec drift and the producers/consumers it touches, call `causoryn_contracts` `{"action": "drift", "base": ["<old spec path>"], "target": ["<new spec path>"]}`.
   - Comparing two committed git revisions needs `causoryn_compare_architecture`, which is only available with `--tool-profile history` (or `--tool-profile full`); each side uses the published local index when it provably matches that revision (or `working-tree`) and otherwise the committed `.causoryn/architecture-snapshot.json`, flagged with `snapshot-loaded-from-committed-git-blob` in `warnings`; `INVALID_REVISION` indicates an unresolvable ref or a ref with neither source.
   - Without that profile, do not call it: tell the user to add `--tool-profile history` to the `causoryn mcp` arguments of the host's MCP entry and restart the host.

## Strict Honesty Boundaries

- **Writes no code, runs no tests:** `causoryn_verify_change` only verifies static projections; it never alters the working tree and never executes a test runner.
- **`no_findings` is not a blanket guarantee:** Always report `incompleteChecks`, `disclaimers`, and `warnings` alongside the verdict, and never claim tests `"passed"` when their status is `not_run`.
