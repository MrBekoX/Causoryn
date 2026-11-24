import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CORE_TOOL_NAMES, TOOL_NAMES } from "../src/version.js";

/**
 * Sprint-7 F1 — esbuild bundle testleri (TŞ v2.1 §17.1/§17.2).
 *
 * Kanıt: TŞ §17.1 "Eklenti paketinde scripts/mcp-server.mjs gerçekten
 * derlenmiş olmalı; root'taki kaynak TS dosyasına işaret edilemez" +
 * §17.2 "./dist/mcp-server.mjs gerçekten mevcutsa geçerlidir" · TŞ §10.1
 * stdout disiplini · wiki/decisions.md ADR-010 (çalışmayan şey Done
 * yazılmaz; 'tek dosya' iddiası dürüst raporlanır).
 *
 * Paketleme gerçeği (görev sözleşmesi): better-sqlite3 NATİF modüldür;
 * esbuild native .node dosyasını tek dosyaya gömemez. Bundle onu EXTERNAL
 * bırakır; build script'i better-sqlite3'ün çalışma zamanı katmanını
 * (package.json + lib/** + prebuilds/**) dist/node_modules/ altına
 * deterministik kopyalar. Böylece dist/mcp-server.mjs, repo node_modules'ü
 * YOKKEN bile bare specifier'ı kendi yanındaki node_modules'ten çözer
 * (Node'un standart up-tree resolution'ı; ayrı bir loader shim gerekmez —
 * karar notu scripts/build-bundle.mjs başlığında).
 *
 * Testler üçlü kurala uyar:
 * - POZİTİF: bundle gerçek spawn (InMemoryTransport DEĞİL) ile stdio'dan
 *   initialize + tools/list (TAM OLARAK 29 araç) + bir tools/call yanıtlar;
 *   stdout yalnızca JSON-RPC taşır.
 * - NEGATİF: bundle dosyası yokken açık hata; vendored native eksikken
 *   (yalnızca mjs kopyalanır) anlaşılır hata (better-sqlite3 adı geçer).
 * - PARTIAL: klon-benzeri ortam (yalnızca mjs + node_modules kopyası,
 *   os.tmpdir altında — repo node_modules'üne up-tree erişim yok) tam
 *   protokol akışı çalışır; determinizm: iki build bit-bit aynı çıktı.
 */

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(path.dirname(PKG_DIR));
const DIST_DIR = path.join(PKG_DIR, "dist");
const BUNDLE_PATH = path.join(DIST_DIR, "mcp-server.mjs");
const WORKER_BUNDLE_PATH = path.join(DIST_DIR, "index-worker.mjs");
const LEGAL_PATH = path.join(DIST_DIR, "mcp-server.mjs.LEGAL.txt");
const VENDOR_ROOT = path.join(DIST_DIR, "node_modules", "better-sqlite3");
const MANIFEST_PATH = path.join(DIST_DIR, "bundle-manifest.json");
const ANTIGRAVITY_SCRIPTS_DIR = path.join(
  REPO_ROOT,
  "integrations",
  "antigravity",
  "causoryn",
  "scripts",
);
const ANTIGRAVITY_BUNDLE_PATH = path.join(ANTIGRAVITY_SCRIPTS_DIR, "mcp-server.mjs");
const ANTIGRAVITY_WORKER_BUNDLE_PATH = path.join(ANTIGRAVITY_SCRIPTS_DIR, "index-worker.mjs");
const ANTIGRAVITY_LEGAL_PATH = path.join(ANTIGRAVITY_SCRIPTS_DIR, "mcp-server.mjs.LEGAL.txt");
const ANTIGRAVITY_VENDOR_ROOT = path.join(
  ANTIGRAVITY_SCRIPTS_DIR,
  "node_modules",
  "better-sqlite3",
);
const ANTIGRAVITY_MANIFEST_PATH = path.join(
  ANTIGRAVITY_SCRIPTS_DIR,
  "bundle-manifest.json",
);
const BUILD_SCRIPT = path.join(PKG_DIR, "scripts", "build-bundle.mjs");
const FIXTURE_ROOT = path.join(REPO_ROOT, "examples", "fixture-ts-orders");

const CONFIG = {
  workspaceId: "default",
  allowRoots: [FIXTURE_ROOT],
  results: { maxNodes: 250, maxSymbols: 100 },
  autoIndex: true,
};

const READY_MARKER = "causoryn mcp server hazir";

interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface SpawnResult {
  readonly exitCode: number | null;
  readonly stdoutLines: readonly string[];
  readonly stderrLines: readonly string[];
  readonly responseOf: (id: number) => JsonRpcMessage;
}

/** sha256 of a file (determinizm kanıtı için). */
function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** build-bundle script'ini koşturur (npm run build:bundle ile aynı giriş). */
function runBuild(): void {
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    cwd: PKG_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Verilen bundle yolunu GERÇEK child process olarak spawn eder ve NDJSON
 * JSON-RPC el sıkışması yürütür (stdio-stdout.test.ts deseni: satır
 * tamponu — tools/list yanıtı tek satırlık dev JSON'dur ve chunk
 * sınırında parçalanabilir).
 */
function runBundleSession(
  bundlePath: string,
  cwd: string,
  requestCount = 3,
): Promise<SpawnResult> {
  const child: ChildProcess = spawn(process.execPath, [bundlePath], {
    cwd,
    env: { ...process.env, CAUSORYN_CONFIG: JSON.stringify(CONFIG) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const responses = new Map<number, JsonRpcMessage>();
  const pending = new Map<number, (message: JsonRpcMessage) => void>();

  const readyPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`bundle hazır olmadı (30s). stderr=${JSON.stringify(stderrLines)}`)),
      30_000,
    );
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        stderrLines.push(trimmed);
        if (trimmed.includes(READY_MARKER)) {
          clearTimeout(timer);
          resolve();
        }
      }
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      reject(new Error(`bundle başlamadan kapandı (exit). stderr=${JSON.stringify(stderrLines)}`));
    });
  });

  const exitPromise = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });


  child.stdout?.setEncoding("utf8");
  let stdoutBuffer = "";
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf("\n");
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      stdoutLines.push(trimmed);
      try {
        const message = JSON.parse(trimmed) as JsonRpcMessage;
        const id = typeof message.id === "number" ? message.id : undefined;
        if (id !== undefined && pending.has(id)) {
          pending.get(id)?.(message);
          pending.delete(id);
        }
      } catch {
        // saf olmayan satır: çağıran tarafın stdout saflık assert'i raporlar
      }
    }
  });

  return readyPromise.then(() => {
    const messages: readonly unknown[] = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "bundle-smoke-test", version: "0.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "causoryn_status", arguments: {} },
      },
    ];
    // pending kaydı YALNIZCA aşağıdaki allResponses kurulumunda yapılır:
    // buradaki id'lerin üzerine aynı senkron blokta resolver yazıldığı için
    // önceki kayıt döngüsü ölü koddur (denetim bulgusu, 2026-11-09).
    for (const message of messages) {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    }

    const allResponses = Promise.all(
      Array.from({ length: requestCount }, (_v, i) => i + 1).map(async (id) => {
        await new Promise<void>((resolve) => {
          pending.set(id, (message) => {
            responses.set(id, message);
            resolve();
          });
        });
        if (!responses.has(id)) {
          throw new Error(`id=${id} yanıtı alınamadı`);
        }
      }),
    );

    return allResponses
      .then(() => {
        child.stdin?.end();
        return exitPromise.then((exitCode) => ({
          exitCode,
          stdoutLines,
          stderrLines,
          responseOf: (id: number): JsonRpcMessage => {
            const message = responses.get(id);
            if (message === undefined) {
              throw new Error(`id=${id} yanıtı yok; stdout=${JSON.stringify(stdoutLines)}`);
            }
            return message;
          },
        }));
      })
      .catch((error: unknown) => {
        child.kill("SIGKILL");
        throw error;
      });
  });
}

/** tmp altında temizlenen geçici dizin (kırmızı çizgi 2: workspace'e yazım yok). */
function makeTempCloneDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

const tempDirs: string[] = [];

beforeAll(() => {
  // Test kendi artefaktını üretir: dist commit edilmediği için (kök
  // .gitignore satır 3: dist/) her ortamda önce bundle kurulur.
  runBuild();
}, 180_000);

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("F1 bundle — build artefaktı", () => {
  it("POZİTİF: dist/mcp-server.mjs + vendored better-sqlite3 + deterministik manifest üretilir", () => {
    expect(existsSync(BUNDLE_PATH), "bundle üretilmedi").toBe(true);
    expect(
      existsSync(path.join(VENDOR_ROOT, "package.json")),
      "vendored better-sqlite3 package.json yok",
    ).toBe(true);
    expect(
      existsSync(path.join(VENDOR_ROOT, "LICENSE")),
      "vendored better-sqlite3 LICENSE yok",
    ).toBe(true);
    expect(
      existsSync(LEGAL_PATH),
      "esbuild linked legal comments dosyası (mcp-server.mjs.LEGAL.txt) yok",
    ).toBe(true);
    expect(
      existsSync(path.join(VENDOR_ROOT, "lib", "index.js")),
      "vendored better-sqlite3 lib katmanı yok",
    ).toBe(true);
    expect(
      existsSync(
        path.join(VENDOR_ROOT, "prebuilds", `win32-${process.arch}.node`),
      ),
      "bu platformun prebuild'i vendored dizinde yok",
    ).toBe(true);
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
      files?: Record<string, string>;
    };
    expect(manifest.files?.["mcp-server.mjs"], "manifest bundle hash'i yok").toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(
      manifest.files?.["mcp-server.mjs.LEGAL.txt"],
      "manifest LEGAL.txt hash'i yok",
    ).toMatch(/^[0-9a-f]{64}$/);
    expect(
      manifest.files?.[["node_modules", "better-sqlite3", "LICENSE"].join("/")],
      "manifest better-sqlite3 LICENSE hash'i yok",
    ).toMatch(/^[0-9a-f]{64}$/);
    expect(
      manifest.files?.[
        ["node_modules", "better-sqlite3", "lib", "index.js"].join("/")
      ],
      "manifest vendor hash'i yok",
    ).toMatch(/^[0-9a-f]{64}$/);
    expect(
      manifest.files?.[
        ["node_modules", "better-sqlite3", "prebuilds", `win32-${process.arch}.node`].join("/")
      ],
    ).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);
});

describe("F1 bundle — gerçek spawn smoke testi (stdio, InMemoryTransport değil)", () => {
  it("POZİTİF: initialize + tools/list (29 araç) + tools/call; stdout yalnızca JSON-RPC", async () => {
    const result = await runBundleSession(BUNDLE_PATH, PKG_DIR);

    // stdout saflığı (TŞ §10.1): her satır geçerli JSON-RPC 2.0 mesajı.
    expect(result.stdoutLines.length).toBe(3);
    for (const line of result.stdoutLines) {
      let message: JsonRpcMessage | undefined;
      expect(() => {
        message = JSON.parse(line) as JsonRpcMessage;
      }).not.toThrow();
      expect(message?.jsonrpc, `stdout satırı protokol dışı: ${line}`).toBe("2.0");
    }

    const initMsg = result.responseOf(1);
    const initResult = initMsg.result as {
      serverInfo?: { name?: string; version?: string };
    };
    expect(initResult.serverInfo?.name).toBe("causoryn");
    expect(typeof initResult.serverInfo?.version).toBe("string");

    const listMsg = result.responseOf(2);
    const listResult = listMsg.result as { tools?: Array<{ name?: string }> };
    const listedNames = listResult.tools?.map((tool) => tool.name).sort();
    // Default core profile exposes exact 11 CORE_TOOL_NAMES (legacy TOOL_NAMES stays 29).
    expect(TOOL_NAMES.length).toBe(29);
    expect(CORE_TOOL_NAMES.length).toBe(11);
    expect(listedNames).toEqual([...CORE_TOOL_NAMES].sort());

    const callMsg = result.responseOf(3);
    const callResult = callMsg.result as {
      structuredContent?: { status?: string; schemaVersion?: string };
      isError?: boolean;
    };
    expect(callResult.isError).toBeFalsy();
    expect(callResult.structuredContent?.schemaVersion).toBe("2.0");
    expect(callResult.structuredContent?.status).toBe("ok");

    expect(result.stderrLines.some((line) => line.includes(READY_MARKER))).toBe(true);
    expect(result.exitCode).toBe(0);
  }, 120_000);
});

describe("F1 bundle — negatif durumlar", () => {
  it("NEGATİF: bundle dosyası yokken spawn açık hata verir (EXIT 1, ERR_MODULE_NOT_FOUND)", async () => {
    const missing = path.join(DIST_DIR, "yok-boyle-bir-bundle.mjs");
    const child = spawn(process.execPath, [missing], {
      cwd: PKG_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks: string[] = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => stderrChunks.push(chunk));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });
    const stderrText = stderrChunks.join("");
    expect(exitCode).not.toBe(0);
    expect(stderrText).toContain("Cannot find module");
    expect(stderrText).toContain("yok-boyle-bir-bundle.mjs");
  }, 30_000);

  it("NEGATİF: vendored native eksikken (yalnızca mjs) anlaşılır hata — better-sqlite3 adlandırılır", async () => {
    const cloneDir = makeTempCloneDir("causoryn-bundle-nonative-");
    tempDirs.push(cloneDir);
    // Kısmi kopya: SADECE mjs — node_modules YOK (external native eksik senaryosu).
    cpSync(BUNDLE_PATH, path.join(cloneDir, "mcp-server.mjs"));

    const child = spawn(process.execPath, [path.join(cloneDir, "mcp-server.mjs")], {
      cwd: cloneDir,
      env: { ...process.env, CAUSORYN_CONFIG: JSON.stringify(CONFIG) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks: string[] = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => stderrChunks.push(chunk));
    const stdoutChunks: string[] = [];
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdoutChunks.push(chunk));
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code));
    });

    expect(exitCode, "native eksikken süreç sessiz başlamamalı").not.toBe(0);
    const stderrText = stderrChunks.join("");
    expect(stderrText).toContain("better-sqlite3");
    // stdout saflığı bozulmadı: hata stderr'de, stdout boş.
    expect(stdoutChunks.join("")).toBe("");
  }, 60_000);
});

describe("F1 bundle — klon-benzeri ortam (partial)", () => {
  it("PARTIAL: yalnızca mjs + node_modules kopyası ile tam protokol akışı (repo node_modules'e bağımlılık yok)", async () => {
    const cloneDir = makeTempCloneDir("causoryn-bundle-clone-");
    tempDirs.push(cloneDir);
    cpSync(BUNDLE_PATH, path.join(cloneDir, "mcp-server.mjs"));
    // Vendored runtime: dist/node_modules → clone/node_modules (deterministik kopya).
    cpSync(path.join(DIST_DIR, "node_modules"), path.join(cloneDir, "node_modules"), {
      recursive: true,
    });

    // os.tmpdir altında up-tree'de repo node_modules yoktur: bare specifier
    // yalnızca clone/node_modules/better-sqlite3'ten çözülebilir.
    const result = await runBundleSession(path.join(cloneDir, "mcp-server.mjs"), cloneDir);

    const listMsg = result.responseOf(2);
    const listResult = listMsg.result as { tools?: Array<{ name?: string }> };
    expect(listResult.tools?.map((tool) => tool.name).sort()).toEqual(
      [...CORE_TOOL_NAMES].sort(),
    );
    const callMsg = result.responseOf(3);
    const callResult = callMsg.result as { isError?: boolean };
    expect(callResult.isError).toBeFalsy();
    expect(result.stdoutLines.length).toBe(3);
    expect(result.exitCode).toBe(0);
  }, 120_000);
});

describe("F1 bundle — determinizm", () => {
  it("DETERMİNİZM: iki ardışık build bit-bit aynı çıktı üretir (bundle + LEGAL.txt + vendor manifest hash)", () => {
    const hashBefore = sha256(BUNDLE_PATH);
    const legalHashBefore = sha256(LEGAL_PATH);
    const licenseHashBefore = sha256(path.join(VENDOR_ROOT, "LICENSE"));
    const manifestBefore = readFileSync(MANIFEST_PATH, "utf8");
    runBuild();
    const hashAfter = sha256(BUNDLE_PATH);
    const legalHashAfter = sha256(LEGAL_PATH);
    const licenseHashAfter = sha256(path.join(VENDOR_ROOT, "LICENSE"));
    const manifestAfter = readFileSync(MANIFEST_PATH, "utf8");
    expect(hashAfter).toBe(hashBefore);
    expect(legalHashAfter).toBe(legalHashBefore);
    expect(licenseHashAfter).toBe(licenseHashBefore);
    expect(manifestAfter).toBe(manifestBefore);
  }, 180_000);
});

describe("F1 bundle — Antigravity eklenti sahnelemesi (integrations/antigravity/causoryn/scripts)", () => {
  it("POZİTİF: build-bundle çıktıları integrations/antigravity/causoryn/scripts/ altına dist/ ile bit-bit aynı sha256 ile sahnelenir", () => {
    expect(
      existsSync(ANTIGRAVITY_BUNDLE_PATH),
      "integrations/antigravity/causoryn/scripts/mcp-server.mjs sahnelenmedi",
    ).toBe(true);
    expect(
      existsSync(ANTIGRAVITY_LEGAL_PATH),
      "integrations/antigravity/causoryn/scripts/mcp-server.mjs.LEGAL.txt sahnelenmedi",
    ).toBe(true);
    expect(
      existsSync(WORKER_BUNDLE_PATH),
      "dist/index-worker.mjs üretilmedi",
    ).toBe(true);
    expect(
      existsSync(ANTIGRAVITY_WORKER_BUNDLE_PATH),
      "integrations/antigravity/causoryn/scripts/index-worker.mjs sahnelenmedi",
    ).toBe(true);
    expect(
      existsSync(ANTIGRAVITY_MANIFEST_PATH),
      "integrations/antigravity/causoryn/scripts/bundle-manifest.json sahnelenmedi",
    ).toBe(true);
    expect(
      existsSync(path.join(ANTIGRAVITY_VENDOR_ROOT, "package.json")),
      "sahnelenmiş better-sqlite3 package.json yok",
    ).toBe(true);
    expect(
      existsSync(path.join(ANTIGRAVITY_VENDOR_ROOT, "LICENSE")),
      "sahnelenmiş better-sqlite3 LICENSE yok",
    ).toBe(true);
    expect(
      existsSync(path.join(ANTIGRAVITY_VENDOR_ROOT, "lib", "index.js")),
      "sahnelenmiş better-sqlite3 lib/index.js yok",
    ).toBe(true);
    expect(
      existsSync(
        path.join(ANTIGRAVITY_VENDOR_ROOT, "prebuilds", `win32-${process.arch}.node`),
      ),
      "sahnelenmiş better-sqlite3 win32 prebuild yok",
    ).toBe(true);

    expect(sha256(ANTIGRAVITY_BUNDLE_PATH)).toBe(sha256(BUNDLE_PATH));
    expect(sha256(ANTIGRAVITY_WORKER_BUNDLE_PATH)).toBe(sha256(WORKER_BUNDLE_PATH));
    expect(sha256(ANTIGRAVITY_LEGAL_PATH)).toBe(sha256(LEGAL_PATH));
    expect(sha256(ANTIGRAVITY_MANIFEST_PATH)).toBe(sha256(MANIFEST_PATH));
    expect(sha256(path.join(ANTIGRAVITY_VENDOR_ROOT, "package.json"))).toBe(
      sha256(path.join(VENDOR_ROOT, "package.json")),
    );
    expect(sha256(path.join(ANTIGRAVITY_VENDOR_ROOT, "LICENSE"))).toBe(
      sha256(path.join(VENDOR_ROOT, "LICENSE")),
    );
    expect(sha256(path.join(ANTIGRAVITY_VENDOR_ROOT, "lib", "index.js"))).toBe(
      sha256(path.join(VENDOR_ROOT, "lib", "index.js")),
    );
    expect(
      sha256(
        path.join(ANTIGRAVITY_VENDOR_ROOT, "prebuilds", `win32-${process.arch}.node`),
      ),
    ).toBe(sha256(path.join(VENDOR_ROOT, "prebuilds", `win32-${process.arch}.node`)));

    const distManifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
      files?: Record<string, string>;
    };
    // mcp-server.mjs + mcp-server.mjs.LEGAL.txt + index-worker.mjs + 33 better-sqlite3 dosyası (LICENSE dahil)
    expect(Object.keys(distManifest.files ?? {}).length).toBe(36);
    expect(distManifest.files?.["index-worker.mjs"]).toMatch(/^[0-9a-f]{64}$/);
    const workerBundleText = readFileSync(WORKER_BUNDLE_PATH, "utf8");
    expect(workerBundleText).toContain("SqliteGraphRepository");
    expect(/\bimport\s*\(\s*specifier\s*\)/.test(workerBundleText)).toBe(false);
    expect(/\bimport\s*\(\s*["']@causoryn\/storage-sqlite["']\s*\)/.test(workerBundleText)).toBe(
      false,
    );
    const stagedBundleText = readFileSync(ANTIGRAVITY_BUNDLE_PATH, "utf8");
    expect(stagedBundleText.startsWith("/* eslint-disable */")).toBe(true);
    const bundleBodyAfterBanner = stagedBundleText.slice(stagedBundleText.indexOf("\n") + 1);
    expect(
      /(\/\/|\/\*)\s*eslint-(disable|enable)\b/.test(bundleBodyAfterBanner),
      "sahnelenmiş bundle gövdesinde eslint --fix bozulmasına veya uyarıya yol açacak iç eslint-disable direktifi kalmamalı",
    ).toBe(false);
    const buildScriptSource = readFileSync(BUILD_SCRIPT, "utf8");
    expect(buildScriptSource).toContain("DÖRT çıktı");
    expect(buildScriptSource).toContain("integrations/antigravity/causoryn/scripts/");
  }, 60_000);
});
