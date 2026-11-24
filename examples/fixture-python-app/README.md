# fixture-python-app — Python Language Support Acceptance Fixture

The Python counterpart of the `native/roslyn-worker` + `adapters/csharp-roslyn` pattern:
`native/python-worker/worker.py` (pure standard-library `ast`) + the `adapters/python` TypeScript
adapter. The fixture proves the route → service → repository chain (Endpoint node + `ROUTES_TO`;
`CALLS` + evidence).

## Files

| File | Content |
|---|---|
| `app.py` | FastAPI-style `@app.get("/orders")` + `@app.post("/orders")` handlers; `logger.info` as an example of an unresolved call |
| `services/orders_service.py` | `create_order` (same-module `_validate_order` → `verified`; imported `save` → `heuristic`), `list_orders`, `async def audit_order` |
| `repositories/order_repository.py` | the module functions `save` / `all_orders` + the `OrderRepository` class (`self._stamp` → `verified`; `save` → same-module function → `verified`) |

## Expected chain

- `GET /orders` → `app.get_orders` → `services.orders_service.list_orders` (`heuristic`)
  → `repositories.order_repository.all_orders` (`heuristic`)
- `POST /orders` → `app.add_order` → `services.orders_service.create_order` (`heuristic`)
  → `repositories.order_repository.save` (`heuristic`); `create_order →
  _validate_order` (`verified`)
- `app.get_orders → logger.info` is **unresolved** (UnknownExternal `logger.info`; no invented
  edge)

The fixture source is never executed; the analysis runs on the in-memory AST (`fastapi` / `flask`
do not have to be installed — the imports are used only as a name table). Acceptance tests:
`tests/python-worker.test.ts` and `adapters/python/test/python-adapter.test.ts`
(`npx vitest run <file>`).
