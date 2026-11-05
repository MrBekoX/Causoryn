/**
 * fixture-ts-nextjs — App Router sayfa bileşeni.
 *
 * Kural: `app/<segmentler>/page.tsx` dosyasının default exportu o yolun
 * sayfa bileşenidir. Linker `GET /users` Endpoint node'u üretir ve
 * default export sembolüne ROUTES_TO kenarı bağlar.
 */

export default function UsersPage(): string {
  return "users-page";
}
