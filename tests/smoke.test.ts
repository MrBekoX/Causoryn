import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Sprint-1 iskelet smoke testi (görev 8'in ağ geçidi):
 * monorepo yapısı, kök script/config sözleşmeleri ve SQLite FTS5
 * kullanılabilirliği dosya sistemi üzerinden doğrulanır. Testler salt
 * okunurdur — depoya hiçbir şey yazılmaz (ADR-008); SQLite testi bellek
 * içi (`:memory:`) veritabanı kullanır.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Tüm dosya erişimleri repo kökü ile sınırlanır: path traversal koruması —
 * hedef resolve edilir ve repo kökü altında kaldığı doğrulanır (statik güvenlik
 * güvenlik kuralı; Causoryn Workspace Gateway'in same-root ilkesinin ayna
 * görüntüsü, TŞ v2.1 §9/§25/2).
 */
function resolveWithinRepo(relativePath: string): string {
  const target = path.resolve(repoRoot, relativePath);
  const boundary = repoRoot.endsWith(path.sep) ? repoRoot : repoRoot + path.sep;
  if (target !== repoRoot && !target.startsWith(boundary)) {
    throw new Error(`Repo kökü dışına erişim reddedildi: ${relativePath}`);
  }
  return target;
}

const PACKAGE_DIRS = [
  "packages/domain",
  "packages/workspace",
  "packages/indexing",
  "packages/graph",
  "packages/storage-sqlite",
  "packages/mcp-server",
] as const;

/**
 * Yalnızca iskelet (scaffold) paketleri: src/index.ts hâlâ sözleşme
 * placeholder'ıdır ve `status: "scaffold"` beyan etmek ZORUNDADIR (ADR-010
 * dürüstlük kuralı). `packages/domain` ve `packages/workspace` bu listede
 * DEĞİLDİR — gerçek implementasyondur (kendi unit testleri çalışır;
 * workspace: Sprint-1 görev 2 WorkspaceAccessPolicy).
 */
const SCAFFOLD_PACKAGE_DIRS = [
  "packages/indexing",
  "packages/graph",
  "packages/storage-sqlite",
  "packages/mcp-server",
] as const;

function readJson(relativePath: string): Record<string, unknown> {
  const raw = readFileSync(resolveWithinRepo(relativePath), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${relativePath} beklenen JSON nesnesi değil`);
  }
  return parsed as Record<string, unknown>;
}

function readText(relativePath: string): string {
  return readFileSync(resolveWithinRepo(relativePath), "utf8");
}

function exists(relativePath: string): boolean {
  return existsSync(resolveWithinRepo(relativePath));
}

function field(obj: Record<string, unknown>, key: string): unknown {
  const value: unknown = obj[key];
  expect(value, `${key} alanı yok`).toBeDefined();
  return value;
}

describe("kök package.json sözleşmesi", () => {
  const pkg = readJson("package.json");

  it("private true ve engines node >=24 beyan eder", () => {
    expect(field(pkg, "private")).toBe(true);
    const engines = field(pkg, "engines") as Record<string, unknown>;
    const nodeEngine = String(field(engines, "node"));
    expect(nodeEngine).toMatch(/>=\s*24/);
    // Host çalışma zamanı da en az 24 olmalı (engines sözleşmesi gerçek olsun).
    const hostMajor = Number(
      (process.version.replace(/^v/, "").split(".")[
        0
      ] as string | undefined) ?? "0",
    );
    expect(hostMajor).toBeGreaterThanOrEqual(24);
  });

  it("workspaces packages/adapters/integrations alanlarını kapsar", () => {
    const workspaces = field(pkg, "workspaces") as string[];
    expect(workspaces).toContain("packages/*");
    expect(workspaces).toContain("adapters/*");
    // Plugin paketi iki seviyede yaşar: integrations/zcode/causoryn.
    expect(
      workspaces.some((glob) =>
        ["integrations/*/*", "integrations/**"].includes(glob),
      ),
    ).toBe(true);
    // Glob'ların gerçekte işaret ettiği paketler mevcut olmalı.
    expect(exists("adapters/typescript/package.json")).toBe(true);
    expect(exists("integrations/zcode/causoryn/package.json")).toBe(true);
  });

  it("test/build/typecheck/lint script'leri tanımlı", () => {
    const scripts = field(pkg, "scripts") as Record<string, unknown>;
    expect(field(scripts, "test")).toBe("vitest run");
    expect(field(scripts, "build")).toBe("tsc -b");
    expect(String(field(scripts, "typecheck"))).toContain(
      "tsconfig.typecheck.json",
    );
    expect(field(scripts, "lint")).toBe("eslint .");
  });

  it("yasak LLM bağımlılıkları hiçbir workspace package.json'ında geçmez", () => {
    const banned = ["openai", "@anthropic-ai/sdk", "@google/generative-ai", "langchain"];
    const manifestPaths = [
      "package.json",
      ...PACKAGE_DIRS.map((dir) => `${dir}/package.json`),
      "adapters/typescript/package.json",
      "integrations/zcode/causoryn/package.json",
    ];
    for (const manifestPath of manifestPaths) {
      const raw = readText(manifestPath);
      for (const name of banned) {
        expect(raw, `${manifestPath} yasak bağımlılık içeriyor: ${name}`).not.toContain(
          `"${name}"`,
        );
      }
    }
  });
});

describe("TypeScript çözüm sözleşmesi", () => {
  it("tsconfig.base.json: strict + NodeNext + declaration + sourceMap", () => {
    const base = readJson("tsconfig.base.json");
    const options = field(base, "compilerOptions") as Record<string, unknown>;
    expect(field(options, "strict")).toBe(true);
    expect(field(options, "module")).toBe("nodenext");
    expect(field(options, "moduleResolution")).toBe("nodenext");
    expect(field(options, "declaration")).toBe(true);
    expect(field(options, "sourceMap")).toBe(true);
  });

  it("kök tsconfig.json solution olarak 7 projeye referans verir", () => {
    const solution = readJson("tsconfig.json");
    const references = field(solution, "references") as Array<
      Record<string, unknown>
    >;
    const paths = references.map((ref) => String(field(ref, "path")));
    expect(paths).toEqual([
      "packages/domain",
      "packages/workspace",
      "packages/indexing",
      "packages/graph",
      "packages/storage-sqlite",
      "packages/mcp-server",
      "adapters/typescript",
    ]);
    for (const projectPath of paths) {
      expect(exists(`${projectPath}/tsconfig.json`)).toBe(true);
    }
  });

  it("tsconfig.typecheck.json noEmit typecheck çözümü sağlar", () => {
    const typecheck = readJson("tsconfig.typecheck.json");
    const options = field(typecheck, "compilerOptions") as Record<string, unknown>;
    expect(field(options, "noEmit")).toBe(true);
  });
});

describe("monorepo dizin iskeleti", () => {
  it("6 çekirdek paket + adapter + integration + example + tests/docs mevcut", () => {
    const requiredDirs = [
      ...PACKAGE_DIRS,
      "adapters/typescript",
      "integrations/zcode/causoryn",
      "examples/fixture-ts-orders",
      "tests",
      "docs/adr",
    ];
    for (const dir of requiredDirs) {
      expect(exists(dir), `${dir} yok`).toBe(true);
    }
    // TŞ §18 sonu ilkesi: Faz A'da olmaması gereken paketler OLMAMALI.
    const forbidden = [
      "packages/contracts",
      "packages/preflight",
      "packages/wiki",
      "packages/roslyn",
    ];
    for (const dir of forbidden) {
      expect(exists(dir), `${dir} şimdilik olmamalı`).toBe(false);
    }
  });

  it("her çekirdek paket: package.json + tsconfig + anlamlı export", () => {
    for (const dir of PACKAGE_DIRS) {
      expect(exists(`${dir}/package.json`), `${dir}/package.json`).toBe(true);
      expect(exists(`${dir}/tsconfig.json`), `${dir}/tsconfig.json`).toBe(true);
      const indexRaw = readText(`${dir}/src/index.ts`);
      expect(indexRaw.length, `${dir}/src/index.ts boş`).toBeGreaterThan(100);
      expect(indexRaw, `${dir}/src/index.ts export içermiyor`).toContain("export ");
    }
    // İskelet dürüstlüğü: yalnızca scaffold paketler `status: "scaffold"`
    // beyan eder (ADR-010); domain gerçek implementasyondur.
    for (const dir of SCAFFOLD_PACKAGE_DIRS) {
      const indexRaw = readText(`${dir}/src/index.ts`);
      expect(indexRaw, `${dir} scaffold statüsü beyan etmiyor`).toContain('"scaffold"');
    }
    expect(readText("packages/domain/src/index.ts")).not.toContain('"scaffold"');
  });

  it("integration plugin paketi: package.json + README placeholder", () => {
    expect(exists("integrations/zcode/causoryn/README.md")).toBe(true);
    const readme = readText("integrations/zcode/causoryn/README.md");
    expect(readme).toContain("ZCode");
    expect(exists("examples/fixture-ts-orders/README.md")).toBe(true);
  });
});

describe("test ve lint araç sözleşmesi", () => {
  it("vitest.config.ts dört alanı kapsar, node_modules/dist dışlar", () => {
    const raw = readText("vitest.config.ts");
    for (const pattern of [
      "packages/*/test/**/*.test.ts",
      "adapters/*/test/**/*.test.ts",
      "integrations/**/*.test.ts",
      "tests/**/*.test.ts",
      "**/node_modules/**",
      "**/dist/**",
    ]) {
      expect(raw, `vitest include/exclude eksik: ${pattern}`).toContain(pattern);
    }
  });

  it("eslint flat config mevcut ve dist/node_modules ignore eder", () => {
    const raw = readText("eslint.config.js");
    expect(raw).toContain("typescript-eslint");
    expect(raw).toContain("**/dist/**");
    expect(raw).toContain("**/node_modules/**");
  });
});

describe("SQLite + FTS5 altyapı kanıtı (TŞ §9)", () => {
  it("better-sqlite3 yüklenir ve FTS5 sanal tablosu çalışır", async () => {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(":memory:");
    try {
      // Statik DDL; kullanıcı girdisi yok. Sorgu parametresi hazırlanmış
      // ifadeyle bağlanır (dış girdi asla SQL metnine eklenmez).
      db.exec("CREATE VIRTUAL TABLE smoke_fts USING fts5(symbol, file)");
      db.prepare("INSERT INTO smoke_fts (symbol, file) VALUES (?, ?)").run(
        "createOrder",
        "src/orders/service.ts",
      );
      const row = db
        .prepare("SELECT file FROM smoke_fts WHERE smoke_fts MATCH ?")
        .get("createOrder") as { file: string } | undefined;
      expect(row?.file).toBe("src/orders/service.ts");
    } finally {
      db.close();
    }
  });
});
