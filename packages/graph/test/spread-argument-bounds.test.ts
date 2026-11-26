import { execFile as execFileCallback } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { EdgeKind, GraphEdge, GraphNode, NodeKind, SnapshotGraph } from "@causoryn/domain";

import { projectArchitecture } from "../src/architecture-projection.js";
import {
  defaultGitProcessRunner,
  resetGitRuntimeCachesForTesting,
  runGit,
  setGitProcessRunnerForTesting,
} from "../src/git-read.js";
import { findViolations } from "../src/guard.js";
import { parseArchitectureBaseline, parseArchitecturePolicy } from "../src/guard-policy-schema.js";

/**
 * Array lengths set by the analysed repository (or by a large config) must
 * never be spread into call arguments: `push(...list)` above V8's argument
 * limit (about 120k-150k on Node 24) throws `RangeError: Maximum call stack
 * size exceeded` (security scan F47 and its variants). Each case uses a
 * bounded input above that limit; none measures time.
 */

const LARGE = 300_000;

function node(id: string, kind: NodeKind, qualifiedName: string, relativePath?: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName,
    ...(relativePath === undefined
      ? {}
      : { location: { relativePath, startLine: 1, endLine: 1, sourceHash: `sha256:${id}` } }),
    attributes: {},
  };
}

function edge(id: string, from: string, to: string, kind: EdgeKind, evidenceIds: readonly string[]): GraphEdge {
  return { id, from, to, kind, resolution: "verified", evidenceIds };
}

function snapshot(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): SnapshotGraph {
  return {
    meta: {
      id: "snapshot:spread-bounds",
      workspaceId: "ws_spread",
      revision: { id: "rev-1", sequence: 1 },
      configHash: "cfg",
      analyzerFingerprint: "fp",
      state: "ready",
      createdAt: "2026-11-26T00:00:00.000Z",
    },
    nodes: [...nodes],
    edges: [...edges],
    evidence: [],
  };
}

/** `count` distinct evidence ids, in reverse order (the finding must sort them). */
function manyEvidenceIds(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}:${String(count - 1 - i).padStart(7, "0")}`);
}

const EMPTY_BASELINE = parseArchitectureBaseline("version: 1\nsuppressions: []\n");

describe("guard: very large per-edge evidence lists", () => {
  it("no-cycles collects the evidence of a cycle whose edge carries 300k evidence ids", () => {
    const policy = parseArchitecturePolicy(
      ["version: 1", "rules:", "  - id: acyclic", "    type: no-cycles", "    scope: modules", "    severity: error", ""].join(
        "\n",
      ),
    );
    const graph = snapshot(
      [node("n-a", "Module", "App.A", "src/A/a.ts"), node("n-b", "Module", "App.B", "src/B/b.ts")],
      [
        edge("e-1", "n-a", "n-b", "CALLS", manyEvidenceIds("ev", LARGE)),
        edge("e-2", "n-b", "n-a", "CALLS", ["ev:back"]),
      ],
    );

    const findings = findViolations(graph, policy, EMPTY_BASELINE);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleType).toBe("no-cycles");
    expect(findings[0]?.evidenceIds).toHaveLength(LARGE + 1);
    expect(findings[0]?.evidenceIds[0]).toBe("ev:0000000");
    expect(findings[0]?.evidenceIds[LARGE]).toBe("ev:back");
  });

  it("forbidden-dependency merges a second matching edge that carries 300k evidence ids", () => {
    const policy = parseArchitecturePolicy(
      [
        "version: 1",
        "rules:",
        "  - id: domain-must-not-use-infra",
        "    type: forbidden-dependency",
        '    from: "**/Domain/**"',
        '    to: "**/Infrastructure/**"',
        "    edgeKinds: [IMPORTS, DEPENDS_ON]",
        "    severity: error",
        "",
      ].join("\n"),
    );
    const graph = snapshot(
      [
        node("n-d", "Class", "App.Domain.Orders", "src/Domain/Orders.ts"),
        node("n-i", "Class", "App.Infrastructure.Repo", "src/Infrastructure/Repo.ts"),
      ],
      [
        // Same (from, to) pair: the second edge (id order) is merged into the
        // bucket of the first.
        edge("ed-1", "n-d", "n-i", "IMPORTS", ["ev:import"]),
        edge("ed-2", "n-d", "n-i", "DEPENDS_ON", manyEvidenceIds("ev", LARGE)),
      ],
    );

    const findings = findViolations(graph, policy, EMPTY_BASELINE);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidenceIds).toHaveLength(LARGE + 1);
    expect(findings[0]?.evidenceIds[0]).toBe("ev:0000000");
    expect(findings[0]?.evidenceIds[LARGE]).toBe("ev:import");
  });
});

describe("architecture projection: a directory with very many files", () => {
  it("clusters 200k files under one directory without spreading the file list", () => {
    const count = 200_000;
    const nodes: GraphNode[] = Array.from({ length: count }, (_, i) => {
      const file = `src/a/f${String(i).padStart(6, "0")}.ts`;
      return node(`node:a${String(i).padStart(6, "0")}`, "File", file, file);
    });
    nodes.push(node("node:b", "File", "src/b/only.ts", "src/b/only.ts"));

    const projection = projectArchitecture(snapshot(nodes, []));

    const byPath = new Map(projection.modules.map((module) => [module.path, module]));
    expect(byPath.get("src/a")?.files).toHaveLength(count);
    expect(byPath.get("src/a")?.files[0]).toBe("src/a/f000000.ts");
    expect(byPath.get("src/b")?.files).toEqual(["src/b/only.ts"]);
  });
});

const execFile = promisify(execFileCallback);
const tempDirs: string[] = [];

afterEach(() => {
  setGitProcessRunnerForTesting(undefined);
  resetGitRuntimeCachesForTesting();
});
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("git-read: a very long safe.directory list in the user's git config", () => {
  it("forwards the last 512 protected safe.directory values when the config lists 200k", async () => {
    const repo = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "causoryn-safe-dir-many-")));
    tempDirs.push(repo);
    const plain = { shell: false, windowsHide: true, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } } as const;
    await execFile("git", ["init", "-q", repo], plain);
    await execFile(
      "git",
      ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "c1"],
      plain,
    );

    // `git config --global -z --get-all safe.directory` printing 200k values:
    // short duplicates, then a recognizable tail (~400 KB, under the 1 MiB
    // buffer the real reader allows).
    const values = [...Array.from({ length: 200_000 - 512 }, () => "x"), ...Array.from({ length: 512 }, (_, i) => `/srv/tail-${String(i)}`)];
    const repositoryCalls: Array<readonly string[]> = [];
    setGitProcessRunnerForTesting(async (file, args, options) => {
      if (args.includes("safe.directory") && args.includes("--get-all")) {
        if (args.includes("--global")) return { stdout: `${values.join("\0")}\0`, stderr: "" };
        throw new Error("exit status 1: key not set");
      }
      if (args.includes("-C")) repositoryCalls.push(args);
      return defaultGitProcessRunner(file, args, options);
    });

    await runGit(repo, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);

    const forwarded = (repositoryCalls.at(-1) ?? []).filter((arg) => arg.startsWith("safe.directory="));
    expect(forwarded).toHaveLength(512);
    expect(forwarded[0]).toBe("safe.directory=/srv/tail-0");
    expect(forwarded.at(-1)).toBe("safe.directory=/srv/tail-511");
  }, 60_000);
});
