# fixture-rust-app — Rust kanıt zinciri fixture'ı (M1-Rust)

> Kanıt: TŞ v2.1 §7 (dil sidecar worker'ları), §8 (graph sözleşmesi).
> Roslyn worker'ın `examples/fixture-csharp-orders` fixture'ının Rust
> karşılığıdır: route → service → repository zinciri.

3 dosya, salt-okunur kaynak çantası (build edilemez cargo projesi DEĞİLDİR
— worker stdin üzerinden içerik analizi yapar, disk yazmaz):

- `main.rs` — `#[get("/orders")] list_orders` ve `#[post("/orders")]
  create_order` handler'ları; aynı modülde doğrudan çağrı
  (`create_audit_entry`) ve nitelikli yol çağrısı
  (`services::OrdersService::new`); çözülemeyen çağrı örneği
  (`std::env::var` → unresolved + UnknownExternal).
- `services.rs` — `OrdersService` (struct → Class; impl metotları →
  Method) `create`/`list` içindeki metot çağrıları → heuristic.
- `repositories.rs` — `Order` (struct → Class), `OrderStore` (trait →
  Interface; metot bildirimleri Method), `OrderRepository` (struct →
  Class; `new` + `impl OrderStore` metotları Method). `save`/`get_all`
  adlarında trait + impl adayı çiftliği → metot çağrısı ambiguity
  taşır.

Kabul testi: `tests/rust-worker.test.ts` ve
`adapters/rust/test/rust-adapter.test.ts`
(`npx vitest run tests/rust-worker.test.ts`).
