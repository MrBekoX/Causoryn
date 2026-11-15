/**
 * adapters/python kabul testleri — M1-Python (TŞ v2.1 §7, §7.1).
 *
 * Pozitif: GERÇEK python worker (sabit komut + sabit argüman dizisi)
 * examples/fixture-python-app ile analiz edilir; sonuç packages/domain
 * createSnapshot kurucusuna beslenir (dangling edge / verified-kanıt
 * invariant'ları kurucuda zorlanır — domain uyum kanıtı).
 * Negatif: olmayan python komutu → motor çökmez; workerAvailable=false,
 * state=partial, explicit warning + L0/L1 dosya düzeyi.
 * Partial: sahte süreçlerle (a) yarı satır yanıt → timeout + kill,
 * (b) anında çöken süreç → unavailable fallback, (c) PROTOCOL.md §4
 * status:"error" yanıtı → sebep warnings'te korunur.
 *
 * Güvenlik notu (proje kırmızı çizgisi 6): süreç koşumları spawn/spawnSync
 * ile LİTERAL çalıştırılabilir ("python"/"node") + ARGÜMAN DİZİSİ ve
 * shell: false ile yapılır; worker script yolu repo içi SABİT constant'tır;
 * kullanıcı girdisi asla komut satırına interpole edilmez.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createSnapshot } from "@causoryn/domain";
import {
  analyzePythonWorkspace,
  PYTHON_WORKER_ADAPTER_ID,
  runWorkerAnalyze,
  type PythonAdapterResult,
} from "../src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKER_SCRIPT = join(REPO_ROOT, "native", "python-worker", "worker.py");
const FIXTURE_DIR = join(REPO_ROOT, "examples", "fixture-python-app");

const FIXTURE_FILES = [
  "app.py",
  "services/orders_service.py",
  "repositories/order_repository.py",
] as const;

/* ------------------------------------------------------------------ */
/* Bootstrap: python var mı? Worker script var mı?                     */
/* ------------------------------------------------------------------ */

const pythonCheck = spawnSync("python", ["--version"], {
  encoding: "utf8",
  shell: false,
});
const pythonAvailable = pythonCheck.status === 0;
if (!pythonAvailable) {
  console.error(
    "[python-adapter] python bulunamadı — adapter kabul testleri skip edilir (koşulamadı olarak raporlanır)",
  );
} else if (!existsSync(WORKER_SCRIPT)) {
  throw new Error(
    `python worker script bulunamadı: ${WORKER_SCRIPT} — eksik teslimat testleri fail etmeli`,
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
/** Geçerli PROTOCOL.md v1 hata yanıtı yazıp çıkan sahte süreç. */
const WORKER_ERROR_SCRIPT = `process.stdout.write(JSON.stringify({ id: 'analyze:adapter-python-worker-error', protocolVersion: '1', status: 'error', error: { code: 'LIMIT_EXCEEDED', message: 'dosya sayısı sınırı aşıldı: 5001 > 5000' } }) + '\\n'); process.exit(0);`;

// Python yokluğunda koşulamayan blok: meşru skip.
describe.skipIf(!pythonAvailable)("adapters/python (M1-Python)", () => {
  let positive: PythonAdapterResult | null = null;
  let positiveDeterminismJson = "";

  beforeAll(async () => {
    positive = await analyzePythonWorkspace({
      workspaceId: "adapter-python",
      files: fixtureFiles(),
    });
    positiveDeterminismJson = JSON.stringify(
      await analyzePythonWorkspace({
        workspaceId: "adapter-python",
        files: fixtureFiles(),
      }),
    );
  }, 60_000);

  it("pozitif: worker hazır, state ready, workerAvailable true", () => {
    expect(positive).not.toBeNull();
    expect(positive?.state).toBe("ready");
    expect(positive?.workerAvailable).toBe(true);
    expect(positive?.analyzerId).toBe(PYTHON_WORKER_ADAPTER_ID);
    expect(positive?.analyzerId).toBe("python-worker");
    expect(positive?.coverageRatio).toBe(0.64);
  });

  it("pozitif: capabilities TŞ §7 sözleşmesiyle taşınır (worker'dan)", () => {
    expect(positive?.capabilities.astParse).toBe(true);
    expect(positive?.capabilities.symbolResolution).toBe(true);
    expect(positive?.capabilities.containsEdges).toBe(true);
    expect(positive?.capabilities.callEdges).toBe(true);
    expect(positive?.capabilities.importEdges).toBe(false);
    expect(positive?.capabilities.frameworkLinkers).toBe(false);
    expect(positive?.capabilities.routeDetection).toBe(
      "python-decorator-route-pattern",
    );
  });

  it("pozitif: sonuç createSnapshot kurucusuna beslenebilir (domain uyumu)", () => {
    const snapshot = createSnapshot({
      workspaceId: "adapter-python-snapshot",
      revision: { id: "rev-m1-python", sequence: 0 },
      configHash: "adapter-python-config",
      analyzerFingerprint: `python-worker@${positive?.analyzerVersion ?? "0.1.0"}`,
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
    // route → service → repository zinciri snapshot düzeyinde ayakta.
    // GraphEdge.from/to node ID cinsindendir (TŞ §8); ID → node çözümüyle
    // qualifiedName zinciri doğrulanır.
    const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
    expect(
      snapshot.edges.some(
        (edge) => edge.kind === "ROUTES_TO" && edge.resolution === "verified",
      ),
    ).toBe(true);
    expect(
      snapshot.edges.some(
        (edge) =>
          edge.kind === "CALLS" &&
          edge.resolution === "heuristic" &&
          nodeById.get(edge.from)?.qualifiedName === "app.add_order" &&
          nodeById.get(edge.to)?.qualifiedName ===
            "services.orders_service.create_order",
      ),
    ).toBe(true);
    expect(
      snapshot.edges.some(
        (edge) =>
          edge.kind === "CALLS" &&
          edge.resolution === "heuristic" &&
          nodeById.get(edge.from)?.qualifiedName ===
            "services.orders_service.create_order" &&
          nodeById.get(edge.to)?.qualifiedName ===
            "repositories.order_repository.save",
      ),
    ).toBe(true);
  });

  it("pozitif: aynı girdi → birebir aynı sonuç JSON (determinizm)", () => {
    expect(JSON.stringify(positive)).toBe(positiveDeterminismJson);
  });

  it("negatif: olmayan python komutu → motor çökmez, partial + L0/L1 + explicit warning", async () => {
    const result = await analyzePythonWorkspace({
      workspaceId: "adapter-python-negative",
      files: fixtureFiles(),
      options: {
        pythonCommand: "causoryn-olmayan-python",
        requestTimeoutMs: 30_000,
      },
    });
    expect(result.workerAvailable).toBe(false);
    expect(result.state).toBe("partial");
    expect(result.coverageRatio).toBe(0);
    expect(result.edges).toEqual([]);
    expect(result.evidence).toEqual([]);
    // L0/L1 düşüş: File node'ları korunur (sourceHash'li), sembol düzeyi yok.
    expect(result.nodes.length).toBe(FIXTURE_FILES.length);
    expect(result.nodes.every((node) => node.kind === "File")).toBe(true);
    expect(
      result.warnings.some(
        (warning) =>
          warning.includes("Python worker kullanılamıyor") && warning.includes("L0/L1"),
      ),
    ).toBe(true);
  });

  it("partial: yarı satır yanıt → timeout + kill + L0/L1 fallback", async () => {
    const capture: { child: ChildProcess | null } = { child: null };
    const result = await analyzePythonWorkspace({
      workspaceId: "adapter-python-halfline",
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
    expect(capture.child).not.toBeNull();
    expect(capture.child?.killed).toBe(true);
    expect(
      result.warnings.some((warning) => warning.includes("zaman aşımı")),
    ).toBe(true);
  });

  it("partial: anında çöken worker → unavailable fallback, çökmez", async () => {
    const result = await analyzePythonWorkspace({
      workspaceId: "adapter-python-crash",
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

  it("partial: worker status:'error' yanıtı → hata kodu warnings'e taşınır", async () => {
    const result = await analyzePythonWorkspace({
      workspaceId: "adapter-python-worker-error",
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
    expect(
      result.warnings.some((warning) => warning.includes("LIMIT_EXCEEDED")),
    ).toBe(true);
    expect(
      result.warnings.some((warning) => warning.includes("worker hatası")),
    ).toBe(true);
  });

  it("protokol: worker env'i minimaldir ve PYTHONIOENCODING=utf-8 sabittir (parent bağımsız)", async () => {
    // Takım denetimi bulgusu: worker stderr'i text-mode locale codec'e
    // düşebiliyordu; adapter spawn env'inde PYTHONIOENCODING her zaman
    // 'utf-8' sabitlenir — PARENT DEĞERİ BOZUK OLSA BİLE (cp1254 durumu).
    const capturedEnv: Array<Record<string, string>> = [];
    const original = process.env["PYTHONIOENCODING"];
    process.env["PYTHONIOENCODING"] = "cp1254";
    try {
      const result = await analyzePythonWorkspace({
        workspaceId: "adapter-python-env",
        files: fixtureFiles(),
        options: {
          requestTimeoutMs: 30_000,
          spawnProcess: (command, args, options) => {
            void command;
            void args;
            capturedEnv.push({ ...options.env });
            return spawn("node", ["-e", CRASH_SCRIPT], options);
          },
        },
      });
      expect(result.workerAvailable).toBe(false); // sahte süreç çöktü; env kanıtı zaten yakalandı
    } finally {
      if (original === undefined) {
        delete process.env["PYTHONIOENCODING"];
      } else {
        process.env["PYTHONIOENCODING"] = original;
      }
    }
    expect(capturedEnv.length).toBe(1);
    const env = capturedEnv[0] ?? {};
    expect(env["PYTHONIOENCODING"]).toBe("utf-8");
    // Allowlist disiplini: parent'taki anahtar/token benzeri değerler taşınmaz.
    expect(Object.keys(env).every((key) => key !== "PYTHONPATH")).toBe(true);
    expect(env["PATH"]).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* runWorkerAnalyze doğrudan birim testleri (spawn enjeksiyonsuz)      */
/* ------------------------------------------------------------------ */

describe("adapters/python runWorkerAnalyze", () => {
  it("negatif: başlatılamayan süreç → unavailable + ayrıntı", async () => {
    const outcome = await runWorkerAnalyze({
      pythonCommand: "causoryn-olmayan-python",
      workerScriptPath: WORKER_SCRIPT,
      requestPayload: { id: 1 },
      requestTimeoutMs: 30_000,
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.response).toBeNull();
    expect(outcome.detail.length).toBeGreaterThan(0);
  }, 30_000);

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

  it("negatif: stderr bütçesi aşımı → süreç kill + unavailable (sınırsız stderr birikimi savunması)", async () => {
    const killed: boolean[] = [];
    const outcome = await runWorkerAnalyze({
      pythonCommand: "python",
      workerScriptPath: WORKER_SCRIPT,
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
    expect(outcome.detail).toContain("sınırını aştı");
    // Saklanan kuyruk bütçeye kırpılır: birikim sınırsız büyüyemez.
    expect(outcome.stderr.length).toBeLessThanOrEqual(64);
    expect(killed.length).toBe(1);
  });

  it("pozitif kontrol: bütçe altındaki stderr yanıtla birlikte taşınır", async () => {
    const outcome = await runWorkerAnalyze({
      pythonCommand: "python",
      workerScriptPath: WORKER_SCRIPT,
      requestPayload: { id: "stderr-ok" },
      requestTimeoutMs: 5_000,
      stderrMaxChars: 4_096,
      spawnProcess: () =>
        makeFakeWorkerChild({
          stderrChunks: ["[python-worker] normal log\n"],
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
