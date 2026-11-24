# fixture-ts-nextjs

Positive Next.js App Router fixture for the TypeScript framework linkers. Framework detection
relies on the **file convention**, not on an import (nothing is invented; this is the official
App Router convention):

- `app/api/users/route.ts` — App Router route handler file: `export async function GET(...)` /
  `export async function POST(...)` verb exports. The linker turns them into `GET /api/users` /
  `POST /api/users` Endpoint nodes and Endpoint → handler symbol `ROUTES_TO` edges.
- `app/users/page.tsx` — App Router page file: `export default function UsersPage(...)`. The
  linker produces a `GET /users` Endpoint and a `ROUTES_TO` edge to the page's default-export
  component.
- `src/services/users.ts` — the service layer called by the route handlers (so the CALLS chain
  resembles a real project).

Path derivation: the segments after the `app` (or `src/app`) segment form the route path —
`app/api/users/route.ts` → `/api/users`, `app/users/page.tsx` → `/users`, `app/route.ts` → `/`.

Note: the fixture does not import the `next` package and uses no JSX (the repository's
`node_modules` is not touched, and without JSX types no spurious diagnostics are produced).
Detection relies only on the file convention, which means the linker also recognizes convention
files in real App Router projects that do not import `next`; the honest counterpart of this is
that the detection `basis` field states the file convention explicitly.
