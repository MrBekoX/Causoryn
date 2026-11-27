import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceAccessPolicy } from "../src/index.js";

/**
 * Follow-ups to the root-authorization and ignore-matching hardening:
 *
 * - Secret / VCS deny rules also match names that a case-insensitive filesystem
 *   treats as the same name but JavaScript lower-casing does not: NTFS compares
 *   names by upper-casing, and U+0131 (dotless i) upper-cases to "I", so `.gıt`
 *   opens `.git` there (also through WSL drvfs, where realpath keeps the given
 *   spelling). Compatibility forms and combining marks fold the same way, so a
 *   look-alike is denied rather than allowed (fail closed).
 * - A root spelled inside an allowRoot whose real path cannot be resolved gets the
 *   "not inside a declared allowRoot" reason whenever the resolvable part of it
 *   already leaves the allowRoots (a dangling link planted in the repository), so
 *   the reason tells nothing about what exists outside the authorized area.
 */

const IS_WIN = process.platform === "win32";
const ROOT_NOT_DECLARED = "root is not inside a user-declared allowRoot (explicit authorization required)";

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function linkDirectory(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, IS_WIN ? "junction" : "dir");
}

async function importWorkspaceAs(platform: NodeJS.Platform): Promise<typeof import("../src/index.js")> {
  const real = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
  Object.defineProperty(process, "platform", { ...real, value: platform });
  try {
    vi.resetModules();
    return await import("../src/index.js");
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}

const LOOK_ALIKES: ReadonlyArray<readonly [string, string]> = [
  // U+0131 dotless i: NTFS upper-cases it to "I", so this opens .git/config there.
  [".gıt/config", "**/.git/**"],
  // U+FF45 fullwidth e: a compatibility form of "e".
  [".ｅnv.local", "**/.env*"],
  // "p" with U+0307 combining dot above.
  ["key.ṗem", "**/*.pem"],
];

function seedLookAlikes(root: string): void {
  mkdirSync(path.join(root, ".gıt"), { recursive: true });
  writeFileSync(path.join(root, ".gıt", "config"), "[core]\n");
  writeFileSync(path.join(root, ".ｅnv.local"), "SECRET=1\n");
  writeFileSync(path.join(root, "key.ṗem"), "-----BEGIN\n");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "app.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, "src", "gi̇t.ts"), "export const b = 1;\n");
}

describe("WorkspaceAccessPolicy — look-alike spellings of the secret deny rules", () => {
  for (const platform of ["linux", "win32"] as const) {
    // A simulated win32 policy requires drive-letter allowRoots: only a Windows
    // host has temp directories of that form.
    it.skipIf(platform === "win32" && process.platform !== "win32")(`denies look-alike .git / .env* / *.pem names (${platform} simulated)`, async () => {
      const ws = await importWorkspaceAs(platform);
      const root = tempDir("causoryn-lookalike-");
      seedLookAlikes(root);
      const policy = ws.WorkspaceAccessPolicy.create({ allowRoots: [root] });
      for (const [candidate, rule] of LOOK_ALIKES) {
        const decision = policy.checkFile(root, candidate);
        expect(decision.allowed, candidate).toBe(false);
        if (!decision.allowed) expect(decision.rule, candidate).toBe(rule);
      }
      // Ordinary files, including non-ASCII names that are not look-alikes of a
      // deny rule, stay allowed.
      expect(policy.checkFile(root, "src/app.ts").allowed).toBe(true);
      expect(policy.checkFile(root, "src/gi̇t.ts").allowed).toBe(true);
    });
  }

  it("folds look-alikes only for the configured secret deny rules", async () => {
    const ws = await importWorkspaceAs("linux");
    const root = tempDir("causoryn-lookalike-custom-");
    seedLookAlikes(root);
    const policy = ws.WorkspaceAccessPolicy.create({ allowRoots: [root], ignore: ["**/vendor/**"] });
    expect(policy.checkFile(root, ".gıt/config").allowed).toBe(true);
  });
});

describe("WorkspaceAccessPolicy.authorizeRoot — no existence oracle through a dangling link", () => {
  it("gives the not-declared reason for a root below a dangling link that leaves the allowRoot", () => {
    const holder = tempDir("causoryn-dangling-");
    const root = path.join(holder, "root");
    mkdirSync(root, { recursive: true });
    const outsideMissing = path.join(holder, "outside", "missing");
    const outsideExisting = path.join(holder, "outside-existing");
    mkdirSync(outsideExisting, { recursive: true });
    linkDirectory(outsideMissing, path.join(root, "gone"));
    linkDirectory(outsideExisting, path.join(root, "there"));
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });

    const toMissing = policy.authorizeRoot(path.join(root, "gone", "sub"));
    const toExisting = policy.authorizeRoot(path.join(root, "there", "sub"));

    expect(toMissing.allowed).toBe(false);
    expect(toExisting.allowed).toBe(false);
    if (!toMissing.allowed && !toExisting.allowed) {
      // Same answer whether or not the outside target exists.
      expect(toMissing.reason).toBe(ROOT_NOT_DECLARED);
      expect(toExisting.reason).toBe(ROOT_NOT_DECLARED);
    }
  });

  // A directory whose name merely starts with ".." is inside the allowRoot; the
  // link check must still run below it.
  it("gives the not-declared reason below a dangling link in a directory named '..x'", () => {
    const holder = tempDir("causoryn-dangling-dotdot-");
    const root = path.join(holder, "root");
    mkdirSync(path.join(root, "..x"), { recursive: true });
    linkDirectory(path.join(holder, "outside", "missing"), path.join(root, "..x", "gone"));
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });

    const decision = policy.authorizeRoot(path.join(root, "..x", "gone", "sub"));

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe(ROOT_NOT_DECLARED);
  });

  it("keeps the detailed reason for a missing root inside the allowRoot", () => {
    const root = tempDir("causoryn-missing-inside-");
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    const decision = policy.authorizeRoot(path.join(root, "not-yet", "here"));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("could not be resolved");
  });
});
