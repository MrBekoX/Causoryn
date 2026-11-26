import {
  readBoundedTextFile,
  readBoundedTextFileSync,
  type BoundedFileReadOptions,
  type BoundedFileReadResult,
} from "@causoryn/workspace";

/**
 * Result of a bounded, descriptor-based optional text read (TŞ §19/§20
 * per-file byte budget; CWE-59 link following and CWE-367 TOCTOU hardening).
 */
export type BoundedTextReadResult =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "missing" }
  | { readonly status: "too-large"; readonly bytes: number };

export interface BoundedTextReadOptions {
  /**
   * Directory the file must stay inside. Any spelling is accepted (a path
   * under a symlinked ancestor such as macOS `/var`, or a Windows 8.3 short
   * path): the root is canonicalised with realpath, only the segments below
   * it are checked, and containment is decided on canonical forms.
   *
   * When omitted, the filesystem root is used: every segment of
   * `absolutePath` must then be a real directory, which holds for paths
   * joined onto a realpath'd workspace root (the production call pattern).
   */
  readonly root?: string;
}

/**
 * The checks live in the shared `@causoryn/workspace` reader (CAU-02/CAU-05):
 * top-down lstat walk from the root (a symlink/junction component is rejected
 * before anything below it is touched), open with O_NOFOLLOW|O_NONBLOCK|
 * O_NOCTTY where available, fstat identity matched against the pre-open lstat
 * and a post-open re-verification, size check from fstat, read capped at
 * `maxBytes + 1`, UTF-8 decode. This module maps its result onto the optional
 * read contract below.
 */
function readerOptions(options: BoundedTextReadOptions | undefined): BoundedFileReadOptions | undefined {
  return options?.root === undefined ? undefined : { root: options.root };
}

function toOptionalTextResult(result: BoundedFileReadResult): BoundedTextReadResult {
  switch (result.status) {
    case "ok":
      return { status: "ok", text: result.text };
    case "too-large":
      return { status: "too-large", bytes: result.bytes };
    case "rejected":
      return { status: "missing" };
  }
}

/**
 * Reads an optional text file that must stay inside a root, through a single
 * descriptor with at most `maxBytes + 1` bytes read.
 *
 * - `{ status: "missing" }`: the file does not exist, is not a regular file,
 *   is reached through a symlink/junction below the root, resolves outside
 *   the root, changed identity around open, or could not be read.
 * - `{ status: "too-large", bytes }`: the fstat size, the bytes read or the
 *   decoded UTF-8 length exceeds `maxBytes`.
 * - Throws RangeError only when `maxBytes` is not a non-negative safe
 *   integer (caller invariant; filesystem conditions never throw).
 */
export async function readOptionalBoundedTextFile(
  absolutePath: string,
  maxBytes: number,
  options?: BoundedTextReadOptions,
): Promise<BoundedTextReadResult> {
  return toOptionalTextResult(await readBoundedTextFile(absolutePath, maxBytes, readerOptions(options)));
}

/**
 * Synchronous counterpart of {@link readOptionalBoundedTextFile} (same
 * checks with lstatSync/realpathSync.native, openSync, fstatSync, bounded
 * readSync and closeSync in `finally`).
 */
export function readOptionalBoundedTextFileSync(
  absolutePath: string,
  maxBytes: number,
  options?: BoundedTextReadOptions,
): BoundedTextReadResult {
  return toOptionalTextResult(readBoundedTextFileSync(absolutePath, maxBytes, readerOptions(options)));
}
