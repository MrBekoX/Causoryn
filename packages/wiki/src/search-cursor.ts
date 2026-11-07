import { Buffer } from "node:buffer";

/**
 * Opak, deterministik wiki arama cursor codec'i — sprint-4 W4, K-013 #5.
 *
 * packages/mcp-server/src/cursor.ts mekanizmasının packages/wiki saf
 * kopyasıdır: MCP türü import etmez ve mcp-server'a bağımlı değildir
 * (bağımlılık sınırı: packages/wiki yalnızca @causoryn/domain'e bağlıdır).
 *
 * Cursor içeriği sürümlü bir offset kaydıdır ({v:1,o:<int>}); base64url
 * ile kodlanır. Format sürümü yükselirse eski cursor'lar reddedilir —
 * istemcinin sayfalamayı baştan yürütmesi beklenir. Geçersiz cursor
 * services katmanında wiki/invalid-cursor'a eşlenir (search-store.ts).
 */

const WIKI_SEARCH_CURSOR_VERSION = 1;

export function encodeWikiSearchCursor(offset: number): string {
  return Buffer.from(
    JSON.stringify({ v: WIKI_SEARCH_CURSOR_VERSION, o: offset }),
    "utf8",
  ).toString("base64url");
}

/** Geçerli cursor → offset; geçersiz/bozuk cursor → null. */
export function decodeWikiSearchCursor(cursor: string): number | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as { v?: unknown; o?: unknown };
    if (record.v !== WIKI_SEARCH_CURSOR_VERSION) return null;
    if (
      typeof record.o !== "number" ||
      !Number.isInteger(record.o) ||
      record.o < 0
    ) {
      return null;
    }
    return record.o;
  } catch {
    return null;
  }
}
