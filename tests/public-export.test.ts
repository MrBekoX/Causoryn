import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Seçenek 1 temiz açık kaynak ağacı dışa aktarıcısı (`scripts/export-public-tree.mjs`)
 * pozitif + negatif fail-closed doğrulama testleri (F-P0-01, F-P1-02, F-P2-09, K-022).
 */

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(THIS_DIR);
const EXPORT_SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "export-public-tree.mjs");

/**
 * Synthetic bait values, assembled at runtime so this file never matches the
 * scanner rules. Personal names and internal identifiers are modelled as
 * private terms (configured per repository in the untracked
 * `.git/info/causoryn-private-terms`); local machine paths as generic
 * absolute drive-letter paths in documentation.
 */
const BAIT_PRIVATE_NAME = ["alice", "sample"].join("-");
const BAIT_INTERNAL_RUN_ID = ["runid", "sample", "0001"].join("-");
const BAIT_DRIVE_REPO = "D:" + "\\Work\\Sample";
const BAIT_DRIVE_TOOLS = "D:" + "\\Work\\Toolchain\\go\\bin\\go.exe";
/** Marker lines delimiting local-only entries that the export strips. */
const LOCAL_ONLY_BEGIN_HASH = "# causoryn-export:local-only begin";
const LOCAL_ONLY_END_HASH = "# causoryn-export:local-only end";
const LOCAL_ONLY_BEGIN_SLASH = "// causoryn-export:local-only begin";
const LOCAL_ONLY_END_SLASH = "// causoryn-export:local-only end";
const BAIT_GH_PAT = "github_" + "pat_" + "11AAAAAA00000000000000_BBBBBBBBBB";
const BAIT_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const BAIT_WIN_PROFILE = "C:" + "\\Users\\" + "alice" + "\\project";

interface VerifyResult {
  readonly ok: boolean;
  readonly findings: readonly string[];
  readonly fileCount: number;
}

interface ExportResult {
  readonly outDir: string;
  readonly ref: string;
  readonly exportedFiles: readonly string[];
  readonly verification: VerifyResult;
}

interface ExportPublicTreeModule {
  readonly exportPublicTree: (options: {
    readonly repoRoot: string;
    readonly outDir: string;
    readonly ref?: string;
  }) => ExportResult;
  readonly verifyPublicTree: (exportedDir: string) => VerifyResult;
}

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeRel(rootDir: string, relPosix: string, content: string): void {
  const target = path.join(rootDir, ...relPosix.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

const PRIVATE_FILE_PATHS = [
  "raw/Causoryn_Teknik_Dokuman_v2.1.pdf",
  "raw/context-inject/tech/third-party.md",
  "wiki/sprint-8.md",
  "docs/superpowers/plans/2026-11-20-plan.md",
  "START-PROMPT.md",
  "OPEN-SOURCE-READINESS-PROMPT.md",
  "AGENTS.md",
] as const;

function createSyntheticGitRepo(
  extraFiles?: Readonly<Record<string, string>>,
  options?: { readonly includePrivateFiles?: boolean },
): string {
  const repoDir = createTempDir("causoryn-pubexport-repo-");

  const baseFiles: Record<string, string> = {
    LICENSE: "MIT License\nCopyright (c) 2026 Causoryn Contributors\n",
    "SECURITY.md": "# Security Policy\n",
    "CONTRIBUTING.md": "# Contributing\n",
    "CODE_OF_CONDUCT.md": "# Code of Conduct\n",
    "README.md": "# Causoryn\n",
    "CHANGELOG.md": "# Changelog\n## [0.2.0] - 2026-11-20\n",
    "server.json": '{"name":"io.github.mrbekox/causoryn","version":"0.2.0"}\n',
    ".gitattributes": "* text=auto eol=lf\n",
    ".gitignore": [
      "node_modules/",
      "dist/",
      "# Yerel geçici çıktı dizinleri (asla commit edilmez)",
      LOCAL_ONLY_BEGIN_HASH,
      ".tool-cache/",
      ".scratch-agent/",
      LOCAL_ONLY_END_HASH,
      "out/",
      "",
    ].join("\n"),
    ".github/workflows/ci.yml": "name: CI\n",
    ".github/workflows/release.yml": "name: Release\n",
    "packages/causoryn/package.json": '{"name":"causoryn","version":"0.2.0"}\n',
    "packages/core/src/index.ts": 'export const version = "0.2.0";\n',
    // Test bait files carry split literals (non-matching by construction);
    // there is no per-file exemption:
    "tests/security-release/f6-security-release.test.ts": '// canary: "AKIA" + "IOSFODNN7EXAMPLE"\n',
    "packages/causoryn/test/setup-and-doctor.test.ts":
      'const sample = "C:\\\\Users\\\\demo\\\\.causoryn\\\\runtime\\\\scripts\\\\causoryn.mjs";\n',
    // Dışlanması gereken özel / telifli / iç dosyalar:
    "raw/Causoryn_Teknik_Dokuman_v2.1.pdf": "PRIVATE PDF",
    "raw/context-inject/tech/third-party.md": `Verbatim ${BAIT_PRIVATE_NAME} note`,
    "wiki/sprint-8.md": `Internal wiki ${BAIT_INTERNAL_RUN_ID}`,
    "docs/superpowers/plans/2026-11-20-plan.md": `Internal plan ${BAIT_DRIVE_REPO}`,
    "START-PROMPT.md": "Internal start prompt\n",
    "OPEN-SOURCE-READINESS-PROMPT.md": "Internal audit prompt\n",
    "AGENTS.md": "Internal agent contract\n",
    ...(extraFiles ?? {}),
  };
  if (options?.includePrivateFiles === false) {
    for (const rel of PRIVATE_FILE_PATHS) delete baseFiles[rel];
  }

  for (const [rel, content] of Object.entries(baseFiles)) {
    writeRel(repoDir, rel, content);
  }

  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Causoryn Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Causoryn Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  execFileSync("git", ["init", "-q"], { cwd: repoDir, env: gitEnv, shell: false });
  execFileSync("git", ["add", "-A"], { cwd: repoDir, env: gitEnv, shell: false });
  execFileSync("git", ["commit", "-q", "-m", "init synthetic repo"], {
    cwd: repoDir,
    env: gitEnv,
    shell: false,
  });
  // Untracked, local-only private term list (never committed):
  writeFileSync(
    path.join(repoDir, ".git", "info", "causoryn-private-terms"),
    `# local only\n${BAIT_PRIVATE_NAME}\n${BAIT_INTERNAL_RUN_ID}\n`,
    "utf8",
  );

  return repoDir;
}

const SYNTHETIC_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Causoryn Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Causoryn Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function gitIn(repoDir: string, args: readonly string[], input?: string): string {
  return execFileSync("git", [...args], {
    cwd: repoDir,
    env: SYNTHETIC_GIT_ENV,
    encoding: "utf8",
    shell: false,
    ...(input !== undefined ? { input } : {}),
  });
}

/**
 * Adds a raw index entry (any mode/path) without touching the working tree,
 * then commits. `core.protectNTFS=false` lets Git for Windows record paths a
 * POSIX contributor could commit (for example a backslash in a file name).
 */
function commitRawEntry(repoDir: string, mode: string, relPath: string, content: string): void {
  const blob = gitIn(repoDir, ["hash-object", "-w", "--stdin"], content).trim();
  gitIn(repoDir, [
    "-c",
    "core.protectNTFS=false",
    "update-index",
    "--add",
    "--cacheinfo",
    `${mode},${blob},${relPath}`,
  ]);
  gitIn(repoDir, ["-c", "core.protectNTFS=false", "commit", "-q", "-m", `raw entry ${relPath}`]);
}

async function loadExporter(): Promise<ExportPublicTreeModule> {
  expect(existsSync(EXPORT_SCRIPT_PATH), "scripts/export-public-tree.mjs mevcut olmalı").toBe(true);
  return (await import(pathToFileURL(EXPORT_SCRIPT_PATH).href)) as ExportPublicTreeModule;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/export-public-tree.mjs — Seçenek 1 temiz açık kaynak dışa aktarıcı", { timeout: 60_000 }, () => {
  it("POZİTİF: raw/, wiki/, docs/superpowers/ ve iç prompt dosyalarını dışlar, .gitignore'ı temizler ve fail-closed doğrulamayı geçer", async () => {
    const { exportPublicTree } = await loadExporter();
    const repoDir = createSyntheticGitRepo();
    const outDir = path.join(createTempDir("causoryn-pubexport-out-"), "clean-tree");

    const result = exportPublicTree({ repoRoot: repoDir, outDir, ref: "HEAD" });
    expect(result.verification.ok, JSON.stringify(result.verification.findings)).toBe(true);
    expect(result.verification.findings).toEqual([]);

    // Zorunlu açık kaynak dosyaları mevcut:
    for (const required of [
      "LICENSE",
      "SECURITY.md",
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "README.md",
      "CHANGELOG.md",
      "server.json",
      ".gitattributes",
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
      "packages/causoryn/package.json",
    ]) {
      expect(existsSync(path.join(outDir, ...required.split("/"))), `${required} eksik`).toBe(true);
    }

    // Dışlanan yollar kesinlikle yok:
    for (const excluded of [
      "raw",
      "wiki",
      "docs/superpowers",
      "START-PROMPT.md",
      "OPEN-SOURCE-READINESS-PROMPT.md",
      "AGENTS.md",
    ]) {
      expect(
        existsSync(path.join(outDir, ...excluded.split("/"))),
        `dışlanan yol sızdı: ${excluded}`,
      ).toBe(false);
    }

    // .gitignore iç araç satırları temizlenmiş, meşru girdiler korunmuş:
    const gitignore = readFileSync(path.join(outDir, ".gitignore"), "utf8");
    expect(gitignore).not.toContain(".tool-cache/");
    expect(gitignore).not.toContain(".scratch-agent/");
    expect(gitignore).not.toContain("causoryn-export:local-only");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("dist/");
    expect(gitignore).toContain("out/");

    // The exported tree is exactly the committed tree minus private paths:
    const committed = gitIn(repoDir, ["ls-tree", "-r", "--name-only", "--full-tree", "HEAD"])
      .split("\n")
      .filter((rel) => rel.length > 0 && !(PRIVATE_FILE_PATHS as readonly string[]).includes(rel))
      .sort();
    expect([...result.exportedFiles]).toEqual(committed);
  });

  it("CLI: node scripts/export-public-tree.mjs --repo <repo> --out <dir> exit 0 ile temiz çıktı üretir", () => {
    expect(existsSync(EXPORT_SCRIPT_PATH)).toBe(true);
    const repoDir = createSyntheticGitRepo();
    const outDir = path.join(createTempDir("causoryn-pubexport-cli-"), "exported");

    const res = spawnSync(
      process.execPath,
      [EXPORT_SCRIPT_PATH, "--repo", repoDir, "--out", outDir, "--ref", "HEAD"],
      { cwd: os.tmpdir(), encoding: "utf8", shell: false },
    );
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("PUBLIC_EXPORT PASS");
    expect(existsSync(path.join(outDir, "raw"))).toBe(false);
    expect(existsSync(path.join(outDir, "LICENSE"))).toBe(true);
  });

  it("CLI: --verify-temp --ref HEAD geçici dizinde fail-closed doğrular, exit 0 döner ve geçici dizini temizler", () => {
    // --verify-temp gates the ref as it is published by `git push`, so the
    // positive case is a repository that does not track private paths:
    const repoDir = createSyntheticGitRepo(undefined, { includePrivateFiles: false });
    const res = spawnSync(
      process.execPath,
      [EXPORT_SCRIPT_PATH, "--repo", repoDir, "--verify-temp", "--ref", "HEAD"],
      { cwd: os.tmpdir(), encoding: "utf8", shell: false },
    );
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("PUBLIC_EXPORT PASS");
    const pathMatch = res.stdout.match(/→\s*(.+?)\s*(?:\(|$)/m);
    const exportedTmp = pathMatch?.[1]?.trim();
    if (exportedTmp) {
      expect(existsSync(exportedTmp), `geçici dizin temizlenmeli: ${exportedTmp}`).toBe(false);
    }

    // Negatif: sızıntılı repoda --verify-temp exit 1 döner VE geçici dizin sızdırmaz:
    const leakyRepo = createSyntheticGitRepo(
      { "docs/leak-temp.md": `token=${BAIT_GH_PAT}\n` },
      { includePrivateFiles: false },
    );
    const tmpBefore = new Set(
      readdirSync(os.tmpdir()).filter((name) => name.startsWith("causoryn-export-gate-")),
    );
    const redRes = spawnSync(
      process.execPath,
      [EXPORT_SCRIPT_PATH, "--repo", leakyRepo, "--verify-temp", "--ref", "HEAD"],
      { cwd: os.tmpdir(), encoding: "utf8", shell: false },
    );
    expect(redRes.status).toBe(1);
    expect(redRes.stderr).toContain("PUBLIC_EXPORT FAIL");
    expect(redRes.stderr).toContain("docs/leak-temp.md:1 — github-fine-grained-pat");
    const leakedTmpDirs = readdirSync(os.tmpdir()).filter(
      (name) => name.startsWith("causoryn-export-gate-") && !tmpBefore.has(name),
    );
    expect(leakedTmpDirs, "hata sonrasında da geçici dizin temizlenmeli").toEqual([]);

    // Negative: private paths that are tracked in the ref are published by
    // `git push` even though a clean `--out` export prunes them:
    const trackedPrivateRepo = createSyntheticGitRepo();
    const privateRes = spawnSync(
      process.execPath,
      [EXPORT_SCRIPT_PATH, "--repo", trackedPrivateRepo, "--verify-temp", "--ref", "HEAD"],
      { cwd: os.tmpdir(), encoding: "utf8", shell: false },
    );
    expect(privateRes.status).toBe(1);
    for (const rel of PRIVATE_FILE_PATHS) {
      expect(privateRes.stderr, rel).toContain(`private path tracked in ref: ${rel}`);
    }
  });

  it("NEGATİF: dolu çıkış dizini (--out) fail-closed reddedilir", async () => {
    const { exportPublicTree } = await loadExporter();
    const repoDir = createSyntheticGitRepo();
    const nonEmptyDir = createTempDir("causoryn-pubexport-nonempty-");
    writeFileSync(path.join(nonEmptyDir, "existing.txt"), "data", "utf8");

    expect(() => exportPublicTree({ repoRoot: repoDir, outDir: nonEmptyDir, ref: "HEAD" })).toThrow(
      /must be empty/i,
    );
  });

  it("NEGATİF: geçersiz/tehlikeli Git ref fail-closed reddedilir", async () => {
    const { exportPublicTree } = await loadExporter();
    const repoDir = createSyntheticGitRepo();
    const outDir = path.join(createTempDir("causoryn-pubexport-badref-"), "out");

    expect(() =>
      exportPublicTree({ repoRoot: repoDir, outDir, ref: "--output=/tmp/pwn" }),
    ).toThrow(/ref/i);
  });

  it("NEGATİF: dışa aktarılan ağaçta kişisel kullanıcı adı, yerel yol, iç çalışma kimliği veya sır sızıntısı varsa fail-closed reddedilir", async () => {
    const { exportPublicTree } = await loadExporter();
    const leakyRepo = createSyntheticGitRepo({
      "docs/leaked-guide.md": [
        `user: ${BAIT_PRIVATE_NAME}`,
        `win: ${BAIT_WIN_PROFILE}`,
        `repo: ${BAIT_DRIVE_REPO}`,
        `tools: ${BAIT_DRIVE_TOOLS}`,
        `run: ${BAIT_INTERNAL_RUN_ID}`,
        `token: ${BAIT_GH_PAT}`,
      ].join("\n"),
    });
    const outDir = path.join(createTempDir("causoryn-pubexport-leak-"), "out");

    let message = "";
    try {
      exportPublicTree({ repoRoot: leakyRepo, outDir, ref: "HEAD" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/PUBLIC_EXPORT FAIL — verification failed/);
    expect(message).toContain("docs/leaked-guide.md:1 — private-term-1");
    expect(message).toContain("docs/leaked-guide.md:2 — local-user-profile-path");
    expect(message).toContain("docs/leaked-guide.md:3 — local-drive-path");
    expect(message).toContain("docs/leaked-guide.md:4 — local-drive-path");
    expect(message).toContain("docs/leaked-guide.md:5 — private-term-2");
    expect(message).toContain("docs/leaked-guide.md:6 — github-fine-grained-pat");
    // Findings never echo the private terms themselves:
    expect(message).not.toContain(BAIT_PRIVATE_NAME);
    expect(message).not.toContain(BAIT_INTERNAL_RUN_ID);
  });

  it("NEGATIVE: files hidden by .gitattributes export-ignore are still scanned and export-subst is not applied (scanned set = committed tree)", async () => {
    const { exportPublicTree } = await loadExporter();
    const hiddenLeakRepo = createSyntheticGitRepo({
      ".gitattributes": "* text=auto eol=lf\ndocs/hidden.md export-ignore\n",
      "docs/hidden.md": `token: ${BAIT_GH_PAT}\n`,
    });
    const hiddenOut = path.join(createTempDir("causoryn-pubexport-hidden-"), "out");
    expect(() => exportPublicTree({ repoRoot: hiddenLeakRepo, outDir: hiddenOut, ref: "HEAD" })).toThrow(
      /docs\/hidden\.md:1 — github-fine-grained-pat/,
    );

    const substRepo = createSyntheticGitRepo({
      ".gitattributes": "* text=auto eol=lf\ndocs/version.md export-subst\ndocs/kept.md export-ignore\n",
      "docs/version.md": "Commit: $Format:%H$\n",
      "docs/kept.md": "clean\n",
    });
    const substOut = path.join(createTempDir("causoryn-pubexport-subst-"), "out");
    const res = exportPublicTree({ repoRoot: substRepo, outDir: substOut, ref: "HEAD" });
    expect(res.verification.ok, JSON.stringify(res.verification.findings)).toBe(true);
    expect(readFileSync(path.join(substOut, "docs", "version.md"), "utf8")).toBe("Commit: $Format:%H$\n");
    expect(res.exportedFiles).toContain("docs/kept.md");
  });

  it("NEGATIVE: test bait files have no exemption — a joined secret or profile path in tests/ fails the export", async () => {
    const { exportPublicTree } = await loadExporter();
    for (const [rel, content, rule] of [
      ["tests/security-release/f6-security-release.test.ts", `// canary: ${BAIT_AWS_KEY}\n`, "aws-access-key"],
      ["packages/causoryn/test/setup-and-doctor.test.ts", `const p = "${BAIT_WIN_PROFILE}";\n`, "local-user-profile-path"],
    ] as const) {
      const repoDir = createSyntheticGitRepo({ [rel]: content });
      const outDir = path.join(createTempDir("causoryn-pubexport-bait-"), "out");
      expect(() => exportPublicTree({ repoRoot: repoDir, outDir, ref: "HEAD" }), rel).toThrow(
        new RegExp(`${rel.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}:1 — ${rule}`),
      );
    }
  });

  it("FAIL-CLOSED: symbolic links, gitlinks and unsafe tree paths are rejected instead of being materialized", async () => {
    const { exportPublicTree } = await loadExporter();
    const cases: ReadonlyArray<readonly [string, string, string, RegExp]> = [
      ["120000", "docs/link.md", "../../outside.txt", /unsupported tree entry \(symbolic link\): docs\/link\.md/],
      ["100644", "docs\\escape.md", "clean\n", /unsafe tree path/],
      ["100644", "docs/a:b.md", "clean\n", /unsafe tree path/],
    ];
    for (const [mode, rel, content, expected] of cases) {
      const repoDir = createSyntheticGitRepo();
      commitRawEntry(repoDir, mode, rel, content);
      const outDir = path.join(createTempDir("causoryn-pubexport-entry-"), "out");
      expect(() => exportPublicTree({ repoRoot: repoDir, outDir, ref: "HEAD" }), rel).toThrow(expected);
      expect(existsSync(path.join(path.dirname(outDir), "outside.txt"))).toBe(false);
    }

    const gitlinkRepo = createSyntheticGitRepo();
    const headOid = gitIn(gitlinkRepo, ["rev-parse", "HEAD"]).trim();
    gitIn(gitlinkRepo, ["update-index", "--add", "--cacheinfo", `160000,${headOid},vendor/sub`]);
    gitIn(gitlinkRepo, ["commit", "-q", "-m", "gitlink"]);
    const gitlinkOut = path.join(createTempDir("causoryn-pubexport-gitlink-"), "out");
    expect(() => exportPublicTree({ repoRoot: gitlinkRepo, outDir: gitlinkOut, ref: "HEAD" })).toThrow(
      /unsupported tree entry \(submodule\): vendor\/sub/,
    );
  });

  it("NEGATİF: verifyPublicTree dışlanan yol sızıntısını ve eksik zorunlu dosyayı yakalar", async () => {
    const { exportPublicTree, verifyPublicTree } = await loadExporter();
    const repoDir = createSyntheticGitRepo();
    const outDir = path.join(createTempDir("causoryn-pubexport-verify-"), "out");
    exportPublicTree({ repoRoot: repoDir, outDir, ref: "HEAD" });

    // 1) Dışlanan dosya sızıntısı:
    writeRel(outDir, "raw/sneaked.txt", "oops");
    // 2) Zorunlu dosya eksikliği:
    rmSync(path.join(outDir, "SECURITY.md"));

    const check = verifyPublicTree(outDir);
    expect(check.ok).toBe(false);
    expect(check.findings.some((f) => f.includes("raw/sneaked.txt"))).toBe(true);
    expect(check.findings.some((f) => f.includes("SECURITY.md"))).toBe(true);
  });

  it("SINIR: THIRD-PARTY-NOTICES.md içindeki üst-akım telif e-postası kabul edilirken gerçek token, eğik çizgili/Linux profil yolu ve eslint iç-dizinleri doğru işlenir", async () => {
    const { exportPublicTree, verifyPublicTree } = await loadExporter();
    const syntheticEmail = ["upstream.author", "gmail.com"].join("@");
    const repoDir = createSyntheticGitRepo({
      "THIRD-PARTY-NOTICES.md": `Copyright Upstream Author <${syntheticEmail}>\n`,
      "licenses/upstream.txt": `Copyright Upstream Author <${syntheticEmail}>\n`,
      "docs/dev-example.md": "Example: C:\\Users\\dev\\repo and /home/dev/repo\n",
      "eslint.config.js": [
        "export default [{ ignores: [",
        `  ${LOCAL_ONLY_BEGIN_SLASH}`,
        '  ".scratch-agent/**",',
        '  ".tool-cache/**",',
        `  ${LOCAL_ONLY_END_SLASH}`,
        '  "dist/**",',
        "] }];",
        "",
      ].join("\n"),
    });
    const outDir = path.join(createTempDir("causoryn-pubexport-notices-"), "out");
    const res = exportPublicTree({ repoRoot: repoDir, outDir, ref: "HEAD" });
    expect(res.verification.ok, JSON.stringify(res.verification.findings)).toBe(true);

    const exportedEslint = readFileSync(path.join(outDir, "eslint.config.js"), "utf8");
    expect(exportedEslint).not.toContain(".tool-cache");
    expect(exportedEslint).not.toContain(".scratch-agent");
    expect(exportedEslint).not.toContain("causoryn-export:local-only");
    expect(exportedEslint).toContain('"dist/**"');

    writeRel(outDir, "THIRD-PARTY-NOTICES.md", `leaked=${BAIT_GH_PAT}\n`);
    const badCheck = verifyPublicTree(outDir);
    expect(badCheck.ok).toBe(false);
    expect(badCheck.findings.some((f) => f.includes("github-fine-grained-pat"))).toBe(true);
    writeRel(outDir, "THIRD-PARTY-NOTICES.md", `Copyright Upstream Author <${syntheticEmail}>\n`);

    const slashLeak = "C:" + "/Users/" + "alice" + "/repo";
    writeRel(outDir, "docs/leak-slash.md", `Path: ${slashLeak}\n`);
    const slashCheck = verifyPublicTree(outDir);
    expect(slashCheck.ok).toBe(false);
    expect(slashCheck.findings.some((f) => f.includes("local-user-profile-path"))).toBe(true);
    rmSync(path.join(outDir, "docs", "leak-slash.md"));

    const linuxLeak = "/home/" + "alice" + "/repo";
    writeRel(outDir, "docs/leak-linux.md", `Path: ${linuxLeak}\n`);
    const linuxCheck = verifyPublicTree(outDir);
    expect(linuxCheck.ok).toBe(false);
    expect(linuxCheck.findings.some((f) => f.includes("local-user-profile-path"))).toBe(true);
  });

  it("GÜVENLİK (#37, #38): yerinde fd yeniden yazımı kısalan CRLF .gitignore ve eslint.config.js dosyalarında artık bayt/NUL bırakmaz ve temiz içerikleri bayt-bayt korur", async () => {
    const { exportPublicTree } = await loadExporter();
    // 1) CRLF + uzun iç satırlar kaldırıldığında dosya ciddi oranda kısalır -> ftruncate + offset-0 writeSync doğrulaması
    const crlfRepo = createSyntheticGitRepo({
      ".gitattributes": ".gitignore -text\neslint.config.js -text\n",
      ".gitignore": [
        "node_modules/",
        `   ${LOCAL_ONLY_BEGIN_HASH}   `,
        "   .tool-cache/   ",
        "   .scratch-agent/   ",
        `   ${LOCAL_ONLY_END_HASH}   `,
        "dist/",
        "",
      ].join("\r\n"),
      "eslint.config.js": [
        "export default [{ ignores: [",
        `    ${LOCAL_ONLY_BEGIN_SLASH}   `,
        '    ".tool-cache/**",   ',
        '    ".scratch-agent/**",   ',
        `    ${LOCAL_ONLY_END_SLASH}   `,
        '  "dist/**",',
        "] }];",
        "",
      ].join("\r\n"),
    });
    const outCrlf = path.join(createTempDir("causoryn-pubexport-crlf-"), "out");
    const crlfRes = exportPublicTree({ repoRoot: crlfRepo, outDir: outCrlf, ref: "HEAD" });
    expect(crlfRes.verification.ok, JSON.stringify(crlfRes.verification.findings)).toBe(true);

    const sanitizedGitignore = readFileSync(path.join(outCrlf, ".gitignore"), "utf8");
    expect(sanitizedGitignore).toBe(["node_modules/", "dist/", ""].join("\r\n"));
    expect(sanitizedGitignore.includes("\0")).toBe(false);

    const sanitizedEslint = readFileSync(path.join(outCrlf, "eslint.config.js"), "utf8");
    expect(sanitizedEslint).toBe(
      ["export default [{ ignores: [", '  "dist/**",', "] }];", ""].join("\r\n"),
    );
    expect(sanitizedEslint.includes("\0")).toBe(false);

    // 2) Değişiklik gerektirmeyen temiz .gitignore bayt-bayt korunur ve eslint.config.js yokken hata vermez
    const cleanGitignore = "node_modules/\ndist/\n";
    const unchangedRepo = createSyntheticGitRepo({
      ".gitignore": cleanGitignore,
    });
    const outUnchanged = path.join(createTempDir("causoryn-pubexport-unchanged-"), "out");
    const unchangedRes = exportPublicTree({ repoRoot: unchangedRepo, outDir: outUnchanged, ref: "HEAD" });
    expect(unchangedRes.verification.ok, JSON.stringify(unchangedRes.verification.findings)).toBe(true);
    expect(readFileSync(path.join(outUnchanged, ".gitignore"), "utf8")).toBe(cleanGitignore);
    expect(existsSync(path.join(outUnchanged, "eslint.config.js"))).toBe(false);

    // 3) An unterminated local-only block fails closed instead of exporting
    //    a half-sanitized file:
    const unterminatedRepo = createSyntheticGitRepo({
      ".gitignore": ["node_modules/", LOCAL_ONLY_BEGIN_HASH, ".tool-cache/", ""].join("\n"),
    });
    const outUnterminated = path.join(createTempDir("causoryn-pubexport-unterminated-"), "out");
    expect(() =>
      exportPublicTree({ repoRoot: unterminatedRepo, outDir: outUnterminated, ref: "HEAD" }),
    ).toThrow(/unterminated local-only block in \.gitignore/);
  });
});
