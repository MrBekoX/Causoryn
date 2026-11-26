/**
 * The git metadata check in git-repository-layout.ts runs before git starts,
 * so the git subprocess timeout does not bound it. Only read files count
 * toward MAX_SCANNED_FILES; every include entry, alternates line and path
 * component costs file system calls of its own (twice when a path is read
 * both ways). One validateRepositoryLayout call therefore has a total budget
 * of file system operations (lstat, readlink, realpath) and walks an
 * identically spelled path once.
 *
 * Operations are counted through a pass-through mock of node:fs/promises, not
 * measured by wall clock.
 */
import { execFile as execFileCallback } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GraphRepositoryError } from "../packages/graph/src/errors.js";
import {
  MAX_LAYOUT_FS_OPERATIONS,
  validateRepositoryLayout,
} from "../packages/graph/src/git-repository-layout.js";

const execFile = promisify(execFileCallback);

const counted = vi.hoisted(() => ({ files: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const lstat = async (file: import("node:fs").PathLike, options?: import("node:fs").StatOptions) => {
    counted.files.push(String(file));
    return actual.lstat(file, options);
  };
  const readlink = async (file: import("node:fs").PathLike, options?: unknown) => {
    counted.files.push(String(file));
    return actual.readlink(file, options as never);
  };
  const realpath = async (file: import("node:fs").PathLike, options?: unknown) => {
    counted.files.push(String(file));
    return actual.realpath(file, options as never);
  };
  return { ...actual, lstat, readlink, realpath };
});

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 120_000);
beforeEach(() => {
  counted.files.length = 0;
});

function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === "";
}

/** A minimal `.git` directory with objects/info. */
function fakeRepository(prefix: string): { readonly root: string; readonly gitDir: string } {
  const root = tempDir(prefix);
  const gitDir = path.join(root, ".git");
  mkdirSync(path.join(gitDir, "objects", "info"), { recursive: true });
  writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  return { root, gitDir };
}

async function rejection(action: () => Promise<unknown>): Promise<GraphRepositoryError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(GraphRepositoryError);
    return error as GraphRepositoryError;
  }
  throw new Error("expected a GraphRepositoryError rejection");
}

function includeConfig(paths: readonly string[]): string {
  return `[include]\n${paths.map((value) => `\tpath = ${value}\n`).join("")}`;
}

function expectBudgetRefusal(error: GraphRepositoryError): void {
  expect(error.code).toBe("compare/repository-refused");
  expect(error.message).toContain("file system operations");
  expect(error.message).toContain(String(MAX_LAYOUT_FS_OPERATIONS));
  // Fails closed at the limit: the operation over the budget is not made.
  expect(counted.files.length).toBeLessThanOrEqual(MAX_LAYOUT_FS_OPERATIONS);
}

async function plainGit(repo: string, args: readonly string[]): Promise<void> {
  await execFile("git", ["-C", repo, ...args], {
    shell: false,
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

/**
 * Each case below makes up to MAX_LAYOUT_FS_OPERATIONS real lstat calls; on a
 * loaded host that can take longer than the default test timeout.
 */
const BUDGET_CASE_TIMEOUT_MS = 120_000;

describe("git metadata check: total file system budget per call", () => {
  it("refuses a config whose include entries would need more operations than the budget", async () => {
    const { root, gitDir } = fakeRepository("causoryn-budget-includes-");
    const entries = Array.from({ length: MAX_LAYOUT_FS_OPERATIONS + 100 }, (_, index) => `m${String(index)}/x.cfg`);
    writeFileSync(path.join(gitDir, "config"), includeConfig(entries), "utf8");

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expectBudgetRefusal(error);
  }, BUDGET_CASE_TIMEOUT_MS);

  it("refuses alternates entries that would need more operations than the budget", async () => {
    const { root, gitDir } = fakeRepository("causoryn-budget-alternates-");
    const entries = Array.from({ length: MAX_LAYOUT_FS_OPERATIONS + 100 }, (_, index) => `../m${String(index)}`);
    writeFileSync(path.join(gitDir, "objects", "info", "alternates"), `${entries.join("\n")}\n`, "utf8");

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expectBudgetRefusal(error);
  }, BUDGET_CASE_TIMEOUT_MS);

  it("bounds the walk of a single path text with more components than the budget", async () => {
    const { root, gitDir } = fakeRepository("causoryn-budget-one-path-");
    mkdirSync(path.join(gitDir, "a"));
    const include = `${"a/../".repeat(MAX_LAYOUT_FS_OPERATIONS + 10)}x.cfg`;
    writeFileSync(path.join(gitDir, "config"), includeConfig([include]), "utf8");

    const error = await rejection(() => validateRepositoryLayout(root, "rev-parse"));

    expectBudgetRefusal(error);
  }, BUDGET_CASE_TIMEOUT_MS);
});

describe("git metadata check: an identically spelled path is walked once per call", () => {
  const copies = 2 * MAX_LAYOUT_FS_OPERATIONS;

  it("resolves a repeated include path once", async () => {
    const { root, gitDir } = fakeRepository("causoryn-budget-dedupe-include-");
    writeFileSync(path.join(gitDir, "config"), includeConfig(Array.from({ length: copies }, () => "nope/x.cfg")), "utf8");

    const layout = await validateRepositoryLayout(root, "rev-parse");

    expect(layout.kind).toBe("git-directory");
    expect(counted.files.filter((file) => samePath(file, path.join(gitDir, "nope")))).toHaveLength(1);
  });

  it("resolves a repeated alternates entry once", async () => {
    const { root, gitDir } = fakeRepository("causoryn-budget-dedupe-alternates-");
    const lines = Array.from({ length: copies }, () => "../nope");
    writeFileSync(path.join(gitDir, "objects", "info", "alternates"), `${lines.join("\n")}\n`, "utf8");

    const layout = await validateRepositoryLayout(root, "rev-parse");

    expect(layout.kind).toBe("git-directory");
    expect(counted.files.filter((file) => samePath(file, path.join(gitDir, "nope")))).toHaveLength(1);
  });
});

describe("git metadata check: real layouts stay far below the budget", () => {
  it("a checkout with an include and an alternate, and its linked worktree, use a small fraction of it", async () => {
    const holder = tempDir("causoryn-budget-real-");
    const main = path.join(holder, "main");
    mkdirSync(main);
    await plainGit(main, ["init", "-q", "-b", "main"]);
    await plainGit(main, ["config", "user.name", "Causoryn Test"]);
    await plainGit(main, ["config", "user.email", "test@causoryn.invalid"]);
    writeFileSync(path.join(main, "a.txt"), "a\n", "utf8");
    await plainGit(main, ["add", "-A"]);
    await plainGit(main, ["commit", "-q", "-m", "a"]);
    writeFileSync(path.join(main, ".git", "local.cfg"), "[user]\n\tname = Included\n", "utf8");
    await plainGit(main, ["config", "include.path", "local.cfg"]);
    mkdirSync(path.join(main, ".git", "extra-objects"));
    writeFileSync(path.join(main, ".git", "objects", "info", "alternates"), "../extra-objects\n", "utf8");
    const worktree = path.join(holder, "wt");
    await plainGit(main, ["worktree", "add", "-q", "-b", "feature", worktree]);

    for (const root of [main, worktree]) {
      counted.files.length = 0;
      await validateRepositoryLayout(root, "rev-parse");
      expect(counted.files.length).toBeGreaterThan(0);
      expect(counted.files.length).toBeLessThan(MAX_LAYOUT_FS_OPERATIONS / 20);
    }
  }, 60_000);
});
