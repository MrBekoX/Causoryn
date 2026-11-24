import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { OutputAccessPolicy } from "@causoryn/workspace";

import { WikiProjectionError } from "./errors.js";
import { WikiProjectionSchema, type EvidenceRef, type WikiPage, type WikiPageSection, type WikiProjection } from "./schema.js";

/**
 * Wiki offline export çekirdeği — TŞ v2.1 §16A.9 "Wiki UI ve offline
 * dağıtım": "güvenli offline statik Wiki export (Markdown klasörü +
 * index.html + yerel asset'ler; CDN/telemetry yok)"; "offline HTML'de kaynak
 * relatif path olarak gösterilir, keyfi file:// link açma yetkisi verilmez";
 * "HTML/CSS/JS statik dosyalarda XSS escape ve CSP zorunlu". §16A.10 Güvenlik
 * satırı: "offline export ağ isteği yapmaz". §16: "yalnızca explicit izinli
 * output dizini, atomik write, HTML escaping, mümkünse offline CSP; remote
 * CDN / analytics yok" (sprint-4 W8; graph/export.ts C6 desenleriyle aynı
 * mimari: saf serializer + OutputAccessPolicy yetkilendirmesi + atomik yazma).
 *
 * Katman ayrımı (C6 deseni):
 * - SAF SERIALIZER'LAR: serializeWikiHtml / serializeWikiIndexMarkdown /
 *   serializeWikiPageMarkdown / buildWikiExportFileSet — girdi yalnızca
 *   WikiProjection; saat okumaz, rastgelelik kullanmaz, dosya sistemine ve
 *   ağa dokunmaz. Tüm sayfalar/bölümler kanıt dizileri kimlik sırasına
 *   alınır; girdi dizisi karıştırılsa bile çıktı bit-bit aynıdır (TŞ §8
 *   invariant vi'nin export karşılığı).
 * - YAZMA KATMANI: exportWikiOffline — hedef, @causoryn/workspace
 *   OutputAccessPolicy (K-012, sprint-3 C6) ile denetlenir; wiki_build'in
 *   data-root'u ile KARIŞTIRILMAZ: export kullanıcı beyanlı output dizinine
 *   yazılır (wiki/mcp-tools.md yazma izin matrisi). Reddedilen hedefe hiçbir
 *   dosya HİÇBİR alt dizin oluşturulmadan yazılmaz. Her dosya `.tmp` + rename
 *   ile atomiktir; tmp önceden silinir (output dizinine konmuş symlink
 *   üzerinden kaçış kapatılır — C6 güvenlik bulgusu deseni).
 *
 * HTML güvenliği (TŞ §16 + §16A.9): TÜM dinamik değerler escapeHtmlText'ten
 * geçer; belgede <script>, <link>, <iframe>, harici kaynak, CDN URL'si,
 * file:// linki YOKTUR. CSP meta: `default-src 'none'; style-src
 * 'unsafe-inline'; base-uri 'none'; form-action 'none'` — script/fetch/
 * frame/connection yüklerini default kapatır; yalnızca gömülü <style> bloğuna
 * istisna tanır (C6 ile birebir aynı politika). Sayfa içi gezinme yalnızca
 * aynı-belge fragment çapalarıyladır (#pN); kaynak yolları METİN olarak
 * gösterilir. Ek savunma: gövde metnine sızan ham http(s):// dizgileri
 * HTML varlığında (`&#58;`) defanged edilir — statik tarama düzeyinde tek bir
 * ham URL öbeği bile kalmaz (linkifier'ların tıklanabilir bağ üretmesi de
 * engellenir).
 *
 * Markdown güvenliği: hücre değerleri (başlık, yol, slug) GFM hücre
 * kaçışıyla kaçırılır (C6 escapeMarkdownCell deseni — kaçırılmayan
 * `![x](https://...)` ağa erişimli GFM görüntüleyicide beacon'dır).
 * Bölüm gövdelerinde satır yapısı korunurken ham inline HTML (`<` → `\<`) ve
 * görsel gömmeleri (`![` → `\![`) nötralize edilir; düz metin linkler
 * korunur (tıklama gerektirir, otomatik ağ isteği yapmaz).
 *
 * Deterministik dosya adları: pageId kanonik sırasında sanitize edilmiş
 * slug + çakışmada `slug-<pageId[5..13]>` sondası (projection.ts:840
 * deseni). Windows reserved device adları (con/nul/com1..9/lpt1..9 —
 * "con.md" yazılamaz) id sondasını ZORUNLU kılar. Kalan çakışma sessiz
 * üzerine yazılmaz; sabit kodla reddedilir.
 *
 * Hata kodları (bu modül `wiki/...` ön ekli WikiProjectionError üretir;
 * MCP yüzey eşlemesi BUGÜN packages/mcp-server'da YOKTUR — takım denetimi
 * kaydı, W8): export çekirdeği mcp-server'dan henüz tüketilmiyor;
 * services-wiki.ts wikiErrorToToolError bu kodları bilmediğinden view=wiki
 * kabloylandığında reddedilmeden INTERNAL_ERROR kovasına düşer (güvenlik
 * reddi sinyali bastırılır). Eşleme, view=wiki işi kabloylandığında
 * services-wiki.ts'teki wikiErrorToToolError'a EKLENMELİDİR; öncül
 * services-architecture.ts:159–165'teki export/output-* eşlemesidir:
 * - `wiki/export-invalid-projection`: girdi WikiProjectionSchema'yı geçmez
 *   (savunma katmanı; geçerli projeksiyonda oluşmaz)
 * - `wiki/export-unknown-page`: serializeWikiPageMarkdown'a projeksiyonda
 *   olmayan sayfa verildi
 * - `wiki/output-not-authorized`: hedef dizin beyanlı output listesinde
 *   değil → eklenmesi gereken eşleme TŞ §10.1 SABİT kodu
 *   EXPORT_NOT_ALLOWED (graph/export.ts:494–503 ile aynı karar — YENİ
 *   uzantı kodu İSTENMEDİ, K-008 örüntüsü)
 * - `wiki/output-path-denied`: null byte / ayraç / ".." / realpath kaçışı
 *   → eklenmesi gereken eşleme mevcut PATH_DENIED
 * - `wiki/export-write-failed`: yetkilendirilmiş hedefe yazma/taşıma hatası
 * - `wiki/export-filename-collision`: ayrıştırıcı dosya adları kümesi
 *   çakışıyor (sessiz üzerine yazma yok)
 */

/** Self-contained HTML için kısıtlayıcı offline CSP (C6 ile birebir). */
export const WIKI_EXPORT_HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** Markdown çıktı alt dizini (index.md + sayfa başına .md). */
export const WIKI_EXPORT_MARKDOWN_DIR_NAME = "markdown";

/** Self-contained HTML belgesinin sabit dosya adı (output kökünde). */
export const WIKI_EXPORT_INDEX_HTML_NAME = "index.html";

/** Markdown dizininde sabit dizin sayfası. */
export const WIKI_EXPORT_INDEX_MD_NAME = "index.md";

/* ------------------------------------------------------------------ */
/* Kaçış yardımcıları (saf, deterministik — C6 desenleri)              */
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
 * HTML metin kaçışı + URL defang: kaçıştan sonra kalan ham http(s)://
 * öbeklerinin `:` karakteri `&#58;` varlığına çevrilir (görünen metin
 * korunur; belge kaynağında ham http(s):// öbeği kalmaz — §16A.10 "offline
 * export ağ isteği yapmaz" statik taramasının güçlü biçimi).
 *
 * Kapsam (takım denetimi kaydı, kabul edilmiş artık risk): defang YALNIZCA
 * http(s) kapsar. Gövdeye sızan file:// dizgisi HTML'e kaçışlı DÜZ METİN
 * olarak geçer — href üretilmediğinden link AÇILAMAZ (TŞ §16A.9 "keyfi
 * file:// link açma yetkisi verilmez" sağlanır) ve .md'de tıklama
 * gerektiren metindir (escapeMarkdownBody'deki tasarımsal koruma).
 */
function escapeHtmlText(value: string): string {
  return escapeHtml(value).replace(/https?:\/\//g, (match) => match.replace(":", "&#58;"));
}

/**
 * Markdown hücre kaçışı (C6 escapeMarkdownCell deseni): GFM hücre ayracı,
 * satır sonları ve link/HTML metakarakterleri. Başlıklar ve meta değerleri
 * için kullanılır — kaçırılmayan `![x](https://...)` dizgisi ağa erişimli
 * GFM görüntüleyicide beacon/link'tir.
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

/**
 * Markdown blok gövde kaçışı: satır yapısı KORUNUR (hücre kaçışının aksine
 * satır sonları sıkıştırılmaz); ham inline HTML (`<` → `\<`, `>` → `\>`) ve
 * görsel gömmeleri (`![` → `\![`) nötralize edilir. `>` kaçışı yalnızca
 * kapanış etiketi kalıntısını temizlemez; satır başı `>` blockquote
 * sahteciliğini de kapatır. GFM'de `\<`/`\>`/`\!` sabit noktalama kaçışları
 * okunabilirliği korur. Düz `[link](url)` metni korunur: GFM'de tıklama
 * gerektiren bağdır, otomatik ağ isteği yapmaz.
 */
function escapeMarkdownBody(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>")
    .replace(/!\[/g, "\\![");
}

/* ------------------------------------------------------------------ */
/* Kanonik sıralama                                                    */
/* ------------------------------------------------------------------ */

function byString(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return byString(a.id, b.id);
}

/** Kanonik kanıt sırası: evidenceId, sonra span alanları. */
function byEvidenceRef(a: EvidenceRef, b: EvidenceRef): number {
  const byEvidence = byString(a.evidenceId, b.evidenceId);
  if (byEvidence !== 0) return byEvidence;
  const byPath = byString(a.relativePath, b.relativePath);
  if (byPath !== 0) return byPath;
  if (a.startLine !== b.startLine) return a.startLine - b.startLine;
  return a.endLine - b.endLine;
}

/* ------------------------------------------------------------------ */
/* Girdi doğrulaması (savunma katmanı)                                 */
/* ------------------------------------------------------------------ */

/**
 * Girdi projeksiyonunu WikiProjectionSchema'dan geçirir (strict + superRefine:
 * dangling bölüm/parentId ve duplicate kimlik reddi). Saf; şema sapması
 * `wiki/export-invalid-projection` ile reddedilir.
 */
function validateProjection(projection: WikiProjection): WikiProjection {
  const parsed = WikiProjectionSchema.safeParse(projection);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new WikiProjectionError(
      "wiki/export-invalid-projection",
      `Export girdisi WikiProjection şemasını geçmedi: ${detail}`,
    );
  }
  return parsed.data;
}

/* ------------------------------------------------------------------ */
/* Deterministik dosya adları (slug tabanlı, kaçış'lı)                 */
/* ------------------------------------------------------------------ */

/**
 * Sayfa slug'ını dosya adına güvenli hale indirger: projection'un slug alanı
 * şema düzeyinde serbest dizgidir (güvenilmez depo verisi, TŞ §19); burada
 * [a-z0-9-] kümesine zorlanır. Sonuç ayraçsız, ".." içermez, boş ise "page".
 */
function exportFileSlug(page: WikiPage): string {
  const dashed = page.slug.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  let end = dashed.length;
  while (start < end && dashed.charCodeAt(start) === 45) start += 1;
  while (end > start && dashed.charCodeAt(end - 1) === 45) end -= 1;
  const slug = dashed.slice(start, end);
  return slug.length > 0 ? slug : "page";
}

/**
 * Windows reserved device adları (denetim bulgusu düzeltmesi): bu gövdeler
 * uzantıdan bağımsız rezervedir — "con.md"/"lpt1.md" Windows'ta yazılamaz.
 * Tam ad karşılaştırması büyük/küçük harf duyarsız yapılır (win32 karar
 * kuralı); exportFileSlug zaten küçük harfe indirger.
 */
const WINDOWS_RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/**
 * Sayfa kimliği → export dosya adı eşlemesi. Kanonik (pageId) sırada:
 * bir slug ilk geçişinde çıplak kalır, aynı slug'ın sonraki sahipleri
 * `slug-<pageId[5..13]>` sondası alır (projection.ts:840 çakışma deseni).
 * Kalan çakışma (sonda çakışan ayrı sayfalar) sessiz üzerine yazmaya
 * dönmez; `wiki/export-filename-collision` ile reddedilir.
 */
function exportFileNamesByPageId(pages: readonly WikiPage[]): ReadonlyMap<string, string> {
  const canonical = [...pages].sort(byId);
  const slugGroups = new Map<string, WikiPage[]>();
  for (const page of canonical) {
    const slug = exportFileSlug(page);
    const group = slugGroups.get(slug) ?? [];
    group.push(page);
    slugGroups.set(slug, group);
  }
  const nameByPageId = new Map<string, string>();
  for (const [slug, group] of slugGroups) {
    for (const [index, page] of group.entries()) {
      // Windows reserved device adları uzantıyla da rezervedir ("con.md"
      // yazılamaz): id sondası bu adlar için İLK üye için de zorunlu
      // kılınır ("con-<sonda>.md" gövdeli ad reserved değildir). Sonda
      // boş kalırsa (kısa pageId) "con-.md" gövdesi yine reserved değildir.
      const forceSuffix = index !== 0 || WINDOWS_RESERVED_DEVICE_NAMES.has(slug);
      const fileName = forceSuffix ? `${slug}-${page.id.slice(5, 13)}` : slug;
      nameByPageId.set(page.id, `${fileName}.md`);
    }
  }
  // Kalan çakışma (ayrı sayfaların adları kümede eşleşti) sessiz üzerine
  // yazmaya dönmez; sabit kodla reddedilir. Kontrol TAM küme üzerinde
  // yapıldığından karar girdi kümesine bağlıdır, atama sırasına değil.
  const seen = new Set<string>();
  for (const [pageId, fileName] of nameByPageId) {
    if (seen.has(fileName)) {
      throw new WikiProjectionError(
        "wiki/export-filename-collision",
        `Export dosya adı çakışıyor (sessiz üzerine yazma yok): ${fileName} (pageId ${pageId})`,
      );
    }
    seen.add(fileName);
  }
  return nameByPageId;
}

/* ------------------------------------------------------------------ */
/* Ortak projeksiyon görünümleri                                       */
/* ------------------------------------------------------------------ */

/** coverage satırı: no_data/partial ayrımı dürüstçe metne taşınır. */
function coverageLabel(coverage: WikiPage["coverage"]): string {
  return coverage.detail === undefined ? coverage.status : `${coverage.status} (${coverage.detail})`;
}

function formatEvidenceRef(ref: EvidenceRef): string {
  return `${ref.relativePath}:${String(ref.startLine)}-${String(ref.endLine)} (${ref.evidenceId})`;
}

interface PageView {
  readonly page: WikiPage;
  readonly sections: readonly WikiPageSection[];
}

/** Kanonik sayfa görünümü: sayfalar + bölümler kimlik sıralı gruplanmış. */
function buildPageViews(projection: WikiProjection): readonly PageView[] {
  const canonicalPages = [...projection.pages].sort(byId);
  const canonicalSections = [...projection.sections].sort(byId);
  const sectionsByPage = new Map<string, WikiPageSection[]>();
  for (const section of canonicalSections) {
    const list = sectionsByPage.get(section.pageId) ?? [];
    list.push(section);
    sectionsByPage.set(section.pageId, list);
  }
  return canonicalPages.map((page) => ({
    page,
    sections: sectionsByPage.get(page.id) ?? [],
  }));
}

/* ------------------------------------------------------------------ */
/* Markdown serializer'lar                                             */
/* ------------------------------------------------------------------ */

/** Bölüm bloğu (paylaşılan md kuralı): başlık + durum + kanıt + gövde. */
function markdownSectionBlock(section: WikiPageSection): string[] {
  const lines: string[] = [];
  lines.push(`## ${escapeMarkdownCell(section.sectionKey)}`);
  lines.push("");
  lines.push(`- status: ${escapeMarkdownCell(section.status)}`);
  const refs = [...section.evidenceRefs].sort(byEvidenceRef);
  for (const ref of refs) {
    lines.push(`- kanıt: ${escapeMarkdownCell(formatEvidenceRef(ref))}`);
  }
  if (section.generatedMarkdown.length > 0) {
    lines.push("");
    lines.push(escapeMarkdownBody(section.generatedMarkdown));
  }
  lines.push("");
  return lines;
}

/**
 * Tek sayfanın deterministik Markdown dokümanı — DOĞRULANMIŞ projeksiyonun
 * sayfa görünümünden render eder. Doğrulama public sarmalayıcıdadır; dosya
 * kümesi üretimi tek doğrulama paylaşır (denetim bulgusu: N sayfalık export
 * eskiden N+2 tam şema çözümlemesi yapıyordu, artık 1).
 */
function renderPageMarkdown(view: PageView): string {
  const lines: string[] = [];
  lines.push(`# ${escapeMarkdownCell(view.page.title)}`);
  lines.push("");
  lines.push(`- pageId: ${escapeMarkdownCell(view.page.id)}`);
  lines.push(`- wikiSnapshotId: ${escapeMarkdownCell(view.page.wikiSnapshotId)}`);
  lines.push(`- kind: ${escapeMarkdownCell(view.page.kind)}`);
  lines.push(`- parentId: ${view.page.parentId === null ? "(kök)" : escapeMarkdownCell(view.page.parentId)}`);
  lines.push(`- slug: ${escapeMarkdownCell(view.page.slug)}`);
  lines.push(`- route: ${escapeMarkdownCell(view.page.route)}`);
  lines.push(`- freshness: ${escapeMarkdownCell(view.page.freshness)}`);
  lines.push(`- coverage: ${escapeMarkdownCell(coverageLabel(view.page.coverage))}`);
  lines.push(`- contentHash: ${escapeMarkdownCell(view.page.contentHash)}`);
  lines.push("");
  for (const section of view.sections) {
    lines.push(...markdownSectionBlock(section));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Tek sayfanın deterministik Markdown dokümanı. Sayfa projeksiyonda yoksa
 * `wiki/export-unknown-page` ile reddedilir (sessiz boş belge üretilmez);
 * girdi savunma katmanı olarak tam şemadan geçirilir.
 */
export function serializeWikiPageMarkdown(projection: WikiProjection, page: WikiPage): string {
  const valid = validateProjection(projection);
  const view = buildPageViews(valid).find((candidate) => candidate.page.id === page.id);
  if (view === undefined) {
    throw new WikiProjectionError(
      "wiki/export-unknown-page",
      `Sayfa bu projeksiyonda bulunamadı: ${page.id}`,
    );
  }
  return renderPageMarkdown(view);
}

/**
 * Deterministik dizin belgesi gövdesi — doğrulanmış projeksiyondan render.
 */
function renderIndexMarkdown(valid: WikiProjection): string {
  const views = buildPageViews(valid);
  const fileNames = exportFileNamesByPageId(valid.pages);
  const lines: string[] = [];
  lines.push("# Causoryn Living Wiki");
  lines.push("");
  lines.push("## Snapshot");
  lines.push("");
  lines.push(`- wikiSnapshotId: ${escapeMarkdownCell(valid.snapshot.id)}`);
  lines.push(`- workspaceId: ${escapeMarkdownCell(valid.snapshot.workspaceId)}`);
  lines.push(`- graphSnapshotId: ${escapeMarkdownCell(valid.snapshot.graphSnapshotId)}`);
  lines.push(`- revisionRef: ${escapeMarkdownCell(valid.snapshot.revisionRef)}`);
  lines.push(`- status: ${escapeMarkdownCell(valid.snapshot.status)}`);
  lines.push(`- builtAt: ${escapeMarkdownCell(valid.snapshot.builtAt)}`);
  lines.push(`- templateVersion: ${escapeMarkdownCell(valid.snapshot.templateVersion)}`);
  lines.push(`- pages: ${String(valid.pages.length)}`);
  lines.push(`- sections: ${String(valid.sections.length)}`);
  lines.push("");
  lines.push(`## Uyarılar (${String(valid.warnings.length)})`);
  lines.push("");
  for (const warning of valid.warnings) {
    lines.push(`- ${escapeMarkdownCell(warning)}`);
  }
  lines.push("");
  lines.push("## Sayfa dizini");
  lines.push("");
  lines.push("| başlık | tür | freshness | coverage | dosya |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const view of views) {
    const fileName = fileNames.get(view.page.id) ?? "";
    lines.push(
      `| ${escapeMarkdownCell(view.page.title)} | ${escapeMarkdownCell(view.page.kind)} | ${escapeMarkdownCell(view.page.freshness)} | ${escapeMarkdownCell(coverageLabel(view.page.coverage))} | ${escapeMarkdownCell(`${WIKI_EXPORT_MARKDOWN_DIR_NAME}/${fileName}`)} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

/**
 * Deterministik dizin belgesi (markdown/index.md): snapshot üst verisi +
 * uyarılar + kanonik sıralı sayfa tablosu (dosya adlarıyla). Girdi savunma
 * katmanı olarak tam şemadan geçirilir.
 */
export function serializeWikiIndexMarkdown(projection: WikiProjection): string {
  return renderIndexMarkdown(validateProjection(projection));
}

/* ------------------------------------------------------------------ */
/* HTML serializer (offline self-contained)                            */
/* ------------------------------------------------------------------ */

const HTML_STATIC_CSS = [
  ":root { color-scheme: light dark; }",
  "body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; line-height: 1.45; }",
  "h1 { border-bottom: 2px solid #64748b; }",
  "h2 { border-bottom: 1px solid #94a3b8; margin-top: 2rem; }",
  "h3 { margin-top: 1.25rem; }",
  "dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }",
  "dt { font-weight: 600; }",
  "dd { margin: 0; overflow-wrap: anywhere; }",
  "table { border-collapse: collapse; width: 100%; font-size: 0.875rem; }",
  "th, td { border: 1px solid #94a3b8; padding: 0.3rem 0.5rem; text-align: left; vertical-align: top; overflow-wrap: anywhere; }",
  "th { background: rgba(100, 116, 139, 0.18); }",
  "pre { background: rgba(100, 116, 139, 0.12); padding: 0.75rem; overflow-wrap: anywhere; white-space: pre-wrap; }",
  ".meta { color: #475569; font-size: 0.875rem; overflow-wrap: anywhere; }",
].join("\n");

/**
 * Offline self-contained HTML gövdesi — doğrulanmış projeksiyondan render.
 */
function renderWikiHtml(valid: WikiProjection): string {
  const views = buildPageViews(valid);
  const metaPairs: readonly (readonly [string, string])[] = [
    ["wikiSnapshotId", valid.snapshot.id],
    ["workspaceId", valid.snapshot.workspaceId],
    ["graphSnapshotId", valid.snapshot.graphSnapshotId],
    ["revisionRef", valid.snapshot.revisionRef],
    ["status", valid.snapshot.status],
    ["builtAt", valid.snapshot.builtAt],
    ["templateVersion", valid.snapshot.templateVersion],
    ["pages", String(valid.pages.length)],
    ["sections", String(valid.sections.length)],
    ["warnings", String(valid.warnings.length)],
  ];
  const lines: string[] = [];
  lines.push("<!DOCTYPE html>");
  lines.push('<html lang="tr">');
  lines.push("<head>");
  lines.push('<meta charset="utf-8">');
  lines.push(`<meta http-equiv="Content-Security-Policy" content="${WIKI_EXPORT_HTML_CSP}">`);
  lines.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  lines.push("<title>Causoryn Living Wiki — Offline Export</title>");
  lines.push("<style>");
  lines.push(HTML_STATIC_CSS);
  lines.push("</style>");
  lines.push("</head>");
  lines.push("<body>");
  lines.push("<h1>Causoryn Living Wiki — Offline Export</h1>");

  lines.push("<section>");
  lines.push("<h2>Snapshot</h2>");
  lines.push("<dl>");
  for (const [term, value] of metaPairs) {
    lines.push(`<dt>${escapeHtmlText(term)}</dt>`);
    lines.push(`<dd>${escapeHtmlText(value)}</dd>`);
  }
  lines.push("</dl>");
  lines.push("</section>");

  lines.push("<section>");
  lines.push(`<h2>Uyarılar (${escapeHtmlText(String(valid.warnings.length))})</h2>`);
  if (valid.warnings.length === 0) {
    lines.push("<p>(uyarı yok)</p>");
  } else {
    lines.push("<ul>");
    for (const warning of valid.warnings) {
      lines.push(`<li>${escapeHtmlText(warning)}</li>`);
    }
    lines.push("</ul>");
  }
  lines.push("</section>");

  lines.push("<section>");
  lines.push(`<h2>Sayfa dizini (${escapeHtmlText(String(views.length))})</h2>`);
  if (views.length === 0) {
    lines.push("<p>(sayfa yok)</p>");
  } else {
    lines.push("<ul>");
    for (const [index, view] of views.entries()) {
      const anchor = `p${String(index)}`;
      lines.push(
        `<li><a href="#${anchor}">${escapeHtmlText(view.page.title)}</a> — ${escapeHtmlText(view.page.kind)} · ${escapeHtmlText(view.page.freshness)} · ${escapeHtmlText(coverageLabel(view.page.coverage))}</li>`,
      );
    }
    lines.push("</ul>");
  }
  lines.push("</section>");

  for (const [index, view] of views.entries()) {
    const anchor = `p${String(index)}`;
    lines.push(`<section id="${anchor}">`);
    lines.push(`<h2>${escapeHtmlText(view.page.title)}</h2>`);
    lines.push(
      `<p class="meta">kind: ${escapeHtmlText(view.page.kind)} · slug: ${escapeHtmlText(view.page.slug)} · route: ${escapeHtmlText(view.page.route)} · parentId: ${view.page.parentId === null ? "(kök)" : escapeHtmlText(view.page.parentId)} · freshness: ${escapeHtmlText(view.page.freshness)} · coverage: ${escapeHtmlText(coverageLabel(view.page.coverage))} · contentHash: ${escapeHtmlText(view.page.contentHash)}</p>`,
    );
    for (const section of view.sections) {
      lines.push("<section>");
      lines.push(`<h3>${escapeHtmlText(section.sectionKey)}</h3>`);
      lines.push(`<p class="meta">status: ${escapeHtmlText(section.status)}</p>`);
      const refs = [...section.evidenceRefs].sort(byEvidenceRef);
      if (refs.length > 0) {
        lines.push("<ul>");
        for (const ref of refs) {
          lines.push(`<li>kanıt: ${escapeHtmlText(formatEvidenceRef(ref))}</li>`);
        }
        lines.push("</ul>");
      }
      if (section.generatedMarkdown.length > 0) {
        lines.push("<pre>");
        lines.push(escapeHtmlText(section.generatedMarkdown));
        lines.push("</pre>");
      }
      lines.push("</section>");
    }
    lines.push("</section>");
  }

  lines.push("</body>");
  lines.push("</html>");
  return `${lines.join("\n")}\n`;
}

/**
 * Offline self-contained HTML (TŞ §16A.9): tüm içerik INLINE (gömülü CSS),
 * tüm dinamik değerler escapeHtmlText'ten geçer, script/CDN/harici
 * referans/file:// link YOK. Gezinti aynı-belge `#pN` fragment'larıyla;
 * kaynak yolları metin olarak gösterilir. Sayfa/bölüm sırası kanoniktir;
 * aynı projeksiyon → bit-bit aynı belge. Girdi savunma katmanı olarak tam
 * şemadan geçirilir.
 */
export function serializeWikiHtml(projection: WikiProjection): string {
  return renderWikiHtml(validateProjection(projection));
}

/* ------------------------------------------------------------------ */
/* Dosya kümesi (saf, deterministik)                                   */
/* ------------------------------------------------------------------ */

/** Export dosya kümesi kaydı: ayraçsız güvenli yol bileşenleri + içerik. */
export interface WikiExportFile {
  /** Forward-slash göreli yol: "index.html" | "markdown/<ad>.md". */
  readonly relativePath: string;
  readonly content: string;
}

/**
 * Deterministik dosya kümesi: [index.html, sayfa .md'leri pageId sırasıyla,
 * markdown/index.md]. Yazma katmanı ile determinizm testi aynı bu kümeden
 * okur; iki koşum → bit-bit aynı küme. Şema doğrulaması ve sayfa görünümü
 * kurulumu TEKE indırilmiştir (denetim bulgusu: sayfa başına yeniden
 * doğrulama yerine küme başına tek çözümleme).
 */
export function buildWikiExportFileSet(projection: WikiProjection): readonly WikiExportFile[] {
  const valid = validateProjection(projection);
  const views = buildPageViews(valid);
  const fileNames = exportFileNamesByPageId(valid.pages);
  const files: WikiExportFile[] = [
    { relativePath: WIKI_EXPORT_INDEX_HTML_NAME, content: renderWikiHtml(valid) },
  ];
  for (const view of views) {
    const fileName = fileNames.get(view.page.id);
    if (fileName === undefined) {
      throw new WikiProjectionError(
        "wiki/export-filename-collision",
        `Sayfa için export dosya adı türetilemedi: ${view.page.id}`,
      );
    }
    files.push({
      relativePath: `${WIKI_EXPORT_MARKDOWN_DIR_NAME}/${fileName}`,
      content: renderPageMarkdown(view),
    });
  }
  files.push({
    relativePath: `${WIKI_EXPORT_MARKDOWN_DIR_NAME}/${WIKI_EXPORT_INDEX_MD_NAME}`,
    content: renderIndexMarkdown(valid),
  });
  return files;
}

/* ------------------------------------------------------------------ */
/* Yazma katmanı (yetkilendirme + atomik write — C6 deseni)            */
/* ------------------------------------------------------------------ */

export interface WikiOfflineExportInput {
  readonly projection: WikiProjection;
  /**
   * Hedef çıktı dizini; OutputAccessPolicy beyanlı listesinde olmalıdır.
   * wiki_build'in data-root'u ile ilişkili DEĞİLDİR: export kullanıcı
   * beyanlı output dizinine yazılır (K-012 output-policy).
   */
  readonly outputDir: string;
}

export interface WikiExportWrittenFile {
  /** Forward-slash göreli yol (dosya kümesindekiyle aynı). */
  readonly relativePath: string;
  /** Yazılan dosyanın kanonik gerçek yolu. */
  readonly path: string;
  /** UTF-8 bayt uzunluğu. */
  readonly bytes: number;
  /** Yazma daima atomiktir: `.tmp` + rename. */
  readonly atomic: true;
}

export interface WikiOfflineExportResult {
  /** Yetkilendirilmiş ve yazılan kanonik output dizini. */
  readonly outputDir: string;
  /** Yazılan dosyalar; kanonik dosya kümesi sırasıyla. */
  readonly files: readonly WikiExportWrittenFile[];
  readonly atomic: true;
}

/** Workspace karar kodu → wiki sözleşme kodu eşlemesi (C6 deseni). */
function contractCodeFor(decisionCode: string): "wiki/output-not-authorized" | "wiki/output-path-denied" {
  return decisionCode === "workspace/output-not-authorized"
    ? "wiki/output-not-authorized"
    : "wiki/output-path-denied";
}

/**
 * Yetkilendirilmiş atomik offline export: projeksiyon doğrulanır → saf dosya
 * kümesi üretilir → hedef OutputAccessPolicy ile denetlenir (reddedilen
 * hedefe HİÇBİR dosya yazılmaz, HİÇBİR alt dizin açılmaz) → markdown alt
 * dizini açılıp yeniden yetkilendirilir (realpath sarmalama, CWE-59) → her
 * dosya `.tmp` + rename ile atomik yazılır.
 *
 * İşlem kapsamı (takım denetimi davranış notu, test ile kanıtlı): TÜM KÜME
 * atomik DEĞİLDİR — TŞ §16 "atomik write" dosya düzeyi taahhüttür
 * (WikiExportWrittenFile.atomic dosya başınadır). Döngü ortası yazma hatası
 * `wiki/export-write-failed` ile fırlar; önceki dosyalar output'ta KALIR ve
 * başarısız adımın `.tmp` kalıntısı temizlenir. Tam küme geri alınması
 * (rollback) sözleşmede yoktur ve sessizce iddia edilmez.
 *
 * Yetkilendirme reddi WikiProjectionError ile SABİT wiki sözleşme koduyla
 * fırlatılır; MCP yüzeyi `wiki/output-not-authorized`'ı TŞ §10.1 sabit
 * EXPORT_NOT_ALLOWED'e eşler (graph/export.ts:494–503 ile aynı takım kararı;
 * workspace karar kodu hata mesajında ayrıca taşınır).
 */
export function exportWikiOffline(
  input: WikiOfflineExportInput,
  policy: OutputAccessPolicy,
): WikiOfflineExportResult {
  const valid = validateProjection(input.projection);
  // Saf küme ÖNCE üretilir: içeriğe bağlı hatalar (dosya adı çakışması)
  // dosya sistemine dokunmadan fırlar.
  const fileSet = buildWikiExportFileSet(valid);

  const dirDecision = policy.authorizeDirectory(input.outputDir);
  if (!dirDecision.allowed) {
    throw new WikiProjectionError(
      contractCodeFor(dirDecision.code),
      `Output yetkilendirmesi reddedildi (${dirDecision.code}): ${dirDecision.reason}`,
    );
  }
  const canonicalDir = dirDecision.canonicalDir;

  const markdownDir = path.join(canonicalDir, WIKI_EXPORT_MARKDOWN_DIR_NAME);
  try {
    mkdirSync(markdownDir, { recursive: true });
  } catch (error) {
    throw new WikiProjectionError(
      "wiki/export-write-failed",
      `Markdown alt dizini açılamadı: ${markdownDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Alt dizin realpath'i beyanlı kök içinde kalmalı (önceden konmuş
  // symlink/junction üzerinden kaçış reddi; CWE-59 — C6 dosya düzeyi
  // savunmasının dizin düzeyi karşılığı).
  const markdownDecision = policy.authorizeDirectory(markdownDir);
  if (!markdownDecision.allowed) {
    throw new WikiProjectionError(
      contractCodeFor(markdownDecision.code),
      `Markdown alt dizini yetkilendirmesi reddedildi (${markdownDecision.code}): ${markdownDecision.reason}`,
    );
  }

  const written: WikiExportWrittenFile[] = [];
  for (const file of fileSet) {
    // Bileşenler by-construction ayraçsızdır; yine de savunma katmanı
    // biçimi politikaya kirletmeden önce doğrular (null byte / ayraç).
    const targetDir = file.relativePath.startsWith(`${WIKI_EXPORT_MARKDOWN_DIR_NAME}/`)
      ? markdownDecision.canonicalDir
      : canonicalDir;
    const fileName = file.relativePath.slice(
      targetDir === markdownDecision.canonicalDir ? WIKI_EXPORT_MARKDOWN_DIR_NAME.length + 1 : 0,
    );
    if (
      fileName.length === 0 ||
      fileName.includes("/") ||
      fileName.includes("\\") ||
      fileName.includes("\0") ||
      fileName === "." ||
      fileName === ".."
    ) {
      throw new WikiProjectionError(
        "wiki/output-path-denied",
        `Export dosya adı güvenli değil (ayraç/null byte/".."): ${file.relativePath}`,
      );
    }
    const decision = policy.authorizeFile(targetDir, fileName);
    if (!decision.allowed) {
      throw new WikiProjectionError(
        contractCodeFor(decision.code),
        `Output yetkilendirmesi reddedildi (${decision.code}): ${decision.reason}`,
      );
    }
    const targetPath = decision.canonicalPath;
    const tmpPath = `${targetPath}.tmp`;
    try {
      // C6 savunma derinliği: kalan .tmp girdisi (özellikle önceden konmuş
      // symlink) yazmadan ÖNCE kaldırılır; bağın hedefi dokunulmaz kalır.
      try {
        unlinkSync(tmpPath);
      } catch {
        // tmp yok: temizlik gereksiz; asıl yazma aşağıda.
      }
      writeFileSync(tmpPath, file.content, "utf8");
      renameSync(tmpPath, targetPath);
    } catch (error) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // tmp oluşmadıysa temizlik gereksiz; asıl hata aşağıda raporlanır.
      }
      throw new WikiProjectionError(
        "wiki/export-write-failed",
        `Çıktı dosyası yazılamadı: ${targetPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    written.push({
      relativePath: file.relativePath,
      path: targetPath,
      bytes: Buffer.byteLength(file.content, "utf8"),
      atomic: true,
    });
  }

  return {
    outputDir: canonicalDir,
    files: written,
    atomic: true,
  };
}
