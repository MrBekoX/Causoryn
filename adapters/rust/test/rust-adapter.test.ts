/**
 * adapters/rust kabul testleri — M1-Rust (TŞ v2.1 §7, §7.1).
 *
 * Pozitif: gerçek Rust worker (repo-içi sabit binary yolu, boş argüman
 * dizisi) fixture-rust-app ile analiz edilir; kenarlar + evidence
 * kanıtlanır ve sonuç packages/domain createSnapshot kurucusuna beslenir
 * (uyum kanıtı: dangling edge / verified-kanıt invariant'ları kurucuda
 * zorlanır).
 * Negatif: olmayan worker binary dizini → adapter motoru düşürmez;
 * workerAvailable=false, state=partial, explicit warning + L0/L1 dosya
 * düzeyi.
 * Partial: sahte child process ile (a) yarı satır yanıt → framing kısmi
 * satır sınırı + timeout → kill kanıtı, (b) anında çöken süreç →
 * unavailable fallback, (c) worker status:"error" yanıtı → hata kodu
 * warnings'e taşınır.
 *
 * Güvenlik notu (proje kırmızı çizgisi 6): süreç koşumları spawnSync/spawn
 * ile LİTERAL "cargo" (derleme) ve LİTERAL binary adı + param-enjeksiyonlu
 * spawnProcess deseni (worker) ile yapılır; yollar repo içi SABİT yol
 * constant'larıdır; kullanıcı girdisi asla komut satırına interpole
 * edilmez.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createSnapshot } from "@causoryn/domain";
import { isCargoAvailable } from "../src/cargo.js";
import {
  analyzeRustWorkspace,
  type RustAdapterResult,
} from "../src/index.js";
import {
  buildRustWorkerBinary,
  RUST_WORKER_BINARY_PATH,
} from "../../../tests/rust-worker-build.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE_DIR = join(REPO_ROOT, "examples", "fixture-rust-app");

const FIXTURE_FILES = [
  "main.rs",
  "repositories.rs",
  "services.rs",
] as const;

/* ------------------------------------------------------------------ */
/* Bootstrap: cargo var mı? Build HER TURDA koşturulur ve sonucu      */
/* KONTROL EDİLİR (B1 kabul düzeniyle aynı disiplin).                  */
/* ------------------------------------------------------------------ */

const cargoAvailable = isCargoAvailable();
if (!cargoAvailable) {
  console.error(
    "[rust-adapter] cargo toolchain bulunamadı — kabul testleri skip edilir (koşulamadı olarak raporlanır)",
  );
} else {
  // Build serileştirme: tests/rust-worker.test.ts paralel fork'ta aynı
  // `cargo build` çağrısını yapar; ortak kilitli builder yarışı kaldırır
  // (tests/rust-worker-build.ts).
  const build = buildRustWorkerBinary();
  if (build.status !== 0 || !existsSync(RUST_WORKER_BINARY_PATH)) {
    throw new Error(
      `worker derlemesi başarısız (exit=${String(build.status)}) — adapter testleri eski binary'ye karşı koşulmaz` +
        (build.stderr ? ` [stderr]: ${build.stderr.slice(0, 400)}` : "") +
        (build.stdout ? ` [stdout]: ${build.stdout.slice(-400)}` : ""),
    );
  }
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
/** Geçerli PROTOCOL.md v1 hata yanıtı yazıp çıkan sahte süreç. */
const WORKER_ERROR_SCRIPT = `process.stdout.write(JSON.stringify({ id: 'analyze:adapter-rust-worker-error', protocolVersion: '1', status: 'error', error: { code: 'LIMIT_EXCEEDED', message: 'dosya sayısı sınırı aşıldı: 5001 > 5000' } }) + '\\n'); process.exit(0);`;

/* ------------------------------------------------------------------ */
/* Testler                                                             */
/* ------------------------------------------------------------------ */

// Cargo yokluğunda koşulamayan blok: meşru skip (PROTOCOL.md §7 kuralı).
describe.skipIf(!cargoAvailable)("adapters/rust (M1)", () => {
  let positive: RustAdapterResult | null = null;
  let positiveDeterminismJson = "";

  beforeAll(
    async () => {
      positive = await analyzeRustWorkspace({
        workspaceId: "adapter-rust-m1",
        files: fixtureFiles(),
      });
      positiveDeterminismJson = JSON.stringify(
        await analyzeRustWorkspace({
          workspaceId: "adapter-rust-m1",
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
    expect(positive?.analyzerId).toBe("rust-worker");
    expect(positive?.coverageRatio).toBeGreaterThan(0);
  });

  it("pozitif: capabilities TŞ §7 sözleşmesiyle taşınır (worker'dan)", () => {
    expect(positive?.capabilities.astParse).toBe(true);
    expect(positive?.capabilities.symbolResolution).toBe(true);
    expect(positive?.capabilities.containsEdges).toBe(true);
    expect(positive?.capabilities.callEdges).toBe(true);
    expect(positive?.capabilities.importEdges).toBe(false);
    expect(positive?.capabilities.frameworkLinkers).toBe(false);
    expect(positive?.capabilities.routeDetection).toBe(
      "rust-attribute-macro-route-pattern",
    );
  });

  it("pozitif: CALLS kenarı + evidence satırı kanıtlanır", () => {
    const calls = (positive?.edges ?? []).find(
      (edge) =>
        edge.kind === "CALLS" &&
        edge.from.qualifiedName === "crate::list_orders" &&
        edge.to.qualifiedName === "crate::create_audit_entry",
    );
    expect(calls).toBeDefined();
    expect(calls?.resolution).toBe("verified");
    expect(calls?.evidence?.length ?? 0).toBeGreaterThan(0);
    expect(calls?.evidence?.[0]?.span?.relativePath).toBe("main.rs");
    expect(calls?.evidence?.[0]?.analyzerId).toBe("rust-worker");
  });

  it("pozitif: ROUTES_TO zinciri worker çıktısında ayakta", () => {
    const route = (positive?.edges ?? []).find(
      (edge) =>
        edge.kind === "ROUTES_TO" &&
        edge.from.qualifiedName === "GET /orders" &&
        edge.to.qualifiedName === "crate::list_orders",
    );
    expect(route).toBeDefined();
    expect(route?.resolution).toBe("verified");
  });

  it("pozitif: sonuç createSnapshot kurucusuna beslenebilir (domain uyumu)", () => {
    const snapshot = createSnapshot({
      workspaceId: "adapter-rust-m1-snapshot",
      revision: { id: "rev-rust-m1", sequence: 0 },
      configHash: "adapter-rust-m1-config",
      analyzerFingerprint: `rust-worker@${positive?.analyzerVersion ?? "0.1.0"}`,
      state: positive?.state === "partial" ? "partial" : "ready",
      createdAt: "2026-11-15T00:00:00.000Z",
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

  it("negatif: olmayan worker binary dizini → motor çökmez, partial + L0/L1 + explicit warning", async () => {
    const result = await analyzeRustWorkspace({
      workspaceId: "adapter-rust-negative",
      files: fixtureFiles(),
      options: {
        workerDir: join(REPO_ROOT, "native", "rust-worker", "target", "olmayan-dizin"),
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
      result.warnings.some((warning) => warning.includes("L0/L1")),
    ).toBe(true);
  });

  it("partial: yarı satır yanıt → timeout + kill + L0/L1 fallback", async () => {
    // Obje sarmalayıcı: TS kontrol akışı closure atamasını daraltmasın.
    const capture: { child: ChildProcess | null } = { child: null };
    const result = await analyzeRustWorkspace({
      workspaceId: "adapter-rust-halfline",
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
    const result = await analyzeRustWorkspace({
      workspaceId: "adapter-rust-crash",
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
    // exception olurdu. Bu test yarışı koşar: süreç çökse bile analyze bir
    // Sonuç döndürmeli, node süreci ayakta kalmalı.
    const bigContent = `fn big() { /* ${"x".repeat(200 * 1024)} */ }`;
    const result = await analyzeRustWorkspace({
      workspaceId: "adapter-rust-crash-bigpayload",
      files: [{ path: "Big/Big.rs", content: bigContent }, ...fixtureFiles()],
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
    const result = await analyzeRustWorkspace({
      workspaceId: "adapter-rust-worker-error",
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
      analyzeRustWorkspace({ workspaceId: "", files: fixtureFiles() }),
    ).rejects.toThrowError(/workspaceId/);
    await expect(
      analyzeRustWorkspace({
        workspaceId: "adapter-rust-invalid",
        files: [{ path: "D:/outside/x.rs", content: "fn x() { }" }],
      }),
    ).rejects.toThrowError(/Mutlak kaynak yolu/);
  });

  it("negatif girdi: '..' kaçışı ve duplicate path adapter API yüzeyinde reddedilir", async () => {
    await expect(
      analyzeRustWorkspace({
        workspaceId: "adapter-rust-escape",
        files: [{ path: "../escape.rs", content: "fn x() { }" }],
      }),
    ).rejects.toThrowError(/kök dışına çıkıyor/);
    await expect(
      analyzeRustWorkspace({
        workspaceId: "adapter-rust-duplicate",
        files: [
          { path: "a.rs", content: "fn a() { }" },
          { path: "a.rs", content: "fn a() { }" },
        ],
      }),
    ).rejects.toThrowError(/iki kez verildi/);
  });
});
