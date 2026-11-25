import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { generateAgentContext, InMemoryGraphRepository } from "@causoryn/graph";
import { IndexService } from "@causoryn/indexing";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

/**
 * End-to-end: a real index of a small `"type": "module"` TypeScript package.
 *
 * 1. Stored symbol nodes carry their real declaration span (no `1:1`
 *    placeholder), and `generateAgentContext` reports that span.
 * 2. An ESM package using `import.meta.url` under NodeNext indexes without
 *    TS1470 and the snapshot is `ready` (not `partial`).
 *
 * The fixture is written only under os.tmpdir() and removed afterwards; the
 * index lives in memory.
 */

const BILLING = [
  "/** Computes an order total. */", // 1
  "export function computeTotal(items: readonly number[]): number {", // 2
  "  let total = 0;", // 3
  "  for (const item of items) total += item;", // 4
  "  return total;", // 5
  "}", // 6
  "", // 7
  "export class InvoiceLedger {", // 8
  "  record(items: readonly number[]): number {", // 9
  "    return computeTotal(items);", // 10
  "  }", // 11
  "}", // 12
  "",
].join("\n");

const HERE = [
  'import { computeTotal } from "./billing.js";', // 1
  "", // 2
  "export function moduleUrl(): string {", // 3
  "  return `${import.meta.url}#${String(computeTotal([1]))}`;", // 4
  "}", // 5
  "",
].join("\n");

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeFixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-spans-esm-"));
  tempRoots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return root;
}

function indexFixture(root: string) {
  const repository = new InMemoryGraphRepository();
  const service = new IndexService({
    workspaceId: "ws-spans-esm",
    policy: WorkspaceAccessPolicy.create({ allowRoots: [root] }),
    repository,
    clock: () => "2026-11-24T00:00:00.000Z",
    limits: { maxFiles: 1_000 },
  });
  return service.runIndex(root);
}

const ESM_PACKAGE = {
  "package.json": JSON.stringify({ name: "esm-billing", private: true, type: "module" }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      types: [],
    },
  }),
  "src/billing.ts": BILLING,
  "src/here.ts": HERE,
};

describe("indexing: real symbol node spans + ESM module-format detection", { timeout: 60_000 }, () => {
  it("stored symbol nodes carry real declaration spans and agent context reports them", () => {
    const run = indexFixture(writeFixture(ESM_PACKAGE));

    const computeTotal = run.snapshot.nodes.find(
      (node) => node.kind === "Function" && node.qualifiedName === "computeTotal",
    );
    expect(computeTotal?.location).toMatchObject({
      relativePath: "src/billing.ts",
      startLine: 2,
      endLine: 6,
    });
    const record = run.snapshot.nodes.find(
      (node) => node.kind === "Method" && node.qualifiedName === "InvoiceLedger.record",
    );
    expect(record?.location).toMatchObject({ startLine: 9, endLine: 11 });
    const ledger = run.snapshot.nodes.find(
      (node) => node.kind === "Class" && node.qualifiedName === "InvoiceLedger",
    );
    expect(ledger?.location).toMatchObject({ startLine: 8, endLine: 12 });

    // The stored node span must agree with the File→symbol CONTAINS evidence span.
    const containsEdge = run.snapshot.edges.find(
      (edge) => edge.kind === "CONTAINS" && edge.to === computeTotal?.id,
    );
    const evidence = run.snapshot.evidence.find(
      (candidate) => candidate.id === containsEdge?.evidenceIds[0],
    );
    expect(evidence?.span).toMatchObject({ startLine: 2, endLine: 6 });
    expect(computeTotal?.location?.sourceHash).toBe(evidence?.span?.sourceHash);

    const context = generateAgentContext(run.snapshot, {
      task: "computeTotal",
      tokenBudget: 4096,
    });
    const item = context.contextItems.find(
      (candidate) => candidate.qualifiedName === "computeTotal",
    );
    expect(item?.span).toEqual({ startLine: 2, endLine: 6 });
  });

  it("an ESM package using import.meta indexes without TS1470 and publishes a ready snapshot", () => {
    const run = indexFixture(writeFixture(ESM_PACKAGE));
    expect(run.diagnostics.filter((diagnostic) => diagnostic.code === "TS1470")).toEqual([]);
    expect(run.diagnostics).toEqual([]);
    expect(run.snapshot.meta.state).toBe("ready");
  });

  it("the same sources in a CommonJS package still report TS1470 (partial snapshot)", () => {
    const run = indexFixture(
      writeFixture({
        ...ESM_PACKAGE,
        "package.json": JSON.stringify({ name: "cjs-billing", private: true }),
      }),
    );
    expect(
      run.diagnostics
        .filter((diagnostic) => diagnostic.code === "TS1470")
        .map((diagnostic) => `${diagnostic.relativePath}:${String(diagnostic.line)}`),
    ).toEqual(["src/here.ts:4"]);
    expect(run.snapshot.meta.state).toBe("partial");
  });
});
