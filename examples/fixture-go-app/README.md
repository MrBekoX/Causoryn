# fixture-go-app

The Go counterpart of the orders evidence chain: **"* /orders" (`http.HandleFunc`) →
ordersHandler → OrdersService.GetOrders → OrdersRepository.FindAll**. An in-memory fixture that
exercises the L1/L2/L3 extraction of the Go sidecar worker (`native/go-worker/`). The worker
receives the sources in the request body and compiles nothing on disk (the analyzed workspace
stays read-only). `go.mod` (module `causoryn.fixture.go-orders`) documents that the fixture is a
real Go module; when the Causoryn indexer analyzes this directory it sends `go.mod` to the worker
for exact import resolution (see below).

## Files

| File | Content |
|---|---|
| `main.go` | `http.HandleFunc` registrations (`/orders`, `/orders/create`, `/health`) + handlers + the `newOrderService` / `writeJSON` helpers |
| `services/orders_service.go` | `OrdersService` (`GetOrders`, `Create`) — struct + constructor |
| `repositories/orders_repository.go` | `Order` + `OrdersRepository` (`FindAll`, `Save`) |

## Expected graph (worker output — [`native/go-worker/PROTOCOL.md`](../../native/go-worker/PROTOCOL.md))

- **CONTAINS** (`verified`, `ast-span`): File → Function/Class; Class → Method (a function with a
  receiver, `func (s *OrdersService) GetOrders`, becomes a Method node).
- **CALLS**:
  - `verified` (bare identifier in the same package, i.e. same directory + same package name):
    `ordersHandler → newOrderService`, `ordersHandler → writeJSON`,
    `createOrderHandler → newOrderService`, `createOrderHandler → writeJSON`,
    `healthHandler → writeJSON`.
  - package-qualified calls to packages of the analysis set:
    `newOrderService → services.NewOrdersService`,
    `newOrderService → repositories.NewOrdersRepository` — `heuristic` with ambiguity when the
    worker gets no `go.mod` (the acceptance test sends only the three `.go` files), and `verified`
    when `go.mod` is sent as `moduleFiles`, because the import paths
    `causoryn.fixture.go-orders/services` and `.../repositories` then map exactly to those
    directories (this is what the Causoryn indexer does).
  - `heuristic` (unique method name): `ordersHandler → services.OrdersService.GetOrders`,
    `createOrderHandler → services.OrdersService.Create`,
    `OrdersService.GetOrders → repositories.OrdersRepository.FindAll`,
    `OrdersService.Create → repositories.OrdersRepository.Save`.
  - `heuristic` (package outside the analysis set, including chained calls):
    `main → UnknownExternal ("log.Fatal")`,
    `writeJSON → UnknownExternal ("json.NewEncoder")`,
    `writeJSON → UnknownExternal ("json.NewEncoder(w).Encode")`.
  - `unresolved`: `writeJSON → UnknownExternal ("w.Header")`,
    `writeJSON → UnknownExternal ("w.Header().Set")`,
    `main → UnknownExternal ("srv.ListenAndServe")` — no invented target (a selector call on a
    value has no type resolution; the `http.Server` literal sets server resource limits).
- **ROUTES_TO** (`verified`, `route-registration`): `"* /orders" → ordersHandler`,
  `"* /orders/create" → createOrderHandler`, `"* /health" → healthHandler`. `http.HandleFunc`
  carries no HTTP verb, so the Endpoint method is `"*"`.
- Builtin calls such as `len` / `append` / `make` produce no CALLS edge.

## Verification

```bash
go build ./...   # in native/go-worker: proves the worker compiles (or /path/to/go build ./...)
npx vitest run adapters/go/test/go-adapter.test.ts   # acceptance tests
```
