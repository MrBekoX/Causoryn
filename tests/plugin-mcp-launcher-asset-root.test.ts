/**
 * `packages/causoryn/scripts/plugin-mcp-launcher.mjs` — CAUSORYN_ASSET_ROOT handling.
 *
 * The asset root decides where the server loads sidecar worker sources from
 * (`native/`). The launcher verifies its own package (`causoryn` at the pinned
 * `--expected-version`); an inherited CAUSORYN_ASSET_ROOT must not silently
 * redirect the server to a different tree. An explicit override is kept for
 * development, but only when it is an absolute path to an existing `causoryn`
 * package directory of the same verified version that contains `native/`.
 * Anything else exits 2 with a `stderr` diagnostic and nothing on `stdout`.
 *
 * The launcher is exercised as a real child process inside a minimal fake
 * package whose `dist/mcp-server.mjs` stub reports the asset root it received.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PKG_SCRIPTS = path.join(REPO_ROOT, "packages", "causoryn", "scripts");
const VERSION = "1.2.3";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  // realpath: the launcher derives its package root from its resolved module path
  // (on macOS os.tmpdir() is a /var -> /private/var symlink).
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), `causoryn-launcher-${prefix}-`)));
  tempDirs.push(dir);
  return dir;
}

interface FakePackageOptions {
  readonly name?: string;
  readonly version?: string;
  readonly withNative?: boolean;
  readonly withLauncher?: boolean;
}

/** A directory laid out like the published package: package.json, native/, and optionally the launcher + bundle stub. */
function makePackageDir(root: string, options: FakePackageOptions = {}): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: options.name ?? "causoryn", version: options.version ?? VERSION }),
    "utf8",
  );
  if (options.withNative ?? true) {
    mkdirSync(path.join(root, "native", "python-worker"), { recursive: true });
    writeFileSync(path.join(root, "native", "python-worker", "worker.py"), "# stub\n", "utf8");
  }
  if (options.withLauncher ?? false) {
    mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
    copyFileSync(
      path.join(PKG_SCRIPTS, "plugin-mcp-launcher.mjs"),
      path.join(root, "scripts", "plugin-mcp-launcher.mjs"),
    );
    copyFileSync(
      path.join(PKG_SCRIPTS, "lib", "node-version-guard.mjs"),
      path.join(root, "scripts", "lib", "node-version-guard.mjs"),
    );
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(
      path.join(root, "dist", "mcp-server.mjs"),
      'process.stdout.write(JSON.stringify({ assetRoot: process.env["CAUSORYN_ASSET_ROOT"] ?? null, argv: process.argv.slice(2) }) + "\\n");\n',
      "utf8",
    );
  }
  return root;
}

interface LauncherRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runLauncher(pkgRoot: string, assetRoot: string | undefined, cwd: string): LauncherRun {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["CAUSORYN_ASSET_ROOT"];
  delete env["CAUSORYN_EXPECTED_VERSION"];
  if (assetRoot !== undefined) env["CAUSORYN_ASSET_ROOT"] = assetRoot;
  const res = spawnSync(
    process.execPath,
    [path.join(pkgRoot, "scripts", "plugin-mcp-launcher.mjs"), "--expected-version", VERSION, "--allow-cwd"],
    { cwd, env, encoding: "utf8", shell: false, timeout: 30_000 },
  );
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function reportedAssetRoot(run: LauncherRun): string | null {
  const parsed = JSON.parse(run.stdout.trim()) as { assetRoot: string | null; argv: string[] };
  expect(parsed.argv).toEqual(["mcp", "--allow-cwd"]);
  return parsed.assetRoot;
}

describe("plugin-mcp-launcher.mjs — CAUSORYN_ASSET_ROOT", () => {
  it("binds the asset root to its own verified package when the variable is unset or blank", () => {
    const base = tempDir("unset");
    const pkg = makePackageDir(path.join(base, "pkg"), { withLauncher: true });
    const cwd = makePackageDir(path.join(base, "workspace"), { withNative: false });

    const unset = runLauncher(pkg, undefined, cwd);
    expect(unset.status, unset.stderr).toBe(0);
    expect(reportedAssetRoot(unset)).toBe(pkg);

    const blank = runLauncher(pkg, "   ", cwd);
    expect(blank.status, blank.stderr).toBe(0);
    expect(reportedAssetRoot(blank)).toBe(pkg);
  });

  it("keeps an explicit override that is an absolute path to a causoryn package of the same version with native/", () => {
    const base = tempDir("override");
    const pkg = makePackageDir(path.join(base, "pkg"), { withLauncher: true });
    const devTree = makePackageDir(path.join(base, "dev-tree"));

    const run = runLauncher(pkg, devTree, base);
    expect(run.status, run.stderr).toBe(0);
    expect(reportedAssetRoot(run)).toBe(devTree);
  });

  it.each([
    ["a relative path", (base: string) => path.relative(base, makePackageDir(path.join(base, "rel-tree"))), /absolute path/],
    ["a missing directory", (base: string) => path.join(base, "does-not-exist"), /does not exist/],
    [
      "a file instead of a directory",
      (base: string) => {
        const file = path.join(base, "plain-file");
        writeFileSync(file, "x", "utf8");
        return file;
      },
      /not a directory/,
    ],
    [
      "a directory without package.json",
      (base: string) => {
        const dir = path.join(base, "no-manifest");
        mkdirSync(path.join(dir, "native"), { recursive: true });
        return dir;
      },
      /package\.json/,
    ],
    [
      "a different package",
      (base: string) => makePackageDir(path.join(base, "other-pkg"), { name: "not-causoryn" }),
      /causoryn@1\.2\.3/,
    ],
    [
      "a causoryn package of another version",
      (base: string) => makePackageDir(path.join(base, "old-pkg"), { version: "1.2.2" }),
      /causoryn@1\.2\.3/,
    ],
    [
      "a causoryn package without native/",
      (base: string) => makePackageDir(path.join(base, "no-native"), { withNative: false }),
      /native/,
    ],
  ] as const)("rejects %s (exit 2, stderr only, server not started)", (_label, makeValue, reason) => {
    const base = tempDir("reject");
    const pkg = makePackageDir(path.join(base, "pkg"), { withLauncher: true });
    const value = makeValue(base);

    const run = runLauncher(pkg, value, base);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("[causoryn-launcher] CAUSORYN_ASSET_ROOT rejected");
    expect(run.stderr).toMatch(reason);
  });
});
