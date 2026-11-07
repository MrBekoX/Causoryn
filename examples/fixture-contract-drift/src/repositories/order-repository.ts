/**
 * fixture-contract-drift — sipariş repository'si.
 *
 * Kayıtlı SQL ankrajı, db/001_create_orders.sql içindeki CREATE TABLE
 * orders tanımıyla verified CONSUMES_CONTRACT üretir (basis name-exact;
 * TŞ §11 "net isim" kuralı).
 */
export class OrderRepository {
  private readonly db: { run(sql: string): void };

  constructor(db: { run(sql: string): void }) {
    this.db = db;
  }

  insert(order: { id: string; amountMinor: number; currency: string }): void {
    this.db.run(
      "INSERT INTO orders (id, amount, currency, created_at) VALUES (?, ?, ?, NOW())",
    );
    void order;
  }
}
