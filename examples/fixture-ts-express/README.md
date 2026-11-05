# fixture-ts-express

Sprint-2 B3 (framework linkers) Express pozitif fixture'ı. Faz A'daki
`fixture-ts-orders` framework-bağımsız bir Router taşırken, bu fixture gerçek
Express specifier'ını (`"express"`) import eder:

- `src/app.ts` — composition root: `import express from "express"` +
  `app.get("/products", ...)` / `app.post("/products", ...)` kayıtları.
- `src/routes/admin-routes.ts` — Router eşdeğeri: `import { Router } from "express"`
  + `router.get("/admin/stats", ...)`.
- `src/handlers/product-handlers.ts` — isimli route handler bildirimleri.

`extractFrameworkEdges` kapısı (adapters/typescript, sprint-2 B3) Express'i
import tabanlı algılar; verb+path+handler çağrı kalıplarını
`framework: "express"` öznitelikli Endpoint node'larına ve Endpoint → handler
ROUTES_TO kenarlarına çevirir (kanıt: route-attribute, `src/app.ts:18`,
`src/routes/admin-routes.ts:13`).

Hermetiklik notu: fixture diskte bir express paketi İÇERMEZ. Testler, girdiyi
hermetik kılmak için bellek-içi bir tip shim'i ekler
(`node_modules/express/package.json` + `node_modules/express/index.d.ts`,
yalnızca fixture'ın kullandığı `app.get/post` + `Router` yüzeyi). Bu,
modül çözümlemesini fixture kökünde tutar; host makinedeki node_modules
içeriğinden bağımsız olarak analiz `ready` ve tanısızdır ve çıktı
bit-bit deterministiktir. Bu shim yalnızca test girdisindedir; depoya
`node_modules` dizini yazılmaz.
