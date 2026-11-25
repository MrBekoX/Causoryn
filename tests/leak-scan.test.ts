import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { loadLeakScan, REPO_ROOT } from "./helpers/leak-scan.js";

/**
 * Unit tests for the shared leak scanner (`scripts/lib/leak-scan.mjs`).
 * Every bait value is assembled at runtime so this file never matches the
 * rules it tests.
 */

const j = (...parts: readonly string[]): string => parts.join("");

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function rulesFor(relPosix: string, content: Buffer | string): Promise<string[]> {
  const scanner = await loadLeakScan();
  return scanner.scanContent(relPosix, content).map((finding) => finding.rule);
}

describe("leak-scan: credential families", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["aws-access-key", j("AK", "IA", "ABCDEFGHIJKLMNOP")],
    ["aws-temporary-access-key", j("AS", "IA", "ABCDEFGHIJKLMNOP")],
    ["gitlab-token", j("gl", "pat-", "a1".repeat(10))],
    ["gitlab-token", j("gl", "rt-", "b2".repeat(10))],
    ["huggingface-token", j("hf", "_", "a".repeat(34))],
    ["supabase-token", j("sb", "p_", "0a".repeat(20))],
    ["supabase-token", j("sb_", "secret_", "c3".repeat(12))],
    ["stripe-live-key", j("sk", "_live_", "d4".repeat(12))],
    ["stripe-live-key", j("rk", "_live_", "e5".repeat(12))],
    ["connection-string-credentials", j("postgres", "://app:", "S3cr3tPw", "@db.internal:5432/app")],
    ["connection-string-credentials", j("mysql", "://root:", "hunter22", "@10.0.0.5/db")],
    ["connection-string-credentials", j("mongodb+srv", "://svc:", "Zx9q", "@cluster0.internal/db")],
    ["connection-string-credentials", j("redis", "://:", "Pa55word123", "@cache:6379")],
    ["nuget-api-key", j("oy", "2", "a".repeat(43))],
    ["pypi-token", j("pypi-", "AgEIcHlwaS5vcmc", "x".repeat(50))],
    ["crates-io-token", j("ci", "o", "A1".repeat(16))],
    ["authorization-bearer", j("Authorization: Bear", "er ", "abc123DEF456ghi789JKL0")],
    ["authorization-bearer", j('"Authorization": "Bear', "er ", 'abc123DEF456ghi789JKL0"')],
    ["dotenv-secret-assignment", j("API_", "KEY=", "a1b2c3d4e5f6g7h8")],
    ["dotenv-secret-assignment", j("export GITHUB_", "TOKEN=", "Zx81Qw92Er03Ty")],
    ["dotenv-secret-assignment", j("DB_PASS", "WORD='", "Pw4-Long-Value'")],
    ["assigned-secret-literal", j("pass", 'word: "', "Q7".repeat(8), '"')],
    ["github-token", j("gh", "p_", "a".repeat(36))],
    ["github-fine-grained-pat", j("github_", "pat_", "11AAAAAA00000000000000_BBBBBBBBBB")],
    ["npm-token", j("np", "m_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234")],
    ["openai-key", j("s", "k-", "projABCDEFGH1234567890abcdef")],
    ["google-api-key", j("AI", "za", "a".repeat(35))],
    ["jwt-token", j("ey", "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij")],
    ["slack-token", j("xo", "xb-", "123456789-abcdefghij")],
    ["private-key-block", j("-----BEGIN RSA PRI", "VATE KEY-----")],
    ["personal-email", j("someone", "@", "proton", ".me")],
  ];

  for (const [rule, bait] of cases) {
    it(`detects ${rule} (${bait.slice(0, 6)}…)`, async () => {
      expect(await rulesFor("src/config.txt", `${bait}\n`)).toContain(rule);
    });
  }

  it("does not flag documented placeholders or variable references", async () => {
    const lines = [
      j("postgres", "://user:password@localhost/db"),
      j("postgres", "://user:${DB_PASSWORD}@db.internal/app"),
      j("mongodb", "://localhost:27017/app"),
      j("Authorization: Bear", "er <token>"),
      j("Authorization: Bear", "er $GITHUB_TOKEN"),
      j("Authorization: Bear", "er YOUR_TOKEN_GOES_HERE_PLEASE"),
      j("API_", "KEY=${API_KEY}"),
      j("API_", "KEY=your-api-key-here-123"),
      j("NPM_", "TOKEN=${{ secrets.NPM_TOKEN }}"),
      j("PASS", "WORD=changeme"),
      "NODE_ENV=production-build-2026",
      j("pass", 'word: "<your-password-1234>"'),
    ];
    for (const line of lines) {
      expect(await rulesFor("docs/guide.md", `${line}\n`), line).toEqual([]);
    }
  });

  it("allows upstream author e-mails only in third-party license notices", async () => {
    const email = j("upstream.author", "@", "gmail.com");
    expect(await rulesFor("THIRD-PARTY-NOTICES.md", `Copyright <${email}>\n`)).toEqual([]);
    expect(await rulesFor("packages/x/licenses/dep.txt", `Copyright <${email}>\n`)).toEqual([]);
    expect(await rulesFor("docs/team.md", `Contact <${email}>\n`)).toContain("personal-email");
  });
});

describe("leak-scan: user-profile and local drive paths", () => {
  it("flags non-generic user-profile paths in every Windows/macOS/Linux/WSL form", async () => {
    const scanner = await loadLeakScan();
    for (const sample of [
      j("C:", "\\Users\\", "alice", "\\src"),
      j("c:", "\\users\\", "alice", "\\src"),
      j("C:", "\\\\Users\\\\", "alice", "\\\\src"),
      j("C:", "/Users/", "alice", "/src"),
      j("/Users/", "jdoe", "/src/app.ts"),
      j("/home/", "jdoe", "/src"),
      j("/mnt/c/", "Users/", "alice", "/repo"),
      j("file:///home/", "jdoe", "/notes.txt"),
    ]) {
      expect(scanner.countUserProfilePaths(`see ${sample}`), sample).toBe(1);
    }
  });

  it("accepts documented placeholders, CI runner profiles and URL path segments", async () => {
    const scanner = await loadLeakScan();
    for (const sample of [
      "C:\\Users\\<you>\\project",
      "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp",
      "C:\\Users\\runneradmin\\work",
      "C:\\Users\\%USERNAME%\\AppData",
      "C:\\Users\\...\\AppData",
      "%USERPROFILE%\\.causoryn",
      "/Users/<user>/repo",
      "/home/runner/work/app",
      "/home/node/app",
      "/home/dev/workspace",
      "https://api.github.com/users/alice",
      "https://example.com/home/alice",
    ]) {
      expect(scanner.countUserProfilePaths(sample), sample).toBe(0);
    }
  });

  it("flags absolute drive-letter paths outside documented example roots", async () => {
    const scanner = await loadLeakScan();
    expect(scanner.countLocalDrivePaths(j("D:", "\\Work\\Sample\\tool.exe"))).toBe(1);
    expect(scanner.countLocalDrivePaths(j("E:", "/", "build-cache/x"))).toBe(1);
    expect(scanner.countLocalDrivePaths(j("D:", "\\\\", "Work\\\\Sample"))).toBe(1);
    for (const sample of [
      "C:/projects/my-app",
      "Z:/definitely/not/here.mjs",
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\Users\\<you>\\project",
      "C:\\<repo>\\src",
      "%LOCALAPPDATA%\\causoryn",
      "https://localhost:8080/path",
    ]) {
      expect(scanner.countLocalDrivePaths(sample), sample).toBe(0);
    }
  });

  it("applies the drive-path policy to documentation/configuration files only", async () => {
    const scanner = await loadLeakScan();
    for (const rel of ["docs/a.md", "x.json", "a/b.yml", ".env", ".env.local", ".npmrc", "LICENSE", "site/index.HTML"]) {
      expect(scanner.isDocumentLikePath(rel), rel).toBe(true);
    }
    for (const rel of ["src/a.ts", "tests/b.test.ts", "Dockerfile", "scripts/run.sh"]) {
      expect(scanner.isDocumentLikePath(rel), rel).toBe(false);
    }
    const leak = `Run ${j("D:", "\\Work\\Sample\\go.exe")}\n`;
    expect(await rulesFor("docs/setup.md", leak)).toContain("local-drive-path");
    expect(await rulesFor("src/paths.test.ts", leak)).not.toContain("local-drive-path");
  });
});

describe("leak-scan: private terms", { timeout: 30_000 }, () => {
  it("parses one term per line or comma separated, ignores comments and rejects too-short terms", async () => {
    const scanner = await loadLeakScan();
    expect(scanner.parsePrivateTerms("Alpha-Term\n# comment\nbeta-x, gamma-y\n\n", "t")).toEqual([
      "alpha-term",
      "beta-x",
      "gamma-y",
    ]);
    expect(() => scanner.parsePrivateTerms("ok-term\nab\n", "t")).toThrow(/shorter than 3/);
  });

  it("reports private terms case-insensitively in content and file names without echoing the term", async () => {
    const scanner = await loadLeakScan();
    const privateTerms = ["sample-corp", "work-sample"];
    const findings = scanner.scanContent("docs/work-sample/guide.md", "Built at SAMPLE-CORP.\n", {
      privateTerms,
    });
    expect(findings).toEqual([
      { location: "docs/work-sample/guide.md:path", rule: "private-term-2" },
      { location: "docs/work-sample/guide.md:1", rule: "private-term-1" },
    ]);
    const rendered = JSON.stringify(findings.map((finding) => finding.rule));
    expect(rendered).not.toContain("sample-corp");
  });

  it("loads terms from CAUSORYN_PRIVATE_TERMS and from the untracked git-dir term file (missing file = none)", async () => {
    const scanner = await loadLeakScan();
    expect(scanner.PRIVATE_TERMS_ENV).toBe("CAUSORYN_PRIVATE_TERMS");
    expect(
      scanner.loadPrivateTerms({ env: { CAUSORYN_PRIVATE_TERMS: "one-term,two-term\nthree-term" } }),
    ).toEqual(["one-term", "two-term", "three-term"]);

    const repoDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-leak-terms-"));
    tempDirs.push(repoDir);
    execFileSync("git", ["init", "-q"], { cwd: repoDir, shell: false });
    expect(scanner.loadPrivateTerms({ repoRoot: repoDir, env: {} })).toEqual([]);

    mkdirSync(path.join(repoDir, ".git", "info"), { recursive: true });
    writeFileSync(path.join(repoDir, ".git", "info", "causoryn-private-terms"), "local-term\n", "utf8");
    expect(
      scanner.loadPrivateTerms({ repoRoot: repoDir, env: { CAUSORYN_PRIVATE_TERMS: "env-term" } }),
    ).toEqual(["env-term", "local-term"]);
  });
});

describe("leak-scan: content handling", () => {
  it("scans binary files (NUL bytes) through their printable string runs", async () => {
    const binary = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]),
      Buffer.from(`tEXtpath ${j("C:", "\\Users\\", "alice", "\\shot.png")}`, "latin1"),
      Buffer.from([0x00, 0x02]),
      Buffer.from(`key ${j("AK", "IA", "ABCDEFGHIJKLMNOP")}`, "latin1"),
      Buffer.from([0x00]),
    ]);
    const scanner = await loadLeakScan();
    const findings = scanner.scanContent("assets/logo.png", binary);
    expect(findings.map((finding) => finding.rule).sort()).toEqual([
      "aws-access-key",
      "local-user-profile-path",
    ]);
    expect(findings.every((finding) => /:@\d+$/.test(finding.location))).toBe(true);
  });

  it("scanner sources and this test file are clean by construction (no self-skip needed)", async () => {
    const scanner = await loadLeakScan();
    for (const rel of [
      "scripts/lib/leak-scan.mjs",
      "scripts/secret-scan.mjs",
      "scripts/export-public-tree.mjs",
      "tests/leak-scan.test.ts",
      "tests/secret-scan.test.ts",
      "tests/public-export.test.ts",
    ]) {
      const content = readFileSync(path.join(REPO_ROOT, ...rel.split("/")));
      expect(scanner.scanContent(rel, content), rel).toEqual([]);
    }
  });

  it("stays linear on adversarial long lines (ReDoS guard)", async () => {
    const scanner = await loadLeakScan();
    const longLines = [
      "a".repeat(60_000),
      j("postgres", "://") + "a:".repeat(30_000),
      j("Authorization: Bear", "er ") + "a".repeat(60_000) + "!",
      j("C:", "\\Users\\") + "a".repeat(60_000),
      "-----BEGIN " + "A ".repeat(30_000),
      j("API_", "KEY") + "_".repeat(60_000),
      j("gh", "p_") + "a".repeat(60_000) + "_",
      "x@".repeat(30_000),
      "/home".repeat(12_000),
    ];
    const started = performance.now();
    for (const line of longLines) {
      scanner.scanContent("docs/long.md", line);
    }
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
