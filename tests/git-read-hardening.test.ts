/**
 * git-read hardening: absolute git resolution + trusted cwd (Windows
 * cwd-first search), per-protocol overrides, the git >= 2.45 requirement for
 * partial-clone repositories, and forwarding of the user's protected
 * safe.directory entries.
 */
import { execFile as execFileCallback } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GraphRepositoryError } from "../packages/graph/src/errors.js";
import {
  defaultGitProcessRunner,
  parseGitVersion,
  readGitBlob,
  readGitTree,
  resetGitRuntimeCachesForTesting,
  resolveGitCommitRef,
  setGitProcessRunnerForTesting,
  type GitProcessRunner,
} from "../packages/graph/src/git-read.js";
import { isWithinUntrustedRoots } from "../packages/graph/src/executable-resolution.js";
import {
  buildMarkerExecutable,
  plantMarkers,
  startedMarkers,
  withCwdSearchUnmasked,
} from "./spawn-marker.js";

const execFile = promisify(execFileCallback);

async function gitSetup(repo: string, args: string[]): Promise<string> {
  const res = await execFile("git", ["-C", repo, ...args], { shell: false, windowsHide: true });
  return res.stdout;
}

async function makeRepo(prefix: string): Promise<string> {
  const repo = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  await gitSetup(repo, ["init", "-q", "-b", "main"]);
  await gitSetup(repo, ["config", "user.name", "Causoryn Test"]);
  await gitSetup(repo, ["config", "user.email", "test@causoryn.invalid"]);
  await gitSetup(repo, ["config", "core.autocrlf", "false"]);
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src", "app.ts"), "export const v = 1;\n", "utf8");
  await gitSetup(repo, ["add", "-A"]);
  await gitSetup(repo, ["commit", "-q", "-m", "c1"]);
  return repo;
}

async function withEnv<T>(
  overrides: Readonly<Record<string, string | undefined>>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  // Optional calls keep this suite runnable against builds without the hooks.
  setGitProcessRunnerForTesting?.(undefined);
  resetGitRuntimeCachesForTesting?.();
});

describe("git-read: executable resolution and trusted cwd", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await makeRepo("causoryn-git-spawn-");
    cleanup.push(repo);
  }, 60_000);

  it("spawns an absolute git path with a cwd outside the repository, shell:false and windowsHide:true", async () => {
    const calls: Array<{ file: string; args: readonly string[]; cwd: string | undefined; shell: unknown; windowsHide: unknown }> = [];
    const spy: GitProcessRunner = (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd, shell: options.shell, windowsHide: options.windowsHide });
      return defaultGitProcessRunner(file, args, options);
    };
    setGitProcessRunnerForTesting(spy);
    await withCwdSearchUnmasked(repo, async () => {
      expect(await readGitBlob(repo, "HEAD", "src/app.ts")).toBe("export const v = 1;\n");
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(path.isAbsolute(call.file)).toBe(true);
      expect(path.basename(call.file).toLowerCase()).toMatch(/^git(\.exe|\.com)?$/);
      expect(call.cwd).toBeDefined();
      expect(path.isAbsolute(call.cwd!)).toBe(true);
      expect(isWithinUntrustedRoots(call.cwd!, [repo])).toBe(false);
      expect(call.shell).toBe(false);
      expect(call.windowsHide).toBe(true);
    }
    const readCall = calls.find((call) => call.args.includes("cat-file"));
    expect(readCall?.args.slice(0, 2)).toEqual(["-C", repo]);
  }, 60_000);

  it("adds command-line protocol.<name>.allow=never for file, git, ssh, http, https and ext", async () => {
    const seen: Array<readonly string[]> = [];
    setGitProcessRunnerForTesting((file, args, options) => {
      seen.push(args);
      return defaultGitProcessRunner(file, args, options);
    });
    await readGitTree(repo, "HEAD");
    const readArgs = seen.find((args) => args.includes("ls-tree"));
    expect(readArgs).toBeDefined();
    const configs: string[] = [];
    for (let i = 0; i < readArgs!.length - 1; i += 1) {
      if (readArgs![i] === "-c") configs.push(readArgs![i + 1]!);
    }
    expect(configs).toContain("protocol.allow=never");
    for (const protocol of ["file", "git", "ssh", "http", "https", "ext"]) {
      expect(configs).toContain(`protocol.${protocol}.allow=never`);
    }
  }, 60_000);

  const marker = buildMarkerExecutable();
  it.skipIf(marker === null)(
    "a git executable planted in the analyzed repository root is never started (cwd = repo, cwd search unmasked)",
    async () => {
      const planted = plantMarkers(marker!, repo, ["git"]);
      try {
        await withCwdSearchUnmasked(repo, async () => {
          expect(await readGitBlob(repo, "HEAD", "src/app.ts")).toBe("export const v = 1;\n");
          expect(await readGitTree(repo, "HEAD")).toHaveLength(1);
          expect((await resolveGitCommitRef(repo, "HEAD")).length).toBe(40);
        });
        expect(startedMarkers(planted)).toEqual([]);
      } finally {
        for (const file of planted) {
          rmSync(file, { force: true });
          rmSync(`${file}.hit`, { force: true });
        }
      }
    },
    240_000,
  );
});

describe("git-read: git >= 2.45 is required for partial-clone repositories", () => {
  it("parses git --version output", () => {
    expect(parseGitVersion("git version 2.53.0.windows.1\n")).toEqual({ major: 2, minor: 53, patch: 0 });
    expect(parseGitVersion("git version 2.44.2")).toEqual({ major: 2, minor: 44, patch: 2 });
    expect(parseGitVersion("git version 2.45")).toEqual({ major: 2, minor: 45, patch: 0 });
    expect(parseGitVersion("git version 3.0.0 (Apple Git-150)")).toEqual({ major: 3, minor: 0, patch: 0 });
    expect(parseGitVersion("not git")).toBeNull();
    expect(parseGitVersion("")).toBeNull();
  });

  let partialRepo: string;
  let fullRepo: string;
  beforeAll(async () => {
    partialRepo = await makeRepo("causoryn-git-partial-");
    fullRepo = await makeRepo("causoryn-git-full-");
    cleanup.push(partialRepo, fullRepo);
    await gitSetup(partialRepo, ["config", "remote.origin.url", "https://example.invalid/repo.git"]);
    await gitSetup(partialRepo, ["config", "remote.origin.promisor", "true"]);
    await gitSetup(partialRepo, ["config", "remote.origin.partialclonefilter", "blob:none"]);
    await gitSetup(partialRepo, ["config", "extensions.partialClone", "origin"]);
  }, 60_000);

  function withReportedVersion(versionLine: string): void {
    setGitProcessRunnerForTesting((file, args, options) => {
      if (args.length === 1 && args[0] === "--version") {
        return Promise.resolve({ stdout: `${versionLine}\n`, stderr: "" });
      }
      return defaultGitProcessRunner(file, args, options);
    });
  }

  it("refuses git-backed reads of a partial clone when git is older than 2.45", async () => {
    withReportedVersion("git version 2.44.0");
    for (const action of [
      () => readGitBlob(partialRepo, "HEAD", "src/app.ts"),
      () => readGitTree(partialRepo, "HEAD"),
      () => resolveGitCommitRef(partialRepo, "HEAD"),
    ]) {
      const error = await rejection(action);
      expect(error.code).toBe("compare/git-unavailable");
      expect(error.message).toContain("git 2.45 or newer is required");
      expect(error.message).toContain("partial-clone");
      expect(error.message).toContain("2.44.0");
    }
  }, 60_000);

  it("still reads full clones on git < 2.45 and partial clones on git >= 2.45", async () => {
    withReportedVersion("git version 2.44.0");
    expect(await readGitBlob(fullRepo, "HEAD", "src/app.ts")).toBe("export const v = 1;\n");
    resetGitRuntimeCachesForTesting();
    withReportedVersion("git version 2.45.0");
    expect(await readGitBlob(partialRepo, "HEAD", "src/app.ts")).toBe("export const v = 1;\n");
  }, 60_000);

  it("treats an unparseable git version as too old for partial clones", async () => {
    withReportedVersion("some-wrapper 1.0");
    const error = await rejection(() => readGitTree(partialRepo, "HEAD"));
    expect(error.code).toBe("compare/git-unavailable");
  }, 60_000);

  it("detects a promisor remote configured only in the worktree config scope", async () => {
    const worktreeScoped = await makeRepo("causoryn-git-worktree-promisor-");
    cleanup.push(worktreeScoped);
    await gitSetup(worktreeScoped, ["config", "core.repositoryformatversion", "1"]);
    await gitSetup(worktreeScoped, ["config", "extensions.worktreeConfig", "true"]);
    await gitSetup(worktreeScoped, ["config", "--worktree", "remote.origin.url", "https://example.invalid/repo.git"]);
    await gitSetup(worktreeScoped, ["config", "--worktree", "remote.origin.promisor", "true"]);
    // Nothing promisor-related in the repository's own config file.
    expect(await gitSetup(worktreeScoped, ["config", "--local", "--list"])).not.toContain("promisor");
    withReportedVersion("git version 2.44.0");
    const error = await rejection(() => readGitBlob(worktreeScoped, "HEAD", "src/app.ts"));
    expect(error.code).toBe("compare/git-unavailable");
    expect(error.message).toContain("git 2.45 or newer is required");
  }, 60_000);
});

describe("git-read: no transport can be enabled by repository config", () => {
  it("sets GIT_ALLOW_PROTOCOL to an empty allowlist and pins ftp/ftps as well", async () => {
    const repo = await makeRepo("causoryn-git-allow-protocol-");
    cleanup.push(repo);
    const seen: Array<{ args: readonly string[]; env: Readonly<Record<string, string>> }> = [];
    setGitProcessRunnerForTesting((file, args, options) => {
      seen.push({ args, env: options.env });
      return defaultGitProcessRunner(file, args, options);
    });
    await readGitTree(repo, "HEAD");
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.env["GIT_ALLOW_PROTOCOL"]).toBe("");
    }
    const readArgs = seen.find((call) => call.args.includes("ls-tree"))!.args;
    for (const protocol of ["ftp", "ftps"]) {
      expect(readArgs).toContain(`protocol.${protocol}.allow=never`);
    }
  }, 60_000);

  it("a partial clone whose repo config allows ftp cannot reach its promisor remote, even if lazy fetch is not disabled", async () => {
    const connections: string[] = [];
    const server = net.createServer((socket) => {
      connections.push(`${socket.remoteAddress ?? "?"}:${String(socket.remotePort ?? 0)}`);
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const origin = await makeRepo("causoryn-git-origin-");
      cleanup.push(origin);
      await gitSetup(origin, ["config", "uploadpack.allowFilter", "true"]);
      const cloneParent = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "causoryn-git-pclone-")));
      cleanup.push(cloneParent);
      const clone = path.join(cloneParent, "clone");
      await execFile(
        "git",
        ["clone", "-q", "--no-checkout", "--filter=blob:none", pathToFileURL(origin).href, clone],
        { shell: false, windowsHide: true },
      );
      await gitSetup(clone, ["remote", "set-url", "origin", `ftp://127.0.0.1:${String(port)}/repo.git`]);
      await gitSetup(clone, ["config", "protocol.ftp.allow", "always"]);
      await gitSetup(clone, ["config", "protocol.ftps.allow", "always"]);
      await gitSetup(clone, ["config", "protocol.allow", "always"]);
      expect(await gitSetup(clone, ["config", "--get", "remote.origin.promisor"])).toContain("true");

      // Simulate a git that ignores GIT_NO_LAZY_FETCH (as git < 2.45 does):
      // only the protocol restrictions may stop the fetch.
      setGitProcessRunnerForTesting((file, args, options) => {
        const env = { ...options.env };
        delete env["GIT_NO_LAZY_FETCH"];
        return defaultGitProcessRunner(file, args, { ...options, env });
      });
      const error = await rejection(() => readGitBlob(clone, "HEAD", "src/app.ts"));
      expect(error.code).toBe("compare/blob-not-found");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(connections).toEqual([]);

      // Same read with the ftp/ftps -c pins removed: the empty
      // GIT_ALLOW_PROTOCOL allowlist alone must still block the transport.
      setGitProcessRunnerForTesting((file, args, options) => {
        const env = { ...options.env };
        delete env["GIT_NO_LAZY_FETCH"];
        const stripped: string[] = [];
        for (let i = 0; i < args.length; i += 1) {
          const next = args[i + 1];
          if (args[i] === "-c" && (next === "protocol.ftp.allow=never" || next === "protocol.ftps.allow=never")) {
            i += 1;
            continue;
          }
          stripped.push(args[i]!);
        }
        expect(env["GIT_ALLOW_PROTOCOL"]).toBe("");
        return defaultGitProcessRunner(file, stripped, { ...options, env });
      });
      const second = await rejection(() => readGitBlob(clone, "HEAD", "src/app.ts"));
      expect(second.code).toBe("compare/blob-not-found");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(connections).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120_000);
});

describe("git-read: protected safe.directory entries are forwarded", () => {
  let repo: string;
  let homeWithEntry: string;
  let homeWithoutEntry: string;
  beforeAll(async () => {
    repo = await makeRepo("causoryn-git-owner-");
    homeWithEntry = mkdtempSync(path.join(os.tmpdir(), "causoryn-git-home-"));
    homeWithoutEntry = mkdtempSync(path.join(os.tmpdir(), "causoryn-git-home-empty-"));
    cleanup.push(repo, homeWithEntry, homeWithoutEntry);
    const entry = repo.replace(/\\/g, "/");
    writeFileSync(path.join(homeWithEntry, ".gitconfig"), `[safe]\n\tdirectory = ${entry}\n`, "utf8");
    writeFileSync(path.join(homeWithoutEntry, ".gitconfig"), "[core]\n\tautocrlf = false\n", "utf8");
  }, 60_000);

  const ownerEnv = (home: string): Record<string, string | undefined> => ({
    GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_GLOBAL: undefined,
    GIT_CONFIG_NOSYSTEM: "1",
  });

  it("reads succeed for a repository owned by another user when the user's global config lists it in safe.directory", async () => {
    await withEnv(ownerEnv(homeWithEntry), async () => {
      expect(await readGitBlob(repo, "HEAD", "src/app.ts")).toBe("export const v = 1;\n");
      expect(await readGitTree(repo, "HEAD")).toHaveLength(1);
      expect((await resolveGitCommitRef(repo, "HEAD")).length).toBe(40);
    });
  }, 60_000);

  it("without a safe.directory entry the error is a clear ownership message, not a missing revision", async () => {
    await withEnv(ownerEnv(homeWithoutEntry), async () => {
      const error = await rejection(() => resolveGitCommitRef(repo, "HEAD"));
      expect(error.code).toBe("compare/git-unavailable");
      expect(error.message).toContain("owned by a different user");
      expect(error.message).toContain("safe.directory");
    });
  }, 60_000);

  it("honours the user's GIT_CONFIG_NOSYSTEM: a system-level safe.directory=* (as on CI runner images) is not forwarded", async () => {
    const systemDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-git-system-"));
    cleanup.push(systemDir);
    const systemConfig = path.join(systemDir, "gitconfig");
    writeFileSync(systemConfig, "[safe]\n\tdirectory = *\n", "utf8");
    // With GIT_CONFIG_NOSYSTEM=1 git itself ignores the system file, so the
    // user's effective protected configuration has no safe.directory entry.
    await withEnv({ ...ownerEnv(homeWithoutEntry), GIT_CONFIG_SYSTEM: systemConfig }, async () => {
      const error = await rejection(() => resolveGitCommitRef(repo, "HEAD"));
      expect(error.code).toBe("compare/git-unavailable");
      expect(error.message).toContain("owned by a different user");
    });
    // Without GIT_CONFIG_NOSYSTEM the system entry is part of the user's
    // protected configuration and is forwarded.
    await withEnv(
      { ...ownerEnv(homeWithoutEntry), GIT_CONFIG_NOSYSTEM: undefined, GIT_CONFIG_SYSTEM: systemConfig },
      async () => {
        expect((await resolveGitCommitRef(repo, "HEAD")).length).toBe(40);
      },
    );
  }, 60_000);

  it("the global config is not consulted for anything except safe.directory (repo reads stay isolated)", async () => {
    const hostileHome = mkdtempSync(path.join(os.tmpdir(), "causoryn-git-home-hostile-"));
    cleanup.push(hostileHome);
    const markerFile = path.join(hostileHome, "fsmonitor.hit");
    const script = path.join(hostileHome, "hook.mjs");
    writeFileSync(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerFile)}, "x");\n`, "utf8");
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`.replace(/\\/g, "/");
    writeFileSync(
      path.join(hostileHome, ".gitconfig"),
      `[core]\n\tfsmonitor = ${command}\n\tpager = ${command}\n[safe]\n\tdirectory = ${repo.replace(/\\/g, "/")}\n`,
      "utf8",
    );
    await withEnv(ownerEnv(hostileHome), async () => {
      expect(await readGitBlob(repo, "HEAD", "src/app.ts")).toBe("export const v = 1;\n");
    });
    expect(existsSync(markerFile)).toBe(false);
  }, 60_000);
});
