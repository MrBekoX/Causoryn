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
  type TypeScriptAnalysisRun, type TypeScriptIncrementalAnalysisRun, type TypeScriptIncrementalState,
  type TsAdapterSourceFile,
} from "./types.js";
import {
  buildProgramCompilerOptions, expandCandidatePaths, loadPackageModuleScopes,
  loadWorkspacePackages, loadWorkspaceTsConfigs, type PackageModuleScope,
  resolveScopedModuleName, type ScopedTsConfig, type WorkspacePackageManifest,
} from "./tsconfig-loader.js";

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

type SourceLanguage = "typescript" | "javascript";

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
  const posix = toPosix(stripWindowsExtendedPrefix(p));
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
  const segments = base === "" || base === "." ? [] : base.split("/").filter((s) => s !== "" && s !== ".");
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return "";
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
      `Absolute source paths are not accepted: ${raw}`,
    );
  }
  for (const segment of posix.split("/")) {
    if (segment === "" || segment === ".") {
      throw new DomainError(
        "adapter/invalid-source-path",
        `Source path contains an empty or invalid segment: ${raw}`,
      );
    }
    if (segment === "..") {
      throw new DomainError(
        "adapter/source-path-escape",
        `Source path escapes the root: ${raw}`,
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
  readonly language: SourceLanguage;
  readonly content: string;
  readonly sourceHash: string;
  sourceFile?: ts.SourceFile;
}

interface NodeRecord {
  readonly key: string;
  node: SnapshotNodeInput;
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
    location?: SnapshotNodeInput["location"];
  }): NodeRecord {
    const key = this.nodeKey(input.kind, input.qualifiedName, input.relativePath);
    const existing = this.nodes.get(key);
    if (existing !== undefined) return withLocation(existing, input.location);
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
    return withLocation(record, input.location);
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
  readonly resolveModule: (moduleName: string, containingFile: string) => ts.ResolvedModuleFull | undefined;
  readonly checker: ts.TypeChecker;
  readonly entries: Map<string, SourceEntry>;
  readonly entryByRelativePath: Map<string, SourceEntry>;
  readonly assembler: GraphAssembler;
  readonly registry: Map<ts.Symbol, NodeRecord>;
  readonly declarationNodes: Map<ts.ClassLikeDeclaration | ts.InterfaceDeclaration, NodeRecord>;
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
type AnalysisRun = TypeScriptIncrementalAnalysisRun;

function runAnalysis(input: TypeScriptAdapterInput): AnalysisRun {
  if (input.workspaceId.trim().length === 0) {
    throw new DomainError("adapter/empty-workspace-id", "workspaceId must not be empty");
  }
  const rootPosix = normalizeRootPosix(input.rootDir);
  // Mutlaklık: POSIX ("/...") veya Windows sürücü harfi ("D:/...").
  const isAbsolute = rootPosix.startsWith("/") || /^[a-zA-Z]:\//.test(rootPosix);
  if (!isAbsolute) {
    throw new DomainError(
      "adapter/invalid-root-dir",
      `rootDir must be an absolute directory: ${input.rootDir}`,
    );
  }

  // 1) Kaynakları normalize et, sırala, çakışmayı reddet (determinizm).
  const entries = new Map<string, SourceEntry>();
  const entryByRelativePath = new Map<string, SourceEntry>();
  for (const source of input.sources as readonly TsAdapterSourceFile[]) {
    const relativePath = normalizeRelativePath(source.relativePath);
    const absolutePath = normalizePosixPath(joinRootAndRelative(rootPosix, relativePath));
    const absoluteKey = canonicalPath(absolutePath);
    if (entries.has(absoluteKey) || entryByRelativePath.has(relativePath)) {
      throw new DomainError(
        "adapter/duplicate-source-path",
        `The same source path was given twice: ${source.relativePath}`,
      );
    }
    const entry: SourceEntry = {
      relativePath,
      absolutePath,
      absoluteKey,
      language: languageForPath(relativePath),
      content: source.content,
      sourceHash: sha256Hex(utf8Encode(source.content)),
    };
    entries.set(absoluteKey, entry);
    entryByRelativePath.set(relativePath, entry);
  }
  const sortedEntries = [...entryByRelativePath.values()].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : 1,
  );

  // 1.5) Güvenli, salt-okunur tsconfig.json / jsconfig.json + monorepo package.json yüklemesi.
  const loadedConfigs = loadWorkspaceTsConfigs(
    rootPosix,
    input.configFiles,
    input.configFiles === undefined ? input.rootDir : undefined,
    sortedEntries.map((entry) => entry.relativePath),
  );
  const loadedPackages = loadWorkspacePackages(
    rootPosix,
    input.packageFiles,
    input.packageFiles === undefined ? input.rootDir : undefined,
    sortedEntries.map((entry) => entry.relativePath),
  );
  const moduleFormat = loadModuleFormatScopes(input, rootPosix, sortedEntries);
  const compilerOptions = buildProgramCompilerOptions(loadedConfigs.configs);
  const resolvedLibDir = resolveTypeScriptLibDir();
  const host = createCompilerHostWithDefaultLib(compilerOptions, resolvedLibDir);
  /**
   * SEC-04: CompilerHost + ModuleResolutionHost disk fallback'i kesinlikle
   * sınırlandırılır — `entries` (WorkspaceAccessPolicy izinli kaynaklar)
   * dışındaki workspace dosyaları (.env.js, ../outside-secret.js, symlink,
   * bundle vb.) diskten ASLA okunmaz.
   */
  const resolutionHost = configureConfinedCompilerHost(
    host,
    entries,
    rootPosix,
    resolvedLibDir,
    moduleFormat.projections,
  );
  const resolveOne = (
    moduleName: string,
    containingFile: string,
  ): ts.ResolvedModuleFull | undefined => resolveScopedModuleName({
    moduleName,
    containingFile,
    rootPosix,
    ...(resolvedLibDir === undefined ? {} : { allowedLibDir: resolvedLibDir }),
    programOptions: compilerOptions,
    configs: loadedConfigs.configs,
    workspacePackages: loadedPackages.packages,
    resolutionHost,
    entries,
  });
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

  // 3) Program + TypeChecker (TŞ §7: TypeScript Compiler API) + incremental oldProgram.
  const { program, optionsSignature } = createProgramWithIncrementalReuse({
    input, rootPosix, compilerOptions, loadedConfigs: loadedConfigs.configs, moduleScopes: moduleFormat.scopes,
    workspacePackages: loadedPackages.packages, host, entries, sortedEntries, resolvedLibDir,
  });
  const checker = program.getTypeChecker();
  for (const sourceFile of program.getSourceFiles()) {
    const hit = entries.get(canonicalPath(sourceFile.fileName));
    if (hit !== undefined) hit.sourceFile = sourceFile;
  }

  const assembler = new GraphAssembler(input.workspaceId);
  for (const warning of [...loadedConfigs.warnings, ...loadedPackages.warnings, ...moduleFormat.warnings]) assembler.addWarning(warning);
  const context: AnalysisContext = {
    workspaceId: input.workspaceId,
    compilerOptions,
    resolutionHost,
    resolveModule: resolveOne,
    checker,
    entries,
    entryByRelativePath,
    assembler,
    registry: new Map<ts.Symbol, NodeRecord>(),
    declarationNodes: new Map<ts.ClassLikeDeclaration | ts.InterfaceDeclaration, NodeRecord>(),
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

  // File node'ları (deterministik: sıralı girdi, dosya uzantısına göre dil).
  for (const entry of sortedEntries) {
    assembler.ensureNode({
      kind: "File",
      qualifiedName: entry.relativePath,
      relativePath: entry.relativePath,
      language: entry.language,
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
        message: "The TypeScript program produced no SourceFile for this source",
        line: 0,
      });
      return;
    }
    // Untyped JS dosyalarında (checkJs: false) sahte TS tip-denetimi
    // gürültüsü üretilmez; bozuk JS sözdizimi syntactic tanılarla dürüstçe yakalanır.
    const all =
      entry.language === "javascript"
        ? [...program.getSyntacticDiagnostics(sourceFile)]
        : [
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
    runPhase(entry, (sourceFile) => extractHeritageClauses(context, entry, sourceFile));
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

  return buildAnalysisRunWithIncrementalState({
    diagnostics,
    capabilities,
    coverageRatio,
    assembler,
    nodeInputs,
    edgeInputs,
    context,
    frameworkNodes,
    byEdgeKey,
    program,
    sortedEntries,
    optionsSignature,
  });
}

/**
 * TypeScript Language Adapter ana girişi: tam graph (framework kenarları
 * dahil) döner. `nextIncrementalState` non-enumerable olarak eklenir.
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
  const run = runAnalysis(input);
  return attachNonEnumerableIncrementalState(
    { result: run.result, framework: run.framework },
    run.nextIncrementalState,
  );
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
    span: declarationSpan(entry, sourceFile, node),
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
    const evidence = evidenceFor(entry, sourceFile, node, "ast-span", rationale);
    assembler.addEdge({
      kind: "CONTAINS",
      from,
      to,
      resolution: "verified",
      evidence,
    });
    withLocation(to, evidence.span);
  };

  const registerMembers = (
    statement: ts.ClassLikeDeclaration | ts.InterfaceDeclaration,
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
        language: entry.language,
      });
      registerWithSymbol(symbolOfDeclaration(member), memberRecord);
      addContains(
        ownerRecord,
        memberRecord,
        member,
        `CONTAINS: member ${memberName} of the ${ownerRecord.node.qualifiedName} ${ownerKind.toLowerCase()} declaration, matched by AST span evidence.`,
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
        language: entry.language,
      });
      registerWithSymbol(symbolOfDeclaration(statement), record);
      context.declarationNodes.set(statement, record);
      addContains(
        fileNode,
        record,
        statement,
        `CONTAINS: ${kind.toLowerCase()} declaration ${name} in ${entry.relativePath}, matched by AST span evidence.`,
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
        language: entry.language,
      });
      registerWithSymbol(symbolOfDeclaration(statement), record);
      addContains(
        fileNode,
        record,
        statement,
        `CONTAINS: function declaration ${name} in ${entry.relativePath}, matched by AST span evidence.`,
      );
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        // CommonJS import bağlaması (`const express = require("express")`)
        // yerel Handler bildirimi değildir.
        if (isStaticRequireCall(declaration.initializer) !== undefined) continue;
        if (tryRegisterClassExpression(context, entry, statement, declaration, fileNode, addContains, registerWithSymbol, registerMembers)) continue;
        // Call signature'lı tip = handler değeri → Handler node'u
        // (ör. const ordersRoute = createOrdersRoute(ordersService)).
        const type = checker.getTypeAtLocation(declaration.name);
        if (type.getCallSignatures().length === 0) continue;
        const record = assembler.ensureNode({
          kind: "Handler",
          qualifiedName: declaration.name.text,
          relativePath: entry.relativePath,
          language: entry.language,
        });
        registerWithSymbol(
          checker.getSymbolAtLocation(declaration.name),
          record,
        );
        addContains(
          fileNode,
          record,
          statement,
          `CONTAINS: handler binding ${declaration.name.text} in ${entry.relativePath}, matched by AST span evidence.`,
        );
      }
      continue;
    }

    extractCjsExportStatement(
      context,
      entry,
      statement,
      fileNode,
      addContains,
      registerWithSymbol,
    );
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
  for (const ext of [".tsx", ".ts", ".mts", ".cts", ".jsx", ".js", ".mjs", ".cjs"]) {
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
          language: entry.language,
        });
        addContains(
          fileNode,
          testRecord,
          node,
          `CONTAINS: test definition '${qualifiedName}' in ${entry.relativePath}, matched by AST span evidence.`,
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
  const resolved = context.resolveModule(
    specifier, containingAbsoluteKey,
  );
  if (resolved === undefined) return { status: "unresolved" };
  const target = context.entries.get(canonicalPath(resolved.resolvedFileName));
  if (target !== undefined) {
    return { status: "internal", targetRelativePath: target.relativePath };
  }
  return { status: "external", builtin: false };
}

/** ESM import/export-from ve statik CommonJS `require("...")` specifier'larını toplar. */
function collectModuleSpecifiers(sourceFile: ts.SourceFile): Array<{ node: ts.StringLiteralLike; text: string }> {
  const specifiers: Array<{ node: ts.StringLiteralLike; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
        specifiers.push({ node: node.moduleSpecifier, text: node.moduleSpecifier.text });
      }
      return;
    }
    const reqArg = isStaticRequireCall(node);
    if (reqArg !== undefined) specifiers.push({ node: reqArg, text: reqArg.text });
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
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
          `IMPORTS: '${specifier.text}' in ${entry.relativePath} was resolved by the TypeChecker to ${record.targetRelativePath}.`,
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
            `IMPORTS: '${specifier.text}' was classified as a Node.js core module by a known rule (heuristic); the external source is represented as an explicit UnknownExternal node.`,
          ),
          ambiguity: {
            candidates: [specifier.text],
            reason: "Node.js builtin classification; no semantic resolution.",
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
          `IMPORTS: '${specifier.text}' in ${entry.relativePath} resolved to a module outside the analysis set; the external source is represented as an explicit UnknownExternal node.`,
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
          `IMPORTS: '${specifier.text}' was not resolved by the TypeChecker; the relative candidate path ${candidate} matched inside the analysis set (heuristic).`,
        ),
        ambiguity: {
          candidates: [candidate],
          reason: "The TypeChecker did not resolve the module; file-path candidate match.",
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
        `IMPORTS: '${specifier.text}' could not be resolved; marked unresolved on an explicit UnknownExternal node instead of inventing a target.`,
      ),
    });
    assembler.addWarning(
      `IMPORTS unresolved: ${entry.relativePath} -> '${specifier.text}' (unresolved, UnknownExternal node created)`,
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
  if (joined.length === 0) return undefined;
  for (const candidate of expandCandidatePaths(joined)) {
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
      if (!context.testBlockCalls.has(node) && isStaticRequireCall(node) === undefined) {
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
        : resolveClassExpressionOwnerName(context, owner);
    const qualifiedName =
      ownerName === undefined ? name.text : `${ownerName}.${name.text}`;
    const kind: NodeKind = ts.isMethodDeclaration(node) ? "Method" : "Function";
    const record = assembler.ensureNode({
      kind, qualifiedName,
      relativePath: entry.relativePath,
      language: entry.language,
      location: declarationSpan(entry, node.getSourceFile(), node),
    });
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol !== undefined) registry.set(symbol, record);
    return record;
  }

  // Anonymous arrow/function-expression: VariableDeclaration'a veya CommonJS
  // export atamasına bağlıysa caller olarak çözümlenir.
  const parent = node.parent;
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return assembler.ensureNode({
      kind: "Handler", qualifiedName: parent.name.text,
      relativePath: entry.relativePath,
      language: entry.language,
      location: declarationSpan(entry, parent.getSourceFile(), parent),
    });
  }
  return cjsExportCallerRecord(context, entry, node);
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
    const ownName = extractDeclarationNameText(declaration);
    if (ownName === undefined) return undefined;
    const owner = declaration.parent;
    const ownerName =
      (ts.isClassDeclaration(owner) ||
        ts.isInterfaceDeclaration(owner))
        ? owner.name?.text
        : undefined;
    qualifiedName = ownerName === undefined ? ownName : `${ownerName}.${ownName}`;
    kind = inferNodeKind(declaration);
  }

  // Denetim bulgusu düzeltmesi: türetilen node kimliği bildirimin KENDİ
  // dosyasına aittir; çağıran dosyaya değil. Aksi halde aynı sembol için
  // çağıran dosya başına çoğaltma node'ları doğar. Guard (resolveSymbolRecord
  // içindeki ownRelativePathOf denetimi) set-dışı bildirimi buraya sokmaz.
  const declarationEntry = context.entries.get(
    canonicalPath(declaration.getSourceFile().fileName),
  );
  if (
    kind === undefined ||
    qualifiedName === undefined ||
    declarationEntry === undefined
  ) {
    return undefined;
  }
  return assembler.ensureNode({
    kind, qualifiedName,
    relativePath: declarationEntry.relativePath,
    language: declarationEntry.language,
    location: declarationSpan(declarationEntry, declaration.getSourceFile(), declaration),
  });
}

function inferNodeKind(declaration: ts.Declaration): NodeKind | undefined {
  if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) return "Class";
  if (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)) return ts.isInterfaceDeclaration(declaration) ? "Interface" : "Type";
  if (ts.isFunctionDeclaration(declaration)) return "Function";
  if (ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration)) return inferCjsExportNodeKind(declaration);
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
    kind: "Endpoint", qualifiedName: `${verb} ${pathText}`,
    relativePath: entry.relativePath,
    language: entry.language,
    attributes:
      framework === undefined
        ? { method: verb, path: pathText }
        : { method: verb, path: pathText, framework },
    location: declarationSpan(entry, sourceFile, call),
  });
  if (framework !== undefined) {
    context.framework.nodeKeys.add(endpoint.key);
  }

  const handlerArg = call.arguments[1];
  if (handlerArg === undefined) return true;
  if (!ts.isIdentifier(handlerArg) && !ts.isPropertyAccessExpression(handlerArg)) {
    assembler.addWarning(
      `Route handler not modeled: ${entry.relativePath} '${verb} ${pathText}' (inline/anonymous handlers are listed in unsupportedConstructs)`,
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
        `ROUTES_TO: route registration '${verb} ${pathText}' was resolved by the TypeChecker to handler ${handlerRecord.node.qualifiedName}.`,
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
        `ROUTES_TO: the handler of route registration '${verb} ${pathText}' resolved to symbol ${handlerSymbol.getName()} outside the analysis set; an explicit UnknownExternal node was used.`,
      ),
    );
    return true;
  }

  assembler.addWarning(
    `ROUTES_TO unresolved: ${entry.relativePath} '${verb} ${pathText}' -> handler symbol not found (Endpoint node kept, no edge created)`,
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
  const signatureSymbol =
    declaration !== undefined
      ? checker.getSymbolAtLocation(ts.getNameOfDeclaration(declaration) ?? declaration)
      : undefined;
  const targetSymbol = isNew
    ? checker.getSymbolAtLocation(call.expression)
    : (signatureSymbol ?? checker.getSymbolAtLocation(call.expression));
  const resolvedTargetSymbol = unwrapAliasSymbol(checker, targetSymbol);

  const registryHit =
    resolveSymbolRecord(
      context,
      entry,
      targetSymbol ?? undefined,
      declaration ?? undefined,
    ) ??
    (!isNew && declaration !== undefined
      ? resolveInternalCallableRecord(context, resolvedTargetSymbol, caller)
      : undefined);
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
        `CALLS: call expression in ${caller.node.qualifiedName} was resolved by the TypeChecker to symbol ${registryHit.node.qualifiedName} (verified).`,
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
          `TESTS: call expression in test ${caller.node.qualifiedName} was resolved by the TypeChecker to symbol ${registryHit.node.qualifiedName} (verified).`,
        ),
      });
    }
    return;
  }

  if (
    resolvedTargetSymbol !== undefined &&
    (resolvedTargetSymbol.flags & ts.SymbolFlags.Alias) === 0 &&
    (resolvedTargetSymbol.getDeclarations()?.length ?? 0) > 0 &&
    !isInternalDeclarationOrSymbol(context, resolvedTargetSymbol, declaration)
  ) {
    // Analiz setinin dışında bildirilen sembol (lib/node_modules): açık
    // UnknownExternal node + checker dayanaklı verified kenar.
    const externalDecl =
      signatureSymbol !== undefined
        ? declaration
        : resolvedTargetSymbol.getDeclarations()?.[0];
    const externalName = externalQualifiedName(resolvedTargetSymbol, externalDecl);
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
        `CALLS: call in ${caller.node.qualifiedName} resolved to symbol ${externalName} outside the analysis set; the external source is represented as an explicit UnknownExternal node.`,
      ),
    });
    return;
  }

  // TypeChecker tarafından kesin olarak çözümlenmiş ancak üst düzey düğüm
  // olarak modellenmeyen yerel çağrılar (callback parametreleri, test-içi
  // kapanışlar, anonim nesne değişmezleri, IIFE): sahte UnknownExternal
  // (unresolved) üretmez.
  if (
    !isNew &&
    declaration !== undefined &&
    isResolvedInternalNonModeledCall(context, resolvedTargetSymbol, declaration)
  ) {
    return;
  }

  // Hiç çözümlenemedi: uydurma sembol YOK; açık UnknownExternal + unresolved.
  const callText = formatUnresolvedCalleeText(call.expression, sourceFile);
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
      `CALLS: call '${callText}' in ${caller.node.qualifiedName} could not be resolved; marked unresolved on an explicit UnknownExternal node instead of inventing a target.`,
    ),
  });
  assembler.addWarning(
    `CALLS unresolved: ${entry.relativePath} '${callText}' (unresolved, UnknownExternal node created)`,
  );
}

const MAX_UNRESOLVED_CALLEE_CHARS = 120;
const MAX_UNRESOLVED_CALLEE_DEPTH = 16;

function resolveInternalCallableRecord(
  context: AnalysisContext,
  symbol: ts.Symbol | undefined,
  caller: NodeRecord,
): NodeRecord | undefined {
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    return undefined;
  }
  const decl = symbol.getDeclarations()?.[0];
  if (decl === undefined) return undefined;
  const declEntry = context.entries.get(
    canonicalPath(decl.getSourceFile().fileName),
  );
  if (declEntry === undefined) return undefined;

  if (
    (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) &&
    ts.isIdentifier(decl.name)
  ) {
    const owner = decl.parent;
    const ownerName =
      ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)
        ? owner.name?.text
        : resolveClassExpressionOwnerName(context, owner);
    if (ownerName !== undefined) {
      const record = context.assembler.ensureNode({
        kind: "Method",
        qualifiedName: `${ownerName}.${decl.name.text}`,
        relativePath: declEntry.relativePath,
        language: declEntry.language,
        location: declarationSpan(declEntry, decl.getSourceFile(), decl),
      });
      context.registry.set(symbol, record);
      return record;
    }
  }

  if (
    caller.node.kind !== "Test" &&
    ts.isVariableDeclaration(decl) &&
    ts.isIdentifier(decl.name)
  ) {
    const init = unwrapParenthesizedExpression(decl.initializer);
    if (
      init !== undefined &&
      (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
    ) {
      const record = context.assembler.ensureNode({
        kind: "Handler",
        qualifiedName: decl.name.text,
        relativePath: declEntry.relativePath,
        language: declEntry.language,
        location: declarationSpan(declEntry, decl.getSourceFile(), decl),
      });
      context.registry.set(symbol, record);
      return record;
    }
  }

  return undefined;
}

function isResolvedInternalNonModeledCall(
  context: AnalysisContext,
  resolvedTargetSymbol: ts.Symbol | undefined,
  declaration: ts.Declaration,
): boolean {
  if (
    resolvedTargetSymbol !== undefined &&
    (resolvedTargetSymbol.flags & ts.SymbolFlags.Alias) === 0 &&
    isInternalDeclarationOrSymbol(context, resolvedTargetSymbol, declaration)
  ) {
    return true;
  }
  return (
    (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) &&
    ownRelativePathOf(context, declaration) !== undefined
  );
}

function formatUnresolvedCalleeExpr(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  depth: number,
): string {
  if (depth >= MAX_UNRESOLVED_CALLEE_DEPTH) {
    return expr.getText(sourceFile).trim();
  }
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isSatisfiesExpression(expr)
  ) {
    return formatUnresolvedCalleeExpr(expr.expression, sourceFile, depth + 1);
  }
  if (ts.isCallExpression(expr)) {
    return `${formatUnresolvedCalleeExpr(expr.expression, sourceFile, depth + 1)}()`;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const receiver = formatUnresolvedCalleeExpr(expr.expression, sourceFile, depth + 1);
    return `${receiver}.${expr.name.text}`;
  }
  if (ts.isElementAccessExpression(expr)) {
    const receiver = formatUnresolvedCalleeExpr(expr.expression, sourceFile, depth + 1);
    return `${receiver}[]`;
  }
  return expr.getText(sourceFile).trim();
}

function formatUnresolvedCalleeText(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
): string {
  const raw = formatUnresolvedCalleeExpr(expr, sourceFile, 0);
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "<unresolved-call>";
  return collapsed.length > MAX_UNRESOLVED_CALLEE_CHARS
    ? collapsed.slice(0, MAX_UNRESOLVED_CALLEE_CHARS)
    : collapsed;
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
const NEXT_APP_ROUTE_BASENAMES: ReadonlySet<string> = new Set([
  "route.ts",
  "route.tsx",
  "route.mts",
  "route.cts",
  "route.js",
  "route.jsx",
  "route.mjs",
  "route.cjs",
]);

const NEXT_APP_PAGE_BASENAMES: ReadonlySet<string> = new Set([
  "page.ts",
  "page.tsx",
  "page.mts",
  "page.cts",
  "page.js",
  "page.jsx",
  "page.mjs",
  "page.cjs",
]);

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
  const base = (segments[segments.length - 1] ?? "").toLowerCase();
  const kind = NEXT_APP_ROUTE_BASENAMES.has(base)
    ? "route"
    : NEXT_APP_PAGE_BASENAMES.has(base)
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
 * (Router "express" specifier'ından ESM import veya CommonJS require ile
 * alındıysa). Denetim bulgusu 2 düzeltmesi: framework etiketi yalnızca bu
 * receiver'ların kayıtlarına yazılır — proje-geneli değil.
 */
function collectExpressInstanceVars(
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const instanceVars = new Set<string>();
  let defaultBinding: string | undefined;
  const namedBindings = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
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
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const reqArg = isStaticRequireCall(declaration.initializer);
        if (reqArg !== undefined && reqArg.text === "express") {
          if (ts.isIdentifier(declaration.name)) {
            defaultBinding = declaration.name.text;
          } else if (ts.isObjectBindingPattern(declaration.name)) {
            for (const element of declaration.name.elements) {
              if (ts.isIdentifier(element.name)) {
                namedBindings.add(element.name.text);
              }
            }
          }
          continue;
        }
        // Zincirli CommonJS deyimleri: `const app = require("express")()`
        // ve `const router = require("express").Router()`.
        if (
          ts.isIdentifier(declaration.name) &&
          isChainedExpressRequireCall(declaration.initializer)
        ) {
          instanceVars.add(declaration.name.text);
        }
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
        if (isChainedExpressRequireCall(initializer)) {
          instanceVars.add(node.name.text);
        } else {
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
    language: entry.language,
    attributes: { method, path: routePath, framework: "nextjs" },
    location: declarationSpan(entry, sourceFile, anchor),
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
      `ROUTES_TO: Next.js App Router convention export '${method} ${routePath}' (${entry.relativePath}) was resolved by the TypeChecker to symbol ${handlerRecord.node.qualifiedName}.`,
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
          `Next.js route handler unresolved: ${entry.relativePath} '${name.text}' (no edge created)`,
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
            `Next.js route handler unresolved: ${entry.relativePath} '${declaration.name.text}' (no edge created)`,
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
      message: `Next.js App Router route file ('${entry.relativePath}') has no recognized HTTP verb export (expected: export function GET|POST|... or export const GET = ...); no edge created, no node invented.`,
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
      ? `Next.js App Router page file ('${entry.relativePath}') has an unnamed/anonymous default export; no symbol invented, no edge created.`
      : `Next.js App Router page file ('${entry.relativePath}') has no recognized default export; no edge created, no node invented.`,
    line: firstStatementLine(sourceFile),
  });
}

/* ------------------------------------------------------------------ */
/* Standalone TypeScript lib*.d.ts dizin çözümlemesi                   */
/* ------------------------------------------------------------------ */

function createCompilerHostWithDefaultLib(
  compilerOptions: ts.CompilerOptions,
  preResolvedLibDir?: string,
): ts.CompilerHost {
  const host = ts.createCompilerHost(compilerOptions, /*setParentNodes*/ true);
  const resolvedLibDir = preResolvedLibDir ?? resolveTypeScriptLibDir();
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

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function normalizeLibDirPosix(rawPath: string): string {
  const posix = toPosix(rawPath);
  if (posix === "/" || /^[a-zA-Z]:\/$/.test(posix)) {
    return posix;
  }
  if (/^[a-zA-Z]:$/.test(posix)) {
    return `${posix}/`;
  }
  return stripTrailingSlashes(posix);
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
  const trimmed = stripTrailingSlashes(dir);
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

/* ------------------------------------------------------------------ */
/* JavaScript, CommonJS & izole host yardımcıları (v0.2.3)              */
/* ------------------------------------------------------------------ */

const JS_EXTENSION_PATTERN = /\.(?:js|jsx|mjs|cjs)$/i;

/** Dosya uzantısına göre dil kimliği: .js/.jsx/.mjs/.cjs -> "javascript", diğerleri -> "typescript". */
function languageForPath(relativePath: string): SourceLanguage {
  return JS_EXTENSION_PATTERN.test(relativePath) ? "javascript" : "typescript";
}

function stripWindowsExtendedPrefix(raw: string): string {
  if (raw.startsWith("\\\\?\\UNC\\") || raw.startsWith("//?/UNC/")) {
    return `//${raw.slice(8)}`;
  }
  if (raw.startsWith("\\\\?\\") || raw.startsWith("//?/")) {
    return raw.slice(4);
  }
  return raw;
}

function normalizeRootPosix(rawRootDir: string): string {
  const normalized = normalizePosixPath(rawRootDir);
  if (normalized === "/" || /^[a-zA-Z]:\/$/.test(normalized)) {
    return normalized;
  }
  return stripTrailingSlashes(normalized);
}

function joinRootAndRelative(rootPosix: string, relativePath: string): string {
  return rootPosix.endsWith("/")
    ? `${rootPosix}${relativePath}`
    : `${rootPosix}/${relativePath}`;
}

/**
 * Maps each workspace `package.json` (canonical absolute path) to a minimal
 * JSON projection carrying only its `"type"` field. TypeScript reads the
 * nearest package.json through the compiler host to decide whether a
 * `.ts`/`.js` file is ESM or CommonJS (`impliedNodeFormat`); without this the
 * confined host hides every workspace manifest and all such files are treated
 * as CommonJS (false TS1470 for `import.meta` in `"type": "module"` packages).
 * Other manifest fields are deliberately not exposed, so module resolution
 * behaves exactly as before.
 */
function buildPackageJsonProjections(
  rootPosix: string,
  scopes: readonly PackageModuleScope[],
): ReadonlyMap<string, string> {
  const projections = new Map<string, string>();
  for (const scope of scopes) {
    const absolutePath = normalizePosixPath(
      joinRootAndRelative(rootPosix, scope.manifestRelativePath),
    );
    projections.set(
      canonicalPath(absolutePath),
      JSON.stringify(scope.moduleType === undefined ? {} : { type: scope.moduleType }),
    );
  }
  return projections;
}

/**
 * SEC-04: CompilerHost + ModuleResolutionHost disk fallback'ini kesinlikle
 * sınırlar — `entries` dışındaki workspace dosyaları (.env.js, ../secret.js,
 * symlink, bundle vb.) diskten ASLA okunmaz. Disk erişimi yalnızca:
 * (a) TypeScript yerleşik lib*.d.ts dizini (`resolvedLibDir`), ve
 * (b) `rootPosix` içindeki `node_modules` altındaki `.d.ts`/`.d.mts`/`.d.cts`/
 *     `package.json` dosyaları için izin verilir.
 */
export function configureConfinedCompilerHost(
  host: ts.CompilerHost,
  entries: ReadonlyMap<string, { readonly absolutePath: string; readonly content: string }>,
  rootPosix: string,
  resolvedLibDir: string | undefined,
  packageJsonProjections: ReadonlyMap<string, string> = new Map(),
): ts.ModuleResolutionHost {
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const baseDirectoryExists = host.directoryExists?.bind(host);
  const baseRealpath = host.realpath?.bind(host);
  const baseGetDirectories = host.getDirectories?.bind(host);

  const withTrailingSlash = (key: string): string =>
    key.endsWith("/") ? key : `${key}/`;

  const tryBaseRealpath = (p: string): string | undefined => {
    if (baseRealpath === undefined || p.includes("\0")) return undefined;
    try {
      const real = baseRealpath(p);
      return typeof real === "string" && real.length > 0 ? real : undefined;
    } catch {
      return undefined;
    }
  };

  const rootKey = canonicalPath(rootPosix);
  const rootKeyWithSlash = withTrailingSlash(rootKey);
  const realRootRaw = tryBaseRealpath(rootPosix);
  const realRootKey =
    realRootRaw === undefined ? undefined : canonicalPath(realRootRaw);
  const realRootKeyWithSlash =
    realRootKey === undefined ? undefined : withTrailingSlash(realRootKey);

  const libDirKey =
    resolvedLibDir === undefined ? undefined : canonicalPath(resolvedLibDir);
  const libDirKeyWithSlash =
    libDirKey === undefined ? undefined : withTrailingSlash(libDirKey);
  const realLibDirRaw =
    resolvedLibDir === undefined ? undefined : tryBaseRealpath(resolvedLibDir);
  const realLibDirKey =
    realLibDirRaw === undefined ? undefined : canonicalPath(realLibDirRaw);
  const realLibDirKeyWithSlash =
    realLibDirKey === undefined ? undefined : withTrailingSlash(realLibDirKey);

  const isInAllowedLibDir = (candidateKey: string): boolean =>
    (libDirKeyWithSlash !== undefined && candidateKey.startsWith(libDirKeyWithSlash)) ||
    (realLibDirKeyWithSlash !== undefined && candidateKey.startsWith(realLibDirKeyWithSlash));

  const isInAllowedLibDirOrSelf = (candidateKey: string): boolean =>
    isInAllowedLibDir(candidateKey) ||
    (libDirKey !== undefined && candidateKey === libDirKey) ||
    (realLibDirKey !== undefined && candidateKey === realLibDirKey);

  const relativeUnderAllowedRoot = (candidateKey: string): string | undefined => {
    if (candidateKey.startsWith(rootKeyWithSlash)) {
      return candidateKey.slice(rootKeyWithSlash.length);
    }
    if (
      realRootKeyWithSlash !== undefined &&
      candidateKey.startsWith(realRootKeyWithSlash)
    ) {
      return candidateKey.slice(realRootKeyWithSlash.length);
    }
    return undefined;
  };

  const isInRootNodeModules = (candidateKey: string): boolean => {
    const rel = relativeUnderAllowedRoot(candidateKey);
    if (rel === undefined) return false;
    return rel.startsWith("node_modules/") || rel.includes("/node_modules/");
  };

  const isAllowedDiskFile = (candidatePath: string): boolean => {
    if (candidatePath.includes("\0")) return false;
    const key = canonicalPath(candidatePath);
    if (isInAllowedLibDir(key)) return true;
    if (!isInRootNodeModules(key)) return false;
    const lower = key.toLowerCase();
    return (
      lower.endsWith(".d.ts") ||
      lower.endsWith(".d.mts") ||
      lower.endsWith(".d.cts") ||
      lower.endsWith("/package.json")
    );
  };

  const isAllowedDiskDir = (candidatePath: string): boolean => {
    if (candidatePath.includes("\0")) return false;
    const key = canonicalPath(candidatePath);
    if (isInAllowedLibDirOrSelf(key)) return true;
    const rel = relativeUnderAllowedRoot(key);
    if (rel === undefined) return false;
    return (
      rel === "node_modules" ||
      rel.startsWith("node_modules/") ||
      rel.endsWith("/node_modules") ||
      rel.includes("/node_modules/")
    );
  };

  // SEC-04-R1: CWE-59 symlink escape guard on BOTH fileExists and readFile.
  const isRealpathConfinedDiskFile = (p: string): boolean => {
    if (p.includes("\0")) return false;
    const key = canonicalPath(p);
    if (isInAllowedLibDir(key)) {
      if (baseRealpath === undefined) return true;
      const real = tryBaseRealpath(p);
      return real !== undefined && isInAllowedLibDir(canonicalPath(real));
    }
    if (!isAllowedDiskFile(p)) return false;
    if (baseRealpath === undefined) return false;
    const real = tryBaseRealpath(p);
    return real !== undefined && isAllowedDiskFile(real);
  };

  const isRealpathConfinedDiskDir = (p: string): boolean => {
    if (p.includes("\0")) return false;
    const key = canonicalPath(p);
    if (isInAllowedLibDirOrSelf(key)) {
      if (baseRealpath === undefined) return true;
      const real = tryBaseRealpath(p);
      return real !== undefined && isInAllowedLibDirOrSelf(canonicalPath(real));
    }
    if (!isAllowedDiskDir(p)) return false;
    if (baseRealpath === undefined) return false;
    const real = tryBaseRealpath(p);
    return real !== undefined && isAllowedDiskDir(real);
  };

  const memoryDirectories = new Set<string>();
  const memoryChildDirs = new Map<string, Set<string>>();
  for (const entry of entries.values()) {
    const normAbs = normalizePosixPath(entry.absolutePath);
    let slash = normAbs.indexOf("/");
    while (slash >= 0) {
      const dirAbs = slash === 0 ? "/" : normAbs.slice(0, slash);
      const dirKey = canonicalPath(dirAbs);
      memoryDirectories.add(dirKey);
      const nextSlash = normAbs.indexOf("/", slash + 1);
      if (nextSlash > slash + 1) {
        const childName = normAbs.slice(slash + 1, nextSlash);
        let childSet = memoryChildDirs.get(dirKey);
        if (childSet === undefined) {
          childSet = new Set<string>();
          memoryChildDirs.set(dirKey, childSet);
        }
        childSet.add(childName);
      }
      slash = nextSlash;
    }
  }

  // Workspace package.json manifests are never read from disk here; the host
  // serves only their module-format projection (see buildPackageJsonProjections).
  host.fileExists = (p: string): boolean =>
    !p.includes("\0") &&
    (entries.has(canonicalPath(p)) ||
      packageJsonProjections.has(canonicalPath(p)) ||
      (isAllowedDiskFile(p) && baseFileExists(p) && isRealpathConfinedDiskFile(p)));

  host.readFile = (p: string): string | undefined => {
    if (p.includes("\0")) return undefined;
    const key = canonicalPath(p);
    const hit = entries.get(key);
    if (hit !== undefined) return hit.content;
    const projected = packageJsonProjections.get(key);
    if (projected !== undefined) return projected;
    return isAllowedDiskFile(p) && isRealpathConfinedDiskFile(p)
      ? baseReadFile(p)
      : undefined;
  };

  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists: (p: string) => host.fileExists(p),
    readFile: (p: string) => host.readFile(p),
  };

  if (baseDirectoryExists !== undefined) {
    const confinedDirectoryExists = (p: string): boolean =>
      !p.includes("\0") &&
      (memoryDirectories.has(canonicalPath(p)) ||
        (isAllowedDiskDir(p) && baseDirectoryExists(p) && isRealpathConfinedDiskDir(p)));
    resolutionHost.directoryExists = confinedDirectoryExists;
    host.directoryExists = confinedDirectoryExists;
  }

  if (baseRealpath !== undefined) {
    const confinedRealpath = (p: string): string => {
      if (p.includes("\0")) return p;
      if (entries.has(canonicalPath(p))) return p;
      if (!isAllowedDiskFile(p) && !isAllowedDiskDir(p)) return p;
      // Escaping symlink'leri leksik yol arkasına SAKLAMAZ: gerçek hedefi döner,
      // böylece `isAllowedResolved` kök dışı hedefi kesin biçimde reddeder.
      return tryBaseRealpath(p) ?? p;
    };
    resolutionHost.realpath = confinedRealpath;
    host.realpath = confinedRealpath;
  }

  if (baseGetDirectories !== undefined) {
    host.getDirectories = (p: string): string[] => {
      if (p.includes("\0")) return [];
      const key = canonicalPath(p);
      const memChildren = memoryChildDirs.get(key);
      const memList = memChildren === undefined ? [] : [...memChildren].sort();
      if (!isAllowedDiskDir(p) || !isRealpathConfinedDiskDir(p)) {
        return memList;
      }
      const childPrefix = p.endsWith("/") || p.endsWith("\\") ? p : `${p}/`;
      let diskDirs: string[];
      try {
        diskDirs = baseGetDirectories(p).filter(
          (name) => !name.includes("\0") && isRealpathConfinedDiskDir(`${childPrefix}${name}`),
        );
      } catch {
        diskDirs = [];
      }
      if (memList.length === 0) return diskDirs;
      return [...new Set([...memList, ...diskDirs])].sort();
    };
  }

  return resolutionHost;
}

/** Statik CommonJS `require("...")` çağrısını tanır; dinamik ifadeleri yoksayar. */
function isStaticRequireCall(
  node: ts.Node | undefined,
): ts.StringLiteralLike | undefined {
  if (node === undefined || !ts.isCallExpression(node)) return undefined;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "require") {
    return undefined;
  }
  if (node.arguments.length !== 1) return undefined;
  const arg = node.arguments[0];
  if (arg === undefined || !ts.isStringLiteralLike(arg) || arg.text.length === 0) {
    return undefined;
  }
  return arg;
}

/** `require("express")()` veya `require("express").Router()` zincirli çağrılarını tanır. */
function isChainedExpressRequireCall(node: ts.Node | undefined): boolean {
  if (node === undefined || !ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const directReq = isStaticRequireCall(callee);
  if (directReq !== undefined && directReq.text === "express") return true;
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === "Router") {
    const memberReq = isStaticRequireCall(callee.expression);
    if (memberReq !== undefined && memberReq.text === "express") return true;
  }
  return false;
}

interface CjsExportFunctionMatch {
  readonly exportName: string;
  readonly kind: "Function" | "Handler";
  readonly lhs: ts.Expression;
  readonly rhs: ts.FunctionExpression | ts.ArrowFunction;
}

function matchCjsExportAssignment(
  binary: ts.BinaryExpression,
): CjsExportFunctionMatch | undefined {
  if (binary.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return undefined;
  const rhs = binary.right;
  if (!ts.isFunctionExpression(rhs) && !ts.isArrowFunction(rhs)) return undefined;
  const lhs = binary.left;
  if (!ts.isPropertyAccessExpression(lhs)) return undefined;

  // exports.<name> = fn|arrow
  if (ts.isIdentifier(lhs.expression) && lhs.expression.text === "exports") {
    return {
      exportName: lhs.name.text,
      kind: ts.isFunctionExpression(rhs) ? "Function" : "Handler",
      lhs,
      rhs,
    };
  }
  // module.exports.<name> = fn|arrow
  if (
    ts.isPropertyAccessExpression(lhs.expression) &&
    ts.isIdentifier(lhs.expression.expression) &&
    lhs.expression.expression.text === "module" &&
    lhs.expression.name.text === "exports"
  ) {
    return {
      exportName: lhs.name.text,
      kind: ts.isFunctionExpression(rhs) ? "Function" : "Handler",
      lhs,
      rhs,
    };
  }
  // module.exports = function <name>(...)
  if (
    ts.isIdentifier(lhs.expression) &&
    lhs.expression.text === "module" &&
    lhs.name.text === "exports" &&
    ts.isFunctionExpression(rhs) &&
    rhs.name !== undefined
  ) {
    return {
      exportName: rhs.name.text,
      kind: "Function",
      lhs,
      rhs,
    };
  }
  return undefined;
}

/** HIGH-2: Üst düzey CommonJS export atamalarını (`exports.fn`, `module.exports.fn`, `module.exports = function name`) düğüm + registry olarak çıkarır. */
function extractCjsExportStatement(
  context: AnalysisContext,
  entry: SourceEntry,
  statement: ts.Statement,
  fileNode: NodeRecord,
  addContains: (from: NodeRecord, to: NodeRecord, node: ts.Node, rationale: string) => void,
  registerWithSymbol: (symbol: ts.Symbol | undefined, record: NodeRecord) => void,
): void {
  if (!ts.isExpressionStatement(statement)) return;
  if (!ts.isBinaryExpression(statement.expression)) return;
  const match = matchCjsExportAssignment(statement.expression);
  if (match === undefined) return;

  const { assembler, checker } = context;
  const record = assembler.ensureNode({
    kind: match.kind,
    qualifiedName: match.exportName,
    relativePath: entry.relativePath,
    language: entry.language,
  });

  const rhsName = ts.getNameOfDeclaration(match.rhs);
  registerWithSymbol(checker.getSymbolAtLocation(rhsName ?? match.rhs), record);
  if (rhsName !== undefined) {
    registerWithSymbol(checker.getSymbolAtLocation(match.rhs), record);
  }
  registerWithSymbol(checker.getSymbolAtLocation(match.lhs), record);
  if (ts.isPropertyAccessExpression(match.lhs)) {
    registerWithSymbol(checker.getSymbolAtLocation(match.lhs.name), record);
  }

  addContains(
    fileNode,
    record,
    statement,
    `CONTAINS: CommonJS export ${match.exportName} in ${entry.relativePath}, matched by AST span evidence.`,
  );
}

/** CommonJS export atamasına bağlı fonksiyon/arrow ifadeleri için caller kaydı döndürür. */
function cjsExportCallerRecord(
  context: AnalysisContext,
  entry: SourceEntry,
  node: ts.Node,
): NodeRecord | undefined {
  const parent = node.parent;
  if (parent === undefined || !ts.isBinaryExpression(parent) || parent.right !== node) {
    return undefined;
  }
  const match = matchCjsExportAssignment(parent);
  if (match === undefined) return undefined;
  return context.assembler.ensureNode({
    kind: match.kind,
    qualifiedName: match.exportName,
    relativePath: entry.relativePath,
    language: entry.language,
    location: declarationSpan(entry, parent.getSourceFile(), parent),
  });
}

/** HIGH-2: Sembol veya bildirimi analiz setindeki dahili bir dosyaya aitse true döner (UnknownExternal sınıflandırmasını önler). */
function isInternalDeclarationOrSymbol(
  context: AnalysisContext,
  symbol: ts.Symbol,
  declaration: ts.Declaration | undefined,
): boolean {
  if (declaration !== undefined && ownRelativePathOf(context, declaration) !== undefined) {
    return true;
  }
  const decls = symbol.getDeclarations();
  if (decls !== undefined) {
    for (const decl of decls) {
      if (ownRelativePathOf(context, decl) !== undefined) return true;
    }
  }
  return false;
}

function extractDeclarationNameText(
  declaration: ts.Declaration,
): string | undefined {
  const name = ts.getNameOfDeclaration(declaration);
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isPropertyAccessExpression(name)) return name.name.text;
  return undefined;
}

function inferCjsExportNodeKind(
  declaration: ts.FunctionExpression | ts.ArrowFunction,
): "Function" | "Handler" | undefined {
  const parent = declaration.parent;
  if (parent === undefined || !ts.isBinaryExpression(parent) || parent.right !== declaration) {
    return undefined;
  }
  const statement = parent.parent;
  if (statement === undefined || !ts.isExpressionStatement(statement)) {
    return undefined;
  }
  if (!ts.isSourceFile(statement.parent)) {
    return undefined;
  }
  return matchCjsExportAssignment(parent)?.kind;
}

/* ------------------------------------------------------------------ */
/* Monorepo Workspace, CHA (INHERITS/IMPLEMENTS) & Incremental Reuse   */
/* ------------------------------------------------------------------ */

/**
 * Incremental entry point returning `{ result, framework, nextIncrementalState }`
 * with enumerable `nextIncrementalState` for reusing unchanged `ts.SourceFile`
 * ASTs via `ts.createProgram(..., oldProgram)` on subsequent runs.
 */
export function analyzeTypeScriptProgramIncremental(
  input: TypeScriptAdapterInput,
): TypeScriptIncrementalAnalysisRun {
  return runAnalysis(input);
}

function computeIncrementalOptionsSignature(
  rootPosix: string,
  compilerOptions: ts.CompilerOptions,
  configs: readonly ScopedTsConfig[],
  workspacePackages: ReadonlyMap<string, WorkspacePackageManifest>,
  moduleScopes: readonly PackageModuleScope[],
): string {
  const normalizedConfigs = configs.map((cfg) => ({
    dirPrefix: cfg.dirPrefix,
    configRelativePath: cfg.configRelativePath,
    baseUrl: cfg.baseUrl ?? null,
    pathsBasePath: cfg.pathsBasePath ?? null,
    paths: cfg.paths === undefined ? null : [...cfg.paths.entries()],
    jsx: cfg.jsx ?? null,
    moduleResolution: cfg.moduleResolution ?? null,
    module: cfg.module ?? null,
    target: cfg.target ?? null,
    experimentalDecorators: cfg.experimentalDecorators ?? null,
    verbatimModuleSyntax: cfg.verbatimModuleSyntax ?? null,
  }));
  const normalizedPackages = [...workspacePackages.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, pkg]) => ({
      name,
      dirPrefix: pkg.dirPrefix,
      manifestRelativePath: pkg.manifestRelativePath,
      exports: pkg.exports ?? null,
      main: pkg.main ?? null,
      module: pkg.module ?? null,
      types: pkg.types ?? null,
      typings: pkg.typings ?? null,
    }));
  const signaturePayload = {
    rootPosix,
    options: {
      strict: compilerOptions.strict ?? null,
      allowJs: compilerOptions.allowJs ?? null,
      checkJs: compilerOptions.checkJs ?? null,
      jsx: compilerOptions.jsx ?? null,
      target: compilerOptions.target ?? null,
      module: compilerOptions.module ?? null,
      moduleResolution: compilerOptions.moduleResolution ?? null,
      experimentalDecorators: compilerOptions.experimentalDecorators ?? null,
      verbatimModuleSyntax: compilerOptions.verbatimModuleSyntax ?? null,
      baseUrl: compilerOptions.baseUrl ?? null,
    },
    configs: normalizedConfigs,
    workspacePackages: normalizedPackages,
    moduleScopes: moduleScopes.map((scope) => [
      scope.manifestRelativePath,
      scope.moduleType ?? null,
    ]),
  };
  return sha256Hex(utf8Encode(JSON.stringify(signaturePayload)));
}

function isCompilerOptionsCompatibleForReuse(
  prev: ts.CompilerOptions,
  next: ts.CompilerOptions,
): boolean {
  return (
    prev.target === next.target &&
    prev.jsx === next.jsx &&
    prev.module === next.module &&
    prev.moduleResolution === next.moduleResolution &&
    prev.strict === next.strict &&
    prev.allowJs === next.allowJs &&
    prev.checkJs === next.checkJs &&
    prev.experimentalDecorators === next.experimentalDecorators &&
    prev.verbatimModuleSyntax === next.verbatimModuleSyntax
  );
}

function configureIncrementalSourceFileReuse(
  host: ts.CompilerHost,
  oldProgram: ts.Program,
  entries: ReadonlyMap<string, SourceEntry>,
  previousSourceHashes: ReadonlyMap<string, string> | undefined,
  resolvedLibDir: string | undefined,
): void {
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const oldSourceFilesByKey = new Map<string, ts.SourceFile>();
  for (const sf of oldProgram.getSourceFiles()) {
    oldSourceFilesByKey.set(canonicalPath(sf.fileName), sf);
  }
  const libDirKeyWithSlash =
    resolvedLibDir === undefined
      ? undefined
      : (() => {
          const k = canonicalPath(resolvedLibDir);
          return k.endsWith("/") ? k : `${k}/`;
        })();

  const tryReuseOldSourceFile = (
    fileName: string,
    shouldCreateNewSourceFile?: boolean,
    languageVersionOrOptions?: ts.ScriptTarget | ts.CreateSourceFileOptions,
  ): ts.SourceFile | undefined => {
    if (shouldCreateNewSourceFile) return undefined;
    const key = canonicalPath(fileName);
    const oldSf = oldSourceFilesByKey.get(key);
    if (oldSf === undefined) return undefined;
    // A package.json "type" change flips ESM/CommonJS without touching the
    // file text; never reuse a SourceFile parsed under the other format.
    if (
      typeof languageVersionOrOptions === "object" &&
      languageVersionOrOptions.impliedNodeFormat !== oldSf.impliedNodeFormat
    ) {
      return undefined;
    }

    const entry = entries.get(key);
    if (entry !== undefined) {
      if (previousSourceHashes !== undefined) {
        return previousSourceHashes.get(key) === entry.sourceHash ? oldSf : undefined;
      }
      return oldSf.text === entry.content ? oldSf : undefined;
    }

    if (libDirKeyWithSlash !== undefined && key.startsWith(libDirKeyWithSlash)) {
      return oldSf;
    }
    return undefined;
  };

  host.getSourceFile = (
    fileName,
    languageVersionOrOptions,
    onError,
    shouldCreateNewSourceFile,
  ) =>
    tryReuseOldSourceFile(fileName, shouldCreateNewSourceFile, languageVersionOrOptions) ??
    baseGetSourceFile(
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile,
    );

  if (host.getSourceFileByPath !== undefined) {
    const baseGetSourceFileByPath = host.getSourceFileByPath.bind(host);
    host.getSourceFileByPath = (
      fileName,
      pathArg,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile,
    ) =>
      tryReuseOldSourceFile(fileName, shouldCreateNewSourceFile, languageVersionOrOptions) ??
      baseGetSourceFileByPath(
        fileName,
        pathArg,
        languageVersionOrOptions,
        onError,
        shouldCreateNewSourceFile,
      );
  }
}

function createProgramWithIncrementalReuse(params: {
  readonly input: TypeScriptAdapterInput;
  readonly rootPosix: string;
  readonly compilerOptions: ts.CompilerOptions;
  readonly loadedConfigs: readonly ScopedTsConfig[];
  readonly workspacePackages: ReadonlyMap<string, WorkspacePackageManifest>;
  readonly moduleScopes: readonly PackageModuleScope[];
  readonly host: ts.CompilerHost;
  readonly entries: ReadonlyMap<string, SourceEntry>;
  readonly sortedEntries: readonly SourceEntry[];
  readonly resolvedLibDir: string | undefined;
}): { readonly program: ts.Program; readonly optionsSignature: string } {
  const {
    input,
    rootPosix,
    compilerOptions,
    loadedConfigs,
    workspacePackages,
    moduleScopes,
    host,
    entries,
    sortedEntries,
    resolvedLibDir,
  } = params;
  const optionsSignature = computeIncrementalOptionsSignature(
    rootPosix,
    compilerOptions,
    loadedConfigs,
    workspacePackages,
    moduleScopes,
  );
  let oldProgram: ts.Program | undefined;
  let previousSourceHashes: ReadonlyMap<string, string> | undefined;
  if (
    input.incrementalState !== undefined &&
    input.incrementalState.optionsSignature === optionsSignature
  ) {
    oldProgram = input.incrementalState.program;
    previousSourceHashes = input.incrementalState.sourceHashes;
  } else if (
    input.previousProgram !== undefined &&
    isCompilerOptionsCompatibleForReuse(
      input.previousProgram.getCompilerOptions(),
      compilerOptions,
    )
  ) {
    oldProgram = input.previousProgram;
  }
  if (oldProgram !== undefined) {
    configureIncrementalSourceFileReuse(
      host,
      oldProgram,
      entries,
      previousSourceHashes,
      resolvedLibDir,
    );
  }
  const rootNames = sortedEntries.map((entry) => entry.absolutePath);
  const program = ts.createProgram({
    rootNames,
    options: compilerOptions,
    host,
    ...(oldProgram === undefined ? {} : { oldProgram }),
  });
  return { program, optionsSignature };
}

function attachNonEnumerableIncrementalState<T extends object>(
  target: T,
  state: TypeScriptIncrementalState,
): T {
  Object.defineProperty(target, "nextIncrementalState", {
    value: state,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return target;
}

function buildAnalysisRunWithIncrementalState(params: {
  readonly diagnostics: TypeScriptAdapterDiagnostic[];
  readonly capabilities: TypeScriptAdapterCapabilities;
  readonly coverageRatio: number;
  readonly assembler: GraphAssembler;
  readonly nodeInputs: SnapshotNodeInput[];
  readonly edgeInputs: SnapshotEdgeInput[];
  readonly context: AnalysisContext;
  readonly frameworkNodes: SnapshotNodeInput[];
  readonly byEdgeKey: (a: EdgeRecord, b: EdgeRecord) => number;
  readonly program: ts.Program;
  readonly sortedEntries: readonly SourceEntry[];
  readonly optionsSignature: string;
}): AnalysisRun {
  const {
    diagnostics,
    capabilities,
    coverageRatio,
    assembler,
    nodeInputs,
    edgeInputs,
    context,
    frameworkNodes,
    byEdgeKey,
    program,
    sortedEntries,
    optionsSignature,
  } = params;

  const sourceHashes = new Map<string, string>();
  for (const entry of sortedEntries) {
    sourceHashes.set(entry.absoluteKey, entry.sourceHash);
  }
  const nextIncrementalState: TypeScriptIncrementalState = {
    program,
    sourceHashes,
    optionsSignature,
  };

  const result: TypeScriptAdapterResult = attachNonEnumerableIncrementalState(
    {
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
    nextIncrementalState,
  );

  const framework: FrameworkEdgesResult = {
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
  };

  return {
    result,
    framework,
    nextIncrementalState,
  };
}

function unwrapParenthesizedExpression(
  expr: ts.Expression | undefined,
): ts.Expression | undefined {
  let current = expr;
  while (current !== undefined && ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function tryRegisterClassExpression(
  context: AnalysisContext,
  entry: SourceEntry,
  statement: ts.VariableStatement,
  declaration: ts.VariableDeclaration,
  fileNode: NodeRecord,
  addContains: (from: NodeRecord, to: NodeRecord, node: ts.Node, rationale: string) => void,
  registerWithSymbol: (symbol: ts.Symbol | undefined, record: NodeRecord) => void,
  registerMembers: (
    stmt: ts.ClassLikeDeclaration | ts.InterfaceDeclaration,
    ownerRecord: NodeRecord,
    ownerKind: NodeKind,
  ) => void,
): boolean {
  if (!ts.isIdentifier(declaration.name)) return false;
  const unwrappedInit = unwrapParenthesizedExpression(declaration.initializer);
  if (unwrappedInit === undefined || !ts.isClassExpression(unwrappedInit)) return false;

  const { assembler, checker } = context;
  const classRecord = assembler.ensureNode({
    kind: "Class",
    qualifiedName: declaration.name.text,
    relativePath: entry.relativePath,
    language: entry.language,
  });
  registerWithSymbol(checker.getSymbolAtLocation(declaration.name), classRecord);
  if (unwrappedInit.name !== undefined) {
    registerWithSymbol(checker.getSymbolAtLocation(unwrappedInit.name), classRecord);
  }
  context.declarationNodes.set(unwrappedInit, classRecord);
  addContains(
    fileNode,
    classRecord,
    statement,
    `CONTAINS: class expression ${declaration.name.text} in ${entry.relativePath}, matched by AST span evidence.`,
  );
  registerMembers(unwrappedInit, classRecord, "Class");
  return true;
}

function resolveClassExpressionOwnerName(
  context: AnalysisContext,
  owner: ts.Node,
): string | undefined {
  if (!ts.isClassExpression(owner)) return undefined;
  return context.declarationNodes.get(owner)?.node.qualifiedName ?? owner.name?.text;
}

function unwrapAliasSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): ts.Symbol | undefined {
  if (symbol === undefined) return undefined;
  let current = symbol;
  let depth = 0;
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && depth < 16) {
    const aliased = checker.getAliasedSymbol(current);
    if (aliased === undefined || aliased === current || aliased.flags === 0) {
      break;
    }
    current = aliased;
    depth += 1;
  }
  return current;
}

function extractHeritageClauses(
  context: AnalysisContext,
  entry: SourceEntry,
  sourceFile: ts.SourceFile,
): void {
  const { assembler, checker } = context;

  const emitHeritageEdge = (
    ownerRecord: NodeRecord,
    edgeKind: "INHERITS" | "IMPLEMENTS",
    heritageType: ts.ExpressionWithTypeArguments,
  ): void => {
    const rawSym = checker.getSymbolAtLocation(heritageType.expression);
    const exprSym = unwrapAliasSymbol(checker, rawSym);
    const exprDecl = exprSym?.getDeclarations()?.[0];

    let targetRecord = resolveSymbolRecord(context, entry, exprSym, exprDecl);
    let resolvedSym = exprSym;
    let resolvedDecl = exprDecl;

    if (targetRecord === undefined) {
      const resolvedType = checker.getTypeAtLocation(heritageType);
      const isTrivialErrorType =
        (resolvedType.flags &
          (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !==
        0;
      if (!isTrivialErrorType) {
        const typeSym = unwrapAliasSymbol(
          checker,
          resolvedType.getSymbol() ?? resolvedType.aliasSymbol,
        );
        const typeDecl = typeSym?.getDeclarations()?.[0];
        if (typeSym !== undefined) {
          targetRecord = resolveSymbolRecord(context, entry, typeSym, typeDecl);
          if (targetRecord !== undefined || (typeSym.getDeclarations()?.length ?? 0) > 0) {
            resolvedSym = typeSym;
            resolvedDecl = typeDecl;
          }
        }
      }
    }

    if (targetRecord !== undefined) {
      if (targetRecord.key === ownerRecord.key) return;
      assembler.addEdge({
        kind: edgeKind,
        from: ownerRecord,
        to: targetRecord,
        resolution: "verified",
        evidence: evidenceFor(
          entry,
          sourceFile,
          heritageType,
          "semantic-symbol",
          `${edgeKind}: declaration ${ownerRecord.node.qualifiedName} was resolved by the TypeChecker to symbol ${targetRecord.node.qualifiedName} (verified).`,
        ),
      });
      return;
    }

    if (
      resolvedSym !== undefined &&
      (resolvedSym.flags & ts.SymbolFlags.Alias) === 0 &&
      (resolvedSym.getDeclarations()?.length ?? 0) > 0 &&
      !isInternalDeclarationOrSymbol(context, resolvedSym, resolvedDecl)
    ) {
      const externalName = externalQualifiedName(resolvedSym, resolvedDecl);
      const externalNode = assembler.ensureNode({
        kind: "UnknownExternal",
        qualifiedName: externalName,
      });
      assembler.addEdge({
        kind: edgeKind,
        from: ownerRecord,
        to: externalNode,
        resolution: "verified",
        evidence: evidenceFor(
          entry,
          sourceFile,
          heritageType,
          "semantic-symbol",
          `${edgeKind}: declaration ${ownerRecord.node.qualifiedName} resolved to symbol ${externalName} outside the analysis set; the external source is represented as an explicit UnknownExternal node.`,
        ),
      });
      return;
    }

    const rawText = heritageType.expression.getText(sourceFile).trim();
    if (rawText.length === 0) return;
    const unresolvedNode = assembler.ensureNode({
      kind: "UnknownExternal",
      qualifiedName: rawText,
    });
    assembler.addEdge({
      kind: edgeKind,
      from: ownerRecord,
      to: unresolvedNode,
      resolution: "unresolved",
      evidence: evidenceFor(
        entry,
        sourceFile,
        heritageType,
        "ast-span",
        `${edgeKind}: heritage target '${rawText}' of ${ownerRecord.node.qualifiedName} could not be resolved; marked unresolved on an explicit UnknownExternal node.`,
      ),
    });
    assembler.addWarning(
      `${edgeKind} unresolved: ${entry.relativePath} '${ownerRecord.node.qualifiedName}' -> '${rawText}' (unresolved, UnknownExternal node created)`,
    );
  };

  const walk = (node: ts.Node): void => {
    if (
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isInterfaceDeclaration(node)
    ) {
      const clauses = node.heritageClauses;
      const ownerRecord = context.declarationNodes.get(node);
      if (clauses !== undefined && clauses.length > 0 && ownerRecord !== undefined) {
        for (const clause of clauses) {
          const edgeKind: "INHERITS" | "IMPLEMENTS" =
            clause.token === ts.SyntaxKind.ImplementsKeyword
              ? "IMPLEMENTS"
              : "INHERITS";
          for (const heritageType of clause.types) {
            emitHeritageEdge(ownerRecord, edgeKind, heritageType);
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  };

  walk(sourceFile);
}

/* ------------------------------------------------------------------ */
/* Symbol node locations & module-format scopes                         */
/* (kept at the end of the file so cited line numbers above stay fixed) */
/* ------------------------------------------------------------------ */

type NodeLocation = NonNullable<SnapshotNodeInput["location"]>;

/** 1-based line span of `node` in its file (leading trivia such as JSDoc excluded). */
function declarationSpan(
  entry: SourceEntry,
  sourceFile: ts.SourceFile,
  node: ts.Node,
): NodeLocation {
  return {
    relativePath: entry.relativePath,
    startLine: spanStart(sourceFile, node),
    endLine: spanEnd(sourceFile, node),
    sourceHash: entry.sourceHash,
  };
}

/**
 * Merges a declaration span into a file-bound symbol node's `location` and
 * returns the record. Only spans of the node's own file are accepted; File
 * nodes carry no adapter span (the indexer anchors them). Repeated
 * declarations of the same node (overloads, merged declarations, a symbol
 * seen both as a declaration and as a call target) widen the span to cover
 * all of them, so the result does not depend on visit order.
 */
function withLocation(record: NodeRecord, span: NodeLocation | undefined): NodeRecord {
  if (span === undefined || record.ref.kind === "File") return record;
  if (record.ref.relativePath === undefined || record.ref.relativePath !== span.relativePath) {
    return record;
  }
  const current = record.node.location;
  if (
    current !== undefined &&
    current.startLine <= span.startLine &&
    current.endLine >= span.endLine
  ) {
    return record;
  }
  const location: NodeLocation = {
    relativePath: span.relativePath,
    startLine: current === undefined ? span.startLine : Math.min(current.startLine, span.startLine),
    endLine: current === undefined ? span.endLine : Math.max(current.endLine, span.endLine),
    sourceHash: span.sourceHash,
  };
  const { language, attributes } = record.node;
  record.node = {
    ...record.ref,
    ...(language === undefined ? {} : { language }),
    location,
    ...(attributes === undefined ? {} : { attributes }),
  };
  return record;
}

/**
 * Loads the nearest-`package.json` `"type"` scopes for every analyzed file
 * (in-memory `packageFiles`, otherwise the guarded read-only disk reader) and
 * the compiler-host projections TypeScript uses for ESM/CommonJS detection.
 */
function loadModuleFormatScopes(
  input: TypeScriptAdapterInput,
  rootPosix: string,
  sortedEntries: readonly SourceEntry[],
): {
  readonly scopes: readonly PackageModuleScope[];
  readonly warnings: readonly string[];
  readonly projections: ReadonlyMap<string, string>;
} {
  const loaded = loadPackageModuleScopes(
    input.packageFiles,
    input.packageFiles === undefined ? input.rootDir : undefined,
    sortedEntries.map((entry) => entry.relativePath),
  );
  return {
    scopes: loaded.scopes,
    warnings: loaded.warnings,
    projections: buildPackageJsonProjections(rootPosix, loaded.scopes),
  };
}
