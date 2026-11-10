import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { parseArchitectureBaseline, parseArchitecturePolicy } from "../src/guard-policy-schema.js";
import { GraphRepositoryError } from "../src/errors.js";
import type { CompareContentSet, CompareEdge, CompareNode } from "../src/compare.js";
import {
  TIMELINE_BASELINE_BLOB_PATH,
  TIMELINE_POLICY_BLOB_PATH,
  buildArchitectureTimelineFromGit,
  buildTimelineViolationTrend,
  type TimelineTrendBaselineResult,
  type TimelineTrendPointInput,
  type TimelineTrendPolicyResult,
  type TimelineTrendSeries,
} from "../src/timeline.js";

/**
 * Architecture Timeline ihlal trendi testleri — sprint-6 E5, TŞ v2.1 §13/§16.
 *
 * TŞ §13 (Sayfa 12) Timeline sözleşmesi: "refs=[...] veya bounded
 * history-range için snapshot/diff özetleri hazırlanır ... analiz
 * edilmeyen aralıklar açık raporlanır" ve kırmızı çizgisi: "Ölçüler
 * 'kalite skoru' olarak tek sayıya indirgenmez". E5 dilimi, sprint-3 C7
 * çekirdeğinin açık bıraktığı "ihlal trendi" bölümünü doldurur (bkz.
 * timeline.ts başlığındaki kapsam notu): seçilen milestone noktalarının
 * HER BİRİNDEKİ içerik kümesi C2 guard kurallarıyla (no-cycles /
 * forbidden-dependency) değerlendirilir; sayılar ayrı ayrı dizi
 * (series) olarak döner — hiçbir bileşik skor üretilmez.
 *
 * Pozitif: 3 milestone → 2 diff özeti (Sprint-3 davranışı korunur) +
 * trend serileri; forbidden 0→1→0 (adımlar increasing, decreasing),
 * no-cycles 0→0→1 (adımlar flat, increasing). Git yolu geçici depoda
 * salt-okunur cat-file ile koşar.
 * Negatif: var olmayan ref ve tekrar ref açık reddedilir (trend bu
 * hataları YUTMAZ); boş/tekrarlı trend girdisi kodlu ret.
 * Partial: bir milestone'un manifest'i bozuk → interval
 * 'unanalyzed-interval' kalır VE trend değerleri o noktada null + neden
 * taşır (eksik nokta üzerinden adım/adım yön UYDURULMAZ; policy
 * dosyası yoksa/bozuksa nokta dürüstçe 'unavailable' işaretlenir).
 *
 * Kırmızı çizgiler: checkout/reset/clean yok; kalite skoru alanı YOK
 * (test assert eder); test geçici depoyu KENDİ kurar.
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

// ---------------------------------------------------------------------------
// Fixture: policy + içerik kümeleri (kimlik sözleşmesi compare ile aynı)
// ---------------------------------------------------------------------------

const POLICY_YAML = [
  "version: 1",
  "rules:",
  "  - id: layer-cycle",
  "    type: no-cycles",
  "    edgeKinds: [CALLS]",
  "    severity: error",
  "  - id: no-service-to-repository",
  "    type: forbidden-dependency",
  '    from: "**/services/**"',
  '    to: "**/repositories/**"',
  "    edgeKinds: [CALLS]",
  "    severity: error",
  "",
].join("\n");

/** Bozuk policy YAML: parseArchitecturePolicy guard/policy-yaml-invalid verir. */
const BAD_POLICY_YAML = "rules: [ bozuk yaml";

const BASELINE_SUPPRESS_CYCLE_YAML = [
  "version: 1",
  "suppressions:",
  "  - ruleId: layer-cycle",
  "    reason: bilinen teknik borç",
  "    owner: mimari-ekip",
  "    date: 2026-01-01",
  '    from: "**/services/**"',
  "",
].join("\n");

function moduleNode(
  qualifiedName: string,
  relativePath: string,
): CompareNode {
  return {
    kind: "Module",
    qualifiedName,
    relativePath,
    attributes: {},
  };
}

function identityOf(node: CompareNode): CompareNode {
  return {
    kind: node.kind,
    qualifiedName: node.qualifiedName,
    ...(node.relativePath === undefined ? {} : { relativePath: node.relativePath }),
  };
}

function callsEdge(from: CompareNode, to: CompareNode): CompareEdge {
  return {
    kind: "CALLS",
    from: identityOf(from),
    to: identityOf(to),
    resolution: "heuristic",
  };
}

const BILLING = moduleNode("services.Billing", "src/services/billing.ts");
const CORE = moduleNode("core.Helper", "src/core/helper.ts");
const REPO = moduleNode("repositories.BillingDb", "src/repositories/billing-db.ts");
const UI = moduleNode("ui.Panel", "src/ui/panel.ts");

/** m1: services→core kenarı; iki kural için de ihlal yok. */
function setM1(): CompareContentSet {
  return { nodes: [BILLING, CORE], edges: [callsEdge(BILLING, CORE)] };
}

/** m2: services→repositories CALLS eklendi → forbidden ihlali 1. */
function setM2(): CompareContentSet {
  return {
    nodes: [BILLING, CORE, REPO],
    edges: [callsEdge(BILLING, CORE), callsEdge(BILLING, REPO)],
  };
}

/** m3: services↔ui karşılıklı CALLS → döngü 1; forbidden kenarı kalktı → 0. */
function setM3(): CompareContentSet {
  return {
    nodes: [BILLING, CORE, REPO, UI],
    edges: [callsEdge(BILLING, CORE), callsEdge(BILLING, UI), callsEdge(UI, BILLING)],
  };
}

function analyzedPolicy(): TimelineTrendPolicyResult {
  return { status: "ok", policy: parseArchitecturePolicy(POLICY_YAML) };
}

function noBaseline(): TimelineTrendBaselineResult {
  return { status: "missing" };
}

function contentOf(set: CompareContentSet): TimelineTrendPointInput["content"] {
  return { status: "analyzed", contentSet: set };
}

function seriesOf(
  trend: ReturnType<typeof buildTimelineViolationTrend>,
  metric: string,
): TimelineTrendSeries {
  const series = trend.series.find((entry) => entry.metric === metric);
  if (series === undefined) {
    throw new Error(`'${metric}' serisi trend çıktısında yok`);
  }
  return series;
}

// ---------------------------------------------------------------------------
// Saf çekirdek: buildTimelineViolationTrend
// ---------------------------------------------------------------------------

describe("timeline ihlal trendi çekirdeği — buildTimelineViolationTrend (saf)", () => {
  it("pozitif: 3 milestone → nokta başına ihlal sayıları + ayrı seriler; adım yönleri artış/azalış/düz", () => {
    const trend = buildTimelineViolationTrend({
      points: [
        { ref: "m1", content: contentOf(setM1()), policy: analyzedPolicy(), baseline: noBaseline() },
        { ref: "m2", content: contentOf(setM2()), policy: analyzedPolicy(), baseline: noBaseline() },
        { ref: "m3", content: contentOf(setM3()), policy: analyzedPolicy(), baseline: noBaseline() },
      ],
    });

    // Nokta değerlendirmeleri: hepsi evaluated; kural sayısı 2.
    expect(trend.points).toHaveLength(3);
    expect(trend.evaluatedPoints).toBe(3);
    expect(trend.unavailablePoints).toBe(0);
    for (const point of trend.points) {
      expect(point.status).toBe("evaluated");
      if (point.status !== "evaluated") continue;
      expect(point.evaluatedRules).toBe(2);
    }

    // TŞ §13 kırmızı çizgisi: bileşik kalite skoru YOK; trendler ayrı diziler.
    const serialized = JSON.stringify(trend);
    expect(serialized).not.toContain("qualityScore");
    expect(serialized).not.toContain('"score"');
    expect(trend.series).toHaveLength(2);
    expect(trend.series.map((entry) => entry.metric)).toEqual([
      "no-cycles",
      "forbidden-dependency",
    ]);

    // no-cycles: 0 → 0 → 1 (adımlar: flat, increasing; uçlar: increasing).
    const cycles = seriesOf(trend, "no-cycles");
    expect(cycles.values.map((value) => value.count)).toEqual([0, 0, 1]);
    expect(cycles.steps.map((step) => step.direction)).toEqual(["flat", "increasing"]);
    expect(cycles.direction).toBe("increasing");
    expect(cycles.steps[0]).toMatchObject({ fromRef: "m1", toRef: "m2" });
    expect(cycles.steps[1]).toMatchObject({
      fromRef: "m2",
      toRef: "m3",
      fromCount: 0,
      toCount: 1,
    });

    // forbidden-dependency: 0 → 1 → 0 (adımlar: increasing, decreasing).
    const forbidden = seriesOf(trend, "forbidden-dependency");
    expect(forbidden.values.map((value) => value.count)).toEqual([0, 1, 0]);
    expect(forbidden.steps.map((step) => step.direction)).toEqual([
      "increasing",
      "decreasing",
    ]);
    // Uç karşılaştırması belgelenmiş semantik: ilk kullanılabilir 0, son 0 → flat.
    expect(forbidden.direction).toBe("flat");

    // Baseline yok: baskılanmış sayılar 0; aktif sayılar yukarıdaki değerler.
    const third = trend.points[2];
    if (third === undefined || third.status !== "evaluated") {
      throw new Error("m3 noktası evaluated olmalı");
    }
    expect(third.noCyclesViolations).toBe(1);
    expect(third.noCyclesSuppressed).toBe(0);
    expect(third.forbiddenDependencyViolations).toBe(0);
    expect(third.forbiddenDependencySuppressed).toBe(0);
  });

  it("pozitif: baseline suppression aktif sayıdan AYRI raporlanır (no-cycles 1 → aktif 0 + baskılanmış 1)", () => {
    const trend = buildTimelineViolationTrend({
      points: [
        { ref: "m3", content: contentOf(setM3()), policy: analyzedPolicy(), baseline: noBaseline() },
        {
          ref: "m3b",
          content: contentOf(setM3()),
          policy: analyzedPolicy(),
          baseline: {
            status: "ok",
            baseline: parseArchitectureBaseline(BASELINE_SUPPRESS_CYCLE_YAML),
          },
        },
      ],
    });
    const without = trend.points[0];
    const withSuppression = trend.points[1];
    if (
      without === undefined ||
      withSuppression === undefined ||
      without.status !== "evaluated" ||
      withSuppression.status !== "evaluated"
    ) {
      throw new Error("iki nokta da evaluated olmalı");
    }
    expect(without.noCyclesViolations).toBe(1);
    expect(without.noCyclesSuppressed).toBe(0);
    // Suppression bulguyu baskılar: aktif sayı düşer, baskılanmış AYRI taşınır.
    expect(withSuppression.noCyclesViolations).toBe(0);
    expect(withSuppression.noCyclesSuppressed).toBe(1);
    const cycles = seriesOf(trend, "no-cycles");
    expect(cycles.values.map((value) => value.count)).toEqual([1, 0]);
    expect(cycles.steps.map((step) => step.direction)).toEqual(["decreasing"]);
  });

  it("partial: analiz edilemeyen nokta → trend değeri null + neden; eksik nokta üzerinden adım ÜRETİLMEZ", () => {
    const trend = buildTimelineViolationTrend({
      points: [
        { ref: "m1", content: contentOf(setM1()), policy: analyzedPolicy(), baseline: noBaseline() },
        {
          ref: "bad",
          content: { status: "unanalyzed", reason: "manifest-not-json: beklenmeyen simge" },
          policy: analyzedPolicy(),
          baseline: noBaseline(),
        },
        { ref: "m3", content: contentOf(setM3()), policy: analyzedPolicy(), baseline: noBaseline() },
      ],
    });

    expect(trend.evaluatedPoints).toBe(2);
    expect(trend.unavailablePoints).toBe(1);
    expect(trend.points[1]).toMatchObject({
      ref: "bad",
      status: "unavailable",
      reason: "manifest-not-json: beklenmeyen simge",
    });

    // Eksik değerler null + neden taşır; sayı UYDURULMAZ.
    const cycles = seriesOf(trend, "no-cycles");
    expect(cycles.values[1]).toMatchObject({
      index: 1,
      ref: "bad",
      count: null,
      reason: "manifest-not-json: beklenmeyen simge",
    });
    // m1→bad ve bad→m3 adımları YOK (eksik nokta üzerinden yön uydurulmaz);
    // yalnızca iki kullanılabilir uç arasındaki tek adım var.
    expect(cycles.steps).toHaveLength(1);
    expect(cycles.steps[0]).toMatchObject({ fromIndex: 0, toIndex: 2 });
    expect(cycles.direction).toBe("increasing"); // m1 (0) → m3 (1), uçlar

    const forbidden = seriesOf(trend, "forbidden-dependency");
    expect(forbidden.steps).toHaveLength(1);
    expect(forbidden.direction).toBe("flat"); // m1 (0) → m3 (0)
  });

  it("partial: policy dosyası yoksa nokta 'unavailable' + policy-not-found nedeni taşır (sıfır ihlal UYDURULMAZ)", () => {
    const trend = buildTimelineViolationTrend({
      points: [
        { ref: "m1", content: contentOf(setM1()), policy: analyzedPolicy(), baseline: noBaseline() },
        {
          ref: "nopolicy",
          content: contentOf(setM2()),
          policy: { status: "missing" },
          baseline: noBaseline(),
        },
      ],
    });
    expect(trend.points[1]).toMatchObject({
      ref: "nopolicy",
      status: "unavailable",
      reason: `policy-not-found: ${TIMELINE_POLICY_BLOB_PATH}`,
    });
    const cycles = seriesOf(trend, "no-cycles");
    expect(cycles.values[1]?.count).toBeNull();
    expect(cycles.steps).toHaveLength(0);
    expect(cycles.direction).toBe("undetermined"); // kullanılabilir değer < 2
  });

  it("partial: policy YAML bozuksa nokta 'unavailable' + policy-invalid nedeni; baseline bozuğu ayrı neden taşır", () => {
    const trend = buildTimelineViolationTrend({
      points: [
        {
          ref: "badpolicy",
          content: contentOf(setM1()),
          policy: { status: "invalid", reason: "guard/policy-yaml-invalid: YAML çözümlenemedi" },
          baseline: noBaseline(),
        },
        {
          ref: "badbaseline",
          content: contentOf(setM1()),
          policy: analyzedPolicy(),
          baseline: { status: "invalid", reason: "guard/baseline-yaml-invalid: YAML çözümlenemedi" },
        },
      ],
    });
    expect(trend.points[0]).toMatchObject({
      ref: "badpolicy",
      status: "unavailable",
      reason: "policy-invalid: guard/policy-yaml-invalid: YAML çözümlenemedi",
    });
    expect(trend.points[1]).toMatchObject({
      ref: "badbaseline",
      status: "unavailable",
      reason: "baseline-invalid: guard/baseline-yaml-invalid: YAML çözümlenemedi",
    });
    expect(trend.evaluatedPoints).toBe(0);
    expect(trend.unavailablePoints).toBe(2);
    expect(trend.series.every((series) => series.direction === "undetermined")).toBe(
      true,
    );
  });

  it("partial: katalog dışı node türü → içerik sözleşme ihlali coded 'unavailable' (sessiz sayı yok)", () => {
    const bogusKind: CompareContentSet = {
      // Katalog dışı tür çalışma zamanında güvenilmez blob verisidir; statik
      // türü kasıtlı olarak ihlal eden cast mevcut timeline test deseniyle
      // aynıdır (bkz. badRelativePath: null as unknown as string).
      nodes: [{ ...BILLING, kind: "Bogus" as unknown as CompareNode["kind"] }],
      edges: [],
    };
    const trend = buildTimelineViolationTrend({
      points: [
        { ref: "m1", content: contentOf(setM1()), policy: analyzedPolicy(), baseline: noBaseline() },
        { ref: "bogus", content: contentOf(bogusKind), policy: analyzedPolicy(), baseline: noBaseline() },
      ],
    });
    expect(trend.points[1]).toMatchObject({ ref: "bogus", status: "unavailable" });
    const reason = trend.points[1]?.status === "unavailable" ? trend.points[1].reason : "";
    expect(reason).toContain("compare/unknown-node-kind");
    // Güvenilmez nokta adımı kirletmez: tek kullanılabilir değer → yön yok.
    expect(trend.series.every((series) => series.steps.length === 0)).toBe(true);
    expect(trend.series.every((series) => series.direction === "undetermined")).toBe(
      true,
    );
  });

  it("negatif: boş nokta listesi ve tekrar ref açık kodla reddedilir", () => {
    expectThrowsCode(() => buildTimelineViolationTrend({ points: [] }), "timeline/trend-invalid-input");
    expectThrowsCode(
      () =>
        buildTimelineViolationTrend({
          points: [
            { ref: "m1", content: contentOf(setM1()), policy: analyzedPolicy(), baseline: noBaseline() },
            { ref: "m1", content: contentOf(setM2()), policy: analyzedPolicy(), baseline: noBaseline() },
          ],
        }),
      "timeline/trend-invalid-input",
    );
    // Biçimsiz ref (denetim bulgusu kilidi): assertValidGitRef'in
    // compare/invalid-ref'i AÇIK ürün hatası olarak yükselir — sessiz
    // 'unavailable' noktasına DÖNÜŞTÜRÜLMEZ ("trend hataları YUTMAZ"
    // sözleşmesi ref biçim katmanında da geçerlidir).
    expectThrowsCode(
      () =>
        buildTimelineViolationTrend({
          points: [
            {
              ref: "-kotu-ref",
              content: contentOf(setM1()),
              policy: analyzedPolicy(),
              baseline: noBaseline(),
            },
          ],
        }),
      "compare/invalid-ref",
    );
  });

  it("determinizm: aynı girdi iki koşum birebir aynı JSON", () => {
    const input = {
      points: [
        { ref: "m1", content: contentOf(setM1()), policy: analyzedPolicy(), baseline: noBaseline() },
        { ref: "m2", content: contentOf(setM2()), policy: analyzedPolicy(), baseline: noBaseline() },
        { ref: "m3", content: contentOf(setM3()), policy: analyzedPolicy(), baseline: noBaseline() },
      ],
    };
    expect(JSON.stringify(buildTimelineViolationTrend(input))).toBe(
      JSON.stringify(buildTimelineViolationTrend(input)),
    );
  });
});

// ---------------------------------------------------------------------------
// Git spawn katmanı: policy/baseline blob'ları ref'ten okunur
// ---------------------------------------------------------------------------

const BROKEN_JSON_MANIFEST = '{ "nodes": [ bozuk json';

describe("timeline ihlal trendi git katmanı — geçici depo (salt-okunur)", () => {
  let repoRoot: string;

  beforeAll(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "causoryn-trend-"));
    const git = async (args: string[]): Promise<string> => {
      const result = await execFile("git", ["-C", repoRoot, ...args], {
        shell: false,
        windowsHide: true,
      });
      return result.stdout;
    };
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "Causoryn Trend Test"]);
    await git(["config", "user.email", "trend-test@causoryn.invalid"]);
    await git(["config", "core.autocrlf", "false"]);

    const manifestPath = path.join(repoRoot, ".causoryn", "architecture-snapshot.json");
    const policyPath = path.join(repoRoot, ".causoryn", "architecture.rules.yaml");
    await mkdir(path.join(repoRoot, ".causoryn"), { recursive: true });

    // m1/m2/m3: manifest + policy birlikte commit'lenir (aynı policy içeriği).
    const milestones: readonly [string, string][] = [
      ["trend-m1", JSON.stringify(setM1(), null, 2)],
      ["trend-m2", JSON.stringify(setM2(), null, 2)],
      ["trend-m3", JSON.stringify(setM3(), null, 2)],
    ];
    for (const [tag, manifest] of milestones) {
      await writeFile(manifestPath, manifest, "utf8");
      await writeFile(policyPath, POLICY_YAML, "utf8");
      await git(["add", "-A"]);
      await git(["commit", "-m", `milestone ${tag}`]);
      await git(["tag", tag]);
    }

    // policy dosyası SİLİNMİŞ milestone: içerik var, trend değerlendirilemez.
    await writeFile(manifestPath, JSON.stringify(setM2(), null, 2), "utf8");
    await rm(policyPath, { force: true });
    await git(["add", "-A"]);
    await git(["commit", "-m", "milestone trend-nopolicy (policy silindi)"]);
    await git(["tag", "trend-nopolicy"]);

    // bozuk policy YAML taşıyan milestone.
    await writeFile(policyPath, BAD_POLICY_YAML, "utf8");
    await git(["add", "-A"]);
    await git(["commit", "-m", "milestone trend-badpolicy (policy bozuk)"]);
    await git(["tag", "trend-badpolicy"]);

    // manifest'i bozuk JSON olan milestone: policy geçerli geri gelir.
    await writeFile(policyPath, POLICY_YAML, "utf8");
    await writeFile(manifestPath, BROKEN_JSON_MANIFEST, "utf8");
    await git(["add", "-A"]);
    await git(["commit", "-m", "milestone trend-bad (manifest bozuk)"]);
    await git(["tag", "trend-bad"]);

    if ((await git(["tag", "--list"])).split("\n").filter((line) => line.length > 0).length !== 6) {
      throw new Error("test kurulumunda 6 tag bekleniyordu");
    }
    // Hook bütçesi: timeline.test.ts:587 hook'uyla aynı kurulum sınıfı
    // (~25 senkron git çağrısı); tam süitte 30 s vitest hookTimeout'unu
    // aşabildiği GÖZLEMLENDİ (bu oturumda "Failed Suites — timeline-trend
    // git katmanı", 2026-11-09). 120 s, kardeş dosyanın hook bütçesiyle aynı.
  }, 120_000);

  afterAll(async () => {
    if (repoRoot !== undefined) {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("pozitif: 3 milestone → 2 diff özeti (Sprint-3 korunur) + ihlal trendi artış/azalış yönleri", async () => {
    const timeline = await buildArchitectureTimelineFromGit(repoRoot, {
      refs: ["trend-m1", "trend-m2", "trend-m3"],
    });

    // Sprint-3 davranışı KIRILMAZ: diff aralıkları aynen.
    expect(timeline.requestedPoints).toBe(3);
    expect(timeline.analyzedPoints).toBe(3);
    expect(timeline.intervals).toHaveLength(2);
    expect(timeline.intervals.every((interval) => interval.kind === "diff")).toBe(true);

    // E5: trend çıktısı aynı çıktıda ayrı bölüm olarak taşınır.
    const trend = timeline.trend;
    expect(trend.evaluatedPoints).toBe(3);
    expect(trend.unavailablePoints).toBe(0);

    const cycles = trend.series.find((entry) => entry.metric === "no-cycles");
    const forbidden = trend.series.find((entry) => entry.metric === "forbidden-dependency");
    expect(cycles).toBeDefined();
    expect(forbidden).toBeDefined();
    expect(cycles?.values.map((value) => value.count)).toEqual([0, 0, 1]);
    expect(cycles?.steps.map((step) => step.direction)).toEqual(["flat", "increasing"]);
    expect(cycles?.direction).toBe("increasing");
    expect(forbidden?.values.map((value) => value.count)).toEqual([0, 1, 0]);
    expect(forbidden?.steps.map((step) => step.direction)).toEqual([
      "increasing",
      "decreasing",
    ]);
    expect(forbidden?.direction).toBe("flat");

    const serialized = JSON.stringify(timeline);
    expect(serialized).not.toContain("qualityScore");
    expect(serialized).not.toContain('"score"');

    // Byte-determinizm (TŞ §8 invariant vi): aynı girdi iki koşum aynı JSON.
    const repeat = await buildArchitectureTimelineFromGit(repoRoot, {
      refs: ["trend-m1", "trend-m2", "trend-m3"],
    });
    expect(JSON.stringify(repeat)).toBe(JSON.stringify(timeline));
  }, 30_000);

  it("pozitif: blob yolları sözleşmesi — policy/baseline yolları .causoryn altında sabit", () => {
    expect(TIMELINE_POLICY_BLOB_PATH).toBe(".causoryn/architecture.rules.yaml");
    expect(TIMELINE_BASELINE_BLOB_PATH).toBe(".causoryn/architecture.baseline.yaml");
  });

  it("partial: bozuk manifest milestone → unanalyzed-interval KORUNUR + trend eksik noktası dürüst işaretli", async () => {
    const timeline = await buildArchitectureTimelineFromGit(repoRoot, {
      refs: ["trend-m1", "trend-bad"],
    });
    expect(timeline.points[1]).toMatchObject({ ref: "trend-bad", status: "unanalyzed" });
    expect(timeline.intervals).toHaveLength(1);
    expect(timeline.intervals[0]?.kind).toBe("unanalyzed-interval");

    expect(timeline.trend.unavailablePoints).toBe(1);
    const cycles = timeline.trend.series.find(
      (entry) => entry.metric === "no-cycles",
    );
    expect(cycles?.values[1]).toMatchObject({
      index: 1,
      ref: "trend-bad",
      count: null,
    });
    expect(
      ((cycles?.values[1] as { reason?: string }).reason ?? "").startsWith(
        "manifest-not-json",
      ),
    ).toBe(true);
    // Tek kullanılabilir değer: adım yok, yön belirlenemez (uydurma yok).
    expect(cycles?.steps).toHaveLength(0);
    expect(cycles?.direction).toBe("undetermined");
  }, 30_000);

  it("partial: policy silinmiş / bozuk policy milestone → nokta unavailable, sayı uydurulmaz", async () => {
    const noPolicy = await buildArchitectureTimelineFromGit(repoRoot, {
      refs: ["trend-m2", "trend-nopolicy"],
    });
    expect(noPolicy.trend.points[1]).toMatchObject({
      ref: "trend-nopolicy",
      status: "unavailable",
    });
    const reason =
      noPolicy.trend.points[1]?.status === "unavailable"
        ? noPolicy.trend.points[1].reason
        : "";
    expect(reason.startsWith("policy-not-found")).toBe(true);

    const badPolicy = await buildArchitectureTimelineFromGit(repoRoot, {
      refs: ["trend-m2", "trend-badpolicy"],
    });
    expect(badPolicy.trend.points[1]).toMatchObject({
      ref: "trend-badpolicy",
      status: "unavailable",
    });
    const badReason =
      badPolicy.trend.points[1]?.status === "unavailable"
        ? badPolicy.trend.points[1].reason
        : "";
    expect(badReason.startsWith("policy-invalid")).toBe(true);
    expect(badReason).toContain("guard/policy-yaml-invalid");
  }, 30_000);

  it("negatif: geçersiz milestone (var olmayan ref / tekrar ref) açık reddedilir — trend hataları YUTMAZ", async () => {
    await expectRejectsCode(
      () =>
        buildArchitectureTimelineFromGit(repoRoot, {
          refs: ["trend-m1", "no-such-milestone"],
        }),
      "compare/ref-not-found",
    );
    await expectRejectsCode(
      () =>
        buildArchitectureTimelineFromGit(repoRoot, {
          refs: ["trend-m1", "trend-m1"],
        }),
      "timeline/duplicate-ref",
    );
  }, 30_000);
});
