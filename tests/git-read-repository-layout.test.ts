/**
 * git-read: the repository read is the one at the analyzed root.
 * - No upward discovery: a root without its own working .git never reads a
 *   parent repository (GIT_CEILING_DIRECTORIES).
 * - A `.git` file may only point inside the root, or to a genuine linked
 *   worktree / submodule git directory that points back to this root.
 * - Network (UNC) and device paths in the gitdir pointer, commondir,
 *   alternates, config include paths and core.worktree are refused before
 *   git is started; a symbolic-link `.git` entry is not followed.
 * - Alternate object stores (nested ones included) must lie inside the
 *   analyzed root, its git directory or its common directory (CAU-06).
 */
import { execFile as execFileCallback } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GraphRepositoryError } from "../packages/graph/src/errors.js";
import {
  defaultGitProcessRunner,
  readGitBlob,
  readGitTree,
  resetGitRuntimeCachesForTesting,
  resolveGitCommitRef,
  setGitProcessRunnerForTesting,
} from "../packages/graph/src/git-read.js";

const execFile = promisify(execFileCallback);

async function plainGit(repo: string, args: readonly string[]): Promise<string> {
  const res = await execFile("git", ["-C", repo, ...args], {
    shell: false,
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return res.stdout;
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

const cleanup: string[] = [];
// Removing a few dozen fixture repositories can exceed the default 10 s hook
// timeout on a loaded machine.
afterAll(() => {
  for (const dir of cleanup) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);
afterEach(() => {
  setGitProcessRunnerForTesting(undefined);
  resetGitRuntimeCachesForTesting();
});

function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

async function initRepo(repo: string, file: string, content: string): Promise<string> {
  mkdirSync(repo, { recursive: true });
  await plainGit(repo, ["init", "-q", "-b", "main"]);
  await plainGit(repo, ["config", "user.name", "Causoryn Test"]);
  await plainGit(repo, ["config", "user.email", "test@causoryn.invalid"]);
  await plainGit(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(repo, file), content, "utf8");
  await plainGit(repo, ["add", "-A"]);
  await plainGit(repo, ["commit", "-q", "-m", `add ${file}`]);
  return (await plainGit(repo, ["rev-parse", "HEAD"])).trim();
}

/**
 * Records every repository-bound git call (`-C <root>`) and refuses to run it,
 * so a check that must happen before git starts can be observed without any
 * network or filesystem side effect. Calls without `-C` (version probe,
 * user safe.directory read) still run.
 */
function blockRepositoryBoundGit(): Array<readonly string[]> {
  const calls: Array<readonly string[]> = [];
  setGitProcessRunnerForTesting((file, args, options) => {
    if (args.includes("-C")) {
      calls.push(args);
      return Promise.reject(Object.assign(new Error("repository-bound git blocked by test"), {
        code: 128,
        stderr: "repository-bound git blocked by test",
      }));
    }
    return defaultGitProcessRunner(file, args, options);
  });
  return calls;
}

/** Directory link that needs no special privilege on Windows (junction). */
function linkDirectory(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

const NETWORK_AND_DEVICE_FORMS: readonly string[] = [
  "\\\\127.0.0.1\\causoryn-unused-share\\repo.git",
  "//127.0.0.1/causoryn-unused-share/repo.git",
  "\\\\?\\UNC\\127.0.0.1\\causoryn-unused-share\\repo.git",
  "\\\\.\\pipe\\causoryn-unused",
  "\\??\\UNC\\127.0.0.1\\causoryn-unused-share\\repo.git",
  "/??/UNC/127.0.0.1/causoryn-unused-share/repo.git",
];

describe("git-read: no repository above the analyzed root is read", () => {
  let parent: string;
  beforeAll(async () => {
    parent = tempDir("causoryn-git-parent-");
    await initRepo(parent, "parent-secret.txt", "parent\n");
    mkdirSync(path.join(parent, "workspace"), { recursive: true });
    writeFileSync(path.join(parent, "workspace", "app.ts"), "export {};\n", "utf8");
  }, 60_000);

  it("a root without a .git entry does not fall back to the enclosing repository", async () => {
    const root = path.join(parent, "workspace");
    const tree = await rejection(() => readGitTree(root, "HEAD"));
    expect(tree.code).toBe("compare/ref-not-found");
    expect(tree.message).toContain("not a git repository");
    expect((await rejection(() => resolveGitCommitRef(root, "HEAD"))).code).toBe("compare/ref-not-found");
    expect((await rejection(() => readGitBlob(root, "HEAD", "parent-secret.txt"))).code).toBe("compare/blob-not-found");
  }, 60_000);

  it("a root whose .git directory is not a git directory does not fall back to the enclosing repository", async () => {
    const root = path.join(parent, "empty-dot-git");
    mkdirSync(path.join(root, ".git"), { recursive: true });
    const error = await rejection(() => readGitTree(root, "HEAD"));
    expect(error.code).toBe("compare/ref-not-found");
    expect((await rejection(() => readGitBlob(root, "HEAD", "parent-secret.txt"))).code).toBe("compare/blob-not-found");
  }, 60_000);
});

describe("git-read: .git file redirection", () => {
  it("rejects a .git file whose gitdir points to another repository outside the analyzed root", async () => {
    const other = tempDir("causoryn-git-other-");
    await initRepo(other, "other-secret.txt", "secret\n");
    const root = tempDir("causoryn-git-redirect-");
    writeFileSync(path.join(root, ".git"), `gitdir: ${path.join(other, ".git")}\n`, "utf8");
    const error = await rejection(() => readGitTree(root, "HEAD"));
    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("outside the analyzed root");
    expect((await rejection(() => readGitBlob(root, "HEAD", "other-secret.txt"))).code).toBe("compare/repository-refused");
  }, 60_000);

  it("rejects a .git file that names a linked worktree git dir registered for a different directory", async () => {
    const main = tempDir("causoryn-git-main-");
    await initRepo(main, "main.txt", "main\n");
    const holder = tempDir("causoryn-git-wt-holder-");
    const worktree = path.join(holder, "wt");
    await plainGit(main, ["worktree", "add", "-q", "-b", "feature", worktree]);
    const worktreeGitDir = path.join(main, ".git", "worktrees", "wt");
    const root = tempDir("causoryn-git-wt-unrelated-");
    writeFileSync(path.join(root, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");
    const error = await rejection(() => readGitTree(root, "HEAD"));
    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("outside the analyzed root");
  }, 60_000);

  for (const form of NETWORK_AND_DEVICE_FORMS) {
    it(`rejects a .git file whose gitdir names a network or device path (${form}) before git starts`, async () => {
      const root = tempDir("causoryn-git-unc-gitdir-");
      writeFileSync(path.join(root, ".git"), `gitdir: ${form}\n`, "utf8");
      const calls = blockRepositoryBoundGit();
      const error = await rejection(() => readGitTree(root, "HEAD"));
      expect(error.code).toBe("compare/repository-refused");
      expect(error.message).toContain("network or device path");
      expect(calls).toEqual([]);
    }, 60_000);
  }

  it("does not follow a .git entry that is a symbolic link or junction", async () => {
    const other = tempDir("causoryn-git-link-target-");
    await initRepo(other, "linked-secret.txt", "secret\n");
    const root = tempDir("causoryn-git-link-root-");
    linkDirectory(path.join(other, ".git"), path.join(root, ".git"));
    const calls = blockRepositoryBoundGit();
    const error = await rejection(() => readGitTree(root, "HEAD"));
    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("symbolic link");
    expect(calls).toEqual([]);
  }, 60_000);

  it("rejects a .git file pointing inside the root through a link that leaves the root", async () => {
    const other = tempDir("causoryn-git-inner-link-target-");
    await initRepo(other, "linked-secret.txt", "secret\n");
    const root = tempDir("causoryn-git-inner-link-root-");
    linkDirectory(other, path.join(root, "vendor"));
    writeFileSync(path.join(root, ".git"), "gitdir: vendor/.git\n", "utf8");
    const error = await rejection(() => readGitTree(root, "HEAD"));
    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("outside the analyzed root");
  }, 60_000);
});

describe("git-read: linked worktrees and submodules keep working", () => {
  it("reads a linked worktree created with git worktree add", async () => {
    const main = tempDir("causoryn-git-wt-main-");
    const mainHead = await initRepo(main, "main.txt", "main\n");
    const holder = tempDir("causoryn-git-wt-");
    const worktree = path.join(holder, "feature-wt");
    await plainGit(main, ["worktree", "add", "-q", "-b", "feature", worktree]);
    writeFileSync(path.join(worktree, "feature.txt"), "feature\n", "utf8");
    await plainGit(worktree, ["add", "-A"]);
    await plainGit(worktree, ["commit", "-q", "-m", "feature work"]);
    const worktreeHead = (await plainGit(worktree, ["rev-parse", "HEAD"])).trim();

    expect(await resolveGitCommitRef(worktree, "HEAD")).toBe(worktreeHead);
    expect(await resolveGitCommitRef(worktree, "main")).toBe(mainHead);
    expect((await readGitTree(worktree, "HEAD")).map((entry) => entry.path)).toEqual(["feature.txt", "main.txt"]);
    expect(await readGitBlob(worktree, "HEAD", "feature.txt")).toBe("feature\n");
    // The main checkout still reads its own HEAD.
    expect(await resolveGitCommitRef(main, "HEAD")).toBe(mainHead);
  }, 60_000);

  it("reads a linked worktree that git records with relative paths (git >= 2.48)", async () => {
    const main = tempDir("causoryn-git-wt-rel-main-");
    const mainHead = await initRepo(main, "main.txt", "main\n");
    const holder = tempDir("causoryn-git-wt-rel-");
    const worktree = path.join(holder, "rel-wt");
    try {
      await plainGit(main, ["worktree", "add", "-q", "--relative-paths", "-b", "rel", worktree]);
    } catch {
      return; // git without --relative-paths: layout not producible here
    }
    expect(await resolveGitCommitRef(worktree, "HEAD")).toBe(mainHead);
    expect(await readGitBlob(worktree, "HEAD", "main.txt")).toBe("main\n");
  }, 60_000);

  it("reads a submodule checkout whose git dir lives in the superproject", async () => {
    const library = tempDir("causoryn-git-sub-lib-");
    const libraryHead = await initRepo(library, "lib.txt", "lib\n");
    const superproject = tempDir("causoryn-git-super-");
    await initRepo(superproject, "super.txt", "super\n");
    await plainGit(superproject, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      pathToFileURL(library).href,
      "libs/lib",
    ]);
    await plainGit(superproject, ["commit", "-q", "-m", "add submodule"]);
    const submoduleRoot = path.join(superproject, "libs", "lib");
    expect(await resolveGitCommitRef(submoduleRoot, "HEAD")).toBe(libraryHead);
    expect(await readGitBlob(submoduleRoot, "HEAD", "lib.txt")).toBe("lib\n");
    // The superproject reads its own tree (gitlink entry for the submodule).
    const superTree = await readGitTree(superproject, "HEAD");
    expect(superTree.map((entry) => [entry.path, entry.type])).toEqual([
      [".gitmodules", "blob"],
      ["libs/lib", "commit"],
      ["super.txt", "blob"],
    ]);
  }, 60_000);
});

describe("git-read: network and device paths inside the git directory are refused before git starts", () => {
  async function repoWith(mutate: (gitDir: string) => void): Promise<string> {
    const root = tempDir("causoryn-git-unc-meta-");
    await initRepo(root, "a.txt", "a\n");
    mutate(path.join(root, ".git"));
    return root;
  }

  const unc = "\\\\127.0.0.1\\causoryn-unused-share\\x";
  const cases: ReadonlyArray<[string, (gitDir: string) => void]> = [
    ["commondir", (gitDir) => writeFileSync(path.join(gitDir, "commondir"), `${unc}\n`, "utf8")],
    [
      "objects/info/alternates",
      (gitDir) => {
        mkdirSync(path.join(gitDir, "objects", "info"), { recursive: true });
        writeFileSync(path.join(gitDir, "objects", "info", "alternates"), `${unc}\\objects\n`, "utf8");
      },
    ],
    [
      "quoted alternates entry",
      (gitDir) => {
        mkdirSync(path.join(gitDir, "objects", "info"), { recursive: true });
        writeFileSync(
          path.join(gitDir, "objects", "info", "alternates"),
          `"${unc.replace(/\\/g, "\\\\")}\\\\objects"\n`,
          "utf8",
        );
      },
    ],
    [
      "include.path",
      (gitDir) => writeFileSync(path.join(gitDir, "config"), `[core]\n\tbare = false\n[include]\n\tpath = //127.0.0.1/causoryn-unused-share/cfg\n`, "utf8"),
    ],
    [
      "includeIf path (quoted, same line as the section header)",
      (gitDir) =>
        writeFileSync(
          path.join(gitDir, "config"),
          `[core]\n\tbare = false\n[includeIf "gitdir:**"] path = "${unc.replace(/\\/g, "\\\\")}"\n`,
          "utf8",
        ),
    ],
    [
      "core.worktree",
      (gitDir) => writeFileSync(path.join(gitDir, "config"), `[core]\n\tbare = false\n\tworktree = //127.0.0.1/causoryn-unused-share/w\n`, "utf8"),
    ],
  ];

  for (const [label, mutate] of cases) {
    it(`refuses a network path in ${label}`, async () => {
      const root = await repoWith(mutate);
      const calls = blockRepositoryBoundGit();
      const error = await rejection(() => resolveGitCommitRef(root, "HEAD"));
      expect(error.code).toBe("compare/repository-refused");
      expect(error.message).toContain("network or device path");
      expect(calls).toEqual([]);
    }, 60_000);
  }

  it("refuses a nested include that names a network path", async () => {
    const root = await repoWith((gitDir) => {
      writeFileSync(path.join(gitDir, "extra.cfg"), "[include]\n\tpath = //127.0.0.1/causoryn-unused-share/cfg\n", "utf8");
      writeFileSync(path.join(gitDir, "config"), "[core]\n\tbare = false\n[include]\n\tpath = extra.cfg\n", "utf8");
    });
    const calls = blockRepositoryBoundGit();
    const error = await rejection(() => readGitTree(root, "HEAD"));
    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("network or device path");
    expect(calls).toEqual([]);
  }, 60_000);

  it("refuses a symbolic link inside the git directory that points to a network path", async () => {
    const root = await repoWith(() => undefined);
    const refs = path.join(root, ".git", "refs");
    rmSync(refs, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    try {
      symlinkSync(process.platform === "win32" ? "\\\\127.0.0.1\\causoryn-unused-share\\refs" : "//127.0.0.1/causoryn-unused-share/refs", refs, "dir");
    } catch {
      return; // creating symbolic links needs a privilege this account does not have
    }
    const calls = blockRepositoryBoundGit();
    const error = await rejection(() => readGitTree(root, "HEAD"));
    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("network or device path");
    expect(calls).toEqual([]);
  }, 60_000);

  // The local include half of the former "local alternates and includes"
  // test; its alternates half pointed at an object store in another directory
  // and now lives in the CAU-06 block below as a refusal.
  it("a regular repository with a local config include still reads", async () => {
    const root = tempDir("causoryn-git-include-root-");
    const head = await initRepo(root, "a.txt", "a\n");
    writeFileSync(path.join(root, ".git", "local.cfg"), "[user]\n\tname = Included\n", "utf8");
    await plainGit(root, ["config", "include.path", "local.cfg"]);
    expect(await resolveGitCommitRef(root, "HEAD")).toBe(head);
    expect(await readGitBlob(root, "HEAD", "a.txt")).toBe("a\n");
  }, 60_000);
});

/**
 * CAU-06 (CWE-668): objects/info/alternates lets git read objects from
 * another object store. Every alternate object directory (nested alternates
 * included) must resolve inside the analyzed root, its git directory or its
 * common directory; anything else is refused before git starts.
 */
describe("git-read: alternates stay inside the repository (CAU-06)", () => {
  function writeAlternates(objectsDir: string, lines: readonly string[]): void {
    mkdirSync(path.join(objectsDir, "info"), { recursive: true });
    writeFileSync(path.join(objectsDir, "info", "alternates"), `${lines.join("\n")}\n`, "utf8");
  }

  async function referenceRepo(prefix: string): Promise<{ readonly dir: string; readonly head: string }> {
    const dir = tempDir(prefix);
    const head = await initRepo(dir, "ref.txt", "ref\n");
    return { dir, head };
  }

  async function expectAlternatesRefused(root: string): Promise<void> {
    const calls = blockRepositoryBoundGit();
    const error = await rejection(() => resolveGitCommitRef(root, "HEAD"));
    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("objects/info/alternates");
    expect(error.message).toContain("outside the repository");
    expect(calls).toEqual([]);
  }

  // Replaces the former acceptance of an alternate in another directory
  // ("a regular repository with local alternates and includes still reads"):
  // CAU-06 requires that such an object store is no longer used.
  it("refuses an alternates entry that names an object store in another directory", async () => {
    const reference = await referenceRepo("causoryn-git-alt-ref-");
    const root = tempDir("causoryn-git-alt-root-");
    await initRepo(root, "a.txt", "a\n");
    writeAlternates(path.join(root, ".git", "objects"), [path.join(reference.dir, ".git", "objects")]);
    await expectAlternatesRefused(root);
    expect((await rejection(() => readGitBlob(root, reference.head, "ref.txt"))).code).toBe("compare/repository-refused");
  }, 60_000);

  it("refuses a relative alternates entry that climbs out of the repository", async () => {
    const holder = tempDir("causoryn-git-alt-rel-");
    const reference = path.join(holder, "reference");
    await initRepo(reference, "ref.txt", "ref\n");
    const root = path.join(holder, "root");
    await initRepo(root, "a.txt", "a\n");
    // Relative alternates resolve against <root>/.git/objects.
    writeAlternates(path.join(root, ".git", "objects"), ["../../../reference/.git/objects"]);
    await expectAlternatesRefused(root);
  }, 60_000);

  it("refuses an outside alternates entry that does not exist yet", async () => {
    const outside = tempDir("causoryn-git-alt-missing-");
    const root = tempDir("causoryn-git-alt-missing-root-");
    await initRepo(root, "a.txt", "a\n");
    writeAlternates(path.join(root, ".git", "objects"), [path.join(outside, "later", "objects")]);
    await expectAlternatesRefused(root);
  }, 60_000);

  it("refuses an alternates entry inside the root that leaves it through a link", async () => {
    const reference = await referenceRepo("causoryn-git-alt-link-ref-");
    const root = tempDir("causoryn-git-alt-link-root-");
    await initRepo(root, "a.txt", "a\n");
    linkDirectory(path.join(reference.dir, ".git"), path.join(root, "linked-store"));
    writeAlternates(path.join(root, ".git", "objects"), [path.join(root, "linked-store", "objects")]);
    await expectAlternatesRefused(root);
  }, 60_000);

  it("refuses a nested alternates entry that leaves the repository", async () => {
    const reference = await referenceRepo("causoryn-git-alt-nested-ref-");
    const root = tempDir("causoryn-git-alt-nested-root-");
    await initRepo(root, "a.txt", "a\n");
    const inner = path.join(root, ".git", "inner-objects");
    mkdirSync(inner, { recursive: true });
    writeAlternates(inner, [path.join(reference.dir, ".git", "objects")]);
    writeAlternates(path.join(root, ".git", "objects"), ["../inner-objects"]);
    await expectAlternatesRefused(root);
  }, 60_000);

  // git resolves a relative alternates entry against the real objects
  // directory. When objects is a link to a shallower directory inside the
  // root, the lexical spelling stays inside the root while git's resolution
  // climbs out of it; the check must judge the location git will use.
  it("resolves a relative alternates entry against the real objects directory, as git does", async () => {
    const holder = tempDir("causoryn-git-alt-reallink-");
    const reference = path.join(holder, "reference");
    await initRepo(reference, "ref.txt", "ref\n");
    const root = path.join(holder, "root");
    await initRepo(root, "a.txt", "a\n");
    const store = path.join(root, "objstore");
    cpSync(path.join(root, ".git", "objects"), store, { recursive: true });
    rmSync(path.join(root, ".git", "objects"), { recursive: true, force: true });
    linkDirectory(store, path.join(root, ".git", "objects"));
    // Lexically <root>/.git/objects/../../reference = <root>/reference (inside);
    // git uses <root>/objstore/../../reference = <holder>/reference (outside).
    writeAlternates(store, ["../../reference/.git/objects"]);
    await expectAlternatesRefused(root);
  }, 60_000);

  it("refuses an objects directory that is a link to an object store outside the repository", async () => {
    const holder = tempDir("causoryn-git-objects-link-");
    const root = path.join(holder, "root");
    await initRepo(root, "a.txt", "a\n");
    const outsideStore = path.join(holder, "outside-objects");
    cpSync(path.join(root, ".git", "objects"), outsideStore, { recursive: true });
    rmSync(path.join(root, ".git", "objects"), { recursive: true, force: true });
    linkDirectory(outsideStore, path.join(root, ".git", "objects"));
    const calls = blockRepositoryBoundGit();
    const error = await rejection(() => resolveGitCommitRef(root, "HEAD"));
    expect(error.code).toBe("compare/repository-refused");
    expect(error.message).toContain("objects directory");
    expect(error.message).toContain("outside the repository");
    expect(calls).toEqual([]);
  }, 60_000);

  it("still reads a repository whose objects directory is a link inside its git directory", async () => {
    const root = tempDir("causoryn-git-objects-inner-link-");
    await initRepo(root, "a.txt", "a\n");
    const store = path.join(root, ".git", "objects-store");
    cpSync(path.join(root, ".git", "objects"), store, { recursive: true });
    rmSync(path.join(root, ".git", "objects"), { recursive: true, force: true });
    linkDirectory(store, path.join(root, ".git", "objects"));
    expect(await readGitBlob(root, "HEAD", "a.txt")).toBe("a\n");
  }, 60_000);

  it("still reads objects reachable only through an alternate inside the git directory", async () => {
    const reference = await referenceRepo("causoryn-git-alt-inside-ref-");
    const root = tempDir("causoryn-git-alt-inside-root-");
    await initRepo(root, "a.txt", "a\n");
    cpSync(path.join(reference.dir, ".git", "objects"), path.join(root, ".git", "ref-objects"), { recursive: true });
    writeAlternates(path.join(root, ".git", "objects"), ["../ref-objects"]);
    expect(await resolveGitCommitRef(root, reference.head)).toBe(reference.head);
    expect(await readGitBlob(root, reference.head, "ref.txt")).toBe("ref\n");
  }, 60_000);

  it("a linked worktree still reads an alternate inside its common directory", async () => {
    const reference = await referenceRepo("causoryn-git-alt-wt-ref-");
    const main = tempDir("causoryn-git-alt-wt-main-");
    await initRepo(main, "main.txt", "main\n");
    cpSync(path.join(reference.dir, ".git", "objects"), path.join(main, ".git", "ref-objects"), { recursive: true });
    writeAlternates(path.join(main, ".git", "objects"), [path.join(main, ".git", "ref-objects")]);
    const holder = tempDir("causoryn-git-alt-wt-");
    const worktree = path.join(holder, "wt");
    await plainGit(main, ["worktree", "add", "-q", "-b", "feature", worktree]);
    expect(await readGitBlob(worktree, reference.head, "ref.txt")).toBe("ref\n");
    expect(await readGitBlob(worktree, "HEAD", "main.txt")).toBe("main\n");
  }, 60_000);

  it("refuses a linked worktree whose common directory has an alternate outside the repository", async () => {
    const reference = await referenceRepo("causoryn-git-alt-wt-out-ref-");
    const main = tempDir("causoryn-git-alt-wt-out-main-");
    await initRepo(main, "main.txt", "main\n");
    const holder = tempDir("causoryn-git-alt-wt-out-");
    const worktree = path.join(holder, "wt");
    await plainGit(main, ["worktree", "add", "-q", "-b", "feature", worktree]);
    writeAlternates(path.join(main, ".git", "objects"), [path.join(reference.dir, ".git", "objects")]);
    await expectAlternatesRefused(worktree);
  }, 60_000);

  it("refuses a submodule git directory whose alternates leave the submodule's repository", async () => {
    const library = tempDir("causoryn-git-alt-sub-lib-");
    await initRepo(library, "lib.txt", "lib\n");
    const reference = await referenceRepo("causoryn-git-alt-sub-ref-");
    const superproject = tempDir("causoryn-git-alt-super-");
    await initRepo(superproject, "super.txt", "super\n");
    await plainGit(superproject, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      pathToFileURL(library).href,
      "libs/lib",
    ]);
    const submoduleRoot = path.join(superproject, "libs", "lib");
    writeAlternates(path.join(superproject, ".git", "modules", "libs", "lib", "objects"), [
      path.join(reference.dir, ".git", "objects"),
    ]);
    await expectAlternatesRefused(submoduleRoot);
  }, 60_000);

  // Evidence, not a behaviour change: the git child environment is an
  // allowlist, so object-store and repository overrides in the server's own
  // environment never reach git.
  it("does not pass object directory or repository overrides from the environment to git", async () => {
    const reference = await referenceRepo("causoryn-git-alt-env-ref-");
    const root = tempDir("causoryn-git-alt-env-root-");
    await initRepo(root, "a.txt", "a\n");
    const overrides: Record<string, string> = {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(reference.dir, ".git", "objects"),
      GIT_OBJECT_DIRECTORY: path.join(reference.dir, ".git", "objects"),
      GIT_DIR: path.join(reference.dir, ".git"),
      GIT_COMMON_DIR: path.join(reference.dir, ".git"),
      GIT_WORK_TREE: reference.dir,
      GIT_INDEX_FILE: path.join(reference.dir, ".git", "index"),
      GIT_NAMESPACE: "causoryn-test",
    };
    const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    const seen: Array<Readonly<Record<string, string>>> = [];
    setGitProcessRunnerForTesting((file, args, options) => {
      if (args.includes("-C")) seen.push(options.env);
      return defaultGitProcessRunner(file, args, options);
    });
    Object.assign(process.env, overrides);
    try {
      expect(await readGitBlob(root, "HEAD", "a.txt")).toBe("a\n");
      expect((await rejection(() => readGitBlob(root, reference.head, "ref.txt"))).code).toBe("compare/blob-not-found");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const env of seen) {
      for (const key of Object.keys(overrides)) expect(env[key]).toBeUndefined();
    }
  }, 60_000);
});
