import { describe, expect, it } from "vitest";

import {
  ContractDiscoveryError,
  discoverAsyncApiContracts,
  discoverContractsFromTexts,
  discoverJsonSchemaContracts,
  discoverOpenApiContracts,
  MAX_SPEC_BYTES,
  assertSpecSize,
  parseStructuredSpec,
} from "../src/index.js";

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ContractDiscoveryError);
    return (err as ContractDiscoveryError).code;
  }
  throw new Error("ContractDiscoveryError beklenmişti ama fırlatılmadı");
}

/* ------------------------------------------------------------------ */
/* OpenAPI keşfi (TŞ §11: path, method, request/response)              */
/* ------------------------------------------------------------------ */

const OPENAPI_SPEC = [
  "openapi: 3.1.0",
  "info:",
  "  title: Orders API",
  "  version: 1.0.0",
  "paths:",
  "  /orders:",
  "    post:",
  "      operationId: createOrder",
  "      requestBody:",
  "        content:",
  "          application/json:",
  "            schema:",
  '              $ref: "#/components/schemas/CreateOrderInput"',
  "      responses:",
  '        "201":',
  "          content:",
  "            application/json:",
  "              schema:",
  '                $ref: "#/components/schemas/Order"',
  "  /orders/{orderId}:",
  "    get:",
  "      operationId: getOrder",
  "      responses:",
  '        "200":',
  "          content:",
  "            application/json:",
  "              schema:",
  '                $ref: "#/components/schemas/Order"',
  "components:",
  "  schemas:",
  "    CreateOrderInput:",
  "      type: object",
  "      required: [amount, currency]",
  "      properties:",
  "        amount:",
  "          type: number",
  "        currency:",
  "          type: string",
  "    Order:",
  "      type: object",
  "      required: [id]",
  "      properties:",
  "        id:",
  "          type: string",
].join("\n");

describe("discoverOpenApiContracts", () => {
  it("pozitif: path+method → ApiContract adayı; request/response şema ID ve required kanıtı dosya+satırlı", () => {
    const out = discoverOpenApiContracts("ws-1", "docs/openapi.yaml", OPENAPI_SPEC);

    expect(out.diagnostics).toEqual([]);
    expect(out.contracts).toHaveLength(2);

    const post = out.contracts.find((c) => c.route === "/orders" && c.method === "POST");
    expect(post).toBeDefined();
    expect(post?.nodeKind).toBe("ApiContract");
    expect(post?.sourceKind).toBe("openapi");
    expect(post?.name).toBe("createOrder");
    expect(post?.qualifiedName).toBe("createOrder");
    expect(post?.requestSchemaId).toBe("CreateOrderInput");
    expect(post?.responseSchemaIds).toEqual(["Order"]);
    expect(post?.requiredPropertyNames).toEqual(["amount", "currency"]);
    expect(post?.properties).toHaveLength(2);
    expect(post?.certainty).toBe("full");
    expect(post?.diagnostics).toEqual([]);
    // satır kanıtı: `  /orders:` anahtarının dosyadaki gerçek satırı (1 tabanlı)
    expect(post?.evidence).toEqual({ relativePath: "docs/openapi.yaml", startLine: 6, endLine: 6 });
    expect(post?.contractId).toMatch(/^node:[0-9a-f]{64}$/);

    const get = out.contracts.find((c) => c.route === "/orders/{orderId}" && c.method === "GET");
    expect(get?.qualifiedName).toBe("getOrder");
    expect(get?.requestSchemaId).toBeUndefined();
    expect(get?.responseSchemaIds).toEqual(["Order"]);
  });

  it("pozitif: determinizm — aynı girdi bit-bit aynı JSON üretir (TŞ §8 invariant vi)", () => {
    const a = JSON.stringify(discoverOpenApiContracts("ws-1", "docs/openapi.yaml", OPENAPI_SPEC));
    const b = JSON.stringify(discoverOpenApiContracts("ws-1", "docs/openapi.yaml", OPENAPI_SPEC));
    expect(a).toBe(b);
  });

  it("negatif: OpenAPI 2.0 (Swagger) → contracts/unsupported-spec açık reddi", () => {
    const swagger = 'swagger: "2.0"\ninfo:\n  title: x\n  version: 1\npaths: {}\n';
    expect(() => discoverOpenApiContracts("ws-1", "openapi.yaml", swagger)).toThrowError(
      ContractDiscoveryError,
    );
    expect(errorCode(() => discoverOpenApiContracts("ws-1", "openapi.yaml", swagger))).toBe(
      "contracts/unsupported-spec",
    );
  });

  it("negatif: paths alanı yok → contracts/spec-invalid", () => {
    const noPaths = "openapi: 3.1.0\ninfo:\n  title: x\n  version: 1\n";
    expect(errorCode(() => discoverOpenApiContracts("ws-1", "openapi.yaml", noPaths))).toBe(
      "contracts/spec-invalid",
    );
  });

  it("negatif: bozuk YAML (tab girintisi) → contracts/spec-yaml-invalid", () => {
    const broken = "openapi: 3.1.0\ninfo:\n\ttitle: tab girintisi\n";
    expect(errorCode(() => discoverOpenApiContracts("ws-1", "openapi.yaml", broken))).toBe(
      "contracts/spec-yaml-invalid",
    );
  });

  it("negatif: kök dizi → contracts/spec-invalid", () => {
    expect(errorCode(() => discoverOpenApiContracts("ws-1", "openapi.yaml", "- a\n- b\n"))).toBe(
      "contracts/spec-invalid",
    );
  });

  it("pozitif: yerel #/components/schemas $ref'i çözümlenir ve resolvedRefs'e yazılır (json-schema ile tutarlı kanıt)", () => {
    const out = discoverOpenApiContracts("ws-1", "docs/openapi.yaml", OPENAPI_SPEC);
    const post = out.contracts.find((c) => c.method === "POST");
    expect(post?.resolvedRefs).toEqual(["#/components/schemas/CreateOrderInput"]);
    const get = out.contracts.find((c) => c.method === "GET");
    // GET işleminin request gövdesi yok → çözümlenen ref yok
    expect(get?.resolvedRefs).toEqual([]);
  });

  it("partial: yerel request $ref çözümlenemediğinde contracts/openapi-ref-unresolved + certainty partial", () => {
    const dangling = OPENAPI_SPEC.replace(
      '"#/components/schemas/CreateOrderInput"',
      '"#/components/schemas/Missing"',
    );
    const out = discoverOpenApiContracts("ws-1", "docs/openapi.yaml", dangling);
    const post = out.contracts.find((c) => c.method === "POST");
    expect(post?.certainty).toBe("partial");
    expect(post?.resolvedRefs).toEqual([]);
    expect(out.diagnostics.some((d) => d.code === "contracts/openapi-ref-unresolved")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* AsyncAPI keşfi (TŞ §11: topic/payload)                              */
/* ------------------------------------------------------------------ */

const ASYNCAPI_SPEC = [
  "asyncapi: 2.6.0",
  "info:",
  "  title: Orders Events",
  "  version: 1.0.0",
  "channels:",
  "  order-created-v1:",
  "    publish:",
  "      message:",
  "        payload:",
  '          $ref: "#/components/schemas/OrderCreated"',
  "  billing.invoice-created:",
  "    subscribe:",
  "      message:",
  "        payload:",
  '          $ref: "#/components/schemas/InvoiceCreated"',
  "components:",
  "  schemas:",
  "    OrderCreated:",
  "      type: object",
  "      required: [orderId]",
  "      properties:",
  "        orderId:",
  "          type: string",
  "    InvoiceCreated:",
  "      type: object",
  "      properties:",
  "        invoiceId:",
  "          type: string",
].join("\n");

describe("discoverAsyncApiContracts", () => {
  it("pozitif: topic/payload → EventContract adayı; publish/subscribe yönü kanıtlı", () => {
    const out = discoverAsyncApiContracts("ws-1", "events/asyncapi.yaml", ASYNCAPI_SPEC);

    expect(out.contracts).toHaveLength(2);
    const publish = out.contracts.find((c) => c.topic === "order-created-v1");
    expect(publish?.nodeKind).toBe("EventContract");
    expect(publish?.channelDirection).toBe("publish");
    expect(publish?.qualifiedName).toBe("order-created-v1#publish");
    expect(publish?.payloadSchemaId).toBe("OrderCreated");
    expect(publish?.requiredPropertyNames).toEqual(["orderId"]);
    expect(publish?.evidence).toEqual({
      relativePath: "events/asyncapi.yaml",
      startLine: 6,
      endLine: 6,
    });

    const subscribe = out.contracts.find((c) => c.topic === "billing.invoice-created");
    expect(subscribe?.channelDirection).toBe("subscribe");
    expect(subscribe?.payloadSchemaId).toBe("InvoiceCreated");
    expect(subscribe?.certainty).toBe("full");
  });

  it("negatif: desteklenmeyen asyncapi ana sürümü → contracts/unsupported-spec", () => {
    const v4 = ASYNCAPI_SPEC.replace("asyncapi: 2.6.0", "asyncapi: 4.0.0");
    expect(errorCode(() => discoverAsyncApiContracts("ws-1", "asyncapi.yaml", v4))).toBe(
      "contracts/unsupported-spec",
    );
  });

  it("negatif: channels alanı yok → contracts/spec-invalid", () => {
    const noChannels = "asyncapi: 2.6.0\ninfo:\n  title: x\n  version: 1\n";
    expect(errorCode(() => discoverAsyncApiContracts("ws-1", "asyncapi.yaml", noChannels))).toBe(
      "contracts/spec-invalid",
    );
  });

  it("pozitif: payload $ref çözümlenmiş işaretçisi resolvedRefs'te taşınır (json-schema ile tutarlı kanıt)", () => {
    const out = discoverAsyncApiContracts("ws-1", "events/asyncapi.yaml", ASYNCAPI_SPEC);
    const publish = out.contracts.find((c) => c.channelDirection === "publish");
    expect(publish?.resolvedRefs).toEqual(["#/components/schemas/OrderCreated"]);
  });
});

/* ------------------------------------------------------------------ */
/* JSON Schema keşfi (yerel $ref çözümlemesi)                          */
/* ------------------------------------------------------------------ */

const SCHEMA_JSON = JSON.stringify(
  {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://schemas.example.local/order.json",
    title: "Order",
    type: "object",
    required: ["orderId"],
    properties: {
      orderId: { type: "string" },
      address: { $ref: "#/$defs/Address" },
    },
    $defs: {
      Address: {
        type: "object",
        required: ["city"],
        properties: { city: { type: "string" } },
      },
    },
  },
  null,
  2,
);

describe("discoverJsonSchemaContracts", () => {
  it("pozitif: $id'li SchemaContract adayı; iç $ref çözümlenir (yerel dosya içinde)", () => {
    const out = discoverJsonSchemaContracts("ws-1", "schemas/order.json", SCHEMA_JSON);

    expect(out.contracts).toHaveLength(1);
    const contract = out.contracts[0];
    expect(contract?.nodeKind).toBe("SchemaContract");
    expect(contract?.sourceKind).toBe("json-schema");
    expect(contract?.name).toBe("https://schemas.example.local/order.json");
    expect(contract?.requiredPropertyNames).toEqual(["orderId"]);
    expect(contract?.resolvedRefs).toEqual(["#/$defs/Address"]);
    expect(contract?.certainty).toBe("full");
    expect(contract?.diagnostics).toEqual([]);
  });

  it("partial: dış $ref → contracts/json-schema-external-ref diagnostic'ı + certainty partial", () => {
    const withExternal = SCHEMA_JSON.replace(
      '"#/$defs/Address"',
      '"https://other.example.local/x.json"',
    );
    const out = discoverJsonSchemaContracts("ws-1", "schemas/order.json", withExternal);
    expect(out.contracts[0]?.certainty).toBe("partial");
    expect(out.diagnostics.some((d) => d.code === "contracts/json-schema-external-ref")).toBe(true);
  });

  it("partial: çözümlenemeyen iç $ref → contracts/json-schema-ref-unresolved", () => {
    const dangling = SCHEMA_JSON.replace('"#/$defs/Address"', '"#/$defs/Missing"');
    const out = discoverJsonSchemaContracts("ws-1", "schemas/order.json", dangling);
    expect(out.contracts[0]?.certainty).toBe("partial");
    expect(out.diagnostics.some((d) => d.code === "contracts/json-schema-ref-unresolved")).toBe(
      true,
    );
  });

  it("negatif: JSON Schema olmayan kök → sözleşme üretilmez + contracts/json-schema-not-a-schema", () => {
    const notSchema = JSON.stringify({ foo: "bar" });
    const out = discoverJsonSchemaContracts("ws-1", "configs/x.json", notSchema);
    expect(out.contracts).toHaveLength(0);
    expect(out.diagnostics.some((d) => d.code === "contracts/json-schema-not-a-schema")).toBe(true);
  });

  it("negatif: kök skaler → contracts/spec-invalid", () => {
    expect(errorCode(() => discoverJsonSchemaContracts("ws-1", "x.json", "42"))).toBe(
      "contracts/spec-invalid",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Parse güvenliği (kırmızı çizgi 6: boyut kotası, derinlik sınırı)    */
/* ------------------------------------------------------------------ */

describe("parse safety", () => {
  it("negatif: boyut kotası aşımı → contracts/limit-exceeded", () => {
    expect(errorCode(() => assertSpecSize(MAX_SPEC_BYTES + 1))).toBe("contracts/limit-exceeded");
    expect(() => assertSpecSize(MAX_SPEC_BYTES)).not.toThrow();
  });

  it("negatif: aşırı derin iç içe yapı → contracts/depth-exceeded", () => {
    const deep = "[".repeat(200) + "]".repeat(200);
    expect(errorCode(() => parseStructuredSpec("deep.json", deep))).toBe("contracts/depth-exceeded");
  });

  it("negatif: YAML alias bombası → ContractDiscoveryError (kota reddi), çökme değil", () => {
    const bomb = [
      "a: &a ['x','x','x','x','x','x','x','x','x','x']",
      "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]",
      "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]",
      "d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]",
      "e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d,*d]",
      "f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e,*e]",
      "g: &g [*f,*f,*f,*f,*f,*f,*f,*f,*f,*f]",
      "h: [*g,*g,*g,*g,*g,*g,*g,*g,*g,*g]",
    ].join("\n");
    expect(errorCode(() => parseStructuredSpec("bomb.yaml", bomb))).toMatch(
      /^contracts\/(limit-exceeded|depth-exceeded|spec-yaml-invalid)$/,
    );
  });

  it("negatif: orkestrasyon yolu (.yaml) ön katmanları parse'dan ÖNCE uygular — alias bombası → contracts/limit-exceeded", () => {
    const bomb = [
      "a: &a ['x','x','x','x','x','x','x','x','x','x']",
      "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]",
      "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]",
      "d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]",
      "e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d,*d]",
      "f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e,*e]",
      "g: &g [*f,*f,*f,*f,*f,*f,*f,*f,*f,*f]",
      "h: [*g,*g,*g,*g,*g,*g,*g,*g,*g,*g]",
    ].join("\n");
    expect(
      errorCode(() =>
        discoverContractsFromTexts("ws-1", [{ relativePath: "bomb.yaml", text: bomb }]),
      ),
    ).toBe("contracts/limit-exceeded");
  });

  it("negatif: orkestrasyon yolu (.yaml) ham derinlik taramasını parse'dan önce yapar → contracts/depth-exceeded", () => {
    const deep = "[".repeat(200) + "]".repeat(200);
    expect(
      errorCode(() =>
        discoverContractsFromTexts("ws-1", [{ relativePath: "deep.yaml", text: deep }]),
      ),
    ).toBe("contracts/depth-exceeded");
  });
});
