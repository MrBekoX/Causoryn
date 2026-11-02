# fixture-ts-orders — İlk TypeScript Test Fixture'ı (iskelet)

> Kanıt: TŞ v2.1 §22, §25/4 · wiki/sprint-1.md görev 4

Sprint-1 Faz A diliminin ilk çalışan vertical slice'ı için kullanılacak
TypeScript fixture'ının yer tutucusudur.

## Planlanan içerik (Sprint-1 görev 4 — henüz YOK, ADR-010: Done yazılmaz)

TŞ §25/4'ün istediği kanıt zinciri:

```
POST /orders  →  OrdersService.createOrder()  →  OrderRepository.save()
```

- Minimal bir Express-benzeri router (endpoint → handler edge'i, ROUTES_TO)
- `OrdersService` sınıfı (CALLS edge'i, constructor injection ile INJECTS)
- `OrderRepository` arayüzü + sahte implementasyon (IMPLEMENTS edge'i)
- Her edge için dosya/satır kanıtı üretilebilir gerçek kaynak yapı

Fixture, adapter testlerinde deterministic graph çıktısı doğrulamak için
kullanılır: aynı giriş → aynı Graph JSON (TŞ §8 invariant vi).

## İlgili sayfalar

- wiki/architecture.md — graph sözleşmesi
- wiki/sprint-1.md — görev 4
