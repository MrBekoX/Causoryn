/**
 * fixture-ts-nextjs — App Router route handler dosyası.
 *
 * Kural: `app/<segmentler>/route.ts` dosyasındaki HTTP fiil adlı exportlar
 * o yola bağlı endpoint'lerdir. Linker (sprint-2 B3) bu exportları
 * `GET /api/users` / `POST /api/users` Endpoint node'larına ve Endpoint →
 * handler sembolü ROUTES_TO kenarlarına çevirir (kanıt: route-attribute).
 */

import { createUser, listUsers } from "../../../src/services/users.js";

export async function GET(): Promise<Response> {
  const users = listUsers();
  return new Response(JSON.stringify(users));
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { name: string };
  const user = createUser(body.name);
  return new Response(JSON.stringify(user));
}
