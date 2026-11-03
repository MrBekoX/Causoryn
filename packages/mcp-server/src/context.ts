import { InMemoryGraphRepository } from "@causoryn/graph";
import type { GraphRepository } from "@causoryn/graph";
import { IndexService } from "@causoryn/indexing";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { parseCausorynServerConfig, type CausorynServerConfig } from "./config.js";

/**
 * Uygulama bağlamı: konfigürasyon → WorkspaceAccessPolicy → GraphRepository
 * → IndexService (+ isteğe bağlı otomatik ilk indeksleme). MCP handler'ları
 * yalnızca bu bağlamın uygulama servis arayüzlerini tüketir; parser detayı
 * bu pakete sızmaz (wiki/architecture.md sınır 3).
 *
 * Loglar her zaman enjekte edilen logger'a gider; stdio modunda bu
 * console.error'dur (stderr) — stdout YALNIZCA MCP protokolüdür (TŞ §10.1).
 */

export interface CausorynContext {
  readonly config: CausorynServerConfig;
  readonly policy: WorkspaceAccessPolicy;
  readonly repository: GraphRepository;
  readonly indexService: IndexService;
  /** stderr'e yazan logger (stdio modunda console.error). */
  readonly logger: (message: string) => void;
}

export interface ContextOverrides {
  readonly repository?: GraphRepository;
  readonly clock?: () => string;
  readonly logger?: (message: string) => void;
}

/**
 * Ham konfigürasyonu ayrıştırır, politikayı kurar, depoyu ve IndexService'i
 * hazırlar. `autoIndex` açık ve allowRoot doluysa ilk indeksleme koşusu
 * yapılır. Konfigürasyon geçersizse CausorynConfigError, indeksleme
 * reddiyse IndexingError fırlatır (çünkü tek workspace'in ilk indeksi
 * sunucunun kullanılabilirlik koşuludur).
 */
export function createCausorynContext(
  rawConfig: unknown,
  overrides: ContextOverrides = {},
): CausorynContext {
  const config = parseCausorynServerConfig(rawConfig);
  const policy = WorkspaceAccessPolicy.create({
    allowRoots: [...config.allowRoots],
    ignore: [...config.ignore],
    extraIgnore: [...config.extraIgnore],
    binaryExtensions: [...config.binaryExtensions],
    extensionFilterMode: config.extensionFilterMode,
    allowedExtensions: [...config.allowedExtensions],
    maxFileBytes: config.maxFileBytes,
  });
  const clock = overrides.clock ?? (() => new Date().toISOString());
  const logger =
    overrides.logger ??
    ((message: string): void => {
      console.error(message);
    });
  const repository = overrides.repository ?? new InMemoryGraphRepository();
  const indexService = new IndexService({
    workspaceId: config.workspaceId,
    policy,
    repository,
    clock,
    limits: { maxFiles: config.index.maxFiles },
  });

  if (config.autoIndex && config.allowRoots.length > 0) {
    const run = indexService.runIndex(config.allowRoots[0] as string);
    logger(
      `index hazır: workspace=${config.workspaceId} snapshot=${run.snapshotId} files=${String(run.fileCount)} state=${run.state}`,
    );
  }

  return { config, policy, repository, indexService, logger };
}
