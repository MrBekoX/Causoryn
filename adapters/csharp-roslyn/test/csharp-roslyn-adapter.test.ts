/**
 * adapters/csharp-roslyn kabul testleri — sprint-2 / B2 (TŞ v2.1 §7, §7.1).
 *
 * Pozitif: gerçek Roslyn worker (dotnet exec, sabit komut + sabit argüman
 * dizisi) fixture-csharp-orders ile analiz edilir; kenarlar + evidence
 * kanıtlanır ve sonuç packages/domain createSnapshot kurucusuna beslenir
 * (uyum kanıtı: dangling edge / verified-kanıt invariant'ları kurucuda
 * zorlanır).
 * Negatif: olmayan worker DLL yolu → adapter motoru düşürmez; workerAvailable
 * =false, state=partial, explicit warning + L0/L1 dosya düzeyi.
 * Partial: sahte child process ile (a) yarı satır yanıt → framing kısmi
 * satır sınırı + timeout → kill kanıtı, (b) anında çöken süreç →
 * unavailable fallback.
 *
 * Güvenlik notu (proje kırmızı çizgisi 6): süreç koşumları spawnSync/spawn
 * ile LİTERAL çalıştırılabilir ("dotnet"/"node") + ARGÜMAN DİZİSİ ve
 * shell: false ile yapılır; DLL/fixture yolları repo içi SABİT yol
 * constant'larıdır; kullanıcı girdisi asla komut satırına interpole edilmez.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createSnapshot } from "@causoryn/domain";
import {
  analyzeCSharpWorkspace,
  type RoslynAdapterResult,
} from "../src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKER_DIR = join(REPO_ROOT, "native", "roslyn-worker");
const WORKER_DLL = join(
  WORKER_DIR,
  "bin",
  "Debug",
  "net10.0",
  "Causoryn.RoslynWorker.dll",
);
const FIXTURE_DIR = join(REPO_ROOT, "examples", "fixture-csharp-orders");

const FIXTURE_FILES = [
  "Program.cs",
  "Controllers/OrdersController.cs",
  "Services/OrdersService.cs",
  "Repositories/OrderRepository.cs",
] as const;

/* ------------------------------------------------------------------ */
/* Bootstrap: dotnet var mı? Build HER TURDA koşturulur ve sonucu      */
/* KONTROL EDİLİR (B1 kabul düzeniyle aynı disiplin).                  */
/* ------------------------------------------------------------------ */

const dotnetCheck = spawnSync("dotnet", ["--version"], {
  encoding: "utf8",
  shell: false,
});
if (dotnetCheck.status !== 0) {
  throw new Error(
    "dotnet SDK bulunamadı — adapters/csharp-roslyn kabul testleri koşulamadı (çalıştırılamadı olarak raporlanır)",
  );
}
const build = spawnSync("dotnet", ["build", WORKER_DIR], {
  encoding: "utf8",
  timeout: 300_000,
  maxBuffer: 16 * 1024 * 1024,
  shell: false,
});
if (build.status !== 0 || !existsSync(WORKER_DLL)) {
  throw new Error(
    `worker derlemesi başarısız (exit=${String(build.status)}) — B2 testleri eski binary'ye karşı koşulmaz`,
  );
}

function fixtureFiles(): Array<{ path: string; content: string }> {
  return FIXTURE_FILES.map((relativePath) => ({
    path: relativePath,
    content: readFileSync(join(FIXTURE_DIR, relativePath), "utf8"),
  }));
}

/** Yarı satır yazıp newline OLMADAN bekleyen sahte süreç (framing sınırı). */
const HALF_LINE_SCRIPT = `process.stdout.write('{"id":"x"}'); setTimeout(() => {}, 60000);`;
/** Anında stderr yazıp çıkan sahte süreç (worker crash fallback). */
const CRASH_SCRIPT = `process.stderr.write('sahte worker cakildi'); process.exit(1);`;
/** Geçerli PROTOCOL.md v1 hata yanıtı yazıp çıkan sahte süreç (bulgu: status:'error' ayrımı). */
const WORKER_ERROR_SCRIPT = `process.stdout.write(JSON.stringify({ id: 'analyze:adapter-b2-worker-error', protocolVersion: '1', status: 'error', error: { code: 'LIMIT_EXCEEDED', message: 'dosya sayısı sınırı aşıldı: 5001 > 5000' } }) + '\\n'); process.exit(0);`;

/* ------------------------------------------------------------------ */
/* Testler                                                             */
/* ------------------------------------------------------------------ */

describe("adapters/csharp-roslyn (sprint-2 B2)", () => {
  let positive: RoslynAdapterResult | null = null;
  let positiveDeterminismJson = "";

  beforeAll(
    async () => {
      positive = await analyzeCSharpWorkspace({
        workspaceId: "adapter-b2",
        files: fixtureFiles(),
      });
      positiveDeterminismJson = JSON.stringify(
        await analyzeCSharpWorkspace({
          workspaceId: "adapter-b2",
          files: fixtureFiles(),
        }),
      );
    },
    180_000,
  );

  it("pozitif: worker hazır, state ready, workerAvailable true", () => {
    expect(positive).not.toBeNull();
    expect(positive?.state).toBe("ready");
    expect(positive?.workerAvailable).toBe(true);
    expect(positive?.analyzerId).toBe("roslyn-worker");
    expect(positive?.coverageRatio).toBe(1);
  });

  it("pozitif: capabilities TŞ §7 sözleşmesiyle taşınır (worker'dan)", () => {
    expect(positive?.capabilities.astParse).toBe(true);
    expect(positive?.capabilities.symbolResolution).toBe(true);
    expect(positive?.capabilities.containsEdges).toBe(true);
    expect(positive?.capabilities.callEdges).toBe(true);
    expect(positive?.capabilities.importEdges).toBe(false);
    expect(positive?.capabilities.frameworkLinkers).toBe(false);
    expect(positive?.capabilities.routeDetection).toBe(
      "aspnetcore-controller-attribute-and-minimal-api-call-pattern",
    );
  });

  it("pozitif: CALLS kenarı + evidence satırı kanıtlanır", () => {
    const calls = (positive?.edges ?? []).find(
      (edge) =>
        edge.kind === "CALLS" &&
        edge.from.qualifiedName ===
          "Causoryn.Fixture.Orders.Controllers.OrdersController.GetById" &&
        edge.to.qualifiedName ===
          "Causoryn.Fixture.Orders.Services.OrdersService.GetById",
    );
    expect(calls).toBeDefined();
    expect(calls?.resolution).toBe("verified");
    expect(calls?.evidence?.length ?? 0).toBeGreaterThan(0);
    expect(calls?.evidence?.[0]?.span?.relativePath).toBe(
      "Controllers/OrdersController.cs",
    );
    expect(calls?.evidence?.[0]?.span?.startLine).toBe(32);
  });

  it("pozitif: sonuç createSnapshot kurucusuna beslenebilir (domain uyumu)", () => {
    const snapshot = createSnapshot({
      workspaceId: "adapter-b2-snapshot",
      revision: { id: "rev-b2", sequence: 0 },
      configHash: "adapter-b2-config",
      analyzerFingerprint: `roslyn-worker@${positive?.analyzerVersion ?? "0.1.0"}`,
      state: positive?.state === "partial" ? "partial" : "ready",
      createdAt: "2026-11-04T00:00:00.000Z",
      nodes: positive?.nodes ?? [],
      edges: positive?.edges ?? [],
      evidence: positive?.evidence ?? [],
    });
    expect(snapshot.edges.length).toBeGreaterThan(0);
    const verifiedCalls = snapshot.edges.filter(
      (edge) => edge.kind === "CALLS" && edge.resolution === "verified",
    );
    expect(verifiedCalls.length).toBeGreaterThan(0);
    for (const edge of verifiedCalls) {
      expect(edge.evidenceIds.length).toBeGreaterThan(0);
    }
    // ROUTES_TO zinciri snapshot düzeyinde de ayakta:
    expect(
      snapshot.edges.some(
        (edge) =>
          edge.kind === "ROUTES_TO" && edge.resolution === "verified",
      ),
    ).toBe(true);
  });

  it("pozitif: aynı girdi → birebir aynı sonuç JSON (determinizm)", () => {
    expect(JSON.stringify(positive)).toBe(positiveDeterminismJson);
  });

  it("negatif: olmayan worker DLL → motor çökmez, partial + L0/L1 + explicit warning", async () => {
    const result = await analyzeCSharpWorkspace({
      workspaceId: "adapter-b2-negative",
      files: fixtureFiles(),
      options: {
        workerDllPath: join(
          WORKER_DIR,
          "bin",
          "Debug",
          "net10.0",
          "olmayan-worker.dll",
        ),
        requestTimeoutMs: 30_000,
      },
    });
    expect(result.workerAvailable).toBe(false);
    expect(result.state).toBe("partial");
    expect(result.coverageRatio).toBe(0);
    expect(result.edges).toEqual([]);
    expect(result.evidence).toEqual([]);
    // L0/L1 düşüş: File node'ları korunur, sembol düzeyi üretilmez.
    expect(result.nodes.length).toBe(FIXTURE_FILES.length);
    expect(result.nodes.every((node) => node.kind === "File")).toBe(true);
    // Explicit warning: sebep + düşüş bildirimi.
    expect(
      result.warnings.some(
        (warning) =>
          warning.includes("Roslyn worker kullanılamıyor") &&
          warning.includes("L0/L1"),
      ),
    ).toBe(true);
  });

  it("partial: yarı satır yanıt → timeout + kill + L0/L1 fallback", async () => {
    // Obje sarmalayıcı: TS kontrol akışı closure atamasını daraltmasın.
    const capture: { child: ChildProcess | null } = { child: null };
    const result = await analyzeCSharpWorkspace({
      workspaceId: "adapter-b2-halfline",
      files: fixtureFiles(),
      options: {
        requestTimeoutMs: 400,
        spawnProcess: (command, args, options) => {
          void command;
          void args;
          capture.child = spawn("node", ["-e", HALF_LINE_SCRIPT], options);
          return capture.child;
        },
      },
    });
    expect(result.workerAvailable).toBe(false);
    expect(result.state).toBe("partial");
    expect(result.coverageRatio).toBe(0);
    // Kill kanıtı: takılı sahte süreç adapter tarafından sonlandırıldı.
    expect(capture.child).not.toBeNull();
    expect(capture.child?.killed).toBe(true);
    expect(
      result.warnings.some((warning) => warning.includes("zaman aşımı")),
    ).toBe(true);
  });

  it("partial: anında çöken worker → unavailable fallback, çökmez", async () => {
    const result = await analyzeCSharpWorkspace({
      workspaceId: "adapter-b2-crash",
      files: fixtureFiles(),
      options: {
        requestTimeoutMs: 30_000,
        spawnProcess: (command, args, options) => {
          void command;
          void args;
          return spawn("node", ["-e", CRASH_SCRIPT], options);
        },
      },
    });
    expect(result.workerAvailable).toBe(false);
    expect(result.state).toBe("partial");
    expect(result.nodes.length).toBe(FIXTURE_FILES.length);
    expect(
      result.warnings.some((warning) => warning.includes("cakildi")),
    ).toBe(true);
  });

  it("partial: çöken worker + 200KB payload → stdin EPIPE yarışı motor çökmez", async () => {
    // Sahte süreç stdin'i HİÇ okumadan ölür; adapter >64KB pipe buffer'lık
    // istek yazarken EPIPE oluşabilir — handler'sız 'error' uncaught
    // exception olurdu (denetim bulgusu). Bu test yarışı koşar: süreç
    // çökse bile analyze bir Sonuç döndürmeli, node süreci ayakta kalmalı.
    const bigContent = `class Big { } /* ${"x".repeat(200 * 1024)} */`;
    const result = await analyzeCSharpWorkspace({
      workspaceId: "adapter-b2-crash-bigpayload",
      files: [{ path: "Big/Big.cs", content: bigContent }, ...fixtureFiles()],
      options: {
        requestTimeoutMs: 30_000,
        spawnProcess: (command, args, options) => {
          void command;
          void args;
          return spawn("node", ["-e", CRASH_SCRIPT], options);
        },
      },
    });
    expect(result.workerAvailable).toBe(false);
    expect(result.state).toBe("partial");
    expect(result.nodes.length).toBe(FIXTURE_FILES.length + 1);
  });

  it("partial: worker status:'error' yanıtı → hata kodu warnings'e taşınır", async () => {
    const result = await analyzeCSharpWorkspace({
      workspaceId: "adapter-b2-worker-error",
      files: fixtureFiles(),
      options: {
        requestTimeoutMs: 30_000,
        spawnProcess: (command, args, options) => {
          void command;
          void args;
          return spawn("node", ["-e", WORKER_ERROR_SCRIPT], options);
        },
      },
    });
    expect(result.workerAvailable).toBe(false);
    expect(result.state).toBe("partial");
    expect(result.coverageRatio).toBe(0);
    // Kullanıcı aksiyonu gizlenmez: hata kodu + mesaj warnings'te.
    expect(
      result.warnings.some(
        (warning) =>
          warning.includes("LIMIT_EXCEEDED") &&
          warning.includes("dosya sayısı sınırı"),
      ),
    ).toBe(true);
    expect(result.nodes.length).toBe(FIXTURE_FILES.length);
  });

  it("negatif girdi: boş workspaceId ve mutlak yol DomainError ile reddedilir", async () => {
    await expect(
      analyzeCSharpWorkspace({ workspaceId: "", files: fixtureFiles() }),
    ).rejects.toThrowError(/workspaceId/);
    await expect(
      analyzeCSharpWorkspace({
        workspaceId: "adapter-b2-invalid",
        files: [{ path: "D:/outside/x.cs", content: "class X { }" }],
      }),
    ).rejects.toThrowError(/Mutlak kaynak yolu/);
  });

  it("negatif girdi: '..' kaçışı ve duplicate path adapter API yüzeyinde reddedilir", async () => {
    await expect(
      analyzeCSharpWorkspace({
        workspaceId: "adapter-b2-escape",
        files: [{ path: "../escape.cs", content: "class X { }" }],
      }),
    ).rejects.toThrowError(/kök dışına çıkıyor/);
    await expect(
      analyzeCSharpWorkspace({
        workspaceId: "adapter-b2-duplicate",
        files: [
          { path: "a.cs", content: "class A { }" },
          { path: "a.cs", content: "class A { }" },
        ],
      }),
    ).rejects.toThrowError(/iki kez verildi/);
  });
});
