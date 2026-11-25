/**
 * git-read: repository-local configuration and attributes can never make a
 * read start a command. Every check uses a real temporary repository whose
 * `.git/config` points the relevant key at a script that creates a marker
 * file; the assertion is that no marker ever appears. Control runs with a
 * plain `git` (no Causoryn hardening) prove that each fixture is live, i.e.
 * the same repository DOES run the configured command when git is not
 * hardened.
 */
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  runGit,
  setGitProcessRunnerForTesting,
} from "../packages/graph/src/git-read.js";

const execFile = promisify(execFileCallback);

/** Plain git for fixture setup and control runs (no Causoryn hardening). */
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
  for (const dir of cleanup) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
afterEach(() => {
  setGitProcessRunnerForTesting(undefined);
  resetGitRuntimeCachesForTesting();
});

/** Directory with a marker script; `command(name)` runs it and creates `<dir>/<name>.hit`. */
function makeMarkerKit(): {
  readonly dir: string;
  readonly script: string;
  command(name: string): string;
  hits(): string[];
  clear(): void;
} {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "causoryn-git-marker-")));
  cleanup.push(dir);
  const script = path.join(dir, "marker.mjs");
  // Writes the marker and exits at once (status 1): never waits on stdin, so
  // a started command can neither hang a read nor pass for a working driver.
  writeFileSync(
    script,
    'import { writeFileSync } from "node:fs";\n' +
      'writeFileSync(process.argv[2], "executed");\n' +
      "process.exit(1);\n",
    "utf8",
  );
  return {
    dir,
    script,
    command(name: string): string {
      return [process.execPath, script, path.join(dir, `${name}.hit`)]
        .map((part) => JSON.stringify(part.replace(/\\/g, "/")))
        .join(" ");
    },
    hits(): string[] {
      return readdirSync(dir).filter((entry) => entry.endsWith(".hit")).sort();
    },
    clear(): void {
      for (const entry of readdirSync(dir)) {
        if (entry.endsWith(".hit")) rmSync(path.join(dir, entry), { force: true });
      }
    },
  };
}

async function makeRepo(prefix: string): Promise<string> {
  const repo = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(repo);
  await plainGit(repo, ["init", "-q", "-b", "main"]);
  await plainGit(repo, ["config", "user.name", "Causoryn Test"]);
  await plainGit(repo, ["config", "user.email", "test@causoryn.invalid"]);
  await plainGit(repo, ["config", "core.autocrlf", "false"]);
  return repo;
}

/** Every repo-local key that names a command git could start. */
function commandKeys(kit: ReturnType<typeof makeMarkerKit>, hooksDir: string): Array<[string, string]> {
  return [
    ["core.fsmonitor", kit.command("core-fsmonitor")],
    ["core.hooksPath", hooksDir.replace(/\\/g, "/")],
    ["core.pager", kit.command("core-pager")],
    ["pager.cat-file", kit.command("pager-cat-file")],
    ["pager.ls-tree", kit.command("pager-ls-tree")],
    ["pager.rev-parse", kit.command("pager-rev-parse")],
    ["pager.config", kit.command("pager-config")],
    ["core.sshCommand", kit.command("core-sshcommand")],
    ["core.gitProxy", kit.command("core-gitproxy")],
    ["core.askPass", kit.command("core-askpass")],
    ["core.editor", kit.command("core-editor")],
    ["sequence.editor", kit.command("sequence-editor")],
    ["core.alternateRefsCommand", kit.command("core-alternaterefscommand")],
    ["credential.helper", `!${kit.command("credential-helper")}`],
    ["gpg.program", kit.command("gpg-program")],
    ["gpg.ssh.program", kit.command("gpg-ssh-program")],
    ["gpg.x509.program", kit.command("gpg-x509-program")],
    ["log.showSignature", "true"],
    ["diff.external", kit.command("diff-external")],
    ["diff.drv.textconv", kit.command("diff-textconv")],
    ["diff.drv.command", kit.command("diff-command")],
    ["filter.flt.clean", kit.command("filter-clean")],
    ["filter.flt.smudge", kit.command("filter-smudge")],
    ["filter.flt.process", kit.command("filter-process")],
    ["filter.flt.required", "true"],
    ["alias.ls-tree", `!${kit.command("alias-ls-tree")}`],
    ["alias.cat-file", `!${kit.command("alias-cat-file")}`],
    ["uploadpack.packObjectsHook", kit.command("uploadpack-packobjectshook")],
    ["remote.origin.uploadpack", kit.command("remote-uploadpack")],
    ["remote.origin.receivepack", kit.command("remote-receivepack")],
  ];
}

function writeHooks(hooksDir: string, kit: ReturnType<typeof makeMarkerKit>): void {
  mkdirSync(hooksDir, { recursive: true });
  for (const hook of [
    "reference-transaction",
    "post-index-change",
    "post-checkout",
    "pre-auto-gc",
    "post-rewrite",
    "fsmonitor-watchman",
  ]) {
    writeFileSync(path.join(hooksDir, hook), `#!/bin/sh\n${kit.command(`hook-${hook}`)}\n`, { mode: 0o755 });
  }
}

describe("git-read: runGit only accepts read-only argument shapes", () => {
  let repo: string;
  let kit: ReturnType<typeof makeMarkerKit>;
  beforeAll(async () => {
    kit = makeMarkerKit();
    repo = await makeRepo("causoryn-git-argv-");
    writeFileSync(path.join(repo, "a.txt"), "x\n", "utf8");
    writeFileSync(path.join(repo, ".gitattributes"), "* diff=drv filter=flt\n", "utf8");
    await plainGit(repo, ["add", "-A"]);
    await plainGit(repo, ["commit", "-q", "-m", "c1"]);
    await plainGit(repo, ["config", "diff.drv.textconv", kit.command("diff-textconv")]);
    await plainGit(repo, ["config", "filter.flt.smudge", kit.command("filter-smudge")]);
    // Control: unhardened git really runs the configured driver for these forms
    // (the marker exits non-zero, so git reports a failure after starting it).
    await plainGit(repo, ["cat-file", "--textconv", "HEAD:a.txt"]).catch(() => undefined);
    await plainGit(repo, ["cat-file", "--filters", "HEAD:a.txt"]).catch(() => undefined);
    expect(kit.hits()).toEqual(expect.arrayContaining(["diff-textconv.hit", "filter-smudge.hit"]));
    kit.clear();
  }, 60_000);

  it("rejects cat-file forms that apply textconv or filter drivers, without starting git", async () => {
    const spawned: Array<readonly string[]> = [];
    setGitProcessRunnerForTesting((file, args, options) => {
      if (args.includes("-C")) spawned.push(args);
      return defaultGitProcessRunner(file, args, options);
    });
    for (const args of [
      ["cat-file", "--textconv", "HEAD:a.txt"],
      ["cat-file", "--filters", "HEAD:a.txt"],
      ["cat-file", "--path=a.txt", "--filters", "HEAD:a.txt"],
      ["cat-file", "--batch", "--textconv"],
      ["cat-file", "--batch-command"],
      ["cat-file", "--batch-check"],
      ["cat-file", "blob", "--textconv", "HEAD:a.txt"],
      ["cat-file", "blob"],
      ["cat-file", "blob", "HEAD:a.txt", "--textconv"],
      ["cat-file", "blob", "-HEAD"],
      ["ls-tree", "-r", "HEAD", "--", "a.txt"],
      ["ls-tree", "--format=%(objectname)", "HEAD"],
      ["ls-tree", "-r"],
    ]) {
      const error = await rejection(() => runGit(repo, args));
      expect(error.code, args.join(" ")).toBe("compare/git-command-not-allowed");
    }
    expect(spawned).toEqual([]);
    expect(kit.hits()).toEqual([]);
  }, 60_000);

  it("still runs the exact forms the read APIs use", async () => {
    const head = (await runGit(repo, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])).trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect((await runGit(repo, ["cat-file", "-t", "HEAD"])).trim()).toBe("commit");
    expect(await runGit(repo, ["cat-file", "commit", head])).toContain("c1");
    expect(await runGit(repo, ["cat-file", "blob", "HEAD:a.txt"])).toBe("x\n");
    expect(await runGit(repo, ["ls-tree", "-r", "--full-tree", "-z", "HEAD"])).toContain("a.txt");
    expect(kit.hits()).toEqual([]);
  }, 60_000);
});

describe("git-read: repository-local command keys never run during reads", () => {
  let repo: string;
  let kit: ReturnType<typeof makeMarkerKit>;
  let head: string;
  beforeAll(async () => {
    kit = makeMarkerKit();
    repo = await makeRepo("causoryn-git-config-keys-");
    writeFileSync(path.join(repo, "a.txt"), "x\n", "utf8");
    writeFileSync(path.join(repo, ".gitattributes"), "* diff=drv filter=flt\n", "utf8");
    await plainGit(repo, ["add", "-A"]);
    await plainGit(repo, ["commit", "-q", "-m", "c1"]);
    await plainGit(repo, ["tag", "-a", "v1", "-m", "release v1"]);
    head = (await plainGit(repo, ["rev-parse", "HEAD"])).trim();
    const hooksDir = path.join(kit.dir, "hooks");
    writeHooks(hooksDir, kit);
    for (const [key, value] of commandKeys(kit, hooksDir)) {
      await plainGit(repo, ["config", key, value]);
    }
    // Control: the fixture is live — unhardened git runs repo-configured drivers.
    await plainGit(repo, ["cat-file", "--textconv", "HEAD:a.txt"]).catch(() => undefined);
    await plainGit(repo, ["cat-file", "--filters", "HEAD:a.txt"]).catch(() => undefined);
    expect(kit.hits().length).toBeGreaterThan(0);
    kit.clear();
  }, 60_000);

  it("every public read path completes without starting any configured command", async () => {
    expect((await readGitTree(repo, "HEAD")).map((entry) => entry.path)).toEqual([".gitattributes", "a.txt"]);
    expect(await readGitBlob(repo, "HEAD", "a.txt")).toBe("x\n");
    expect(await readGitBlob(repo, "v1", "a.txt")).toBe("x\n");
    expect(await resolveGitCommitRef(repo, "v1")).toBe(head);
    expect((await runGit(repo, ["cat-file", "-t", "v1"])).trim()).toBe("tag");
    expect(await runGit(repo, ["cat-file", "tag", "v1"])).toContain("release v1");
    expect(await runGit(repo, ["cat-file", "commit", head])).toContain("c1");
    expect((await rejection(() => readGitBlob(repo, "HEAD", "missing.txt"))).code).toBe("compare/blob-not-found");
    expect((await rejection(() => resolveGitCommitRef(repo, "0".repeat(40)))).code).toBe("compare/ref-not-found");
    expect(kit.hits()).toEqual([]);
    expect(existsSync(path.join(repo, ".git", "index.lock"))).toBe(false);
  }, 60_000);

  it("every repository-bound git call disables the pager and resets credential helpers", async () => {
    const seen: Array<readonly string[]> = [];
    setGitProcessRunnerForTesting((file, args, options) => {
      if (args.includes("-C")) seen.push(args);
      return defaultGitProcessRunner(file, args, options);
    });
    await readGitTree(repo, "HEAD");
    await readGitBlob(repo, "HEAD", "a.txt");
    await resolveGitCommitRef(repo, "HEAD");
    expect(seen.length).toBeGreaterThan(0);
    for (const args of seen) {
      const subcommandIndex = args.findIndex((arg) => ["cat-file", "ls-tree", "rev-parse", "config"].includes(arg));
      expect(subcommandIndex).toBeGreaterThan(0);
      expect(args.indexOf("--no-pager")).toBeGreaterThanOrEqual(0);
      expect(args.indexOf("--no-pager")).toBeLessThan(subcommandIndex);
      const configs: string[] = [];
      for (let i = 0; i < args.length - 1; i += 1) {
        if (args[i] === "-c") configs.push(args[i + 1]!);
      }
      expect(configs).toContain("credential.helper=");
    }
    expect(kit.hits()).toEqual([]);
  }, 60_000);
});

describe("git-read: a promisor remote using a command transport is never contacted", () => {
  it("lazy fetch through a repo-enabled ext:: remote does not start the command, even when git ignores GIT_NO_LAZY_FETCH", async () => {
    const kit = makeMarkerKit();
    const origin = await makeRepo("causoryn-git-ext-origin-");
    writeFileSync(path.join(origin, "a.txt"), "x\n", "utf8");
    await plainGit(origin, ["add", "-A"]);
    await plainGit(origin, ["commit", "-q", "-m", "c1"]);
    await plainGit(origin, ["config", "uploadpack.allowFilter", "true"]);
    const parent = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "causoryn-git-ext-clone-")));
    cleanup.push(parent);
    const clone = path.join(parent, "clone");
    await execFile(
      "git",
      ["clone", "-q", "--no-checkout", "--filter=blob:none", pathToFileURL(origin).href, clone],
      { shell: false, windowsHide: true },
    );
    const escapeExt = (value: string): string => value.replace(/%/g, "%%").replace(/ /g, "% ");
    const marker = path.join(kit.dir, "ext-transport.hit");
    await plainGit(clone, [
      "remote",
      "set-url",
      "origin",
      `ext::${escapeExt(process.execPath)} ${escapeExt(kit.script)} ${escapeExt(marker)}`,
    ]);
    await plainGit(clone, ["config", "protocol.ext.allow", "always"]);
    await plainGit(clone, ["config", "protocol.allow", "always"]);
    const blob = (await plainGit(clone, ["ls-tree", "HEAD", "a.txt"])).split(/\s+/)[2]!;

    // Control: unhardened git starts the ext:: command for the missing blob.
    await plainGit(clone, ["cat-file", "blob", blob]).catch(() => undefined);
    expect(kit.hits()).toEqual(["ext-transport.hit"]);
    kit.clear();

    // Simulate a git that ignores GIT_NO_LAZY_FETCH (git < 2.45).
    setGitProcessRunnerForTesting((file, args, options) => {
      const env = { ...options.env };
      delete env["GIT_NO_LAZY_FETCH"];
      return defaultGitProcessRunner(file, args, { ...options, env });
    });
    expect((await rejection(() => readGitBlob(clone, "HEAD", "a.txt"))).code).toBe("compare/blob-not-found");
    expect((await readGitTree(clone, "HEAD")).map((entry) => entry.path)).toEqual(["a.txt"]);
    expect(kit.hits()).toEqual([]);
  }, 120_000);
});
