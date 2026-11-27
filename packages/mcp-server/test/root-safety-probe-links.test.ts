import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Root-safety probe hardening (F18 / F23): the probe that decides whether a
 * candidate directory (and each of its ancestors) is a Causoryn plugin install
 * or the exempt Causoryn monorepo never follows a repository-planted link
 * blindly and never reads a repository file unbounded.
 * - Monorepo markers (AGENTS.md, packages/, adapters/, package.json) grant an
 *   exemption, so a link never counts as one: they are inspected with lstat
 *   only, and package.json is read with the descriptor-bound bounded reader
 *   (no link, regular file, 64 KiB).
 * - Plugin markers (plugin manifests, bundle-manifest.json) reject a root, so a
 *   link to a UNC/device target is refused from lstat/readlink alone (the root
 *   is rejected, fail closed) before anything follows it; a local link keeps
 *   being detected through the bounded reader.
 */

const followCalls = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const record =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      followCalls.paths.push(String(args[0] ?? ""));
      return fn(...args);
    };
  const realpathSync = Object.assign(record(actual.realpathSync as (...args: unknown[]) => string), {
    native: record(actual.realpathSync.native as (...args: unknown[]) => string),
  });
  return {
    ...actual,
    existsSync: record(actual.existsSync),
    statSync: record(actual.statSync),
    readFileSync: record(actual.readFileSync),
    openSync: record(actual.openSync),
    accessSync: record(actual.accessSync),
    realpathSync,
  };
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { inspectProjectRootSafety } from "../src/index.js";

const IS_WIN = process.platform === "win32";
const UNC_TARGET_DIR = "\\\\127.0.0.1\\causoryn-none";

function canCreate(type: "file" | "dir" | "junction"): boolean {
  const probe = mkdtempSync(path.join(tmpdir(), "causoryn-probe-link-"));
  try {
    const target = path.join(probe, "target");
    if (type === "file") writeFileSync(target, "probe");
    else mkdirSync(target);
    symlinkSync(target, path.join(probe, "link"), type);
    return type !== "file" || readFileSync(path.join(probe, "link"), "utf8") === "probe";
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const CAN_FILE_LINK = canCreate("file");
const DIR_LINK_TYPE: "dir" | "junction" = IS_WIN ? "junction" : "dir";
const CAN_DIR_LINK = canCreate(DIR_LINK_TYPE);
/** A directory symlink to a UNC target (Windows; needs the symlink privilege). */
const CAN_UNC_DIR_LINK = IS_WIN && canCreate("dir");

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
beforeEach(() => {
  followCalls.paths.length = 0;
});

interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly outside: string;
  project(name: string): string;
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "causoryn-root-probe-"));
  sandboxes.push(root);
  const home = path.join(root, "home");
  const outside = path.join(root, "outside");
  mkdirSync(home, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return {
    root,
    home,
    outside,
    project: (name) => {
      const dir = path.join(home, "projects", name);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
}

const CAUSORYN_MANIFEST = JSON.stringify({ name: "causoryn", version: "0.2.0" });
const WORKSPACES_PACKAGE = JSON.stringify({ name: "mono", private: true, workspaces: ["packages/*"] });

function comparable(value: string): string {
  const resolved = path.resolve(value);
  return IS_WIN ? resolved.toLowerCase() : resolved;
}

/** Follow-calls (stat, exists, read, open, access, realpath) that reached a link or anything below it. */
function followedThrough(links: readonly string[]): string[] {
  const linkForms = links.map(comparable);
  return followCalls.paths.filter((raw) => {
    if (raw.length === 0) return false;
    const call = comparable(raw);
    return linkForms.some((link) => call === link || call.startsWith(link + path.sep));
  });
}

function inspect(candidate: string, sandbox: Sandbox, scriptPath?: string): ReturnType<typeof inspectProjectRootSafety> {
  return inspectProjectRootSafety(candidate, {
    homeDir: sandbox.home,
    env: {},
    ...(scriptPath === undefined ? {} : { scriptPath }),
  });
}

describe("root-safety probe — monorepo markers (F23)", () => {
  it("an oversized package.json does not grant the monorepo exemption (bounded read)", () => {
    const sandbox = makeSandbox();
    const project = sandbox.project("huge-package-json");
    writeFileSync(path.join(project, "AGENTS.md"), "# agents\n");
    writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({ name: "mono", workspaces: ["packages/*"], padding: "x".repeat(70 * 1024) }),
    );
    writeFileSync(path.join(project, "plugin.json"), CAUSORYN_MANIFEST);
    const result = inspect(project, sandbox);
    expect(result).toEqual({ safe: false, reason: "plugin-install-directory" });
  });

  it.skipIf(!CAN_FILE_LINK || !CAN_DIR_LINK)(
    "links never count as monorepo markers: a linked AGENTS.md / package.json / packages / adapters grant no exemption",
    () => {
      const sandbox = makeSandbox();
      const realAgents = path.join(sandbox.outside, "AGENTS.md");
      const realPackage = path.join(sandbox.outside, "package.json");
      writeFileSync(realAgents, "# agents\n");
      writeFileSync(realPackage, WORKSPACES_PACKAGE);
      mkdirSync(path.join(sandbox.outside, "packages"));
      mkdirSync(path.join(sandbox.outside, "adapters"));

      // AGENTS.md and package.json linked, packages/adapters real: no exemption.
      const linkedFiles = sandbox.project("linked-markers");
      symlinkSync(realAgents, path.join(linkedFiles, "AGENTS.md"), "file");
      symlinkSync(realPackage, path.join(linkedFiles, "package.json"), "file");
      writeFileSync(path.join(linkedFiles, "plugin.json"), CAUSORYN_MANIFEST);
      expect(inspect(linkedFiles, sandbox)).toEqual({ safe: false, reason: "plugin-install-directory" });

      // packages/adapters linked, package.json real: no exemption either.
      const linkedDirs = sandbox.project("linked-dirs");
      symlinkSync(path.join(sandbox.outside, "packages"), path.join(linkedDirs, "packages"), DIR_LINK_TYPE);
      symlinkSync(path.join(sandbox.outside, "adapters"), path.join(linkedDirs, "adapters"), DIR_LINK_TYPE);
      writeFileSync(path.join(linkedDirs, "package.json"), WORKSPACES_PACKAGE);
      writeFileSync(path.join(linkedDirs, "plugin.json"), CAUSORYN_MANIFEST);
      expect(inspect(linkedDirs, sandbox)).toEqual({ safe: false, reason: "plugin-install-directory" });

      // The real markers still grant it (the exemption itself is unchanged).
      const realMono = sandbox.project("real-mono");
      writeFileSync(path.join(realMono, "AGENTS.md"), "# agents\n");
      writeFileSync(path.join(realMono, "package.json"), WORKSPACES_PACKAGE);
      writeFileSync(path.join(realMono, "plugin.json"), CAUSORYN_MANIFEST);
      expect(inspect(realMono, sandbox).safe).toBe(true);
    },
  );

  it.skipIf(!CAN_FILE_LINK || !CAN_DIR_LINK)(
    "a linked monorepo marker is inspected with lstat only: nothing stats, opens, reads or resolves through it",
    () => {
      const sandbox = makeSandbox();
      const project = sandbox.project("no-follow");
      const target = path.join(sandbox.outside, "marker.txt");
      writeFileSync(target, WORKSPACES_PACKAGE);
      mkdirSync(path.join(sandbox.outside, "dir"));
      const links = [
        path.join(project, "AGENTS.md"),
        path.join(project, "package.json"),
        path.join(project, "packages"),
        path.join(project, "adapters"),
      ];
      symlinkSync(target, links[0] as string, "file");
      symlinkSync(target, links[1] as string, "file");
      symlinkSync(path.join(sandbox.outside, "dir"), links[2] as string, DIR_LINK_TYPE);
      symlinkSync(path.join(sandbox.outside, "dir"), links[3] as string, DIR_LINK_TYPE);
      followCalls.paths.length = 0;
      expect(inspect(project, sandbox).safe).toBe(true);
      expect(followedThrough(links)).toEqual([]);
    },
  );
});

describe("root-safety probe — plugin markers keep being detected (no regression)", () => {
  it.skipIf(!CAN_FILE_LINK)("a local link to another plugin's manifest is read and does not reject the root", () => {
    const sandbox = makeSandbox();
    const project = sandbox.project("other-plugin-link");
    const target = path.join(sandbox.outside, "other-plugin.json");
    writeFileSync(target, JSON.stringify({ name: "other-plugin" }));
    mkdirSync(path.join(project, ".claude-plugin"));
    symlinkSync(target, path.join(project, ".claude-plugin", "plugin.json"), "file");
    expect(inspect(project, sandbox).safe).toBe(true);
  });

  it.skipIf(!CAN_FILE_LINK || !CAN_DIR_LINK)("a Causoryn manifest behind a local directory link is still detected", () => {
    const sandbox = makeSandbox();
    const project = sandbox.project("linked-plugin-dir");
    const realPluginDir = path.join(sandbox.outside, "claude-plugin");
    mkdirSync(realPluginDir);
    writeFileSync(path.join(realPluginDir, "plugin.json"), CAUSORYN_MANIFEST);
    symlinkSync(realPluginDir, path.join(project, ".claude-plugin"), DIR_LINK_TYPE);
    expect(inspect(project, sandbox)).toEqual({ safe: false, reason: "plugin-install-directory" });
  });

  it("an oversized Causoryn manifest is skipped and a regular one is detected", () => {
    const sandbox = makeSandbox();
    const huge = sandbox.project("huge-manifest");
    writeFileSync(path.join(huge, "plugin.json"), JSON.stringify({ name: "causoryn", padding: "x".repeat(70 * 1024) }));
    expect(inspect(huge, sandbox).safe).toBe(true);
    const normal = sandbox.project("normal-manifest");
    mkdirSync(path.join(normal, ".codex-plugin"));
    writeFileSync(path.join(normal, ".codex-plugin", "plugin.json"), CAUSORYN_MANIFEST);
    expect(inspect(normal, sandbox)).toEqual({ safe: false, reason: "plugin-install-directory" });
  });
});

describe("root-safety probe — Windows UNC link targets (F18)", () => {
  it.skipIf(!IS_WIN || !CAN_FILE_LINK)(
    "monorepo markers linked to a UNC target are never followed (no SMB contact) and grant nothing",
    () => {
      const sandbox = makeSandbox();
      const project = sandbox.project("unc-monorepo-markers");
      const links = [path.join(project, "AGENTS.md"), path.join(project, "package.json")];
      symlinkSync(`${UNC_TARGET_DIR}\\AGENTS.md`, links[0] as string, "file");
      symlinkSync(`${UNC_TARGET_DIR}\\package.json`, links[1] as string, "file");
      if (CAN_UNC_DIR_LINK) {
        links.push(path.join(project, "packages"), path.join(project, "adapters"));
        symlinkSync(`${UNC_TARGET_DIR}\\packages`, links[2] as string, "dir");
        symlinkSync(`${UNC_TARGET_DIR}\\adapters`, links[3] as string, "dir");
      }
      followCalls.paths.length = 0;
      expect(inspect(project, sandbox).safe).toBe(true);
      expect(followedThrough(links)).toEqual([]);
    },
  );

  it.skipIf(!IS_WIN || !CAN_FILE_LINK)(
    "a plugin manifest or bundle manifest linked to a UNC target rejects the root before the link is followed",
    () => {
      const sandbox = makeSandbox();
      const cases: Array<{ readonly name: string; readonly link: (project: string) => string }> = [
        {
          name: "unc-root-plugin-json",
          link: (project) => {
            const link = path.join(project, "plugin.json");
            symlinkSync(`${UNC_TARGET_DIR}\\plugin.json`, link, "file");
            return link;
          },
        },
        {
          name: "unc-claude-plugin-json",
          link: (project) => {
            mkdirSync(path.join(project, ".claude-plugin"));
            const link = path.join(project, ".claude-plugin", "plugin.json");
            symlinkSync(`${UNC_TARGET_DIR}\\plugin.json`, link, "file");
            return link;
          },
        },
        {
          name: "unc-bundle-manifest",
          link: (project) => {
            const link = path.join(project, "bundle-manifest.json");
            symlinkSync(`${UNC_TARGET_DIR}\\bundle-manifest.json`, link, "file");
            return link;
          },
        },
      ];
      if (CAN_UNC_DIR_LINK) {
        cases.push({
          name: "unc-plugin-dir",
          link: (project) => {
            const link = path.join(project, ".zcode-plugin");
            symlinkSync(`${UNC_TARGET_DIR}\\zcode-plugin`, link, "dir");
            return link;
          },
        });
      }
      for (const testCase of cases) {
        const project = sandbox.project(testCase.name);
        const link = testCase.link(project);
        followCalls.paths.length = 0;
        expect(inspect(project, sandbox), testCase.name).toEqual({ safe: false, reason: "unc-or-device-link-target" });
        expect(followedThrough([link]), testCase.name).toEqual([]);
      }
    },
  );

  it.skipIf(!IS_WIN || !CAN_UNC_DIR_LINK)(
    "the plugin-install markers of the server script's ancestors are not followed through a UNC link either",
    () => {
      const sandbox = makeSandbox();
      const host = sandbox.project("host-with-script");
      const link = path.join(host, ".claude-plugin");
      symlinkSync(`${UNC_TARGET_DIR}\\claude-plugin`, link, "dir");
      const scriptDir = path.join(host, "node_modules", "causoryn", "dist");
      mkdirSync(scriptDir, { recursive: true });
      const script = path.join(scriptDir, "mcp-server.mjs");
      writeFileSync(script, "// placeholder\n");
      const candidate = sandbox.project("plain-project");
      followCalls.paths.length = 0;
      inspect(candidate, sandbox, script);
      expect(followedThrough([link])).toEqual([]);
    },
  );
});
