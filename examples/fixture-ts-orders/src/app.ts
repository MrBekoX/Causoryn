/**
 * fixture-ts-orders — giriş dosyası (composition root).
 *
 * Route kaydı: `router.post("/orders", ordersRoute)` ifadesi adapter'da
 * Endpoint node'u ("POST /orders") + Endpoint → ordersRoute ROUTES_TO
 * kenarı üretir (TŞ v2.1 §25/4 kanıt zincirinin başlangıcı).
 */

import { Router } from "./http/router.js";
import { OrderRepository } from "./repositories/order-repository.js";
import { createOrdersRoute } from "./routes/orders.js";
import { OrdersService } from "./services/orders-service.js";

const router = new Router();
const ordersService = new OrdersService(new OrderRepository());
const ordersRoute = createOrdersRoute(ordersService);

router.post("/orders", ordersRoute);
