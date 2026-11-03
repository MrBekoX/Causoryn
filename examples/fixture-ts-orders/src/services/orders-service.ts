/**
 * fixture-ts-orders — sipariş servis katmanı.
 *
 * Kanıt zincirinin ortası: `OrdersService.create` → `OrderRepository.save`
 * CALLS kenarı adapter testlerinde kanıtlanır (TŞ v2.1 §25/4).
 */

import { type Order, OrderRepository } from "../repositories/order-repository.js";

/** Yeni sipariş oluşturma girdisi. */
export interface CreateOrderInput {
  sku: string;
  quantity: number;
}

/** Sipariş iş kurallarını taşıyan servis. */
export class OrdersService {
  private readonly repository: OrderRepository;

  constructor(repository: OrderRepository) {
    this.repository = repository;
  }

  create(input: CreateOrderInput): Order {
    const order: Order = {
      id: `order-${input.sku}-${String(input.quantity)}`,
      sku: input.sku,
      quantity: input.quantity,
    };
    this.repository.save(order);
    return order;
  }
}
