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
  TS_ADAPTER_VERSION,
  type TypeScriptAdapterCapabilities,
  type TypeScriptAdapterDiagnostic,
  type TypeScriptAdapterInput,
  type TypeScriptAdapterResult,
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
function canonicalPath(p: string): string {
  const posix = toPosix(p);
  const lower = posix.toLowerCase();
  const drivePrefix = /^[a-z]:/.test(lower) ? lower.slice(0, 2) : undefined;
  const body = drivePrefix === undefined ? lower : lower.slice(2);
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
  /** Kanonik sanal mutlak yol; compiler host anahtarları. */
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
  }): void {
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
}

/* ------------------------------------------------------------------ */
/* Ana analiz fonksiyonu                                               */
/* ------------------------------------------------------------------ */

export function analyzeTypeScriptProgram(
  input: TypeScriptAdapterInput,
): TypeScriptAdapterResult {
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
    const absoluteKey = canonicalPath(`${rootPosix}/${relativePath}`);
    if (entries.has(absoluteKey) || entryByRelativePath.has(relativePath)) {
      throw new DomainError(
        "adapter/duplicate-source-path",
        `Aynı kaynak yolu iki kez verildi: ${source.relativePath}`,
      );
    }
    const entry: SourceEntry = {
      relativePath,
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
  const host = ts.createCompilerHost(compilerOptions, /*setParentNodes*/ true);
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
  // adaya hiç ulaşmadan düşer (denetim bulgusu kök nedeni — kanıt:
  // minimal resolutionHost'ta çözülür, directoryExists eklenince düşer).
  const memoryDirectories = new Set<string>();
  for (const key of entries.keys()) {
    let slash = key.indexOf("/");
    while (slash > 0) {
      memoryDirectories.add(key.slice(0, slash));
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
  const rootNames = sortedEntries.map((entry) => entry.absoluteKey);
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
  for (const entry of sortedEntries) {
    runPhase(entry, (sourceFile) =>
      extractCallsAndRoutes(context, entry, sourceFile),
    );
  }

  // 4) Kanonik düzende çıktı (TŞ §8 invariant iv/vi).
  const nodeInputs = [...assembler.nodes.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((record) => record.node);

  const edgeInputs: SnapshotEdgeInput[] = [...assembler.edges.values()]
    .sort((a, b) => {
      const aKey = `${a.kind}::${a.from.key}::${a.to.key}`;
      const bKey = `${b.kind}::${b.from.key}::${b.to.key}`;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    })
    .map((record) => ({
      kind: record.kind,
      from: record.from.ref,
      to: record.to.ref,
      resolution: record.resolution,
      evidence: [...record.evidence.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map((pair) => pair[1]),
      ...(record.ambiguity === undefined ? {} : { ambiguity: record.ambiguity }),
    }));

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
    frameworkLinkers: false,
  };

  return {
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
  };
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

  const specifiers: Array<{ node: ts.StringLiteralLike; text: string }> = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (moduleSpecifier !== undefined && ts.isStringLiteralLike(moduleSpecifier)) {
        specifiers.push({ node: moduleSpecifier, text: moduleSpecifier.text });
      }
    }
  }

  for (const specifier of specifiers) {
    const record = classifyModuleSpecifier(context, entry.absoluteKey, specifier.text);

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

    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      const ref = callerRecordForFunctionLike(context, entry, node);
      if (ref !== undefined) currentCaller = ref;
    }

    if (ts.isCallExpression(node)) {
      tryRoutePattern(context, entry, sourceFile, node);
      emitCallEdge(context, entry, sourceFile, node, currentCaller);
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

/** `<x>.<verb>("/path", handler)` kalıbını Endpoint + ROUTES_TO'ya çevirir. */
function tryRoutePattern(
  context: AnalysisContext,
  entry: SourceEntry,
  sourceFile: ts.SourceFile,
  call: ts.CallExpression,
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
    attributes: { method: verb, path: pathText },
  });

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

  if (handlerRecord !== undefined) {
    assembler.addEdge({
      kind: "ROUTES_TO",
      from: endpoint,
      to: handlerRecord,
      resolution: "verified",
      evidence: evidenceFor(
        entry,
        sourceFile,
        call,
        "route-attribute",
        `ROUTES_TO: '${verb} ${pathText}' route kaydı ${handlerRecord.node.qualifiedName} handler'ına TypeChecker ile çözümlendi.`,
      ),
    });
    return true;
  }

  if (handlerSymbol !== undefined && (handlerDeclaration !== undefined)) {
    // Handler analiz setinin dışında bildirildi: açık external node.
    const externalHandler = assembler.ensureNode({
      kind: "UnknownExternal",
      qualifiedName: handlerSymbol.getName(),
    });
    assembler.addEdge({
      kind: "ROUTES_TO",
      from: endpoint,
      to: externalHandler,
      resolution: "verified",
      evidence: evidenceFor(
        entry,
        sourceFile,
        call,
        "route-attribute",
        `ROUTES_TO: '${verb} ${pathText}' route kaydındaki handler analiz seti dışındaki ${handlerSymbol.getName()} sembolüne çözümlendi; açık UnknownExternal node kullanıldı.`,
      ),
    });
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
