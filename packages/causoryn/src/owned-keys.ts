/**
 * Placement of the keys `causoryn setup` owns inside an existing server entry
 * (JSON object entries and the Codex `[mcp_servers.causoryn]` table).
 */

function lastIndexWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i] as T)) return i;
  }
  return -1;
}

/**
 * Returns `items` with every owned key of `canonicalOwnedKeys` that is missing
 * inserted where a freshly generated entry would have it: right before the
 * next owned key (in canonical order) that is present, otherwise right after
 * the previous one, otherwise at the start. Existing items keep their order,
 * so an entry that already has every owned key is returned unchanged.
 */
export function insertMissingOwnedKeys<T>(
  items: readonly T[],
  ownedKeyOf: (item: T) => string | null,
  canonicalOwnedKeys: readonly string[],
  createItem: (key: string) => T,
): T[] {
  const out = [...items];
  for (let k = 0; k < canonicalOwnedKeys.length; k += 1) {
    const key = canonicalOwnedKeys[k] as string;
    if (out.some((item) => ownedKeyOf(item) === key)) continue;
    let index = -1;
    for (const later of canonicalOwnedKeys.slice(k + 1)) {
      index = out.findIndex((item) => ownedKeyOf(item) === later);
      if (index >= 0) break;
    }
    if (index < 0) {
      for (const earlier of canonicalOwnedKeys.slice(0, k).reverse()) {
        const at = lastIndexWhere(out, (item) => ownedKeyOf(item) === earlier);
        if (at >= 0) {
          index = at + 1;
          break;
        }
      }
    }
    out.splice(index < 0 ? 0 : index, 0, createItem(key));
  }
  return out;
}
