import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import {
  GraphRepositoryError,
  readGitTree,
  serializeSnapshotContentSet,
  TIMELINE_SNAPSHOT_BLOB_PATH,
  WORKING_TREE_REF,
  type CompareContentSet,
  type GitTreeEntry,
  type TimelineReconstructFromGitTree,
  type TimelineSnapshotLookup,
} from "@causoryn/graph";
import type { PolicyDecision } from "@causoryn/workspace";

import type { ServiceDeps } from "./services.js";

/**
 * Trusted sources for the history tools (`causoryn_compare_architecture`,
 * `causoryn_architecture_timeline`), wired into the trust hierarchy of
 * `readTimelinePointFromGit` / `buildArchitectureTimelineFromGit`:
 *
 * 1. `snapshotLookup` (commit refs): the local index's latest published
 *    snapshot, but ONLY when the indexed files are proven to be exactly the
 *    commit's content. Proof: every indexed file still has its indexed hash on
 *    disk, its git blob id (computed from those bytes) equals the commit
 *    tree's entry (read-only `git ls-tree`), and every other path in the
 *    commit tree is excluded by the workspace path/extension rules. The index
 *    keeps no per-commit history (snapshots are recorded against the working
 *    tree), so this is the only commit the index can vouch for.
 * 2. `reconstructFromGitTree` (`working-tree` ref): the local index's latest
 *    published snapshot — the engine's own analysis of the working tree —
 *    instead of the working-tree `.causoryn/architecture-snapshot.json` file.
 *    Commit refs are not reconstructed here: a file-level reconstruction
 *    would mix granularities with the symbol-level points from (1) and (3).
 * 3. Otherwise the timeline core falls back to the repo-committed (or
 *    working-tree) snapshot file and marks the point with
 *    `snapshot-loaded-from-committed-git-blob`.
 *
 * Every check is conservative: any doubt (stale build, edited file, CRLF
 * conversion, untracked indexed file, unreadable path) means "not verified"
 * and the point falls back to (3) with its trust warning. Nothing is written.
 */
export interface TrustedHistorySources {
  readonly snapshotLookup: TimelineSnapshotLookup;
  readonly reconstructFromGitTree: TimelineReconstructFromGitTree;
  /** One line per ref that was served from the local index (envelope warnings). */
  readonly notes: () => readonly string[];
}

interface LoadedIndex {
  readonly snapshotId: string;
  readonly stale: boolean;
  readonly contentSet: CompareContentSet;
  /** relativePath -> indexed content hash, taken from the snapshot's node locations. */
  readonly nodeFileHashes: ReadonlyMap<string, string>;
}

interface IndexedFileProof {
  readonly gitBlobSha1: string;
  readonly gitBlobSha256: string;
}

type DiskProof =
  | { readonly ok: true; readonly files: ReadonlyMap<string, IndexedFileProof> }
  | { readonly ok: false; readonly reason: string; readonly changedFiles: number };

const OPEN_RDONLY_NOFOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const READ_CHUNK_BYTES = 64 * 1024;
const SYMLINK_MODE = "120000";

/** Policy denials that depend only on the path (ignore rule or extension filter). */
const NON_PATH_RULES: ReadonlySet<string> = new Set([
  "realpath-containment",
  "unc-or-device-path",
  "..",
  "sizeBytes",
  "maxFileBytes",
]);

function isPathRuleExclusion(decision: PolicyDecision): boolean {
  return (
    !decision.allowed &&
    decision.code === "workspace/path-denied" &&
    decision.rule !== undefined &&
    !NON_PATH_RULES.has(decision.rule)
  );
}

/** Reads a regular file (no symlink follow) of at most `maxBytes` bytes. */
async function readBoundedFileBytes(
  absolutePath: string,
  maxBytes: number,
): Promise<Buffer | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolutePath, OPEN_RDONLY_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) {
      return undefined;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const limit = maxBytes + 1;
    while (total < limit) {
      const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit - total));
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      chunks.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
      total += bytesRead;
    }
    return total > maxBytes ? undefined : Buffer.concat(chunks, total);
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function gitBlobId(algorithm: "sha1" | "sha256", bytes: Buffer): string {
  return createHash(algorithm).update(`blob ${String(bytes.length)}\0`).update(bytes).digest("hex");
}

/** Same hash the inventory records: sha256 of the UTF-8 re-encoding of the decoded text. */
function inventoryHashOf(bytes: Buffer): string {
  return createHash("sha256").update(Buffer.from(bytes.toString("utf8"), "utf8")).digest("hex");
}

export function createTrustedHistorySources(
  deps: ServiceDeps,
  workspaceId: string,
  canonicalRoot: string,
): TrustedHistorySources {
  const notes: string[] = [];
  const addNote = (note: string): void => {
    if (!notes.includes(note)) notes.push(note);
  };

  let indexLoaded = false;
  let index: LoadedIndex | null = null;
  const loadIndex = (): LoadedIndex | null => {
    if (indexLoaded) return index;
    indexLoaded = true;
    const read = deps.repository.getLatestPublished(workspaceId);
    if (read === undefined) return null;
    let contentSet: CompareContentSet;
    try {
      contentSet = JSON.parse(serializeSnapshotContentSet(read.snapshot)) as CompareContentSet;
    } catch (error) {
      deps.logger(
        `history: the published snapshot ${read.snapshot.meta.id} could not be used as a trusted source: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    const nodeFileHashes = new Map<string, string>();
    for (const node of read.snapshot.nodes) {
      if (node.location === undefined) continue;
      const previous = nodeFileHashes.get(node.location.relativePath);
      if (previous !== undefined && previous !== node.location.sourceHash) {
        deps.logger(
          `history: the published snapshot ${read.snapshot.meta.id} records two hashes for ${node.location.relativePath}; it is not used as a trusted source`,
        );
        return null;
      }
      nodeFileHashes.set(node.location.relativePath, node.location.sourceHash);
    }
    index = {
      snapshotId: read.snapshot.meta.id,
      stale: read.stale,
      contentSet,
      nodeFileHashes,
    };
    return index;
  };

  let diskProofPromise: Promise<DiskProof> | undefined;
  const loadDiskProof = (loaded: LoadedIndex): Promise<DiskProof> => {
    diskProofPromise ??= (async (): Promise<DiskProof> => {
      const inventory = deps.repository.listFiles(workspaceId);
      if (inventory.length === 0) {
        return { ok: false, reason: "the index has no file inventory", changedFiles: 0 };
      }
      const inventoryHashes = new Map(inventory.map((file) => [file.relativePath, file.contentHash]));
      // The files table must describe the same content as the published snapshot.
      for (const [relativePath, hash] of loaded.nodeFileHashes) {
        if (inventoryHashes.get(relativePath) !== hash) {
          return {
            ok: false,
            reason: "the file inventory differs from the published snapshot",
            changedFiles: 0,
          };
        }
      }
      const files = new Map<string, IndexedFileProof>();
      let changedFiles = 0;
      for (const file of inventory) {
        const absolute = path.resolve(canonicalRoot, file.relativePath);
        const relative = path.relative(canonicalRoot, absolute);
        const decision = deps.policy.checkFile(canonicalRoot, absolute);
        const bytes =
          relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative) || !decision.allowed
            ? undefined
            : await readBoundedFileBytes(absolute, deps.config.maxFileBytes);
        if (bytes === undefined || inventoryHashOf(bytes) !== file.contentHash) {
          changedFiles += 1;
          continue;
        }
        files.set(file.relativePath, {
          gitBlobSha1: gitBlobId("sha1", bytes),
          gitBlobSha256: gitBlobId("sha256", bytes),
        });
      }
      if (changedFiles > 0) {
        return {
          ok: false,
          reason: `${String(changedFiles)} indexed file(s) changed on disk since the snapshot`,
          changedFiles,
        };
      }
      return { ok: true, files };
    })();
    return diskProofPromise;
  };

  const verifiedCommits = new Map<string, Promise<boolean>>();
  const verifyCommit = (commitSha: string, proof: ReadonlyMap<string, IndexedFileProof>): Promise<boolean> => {
    let pending = verifiedCommits.get(commitSha);
    if (pending === undefined) {
      pending = (async (): Promise<boolean> => {
        let tree: GitTreeEntry[];
        try {
          tree = await readGitTree(canonicalRoot, commitSha);
        } catch (error) {
          if (error instanceof GraphRepositoryError) {
            deps.logger(`history: commit ${commitSha} could not be listed for verification: ${error.message}`);
            return false;
          }
          throw error;
        }
        const blobs = new Map<string, GitTreeEntry>();
        for (const entry of tree) {
          if (entry.type === "blob") blobs.set(entry.path, entry);
        }
        for (const [relativePath, fileProof] of proof) {
          const entry = blobs.get(relativePath);
          if (entry?.sha === undefined || entry.mode === SYMLINK_MODE) return false;
          const expected = entry.sha.length === 64 ? fileProof.gitBlobSha256 : fileProof.gitBlobSha1;
          if (entry.sha.toLowerCase() !== expected) return false;
        }
        for (const [relativePath, entry] of blobs) {
          if (proof.has(relativePath)) continue;
          // A tracked path the index did not analyze is acceptable only when the
          // workspace rules exclude it by path or extension (independent of content).
          const decision = deps.policy.checkFile(
            canonicalRoot,
            path.resolve(canonicalRoot, relativePath),
            0,
          );
          if (entry.mode === SYMLINK_MODE && decision.allowed) return false;
          if (!isPathRuleExclusion(decision)) return false;
        }
        return true;
      })();
      verifiedCommits.set(commitSha, pending);
    }
    return pending;
  };

  const snapshotLookup: TimelineSnapshotLookup = async (commitSha, ref) => {
    const loaded = loadIndex();
    if (loaded === null || loaded.stale) return undefined;
    const proof = await loadDiskProof(loaded);
    if (!proof.ok) return undefined;
    if (!(await verifyCommit(commitSha, proof.files))) return undefined;
    addNote(
      `'${ref}' (commit ${commitSha.slice(0, 12)}) was read from the local index snapshot ${loaded.snapshotId}: the indexed files match that commit's content`,
    );
    return loaded.contentSet;
  };

  const reconstructFromGitTree: TimelineReconstructFromGitTree = async (_repoRoot, ref) => {
    if (ref !== WORKING_TREE_REF) return undefined;
    const loaded = loadIndex();
    if (loaded === null) return undefined;
    const proof = await loadDiskProof(loaded);
    const freshness = loaded.stale
      ? "; a newer index build is in progress"
      : !proof.ok && proof.changedFiles > 0
        ? `; ${String(proof.changedFiles)} indexed file(s) changed on disk since then, run causoryn_refresh_index for an up-to-date working-tree point`
        : "";
    addNote(
      `'${WORKING_TREE_REF}' was read from the local index snapshot ${loaded.snapshotId}, not from ${TIMELINE_SNAPSHOT_BLOB_PATH}${freshness}`,
    );
    return loaded.contentSet;
  };

  return { snapshotLookup, reconstructFromGitTree, notes: () => [...notes] };
}
