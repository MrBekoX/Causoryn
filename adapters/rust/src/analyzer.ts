/**
 * analyzeRustWorkspace — syn sidecar worker sürecini yöneten TS adapter
 * çekirdeği (TŞ v2.1 §7; M1-Rust).
 *
 * Çıkarım disiplini (csharp-roslyn önceliğiyle aynı):
 * - Worker SAĞLIKLI yanıt verdiyse: PROTOCOL.md v1 çıktısı katalog
 *   doğrulamasından (TŞ §8 27-node / 20-edge / 3-resolution setleri)
 *   geçtikten sonra domain createSnapshot GİRDİ sözleşmesine map edilir —
 *   adapter ID ÜRETMEZ, uydurma kenar eklemez; canonical ID / de-dup
 *   merkezi normalizer'dadır (TŞ §7.1).
 * - Worker kullanılamadıysa (binary yok + cargo derleyemedi / başlatılamama /
 *   çökme / timeout / bozuk yanıt): motor ÇÖKMEZ — L0/L1 dosya düzeyine
 *   düşülür: File node'ları (sourceHash kanıtlı) korunur, sembol/kenar
 *   üretilmez, state=partial + coverage=0 + explicit warning (stderr'e de
 *   loglanır). TŞ §7: "Parser başarısızsa yalnızca kanıtlanabilen L0/L1
 *   bilgisi sunulur."
 * - Tek dosyadaki girdi sorunu (mutlak yol, ".." kaçışı, duplicate) analiz
 *   düşürmeden DomainError ile reddedilir — adapter izolasyonu motor
 *   tarafındaki hata toplayıcısına aittir (TŞ §7).
 *
 * Determinizm: girdi sıralanır, istek id workspaceId'den türetilir, saat
 * okunmaz; aynı girdi → aynı sonuç JSON (TŞ §8 invariant vi).
 */
import {
  DomainError,
  EDGE_KIND_SET,
  NODE_KIND_SET,
  RESOLUTION_SET,
  sha256Hex,
  utf8Encode,
  type EdgeKind,
  type NodeKind,
  type NodeRef,
  type Resolution,
  type SnapshotEdgeInput,
  type SnapshotEvidenceInput,
  type SnapshotNodeInput,
  type SourceSpan,
} from "@causoryn/domain";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  isCargoAvailable,
  resolveCargoHomeDir,
  runCargoBuild,
} from "./cargo.js";
import { runWorkerAnalyze, type WorkerRunOutcome } from "./worker-process.js";
import {
  DEFAULT_CARGO_BUILD_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RESPONSE_MAX_CHARS,
  defaultWorkerDir,
  defaultWorkerManifestPath,
  defaultWritableRustTargetDir,
  RUST_ADAPTER_ID,
  RUST_ADAPTER_VERSION,
  WORKER_BINARY_NAME,
  WORKER_UNAVAILABLE_CAPABILITIES,
  type AnalyzeRustWorkspaceInput,
  type RustAdapterCapabilities,
  type RustAdapterDiagnostic,
  type RustAdapterOptions,
  type RustAdapterResult,
} from "./types.js";

export { defaultWritableRustTargetDir } from "./types.js";

/** cargo-home override çözümlemesi (options.cargoHomeDir önceliklidir). */
function resolveCargoHome(options: Partial<RustAdapterOptions> | undefined): string | null {
  if (options?.cargoHomeDir !== undefined && options.cargoHomeDir.trim().length > 0) {
    return options.cargoHomeDir;
  }
  return resolveCargoHomeDir();
}

export interface AnalyzeRustWorkspaceOptions extends Partial<RustAdapterOptions> {
  /** false iken eksik/bozuk worker binary'si otomatik derlenmez, güvenli reddedilir. */
  readonly autoBuild?: boolean;
}

interface ResolvedRuntimeOptions {
  readonly workerDir: string;
  readonly workerBinaryName: string;
  readonly cargoHomeDir: string | null;
  readonly requestTimeoutMs: number;
  readonly responseMaxChars: number;
  readonly cargoBuildTimeoutMs: number;
  readonly hasSpawnInjection: boolean;
  readonly hasExplicitWorkerDir: boolean;
  readonly autoBuild: boolean;
}

function resolveOptions(
  partial?: AnalyzeRustWorkspaceOptions,
): ResolvedRuntimeOptions {
  const cargoHome = resolveCargoHome(partial);
  const envWorkerDir = process.env["CAUSORYN_RUST_WORKER_DIR"];
  const hasExplicitWorkerDir =
    partial?.workerDir !== undefined ||
    (envWorkerDir !== undefined && envWorkerDir.trim().length > 0);
  const workerDir = partial?.workerDir ?? defaultWorkerDir();
  return {
    workerDir,
    workerBinaryName: WORKER_BINARY_NAME, // LİTERAL sabit — opsiyonla değişmez
    cargoHomeDir: cargoHome,
    requestTimeoutMs:
      partial?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    responseMaxChars:
      partial?.responseMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS,
    cargoBuildTimeoutMs:
      partial?.cargoBuildTimeoutMs ?? DEFAULT_CARGO_BUILD_TIMEOUT_MS,
    hasSpawnInjection: partial?.spawnProcess !== undefined,
    hasExplicitWorkerDir,
    autoBuild: partial?.autoBuild !== false,
  };
}

/** TS adapter yol normalizasyonu — aynı reddiyeler, aynı hata kodları. */
function normalizeRelativePath(raw: string): string {
  const posix = raw.replace(/\\/g, "/");
  if (posix.startsWith("/") || /^[a-zA-Z]:/.test(posix)) {
    throw new DomainError(
      "adapter/absolute-source-path",
      `Mutlak kaynak yolu kabul edilmez: ${raw}`,
    );
  }

  for (const segment of posix.split("/")) {
    if (segment.length === 0 || segment === ".") {
      throw new DomainError(
        "adapter/invalid-source-path",
        `Kaynak yolu boş/geçersiz segment içeriyor: ${raw}`,
      );
    }

    if (segment === "..") {
      throw new DomainError(
        "adapter/source-path-escape",
        `Kaynak yolu kök dışına çıkıyor: ${raw}`,
      );
    }
  }

  return posix;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* Worker binary bütünlük doğrulaması ve sağlama (Task 1.1)            */
/* ------------------------------------------------------------------ */

const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const NOFOLLOW_READ_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const INTEGRITY_META_MAX_BYTES = 64 * 1024;

export interface RustWorkerIntegrityRecord {
  readonly sourceFingerprint: string;
  readonly binarySha256: string;
}

/** Önbellekteki worker binary'si için yan-dosya bütünlük kaydı yolu. */
export function rustWorkerIntegrityPath(binaryPath: string): string {
  return `${binaryPath}.sha256.json`;
}

function lstatOrNull(filePath: string): Stats | null {
  try {
    return lstatSync(filePath);
  } catch {
    return null;
  }
}

/**
 * Dosyayı lstatSync + O_NOFOLLOW + fstatSync kimlik eşleşmesiyle okur.
 * Symlink / dizin / özel dosya veya açma-arası değişim (TOCTOU) reddedilir.
 */
function readRegularFileBytesNoFollow(
  filePath: string,
  maxBytes?: number,
): Buffer | null {
  const st = lstatOrNull(filePath);
  if (st === null || st.isSymbolicLink() || !st.isFile()) {
    return null;
  }
  if (maxBytes !== undefined && st.size > maxBytes) {
    return null;
  }
  let fd: number | null = null;
  try {
    fd = openSync(filePath, NOFOLLOW_READ_FLAGS);
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile()) return null;
    if (st.ino !== 0 && (fdStat.dev !== st.dev || fdStat.ino !== st.ino)) {
      return null;
    }
    const chunks: Buffer[] = [];
    const buf = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buf, 0, buf.length, null);
      if (read <= 0) break;
      total += read;
      if (maxBytes !== undefined && total > maxBytes) {
        return null;
      }
      chunks.push(Buffer.from(buf.subarray(0, read)));
    }
    return Buffer.concat(chunks, total);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
  }
}

/**
 * Düzenli dosyayı O_NOFOLLOW ile akışlı okuyup SHA-256 hex özetini üretir.
 * Symlink, özel dosya veya TOCTOU sapmasında null döner.
 */
export function readRegularFileSha256NoFollow(filePath: string): string | null {
  const st = lstatOrNull(filePath);
  if (st === null || st.isSymbolicLink() || !st.isFile()) {
    return null;
  }
  let fd: number | null = null;
  try {
    fd = openSync(filePath, NOFOLLOW_READ_FLAGS);
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile()) return null;
    if (st.ino !== 0 && (fdStat.dev !== st.dev || fdStat.ino !== st.ino)) {
      return null;
    }
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = readSync(fd, buf, 0, buf.length, null);
      if (read <= 0) break;
      hash.update(buf.subarray(0, read));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
  }
}

function collectSortedRsFiles(srcDir: string): string[] {
  const results: string[] = [];
  const walk = (currentDir: string, relPrefix: string): void => {
    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(currentDir, entry.name);
      const relPosix =
        relPrefix.length === 0 ? entry.name : `${relPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(fullPath, relPosix);
      } else if (entry.isFile() && entry.name.endsWith(".rs")) {
        results.push(relPosix);
      }
    }
  };
  walk(srcDir, "");
  results.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return results;
}

/**
 * Rust worker kaynağının deterministik SHA-256 parmak izini hesaplar:
 * Cargo.toml + Cargo.lock + sıralı src/**\/*.rs. Manifest yoksa null döner.
 */
export function computeRustWorkerSourceFingerprint(
  manifestPath: string,
): string | null {
  const cargoToml = readRegularFileBytesNoFollow(manifestPath);
  if (cargoToml === null) {
    return null;
  }
  const workerRoot = dirname(manifestPath);
  const hash = createHash("sha256");
  hash.update("Cargo.toml\0");
  hash.update(String(cargoToml.length));
  hash.update("\0");
  hash.update(cargoToml);

  const cargoLock = readRegularFileBytesNoFollow(join(workerRoot, "Cargo.lock"));
  if (cargoLock !== null) {
    hash.update("Cargo.lock\0");
    hash.update(String(cargoLock.length));
    hash.update("\0");
    hash.update(cargoLock);
  } else {
    hash.update("Cargo.lock:absent\0");
  }

  const srcDir = join(workerRoot, "src");
  for (const relPosix of collectSortedRsFiles(srcDir)) {
    const rsBytes = readRegularFileBytesNoFollow(
      join(srcDir, ...relPosix.split("/")),
    );
    if (rsBytes === null) {
      return null;
    }
    hash.update(`src/${relPosix}\0`);
    hash.update(String(rsBytes.length));
    hash.update("\0");
    hash.update(rsBytes);
  }

  return hash.digest("hex");
}

/** Bütünlük yan-dosyasını (<binaryPath>.sha256.json) atomik yazar. */
export function writeRustWorkerIntegrityMetadata(
  binaryPath: string,
  record: RustWorkerIntegrityRecord,
): void {
  const metaPath = rustWorkerIntegrityPath(binaryPath);
  const tmpPath = `${metaPath}.tmp.${String(process.pid)}.${randomBytes(6).toString("hex")}`;
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  let fd: number | null = null;
  try {
    fd = openSync(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    writeFileSync(fd, payload, "utf8");
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, metaPath);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // ignore
    }
    throw error;
  }
}

/**
 * Önbellekteki binary'yi çalıştırmadan önce doğrular:
 * 1) lstatSync düzenli dosya kontrolü (symlink reddi),
 * 2) O_NOFOLLOW binary SHA-256 hesabı,
 * 3) <binaryPath>.sha256.json regular-file + O_NOFOLLOW okuması,
 * 4) sourceFingerprint VE binarySha256 birebir eşleşmesi.
 */
export function verifyRustWorkerBinaryIntegrity(
  binaryPath: string,
  expectedSourceFingerprint: string | null,
): { readonly valid: boolean; readonly reason: string } {
  if (expectedSourceFingerprint === null) {
    return {
      valid: false,
      reason: "sourceFingerprint hesaplanamadı (Cargo.toml eksik veya okunamadı)",
    };
  }
  const st = lstatOrNull(binaryPath);
  if (st === null) {
    return { valid: false, reason: "worker binary mevcut değil" };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return {
      valid: false,
      reason: "worker binary symlink veya düzenli dosya değil (reddedildi)",
    };
  }
  const actualBinarySha256 = readRegularFileSha256NoFollow(binaryPath);
  if (actualBinarySha256 === null) {
    return {
      valid: false,
      reason: "worker binary O_NOFOLLOW ile doğrulanamadı",
    };
  }
  const metaPath = rustWorkerIntegrityPath(binaryPath);
  const metaRaw = readRegularFileBytesNoFollow(
    metaPath,
    INTEGRITY_META_MAX_BYTES,
  );
  if (metaRaw === null) {
    return {
      valid: false,
      reason: "bütünlük yan-dosyası (.sha256.json) eksik veya düzenli dosya değil",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(metaRaw.toString("utf8"));
  } catch {
    return {
      valid: false,
      reason: "bütünlük yan-dosyası (.sha256.json) geçerli JSON değil",
    };
  }
  if (!isRecord(parsed)) {
    return {
      valid: false,
      reason: "bütünlük yan-dosyası (.sha256.json) geçersiz şema",
    };
  }
  const recordedSource = parsed["sourceFingerprint"];
  const recordedBinary = parsed["binarySha256"];
  if (
    typeof recordedSource !== "string" ||
    !HEX_SHA256_RE.test(recordedSource) ||
    typeof recordedBinary !== "string" ||
    !HEX_SHA256_RE.test(recordedBinary)
  ) {
    return {
      valid: false,
      reason: "bütünlük yan-dosyası geçersiz SHA-256 alanı içeriyor",
    };
  }
  if (recordedSource !== expectedSourceFingerprint) {
    return {
      valid: false,
      reason: "sourceFingerprint uyuşmuyor (worker kaynağı değişmiş)",
    };
  }
  if (recordedBinary !== actualBinarySha256) {
    return {
      valid: false,
      reason: "binarySha256 uyuşmuyor (kurcalanmış veya bozuk binary)",
    };
  }
  return { valid: true, reason: "" };
}

interface WorkerBinaryProbe {
  readonly available: boolean;
  readonly workerDir: string;
  readonly detail: string;
}

/**
 * Worker binary'sini sağlar ve önbellekteki binary için yürütme öncesi
 * SHA-256 + sourceFingerprint + symlink-reddi bütünlük doğrulaması yapar.
 * Uyuşmazlık/kurcalanma durumunda temiz yeniden derleme yapılır (autoBuild=false
 * ise güvenli reddedilir ve L0/L1'e düşülür).
 */
async function ensureWorkerBinary(
  options: ResolvedRuntimeOptions,
): Promise<WorkerBinaryProbe> {
  const manifestPath = defaultWorkerManifestPath();

  if (options.hasExplicitWorkerDir) {
    const binaryPath = join(options.workerDir, options.workerBinaryName);
    const st = lstatOrNull(binaryPath);
    if (st !== null) {
      if (st.isSymbolicLink() || !st.isFile()) {
        return {
          available: false,
          workerDir: options.workerDir,
          detail: `worker binary symlink veya düzenli dosya değil (reddedildi): ${binaryPath}`,
        };
      }
      return { available: true, workerDir: options.workerDir, detail: "" };
    }

    if (options.hasSpawnInjection) {
      // Test enjeksiyonu: build yok — sahte süreç senaryosu doğrudan koşar.
      return { available: true, workerDir: options.workerDir, detail: "" };
    }

    if (!options.autoBuild) {
      return {
        available: false,
        workerDir: options.workerDir,
        detail: `Rust worker binary bulunamadı ve autoBuild kapalı: ${binaryPath}`,
      };
    }

    if (!isCargoAvailable(manifestPath)) {
      return {
        available: false,
        workerDir: options.workerDir,
        detail:
          "cargo bulunamadı (PATH ve cargo-home öneklemesi) — Rust worker binary'si yok ve derlenemedi",
      };
    }

    const build = await runCargoBuild({
      manifestPath,
      timeoutMs: options.cargoBuildTimeoutMs,
    });
    if (build.status !== 0) {
      const tail =
        build.spawnError ||
        build.stderr.trim().slice(-300) ||
        build.stdout.trim().slice(-300) ||
        "(çıktı boş)";
      return {
        available: false,
        workerDir: options.workerDir,
        detail: `cargo build başarısız (exit=${String(build.status ?? "bilinmiyor")}): ${tail}`,
      };
    }
    const builtStat = lstatOrNull(binaryPath);
    if (builtStat === null || builtStat.isSymbolicLink() || !builtStat.isFile()) {
      // Dürüst ayrım: derleme BAŞARILI ama binary override edilen dizinde
      // değil — "build başarısız" DEMEYİZ; gerçek sebep bildirilir.
      return {
        available: false,
        workerDir: options.workerDir,
        detail: `cargo build başarılı ama worker binary'si beklenen konumda yok: ${binaryPath} (workerDir override'ını kontrol edin)`,
      };
    }
    return { available: true, workerDir: options.workerDir, detail: "" };
  }

  // hasExplicitWorkerDir === false:
  // 1) Önce asset kökü içindeki <assetRoot>/native/rust-worker/target/debug/<bin> aranır.
  const assetBinaryPath = join(options.workerDir, options.workerBinaryName);
  const assetStat = lstatOrNull(assetBinaryPath);
  if (assetStat !== null) {
    if (assetStat.isSymbolicLink() || !assetStat.isFile()) {
      return {
        available: false,
        workerDir: options.workerDir,
        detail: `asset Rust worker binary symlink veya düzenli dosya değil (reddedildi): ${assetBinaryPath}`,
      };
    }
    return { available: true, workerDir: options.workerDir, detail: "" };
  }

  // 2) Yoksa yazılabilir önbellekteki <cacheTargetDir>/debug/<bin> bütünlük doğrulamasıyla kontrol edilir.
  const cacheTargetDir = defaultWritableRustTargetDir();
  const cacheWorkerDir = join(cacheTargetDir, "debug");
  const cacheBinaryPath = join(cacheWorkerDir, options.workerBinaryName);
  const sourceFingerprint = computeRustWorkerSourceFingerprint(manifestPath);
  const cacheStat = lstatOrNull(cacheBinaryPath);

  if (cacheStat !== null) {
    const verification = verifyRustWorkerBinaryIntegrity(
      cacheBinaryPath,
      sourceFingerprint,
    );
    if (verification.valid) {
      return { available: true, workerDir: cacheWorkerDir, detail: "" };
    }
    console.error(
      `[rust-adapter] önbellekteki Rust worker binary bütünlük doğrulamasından geçemedi (${verification.reason}): ${cacheBinaryPath}`,
    );
    if (!options.autoBuild || options.hasSpawnInjection) {
      return {
        available: false,
        workerDir: cacheWorkerDir,
        detail: `önbellekteki Rust worker binary bütünlük doğrulamasından geçemedi (${verification.reason})`,
      };
    }
    // Temiz yeniden derleme öncesi kurcalanmış/symlink/bayat binary ve yan-dosya kaldırılır.
    try {
      rmSync(cacheBinaryPath, { force: true });
      rmSync(rustWorkerIntegrityPath(cacheBinaryPath), { force: true });
    } catch {
      return {
        available: false,
        workerDir: cacheWorkerDir,
        detail: `önbellekteki bozuk Rust worker binary temizlenemedi: ${cacheBinaryPath}`,
      };
    }
  } else {
    if (options.hasSpawnInjection) {
      return { available: true, workerDir: cacheWorkerDir, detail: "" };
    }
    if (!options.autoBuild) {
      return {
        available: false,
        workerDir: cacheWorkerDir,
        detail: `Rust worker binary bulunamadı ve autoBuild kapalı: ${cacheBinaryPath}`,
      };
    }
  }

  // 3) İkisi de yoksa (veya önbellek doğrulaması başarısız olup temizlendiyse)
  //    cargo build yazılabilir CARGO_TARGET_DIR içine çalıştırılır ve .sha256.json yazılır.
  if (sourceFingerprint === null) {
    return {
      available: false,
      workerDir: cacheWorkerDir,
      detail: `Rust worker manifest kaynağı bulunamadı: ${manifestPath}`,
    };
  }
  if (!isCargoAvailable(manifestPath)) {
    return {
      available: false,
      workerDir: cacheWorkerDir,
      detail:
        "cargo bulunamadı (PATH ve cargo-home öneklemesi) — Rust worker binary'si yok ve derlenemedi",
    };
  }

  const build = await runCargoBuild({
    manifestPath,
    timeoutMs: options.cargoBuildTimeoutMs,
    targetDir: cacheTargetDir,
  });
  if (build.status !== 0) {
    const tail =
      build.spawnError ||
      build.stderr.trim().slice(-300) ||
      build.stdout.trim().slice(-300) ||
      "(çıktı boş)";
    return {
      available: false,
      workerDir: cacheWorkerDir,
      detail: `cargo build başarısız (exit=${String(build.status ?? "bilinmiyor")}): ${tail}`,
    };
  }
  const binarySha256 = readRegularFileSha256NoFollow(cacheBinaryPath);
  if (binarySha256 === null) {
    return {
      available: false,
      workerDir: cacheWorkerDir,
      detail: `cargo build başarılı ama worker binary'si doğrulanamadı (eksik veya düzenli dosya değil): ${cacheBinaryPath}`,
    };
  }
  try {
    writeRustWorkerIntegrityMetadata(cacheBinaryPath, {
      sourceFingerprint,
      binarySha256,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      workerDir: cacheWorkerDir,
      detail: `worker binary bütünlük kaydı (.sha256.json) yazılamadı: ${detail}`,
    };
  }
  const postBuildCheck = verifyRustWorkerBinaryIntegrity(
    cacheBinaryPath,
    sourceFingerprint,
  );
  if (!postBuildCheck.valid) {
    return {
      available: false,
      workerDir: cacheWorkerDir,
      detail: `yeni derlenen Rust worker binary doğrulaması başarısız: ${postBuildCheck.reason}`,
    };
  }
  return { available: true, workerDir: cacheWorkerDir, detail: "" };
}

/* ------------------------------------------------------------------ */
/* Worker yanıt mapping (defansif + katalog doğrulaması)               */
/* ------------------------------------------------------------------ */

interface MappedWorkerResponse {
  readonly state: "ready" | "partial";
  readonly coverageRatio: number;
  readonly capabilities: RustAdapterCapabilities;
  readonly unsupportedConstructs: readonly string[];
  readonly workerWarnings: readonly string[];
  readonly diagnostics: readonly RustAdapterDiagnostic[];
  readonly nodes: readonly SnapshotNodeInput[];
  readonly edges: readonly SnapshotEdgeInput[];
  readonly evidence: readonly SnapshotEvidenceInput[];
}

function mapSpan(raw: unknown): SourceSpan | null {
  if (!isRecord(raw)) return null;
  const { relativePath, startLine, endLine, sourceHash } = raw;
  if (
    typeof relativePath !== "string" ||
    typeof startLine !== "number" ||
    typeof endLine !== "number" ||
    typeof sourceHash !== "string"
  ) {
    return null;
  }

  return { relativePath, startLine, endLine, sourceHash };
}

function mapEvidence(raw: unknown): SnapshotEvidenceInput | null {
  if (!isRecord(raw)) return null;
  const kind = raw["kind"];
  const analyzerId = raw["analyzerId"];
  const analyzerVersion = raw["analyzerVersion"];
  const rationale = raw["rationale"];
  if (
    typeof kind !== "string" ||
    typeof analyzerId !== "string" ||
    typeof analyzerVersion !== "string" ||
    typeof rationale !== "string"
  ) {
    return null;
  }

  const span = mapSpan(raw["span"]);
  return {
    kind,
    ...(span !== null ? { span } : {}),
    analyzerId,
    analyzerVersion,
    rationale,
  };
}

function mapNodeRef(raw: unknown): NodeRef | null {
  if (!isRecord(raw)) return null;
  const kind = raw["kind"];
  const qualifiedName = raw["qualifiedName"];
  const relativePath = raw["relativePath"];
  if (
    typeof kind !== "string" ||
    !NODE_KIND_SET.has(kind) ||
    typeof qualifiedName !== "string" ||
    qualifiedName.trim().length === 0
  ) {
    return null;
  }

  return {
    kind: kind as NodeKind,
    qualifiedName,
    ...(typeof relativePath === "string" ? { relativePath } : {}),
  };
}

function mapAmbiguity(raw: unknown): { candidates: string[]; reason: string } | null {
  if (!isRecord(raw)) return null;
  const candidates = raw["candidates"];
  const reason = raw["reason"];
  if (
    !Array.isArray(candidates) ||
    !candidates.every((candidate) => typeof candidate === "string") ||
    typeof reason !== "string"
  ) {
    return null;
  }

  return { candidates: [...candidates], reason };
}

function mapNode(raw: unknown, skipped: string[]): SnapshotNodeInput | null {
  if (!isRecord(raw)) return null;
  const kind = raw["kind"];
  const qualifiedName = raw["qualifiedName"];
  if (typeof qualifiedName !== "string" || qualifiedName.trim().length === 0) {
    return null;
  }

  if (typeof kind !== "string" || !NODE_KIND_SET.has(kind)) {
    skipped.push(`katalog dışı node türü atlandı: ${String(kind)}`);
    return null;
  }

  const language = raw["language"];
  const relativePath = raw["relativePath"];
  const attributes = raw["attributes"];
  return {
    kind: kind as NodeKind,
    qualifiedName,
    ...(typeof language === "string" ? { language } : {}),
    ...(typeof relativePath === "string" ? { relativePath } : {}),
    attributes: isRecord(attributes) ? { ...attributes } : {},
  };
}

function mapEdge(raw: unknown, skipped: string[]): SnapshotEdgeInput | null {
  if (!isRecord(raw)) return null;
  const kind = raw["kind"];
  const resolution = raw["resolution"];
  if (typeof kind !== "string" || !EDGE_KIND_SET.has(kind)) {
    skipped.push(`katalog dışı edge türü atlandı: ${String(kind)}`);
    return null;
  }

  if (typeof resolution !== "string" || !RESOLUTION_SET.has(resolution)) {
    skipped.push(`geçersiz resolution değeri olan kenar atlandı: ${String(resolution)}`);
    return null;
  }

  const from = mapNodeRef(raw["from"]);
  const to = mapNodeRef(raw["to"]);
  if (from === null || to === null) {
    skipped.push("geçersiz kenar ucu atlandı");
    return null;
  }

  const evidenceRaw = Array.isArray(raw["evidence"]) ? raw["evidence"] : [];
  const evidence = evidenceRaw
    .map((item) => mapEvidence(item))
    .filter((item): item is SnapshotEvidenceInput => item !== null);

  const ambiguity = mapAmbiguity(raw["ambiguity"]);
  return {
    kind: kind as EdgeKind,
    from,
    to,
    resolution: resolution as Resolution,
    evidence,
    ...(ambiguity !== null ? { ambiguity } : {}),
  };
}

function mapDiagnostics(raw: unknown): RustAdapterDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  const diagnostics: RustAdapterDiagnostic[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const { relativePath, code, message, line } = item;
    if (
      typeof relativePath !== "string" ||
      typeof code !== "string" ||
      typeof message !== "string" ||
      typeof line !== "number"
    ) {
      continue;
    }

    diagnostics.push({ relativePath, code, message, line });
  }

  return diagnostics;
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : [];
}

/** TŞ §7 capabilities karşılığı — bozuk/eksikse defansif "unknown" kümesi. */
function mapCapabilities(raw: unknown): RustAdapterCapabilities {
  if (!isRecord(raw)) {
    return { ...WORKER_UNAVAILABLE_CAPABILITIES, routeDetection: "unknown" };
  }

  const isTrue = (value: unknown): boolean => value === true;
  const routeDetection = raw["routeDetection"];
  return {
    astParse: isTrue(raw["astParse"]),
    symbolResolution: isTrue(raw["symbolResolution"]),
    containsEdges: isTrue(raw["containsEdges"]),
    callEdges: isTrue(raw["callEdges"]),
    importEdges: isTrue(raw["importEdges"]),
    routeDetection:
      typeof routeDetection === "string" ? routeDetection : "unknown",
    frameworkLinkers: isTrue(raw["frameworkLinkers"]),
  };
}

/** Worker yanıtını doğrular ve domain girdi sözleşmesine map eder; bozuksa null. */
function mapWorkerResponse(
  payload: unknown,
  expectedId: string,
  skipped: string[],
): MappedWorkerResponse | null {
  if (!isRecord(payload)) return null;
  if (payload["id"] !== expectedId) {
    skipped.push("worker yanıtı id echo eşleşmedi");
    return null;
  }

  const status = payload["status"];

  // csharp-roslyn bulgusu düzeltmesiyle aynı: worker'ın PROTOCOL.md v1
  // hata yanıtı (status:"error" — LIMIT_EXCEEDED vb.) genel "sözleşmeye
  // aykırı" kovasına karışmamalı; hata kodu + mesaj kullanıcı aksiyonuyla
  // birlikte warnings'e taşınır ve L0/L1'e düşülür (davranış değişmez,
  // sebep korunur).
  if (status === "error") {
    const error = isRecord(payload["error"]) ? payload["error"] : null;
    const code =
      error !== null && typeof error["code"] === "string"
        ? error["code"]
        : "bilinmeyen";
    const message =
      error !== null && typeof error["message"] === "string"
        ? error["message"]
        : "";
    skipped.push(
      `worker hatası ${code}${message.length > 0 ? `: ${message}` : ""} — istek kaynak sınırlarını (dosya boyutu/sayısı) kontrol edin`,
    );
    return null;
  }

  if (status !== "ready" && status !== "partial") return null;
  if (!Array.isArray(payload["nodes"])) return null;
  if (!Array.isArray(payload["edges"])) return null;

  const nodes = payload["nodes"]
    .map((node) => mapNode(node, skipped))
    .filter((node): node is SnapshotNodeInput => node !== null);
  const edges = payload["edges"]
    .map((edge) => mapEdge(edge, skipped))
    .filter((edge): edge is SnapshotEdgeInput => edge !== null);
  const evidence = Array.isArray(payload["evidence"])
    ? payload["evidence"]
        .map((item) => mapEvidence(item))
        .filter((item): item is SnapshotEvidenceInput => item !== null)
    : [];

  const coverageRatio = payload["coverageRatio"];
  const safeCoverage =
    typeof coverageRatio === "number" && Number.isFinite(coverageRatio)
      ? coverageRatio
      : 0;

  return {
    state: status,
    coverageRatio: safeCoverage,
    capabilities: mapCapabilities(payload["capabilities"]),
    unsupportedConstructs: stringList(payload["unsupportedConstructs"]),
    workerWarnings: stringList(payload["warnings"]),
    diagnostics: mapDiagnostics(payload["diagnostics"]),
    nodes,
    edges,
    evidence,
  };
}

/* ------------------------------------------------------------------ */
/* L0/L1 fallback (TŞ §7: yalnızca kanıtlanabilen bilgi sunulur)        */
/* ------------------------------------------------------------------ */

function fallbackResult(
  entries: ReadonlyArray<{
    readonly relativePath: string;
    readonly content: string;
    readonly sourceHash: string;
  }>,
  reason: string,
  stderr: string,
  skipped: string[],
): RustAdapterResult {
  const warningLines = [
    `${reason} — L0/L1 dosya düzeyine düşüldü`,
    ...(stderr.trim().length > 0
      ? [`worker stderr: ${stderr.trim().slice(0, 200)}`]
      : []),
    ...skipped,
  ];
  // Açık warning ayrıca stderr'e loglanır (MCP stdout temizlik kuralı).
  console.error(`[rust-adapter] ${warningLines[0] ?? reason}`);

  return {
    analyzerId: RUST_ADAPTER_ID,
    analyzerVersion: RUST_ADAPTER_VERSION,
    workerAvailable: false,
    state: "partial",
    coverageRatio: 0,
    capabilities: WORKER_UNAVAILABLE_CAPABILITIES,
    unsupportedConstructs: [],
    warnings: warningLines,
    diagnostics: [],
    nodes: entries.map((entry) => ({
      kind: "File",
      qualifiedName: entry.relativePath,
      language: "rust",
      relativePath: entry.relativePath,
      attributes: { sourceHash: entry.sourceHash },
    })),
    edges: [],
    evidence: [],
  };
}

/* ------------------------------------------------------------------ */
/* Ana giriş                                                           */
/* ------------------------------------------------------------------ */

export async function analyzeRustWorkspace(
  input: Omit<AnalyzeRustWorkspaceInput, "options"> & {
    readonly options?: AnalyzeRustWorkspaceOptions;
  },
): Promise<RustAdapterResult> {
  const { workspaceId, files } = input;
  if (workspaceId.trim().length === 0) {
    throw new DomainError("adapter/empty-workspace-id", "workspaceId boş olamaz");
  }

  // 1) Girdi normalizasyonu (sıralı, çakışmasız — deterministik istek).
  const seen = new Set<string>();
  const entries: Array<{
    relativePath: string;
    content: string;
    sourceHash: string;
  }> = [];
  for (const file of files) {
    const relativePath = normalizeRelativePath(file.path);
    if (seen.has(relativePath)) {
      throw new DomainError(
        "adapter/duplicate-source-path",
        `Aynı kaynak yolu iki kez verildi: ${relativePath}`,
      );
    }

    seen.add(relativePath);
    entries.push({
      relativePath,
      content: file.content,
      sourceHash: sha256Hex(utf8Encode(file.content)),
    });
  }

  entries.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );

  const options = resolveOptions(input.options);

  // 2) Worker binary sağlama (yoksa LİTERAL "cargo" ile derleme; olmazsa
  //    fallback detayı warnings'e aynen taşınır).
  const binaryProbe = await ensureWorkerBinary(options);
  if (!binaryProbe.available) {
    return fallbackResult(entries, binaryProbe.detail, "", []);
  }

  const request = {
    id: `analyze:${workspaceId}`,
    type: "analyze",
    protocolVersion: "1",
    files: entries.map((entry) => ({
      path: entry.relativePath,
      content: entry.content,
    })),
  };

  const outcome: WorkerRunOutcome = await runWorkerAnalyze({
    workerDir: binaryProbe.workerDir,
    workerBinaryName: options.workerBinaryName,
    requestPayload: request,
    requestTimeoutMs: options.requestTimeoutMs,
    responseMaxChars: options.responseMaxChars,
    ...(input.options?.spawnProcess !== undefined
      ? { spawnProcess: input.options.spawnProcess }
      : {}),
  });

  const skipped: string[] = [];
  if (outcome.status === "ok") {
    const mapped = mapWorkerResponse(outcome.response, request.id, skipped);
    if (mapped !== null) {
      return {
        analyzerId: RUST_ADAPTER_ID,
        analyzerVersion: RUST_ADAPTER_VERSION,
        workerAvailable: true,
        state: mapped.state,
        coverageRatio: mapped.coverageRatio,
        capabilities: mapped.capabilities,
        unsupportedConstructs: mapped.unsupportedConstructs,
        warnings: [...mapped.workerWarnings, ...skipped],
        diagnostics: mapped.diagnostics,
        nodes: mapped.nodes,
        edges: mapped.edges,
        evidence: mapped.evidence,
      };
    }
  }

  // 3) Graceful fallback — motor çökmez; L0/L1 + explicit warning.
  //    csharp-roslyn bulgusu 9 ile aynı: worker'ın PROTOCOL.md §4'e UYGUN
  //    status:"error" yanıtı (LIMIT_EXCEEDED vb.) "sözleşmeye aykırı"
  //    DEĞİLDİR — istek reddidir; gerekçe metni bunu dürüstçe ayırt eder.
  const isWorkerRejection =
    outcome.status === "ok" &&
    skipped.some((line) => line.startsWith("worker hatası"));
  const reason =
    outcome.status === "ok"
      ? isWorkerRejection
        ? 'Rust worker isteği reddetti (worker status:"error"); ayrıntı warnings\'te'
        : "Rust worker kullanılamıyor (yanıt sözleşmeye aykırı)"
      : `Rust worker kullanılamıyor (${outcome.detail})`;
  return fallbackResult(entries, reason, outcome.stderr, skipped);
}
