/**
 * Rust worker build cache isolation (security scan findings F11 and F38).
 *
 * F11: the staged worker crate is built with `cargo build --manifest-path`
 * from a directory below the build cache. Without a `[workspace]` table cargo
 * searches every parent directory for a `Cargo.toml` with `[workspace]` and
 * adopts it as the workspace root (its `[patch]` and `Cargo.lock` then govern
 * the build): https://doc.rust-lang.org/cargo/reference/workspaces.html
 * ("Cargo will automatically search the parent directories ...") and
 * https://doc.rust-lang.org/cargo/reference/manifest.html#the-workspace-field
 * ("inferred as the first Cargo.toml with [workspace] upwards in the
 * filesystem"). A `[workspace]` table in the package's own manifest makes the
 * package the root package, so the search never starts.
 *
 * F38: on Windows Node exposes no owner or ACL of a directory, so the cache
 * that holds the executed worker binary and its integrity pin is trusted only
 * when it resolves inside the user's profile directory (whose ACL admits the
 * user, SYSTEM and Administrators); anything else is refused before it is
 * created, executed or built into.
 *
 * Safety: the only real cargo invocation is `cargo locate-project` on fixture
 * manifests (no build, no build script, offline); cargo builds are simulated.
 */
import { spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  analyzeRustWorkspace,
  computeRustWorkerSourceFingerprint,
  writeRustWorkerIntegrityMetadata,
} from "../src/analyzer.js";
import { buildRustWorkerFromStagedSource, resolveCargoExecutable } from "../src/cargo.js";
import { preparePrivateDirectory } from "../src/file-integrity.js";
import { WORKER_BINARY_NAME } from "../src/types.js";

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

const PACKAGE_MANIFEST = '[package]\nname = "causoryn-rust-worker"\nversion = "0.1.0"\nedition = "2021"\n';

function stageCrate(dir: string): string {
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "Cargo.toml"), PACKAGE_MANIFEST, "utf8");
  writeFileSync(path.join(dir, "Cargo.lock"), "version = 4\n", "utf8");
  writeFileSync(path.join(dir, "src", "main.rs"), "fn main() {}\n", "utf8");
  return path.join(dir, "Cargo.toml");
}

function exitingChild(code: number): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const record = child as unknown as Record<string, unknown>;
  record["stdout"] = new EventEmitter();
  record["stderr"] = new EventEmitter();
  record["exitCode"] = null;
  record["signalCode"] = null;
  record["kill"] = () => true;
  queueMicrotask(() => child.emit("exit", code, null));
  return child;
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
    const response = {
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
    };
    stdout.emit("data", Buffer.from(`${JSON.stringify(response)}\n`, "utf8"));
  });
  return child;
}

async function withEnv<T>(overrides: Readonly<Record<string, string | undefined>>, fn: () => Promise<T>): Promise<T> {
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

describe("staged Rust worker build: the staged crate is its own workspace root (F11)", () => {
  it("the staged manifest keeps the shipped manifest and adds a [workspace] table", async () => {
    const base = tempDir("causoryn-rs-ws-table-");
    const cacheRoot = path.join(base, "cache");
    let staged: string | null = null;
    const outcome = await buildRustWorkerFromStagedSource({
      sourceManifestPath: stageCrate(path.join(base, "crate")),
      cacheRoot,
      destinationBinaryPath: path.join(cacheRoot, "debug", WORKER_BINARY_NAME),
      untrustedRoots: [],
      timeoutMs: 5_000,
      cargoExecutable: process.execPath,
      trustedConfigRoot: base,
      spawnFn: (_command, args) => {
        staged = readFileSync(args[args.indexOf("--manifest-path") + 1]!, "utf8");
        return exitingChild(1);
      },
    });
    expect(outcome.ok).toBe(false);
    expect(staged).not.toBeNull();
    expect(staged!.startsWith(PACKAGE_MANIFEST)).toBe(true);
    expect(staged!).toMatch(/^\[workspace\][ \t]*$/m);
    // The shipped manifest itself is never modified.
    expect(readFileSync(path.join(base, "crate", "Cargo.toml"), "utf8")).toBe(PACKAGE_MANIFEST);
  });

  // A package installed read-only (a global npm prefix owned by another account,
  // or a locked-down image): the staged copies keep the read-only mode, and the
  // [workspace] table must still be added to the private staged manifest.
  it("adds the [workspace] table when the shipped crate files are read-only", async () => {
    const base = tempDir("causoryn-rs-ws-readonly-");
    const crate = path.join(base, "crate");
    const manifest = stageCrate(crate);
    for (const file of [manifest, path.join(crate, "Cargo.lock"), path.join(crate, "src", "main.rs")]) {
      if (existsSync(file)) chmodSync(file, 0o444);
    }
    const cacheRoot = path.join(base, "cache");
    let staged: string | null = null;
    try {
      const outcome = await buildRustWorkerFromStagedSource({
        sourceManifestPath: manifest,
        cacheRoot,
        destinationBinaryPath: path.join(cacheRoot, "debug", WORKER_BINARY_NAME),
        untrustedRoots: [],
        timeoutMs: 5_000,
        cargoExecutable: process.execPath,
        trustedConfigRoot: base,
        spawnFn: (_command, args) => {
          staged = readFileSync(args[args.indexOf("--manifest-path") + 1]!, "utf8");
          return exitingChild(1);
        },
      });
      expect(staged, outcome.detail ?? "").not.toBeNull();
      expect(staged!).toMatch(/^\[workspace\][ 	]*$/m);
      expect(readFileSync(manifest, "utf8")).toBe(PACKAGE_MANIFEST);
    } finally {
      for (const file of [manifest, path.join(crate, "Cargo.lock"), path.join(crate, "src", "main.rs")]) {
        if (existsSync(file)) chmodSync(file, 0o644);
      }
    }
  });

  it("a manifest that already declares [workspace] is staged unchanged", async () => {
    const base = tempDir("causoryn-rs-ws-present-");
    const crate = path.join(base, "crate");
    const manifest = stageCrate(crate);
    const withWorkspace = `${PACKAGE_MANIFEST}\n[workspace]\n`;
    writeFileSync(manifest, withWorkspace, "utf8");
    const cacheRoot = path.join(base, "cache");
    let staged: string | null = null;
    await buildRustWorkerFromStagedSource({
      sourceManifestPath: manifest,
      cacheRoot,
      destinationBinaryPath: path.join(cacheRoot, "debug", WORKER_BINARY_NAME),
      untrustedRoots: [],
      timeoutMs: 5_000,
      cargoExecutable: process.execPath,
      trustedConfigRoot: base,
      spawnFn: (_command, args) => {
        staged = readFileSync(args[args.indexOf("--manifest-path") + 1]!, "utf8");
        return exitingChild(1);
      },
    });
    expect(staged).toBe(withWorkspace);
  });

  const cargo = resolveCargoExecutable();
  it.skipIf(cargo === null)(
    "real cargo resolves the staged manifest as the workspace root below a foreign Cargo.toml with [workspace]",
    async () => {
      const base = tempDir("causoryn-rs-ws-foreign-");
      // A foreign workspace root above the cache that claims the staging directories.
      writeFileSync(path.join(base, "Cargo.toml"), '[workspace]\nmembers = ["cache/staging/*"]\n', "utf8");
      const cacheRoot = path.join(base, "cache");
      let stagedManifest = "";
      let located: { status: number | null; stdout: string; stderr: string } | null = null;
      await buildRustWorkerFromStagedSource({
        sourceManifestPath: stageCrate(path.join(base, "crate")),
        cacheRoot,
        destinationBinaryPath: path.join(cacheRoot, "debug", WORKER_BINARY_NAME),
        untrustedRoots: [],
        timeoutMs: 60_000,
        cargoExecutable: process.execPath,
        trustedConfigRoot: base,
        spawnFn: (_command, args, options) => {
          stagedManifest = args[args.indexOf("--manifest-path") + 1]!;
          // Where would cargo put the workspace root of this build? (no build is run)
          const probe = spawnSync(
            cargo!,
            ["locate-project", "--workspace", "--message-format", "plain", "--manifest-path", stagedManifest],
            {
              cwd: options.cwd,
              env: { ...options.env, CARGO_NET_OFFLINE: "true" },
              encoding: "utf8",
              shell: false,
              windowsHide: true,
              timeout: 60_000,
            },
          );
          const stdout = String(probe.stdout).trim();
          located = {
            status: probe.status,
            stderr: String(probe.stderr),
            // Resolved while the staging directory still exists (it is removed after the build).
            stdout: probe.status === 0 && stdout.length > 0 ? realpathSync.native(stdout) : stdout,
          };
          stagedManifest = realpathSync.native(stagedManifest);
          return exitingChild(1);
        },
      });
      expect(located).not.toBeNull();
      expect(located!.status, located!.stderr).toBe(0);
      expect(located!.stdout).toBe(stagedManifest);
    },
    120_000,
  );
});

/** A minimal worker crate under `assetRoot` plus a pinned cached binary in `cacheRoot`. */
function stagePinnedCache(assetRoot: string, cacheRoot: string): void {
  stageCrate(path.join(assetRoot, "native", "rust-worker"));
  mkdirSync(path.join(cacheRoot, "debug"), { recursive: true });
  const cachedBin = path.join(cacheRoot, "debug", WORKER_BINARY_NAME);
  const bytes = Buffer.from("cached-worker", "utf8");
  writeFileSync(cachedBin, bytes);
  const fingerprint = computeRustWorkerSourceFingerprint(path.join(assetRoot, "native", "rust-worker", "Cargo.toml"));
  writeRustWorkerIntegrityMetadata(cachedBin, {
    sourceFingerprint: fingerprint!,
    binarySha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

async function analyzeWithProfile(
  profile: string,
  assetRoot: string,
  cacheRoot: string,
  id: string,
): Promise<{ readonly available: boolean; readonly spawns: number; readonly warnings: string }> {
  let spawns = 0;
  const result = await withEnv(
    {
      USERPROFILE: profile,
      CAUSORYN_ASSET_ROOT: assetRoot,
      CAUSORYN_RUST_TARGET_DIR: cacheRoot,
      CAUSORYN_RUST_WORKER_DIR: undefined,
    },
    async () => {
      expect(os.homedir()).toBe(profile);
      return analyzeRustWorkspace({
        workspaceId: id,
        files: [{ path: "lib.rs", content: "pub fn a() {}\n" }],
        options: {
          autoBuild: false,
          spawnProcess: () => {
            spawns += 1;
            return readyChild(`analyze:${id}`);
          },
        },
      });
    },
  );
  return { available: result.workerAvailable, spawns, warnings: result.warnings.join("\n") };
}

describe.skipIf(!IS_WIN)("Windows: the Rust worker cache must resolve inside the user profile (F38)", () => {
  it("preparePrivateDirectory refuses a directory outside the profile and creates nothing there", () => {
    const base = tempDir("causoryn-rs-profile-outside-");
    const profile = path.join(base, "profile");
    mkdirSync(profile);
    const outside = path.join(base, "shared", "cache");
    expect(preparePrivateDirectory(outside, true, { perUserRoot: profile })).toContain("outside the user profile");
    expect(existsSync(path.join(base, "shared"))).toBe(false);
    expect(preparePrivateDirectory(path.join(profile, "cache"), true, { perUserRoot: profile })).toBeNull();
    expect(existsSync(path.join(profile, "cache"))).toBe(true);
  });

  it("a junction inside the profile that leads outside it is refused", () => {
    const base = tempDir("causoryn-rs-profile-junction-");
    const profile = path.join(base, "profile");
    const shared = path.join(base, "shared");
    mkdirSync(profile);
    mkdirSync(path.join(shared, "cache"), { recursive: true });
    symlinkSync(shared, path.join(profile, "link"), "junction");
    expect(preparePrivateDirectory(path.join(profile, "link", "cache"), false, { perUserRoot: profile })).toContain(
      "outside the user profile",
    );
  });

  it("an intact pinned cache outside the profile is never executed; the same cache inside it is used", async () => {
    const base = tempDir("causoryn-rs-profile-exec-");
    const profile = path.join(base, "profile");
    mkdirSync(profile);
    const assetRoot = path.join(base, "asset");
    const sharedCache = path.join(base, "shared-cache");
    stagePinnedCache(assetRoot, sharedCache);

    const refused = await analyzeWithProfile(profile, assetRoot, sharedCache, "profile-outside");
    expect(refused.available).toBe(false);
    expect(refused.spawns).toBe(0);
    expect(refused.warnings).toContain("outside the user profile");

    const accepted = await analyzeWithProfile(base, assetRoot, sharedCache, "profile-inside");
    expect(accepted.available).toBe(true);
    expect(accepted.spawns).toBe(1);
  });

  it("a fresh build into a cache outside the profile is refused before cargo starts", async () => {
    const base = tempDir("causoryn-rs-profile-build-");
    const profile = path.join(base, "profile");
    mkdirSync(profile);
    const cacheRoot = path.join(base, "shared-cache");
    let spawned = false;
    const outcome = await withEnv({ USERPROFILE: profile }, () =>
      buildRustWorkerFromStagedSource({
        sourceManifestPath: stageCrate(path.join(base, "crate")),
        cacheRoot,
        destinationBinaryPath: path.join(cacheRoot, "debug", WORKER_BINARY_NAME),
        untrustedRoots: [],
        timeoutMs: 5_000,
        cargoExecutable: process.execPath,
        trustedConfigRoot: base,
        spawnFn: () => {
          spawned = true;
          return exitingChild(0);
        },
      }),
    );
    expect(spawned).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("outside the user profile");
    expect(existsSync(cacheRoot)).toBe(false);
  });
});
