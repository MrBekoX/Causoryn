import { isScalar, type Pair, type YAMLMap } from "yaml";

/**
 * Per-document lookup indexes for ParsedSpec.lineOf (CAU-04, CWE-407).
 *
 * Line evidence used to be found by scanning: a linear `items.find` over the
 * map for every key-path segment, and a character scan from offset 0 to turn
 * the key's offset into a line. With one lookup per OpenAPI route or AsyncAPI
 * channel that is quadratic in the document. Both are now indexed once per
 * document and reused, with the same results as the scans they replace.
 */

/**
 * Offset → 1-based line. The newline offsets are collected in one pass; each
 * lookup is a binary search. The result is 1 + the number of "\n" characters
 * before `offset`, the same as the character scan it replaces, including for
 * offsets outside the text (negative, past the end, NaN).
 */
export function createLineLocator(text: string): (offset: number) => number {
  const newlines: number[] = [];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    newlines.push(index);
  }
  return (offset: number): number => {
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const newline = newlines[middle];
      if (newline !== undefined && newline < offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low + 1;
  };
}

/**
 * Key → entry index of YAML maps, built on a map's first lookup (one pass over
 * its entries) and reused afterwards. Matching mirrors the scan it replaces:
 * only scalar keys, strict equality on the key's value (a numeric key 200 is
 * not the string "200"; NaN never matches), first entry wins.
 */
export class YamlKeyIndex {
  readonly #maps = new WeakMap<YAMLMap<unknown, unknown>, Map<unknown, Pair<unknown, unknown>>>();
  readonly #onIndexBuilt: ((entries: number) => void) | undefined;

  /** `onIndexBuilt` is told the entry count of every map indexed (work metering). */
  constructor(onIndexBuilt?: (entries: number) => void) {
    this.#onIndexBuilt = onIndexBuilt;
  }

  find(map: YAMLMap<unknown, unknown>, key: unknown): Pair<unknown, unknown> | undefined {
    let index = this.#maps.get(map);
    if (index === undefined) {
      this.#onIndexBuilt?.(map.items.length);
      index = new Map();
      for (const entry of map.items) {
        if (!isScalar(entry.key)) continue;
        const value = entry.key.value;
        if (typeof value === "number" && Number.isNaN(value)) continue;
        if (!index.has(value)) index.set(value, entry);
      }
      this.#maps.set(map, index);
    }
    return index.get(key);
  }
}
