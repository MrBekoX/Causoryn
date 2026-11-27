import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
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
    // The process reports its cwd's real path (macOS: /var is a link to /private/var).
    const reported = /^CWD=(.*)$/m.exec(run.stdout)?.[1]?.trim();
    expect(reported, run.stdout).toBeDefined();
    expect(realpathSync(reported ?? "")).toBe(realpathSync(sandbox.project));
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

/* ------------------------------------------------------------------ */
/* F20 round 3: what the PATH residual can still reach                 */
/* ------------------------------------------------------------------ */

/**
 * With `<cwd>/node_modules/.bin` (and every parent's) on PATH after the
 * package's own bin directory, a repository could still choose the `node`
 * that starts the server: a bin with `#!/usr/bin/env node` (and cmd-shim's
 * Windows shim for it) looks `node` up on that PATH, and on Windows cmd.exe
 * also searches the current directory first, for `node` and for the bin name
 * itself (NeedCurrentDirectoryForExePathW). Measured with npm 11.13:
 * `node_modules/.bin/node(.cmd)`, a repository-root `node.cmd` and a
 * repository-root `causoryn.cmd` all ran instead of the server.
 *
 * Now (1) the registry entry sets NoDefaultCurrentDirectoryInExePath=1, so
 * cmd.exe does not search the current directory, and (2) the package's bin is
 * a shebang-less launcher (scripts/causoryn.cmd, read by sh and by cmd.exe) that
 * starts the CLI with the absolute node npm runs (`npm_node_execpath`).
 * Still open, pinned below: on POSIX npm starts the command through a bare
 * `sh` looked up on that PATH, so `node_modules/.bin/sh` runs first.
 *
 * The launcher is exercised as shipped (packages/causoryn/scripts/causoryn.cmd and
 * scripts/lib/windows-argv.mjs) with a probe CLI that reports its argv,
 * node and stdin; the control is the same probe behind the previous bin form.
 *
 * Review round 4: on Windows the launcher no longer puts `%*` on a command
 * line (where cmd.exe would parse it once more than npm escapes for): it
 * echoes `%*` unparsed in UTF-8 into two captures, with two different FOR
 * variables, and node takes the arguments from them. Every argument then
 * reaches the CLI exactly, or the start is refused (exit 2); nothing an
 * argument contains is ever run.
 */

const IS_WINDOWS = process.platform === "win32";
const PKG_DIR = path.join(REPO_ROOT, "packages", "causoryn");
const PROBE_CLI = [
  'const args = process.argv.slice(2);',
  'let stdin = "";',
  'if (args[0] === "--echo-stdin") { stdin = require("node:fs").readFileSync(0, "utf8").split(/\\r?\\n/)[0]; }',
  'console.log("CAUSORYN-PROBE " + JSON.stringify({ argv: args, execPath: process.execPath, stdin }));',
  'if (args[0] === "--exit") process.exitCode = Number(args[1]);',
  "",
].join("\n");

type BinForm = "launcher" | "shebang";

/** A `causoryn` package whose CLI is the probe, behind the shipped launcher or the previous shebang bin. */
function probePackage(root: string, form: BinForm): string {
  const dir = path.join(root, `pkg-${form}`);
  mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
  const bin = form === "launcher" ? "scripts/causoryn.cmd" : "scripts/causoryn.mjs";
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `causoryn-f20-${form}`, version: "1.0.0", bin: { causoryn: bin } }));
  // CommonJS probe (the launcher imports scripts/causoryn.mjs; a .mjs file is ESM, so use createRequire).
  const cli = `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\n${PROBE_CLI}`;
  writeFileSync(path.join(dir, "scripts", "causoryn.mjs"), form === "shebang" ? `#!/usr/bin/env node\n${cli}` : cli);
  if (form === "launcher") {
    writeFileSync(path.join(dir, "scripts", "causoryn.cmd"), readFileSync(path.join(PKG_DIR, "scripts", "causoryn.cmd")));
    // The launcher's helpers as shipped (scripts/lib/*.mjs).
    for (const name of readdirSync(path.join(PKG_DIR, "scripts", "lib"))) {
      if (name.endsWith(".mjs")) copyFileSync(path.join(PKG_DIR, "scripts", "lib", name), path.join(dir, "scripts", "lib", name));
    }
    chmodSync(path.join(dir, "scripts", "causoryn.cmd"), 0o755);
  } else {
    chmodSync(path.join(dir, "scripts", "causoryn.mjs"), 0o755);
  }
  return dir;
}

type Plant = "bin-node" | "root-node" | "root-causoryn" | "bin-sh";

/** A repository that plants one of the measured hijacks; each prints a marker and exits 7. */
function plantedProject(plant: Plant | null): Sandbox & { readonly root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-f20r3-"));
  roots.push(root);
  const home = path.join(root, "home");
  const cache = path.join(root, "npm-cache");
  const project = path.join(root, "project");
  const binDir = path.join(project, "node_modules", ".bin");
  for (const dir of [home, cache, binDir, path.join(root, "tmp"), path.join(root, "localappdata")]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "planted-project", version: "1.0.0" }));
  const marker = `HIJACK-${String(plant).toUpperCase()}`;
  const winScript = `@echo ${marker}\r\n@exit /b 7\r\n`;
  const shScript = `#!/bin/sh\necho ${marker}\nexit 7\n`;
  const write = (file: string, text: string): void => {
    writeFileSync(file, text);
    chmodSync(file, 0o755);
  };
  if (plant === "bin-node") write(path.join(binDir, IS_WINDOWS ? "node.cmd" : "node"), IS_WINDOWS ? winScript : shScript);
  if (plant === "root-node") write(path.join(project, "node.cmd"), winScript);
  if (plant === "root-causoryn") write(path.join(project, "causoryn.cmd"), winScript);
  if (plant === "bin-sh") write(path.join(binDir, "sh"), shScript);
  return { root, home, cache, project };
}

/** The registry entry's environment variables, as a client sets them. */
function registryEnvironment(): Record<string, string> {
  const serverJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "server.json"), "utf8")) as {
    packages: Array<{ environmentVariables?: Array<{ name: string; value?: string }> }>;
  };
  const out: Record<string, string> = {};
  for (const variable of serverJson.packages[0]?.environmentVariables ?? []) {
    if (variable.value !== undefined) out[variable.name] = variable.value;
  }
  return out;
}

interface ProbeRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly probe: { argv: string[]; execPath: string; stdin: string } | null;
}

/**
 * `npx <runtimeArguments> --offline --package=<probe> -- causoryn <args>` in the
 * project, as a registry client starts the server; `registryEnv` adds the
 * entry's environment variables. The harness running these tests may itself
 * set NoDefaultCurrentDirectoryInExePath, so it is removed first.
 */
function probeEnvironment(sandbox: Sandbox, registryEnv: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_/i.test(key) || /^NoDefaultCurrentDirectoryInExePath$/i.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    // The sandbox's own temporary and local application data directories (plantedProject): the
    // Windows launcher writes its captures under %LOCALAPPDATA%\causoryn\argv, never under %TEMP%.
    TEMP: path.join(path.dirname(sandbox.home), "tmp"),
    TMP: path.join(path.dirname(sandbox.home), "tmp"),
    LOCALAPPDATA: path.join(path.dirname(sandbox.home), "localappdata"),
    npm_config_cache: sandbox.cache,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_yes: "true",
    ...(registryEnv ? registryEnvironment() : {}),
  });
  return env;
}

/** The launcher's capture root in a sandbox (%LOCALAPPDATA%\causoryn\argv). */
function captureRoot(sandbox: { readonly root: string }): string {
  return path.join(sandbox.root, "localappdata", "causoryn", "argv");
}

/** Capture directories (and a held lock) the launcher left in a sandbox, under %TEMP% or its capture root. */
function leftoverCaptures(sandbox: { readonly root: string }): string[] {
  const inTemp = readdirSync(path.join(sandbox.root, "tmp")).filter((name) => name.startsWith("causoryn-argv-"));
  const root = captureRoot(sandbox);
  return [...inTemp, ...(existsSync(root) ? readdirSync(root) : [])];
}

function probeNpmArguments(pkg: string, args: readonly string[]): string[] {
  return [NPM_CLI as string, "exec", ...registryRuntimeArguments(), "--offline", `--package=${pkg}`, "--", "causoryn", ...args];
}

function probeRun(result: { status: number | null; stdout: string; stderr: string }): ProbeRun {
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith("CAUSORYN-PROBE "));
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    probe: line === undefined ? null : (JSON.parse(line.slice("CAUSORYN-PROBE ".length)) as ProbeRun["probe"]),
  };
}

function runProbe(
  sandbox: Sandbox & { readonly root: string },
  form: BinForm,
  args: readonly string[],
  options: { readonly registryEnv: boolean; readonly input?: string },
): ProbeRun {
  const pkg = probePackage(sandbox.root, form);
  const result = spawnSync(process.execPath, probeNpmArguments(pkg, args), {
    cwd: sandbox.project,
    env: probeEnvironment(sandbox, options.registryEnv),
    encoding: "utf8",
    timeout: 120_000,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  return probeRun(result);
}

function expectServerRan(run: ProbeRun, args: readonly string[] = []): void {
  expect(run.stdout, run.stderr).not.toMatch(/HIJACK-/);
  expect(run.probe, `${run.stdout}\n${run.stderr}`).not.toBeNull();
  expect(run.probe?.argv).toEqual(args);
  // The node npm itself runs (the one running these tests), not one found on PATH.
  expect(run.probe?.execPath.toLowerCase()).toBe(process.execPath.toLowerCase());
}

describe.skipIf(NPM_CLI === undefined)("F20 round 3: the server starts with npm's own node", () => {
  /**
   * The schema is a verbatim copy of
   * https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
   * (sha256 3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0,
   * fetched 2026-11-26), validated with the ajv the MCP SDK itself depends on.
   */
  it("validates server.json against the MCP Registry 2025-12-11 schema, with NoDefaultCurrentDirectoryInExePath=1 set", () => {
    const sdkEntry = createRequire(path.join(REPO_ROOT, "packages", "mcp-server", "package.json")).resolve(
      "@modelcontextprotocol/sdk/server/index.js",
    );
    const sdkRequire = createRequire(sdkEntry);
    const ajvModule = sdkRequire("ajv") as { default?: AjvConstructor } & AjvConstructor;
    const formatsModule = sdkRequire("ajv-formats") as { default?: (ajv: AjvInstance) => void } & ((ajv: AjvInstance) => void);
    const Ajv = ajvModule.default ?? ajvModule;
    const addFormats = formatsModule.default ?? formatsModule;
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const schemaPath = path.join(REPO_ROOT, "tests", "fixtures", "mcp-registry", "server.schema.2025-12-11.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
    const serverJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "server.json"), "utf8")) as Record<string, unknown>;
    expect(serverJson["$schema"]).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    const validate = ajv.compile(schema);
    expect(validate(serverJson), JSON.stringify(validate.errors)).toBe(true);
    // The fixture really is a validator: a package entry without its required fields fails.
    expect(validate({ ...serverJson, packages: [{ registryType: "npm" }] })).toBe(false);
    expect(registryEnvironment()).toEqual({ NoDefaultCurrentDirectoryInExePath: "1" });
  });

  it("control: the previous #!/usr/bin/env node bin runs the repository's node_modules/.bin/node", () => {
    const run = runProbe(plantedProject("bin-node"), "shebang", [], { registryEnv: true });
    expect(run.stdout).toContain("HIJACK-BIN-NODE");
    expect(run.probe).toBeNull();
  });

  it("the launcher starts the CLI with npm's node despite node_modules/.bin/node", () => {
    expectServerRan(runProbe(plantedProject("bin-node"), "launcher", ["mcp", "--allow-cwd"], { registryEnv: true }), [
      "mcp",
      "--allow-cwd",
    ]);
  });

  it("passes stdin through and returns the CLI's exit code", () => {
    const sandbox = plantedProject(null);
    const echoed = runProbe(sandbox, "launcher", ["--echo-stdin"], { registryEnv: true, input: '{"jsonrpc":"2.0"}\n' });
    expectServerRan(echoed, ["--echo-stdin"]);
    expect(echoed.probe?.stdin).toBe('{"jsonrpc":"2.0"}');
    const exited = runProbe(sandbox, "launcher", ["--exit", "5"], { registryEnv: true });
    expect(exited.status).toBe(5);
  });

  it.runIf(IS_WINDOWS)("control: a repository-root node.cmd runs for the previous bin when cmd.exe searches the current directory", () => {
    const run = runProbe(plantedProject("root-node"), "shebang", [], { registryEnv: false });
    expect(run.stdout).toContain("HIJACK-ROOT-NODE");
  });

  it.runIf(IS_WINDOWS)("the launcher ignores a repository-root node.cmd, even without the registry environment", () => {
    expectServerRan(runProbe(plantedProject("root-node"), "launcher", [], { registryEnv: false }));
  });

  it.runIf(IS_WINDOWS)("control: a repository-root causoryn.cmd runs instead of the bin when cmd.exe searches the current directory", () => {
    const run = runProbe(plantedProject("root-causoryn"), "launcher", [], { registryEnv: false });
    expect(run.stdout).toContain("HIJACK-ROOT-CAUSORYN");
  });

  it.runIf(IS_WINDOWS)("the registry environment (NoDefaultCurrentDirectoryInExePath=1) makes a repository-root causoryn.cmd unreachable", () => {
    expectServerRan(runProbe(plantedProject("root-causoryn"), "launcher", [], { registryEnv: true }));
  });

  it.runIf(!IS_WINDOWS)("documented residual: npm's bare `sh` still runs node_modules/.bin/sh first", () => {
    const run = runProbe(plantedProject("bin-sh"), "launcher", [], { registryEnv: true });
    expect(run.stdout).toContain("HIJACK-BIN-SH");
  });

  /**
   * Arguments reach the CLI exactly as the previous `#!/usr/bin/env node` bin
   * passed them: spaces, quotes, %, cmd.exe operators outside quotes, /?,
   * best-fit quote look-alikes, full-width operators and non-ASCII text.
   */
  const EXACT_ARGUMENT_SETS: ReadonlyArray<readonly string[]> = [
    ["plain", "a b", "50%", "%PATH%", "%a", "(x)", "!x!", "", "tab\tx", "trail\\", "x & echo INJECTED", "--flag=va lue", "Çağrı ğüşöıİ", "日本語"],
    ['a"b'],
    ['\\"q', "c:\\dir with space\\"],
    ["a&echo,INJECTED", "a|b", "<y>", "a^b", 'q"&echo,INJECTED&"q', ")&echo,INJECTED&("],
    ["/?", "a/?b", "--root", "x /? y"],
    ["＂&echo,INJECTED&＂", "“&echo,INJECTED&”", "„&echo,INJECTED&„", "ʺ&echo,INJECTED&ʺ", "x\u030E&echo,INJECTED&x\u030E", "″&echo,INJECTED&″"],
    ["＆＜＞｜＾", "ＡＢ＆ｃｄ"],
  ];
  it.each(EXACT_ARGUMENT_SETS.map((set) => [JSON.stringify(set), set] as const))("passes %s through unchanged", (_label, args) => {
    const control = runProbe(plantedProject(null), "shebang", args, { registryEnv: true });
    expect(control.probe?.argv).toEqual(args);
    const run = runProbe(plantedProject(null), "launcher", args, { registryEnv: true });
    expectServerRan(run, args);
    expect(`${run.stdout}${run.stderr}`).not.toMatch(/^INJECTED/m);
  });

  /**
   * A FOR body expands references to its variable. The launcher's two
   * captures use different variables, so any reference stays literal in one
   * of them: such arguments are refused, never run, and an argument that
   * only looks like one (`%a`) passes unchanged (above).
   */
  const FOR_REFERENCE_SETS: ReadonlyArray<readonly string[]> = [
    ["mcp", "%~$X&echo,INJECTED&:#"],
    ["mcp", "%~$X&echo,INJECTED&:]"],
    ["mcp", "%~$X&echo,INJECTED&:a"],
    ["%#"],
    ["%]"],
    ["%~fa"],
    ["%~dpa"],
  ];
  it.each(FOR_REFERENCE_SETS.map((set) => [JSON.stringify(set), set] as const))(
    "never runs a FOR variable reference in %s: refused on Windows, unchanged on POSIX",
    (_label, args) => {
      const run = runProbe(plantedProject(null), "launcher", args, { registryEnv: true });
      expect(`${run.stdout}${run.stderr}`).not.toMatch(/^INJECTED/m);
      if (IS_WINDOWS) {
        expect(run.probe).toBeNull();
        expect(run.status).toBe(2);
        expect(run.stderr).toMatch(/refusing to start/);
      } else {
        expectServerRan(run, args);
      }
    },
  );

  it.runIf(IS_WINDOWS)("leaves no capture behind; an argument cmd.exe cannot take stops the start before the CLI runs", () => {
    const sandbox = plantedProject(null);
    expectServerRan(runProbe(sandbox, "launcher", ["mcp"], { registryEnv: true }), ["mcp"]);
    expect(leftoverCaptures(sandbox)).toEqual([]);
    const refused = runProbe(sandbox, "launcher", ["%#"], { registryEnv: true });
    expect(refused.status).toBe(2);
    expect(leftoverCaptures(sandbox)).toEqual([]);
    const tooLong = runProbe(sandbox, "launcher", ["x".repeat(8100)], { registryEnv: true });
    expect(tooLong.probe).toBeNull();
    expect(tooLong.status).not.toBe(0);
    expect(leftoverCaptures(sandbox)).toEqual([]);
  });

  /**
   * Review round 5 (B1): whoever can write the capture directory between the
   * batch writing the captures and node reading them chooses the CLI's
   * arguments. %TEMP% can be shared (inherited Modify for other accounts or
   * groups), so the captures live under %LOCALAPPDATA%\causoryn\argv: a
   * principal that can write there can already change the launcher in npm's
   * cache under %LOCALAPPDATA%. The launcher refuses to start without an
   * absolute LOCALAPPDATA.
   */
  it.runIf(IS_WINDOWS)("B1: hands node a capture directory under %LOCALAPPDATA%\\causoryn\\argv, never under %TEMP%", () => {
    const sandbox = plantedProject(null);
    const pkg = probePackage(sandbox.root, "launcher");
    writeFileSync(
      path.join(pkg, "scripts", "lib", "windows-argv.mjs"),
      'if (process.argv[2] === "--launch") console.log("CAPTURE-DIR " + process.argv[3]);\n',
    );
    const run = runLauncherDirectly(sandbox, pkg, "mcp", probeEnvironment(sandbox, true));
    const line = run.stdout.split(/\r?\n/).find((entry) => entry.startsWith("CAPTURE-DIR "));
    expect(line, `${run.stdout}\n${run.stderr}`).toBeDefined();
    const dir = (line as string).slice("CAPTURE-DIR ".length);
    expect(path.dirname(dir).toLowerCase()).toBe(captureRoot(sandbox).toLowerCase());
    expect(readdirSync(path.join(sandbox.root, "tmp"))).toEqual([]);
  });

  it.runIf(IS_WINDOWS)("B1: refuses to start without an absolute LOCALAPPDATA", () => {
    for (const value of [undefined, "relative\\appdata"]) {
      const sandbox = plantedProject(null);
      const pkg = probePackage(sandbox.root, "launcher");
      const env = probeEnvironment(sandbox, true);
      for (const key of Object.keys(env)) if (/^LOCALAPPDATA$/i.test(key)) delete env[key];
      if (value !== undefined) env["LOCALAPPDATA"] = value;
      const run = runLauncherDirectly(sandbox, pkg, "mcp", env);
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(2);
      expect(run.stdout).not.toContain("CAUSORYN-PROBE");
      expect(run.stderr).toMatch(/refusing to start: LOCALAPPDATA/);
      expect(readdirSync(path.join(sandbox.root, "tmp"))).toEqual([]);
      expect(existsSync(path.join(sandbox.project, "relative"))).toBe(false);
    }
  });

  /** Review round 5 (B5): a start that never reached node (or a crashed node) leaves its capture directory; later starts remove it. */
  it.runIf(IS_WINDOWS)("B5: a start removes capture directories an earlier start left behind, and only those", () => {
    const sandbox = plantedProject(null);
    const root = captureRoot(sandbox);
    const old = new Date(Date.now() - 3_600_000);
    const stale = path.join(root, "c-12345-1");
    const foreign = path.join(root, "c-12345-2");
    mkdirSync(stale, { recursive: true });
    mkdirSync(foreign);
    for (const file of ["argv-hash.txt", "argv-bracket.txt", "cp.txt"]) writeFileSync(path.join(stale, file), "x");
    writeFileSync(path.join(foreign, "not-a-capture.txt"), "x");
    for (const dir of [stale, foreign]) utimesSync(dir, old, old);
    expectServerRan(runProbe(sandbox, "launcher", ["mcp"], { registryEnv: true }), ["mcp"]);
    expect(leftoverCaptures(sandbox)).toEqual(["c-12345-2"]);
  });
});

describe.skipIf(NPM_CLI === undefined || !IS_WINDOWS)("F20 round 6: the launcher's console lock", () => {
  // (3) A file named `lock` never went stale: every start waited 15 s and refused.
  it("a file named lock refuses the start at once, naming it", () => {
    const sandbox = plantedProject(null);
    mkdirSync(captureRoot(sandbox), { recursive: true });
    writeFileSync(path.join(captureRoot(sandbox), "lock"), "");
    const started = Date.now();
    const run = runProbe(sandbox, "launcher", ["mcp"], { registryEnv: true });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(run.probe).toBeNull();
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/lock is not a directory/);
    expect(run.stderr).toContain(path.join(captureRoot(sandbox), "lock"));
    expect(leftoverCaptures(sandbox)).toEqual(["lock"]);
  }, 60_000);

  // (5) The launcher removed `lock` after its window whoever held it; it now releases only a lock with its own token.
  it("releases only its own lock, never another start's", () => {
    const sandbox = plantedProject(null);
    const pkg = probePackage(sandbox.root, "launcher");
    // A --lock that reports success without taking the lock: the lock below belongs to another start.
    writeFileSync(path.join(pkg, "scripts", "lib", "windows-argv.mjs"), 'if (process.argv[2] === "--launch") console.log("LAUNCHED");\n');
    const lock = path.join(captureRoot(sandbox), "lock");
    mkdirSync(lock, { recursive: true });
    const run = runLauncherDirectly(sandbox, pkg, "mcp", probeEnvironment(sandbox, true));
    expect(run.stdout, run.stderr).toContain("LAUNCHED");
    expect(existsSync(lock)).toBe(true);
  });

  it("takes the lock with its own token and leaves nothing behind", () => {
    const sandbox = plantedProject(null);
    const pkg = probePackage(sandbox.root, "launcher");
    const real = readFileSync(path.join(pkg, "scripts", "lib", "windows-argv.mjs"), "utf8");
    // The real module, which also reports what the lock holds when the launch starts (the lock is released by then).
    writeFileSync(
      path.join(pkg, "scripts", "lib", "windows-argv.mjs"),
      `${real}\nif (process.argv[2] === "--lock") { const fs = await import("node:fs"); console.error("LOCK-HOLDS " + JSON.stringify(fs.readdirSync(process.argv[3] + "/lock"))); }\n`,
    );
    const run = runLauncherDirectly(sandbox, pkg, "mcp", probeEnvironment(sandbox, true));
    expect(run.stdout, run.stderr).toContain("CAUSORYN-PROBE");
    expect(run.stderr).toMatch(/LOCK-HOLDS \["owner-c-\d+-\d+"\]/);
    expect(leftoverCaptures(sandbox)).toEqual([]);
  });
});

/** Runs a probe package's launcher through cmd.exe as npm would, with npm's node, without npm. */
function runLauncherDirectly(
  sandbox: Sandbox & { readonly root: string },
  pkg: string,
  args: string,
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/s", "/c", `""${path.join(pkg, "scripts", "causoryn.cmd")}" ${args}"`], {
    cwd: sandbox.project,
    env: { ...env, npm_node_execpath: process.execPath },
    encoding: "utf8",
    windowsVerbatimArguments: true,
  });
}

/* ------------------------------------------------------------------ */
/* F20 round 4: Windows console code pages                             */
/* ------------------------------------------------------------------ */

const CHCP = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "chcp.com");
const POWERSHELL = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/**
 * Runs `npm exec … causoryn <args>` (as runProbe) in a new, hidden console
 * whose code page is first set to `codePage` (PowerShell Start-Process opens
 * the console; the console of the test runner is never changed). Reports the
 * console's code page before and after the run. With `parallel` > 1 the
 * starts run at the same time in that one console (after one warm-up start,
 * so npm's cache is not filled concurrently).
 */
function runProbeInConsole(
  codePage: number,
  args: readonly string[],
  parallel = 1,
  prepare?: (sandbox: Sandbox & { readonly root: string }) => void,
): ProbeRun & { readonly before: number | null; readonly after: number | null; readonly runs: readonly ProbeRun[] } {
  const sandbox = plantedProject(null);
  prepare?.(sandbox);
  const pkg = probePackage(sandbox.root, "launcher");
  const driver = path.join(sandbox.root, "console-driver.cjs");
  const job = path.join(sandbox.root, "console-job.json");
  const out = path.join(sandbox.root, "console-out.json");
  writeFileSync(
    driver,
    [
      'const { spawn, spawnSync } = require("node:child_process");',
      'const fs = require("node:fs");',
      'const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));',
      'const cp = () => { const r = spawnSync(job.chcp, [], { encoding: "latin1" }); const m = /(\\d+)\\D*$/.exec(String(r.stdout).trim()); return m ? Number(m[1]) : null; };',
      "const runOne = (argv) => new Promise((resolve) => {",
      "  const child = spawn(process.execPath, argv, { cwd: job.cwd, env: job.env });",
      '  let stdout = ""; let stderr = "";',
      '  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");',
      '  child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });',
      '  child.on("close", (status) => resolve({ status, stdout, stderr }));',
      "  child.stdin.end();",
      "});",
      "(async () => {",
      '  spawnSync(job.chcp, [String(job.codePage)], { stdio: ["ignore", "ignore", "ignore"] });',
      "  const before = cp();",
      "  if (job.parallel > 1) await runOne(job.warmup);",
      "  const runs = await Promise.all(Array.from({ length: job.parallel }, () => runOne(job.argv)));",
      "  const after = cp();",
      "  fs.writeFileSync(job.out, JSON.stringify({ before, after, runs }));",
      "})();",
      "",
    ].join("\n"),
  );
  writeFileSync(
    job,
    JSON.stringify({
      chcp: CHCP,
      codePage,
      parallel,
      argv: probeNpmArguments(pkg, args),
      warmup: probeNpmArguments(pkg, ["warm-up"]),
      cwd: sandbox.project,
      env: probeEnvironment(sandbox, true),
      out,
    }),
  );
  const quote = (text: string): string => `'"${text.replace(/'/g, "''")}"'`;
  const started = spawnSync(
    POWERSHELL,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${quote(driver)},${quote(job)} -WindowStyle Hidden -Wait`,
    ],
    { encoding: "utf8", timeout: 180_000 },
  );
  expect(existsSync(out), `${started.stdout}\n${started.stderr}`).toBe(true);
  const result = JSON.parse(readFileSync(out, "utf8")) as {
    before: number | null;
    after: number | null;
    runs: Array<{ status: number | null; stdout: string; stderr: string }>;
  };
  const runs = result.runs.map((run) => probeRun(run));
  return { ...(runs[0] as ProbeRun), before: result.before, after: result.after, runs };
}

/** Characters whose cp932 (Shift-JIS) trail byte is 0x5E (`^`) or 0x7C (`|`). */
function shiftJisTrailCharacters(): string {
  const decoder = new TextDecoder("shift_jis");
  let out = "";
  for (const lead of [0x81, 0x82, 0x83, 0x88, 0x89, 0x8a]) {
    for (const trail of [0x5e, 0x7c]) {
      const text = decoder.decode(Uint8Array.of(lead, trail));
      if (text.length === 1 && text !== "\uFFFD") out += text;
    }
  }
  return out;
}

/**
 * cmd.exe writes internal command output in the console code page, with
 * best-fit: in 437, 850, 857 and 1252, U+FF02 ＂, U+201C “, U+201D ”,
 * U+201E „, U+02BA ʺ, U+030E and (857) U+2033 ″ become `"`, and in 932 a
 * trail byte can be 0x5E or 0x7C. The launcher captures in UTF-8 (chcp
 * 65001) and restores the console's code page.
 */
describe.skipIf(NPM_CLI === undefined || !IS_WINDOWS)(
  "F20 round 4: the capture is exact in every console code page",
  () => {
    const BEST_FIT = ["＂&echo,INJECTED&＂", "“&echo,INJECTED&”", "„&echo,INJECTED&„", "ʺ&echo,INJECTED&ʺ", "x\u030E&echo,INJECTED&x\u030E", "″&echo,INJECTED&″"];
    it.each([
      [857, BEST_FIT],
      [437, BEST_FIT],
      [1252, BEST_FIT],
      [932, [shiftJisTrailCharacters(), "＆＜＞｜＾", "a b"]],
    ] as const)("code page %i: arguments pass unchanged and the code page is restored", (codePage, args) => {
      const run = runProbeInConsole(codePage, args);
      expect(run.before).toBe(codePage);
      expect(`${run.stdout}${run.stderr}`).not.toMatch(/^INJECTED/m);
      expectServerRan(run, args);
      expect(run.after).toBe(codePage);
    });

    it("code page 857: a refused start restores the code page too", () => {
      const run = runProbeInConsole(857, ["%~$X&echo,INJECTED&:#"]);
      expect(run.before).toBe(857);
      expect(`${run.stdout}${run.stderr}`).not.toMatch(/^INJECTED/m);
      expect(run.probe).toBeNull();
      expect(run.status).toBe(2);
      expect(run.after).toBe(857);
    });

    /**
     * Review round 5 (B2): starts that share a console race on its code page
     * (one restores 857 while another captures), which gave refusals and,
     * worse, exit 0 with `["mcp","???","x","--root","C:\\proj\\?_?"]`. The
     * launcher now serializes its code page window with a lock under
     * %LOCALAPPDATA%\causoryn\argv and checks the code page after capturing.
     */
    it("B2: eight starts at once in one console all get their exact arguments", () => {
      const args = ["mcp", "日本語", "＂x＂", "--root", "C:\\proj\\データ"];
      const result = runProbeInConsole(857, args, 8);
      expect(result.before).toBe(857);
      expect(result.runs).toHaveLength(8);
      for (const run of result.runs) {
        expect(`${run.stdout}${run.stderr}`).not.toMatch(/^INJECTED/m);
        expectServerRan(run, args);
      }
      expect(result.after).toBe(857);
    }, 120_000);

    /**
     * Review round 6 (2): a start killed inside its 65001 window left the
     * console at 65001 for good (the next start read 65001 and kept it). The
     * lock records the console's code page (`lock\cp-<n>`), and the start that
     * breaks a stale lock while the console is at 65001 restores it. The
     * killed start is simulated by its stale lock.
     */
    it("round 6 (2): breaking the lock of a start killed at 65001 restores the code page it recorded", () => {
      const args = ["mcp", "日本語", "＂x＂"];
      const result = runProbeInConsole(65001, args, 1, (sandbox) => {
        const lock = path.join(captureRoot(sandbox), "lock");
        mkdirSync(lock, { recursive: true });
        writeFileSync(path.join(lock, "owner-c-1-1"), "");
        writeFileSync(path.join(lock, "cp-857"), "");
        const old = new Date(Date.now() - 3_600_000);
        utimesSync(lock, old, old);
      });
      expect(result.before).toBe(65001);
      expectServerRan(result, args);
      expect(result.after).toBe(857);
    }, 150_000);
  },
);

/* ------------------------------------------------------------------ */
/* F20 round 4: without npm (a global install)                         */
/* ------------------------------------------------------------------ */

/** Git for Windows' bash.exe, found next to the git.exe on PATH (not WSL's System32\bash.exe). */
const GIT_BASH = IS_WINDOWS
  ? (process.env["PATH"] ?? "")
      .split(path.delimiter)
      .filter((dir) => dir !== "" && existsSync(path.join(dir, "git.exe")))
      .map((dir) => path.join(dir, "..", "bin", "bash.exe"))
      .find((file) => existsSync(file))
  : undefined;

/**
 * A global install runs the launcher without npm: it finds node.exe on PATH
 * only (`%~$PATH:`), never in the current directory, whichever shim starts
 * it (causoryn.cmd from cmd.exe, causoryn.ps1 from PowerShell, causoryn from
 * Git Bash). The directory it runs in plants node.cmd, node.bat and a
 * node.exe (a copy of cmd.exe, which would print its banner).
 */
describe.skipIf(NPM_CLI === undefined || !IS_WINDOWS)("F20 round 4: a global install finds node on PATH only", () => {
  function globalInstall(): { prefix: string; cwd: string; env: NodeJS.ProcessEnv } {
    const sandbox = plantedProject(null);
    const pkg = probePackage(sandbox.root, "launcher");
    const prefix = path.join(sandbox.root, "global");
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (/^npm_/i.test(key) || /^NoDefaultCurrentDirectoryInExePath$/i.test(key)) continue;
      env[key] = value;
    }
    Object.assign(env, { HOME: sandbox.home, USERPROFILE: sandbox.home, npm_config_cache: sandbox.cache, npm_config_update_notifier: "false" });
    const install = spawnSync(process.execPath, [NPM_CLI as string, "install", "-g", "--offline", "--ignore-scripts", "--install-links", "--prefix", prefix, pkg], {
      cwd: sandbox.project,
      env,
      encoding: "utf8",
    });
    expect(install.status, install.stderr).toBe(0);
    const cwd = sandbox.project;
    writeFileSync(path.join(cwd, "node.cmd"), "@echo HIJACK-CWD-NODE\r\n@exit /b 7\r\n");
    writeFileSync(path.join(cwd, "node.bat"), "@echo HIJACK-CWD-NODE\r\n@exit /b 7\r\n");
    copyFileSync(process.env["ComSpec"] ?? "C:\\Windows\\System32\\cmd.exe", path.join(cwd, "node.exe"));
    return { prefix, cwd, env };
  }

  function expectProbe(stdout: string, stderr: string, args: readonly string[]): void {
    // The planted node.exe is a copy of cmd.exe: its banner ends with the copyright line.
    expect(stdout, stderr).not.toMatch(/HIJACK-|\(c\) Microsoft Corporation/);
    const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("CAUSORYN-PROBE "));
    expect(line, `${stdout}\n${stderr}`).toBeDefined();
    const probe = JSON.parse((line as string).slice("CAUSORYN-PROBE ".length)) as { argv: string[]; execPath: string };
    expect(probe.argv).toEqual(args);
    // node.exe from PATH (the one running these tests), not the directory's node.exe.
    expect(probe.execPath.toLowerCase()).toBe(process.execPath.toLowerCase());
  }

  it("from cmd.exe (causoryn.cmd)", () => {
    const { prefix, cwd, env } = globalInstall();
    const run = spawnSync(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/s", "/c", `""${path.join(prefix, "causoryn.cmd")}" mcp "a b""`], {
      cwd,
      env,
      encoding: "utf8",
      windowsVerbatimArguments: true,
    });
    expectProbe(run.stdout, run.stderr, ["mcp", "a b"]);
  });

  /**
   * Review round 5 (B4): `%~$PATH:` searches the current directory for an
   * empty or `.` PATH entry, so a directory's node.exe was picked before the
   * real one. The launcher refuses a node.exe found in the current directory.
   * Review round 6 (4): and below it, through any relative PATH entry
   * (`sub`, `.\sub`, `node_modules\.bin;sub`), by a prefix check.
   */
  it.each([
    ["an empty", ""],
    ["a .", "."],
    ["a relative sub", "sub"],
    ["a relative .\\sub", ".\\sub"],
    ["a node_modules\\.bin;sub", "node_modules\\.bin;sub"],
  ])("B4: refuses the current directory's node.exe found through %s PATH entry", (_label, entry) => {
    const { prefix, cwd, env } = globalInstall();
    mkdirSync(path.join(cwd, "sub"));
    copyFileSync(process.env["ComSpec"] ?? "C:\\Windows\\System32\\cmd.exe", path.join(cwd, "sub", "node.exe"));
    const pathKey = Object.keys(env).find((key) => /^path$/i.test(key)) ?? "PATH";
    env[pathKey] = `${entry};${path.dirname(process.execPath)};${env[pathKey] ?? ""}`;
    const run = spawnSync(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/s", "/c", `""${path.join(prefix, "causoryn.cmd")}" mcp"`], {
      cwd,
      env,
      encoding: "utf8",
      windowsVerbatimArguments: true,
    });
    expect(run.stdout, run.stderr).not.toMatch(/HIJACK-|\(c\) Microsoft Corporation|CAUSORYN-PROBE/);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/refusing to start: the node\.exe found on PATH is in the current directory or below it/);
  });

  // The prefix check compares whole directory names: <dir>\project2 is not below <dir>\project.
  it("B4: a node.exe in a sibling directory whose name starts like the current one is not refused", () => {
    const { prefix, cwd, env } = globalInstall();
    const sibling = `${cwd}2`;
    mkdirSync(sibling);
    // A marker node.exe (a copy of cmd.exe, which prints its banner): the entry points outside the project.
    copyFileSync(process.env["ComSpec"] ?? "C:\\Windows\\System32\\cmd.exe", path.join(sibling, "node.exe"));
    const pathKey = Object.keys(env).find((key) => /^path$/i.test(key)) ?? "PATH";
    env[pathKey] = `..\\${path.basename(sibling)};${path.dirname(process.execPath)};${env[pathKey] ?? ""}`;
    const run = spawnSync(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/s", "/c", `""${path.join(prefix, "causoryn.cmd")}" mcp"`], {
      cwd,
      env,
      encoding: "utf8",
      windowsVerbatimArguments: true,
    });
    expect(run.stderr).not.toMatch(/refusing to start/);
    expect(run.stdout).toMatch(/\(c\) Microsoft Corporation/);
  });

  it("from PowerShell (causoryn.ps1)", () => {
    const { prefix, cwd, env } = globalInstall();
    const run = spawnSync(
      POWERSHELL,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `& '${path.join(prefix, "causoryn.ps1")}' mcp 'a b'`],
      { cwd, env, encoding: "utf8" },
    );
    expectProbe(run.stdout, run.stderr, ["mcp", "a b"]);
  });

  it.runIf(GIT_BASH !== undefined)("from Git Bash (causoryn)", () => {
    const { prefix, cwd, env } = globalInstall();
    const run = spawnSync(GIT_BASH as string, ["-c", '"$0" mcp "a b"', path.join(prefix, "causoryn").split("\\").join("/")], { cwd, env, encoding: "utf8" });
    expectProbe(run.stdout, run.stderr, ["mcp", "a b"]);
  });

  /** Documented residual (BatBadBut), as for PowerShell below: Git Bash (MSYS) starts the sh shim's .cmd through cmd.exe too. */
  it.runIf(GIT_BASH !== undefined)("documented residual: Git Bash lets cmd.exe split an argument with an operator before the launcher runs", () => {
    const { prefix, cwd, env } = globalInstall();
    const run = spawnSync(GIT_BASH as string, ["-c", '"$0" mcp "x&echo,INJECTED-SH"', path.join(prefix, "causoryn").split("\\").join("/")], {
      cwd,
      env,
      encoding: "utf8",
    });
    expectProbe(run.stdout, run.stderr, ["mcp", "x"]);
    expect(run.stdout).toMatch(/^INJECTED-SH\r?$/m);
  });

  /**
   * Documented residual (BatBadBut): cmd-shim's .ps1 shim (and its sh shim
   * under Git Bash) starts the launcher, a .cmd file, so Windows runs it
   * through `cmd.exe /c`, and PowerShell quotes an argument only when it has
   * spaces. Measured with Windows PowerShell 5.1 and Git Bash: in an argument
   * without spaces cmd.exe acts on `& | < > ^`, expands `%NAME%`, and treats
   * full-width ＂ as text, before the launcher runs; `causoryn mcp
   * 'x&echo,INJECTED-PS'` runs the echo. The previous bin's shims started
   * node.exe directly. Nothing in the launcher can see or undo what cmd.exe
   * did before it starts; npx and `causoryn setup` do not go this way.
   */
  it("documented residual: PowerShell lets cmd.exe split an argument with an operator before the launcher runs", () => {
    const { prefix, cwd, env } = globalInstall();
    const run = spawnSync(
      POWERSHELL,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `& '${path.join(prefix, "causoryn.ps1")}' mcp 'x&echo,INJECTED-PS'`],
      { cwd, env, encoding: "utf8" },
    );
    expectProbe(run.stdout, run.stderr, ["mcp", "x"]);
    expect(run.stdout).toMatch(/^INJECTED-PS\r?$/m);
  });
});

interface AjvInstance {
  compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown };
}
type AjvConstructor = new (options: object) => AjvInstance;
