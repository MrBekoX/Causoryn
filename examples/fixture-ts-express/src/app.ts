/**
 * fixture-ts-express — Express route kayıtları (composition root).
 *
 * Framework linker (sprint-2 B3) Express'i import tabanlı algılar
 * (`import express from "express"`) ve `app.<verb>("/path", handler)`
 * kayıtlarını `framework: "express"` öznitelikli Endpoint node'larına +
 * Endpoint → handler ROUTES_TO kenarlarına çevirir.
 */

import express from "express";
import {
  createProductHandler,
  listProductsHandler,
} from "./handlers/product-handlers.js";

const app = express();

app.get("/products", listProductsHandler);
app.post("/products", createProductHandler);
