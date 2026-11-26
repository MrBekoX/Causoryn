import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { symlink as symlinkAsync, writeFile as writeFileAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  createSnapshot,
  type SnapshotGraph,
  type SnapshotNodeInput,
} from "@causoryn/domain";
import { OutputAccessPolicy, OutputPolicyError } from "@causoryn/workspace";

import {
  EXPORT_DEFAULT_FILE_NAMES,
  EXPORT_DOCUMENTATION_FORMATS,
  exportDocumentationFormatSchema,
  serializeDocumentation,
  serializeDocumentationHtml,
  serializeDocumentationJson,
  serializeDocumentationMarkdown,
  serializeDocumentationMermaid,
  writeDocumentation,
} from "../src/export.js";
import * as graphIndex from "../src/index.js";
import {
  diffContentSets,
  GraphRepositoryError,
  readTimelinePointFromGit,
  serializeSnapshotContentSet,
  TIMELINE_SNAPSHOT_BLOB_PATH,
  type CompareContentSet,
} from "../src/index.js";

/**
 * causoryn_export_documentation çekirdeği — test üçlüsü (TŞ v2.1 §16
 * "Onboarding, görselleştirme ve export"; sprint-3 C6).
 *
 * Pozitif: dört formatın (json/markdown/mermaid/html) fixture graph'tan
 * geçerli çıktısı; Mermaid deterministik flowchart sözdizimi; HTML'de
 * escape + kısıtlayıcı CSP meta + harici kaynak/CDN/script YOK; yazma
 * katmanı izinli dizine atomik yazar.
 * Negatif: beyan edilmemiş output dizini → export/output-not-authorized
 * (MCP eşlemesi TŞ §10.1 sabit EXPORT_NOT_ALLOWED); üst-dizin (dot-dot)
 * traversal reddi; ayraçlı dosya adı reddi; geçersiz format reddi.
 * Partial: boş graph → boş ama geçerli çıktı (dört format + yazma).
 *
 * Determinizm: aynı girdi → aynı çıktı; node/edge/evidence dizisi sırası
 * karışsa bile çıktı bit düzeyinde aynıdır (kanonik sıralama).
 */

const WS = "ws_export";
const CREATED_AT = "2026-11-05T09:00:00.000Z";
const DOT_DOT = "." + ".";

/* ------------------------------------------------------------------ */
/* Fixture: 4 node (XSS + pipe adları dahil), 2 kenar, 1 kanıt          */
/* ------------------------------------------------------------------ */

function nodeInput(
  kind: SnapshotNodeInput["kind"],
  qualifiedName: string,
  relativePath: string,
  startLine: number,
  endLine: number,
): SnapshotNodeInput {
  return {
    kind,
    qualifiedName,
    language: "typescript",
    location: {
      relativePath,
      startLine,
      endLine,
      sourceHash: `sha256:${relativePath}:${startLine}`,
    },
    attributes: {},
  };
}

const MODULE_BILLING = nodeInput(
  "Module",
  "app::billing|orders",
  "src/orders/index.ts",
  1,
  20,
);
const MODULE_SHARED = nodeInput("Module", "app::shared", "src/shared/index.ts", 1, 10);
const FN_CREATE_ORDER = nodeInput(
  "Function",
  "app::orders::createOrder",
  "src/orders/create.ts",
  5,
  25,
);
/** XSS deneme adı: <script> + çift tırnak — escape testlerinin hedefi. */
const FN_XSS = nodeInput(
  "Function",
  'app::x::<script>alert("xss")</script>',
  "src/x/pay.ts",
  3,
  9,
);

const EV_DEPENDS: {
  kind: string;
  span: { relativePath: string; startLine: number; endLine: number; sourceHash: string };
  analyzerId: string;
  analyzerVersion: string;
  rationale: string;
} = {
  kind: "static-analysis",
  span: {
    relativePath: "src/orders/index.ts",
    startLine: 1,
    endLine: 20,
    sourceHash: "sha256:src/orders/index.ts:1",
  },
  analyzerId: "typescript-adapter",
  analyzerVersion: "0.1.0",
  rationale: "DEPENDS_ON: package.json bağımlılık bildirimi",
};

function positiveGraph(): SnapshotGraph {
  return createSnapshot({
    workspaceId: WS,
    revision: { id: "rev-1", sequence: 1 },
    configHash: "confighash-export",
    analyzerFingerprint: "typescript-adapter@0.1.0",
    state: "ready",
    createdAt: CREATED_AT,
    nodes: [MODULE_BILLING, MODULE_SHARED, FN_CREATE_ORDER, FN_XSS],
    edges: [
      {
        kind: "DEPENDS_ON",
        from: MODULE_BILLING,
        to: MODULE_SHARED,
        resolution: "verified",
        evidence: [EV_DEPENDS],
      },
      {
        kind: "CALLS",
        from: FN_CREATE_ORDER,
        to: FN_XSS,
        resolution: "heuristic",
      },
    ],
  });
}

/** Aynı graph; node/edge/evidence dizileri ters sırada (determinizm girdisi). */
function shuffledGraph(): SnapshotGraph {
  const base = positiveGraph();
  return {
    ...base,
    nodes: [...base.nodes].reverse(),
    edges: [...base.edges].reverse(),
    evidence: [...base.evidence].reverse(),
  };
}

function emptyGraph(): SnapshotGraph {
  return createSnapshot({
    workspaceId: WS,
    revision: { id: "rev-empty", sequence: 0 },
    configHash: "confighash-empty",
    analyzerFingerprint: "typescript-adapter@0.1.0",
    state: "ready",
    createdAt: CREATED_AT,
    nodes: [],
    edges: [],
  });
}

/* ------------------------------------------------------------------ */
/* Temp output dizinleri                                               */
/* ------------------------------------------------------------------ */

const tempRoots: string[] = [];

function makeTempDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `causoryn-export-${label}-`));
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
/* Pozitif — format yüzeyi ve serializer çıktıları                     */
/* ------------------------------------------------------------------ */

describe("export format yüzeyi", () => {
  it("Zod enum'u tam olarak json|markdown|mermaid|html|snapshot kabul eder", () => {
    expect([...EXPORT_DOCUMENTATION_FORMATS]).toEqual([
      "json",
      "markdown",
      "mermaid",
      "html",
      "snapshot",
    ]);
    for (const format of EXPORT_DOCUMENTATION_FORMATS) {
      expect(exportDocumentationFormatSchema.safeParse(format).success).toBe(true);
    }
    expect(exportDocumentationFormatSchema.safeParse("xml").success).toBe(false);
    expect(exportDocumentationFormatSchema.safeParse("").success).toBe(false);
    expect(typeof (graphIndex as Record<string, unknown>)["serializeDocumentationSnapshot"]).toBe(
      "function",
    );
  });

  it("dispatcher her formatı kendi serializer'ına yönlendirir", () => {
    const snapshot = positiveGraph();
    expect(serializeDocumentation(snapshot, "json")).toBe(serializeDocumentationJson(snapshot));
    expect(serializeDocumentation(snapshot, "markdown")).toBe(
      serializeDocumentationMarkdown(snapshot),
    );
    expect(serializeDocumentation(snapshot, "mermaid")).toBe(
      serializeDocumentationMermaid(snapshot),
    );
    expect(serializeDocumentation(snapshot, "html")).toBe(serializeDocumentationHtml(snapshot));
    expect(serializeDocumentation(snapshot, "snapshot")).toBe(
      serializeSnapshotContentSet(snapshot),
    );
  });

  it("şemayı geçmeyen format sabit hata koduyla reddedilir", () => {
    const snapshot = positiveGraph();
    expect(() =>
      serializeDocumentation(snapshot, "xml" as (typeof EXPORT_DOCUMENTATION_FORMATS)[number]),
    ).toThrowError(expect.objectContaining({ code: "export/invalid-format" }));
  });
});

describe("JSON serializer (canonical)", () => {
  it("fixture graph'ı canonical JSON olarak üretir", () => {
    const snapshot = positiveGraph();
    const output = serializeDocumentationJson(snapshot);
    const parsed: unknown = JSON.parse(output);

    // Canonical özelliği: yeniden kanonikleştirme bit düzeyinde aynıdır
    // (anahtarlar sıralı, beyaz boşluk yok).
    expect(canonicalJson(parsed as never)).toBe(output);

    const record = parsed as {
      meta: { id: string; state: string };
      nodes: { id: string }[];
      edges: { id: string; kind: string; resolution: string }[];
      evidence: { id: string }[];
    };
    expect(record.meta.state).toBe("ready");
    expect(record.nodes).toHaveLength(4);
    expect(record.edges).toHaveLength(2);
    expect(record.evidence).toHaveLength(1);
    // Diziler id'ye göre kanonik sırada.
    const ids = record.nodes.map((node) => node.id);
    expect([...ids].sort()).toEqual(ids);
    // Kenar çözüm düzeyleri ayrı taşınır (TŞ §16: resolved/heuristic ayrı işaretlenir).
    const resolutions = record.edges.map((edge) => edge.resolution).sort();
    expect(resolutions).toEqual(["heuristic", "verified"]);
  });
});

describe("Markdown serializer", () => {
  it("başlıklar, sayaçlar ve meta alanlarını taşır", () => {
    const snapshot = positiveGraph();
    const output = serializeDocumentationMarkdown(snapshot);
    expect(output.startsWith("# Causoryn Architecture Documentation\n")).toBe(true);
    expect(output).toContain("## Snapshot");
    expect(output).toContain(`- id: ${snapshot.meta.id}`);
    expect(output).toContain("- state: ready");
    expect(output).toContain("## Nodes (4)");
    expect(output).toContain("## Edges (2)");
    expect(output).toContain("## Evidence (1)");
    expect(output).toContain("DEPENDS_ON");
    expect(output).toContain("verified");
    expect(output).toContain("heuristic");
  });

  it("tablo hücresindeki '|' karakterini kaçırır", () => {
    const output = serializeDocumentationMarkdown(positiveGraph());
    expect(output).toContain("app::billing\\|orders");
    expect(output).not.toContain("| app::billing|orders");
  });

  it("satır sonu/newline'ları hücre içi boşlukla indirir", () => {
    const withNewline = createSnapshot({
      workspaceId: WS,
      revision: { id: "rev-nl", sequence: 1 },
      configHash: "confighash-nl",
      analyzerFingerprint: "typescript-adapter@0.1.0",
      state: "ready",
      createdAt: CREATED_AT,
      nodes: [nodeInput("Module", "app::line\nbreak", "src/a.ts", 1, 2)],
      edges: [],
    });
    const output = serializeDocumentationMarkdown(withNewline);
    expect(output).toContain("app::line break");
    expect(output).not.toContain("app::line\nbreak");
  });

  it("hücredeki link/HTML metakarakterlerini kaçırır; kötü niyetli dosya adı beacon/link üretmez", () => {
    // Güvenlik bulgusu (düşük): node.location.relativePath güvenilmez depo
    // verisidir; '![a](https://evil/x).ts' gibi bir ad kaçırılmazsa ağa
    // erişimli GFM görüntüleyicide beacon/link olarak işlenir (TŞ §16
    // export güvenliği; §19 depo güvenilmez girdi sayılır).
    const evil = createSnapshot({
      workspaceId: WS,
      revision: { id: "rev-md-link", sequence: 1 },
      configHash: "confighash-md-link",
      analyzerFingerprint: "typescript-adapter@0.1.0",
      state: "ready",
      createdAt: CREATED_AT,
      nodes: [
        nodeInput("Module", "app::md::beacon", "![a](https://evil/x).ts", 1, 2),
        nodeInput("Function", 'app::x::<script>alert("xss")</script>', "src/x/pay.ts", 3, 9),
      ],
      edges: [],
    });
    const output = serializeDocumentationMarkdown(evil);
    // Beacon/link dizgisi bozulmuş olmalı: hücrede GFM sözdizimi oluşamaz.
    expect(output).not.toContain("![a](https://evil/x)");
    // Ham inline HTML yok: <script> backslash kaçışlı görünür.
    expect(output).not.toContain("<script>");
    // Kaçış biçimi deterministiktir ve içerik okunur kalır:
    expect(output).toContain("\\!\\[a\\]\\(https://evil/x\\).ts");
    expect(output).toContain('app::x::\\<script\\>alert\\("xss"\\)\\</script\\>');
  });
});

describe("Mermaid serializer (deterministik flowchart)", () => {
  it("fixture graph için deterministik flowchart sözdizimi üretir", () => {
    const snapshot = positiveGraph();
    const output = serializeDocumentationMermaid(snapshot);
    const lines = output.split("\n");
    expect(lines[0]).toBe("flowchart TD");

    // Node satırları: sıralı id → n0..nN, tırnaklı kaçış'lı etiket.
    const nodeLines = lines.filter((line) => /^  n\d+\[".+"\]$/.test(line));
    expect(nodeLines).toHaveLength(4);
    // Kenar satırları: resolution'a göre ok biçimi sabit.
    const verifiedEdge = lines.find((line) =>
      /^  n\d+ -->\|DEPENDS_ON\/verified\| n\d+$/.test(line),
    );
    expect(verifiedEdge).toBeDefined();
    const heuristicEdge = lines.find((line) =>
      /^  n\d+ -\.->\|CALLS\/heuristic\| n\d+$/.test(line),
    );
    expect(heuristicEdge).toBeDefined();

    // XSS adı kaçırılmış olmalı: ham <script> yok, HTML entity var.
    expect(output).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(output.includes("<script>")).toBe(false);
  });

  it("aynı graph'ın karıştırılmış kopyasından bit düzeyinde aynı çıktıyı üretir", () => {
    const a = serializeDocumentationMermaid(positiveGraph());
    expect(serializeDocumentationMermaid(positiveGraph())).toBe(a);
    expect(serializeDocumentationMermaid(shuffledGraph())).toBe(a);
  });

  it("neutralises Mermaid directives, comments and quote breakout in node labels", () => {
    const hostile = createSnapshot({
      workspaceId: "ws-mermaid-hostile",
      revision: { id: "rev-mermaid-hostile", sequence: 1 },
      configHash: "cfg-mermaid-hostile",
      analyzerFingerprint: "typescript-adapter@0.1.0",
      state: "ready",
      createdAt: CREATED_AT,
      nodes: [
        nodeInput("Function", "app::%%{init: {'theme':'dark'}}%%", "src/a.ts", 1, 2),
        nodeInput("Function", 'app::x"]\nclick n0 call alert(1)\n%% c `md`', "src/b.ts", 3, 4),
      ],
      edges: [],
    });
    const output = serializeDocumentationMermaid(hostile);
    const lines = output.trimEnd().split("\n");
    expect(lines[0]).toBe("flowchart TD");
    expect(lines).toHaveLength(3);
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/^ {2}n\d+\["[^"]*"\]$/);
    }
    expect(output).not.toContain("%%");
    expect(output).not.toMatch(/[{}`]/);
    expect(output).not.toMatch(/^\s*click\b/m);
  });
});

describe("HTML serializer (offline self-contained)", () => {
  it("kısıtlayıcı CSP meta etiketi taşır", () => {
    const output = serializeDocumentationHtml(positiveGraph());
    expect(output).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(output).toContain("default-src 'none'");
  });

  it("hiçbir harici kaynak, script veya bağlantı yüklemez (CDN yok)", () => {
    const output = serializeDocumentationHtml(positiveGraph());
    expect(/<script/i.test(output)).toBe(false);
    expect(/<link\b/i.test(output)).toBe(false);
    expect(/<img\b/i.test(output)).toBe(false);
    expect(/\ssrc\s*=/i.test(output)).toBe(false);
    expect(/\shref\s*=/i.test(output)).toBe(false);
    expect(/https?:\/\//i.test(output)).toBe(false);
  });

  it("tüm dinamik değerleri HTML-escape eder (XSS denemesi)", () => {
    const output = serializeDocumentationHtml(positiveGraph());
    expect(output).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(output.includes("<script")).toBe(false);
    expect(output).toContain("app::billing&#124;orders");
  });

  it("snapshot meta, node/edge/evidence tablolarını ve sayaçları içerir", () => {
    const output = serializeDocumentationHtml(positiveGraph());
    expect(output).toContain(`id: ${snapshotMetaId(positiveGraph())}`.replace("id: ", ""));
    expect(output).toContain("Nodes (4)");
    expect(output).toContain("Edges (2)");
    expect(output).toContain("Evidence (1)");
    expect(output).toContain("DEPENDS_ON");
  });
});

function snapshotMetaId(snapshot: SnapshotGraph): string {
  return snapshot.meta.id;
}

describe("Snapshot serializer (CompareContentSet mimari blob'u)", () => {
  it("varsayılan dosya adı architecture-snapshot.json'dur ve TIMELINE_SNAPSHOT_BLOB_PATH ile hizalıdır", () => {
    expect(EXPORT_DEFAULT_FILE_NAMES.snapshot).toBe("architecture-snapshot.json");
    expect(TIMELINE_SNAPSHOT_BLOB_PATH.endsWith(`/${EXPORT_DEFAULT_FILE_NAMES.snapshot}`)).toBe(
      true,
    );
  });

  it("serializeSnapshotContentSet ile bit düzeyinde özdeş ve karıştırmaya karşı deterministiktir", () => {
    const base = positiveGraph();
    const shuffled = shuffledGraph();
    const expected = serializeSnapshotContentSet(base);

    expect(serializeDocumentation(base, "snapshot")).toBe(expected);
    expect(serializeDocumentation(shuffled, "snapshot")).toBe(expected);
    expect(serializeDocumentation(emptyGraph(), "snapshot")).toBe(
      serializeSnapshotContentSet(emptyGraph()),
    );
  });

  it("dangling kenar içeren bozuk snapshot'ı sabit hata koduyla reddeder", () => {
    const base = positiveGraph();
    const firstNode = base.nodes[0];
    if (firstNode === undefined) {
      throw new Error("fixture node eksik");
    }
    const danglingGraph: SnapshotGraph = {
      ...base,
      edges: [
        ...base.edges,
        {
          id: "edge:dangling-snapshot",
          kind: "CALLS",
          from: firstNode.id,
          to: "node:non-existent-target",
          resolution: "verified",
          evidenceIds: ["ev:dangling"],
        },
      ],
    };

    try {
      serializeDocumentation(danglingGraph, "snapshot");
      expect.unreachable("dangling-edge hatası beklenmişti");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphRepositoryError);
      expect((error as GraphRepositoryError).code).toBe("export/dangling-edge");
    }
  });

  it("writeDocumentation ile üretilen snapshot blob'u readTimelinePointFromGit(working-tree) ve diffContentSets tarafından analyzed olarak okunur", async () => {
    const snapshot = positiveGraph();
    const outputDir = makeTempDir("snap-out");
    const policy = OutputAccessPolicy.create([outputDir]);

    const written = writeDocumentation(
      { snapshot, format: "snapshot", outputDir },
      policy,
    );
    expect(written.path.endsWith("architecture-snapshot.json")).toBe(true);
    expect(written.format).toBe("snapshot");
    expect(written.atomic).toBe(true);

    const blobContent = readFileSync(written.path, "utf8");
    expect(blobContent).toBe(serializeSnapshotContentSet(snapshot));

    const repoRoot = makeTempDir("snap-git-repo");
    const initResult = spawnSync("git", ["-C", repoRoot, "init", "-b", "main"], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
    });
    if (initResult.status !== 0) {
      throw new Error(`git init başarısız: ${String(initResult.stderr)}`);
    }
    const causorynDir = path.join(repoRoot, ".causoryn");
    mkdirSync(causorynDir, { recursive: true });
    writeFileSync(path.join(causorynDir, "architecture-snapshot.json"), blobContent, "utf8");

    const point = await readTimelinePointFromGit(repoRoot, "working-tree");
    expect(point.status).toBe("analyzed");
    if (point.status !== "analyzed") {
      throw new Error(`analyzed beklenmişti: ${point.reason}`);
    }
    expect(point.contentSet.nodes).toHaveLength(4);
    expect(point.contentSet.edges).toHaveLength(2);

    const emptyOutDir = makeTempDir("snap-empty-out");
    const emptyWritten = writeDocumentation(
      {
        snapshot: emptyGraph(),
        format: "snapshot",
        outputDir: emptyOutDir,
      },
      OutputAccessPolicy.create([emptyOutDir]),
    );
    const emptyContentSet = JSON.parse(
      readFileSync(emptyWritten.path, "utf8"),
    ) as CompareContentSet;

    const diffFromEmpty = diffContentSets(emptyContentSet, point.contentSet);
    expect(diffFromEmpty.summary.added).toBe(4);
    expect(diffFromEmpty.summary.edgeAdded).toBe(2);
    expect(diffFromEmpty.summary.removed).toBe(0);

    const selfDiff = diffContentSets(point.contentSet, point.contentSet);
    expect(selfDiff.summary.unchangedNodes).toBe(4);
    expect(selfDiff.summary.edgeUnchanged).toBe(2);
    expect(selfDiff.summary.added).toBe(0);
    expect(selfDiff.summary.removed).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Pozitif — yazma katmanı                                             */
/* ------------------------------------------------------------------ */

describe("writeDocumentation (izinli output dizinine atomik yazma)", () => {
  it("dört formatı varsayılan dosya adlarıyla yazar", () => {
    const snapshot = positiveGraph();
    const outputDir = makeTempDir("pos");
    const policy = OutputAccessPolicy.create([outputDir]);

    for (const format of EXPORT_DOCUMENTATION_FORMATS) {
      const result = writeDocumentation({ snapshot, format, outputDir }, policy);
      const expectedName = EXPORT_DEFAULT_FILE_NAMES[format];
      expect(result.path.endsWith(expectedName)).toBe(true);
      expect(result.format).toBe(format);
      expect(result.atomic).toBe(true);
      const written = readFileSync(result.path, "utf8");
      expect(written).toBe(serializeDocumentation(snapshot, format));
      expect(result.bytes).toBe(Buffer.byteLength(written, "utf8"));
    }
    expect(readdirSync(outputDir).sort()).toEqual(
      Object.values(EXPORT_DEFAULT_FILE_NAMES).slice().sort(),
    );
  });

  it("aynı hedefe ikinci yazma tek dosya bırakır (atomik overwrite)", () => {
    const snapshot = positiveGraph();
    const outputDir = makeTempDir("atomic");
    const policy = OutputAccessPolicy.create([outputDir]);
    const first = writeDocumentation({ snapshot, format: "json", outputDir }, policy);
    const second = writeDocumentation({ snapshot, format: "json", outputDir }, policy);
    expect(second.path).toBe(first.path);
    expect(readdirSync(outputDir)).toEqual([EXPORT_DEFAULT_FILE_NAMES.json]);
  });

  it("os.a..b gibi nokta içeren dosya adı geçerlidir ('..' yalnızca tam segmenttir)", () => {
    const snapshot = positiveGraph();
    const outputDir = makeTempDir("dots");
    const policy = OutputAccessPolicy.create([outputDir]);
    const result = writeDocumentation(
      { snapshot, format: "markdown", outputDir, fileName: "rapor..v2.md" },
      policy,
    );
    expect(existsSync(result.path)).toBe(true);
  });

  it("önceden konmuş <hedef>.tmp sembolik bağı İZLENMEZ ve SİLİNMEZ (CAU-08); bağın dışarıdaki hedefi değişmez", async () => {
    // Güvenlik bulgusu (düşük, savunma derinliği): hedef authorizeFile ile
    // doğrulanır ama türetilen .tmp yeniden doğrulanmaz; output dizininde
    // önceden var olan .tmp sembolik bağı yazmayı İZİNİ takip ederek beyanlı
    // dizin dışına yönlendirebilir (TŞ §16 atomik yazma + §19 tehdit modeli).
    const snapshot = positiveGraph();
    const outputDir = makeTempDir("tmp-link");
    const outsideDir = makeTempDir("tmp-link-outside");
    const victimPath = path.join(outsideDir, "victim.txt");
    // Test fixture sınırı: victim dosyası dış dizinin bir altıdır (bağın
    // hedefi kasaca dizin DIŞI olduğundan emin olmak için bilinçli).
    if (!victimPath.startsWith(outsideDir + path.sep)) {
      throw new Error("fixture sınırı aşıldı: victim yolu dış dizinde değil");
    }
    await writeFileAsync(victimPath, "ESKI-ICERIK", "utf8");
    const target = path.join(outputDir, EXPORT_DEFAULT_FILE_NAMES.json);
    if (!target.startsWith(outputDir + path.sep)) {
      throw new Error("fixture sınırı aşıldı: hedef yolu output dizininde değil");
    }
    await symlinkAsync(victimPath, `${target}.tmp`);

    const policy = OutputAccessPolicy.create([outputDir]);
    const result = writeDocumentation({ snapshot, format: "json", outputDir }, policy);

    // Bağın dışarıdaki hedefi YENİDEN YAZILMAMIŞ olmalı.
    expect(readFileSync(victimPath, "utf8")).toBe("ESKI-ICERIK");
    // Hedef, izinli dizinde DÜZENLİ dosya olarak yazılmış olmalı (kanonik realpath).
    expect(result.path).toBe(path.join(realpathSync(outputDir), EXPORT_DEFAULT_FILE_NAMES.json));
    expect(existsSync(target)).toBe(true);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toBe(serializeDocumentation(snapshot, "json"));
    // CAU-08: the planted entry is not this export's temp file, so it is
    // left in place (formerly the export removed it); the export leaves
    // no temp file of its own.
    expect(lstatSync(`${target}.tmp`).isSymbolicLink()).toBe(true);
    expect(readdirSync(outputDir).sort()).toEqual(
      [EXPORT_DEFAULT_FILE_NAMES.json, `${EXPORT_DEFAULT_FILE_NAMES.json}.tmp`].sort(),
    );
  });
});

/* ------------------------------------------------------------------ */
/* Negatif — output yetkilendirmesi                                    */
/* ------------------------------------------------------------------ */

describe("output yetkilendirmesi (negatif)", () => {
  it("beyan edilmemiş output dizini export/output-not-authorized ile reddedilir (MCP eşlemesi EXPORT_NOT_ALLOWED)", () => {
    const snapshot = positiveGraph();
    const declared = makeTempDir("decl");
    const other = makeTempDir("other");
    const policy = OutputAccessPolicy.create([declared]);

    expect(() =>
      writeDocumentation({ snapshot, format: "html", outputDir: other }, policy),
    ).toThrowError(expect.objectContaining({ code: "export/output-not-authorized" }));
    // Reddedilen dizine hiçbir dosya yazılmamış olmalı.
    expect(readdirSync(other)).toEqual([]);
    expect(readdirSync(declared)).toEqual([]);
  });

  it("outputDir '..' traversal ile beyanlı kökün dışına çıkamaz", () => {
    const snapshot = positiveGraph();
    const declared = makeTempDir("decl2");
    const parent = path.dirname(declared);
    const escapeDir = path.join(parent, "causoryn-escape-c6");
    mkdirSync(escapeDir, { recursive: true });
    try {
      const policy = OutputAccessPolicy.create([declared]);
      const traversalDir = path.join(declared, DOT_DOT, "causoryn-escape-c6");
      expect(() =>
        writeDocumentation({ snapshot, format: "json", outputDir: traversalDir }, policy),
      ).toThrowError(expect.objectContaining({ code: "export/output-not-authorized" }));
      expect(readdirSync(escapeDir)).toEqual([]);
    } finally {
      rmSync(escapeDir, { recursive: true, force: true });
    }
  });

  it("fileName '..' ve ayraçlı yol reddedilir (export/output-path-denied)", () => {
    const snapshot = positiveGraph();
    const outputDir = makeTempDir("decl3");
    const policy = OutputAccessPolicy.create([outputDir]);

    expect(() =>
      writeDocumentation({ snapshot, format: "json", outputDir, fileName: DOT_DOT }, policy),
    ).toThrowError(expect.objectContaining({ code: "export/output-path-denied" }));
    expect(() =>
      writeDocumentation(
        { snapshot, format: "json", outputDir, fileName: "sub/report.json" },
        policy,
      ),
    ).toThrowError(expect.objectContaining({ code: "export/output-path-denied" }));
    expect(() =>
      writeDocumentation(
        { snapshot, format: "json", outputDir, fileName: "back\\slash.json" },
        policy,
      ),
    ).toThrowError(expect.objectContaining({ code: "export/output-path-denied" }));
    expect(() =>
      writeDocumentation({ snapshot, format: "json", outputDir, fileName: "\0evil" }, policy),
    ).toThrowError(expect.objectContaining({ code: "export/output-path-denied" }));
    expect(readdirSync(outputDir)).toEqual([]);
  });

  it("OutputAccessPolicy.create boş liste ve var olmayan dizini reddeder (default deny)", () => {
    expect(() => OutputAccessPolicy.create([])).toThrowError(
      expect.objectContaining({ code: "workspace/output-policy-invalid" }),
    );
    const missing = path.join(makeTempDir("missing-root"), "yok");
    expect(() => OutputAccessPolicy.create([missing])).toThrowError(OutputPolicyError);
    expect(() => OutputAccessPolicy.create(["\0bad"])).toThrowError(
      expect.objectContaining({ code: "workspace/output-policy-invalid" }),
    );
  });
});

/* ------------------------------------------------------------------ */
/* Partial — boş graph                                                 */
/* ------------------------------------------------------------------ */

describe("boş graph (partial)", () => {
  it("dört format boş ama geçerli çıktı üretir", () => {
    const snapshot = emptyGraph();

    const json = serializeDocumentationJson(snapshot);
    const parsedJson = JSON.parse(json) as { nodes: unknown[]; edges: unknown[]; evidence: unknown[] };
    expect(parsedJson.nodes).toEqual([]);
    expect(parsedJson.edges).toEqual([]);
    expect(parsedJson.evidence).toEqual([]);
    expect(canonicalJson(parsedJson as never)).toBe(json);

    const markdown = serializeDocumentationMarkdown(snapshot);
    expect(markdown).toContain("## Nodes (0)");
    expect(markdown).toContain("## Edges (0)");
    expect(markdown).toContain("## Evidence (0)");

    expect(serializeDocumentationMermaid(snapshot)).toBe("flowchart TD\n");

    const html = serializeDocumentationHtml(snapshot);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("Nodes (0)");
    expect(html).toContain("Edges (0)");
    expect(html).toContain("Evidence (0)");
    expect(/<script/i.test(html)).toBe(false);
  });

  it("boş graph'ın HTML'i izinli dizine yazılabilir", () => {
    const outputDir = makeTempDir("empty");
    const policy = OutputAccessPolicy.create([outputDir]);
    const result = writeDocumentation(
      { snapshot: emptyGraph(), format: "html", outputDir },
      policy,
    );
    expect(existsSync(result.path)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Determinizm — dört format                                           */
/* ------------------------------------------------------------------ */

describe("determinizm (aynı girdi → aynı çıktı)", () => {
  it("dizi sırası karıştırılsa bile dört formatın çıktısı bit düzeyinde aynıdır", () => {
    for (const format of EXPORT_DOCUMENTATION_FORMATS) {
      const a = serializeDocumentation(positiveGraph(), format);
      expect(serializeDocumentation(positiveGraph(), format)).toBe(a);
      expect(serializeDocumentation(shuffledGraph(), format)).toBe(a);
    }
  });

  it("GraphRepositoryError tipiyle fırlatır (sabit kodlu sözleşme hatası)", () => {
    // Negatif akışlardan biri üzerinden hata tipini doğrula.
    const declared = makeTempDir("errtype");
    const other = makeTempDir("errtype-other");
    const policy = OutputAccessPolicy.create([declared]);
    try {
      writeDocumentation({ snapshot: positiveGraph(), format: "json", outputDir: other }, policy);
      expect.unreachable("export/output-not-authorized beklenmişti");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphRepositoryError);
      expect((error as GraphRepositoryError).code).toBe("export/output-not-authorized");
    }
  });
});
