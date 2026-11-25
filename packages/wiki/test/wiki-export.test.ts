import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OutputAccessPolicy } from "@causoryn/workspace";

import { WikiProjectionError } from "../src/errors.js";
import {
  WIKI_EXPORT_HTML_CSP,
  WIKI_EXPORT_MARKDOWN_DIR_NAME,
  buildWikiExportFileSet,
  exportWikiOffline,
  serializeWikiHtml,
  serializeWikiIndexMarkdown,
  serializeWikiPageMarkdown,
} from "../src/export.js";
import { WIKI_TEMPLATE_VERSION } from "../src/taxonomy.js";
import type { WikiPage, WikiPageSection, WikiProjection } from "../src/schema.js";

/**
 * Wiki offline export — test üçlüsü (TŞ v2.1 §16A.9, §16, §16A.10 Güvenlik
 * satırı; sprint-4 W8; docs/wiki-spec.md §3.0–3.2).
 *
 * Pozitif: fixture WikiProjection → izinli output dizinine Markdown klasörü
 * (sayfa başına .md + index.md) + self-contained index.html; HTML'de escape,
 * kısıtlayıcı CSP meta ve DIŞ URL YOK (statik http(s):// taraması — §16A.10
 * "offline export ağ isteği yapmaz").
 * Negatif: beyan edilmemiş output dizini → wiki/output-not-authorized
 * (MCP eşlemesi TŞ §10.1 sabit EXPORT_NOT_ALLOWED; reddedilen hedefe
 * HİÇBİR dosya yazılmaz); `<script>` içeren sayfa başlığı ve gövdesi hem
 * .md hem .html çıktısında nötralize edilir; "../../" içeren slug'lı sayfa
 * dizin kaçışı üretmez (traversal reddi); şemayı geçmeyen projeksiyon reddi.
 * Partial: boş projeksiyon (sıfır sayfa/bölüm) → geçerli boş iskelet
 * (index.html + markdown/index.md var, sayfa dosyası yok, CSP durur).
 *
 * Determinizm: iki koşum → bit-bit aynı dosya içerikleri (TŞ §8 invariant
 * vi'nin export karşılığı); saf serializer'lar girdi sırasından bağımsızdır.
 */

const WS = "ws_wiki_export";
const BUILT_AT = "2026-11-06T12:00:00.000Z";

/* ------------------------------------------------------------------ */
/* Fixture — WikiProjection (WikiProjectionSchema strict)              */
/* ------------------------------------------------------------------ */

function page(overrides: Partial<WikiPage> & Pick<WikiPage, "id" | "title" | "slug" | "kind">): WikiPage {
  return {
    wikiSnapshotId: "wiki:export-fixture",
    parentId: null,
    route: `/wiki/${overrides.slug}`,
    contentHash: `sha256:content-${overrides.id}`,
    freshness: "fresh",
    coverage: { status: "complete" },
    ...overrides,
  };
}

function section(
  overrides: Partial<WikiPageSection> & Pick<WikiPageSection, "id" | "pageId">,
): WikiPageSection {
  return {
    sectionKey: "summary",
    generatedMarkdown: `- satır: ${overrides.id}`,
    evidenceRefs: [],
    status: "ok",
    ...overrides,
  };
}

/** TŞ §16A.9 senaryolarını tek projeksiyonda taşıyan fixture. */
function buildFixtureProjection(): WikiProjection {
  const pages: WikiPage[] = [
    page({ id: "page:11111111", kind: "overview", title: "Overview", slug: "overview" }),
    page({
      id: "page:22222222",
      kind: "module",
      parentId: "page:11111111",
      title: "OrderService",
      slug: "orderservice",
      coverage: { status: "partial", detail: "1 çözülemeyen kenar" },
    }),
    page({
      id: "page:33333333",
      kind: "symbol",
      parentId: "page:11111111",
      title: '<script>alert("xss")</script>',
      slug: "evil-script-page",
    }),
    page({
      id: "page:44444444",
      kind: "component",
      parentId: "page:11111111",
      title: "Traversal Candidate",
      slug: "../../escape",
    }),
    page({
      id: "page:55555555",
      kind: "project",
      title: "Overview Duplicate Slug",
      slug: "overview",
    }),
  ];
  const sections: WikiPageSection[] = [
    section({
      id: "section:aaaa0001",
      pageId: "page:11111111",
      sectionKey: "summary",
      generatedMarkdown: "- Workspace: orders-service\n- Graph: 3 node, 2 edge, 1 evidence",
      evidenceRefs: [
        {
          evidenceId: "ev:0001",
          relativePath: "src/orders/index.ts",
          startLine: 1,
          endLine: 5,
          sourceHash: "sha256:fixture-evidence",
        },
      ],
    }),
    section({
      id: "section:aaaa0002",
      pageId: "page:11111111",
      sectionKey: "timeline",
      generatedMarkdown: "",
      status: "no_data",
    }),
    section({
      id: "section:bbbb0001",
      pageId: "page:22222222",
      sectionKey: "calls",
      generatedMarkdown: "- Çözülemeyen kenar: 1",
      status: "partial",
    }),
    section({
      id: "section:cccc0001",
      pageId: "page:33333333",
      sectionKey: "notes",
      generatedMarkdown:
        '<script>alert("gövde xss")</script>\n![beacon](https://evil.example/beacon.png)\n[link](http://evil.example)',
    }),
    section({ id: "section:dddd0001", pageId: "page:44444444" }),
    section({ id: "section:eeee0001", pageId: "page:55555555" }),
  ];
  return {
    snapshot: {
      id: "wiki:export-fixture",
      workspaceId: WS,
      graphSnapshotId: "snap:export-fixture",
      revisionRef: "rev-export-001",
      status: "ready",
      builtAt: BUILT_AT,
      templateVersion: WIKI_TEMPLATE_VERSION,
    },
    pages,
    sections,
    warnings: ["fixture uyarısı: 1 çözülemeyen kenar", "fixture uyarısı: 1 bayat bölüm"],
  };
}

/** §16A.1 boş kategori dürüstlüğü: sıfır sayfa, sıfır bölüm, yalnızca uyarı. */
function buildEmptyProjection(): WikiProjection {
  return {
    snapshot: {
      id: "wiki:export-empty",
      workspaceId: WS,
      graphSnapshotId: "snap:export-empty",
      revisionRef: "rev-export-002",
      status: "partial",
      builtAt: BUILT_AT,
      templateVersion: WIKI_TEMPLATE_VERSION,
    },
    pages: [],
    sections: [],
    warnings: ["boş projeksiyon: kapsamdaki kaynak bulunamadı"],
  };
}

/* ------------------------------------------------------------------ */
/* Temp output dizinleri                                               */
/* ------------------------------------------------------------------ */

const tempRoots: string[] = [];

function makeTempDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `causoryn-wiki-export-${label}-`));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/* ------------------------------------------------------------------ */
/* Pozitif — Markdown klasörü + self-contained index.html              */
/* ------------------------------------------------------------------ */

describe("exportWikiOffline (pozitif)", () => {
  it("fixture projeksiyonu izinli dizine md klasörü + index.html yazar", () => {
    const projection = buildFixtureProjection();
    const outputDir = makeTempDir("positive");
    const policy = OutputAccessPolicy.create([outputDir]);

    const result = exportWikiOffline({ projection, outputDir }, policy);

    expect(result.atomic).toBe(true);
    expect(result.outputDir).toBe(realpathSync(outputDir));
    const writtenRelative = result.files.map((file) => file.relativePath);
    // index.html kökte; markdown klasörü index.md + sayfa başına .md taşır.
    expect(writtenRelative).toContain("index.html");
    expect(writtenRelative).toContain(`${WIKI_EXPORT_MARKDOWN_DIR_NAME}/index.md`);
    expect(writtenRelative).toContain(`${WIKI_EXPORT_MARKDOWN_DIR_NAME}/overview.md`);
    expect(writtenRelative).toContain(`${WIKI_EXPORT_MARKDOWN_DIR_NAME}/orderservice.md`);
    expect(writtenRelative).toContain(`${WIKI_EXPORT_MARKDOWN_DIR_NAME}/evil-script-page.md`);
    // Aynı slug'lı ikinci sayfa id sondasıyla ayrıştırılır (deterministik ad).
    expect(writtenRelative).toContain(`${WIKI_EXPORT_MARKDOWN_DIR_NAME}/overview-55555555.md`);
    // "../../escape" slug'ı ayraçsız güvenli ada indirgenir (traversal yok).
    expect(writtenRelative).toContain(`${WIKI_EXPORT_MARKDOWN_DIR_NAME}/escape.md`);
    // Yazılan liste ile disk içeriği birebir: her kayıt var ve bayt uzunluğu doğru.
    for (const file of result.files) {
      const onDisk = readFileSync(path.join(outputDir, file.relativePath), "utf8");
      expect(onDisk.length).toBeGreaterThan(0);
      expect(file.bytes).toBe(Buffer.byteLength(onDisk, "utf8"));
    }
    expect(result.files.every((file) => file.atomic === true)).toBe(true);
  });

  it("index.md sayfa dizinini kanonik sırada ve dosya adlarıyla taşır", () => {
    const projection = buildFixtureProjection();
    const outputDir = makeTempDir("index-md");
    const policy = OutputAccessPolicy.create([outputDir]);

    exportWikiOffline({ projection, outputDir }, policy);

    const indexMd = readFileSync(
      path.join(outputDir, WIKI_EXPORT_MARKDOWN_DIR_NAME, "index.md"),
      "utf8",
    );
    expect(indexMd).toContain("# Causoryn Living Wiki");
    expect(indexMd).toContain("wiki:export-fixture");
    expect(indexMd).toContain("rev-export-001");
    expect(indexMd).toContain("fixture uyarısı: 1 çözülemeyen kenar");
    // Kanonik sıra pageId'ye göre: overview ilk satır, dup sondalı sonrakiler.
    const overviewRow = indexMd.indexOf("| Overview |");
    const serviceRow = indexMd.indexOf("| OrderService |");
    expect(overviewRow).toBeGreaterThan(-1);
    expect(serviceRow).toBeGreaterThan(overviewRow);
    expect(indexMd).toContain("markdown/overview-55555555.md");
  });

  it("sayfa .md dosyası başlık, bölüm durumu ve kanıt referansı taşır", () => {
    const projection = buildFixtureProjection();
    const files = buildWikiExportFileSet(projection);
    const pageMd = files.find((file) => file.relativePath === "markdown/overview.md");
    expect(pageMd).toBeDefined();
    const content = pageMd?.content ?? "";
    expect(content).toContain("# Overview");
    expect(content).toContain("page:11111111");
    expect(content).toContain("## summary");
    expect(content).toContain("status: ok");
    expect(content).toContain("src/orders/index.ts:1-5");
    expect(content).toContain("- Workspace: orders-service");
    // no_data bölümü İÇERİKSİZ kalmalı (TŞ §16A.1: uydurulmuş içerik yok).
    expect(content).toContain("## timeline");
    expect(content).toContain("status: no_data");
    const timelineIndex = content.indexOf("## timeline");
    const tail = content.slice(timelineIndex);
    expect(tail.indexOf("##")).toBe(0);
    expect(content).not.toContain("uydurma");
  });

  it("index.html kısıtlayıcı CSP meta ile başlar ve tamamen self-contained'dır", () => {
    const projection = buildFixtureProjection();
    const html = serializeWikiHtml(projection);

    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${WIKI_EXPORT_HTML_CSP}">`);
    expect(WIKI_EXPORT_HTML_CSP).toContain("default-src 'none'");
    // Tüm CSS INLINE: <link> etiketi yok, dış stil yok, script yok, iframe yok.
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<style @import");
    expect(html).toContain("<style>");
    // Kaynak yolları metindir; keyfi file:// linki üretilmez (TŞ §16A.9).
    expect(html).not.toContain("file://");
    expect(html).toContain("src/orders/index.ts:1-5");
    // Ağ isteği taraması: belge içinde tek bir http(s):// referansı bile yok.
    expect(httpUrlMatches(html)).toEqual([]);
  });

  it("index.html tüm sayfa içeriğini tek belgede fragment çapalarıyla taşır", () => {
    const projection = buildFixtureProjection();
    const html = serializeWikiHtml(projection);

    expect(html).toContain("wiki:export-fixture");
    expect(html).toContain("fixture uyarısı: 1 çözülemeyen kenar");
    for (const anchor of ['id="p0"', 'id="p1"', 'id="p2"', 'id="p3"', 'id="p4"']) {
      expect(html).toContain(anchor);
    }
    expect(html).toContain('href="#p1"');
    expect(html).toContain("OrderService");
  });
});

/* ------------------------------------------------------------------ */
/* Negatif — yetkilendirme reddi, XSS kaçışı, traversal, şema          */
/* ------------------------------------------------------------------ */

describe("exportWikiOffline (negatif)", () => {
  it("beyan edilmemiş output dizini wiki/output-not-authorized ile reddedilir ve HİÇBİR dosya yazılmaz (MCP eşlemesi EXPORT_NOT_ALLOWED)", () => {
    const projection = buildFixtureProjection();
    const declared = makeTempDir("declared");
    const other = makeTempDir("undeclared");
    const policy = OutputAccessPolicy.create([declared]);

    expect(() => exportWikiOffline({ projection, outputDir: other }, policy)).toThrowError(
      expect.objectContaining({ code: "wiki/output-not-authorized" }),
    );
    // Redde kadar tek dosya bile hedefe sızmadı (fail-closed yetkilendirme).
    expect(readdirSync(other)).toEqual([]);
  });

  it("<script> içeren sayfa başlığı .md ve .html çıktılarında kaçırılır", () => {
    const projection = buildFixtureProjection();
    const outputDir = makeTempDir("xss");
    const policy = OutputAccessPolicy.create([outputDir]);

    exportWikiOffline({ projection, outputDir }, policy);

    const pageMd = readFileSync(
      path.join(outputDir, WIKI_EXPORT_MARKDOWN_DIR_NAME, "evil-script-page.md"),
      "utf8",
    );
    // Ham <script> NE .md NE .html'de geçebilir (TŞ §16A.9 XSS escape).
    expect(pageMd).not.toContain("<script>");
    expect(pageMd).toContain("\\<script\\>");
    const html = readFileSync(path.join(outputDir, "index.html"), "utf8");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    // Gövde markdown'ındaki script ve beacon görseli de nötralize edilir:
    // KAÇIŞSIZ görsel gömme örüntüsü yok, kaçışlı sabit metin var.
    expect(pageMd).not.toMatch(/(?<!\\)!\[beacon\]/);
    // Brackets are escaped too, so neither an image nor a link can form.
    expect(pageMd).toContain("\\!\\[beacon\\]");
    expect(pageMd).not.toMatch(/(?<!\\)<script>/);
    expect(httpUrlMatches(html)).toEqual([]);
  });

  it("../../ içeren slug dizin kaçışı üretmez (traversal reddi, TŞ §16A.10)", () => {
    const projection = buildFixtureProjection();
    const outputDir = makeTempDir("traversal");
    const parent = path.dirname(outputDir);
    const policy = OutputAccessPolicy.create([outputDir]);

    const result = exportWikiOffline({ projection, outputDir }, policy);

    for (const file of result.files) {
      expect(file.relativePath.includes("/") && file.relativePath.includes("..")).toBe(false);
      const resolved = path.resolve(outputDir, file.relativePath);
      expect(resolved.startsWith(path.resolve(outputDir) + path.sep)).toBe(true);
    }
    // Kaçış dosyası output dışına DÜŞMEDI: parent dizinde yalnızca tmp kökü var.
    const siblings = readdirSync(parent).filter((entry) => entry.startsWith("causoryn-wiki-export-traversal"));
    expect(siblings.length).toBe(1);
    expect(readdirSync(path.join(outputDir, WIKI_EXPORT_MARKDOWN_DIR_NAME))).toContain("escape.md");
  });

  it("şemayı geçmeyen projeksiyon (dangling bölüm) sabit kodla reddedilir", () => {
    const projection = buildFixtureProjection();
    const dangling: WikiProjection = {
      ...projection,
      sections: [
        ...projection.sections,
        section({ id: "section:ffff0001", pageId: "page:yok" }),
      ],
    };
    const outputDir = makeTempDir("invalid");
    const policy = OutputAccessPolicy.create([outputDir]);

    expect(() => exportWikiOffline({ projection: dangling, outputDir }, policy)).toThrowError(
      expect.objectContaining({ code: "wiki/export-invalid-projection" }),
    );
    expect(() => serializeWikiHtml(dangling)).toThrowError(
      expect.objectContaining({ code: "wiki/export-invalid-projection" }),
    );
    expect(() => serializeWikiIndexMarkdown(dangling)).toThrowError(WikiProjectionError);
    expect(() => serializeWikiPageMarkdown(dangling, dangling.pages[0]!)).toThrowError(
      WikiProjectionError,
    );
    // Reddedilen export dosya sistemi izi bırakmadı.
    expect(readdirSync(outputDir)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Partial — boş projeksiyon geçerli boş iskelet üretir                */
/* ------------------------------------------------------------------ */

describe("exportWikiOffline (partial)", () => {
  it("boş projeksiyon → geçerli iskelet: index.html + markdown/index.md, sayfa dosyası yok", () => {
    const projection = buildEmptyProjection();
    const outputDir = makeTempDir("empty");
    const policy = OutputAccessPolicy.create([outputDir]);

    const result = exportWikiOffline({ projection, outputDir }, policy);

    const writtenRelative = result.files.map((file) => file.relativePath);
    expect(writtenRelative).toEqual(["index.html", `${WIKI_EXPORT_MARKDOWN_DIR_NAME}/index.md`]);
    const html = readFileSync(path.join(outputDir, "index.html"), "utf8");
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain(WIKI_EXPORT_HTML_CSP);
    expect(html).toContain("0");
    expect(html).toContain("wiki:export-empty");
    expect(html).toContain("boş projeksiyon: kapsamdaki kaynak bulunamadı");
    expect(httpUrlMatches(html)).toEqual([]);
    const indexMd = readFileSync(
      path.join(outputDir, WIKI_EXPORT_MARKDOWN_DIR_NAME, "index.md"),
      "utf8",
    );
    expect(indexMd).toContain("# Causoryn Living Wiki");
    expect(indexMd).toContain("wiki:export-empty");
    // Sayfa dizini boş ama belge geçerli ve uyarı dürüstçe listelenir.
    expect(indexMd).toContain("boş projeksiyon: kapsamdaki kaynak bulunamadı");
  });
});

/* ------------------------------------------------------------------ */
/* Fail-closed davranış sözleşmeleri (takım denetimi ek testleri)      */
/* ------------------------------------------------------------------ */

describe("exportWikiOffline (denetim bulguları)", () => {
  /**
   * wiki/export-filename-collision: ayrık sayfaların adları kümede
   * eşleşirse sessiz üzerine yazma yok — export.ts exportFileNamesByPageId
   * son küme üzerinde çakışma arar (atama sırasına değil küme yapısına
   * bağlı, deterministik karar).
   */
  it("ayrık sayfa adları çakışırsa wiki/export-filename-collision ile reddedilir ve hiçbir dosya yazılmaz", () => {
    // "overview" grubunun ikinci üyesinin id sondası (55555555), ayrı bir
    // sayfanın ÇIPLAK slug'ıyla (overview-55555555) aynı adı üretir.
    const collision: WikiProjection = {
      snapshot: {
        id: "wiki:export-collision",
        workspaceId: WS,
        graphSnapshotId: "snap:export-collision",
        revisionRef: "rev-export-collision",
        status: "ready",
        builtAt: BUILT_AT,
        templateVersion: WIKI_TEMPLATE_VERSION,
      },
      pages: [
        page({
          id: "page:aaaaaaaa",
          kind: "component",
          title: "Bare Suffix Slug",
          slug: "overview-55555555",
        }),
        page({ id: "page:11111111", kind: "overview", title: "Overview", slug: "overview" }),
        page({
          id: "page:55555555",
          kind: "project",
          title: "Overview Second",
          slug: "overview",
        }),
      ],
      sections: [],
      warnings: [],
    };
    expect(() => buildWikiExportFileSet(collision)).toThrowError(
      expect.objectContaining({ code: "wiki/export-filename-collision" }),
    );
    const outputDir = makeTempDir("collision");
    const policy = OutputAccessPolicy.create([outputDir]);
    expect(() => exportWikiOffline({ projection: collision, outputDir }, policy)).toThrowError(
      expect.objectContaining({ code: "wiki/export-filename-collision" }),
    );
    // Çakışma dosya kümesi üretiminde fırladığından output'a dokunulmadı.
    expect(readdirSync(outputDir)).toEqual([]);
  });

  /** wiki/export-unknown-page: projeksiyonda olmayan sayfa sessiz boş belge üretmez. */
  it("projeksiyonda olmayan sayfayla serializeWikiPageMarkdown wiki/export-unknown-page ile reddedilir", () => {
    const projection = buildFixtureProjection();
    const ghost = page({ id: "page:ffffffff", kind: "symbol", title: "Ghost", slug: "ghost" });
    expect(() => serializeWikiPageMarkdown(projection, ghost)).toThrowError(
      expect.objectContaining({ code: "wiki/export-unknown-page" }),
    );
  });

  /**
   * Windows reserved device adları (con/nul/lpt1…): "con.md" Windows'ta
   * yazılamaz → export fail-closed değil KULLANILAMAZ olurdu. Slug bu
   * adlara düşerse deterministik id-sondası zorunlu kılınır (con-<id>.md
   * gibi gövdeli adlar reserved değildir).
   */
  it("Windows reserved device adları yazılabilir deterministik adlara indirgenir", () => {
    const reserved: WikiProjection = {
      snapshot: {
        id: "wiki:export-reserved",
        workspaceId: WS,
        graphSnapshotId: "snap:export-reserved",
        revisionRef: "rev-export-reserved",
        status: "ready",
        builtAt: BUILT_AT,
        templateVersion: WIKI_TEMPLATE_VERSION,
      },
      pages: [
        page({ id: "page:11111111", kind: "module", title: "CON Page", slug: "con" }),
        page({ id: "page:22222222", kind: "data", title: "NUL Page", slug: "nul" }),
        page({ id: "page:33333333", kind: "test", title: "LPT1 Page", slug: "lpt1" }),
      ],
      sections: [],
      warnings: [],
    };
    const outputDir = makeTempDir("reserved");
    const policy = OutputAccessPolicy.create([outputDir]);

    const result = exportWikiOffline({ projection: reserved, outputDir }, policy);

    const names = result.files.map((file) => file.relativePath);
    expect(names).toContain(`${WIKI_EXPORT_MARKDOWN_DIR_NAME}/con-11111111.md`);
    expect(names).toContain(`${WIKI_EXPORT_MARKDOWN_DIR_NAME}/nul-22222222.md`);
    expect(names).toContain(`${WIKI_EXPORT_MARKDOWN_DIR_NAME}/lpt1-33333333.md`);
    expect(names).not.toContain(`${WIKI_EXPORT_MARKDOWN_DIR_NAME}/con.md`);
    for (const name of names.slice(1, 4)) {
      expect(existsSync(path.join(outputDir, name))).toBe(true);
    }
  });

  /**
   * Kabul edilmiş artık riskin kanıtı (denetim bulgusu: defang http(s)
   * kapsar): gövdeye sızan file:// metni HTML'de kaçışlı DÜZ METİN olarak
   * kalır — href üretilmez, TŞ §16A.9 "keyfi file:// link açma" söz
   * konusu değildir; .md'de tıklama gerektiren metindir (tasarımsal).
   */
  it("file:// gövde metni href üretmeden inert metin olarak taşınır", () => {
    const base = buildFixtureProjection();
    const withFileRef: WikiProjection = {
      ...base,
      sections: [
        ...base.sections,
        section({
          id: "section:cccc0002",
          pageId: "page:33333333",
          sectionKey: "kaynak",
          generatedMarkdown: "- yerel dosya: file:///C:/kaynak/sir.ts",
        }),
      ],
    };
    const html = serializeWikiHtml(withFileRef);
    expect(html).toContain("file:///C:/kaynak/sir.ts");
    expect(html).not.toContain('href="file:');
    const outputDir = makeTempDir("fileref");
    const policy = OutputAccessPolicy.create([outputDir]);
    exportWikiOffline({ projection: withFileRef, outputDir }, policy);
    const pageMd = readFileSync(
      path.join(outputDir, WIKI_EXPORT_MARKDOWN_DIR_NAME, "evil-script-page.md"),
      "utf8",
    );
    expect(pageMd).toContain("file:///C:/kaynak/sir.ts");
  });

  /**
   * Belgeli davranış: çoklu dosya export'u TÜM KÜME atomik DEĞİLDİR — her
   * dosya kendi .tmp+rename'iyle atomiktir (WikiExportWrittenFile.atomic);
   * döngü ortası hatada önceki dosyalar kalır, tmp kalıntısı temizlenir.
   */
  it("döngü ortası yazma hatası wiki/export-write-failed ile raporlanır; önceki dosyalar kalır, tmp temizlenir", () => {
    const projection = buildFixtureProjection();
    const outputDir = makeTempDir("partial-write");
    // Kanonik sırada İLK sayfa dosyasının (overview.md) hedefi dizin olarak
    // önceden konur: rename yazma hatası üretir (deterministik enjeksiyon).
    mkdirSync(path.join(outputDir, WIKI_EXPORT_MARKDOWN_DIR_NAME), { recursive: true });
    mkdirSync(path.join(outputDir, WIKI_EXPORT_MARKDOWN_DIR_NAME, "overview.md"));
    const policy = OutputAccessPolicy.create([outputDir]);

    expect(() => exportWikiOffline({ projection, outputDir }, policy)).toThrowError(
      expect.objectContaining({ code: "wiki/export-write-failed" }),
    );
    // Kümede önce yazılan index.html kaldı (kısmi çıktı — belgeli davranış).
    expect(existsSync(path.join(outputDir, "index.html"))).toBe(true);
    // Başarısız adımın .tmp kalıntısı temizlendi (C6 tmp-disiplini).
    const leftovers = readdirSync(path.join(outputDir, WIKI_EXPORT_MARKDOWN_DIR_NAME)).filter(
      (entry) => entry.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Determinizm — iki koşum bit-bit aynı                                */
/* ------------------------------------------------------------------ */

describe("exportWikiOffline (determinizm)", () => {
  it("iki ayrı koşumun tüm dosya içerikleri bit-bit aynıdır", () => {
    const projection = buildFixtureProjection();
    const reversed: WikiProjection = {
      ...projection,
      // Girdi dizisi karıştırılmış olsa bile çıktı kanonik sıradadır.
      pages: [...projection.pages].reverse(),
      sections: [...projection.sections].reverse(),
    };
    const dirA = makeTempDir("det-a");
    const dirB = makeTempDir("det-b");
    const policy = OutputAccessPolicy.create([dirA, dirB]);

    const runA = exportWikiOffline({ projection, outputDir: dirA }, policy);
    const runB = exportWikiOffline({ projection: reversed, outputDir: dirB }, policy);

    expect(runB.files.map((file) => file.relativePath)).toEqual(
      runA.files.map((file) => file.relativePath),
    );
    for (let index = 0; index < runA.files.length; index += 1) {
      const relative = runA.files[index]!.relativePath;
      const bytesA = readFileSync(path.join(dirA, relative));
      const bytesB = readFileSync(path.join(dirB, relative));
      expect(bytesA.equals(bytesB)).toBe(true);
    }
    // Aynı dizine ikinci yazım da bit-bit aynı sonucu verir (idempotent).
    const runA2 = exportWikiOffline({ projection, outputDir: dirA }, policy);
    for (let index = 0; index < runA.files.length; index += 1) {
      const relative = runA.files[index]!.relativePath;
      expect(
        readFileSync(path.join(dirA, relative)).equals(
          readFileSync(path.join(dirA, runA2.files[index]!.relativePath)),
        ),
      ).toBe(true);
    }
  });
});

describe("exportFileSlug — CodeQL #20 tire kırpma paritesi ve ReDoS koruması", () => {
  it("baştaki/sondaki tireleri ve uzun adversarial slug girdilerini O(n) sürede dosya adına indirger", () => {
    const projection: WikiProjection = {
      snapshot: {
        id: "wiki:export-slug-redos",
        workspaceId: WS,
        graphSnapshotId: "snap:export-slug-redos",
        revisionRef: "rev-slug-redos",
        status: "ready",
        builtAt: BUILT_AT,
        templateVersion: WIKI_TEMPLATE_VERSION,
      },
      pages: [
        page({
          id: "page:11111111",
          kind: "module",
          title: "Trimmed",
          slug: "---Hello__World---",
        }),
        page({
          id: "page:22222222",
          kind: "module",
          title: "AllDashes",
          slug: "-".repeat(50_000),
        }),
        page({
          id: "page:33333333",
          kind: "module",
          title: "Wrapped",
          slug: `${"-".repeat(25_000)}alpha${"-".repeat(25_000)}`,
        }),
        page({
          id: "page:44444444",
          kind: "module",
          title: "MidDashes",
          slug: `a${"-".repeat(50_000)}b`,
        }),
      ],
      sections: [],
      warnings: [],
    };

    const start = performance.now();
    const files = buildWikiExportFileSet(projection);
    const elapsedMs = performance.now() - start;

    const names = files.map((file) => file.relativePath);
    expect(names).toContain(`${WIKI_EXPORT_MARKDOWN_DIR_NAME}/hello-world.md`);
    expect(names).toContain(`${WIKI_EXPORT_MARKDOWN_DIR_NAME}/page.md`);
    expect(names).toContain(`${WIKI_EXPORT_MARKDOWN_DIR_NAME}/alpha.md`);
    expect(names).toContain(`${WIKI_EXPORT_MARKDOWN_DIR_NAME}/a-b.md`);
    expect(elapsedMs).toBeLessThan(250);
  });
});

/* ------------------------------------------------------------------ */
/* Hostile text in Markdown output                                     */
/* ------------------------------------------------------------------ */

const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/;
const RAW_AUTOLINK = /(?:https?|ftp):\/\/|www\./i;

function buildHostileProjection(): WikiProjection {
  const base = buildFixtureProjection();
  return {
    ...base,
    pages: base.pages.map((candidate) =>
      candidate.id === "page:22222222"
        ? { ...candidate, title: "OrderService\n```mermaid\nclick A call alert(1)\n```\n# Injected title" }
        : candidate,
    ),
    sections: [
      ...base.sections,
      section({
        id: "section:bbbb0002",
        pageId: "page:22222222",
        sectionKey: "deps\n# Injected section ~~~",
        generatedMarkdown: [
          "- Workspace: orders-service",
          "- Module: src/we`ird\r```mermaid\r%%{init: {'theme':'dark'}}%%\r```",
          "- Path: src/a.ts\r\n# Injected heading\n> injected quote",
          "- Link: [x](https://evil.test/a) www.evil.test ftp://files.test/x",
          "~~~",
        ].join("\n"),
        evidenceRefs: [
          {
            evidenceId: "ev:hostile`1",
            relativePath: "src/x\n# Injected evidence.ts",
            startLine: 1,
            endLine: 2,
            sourceHash: "sha256:hostile",
          },
        ],
      }),
    ],
    warnings: [...base.warnings, "warning\n```\n# Injected warning https://evil.test/w"],
  };
}

describe("exportWikiOffline (hostile Markdown text)", () => {
  it("page and index Markdown contain no injected fence, heading, blockquote, CR or bare autolink", () => {
    const files = buildWikiExportFileSet(buildHostileProjection());
    for (const file of files.filter((candidate) => candidate.relativePath.endsWith(".md"))) {
      const lines = file.content.split("\n");
      expect(lines.filter((line) => FENCE_LINE.test(line)), file.relativePath).toEqual([]);
      expect(file.content, file.relativePath).not.toMatch(/^#{1,6} Injected/m);
      expect(file.content, file.relativePath).not.toMatch(/^ {0,3}> injected/m);
      expect(file.content, file.relativePath).not.toContain("\r");
      expect(RAW_AUTOLINK.test(file.content), file.relativePath).toBe(false);
      // Mermaid directive text is inert here because no fence can be opened.
    }
    const pageMd = files.find((candidate) => candidate.relativePath === "markdown/orderservice.md");
    const content = pageMd?.content ?? "";
    // Generated list structure is kept; only the hostile characters are escaped.
    expect(content).toContain("- Workspace: orders-service");
    expect(content).toContain("- Module: src/we\\`ird");
    expect(content).toContain("\\# Injected heading");
    expect(content).toContain("\\> injected quote");
    expect(content).toContain("\\[x\\]\\(https\\://evil.test/a\\)");
  });
});

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */

/** Statik ağ isteği taraması: belge metnindeki ham http(s):// öbekleri. */
function httpUrlMatches(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s"'<>)]*/g)].map((match) => match[0]);
}
