import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { findFirstAncestorIgnoreMatch, lookAlikeFold } from "../src/ignore-matcher.js";
import {
  DEFAULT_IGNORE_PATTERNS,
  findMatchingIgnorePattern,
  IGNORE_MATCH_WORK_BUDGET,
  WorkspaceAccessPolicy,
} from "../src/index.js";
import type { IgnoreWorkMeter, PolicyDecision } from "../src/index.js";

/**
 * Ignore matching hardening:
 *
 * - All ancestors of a path are matched in one pass per pattern, and the whole
 *   decision runs under a fixed work budget that fails closed, so a repository
 *   .gitignore cannot make a single policy decision unbounded (Claude Security F32).
 * - The default secret / VCS deny rules (`.git`, `.env*`, `*.pem`) match letter-case
 *   aliases on every platform, while other patterns keep the platform's case
 *   semantics (Claude Security F44).
 */

const IS_WIN = process.platform === "win32";

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "causoryn-ignore-hardening-"));
  cleanups.push(dir);
  return dir;
}

function denyOf(decision: PolicyDecision): { code: string; rule?: string } {
  if (decision.allowed) {
    throw new Error(`expected a deny decision, got allowed: ${decision.relativePath}`);
  }
  return decision.rule === undefined ? { code: decision.code } : { code: decision.code, rule: decision.rule };
}

/** The per-prefix loop the policy used before the one-pass matcher (the reference semantics). */
function referenceAncestorMatch(
  posixRelative: string,
  lastIsDirectory: boolean,
  patterns: readonly string[],
): { kind: "matched"; pattern: string; depth: number } | { kind: "none" } {
  const segments = posixRelative.split("/");
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const prefix = segments.slice(0, depth).join("/");
    const matched = findMatchingIgnorePattern(prefix, depth < segments.length || lastIsDirectory, patterns);
    if (matched !== undefined) return { kind: "matched", pattern: matched, depth };
  }
  return { kind: "none" };
}

/** Deterministic linear congruential generator (no Math.random: reproducible cases). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

describe("findFirstAncestorIgnoreMatch — one-pass ancestor matching (F32)", () => {
  const SEGMENTS = [
    "a", "b", "ab", "ba", "aab", "src", "build", "dist", "Dist", ".git", ".GIT", "node_modules",
    "x.pem", ".env.local", "gen-1.tmp", "[id]", "page.ts", "run.log", "frontend", "generated", "a\\b", "vendor",
  ];
  const PATTERNS = [
    ...DEFAULT_IGNORE_PATTERNS,
    "*.log", "/build", "build/", "generated/", "a/**/b", "**/a/*/b/**", "?b/**", "src/[id]/*.ts", "**", "**/",
    "a", "/a/b", "a/b/", "**/b", "b/**", "*", "a*b", "**/a/**/a/**", "*/b", "a\\b", "x.pem", "frontend/**/build/",
    "**/ab", "ab/**/ba/", "/**/b", "a/*", "*/*/*", "src/**", "**/*.ts",
  ];

  it("returns exactly what the per-prefix loop returns (pattern and depth)", () => {
    const random = lcg(20_261_126);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    for (let index = 0; index < 4_000; index += 1) {
      const depth = 1 + Math.floor(random() * 7);
      const candidate = Array.from({ length: depth }, () => pick(SEGMENTS)).join("/");
      const lastIsDirectory = random() < 0.5;
      const patterns = PATTERNS.filter(() => random() < 0.25);
      if (random() < 0.5) patterns.reverse();
      const actual = findFirstAncestorIgnoreMatch(candidate, lastIsDirectory, patterns, {
        budget: { remaining: Number.POSITIVE_INFINITY },
      });
      expect(actual, `${candidate} (dir=${String(lastIsDirectory)}) vs ${JSON.stringify(patterns)}`).toEqual(
        referenceAncestorMatch(candidate, lastIsDirectory, patterns),
      );
    }
  });

  it("reports budget exhaustion instead of finishing an unbounded match", () => {
    const chain = Array.from({ length: 64 }, () => "a").join("/");
    const patterns = Array.from({ length: 50 }, (_, i) => `**/${chain}/b${String(i)}`);
    const candidate = Array.from({ length: 200 }, () => "a").join("/");
    const budget = { remaining: 10_000 };
    expect(findFirstAncestorIgnoreMatch(candidate, true, patterns, { budget })).toEqual({
      kind: "budget-exhausted",
    });
    expect(budget.remaining).toBeLessThanOrEqual(0);
  });

  it("matches the security deny rules case-insensitively when asked to, whatever the platform", () => {
    const budget = { remaining: Number.POSITIVE_INFINITY };
    expect(
      findFirstAncestorIgnoreMatch("src/.GIT/config", false, ["**/.git/**"], { budget, caseInsensitive: true }),
    ).toEqual({ kind: "matched", pattern: "**/.git/**", depth: 2 });
    expect(
      findFirstAncestorIgnoreMatch("src/.GIT/config", false, ["**/.git/**"], { budget, caseInsensitive: false }),
    ).toEqual({ kind: "none" });
  });
});

describe("WorkspaceAccessPolicy — bounded ignore matching (F32)", () => {
  it("fails closed with a budget rule for an adversarial .gitignore against a deep path", () => {
    const root = makeRoot();
    const chain = Array.from({ length: 32 }, () => "a").join("/");
    const extraIgnore = Array.from({ length: 200 }, (_, i) => `**/${chain}/b${String(i).padStart(4, "0")}`);
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root], extraIgnore });
    const deep = `${Array.from({ length: 128 }, () => "a").join("/")}/file.txt`;

    const started = performance.now();
    const denial = denyOf(policy.checkPath(root, deep));
    const elapsedMs = performance.now() - started;
    expect(denial).toEqual({ code: "workspace/path-denied", rule: "ignore-match-budget" });
    expect(elapsedMs, `budgeted decision took ${elapsedMs.toFixed(0)} ms`).toBeLessThan(2_000);

    // The budget belongs to one decision: an ordinary path is still decided normally.
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "app.ts"), "export const a = 1;\n");
    expect(policy.checkFile(root, "src/app.ts").allowed).toBe(true);
  });

  it("stays well inside the budget for a large but ordinary ignore list on a deep path", () => {
    const root = makeRoot();
    const extraIgnore: string[] = [];
    for (let i = 0; i < 250; i += 1) {
      extraIgnore.push(`*.ext${String(i)}`, `/build${String(i)}`, `docs${String(i)}/`, `**/tmp${String(i)}/**`);
    }
    expect(extraIgnore.length).toBe(1_000);
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root], extraIgnore });
    const deepDir = Array.from({ length: 30 }, (_, i) => `level-${String(i)}`).join("/");
    mkdirSync(path.join(root, ...deepDir.split("/")), { recursive: true });
    writeFileSync(path.join(root, ...deepDir.split("/"), "module.ts"), "export const m = 1;\n");
    writeFileSync(path.join(root, ...deepDir.split("/"), "data.ext249"), "x");

    expect(policy.checkFile(root, `${deepDir}/module.ts`).allowed).toBe(true);
    expect(denyOf(policy.checkFile(root, `${deepDir}/data.ext249`)).rule).toBe("*.ext249");
    expect(denyOf(policy.checkPath(root, `${deepDir}/tmp7/x.ts`)).rule).toBe("**/tmp7/**");
  });
});

/** Imports a fresh copy of the package with `process.platform` reporting `platform` at load time. */
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

function seedSecrets(root: string): void {
  mkdirSync(path.join(root, ".git"), { recursive: true });
  writeFileSync(path.join(root, ".git", "config"), "[core]\n");
  mkdirSync(path.join(root, "src", ".git"), { recursive: true });
  writeFileSync(path.join(root, "src", ".git", "HEAD"), "ref: x\n");
  writeFileSync(path.join(root, ".env.local"), "SECRET=1\n");
  writeFileSync(path.join(root, "server-key.pem"), "-----BEGIN\n");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "app.ts"), "export const a = 1;\n");
  mkdirSync(path.join(root, "Dist"), { recursive: true });
  writeFileSync(path.join(root, "Dist", "app.ts"), "export const d = 1;\n");
}

const RECASED_SECRETS: ReadonlyArray<readonly [string, string]> = [
  [".GIT/config", "**/.git/**"],
  [".Git", "**/.git/**"],
  ["src/.GIT/HEAD", "**/.git/**"],
  [".ENV.local", "**/.env*"],
  [".Env.yaml", "**/.env*"],
  ["SERVER-KEY.PEM", "**/*.pem"],
  ["certs/Key.Pem", "**/*.pem"],
];

describe("WorkspaceAccessPolicy — letter-case aliases of secret deny rules (F44)", () => {
  it("denies re-cased .git / .env* / *.pem paths on a case-sensitive-matching platform (linux simulated)", async () => {
    const ws = await importWorkspaceAs("linux");
    const root = makeRoot();
    seedSecrets(root);
    const policy = ws.WorkspaceAccessPolicy.create({ allowRoots: [root] });
    for (const [candidate, rule] of RECASED_SECRETS) {
      const decision = policy.checkFile(root, candidate);
      expect(decision.allowed, candidate).toBe(false);
      if (!decision.allowed) expect(decision.rule, candidate).toBe(rule);
    }
    // Other patterns keep case-sensitive semantics: `Dist/` is not `dist/` here.
    expect(policy.checkFile(root, "Dist/app.ts").allowed).toBe(true);
    expect(policy.checkFile(root, "src/app.ts").allowed).toBe(true);
    // The exported single-pattern matcher keeps the platform's case semantics.
    expect(ws.matchesIgnorePattern("SRC/.GIT/HEAD", false, "**/.git/**")).toBe(false);
  });

  it("applies the case-folded deny rules only when they are configured (linux simulated)", async () => {
    const ws = await importWorkspaceAs("linux");
    const root = makeRoot();
    seedSecrets(root);
    const policy = ws.WorkspaceAccessPolicy.create({ allowRoots: [root], ignore: ["**/vendor/**"] });
    expect(policy.checkFile(root, ".GIT/config").allowed).toBe(true);
    expect(policy.checkFile(root, ".git/config").allowed).toBe(true);
  });

  it.skipIf(IS_WIN)("denies re-cased secret paths on the real host filesystem", () => {
    const root = makeRoot();
    seedSecrets(root);
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root] });
    for (const [candidate, rule] of RECASED_SECRETS) {
      const decision = policy.checkFile(root, candidate);
      expect(decision.allowed, candidate).toBe(false);
      if (!decision.allowed) expect(decision.rule, candidate).toBe(rule);
    }
    expect(policy.checkFile(root, "src/app.ts").allowed).toBe(true);
  });
});

// Linux casefold before 6.12 ignores default-ignorable code points when it
// compares names, so `.g<U+200D>it` can open `.git` there.
const DEFAULT_IGNORABLE_ALIASES: ReadonlyArray<readonly [string, string]> = [
  [".g‍it/config", "**/.git/**"], // ZERO WIDTH JOINER
  ["src/.​git/HEAD", "**/.git/**"], // ZERO WIDTH SPACE
  [".e­nv.local", "**/.env*"], // SOFT HYPHEN
  ["key.p⁠em", "**/*.pem"], // WORD JOINER
  ["key.pem﻿", "**/*.pem"], // ZERO WIDTH NO-BREAK SPACE
];

describe("lookAlikeFold — default-ignorable code points (F44)", () => {
  it("drops default-ignorable code points, as pre-6.12 Linux casefold does", () => {
    expect(lookAlikeFold(".g‍it")).toBe(".git");
    expect(lookAlikeFold(".e­nv͏")).toBe(".env");
    expect(lookAlikeFold("a᠋b️c")).toBe("abc");
    // Ordinary characters are kept.
    expect(lookAlikeFold("Src-Dir_1.ts")).toBe("src-dir_1.ts");
  });

  for (const platform of ["linux", "win32"] as const) {
    // A simulated win32 policy requires drive-letter allowRoots: only a Windows
    // host has temp directories of that form.
    it.skipIf(platform === "win32" && process.platform !== "win32")(
      `denies .git / .env* / *.pem names padded with default-ignorable code points (${platform} simulated)`,
      async () => {
        const ws = await importWorkspaceAs(platform);
        const root = makeRoot();
        seedSecrets(root);
        const policy = ws.WorkspaceAccessPolicy.create({ allowRoots: [root] });
        for (const [candidate, rule] of DEFAULT_IGNORABLE_ALIASES) {
          const decision = policy.checkFile(root, candidate);
          expect(decision.allowed, JSON.stringify(candidate)).toBe(false);
          if (!decision.allowed) expect(decision.rule, JSON.stringify(candidate)).toBe(rule);
        }
        expect(policy.checkFile(root, "src/app.ts").allowed).toBe(true);
      },
    );
  }
});

describe("WorkspaceAccessPolicy — ignore work budget per pass (F32)", () => {
  it("does not drop a path reached through an in-root link when each pass fits the budget", () => {
    const root = makeRoot();
    // About 650k steps for one pass over this path: two passes (lexical spelling
    // through the link, then the canonical real path) exceed one 1M budget.
    const extraIgnore = Array.from({ length: 3_500 }, (_, i) => `*.ext${String(i)}`);
    const dirs = Array.from({ length: 12 }, (_, i) => `dir-${String(i).padStart(2, "0")}-abcde`);
    mkdirSync(path.join(root, "real", ...dirs), { recursive: true });
    writeFileSync(path.join(root, "real", ...dirs, "module.ts"), "export const m = 1;\n");
    symlinkSync(path.join(root, "real"), path.join(root, "link"), IS_WIN ? "junction" : "dir");
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root], extraIgnore });

    const direct = policy.checkFile(root, ["real", ...dirs, "module.ts"].join("/"));
    expect(direct.allowed).toBe(true);
    const viaLink = policy.checkFile(root, ["link", ...dirs, "module.ts"].join("/"));
    expect(viaLink.allowed, viaLink.allowed ? "" : `${viaLink.rule ?? ""}: ${viaLink.reason}`).toBe(true);
    if (viaLink.allowed) expect(viaLink.relativePath).toBe(["real", ...dirs, "module.ts"].join("/"));
  });

  it("reports the ignore work of each decision and counts budget denials on a meter", () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "app.ts"), "export const a = 1;\n");
    const chain = Array.from({ length: 32 }, () => "a").join("/");
    const crafted = Array.from({ length: 200 }, (_, i) => `**/${chain}/b${String(i).padStart(4, "0")}`);
    const policy = WorkspaceAccessPolicy.create({ allowRoots: [root], extraIgnore: crafted });
    const meter: IgnoreWorkMeter = { steps: 0, budgetDenials: 0 };

    expect(policy.checkFile(root, "src/app.ts", undefined, { ignoreWork: meter }).allowed).toBe(true);
    expect(meter.steps).toBeGreaterThan(0);
    expect(meter.budgetDenials).toBe(0);
    const afterOrdinary = meter.steps;

    const deep = `${Array.from({ length: 128 }, () => "a").join("/")}/file.txt`;
    const denial = denyOf(policy.checkPath(root, deep, { ignoreWork: meter }));
    expect(denial.rule).toBe("ignore-match-budget");
    expect(meter.budgetDenials).toBe(1);
    expect(meter.steps - afterOrdinary).toBeGreaterThanOrEqual(IGNORE_MATCH_WORK_BUDGET);
  });
});
