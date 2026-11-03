import { Buffer } from "node:buffer";

/**
 * Opak, deterministik cursor codec'i (TŞ §8 invariant iv: "sıralama/cursor
 * deterministik"; §10.1: uzun sonuçlar cursor ile bölünür).
 *
 * Cursor içeriği sürümlü bir offset kaydıdır ({v:1,o:<int>}); base64url
 * ile kodlanır. Format sürümü yükselirse eski cursor'lar reddedilir —
 * istemcinin sayfalamayı baştan yürütmesi beklenir. Geçersiz cursor
 * INVALID_ARGUMENT'a eşlenir (services katmanı).
 */

const CURSOR_VERSION = 1;

export function encodeCursor(offset: number): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, o: offset }),
    "utf8",
  ).toString("base64url");
}

/** Geçerli cursor → offset; geçersiz/bozuk cursor → null. */
export function decodeCursor(cursor: string): number | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as { v?: unknown; o?: unknown };
    if (record.v !== CURSOR_VERSION) return null;
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
