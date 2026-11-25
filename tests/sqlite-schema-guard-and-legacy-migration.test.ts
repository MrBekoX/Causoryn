import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCausorynContext } from "@causoryn/mcp-server";
import { SqliteGraphRepository } from "@causoryn/storage-sqlite";

import * as runtimeCli from "../packages/mcp-server/src/runtime-cli.js";

/**
 * Task 1.7 criteria 4 (schema version key) and the legacy per-client DB
 * migration:
 * - a shared graph.sqlite stamped by a NEWER schema is never written by this
 *   build: explicit configs are refused with a typed English error, and the
 *   runtime CLI falls back to graph.schema-<N>.sqlite with a stderr warning;
 * - legacy graph-<client>.sqlite files are migrated once into graph.sqlite.
 */

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(TEST_DIR);
const STDIO_ENTRY = path.join(REPO_ROOT, "packages", "mcp-server", "src", "cli-stdio.ts");
const LOADER_ENTRY = path.join(
  REPO_ROOT,
  "packages",
  "mcp-server",
  "test",
  "loader",
  "register-strip.mjs",
);
const READY_MARKER = "causoryn mcp server ready";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "causoryn-schema-guard-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeWorkspace(): string {
  const workspaceDir = path.join(tempRoot, "project");
  mkdirSync(path.join(workspaceDir, "src"), { recursive: true });
  writeFileSync(
    path.join(workspaceDir, "src", "index.ts"),
    "export function hello(): string { return 'hi'; }\n",
    "utf8",
  );
  return workspaceDir;
}

function stampVersion(file: string, version: number): void {
  const db = new Database(file);
  db.pragma(`user_version = ${String(version)}`);
  db.close();
}

function makeLegacyDb(file: string, marker: string): void {
  const repo = new SqliteGraphRepository(file);
  try {
    repo.registerWorkspace({ id: "project", rootPath: "/legacy", createdAt: "2026-11-01T00:00:00.000Z" });
    repo.upsertFile({
      workspaceId: "project",
      relativePath: marker,
      contentHash: "legacy-hash",
      sizeBytes: 1,
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
  } finally {
    repo.close();
  }
  const raw = new Database(file);
  raw.exec(`
    ALTER TABLE build_leases DROP COLUMN hostname;
    ALTER TABLE build_leases DROP COLUMN owner_instance;
    PRAGMA user_version = 4;
  `);
  raw.close();
}

describe("schema version guard", { timeout: 60_000 }, () => {
  it("explicit storage.dataDbPath with a newer schema is refused with a typed English error", () => {
    const workspaceDir = makeWorkspace();
    const dataDir = path.join(tempRoot, "data");
    mkdirSync(dataDir);
    const dbPath = path.join(dataDir, "graph.sqlite");
    stampVersion(dbPath, 99);
    expect(() =>
      createCausorynContext(
        { allowRoots: [workspaceDir], storage: { dataDbPath: dbPath } },
        { logger: () => {} },
      ),
    ).toThrow(/schema v99 is newer than this Causoryn build supports/);
    const probe = new Database(dbPath, { readonly: true });
    try {
      expect(probe.pragma("user_version", { simple: true })).toBe(99);
    } finally {
      probe.close();
    }
  });

  it("auto data dir: a newer graph.sqlite makes the CLI use graph.schema-<N>.sqlite with one stderr warning", () => {
    const workspaceDir = makeWorkspace();
    const baseDataDir = path.join(tempRoot, "causoryn-data");
    const first = runtimeCli.buildWorkspaceAutoConfig({
      roots: [workspaceDir],
      autoDataDir: true,
      dataDir: baseDataDir,
      logger: () => {},
    } as Parameters<typeof runtimeCli.buildWorkspaceAutoConfig>[0]);
    const sharedPath = first.storage.dataDbPath as string;
    expect(path.basename(sharedPath)).toBe("graph.sqlite");
    stampVersion(sharedPath, 99);

    const warnings: string[] = [];
    const second = runtimeCli.buildWorkspaceAutoConfig({
      roots: [workspaceDir],
      autoDataDir: true,
      dataDir: baseDataDir,
      logger: (message: string) => warnings.push(message),
    } as Parameters<typeof runtimeCli.buildWorkspaceAutoConfig>[0]);
    const fallback = path.join(path.dirname(sharedPath), "graph.schema-5.sqlite");
    expect(second.storage.dataDbPath).toBe(fallback);
    expect(second.wiki.dataDbPath).toBe(fallback);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/schema v99, newer than this Causoryn build supports \(v5\)/);
    expect(warnings[0]).toContain("graph.schema-5.sqlite");

    const context = createCausorynContext(second, { logger: () => {}, deferAutoIndex: true });
    context.close();
    const probe = new Database(sharedPath, { readonly: true });
    try {
      // The newer shared file was never touched.
      expect(probe.pragma("user_version", { simple: true })).toBe(99);
    } finally {
      probe.close();
    }
    expect(existsSync(fallback)).toBe(true);
  });
});

describe("legacy graph-<client>.sqlite migration", { timeout: 120_000 }, () => {
  it("prepareWorkspaceDatabase migrates the newest valid legacy DB once and logs one English line", async () => {
    const workspaceDir = makeWorkspace();
    const baseDataDir = path.join(tempRoot, "causoryn-data");
    const config = runtimeCli.buildWorkspaceAutoConfig({
      roots: [workspaceDir],
      autoDataDir: true,
      dataDir: baseDataDir,
    });
    const sharedPath = config.storage.dataDbPath as string;
    const dataDir = path.dirname(sharedPath);
    makeLegacyDb(path.join(dataDir, "graph-claude-code.sqlite"), "legacy/marker.ts");

    const prepare = (runtimeCli as unknown as {
      prepareWorkspaceDatabase?: (
        cfg: typeof config,
        opts: { logger: (m: string) => void },
      ) => Promise<void>;
    }).prepareWorkspaceDatabase;
    expect(typeof prepare).toBe("function");
    const lines: string[] = [];
    await prepare!(config, { logger: (message) => lines.push(message) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /migrated legacy database graph-claude-code\.sqlite \(schema v4\) into .*graph\.sqlite; legacy files were left in place/,
    );
    expect(readdirSync(dataDir)).toContain("graph-claude-code.sqlite");

    const context = createCausorynContext(config, { logger: () => {}, deferAutoIndex: true });
    try {
      expect(context.repository.listFiles("project").map((f) => f.relativePath)).toContain(
        "legacy/marker.ts",
      );
    } finally {
      context.close();
    }
    const again: string[] = [];
    await prepare!(config, { logger: (message) => again.push(message) });
    expect(again).toEqual([]);
  });

  it("the stdio CLI migrates a legacy DB before opening graph.sqlite (end to end)", async () => {
    const workspaceDir = makeWorkspace();
    const baseDataDir = path.join(tempRoot, "causoryn-data");
    const config = runtimeCli.buildWorkspaceAutoConfig({
      roots: [workspaceDir],
      autoDataDir: true,
      dataDir: baseDataDir,
    });
    const sharedPath = config.storage.dataDbPath as string;
    const dataDir = path.dirname(sharedPath);
    makeLegacyDb(path.join(dataDir, "graph-codex.sqlite"), "legacy/from-codex.ts");
    expect(existsSync(sharedPath)).toBe(false);

    const child = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--import",
        pathToFileURL(LOADER_ENTRY).href,
        STDIO_ENTRY,
        "mcp",
        "--root",
        workspaceDir,
        "--auto-data-dir",
        "--data-dir",
        baseDataDir,
        "--client",
        "zcode",
      ],
      { cwd: REPO_ROOT, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ready marker; stderr=${stderr}`)), 60_000);
        const check = (): void => {
          if (stderr.includes(READY_MARKER)) {
            clearTimeout(timer);
            resolve();
          }
        };
        child.stderr.on("data", check);
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`CLI exited early (${String(code)}): ${stderr}`));
        });
      });
    } finally {
      child.stdin.end();
      child.kill();
      await new Promise((resolve) => child.once("close", resolve));
    }
    expect(stdout).toBe("");
    expect(stderr).toMatch(/migrated legacy database graph-codex\.sqlite \(schema v4\)/);
    expect(existsSync(sharedPath)).toBe(true);
    expect(existsSync(path.join(dataDir, "graph-codex.sqlite"))).toBe(true);
    const repo = new SqliteGraphRepository(sharedPath);
    try {
      expect(repo.listFiles("project").map((f) => f.relativePath)).toContain("legacy/from-codex.ts");
    } finally {
      repo.close();
    }
  });
});
