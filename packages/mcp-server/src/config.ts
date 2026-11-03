import { canonicalJson, sha256Hex, utf8Encode, type JsonValue } from "@causoryn/domain";
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
  /** Sonuç limitleri (TŞ §20 results.maxNodes; maxSymbols Faz A eklentisi). */
  results: z
    .strictObject({
      maxNodes: z.number().int().positive().default(250),
      maxSymbols: z.number().int().positive().default(100),
    })
    .default({ maxNodes: 250, maxSymbols: 100 }),
  /** Başlangıçta otomatik indeksleme; false → araçlar INDEX_NOT_READY döner. */
  autoIndex: z.boolean().default(true),
});

export type CausorynServerConfig = z.infer<typeof causorynServerConfigSchema>;

export type { WorkspacePolicyConfig };

/** Konfigürasyon ayrıştırma hatası; sorun listesi stderr'e raporlanır. */
export class CausorynConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Causoryn server konfigürasyonu geçersiz: ${issues.join("; ")}`);
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
      `${issue.path.length > 0 ? issue.path.map(String).join(".") : "(kök)"}: ${issue.message}`,
  );
  throw new CausorynConfigError(issues);
}

/**
 * Deterministik konfigürasyon karması — snapshot.configHash girdisi
 * (aynı konfigürasyon → aynı karma; TŞ §8 invariant vi).
 */
export function configHashOf(config: CausorynServerConfig): string {
  const hashInput: JsonValue = {
    workspaceId: config.workspaceId,
    allowRoots: [...config.allowRoots],
    ignore: [...config.ignore],
    extraIgnore: [...config.extraIgnore],
    binaryExtensions: [...config.binaryExtensions],
    extensionFilterMode: config.extensionFilterMode,
    allowedExtensions: [...config.allowedExtensions],
    maxFileBytes: config.maxFileBytes,
    maxFiles: config.index.maxFiles,
    maxNodes: config.results.maxNodes,
    maxSymbols: config.results.maxSymbols,
  };
  return sha256Hex(utf8Encode(canonicalJson(hashInput)));
}
