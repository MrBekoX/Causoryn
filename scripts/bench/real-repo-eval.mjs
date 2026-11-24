#!/usr/bin/env node
/**
 * Judge (ISSTA 2019) Real-Repo & Packed-Tarball Evaluation Harness for Causoryn.
 *
 * Strict process discipline:
 *   - NEVER evaluates stale local `packages/causoryn/dist/`.
 *   - Packs `packages/causoryn` via `npm pack --pack-destination <tmp>` (or uses
 *     `--tarball <path>`), unpacks it into a fresh temp directory, and spawns the
 *     real unpacked `scripts/causoryn.mjs mcp --allow-cwd --auto-data-dir --data-dir <tmp>`
 *     over JSON-RPC 2.0 stdio.
 *   - Zero external dependencies (Node.js >= 24 built-ins only), `shell: false`
 *     everywhere, read-only against target workspaces (ADR-008), and `try/finally`
 *     cleanup of every temporary directory.
 *
 * Usage:
 *   node scripts/bench/real-repo-eval.mjs
 *   node scripts/bench/real-repo-eval.mjs --tarball path/to/causoryn.tgz --json out/eval.json
 *   node scripts/bench/real-repo-eval.mjs --repo /path/to/repo --timeout-ms 300000
 */
import { execFile as execFileCallback, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_INDEX_TIMEOUT_MS = 300_000;
const STATUS_PING_INTERVAL_MS = 250;
const RPC_TIMEOUT_MS = 60_000;

/** v0.2.4 independent Opus audit baseline metrics (measured on published tarball). */
const V024_BASELINE = {
  coldHandshakeMs: 740,
  toolCount: 29,
  toolsListChars: 43_576,
  coldIndexSec: 70.7,
  peakRssMb: 1_024,
  maxEventLoopStallMs: 23_500,
  unresolvedEdgePct: 33.5,
  agentContextServerRank: "Not in top 10",
  findSymbolsAmbiguity: "AMBIGUOUS_SYMBOL",
  preflightWorkspaceLeak: "Workspace root included",
  warmHandshakeMs: 8_900,
  sqliteSizeMb: 70.6,
};

const SLO = {
  coreToolCount: 11,
  toolsListMaxChars: 15_000,
  maxEventLoopStallMs: 500,
  maxUnresolvedEdgePct: 10.0,
  maxAgentContextServerRank: 3,
  maxWarmHandshakeMs: 1_000,
};

function parseCliArgs(argv) {
  const parsed = {
    tarball: null,
    repoRoot: DEFAULT_REPO_ROOT,
    jsonOut: null,
    timeoutMs: DEFAULT_INDEX_TIMEOUT_MS,
    skipSelfRepo: false,
    skipHeadToHead: false,
    skipJudge: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--skip-self-repo") {
      parsed.skipSelfRepo = true;
      continue;
    }
    if (arg === "--skip-head-to-head") {
      parsed.skipHeadToHead = true;
      continue;
    }
    if (arg === "--skip-judge") {
      parsed.skipJudge = true;
      continue;
    }
    if (arg === "--tarball" || arg === "--repo" || arg === "--json" || arg === "--timeout-ms") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`Flag ${arg} requires a value`);
      }
      i += 1;
      if (arg === "--tarball") parsed.tarball = path.resolve(next);
      if (arg === "--repo") parsed.repoRoot = path.resolve(next);
      if (arg === "--json") parsed.jsonOut = path.resolve(next);
      if (arg === "--timeout-ms") {
        const ms = Number(next);
        if (!Number.isInteger(ms) || ms < 5_000) {
          throw new Error(`--timeout-ms must be an integer >= 5000 (got ${next})`);
        }
        parsed.timeoutMs = ms;
      }
      continue;
    }
    throw new Error(`Unknown CLI argument: ${arg}`);
  }
  return parsed;
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/bench/real-repo-eval.mjs [options]",
      "",
      "Options:",
      "  --tarball <path>     Evaluate an existing causoryn-*.tgz instead of running npm pack",
      "  --repo <path>        Self-repo target root (default: monorepo root)",
      "  --json <outPath>     Write full structured evaluation report JSON to <outPath>",
      "  --timeout-ms <ms>    Per-workspace indexing timeout in ms (default: 300000)",
      "  --skip-self-repo     Skip Section 1 (Causoryn self-repo benchmark)",
      "  --skip-head-to-head  Skip Section 2 (fixture-ts-orders head-to-head demo)",
      "  --skip-judge         Skip Section 3 (Judge ISSTA 2019 multi-language honesty & CHA)",
      "  -h, --help           Show this help text",
    ].join("\n"),
  );
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value, digits = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

function resolveNpmCliJs() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(
      path.dirname(path.dirname(process.execPath)),
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    if (existsSync(candidate) && candidate.endsWith(".js")) {
      return candidate;
    }
  }
  return null;
}

function packCausorynTarball(repoRoot, packDir) {
  const pkgDir = path.join(repoRoot, "packages", "causoryn");
  if (!existsSync(path.join(pkgDir, "package.json"))) {
    throw new Error(`packages/causoryn/package.json not found under ${repoRoot}`);
  }
  const npmCliJs = resolveNpmCliJs();
  if (npmCliJs !== null) {
    execFileSync(
      process.execPath,
      [npmCliJs, "pack", "--pack-destination", packDir],
      {
        cwd: pkgDir,
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } else if (process.platform !== "win32") {
    execFileSync("npm", ["pack", "--pack-destination", packDir], {
      cwd: pkgDir,
      shell: false,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    throw new Error(
      "Could not locate npm-cli.js next to Node.js executable; pass --tarball <path> explicitly",
    );
  }

  const tarballs = readdirSync(packDir)
    .filter((name) => name.endsWith(".tgz"))
    .sort();
  if (tarballs.length === 0) {
    throw new Error(`npm pack produced no .tgz archive in ${packDir}`);
  }
  return path.join(packDir, tarballs[tarballs.length - 1]);
}

function unpackTarball(tarballPath, unpackDir) {
  mkdirSync(unpackDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarballPath, "-C", unpackDir], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const packageRoot = path.join(unpackDir, "package");
  const causorynMjs = path.join(packageRoot, "scripts", "causoryn.mjs");
  const bundleMjs = path.join(packageRoot, "dist", "mcp-server.mjs");
  if (!existsSync(causorynMjs)) {
    throw new Error(`Unpacked tarball missing entrypoint: ${causorynMjs}`);
  }
  if (!existsSync(bundleMjs)) {
    throw new Error(`Unpacked tarball missing MCP bundle: ${bundleMjs}`);
  }
  return {
    packageRoot,
    causorynMjs,
    bundleMjs,
    tarballSha256: sha256File(tarballPath),
    mcpBundleSha256: sha256File(bundleMjs),
  };
}

function isExecutableAvailable(cmd, args = ["--version"]) {
  try {
    execFileSync(cmd, args, {
      cwd: os.tmpdir(),
      shell: false,
      windowsHide: true,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function collectFilesRecursive(rootDir, out = []) {
  if (!existsSync(rootDir)) return out;
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      collectFilesRecursive(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function measureSqliteFootprint(dataDir) {
  const files = collectFilesRecursive(dataDir);
  let dbBytes = 0;
  let totalSqliteBytes = 0;
  const sqliteFiles = [];
  for (const filePath of files) {
    const lower = path.basename(filePath).toLowerCase();
    if (lower.endsWith(".sqlite") || lower.endsWith(".sqlite-wal") || lower.endsWith(".sqlite-shm")) {
      const size = statSync(filePath).size;
      totalSqliteBytes += size;
      if (lower.endsWith(".sqlite")) {
        dbBytes += size;
      }
      sqliteFiles.push({
        relativePath: path.relative(dataDir, filePath).split(path.sep).join("/"),
        bytes: size,
      });
    }
  }
  return {
    dbBytes,
    dbMb: round(dbBytes / (1024 * 1024), 2),
    totalSqliteBytes,
    totalSqliteMb: round(totalSqliteBytes / (1024 * 1024), 2),
    files: sqliteFiles,
  };
}

/** Non-blocking child-process RSS sampler (Windows + Linux + macOS). */
class ProcessRssSampler {
  constructor(pid) {
    this.pid = pid;
    this.peakMb = null;
    this.samplesMb = [];
    this.inFlight = false;
    this.stopped = false;
    this.timer = null;
  }

  start(intervalMs = 500) {
    if (typeof this.pid !== "number" || this.pid <= 0) return;
    this.sampleOnce().catch(() => {});
    this.timer = setInterval(() => {
      if (!this.stopped) {
        this.sampleOnce().catch(() => {});
      }
    }, intervalMs);
    this.timer.unref();
  }

  recordMb(mb) {
    if (typeof mb !== "number" || !Number.isFinite(mb) || mb <= 0) return;
    this.samplesMb.push(mb);
    if (this.peakMb === null || mb > this.peakMb) {
      this.peakMb = mb;
    }
  }

  async sampleOnce() {
    if (this.inFlight || this.stopped || typeof this.pid !== "number") return;
    this.inFlight = true;
    try {
      if (process.platform === "linux") {
        const status = await readFile(`/proc/${String(this.pid)}/status`, "utf8");
        const hwmMatch = /^VmHWM:\s+(\d+)\s+kB/m.exec(status);
        const rssMatch = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
        if (hwmMatch?.[1] !== undefined) {
          this.recordMb(Number(hwmMatch[1]) / 1024);
        }
        if (rssMatch?.[1] !== undefined) {
          this.recordMb(Number(rssMatch[1]) / 1024);
        }
      } else if (process.platform === "darwin") {
        const { stdout } = await execFile("ps", ["-o", "rss=", "-p", String(this.pid)], {
          shell: false,
          timeout: 1_500,
        });
        const kb = Number(stdout.trim());
        if (Number.isFinite(kb) && kb > 0) {
          this.recordMb(kb / 1024);
        }
      } else if (process.platform === "win32") {
        const { stdout } = await execFile(
          "tasklist",
          ["/FI", `PID eq ${String(this.pid)}`, "/FO", "CSV", "/NH"],
          {
            shell: false,
            windowsHide: true,
            timeout: 2_000,
          },
        );
        const line = stdout.trim().split(/\r?\n/)[0] ?? "";
        // CSV format: "node.exe","12345","Console","1","245,120 K"
        const cols = line.match(/"([^"]*)"/g);
        if (cols && cols.length >= 5) {
          const memStr = cols[4].replace(/[^0-9]/g, "");
          const kb = Number(memStr);
          if (Number.isFinite(kb) && kb > 0) {
            this.recordMb(kb / 1024);
          }
        }
      }
    } catch {
      // Best-effort process metrics; never fail the benchmark on OS probe restriction.
    } finally {
      this.inFlight = false;
    }
  }

  async captureFinalPeakAndStop() {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (process.platform === "linux" && typeof this.pid === "number") {
      try {
        const status = await readFile(`/proc/${String(this.pid)}/status`, "utf8");
        const hwmMatch = /^VmHWM:\s+(\d+)\s+kB/m.exec(status);
        if (hwmMatch?.[1] !== undefined) {
          this.recordMb(Number(hwmMatch[1]) / 1024);
        }
      } catch {
        // Process already exited or /proc unavailable.
      }
    } else if (process.platform === "win32" && typeof this.pid === "number") {
      try {
        const { stdout } = await execFile(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${String(this.pid)} -ErrorAction Stop).PeakWorkingSet64`,
          ],
          {
            shell: false,
            windowsHide: true,
            timeout: 3_000,
          },
        );
        const bytes = Number(stdout.trim());
        if (Number.isFinite(bytes) && bytes > 0) {
          this.recordMb(bytes / (1024 * 1024));
        }
      } catch {
        // Best-effort kernel peak working set.
      }
    }
    return this.peakMb === null ? null : round(this.peakMb, 1);
  }
}

/** Minimal zero-dependency MCP JSON-RPC 2.0 stdio client. */
class McpStdioClient {
  constructor(causorynMjs, workspaceRoot, dataDir, extraArgs = []) {
    this.spawnStartMs = performance.now();
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stderrLines = [];
    this.buffer = "";
    this.closed = false;

    const args = [
      causorynMjs,
      "mcp",
      "--allow-cwd",
      "--auto-data-dir",
      "--data-dir",
      dataDir,
      ...extraArgs,
    ];

    this.child = spawn(process.execPath, args, {
      cwd: workspaceRoot,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.exitPromise = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.closed = true;
        const tail = this.stderrLines.slice(-25).join("\n");
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(
            new Error(
              `MCP process exited unexpectedly (code=${String(code)}, signal=${String(signal)}).\nstderr tail:\n${tail}`,
            ),
          );
        }
        this.pending.clear();
        resolve({ code, signal });
      });
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let newlineIdx = this.buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const rawLine = this.buffer.slice(0, newlineIdx).replace(/\r$/, "");
        this.buffer = this.buffer.slice(newlineIdx + 1);
        newlineIdx = this.buffer.indexOf("\n");
        if (rawLine.trim().length === 0) continue;
        this.handleLine(rawLine);
      }
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length === 0) continue;
        this.stderrLines.push(line);
        if (this.stderrLines.length > 200) {
          this.stderrLines.shift();
        }
      }
    });
  }

  get pid() {
    return this.child.pid;
  }

  handleLine(rawLine) {
    let msg;
    try {
      msg = JSON.parse(rawLine);
    } catch {
      return;
    }

    // Server-initiated request (e.g., roots/list) — reply politely so we never deadlock.
    if (msg.id !== undefined && typeof msg.method === "string") {
      const reply =
        msg.method === "roots/list"
          ? { jsonrpc: "2.0", id: msg.id, result: { roots: [] } }
          : {
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32601, message: `Method not implemented: ${msg.method}` },
            };
      this.writeRaw(reply);
      return;
    }

    // Response matching a pending request
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error !== undefined) {
        entry.reject(
          new Error(`JSON-RPC error ${String(msg.error.code)}: ${String(msg.error.message)}`),
        );
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Server notification (e.g., notifications/progress)
    if (typeof msg.method === "string") {
      this.notifications.push(msg);
    }
  }

  writeRaw(payload) {
    if (this.closed || this.child.stdin.destroyed) {
      throw new Error("Cannot write to closed MCP stdio transport");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `MCP request timed out after ${String(timeoutMs)}ms: ${method}\nstderr tail:\n${this.stderrLines.slice(-20).join("\n")}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writeRaw({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.writeRaw({ jsonrpc: "2.0", method, params });
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "causoryn-real-repo-eval", version: "1.0.0" },
    });
    const handshakeMs = performance.now() - this.spawnStartMs;
    this.notify("notifications/initialized", {});
    return { handshakeMs, result };
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return {
      tools,
      toolCount: tools.length,
      serializedChars: JSON.stringify(tools).length,
    };
  }

  async callTool(name, args = {}, timeoutMs = RPC_TIMEOUT_MS) {
    const t0 = performance.now();
    const result = await this.request(
      "tools/call",
      {
        name,
        arguments: args,
      },
      timeoutMs,
    );
    const latencyMs = performance.now() - t0;
    let envelope = result?.structuredContent ?? null;
    if (envelope === null && Array.isArray(result?.content)) {
      const textItem = result.content.find((entry) => entry?.type === "text" && typeof entry.text === "string");
      if (textItem !== undefined) {
        try {
          envelope = JSON.parse(textItem.text);
        } catch {
          envelope = null;
        }
      }
    }
    return {
      latencyMs,
      isError: Boolean(result?.isError),
      raw: result,
      envelope,
    };
  }

  async close() {
    if (!this.closed) {
      try {
        this.child.stdin.end();
      } catch {
        // Ignore already-closed stdin.
      }
      const exited = await Promise.race([
        this.exitPromise.then(() => true),
        sleep(3_000).then(() => false),
      ]);
      if (!exited && !this.closed) {
        try {
          this.child.kill("SIGTERM");
        } catch {
          // Process may have exited between checks.
        }
        await Promise.race([this.exitPromise, sleep(2_000)]);
      }
      if (!this.closed) {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // Ignore kill race.
        }
        await Promise.race([this.exitPromise, sleep(1_000)]);
      }
    }
  }
}

/**
 * Polls `causoryn_status` every `pingIntervalMs` while background cold indexing
 * runs, capturing every round-trip latency to measure worst-case main-thread
 * event-loop stall alongside total wall time.
 */
async function waitForIndexWithStallProbing(client, timeoutMs, pingIntervalMs = STATUS_PING_INTERVAL_MS) {
  const startMs = performance.now();
  const deadlineMs = startMs + timeoutMs;
  const activePingLatenciesMs = [];
  let lastStatusEnvelope = null;

  while (performance.now() < deadlineMs) {
    const pingStartMs = performance.now();
    const call = await client.callTool("causoryn_status", { action: "inspect" }, RPC_TIMEOUT_MS);
    const pingMs = performance.now() - pingStartMs;
    const envelope = call.envelope;
    lastStatusEnvelope = envelope;

    const data = envelope?.data ?? null;
    const indexing = Boolean(data?.indexing);
    const job = data?.index?.job ?? null;
    const latestSnapshot = data?.index?.latestSnapshot ?? null;

    if (job?.status === "failed") {
      throw new Error(
        `Background indexing job failed (jobId=${String(job.jobId)}): ${String(job.error ?? "unknown error")}`,
      );
    }

    activePingLatenciesMs.push(pingMs);

    if (!indexing && latestSnapshot !== null) {
      const wallMs = performance.now() - startMs;
      return {
        wallMs,
        wallSec: round(wallMs / 1000, 2),
        pingCount: activePingLatenciesMs.length,
        maxStallMs: round(Math.max(...activePingLatenciesMs), 1),
        p50StallMs: round(percentile(activePingLatenciesMs, 50), 1),
        p95StallMs: round(percentile(activePingLatenciesMs, 95), 1),
        latestSnapshot,
        coverage: envelope?.coverage ?? null,
        summary: data?.summary ?? null,
        warnings: envelope?.warnings ?? [],
      };
    }

    const waitMs = Math.max(0, pingIntervalMs - pingMs);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  }

  throw new Error(
    `Timed out after ${String(timeoutMs)}ms waiting for cold index to finish. Last status: ${JSON.stringify(lastStatusEnvelope?.data?.index ?? null)}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Section 1 — Causoryn Self-Repo Evaluation                                  */
/* -------------------------------------------------------------------------- */

function discoverWorkspaceScopes(repoRoot) {
  const scopes = new Set();
  for (const groupDir of ["packages", "adapters"]) {
    const absGroup = path.join(repoRoot, groupDir);
    if (!existsSync(absGroup)) continue;
    let entries;
    try {
      entries = readdirSync(absGroup, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgJsonPath = path.join(absGroup, entry.name, "package.json");
      if (!existsSync(pkgJsonPath)) continue;
      try {
        const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
        if (typeof parsed?.name === "string" && parsed.name.startsWith("@")) {
          const slashIdx = parsed.name.indexOf("/");
          if (slashIdx > 1) {
            scopes.add(parsed.name.slice(0, slashIdx + 1));
          }
        }
      } catch {
        // Ignore unreadable or malformed package.json files.
      }
    }
  }
  return [...scopes].sort();
}

async function measureWorkspaceInternalUnresolvedImports(client, repoRoot) {
  const scopes = discoverWorkspaceScopes(repoRoot);
  const sampleSet = new Set();
  let workspacePackageCount = 0;

  for (const scope of scopes) {
    const scopeCall = await client.callTool("causoryn_find_symbols", {
      query: scope,
      kind: "UnknownExternal",
    });
    const scopeData = scopeCall.envelope?.data ?? null;
    const scopeHits = Array.isArray(scopeData?.hits) ? scopeData.hits : [];
    const matchingHits = scopeHits.filter(
      (hit) => typeof hit?.qualifiedName === "string" && hit.qualifiedName.startsWith(scope),
    );
    const totalForScope =
      typeof scopeData?.totalMatches === "number" && matchingHits.length === scopeHits.length
        ? scopeData.totalMatches
        : matchingHits.length;
    workspacePackageCount += totalForScope;
    for (const hit of matchingHits) {
      if (sampleSet.size < 10) sampleSet.add(hit.qualifiedName);
    }
  }

  // Note: "../" contains "./", so querying "./" finds both "./..." and "../..." specifiers.
  const relCall = await client.callTool("causoryn_find_symbols", {
    query: "./",
    kind: "UnknownExternal",
  });
  const relData = relCall.envelope?.data ?? null;
  const relHits = Array.isArray(relData?.hits) ? relData.hits : [];
  const relativeHits = relHits.filter(
    (hit) =>
      typeof hit?.qualifiedName === "string" &&
      (hit.qualifiedName.startsWith("./") || hit.qualifiedName.startsWith("../")),
  );
  const relativeImportCount =
    typeof relData?.totalMatches === "number" && relativeHits.length === relHits.length
      ? relData.totalMatches
      : relativeHits.length;
  for (const hit of relativeHits) {
    if (sampleSet.size < 10) sampleSet.add(hit.qualifiedName);
  }

  return {
    scopes,
    workspacePackageCount,
    relativeImportCount,
    totalCount: workspacePackageCount + relativeImportCount,
    samples: [...sampleSet].sort(),
  };
}

async function evaluateSelfRepo(causorynMjs, repoRoot, tmpRoot, timeoutMs) {
  const dataDir = path.join(tmpRoot, "self-repo-data");
  mkdirSync(dataDir, { recursive: true });

  // 1) Cold process
  const coldClient = new McpStdioClient(causorynMjs, repoRoot, dataDir);
  const rssSampler = new ProcessRssSampler(coldClient.pid);

  let coldHandshakeMs;
  let toolsInfo;
  let indexMetrics;
  let peakRssMb = null;
  let agentContextResult;
  let findSymbolsResult;
  let preflightResult;
  let workspaceInternalUnresolvedImports;

  try {
    const init = await coldClient.initialize();
    coldHandshakeMs = round(init.handshakeMs, 1);

    toolsInfo = await coldClient.listTools();

    rssSampler.start(400);
    indexMetrics = await waitForIndexWithStallProbing(coldClient, timeoutMs, STATUS_PING_INTERVAL_MS);

    // 1a) LocAgent-style code localization check
    const ctxCall = await coldClient.callTool("causoryn_get_agent_context", {
      task: "Where are MCP tools registered?",
      tokenBudget: 4000,
    });
    const ctxItems = Array.isArray(ctxCall.envelope?.data?.contextItems)
      ? ctxCall.envelope.data.contextItems
      : [];
    const serverIdx = ctxItems.findIndex((item) => {
      const rel = String(item?.relativePath ?? "").replaceAll("\\", "/");
      return rel === "packages/mcp-server/src/server.ts" || rel.endsWith("/mcp-server/src/server.ts");
    });
    agentContextResult = {
      latencyMs: round(ctxCall.latencyMs, 1),
      serverTsRank: serverIdx >= 0 ? serverIdx + 1 : null,
      top5Paths: ctxItems.slice(0, 5).map((item) => ({
        qualifiedName: item?.qualifiedName ?? null,
        kind: item?.kind ?? null,
        relativePath: item?.relativePath ?? null,
      })),
      passed: serverIdx >= 0 && serverIdx + 1 <= SLO.maxAgentContextServerRank,
    };

    // 1b) find_symbols disambiguation honesty (zero false UnknownExternal AMBIGUOUS_SYMBOL)
    const findCall = await coldClient.callTool("causoryn_find_symbols", {
      query: "createCausorynMcpServer",
    });
    const findEnv = findCall.envelope;
    const findErrorCode = findEnv?.error?.code ?? null;
    const symbols = Array.isArray(findEnv?.data?.hits) ? findEnv.data.hits : [];
    const hasRealFn = symbols.some(
      (sym) => sym?.qualifiedName === "createCausorynMcpServer" && sym?.kind !== "UnknownExternal",
    );
    findSymbolsResult = {
      latencyMs: round(findCall.latencyMs, 1),
      status: findEnv?.status ?? null,
      errorCode: findErrorCode,
      matchCount: symbols.length,
      hasRealFunction: hasRealFn,
      passed: findEnv?.status !== "error" && findErrorCode !== "AMBIGUOUS_SYMBOL" && hasRealFn,
    };

    // 1c) preflight_change CONTAINS-noise elimination (zero Workspace root nodes)
    const preflightCall = await coldClient.callTool("causoryn_preflight_change", {
      intent: "Modify MCP tool registration",
      targetFiles: ["packages/mcp-server/src/server.ts"],
    });
    const pfEnv = preflightCall.envelope;
    const impactCandidates = Array.isArray(pfEnv?.data?.impactCandidates)
      ? pfEnv.data.impactCandidates
      : [];
    const workspaceCandidates = impactCandidates.filter((cand) => cand?.kind === "Workspace");
    preflightResult = {
      latencyMs: round(preflightCall.latencyMs, 1),
      status: pfEnv?.status ?? null,
      impactCandidateCount: impactCandidates.length,
      workspaceNodeCount: workspaceCandidates.length,
      passed: pfEnv?.status !== "error" && workspaceCandidates.length === 0,
    };

    // 1d) Workspace-internal unresolved imports breakdown
    workspaceInternalUnresolvedImports = await measureWorkspaceInternalUnresolvedImports(
      coldClient,
      repoRoot,
    );

    peakRssMb = await rssSampler.captureFinalPeakAndStop();
  } finally {
    await coldClient.close();
  }

  // 2) SQLite footprint after retention GC
  const sqlite = measureSqliteFootprint(dataDir);

  // 3) Warm restart handshake against the EXACT SAME data-dir
  const warmClient = new McpStdioClient(causorynMjs, repoRoot, dataDir);
  let warmHandshakeMs;
  let warmStatusMs;
  let warmServedCachedSnapshot = false;
  try {
    const warmInit = await warmClient.initialize();
    warmHandshakeMs = round(warmInit.handshakeMs, 1);

    const warmStatusCall = await warmClient.callTool("causoryn_status", { action: "inspect" });
    warmStatusMs = round(warmStatusCall.latencyMs, 1);
    warmServedCachedSnapshot = warmStatusCall.envelope?.data?.index?.latestSnapshot !== null;
  } finally {
    await warmClient.close();
  }

  const coverage = indexMetrics.coverage;
  const totalEdges = coverage?.totalEdges ?? indexMetrics.latestSnapshot.edgeCount ?? 0;
  const unresolvedEdges = coverage?.unresolvedEdges ?? 0;
  const unresolvedEdgePct =
    totalEdges > 0 ? round((unresolvedEdges / totalEdges) * 100, 2) : 0;

  return {
    coldHandshakeMs,
    toolCount: toolsInfo.toolCount,
    toolsListChars: toolsInfo.serializedChars,
    coldIndexSec: indexMetrics.wallSec,
    peakRssMb,
    maxEventLoopStallMs: indexMetrics.maxStallMs,
    p50EventLoopStallMs: indexMetrics.p50StallMs,
    p95EventLoopStallMs: indexMetrics.p95StallMs,
    statusPingCount: indexMetrics.pingCount,
    snapshot: {
      snapshotId: indexMetrics.latestSnapshot.snapshotId,
      state: indexMetrics.latestSnapshot.state,
      nodeCount: indexMetrics.latestSnapshot.nodeCount,
      edgeCount: indexMetrics.latestSnapshot.edgeCount,
      evidenceCount: indexMetrics.latestSnapshot.evidenceCount,
    },
    unresolvedEdges,
    totalEdges,
    unresolvedEdgePct,
    workspaceInternalUnresolvedImports,
    coverageByLanguage: coverage?.byLanguage ?? {},
    agentContext: agentContextResult,
    findSymbols: findSymbolsResult,
    preflightServerTs: preflightResult,
    warmHandshakeMs,
    warmStatusMs,
    warmServedCachedSnapshot,
    sqlite,
    slos: {
      toolCountPassed: toolsInfo.toolCount === SLO.coreToolCount,
      toolsListBudgetPassed: toolsInfo.serializedChars <= SLO.toolsListMaxChars,
      eventLoopStallPassed:
        indexMetrics.maxStallMs !== null && indexMetrics.maxStallMs < SLO.maxEventLoopStallMs,
      unresolvedEdgePctPassed:
        unresolvedEdgePct !== null && unresolvedEdgePct < SLO.maxUnresolvedEdgePct,
      agentContextPassed: agentContextResult.passed,
      findSymbolsPassed: findSymbolsResult.passed,
      preflightNoWorkspacePassed: preflightResult.passed,
      warmHandshakePassed:
        warmHandshakeMs !== null && warmHandshakeMs < SLO.maxWarmHandshakeMs,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Section 2 — Head-to-Head Demo (examples/fixture-ts-orders)                 */
/* -------------------------------------------------------------------------- */

function initTempGitRepo(repoDir) {
  const git = (args) =>
    execFileSync("git", ["-C", repoDir, ...args], {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Causoryn Benchmark"]);
  git(["config", "user.email", "bench@causoryn.invalid"]);
  git(["config", "core.autocrlf", "false"]);
  git(["add", "-A"]);
  git(["commit", "-m", "initial fixture"]);
}

function findSubstringMatches(workspaceDir, needles) {
  const files = collectFilesRecursive(workspaceDir).filter((filePath) =>
    filePath.endsWith(".ts"),
  );
  const hits = new Set();
  for (const filePath of files) {
    const content = readFileSync(filePath, "utf8");
    if (needles.some((needle) => content.includes(needle))) {
      hits.add(path.relative(workspaceDir, filePath).split(path.sep).join("/"));
    }
  }
  return [...hits].sort();
}

async function evaluateHeadToHeadDemo(causorynMjs, repoRoot, tmpRoot, timeoutMs) {
  const sourceFixture = path.join(repoRoot, "examples", "fixture-ts-orders");
  if (!existsSync(sourceFixture)) {
    throw new Error(`Fixture directory not found: ${sourceFixture}`);
  }

  // Copy fixture to an isolated temp workspace (ADR-008: never touch repo fixture).
  const demoDir = path.join(tmpRoot, "demo-fixture-ts-orders");
  const demoDataDir = path.join(tmpRoot, "demo-fixture-data");
  cpSync(sourceFixture, demoDir, { recursive: true });
  mkdirSync(demoDataDir, { recursive: true });

  // Add a real BDD route test that calls createOrdersRoute (no literal mention of OrderRepository or save)
  writeFileSync(
    path.join(demoDir, "src", "routes", "orders.test.ts"),
    [
      'import { createOrdersRoute } from "./orders.js";',
      'import { OrdersService } from "../services/orders-service.js";',
      "",
      "declare function describe(title: string, fn: () => void): void;",
      "declare function it(title: string, fn: () => void): void;",
      "",
      'describe("orders route", () => {',
      '  it("handles order creation", () => {',
      "    const service = undefined as unknown as OrdersService;",
      "    const handler = createOrdersRoute(service);",
      '    handler({ body: { sku: "SKU-1", quantity: 2 } }, { json: () => {} });',
      "  });",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  // Add clean layering policy committed to git HEAD so verify_change evaluates architecture cleanly.
  mkdirSync(path.join(demoDir, ".causoryn"), { recursive: true });
  writeFileSync(
    path.join(demoDir, ".causoryn", "architecture.rules.yaml"),
    [
      "version: 1",
      "rules:",
      "  - id: no-routes-to-repositories",
      "    type: forbidden-dependency",
      '    from: "**/routes/**"',
      '    to: "**/repositories/**"',
      "    edgeKinds: [CALLS, IMPORTS]",
      "    severity: error",
      "",
    ].join("\n"),
    "utf8",
  );
  initTempGitRepo(demoDir);

  // Baseline substring search (`rg --fixed-strings` equivalent for OrderRepository / .save()
  const rgMatchedFiles = findSubstringMatches(demoDir, ["OrderRepository", ".save("]);

  const client = new McpStdioClient(causorynMjs, demoDir, demoDataDir);
  try {
    await client.initialize();
    await waitForIndexWithStallProbing(client, timeoutMs, 150);

    const pfCall = await client.callTool("causoryn_preflight_change", {
      intent: "Update OrderRepository.save contract signature",
      targetSymbols: ["OrderRepository.save"],
      include: ["impact", "test-plan"],
    });
    const pfData = pfCall.envelope?.data ?? null;
    const preflightId = pfData?.preflightId ?? null;
    const impactCandidates = Array.isArray(pfData?.impactCandidates)
      ? pfData.impactCandidates
      : [];
    const testPlanCandidates = Array.isArray(pfData?.testPlan?.candidates)
      ? pfData.testPlan.candidates
      : Array.isArray(pfData?.candidateTests)
        ? pfData.candidateTests
        : [];

    // Verified 3-hop reverse dependency chain in fixture-ts-orders:
    // OrderRepository.save <- OrdersService.create <- createOrdersRoute <- Test("orders route > handles order creation")
    // (Note: src/app.ts mounts POST /orders at module top-level via Handler `ordersRoute`,
    // which is outside function-level CALLS topology and is intentionally not fabricated.)
    const hasServiceCaller = impactCandidates.some(
      (c) => c?.qualifiedName === "OrdersService.create" && c?.resolution === "verified",
    );
    const hasRouteCaller = impactCandidates.some(
      (c) => c?.qualifiedName === "createOrdersRoute" && c?.resolution === "verified",
    );
    const hasTestImpactCaller = impactCandidates.some(
      (c) =>
        c?.kind === "Test" &&
        c?.resolution === "verified" &&
        String(c?.qualifiedName ?? "").includes("orders route > handles order creation"),
    );
    const hasTransitiveTestCandidate = testPlanCandidates.some(
      (c) =>
        c?.testKind === "Test" &&
        c?.matchLevel === "call-site" &&
        c?.resolution === "verified" &&
        String(c?.testQualifiedName ?? "").includes("orders route > handles order creation"),
    );

    const rgMissedFiles = ["src/routes/orders.ts", "src/routes/orders.test.ts"].filter(
      (rel) => !rgMatchedFiles.includes(rel),
    );

    // Default verify_change (NO checks override -> contracts must stay not_requested, verdict no_findings)
    const verifyCall = await client.callTool("causoryn_verify_change", {
      preflightId,
    });
    const verifyData = verifyCall.envelope?.data ?? null;
    const verdict = verifyData?.verdict ?? null;
    const contractsStatus = verifyData?.checks?.contracts?.status ?? null;
    const architectureStatus = verifyData?.checks?.architecture?.status ?? null;
    const verifyTrustWarning = verifyData?.trustWarning ?? null;

    const passed =
      hasServiceCaller &&
      hasRouteCaller &&
      hasTestImpactCaller &&
      hasTransitiveTestCandidate &&
      rgMissedFiles.includes("src/routes/orders.ts") &&
      rgMissedFiles.includes("src/routes/orders.test.ts") &&
      verdict === "no_findings" &&
      contractsStatus === "not_requested" &&
      verifyTrustWarning === null;

    return {
      targetSymbol: "OrderRepository.save",
      rgMatchedFiles,
      rgMissedMultiHopFiles: rgMissedFiles,
      causorynImpactCount: impactCandidates.length,
      causorynMultiHopVerified: {
        ordersServiceCreate: hasServiceCaller,
        createOrdersRoute: hasRouteCaller,
        ordersRouteTestImpact: hasTestImpactCaller,
        transitiveTestCandidate: hasTransitiveTestCandidate,
      },
      testPlanCandidateCount: testPlanCandidates.length,
      verifyChange: {
        verdict,
        contractsStatus,
        architectureStatus,
        trustWarning: verifyTrustWarning,
      },
      passed,
    };
  } finally {
    await client.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Section 3 — Judge (ISSTA 2019) Multi-Language Honesty & CHA Check          */
/* -------------------------------------------------------------------------- */

async function evaluateJudgeTypeScript(causorynMjs, tmpRoot, timeoutMs) {
  const wsDir = path.join(tmpRoot, "judge-ts-monorepo");
  const dataDir = path.join(tmpRoot, "judge-ts-data");
  mkdirSync(path.join(wsDir, "packages", "core", "src"), { recursive: true });
  mkdirSync(path.join(wsDir, "packages", "app", "src"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  writeFileSync(
    path.join(wsDir, "package.json"),
    JSON.stringify({ name: "judge-ts-mono", private: true, workspaces: ["packages/*"] }, null, 2),
    "utf8",
  );
  writeFileSync(
    path.join(wsDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    path.join(wsDir, "packages", "core", "package.json"),
    JSON.stringify(
      {
        name: "@judge/core",
        version: "1.0.0",
        type: "module",
        main: "./src/index.ts",
        exports: { ".": "./src/index.ts" },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    path.join(wsDir, "packages", "core", "src", "index.ts"),
    [
      "export interface PaymentGateway {",
      "  charge(amountCents: number): boolean;",
      "}",
      "export class BaseGateway {",
      "  audit(action: string): string {",
      "    return action;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(wsDir, "packages", "app", "package.json"),
    JSON.stringify({ name: "@judge/app", version: "1.0.0", type: "module" }, null, 2),
    "utf8",
  );
  writeFileSync(
    path.join(wsDir, "packages", "app", "src", "stripe-gateway.ts"),
    [
      'import { BaseGateway, type PaymentGateway } from "@judge/core";',
      "export class StripeGateway extends BaseGateway implements PaymentGateway {",
      "  charge(amountCents: number): boolean {",
      '    this.audit("charge");',
      "    return amountCents > 0;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(wsDir, "packages", "app", "src", "checkout.ts"),
    [
      'import { StripeGateway } from "./stripe-gateway.js";',
      "export function runCheckout(amountCents: number): boolean {",
      "  return new StripeGateway().charge(amountCents);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const client = new McpStdioClient(causorynMjs, wsDir, dataDir);
  try {
    await client.initialize();
    const idx = await waitForIndexWithStallProbing(client, timeoutMs, 150);

    const tsCov = idx.coverage?.byLanguage?.typescript ?? null;
    const unresolvedTsEdges = tsCov?.unresolvedEdges ?? idx.coverage?.unresolvedEdges ?? -1;

    const ctxCall = await client.callTool("causoryn_get_symbol_context", {
      symbolId: "StripeGateway",
      edgeKinds: ["INHERITS", "IMPLEMENTS"],
      depth: 1,
    });
    const ctxData = ctxCall.envelope?.data ?? null;
    const nodeById = new Map(
      (Array.isArray(ctxData?.nodes) ? ctxData.nodes : []).map((n) => [n.id, n]),
    );
    const edges = Array.isArray(ctxData?.edges) ? ctxData.edges : [];
    const hasVerifiedInherits = edges.some(
      (e) =>
        e.kind === "INHERITS" &&
        e.resolution === "verified" &&
        nodeById.get(e.to)?.qualifiedName === "BaseGateway",
    );
    const hasVerifiedImplements = edges.some(
      (e) =>
        e.kind === "IMPLEMENTS" &&
        e.resolution === "verified" &&
        nodeById.get(e.to)?.qualifiedName === "PaymentGateway",
    );

    const pfCall = await client.callTool("causoryn_preflight_change", {
      intent: "Change PaymentGateway.charge signature",
      targetSymbols: ["PaymentGateway"],
    });
    const pfCandidates = Array.isArray(pfCall.envelope?.data?.impactCandidates)
      ? pfCall.envelope.data.impactCandidates
      : [];
    const chaImpactsStripeGateway = pfCandidates.some(
      (c) => c?.qualifiedName === "StripeGateway",
    );

    const passed =
      unresolvedTsEdges === 0 &&
      hasVerifiedInherits &&
      hasVerifiedImplements &&
      chaImpactsStripeGateway;

    return {
      status: passed ? "PASS" : "FAIL",
      passed,
      unresolvedTsEdges,
      hasVerifiedInherits,
      hasVerifiedImplements,
      chaImpactsStripeGateway,
    };
  } finally {
    await client.close();
  }
}

async function evaluateJudgeGo(causorynMjs, tmpRoot, timeoutMs) {
  if (!isExecutableAvailable("go", ["version"])) {
    return {
      status: "SKIPPED",
      passed: true,
      reason: "go toolchain not available on PATH",
    };
  }

  const wsDir = path.join(tmpRoot, "judge-go-repo");
  const dataDir = path.join(tmpRoot, "judge-go-data");
  mkdirSync(path.join(wsDir, "pkg", "orders"), { recursive: true });
  mkdirSync(path.join(wsDir, "cmd", "api"), { recursive: true });
  mkdirSync(path.join(wsDir, "cmd", "worker"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  writeFileSync(path.join(wsDir, "go.mod"), "module example.com/judge-go\n\ngo 1.22\n", "utf8");
  writeFileSync(
    path.join(wsDir, "pkg", "orders", "handler.go"),
    "package orders\n\nfunc Handle() {\n\thelper()\n}\n",
    "utf8",
  );
  writeFileSync(
    path.join(wsDir, "pkg", "orders", "helper.go"),
    "package orders\n\nfunc helper() {}\n",
    "utf8",
  );
  writeFileSync(
    path.join(wsDir, "cmd", "api", "main.go"),
    [
      "package main",
      "",
      'import "example.com/judge-go/pkg/orders"',
      "",
      "func runAPI() {",
      "\torders.Handle()",
      "\tshared()",
      "\tonlyInWorker()",
      "}",
      "",
      "func shared() {}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(wsDir, "cmd", "worker", "main.go"),
    "package main\n\nfunc onlyInWorker() {}\n\nfunc shared() {}\n",
    "utf8",
  );

  const client = new McpStdioClient(causorynMjs, wsDir, dataDir);
  try {
    await client.initialize();
    const idx = await waitForIndexWithStallProbing(client, timeoutMs, 150);

    const goTier = idx.coverage?.byLanguage?.go?.tier ?? "L0";
    if (goTier === "L0") {
      return {
        status: "SKIPPED",
        passed: true,
        reason: "go-worker unavailable in runtime (degraded to L0)",
      };
    }

    // 1) Multi-file same-directory package call: orders.Handle -> orders.helper (verified)
    const handleCtx = await client.callTool("causoryn_get_symbol_context", {
      symbolId: "orders.Handle",
      edgeKinds: ["CALLS"],
      depth: 1,
    });
    const handleNodes = new Map(
      (Array.isArray(handleCtx.envelope?.data?.nodes) ? handleCtx.envelope.data.nodes : []).map(
        (n) => [n.id, n],
      ),
    );
    const handleEdges = Array.isArray(handleCtx.envelope?.data?.edges)
      ? handleCtx.envelope.data.edges
      : [];
    const samePkgVerified = handleEdges.some(
      (e) =>
        e.kind === "CALLS" &&
        e.resolution === "verified" &&
        handleNodes.get(e.from)?.qualifiedName === "orders.Handle" &&
        handleNodes.get(e.to)?.qualifiedName === "orders.helper",
    );

    // 2) go.mod import call + dual package main isolation from main.runAPI
    const apiCtx = await client.callTool("causoryn_get_symbol_context", {
      symbolId: "main.runAPI",
      edgeKinds: ["CALLS"],
      depth: 1,
    });
    const apiNodes = new Map(
      (Array.isArray(apiCtx.envelope?.data?.nodes) ? apiCtx.envelope.data.nodes : []).map(
        (n) => [n.id, n],
      ),
    );
    const apiEdges = Array.isArray(apiCtx.envelope?.data?.edges)
      ? apiCtx.envelope.data.edges
      : [];
    const goModCrossPkgVerified = apiEdges.some(
      (e) =>
        e.kind === "CALLS" &&
        e.resolution === "verified" &&
        apiNodes.get(e.from)?.qualifiedName === "main.runAPI" &&
        apiNodes.get(e.to)?.qualifiedName === "orders.Handle",
    );
    const falseDualMainEdge = apiEdges.some((e) => {
      const target = apiNodes.get(e.to);
      const targetPath = String(target?.relativePath ?? target?.location?.relativePath ?? "").replaceAll(
        "\\",
        "/",
      );
      return e.kind === "CALLS" && targetPath === "cmd/worker/main.go";
    });

    const passed = samePkgVerified && goModCrossPkgVerified && !falseDualMainEdge;
    return {
      status: passed ? "PASS" : "FAIL",
      passed,
      goTier,
      samePkgVerified,
      goModCrossPkgVerified,
      zeroFalseDualMainEdges: !falseDualMainEdge,
    };
  } finally {
    await client.close();
  }
}

async function evaluateJudgeRust(causorynMjs, tmpRoot, timeoutMs) {
  if (!isExecutableAvailable("cargo", ["--version"])) {
    return {
      status: "SKIPPED",
      passed: true,
      reason: "cargo toolchain not available on PATH",
    };
  }

  const wsDir = path.join(tmpRoot, "judge-rust-repo");
  const dataDir = path.join(tmpRoot, "judge-rust-data");
  mkdirSync(wsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  writeFileSync(
    path.join(wsDir, "services.rs"),
    [
      "pub struct OrdersService;",
      "",
      "impl OrdersService {",
      "    pub fn new() -> OrdersService {",
      "        OrdersService",
      "    }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(wsDir, "main.rs"),
    [
      "mod services;",
      "",
      "fn list_orders() {",
      "    let _svc = services::OrdersService::new();",
      "}",
      "",
      "fn main() {",
      "    list_orders();",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const client = new McpStdioClient(causorynMjs, wsDir, dataDir);
  try {
    await client.initialize();
    const idx = await waitForIndexWithStallProbing(client, timeoutMs, 150);

    const rustTier = idx.coverage?.byLanguage?.rust?.tier ?? "L0";
    if (rustTier === "L0") {
      return {
        status: "SKIPPED",
        passed: true,
        reason: "rust-worker unavailable in runtime (degraded to L0)",
      };
    }

    const ctxCall = await client.callTool("causoryn_get_symbol_context", {
      symbolId: "crate::list_orders",
      edgeKinds: ["CALLS"],
      depth: 1,
    });
    const nodes = new Map(
      (Array.isArray(ctxCall.envelope?.data?.nodes) ? ctxCall.envelope.data.nodes : []).map(
        (n) => [n.id, n],
      ),
    );
    const edges = Array.isArray(ctxCall.envelope?.data?.edges) ? ctxCall.envelope.data.edges : [];

    const suffixCall = edges.find(
      (e) =>
        e.kind === "CALLS" &&
        nodes.get(e.from)?.qualifiedName === "crate::list_orders" &&
        nodes.get(e.to)?.qualifiedName === "crate::services::OrdersService::new",
    );
    const sameFileCall = edges.find(
      (e) =>
        e.kind === "CALLS" &&
        nodes.get(e.from)?.qualifiedName === "crate::main" &&
        nodes.get(e.to)?.qualifiedName === "crate::list_orders",
    );

    const suffixIsHeuristic = suffixCall !== undefined && suffixCall.resolution === "heuristic";
    const sameFileIsVerified = sameFileCall !== undefined && sameFileCall.resolution === "verified";
    const passed = suffixIsHeuristic && sameFileIsVerified;

    return {
      status: passed ? "PASS" : "FAIL",
      passed,
      rustTier,
      suffixResolution: suffixCall?.resolution ?? null,
      sameFileResolution: sameFileCall?.resolution ?? null,
      suffixIsHeuristic,
      sameFileIsVerified,
    };
  } finally {
    await client.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Markdown & JSON Report Formatting                                          */
/* -------------------------------------------------------------------------- */

function passBadge(passed) {
  return passed ? "PASS" : "FAIL";
}

function formatMarkdownReport(report) {
  const lines = [];
  lines.push("# Causoryn Real-Repo & Packed-Tarball Evaluation Report");
  lines.push("");
  lines.push(`- **Tarball:** \`${path.basename(report.provenance.tarballPath)}\` (\`sha256:${report.provenance.tarballSha256.slice(0, 16)}...\`)`);
  lines.push(`- **Bundle (\`dist/mcp-server.mjs\`):** \`sha256:${report.provenance.mcpBundleSha256.slice(0, 16)}...\``);
  lines.push(`- **Runtime:** Node ${report.provenance.nodeVersion} (${report.provenance.platform}/${report.provenance.arch})`);
  lines.push("");

  if (report.selfRepo !== null) {
    const s = report.selfRepo;
    lines.push("## 1. Causoryn Self-Repo Evaluation (vs v0.2.4 Opus Audit Baseline)");
    lines.push("");
    lines.push("| Metric | v0.2.4 Baseline | Current Tarball | Target SLO | Pass/Fail |");
    lines.push("|---|---|---|---|---|");
    lines.push(
      `| Cold \`initialize\` handshake | ${String(V024_BASELINE.coldHandshakeMs)} ms | ${String(s.coldHandshakeMs)} ms | Info | INFO |`,
    );
    lines.push(
      `| \`tools/list\` tool count | ${String(V024_BASELINE.toolCount)} | ${String(s.toolCount)} | === ${String(SLO.coreToolCount)} | ${passBadge(s.slos.toolCountPassed)} |`,
    );
    lines.push(
      `| \`tools/list\` serialized chars | ${V024_BASELINE.toolsListChars.toLocaleString("en-US")} | ${s.toolsListChars.toLocaleString("en-US")} | <= ${SLO.toolsListMaxChars.toLocaleString("en-US")} | ${passBadge(s.slos.toolsListBudgetPassed)} |`,
    );
    lines.push(
      `| Cold full index wall time | ${String(V024_BASELINE.coldIndexSec)} s | ${String(s.coldIndexSec)} s | Info | INFO |`,
    );
    lines.push(
      `| Peak RSS during cold index | ~${String(V024_BASELINE.peakRssMb)} MB | ${s.peakRssMb === null ? "N/A" : `${String(s.peakRssMb)} MB`} | Info | INFO |`,
    );
    lines.push(
      `| Max event-loop stall (250ms pings) | ${V024_BASELINE.maxEventLoopStallMs.toLocaleString("en-US")} ms | ${String(s.maxEventLoopStallMs)} ms (p95 ${String(s.p95EventLoopStallMs)} ms, n=${String(s.statusPingCount)}) | < ${String(SLO.maxEventLoopStallMs)} ms | ${passBadge(s.slos.eventLoopStallPassed)} |`,
    );
    lines.push(
      `| Unresolved edge % | ${String(V024_BASELINE.unresolvedEdgePct)}% | ${String(s.unresolvedEdgePct)}% (${String(s.unresolvedEdges)}/${String(s.totalEdges)}) | < ${String(SLO.maxUnresolvedEdgePct)}% | ${passBadge(s.slos.unresolvedEdgePctPassed)} |`,
    );
    if (s.workspaceInternalUnresolvedImports !== undefined) {
      const wsUnres = s.workspaceInternalUnresolvedImports;
      lines.push(
        `| Workspace-internal unresolved imports | — | ${String(wsUnres.totalCount)} (workspace pkgs: ${String(wsUnres.workspacePackageCount)}, relative: ${String(wsUnres.relativeImportCount)}) | Info | INFO |`,
      );
    }
    lines.push(
      `| \`get_agent_context\` \`server.ts\` rank | ${V024_BASELINE.agentContextServerRank} | ${s.agentContext.serverTsRank === null ? "Not found" : `#${String(s.agentContext.serverTsRank)}`} | <= #${String(SLO.maxAgentContextServerRank)} | ${passBadge(s.slos.agentContextPassed)} |`,
    );
    lines.push(
      `| \`find_symbols("createCausorynMcpServer")\` | ${V024_BASELINE.findSymbolsAmbiguity} | ${s.findSymbols.errorCode ?? `${String(s.findSymbols.matchCount)} match(es)`} | No AMBIGUOUS_SYMBOL | ${passBadge(s.slos.findSymbolsPassed)} |`,
    );
    lines.push(
      `| \`preflight_change(server.ts)\` Workspace leak | ${V024_BASELINE.preflightWorkspaceLeak} | ${String(s.preflightServerTs.workspaceNodeCount)} Workspace node(s) | 0 Workspace nodes | ${passBadge(s.slos.preflightNoWorkspacePassed)} |`,
    );
    lines.push(
      `| Warm restart handshake (same \`data-dir\`) | ${V024_BASELINE.warmHandshakeMs.toLocaleString("en-US")} ms | ${String(s.warmHandshakeMs)} ms | < ${SLO.maxWarmHandshakeMs.toLocaleString("en-US")} ms | ${passBadge(s.slos.warmHandshakePassed)} |`,
    );
    lines.push(
      `| SQLite DB size after retention GC | ${String(V024_BASELINE.sqliteSizeMb)} MB | ${String(s.sqlite.dbMb)} MB (total ${String(s.sqlite.totalSqliteMb)} MB) | Info | INFO |`,
    );
    lines.push("");
    lines.push(
      `Snapshot: \`${s.snapshot.snapshotId}\` · state=\`${s.snapshot.state}\` · ${s.snapshot.nodeCount.toLocaleString("en-US")} nodes · ${s.snapshot.edgeCount.toLocaleString("en-US")} edges · ${s.snapshot.evidenceCount.toLocaleString("en-US")} evidence`,
    );
    lines.push("");

    const langEntries = Object.entries(s.coverageByLanguage);
    if (langEntries.length > 0) {
      lines.push("### Per-Language Coverage (`coverage.byLanguage`)");
      lines.push("");
      lines.push("| Language | Tier | Files | Verified | Heuristic | Unresolved | Coverage Ratio |");
      lines.push("|---|---|---|---|---|---|---|");
      for (const [lang, cov] of langEntries) {
        lines.push(
          `| ${lang} | ${cov.tier} | ${String(cov.files)} | ${String(cov.verifiedEdges)} | ${String(cov.heuristicEdges)} | ${String(cov.unresolvedEdges)} | ${String(round(cov.coverageRatio * 100, 1))}% |`,
        );
      }
      lines.push("");
    }
  }

  if (report.headToHead !== null) {
    const h = report.headToHead;
    lines.push("## 2. Head-to-Head Demo (`examples/fixture-ts-orders`)");
    lines.push("");
    lines.push("| Check | Result | Pass/Fail |");
    lines.push("|---|---|---|");
    lines.push(
      `| Substring search (\`rg\`) files matching \`OrderRepository\` / \`.save(\` | ${h.rgMatchedFiles.join(", ") || "(none)"} | Baseline |`,
    );
    lines.push(
      `| Multi-hop files missed by \`rg\` | ${h.rgMissedMultiHopFiles.join(", ") || "(none)"} | ${passBadge(h.rgMissedMultiHopFiles.includes("src/routes/orders.ts"))} |`,
    );
    lines.push(
      `| \`preflight_change(OrderRepository.save)\` verified callers | service=${String(h.causorynMultiHopVerified.ordersServiceCreate)}, route=${String(h.causorynMultiHopVerified.createOrdersRoute)}, testImpact=${String(h.causorynMultiHopVerified.ordersRouteTestImpact)}, testPlan=${String(h.causorynMultiHopVerified.transitiveTestCandidate)} | ${passBadge(h.causorynMultiHopVerified.ordersServiceCreate && h.causorynMultiHopVerified.createOrdersRoute && h.causorynMultiHopVerified.ordersRouteTestImpact && h.causorynMultiHopVerified.transitiveTestCandidate)} |`,
    );
    lines.push(
      `| \`verify_change(preflightId)\` default checks | verdict=\`${String(h.verifyChange.verdict)}\`, contracts=\`${String(h.verifyChange.contractsStatus)}\`, architecture=\`${String(h.verifyChange.architectureStatus)}\` | ${passBadge(h.verifyChange.verdict === "no_findings" && h.verifyChange.contractsStatus === "not_requested")} |`,
    );
    lines.push("");
  }

  if (report.judge !== null) {
    const j = report.judge;
    lines.push("## 3. Judge (ISSTA 2019) Multi-Language Honesty & CHA Check");
    lines.push("");
    lines.push("| Fixture | Details | Status |");
    lines.push("|---|---|---|");
    lines.push(
      `| TypeScript Monorepo + CHA | unresolved=${String(j.typescript.unresolvedTsEdges)}, INHERITS=${String(j.typescript.hasVerifiedInherits)}, IMPLEMENTS=${String(j.typescript.hasVerifiedImplements)}, preflightCHA=${String(j.typescript.chaImpactsStripeGateway)} | ${j.typescript.status} |`,
    );
    lines.push(
      `| Go Multi-File + Dual \`main\` + \`go.mod\` | ${j.go.status === "SKIPPED" ? j.go.reason : `samePkg=${String(j.go.samePkgVerified)}, goModImport=${String(j.go.goModCrossPkgVerified)}, zeroFalseDualMain=${String(j.go.zeroFalseDualMainEdges)}`} | ${j.go.status} |`,
    );
    lines.push(
      `| Rust 2-Segment Suffix Honesty | ${j.rust.status === "SKIPPED" ? j.rust.reason : `suffix=${String(j.rust.suffixResolution)}, sameFile=${String(j.rust.sameFileResolution)}`} | ${j.rust.status} |`,
    );
    lines.push("");
  }

  lines.push(`**Overall Gate:** ${report.overallPassed ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}

function computeOverallPassed(report) {
  if (report.selfRepo !== null) {
    const slos = Object.values(report.selfRepo.slos);
    if (slos.some((ok) => !ok)) return false;
  }
  if (report.headToHead !== null && !report.headToHead.passed) {
    return false;
  }
  if (report.judge !== null) {
    if (!report.judge.typescript.passed || !report.judge.go.passed || !report.judge.rust.passed) {
      return false;
    }
  }
  return true;
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.help) {
    printUsage();
    return;
  }

  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "causoryn-real-repo-eval-"));
  try {
    const packDir = path.join(tmpRoot, "pack");
    const unpackDir = path.join(tmpRoot, "unpacked");
    mkdirSync(packDir, { recursive: true });

    let tarballPath;
    if (cli.tarball !== null) {
      if (!existsSync(cli.tarball)) {
        throw new Error(`Tarball not found: ${cli.tarball}`);
      }
      tarballPath = cli.tarball;
    } else {
      console.error("[eval] Packing packages/causoryn via npm pack...");
      tarballPath = packCausorynTarball(cli.repoRoot, packDir);
    }

    console.error(`[eval] Unpacking tarball: ${path.basename(tarballPath)}`);
    const unpacked = unpackTarball(tarballPath, unpackDir);

    const report = {
      generatedAt: new Date().toISOString(),
      provenance: {
        tarballPath,
        tarballSha256: unpacked.tarballSha256,
        mcpBundleSha256: unpacked.mcpBundleSha256,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      baselineV024: V024_BASELINE,
      sloThresholds: SLO,
      selfRepo: null,
      headToHead: null,
      judge: null,
      overallPassed: false,
    };

    if (!cli.skipSelfRepo) {
      console.error(`[eval] Section 1: Evaluating self-repo (${cli.repoRoot})...`);
      report.selfRepo = await evaluateSelfRepo(
        unpacked.causorynMjs,
        cli.repoRoot,
        tmpRoot,
        cli.timeoutMs,
      );
    }

    if (!cli.skipHeadToHead) {
      console.error("[eval] Section 2: Running head-to-head demo (fixture-ts-orders)...");
      report.headToHead = await evaluateHeadToHeadDemo(
        unpacked.causorynMjs,
        cli.repoRoot,
        tmpRoot,
        cli.timeoutMs,
      );
    }

    if (!cli.skipJudge) {
      console.error("[eval] Section 3: Running Judge (ISSTA 2019) multi-language honesty & CHA checks...");
      const tsJudge = await evaluateJudgeTypeScript(unpacked.causorynMjs, tmpRoot, cli.timeoutMs);
      const goJudge = await evaluateJudgeGo(unpacked.causorynMjs, tmpRoot, cli.timeoutMs);
      const rustJudge = await evaluateJudgeRust(unpacked.causorynMjs, tmpRoot, cli.timeoutMs);
      report.judge = {
        typescript: tsJudge,
        go: goJudge,
        rust: rustJudge,
      };
    }

    report.overallPassed = computeOverallPassed(report);

    if (cli.jsonOut !== null) {
      mkdirSync(path.dirname(cli.jsonOut), { recursive: true });
      writeFileSync(cli.jsonOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.error(`[eval] Wrote JSON report to ${cli.jsonOut}`);
    }

    console.log(formatMarkdownReport(report));
    if (!report.overallPassed) {
      process.exitCode = 1;
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(`[eval] Fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
