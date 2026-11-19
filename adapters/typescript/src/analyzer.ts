import ts from "typescript";

import {
  canonicalJson,
  DomainError,
  evidenceId,
  sha256Hex,
  utf8Encode,
  type NodeKind,
  type NodeRef,
  type Resolution,
  type SnapshotEdgeInput,
  type SnapshotEvidenceInput,
  type SnapshotNodeInput,
} from "@causoryn/domain";

import {
  TS_ADAPTER_ANALYZER_ID,
  TS_ADAPTER_FRAMEWORK_LINKERS,
  TS_ADAPTER_VERSION,
  type FrameworkDetection,
  type FrameworkEdgesResult,
  type FrameworkLinkerId,
  type TypeScriptAdapterCapabilities,
  type TypeScriptAdapterDiagnostic,
  type TypeScriptAdapterInput,
  type TypeScriptAdapterResult,
  type TypeScriptAnalysisRun,
  type TsAdapterSourceFile,
} from "./types.js";

/**
 * TypeScript Language Adapter çekirdeği (TŞ v2.1 §6, §7, §7.1, §25/4;
 * sprint-1 görev 4).
 *
 * Çıkarım disiplini:
 * - CONTAINS  : File → üst düzey sembol; Class/Interface → üye Method.
 * - IMPORTS   : import/export-from beyanları; TypeChecker çözerse verified,
 *               relative aday eşleşme heuristic, kalanı açık UnknownExternal
 *               node üzerinde unresolved (uydurulmuş kenar yok).
 * - CALLS     : çağrı/new ifadeleri TypeChecker ile hedef sembole
 *               çözümlenir (verified); sembol analiz setinin DIŞINDAYSA
 *               açık UnknownExternal node (checker dayanaklı verified);
 *               hiç çözümlenemezse UnknownExternal + unresolved.
 * - ROUTES_TO : `<x>.<verb>("/path", handler)` çağrı kalıbı → Endpoint
 *               node + Endpoint → handler kenarı (route-attribute kanıtı).
 *
 * Invariant'lar (TŞ §8): (i) verified kenar ≥1 kanıt; (ii) dangling edge
 * yok — dış kaynaklar açık node; (iv/vi) deterministik çıktı — girdi
 * sırasızlaştırılıp anahtara göre sıralanır, saat okunmaz.
 *
 * Hata izolasyonu: tek dosyadaki parse/semantic sorunları analizi
 * düşürmez; tanılar dosya başına toplanır, `state: "partial"` bildirilir.
 */

/** Adapter'ın route tespitinde tanıdığı HTTP fiilleri. */
const HTTP_VERBS: ReadonlySet<string> = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);

/**
 * Node.js çekirdek modülleri (stabil genel liste). ts.resolveModuleName
 * bu ortamda bare/node: specifier'ları @types'a çözümlemediği için
 * bilinen-kural sınıflandırması kullanılır → resolution "heuristic".
 */
const NODE_BUILTIN_MODULES: ReadonlySet<string> = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

function isNodeBuiltinSpecifier(specifier: string): boolean {
  if (specifier.startsWith("node:")) {
    return NODE_BUILTIN_MODULES.has(specifier.slice(5));
  }
  return NODE_BUILTIN_MODULES.has(specifier);
}

const LANGUAGE = "typescript";

/** TŞ §7: bu dilimde modellenmeyen yapılar açıkça beyan edilir. */
const UNSUPPORTED_CONSTRUCTS: readonly string[] = [
  "decorators",
  "dynamic-import-resolution",
  "reflection/metaprogramming",
  "inline-anonymous-route-handlers",
  "function-local-declarations",
];

/* ------------------------------------------------------------------ */
/* Posix yol yardımcıları (node:path bağımlılığı olmadan)              */
/* ------------------------------------------------------------------ */

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Anahtar ad alanı: yol karşılaştırmaları için kanonik biçim.
 *
 * Denetim bulgusu düzeltmesi: `..`/`.` segmentleri ÇÖZÜMLLENİR. TS modül
 * çözümleme adayları normalize edilmemiş segmentler taşıyabilir
 * (`src/app/../lib/repo.ts` gibi); segmentler çözülmezse bellek-içi kaynak
 * haritası eşleşemez ve NodeNext bağ Wagner "Cannot find module" üretir
 * (diskteki kopyası olan fixture'da bu hata disk fallback'iyle maskelenir).
 */
function normalizePosixPath(p: string): string {
  const posix = toPosix(p);
  const drivePrefix = /^[a-zA-Z]:/.test(posix) ? posix.slice(0, 2) : undefined;
  const body = drivePrefix === undefined ? posix : posix.slice(2);
  const isAbsolute = body.startsWith("/");
  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const last = segments[segments.length - 1];
      if (last !== undefined && last !== "..") {
        segments.pop();
        continue;
      }
      if (!isAbsolute) segments.push("..");
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  if (drivePrefix !== undefined) return `${drivePrefix}/${joined}`;
  return isAbsolute ? `/${joined}` : joined;
}

function canonicalPath(p: string): string {
  const normalized = normalizePosixPath(p);
  return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

function posixDirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "." : p.slice(0, idx);
}

function posixJoin(base: string, relative: string): string {
  const segments = base.split("/");
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/* ------------------------------------------------------------------ */
/* Girdi doğrulama                                                     */
/* ------------------------------------------------------------------ */

function normalizeRelativePath(raw: string): string {
  const posix = toPosix(raw);
  if (posix.startsWith("/") || /^[a-zA-Z]:/.test(posix)) {
    throw new DomainError(
      "adapter/absolute-source-path",
      `Mutlak kaynak yolu kabul edilmez: ${raw}`,
    );
  }
  for (const segment of posix.split("/")) {
    if (segment === "" || segment === ".") {
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

/* ------------------------------------------------------------------ */
/* Kayıt yapıları                                                      */
/* ------------------------------------------------------------------ */

interface SourceEntry {
  readonly relativePath: string;
  /** Büyük/küçük harf koruyan normalize POSIX sanal yol (TS rootNames ve containingFile). */
  readonly absolutePath: string;
  /** Kanonik sanal mutlak yol; compiler host harita anahtarı. */
  readonly absoluteKey: string;
  readonly content: string;
  readonly sourceHash: string;
  sourceFile?: ts.SourceFile;
}

interface NodeRecord {
  readonly key: string;
  readonly node: SnapshotNodeInput;
  readonly ref: NodeRef;
}

/** Modül specifier sınıflandırması (TypeChecker/bilinen-kural dayanaklı). */
type ModuleRecord =
  | { readonly status: "internal"; readonly targetRelativePath: string }
  | { readonly status: "external"; readonly builtin: boolean }
  | { readonly status: "unresolved" };

interface EdgeRecord {
  readonly kind: SnapshotEdgeInput["kind"];
  readonly from: NodeRecord;
  readonly to: NodeRecord;
  readonly resolution: Resolution;
  readonly evidence: Map<string, SnapshotEvidenceInput>;
  readonly ambiguity?: {
    readonly candidates: readonly string[];
    readonly reason: string;
  };
}

/** Node/edge/evidence toplayıcı; çıktı kanonik düzende sıralanır. */
class GraphAssembler {
  readonly nodes = new Map<string, NodeRecord>();
  readonly edges = new Map<string, EdgeRecord>();
  readonly warnings: string[] = [];
  private readonly workspaceId: string;
  private readonly warningSeen = new Set<string>();

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  nodeKey(kind: NodeKind, qualifiedName: string, relativePath?: string): string {
    return canonicalJson([kind, qualifiedName, relativePath ?? null]);
  }

  /** Node kaydını getirir; yoksa oluşturur (dedupe nodeKey ile). */
  ensureNode(input: {
    kind: NodeKind;
    qualifiedName: string;
    relativePath?: string;
    language?: string;
    attributes?: Record<string, unknown>;
  }): NodeRecord {
    const key = this.nodeKey(input.kind, input.qualifiedName, input.relativePath);
    const existing = this.nodes.get(key);
    if (existing !== undefined) return existing;
    const ref: NodeRef = {
      kind: input.kind,
      qualifiedName: input.qualifiedName,
      ...(input.relativePath === undefined
        ? {}
        : { relativePath: input.relativePath }),
    };
    const record: NodeRecord = {
      key,
      ref,
      node: {
        ...ref,
        ...(input.language === undefined ? {} : { language: input.language }),
        attributes: input.attributes ?? {},
      },
    };
    this.nodes.set(key, record);
    return record;
  }

  /** Kenarı ekler; aynı (kind, from, to) kenarı kanıtlarıyla birleştirir. */
  addEdge(input: {
    kind: EdgeRecord["kind"];
    from: NodeRecord;
    to: NodeRecord;
    resolution: Resolution;
    evidence: SnapshotEvidenceInput;
    ambiguity?: { readonly candidates: readonly string[]; readonly reason: string };
  }): EdgeRecord {
    const key = `${input.kind}::${input.from.key}::${input.to.key}`;
    let record = this.edges.get(key);
    if (record === undefined) {
      record = {
        kind: input.kind,
        from: input.from,
        to: input.to,
        resolution: input.resolution,
        evidence: new Map<string, SnapshotEvidenceInput>(),
        ...(input.ambiguity === undefined ? {} : { ambiguity: input.ambiguity }),
      };
      this.edges.set(key, record);
    }
    const id = this.evidenceIdOf(input.evidence);
    record.evidence.set(id, input.evidence);
    return record;
  }

  addWarning(message: string): void {
    if (this.warningSeen.has(message)) return;
    this.warningSeen.add(message);
    this.warnings.push(message);
  }

  /** Domain deterministik evidence ID'si (içerik tabanlı, dedupe anahtarı). */
  evidenceIdOf(evidence: SnapshotEvidenceInput): string {
    return evidenceId({
      workspaceId: this.workspaceId,
      kind: evidence.kind,
      ...(evidence.span === undefined ? {} : { span: evidence.span }),
      analyzerId: evidence.analyzerId,
      analyzerVersion: evidence.analyzerVersion,
      rationale: evidence.rationale,
    });
  }
}

/**
 * Framework linker katkısı toplayıcı (sprint-2 B3). Linker'ların ürettiği
 * detection/node/kenar/tanı notları buradan ayrıştırılır; böylece
 * `extractFrameworkEdges` kapısı framework katkısını ana analizden
 * bağımsız raporlayabilir.
 */
interface FrameworkCollection {
  readonly detections: FrameworkDetection[];
  /** Linker'ların dokunduğu node anahtarları (Endpoint node'ları). */
  readonly nodeKeys: Set<string>;
  /** Linker'ların ürettiği kenar kayıtları (ROUTES_TO). */
  readonly edges: EdgeRecord[];
  /** Bilinmeyen framework kalıpları için tanı notları. */
  readonly diagnostics: TypeScriptAdapterDiagnostic[];
}

/** Analiz bağlamı: tüm geçiş fazları buradan paylaşır (modül-global yok). */
interface AnalysisContext {
  readonly workspaceId: string;
  readonly compilerOptions: ts.CompilerOptions;
  readonly resolutionHost: ts.ModuleResolutionHost;
  readonly checker: ts.TypeChecker;
  readonly entries: Map<string, SourceEntry>;
  readonly entryByRelativePath: Map<string, SourceEntry>;
  readonly assembler: GraphAssembler;
  /** Bildirim sembolü → node kaydı (registry). */
  readonly registry: Map<ts.Symbol, NodeRecord>;
  /** Test callback fonksiyonu → Test node kaydı (yalnızca test-affinity dosyalar). */
  readonly testCallbacks: Map<ts.Node, NodeRecord>;
  /** BDD sarmalayıcı çağrıları (`describe`/`it`/`test`); sahte CALLS kenarı üretmez. */
  readonly testBlockCalls: Set<ts.CallExpression>;
  readonly framework: FrameworkCollection;
}

/* ------------------------------------------------------------------ */
/* Ana analiz fonksiyonu                                               */
/* ------------------------------------------------------------------ */

/** Tek analiz koşusunun çıktısı: ana sonuç + framework linker katkısı. */
type AnalysisRun = TypeScriptAnalysisRun;

function runAnalysis(input: TypeScriptAdapterInput): AnalysisRun {
  if (input.workspaceId.trim().length === 0) {
    throw new DomainError("adapter/empty-workspace-id", "workspaceId boş olamaz");
  }
  const rootPosix = toPosix(input.rootDir).replace(/\/+$/, "");
  // Mutlaklık: POSIX ("/...") veya Windows sürücü harfi ("D:/...").
  const isAbsolute = rootPosix.startsWith("/") || /^[a-zA-Z]:\//.test(rootPosix);
  if (!isAbsolute) {
    throw new DomainError(
      "adapter/invalid-root-dir",
      `rootDir mutlak dizin olmalı: ${input.rootDir}`,
    );
  }

  // 1) Kaynakları normalize et, sırala, çakışmayı reddet (determinizm).
  const entries = new Map<string, SourceEntry>();
  const entryByRelativePath = new Map<string, SourceEntry>();
  for (const source of input.sources as readonly TsAdapterSourceFile[]) {
    const relativePath = normalizeRelativePath(source.relativePath);
    const absolutePath = normalizePosixPath(`${rootPosix}/${relativePath}`);
    const absoluteKey = canonicalPath(absolutePath);
    if (entries.has(absoluteKey) || entryByRelativePath.has(relativePath)) {
      throw new DomainError(
        "adapter/duplicate-source-path",
        `Aynı kaynak yolu iki kez verildi: ${source.relativePath}`,
      );
    }
    const entry: SourceEntry = {
      relativePath,
      absolutePath,
      absoluteKey,
      content: source.content,
      sourceHash: sha256Hex(utf8Encode(source.content)),
    };
    entries.set(absoluteKey, entry);
    entryByRelativePath.set(relativePath, entry);
  }
  const sortedEntries = [...entryByRelativePath.values()].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : 1,
  );

  // 2) Compiler host: bellek-içi çanta önce, ts.sys salt-okunur fallback.
  const compilerOptions: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  };
  const host = createCompilerHostWithDefaultLib(compilerOptions);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  host.fileExists = (path: string) =>
    entries.has(canonicalPath(path)) || baseFileExists(path);
  host.readFile = (path: string): string | undefined => {
    const hit = entries.get(canonicalPath(path));
    return hit === undefined ? baseReadFile(path) : hit.content;
  };
  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists: (path: string) => host.fileExists(path),
    readFile: (path: string) => host.readFile(path),
  };
  // Bellek-içi kaynakların ata dizinleri: NodeNext çözümleyicisi aday
  // dosyaya bakmadan önce dizin varlığını directoryExists ile sorar;
  // bellek-içi dizinler diskte olmadığından ham yanıt "yok"tur ve çözümleme
  // adaya hiç ulaşmadan düşer (POSIX "/" kökünde ilk ayraç index 0'dır).
  const memoryDirectories = new Set<string>();
  for (const key of entries.keys()) {
    let slash = key.indexOf("/");
    while (slash >= 0) {
      memoryDirectories.add(canonicalPath(slash === 0 ? "/" : key.slice(0, slash)));
      slash = key.indexOf("/", slash + 1);
    }
  }
  if (host.directoryExists !== undefined) {
    const baseDirectoryExists = host.directoryExists.bind(host);
    resolutionHost.directoryExists = (path: string): boolean =>
      memoryDirectories.has(canonicalPath(path)) || baseDirectoryExists(path);
  }
  if (host.realpath !== undefined) {
    const baseRealpath = host.realpath.bind(host);
    // Denetim bulgusu düzeltmesi: Node16/NodeNext çözümlemesi adayları
    // realpath ile gerçekler; bellek-içi kaynakların diskte gerçek yolu
    // olmadığından ham realpath onları reddeder. Map eşleşmesi varsa yol
    // olduğu gibi onaylanır.
    resolutionHost.realpath = (path: string): string => {
      if (entries.has(canonicalPath(path))) return path;
      // realpath yalnızca fileExists onayından sonra çağrılır; disk tarafında
      // beklenmedik bir undefined durumunda kimlik düşüşü güvenlidir.
      const real = baseRealpath(path);
      return real === undefined ? path : real;
    };
  }

  // Denetim bulgusu düzeltmesi (modül çözümleme): TS'nin VARSAYILAN program
  // çözümleyici, tamamen bellek-içi kaynak setlerinde göreli içe aktarımları
  // host'a hiç modül adayı sorgulatmadan UNRESOLVED bırakabiliyor (kanıt:
  // `fileExists` izi — yalnızca package.json/node_modules taraması; "Cannot
  // find module" tanısı; diskte kopyası olan fixture'da disk fallback'i
  // hatayı maskeler). Çözümleme kancaları, kanonik anahtarlı resolutionHost
  // üzerinden ts.resolveModuleName çalıştırır; node_modules/lib dahil aynı
  // semantik izlenir.
  const resolveOne = (
    moduleName: string,
    containingFile: string,
  ): ts.ResolvedModuleFull | undefined =>
    ts.resolveModuleName(moduleName, containingFile, compilerOptions, resolutionHost)
      .resolvedModule;
  const resolveModuleNamesHook: ts.CompilerHost["resolveModuleNames"] = (
    moduleNames,
    containingFile,
  ) => moduleNames.map((moduleName) => resolveOne(moduleName, containingFile));
  const resolveModuleNameLiteralsHook: ts.CompilerHost["resolveModuleNameLiterals"] = (
    moduleLiterals,
    containingFile,
  ) =>
    moduleLiterals.map((literal) => ({
      resolvedModule: resolveOne(literal.text, containingFile),
    }));
  host.resolveModuleNames = resolveModuleNamesHook;
  host.resolveModuleNameLiterals = resolveModuleNameLiteralsHook;

  // 3) Program + TypeChecker (TŞ §7: TypeScript Compiler API).
  const rootNames = sortedEntries.map((entry) => entry.absolutePath);
  const program = ts.createProgram({ rootNames, options: compilerOptions, host });
  const checker = program.getTypeChecker();
  for (const sourceFile of program.getSourceFiles()) {
    const hit = entries.get(canonicalPath(sourceFile.fileName));
    if (hit !== undefined) hit.sourceFile = sourceFile;
  }

  const assembler = new GraphAssembler(input.workspaceId);
  const context: AnalysisContext = {
    workspaceId: input.workspaceId,
    compilerOptions,
    resolutionHost,
    checker,
    entries,
    entryByRelativePath,
    assembler,
    registry: new Map<ts.Symbol, NodeRecord>(),
    testCallbacks: new Map<ts.Node, NodeRecord>(),
    testBlockCalls: new Set<ts.CallExpression>(),
    framework: {
      detections: [],
      nodeKeys: new Set<string>(),
      edges: [],
      diagnostics: [],
    },
  };

  const diagnostics: TypeScriptAdapterDiagnostic[] = [];

  // File node'ları (deterministik: sıralı girdi).
  for (const entry of sortedEntries) {
    assembler.ensureNode({
      kind: "File",
      qualifiedName: entry.relativePath,
      relativePath: entry.relativePath,
      language: LANGUAGE,
      attributes: { sourceHash: entry.sourceHash },
    });
  }

  /* Geçiş fazları: her faz dosya başına try/catch ile izole edilir — tek
   * dosyanın sorunu motoru düşürmez, tanı olarak toplanır (TŞ §5.1). */
  const collectDiagnostics = (entry: SourceEntry): void => {
    const sourceFile = entry.sourceFile;
    if (sourceFile === undefined) {
      diagnostics.push({
        relativePath: entry.relativePath,
        code: "ADAPTER_INTERNAL",
        message: "Program bu kaynak için SourceFile üretmedi",
        line: 0,
      });
      return;
    }
    const all = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ];
    for (const diag of all) {
      diagnostics.push({
        relativePath: entry.relativePath,
        code: `TS${diag.code}`,
        message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
        line:
          diag.file !== undefined && diag.start !== undefined
            ? diag.file.getLineAndCharacterOfPosition(diag.start).line + 1
            : 0,
      });
    }
  };

  const runPhase = (
    entry: SourceEntry,
    phase: (sourceFile: ts.SourceFile) => void,
  ): void => {
    const sourceFile = entry.sourceFile;
    if (sourceFile === undefined) return;
    try {
      phase(sourceFile);
    } catch (error) {
      diagnostics.push({
        relativePath: entry.relativePath,
        code: "ADAPTER_INTERNAL",
        message: error instanceof Error ? error.message : String(error),
        line: 0,
      });
    }
  };

  // Faz 0: tanılar. Faz 1: CONTAINS + symbol registry (önce tüm dosyalar,
  // böylece çapraz-dosya sembol araması registry'de tam olur).
  for (const entry of sortedEntries) {
    try {
      collectDiagnostics(entry);
    } catch (error) {
      diagnostics.push({
        relativePath: entry.relativePath,
        code: "ADAPTER_INTERNAL",
        message: error instanceof Error ? error.message : String(error),
        line: 0,
      });
    }
  }
  for (const entry of sortedEntries) {
    runPhase(entry, (sourceFile) =>
      extractDeclarations(context, entry, sourceFile),
    );
  }
  for (const entry of sortedEntries) {
    runPhase(entry, (sourceFile) => extractImports(context, entry, sourceFile));
  }

  /* Faz 2.5: framework linker'ları (sprint-2 B3, extractFrameworkEdges
   * kapısı). Jenerik route fazından ÖNCE çalışır: framework Endpoint
   * node'ları `framework` özniteliğiyle oluşur; jenerik faz aynı
   * (kind, from, to) kenarını kanıt birleştirmeyle (aynı evidence ID)
   * paylaşır. Framework olmayan projelerde bu faz sessizdir — Faz A
   * davranışı bit-bit korunur. */
  const expressDetection = detectExpressFramework(sortedEntries);
  const nextDetection = detectNextAppRouterFramework(sortedEntries);
  if (expressDetection !== undefined) {
    context.framework.detections.push(expressDetection);
    for (const entry of sortedEntries) {
      runPhase(entry, (sourceFile) =>
        collectExpressRoutes(context, entry, sourceFile),
      );
    }
  }
  if (nextDetection !== undefined) {
    context.framework.detections.push(nextDetection);
    for (const entry of sortedEntries) {
      runPhase(entry, (sourceFile) =>
        collectNextAppRouterRoutes(context, entry, sourceFile),
      );
    }
  }
  for (const diagnostic of context.framework.diagnostics) {
    diagnostics.push(diagnostic);
  }

  for (const entry of sortedEntries) {
    runPhase(entry, (sourceFile) =>
      extractCallsAndRoutes(context, entry, sourceFile),
    );
  }

  // 4) Kanonik düzende çıktı (TŞ §8 invariant iv/vi).
  const byEdgeKey = (a: EdgeRecord, b: EdgeRecord): number => {
    const aKey = edgeRecordKey(a);
    const bKey = edgeRecordKey(b);
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  };
  const nodeInputs = [...assembler.nodes.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((record) => record.node);

  const edgeInputs: SnapshotEdgeInput[] = [...assembler.edges.values()]
    .sort(byEdgeKey)
    .map(edgeRecordToInput);

  // 5) Framework linker katkısı (extractFrameworkEdges kapısı çıktısı).
  const frameworkNodes = [...context.framework.nodeKeys]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => assembler.nodes.get(key))
    .filter((record): record is NodeRecord => record !== undefined)
    .map((record) => record.node);

  const totalEdges = edgeInputs.length;
  const verifiedEdges = edgeInputs.filter(
    (edge) => edge.resolution === "verified",
  ).length;
  const coverageRatio =
    totalEdges === 0
      ? 0
      : Math.round((verifiedEdges / totalEdges) * 10000) / 10000;

  const capabilities: TypeScriptAdapterCapabilities = {
    astParse: true,
    symbolResolution: true,
    containsEdges: true,
    importEdges: true,
    callEdges: true,
    routeDetection: "http-verb-call-pattern",
    frameworkLinkers: TS_ADAPTER_FRAMEWORK_LINKERS,
  };

  return {
    result: {
      analyzerId: TS_ADAPTER_ANALYZER_ID,
      analyzerVersion: TS_ADAPTER_VERSION,
      state: diagnostics.length > 0 ? "partial" : "ready",
      capabilities,
      coverageRatio,
      unsupportedConstructs: UNSUPPORTED_CONSTRUCTS,
      warnings: assembler.warnings,
      diagnostics,
      nodes: nodeInputs,
      edges: edgeInputs,
    },
    framework: {
      detections: [...context.framework.detections].sort((a, b) =>
        a.framework < b.framework ? -1 : 1,
      ),
      nodes: frameworkNodes,
      edges: [...context.framework.edges].sort(byEdgeKey).map(edgeRecordToInput),
      diagnostics: [...context.framework.diagnostics].sort((a, b) => {
        if (a.relativePath !== b.relativePath) {
          return a.relativePath < b.relativePath ? -1 : 1;
        }
        if (a.code !== b.code) return a.code < b.code ? -1 : 1;
        return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
      }),
    },
  };
}

/**
 * TypeScript Language Adapter ana girişi: tam graph (framework kenarları
 * dahil) döner.
 */
export function analyzeTypeScriptProgram(
  input: TypeScriptAdapterInput,
): TypeScriptAdapterResult {
  return runAnalysis(input).result;
}

/**
 * Framework linker kapısı (sprint-2 B3, TŞ §7 L3): Express route kayıtları
 * ve Next.js App Router kural dosyaları için Endpoint node'ları + ROUTES_TO
 * kenarlarını üretir ve yalnızca framework katkısını raporlar.
 *
 * Aynı analiz çekirdeğini koşturur (handler çözümlemesi TypeChecker
 * dayanaklıdır); dönen kenarlar ana analizle aynı kimlik/evidence
 * birleştirmesine tabidir. Framework tespiti yapılamayan girdilerde
 * detections/nodes/edges/diagnostics boş döner (uydurma yasak).
 *
 * Hem ana sonucu hem framework katkısını isteyen istemciler iki ayrı çağrı
 * yerine `analyzeTypeScriptProgramWithFrameworks` kullanmalıdır: her iki
 * kapı da tüm analizi koşturur, ayrı çağrı 2x derleme maliyeti demektir
 * (denetim bulgusu 3).
 */
export function extractFrameworkEdges(
  input: TypeScriptAdapterInput,
): FrameworkEdgesResult {
  return runAnalysis(input).framework;
}

/**
 * Birleşik giriş (denetim bulgusu 3 düzeltmesi): TEK analiz koşumuyla ana
 * sonucu ve framework linker katkısını birlikte döndürür; `result` dilimi
 * `analyzeTypeScriptProgram` ile, `framework` dilimi
 * `extractFrameworkEdges` ile bit-bit eşdeğerdir.
 */
export function analyzeTypeScriptProgramWithFrameworks(
  input: TypeScriptAdapterInput,
): TypeScriptAnalysisRun {
  return runAnalysis(input);
}

/* ------------------------------------------------------------------ */
/* Kanıt yardımcıları                                                  */
/* ------------------------------------------------------------------ */

function spanStart(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function spanEnd(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

function evidenceFor(
  entry: SourceEntry,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  kind: string,
  rationale: string,
): SnapshotEvidenceInput {
  return {
    kind,
    span: {
      relativePath: entry.relativePath,
      startLine: spanStart(sourceFile, node),
      endLine: spanEnd(sourceFile, node),
      sourceHash: entry.sourceHash,
    },
    analyzerId: TS_ADAPTER_ANALYZER_ID,
    analyzerVersion: TS_ADAPTER_VERSION,
    rationale,
  };
}

/** Kenar kaydının sıralama anahtarı (kind::from::to). */
function edgeRecordKey(record: EdgeRecord): string {
  return `${record.kind}::${record.from.key}::${record.to.key}`;
}

/** Kenar kaydını SnapshotEdgeInput girdisine çevirir (kanonik kanıt sırası). */
function edgeRecordToInput(record: EdgeRecord): SnapshotEdgeInput {
  return {
    kind: record.kind,
    from: record.from.ref,
    to: record.to.ref,
    resolution: record.resolution,
    evidence: [...record.evidence.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map((pair) => pair[1]),
    ...(record.ambiguity === undefined ? {} : { ambiguity: record.ambiguity }),
  };
}

/* ------------------------------------------------------------------ */
/* Faz 1: CONTAINS + symbol registry                                   */
/* ------------------------------------------------------------------ */

function extractDeclarations(
  context: AnalysisContext,
  entry: SourceEntry,
  sourceFile: ts.SourceFile,
): void {
  const { assembler, checker, registry } = context;

  const fileNode = assembler.ensureNode({
    kind: "File",
    qualifiedName: entry.relativePath,
    relativePath: entry.relativePath,
  });

  const registerWithSymbol = (
    symbol: ts.Symbol | undefined,
    record: NodeRecord,
  ): void => {
    if (symbol !== undefined) registry.set(symbol, record);
  };

  const symbolOfDeclaration = (declaration: ts.Declaration): ts.Symbol | undefined => {
    const name = ts.getNameOfDeclaration(declaration);
    return name === undefined
      ? undefined
      : checker.getSymbolAtLocation(name);
  };

  const addContains = (
    from: NodeRecord,
    to: NodeRecord,
    node: ts.Node,
    rationale: string,
  ): void => {
    assembler.addEdge({
      kind: "CONTAINS",
      from,
      to,
      resolution: "verified",
      evidence: evidenceFor(entry, sourceFile, node, "ast-span", rationale),
    });
  };

  const registerMembers = (
    statement: ts.ClassDeclaration | ts.InterfaceDeclaration,
    ownerRecord: NodeRecord,
    ownerKind: NodeKind,
  ): void => {
    for (const member of statement.members) {
      if (!ts.isMethodDeclaration(member) && !ts.isMethodSignature(member)) continue;
      const memberName = ts.isIdentifier(member.name) ? member.name.text : undefined;
      if (memberName === undefined) continue;
      const qualifiedName = `${ownerRecord.node.qualifiedName}.${memberName}`;
      const memberRecord = assembler.ensureNode({
        kind: "Method",
        qualifiedName,
        relativePath: entry.relativePath,
        language: LANGUAGE,
      });
      registerWithSymbol(symbolOfDeclaration(member), memberRecord);
      addContains(
        ownerRecord,
        memberRecord,
        member,
        `CONTAINS: ${ownerRecord.node.qualifiedName} ${ownerKind.toLowerCase()} bildirimi içindeki ${memberName} üyesi AST span kanıtıyla eşlendi.`,
      );
    }
  };

  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      const name = statement.name?.text;
      if (name === undefined) continue;
      const kind: NodeKind = ts.isClassDeclaration(statement) ? "Class" : "Interface";
      const record = assembler.ensureNode({
        kind,
        qualifiedName: name,
        relativePath: entry.relativePath,
        language: LANGUAGE,
      });
      registerWithSymbol(symbolOfDeclaration(statement), record);
      addContains(
        fileNode,
        record,
        statement,
        `CONTAINS: ${entry.relativePath} dosyasındaki ${name} ${kind.toLowerCase()} bildirimi AST span kanıtıyla eşlendi.`,
      );
      registerMembers(statement, record, kind);
      continue;
    }

    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text;
      if (name === undefined) continue;
      const record = assembler.ensureNode({
        kind: "Function",
        qualifiedName: name,
        relativePath: entry.relativePath,
        language: LANGUAGE,
      });
      registerWithSymbol(symbolOfDeclaration(statement), record);
      addContains(
        fileNode,
        record,
        statement,
        `CONTAINS: ${entry.relativePath} dosyasındaki ${name} fonksiyon bildirimi AST span kanıtıyla eşlendi.`,
      );
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        // Call signature'lı tip = handler değeri → Handler node'u
        // (ör. const ordersRoute = createOrdersRoute(ordersService)).
        const type = checker.getTypeAtLocation(declaration.name);
        if (type.getCallSignatures().length === 0) continue;
        const record = assembler.ensureNode({
          kind: "Handler",
          qualifiedName: declaration.name.text,
          relativePath: entry.relativePath,
          language: LANGUAGE,
        });
        registerWithSymbol(
          checker.getSymbolAtLocation(declaration.name),
          record,
        );
        addContains(
          fileNode,
          record,
          statement,
          `CONTAINS: ${entry.relativePath} dosyasındaki ${declaration.name.text} handler bağlaması AST span kanıtıyla eşlendi.`,
        );
      }
      continue;
    }
  }

  if (isTestAffinityTypeScriptFile(entry.relativePath)) {
    extractTestDefinitions(context, entry, sourceFile, fileNode, addContains);
  }
}

const TEST_AFFINITY_MARKERS: readonly string[] = [".test", ".spec", ".tests"];
const TEST_AFFINITY_SUFFIXES: readonly string[] = ["Tests", "Test", "Spec"];
const BDD_MODIFIERS: ReadonlySet<string> = new Set(["only", "skip"]);

/**
 * Test-affinity TypeScript dosyası denetimi (preflight testAffinityBase +
 * `__tests__` dizin segmenti uyumu). Üretim dosyalarındaki `test(...)` /
 * `it(...)` çağrıları bu kapı sayesinde test bloğu olarak yorumlanmaz.
 */
function isTestAffinityTypeScriptFile(relativePath: string): boolean {
  const segments = toPosix(relativePath).split("/");
  if (segments.includes("node_modules")) return false;
  const basename = segments[segments.length - 1] ?? "";
  if (
    basename.endsWith(".d.ts") ||
    basename.endsWith(".d.mts") ||
    basename.endsWith(".d.cts")
  ) {
    return false;
  }
  let stem: string | undefined;
  for (const ext of [".tsx", ".ts", ".mts", ".cts"]) {
    if (basename.length > ext.length && basename.endsWith(ext)) {
      stem = basename.slice(0, basename.length - ext.length);
      break;
    }
  }
  if (stem === undefined) return false;
  if (segments.slice(0, -1).includes("__tests__")) return true;
  for (const marker of TEST_AFFINITY_MARKERS) {
    if (stem.length > marker.length && stem.endsWith(marker)) return true;
  }
  for (const suffix of TEST_AFFINITY_SUFFIXES) {
    if (stem.length > suffix.length && stem.endsWith(suffix)) return true;
  }
  return false;
}

interface BddBlockMatch {
  readonly title: string;
  readonly callback: ts.ArrowFunction | ts.FunctionExpression;
}

function extractStaticNonEmptyTitle(
  arg: ts.Expression | undefined,
): string | undefined {
  if (arg === undefined) return undefined;
  if (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) {
    return undefined;
  }
  if (arg.text.trim().length === 0) return undefined;
  return arg.text;
}

function findLastCallbackArgument(
  args: readonly ts.Expression[],
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (let index = args.length - 1; index >= 1; index -= 1) {
    const candidate = args[index];
    if (
      candidate !== undefined &&
      (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate))
    ) {
      return candidate;
    }
  }
  return undefined;
}

function isSuiteCallee(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) return callee.text === "describe";
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "describe"
  ) {
    return BDD_MODIFIERS.has(callee.name.text);
  }
  return false;
}

function isTestCallee(callee: ts.Expression): boolean {
  if (ts.isIdentifier(callee)) {
    return callee.text === "it" || callee.text === "test";
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    (callee.expression.text === "it" || callee.expression.text === "test")
  ) {
    return BDD_MODIFIERS.has(callee.name.text);
  }
  return false;
}

function matchSuiteCall(call: ts.CallExpression): BddBlockMatch | undefined {
  if (!isSuiteCallee(call.expression) || call.arguments.length < 2) {
    return undefined;
  }
  const title = extractStaticNonEmptyTitle(call.arguments[0]);
  if (title === undefined) return undefined;
  const callback = findLastCallbackArgument(call.arguments);
  if (callback === undefined) return undefined;
  return { title, callback };
}

function matchTestCall(call: ts.CallExpression): BddBlockMatch | undefined {
  if (!isTestCallee(call.expression) || call.arguments.length < 2) {
    return undefined;
  }
  const title = extractStaticNonEmptyTitle(call.arguments[0]);
  if (title === undefined) return undefined;
  const callback = findLastCallbackArgument(call.arguments);
  if (callback === undefined) return undefined;
  return { title, callback };
}

function extractTestDefinitions(
  context: AnalysisContext,
  entry: SourceEntry,
  sourceFile: ts.SourceFile,
  fileNode: NodeRecord,
  addContains: (
    from: NodeRecord,
    to: NodeRecord,
    node: ts.Node,
    rationale: string,
  ) => void,
): void {
  const { assembler, testCallbacks, testBlockCalls } = context;

  const walk = (node: ts.Node, suiteChain: readonly string[]): void => {
    if (ts.isCallExpression(node)) {
      const suiteMatch = matchSuiteCall(node);
      if (suiteMatch !== undefined) {
        testBlockCalls.add(node);
        const nextSuiteChain = [...suiteChain, suiteMatch.title];
        walk(node.expression, suiteChain);
        for (const arg of node.arguments) {
          if (arg === suiteMatch.callback) {
            walk(suiteMatch.callback.body, nextSuiteChain);
          } else {
            walk(arg, suiteChain);
          }
        }
        return;
      }

      const testMatch = matchTestCall(node);
      if (testMatch !== undefined) {
        testBlockCalls.add(node);
        const qualifiedName =
          suiteChain.length > 0
            ? `${suiteChain.join(" > ")} > ${testMatch.title}`
            : testMatch.title;
        const testRecord = assembler.ensureNode({
          kind: "Test",
          qualifiedName,
          relativePath: entry.relativePath,
          language: LANGUAGE,
        });
        addContains(
          fileNode,
          testRecord,
          node,
          `CONTAINS: ${entry.relativePath} dosyasındaki '${qualifiedName}' test tanımı AST span kanıtıyla eşlendi.`,
        );
        testCallbacks.set(testMatch.callback, testRecord);
        walk(node.expression, suiteChain);
        for (const arg of node.arguments) {
          if (arg === testMatch.callback) {
            walk(testMatch.callback.body, suiteChain);
          } else {
            walk(arg, suiteChain);
          }
        }
        return;
      }
    }
    ts.forEachChild(node, (child) => walk(child, suiteChain));
  };

  walk(sourceFile, []);
}

/* ------------------------------------------------------------------ */
/* Faz 2: IMPORTS                                                      */
/* ------------------------------------------------------------------ */

function classifyModuleSpecifier(
  context: AnalysisContext,
  containingAbsoluteKey: string,
  specifier: string,
): ModuleRecord {
  // Node.js çekirdek modülleri: bilinen kural (checker dayanağı yok → heuristic).
  if (isNodeBuiltinSpecifier(specifier)) {
    return { status: "external", builtin: true };
  }
  const resolved = ts.resolveModuleName(
    specifier,
    containingAbsoluteKey,
    context.compilerOptions,
    context.resolutionHost,
  ).resolvedModule;
  if (resolved === undefined) return { status: "unresolved" };
  const target = context.entries.get(canonicalPath(resolved.resolvedFileName));
  if (target !== undefined) {
    return { status: "internal", targetRelativePath: target.relativePath };
  }
  return { status: "external", builtin: false };
}

/** Kaynak dosyadaki import/export-from module specifier'larını toplar. */
function collectModuleSpecifiers(
  sourceFile: ts.SourceFile,
): Array<{ node: ts.StringLiteralLike; text: string }> {
  const specifiers: Array<{ node: ts.StringLiteralLike; text: string }> = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (moduleSpecifier !== undefined && ts.isStringLiteralLike(moduleSpecifier)) {
        specifiers.push({ node: moduleSpecifier, text: moduleSpecifier.text });
      }
    }
  }
  return specifiers;
}

function extractImports(
  context: AnalysisContext,
  entry: SourceEntry,
  sourceFile: ts.SourceFile,
): void {
  const { assembler } = context;
  const fileNode = assembler.ensureNode({
    kind: "File",
    qualifiedName: entry.relativePath,
    relativePath: entry.relativePath,
  });

  const specifiers = collectModuleSpecifiers(sourceFile);

  for (const specifier of specifiers) {
    const record = classifyModuleSpecifier(context, entry.absolutePath, specifier.text);

    if (record.status === "internal") {
      const targetFile = assembler.ensureNode({
        kind: "File",
        qualifiedName: record.targetRelativePath,
        relativePath: record.targetRelativePath,
      });
      assembler.addEdge({
        kind: "IMPORTS",
        from: fileNode,
        to: targetFile,
        resolution: "verified",
        evidence: evidenceFor(
          entry,
          sourceFile,
          specifier.node,
          "ast-span",
          `IMPORTS: ${entry.relativePath} dosyasındaki '${specifier.text}' beyanı TypeChecker tarafından ${record.targetRelativePath} dosyasına çözümlendi.`,
        ),
      });
      continue;
    }

    if (record.status === "external") {
      const externalNode = assembler.ensureNode({
        kind: "UnknownExternal",
        qualifiedName: specifier.text,
      });
      if (record.builtin) {
        // Node.js çekirdek modülü: bilinen kural dayanağı → heuristic.
        assembler.addEdge({
          kind: "IMPORTS",
          from: fileNode,
          to: externalNode,
          resolution: "heuristic",
          evidence: evidenceFor(
            entry,
            sourceFile,
            specifier.node,
            "ast-span",
            `IMPORTS: '${specifier.text}' Node.js çekirdek modülü olarak bilinen kural ile sınıflandırıldı (heuristic); dış kaynak açık UnknownExternal node olarak temsil edildi.`,
          ),
          ambiguity: {
            candidates: [specifier.text],
            reason: "Node.js builtin sınıflandırması; semantik çözümleme yok.",
          },
        });
        continue;
      }
      assembler.addEdge({
        kind: "IMPORTS",
        from: fileNode,
        to: externalNode,
        resolution: "verified",
        evidence: evidenceFor(
          entry,
          sourceFile,
          specifier.node,
          "ast-span",
          `IMPORTS: ${entry.relativePath} dosyasındaki '${specifier.text}' analizi dışındaki modüle çözümlendi; dış kaynak açık UnknownExternal node olarak temsil edildi.`,
        ),
      });
      continue;
    }

    // unresolved: relative aday eşleşmesi varsa heuristic, yoksa açık node.
    const candidate = heuristicCandidatePath(
      context,
      specifier.text,
      entry.relativePath,
    );
    if (candidate !== undefined) {
      const targetFile = assembler.ensureNode({
        kind: "File",
        qualifiedName: candidate,
        relativePath: candidate,
      });
      assembler.addEdge({
        kind: "IMPORTS",
        from: fileNode,
        to: targetFile,
        resolution: "heuristic",
        evidence: evidenceFor(
          entry,
          sourceFile,
          specifier.node,
          "ast-span",
          `IMPORTS: '${specifier.text}' TypeChecker tarafından çözümlenemedi; relative aday yolu ${candidate} analizi içinde eşleşti (heuristic).`,
        ),
        ambiguity: {
          candidates: [candidate],
          reason: "TypeChecker modülü çözümlemedi; dosya yolu aday eşleşmesi.",
        },
      });
      continue;
    }

    const externalNode = assembler.ensureNode({
      kind: "UnknownExternal",
      qualifiedName: specifier.text,
    });
    assembler.addEdge({
      kind: "IMPORTS",
      from: fileNode,
      to: externalNode,
      resolution: "unresolved",
      evidence: evidenceFor(
        entry,
        sourceFile,
        specifier.node,
        "ast-span",
        `IMPORTS: '${specifier.text}' çözümlenemedi; uydurma hedef yerine açık UnknownExternal node üzerinde unresolved işaretlendi.`,
      ),
    });
    assembler.addWarning(
      `IMPORTS çözümlenemedi: ${entry.relativePath} -> '${specifier.text}' (unresolved, UnknownExternal node üretildi)`,
    );
  }
}

/** Relative specifier için analiz seti içinde aday yol eşleşmesi arar. */
function heuristicCandidatePath(
  context: AnalysisContext,
  specifier: string,
  fromRelativePath: string,
): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const joined = posixJoin(posixDirname(fromRelativePath), specifier);
  const candidates = [joined];
  if (joined.endsWith(".js")) candidates.push(`${joined.slice(0, -3)}.ts`);
  for (const candidate of candidates) {
    if (context.entryByRelativePath.has(candidate)) return candidate;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Faz 3: CALLS + ROUTES_TO                                            */
/* ------------------------------------------------------------------ */

function extractCallsAndRoutes(
  context: AnalysisContext,
  entry: SourceEntry,
  sourceFile: ts.SourceFile,
): void {
  const visit = (node: ts.Node, caller: NodeRecord | undefined): void => {
    let currentCaller = caller;

    const testCaller = context.testCallbacks.get(node);
    if (testCaller !== undefined) {
      currentCaller = testCaller;
    } else if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      const ref = callerRecordForFunctionLike(context, entry, node);
      if (ref !== undefined) currentCaller = ref;
    } else if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      caller?.node.kind !== "Test"
    ) {
      const ref = callerRecordForFunctionLike(context, entry, node);
      if (ref !== undefined) currentCaller = ref;
    }

    if (ts.isCallExpression(node)) {
      tryRoutePattern(context, entry, sourceFile, node);
      if (!context.testBlockCalls.has(node)) {
        emitCallEdge(context, entry, sourceFile, node, currentCaller);
      }
    } else if (ts.isNewExpression(node)) {
      emitCallEdge(context, entry, sourceFile, node, currentCaller);
    }

    ts.forEachChild(node, (child) => visit(child, currentCaller));
  };

  visit(sourceFile, undefined);
}

/** Caller NodeRecord çözer; anonymous arrow değişkene bağlıysa Handler olur. */
function callerRecordForFunctionLike(
  context: AnalysisContext,
  entry: SourceEntry,
  node: ts.Node,
): NodeRecord | undefined {
  const { assembler, registry, checker } = context;

  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    const name = ts.getNameOfDeclaration(node);
    if (name === undefined || !ts.isIdentifier(name)) return undefined;
    const owner = node.parent;
    const ownerName =
      (ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner))
        ? owner.name?.text
        : undefined;
    const qualifiedName =
      ownerName === undefined ? name.text : `${ownerName}.${name.text}`;
    const kind: NodeKind = ts.isMethodDeclaration(node) ? "Method" : "Function";
    const record = assembler.ensureNode({
      kind,
      qualifiedName,
      relativePath: entry.relativePath,
      language: LANGUAGE,
    });
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol !== undefined) registry.set(symbol, record);
    return record;
  }

  // Anonymous arrow/function-expression: VariableDeclaration'a bağlıysa
  // Handler node'u caller olur (ör. const h = (req, res) => {...}).
  const parent = node.parent;
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return assembler.ensureNode({
      kind: "Handler",
      qualifiedName: parent.name.text,
      relativePath: entry.relativePath,
      language: LANGUAGE,
    });
  }
  return undefined;
}

/** Bildirimi analiz seti içindeyse relativePath döner. */
function ownRelativePathOf(
  context: AnalysisContext,
  declaration: ts.Declaration,
): string | undefined {
  return context.entries.get(canonicalPath(declaration.getSourceFile().fileName))
    ?.relativePath;
}

/**
 * Sembolü node kaydına çözer: 0) import/namespace alias'ı hedef sembole
 * çevrilir (çağrı yerindeki sembol import specifier sembolüdür; registry
 * bildirim sembolüyle tuşlanır — alias çözümü olmadan analiz setindeki
 * sınıf/fonksiyon hedefleri UnknownExternal'a düşer), 1) registry,
 * 2) analiz seti içinde bildirim (registry boşluğu kapanır), 3) undefined
 * (dış/bilinmeyen).
 */
function resolveSymbolRecord(
  context: AnalysisContext,
  entry: SourceEntry,
  symbol: ts.Symbol | undefined,
  declaration: ts.Declaration | undefined,
): NodeRecord | undefined {
  const { registry, checker } = context;

  if (
    symbol !== undefined &&
    (symbol.flags & ts.SymbolFlags.Alias) !== 0
  ) {
    const aliased = checker.getAliasedSymbol(symbol);
    if (aliased !== undefined && aliased !== symbol) {
      return resolveSymbolRecord(
        context,
        entry,
        aliased,
        aliased.getDeclarations()?.[0],
      );
    }
  }

  if (symbol !== undefined) {
    const hit = registry.get(symbol);
    if (hit !== undefined) return hit;
  }

  if (declaration !== undefined && ownRelativePathOf(context, declaration) !== undefined) {
    const derived = deriveNodeRecord(context, declaration);
    if (derived !== undefined) {
      if (symbol !== undefined) registry.set(symbol, derived);
      return derived;
    }
  }
  return undefined;
}

/** Registry boşlukları için bildirimden node türetir (kurucu vb.). */
function deriveNodeRecord(
  context: AnalysisContext,
  declaration: ts.Declaration,
): NodeRecord | undefined {
  const { assembler } = context;
  let kind: NodeKind | undefined;
  let qualifiedName: string | undefined;

  if (ts.isConstructorDeclaration(declaration)) {
    const owner = declaration.parent;
    const ownerName = ts.isClassDeclaration(owner) ? owner.name?.text : undefined;
    if (ownerName === undefined) return undefined;
    kind = "Method";
    qualifiedName = `${ownerName}.constructor`;
  } else {
    const name = ts.getNameOfDeclaration(declaration);
    if (name === undefined || !ts.isIdentifier(name)) return undefined;
    const owner = declaration.parent;
    const ownerName =
      (ts.isClassDeclaration(owner) ||
        ts.isInterfaceDeclaration(owner))
        ? owner.name?.text
        : undefined;
    const ownName = name.text;
    qualifiedName = ownerName === undefined ? ownName : `${ownerName}.${ownName}`;
    kind = inferNodeKind(declaration);
  }

  // Denetim bulgusu düzeltmesi: türetilen node kimliği bildirimin KENDİ
  // dosyasına aittir; çağıran dosyaya değil. Aksi halde aynı sembol için
  // çağıran dosya başına çoğaltma node'ları doğar. Guard (resolveSymbolRecord
  // içindeki ownRelativePathOf denetimi) set-dışı bildirimi buraya sokmaz.
  const declarationPath = ownRelativePathOf(context, declaration);
  if (
    kind === undefined ||
    qualifiedName === undefined ||
    declarationPath === undefined
  ) {
    return undefined;
  }
  return assembler.ensureNode({
    kind,
    qualifiedName,
    relativePath: declarationPath,
    language: LANGUAGE,
  });
}

function inferNodeKind(declaration: ts.Declaration): NodeKind | undefined {
  if (ts.isClassDeclaration(declaration)) return "Class";
  if (ts.isInterfaceDeclaration(declaration)) return "Interface";
  if (ts.isFunctionDeclaration(declaration)) return "Function";
  if (
    ts.isMethodDeclaration(declaration) ||
    ts.isMethodSignature(declaration) ||
    ts.isConstructorDeclaration(declaration)
  ) {
    return "Method";
  }
  return undefined;
}

/**
 * `<x>.<verb>("/path", handler)` kalıbını Endpoint + ROUTES_TO'ya çevirir.
 *
 * Sprint-2 B3 genelleştirme: `framework` verilirse (Express linker'ı)
 * Endpoint `framework` özniteliği taşır ve katkı linker toplayıcısına
 * yazılır. Kalıp önceden oluşturulmuşsa ensureNode/addEdge aynı node ve
 * kenarı döndürür — kanıt birleştirilir, çift kayıt oluşmaz. Jenerik faz
 * framework'süz çağırır; Faz A davranışı bit-bit korunur.
 */
function tryRoutePattern(
  context: AnalysisContext,
  entry: SourceEntry,
  sourceFile: ts.SourceFile,
  call: ts.CallExpression,
  framework?: FrameworkLinkerId,
): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!HTTP_VERBS.has(callee.name.text)) return false;
  if (call.arguments.length < 2) return false;
  const pathArg = call.arguments[0];
  if (pathArg === undefined || !ts.isStringLiteral(pathArg)) return false;
  if (!pathArg.text.startsWith("/")) return false;

  const assembler = context.assembler;
  const verb = callee.name.text.toUpperCase();
  const pathText = pathArg.text;
  const endpoint = assembler.ensureNode({
    kind: "Endpoint",
    qualifiedName: `${verb} ${pathText}`,
    relativePath: entry.relativePath,
    language: LANGUAGE,
    attributes:
      framework === undefined
        ? { method: verb, path: pathText }
        : { method: verb, path: pathText, framework },
  });
  if (framework !== undefined) {
    context.framework.nodeKeys.add(endpoint.key);
  }

  const handlerArg = call.arguments[1];
  if (handlerArg === undefined) return true;
  if (!ts.isIdentifier(handlerArg) && !ts.isPropertyAccessExpression(handlerArg)) {
    assembler.addWarning(
      `Route handler modellenmedi: ${entry.relativePath} '${verb} ${pathText}' (inline/anonymous handler unsupportedConstructs kapsamında)`,
    );
    return true;
  }

  const handlerSymbol = context.checker.getSymbolAtLocation(handlerArg);
  const handlerDeclaration = handlerSymbol?.getDeclarations()?.[0];
  const handlerRecord = resolveSymbolRecord(
    context,
    entry,
    handlerSymbol,
    handlerDeclaration,
  );

  /** ROUTES_TO ekler; framework linker koşusunda katkıyı toplayıcıya yazar. */
  const addRouteEdge = (to: NodeRecord, evidence: SnapshotEvidenceInput): void => {
    const record = assembler.addEdge({
      kind: "ROUTES_TO",
      from: endpoint,
      to,
      resolution: "verified",
      evidence,
    });
    if (framework !== undefined) {
      context.framework.edges.push(record);
    }
  };

  if (handlerRecord !== undefined) {
    addRouteEdge(
      handlerRecord,
      evidenceFor(
        entry,
        sourceFile,
        call,
        "route-attribute",
        `ROUTES_TO: '${verb} ${pathText}' route kaydı ${handlerRecord.node.qualifiedName} handler'ına TypeChecker ile çözümlendi.`,
      ),
    );
    return true;
  }

  if (handlerSymbol !== undefined && (handlerDeclaration !== undefined)) {
    // Handler analiz setinin dışında bildirildi: açık external node.
    const externalHandler = assembler.ensureNode({
      kind: "UnknownExternal",
      qualifiedName: handlerSymbol.getName(),
    });
    addRouteEdge(
      externalHandler,
      evidenceFor(
        entry,
        sourceFile,
        call,
        "route-attribute",
        `ROUTES_TO: '${verb} ${pathText}' route kaydındaki handler analiz seti dışındaki ${handlerSymbol.getName()} sembolüne çözümlendi; açık UnknownExternal node kullanıldı.`,
      ),
    );
    return true;
  }

  assembler.addWarning(
    `ROUTES_TO çözümlenemedi: ${entry.relativePath} '${verb} ${pathText}' -> handler sembolü bulunamadı (Endpoint node'u korundu, kenar üretilmedi)`,
  );
  return true;
}

/** Çağrı/new ifadesini CALLS kenarına çevirir; uydurma hedef üretmez. */
function emitCallEdge(
  context: AnalysisContext,
  entry: SourceEntry,
  sourceFile: ts.SourceFile,
  call: ts.CallExpression | ts.NewExpression,
  caller: NodeRecord | undefined,
): void {
  if (caller === undefined) return; // modül üstü çağrılar bu dilimde modellenmez

  const assembler = context.assembler;
  const checker = context.checker;
  // Denetim bulgusu düzeltmesi (instantiation): `new X()` için çözümlenen
  // imza ctor üyesine/iç yapısına işaret eder; instantiation'ın modellediği
  // hedef sınıfın KENDİSİ olduğundan sembol doğrudan ifadeden alınır.
  // Import alias'ı resolveSymbolRecord içinde hedef sembole çevrilir.
  const isNew = ts.isNewExpression(call);
  const signature = isNew ? undefined : checker.getResolvedSignature(call);
  const declaration = signature?.declaration;
  const targetSymbol = isNew
    ? checker.getSymbolAtLocation(call.expression)
    : declaration !== undefined
      ? checker.getSymbolAtLocation(ts.getNameOfDeclaration(declaration) ?? declaration)
      : checker.getSymbolAtLocation(call.expression);

  const registryHit = resolveSymbolRecord(
    context,
    entry,
    targetSymbol ?? undefined,
    declaration ?? undefined,
  );
  if (registryHit !== undefined) {
    assembler.addEdge({
      kind: "CALLS",
      from: caller,
      to: registryHit,
      resolution: "verified",
      evidence: evidenceFor(
        entry,
        sourceFile,
        call,
        "semantic-symbol",
        `CALLS: ${caller.node.qualifiedName} içindeki çağrı ifadesi TypeChecker ile ${registryHit.node.qualifiedName} sembolüne çözümlendi (verified).`,
      ),
    });
    if (caller.node.kind === "Test" && registryHit.node.kind !== "Test") {
      assembler.addEdge({
        kind: "TESTS",
        from: caller,
        to: registryHit,
        resolution: "verified",
        evidence: evidenceFor(
          entry,
          sourceFile,
          call,
          "semantic-symbol",
          `TESTS: ${caller.node.qualifiedName} testi içindeki çağrı ifadesi TypeChecker ile ${registryHit.node.qualifiedName} sembolüne çözümlendi (verified).`,
        ),
      });
    }
    return;
  }

  if (targetSymbol !== undefined && (targetSymbol.getDeclarations()?.length ?? 0) > 0) {
    // Analiz setinin dışında bildirilen sembol (lib/node_modules): açık
    // UnknownExternal node + checker dayanaklı verified kenar.
    const externalName = externalQualifiedName(targetSymbol, declaration);
    const externalNode = assembler.ensureNode({
      kind: "UnknownExternal",
      qualifiedName: externalName,
    });
    assembler.addEdge({
      kind: "CALLS",
      from: caller,
      to: externalNode,
      resolution: "verified",
      evidence: evidenceFor(
        entry,
        sourceFile,
        call,
        "semantic-symbol",
        `CALLS: ${caller.node.qualifiedName} içindeki çağrı analiz seti dışındaki ${externalName} sembolüne çözümlendi; dış kaynak açık UnknownExternal node olarak temsil edildi.`,
      ),
    });
    return;
  }

  // Hiç çözümlenemedi: uydurma sembol YOK; açık UnknownExternal + unresolved.
  const callText = call.expression.getText(sourceFile).trim();
  const unresolvedNode = assembler.ensureNode({
    kind: "UnknownExternal",
    qualifiedName: callText,
  });
  assembler.addEdge({
    kind: "CALLS",
    from: caller,
    to: unresolvedNode,
    resolution: "unresolved",
    evidence: evidenceFor(
      entry,
      sourceFile,
      call,
      "ast-span",
      `CALLS: ${caller.node.qualifiedName} içindeki '${callText}' çağrısı çözümlenemedi; uydurma hedef yerine açık UnknownExternal node üzerinde unresolved işaretlendi.`,
    ),
  });
  assembler.addWarning(
    `CALLS çözümlenemedi: ${entry.relativePath} '${callText}' (unresolved, UnknownExternal node üretildi)`,
  );
}

function externalQualifiedName(
  symbol: ts.Symbol,
  declaration: ts.Declaration | undefined,
): string {
  const owner = declaration?.parent;
  if (
    owner !== undefined &&
    (ts.isClassDeclaration(owner) ||
      ts.isInterfaceDeclaration(owner) ||
      ts.isClassExpression(owner)) &&
    owner.name !== undefined
  ) {
    return `${owner.name.text}.${symbol.getName()}`;
  }
  return symbol.getName();
}

/* ------------------------------------------------------------------ */
/* Faz 2.5: framework linker'ları (sprint-2 B3, TŞ §7 L3)              */
/*                                                                     */
/* İki linker vardır ve ikisi de uydurma disiplinine tabidir:          */
/* - Express : import specifier'ı tam "express" olan dosya varsa        */
/*   framework algılanır; `<app|router>.<verb>("/path", handler)`       */
/*   kayıtları jenerik route fazıyla AYNI shared helper üzerinden      */
/*   Endpoint (framework öznitelikli) + ROUTES_TO üretir.              */
/* - Next.js : App Router dosya kuralı (app/**\/route.ts fiil exportları,*/
/*   app/**\/page.tsx default export). Yol türetimi yalnızca dosya     */
/*   yolundan yapılır; handler sembolü TypeChecker/registry ile        */
/*   çözümlenir; tanınmayan kalıpta node icat EDİLMEZ, tanı notu düşer.*/
/* ------------------------------------------------------------------ */

/** Express framework tespiti: herhangi bir dosyada tam "express" importu. */
function detectExpressFramework(
  entries: readonly SourceEntry[],
): FrameworkDetection | undefined {
  const basis: string[] = [];
  for (const entry of entries) {
    const sourceFile = entry.sourceFile;
    if (sourceFile === undefined) continue;
    for (const specifier of collectModuleSpecifiers(sourceFile)) {
      if (specifier.text === "express") {
        basis.push(`import:express@${entry.relativePath}`);
        break;
      }
    }
  }
  if (basis.length === 0) return undefined;
  return { framework: "express", basis: [...basis].sort() };
}

/**
 * Next.js framework tespiti: App Router dosya kuralı. `app/` veya
 * `src/app/` altındaki route/page kural dosyaları dayanak listelenir.
 */
function detectNextAppRouterFramework(
  entries: readonly SourceEntry[],
): FrameworkDetection | undefined {
  const basis: string[] = [];
  for (const entry of entries) {
    if (nextAppConvention(entry.relativePath) !== undefined) {
      basis.push(`file-convention:${entry.relativePath}`);
    }
  }
  if (basis.length === 0) return undefined;
  return { framework: "nextjs", basis: [...basis].sort() };
}

/**
 * Dosya yolundan App Router kuralı türetir: `app/` (veya `src/app/`)
 * segmentinden sonraki segmentler route yoludur; kök kural dosyası "/"
 * olur. Dinamik segmentler (`[id]`) olduğu gibi korunur.
 */
function nextAppConvention(
  relativePath: string,
): { readonly kind: "route" | "page"; readonly routePath: string } | undefined {
  const segments = toPosix(relativePath).split("/");
  if (segments.length < 2) return undefined;
  const appIndex =
    segments[0] === "src" && segments[1] === "app"
      ? 1
      : segments[0] === "app"
        ? 0
        : -1;
  if (appIndex < 0) return undefined;
  const base = segments[segments.length - 1] ?? "";
  const kind =
    base === "route.ts" || base === "route.tsx"
      ? "route"
      : base === "page.ts" || base === "page.tsx"
        ? "page"
        : undefined;
  if (kind === undefined) return undefined;
  const routeSegments = segments.slice(appIndex + 1, -1);
  const routePath =
    routeSegments.length === 0 ? "/" : `/${routeSegments.join("/")}`;
  return { kind, routePath };
}

/**
 * Dosya içinde Express instance'ına bağlanan değişken adlarını toplar:
 * `const x = express()`, `const x = express.Router()` ve `const x = Router()`
 * (Router "express" specifier'ından isimli import edildiyse). Denetim
 * bulgusu 2 düzeltmesi: framework etiketi yalnızca bu receiver'ların
 * kayıtlarına yazılır — proje-geneli değil.
 */
function collectExpressInstanceVars(
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const instanceVars = new Set<string>();
  let defaultBinding: string | undefined;
  const namedBindings = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleSpecifier = statement.moduleSpecifier;
    if (
      moduleSpecifier === undefined ||
      !ts.isStringLiteralLike(moduleSpecifier) ||
      moduleSpecifier.text !== "express"
    ) {
      continue;
    }
    const importClause = statement.importClause;
    if (importClause === undefined) continue;
    if (importClause.name !== undefined) {
      defaultBinding = importClause.name.text;
    }
    const named = importClause.namedBindings;
    if (named !== undefined && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        namedBindings.add(element.name.text);
      }
    }
  }
  if (defaultBinding === undefined && namedBindings.size === 0) {
    return instanceVars;
  }

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      if (initializer !== undefined && ts.isCallExpression(initializer)) {
        const callee = initializer.expression;
        const isDefaultCall =
          defaultBinding !== undefined &&
          ts.isIdentifier(callee) &&
          callee.text === defaultBinding;
        const isDefaultRouterMember =
          defaultBinding !== undefined &&
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === defaultBinding &&
          callee.name.text === "Router";
        const isNamedRouterCall =
          ts.isIdentifier(callee) && namedBindings.has(callee.text);
        if (isDefaultCall || isDefaultRouterMember || isNamedRouterCall) {
          instanceVars.add(node.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return instanceVars;
}

/**
 * Express linker geçişi: yalnızca Express instance receiver'lı
 * `<app|router>.<verb>("/path", handler)` kayıtları framework etiketiyle
 * jenerik route helper'ına verilir (denetim bulgusu 2). Diğer verb kalıpları
 * linker'dan geçmez; Faz A jenerik fazı bunları etiketsiz üretmeye devam
 * eder. Cross-file receiver (import edilen app instance) bu dilimde
 * modellenmez — jenerik üretim etkilenmez, yalnızca etiket eksik kalır.
 */
function collectExpressRoutes(
  context: AnalysisContext,
  entry: SourceEntry,
  sourceFile: ts.SourceFile,
): void {
  const expressInstanceVars = collectExpressInstanceVars(sourceFile);
  if (expressInstanceVars.size === 0) return;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        expressInstanceVars.has(callee.expression.text)
      ) {
        tryRoutePattern(context, entry, sourceFile, node, "express");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/** Next.js linker geçişi: kural dosyasına göre route/page çıkarımı. */
function collectNextAppRouterRoutes(
  context: AnalysisContext,
  entry: SourceEntry,
  sourceFile: ts.SourceFile,
): void {
  const convention = nextAppConvention(entry.relativePath);
  if (convention === undefined) return;
  if (convention.kind === "route") {
    collectNextRouteHandlers(context, entry, sourceFile, convention.routePath);
  } else {
    collectNextPageHandler(context, entry, sourceFile, convention.routePath);
  }
}

function hasModifierOfKind(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

/** Bildirim satırı (1 tabanlı); dosya boşsa 1. Tanı notlarında kullanılır. */
function firstStatementLine(
  sourceFile: ts.SourceFile,
): number {
  const first = sourceFile.statements[0];
  return first === undefined
    ? 1
    : sourceFile.getLineAndCharacterOfPosition(first.getStart(sourceFile)).line + 1;
}

/** Route/page kural dosyasındaki exportu Endpoint + ROUTES_TO'ya bağlar. */
function emitNextRouteEdge(
  context: AnalysisContext,
  entry: SourceEntry,
  sourceFile: ts.SourceFile,
  anchor: ts.Node,
  handlerRecord: NodeRecord,
  method: string,
  routePath: string,
): void {
  const endpoint = context.assembler.ensureNode({
    kind: "Endpoint",
    qualifiedName: `${method} ${routePath}`,
    relativePath: entry.relativePath,
    language: LANGUAGE,
    attributes: { method, path: routePath, framework: "nextjs" },
  });
  context.framework.nodeKeys.add(endpoint.key);
  const edge = context.assembler.addEdge({
    kind: "ROUTES_TO",
    from: endpoint,
    to: handlerRecord,
    resolution: "verified",
    evidence: evidenceFor(
      entry,
      sourceFile,
      anchor,
      "route-attribute",
      `ROUTES_TO: '${method} ${routePath}' Next.js App Router kural exportu (${entry.relativePath}) ${handlerRecord.node.qualifiedName} sembolüne TypeChecker ile çözümlendi.`,
    ),
  });
  context.framework.edges.push(edge);
}

/**
 * route.ts fiil exportları: `export function GET(...)` / `export const GET
 * = ...` biçimindeki HTTP fiil adlı exportlar route handler'dır. Hiç tanınan
 * fiil exportu yoksa kenar üretilmez ve tanı notu düşer (uydurma yasak).
 */
function collectNextRouteHandlers(
  context: AnalysisContext,
  entry: SourceEntry,
  sourceFile: ts.SourceFile,
  routePath: string,
): void {
  const { assembler } = context;
  let verbExports = 0;

  const handlerRecordOf = (name: ts.Identifier): NodeRecord | undefined => {
    const symbol = context.checker.getSymbolAtLocation(name);
    const declaration = symbol?.getDeclarations()?.[0];
    return resolveSymbolRecord(context, entry, symbol, declaration);
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      hasModifierOfKind(statement, ts.SyntaxKind.ExportKeyword)
    ) {
      const name = statement.name;
      if (name === undefined || !HTTP_VERBS.has(name.text.toLowerCase())) continue;
      const record = handlerRecordOf(name);
      if (record === undefined) {
        assembler.addWarning(
          `Next.js route handler çözümlenemedi: ${entry.relativePath} '${name.text}' (kenar üretilmedi)`,
        );
        continue;
      }
      verbExports += 1;
      emitNextRouteEdge(
        context,
        entry,
        sourceFile,
        statement,
        record,
        name.text.toUpperCase(),
        routePath,
      );
      continue;
    }

    if (
      ts.isVariableStatement(statement) &&
      hasModifierOfKind(statement, ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        if (!HTTP_VERBS.has(declaration.name.text.toLowerCase())) continue;
        const record = handlerRecordOf(declaration.name);
        if (record === undefined) {
          assembler.addWarning(
            `Next.js route handler çözümlenemedi: ${entry.relativePath} '${declaration.name.text}' (kenar üretilmedi)`,
          );
          continue;
        }
        verbExports += 1;
        emitNextRouteEdge(
          context,
          entry,
          sourceFile,
          statement,
          record,
          declaration.name.text.toUpperCase(),
          routePath,
        );
      }
      continue;
    }
  }

  if (verbExports === 0) {
    context.framework.diagnostics.push({
      relativePath: entry.relativePath,
      code: "FRAMEWORK_PATTERN_UNKNOWN",
      message: `Next.js App Router kural dosyası ('${entry.relativePath}') tanınan HTTP fiil exportu içermiyor (beklenen: export function GET|POST|... veya export const GET = ...); kenar üretilmedi, node icat edilmedi.`,
      line: firstStatementLine(sourceFile),
    });
  }
}

/**
 * page.tsx default exportu: `export default function Name(...)` /
 * `export default Name` sembolü registry/TypeChecker ile çözümlenir ve
 * `GET <routePath>` Endpoint'ine bağlanır. Anonim default export için sembol
 * icat EDİLMEZ; tanı notu düşer.
 */
function collectNextPageHandler(
  context: AnalysisContext,
  entry: SourceEntry,
  sourceFile: ts.SourceFile,
  routePath: string,
): void {
  let handlerRecord: NodeRecord | undefined;
  let anchor: ts.Node | undefined;
  let defaultExportSeen = false;

  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      hasModifierOfKind(statement, ts.SyntaxKind.DefaultKeyword)
    ) {
      defaultExportSeen = true;
      anchor = statement;
      const name = statement.name;
      if (name !== undefined && ts.isIdentifier(name)) {
        const symbol = context.checker.getSymbolAtLocation(name);
        const declaration = symbol?.getDeclarations()?.[0];
        handlerRecord = resolveSymbolRecord(context, entry, symbol, declaration);
      }
      break;
    }
    if (ts.isExportAssignment(statement)) {
      defaultExportSeen = true;
      anchor = statement;
      if (ts.isIdentifier(statement.expression)) {
        const symbol = context.checker.getSymbolAtLocation(statement.expression);
        const declaration = symbol?.getDeclarations()?.[0];
        handlerRecord = resolveSymbolRecord(context, entry, symbol, declaration);
      }
      break;
    }
  }

  if (handlerRecord !== undefined && anchor !== undefined) {
    emitNextRouteEdge(
      context,
      entry,
      sourceFile,
      anchor,
      handlerRecord,
      "GET",
      routePath,
    );
    return;
  }

  context.framework.diagnostics.push({
    relativePath: entry.relativePath,
    code: "FRAMEWORK_PATTERN_UNKNOWN",
    message: defaultExportSeen
      ? `Next.js App Router sayfa dosyası ('${entry.relativePath}') isimsiz/anonim default export içeriyor; sembol icat edilmez, kenar üretilmedi.`
      : `Next.js App Router sayfa dosyası ('${entry.relativePath}') tanınan default export içermiyor; kenar üretilmedi, node icat edilmedi.`,
    line: firstStatementLine(sourceFile),
  });
}

/* ------------------------------------------------------------------ */
/* Standalone TypeScript lib*.d.ts dizin çözümlemesi                   */
/* ------------------------------------------------------------------ */

function createCompilerHostWithDefaultLib(
  compilerOptions: ts.CompilerOptions,
): ts.CompilerHost {
  const host = ts.createCompilerHost(compilerOptions, /*setParentNodes*/ true);
  const resolvedLibDir = resolveTypeScriptLibDir();
  if (resolvedLibDir !== undefined) {
    host.getDefaultLibLocation = () => resolvedLibDir;
    host.getDefaultLibFileName = (opts) =>
      joinLibPosix(resolvedLibDir, ts.getDefaultLibFileName(opts));
  }
  return host;
}

type ProcessEnvMap = Readonly<Record<string, string | undefined>>;

export interface ResolveTypeScriptLibDirOptions {
  readonly importMetaUrl?: string;
  readonly env?: ProcessEnvMap;
}

function readDefaultProcessEnv(): ProcessEnvMap {
  const proc = (
    globalThis as { readonly process?: { readonly env?: ProcessEnvMap } }
  ).process;
  return proc?.env ?? {};
}

function normalizeLibDirPosix(rawPath: string): string {
  const posix = toPosix(rawPath);
  if (posix === "/" || /^[a-zA-Z]:\/$/.test(posix)) {
    return posix;
  }
  if (/^[a-zA-Z]:$/.test(posix)) {
    return `${posix}/`;
  }
  return posix.replace(/\/+$/, "");
}

function joinLibPosix(base: string, child: string): string {
  return base.endsWith("/") ? `${base}${child}` : `${base}/${child}`;
}

function parentLibPosixDir(dir: string): string {
  if (dir === "/" || /^[a-zA-Z]:\/$/.test(dir)) {
    return dir;
  }
  if (/^[a-zA-Z]:$/.test(dir)) {
    return `${dir}/`;
  }
  const trimmed = dir.replace(/\/+$/, "");
  const slashIdx = trimmed.lastIndexOf("/");
  if (slashIdx < 0) {
    return ".";
  }
  if (slashIdx === 0) {
    return "/";
  }
  if (slashIdx === 2 && /^[a-zA-Z]:/.test(trimmed)) {
    return `${trimmed.slice(0, 2)}/`;
  }
  return trimmed.slice(0, slashIdx);
}

function safeDecodeUriComponent(raw: string): string {
  return raw.replace(/(?:%[0-9A-Fa-f]{2})+/g, (encodedRun) => {
    try {
      return decodeURIComponent(encodedRun);
    } catch {
      return encodedRun;
    }
  });
}

function fileUrlToPosixPath(urlOrPath: string): string {
  if (!urlOrPath.startsWith("file://")) {
    return normalizeLibDirPosix(ts.sys.resolvePath(urlOrPath));
  }
  const withoutScheme = urlOrPath.slice("file://".length);
  const slashIdx = withoutScheme.indexOf("/");
  if (slashIdx < 0) {
    return "/";
  }
  const authority = safeDecodeUriComponent(withoutScheme.slice(0, slashIdx));
  const decodedPath = safeDecodeUriComponent(withoutScheme.slice(slashIdx));
  if (authority.length > 0 && authority !== "localhost") {
    return normalizeLibDirPosix(`//${authority}${decodedPath}`);
  }
  if (/^\/[a-zA-Z]:(\/|$)/.test(decodedPath)) {
    return normalizeLibDirPosix(decodedPath.slice(1));
  }
  return normalizeLibDirPosix(decodedPath);
}

/**
 * Paketlenmiş (node_modules dışı) ve monorepo ortamlarında TypeScript
 * yerleşik `lib.*.d.ts` dizinini çözümler (K-021 §5.2.B).
 */
export function resolveTypeScriptLibDir(
  options?: ResolveTypeScriptLibDirOptions,
): string | undefined {
  const env = options?.env ?? readDefaultProcessEnv();
  const override = env["CAUSORYN_TS_LIB_DIR"]?.trim();
  if (override !== undefined && override.length > 0) {
    const resolvedOverride = normalizeLibDirPosix(ts.sys.resolvePath(override));
    if (
      ts.sys.fileExists(joinLibPosix(resolvedOverride, "lib.es2022.full.d.ts"))
    ) {
      return resolvedOverride;
    }
  }

  const metaUrl =
    options?.importMetaUrl ??
    (import.meta as { readonly url?: string }).url;
  if (metaUrl === undefined || metaUrl.length === 0) {
    return undefined;
  }
  const entryPath = fileUrlToPosixPath(metaUrl);
  let dir = parentLibPosixDir(entryPath);
  for (let depth = 0; depth <= 4; depth += 1) {
    const candidates = [
      joinLibPosix(dir, "typescript-lib"),
      joinLibPosix(dir, "dist/typescript-lib"),
      joinLibPosix(dir, "node_modules/typescript/lib"),
    ];
    for (const candidate of candidates) {
      if (ts.sys.fileExists(joinLibPosix(candidate, "lib.es2022.full.d.ts"))) {
        return candidate;
      }
    }
    const parent = parentLibPosixDir(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return undefined;
}
