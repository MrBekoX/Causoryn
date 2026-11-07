# fixture-contract-drift — Sözleşme Keşfi ve Drift Fixture'ı

> Kanıt: TŞ v2.1 §11 (Architecture Contracts ve Contract Drift, s.11–12), §23 Faz D · wiki/sprint-5.md D1

Sprint-5 Faz D diliminin sözleşme keşfi (`@causoryn/contracts`) ve drift
testleri için fixture. TŞ §11'deki read-only keşif kaynaklarını bilinçli
olarak **backward-safe ve breaking aday** malzemeleriyle birlikte taşır;
`db/` migration'ları asla çalıştırılmaz, yalnızca statik okunur (TŞ §11:
"Kullanıcının workspace'ini değiştirmek için migration çalıştırılmaz").

## Dosyalar

| Dosya | İçerik | Keşif rolü |
|---|---|---|
| `openapi.yaml` | Orders Public API v1 (OpenAPI 3.1.0) | `POST /orders` + `GET /orders/{orderId}`; `CreateOrderInput` required `[amount, currency]`; `Order` required `[id, amount, currency]` |
| `openapi-v2.yaml` | v2 hedef sürüm | **breaking_candidate malzemesi (TŞ §11: zorunlu property silinmesi):** yanıt şeması `Order`'dan zorunlu `currency` property'si tamamen silindi; **backward-safe malzemeleri:** istek şemasında `currency` zorunluluktan isteğe indirildi (required→optional; property korunur), optional `note` alanı + yeni `GET /orders` rotası |
| `asyncapi.yaml` | Orders Events (AsyncAPI 2.6.0) | `order-created-v1` (publish) + `billing.invoice-created` (subscribe) topic'leri, payload şemaları |
| `db/001_create_orders.sql` | `CREATE TABLE orders` (4 kolon) | SQL sözleşmesi; `INSERT INTO orders` repo ankrajıyla verified eşleşir |
| `db/002_alter_orders.sql` | ADD/DROP/RENAME COLUMN | **breaking_candidate adayı:** `DROP COLUMN currency` (TŞ §11: DB kolon kaldırma → tüketici etkisi); RENAME tanıma dilimi |
| `contracts/order-created.proto` | proto3 `OrderCreatedEvent` + `OrderCreatedAck` + `OrderEvents` rpc | **unknown serializer notu:** `map<string, string>` alanı sınırlı parser diliminin ötesinde → kısmen tanıma |
| `schemas/order-created.schema.json` | JSON Schema 2020-12, `$defs/Money` + iç `$ref` | `$ref` yerel çözümleme; required `[orderId, amountMinor]` |
| `src/services/orders-service.ts` | rota kayıtları + publish/subscribe ankrajları | verified route/topic eşleşmelerinin servis tarafı |
| `src/repositories/order-repository.ts` | `INSERT INTO orders` | SQL sözleşmesiyle verified CONSUMES_CONTRACT (name-exact) |
| `src/services/billing-service.ts` | `SELECT amount FROM ORDERS` | **name-similarity ankrajı:** büyük harf yazım → heuristic eşleşme (verified ASLA değil) |

## Keşif disiplini (TŞ §11)

- produces/consumes edge'i **yalnızca** net isim, route veya schema kimliği
  eşleşmesinde `verified`; isim benzerliği (case/separator normalize eşitlik)
  `heuristic` kalır; daha zayıf eşleşme kenar üretmez.
- Her aday kanıt taşır (dosya + satır aralığı); `verified` kenar kanıtsız
  yayımlanmaz (ADR-004 Evidence First).
- Keşif salt-okunurdur: WorkspaceAccessPolicy dışındaki dosya okunmaz;
  migration çalıştırılmaz; spec parse'ı boyut/derinlik kotalarıyla sınırlıdır.

## Kullanım

Fixture diskten salt-okunur okunur (`packages/contracts/test/`); drift
karşılaştırma malzemesi (v1 ↔ v2 openapi, 001 ↔ 002 SQL) D2/D3 araçları
için bilinçli olarak birlikte saklanır. Depoya test yazımı yapılmaz
(ADR-008).

## İlgili sayfalar

- wiki/architecture.md — graph sözleşmesi
- wiki/sprint-5.md — Faz D görevleri
