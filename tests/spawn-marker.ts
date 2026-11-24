/**
 * Test helper: builds a harmless "marker" executable with the local Go
 * toolchain. When started, the marker writes `<its own path>.hit` and exits
 * with status 1 — nothing else. Tests plant copies of it under tool names
 * (git.exe, cargo.exe, ...) inside a fixture "analyzed repository" and assert
 * that no `.hit` file appears, i.e. the planted file was never started.
 *
 * Returns null when Go is not installed (callers skip cleanly).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveExecutable } from "../packages/graph/src/executable-resolution.js";

const MARKER_SOURCE = [
  "package main",
  "",
  "import \"os\"",
  "",
  "func main() {",
  "\texe, err := os.Executable()",
  "\tif err == nil {",
  "\t\t_ = os.WriteFile(exe+\".hit\", []byte(\"executed\"), 0o644)",
  "\t}",
  "\tos.Exit(1)",
  "}",
  "",
].join("\n");

let cachedMarker: string | null | undefined;

/** Absolute path of a built marker executable, or null when Go is missing. */
export function buildMarkerExecutable(): string | null {
  if (cachedMarker !== undefined) return cachedMarker;
  const go = resolveExecutable("go");
  if (go === null) {
    cachedMarker = null;
    return null;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "causoryn-marker-src-"));
  writeFileSync(path.join(dir, "main.go"), MARKER_SOURCE, "utf8");
  const out = path.join(dir, process.platform === "win32" ? "marker.exe" : "marker");
  const build = spawnSync(go, ["build", "-o", out, "main.go"], {
    cwd: dir,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 180_000,
    env: { ...process.env, GOTOOLCHAIN: "local", GOFLAGS: "", GOWORK: "off" },
  });
  cachedMarker = build.status === 0 && existsSync(out) ? out : null;
  if (cachedMarker === null) {
    console.error(`[spawn-marker] go build failed: ${build.stderr ?? ""}`);
  }
  return cachedMarker;
}

/**
 * Plants marker copies named after `toolNames` (with `.exe` on win32) in
 * `dir`; returns the planted absolute paths.
 */
export function plantMarkers(
  marker: string,
  dir: string,
  toolNames: readonly string[],
): string[] {
  mkdirSync(dir, { recursive: true });
  return toolNames.map((name) => {
    const target = path.join(dir, process.platform === "win32" ? `${name}.exe` : name);
    copyFileSync(marker, target);
    return target;
  });
}

/** Planted markers that were started (their `.hit` file exists). */
export function startedMarkers(planted: readonly string[]): string[] {
  return planted.filter((file) => existsSync(`${file}.hit`));
}

/**
 * Runs `fn` with the Windows cwd-first executable search UNMASKED: the
 * `NoDefaultCurrentDirectoryInExePath` variable (set by some harnesses) is
 * removed for the duration. On POSIX a leading "." PATH entry is added so the
 * equivalent cwd lookup is exercised. cwd is switched to `cwd`.
 */
export async function withCwdSearchUnmasked<T>(
  cwd: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const savedNoDefault = process.env["NoDefaultCurrentDirectoryInExePath"];
  const savedPath = process.env["PATH"];
  const savedCwd = process.cwd();
  delete process.env["NoDefaultCurrentDirectoryInExePath"];
  if (process.platform !== "win32") {
    process.env["PATH"] = `.:${savedPath ?? ""}`;
  }
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(savedCwd);
    if (savedNoDefault === undefined) delete process.env["NoDefaultCurrentDirectoryInExePath"];
    else process.env["NoDefaultCurrentDirectoryInExePath"] = savedNoDefault;
    if (process.platform !== "win32") {
      if (savedPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = savedPath;
    }
  }
}
