import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * net-guard kapsam sınırı testi (güvenlik analizi bulgusu, 2026-11-09).
 *
 * net-guard.cjs başlığındaki iddia, gerçek kapsamla birebir ölçülüdür:
 * guard yalnızca process-içi Node ağ API'lerini (dns/net/tls/http/https +
 * globalThis.fetch/WebSocket) KAYIT+RED ile sarar; child_process SARMAZ.
 * Bu test dosyası iddianın iki yönünü de davranışsal olarak sabitler:
 *
 *   NEGATİF  — sarılan API (fetch): preload aktifken deneme KAYIT+RED ile
 *              düşer; sessiz başarı yok (.invalid TLD'si kullanılır ve
 *              guard çağrıyı I/O'dan ÖNCE senkron fırlatarak reddettiği
 *              için hiçbir ağ paketi çıkmaz).
 *   PARTIAL  — kapsam dışı yüzey (execFile sabit yerel hedef): guard
 *              engellemez; komut başarıyla koşar. Bu, başlıktaki kapsam
 *              sınırı cümlesinin kanıtıdır — iddia genişletilirse test
 *              iddianın karşısına dürüst çelişki olarak çıkar.
 *   POZİTİF  — netlog (KAYIT ayağı) yalnızca sarılan API denemesini taşır;
 *              execFile denemesi kaydedilmez (guard'ın böyle bir sarması
 *              yoktur) — başlık cümlesiyle tutarlı.
 */

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const NET_GUARD_PATH = path.join(THIS_DIR, "helpers", "net-guard.cjs");

const PROBE_SCRIPT = [
  `"use strict";`,
  `const fs = require("node:fs");`,
  // (1) Sarılan API: fetch — guard stub'ı çağrıyı I/O'dan ÖNCE senkron reddeder.
  `let fetchDenied = false;`,
  `let fetchError = null;`,
  `try {`,
  `  globalThis.fetch("https://probe.invalid/causoryn-netguard-boundary");`,
  `} catch (error) {`,
  `  fetchError = String(error && error.message ? error.message : error);`,
  `  fetchDenied = fetchError.includes("CAUSORYN_NETWORK_DENIED");`,
  `}`,
  // (2) Kapsam dışı yüzey: execFile sabit YEREL hedefe (kendi node'una) —
  // guard child_process'i sarmadığı için çalışmalıdır.
  `const { execFile } = require("node:child_process");`,
  `execFile(process.execPath, ["-e", "process.stdout.write('exec-ok')"], (err, stdout) => {`,
  `  const result = {`,
  `    fetchDenied,`,
  `    fetchError,`,
  `    execOk: !err && stdout === "exec-ok",`,
  `    execError: err ? String(err && err.message ? err.message : err) : null,`,
  `  };`,
  `  fs.writeFileSync(process.env.BOUNDARY_OUT, JSON.stringify(result), "utf8");`,
  `  process.exit(result.fetchDenied && result.execOk ? 0 : 3);`,
  `});`,
  ``,
].join("\n");

interface ProbeResult {
  readonly fetchDenied: boolean;
  readonly fetchError: string | null;
  readonly execOk: boolean;
  readonly execError: string | null;
}

let workDir: string;
let outPath: string;
let netLogPath: string;
let result: ProbeResult | undefined;
let netLogText: string;
let childCode: number | null;

beforeAll(async () => {
  workDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-netguard-boundary-"));
  const scriptPath = path.join(workDir, "probe.cjs");
  writeFileSync(scriptPath, PROBE_SCRIPT, "utf8");
  outPath = path.join(workDir, "boundary-out.json");
  netLogPath = path.join(workDir, "netlog.jsonl");
  writeFileSync(netLogPath, "", "utf8");

  const requirePath = path.resolve(NET_GUARD_PATH);
  if (/\s/.test(requirePath)) {
    throw new Error(`guard yolu boşluk içeriyor; NODE_OPTIONS boşlukla böler: ${requirePath}`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env["NODE_OPTIONS"] = `--require ${requirePath.split(path.sep).join("/")}`;
  env["CAUSORYN_NETLOG"] = netLogPath.split(path.sep).join("/");
  env["BOUNDARY_OUT"] = outPath;

  childCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: workDir,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrText = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrText += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`boundary probe 30 s içinde bitmedi: ${stderrText}`));
    }, 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  result = JSON.parse(readFileSync(outPath, "utf8")) as ProbeResult;
  netLogText = readFileSync(netLogPath, "utf8");
}, 60_000);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("net-guard kapsam sınırı — başlık iddiası ile gerçek kapsam birebir", () => {
  it("negatif: SARILAN API (fetch) preload aktifken KAYIT+RED ile düşer — sessiz başarı yok", () => {
    expect(childCode).toBe(0);
    expect(result?.fetchDenied, `fetchError: ${result?.fetchError ?? "yok"}`).toBe(true);
  });

  it("partial: KAPSAM DIŞI yüzey (execFile sabit yerel hedef) guard engellemesiz çalışır — kapsam sınırı cümlesinin davranışsal kanıtı", () => {
    expect(result?.execOk, `execError: ${result?.execError ?? "yok"}`).toBe(true);
    expect(result?.execError).toBeNull();
  });

  it("pozitif: netlog (KAYIT ayağı) yalnızca sarılan API denemesini taşır; child_process denemesi kaydedilmez (guard böyle bir sarma içermez)", () => {
    const entries = netLogText
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { api: string });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.api).toBe("globalThis.fetch");
  });
});
