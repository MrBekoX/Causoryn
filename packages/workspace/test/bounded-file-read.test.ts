import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readBoundedTextFile,
  readBoundedTextFileSync,
  type BoundedFileReadOptions,
  type BoundedFileReadResult,
  type OpenedFileInfo,
} from "../src/index.js";

/**
 * Shared descriptor-based bounded reader (CAU-02 / CAU-05): regular files
 * inside the root are read through one descriptor whose identity matches the
 * verified path; everything else is refused without being read.
 */

const tempDirs: string[] = [];

/** Canonical temp directory (the production call pattern joins onto a realpath'd root). */
function createTempDir(label: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), `causoryn-bounded-read-${label}-`)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});

type Reader = (
  absolutePath: string,
  maxBytes: number,
  options?: BoundedFileReadOptions,
) => Promise<BoundedFileReadResult>;

const READERS: ReadonlyArray<readonly [string, Reader]> = [
  ["async", readBoundedTextFile],
  // async wrapper: a synchronous throw surfaces as a rejection, like the async variant.
  ["sync", async (absolutePath, maxBytes, options) => readBoundedTextFileSync(absolutePath, maxBytes, options)],
];

function identityOf(target: string): { readonly dev: bigint; readonly ino: bigint } {
  const stat = lstatSync(target, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

/** Opens the FIFO's write end after `delayMs`, so a blocked reader fails the timing assertion instead of hanging. */
function startFifoReleaser(fifoPath: string, delayMs: number): ChildProcess {
  const script = [
    "const fs = require('node:fs');",
    "const [fifo, delay] = process.argv.slice(1);",
    "setTimeout(() => setInterval(() => {",
    "  try { fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch {}",
    "}, 50), Number(delay));",
  ].join("\n");
  return spawn(process.execPath, ["-e", script, fifoPath, String(delayMs)], { stdio: "ignore", shell: false });
}

describe.each(READERS)("bounded-file-read (%s)", (_label, read) => {
  it("reads a regular UTF-8 file inside the root and reports its descriptor identity", async () => {
    const root = createTempDir("regular");
    mkdirSync(path.join(root, "src"));
    const file = path.join(root, "src", "app.ts");
    const text = "export const name = 'çğü';\n";
    writeFileSync(file, text, "utf8");

    expect(await read(file, 1024, { root })).toEqual({
      status: "ok",
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      identity: identityOf(file),
    });
    // Without a root every component from the filesystem root is verified.
    expect(await read(file, 1024)).toMatchObject({ status: "ok", text });
  });

  it("accepts a file of exactly maxBytes and rejects maxBytes + 1 as too-large", async () => {
    const root = createTempDir("boundary");
    const file = path.join(root, "exact.txt");
    const text = "ğ".repeat(16); // 32 UTF-8 bytes
    writeFileSync(file, text, "utf8");

    expect(await read(file, 32, { root })).toMatchObject({ status: "ok", text, bytes: 32 });
    expect(await read(file, 31, { root })).toEqual({ status: "too-large", bytes: 32 });

    const empty = path.join(root, "empty.txt");
    writeFileSync(empty, "", "utf8");
    expect(await read(empty, 0, { root })).toMatchObject({ status: "ok", text: "", bytes: 0 });
  });

  it("rejects a directory, the root itself and a missing file without reading", async () => {
    const root = createTempDir("non-regular");
    mkdirSync(path.join(root, "nested"));

    expect(await read(path.join(root, "nested"), 1024, { root })).toEqual({
      status: "rejected",
      reason: "not-regular-file",
    });
    expect(await read(root, 1024, { root })).toEqual({ status: "rejected", reason: "outside-root" });
    expect(await read(path.join(root, "missing.txt"), 1024, { root })).toEqual({
      status: "rejected",
      reason: "not-found",
    });
  });

  it("rejects a file reached through a junction/symlinked intermediate directory", async () => {
    const root = createTempDir("link-dir");
    const outside = createTempDir("link-dir-outside");
    writeFileSync(path.join(outside, "secret.txt"), "outside\n", "utf8");
    // "junction" needs no privilege on Windows and is ignored on POSIX (directory symlink).
    symlinkSync(outside, path.join(root, "linked"), "junction");
    const target = path.join(root, "linked", "secret.txt");

    expect(await read(target, 1024, { root })).toEqual({ status: "rejected", reason: "unsafe-component" });
    expect(await read(target, 1024)).toEqual({ status: "rejected", reason: "unsafe-component" });
  });

  it("rejects a sibling of the root and an unnormalised '..' traversal out of it", async () => {
    const base = createTempDir("contain");
    const root = path.join(base, "workspace");
    const sibling = path.join(base, "sibling");
    mkdirSync(root);
    mkdirSync(sibling);
    const siblingFile = path.join(sibling, "a.txt");
    writeFileSync(siblingFile, "sibling\n", "utf8");

    expect(await read(siblingFile, 1024, { root })).toEqual({ status: "rejected", reason: "outside-root" });
    expect(await read(`${root}${path.sep}..${path.sep}sibling${path.sep}a.txt`, 1024, { root })).toEqual({
      status: "rejected",
      reason: "outside-root",
    });
  });

  it("accepts a target spelled through an alias of the root (junction or symlink to the root)", async () => {
    const realRoot = createTempDir("alias-real");
    const aliasParent = createTempDir("alias-parent");
    const aliasRoot = path.join(aliasParent, "alias-root");
    symlinkSync(realRoot, aliasRoot, "junction");
    mkdirSync(path.join(realRoot, "cfg"));
    writeFileSync(path.join(realRoot, "cfg", "a.yaml"), "a: 1\n", "utf8");

    for (const [root, target] of [
      [aliasRoot, path.join(aliasRoot, "cfg", "a.yaml")],
      [aliasRoot, path.join(realRoot, "cfg", "a.yaml")],
      [realRoot, path.join(aliasRoot, "cfg", "a.yaml")],
      [realRoot, path.join(realRoot, "cfg", "a.yaml")],
    ] as const) {
      expect(await read(target, 1024, { root })).toMatchObject({ status: "ok", text: "a: 1\n" });
    }
  });

  it("refuses an outside link that leads into a directory below the root or away from the root", async () => {
    const root = createTempDir("alias-reject-root");
    const outside = createTempDir("alias-reject-outside");
    const elsewhere = createTempDir("alias-reject-elsewhere");
    mkdirSync(path.join(root, "sub"));
    writeFileSync(path.join(root, "sub", "f.txt"), "root\n", "utf8");
    writeFileSync(path.join(elsewhere, "f.txt"), "elsewhere\n", "utf8");
    symlinkSync(path.join(root, "sub"), path.join(outside, "into-sub"), "junction");
    symlinkSync(elsewhere, path.join(outside, "away"), "junction");

    expect(await read(path.join(outside, "into-sub", "f.txt"), 1024, { root })).toEqual({
      status: "rejected",
      reason: "unsafe-component",
    });
    expect(await read(path.join(outside, "away", "f.txt"), 1024, { root })).toEqual({
      status: "rejected",
      reason: "outside-root",
    });
  });

  it.skipIf(process.platform !== "win32")(
    "on Windows, accepts a root and a target spelled in a different letter case",
    async () => {
      const root = createTempDir("case");
      mkdirSync(path.join(root, "Cfg"));
      writeFileSync(path.join(root, "Cfg", "a.yaml"), "a: 1\n", "utf8");

      expect(await read(path.join(root, "Cfg", "a.yaml").toUpperCase(), 1024, { root: root.toLowerCase() })).toMatchObject(
        { status: "ok", text: "a: 1\n" },
      );
    },
  );

  it("hands the descriptor-verified byte count and identity to authorize, and drops content it refuses", async () => {
    const root = createTempDir("authorize");
    const file = path.join(root, "spec.yaml");
    writeFileSync(file, "openapi: 3.1.0\n", "utf8");
    const seen: OpenedFileInfo[] = [];

    expect(
      await read(file, 1024, {
        root,
        authorize: (opened) => {
          seen.push(opened);
          return false;
        },
      }),
    ).toEqual({ status: "rejected", reason: "not-authorized" });
    expect(seen).toEqual([{ bytes: 15, identity: identityOf(file) }]);

    expect(await read(file, 1024, { root, authorize: () => true })).toMatchObject({
      status: "ok",
      text: "openapi: 3.1.0\n",
    });
  });

  it("rejects relative, empty and NUL-containing paths and an unusable root without throwing", async () => {
    const root = createTempDir("invalid");
    const file = path.join(root, "a.txt");
    writeFileSync(file, "a\n", "utf8");

    for (const candidate of ["", "a.txt", `${file}\0.txt`]) {
      expect(await read(candidate, 1024, { root })).toEqual({ status: "rejected", reason: "invalid-path" });
    }
    expect(await read(file, 1024, { root: "relative-root" })).toEqual({
      status: "rejected",
      reason: "invalid-path",
    });
    expect(await read(file, 1024, { root: path.join(root, "does-not-exist") })).toEqual({
      status: "rejected",
      reason: "not-found",
    });
  });

  it("rejects a byte budget that is not a non-negative safe integer", async () => {
    const root = createTempDir("budget");
    const file = path.join(root, "a.txt");
    writeFileSync(file, "a\n", "utf8");
    for (const maxBytes of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      await expect(read(file, maxBytes, { root })).rejects.toThrow(RangeError);
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO immediately, without waiting for a writer",
    async () => {
      const root = createTempDir("fifo");
      const fifo = path.join(root, "pipe.yaml");
      expect(spawnSync("mkfifo", [fifo], { shell: false }).status).toBe(0);
      const releaser = startFifoReleaser(fifo, 2_500);
      try {
        const start = performance.now();
        expect(await read(fifo, 1024, { root })).toEqual({ status: "rejected", reason: "not-regular-file" });
        expect(performance.now() - start).toBeLessThan(1_500);
      } finally {
        releaser.kill();
      }
    },
    10_000,
  );
});
