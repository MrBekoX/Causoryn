# fixture-python-app — Python dil desteği kabul fixture'i (M1-Python).

TŞ v2.1 §7 deseni uyarınca **roslyn-worker + adapters/csharp-roslyn**
kalıbının Python karşılığı: `native/python-worker/worker.py` (saf stdlib
`ast`) + `adapters/python` TS adapter. Route → service → repository zinciri
kanıtlanır (TŞ §8: Endpoint node + ROUTES_TO; CALLS + evidence).

## Dosyalar

| Dosya | İçerik |
|---|---|
| `app.py` | `@app.get("/orders")` + `@app.post("/orders")` FastAPI tarzı handler'lar; `logger.info` çözümsüz çağrı örneği |
| `services/orders_service.py` | `create_order` (aynı modül `_validate_order` → verified; import edilen `save` → heuristic), `list_orders`, `async def audit_order` |
| `repositories/order_repository.py` | `save`/`all_orders` modül fonksiyonları + `OrderRepository` sınıfı (`self._stamp` → verified, `save` → aynı modül fonksiyon → verified) |

## Beklenen zincir

- `GET /orders` → `app.get_orders` → `services.orders_service.list_orders` (heuristic)
  → `repositories.order_repository.all_orders` (heuristic)
- `POST /orders` → `app.add_order` → `services.orders_service.create_order` (heuristic)
  → `repositories.order_repository.save` (heuristic); `create_order →
  _validate_order` (verified)
- `app.get_orders → logger.info` **unresolved** (UnknownExternal `logger.info`;
  uydurma kenar yok)

Fixture kaynak kodu çalıştırılmaz; analiz bellek-içi AST üzerinden yapılır
(`fastapi`/`flask` kurulu olması gerekmez — import'lar yalnızca ad tablosu
içindir). Kabul testleri: `tests/python-worker.test.ts` ve
`adapters/python/test/python-adapter.test.ts` (`npx vitest run <dosya>`).
