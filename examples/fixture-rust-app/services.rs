//! fixture-rust-app — sipariş servis katmanı.
//!
//! Kanıt zincirinin ortası: OrdersService::create → repository.save CALLS
//! kenarı. Metot çağrıları (`self.repository.save(...)`) alıcı türü
//! çözülemediğinden heuristic işaretlenir — trait dispatch çözümü bu
//! dilimde yoktur (worker: native/rust-worker).

use crate::repositories::{Order, OrderRepository};

/// Sipariş iş kurallarını taşıyan servis (struct → Class node).
pub struct OrdersService {
    repository: OrderRepository,
}

impl OrdersService {
    /// Yapıcı; nitelikli yol çağrısı hedefi (OrdersService::new → verified).
    pub fn new() -> OrdersService {
        OrdersService {
            repository: OrderRepository::new(),
        }
    }

    /// Yeni sipariş oluşturur ve kalıcı hale getirir.
    pub fn create(&mut self, sku: String, quantity: u32) -> Order {
        let order = Order { sku, quantity };
        self.repository.save(order)
    }

    /// Tüm siparişleri listeler.
    pub fn list(&self) -> Vec<Order> {
        self.repository.get_all()
    }
}
