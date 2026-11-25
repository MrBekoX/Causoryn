import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

/**
 * Hardening wiring: the Python, Go and Rust adapters exclude PATH entries that
 * live inside the analyzed workspace when they resolve toolchain executables,
 * but only if IndexService tells them where the workspace is. Without
 * `workspaceRoot`, a server started with `--root <repo>` from a different cwd
 * would let PATH entries inside the repo win. This test pins that every
 * full-pipeline adapter call receives the canonical workspace root.
 */

const captured: Record<string, string | undefined> = {};

vi.mock("@causoryn/adapter-python", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@causoryn/adapter-python")>();
  return {
    ...actual,
    analyzePythonWorkspace: async (input: Parameters<typeof actual.analyzePythonWorkspace>[0]) => {
      captured["python"] = input.workspaceRoot;
      return actual.analyzePythonWorkspace({ ...input, options: { ...input.options, pythonCommand: "__missing_python__" } });
    },
  };
});
vi.mock("@causoryn/adapter-go", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@causoryn/adapter-go")>();
  return {
    ...actual,
    analyzeGoWorkspace: async (input: Parameters<typeof actual.analyzeGoWorkspace>[0]) => {
      captured["go"] = input.workspaceRoot;
      return actual.analyzeGoWorkspace({ ...input, options: { ...input.options, goBinaryPath: "__missing_go__", goWorkerBinaryPath: "__missing_go_worker__" } });
    },
  };
});
vi.mock("@causoryn/adapter-rust", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@causoryn/adapter-rust")>();
  return {
    ...actual,
    analyzeRustWorkspace: async (input: Parameters<typeof actual.analyzeRustWorkspace>[0]) => {
      captured["rust"] = input.workspaceRoot;
      return {
        ...(await actual.analyzeRustWorkspace({ ...input, files: [] })),
      };
    },
  };
});

import { InMemoryGraphRepository } from "@causoryn/graph";
import { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { IndexService } from "../src/index.js";

describe("IndexService passes the workspace root to sidecar adapters", () => {
  it("python, go and rust adapter calls receive the canonical workspace root", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "causoryn-wsroot-")));
    try {
      writeFileSync(path.join(root, "app.py"), "def main():\n    return 1\n", "utf8");
      writeFileSync(path.join(root, "main.go"), "package main\n\nfunc main() {}\n", "utf8");
      writeFileSync(path.join(root, "lib.rs"), "pub fn run() {}\n", "utf8");

      const service = new IndexService({
        workspaceId: "wsroot",
        policy: WorkspaceAccessPolicy.create({ allowRoots: [root] }),
        repository: new InMemoryGraphRepository(),
        clock: () => "2026-11-24T00:00:00.000Z",
        limits: { maxFiles: 1_000 },
      });

      await service.runIndexAsync(root).catch(() => undefined);

      for (const lang of ["python", "go", "rust"]) {
        expect(captured[lang], `${lang} adapter must receive workspaceRoot`).toBeDefined();
        expect(path.resolve(captured[lang] as string).toLowerCase()).toBe(path.resolve(root).toLowerCase());
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
