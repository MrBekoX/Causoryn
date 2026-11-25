import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  constants as fsConstants,
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
  readOptionalBoundedTextFile,
  readOptionalBoundedTextFileSync,
} from "../src/safe-file-read.js";

const tempDirs: string[] = [];

/**
 * Temp directories are returned in canonical (realpath) form, mirroring the
 * production contract: callers join paths onto the realpath'd workspace root.
 * On macOS os.tmpdir() lives under the /var -> /private/var symlink and on
 * Windows CI it can be an 8.3 short path; the explicit `root` option tests
 * below cover non-canonical root spellings.
 */
function createTempDir(prefix: string): string {
  const dir = realpathSync.native(
    mkdtempSync(path.join(os.tmpdir(), `causoryn-safe-read-${prefix}-`)),
  );
  tempDirs.push(dir);
  return dir;
}

function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      removeDir(dir);
    }
  }
});

/** File symlinks need a privilege (or Developer Mode) on Windows. */
function probeFileSymlinkSupport(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), "causoryn-safe-read-probe-"));
  try {
    const target = path.join(dir, "target.txt");
    writeFileSync(target, "probe", "utf8");
    symlinkSync(target, path.join(dir, "link.txt"), "file");
    return true;
  } catch {
    return false;
  } finally {
    removeDir(dir);
  }
}

const FILE_SYMLINKS_SUPPORTED = probeFileSymlinkSupport();
const IS_WINDOWS = process.platform === "win32";

/**
 * Starts a helper process that, after `delayMs`, repeatedly opens the FIFO's
 * write end without blocking. A reader stuck in open(2) is released by it, so
 * a regression surfaces as a slow (failed timing assertion) call instead of a
 * hung test worker.
 */
function startFifoReleaser(fifoPath: string, delayMs: number): ChildProcess {
  const script = [
    "const fs = require('node:fs');",
    "const [fifo, delay] = process.argv.slice(1);",
    "setTimeout(() => setInterval(() => {",
    "  try { fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch {}",
    "}, 50), Number(delay));",
  ].join("\n");
  return spawn(process.execPath, ["-e", script, fifoPath, String(delayMs)], {
    stdio: "ignore",
    shell: false,
  });
}

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

describe("safe-file-read — workspace containment (symlinks, junctions, explicit root)", () => {
  const POLICY_DIR = ".causoryn";
  const POLICY_FILE = "architecture.rules.yaml";

  it("rejects a file reached through a symlinked or junction intermediate directory (every platform)", async () => {
    const workspace = createTempDir("ws");
    const outside = createTempDir("outside");
    writeFileSync(path.join(outside, POLICY_FILE), "outside: 1\n", "utf8");
    // "junction" is honoured on Windows (no privilege needed) and ignored on
    // POSIX, where a directory symlink is created instead.
    symlinkSync(outside, path.join(workspace, POLICY_DIR), "junction");
    const target = path.join(workspace, POLICY_DIR, POLICY_FILE);

    expect(await readOptionalBoundedTextFile(target, 1024)).toEqual({ status: "missing" });
    expect(readOptionalBoundedTextFileSync(target, 1024)).toEqual({ status: "missing" });
    expect(await readOptionalBoundedTextFile(target, 1024, { root: workspace })).toEqual({
      status: "missing",
    });
    expect(readOptionalBoundedTextFileSync(target, 1024, { root: workspace })).toEqual({
      status: "missing",
    });
  });

  it.skipIf(!FILE_SYMLINKS_SUPPORTED)(
    "rejects a final-component file symlink on every platform (including Windows)",
    async () => {
      const workspace = createTempDir("ws-file-link");
      const outside = createTempDir("outside-file-link");
      const outsideFile = path.join(outside, "secret.txt");
      writeFileSync(outsideFile, "outside content\n", "utf8");
      mkdirSync(path.join(workspace, POLICY_DIR));
      const link = path.join(workspace, POLICY_DIR, POLICY_FILE);
      symlinkSync(outsideFile, link, "file");

      expect(await readOptionalBoundedTextFile(link, 1024)).toEqual({ status: "missing" });
      expect(readOptionalBoundedTextFileSync(link, 1024)).toEqual({ status: "missing" });
      expect(await readOptionalBoundedTextFile(link, 1024, { root: workspace })).toEqual({
        status: "missing",
      });
      expect(readOptionalBoundedTextFileSync(link, 1024, { root: workspace })).toEqual({
        status: "missing",
      });
    },
  );

  it("with an explicit root, accepts canonical and aliased spellings of a root reached through a symlinked ancestor", async () => {
    // Models macOS (/var -> /private/var) and Windows 8.3 short paths: the
    // root's own ancestors may be symlinks; only segments below the
    // canonical root are checked, and containment compares canonical forms.
    const realRoot = createTempDir("real-root");
    const aliasParent = createTempDir("alias-parent");
    const aliasRoot = path.join(aliasParent, "alias-root");
    symlinkSync(realRoot, aliasRoot, "junction");
    mkdirSync(path.join(realRoot, POLICY_DIR));
    const content = "version: 1\nrules: []\n";
    writeFileSync(path.join(realRoot, POLICY_DIR, POLICY_FILE), content, "utf8");

    const combinations: ReadonlyArray<readonly [string, string]> = [
      [aliasRoot, path.join(aliasRoot, POLICY_DIR, POLICY_FILE)],
      [aliasRoot, path.join(realRoot, POLICY_DIR, POLICY_FILE)],
      [realRoot, path.join(aliasRoot, POLICY_DIR, POLICY_FILE)],
      [realRoot, path.join(realRoot, POLICY_DIR, POLICY_FILE)],
    ];
    for (const [root, target] of combinations) {
      expect(await readOptionalBoundedTextFile(target, 1024, { root })).toEqual({
        status: "ok",
        text: content,
      });
      expect(readOptionalBoundedTextFileSync(target, 1024, { root })).toEqual({
        status: "ok",
        text: content,
      });
    }
  });

  it("with an explicit root, rejects a sibling path, a '..' traversal and the root directory itself", async () => {
    const base = createTempDir("contain");
    const root = path.join(base, "workspace");
    const sibling = path.join(base, "sibling");
    mkdirSync(root);
    mkdirSync(sibling);
    const siblingFile = path.join(sibling, POLICY_FILE);
    writeFileSync(siblingFile, "sibling: 1\n", "utf8");

    const candidates = [
      siblingFile,
      // Unnormalised '..' segments must not slip past the containment check.
      `${root}${path.sep}..${path.sep}sibling${path.sep}${POLICY_FILE}`,
      root,
    ];
    for (const candidate of candidates) {
      expect(await readOptionalBoundedTextFile(candidate, 1024, { root })).toEqual({
        status: "missing",
      });
      expect(readOptionalBoundedTextFileSync(candidate, 1024, { root })).toEqual({
        status: "missing",
      });
    }
  });

  it("with a root that does not exist, every read is 'missing'", async () => {
    const base = createTempDir("no-root");
    const filePath = path.join(base, POLICY_FILE);
    writeFileSync(filePath, "a: 1\n", "utf8");
    const root = path.join(base, "does-not-exist");

    expect(await readOptionalBoundedTextFile(filePath, 1024, { root })).toEqual({
      status: "missing",
    });
    expect(readOptionalBoundedTextFileSync(filePath, 1024, { root })).toEqual({
      status: "missing",
    });
  });

  it("rejects a relative path even when it names an existing file", async () => {
    const dir = createTempDir("relative");
    const filePath = path.join(dir, POLICY_FILE);
    writeFileSync(filePath, "a: 1\n", "utf8");
    const relative = path.relative(process.cwd(), filePath);
    // Different drives on Windows yield an absolute path; the case is then
    // not applicable.
    if (path.isAbsolute(relative)) {
      return;
    }

    expect(await readOptionalBoundedTextFile(relative, 1024)).toEqual({ status: "missing" });
    expect(readOptionalBoundedTextFileSync(relative, 1024)).toEqual({ status: "missing" });
  });

  it("rejects a path containing a NUL byte without throwing", async () => {
    const dir = createTempDir("nul");
    const filePath = `${path.join(dir, POLICY_FILE)}\0.txt`;

    expect(await readOptionalBoundedTextFile(filePath, 1024)).toEqual({ status: "missing" });
    expect(readOptionalBoundedTextFileSync(filePath, 1024)).toEqual({ status: "missing" });
  });
});

describe("safe-file-read — non-regular files never block or get read", () => {
  it.skipIf(IS_WINDOWS)(
    "returns 'missing' for a FIFO immediately, without waiting for a writer (async & sync)",
    async () => {
      const dir = createTempDir("fifo");
      const fifoPath = path.join(dir, "architecture.rules.yaml");
      const made = spawnSync("mkfifo", [fifoPath], { shell: false });
      expect(made.status).toBe(0);
      const releaser = startFifoReleaser(fifoPath, 2_500);
      try {
        const asyncStart = performance.now();
        expect(await readOptionalBoundedTextFile(fifoPath, 1024)).toEqual({
          status: "missing",
        });
        expect(performance.now() - asyncStart).toBeLessThan(1_500);

        const syncStart = performance.now();
        expect(readOptionalBoundedTextFileSync(fifoPath, 1024)).toEqual({
          status: "missing",
        });
        expect(performance.now() - syncStart).toBeLessThan(1_500);
      } finally {
        releaser.kill();
      }
    },
    20_000,
  );

  it.skipIf(IS_WINDOWS)("returns 'missing' for a character device (/dev/null)", async () => {
    expect(await readOptionalBoundedTextFile("/dev/null", 1024)).toEqual({ status: "missing" });
    expect(readOptionalBoundedTextFileSync("/dev/null", 1024)).toEqual({ status: "missing" });
  });
});
