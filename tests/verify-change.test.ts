import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSnapshot,
  type NodeKind,
  type SnapshotEdgeInput,
  type SnapshotGraph,
  type SnapshotNodeInput,
} from "@causoryn/domain";
import {
  TEST_RUN_STATUS_SCHEMA,
  verifyChange,
  serializeVerificationReport,
} from "@causoryn/verification";
import {
  VerifyChangeDataSchema,
  VerifyChangeInputSchema,
  createCausorynContext,
  preflightChange,
  verifyChangeTool,
} from "@causoryn/mcp-server";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `causoryn-t16-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const FIXED_NOW = "2026-11-24T10:00:00.000Z";
const fixedClock = (): string => FIXED_NOW;

const POLICY_YAML = `version: 1
rules:
  - id: src-must-not-import-legacy
    type: forbidden-dependency
    severity: error
    from: "**/src/**"
    to: "**/legacy/**"
    edgeKinds: [IMPORTS]
`;

const WEAKENED_POLICY_YAML = `version: 1
rules: []
`;

const REPO_TS = `export class OrderRepository {
  find(id: string): string {
    return id;
  }
}
`;

const SERVICE_TS = `import { OrderRepository } from "./order-repo.js";

export class OrderService {
  private readonly repo: OrderRepository;
  constructor(repo: OrderRepository) {
    this.repo = repo;
  }
  place(id: string): string {
    return this.repo.find(id);
  }
}
`;

const TEST_TS = `import { OrderService } from "../src/order-service.js";
import { OrderRepository } from "../src/order-repo.js";

export function makeDefaultOrderService(): OrderService {
  return new OrderService(new OrderRepository());
}
`;

function writeTsFixture(root: string): void {
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "tests"), { recursive: true });
  mkdirSync(path.join(root, ".causoryn"), { recursive: true });
  writeFileSync(path.join(root, "src", "order-repo.ts"), REPO_TS, "utf8");
  writeFileSync(path.join(root, "src", "order-service.ts"), SERVICE_TS, "utf8");
  writeFileSync(path.join(root, "tests", "order-service.test.ts"), TEST_TS, "utf8");
  writeFileSync(path.join(root, ".causoryn", "architecture.rules.yaml"), POLICY_YAML, "utf8");
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    shell: false,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test Bot",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test Bot",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

function buildMiniSnapshot(): SnapshotGraph {
  const svcRef = { kind: "Class" as NodeKind, qualifiedName: "App.OrdersService", relativePath: "src/OrdersService.ts" };
  const testRef = { kind: "Test" as NodeKind, qualifiedName: "App.OrdersService tests", relativePath: "tests/OrdersService.test.ts" };
  const nodes: SnapshotNodeInput[] = [
    {
      kind: "Class",
      qualifiedName: svcRef.qualifiedName,
      relativePath: svcRef.relativePath,
      language: "typescript",
      location: { relativePath: svcRef.relativePath, startLine: 1, endLine: 10, sourceHash: "sha256:svc" },
    },
    {
      kind: "Test",
      qualifiedName: testRef.qualifiedName,
      relativePath: testRef.relativePath,
      language: "typescript",
      location: { relativePath: testRef.relativePath, startLine: 1, endLine: 10, sourceHash: "sha256:test" },
    },
  ];
  const edges: SnapshotEdgeInput[] = [
    {
      kind: "TESTS",
      from: testRef,
      to: svcRef,
      resolution: "verified",
      evidence: [
        {
          kind: "source",
          analyzerId: "fixture",
          analyzerVersion: "0.0.0",
          rationale: "fixture TESTS edge",
        },
      ],
    },
  ];
  return createSnapshot({
    workspaceId: "ws-t16",
    revision: { id: "rev-1", sequence: 1 },
    configHash: "cfg-1",
    analyzerFingerprint: "fp-1",
    state: "ready",
    createdAt: FIXED_NOW,
    nodes,
    edges,
  });
}

describe("Task 1.6 — verify_change defaults, async projection, trusted git rules, host_asserted honesty", () => {
  it("omits unevaluable 'contracts' from default checks so default verify_change does NOT degrade to inconclusive", async () => {
    const root = makeTempDir("default-checks");
    writeTsFixture(root);
    // Rules committed at HEAD: the clean default path is the trusted-rules
    // path (working-tree rules can never produce no_findings).
    runGit(root, ["init", "-q"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-q", "-m", "initial commit with architecture rules"]);
    const context = createCausorynContext(
      { workspaceId: "default", allowRoots: [root], autoIndex: true },
      { clock: fixedClock },
    );
    try {
      const pf = await preflightChange(context, "req-pf-1", {
        intent: "update order repository",
        targetFiles: ["src/order-service.ts"],
      });
      const preflightId = (pf.data as Record<string, unknown>).preflightId as string;

      writeFileSync(
        path.join(root, "src", "order-repo.ts"),
        REPO_TS.replace("return id;", 'return id.trim();'),
        "utf8",
      );

      // Call verify_change WITHOUT specifying checks -> defaults to architecture, graph-diff, test-plan.
      const envelope = await verifyChangeTool(
        context,
        "req-verify-default",
        VerifyChangeInputSchema.parse({ preflightId }),
      );
      expect(envelope.status).toBe("ok");
      const data = VerifyChangeDataSchema.parse(envelope.data);
      expect(data.requestedChecks).toEqual(["architecture", "graph-diff", "test-plan"]);
      expect(data.checks.contracts.status).toBe("not_requested");
      expect(data.checks.architecture.status).toBe("evaluated");
      expect(data.checks.graphDiff.status).toBe("evaluated");
      expect(data.checks.testPlan.status).toBe("evaluated");
      expect(data.incompleteChecks).toEqual([]);
      expect(data.verdict).toBe("no_findings");
      expect(data.trustWarning).toBeUndefined();
      expect(data.rulesProvenance?.source).toBe("git-ref");
      expect(data.rulesProvenance?.commit).toBe(runGit(root, ["rev-parse", "HEAD"]));

      // Explicitly requesting contracts still evaluates as not_evaluated -> inconclusive.
      const withContracts = await verifyChangeTool(
        context,
        "req-verify-contracts",
        VerifyChangeInputSchema.parse({
          preflightId,
          checks: ["architecture", "contracts", "graph-diff", "test-plan"],
        }),
      );
      const contractsData = VerifyChangeDataSchema.parse(withContracts.data);
      expect(contractsData.checks.contracts.status).toBe("not_evaluated");
      expect(contractsData.incompleteChecks).toEqual(["contracts"]);
      expect(contractsData.verdict).toBe("inconclusive");
    } finally {
      context.close();
    }
  }, 60_000);

  it("loads architecture.rules.yaml and architecture.baseline.yaml from trusted base git ref (HEAD), blocking attempts to weaken rules in the same diff", async () => {
    const root = makeTempDir("trusted-git-rules");
    writeTsFixture(root);
    runGit(root, ["init", "-q"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-q", "-m", "initial commit with strict architecture rules"]);

    const context = createCausorynContext(
      { workspaceId: "default", allowRoots: [root], autoIndex: true },
      { clock: fixedClock },
    );
    try {
      const pf = await preflightChange(context, "req-pf-git", {
        intent: "modify order service",
        targetFiles: ["src/order-service.ts"],
      });
      const preflightId = (pf.data as Record<string, unknown>).preflightId as string;

      // Agent introduces forbidden legacy import AND weakens rules.yaml AND adds an untracked baseline suppression!
      mkdirSync(path.join(root, "src", "legacy"), { recursive: true });
      writeFileSync(
        path.join(root, "src", "legacy", "old.ts"),
        'export function oldFn(): string { return "old"; }\n',
        "utf8",
      );
      writeFileSync(
        path.join(root, "src", "order-service.ts"),
        `import { OrderRepository } from "./order-repo.js";
import { oldFn } from "./legacy/old.js";

export class OrderService {
  private readonly repo: OrderRepository;
  constructor(repo: OrderRepository) {
    this.repo = repo;
  }
  place(id: string): string {
    return this.repo.find(id) + oldFn();
  }
}
`,
        "utf8",
      );
      writeFileSync(
        path.join(root, ".causoryn", "architecture.rules.yaml"),
        WEAKENED_POLICY_YAML,
        "utf8",
      );
      writeFileSync(
        path.join(root, ".causoryn", "architecture.baseline.yaml"),
        `version: 1
suppressions:
  - ruleId: src-must-not-import-legacy
    from: "**"
    to: "**"
    reason: "agent-injected bypass"
    owner: "untrusted"
    date: "2026-11-24"
`,
        "utf8",
      );

      const envelope = await verifyChangeTool(
        context,
        "req-verify-git-trusted",
        VerifyChangeInputSchema.parse({ preflightId }),
      );
      const data = VerifyChangeDataSchema.parse(envelope.data);
      // Must evaluate the trusted HEAD rules, NOT the weakened working-tree rules or untracked baseline!
      expect(data.verdict).toBe("blocking_findings");
      expect(data.architectureFindings.length).toBeGreaterThan(0);
      expect(data.architectureFindings[0]?.ruleId).toBe("src-must-not-import-legacy");
      expect(data.trustWarning).toBeUndefined();
      expect(
        envelope.warnings.some((w) => w.includes("architecture-rules-loaded-from-untrusted-working-tree")),
      ).toBe(false);

      // Explicit nonexistent baseRef must fail closed with INVALID_REVISION (cannot bypass trusted HEAD rules).
      await expect(
        verifyChangeTool(
          context,
          "req-verify-bad-baseref",
          VerifyChangeInputSchema.parse({ preflightId, baseRef: "nonexistent-ref-999" }),
        ),
      ).rejects.toMatchObject({ code: "INVALID_REVISION" });
    } finally {
      context.close();
    }
  }, 60_000);

  it("emits explicit trustWarning when falling back to untrusted working-tree rules (non-git or untracked)", async () => {
    // 1) Non-git workspace
    const nonGitRoot = makeTempDir("untrusted-nongit");
    writeTsFixture(nonGitRoot);
    const context = createCausorynContext(
      { workspaceId: "default", allowRoots: [nonGitRoot], autoIndex: true },
      { clock: fixedClock },
    );
    try {
      const latest = context.repository.getLatestPublished("default");
      expect(latest).toBeDefined();
      const envelope = await verifyChangeTool(
        context,
        "req-verify-nongit",
        VerifyChangeInputSchema.parse({ baseSnapshot: latest!.snapshot.meta.id }),
      );
      const data = VerifyChangeDataSchema.parse(envelope.data);
      expect(data.trustWarning).toBe("architecture-rules-loaded-from-untrusted-working-tree");
      expect(
        envelope.warnings.some((w) =>
          w.includes("architecture-rules-loaded-from-untrusted-working-tree"),
        ),
      ).toBe(true);
      // Clean architecture result + untrusted rules is never a clean pass.
      expect(data.checks.architecture.status).toBe("evaluated");
      expect(data.verdict).toBe("review_required");
      expect(data.verdictRationale[0]?.rule).toBe("untrusted-rules");
      expect(data.rulesProvenance?.source).toBe("working-tree");
      expect(data.rulesProvenance?.fallbackReason).toBe("ref-unreadable");
    } finally {
      context.close();
    }

    // 2) Git repo where .causoryn/architecture.rules.yaml is untracked (not in HEAD)
    const untrackedRoot = makeTempDir("untrusted-untracked");
    mkdirSync(path.join(untrackedRoot, "src"), { recursive: true });
    writeFileSync(path.join(untrackedRoot, "src", "order-repo.ts"), REPO_TS, "utf8");
    runGit(untrackedRoot, ["init", "-q"]);
    runGit(untrackedRoot, ["add", "."]);
    runGit(untrackedRoot, ["commit", "-q", "-m", "initial commit without rules"]);
    mkdirSync(path.join(untrackedRoot, ".causoryn"), { recursive: true });
    writeFileSync(
      path.join(untrackedRoot, ".causoryn", "architecture.rules.yaml"),
      POLICY_YAML,
      "utf8",
    );

    const gitCtx = createCausorynContext(
      { workspaceId: "default", allowRoots: [untrackedRoot], autoIndex: true },
      { clock: fixedClock },
    );
    try {
      const latest = gitCtx.repository.getLatestPublished("default");
      const envelope = await verifyChangeTool(
        gitCtx,
        "req-verify-untracked",
        VerifyChangeInputSchema.parse({ baseSnapshot: latest!.snapshot.meta.id }),
      );
      const data = VerifyChangeDataSchema.parse(envelope.data);
      expect(data.trustWarning).toBe("architecture-rules-loaded-from-untrusted-working-tree");
      expect(
        envelope.warnings.some((w) =>
          w.includes("architecture-rules-loaded-from-untrusted-working-tree"),
        ),
      ).toBe(true);
      expect(data.verdict).toBe("review_required");
      expect(data.verdictRationale[0]?.rule).toBe("untrusted-rules");
      expect(data.rulesProvenance).toEqual({
        source: "working-tree",
        ref: "HEAD",
        refOrigin: "default-head",
        fallbackReason: "rules-not-in-ref",
      });
    } finally {
      gitCtx.close();
    }
  }, 60_000);

  it("an unreadable trusted base (repository without commits) falls back to working-tree rules but never yields no_findings", async () => {
    const root = makeTempDir("unborn-head");
    writeTsFixture(root);
    runGit(root, ["init", "-q"]);
    const context = createCausorynContext(
      { workspaceId: "default", allowRoots: [root], autoIndex: true },
      { clock: fixedClock },
    );
    try {
      const latest = context.repository.getLatestPublished("default");
      expect(latest).toBeDefined();
      const envelope = await verifyChangeTool(
        context,
        "req-verify-unborn",
        VerifyChangeInputSchema.parse({ baseSnapshot: latest!.snapshot.meta.id }),
      );
      const data = VerifyChangeDataSchema.parse(envelope.data);
      expect(data.checks.architecture.status).toBe("evaluated");
      expect(data.verdict).toBe("review_required");
      expect(data.verdictRationale[0]?.rule).toBe("untrusted-rules");
      expect(data.trustWarning).toBe("architecture-rules-loaded-from-untrusted-working-tree");
      expect(data.rulesProvenance?.source).toBe("working-tree");
      expect(data.rulesProvenance?.fallbackReason).toBe("ref-unreadable");
    } finally {
      context.close();
    }
  }, 60_000);

  it("a refused repository layout (.git file pointing to another repository) falls back to working-tree rules, never no_findings", async () => {
    const root = makeTempDir("refused-layout");
    writeTsFixture(root);
    // A separate repository outside the analyzed root, with the same rules committed.
    const other = makeTempDir("refused-layout-other");
    writeTsFixture(other);
    runGit(other, ["init", "-q"]);
    runGit(other, ["add", "."]);
    runGit(other, ["commit", "-q", "-m", "other repository"]);
    writeFileSync(path.join(root, ".git"), `gitdir: ${path.join(other, ".git")}\n`, "utf8");
    const context = createCausorynContext(
      { workspaceId: "default", allowRoots: [root], autoIndex: true },
      { clock: fixedClock },
    );
    try {
      const latest = context.repository.getLatestPublished("default");
      expect(latest).toBeDefined();
      const envelope = await verifyChangeTool(
        context,
        "req-verify-refused-layout",
        VerifyChangeInputSchema.parse({ baseSnapshot: latest!.snapshot.meta.id }),
      );
      const data = VerifyChangeDataSchema.parse(envelope.data);
      expect(data.verdict).toBe("review_required");
      expect(data.verdictRationale[0]?.rule).toBe("untrusted-rules");
      expect(data.rulesProvenance?.source).toBe("working-tree");
      expect(data.rulesProvenance?.fallbackReason).toBe("ref-unreadable");
    } finally {
      context.close();
    }
  }, 60_000);

  it("keeps host-asserted observedTestRun.evidenceIds out of the report's engine evidence over verifyChangeTool", async () => {
    const root = makeTempDir("host-evidence-isolation");
    writeTsFixture(root);
    const context = createCausorynContext(
      { workspaceId: "default", allowRoots: [root], autoIndex: true },
      { clock: fixedClock },
    );
    try {
      const pf = await preflightChange(context, "req-pf-host-ev", {
        intent: "host evidence isolation",
        targetFiles: ["src/order-service.ts"],
      });
      const preflightId = (pf.data as Record<string, unknown>).preflightId as string;
      const envelope = await verifyChangeTool(
        context,
        "req-verify-host-ev",
        VerifyChangeInputSchema.parse({
          preflightId,
          checks: ["test-plan", "graph-diff"],
          observedTestRun: {
            state: "host_asserted",
            evidenceRef: "reports/vitest.json",
            observedCount: 1,
            evidenceIds: ["host-claimed-evidence-mcp"],
          },
        }),
      );
      const data = VerifyChangeDataSchema.parse(envelope.data);
      if (data.tests.state !== "host_asserted") throw new Error("expected host_asserted");
      expect(data.tests.evidenceIds).toEqual(["host-claimed-evidence-mcp"]);
      expect(data.evidenceIds).not.toContain("host-claimed-evidence-mcp");
      expect(data.checks.testPlan.evidenceIds).not.toContain("host-claimed-evidence-mcp");
    } finally {
      context.close();
    }
  }, 60_000);

  it("projects working tree asynchronously via runIndexAsync so non-TS languages do NOT degrade to sync L0", async () => {
    const root = makeTempDir("async-projection-py");
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "calc.py"),
      "def add(a: int, b: int) -> int:\n    return a + b\n",
      "utf8",
    );
    const context = createCausorynContext(
      { workspaceId: "default", allowRoots: [root], autoIndex: false },
      { clock: fixedClock },
    );
    try {
      // Establish an async base snapshot first (at L1/L2 parity).
      const baseRun = await context.indexService.runIndexAsync(root);
      const envelope = await verifyChangeTool(
        context,
        "req-verify-py-async",
        VerifyChangeInputSchema.parse({
          baseSnapshot: baseRun.snapshotId,
          checks: ["graph-diff"],
        }),
      );
      // Must NOT emit synchronous L0 degradation warning ("synchronous run cannot perform deep ... symbol analysis")
      expect(
        envelope.warnings.some((w) => w.includes("synchronous run cannot perform deep") || w.includes("sync-run-degraded")),
      ).toBe(false);
      const data = VerifyChangeDataSchema.parse(envelope.data);
      // Unchanged workspace against async base snapshot should have 0 node diff!
      expect(data.checks.graphDiff.diffSummary.added).toBe(0);
      expect(data.checks.graphDiff.diffSummary.removed).toBe(0);
      expect(data.checks.graphDiff.diffSummary.changed).toBe(0);
    } finally {
      context.close();
    }
  }, 60_000);

  it("reports host-supplied test results honestly as state: 'host_asserted' with engineVerified: false (never engine-verified 'observed' / passed: true)", () => {
    const snap = buildMiniSnapshot();

    // 1) Passing host-supplied test run
    const passingReport = verifyChange({
      baseSnapshot: snap,
      targetSnapshot: snap,
      changedSymbols: ["App.OrdersService"],
      checks: ["test-plan", "graph-diff"],
      observedTestRun: {
        state: "observed",
        evidenceRef: "reports/vitest-summary.json",
        evidenceSha256: "a".repeat(64),
        observedCount: 2,
        passedCount: 2,
        failedCount: 0,
        testNames: ["App.OrdersService tests"],
      },
    });

    expect(passingReport.tests.state).toBe("host_asserted");
    if (passingReport.tests.state !== "host_asserted") {
      throw new Error("Expected host_asserted state");
    }
    expect(passingReport.tests.engineVerified).toBe(false);
    expect(passingReport.tests.hostAssertedPassed).toBe(true);
    expect("passed" in passingReport.tests).toBe(false);
    expect(passingReport.checks.testPlan.run.state).toBe("host_asserted");
    expect(passingReport.checks.testPlan.candidateStatuses[0]?.status).toBe("host_asserted");
    expect(
      passingReport.disclaimers.some(
        (d) => d.includes("host_asserted") && d.includes("engineVerified=false"),
      ),
    ).toBe(true);

    // Byte-deterministic serialization includes host_asserted + engineVerified:false, never "passed":true
    const serialized = serializeVerificationReport(passingReport);
    expect(serialized).toContain('"state":"host_asserted"');
    expect(serialized).toContain('"engineVerified":false');
    expect(serialized).toContain('"hostAssertedPassed":true');
    expect(serialized).not.toContain('"passed":true');

    // 2) Failing host-supplied test run -> hostAssertedPassed: false, engineVerified: false
    const failingReport = verifyChange({
      baseSnapshot: snap,
      targetSnapshot: snap,
      changedSymbols: ["App.OrdersService"],
      checks: ["test-plan", "graph-diff"],
      observedTestRun: {
        state: "host_asserted",
        evidenceRef: "reports/vitest-summary.json",
        observedCount: 3,
        passedCount: 1,
        failedCount: 2,
      },
    });
    expect(failingReport.tests.state).toBe("host_asserted");
    if (failingReport.tests.state !== "host_asserted") {
      throw new Error("Expected host_asserted state");
    }
    expect(failingReport.tests.engineVerified).toBe(false);
    expect(failingReport.tests.hostAssertedPassed).toBe(false);
    expect("passed" in failingReport.tests).toBe(false);

    // 3) Schema rejects legacy "observed" output, engineVerified:true, and forged passed:true
    expect(
      TEST_RUN_STATUS_SCHEMA.safeParse({
        state: "observed",
        recommendedCount: 1,
        observedCount: 1,
        evidenceRef: "reports/vitest.json",
        passed: true,
        passedCount: 1,
        failedCount: 0,
      }).success,
    ).toBe(false);

    expect(
      TEST_RUN_STATUS_SCHEMA.safeParse({
        state: "host_asserted",
        engineVerified: true,
        hostAssertedPassed: true,
        recommendedCount: 1,
        observedCount: 1,
        evidenceRef: "reports/vitest.json",
        passedCount: 1,
        failedCount: 0,
      }).success,
    ).toBe(false);

    expect(
      TEST_RUN_STATUS_SCHEMA.safeParse({
        state: "host_asserted",
        engineVerified: false,
        hostAssertedPassed: true,
        recommendedCount: 1,
        observedCount: 1,
        evidenceRef: "reports/vitest.json",
        passed: true,
        passedCount: 1,
        failedCount: 0,
      }).success,
    ).toBe(false);

    expect(
      TEST_RUN_STATUS_SCHEMA.safeParse({
        state: "host_asserted",
        engineVerified: false,
        hostAssertedPassed: true,
        recommendedCount: 1,
        observedCount: 2,
        evidenceRef: "reports/vitest.json",
        passedCount: 1,
        failedCount: 1,
      }).success,
    ).toBe(false);

    expect(TEST_RUN_STATUS_SCHEMA.safeParse(passingReport.tests).success).toBe(true);
    expect(TEST_RUN_STATUS_SCHEMA.safeParse(failingReport.tests).success).toBe(true);
  });

  it("supports explicit baseRef commit SHA, rejects baseRef='working-tree' and invalid refs, and exposes host_asserted over verifyChangeTool", async () => {
    const root = makeTempDir("explicit-baseref-and-mcp-host-asserted");
    writeTsFixture(root);
    runGit(root, ["init", "-q"]);
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-q", "-m", "commit 1: strict rules"]);
    const strictCommitSha = runGit(root, ["rev-parse", "HEAD"]);

    // Commit 2 weakens rules in HEAD, but caller pins baseRef to commit 1!
    writeFileSync(
      path.join(root, ".causoryn", "architecture.rules.yaml"),
      WEAKENED_POLICY_YAML,
      "utf8",
    );
    mkdirSync(path.join(root, "src", "legacy"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "legacy", "old.ts"),
      'export function oldFn(): string { return "old"; }\n',
      "utf8",
    );
    writeFileSync(
      path.join(root, "src", "order-service.ts"),
      `import { OrderRepository } from "./order-repo.js";\nimport { oldFn } from "./legacy/old.js";\nexport class OrderService {\n  constructor(private readonly repo: OrderRepository) {}\n  place(id: string): string {\n    return this.repo.find(id) + oldFn();\n  }\n}\n`,
      "utf8",
    );
    runGit(root, ["add", "."]);
    runGit(root, ["commit", "-q", "-m", "commit 2: weakened rules"]);

    const context = createCausorynContext(
      { workspaceId: "default", allowRoots: [root], autoIndex: true },
      { clock: fixedClock },
    );
    try {
      const latest = context.repository.getLatestPublished("default");
      expect(latest).toBeDefined();
      const baseSnapshot = latest!.snapshot.meta.id;

      // 1) Explicit baseRef=strictCommitSha loads commit 1's strict rules and catches violation
      const pinned = await verifyChangeTool(
        context,
        "req-verify-pinned",
        VerifyChangeInputSchema.parse({
          baseSnapshot,
          baseRef: strictCommitSha,
          checks: ["architecture", "graph-diff"],
        }),
      );
      const pinnedData = VerifyChangeDataSchema.parse(pinned.data);
      expect(pinnedData.verdict).toBe("blocking_findings");
      expect(pinnedData.trustWarning).toBeUndefined();
      // An explicit (older) baseRef is the caller's trusted choice; the report names it.
      expect(pinnedData.rulesProvenance).toEqual({
        source: "git-ref",
        ref: strictCommitSha,
        commit: strictCommitSha,
        refOrigin: "explicit",
      });

      // 2) baseRef='working-tree' is rejected fail-closed with INVALID_ARGUMENT
      await expect(
        verifyChangeTool(
          context,
          "req-verify-wt-ref",
          VerifyChangeInputSchema.parse({
            baseSnapshot,
            baseRef: "working-tree",
            checks: ["architecture"],
          }),
        ),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

      // 3) Invalid git ref is rejected fail-closed with INVALID_ARGUMENT
      await expect(
        verifyChangeTool(
          context,
          "req-verify-bad-ref",
          VerifyChangeInputSchema.parse({
            baseSnapshot,
            baseRef: "--exec=evil",
            checks: ["architecture"],
          }),
        ),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

      // 4) MCP verifyChangeTool reports host_asserted with engineVerified:false on observedTestRun
      const pf = await preflightChange(context, "req-pf-obs", {
        intent: "verify host_asserted via MCP tool",
        targetFiles: ["src/order-service.ts"],
      });
      const preflightId = (pf.data as Record<string, unknown>).preflightId as string;
      const firstRun = await verifyChangeTool(
        context,
        "req-verify-candidates",
        VerifyChangeInputSchema.parse({ preflightId, checks: ["test-plan"] }),
      );
      const firstData = VerifyChangeDataSchema.parse(firstRun.data);
      const candidateName = firstData.checks.testPlan.candidates[0]?.testQualifiedName;
      expect(candidateName).toBeDefined();

      const withHostRun = await verifyChangeTool(
        context,
        "req-verify-host-asserted",
        VerifyChangeInputSchema.parse({
          preflightId,
          checks: ["test-plan"],
          observedTestRun: {
            state: "observed",
            evidenceRef: "reports/vitest.json",
            observedCount: 1,
            passedCount: 1,
            failedCount: 0,
            testNames: [candidateName!],
          },
        }),
      );
      const hostData = VerifyChangeDataSchema.parse(withHostRun.data);
      expect(hostData.tests.state).toBe("host_asserted");
      if (hostData.tests.state !== "host_asserted") throw new Error("expected host_asserted");
      expect(hostData.tests.engineVerified).toBe(false);
      expect(hostData.tests.hostAssertedPassed).toBe(true);
      expect("passed" in hostData.tests).toBe(false);
      expect(hostData.checks.testPlan.candidateStatuses[0]?.status).toBe("host_asserted");
    } finally {
      context.close();
    }
  }, 60_000);
});
