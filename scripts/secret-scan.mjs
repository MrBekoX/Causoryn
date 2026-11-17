/**
 * secret-scan — üretim kaynak yüzeyinde kimlik bilgisi kalıbı tarayıcısı.
 *
 * Amaç: denetim turunda tespit edilen "adanmış secret-scan script'i yok" açık
 * kalemını kapatır (docs/implementation-status.md Sprint 5 açık kalem 7).
 * Kapsam: packages ve adapters altındaki src dizinleri, scripts dizini ve
 * integrations zcode causoryn paketi (test ve bait fixture dizinleri HARİÇ —
 * güvenlik testlerinde sahte yem token'ları bilinçli olarak yaşar;
 * f6-security-release.test.ts deseni).
 *
 * Kural: herhangi bir eşleşmede exit 1 (kapı kırmızı); temizde exit 0.
 * Desenler yüksek-hassasiyet seçildi: bilinen token formatları + private key
 * bloğu + atanan gizli literal; source kodunda tip tanımları ve env okumaları
 * eşleşmez.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SCAN_ROOTS = [
  "packages",
  "adapters",
  "scripts",
  path.join("integrations", "zcode", "causoryn"),
];

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
      yield* walk(full);
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      // Tarayıcı kendi kaynaklarını taramaz: desen literalleri bu dosyada
      // bilinçli olarak yaşar (self-match önleme).
      if (path.basename(full) === "secret-scan.mjs") continue;
      yield full;
    }
  }
}

const findings = [];
for (const root of SCAN_ROOTS) {
  if (!existsSyncLocal(root)) continue;
  for (const file of walk(root)) {
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
          findings.push(`${file}:${index + 1} — ${name}`);
        }
      });
    }
  }
}

function existsSyncLocal(relativeRoot) {
  try {
    statSync(relativeRoot);
    return true;
  } catch {
    return false;
  }
}

if (findings.length > 0) {
  console.error("SECRET_SCAN KIRMIZI — eşleşen satırlar:");
  for (const finding of findings) console.error("  " + finding);
  process.exit(1);
}
console.log(`SECRET_SCAN YEŞİL — ${SCAN_ROOTS.length} kök tarandı, 0 eşleşme.`);
