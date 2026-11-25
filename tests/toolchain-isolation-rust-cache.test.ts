/**
 * Rust worker build cache hardening:
 * - a cached worker binary (or its integrity pin) with a second hard link,
 *   another owner or group/world write access is never executed,
 * - the binary started is the file whose hash was verified (identity check
 *   right before the spawn),
 * - the pin of a fresh build comes from the bytes the build produced,
 * - the cache directory is private to the current user (POSIX 0700).
 */
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  analyzeRustWorkspace,
  computeRustWorkerSourceFingerprint,
  writeRustWorkerIntegrityMetadata,
} from "../adapters/rust/src/analyzer.js";
import { buildRustWorkerFromStagedSource } from "../adapters/rust/src/cargo.js";
import { WORKER_BINARY_NAME } from "../adapters/rust/src/types.js";
import {
  readWorkerBinaryIdentity,
  runWorkerAnalyze,
} from "../adapters/rust/src/worker-process.js";

const IS_WIN = process.platform === "win32";
const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

function readyChild(id: string): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const record = child as unknown as Record<string, unknown>;
  const stdout = new EventEmitter();
  record["stdout"] = stdout;
  record["stderr"] = new EventEmitter();
  record["stdin"] = Object.assign(new EventEmitter(), { write: () => true, end: () => {} });
  record["killed"] = false;
  record["exitCode"] = null;
  record["signalCode"] = null;
  record["kill"] = () => true;
  queueMicrotask(() => {
    stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          id,
          protocolVersion: "1",
          status: "ready",
          coverageRatio: 1,
          capabilities: {
            astParse: true,
            symbolResolution: true,
            containsEdges: true,
            callEdges: true,
            importEdges: false,
            routeDetection: "none",
            frameworkLinkers: false,
          },
          unsupportedConstructs: [],
          warnings: [],
          diagnostics: [],
          nodes: [],
          edges: [],
          evidence: [],
        })}\n`,
        "utf8",
      ),
    );
  });
  return child;
}

async function withEnv<T>(
  overrides: Readonly<Record<string, string | undefined>>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Asset root with a minimal worker crate plus a pinned cached binary. */
function stagePinnedCache(label: string): {
  readonly assetRoot: string;
  readonly cacheRoot: string;
  readonly cachedBin: string;
  readonly pinPath: string;
} {
  const base = tempDir(`causoryn-rs-cache-${label}-`);
  const assetRoot = path.join(base, "asset");
  const crate = path.join(assetRoot, "native", "rust-worker");
  mkdirSync(path.join(crate, "src"), { recursive: true });
  writeFileSync(path.join(crate, "Cargo.toml"), '[package]\nname = "causoryn-rust-worker"\nversion = "0.1.0"\n', "utf8");
  writeFileSync(path.join(crate, "Cargo.lock"), "version = 4\n", "utf8");
  writeFileSync(path.join(crate, "src", "main.rs"), "fn main() {}\n", "utf8");
  const cacheRoot = path.join(base, "cache");
  mkdirSync(path.join(cacheRoot, "debug"), { recursive: true });
  const cachedBin = path.join(cacheRoot, "debug", WORKER_BINARY_NAME);
  const bytes = Buffer.from(`cached-worker-${label}`, "utf8");
  writeFileSync(cachedBin, bytes);
  // Owner-only, independent of the umask (as the real build leaves it).
  if (!IS_WIN) chmodSync(cachedBin, 0o700);
  const fingerprint = computeRustWorkerSourceFingerprint(path.join(crate, "Cargo.toml"));
  expect(fingerprint).not.toBeNull();
  writeRustWorkerIntegrityMetadata(cachedBin, {
    sourceFingerprint: fingerprint!,
    binarySha256: createHash("sha256").update(bytes).digest("hex"),
  });
  return { assetRoot, cacheRoot, cachedBin, pinPath: `${cachedBin}.sha256.json` };
}

async function analyzeWithCache(
  stage: { readonly assetRoot: string; readonly cacheRoot: string },
  id: string,
): Promise<{ readonly available: boolean; readonly spawns: number; readonly warnings: string }> {
  let spawns = 0;
  const result = await withEnv(
    {
      CAUSORYN_ASSET_ROOT: stage.assetRoot,
      CAUSORYN_RUST_TARGET_DIR: stage.cacheRoot,
      CAUSORYN_RUST_WORKER_DIR: undefined,
    },
    () =>
      analyzeRustWorkspace({
        workspaceId: id,
        files: [{ path: "lib.rs", content: "pub fn a() {}\n" }],
        options: {
          autoBuild: false,
          spawnProcess: () => {
            spawns += 1;
            return readyChild(`analyze:${id}`);
          },
        },
      }),
  );
  return { available: result.workerAvailable, spawns, warnings: result.warnings.join("\n") };
}

describe("Rust worker cache: single-link, private files only", () => {
  it("control: an intact pinned cache binary is used", async () => {
    const stage = stagePinnedCache("control");
    const outcome = await analyzeWithCache(stage, "cache-control");
    expect(outcome.available).toBe(true);
    expect(outcome.spawns).toBe(1);
  });

  it("a cached worker binary with a second hard link is never executed", async () => {
    const stage = stagePinnedCache("hardlink-bin");
    linkSync(stage.cachedBin, path.join(path.dirname(stage.cacheRoot), "second-link"));
    const outcome = await analyzeWithCache(stage, "cache-hardlink-bin");
    expect(outcome.available).toBe(false);
    expect(outcome.spawns).toBe(0);
    expect(outcome.warnings).toContain("hard link");
  });

  it("an integrity pin with a second hard link is not trusted", async () => {
    const stage = stagePinnedCache("hardlink-pin");
    linkSync(stage.pinPath, path.join(path.dirname(stage.cacheRoot), "pin-link"));
    const outcome = await analyzeWithCache(stage, "cache-hardlink-pin");
    expect(outcome.available).toBe(false);
    expect(outcome.spawns).toBe(0);
    expect(outcome.warnings).toContain("hard link");
  });

  it.skipIf(IS_WIN)("a cached binary writable by group/other users is never executed", async () => {
    const stage = stagePinnedCache("world-writable-bin");
    chmodSync(stage.cachedBin, 0o777);
    const outcome = await analyzeWithCache(stage, "cache-world-writable");
    expect(outcome.available).toBe(false);
    expect(outcome.spawns).toBe(0);
    expect(outcome.warnings).toContain("writable by other users");
  });

  it.skipIf(IS_WIN)("an existing cache directory is made private (0700) before it is used", async () => {
    const stage = stagePinnedCache("private-dir");
    chmodSync(stage.cacheRoot, 0o777);
    chmodSync(path.join(stage.cacheRoot, "debug"), 0o775);
    const outcome = await analyzeWithCache(stage, "cache-private-dir");
    expect(outcome.available).toBe(true);
    expect(statSync(stage.cacheRoot).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(stage.cacheRoot, "debug")).mode & 0o777).toBe(0o700);
  });
});

describe("Rust worker binary identity is re-checked right before the spawn", () => {
  it("a binary replaced after its identity was recorded is not started", async () => {
    const dir = tempDir("causoryn-rs-identity-");
    const bin = path.join(dir, WORKER_BINARY_NAME);
    writeFileSync(bin, "verified-bytes", "utf8");
    const identity = readWorkerBinaryIdentity(bin);
    expect(identity).not.toBeNull();

    let spawns = 0;
    const unchanged = await runWorkerAnalyze({
      workerDir: dir,
      workerBinaryName: WORKER_BINARY_NAME,
      requestPayload: { id: "identity-same" },
      requestTimeoutMs: 5_000,
      expectedBinaryIdentity: identity!,
      spawnProcess: () => {
        spawns += 1;
        return readyChild("identity-same");
      },
    });
    expect(unchanged.status).toBe("ok");
    expect(spawns).toBe(1);

    // Swap in different bytes under the same name (new file, atomic rename).
    const replacement = path.join(dir, "replacement.tmp");
    writeFileSync(replacement, "swapped-bytes-of-another-length", "utf8");
    renameSync(replacement, bin);
    const swapped = await runWorkerAnalyze({
      workerDir: dir,
      workerBinaryName: WORKER_BINARY_NAME,
      requestPayload: { id: "identity-swapped" },
      requestTimeoutMs: 5_000,
      expectedBinaryIdentity: identity!,
      spawnProcess: () => {
        spawns += 1;
        return readyChild("identity-swapped");
      },
    });
    expect(spawns).toBe(1);
    expect(swapped.status).toBe("unavailable");
    expect(swapped.detail).toContain("changed after its integrity check");
  });
});

describe("a fresh build is pinned from the bytes it produced", () => {
  it("buildRustWorkerFromStagedSource reports the SHA-256 of the produced binary", async () => {
    const base = tempDir("causoryn-rs-build-pin-");
    const crate = path.join(base, "crate");
    mkdirSync(path.join(crate, "src"), { recursive: true });
    writeFileSync(path.join(crate, "Cargo.toml"), '[package]\nname = "causoryn-rust-worker"\nversion = "0.1.0"\n', "utf8");
    writeFileSync(path.join(crate, "Cargo.lock"), "version = 4\n", "utf8");
    writeFileSync(path.join(crate, "src", "main.rs"), "fn main() {}\n", "utf8");
    const cacheRoot = path.join(base, "cache");
    const destination = path.join(cacheRoot, "debug", WORKER_BINARY_NAME);
    const producedBytes = Buffer.from("freshly-built-worker-bytes", "utf8");

    const outcome = await buildRustWorkerFromStagedSource({
      sourceManifestPath: path.join(crate, "Cargo.toml"),
      cacheRoot,
      destinationBinaryPath: destination,
      untrustedRoots: [],
      timeoutMs: 5_000,
      cargoExecutable: process.execPath,
      spawnFn: (_command, args, opts) => {
        // Simulated cargo: writes the binary into --target-dir/debug and exits 0.
        const targetDir = args[args.indexOf("--target-dir") + 1]!;
        mkdirSync(path.join(targetDir, "debug"), { recursive: true });
        writeFileSync(path.join(targetDir, "debug", WORKER_BINARY_NAME), producedBytes);
        expect(opts.cwd).toBeDefined();
        const child = new EventEmitter() as unknown as ChildProcess;
        const record = child as unknown as Record<string, unknown>;
        record["stdout"] = new EventEmitter();
        record["stderr"] = new EventEmitter();
        record["exitCode"] = null;
        record["signalCode"] = null;
        record["kill"] = () => true;
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      },
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.binarySha256).toBe(createHash("sha256").update(producedBytes).digest("hex"));
    expect(readFileSync(destination).equals(producedBytes)).toBe(true);
    expect(existsSync(path.join(cacheRoot, "staging"))).toBe(true);
    if (!IS_WIN) {
      expect(statSync(cacheRoot).mode & 0o777).toBe(0o700);
      expect(statSync(path.dirname(destination)).mode & 0o777).toBe(0o700);
    }
  });
});
