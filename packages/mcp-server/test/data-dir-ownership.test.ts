import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Data directory and database ownership (F41 / F48), for a data root that may
 * sit in a location other local users can write (a manual --data-dir,
 * ZCODE_PLUGIN_DATA or storage.dataDbPath):
 * - F41: prepareWorkspaceDataDir refuses a base, `workspaces`, workspace or
 *   `exports` directory that is a link or (POSIX) owned by another uid; it
 *   refuses a pre-existing (user-supplied) base that group or others can
 *   write; every directory it creates itself, and Causoryn's own `workspaces`,
 *   workspace and `exports` directories, are made owner-only (0700) explicitly,
 *   whatever the umask or a default ACL gave mkdir; a chmod that fails or does
 *   not take effect stops startup (fail closed).
 * - F48: validateDataDbPath refuses a database or -wal/-shm/-journal side file
 *   that is a symbolic link (lstat), and (POSIX) a database file or parent
 *   directory owned by another uid or writable by group or others.
 * The POSIX owner view is emulated (an injected uid and per-path owner and
 * mode on lstat/stat/chmod), so these run on Windows too; the real-permission
 * variants run on POSIX only.
 */

const SERVER_UID = 4242;
const OTHER_UID = 5151;

const hooks = vi.hoisted(() => ({
  posix: false,
  owners: new Map<string, number>(),
  perms: new Map<string, number>(),
  chmodFails: new Set<string>(),
  chmodIgnored: new Set<string>(),
  chmodCalls: [] as Array<{ readonly path: string; readonly mode: number }>,
  /**
   * Permission bits mkdir gives a new directory whatever mode was asked for
   * (a umask of 002 applied to the default 0777, or a default ACL); undefined:
   * the requested mode.
   */
  mkdirPerm: undefined as number | undefined,
  /** Runs right after a successful mkdir (e.g. to swap the new entry before the chmod). */
  afterMkdir: undefined as ((target: string) => void) | undefined,
  /** Runs after each lstat, once its result is taken (e.g. to swap an entry after its identity was recorded). */
  afterLstat: undefined as ((target: string) => void) | undefined,
}));

function key(target: string): string {
  // Not node:path at hoist time; the same normalisation is applied everywhere.
  const resolved = target.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const ownerKey = (target: unknown): string => {
    const value = String(target).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? value.toLowerCase() : value;
  };
  const view = <T>(target: unknown, real: T): T => {
    if (!hooks.posix || real === undefined || real === null) return real;
    const stat = real as unknown as { mode: number | bigint; isDirectory(): boolean };
    if (typeof stat.mode !== "number") return real;
    const pathKey = ownerKey(target);
    const perm = hooks.perms.get(pathKey) ?? (stat.isDirectory() ? 0o700 : 0o600);
    const copy = Object.assign(Object.create(Object.getPrototypeOf(real) as object) as object, real) as unknown as {
      uid: number;
      mode: number;
    };
    copy.uid = hooks.owners.get(pathKey) ?? SERVER_UID;
    copy.mode = (stat.mode & 0o170000) | perm;
    return copy as unknown as T;
  };
  const lstatSync = ((target: unknown, options?: unknown) => {
    const result = view(target, (actual.lstatSync as (p: unknown, o?: unknown) => unknown)(target, options));
    if (hooks.posix) hooks.afterLstat?.(String(target));
    return result;
  }) as typeof actual.lstatSync;
  const statSync = ((target: unknown, options?: unknown) =>
    view(target, (actual.statSync as (p: unknown, o?: unknown) => unknown)(target, options))) as typeof actual.statSync;
  const chmodSync = ((target: unknown, mode: unknown) => {
    if (!hooks.posix) {
      actual.chmodSync(target as string, mode as number);
      return;
    }
    const pathKey = ownerKey(target);
    hooks.chmodCalls.push({ path: pathKey, mode: Number(mode) });
    if (hooks.chmodFails.has(pathKey)) {
      throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${String(target)}'`), { code: "EPERM" });
    }
    if (!hooks.chmodIgnored.has(pathKey)) hooks.perms.set(pathKey, Number(mode) & 0o7777);
  }) as typeof actual.chmodSync;
  const mkdirSync = ((target: unknown, options?: unknown) => {
    const forced = hooks.posix ? hooks.mkdirPerm : undefined;
    // Every component this call creates gets the forced permission bits.
    const missing: string[] = [];
    if (forced !== undefined) {
      let cursor = String(target).replace(/[\\/]+$/, "");
      for (;;) {
        if (actual.existsSync(cursor)) break;
        missing.push(cursor);
        const parent = cursor.replace(/[\\/][^\\/]*$/, "");
        if (parent === cursor || parent.length === 0) break;
        cursor = parent;
      }
    }
    const result = (actual.mkdirSync as (p: unknown, o?: unknown) => unknown)(target, options);
    for (const created of missing) hooks.perms.set(ownerKey(created), forced as number);
    if (hooks.posix) hooks.afterMkdir?.(String(target));
    return result;
  }) as typeof actual.mkdirSync;
  return { ...actual, lstatSync, statSync, chmodSync, mkdirSync };
});

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CausorynConfigError, buildWorkspaceAutoConfig, createCausorynContext } from "../src/index.js";

const IS_WIN = process.platform === "win32";
/** A directory link that needs no privilege (a junction on Windows). */
const DIR_LINK_TYPE = IS_WIN ? "junction" : "dir";

const CAN_FILE_LINK: boolean = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), "causoryn-owner-probe-"));
  try {
    writeFileSync(path.join(probe, "t.txt"), "probe");
    symlinkSync(path.join(probe, "t.txt"), path.join(probe, "l.txt"), "file");
    return readFileSync(path.join(probe, "l.txt"), "utf8") === "probe";
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})();

const originalGetuid = process.getuid;
const sandboxes: string[] = [];

function emulatePosix(): void {
  hooks.posix = true;
  process.getuid = () => SERVER_UID;
}

beforeEach(() => {
  hooks.posix = false;
  hooks.owners.clear();
  hooks.perms.clear();
  hooks.chmodFails.clear();
  hooks.chmodIgnored.clear();
  hooks.chmodCalls.length = 0;
  hooks.mkdirPerm = undefined;
  hooks.afterMkdir = undefined;
  hooks.afterLstat = undefined;
});

afterEach(() => {
  hooks.posix = false;
  if (originalGetuid === undefined) {
    delete (process as { getuid?: () => number }).getuid;
  } else {
    process.getuid = originalGetuid;
  }
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly project: string;
  readonly base: string;
  readonly outside: string;
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "causoryn-owner-"));
  sandboxes.push(root);
  const home = path.join(root, "home");
  const project = path.join(home, "projects", "owned-app");
  const outside = path.join(root, "outside");
  mkdirSync(path.join(project, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(project, "src", "app.ts"), "export const a = 1;\n");
  return { root, home, project, base: path.join(root, "shared-data"), outside };
}

function buildConfig(sandbox: Sandbox, logs: string[] = []): ReturnType<typeof buildWorkspaceAutoConfig> {
  return buildWorkspaceAutoConfig({
    roots: [sandbox.project],
    autoDataDir: true,
    dataDir: sandbox.base,
    homeDir: sandbox.home,
    env: {},
    logger: (message) => logs.push(message),
  });
}

function configError(run: () => unknown): CausorynConfigError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CausorynConfigError);
  return thrown as CausorynConfigError;
}

/** The workspace data directory buildWorkspaceAutoConfig derives (created by a first, clean run). */
function workspaceDirs(sandbox: Sandbox): { readonly workspaces: string; readonly workspace: string; readonly exports: string } {
  const config = buildConfig(sandbox);
  const workspace = path.dirname(config.storage.dataDbPath as string);
  return { workspaces: path.dirname(workspace), workspace, exports: path.join(workspace, "exports") };
}

function openContext(rawConfig: unknown): void {
  const context = createCausorynContext(rawConfig, { logger: () => {} });
  context.close();
}

describe("prepareWorkspaceDataDir — ownership and permissions (F41, emulated POSIX owners)", () => {
  it("accepts and keeps private a fresh data directory (regression guard)", () => {
    emulatePosix();
    const sandbox = makeSandbox();
    const dirs = workspaceDirs(sandbox);
    expect(existsSync(dirs.exports)).toBe(true);
  });

  it("refuses a workspace data directory owned by another uid", () => {
    emulatePosix();
    const sandbox = makeSandbox();
    const dirs = workspaceDirs(sandbox);
    hooks.owners.set(key(dirs.workspace), OTHER_UID);
    const error = configError(() => buildConfig(sandbox));
    expect(error.message).toMatch(new RegExp(`owned by uid ${String(OTHER_UID)}`));
  });

  it("refuses a base data directory owned by another uid before creating anything in it", () => {
    emulatePosix();
    const sandbox = makeSandbox();
    mkdirSync(sandbox.base, { recursive: true });
    hooks.owners.set(key(sandbox.base), OTHER_UID);
    const error = configError(() => buildConfig(sandbox));
    expect(error.message).toMatch(/owned by uid/);
    expect(existsSync(path.join(sandbox.base, "workspaces"))).toBe(false);
  });

  it("refuses a `workspaces` or `exports` directory owned by another uid", () => {
    emulatePosix();
    for (const which of ["workspaces", "exports"] as const) {
      const sandbox = makeSandbox();
      const dirs = workspaceDirs(sandbox);
      hooks.owners.clear();
      hooks.owners.set(key(dirs[which]), OTHER_UID);
      const error = configError(() => buildConfig(sandbox));
      expect(error.message, which).toMatch(/owned by uid/);
    }
  });

  it("refuses a pre-existing (user-supplied) base directory writable by group or others, and never chmods it", () => {
    emulatePosix();
    for (const perm of [0o777, 0o775, 0o1777]) {
      const sandbox = makeSandbox();
      workspaceDirs(sandbox);
      hooks.perms.clear();
      hooks.chmodCalls.length = 0;
      hooks.perms.set(key(sandbox.base), perm);
      const error = configError(() => buildConfig(sandbox));
      expect(error.message, perm.toString(8)).toMatch(/writable by group or others/);
      expect(error.message, perm.toString(8)).toContain(`chmod go-w ${sandbox.base}`);
      expect(hooks.chmodCalls.some((call) => call.path === key(sandbox.base)), perm.toString(8)).toBe(false);
      expect(hooks.perms.get(key(sandbox.base)), perm.toString(8)).toBe(perm);
    }
  });

  it("makes Causoryn's own `workspaces`, workspace and `exports` directories owner-only", () => {
    emulatePosix();
    const sandbox = makeSandbox();
    const dirs = workspaceDirs(sandbox);
    hooks.perms.set(key(dirs.workspaces), 0o775);
    hooks.perms.set(key(dirs.workspace), 0o755);
    hooks.perms.set(key(dirs.exports), 0o777);
    buildConfig(sandbox);
    expect(hooks.perms.get(key(dirs.workspaces))).toBe(0o700);
    expect(hooks.perms.get(key(dirs.workspace))).toBe(0o700);
    expect(hooks.perms.get(key(dirs.exports))).toBe(0o700);
  });

  it("makes every directory it creates owner-only explicitly, even when mkdir ignores the requested mode (umask 002 or a default ACL)", () => {
    emulatePosix();
    hooks.mkdirPerm = 0o775;
    // --data-dir whose ancestors do not exist yet, and the default ~/.causoryn.
    for (const useDefault of [false, true]) {
      const sandbox = makeSandbox();
      hooks.chmodCalls.length = 0;
      const base = useDefault ? path.join(sandbox.home, ".causoryn") : path.join(sandbox.root, "new", "nested", "data");
      const config = buildWorkspaceAutoConfig({
        roots: [sandbox.project],
        autoDataDir: true,
        ...(useDefault ? {} : { dataDir: base }),
        homeDir: sandbox.home,
        env: {},
        logger: () => {},
      });
      const workspace = path.dirname(config.storage.dataDbPath as string);
      const created = [
        ...(useDefault ? [] : [path.join(sandbox.root, "new"), path.join(sandbox.root, "new", "nested")]),
        base,
        path.dirname(workspace),
        workspace,
        path.join(workspace, "exports"),
      ];
      for (const dir of created) {
        expect(hooks.perms.get(key(dir)), dir).toBe(0o700);
        expect(hooks.chmodCalls.some((call) => call.path === key(dir) && call.mode === 0o700), dir).toBe(true);
      }
    }
  });

  it("refuses a directory it created that was swapped for a link before the chmod, without chmod'ing through the link", () => {
    emulatePosix();
    const sandbox = makeSandbox();
    const victim = path.join(sandbox.outside, "victim-dir");
    mkdirSync(victim);
    hooks.perms.set(key(victim), 0o755);
    const workspaces = path.join(sandbox.base, "workspaces");
    hooks.afterMkdir = (target) => {
      if (key(target) !== key(workspaces)) return;
      hooks.afterMkdir = undefined;
      renameSync(target, `${target}.moved`);
      symlinkSync(victim, target, DIR_LINK_TYPE);
    };
    const error = configError(() => buildConfig(sandbox));
    expect(error.message).toMatch(/symbolic link/);
    expect(hooks.chmodCalls.filter((call) => call.path === key(workspaces) || call.path === key(victim))).toEqual([]);
    expect(hooks.perms.get(key(victim))).toBe(0o755);
  });

  it("refuses a directory it created that another user replaced right after the mkdir, without chmod'ing it", () => {
    emulatePosix();
    const sandbox = makeSandbox();
    const workspaces = path.join(sandbox.base, "workspaces");
    hooks.afterMkdir = (target) => {
      if (key(target) !== key(workspaces)) return;
      hooks.afterMkdir = undefined;
      renameSync(target, `${target}.moved`);
      mkdirSync(target);
      hooks.owners.set(key(target), OTHER_UID);
    };
    const error = configError(() => buildConfig(sandbox));
    expect(error.message).toMatch(/changed after it was created/);
    expect(hooks.chmodCalls.filter((call) => call.path === key(workspaces))).toEqual([]);
  });

  it("refuses a directory it created that was replaced after its identity was recorded, before the chmod", () => {
    emulatePosix();
    const sandbox = makeSandbox();
    const workspaces = path.join(sandbox.base, "workspaces");
    let armed = false;
    hooks.afterMkdir = (target) => {
      if (key(target) === key(workspaces)) armed = true;
    };
    hooks.afterLstat = (target) => {
      // The first lstat after the mkdir records the identity; then the entry is swapped.
      if (!armed || key(target) !== key(workspaces)) return;
      armed = false;
      hooks.afterMkdir = undefined;
      renameSync(target, `${target}.moved`);
      mkdirSync(target);
    };
    const error = configError(() => buildConfig(sandbox));
    expect(error.message).toMatch(/changed after it was created/);
    expect(hooks.chmodCalls.filter((call) => call.path === key(workspaces))).toEqual([]);
  });

  it("fails closed when chmod fails on a Causoryn-owned directory that must be narrowed", () => {
    emulatePosix();
    for (const which of ["workspaces", "workspace", "exports"] as const) {
      const sandbox = makeSandbox();
      const dirs = workspaceDirs(sandbox);
      const target = dirs[which];
      hooks.perms.clear();
      hooks.chmodFails.clear();
      hooks.perms.set(key(target), 0o777);
      hooks.chmodFails.add(key(target));
      const error = configError(() => buildConfig(sandbox));
      expect(error.message, which).toMatch(/permissions could not be restricted/);
    }
  });

  it("fails closed when chmod does not take effect (the directory stays writable by others)", () => {
    emulatePosix();
    const sandbox = makeSandbox();
    const dirs = workspaceDirs(sandbox);
    hooks.perms.set(key(dirs.workspace), 0o777);
    hooks.chmodIgnored.add(key(dirs.workspace));
    const error = configError(() => buildConfig(sandbox));
    expect(error.message).toMatch(/permissions did not change/);
  });

  it.skipIf(IS_WIN || process.getuid?.() === 0)(
    "real POSIX permissions: a world-writable base is refused; a group-readable workspace directory is made owner-only",
    () => {
      const sandbox = makeSandbox();
      const config = buildConfig(sandbox);
      const workspace = path.dirname(config.storage.dataDbPath as string);
      chmodSync(workspace, 0o755);
      buildConfig(sandbox);
      expect(statSync(workspace).mode & 0o077).toBe(0);

      chmodSync(sandbox.base, 0o777);
      try {
        const error = configError(() => buildConfig(sandbox));
        expect(error.message).toMatch(/writable by group or others/);
        expect(statSync(sandbox.base).mode & 0o777).toBe(0o777);
      } finally {
        chmodSync(sandbox.base, 0o700);
      }
    },
  );
});

describe("validateDataDbPath — link and ownership checks of the database files (F48)", () => {
  it.skipIf(!CAN_FILE_LINK)("refuses a graph.sqlite that is a symbolic link to a file outside the roots", () => {
    const sandbox = makeSandbox();
    const dataDir = path.join(sandbox.root, "data");
    mkdirSync(dataDir);
    const target = path.join(sandbox.outside, "readable-by-attacker.sqlite");
    writeFileSync(target, "");
    const link = path.join(dataDir, "graph.sqlite");
    symlinkSync(target, link, "file");
    for (const field of ["storage", "wiki"] as const) {
      const error = configError(() =>
        openContext({ workspaceId: "ws_owner", allowRoots: [sandbox.project], autoIndex: false, [field]: { dataDbPath: link } }),
      );
      expect(error.message, field).toMatch(/symbolic link/);
    }
  });

  it.skipIf(!CAN_FILE_LINK)("refuses a -wal, -shm or -journal side file that is a symbolic link to a file outside the roots", () => {
    const sandbox = makeSandbox();
    for (const suffix of ["-wal", "-shm", "-journal"] as const) {
      const dataDir = path.join(sandbox.root, `data${suffix}`);
      mkdirSync(dataDir);
      const target = path.join(sandbox.outside, `side${suffix}`);
      writeFileSync(target, "");
      const dbPath = path.join(dataDir, "graph.sqlite");
      symlinkSync(target, `${dbPath}${suffix}`, "file");
      const error = configError(() =>
        openContext({ workspaceId: "ws_owner", allowRoots: [sandbox.project], autoIndex: false, storage: { dataDbPath: dbPath } }),
      );
      expect(error.message, suffix).toMatch(/symbolic link/);
    }
  });

  it("refuses (emulated POSIX) an existing database or side file owned by another uid or writable by group or others", () => {
    emulatePosix();
    const sandbox = makeSandbox();
    const cases: Array<{ readonly name: string; readonly owner?: number; readonly perm?: number }> = [
      { name: "graph.sqlite", owner: OTHER_UID },
      { name: "graph.sqlite", perm: 0o666 },
      { name: "graph.sqlite", perm: 0o620 },
      { name: "graph.sqlite-wal", owner: OTHER_UID },
      { name: "graph.sqlite-shm", perm: 0o646 },
    ];
    cases.forEach((testCase, index) => {
      const dataDir = path.join(sandbox.root, `db-${String(index)}`);
      mkdirSync(dataDir);
      const dbPath = path.join(dataDir, "graph.sqlite");
      const file = path.join(dataDir, testCase.name);
      writeFileSync(file, "");
      if (testCase.owner !== undefined) hooks.owners.set(key(file), testCase.owner);
      if (testCase.perm !== undefined) hooks.perms.set(key(file), testCase.perm);
      const error = configError(() =>
        openContext({ workspaceId: "ws_owner", allowRoots: [sandbox.project], autoIndex: false, storage: { dataDbPath: dbPath } }),
      );
      expect(error.message, JSON.stringify(testCase)).toMatch(/owned by uid|writable by group or others/);
    });
  });

  it("refuses (emulated POSIX) a database parent directory owned by another uid or writable by group or others", () => {
    emulatePosix();
    const sandbox = makeSandbox();
    for (const [index, override] of [{ owner: OTHER_UID }, { perm: 0o777 }, { perm: 0o770 }].entries()) {
      const dataDir = path.join(sandbox.root, `parent-${String(index)}`);
      mkdirSync(dataDir);
      if (override.owner !== undefined) hooks.owners.set(key(dataDir), override.owner);
      if (override.perm !== undefined) hooks.perms.set(key(dataDir), override.perm);
      const error = configError(() =>
        openContext({
          workspaceId: "ws_owner",
          allowRoots: [sandbox.project],
          autoIndex: false,
          storage: { dataDbPath: path.join(dataDir, "graph.sqlite") },
        }),
      );
      expect(error.message, JSON.stringify(override)).toMatch(/owned by uid|writable by group or others/);
    }
  });

  it("keeps accepting (emulated POSIX) an owner-only database in an owner-only directory", () => {
    emulatePosix();
    const sandbox = makeSandbox();
    const dataDir = path.join(sandbox.root, "private-data");
    mkdirSync(dataDir);
    openContext({
      workspaceId: "ws_owner",
      allowRoots: [sandbox.project],
      autoIndex: false,
      storage: { dataDbPath: path.join(dataDir, "graph.sqlite") },
    });
    // Second open: the database now exists (owner-only, created by the server).
    openContext({
      workspaceId: "ws_owner",
      allowRoots: [sandbox.project],
      autoIndex: false,
      storage: { dataDbPath: path.join(dataDir, "graph.sqlite") },
    });
  });

  it.skipIf(IS_WIN || process.getuid?.() === 0)("real POSIX permissions: a world-writable graph.sqlite is refused", () => {
    const sandbox = makeSandbox();
    const dataDir = path.join(sandbox.root, "real-data");
    mkdirSync(dataDir, { mode: 0o700 });
    const dbPath = path.join(dataDir, "graph.sqlite");
    const raw = { workspaceId: "ws_owner", allowRoots: [sandbox.project], autoIndex: false, storage: { dataDbPath: dbPath } };
    openContext(raw);
    chmodSync(dbPath, 0o666);
    const error = configError(() => openContext(raw));
    expect(error.message).toMatch(/writable by group or others/);
  });
});
