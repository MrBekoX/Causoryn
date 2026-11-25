import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  GraphRepositoryError,
  TIMELINE_SNAPSHOT_BLOB_PATH,
  buildArchitectureTimeline,
  buildArchitectureTimelineFromGit,
  readGitBlob,
  readGitTree,
  readTimelinePointFromGit,
  type CompareContentSet,
  type CompareEdge,
  type CompareNode,
} from "@causoryn/graph";
import {
  TIMELINE_TRUST_WARNING_COMMITTED_GIT_BLOB,
  reconstructFileContentSetFromGitTree,
} from "../packages/graph/src/timeline.js";

const execFile = promisify(execFileCallback);

function fileNode(relativePath: string): CompareNode {
  return {
    kind: "File",
    qualifiedName: relativePath,
    relativePath,
    attributes: {},
  };
}

function fnNode(qualifiedName: string, relativePath: string, signature: string): CompareNode {
  return {
    kind: "Function",
    qualifiedName,
    language: "typescript",
    relativePath,
    signature,
    attributes: {},
  };
}

function declaresEdge(file: string, fnName: string): CompareEdge {
  return {
    kind: "DECLARES",
    from: { kind: "File", qualifiedName: file, relativePath: file },
    to: { kind: "Function", qualifiedName: fnName, relativePath: file },
    resolution: "verified",
  };
}

function trustedV1(): CompareContentSet {
  return {
    nodes: [fileNode("src/orders.ts"), fnNode("createOrder", "src/orders.ts", "createOrder()")],
    edges: [declaresEdge("src/orders.ts", "createOrder")],
  };
}

function trustedV2(): CompareContentSet {
  return {
    nodes: [
      fileNode("src/orders.ts"),
      fnNode("createOrder", "src/orders.ts", "createOrder(id: string)"),
      fileNode("src/billing.ts"),
      fnNode("chargeOrder", "src/billing.ts", "chargeOrder(id: string)"),
    ],
    edges: [
      declaresEdge("src/orders.ts", "createOrder"),
      declaresEdge("src/billing.ts", "chargeOrder"),
    ],
  };
}

function poisonedCommittedBlob(): CompareContentSet {
  return {
    nodes: [fileNode("src/tampered-by-pr.ts")],
    edges: [],
  };
}

async function initGitRepo(prefix: string): Promise<{
  readonly repoRoot: string;
  readonly git: (args: readonly string[]) => Promise<string>;
}> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), prefix));
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await execFile("git", ["-C", repoRoot, ...args], {
      shell: false,
      windowsHide: true,
    });
    return result.stdout;
  };
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Causoryn Timeline Fallback Test"]);
  await git(["config", "user.email", "timeline-fallback@causoryn.invalid"]);
  await git(["config", "core.autocrlf", "false"]);
  return { repoRoot, git };
}

describe("Task 3.2 — timeline.ts SQLite snapshotLookup, Git-Tree reconstruction & trust warnings", { timeout: 60_000 }, () => {
  describe("repo WITH committed .causoryn/architecture-snapshot.json", () => {
    let repoRoot: string;
    let shaV1: string;
    let shaV2: string;
    let shaV3: string;

    beforeAll(async () => {
      const repo = await initGitRepo("causoryn-tl-with-blob-");
      repoRoot = repo.repoRoot;
      const { git } = repo;

      await mkdir(path.join(repoRoot, ".causoryn"), { recursive: true });
      await mkdir(path.join(repoRoot, "src"), { recursive: true });

      // v1: has a poisoned committed snapshot blob alongside real source
      await writeFile(
        path.join(repoRoot, "src", "orders.ts"),
        "export function createOrder(): void {}\n",
        "utf8",
      );
      await writeFile(
        path.join(repoRoot, ".causoryn", "architecture-snapshot.json"),
        JSON.stringify(poisonedCommittedBlob(), null, 2),
        "utf8",
      );
      await git(["add", "-A"]);
      await git(["commit", "-m", "v1"]);
      shaV1 = (await git(["rev-parse", "HEAD"])).trim();
      await git(["tag", "v1"]);

      // v2: updated source + updated committed snapshot blob
      await writeFile(
        path.join(repoRoot, "src", "billing.ts"),
        "export function chargeOrder(): void {}\n",
        "utf8",
      );
      await writeFile(
        path.join(repoRoot, ".causoryn", "architecture-snapshot.json"),
        JSON.stringify(trustedV2(), null, 2),
        "utf8",
      );
      await git(["add", "-A"]);
      await git(["commit", "-m", "v2"]);
      shaV2 = (await git(["rev-parse", "HEAD"])).trim();
      await git(["tag", "v2"]);

      // v3: extra commit for range & sampling tests
      await writeFile(
        path.join(repoRoot, "src", "notify.ts"),
        "export function notifyOrder(): void {}\n",
        "utf8",
      );
      await git(["add", "-A"]);
      await git(["commit", "-m", "v3"]);
      shaV3 = (await git(["rev-parse", "HEAD"])).trim();
      await git(["tag", "v3"]);
    }, 60_000);

    afterAll(async () => {
      if (repoRoot !== undefined) {
        await rm(repoRoot, { recursive: true, force: true });
      }
    });

    it("snapshotLookup takes precedence over committed .causoryn/architecture-snapshot.json with ZERO trustWarning", async () => {
      const localStore = new Map<string, CompareContentSet>([
        [shaV1, trustedV1()],
        [shaV2, trustedV2()],
      ]);
      const lookupCalls: Array<{ commitSha: string; ref: string }> = [];

      const timeline = await buildArchitectureTimelineFromGit(repoRoot, {
        refs: ["v1", "v2"],
        snapshotLookup: async (commitSha, ref) => {
          lookupCalls.push({ commitSha, ref });
          return localStore.get(commitSha);
        },
      });

      expect(lookupCalls).toEqual([
        { commitSha: shaV1, ref: "v1" },
        { commitSha: shaV2, ref: "v2" },
      ]);
      expect(timeline.analyzedPoints).toBe(2);
      expect(timeline.unanalyzedPoints).toBe(0);
      // Used trusted local snapshot (2 nodes in v1), NOT poisoned committed blob (1 node)
      expect(timeline.points[0]?.nodeCount).toBe(2);
      expect(timeline.points[1]?.nodeCount).toBe(4);
      expect(timeline.points[0]?.trustWarning).toBeUndefined();
      expect(timeline.points[1]?.trustWarning).toBeUndefined();
      expect(timeline.warnings).toEqual([]);

      const interval = timeline.intervals[0];
      expect(interval?.kind).toBe("diff");
      if (interval?.kind === "diff") {
        expect(interval.changes.added).toBe(2);
        expect(interval.changes.changed).toBe(1);
        expect(interval.changes.removed).toBe(0);
      }
    });

    it("falling back to committed .causoryn/architecture-snapshot.json emits explicit trustWarning on point and timeline warnings", async () => {
      const directPoint = await readTimelinePointFromGit(repoRoot, "v1");
      expect(directPoint.status).toBe("analyzed");
      if (directPoint.status === "analyzed") {
        expect(directPoint.trustWarning).toBe("snapshot-loaded-from-committed-git-blob");
        expect(directPoint.trustWarning).toBe(TIMELINE_TRUST_WARNING_COMMITTED_GIT_BLOB);
      }

      const timeline = await buildArchitectureTimelineFromGit(repoRoot, {
        refs: ["v1", "v2"],
      });

      expect(timeline.analyzedPoints).toBe(2);
      expect(timeline.points[0]?.trustWarning).toBe("snapshot-loaded-from-committed-git-blob");
      expect(timeline.points[1]?.trustWarning).toBe("snapshot-loaded-from-committed-git-blob");
      expect(timeline.warnings).toHaveLength(2);
      expect(timeline.warnings[0]).toContain("snapshot-loaded-from-committed-git-blob");
      expect(timeline.warnings[0]).toContain("v1");
      expect(timeline.warnings[1]).toContain("snapshot-loaded-from-committed-git-blob");
      expect(timeline.warnings[1]).toContain("v2");
      // Honest metrics: still zero composite score fields
      expect(JSON.stringify(timeline)).not.toContain("qualityScore");
      expect(JSON.stringify(timeline)).not.toContain('"score"');
    });

    it("partial snapshotLookup hit emits trustWarning ONLY for points that fell back to committed git blob", async () => {
      const timeline = await buildArchitectureTimelineFromGit(repoRoot, {
        refs: ["v1", "v2"],
        snapshotLookup: (commitSha) => (commitSha === shaV1 ? trustedV1() : undefined),
      });

      expect(timeline.points[0]?.trustWarning).toBeUndefined();
      expect(timeline.points[1]?.trustWarning).toBe("snapshot-loaded-from-committed-git-blob");
      expect(timeline.warnings).toHaveLength(1);
      expect(timeline.warnings[0]).toContain("v2");
      expect(timeline.warnings[0]).not.toContain("'v1'");
    });

    it("reconstructFromGitTree takes precedence over committed blob when snapshotLookup is omitted or misses, with ZERO trustWarning", async () => {
      const timeline = await buildArchitectureTimelineFromGit(repoRoot, {
        refs: ["v1", "v2"],
        snapshotLookup: () => undefined,
        reconstructFromGitTree: async (root, ref) =>
          reconstructFileContentSetFromGitTree(root, ref),
      });

      expect(timeline.analyzedPoints).toBe(2);
      expect(timeline.points[0]?.trustWarning).toBeUndefined();
      expect(timeline.points[1]?.trustWarning).toBeUndefined();
      expect(timeline.warnings).toEqual([]);
      // v1 has src/orders.ts (1 source file; .causoryn/architecture-snapshot.json excluded)
      expect(timeline.points[0]?.nodeCount).toBe(1);
      // v2 adds src/billing.ts (2 source files)
      expect(timeline.points[1]?.nodeCount).toBe(2);
      const interval = timeline.intervals[0];
      expect(interval?.kind).toBe("diff");
      if (interval?.kind === "diff") {
        expect(interval.changes.added).toBe(1);
        expect(interval.changes.removed).toBe(0);
      }
    });

    it("range mode and sampling preserve cost bounds and pass canonical commit SHAs to snapshotLookup", async () => {
      const seenShas: string[] = [];
      const lookup = vi.fn((commitSha: string) => {
        seenShas.push(commitSha);
        return commitSha === shaV1 ? trustedV1() : trustedV2();
      });

      // maxRevisions=2 selects endpoints [v1, v3] and skips middle commit shaV2
      const timeline = await buildArchitectureTimelineFromGit(repoRoot, {
        range: { from: "v1", to: "v3" },
        maxRevisions: 2,
        snapshotLookup: lookup,
      });

      expect(timeline.sampling.applied).toBe(true);
      expect(timeline.sampling.skipped).toEqual([{ sourceIndex: 1, ref: shaV2 }]);
      // Skipped point shaV2 must NEVER invoke snapshotLookup
      expect(seenShas).toEqual([shaV1, shaV3]);
      expect(timeline.warnings).toEqual([]);
    });

    it("reconstructFromGitTree receives the canonical commit SHA resolved for snapshotLookup (none for working-tree)", async () => {
      const seen: Array<{ ref: string; commitSha: string | undefined }> = [];
      const reconstruct = async (
        root: string,
        ref: string,
        commitSha?: string,
      ): Promise<CompareContentSet> => {
        seen.push({ ref, commitSha });
        return reconstructFileContentSetFromGitTree(root, ref);
      };
      await buildArchitectureTimelineFromGit(repoRoot, {
        refs: ["v1", "v2"],
        snapshotLookup: () => undefined,
        reconstructFromGitTree: reconstruct,
      });
      await readTimelinePointFromGit(repoRoot, "working-tree", {
        snapshotLookup: () => undefined,
        reconstructFromGitTree: reconstruct,
      });
      expect(seen).toEqual([
        { ref: "v1", commitSha: shaV1 },
        { ref: "v2", commitSha: shaV2 },
        { ref: "working-tree", commitSha: undefined },
      ]);
    });

    it("an unanalyzed reconstructFromGitTree outcome still falls back to the committed snapshot with its trust warning", async () => {
      const point = await readTimelinePointFromGit(repoRoot, "v2", {
        snapshotLookup: () => undefined,
        reconstructFromGitTree: async () => ({
          status: "unanalyzed",
          reason: "analysis-budget-exceeded: test budget",
        }),
      });
      expect(point.status).toBe("analyzed");
      if (point.status === "analyzed") {
        expect(point.trustWarning).toBe(TIMELINE_TRUST_WARNING_COMMITTED_GIT_BLOB);
        expect(point.contentSet.nodes).toHaveLength(trustedV2().nodes.length);
      }
    });

    it("malformed content returned by snapshotLookup or reconstructFromGitTree degrades cleanly to unanalyzed", async () => {
      const badLookup = await readTimelinePointFromGit(repoRoot, "v1", {
        snapshotLookup: () =>
          ({
            nodes: [{ kind: "File", qualifiedName: "src/x.ts", relativePath: 42 }],
            edges: [],
          }) as unknown as CompareContentSet,
      });
      expect(badLookup.status).toBe("unanalyzed");
      if (badLookup.status === "unanalyzed") {
        expect(badLookup.reason).toContain("snapshot-lookup-invalid-shape");
      }

      const badReconstruct = await readTimelinePointFromGit(repoRoot, "v1", {
        reconstructFromGitTree: async () =>
          ({
            nodes: "not-an-array",
            edges: [],
          }) as unknown as CompareContentSet,
      });
      expect(badReconstruct.status).toBe("unanalyzed");
      if (badReconstruct.status === "unanalyzed") {
        expect(badReconstruct.reason).toContain("git-tree-reconstruct-invalid-shape");
      }
    });
  });

  describe("repo WITHOUT .causoryn/architecture-snapshot.json", () => {
    let bareRepoRoot: string;

    beforeAll(async () => {
      const repo = await initGitRepo("causoryn-tl-no-blob-");
      bareRepoRoot = repo.repoRoot;
      const { git } = repo;

      await mkdir(path.join(bareRepoRoot, "src"), { recursive: true });
      await writeFile(
        path.join(bareRepoRoot, "src", "orders.ts"),
        "export function createOrder(): number {\n  return 1;\n}\n",
        "utf8",
      );
      await git(["add", "-A"]);
      await git(["commit", "-m", "commit-1"]);
      await git(["tag", "r1"]);

      await writeFile(
        path.join(bareRepoRoot, "src", "orders.ts"),
        "export function createOrder(id: string): number {\n  return id.length;\n}\n",
        "utf8",
      );
      await writeFile(
        path.join(bareRepoRoot, "src", "payments.ts"),
        "export function payOrder(id: string): boolean {\n  return id.length > 0;\n}\n",
        "utf8",
      );
      await git(["add", "-A"]);
      await git(["commit", "-m", "commit-2"]);
      await git(["tag", "r2"]);
    }, 60_000);

    afterAll(async () => {
      if (bareRepoRoot !== undefined) {
        await rm(bareRepoRoot, { recursive: true, force: true });
      }
    });

    it("reconstructFromGitTree succeeds on a real git repo WITHOUT .causoryn/architecture-snapshot.json with ZERO trustWarning", async () => {
      // Custom reconstructor built strictly on hardened readGitTree + readGitBlob
      const reconstructTsExports = async (
        root: string,
        ref: string,
      ): Promise<CompareContentSet> => {
        const tree = await readGitTree(root, ref);
        const nodes: CompareNode[] = [];
        const edges: CompareEdge[] = [];
        for (const entry of tree) {
          if (entry.type !== "blob" || !entry.path.endsWith(".ts")) continue;
          const source = await readGitBlob(root, ref, entry.path);
          nodes.push(fileNode(entry.path));
          const fnRegex = /export\s+function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g;
          let match: RegExpExecArray | null;
          while ((match = fnRegex.exec(source)) !== null) {
            const name = match[1];
            const params = match[2] ?? "";
            if (name === undefined) continue;
            nodes.push(fnNode(name, entry.path, `${name}(${params})`));
            edges.push(declaresEdge(entry.path, name));
          }
        }
        return { nodes, edges };
      };

      const timeline = await buildArchitectureTimelineFromGit(bareRepoRoot, {
        refs: ["r1", "r2"],
        reconstructFromGitTree: reconstructTsExports,
      });

      expect(timeline.analyzedPoints).toBe(2);
      expect(timeline.unanalyzedPoints).toBe(0);
      expect(timeline.points[0]?.trustWarning).toBeUndefined();
      expect(timeline.points[1]?.trustWarning).toBeUndefined();
      expect(timeline.warnings).toEqual([]);

      const interval = timeline.intervals[0];
      expect(interval?.kind).toBe("diff");
      if (interval?.kind === "diff") {
        // Added src/payments.ts + payOrder; changed createOrder signature
        expect(interval.changes.added).toBe(2);
        expect(interval.changes.changed).toBe(1);
        expect(interval.changes.edgeAdded).toBe(1);
      }
    });

    it("built-in reconstructFileContentSetFromGitTree reconstructs File nodes without .causoryn/architecture-snapshot.json and ZERO trustWarning", async () => {
      const timeline = await buildArchitectureTimelineFromGit(bareRepoRoot, {
        refs: ["r1", "r2"],
        reconstructFromGitTree: (root, ref) =>
          reconstructFileContentSetFromGitTree(root, ref),
      });

      expect(timeline.analyzedPoints).toBe(2);
      expect(timeline.points[0]?.nodeCount).toBe(1);
      expect(timeline.points[1]?.nodeCount).toBe(2);
      expect(timeline.points[0]?.trustWarning).toBeUndefined();
      expect(timeline.points[1]?.trustWarning).toBeUndefined();
      expect(timeline.warnings).toEqual([]);
    });

    it("without seams on a repo lacking .causoryn/architecture-snapshot.json, points stay unanalyzed with ZERO trustWarning", async () => {
      const timeline = await buildArchitectureTimelineFromGit(bareRepoRoot, {
        refs: ["r1", "r2"],
      });

      expect(timeline.analyzedPoints).toBe(0);
      expect(timeline.unanalyzedPoints).toBe(2);
      expect(timeline.points[0]?.trustWarning).toBeUndefined();
      expect(timeline.points[1]?.trustWarning).toBeUndefined();
      expect(timeline.warnings).toEqual([]);
      expect(timeline.points[0]?.unanalyzedReason).toContain(TIMELINE_SNAPSHOT_BLOB_PATH);
    });

    it("an unanalyzed reconstructFromGitTree outcome is the point's reason when no committed snapshot exists", async () => {
      const timeline = await buildArchitectureTimelineFromGit(bareRepoRoot, {
        refs: ["r1", "r2"],
        reconstructFromGitTree: async (root, ref) =>
          ref === "r1"
            ? reconstructFileContentSetFromGitTree(root, ref)
            : { status: "unanalyzed", reason: "analysis-budget-exceeded: test budget" },
      });
      expect(timeline.analyzedPoints).toBe(1);
      expect(timeline.points[1]?.status).toBe("unanalyzed");
      expect(timeline.points[1]?.unanalyzedReason).toBe("analysis-budget-exceeded: test budget");
      expect(timeline.points[1]?.trustWarning).toBeUndefined();
      const interval = timeline.intervals[0];
      expect(interval?.kind).toBe("unanalyzed-interval");
    });

    it("rejects non-function snapshotLookup / reconstructFromGitTree with timeline/invalid-input", async () => {
      let err1: unknown;
      try {
        await buildArchitectureTimelineFromGit(bareRepoRoot, {
          refs: ["r1", "r2"],
          snapshotLookup: "not-a-fn" as unknown as () => undefined,
        });
      } catch (error) {
        err1 = error;
      }
      expect(err1).toBeInstanceOf(GraphRepositoryError);
      expect((err1 as GraphRepositoryError).code).toBe("timeline/invalid-input");

      let err2: unknown;
      try {
        await buildArchitectureTimelineFromGit(bareRepoRoot, {
          refs: ["r1", "r2"],
          reconstructFromGitTree: 123 as unknown as () => Promise<undefined>,
        });
      } catch (error) {
        err2 = error;
      }
      expect(err2).toBeInstanceOf(GraphRepositoryError);
      expect((err2 as GraphRepositoryError).code).toBe("timeline/invalid-input");
    });

    it("pure buildArchitectureTimeline propagates trustWarning into point and timeline.warnings", () => {
      const pure = buildArchitectureTimeline({
        points: [
          {
            ref: "r1",
            content: {
              status: "analyzed",
              contentSet: trustedV1(),
              trustWarning: TIMELINE_TRUST_WARNING_COMMITTED_GIT_BLOB,
            },
          },
          {
            ref: "r2",
            content: {
              status: "analyzed",
              contentSet: trustedV2(),
            },
          },
        ],
      });

      expect(pure.points[0]?.trustWarning).toBe("snapshot-loaded-from-committed-git-blob");
      expect(pure.points[1]?.trustWarning).toBeUndefined();
      expect(pure.warnings).toHaveLength(1);
      expect(pure.warnings[0]).toContain("snapshot-loaded-from-committed-git-blob");
      expect(pure.warnings[0]).toContain("r1");
    });
  });
});
