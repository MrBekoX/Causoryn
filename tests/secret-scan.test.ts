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
  writeFileSync(
    path.join(repoDir, "packages", "sample", "src", "clean.ts"),
    'export const ok = "clean";\n',
    "utf8",
  );
  for (const rootFile of EXPECTED_ROOT_FILES) {
    writeFileSync(path.join(repoDir, rootFile), "# clean\n", "utf8");
  }
  return { repoDir, scriptCopyPath };
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/secret-scan.mjs — genişletilmiş kapsam (12 kök + kök dosyalar) ve desenler", () => {
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

    const excludeMatch = source.match(/const\s+EXCLUDE_SEGMENTS\s*=\s*new\s+Set\(\[([\s\S]*?)\]\);/);
    expect(excludeMatch, "EXCLUDE_SEGMENTS tanımı bulunmalı").not.toBeNull();
    const excludeBody = excludeMatch?.[1] ?? "";
    for (const seg of ["target", "bin", "obj", "test", "tests", "node_modules", "dist"]) {
      expect(excludeBody).toContain(`"${seg}"`);
    }
    // docs ve skills artık taranan kökler olduğu için genel EXCLUDE_SEGMENTS içinde OLAMAZ.
    expect(excludeBody).not.toContain('"docs"');
    expect(excludeBody).not.toContain('"skills"');
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
