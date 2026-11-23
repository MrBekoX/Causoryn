/**
 * export-public-tree — Seçenek 1 temiz açık kaynak ağacı dışa aktarıcısı (F-P0-01, F-P1-02, K-022).
 *
 * Salt-okunur `git archive` kullanarak belirtilen Git ref'inden (varsayılan: HEAD)
 * kamuya açık kaynak ağacını boş bir hedef dizine aktarır; özel/telifli/iç dosyaları
 * (`raw/`, `wiki/`, `docs/superpowers/`, `START-PROMPT.md`, `OPEN-SOURCE-READINESS-PROMPT.md`,
 * `AGENTS.md`) kesinlikle dışlar, `.gitignore` içindeki iç araç satırlarını temizler ve
 * hedef ağaç üzerinde fail-closed sızıntı/bütünlük doğrulaması çalıştırır.
 *
 * Kullanım:
 *   node scripts/export-public-tree.mjs --out <boş-hedef-dizin> [--ref HEAD] [--repo <dizin>]
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const EXCLUDED_DIR_PREFIXES = ["raw/", "wiki/", "docs/superpowers/"];
const EXCLUDED_EXACT_FILES = new Set([
  "START-PROMPT.md",
  "OPEN-SOURCE-READINESS-PROMPT.md",
  "AGENTS.md",
]);

const REQUIRED_PUBLIC_FILES = [
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
];

/** Bilinçli sentetik test yem dosyaları (sır/demo-yol muafiyeti). */
const SYNTHETIC_SECRET_CANARY_FILES = new Set([
  "tests/security-release/f6-security-release.test.ts",
  "scripts/secret-scan.mjs",
  "scripts/export-public-tree.mjs",
]);

const SYNTHETIC_PROFILE_CANARY_FILES = new Set([
  "packages/causoryn/test/setup-and-doctor.test.ts",
  "scripts/secret-scan.mjs",
  "scripts/export-public-tree.mjs",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".woff", ".woff2",
  ".node", ".dll", ".exe", ".so", ".dylib", ".pdb", ".wasm",
  ".tgz", ".gz", ".zip", ".tar", ".pdf", ".sqlite", ".sqlite3", ".db",
]);

const GENERIC_PROFILE_USERS = new Set([
  "you",
  "your-user",
  "runner",
  "runneradmin",
  "username",
  "user",
  "demo",
  "dev",
  "<user>",
]);

const SAFE_GIT_REF_RE = /^(?!-)[A-Za-z0-9._/@~-]+$/;

/** Desen literalleri öz-eşleşmeyi önlemek için çalışma zamanında derlenir. */
const PERSONAL_USER_RE = new RegExp("ber" + "ka", "i");
const LOCAL_DRIVE_REPO_RE = new RegExp("D:(?:\\\\\\\\|\\\\|/)Cau" + "soryn", "i");
const LOCAL_DRIVE_TOOLS_RE = new RegExp("D:(?:\\\\\\\\|\\\\|/)to" + "ols", "i");
const INTERNAL_DWFRUN_RE = new RegExp("\\bdwf" + "run-[a-f0-9]{6,}\\b", "i");

const SECRET_PATTERNS = [
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "github-fine-grained-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{20,}\b/ },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: "jwt-token",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "personal-email", re: /[A-Za-z0-9._%+-]+@(?:gmail|hotmail|outlook)\.com/i },
];

const USER_PROFILE_PATH_RE =
  /(?:[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)|\/(?:Users|home)\/)(<[A-Za-z0-9._-]+>|[A-Za-z0-9._-]+)/g;

function toPosixRel(rootDir, fullPath) {
  return path.relative(rootDir, fullPath).split(path.sep).join("/");
}

function isThirdPartyLicenseNoticeFile(relPosix) {
  const base = path.posix.basename(relPosix);
  if (base === "THIRD-PARTY-NOTICES.md") return true;
  return relPosix.startsWith("licenses/") || relPosix.includes("/licenses/");
}

function isExcludedRelPath(relPosix) {
  if (EXCLUDED_EXACT_FILES.has(relPosix)) return true;
  return EXCLUDED_DIR_PREFIXES.some(
    (prefix) => relPosix === prefix.slice(0, -1) || relPosix.startsWith(prefix),
  );
}

function hasLocalUserProfilePath(line) {
  USER_PROFILE_PATH_RE.lastIndex = 0;
  let match;
  while ((match = USER_PROFILE_PATH_RE.exec(line)) !== null) {
    const userSegment = (match[1] ?? "").toLowerCase();
    if (!GENERIC_PROFILE_USERS.has(userSegment)) {
      return true;
    }
  }
  return false;
}

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function sanitizeGitignore(exportedDir) {
  const gitignorePath = path.join(exportedDir, ".gitignore");
  if (!existsSync(gitignorePath)) return;
  const raw = readFileSync(gitignorePath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const filtered = raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*\.(?:mimosa|video_agent)\/?\s*$/.test(line));
  writeFileSync(gitignorePath, filtered.join(eol), "utf8");
}

function sanitizeEslintConfig(exportedDir) {
  const eslintPath = path.join(exportedDir, "eslint.config.js");
  if (!existsSync(eslintPath)) return;
  const raw = readFileSync(eslintPath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const filtered = raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*["']\.(?:mimosa|video_agent)\/\*\*["']\s*,?\s*$/.test(line));
  writeFileSync(eslintPath, filtered.join(eol), "utf8");
}

function pruneExcludedPaths(exportedDir) {
  for (const prefix of EXCLUDED_DIR_PREFIXES) {
    const dirRel = prefix.slice(0, -1);
    const target = path.join(exportedDir, ...dirRel.split("/"));
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
  }
  for (const fileRel of EXCLUDED_EXACT_FILES) {
    const target = path.join(exportedDir, ...fileRel.split("/"));
    if (existsSync(target)) {
      rmSync(target, { force: true });
    }
  }
}

/**
 * Dışa aktarılmış kamuya açık ağacı fail-closed doğrular.
 *
 * @param {string} exportedDir
 * @returns {{ ok: boolean, findings: string[], fileCount: number }}
 */
export function verifyPublicTree(exportedDir) {
  const findings = [];
  if (!existsSync(exportedDir) || !statSync(exportedDir).isDirectory()) {
    return {
      ok: false,
      findings: [`hedef dizin mevcut değil: ${exportedDir}`],
      fileCount: 0,
    };
  }

  for (const requiredRel of REQUIRED_PUBLIC_FILES) {
    const full = path.join(exportedDir, ...requiredRel.split("/"));
    if (!existsSync(full) || !statSync(full).isFile()) {
      findings.push(`eksik zorunlu açık kaynak dosyası: ${requiredRel}`);
    }
  }

  const allFiles = walkFiles(exportedDir);
  for (const fullPath of allFiles) {
    const relPosix = toPosixRel(exportedDir, fullPath);

    if (isExcludedRelPath(relPosix)) {
      findings.push(`dışlanan yol sızıntısı: ${relPosix}`);
      continue;
    }

    const ext = path.extname(relPosix).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;

    let rawBuffer;
    try {
      rawBuffer = readFileSync(fullPath);
    } catch {
      continue;
    }
    if (rawBuffer.includes(0)) continue;

    const text = rawBuffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    const skipSecretCanary = SYNTHETIC_SECRET_CANARY_FILES.has(relPosix);
    const skipProfileCanary = SYNTHETIC_PROFILE_CANARY_FILES.has(relPosix);
    const allowUpstreamCopyrightEmail = isThirdPartyLicenseNoticeFile(relPosix);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const loc = `${relPosix}:${index + 1}`;

      if (PERSONAL_USER_RE.test(line)) {
        findings.push(`${loc} — personal-username`);
      }
      if (!skipProfileCanary && hasLocalUserProfilePath(line)) {
        findings.push(`${loc} — local-user-profile-path`);
      }
      if (LOCAL_DRIVE_REPO_RE.test(line)) {
        findings.push(`${loc} — local-repo-path`);
      }
      if (LOCAL_DRIVE_TOOLS_RE.test(line)) {
        findings.push(`${loc} — local-tools-path`);
      }
      if (INTERNAL_DWFRUN_RE.test(line)) {
        findings.push(`${loc} — internal-workflow-run-id`);
      }
      if (!skipSecretCanary) {
        for (const { name, re } of SECRET_PATTERNS) {
          if (allowUpstreamCopyrightEmail && name === "personal-email") continue;
          if (re.test(line)) {
            findings.push(`${loc} — ${name}`);
          }
        }
      }
    }
  }

  return {
    ok: findings.length === 0,
    findings,
    fileCount: allFiles.length,
  };
}

/**
 * Belirtilen Git ref'inden temiz açık kaynak ağacını dışa aktarır ve fail-closed doğrular.
 *
 * @param {{ repoRoot?: string, outDir: string, ref?: string }} options
 * @returns {{ outDir: string, ref: string, exportedFiles: string[], verification: { ok: boolean, findings: string[], fileCount: number } }}
 */
export function exportPublicTree(options) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const outDir = path.resolve(options.outDir);
  const ref = options.ref ?? "HEAD";

  if (typeof ref !== "string" || !SAFE_GIT_REF_RE.test(ref) || ref.includes("..")) {
    throw new Error(`Geçersiz Git ref reddedildi (fail-closed): ${String(ref)}`);
  }

  if (existsSync(outDir)) {
    const stat = statSync(outDir);
    if (!stat.isDirectory()) {
      throw new Error(`Hedef yol bir dizin değil: ${outDir}`);
    }
    if (readdirSync(outDir).length > 0) {
      throw new Error(`Hedef çıkış dizini boş olmalı (fail-closed): ${outDir}`);
    }
  } else {
    mkdirSync(outDir, { recursive: true });
  }

  // Salt-okunur git archive: çalışma ağacını veya Git indeksini asla değiştirmez.
  const tarBuffer = execFileSync("git", ["archive", "--format=tar", ref], {
    cwd: repoRoot,
    maxBuffer: 256 * 1024 * 1024,
    shell: false,
  });

  execFileSync("tar", ["-xf", "-", "-C", outDir], {
    input: tarBuffer,
    shell: false,
  });

  pruneExcludedPaths(outDir);
  sanitizeGitignore(outDir);
  sanitizeEslintConfig(outDir);

  const verification = verifyPublicTree(outDir);
  if (!verification.ok) {
    throw new Error(
      `PUBLIC_EXPORT KIRMIZI — doğrulama başarısız (${verification.findings.length} bulgu):\n` +
        verification.findings.map((f) => `  - ${f}`).join("\n"),
    );
  }

  const exportedFiles = walkFiles(outDir)
    .map((full) => toPosixRel(outDir, full))
    .sort();

  return {
    outDir,
    ref,
    exportedFiles,
    verification,
  };
}

function parseCliArgs(argv) {
  let outDir = "";
  let ref = "HEAD";
  let repoRoot = DEFAULT_REPO_ROOT;
  let verifyTemp = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      outDir = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--ref") {
      ref = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--repo") {
      repoRoot = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--verify-temp") {
      verifyTemp = true;
    } else {
      throw new Error(`Bilinmeyen argüman: ${String(arg)}`);
    }
  }

  if (verifyTemp && outDir) {
    throw new Error("--verify-temp ve --out aynı anda kullanılamaz.");
  }
  if (!verifyTemp && !outDir) {
    throw new Error("Zorunlu --out <boş-hedef-dizin> veya --verify-temp parametresi eksik.");
  }

  return { outDir, ref, repoRoot, verifyTemp };
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  let tempDir = "";
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    if (cli.verifyTemp) {
      tempDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-export-gate-"));
    }
    const targetOutDir = cli.verifyTemp ? tempDir : cli.outDir;
    const result = exportPublicTree({
      repoRoot: cli.repoRoot,
      outDir: targetOutDir,
      ref: cli.ref,
    });
    console.log(
      `PUBLIC_EXPORT YEŞİL — ref=${result.ref}, ${result.exportedFiles.length} dosya temiz aktarıldı → ${result.outDir}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
