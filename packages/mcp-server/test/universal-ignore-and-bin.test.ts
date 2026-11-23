import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { WorkspaceAccessPolicy } from "@causoryn/workspace";

import { CausorynConfigError, buildWorkspaceAutoConfig } from "../src/index.js";
import {
  MAX_CSPROJ_BIN_PATTERNS,
  MAX_CSPROJ_SCAN_DEPTH,
  MAX_CSPROJ_SCAN_DIRS,
  MAX_DISCOVERED_IGNORE_PATTERNS,
  MAX_IGNORE_FILE_BYTES,
  MAX_LINES_PER_IGNORE_FILE,
  MAX_NEGATED_ANCESTOR_DEPTH,
  MAX_NESTED_GITIGNORE_DEPTH,
  MAX_NESTED_GITIGNORE_FILES,
  MAX_NESTED_WALK_DIRS,
  MAX_WILDCARDS_PER_PATTERN,
  discoverWorkspaceIgnoreConfig,
  isSafeIgnoreDirSegment,
} from "../src/workspace-ignore-discovery.js";

/**
 * Causoryn v0.2.3 — Universal Ignore Discovery (.git/info/exclude, nested .gitignore)
 * ve Smart bin/ Separation (AC-3, AC-4).
 *
 * Kırmızı çizgiler:
 * - Kaynak ağaca yazma yapılmaz (ADR-008); tüm fixture'lar os.tmpdir() altındadır.
 * - CWE-59: symlink `.git`, `.git/info`, `.git/info/exclude`, `.gitignore` ve alt dizin
 *   symlink'leri asla izlenmez.
 * - Deterministik, sınırlı tarama (256 KB dosya, derinlik ≤ 6 / 64 dosya / 1000 desen,
 *   .csproj taraması derinlik ≤ 4).
 */

const DIR_LINK_CAPABILITY: "dir" | "junction" | null = (() => {
  const candidates: readonly ("dir" | "junction")[] =
    process.platform === "win32" ? ["junction", "dir"] : ["dir"];
  for (const linkType of candidates) {
    const probe = mkdtempSync(path.join(tmpdir(), "causoryn-dirlink-probe-"));
    try {
      const target = path.join(probe, "target");
      const link = path.join(probe, "link");
      mkdirSync(target, { recursive: true });
      symlinkSync(target, link, linkType);
      return linkType;
    } catch {
      // Bu bağ türü bu ortamda desteklenmiyor; sıradakini dene.
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  }
  return null;
})();

const CAN_CREATE_DIR_LINK = DIR_LINK_CAPABILITY !== null;

const CAN_CREATE_FILE_SYMLINK: boolean = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), "causoryn-filelink-probe-"));
  try {
    const target = path.join(probe, "target.txt");
    const link = path.join(probe, "link.txt");
    writeFileSync(target, "probe", "utf8");
    symlinkSync(target, link, "file");
    return readFileSync(link, "utf8") === "probe";
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

interface TestWorkspace {
  readonly baseDir: string;
  readonly repoDir: string;
  readonly dataDir: string;
  readonly fakeHome: string;
  readonly cleanup: () => void;
}

function makeWorkspace(prefix = "causoryn-univ-ign-"): TestWorkspace {
  const baseDir = mkdtempSync(path.join(tmpdir(), prefix));
  const fakeHome = path.join(baseDir, "home");
  const repoDir = path.join(fakeHome, "projects", "sample-repo");
  const dataDir = path.join(baseDir, "data");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return {
    baseDir,
    repoDir,
    dataDir,
    fakeHome,
    cleanup: () => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

function buildPolicy(
  ws: TestWorkspace,
  options: { readonly autoDataDir?: boolean; readonly rawBaseConfig?: unknown } = {},
): { readonly config: ReturnType<typeof buildWorkspaceAutoConfig>; readonly policy: WorkspaceAccessPolicy } {
  const config = buildWorkspaceAutoConfig({
    roots: [ws.repoDir],
    autoDataDir: options.autoDataDir ?? true,
    dataDir: ws.dataDir,
    homeDir: ws.fakeHome,
    ...(options.rawBaseConfig !== undefined ? { rawBaseConfig: options.rawBaseConfig } : {}),
  });
  const policy = WorkspaceAccessPolicy.create({
    allowRoots: config.allowRoots,
    ignore: config.ignore,
    extraIgnore: config.extraIgnore,
    binaryExtensions: config.binaryExtensions,
    extensionFilterMode: config.extensionFilterMode,
    allowedExtensions: config.allowedExtensions,
    maxFileBytes: config.maxFileBytes,
  });
  return { config, policy };
}

describe("v0.2.3 Source 2: .git/info/exclude keşfi ve CWE-59 güvenliği", () => {
  it(".git/info/exclude desenlerini (UTF-8 BOM ve negasyon güvenliği dahil) hem autoDataDir=true hem autoDataDir=false modunda uygular", () => {
    const ws = makeWorkspace();
    try {
      mkdirSync(path.join(ws.repoDir, ".git", "info"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, ".mimosa", "chunks"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, "local-scratch"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, "kept"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, "src"), { recursive: true });

      writeFileSync(path.join(ws.repoDir, ".mimosa", "chunks", "blob.source"), "raw\n");
      writeFileSync(path.join(ws.repoDir, "local-scratch", "tmp.ts"), "export const t = 1;\n");
      writeFileSync(path.join(ws.repoDir, "kept", "important.ts"), "export const k = 1;\n");
      writeFileSync(path.join(ws.repoDir, "src", "app.ts"), "export const app = 1;\n");
      writeFileSync(
        path.join(ws.repoDir, ".git", "info", "exclude"),
        "\uFEFF" +
          [
            "# local repo excludes",
            "",
            ".mimosa/",
            "local-scratch/",
            "kept/*",
            "!kept/important.ts",
          ].join("\n"),
        "utf8",
      );

      for (const autoDataDir of [true, false]) {
        const { policy } = buildPolicy(ws, { autoDataDir });
        expect(policy.checkPath(ws.repoDir, ".mimosa/chunks/blob.source").allowed).toBe(false);
        expect(policy.checkPath(ws.repoDir, "local-scratch/tmp.ts").allowed).toBe(false);
        expect(policy.checkPath(ws.repoDir, "kept/important.ts").allowed).toBe(true);
        expect(policy.checkPath(ws.repoDir, "src/app.ts").allowed).toBe(true);
      }
    } finally {
      ws.cleanup();
    }
  });

  it("worktree .git regular dosyası olduğunda hata fırlatmadan güvenle atlar", () => {
    const ws = makeWorkspace();
    try {
      mkdirSync(path.join(ws.repoDir, "src"), { recursive: true });
      writeFileSync(path.join(ws.repoDir, ".git"), "gitdir: ../../outside-git-dir\n", "utf8");
      writeFileSync(path.join(ws.repoDir, "src", "app.ts"), "export const ok = true;\n");

      const { policy } = buildPolicy(ws);
      expect(policy.checkPath(ws.repoDir, "src/app.ts").allowed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it("256 KB üstündeki .git/info/exclude ve .gitignore dosyaları güvenle atlanır", () => {
    const ws = makeWorkspace();
    try {
      mkdirSync(path.join(ws.repoDir, ".git", "info"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, "oversized-target"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, "frontend", "oversized-nested"), { recursive: true });
      writeFileSync(path.join(ws.repoDir, "oversized-target", "keep.ts"), "export const a = 1;\n");
      writeFileSync(
        path.join(ws.repoDir, "frontend", "oversized-nested", "keep.ts"),
        "export const b = 2;\n",
      );

      const bigPadding = `# ${"x".repeat(262_200)}\n`;
      writeFileSync(
        path.join(ws.repoDir, ".git", "info", "exclude"),
        `${bigPadding}oversized-target/\n`,
        "utf8",
      );
      writeFileSync(
        path.join(ws.repoDir, "frontend", ".gitignore"),
        `${bigPadding}oversized-nested/\n`,
        "utf8",
      );

      const { policy } = buildPolicy(ws);
      expect(policy.checkPath(ws.repoDir, "oversized-target/keep.ts").allowed).toBe(true);
      expect(policy.checkPath(ws.repoDir, "frontend/oversized-nested/keep.ts").allowed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it("symlink/junction .git veya .git/info dışarıya işaret ediyorsa atlanır (CWE-59)", { skip: !CAN_CREATE_DIR_LINK }, () => {
    const ws = makeWorkspace();
    try {
      const outsideGit = path.join(ws.baseDir, "outside-git");
      mkdirSync(path.join(outsideGit, "info"), { recursive: true });
      writeFileSync(path.join(outsideGit, "info", "exclude"), "src/\n", "utf8");

      mkdirSync(path.join(ws.repoDir, "src"), { recursive: true });
      writeFileSync(path.join(ws.repoDir, "src", "keep.ts"), "export const keep = 1;\n");
      symlinkSync(outsideGit, path.join(ws.repoDir, ".git"), DIR_LINK_CAPABILITY ?? "dir");

      const { policy } = buildPolicy(ws);
      expect(policy.checkPath(ws.repoDir, "src/keep.ts").allowed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it("symlink .git/info/exclude veya symlink .gitignore atlanır (CWE-59)", { skip: !CAN_CREATE_FILE_SYMLINK }, () => {
    const ws = makeWorkspace();
    try {
      const outsideExclude = path.join(ws.baseDir, "outside-exclude");
      writeFileSync(outsideExclude, "src/\n", "utf8");

      mkdirSync(path.join(ws.repoDir, ".git", "info"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, "src"), { recursive: true });
      writeFileSync(path.join(ws.repoDir, "src", "keep.ts"), "export const keep = 1;\n");
      symlinkSync(outsideExclude, path.join(ws.repoDir, ".git", "info", "exclude"), "file");

      const { policy } = buildPolicy(ws);
      expect(policy.checkPath(ws.repoDir, "src/keep.ts").allowed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });
});

describe("v0.2.3 Source 3: İç içe (nested) .gitignore kapsamlandırma ve sınırlar", () => {
  it("frontend/.gitignore desenlerini yalnızca frontend/ altına kapsamlandırır; backend/ etkilenmez", () => {
    const ws = makeWorkspace();
    try {
      const pathsToCreate = [
        "frontend/build/a.js",
        "frontend/nested/build/b.js",
        "frontend/local-dist/bundle.js",
        "frontend/nested/local-dist/keep.ts",
        "frontend/root-only.ts",
        "frontend/nested/root-only.ts",
        "frontend/src/api.gen.ts",
        "frontend/top.gen.ts",
        "frontend/temp-cache/x.ts",
        "frontend/nested/temp-cache/y.ts",
        "frontend/sub/out/x.js",
        "frontend/deep/sub/out/keep.ts",
        "frontend/src/app.ts",
        "backend/build/a.ts",
        "backend/api.gen.ts",
        "backend/temp-cache/z.ts",
        "build/root.ts",
        "escape-target/keep.ts",
      ];
      for (const rel of pathsToCreate) {
        const full = path.join(ws.repoDir, rel);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, "export const x = 1;\n", "utf8");
      }

      writeFileSync(
        path.join(ws.repoDir, "frontend", ".gitignore"),
        [
          "# frontend-scoped ignores",
          "build/",
          "/local-dist/",
          "/root-only.ts",
          "*.gen.ts",
          "temp-cache",
          "sub/out/",
          "../escape-target/",
        ].join("\n"),
        "utf8",
      );

      const { policy } = buildPolicy(ws);

      // frontend/ içinde dışlananlar:
      expect(policy.checkPath(ws.repoDir, "frontend/build/a.js").allowed).toBe(false);
      expect(policy.checkPath(ws.repoDir, "frontend/nested/build/b.js").allowed).toBe(false);
      expect(policy.checkPath(ws.repoDir, "frontend/local-dist/bundle.js").allowed).toBe(false);
      expect(policy.checkPath(ws.repoDir, "frontend/root-only.ts").allowed).toBe(false);
      expect(policy.checkPath(ws.repoDir, "frontend/src/api.gen.ts").allowed).toBe(false);
      expect(policy.checkPath(ws.repoDir, "frontend/top.gen.ts").allowed).toBe(false);
      expect(policy.checkPath(ws.repoDir, "frontend/temp-cache/x.ts").allowed).toBe(false);
      expect(policy.checkPath(ws.repoDir, "frontend/nested/temp-cache/y.ts").allowed).toBe(false);
      expect(policy.checkPath(ws.repoDir, "frontend/sub/out/x.js").allowed).toBe(false);

      // Anchored desenler alt dizinde eşleşmez:
      expect(policy.checkPath(ws.repoDir, "frontend/nested/local-dist/keep.ts").allowed).toBe(true);
      expect(policy.checkPath(ws.repoDir, "frontend/nested/root-only.ts").allowed).toBe(true);
      expect(policy.checkPath(ws.repoDir, "frontend/deep/sub/out/keep.ts").allowed).toBe(true);
      expect(policy.checkPath(ws.repoDir, "frontend/src/app.ts").allowed).toBe(true);

      // backend/ ve kök dizin KESİNLİKLE etkilenmez:
      expect(policy.checkPath(ws.repoDir, "backend/build/a.ts").allowed).toBe(true);
      expect(policy.checkPath(ws.repoDir, "backend/api.gen.ts").allowed).toBe(true);
      expect(policy.checkPath(ws.repoDir, "backend/temp-cache/z.ts").allowed).toBe(true);
      expect(policy.checkPath(ws.repoDir, "build/root.ts").allowed).toBe(true);
      expect(policy.checkPath(ws.repoDir, "escape-target/keep.ts").allowed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it("nested .gitignore içinde dosya-bazlı negasyon güvenliği (!generated/keep.ts) aşırı-dışlamayı önler", () => {
    const ws = makeWorkspace();
    try {
      mkdirSync(path.join(ws.repoDir, "frontend", "generated"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, "frontend", "staging"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, "frontend", "trash"), { recursive: true });
      writeFileSync(path.join(ws.repoDir, "frontend", "generated", "keep.ts"), "export const g = 1;\n");
      writeFileSync(path.join(ws.repoDir, "frontend", "staging", "keep.ts"), "export const s = 2;\n");
      writeFileSync(path.join(ws.repoDir, "frontend", "trash", "dump.ts"), "export const t = 3;\n");
      writeFileSync(
        path.join(ws.repoDir, "frontend", ".gitignore"),
        [
          "generated/**",
          "!generated/keep.ts",
          "staging/",
          "!staging/keep.ts",
          "trash/",
        ].join("\n"),
        "utf8",
      );

      const { policy } = buildPolicy(ws);
      expect(policy.checkPath(ws.repoDir, "frontend/generated/keep.ts").allowed).toBe(true);
      expect(policy.checkPath(ws.repoDir, "frontend/staging/keep.ts").allowed).toBe(true);
      expect(policy.checkPath(ws.repoDir, "frontend/trash/dump.ts").allowed).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it("sınırlı yürüyüş tavanlarını uygular: derinlik ≤ 6, en fazla 64 nested .gitignore, toplam 1000 desen", () => {
    const ws = makeWorkspace();
    try {
      // 1) Derinlik 6 okunur, derinlik 7 okunmaz:
      const depth6Dir = path.join(ws.repoDir, "d1", "d2", "d3", "d4", "d5", "d6");
      const depth7Dir = path.join(depth6Dir, "d7");
      mkdirSync(path.join(depth6Dir, "drop6"), { recursive: true });
      mkdirSync(path.join(depth7Dir, "drop7"), { recursive: true });
      writeFileSync(path.join(depth6Dir, "drop6", "a.ts"), "export const a = 1;\n");
      writeFileSync(path.join(depth7Dir, "drop7", "b.ts"), "export const b = 2;\n");
      writeFileSync(path.join(depth6Dir, ".gitignore"), "drop6/\n", "utf8");
      writeFileSync(path.join(depth7Dir, ".gitignore"), "drop7/\n", "utf8");

      const { policy } = buildPolicy(ws);
      expect(policy.checkPath(ws.repoDir, "d1/d2/d3/d4/d5/d6/drop6/a.ts").allowed).toBe(false);
      expect(policy.checkPath(ws.repoDir, "d1/d2/d3/d4/d5/d6/d7/drop7/b.ts").allowed).toBe(true);
    } finally {
      ws.cleanup();
    }

    // 2) En fazla 64 nested .gitignore dosyası (leksikografik ilk 64 okunur):
    const wsCapFiles = makeWorkspace("causoryn-cap64-");
    try {
      for (let i = 0; i < 70; i += 1) {
        const name = `pkg-${String(i).padStart(2, "0")}`;
        mkdirSync(path.join(wsCapFiles.repoDir, name, "out"), { recursive: true });
        writeFileSync(path.join(wsCapFiles.repoDir, name, "out", "x.ts"), "export const x = 1;\n");
        writeFileSync(path.join(wsCapFiles.repoDir, name, ".gitignore"), "out/\n", "utf8");
      }
      const { config, policy } = buildPolicy(wsCapFiles);
      expect(config.extraIgnore.length).toBe(64);
      expect(policy.checkPath(wsCapFiles.repoDir, "pkg-00/out/x.ts").allowed).toBe(false);
      expect(policy.checkPath(wsCapFiles.repoDir, "pkg-63/out/x.ts").allowed).toBe(false);
      expect(policy.checkPath(wsCapFiles.repoDir, "pkg-64/out/x.ts").allowed).toBe(true);
    } finally {
      wsCapFiles.cleanup();
    }

    // 3) Toplam desen tavanı 1000:
    const wsCapPatterns = makeWorkspace("causoryn-cap1000-");
    try {
      for (let i = 0; i < 5; i += 1) {
        const dir = path.join(wsCapPatterns.repoDir, `mod-${String(i)}`);
        mkdirSync(dir, { recursive: true });
        const lines: string[] = [];
        for (let j = 0; j < 250; j += 1) {
          lines.push(`gen-${String(j).padStart(3, "0")}.tmp`);
        }
        writeFileSync(path.join(dir, ".gitignore"), `${lines.join("\n")}\n`, "utf8");
      }
      const { config } = buildPolicy(wsCapPatterns);
      expect(config.extraIgnore.length).toBe(1000);
    } finally {
      wsCapPatterns.cleanup();
    }
  });
});

describe("v0.2.3 Source 4: Smart bin/ ayrımı (AC-4)", () => {
  it("poliglot repoda .csproj/.fsproj/.vbproj altındaki bin/ ile bin/{Debug,Release,x64,x86,AnyCPU} dışlanır; bin/cli.ts ve src/bin/main.rs izinli kalır", () => {
    const ws = makeWorkspace("causoryn-smart-bin-");
    try {
      const files = [
        "Api/Api.csproj",
        "Api/Program.cs",
        "Api/bin/Custom/gen.cs",
        "Worker/Worker.fsproj",
        "Worker/bin/Custom/gen.fs",
        "Legacy/Legacy.vbproj",
        "Legacy/bin/Custom/gen.vb",
        "Other/bin/Debug/out.cs",
        "Other/bin/Release/out.cs",
        "Other/bin/x64/out.cs",
        "Other/bin/x86/out.cs",
        "Other/bin/AnyCPU/out.cs",
        "bin/cli.ts",
        "src/bin/main.rs",
      ];
      for (const rel of files) {
        const full = path.join(ws.repoDir, rel);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, "// sample\n", "utf8");
      }

      for (const autoDataDir of [true, false]) {
        const { config, policy } = buildPolicy(ws, { autoDataDir });

        // Smart bin/ aktif: blunt **/bin/** yerine hedefli kurallar
        expect(config.ignore).not.toContain("**/bin/**");
        expect(config.ignore).toContain("**/bin/Debug/**");
        expect(config.ignore).toContain("**/bin/Release/**");
        expect(config.ignore).toContain("**/bin/x64/**");
        expect(config.ignore).toContain("**/bin/x86/**");
        expect(config.ignore).toContain("**/bin/AnyCPU/**");
        expect(config.ignore).toContain("Api/bin/**");
        expect(config.ignore).toContain("Worker/bin/**");
        expect(config.ignore).toContain("Legacy/bin/**");

        // .NET proje bin/ klasörleri ve Debug/Release/x64/x86/AnyCPU dışlanır:
        expect(policy.checkFile(ws.repoDir, "Api/bin/Custom/gen.cs").allowed).toBe(false);
        expect(policy.checkFile(ws.repoDir, "Worker/bin/Custom/gen.fs").allowed).toBe(false);
        expect(policy.checkFile(ws.repoDir, "Legacy/bin/Custom/gen.vb").allowed).toBe(false);
        expect(policy.checkFile(ws.repoDir, "Other/bin/Debug/out.cs").allowed).toBe(false);
        expect(policy.checkFile(ws.repoDir, "Other/bin/Release/out.cs").allowed).toBe(false);
        expect(policy.checkFile(ws.repoDir, "Other/bin/x64/out.cs").allowed).toBe(false);
        expect(policy.checkFile(ws.repoDir, "Other/bin/x86/out.cs").allowed).toBe(false);
        expect(policy.checkFile(ws.repoDir, "Other/bin/AnyCPU/out.cs").allowed).toBe(false);

        // Node CLI ve Rust binary kaynakları İZİNLİ:
        expect(policy.checkFile(ws.repoDir, "bin/cli.ts").allowed).toBe(true);
        expect(policy.checkFile(ws.repoDir, "src/bin/main.rs").allowed).toBe(true);
        expect(policy.checkFile(ws.repoDir, "Api/Program.cs").allowed).toBe(true);
      }
    } finally {
      ws.cleanup();
    }
  });

  it("kök dizinde .csproj varsa 'bin/**' yalnızca kök bin/'i dışlar, src/bin/main.rs izinli kalır", () => {
    const ws = makeWorkspace("causoryn-root-csproj-");
    try {
      mkdirSync(path.join(ws.repoDir, "bin", "Custom"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, "src", "bin"), { recursive: true });
      writeFileSync(path.join(ws.repoDir, "RootApp.csproj"), "<Project />\n", "utf8");
      writeFileSync(path.join(ws.repoDir, "bin", "Custom", "gen.cs"), "// gen\n", "utf8");
      writeFileSync(path.join(ws.repoDir, "src", "bin", "main.rs"), "fn main() {}\n", "utf8");

      const { config, policy } = buildPolicy(ws);
      expect(config.ignore).toContain("bin/**");
      expect(policy.checkFile(ws.repoDir, "bin/Custom/gen.cs").allowed).toBe(false);
      expect(policy.checkFile(ws.repoDir, "src/bin/main.rs").allowed).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it("çağıran açık rawBaseConfig.ignore verdiğinde smart bin/ onu ASLA ezmez", () => {
    const ws = makeWorkspace("causoryn-explicit-ignore-");
    try {
      mkdirSync(path.join(ws.repoDir, "bin"), { recursive: true });
      writeFileSync(path.join(ws.repoDir, "bin", "cli.ts"), "export const cli = 1;\n", "utf8");

      const explicit = ["**/.git/**", "**/bin/**"];
      for (const autoDataDir of [true, false]) {
        const { config, policy } = buildPolicy(ws, {
          autoDataDir,
          rawBaseConfig: { ignore: explicit },
        });
        expect(config.ignore).toEqual(explicit);
        expect(policy.checkFile(ws.repoDir, "bin/cli.ts").allowed).toBe(false);
      }

      // Açık boş ignore dizisi de korunmalıdır:
      const { config: emptyCfg } = buildPolicy(ws, {
        rawBaseConfig: { ignore: [] },
      });
      expect(emptyCfg.ignore).toEqual([]);
    } finally {
      ws.cleanup();
    }
  });

  it(".csproj taraması derinlik ≤ 4 ile sınırlıdır ve sonuçlar deterministiktir", () => {
    const ws = makeWorkspace("causoryn-csproj-depth-");
    try {
      const depth4 = path.join(ws.repoDir, "a", "b", "c", "d");
      const depth5 = path.join(depth4, "e");
      mkdirSync(path.join(depth4, "bin", "Custom"), { recursive: true });
      mkdirSync(path.join(depth5, "bin", "Custom"), { recursive: true });
      mkdirSync(path.join(depth5, "bin", "Debug"), { recursive: true });
      writeFileSync(path.join(depth4, "D4.csproj"), "<Project />\n", "utf8");
      writeFileSync(path.join(depth5, "D5.csproj"), "<Project />\n", "utf8");
      writeFileSync(path.join(depth4, "bin", "Custom", "x.cs"), "// x\n", "utf8");
      writeFileSync(path.join(depth5, "bin", "Custom", "y.cs"), "// y\n", "utf8");
      writeFileSync(path.join(depth5, "bin", "Debug", "z.cs"), "// z\n", "utf8");

      const first = buildPolicy(ws);
      const second = buildPolicy(ws);
      expect(JSON.stringify(first.config.ignore)).toBe(JSON.stringify(second.config.ignore));
      expect(JSON.stringify(first.config.extraIgnore)).toBe(JSON.stringify(second.config.extraIgnore));

      expect(first.config.ignore).toContain("a/b/c/d/bin/**");
      expect(first.config.ignore).not.toContain("a/b/c/d/e/bin/**");
      expect(first.policy.checkFile(ws.repoDir, "a/b/c/d/bin/Custom/x.cs").allowed).toBe(false);
      expect(first.policy.checkFile(ws.repoDir, "a/b/c/d/e/bin/Custom/y.cs").allowed).toBe(true);
      expect(first.policy.checkFile(ws.repoDir, "a/b/c/d/e/bin/Debug/z.cs").allowed).toBe(false);
    } finally {
      ws.cleanup();
    }
  });
});

describe("v0.2.3 discoverWorkspaceIgnoreConfig — birim sözleşmesi, budama ve güvenlik sertleştirmesi", () => {
  it("tavan sabitleri AC-3/AC-4 sözleşmesiyle eşleşir; var olmayan kök ve hasExplicitIgnore=true güvenle yönetilir", () => {
    expect(MAX_IGNORE_FILE_BYTES).toBe(256 * 1024);
    expect(MAX_NESTED_GITIGNORE_DEPTH).toBe(6);
    expect(MAX_NESTED_GITIGNORE_FILES).toBe(64);
    expect(MAX_NESTED_WALK_DIRS).toBe(4_000);
    expect(MAX_DISCOVERED_IGNORE_PATTERNS).toBe(1_000);
    expect(MAX_CSPROJ_SCAN_DEPTH).toBe(4);
    expect(MAX_CSPROJ_SCAN_DIRS).toBe(2_000);

    const ws = makeWorkspace("causoryn-unit-disc-");
    try {
      const missing = discoverWorkspaceIgnoreConfig(path.join(ws.baseDir, "does-not-exist"));
      expect(missing).toEqual({ extraIgnore: [] });
      expect("refinedDefaultIgnore" in missing).toBe(false);

      const withExplicit = discoverWorkspaceIgnoreConfig(ws.repoDir, { hasExplicitIgnore: true });
      expect(withExplicit.extraIgnore).toEqual([]);
      expect(withExplicit.refinedDefaultIgnore).toBeUndefined();
      expect("refinedDefaultIgnore" in withExplicit).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it("varsayılan veya .git/info/exclude ile dışlanan dizinlerdeki (.mimosa, node_modules) nested .gitignore budanır", () => {
    const ws = makeWorkspace("causoryn-prune-");
    try {
      mkdirSync(path.join(ws.repoDir, ".git", "info"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, ".mimosa", "sub"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, "node_modules", "pkg"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, "frontend"), { recursive: true });

      writeFileSync(path.join(ws.repoDir, ".git", "info", "exclude"), ".mimosa/\n", "utf8");
      writeFileSync(
        path.join(ws.repoDir, ".mimosa", "sub", ".gitignore"),
        "mimosa-sentinel/\n",
        "utf8",
      );
      writeFileSync(
        path.join(ws.repoDir, "node_modules", "pkg", ".gitignore"),
        "nm-sentinel/\n",
        "utf8",
      );
      writeFileSync(path.join(ws.repoDir, "frontend", ".gitignore"), "tmp-out/\n", "utf8");

      const discovered = discoverWorkspaceIgnoreConfig(ws.repoDir);
      expect(discovered.extraIgnore).toContain(".mimosa/");
      expect(discovered.extraIgnore).toContain("frontend/**/tmp-out/");
      expect(discovered.extraIgnore.some((p) => p.includes("mimosa-sentinel"))).toBe(false);
      expect(discovered.extraIgnore.some((p) => p.includes("nm-sentinel"))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it("ReDoS sertleştirmesi: ardışık **/** tekilleştirilir, aşırı uzun veya çoklu-** desenler atlanır, '*' + '!src/' aşırı-dışlama yapmaz", () => {
    const ws = makeWorkspace("causoryn-redos-");
    try {
      mkdirSync(path.join(ws.repoDir, "src"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, "frontend", "a", "b"), { recursive: true });
      writeFileSync(path.join(ws.repoDir, "src", "app.ts"), "export const a = 1;\n", "utf8");
      writeFileSync(path.join(ws.repoDir, "frontend", "a", "b", "drop.tmp"), "tmp\n", "utf8");

      const overlyLong = `${"a".repeat(600)}/`;
      const excessiveGlobstars = "**/a/**/b/**/c/**/d/**/e/**";
      writeFileSync(
        path.join(ws.repoDir, ".gitignore"),
        [
          "*",
          "!src/",
          overlyLong,
          excessiveGlobstars,
          "cache/**/**/**/temp",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        path.join(ws.repoDir, "frontend", ".gitignore"),
        "a/**/**/**/drop.tmp\n",
        "utf8",
      );

      const discovered = discoverWorkspaceIgnoreConfig(ws.repoDir);
      expect(discovered.extraIgnore).not.toContain("*");
      expect(discovered.extraIgnore).not.toContain(overlyLong);
      expect(discovered.extraIgnore).not.toContain(excessiveGlobstars);
      expect(discovered.extraIgnore).toContain("cache/**/temp");
      expect(discovered.extraIgnore).toContain("frontend/a/**/drop.tmp");

      const { policy } = buildPolicy(ws);
      expect(policy.checkPath(ws.repoDir, "src/app.ts").allowed).toBe(true);
      expect(policy.checkPath(ws.repoDir, "frontend/a/b/drop.tmp").allowed).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it(".git/info symlink'i ile dışa işaret eden alt dizin symlink'indeki .gitignore ve .csproj atlanır (CWE-59)", { skip: !CAN_CREATE_DIR_LINK }, () => {
    const ws = makeWorkspace("causoryn-symlink-sub-");
    try {
      const outsideInfo = path.join(ws.baseDir, "outside-info");
      const outsidePkg = path.join(ws.baseDir, "outside-pkg");
      mkdirSync(outsideInfo, { recursive: true });
      mkdirSync(outsidePkg, { recursive: true });
      writeFileSync(path.join(outsideInfo, "exclude"), "outside-info-marker/\n", "utf8");
      writeFileSync(path.join(outsidePkg, ".gitignore"), "outside-pkg-marker/\n", "utf8");
      writeFileSync(path.join(outsidePkg, "Evil.csproj"), "<Project />\n", "utf8");

      mkdirSync(path.join(ws.repoDir, ".git"), { recursive: true });
      symlinkSync(outsideInfo, path.join(ws.repoDir, ".git", "info"), DIR_LINK_CAPABILITY ?? "dir");
      symlinkSync(outsidePkg, path.join(ws.repoDir, "linked-pkg"), DIR_LINK_CAPABILITY ?? "dir");

      const discovered = discoverWorkspaceIgnoreConfig(ws.repoDir);
      expect(discovered.extraIgnore.some((p) => p.includes("outside-info-marker"))).toBe(false);
      expect(discovered.extraIgnore.some((p) => p.includes("outside-pkg-marker"))).toBe(false);
      expect(discovered.refinedDefaultIgnore).not.toContain("linked-pkg/bin/**");
    } finally {
      ws.cleanup();
    }
  });

  it("symlink nested .gitignore ve symlink .csproj dosyaları atlanır (CWE-59)", { skip: !CAN_CREATE_FILE_SYMLINK }, () => {
    const ws = makeWorkspace("causoryn-symlink-files-");
    try {
      const outsideIgnore = path.join(ws.baseDir, "outside.gitignore");
      const outsideCsproj = path.join(ws.baseDir, "Outside.csproj");
      writeFileSync(outsideIgnore, "secret-drop/\n", "utf8");
      writeFileSync(outsideCsproj, "<Project />\n", "utf8");

      mkdirSync(path.join(ws.repoDir, "sub"), { recursive: true });
      symlinkSync(outsideIgnore, path.join(ws.repoDir, "sub", ".gitignore"), "file");
      symlinkSync(outsideCsproj, path.join(ws.repoDir, "sub", "Fake.csproj"), "file");

      const discovered = discoverWorkspaceIgnoreConfig(ws.repoDir);
      expect(discovered.extraIgnore.some((p) => p.includes("secret-drop"))).toBe(false);
      expect(discovered.refinedDefaultIgnore).not.toContain("sub/bin/**");
    } finally {
      ws.cleanup();
    }
  });
});

describe("v0.2.3 denetim düzeltme regresyonları (SEC-01/05/07/08/09, HIGH-1/3, MEDIUM-2)", () => {
  it("SEC-01: 2 satırlık ReDoS .gitignore (!a*40 + *a*a...*b) < 50 ms içinde biter ve > 16 jokerli desen reddedilir", () => {
    expect(MAX_WILDCARDS_PER_PATTERN).toBe(16);
    expect(MAX_LINES_PER_IGNORE_FILE).toBe(4_000);
    expect(MAX_NEGATED_ANCESTOR_DEPTH).toBe(16);
    expect(MAX_CSPROJ_BIN_PATTERNS).toBe(128);

    const ws = makeWorkspace("causoryn-sec01-");
    try {
      const target = "a".repeat(40);
      const redosPattern = `${"*a".repeat(22)}*b`;
      writeFileSync(
        path.join(ws.repoDir, ".gitignore"),
        `!${target}\n${redosPattern}\n`,
        "utf8",
      );

      const t0 = performance.now();
      const discovered = discoverWorkspaceIgnoreConfig(ws.repoDir);
      const elapsedMs = performance.now() - t0;

      expect(elapsedMs, `2 satırlık ReDoS .gitignore yavaşladı: ${elapsedMs.toFixed(1)} ms`).toBeLessThan(50);
      expect(discovered.extraIgnore).not.toContain(redosPattern);
    } finally {
      ws.cleanup();
    }
  });

  it("SEC-05 & HIGH-3: 256 KB yinelenen satırlar + 64 derin negasyon < 200 ms sürer; 4000 satır sınırı ve 128 .csproj tavanı uygulanır", () => {
    const ws = makeWorkspace("causoryn-sec05-");
    try {
      const lines: string[] = [];
      for (let i = 0; i < 64; i += 1) {
        const deep = Array.from({ length: 24 }, (_, idx) => `d${String(idx)}`).join("/");
        lines.push(`!${deep}/keep-${String(i).padStart(2, "0")}.ts`);
      }
      // ~245 KB yinelenen satırlar (4000 satır tavanının çok üstünde)
      for (let i = 0; i < 12_000; i += 1) {
        lines.push("dup-entry/*.tmp");
      }
      lines.push("after-line-cap-dir/");
      const content = `${lines.join("\n")}\n`;
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MAX_IGNORE_FILE_BYTES);
      writeFileSync(path.join(ws.repoDir, ".gitignore"), content, "utf8");

      const t0 = performance.now();
      const discovered = discoverWorkspaceIgnoreConfig(ws.repoDir);
      const elapsedMs = performance.now() - t0;

      expect(elapsedMs, `256 KB .gitignore işleme süresi aşıldı: ${elapsedMs.toFixed(1)} ms`).toBeLessThan(200);
      expect(discovered.extraIgnore).not.toContain("after-line-cap-dir/");
    } finally {
      ws.cleanup();
    }

    // 140 .csproj alt dizini -> refinedDefaultIgnore içinde en fazla 128 proje bin/** kuralı:
    const wsCsproj = makeWorkspace("causoryn-csproj-cap-");
    try {
      for (let i = 0; i < 140; i += 1) {
        const dirName = `svc-${String(i).padStart(3, "0")}`;
        const dirPath = path.join(wsCsproj.repoDir, dirName);
        mkdirSync(dirPath, { recursive: true });
        writeFileSync(path.join(dirPath, "App.csproj"), "<Project />\n", "utf8");
      }
      const discovered = discoverWorkspaceIgnoreConfig(wsCsproj.repoDir);
      const projectBinRules = (discovered.refinedDefaultIgnore ?? []).filter((p) =>
        /^svc-\d{3}\/bin\/\*\*$/.test(p),
      );
      expect(projectBinRules.length).toBe(128);
      expect(projectBinRules[0]).toBe("svc-000/bin/**");
      expect(projectBinRules[127]).toBe("svc-127/bin/**");
    } finally {
      wsCsproj.cleanup();
    }
  });

  it("HIGH-1: nested .gitignore dirOnly ('build/', '/local-dist/') normal dosyayı gizlemez ama dizin ve içeriğini reddeder", () => {
    const ws = makeWorkspace("causoryn-dironly-");
    try {
      mkdirSync(path.join(ws.repoDir, "frontend", "sub", "build"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, "frontend-dir", "local-dist"), { recursive: true });
      // Regular dosyalar (dizin DEĞİL!):
      writeFileSync(path.join(ws.repoDir, "frontend", "build"), "#!/bin/sh\necho build\n", "utf8");
      writeFileSync(path.join(ws.repoDir, "frontend", "local-dist"), "regular file\n", "utf8");
      // Gerçek dizin altındaki dosyalar:
      writeFileSync(path.join(ws.repoDir, "frontend", "sub", "build", "a.js"), "var a=1;\n", "utf8");
      writeFileSync(path.join(ws.repoDir, "frontend-dir", "local-dist", "bundle.js"), "var b=1;\n", "utf8");

      writeFileSync(
        path.join(ws.repoDir, "frontend", ".gitignore"),
        "build/\n/local-dist/\n",
        "utf8",
      );
      writeFileSync(
        path.join(ws.repoDir, "frontend-dir", ".gitignore"),
        "/local-dist/\n",
        "utf8",
      );

      const discovered = discoverWorkspaceIgnoreConfig(ws.repoDir);
      expect(discovered.extraIgnore).toContain("frontend/**/build/");
      expect(discovered.extraIgnore).toContain("frontend/local-dist/");
      expect(discovered.extraIgnore).toContain("frontend-dir/local-dist/");

      const { policy } = buildPolicy(ws);
      // Normal dosyalar dirOnly kuralıyla GİZLENMEMELİ:
      expect(policy.checkPath(ws.repoDir, "frontend/build").allowed).toBe(true);
      expect(policy.checkPath(ws.repoDir, "frontend/local-dist").allowed).toBe(true);
      // Gerçek dizin ve içeriği REDDEDİLMELİ:
      expect(policy.checkPath(ws.repoDir, "frontend/sub/build").allowed).toBe(false);
      expect(policy.checkPath(ws.repoDir, "frontend/sub/build/a.js").allowed).toBe(false);
      expect(policy.checkPath(ws.repoDir, "frontend-dir/local-dist").allowed).toBe(false);
      expect(policy.checkPath(ws.repoDir, "frontend-dir/local-dist/bundle.js").allowed).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it("MEDIUM-2: jokerli negasyon (!build/*.js, !*.ts) ve > 64 negasyon taşması aşırı-dışlamayı önler", () => {
    const ws = makeWorkspace("causoryn-neg-wc-");
    try {
      mkdirSync(path.join(ws.repoDir, "build"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, "src"), { recursive: true });
      mkdirSync(path.join(ws.repoDir, "logs"), { recursive: true });
      writeFileSync(path.join(ws.repoDir, "build", "output.js"), "module.exports = 1;\n", "utf8");
      writeFileSync(path.join(ws.repoDir, "src", "gen.ts"), "export const g = 1;\n", "utf8");
      writeFileSync(path.join(ws.repoDir, "logs", "run.log"), "log\n", "utf8");
      writeFileSync(
        path.join(ws.repoDir, ".gitignore"),
        [
          "build/output.js",
          "!build/*.js",
          "src/gen.ts",
          "!*.ts",
          "logs/run.log",
        ].join("\n"),
        "utf8",
      );

      const { policy } = buildPolicy(ws);
      expect(policy.checkPath(ws.repoDir, "build/output.js").allowed).toBe(true);
      expect(policy.checkPath(ws.repoDir, "src/gen.ts").allowed).toBe(true);
      expect(policy.checkPath(ws.repoDir, "logs/run.log").allowed).toBe(false);
    } finally {
      ws.cleanup();
    }

    // > 64 benzersiz negasyon taşması: jokerli pozitif kurallar muhafazakâr biçimde atlanır, literal kurallar korunur
    const wsOverflow = makeWorkspace("causoryn-neg-ovf-");
    try {
      mkdirSync(path.join(wsOverflow.repoDir, "trash-dir"), { recursive: true });
      writeFileSync(path.join(wsOverflow.repoDir, "keep-68.ts"), "export const k = 68;\n", "utf8");
      writeFileSync(path.join(wsOverflow.repoDir, "other.ts"), "export const o = 1;\n", "utf8");
      writeFileSync(path.join(wsOverflow.repoDir, "trash-dir", "drop.txt"), "drop\n", "utf8");

      const negLines: string[] = [];
      for (let i = 0; i < 70; i += 1) {
        negLines.push(`!keep-${String(i).padStart(2, "0")}.ts`);
      }
      negLines.push("*.ts");
      negLines.push("trash-dir/");
      writeFileSync(path.join(wsOverflow.repoDir, ".gitignore"), `${negLines.join("\n")}\n`, "utf8");

      const { policy } = buildPolicy(wsOverflow);
      expect(policy.checkPath(wsOverflow.repoDir, "keep-68.ts").allowed).toBe(true);
      expect(policy.checkPath(wsOverflow.repoDir, "other.ts").allowed).toBe(true);
      expect(policy.checkPath(wsOverflow.repoDir, "trash-dir/drop.txt").allowed).toBe(false);
    } finally {
      wsOverflow.cleanup();
    }
  });

  it("SEC-09: doğrulanmamış göreli allowRoots şema doğrulaması öncesi diskte yürünmez ve extraIgnore Object.hasOwn ile okunur", () => {
    try {
      buildWorkspaceAutoConfig({
        roots: [],
        autoDataDir: false,
        rawBaseConfig: {
          allowRoots: ["."],
          extraIgnore: "invalid-not-an-array",
        },
      });
      throw new Error("CausorynConfigError beklenmişti");
    } catch (error) {
      expect(error).toBeInstanceOf(CausorynConfigError);
      const issues = (error as CausorynConfigError).issues;
      expect(issues.some((i) => i.includes("allowRoots"))).toBe(true);
      // Eğer "." diskte yürünseydi mergeExtraIgnore "invalid-not-an-array" değerini
      // CWD .gitignore dizisiyle ezecekti ve extraIgnore doğrulama hatası kaybolacaktı!
      expect(issues.some((i) => i.includes("extraIgnore"))).toBe(true);
    }

    // autoDataDir=true iken de göreli allowRoots reddedilmelidir:
    expect(() =>
      buildWorkspaceAutoConfig({
        roots: [],
        autoDataDir: true,
        rawBaseConfig: { allowRoots: ["../other"] },
      }),
    ).toThrow(CausorynConfigError);
  });

  it("SEC-08: glob joker (*, ?) veya yol kaçışı içeren dizin adları isSafeIgnoreDirSegment tarafından reddedilir", () => {
    for (const bad of ["", ".", "..", "*", "foo*bar", "a?b", "a\0b", "a/b", "a\\b"]) {
      expect(isSafeIgnoreDirSegment(bad), `reddedilmeli: ${JSON.stringify(bad)}`).toBe(false);
    }
    for (const good of ["frontend", "pkg-01", ".config", "Api.Service_2"]) {
      expect(isSafeIgnoreDirSegment(good), `kabul edilmeli: ${good}`).toBe(true);
    }

    if (process.platform !== "win32") {
      const ws = makeWorkspace("causoryn-sec08-posix-");
      try {
        const evilDir = path.join(ws.repoDir, "evil*dir");
        mkdirSync(evilDir, { recursive: true });
        writeFileSync(path.join(evilDir, ".gitignore"), "secret/\n", "utf8");
        writeFileSync(path.join(evilDir, "Evil.csproj"), "<Project />\n", "utf8");

        const discovered = discoverWorkspaceIgnoreConfig(ws.repoDir);
        expect(discovered.extraIgnore.some((p) => p.includes("evil*dir"))).toBe(false);
        expect((discovered.refinedDefaultIgnore ?? []).some((p) => p.includes("evil*dir"))).toBe(
          false,
        );
      } finally {
        ws.cleanup();
      }
    }
  });
});
