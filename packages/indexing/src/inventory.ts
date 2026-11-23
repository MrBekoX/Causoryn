import { Buffer } from "node:buffer";
import { readdirSync, readFileSync, statSync } from "node:fs";
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
 * Güvenlik sözleşmesi (TŞ §19, WorkspaceAccessPolicy başlığındaki TOCTOU
 * gerekliliği): her dosya için (1) açılıştan ÖNCE `checkFile` kararı,
 * (2) okuma sonrası gerçek boyutla YENİDEN `checkFile` denetimi yapılır;
 * ikinci karar reddederse dosya envantere girmez ve uyarı üretilir.
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

function toPosixRelative(nativeRelative: string): string {
  return nativeRelative.split(path.sep).join("/");
}

/**
 * Politika izinli dosyaları kök altında toplar. Dizin, ignore kuralına
 * takılırsa alt ağacı budanır (checkPath ataları da değerlendirir).
 */
export function collectInventory(
  policy: WorkspaceAccessPolicy,
  canonicalRoot: string,
  maxFiles: number,
): InventoryEntry[] {
  const entries: InventoryEntry[] = [];

  const walk = (nativeRelative: string): void => {
    const absolute = nativeRelative === "" ? canonicalRoot : path.join(canonicalRoot, nativeRelative);
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
          // Ignore/traversal/symlink kararı: dizinin alt ağacı budanır.
          continue;
        }
        walk(childRelative);
        continue;
      }
      if (!dirent.isFile()) {
        // Symlink veya diğer girdiler için yol/sarmalama politikasını koru.
        const entryDecision = policy.checkPath(canonicalRoot, childPosix);
        if (!entryDecision.allowed) {
          continue;
        }
        continue;
      }
      // 1) Açılıştan önce: checkFile kendi içinde checkPath (ignore + symlink) + uzantı + boyut uygular.
      const preDecision = policy.checkFile(canonicalRoot, childPosix);
      if (!preDecision.allowed) {
        continue;
      }
      let content: string;
      try {
        content = readFileSync(path.join(canonicalRoot, childRelative), "utf8");
      } catch {
        continue; // okunamayan dosya envantere girmez
      }
      const sizeBytes = Buffer.byteLength(content, "utf8");
      // 2) Açma sonrası yeniden denetim (TOCTOU sözleşmesi; TŞ §19).
      const postDecision = policy.checkFile(canonicalRoot, childPosix, sizeBytes);
      if (!postDecision.allowed) {
        continue;
      }
      entries.push({
        relativePath: childPosix,
        sizeBytes,
        contentHash: sha256Hex(utf8Encode(content)),
        content,
      });
      if (entries.length > maxFiles) {
        throw new IndexingError(
          "indexing/limit-exceeded",
          `dosya sayısı index.maxFiles sınırını (${String(maxFiles)}) aştı`,
        );
      }
    }
  };

  // Kök dizinin kendisi politikaya tabidir (authorizeRoot çağıranın
  // sorumluluğundadır; burada yalnızca iç yapıyı doğrulayarak başlarız).
  const rootStat = statSync(canonicalRoot);
  if (!rootStat.isDirectory()) {
    throw new IndexingError(
      "indexing/internal",
      "envanter kökü bir dizin değil (authorizeRoot kararıyla çelişki)",
    );
  }
  walk("");
  entries.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return entries;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
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
): Promise<InventoryEntry[]> {
  const rootStat = statSync(canonicalRoot);
  if (!rootStat.isDirectory()) {
    throw new IndexingError(
      "indexing/internal",
      "envanter kökü bir dizin değil (authorizeRoot kararıyla çelişki)",
    );
  }

  const stride = Math.max(1, Math.floor(Number.isFinite(yieldEvery) ? yieldEvery : 64));
  const entries: InventoryEntry[] = [];
  let processed = 0;

  const maybeYield = async (): Promise<void> => {
    processed += 1;
    if (processed % stride === 0) {
      await yieldToEventLoop();
    }
  };

  const walk = async (nativeRelative: string): Promise<void> => {
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
        await walk(childRelative);
        continue;
      }
      if (!dirent.isFile()) {
        const entryDecision = policy.checkPath(canonicalRoot, childPosix);
        if (!entryDecision.allowed) {
          continue;
        }
        continue;
      }
      const preDecision = policy.checkFile(canonicalRoot, childPosix);
      if (!preDecision.allowed) {
        continue;
      }
      let content: string;
      try {
        content = readFileSync(path.join(canonicalRoot, childRelative), "utf8");
      } catch {
        continue;
      }
      const sizeBytes = Buffer.byteLength(content, "utf8");
      const postDecision = policy.checkFile(canonicalRoot, childPosix, sizeBytes);
      if (!postDecision.allowed) {
        continue;
      }
      entries.push({
        relativePath: childPosix,
        sizeBytes,
        contentHash: sha256Hex(utf8Encode(content)),
        content,
      });
      if (entries.length > maxFiles) {
        throw new IndexingError(
          "indexing/limit-exceeded",
          `dosya sayısı index.maxFiles sınırını (${String(maxFiles)}) aştı`,
        );
      }
    }
  };

  await walk("");
  entries.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  return entries;
}
