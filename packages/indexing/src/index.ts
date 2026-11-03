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
 */
import { TS_ADAPTER_ANALYZER_ID, TS_ADAPTER_VERSION } from "@causoryn/adapter-typescript";

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

/**
 * Adapter yetenek beyanı (uygulama düzeyi metadata; TŞ §7).
 * `frameworkLinkers: "yok"` — Faz A'da L3 framework linker'ları aktif
 * değil; TS adapter yalnızca L1 (AST declaration/import) + L2 (TypeChecker
 * sembol çözümlemesi) + route kalıbı (ROUTES_TO) sağlar.
 */
export interface IndexedAdapterInfo {
  readonly language: "typescript";
  readonly analyzerId: typeof TS_ADAPTER_ANALYZER_ID;
  readonly version: typeof TS_ADAPTER_VERSION;
  readonly levels: {
    readonly astParse: "L1";
    readonly symbolResolution: "L2";
    readonly frameworkLinkers: "yok";
  };
  readonly source: "adapters/typescript";
}

/** Faz A'da kayıtlı dil adapter'ları (get_capabilities bu metadata'yı sunar). */
export const INDEXED_ADAPTERS: readonly IndexedAdapterInfo[] = [
  {
    language: "typescript",
    analyzerId: TS_ADAPTER_ANALYZER_ID,
    version: TS_ADAPTER_VERSION,
    levels: {
      astParse: "L1",
      symbolResolution: "L2",
      frameworkLinkers: "yok",
    },
    source: "adapters/typescript",
  },
];
