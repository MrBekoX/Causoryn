/**
 * fixture-contract-drift — orders servisi (D1 keşif ankrajları).
 *
 * Bu dosya bilinçli olarak sözleşme keşfinin servis tarafı ankrajlarını
 * taşır (satır-bazlı basitleştirilmiş tarayıcı `scanServiceAnchors` ile
 * okunur; gerçek endpoint/publish çözümlemesi adapter'ların işidir):
 * - `router.post` + `router.get` kayıtları → openapi.yaml path'leriyle
 *   verified route eşleşmesi (":orderId" param segmenti şablon-eşdeğerdir).
 * - `bus.publish` → asyncapi publish kanalıyla verified PRODUCES_CONTRACT.
 * - `bus.subscribe` → asyncapi subscribe kanalıyla verified CONSUMES_CONTRACT.
 */
export interface Router {
  post(route: string, handler: () => void): void;
  get(route: string, handler: () => void): void;
}

export interface EventBus {
  publish(topic: string, payload: unknown): void;
  subscribe(topic: string, handler: (payload: unknown) => void): void;
}

export function registerOrdersApi(router: Router, bus: EventBus): void {
  router.post("/orders", createOrderHandler);
  router.get("/orders/:orderId", getOrderHandler);
  bus.publish("order-created-v1", { orderId: "o-1", amountMinor: 1000 });
  bus.subscribe("billing.invoice-created", onInvoiceCreated);
}

function createOrderHandler(): void {
  // handler gövdesi fixture için boş bırakıldı (keşif ankrajı yeterli)
}

function getOrderHandler(): void {
  // handler gövdesi fixture için boş bırakıldı
}

function onInvoiceCreated(payload: unknown): void {
  void payload;
}
