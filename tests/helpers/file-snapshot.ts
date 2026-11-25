import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";

/** Content and metadata of one file, read through a single file descriptor. */
export interface FileSnapshot {
  readonly text: string;
  readonly bytes: Buffer;
  readonly mtimeMs: number;
  readonly size: number;
}

/**
 * Reads a file's bytes and its `mtimeMs`/`size` from the same open descriptor,
 * so a test never checks one path (stat/exists) and then uses another version
 * of it (read/write) — the check and the use refer to the same file object.
 */
export function fileSnapshot(filePath: string): FileSnapshot {
  const fd = openSync(filePath, "r");
  try {
    const stat = fstatSync(fd);
    const bytes = readFileSync(fd);
    return { text: bytes.toString("utf8"), bytes, mtimeMs: stat.mtimeMs, size: stat.size };
  } finally {
    closeSync(fd);
  }
}
