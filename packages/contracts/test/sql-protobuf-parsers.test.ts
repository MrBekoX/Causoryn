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

  it("güvenlik (#11/#14/#15): ReDoS karşıtı doğrusal süre ve kenar SQL ALTER/CREATE biçimleri", () => {
    const payloads = [
      "ALTER TABLE users " + " ".repeat(30_000) + "\n",
      "ALTER TABLE users ADD " + " ".repeat(30_000) + "\n",
      "ALTER TABLE users ADD COLUMN " + " ".repeat(30_000) + "\n",
      "CREATE TABLE evil (\n  col" + " ".repeat(30_000) + "\n);",
      "ALTER TABLE " + "1 ".repeat(15_000) + ";",
    ];

    for (const sql of payloads) {
      const start = performance.now();
      const out = discoverSqlContracts("ws-1", "db/redos.sql", sql);
      const elapsedMs = performance.now() - start;
      expect(elapsedMs).toBeLessThan(200);
      expect(Array.isArray(out.contracts)).toBe(true);
    }

    // ALTER TABLE ONLY + tırnaklı kolon + kısaltılmış ADD (COLUMN olmadan) + boşluklu geçersiz kolon
    const edgeSql = [
      'CREATE TABLE "accounts" (',
      '  "id" UUID NOT NULL,',
      "  empty_col   ",
      ");",
      'ALTER TABLE ONLY "accounts" ADD COLUMN "email" VARCHAR(120) NOT NULL;',
      "ALTER TABLE accounts ADD label TEXT;",
    ].join("\n");
    const edgeOut = discoverSqlContracts("ws-1", "db/edge.sql", edgeSql);
    expect(edgeOut.contracts).toHaveLength(1);
    expect(edgeOut.contracts[0]?.name).toBe("accounts");
    expect(edgeOut.contracts[0]?.properties).toEqual([
      { name: "id", type: "UUID", required: true },
      { name: "email", type: "VARCHAR(120)", required: true },
      { name: "label", type: "TEXT", required: false },
    ]);
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

  it("güvenlik (#12/#13): map ve alan kalıpları ReDoS girdilerinde < 200ms tamamlanır; iç içe bloklar korunur", () => {
    const adversarialMap =
      'syntax = "proto3";\nmessage EvilMap {\n  map<A,A> A=0' + "0".repeat(30_000) + "!\n}\n";
    const startMap = performance.now();
    const mapOut = discoverProtobufContracts("ws-1", "evil-map.proto", adversarialMap);
    expect(performance.now() - startMap).toBeLessThan(200);
    expect(mapOut.contracts[0]?.properties).toEqual([]);

    const adversarialField =
      'syntax = "proto3";\nmessage EvilField {\n  A A=0' + "0".repeat(30_000) + "!\n}\n";
    const startField = performance.now();
    const fieldOut = discoverProtobufContracts("ws-1", "evil-field.proto", adversarialField);
    expect(performance.now() - startField).toBeLessThan(200);
    expect(fieldOut.contracts[0]?.properties).toEqual([]);

    // İç içe message/enum/oneof, reserved/option/yorumlar, field options ve U+2028 reddi
    const nestedProto = [
      'syntax = "proto3";',
      "package acme.v1;",
      "message Outer {",
      "  // yorum satırı",
      "  option deprecated = false;",
      "  reserved 99;",
      "  enum Status {",
      "    STATUS_UNSPECIFIED = 0;",
      "  }",
      "  message Inner {",
      "    repeated string tags = 1 [deprecated = true];",
      "    map<string, int32> counts = 2 [deprecated = true];",
      "  }",
      "  oneof choice {",
      "    string a = 3;",
      "  }",
      "  string id = 1;",
      "  string spoof = 2\u2028;",
      "}",
    ].join("\n");
    const nestedOut = discoverProtobufContracts("ws-1", "nested.proto", nestedProto);
    const outer = nestedOut.contracts.find((c) => c.name === "acme.v1.Outer");
    const inner = nestedOut.contracts.find((c) => c.name === "acme.v1.Inner");
    expect(outer?.properties).toEqual([{ name: "id", type: "string", required: false }]);
    expect(inner?.properties).toEqual([
      { name: "tags", type: "repeated string", required: false },
      { name: "counts", type: "map<string,int32>", required: false },
    ]);
    expect(nestedOut.diagnostics.some((d) => d.code === "contracts/protobuf-unbalanced-block")).toBe(
      false,
    );
  });
});
