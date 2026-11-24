import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  createSnapshot,
  type SnapshotGraph,
  type SnapshotNodeInput,
} from "@causoryn/domain";
import { OutputAccessPolicy } from "@causoryn/workspace";

import {
  ARCHITECTURE_INTERACTIVE_CSP,
  EXPORT_DOCUMENTATION_VIEWS,
  serializeArchitectureHtml,
  serializeArchitectureJson,
  serializeArchitectureMarkdown,
  serializeArchitectureMermaid,
  serializeInteractiveArchitectureHtml,
} from "../src/architecture-export.js";
import { computeArchitectureLayout } from "../src/architecture-layout.js";
import { projectArchitecture } from "../src/architecture-projection.js";
import {
  EXPORT_DEFAULT_FILE_NAMES,
  writeDocumentation,
} from "../src/export.js";
import { EXPORT_INTERACTIVE_HTML_FILE_NAME } from "../src/index.js";
import { GraphRepositoryError } from "../src/errors.js";

const WS = "ws_arch_export";
const CREATED_AT = "2026-11-22T20:30:00.000Z";

function node(
  kind: SnapshotNodeInput["kind"],
  qualifiedName: string,
  relativePath: string | undefined,
  language: string | undefined = "typescript",
  startLine = 1,
  endLine = 20,
): SnapshotNodeInput {
  return {
    kind,
    qualifiedName,
    ...(language === undefined ? {} : { language }),
    ...(relativePath === undefined
      ? {}
      : {
          location: {
            relativePath,
            startLine,
            endLine,
            sourceHash: `sha256:${relativePath}:${String(startLine)}`,
          },
        }),
    attributes: {},
  };
}

function ev(relativePath: string, rationale: string, analyzerId = "ts-adapter") {
  return {
    kind: "static-analysis",
    span: {
      relativePath,
      startLine: 1,
      endLine: 10,
      sourceHash: `sha256:${relativePath}:1`,
    },
    analyzerId,
    analyzerVersion: "0.2.2",
    rationale,
  };
}

function richFixture(): SnapshotGraph {
  const apiEp = node("Endpoint", "POST /orders", "src/api/orders-controller.ts", "typescript", 12, 30);
  const apiHandler = node("Handler", "OrdersController.create", "src/api/orders-controller.ts", "typescript", 14, 29);
  const svcCreate = node("Method", "OrdersService.create", "src/orders/orders-service.ts", "typescript", 8, 40);
  const repoSave = node("Method", "OrdersRepository.save", "src/persistence/orders-repo.ts", "typescript", 5, 22);
  const tblOrders = node("Table", "orders", "src/persistence/orders-repo.ts", "typescript", 1, 4);
  const xssFn = node(
    "Function",
    'evil::<script>alert("xss")</script> https://evil.test/p',
    "src/shared/util.ts",
    "typescript",
    1,
    10,
  );
  const extNode = node("UnknownExternal", "console.log", undefined, "typescript");

  return createSnapshot({
    workspaceId: WS,
    revision: { id: "rev-exp-1", sequence: 1 },
    configHash: "cfg-exp",
    analyzerFingerprint: "ts-adapter@0.2.2",
    state: "ready",
    createdAt: CREATED_AT,
    nodes: [apiEp, apiHandler, svcCreate, repoSave, tblOrders, xssFn, extNode],
    edges: [
      {
        kind: "ROUTES_TO",
        from: apiEp,
        to: apiHandler,
        resolution: "verified",
        evidence: [ev("src/api/orders-controller.ts", "Route binding")],
      },
      {
        kind: "CALLS",
        from: apiHandler,
        to: svcCreate,
        resolution: "verified",
        evidence: [ev("src/api/orders-controller.ts", "Calls OrdersService.create")],
      },
      {
        kind: "CALLS",
        from: svcCreate,
        to: repoSave,
        resolution: "verified",
        evidence: [ev("src/orders/orders-service.ts", "Persists order")],
      },
      // Cycle between orders and persistence
      {
        kind: "CALLS",
        from: repoSave,
        to: svcCreate,
        resolution: "heuristic",
      },
      {
        kind: "WRITES",
        from: repoSave,
        to: tblOrders,
        resolution: "verified",
        evidence: [ev("src/persistence/orders-repo.ts", "Writes orders table")],
      },
      {
        kind: "CALLS",
        from: svcCreate,
        to: xssFn,
        resolution: "verified",
        evidence: [ev("src/orders/orders-service.ts", "Uses util")],
      },
      {
        kind: "CALLS",
        from: svcCreate,
        to: extNode,
        resolution: "unresolved",
      },
    ],
  });
}

function emptyFixture(): SnapshotGraph {
  return createSnapshot({
    workspaceId: WS,
    revision: { id: "rev-empty", sequence: 0 },
    configHash: "cfg-empty",
    analyzerFingerprint: "ts-adapter@0.2.2",
    state: "ready",
    createdAt: CREATED_AT,
    nodes: [],
    edges: [],
  });
}

function sampleAnnotations(snap: SnapshotGraph) {
  const proj = projectArchitecture(snap);
  const apiMod = proj.modules.find((m) => m.path.includes("api"));
  const ordersMod = proj.modules.find((m) => m.path.includes("orders"));
  const persistMod = proj.modules.find((m) => m.path.includes("persistence"));
  const firstNode = snap.nodes.find((n) => n.kind === "Endpoint");
  const firstEv = snap.evidence[0];
  if (!apiMod || !ordersMod || !persistMod || !firstNode || !firstEv) {
    throw new Error("missing fixture modules");
  }
  return {
    title: 'Orders System </script><script>alert(1)</script> https://evil.test/x',
    architectureStyle: "Layered Modular Monolith",
    executiveSummary: "Processes orders via API -> Service -> Persistence. ![beacon](https://evil.test/b.png)",
    domains: [
      {
        id: "dom-edge",
        name: "API Edge",
        description: "HTTP entrypoints",
        layer: "presentation",
        moduleIds: [apiMod.id],
      },
      {
        id: "dom-core",
        name: "Order Core",
        description: "Domain and persistence",
        layer: "core",
        moduleIds: [ordersMod.id, persistMod.id],
      },
    ],
    moduleNotes: [
      {
        moduleId: ordersMod.id,
        summary: "Core order orchestration logic.",
        responsibility: "Order lifecycle management",
        layer: "application",
      },
    ],
    flows: [
      {
        id: "flow-create-order",
        title: "Create Order",
        description: "Full HTTP to DB flow.",
        steps: [
          { moduleId: apiMod.id, nodeId: firstNode.id, label: "POST /orders", explanation: "Validates payload." },
          { moduleId: ordersMod.id, label: "OrdersService.create", explanation: "Applies business rules." },
          { moduleId: persistMod.id, label: "OrdersRepository.save", explanation: "Persists row." },
        ],
      },
    ],
    guidedTour: [
      { step: 1, title: "API Entry", targetModuleId: apiMod.id, explanation: "Begin at controller." },
      { step: 2, title: "Domain Logic", targetModuleId: ordersMod.id, explanation: "Inspect order creation." },
    ],
    decisions: [
      {
        id: "adr-layered",
        title: "Separate API and Service",
        summary: "Keeps HTTP parsing outside domain logic.",
        relatedModuleIds: [apiMod.id, ordersMod.id],
        evidenceIds: [firstEv.id],
      },
    ],
    risks: [
      {
        id: "risk-cycle",
        title: "Orders <-> Persistence cycle",
        severity: "high" as const,
        summary: "Repository calls back into OrdersService.",
        relatedModuleIds: [ordersMod.id, persistMod.id],
        evidenceIds: [firstEv.id],
      },
    ],
  };
}

const tempRoots: string[] = [];
function makeTmp(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `causoryn-arch-exp-${label}-`));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const d = tempRoots.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

describe("computeArchitectureLayout — katmanlı deterministik yerleşim", () => {
  it("çakışmayan kart koordinatları, domain şeritleri ve döngü kenar geometrisi üretir", () => {
    const snap = richFixture();
    const proj = projectArchitecture(snap);
    const layout = computeArchitectureLayout(proj);

    expect(layout.width).toBeGreaterThan(300);
    expect(layout.height).toBeGreaterThan(200);
    expect(layout.nodes).toHaveLength(proj.modules.length);
    expect(layout.edges).toHaveLength(proj.edges.length);

    // Hiçbir iki modül kutusu çakışmaz
    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        const a = layout.nodes[i];
        const b = layout.nodes[j];
        if (!a || !b) continue;
        const overlapX = a.x < b.x + b.width && a.x + a.width > b.x;
        const overlapY = a.y < b.y + b.height && a.y + a.height > b.y;
        expect(overlapX && overlapY).toBe(false);
      }
    }

    // Döngü kenarı cycle olarak işaretlenir ve SVG path taşır
    const cycleEdge = layout.edges.find((e) => e.edge.isCycle);
    expect(cycleEdge).toBeDefined();
    expect(cycleEdge?.pathD.startsWith("M ")).toBe(true);
  });

  it("boş projeksiyon için geçerli minimal geometri döner", () => {
    const layout = computeArchitectureLayout(projectArchitecture(emptyFixture()));
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });
});

describe("serializeArchitectureMermaid — temiz render edilebilir mimari diyagram", () => {
  it("subgraph gruplu flowchart TB, sınıf tanımları ve XSS-güvenli etiketler üretir", () => {
    const snap = richFixture();
    const ann = sampleAnnotations(snap);
    const out = serializeArchitectureMermaid(snap, undefined, ann);

    expect(out.startsWith("flowchart TB\n")).toBe(true);
    expect(out).toContain("subgraph ");
    expect(out).toContain("API Edge");
    expect(out).toContain("Order Core");
    expect(out).toContain("classDef ");
    expect(out).not.toContain("UnknownExternal");
    expect(out).not.toContain("<script>");
    expect(out.split("\n").length).toBeLessThan(120);
  });
});

describe("serializeArchitectureHtml — sıfır-JS katı-CSP offline mimari portalı", () => {
  it("inline katmanlı SVG, CSS sekmeleri, Host-LLM anotasyonları ve sıfır <script>/http(s) garantisi verir", () => {
    const snap = richFixture();
    const ann = sampleAnnotations(snap);
    const html = serializeArchitectureHtml(snap, undefined, ann);

    expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("base-uri 'none'");
    expect(html).toContain("<svg ");
    expect(html).toContain("Layered Modular Monolith");
    expect(html).toContain("Core order orchestration logic.");
    expect(html).toContain("Create Order");
    expect(html).toContain("Separate API and Service");
    expect(html).toContain("OrdersService.create");

    // Güvenlik kırmızı çizgileri (f6-security-release.test.ts ile birebir uyumlu!)
    expect(/<script/i.test(html)).toBe(false);
    expect(/<link\b/i.test(html)).toBe(false);
    expect(/<img\b/i.test(html)).toBe(false);
    expect(/\ssrc\s*=/i.test(html)).toBe(false);
    expect(/https?:\/\//i.test(html)).toBe(false);

    // Tüm href'ler yalnızca belge içi fragment çapa (#...)
    const hrefMatches = [...html.matchAll(/\shref\s*=\s*"([^"]*)"/gi)];
    for (const m of hrefMatches) {
      expect((m[1] ?? "").startsWith("#")).toBe(true);
    }
  });
});

describe("serializeInteractiveArchitectureHtml — etkileşimli offline E6+ portal", () => {
  it("deterministik SHA-256 script-src CSP (sıfır script-src 'unsafe-inline'), kaçışlı JSON veri adası, sıfır innerHTML/fetch ve etkileşim kontrolleri taşır", () => {
    const snap = richFixture();
    const ann = sampleAnnotations(snap);
    const html = serializeInteractiveArchitectureHtml(snap, undefined, ann);

    // Task 1.3b: ZERO script-src 'unsafe-inline'; deterministic sha256 hash matches exact <script> body
    expect(ARCHITECTURE_INTERACTIVE_CSP).not.toContain("script-src 'unsafe-inline'");
    expect(ARCHITECTURE_INTERACTIVE_CSP).toMatch(
      /^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/]{43}='; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'$/,
    );

    const cspMetaMatch = html.match(
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/,
    );
    expect(cspMetaMatch).not.toBeNull();
    const renderedCsp = cspMetaMatch?.[1] ?? "";
    expect(renderedCsp).toBe(ARCHITECTURE_INTERACTIVE_CSP);
    expect(renderedCsp).not.toContain("script-src 'unsafe-inline'");

    const cspHashMatch = renderedCsp.match(/script-src '(sha256-[A-Za-z0-9+/]{43}=)'/);
    expect(cspHashMatch).not.toBeNull();
    const cspHash = cspHashMatch?.[1] ?? "";

    // Strictly 2 <script> blocks: 1 non-executable JSON island + 1 executable script matching SHA-256 hash
    const allScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    expect(allScripts).toHaveLength(2);
    const jsonScripts = allScripts.filter((m) => (m[1] ?? "").includes('type="application/json"'));
    const execScripts = allScripts.filter((m) => !(m[1] ?? "").includes('type="application/json"'));
    expect(jsonScripts).toHaveLength(1);
    expect(execScripts).toHaveLength(1);

    const execBody = execScripts[0]?.[2] ?? "";
    const computedHash = `sha256-${createHash("sha256").update(execBody, "utf8").digest("base64")}`;
    expect(computedHash).toBe(cspHash);

    // Single-file offline compatibility: zero inline event handlers or external resources in HTML markup
    // Strip script blocks until nothing changes, so a nested or case-variant
    // "<script" left behind by one pass is removed too.
    let htmlWithoutScripts = html;
    for (let previous = ""; previous !== htmlWithoutScripts; ) {
      previous = htmlWithoutScripts;
      htmlWithoutScripts = htmlWithoutScripts.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
    }
    expect(/<script\b/i.test(htmlWithoutScripts)).toBe(false);
    expect(/\son[a-z]+\s*=/i.test(htmlWithoutScripts)).toBe(false);
    expect(/<link\b/i.test(htmlWithoutScripts)).toBe(false);
    expect(/<img\b/i.test(htmlWithoutScripts)).toBe(false);
    expect(/\ssrc\s*=/i.test(htmlWithoutScripts)).toBe(false);

    expect(html).toContain('id="causoryn-portal-data"');
    expect(html).toContain("causoryn-search");
    expect(html).toContain("causoryn-inspector");
    expect(html).toContain("<svg ");

    // </script> breakout imkânsız
    const dataBlockMatch = html.match(/<script type="application\/json" id="causoryn-portal-data">([\s\S]*?)<\/script>/);
    expect(dataBlockMatch).not.toBeNull();
    const rawIsland = dataBlockMatch?.[1] ?? "";
    expect(rawIsland.includes("<script")).toBe(false);
    expect(rawIsland.includes("</script")).toBe(false);
    const parsedIsland = JSON.parse(rawIsland) as { annotations?: { title?: string }; evidence?: Record<string, unknown> };
    expect(parsedIsland.annotations?.title).toContain("Orders System");
    expect(Object.keys(parsedIsland.evidence ?? {}).length).toBeGreaterThan(0);

    // Zero unsafe DOM/network APIs inside embedded script
    expect(html).not.toContain("innerHTML");
    expect(html).not.toContain("outerHTML");
    expect(html).not.toContain("document.write");
    expect(html).not.toContain("eval(");
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("XMLHttpRequest");
  });
});

describe("serializeArchitectureMarkdown ve serializeArchitectureJson", () => {
  it("Markdown brief gömülü Mermaid, anahtar semboller ve GFM beacon kaçışı içerir", () => {
    const snap = richFixture();
    const ann = sampleAnnotations(snap);
    const md = serializeArchitectureMarkdown(snap, undefined, ann);

    expect(md.startsWith("# Causoryn Architecture Documentation\n")).toBe(true);
    expect(md).toContain("```mermaid\nflowchart TB\n");
    expect(md).toContain("OrdersService.create");
    expect(md).toContain("Layered Modular Monolith");
    expect(md).not.toContain("![beacon](https://evil.test/b.png)");
    expect(md).not.toContain("<script>");
  });

  it("Audit H1, M1, M2, M4, L2: backslash-escape bypass, word-prefixed URL, prototype language/evidence, backtick Mermaid ve acyclic test gutter korunur", () => {
    const srcFn = node("Function", "fetch_https://evil.test/leak `backtick`", "src/core/app.ts", "toString", 1, 10);
    const testFn = node("Test", "testApp", "src/tests/app.test.ts", "typescript", 1, 10);
    const snap = createSnapshot({
      workspaceId: WS,
      revision: { id: "rev-sec-audit", sequence: 1 },
      configHash: "cfg-sec",
      analyzerFingerprint: "ts-adapter@0.2.2",
      state: "ready",
      createdAt: CREATED_AT,
      nodes: [srcFn, testFn],
      edges: [
        {
          kind: "TESTS",
          from: testFn,
          to: srcFn,
          resolution: "verified",
          evidence: [ev("src/tests/app.test.ts", "Tests core")],
        },
      ],
    });
    const proj = projectArchitecture(snap);
    const mod = proj.modules[0];
    if (!mod) throw new Error("missing mod");

    // Audit H1: backslash-prefixed HTML/image injection in annotation prose
    const ann = {
      title: "Title\\<img src=https://evil.test/x x=\\>\nInjectedLine",
      executiveSummary: "Test \\<img src=https://evil.test/b.png x=\\> and [click](javascript:alert(1))",
      guidedTour: [{ step: 1, title: "Stop 1", targetModuleId: mod.id, explanation: "Walk." }],
    };

    const md = serializeArchitectureMarkdown(snap, undefined, ann);
    expect(md).not.toMatch(/(?<!\\)(?:\\\\)*<img/);
    expect(md).toContain("\\\\\\<img");
    expect(md).not.toContain("[click](javascript:alert(1))");

    // Audit M1 & M2: zero-JS HTML defangs word-prefixed https:// AND ignores Object.prototype on language="toString"
    const html = serializeArchitectureHtml(snap, undefined, ann);
    expect(/https?:\/\//i.test(html)).toBe(false);
    expect(html).not.toContain("function toString()");

    // Audit M4: interactive HTML uses data-jump-module (no dead #mod-card-* anchors)
    const interHtml = serializeInteractiveArchitectureHtml(snap, undefined, ann);
    expect(interHtml).toContain("data-jump-module=");
    expect(interHtml).not.toContain('href="#mod-card-');

    // Audit L2: backticks escaped in Mermaid
    const mmd = serializeArchitectureMermaid(snap, undefined, ann);
    expect(mmd).not.toContain("`backtick`");

    // Audit M4: acyclic test-to-source upward edge gets right gutter so x stays inside viewBox
    const layout = computeArchitectureLayout(proj);
    for (const pe of layout.edges) {
      expect(pe.labelX).toBeLessThan(layout.width);
    }
  });

  it("JSON blueprint kanonik JSON'dur ve meta.id snapshot kimliğini korur", () => {
    const snap = richFixture();
    const ann = sampleAnnotations(snap);
    const jsonText = serializeArchitectureJson(snap, undefined, ann);
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    expect(canonicalJson(parsed as never)).toBe(jsonText);
    expect((parsed.meta as Record<string, unknown>).id).toBe(snap.meta.id);
    expect(parsed.view).toBe("architecture");
    expect(Array.isArray(parsed.modules)).toBe(true);
  });

  it("tüm formatlar karıştırılmış girdilerde bit-bit deterministiktir", () => {
    const snap = richFixture();
    const shuffled: SnapshotGraph = {
      ...snap,
      nodes: [...snap.nodes].reverse(),
      edges: [...snap.edges].reverse(),
      evidence: [...snap.evidence].reverse(),
    };
    const ann = sampleAnnotations(snap);
    expect(serializeArchitectureMermaid(shuffled, undefined, ann)).toBe(
      serializeArchitectureMermaid(snap, undefined, ann),
    );
    expect(serializeArchitectureHtml(shuffled, undefined, ann)).toBe(
      serializeArchitectureHtml(snap, undefined, ann),
    );
    expect(serializeInteractiveArchitectureHtml(shuffled, undefined, ann)).toBe(
      serializeInteractiveArchitectureHtml(snap, undefined, ann),
    );
    expect(serializeArchitectureMarkdown(shuffled, undefined, ann)).toBe(
      serializeArchitectureMarkdown(snap, undefined, ann),
    );
    expect(serializeArchitectureJson(shuffled, undefined, ann)).toBe(
      serializeArchitectureJson(snap, undefined, ann),
    );
  });
});

describe("writeDocumentation — view & annotations entegrasyonu", () => {
  it("architecture, interactive ve full görünümlerini atomik yazar; uyumsuz kombinasyonları fail-closed reddeder", () => {
    expect([...EXPORT_DOCUMENTATION_VIEWS]).toEqual(["architecture", "interactive", "full"]);
    const snap = richFixture();
    const outDir = makeTmp("views");
    const policy = OutputAccessPolicy.create([outDir]);
    const ann = sampleAnnotations(snap);

    const archHtml = writeDocumentation(
      { snapshot: snap, format: "html", outputDir: outDir, view: "architecture", annotations: ann },
      policy,
    );
    expect(archHtml.view).toBe("architecture");
    expect(archHtml.architectureSummary?.annotated).toBe(true);
    expect(archHtml.architectureSummary?.moduleIds.length).toBeGreaterThan(0);
    expect(readFileSync(archHtml.path, "utf8")).toContain("<svg ");

    const interHtml = writeDocumentation(
      {
        snapshot: snap,
        format: "html",
        outputDir: outDir,
        fileName: "portal.html",
        view: "interactive",
        annotations: ann,
      },
      policy,
    );
    expect(interHtml.view).toBe("interactive");
    expect(readFileSync(interHtml.path, "utf8")).toContain("causoryn-portal-data");

    // interactive yalnızca html formatında geçerli
    expect(() =>
      writeDocumentation(
        { snapshot: snap, format: "mermaid", outputDir: outDir, view: "interactive" },
        policy,
      ),
    ).toThrowError(expect.objectContaining({ code: "export/invalid-view" }));

    // full görünümde annotations yasak
    expect(() =>
      writeDocumentation(
        { snapshot: snap, format: "html", outputDir: outDir, view: "full", annotations: ann },
        policy,
      ),
    ).toThrowError(expect.objectContaining({ code: "export/invalid-options" }));

    // Bilinmeyen view reddedilir
    expect(() =>
      writeDocumentation(
        {
          snapshot: snap,
          format: "html",
          outputDir: outDir,
          view: "unknown" as (typeof EXPORT_DOCUMENTATION_VIEWS)[number],
        },
        policy,
      ),
    ).toThrowError(GraphRepositoryError);
  });

  it("varsayılan dosya adları: architecture → causoryn-architecture.html, interactive → causoryn-architecture-interactive.html (çakışmadan birlikte yaşar) ve açık fileName her zaman önceliklidir", () => {
    expect(EXPORT_DEFAULT_FILE_NAMES.html).toBe("causoryn-architecture.html");
    expect(EXPORT_INTERACTIVE_HTML_FILE_NAME).toBe("causoryn-architecture-interactive.html");

    const snap = richFixture();
    const outDir = makeTmp("default-names");
    const policy = OutputAccessPolicy.create([outDir]);

    // 1. Default architecture HTML (no fileName) -> causoryn-architecture.html (zero-JS SVG portal)
    const archHtml = writeDocumentation(
      { snapshot: snap, format: "html", outputDir: outDir, view: "architecture" },
      policy,
    );
    expect(path.basename(archHtml.path)).toBe("causoryn-architecture.html");
    expect(archHtml.view).toBe("architecture");

    // 2. Interactive HTML (no fileName) -> causoryn-architecture-interactive.html without overwriting architecture HTML
    const interHtml = writeDocumentation(
      { snapshot: snap, format: "html", outputDir: outDir, view: "interactive" },
      policy,
    );
    expect(path.basename(interHtml.path)).toBe("causoryn-architecture-interactive.html");
    expect(interHtml.view).toBe("interactive");
    expect(interHtml.path).not.toBe(archHtml.path);

    // Both files coexist with distinct contents
    const archContent = readFileSync(archHtml.path, "utf8");
    const interContent = readFileSync(interHtml.path, "utf8");
    expect(archContent).toContain("<svg ");
    expect(/<script/i.test(archContent)).toBe(false);
    expect(interContent).toContain("causoryn-portal-data");
    expect(interContent).toContain("<svg ");
    expect(archContent).not.toBe(interContent);

    // 3. Explicit fileName always takes precedence for interactive view
    const customInterHtml = writeDocumentation(
      {
        snapshot: snap,
        format: "html",
        outputDir: outDir,
        view: "interactive",
        fileName: "custom-portal.html",
      },
      policy,
    );
    expect(path.basename(customInterHtml.path)).toBe("custom-portal.html");
    expect(readFileSync(customInterHtml.path, "utf8")).toContain("causoryn-portal-data");

    expect(readdirSync(outDir).sort()).toEqual([
      "causoryn-architecture-interactive.html",
      "causoryn-architecture.html",
      "custom-portal.html",
    ]);

    // 4. Non-interactive views (full / undefined) keep EXPORT_DEFAULT_FILE_NAMES.html
    const fullDir = makeTmp("default-full");
    const fullPolicy = OutputAccessPolicy.create([fullDir]);
    const fullHtml = writeDocumentation(
      { snapshot: snap, format: "html", outputDir: fullDir, view: "full" },
      fullPolicy,
    );
    expect(path.basename(fullHtml.path)).toBe("causoryn-architecture.html");
  });

  it("SEC-12: atomik geçici dosya yazımı exclusive flag='wx' kullanır ve mevcut hedef dosyayı artık .tmp bırakmadan temizce üzerine yazar", () => {
    const snap = richFixture();
    const outDir = makeTmp("atomic-wx");
    const policy = OutputAccessPolicy.create([outDir]);
    const ann = sampleAnnotations(snap);

    // 1. İlk interactive export hedef dosyayı oluşturur
    const first = writeDocumentation(
      { snapshot: snap, format: "html", outputDir: outDir, view: "interactive" },
      policy,
    );
    expect(first.atomic).toBe(true);
    expect(path.basename(first.path)).toBe(EXPORT_INTERACTIVE_HTML_FILE_NAME);
    expect(readFileSync(first.path, "utf8")).not.toContain("Layered Modular Monolith");

    // 2. Artık .tmp dosyası varken ikinci yazma mevcut hedefi atomik ve temizce üzerine yazar
    writeFileSync(`${first.path}.tmp`, "STALE-TMP-RESIDUE", "utf8");
    const second = writeDocumentation(
      {
        snapshot: snap,
        format: "html",
        outputDir: outDir,
        view: "interactive",
        annotations: ann,
      },
      policy,
    );
    expect(second.atomic).toBe(true);
    expect(second.path).toBe(first.path);
    const updatedContent = readFileSync(second.path, "utf8");
    expect(updatedContent).toContain("causoryn-portal-data");
    expect(updatedContent).toContain("Layered Modular Monolith");
    expect(updatedContent).not.toContain("STALE-TMP-RESIDUE");
    expect(readdirSync(outDir)).toEqual([EXPORT_INTERACTIVE_HTML_FILE_NAME]);

    // 3. SEC-12 TOCTOU koruması: export.ts geçici dosyayı { encoding: "utf8", flag: "wx" } ile açar
    const exportSourcePath = fileURLToPath(new URL("../src/export.ts", import.meta.url));
    const exportSource = readFileSync(exportSourcePath, "utf8");
    expect(exportSource).toMatch(
      /writeFileSync\(\s*tmpPath\s*,\s*content\s*,\s*\{\s*encoding:\s*"utf8"\s*,\s*flag:\s*"wx"\s*\}\s*\)/,
    );
  });
});
