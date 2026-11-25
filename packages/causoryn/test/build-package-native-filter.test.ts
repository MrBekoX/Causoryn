import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Native worker staging in `scripts/build-package.mjs`: hidden entries
 * (local tool caches, editor and VCS metadata) are never staged unless they
 * are explicitly allowlisted, without naming any particular tool.
 */

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUILD_PACKAGE_PATH = path.join(PKG_DIR, "scripts", "build-package.mjs");

interface BuildPackageModule {
  readonly copyNativeFiltered: (srcDir: string, destDir: string, workerName: string) => void;
  readonly NATIVE_HIDDEN_ENTRY_ALLOWLIST: ReadonlySet<string>;
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(root, rel)).sort()) {
    const childRel = rel ? `${rel}/${name}` : name;
    if (statSync(path.join(root, childRel)).isDirectory()) {
      out.push(...listFiles(root, childRel));
    } else {
      out.push(childRel);
    }
  }
  return out;
}

function writeTree(root: string, files: readonly string[]): void {
  for (const rel of files) {
    const target = path.join(root, ...rel.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${rel}\n`, "utf8");
  }
}

describe("build-package.mjs native worker staging", () => {
  it("skips every hidden directory and file (no tool-specific denylist) and keeps worker sources", async () => {
    const mod = (await import(pathToFileURL(BUILD_PACKAGE_PATH).href)) as BuildPackageModule;
    expect(mod.NATIVE_HIDDEN_ENTRY_ALLOWLIST.size).toBe(0);

    const root = mkdtempSync(path.join(os.tmpdir(), "causoryn-native-filter-"));
    tempDirs.push(root);
    const src = path.join(root, "src", "go-worker");
    const dest = path.join(root, "dest", "go-worker");
    writeTree(src, [
      "PROTOCOL.md",
      "go.mod",
      "cmd/worker/main.go",
      "internal/analyze/analyze.go",
      ".tool-cache/chunks/blob.source",
      ".scratch-agent/session.json",
      ".git/config",
      ".venv/pyvenv.cfg",
      "cmd/.editor/state.json",
      ".env",
      ".DS_Store",
      "cmd/worker/.notes",
      "target/debug/worker",
      "obj/project.assets.json",
      "__pycache__/x.pyc",
      "node_modules/pkg/index.js",
      "bin/fake-go",
      "test-build.lock",
      "Thumbs.db",
      "worker.pdb",
    ]);

    mod.copyNativeFiltered(src, dest, "go-worker");

    expect(listFiles(dest)).toEqual([
      "PROTOCOL.md",
      "cmd/worker/main.go",
      "go.mod",
      "internal/analyze/analyze.go",
    ]);
  });
});
