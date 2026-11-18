import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * secret-scan kapsam, CWD bağımsızlığı, sahnelenmiş derleme dışlaması ve
 * negatif yakalama testleri (TŞ §23 DoD (3): pozitif + negatif + sınır).
 */

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(THIS_DIR);
const SECRET_SCAN_PATH = path.join(REPO_ROOT, "scripts", "secret-scan.mjs");

/** Kaynakta tek parça secret literal yazılmaz; çalışma zamanında birleştirilir. */
const BAIT_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";

const tempDirs: string[] = [];

function createTempRepoSkeleton(options?: { readonly omitNative?: boolean }): {
  readonly repoDir: string;
  readonly scriptCopyPath: string;
} {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-secret-scan-"));
  tempDirs.push(repoDir);

  mkdirSync(path.join(repoDir, "packages", "sample", "src"), { recursive: true });
  mkdirSync(path.join(repoDir, "adapters", "sample", "src"), { recursive: true });
  mkdirSync(path.join(repoDir, "apps", "visualizer", "src"), { recursive: true });
  if (!options?.omitNative) {
    mkdirSync(path.join(repoDir, "native", "worker", "src"), { recursive: true });
  }
  mkdirSync(path.join(repoDir, "scripts"), { recursive: true });
  mkdirSync(path.join(repoDir, "integrations", "zcode", "causoryn"), { recursive: true });
  mkdirSync(path.join(repoDir, "integrations", "antigravity", "causoryn"), { recursive: true });

  const scriptCopyPath = path.join(repoDir, "scripts", "secret-scan.mjs");
  copyFileSync(SECRET_SCAN_PATH, scriptCopyPath);
  writeFileSync(
    path.join(repoDir, "packages", "sample", "src", "clean.ts"),
    'export const ok = "clean";\n',
    "utf8",
  );
  return { repoDir, scriptCopyPath };
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/secret-scan.mjs — kapsam ve tarama kapısı", () => {
  it("SCAN_ROOTS tanımı apps, native ve integrations/antigravity/causoryn dahil 7 kökü kapsar", () => {
    expect(existsSync(SECRET_SCAN_PATH), "scripts/secret-scan.mjs mevcut olmalı").toBe(true);
    const source = readFileSync(SECRET_SCAN_PATH, "utf8");

    const scanRootsMatch = source.match(/const\s+SCAN_ROOTS\s*=\s*\[([\s\S]*?)\];/);
    expect(scanRootsMatch, "SCAN_ROOTS dizi tanımı bulunmalı").not.toBeNull();
    const scanRootsBody = scanRootsMatch?.[1] ?? "";

    expect(scanRootsBody).toContain('"packages"');
    expect(scanRootsBody).toContain('"adapters"');
    expect(scanRootsBody).toContain('"apps"');
    expect(scanRootsBody).toContain('"native"');
    expect(scanRootsBody).toContain('"scripts"');
    expect(scanRootsBody).toMatch(/path\.join\(\s*"integrations"\s*,\s*"zcode"\s*,\s*"causoryn"\s*\)/);
    expect(scanRootsBody).toMatch(
      /path\.join\(\s*"integrations"\s*,\s*"antigravity"\s*,\s*"causoryn"\s*\)/,
    );

    const excludeMatch = source.match(/const\s+EXCLUDE_SEGMENTS\s*=\s*new\s+Set\(\[([\s\S]*?)\]\);/);
    expect(excludeMatch, "EXCLUDE_SEGMENTS tanımı bulunmalı").not.toBeNull();
    const excludeBody = excludeMatch?.[1] ?? "";
    for (const seg of ["target", "bin", "obj", "test", "tests", "node_modules", "dist"]) {
      expect(excludeBody).toContain(`"${seg}"`);
    }
  });

  it("gerçek secret-scan koşumu CWD bağımsız olarak (cwd: os.tmpdir()) exit 0 ve '7 kök tarandı, 0 eşleşme' döndürür", () => {
    const stdout = execFileSync(process.execPath, [SECRET_SCAN_PATH], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(stdout).toContain("SECRET_SCAN YEŞİL");
    expect(stdout).toContain("7 kök tarandı, 0 eşleşme");
  });

  it("NEGATİF: apps, native veya integrations/antigravity/causoryn altında yem sır bulunduğunda exit 1 ve SECRET_SCAN KIRMIZI döner", () => {
    const { repoDir, scriptCopyPath } = createTempRepoSkeleton();
    writeFileSync(
      path.join(repoDir, "apps", "visualizer", "src", "leak.ts"),
      `export const k1 = "${BAIT_AWS_KEY}";\n`,
      "utf8",
    );
    writeFileSync(
      path.join(repoDir, "native", "worker", "src", "leak.rs"),
      `pub const K2: &str = "${BAIT_AWS_KEY}";\n`,
      "utf8",
    );
    writeFileSync(
      path.join(repoDir, "integrations", "antigravity", "causoryn", "mcp_config.json"),
      `{"token":"${BAIT_AWS_KEY}"}\n`,
      "utf8",
    );

    const res = spawnSync(process.execPath, [scriptCopyPath], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      shell: false,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("SECRET_SCAN KIRMIZI");
    expect(res.stderr).toContain("aws-access-key");
    expect(res.stderr).toContain(path.join("apps", "visualizer", "src", "leak.ts"));
    expect(res.stderr).toContain(path.join("native", "worker", "src", "leak.rs"));
    expect(res.stderr).toContain(
      path.join("integrations", "antigravity", "causoryn", "mcp_config.json"),
    );
  });

  it("SINIR: sahnelenmiş derleme çıktısı (integrations/antigravity/causoryn/scripts/) taranmazken kök scripts/ taranmaya devam eder", () => {
    const { repoDir, scriptCopyPath } = createTempRepoSkeleton();
    const stagedDir = path.join(repoDir, "integrations", "antigravity", "causoryn", "scripts");
    mkdirSync(stagedDir, { recursive: true });
    writeFileSync(
      path.join(stagedDir, "mcp-server.mjs"),
      `// bundled third-party comment ${BAIT_AWS_KEY}\n`,
      "utf8",
    );

    const cleanRun = spawnSync(process.execPath, [scriptCopyPath], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      shell: false,
    });
    expect(cleanRun.status).toBe(0);
    expect(cleanRun.stdout).toContain("7 kök tarandı, 0 eşleşme");

    // Kök scripts/ altındaki gerçek kaynak dosyası ise yakalanmalıdır:
    writeFileSync(
      path.join(repoDir, "scripts", "check-helper.mjs"),
      `export const leaked = "${BAIT_AWS_KEY}";\n`,
      "utf8",
    );
    const redRun = spawnSync(process.execPath, [scriptCopyPath], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      shell: false,
    });
    expect(redRun.status).toBe(1);
    expect(redRun.stderr).toContain("SECRET_SCAN KIRMIZI");
    expect(redRun.stderr).toContain(path.join("scripts", "check-helper.mjs"));
  });

  it("NEGATİF: beyan edilen SCAN_ROOTS köklerinden biri diskte yoksa sessizce '7 kök tarandı' denmez, exit 1 döner", () => {
    const { scriptCopyPath } = createTempRepoSkeleton({ omitNative: true });
    const res = spawnSync(process.execPath, [scriptCopyPath], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      shell: false,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("native");
  });
});
