import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GraphRepositoryError } from "../packages/graph/src/errors.js";
import {
  assertValidGitRef,
  buildGitEnv,
  GIT_DEV_NULL,
  readGitBlob,
  readGitTree,
  resolveGitCommitRef,
  runGit,
  WORKING_TREE_REF,
} from "../packages/graph/src/git-read.js";

const execFile = promisify(execFileCallback);

function expectThrowsCode(action: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`Expected GraphRepositoryError(${code}) but nothing was thrown`);
  }
  expect(thrown).toBeInstanceOf(GraphRepositoryError);
  expect((thrown as GraphRepositoryError).code).toBe(code);
}

async function expectRejectsCode(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`Expected GraphRepositoryError(${code}) but promise resolved`);
  }
  expect(thrown).toBeInstanceOf(GraphRepositoryError);
  expect((thrown as GraphRepositoryError).code).toBe(code);
}

describe("git-read — untrusted repository hardening (Task 1.2)", () => {
  it("buildGitEnv forces all 7 hardened Git isolation variables and strips hostile/secret env vars", () => {
    const expectedNull = process.platform === "win32" ? "NUL" : "/dev/null";
    expect(GIT_DEV_NULL).toBe(expectedNull);

    const env = buildGitEnv({
      PATH: "/usr/bin:/bin",
      SystemRoot: "C:\\Windows",
      HOME: "/home/dev",
      // Hostile/override attempts that MUST be neutralized:
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_CONFIG_GLOBAL: "/tmp/evil.gitconfig",
      GIT_ATTR_NOSYSTEM: "0",
      GIT_TERMINAL_PROMPT: "1",
      GIT_NO_LAZY_FETCH: "0",
      GIT_OPTIONAL_LOCKS: "1",
      GIT_LFS_SKIP_SMUDGE: "0",
      GIT_SSH_COMMAND: "evil-ssh",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "evil-fsmonitor",
      GITHUB_TOKEN: "ghp_secret",
    });

    expect(env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(env["GIT_CONFIG_GLOBAL"]).toBe(expectedNull);
    expect(env["GIT_ATTR_NOSYSTEM"]).toBe("1");
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(env["GIT_NO_LAZY_FETCH"]).toBe("1");
    expect(env["GIT_OPTIONAL_LOCKS"]).toBe("0");
    expect(env["GIT_LFS_SKIP_SMUDGE"]).toBe("1");

    expect(env["GIT_SSH_COMMAND"]).toBeUndefined();
    expect(env["GIT_CONFIG_COUNT"]).toBeUndefined();
    expect(env["GIT_CONFIG_KEY_0"]).toBeUndefined();
    expect(env["GIT_CONFIG_VALUE_0"]).toBeUndefined();
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
  });

  describe("malicious .git/config neutralization & safe relative revisions on real Git repos", () => {
    let repoRoot: string;
    let markerDir: string;
    let markerFile: string;
    let commit1Sha: string;
    let commit2Sha: string;
    let commit3Sha: string;

    beforeAll(async () => {
      repoRoot = await mkdtemp(path.join(tmpdir(), "causoryn-git-hardening-"));
      markerDir = await mkdtemp(path.join(tmpdir(), "causoryn-git-marker-"));
      markerFile = path.join(markerDir, "pwned.txt");
      const poisonScript = path.join(markerDir, "poison.mjs");
      await writeFile(
        poisonScript,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerFile)}, "EXECUTED", "utf8");\n`,
        "utf8",
      );

      const git = async (args: string[]): Promise<string> => {
        const res = await execFile("git", ["-C", repoRoot, ...args], {
          shell: false,
          windowsHide: true,
        });
        return res.stdout;
      };

      await git(["init", "-b", "main"]);
      await git(["config", "user.name", "Causoryn Hardening Test"]);
      await git(["config", "user.email", "hardening@causoryn.invalid"]);
      await git(["config", "core.autocrlf", "false"]);

      await mkdir(path.join(repoRoot, "src"), { recursive: true });

      await writeFile(path.join(repoRoot, "src", "app.ts"), "export const version = 1;\n", "utf8");
      await git(["add", "-A"]);
      await git(["commit", "-m", "commit-1"]);
      commit1Sha = (await git(["rev-parse", "HEAD"])).trim();

      await writeFile(path.join(repoRoot, "src", "app.ts"), "export const version = 2;\n", "utf8");
      await git(["add", "-A"]);
      await git(["commit", "-m", "commit-2"]);
      commit2Sha = (await git(["rev-parse", "HEAD"])).trim();

      await writeFile(path.join(repoRoot, "src", "app.ts"), "export const version = 3;\n", "utf8");
      await git(["add", "-A"]);
      await git(["commit", "-m", "commit-3"]);
      commit3Sha = (await git(["rev-parse", "HEAD"])).trim();

      await git(["tag", "-a", "v0.2.4", "-m", "release v0.2.4"]);

      // Inject malicious .git/config entries (CVE-2022-24765 + CVE-2024-32465 vectors)
      const poisonCmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(poisonScript)}`;
      await git(["config", "core.fsmonitor", poisonCmd]);
      await git(["config", "core.sshCommand", poisonCmd]);
      await git(["config", "diff.external", poisonCmd]);
      await git(["config", "core.repositoryformatversion", "1"]);
      await git(["config", "extensions.partialClone", "origin"]);
      await git(["config", "remote.origin.url", "ssh://attacker.invalid/evil.git"]);
      await git(["config", "remote.origin.promisor", "true"]);
    }, 30_000);

    afterAll(async () => {
      if (repoRoot !== undefined) {
        await rm(repoRoot, { recursive: true, force: true });
      }
      if (markerDir !== undefined) {
        await rm(markerDir, { recursive: true, force: true });
      }
    });

    it("never executes core.sshCommand / core.fsmonitor / partialClone promisor fetch or creates .git/index.lock", async () => {
      const tree = await readGitTree(repoRoot, "HEAD");
      expect(tree.some((entry) => entry.path === "src/app.ts")).toBe(true);

      const blob = await readGitBlob(repoRoot, "HEAD", "src/app.ts");
      expect(blob).toBe("export const version = 3;\n");

      const resolvedHead = await resolveGitCommitRef(repoRoot, "HEAD");
      expect(resolvedHead).toBe(commit3Sha);

      // Even when querying a missing blob or missing object SHA (which would trigger
      // promisor lazy-fetch + core.sshCommand in an unhardened repo), ZERO external commands run!
      await expectRejectsCode(
        () => readGitBlob(repoRoot, "HEAD", "src/does-not-exist.ts"),
        "compare/blob-not-found",
      );
      await expectRejectsCode(
        () => readGitBlob(repoRoot, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "src/app.ts"),
        "compare/blob-not-found",
      );
      await expectRejectsCode(
        () => resolveGitCommitRef(repoRoot, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
        "compare/ref-not-found",
      );

      expect(existsSync(markerFile), "malicious .git/config command MUST NEVER execute").toBe(false);
      expect(
        existsSync(path.join(repoRoot, ".git", "index.lock")),
        "ADR-008: read-only git inspection MUST NOT create .git/index.lock",
      ).toBe(false);
    }, 60_000);

    it("resolves safe relative revisions (HEAD~1, HEAD~2, HEAD^, HEAD^^, main~1, v0.2.4^0) and reads their trees/blobs", async () => {
      expect(await resolveGitCommitRef(repoRoot, "HEAD")).toBe(commit3Sha);
      expect(await resolveGitCommitRef(repoRoot, "HEAD~1")).toBe(commit2Sha);
      expect(await resolveGitCommitRef(repoRoot, "HEAD~2")).toBe(commit1Sha);
      expect(await resolveGitCommitRef(repoRoot, "HEAD^")).toBe(commit2Sha);
      expect(await resolveGitCommitRef(repoRoot, "HEAD^1")).toBe(commit2Sha);
      expect(await resolveGitCommitRef(repoRoot, "HEAD^^")).toBe(commit1Sha);
      expect(await resolveGitCommitRef(repoRoot, "HEAD~1^")).toBe(commit1Sha);
      expect(await resolveGitCommitRef(repoRoot, "main~1")).toBe(commit2Sha);
      expect(await resolveGitCommitRef(repoRoot, "v0.2.4^0")).toBe(commit3Sha);
      expect(await resolveGitCommitRef(repoRoot, "v0.2.4~1")).toBe(commit2Sha);

      expect(await readGitBlob(repoRoot, "HEAD~1", "src/app.ts")).toBe("export const version = 2;\n");
      expect(await readGitBlob(repoRoot, "HEAD^", "src/app.ts")).toBe("export const version = 2;\n");
      expect(await readGitBlob(repoRoot, "HEAD~2", "src/app.ts")).toBe("export const version = 1;\n");

      const treePrev = await readGitTree(repoRoot, "HEAD~1");
      expect(treePrev.some((entry) => entry.path === "src/app.ts")).toBe(true);
      expect(existsSync(markerFile)).toBe(false);
    }, 60_000);

    it("accepts safe relative ref formats and strictly rejects malicious/malformed refs", async () => {
      for (const valid of [
        "HEAD",
        "HEAD~1",
        "HEAD~10",
        "HEAD~",
        "HEAD^",
        "HEAD^0",
        "HEAD^2",
        "HEAD^^",
        "HEAD~1^2",
        "main~1",
        "v0.2.4^0",
        "refs/heads/feature/x~2",
      ]) {
        expect(assertValidGitRef(valid), `should accept ${valid}`).toBe(valid);
      }

      for (const invalid of [
        "",
        "--exec=x",
        "--upload-pack=evil",
        "-foo",
        "-c",
        ".HEAD",
        "/HEAD",
        "HEAD..main",
        "HEAD...main",
        "HEAD@{0}",
        "HEAD:src/app.ts",
        "HEAD~-1",
        "HEAD~abc",
        "HEAD^abc",
        "HEAD^{tree}",
        "HEAD^{/regex}",
        "HEAD^!",
        "HEAD^@",
        "~1",
        "^1",
        "HEAD~1/foo",
        "main/~1",
        "HEAD.lock",
        "HEAD.lock~1",
        "HEAD foo",
        "HEAD\tfoo",
        "HEAD\nfoo",
        "HEAD\x00",
        "refs//heads/main",
        "refs\\heads\\main",
        "HEAD/",
        `a${"b".repeat(200)}`,
      ]) {
        expectThrowsCode(() => assertValidGitRef(invalid), "compare/invalid-ref");
      }

      await expectRejectsCode(
        () => resolveGitCommitRef(repoRoot, WORKING_TREE_REF),
        "compare/invalid-ref",
      );
    });

    it("guards rev-parse strictly to read-only --verify --end-of-options mode", async () => {
      await expectRejectsCode(
        () => runGit(repoRoot, ["rev-parse", "--git-dir"]),
        "compare/git-command-not-allowed",
      );
      await expectRejectsCode(
        () => runGit(repoRoot, ["rev-parse", "--show-toplevel"]),
        "compare/git-command-not-allowed",
      );
      await expectRejectsCode(
        () => runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]),
        "compare/git-command-not-allowed",
      );
      await expectRejectsCode(
        () => runGit(repoRoot, ["rev-parse", "--verify", "--end-of-options", "HEAD", "--extra"]),
        "compare/git-command-not-allowed",
      );
      await expectRejectsCode(
        () => runGit(repoRoot, ["rev-parse", "--verify", "--end-of-options"]),
        "compare/git-command-not-allowed",
      );
      await expectRejectsCode(
        () => runGit(repoRoot, ["rev-parse", "--verify", "--end-of-options", "--exec=evil"]),
        "compare/invalid-ref",
      );
      await expectRejectsCode(
        () => runGit(repoRoot, ["rev-parse", "--verify", "--end-of-options", "HEAD@{0}"]),
        "compare/invalid-ref",
      );

      const sha = (
        await runGit(repoRoot, ["rev-parse", "--verify", "--end-of-options", "HEAD~1^{commit}"])
      ).trim();
      expect(sha).toBe(commit2Sha);
    }, 60_000);
  });
});
