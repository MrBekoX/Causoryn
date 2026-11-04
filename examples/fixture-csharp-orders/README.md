# fixture-csharp-orders

TŞ v2.1 §25/4 kanıt zincirinin C# karşılığı: **POST /orders (controller) →
OrdersService.Create → OrderRepository.Save**. Roslyn sidecar worker'ın
(`native/roslyn-worker/`, sprint-2 B1) L2/L3 çıkarımını kanıtlayan 4 dosyalık
bellek-içi fixture'dır — csproj/SLN içermez; worker kaynakları istek gövdesinde
alır ve diskte hiçbir şey derlemez (ADR-008 salt-okunur workspace).

## Dosyalar

| Dosya | İçerik |
|---|---|
| `Program.cs` | Top-level host kurulumu + minimal API `GET /health` (adlandırılmış yerel fonksiyon handler) |
| `Controllers/OrdersController.cs` | `[ApiController]` `[Route("api/[controller]")]` + `[HttpGet("{id}")]`/`[HttpPost]` action'ları |
| `Services/OrdersService.cs` | `OrdersService` + `CreateOrderInput` record |
| `Repositories/OrderRepository.cs` | `OrderRepository` + `Order` record |

## Beklenen graph (worker çıktısı)

- **CONTAINS** (verified, ast-span): File → Class/Function, Class → Method
  (property bildirimleri erişimci-metot yaklaşımıyla Method düğümü olur).
- **CALLS** (verified, semantic-symbol):
  `OrdersController.GetById → OrdersService.GetById → OrderRepository.GetAll`,
  `OrdersController.Create → OrdersService.Create → OrderRepository.Save`
  ve `new Order` için `OrdersService.Create → Class Order`.
  `List<T>.Add/ToArray` gibi analiz seti dışı çağrılar açık
  `UnknownExternal` node + verified kenar olarak temsil edilir.
- **ROUTES_TO** (verified, route-attribute):
  `GET /api/Orders/{id} → OrdersController.GetById`,
  `POST /api/Orders → OrdersController.Create`,
  `GET /health → Program.Health` (minimal API). `[controller]` token'ı
  ASP.NET kuralıyla sınıf adının "Controller" ekinden arınmış hâliyle
  (büyük/küçük harf korunarak: `Orders`) yazılır.
- DI kayıt çağrıları (`AddScoped`, `AddControllers`, `MapControllers`) çağıran
  bağlamı top-level statement olduğu için CALLS üretmez — uydurma kenar yok.

## Doğrulama

```bash
dotnet build native/roslyn-worker
npx vitest run tests/roslyn-worker.test.ts   # kabul testleri (B1)
```
