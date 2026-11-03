/**
 * Saf TS SHA-256 (FIPS 180-4).
 *
 * Neden saf TS (güncel gerekçe — denetim bulgusu düzeltmesi): domain
 * paketinin çalışma zamanı bağımlılığı sıfırdır (bağımlılık sınırı: core/
 * domain yalnızca domain sözleşmelerine bağlıdır) ve algoritma NIST FIPS
 * 180-2 örnek vektörleriyle kanıtlanmıştır (bkz.
 * packages/domain/test/sha256.test.ts). `@types/node` artık kök
 * devDependency olduğundan `node:crypto`'ya geçiş teknik olarak mümkündür;
 * bu bir sadeleştirme kararıdır ve ayrı ADR'ye bırakılmıştır — davranış
 * farkı yaratmadan (aynı özet, aynı vektörler) yapılabilir.
 */

/** FIPS 180-4 §4.2.3 — ilk 64 asal sayının küp köklerinin kesir kısımları. */
const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const INITIAL_HASH: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];

const rotr = (x: number, n: number): number =>
  ((x >>> n) | (x << (32 - n))) >>> 0;

/** Byte dizisinin SHA-256 özetini 64 karakterlik küçük harf hex olarak döner. */
export function sha256Hex(bytes: Uint8Array): string {
  const hash = [...INITIAL_HASH];
  const messageLength = bytes.length;
  const bitLength = messageLength * 8;
  const zeroPadding =
    (56 - ((messageLength + 1) % 64) + 64) % 64;
  const paddedLength = messageLength + 1 + zeroPadding + 8;

  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[messageLength] = 0x80;

  // 64 bit büyük-endian bit uzunluğu (TŞ girdileri 2^53 altında kalır).
  const lengthView = new DataView(padded.buffer);
  lengthView.setUint32(
    paddedLength - 8,
    Math.floor(bitLength / 0x1_0000_0000),
    false,
  );
  lengthView.setUint32(paddedLength - 4, bitLength % 0x1_0000_0000, false);

  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let t = 0; t < 16; t += 1) {
      schedule[t] = lengthView.getUint32(offset + t * 4, false);
    }
    for (let t = 16; t < 64; t += 1) {
      const w15 = schedule[t - 15] as number;
      const w2 = schedule[t - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      schedule[t] =
        ((schedule[t - 16] as number) +
          s0 +
          (schedule[t - 7] as number) +
          s1) >>>
        0;
    }

    // Hash her zaman 8 kelimedir; tuple daraltması bu değişmezi koda yazar.
    let [a, b, c, d, e, f, g, h] = hash as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let t = 0; t < 64; t += 1) {
      const w = schedule[t] as number;
      const k = K[t] as number;
      const bigSigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + bigSigma1 + choose + k + w) >>> 0;
      const bigSigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    const round = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i += 1) {
      hash[i] = ((hash[i] as number) + (round[i] as number)) >>> 0;
    }
  }

  let hex = "";
  for (const word of hash) {
    hex += word.toString(16).padStart(8, "0");
  }
  return hex;
}
