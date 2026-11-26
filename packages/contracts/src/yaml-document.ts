import {
  isScalar,
  LineCounter,
  parseDocument,
  Schema,
  type CollectionTag,
  type Document,
  type Tags,
} from "yaml";

/**
 * `parseDocument(text)` with a linear duplicate-key check (CAU-04, CWE-407).
 *
 * With its default `uniqueKeys: true`, the `yaml` library (2.9.1,
 * compose/util-map-includes.js) checks every new map key against EVERY earlier
 * key of that map (`items.some(...)`), which is O(k²) per map: about 37 s for a
 * 250 KB spec whose `paths` map has 20,000 keys, long before the 1 MiB size
 * limit. This function returns the same document — same tree, and the same
 * errors and warnings (code, offsets, line/column, order) — while comparing
 * each key once:
 *
 * - `uniqueKeys` is given as a comparator. The library calls it for each key
 *   after a map's first key, starting with the first entry, and stops at the
 *   first `true`. The comparator always returns `true` (so the scan stops
 *   after one call) and records, in O(1) with a per-map set of earlier key
 *   values, whether the key is REALLY a duplicate under the library's own rule
 *   (scalar keys with strictly equal values; NaN never equals NaN; non-scalar
 *   keys are never equal).
 * - Each call is followed, synchronously and in the same order, by exactly one
 *   DUPLICATE_KEY error. Afterwards the DUPLICATE_KEY errors are matched with
 *   the recorded answers in order, and only the real duplicates are kept, so
 *   every remaining error sits exactly where the default check put it.
 * - Error positions get `linePos` from the same LineCounter computation the
 *   library's prettifier uses. Messages are NOT prettified (no source excerpt;
 *   callers report code and position only — see describeSpecSyntaxError).
 *
 * - `!!omap` (ordered map) sequences are resolved by a Set-based copy of the
 *   library's own tag instead of its O(k²) `includes` scan (see
 *   linearOrderedMapTag); duplicates, messages and order are unchanged.
 *
 * Stack capture is switched off while parsing: the library builds an Error
 * object for each recorded key, and capturing a stack for each was most of the
 * cost. The previous limit is restored before returning, also when the parser
 * throws. The returned document's options are reset to the default-parse
 * values, which also releases the comparator's per-map key sets.
 */
export function parseYamlDocument(text: string): Document.Parsed {
  const earlierKeys = new WeakMap<object, Set<unknown>>();
  const realDuplicate: boolean[] = [];

  const uniqueKeys = (firstKey: unknown, key: unknown): boolean => {
    if (typeof firstKey === "object" && firstKey !== null) {
      // The map is identified by its first key node: the library always
      // compares a new key with the map's first entry first.
      let seen = earlierKeys.get(firstKey);
      if (seen === undefined) {
        seen = new Set();
        rememberKey(seen, firstKey);
        earlierKeys.set(firstKey, seen);
      }
      realDuplicate.push(rememberKey(seen, key));
    } else {
      realDuplicate.push(false);
    }
    return true;
  };

  const lineCounter = new LineCounter();
  const savedStackTraceLimit = Error.stackTraceLimit;
  let document: Document.Parsed;
  try {
    setStackTraceLimit(0);
    document = parseDocument(text, {
      uniqueKeys,
      prettyErrors: false,
      lineCounter,
      customTags: withLinearOrderedMap,
    });
  } finally {
    setStackTraceLimit(savedStackTraceLimit);
  }

  let answer = 0;
  document.errors = document.errors.filter((error) => {
    if (error.code !== "DUPLICATE_KEY") return true;
    const real = realDuplicate[answer];
    answer += 1;
    // No recorded answer cannot happen; keeping the error then fails closed.
    return real ?? true;
  });
  for (const issue of [...document.errors, ...document.warnings]) {
    // Same as the library's prettifier, which skips positionless (-1) issues.
    if (issue.pos[0] === -1) continue;
    issue.linePos = [lineCounter.linePos(issue.pos[0]), lineCounter.linePos(issue.pos[1])];
  }

  // Leave the document's options as a default parse leaves them; this also
  // drops the comparator and its per-map key sets with the parse.
  const options = document.options as Record<string, unknown>;
  options["uniqueKeys"] = true;
  options["prettyErrors"] = true;
  Reflect.deleteProperty(options, "lineCounter");
  Reflect.deleteProperty(options, "customTags");
  return document;
}

/** Best effort: where Error.stackTraceLimit is not writable, stacks are just captured (slower, same result). */
function setStackTraceLimit(limit: number): void {
  try {
    Error.stackTraceLimit = limit;
  } catch {
    // Frozen intrinsics: keep the current limit.
  }
}

const ORDERED_MAP_TAG = "tag:yaml.org,2002:omap";
const PAIRS_TAG = "tag:yaml.org,2002:pairs";

let linearOrderedMap: CollectionTag | null | undefined;

/**
 * The library's `!!omap` resolver checks each entry against every earlier key
 * (`seenKeys.includes`, yaml 2.9.1 schema/yaml-1.1/omap.js): O(k²) for k
 * entries, in YAML 1.1 documents and through the known-tags fallback in YAML
 * 1.2. This copy of the library's own tag does the same work with a Set
 * (same SameValueZero matching as `includes`), so it reports the same
 * duplicates, with the same message, in the same order. `null`: the library
 * tags were not found as expected, so the library's tag is kept.
 */
function linearOrderedMapTag(): CollectionTag | null {
  if (linearOrderedMap !== undefined) return linearOrderedMap;
  const libraryTags = new Schema({ schema: "yaml-1.1" }).tags;
  const findSeqTag = (name: string): CollectionTag | undefined =>
    libraryTags.find(
      (tag): tag is CollectionTag => tag.tag === name && "collection" in tag && tag.collection === "seq",
    );
  const omap = findSeqTag(ORDERED_MAP_TAG);
  const resolvePairs = findSeqTag(PAIRS_TAG)?.resolve;
  const OrderedMap = omap?.nodeClass;
  if (omap === undefined || resolvePairs === undefined || OrderedMap === undefined) {
    linearOrderedMap = null;
    return null;
  }
  linearOrderedMap = {
    ...omap,
    resolve(seq, onError, options) {
      const pairs = resolvePairs(seq, onError, options) as { readonly items: ReadonlyArray<{ readonly key?: unknown }> };
      const seenKeys = new Set<unknown>();
      for (const { key } of pairs.items) {
        if (isScalar(key)) {
          if (seenKeys.has(key.value)) {
            onError(`Ordered maps must not include duplicate keys: ${String(key.value)}`);
          } else {
            seenKeys.add(key.value);
          }
        }
      }
      return Object.assign(new OrderedMap(), pairs);
    },
  };
  return linearOrderedMap;
}

/**
 * customTags: put the linear `!!omap` in the schema's tag list — in place of
 * the library's (YAML 1.1) or appended (YAML 1.2, where the library would
 * otherwise resolve `!!omap` through its known tags with the same definition).
 */
function withLinearOrderedMap(tags: Tags): Tags {
  const linear = linearOrderedMapTag();
  if (linear === null) return tags;
  let replaced = false;
  const result = tags.map((tag) => {
    if (typeof tag === "object" && tag.tag === ORDERED_MAP_TAG && "collection" in tag && tag.collection === "seq") {
      replaced = true;
      return linear;
    }
    return tag;
  });
  if (!replaced) result.push(linear);
  return result;
}

/**
 * Adds `key`'s comparable value to `seen`; returns whether it was already
 * there. Only scalar keys compare, by strict equality of their values (a Set
 * matches like ===, except that it treats NaN as equal, so NaN is skipped).
 */
function rememberKey(seen: Set<unknown>, key: unknown): boolean {
  if (!isScalar(key)) return false;
  const value = key.value;
  if (typeof value === "number" && Number.isNaN(value)) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  return false;
}
