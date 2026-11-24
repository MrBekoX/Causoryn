import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  createSnapshot,
  type SnapshotEdgeInput,
  type SnapshotNodeInput,
} from "@causoryn/domain";
import {
  analyzeTypeScriptProgram,
  analyzeTypeScriptProgramIncremental,
  loadWorkspacePackages,
  type TypeScriptAdapterInput,
  type TypeScriptAdapterResult,
  type TypeScriptIncrementalState,
} from "../adapters/typescript/src/index.js";
import {
  analyzeCSharpWorkspace,
  discoverNugetReferenceDirs,
  MAX_NUGET_REFERENCE_DIRS,
  MAX_PROJECT_ASSETS_BYTES,
} from "../adapters/csharp-roslyn/src/index.js";
import { buildRoslynWorkerBinary } from "./roslyn-worker-build.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ROSLYN_WORKER_DLL = path.join(
  REPO_ROOT,
  "native",
  "roslyn-worker",
  "bin",
  "Debug",
  "net10.0",
  "Causoryn.RoslynWorker.dll",
);

const dotnetCheck = spawnSync("dotnet", ["--version"], {
  encoding: "utf8",
  shell: false,
});
const dotnetAvailable = dotnetCheck.status === 0;
if (dotnetAvailable) {
  const build = buildRoslynWorkerBinary();
  if (build.status !== 0 || !existsSync(ROSLYN_WORKER_DLL)) {
    throw new Error(
      `Roslyn worker build failed (exit=${String(build.status)}): ${(build.stdout || build.stderr).slice(-400)}`,
    );
  }
}

function findEdge(
  edges: readonly SnapshotEdgeInput[],
  kind: SnapshotEdgeInput["kind"],
  fromQualifiedName: string,
  toQualifiedName: string,
): SnapshotEdgeInput | undefined {
  return edges.find(
    (edge) =>
      edge.kind === kind &&
      edge.from.qualifiedName === fromQualifiedName &&
      edge.to.qualifiedName === toQualifiedName,
  );
}

function findNode(
  nodes: readonly SnapshotNodeInput[],
  kind: SnapshotNodeInput["kind"],
  qualifiedName: string,
): SnapshotNodeInput | undefined {
  return nodes.find(
    (node) => node.kind === kind && node.qualifiedName === qualifiedName,
  );
}

function createSyntheticWorkerChild(
  responseFactory: (requestJson: string) => unknown,
): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter();
  let capturedInput = "";
  const record = child as unknown as Record<string, unknown>;
  record.stdout = stdout;
  record.stderr = stderr;
  record.stdin = Object.assign(stdin, {
    write: (chunk: string | Buffer) => {
      capturedInput += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      return true;
    },
    end: () => {
      const response = responseFactory(capturedInput.trim());
      queueMicrotask(() => {
        stdout.emit("data", Buffer.from(`${JSON.stringify(response)}\n`, "utf8"));
      });
    },
  });
  record.killed = false;
  record.exitCode = null;
  record.signalCode = null;
  record.kill = () => true;
  return child;
}

describe("Wave 2A — TypeScript Monorepo Workspace Package Resolution", { timeout: 30_000 }, () => {
  it("resolves @acme/domain -> @acme/service imports (root, exports subpaths, dist->src mapping) as verified with zero TS2307 diagnostics", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-ts-ws-"));
    try {
      mkdirSync(path.join(tempRoot, "packages", "domain", "src"), { recursive: true });
      mkdirSync(path.join(tempRoot, "packages", "service", "src"), { recursive: true });

      writeFileSync(
        path.join(tempRoot, "package.json"),
        JSON.stringify({
          name: "acme-monorepo",
          private: true,
          workspaces: ["packages/*"],
        }),
        "utf8",
      );
      writeFileSync(
        path.join(tempRoot, "packages", "domain", "package.json"),
        JSON.stringify({
          name: "@acme/domain",
          version: "1.0.0",
          type: "module",
          exports: {
            ".": "./src/index.ts",
            "./money": {
              types: "./dist/money.d.ts",
              import: "./dist/money.js",
            },
            "./*": "./dist/*.js",
          },
        }),
        "utf8",
      );
      writeFileSync(
        path.join(tempRoot, "packages", "service", "package.json"),
        JSON.stringify({
          name: "@acme/service",
          version: "1.0.0",
          type: "module",
          main: "./dist/index.js",
          types: "./dist/index.d.ts",
        }),
        "utf8",
      );

      const domainIndex = [
        "export interface IOrderEntity {",
        "  readonly id: string;",
        "}",
        "export function makeOrderId(seq: number): string {",
        "  return `ord-${seq}`;",
        "}",
        "",
      ].join("\n");
      const domainMoney = [
        "export function formatCents(cents: number): string {",
        "  return `$${(cents / 100).toFixed(2)}`;",
        "}",
        "",
      ].join("\n");
      const domainTax = [
        "export function computeTax(cents: number): number {",
        "  return Math.round(cents * 0.1);",
        "}",
        "",
      ].join("\n");
      const serviceIndex = [
        'import { makeOrderId, type IOrderEntity } from "@acme/domain";',
        'import { formatCents } from "@acme/domain/money";',
        'import { computeTax } from "@acme/domain/tax";',
        "",
        "export function createOrderSummary(seq: number, cents: number): { order: IOrderEntity; label: string } {",
        "  const id = makeOrderId(seq);",
        "  const total = cents + computeTax(cents);",
        "  return { order: { id }, label: formatCents(total) };",
        "}",
        "",
      ].join("\n");

      writeFileSync(path.join(tempRoot, "packages", "domain", "src", "index.ts"), domainIndex, "utf8");
      writeFileSync(path.join(tempRoot, "packages", "domain", "src", "money.ts"), domainMoney, "utf8");
      writeFileSync(path.join(tempRoot, "packages", "domain", "src", "tax.ts"), domainTax, "utf8");
      writeFileSync(path.join(tempRoot, "packages", "service", "src", "index.ts"), serviceIndex, "utf8");

      // Simulate IndexService passing explicit configFiles: [] alongside rootDir.
      const result = analyzeTypeScriptProgram({
        workspaceId: "ws_acme_monorepo",
        rootDir: tempRoot,
        configFiles: [],
        sources: [
          { relativePath: "packages/domain/src/index.ts", content: domainIndex },
          { relativePath: "packages/domain/src/money.ts", content: domainMoney },
          { relativePath: "packages/domain/src/tax.ts", content: domainTax },
          { relativePath: "packages/service/src/index.ts", content: serviceIndex },
        ],
      });

      const ts2307 = result.diagnostics.filter((d) => d.code === "TS2307");
      expect(ts2307).toEqual([]);
      expect(result.state).toBe("ready");

      expect(
        findEdge(result.edges, "IMPORTS", "packages/service/src/index.ts", "packages/domain/src/index.ts")?.resolution,
      ).toBe("verified");
      expect(
        findEdge(result.edges, "IMPORTS", "packages/service/src/index.ts", "packages/domain/src/money.ts")?.resolution,
      ).toBe("verified");
      expect(
        findEdge(result.edges, "IMPORTS", "packages/service/src/index.ts", "packages/domain/src/tax.ts")?.resolution,
      ).toBe("verified");

      expect(findEdge(result.edges, "CALLS", "createOrderSummary", "makeOrderId")?.resolution).toBe("verified");
      expect(findEdge(result.edges, "CALLS", "createOrderSummary", "formatCents")?.resolution).toBe("verified");
      expect(findEdge(result.edges, "CALLS", "createOrderSummary", "computeTax")?.resolution).toBe("verified");

      // Snapshot creation confirms zero dangling refs.
      const snapshot = createSnapshot({
        workspaceId: "ws_acme_monorepo",
        revision: { id: "rev-1", sequence: 1 },
        configHash: "cfg-1",
        analyzerFingerprint: "ts-adapter@0.1.0",
        state: "ready",
        createdAt: "2026-11-24T00:00:00.000Z",
        nodes: result.nodes,
        edges: result.edges,
      });
      expect(snapshot.edges.length).toBe(result.edges.length);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("SECURITY: strictly rejects symlinked node_modules/@evil/escape pointing outside rootDir", () => {
    const parentTemp = mkdtempSync(path.join(os.tmpdir(), "causoryn-ts-evil-"));
    const workspaceRoot = path.join(parentTemp, "workspace");
    const outsidePkg = path.join(parentTemp, "outside-evil");
    try {
      mkdirSync(path.join(workspaceRoot, "packages", "app", "src"), { recursive: true });
      mkdirSync(path.join(workspaceRoot, "node_modules", "@evil"), { recursive: true });
      mkdirSync(path.join(outsidePkg, "src"), { recursive: true });

      writeFileSync(
        path.join(workspaceRoot, "package.json"),
        JSON.stringify({ name: "ws-root", private: true, workspaces: ["packages/*"] }),
        "utf8",
      );
      writeFileSync(
        path.join(outsidePkg, "package.json"),
        JSON.stringify({ name: "@evil/escape", version: "1.0.0", exports: { ".": "./src/index.ts" }, types: "./index.d.ts" }),
        "utf8",
      );
      writeFileSync(
        path.join(outsidePkg, "src", "index.ts"),
        'export const EVIL_SECRET_SYMBOL = "LEAKED";\n',
        "utf8",
      );
      writeFileSync(
        path.join(outsidePkg, "index.d.ts"),
        "export declare const EVIL_SECRET_SYMBOL: string;\n",
        "utf8",
      );

      const linkType = process.platform === "win32" ? "junction" : "dir";
      let symlinkCreated = false;
      try {
        symlinkSync(outsidePkg, path.join(workspaceRoot, "node_modules", "@evil", "escape"), linkType);
        symlinkSync(outsidePkg, path.join(workspaceRoot, "packages", "evil-link"), linkType);
        symlinkCreated = true;
      } catch {
        // Windows sandbox without junction privilege may return EPERM; test also covers in-memory traversal below.
      }

      const appSource = [
        'import { WRONG_REF } from "@evil/escape";',
        "export const out = WRONG_REF;",
        "",
      ].join("\n");

      const result = analyzeTypeScriptProgram({
        workspaceId: "ws_evil_escape",
        rootDir: workspaceRoot,
        configFiles: [],
        sources: [{ relativePath: "packages/app/src/index.ts", content: appSource }],
      });

      const evilEdge = findEdge(result.edges, "IMPORTS", "packages/app/src/index.ts", "@evil/escape");
      expect(evilEdge).toBeDefined();
      expect(evilEdge?.resolution).toBe("unresolved");
      expect(evilEdge?.to.kind).toBe("UnknownExternal");
      expect(JSON.stringify(result)).not.toContain("EVIL_SECRET_SYMBOL");

      // Also verify package.json export traversal ("../../outside-evil/src/index.ts") is rejected in-memory.
      const traversalResult = analyzeTypeScriptProgram({
        workspaceId: "ws_pkg_traversal",
        rootDir: workspaceRoot,
        configFiles: [],
        packageFiles: [
          {
            relativePath: "packages/app/package.json",
            content: JSON.stringify({
              name: "@evil/traversal",
              exports: { ".": "../../../outside-evil/src/index.ts" },
            }),
          },
        ],
        sources: [
          {
            relativePath: "packages/app/src/index.ts",
            content: 'import { WRONG_REF } from "@evil/traversal";\nexport const v = WRONG_REF;\n',
          },
        ],
      });
      const traversalEdge = findEdge(
        traversalResult.edges,
        "IMPORTS",
        "packages/app/src/index.ts",
        "@evil/traversal",
      );
      expect(traversalEdge?.resolution).toBe("unresolved");
      expect(traversalEdge?.to.kind).toBe("UnknownExternal");
      expect(JSON.stringify(traversalResult)).not.toContain("EVIL_SECRET_SYMBOL");
      void symlinkCreated;
    } finally {
      rmSync(parentTemp, { recursive: true, force: true });
    }
  });

  it("preserves explicit tsconfig.json paths precedence, resolves Causoryn own @causoryn/domain workspace import, and degrades safely on malformed/oversized/polluted package.json", () => {
    // 1) Explicit tsconfig.json `paths` wins over workspace package.json while sibling workspace packages still resolve.
    const precedenceResult = analyzeTypeScriptProgram({
      workspaceId: "ws_paths_precedence",
      rootDir: path.resolve(os.tmpdir(), "causoryn-precedence-virtual"),
      configFiles: [
        {
          relativePath: "tsconfig.json",
          content: JSON.stringify({
            compilerOptions: {
              baseUrl: ".",
              paths: {
                "@acme/override": ["./src/custom-override.ts"],
              },
            },
          }),
        },
      ],
      packageFiles: [
        {
          relativePath: "packages/override/package.json",
          content: JSON.stringify({
            name: "@acme/override",
            exports: { ".": "./src/index.ts" },
          }),
        },
        {
          relativePath: "packages/shared/package.json",
          content: JSON.stringify({
            name: "@acme/shared",
            main: "./dist/index.js",
          }),
        },
        {
          relativePath: "packages/broken/package.json",
          content: "{ malformed json {{{",
        },
        {
          relativePath: "packages/polluted/package.json",
          content: '{"name":"__proto__","__proto__":{"pollutedWsPkg":true}}',
        },
        {
          relativePath: "packages/huge/package.json",
          content: `{"name":"@acme/huge","pad":"${"x".repeat(300_000)}"}`,
        },
      ],
      sources: [
        {
          relativePath: "src/custom-override.ts",
          content: "export function fromCustom(): number { return 1; }\r\n",
        },
        {
          relativePath: "packages/override/src/index.ts",
          content: "export function fromPkg(): number { return 2; }\r\n",
        },
        {
          relativePath: "packages/shared/src/index.ts",
          content: [
            "export abstract class SharedBase {",
            "  ping(): string { return 'pong'; }",
            "}",
            "export interface ISharedPort {",
            "  ping(): string;",
            "}",
            "",
          ].join("\r\n"),
        },
        {
          relativePath: "src/consumer.ts",
          content: [
            'import { fromCustom } from "@acme/override";',
            'import { SharedBase, type ISharedPort } from "@acme/shared";',
            "",
            "export class ConcreteConsumer extends SharedBase implements ISharedPort {",
            "  run(): number { return fromCustom() + this.ping().length; }",
            "}",
            "",
          ].join("\r\n"),
        },
      ],
    });

    expect((Object.prototype as Record<string, unknown>)["pollutedWsPkg"]).toBeUndefined();
    expect(precedenceResult.diagnostics.filter((d) => d.code === "TS2307")).toEqual([]);
    // tsconfig paths won for @acme/override
    expect(
      findEdge(precedenceResult.edges, "IMPORTS", "src/consumer.ts", "src/custom-override.ts")?.resolution,
    ).toBe("verified");
    // workspace package resolved @acme/shared main: "./dist/index.js" -> packages/shared/src/index.ts
    expect(
      findEdge(precedenceResult.edges, "IMPORTS", "src/consumer.ts", "packages/shared/src/index.ts")?.resolution,
    ).toBe("verified");
    // cross-package CHA INHERITS + IMPLEMENTS resolved as verified
    expect(
      findEdge(precedenceResult.edges, "INHERITS", "ConcreteConsumer", "SharedBase")?.resolution,
    ).toBe("verified");
    expect(
      findEdge(precedenceResult.edges, "IMPLEMENTS", "ConcreteConsumer", "ISharedPort")?.resolution,
    ).toBe("verified");

    // 2) Causoryn's OWN monorepo: packages/domain/src/index.ts resolved via @causoryn/domain with zero TS2307.
    const domainIndexPath = path.join(REPO_ROOT, "packages", "domain", "src", "index.ts");
    const graphKindsPath = path.join(REPO_ROOT, "packages", "domain", "src", "graph-kinds.ts");
    const realCausoryn = analyzeTypeScriptProgram({
      workspaceId: "ws_causoryn_self",
      rootDir: REPO_ROOT,
      configFiles: [],
      sources: [
        {
          relativePath: "packages/domain/src/graph-kinds.ts",
          content: readFileSync(graphKindsPath, "utf8"),
        },
        {
          relativePath: "packages/domain/src/index.ts",
          content: 'export { EDGE_KINDS, NODE_KINDS } from "./graph-kinds.js";\n',
        },
        {
          relativePath: "packages/graph/src/probe.ts",
          content: [
            'import { EDGE_KINDS } from "@causoryn/domain";',
            "export function countKinds(): number { return EDGE_KINDS.length; }",
            "",
          ].join("\n"),
        },
      ],
    });
    expect(existsSync(domainIndexPath)).toBe(true);
    expect(realCausoryn.diagnostics.filter((d) => d.code === "TS2307")).toEqual([]);
    expect(
      findEdge(realCausoryn.edges, "IMPORTS", "packages/graph/src/probe.ts", "packages/domain/src/index.ts")?.resolution,
    ).toBe("verified");
  });

  it("SECURITY: handles slash-heavy workspaces patterns in linear time (no ReDoS) and rejects mixed-slash UNC rootDirs lexically in loadWorkspacePackages", () => {
    // 1) Mixed-slash UNC rootDirs must be rejected lexically BEFORE any fs.lstatSync call.
    for (const uncRoot of [
      "\\\\evil\\share",
      "//evil/share",
      "\\/evil\\share",
      "/\\evil/share",
    ]) {
      const uncRes = loadWorkspacePackages("/virtual", undefined, uncRoot);
      expect(uncRes.packages.size).toBe(0);
      expect(uncRes.warnings.some((w) => w.includes("UNC/aygıt"))).toBe(true);
    }

    // 2) Slash-heavy workspaces patterns (classic O(n^2) trigger for /^\/+|\/+$/g) must finish in O(n) linear time.
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-ts-slash-redos-"));
    try {
      mkdirSync(path.join(tempRoot, "packages", "alpha"), { recursive: true });
      mkdirSync(path.join(tempRoot, "packages", "ignored"), { recursive: true });

      const slashBurst = "/".repeat(30_000);
      writeFileSync(
        path.join(tempRoot, "package.json"),
        JSON.stringify({
          name: "slash-heavy-root",
          private: true,
          workspaces: [
            `a${slashBurst}b`,
            `!a${slashBurst}b`,
            "///packages/*///",
            "!///packages/ignored///",
          ],
        }),
        "utf8",
      );
      writeFileSync(
        path.join(tempRoot, "packages", "alpha", "package.json"),
        JSON.stringify({ name: "@acme/alpha", version: "1.0.0" }),
        "utf8",
      );
      writeFileSync(
        path.join(tempRoot, "packages", "ignored", "package.json"),
        JSON.stringify({ name: "@acme/ignored", version: "1.0.0" }),
        "utf8",
      );

      const startedAt = performance.now();
      const loaded = loadWorkspacePackages("/virtual", undefined, tempRoot);
      const elapsedMs = performance.now() - startedAt;

      expect(elapsedMs).toBeLessThan(250);
      expect(loaded.packages.has("@acme/alpha")).toBe(true);
      expect(loaded.packages.has("@acme/ignored")).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("Wave 2A — TypeScript CHA (INHERITS & IMPLEMENTS)", { timeout: 30_000 }, () => {
  it("emits verified INHERITS and IMPLEMENTS edges with evidence spans for classes, class expressions, and interfaces", () => {
    const sources = [
      {
        relativePath: "src/contracts.ts",
        content: [
          "export interface IOrderService {",
          "  place(id: string): void;",
          "}",
          "",
          "export interface IAuditable {",
          "  audit(): string;",
          "}",
          "",
          "export interface IAdminService extends IOrderService, IAuditable {",
          "  cancel(id: string): void;",
          "}",
          "",
        ].join("\n"),
      },
      {
        relativePath: "src/base-service.ts",
        content: [
          "export abstract class BaseService {",
          "  log(msg: string): string {",
          "    return msg;",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
      {
        relativePath: "src/order-service.ts",
        content: [
          'import { BaseService } from "./base-service.js";',
          'import type { IAuditable, IOrderService } from "./contracts.js";',
          "",
          "export class OrderService extends BaseService implements IOrderService, IAuditable {",
          "  place(id: string): void {",
          "    this.log(id);",
          "  }",
          "  audit(): string {",
          '    return "ok";',
          "  }",
          "}",
          "",
          "export const DynamicOrderService = class extends BaseService implements IOrderService {",
          "  place(id: string): void {",
          "    this.log(id);",
          "  }",
          "};",
          "",
        ].join("\n"),
      },
    ];

    const forward = analyzeTypeScriptProgram({
      workspaceId: "ws_ts_cha",
      rootDir: path.resolve(os.tmpdir(), "causoryn-ts-cha-virtual"),
      configFiles: [],
      sources,
    });

    expect(forward.state).toBe("ready");
    expect(forward.diagnostics).toEqual([]);

    // class OrderService extends BaseService -> INHERITS (verified)
    const inheritsBase = findEdge(forward.edges, "INHERITS", "OrderService", "BaseService");
    expect(inheritsBase).toBeDefined();
    expect(inheritsBase?.resolution).toBe("verified");
    expect(inheritsBase?.from.kind).toBe("Class");
    expect(inheritsBase?.to.kind).toBe("Class");
    expect(inheritsBase?.evidence?.[0]?.span?.relativePath).toBe("src/order-service.ts");
    expect(inheritsBase?.evidence?.[0]?.span?.startLine).toBe(4);

    // class OrderService implements IOrderService, IAuditable -> IMPLEMENTS (verified)
    const implOrder = findEdge(forward.edges, "IMPLEMENTS", "OrderService", "IOrderService");
    expect(implOrder).toBeDefined();
    expect(implOrder?.resolution).toBe("verified");
    expect(implOrder?.to.kind).toBe("Interface");
    expect(implOrder?.evidence?.[0]?.span?.startLine).toBe(4);

    const implAudit = findEdge(forward.edges, "IMPLEMENTS", "OrderService", "IAuditable");
    expect(implAudit).toBeDefined();
    expect(implAudit?.resolution).toBe("verified");

    // interface IAdminService extends IOrderService, IAuditable -> INHERITS (verified)
    const ifaceInheritsOrder = findEdge(forward.edges, "INHERITS", "IAdminService", "IOrderService");
    expect(ifaceInheritsOrder).toBeDefined();
    expect(ifaceInheritsOrder?.resolution).toBe("verified");
    expect(ifaceInheritsOrder?.from.kind).toBe("Interface");
    expect(ifaceInheritsOrder?.to.kind).toBe("Interface");
    expect(ifaceInheritsOrder?.evidence?.[0]?.span?.relativePath).toBe("src/contracts.ts");
    expect(ifaceInheritsOrder?.evidence?.[0]?.span?.startLine).toBe(9);

    const ifaceInheritsAudit = findEdge(forward.edges, "INHERITS", "IAdminService", "IAuditable");
    expect(ifaceInheritsAudit).toBeDefined();
    expect(ifaceInheritsAudit?.resolution).toBe("verified");

    // class expression: const DynamicOrderService = class extends BaseService implements IOrderService
    expect(findNode(forward.nodes, "Class", "DynamicOrderService")).toBeDefined();
    expect(findEdge(forward.edges, "INHERITS", "DynamicOrderService", "BaseService")?.resolution).toBe("verified");
    expect(findEdge(forward.edges, "IMPLEMENTS", "DynamicOrderService", "IOrderService")?.resolution).toBe("verified");

    // Determinism across reversed input order & valid domain snapshot (zero dangling refs)
    const reversed = analyzeTypeScriptProgram({
      workspaceId: "ws_ts_cha",
      rootDir: path.resolve(os.tmpdir(), "causoryn-ts-cha-virtual"),
      configFiles: [],
      sources: [...sources].reverse(),
    });
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));

    const snapshot = createSnapshot({
      workspaceId: "ws_ts_cha",
      revision: { id: "rev-cha", sequence: 1 },
      configHash: "cfg-cha",
      analyzerFingerprint: "ts-adapter@0.1.0",
      state: "ready",
      createdAt: "2026-11-24T00:00:00.000Z",
      nodes: forward.nodes,
      edges: forward.edges,
    });
    expect(snapshot.edges.length).toBe(forward.edges.length);
  });

  it("emits unresolved INHERITS/IMPLEMENTS to UnknownExternal with ast-span evidence when base/interface cannot be resolved", () => {
    const result = analyzeTypeScriptProgram({
      workspaceId: "ws_ts_cha_unresolved",
      rootDir: path.resolve(os.tmpdir(), "causoryn-ts-cha-unres"),
      configFiles: [],
      sources: [
        {
          relativePath: "src/orphan.ts",
          content: [
            "export class OrphanService extends MissingBase implements IMissingService {",
            "  run(): void {}",
            "}",
            "",
          ].join("\n"),
        },
      ],
    });

    const unresInherits = findEdge(result.edges, "INHERITS", "OrphanService", "MissingBase");
    expect(unresInherits?.resolution).toBe("unresolved");
    expect(unresInherits?.to.kind).toBe("UnknownExternal");
    expect(unresInherits?.evidence?.[0]?.span?.startLine).toBe(1);

    const unresImplements = findEdge(result.edges, "IMPLEMENTS", "OrphanService", "IMissingService");
    expect(unresImplements?.resolution).toBe("unresolved");
    expect(unresImplements?.to.kind).toBe("UnknownExternal");
    expect(unresImplements?.evidence?.[0]?.span?.startLine).toBe(1);
  });
});

describe.skipIf(!dotnetAvailable)("Wave 2A — C# Roslyn CHA (INHERITS & IMPLEMENTS)", { timeout: 120_000 }, () => {
  it("emits verified INHERITS and IMPLEMENTS for classes, records, structs, and interfaces without System.Object noise", async () => {
    const result = await analyzeCSharpWorkspace({
      workspaceId: "ws_cs_cha",
      files: [
        {
          path: "Contracts/IOrderService.cs",
          content: [
            "namespace Acme.Orders;",
            "public interface IOrderService",
            "{",
            "    void Place(string id);",
            "}",
            "public interface IAdminService : IOrderService",
            "{",
            "    void Cancel(string id);",
            "}",
            "",
          ].join("\n"),
        },
        {
          path: "Services/BaseService.cs",
          content: [
            "namespace Acme.Orders;",
            "public abstract class BaseService",
            "{",
            "    protected void Audit(string msg) {}",
            "}",
            "public record OrderBase(string Id);",
            "public record PriorityOrder(string Id, int Priority) : OrderBase(Id);",
            "public struct OrderSummary : IOrderService",
            "{",
            "    public void Place(string id) {}",
            "}",
            "",
          ].join("\n"),
        },
        {
          path: "Services/OrderService.cs",
          content: [
            "namespace Acme.Orders;",
            "public class OrderService : BaseService, IOrderService",
            "{",
            "    public void Place(string id) { Audit(id); }",
            "}",
            "",
          ].join("\n"),
        },
      ],
    });

    expect(result.workerAvailable).toBe(true);
    expect(result.state).toBe("ready");

    // class OrderService : BaseService, IOrderService
    const inheritsBase = findEdge(
      result.edges,
      "INHERITS",
      "Acme.Orders.OrderService",
      "Acme.Orders.BaseService",
    );
    expect(inheritsBase).toBeDefined();
    expect(inheritsBase?.resolution).toBe("verified");
    expect(inheritsBase?.evidence?.[0]?.span?.relativePath).toBe("Services/OrderService.cs");
    expect(inheritsBase?.evidence?.[0]?.span?.startLine).toBe(2);

    const implOrder = findEdge(
      result.edges,
      "IMPLEMENTS",
      "Acme.Orders.OrderService",
      "Acme.Orders.IOrderService",
    );
    expect(implOrder).toBeDefined();
    expect(implOrder?.resolution).toBe("verified");
    expect(implOrder?.evidence?.[0]?.span?.relativePath).toBe("Services/OrderService.cs");
    expect(implOrder?.evidence?.[0]?.span?.startLine).toBe(2);

    // interface IAdminService : IOrderService -> INHERITS
    const ifaceInherits = findEdge(
      result.edges,
      "INHERITS",
      "Acme.Orders.IAdminService",
      "Acme.Orders.IOrderService",
    );
    expect(ifaceInherits).toBeDefined();
    expect(ifaceInherits?.resolution).toBe("verified");
    expect(ifaceInherits?.evidence?.[0]?.span?.relativePath).toBe("Contracts/IOrderService.cs");
    expect(ifaceInherits?.evidence?.[0]?.span?.startLine).toBe(6);

    // record PriorityOrder : OrderBase -> INHERITS
    const recordInherits = findEdge(
      result.edges,
      "INHERITS",
      "Acme.Orders.PriorityOrder",
      "Acme.Orders.OrderBase",
    );
    expect(recordInherits?.resolution).toBe("verified");

    // struct OrderSummary : IOrderService -> IMPLEMENTS
    const structImpl = findEdge(
      result.edges,
      "IMPLEMENTS",
      "Acme.Orders.OrderSummary",
      "Acme.Orders.IOrderService",
    );
    expect(structImpl?.resolution).toBe("verified");

    // No trivial System.Object / System.ValueType / compiler-synthesized IEquatable noise!
    const trivialNoise = result.edges.filter(
      (e) =>
        (e.kind === "INHERITS" || e.kind === "IMPLEMENTS") &&
        (e.to.qualifiedName.includes("System.Object") ||
          e.to.qualifiedName.includes("System.ValueType") ||
          e.to.qualifiedName.includes("IEquatable")),
    );
    expect(trivialNoise).toEqual([]);

    // Valid domain snapshot (zero dangling refs)
    const snapshot = createSnapshot({
      workspaceId: "ws_cs_cha",
      revision: { id: "rev-cs-cha", sequence: 1 },
      configHash: "cfg-cs-cha",
      analyzerFingerprint: "roslyn-worker@0.1.0",
      state: "ready",
      createdAt: "2026-11-24T00:00:00.000Z",
      nodes: result.nodes,
      edges: result.edges,
      evidence: result.evidence,
    });
    expect(snapshot.edges.length).toBe(result.edges.length);
  });

  it("emits unresolved C# INHERITS/IMPLEMENTS to UnknownExternal with ast-span evidence and safely rejects UNC/relative referenceDirs in ReferenceResolver", async () => {
    const result = await analyzeCSharpWorkspace({
      workspaceId: "ws_cs_cha_unres_and_ref_guard",
      files: [
        {
          path: "Broken.cs",
          content: [
            "namespace Acme.Broken;",
            "public class BrokenService : MissingBase, IMissingContract",
            "{",
            "    public void Run() {}",
            "}",
            "",
          ].join("\r\n"),
        },
      ],
      options: {
        workerDllPath: ROSLYN_WORKER_DLL,
      },
    });
    expect(result.workerAvailable).toBe(true);
    const unresInherits = findEdge(
      result.edges,
      "INHERITS",
      "Acme.Broken.BrokenService",
      "MissingBase",
    );
    expect(unresInherits?.resolution).toBe("unresolved");
    expect(unresInherits?.to.kind).toBe("UnknownExternal");
    expect(unresInherits?.evidence?.[0]?.span?.startLine).toBe(2);

    const unresImplements = findEdge(
      result.edges,
      "IMPLEMENTS",
      "Acme.Broken.BrokenService",
      "IMissingContract",
    );
    expect(unresImplements?.resolution).toBe("unresolved");
    expect(unresImplements?.to.kind).toBe("UnknownExternal");
    expect(unresImplements?.evidence?.[0]?.span?.startLine).toBe(2);

    // Direct ReferenceResolver.cs defense-in-depth check: all 4 UNC/device prefixes, drive-relative,
    // relative, symlink/reparse-point, and missing paths sent directly to worker are handled safely.
    const refTempParent = mkdtempSync(path.join(os.tmpdir(), "causoryn-roslyn-refguard-"));
    const refRealDir = path.join(refTempParent, "real-dir");
    const refLinkDir = path.join(refTempParent, "link-dir");
    const refMissingDir = path.join(refTempParent, "does-not-exist-dir");
    let linkCreated = false;
    try {
      mkdirSync(refRealDir, { recursive: true });
      try {
        symlinkSync(refRealDir, refLinkDir, process.platform === "win32" ? "junction" : "dir");
        linkCreated = true;
      } catch {
        // Sandbox environments without symlink/junction privilege still test lexical & missing guards below.
      }

      const driveRelative = process.platform === "win32" ? ["\\Windows\\System32"] : [];
      const linkCases = linkCreated ? [refLinkDir, `${refLinkDir}${path.sep}`] : [];
      const referenceDirs = [
        "\\\\10.0.0.1\\evil\\share",
        "//10.0.0.1/evil/share",
        "\\/evil\\share",
        "/\\evil/share",
        "relative/not-rooted",
        ...driveRelative,
        ...linkCases,
        refMissingDir,
      ];

      const rawRun = spawnSync("dotnet", ["exec", ROSLYN_WORKER_DLL], {
        input:
          JSON.stringify({
            id: "ref-guard-1",
            type: "analyze",
            protocolVersion: "1",
            files: [{ path: "Ok.cs", content: "public class Ok {}" }],
            referenceDirs,
          }) + "\n",
        encoding: "utf8",
        shell: false,
      });
      expect(rawRun.status).toBe(0);
      const parsed = JSON.parse(rawRun.stdout.trim()) as {
        status: string;
        warnings: string[];
      };
      expect(parsed.status).toBe("ready");

      // Every lexical UNC/relative/drive-relative entry must produce an explicit lexical rejection warning.
      const lexicalRejected = parsed.warnings.filter((w) =>
        w.includes("güvensiz veya göreli referenceDirs girdisi reddedildi"),
      );
      expect(lexicalRejected.some((w) => w.includes("\\\\10.0.0.1\\evil\\share"))).toBe(true);
      expect(lexicalRejected.some((w) => w.includes("//10.0.0.1/evil/share"))).toBe(true);
      expect(lexicalRejected.some((w) => w.includes("\\/evil\\share"))).toBe(true);
      expect(lexicalRejected.some((w) => w.includes("/\\evil/share"))).toBe(true);
      expect(lexicalRejected.some((w) => w.includes("relative/not-rooted"))).toBe(true);
      if (process.platform === "win32") {
        expect(lexicalRejected.some((w) => w.includes("\\Windows\\System32"))).toBe(true);
      }

      // Missing non-existent local dir must be reported as missing (NOT misclassified as symlink via Attributes == -1).
      expect(
        parsed.warnings.some(
          (w) => w.includes("referenceDirs girdisi yok") && w.includes("does-not-exist-dir"),
        ),
      ).toBe(true);
      expect(
        parsed.warnings.some(
          (w) => w.includes("symlink/reparse-point") && w.includes("does-not-exist-dir"),
        ),
      ).toBe(false);

      if (linkCreated) {
        const symlinkRejected = parsed.warnings.filter((w) =>
          w.includes("symlink/reparse-point referenceDirs girdisi reddedildi"),
        );
        expect(symlinkRejected.length).toBeGreaterThanOrEqual(2);
      }
    } finally {
      rmSync(refTempParent, { recursive: true, force: true });
    }
  });
});

describe("Wave 2A — C# Read-Only NuGet obj/project.assets.json Discovery", { timeout: 60_000 }, () => {
  it("extracts valid local compile-time NuGet DLL directories, rejects UNC/traversal/symlinks, caps at 64, and degrades silently when absent/malformed/oversized", async () => {
    const tempParent = mkdtempSync(path.join(os.tmpdir(), "causoryn-nuget-disc-"));
    const workspaceRoot = path.join(tempParent, "cs-app");
    const nugetCache = path.join(tempParent, "nuget-cache");
    const outsideDir = path.join(tempParent, "outside-dlls");
    try {
      mkdirSync(path.join(workspaceRoot, "obj"), { recursive: true });
      const pkgLibDir = path.join(nugetCache, "acme.external", "1.0.0", "lib", "net10.0");
      mkdirSync(pkgLibDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });

      // Put a real managed .NET assembly DLL into the simulated local NuGet cache if available,
      // otherwise a stub file for path discovery verification.
      const dummyDll = path.join(pkgLibDir, "Acme.External.dll");
      if (existsSync(ROSLYN_WORKER_DLL)) {
        copyFileSync(ROSLYN_WORKER_DLL, dummyDll);
      } else {
        writeFileSync(dummyDll, "stub", "utf8");
      }
      writeFileSync(path.join(outsideDir, "Evil.dll"), "stub", "utf8");

      const assetsJson = {
        version: 3,
        targets: {
          "net10.0": {
            "Acme.External/1.0.0": {
              type: "package",
              compile: {
                "lib/net10.0/Acme.External.dll": {},
                "lib/net10.0/_._": {},
              },
            },
            "Evil.Traversal/1.0.0": {
              type: "package",
              compile: {
                "../../outside-dlls/Evil.dll": {},
              },
            },
          },
        },
        libraries: {
          "Acme.External/1.0.0": {
            type: "package",
            path: "acme.external/1.0.0",
          },
          "Evil.Traversal/1.0.0": {
            type: "package",
            path: "evil.traversal/1.0.0",
          },
        },
        packageFolders: {
          [`${nugetCache}${path.sep}`]: {},
          "\\\\10.0.0.1\\evil-share\\nuget\\": {},
          "//evil-host/share/nuget/": {},
          "\\/evil\\share\\nuget\\": {},
          "/\\evil/share/nuget/": {},
          "\\\\?\\UNC\\evil\\share\\": {},
          "\\\\.\\pipe\\evil": {},
        },
      };
      writeFileSync(
        path.join(workspaceRoot, "obj", "project.assets.json"),
        JSON.stringify(assetsJson),
        "utf8",
      );

      const discovered = discoverNugetReferenceDirs(workspaceRoot);
      expect(discovered.referenceDirs).toEqual([pkgLibDir]);
      expect(discovered.referenceDirs.length).toBeLessThanOrEqual(MAX_NUGET_REFERENCE_DIRS);

      // Verify analyzeCSharpWorkspace forwards discovered referenceDirs to the worker request.
      let capturedRequest: Record<string, unknown> | undefined;
      const adapterRes = await analyzeCSharpWorkspace({
        workspaceId: "ws_nuget_forward",
        rootDir: workspaceRoot,
        files: [{ path: "Program.cs", content: "public class P {}" }],
        options: {
          spawnProcess: () =>
            createSyntheticWorkerChild((raw) => {
              capturedRequest = JSON.parse(raw) as Record<string, unknown>;
              return {
                id: "analyze:ws_nuget_forward",
                protocolVersion: "1",
                status: "ready",
                coverageRatio: 1,
                nodes: [],
                edges: [],
                evidence: [],
              };
            }),
        },
      });
      expect(adapterRes.workerAvailable).toBe(true);
      expect(capturedRequest?.["referenceDirs"]).toEqual([pkgLibDir]);

      // End-to-end with real Roslyn worker: resolve Causoryn.RoslynWorker.ProtocolConstants via discovered NuGet DLL!
      if (dotnetAvailable && existsSync(ROSLYN_WORKER_DLL)) {
        const realResult = await analyzeCSharpWorkspace({
          workspaceId: "ws_nuget_real_roslyn",
          rootDir: workspaceRoot,
          files: [
            {
              path: "UseNuget.cs",
              content: [
                "using Causoryn.RoslynWorker;",
                "namespace Consumer;",
                "public class Client : WorkerInfo",
                "{",
                "    public string GetVer() => ProtocolConstants.ProtocolVersion;",
                "}",
                "",
              ].join("\n"),
            },
          ],
        });
        expect(realResult.workerAvailable).toBe(true);
        const nugetInherits = findEdge(
          realResult.edges,
          "INHERITS",
          "Consumer.Client",
          "Causoryn.RoslynWorker.WorkerInfo",
        );
        expect(nugetInherits).toBeDefined();
        expect(nugetInherits?.resolution).toBe("verified");
      }

      // Malformed JSON degrades silently with zero crash.
      writeFileSync(
        path.join(workspaceRoot, "obj", "project.assets.json"),
        "{ not valid json {{{",
        "utf8",
      );
      expect(discoverNugetReferenceDirs(workspaceRoot).referenceDirs).toEqual([]);

      // Oversized (> 8 MB) degrades silently with zero crash.
      writeFileSync(
        path.join(workspaceRoot, "obj", "project.assets.json"),
        `{"pad":"${"a".repeat(MAX_PROJECT_ASSETS_BYTES + 1024)}"}`,
        "utf8",
      );
      expect(discoverNugetReferenceDirs(workspaceRoot).referenceDirs).toEqual([]);

      // Absent obj/project.assets.json degrades silently.
      const emptyRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-nuget-empty-"));
      try {
        expect(discoverNugetReferenceDirs(emptyRoot).referenceDirs).toEqual([]);
      } finally {
        rmSync(emptyRoot, { recursive: true, force: true });
      }

      // All 4 UNC/mixed-slash rootDirs are lexically rejected without crashing or network I/O.
      expect(discoverNugetReferenceDirs("\\\\10.0.0.1\\share\\repo").referenceDirs).toEqual([]);
      expect(discoverNugetReferenceDirs("//10.0.0.1/share/repo").referenceDirs).toEqual([]);
      expect(discoverNugetReferenceDirs("\\/evil\\share").referenceDirs).toEqual([]);
      expect(discoverNugetReferenceDirs("/\\evil/share").referenceDirs).toEqual([]);

      // Symlink/junction packageFolder (even with trailing slash as NuGet emits) is rejected.
      const linkCacheRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-nuget-symlink-"));
      try {
        const wsWithLink = path.join(linkCacheRoot, "ws");
        const realCache = path.join(linkCacheRoot, "real-cache");
        const linkedCache = path.join(linkCacheRoot, "linked-cache");
        const realDllDir = path.join(realCache, "acme.link", "1.0.0", "lib", "net10.0");
        mkdirSync(path.join(wsWithLink, "obj"), { recursive: true });
        mkdirSync(realDllDir, { recursive: true });
        writeFileSync(path.join(realDllDir, "Acme.Link.dll"), "stub", "utf8");
        let cacheLinkCreated = false;
        try {
          symlinkSync(realCache, linkedCache, process.platform === "win32" ? "junction" : "dir");
          cacheLinkCreated = true;
        } catch {
          // Ignore EPERM in restricted sandboxes.
        }
        if (cacheLinkCreated) {
          writeFileSync(
            path.join(wsWithLink, "obj", "project.assets.json"),
            JSON.stringify({
              version: 3,
              targets: {
                "net10.0": {
                  "Acme.Link/1.0.0": {
                    type: "package",
                    compile: { "lib/net10.0/Acme.Link.dll": {} },
                  },
                },
              },
              libraries: {
                "Acme.Link/1.0.0": { type: "package", path: "acme.link/1.0.0" },
              },
              packageFolders: {
                [`${linkedCache}${path.sep}`]: {},
              },
            }),
            "utf8",
          );
          expect(discoverNugetReferenceDirs(wsWithLink).referenceDirs).toEqual([]);
        }
      } finally {
        rmSync(linkCacheRoot, { recursive: true, force: true });
      }

      // Multi-project cap check: > 64 packages in nested project.assets.json capped deterministically at MAX_NUGET_REFERENCE_DIRS (64).
      const capRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-nuget-cap-"));
      try {
        mkdirSync(path.join(capRoot, "src", "Api", "obj"), { recursive: true });
        const capCache = path.join(capRoot, "cache");
        const targets: Record<string, unknown> = {};
        const libraries: Record<string, unknown> = {};
        for (let i = 0; i < MAX_NUGET_REFERENCE_DIRS + 10; i += 1) {
          const pkgName = `pkg${String(i).padStart(3, "0")}`;
          const key = `${pkgName}/1.0.0`;
          const dllDir = path.join(capCache, pkgName, "1.0.0", "lib", "net8.0");
          mkdirSync(dllDir, { recursive: true });
          writeFileSync(path.join(dllDir, `${pkgName}.dll`), "stub", "utf8");
          targets[key] = {
            type: "package",
            compile: { [`lib/net8.0/${pkgName}.dll`]: {} },
          };
          libraries[key] = { type: "package", path: `${pkgName}/1.0.0` };
        }
        writeFileSync(
          path.join(capRoot, "src", "Api", "obj", "project.assets.json"),
          JSON.stringify({
            version: 3,
            targets: { "net8.0": targets },
            libraries,
            packageFolders: { [`${capCache}${path.sep}`]: {} },
          }),
          "utf8",
        );
        const capDiscovered = discoverNugetReferenceDirs(capRoot);
        expect(capDiscovered.referenceDirs.length).toBe(MAX_NUGET_REFERENCE_DIRS);
      } finally {
        rmSync(capRoot, { recursive: true, force: true });
      }
    } finally {
      rmSync(tempParent, { recursive: true, force: true });
    }
  });
});

describe("Wave 2A — TypeScript Incremental oldProgram Reuse Hook", { timeout: 30_000 }, () => {
  it("reuses unchanged ts.SourceFile ASTs across a 1-file edit and produces byte-identical output to a fresh cold analysis", () => {
    const virtualRoot = path.resolve(os.tmpdir(), "causoryn-ts-inc-virtual");
    const baseSources = [
      {
        relativePath: "src/contracts.ts",
        content: [
          "export interface IGreeter {",
          "  greet(name: string): string;",
          "}",
          "",
        ].join("\n"),
      },
      {
        relativePath: "src/math.ts",
        content: [
          "export function doubleValue(n: number): number {",
          "  return n * 2;",
          "}",
          "",
        ].join("\n"),
      },
      {
        relativePath: "src/greeter.ts",
        content: [
          'import type { IGreeter } from "./contracts.js";',
          'import { doubleValue } from "./math.js";',
          "",
          "export class Greeter implements IGreeter {",
          "  greet(name: string): string {",
          "    return `${name}:${doubleValue(2)}`;",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    ];

    const run1: TypeScriptAdapterResult = analyzeTypeScriptProgram({
      workspaceId: "ws_ts_inc",
      rootDir: virtualRoot,
      configFiles: [],
      sources: baseSources,
    });

    // JSON.stringify must NOT throw circular JSON error when nextIncrementalState is attached!
    expect(() => JSON.stringify(run1)).not.toThrow();

    const state1: TypeScriptIncrementalState | undefined = run1.nextIncrementalState;
    expect(state1).toBeDefined();
    if (state1 === undefined) {
      throw new Error("Expected nextIncrementalState to be defined");
    }
    expect(state1.program).toBeDefined();

    // Edit 1 file (src/greeter.ts) while leaving src/contracts.ts and src/math.ts untouched.
    const editedSources = [
      baseSources[0]!,
      baseSources[1]!,
      {
        relativePath: "src/greeter.ts",
        content: [
          'import type { IGreeter } from "./contracts.js";',
          'import { doubleValue } from "./math.js";',
          "",
          "export class Greeter implements IGreeter {",
          "  greet(name: string): string {",
          "    return `hello-${name}:${doubleValue(3)}`;",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    ];

    const run2Incremental = analyzeTypeScriptProgram({
      workspaceId: "ws_ts_inc",
      rootDir: virtualRoot,
      configFiles: [],
      sources: editedSources,
      incrementalState: state1,
    } satisfies TypeScriptAdapterInput);

    const run2PreviousProgram = analyzeTypeScriptProgram({
      workspaceId: "ws_ts_inc",
      rootDir: virtualRoot,
      configFiles: [],
      sources: editedSources,
      previousProgram: state1.program,
    } satisfies TypeScriptAdapterInput);

    const run2Cold = analyzeTypeScriptProgram({
      workspaceId: "ws_ts_inc",
      rootDir: virtualRoot,
      configFiles: [],
      sources: editedSources,
    });

    // Byte-identical deterministic output across incrementalState, previousProgram, and fresh cold run!
    expect(JSON.stringify(run2Incremental)).toBe(JSON.stringify(run2Cold));
    expect(JSON.stringify(run2PreviousProgram)).toBe(JSON.stringify(run2Cold));

    // Prove unchanged SourceFiles were actually reused by object identity!
    const state2 = run2Incremental.nextIncrementalState;
    expect(state2).toBeDefined();
    const mathPath = state1!.program
      .getSourceFiles()
      .find((sf) => sf.fileName.endsWith("src/math.ts"))?.fileName;
    const contractsPath = state1!.program
      .getSourceFiles()
      .find((sf) => sf.fileName.endsWith("src/contracts.ts"))?.fileName;
    const greeterPath = state1!.program
      .getSourceFiles()
      .find((sf) => sf.fileName.endsWith("src/greeter.ts"))?.fileName;

    expect(mathPath).toBeDefined();
    expect(contractsPath).toBeDefined();
    expect(greeterPath).toBeDefined();
    expect(state2!.program.getSourceFile(mathPath!)).toBe(
      state1!.program.getSourceFile(mathPath!),
    );
    expect(state2!.program.getSourceFile(contractsPath!)).toBe(
      state1!.program.getSourceFile(contractsPath!),
    );
    // Edited file MUST be a freshly parsed SourceFile (not stale!).
    expect(state2!.program.getSourceFile(greeterPath!)).not.toBe(
      state1!.program.getSourceFile(greeterPath!),
    );
  });

  it("produces byte-identical output to cold analysis across signature edits, file additions, file deletions, and config changes", () => {
    const virtualRoot = path.resolve(os.tmpdir(), "causoryn-ts-inc-mutations");
    const initialSources = [
      {
        relativePath: "src/app.ts",
        content: [
          'import { compute } from "./helper.js";',
          "export function main(): number {",
          "  return compute(5);",
          "}",
          "",
        ].join("\n"),
      },
    ];

    // Step 1: initial run where ./helper.js does NOT exist yet (unresolved + TS2307).
    const step1 = analyzeTypeScriptProgramIncremental({
      workspaceId: "ws_ts_inc_mut",
      rootDir: virtualRoot,
      configFiles: [],
      sources: initialSources,
    });
    expect(step1.nextIncrementalState.program).toBeDefined();
    expect(step1.result.diagnostics.some((d) => d.code === "TS2307")).toBe(true);

    // Step 2: ADD src/helper.ts while src/app.ts is UNCHANGED -> must resolve cleanly & match cold run!
    const withHelperSources = [
      ...initialSources,
      {
        relativePath: "src/helper.ts",
        content: "export function compute(x: number): number { return x + 1; }\n",
      },
    ];
    const step2Inc = analyzeTypeScriptProgramIncremental({
      workspaceId: "ws_ts_inc_mut",
      rootDir: virtualRoot,
      configFiles: [],
      sources: withHelperSources,
      incrementalState: step1.nextIncrementalState,
    });
    const step2Cold = analyzeTypeScriptProgram({
      workspaceId: "ws_ts_inc_mut",
      rootDir: virtualRoot,
      configFiles: [],
      sources: withHelperSources,
    });
    expect(step2Inc.result.state).toBe("ready");
    expect(JSON.stringify(step2Inc.result)).toBe(JSON.stringify(step2Cold));

    // Step 3: CHANGE exported signature of src/helper.ts (number -> string) while src/app.ts is UNCHANGED!
    const brokenSigSources = [
      initialSources[0]!,
      {
        relativePath: "src/helper.ts",
        content: "export function compute(x: string): string { return x; }\n",
      },
    ];
    const step3Inc = analyzeTypeScriptProgramIncremental({
      workspaceId: "ws_ts_inc_mut",
      rootDir: virtualRoot,
      configFiles: [],
      sources: brokenSigSources,
      incrementalState: step2Inc.nextIncrementalState,
    });
    const step3Cold = analyzeTypeScriptProgram({
      workspaceId: "ws_ts_inc_mut",
      rootDir: virtualRoot,
      configFiles: [],
      sources: brokenSigSources,
    });
    expect(step3Inc.result.state).toBe("partial");
    expect(JSON.stringify(step3Inc.result)).toBe(JSON.stringify(step3Cold));

    // Step 4: DELETE src/helper.ts -> reverts to unresolved + TS2307, byte-identical to cold run!
    const step4Inc = analyzeTypeScriptProgramIncremental({
      workspaceId: "ws_ts_inc_mut",
      rootDir: virtualRoot,
      configFiles: [],
      sources: initialSources,
      incrementalState: step3Inc.nextIncrementalState,
    });
    const step4Cold = analyzeTypeScriptProgram({
      workspaceId: "ws_ts_inc_mut",
      rootDir: virtualRoot,
      configFiles: [],
      sources: initialSources,
    });
    expect(JSON.stringify(step4Inc.result)).toBe(JSON.stringify(step4Cold));
  });
});

describe("Post-v0.2.4 Remediation — TypeScript Anonymous CallSignature & Unresolved Callee Formatting", { timeout: 30_000 }, () => {
  it("resolves anonymous CallSignature lib/external/workspace calls (String, Number, Boolean, expect, new External, handlers, clock, walk, resolve, close) without false unresolved edges", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-ts-callsig-"));
    try {
      mkdirSync(path.join(tempRoot, "node_modules", "fake-assert"), { recursive: true });
      mkdirSync(path.join(tempRoot, "src"), { recursive: true });

      writeFileSync(
        path.join(tempRoot, "node_modules", "fake-assert", "package.json"),
        JSON.stringify({ name: "fake-assert", version: "1.0.0", types: "./index.d.ts" }),
        "utf8",
      );
      writeFileSync(
        path.join(tempRoot, "node_modules", "fake-assert", "index.d.ts"),
        [
          "export interface Assertion {",
          "  readonly toBe: (expected: unknown) => void;",
          "}",
          "export interface ExpectFn {",
          "  (value: unknown): Assertion;",
          "}",
          "export declare const expect: ExpectFn;",
          "export declare class ExternalMcpServer {",
          "  constructor(name: string);",
          "  registerTool(name: string): void;",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const depsSource = [
        "export interface ClockDeps {",
        "  readonly clock: () => string;",
        "}",
        "export const topLevelHandler = (v: number): string => String(v);",
        "export function makePair(): { close: () => void } {",
        "  return { close: () => {} };",
        "}",
        "",
      ].join("\n");

      const runnerSource = [
        'import { expect, ExternalMcpServer } from "fake-assert";',
        'import { type ClockDeps, makePair, topLevelHandler } from "./deps.js";',
        "",
        "export class Runner {",
        "  private readonly clock: () => string;",
        "  constructor(deps: ClockDeps) {",
        "    this.clock = deps.clock;",
        "  }",
        "  async run(input: unknown, deps: ClockDeps): Promise<number> {",
        "    const text = String(input);",
        "    const num = Number(text);",
        "    const flag = Boolean(num);",
        "    const label = topLevelHandler(num);",
        "    const nowA = this.clock();",
        "    const nowB = deps.clock();",
        "    const walk = (n: number): number => (n > 0 ? walk(n - 1) : 0);",
        "    const walked = walk(2);",
        "    const pair = makePair();",
        "    pair.close();",
        "    const srv = new ExternalMcpServer(label);",
        '    srv.registerTool("demo");',
        "    expect(flag).toBe(true);",
        "    const resolved = await new Promise<number>((resolve) => {",
        "      resolve(walked + nowA.length + nowB.length);",
        "    });",
        "    return resolved;",
        "  }",
        "}",
        "",
      ].join("\n");

      const result = analyzeTypeScriptProgram({
        workspaceId: "ws_callsig_fix",
        rootDir: tempRoot,
        configFiles: [],
        sources: [
          { relativePath: "src/deps.ts", content: depsSource },
          { relativePath: "src/runner.ts", content: runnerSource },
        ],
      });

      expect(result.diagnostics).toEqual([]);
      expect(result.state).toBe("ready");

      // Zero unresolved CALLS edges for any resolved lib, external, or workspace callable!
      const unresolvedCalls = result.edges.filter(
        (e) => e.kind === "CALLS" && e.resolution === "unresolved",
      );
      expect(unresolvedCalls).toEqual([]);

      // Lib built-ins resolve cleanly as verified UnknownExternal with clean names (not StringConstructor.String)
      for (const libName of ["String", "Number", "Boolean"]) {
        const edge = findEdge(result.edges, "CALLS", "Runner.run", libName);
        expect(edge, `expected verified CALLS edge to ${libName}`).toBeDefined();
        expect(edge?.resolution).toBe("verified");
        expect(edge?.to.kind).toBe("UnknownExternal");
      }

      // External node_modules imported callables (anonymous CallSignature, PropertySignature, new External)
      const expectEdge = findEdge(result.edges, "CALLS", "Runner.run", "expect");
      expect(expectEdge?.resolution).toBe("verified");
      expect(expectEdge?.to.kind).toBe("UnknownExternal");

      const toBeEdge = findEdge(result.edges, "CALLS", "Runner.run", "Assertion.toBe");
      expect(toBeEdge?.resolution).toBe("verified");
      expect(toBeEdge?.to.kind).toBe("UnknownExternal");

      const serverNewEdge = findEdge(result.edges, "CALLS", "Runner.run", "ExternalMcpServer");
      expect(serverNewEdge?.resolution).toBe("verified");
      expect(serverNewEdge?.to.kind).toBe("UnknownExternal");

      const registerToolEdge = findEdge(
        result.edges,
        "CALLS",
        "Runner.run",
        "ExternalMcpServer.registerTool",
      );
      expect(registerToolEdge?.resolution).toBe("verified");
      expect(registerToolEdge?.to.kind).toBe("UnknownExternal");

      // Workspace-internal top-level Handler and callable interface/class properties resolve as verified workspace nodes
      const handlerEdge = findEdge(result.edges, "CALLS", "Runner.run", "topLevelHandler");
      expect(handlerEdge?.resolution).toBe("verified");
      expect(handlerEdge?.to.kind).toBe("Handler");

      const depsClockEdge = findEdge(result.edges, "CALLS", "Runner.run", "ClockDeps.clock");
      expect(depsClockEdge?.resolution).toBe("verified");
      expect(depsClockEdge?.to.kind).toBe("Method");

      const thisClockEdge = findEdge(result.edges, "CALLS", "Runner.run", "Runner.clock");
      expect(thisClockEdge?.resolution).toBe("verified");
      expect(thisClockEdge?.to.kind).toBe("Method");

      // Local arrow helper (walk) resolves to its existing Handler node (not UnknownExternal);
      // callback parameter (resolve) and object-literal property (pair.close) emit zero UnknownExternal nodes
      const walkEdge = findEdge(result.edges, "CALLS", "Runner.run", "walk");
      expect(walkEdge?.resolution).toBe("verified");
      expect(walkEdge?.to.kind).toBe("Handler");
      expect(result.nodes.some((n) => n.kind === "UnknownExternal" && n.qualifiedName === "walk")).toBe(false);
      expect(result.nodes.some((n) => n.qualifiedName === "resolve")).toBe(false);
      expect(result.nodes.some((n) => n.qualifiedName === "pair.close")).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps genuinely unresolved calls honest (unresolved) and collapses multi-line chained call arguments cleanly (<= 120 chars)", () => {
    const virtualRoot = path.resolve(os.tmpdir(), "causoryn-ts-unresolved-fmt");
    const longChain = Array.from({ length: 20 }, (_, i) => `veryLongSegmentName${String(i)}`).join(".");
    const result = analyzeTypeScriptProgram({
      workspaceId: "ws_unres_fmt",
      rootDir: virtualRoot,
      configFiles: [],
      sources: [
        {
          relativePath: "src/broken.ts",
          content: [
            'import { missingFn } from "./does-not-exist.js";',
            "export function check(hitSymbols: readonly string[], dyn: any): void {",
            "  missingFn();",
            "  dyn.run();",
            "  undeclaredExpect(",
            '    hitSymbols.some((s) => s.startsWith("createCausorynMcpServer") && s.length > 0),',
            "  ).not.toBe(false);",
            `  ${longChain}();`,
            "}",
            "",
          ].join("\n"),
        },
      ],
    });

    // Unresolved import call and `any`-typed call remain honestly unresolved
    const missingCall = findEdge(result.edges, "CALLS", "check", "missingFn");
    expect(missingCall?.resolution).toBe("unresolved");
    expect(missingCall?.to.kind).toBe("UnknownExternal");

    const anyCall = findEdge(result.edges, "CALLS", "check", "dyn.run");
    expect(anyCall?.resolution).toBe("unresolved");
    expect(anyCall?.to.kind).toBe("UnknownExternal");

    // Multi-line chained call arguments collapsed cleanly to `undeclaredExpect().not.toBe` (no newlines, no dumped args!)
    const chainedCall = findEdge(result.edges, "CALLS", "check", "undeclaredExpect().not.toBe");
    expect(chainedCall).toBeDefined();
    expect(chainedCall?.resolution).toBe("unresolved");
    expect(chainedCall?.to.kind).toBe("UnknownExternal");

    // Every unresolved UnknownExternal CALLS target is single-line and <= 120 chars
    const allUnresolvedCallTargets = result.edges
      .filter((e) => e.kind === "CALLS" && e.resolution === "unresolved")
      .map((e) => e.to.qualifiedName);
    expect(allUnresolvedCallTargets.length).toBeGreaterThanOrEqual(4);
    for (const targetName of allUnresolvedCallTargets) {
      expect(targetName).not.toContain("\n");
      expect(targetName).not.toContain("\r");
      expect(targetName).not.toContain("hitSymbols.some");
      expect(targetName.length).toBeLessThanOrEqual(120);
    }
  });
});
