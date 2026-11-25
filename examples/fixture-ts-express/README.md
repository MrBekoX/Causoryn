# fixture-ts-express

Positive Express fixture for the TypeScript framework linkers. While `fixture-ts-orders` uses a
framework-independent Router, this fixture imports the real Express specifier (`"express"`):

- `src/app.ts` — composition root: `import express from "express"` + the
  `app.get("/products", ...)` / `app.post("/products", ...)` registrations.
- `src/routes/admin-routes.ts` — Router equivalent: `import { Router } from "express"` +
  `router.get("/admin/stats", ...)`.
- `src/handlers/product-handlers.ts` — named route handler declarations.

The `extractFrameworkEdges` gate (`adapters/typescript/src/analyzer.ts`) detects Express from
its imports and turns the verb + path + handler call patterns into Endpoint nodes with the
attribute `framework: "express"` and Endpoint → handler `ROUTES_TO` edges (evidence:
`route-attribute`, `src/app.ts:18`, `src/routes/admin-routes.ts:13`).

Hermeticity note: the fixture contains NO Express package on disk. To keep the input hermetic,
the tests add an in-memory type shim (`node_modules/express/package.json` +
`node_modules/express/index.d.ts`, covering only the `app.get` / `app.post` + `Router` surface
the fixture uses). This keeps module resolution at the fixture root, so the analysis is `ready`
without diagnostics and byte-for-byte deterministic regardless of what the host machine's
`node_modules` contains. The shim exists only in the test input; no `node_modules` directory is
written to the repository.
