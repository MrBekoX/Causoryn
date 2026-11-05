import { InMemoryGraphRepository } from "@causoryn/graph";
import type { GraphRepository } from "@causoryn/graph";
import { IndexJobManager, IndexService } from "@causoryn/indexing";
import { OutputAccessPolicy, WorkspaceAccessPolicy } from "@causoryn/workspace";

import { parseCausorynServerConfig, type CausorynServerConfig } from "./config.js";

/**
 * Uygulama bağlamı: konfigürasyon → WorkspaceAccessPolicy → GraphRepository
 * → IndexService → IndexJobManager (+ isteğe bağlı otomatik ilk indeksleme)
 * → OutputAccessPolicy (sprint-3 C6/C8: export çıktı yetkilendirmesi).
 * MCP handler'ları yalnızca bu bağlamın uygulama servis arayüzlerini tüketir;
 * parser detayı bu pakete sızmaz (wiki/architecture.md sınır 3).
 *
 * IndexJobManager (sprint-2 B6): causoryn_refresh_index'in in-process async
 * snapshot işlerini yönetir (TŞ §10.2); başlangıç autoIndex'i KAPSAMAZ —
 * o, sunucu kullanılabilirlik koşulu olarak senkron koşmaya devam eder.
 *
 * OutputAccessPolicy (sprint-3 C6): config.output.allowedOutputDirs beyanı
 * boşsa NULL'dur (default deny) — causoryn_export_documentation o durumda
 * EXPORT_NOT_ALLOWED döner, hiçbir dizine yazmaz. Beyan varsa politika
 * başlangıçta kurulur; çözümlenemeyen/bulunmayan beyanlı dizin
 * OutputPolicyError ile sunucu başlangıcını düşürür (güven kaynağı
 * kurulamıyorsa sessiz devam yoktur — WorkspaceAccessPolicy ile aynı ilke).
 *
 * Loglar her zaman enjekte edilen logger'a gider; stdio modunda bu
 * console.error'dur (stderr) — stdout YALNIZCA MCP protokolüdür (TŞ §10.1).
 */

export interface CausorynContext {
  readonly config: CausorynServerConfig;
  readonly policy: WorkspaceAccessPolicy;
  readonly repository: GraphRepository;
  readonly indexService: IndexService;
  readonly jobManager: IndexJobManager;
  /**
   * Export çıktı yetkilendirmesi (sprint-3 C6). Beyanlı output dizini yoksa
   * null — export aracı EXPORT_NOT_ALLOWED döner (default deny).
   */
  readonly outputPolicy: OutputAccessPolicy | null;
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
  // Sprint-2 B6: refresh_index işleri için yönetici; jobId per-manager
  // monoton sayaçtır (işletim kaydı — snapshot determinizmine girmez).
  const jobManager = new IndexJobManager({
    indexService,
    policy,
    clock,
  });

  // Sprint-3 C6/C8: export çıktı yetkilendirmesi — explicit beyanlı liste
  // (default [] → null politika = default deny, EXPORT_NOT_ALLOWED).
  const outputPolicy =
    config.output.allowedOutputDirs.length === 0
      ? null
      : OutputAccessPolicy.create([...config.output.allowedOutputDirs]);

  if (config.autoIndex && config.allowRoots.length > 0) {
    const run = indexService.runIndex(config.allowRoots[0] as string);
    logger(
      `index hazır: workspace=${config.workspaceId} snapshot=${run.snapshotId} files=${String(run.fileCount)} state=${run.state}`,
    );
  }

  return {
    config,
    policy,
    repository,
    indexService,
    jobManager,
    outputPolicy,
    logger,
  };
}
