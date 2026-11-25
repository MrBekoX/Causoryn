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
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createSnapshot } from "@causoryn/domain";
import { resolveWindowsSystemExecutable } from "@causoryn/sidecar-ipc";
import { isCargoAvailable } from "../src/cargo.js";
import {
  analyzeRustWorkspace,
  runCargoBuild,
  runWorkerAnalyze,
  type RustAdapterResult,
} from "../src/index.js";
import {
  buildRustWorkerBinary,
  RUST_WORKER_BINARY_PATH,
} from "../../../tests/rust-worker-build.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** Absolute fake manifest for spawn-injected cargo tests (cargo is never started). */
const FAKE_MANIFEST_PATH = join(REPO_ROOT, "native", "rust-worker", "sahte", "Cargo.toml");
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
const WORKER_ERROR_SCRIPT = `process.stdout.write(JSON.stringify({ id: 'analyze:adapter-rust-worker-error', protocolVersion: '1', status: 'error', error: { code: 'LIMIT_EXCEEDED', message: 'file count limit exceeded: 5001 > 5000' } }) + '\\n'); process.exit(0);`;

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

  it("dürüstlük (Task 1.5): 2-segment son ek eşleşmesi (Type::method / mod::fn) verified DEĞİL heuristic + ambiguity döner", () => {
    const svcNew = (positive?.edges ?? []).find(
      (edge) =>
        edge.kind === "CALLS" &&
        edge.from.qualifiedName === "crate::list_orders" &&
        edge.to.qualifiedName === "crate::services::OrdersService::new",
    );
    expect(svcNew).toBeDefined();
    expect(svcNew?.resolution).toBe("heuristic");
    expect(svcNew?.resolution).not.toBe("verified");
    expect(svcNew?.ambiguity?.candidates).toEqual([
      "crate::services::OrdersService::new",
    ]);
    expect(svcNew?.ambiguity?.reason).toContain(
      "unverified-module-prefix-suffix-match",
    );

    const repoNew = (positive?.edges ?? []).find(
      (edge) =>
        edge.kind === "CALLS" &&
        edge.from.qualifiedName === "crate::services::OrdersService::new" &&
        edge.to.qualifiedName === "crate::repositories::OrderRepository::new",
    );
    expect(repoNew).toBeDefined();
    expect(repoNew?.resolution).toBe("heuristic");
    expect(repoNew?.ambiguity?.reason).toContain(
      "unverified-module-prefix-suffix-match",
    );
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
      result.warnings.some((warning) => warning.includes("timeout")),
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
          warning.includes("file count limit exceeded"),
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
    ).rejects.toThrowError(/Absolute source paths are not accepted/);
  });

  it("negatif girdi: '..' kaçışı ve duplicate path adapter API yüzeyinde reddedilir", async () => {
    await expect(
      analyzeRustWorkspace({
        workspaceId: "adapter-rust-escape",
        files: [{ path: "../escape.rs", content: "fn x() { }" }],
      }),
    ).rejects.toThrowError(/escapes the workspace root/);
    await expect(
      analyzeRustWorkspace({
        workspaceId: "adapter-rust-duplicate",
        files: [
          { path: "a.rs", content: "fn a() { }" },
          { path: "a.rs", content: "fn a() { }" },
        ],
      }),
    ).rejects.toThrowError(/was given twice/);
  });
});

/* ------------------------------------------------------------------ */
/* worker-process birim davranışları (cargo gerektirmez)               */
/* ------------------------------------------------------------------ */

/**
 * Sentetik worker: önce verilen stderr parçalarını, sonra (istendiyse)
 * geçerli protokol yanıtını stdout'a yazar; süreç kapanmaz (timeout
 * penceresi canlı kalmalı — sınırsız birikim senaryosu).
 */
function makeFakeWorkerChild(io: {
  stderrChunks?: string[];
  stdoutResponseLine?: string;
}): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter();
  const record = child as unknown as Record<string, unknown>;
  record.stdout = stdout;
  record.stderr = stderr;
  record.stdin = Object.assign(stdin, {
    write: () => true,
    end: () => {},
  });
  record.killed = false;
  record.exitCode = null;
  record.signalCode = null;
  record.kill = () => true;
  queueMicrotask(() => {
    for (const chunk of io.stderrChunks ?? []) {
      stderr.emit("data", Buffer.from(chunk, "utf8"));
    }
    if (io.stdoutResponseLine !== undefined) {
      stdout.emit("data", Buffer.from(`${io.stdoutResponseLine}\n`, "utf8"));
    }
  });
  return child;
}

describe("adapters/rust runWorkerAnalyze birim davranışları (cargo gerektirmez)", () => {
  it("negatif: stderr bütçesi aşımı → süreç kill + unavailable (sınırsız stderr birikimi savunması)", async () => {
    const killed: boolean[] = [];
    const outcome = await runWorkerAnalyze({
      workerDir: join(REPO_ROOT, "native", "rust-worker", "target", "debug"),
      workerBinaryName: "causoryn-rust-worker.exe",
      requestPayload: { id: "stderr-cap" },
      requestTimeoutMs: 300,
      stderrMaxChars: 64,
      spawnProcess: () => {
        const child = makeFakeWorkerChild({
          stderrChunks: ["a".repeat(40), "b".repeat(40)],
        });
        const record = child as unknown as Record<string, unknown>;
        record.kill = () => {
          killed.push(true);
          return true;
        };
        return child;
      },
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.detail).toContain("character limit");
    // Saklanan kuyruk bütçeye kırpılır: birikim sınırsız büyüyemez.
    expect(outcome.stderr.length).toBeLessThanOrEqual(64);
    expect(killed.length).toBe(1);
  });

  it("pozitif kontrol: bütçe altındaki stderr yanıtla birlikte taşınır", async () => {
    const outcome = await runWorkerAnalyze({
      workerDir: join(REPO_ROOT, "native", "rust-worker", "target", "debug"),
      workerBinaryName: "causoryn-rust-worker.exe",
      requestPayload: { id: "stderr-ok" },
      requestTimeoutMs: 5_000,
      stderrMaxChars: 4_096,
      spawnProcess: () =>
        makeFakeWorkerChild({
          stderrChunks: ["[rust-worker] normal log\n"],
          stdoutResponseLine: JSON.stringify({
            id: "stderr-ok",
            protocolVersion: "1",
            status: "ready",
          }),
        }),
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.stderr).toContain("normal log");
  });
});

/* ------------------------------------------------------------------ */
/* runCargoBuild çıktı bütçesi (cargo gerektirmez — spawn enjeksiyonu)  */
/* ------------------------------------------------------------------ */

describe("runCargoBuild çıktı bütçesi (spawn enjeksiyonlu)", () => {
  it("negatif: stdout bütçesi aşımı → süreç kill + status:null + açık spawnError", async () => {
    const killed: boolean[] = [];
    const outcome = await runCargoBuild({
      manifestPath: FAKE_MANIFEST_PATH,
      cargoExecutable: process.execPath,
      timeoutMs: 5_000,
      outputMaxChars: 64,
      spawnFn: () => {
        const child = makeFakeWorkerChild({});
        // cargo akışında satır framing'i yoktur — büyük tek parça emit edilir.
        const record = child as unknown as Record<string, unknown>;
        record.kill = () => {
          killed.push(true);
          return true;
        };
        queueMicrotask(() => {
          const stdout = record.stdout as EventEmitter;
          stdout.emit("data", Buffer.from("x".repeat(100), "utf8"));
        });
        return child;
      },
    });
    expect(outcome.status).toBeNull();
    expect(outcome.spawnError).toContain("character limit");
    expect(outcome.stdout.length).toBeLessThanOrEqual(64);
    expect(killed.length).toBe(1);
  });

  it("negatif: stderr bütçesi aşımı → süreç kill + spawnError akış adını taşır", async () => {
    const outcome = await runCargoBuild({
      manifestPath: FAKE_MANIFEST_PATH,
      cargoExecutable: process.execPath,
      timeoutMs: 5_000,
      outputMaxChars: 64,
      spawnFn: () => {
        const child = makeFakeWorkerChild({});
        queueMicrotask(() => {
          const stderr = (child as unknown as Record<string, unknown>)
            .stderr as EventEmitter;
          stderr.emit("data", Buffer.from("e".repeat(100), "utf8"));
        });
        return child;
      },
    });
    expect(outcome.status).toBeNull();
    expect(outcome.spawnError).toContain("stderr");
    expect(outcome.spawnError).toContain("character limit");
    expect(outcome.stderr.length).toBeLessThanOrEqual(64);
  });

  it("pozitif kontrol: bütçe altındaki koşum exit kodunu aynen taşır", async () => {
    const outcome = await runCargoBuild({
      manifestPath: FAKE_MANIFEST_PATH,
      cargoExecutable: process.execPath,
      timeoutMs: 5_000,
      outputMaxChars: 4_096,
      spawnFn: () => {
        const child = makeFakeWorkerChild({});
        queueMicrotask(() => {
          const stdout = (child as unknown as Record<string, unknown>)
            .stdout as EventEmitter;
          stdout.emit("data", Buffer.from("derleme tamam\n", "utf8"));
          child.emit("exit", 0, null);
        });
        return child;
      },
    });
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain("derleme tamam");
    expect(outcome.spawnError).toBe("");
  });

  it("negatif: zaman aşımı → doğrudan kill + win32 AĞAÇ-KILL (torun rustc/codegen süreçleri)", async () => {
    if (process.platform !== "win32") {
      // Ağaç-kill savunması win32'ye özeldir; diğer platformlarda mevcut
      // doğrudan kill davranışı korunur (dal koşullaması testte de açık).
      expect(true).toBe(true);
      return;
    }
    const spawned: Array<{ command: string; args: readonly string[] }> = [];
    const killed: boolean[] = [];
    const events: string[] = [];
    const outcome = await runCargoBuild({
      manifestPath: FAKE_MANIFEST_PATH,
      cargoExecutable: process.execPath,
      timeoutMs: 120,
      spawnFn: (command, args) => {
        spawned.push({ command, args: [...args] });
        const isCargo = command === process.execPath;
        events.push(isCargo ? "spawn:cargo" : "spawn:taskkill");
        const child = makeFakeWorkerChild({});
        const record = child as unknown as Record<string, unknown>;
        record.pid = isCargo ? 7777 : undefined;
        record.kill = () => {
          events.push(isCargo ? "kill:cargo" : "kill:taskkill");
          killed.push(true);
          return true;
        };
        if (!isCargo) {
          setTimeout(() => {
            events.push("exit:taskkill");
            child.emit("exit", 0, null);
          }, 20);
        }
        return child;
      },
    });
    expect(outcome.status).toBeNull();
    expect(outcome.spawnError).toContain("timeout");
    // Doğrudan kill her koşulda uygulanır (ağaç-kill ek savunmadır); it only
    // follows once taskkill /T has finished with the cargo parent still alive.
    await vi.waitFor(() => {
      expect(killed.length).toBe(1);
    });
    expect(events).toEqual(["spawn:cargo", "spawn:taskkill", "exit:taskkill", "kill:cargo"]);
    // İkinci spawn: LİTERAL "taskkill" + SADECE kendi çocuğumuzun sayısal
    // pid'i (/T ağaç, /F zorla). rustc/codegen torun süreçleri finite'dir
    // ama savunma derinliği go worker deseniyle sağlanır.
    expect(spawned.length).toBe(2);
    expect(spawned[0]?.command).toBe(process.execPath);
    expect(spawned[1]?.command).toBe(resolveWindowsSystemExecutable("taskkill.exe"));
    expect(spawned[1]?.args).toEqual(["/pid", "7777", "/T", "/F"]);
  }, 10_000);

  it.skipIf(process.platform !== "win32")(
    "output budget overflow also tree-kills the build (taskkill /T before the direct kill)",
    async () => {
      const events: string[] = [];
      const outcome = await runCargoBuild({
        manifestPath: FAKE_MANIFEST_PATH,
        cargoExecutable: process.execPath,
        timeoutMs: 5_000,
        outputMaxChars: 64,
        spawnFn: (command, args) => {
          const isCargo = command === process.execPath;
          events.push(isCargo ? "spawn:cargo" : `spawn:taskkill ${args.join(" ")}`);
          const child = makeFakeWorkerChild({});
          const record = child as unknown as Record<string, unknown>;
          record.pid = isCargo ? 7778 : undefined;
          record.kill = () => {
            events.push(isCargo ? "kill:cargo" : "kill:taskkill");
            return true;
          };
          if (isCargo) {
            queueMicrotask(() => {
              (record.stdout as EventEmitter).emit("data", Buffer.from("x".repeat(100), "utf8"));
            });
          } else {
            setTimeout(() => {
              events.push("exit:taskkill");
              child.emit("exit", 0, null);
            }, 20);
          }
          return child;
        },
      });
      expect(outcome.status).toBeNull();
      expect(outcome.spawnError).toContain("character limit");
      await vi.waitFor(() => {
        expect(events).toContain("kill:cargo");
      });
      expect(events).toEqual([
        "spawn:cargo",
        "spawn:taskkill /pid 7778 /T /F",
        "exit:taskkill",
        "kill:cargo",
      ]);
    },
  );

  it("pozitif kontrol: zaman aşımına uğramayan koşumda ağaç-kill çağrılmaz", async () => {
    const spawned: Array<{ command: string }> = [];
    const outcome = await runCargoBuild({
      manifestPath: FAKE_MANIFEST_PATH,
      cargoExecutable: process.execPath,
      timeoutMs: 5_000,
      spawnFn: (command) => {
        spawned.push({ command });
        const child = makeFakeWorkerChild({});
        queueMicrotask(() => {
          child.emit("exit", 0, null);
        });
        return child;
      },
    });
    expect(outcome.status).toBe(0);
    expect(spawned.length).toBe(1);
    expect(spawned[0]?.command).toBe(process.execPath);
  });
});
