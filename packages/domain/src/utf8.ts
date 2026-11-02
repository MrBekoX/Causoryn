/**
 * Bağımlılıksız UTF-8 kodlayıcı.
 *
 * Neden node:crypto/TextEncoder değil: paketin `@types/node` bağımlılığı
 * kurulu değil ve domain dilimi sıfır çalışma zamanı bağımlılığıyla
 * tip-denetime tabi tutulacak (TŞ v2.1 §6 — TypeScript strict). Kodlama
 * UTF-8 standartlarına göre elle uygulanır ve FIPS vektör testleriyle
 * doğrulanır.
 */

/**
 * Verilen metni UTF-8 byte dizisine kodlar. Surrogate çiftleri tek kod
 * noktasına birleştirilir; tek başına kalan surrogate'ler deterministik
 * olmak koşuluyla 3 byte'lık dizilimle (WTF-8) kodlanır.
 */
export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let codePoint = text.charCodeAt(i);
    const isHighSurrogate = codePoint >= 0xd800 && codePoint <= 0xdbff;
    if (isHighSurrogate && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint =
          0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (codePoint < 0x80) {
      out.push(codePoint);
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      out.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}
