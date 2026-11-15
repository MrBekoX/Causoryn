//! fixture-rust-app — sipariş kalıcılığı (bellek-içi repository).
//!
//! Kanıt zincirinin ucu: OrderRepository (OrderStore gerçeklemesi).
//! trait → Interface node; trait metot bildirimleri Interface altında,
//! impl metot tanımları Class altında Method node olur — `save` adında
//! iki aday olduğu için metot çağrısı heuristic + ambiguity taşır
//! (worker: native/rust-worker).

/// Sipariş kaydının alan sözleşmesi (struct → Class node).
pub struct Order {
    pub sku: String,
    pub quantity: u32,
}

/// Kalıcılık sözleşmesi (trait → Interface node).
pub trait OrderStore {
    fn save(&mut self, order: Order) -> Order;
    fn get_all(&self) -> Vec<Order>;
}

/// Siparişleri bellek-içi tutan repository (struct → Class node).
pub struct OrderRepository {
    orders: Vec<Order>,
}

impl OrderRepository {
    /// Yapıcı.
    pub fn new() -> OrderRepository {
        OrderRepository {
            orders: Vec::new(),
        }
    }
}

impl OrderStore for OrderRepository {
    fn save(&mut self, order: Order) -> Order {
        self.orders.push(order);
        order
    }

    fn get_all(&self) -> Vec<Order> {
        self.orders.clone()
    }
}
