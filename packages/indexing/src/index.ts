/**
 * @causoryn/indexing — IndexCoordinator (Faz A dilimi, sprint-1 görev 6).
 *
 * Minimal pipeline: dosya envanteri (WorkspaceAccessPolicy ile) →
 * TypeScript Language Adapter → graph inşası (domain deterministik ID'leri)
 * → atomik snapshot publish (TŞ v2.1 §9, §25/4-5).
 *
 * Bağımlılık sınırları (wiki/architecture.md): bu paket workspace/domain/
 * graph/adapter-typescript'e bağlıdır; MCP paketini import ETMEZ. Adapter
 * metadata'sı (analyzerId/version/levels) uygulama düzeyi bilgi olarak
 * buradan yayımlanır — mcp-server parser paketini doğrudan import etmez.
 *
 * Invalidation (FS watcher, 300–1000 ms debounce) sonraki dilimlere
 * aittir; bu dilimde yeniden indeksleme `runIndex` çağrısıyla yapılır.
 * Sprint-2 B6: `IndexJobManager`, refresh_index tool'u için `runIndex`
 * pipeline'ını in-process async iş olarak sarmalar (TŞ §10.2
 * causoryn_refresh_index "Yeni snapshot işi"). Sprint-2 B7 (Live
 * Architecture, TŞ §9): `WorkspaceWatcher` (node:fs.watch, policy süzgeci,
 * debounce, fingerprint no-op skip, invalidation) + `IndexService.runIncrementalIndex`
 * (karma tabanlı karar, atomik publish, eski snapshot stale=true).
 */
import {
  TS_ADAPTER_ANALYZER_ID,
  TS_ADAPTER_FRAMEWORK_LINKERS,
  TS_ADAPTER_VERSION,
} from "@causoryn/adapter-typescript";

export { IndexingError } from "./errors.js";
export type { IndexingErrorCode } from "./errors.js";
export { collectInventory } from "./inventory.js";
export type { InventoryEntry } from "./inventory.js";
export { INDEXING_VERSION, IndexService } from "./index-service.js";
export type {
  IndexDiagnostic,
  IndexLimits,
  IndexRunResult,
  IndexServiceOptions,
} from "./index-service.js";
export { IndexJobManager } from "./job-manager.js";
export type {
  IndexJobError,
  IndexJobManagerOptions,
  IndexJobMode,
  IndexJobRecord,
  IndexJobStatus,
} from "./job-manager.js";
export {
  hashWorkspaceFile,
  WATCHER_DEBOUNCE_DEFAULT_MS,
  WATCHER_DEBOUNCE_MAX_MS,
  WATCHER_DEBOUNCE_MIN_MS,
  WorkspaceWatcher,
} from "./watcher.js";
export type {
  WatchFactory,
  WatchHandle,
  WorkspaceWatcherOptions,
  WorkspaceWatcherState,
  WorkspaceWatcherStats,
} from "./watcher.js";

/**
 * Adapter linker beyanından türetilen metadata etiketi (denetim bulgusu 1
 * düzeltmesi): hiçbiri yoksa "yok", varsa '+' ile birleşik linker
 * kimlikleri (ör. "express+nextjs"). Sabit kopya TUTULMAZ — adapter'ın
 * TS_ADAPTER_FRAMEWORK_LINKERS beyanıyla birlikte sürüklenir; aksi halde
 * get_capabilities bayat "yok" değerini MCP yüzeyine taşır.
 */
const FRAMEWORK_LINKERS_LABEL =
  TS_ADAPTER_FRAMEWORK_LINKERS.length === 0
    ? "yok"
    : TS_ADAPTER_FRAMEWORK_LINKERS.join("+");

/**
 * Adapter yetenek beyanı (uygulama düzeyi metadata; TŞ §7).
 * TS adapter: L1 (AST declaration/import) + L2 (TypeChecker sembol
 * çözümlemesi) + route kalıbı (ROUTES_TO); sprint-2 B3 ile framework
 * linker'ları aktif — `frameworkLinkers` adapter beyanından türetilir.
 */
export interface IndexedAdapterInfo {
  readonly language: "typescript";
  readonly analyzerId: typeof TS_ADAPTER_ANALYZER_ID;
  readonly version: typeof TS_ADAPTER_VERSION;
  readonly levels: {
    readonly astParse: "L1";
    readonly symbolResolution: "L2";
    /** "yok" veya '+' ile birleşik aktif linker kimlikleri (ör. "express+nextjs"). */
    readonly frameworkLinkers: string;
  };
  readonly source: "adapters/typescript";
}

/** Kayıtlı dil adapter'ları (get_capabilities bu metadata'yı sunar). */
export const INDEXED_ADAPTERS: readonly IndexedAdapterInfo[] = [
  {
    language: "typescript",
    analyzerId: TS_ADAPTER_ANALYZER_ID,
    version: TS_ADAPTER_VERSION,
    levels: {
      astParse: "L1",
      symbolResolution: "L2",
      frameworkLinkers: FRAMEWORK_LINKERS_LABEL,
    },
    source: "adapters/typescript",
  },
];
