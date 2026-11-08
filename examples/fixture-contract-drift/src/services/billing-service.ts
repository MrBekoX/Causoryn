/**
 * fixture-contract-drift — billing servis kenarı.
 *
 * Sorgudaki büyük harf tablo yazımı bilinçli bir name-similarity
 * ankrajıdır: ham isim ORDERS, sözleşmedeki tablo orders. Normalize
 * (büyük/küçük harf ve ayraç duyarsız) eşitlik heuristic CONSUMES_CONTRACT
 * üretir; verified ASLA üretilmez (TŞ §11: isim benzerliği heuristic kalır).
 */
export class BillingService {
  private readonly db: { run(sql: string, ...params: unknown[]): unknown };

  constructor(db: { run(sql: string, ...params: unknown[]): unknown }) {
    this.db = db;
  }

  totalFor(orderId: string): unknown {
    return this.db.run(
      "SELECT amount FROM ORDERS WHERE id = ?",
      orderId,
    );
  }
}
