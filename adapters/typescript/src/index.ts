/**
 * @causoryn/adapter-typescript — TypeScript Language Adapter.
 *
 * Sorumluluk alanı (TŞ v2.1 §6, §7, §7.1, Sprint-1 görev 4): TypeScript
 * Compiler API (Program + AST + TypeChecker) ile AST parse ve symbol
 * resolution. Çıktı, `@causoryn/domain` şemalarının `createSnapshot`
 * girdi sözleşmesiyle birebir uyumlu SnapshotNodeInput/SnapshotEdgeInput
 * kümesidir; ID üretimi domain katmanına aittir (TŞ §8 invariant iii).
 *
 * Bağımlılık sınırı (wiki/architecture.md): adapter motoru çökertmez —
 * tek dosyadaki parse hatası toplanıp `diagnostics` + `state: "partial"`
 * olarak raporlanır; diğer dosyaların çıkarımı sürer (TŞ §5.1).
 *
 * Resolution disiplini (TŞ §8): checker ile çözümlenen → `verified`,
 * aday eşleşme → `heuristic`, çözülemeyen → `unresolved` ve uydurulmuş
 * kenar YOK; dış hedefler açık `UnknownExternal` node'dur (invariant ii:
 * dangling edge yok, dış kaynaklar açık node).
 */

export {
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

export {
  analyzeTypeScriptProgram,
  analyzeTypeScriptProgramWithFrameworks,
  extractFrameworkEdges,
} from "./analyzer.js";
