import { describe, expect, it } from "vitest";

import { DomainError } from "../src/errors.js";
import { canonicalJson, type JsonValue } from "../src/canonical-json.js";

describe("canonicalJson", () => {
  it("pozitif: anahtarları sıralı ve boşluksuz üretir", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("pozitif: iç içe nesneleri de sıralar; dizi sırası korunur", () => {
    const value = { z: [3, 1, { y: 2, x: 1 }], a: null };
    expect(canonicalJson(value)).toBe('{"a":null,"z":[3,1,{"x":1,"y":2}]}');
  });

  it("pozitif: girdi anahtar sırası çıktıyı değiştirmez (aynı girdi → aynı JSON, TŞ §8 invariant vi)", () => {
    const a = canonicalJson({ a: 1, b: { d: 4, c: 3 } } as JsonValue);
    const b = canonicalJson({ b: { c: 3, d: 4 }, a: 1 } as JsonValue);
    expect(a).toBe(b);
  });

  it("negatif: nesne değeri undefined ise DomainError fırlatır", () => {
    const bad = { a: undefined } as unknown as JsonValue;
    expect(() => canonicalJson(bad)).toThrowError(DomainError);
    let err: unknown;
    try {
      canonicalJson(bad);
    } catch (e) {
      err = e;
    }
    expect((err as DomainError).code).toBe("domain/unsupported-json-value");
  });

  it("negatif: sonlu olmayan sayılar (NaN, Infinity) DomainError fırlatır", () => {
    expect(() => canonicalJson(Number.NaN)).toThrowError(DomainError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrowError(
      DomainError,
    );
    let err: unknown;
    try {
      canonicalJson(Number.NaN);
    } catch (e) {
      err = e;
    }
    expect((err as DomainError).code).toBe("domain/non-finite-number");
  });

  it("partial: string kaçışları JSON.stringify ile uyumlu ve deterministiktir", () => {
    expect(canonicalJson({ k: 'a"b\\c\nd' })).toBe(
      '{"k":"a\\"b\\\\c\\nd"}',
    );
  });

  it("partial: null değeri anahtarı korur; boş nesne/dizi geçerlidir", () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson("metin")).toBe('"metin"');
    expect(canonicalJson(42)).toBe("42");
  });
});
