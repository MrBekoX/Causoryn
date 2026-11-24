import { workspacePolicyConfigSchema, type WorkspacePolicyConfig } from "@causoryn/workspace";
import { z } from "zod";

/**
 * Causoryn MCP server konfigürasyonu — TŞ v2.1 §20 `causoryn.config`
 * sözdiziminin Faz A dilimi. Workspace dilimi (allowRoots/ignore/uzantı/
 * boyut) `@causoryn/workspace` şemasından GENİŞLETİLİR; varsayılanlar
 * güvenlidir: `allowRoots: []` (explicit authorization, default deny) —
 * MCP isteği tek başına kök ekleyemez (TŞ §9/§20).
 *
 * Faz A tek workspace modelidir: `workspaceId` sunucunun tek yetkili
 * workspace'ini adlandırır; kökü `allowRoots[0]` belirler.
 */

export const causorynServerConfigSchema = workspacePolicyConfigSchema.extend({
  /** Bu sunucunun tek yetkili workspace kimliği (opaque, TŞ §10.1). */
  workspaceId: z.string().min(1).default("default"),
  /** Envanter limitleri (TŞ §20 index.maxFiles). */
  index: z
    .strictObject({
      maxFiles: z.number().int().positive().default(50_000),
    })
    // Not: zod v4 `.default({})` iç şemayı parse etmez — default değer
    // bütünsel verilmelidir (aksi halde maxFiles undefined kalır).
    .default({ maxFiles: 50_000 }),
  /** Sonuç limitleri (TŞ §20 results.maxNodes; maxSymbols Faz A, maxDepth
   * sprint-2 B5: causoryn_get_symbol_context derinlik tavanı, maxPaths
   * sprint-2 B4: causoryn_trace_execution yol sayısı tavanı — TŞ §20
   * resource budget "maxDepth, maxPaths" dilimleri). */
  results: z
    .strictObject({
      maxNodes: z.number().int().positive().default(250),
      maxSymbols: z.number().int().positive().default(100),
      maxDepth: z.number().int().positive().default(3),
      maxPaths: z.number().int().positive().default(50),
    })
    .default({ maxNodes: 250, maxSymbols: 100, maxDepth: 3, maxPaths: 50 }),
  /** Başlangıçta otomatik indeksleme; false → araçlar INDEX_NOT_READY döner. */
  autoIndex: z.boolean().default(true),
  /**
   * Export çıktı beyanı (sprint-3 C6/C8; TŞ §16 "yalnızca explicit izinli
   * output dizini, atomik write"). Default BOŞ listedir → default deny:
   * causoryn_export_documentation EXPORT_NOT_ALLOWED döner, hiçbir
   * dizine yazılmaz. Beyanlı dizinler diskte VAR OLMALIDIR (OutputAccessPolicy
   * başlangıçta realpath doğrular; çözümlenemeyen beyan sunucuyu düşürür —
   * güven kaynağı kurulamaz).
   */
  output: z
    .strictObject({
      allowedOutputDirs: z.array(z.string()).default([]),
    })
    .default({ allowedOutputDirs: [] }),
  /**
   * Wiki veri kökü beyanı (sprint-4 W5; TŞ §16A.8: wiki_build "yalnızca
   * izinli Causoryn data-root'a yazar, kaynak dosyalara yazamaz"; TŞ §20
   * CAUSORYN_DATA_DIR ilkesi). Beyan yazma hedefi SQLite dosyasının tam
   * yoludur. Default beyansız → default deny: causoryn_wiki_build hiçbir
   * yere yazamaz (PATH_DENIED), wiki okuma araçları INDEX_NOT_READY döner.
   * Beyan başlangıçta doğrulanır: mutlak yol, üst dizin mevcut ve YETKİLİ
   * WORKSPACE KÖKÜNÜN DIŞINDA olmalıdır (kaynak ağacına yazım yasak,
   * ADR-008) — ihlal CausorynConfigError ile sunucuyu düşürür (güven
   * kaynağı kurulamıyorsa sessiz devam yoktur; OutputAccessPolicy ile aynı
   * disiplin).
   */
  wiki: z
    .strictObject({
      dataDbPath: z.string().min(1).optional(),
    })
    .default({}),
  /**
   * Kalıcı graph/index veri kökü beyanı (TŞ §9 SQLite GraphRepository +
   * symbol_fts; TŞ §20 CAUSORYN_DATA_DIR ilkesi; ADR-008 kaynak ağacı
   * salt-okunurluğu). Beyan yazma hedefi SQLite dosyasının tam yoludur.
   * Default beyansız → süreç-içi InMemoryGraphRepository kullanılır (diskte
   * hiçbir yere yazılmaz). Beyan başlangıçta doğrulanır: mutlak yol, null
   * byte yok, allowRoots dolu, üst dizin mevcut dizin ve hem sözcüksel hem
   * gerçek yol (realpath) açısından TÜM yetkili workspace köklerinin
   * DIŞINDA olmalıdır — ihlal CausorynConfigError ile sunucuyu düşürür
   * (fail-closed; wiki.dataDbPath ile birebir aynı güvenlik sözleşmesi).
   */
  storage: z
    .strictObject({
      dataDbPath: z.string().min(1).optional(),
    })
    .default({}),
  /** Optional default tool profile (e.g., "core", "full", "wiki", "history", or comma-separated). */
  toolProfile: z.string().min(1).optional(),
});

export type CausorynServerConfig = z.infer<typeof causorynServerConfigSchema>;

export type { WorkspacePolicyConfig };

/** Konfigürasyon ayrıştırma hatası; sorun listesi stderr'e raporlanır. */
export class CausorynConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid Causoryn server configuration: ${issues.join("; ")}`);
    this.name = "CausorynConfigError";
    this.issues = issues;
  }
}

/** Şemayı doğrular, default'ları uygular; geçersizse CausorynConfigError. */
export function parseCausorynServerConfig(input: unknown): CausorynServerConfig {
  const result = causorynServerConfigSchema.safeParse(input);
  if (result.success) {
    return result.data as CausorynServerConfig;
  }
  const issues = result.error.issues.map(
    (issue) =>
      `${issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)"}: ${issue.message}`,
  );
  throw new CausorynConfigError(issues);
}

// Not (denetim bulgusu düzeltmesi): `configHashOf` buradan KALDIRILDI.
// snapshot.configHash'in tek gerçeklemesi IndexService'tedir
// (packages/indexing/src/index-service.ts — indeksi etkileyen konfigürasyon
// alanlarıyla; results limitleri karmaya dahil edilmez). İki farklı "config
// hash" tanımının yürürlükte kalması yerine tek yetkili gerçekleme korunur.
