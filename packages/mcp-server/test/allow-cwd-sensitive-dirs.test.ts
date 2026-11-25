import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectProjectRootSafety } from "../src/index.js";

/**
 * `--allow-cwd` / MCP roots/list project-root filter: credential and tool
 * configuration directories are rejected as `sensitive-directory`, comparisons
 * hold for every spelling of a path (lexical, realpath, native long-name), and
 * a project inside the OS temp directory stays usable when the temp directory
 * itself lives inside a sensitive directory (Windows: %LOCALAPPDATA%\Temp).
 */

const IS_WIN = process.platform === "win32";

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

interface Sandbox {
  readonly base: string;
  readonly home: string;
  readonly project: string;
}

function makeSandbox(homeName = "home"): Sandbox {
  const base = mkdtempSync(path.join(tmpdir(), "causoryn-allow-cwd-"));
  cleanups.push(base);
  const home = path.join(base, homeName);
  const project = path.join(home, "projects", "alpha");
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "src", "app.ts"), "export const a = 1;\n");
  return { base, home, project };
}

function shortNameOf(longPath: string): string | null {
  if (!IS_WIN) return null;
  try {
    const out = spawnSync(
      process.env["ComSpec"] ?? "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/c", `for %I in ("${longPath}") do @echo %~sI`],
      { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true },
    )
      .stdout.trim()
      .replace(/^"|"$/g, "");
    return out.length > 0 && !out.includes('"') && out.toLowerCase() !== longPath.toLowerCase()
      ? out
      : null;
  } catch {
    return null;
  }
}

const SHORT_NAMES_AVAILABLE: boolean = (() => {
  if (!IS_WIN) return false;
  const probe = mkdtempSync(path.join(tmpdir(), "causoryn-allow-cwd-8dot3-"));
  try {
    const longDir = path.join(probe, "LongProbeDirectoryName");
    mkdirSync(longDir);
    return shortNameOf(longDir) !== null;
  } finally {
    rmSync(probe, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})();

const CAN_CREATE_DIR_SYMLINK: boolean = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), "causoryn-allow-cwd-probe-"));
  try {
    mkdirSync(path.join(probe, "t"));
    writeFileSync(path.join(probe, "t", "x.txt"), "probe");
    symlinkSync(path.join(probe, "t"), path.join(probe, "l"), "dir");
    return readFileSync(path.join(probe, "l", "x.txt"), "utf8") === "probe";
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})();

describe("inspectProjectRootSafety — sensitive user directories", () => {
  it("rejects tool and credential configuration directories under the home directory", () => {
    const sandbox = makeSandbox();
    const sensitive = [
      ".config",
      path.join(".config", "gcloud"),
      path.join(".config", "gh"),
      ".docker",
      ".azure",
      ".gcloud",
      ".npm",
      path.join(".npm", "_cacache"),
      ".cargo",
      path.join(".cargo", "registry"),
      "Library",
      path.join("Library", "Application Support", "tool"),
      path.join("AppData", "Roaming"),
      path.join("AppData", "Roaming", "tool"),
      path.join("AppData", "Local"),
      path.join("AppData", "Local", "tool"),
    ];
    for (const relative of sensitive) {
      const dir = path.join(sandbox.home, relative);
      mkdirSync(dir, { recursive: true });
      expect(inspectProjectRootSafety(dir, { homeDir: sandbox.home, env: {} }), relative).toEqual({
        safe: false,
        reason: "sensitive-directory",
      });
    }
    // Ordinary projects under the home directory stay usable.
    expect(inspectProjectRootSafety(sandbox.project, { homeDir: sandbox.home, env: {} }).safe).toBe(true);
    const lookalike = path.join(sandbox.home, ".configs-project");
    mkdirSync(lookalike);
    expect(inspectProjectRootSafety(lookalike, { homeDir: sandbox.home, env: {} }).safe).toBe(true);
  });

  it("rejects the APPDATA and LOCALAPPDATA directories named by the environment", () => {
    const sandbox = makeSandbox();
    const roaming = path.join(sandbox.base, "profile", "Roaming");
    const local = path.join(sandbox.base, "profile", "Local");
    mkdirSync(path.join(roaming, "tool"), { recursive: true });
    mkdirSync(path.join(local, "tool"), { recursive: true });
    const env = { APPDATA: roaming, LOCALAPPDATA: local };
    for (const dir of [roaming, path.join(roaming, "tool"), local, path.join(local, "tool")]) {
      expect(inspectProjectRootSafety(dir, { homeDir: sandbox.home, env }), dir).toEqual({
        safe: false,
        reason: "sensitive-directory",
      });
    }
    expect(inspectProjectRootSafety(sandbox.project, { homeDir: sandbox.home, env }).safe).toBe(true);
  });

  it("keeps a project inside the OS temp directory usable when a sensitive directory contains it", () => {
    const sandbox = makeSandbox();
    // Windows: %LOCALAPPDATA% contains %TEMP%. Model it on every platform with the
    // parent of the canonical temp directory.
    const tempParent = path.dirname(realpathSync(tmpdir()));
    const env = { LOCALAPPDATA: tempParent };
    const decision = inspectProjectRootSafety(sandbox.project, { homeDir: sandbox.home, env });
    expect(decision.safe).toBe(true);
    if (decision.safe) {
      expect(decision.canonicalRoot).toBe(realpathSync(sandbox.project));
    }
    // A sensitive directory inside the temp directory is still rejected.
    const ssh = path.join(sandbox.home, ".ssh");
    mkdirSync(ssh);
    expect(inspectProjectRootSafety(ssh, { homeDir: sandbox.home, env })).toEqual({
      safe: false,
      reason: "sensitive-directory",
    });
  });

  it.skipIf(!SHORT_NAMES_AVAILABLE)("rejects an 8.3 short-name spelling of a sensitive directory and of $HOME", () => {
    const sandbox = makeSandbox("LongHomeDirectoryName");
    const ssh = path.join(sandbox.home, ".ssh");
    mkdirSync(ssh);
    const shortSsh = shortNameOf(ssh);
    expect(shortSsh).not.toBeNull();
    expect(inspectProjectRootSafety(shortSsh as string, { homeDir: sandbox.home, env: {} })).toEqual({
      safe: false,
      reason: "sensitive-directory",
    });
    const shortHome = shortNameOf(sandbox.home);
    expect(shortHome).not.toBeNull();
    const homeDecision = inspectProjectRootSafety(shortHome as string, { homeDir: sandbox.home, env: {} });
    expect(homeDecision.safe).toBe(false);
    if (!homeDecision.safe) expect(homeDecision.reason).toMatch(/user home directory/);
  });

  it.skipIf(!IS_WIN || !CAN_CREATE_DIR_SYMLINK)(
    "rejects a candidate that is a link to a UNC share before the link is followed",
    () => {
      const sandbox = makeSandbox();
      const link = path.join(sandbox.home, "projects", "remote");
      // Explicit link type: the default type detection would stat the target.
      symlinkSync("\\\\127.0.0.1\\causoryn-none\\", link, "dir");
      expect(inspectProjectRootSafety(link, { homeDir: sandbox.home, env: {} })).toEqual({
        safe: false,
        reason: "unc-or-device-link-target",
      });
    },
  );
});
