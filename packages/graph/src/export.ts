import { renameSync, unlinkSync, writeFileSync } from "node:fs";

import { z } from "zod";

import { escapeMermaidLabel, snapshotCanonicalJson, type SnapshotGraph } from "@causoryn/domain";
import { OutputAccessPolicy } from "@causoryn/workspace";

import { GraphRepositoryError } from "./errors.js";
import { serializeSnapshotContentSet } from "./timeline.js";
import type { ArchitectureAnnotations } from "./architecture-annotations.js";
import {
  EXPORT_DOCUMENTATION_VIEWS,
  exportDocumentationViewSchema,
  prepareArchitecture,
  renderArchitectureMermaidFromPrepared,
  serializeArchitectureHtmlFromPrepared,
  serializeArchitectureJsonFromPrepared,
  serializeArchitectureMarkdownFromPrepared,
  serializeInteractiveArchitectureHtmlFromPrepared,
  type ExportDocumentationView,
} from "./architecture-export.js";
import type { ArchitectureProjectionOptions } from "./architecture-projection.js";

/**
 * causoryn_export_documentation çekirdeği — TŞ v2.1 §16 "Onboarding,
 * görselleştirme ve export" (Sayfa 14): "Export JSON, Mermaid, Markdown,
 * offline/self-contained HTML... Export güvenliği: yalnızca explicit izinli
 * output dizini, atomik write, HTML escaping, mümkünse offline CSP; remote
 * CDN / analytics yok" (sprint-3 C6; wiki/mcp-tools.md yazma izin matrisi:
 * "export_documentation: yalnızca explicit izinli output klasörü").
 *
 * Katman ayrımı (görev sözleşmesi 4):
 * - SAF SERIALIZER'LAR: serializeDocumentationJson/Markdown/Mermaid/Html ve
 *   dispatcher serializeDocumentation — girdi yalnızca SnapshotGraph;
   * saat okumaz, rastgelelik kullanmaz, dosya sistemine dokunmaz. Tüm
 *   diziler id'ye göre kanonik sıraya alınır; aynı girdi iki koşumda bit
 *   düzeyinde aynı çıktıyı üretir (TŞ §8 invariant vi'nin export
 *   karşılığı). Girdi dizisi sırası karıştırılsa bile çıktı aynıdır.
 * - YAZMA KATMANI: writeDocumentation — hedef, @causoryn/workspace
 *   OutputAccessPolicy (sprint-3 C6'da eklenen explicit-beyanlı output
 *   dizin yetkilendirmesi) ile denetlenir; reddedilen hedefe hiçbir dosya
 *   yazılmaz. Yazma atomiktir: önce aynı dizinde `.tmp` dosyasına yazılır,
 *   sonra rename ile hedefe taşınır (yarım dosya görünmez).
 *
 * HTML güvenliği (TŞ §16 + §16A.9): TÜM dinamik değerler escapeHtml'den
 * geçer; belgede <script>, harici kaynak, CDN URL'si YOKTUR. CSP meta
 * etiketi: `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none';
 * form-action 'none'` — script/fetch/frame/connection yüklerini default
 * kapatır; yalnızca gömülü <style> bloğuna istisna tanır. Kaynak yolları
 * metin olarak gösterilir; keyfi file:// link üretilmez (TŞ §16A.9).
 *
 * Mermaid ayrımı (TŞ §16 "resolved/heuristic/unresolved edge tipleri ayrı
 * işaretlenir"): kenar etiketi daima `KIND/resolution` taşır; ok biçimi
 * verified → düz (`-->`), heuristic/unresolved → kesikli (`-.->`). Ayrım
 * metinsel olarak daima mevcuttur.
 *
 * Hata kodları: bu modül `export/...` ön ekli GraphRepositoryError üretir
 * (packages/graph/src/errors.ts başlığındaki ad alanı listesine C6 ile
 * dördüncü ön ek eklenmiştir — başlık güncellemesi orkestratör notudur):
 * - export/invalid-format: şemayı geçmeyen format
 * - export/dangling-edge: metin serializer'larında bilinmeyen kenar ucu
 *   (savunma katmanı; geçerli snapshot'ta oluşmaz — TŞ §8 invariant ii)
 * - export/write-failed: yetkilendirilmiş hedefe yazma/taşıma hatası
 * - export/output-not-authorized: hedef dizin beyanlı output listesinde
 *   değil → MCP yüzeyinde TŞ §10.1 SABİT kodu EXPORT_NOT_ALLOWED ile
 *   eşlenir (takım denetimi kararı: YENİ uzantı kodu OUTPUT_NOT_AUTHORIZED
 *   İSTENMEDİ — K-008 örüntüsünün önkoşulu "TŞ listesinde uygun kod yok"
 *   sağlanmazdı; eşleme packages/mcp-server/src/services-architecture.ts'te,
 *   test faz-c-tools.test.ts'te. wiki/decisions.md yönetişim ADR girişi
 *   orkestratör kalemidir)
 * - export/output-path-denied: null byte / ayraç / ".." / realpath kaçışı
 *   → mevcut PATH_DENIED ile eşlenir (workspace karar kodu mesaj taşınır).
 */

/** Export formatları (görev sözleşmesi 2): MCP yüzeyindeki `format` alanı. */
export const EXPORT_DOCUMENTATION_FORMATS = [
  "json",
  "markdown",
  "mermaid",
  "html",
  "snapshot",
] as const;

export type ExportDocumentationFormat = (typeof EXPORT_DOCUMENTATION_FORMATS)[number];

/** Format doğrulaması (Zod enum) — MCP zarfı şemasında bire bir kullanılır. */
export const exportDocumentationFormatSchema = z.enum(EXPORT_DOCUMENTATION_FORMATS);

/** Format başına varsayılan çıktı dosya adı (fileName verilmezse). */
export const EXPORT_DEFAULT_FILE_NAMES: Readonly<
  Record<ExportDocumentationFormat, string>
> = {
  json: "causoryn-architecture.json",
  markdown: "causoryn-architecture.md",
  mermaid: "causoryn-architecture.mmd",
  html: "causoryn-architecture.html",
  snapshot: "architecture-snapshot.json",
};

/** `view="interactive"` (yalnızca `format="html"`) için varsayılan çıktı dosya adı. */
export const EXPORT_INTERACTIVE_HTML_FILE_NAME =
  "causoryn-architecture-interactive.html";

/* ------------------------------------------------------------------ */
/* Kaçış yardımcıları (saf, deterministik)                             */
/* ------------------------------------------------------------------ */

/** HTML metin kaçışı: tüm dinamik değerler bu fonksiyondan geçer. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\|/g, "&#124;");
}

/**
 * Markdown tablo hücresi kaçışı: GFM hücre ayracı, satır sonları ve
 * link/HTML metakarakterleri. Hücre değerleri (dosya yolları, sembol adları,
 * rationale) güvenilmez depo verisidir (TŞ §19): kaçırılmayan
 * `![x](https://...)` dizgisi ağa erişimli GFM görüntüleyicide beacon/link,
 * kaçırılmayan `<...>` ham inline HTML olarak işlenir. Backslash escape
 * GFM'in ASCII noktalama kaçışıdır; içerik okunur kalır, sözdizimi bozulur.
 */
function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/!/g, "\\!")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>")
    .replace(/[\r\n\t]+/g, " ");
}

function byId<T extends { readonly id: string }>(a: T, b: T): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** Kanonik sıra: id'ye göre sıralı node/edge/evidence dizileri. */
function canonicallyOrdered(snapshot: SnapshotGraph): SnapshotGraph {
  return {
    meta: snapshot.meta,
    nodes: [...snapshot.nodes].sort(byId),
    edges: [...snapshot.edges].sort(byId),
    evidence: [...snapshot.evidence].sort(byId),
  };
}

/**
 * Savunma katmanı (TŞ §8 invariant ii): metin serializer'ları kenar uçlarını
 * node kimliklerine çözümlediğinden dangling kenar sessizce DÜŞÜRÜLMEZ,
 * sabit hata koduyla reddedilir. Geçerli snapshot'ta oluşmaz.
 */
function assertNoDanglingEdges(snapshot: SnapshotGraph): void {
  const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
  for (const edge of snapshot.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new GraphRepositoryError(
        "export/dangling-edge",
        `Edge endpoint points to an unknown node; publish a finalized snapshot: ${edge.id}`,
      );
    }
  }
}

function formatLocation(
  span: { readonly relativePath: string; readonly startLine: number; readonly endLine: number } | undefined,
): string {
  return span === undefined ? "" : `${span.relativePath}:${String(span.startLine)}-${String(span.endLine)}`;
}

/* ------------------------------------------------------------------ */
/* JSON serializer (canonical)                                         */
/* ------------------------------------------------------------------ */

/**
 * Canonical JSON export: meta + node/edge/evidence kümeleri, anahtarlar
 * sıralı, beyaz boşluk yok (TŞ §8 invariant vi). Domain'in
 * snapshotCanonicalJson'u kullanılır; diziler önceden id sırasına alınır
 * (girdi sırasından bağımsız determinizm).
 */
export function serializeDocumentationJson(snapshot: SnapshotGraph): string {
  return snapshotCanonicalJson(canonicallyOrdered(snapshot));
}

/* ------------------------------------------------------------------ */
/* Markdown serializer                                                 */
/* ------------------------------------------------------------------ */

/**
 * Deterministik Markdown dokümanı: sabit şablon, id sıralı tablolar,
 * hücre değerleri escapeMarkdownCell ile kaçırılır.
 */
export function serializeDocumentationMarkdown(snapshot: SnapshotGraph): string {
  const ordered = canonicallyOrdered(snapshot);
  assertNoDanglingEdges(ordered);
  const lines: string[] = [];
  lines.push("# Causoryn Architecture Documentation");
  lines.push("");
  lines.push("## Snapshot");
  lines.push("");
  lines.push(`- id: ${escapeMarkdownCell(ordered.meta.id)}`);
  lines.push(`- workspaceId: ${escapeMarkdownCell(ordered.meta.workspaceId)}`);
  lines.push(
    `- revision: ${escapeMarkdownCell(ordered.meta.revision.id)} (sequence ${String(ordered.meta.revision.sequence)})`,
  );
  lines.push(`- configHash: ${escapeMarkdownCell(ordered.meta.configHash)}`);
  lines.push(`- analyzerFingerprint: ${escapeMarkdownCell(ordered.meta.analyzerFingerprint)}`);
  lines.push(`- state: ${escapeMarkdownCell(ordered.meta.state)}`);
  lines.push(`- createdAt: ${escapeMarkdownCell(ordered.meta.createdAt)}`);
  lines.push("");
  lines.push(`## Nodes (${String(ordered.nodes.length)})`);
  lines.push("");
  lines.push("| id | kind | qualifiedName | language | location |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const node of ordered.nodes) {
    lines.push(
      `| ${escapeMarkdownCell(node.id)} | ${escapeMarkdownCell(node.kind)} | ${escapeMarkdownCell(node.qualifiedName)} | ${escapeMarkdownCell(node.language ?? "")} | ${escapeMarkdownCell(formatLocation(node.location))} |`,
    );
  }
  lines.push("");
  lines.push(`## Edges (${String(ordered.edges.length)})`);
  lines.push("");
  lines.push("| id | kind | from | to | resolution | evidenceIds |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const edge of ordered.edges) {
    lines.push(
      `| ${escapeMarkdownCell(edge.id)} | ${escapeMarkdownCell(edge.kind)} | ${escapeMarkdownCell(edge.from)} | ${escapeMarkdownCell(edge.to)} | ${escapeMarkdownCell(edge.resolution)} | ${escapeMarkdownCell(edge.evidenceIds.join(","))} |`,
    );
  }
  lines.push("");
  lines.push(`## Evidence (${String(ordered.evidence.length)})`);
  lines.push("");
  lines.push("| id | kind | analyzerId | analyzerVersion | span | rationale |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const evidence of ordered.evidence) {
    lines.push(
      `| ${escapeMarkdownCell(evidence.id)} | ${escapeMarkdownCell(evidence.kind)} | ${escapeMarkdownCell(evidence.analyzerId)} | ${escapeMarkdownCell(evidence.analyzerVersion)} | ${escapeMarkdownCell(formatLocation(evidence.span))} | ${escapeMarkdownCell(evidence.rationale)} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------ */
/* Mermaid serializer                                                  */
/* ------------------------------------------------------------------ */

/** Resolution → Mermaid ok biçimi (deterministik, belgelenmiş eşleme). */
function mermaidArrow(resolution: string): string {
  return resolution === "verified" ? "-->" : "-.->";
}

/**
 * Deterministik Mermaid flowchart: node kimlikleri sıralı id'den türetilen
 * `n0..nN` güvenli tanımlayıcılardır (ham id'deki `:` gibi karakterler
 * Mermaid tanımlayıcı kurallarına güvenilmez); etiketler tırnak içinde ve
 * escapeMermaidLabel ile kaçırılmıştır. Boş graph → yalnızca `flowchart TD`.
 */
export function serializeDocumentationMermaid(snapshot: SnapshotGraph): string {
  const ordered = canonicallyOrdered(snapshot);
  assertNoDanglingEdges(ordered);
  const lines: string[] = ["flowchart TD"];
  const nodeIndexById = new Map<string, string>();
  for (const [index, node] of ordered.nodes.entries()) {
    const mermaidId = `n${String(index)}`;
    nodeIndexById.set(node.id, mermaidId);
    lines.push(`  ${mermaidId}["${escapeMermaidLabel(`${node.kind} :: ${node.qualifiedName}`)}"]`);
  }
  for (const edge of ordered.edges) {
    const fromId = nodeIndexById.get(edge.from);
    const toId = nodeIndexById.get(edge.to);
    if (fromId === undefined || toId === undefined) {
      throw new GraphRepositoryError("export/dangling-edge", `Edge endpoint points to an unknown node: ${edge.id}`);
    }
    lines.push(
      `  ${fromId} ${mermaidArrow(edge.resolution)}|${edge.kind}/${edge.resolution}| ${toId}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------ */
/* HTML serializer (offline self-contained)                            */
/* ------------------------------------------------------------------ */

/**
 * Kısıtlayıcı offline CSP (TŞ §16 "mümkünse offline CSP"): default-src
 * 'none' script/fetch/frame/connection yollarını kapatır; yalnızca gömülü
 * <style> bloğu için 'unsafe-inline' istisnası vardır. Harici kaynak, CDN,
 * analytics yok; belge tek dosyada self-contained'dır.
 */
const HTML_CSP_POLICY = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const HTML_STATIC_CSS = [
  ":root { color-scheme: light dark; }",
  "body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; line-height: 1.45; }",
  "h1 { border-bottom: 2px solid #64748b; }",
  "h2 { border-bottom: 1px solid #94a3b8; margin-top: 2rem; }",
  "dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }",
  "dt { font-weight: 600; }",
  "dd { margin: 0; overflow-wrap: anywhere; }",
  "table { border-collapse: collapse; width: 100%; font-size: 0.875rem; }",
  "th, td { border: 1px solid #94a3b8; padding: 0.3rem 0.5rem; text-align: left; vertical-align: top; overflow-wrap: anywhere; }",
  "th { background: rgba(100, 116, 139, 0.18); }",
].join("\n");

function htmlTable(
  heading: string,
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const lines: string[] = [];
  lines.push(`<section>`);
  lines.push(`<h2>${heading}</h2>`);
  lines.push("<table>");
  lines.push("<thead>");
  lines.push(`<tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>`);
  lines.push("</thead>");
  lines.push("<tbody>");
  for (const row of rows) {
    lines.push(`<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`);
  }
  lines.push("</tbody>");
  lines.push("</table>");
  lines.push("</section>");
  return lines.join("\n");
}

/**
 * Offline self-contained HTML: tüm içerik INLINE (gömülü CSS), tüm dinamik
 * değerler escapeHtml'den geçer, script/CDN/harici referans YOK. Belge
 * tek dosyadır; kaynak yolları metin olarak gösterilir (keyfi file:// link
 * üretilmez — TŞ §16A.9).
 */
export function serializeDocumentationHtml(snapshot: SnapshotGraph): string {
  const ordered = canonicallyOrdered(snapshot);
  assertNoDanglingEdges(ordered);
  const metaPairs: readonly (readonly [string, string])[] = [
    ["id", ordered.meta.id],
    ["workspaceId", ordered.meta.workspaceId],
    ["revision", `${ordered.meta.revision.id} (sequence ${String(ordered.meta.revision.sequence)})`],
    ["configHash", ordered.meta.configHash],
    ["analyzerFingerprint", ordered.meta.analyzerFingerprint],
    ["state", ordered.meta.state],
    ["createdAt", ordered.meta.createdAt],
  ];
  const lines: string[] = [];
  lines.push("<!DOCTYPE html>");
  lines.push('<html lang="en">');
  lines.push("<head>");
  lines.push('<meta charset="utf-8">');
  lines.push(`<meta http-equiv="Content-Security-Policy" content="${HTML_CSP_POLICY}">`);
  lines.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  lines.push("<title>Causoryn Architecture Documentation</title>");
  lines.push("<style>");
  lines.push(HTML_STATIC_CSS);
  lines.push("</style>");
  lines.push("</head>");
  lines.push("<body>");
  lines.push("<h1>Causoryn Architecture Documentation</h1>");
  lines.push("<section>");
  lines.push("<h2>Snapshot</h2>");
  lines.push("<dl>");
  for (const [term, value] of metaPairs) {
    lines.push(`<dt>${escapeHtml(term)}</dt>`);
    lines.push(`<dd>${escapeHtml(value)}</dd>`);
  }
  lines.push("</dl>");
  lines.push("</section>");
  lines.push(
    htmlTable(
      `Nodes (${String(ordered.nodes.length)})`,
      ["id", "kind", "qualifiedName", "language", "location"],
      ordered.nodes.map((node) => [
        node.id,
        node.kind,
        node.qualifiedName,
        node.language ?? "",
        formatLocation(node.location),
      ]),
    ),
  );
  lines.push(
    htmlTable(
      `Edges (${String(ordered.edges.length)})`,
      ["id", "kind", "from", "to", "resolution", "evidenceIds"],
      ordered.edges.map((edge) => [
        edge.id,
        edge.kind,
        edge.from,
        edge.to,
        edge.resolution,
        edge.evidenceIds.join(","),
      ]),
    ),
  );
  lines.push(
    htmlTable(
      `Evidence (${String(ordered.evidence.length)})`,
      ["id", "kind", "analyzerId", "analyzerVersion", "span", "rationale"],
      ordered.evidence.map((evidence) => [
        evidence.id,
        evidence.kind,
        evidence.analyzerId,
        evidence.analyzerVersion,
        formatLocation(evidence.span),
        evidence.rationale,
      ]),
    ),
  );
  lines.push("</body>");
  lines.push("</html>");
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------ */
/* Snapshot ContentSet serializer (.causoryn/architecture-snapshot.json) */
/* ------------------------------------------------------------------ */

/**
 * Compare/timeline okuyucularının tükettiği kanonik CompareContentSet
 * mimari snapshot blob'u. Dangling kenarları diğer export formatlarıyla
 * tutarlı biçimde `export/dangling-edge` koduyla reddeder.
 */
export function serializeDocumentationSnapshot(snapshot: SnapshotGraph): string {
  const ordered = canonicallyOrdered(snapshot);
  assertNoDanglingEdges(ordered);
  return serializeSnapshotContentSet(ordered);
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                          */
/* ------------------------------------------------------------------ */

/** Format dispatch'i: şema doğrulaması + serializer seçimi (saf, deterministik). */
export function serializeDocumentation(
  snapshot: SnapshotGraph,
  format: ExportDocumentationFormat,
): string {
  const parsed = exportDocumentationFormatSchema.safeParse(format);
  if (!parsed.success) {
    throw new GraphRepositoryError(
      "export/invalid-format",
      `Unknown export format: ${String(format)}; allowed values: ${EXPORT_DOCUMENTATION_FORMATS.join(", ")}`,
    );
  }
  switch (parsed.data) {
    case "json":
      return serializeDocumentationJson(snapshot);
    case "markdown":
      return serializeDocumentationMarkdown(snapshot);
    case "mermaid":
      return serializeDocumentationMermaid(snapshot);
    case "html":
      return serializeDocumentationHtml(snapshot);
    case "snapshot":
      return serializeDocumentationSnapshot(snapshot);
  }
}

/* ------------------------------------------------------------------ */
/* Yazma katmanı (yetkilendirme + atomik write)                        */
/* ------------------------------------------------------------------ */

export interface WriteDocumentationArchitectureSummary {
  readonly moduleCount: number;
  readonly edgeCount: number;
  readonly cycleCount: number;
  readonly entrypointCount: number;
  readonly contractCount: number;
  readonly flowCount: number;
  readonly annotated: boolean;
  readonly moduleIds: readonly string[];
}

export interface WriteDocumentationInput {
  readonly snapshot: SnapshotGraph;
  readonly format: ExportDocumentationFormat;
  /** Hedef çıktı dizini; OutputAccessPolicy beyanlı listesinde olmalıdır. */
  readonly outputDir: string;
  /** SAF dosya adı (ayraçsız); verilmezse formatın varsayılan adı kullanılır. */
  readonly fileName?: string;
  /** Export görünümü (`architecture` | `interactive` | `full`). */
  readonly view?: ExportDocumentationView;
  /** Mimari projeksiyon seçenekleri (yalnızca `architecture` / `interactive`). */
  readonly options?: ArchitectureProjectionOptions;
  /** Host-LLM kanıt-temelli mimari anotasyonları (yalnızca `architecture` / `interactive`). */
  readonly annotations?: ArchitectureAnnotations;
}

export interface WriteDocumentationResult {
  /** Yazılan dosyanın kanonik gerçek yolu. */
  readonly path: string;
  readonly format: ExportDocumentationFormat;
  /** UTF-8 bayt uzunluğu. */
  readonly bytes: number;
  /** Yazma daima atomiktir: `.tmp` + rename. */
  readonly atomic: true;
  /** Uygulanan görünüm (belirtildiyse veya architecture/interactive seçildiyse). */
  readonly view?: ExportDocumentationView;
  /** Mimari projeksiyon özeti ve doğrulanmış `moduleIds` listesi (`architecture`/`interactive`). */
  readonly architectureSummary?: WriteDocumentationArchitectureSummary;
}

/**
 * Yetkilendirilmiş atomik yazma: format/view/options/annotations doğrulanır →
 * içerik SAF serializer ile üretilir → hedef OutputAccessPolicy ile denetlenir
 * (reddedilen hedefe HİÇBİR dosya yazılmaz) → `.tmp` + rename ile atomik yazılır.
 *
 * Yetkilendirme reddi GraphRepositoryError ile SABİT graph sözleşme koduyla
 * fırlatılır (graph paketi kendi `export/...` ad alanını kullanır; MCP
 * eşlemesi tek sabit kod okur):
 * - `export/output-not-authorized`: hedef dizin beyanlı output listesinde
 *   değil → MCP yüzeyinde SABİT EXPORT_NOT_ALLOWED ile eşlenir.
 * - `export/output-path-denied`: null byte / ayraç / ".." / realpath kaçışı
 *   → mevcut PATH_DENIED ile eşlenir.
 * - `export/invalid-view`, `export/invalid-options`, `export/invalid-annotations`
 *   → MCP yüzeyinde `INVALID_ARGUMENT` ile eşlenir.
 */
export function writeDocumentation(
  input: WriteDocumentationInput,
  policy: OutputAccessPolicy,
): WriteDocumentationResult {
  const parsedFormat = exportDocumentationFormatSchema.safeParse(input.format);
  if (!parsedFormat.success) {
    throw new GraphRepositoryError(
      "export/invalid-format",
      `Unknown export format: ${String(input.format)}; allowed values: ${EXPORT_DOCUMENTATION_FORMATS.join(", ")}`,
    );
  }

  let resolvedView: ExportDocumentationView | undefined;
  if (input.view !== undefined) {
    const parsedView = exportDocumentationViewSchema.safeParse(input.view);
    if (!parsedView.success) {
      throw new GraphRepositoryError(
        "export/invalid-view",
        `Unknown export view: ${String(input.view)}; allowed values: ${EXPORT_DOCUMENTATION_VIEWS.join(", ")}`,
      );
    }
    resolvedView = parsedView.data;
  } else if (input.options !== undefined || input.annotations !== undefined) {
    resolvedView = "architecture";
  }

  let content: string;
  let architectureSummary: WriteDocumentationArchitectureSummary | undefined;

  if (parsedFormat.data === "snapshot") {
    if (input.options !== undefined || input.annotations !== undefined) {
      throw new GraphRepositoryError(
        "export/invalid-options",
        "options and annotations cannot be used with the snapshot format",
      );
    }
    if (resolvedView !== undefined && resolvedView !== "full") {
      throw new GraphRepositoryError(
        "export/invalid-view",
        `the snapshot format only produces a raw CompareContentSet; view="${resolvedView}" is not supported`,
      );
    }
    content = serializeDocumentationSnapshot(input.snapshot);
  } else if (resolvedView === undefined || resolvedView === "full") {
    if (input.options !== undefined || input.annotations !== undefined) {
      throw new GraphRepositoryError(
        "export/invalid-options",
        'options and annotations can only be used with view="architecture" or view="interactive"',
      );
    }
    content = serializeDocumentation(input.snapshot, parsedFormat.data);
  } else if (resolvedView === "interactive") {
    if (parsedFormat.data !== "html") {
      throw new GraphRepositoryError(
        "export/invalid-view",
        `view="interactive" can only be used with format="html" (given: ${parsedFormat.data})`,
      );
    }
    const prepared = prepareArchitecture(input.snapshot, input.options, input.annotations);
    content = serializeInteractiveArchitectureHtmlFromPrepared(prepared);
    architectureSummary = {
      moduleCount: prepared.projection.summary.moduleCount,
      edgeCount: prepared.projection.summary.moduleEdgeCount,
      cycleCount: prepared.projection.summary.cycleCount,
      entrypointCount: prepared.projection.summary.entrypointCount,
      contractCount: prepared.projection.summary.contractCount,
      flowCount: prepared.projection.summary.flowCount,
      annotated: prepared.annotations !== undefined,
      moduleIds: prepared.projection.modules.map((m) => m.id),
    };
  } else {
    // resolvedView === "architecture"
    const prepared = prepareArchitecture(input.snapshot, input.options, input.annotations);
    switch (parsedFormat.data) {
      case "json":
        content = serializeArchitectureJsonFromPrepared(prepared);
        break;
      case "markdown":
        content = serializeArchitectureMarkdownFromPrepared(prepared);
        break;
      case "mermaid":
        content = renderArchitectureMermaidFromPrepared(prepared);
        break;
      case "html":
        content = serializeArchitectureHtmlFromPrepared(prepared);
        break;
    }
    architectureSummary = {
      moduleCount: prepared.projection.summary.moduleCount,
      edgeCount: prepared.projection.summary.moduleEdgeCount,
      cycleCount: prepared.projection.summary.cycleCount,
      entrypointCount: prepared.projection.summary.entrypointCount,
      contractCount: prepared.projection.summary.contractCount,
      flowCount: prepared.projection.summary.flowCount,
      annotated: prepared.annotations !== undefined,
      moduleIds: prepared.projection.modules.map((m) => m.id),
    };
  }

  const defaultFileName =
    resolvedView === "interactive" && parsedFormat.data === "html"
      ? EXPORT_INTERACTIVE_HTML_FILE_NAME
      : EXPORT_DEFAULT_FILE_NAMES[parsedFormat.data];
  const fileName = input.fileName ?? defaultFileName;
  const decision = policy.authorizeFile(input.outputDir, fileName);
  if (!decision.allowed) {
    const contractCode =
      decision.code === "workspace/output-not-authorized"
        ? "export/output-not-authorized"
        : "export/output-path-denied";
    throw new GraphRepositoryError(
      contractCode,
      `Output authorization denied (${decision.code}): ${decision.reason}`,
    );
  }
  const targetPath = decision.canonicalPath;
  const tmpPath = `${targetPath}.tmp`;
  try {
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp yok: temizlik gereksiz; asıl yazma aşağıda.
    }
    writeFileSync(tmpPath, content, { encoding: "utf8", flag: "wx" });
    renameSync(tmpPath, targetPath);
  } catch (error) {
    const isEexist =
      error instanceof Error && "code" in error && error.code === "EEXIST";
    if (!isEexist) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // tmp oluşmadıysa temizlik gereksiz; asıl hata aşağıda raporlanır.
      }
    }
    throw new GraphRepositoryError(
      "export/write-failed",
      `Could not write the output file: ${targetPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    path: targetPath,
    format: parsedFormat.data,
    bytes: Buffer.byteLength(content, "utf8"),
    atomic: true,
    ...(resolvedView === undefined ? {} : { view: resolvedView }),
    ...(architectureSummary === undefined ? {} : { architectureSummary }),
  };
}
