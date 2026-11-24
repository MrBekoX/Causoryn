/**
 * analyzeCSharpWorkspace — Roslyn worker sürecini yöneten TS adapter
 * çekirdeği (TŞ v2.1 §7, §7.1; sprint-2 / B2).
 *
 * Çıkarım disiplini:
 * - Worker SAĞLIKLI yanıt verdiyse: B1 protokol çıktısı (PROTOCOL.md v1)
 *   katalog doğrulamasından (TŞ §8 27-node / 20-edge / 3-resolution setleri)
 *   geçtikten sonra domain createSnapshot GİRDİ sözleşmesine map edilir —
 *   adapter ID ÜRETMEZ, uydurma kenar eklemez; TŞ §7.1 gereği canonical ID /
 *   de-duplication merkezi normalizer'dadır.
 * - Worker kullanılamadıysa (başlatılamama/çökme/timeout/bozuk yanıt):
 *   motor ÇÖKMEZ — L0/L1 dosya düzeyine düşülür: File node'ları (sourceHash
 *   kanıtlı) korunur, sembol/kenar üretilmez, state=partial + coverage=0 +
 *   explicit warning (stderr'e de loglanır). TŞ §7: "Parser başarısızsa
 *   yalnızca kanıtlanabilen L0/L1 bilgisi sunulur."
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
import { resolveCausorynAssetRoot } from "@causoryn/sidecar-ipc";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, posix as pathPosix, resolve, sep } from "node:path";
import { runWorkerAnalyze, type WorkerRunOutcome } from "./worker-process.js";
import {
  CSHARP_ROSLYN_ADAPTER_ID,
  CSHARP_ROSLYN_ADAPTER_VERSION,
  DEFAULT_DOTNET_COMMAND,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RESPONSE_MAX_CHARS,
  MAX_NUGET_REFERENCE_DIRS,
  MAX_PROJECT_ASSETS_BYTES,
  WORKER_DLL_RELATIVE_PATH,
  WORKER_UNAVAILABLE_CAPABILITIES,
  type AnalyzeCSharpWorkspaceInput,
  type NugetReferenceDiscoveryResult,
  type RoslynAdapterCapabilities,
  type RoslynAdapterDiagnostic,
  type RoslynAdapterOptions,
  type RoslynAdapterResult,
} from "./types.js";

/**
 * Varsayılan worker DLL yolu: dinamik asset kökü + paketlenmiş düz DLL ya da
 * B1 build çıktısı. Config kuralı: CAUSORYN_ROSLYN_WORKER_DLL ortam
 * değişkeniyle ya da analyze seçenekleriyle override edilebilir; komut
 * satırına kullanıcı girdisi HİÇbir yolla interpole edilmez (kırmızı çizgi 6).
 */
function defaultWorkerDllPath(): string
{
  const override = process.env["CAUSORYN_ROSLYN_WORKER_DLL"];
  if (override !== undefined && override.trim().length > 0)
  {
    return override;
  }

  const assetRoot = resolveCausorynAssetRoot(import.meta.url);
  const flatDllPath = join(
    assetRoot,
    "native",
    "roslyn-worker",
    "Causoryn.RoslynWorker.dll",
  );
  if (existsSync(flatDllPath))
  {
    return flatDllPath;
  }

  const releaseDllPath = join(
    assetRoot,
    "native",
    "roslyn-worker",
    "bin",
    "Release",
    "net10.0",
    "Causoryn.RoslynWorker.dll",
  );
  if (existsSync(releaseDllPath))
  {
    return releaseDllPath;
  }

  return join(assetRoot, WORKER_DLL_RELATIVE_PATH);
}

function resolveOptions(partial?: Partial<RoslynAdapterOptions>): RoslynAdapterOptions
{
  return {
    workerDllPath: partial?.workerDllPath ?? defaultWorkerDllPath(),
    dotnetCommand: partial?.dotnetCommand ?? DEFAULT_DOTNET_COMMAND,
    requestTimeoutMs: partial?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    responseMaxChars: partial?.responseMaxChars ?? DEFAULT_RESPONSE_MAX_CHARS,
    ...(partial?.spawnProcess !== undefined ? { spawnProcess: partial.spawnProcess } : {}),
  };
}

/** TS adapter yol normalizasyonu — aynı reddiyeler, aynı hata kodları. */
function normalizeRelativePath(raw: string): string
{
  const posix = raw.replace(/\\/g, "/");
  if (posix.startsWith("/") || /^[a-zA-Z]:/.test(posix))
  {
    throw new DomainError(
      "adapter/absolute-source-path",
      `Mutlak kaynak yolu kabul edilmez: ${raw}`,
    );
  }

  for (const segment of posix.split("/"))
  {
    if (segment.length === 0 || segment === ".")
    {
      throw new DomainError(
        "adapter/invalid-source-path",
        `Kaynak yolu boş/geçersiz segment içeriyor: ${raw}`,
      );
    }

    if (segment === "..")
    {
      throw new DomainError(
        "adapter/source-path-escape",
        `Kaynak yolu kök dışına çıkıyor: ${raw}`,
      );
    }
  }

  return posix;
}

function isRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* Worker yanıt mapping (defansif + katalog doğrulaması)               */
/* ------------------------------------------------------------------ */

interface MappedWorkerResponse {
  readonly state: "ready" | "partial";
  readonly coverageRatio: number;
  readonly capabilities: RoslynAdapterCapabilities;
  readonly unsupportedConstructs: readonly string[];
  readonly workerWarnings: readonly string[];
  readonly diagnostics: readonly RoslynAdapterDiagnostic[];
  readonly nodes: readonly SnapshotNodeInput[];
  readonly edges: readonly SnapshotEdgeInput[];
  readonly evidence: readonly SnapshotEvidenceInput[];
}

function mapSpan(raw: unknown): SourceSpan | null
{
  if (!isRecord(raw)) return null;
  const { relativePath, startLine, endLine, sourceHash } = raw;
  if (
    typeof relativePath !== "string" ||
    typeof startLine !== "number" ||
    typeof endLine !== "number" ||
    typeof sourceHash !== "string"
  )
  {
    return null;
  }

  return { relativePath, startLine, endLine, sourceHash };
}

function mapEvidence(raw: unknown): SnapshotEvidenceInput | null
{
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
  )
  {
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

function mapNodeRef(raw: unknown): NodeRef | null
{
  if (!isRecord(raw)) return null;
  const kind = raw["kind"];
  const qualifiedName = raw["qualifiedName"];
  const relativePath = raw["relativePath"];
  if (
    typeof kind !== "string" ||
    !NODE_KIND_SET.has(kind) ||
    typeof qualifiedName !== "string" ||
    qualifiedName.trim().length === 0
  )
  {
    return null;
  }

  return {
    kind: kind as NodeKind,
    qualifiedName,
    ...(typeof relativePath === "string" ? { relativePath } : {}),
  };
}

function mapAmbiguity(raw: unknown): { candidates: string[]; reason: string } | null
{
  if (!isRecord(raw)) return null;
  const candidates = raw["candidates"];
  const reason = raw["reason"];
  if (
    !Array.isArray(candidates) ||
    !candidates.every((candidate) => typeof candidate === "string") ||
    typeof reason !== "string"
  )
  {
    return null;
  }

  return { candidates: [...candidates], reason };
}

function mapNode(raw: unknown, skipped: string[]): SnapshotNodeInput | null
{
  if (!isRecord(raw)) return null;
  const kind = raw["kind"];
  const qualifiedName = raw["qualifiedName"];
  if (typeof qualifiedName !== "string" || qualifiedName.trim().length === 0)
  {
    return null;
  }

  if (typeof kind !== "string" || !NODE_KIND_SET.has(kind))
  {
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

function mapEdge(raw: unknown, skipped: string[]): SnapshotEdgeInput | null
{
  if (!isRecord(raw)) return null;
  const kind = raw["kind"];
  const resolution = raw["resolution"];
  if (typeof kind !== "string" || !EDGE_KIND_SET.has(kind))
  {
    skipped.push(`katalog dışı edge türü atlandı: ${String(kind)}`);
    return null;
  }

  if (typeof resolution !== "string" || !RESOLUTION_SET.has(resolution))
  {
    skipped.push(`geçersiz resolution değeri olan kenar atlandı: ${String(resolution)}`);
    return null;
  }

  const from = mapNodeRef(raw["from"]);
  const to = mapNodeRef(raw["to"]);
  if (from === null || to === null)
  {
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

function mapDiagnostics(raw: unknown): RoslynAdapterDiagnostic[]
{
  if (!Array.isArray(raw)) return [];
  const diagnostics: RoslynAdapterDiagnostic[] = [];
  for (const item of raw)
  {
    if (!isRecord(item)) continue;
    const { relativePath, code, message, line } = item;
    if (
      typeof relativePath !== "string" ||
      typeof code !== "string" ||
      typeof message !== "string" ||
      typeof line !== "number"
    )
    {
      continue;
    }

    diagnostics.push({ relativePath, code, message, line });
  }

  return diagnostics;
}

function stringList(raw: unknown): string[]
{
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : [];
}

/** TŞ §7 capabilities karşılığı — bozuk/eksikse defansif "unknown" kümesi. */
function mapCapabilities(raw: unknown): RoslynAdapterCapabilities
{
  if (!isRecord(raw))
  {
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
): MappedWorkerResponse | null
{
  if (!isRecord(payload)) return null;
  if (payload["id"] !== expectedId)
  {
    skipped.push("worker yanıtı id echo eşleşmedi");
    return null;
  }

  const status = payload["status"];

  // Denetim bulgusu düzeltmesi: worker'ın PROTOCOL.md v1 hata yanıtı
  // (status:"error" — LIMIT_EXCEEDED vb.) genel "sözleşmeye aykırı"
  // kovasına karışmamalı; hata kodu + mesaj kullanıcı aksiyonuyla birlikte
  // warnings'e taşınır ve L0/L1'e düşülür (davranış değişmez, sebep korunur).
  if (status === "error")
  {
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
  entries: ReadonlyArray<{ readonly relativePath: string; readonly content: string; readonly sourceHash: string }>,
  reason: string,
  stderr: string,
  skipped: string[],
): RoslynAdapterResult
{
  const warningLines = [
    `${reason} — L0/L1 dosya düzeyine düşüldü`,
    ...(stderr.trim().length > 0
      ? [`worker stderr: ${stderr.trim().slice(0, 200)}`]
      : []),
    ...skipped,
  ];
  // Açık warning ayrıca stderr'e loglanır (MCP stdout temizlik kuralı).
  console.error(`[csharp-roslyn-adapter] ${warningLines[0] ?? reason}`);

  return {
    analyzerId: CSHARP_ROSLYN_ADAPTER_ID,
    analyzerVersion: CSHARP_ROSLYN_ADAPTER_VERSION,
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
      language: "csharp",
      relativePath: entry.relativePath,
      attributes: { sourceHash: entry.sourceHash },
    })),
    edges: [],
    evidence: [],
  };
}

/* ------------------------------------------------------------------ */
/* Read-Only NuGet `obj/project.assets.json` Reference Discovery       */
/* ------------------------------------------------------------------ */

const MAX_ASSETS_SCAN_DEPTH = 4;
const MAX_ASSETS_FILES = 32;
const MAX_ASSETS_DIR_VISITS = 512;

const FORBIDDEN_JSON_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const ASSETS_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".vs",
  ".vscode",
  ".idea",
  "bin",
  "obj",
  "dist",
  "build",
  "out",
  "target",
]);

const UNC_OR_DEVICE_PREFIX = /^(?:\\\\|\/\/|\/\\|\\\/)/;

function isUncOrDevicePath(raw: string): boolean
{
  if (raw.length < 2) return false;
  return UNC_OR_DEVICE_PREFIX.test(raw);
}

function stripTrailingSeparators(p: string): string
{
  let end = p.length;
  while (end > 1 && (p.charCodeAt(end - 1) === 47 || p.charCodeAt(end - 1) === 92))
  {
    // Preserve Windows drive root (e.g. "C:\") and POSIX root ("/").
    if (end === 3 && p.charCodeAt(1) === 58) break;
    end -= 1;
  }
  return end === p.length ? p : p.slice(0, end);
}

function comparablePath(p: string): string
{
  const normalized = resolve(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInsideRealDir(realParent: string, realCandidate: string): boolean
{
  const parentCmp = comparablePath(realParent);
  const candidateCmp = comparablePath(realCandidate);
  const prefix = parentCmp.endsWith(sep) ? parentCmp : `${parentCmp}${sep}`;
  return candidateCmp === parentCmp || candidateCmp.startsWith(prefix);
}

function validateSafeRelativeSegments(rawPath: string): string[] | null
{
  if (rawPath.length === 0 || rawPath.includes("\0")) return null;
  const posixPath = rawPath.replace(/\\/g, "/");
  if (posixPath.startsWith("/") || /^[a-zA-Z]:/.test(posixPath)) return null;
  const segments = posixPath.split("/");
  for (const segment of segments)
  {
    if (segment.length === 0 || segment === "." || segment === "..")
    {
      return null;
    }
  }
  return segments;
}

function readBoundedFileNoFollow(filePath: string, realRoot: string): string | null
{
  let leafStat;
  try
  {
    leafStat = lstatSync(filePath);
  }
  catch
  {
    return null;
  }
  if (leafStat.isSymbolicLink() || !leafStat.isFile()) return null;
  if (leafStat.size > MAX_PROJECT_ASSETS_BYTES) return null;

  let realFile: string;
  try
  {
    realFile = realpathSync(filePath);
  }
  catch
  {
    return null;
  }
  if (!isInsideRealDir(realRoot, realFile)) return null;

  const flags =
    (fsConstants.O_RDONLY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
  let fd: number;
  try
  {
    fd = openSync(realFile, flags);
  }
  catch
  {
    return null;
  }

  try
  {
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile()) return null;
    if (fdStat.size > MAX_PROJECT_ASSETS_BYTES) return null;
    if (
      leafStat.ino !== 0 &&
      (fdStat.ino !== leafStat.ino || fdStat.dev !== leafStat.dev)
    )
    {
      return null;
    }

    const buffer = Buffer.allocUnsafe(Math.min(fdStat.size + 1, MAX_PROJECT_ASSETS_BYTES + 1));
    let totalRead = 0;
    while (totalRead < buffer.length)
    {
      const bytesRead = readSync(fd, buffer, totalRead, buffer.length - totalRead, null);
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
    }
    if (totalRead > MAX_PROJECT_ASSETS_BYTES) return null;
    return buffer.subarray(0, totalRead).toString("utf8");
  }
  catch
  {
    return null;
  }
  finally
  {
    try
    {
      closeSync(fd);
    }
    catch
    {
      // Ignore close error.
    }
  }
}

function scoreTargetFrameworkKey(tfmKey: string): readonly [number, number, number]
{
  const slashIdx = tfmKey.indexOf("/");
  const baseTfm = (slashIdx >= 0 ? tfmKey.slice(0, slashIdx) : tfmKey).toLowerCase();
  const ridPenalty = slashIdx >= 0 ? 0 : 1;

  const netMatch = /^net(\d+)\.(\d+)$/.exec(baseTfm);
  if (netMatch !== null)
  {
    return [3, Number(netMatch[1]) * 100 + Number(netMatch[2]), ridPenalty];
  }
  const netCoreMatch = /^netcoreapp(\d+)\.(\d+)$/.exec(baseTfm);
  if (netCoreMatch !== null)
  {
    return [2, Number(netCoreMatch[1]) * 100 + Number(netCoreMatch[2]), ridPenalty];
  }
  const netStdMatch = /^netstandard(\d+)\.(\d+)$/.exec(baseTfm);
  if (netStdMatch !== null)
  {
    return [1, Number(netStdMatch[1]) * 100 + Number(netStdMatch[2]), ridPenalty];
  }
  return [0, 0, ridPenalty];
}

function selectPreferredTargetKey(targetKeys: readonly string[]): string | undefined
{
  if (targetKeys.length === 0) return undefined;
  const sorted = [...targetKeys].sort((a, b) => {
    const scoreA = scoreTargetFrameworkKey(a);
    const scoreB = scoreTargetFrameworkKey(b);
    if (scoreB[0] !== scoreA[0]) return scoreB[0] - scoreA[0];
    if (scoreB[1] !== scoreA[1]) return scoreB[1] - scoreA[1];
    if (scoreB[2] !== scoreA[2]) return scoreB[2] - scoreA[2];
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return sorted[0];
}

function resolveNonSymlinkDirWithinBase(
  baseRealDir: string,
  segments: readonly string[],
): string | null
{
  let current = baseRealDir;
  for (const seg of segments)
  {
    current = join(current, seg);
    let stat;
    try
    {
      stat = lstatSync(current);
    }
    catch
    {
      return null;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  }

  let realTarget: string;
  try
  {
    realTarget = realpathSync(current);
  }
  catch
  {
    return null;
  }
  if (!isInsideRealDir(baseRealDir, realTarget)) return null;
  return realTarget;
}

function validateSafeLocalDirectory(rawDir: string): string | null
{
  if (rawDir.length === 0 || rawDir.includes("\0")) return null;
  const trimmed = rawDir.trim();
  if (trimmed.length === 0 || isUncOrDevicePath(trimmed) || !isAbsolute(trimmed))
  {
    return null;
  }
  const normalized = stripTrailingSeparators(trimmed);
  let stat;
  try
  {
    stat = lstatSync(normalized);
  }
  catch
  {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  try
  {
    const real = realpathSync(normalized);
    if (isUncOrDevicePath(real)) return null;
    return real;
  }
  catch
  {
    return null;
  }
}

function extractNugetDirsFromAssetsContent(
  content: string,
  discovered: Set<string>,
): void
{
  let parsed: unknown;
  try
  {
    parsed = JSON.parse(content);
  }
  catch
  {
    return;
  }
  if (!isRecord(parsed)) return;

  // 1) Validated local packageFolders (reject UNC/device paths, relative paths, and symlinks).
  const rawPackageFolders = parsed["packageFolders"];
  if (!isRecord(rawPackageFolders)) return;
  const packageFolders: string[] = [];
  for (const key of Object.getOwnPropertyNames(rawPackageFolders).sort())
  {
    if (FORBIDDEN_JSON_KEYS.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(rawPackageFolders, key)) continue;
    const realFolder = validateSafeLocalDirectory(key);
    if (realFolder !== null && !packageFolders.includes(realFolder))
    {
      packageFolders.push(realFolder);
    }
  }
  if (packageFolders.length === 0) return;

  // 2) Map library keys -> safe relative package paths.
  const libraryPathByKey = new Map<string, readonly string[]>();
  const rawLibraries = parsed["libraries"];
  if (isRecord(rawLibraries))
  {
    for (const key of Object.getOwnPropertyNames(rawLibraries))
    {
      if (FORBIDDEN_JSON_KEYS.has(key)) continue;
      if (!Object.prototype.hasOwnProperty.call(rawLibraries, key)) continue;
      const lib = rawLibraries[key];
      if (!isRecord(lib)) continue;
      if (lib["type"] !== undefined && lib["type"] !== "package") continue;
      const rawPath = lib["path"];
      if (typeof rawPath === "string")
      {
        const segments = validateSafeRelativeSegments(rawPath);
        if (segments !== null)
        {
          libraryPathByKey.set(key, segments);
        }
      }
    }
  }

  // 3) Extract compile-time DLL directories from the preferred TFM target.
  const rawTargets = parsed["targets"];
  if (!isRecord(rawTargets)) return;
  const targetKeys = Object.getOwnPropertyNames(rawTargets).filter(
    (key) => !FORBIDDEN_JSON_KEYS.has(key) && Object.prototype.hasOwnProperty.call(rawTargets, key),
  );
  const preferredTargetKey = selectPreferredTargetKey(targetKeys);
  if (preferredTargetKey === undefined) return;

  const targetPackages = rawTargets[preferredTargetKey];
  if (!isRecord(targetPackages)) return;

  const sortedPkgKeys = Object.getOwnPropertyNames(targetPackages)
    .filter((key) => !FORBIDDEN_JSON_KEYS.has(key) && Object.prototype.hasOwnProperty.call(targetPackages, key))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const pkgKey of sortedPkgKeys)
  {
    if (discovered.size >= MAX_NUGET_REFERENCE_DIRS) break;
    const pkgInfo = targetPackages[pkgKey];
    if (!isRecord(pkgInfo)) continue;
    if (pkgInfo["type"] !== undefined && pkgInfo["type"] !== "package") continue;

    const compileObj = pkgInfo["compile"];
    if (!isRecord(compileObj)) continue;

    const libSegments =
      libraryPathByKey.get(pkgKey) ??
      validateSafeRelativeSegments(pkgKey.toLowerCase());
    if (libSegments === null) continue;

    const compileEntries = Object.getOwnPropertyNames(compileObj)
      .filter((k) => !FORBIDDEN_JSON_KEYS.has(k) && Object.prototype.hasOwnProperty.call(compileObj, k))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    for (const compileKey of compileEntries)
    {
      if (discovered.size >= MAX_NUGET_REFERENCE_DIRS) break;
      if (!compileKey.toLowerCase().endsWith(".dll")) continue;
      const compileSegments = validateSafeRelativeSegments(compileKey);
      if (compileSegments === null || compileSegments.length === 0) continue;

      const dllFileName = compileSegments[compileSegments.length - 1]!;
      const compileDirPosix = pathPosix.dirname(compileSegments.join("/"));
      const compileDirSegments =
        compileDirPosix === "." ? [] : compileDirPosix.split("/");
      const fullDirSegments = [...libSegments, ...compileDirSegments];

      for (const pkgFolder of packageFolders)
      {
        const resolvedDir = resolveNonSymlinkDirWithinBase(pkgFolder, fullDirSegments);
        if (resolvedDir === null) continue;
        const dllPath = join(resolvedDir, dllFileName);
        let dllStat;
        try
        {
          dllStat = lstatSync(dllPath);
        }
        catch
        {
          continue;
        }
        if (dllStat.isSymbolicLink() || !dllStat.isFile()) continue;

        discovered.add(resolvedDir);
        break;
      }
    }
  }
}

/**
 * Strictly read-only, bounded, symlink- and UNC-safe discovery of local NuGet
 * compile-time DLL directories from `obj/project.assets.json` inside `rootDir`.
 * Degrades silently with zero crashes if absent, malformed, or oversized (> 8 MB).
 */
export function discoverNugetReferenceDirs(rootDir: string): NugetReferenceDiscoveryResult
{
  const warnings: string[] = [];
  if (rootDir.length === 0 || rootDir.includes("\0") || isUncOrDevicePath(rootDir) || !isAbsolute(rootDir))
  {
    return { referenceDirs: [], warnings };
  }

  const normalizedRoot = stripTrailingSeparators(rootDir);
  let rootStat;
  try
  {
    rootStat = lstatSync(normalizedRoot);
  }
  catch
  {
    return { referenceDirs: [], warnings };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
  {
    return { referenceDirs: [], warnings };
  }

  let realRoot: string;
  try
  {
    realRoot = realpathSync(normalizedRoot);
  }
  catch
  {
    return { referenceDirs: [], warnings };
  }
  if (isUncOrDevicePath(realRoot))
  {
    return { referenceDirs: [], warnings };
  }

  const assetsFiles: string[] = [];
  const queue: Array<{ readonly dir: string; readonly depth: number }> = [
    { dir: realRoot, depth: 0 },
  ];
  let visitedDirs = 0;

  while (
    queue.length > 0 &&
    visitedDirs < MAX_ASSETS_DIR_VISITS &&
    assetsFiles.length < MAX_ASSETS_FILES
  )
  {
    const current = queue.shift()!;
    visitedDirs += 1;

    // Check `<current>/obj/project.assets.json` strictly without following symlinks.
    const objDir = join(current.dir, "obj");
    try
    {
      const objStat = lstatSync(objDir);
      if (!objStat.isSymbolicLink() && objStat.isDirectory())
      {
        const realObj = realpathSync(objDir);
        if (isInsideRealDir(realRoot, realObj))
        {
          const assetsPath = join(realObj, "project.assets.json");
          if (existsSync(assetsPath))
          {
            assetsFiles.push(assetsPath);
          }
        }
      }
    }
    catch
    {
      // Absent obj/ directory — normal case, degrade silently.
    }

    if (current.depth >= MAX_ASSETS_SCAN_DEPTH) continue;

    let names: string[];
    try
    {
      names = readdirSync(current.dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    catch
    {
      continue;
    }

    for (const name of names)
    {
      if (name.length === 0 || name.startsWith(".") || ASSETS_SKIP_DIRS.has(name.toLowerCase()))
      {
        continue;
      }
      const childDir = join(current.dir, name);
      try
      {
        const childStat = lstatSync(childDir);
        if (childStat.isSymbolicLink() || !childStat.isDirectory()) continue;
        const realChild = realpathSync(childDir);
        if (!isInsideRealDir(realRoot, realChild)) continue;
        queue.push({ dir: realChild, depth: current.depth + 1 });
      }
      catch
      {
        continue;
      }
    }
  }

  const discovered = new Set<string>();
  for (const assetsPath of assetsFiles.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
  {
    if (discovered.size >= MAX_NUGET_REFERENCE_DIRS) break;
    const content = readBoundedFileNoFollow(assetsPath, realRoot);
    if (content === null) continue;
    extractNugetDirsFromAssetsContent(content, discovered);
  }

  const referenceDirs = [...discovered]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_NUGET_REFERENCE_DIRS);

  return { referenceDirs, warnings };
}

/* ------------------------------------------------------------------ */
/* Ana giriş                                                           */
/* ------------------------------------------------------------------ */

export async function analyzeCSharpWorkspace(
  input: AnalyzeCSharpWorkspaceInput,
): Promise<RoslynAdapterResult>
{
  const { workspaceId, files } = input;
  if (workspaceId.trim().length === 0)
  {
    throw new DomainError("adapter/empty-workspace-id", "workspaceId boş olamaz");
  }

  // 1) Girdi normalizasyonu (sıralı, çakışmasız — deterministik istek).
  const seen = new Set<string>();
  const entries: Array<{
    relativePath: string;
    content: string;
    sourceHash: string;
  }> = [];
  for (const file of files)
  {
    const relativePath = normalizeRelativePath(file.path);
    if (seen.has(relativePath))
    {
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

  // 1.5) Read-only NuGet `obj/project.assets.json` referenceDirs discovery (bounded, symlink/UNC-safe).
  const mergedRefDirs = new Set<string>();
  if (input.rootDir !== undefined)
  {
    const discovered = discoverNugetReferenceDirs(input.rootDir);
    for (const dir of discovered.referenceDirs)
    {
      mergedRefDirs.add(dir);
    }
  }
  if (input.referenceDirs !== undefined)
  {
    for (const rawDir of input.referenceDirs)
    {
      if (mergedRefDirs.size >= MAX_NUGET_REFERENCE_DIRS) break;
      const safeDir = validateSafeLocalDirectory(rawDir);
      if (safeDir !== null)
      {
        mergedRefDirs.add(safeDir);
      }
    }
  }
  const referenceDirs = [...mergedRefDirs]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_NUGET_REFERENCE_DIRS);

  const options = resolveOptions(input.options);
  const request = {
    id: `analyze:${workspaceId}`,
    type: "analyze",
    protocolVersion: "1",
    files: entries.map((entry) => ({
      path: entry.relativePath,
      content: entry.content,
    })),
    ...(referenceDirs.length > 0 ? { referenceDirs } : {}),
  };

  const outcome: WorkerRunOutcome = await runWorkerAnalyze({
    dotnetCommand: options.dotnetCommand,
    workerDllPath: options.workerDllPath,
    requestPayload: request,
    requestTimeoutMs: options.requestTimeoutMs,
    responseMaxChars: options.responseMaxChars,
    ...(options.spawnProcess !== undefined
      ? { spawnProcess: options.spawnProcess }
      : {}),
  });

  const skipped: string[] = [];
  if (outcome.status === "ok")
  {
    const mapped = mapWorkerResponse(outcome.response, request.id, skipped);
    if (mapped !== null)
    {
      return {
        analyzerId: CSHARP_ROSLYN_ADAPTER_ID,
        analyzerVersion: CSHARP_ROSLYN_ADAPTER_VERSION,
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

  // 2) Graceful fallback — motor çökmez; L0/L1 + explicit warning.
  // Denetim bulgusu 9: worker'ın PROTOCOL.md §4'e UYGUN status:"error"
  // yanıtı (LIMIT_EXCEEDED vb.) "sözleşmeye aykırı" DEĞİLDİR — istek
  // reddidir; gerekçe metni bunu dürüstçe ayırt eder (ayrıntı warnings'te).
  const isWorkerRejection =
    outcome.status === "ok" &&
    skipped.some((line) => line.startsWith("worker hatası"));
  const reason =
    outcome.status === "ok"
      ? isWorkerRejection
        ? 'Roslyn worker isteği reddetti (worker status:"error"); ayrıntı warnings\'te'
        : "Roslyn worker kullanılamıyor (yanıt sözleşmeye aykırı)"
      : `Roslyn worker kullanılamıyor (${outcome.detail})`;
  return fallbackResult(entries, reason, outcome.stderr, skipped);
}
