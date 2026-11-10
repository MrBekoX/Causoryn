import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * build-bundle yardımcıları — manifest dosya listesi (test edilebilir seam).
 *
 * Bu modül scripts/build-bundle.mjs'ten çıkarıldı: davranışı testle
 * kanıtlanabilir olsun diye (packages/mcp-server/test/build-list-files.test.ts).
 *
 * Sıralama sözleşmesi (güvenlik analizi bulgusu, 2026-11-09): sıralama
 * CODEPOINT (UTF-16 kod birimi) düzenindedir; localeCompare KULLANILMAZ.
 * Gerekçe: localeCompare ICU kollasyonuna bağlıdır — ölçüm: tr-TR locale'inde
 * 'a.txt'.localeCompare('B.txt') === -1 iken codepoint düzeninde
 * 'B.txt' (0x42) < 'a.txt' (0x61)'dir; kollasyon makinenin ICU locale'ine
 * göre değişebileceğinden manifest JSON key sırası — ve dolayısıyla
 * "bit-bit aynı manifest" cross-host determinizmi — aynı-locale varsayımına
 * düşerdi. Codepoint karşılaştırması host/locale'den bağımsız sabittir.
 * Bugünkü vendor ad kümesi (33 key) tamamen küçük harf ASCII olduğundan
 * bugünkü manifest sırası DEĞİŞMEZ (ölçüldü: codepoint == locale == bugünkü
 * sıra; build sonrası manifest baytları birebir doğrulandı); sözleşme,
 * ileride karışık harf boyutlu ad girdiğinde sessizce kırılmayı önler.
 * Kabul kanıtı: test üçlüsü kırmızıdan yeşile koşturuldu (localeCompare
 * sürümü 'expected [a.txt, B.txt] to deeply equal [B.txt, a.txt]' ile
 * kırmızıydı).
 */

/** UTF-16 kod birimi (codepoint) düzeninde karşılaştırıcı: host/locale bağımsız. */
export function compareCodepoint(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Sıralı, deterministik dosya listesi (göreli, POSIX ayraçlı). */
export function listFiles(rootDir, baseDir = rootDir) {
  const entries = readdirSync(rootDir, { withFileTypes: true }).sort((a, b) =>
    compareCodepoint(a.name, b.name),
  );
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      files.push(path.relative(baseDir, fullPath).split(path.sep).join("/"));
    }
  }
  return files;
}
