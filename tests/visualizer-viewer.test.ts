import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  VIEWER_CSP_POLICY,
  ViewerError,
  generateViewerHtml,
  type ViewerInput,
} from "../apps/visualizer/src/generate-viewer.js";

/**
 * Sprint-6 E6 — apps/visualizer offline HTML görüntüleyici testleri.
 *
 * Sözleşme (görev metni + TŞ v2.1 §16 s.14):
 * - Statik, offline, self-contained HTML: HARİCİ KAYNAK YOK (CDN/font/
 *   analytics yasak); kısıtlayıcı CSP meta (default-src 'none' tabanlı).
 * - Graph render kendi deterministik inline SVG üretimiyle (Mermaid kütüphane
 *   YOK); resolved(verified)=yeşil, heuristic=sarı, unresolved=gri ayrı
 *   işaretli (TŞ §16 "resolved/heuristic/unresolved edge tipleri ayrı
 *   işaretlenir").
 * - Selection → get_evidence akışı çevrimdışı: her node/edge'te evidence
 *   kimlikleri kanıt kimlikleriyle gömülü; tıklanınca statik gömülü veriden
 *   dosya+satır+analyzer+rationale paneli açılır (get_evidence TOOL çağrısı
 *   DEĞİL — tamamen çevrimdışı sunum).
 * - Determinizm: aynı (GraphSnapshot + WikiSummary girdisi) → bit-bit aynı
 *   HTML; girdi dizi sırasından bağımsız.
 */

const META = {
  id: "snapshot:demo-0001",
  workspaceId: "ws-demo",
  revision: { id: "rev-9f2c", sequence: 4 },
  configHash: "cfg-abc123",
  analyzerFingerprint: "af-def456",
  state: "ready",
  createdAt: "2026-11-08T10:00:00.000Z",
} as const;

const NODES = [
  {
    id: "node:ts-handleRequest",
    kind: "function",
    qualifiedName: "app::handleRequest",
    language: "typescript",
    location: {
      relativePath: "src/app.ts",
      startLine: 10,
      endLine: 40,
      sourceHash: "hash-app",
    },
  },
  {
    id: "node:ts-validate",
    kind: "function",
    qualifiedName: "app::validate",
    language: "typescript",
    location: {
      relativePath: "src/validate.ts",
      startLine: 1,
      endLine: 20,
      sourceHash: "hash-validate",
    },
  },
  {
    id: "node:legacy-util",
    kind: "module",
    qualifiedName: "legacy::util",
  },
] as const;

const EVIDENCE = [
  {
    id: "ev:call-1",
    kind: "call",
    span: {
      relativePath: "src/app.ts",
      startLine: 12,
      endLine: 18,
      sourceHash: "hash-app",
    },
    analyzerId: "ts-calls",
    analyzerVersion: "1.4.0",
    rationale: "handleRequest, validate fonksiyonunu doğrudan çağırıyor",
  },
  {
    id: "ev:import-1",
    kind: "import",
    span: {
      relativePath: "src/validate.ts",
      startLine: 3,
      endLine: 3,
      sourceHash: "hash-validate",
    },
    analyzerId: "ts-imports",
    analyzerVersion: "1.4.0",
    rationale: "validate modülü legacy::util sembolünü import ediyor",
  },
] as const;

const EDGES = [
  {
    id: "edge:call-handle-validate",
    from: "node:ts-handleRequest",
    to: "node:ts-validate",
    kind: "CALLS",
    resolution: "verified",
    evidenceIds: ["ev:call-1"],
  },
  {
    id: "edge:depends-validate-util",
    from: "node:ts-validate",
    to: "node:legacy-util",
    kind: "DEPENDS_ON",
    resolution: "heuristic",
    evidenceIds: ["ev:import-1"],
    ambiguity: {
      candidates: ["legacy::util", "legacy::utilV2"],
      reason: "Aynı adda iki aday sembol; import span tek satır",
    },
  },
  {
    id: "edge:call-handle-util",
    from: "node:ts-handleRequest",
    to: "node:legacy-util",
    kind: "CALLS",
    resolution: "unresolved",
    evidenceIds: [],
  },
] as const;

const WIKI = {
  id: "wiki:demo-0001",
  graphSnapshotId: "snapshot:demo-0001",
  status: "ready",
  revisionRef: "rev-9f2c",
  templateVersion: "wiki-template/1",
  pages: [
    {
      id: "page:legacy-util",
      kind: "module",
      title: "Legacy util",
      route: "modules/legacy-util",
      coverageStatus: "partial",
    },
  ],
} as const;

const FIXTURE: ViewerInput = {
  graph: {
    meta: META,
    nodes: [...NODES],
    edges: [...EDGES],
    evidence: [...EVIDENCE],
  },
  wiki: WIKI,
};

/** Veri adasını (gömülü JSON) HTML'den çeker ve parse eder. */
function extractDataIsland(html: string): {
  nodes: Array<{ id: string; evidenceIds: string[]; qualifiedName: string }>;
  edges: Array<{ id: string; resolution: string; evidenceIds: string[] }>;
  evidence: Array<{
    id: string;
    analyzerId: string;
    analyzerVersion: string;
    rationale: string;
    span?: { relativePath: string; startLine: number; endLine: number };
  }>;
  wiki?: { id: string; pages: Array<{ id: string; title: string }> };
} {
  const match = html.match(
    /<script id="causoryn-data" type="application\/json">([\s\S]*?)<\/script\b[^>]*>/i,
  );
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as ReturnType<typeof extractDataIsland>;
}

/** CSP hash source value: base64 SHA-256 of the exact inline block text. */
function sha256Base64(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("base64");
}

describe("visualizer — pozitif: offline HTML + SVG graph + gömülü evidence", () => {
  const html = generateViewerHtml(FIXTURE);

  it("tek dosyalık offline HTML üretir: DOCTYPE + kısıtlayıcı CSP meta", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${VIEWER_CSP_POLICY}">`,
    );
    // CSP: no external source can load; only the embedded script and style
    // blocks are allowed, by SHA-256 hash (no 'unsafe-inline').
    expect(VIEWER_CSP_POLICY).toContain("default-src 'none'");
    expect(VIEWER_CSP_POLICY).toMatch(/style-src 'sha256-[A-Za-z0-9+/]{43}='/);
    expect(VIEWER_CSP_POLICY).toMatch(/script-src 'sha256-[A-Za-z0-9+/]{43}='/);
    expect(VIEWER_CSP_POLICY).not.toContain("'unsafe-inline'");
    expect(VIEWER_CSP_POLICY).toContain("base-uri 'none'");
    expect(VIEWER_CSP_POLICY).toContain("form-action 'none'");
  });

  it("CSP hashes match the emitted inline script and style blocks exactly", () => {
    for (const input of [FIXTURE, { graph: { ...FIXTURE.graph, nodes: [], edges: [], evidence: [] } }]) {
      const page = generateViewerHtml(input);
      const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(page)?.[1] ?? "";
      expect(csp).toBe(VIEWER_CSP_POLICY);
      expect(csp).not.toContain("'unsafe-inline'");
      expect(csp).not.toContain("'unsafe-eval'");
      const directives = new Map(
        csp
          .split(";")
          .map((directive) => directive.trim())
          .filter((directive) => directive.length > 0)
          .map((directive) => {
            const [name = "", ...values] = directive.split(/\s+/);
            return [name, values] as const;
          }),
      );
      expect(directives.get("default-src")).toEqual(["'none'"]);
      expect(directives.get("base-uri")).toEqual(["'none'"]);
      expect(directives.get("form-action")).toEqual(["'none'"]);

      const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)];
      expect(scripts).toHaveLength(2);
      const executable = scripts.filter((match) => !/type="application\/json"/i.test(match[1] ?? ""));
      expect(executable).toHaveLength(1);
      expect(directives.get("script-src")).toEqual(
        executable.map((match) => `'sha256-${sha256Base64(match[2] ?? "")}'`),
      );

      const styles = [...page.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style\b[^>]*>/gi)];
      expect(styles).toHaveLength(1);
      expect(directives.get("style-src")).toEqual(
        styles.map((match) => `'sha256-${sha256Base64(match[2] ?? "")}'`),
      );

      // Hash-only CSP: inline event handlers or style attributes would be blocked.
      // Text outside the <script>/<style> blocks, taken from the gaps between
      // matches (no replace-based stripping): no other tag may open one.
      const gaps: string[] = [];
      let last = 0;
      for (const block of page.matchAll(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi)) {
        gaps.push(page.slice(last, block.index));
        last = block.index + block[0].length;
      }
      gaps.push(page.slice(last));
      const withoutBlocks = gaps.join("\n");
      expect(/<script\b/i.test(withoutBlocks)).toBe(false);
      expect(/<style\b/i.test(withoutBlocks)).toBe(false);
      expect(/\son[a-z]+\s*=/i.test(withoutBlocks)).toBe(false);
      expect(/\sstyle\s*=/i.test(withoutBlocks)).toBe(false);
    }
  });

  it("kendi inline SVG graph render'ını üretir (Mermaid kütüphanesi yok)", () => {
    expect(html).toContain("<svg");
    expect(html).toContain('viewBox="0 0');
    // 3 node → en az 3 kutu (rect).
    const rectCount = html.match(/<rect/g)?.length ?? 0;
    expect(rectCount).toBeGreaterThanOrEqual(3);
    // Mermaid runtime/CDN izi olmamalı.
    expect(html.toLowerCase().includes("mermaid")).toBe(false);
    // Her node/edge tıklanabilir kimlikle işaretli.
    expect(html).toContain('data-viewer-id="node:ts-handleRequest"');
    expect(html).toContain('data-viewer-id="edge:call-handle-validate"');
  });

  it("resolved/heuristic/unresolved ayrı ayrı işaretli (renk + çizgi biçimi)", () => {
    // TŞ §16: "resolved/heuristic/unresolved edge tipleri ayrı işaretlenir".
    expect(html).toContain("res-verified");
    expect(html).toContain("res-heuristic");
    expect(html).toContain("res-unresolved");
    // Renk kodlaması: verified=yeşil, heuristic=sarı, unresolved=gri.
    expect(html).toContain("#16a34a"); // yeşil
    expect(html).toContain("#d97706"); // sarı
    expect(html).toContain("#6b7280"); // gri
    // Çizgi biçimi ayrımı: kesikli desenler mevcut.
    expect(html).toContain("stroke-dasharray");
    // Lejant üç seviyeyi de metinsel olarak taşır.
    expect(html).toContain("verified");
    expect(html).toContain("heuristic");
    expect(html).toContain("unresolved");
  });

  it("evidence paneli verisi statik gömülüdür (get_evidence TOOL çağrısı değil)", () => {
    expect(html).toContain('id="evidence-panel"');
    expect(html).toContain("<noscript>");
    const data = extractDataIsland(html);
    // Kanıt kayıtları: dosya+satır+analyzer+rationale eksiksiz.
    expect(data.evidence).toHaveLength(2);
    expect(data.evidence[0]).toMatchObject({
      id: "ev:call-1",
      analyzerId: "ts-calls",
      analyzerVersion: "1.4.0",
      rationale: "handleRequest, validate fonksiyonunu doğrudan çağırıyor",
    });
    expect(data.evidence[0]!.span).toMatchObject({
      relativePath: "src/app.ts",
      startLine: 12,
      endLine: 18,
    });
    // Node/edge evidence kimlikleri gömülü; node kuralı = komşu kenarların
    // evidenceIds birleşimi (packages/graph/src/evidence-chain.ts
    // nodeEvidenceIdsInOrder semantiği — get_evidence'ın Faz A düzeni).
    const nodeA = data.nodes.find((n) => n.id === "node:ts-handleRequest");
    expect(nodeA).toBeDefined();
    expect(nodeA!.evidenceIds).toContain("ev:call-1");
    const edge1 = data.edges.find((e) => e.id === "edge:call-handle-validate");
    expect(edge1!.evidenceIds).toEqual(["ev:call-1"]);
    // Kenar çözüm seviyeleri gömülü.
    const edge3 = data.edges.find((e) => e.id === "edge:call-handle-util");
    expect(edge3!.resolution).toBe("unresolved");
    // Belirsizlik bilgisi uydurulmadan taşınır.
    expect(html).toContain("legacy::utilV2");
  });

  it("temiz fixture'ta sıfır dış URL eşleşmesi (CDN/font/analytics yok)", () => {
    // Temiz snapshot verisi URL taşımıyorsa belge HİÇBİR http(s) dizgisi
    // barındırmaz: harici kaynak sıfırdır (hostile veride URL yalnızca
    // kaçırılmış inert METİN olabilir — bkz. negatif test yorumu).
    expect(html.includes("http://")).toBe(false);
    expect(html.includes("https://")).toBe(false);
    expect(html.includes("//cdn")).toBe(false);
    expect(html.includes("www.")).toBe(false);
  });

  it("WikiSnapshot özetini deterministik biçimde gömer", () => {
    expect(html).toContain("wiki:demo-0001");
    expect(html).toContain("Legacy util");
    const data = extractDataIsland(html);
    expect(data.wiki?.id).toBe("wiki:demo-0001");
    expect(data.wiki?.pages[0]?.title).toBe("Legacy util");
  });

  it("bit-bit deterministiktir: aynı girdi → aynı HTML; girdi sırasından bağımsız", () => {
    const again = generateViewerHtml(FIXTURE);
    expect(again).toBe(html);
    // Diziler karıştırılsa bile çıktı aynı (kanonik id sıralaması).
    const shuffled: ViewerInput = {
      graph: {
        meta: META,
        nodes: [...NODES].reverse(),
        edges: [...EDGES].reverse(),
        evidence: [...EVIDENCE].reverse(),
      },
      wiki: { ...WIKI, pages: [...WIKI.pages].reverse() },
    };
    expect(generateViewerHtml(shuffled)).toBe(html);
  });
});

describe("visualizer — negatif: escape + sıfır harici kaynak + dangling edge", () => {
  const HOSTILE: ViewerInput = {
    graph: {
      meta: META,
      nodes: [
        {
          id: "node:evil",
          kind: "function",
          qualifiedName: '<script>alert("x")</script>',
        },
      ],
      edges: [],
      evidence: [
        {
          id: "ev:evil",
          kind: "call",
          analyzerId: "ts-calls",
          analyzerVersion: "1.4.0",
          rationale:
            "kanıt metni https://evil.example/beacon içerir ve </script><script>alert(2)</script> taşır",
        },
      ],
    },
  };

  it("hostile node adı HTML'e kaçırılmadan girmez (escapeHtml)", () => {
    const html = generateViewerHtml(HOSTILE);
    // Ham payload belgede görünmez.
    expect(html.includes('<script>alert("x")</script>')).toBe(false);
    // Görünür metin entity ile kaçırılmış.
    expect(html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    // Belgede yalnızca kendi iki script bloğu vardır: veri adası
    // (application/json veri bloğu, çalıştırılmaz) + statik uygulama betiği.
    // Hostile enjeksiyon sayacı artırmaz.
    const scriptTagCount = html.match(/<script/g)?.length ?? 0;
    expect(scriptTagCount).toBe(2);
    // Veri adası `<` → `\u003c` kaçışıyla güvenli tutulur ama veri BÜTÜNLÜĞÜ
    // korunur: JSON.parse sonrası özgün dizgi birebir geri gelir.
    const data = extractDataIsland(html);
    expect(data.nodes[0]!.qualifiedName).toBe('<script>alert("x")</script>');
    expect(data.evidence[0]!.rationale).toBe(
      HOSTILE.graph.evidence[0]!.rationale,
    );
  });

  it("sıfır harici kaynak eşleşmesi (CDN/font/analytics/ağ primi yok)", () => {
    const html = generateViewerHtml(HOSTILE);
    // Kaynak konumu oluşturan hiçbir desen yok: src/href http, srcset, @import,
    // url(), iframe/embed/object/link/img etiketi, fetch/XHR/beacon/WebSocket.
    // Not: rationale içindeki https:// dizgisi yalnızca kaçırılmış METİN olarak
    // bulunur; hiçbir öznitelik/etiket/kaynak konumu oluşturmaz (CSP
    // default-src 'none' ayrıca tüm yükleme yollarını kapatır).
    const patterns = [
      'src="http',
      "src='http",
      'href="http',
      "href='http",
      "srcset",
      "@import",
      "url(http",
      "<iframe",
      "<embed",
      "<object",
      "<link ",
      "<img",
      "fetch(",
      "XMLHttpRequest",
      "sendBeacon",
      "WebSocket",
      "EventSource",
    ];
    for (const pattern of patterns) {
      expect(
        html.includes(pattern),
        `harici kaynak deseni bulundu: ${pattern}`,
      ).toBe(false);
    }
    // Inline SVG xmlns gerekmez (HTML5 ayrıştırıcı SVG ad uzayını kendisi
    // atar); xmlns niteliği hiç üretilmez (bkz. pozitif sıfır-dış-URL testi).
    expect(html.includes('xmlns="')).toBe(false);
  });

  it("dangling edge sabit hata koduyla reddedilir (sessiz düşürme yok)", () => {
    const broken: ViewerInput = {
      graph: {
        meta: META,
        nodes: [...NODES],
        edges: [
          {
            id: "edge:ghost",
            from: "node:ts-handleRequest",
            to: "node:ghost",
            kind: "CSS",
            resolution: "verified",
            evidenceIds: [],
          },
        ],
        evidence: [],
      },
    };
    let caught: unknown;
    try {
      generateViewerHtml(broken);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ViewerError);
    expect((caught as ViewerError).code).toBe("viewer/dangling-edge");
  });
});

describe("visualizer — partial: boş graph → boş iskelet + uyarı", () => {
  const EMPTY: ViewerInput = {
    graph: {
      meta: { ...META, state: "partial" },
      nodes: [],
      edges: [],
      evidence: [],
    },
  };

  it("boş graph uyarısı + boş SVG iskeleti üretir", () => {
    const html = generateViewerHtml(EMPTY);
    expect(html).toContain('data-empty="true"');
    expect(html).toContain("Empty graph");
    // Boş SVG iskeleti yine de mevcut (viewBox'lı).
    expect(html).toContain("<svg");
    expect(html).toContain('viewBox="0 0');
    // Çözüm seviyesi işareti YOK (kayıt çizilemedi).
    expect(html).not.toContain("res-verified");
    // Panel konteyneri ve veri adası mevcut ama içerik boş.
    expect(html).toContain('id="evidence-panel"');
    const data = extractDataIsland(html);
    expect(data.nodes).toHaveLength(0);
    expect(data.edges).toHaveLength(0);
    expect(data.evidence).toHaveLength(0);
    expect(data.wiki).toBeUndefined();
    // Uyarı ve iskelet deterministik.
    expect(generateViewerHtml(EMPTY)).toBe(html);
  });
});
