import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * secret-scan kapsam (12 dizin kökü + kök metin dosyaları), genişletilmiş
 * token/kişisel-yol desenleri, CWD bağımsızlığı, sahnelenmiş derleme ve
 * docs/superpowers dışlamaları ile negatif yakalama testleri (F-P2-01, K-022).
 */

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(THIS_DIR);
const SECRET_SCAN_PATH = path.join(REPO_ROOT, "scripts", "secret-scan.mjs");
const LEAK_SCAN_PATH = path.join(REPO_ROOT, "scripts", "lib", "leak-scan.mjs");

/** Kaynakta tek parça secret literal yazılmaz; çalışma zamanında birleştirilir. */
const BAIT_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const BAIT_GH_FINE_PAT = "github_" + "pat_" + "11AAAAAA00000000000000_BBBBBBBBBB";
const BAIT_NPM_TOKEN = "npm_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234";
const BAIT_OPENAI_KEY = "sk-" + "projABCDEFGH1234567890abcdef";
const BAIT_GOOGLE_KEY = "AIza" + "SyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe";
const BAIT_JWT =
  "eyJhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const BAIT_WIN_PROFILE = "C:" + "\\Users\\" + "alice" + "\\project\\app.ts";
const BAIT_WIN_SLASH_PROFILE = "C:" + "/Users/" + "alice" + "/project/app.ts";
const BAIT_MAC_PROFILE = "/Users/" + "jdoe" + "/src/app.ts";
const BAIT_LINUX_PROFILE = "/home/" + "jdoe" + "/src/app.ts";
const SYNTHETIC_UPSTREAM_EMAIL = ["upstream.author", "gmail.com"].join("@");

const tempDirs: string[] = [];

const EXPECTED_DIR_ROOTS = [
  "packages",
  "adapters",
  "apps",
  "native",
  "scripts",
  path.join("integrations", "zcode", "causoryn"),
  path.join("integrations", "zcode", ".claude-plugin"),
  path.join("integrations", "antigravity", "causoryn"),
  ".github",
  ".claude-plugin",
  ".agents",
  "docs",
  "skills",
] as const;

const EXPECTED_ROOT_FILES = [
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "package.json",
  "marketplace.json",
  "plugin.json",
  "mcp.json",
  "mcp_config.json",
  "server.json",
  ".gitattributes",
  ".gitignore",
] as const;

function createTempRepoSkeleton(options?: { readonly omitNative?: boolean }): {
  readonly repoDir: string;
  readonly scriptCopyPath: string;
} {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-secret-scan-"));
  tempDirs.push(repoDir);

  mkdirSync(path.join(repoDir, "packages", "sample", "src"), { recursive: true });
  mkdirSync(path.join(repoDir, "adapters", "sample", "src"), { recursive: true });
  mkdirSync(path.join(repoDir, "apps", "visualizer", "src"), { recursive: true });
  if (!options?.omitNative) {
    mkdirSync(path.join(repoDir, "native", "worker", "src"), { recursive: true });
  }
  mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
  mkdirSync(path.join(repoDir, "integrations", "zcode", "causoryn"), { recursive: true });
  mkdirSync(path.join(repoDir, "integrations", "zcode", ".claude-plugin"), { recursive: true });
  mkdirSync(path.join(repoDir, "integrations", "antigravity", "causoryn"), { recursive: true });
  mkdirSync(path.join(repoDir, ".github", "workflows"), { recursive: true });
  mkdirSync(path.join(repoDir, ".claude-plugin"), { recursive: true });
  mkdirSync(path.join(repoDir, ".agents", "plugins"), { recursive: true });
  mkdirSync(path.join(repoDir, "docs"), { recursive: true });
  mkdirSync(path.join(repoDir, "skills", "causoryn"), { recursive: true });

  const scriptCopyPath = path.join(repoDir, "scripts", "secret-scan.mjs");
  copyFileSync(SECRET_SCAN_PATH, scriptCopyPath);
  mkdirSync(path.join(repoDir, "scripts", "lib"), { recursive: true });
  copyFileSync(LEAK_SCAN_PATH, path.join(repoDir, "scripts", "lib", "leak-scan.mjs"));
  writeFileSync(
    path.join(repoDir, "packages", "sample", "src", "clean.ts"),
    'export const ok = "clean";\n',
    "utf8",
  );
  for (const rootFile of EXPECTED_ROOT_FILES) {
    writeFileSync(path.join(repoDir, rootFile), "# clean\n", "utf8");
  }
  // Mirrors the real repository: staged build output is ignored by `.gitignore`,
  // internal plans by the local-only `.git/info/exclude`.
  writeFileSync(
    path.join(repoDir, ".gitignore"),
    "# clean\nintegrations/antigravity/causoryn/scripts/\n",
    "utf8",
  );
  git(repoDir, ["init", "-q"]);
  writeFileSync(path.join(repoDir, ".git", "info", "exclude"), "docs/superpowers/\n", "utf8");
  return { repoDir, scriptCopyPath };
}

/** Repository-relative POSIX path in the OS-native form the CLI prints. */
function native(relPosix: string): string {
  return relPosix.split("/").join(path.sep);
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    shell: false,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function runScan(
  scriptCopyPath: string,
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> & { stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [scriptCopyPath, ...args], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    shell: false,
    env: { ...process.env, CAUSORYN_PRIVATE_TERMS: "", ...env },
  });
  return res as ReturnType<typeof spawnSync> & { stdout: string; stderr: string };
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/secret-scan.mjs — genişletilmiş kapsam (12 kök + kök dosyalar) ve desenler", { timeout: 60_000 }, () => {
  it("SCAN_ROOTS tanımı 12 dizin kökünü kapsar; ROOT_TEXT_FILES kök metin dosyalarını listeler", () => {
    expect(existsSync(SECRET_SCAN_PATH), "scripts/secret-scan.mjs mevcut olmalı").toBe(true);
    const source = readFileSync(SECRET_SCAN_PATH, "utf8");

    const scanRootsMatch = source.match(/const\s+SCAN_ROOTS\s*=\s*\[([\s\S]*?)\];/);
    expect(scanRootsMatch, "SCAN_ROOTS dizi tanımı bulunmalı").not.toBeNull();
    const scanRootsBody = scanRootsMatch?.[1] ?? "";

    for (const dir of [
      '"packages"',
      '"adapters"',
      '"apps"',
      '"native"',
      '"scripts"',
      '".github"',
      '".claude-plugin"',
      '".agents"',
      '"docs"',
      '"skills"',
    ]) {
      expect(scanRootsBody).toContain(dir);
    }
    expect(scanRootsBody).toMatch(/path\.join\(\s*"integrations"\s*,\s*"zcode"\s*,\s*"causoryn"\s*\)/);
    expect(scanRootsBody).toMatch(
      /path\.join\(\s*"integrations"\s*,\s*"antigravity"\s*,\s*"causoryn"\s*\)/,
    );

    const rootFilesMatch = source.match(/const\s+ROOT_TEXT_FILES\s*=\s*\[([\s\S]*?)\];/);
    expect(rootFilesMatch, "ROOT_TEXT_FILES dizi tanımı bulunmalı").not.toBeNull();
    const rootFilesBody = rootFilesMatch?.[1] ?? "";
    for (const rootFile of EXPECTED_ROOT_FILES) {
      expect(rootFilesBody).toContain(`"${rootFile}"`);
    }

    // Coverage is no longer limited by directory-name or extension lists: files
    // come from `git ls-files` (tracked + untracked-not-ignored) and the rules
    // live in the shared scanner module used by the export gate as well.
    // Build outputs (target/, bin/, obj/, node_modules/, dist/) stay out
    // because `.gitignore` ignores them, not because of a name list.
    expect(source).not.toMatch(/const\s+EXCLUDE_SEGMENTS\b/);
    expect(source).not.toMatch(/const\s+TEXT_EXTENSIONS\b/);
    expect(source).toContain('from "./lib/leak-scan.mjs"');
    expect(source).not.toMatch(/basename\([^)]*\)\s*===\s*["']secret-scan\.mjs["']/);
    const rootGitignore = readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
    for (const ignored of ["node_modules/", "dist/", "bin/", "obj/", "native/rust-worker/target/"]) {
      expect(rootGitignore).toContain(ignored);
    }
  });

  it("gerçek secret-scan koşumu CWD bağımsız olarak (cwd: os.tmpdir()) exit 0 ve '12 kök tarandı' döndürür", () => {
    const stdout = execFileSync(process.execPath, [SECRET_SCAN_PATH], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(stdout).toContain("SECRET_SCAN PASS");
    expect(stdout).toContain(`${String(EXPECTED_DIR_ROOTS.length)} roots scanned`);
    expect(stdout).toContain("0 matches");
  });

  it("NEGATİF: .github, docs, skills ve kök README.md içindeki yeni sır/kişisel-yol kalıpları exit 1 ile yakalanır", () => {
    const { repoDir, scriptCopyPath } = createTempRepoSkeleton();
    writeFileSync(
      path.join(repoDir, ".github", "workflows", "leak.yml"),
      `env:\n  PAT: ${BAIT_GH_FINE_PAT}\n  NPM: ${BAIT_NPM_TOKEN}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(repoDir, "docs", "leak.md"),
      `key=${BAIT_OPENAI_KEY}\ngoogle=${BAIT_GOOGLE_KEY}\npath=${BAIT_WIN_PROFILE}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(repoDir, "skills", "causoryn", "SKILL.md"),
      `jwt=${BAIT_JWT}\nmac=${BAIT_MAC_PROFILE}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(repoDir, "README.md"),
      `leaked=${BAIT_AWS_KEY}\n`,
      "utf8",
    );

    const res = spawnSync(process.execPath, [scriptCopyPath], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      shell: false,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("SECRET_SCAN FAIL");
    expect(res.stderr).toContain("github-fine-grained-pat");
    expect(res.stderr).toContain("npm-token");
    expect(res.stderr).toContain("openai-key");
    expect(res.stderr).toContain("google-api-key");
    expect(res.stderr).toContain("jwt-token");
    expect(res.stderr).toContain("local-user-profile-path");
    expect(res.stderr).toContain("aws-access-key");
    expect(res.stderr).toContain(path.join(".github", "workflows", "leak.yml"));
    expect(res.stderr).toContain(path.join("docs", "leak.md"));
    expect(res.stderr).toContain(path.join("skills", "causoryn", "SKILL.md"));
    expect(res.stderr).toContain("README.md");
  });

  it("SINIR: jenerik yer tutucu kullanıcı adları (you, your-user, runner, runneradmin, username, <user>) local-user-profile-path olarak yanlış pozitif üretmez", () => {
    const { repoDir, scriptCopyPath } = createTempRepoSkeleton();
    writeFileSync(
      path.join(repoDir, "docs", "guide.md"),
      [
        "Windows: C:\\Users\\you\\project",
        "Runner: C:\\Users\\runner\\work",
        "Admin: C:\\Users\\runneradmin\\work",
        "macOS: /Users/your-user/project",
        "Placeholder: /Users/username/app",
        "Angle: /Users/<user>/repo",
        "Dev Win: C:\\Users\\dev\\workspace",
        "Dev Linux: /home/dev/workspace",
      ].join("\n") + "\n",
      "utf8",
    );

    const res = spawnSync(process.execPath, [scriptCopyPath], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      shell: false,
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("SECRET_SCAN PASS");

    // Negatif: eğik çizgili Windows profili ve Linux /home/<user> yakalanmalı:
    writeFileSync(path.join(repoDir, "docs", "slash.md"), `Path: ${BAIT_WIN_SLASH_PROFILE}\n`, "utf8");
    const slashRed = spawnSync(process.execPath, [scriptCopyPath], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      shell: false,
    });
    expect(slashRed.status).toBe(1);
    expect(slashRed.stderr).toContain("local-user-profile-path");
    rmSync(path.join(repoDir, "docs", "slash.md"));

    writeFileSync(path.join(repoDir, "docs", "linux.md"), `Path: ${BAIT_LINUX_PROFILE}\n`, "utf8");
    const linuxRed = spawnSync(process.execPath, [scriptCopyPath], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      shell: false,
    });
    expect(linuxRed.status).toBe(1);
    expect(linuxRed.stderr).toContain("local-user-profile-path");
    rmSync(path.join(repoDir, "docs", "linux.md"));

    // Negatif: integrations/zcode/.claude-plugin/marketplace.json da taranır:
    writeFileSync(
      path.join(repoDir, "integrations", "zcode", ".claude-plugin", "marketplace.json"),
      JSON.stringify({ leaked: BAIT_GH_FINE_PAT }),
      "utf8",
    );
    const zcodeRed = spawnSync(process.execPath, [scriptCopyPath], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      shell: false,
    });
    expect(zcodeRed.status).toBe(1);
    expect(zcodeRed.stderr).toContain("github-fine-grained-pat");
  });

  it("SINIR: sahnelenmiş derleme çıktısı (integrations/antigravity/causoryn/scripts/) ve iç planlar (docs/superpowers/) taranmazken kök scripts/ taranmaya devam eder", () => {
    const { repoDir, scriptCopyPath } = createTempRepoSkeleton();
    const stagedDir = path.join(repoDir, "integrations", "antigravity", "causoryn", "scripts");
    mkdirSync(stagedDir, { recursive: true });
    writeFileSync(
      path.join(stagedDir, "mcp-server.mjs"),
      `// bundled third-party comment ${BAIT_AWS_KEY}\n`,
      "utf8",
    );

    const superpowersDir = path.join(repoDir, "docs", "superpowers", "plans");
    mkdirSync(superpowersDir, { recursive: true });
    writeFileSync(
      path.join(superpowersDir, "internal-plan.md"),
      `internal note ${BAIT_WIN_PROFILE}\n`,
      "utf8",
    );

    const cleanRun = spawnSync(process.execPath, [scriptCopyPath], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      shell: false,
    });
    expect(cleanRun.status, cleanRun.stderr).toBe(0);
    expect(cleanRun.stdout).toContain(`${String(EXPECTED_DIR_ROOTS.length)} roots scanned`);
    expect(cleanRun.stdout).toContain("0 matches");

    writeFileSync(
      path.join(repoDir, "scripts", "check-helper.mjs"),
      `export const leaked = "${BAIT_AWS_KEY}";\n`,
      "utf8",
    );
    const redRun = spawnSync(process.execPath, [scriptCopyPath], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      shell: false,
    });
    expect(redRun.status).toBe(1);
    expect(redRun.stderr).toContain("SECRET_SCAN FAIL");
    expect(redRun.stderr).toContain(path.join("scripts", "check-helper.mjs"));
    rmSync(path.join(repoDir, "scripts", "check-helper.mjs"));

    // An ignored file that is force-added becomes tracked (and therefore
    // published), so it is scanned again:
    git(repoDir, ["add", "-f", "docs/superpowers/plans/internal-plan.md"]);
    const trackedRun = runScan(scriptCopyPath);
    expect(trackedRun.status).toBe(1);
    expect(trackedRun.stderr).toContain(native("docs/superpowers/plans/internal-plan.md"));
    expect(trackedRun.stderr).toContain("local-user-profile-path");
  });

  it("NEGATIVE: locations and file types the old extension/directory lists skipped are scanned", () => {
    const { repoDir, scriptCopyPath } = createTempRepoSkeleton();
    const leakyFiles = [
      "tests/leak.test.ts",
      "examples/demo/src/App.tsx",
      "examples/demo/src/legacy.jsx",
      "eslint.config.js",
      "tsconfig.base.json",
      "Dockerfile",
      "id_rsa",
      ".env.production",
      ".npmrc",
      "scripts/deploy.sh",
      "scripts/setup.ps1",
      "scripts/run.bat",
      "scripts/run.cmd",
      "certs/server.pem",
      "certs/server.key",
      "db/schema.sql",
      "proto/api.proto",
      "site/index.html",
      "site/logo.svg",
      "build/pom.xml",
      "config/settings.ini",
      "packages/sample/src/UPPER.TS",
      "packages/sample/data.JSON",
    ];
    for (const rel of leakyFiles) {
      mkdirSync(path.dirname(path.join(repoDir, rel)), { recursive: true });
      writeFileSync(path.join(repoDir, rel), `leaked ${BAIT_AWS_KEY}\n`, "utf8");
    }

    const res = runScan(scriptCopyPath);
    expect(res.status).toBe(1);
    for (const rel of leakyFiles) {
      expect(res.stderr, rel).toContain(`${native(rel)}:1 — aws-access-key`);
    }
  });

  it("NEGATIVE: the self-skip is not name-based — any other secret-scan.mjs is scanned, the scanner's own files are clean", () => {
    const { repoDir, scriptCopyPath } = createTempRepoSkeleton();
    writeFileSync(
      path.join(repoDir, "packages", "sample", "secret-scan.mjs"),
      `export const leaked = "${BAIT_GH_FINE_PAT}";\n`,
      "utf8",
    );
    const res = runScan(scriptCopyPath);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`${native("packages/sample/secret-scan.mjs")}:1 — github-fine-grained-pat`);
    expect(res.stderr).not.toContain(native("scripts/secret-scan.mjs"));
    expect(res.stderr).not.toContain(native("scripts/lib/leak-scan.mjs"));
  });

  it("BOUNDARY: untracked files that are not ignored are scanned, ignored ones are not, --tracked-only limits to the index", () => {
    const { repoDir, scriptCopyPath } = createTempRepoSkeleton();
    writeFileSync(path.join(repoDir, ".gitignore"), "# clean\nlocal-cache/\n", "utf8");
    mkdirSync(path.join(repoDir, "local-cache"), { recursive: true });
    writeFileSync(path.join(repoDir, "local-cache", "dump.txt"), `${BAIT_AWS_KEY}\n`, "utf8");
    expect(runScan(scriptCopyPath).status).toBe(0);

    writeFileSync(path.join(repoDir, "docs", "draft.md"), `${BAIT_NPM_TOKEN}\n`, "utf8");
    const untrackedRun = runScan(scriptCopyPath);
    expect(untrackedRun.status).toBe(1);
    expect(untrackedRun.stderr).toContain(`${native("docs/draft.md")}:1 — npm-token`);

    const trackedOnlyRun = runScan(scriptCopyPath, ["--tracked-only"]);
    expect(trackedOnlyRun.status, trackedOnlyRun.stderr).toBe(0);
    git(repoDir, ["add", "docs/draft.md"]);
    expect(runScan(scriptCopyPath, ["--tracked-only"]).status).toBe(1);

    expect(runScan(scriptCopyPath, ["--unknown-flag"]).status).toBe(1);
  });

  it("FAIL-CLOSED: unreadable entries and non-git directories fail; tracked files deleted from the working tree are skipped", () => {
    const { repoDir, scriptCopyPath } = createTempRepoSkeleton();
    writeFileSync(path.join(repoDir, "docs", "gone.md"), "clean\n", "utf8");
    writeFileSync(path.join(repoDir, "docs", "swapped.md"), "clean\n", "utf8");
    git(repoDir, ["add", "docs/gone.md", "docs/swapped.md"]);

    rmSync(path.join(repoDir, "docs", "gone.md"));
    expect(runScan(scriptCopyPath).status).toBe(0);

    rmSync(path.join(repoDir, "docs", "swapped.md"));
    mkdirSync(path.join(repoDir, "docs", "swapped.md"));
    const swappedRun = runScan(scriptCopyPath);
    expect(swappedRun.status).toBe(1);
    expect(swappedRun.stderr).toContain("SECRET_SCAN FAIL");
    expect(swappedRun.stderr).toContain(native("docs/swapped.md"));

    const notGit = mkdtempSync(path.join(os.tmpdir(), "causoryn-secret-scan-nogit-"));
    tempDirs.push(notGit);
    mkdirSync(path.join(notGit, "scripts", "lib"), { recursive: true });
    copyFileSync(SECRET_SCAN_PATH, path.join(notGit, "scripts", "secret-scan.mjs"));
    copyFileSync(LEAK_SCAN_PATH, path.join(notGit, "scripts", "lib", "leak-scan.mjs"));
    const notGitRun = runScan(path.join(notGit, "scripts", "secret-scan.mjs"));
    expect(notGitRun.status).toBe(1);
    expect(notGitRun.stderr).toContain("SECRET_SCAN FAIL");
  });

  it("NEGATIVE: binary files are scanned through their printable strings, not skipped by extension", () => {
    const { repoDir, scriptCopyPath } = createTempRepoSkeleton();
    writeFileSync(
      path.join(repoDir, "docs", "diagram.png"),
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]),
        Buffer.from(`author-path ${BAIT_WIN_PROFILE}`, "latin1"),
        Buffer.from([0x00, 0x01]),
      ]),
    );
    const res = runScan(scriptCopyPath);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`${native("docs/diagram.png")}:@`);
    expect(res.stderr).toContain("— local-user-profile-path");
  });

  it("PRIVACY: private terms from CAUSORYN_PRIVATE_TERMS and .git/info/causoryn-private-terms are enforced without echoing the term", () => {
    const { repoDir, scriptCopyPath } = createTempRepoSkeleton();
    const envTerm = ["sample", "corp", "internal"].join("-");
    const fileTerm = ["work", "sample", "box"].join("-");
    writeFileSync(path.join(repoDir, "docs", "notes.md"), `Built on ${envTerm.toUpperCase()}\n`, "utf8");
    writeFileSync(path.join(repoDir, "packages", "sample", "src", "where.ts"), `// ${fileTerm}\n`, "utf8");

    expect(runScan(scriptCopyPath).status).toBe(0);

    const envRun = runScan(scriptCopyPath, [], { CAUSORYN_PRIVATE_TERMS: envTerm });
    expect(envRun.status).toBe(1);
    expect(envRun.stderr).toContain(`${native("docs/notes.md")}:1 — private-term-1`);
    expect(envRun.stderr.toLowerCase()).not.toContain(envTerm);

    writeFileSync(
      path.join(repoDir, ".git", "info", "causoryn-private-terms"),
      `# local only\n${fileTerm}\n`,
      "utf8",
    );
    const fileRun = runScan(scriptCopyPath);
    expect(fileRun.status).toBe(1);
    expect(fileRun.stderr).toContain(`${native("packages/sample/src/where.ts")}:1 — private-term-1`);
    expect(fileRun.stderr.toLowerCase()).not.toContain(fileTerm);

    writeFileSync(path.join(repoDir, ".git", "info", "causoryn-private-terms"), "ab\n", "utf8");
    const shortRun = runScan(scriptCopyPath);
    expect(shortRun.status).toBe(1);
    expect(shortRun.stderr).toContain("shorter than 3");
  });

  it("NEGATIVE: new credential families and local drive paths in docs are reported by the CLI", () => {
    const { repoDir, scriptCopyPath } = createTempRepoSkeleton();
    writeFileSync(
      path.join(repoDir, "docs", "deploy.md"),
      [
        `token ${["gl", "pat-", "a1".repeat(10)].join("")}`,
        `db ${["postgres", "://app:", "S3cr3tPw", "@db.internal/app"].join("")}`,
        `${["API_", "KEY=", "a1b2c3d4e5f6g7h8"].join("")}`,
        `tool ${["D:", "\\Work\\Sample\\go.exe"].join("")}`,
      ].join("\n") + "\n",
      "utf8",
    );
    const res = runScan(scriptCopyPath);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`${native("docs/deploy.md")}:1 — gitlab-token`);
    expect(res.stderr).toContain(`${native("docs/deploy.md")}:2 — connection-string-credentials`);
    expect(res.stderr).toContain(`${native("docs/deploy.md")}:3 — dotenv-secret-assignment`);
    expect(res.stderr).toContain(`${native("docs/deploy.md")}:4 — local-drive-path`);
  });

  it("SINIR: THIRD-PARTY-NOTICES.md ve licenses/ içindeki üçüncü taraf telif e-postaları yanlış pozitif üretmez, gerçek sırlar yine yakalanır", () => {
    const { repoDir, scriptCopyPath } = createTempRepoSkeleton();
    const noticesPath = path.join(repoDir, "packages", "sample", "THIRD-PARTY-NOTICES.md");
    writeFileSync(
      noticesPath,
      `Copyright Upstream Author <${SYNTHETIC_UPSTREAM_EMAIL}>\n`,
      "utf8",
    );

    const cleanRun = spawnSync(process.execPath, [scriptCopyPath], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      shell: false,
    });
    expect(cleanRun.status, cleanRun.stderr).toBe(0);

    writeFileSync(
      noticesPath,
      `Copyright Upstream Author <${SYNTHETIC_UPSTREAM_EMAIL}>\nleaked=${BAIT_GH_FINE_PAT}\n`,
      "utf8",
    );
    const redRun = spawnSync(process.execPath, [scriptCopyPath], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      shell: false,
    });
    expect(redRun.status).toBe(1);
    expect(redRun.stderr).toContain("github-fine-grained-pat");
  });

  it("NEGATİF: beyan edilen SCAN_ROOTS köklerinden biri diskte yoksa exit 1 döner", () => {
    const { scriptCopyPath } = createTempRepoSkeleton({ omitNative: true });
    const res = spawnSync(process.execPath, [scriptCopyPath], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      shell: false,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("native");
  });
});
