# fixture-ts-nextjs

Sprint-2 B3 (framework linkers) Next.js App Router pozitif fixture'ı.
Framework tespiti import'a değil **dosya kuralına** dayanır (uydurma yok;
App Router'ın resmî konvansiyonu):

- `app/api/users/route.ts` — App Router route handler dosyası: `export async
  function GET(...)` / `export async function POST(...)` fiil exportları.
  Linker bunları `GET /api/users` / `POST /api/users` Endpoint node'larına ve
  Endpoint → handler sembolü ROUTES_TO kenarlarına çevirir.
- `app/users/page.tsx` — App Router sayfa dosyası: `export default function
  UsersPage(...)`. Linker `GET /users` Endpoint'i üretir ve sayfanın default
  export bileşenine ROUTES_TO kenarı bağlar.
- `src/services/users.ts` — route handler'ların çağırdığı servis katmanı
  (CALLS zinciri gerçek projeye benzesin diye).

Yol türetimi: `app` (veya `src/app`) segmentinden sonra gelen segmentler
route yoludur — `app/api/users/route.ts` → `/api/users`,
`app/users/page.tsx` → `/users`, `app/route.ts` → `/`.

Not: fixture'da `next` paketi import edilmez ve JSX kullanılmaz (depo
node_modules'una dokunulmaz; JSX tipleri olmadan sahte tanı üretmemek için).
Tespit yalnızca dosya kuralından yapılır; bu, linker'ın gerçek App Router
projelerinde `next` importu olmasa bile kural dosyalarını tanıdığı anlamına
gelir — bunun dürüst karşılığı detection `basis` alanında dosya kuralının
açıkça yazılmasıdır.
