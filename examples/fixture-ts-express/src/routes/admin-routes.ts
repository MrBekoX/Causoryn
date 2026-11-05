/**
 * fixture-ts-express — Express Router eşdeğeri kayıtlar.
 *
 * `Router` da `express` specifier'ından gelir; `router.<verb>` kayıtları
 * aynı linker geçişinde Endpoint + ROUTES_TO olarak eşlenir.
 */

import { Router } from "express";
import { getAdminStatsHandler } from "../handlers/product-handlers.js";

const router = Router();

router.get("/admin/stats", getAdminStatsHandler);

export default router;
