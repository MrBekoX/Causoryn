import { describe, expect, it } from "vitest";

import {
  ContractDiscoveryError,
  discoverAsyncApiContracts,
  discoverContractsFromTexts,
  discoverOpenApiContracts,
  MAX_SPEC_BYTES,
  MAX_SPEC_NODES,
} from "../src/index.js";
import {
  MAX_PROJECTION_WORK_UNITS,
  ProjectionBudget,
  TEXT_UNIT_CHARS,
  textUnits,
} from "../src/projection-budget.js";

import { generateAsyncApi, generateOpenApi, routeName, topicName } from "./large-spec-fixtures.js";

/**
 * CAU-04 (CWE-407/400): OpenAPI/AsyncAPI projection must cost linear work in
 * the document and stop at a deterministic total budget. Work is measured with
 * the ProjectionBudget counter (work units), never with wall-clock time.
 */

function thrown(fn: () => unknown): ContractDiscoveryError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractDiscoveryError);
    return error as ContractDiscoveryError;
  }
  throw new Error("expected a ContractDiscoveryError, but nothing was thrown");
}

const PROPS = 25;

describe("ProjectionBudget", () => {
  it("defaults to MAX_PROJECTION_WORK_UNITS (a documented multiple of the parser node quota)", () => {
    expect(MAX_PROJECTION_WORK_UNITS).toBe(1_000_000);
    expect(MAX_PROJECTION_WORK_UNITS).toBe(4 * MAX_SPEC_NODES);
    const budget = new ProjectionBudget();
    expect(budget.limit).toBe(MAX_PROJECTION_WORK_UNITS);
    expect(budget.used).toBe(0);
  });

  it("accumulates charges and rejects the charge that crosses the limit with contracts/limit-exceeded", () => {
    const budget = new ProjectionBudget(10);
    budget.charge(4);
    budget.charge(6);
    expect(budget.used).toBe(10);
    const error = thrown(() => budget.charge(1));
    expect(error.code).toBe("contracts/limit-exceeded");
    expect(error.message).toContain("10");
  });

  it("rejects a limit that is not a positive safe integer with contracts/invalid-input", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(thrown(() => new ProjectionBudget(bad)).code).toBe("contracts/invalid-input");
    }
  });

  it("textUnits charges emitted text by length: one unit per full TEXT_UNIT_CHARS characters", () => {
    expect(TEXT_UNIT_CHARS).toBe(64);
    expect(textUnits()).toBe(0);
    expect(textUnits("short", undefined, "x".repeat(63))).toBe(0);
    expect(textUnits("x".repeat(64))).toBe(1);
    expect(textUnits("x".repeat(640), "y".repeat(130))).toBe(12);
  });
});

describe("emitted text is charged by length (CAU-04: long strings fanned out by $ref or aliases)", () => {
  const LONG_TYPE = "t".repeat(40_000);

  it("a long shared property type costs work per route in proportion to its length", () => {
    const routes = 200;
    const short = new ProjectionBudget();
    discoverOpenApiContracts("ws", "t/openapi.yaml", generateOpenApi(routes, 1).text, { budget: short });
    const long = new ProjectionBudget();
    discoverOpenApiContracts("ws", "t/openapi.yaml", generateOpenApi(routes, 1, { propertyType: LONG_TYPE }).text, {
      budget: long,
    });
    expect(long.used - short.used).toBeGreaterThanOrEqual(routes * Math.floor(LONG_TYPE.length / TEXT_UNIT_CHARS));
  });

  it("the default budget rejects a long property type fanned out to many routes and channels", () => {
    // 2000 x 625 text units ≈ 1.25M > MAX_PROJECTION_WORK_UNITS, though the
    // element count (2000 x 1 property) is tiny and the text is under 1 MiB.
    const openapi = generateOpenApi(2000, 1, { propertyType: LONG_TYPE }).text;
    expect(Buffer.byteLength(openapi, "utf8")).toBeLessThan(MAX_SPEC_BYTES);
    expect(thrown(() => discoverOpenApiContracts("ws", "t/openapi.yaml", openapi)).code).toBe("contracts/limit-exceeded");

    const asyncapi = generateAsyncApi(2000, 1, { propertyType: LONG_TYPE }).text;
    expect(Buffer.byteLength(asyncapi, "utf8")).toBeLessThan(MAX_SPEC_BYTES);
    expect(thrown(() => discoverAsyncApiContracts("ws", "t/asyncapi.yaml", asyncapi)).code).toBe(
      "contracts/limit-exceeded",
    );
  });

  it("an aliased long operationId is charged for every operation that repeats it", () => {
    const operationId = "o".repeat(6_400);
    const lines = ["openapi: 3.1.0", "info: {title: Alias, version: 1.0.0}", "x-ids:", `  id: &op ${operationId}`, "paths:"];
    for (let index = 0; index < 50; index += 1) lines.push(`  /r${String(index)}:`, "    get:", "      operationId: *op");
    const budget = new ProjectionBudget();
    const out = discoverOpenApiContracts("ws", "alias/openapi.yaml", lines.join("\n"), { budget });
    expect(out.contracts).toHaveLength(50);
    // name and qualifiedName both carry the operationId: 2 x 100 text units per operation.
    expect(budget.used).toBeGreaterThanOrEqual(50 * 2 * (operationId.length / TEXT_UNIT_CHARS));
  });
});

describe("OpenAPI projection cost (CAU-04)", () => {
  const ROUTES = 3000;
  const spec = generateOpenApi(ROUTES, PROPS);

  it("the generated document is large but inside the parser limits", () => {
    expect(Buffer.byteLength(spec.text, "utf8")).toBeLessThan(MAX_SPEC_BYTES);
    expect(discoverOpenApiContracts("ws", "big/openapi.yaml", spec.text).contracts).toHaveLength(ROUTES);
  });

  it("projects every route with exact evidence lines and deterministic output", () => {
    const first = discoverOpenApiContracts("ws", "big/openapi.yaml", spec.text);
    const second = discoverOpenApiContracts("ws", "big/openapi.yaml", spec.text);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.diagnostics).toEqual([]);
    for (const contract of first.contracts) {
      expect(contract.evidence.startLine).toBe(spec.keyLines.get(contract.route ?? ""));
      expect(contract.properties).toHaveLength(PROPS);
      expect(contract.requiredPropertyNames).toHaveLength(PROPS);
      expect(contract.resolvedRefs).toEqual(["#/components/schemas/Shared"]);
      expect(contract.responseSchemaIds).toEqual(["Shared"]);
    }
  });

  it("keeps evidence lines exact for CRLF documents", () => {
    const crlf = generateOpenApi(500, 3, { eol: "\r\n" });
    const out = discoverOpenApiContracts("ws", "big/openapi.yaml", crlf.text);
    expect(out.contracts).toHaveLength(500);
    for (const contract of out.contracts) {
      expect(contract.evidence.startLine).toBe(crlf.keyLines.get(contract.route ?? ""));
    }
  });

  it("measured work is linear in the number of routes and stays under the default budget", () => {
    const half = new ProjectionBudget();
    discoverOpenApiContracts("ws", "big/openapi.yaml", generateOpenApi(ROUTES / 2, PROPS).text, { budget: half });
    const full = new ProjectionBudget();
    discoverOpenApiContracts("ws", "big/openapi.yaml", spec.text, { budget: full });

    // Work is really counted: at least one unit per route plus its properties.
    expect(full.used).toBeGreaterThan(ROUTES * PROPS);
    // Linear: a constant cost per route (lookups, candidate, emitted properties
    // and required names) plus a one-off schema expansion.
    expect(full.used).toBeLessThanOrEqual(ROUTES * (8 + 2 * PROPS) + 1000);
    // Doubling the routes at most doubles the work (no quadratic term).
    expect(full.used).toBeLessThanOrEqual(2 * half.used);
    expect(full.used).toBeLessThanOrEqual(full.limit);
  });

  it("a repeated $ref schema is expanded once: every route shares the same property representations", () => {
    const out = discoverOpenApiContracts("ws", "big/openapi.yaml", generateOpenApi(3, 4).text);
    const [a, b, c] = out.contracts;
    expect(a?.properties[0]).toBeDefined();
    expect(b?.properties[0]).toBe(a?.properties[0]);
    expect(c?.properties[3]).toBe(a?.properties[3]);
    // Arrays stay per candidate (no aliasing between candidates' lists).
    expect(b?.properties).not.toBe(a?.properties);
    expect(b?.requiredPropertyNames).not.toBe(a?.requiredPropertyNames);
  });

  it("a small injected budget ends in a controlled contracts/limit-exceeded without source text", () => {
    const error = thrown(() =>
      discoverOpenApiContracts("ws", "big/openapi.yaml", spec.text, { budget: new ProjectionBudget(5_000) }),
    );
    expect(error.code).toBe("contracts/limit-exceeded");
    expect(error.message).toContain("5000");
    expect(error.message).not.toContain(routeName(1));
    expect(error.message).not.toContain("field1");
  });

  it("the budget boundary is deterministic: exactly the measured work passes, one unit less fails", () => {
    const small = generateOpenApi(40, 6).text;
    const measured = new ProjectionBudget();
    const reference = discoverOpenApiContracts("ws", "small/openapi.yaml", small, { budget: measured });

    const exact = discoverOpenApiContracts("ws", "small/openapi.yaml", small, {
      budget: new ProjectionBudget(measured.used),
    });
    expect(JSON.stringify(exact)).toBe(JSON.stringify(reference));
    expect(JSON.stringify(discoverOpenApiContracts("ws", "small/openapi.yaml", small))).toBe(
      JSON.stringify(reference),
    );

    const first = thrown(() =>
      discoverOpenApiContracts("ws", "small/openapi.yaml", small, { budget: new ProjectionBudget(measured.used - 1) }),
    );
    const again = thrown(() =>
      discoverOpenApiContracts("ws", "small/openapi.yaml", small, { budget: new ProjectionBudget(measured.used - 1) }),
    );
    expect(first.code).toBe("contracts/limit-exceeded");
    expect(again.message).toBe(first.message);
  });

  it("the default budget applies on the orchestration path: shared-$ref re-expansion past the budget is rejected", () => {
    // 1100 routes x (500 properties + 500 required names) of emitted
    // representation ≈ 1.1M work units > MAX_PROJECTION_WORK_UNITS, while the
    // text and node count stay inside the parser limits.
    const heavy = generateOpenApi(1100, 500).text;
    expect(Buffer.byteLength(heavy, "utf8")).toBeLessThan(MAX_SPEC_BYTES);
    const error = thrown(() => discoverContractsFromTexts("ws", [{ relativePath: "heavy/openapi.yaml", text: heavy }]));
    expect(error.code).toBe("contracts/limit-exceeded");
  });

  it("$ref cycles and self references terminate with a single-hop shape (no recursive expansion)", () => {
    const text = [
      "openapi: 3.1.0",
      "info: {title: Cycles, version: 1.0.0}",
      "paths:",
      "  /a:",
      "    post:",
      "      requestBody:",
      "        content:",
      "          application/json:",
      "            schema:",
      '              $ref: "#/components/schemas/A"',
      "  /node:",
      "    post:",
      "      requestBody:",
      "        content:",
      "          application/json:",
      "            schema:",
      '              $ref: "#/components/schemas/Node"',
      "components:",
      "  schemas:",
      "    A:",
      '      $ref: "#/components/schemas/B"',
      "    B:",
      '      $ref: "#/components/schemas/A"',
      "    Node:",
      "      type: object",
      "      required: [child]",
      "      properties:",
      "        child:",
      '          $ref: "#/components/schemas/Node"',
    ].join("\n");
    const budget = new ProjectionBudget();
    const out = discoverOpenApiContracts("ws", "cycles/openapi.yaml", text, { budget });
    const byRoute = new Map(out.contracts.map((contract) => [contract.route, contract]));
    expect(byRoute.get("/a")?.properties).toEqual([]);
    expect(byRoute.get("/a")?.resolvedRefs).toEqual(["#/components/schemas/A"]);
    expect(byRoute.get("/node")?.properties).toEqual([{ name: "child", type: "ref", required: true }]);
    expect(budget.used).toBeLessThan(100);
  });
});

describe("AsyncAPI projection cost (CAU-04)", () => {
  const CHANNELS = 4000;
  const spec = generateAsyncApi(CHANNELS, PROPS);

  it("projects every channel with exact evidence lines and deterministic output", () => {
    expect(Buffer.byteLength(spec.text, "utf8")).toBeLessThan(MAX_SPEC_BYTES);
    const first = discoverAsyncApiContracts("ws", "big/asyncapi.yaml", spec.text);
    const second = discoverAsyncApiContracts("ws", "big/asyncapi.yaml", spec.text);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.contracts).toHaveLength(CHANNELS);
    expect(first.diagnostics).toEqual([]);
    for (const contract of first.contracts) {
      expect(contract.evidence.startLine).toBe(spec.keyLines.get(contract.topic ?? ""));
      expect(contract.properties).toHaveLength(PROPS);
      expect(contract.resolvedRefs).toEqual(["#/components/schemas/Shared"]);
    }
  });

  it("measured work is linear in the number of channels and stays under the default budget", () => {
    const half = new ProjectionBudget();
    discoverAsyncApiContracts("ws", "big/asyncapi.yaml", generateAsyncApi(CHANNELS / 2, PROPS).text, {
      budget: half,
    });
    const full = new ProjectionBudget();
    discoverAsyncApiContracts("ws", "big/asyncapi.yaml", spec.text, { budget: full });

    expect(full.used).toBeGreaterThan(CHANNELS * PROPS);
    expect(full.used).toBeLessThanOrEqual(CHANNELS * (8 + 2 * PROPS) + 1000);
    expect(full.used).toBeLessThanOrEqual(2 * half.used);
    expect(full.used).toBeLessThanOrEqual(full.limit);
  });

  it("a repeated payload $ref is expanded once: channels share the same property representations", () => {
    const out = discoverAsyncApiContracts("ws", "big/asyncapi.yaml", generateAsyncApi(2, 3).text);
    const [a, b] = out.contracts;
    expect(a?.properties[0]).toBeDefined();
    expect(b?.properties[0]).toBe(a?.properties[0]);
    expect(b?.properties).not.toBe(a?.properties);
  });

  it("a small injected budget ends in a controlled contracts/limit-exceeded without source text", () => {
    const error = thrown(() =>
      discoverAsyncApiContracts("ws", "big/asyncapi.yaml", spec.text, { budget: new ProjectionBudget(5_000) }),
    );
    expect(error.code).toBe("contracts/limit-exceeded");
    expect(error.message).not.toContain(topicName(1));
  });

  it("the default budget applies on the orchestration path for AsyncAPI too", () => {
    const heavy = generateAsyncApi(1100, 500).text;
    expect(Buffer.byteLength(heavy, "utf8")).toBeLessThan(MAX_SPEC_BYTES);
    const error = thrown(() => discoverContractsFromTexts("ws", [{ relativePath: "heavy/asyncapi.yaml", text: heavy }]));
    expect(error.code).toBe("contracts/limit-exceeded");
  });

  it("v3-style channels without operations are charged and still projected as #none candidates", () => {
    const text = ["asyncapi: 3.0.0", "info: {title: V3, version: 1.0.0}", "channels:", "  a: {}", "  b: {}"].join("\n");
    const budget = new ProjectionBudget();
    const out = discoverAsyncApiContracts("ws", "v3/asyncapi.yaml", text, { budget });
    expect(out.contracts.map((contract) => contract.qualifiedName)).toEqual(["a#none", "b#none"]);
    expect(budget.used).toBeGreaterThan(0);
  });
});
