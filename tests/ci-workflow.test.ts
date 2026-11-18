/**
 * GitHub Actions CI iş akışı (.github/workflows/ci.yml) sözleşme ve güvenlik
 * testleri.
 *
 * Kapsam:
 * - Geçerli YAML ayrıştırması (yaml.parse).
 * - En-az-yetki izinleri: üst düzey permissions: { contents: "read" }.
 * - Tetikleyiciler: push (main) + pull_request (main); pull_request_target yasak.
 * - Matris: ubuntu-latest + windows-latest, fail-fast: false.
 * - Sabitlenmiş resmi toolchain action'ları ve güvenli checkout.
 * - Native sidecar worker derlemeleri (Roslyn + Rust).
 * - 7 kalite kapısının eksiksiz ve doğru sırayla yürütülmesi.
 * - run: bloklarında güvenilmeyen ${{ github.event.pull_request ifade
 *   interpolasyonunun bulunmaması.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(THIS_DIR);
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

interface WorkflowStep {
  readonly name?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly run?: string;
}

interface WorkflowJob {
  readonly "runs-on"?: string;
  readonly "timeout-minutes"?: number;
  readonly strategy?: {
    readonly "fail-fast"?: boolean;
    readonly matrix?: {
      readonly os?: readonly string[];
    };
  };
  readonly steps?: readonly WorkflowStep[];
}

interface WorkflowDoc {
  readonly name?: string;
  readonly permissions?: Readonly<Record<string, unknown>>;
  readonly on?: Readonly<Record<string, unknown>>;
  readonly jobs?: Readonly<Record<string, WorkflowJob>>;
}

function loadWorkflow(): { readonly raw: string; readonly doc: WorkflowDoc } {
  expect(
    existsSync(CI_WORKFLOW_PATH),
    ".github/workflows/ci.yml mevcut olmalı",
  ).toBe(true);
  const raw = readFileSync(CI_WORKFLOW_PATH, "utf8");
  const parsed: unknown = parse(raw);
  expect(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)).toBe(
    true,
  );
  return { raw, doc: parsed as WorkflowDoc };
}

function collectAllSteps(doc: WorkflowDoc): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  for (const job of Object.values(doc.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      steps.push(step);
    }
  }
  return steps;
}

describe(".github/workflows/ci.yml — CI sözleşmesi ve güvenlik kapıları", () => {
  it("dosya mevcuttur, geçerli YAML olarak ayrışır ve üst düzeyde salt-okunur izin tanımlar", () => {
    const { doc } = loadWorkflow();
    expect(doc.permissions).toEqual({ contents: "read" });
  });

  it("yalnızca main üzerinde push ve pull_request ile tetiklenir; pull_request_target kullanmaz", () => {
    const { doc } = loadWorkflow();
    const triggers = doc.on;
    expect(triggers).toBeDefined();
    expect(triggers?.["pull_request_target"]).toBeUndefined();
    expect(triggers?.["push"]).toEqual({ branches: ["main"] });
    expect(triggers?.["pull_request"]).toEqual({ branches: ["main"] });
  });

  it("ubuntu-latest ve windows-latest üzerinde fail-fast: false matris tanımlar", () => {
    const { doc } = loadWorkflow();
    const jobs = Object.values(doc.jobs ?? {});
    expect(jobs.length).toBeGreaterThanOrEqual(1);

    const matrixJob = jobs.find((job) => job.strategy?.matrix !== undefined);
    expect(matrixJob, "matris tanımlı CI job bulunmalı").toBeDefined();
    expect(matrixJob?.strategy?.["fail-fast"]).toBe(false);
    expect(matrixJob?.strategy?.matrix?.os).toEqual([
      "ubuntu-latest",
      "windows-latest",
    ]);
    expect(matrixJob?.["runs-on"]).toBe("${{ matrix.os }}");
  });

  it("gerekli resmi checkout ve dil toolchain action'larını beklenen sürümlerle kurar", () => {
    const { doc } = loadWorkflow();
    const steps = collectAllSteps(doc);

    const checkout = steps.find((step) => step.uses === "actions/checkout@v7");
    expect(checkout).toBeDefined();
    expect(checkout?.with).toEqual({ "persist-credentials": false });

    const setupNode = steps.find((step) => step.uses === "actions/setup-node@v7");
    expect(setupNode).toBeDefined();
    expect(String(setupNode?.with?.["node-version"])).toBe("24");

    const setupDotnet = steps.find(
      (step) => step.uses === "actions/setup-dotnet@v6",
    );
    expect(setupDotnet).toBeDefined();
    expect(setupDotnet?.with?.["dotnet-version"]).toBe("10.0.x");

    const setupPython = steps.find(
      (step) => step.uses === "actions/setup-python@v7",
    );
    expect(setupPython).toBeDefined();
    expect(String(setupPython?.with?.["python-version"])).toBe("3.12");

    const setupGo = steps.find((step) => step.uses === "actions/setup-go@v7");
    expect(setupGo).toBeDefined();
    expect(setupGo?.with?.["go-version-file"]).toBe("native/go-worker/go.mod");

    const setupRust = steps.find(
      (step) => step.uses === "dtolnay/rust-toolchain@stable",
    );
    expect(setupRust).toBeDefined();
  });

  it("native sidecar worker derlemelerini ve 7 kalite kapısının tamamını eksiksiz yürütür", () => {
    const { doc } = loadWorkflow();
    const runBlocks = collectAllSteps(doc)
      .map((step) => step.run)
      .filter((cmd): cmd is string => typeof cmd === "string")
      .map((cmd) => cmd.trim());

    const requiredNativeBuilds = [
      "dotnet build native/roslyn-worker/Causoryn.RoslynWorker.csproj -c Debug",
      "cargo build --manifest-path native/rust-worker/Cargo.toml",
    ] as const;

    for (const buildCmd of requiredNativeBuilds) {
      expect(
        runBlocks.some((block) => block.includes(buildCmd)),
        `native derleme komutu bulunmalı: ${buildCmd}`,
      ).toBe(true);
    }

    const requiredGates = [
      "npm ci --ignore-scripts",
      "npm run typecheck",
      "npm run build",
      "npm run build:bundle --workspace packages/mcp-server",
      "npm run lint",
      "npm run secret-scan",
      "npm test",
    ] as const;

    const gateIndices = requiredGates.map((gate) => {
      const idx = runBlocks.findIndex((block) =>
        block
          .split(/\r?\n/)
          .map((line) => line.trim())
          .includes(gate),
      );
      expect(idx, `kalite kapısı bulunmalı: ${gate}`).toBeGreaterThanOrEqual(0);
      return idx;
    });

    // npm ci --ignore-scripts ilk kapı, npm test ise son kapı olmalıdır.
    const installIdx = gateIndices[0] ?? -1;
    const testIdx = gateIndices[gateIndices.length - 1] ?? -1;
    for (const idx of gateIndices.slice(1)) {
      expect(idx).toBeGreaterThanOrEqual(installIdx);
    }
    for (const buildCmd of requiredNativeBuilds) {
      const nativeIdx = runBlocks.findIndex((block) => block.includes(buildCmd));
      expect(nativeIdx).toBeLessThan(testIdx);
    }
  });

  it("run: bloklarında güvenilmeyen ${{ github.event.pull_request ifade interpolasyonu içermez", () => {
    const { doc } = loadWorkflow();
    const runBlocks = collectAllSteps(doc)
      .map((step) => step.run)
      .filter((cmd): cmd is string => typeof cmd === "string");

    expect(runBlocks.length).toBeGreaterThan(0);
    for (const runBlock of runBlocks) {
      expect(runBlock).not.toContain("${{ github.event.pull_request");
    }
  });
});
