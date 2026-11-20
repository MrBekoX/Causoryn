# fixture-go-app

TŞ v2.1 §25/4 kanıt zincirinin Go karşılığı: **"* /orders" (http.HandleFunc) →
ordersHandler → OrdersService.GetOrders → OrdersRepository.FindAll**. Go
sidecar worker'ın (`native/go-worker/`, M1 dilimi) L1/L2/L3 çıkarımını
kanıtlayan bellek-içi fixture'dır — worker kaynakları istek gövdesinde alır,
diskte hiçbir şey derlemez (salt-okunur workspace kırmızı çizgisi). `go.mod`
yalnızca fixture'ın gerçek bir Go modülü olduğunu belgelemek içindir; worker
için gerekli değildir.

## Dosyalar

| Dosya | İçerik |
|---|---|
| `main.go` | `http.HandleFunc` kayıtları (`/orders`, `/orders/create`, `/health`) + handler'lar + `newOrderService`/`writeJSON` yardımcıları |
| `services/orders_service.go` | `OrdersService` (`GetOrders`, `Create`) — struct + constructor |
| `repositories/orders_repository.go` | `Order` + `OrdersRepository` (`FindAll`, `Save`) |

## Beklenen graph (worker çıktısı — native/go-worker/PROTOCOL.md)

- **CONTAINS** (verified, ast-span): File → Function/Class; Class → Method
  (alıcılı `func (s *OrdersService) GetOrders` → Method node).
- **CALLS**:
  - verified (aynı package, bare ident): `ordersHandler → newOrderService`,
    `ordersHandler → writeJSON`, `createOrderHandler → newOrderService`,
    `createOrderHandler → writeJSON`, `healthHandler → writeJSON`.
  - heuristic (package-qualified, analiz setindeki package):
    `newOrderService → services.NewOrdersService`,
    `newOrderService → repositories.NewOrdersRepository`.
  - heuristic (benzersiz metot adı): `ordersHandler →
    services.OrdersService.GetOrders`, `createOrderHandler →
    services.OrdersService.Create`, `OrdersService.GetOrders →
    repositories.OrdersRepository.FindAll`, `OrdersService.Create →
    repositories.OrdersRepository.Save`.
  - heuristic (analiz seti dışı package; zincirli akış dahil):
    `main → UnknownExternal ("log.Fatal")`,
    `writeJSON → UnknownExternal ("json.NewEncoder")`,
    `writeJSON → UnknownExternal ("json.NewEncoder(w).Encode")`.
  - unresolved: `writeJSON → UnknownExternal ("w.Header")`,
    `writeJSON → UnknownExternal ("w.Header().Set")`,
    `main → UnknownExternal ("srv.ListenAndServe")` — uydurma hedef yok
    (sunucu kaynak sınırları için `http.Server` literal'i güvenlik denetimi
    bulgusu sonucu eklendi; selector çağrı tip çözümsüzdür).
- **ROUTES_TO** (verified, route-registration): `"* /orders" → ordersHandler`,
  `"* /orders/create" → createOrderHandler`, `"* /health" → healthHandler`.
  `http.HandleFunc` HTTP fiili taşımadığından Endpoint metodu `"*"`'dir.
- `len`/`append`/`make` builtin çağrıları CALLS üretmez.

## Doğrulama

```bash
go build ./...   # native/go-worker derleme kanıtı (veya /path/to/go build ./...)
npx vitest run adapters/go/test/go-adapter.test.ts   # kabul testleri (M1)
```
