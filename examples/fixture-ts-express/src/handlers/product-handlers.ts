/**
 * fixture-ts-express — route handler'ları.
 *
 * Handler'lar isimli fonksiyon bildirimleridir; linker, route kaydındaki
 * handler argümanını TypeChecker ile bu sembollere çözümler (registry),
 * böylece ROUTES_TO kenarları verified + route-attribute kanıtlı olur.
 */

export function listProductsHandler(request: unknown, response: unknown): void {
  void request;
  void response;
}

export function createProductHandler(request: unknown, response: unknown): void {
  void request;
  void response;
}

export function getAdminStatsHandler(request: unknown, response: unknown): void {
  void request;
  void response;
}
