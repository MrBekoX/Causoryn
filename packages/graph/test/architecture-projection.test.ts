import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  createSnapshot,
  type SnapshotGraph,
  type SnapshotNodeInput,
} from "@causoryn/domain";

import {
  ANNOTATION_LIMITS,
  ArchitectureAnnotationsSchema,
  validateArchitectureAnnotations,
} from "../src/architecture-annotations.js";
import {
  projectArchitecture,
} from "../src/architecture-projection.js";
import { GraphRepositoryError } from "../src/errors.js";

const WS = "ws_arch_proj";
const CREATED_AT = "2026-11-22T20:00:00.000Z";

function makeNode(
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

function makeEvidence(relativePath: string, rationale: string, analyzerId = "ts-adapter") {
  return {
    kind: "static-analysis",
    span: {
      relativePath,
      startLine: 1,
      endLine: 15,
      sourceHash: `sha256:${relativePath}:1`,
    },
    analyzerId,
    analyzerVersion: "0.2.2",
    rationale,
  };
}

function polyglotCleanArchSnapshot(): SnapshotGraph {
  const wsRoot = makeNode("Workspace", "workspace::blogapp", undefined, undefined);

  // Backend Presentation / API (C#)
  const apiEpPosts = makeNode("Endpoint", "POST /posts", "src/backend/Presentation/API/Endpoints/PostsEndpoints.cs", "csharp", 12, 40);
  const apiEpAuth = makeNode("Endpoint", "POST /auth/login", "src/backend/Presentation/API/Endpoints/AuthEndpoints.cs", "csharp", 10, 35);
  const apiHandler = makeNode("Handler", "PostsEndpoints.CreatePost", "src/backend/Presentation/API/Endpoints/PostsEndpoints.cs", "csharp", 15, 38);

  // Backend Presentation / Api.Tests (C#)
  const apiTest = makeNode("Test", "PostsEndpointsTests.ShouldCreatePost", "src/backend/Presentation/Api.Tests/PostsEndpointsTests.cs", "csharp", 5, 25);

  // Backend Core / Application (C#)
  const appCmd = makeNode("Class", "CreatePostCommandHandler", "src/backend/Core/Application/Features/Posts/CreatePostCommandHandler.cs", "csharp", 1, 60);
  const appCommon = makeNode("Interface", "IAppDbContext", "src/backend/Core/Application/Common/IAppDbContext.cs", "csharp", 1, 20);

  // Backend Core / Domain (C#)
  const domainPost = makeNode("Class", "Post", "src/backend/Core/Domain/Entities/Post.cs", "csharp", 1, 45);

  // Backend Infrastructure / Persistence (C#) — deliberate cycle with Application/Common!
  const infraDb = makeNode("Class", "BlogDbContext", "src/backend/Infrastructure/Persistence/BlogDbContext.cs", "csharp", 1, 80);
  const dbTable = makeNode("Table", "posts", "src/backend/Infrastructure/Persistence/BlogDbContext.cs", "csharp", 20, 30);

  // Frontend (TypeScript)
  const webPage = makeNode("Function", "PostsPage", "src/frontend/blogapp-web/src/app/posts/page.tsx", "typescript", 1, 50);
  const webApi = makeNode("Function", "createPostApi", "src/frontend/blogapp-web/src/lib/api.ts", "typescript", 10, 30);

  // Python AI Agent service
  const pyAgent = makeNode("Function", "generate_summary", "src/services/ai-agent-service/app/agent_core/summarizer.py", "python", 1, 40);
  const pyMsg = makeNode("Function", "publish_event", "src/services/ai-agent-service/app/messaging/broker.py", "python", 1, 35);
  const contractApi = makeNode("ApiContract", "agent-openapi", "src/contracts/agent/openapi.yaml", "yaml", 1, 100);

  // Noisy UnknownExternal nodes (simulating real Roslyn/TS external expressions)
  const externals: SnapshotNodeInput[] = [];
  for (let i = 0; i < 12; i++) {
    externals.push(
      makeNode(
        "UnknownExternal",
        `RuleFor(x => x.Field${String(i)}).NotEmpty()\n  .MaximumLength(200)`,
        undefined,
        "csharp",
      ),
    );
  }

  const allNodes: SnapshotNodeInput[] = [
    wsRoot,
    apiEpPosts,
    apiEpAuth,
    apiHandler,
    apiTest,
    appCmd,
    appCommon,
    domainPost,
    infraDb,
    dbTable,
    webPage,
    webApi,
    pyAgent,
    pyMsg,
    contractApi,
    ...externals,
  ];

  const externalEdges = externals.map((ext) => ({
    kind: "CALLS" as const,
    from: apiHandler,
    to: ext,
    resolution: "unresolved" as const,
  }));

  return createSnapshot({
    workspaceId: WS,
    revision: { id: "rev-poly-1", sequence: 1 },
    configHash: "cfg-poly",
    analyzerFingerprint: "ts+roslyn+python@0.2.2",
    state: "ready",
    createdAt: CREATED_AT,
    nodes: allNodes,
    edges: [
      {
        kind: "ROUTES_TO",
        from: apiEpPosts,
        to: apiHandler,
        resolution: "verified",
        evidence: [makeEvidence("src/backend/Presentation/API/Endpoints/PostsEndpoints.cs", "Minimal API route", "roslyn-worker")],
      },
      {
        kind: "CALLS",
        from: apiHandler,
        to: appCmd,
        resolution: "verified",
        evidence: [makeEvidence("src/backend/Presentation/API/Endpoints/PostsEndpoints.cs", "MediatR send", "roslyn-worker")],
      },
      {
        kind: "CALLS",
        from: appCmd,
        to: domainPost,
        resolution: "verified",
        evidence: [makeEvidence("src/backend/Core/Application/Features/Posts/CreatePostCommandHandler.cs", "Constructs Post", "roslyn-worker")],
      },
      {
        kind: "REFERENCES",
        from: appCmd,
        to: appCommon,
        resolution: "verified",
        evidence: [makeEvidence("src/backend/Core/Application/Features/Posts/CreatePostCommandHandler.cs", "Uses IAppDbContext", "roslyn-worker")],
      },
      // Cycle between Application/Common and Infrastructure/Persistence
      {
        kind: "IMPLEMENTS",
        from: infraDb,
        to: appCommon,
        resolution: "verified",
        evidence: [makeEvidence("src/backend/Infrastructure/Persistence/BlogDbContext.cs", "Implements IAppDbContext", "roslyn-worker")],
      },
      {
        kind: "CALLS",
        from: appCommon,
        to: infraDb,
        resolution: "heuristic",
      },
      {
        kind: "WRITES",
        from: infraDb,
        to: dbTable,
        resolution: "verified",
        evidence: [makeEvidence("src/backend/Infrastructure/Persistence/BlogDbContext.cs", "DbSet<Post>", "roslyn-worker")],
      },
      {
        kind: "TESTS",
        from: apiTest,
        to: apiHandler,
        resolution: "verified",
        evidence: [makeEvidence("src/backend/Presentation/Api.Tests/PostsEndpointsTests.cs", "xUnit test", "roslyn-worker")],
      },
      {
        kind: "CALLS",
        from: webPage,
        to: webApi,
        resolution: "verified",
        evidence: [makeEvidence("src/frontend/blogapp-web/src/app/posts/page.tsx", "Calls API client", "ts-adapter")],
      },
      {
        kind: "CALLS",
        from: pyAgent,
        to: pyMsg,
        resolution: "verified",
        evidence: [makeEvidence("src/services/ai-agent-service/app/agent_core/summarizer.py", "Publishes summary", "python-worker")],
      },
      {
        kind: "CONSUMES_CONTRACT",
        from: pyAgent,
        to: contractApi,
        resolution: "heuristic",
      },
      ...externalEdges,
    ],
  });
}

function emptySnapshot(): SnapshotGraph {
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

describe("projectArchitecture — deterministik adaptif mimari projeksiyonu", () => {
  it("boş snapshot için geçerli 0 modüllü projeksiyon üretir", () => {
    const proj = projectArchitecture(emptySnapshot());
    expect(proj.modules).toEqual([]);
    expect(proj.edges).toEqual([]);
    expect(proj.cycles).toEqual([]);
    expect(proj.entrypoints).toEqual([]);
    expect(proj.contracts).toEqual([]);
    expect(proj.externalSummary.nodeCount).toBe(0);
    expect(proj.summary.totalRawNodes).toBe(0);
  });

  it("polyglot clean-architecture repo'da (0 Module node, %50 UnknownExternal) okunabilir modül grafı, SCC döngüsü ve external özeti üretir", () => {
    const snap = polyglotCleanArchSnapshot();
    const proj = projectArchitecture(snap, { maxModules: 16 });

    expect(proj.modules.length).toBeGreaterThanOrEqual(5);
    expect(proj.modules.length).toBeLessThanOrEqual(16);

    // UnknownExternal asla diyagram modülü olmaz; externalSummary içinde dürüstçe raporlanır.
    expect(proj.modules.every((m) => !m.id.includes("UnknownExternal"))).toBe(true);
    expect(proj.externalSummary.nodeCount).toBe(12);
    expect(proj.externalSummary.unresolvedEdgeCount).toBe(12);

    // Tüm modül kimlikleri kararlı `mod:` ön ekli ve insan-okunurdur.
    for (const mod of proj.modules) {
      expect(mod.id.startsWith("mod:")).toBe(true);
      expect(mod.label.length).toBeGreaterThan(0);
      expect(mod.layer).toBeGreaterThanOrEqual(0);
    }

    // Test modülü isTest=true olarak işaretlenir.
    const testMod = proj.modules.find((m) => m.path.includes("Api.Tests"));
    expect(testMod?.isTest).toBe(true);

    // Entrypoint'ler ve kontratlar çıkarılır.
    expect(proj.entrypoints.length).toBeGreaterThanOrEqual(2);
    expect(proj.contracts.length).toBeGreaterThanOrEqual(2);

    // Application/Common <-> Infrastructure/Persistence döngüsü SCC olarak tespit edilir.
    expect(proj.cycles.length).toBeGreaterThanOrEqual(1);
    expect(proj.edges.some((e) => e.isCycle)).toBe(true);

    // Kritik akışlar (PostsEndpoints -> CreatePost -> CreatePostCommandHandler) çıkarılır.
    expect(proj.deterministicFlows.length).toBeGreaterThanOrEqual(1);

    // Evidence kataloğu yalnızca görünür kanıtları taşır ve boşturmaz.
    expect(Object.keys(proj.evidenceCatalog).length).toBeGreaterThan(0);
  });

  it("maxModules tavanına her zaman uyar ve pathPrefix / includeTests filtrelerini uygular", () => {
    const snap = polyglotCleanArchSnapshot();
    const compact = projectArchitecture(snap, { maxModules: 4 });
    expect(compact.modules.length).toBeLessThanOrEqual(4);

    const backendOnly = projectArchitecture(snap, { pathPrefix: "src/backend", includeTests: false });
    expect(backendOnly.modules.length).toBeGreaterThan(0);
    expect(backendOnly.modules.every((m) => m.path.startsWith("src/backend"))).toBe(true);
    expect(backendOnly.modules.every((m) => !m.isTest)).toBe(true);

    expect(() => projectArchitecture(snap, { maxModules: 1 })).toThrowError(
      expect.objectContaining({ code: "export/invalid-options" }),
    );
    expect(() => projectArchitecture(snap, { maxModules: 101 })).toThrowError(
      expect.objectContaining({ code: "export/invalid-options" }),
    );
  });

  it("karıştırılmış snapshot girdilerinden bit düzeyinde özdeş projeksiyon üretir", () => {
    const snap = polyglotCleanArchSnapshot();
    const shuffled: SnapshotGraph = {
      ...snap,
      nodes: [...snap.nodes].reverse(),
      edges: [...snap.edges].reverse(),
      evidence: [...snap.evidence].reverse(),
    };
    const a = canonicalJson(projectArchitecture(snap) as never);
    const b = canonicalJson(projectArchitecture(shuffled) as never);
    expect(b).toBe(a);
  });

  it("tek klasörlü küçük fixture'da anahtar sembolleri (OrdersService.create) korur", () => {
    const fnCreate = makeNode("Method", "OrdersService.create", "src/orders-service.ts", "typescript", 10, 25);
    const fnRepo = makeNode("Method", "OrdersRepo.save", "src/orders-repo.ts", "typescript", 5, 18);
    const snap = createSnapshot({
      workspaceId: WS,
      revision: { id: "rev-small", sequence: 1 },
      configHash: "cfg-small",
      analyzerFingerprint: "ts-adapter@0.2.2",
      state: "ready",
      createdAt: CREATED_AT,
      nodes: [fnCreate, fnRepo],
      edges: [
        {
          kind: "CALLS",
          from: fnCreate,
          to: fnRepo,
          resolution: "verified",
          evidence: [makeEvidence("src/orders-service.ts", "Calls repo.save")],
        },
      ],
    });
    const proj = projectArchitecture(snap);
    expect(proj.modules).toHaveLength(2);
    expect(proj.edges).toHaveLength(1);
    const allKeyNames = proj.modules.flatMap((m) => m.keySymbols.map((s) => s.qualifiedName));
    expect(allKeyNames).toContain("OrdersService.create");
  });
});

describe("validateArchitectureAnnotations — fail-closed Host-LLM grounding", () => {
  it("geçerli ve doğrulanmış Host-LLM anotasyonlarını kanonik biçimde kabul eder", () => {
    const snap = polyglotCleanArchSnapshot();
    const proj = projectArchitecture(snap, { maxModules: 16 });
    const firstMod = proj.modules[0];
    const secondMod = proj.modules[1];
    const firstNode = snap.nodes.find((n) => n.kind === "Endpoint");
    const firstEv = snap.evidence[0];
    if (!firstMod || !secondMod || !firstNode || !firstEv) {
      throw new Error("fixture incomplete");
    }
    const keyFile = firstMod.files[0];

    const parsed = ArchitectureAnnotationsSchema.parse({
      title: "BlogApp Full-Stack Architecture",
      architectureStyle: "Clean Architecture + Polyglot Microservice",
      executiveSummary: "C# .NET API, Next.js frontend, and Python AI agent service.",
      domains: [
        {
          id: "dom-core",
          name: "Core Platform",
          description: "Core application services",
          layer: "application",
          moduleIds: [firstMod.id],
        },
      ],
      moduleNotes: [
        {
          moduleId: firstMod.id,
          summary: "Handles primary domain logic.",
          responsibility: "Orchestrates domain commands",
          layer: "application",
          ...(keyFile === undefined ? {} : { keyFiles: [keyFile] }),
        },
      ],
      flows: [
        {
          id: "flow-post",
          title: "Create Post Flow",
          description: "End-to-end article creation.",
          steps: [
            {
              moduleId: firstMod.id,
              nodeId: firstNode.id,
              label: "HTTP POST /posts",
              explanation: "Validates and dispatches command.",
            },
            {
              moduleId: secondMod.id,
              label: "Persist",
              explanation: "Saves entity to database.",
            },
          ],
        },
      ],
      guidedTour: [
        {
          step: 2,
          title: "Second stop",
          targetModuleId: secondMod.id,
          explanation: "Explore downstream handling.",
        },
        {
          step: 1,
          title: "Start here",
          targetModuleId: firstMod.id,
          targetNodeId: firstNode.id,
          explanation: "Entry point for new contributors.",
        },
      ],
      decisions: [
        {
          id: "adr-1",
          title: "Clean Architecture Separation",
          summary: "Keeps presentation isolated from persistence.",
          relatedModuleIds: [firstMod.id],
          evidenceIds: [firstEv.id],
        },
      ],
      risks: [
        {
          id: "risk-1",
          title: "Circular dependency",
          severity: "high",
          summary: "Common interfaces call back into Infrastructure.",
          relatedModuleIds: [firstMod.id],
          evidenceIds: [firstEv.id],
        },
      ],
    });

    const validated = validateArchitectureAnnotations(parsed, proj, snap);
    expect(validated.title).toBe("BlogApp Full-Stack Architecture");
    expect(validated.guidedTour.map((s) => s.step)).toEqual([1, 2]);
    expect(validated.domains).toHaveLength(1);
    expect(validated.moduleNotes).toHaveLength(1);
  });

  it("uydurma moduleId, nodeId, evidenceId, keyFile veya çakışan domain atamasını fail-closed reddeder", () => {
    const snap = polyglotCleanArchSnapshot();
    const proj = projectArchitecture(snap, { maxModules: 16 });
    const validMod = proj.modules[0];
    if (!validMod) throw new Error("missing mod");

    // 1. Unknown moduleId
    expect(() =>
      validateArchitectureAnnotations(
        { moduleNotes: [{ moduleId: "mod:src/does-not-exist", summary: "Hallucinated" }] },
        proj,
        snap,
      ),
    ).toThrowError(expect.objectContaining({ code: "export/invalid-annotations" }));

    // 2. Unknown nodeId
    expect(() =>
      validateArchitectureAnnotations(
        {
          guidedTour: [
            { step: 1, title: "Bad", targetNodeId: "node:fabricated123", explanation: "Nope" },
          ],
        },
        proj,
        snap,
      ),
    ).toThrowError(expect.objectContaining({ code: "export/invalid-annotations" }));

    // 3. Unknown evidenceId
    expect(() =>
      validateArchitectureAnnotations(
        {
          decisions: [
            { id: "d1", title: "D1", summary: "S", evidenceIds: ["ev:nonexistent"] },
          ],
        },
        proj,
        snap,
      ),
    ).toThrowError(expect.objectContaining({ code: "export/invalid-annotations" }));

    // 4. Unknown keyFile
    expect(() =>
      validateArchitectureAnnotations(
        {
          moduleNotes: [
            { moduleId: validMod.id, summary: "Ok", keyFiles: ["src/hallucinated/file.ts"] },
          ],
        },
        proj,
        snap,
      ),
    ).toThrowError(expect.objectContaining({ code: "export/invalid-annotations" }));

    // 5. Module in two domains
    expect(() =>
      validateArchitectureAnnotations(
        {
          domains: [
            { id: "d1", name: "D1", description: "A", moduleIds: [validMod.id] },
            { id: "d2", name: "D2", description: "B", moduleIds: [validMod.id] },
          ],
        },
        proj,
        snap,
      ),
    ).toThrowError(expect.objectContaining({ code: "export/invalid-annotations" }));

    // 6. Oversized title fails schema budget
    expect(() =>
      validateArchitectureAnnotations(
        { title: "x".repeat(ANNOTATION_LIMITS.maxTitleChars + 1) },
        proj,
        snap,
      ),
    ).toThrowError(GraphRepositoryError);

    // 7. Audit H2: keyFile from a DIFFERENT module in the same snapshot is rejected fail-closed
    const otherMod = proj.modules.find((m) => m.id !== validMod.id && m.files.length > 0);
    if (otherMod && otherMod.files[0]) {
      expect(() =>
        validateArchitectureAnnotations(
          {
            moduleNotes: [
              { moduleId: validMod.id, summary: "Cross-module leak", keyFiles: [otherMod.files[0]] },
            ],
          },
          proj,
          snap,
        ),
      ).toThrowError(expect.objectContaining({ code: "export/invalid-annotations" }));
    }

    // 8. Audit H2: UnknownExternal nodeId cannot be targeted by guidedTour / flows
    const extNode = snap.nodes.find((n) => n.kind === "UnknownExternal");
    if (extNode) {
      expect(() =>
        validateArchitectureAnnotations(
          {
            guidedTour: [
              { step: 1, title: "Ext", targetNodeId: extNode.id, explanation: "Should fail" },
            ],
          },
          proj,
          snap,
        ),
      ).toThrowError(expect.objectContaining({ code: "export/invalid-annotations" }));
    }
  });

  it("Audit H3 & M4 & L3: 50 pathless node maxModules tavanını aşmaz, root/ dizini kök dosyayla çakışmaz ve '/' pathPrefix reddedilir", () => {
    const pathless: SnapshotNodeInput[] = [];
    for (let i = 0; i < 50; i++) {
      pathless.push(makeNode("Table", `tbl_${String(i)}`, undefined, "sql"));
    }
    const rootFile = makeNode("Function", "rootInit", "index.ts", "typescript", 1, 5);
    const rootDirFile = makeNode("Function", "rootDirFn", "root/app.ts", "typescript", 1, 5);
    const snap = createSnapshot({
      workspaceId: WS,
      revision: { id: "rev-audit-h3", sequence: 1 },
      configHash: "cfg-h3",
      analyzerFingerprint: "ts-adapter@0.2.2",
      state: "ready",
      createdAt: CREATED_AT,
      nodes: [rootFile, rootDirFile, ...pathless],
      edges: [],
    });

    const proj = projectArchitecture(snap, { maxModules: 8 });
    expect(proj.modules.length).toBeLessThanOrEqual(8);
    // Root loose file (`.`) and `root/` directory remain distinct modules with intact files!
    const rootLoose = proj.modules.find((m) => m.path === ".");
    const rootSubdir = proj.modules.find((m) => m.path === "root");
    expect(rootLoose?.files).toContain("index.ts");
    expect(rootSubdir?.files).toContain("root/app.ts");

    // Audit L3: "/" or "\\" pathPrefix is rejected fail-closed
    expect(() => projectArchitecture(snap, { pathPrefix: "/" })).toThrowError(
      expect.objectContaining({ code: "export/invalid-options" }),
    );
  });
});
