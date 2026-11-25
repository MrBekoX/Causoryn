import { Buffer } from "node:buffer";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { sha256Hex, utf8Encode } from "@causoryn/domain";
import type { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { IndexingError } from "./errors.js";

/**
 * Dosya envanteri (TŞ v2.1 §9 "Discover → allowlist/ignore → fingerprint";
 * sprint-1 görev 6 indexing dilimi).
 *
 * Yürüme sırası deterministiktir: dizin girdileri ada göre sıralanır,
 * sonuç envanteri göreli POSIX yola göre sıralanır (TŞ §8 invariant vi).
 *
 * Güvenlik sözleşmesi (TŞ §19, SEC-07, WorkspaceAccessPolicy TOCTOU sözleşmesi):
 * her dosya için (1) açılıştan ÖNCE `checkFile` kararı, (2) `O_RDONLY | O_NOFOLLOW`
 * ile fd açılıp `fstatSync` (`isFile()`, `size <= maxFileBytes`) + sınırlı
 * `readSync` (≤ `maxFileBytes + 1`) ile FIFO/dev-dosya/OOM/symlink takasına
 * karşı korumalı okuma, (3) okuma sonrası gerçek boyutla YENİDEN `checkFile`
 * denetimi yapılır; ikinci karar reddederse dosya envantere girmez.
 */

/** Envanter girdisi: politika-izinli, okunmuş tek kaynak dosya. */
export interface InventoryEntry {
  /** Kök-göreceli POSIX yol ("src/app.ts"). */
  readonly relativePath: string;
  readonly sizeBytes: number;
  /** sha256(utf8(content)); FileRecord.contentHash ve evidence span kaynağı. */
  readonly contentHash: string;
  readonly content: string;
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Maximum directory nesting below the workspace root the inventory descends into.
 * Real source trees stay far below it (ignored trees such as node_modules are
 * pruned before descending); a deeper tree fails with `indexing/limit-exceeded`
 * instead of being truncated silently.
 */
export const MAX_INVENTORY_DEPTH = 256;

function assertWithinDepth(depth: number, maxDepth: number, childPosix: string): void {
  if (depth > maxDepth) {
    throw new IndexingError(
      "indexing/limit-exceeded",
      `directory nesting exceeded the inventory depth limit (${String(maxDepth)}) at ${childPosix}`,
    );
  }
}

function toPosixRelative(nativeRelative: string): string {
  return nativeRelative.split(path.sep).join("/");
}

function assertCanonicalRootIsDirectory(canonicalRoot: string): void {
  const rootStat = statSync(canonicalRoot);
  if (!rootStat.isDirectory()) {
    throw new IndexingError(
      "indexing/internal",
      "inventory root is not a directory (contradicts the authorizeRoot decision)",
    );
  }
}

/**
 * Tek dosyayı TOCTOU-güvenli fd tabanlı sınırlı okumayla envanter girdisine
 * dönüştürür; politika reddederse veya dosya okunamaz/sınırı aşarsa undefined döner.
 */
function readAllowedFileEntry(
  policy: WorkspaceAccessPolicy,
  canonicalRoot: string,
  childRelative: string,
  childPosix: string,
): InventoryEntry | undefined {
  // 1) Açılıştan önce: checkFile kendi içinde checkPath (ignore + symlink) + uzantı + boyut uygular.
  const preDecision = policy.checkFile(canonicalRoot, childPosix);
  if (!preDecision.allowed) {
    return undefined;
  }

  const maxBytes = policy.config.maxFileBytes;
  const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(path.join(canonicalRoot, childRelative), openFlags);
  } catch {
    return undefined; // okunamayan/symlink dosya envantere girmez
  }

  let content: string;
  let sizeBytes: number;
  try {
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile() || fdStat.size > maxBytes) {
      return undefined;
    }
    const chunks: Buffer[] = [];
    let totalRead = 0;
    const hardCap = maxBytes + 1;
    while (totalRead < hardCap) {
      const toRead = Math.min(READ_CHUNK_BYTES, hardCap - totalRead);
      const chunk = Buffer.allocUnsafe(toRead);
      const bytesRead = readSync(fd, chunk, 0, toRead, null);
      if (bytesRead <= 0) break;
      chunks.push(bytesRead === toRead ? chunk : chunk.subarray(0, bytesRead));
      totalRead += bytesRead;
    }
    if (totalRead > maxBytes) {
      return undefined;
    }
    const buffer =
      chunks.length === 0
        ? Buffer.alloc(0)
        : chunks.length === 1
          ? (chunks[0] as Buffer)
          : Buffer.concat(chunks, totalRead);
    content = buffer.toString("utf8");
    sizeBytes = Buffer.byteLength(content, "utf8");
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Kapatma hatası yutulur.
    }
  }

  // 2) Açma sonrası yeniden denetim (TOCTOU sözleşmesi; TŞ §19).
  const postDecision = policy.checkFile(canonicalRoot, childPosix, sizeBytes);
  if (!postDecision.allowed) {
    return undefined;
  }
  return {
    relativePath: childPosix,
    sizeBytes,
    contentHash: sha256Hex(utf8Encode(content)),
    content,
  };
}

/** Node.js event loop'una tek tur nefes verir (non-blocking async pipeline). */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Politika izinli dosyaları kök altında toplar. Dizin, ignore kuralına
 * takılırsa alt ağacı budanır (checkPath ataları da değerlendirir).
 *
 * Only regular files and real directories are visited: link entries (symbolic
 * links, junctions) and special files are skipped without a policy call, so
 * nothing stats or resolves a link target. Directory nesting deeper than
 * `maxDepth` fails with `indexing/limit-exceeded`.
 */
export function collectInventory(
  policy: WorkspaceAccessPolicy,
  canonicalRoot: string,
  maxFiles: number,
  maxDepth = MAX_INVENTORY_DEPTH,
): InventoryEntry[] {
  assertCanonicalRootIsDirectory(canonicalRoot);
  const entries: InventoryEntry[] = [];

  const walk = (nativeRelative: string, depth: number): void => {
    const absolute =
      nativeRelative === "" ? canonicalRoot : path.join(canonicalRoot, nativeRelative);
    const dirents = readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const dirent of dirents) {
      const childRelative =
        nativeRelative === "" ? dirent.name : `${nativeRelative}${path.sep}${dirent.name}`;
      const childPosix = toPosixRelative(childRelative);
      if (dirent.isDirectory()) {
        const dirDecision = policy.checkPath(canonicalRoot, childPosix);
        if (!dirDecision.allowed) {
          continue;
        }
        assertWithinDepth(depth + 1, maxDepth, childPosix);
        walk(childRelative, depth + 1);
        continue;
      }
      if (!dirent.isFile()) {
        // Links (symbolic links, junctions) and special files are never followed:
        // skipped before any policy call stats or resolves them.
        continue;
      }
      const entry = readAllowedFileEntry(policy, canonicalRoot, childRelative, childPosix);
      if (entry === undefined) continue;
      entries.push(entry);
      if (entries.length > maxFiles) {
        throw new IndexingError(
          "indexing/limit-exceeded",
          `file count exceeded the index.maxFiles limit (${String(maxFiles)})`,
        );
      }
    }
  };

  walk("", 0);
  entries.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  return entries;
}

/**
 * `collectInventory` ile bit-bit aynı sıralı `InventoryEntry[]` çıktısını
 * üreten, ancak her `yieldEvery` (varsayılan 64) işlenen dosya/dizinde
 * Node.js event loop'una (`setImmediate`) nefes veren non-blocking envanter
 * tarayıcısı (v0.2.3).
 */
export async function collectInventoryAsync(
  policy: WorkspaceAccessPolicy,
  canonicalRoot: string,
  maxFiles: number,
  yieldEvery = 64,
  maxDepth = MAX_INVENTORY_DEPTH,
): Promise<InventoryEntry[]> {
  assertCanonicalRootIsDirectory(canonicalRoot);

  const stride = Math.max(1, Math.floor(Number.isFinite(yieldEvery) ? yieldEvery : 64));
  const entries: InventoryEntry[] = [];
  let processed = 0;

  const maybeYield = async (): Promise<void> => {
    processed += 1;
    if (processed % stride === 0) {
      await yieldToEventLoop();
    }
  };

  const walk = async (nativeRelative: string, depth: number): Promise<void> => {
    const absolute =
      nativeRelative === "" ? canonicalRoot : path.join(canonicalRoot, nativeRelative);
    const dirents = readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const dirent of dirents) {
      await maybeYield();
      const childRelative =
        nativeRelative === "" ? dirent.name : `${nativeRelative}${path.sep}${dirent.name}`;
      const childPosix = toPosixRelative(childRelative);
      if (dirent.isDirectory()) {
        const dirDecision = policy.checkPath(canonicalRoot, childPosix);
        if (!dirDecision.allowed) {
          continue;
        }
        assertWithinDepth(depth + 1, maxDepth, childPosix);
        await walk(childRelative, depth + 1);
        continue;
      }
      if (!dirent.isFile()) {
        // Links (symbolic links, junctions) and special files are never followed:
        // skipped before any policy call stats or resolves them.
        continue;
      }
      const entry = readAllowedFileEntry(policy, canonicalRoot, childRelative, childPosix);
      if (entry === undefined) continue;
      entries.push(entry);
      if (entries.length > maxFiles) {
        throw new IndexingError(
          "indexing/limit-exceeded",
          `file count exceeded the index.maxFiles limit (${String(maxFiles)})`,
        );
      }
    }
  };

  await walk("", 0);
  entries.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  return entries;
}
