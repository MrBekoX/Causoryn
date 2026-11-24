# fixture-rust-app — Rust Evidence Chain Fixture

The Rust counterpart of the `examples/fixture-csharp-orders` fixture of the Roslyn worker: a
route → service → repository chain for the Rust sidecar worker (`native/rust-worker`, see its
[`PROTOCOL.md`](../../native/rust-worker/PROTOCOL.md)).

Three files form a read-only source bag. This is NOT a buildable cargo project: the worker
analyzes the contents sent over stdin and writes nothing to disk.

- `main.rs` — the `#[get("/orders")] list_orders` and `#[post("/orders")] create_order`
  handlers (`ROUTES_TO`, `verified`); a direct call in the same module (`create_audit_entry`,
  `verified`); a qualified path call (`services::OrdersService::new`, `heuristic` with an
  `unverified-module-prefix-suffix-match` ambiguity because only the last two path segments are
  matched); and an unresolvable call (`std::env::var` → `unresolved` + UnknownExternal).
- `services.rs` — `OrdersService` (struct → Class; impl methods → Method); the method calls
  inside `create` / `list` → `heuristic`, and `OrderRepository::new` inside `OrdersService::new`
  → `heuristic` (qualified path).
- `repositories.rs` — `Order` (struct → Class), `OrderStore` (trait → Interface; its method
  declarations are Method nodes), `OrderRepository` (struct → Class; `new` and the
  `impl OrderStore` methods are Method nodes). The trait + impl candidates for `save` /
  `get_all` make those method calls carry an ambiguity.

Acceptance tests: `tests/rust-worker.test.ts` and `adapters/rust/test/rust-adapter.test.ts`
(`npx vitest run tests/rust-worker.test.ts`).
