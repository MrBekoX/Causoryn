import { Buffer } from "node:buffer";

import {
  isAlias,
  isCollection,
  isMap,
  isNode,
  isPair,
  isSeq,
  Scalar,
  type Document,
  type Pair,
  type YAMLSeq,
} from "yaml";

import { ContractDiscoveryError } from "./errors.js";
import type { ProjectionOptions } from "./projection-budget.js";
import { createLineLocator, YamlKeyIndex } from "./spec-index.js";
import { parseYamlDocument } from "./yaml-document.js";

/**
 * Syntax error of a spec text as its error code and position only. The yaml
 * library's own message quotes the offending source lines, and that text would
 * reach the agent (CONTRACT_PARSE_FAILED) and the server log; config files such
 * as appsettings.json can hold credentials on exactly those lines.
 */
export function describeSpecSyntaxError(error: unknown): string {
  const record = (error ?? {}) as { code?: unknown; linePos?: ReadonlyArray<{ line?: unknown; col?: unknown }> };
  const code = typeof record.code === "string" && /^[A-Z_]{1,64}$/.test(record.code) ? record.code : "SYNTAX_ERROR";
  const position = record.linePos?.[0];
  const where =
    position !== undefined && Number.isSafeInteger(position.line) && Number.isSafeInteger(position.col)
      ? ` at line ${String(position.line)}, column ${String(position.col)}`
      : "";
  return `${code}${where}`;
}

/**
 * Failure of the parser itself (not a reported syntax error). Its message is
 * not carried over: it may embed parser internals or input text.
 */
export function describeSpecParserFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("alias")
    ? "alias use exceeds the limit (aliases are expanded with a bound)"
    : "the parser failed on this input";
}

/**
 * Spec parse güvenliği — sprint kırmızı çizgi 6: "Spec dosyası parse
 * güvenliği: sınırsız derinlik/boyut sınırı (yaml safe-load, boyut kotası),
 * ReDoS sınırlı desenler" ve TŞ §19 (kaynak tüketimi).
 *
 * Savunma katmanları (sırayla uygulanır; hepsi deterministic reddi içerir):
 *  1. boyut kotası (UTF-8 bayt)
 *  2. ham metin süslü/köşeli parantez derinlik taraması (parser'a girmeden)
 *  3. YAML alias ref sayım kotası (billion-laughs genişlemesi parser'a
 *     girmeden kesilir)
 *  4. `yaml` paketi parseDocument (kütüphanenin kendi alias/limit
 *     korumalarıyla; hatalar toplanır → spec-yaml/spec-json-invalid),
 *     linear duplicate-key check via parseYamlDocument (CAU-04)
 *  4b. toJS() work bound before conversion (F24,
 *     assertSpecConversionWithinBudget → contracts/limit-exceeded)
 *  5. çözümlenmiş yapı üzerinde iterative (stack tabanlı) derinlik + node
 *     kotası turu — recursion yok, stack overflow ile çökme yüzeyi yok
 *
 * Bu modül fs/thread/saat okumaz; dosya okuma `discover.ts`'in işidir.
 */

/** Tek spec dosyası için UTF-8 bayt üst sınırı (TŞ §20 maxFileBytes ile aynı kibarlıkta). */
export const MAX_SPEC_BYTES = 1_048_576; // 1 MiB

/** Çözümlenmiş JS yapısının izin verilen en fazla iç içe derinliği. */
export const MAX_SPEC_DEPTH = 64;

/** Çözümlenmiş yapıdaki toplam node kotası (alias bombası savunma derinliği). */
export const MAX_SPEC_NODES = 250_000;

/** Ham metin taramasında izin verilen en fazla parantez derinliği (parser önü). */
export const MAX_TEXT_NESTING = 100;

/** Ham metinde izin verilen en fazla YAML alias referansı (parser önü). */
const MAX_ALIAS_REFS = 5_000;

export function assertSpecSize(byteLength: number): void {
  if (!Number.isFinite(byteLength) || byteLength < 0) {
    throw new ContractDiscoveryError(
      "contracts/invalid-input",
      "byteLength must be a finite, non-negative number",
    );
  }
  if (byteLength > MAX_SPEC_BYTES) {
    throw new ContractDiscoveryError(
      "contracts/limit-exceeded",
      `Spec size quota exceeded: ${String(byteLength)} > ${String(MAX_SPEC_BYTES)} bytes`,
    );
  }
}

/**
 * Ham metin ön katmanları (parser'a girmeden): boyut kotası + parantez
 * derinlik taraması + alias sayımı. parseStructuredSpec VE orkestrasyon
 * yolundaki kök-kokusu (discover.ts sniffYamlRoot) BU fonksiyonu kullanmak
 * ZORUNDADIR — belgelenmiş katman sırasının (1→3) her parse yolunda
 * uygulanması için (takım denetimi bulgusu 2: sniff ön katmanları
 * atlamamalı).
 */
export function assertSpecTextPrechecks(text: string): void {
  assertSpecSize(Buffer.byteLength(text, "utf8"));
  if (maxTextNesting(text) > MAX_TEXT_NESTING) {
    throw new ContractDiscoveryError(
      "contracts/depth-exceeded",
      `Raw text bracket nesting limit exceeded (> ${String(MAX_TEXT_NESTING)})`,
    );
  }
  if (countAliasRefs(text) > MAX_ALIAS_REFS) {
    throw new ContractDiscoveryError(
      "contracts/limit-exceeded",
      `YAML alias reference quota exceeded (> ${String(MAX_ALIAS_REFS)}) — possible alias bomb`,
    );
  }
}

/**
 * Ham metinde string literalleri atlayarak en fazla {/[ derinliğini sayar.
 * Kaçış dizisi (+ string içi parantez) nadir durumlarda yanlış sayım
 * üretebilir; tek amacı HOSTİL girdiyi parser'a Sokmamaktır — kesin sayım
 * 5. katmandaki iterative turda yapılır (yanlışlıkla fazla saymak
 * fail-closed'dur, az saymak katman 5'te yakalanır).
 */
function maxTextNesting(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break; // noUncheckedIndexedAccess güvencesi
    if (inString) {
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      if (depth > max) max = depth;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth < 0) depth = 0;
    }
  }
  return max;
}

/** Ham metindeki YAML alias referanslarını (`*ad`) sayar. */
function countAliasRefs(text: string): number {
  const matches = text.match(/\*[^\s#, [\]{}]+/g);
  return matches === null ? 0 : matches.length;
}

/* ------------------------------------------------------------------ */
/* F24 (CWE-407): bounded yaml toJS() work                             */
/* ------------------------------------------------------------------ */

/**
 * Upper bound of the work the `yaml` library's `Document.toJS()` may do on one
 * spec, in the units below. Calibrated with yaml 2.9.1 on Node 24 (Windows
 * laptop): one unit took 25–55 ns, so the bound is about 1–1.5 s. The text
 * prechecks bound the input (size, bracket nesting, alias tokens) but not
 * this work: measured before this bound, a 1.2 KB spec took 2.3 s and a
 * 300 KB spec 16 s.
 */
export const MAX_SPEC_CONVERSION_WORK = 30_000_000;

/** Converting one node or pair. */
const WORK_CONVERT = 2;
/** One step of the library's getAliasCount() over an anchored subtree. */
const WORK_COUNT_STEP = 1;
/** One entry of a full-document visit() (each Alias.resolve without a context); measured ~220 ns. */
const WORK_VISIT = 5;
/** One entry of the alias/anchor list that Alias.resolve scans. */
const WORK_SCAN = 1;
/** One anchor name copied for a key that converts to an object. */
const WORK_KEY_ANCHOR = 3;
/** One key node stringified for a key that converts to an object. */
const WORK_KEY_STRINGIFY = 4;

const MERGE_TAG = "tag:yaml.org,2002:merge";

/** Pairs and nodes of the document tree (what the library's visit() walks). */
function isTreeItem(item: unknown): item is object {
  return isNode(item) || isPair(item);
}

/**
 * A scalar node: the node kinds are alias, scalar, map and sequence. (The
 * walk does not call `isScalar`, which the CAU-04 tests count as key
 * inspections made by lookups.)
 */
function isScalarNode(item: unknown): item is Scalar {
  return isNode(item) && !isAlias(item) && !isCollection(item);
}

function childrenOf(item: unknown): readonly unknown[] {
  if (isPair(item)) return [item.key, item.value];
  if (isCollection(item)) return item.items;
  return [];
}

/** The anchor of a scalar or collection (the library's `hasAnchor`), if any. */
function anchorOf(item: unknown): string | undefined {
  if (!isScalarNode(item) && !isCollection(item)) return undefined;
  const anchor = item.anchor;
  return typeof anchor === "string" && anchor.length > 0 ? anchor : undefined;
}

/**
 * A pair the library handles as a merge (`<<`): a key node carrying its own
 * merge handler (YAML 1.1 schema, or an explicit `!!merge` tag), or a plain
 * `<<` scalar when the schema enables merge keys (addPairToJSMap, isMergeKey).
 */
function isMergePair(pair: Pair<unknown, unknown>, mergeByDefault: boolean): boolean {
  const key = pair.key;
  if (isNode(key) && typeof (key as { addToJSMap?: unknown }).addToJSMap === "function") return true;
  if (!mergeByDefault || !isScalarNode(key)) return false;
  if (key.type !== undefined && key.type !== Scalar.PLAIN) return false;
  const value = key.value;
  return value === "<<" || (typeof value === "symbol" && value.description === "<<");
}

/** A key whose converted value may be an object, so the library stringifies it (stringifyKey). */
function mayConvertToObjectKey(key: unknown): boolean {
  if (!isScalarNode(key)) return isTreeItem(key);
  return typeof key.value === "object" && key.value !== null;
}

interface AnchorInfo {
  /** getAliasCount() steps over the subtree (aliases are not followed). */
  readonly size: number;
  /** Aliases inside the subtree: each makes getAliasCount() walk the whole document. */
  readonly aliasesIn: number;
  /** getAliasCount() is at least 1, so the library computes it once per registration. */
  readonly hasOne: boolean;
}

interface DocumentIndex {
  /** Entries a full-document visit() touches. */
  readonly visitEntries: number;
  /** Length of the alias/anchor list Alias.resolve scans. */
  readonly listLength: number;
  readonly anchors: number;
  readonly aliases: number;
  readonly objectKeys: number;
  readonly hasMerge: boolean;
  /** Position of each alias and anchored node in that list (document pre-order). */
  readonly order: ReadonlyMap<object, number>;
  /** The anchored node each alias resolves to: the last one with its name before it. */
  readonly target: ReadonlyMap<object, object | undefined>;
}

/** Pre-order walk in the library's visit() order. */
function indexDocument(root: unknown, mergeByDefault: boolean): DocumentIndex {
  const order = new Map<object, number>();
  const target = new Map<object, object | undefined>();
  const lastAnchor = new Map<string, object>();
  let visitEntries = 1; // the document itself
  let listLength = 0;
  let anchors = 0;
  let aliases = 0;
  let objectKeys = 0;
  let hasMerge = false;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const item = stack.pop();
    visitEntries += 1;
    if (!isTreeItem(item)) continue;
    if (isAlias(item)) {
      order.set(item, listLength);
      listLength += 1;
      aliases += 1;
      target.set(item, lastAnchor.get(item.source));
      continue;
    }
    const anchor = anchorOf(item);
    if (anchor !== undefined) {
      order.set(item, listLength);
      listLength += 1;
      anchors += 1;
      lastAnchor.set(anchor, item);
    }
    if (isPair(item)) {
      if (isMergePair(item, mergeByDefault)) hasMerge = true;
      else if (mayConvertToObjectKey(item.key)) objectKeys += 1;
    }
    const children = childrenOf(item);
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return { visitEntries, listLength, anchors, aliases, objectKeys, hasMerge, order, target };
}

interface PostOrderFrame {
  readonly item: object;
  readonly children: readonly unknown[];
  next: number;
  size: number;
  aliasesIn: number;
  hasOne: boolean;
  fresh: number;
  /** Pairs only: the key's subtree size and the value's fresh conversion work. */
  keySize: number;
  valueFresh: number;
}

/**
 * Left-to-right post-order walk. `finish` sees each tree item after all of
 * its children, and every item before it in pre-order that is not one of its
 * ancestors has finished already.
 */
function walkPostOrder(
  root: unknown,
  leafFresh: number,
  finish: (frame: PostOrderFrame) => void,
): void {
  const stack: PostOrderFrame[] = [];
  const open = (item: object): void => {
    stack.push({
      item,
      children: childrenOf(item),
      next: 0,
      size: 1,
      aliasesIn: isAlias(item) ? 1 : 0,
      hasOne: isScalarNode(item),
      fresh: 0,
      keySize: 0,
      valueFresh: 0,
    });
  };
  if (!isTreeItem(root)) return;
  open(root);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as PostOrderFrame;
    if (frame.next < frame.children.length) {
      const index = frame.next;
      frame.next += 1;
      const child = frame.children[index];
      if (isTreeItem(child)) {
        open(child);
      } else {
        // A missing key/value or a plain value: getAliasCount() returns 1, toJS() returns it.
        frame.size += 1;
        frame.hasOne = true;
        frame.fresh += leafFresh;
        if (index === 0) frame.keySize = 1;
        else frame.valueFresh = leafFresh;
      }
      continue;
    }
    stack.pop();
    finish(frame);
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      const index = parent.next - 1;
      parent.size += frame.size;
      parent.aliasesIn += frame.aliasesIn;
      parent.hasOne ||= frame.hasOne;
      parent.fresh += frame.fresh;
      if (isPair(parent.item)) {
        if (index === 0) parent.keySize = frame.size;
        else parent.valueFresh = frame.fresh;
      }
    }
  }
}

function limitExceeded(work: number): ContractDiscoveryError {
  return new ContractDiscoveryError(
    "contracts/limit-exceeded",
    `Spec conversion work quota exceeded (> ${String(MAX_SPEC_CONVERSION_WORK)}${Number.isFinite(work) ? "" : ", cyclic merge"}) — possible alias or anchor amplification`,
  );
}

/**
 * Throws `contracts/limit-exceeded` unless the `yaml` library's toJS() on
 * `document` stays within {@link MAX_SPEC_CONVERSION_WORK}. The estimate
 * follows the library's own control flow (yaml 2.9.1 Document.toJS with its
 * default alias limit) and only ever over-counts:
 * - every node and pair is converted once (aliases share the anchor's value);
 * - each alias resolution scans the alias/anchor list up to the alias, and
 *   the first one walks the whole document to build that list;
 * - the alias-count check (getAliasCount) walks the anchored subtree, plus the
 *   whole document once per alias inside it; it runs on the first use of an
 *   anchor, and on every use while the count is 0 (an anchored subtree with
 *   no scalar, such as `&e []`);
 * - a key that converts to an object copies every anchor name and is
 *   stringified;
 * - a merge (`<<`) converts its source maps again (aliases inside charged in
 *   full) and copies their entries; after one, every anchor is treated as
 *   unchecked again, and the first alias to an anchored inline merge source
 *   converts that source once more.
 * Documents within the bound convert exactly as before: the conversion itself
 * is still the library's toJS().
 */
export function assertSpecConversionWithinBudget(document: Document.Parsed): void {
  const root = document.contents;
  const mergeByDefault = document.schema.tags.some((tag) => tag.tag === MERGE_TAG && Boolean(tag.default));
  const index = indexDocument(root, mergeByDefault);
  const n = index.visitEntries;

  if (index.aliases === 0 && !index.hasMerge) {
    const work =
      WORK_CONVERT * n + WORK_KEY_STRINGIFY * n + index.objectKeys * WORK_KEY_ANCHOR * index.anchors;
    if (work > MAX_SPEC_CONVERSION_WORK) throw limitExceeded(work);
    return;
  }

  // Alias-count cost of each anchored subtree (pure subtree data).
  const anchorInfo = new Map<object, AnchorInfo>();
  walkPostOrder(root, WORK_CONVERT, (frame) => {
    if (anchorOf(frame.item) !== undefined) {
      anchorInfo.set(frame.item, { size: frame.size, aliasesIn: frame.aliasesIn, hasOne: frame.hasOne });
    }
  });
  const perNestedAlias = WORK_VISIT * n + WORK_SCAN * index.listLength;
  const aliasCountWork = (anchored: object | undefined): number => {
    const info = anchored === undefined ? undefined : anchorInfo.get(anchored);
    return info === undefined ? 0 : WORK_COUNT_STEP * info.size + info.aliasesIn * perNestedAlias;
  };
  const scanWork = (alias: object): number => WORK_SCAN * ((index.order.get(alias) ?? index.listLength) + 1);

  // Work of converting a subtree again (a merge source), every alias charged in full.
  const mergeWork = new Map<object, number>();
  const anchoredFresh = new Map<object, number>();
  // Anchored inline merge sources: the merge converts them without registering
  // their anchor, so the first alias to one converts it again (Alias.resolve).
  const unregisteredSources = new Set<object>();
  if (index.hasMerge) {
    walkPostOrder(root, WORK_CONVERT, (frame) => {
      const { item } = frame;
      if (isAlias(item)) {
        frame.fresh = WORK_CONVERT + scanWork(item) + aliasCountWork(index.target.get(item));
      } else if (isPair(item) && isMergePair(item, mergeByDefault)) {
        let sourcesWork = 0;
        const value = item.value;
        for (const inline of isSeq(value) ? value.items : [value]) {
          if (isMap(inline) && anchorOf(inline) !== undefined) unregisteredSources.add(inline);
        }
        const aliasSources = isAlias(value) ? [value] : isSeq(value) ? value.items.filter((entry) => isAlias(entry)) : [];
        for (const alias of aliasSources) {
          const source = index.target.get(alias);
          // A source that is still being converted (an ancestor) re-enters itself.
          sourcesWork += 2 * (source === undefined ? 0 : (anchoredFresh.get(source) ?? Number.POSITIVE_INFINITY));
        }
        frame.fresh = WORK_CONVERT + 2 * frame.valueFresh + sourcesWork;
        mergeWork.set(item, frame.fresh);
      } else {
        frame.fresh += WORK_CONVERT;
        if (isPair(item) && mayConvertToObjectKey(item.key)) {
          frame.fresh += WORK_KEY_ANCHOR * index.anchors + WORK_KEY_STRINGIFY * frame.keySize;
        }
      }
      if (anchorOf(item) !== undefined) anchoredFresh.set(item, frame.fresh);
    });
  }

  // The conversion itself, in the library's order.
  let work = WORK_VISIT * n + WORK_KEY_STRINGIFY * n;
  const countChecked = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const item = stack.pop();
    work += WORK_CONVERT;
    if (isTreeItem(item)) {
      if (isAlias(item)) {
        work += scanWork(item);
        const anchored = index.target.get(item);
        const info = anchored === undefined ? undefined : anchorInfo.get(anchored);
        if (anchored !== undefined && info !== undefined && !(info.hasOne && countChecked.has(anchored))) {
          work += aliasCountWork(anchored);
          if (info.hasOne) countChecked.add(anchored);
        }
        if (anchored !== undefined && unregisteredSources.delete(anchored)) {
          work += anchoredFresh.get(anchored) ?? Number.POSITIVE_INFINITY;
        }
      } else if (isPair(item) && index.hasMerge && isMergePair(item, mergeByDefault)) {
        work += mergeWork.get(item) ?? Number.POSITIVE_INFINITY;
        // Re-converted sources register their anchors again (fresh counts).
        countChecked.clear();
      } else {
        if (anchorOf(item) !== undefined) countChecked.delete(item);
        if (isPair(item) && mayConvertToObjectKey(item.key)) work += WORK_KEY_ANCHOR * index.anchors;
        const children = childrenOf(item);
        for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
          stack.push(children[childIndex]);
        }
      }
    }
    if (work > MAX_SPEC_CONVERSION_WORK) throw limitExceeded(work);
  }
}

/**
 * `document.toJS()` once its work is known to be bounded
 * ({@link assertSpecConversionWithinBudget}); same result as toJS().
 */
export function convertSpecDocument(document: Document.Parsed): unknown {
  assertSpecConversionWithinBudget(document);
  return document.toJS();
}

/** Iterative DFS: derinlik ve node kotaları; recursion yok. */
function checkStructureQuotas(root: unknown): void {
  let nodes = 0;
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: root, depth: 1 },
  ];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break; // noUncheckedIndexedAccess güvencesi
    nodes += 1;
    if (nodes > MAX_SPEC_NODES) {
      throw new ContractDiscoveryError(
        "contracts/limit-exceeded",
        `Spec node quota exceeded (> ${String(MAX_SPEC_NODES)}) — possible alias bomb`,
      );
    }
    if (item.depth > MAX_SPEC_DEPTH) {
      throw new ContractDiscoveryError(
        "contracts/depth-exceeded",
        `Spec depth limit exceeded (> ${String(MAX_SPEC_DEPTH)})`,
      );
    }
    const { value, depth } = item;
    if (Array.isArray(value)) {
      for (const child of value) {
        stack.push({ value: child, depth: depth + 1 });
      }
    } else if (value !== null && typeof value === "object") {
      for (const child of Object.values(value as Record<string, unknown>)) {
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Line of the key node at `segments` (CAU-04): map keys are found through the
 * document's YamlKeyIndex and the offset is turned into a line by the
 * document's line locator, so a lookup no longer scans the map or the text.
 */
function keyNodeLine(
  node: unknown,
  segments: readonly (string | number)[],
  keys: YamlKeyIndex,
  lineAt: (offset: number) => number,
): number | undefined {
  let current: unknown = node;
  let keyNode: unknown;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === undefined) return undefined;
    if (isMap(current)) {
      const item = keys.find(current, segment);
      if (item === undefined) return undefined;
      keyNode = item.key;
      current = item.value;
    } else if (isSeq(current)) {
      const seq = current as YAMLSeq;
      const index = typeof segment === "number" ? segment : Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= seq.items.length) {
        return undefined;
      }
      const child = seq.items[index];
      keyNode = child;
      current = child;
    } else {
      return undefined;
    }
  }
  if (
    keyNode !== undefined &&
    keyNode !== null &&
    typeof keyNode === "object" &&
    "range" in keyNode
  ) {
    const range = (keyNode as { range?: readonly number[] }).range;
    if (range !== undefined && range.length > 0) {
      return lineAt(range[0] ?? 0);
    }
  }
  return undefined;
}

/** Çözümlenmiş spec: kök eşleme + anahtar-yol → satır çözümleyici. */
export interface ParsedSpec {
  readonly root: Record<string, unknown>;
  readonly text: string;
  /**
   * Verilen anahtar yolunun (örn. ["paths", "/orders"]) KAYNAK METİNDEKİ
   * satırı (1 tabanlı); yol bulunamazsa undefined. YAML ve JSON belgelerinde
   * çalışır (`yaml` parseDocument konum aralıkları her ikisinde de vardır).
   * Lookups use per-document key and line indexes (CAU-04); with a projection
   * budget, each segment costs 1 work unit and each map's first index build
   * costs 1 unit per entry.
   */
  lineOf(...segments: Array<string | number>): number | undefined;
}

function syntaxErrorCode(relativePath: string): "contracts/spec-json-invalid" | "contracts/spec-yaml-invalid" {
  const lower = relativePath.toLowerCase();
  return lower.endsWith(".json")
    ? "contracts/spec-json-invalid"
    : "contracts/spec-yaml-invalid";
}

/**
 * Spec metnini güvenlik katmanlarından geçirip çözümler. Söz dizimi hatası
 * → contracts/spec-json-invalid (.json) / contracts/spec-yaml-invalid
 * (diğer); kök eşleme değilse → contracts/spec-invalid.
 * `options.budget` (optional) meters the lineOf lookups (CAU-04).
 */
export function parseStructuredSpec(
  relativePath: string,
  text: string,
  options: ProjectionOptions = {},
): ParsedSpec {
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    throw new ContractDiscoveryError("contracts/invalid-input", "relativePath must not be empty");
  }
  if (typeof text !== "string") {
    throw new ContractDiscoveryError("contracts/invalid-input", "text must be a string");
  }
  assertSpecTextPrechecks(text);

  let document: Document.Parsed;
  let root: unknown;
  try {
    // Same document and errors as yaml's parseDocument(text), with a linear
    // duplicate-key check (CAU-04; see yaml-document.ts).
    document = parseYamlDocument(text);
    if (document.errors.length > 0) {
      const first = document.errors[0];
      throw new ContractDiscoveryError(
        syntaxErrorCode(relativePath),
        `Spec YAML/JSON syntax error: ${describeSpecSyntaxError(first)}`,
      );
    }
    // toJS() alias'ları genişletir; kütüphane alias bombası sınırını
    // ReferenceError ile aşar — ContractDiscoveryError'a çevrilir. F24: its
    // work is bounded first (contracts/limit-exceeded).
    root = convertSpecDocument(document);
  } catch (error) {
    if (error instanceof ContractDiscoveryError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ContractDiscoveryError(
      message.includes("alias")
        ? "contracts/limit-exceeded"
        : syntaxErrorCode(relativePath),
      `Spec could not be parsed: ${describeSpecParserFailure(error)}`,
    );
  }
  checkStructureQuotas(root);

  if (!isPlainObject(root)) {
    throw new ContractDiscoveryError(
      "contracts/spec-invalid",
      `Spec root must be a mapping (object); received: ${Array.isArray(root) ? "array" : typeof root}`,
    );
  }

  const budget = options.budget;
  const keys = new YamlKeyIndex(budget === undefined ? undefined : (entries) => { budget.charge(entries); });
  let lineLocator: ((offset: number) => number) | undefined;
  const lineAt = (offset: number): number => {
    lineLocator ??= createLineLocator(text);
    return lineLocator(offset);
  };

  return {
    root,
    text,
    lineOf: (...segments: Array<string | number>) => {
      if (segments.length === 0) return undefined;
      budget?.charge(segments.length);
      return keyNodeLine(document.contents, segments, keys, lineAt);
    },
  };
}
