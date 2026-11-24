import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { open } from "node:fs/promises";

/**
 * FD-tabanlı sınırlı isteğe bağlı metin okuma sonucu (TŞ §19/§20 dosya başına
 * byte bütçesi + CWE-367 TOCTOU koruması).
 */
export type BoundedTextReadResult =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "missing" }
  | { readonly status: "too-large"; readonly bytes: number };

const READ_CHUNK_BYTES = 64 * 1024;
const OPEN_RDONLY_NOFOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * İsteğe bağlı metin dosyasını tek bir file handle üzerinden atomik olarak açar,
 * `handle.stat()` ile normal dosya ve boyut kontrolü yapar, ardından en fazla
 * `maxBytes + 1` bayt okuyarak UTF-8 metne çevirir.
 *
 * - Dosya yoksa, normal dosya değilse, symlink (POSIX O_NOFOLLOW) ise veya
 *   okunamıyorsa `{ status: "missing" }` döner.
 * - Dosya boyutu veya okunan/çözülen UTF-8 bayt uzunluğu `maxBytes` sınırını
 *   aşarsa `{ status: "too-large", bytes }` döner.
 */
export async function readOptionalBoundedTextFile(
  absolutePath: string,
  maxBytes: number,
): Promise<BoundedTextReadResult> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolutePath, OPEN_RDONLY_NOFOLLOW);
  } catch {
    return { status: "missing" };
  }

  try {
    const st = await handle.stat();
    if (!st.isFile()) {
      return { status: "missing" };
    }
    if (st.size > maxBytes) {
      return { status: "too-large", bytes: st.size };
    }

    const maxRead = maxBytes + 1;
    const chunkSize = Math.min(READ_CHUNK_BYTES, Math.max(1, maxRead));
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    while (totalBytes < maxRead) {
      const toRead = Math.min(chunkSize, maxRead - totalBytes);
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(buf, 0, toRead, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }

    if (totalBytes > maxBytes) {
      return { status: "too-large", bytes: totalBytes };
    }

    const text = Buffer.concat(chunks, totalBytes).toString("utf8");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) {
      return { status: "too-large", bytes };
    }
    return { status: "ok", text };
  } catch {
    return { status: "missing" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * `readOptionalBoundedTextFile` fonksiyonunun senkron karşılığı (`openSync` +
 * `fstatSync` + sınırlı `readSync` + `finally` içinde `closeSync`).
 */
export function readOptionalBoundedTextFileSync(
  absolutePath: string,
  maxBytes: number,
): BoundedTextReadResult {
  let fd: number;
  try {
    fd = openSync(absolutePath, OPEN_RDONLY_NOFOLLOW);
  } catch {
    return { status: "missing" };
  }

  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      return { status: "missing" };
    }
    if (st.size > maxBytes) {
      return { status: "too-large", bytes: st.size };
    }

    const maxRead = maxBytes + 1;
    const chunkSize = Math.min(READ_CHUNK_BYTES, Math.max(1, maxRead));
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    while (totalBytes < maxRead) {
      const toRead = Math.min(chunkSize, maxRead - totalBytes);
      const buf = Buffer.allocUnsafe(toRead);
      const bytesRead = readSync(fd, buf, 0, toRead, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }

    if (totalBytes > maxBytes) {
      return { status: "too-large", bytes: totalBytes };
    }

    const text = Buffer.concat(chunks, totalBytes).toString("utf8");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) {
      return { status: "too-large", bytes };
    }
    return { status: "ok", text };
  } catch {
    return { status: "missing" };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Kapatma hatası yoksayılır.
    }
  }
}
