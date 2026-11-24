# fixture-ts-orders — TypeScript Orders Service Fixture

A small but realistic `POST /orders` service in TypeScript: the first end-to-end fixture of
Causoryn and the sample project used by the
[5-minute quickstart tutorial](../../docs/en/tutorial-5-minutes.md).

## Evidence chain

```
POST /orders (Endpoint)  →  ordersRoute (Handler)  →  createOrdersRoute()
  →  OrdersService.create()  →  OrderRepository.save()
```

## Files

| File | Content | Role in the adapter output |
|---|---|---|
| `src/app.ts` | entry point / composition root: `router.post("/orders", ordersRoute)` | Endpoint node (`POST /orders`) + `ROUTES_TO` edge |
| `src/http/router.ts` | framework-independent minimal `Router` + `Request` / `Response` / `RouteHandler` types | `Class` / `Interface` / `Method` nodes; the target of the route detection pattern |
| `src/routes/orders.ts` | `createOrdersRoute(ordersService): RouteHandler` factory | `CALLS` edges: `createOrdersRoute` → `OrdersService.create`, `Response.json` |
| `src/services/orders-service.ts` | `OrdersService.create` builds and stores an order (`CreateOrderInput` input type) | `CALLS` edge: `OrdersService.create` → `OrderRepository.save` |
| `src/repositories/order-repository.ts` | `OrderRepository.save` + the `Order` type | end of the chain; `Method` + `Interface` nodes |

## Adapter contract

- Every edge carries evidence: `relativePath`, `startLine` / `endLine`,
  `sourceHash = sha256(file content)`, `analyzerId = "ts-adapter"`, `analyzerVersion` and
  `rationale`.
- Resolution discipline: resolved by the type checker → `verified`; candidate match →
  `heuristic`; not resolvable → `unresolved`, and no edge is invented (external targets are
  explicit `UnknownExternal` nodes).
- Determinism: the same input gives a byte-identical graph JSON.
- A parse error in one file does not stop the analysis; it is collected in `diagnostics` and the
  result is reported as `state: "partial"`.

## Usage

- **With Causoryn:** open this directory in your coding agent host, or start the MCP server
  inside it with `npx causoryn mcp --allow-cwd --auto-data-dir`, then follow the
  [5-minute quickstart tutorial](../../docs/en/tutorial-5-minutes.md) (`causoryn_status`,
  `causoryn_map_system`, `causoryn_preflight_change`, `causoryn_verify_change`).
- **In the test suites:** the fixture is read from disk read-only; the tests load the file
  contents into memory and pass them to `analyzeTypeScriptProgram`
  (`adapters/typescript/test/`). Nothing is written to the repository.

## Related pages

- [Architecture overview](../../docs/en/architecture.md) — graph contract
- [Language analyzers](../../docs/en/language-analyzers.md)
