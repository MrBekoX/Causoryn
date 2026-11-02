/**
 * fixture-ts-orders — sipariş kalıcılığı (sahte repository).
 *
 * Kanıt zincirinin ucu: `OrderRepository.save` (TŞ v2.1 §25/4:
 * "POST /orders → OrdersService → repository" zincirindeki son halka).
 */

/** Sipariş kaydının alan sözleşmesi. */
export interface Order {
  id: string;
  sku: string;
  quantity: number;
}

/** Siparişi kaydeden sahte (in-memory) repository. */
export class OrderRepository {
  save(order: Order): Order {
    return order;
  }
}
