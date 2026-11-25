/**
 * resolveSourceRevision path hardening: the gitdir pointer is checked for
 * containment and for network/device forms BEFORE any filesystem call on its
 * target; git metadata (HEAD, refs, packed-refs) is never read through a
 * symbolic link; quota notes do not echo exact file sizes.
 */
import { execFile as execFileCallback } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { touched } = vi.hoisted(() => ({ touched: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const record =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      if (typeof args[0] === "string") touched.push(args[0]);
      return fn(...args);
    };
  const wrapped = {
    ...actual,
    access: record(actual.access),
    lstat: record(actual.lstat),
    open: record(actual.open),
    opendir: record(actual.opendir),
    readFile: record(actual.readFile),
    readdir: record(actual.readdir),
    readlink: record(actual.readlink),
    realpath: record(actual.realpath),
    stat: record(actual.stat),
  };
  return { ...wrapped, default: wrapped };
});

const { resolveSourceRevision } = await import("../src/source-revision.js");

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile("git", ["-C", cwd, ...args], {
    shell: false,
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return result.stdout;
}

const createdDirs: string[] = [];
afterAll(() => {
  for (const dir of createdDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
beforeEach(() => {
  touched.length = 0;
});

function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  createdDirs.push(dir);
  return dir;
}

async function initRepo(prefix: string): Promise<{ root: string; head: string }> {
  const root = tempDir(prefix);
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.name", "Causoryn Preflight Test"]);
  await git(root, ["config", "user.email", "preflight-test@causoryn.invalid"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "baseline"]);
  return { root, head: (await git(root, ["rev-parse", "HEAD"])).trim().toLowerCase() };
}

function linkDirectory(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

/** Lower-cased, separator-normalized form for "was this path touched" checks. */
function normalized(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function touchedUnder(prefix: string): string[] {
  const candidates = new Set([normalized(prefix)]);
  try {
    candidates.add(normalized(realpathSync.native(prefix)));
  } catch {
    // prefix may not exist
  }
  return touched.filter((entry) => {
    const value = normalized(entry);
    return [...candidates].some((candidate) => value === candidate || value.startsWith(`${candidate}/`));
  });
}

describe("resolveSourceRevision: gitdir pointer checks happen before any access to the target", { timeout: 60_000 }, () => {
  for (const form of [
    "\\\\127.0.0.1\\causoryn-unused-share\\repo.git",
    "//127.0.0.1/causoryn-unused-share/repo.git",
    "\\\\?\\UNC\\127.0.0.1\\causoryn-unused-share\\repo.git",
    "\\??\\UNC\\127.0.0.1\\causoryn-unused-share\\repo.git",
  ]) {
    it(`a gitdir pointer naming a network or device path (${form}) is not accessed`, async () => {
      const root = tempDir("causoryn-preflight-unc-");
      writeFileSync(path.join(root, ".git"), `gitdir: ${form}\n`, "utf8");
      touched.length = 0;
      const resolution = await resolveSourceRevision(root);
      expect(touched.filter((entry) => entry.includes("127.0.0.1") || entry.includes("causoryn-unused"))).toEqual([]);
      expect(resolution.sourceRevision).toBeUndefined();
      expect(resolution.limitations.some((note) => note.includes("network or device path"))).toBe(true);
    });
  }

  it("a gitdir pointer outside the root is reported without touching the target", async () => {
    const other = await initRepo("causoryn-preflight-other-");
    const root = tempDir("causoryn-preflight-outside-");
    writeFileSync(path.join(root, ".git"), `gitdir: ${path.join(other.root, ".git")}\n`, "utf8");
    touched.length = 0;
    const resolution = await resolveSourceRevision(root);
    expect(touchedUnder(other.root)).toEqual([]);
    expect(resolution.sourceRevision).toBeUndefined();
    expect(resolution.limitations.some((note) => note.includes("outside the repository root"))).toBe(true);
  });

  it("a gitdir pointer that stays inside the root lexically but leaves it through a link is not followed", async () => {
    const other = await initRepo("causoryn-preflight-link-target-");
    const root = tempDir("causoryn-preflight-link-root-");
    linkDirectory(other.root, path.join(root, "vendor"));
    writeFileSync(path.join(root, ".git"), "gitdir: vendor/.git\n", "utf8");
    const resolution = await resolveSourceRevision(root);
    expect(resolution.sourceRevision).toBeUndefined();
    expect(resolution.limitations.some((note) => note.includes("symbolic link"))).toBe(true);
  });

  it("a .git entry that is a symbolic link or junction is not followed", async () => {
    const other = await initRepo("causoryn-preflight-dotgit-target-");
    const root = tempDir("causoryn-preflight-dotgit-link-");
    linkDirectory(path.join(other.root, ".git"), path.join(root, ".git"));
    const resolution = await resolveSourceRevision(root);
    expect(resolution.sourceRevision).toBeUndefined();
    expect(touchedUnder(path.join(other.root, ".git", "HEAD"))).toEqual([]);
  });
});

describe("resolveSourceRevision: git metadata is never read through a symbolic link", { timeout: 60_000 }, () => {
  it("a refs directory linked outside the root does not resolve HEAD", async () => {
    const { root } = await initRepo("causoryn-preflight-refs-link-");
    const outside = tempDir("causoryn-preflight-refs-outside-");
    const foreignSha = "1".repeat(40);
    mkdirSync(path.join(outside, "heads"), { recursive: true });
    writeFileSync(path.join(outside, "heads", "main"), `${foreignSha}\n`, "utf8");
    rmSync(path.join(root, ".git", "refs"), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    linkDirectory(outside, path.join(root, ".git", "refs"));
    // No packed-refs fallback either.
    rmSync(path.join(root, ".git", "packed-refs"), { force: true });

    const resolution = await resolveSourceRevision(root);
    expect(resolution.sourceRevision?.head).not.toBe(foreignSha);
    expect(resolution.sourceRevision).toBeUndefined();
    expect(resolution.limitations.some((note) => note.includes("symbolic link"))).toBe(true);
  });

  it("a packed-refs file that is a symbolic link is not read", async () => {
    const { root } = await initRepo("causoryn-preflight-packed-link-");
    const outside = tempDir("causoryn-preflight-packed-outside-");
    const foreignSha = "2".repeat(40);
    writeFileSync(path.join(outside, "packed-refs"), `${foreignSha} refs/heads/main\n`, "utf8");
    rmSync(path.join(root, ".git", "refs", "heads", "main"), { force: true });
    try {
      symlinkSync(path.join(outside, "packed-refs"), path.join(root, ".git", "packed-refs"), "file");
    } catch {
      return; // creating file symbolic links needs a privilege this account does not have
    }
    const resolution = await resolveSourceRevision(root);
    expect(resolution.sourceRevision).toBeUndefined();
  });

  it("a HEAD file that is a symbolic link is not read", async () => {
    const { root } = await initRepo("causoryn-preflight-head-link-");
    const outside = tempDir("causoryn-preflight-head-outside-");
    const foreignSha = "3".repeat(40);
    writeFileSync(path.join(outside, "HEAD"), `${foreignSha}\n`, "utf8");
    rmSync(path.join(root, ".git", "HEAD"), { force: true });
    try {
      symlinkSync(path.join(outside, "HEAD"), path.join(root, ".git", "HEAD"), "file");
    } catch {
      return;
    }
    const resolution = await resolveSourceRevision(root);
    expect(resolution.sourceRevision).toBeUndefined();
  });

  it("a regular repository and a gitdir pointer inside the root still resolve", async () => {
    const { root, head } = await initRepo("causoryn-preflight-regular-");
    expect((await resolveSourceRevision(root)).sourceRevision).toEqual({ kind: "working-tree", head });

    const separated = tempDir("causoryn-preflight-separated-");
    await git(separated, ["init", "-q", "-b", "main", `--separate-git-dir=${path.join(separated, "meta.git")}`]);
    await git(separated, ["config", "user.name", "Causoryn Preflight Test"]);
    await git(separated, ["config", "user.email", "preflight-test@causoryn.invalid"]);
    writeFileSync(path.join(separated, "a.ts"), "export const a = 1;\n", "utf8");
    await git(separated, ["add", "-A"]);
    await git(separated, ["commit", "-q", "-m", "baseline"]);
    const separatedHead = (await git(separated, ["rev-parse", "HEAD"])).trim().toLowerCase();
    expect((await resolveSourceRevision(separated)).sourceRevision).toEqual({ kind: "working-tree", head: separatedHead });
  });
});

describe("resolveSourceRevision: quota notes", { timeout: 60_000 }, () => {
  it("an oversized HEAD is reported against the 1 MiB limit without its exact size", async () => {
    const root = tempDir("causoryn-preflight-quota-");
    mkdirSync(path.join(root, ".git"), { recursive: true });
    const size = 1024 * 1024 + 65;
    writeFileSync(path.join(root, ".git", "HEAD"), "a".repeat(size), "utf8");
    const resolution = await resolveSourceRevision(root);
    expect(resolution.sourceRevision).toBeUndefined();
    const note = resolution.limitations.find((entry) => entry.includes(".git/HEAD"));
    expect(note).toBeDefined();
    expect(note).toContain("exceeds the size quota");
    expect(note).toContain("1 MiB");
    expect(note).not.toContain(String(size));
    expect(resolution.limitations.join("\n")).not.toMatch(/\d{6,}/);
  });
});
