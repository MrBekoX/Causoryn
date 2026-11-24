# fixture-contract-drift — Contract Discovery and Drift Fixture

Fixture for contract discovery (`@causoryn/contracts`) and contract drift tests. It deliberately
contains read-only discovery sources together with **backward-safe and breaking-candidate**
material. The `db/` migrations are never executed; they are only read statically (Causoryn does
not run migrations, because that would change the user's workspace).

## Files

| File | Content | Discovery role |
|---|---|---|
| `openapi.yaml` | Orders Public API v1 (OpenAPI 3.1.0) | `POST /orders` + `GET /orders/{orderId}`; `CreateOrderInput` required `[amount, currency]`; `Order` required `[id, amount, currency]` |
| `openapi-v2.yaml` | v2 target version | **breaking_candidate material (removal of a required property):** the required `currency` property is removed entirely from the `Order` response schema; **backward-safe material:** in the request schema `currency` changes from required to optional (required→optional; the property stays), plus an optional `note` field and a new `GET /orders` route |
| `asyncapi.yaml` | Orders Events (AsyncAPI 2.6.0) | `order-created-v1` (publish) and `billing.invoice-created` (subscribe) topics with payload schemas |
| `db/001_create_orders.sql` | `CREATE TABLE orders` (4 columns) | SQL contract; the repository anchor `INSERT INTO orders` matches it as `verified` |
| `db/002_alter_orders.sql` | ADD / DROP / RENAME COLUMN | **breaking_candidate:** `DROP COLUMN currency` (removing a DB column affects consumers); the RENAME statement exercises rename recognition |
| `contracts/order-created.proto` | proto3 `OrderCreatedEvent` + `OrderCreatedAck` + `OrderEvents` rpc | **unknown serializer note:** the `map<string, string>` field is beyond the bounded parser, so it is only partially recognized |
| `schemas/order-created.schema.json` | JSON Schema 2020-12, `$defs/Money` + an internal `$ref` | local `$ref` resolution; required `[orderId, amountMinor]` |
| `src/services/orders-service.ts` | route registrations + publish/subscribe anchors | service side of the `verified` route and topic matches |
| `src/repositories/order-repository.ts` | `INSERT INTO orders` | `verified` `CONSUMES_CONTRACT` with the SQL contract (exact name) |
| `src/services/billing-service.ts` | `SELECT amount FROM ORDERS` | **name-similarity anchor:** the upper-case spelling gives a `heuristic` match (NEVER `verified`) |

## Discovery discipline

- A produces/consumes edge is `verified` **only** for an exact name, route or schema identity
  match; name similarity (case- or separator-normalized equality) stays `heuristic`; weaker
  matches produce no edge.
- Every candidate carries evidence (file + line range); a `verified` edge is never published
  without evidence.
- Discovery is read-only: no file outside the workspace access policy is read, migrations are
  never run, and spec parsing is bounded by size and depth quotas.

## Usage

The fixture is read from disk read-only by `packages/contracts/test/`. The drift comparison
material (OpenAPI v1 ↔ v2, SQL 001 ↔ 002) is kept together on purpose for
`causoryn_contracts` (`action: "check"` for compatibility, `action: "drift"` for drift impact).
Nothing is written to the repository.

## Related pages

- [MCP tool contracts](../../docs/en/tool-contracts.md) — `causoryn_contracts`
- [Architecture overview](../../docs/en/architecture.md) — graph contract
