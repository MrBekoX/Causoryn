/**
 * secret-scan — üretim kaynak, doküman, workflow ve kök yapılandırma yüzeyinde
 * kimlik bilgisi ve yerel kullanıcı profili yolu tarayıcısı (F-P2-01, K-022).
 *
 * Kapsam (13 dizin kökü + kök metin dosyaları):
 *   packages, adapters, apps, native, scripts, integrations/zcode/causoryn,
 *   integrations/zcode/.claude-plugin, integrations/antigravity/causoryn,
 *   .github, .claude-plugin, .agents, docs, skills + ROOT_TEXT_FILES.
 *
 * Bilinçli dışlamalar:
 * - `raw/` ve `wiki/`: kamuya açık dışa aktarımdan (`scripts/export-public-tree.mjs`)
 *   dışlanan özel arşiv/çalışma kayıtlarıdır; SCAN_ROOTS'ta yer almaz.
 * - `docs/superpowers/`: dışa aktarımdan dışlanan iç geliştirme planlarıdır.
 * - `test/`, `tests/`, `__tests__/`, `fixture/`, `fixtures/`, `example/`, `examples/`:
 *   güvenlik testlerinde sentetik yem token'ları bilinçli olarak yaşar.
 * - `node_modules/`, `dist/`, `target/`, `bin/`, `obj/`, `__pycache__/` ve
 *   `integrations/antigravity/causoryn/scripts/`: derleme/sahneleme çıktıları.
 *
 * Kural: herhangi bir eşleşmede veya eksik beyanlı kökte/dosyada exit 1 (kapı kırmızı);
 * temizde taranan kök ve kök-dosya sayısıyla exit 0.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SCAN_ROOTS = [
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
];

const ROOT_TEXT_FILES = [
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
];

/**
 * Repo-göreli dışlanan alt dizinler:
 * - integrations/antigravity/causoryn/scripts: sahnelenmiş derleme çıktısı (.gitignore satır 4).
 * - docs/superpowers: iç geliştirme planları (export-public-tree.mjs tarafından dışlanır).
 */
const EXCLUDE_REL_PATHS = new Set([
  path.join("integrations", "antigravity", "causoryn", "scripts"),
  path.join("docs", "superpowers"),
]);

const EXCLUDE_SEGMENTS = new Set([
  "node_modules", "dist", "target", "test", "tests", "__tests__",
  "__pycache__", "fixture", "fixtures", "example", "examples",
  "bin", "obj",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", ".md", ".yaml",
  ".yml", ".toml", ".py", ".go", ".rs", ".cs", ".csproj", ".mod", ".lock", ".txt",
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

const PATTERNS = [
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
  {
    name: "assigned-secret-literal",
    re: /(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*["'][^"']{12,}["']/i,
  },
  { name: "personal-email", re: /[A-Za-z0-9._%+-]+@(?:gmail|hotmail|outlook)\.com/i },
];

const USER_PROFILE_PATH_RE =
  /(?:[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)|\/(?:Users|home)\/)(<[A-Za-z0-9._-]+>|[A-Za-z0-9._-]+)/g;

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

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_SEGMENTS.has(entry.name)) continue;
      if (EXCLUDE_REL_PATHS.has(path.relative(REPO_ROOT, full))) continue;
      yield* walk(full);
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      // Tarayıcı kendi kaynaklarını taramaz: desen literalleri bu dosyada
      // bilinçli olarak yaşar (self-match önleme).
      if (path.basename(full) === "secret-scan.mjs") continue;
      yield full;
    }
  }
}

function isExistingDir(targetPath) {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function isExistingFile(targetPath) {
  try {
    return statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

function isThirdPartyLicenseNoticeFile(relPosix) {
  const base = path.posix.basename(relPosix);
  if (base === "THIRD-PARTY-NOTICES.md") return true;
  return relPosix.startsWith("licenses/") || relPosix.includes("/licenses/");
}

function scanFile(filePath, findings) {
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  const relPath = path.relative(REPO_ROOT, filePath);
  const relPosix = relPath.split(path.sep).join("/");
  const allowUpstreamCopyrightEmail = isThirdPartyLicenseNoticeFile(relPosix);
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const { name, re } of PATTERNS) {
      if (allowUpstreamCopyrightEmail && name === "personal-email") continue;
      if (re.test(line)) {
        findings.push(`${relPath}:${index + 1} — ${name}`);
      }
    }
    if (hasLocalUserProfilePath(line)) {
      findings.push(`${relPath}:${index + 1} — local-user-profile-path`);
    }
  }
}

const missingRoots = [];
const findings = [];
let scannedRoots = 0;
let scannedRootFiles = 0;

for (const root of SCAN_ROOTS) {
  const fullRoot = path.join(REPO_ROOT, root);
  if (!isExistingDir(fullRoot)) {
    missingRoots.push(root);
    continue;
  }
  scannedRoots += 1;
  for (const file of walk(fullRoot)) {
    scanFile(file, findings);
  }
}

for (const rootFile of ROOT_TEXT_FILES) {
  const fullFile = path.join(REPO_ROOT, rootFile);
  if (!isExistingFile(fullFile)) {
    missingRoots.push(rootFile);
    continue;
  }
  scannedRootFiles += 1;
  scanFile(fullFile, findings);
}

if (missingRoots.length > 0) {
  console.error("SECRET_SCAN KIRMIZI — beyan edilen kök dizin/dosya bulunamadı:");
  for (const missing of missingRoots) console.error("  " + missing);
  process.exit(1);
}

if (findings.length > 0) {
  console.error("SECRET_SCAN KIRMIZI — eşleşen satırlar:");
  for (const finding of findings) console.error("  " + finding);
  process.exit(1);
}
console.log(
  `SECRET_SCAN YEŞİL — ${scannedRoots} kök tarandı (+ ${scannedRootFiles} kök dosyası), 0 eşleşme.`,
);
