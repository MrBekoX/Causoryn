import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// build-bundle.mjs'in manifest üretiminde kullandığı dosya listesi seam'i.
// Güvenlik analizi bulgusu (2026-11-09): listFiles sıralaması localeCompare
// ile yapılırsa manifest JSON key sırası ICU locale'ine bağlanır — cross-host
// "bit-bit aynı manifest" determinizmi aynı-locale varsayımına düşer.
// Sözleşme: sıralama CODEPOINT (UTF-16 kod birimi) düzeninde olmalıdır.
import { compareCodepoint, listFiles } from "../scripts/lib/list-files.mjs";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("build-bundle listFiles — codepoint sıralama sözleşmesi (cross-host manifest determinizmi)", () => {
  it("pozitif: tamamen küçük harf ASCII adlar (bugünkü vendor kümesi sınıfı) codepoint düzeninde döner; bugünkü manifest sırası korunur", () => {
    const root = makeTempDir("causoryn-listfiles-lc-");
    for (const name of ["banana.ts", "apple.ts", "cherry.ts"]) {
      writeFileSync(path.join(root, name), "x", "utf8");
    }
    expect(listFiles(root)).toEqual(["apple.ts", "banana.ts", "cherry.ts"]);
  });

  it("negatif (ayrımcı): karışık harf boyutlu adlar CODEPOINT sırasıyla döner — ICU kollasyonu DEĞİL (localeCompare 'a.txt' < 'B.txt' der, codepoint'te B=0x42 < a=0x61)", () => {
    const root = makeTempDir("causoryn-listfiles-mc-");
    writeFileSync(path.join(root, "a.txt"), "x", "utf8");
    writeFileSync(path.join(root, "B.txt"), "x", "utf8");
    // Bu satır localeCompare ile KIRMIZI düşer (kollasyon a'yı önce koyar);
    // codepoint karşılaştırma ile YEŞİLDİR — host/locale'den bağımsız.
    expect(listFiles(root)).toEqual(["B.txt", "a.txt"]);
  });

  it("partial: iç içe dizinlerde POSIX ayraçlı göreli yol; dizin içi sıralama da codepoint'tir ve derinlik-öncelik gezinme deterministiktir", () => {
    const root = makeTempDir("causoryn-listfiles-nest-");
    writeFileSync(path.join(root, "top.txt"), "x", "utf8");
    mkdirSync(path.join(root, "sub"), { recursive: true });
    writeFileSync(path.join(root, "sub", "b.txt"), "x", "utf8");
    writeFileSync(path.join(root, "sub", "A.txt"), "x", "utf8");
    // "sub" (0x73) < "top.txt" (0x74): önce sub derinlemesine; sub içinde
    // codepoint: "A.txt" (0x41) < "b.txt" (0x62).
    expect(listFiles(root)).toEqual(["sub/A.txt", "sub/b.txt", "top.txt"]);
    expect(compareCodepoint("a", "B")).toBe(1); // a(0x61) > B(0x42)
    expect(compareCodepoint("same", "same")).toBe(0);
  });
});
