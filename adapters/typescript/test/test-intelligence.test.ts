import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  analyzeTypeScriptProgram,
  type TsAdapterSourceFile,
  type TypeScriptAdapterResult,
} from "../src/index.js";
import {
  createSnapshot,
  sha256Hex,
  snapshotCanonicalJson,
  utf8Encode,
  type SnapshotEdgeInput,
  type SnapshotNodeInput,
} from "@causoryn/domain";

/**
 * TypeScript Test Intelligence testleri (`Test` node'ları ve `TESTS` kenarları).
 *
 * Kapsam:
 * - Pozitif: test-affinity dosyalarda (`*.test.ts`, `*.spec.ts`, `*.tests.ts`,
 *   `*Tests.ts`, `*Test.ts`, `*Spec.tsx`, `__tests__/*.ts`) `describe` / `it` /
 *   `test` bloklarından `Test` node'u, `File --CONTAINS--> Test`, `Test --TESTS-->`
 *   ve `Test --CALLS-->` kenarları (verified + geçerli SourceSpan/sourceHash).
 * - Yardımcı koruması: test dosyasındaki `function` / `class` bildirimleri
 *   `Function` / `Class` olarak kalır; `Test --CALLS--> helper --CALLS--> target`
 *   zinciri bozulmaz.
 * - Negatif: üretim dosyasında (`src/validator.ts`) `test("x", () => ...)` veya
 *   `it("y", () => ...)` çağrıları `Test` node'u ya da `TESTS` kenarı üretmez;
 *   dinamik/boş başlıklı çağrılar uydurma `Test` node'u icat etmez.
 * - Determinizm & Kırmızı Çizgi: karıştırılmış kaynak sırası bit-bit aynı
 *   çıktıyı verir; serileştirilmiş çıktıda asla "geçti" veya "passed" geçmez.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_DIR = path.dirname(TEST_DIR);
const REPO_ROOT = path.dirname(path.dirname(ADAPTER_DIR));
const WORKSPACE_ID = "ws_ts_test_intel";
const UP = "." + ".";

const RUNNER_SHIM_TS = [
  "export interface SuiteOptions { readonly concurrent?: boolean; readonly timeout?: number; }",
  "export interface TestFn {",
  "  (title: string, fn: () => void | Promise<void>, timeout?: number): void;",
  "  (title: string, options: SuiteOptions, fn: () => void | Promise<void>): void;",
  "  only(title: string, fn: () => void | Promise<void>, timeout?: number): void;",
  "  skip(title: string, fn: () => void | Promise<void>, timeout?: number): void;",
  "}",
  "export interface SuiteFn {",
  "  (title: string, fn: () => void): void;",
  "  (title: string, options: SuiteOptions, fn: () => void): void;",
  "  only(title: string, fn: () => void): void;",
  "  skip(title: string, fn: () => void): void;",
  "}",
  "export declare const describe: SuiteFn;",
  "export declare const it: TestFn;",
  "export declare const test: TestFn;",
  "",
].join("\n");

const ORDER_REPO_TS = [
  "export class OrderRepository {",
  "  save(sku: string): string {",
  "    return `order:${sku}`;",
  "  }",
  "}",
  "",
].join("\n");

const ORDERS_SERVICE_TS = [
  'import { OrderRepository } from "./order-repo.js";',
  "",
  "export class OrdersService {",
  "  private readonly repo: OrderRepository;",
  "",
  "  constructor(repo: OrderRepository) {",
  "    this.repo = repo;",
  "  }",
  "",
  "  create(sku: string): string {",
  "    return this.repo.save(sku);",
  "  }",
  "",
  "  cancel(orderId: string): boolean {",
  "    return orderId.length > 0;",
  "  }",
  "}",
  "",
].join("\n");

const ORDERS_TEST_TS = [
  `import { describe, it, test } from "${UP}/src/test-shim.js";`,
  `import { OrderRepository } from "${UP}/src/order-repo.js";`,
  `import { OrdersService } from "${UP}/src/orders-service.js";`,
  "",
  "export class FakeOrderAudit {",
  "  record(id: string): string {",
  "    return id;",
  "  }",
  "}",
  "",
  "export function makeDefaultOrderService(): OrdersService {",
  "  return new OrdersService(new OrderRepository());",
  "}",
  "",
  'describe("OrdersService", () => {',
  '  describe.only("creation", () => {',
  '    it("creates order directly", () => {',
  "      const repo = new OrderRepository();",
  "      const service = new OrdersService(repo);",
  '      const invoke = () => service.create("sku-1");',
  "      invoke();",
  "    });",
  "  });",
  "",
  '  describe.skip("cancellation", () => {',
  "    test.only(`cancels order`, function () {",
  "      const service = makeDefaultOrderService();",
  '      service.cancel("ord-1");',
  "    });",
  "  });",
  "});",
  "",
  'test("creates order via helper", { timeout: 2000 }, () => {',
  "  makeDefaultOrderService();",
  "});",
  "",
].join("\n");

function baseSources(): TsAdapterSourceFile[] {
  return [
    { relativePath: "src/test-shim.ts", content: RUNNER_SHIM_TS },
    { relativePath: "src/order-repo.ts", content: ORDER_REPO_TS },
    { relativePath: "src/orders-service.ts", content: ORDERS_SERVICE_TS },
    { relativePath: "tests/orders.test.ts", content: ORDERS_TEST_TS },
  ];
}

function findNode(
  result: TypeScriptAdapterResult,
  kind: SnapshotNodeInput["kind"],
  qualifiedName: string,
  relativePath?: string,
): SnapshotNodeInput {
  const hit = result.nodes.find(
    (node) =>
      node.kind === kind &&
      node.qualifiedName === qualifiedName &&
      (relativePath === undefined || node.relativePath === relativePath),
  );
  if (hit === undefined) {
    const known = result.nodes
      .map((n) => `${n.kind}:${n.qualifiedName}@${n.relativePath ?? "-"}`)
      .join(", ");
    throw new Error(`Node bulunamadı (${kind} ${qualifiedName}). Mevcut: ${known}`);
  }
  return hit;
}

function sameRef(a: SnapshotNodeInput, b: SnapshotNodeInput): boolean {
  return (
    a.kind === b.kind &&
    a.qualifiedName === b.qualifiedName &&
    a.relativePath === b.relativePath
  );
}

function edgesBetween(
  result: TypeScriptAdapterResult,
  kind: SnapshotEdgeInput["kind"],
  from: SnapshotNodeInput,
  to: SnapshotNodeInput,
): SnapshotEdgeInput[] {
  return result.edges.filter(
    (edge) =>
      edge.kind === kind && sameRef(edge.from, from) && sameRef(edge.to, to),
  );
}

// paralel süit yükü altında senkron ts.createProgram 5s varsayılanını aşabildiğinden
// framework-linkers.test.ts ile aynı açık 30s sınırı uygulanır.
describe("TypeScript Test Intelligence — Test node ve TESTS kenarı üretimi", { timeout: 30_000 }, () => {
  it("describe + it + test bloklarından Test node'ları, CONTAINS, TESTS ve CALLS kenarlarını verified üretir", () => {
    const sources = baseSources();
    const result = analyzeTypeScriptProgram({
      workspaceId: WORKSPACE_ID,
      rootDir: REPO_ROOT,
      sources,
    });

    expect(result.state).toBe("ready");
    expect(result.diagnostics).toEqual([]);

    const testFile = findNode(result, "File", "tests/orders.test.ts", "tests/orders.test.ts");
    const directTest = findNode(
      result,
      "Test",
      "OrdersService > creation > creates order directly",
      "tests/orders.test.ts",
    );
    const cancelTest = findNode(
      result,
      "Test",
      "OrdersService > cancellation > cancels order",
      "tests/orders.test.ts",
    );
    const standaloneTest = findNode(
      result,
      "Test",
      "creates order via helper",
      "tests/orders.test.ts",
    );

    expect(directTest.language).toBe("typescript");
    expect(cancelTest.language).toBe("typescript");
    expect(standaloneTest.language).toBe("typescript");

    const expectedTestHash = sha256Hex(utf8Encode(ORDERS_TEST_TS));

    for (const testNode of [directTest, cancelTest, standaloneTest]) {
      const contains = edgesBetween(result, "CONTAINS", testFile, testNode);
      expect(contains).toHaveLength(1);
      const edge = contains[0] as SnapshotEdgeInput;
      expect(edge.resolution).toBe("verified");
      expect((edge.evidence ?? []).length).toBeGreaterThanOrEqual(1);
      const ev = edge.evidence?.[0];
      expect(ev?.kind).toBe("ast-span");
      expect(ev?.span?.relativePath).toBe("tests/orders.test.ts");
      expect(ev?.span?.sourceHash).toBe(expectedTestHash);
      expect(ev?.span?.startLine).toBeGreaterThanOrEqual(1);
      expect((ev?.span?.endLine ?? 0) >= (ev?.span?.startLine ?? 1)).toBe(true);
    }

    const ordersServiceClass = findNode(
      result,
      "Class",
      "OrdersService",
      "src/orders-service.ts",
    );
    const createMethod = findNode(
      result,
      "Method",
      "OrdersService.create",
      "src/orders-service.ts",
    );
    const cancelMethod = findNode(
      result,
      "Method",
      "OrdersService.cancel",
      "src/orders-service.ts",
    );

    // new OrdersService(...) -> hem CALLS hem TESTS (verified, semantic-symbol)
    for (const edgeKind of ["CALLS", "TESTS"] as const) {
      const classEdges = edgesBetween(result, edgeKind, directTest, ordersServiceClass);
      expect(classEdges).toHaveLength(1);
      expect(classEdges[0]?.resolution).toBe("verified");
      const ev = classEdges[0]?.evidence?.[0];
      expect(ev?.kind).toBe("semantic-symbol");
      expect(ev?.span?.relativePath).toBe("tests/orders.test.ts");
      expect(ev?.span?.sourceHash).toBe(expectedTestHash);

      const methodEdges = edgesBetween(result, edgeKind, directTest, createMethod);
      expect(methodEdges).toHaveLength(1);
      expect(methodEdges[0]?.resolution).toBe("verified");
      const methodEv = methodEdges[0]?.evidence?.[0];
      expect(methodEv?.kind).toBe("semantic-symbol");
      expect(methodEv?.span?.relativePath).toBe("tests/orders.test.ts");
      expect(methodEv?.span?.sourceHash).toBe(expectedTestHash);
    }

    // test.only(`cancels order`, function () { ... }) -> OrdersService.cancel TESTS + CALLS
    expect(edgesBetween(result, "TESTS", cancelTest, cancelMethod)).toHaveLength(1);
    expect(edgesBetween(result, "CALLS", cancelTest, cancelMethod)).toHaveLength(1);

    // Test gövdesi içindeki yerel const invoke = () => ... ayrı Handler node'una dönüşmez
    const spuriousHandler = result.nodes.find(
      (n) => n.kind === "Handler" && n.qualifiedName === "invoke",
    );
    expect(spuriousHandler).toBeUndefined();
  });

  it("test dosyasındaki yardımcı fonksiyon ve sınıflar Function/Class olarak kalır; Test -> helper -> target CALLS zinciri kurulur", () => {
    const result = analyzeTypeScriptProgram({
      workspaceId: WORKSPACE_ID,
      rootDir: REPO_ROOT,
      sources: baseSources(),
    });

    const helperFn = findNode(
      result,
      "Function",
      "makeDefaultOrderService",
      "tests/orders.test.ts",
    );
    const fakeClass = findNode(
      result,
      "Class",
      "FakeOrderAudit",
      "tests/orders.test.ts",
    );
    const fakeMethod = findNode(
      result,
      "Method",
      "FakeOrderAudit.record",
      "tests/orders.test.ts",
    );
    expect(helperFn.kind).toBe("Function");
    expect(fakeClass.kind).toBe("Class");
    expect(fakeMethod.kind).toBe("Method");

    const standaloneTest = findNode(
      result,
      "Test",
      "creates order via helper",
      "tests/orders.test.ts",
    );
    const ordersServiceClass = findNode(
      result,
      "Class",
      "OrdersService",
      "src/orders-service.ts",
    );

    // Test --CALLS--> makeDefaultOrderService --CALLS--> OrdersService
    expect(edgesBetween(result, "CALLS", standaloneTest, helperFn)).toHaveLength(1);
    expect(edgesBetween(result, "CALLS", helperFn, ordersServiceClass)).toHaveLength(1);
    // Helper Function olduğu için kendisi TESTS kenarı yaymaz
    expect(edgesBetween(result, "TESTS", helperFn, ordersServiceClass)).toHaveLength(0);
    // Doğrudan yalnızca helper çağıran test, OrdersService'e doğrudan TESTS kenarı yaymaz
    expect(edgesBetween(result, "TESTS", standaloneTest, ordersServiceClass)).toHaveLength(0);
  });

  it("üretim dosyasında test/it/describe adlı fonksiyon çağrıları Test node veya TESTS kenarı üretmez", () => {
    const validatorTs = [
      'import { OrderRepository } from "./order-repo.js";',
      "",
      "export function test(ruleName: string, check: () => boolean): boolean {",
      "  return ruleName.length > 0 && check();",
      "}",
      "",
      "export function it(label: string, action: () => void): void {",
      "  if (label.length > 0) action();",
      "}",
      "",
      "export function validateOrder(sku: string): boolean {",
      "  const repo = new OrderRepository();",
      '  it("audit", () => {',
      "    repo.save(sku);",
      "  });",
      '  return test("non-empty-sku", () => sku.trim().length > 0);',
      "}",
      "",
    ].join("\n");

    const result = analyzeTypeScriptProgram({
      workspaceId: WORKSPACE_ID,
      rootDir: REPO_ROOT,
      sources: [
        { relativePath: "src/order-repo.ts", content: ORDER_REPO_TS },
        { relativePath: "src/validator.ts", content: validatorTs },
      ],
    });

    expect(result.state).toBe("ready");
    expect(result.nodes.filter((n) => n.kind === "Test")).toEqual([]);
    expect(result.edges.filter((e) => e.kind === "TESTS")).toEqual([]);

    // Üretim dosyasındaki normal CALLS davranışı korunur
    const validateFn = findNode(result, "Function", "validateOrder", "src/validator.ts");
    const testFn = findNode(result, "Function", "test", "src/validator.ts");
    expect(edgesBetween(result, "CALLS", validateFn, testFn)).toHaveLength(1);
  });

  it("tüm test-affinity yol kalıplarını tanır ve dinamik/boş başlıklarda Test node uydurmaz", () => {
    const affinityPaths = [
      "src/orders.spec.ts",
      "src/orders.tests.ts",
      "src/OrdersTests.ts",
      "src/OrdersTest.ts",
      "src/OrdersSpec.tsx",
      "src/__tests__/orders-suite.ts",
    ];

    const affinitySources: TsAdapterSourceFile[] = affinityPaths.map((testPath) => {
      const importPrefix = testPath.startsWith("src/__tests__/")
        ? `${UP}/`
        : "./";
      return {
        relativePath: testPath,
        content: [
          `import { it } from "${importPrefix}test-shim.js";`,
          `import { OrderRepository } from "${importPrefix}order-repo.js";`,
          'const dynamicName = "computed";',
          "it(dynamicName, () => { new OrderRepository(); });",
          'it("", () => { new OrderRepository(); });',
          'it("   ", () => { new OrderRepository(); });',
          `it("saves order in ${testPath}", () => {`,
          "  const repo = new OrderRepository();",
          '  repo.save("x");',
          "});",
          "",
        ].join("\n"),
      };
    });

    const result = analyzeTypeScriptProgram({
      workspaceId: WORKSPACE_ID,
      rootDir: REPO_ROOT,
      sources: [
        { relativePath: "src/test-shim.ts", content: RUNNER_SHIM_TS },
        { relativePath: "src/order-repo.ts", content: ORDER_REPO_TS },
        ...affinitySources,
      ],
    });

    const saveMethod = findNode(result, "Method", "OrderRepository.save", "src/order-repo.ts");
    const allTestNodes = result.nodes.filter((n) => n.kind === "Test");
    expect(allTestNodes).toHaveLength(affinityPaths.length);

    for (const testPath of affinityPaths) {
      const testNode = findNode(result, "Test", `saves order in ${testPath}`, testPath);
      expect(edgesBetween(result, "TESTS", testNode, saveMethod)).toHaveLength(1);
    }
  });

  it("determinizm ve dürüstlük: kaynak sırası karıştırıldığında bit-bit aynıdır; çıktıda 'geçti' veya 'passed' geçmez", () => {
    const forward = analyzeTypeScriptProgram({
      workspaceId: WORKSPACE_ID,
      rootDir: REPO_ROOT,
      sources: baseSources(),
    });
    const reversed = analyzeTypeScriptProgram({
      workspaceId: WORKSPACE_ID,
      rootDir: REPO_ROOT,
      sources: [...baseSources()].reverse(),
    });

    expect(forward.nodes.filter((n) => n.kind === "Test").length).toBeGreaterThanOrEqual(3);
    expect(forward.edges.filter((e) => e.kind === "TESTS").length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));

    const snapForward = createSnapshot({
      workspaceId: WORKSPACE_ID,
      revision: { id: "rev-ti-1", sequence: 1 },
      configHash: "cfg-ti",
      analyzerFingerprint: "ts-adapter@0.1.0",
      state: "ready",
      createdAt: "2026-11-18T12:00:00.000Z",
      nodes: forward.nodes,
      edges: forward.edges,
    });
    const snapReversed = createSnapshot({
      workspaceId: WORKSPACE_ID,
      revision: { id: "rev-ti-1", sequence: 1 },
      configHash: "cfg-ti",
      analyzerFingerprint: "ts-adapter@0.1.0",
      state: "ready",
      createdAt: "2026-11-18T12:00:00.000Z",
      nodes: reversed.nodes,
      edges: reversed.edges,
    });

    const serializedSnap = snapshotCanonicalJson(snapForward);
    expect(snapshotCanonicalJson(snapReversed)).toBe(serializedSnap);

    const serializedAdapter = JSON.stringify(forward);
    expect(serializedAdapter).not.toContain("geçti");
    expect(serializedAdapter.toLowerCase()).not.toContain("passed");
    expect(serializedSnap).not.toContain("geçti");
    expect(serializedSnap.toLowerCase()).not.toContain("passed");
  });
});
