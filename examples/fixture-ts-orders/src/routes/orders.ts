/**
 * fixture-ts-orders — POST /orders route katmanı.
 *
 * Factory deseni: `createOrdersRoute` bir `RouteHandler` üretir; handler
 * gövdesindeki `ordersService.create(...)` çağrısı TypeChecker ile
 * `OrdersService.create` sembolüne çözümlenir (TŞ v2.1 §25/4 zinciri).
 */

import { type Request, type Response, type RouteHandler } from "../http/router.js";
import { type CreateOrderInput, OrdersService } from "../services/orders-service.js";

/**
 * Verilen servis için route handler üretir. Dönen arrow function'ın
 * çağrıları en yakın isimli enclosing declaration'a (bu fonksiyona)
 * atanır.
 */
export function createOrdersRoute(
  ordersService: OrdersService,
): RouteHandler<CreateOrderInput> {
  return (request: Request<CreateOrderInput>, response: Response): void => {
    const order = ordersService.create(request.body);
    response.json({ id: order.id });
  };
}
