/**
 * git-read: the layout check reads repository metadata the way git reads it,
 * and refuses the repository when it cannot prove that the path it checked is
 * the one git will use.
 *
 * Git behaviour each case mirrors (git v2.53.0 source, confirmed with git
 * 2.43.0 on Linux and Git for Windows 2.53.0):
 * - setup.c get_common_dir_noenv: commondir loses only trailing CR/LF and is
 *   then a C string (cut at the first NUL); an inner CR or LF stays in the
 *   path.
 * - setup.c read_gitfile_gently: the same for the `gitdir: ` pointer.
 * - odb.c parse_alternates + quote.c unquote_c_style: lines split on LF only
 *   (a CR stays in the path); after a quoted entry's closing quote exactly
 *   one byte is skipped and the rest of the line is read as another entry;
 *   `\ooo` escapes are bytes.
 * - Paths are bytes: git on POSIX opens the byte name, Git for Windows maps
 *   bytes that are not valid UTF-8 to Latin-1 characters (0xFF -> U+00FF).
 * - path.c interpolate_path + exec-cmd.c system_path: `%(prefix)/<rest>`
 *   becomes <rest> as is when <rest> is absolute (`//host/share` included).
 * - refs/files-backend.c, shallow.c, commit.c, odb.c: git follows symbolic
 *   links at info/grafts, shallow, packed-refs, loose refs, objects/pack and
 *   loose object directories, and echoes graft/shallow/packed-refs lines in
 *   its error messages.
 */
import { execFile as execFileCallback } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { GraphRepositoryError } from "../packages/graph/src/errors.js";
import {
  defaultGitProcessRunner,
  readGitBlob,
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
afterAll(() => {
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

/** Records repository-bound git calls (`-C <root>`) and refuses to run them. */
function blockRepositoryBoundGit(): Array<readonly string[]> {
  const calls: Array<readonly string[]> = [];
  setGitProcessRunnerForTesting((file, args, options) => {
    if (args.includes("-C")) {
      calls.push(args);
      return Promise.reject(
        Object.assign(new Error("repository-bound git blocked by test"), {
          code: 128,
          stderr: "repository-bound git blocked by test",
        }),
      );
    }
    return defaultGitProcessRunner(file, args, options);
  });
  return calls;
}

/** Directory link that needs no special privilege on Windows (junction). */
function linkDirectory(target: string, linkPath: string | Buffer): void {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

/** File symbolic link; false when this account may not create one (Windows without the privilege). */
function tryLinkFile(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, "file");
    return true;
  } catch {
    return false;
  }
}

function expectNotNamed(message: string, location: string): void {
  expect(message).not.toContain(location);
  expect(message).not.toContain(JSON.stringify(location).slice(1, -1));
}

/** Expects a refusal before any repository-bound git call, naming none of `outside`. */
async function expectRefusedBeforeGit(root: string, ref: string, ...outside: string[]): Promise<GraphRepositoryError> {
  const calls = blockRepositoryBoundGit();
  const error = await rejection(() => resolveGitCommitRef(root, ref));
  expect(error.code).toBe("compare/repository-refused");
  for (const location of outside) expectNotNamed(error.message, location);
  expect(calls).toEqual([]);
  return error;
}

function writeAlternatesBytes(objectsDir: string, bytes: Buffer): void {
  mkdirSync(path.join(objectsDir, "info"), { recursive: true });
  writeFileSync(path.join(objectsDir, "info", "alternates"), bytes);
}

function writeAlternates(objectsDir: string, text: string): void {
  writeAlternatesBytes(objectsDir, Buffer.from(text, "utf8"));
}

/**
 * The name git opens for the single byte 0xFF inside `dir`: Git for Windows
 * maps a byte that is not valid UTF-8 to its Latin-1 character (U+00FF), git
 * on POSIX opens the byte name itself.
 */
function gitNameForByteFF(dir: string): string | Buffer {
  return process.platform === "win32"
    ? path.join(dir, "\u00ff")
    : Buffer.concat([Buffer.from(`${dir}/`, "utf8"), Buffer.from([0xff])]);
}

/**
 * Plants what git would open for the byte 0xFF in `dir` (see gitNameForByteFF).
 * File systems that accept only UTF-8 names (APFS on macOS) refuse the byte
 * name (EILSEQ); git cannot open it there either. Returns whether it was
 * planted.
 */
function plantAtByteFF(dir: string, plant: (at: string | Buffer) => void): boolean {
  try {
    plant(gitNameForByteFF(dir));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EILSEQ") throw error;
    return false;
  }
}

/** Config text with forward slashes (no config escapes needed for a Windows path). */
function configPath(file: string): string {
  return file.replace(/\\/g, "/");
}

async function repositoryPair(prefix: string): Promise<{ readonly other: string; readonly otherHead: string; readonly root: string }> {
  const holder = tempDir(prefix);
  const other = path.join(holder, "other");
  const otherHead = await initRepo(other, "secret.txt", "secret\n");
  const root = path.join(holder, "root");
  await initRepo(root, "a.txt", "a\n");
  return { other, otherHead, root };
}

describe("F4: a commondir whose text git reads past a NUL, CR or LF is refused, not ignored", () => {
  const forms: ReadonlyArray<readonly [string, string]> = [
    ["a NUL (git cuts the path there)", "\0x"],
    ["an inner LF (git keeps it in the path)", "\nx"],
    ["an inner CR (git keeps it in the path)", "\rx"],
  ];
  for (const [label, tail] of forms) {
    it(`refuses a commondir with ${label} before git starts`, async () => {
      const { other, root } = await repositoryPair("causoryn-parse-commondir-");
      const text = Buffer.concat([Buffer.from(configPath(path.join(other, ".git")), "utf8"), Buffer.from(`${tail}\n`, "utf8")]);
      writeFileSync(path.join(root, ".git", "commondir"), text);

      const error = await expectRefusedBeforeGit(root, "HEAD", other);

      expect(error.message).toContain("commondir");
    }, 60_000);
  }

  it("still reads a repository whose commondir names its own git directory with a CRLF ending", async () => {
    const root = tempDir("causoryn-parse-commondir-crlf-");
    const head = await initRepo(root, "a.txt", "a\n");
    writeFileSync(path.join(root, ".git", "commondir"), ".\r\n", "utf8");

    expect(await resolveGitCommitRef(root, "HEAD")).toBe(head);
  }, 60_000);
});

describe("F12: metadata paths that are not valid UTF-8 are refused, not checked under a replacement name", () => {
  it("refuses a commondir that is not valid UTF-8 (decoy at the U+FFFD name)", async () => {
    const { other, root } = await repositoryPair("causoryn-parse-commondir-ff-");
    const gitDir = path.join(root, ".git");
    mkdirSync(path.join(gitDir, "\ufffd"));
    plantAtByteFF(gitDir, (at) => linkDirectory(path.join(other, ".git"), at));
    writeFileSync(path.join(gitDir, "commondir"), Buffer.from([0xff, 0x0a]));

    const error = await expectRefusedBeforeGit(root, "HEAD", other);

    expect(error.message).toContain("commondir");
    expect(error.message).toContain("UTF-8");
  }, 60_000);

  it("refuses a .git file whose gitdir pointer is not valid UTF-8 (decoy at the U+FFFD name)", async () => {
    const holder = tempDir("causoryn-parse-gitfile-ff-");
    const other = path.join(holder, "other");
    await initRepo(other, "secret.txt", "secret\n");
    const root = path.join(holder, "root");
    mkdirSync(root);
    await plainGit(holder, ["init", "-q", "--bare", path.join(root, "\ufffd")]);
    plantAtByteFF(root, (at) => linkDirectory(path.join(other, ".git"), at));
    writeFileSync(path.join(root, ".git"), Buffer.concat([Buffer.from("gitdir: ", "utf8"), Buffer.from([0xff, 0x0a])]));

    const error = await expectRefusedBeforeGit(root, "HEAD", other);

    expect(error.message).toContain("UTF-8");
  }, 60_000);

  it("refuses an alternates entry that is not valid UTF-8", async () => {
    const { other, otherHead, root } = await repositoryPair("causoryn-parse-alt-ff-");
    const objects = path.join(root, ".git", "objects");
    plantAtByteFF(objects, (at) => linkDirectory(path.join(other, ".git", "objects"), at));
    writeAlternatesBytes(objects, Buffer.from([0xff, 0x0a]));

    const error = await expectRefusedBeforeGit(root, otherHead, other);

    expect(error.message).toContain("objects/info/alternates");
    expect(error.message).toContain("UTF-8");
  }, 60_000);

  it("refuses an include.path that is not valid UTF-8", async () => {
    const root = tempDir("causoryn-parse-include-ff-");
    await initRepo(root, "a.txt", "a\n");
    const gitDir = path.join(root, ".git");
    plantAtByteFF(gitDir, (at) => writeFileSync(at, "[include]\n\tpath = //127.0.0.1/causoryn-unused-share/cfg\n", "utf8"));
    const config = Buffer.concat([
      Buffer.from("[core]\n\tbare = false\n[include]\n\tpath = ", "utf8"),
      Buffer.from([0xff]),
      Buffer.from("\n", "utf8"),
    ]);
    writeFileSync(path.join(gitDir, "config"), config);

    const error = await expectRefusedBeforeGit(root, "HEAD");

    expect(error.message).toContain("include.path");
    expect(error.message).toContain("UTF-8");
  }, 60_000);

  it("still reads a repository whose include path and alternates entry are non-ASCII UTF-8", async () => {
    const reference = tempDir("causoryn-parse-utf8-ref-");
    const referenceHead = await initRepo(reference, "ref.txt", "ref\n");
    const root = tempDir("causoryn-parse-utf8-root-");
    const head = await initRepo(root, "a.txt", "a\n");
    const gitDir = path.join(root, ".git");
    writeFileSync(path.join(gitDir, "yerel-ü.cfg"), "[user]\n\tname = Included\n", "utf8");
    writeFileSync(path.join(gitDir, "config"), "[core]\n\tbare = false\n[include]\n\tpath = yerel-ü.cfg\n", "utf8");
    cpSync(path.join(reference, ".git", "objects"), path.join(gitDir, "nesne-ğ"), { recursive: true });
    writeAlternates(path.join(gitDir, "objects"), "../nesne-ğ\n");

    expect(await resolveGitCommitRef(root, "HEAD")).toBe(head);
    expect(await readGitBlob(root, referenceHead, "ref.txt")).toBe("ref\n");
  }, 60_000);

  it("still reads a repository whose config holds a Latin-1 value outside any path", async () => {
    const root = tempDir("causoryn-parse-latin1-");
    const head = await initRepo(root, "a.txt", "a\n");
    const config = Buffer.concat([
      Buffer.from("[core]\n\tbare = false\n[user]\n\tname = M", "utf8"),
      Buffer.from([0xfc]),
      Buffer.from("ller\n", "utf8"),
    ]);
    writeFileSync(path.join(root, ".git", "config"), config);

    expect(await resolveGitCommitRef(root, "HEAD")).toBe(head);
  }, 60_000);
});

describe("F6: an entry git reads after a quoted alternates entry is checked too", () => {
  it("refuses '\".\"X<other object store>' (git skips one byte after the quote and links the rest)", async () => {
    const { other, otherHead, root } = await repositoryPair("causoryn-parse-alt-afterquote-");
    writeAlternates(path.join(root, ".git", "objects"), `"."X${configPath(path.join(other, ".git", "objects"))}\n`);

    const error = await expectRefusedBeforeGit(root, otherHead);

    expect(error.message).toContain("objects/info/alternates");
    expect(error.message).toContain("outside the repository");
  }, 60_000);

  it("refuses '\".\"X//host/share/objects' as a network path", async () => {
    const root = tempDir("causoryn-parse-alt-afterquote-unc-");
    await initRepo(root, "a.txt", "a\n");
    writeAlternates(path.join(root, ".git", "objects"), `"."X//127.0.0.1/causoryn-unused-share/objects\n`);

    const error = await expectRefusedBeforeGit(root, "HEAD");

    expect(error.message).toContain("network or device path");
  }, 60_000);

  it("still reads a quoted alternates entry that ends with CRLF (git skips the CR after the quote)", async () => {
    const reference = tempDir("causoryn-parse-alt-quoted-crlf-ref-");
    const referenceHead = await initRepo(reference, "ref.txt", "ref\n");
    const root = tempDir("causoryn-parse-alt-quoted-crlf-root-");
    await initRepo(root, "a.txt", "a\n");
    cpSync(path.join(reference, ".git", "objects"), path.join(root, ".git", "ref-objects"), { recursive: true });
    writeAlternates(path.join(root, ".git", "objects"), `"../ref-objects"\r\n`);

    expect(await readGitBlob(root, referenceHead, "ref.txt")).toBe("ref\n");
  }, 60_000);
});

describe("F17: octal escapes in a quoted alternates entry are bytes, as in git", () => {
  it("resolves '\"\\303\\277\"' as U+00FF and refuses it when that name links outside", async () => {
    const { other, otherHead, root } = await repositoryPair("causoryn-parse-alt-octal-");
    const objects = path.join(root, ".git", "objects");
    linkDirectory(path.join(other, ".git", "objects"), path.join(objects, "\u00ff"));
    writeAlternates(objects, `"\\303\\277"\n`);

    const error = await expectRefusedBeforeGit(root, otherHead, other);

    expect(error.message).toContain("outside the repository");
  }, 60_000);

  it("refuses a quoted entry whose escaped bytes are not valid UTF-8 ('\"\\377\"', decoy at U+00FF)", async () => {
    const root = tempDir("causoryn-parse-alt-octal-ff-");
    await initRepo(root, "a.txt", "a\n");
    const objects = path.join(root, ".git", "objects");
    mkdirSync(path.join(objects, "\u00ff"));
    writeAlternates(objects, `"\\377"\n`);

    const error = await expectRefusedBeforeGit(root, "HEAD");

    expect(error.message).toContain("UTF-8");
  }, 60_000);
});

describe("F40: a CR in an alternates line is part of the path for git, so it is refused", () => {
  it("refuses a line that is a lone CR (git reads it as the path \"\\r\")", async () => {
    const root = tempDir("causoryn-parse-alt-lone-cr-");
    await initRepo(root, "a.txt", "a\n");
    writeAlternates(path.join(root, ".git", "objects"), "\r\n");

    const error = await expectRefusedBeforeGit(root, "HEAD");

    expect(error.message).toContain("objects/info/alternates");
  }, 60_000);

  it("refuses a CRLF line instead of checking the entry without its CR", async () => {
    const root = tempDir("causoryn-parse-alt-crlf-");
    await initRepo(root, "a.txt", "a\n");
    mkdirSync(path.join(root, ".git", "ref-objects"));
    writeAlternates(path.join(root, ".git", "objects"), "../ref-objects\r\n");

    const error = await expectRefusedBeforeGit(root, "HEAD");

    expect(error.message).toContain("objects/info/alternates");
  }, 60_000);
});

describe("F13: a %(prefix)/ include is checked after git's interpolation", () => {
  async function repoWithInclude(prefix: string, value: string): Promise<string> {
    const root = tempDir(prefix);
    await initRepo(root, "a.txt", "a\n");
    writeFileSync(path.join(root, ".git", "config"), `[core]\n\tbare = false\n[include]\n\tpath = ${value}\n`, "utf8");
    return root;
  }

  it("refuses '%(prefix)///host/share/x': git opens //host/share/x", async () => {
    const root = await repoWithInclude("causoryn-parse-prefix-unc-", "%(prefix)///127.0.0.1/causoryn-unused-share/x");

    const error = await expectRefusedBeforeGit(root, "HEAD");

    expect(error.message).toContain("network or device path");
  }, 60_000);

  it("refuses '%(prefix)/\\\\host\\share\\x'", async () => {
    // Config text `\\` is one backslash: the value is %(prefix)/\\127.0.0.1\share\x.
    const root = await repoWithInclude(
      "causoryn-parse-prefix-unc-backslash-",
      "%(prefix)/\\\\\\\\127.0.0.1\\\\causoryn-unused-share\\\\x",
    );

    const error = await expectRefusedBeforeGit(root, "HEAD");

    expect(error.message).toContain("include.path");
  }, 60_000);

  it("checks the includes of a file named by '%(prefix)/<absolute path>'", async () => {
    const root = tempDir("causoryn-parse-prefix-nested-");
    await initRepo(root, "a.txt", "a\n");
    const extra = path.join(root, ".git", "extra.cfg");
    writeFileSync(extra, "[include]\n\tpath = //127.0.0.1/causoryn-unused-share/cfg\n", "utf8");
    writeFileSync(
      path.join(root, ".git", "config"),
      `[core]\n\tbare = false\n[include]\n\tpath = %(prefix)/${configPath(extra)}\n`,
      "utf8",
    );

    const error = await expectRefusedBeforeGit(root, "HEAD");

    expect(error.message).toContain("network or device path");
  }, 60_000);

  it("refuses '%(prefix)/<relative path>', which git resolves against its installation prefix", async () => {
    const root = await repoWithInclude("causoryn-parse-prefix-relative-", "%(prefix)/etc/causoryn-unused.cfg");

    const error = await expectRefusedBeforeGit(root, "HEAD");

    expect(error.message).toContain("%(prefix)");
  }, 60_000);

  it("still reads a repository whose '%(prefix)/<absolute path>' include is a local file", async () => {
    const root = tempDir("causoryn-parse-prefix-local-");
    const head = await initRepo(root, "a.txt", "a\n");
    const local = path.join(root, ".git", "local.cfg");
    writeFileSync(local, "[user]\n\tname = Included\n", "utf8");
    writeFileSync(
      path.join(root, ".git", "config"),
      `[core]\n\tbare = false\n[include]\n\tpath = %(prefix)/${configPath(local)}\n`,
      "utf8",
    );

    expect(await resolveGitCommitRef(root, "HEAD")).toBe(head);
  }, 60_000);
});

describe("F7: links at or below the git directory entries git reads stay inside the repository", () => {
  async function outsideSecret(holder: string): Promise<string> {
    const outside = path.join(holder, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "grafts"), "TOP-SECRET-LINE\n", "utf8");
    writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET-LINE\n", "utf8");
    return outside;
  }

  async function expectLinkRefused(root: string, ref: string, outside: string): Promise<void> {
    const error = await expectRefusedBeforeGit(root, ref, outside);
    expect(error.message).toContain("outside the repository");
    expect(error.message).not.toContain("TOP-SECRET-LINE");
  }

  it("refuses an info directory that is a link outside the repository (info/grafts is echoed by git)", async () => {
    const { root } = await repositoryPair("causoryn-parse-link-info-");
    const outside = await outsideSecret(path.dirname(root));
    rmSync(path.join(root, ".git", "info"), { recursive: true, force: true });
    linkDirectory(outside, path.join(root, ".git", "info"));

    await expectLinkRefused(root, "HEAD", outside);
  }, 60_000);

  for (const entry of ["info/grafts", "shallow", "packed-refs", "ORIG_HEAD"]) {
    it(`refuses ${entry} as a file link outside the repository`, async () => {
      const { root } = await repositoryPair(`causoryn-parse-link-${entry.replace("/", "-")}-`);
      const outside = await outsideSecret(path.dirname(root));
      const at = path.join(root, ".git", ...entry.split("/"));
      mkdirSync(path.dirname(at), { recursive: true });
      rmSync(at, { force: true });
      if (!tryLinkFile(path.join(outside, "secret.txt"), at)) return; // no symlink privilege on this host

      await expectLinkRefused(root, "HEAD", outside);
    }, 60_000);
  }

  it("refuses a loose ref that is a file link to another repository's ref", async () => {
    const { other, root } = await repositoryPair("causoryn-parse-link-loose-ref-");
    if (!tryLinkFile(path.join(other, ".git", "refs", "heads", "main"), path.join(root, ".git", "refs", "heads", "x"))) return;

    await expectLinkRefused(root, "HEAD", other);
  }, 60_000);

  it("refuses a ref directory below refs/ that is a link outside the repository", async () => {
    const { other, root } = await repositoryPair("causoryn-parse-link-ref-dir-");
    mkdirSync(path.join(root, ".git", "refs", "remotes"), { recursive: true });
    linkDirectory(path.join(other, ".git", "refs", "heads"), path.join(root, ".git", "refs", "remotes", "origin"));

    await expectLinkRefused(root, "HEAD", other);
  }, 60_000);

  it("refuses a loose object directory that is a link into another object store", async () => {
    const { other, otherHead, root } = await repositoryPair("causoryn-parse-link-fanout-");
    const fanout = otherHead.slice(0, 2);
    const own = path.join(root, ".git", "objects", fanout);
    rmSync(own, { recursive: true, force: true });
    linkDirectory(path.join(other, ".git", "objects", fanout), own);

    await expectLinkRefused(root, otherHead, other);
  }, 60_000);

  it("refuses an objects/pack directory that is a link into another object store", async () => {
    const { other, otherHead, root } = await repositoryPair("causoryn-parse-link-pack-");
    await plainGit(other, ["repack", "-a", "-d", "-q"]);
    const pack = path.join(root, ".git", "objects", "pack");
    rmSync(pack, { recursive: true, force: true });
    linkDirectory(path.join(other, ".git", "objects", "pack"), pack);

    await expectLinkRefused(root, otherHead, other);
  }, 60_000);

  it("still reads a repository whose loose ref links to another ref inside its git directory", async () => {
    const root = tempDir("causoryn-parse-link-inner-ref-");
    const head = await initRepo(root, "a.txt", "a\n");
    if (!tryLinkFile(path.join(root, ".git", "refs", "heads", "main"), path.join(root, ".git", "refs", "heads", "alias"))) return;

    expect(await resolveGitCommitRef(root, "alias")).toBe(head);
  }, 60_000);

  it("still reads a repository whose info directory is a link inside the analyzed root", async () => {
    const root = tempDir("causoryn-parse-link-inner-info-");
    const head = await initRepo(root, "a.txt", "a\n");
    const info = path.join(root, ".git", "info");
    cpSync(info, path.join(root, "git-info"), { recursive: true });
    rmSync(info, { recursive: true, force: true });
    linkDirectory(path.join(root, "git-info"), info);

    expect(await resolveGitCommitRef(root, "HEAD")).toBe(head);
  }, 60_000);
});

/** POSIX only: file names that are not valid UTF-8 or contain a CR. */
describe.skipIf(process.platform === "win32")("POSIX byte names git opens as written", () => {
  it("refuses an alternates line 'evil\\r' where objects/evil<CR> links into another object store", async () => {
    const { other, otherHead, root } = await repositoryPair("causoryn-parse-posix-cr-");
    const objects = path.join(root, ".git", "objects");
    symlinkSync(path.join(other, ".git", "objects"), path.join(objects, "evil\r"));
    writeAlternates(objects, "evil\r\n");

    const error = await expectRefusedBeforeGit(root, otherHead, other);

    expect(error.message).toContain("objects/info/alternates");
  }, 60_000);

  it("refuses a loose ref link whose name is not valid UTF-8 (HEAD names it as bytes)", async () => {
    const { other, root } = await repositoryPair("causoryn-parse-posix-ff-ref-");
    const heads = path.join(root, ".git", "refs", "heads");
    // The refusal is about this entry's name: without it (UTF-8-only file system) there is nothing to check.
    if (!plantAtByteFF(heads, (at) => symlinkSync(path.join(other, ".git", "refs", "heads", "main"), at))) return;
    writeFileSync(path.join(root, ".git", "HEAD"), Buffer.concat([Buffer.from("ref: refs/heads/", "utf8"), Buffer.from([0xff, 0x0a])]));

    const error = await expectRefusedBeforeGit(root, "HEAD", other);

    expect(error.message).toContain("UTF-8");
  }, 60_000);

  it("refuses a HEAD that is a relative symbolic link leaving the git directory", async () => {
    const { other, root } = await repositoryPair("causoryn-parse-posix-head-link-");
    rmSync(path.join(root, ".git", "HEAD"));
    symlinkSync("../../other/.git/HEAD", path.join(root, ".git", "HEAD"));

    await expectRefusedBeforeGit(root, "HEAD", other);
  }, 60_000);

  it("still reads a HEAD that is a symbolic link 'refs/heads/main' (core.preferSymlinkRefs)", async () => {
    const root = tempDir("causoryn-parse-posix-symref-");
    const head = await initRepo(root, "a.txt", "a\n");
    rmSync(path.join(root, ".git", "HEAD"));
    symlinkSync("refs/heads/main", path.join(root, ".git", "HEAD"));

    expect(await resolveGitCommitRef(root, "HEAD")).toBe(head);
  }, 60_000);
});
