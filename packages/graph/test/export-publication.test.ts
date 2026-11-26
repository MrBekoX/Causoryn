/**
 * CAU-08 (CWE-367 / CWE-459): writeDocumentation publishes through a temp
 * file it creates itself, so
 * - a pre-existing file named like the former fixed temp name (`<target>.tmp`)
 *   is never removed,
 * - two exports to the same target do not delete each other's temp file,
 * - the authorized output directory is bound to the publication: replaced
 *   between authorization and rename → refused, nothing written outside.
 *
 * Interleavings and directory swaps are injected through a pass-through mock
 * of node:fs, so they run on every platform.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSnapshot, type SnapshotGraph } from "@causoryn/domain";
import { OutputAccessPolicy } from "@causoryn/workspace";

import { GraphRepositoryError } from "../src/errors.js";
import { EXPORT_DEFAULT_FILE_NAMES, serializeDocumentation, writeDocumentation } from "../src/export.js";

const fsHooks = vi.hoisted(() => ({
  opened: [] as Array<{ readonly file: string; readonly flags: unknown; readonly mode: unknown }>,
  /** One-shot: runs after the next closeSync. */
  afterClose: undefined as undefined | (() => void),
  /** One-shot: runs before the next renameSync. */
  beforeRename: undefined as undefined | (() => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = (file: import("node:fs").PathLike, flags?: import("node:fs").OpenMode, mode?: import("node:fs").Mode | null) => {
    fsHooks.opened.push({ file: String(file), flags, mode });
    return actual.openSync(file, flags ?? "r", mode);
  };
  const closeSync = (fd: number) => {
    actual.closeSync(fd);
    const hook = fsHooks.afterClose;
    fsHooks.afterClose = undefined;
    hook?.();
  };
  const renameSync = (from: import("node:fs").PathLike, to: import("node:fs").PathLike) => {
    const hook = fsHooks.beforeRename;
    fsHooks.beforeRename = undefined;
    hook?.();
    actual.renameSync(from, to);
  };
  return { ...actual, openSync, closeSync, renameSync };
});

const created: string[] = [];
afterEach(() => {
  fsHooks.opened.length = 0;
  fsHooks.afterClose = undefined;
  fsHooks.beforeRename = undefined;
  for (const dir of created.splice(0).reverse()) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function makeTempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `causoryn-export-publish-${label}-`)));
  created.push(dir);
  return dir;
}

function graph(revision: string): SnapshotGraph {
  return createSnapshot({
    workspaceId: "ws_export_publication",
    revision: { id: revision, sequence: 1 },
    configHash: "confighash-export-publication",
    analyzerFingerprint: "typescript-adapter@0.1.0",
    state: "ready",
    createdAt: "2026-11-26T09:00:00.000Z",
    nodes: [
      {
        kind: "Module",
        qualifiedName: `app::${revision}`,
        language: "typescript",
        location: { relativePath: "src/index.ts", startLine: 1, endLine: 2, sourceHash: "sha256:src/index.ts:1" },
        attributes: {},
      },
    ],
    edges: [],
  });
}

function graphError(action: () => unknown): GraphRepositoryError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(GraphRepositoryError);
    return error as GraphRepositoryError;
  }
  throw new Error("expected a GraphRepositoryError");
}

const JSON_NAME = EXPORT_DEFAULT_FILE_NAMES.json;

describe("writeDocumentation publication (CAU-08)", () => {
  it("preserves a pre-existing file named like the former fixed temp name", () => {
    const outputDir = makeTempDir("foreign");
    const foreign = path.join(outputDir, `${JSON_NAME}.tmp`);
    writeFileSync(foreign, "FOREIGN-FILE", "utf8");
    const policy = OutputAccessPolicy.create([outputDir]);
    const snapshot = graph("rev-foreign");

    const result = writeDocumentation({ snapshot, format: "json", outputDir }, policy);

    expect(readFileSync(foreign, "utf8")).toBe("FOREIGN-FILE");
    expect(readFileSync(result.path, "utf8")).toBe(serializeDocumentation(snapshot, "json"));
    expect(readdirSync(outputDir).sort()).toEqual([JSON_NAME, `${JSON_NAME}.tmp`].sort());
  });

  it("creates its temp file exclusively, with the umask-narrowed default mode, under an unpredictable name", () => {
    const outputDir = makeTempDir("temp-file");
    const policy = OutputAccessPolicy.create([outputDir]);

    writeDocumentation({ snapshot: graph("rev-temp"), format: "json", outputDir }, policy);

    const temps = fsHooks.opened.filter((entry) => path.relative(outputDir, path.dirname(entry.file)) === "");
    expect(temps).toHaveLength(1);
    expect(temps[0]!.flags).toBe("wx");
    // 0o666 minus the umask (0o644 under 022), like any file the process
    // writes: the temp's mode becomes the published export's mode, and an
    // owner-only export would be unreadable in a shared or served directory.
    expect(temps[0]!.mode).toBe(0o666);
    expect(path.basename(temps[0]!.file)).not.toBe(`${JSON_NAME}.tmp`);
    expect(readdirSync(outputDir)).toEqual([JSON_NAME]);
  });

  it("two exports to the same target interleaved at the rename both succeed", () => {
    const outputDir = makeTempDir("interleaved");
    const policy = OutputAccessPolicy.create([outputDir]);
    const first = graph("rev-first");
    const second = graph("rev-second");
    let secondPath: string | undefined;
    fsHooks.beforeRename = () => {
      secondPath = writeDocumentation({ snapshot: second, format: "json", outputDir }, policy).path;
    };

    const result = writeDocumentation({ snapshot: first, format: "json", outputDir }, policy);

    expect(secondPath).toBe(result.path);
    // The first export renamed last; neither export lost its temp file.
    expect(readFileSync(result.path, "utf8")).toBe(serializeDocumentation(first, "json"));
    expect(readdirSync(outputDir)).toEqual([JSON_NAME]);
  });

  it("refuses when the output directory is replaced by a link after authorization; nothing is written outside", () => {
    const outputDir = makeTempDir("swap");
    const outside = makeTempDir("swap-outside");
    const policy = OutputAccessPolicy.create([outputDir]);
    let moved: string | undefined;
    fsHooks.afterClose = () => {
      moved = `${outputDir}-moved`;
      renameSync(outputDir, moved);
      created.push(moved);
      symlinkSync(outside, outputDir, process.platform === "win32" ? "junction" : "dir");
    };

    const error = graphError(() => writeDocumentation({ snapshot: graph("rev-swap"), format: "json", outputDir }, policy));

    expect(error.code).toBe("export/output-path-denied");
    expect(moved).toBeDefined();
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(path.join(moved!, JSON_NAME))).toBe(false);
  });
});
