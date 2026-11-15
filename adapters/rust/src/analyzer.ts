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
import { existsSync } from "node:fs";
import { join } from "node:path";
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

/** cargo-home override çözümlemesi (options.cargoHomeDir önceliklidir). */
function resolveCargoHome(options: Partial<RustAdapterOptions> | undefined): string | null {
  if (options?.cargoHomeDir !== undefined && options.cargoHomeDir.trim().length > 0) {
    return options.cargoHomeDir;
  }
  return resolveCargoHomeDir();
}

interface ResolvedRuntimeOptions {
  readonly workerDir: string;
  readonly workerBinaryName: string;
  readonly cargoHomeDir: string | null;
  readonly requestTimeoutMs: number;
  readonly responseMaxChars: number;
  readonly cargoBuildTimeoutMs: number;
  readonly hasSpawnInjection: boolean;
}

function resolveOptions(
  partial?: Partial<RustAdapterOptions>,
): ResolvedRuntimeOptions {
  const cargoHome = resolveCargoHome(partial);
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
/* Worker binary sağlama: yoksa LİTERAL "cargo" ile derle              */
/* ------------------------------------------------------------------ */

interface WorkerBinaryProbe {
  readonly available: boolean;
  readonly detail: string;
}

/**
 * Worker binary'si yoksa LİTERAL "cargo" komutuyla (cargo-home PATH
 * ön ekli) derler. cargo toolchain'i yoksa/derleme başarısızsa
 * available=false döner — analyzer açık warning ile L0/L1'e düşer.
 *
 * Not: spawn enjeksiyonlu TEST koşumlarında build adımı atlanır; testler
 * binary'yi kendi bootstrap'ında derler ve sahte süreçler spawnProcess
 * ile verilir (build'ci test kontekstinde gereksiz yere cargo koşturmaz).
 */
async function ensureWorkerBinary(
  options: ResolvedRuntimeOptions,
): Promise<WorkerBinaryProbe> {
  const binaryPath = join(options.workerDir, options.workerBinaryName);
  if (existsSync(binaryPath)) {
    return { available: true, detail: "" };
  }

  if (options.hasSpawnInjection) {
    // Test enjeksiyonu: build yok — sahte süreç senaryosu doğrudan koşar.
    return { available: true, detail: "" };
  }

  if (!isCargoAvailable()) {
    return {
      available: false,
      detail:
        "cargo bulunamadı (PATH ve cargo-home öneklemesi) — Rust worker binary'si yok ve derlenemedi",
    };
  }

  const build = await runCargoBuild({
    manifestPath: defaultWorkerManifestPath(),
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
      detail: `cargo build başarısız (exit=${String(build.status ?? "bilinmiyor")}): ${tail}`,
    };
  }
  if (!existsSync(binaryPath)) {
    // Dürüst ayrım: derleme BAŞARILI ama binary override edilen dizinde
    // değil — "build başarısız" DEMEYİZ; gerçek sebep bildirilir.
    return {
      available: false,
      detail: `cargo build başarılı ama worker binary'si beklenen konumda yok: ${binaryPath} (workerDir override'ını kontrol edin)`,
    };
  }
  return { available: true, detail: "" };
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
  input: AnalyzeRustWorkspaceInput,
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
    workerDir: options.workerDir,
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
