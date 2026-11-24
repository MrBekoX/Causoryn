# fixture-csharp-orders

The C# counterpart of the orders evidence chain: **POST /orders (controller) →
OrdersService.Create → OrderRepository.Save**. A 4-file in-memory fixture that exercises the L2/L3
extraction of the Roslyn sidecar worker (`native/roslyn-worker/`). It contains no csproj or SLN:
the worker receives the sources in the request body and compiles nothing on disk (the analyzed
workspace stays read-only).

## Files

| File | Content |
|---|---|
| `Program.cs` | Top-level host setup + minimal API `GET /health` (named local function handler) |
| `Controllers/OrdersController.cs` | `[ApiController]` `[Route("api/[controller]")]` controller deriving from `ControllerBase`, with `[HttpGet("{id}")]` / `[HttpPost]` actions |
| `Services/OrdersService.cs` | `OrdersService` + the `CreateOrderInput` record |
| `Repositories/OrderRepository.cs` | the `Order` record, the `IOrderRepository` interface and `OrderRepository : IOrderRepository` |

## Expected graph (worker output)

- **CONTAINS** (`verified`, `ast-span`): File → Class/Interface/Function, Class → Method (property
  declarations become Method nodes through the accessor-method approach).
- **CALLS** (`verified`, `semantic-symbol`):
  `OrdersController.GetById → OrdersService.GetById → OrderRepository.GetAll`,
  `OrdersController.Create → OrdersService.Create → OrderRepository.Save`,
  and `OrdersService.Create → Class Order` for `new Order`.
  Calls outside the analysis set, such as `List<T>.Add` / `ToArray`, are represented as explicit
  `UnknownExternal` nodes with `verified` edges.
- **ROUTES_TO** (`verified`, `route-attribute`):
  `GET /api/Orders/{id} → OrdersController.GetById`,
  `POST /api/Orders → OrdersController.Create`,
  `GET /health → Program.Health` (minimal API). The `[controller]` token is written, following
  the ASP.NET convention, as the class name without its "Controller" suffix, keeping its casing
  (`Orders`).
- **IMPLEMENTS** (`verified`, `semantic-symbol`): `OrderRepository → IOrderRepository`.
- **INHERITS**: `OrdersController → ControllerBase` points at an `UnknownExternal` node — `verified`
  when the ASP.NET Core reference assemblies can be resolved, otherwise `unresolved` with a
  warning (no invented target).
- DI registration calls (`AddScoped`, `AddControllers`, `MapControllers`) produce no CALLS edge,
  because their calling context is a top-level statement — no invented edges.

## Verification

```bash
dotnet build native/roslyn-worker
npx vitest run tests/roslyn-worker.test.ts   # acceptance tests
```
