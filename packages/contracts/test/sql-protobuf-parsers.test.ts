import { describe, expect, it } from "vitest";

import {
  ContractDiscoveryError,
  discoverProtobufContracts,
  discoverSqlContracts,
  MAX_SPEC_BYTES,
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
/* SQL migration keşfi — SADELEŞTİRİLMİŞ satır/statement parser'ı      */
/* (belgeli sınırlı dilim; migration ASLA çalıştırılmaz, TŞ §11)       */
/* ------------------------------------------------------------------ */

const CREATE_SQL = [
  "-- orders v1 sözleşmesi",
  "CREATE TABLE orders (",
  "    id INTEGER NOT NULL,",
  "    amount NUMERIC NOT NULL,",
  "    currency VARCHAR(3),",
  "    created_at TIMESTAMP NOT NULL",
  ");",
].join("\n");

const ALTER_SQL = [
  "-- v2 değişiklikleri",
  "ALTER TABLE orders ADD COLUMN note VARCHAR(256);",
  "ALTER TABLE orders DROP COLUMN currency;",
  "ALTER TABLE orders RENAME COLUMN amount TO amount_minor;",
  "DROP TABLE audit_log;",
].join("\n");

describe("discoverSqlContracts", () => {
  it("pozitif: CREATE TABLE → SchemaContract; kolon tipleri + NOT NULL required kanıtı satırlı", () => {
    const out = discoverSqlContracts("ws-1", "db/001_create_orders.sql", CREATE_SQL);

    expect(out.diagnostics).toEqual([]);
    expect(out.contracts).toHaveLength(1);
    const table = out.contracts[0];
    expect(table?.nodeKind).toBe("SchemaContract");
    expect(table?.sourceKind).toBe("sql");
    expect(table?.name).toBe("orders");
    expect(table?.qualifiedName).toBe("table:orders");
    expect(table?.certainty).toBe("full");
    expect(table?.properties).toEqual([
      { name: "id", type: "INTEGER", required: true },
      { name: "amount", type: "NUMERIC", required: true },
      { name: "currency", type: "VARCHAR(3)", required: false },
      { name: "created_at", type: "TIMESTAMP", required: true },
    ]);
    expect(table?.requiredPropertyNames).toEqual(["id", "amount", "created_at"]);
    // satır kanıtı: CREATE TABLE anahtar satırı (1 tabanlı)
    expect(table?.evidence).toEqual({
      relativePath: "db/001_create_orders.sql",
      startLine: 2,
      endLine: 7,
    });
    expect(table?.contractId).toMatch(/^node:[0-9a-f]{64}$/);
  });

  it("pozitif: DECIMAL(10,2) içindeki virgül kolon bölmesini bozmaz (paren-duyarlı split)", () => {
    const withDecimal = [
      "CREATE TABLE invoices (",
      "    id UUID NOT NULL,",
      "    price DECIMAL(10,2) NOT NULL,",
      "    note TEXT",
      ");",
    ].join("\n");
    const out = discoverSqlContracts("ws-1", "db/003.sql", withDecimal);
    expect(out.contracts[0]?.properties).toEqual([
      { name: "id", type: "UUID", required: true },
      { name: "price", type: "DECIMAL(10,2)", required: true },
      { name: "note", type: "TEXT", required: false },
    ]);
  });

  it("partial: ADD/DROP/RENAME kolonlar diagnostic'lı tanınır; DROP TABLE sözleşme üretmez", () => {
    const out = discoverSqlContracts("ws-1", "db/002_alter_orders.sql", ALTER_SQL);

    expect(out.contracts).toHaveLength(1);
    const table = out.contracts[0];
    expect(table?.name).toBe("orders");
    expect(table?.properties).toEqual([{ name: "note", type: "VARCHAR(256)", required: false }]);
    expect(table?.certainty).toBe("partial");

    const codes = out.diagnostics.map((d) => d.code);
    expect(codes).toContain("contracts/sql-drop-column");
    expect(codes).toContain("contracts/sql-rename-column");
    expect(codes).toContain("contracts/sql-drop-table");
    const drop = out.diagnostics.find((d) => d.code === "contracts/sql-drop-column");
    expect(drop?.line).toBe(3); // DROP COLUMN currency satırı
    expect(drop?.message).toContain("currency");
  });

  it("pozitif: boş dosya → sözleşme ve diagnostic yok, çökme yok", () => {
    const out = discoverSqlContracts("ws-1", "db/empty.sql", "");
    expect(out.contracts).toEqual([]);
    expect(out.diagnostics).toEqual([]);
  });

  it("pozitif: determinizm — aynı girdi bit-bit aynı JSON", () => {
    const a = JSON.stringify(discoverSqlContracts("ws-1", "db/001.sql", CREATE_SQL + "\n" + ALTER_SQL));
    const b = JSON.stringify(discoverSqlContracts("ws-1", "db/001.sql", CREATE_SQL + "\n" + ALTER_SQL));
    expect(a).toBe(b);
  });

  it("negatif: boyut kotası SQL keşfinde de uygulanır (yaml/json yollarıyla simetrik, kırmızı çizgi 6)", () => {
    const huge = "-- " + "x".repeat(MAX_SPEC_BYTES) + "\n";
    expect(errorCode(() => discoverSqlContracts("ws-1", "db/huge.sql", huge))).toBe(
      "contracts/limit-exceeded",
    );
    expect(() => discoverSqlContracts("ws-1", "db/ok.sql", CREATE_SQL)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* protobuf keşfi — sınırlı satır parser'ı (proto3 message/rpc)        */
/* ------------------------------------------------------------------ */

const PROTO_OK = [
  'syntax = "proto3";',
  "",
  "package causoryn.orders;",
  "",
  "message OrderCreatedEvent {",
  "  string order_id = 1;",
  "  int64 amount_minor = 2;",
  "}",
  "",
  "service OrderEvents {",
  "  rpc OrderCreated (OrderCreatedEvent) returns (OrderCreatedAck);",
  "}",
  "",
  "message OrderCreatedAck {",
  "  string event_id = 1;",
  "}",
].join("\n");

describe("discoverProtobufContracts", () => {
  it("pozitif: message → SchemaContract, rpc → ApiContract (request/response şema ID satırlı)", () => {
    const out = discoverProtobufContracts("ws-1", "contracts/orders.proto", PROTO_OK);

    expect(out.diagnostics).toEqual([]);
    expect(out.contracts).toHaveLength(3);

    const event = out.contracts.find((c) => c.name === "causoryn.orders.OrderCreatedEvent");
    expect(event?.nodeKind).toBe("SchemaContract");
    expect(event?.certainty).toBe("full");
    expect(event?.evidence).toEqual({
      relativePath: "contracts/orders.proto",
      startLine: 5,
      endLine: 8,
    });

    const ack = out.contracts.find((c) => c.name === "causoryn.orders.OrderCreatedAck");
    expect(ack?.nodeKind).toBe("SchemaContract");

    const rpc = out.contracts.find((c) => c.name === "OrderEvents.OrderCreated");
    expect(rpc?.nodeKind).toBe("ApiContract");
    expect(rpc?.sourceKind).toBe("protobuf");
    expect(rpc?.qualifiedName).toBe("OrderEvents.OrderCreated");
    expect(rpc?.requestSchemaId).toBe("causoryn.orders.OrderCreatedEvent");
    expect(rpc?.responseSchemaIds).toEqual(["causoryn.orders.OrderCreatedAck"]);
    expect(rpc?.evidence).toEqual({
      relativePath: "contracts/orders.proto",
      startLine: 11,
      endLine: 11,
    });
  });

  it("partial/unknown: map alanı → certainty partial + unknown serializer diagnostic'ı", () => {
    const withMap = [
      'syntax = "proto3";',
      "message OrderCreatedEvent {",
      "  string order_id = 1;",
      "  map<string, string> metadata = 4;",
      "}",
    ].join("\n");
    const out = discoverProtobufContracts("ws-1", "contracts/orders.proto", withMap);

    const event = out.contracts[0];
    expect(event?.certainty).toBe("partial");
    expect(event?.diagnostics.some((d) => /unknown/i.test(d))).toBe(true);
    expect(out.diagnostics.some((d) => d.code === "contracts/protobuf-unknown-field")).toBe(true);
    // kısmen tanınan alan yine de taşınır: string order_id görülür
    expect(event?.properties).toContainEqual({
      name: "order_id",
      type: "string",
      required: false,
    });
  });

  it("partial: syntax satırı yok → contracts/protobuf-no-syntax + tüm adaylar partial", () => {
    const noSyntax = "message Foo {\n  string id = 1;\n}\n";
    const out = discoverProtobufContracts("ws-1", "x.proto", noSyntax);
    expect(out.diagnostics.some((d) => d.code === "contracts/protobuf-no-syntax")).toBe(true);
    expect(out.contracts.every((c) => c.certainty === "partial")).toBe(true);
  });

  it("partial: stream rpc → unknown serializer notu ile işaretlenir", () => {
    const streamRpc = [
      'syntax = "proto3";',
      "service Chat {",
      "  rpc Talk (Msg) returns (stream Msg);",
      "}",
      "message Msg {",
      "  string body = 1;",
      "}",
    ].join("\n");
    const out = discoverProtobufContracts("ws-1", "chat.proto", streamRpc);
    const rpc = out.contracts.find((c) => c.name === "Chat.Talk");
    expect(rpc?.certainty).toBe("partial");
    expect(rpc?.diagnostics.some((d) => /unknown/i.test(d))).toBe(true);
    expect(rpc?.requestSchemaId).toBe("Msg");
    expect(rpc?.responseSchemaIds).toEqual(["Msg"]);
  });

  it("partial: dengesiz süslü parantez → çökme yok, contracts/protobuf-unbalanced-block", () => {
    const unbalanced = 'syntax = "proto3";\nmessage Broken {\n  string id = 1;\n';
    const out = discoverProtobufContracts("ws-1", "broken.proto", unbalanced);
    expect(out.diagnostics.some((d) => d.code === "contracts/protobuf-unbalanced-block")).toBe(
      true,
    );
    expect(out.contracts.every((c) => c.certainty === "partial")).toBe(true);
  });

  it("negatif: boyut kotası protobuf keşfinde de uygulanır (yaml/json yollarıyla simetrik, kırmızı çizgi 6)", () => {
    const huge = "// " + "x".repeat(MAX_SPEC_BYTES) + "\n";
    expect(errorCode(() => discoverProtobufContracts("ws-1", "huge.proto", huge))).toBe(
      "contracts/limit-exceeded",
    );
    expect(() => discoverProtobufContracts("ws-1", "ok.proto", PROTO_OK)).not.toThrow();
  });
});
