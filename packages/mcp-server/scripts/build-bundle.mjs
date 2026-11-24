/**
 * Sprint-7 F1 — build:bundle (TŞ v2.1 §17.1/§17.2).
 *
 *   node scripts/build-bundle.mjs   (npm run build:bundle ile aynı)
 *
 * DÖRT çıktı üretir (dist/ ve integrations/antigravity/causoryn/scripts/
 * kök .gitignore kapsamındadır — derlenmiş bundle artefaktları commit EDİLMEZ,
 * yalnızca deterministik üretim ve sahneleme kanıtlanır):
 *
 *   1. dist/mcp-server.mjs                    — esbuild bundle
 *   2. dist/node_modules/better-sqlite3/      — vendored çalışma zamanı
 *      (package.json + lib/** + prebuilds/**)
 *   3. dist/bundle-manifest.json              — her dosyanın sha256'ı
 *      (determinizm kanıtı: iki build bit-bit aynı manifest üretir)
 *   4. integrations/antigravity/causoryn/scripts/ — aynı 3 çıktının
 *      Antigravity eklenti köküne deterministik sahnelenmiş kopyası
 *
 * PAKETLEME KARARI (görev sözleşmesi + ADR-010 dürüstlük):
 *
 * 1) GİRİŞ NOKTASI src/stdio.ts'tir, src/index.ts DEĞİL. index.ts saf
 *    barrel re-export'tur (module düzeyinde main() çağrısı YOKTUR); onu
 *    bundle'layıp spawn'layan bir süreç hiçbir şey yapmazdı. TŞ §17.1
 *    kuralı "scripts/mcp-server.mjs gerçekten derlenmiş (çalışan)
 *    başlangıç noktası olmalı"dır — stdio.ts'in module-top-level
 *    main()'i bu koşulu sağlayan tek kaynaktır.
 *
 * 2) better-sqlite3 EXTERNAL tutulur (--external:better-sqlite3).
 *    better-sqlite3 NATİF bir modüldür (prebuilds/win32-x64.node vb.);
 *    esbuild native .node dosyasını tek dosyaya gömemez. Görevin
 *    istediği bayraklar aynen kullanılır: --bundle --platform=node
 *    --format=esm --external:better-sqlite3.
 *
 * 3) "node_modules YOKSA bile bulma" çözümü: bundle, bare specifier'ı
 *    STATIC ESM import olarak korur (external → esbuild import
 *    ifadesini dokunmaz). Node, bare specifier'ı mcp-server.mjs'in
 *    bulunduğu dizinden yukarı doğru node_modules arayarak çözer;
 *    build script'i better-sqlite3'ün çalışma zamanı katmanını
 *    (package.json + lib/** + prebuilds/** — yalnızca runtime dosyalar:
 *    lib katmanı fs/path dışında dış bağımlılık istemez, node-addon-api
 *    yalnızca derleme başlığıdır) dist/node_modules/better-sqlite3
 *    altına GERÇEK node_modules düzeniyle kopyalar. Böylece hedef
 *    ortamda repo node_modules olmasa bile çözümleme kendi yanındaki
 *    vendored kopyadan yapılır.
 *
 *    createRequire(import.meta.url) banner'ı (karar gerekçesi): better-
 *    sqlite3 external STATIC import kaldığı için onun çözümlemesi Node'un
 *    kendi resolution algoritmasıyla yapılır (default = module.exports
 *    interop'ı doğaldır) — ayrıca bir shim GEREKMEZ. Ancak bundle'a
 *    gömülü CJS kaynaklar (ör. yaml/dist) esbuild'in ESM çıktısında
 *    `require(...)` çağrılarını __require shim'ine çevirir; shim, modül
 *    kapsamında `require` tanımlı değilse "Dynamic require of X is not
 *    supported" ile düşer (F1 testinde gerçek bulgu: yaml → require
 *    ("process")). Banner, bundle'ın üst kapsamına `const require =
 *    createRequire(import.meta.url)` koyarak shim'i çalışır kılar;
 *    import.meta.url bundle dizinini gösterdiğinden çözümleme kuralları
 *    dist/mcp-server.mjs'ten yürür. Bu, görev sözleşmesinin işaret
 *    ettiği yaygın çözümün bu tasarımdaki GERÇEK zorunlu kullanım
 *    yeridir; ileride JS katmanı gömülüp .node elle require edilecek
 *    olursa aynı mekanizma o yolu da taşır (baked __dirname yolları
 *    o senaryoda yeniden yönlendirilmelidir).
 *
 * 4) Dürüstlük (ADR-010): artefakt TEK DOSYA DEĞİLDİR. Doğru iddia:
 *    "dist/mcp-server.mjs + dist/node_modules/better-sqlite3 (lib JS +
 *    prebuilds)". Yalnızca "mjs + çıplak prebuilds/" düzeni teknik
 *    olarak imkânsızdır: .node dosyası Node tarafından doğrudan
 *    import edilemez; onu yükleyen JS paket katmanının da diskinde
 *    bulunması gerekir.
 *
 * 5) DETERMİNİZM: esbuild aynı sürüm + aynı girdi ile bit-bit aynı
 *    çıktı üretir (timestamp gömmez); vendor kopyası içerik-özdeş
 *    dosya kümesidir; manifest, sıralı anahtarlarla sha256 yazar.
 *    Kod üretimi sabitlemesi için target "node24" (kök engines ile aynı).
 */

import { build } from "esbuild";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listFiles } from "./lib/list-files.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(PKG_DIR, "..", "..");
const DIST_DIR = path.join(PKG_DIR, "dist");
const BUNDLE_PATH = path.join(DIST_DIR, "mcp-server.mjs");
const WORKER_BUNDLE_PATH = path.join(DIST_DIR, "index-worker.mjs");
const WORKER_ENTRY_PATH = path.join(PKG_DIR, "src", "index-worker-entry.ts");
const LEGAL_PATH = path.join(DIST_DIR, "mcp-server.mjs.LEGAL.txt");
const MANIFEST_PATH = path.join(DIST_DIR, "bundle-manifest.json");
const VENDOR_PARENT = path.join(DIST_DIR, "node_modules");
const VENDOR_DEST = path.join(VENDOR_PARENT, "better-sqlite3");
const SQLITE_SRC = path.join(REPO_ROOT, "node_modules", "better-sqlite3");
const ANTIGRAVITY_SCRIPTS_DIR = path.join(
  REPO_ROOT,
  "integrations",
  "antigravity",
  "causoryn",
  "scripts",
);
const ANTIGRAVITY_VENDOR_DEST = path.join(
  ANTIGRAVITY_SCRIPTS_DIR,
  "node_modules",
  "better-sqlite3",
);

/** Vendored kopyaya giren allowlist: yalnızca çalışma zamanı ve lisans dosyaları. */
const VENDOR_ENTRIES = ["package.json", "LICENSE", "lib", "prebuilds"];

function assertExists(filePath, label) {
  if (!existsSync(filePath)) {
    console.error(`[build:bundle] ${label} bulunamadı: ${filePath}`);
    process.exit(1);
  }
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function writeFileAtomic(destPath, content) {
  mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, destPath);
}

assertExists(path.join(PKG_DIR, "src", "stdio.ts"), "giriş noktası src/stdio.ts");
assertExists(SQLITE_SRC, "repo node_modules/better-sqlite3 (npm install gerekli)");

// --- 1) Bundle (in-memory + atomik yazım: koşut testlerde ENOENT penceresi yok) ---
const buildResult = await build({
  absWorkingDir: PKG_DIR,
  entryPoints: ["src/stdio.ts"],
  outfile: "dist/mcp-server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  write: false,
  // Görev sözleşmesindeki bayraklar: native .node gömülemez → EXTERNAL.
  external: ["better-sqlite3"],
  // ESM çıktısında CJS'ten çevrilen dinamik require'ları (ör. yaml →
  // require("process")) VE CJS global'larını (__filename/__dirname —
  // bundled typescript.js getNodeSystem bunları kullanır) çalışır kılar;
  // ayrıntı yukarıdaki karar notunda. __filename/__dirname değerleri
  // bundle'ın KENDİ yoludur (esbuild format=esm'de modül-bazlı literal
  // eklemez); typescript.js bu yolu yalnızca executingFilePath (sys.js
  // variant tespiti + default lib konumu) için okur — Causoryn'in
  // parse kullanımı (createSourceFile/createProgram, fixture kaynakları)
  // bu konuma bağımlı değildir; bundle smoke testi bunu kanıtlar.
  banner: {
    js: [
      "/* eslint-disable */",
      'import { createRequire } from "node:module";',
      'import { fileURLToPath as __causorynFileURLToPath } from "node:url";',
      "const require = createRequire(import.meta.url);",
      "const __filename = __causorynFileURLToPath(import.meta.url);",
      'const __dirname = __causorynFileURLToPath(new URL(".", import.meta.url));',
    ].join("\n"),
  },
  sourcemap: false,
  minify: false,
  legalComments: "linked",
  logLevel: "warning",
});

const outputFiles = buildResult.outputFiles ?? [];
const bundleOut = outputFiles.find((f) => path.resolve(f.path) === path.resolve(BUNDLE_PATH));
const legalOut = outputFiles.find((f) => path.resolve(f.path) === path.resolve(LEGAL_PATH));
if (!bundleOut || !legalOut) {
  console.error("[build:bundle] esbuild beklenen mcp-server.mjs veya mcp-server.mjs.LEGAL.txt çıktısını üretmedi");
  process.exit(1);
}

// Sahnelenmiş scripts/mcp-server.mjs kök `eslint .` taramasına girdiğinde
// gömülü bağımlılıklardaki iç `eslint-disable` / `eslint-enable` yorumları
// ESLint v10 reportUnusedDisableDirectives altında uyarıya düşer ve
// `eslint --fix` çalıştırılırsa dosyayı değiştirerek sha256 manifest
// eşleşmesini bozar. İlk satırdaki dosya-düzeyi `/* eslint-disable */`
// korunur; gövdedeki iç direktif yorumları manifest hesaplanmadan önce
// deterministik biçimde etkisizleştirilir.
const rawBundle = bundleOut.text;
const firstNewline = rawBundle.indexOf("\n");
const finalBundleText =
  firstNewline >= 0
    ? rawBundle.slice(0, firstNewline + 1) +
      rawBundle
        .slice(firstNewline + 1)
        .replace(/(\/\/|\/\*)\s*eslint-(disable|enable)\b/g, "$1 [bundled-lint-directive] $2")
    : rawBundle;
const finalBundleBytes = Buffer.from(finalBundleText, "utf8");
const finalLegalBytes = Buffer.from(legalOut.contents);

writeFileAtomic(BUNDLE_PATH, finalBundleBytes);
writeFileAtomic(LEGAL_PATH, finalLegalBytes);

// --- 1b) Non-blocking worker_threads indexing bundle (Wave 2 Task 2.5) ---
assertExists(WORKER_ENTRY_PATH, "indexing worker giriş noktası src/index-worker-entry.ts");
const workerBuildResult = await build({
  absWorkingDir: PKG_DIR,
  entryPoints: [WORKER_ENTRY_PATH],
  outfile: "dist/index-worker.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  write: false,
  external: ["better-sqlite3"],
  banner: {
    js: [
      "/* eslint-disable */",
      'import { createRequire } from "node:module";',
      'import { fileURLToPath as __causorynFileURLToPath } from "node:url";',
      "const require = createRequire(import.meta.url);",
      "const __filename = __causorynFileURLToPath(import.meta.url);",
      'const __dirname = __causorynFileURLToPath(new URL(".", import.meta.url));',
    ].join("\n"),
  },
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "warning",
});
const workerOut = (workerBuildResult.outputFiles ?? []).find(
  (f) => path.resolve(f.path) === path.resolve(WORKER_BUNDLE_PATH),
);
if (!workerOut) {
  console.error("[build:bundle] esbuild beklenen index-worker.mjs çıktısını üretmedi");
  process.exit(1);
}
const rawWorker = workerOut.text;
const workerFirstNl = rawWorker.indexOf("\n");
const finalWorkerText =
  workerFirstNl >= 0
    ? rawWorker.slice(0, workerFirstNl + 1) +
      rawWorker
        .slice(workerFirstNl + 1)
        .replace(/(\/\/|\/\*)\s*eslint-(disable|enable)\b/g, "$1 [bundled-lint-directive] $2")
    : rawWorker;
const finalWorkerBytes = Buffer.from(finalWorkerText, "utf8");
writeFileAtomic(WORKER_BUNDLE_PATH, finalWorkerBytes);

// --- 2) Vendored better-sqlite3 çalışma zamanı ----------------------------
mkdirSync(VENDOR_DEST, { recursive: true });
for (const entry of VENDOR_ENTRIES) {
  const source = path.join(SQLITE_SRC, entry);
  assertExists(source, `better-sqlite3 çalışma zamanı parçası ${entry}`);
  cpSync(source, path.join(VENDOR_DEST, entry), { recursive: true, force: true });
}

// --- 3) Deterministik sha256 manifest -------------------------------------
// Manifest YALNIZCA bu script'in kendi çıktılarını kapsar (mcp-server.mjs +
// mcp-server.mjs.LEGAL.txt + vendored node_modules/**). dist/'teki tsc çıktıları
// (npm run build) kapsam dışıdır — aksi halde determinizm, bundle ile ilgisiz
// dosyalara bağımlı kalırdı.
const files = {};
files["mcp-server.mjs"] = createHash("sha256").update(finalBundleBytes).digest("hex");
files["mcp-server.mjs.LEGAL.txt"] = createHash("sha256").update(finalLegalBytes).digest("hex");
files["index-worker.mjs"] = createHash("sha256").update(finalWorkerBytes).digest("hex");
for (const rel of listFiles(VENDOR_DEST)) {
  files[`node_modules/better-sqlite3/${rel}`] = sha256(
    path.join(VENDOR_DEST, ...rel.split("/")),
  );
}
const manifest = `${JSON.stringify({ files }, null, 2)}\n`;
writeFileAtomic(MANIFEST_PATH, Buffer.from(manifest, "utf8"));

// --- 4) Antigravity eklenti paketine deterministik sahneleme --------------
// dist/ altındaki deterministik manifest ve artefakt düzeni birebir korunur;
// aynı çıktılar integrations/antigravity/causoryn/scripts/ altına atomik olarak
// sahnelenir (.gitignore bu dizini kapsar; derlenmiş artefakt commit edilmez).
mkdirSync(ANTIGRAVITY_VENDOR_DEST, { recursive: true });
writeFileAtomic(path.join(ANTIGRAVITY_SCRIPTS_DIR, "mcp-server.mjs"), finalBundleBytes);
writeFileAtomic(path.join(ANTIGRAVITY_SCRIPTS_DIR, "mcp-server.mjs.LEGAL.txt"), finalLegalBytes);
writeFileAtomic(path.join(ANTIGRAVITY_SCRIPTS_DIR, "index-worker.mjs"), finalWorkerBytes);
for (const entry of VENDOR_ENTRIES) {
  cpSync(
    path.join(VENDOR_DEST, entry),
    path.join(ANTIGRAVITY_VENDOR_DEST, entry),
    { recursive: true, force: true },
  );
}
writeFileAtomic(
  path.join(ANTIGRAVITY_SCRIPTS_DIR, "bundle-manifest.json"),
  Buffer.from(manifest, "utf8"),
);

const bundleHash = files["mcp-server.mjs"];
console.error(
  `[build:bundle] ok — dist/mcp-server.mjs sha256=${bundleHash} · vendored better-sqlite3 (${Object.keys(files).length - 1} dosya) · dist/bundle-manifest.json · staged integrations/antigravity/causoryn/scripts/`,
);
