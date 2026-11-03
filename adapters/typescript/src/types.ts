/**
 * @causoryn/adapter-typescript — genel sözleşme tipleri (TŞ v2.1 §7, §7.1, §8).
 *
 * Adapter girdisi bellek-içi kaynak çantasıdır: adapter KULLANICI
 * WORKSPACE'İNE KENDİ YAZMAZ, salt-okunur iş yapar (ADR-008). `rootDir`
 * yalnızca module-resolution çapası ve sanal mutlak yol ad alanıdır;
 * lib/.d.ts ve harici modül çözümlemesi TS Compiler API'nin salt-okunur
 * `ts.sys` erişimi üzerinden yapılır.
 *
 * Çıktı, `packages/domain`'in `createSnapshot` girdi sözleşmesiyle
 * birebir uyumludur (SnapshotNodeInput / SnapshotEdgeInput); adapter hiçbir
 * zaman kendi şemasını icat etmez ve ID üretmez — ID'ler domain
 * katmanında deterministik olarak üretilir (TŞ §8 invariant iii).
 */

import type {
  SnapshotEdgeInput,
  SnapshotNodeInput,
} from "@causoryn/domain";

/** Adapter çıktılarında sabit analyzer kimliği (TŞ §8 Evidence.analyzerId). */
export const TS_ADAPTER_ANALYZER_ID = "ts-adapter";

/** Paket sürümü; Evidence.analyzerVersion'a yazılır. */
export const TS_ADAPTER_VERSION = "0.1.0";

/** Adapter'a verilen tek kaynak dosya (bellek-içi, salt-okunur). */
export interface TsAdapterSourceFile {
  /** Workspace-relative POSIX yolu ("src/app.ts"); "..", mutlak yol yasak. */
  readonly relativePath: string;
  readonly content: string;
}

/** `analyzeTypeScriptProgram` girdisi. */
export interface TypeScriptAdapterInput {
  /** Opaque workspace kimliği; boş/boşluk reddedilir. */
  readonly workspaceId: string;
  /**
   * Module-resolution çapası (mutlak dizin). Adapter bu dizine YAZMAZ;
   * relative import çözümlemesi ve node_modules taraması bu kökten yürür.
   */
  readonly rootDir: string;
  readonly sources: readonly TsAdapterSourceFile[];
}

/** Adapter yetenek beyanı (TŞ §7: "capabilities"). */
export interface TypeScriptAdapterCapabilities {
  readonly astParse: true;
  readonly symbolResolution: true;
  readonly containsEdges: true;
  readonly importEdges: true;
  readonly callEdges: true;
  /** Route tespiti: `<router>.<verb>("/path", handler)` çağrı kalıbı. */
  readonly routeDetection: "http-verb-call-pattern";
  /** L3 framework linker'ları (Next.js/DI vb.) bu dilimde yok. */
  readonly frameworkLinkers: false;
}

/** Tek dosyadan toplanan tanı (parse/semantic). Satır 1 tabanlıdır. */
export interface TypeScriptAdapterDiagnostic {
  readonly relativePath: string;
  readonly code: string;
  readonly message: string;
  /** Bilinmiyorsa 0. */
  readonly line: number;
}

/** `analyzeTypeScriptProgram` çıktısı; `createSnapshot` girdisine hazırdır. */
export interface TypeScriptAdapterResult {
  readonly analyzerId: typeof TS_ADAPTER_ANALYZER_ID;
  readonly analyzerVersion: string;
  /** Tanı yoksa "ready", herhangi bir dosyada sorun varsa "partial". */
  readonly state: "ready" | "partial";
  readonly capabilities: TypeScriptAdapterCapabilities;
  /** verified kenar / toplam kenar (4 ondalık); kenar yoksa 0. */
  readonly coverageRatio: number;
  /** Bu dilimde modellenmeyen dil yapıları (TŞ §7 "unsupportedConstructs"). */
  readonly unsupportedConstructs: readonly string[];
  readonly warnings: readonly string[];
  readonly diagnostics: readonly TypeScriptAdapterDiagnostic[];
  /** Domain `createSnapshot` girdisiyle birebir uyumlu node kümesi. */
  readonly nodes: readonly SnapshotNodeInput[];
  /** Domain `createSnapshot` girdisiyle birebir uyumlu kenar kümesi. */
  readonly edges: readonly SnapshotEdgeInput[];
}
