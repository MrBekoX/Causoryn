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

/** Sentetik yem literalleri çalışma zamanında birleştirilir (kaynakta ham sır yok). */
const BAIT_USER = "ber" + "ka";
const BAIT_DRIVE_REPO = "D:" + "\\Cau" + "soryn";
const BAIT_DRIVE_TOOLS = "D:" + "\\to" + "ols\\go\\bin\\go.exe";
const BAIT_DWFRUN = "dwf" + "run-0fbb3806";
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

function createSyntheticGitRepo(extraFiles?: Readonly<Record<string, string>>): string {
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
      ".mimosa/",
      ".video_agent/",
      "out/",
      "",
    ].join("\n"),
    ".github/workflows/ci.yml": "name: CI\n",
    ".github/workflows/release.yml": "name: Release\n",
    "packages/causoryn/package.json": '{"name":"causoryn","version":"0.2.0"}\n',
    "packages/core/src/index.ts": 'export const version = "0.2.0";\n',
    // Sentetik test yem dosyaları — bilinçli muafiyet kanıtı:
    "tests/security-release/f6-security-release.test.ts": `// canary: ${BAIT_AWS_KEY}\n`,
    "packages/causoryn/test/setup-and-doctor.test.ts":
      'const sample = "C:\\\\Users\\\\demo\\\\.causoryn\\\\runtime\\\\scripts\\\\causoryn.mjs";\n',
    // Dışlanması gereken özel / telifli / iç dosyalar:
    "raw/Causoryn_Teknik_Dokuman_v2.1.pdf": "PRIVATE PDF",
    "raw/context-inject/tech/third-party.md": `Verbatim ${BAIT_USER} note`,
    "wiki/sprint-8.md": `Internal wiki ${BAIT_DWFRUN}`,
    "docs/superpowers/plans/2026-11-20-plan.md": `Internal plan ${BAIT_DRIVE_REPO}`,
    "START-PROMPT.md": "Internal start prompt\n",
    "OPEN-SOURCE-READINESS-PROMPT.md": "Internal audit prompt\n",
    "AGENTS.md": "Internal agent contract\n",
    ...(extraFiles ?? {}),
  };

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

  return repoDir;
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

describe("scripts/export-public-tree.mjs — Seçenek 1 temiz açık kaynak dışa aktarıcı", { timeout: 20_000 }, () => {
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
    expect(gitignore).not.toContain(".mimosa/");
    expect(gitignore).not.toContain(".video_agent/");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("dist/");
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
    expect(res.stdout).toContain("PUBLIC_EXPORT YEŞİL");
    expect(existsSync(path.join(outDir, "raw"))).toBe(false);
    expect(existsSync(path.join(outDir, "LICENSE"))).toBe(true);
  });

  it("CLI: --verify-temp --ref HEAD geçici dizinde fail-closed doğrular, exit 0 döner ve geçici dizini temizler", () => {
    const repoDir = createSyntheticGitRepo();
    const res = spawnSync(
      process.execPath,
      [EXPORT_SCRIPT_PATH, "--repo", repoDir, "--verify-temp", "--ref", "HEAD"],
      { cwd: os.tmpdir(), encoding: "utf8", shell: false },
    );
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("PUBLIC_EXPORT YEŞİL");
    const pathMatch = res.stdout.match(/→\s*(.+?)\s*(?:\(|$)/m);
    const exportedTmp = pathMatch?.[1]?.trim();
    if (exportedTmp) {
      expect(existsSync(exportedTmp), `geçici dizin temizlenmeli: ${exportedTmp}`).toBe(false);
    }

    // Negatif: sızıntılı repoda --verify-temp exit 1 döner VE geçici dizin sızdırmaz:
    const leakyRepo = createSyntheticGitRepo({
      "docs/leak-temp.md": `token=${BAIT_GH_PAT}\n`,
    });
    const tmpBefore = new Set(
      readdirSync(os.tmpdir()).filter((name) => name.startsWith("causoryn-export-gate-")),
    );
    const redRes = spawnSync(
      process.execPath,
      [EXPORT_SCRIPT_PATH, "--repo", leakyRepo, "--verify-temp", "--ref", "HEAD"],
      { cwd: os.tmpdir(), encoding: "utf8", shell: false },
    );
    expect(redRes.status).toBe(1);
    expect(redRes.stderr).toContain("PUBLIC_EXPORT KIRMIZI");
    const leakedTmpDirs = readdirSync(os.tmpdir()).filter(
      (name) => name.startsWith("causoryn-export-gate-") && !tmpBefore.has(name),
    );
    expect(leakedTmpDirs, "hata sonrasında da geçici dizin temizlenmeli").toEqual([]);
  });

  it("NEGATİF: dolu çıkış dizini (--out) fail-closed reddedilir", async () => {
    const { exportPublicTree } = await loadExporter();
    const repoDir = createSyntheticGitRepo();
    const nonEmptyDir = createTempDir("causoryn-pubexport-nonempty-");
    writeFileSync(path.join(nonEmptyDir, "existing.txt"), "data", "utf8");

    expect(() => exportPublicTree({ repoRoot: repoDir, outDir: nonEmptyDir, ref: "HEAD" })).toThrow(
      /boş|empty/i,
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

  it("NEGATİF: dışa aktarılan ağaçta kişisel kullanıcı adı, yerel yol, dwfrun veya sır sızıntısı varsa fail-closed reddedilir", async () => {
    const { exportPublicTree } = await loadExporter();
    const leakyRepo = createSyntheticGitRepo({
      "docs/leaked-guide.md": [
        `user: ${BAIT_USER}`,
        `win: ${BAIT_WIN_PROFILE}`,
        `repo: ${BAIT_DRIVE_REPO}`,
        `tools: ${BAIT_DRIVE_TOOLS}`,
        `run: ${BAIT_DWFRUN}`,
        `token: ${BAIT_GH_PAT}`,
      ].join("\n"),
    });
    const outDir = path.join(createTempDir("causoryn-pubexport-leak-"), "out");

    expect(() => exportPublicTree({ repoRoot: leakyRepo, outDir, ref: "HEAD" })).toThrow(
      /PUBLIC_EXPORT KIRMIZI|doğrulama başarısız/i,
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
        '  ".video_agent/**",',
        '  ".mimosa/**",',
        '  "dist/**",',
        "] }];",
        "",
      ].join("\n"),
    });
    const outDir = path.join(createTempDir("causoryn-pubexport-notices-"), "out");
    const res = exportPublicTree({ repoRoot: repoDir, outDir, ref: "HEAD" });
    expect(res.verification.ok, JSON.stringify(res.verification.findings)).toBe(true);

    const exportedEslint = readFileSync(path.join(outDir, "eslint.config.js"), "utf8");
    expect(exportedEslint).not.toContain(".mimosa");
    expect(exportedEslint).not.toContain(".video_agent");
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
});
