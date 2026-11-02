import { describe, expect, it } from "vitest";

import { sha256Hex } from "../src/sha256.js";
import { utf8Encode } from "../src/utf8.js";

// NIST FIPS 180-2 / NIST test vektörleri (kaynak: csrc.nist.gov SHA-2 örnekleri)
describe("sha256Hex", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    [
      "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
      "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
    ],
  ])("pozitif: FIPS vektörü %j → %s", (input, expected) => {
    expect(sha256Hex(utf8Encode(input))).toBe(expected);
  });

  it("pozitif: çıktı her zaman 64 karakterlik küçük harf hex'tir", () => {
    const digest = sha256Hex(utf8Encode("herhangi bir girdi"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("partial: aynı girdi aynı özeti üretir (determinizm — TŞ §8 invariant vi)", () => {
    const bytes = utf8Encode("POST /orders → OrdersService");
    expect(sha256Hex(bytes)).toBe(sha256Hex(bytes));
  });

  it("partial: tek byte farklılığı özeti değiştirir (çarpışma-duyarlılık)", () => {
    const a = sha256Hex(utf8Encode("orders-v1"));
    const b = sha256Hex(utf8Encode("orders-v2"));
    expect(a).not.toBe(b);
  });

  it("partial: 63/64/65 byte sınır uzunlukları (padding yolları) ayrı özetler üretir", () => {
    const d63 = sha256Hex(utf8Encode("x".repeat(63)));
    const d64 = sha256Hex(utf8Encode("x".repeat(64)));
    const d65 = sha256Hex(utf8Encode("x".repeat(65)));
    expect(new Set([d63, d64, d65]).size).toBe(3);
    for (const d of [d63, d64, d65]) expect(d).toMatch(/^[0-9a-f]{64}$/);
  });
});
