import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

/**
 * F20 (CWE-427): MCP Registry clients start the server as
 * `npx <runtimeArguments> causoryn@<version> <packageArguments>`, and the
 * registry entry has no working-directory field, so a client that starts
 * stdio servers in the workspace runs npx inside the analyzed repository.
 * npm then takes its project context from that repository: its `.npmrc`
 * (registry, script-shell, node-options) and a committed
 * `node_modules/causoryn` that satisfies the spec.
 *
 * `--prefix=~/` makes npm treat the user's home directory as the project
 * (npm config docs: "If set on the command line, then it forces non-global
 * commands to run in the specified folder"; npm expands `~/` itself, no
 * shell needed). The command still runs in the client's working directory
 * (libnpmexec: "we always run in cwd, not --prefix"), so `--allow-cwd` keeps
 * binding the workspace.
 *
 * Documented residual, pinned below: npm still puts `<cwd>/node_modules/.bin`
 * (and every parent's) on PATH after the package's own bin directory, so a
 * repository can still shadow the `node` that the package's bin shim starts.
 *
 * This suite runs the npm that ships with the Node running the tests, with a
 * temporary HOME and npm cache, `--offline`, and a probe package name that
 * is not published (nothing is downloaded or run from the registry).
 */

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROBE = "causoryn-f20-registry-probe";
const PROJECT_REGISTRY = "http://127.0.0.1:9/";

function findNpmCli(): string | undefined {
  const fromEnv = process.env["npm_execpath"];
  const candidates = [
    ...(fromEnv === undefined ? [] : [path.join(path.dirname(fromEnv), "npm-cli.js")]),
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

const NPM_CLI = findNpmCli();

function registryRuntimeArguments(): string[] {
  const serverJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "server.json"), "utf8")) as {
    packages: Array<{ runtimeHint: string; runtimeArguments?: Array<{ type: string; value?: string }> }>;
  };
  const pkg = serverJson.packages[0];
  expect(pkg?.runtimeHint).toBe("npx");
  return (pkg?.runtimeArguments ?? []).map((arg) => {
    expect(arg.type).toBe("positional");
    return arg.value ?? "";
  });
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Sandbox {
  readonly home: string;
  readonly cache: string;
  readonly project: string;
}

/** A hostile project: its own registry and script shell, and a committed local package satisfying the spec. */
function hostileProject(): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-f20-"));
  roots.push(root);
  const home = path.join(root, "home");
  const cache = path.join(root, "npm-cache");
  const project = path.join(root, "project");
  const pkgDir = path.join(project, "node_modules", PROBE);
  const binDir = path.join(project, "node_modules", ".bin");
  for (const dir of [home, cache, pkgDir, binDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "hostile-project", version: "1.0.0" }));
  writeFileSync(
    path.join(project, ".npmrc"),
    `registry=${PROJECT_REGISTRY}\nscript-shell=${path.join(project, "evil-shell")}\n`,
  );
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: PROBE, version: "1.0.0", bin: { [PROBE]: "bin.js" } }),
  );
  writeFileSync(path.join(pkgDir, "bin.js"), 'console.log("LOCAL PROBE RAN");\n');
  writeFileSync(
    path.join(project, "node_modules", ".package-lock.json"),
    JSON.stringify({
      name: "hostile-project",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { [`node_modules/${PROBE}`]: { version: "1.0.0", bin: { [PROBE]: "bin.js" } } },
    }),
  );
  writeFileSync(path.join(binDir, `${PROBE}.cmd`), `@node "%~dp0\\..\\${PROBE}\\bin.js" %*\r\n`);
  const shim = path.join(binDir, PROBE);
  writeFileSync(shim, `#!/bin/sh\nexec node "$(dirname "$0")/../${PROBE}/bin.js" "$@"\n`);
  chmodSync(shim, 0o755);
  return { home, cache, project };
}

/** Runs npm in the project with only the sandbox's HOME and cache (no inherited npm_config_*). */
function npm(sandbox: Sandbox, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_/i.test(key)) continue;
    env[key] = value;
  }
  env["HOME"] = sandbox.home;
  env["USERPROFILE"] = sandbox.home;
  env["npm_config_cache"] = sandbox.cache;
  env["npm_config_update_notifier"] = "false";
  env["npm_config_fund"] = "false";
  const result = spawnSync(process.execPath, [NPM_CLI as string, ...args], {
    cwd: sandbox.project,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const cwdProbe = ["-c", "node -e \"console.log('CWD=' + process.cwd())\""];

describe.skipIf(NPM_CLI === undefined)("F20: the registry npx entry keeps npm out of the project's context", () => {
  it("the hostile project does take over a bare npx (control: the fixture is effective)", () => {
    const sandbox = hostileProject();
    expect(npm(sandbox, ["config", "get", "registry"]).stdout.trim()).toBe(PROJECT_REGISTRY);
    const local = npm(sandbox, ["exec", "--offline", "--ignore-scripts", "--", `${PROBE}@1.0.0`]);
    // The project's script-shell is used to start the local package (it does not exist here).
    expect(`${local.stdout}\n${local.stderr}`).toMatch(/LOCAL PROBE RAN|evil-shell|ENOENT/);
  });

  it("does not read the project's .npmrc", () => {
    const sandbox = hostileProject();
    const runtime = registryRuntimeArguments();
    expect(npm(sandbox, ["config", "get", "registry", ...runtime]).stdout.trim()).not.toBe(PROJECT_REGISTRY);
    expect(npm(sandbox, ["config", "get", "script-shell", ...runtime]).stdout).not.toContain("evil-shell");
  });

  it("does not run a package committed to the project's node_modules", () => {
    const sandbox = hostileProject();
    const run = npm(sandbox, ["exec", ...registryRuntimeArguments(), "--offline", "--", `${PROBE}@1.0.0`]);
    expect(run.stdout).not.toContain("LOCAL PROBE RAN");
    // Not in the project, so npm looks it up in the (offline, empty) cache instead.
    expect(run.stderr).toMatch(/ENOTCACHED/);
  });

  it("still runs the server in the client's working directory, so --allow-cwd binds the workspace", () => {
    const sandbox = hostileProject();
    const run = npm(sandbox, ["exec", ...registryRuntimeArguments(), ...cwdProbe]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`CWD=${sandbox.project}`);
  });

  it("documented residual: <cwd>/node_modules/.bin stays on PATH (npm runs in the cwd, not the prefix)", () => {
    const sandbox = hostileProject();
    const run = npm(sandbox, [
      "exec",
      ...registryRuntimeArguments(),
      "-c",
      "node -e \"console.log('PATH=' + process.env.PATH)\"",
    ]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(path.join(sandbox.project, "node_modules", ".bin"));
  });
});
