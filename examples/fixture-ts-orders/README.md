# fixture-ts-orders — İlk TypeScript Test Fixture'ı

> Kanıt: TŞ v2.1 §22, §25/4 · wiki/sprint-1.md görev 4

Sprint-1 Faz A diliminin ilk çalışan vertical slice'ı için TypeScript
fixture'ı: küçük ama gerçekçi bir "POST /orders" servisi.

## Kanıt zinciri

```
POST /orders (Endpoint)  →  ordersRoute (Handler)  →  createOrdersRoute()
  →  OrdersService.create()  →  OrderRepository.save()
```

## Dosyalar

| Dosya | İçerik | Adapter çıktısındaki rolü |
|---|---|---|
| `src/app.ts` | entry / composition root: `router.post("/orders", ordersRoute)` | Endpoint node'u (`POST /orders`) + `ROUTES_TO` kenarı |
| `src/http/router.ts` | framework-bağımsız minimal `Router` + `Request`/`Response`/`RouteHandler` tipleri | `Class`/`Interface`/`Method` node'ları; route tespit kalıbının hedefi |
| `src/routes/orders.ts` | `createOrdersRoute(ordersService): RouteHandler` factory'si | `CALLS` kenarı: `createOrdersRoute` → `OrdersService.create`, `Response.json` |
| `src/services/orders-service.ts` | `OrdersService.create` sipariş üretir ve kaydeder | `CALLS` kenarı: `OrdersService.create` → `OrderRepository.save` |
| `src/repositories/order-repository.ts` | `OrderRepository.save` + `Order` tipi | zincirin ucu; `Method` + `Interface` node'ları |

## Adapter sözleşmesi (TŞ §7, §8)

- Her kenar Evidence taşır: `relativePath`, `startLine`/`endLine`,
  `sourceHash = sha256(dosya içeriği)`, `analyzerId = "ts-adapter"`,
  `analyzerVersion`, `rationale`.
- Resolution disiplini: checker ile çözümlenen → `verified`; aday eşleşme
  → `heuristic`; çözülemeyen → `unresolved` ve uydurulmuş kenar YOK
  (dış hedefler açık `UnknownExternal` node'dur — TŞ §8 invariant ii).
- Determinizm: aynı girdi → bit-bit aynı Graph JSON (TŞ §8 invariant vi).
- Tek dosyadaki parse hatası analizi düşürmez; hata `diagnostics` olarak
  toplanır ve `state: "partial"` bildirilir.

## Kullanım

Fixture diskten salt-okunur okunur; testler dosya içeriklerini belleğe
alıp `analyzeTypeScriptProgram`'a verir (`adapters/typescript/test/`).
Depoya test yazımı yapılmaz (ADR-008).

## İlgili sayfalar

- wiki/architecture.md — graph sözleşmesi
- wiki/sprint-1.md — görev 4
