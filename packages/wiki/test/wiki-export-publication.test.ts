/**
 * CAU-08 (CWE-367 / CWE-459) for the offline wiki export: every file is
 * published through a temp file the export creates itself (`wx`, default mode
 * 0o666 narrowed by the umask, unpredictable name), and the authorized output directory is bound to each
 * publication — replaced between authorization and rename → refused,
 * nothing written outside. Two exports to one directory do not interfere.
 *
 * Interleavings and directory swaps are injected through a pass-through mock
 * of node:fs, so they run on every platform.
 */
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OutputAccessPolicy } from "@causoryn/workspace";

import { WikiProjectionError } from "../src/errors.js";
import { WIKI_EXPORT_MARKDOWN_DIR_NAME, buildWikiExportFileSet, exportWikiOffline } from "../src/export.js";
import { WIKI_TEMPLATE_VERSION } from "../src/taxonomy.js";
import type { WikiProjection } from "../src/schema.js";

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
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `causoryn-wiki-publish-${label}-`)));
  created.push(dir);
  return dir;
}

function projection(revision: string): WikiProjection {
  return {
    snapshot: {
      id: `wiki:${revision}`,
      workspaceId: "ws_wiki_publication",
      graphSnapshotId: `snap:${revision}`,
      revisionRef: revision,
      status: "partial",
      builtAt: "2026-11-26T09:00:00.000Z",
      templateVersion: WIKI_TEMPLATE_VERSION,
    },
    pages: [],
    sections: [],
    warnings: [`fixture: ${revision}`],
  };
}

function listTree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((entry) => entry.split(path.sep).join("/")).sort();
}

describe("exportWikiOffline publication (CAU-08)", () => {
  it("creates every temp file exclusively, with the umask-narrowed default mode", () => {
    const outputDir = makeTempDir("temp-files");
    const policy = OutputAccessPolicy.create([outputDir]);
    const input = projection("rev-temp");

    const result = exportWikiOffline({ projection: input, outputDir }, policy);

    const temps = fsHooks.opened.filter((entry) => entry.file.endsWith(".tmp"));
    expect(temps).toHaveLength(result.files.length);
    for (const temp of temps) {
      expect(temp.flags).toBe("wx");
      // 0o666 minus the umask: the temp's mode becomes the published page's
      // mode, so a served wiki directory stays readable (0o644 under 022).
      expect(temp.mode).toBe(0o666);
    }
    expect(listTree(outputDir)).toEqual(
      [...buildWikiExportFileSet(input).map((file) => file.relativePath), WIKI_EXPORT_MARKDOWN_DIR_NAME].sort(),
    );
  });

  it("two exports into one directory interleaved at a rename both succeed", () => {
    const outputDir = makeTempDir("interleaved");
    const policy = OutputAccessPolicy.create([outputDir]);
    const first = projection("rev-first");
    const second = projection("rev-second");
    let secondFiles = 0;
    fsHooks.beforeRename = () => {
      secondFiles = exportWikiOffline({ projection: second, outputDir }, policy).files.length;
    };

    const result = exportWikiOffline({ projection: first, outputDir }, policy);

    expect(secondFiles).toBe(result.files.length);
    // The first export wrote every file after the second one finished.
    for (const file of buildWikiExportFileSet(first)) {
      expect(readFileSync(path.join(outputDir, file.relativePath), "utf8")).toBe(file.content);
    }
    expect(listTree(outputDir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses when the output directory is replaced by a link after authorization; nothing is written outside", () => {
    const outputDir = makeTempDir("swap");
    const outside = makeTempDir("swap-outside");
    const policy = OutputAccessPolicy.create([outputDir]);
    fsHooks.afterClose = () => {
      const moved = `${outputDir}-moved`;
      renameSync(outputDir, moved);
      created.push(moved);
      symlinkSync(outside, outputDir, process.platform === "win32" ? "junction" : "dir");
    };

    let thrown: unknown;
    try {
      exportWikiOffline({ projection: projection("rev-swap"), outputDir }, policy);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WikiProjectionError);
    expect((thrown as WikiProjectionError).code).toBe("wiki/output-path-denied");
    expect(readdirSync(outside)).toEqual([]);
  });
});
