import { describe, expect, it } from "vitest";

import { utf8Encode } from "../src/utf8.js";

describe("utf8Encode", () => {
  it("pozitif: ASCII metni bire bir byte dizisine çevirir", () => {
    expect(Array.from(utf8Encode("abc"))).toEqual([0x61, 0x62, 0x63]);
  });

  it("pozitif: iki byte'lı Türkçe karakterleri doğru kodlar (ç ğ ş)", () => {
    // ç U+00E7 → C3 A7, ğ U+011F → C4 9F, ş U+015F → C5 9F
    expect(Array.from(utf8Encode("çğş"))).toEqual([
      0xc3, 0xa7, 0xc4, 0x9f, 0xc5, 0x9f,
    ]);
  });

  it("pozitif: dört byte'lı emoji (U+1F680) doğru kodlanır", () => {
    expect(Array.from(utf8Encode("🚀"))).toEqual([0xf0, 0x9f, 0x9a, 0x80]);
  });

  it("partial: yıldız işareti olmayan kod noktası (U+1D11E) surrogate çifti olarak da aynı sonucu verir", () => {
    // "\uD834\uDD1E" = U+1D11E (MUSICAL SYMBOL G CLEF) surrogate çifti yazımı
    expect(Array.from(utf8Encode("𝄞"))).toEqual([
      0xf0, 0x9d, 0x84, 0x9e,
    ]);
    expect(Array.from(utf8Encode("\uD834\uDD1E"))).toEqual([
      0xf0, 0x9d, 0x84, 0x9e,
    ]);
  });

  it("partial: aynı girdi her zaman aynı byte dizisini üretir (determinizm)", () => {
    const text = "sipariş:/orders → OrdersService 🚀";
    expect(Array.from(utf8Encode(text))).toEqual(Array.from(utf8Encode(text)));
  });
});
