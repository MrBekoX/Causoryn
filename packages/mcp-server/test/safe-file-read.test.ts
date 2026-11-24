import {
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readOptionalBoundedTextFile,
  readOptionalBoundedTextFileSync,
} from "../src/safe-file-read.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `causoryn-safe-read-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("safe-file-read — fd-based bounded optional text reader (async & sync)", () => {
  it("reads a regular UTF-8 file (including multi-byte characters) within maxBytes", async () => {
    const dir = createTempDir("ok");
    const filePath = path.join(dir, "policy.yaml");
    const content = "version: 1\n# Türkçe karakterler: ğüşıöç\nrules: []\n";
    writeFileSync(filePath, content, "utf8");
    const byteLen = Buffer.byteLength(content, "utf8");

    expect(await readOptionalBoundedTextFile(filePath, byteLen + 10)).toEqual({
      status: "ok",
      text: content,
    });
    expect(readOptionalBoundedTextFileSync(filePath, byteLen + 10)).toEqual({
      status: "ok",
      text: content,
    });
  });

  it("returns status 'missing' when file does not exist", async () => {
    const dir = createTempDir("missing");
    const missingPath = path.join(dir, "does-not-exist.yaml");

    expect(await readOptionalBoundedTextFile(missingPath, 1024)).toEqual({
      status: "missing",
    });
    expect(readOptionalBoundedTextFileSync(missingPath, 1024)).toEqual({
      status: "missing",
    });
  });

  it("returns status 'missing' when path points to a directory (no EISDIR throw or fd leak)", async () => {
    const dir = createTempDir("dir");
    const subDir = path.join(dir, "nested-dir");
    mkdirSync(subDir);

    expect(await readOptionalBoundedTextFile(subDir, 1024)).toEqual({
      status: "missing",
    });
    expect(readOptionalBoundedTextFileSync(subDir, 1024)).toEqual({
      status: "missing",
    });
  });

  it("accepts exact maxBytes boundary (including 0-byte empty file) and rejects maxBytes + 1", async () => {
    const dir = createTempDir("boundary");

    const emptyFile = path.join(dir, "empty.txt");
    writeFileSync(emptyFile, "", "utf8");
    expect(await readOptionalBoundedTextFile(emptyFile, 0)).toEqual({
      status: "ok",
      text: "",
    });
    expect(readOptionalBoundedTextFileSync(emptyFile, 0)).toEqual({
      status: "ok",
      text: "",
    });

    const exactFile = path.join(dir, "exact.txt");
    const exactContent = "ğ".repeat(16); // 32 UTF-8 bytes
    writeFileSync(exactFile, exactContent, "utf8");
    expect(Buffer.byteLength(exactContent, "utf8")).toBe(32);

    expect(await readOptionalBoundedTextFile(exactFile, 32)).toEqual({
      status: "ok",
      text: exactContent,
    });
    expect(readOptionalBoundedTextFileSync(exactFile, 32)).toEqual({
      status: "ok",
      text: exactContent,
    });

    const overByOneAsync = await readOptionalBoundedTextFile(exactFile, 31);
    expect(overByOneAsync).toEqual({
      status: "too-large",
      bytes: 32,
    });
    const overByOneSync = readOptionalBoundedTextFileSync(exactFile, 31);
    expect(overByOneSync).toEqual({
      status: "too-large",
      bytes: 32,
    });
  });

  it("reads multi-chunk files (>64 KiB) completely when within maxBytes and rejects when over", async () => {
    const dir = createTempDir("multichunk");
    const filePath = path.join(dir, "large.txt");
    const content = "abcdefgh".repeat(20_000); // 160,000 bytes (> 64 KiB chunk size)
    writeFileSync(filePath, content, "utf8");

    const asyncOk = await readOptionalBoundedTextFile(filePath, 160_000);
    expect(asyncOk.status).toBe("ok");
    if (asyncOk.status === "ok") {
      expect(asyncOk.text).toBe(content);
    }

    const syncOk = readOptionalBoundedTextFileSync(filePath, 160_000);
    expect(syncOk.status).toBe("ok");
    if (syncOk.status === "ok") {
      expect(syncOk.text).toBe(content);
    }

    expect(await readOptionalBoundedTextFile(filePath, 159_999)).toEqual({
      status: "too-large",
      bytes: 160_000,
    });
    expect(readOptionalBoundedTextFileSync(filePath, 159_999)).toEqual({
      status: "too-large",
      bytes: 160_000,
    });
  });

  it("rejects symlinks with status 'missing' on platforms supporting O_NOFOLLOW", async () => {
    if (!fsConstants.O_NOFOLLOW) {
      // Windows lacks O_NOFOLLOW; skip POSIX-only assertion.
      return;
    }
    const dir = createTempDir("symlink");
    const target = path.join(dir, "real.yaml");
    const link = path.join(dir, "link.yaml");
    writeFileSync(target, "version: 1\n", "utf8");
    try {
      symlinkSync(target, link, "file");
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === "EPERM") {
        return;
      }
      throw err;
    }

    expect(await readOptionalBoundedTextFile(link, 1024)).toEqual({
      status: "missing",
    });
    expect(readOptionalBoundedTextFileSync(link, 1024)).toEqual({
      status: "missing",
    });
  });
});
