import { DomainError } from "./errors.js";

/**
 * Canonical JSON (TŞ v2.1 §8 invariant vi: aynı girdi → aynı Graph JSON).
 *
 * Kurallar:
 * - Nesne anahtarları UTF-16 kod birimi sırasına göre sıralanır (motor
 *   bağımsız determinizm; `Array.prototype.sort` varsayılan karşılaştırma).
 * - Beyaz boşluk yok; string kaçışları `JSON.stringify` ile uyumlu.
 * - Sayılar motorun en kısa yuvarlama-yeniden temsil biçimiyle yazılır
 *   (`JSON.stringify`); sonlu olmayan sayılar reddedilir.
 * - `undefined`, fonksiyon ve sembol değerleri reddedilir (sessiz düşme yok).
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function canonicalJson(value: JsonValue): string {
  return serialize(value);
}

function serialize(value: JsonValue): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new DomainError(
          "domain/non-finite-number",
          `Canonical JSON yalnızca sonlu sayılar kabul eder: ${String(value)}`,
        );
      }
      return JSON.stringify(value);
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) {
        return `[${value.map(serialize).join(",")}]`;
      }
      // Negatif dalda `Array.isArray` readonly dizi türünü ayıramaz; nesne
      // dalını burada açıkça daraltıyoruz.
      const record = value as { readonly [key: string]: JsonValue };
      const keys = Object.keys(record).sort();
      const members = keys.map(
        (key) => `${JSON.stringify(key)}:${serialize(record[key] as JsonValue)}`,
      );
      return `{${members.join(",")}}`;
    }
    default:
      throw new DomainError(
        "domain/unsupported-json-value",
        `Canonical JSON bu değeri desteklemiyor: ${typeof value}`,
      );
  }
}
