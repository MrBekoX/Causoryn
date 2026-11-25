import { Buffer } from "node:buffer";

import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

import { ContractDiscoveryError } from "./errors.js";

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
 *     korumalarıyla; hatalar toplanır → spec-yaml/spec-json-invalid)
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

function offsetToLine(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

function keyNodeLine(
  node: unknown,
  segments: readonly (string | number)[],
  text: string,
): number | undefined {
  let current: unknown = node;
  let keyNode: unknown;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === undefined) return undefined;
    if (isMap(current)) {
      const map = current as YAMLMap;
      const item = map.items.find((entry) => isScalar(entry.key) && entry.key.value === segment);
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
      return offsetToLine(text, range[0] ?? 0);
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
 */
export function parseStructuredSpec(relativePath: string, text: string): ParsedSpec {
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
    document = parseDocument(text);
    if (document.errors.length > 0) {
      const first = document.errors[0];
      throw new ContractDiscoveryError(
        syntaxErrorCode(relativePath),
        `Spec YAML/JSON syntax error: ${describeSpecSyntaxError(first)}`,
      );
    }
    // toJS() alias'ları genişletir; kütüphane alias bombası sınırını
    // ReferenceError ile aşar — ContractDiscoveryError'a çevrilir.
    root = document.toJS();
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

  return {
    root,
    text,
    lineOf: (...segments: Array<string | number>) =>
      segments.length === 0 ? undefined : keyNodeLine(document.contents, segments, text),
  };
}
