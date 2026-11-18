/**
 * secret-scan — üretim kaynak yüzeyinde kimlik bilgisi kalıbı tarayıcısı.
 *
 * Amaç: denetim turunda tespit edilen "adanmış secret-scan script'i yok" açık
 * kalemını kapatır (docs/implementation-status.md Sprint 5 açık kalem 7).
 * Kapsam (7 kök): packages, adapters, apps, native, scripts,
 * integrations/zcode/causoryn ve integrations/antigravity/causoryn (test,
 * derleme çıktıları ve bait fixture dizinleri HARİÇ — güvenlik testlerinde
 * sahte yem token'ları bilinçli olarak yaşar; f6-security-release.test.ts deseni).
 *
 * Kural: herhangi bir eşleşmede veya eksik beyanlı kökte exit 1 (kapı kırmızı);
 * temizde gerçekte taranan kök sayısıyla exit 0.
 * Desenler yüksek-hassasiyet seçildi: bilinen token formatları + private key
 * bloğu + atanan gizli literal; source kodunda tip tanımları ve env okumaları
 * eşleşmez.
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
  path.join("integrations", "antigravity", "causoryn"),
];

/**
 * Sahnelenmiş derleme çıktısı (.gitignore satır 4: integrations/antigravity/causoryn/scripts/).
 * "scripts" genel segment dışlamasına eklenmez (kök scripts/ ve packages/mcp-server/scripts/
 * taranmaya devam etmelidir); yalnızca bu repo-göreli sahneleme dizini dist/ ile simetrik atlanır.
 */
const STAGED_BUILD_REL = path.join("integrations", "antigravity", "causoryn", "scripts");

const EXCLUDE_SEGMENTS = new Set([
  "node_modules", "dist", "target", "test", "tests", "__tests__",
  "__pycache__", "fixture", "fixtures", "example", "examples", "docs",
  "bin", "obj", "skills",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".json", ".md", ".yaml",
  ".yml", ".toml", ".py", ".go", ".rs", ".cs", ".csproj",
]);

const PATTERNS = [
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    name: "assigned-secret-literal",
    re: /(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*["'][^"']{12,}["']/i,
  },
  { name: "personal-email", re: /[A-Za-z0-9._%+-]+@(?:gmail|hotmail|outlook)\.com/i },
];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_SEGMENTS.has(entry.name)) continue;
      if (path.relative(REPO_ROOT, full) === STAGED_BUILD_REL) continue;
      yield* walk(full);
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      // Tarayıcı kendi kaynaklarını taramaz: desen literalleri bu dosyada
      // bilinçli olarak yaşar (self-match önleme).
      if (path.basename(full) === "secret-scan.mjs") continue;
      yield full;
    }
  }
}

function existsSyncLocal(targetPath) {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

const missingRoots = [];
const findings = [];
let scannedRoots = 0;

for (const root of SCAN_ROOTS) {
  const fullRoot = path.join(REPO_ROOT, root);
  if (!existsSyncLocal(fullRoot)) {
    missingRoots.push(root);
    continue;
  }
  scannedRoots += 1;
  for (const file of walk(fullRoot)) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const { name, re } of PATTERNS) {
      lines.forEach((line, index) => {
        if (re.test(line)) {
          findings.push(`${path.relative(REPO_ROOT, file)}:${index + 1} — ${name}`);
        }
      });
    }
  }
}

if (missingRoots.length > 0) {
  console.error("SECRET_SCAN KIRMIZI — beyan edilen kök dizin bulunamadı:");
  for (const missing of missingRoots) console.error("  " + missing);
  process.exit(1);
}

if (findings.length > 0) {
  console.error("SECRET_SCAN KIRMIZI — eşleşen satırlar:");
  for (const finding of findings) console.error("  " + finding);
  process.exit(1);
}
console.log(`SECRET_SCAN YEŞİL — ${scannedRoots} kök tarandı, 0 eşleşme.`);
