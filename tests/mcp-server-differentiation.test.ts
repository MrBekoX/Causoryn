import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CausorynToolError,
  createCausorynContext,
  deriveTestPlan,
  preflightChange,
} from "@causoryn/mcp-server";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `causoryn-diff-t16-${prefix}-`));
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

function writeSampleWorkspace(root: string): void {
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "tests"), { recursive: true });
  writeFileSync(
    path.join(root, "src", "order-repo.ts"),
    `export class OrderRepository {\n  save(id: string): string {\n    return id;\n  }\n}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(root, "src", "order-service.ts"),
    `import { OrderRepository } from "./order-repo.js";\nexport class OrderService {\n  constructor(private readonly repo: OrderRepository) {}\n  create(id: string): string {\n    return this.repo.save(id);\n  }\n}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(root, "tests", "order-service.test.ts"),
    `import { OrderService } from "../src/order-service.js";\nimport { OrderRepository } from "../src/order-repo.js";\nexport function testCreateOrder(): string {\n  return new OrderService(new OrderRepository()).create("1");\n}\n`,
    "utf8",
  );
}

describe("Task 1.6c — derive_test_plan preflightId resolution", () => {
  it("resolves stored preflightId from preflightStore (targetFiles) and derives the matching test plan", async () => {
    const root = makeTempDir("preflight-files");
    writeSampleWorkspace(root);
    const context = createCausorynContext(
      { workspaceId: "default", allowRoots: [root], autoIndex: true },
      { clock: fixedClock },
    );
    try {
      const pf = await preflightChange(context, "req-pf-files", {
        intent: "change order service file",
        targetFiles: ["src/order-service.ts"],
      });
      expect(pf.status).toBe("ok");
      const pfData = pf.data as Record<string, unknown>;
      const preflightId = pfData.preflightId as string;
      const expectedTestPlanId = pfData.testPlanId as string;

      const planEnvelope = deriveTestPlan(context, "req-tp-from-pf-files", {
        preflightId,
      });
      expect(planEnvelope.status).toBe("ok");
      const planData = planEnvelope.data as Record<string, unknown>;
      expect(planData.planId).toBe(expectedTestPlanId);
      const candidates = planData.candidates as Array<Record<string, unknown>>;
      expect(candidates.length).toBeGreaterThan(0);
      expect(
        candidates.some((c) => String(c.testQualifiedName).includes("order-service.test")),
      ).toBe(true);
    } finally {
      context.close();
    }
  }, 60_000);

  it("resolves stored preflightId from preflightStore (targetSymbols) and derives the matching test plan", async () => {
    const root = makeTempDir("preflight-symbols");
    writeSampleWorkspace(root);
    const context = createCausorynContext(
      { workspaceId: "default", allowRoots: [root], autoIndex: true },
      { clock: fixedClock },
    );
    try {
      const pf = await preflightChange(context, "req-pf-symbols", {
        intent: "change OrderService.create",
        targetSymbols: ["OrderService.create"],
      });
      const pfData = pf.data as Record<string, unknown>;
      const preflightId = pfData.preflightId as string;
      const expectedTestPlanId = pfData.testPlanId as string;

      const planEnvelope = deriveTestPlan(context, "req-tp-from-pf-symbols", {
        preflightId,
      });
      expect(planEnvelope.status).toBe("ok");
      const planData = planEnvelope.data as Record<string, unknown>;
      expect(planData.planId).toBe(expectedTestPlanId);
      const identified = planData.identifiedSymbols as Array<Record<string, unknown>>;
      expect(identified.some((s) => s.qualifiedName === "OrderService.create")).toBe(true);
    } finally {
      context.close();
    }
  }, 60_000);

  it("throws INVALID_ARGUMENT when preflightId is missing/expired, or when both changeSet and preflightId are given, or when neither is given", () => {
    const root = makeTempDir("preflight-neg");
    writeSampleWorkspace(root);
    const context = createCausorynContext(
      { workspaceId: "default", allowRoots: [root], autoIndex: true },
      { clock: fixedClock },
    );
    try {
      // Missing/expired preflightId
      expect(() =>
        deriveTestPlan(context, "req-tp-missing", {
          preflightId: "preflight:0000000000000000000000000000000000000000000000000000000000000000",
        }),
      ).toThrowError(CausorynToolError);
      try {
        deriveTestPlan(context, "req-tp-missing-code", {
          preflightId: "preflight:0000000000000000000000000000000000000000000000000000000000000000",
        });
      } catch (err) {
        expect((err as CausorynToolError).code).toBe("INVALID_ARGUMENT");
      }

      // Both provided
      try {
        deriveTestPlan(context, "req-tp-both", {
          changeSet: { changedSymbols: ["OrderService.create"] },
          preflightId: "preflight:abc",
        });
        expect.unreachable("should throw");
      } catch (err) {
        expect(err).toBeInstanceOf(CausorynToolError);
        expect((err as CausorynToolError).code).toBe("INVALID_ARGUMENT");
      }

      // Neither provided
      try {
        deriveTestPlan(context, "req-tp-neither", {});
        expect.unreachable("should throw");
      } catch (err) {
        expect(err).toBeInstanceOf(CausorynToolError);
        expect((err as CausorynToolError).code).toBe("INVALID_ARGUMENT");
      }
    } finally {
      context.close();
    }
  }, 60_000);
});
