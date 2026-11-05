import { describe, expect, it } from "vitest";

import type {
  EdgeKind,
  GraphEdge,
  GraphNode,
  NodeKind,
  SnapshotGraph,
} from "@causoryn/domain";

import {
  compileGuardGlob,
  findOrphanSuppressions,
  findViolations,
  GuardError,
  MAX_GLOB_LENGTH,
  MAX_GLOB_WILDCARDS,
  parseArchitectureBaseline,
  parseArchitecturePolicy,
  type ArchitectureBaseline,
  type ArchitecturePolicy,
} from "../src/index.js";

/**
 * causoryn_check_architecture çekirdek testleri — TŞ v2.1 §12 (Architecture
 * Guard ve policy DSL), sprint-3 C2. Pozitif: döngülü fixture → no-cycles
 * bulgusu; yasak bağımlılık → forbidden bulgusu; TŞ §12'deki örnek policy
 * YAML'ı birebir parse edilir. Negatif: geçersiz YAML/şema açık reddi,
 * zorunlu suppression alanları (reason/owner/date). Partial: kısmen
 * suppression'lı bulgu listesi, suppression reason'u çıktıda taşınır.
 *
 * Determinizm: aynı giriş → aynı çıktı; node/edge dizi sırası sonucu
 * etkilemez; girdiler mutate edilmez.
 */

// ---------------------------------------------------------------------------
// Fixture yardımcıları
// ---------------------------------------------------------------------------

const EMPTY_BASELINE = parseArchitectureBaseline(
  "version: 1\nsuppressions: []\n",
);

/** Yalnızca Cart→HtmlReportWriter ihlalini baskılayan baseline (partial senaryo). */
const CART_BASELINE = parseArchitectureBaseline(
  [
    "version: 1",
    "suppressions:",
    "  - ruleId: domain-must-not-import-infrastructure",
    '    from: "**/Cart/**"',
    '    to: "**/HtmlReportWriter*"',
    '    reason: "Legacy rapor yazarı refactor edilene kadar geçici istisna"',
    "    owner: alice",
    "    date: 2026-11-01",
    "",
  ].join("\n"),
);

function node(
  id: string,
  kind: NodeKind,
  qualifiedName: string,
  relativePath?: string,
): GraphNode {
  return {
    id,
    kind,
    qualifiedName,
    ...(relativePath === undefined
      ? {}
      : {
          location: {
            relativePath,
            startLine: 1,
            endLine: 1,
            sourceHash: `sha256:${id}`,
          },
        }),
    attributes: {},
  };
}

function edge(
  id: string,
  from: string,
  to: string,
  kind: EdgeKind,
  evidenceIds: readonly string[] = [`ev-${id}`],
): GraphEdge {
  return { id, from, to, kind, resolution: "verified", evidenceIds };
}

function snapshot(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  id = "snapshot:guard-fixture",
): SnapshotGraph {
  return {
    meta: {
      id,
      workspaceId: "ws_guard",
      revision: { id: "rev-1", sequence: 1 },
      configHash: "cfg-guard",
      analyzerFingerprint: "fp-guard",
      state: "ready",
      createdAt: "2026-11-05T00:00:00.000Z",
    },
    nodes: [...nodes],
    edges: [...edges],
    evidence: [],
  };
}

/** A→B→C→A döngüsü (Module node'ları, path tabanlı eşleşme). */
function cyclicModuleSnapshot(): SnapshotGraph {
  return snapshot(
    [
      node("n-a", "Module", "App.A", "src/A/ModuleA.ts"),
      node("n-b", "Module", "App.B", "src/B/ModuleB.ts"),
      node("n-c", "Module", "App.C", "src/C/ModuleC.ts"),
    ],
    [
      edge("e-1", "n-a", "n-b", "CALLS"),
      edge("e-2", "n-b", "n-c", "CALLS"),
      edge("e-3", "n-c", "n-a", "CALLS"),
      edge("e-4", "n-a", "n-c", "REFERENCES"),
    ],
  );
}

const NO_CYCLES_POLICY = parseArchitecturePolicy(
  [
    "version: 1",
    "rules:",
    "  - id: modules-must-be-acyclic",
    "    type: no-cycles",
    "    scope: modules",
    "    severity: error",
    "",
  ].join("\n"),
);

const FORBIDDEN_POLICY = parseArchitecturePolicy(
  [
    "version: 1",
    "rules:",
    "  - id: domain-must-not-import-infrastructure",
    "    type: forbidden-dependency",
    '    from: "**/Domain/**"',
    '    to: "**/Infrastructure/**"',
    "    edgeKinds: [IMPORTS, DEPENDS_ON]",
    "    severity: error",
    "",
  ].join("\n"),
);

function forbiddenFixtureSnapshot(): SnapshotGraph {
  return snapshot(
    [
      node("n-d1", "Class", "App.Domain.OrdersService", "src/Domain/Orders/OrdersService.ts"),
      node("n-d2", "Class", "App.Domain.Cart.CartService", "src/Domain/Cart/CartService.ts"),
      node("n-i1", "Class", "App.Infrastructure.Persistence.OrdersRepository", "src/Infrastructure/Persistence/OrdersRepository.ts"),
      node("n-i2", "Class", "App.Infrastructure.Reporting.HtmlReportWriter", "src/Infrastructure/Reporting/HtmlReportWriter.ts"),
    ],
    [
      edge("ed-1", "n-d1", "n-i1", "IMPORTS"),
      edge("ed-2", "n-d2", "n-i2", "IMPORTS"),
    ],
  );
}

function expectGuardError(code: string, run: () => unknown): GuardError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `beklenen GuardError(${code}) fırlatılmadı`).toBeInstanceOf(
    GuardError,
  );
  const guardError = caught as GuardError;
  expect(guardError.code).toBe(code);
  return guardError;
}

// ---------------------------------------------------------------------------
// Policy DSL şeması — pozitif
// ---------------------------------------------------------------------------

describe("parseArchitecturePolicy", () => {
  it("TŞ §12'deki örnek policy YAML'ını birebir parse eder", () => {
    const policy = parseArchitecturePolicy(
      [
        "version: 1",
        "rules:",
        "  - id: modules-must-be-acyclic",
        "    type: no-cycles",
        "    scope: modules",
        "    severity: error",
        "  - id: domain-must-not-import-infrastructure",
        "    type: forbidden-dependency",
        '    from: "**/Domain/**"',
        '    to: "**/Infrastructure/**"',
        "    edgeKinds: [IMPORTS, DEPENDS_ON]",
        "    severity: error",
        "  - id: api-must-not-call-db-directly",
        "    type: forbidden-dependency",
        '    from: "**/Api/**"',
        '    to: "**/Infrastructure/**Repository*"',
        "    edgeKinds: [CALLS, REFERENCES]",
        "    severity: warning",
        "",
      ].join("\n"),
    );

    expect(policy.version).toBe(1);
    expect(policy.rules).toHaveLength(3);

    const noCycles = policy.rules[0];
    expect(noCycles?.type).toBe("no-cycles");
    expect(noCycles?.id).toBe("modules-must-be-acyclic");
    expect(noCycles?.severity).toBe("error");
    if (noCycles?.type === "no-cycles") {
      expect(noCycles.scope).toBe("modules");
      // Varsayılan kenar türleri: CALLS/IMPORTS (TŞ: Tarjan SCC bu kenarlar üzerinde).
      expect(noCycles.edgeKinds).toEqual(["CALLS", "IMPORTS"]);
    }

    const forbidden = policy.rules[1];
    expect(forbidden?.severity).toBe("error");
    if (forbidden?.type === "forbidden-dependency") {
      expect(forbidden.from.source).toBe("**/Domain/**");
      expect(forbidden.to.source).toBe("**/Infrastructure/**");
      expect(forbidden.edgeKinds).toEqual(["IMPORTS", "DEPENDS_ON"]);
    }

    expect(policy.rules[2]?.severity).toBe("warning");
  });

  it("no-cycles kuralında edgeKinds belirtilirse açık liste kullanılır", () => {
    const policy = parseArchitecturePolicy(
      [
        "version: 1",
        "rules:",
        "  - id: classes-must-not-inherit-cyclically",
        "    type: no-cycles",
        "    edgeKinds: [INHERITS]",
        "    severity: warning",
        "",
      ].join("\n"),
    );
    const rule = policy.rules[0];
    if (rule?.type === "no-cycles") {
      expect(rule.edgeKinds).toEqual(["INHERITS"]);
      // scope belirtilmediğinde varsayılan "all".
      expect(rule.scope).toBe("all");
    } else {
      expect.unreachable("kural türü no-cycles olmalı");
    }
  });

  it("boş rules dizisi kabul edilir (hiçbir şey kontrol etmeyen politika)", () => {
    const policy = parseArchitecturePolicy("version: 1\nrules: []\n");
    expect(policy.rules).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Policy DSL şeması — negatif (açık reddi)
// ---------------------------------------------------------------------------

describe("parseArchitecturePolicy reddi", () => {
  it("geçersiz YAML sözdizimi → guard/policy-yaml-invalid", () => {
    expectGuardError("guard/policy-yaml-invalid", () =>
      parseArchitecturePolicy("version: 1\nrules:\n  - {id: a, type: no-cycles"),
    );
  });

  it("bilinmeyen kural türü → guard/policy-invalid", () => {
    const error = expectGuardError("guard/policy-invalid", () =>
      parseArchitecturePolicy(
        [
          "version: 1",
          "rules:",
          "  - id: r1",
          "    type: magic-rule",
          "    severity: error",
          "",
        ].join("\n"),
      ),
    );
    expect(error.message).toContain("type");
  });

  it("eksik severity → guard/policy-invalid", () => {
    expectGuardError("guard/policy-invalid", () =>
      parseArchitecturePolicy(
        [
          "version: 1",
          "rules:",
          "  - id: r1",
          "    type: no-cycles",
          "",
        ].join("\n"),
      ),
    );
  });

  it("şema dışı severity ('critical') → guard/policy-invalid", () => {
    expectGuardError("guard/policy-invalid", () =>
      parseArchitecturePolicy(
        [
          "version: 1",
          "rules:",
          "  - id: r1",
          "    type: no-cycles",
          "    severity: critical",
          "",
        ].join("\n"),
      ),
    );
  });

  it("bilinmeyen üst düzey anahtar → guard/policy-invalid (strict)", () => {
    expectGuardError("guard/policy-invalid", () =>
      parseArchitecturePolicy(
        [
          "version: 1",
          "rules: []",
          "unexpectedTopLevel: true",
          "",
        ].join("\n"),
      ),
    );
  });

  it("kural içinde yazım hatası alanı ('scop') → guard/policy-invalid (strict)", () => {
    expectGuardError("guard/policy-invalid", () =>
      parseArchitecturePolicy(
        [
          "version: 1",
          "rules:",
          "  - id: r1",
          "    type: no-cycles",
          "    severity: error",
          "    scop: modules",
          "",
        ].join("\n"),
      ),
    );
  });

  it("duplicate rule id → guard/policy-invalid", () => {
    expectGuardError("guard/policy-invalid", () =>
      parseArchitecturePolicy(
        [
          "version: 1",
          "rules:",
          "  - id: r1",
          "    type: no-cycles",
          "    severity: error",
          "  - id: r1",
          "    type: no-cycles",
          "    severity: warning",
          "",
        ].join("\n"),
      ),
    );
  });

  it("version: 2 → guard/policy-invalid", () => {
    expectGuardError("guard/policy-invalid", () =>
      parseArchitecturePolicy(
        [
          "version: 2",
          "rules:",
          "  - id: r1",
          "    type: no-cycles",
          "    severity: error",
          "",
        ].join("\n"),
      ),
    );
  });

  it("forbidden-dependency'den edgeKinds eksik → guard/policy-invalid", () => {
    expectGuardError("guard/policy-invalid", () =>
      parseArchitecturePolicy(
        [
          "version: 1",
          "rules:",
          "  - id: r1",
          "    type: forbidden-dependency",
          '    from: "**/A/**"',
          '    to: "**/B/**"',
          "    severity: error",
          "",
        ].join("\n"),
      ),
    );
  });

  it("EDGE_KINDS dışında kenar türü → guard/policy-invalid", () => {
    expectGuardError("guard/policy-invalid", () =>
      parseArchitecturePolicy(
        [
          "version: 1",
          "rules:",
          "  - id: r1",
          "    type: forbidden-dependency",
          '    from: "**/A/**"',
          '    to: "**/B/**"',
          "    edgeKinds: [FRIENDS_WITH]",
          "    severity: error",
          "",
        ].join("\n"),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Glob güvenliği (ReDoS kırmızı çizgisi: karmaşık desen kotası + uzunluk sınırı)
// ---------------------------------------------------------------------------

describe("compileGuardGlob güvenlik sınırları", () => {
  it("uzunluk sınırını aşan desen → guard/pattern-too-long", () => {
    expect("*".length).toBeGreaterThan(0);
    const longPattern = "a".repeat(MAX_GLOB_LENGTH + 1);
    expectGuardError("guard/pattern-too-long", () =>
      compileGuardGlob(longPattern),
    );
    // Sınırın altındaki desen reddedilmez.
    expect(() => compileGuardGlob("a".repeat(MAX_GLOB_LENGTH))).not.toThrow();
  });

  it("wildcard kotasını aşan desen → guard/pattern-too-complex", () => {
    const manyWildcards = "a*".repeat(MAX_GLOB_WILDCARDS + 1);
    expect(manyWildcards.length).toBeLessThanOrEqual(MAX_GLOB_LENGTH);
    expectGuardError("guard/pattern-too-complex", () =>
      compileGuardGlob(manyWildcards),
    );
  });

  it("desteklenmeyen glob söz dizimi → guard/pattern-unsupported-syntax", () => {
    expectGuardError("guard/pattern-unsupported-syntax", () =>
      compileGuardGlob("**/{a,b}/**"),
    );
    expectGuardError("guard/pattern-unsupported-syntax", () =>
      compileGuardGlob("src\\Domain\\**"),
    );
    expectGuardError("guard/pattern-unsupported-syntax", () =>
      compileGuardGlob("**/[a-z]/**"),
    );
    expectGuardError("guard/pattern-unsupported-syntax", () =>
      compileGuardGlob("***"),
    );
  });

  it("** dizinler arası, * segment içi, ? tek karakter", () => {
    const repo = compileGuardGlob("**/Infrastructure/**Repository*");
    expect(repo.matches("src/Infrastructure/Persistence/OrdersRepository.ts")).toBe(true);
    expect(repo.matches("src/Domain/Orders/OrdersService.ts")).toBe(false);
    // Kök dizin altında da eşleşir (TŞ normalizasyon kararı: `**/` öneki opsiyonel).
    expect(repo.matches("Infrastructure/OrdersRepository.ts")).toBe(true);

    const single = compileGuardGlob("src/*/Repo.ts");
    expect(single.matches("src/a/Repo.ts")).toBe(true);
    expect(single.matches("src/a/b/Repo.ts")).toBe(false);

    const question = compileGuardGlob("src/File?.ts");
    expect(question.matches("src/FileA.ts")).toBe(true);
    expect(question.matches("src/FileAB.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Baseline/suppression şeması — reason/owner/date ZORUNLU
// ---------------------------------------------------------------------------

describe("parseArchitectureBaseline", () => {
  const validBaseline = [
    "version: 1",
    "suppressions:",
    "  - ruleId: domain-must-not-import-infrastructure",
    '    from: "**/Cart/**"',
    '    to: "**/HtmlReportWriter*"',
    '    reason: "Legacy rapor yazarı refactor edilene kadar geçici istisna"',
    "    owner: alice",
    "    date: 2026-11-01",
    "",
  ].join("\n");

  it("geçerli girişler parse edilir; from/to derlenmiş glob olur", () => {
    const baseline = parseArchitectureBaseline(validBaseline);
    expect(baseline.version).toBe(1);
    expect(baseline.suppressions).toHaveLength(1);
    const entry = baseline.suppressions[0];
    expect(entry?.ruleId).toBe("domain-must-not-import-infrastructure");
    expect(entry?.reason).toContain("geçici istisna");
    expect(entry?.owner).toBe("alice");
    expect(entry?.date).toBe("2026-11-01");
    expect(entry?.from?.source).toBe("**/Cart/**");
    expect(entry?.to?.source).toBe("**/HtmlReportWriter*");
  });

  it("owner eksik → guard/baseline-invalid", () => {
    expectGuardError("guard/baseline-invalid", () =>
      parseArchitectureBaseline(
        [
          "version: 1",
          "suppressions:",
          "  - ruleId: r1",
          '    reason: "gerekçe"',
          "    date: 2026-11-01",
          "",
        ].join("\n"),
      ),
    );
  });

  it("reason boşluk → guard/baseline-invalid", () => {
    expectGuardError("guard/baseline-invalid", () =>
      parseArchitectureBaseline(
        [
          "version: 1",
          "suppressions:",
          "  - ruleId: r1",
          '    reason: "   "',
          "    owner: alice",
          "    date: 2026-11-01",
          "",
        ].join("\n"),
      ),
    );
  });

  it("date biçimi YYYY-MM-DD değilse → guard/baseline-invalid", () => {
    expectGuardError("guard/baseline-invalid", () =>
      parseArchitectureBaseline(
        [
          "version: 1",
          "suppressions:",
          "  - ruleId: r1",
          '    reason: "gerekçe"',
          "    owner: alice",
          "    date: 01.11.2026",
          "",
        ].join("\n"),
      ),
    );
  });

  it("geçersiz takvim tarihi (2026-02-30) → guard/baseline-invalid", () => {
    expectGuardError("guard/baseline-invalid", () =>
      parseArchitectureBaseline(
        [
          "version: 1",
          "suppressions:",
          "  - ruleId: r1",
          '    reason: "gerekçe"',
          "    owner: alice",
          "    date: 2026-02-30",
          "",
        ].join("\n"),
      ),
    );
  });

  it("baseline'daki güvensiz glob → guard/pattern-too-long", () => {
    expectGuardError("guard/pattern-too-long", () =>
      parseArchitectureBaseline(
        [
          "version: 1",
          "suppressions:",
          "  - ruleId: r1",
          `    from: "${"a".repeat(MAX_GLOB_LENGTH + 1)}"`,
          '    reason: "gerekçe"',
          "    owner: alice",
          "    date: 2026-11-01",
          "",
        ].join("\n"),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// findViolations — pozitif
// ---------------------------------------------------------------------------

describe("findViolations no-cycles", () => {
  it("döngülü fixture → tek no-cycles bulgusu (SCC üyeleri + birleşik kanıtlar)", () => {
    const findings = findViolations(
      cyclicModuleSnapshot(),
      NO_CYCLES_POLICY,
      EMPTY_BASELINE,
    );

    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.ruleId).toBe("modules-must-be-acyclic");
    expect(finding?.ruleType).toBe("no-cycles");
    expect(finding?.severity).toBe("error");
    expect(finding?.cycle).toEqual(["App.A", "App.B", "App.C"]);
    // from/to: döngü temsilcisi (lexical olarak en küçük qualifiedName).
    expect(finding?.from).toBe("App.A");
    expect(finding?.to).toBe("App.A");
    expect(finding?.evidenceIds).toEqual(["ev-e-1", "ev-e-2", "ev-e-3"]);
    expect(finding?.suppressed).toBe(false);
    expect(finding?.suppression).toBeUndefined();
    expect(finding?.snapshotId).toBe("snapshot:guard-fixture");
    expect(finding?.id).toMatch(/^finding:[0-9a-f]{64}$/);
  });

  it("kendine çağrı (self-loop) → döngü bulgusu", () => {
    const snap = snapshot(
      [node("n-s", "Module", "App.Self", "src/Self.ts")],
      [edge("e-1", "n-s", "n-s", "CALLS")],
    );
    const findings = findViolations(snap, NO_CYCLES_POLICY, EMPTY_BASELINE);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cycle).toEqual(["App.Self"]);
  });

  it("kuralın edgeKinds dışındaki kenarlardan kurulan döngü → bulgu yok", () => {
    const snap = snapshot(
      [
        node("n-a", "Module", "App.A", "src/A/ModuleA.ts"),
        node("n-b", "Module", "App.B", "src/B/ModuleB.ts"),
      ],
      [
        edge("e-1", "n-a", "n-b", "IMPORTS"),
        edge("e-2", "n-b", "n-a", "IMPORTS"),
      ],
    );
    const callsOnly = parseArchitecturePolicy(
      [
        "version: 1",
        "rules:",
        "  - id: modules-must-be-acyclic",
        "    type: no-cycles",
        "    edgeKinds: [CALLS]",
        "    severity: error",
        "",
      ].join("\n"),
    );
    expect(findViolations(snap, callsOnly, EMPTY_BASELINE)).toHaveLength(0);
    // Varsayılan (CALLS+IMPORTS) kuralda aynı graf bulgu üretir.
    expect(findViolations(snap, NO_CYCLES_POLICY, EMPTY_BASELINE)).toHaveLength(1);
  });

  it("scope: modules File döngüsünü kapsam dışı bırakır; scope: files yakalar", () => {
    const snap = snapshot(
      [
        node("f-1", "File", "App.FileA", "src/FileA.ts"),
        node("f-2", "File", "App.FileB", "src/FileB.ts"),
      ],
      [
        edge("e-1", "f-1", "f-2", "CALLS"),
        edge("e-2", "f-2", "f-1", "CALLS"),
      ],
    );
    expect(findViolations(snap, NO_CYCLES_POLICY, EMPTY_BASELINE)).toHaveLength(0);

    const filesScope = parseArchitecturePolicy(
      [
        "version: 1",
        "rules:",
        "  - id: files-must-be-acyclic",
        "    type: no-cycles",
        "    scope: files",
        "    severity: warning",
        "",
      ].join("\n"),
    );
    const findings = findViolations(snap, filesScope, EMPTY_BASELINE);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cycle).toEqual(["App.FileA", "App.FileB"]);
  });
});

describe("findViolations forbidden-dependency", () => {
  it("yasak bağımlılık → forbidden bulguları (from/to + kenar kanıtı)", () => {
    const findings = findViolations(
      forbiddenFixtureSnapshot(),
      FORBIDDEN_POLICY,
      EMPTY_BASELINE,
    );

    expect(findings).toHaveLength(2);
    const first = findings[0];
    expect(first?.ruleType).toBe("forbidden-dependency");
    expect(first?.severity).toBe("error");
    expect(first?.from).toBe("App.Domain.Cart.CartService");
    expect(first?.fromPath).toBe("src/Domain/Cart/CartService.ts");
    expect(first?.to).toBe("App.Infrastructure.Reporting.HtmlReportWriter");
    expect(first?.toPath).toBe("src/Infrastructure/Reporting/HtmlReportWriter.ts");
    expect(first?.evidenceIds).toEqual(["ev-ed-2"]);
    expect(first?.cycle).toBeUndefined();
  });

  it("kenar türü kuralın edgeKinds'i dışındaysa bulgu üretmez", () => {
    const dependsOnly = parseArchitecturePolicy(
      [
        "version: 1",
        "rules:",
        "  - id: domain-must-not-depend-infrastructure",
        "    type: forbidden-dependency",
        '    from: "**/Domain/**"',
        '    to: "**/Infrastructure/**"',
        "    edgeKinds: [DEPENDS_ON]",
        "    severity: error",
        "",
      ].join("\n"),
    );
    expect(
      findViolations(forbiddenFixtureSnapshot(), dependsOnly, EMPTY_BASELINE),
    ).toHaveLength(0);
  });

  it("qualifiedName eğik çizgi içeriyorsa path'siz node da eşleşir (belgelenmiş yüzey)", () => {
    const snap = snapshot(
      [
        node("n-d", "Class", "code/Domain/Svc"),
        node("n-i", "Class", "code/Infrastructure/Repo"),
      ],
      [edge("e-1", "n-d", "n-i", "IMPORTS")],
    );
    const findings = findViolations(snap, FORBIDDEN_POLICY, EMPTY_BASELINE);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.fromPath).toBeUndefined();
  });

  it("path'siz ve eğik çizgisiz qualifiedName path glob'uyla eşleşmez", () => {
    const snap = snapshot(
      [
        node("n-d", "Class", "App.Domain.Svc"),
        node("n-i", "Class", "App.Infrastructure.Repo"),
      ],
      [edge("e-1", "n-d", "n-i", "IMPORTS")],
    );
    expect(findViolations(snap, FORBIDDEN_POLICY, EMPTY_BASELINE)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findViolations — negatif
// ---------------------------------------------------------------------------

describe("findViolations negatif", () => {
  it("döngüsüz graf → bulgu yok", () => {
    const snap = snapshot(
      [
        node("n-a", "Module", "App.A", "src/A/ModuleA.ts"),
        node("n-b", "Module", "App.B", "src/B/ModuleB.ts"),
      ],
      [edge("e-1", "n-a", "n-b", "CALLS")],
    );
    expect(findViolations(snap, NO_CYCLES_POLICY, EMPTY_BASELINE)).toHaveLength(0);
  });

  it("kural yok → bulgu yok", () => {
    const emptyPolicy = parseArchitecturePolicy("version: 1\nrules: []\n");
    expect(
      findViolations(cyclicModuleSnapshot(), emptyPolicy, EMPTY_BASELINE),
    ).toHaveLength(0);
  });

  it("uçları bilinmeyen node'a işaret eden kenar savunmalı atlanır", () => {
    const snap = snapshot(
      [node("n-d1", "Class", "App.Domain.OrdersService", "src/Domain/Svc.ts")],
      [
        edge("ed-1", "n-d1", "n-missing", "IMPORTS"),
        edge("ed-2", "n-d1", "n-missing2", "CALLS"),
      ],
    );
    expect(findViolations(snap, FORBIDDEN_POLICY, EMPTY_BASELINE)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findViolations — suppression (partial: kısmen suppression'lı liste)
// ---------------------------------------------------------------------------

describe("findViolations suppression", () => {
  it("kısmen suppression'lı bulgu listesi; reason/owner/date çıktıda taşınır", () => {
    const findings = findViolations(
      forbiddenFixtureSnapshot(),
      FORBIDDEN_POLICY,
      CART_BASELINE,
    );

    expect(findings).toHaveLength(2);
    const suppressed = findings.filter((f) => f.suppressed);
    const open = findings.filter((f) => !f.suppressed);
    expect(suppressed).toHaveLength(1);
    expect(open).toHaveLength(1);

    expect(suppressed[0]?.from).toBe("App.Domain.Cart.CartService");
    expect(suppressed[0]?.suppression).toEqual({
      reason: "Legacy rapor yazarı refactor edilene kadar geçici istisna",
      owner: "alice",
      date: "2026-11-01",
    });

    expect(open[0]?.from).toBe("App.Domain.OrdersService");
    expect(open[0]?.suppression).toBeUndefined();
  });

  it("ruleId uyuşmayan suppression bulguyu baskılamaz", () => {
    const wrongRuleBaseline = parseArchitectureBaseline(
      [
        "version: 1",
        "suppressions:",
        "  - ruleId: baska-kural",
        '    reason: "gerekçe"',
        "    owner: alice",
        "    date: 2026-11-01",
        "",
      ].join("\n"),
    );
    const findings = findViolations(
      forbiddenFixtureSnapshot(),
      FORBIDDEN_POLICY,
      wrongRuleBaseline,
    );
    expect(findings.every((f) => !f.suppressed)).toBe(true);
  });

  it("döngü bulgusu: from/to glob'u SCC üyelerinden en az birine eşleşirse baskılanır", () => {
    const cycleBaseline = parseArchitectureBaseline(
      [
        "version: 1",
        "suppressions:",
        "  - ruleId: modules-must-be-acyclic",
        '    from: "**/B/**"',
        '    to: "**/C/**"',
        '    reason: "B→C döngüsü bilinen teknik borç"',
        "    owner: bob",
        "    date: 2026-10-15",
        "",
      ].join("\n"),
    );
    const findings = findViolations(
      cyclicModuleSnapshot(),
      NO_CYCLES_POLICY,
      cycleBaseline,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.suppressed).toBe(true);
    expect(findings[0]?.suppression?.owner).toBe("bob");
  });

  it("suppression from glob'u hiçbir üyeye eşleşmezse bulgu açık kalır", () => {
    const noMatchBaseline = parseArchitectureBaseline(
      [
        "version: 1",
        "suppressions:",
        "  - ruleId: modules-must-be-acyclic",
        '    from: "**/Yok/**"',
        '    reason: "gerekçe"',
        "    owner: alice",
        "    date: 2026-11-01",
        "",
      ].join("\n"),
    );
    const findings = findViolations(
      cyclicModuleSnapshot(),
      NO_CYCLES_POLICY,
      noMatchBaseline,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.suppressed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Determinizm ve saflık
// ---------------------------------------------------------------------------

describe("findViolations determinizm", () => {
  it("aynı girdi → aynı çıktı (JSON bit eş eş)", () => {
    const snap = forbiddenFixtureSnapshot();
    const a = findViolations(snap, FORBIDDEN_POLICY, CART_BASELINE);
    const b = findViolations(snap, FORBIDDEN_POLICY, CART_BASELINE);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("node/edge dizi sırası sonucu etkilemez", () => {
    const snap = forbiddenFixtureSnapshot();
    const a = findViolations(snap, FORBIDDEN_POLICY, EMPTY_BASELINE);
    const shuffled = snapshot(
      [...snap.nodes].reverse(),
      [...snap.edges].reverse(),
    );
    expect(findViolations(shuffled, FORBIDDEN_POLICY, EMPTY_BASELINE)).toEqual(a);
  });

  it("girdiler mutate edilmez (derin dondurulmuş snapshot ile aynı sonuç)", () => {
    const snap = forbiddenFixtureSnapshot();
    const expected = findViolations(snap, FORBIDDEN_POLICY, CART_BASELINE);
    const frozen = JSON.parse(JSON.stringify(snap)) as SnapshotGraph;
    deepFreeze(frozen);
    expect(() =>
      findViolations(frozen, FORBIDDEN_POLICY, CART_BASELINE),
    ).not.toThrow();
    expect(findViolations(frozen, FORBIDDEN_POLICY, CART_BASELINE)).toEqual(
      expected,
    );
  });
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Denetim bulguları — ReDoS doğrusal eşleştirici, boş glob reddi, bitişik
// literal karakterler, yetim suppression yönetişimi
// ---------------------------------------------------------------------------

describe("compileGuardGlob — ReDoS regresyonu (doğrusal eşleştirici)", () => {
  it("`**/` çoklu grup × uzun eğik çizgili değer doğrusal sürede sonuçlanır", () => {
    // 16 adet `**/` grubu = 32 wildcard (kota: 32, tam sınırda — geçerli);
    // değer 5000 karakter. Önceki regex gerçeklemesi `(?:.*/)?` nicelenmiş
    // grubu `.*` içerdiğinden bu girdide dakikalarca geri izliyordu
    // (bağımsız ölçüm: 16 grup = 68 sn, 25 eğik çizgide 300+ sn bitmedi).
    const glob = compileGuardGlob("**/".repeat(16) + "z");
    const value = "a/".repeat(2500);
    const startedAt = Date.now();
    expect(glob.matches(value)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("çoklu `**/` gruplu desenler standart glob semantiğiyle eşleşir", () => {
    const glob = compileGuardGlob("**/a/**/b/**/c");
    expect(glob.matches("x/a/y/b/w/c")).toBe(true);
    expect(glob.matches("a/b/c")).toBe(true);
    expect(glob.matches("x/a/y/b/w/d")).toBe(false);
  });
});

describe("boş glob reddi", () => {
  it("forbidden-dependency from: '' → guard/policy-invalid", () => {
    expectGuardError("guard/policy-invalid", () =>
      parseArchitecturePolicy(
        [
          "version: 1",
          "rules:",
          "  - id: r1",
          "    type: forbidden-dependency",
          '    from: ""',
          '    to: "**/B/**"',
          "    edgeKinds: [CALLS]",
          "    severity: error",
          "",
        ].join("\n"),
      ),
    );
  });

  it("suppression from: '' → guard/baseline-invalid", () => {
    expectGuardError("guard/baseline-invalid", () =>
      parseArchitectureBaseline(
        [
          "version: 1",
          "suppressions:",
          "  - ruleId: r1",
          '    from: ""',
          '    reason: "gerekçe"',
          "    owner: alice",
          "    date: 2026-11-01",
          "",
        ].join("\n"),
      ),
    );
  });
});

describe("bitişik meta-benzeri literal karakterler birebir eşleşir", () => {
  it("'v1..2' deseni noktaları literal sayar", () => {
    const glob = compileGuardGlob("v1..2");
    expect(glob.matches("v1..2")).toBe(true);
    // Ayrıkçı girdi: ikinci nokta regex any-char olarak sızarsa (eski /g
    // lastIndex hatası) bu eşleşme yanlış true dönerdi.
    expect(glob.matches("v1.A2")).toBe(false);
    expect(glob.matches("v1ABC2")).toBe(false);
  });
});

describe("findOrphanSuppressions", () => {
  it("policy'de karşılığı olmayan ruleId'li suppression'ları raporlar", () => {
    const baseline = parseArchitectureBaseline(
      [
        "version: 1",
        "suppressions:",
        "  - ruleId: domain-must-not-import-infrastructure",
        '    reason: "geçerli"',
        "    owner: alice",
        "    date: 2026-11-01",
        "  - ruleId: retired-rule",
        '    reason: "bayat kayıt"',
        "    owner: bob",
        "    date: 2026-01-01",
        "",
      ].join("\n"),
    );
    const orphans = findOrphanSuppressions(FORBIDDEN_POLICY, baseline);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.ruleId).toBe("retired-rule");
    expect(orphans[0]?.reason).toBe("bayat kayıt");
  });

  it("tüm girişlerin karşılığı varsa boş döner", () => {
    const baseline = parseArchitectureBaseline(
      [
        "version: 1",
        "suppressions:",
        "  - ruleId: domain-must-not-import-infrastructure",
        '    reason: "geçerli"',
        "    owner: alice",
        "    date: 2026-11-01",
        "",
      ].join("\n"),
    );
    expect(findOrphanSuppressions(FORBIDDEN_POLICY, baseline)).toEqual([]);
  });

  it("kural içermeyen policy'de tüm suppression'lar yetim sayılır", () => {
    const emptyPolicy = parseArchitecturePolicy("version: 1\nrules: []\n");
    const orphans = findOrphanSuppressions(emptyPolicy, CART_BASELINE);
    expect(orphans).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Belgelenmiş davranışlar — karakterizasyon (case-sensitivity, derin graf
// Tarjan, no-cycles determinizmi)
// ---------------------------------------------------------------------------

describe("belgelenmiş davranışlar — karakterizasyon", () => {
  it("globlar büyük/küçük harfe DUYARLIDIR (belgelenmiş karar)", () => {
    const glob = compileGuardGlob("**/Domain/**");
    expect(glob.matches("src/Domain/x.ts")).toBe(true);
    expect(glob.matches("src/domain/x.ts")).toBe(false);
  });

  it("yinelemeli Tarjan: 10.000 node'luk tek döngü yığın taşması olmadan bulunur", () => {
    const n = 10000;
    const pad = (i: number) => String(i).padStart(5, "0");
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < n; i += 1) {
      nodes.push(
        node(`n-${pad(i)}`, "Module", `App.M${pad(i)}`, `src/M${i}.ts`),
      );
      edges.push(
        edge(`e-${pad(i)}`, `n-${pad(i)}`, `n-${pad((i + 1) % n)}`, "CALLS"),
      );
    }
    const findings = findViolations(
      snapshot(nodes, edges),
      NO_CYCLES_POLICY,
      EMPTY_BASELINE,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.cycle).toHaveLength(n);
    expect(findings[0]?.suppressed).toBe(false);
  }, 15000); // tam koşu paralel işçi yükü altında da kararlı olsun

  it("no-cycles determinizmi: aynı girdi → aynı çıktı; dizi sırası etkisiz", () => {
    const snap = cyclicModuleSnapshot();
    const a = findViolations(snap, NO_CYCLES_POLICY, EMPTY_BASELINE);
    const b = findViolations(snap, NO_CYCLES_POLICY, EMPTY_BASELINE);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const shuffled = snapshot(
      [...snap.nodes].reverse(),
      [...snap.edges].reverse(),
    );
    expect(findViolations(shuffled, NO_CYCLES_POLICY, EMPTY_BASELINE)).toEqual(a);
  });
});

// Kullanılmayan import uyarısını önlemek için tip düzeyi referans.
export type { ArchitecturePolicy, ArchitectureBaseline };
