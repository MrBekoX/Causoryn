//! fixture-rust-app — HTTP handler katmanı (attribute route örüntüsü).
//!
//! Kanıt zinciri (TŞ v2.1 §7 analog): GET /orders → list_orders →
//! OrdersService → OrderRepository/OrderStore. Worker: native/rust-worker
//! (syn 2; PROTOCOL.md v1). Route kanıtı: #[get]/#[post] öznitelikleri
//! Endpoint node + ROUTES_TO kenarı üretir (L3).

mod repositories;
mod services;

/// GET /orders — sipariş listeleme; kanıt zincirinin başlangıcı.
#[get("/orders")]
fn list_orders() -> Vec<repositories::Order> {
    create_audit_entry("list_orders");
    let mut service = services::OrdersService::new();
    service.list()
}

/// POST /orders — sipariş oluşturma.
#[post("/orders")]
fn create_order(sku: String, quantity: u32) -> repositories::Order {
    let mut service = services::OrdersService::new();
    service.create(sku, quantity)
}

/// Basit denetim kaydı; aynı modülde doğrudan çağrı hedefi (verified).
/// `std::env::var` çağrısı ise çözülemeyen hedef örneğidir (unresolved +
/// UnknownExternal — uydurma hedef yok).
fn create_audit_entry(action: &str) {
    let _ = std::env::var("CAUSORYN_FIXTURE_AUDIT");
    println!("audit: {action}");
}

fn main() {
    list_orders();
}
