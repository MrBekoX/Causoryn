import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectInventory,
  collectInventoryAsync,
  IndexService,
  IndexingError,
} from "../src/index.js";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";
import { InMemoryGraphRepository } from "@causoryn/graph";
import { snapshotCanonicalJson } from "@causoryn/domain";

const FIXED_NOW = "2026-11-23T00:00:00.000Z";

function makeTempWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "causoryn-v023-indexing-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const abs = path.resolve(root, relativePath);
    if (abs === root || !abs.startsWith(root + path.sep)) {
      throw new Error(`Invalid fixture path: ${relativePath}`);
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return root;
}

function makeService(
  repository: InMemoryGraphRepository,
  root: string,
  workspaceId = "ws_v023",
  maxFiles = 50_000,
): IndexService {
  const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
  return new IndexService({
    workspaceId,
    policy,
    repository,
    clock: () => FIXED_NOW,
    limits: { maxFiles },
  });
}

describe("Track 1 — Pure JS & tsconfig.json Integration in IndexService", { timeout: 30_000 }, () => {
  it("indexes a pure JavaScript workspace (.js/.jsx/.mjs/.cjs) in both runIndex and runIndexAsync with verified IMPORTS + CALLS", async () => {
    const root = makeTempWorkspace({
      "src/math.js": "export function add(a, b) { return a + b; }\n",
      "src/esm.mjs": 'import { add } from "./math.js";\nexport function runEsm(x) { return add(x, 1); }\n',
      "src/cjs-lib.cjs": "function mul(a, b) { return a * b; }\nmodule.exports = { mul };\n",
      "src/cjs-app.cjs": 'const { mul } = require("./cjs-lib.cjs");\nfunction runCjs(x) { return mul(x, 2); }\nmodule.exports = { runCjs };\n',
      "src/view.jsx": 'import { add } from "./math";\nexport function View({ n }) { return <div>{add(n, 1)}</div>; }\n',
      "src/mod.mts": "export function subMts(a: number, b: number): number { return a - b; }\n",
      "src/mod.cts": "export function divCts(a: number, b: number): number { return a / b; }\n",
    });

    try {
      const syncRepo = new InMemoryGraphRepository();
      const syncRun = makeService(syncRepo, root, "ws_js_sync").runIndex(root);

      const asyncRepo = new InMemoryGraphRepository();
      const asyncRun = await makeService(asyncRepo, root, "ws_js_sync").runIndexAsync(root);

      expect(syncRun.state).toBe("ready");
      expect(syncRun.tsFileCount).toBe(7);
      expect(asyncRun.state).toBe("ready");
      expect(asyncRun.tsFileCount).toBe(7);

      // Sync and async produce byte-identical snapshots for JS/TS workspaces.
      expect(snapshotCanonicalJson(asyncRun.snapshot)).toBe(
        snapshotCanonicalJson(syncRun.snapshot),
      );

      const fileNodes = asyncRun.snapshot.nodes.filter((n) => n.kind === "File");
      expect(fileNodes).toHaveLength(7);
      const jsFileNodes = fileNodes.filter((n) => n.language === "javascript");
      const tsFileNodes = fileNodes.filter((n) => n.language === "typescript");
      expect(jsFileNodes).toHaveLength(5);
      expect(tsFileNodes).toHaveLength(2);

      const byId = new Map(asyncRun.snapshot.nodes.map((n) => [n.id, n]));
      const hasVerifiedCjsCall = asyncRun.snapshot.edges.some(
        (edge) =>
          edge.kind === "CALLS" &&
          edge.resolution === "verified" &&
          byId.get(edge.from)?.qualifiedName === "runCjs" &&
          byId.get(edge.to)?.qualifiedName === "mul",
      );
      const hasVerifiedEsmImport = asyncRun.snapshot.edges.some(
        (edge) =>
          edge.kind === "IMPORTS" &&
          edge.resolution === "verified" &&
          byId.get(edge.from)?.qualifiedName === "src/esm.mjs" &&
          byId.get(edge.to)?.qualifiedName === "src/math.js",
      );
      expect(hasVerifiedCjsCall).toBe(true);
      expect(hasVerifiedEsmImport).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes tsconfig.json automatically to ts-adapter and invalidates incremental cache when tsconfig.json changes", async () => {
    const root = makeTempWorkspace({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          jsx: "preserve",
          baseUrl: ".",
          paths: { "@/*": ["./src/*"] },
        },
      }),
      "src/lib/math.ts": "export function add(a: number, b: number): number { return a + b; }\n",
      "src/alt/math.ts": "export function add(a: number, b: number): number { return a + b + 10; }\n",
      "src/app/page.tsx": [
        'import { add } from "@/lib/math";',
        "export default function Page(): number { return add(1, 2); }",
        "",
      ].join("\n"),
    });

    try {
      const repo = new InMemoryGraphRepository();
      const service = makeService(repo, root, "ws_tsconfig_inc");
      const first = await service.runIndexAsync(root);

      expect(first.state).toBe("ready");
      expect(first.diagnostics).toEqual([]);
      const byId1 = new Map(first.snapshot.nodes.map((n) => [n.id, n]));
      const importsLib = first.snapshot.edges.some(
        (edge) =>
          edge.kind === "IMPORTS" &&
          edge.resolution === "verified" &&
          byId1.get(edge.from)?.qualifiedName === "src/app/page.tsx" &&
          byId1.get(edge.to)?.qualifiedName === "src/lib/math.ts",
      );
      expect(importsLib).toBe(true);

      // No changes -> incremental no-op.
      const noOp = await service.runIncrementalIndexAsync(root, []);
      expect(noOp.published).toBe(false);
      expect(noOp.snapshotId).toBe(first.snapshotId);

      // Edit tsconfig.json so @/lib/* redirects to ./src/alt/* -> MUST invalidate and republish!
      writeFileSync(
        path.join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            jsx: "preserve",
            baseUrl: ".",
            paths: { "@/lib/*": ["./src/alt/*"] },
          },
        }),
        "utf8",
      );
      const afterConfigEdit = await service.runIncrementalIndexAsync(root, ["tsconfig.json"]);
      expect(afterConfigEdit.published).toBe(true);
      expect(afterConfigEdit.snapshotId).not.toBe(first.snapshotId);
      expect(afterConfigEdit.state).toBe("ready");

      const byId2 = new Map(afterConfigEdit.snapshot.nodes.map((n) => [n.id, n]));
      const importsAlt = afterConfigEdit.snapshot.edges.some(
        (edge) =>
          edge.kind === "IMPORTS" &&
          edge.resolution === "verified" &&
          byId2.get(edge.from)?.qualifiedName === "src/app/page.tsx" &&
          byId2.get(edge.to)?.qualifiedName === "src/alt/math.ts",
      );
      expect(importsAlt).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Track 1 — Non-Blocking collectInventoryAsync", { timeout: 30_000 }, () => {
  it("produces byte-identical sorted InventoryEntry[] as sync collectInventory and yields to the event loop", async () => {
    const files: Record<string, string> = {};
    for (let dir = 0; dir < 8; dir += 1) {
      for (let i = 0; i < 20; i += 1) {
        files[`pkg-${String(dir).padStart(2, "0")}/file-${String(i).padStart(2, "0")}.js`] =
          `export const v_${dir}_${i} = ${dir * 100 + i};\n`;
      }
    }
    const root = makeTempWorkspace(files);

    try {
      const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
      const auth = policy.authorizeRoot(root);
      if (!auth.allowed) {
        throw new Error(`Unexpected root denial: ${auth.reason}`);
      }

      const syncEntries = collectInventory(policy, auth.canonicalRoot, 50_000);

      let immediateFiredBeforeCompletion = false;
      let asyncFinished = false;
      setImmediate(() => {
        if (!asyncFinished) {
          immediateFiredBeforeCompletion = true;
        }
      });

      const asyncEntries = await collectInventoryAsync(
        policy,
        auth.canonicalRoot,
        50_000,
        16,
      );
      asyncFinished = true;

      expect(asyncEntries).toHaveLength(160);
      expect(JSON.stringify(asyncEntries)).toBe(JSON.stringify(syncEntries));
      expect(immediateFiredBeforeCompletion).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces maxFiles limit identically to sync collectInventory", async () => {
    const root = makeTempWorkspace({
      "a.js": "export const a = 1;\n",
      "b.js": "export const b = 2;\n",
      "c.js": "export const c = 3;\n",
    });

    try {
      const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
      const auth = policy.authorizeRoot(root);
      if (!auth.allowed) {
        throw new Error(`Unexpected root denial: ${auth.reason}`);
      }

      let caught: unknown;
      try {
        await collectInventoryAsync(policy, auth.canonicalRoot, 2, 1);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(IndexingError);
      expect((caught as IndexingError).code).toBe("indexing/limit-exceeded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
