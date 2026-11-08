import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { GraphRepositoryError } from "../src/errors.js";
import type { CompareContentSet, CompareEdge, CompareNode } from "../src/compare.js";
import * as graphIndex from "../src/index.js";
import {
  TIMELINE_CEILINGS,
  TIMELINE_DEFAULTS,
  buildArchitectureTimeline,
  buildArchitectureTimelineFromGit,
  selectSampledIndices,
  type TimelineInterval,
  type TimelinePointContent,
  type TimelinePointInput,
} from "../src/timeline.js";

/**
 * causoryn_architecture_timeline çekirdek testleri (sprint-3 C7, TŞ v2.1 §13).
 *
 * TŞ §13 (Sayfa 12) Timeline sözleşmesi: "refs=[...] veya bounded
 * history-range için snapshot/diff özetleri hazırlanır. Her commit'i taramak
 * pahalıysa sampling ve maxRevisions uygulanır; analiz edilmeyen aralıklar
 * açık raporlanır." TŞ §10 (Sayfa 10) araç girdisi: refs/range, granularity.
 *
 * Pozitif: 3 nokta → 2 diff özeti + node/edge/API değişim sayıları (compare
 * çıktısından türetilmiş); refs modu ve git aralığı (ilk-ebeveyn zinciri,
 * yalnızca salt-okunur cat-file) uçtan uca geçici depoda koşar.
 * Negatif: geçersiz aralık (eş uçlar, kötü ref, var olmayan ref, from
 * atası olmayan dal) açık reddi; yetersiz nokta; tekrar ref; geçersiz limit.
 * Partial: maxRevisions aşıldığında deterministik eşit aralıklı örnekleme +
 * atlanan noktaların açık raporu; bir noktaya analiz edilemeyen içerik →
 * 'unanalyzed-interval' kaydı (uydurma interpolasyon YOK).
 *
 * Kırmızı çizgiler: checkout/reset/clean yok (ürün katmanı yalnızca
 * cat-file/ls-tree); ölçüler kalite skoru olarak tek sayıya indirgenmez
 * (TŞ §13). Test geçici depoyu KENDİ kurar; ürün yalnızca salt-okunur okur.
 */

const execFile = promisify(execFileCallback);

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

/** Sync çağrının GraphRepositoryError ve beklenen kodla fırlatılmasını zorlar. */
function expectThrowsCode(action: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    thrown = (() => {
      try {
        action();
        return undefined;
      } catch (error) {
        return error;
      }
    })();
  } catch {
    // imkânsız; iç fonksiyon yakaladı
  }
  if (thrown === undefined) {
    throw new Error(`Beklenen hata fırlatılmadı (kod=${code})`);
  }
  expect(thrown).toBeInstanceOf(GraphRepositoryError);
  expect((thrown as GraphRepositoryError).code).toBe(code);
}

// ---------------------------------------------------------------------------
// İçerik kümesi üreticileri (compare.test.ts ile aynı kimlik sözleşmesi)
// ---------------------------------------------------------------------------

function fileNode(p: string): CompareNode {
  return { kind: "File", qualifiedName: p, relativePath: p, attributes: {} };
}

function fnNode(name: string, p: string, signature: string): CompareNode {
  return {
    kind: "Function",
    qualifiedName: name,
    language: "typescript",
    relativePath: p,
    signature,
    attributes: {},
  };
}

function endpointNode(route: string, p: string): CompareNode {
  return {
    kind: "Endpoint",
    qualifiedName: route,
    relativePath: p,
    signature: route,
    attributes: {},
  };
}

function declaresEdge(file: string, fnName: string, fnPath: string): CompareEdge {
  return {
    kind: "DECLARES",
    from: { kind: "File", qualifiedName: file, relativePath: file },
    to: { kind: "Function", qualifiedName: fnName, relativePath: fnPath },
    resolution: "heuristic",
  };
}

const FILE_A = "src/a.ts";
const FILE_B = "src/b.ts";
const FILE_C = "src/c.ts";

function setV1(): CompareContentSet {
  return {
    nodes: [
      fileNode(FILE_A),
      fnNode("Alpha", FILE_A, "alpha()"),
      fileNode(FILE_B),
      fnNode("Beta", FILE_B, "beta()"),
    ],
    edges: [
      declaresEdge(FILE_A, "Alpha", FILE_A),
      declaresEdge(FILE_B, "Beta", FILE_B),
    ],
  };
}

function setV2(): CompareContentSet {
  return {
    nodes: [
      fileNode(FILE_A),
      fnNode("Alpha", FILE_A, "alpha(n: number)"),
      fileNode(FILE_B),
      fnNode("Beta", FILE_B, "beta()"),
      fileNode(FILE_C),
      fnNode("Gamma", FILE_C, "gamma()"),
    ],
    edges: [
      declaresEdge(FILE_A, "Alpha", FILE_A),
      declaresEdge(FILE_B, "Beta", FILE_B),
      declaresEdge(FILE_C, "Gamma", FILE_C),
    ],
  };
}

function setV3(): CompareContentSet {
  return {
    nodes: [
      fileNode(FILE_B),
      fnNode("Beta", FILE_B, "beta()"),
      fileNode(FILE_C),
      fnNode("Gamma", FILE_C, "gamma()"),
      endpointNode("GET /x", "src/routes.ts"),
    ],
    edges: [
      declaresEdge(FILE_B, "Beta", FILE_B),
      declaresEdge(FILE_C, "Gamma", FILE_C),
    ],
  };
}

function analyzed(set: CompareContentSet): TimelinePointContent {
  return { status: "analyzed", contentSet: set };
}

function unanalyzed(reason: string): TimelinePointContent {
  return { status: "unanalyzed", reason };
}

function point(ref: string, content: TimelinePointContent): TimelinePointInput {
  return { ref, content };
}

// ---------------------------------------------------------------------------
// Saf çekirdek: buildArchitectureTimeline
// ---------------------------------------------------------------------------

describe("timeline çekirdeği — buildArchitectureTimeline (saf)", () => {
  it("pozitif: 3 nokta → 2 diff özeti + node/edge/API değişim sayıları", () => {
    const timeline = buildArchitectureTimeline({
      points: [
        point("v1", analyzed(setV1())),
        point("v2", analyzed(setV2())),
        point("v3", analyzed(setV3())),
      ],
    });

    expect(timeline.requestedPoints).toBe(3);
    expect(timeline.points).toHaveLength(3);
    expect(timeline.analyzedPoints).toBe(3);
    expect(timeline.unanalyzedPoints).toBe(0);
    expect(timeline.intervals).toHaveLength(2);
    expect(timeline.sampling.applied).toBe(false);
    expect(timeline.sampling.skipped).toHaveLength(0);

    const first = timeline.intervals[0];
    if (first === undefined || first.kind !== "diff") {
      throw new Error("ilk interval 'diff' olmalı");
    }
    expect(first.fromRef).toBe("v1");
    expect(first.toRef).toBe("v2");
    expect(first.fromIndex).toBe(0);
    expect(first.toIndex).toBe(1);
    expect(first.fromSourceIndex).toBe(0);
    expect(first.toSourceIndex).toBe(1);
    expect(first.changes.added).toBe(2); // File c + Gamma
    expect(first.changes.removed).toBe(0);
    expect(first.changes.changed).toBe(1); // Alpha imza değişimi
    expect(first.changes.unchangedNodes).toBe(3); // File a, File b, Beta
    expect(first.changes.edgeAdded).toBe(1); // DECLARES c→Gamma
    expect(first.changes.edgeRemoved).toBe(0);
    expect(first.changes.edgeUnchanged).toBe(2);
    expect(first.changes.apiSurfaceChanges).toBe(0);

    const second = timeline.intervals[1];
    if (second === undefined || second.kind !== "diff") {
      throw new Error("ikinci interval 'diff' olmalı");
    }
    expect(second.fromRef).toBe("v2");
    expect(second.toRef).toBe("v3");
    expect(second.changes.added).toBe(1); // Endpoint
    expect(second.changes.removed).toBe(2); // File a + Alpha
    expect(second.changes.changed).toBe(0);
    expect(second.changes.unchangedNodes).toBe(4);
    expect(second.changes.edgeAdded).toBe(0);
    expect(second.changes.edgeRemoved).toBe(1); // DECLARES a→Alpha
    expect(second.changes.edgeUnchanged).toBe(2);
    expect(second.changes.apiSurfaceChanges).toBe(1); // Endpoint eklendi

    // Nokta mutlak sayıları.
    expect(timeline.points[0]).toMatchObject({
      ref: "v1",
      status: "analyzed",
      nodeCount: 4,
      edgeCount: 2,
      apiSurfaceNodeCount: 0,
    });
    expect(timeline.points[1]).toMatchObject({
      ref: "v2",
      status: "analyzed",
      nodeCount: 6,
      edgeCount: 3,
      apiSurfaceNodeCount: 0,
    });
    expect(timeline.points[2]).toMatchObject({
      ref: "v3",
      status: "analyzed",
      nodeCount: 5,
      edgeCount: 2,
      apiSurfaceNodeCount: 1,
    });

    // TŞ §13: ölçüler kalite skoru olarak tek sayıya indirgenmez.
    expect(JSON.stringify(timeline)).not.toContain("qualityScore");
    expect(JSON.stringify(timeline)).not.toContain('"score"');
  });

  it("negatif: geçersiz girdiler açık kodlarla reddedilir", () => {
    // Yetersiz nokta.
    expectThrowsCode(
      () => buildArchitectureTimeline({ points: [] }),
      "timeline/insufficient-points",
    );
    expectThrowsCode(
      () => buildArchitectureTimeline({ points: [point("v1", analyzed(setV1()))] }),
      "timeline/insufficient-points",
    );
    // Tekrar ref.
    expectThrowsCode(
      () =>
        buildArchitectureTimeline({
          points: [
            point("v1", analyzed(setV1())),
            point("v1", analyzed(setV2())),
          ],
        }),
      "timeline/duplicate-ref",
    );
    // Geçersiz ref biçimi (C3 güvenlik deseni).
    expectThrowsCode(
      () =>
        buildArchitectureTimeline({
          points: [
            point("v1", analyzed(setV1())),
            point("--evil", analyzed(setV2())),
          ],
        }),
      "compare/invalid-ref",
    );
    // Geçersiz limitler.
    for (const bad of [0, 1, 2.5, Number.NaN]) {
      expectThrowsCode(
        () =>
          buildArchitectureTimeline({
            points: [
              point("v1", analyzed(setV1())),
              point("v2", analyzed(setV2())),
            ],
            maxRevisions: bad,
          }),
        "timeline/invalid-limit",
      );
    }
  });

  it("config: maxRevisions tavanı aşarsa tavana kırpılır ve applied limit raporlanır", () => {
    const timeline = buildArchitectureTimeline({
      points: [
        point("v1", analyzed(setV1())),
        point("v2", analyzed(setV2())),
      ],
      maxRevisions: TIMELINE_CEILINGS.maxRevisions + 500,
    });
    expect(timeline.limits.maxRevisions).toBe(TIMELINE_CEILINGS.maxRevisions);
    expect(TIMELINE_DEFAULTS.maxRevisions).toBeGreaterThan(1);
    expect(TIMELINE_CEILINGS.maxRevisions).toBeGreaterThanOrEqual(
      TIMELINE_DEFAULTS.maxRevisions,
    );
  });

  it("partial: maxRevisions aşıldı → deterministik örnekleme + atlanan noktalar açık raporlu", () => {
    const timeline = buildArchitectureTimeline({
      points: [
        point("r0", analyzed(setV1())),
        point("r1", analyzed(setV2())),
        point("r2", analyzed(setV3())),
        point("r3", analyzed(setV2())),
        point("r4", analyzed(setV3())),
      ],
      maxRevisions: 3,
    });

    expect(timeline.sampling.applied).toBe(true);
    expect(timeline.sampling.maxRevisions).toBe(3);
    expect(timeline.sampling.requestedPoints).toBe(5);
    expect(timeline.sampling.selectedCount).toBe(3);
    expect(timeline.sampling.skipped).toEqual([
      { sourceIndex: 1, ref: "r1" },
      { sourceIndex: 3, ref: "r3" },
    ]);

    expect(timeline.points).toHaveLength(3);
    expect(timeline.points.map((p) => p.sourceIndex)).toEqual([0, 2, 4]);
    expect(timeline.intervals).toHaveLength(2);
    // Aralıklar SEÇİLMİŞ ardışık noktalar arasında: r0→r2 ve r2→r4.
    expect(timeline.intervals[0]).toMatchObject({
      kind: "diff",
      fromSourceIndex: 0,
      toSourceIndex: 2,
      fromRef: "r0",
      toRef: "r2",
    });
    expect(timeline.intervals[1]).toMatchObject({
      kind: "diff",
      fromSourceIndex: 2,
      toSourceIndex: 4,
      fromRef: "r2",
      toRef: "r4",
    });
    const first = timeline.intervals[0];
    if (first === undefined || first.kind !== "diff") {
      throw new Error("ilk interval 'diff' olmalı");
    }
    // setV1 → setV3 (compare.ts gerçek davranışı): File a→File c medium
    // confidence rename (uzantı taban adı eşleşmesi); Alpha bağımsız çıkarma;
    // Gamma + Endpoint ekleme.
    expect(first.changes.added).toBe(2);
    expect(first.changes.removed).toBe(1);
    expect(first.changes.renamed).toBe(1);
    expect(first.changes.apiSurfaceChanges).toBe(1);
  });

  it("partial: analiz edilemeyen nokta → 'unanalyzed-interval' kaydı, uydurma sayı yok", () => {
    const timeline = buildArchitectureTimeline({
      points: [
        point("v1", analyzed(setV1())),
        point("bad", unanalyzed("manifest-not-json: beklenmeyen simge")),
        point("v3", analyzed(setV3())),
      ],
    });

    expect(timeline.analyzedPoints).toBe(2);
    expect(timeline.unanalyzedPoints).toBe(1);
    expect(timeline.points[1]).toMatchObject({
      ref: "bad",
      status: "unanalyzed",
      unanalyzedReason: "manifest-not-json: beklenmeyen simge",
    });
    expect(timeline.intervals).toHaveLength(2);
    for (const interval of timeline.intervals as readonly TimelineInterval[]) {
      expect(interval.kind).toBe("unanalyzed-interval");
      expect(JSON.stringify(interval)).not.toContain('"changes"');
    }
    const first = timeline.intervals[0];
    if (first === undefined || first.kind !== "unanalyzed-interval") {
      throw new Error("ilk interval 'unanalyzed-interval' olmalı");
    }
    expect(first.reasons.to).toBe("manifest-not-json: beklenmeyen simge");
    const second = timeline.intervals[1];
    if (second === undefined || second.kind !== "unanalyzed-interval") {
      throw new Error("ikinci interval 'unanalyzed-interval' olmalı");
    }
    expect(second.reasons.from).toBe("manifest-not-json: beklenmeyen simge");
  });

  it("partial: compare sözleşmesini ihlal eden içerik → interval açık 'unanalyzed-interval'", () => {
    // Aynı içerik kümesinde tekrar node kimliği → diffContentSets reddeder;
    // çekirdek bu içeriği analiz edilemez sayar, komutları uydurmaz.
    const duplicateSet: CompareContentSet = {
      nodes: [fnNode("Dup", FILE_A, "dup()"), fnNode("Dup", FILE_A, "dup()")],
      edges: [],
    };
    const timeline = buildArchitectureTimeline({
      points: [
        point("v1", analyzed(setV1())),
        point("dup", analyzed(duplicateSet)),
        point("v3", analyzed(setV3())),
      ],
    });
    expect(timeline.intervals).toHaveLength(2);
    for (const interval of timeline.intervals) {
      expect(interval.kind).toBe("unanalyzed-interval");
      if (interval.kind !== "unanalyzed-interval") continue;
      expect(interval.reasons.pair).toContain("compare/duplicate-node");
    }
  });

  it("negatif: analyzed noktada bozuk relativePath/signature türü kodlanmamış TypeError kaçmaz", () => {
    // Denetim bulgusu 1: güvenilmez girdide relativePath/signature türü
    // doğrulanmadan analyzed işaretleniyordu; diffContentSets'in
    // pathSegmentSet/tokenize katmanı .split/.replace ile TypeError
    // fırlatıyordu — GraphRepositoryError kod sözleşmesinin DIŞINDA (TŞ §19:
    // depo güvenilmez girdi sayılır). Çekirdek sınırda türü doğrular.
    const badRelativePath: CompareContentSet = {
      nodes: [
        {
          kind: "File",
          qualifiedName: "src/x.ts",
          relativePath: null as unknown as string,
          attributes: {},
        },
      ],
      edges: [],
    };
    expectThrowsCode(
      () =>
        buildArchitectureTimeline({
          points: [
            point("v1", analyzed(setV1())),
            point("bad", analyzed(badRelativePath)),
          ],
        }),
      "timeline/invalid-input",
    );
    const badSignature: CompareContentSet = {
      nodes: [
        {
          kind: "Function",
          qualifiedName: "X",
          relativePath: "src/x.ts",
          signature: 123 as unknown as string,
          attributes: {},
        },
      ],
      edges: [],
    };
    expectThrowsCode(
      () =>
        buildArchitectureTimeline({
          points: [
            point("v1", analyzed(setV1())),
            point("bad2", analyzed(badSignature)),
          ],
        }),
      "timeline/invalid-input",
    );
  });

  it("config: maxRangeWalk tavanı kırpılır, limits içinde raporlanır ve geçersiz değer reddedilir", () => {
    const timeline = buildArchitectureTimeline({
      points: [
        point("v1", analyzed(setV1())),
        point("v2", analyzed(setV2())),
      ],
      maxRangeWalk: TIMELINE_CEILINGS.maxRangeWalk + 1000,
    });
    expect(timeline.limits.maxRangeWalk).toBe(TIMELINE_CEILINGS.maxRangeWalk);
    for (const bad of [0, 1, 2.5, Number.NaN]) {
      expectThrowsCode(
        () =>
          buildArchitectureTimeline({
            points: [
              point("v1", analyzed(setV1())),
              point("v2", analyzed(setV2())),
            ],
            maxRangeWalk: bad,
          }),
        "timeline/invalid-limit",
      );
    }
  });

  it("determinizm: aynı girdi iki koşum aynı JSON; içerik kümesi sırası sonucu değiştirmez", () => {
    const input = {
      points: [
        point("v1", analyzed(setV1())),
        point("v2", analyzed(setV2())),
        point("v3", analyzed(setV3())),
      ],
    };
    const first = buildArchitectureTimeline(input);
    const second = buildArchitectureTimeline(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const shuffledInput = {
      points: [
        point("v1", {
          status: "analyzed",
          contentSet: {
            nodes: [...setV1().nodes].reverse(),
            edges: [...setV1().edges].reverse(),
          },
        }),
        point("v2", {
          status: "analyzed",
          contentSet: {
            nodes: [...setV2().nodes].reverse(),
            edges: [...setV2().edges].reverse(),
          },
        }),
        point("v3", {
          status: "analyzed",
          contentSet: {
            nodes: [...setV3().nodes].reverse(),
            edges: [...setV3().edges].reverse(),
          },
        }),
      ],
    };
    const shuffled = buildArchitectureTimeline(shuffledInput);
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(first));
  });

  it("selectSampledIndices: eşit aralıklı, uçlar korunur, deterministik", () => {
    expect(selectSampledIndices(5, 3)).toEqual([0, 2, 4]);
    expect(selectSampledIndices(3, 5)).toEqual([0, 1, 2]);
    expect(selectSampledIndices(7, 2)).toEqual([0, 6]);
    expect(selectSampledIndices(6, 4)).toEqual([0, 1, 3, 5]);
    expect(selectSampledIndices(2, 2)).toEqual([0, 1]);
    expectThrowsCode(() => selectSampledIndices(5, 1), "timeline/invalid-limit");
  });
});

// ---------------------------------------------------------------------------
// Git spawn katmanı: geçici depo (salt-okunur cat-file okuması)
// ---------------------------------------------------------------------------

/** Manifest üreticileri: her commit .causoryn/architecture-snapshot.json taşır. */
const BROKEN_JSON_MANIFEST = '{ "nodes": [ bozuk json';

function shapeBrokenManifest(): string {
  return JSON.stringify({ nodes: "bozuk-türü", edges: [] });
}

describe("timeline git katmanı — geçici depo (salt-okunur)", () => {
  let repoRoot: string;
  let sha2: string;
  let sha3: string;
  const shas: string[] = [];

  beforeAll(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "causoryn-timeline-"));
    const git = async (args: string[]): Promise<string> => {
      const result = await execFile("git", ["-C", repoRoot, ...args], {
        shell: false,
        windowsHide: true,
      });
      return result.stdout;
    };
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Causoryn Timeline Test"]);
    await git(["config", "user.email", "timeline-test@causoryn.invalid"]);
    await git(["config", "core.autocrlf", "false"]);

    const manifestStrings = [
      JSON.stringify(setV1(), null, 2),
      JSON.stringify(setV2(), null, 2),
      JSON.stringify(setV3(), null, 2),
      shapeBrokenManifest(),
      BROKEN_JSON_MANIFEST,
    ];
    await mkdir(path.join(repoRoot, ".causoryn"), { recursive: true });
    for (let i = 0; i < manifestStrings.length; i++) {
      const manifest = manifestStrings[i];
      if (manifest === undefined) throw new Error("manifest eksik");
      await writeFile(
        path.join(repoRoot, ".causoryn", "architecture-snapshot.json"),
        manifest,
        "utf8",
      );
      await git(["add", "-A"]);
      await git(["commit", "-m", `commit-${i + 1}`]);
      const sha = (await git(["rev-parse", "HEAD"])).trim();
      shas.push(sha);
      await git(["tag", `v${i + 1}`]);
    }

    // Annotated tag: peel yolu (tag nesnesi → commit) test edilir.
    await git(["tag", "-a", "av1", "-m", "annotated v1", shas[0] ?? ""]);

    // v3'ün ilk-ebeveyn zincirinde OLMAYAN dal: v2'den kopan tek commit.
    // (checkout yok; commit-tree + branch ile worktree dokunulmaz.)
    const sideSha = (
      await git(["commit-tree", `${shas[1] ?? ""}^{tree}`, "-p", shas[1] ?? "", "-m", "side-commit"])
    ).trim();
    await git(["branch", "side", sideSha]);

    // Denetim bulgusu 1: relativePath türü bozuk manifest taşıyan commit.
    // (null relativePath shape denetimini geçememeli; geçseydi diffContentSets
    // pathSegmentSet içinde kodlanmamış TypeError fırlatırdı.)
    await writeFile(
      path.join(repoRoot, ".causoryn", "architecture-snapshot.json"),
      JSON.stringify({
        nodes: [
          { kind: "File", qualifiedName: "src/x.ts", relativePath: null, attributes: {} },
        ],
        edges: [],
      }),
      "utf8",
    );
    await git(["add", "-A"]);
    await git(["commit", "-m", "commit-6-bad-relative-path"]);
    await git(["tag", "v6"]);

    // Denetim bulgusu 3: tag-peel derinlik sınırı için 6 katmanlı tag zinciri.
    // git-tag CLI annotated tag'i commit'e peel ettiği için zincir kuramaz;
    // hash-object -t tag -w ile tag nesneleri elle yazılır.
    const tagObjectSha = (text: string): string => {
      const result = spawnSync(
        "git",
        ["-C", repoRoot, "hash-object", "-t", "tag", "-w", "--stdin"],
        { input: text, shell: false, windowsHide: true, encoding: "utf8" },
      );
      if (result.status !== 0) {
        throw new Error(`hash-object başarısız: ${String(result.stderr)}`);
      }
      return (result.stdout ?? "").trim();
    };
    // av1 annotated tag NESNESİNİN sha'sı (ref'in işaret ettiği tag objesi).
    const av1TagObjectSha = (await git(["rev-parse", "refs/tags/av1"])).trim();
    let prevTagSha = av1TagObjectSha;
    for (let level = 1; level <= 6; level++) {
      const objectSha = tagObjectSha(
        `object ${prevTagSha}\ntype tag\ntag deep${level}\n` +
          `tagger Causoryn Deep <deep@causoryn.invalid> 0 +0000\n\n` +
          `deep level ${level}\n`,
      );
      await git(["update-ref", `refs/tags/deep${level}`, objectSha]);
      prevTagSha = objectSha;
    }

    // Kurulum doğrulaması: sonraki testlerde kullanılan sha'lar mevcut olmalı.
    if (shas[0] === undefined || shas[1] === undefined || shas[2] === undefined) {
      throw new Error("test kurulumunda commit sha'ları eksik");
    }
    sha2 = shas[1];
    sha3 = shas[2];
  }, 30_000);

  afterAll(async () => {
    if (repoRoot !== undefined) {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("pozitif: refs modu — 3 tag → 2 diff özeti + değişim sayıları", async () => {
    const timeline = await buildArchitectureTimelineFromGit(repoRoot, {
      refs: ["v1", "v2", "v3"],
    });

    expect(timeline.requestedPoints).toBe(3);
    expect(timeline.sampling.applied).toBe(false);
    expect(timeline.points.map((p) => p.ref)).toEqual(["v1", "v2", "v3"]);
    expect(timeline.intervals).toHaveLength(2);

    const first = timeline.intervals[0];
    if (first === undefined || first.kind !== "diff") {
      throw new Error("ilk interval 'diff' olmalı");
    }
    expect(first.changes.added).toBe(2);
    expect(first.changes.changed).toBe(1);
    expect(first.changes.apiSurfaceChanges).toBe(0);

    const second = timeline.intervals[1];
    if (second === undefined || second.kind !== "diff") {
      throw new Error("ikinci interval 'diff' olmalı");
    }
    expect(second.changes.removed).toBe(2);
    expect(second.changes.added).toBe(1);
    expect(second.changes.apiSurfaceChanges).toBe(1);
  }, 30_000);

  it("pozitif: range modu — v1..v3 ilk-ebeveyn zinciri, sıralı 3 nokta", async () => {
    const timeline = await buildArchitectureTimelineFromGit(repoRoot, {
      range: { from: "v1", to: "v3" },
    });

    expect(timeline.requestedPoints).toBe(3);
    expect(timeline.points.map((p) => p.ref)).toEqual([
      "v1",
      sha2,
      "v3",
    ]);
    expect(timeline.intervals).toHaveLength(2);
    const second = timeline.intervals[1];
    if (second === undefined || second.kind !== "diff") {
      throw new Error("ikinci interval 'diff' olmalı");
    }
    expect(second.changes.apiSurfaceChanges).toBe(1);
  }, 30_000);

  it("pozitif: annotated tag uçlu range — tag nesnesi commit'e peel edilir", async () => {
    const timeline = await buildArchitectureTimelineFromGit(repoRoot, {
      range: { from: "av1", to: "v2" },
    });
    expect(timeline.points.map((p) => p.ref)).toEqual(["av1", "v2"]);
    expect(timeline.intervals).toHaveLength(1);
    const only = timeline.intervals[0];
    if (only === undefined || only.kind !== "diff") {
      throw new Error("tek interval 'diff' olmalı");
    }
    expect(only.changes.added).toBe(2);
    expect(only.changes.changed).toBe(1);
  }, 30_000);

  it("negatif: geçersiz aralık açıkça reddedilir", async () => {
    // Eş uçlar.
    await expectRejectsCode(
      () =>
        buildArchitectureTimelineFromGit(repoRoot, {
          range: { from: "v1", to: "v1" },
        }),
      "timeline/invalid-range",
    );
    // Ref biçimi güvenlik desenine uymuyor.
    await expectRejectsCode(
      () =>
        buildArchitectureTimelineFromGit(repoRoot, {
          range: { from: "--upload-pack=evil", to: "v3" },
        }),
      "compare/invalid-ref",
    );
    // Var olmayan ref.
    await expectRejectsCode(
      () =>
        buildArchitectureTimelineFromGit(repoRoot, {
          range: { from: "refs/heads/no-such-branch", to: "v3" },
        }),
      "compare/ref-not-found",
    );
    // from, to'nun ilk-ebeveyn zincirinde değil (yan dal).
    await expectRejectsCode(
      () =>
        buildArchitectureTimelineFromGit(repoRoot, {
          range: { from: "side", to: "v3" },
        }),
      "timeline/invalid-range",
    );
    // Girdi modu belirsiz: refs ve range birlikte / ikisi birden yok.
    await expectRejectsCode(
      () =>
        buildArchitectureTimelineFromGit(repoRoot, {
          refs: ["v1", "v2"],
          range: { from: "v1", to: "v3" },
        }),
      "timeline/invalid-input",
    );
    await expectRejectsCode(
      () => buildArchitectureTimelineFromGit(repoRoot, {}),
      "timeline/invalid-input",
    );
    // Refs modunda var olmayan ref açık hatadır (sessiz unanalyzed DEĞİL).
    await expectRejectsCode(
      () =>
        buildArchitectureTimelineFromGit(repoRoot, {
          refs: ["v1", "refs/heads/no-such-branch"],
        }),
      "compare/ref-not-found",
    );
    // Geçersiz repo kökü.
    await expectRejectsCode(
      () =>
        buildArchitectureTimelineFromGit("relative/path", {
          refs: ["v1", "v2"],
        }),
      "compare/invalid-repo-root",
    );
  });

  it("partial: maxRevisions aşıldı → örnekleme + atlanan noktalar; analiz edilemeyen içerik → unanalyzed-interval", async () => {
    // 5 nokta, limit 3 → seçim [0,2,4] = v1, v3, v5; v5 manifest'i bozuk JSON.
    const timeline = await buildArchitectureTimelineFromGit(repoRoot, {
      refs: ["v1", "v2", "v3", "v4", "v5"],
      maxRevisions: 3,
    });

    expect(timeline.sampling.applied).toBe(true);
    expect(timeline.sampling.selectedCount).toBe(3);
    expect(timeline.sampling.skipped).toEqual([
      { sourceIndex: 1, ref: "v2" },
      { sourceIndex: 3, ref: "v4" },
    ]);
    expect(timeline.points.map((p) => p.ref)).toEqual(["v1", "v3", "v5"]);
    expect(timeline.points[2]).toMatchObject({
      ref: "v5",
      status: "unanalyzed",
    });
    const reason = timeline.points[2]?.unanalyzedReason ?? "";
    expect(reason.startsWith("manifest-not-json")).toBe(true);

    expect(timeline.intervals).toHaveLength(2);
    const first = timeline.intervals[0];
    if (first === undefined || first.kind !== "diff") {
      throw new Error("v1→v3 interval 'diff' olmalı");
    }
    expect(first.fromRef).toBe("v1");
    expect(first.toRef).toBe("v3");
    // compare.ts gerçek davranışı: File a→File c rename, Alpha bağımsız
    // çıkarma (bkz. saf çekirdek partial testi).
    expect(first.changes.removed).toBe(1);
    expect(first.changes.renamed).toBe(1);
    expect(first.changes.apiSurfaceChanges).toBe(1);

    const second = timeline.intervals[1];
    if (second === undefined || second.kind !== "unanalyzed-interval") {
      throw new Error("v3→v5 interval 'unanalyzed-interval' olmalı");
    }
    expect((second.reasons.to ?? "").startsWith("manifest-not-json")).toBe(true);
    expect(JSON.stringify(second)).not.toContain('"changes"');
  }, 30_000);

  it("partial: şekli bozuk manifest → nokta unanalyzed, interval açık raporlu", async () => {
    const timeline = await buildArchitectureTimelineFromGit(repoRoot, {
      refs: ["v3", "v4"],
    });
    expect(timeline.points[1]).toMatchObject({
      ref: "v4",
      status: "unanalyzed",
    });
    expect(
      (timeline.points[1]?.unanalyzedReason ?? "").startsWith(
        "manifest-invalid-shape",
      ),
    ).toBe(true);
    const interval = timeline.intervals[0];
    if (interval === undefined || interval.kind !== "unanalyzed-interval") {
      throw new Error("interval 'unanalyzed-interval' olmalı");
    }
    expect((interval.reasons.to ?? "").startsWith("manifest-invalid-shape")).toBe(
      true,
    );
  });

  it("negatif: manifest hiç olmayan revizyon → manifest-not-found ile unanalyzed", async () => {
    // av1 annotated tag'i v1 ile aynı commit'i gösterir; manifest'siz bir
    // revizyon simüle etmek için çalışma ağacından manifest SİLİNMİŞ bir
    // commit'e ihtiyaç yok — commit-tree ile manifest'siz ağaçtan commit
    // üretilir ve ona range ucu açılır.
    const git = async (args: string[]): Promise<string> => {
      const result = await execFile("git", ["-C", repoRoot, ...args], {
        shell: false,
        windowsHide: true,
      });
      return result.stdout;
    };
    // Boş ağaç (git'in yerleşik empty tree nesnesi) → manifest blob'u yok.
    const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const bareSha = (
      await git(["commit-tree", EMPTY_TREE, "-p", sha3, "-m", "no-manifest"])
    ).trim();
    await git(["branch", "no-manifest", bareSha]);

    const timeline = await buildArchitectureTimelineFromGit(repoRoot, {
      range: { from: "v3", to: "no-manifest" },
    });
    expect(timeline.points.map((p) => p.ref)).toEqual(["v3", "no-manifest"]);
    const interval = timeline.intervals[0];
    if (interval === undefined || interval.kind !== "unanalyzed-interval") {
      throw new Error("interval 'unanalyzed-interval' olmalı");
    }
    expect((interval.reasons.to ?? "").startsWith("manifest-not-found")).toBe(
      true,
    );
  });

  it("partial: relativePath türü bozuk manifest → unanalyzed; kodlanmamış TypeError kaçmaz", async () => {
    // Denetim bulgusu 1 (git yolu): güvenilmez depodan gelen manifest'te
    // relativePath null ise nokta analyzed işaretlenip diff'te TypeError
    // üretmek yerine shape denetiminde yakalanır.
    const timeline = await buildArchitectureTimelineFromGit(repoRoot, {
      refs: ["v1", "v6"],
    });
    expect(timeline.points[1]).toMatchObject({
      ref: "v6",
      status: "unanalyzed",
    });
    const reason = timeline.points[1]?.unanalyzedReason ?? "";
    expect(reason.startsWith("manifest-invalid-shape")).toBe(true);
    expect(reason).toContain("relativePath");

    const interval = timeline.intervals[0];
    if (interval === undefined || interval.kind !== "unanalyzed-interval") {
      throw new Error("interval 'unanalyzed-interval' olmalı");
    }
    expect((interval.reasons.to ?? "").startsWith("manifest-invalid-shape")).toBe(
      true,
    );
    expect(JSON.stringify(interval)).not.toContain('"changes"');
  });

  it("negatif: refs modunda sampling'e takılan ref bile çözümlenemiyorsa açık hatadır", async () => {
    // Denetim bulgusu 2: yalnızca SEÇİLEN ref'ler doğrulanıyordu; aynı girdi
    // maxRevisions'a bağlı olarak ya ref-not-found ya sessiz atlama
    // gösteriyordu. Tüm ref'ler seçimden ÖNCE çözümlenir.
    await expectRejectsCode(
      () =>
        buildArchitectureTimelineFromGit(repoRoot, {
          refs: ["v1", "refs/heads/no-such-branch", "v3"],
          maxRevisions: 2,
        }),
      "compare/ref-not-found",
    );
  }, 30_000);

  it("negatif: maxRangeWalk aşımı — bounded history-range açıkça reddedilir", async () => {
    // Denetim bulgusu 3a: v1..v3 zinciri 3 commit; maxRangeWalk=2 sınırında
    // from bulunamaz → sessiz kırpma değil, timeline/invalid-range.
    await expectRejectsCode(
      () =>
        buildArchitectureTimelineFromGit(repoRoot, {
          range: { from: "v1", to: "v3" },
          maxRangeWalk: 2,
        }),
      "timeline/invalid-range",
    );
    // Tavan kırpımı: aşırı büyük sınır küçük depoda hatasız çalışır.
    const clamped = await buildArchitectureTimelineFromGit(repoRoot, {
      range: { from: "v1", to: "v3" },
      maxRangeWalk: TIMELINE_CEILINGS.maxRangeWalk + 1000,
    });
    expect(clamped.limits.maxRangeWalk).toBe(TIMELINE_CEILINGS.maxRangeWalk);
  }, 30_000);

  it("negatif: tag zinciri peel derinliği aşımı — açık ret", async () => {
    // Denetim bulgusu 3b: deep6 → deep1 → av1 zinciri peel derinlik sınırını
    // aşar; sonsuz döngü/kodlanmamış hata yerine timeline/invalid-range.
    await expectRejectsCode(
      () =>
        buildArchitectureTimelineFromGit(repoRoot, {
          range: { from: "deep6", to: "v3" },
        }),
      "timeline/invalid-range",
    );
  });

  it("paket yüzeyi: timeline çekirdeği index.ts'ten export edilir", () => {
    // Denetim bulgusu 4: compare/impact/guard deseni gibi paket index'i
    // üzerinden erişilebilir olmalı (mcp-server entegrasyon yüzeyi).
    expect(Object.keys(graphIndex)).toContain("buildArchitectureTimeline");
    expect(Object.keys(graphIndex)).toContain("buildArchitectureTimelineFromGit");
    expect(Object.keys(graphIndex)).toContain("selectSampledIndices");
    expect(Object.keys(graphIndex)).toContain("serializeSnapshotContentSet");
    expect(Object.keys(graphIndex)).toContain("TIMELINE_DEFAULTS");
    expect(Object.keys(graphIndex)).toContain("TIMELINE_CEILINGS");
  });

  it("determinizm: aynı refs iki koşum aynı timeline JSON", async () => {
    const input = { refs: ["v1", "v2", "v3"] };
    const first = await buildArchitectureTimelineFromGit(repoRoot, input);
    const second = await buildArchitectureTimelineFromGit(repoRoot, input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.points.map((p) => p.ref)).toEqual(["v1", "v2", "v3"]);
    expect(JSON.stringify(first)).not.toContain("qualityScore");
  }, 30_000);
});
