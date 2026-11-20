import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { GraphRepositoryError } from "../src/errors.js";
import {
  assertValidGitRef,
  buildGitEnv,
  readGitBlob,
  readGitTree,
  runGit,
} from "../src/git-read.js";
import {
  API_SURFACE_NODE_KINDS,
  diffContentSets,
  type ArchitectureDiff,
  type CompareContentSet,
  type CompareEdge,
  type CompareNode,
  type CompareNodeIdentity,
} from "../src/compare.js";
import { serializeSnapshotContentSet } from "../src/timeline.js";
import { createSnapshot, type SnapshotGraph } from "@causoryn/domain";

/**
 * causoryn_compare_architecture çekirdek testleri (sprint-3 C3, TŞ v2.1 §13).
 *
 * Pozitif: iki içerik kümesi arasından node ekleme, yeniden adlandırma
 * (confidence'lı rename), imza değişimi ve API yüzeyi değişimlerinin
 * çıkarılması; geçici git deposunda cat-file/ls-tree ile uçtan uca koşum.
 * Negatif: geçersiz ref formatı (`--` ile başlayan dahil), var olmayan ref,
 * beyaz liste dışı git komutları (checkout/reset/clean dahil — yürütme
 * ÖNCESİ reddedilir), blob yolu traversal denemeleri ve içerik kümesi
 * sözleşme ihlalleri. Partial: zayıf rename adayının "uncertain"
 * sınıflanması (iddia üretilmez).
 *
 * TŞ §13 kısıtları: shell interpolation yok, checkout/reset/clean yok;
 * rename heuristic qualifiedName + imza parmak izi + yol benzerliğiyle
 * yapılır, confidence belgelidir. Test geçici deposunu KENDİ kurar
 * (init + iki commit); ürün katmanı yalnızca salt-okunur git okuması yapar.
 */

const execFile = promisify(execFileCallback);

/** Sync çağrının GraphRepositoryError ve beklenen kodla fırlatılmasını zorlar. */
function expectThrowsCode(action: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`Beklenen hata fırlatılmadı (kod=${code})`);
  }
  expect(thrown).toBeInstanceOf(GraphRepositoryError);
  expect((thrown as GraphRepositoryError).code).toBe(code);
}

/** Promise reddinin GraphRepositoryError ve beklenen kodla olduğunu zorlar. */
async function expectRejectsCode(
  action: () => Promise<unknown>,
  code: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`Beklenen hata fırlatılmadı (kod=${code})`);
  }
  expect(thrown).toBeInstanceOf(GraphRepositoryError);
  expect((thrown as GraphRepositoryError).code).toBe(code);
}

function identityOf(node: CompareNodeIdentity): CompareNodeIdentity {
  return {
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    ...(node.relativePath === undefined ? {} : { relativePath: node.relativePath }),
  };
}

function fnNode(
  qualifiedName: string,
  relativePath: string,
  signature: string,
): CompareNode {
  return {
    kind: "Function",
    qualifiedName,
    language: "typescript",
    relativePath,
    signature,
    attributes: {},
  };
}

/** Test ayıklayıcısı: `function <ad>(<args>)` desenini deterministik çıkarır. */
function extractFunctionNodes(
  content: string,
  relativePath: string,
): CompareNode[] {
  const nodes: CompareNode[] = [];
  const pattern = /\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g;
  for (const match of content.matchAll(pattern)) {
    const name = match[1];
    const args = match[2];
    if (name === undefined || args === undefined) {
      continue;
    }
    nodes.push({
      kind: "Function",
      qualifiedName: name,
      language: "typescript",
      relativePath,
      signature: `${name}(${args})`,
      attributes: {},
    });
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Saf çekirdek: diffContentSets
// ---------------------------------------------------------------------------

describe("compare çekirdeği — diffContentSets (saf)", () => {
  it("pozitif: ekleme + confidence'lı rename + imza değişimi + API yüzeyi + edge remap", () => {
    const base: CompareContentSet = {
      nodes: [
        fnNode("UserService", "src/user/service.ts", "create(name: string): User"),
        {
          kind: "File",
          qualifiedName: "src/user/service.ts",
          relativePath: "src/user/service.ts",
          attributes: {},
        },
        {
          kind: "Endpoint",
          qualifiedName: "GET /users",
          relativePath: "src/user/routes.ts",
          signature: "GET /users",
          attributes: {},
        },
        {
          kind: "ApiContract",
          qualifiedName: "users-api",
          relativePath: "docs/users-api.json",
          attributes: { version: "1.0" },
        },
      ],
      edges: [
        {
          kind: "DECLARES",
          from: {
            kind: "File",
            qualifiedName: "src/user/service.ts",
            relativePath: "src/user/service.ts",
          },
          to: {
            kind: "Function",
            qualifiedName: "UserService",
            relativePath: "src/user/service.ts",
          },
          resolution: "heuristic",
        },
      ],
    };

    const target: CompareContentSet = {
      nodes: [
        fnNode("UserAccountService", "src/user/service.ts", "create(name: string): User"),
        {
          kind: "File",
          qualifiedName: "src/user/service.ts",
          relativePath: "src/user/service.ts",
          attributes: {},
        },
        {
          kind: "Endpoint",
          qualifiedName: "GET /users",
          relativePath: "src/user/routes.ts",
          signature: "GET /users?limit=int",
          attributes: {},
        },
        {
          kind: "ApiContract",
          qualifiedName: "users-api",
          relativePath: "docs/users-api.json",
          attributes: { version: "1.0" },
        },
        fnNode("AuditService", "src/audit/service.ts", "record(event: string): void"),
      ],
      edges: [
        {
          kind: "DECLARES",
          from: {
            kind: "File",
            qualifiedName: "src/user/service.ts",
            relativePath: "src/user/service.ts",
          },
          to: {
            kind: "Function",
            qualifiedName: "UserAccountService",
            relativePath: "src/user/service.ts",
          },
          resolution: "heuristic",
        },
      ],
    };

    const diff = diffContentSets(base, target);

    // Rename: aynı imza + aynı yol + benzer taban ad → yüksek güven.
    expect(diff.renamed).toHaveLength(1);
    const rename = diff.renamed[0];
    if (rename === undefined) {
      throw new Error("rename eksik");
    }
    expect(rename.from.qualifiedName).toBe("UserService");
    expect(rename.to.qualifiedName).toBe("UserAccountService");
    expect(rename.from.kind).toBe("Function");
    expect(rename.confidence).toBe("high");
    expect(rename.score).toBeGreaterThanOrEqual(0.75);
    expect(rename.reason.length).toBeGreaterThan(0);

    // Ekleme: yalnız AuditService; UserService rename'a emildi → removed boş.
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.node.qualifiedName).toBe("AuditService");
    expect(diff.removed).toHaveLength(0);

    // İmza değişimi: endpoint aynı kimlik, farklı imza → changed/signature.
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.node.qualifiedName).toBe("GET /users");
    expect(diff.changed[0]?.changeType).toContain("signature");

    // API yüzeyi: Endpoint + contract türleri; AuditService (Function) yüzeyde değil.
    expect(diff.apiSurface.changed).toHaveLength(1);
    expect(diff.apiSurface.added).toHaveLength(0);
    expect(diff.apiSurface.removed).toHaveLength(0);
    expect(diff.apiSurface.renamed).toHaveLength(0);
    expect(diff.summary.apiSurfaceChanges).toBe(1);
    expect(API_SURFACE_NODE_KINDS).toContain("Endpoint");
    expect(API_SURFACE_NODE_KINDS).toContain("ApiContract");

    // Edge remap: DECLARES kenarı rename uçlarıyla yeniden eşlenir → değişmez.
    expect(diff.edges.added).toHaveLength(0);
    expect(diff.edges.removed).toHaveLength(0);
    expect(diff.edges.changed).toHaveLength(0);
    expect(diff.edges.unchangedCount).toBe(1);

    // Değişmeyenler: File + ApiContract.
    expect(diff.unchangedNodeCount).toBe(2);
    expect(diff.uncertain).toHaveLength(0);
  });

  it("negatif: tür kataloğu/JSON/duplicate/dangling/boş ad ihlalleri açık ret", () => {
    const valid: CompareContentSet = {
      nodes: [fnNode("A", "a.ts", "a()")],
      edges: [],
    };

    expectThrowsCode(
      () =>
        diffContentSets(
          valid,
          { nodes: [{ ...(fnNode("B", "b.ts", "b()")), kind: "Widget" as never }], edges: [] },
        ),
      "compare/unknown-node-kind",
    );
    expectThrowsCode(
      () =>
        diffContentSets(
          {
            nodes: [fnNode("A", "a.ts", "a()")],
            edges: [
              {
                kind: "WALKS" as never,
                from: identityOf(fnNode("A", "a.ts", "a()")),
                to: identityOf(fnNode("A", "a.ts", "a()")),
                resolution: "heuristic",
              },
            ],
          },
          valid,
        ),
      "compare/unknown-edge-kind",
    );
    expectThrowsCode(
      () =>
        diffContentSets(
          {
            nodes: [fnNode("A", "a.ts", "a()")],
            edges: [
              {
                kind: "CALLS",
                from: identityOf(fnNode("A", "a.ts", "a()")),
                to: identityOf(fnNode("A", "a.ts", "a()")),
                resolution: "guessed" as never,
              },
            ],
          },
          valid,
        ),
      "compare/unknown-resolution",
    );
    expectThrowsCode(
      () =>
        diffContentSets(
          valid,
          {
            nodes: [
              {
                kind: "Function",
                qualifiedName: "Bad",
                relativePath: "bad.ts",
                attributes: { callback: () => 1 },
              },
            ],
            edges: [],
          },
        ),
      "compare/non-json-attribute",
    );
    expectThrowsCode(
      () =>
        diffContentSets(
          { nodes: [fnNode("A", "a.ts", "a()"), fnNode("A", "a.ts", "a()")], edges: [] },
          valid,
        ),
      "compare/duplicate-node",
    );
    expectThrowsCode(
      () =>
        diffContentSets(
          {
            nodes: [fnNode("A", "a.ts", "a()")],
            edges: [
              {
                kind: "CALLS",
                from: identityOf(fnNode("A", "a.ts", "a()")),
                to: { kind: "Function", qualifiedName: "Missing", relativePath: "x.ts" },
                resolution: "heuristic",
              },
            ],
          },
          valid,
        ),
      "compare/dangling-edge",
    );
    expectThrowsCode(
      () => diffContentSets(valid, { nodes: [{ kind: "Function", qualifiedName: "   " }], edges: [] }),
      "compare/empty-qualified-name",
    );
  });

  it("negatif: aynı (tür,uçlar) kimlikte tekrar kenar reddedilir — girdi sırası determinizmi korunur", () => {
    // Denetim bulgusu 1: aynı kenar kimliğini paylaşan, resolution'ı farklı
    // iki base kenarı kova FIFO'sunda girdi sırasına bağlı tüketiliyordu;
    // domain'deki duplicate-edge invariant'ı gibi reddedilerek boşluk kapanır.
    const nodeA = fnNode("A", "a.ts", "a()");
    const nodeB = fnNode("B", "b.ts", "b()");
    const makeEdge = (resolution: "heuristic" | "unresolved") => ({
      kind: "CALLS" as const,
      from: identityOf(nodeA),
      to: identityOf(nodeB),
      resolution,
    });
    expectThrowsCode(
      () =>
        diffContentSets(
          { nodes: [nodeA, nodeB], edges: [makeEdge("heuristic"), makeEdge("unresolved")] },
          { nodes: [nodeB], edges: [] },
        ),
      "compare/duplicate-edge",
    );
    expectThrowsCode(
      () =>
        diffContentSets(
          { nodes: [nodeA, nodeB], edges: [makeEdge("heuristic"), makeEdge("heuristic")] },
          { nodes: [nodeB], edges: [] },
        ),
      "compare/duplicate-edge",
    );
  });

  it("partial: zayıf rename adayı 'uncertain' sınıflanır; zayıf olmayan aday bağımsız eklenir/çıkarılır", () => {
    const base: CompareContentSet = {
      nodes: [
        fnNode("OrderHelper", "src/orders/helper.ts", "processOrder()"),
        fnNode("Alpha", "a/alpha.ts", "a()"),
      ],
      edges: [],
    };
    const target: CompareContentSet = {
      nodes: [
        fnNode("RefundHelper", "src/refunds/helper.ts", "runRefund()"),
        fnNode("Beta", "b/beta.ts", "b()"),
      ],
      edges: [],
    };

    const diff = diffContentSets(base, target);

    // Zayıf aday (tür eşit, taban ad/imza/yol sinyali güçsüz) → uncertain;
    // ne rename iddiası ne de sessiz added+removed çiftesi.
    expect(diff.uncertain).toHaveLength(1);
    const uncertain = diff.uncertain[0];
    if (uncertain === undefined) {
      throw new Error("uncertain girişi eksik");
    }
    expect(uncertain.from.qualifiedName).toBe("OrderHelper");
    expect(uncertain.to.qualifiedName).toBe("RefundHelper");
    expect(uncertain.score).toBeGreaterThanOrEqual(0.15);
    expect(uncertain.score).toBeLessThan(0.3);
    expect(diff.renamed).toHaveLength(0);

    // Sıfır benzerlik çifti → bağımsız added/removed (uncertain'a sızmaz).
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.node.qualifiedName).toBe("Beta");
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]?.node.qualifiedName).toBe("Alpha");
  });

  it("determinizm: girdi sırasından bağımsız, iki koşum aynı JSON", () => {
    const base: CompareContentSet = {
      nodes: [fnNode("S1", "s1.ts", "one()"), fnNode("S2", "s2.ts", "two()")],
      edges: [
        {
          kind: "CALLS",
          from: identityOf(fnNode("S1", "s1.ts", "one()")),
          to: identityOf(fnNode("S2", "s2.ts", "two()")),
          resolution: "heuristic",
        },
      ],
    };
    const target: CompareContentSet = {
      nodes: [fnNode("S2", "s2.ts", "two()"), fnNode("S9", "s9.ts", "nine()")],
      edges: [
        {
          kind: "CALLS",
          from: identityOf(fnNode("S2", "s2.ts", "two()")),
          to: identityOf(fnNode("S9", "s9.ts", "nine()")),
          resolution: "heuristic",
        },
      ],
    };

    const first = diffContentSets(base, target);
    const second = diffContentSets(base, target);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    // Girdi sırası karıştırıldığında sonuç birebir aynı kalmalı.
    const shuffledBase: CompareContentSet = {
      nodes: [...base.nodes].reverse(),
      edges: [...base.edges].reverse(),
    };
    const shuffledTarget: CompareContentSet = {
      nodes: [...target.nodes].reverse(),
      edges: [...target.edges].reverse(),
    };
    const shuffled = diffContentSets(shuffledBase, shuffledTarget);
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(first));
  });
});

// ---------------------------------------------------------------------------
// Git okuma katmanı: geçici depo (yalnızca cat-file/ls-tree okuması)
// ---------------------------------------------------------------------------

const ORDER_FILE_V1 = [
  "export function createOrder(userId: string, amount: number): Order {",
  "  return { userId, amount };",
  "}",
  "",
  "export function cancelOrder(orderId: string): void {",
  "}",
  "",
].join("\n");

const ORDER_FILE_V2 = [
  "export function createPurchaseOrder(userId: string, amount: number): Order {",
  "  return { userId, amount };",
  "}",
  "",
  "export function cancelOrder(orderId: string): void {",
  "}",
  "",
  "export function auditLog(event: string): void {",
  "}",
  "",
].join("\n");

/** Commit sonrası bilinçli olarak commit'lenmeyen çalışma ağacı sürümü. */
const ORDER_FILE_WORKTREE = `${ORDER_FILE_V2}export function worktreeOnly(): void {\n}\n`;

describe("git okuma katmanı — geçici depo (salt-okunur cat-file/ls-tree)", () => {
  let repoRoot: string;
  let commit1Sha: string;
  let commit2Sha: string;
  let escapeDir: string | undefined;
  let symlinkCreated = false;

  beforeAll(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "causoryn-compare-"));
    const git = async (args: string[]): Promise<string> => {
      const result = await execFile("git", ["-C", repoRoot, ...args], {
        shell: false,
        windowsHide: true,
      });
      return result.stdout;
    };
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Causoryn Compare Test"]);
    await git(["config", "user.email", "compare-test@causoryn.invalid"]);
    await git(["config", "core.autocrlf", "false"]);

    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "orders.ts"), ORDER_FILE_V1, "utf8");
    await git(["add", "-A"]);
    await git(["commit", "-m", "commit-1"]);
    commit1Sha = (await git(["rev-parse", "HEAD"])).trim();

    await writeFile(path.join(repoRoot, "src", "orders.ts"), ORDER_FILE_V2, "utf8");
    await git(["add", "-A"]);
    await git(["commit", "-m", "commit-2"]);
    commit2Sha = (await git(["rev-parse", "HEAD"])).trim();

    // Çalışma ağacını kirlet: ürünün commit'lenmiş blob'lardan okuduğunu
    // kanıtlamak için bu sürüm asla commit'lenmez.
    await writeFile(path.join(repoRoot, "src", "orders.ts"), ORDER_FILE_WORKTREE, "utf8");

    // Denetim bulgusu 2 için sembolik bağlar: biri depo DIŞINA kaçan, biri
    // depo içindeki bir dosyayı gösteren bağlar. Windows'ta symlink oluşturma
    // ayrıcalık gerektirebilir; başarısız olursa ilgili test ctx.skip ile
    // açıkça raporlanır (sessiz geçiş yok).
    escapeDir = await mkdtemp(path.join(tmpdir(), "causoryn-escape-"));
    await writeFile(path.join(escapeDir, "secret.txt"), "SECRET-OUTSIDE-REPO\n", "utf8");
    try {
      await symlink(
        path.join(escapeDir, "secret.txt"),
        path.join(repoRoot, "src", "link-outside.ts"),
      );
      await symlink("orders.ts", path.join(repoRoot, "src", "link-inside.ts"));
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
  }, 30_000);

  afterAll(async () => {
    if (repoRoot !== undefined) {
      await rm(repoRoot, { recursive: true, force: true });
    }
    if (escapeDir !== undefined) {
      await rm(escapeDir, { recursive: true, force: true });
    }
  });

  /** Bir ref'in içerik kümesini ÜRÜN katmanı (readGitTree/readGitBlob) ile toplar. */
  async function collectContentSet(ref: string): Promise<CompareContentSet> {
    const entries = await readGitTree(repoRoot, ref);
    const sourceFiles = entries
      .filter((entry) => entry.type === "blob" && entry.path.endsWith(".ts"))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const nodes: CompareNode[] = [];
    const edges: CompareEdge[] = [];
    for (const file of sourceFiles) {
      const content = await readGitBlob(repoRoot, ref, file.path);
      const fileNode: CompareNode = {
        kind: "File",
        qualifiedName: file.path,
        relativePath: file.path,
        attributes: {},
      };
      nodes.push(fileNode);
      for (const fn of extractFunctionNodes(content, file.path)) {
        nodes.push(fn);
        edges.push({
          kind: "DECLARES",
          from: identityOf(fileNode),
          to: identityOf(fn),
          resolution: "heuristic",
        });
      }
    }
    return { nodes, edges };
  }

  it("pozitif: iki commit arası E2E diff — rename confidence + ekleme; çalışma ağacı okunmaz", async () => {
    const base = await collectContentSet(commit1Sha);
    const target = await collectContentSet(commit2Sha);
    const diff: ArchitectureDiff = diffContentSets(base, target);

    // Rename: createOrder → createPurchaseOrder (aynı yol, aynı argümanlar).
    expect(diff.renamed).toHaveLength(1);
    const rename = diff.renamed[0];
    if (rename === undefined) {
      throw new Error("rename eksik");
    }
    expect(rename.from.qualifiedName).toBe("createOrder");
    expect(rename.to.qualifiedName).toBe("createPurchaseOrder");
    expect(rename.confidence).toBe("high");
    expect(rename.score).toBeGreaterThanOrEqual(0.75);

    // Ekleme: auditLog; createPurchaseOrder added'a sızmamalı (rename'a emildi).
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.node.qualifiedName).toBe("auditLog");
    expect(diff.removed).toHaveLength(0);
    expect(diff.uncertain).toHaveLength(0);

    // Kenarlar: rename remap ile createOrder kenarı korunur; auditLog'un
    // yeni DECLARES kenarı meşru 'added'; cancelOrder kenarı değişmez.
    expect(diff.edges.added).toHaveLength(1);
    expect(diff.edges.added[0]?.to.qualifiedName).toBe("auditLog");
    expect(diff.edges.removed).toHaveLength(0);
    expect(diff.edges.changed).toHaveLength(0);
    expect(diff.edges.unchangedCount).toBe(2);

    // Ürün commit'lenmiş blob'u okudu; kirli çalışma ağacı diff'e sızmadı.
    expect(JSON.stringify(diff)).not.toContain("worktreeOnly");
  });

  it("negatif: geçersiz ref formatı ve var olmayan ref açıkça reddedilir", async () => {
    expectThrowsCode(() => assertValidGitRef("--upload-pack=evil"), "compare/invalid-ref");
    expectThrowsCode(() => assertValidGitRef("-c"), "compare/invalid-ref");
    expectThrowsCode(() => assertValidGitRef(""), "compare/invalid-ref");
    expectThrowsCode(() => assertValidGitRef("has space"), "compare/invalid-ref");
    expectThrowsCode(() => assertValidGitRef("a..b"), "compare/invalid-ref");
    expectThrowsCode(() => assertValidGitRef("HEAD.lock"), "compare/invalid-ref");
    expectThrowsCode(() => assertValidGitRef(`a${"b".repeat(200)}`), "compare/invalid-ref");

    // Geçerli biçimler kabul edilir (yürütme yapılmaz).
    expect(assertValidGitRef("main")).toBe("main");
    expect(assertValidGitRef("HEAD")).toBe("HEAD");
    expect(assertValidGitRef("refs/heads/feature/x")).toBe("refs/heads/feature/x");
    expect(assertValidGitRef("a".repeat(200))).toBe("a".repeat(200));

    // Biçimi geçerli ama depoda var olmayan ref → yürütme sonrası açık ret.
    await expectRejectsCode(
      () => readGitTree(repoRoot, "refs/heads/no-such-branch"),
      "compare/ref-not-found",
    );
  });

  it("negatif: ls-tree buffer sınırı (maxBuffer) aşımı ref-not-found olarak YANLIŞ etiketlenmez; tree-too-large döner", async () => {
    // Güvenlik/denetim bulgusu (düşük): mapGitSpawnError her spawn hatasını
    // compare/git-command-failed'a indirger; readGitTree bunu koşulsuz
    // 'ref çözümlenemedi'ye yeniden etiketler. maxBuffer aşımı (küçük bir
    // ağaçta bile kasıtlı küçük buffer ile tetiklenir) gerçek nedeni ağaç
    // boyutudur — dürüst hata raporlama sözleşmesi compare/tree-too-large
    // döndürmeli (TŞ §10.1 hata kodu tablosu; git-read.ts başlığındaki kod
    // listesi).
    await expectRejectsCode(
      () => readGitTree(repoRoot, commit1Sha, { maxBufferBytes: 64 }),
      "compare/tree-too-large",
    );
    // Normal koşumda aynı ref sorunsuz listelenir: sınır, kodun değil
    // buffer'ın aşımı olduğunu ayrıştırmalı.
    const entries = await readGitTree(repoRoot, commit1Sha);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("negatif: beyaz liste dışı git komutları yürütülmeye gönderilmeden reddedilir", async () => {
    // checkout/reset/clean TŞ §13'te ismen yasaktır; status dahil beyaz liste
    // dışı her alt komut exec'e ULAŞMADAN reddedilir.
    await expectRejectsCode(() => runGit(repoRoot, ["checkout", "main"]), "compare/git-command-not-allowed");
    await expectRejectsCode(() => runGit(repoRoot, ["reset", "--hard"]), "compare/git-command-not-allowed");
    await expectRejectsCode(() => runGit(repoRoot, ["clean", "-fdx"]), "compare/git-command-not-allowed");
    await expectRejectsCode(() => runGit(repoRoot, ["status", "--porcelain"]), "compare/git-command-not-allowed");
    await expectRejectsCode(() => runGit(repoRoot, []), "compare/git-command-not-allowed");
  });

  it("negatif: blob yolu traversal/absolut/backslash/colon denemeleri reddedilir", async () => {
    await expectRejectsCode(
      () => readGitBlob(repoRoot, commit2Sha, "../outside.txt"),
      "compare/invalid-blob-path",
    );
    await expectRejectsCode(
      () => readGitBlob(repoRoot, commit2Sha, "/abs.txt"),
      "compare/invalid-blob-path",
    );
    await expectRejectsCode(
      () => readGitBlob(repoRoot, commit2Sha, "src\\orders.ts"),
      "compare/invalid-blob-path",
    );
    await expectRejectsCode(
      () => readGitBlob(repoRoot, commit2Sha, "src/../secret.txt"),
      "compare/invalid-blob-path",
    );
    await expectRejectsCode(
      () => readGitBlob(repoRoot, commit2Sha, "-flag.txt"),
      "compare/invalid-blob-path",
    );
    // working-tree okuması da aynı yol savunmasından geçer.
    await expectRejectsCode(
      () => readGitBlob(repoRoot, "working-tree", "../evil.txt"),
      "compare/invalid-blob-path",
    );
  });

  it("pozitif: working-tree referansı izinli dizinden salt-okunur okunur", async () => {
    const entries = await readGitTree(repoRoot, "working-tree");
    const orders = entries.find((entry) => entry.path === "src/orders.ts");
    expect(orders?.type).toBe("blob");

    const content = await readGitBlob(repoRoot, "working-tree", "src/orders.ts");
    expect(content).toContain("worktreeOnly");
  });

  it("negatif: working-tree okuması sembolik bağ takip etmez", async (ctx) => {
    if (!symlinkCreated) {
      ctx.skip();
    }
    // Ağaç listelemesi sembolik bağları zaten göstermez.
    const entries = await readGitTree(repoRoot, "working-tree");
    expect(entries.some((entry) => entry.path.includes("link-"))).toBe(false);

    // Son bileşeni bağ olan yollar okunamaz — depo dışına kaçış da, depo
    // içine işaret eden bağ da (listeleme sözleşmesiyle aynı kural).
    await expectRejectsCode(
      () => readGitBlob(repoRoot, "working-tree", "src/link-outside.ts"),
      "compare/invalid-blob-path",
    );
    await expectRejectsCode(
      () => readGitBlob(repoRoot, "working-tree", "src/link-inside.ts"),
      "compare/invalid-blob-path",
    );
    expect(JSON.stringify(entries)).not.toContain("SECRET-OUTSIDE-REPO");
  });

  it("negatif: ağaç (dizin) yolu blob olarak okunamaz", async () => {
    // Denetim bulgusu 4: 'cat-file -p' ağaç yolunda liste metni döndürüyordu;
    // sözleşme yalnızca blob okumaktır.
    await expectRejectsCode(() => readGitBlob(repoRoot, commit2Sha, "src"), "compare/blob-not-found");
  });

  it("determinizm: aynı ref için iki koşum aynı içerik kümesi ve aynı diff JSON", async () => {
    const first = await collectContentSet(commit2Sha);
    const second = await collectContentSet(commit2Sha);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const diffFirst = diffContentSets(first, second);
    const diffSecond = diffContentSets(first, second);
    expect(JSON.stringify(diffFirst)).toBe(JSON.stringify(diffSecond));
  });

  it("güvenlik: buildGitEnv gizli ortam değişkenlerini ayıklar, minimal allowlist'i korur ve GIT_CONFIG_NOSYSTEM=1 + GIT_TERMINAL_PROMPT=0 zorlar", () => {
    const filtered = buildGitEnv({
      PATH: "/usr/bin:/bin",
      SystemRoot: "C:\\Windows",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      TEMP: "/tmp",
      TMP: "/tmp",
      HOME: "/home/dev",
      USERPROFILE: "C:\\Users\\dev",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      OPENAI_API_KEY: "sk-live-secret",
      GITHUB_TOKEN: "ghp_secret_token",
      AWS_SECRET_ACCESS_KEY: "aws-secret-key",
      ANTHROPIC_API_KEY: "ant-secret-key",
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_TERMINAL_PROMPT: "1",
    });

    expect(filtered["OPENAI_API_KEY"]).toBeUndefined();
    expect(filtered["GITHUB_TOKEN"]).toBeUndefined();
    expect(filtered["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(filtered["ANTHROPIC_API_KEY"]).toBeUndefined();

    expect(filtered["PATH"]).toBe("/usr/bin:/bin");
    expect(filtered["SystemRoot"]).toBe("C:\\Windows");
    expect(filtered["COMSPEC"]).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(filtered["TEMP"]).toBe("/tmp");
    expect(filtered["TMP"]).toBe("/tmp");
    expect(filtered["HOME"]).toBe("/home/dev");
    expect(filtered["USERPROFILE"]).toBe("C:\\Users\\dev");
    expect(filtered["LANG"]).toBe("C.UTF-8");
    expect(filtered["LC_ALL"]).toBe("C.UTF-8");
    expect(filtered["TZ"]).toBe("UTC");

    expect(filtered["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    expect(filtered["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(Object.keys(filtered).sort()).toEqual([
      "COMSPEC",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_TERMINAL_PROMPT",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "SystemRoot",
      "TEMP",
      "TMP",
      "TZ",
      "USERPROFILE",
    ]);
  });

  it("güvenlik: working-tree readGitBlob maxBufferBytes sınırını aşan dosyaları compare/blob-too-large ile ve normal dosya olmayan yolları compare/invalid-blob-path ile reddeder", async () => {
    const wtRoot = await mkdtemp(path.join(tmpdir(), "causoryn-wt-blob-"));
    try {
      await mkdir(path.join(wtRoot, "src", "subdir"), { recursive: true });
      await writeFile(path.join(wtRoot, "src", "small.ts"), "export const ok = 1;\n", "utf8");
      await writeFile(path.join(wtRoot, "src", "oversized.ts"), "x".repeat(512), "utf8");

      // Sınır içindeki normal dosya sorunsuz okunur.
      const small = await readGitBlob(wtRoot, "working-tree", "src/small.ts", {
        maxBufferBytes: 128,
      });
      expect(small).toBe("export const ok = 1;\n");

      // Sınır aşımı: compare/blob-too-large ile reddedilir.
      await expectRejectsCode(
        () =>
          readGitBlob(wtRoot, "working-tree", "src/oversized.ts", {
            maxBufferBytes: 128,
          }),
        "compare/blob-too-large",
      );

      // Normal dosya olmayan yol (dizin): compare/invalid-blob-path ile reddedilir.
      await expectRejectsCode(
        () => readGitBlob(wtRoot, "working-tree", "src/subdir"),
        "compare/invalid-blob-path",
      );
    } finally {
      await rm(wtRoot, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* Compare/timeline blob üreticisi (denetim bulgusu: üretici yoktu)     */
/* ------------------------------------------------------------------ */

describe("serializeSnapshotContentSet — .causoryn/architecture-snapshot.json üreticisi", () => {
  // Denetim bulgusu (orta): compare/timeline'ın tükettiği blob sözleşmesini
  // (CompareContentSet: kenar uçları {kind, qualifiedName} kimlik nesneleri)
  // üreten hiçbir kod yoktu; tek JSON export yolu tam snapshot canonical
  // JSON'u üretir ve uçları node-id string olduğu için blob okuyucu
  // 'edge from ucu bir nesne değil' ile reddeder. Bu testler üreticinin
  // çıktısının TÜKETİCİLERİN KENDİ doğrulamalarından geçtiğini kanıtlar.
  const SPAN_A = {
    relativePath: "src/orders/index.ts",
    startLine: 1,
    endLine: 20,
    sourceHash: "sha256:blob-a",
  };
  const SPAN_B = {
    relativePath: "src/orders/create.ts",
    startLine: 5,
    endLine: 25,
    sourceHash: "sha256:blob-b",
  };
  const NODE_A = { kind: "Module" as const, qualifiedName: "app::orders", language: "typescript", location: SPAN_A, attributes: {} };
  const NODE_B = { kind: "Function" as const, qualifiedName: "app::orders::create", language: "typescript", location: SPAN_B, attributes: {} };

  function blobFixture(): SnapshotGraph {
    return createSnapshot({
      workspaceId: "ws_blob",
      revision: { id: "rev-blob", sequence: 1 },
      configHash: "confighash-blob",
      analyzerFingerprint: "typescript-adapter@0.1.0",
      state: "ready",
      createdAt: "2026-11-05T09:00:00.000Z",
      nodes: [NODE_A, NODE_B],
      edges: [
        {
          kind: "CALLS",
          from: NODE_A,
          to: NODE_B,
          resolution: "verified",
          evidence: [
            {
              kind: "static-analysis",
              span: SPAN_B,
              analyzerId: "typescript-adapter",
              analyzerVersion: "0.1.0",
              rationale: "denetim bulgusu blob üreticisi",
            },
          ],
        },
      ],
    });
  }

  it("ürettiği blob compare diff girdisi olarak sindirilir: uçlar {kind, qualifiedName} kimliği taşır, round-trip sıfır diff", () => {
    const snapshot = blobFixture();
    const blob = serializeSnapshotContentSet(snapshot);
    const parsed = JSON.parse(blob) as CompareContentSet;

    // Blob sözleşmesi: uçlar node-ID string DEĞİL, kimlik nesnesi.
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.edges).toHaveLength(1);
    const edge = parsed.edges[0]!;
    expect(typeof edge.from).toBe("object");
    expect(edge.from.kind).toBe("Module");
    expect(edge.from.qualifiedName).toBe("app::orders");
    expect(edge.from.relativePath).toBe("src/orders/index.ts");
    expect(edge.to.kind).toBe("Function");
    expect(edge.to.qualifiedName).toBe("app::orders::create");
    expect(edge.to.relativePath).toBe("src/orders/create.ts");
    expect(edge.resolution).toBe("verified");

    // Tüketici doğrulaması: aynı kümeyle diff → değişim yok.
    const diff = diffContentSets(parsed, parsed);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.unchangedNodeCount).toBe(2);
    expect(diff.edges.added).toHaveLength(0);
    expect(diff.edges.removed).toHaveLength(0);
    expect(diff.edges.changed).toHaveLength(0);
    expect(diff.edges.unchangedCount).toBe(1);
  });

  it("determinizm: node/edge girdi sırası karıştırılsa bile blob bit-bit aynı", () => {
    const straight = serializeSnapshotContentSet(blobFixture());
    const shuffled = createSnapshot({
      workspaceId: "ws_blob",
      revision: { id: "rev-blob", sequence: 1 },
      configHash: "confighash-blob",
      analyzerFingerprint: "typescript-adapter@0.1.0",
      state: "ready",
      createdAt: "2026-11-05T09:00:00.000Z",
      nodes: [NODE_B, NODE_A],
      edges: [
        {
          kind: "CALLS",
          from: NODE_A,
          to: NODE_B,
          resolution: "verified",
          evidence: [
            {
              kind: "static-analysis",
              span: SPAN_B,
              analyzerId: "typescript-adapter",
              analyzerVersion: "0.1.0",
              rationale: "denetim bulgusu blob üreticisi",
            },
          ],
        },
      ],
    });
    expect(serializeSnapshotContentSet(shuffled)).toBe(straight);
    expect(serializeSnapshotContentSet(blobFixture())).toBe(straight);
  });

  it("negatif: bilinmeyen kenar ucu savunma katmanıyla compare/dangling-edge ile reddedilir", () => {
    const snapshot = blobFixture();
    const dangling: SnapshotGraph = {
      meta: snapshot.meta,
      nodes: snapshot.nodes,
      edges: [
        {
          id: "edge:dangling",
          from: "node:0000000000000000000000000000000000000000000000000000000000000000",
          to: snapshot.edges[0]!.to,
          kind: "CALLS",
          resolution: "verified",
          evidenceIds: snapshot.edges[0]!.evidenceIds,
        },
      ],
      evidence: snapshot.evidence,
    };
    expectThrowsCode(() => serializeSnapshotContentSet(dangling), "compare/dangling-edge");
  });
});
