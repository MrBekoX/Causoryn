import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeCSharpWorkspace } from "@causoryn/adapter-csharp-roslyn";
import { analyzeGoWorkspace } from "@causoryn/adapter-go";
import { analyzePythonWorkspace } from "@causoryn/adapter-python";
import {
  analyzeRustWorkspace,
  computeRustWorkerSourceFingerprint,
  rustWorkerIntegrityPath,
  writeRustWorkerIntegrityMetadata,
} from "../src/analyzer.js";
import {
  buildToolEnv,
  CARGO_ENV_ALLOWLIST,
  isCargoAvailable,
  runCargoBuild,
} from "../src/cargo.js";
import {
  defaultWorkerDir,
  defaultWorkerManifestPath,
  defaultWritableRustTargetDir,
  WORKER_BINARY_NAME,
} from "../src/types.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_DIR = path.dirname(TEST_DIR);
const ADAPTERS_ROOT = path.dirname(ADAPTER_DIR);
const REPO_ROOT = path.dirname(ADAPTERS_ROOT);

function createFakeSuccessChild(requestId: string): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter();
  const record = child as unknown as Record<string, unknown>;
  record["stdout"] = stdout;
  record["stderr"] = stderr;
  record["stdin"] = Object.assign(stdin, {
    write: () => true,
    end: () => {},
  });
  record["killed"] = false;
  record["exitCode"] = null;
  record["signalCode"] = null;
  record["kill"] = () => {
    record["killed"] = true;
    return true;
  };
  queueMicrotask(() => {
    const payload = JSON.stringify({
      id: requestId,
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
    });
    stdout.emit("data", Buffer.from(`${payload}\n`, "utf8"));
  });
  return child;
}

function withTemporaryEnv<T>(
  overrides: Readonly<Record<string, string | undefined>>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    saved.set(key, process.env[key]);
    const next = overrides[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, prev] of saved.entries()) {
        if (prev === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = prev;
        }
      }
    });
}

interface TreeSnapshotEntry {
  readonly relativePath: string;
  readonly entryKind: "dir" | "file";
  readonly sha256: string;
  readonly contentHex: string;
}

function snapshotTreeRecursive(rootDir: string): TreeSnapshotEntry[] {
  const results: TreeSnapshotEntry[] = [];
  const walk = (currentDir: string, prefix: string): void => {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        results.push({
          relativePath: relPath,
          entryKind: "dir",
          sha256: "",
          contentHex: "",
        });
        walk(fullPath, relPath);
      } else {
        const raw = readFileSync(fullPath);
        results.push({
          relativePath: relPath,
          entryKind: "file",
          sha256: createHash("sha256").update(raw).digest("hex"),
          contentHex: raw.toString("hex"),
        });
      }
    }
  };
  walk(rootDir, "");
  return results;
}

function setTreePermissions(rootDir: string, readOnly: boolean): void {
  if (process.platform === "win32" || !existsSync(rootDir)) {
    return;
  }
  if (readOnly) {
    const lockWalk = (currentDir: string): void => {
      for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          lockWalk(fullPath);
        } else {
          chmodSync(fullPath, 0o444);
        }
      }
      chmodSync(currentDir, 0o555);
    };
    lockWalk(rootDir);
    return;
  }
  const unlockWalk = (currentDir: string): void => {
    chmodSync(currentDir, 0o755);
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        unlockWalk(fullPath);
      } else {
        chmodSync(fullPath, 0o644);
      }
    }
  };
  unlockWalk(rootDir);
}

describe("4 sidecar adapter dinamik asset root keşfi (CAUSORYN_ASSET_ROOT)", () => {
  it("python adapter: CAUSORYN_PYTHON_WORKER_SCRIPT tanımsızken CAUSORYN_ASSET_ROOT altındaki worker.py yolunu kullanır", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-py-asset-"));
    try {
      const capturedArgs: Array<readonly string[]> = [];
      await withTemporaryEnv(
        {
          CAUSORYN_ASSET_ROOT: tmpDir,
          CAUSORYN_PYTHON_WORKER_SCRIPT: undefined,
        },
        async () => {
          const result = await analyzePythonWorkspace({
            workspaceId: "py-asset",
            files: [{ path: "app.py", content: "x = 1\n" }],
            options: {
              spawnProcess: (_cmd, args) => {
                capturedArgs.push(args);
                return createFakeSuccessChild("analyze:py-asset");
              },
            },
          });
          expect(result.workerAvailable).toBe(true);
        },
      );

      expect(capturedArgs).toHaveLength(1);
      expect(capturedArgs[0]).toEqual([
        "-I",
        "-B",
        "-X",
        "utf8",
        path.join(tmpDir, "native", "python-worker", "worker.py"),
      ]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("csharp-roslyn adapter: paketlenmiş düz Causoryn.RoslynWorker.dll mevcutsa onu seçer; yoksa bin/Debug/net10.0 yoluna düşer", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-cs-asset-"));
    try {
      const fallbackArgs: Array<readonly string[]> = [];
      await withTemporaryEnv(
        {
          CAUSORYN_ASSET_ROOT: tmpDir,
          CAUSORYN_ROSLYN_WORKER_DLL: undefined,
        },
        async () => {
          await analyzeCSharpWorkspace({
            workspaceId: "cs-fallback",
            files: [{ path: "Program.cs", content: "class P {}\n" }],
            options: {
              spawnProcess: (_cmd, args) => {
                fallbackArgs.push(args);
                return createFakeSuccessChild("analyze:cs-fallback");
              },
            },
          });
        },
      );

      expect(fallbackArgs[0]).toEqual([
        "exec",
        path.join(
          tmpDir,
          "native",
          "roslyn-worker",
          "bin",
          "Debug",
          "net10.0",
          "Causoryn.RoslynWorker.dll",
        ),
      ]);

      const flatDir = path.join(tmpDir, "native", "roslyn-worker");
      mkdirSync(flatDir, { recursive: true });
      const flatDll = path.join(flatDir, "Causoryn.RoslynWorker.dll");
      writeFileSync(flatDll, "stub", "utf8");

      const flatArgs: Array<readonly string[]> = [];
      await withTemporaryEnv(
        {
          CAUSORYN_ASSET_ROOT: tmpDir,
          CAUSORYN_ROSLYN_WORKER_DLL: undefined,
        },
        async () => {
          await analyzeCSharpWorkspace({
            workspaceId: "cs-flat",
            files: [{ path: "Program.cs", content: "class P {}\n" }],
            options: {
              spawnProcess: (_cmd, args) => {
                flatArgs.push(args);
                return createFakeSuccessChild("analyze:cs-flat");
              },
            },
          });
        },
      );

      expect(flatArgs[0]).toEqual(["exec", flatDll]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("go adapter: CAUSORYN_GO_WORKER_DIR tanımsızken CAUSORYN_ASSET_ROOT altındaki native/go-worker cwd'sini kullanır", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-go-asset-"));
    try {
      const capturedCwds: Array<string | undefined> = [];
      await withTemporaryEnv(
        {
          CAUSORYN_ASSET_ROOT: tmpDir,
          CAUSORYN_GO_WORKER_DIR: undefined,
          CAUSORYN_GO_WORKER_BIN: undefined,
        },
        async () => {
          const result = await analyzeGoWorkspace({
            workspaceId: "go-asset",
            files: [{ path: "main.go", content: "package main\n" }],
            options: {
              spawnProcess: (_cmd, _args, opts) => {
                capturedCwds.push(opts.cwd);
                return createFakeSuccessChild("analyze:go-asset");
              },
            },
          });
          expect(result.workerAvailable).toBe(true);
        },
      );

      expect(capturedCwds).toEqual([path.join(tmpDir, "native", "go-worker")]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("rust adapter types: defaultWorkerDir ve defaultWorkerManifestPath dinamik olarak CAUSORYN_ASSET_ROOT okur", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-rs-asset-"));
    try {
      await withTemporaryEnv(
        {
          CAUSORYN_ASSET_ROOT: tmpDir,
          CAUSORYN_RUST_WORKER_DIR: undefined,
        },
        () => {
          expect(defaultWorkerDir()).toBe(
            path.join(tmpDir, "native", "rust-worker", "target", "debug"),
          );
          expect(defaultWorkerManifestPath()).toBe(
            path.join(tmpDir, "native", "rust-worker", "Cargo.toml"),
          );
        },
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("Rust yazılabilir CARGO_TARGET_DIR önbelleği ve fallback zinciri", () => {
  it("CARGO_ENV_ALLOWLIST içinde CARGO_TARGET_DIR bulunur ve defaultWritableRustTargetDir env/homedir kurallarına uyar", () => {
    expect(CARGO_ENV_ALLOWLIST).toContain("CARGO_TARGET_DIR");

    expect(
      defaultWritableRustTargetDir({
        CAUSORYN_RUST_TARGET_DIR: "  /custom/rust-target  ",
      }),
    ).toBe("/custom/rust-target");

    expect(defaultWritableRustTargetDir({})).toBe(
      path.join(os.homedir(), ".causoryn", "cache", "rust-worker-target"),
    );
    expect(
      defaultWritableRustTargetDir({ CAUSORYN_RUST_TARGET_DIR: "   " }),
    ).toBe(path.join(os.homedir(), ".causoryn", "cache", "rust-worker-target"));
  });

  it("runCargoBuild: güvenli targetDir verildiğinde child env içine CARGO_TARGET_DIR yazar", async () => {
    const capturedEnvs: Array<Readonly<Record<string, string>>> = [];
    const safeTarget = path.join(os.tmpdir(), "causoryn-safe-cargo-target");

    const outcome = await runCargoBuild({
      manifestPath: path.join(REPO_ROOT, "native", "rust-worker", "Cargo.toml"),
      timeoutMs: 5_000,
      targetDir: safeTarget,
      spawnFn: (_cmd, _args, opts) => {
        capturedEnvs.push(opts.env);
        const child = createFakeSuccessChild("unused");
        queueMicrotask(() => {
          child.emit("exit", 0, null);
        });
        return child;
      },
    });

    expect(outcome.status).toBe(0);
    expect(capturedEnvs).toHaveLength(1);
    expect(capturedEnvs[0]?.["CARGO_TARGET_DIR"]).toBe(safeTarget);
  });

  it("runCargoBuild: isSafeCommandPath reddedilen targetDir ile çağrıldığında fail-closed (status:null + açık spawnError) döner", async () => {
    let spawnCalled = false;

    const outcome = await runCargoBuild({
      manifestPath: path.join(REPO_ROOT, "native", "rust-worker", "Cargo.toml"),
      timeoutMs: 5_000,
      targetDir: "bad;target$dir",
      spawnFn: () => {
        spawnCalled = true;
        const child = createFakeSuccessChild("unused");
        queueMicrotask(() => {
          child.emit("exit", 0, null);
        });
        return child;
      },
    });

    expect(spawnCalled).toBe(false);
    expect(outcome.status).toBeNull();
    expect(outcome.spawnError.length).toBeGreaterThan(0);
  });

  it("runCargoBuild: targetDir verildiğinde ve Cargo.lock mevcutsa --locked ekler; Cargo.lock yoksa veya targetDir tanımsızsa eklemez", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-rs-locked-"));
    try {
      const safeTarget = path.join(tmpDir, "safe-target");
      const repoManifest = path.join(
        REPO_ROOT,
        "native",
        "rust-worker",
        "Cargo.toml",
      );

      // 1) targetDir tanımlı + Cargo.lock mevcut → ["build", "--locked", "--manifest-path", manifestPath, "--target-dir", targetDir]
      const lockedArgs: Array<readonly string[]> = [];
      const lockedOutcome = await runCargoBuild({
        manifestPath: repoManifest,
        timeoutMs: 5_000,
        targetDir: safeTarget,
        spawnFn: (_cmd, args) => {
          lockedArgs.push(args);
          const child = createFakeSuccessChild("unused");
          queueMicrotask(() => {
            child.emit("exit", 0, null);
          });
          return child;
        },
      });
      expect(lockedOutcome.status).toBe(0);
      expect(lockedArgs).toEqual([
        ["build", "--locked", "--manifest-path", repoManifest, "--target-dir", safeTarget],
      ]);

      // 2) targetDir tanımsız (Cargo.lock mevcut olsa bile) → ["build", "--manifest-path", manifestPath]
      const noTargetArgs: Array<readonly string[]> = [];
      await withTemporaryEnv({ CARGO_TARGET_DIR: undefined }, async () => {
        const noTargetOutcome = await runCargoBuild({
          manifestPath: repoManifest,
          timeoutMs: 5_000,
          spawnFn: (_cmd, args) => {
            noTargetArgs.push(args);
            const child = createFakeSuccessChild("unused");
            queueMicrotask(() => {
              child.emit("exit", 0, null);
            });
            return child;
          },
        });
        expect(noTargetOutcome.status).toBe(0);
      });
      expect(noTargetArgs).toEqual([["build", "--manifest-path", repoManifest]]);

      // 3) targetDir tanımlı ama Cargo.lock yok → ["build", "--manifest-path", manifestPath]
      const unlockedDir = path.join(tmpDir, "unlocked-crate");
      mkdirSync(unlockedDir, { recursive: true });
      const unlockedManifest = path.join(unlockedDir, "Cargo.toml");
      writeFileSync(unlockedManifest, '[package]\nname = "x"\nversion = "0.1.0"\n', "utf8");

      const unlockedArgs: Array<readonly string[]> = [];
      const unlockedOutcome = await runCargoBuild({
        manifestPath: unlockedManifest,
        timeoutMs: 5_000,
        targetDir: safeTarget,
        spawnFn: (_cmd, args) => {
          unlockedArgs.push(args);
          const child = createFakeSuccessChild("unused");
          queueMicrotask(() => {
            child.emit("exit", 0, null);
          });
          return child;
        },
      });
      expect(unlockedOutcome.status).toBe(0);
      expect(unlockedArgs).toEqual([
        ["build", "--manifest-path", unlockedManifest, "--target-dir", safeTarget],
      ]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("negatif (a): runCargoBuild güvensiz manifestPath ile çağrıldığında fail-closed döner", async () => {
    let unsafeManifestSpawned = false;
    const unsafeManifestOutcome = await runCargoBuild({
      manifestPath: "bad;manifest$path/Cargo.toml",
      timeoutMs: 5_000,
      spawnFn: () => {
        unsafeManifestSpawned = true;
        const child = createFakeSuccessChild("unused");
        queueMicrotask(() => {
          child.emit("exit", 0, null);
        });
        return child;
      },
    });
    expect(unsafeManifestSpawned).toBe(false);
    expect(unsafeManifestOutcome.status).toBeNull();
    expect(unsafeManifestOutcome.spawnError.length).toBeGreaterThan(0);
  });

  it("negatif (b): targetDir verilmemişken miras process.env.CARGO_TARGET_DIR güvensizse buildToolEnv kopyalamaz ve runCargoBuild fail-closed döner", async () => {
    await withTemporaryEnv(
      { CARGO_TARGET_DIR: "bad;inherited$target" },
      async () => {
        const filteredEnv = buildToolEnv(CARGO_ENV_ALLOWLIST, null);
        expect("CARGO_TARGET_DIR" in filteredEnv).toBe(false);

        let unsafeEnvSpawned = false;
        const unsafeEnvOutcome = await runCargoBuild({
          manifestPath: path.join(
            REPO_ROOT,
            "native",
            "rust-worker",
            "Cargo.toml",
          ),
          timeoutMs: 5_000,
          spawnFn: () => {
            unsafeEnvSpawned = true;
            const child = createFakeSuccessChild("unused");
            queueMicrotask(() => {
              child.emit("exit", 0, null);
            });
            return child;
          },
        });
        expect(unsafeEnvSpawned).toBe(false);
        expect(unsafeEnvOutcome.status).toBeNull();
        expect(unsafeEnvOutcome.spawnError.length).toBeGreaterThan(0);
      },
    );
  });

  it("partial: güvensiz CAUSORYN_RUST_TARGET_DIR ve hazır binary yokluğunda analyzeRustWorkspace L0/L1 dosya düzeyine zarifçe düşer", async () => {
    const tmpDir = mkdtempSync(
      path.join(os.tmpdir(), "causoryn-rs-unsafe-target-"),
    );
    try {
      const emptyAssetRoot = path.join(tmpDir, "empty-asset");
      mkdirSync(emptyAssetRoot, { recursive: true });

      await withTemporaryEnv(
        {
          CAUSORYN_ASSET_ROOT: emptyAssetRoot,
          CAUSORYN_RUST_TARGET_DIR: "bad;rust$target",
          CAUSORYN_RUST_WORKER_DIR: undefined,
        },
        async () => {
          const result = await analyzeRustWorkspace({
            workspaceId: "rs-unsafe-target-partial",
            files: [
              { path: "src/lib.rs", content: "pub fn alpha() -> i32 { 1 }\n" },
              { path: "src/util.rs", content: "pub fn beta() -> i32 { 2 }\n" },
            ],
          });

          expect(result.workerAvailable).toBe(false);
          expect(result.state).toBe("partial");
          expect(result.coverageRatio).toBe(0);
          expect(result.edges).toEqual([]);
          expect(result.nodes).toHaveLength(2);
          expect(result.nodes.every((n) => n.kind === "File")).toBe(true);
          expect(result.nodes.map((n) => n.relativePath)).toEqual([
            "src/lib.rs",
            "src/util.rs",
          ]);
          expect(result.warnings.some((w) => w.includes("L0/L1"))).toBe(true);
        },
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("hasExplicitWorkerDir=false iken önce assetRoot içindeki binary'yi, yoksa cacheTargetDir/debug altındaki binary'yi seçer", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-rs-order-"));
    try {
      const assetRoot = path.join(tmpDir, "asset-root");
      const cacheTargetDir = path.join(tmpDir, "cache-target");
      const assetDebugDir = path.join(
        assetRoot,
        "native",
        "rust-worker",
        "target",
        "debug",
      );
      const cacheDebugDir = path.join(cacheTargetDir, "debug");

      mkdirSync(cacheDebugDir, { recursive: true });
      const workerSourceDir = path.join(assetRoot, "native", "rust-worker");
      mkdirSync(path.join(workerSourceDir, "src"), { recursive: true });
      const manifestPath = path.join(workerSourceDir, "Cargo.toml");
      writeFileSync(
        manifestPath,
        '[package]\nname = "causoryn-rust-worker"\nversion = "0.1.0"\n',
        "utf8",
      );
      writeFileSync(path.join(workerSourceDir, "src", "main.rs"), "fn main() {}\n", "utf8");
      const cacheBinPath = path.join(cacheDebugDir, WORKER_BINARY_NAME);
      writeFileSync(cacheBinPath, "bin", "utf8");
      const sourceFingerprint = computeRustWorkerSourceFingerprint(manifestPath);
      expect(sourceFingerprint).not.toBeNull();
      writeRustWorkerIntegrityMetadata(cacheBinPath, {
        sourceFingerprint: sourceFingerprint!,
        binarySha256: createHash("sha256").update("bin", "utf8").digest("hex"),
      });

      // Adım 2: assetRoot altında binary yok ama cacheTargetDir/debug altında var → cacheDebugDir kullanılır.
      const step2Paths: string[] = [];
      await withTemporaryEnv(
        {
          CAUSORYN_ASSET_ROOT: assetRoot,
          CAUSORYN_RUST_TARGET_DIR: cacheTargetDir,
          CAUSORYN_RUST_WORKER_DIR: undefined,
        },
        async () => {
          const res = await analyzeRustWorkspace({
            workspaceId: "rs-step2",
            files: [{ path: "lib.rs", content: "pub fn f() {}\n" }],
            options: {
              spawnProcess: (_cmd, _args, opts) => {
                step2Paths.push(opts.env["PATH"] ?? "");
                return createFakeSuccessChild("analyze:rs-step2");
              },
            },
          });
          expect(res.workerAvailable).toBe(true);
        },
      );

      expect(step2Paths[0]?.startsWith(cacheDebugDir + path.delimiter)).toBe(
        true,
      );

      // Adım 1: assetRoot altında da binary mevcutsa doğrudan assetDebugDir seçilir.
      mkdirSync(assetDebugDir, { recursive: true });
      writeFileSync(path.join(assetDebugDir, WORKER_BINARY_NAME), "bin", "utf8");

      const step1Paths: string[] = [];
      await withTemporaryEnv(
        {
          CAUSORYN_ASSET_ROOT: assetRoot,
          CAUSORYN_RUST_TARGET_DIR: cacheTargetDir,
          CAUSORYN_RUST_WORKER_DIR: undefined,
        },
        async () => {
          const res = await analyzeRustWorkspace({
            workspaceId: "rs-step1",
            files: [{ path: "lib.rs", content: "pub fn f() {}\n" }],
            options: {
              spawnProcess: (_cmd, _args, opts) => {
                step1Paths.push(opts.env["PATH"] ?? "");
                return createFakeSuccessChild("analyze:rs-step1");
              },
            },
          });
          expect(res.workerAvailable).toBe(true);
        },
      );

      expect(step1Paths[0]?.startsWith(assetDebugDir + path.delimiter)).toBe(
        true,
      );

      // Explicit workerDir verildiğinde cacheDebugDir'e yönlenmez (mevcut davranış korunur).
      const explicitDir = path.join(tmpDir, "explicit-missing-dir");
      const explicitPaths: string[] = [];
      await withTemporaryEnv(
        {
          CAUSORYN_ASSET_ROOT: path.join(tmpDir, "empty-asset"),
          CAUSORYN_RUST_TARGET_DIR: cacheTargetDir,
          CAUSORYN_RUST_WORKER_DIR: undefined,
        },
        async () => {
          await analyzeRustWorkspace({
            workspaceId: "rs-explicit",
            files: [{ path: "lib.rs", content: "pub fn f() {}\n" }],
            options: {
              workerDir: explicitDir,
              spawnProcess: (_cmd, _args, opts) => {
                explicitPaths.push(opts.env["PATH"] ?? "");
                return createFakeSuccessChild("analyze:rs-explicit");
              },
            },
          });
        },
      );

      expect(explicitPaths[0]?.startsWith(explicitDir + path.delimiter)).toBe(
        true,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  const cargoAvailable = isCargoAvailable();
  it.skipIf(!cargoAvailable)(
    "adım 3 (uçtan uca): target/ içermeyen paketlenmiş native/rust-worker kaynağını yazılabilir CAUSORYN_RUST_TARGET_DIR içine derleyip çalıştırır; paket dizinine yazmaz",
    async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-rs-e2e-"));
      const stagedPkgRoot = path.join(tmpDir, "ro-pkg");
      try {
        const stagedRustWorker = path.join(
          stagedPkgRoot,
          "native",
          "rust-worker",
        );
        const stagedRustSrc = path.join(stagedRustWorker, "src");
        mkdirSync(stagedRustSrc, { recursive: true });
        writeFileSync(
          path.join(stagedRustWorker, "Cargo.toml"),
          [
            "[package]",
            'name = "causoryn-rust-worker"',
            'version = "0.1.0"',
            'edition = "2021"',
            "",
            "[dependencies]",
            "",
          ].join("\n"),
          "utf8",
        );
        writeFileSync(
          path.join(stagedRustWorker, "Cargo.lock"),
          [
            "# This file is automatically @generated by Cargo.",
            "# It is not intended for manual editing.",
            "version = 4",
            "",
            "[[package]]",
            'name = "causoryn-rust-worker"',
            'version = "0.1.0"',
            "",
          ].join("\n"),
          "utf8",
        );
        writeFileSync(
          path.join(stagedRustSrc, "main.rs"),
          [
            "use std::io::{self, BufRead, Write};",
            "",
            "fn extract_id(line: &str) -> String {",
            '    let needle = "\\"id\\":\\"";',
            "    if let Some(start) = line.find(needle) {",
            "        let (_, rest) = line.split_at(start + needle.len());",
            "        if let Some(end) = rest.find('\"') {",
            "            let (id_slice, _) = rest.split_at(end);",
            "            return id_slice.to_string();",
            "        }",
            "    }",
            '    String::from("analyze:unknown")',
            "}",
            "",
            "fn main() {",
            "    let stdin = io::stdin();",
            "    let mut first_line = String::new();",
            "    let _ = stdin.lock().read_line(&mut first_line);",
            "    let req_id = extract_id(&first_line);",
            "    let response = format!(",
            '        "{{\\"id\\":\\"{}\\",\\"protocolVersion\\":\\"1\\",\\"status\\":\\"ready\\",\\"coverageRatio\\":1.0,\\"capabilities\\":{{\\"astParse\\":true,\\"symbolResolution\\":true,\\"containsEdges\\":true,\\"callEdges\\":true,\\"importEdges\\":false,\\"routeDetection\\":\\"rust-attribute-macro-route-pattern\\",\\"frameworkLinkers\\":false}},\\"unsupportedConstructs\\":[],\\"warnings\\":[],\\"diagnostics\\":[],\\"nodes\\":[],\\"edges\\":[],\\"evidence\\":[]}}\\n",',
            "        req_id",
            "    );",
            "    let _ = io::stdout().write_all(response.as_bytes());",
            "    let _ = io::stdout().flush();",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );

        const beforeSnapshot = snapshotTreeRecursive(stagedPkgRoot);
        setTreePermissions(stagedPkgRoot, true);

        const writableTargetDir = path.join(tmpDir, "writable-rust-target");

        await withTemporaryEnv(
          {
            CAUSORYN_ASSET_ROOT: stagedPkgRoot,
            CAUSORYN_RUST_TARGET_DIR: writableTargetDir,
            CAUSORYN_RUST_WORKER_DIR: undefined,
          },
          async () => {
            const result = await analyzeRustWorkspace({
              workspaceId: "rs-packaged-e2e",
              files: [
                {
                  path: "lib.rs",
                  content:
                    "pub fn compute() -> i32 { helper() }\npub fn helper() -> i32 { 7 }\n",
                },
              ],
            });

            expect(result.workerAvailable).toBe(true);
            expect(result.state).toBe("ready");
            const builtBinPath = path.join(
              writableTargetDir,
              "debug",
              WORKER_BINARY_NAME,
            );
            expect(existsSync(builtBinPath)).toBe(true);
            expect(existsSync(rustWorkerIntegrityPath(builtBinPath))).toBe(true);
            expect(existsSync(path.join(stagedRustWorker, "target"))).toBe(
              false,
            );
          },
        );

        const afterSnapshot = snapshotTreeRecursive(stagedPkgRoot);
        expect(afterSnapshot).toEqual(beforeSnapshot);
      } finally {
        setTreePermissions(stagedPkgRoot, false);
        rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    },
    240_000,
  );
});
