import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import {
  CANONICAL_SKILL_NAMES,
  HOST_CLIENT_IDS,
  getHostSkillsDir,
  runSetup,
} from "../packages/causoryn/src/index.js";
import { ArchitectureAnnotationsSchema } from "../packages/graph/src/architecture-annotations.js";
import {
  ContractsToolInputSchema,
  ExportDocumentationCoreInputSchema,
  FindSymbolsToolInputSchema,
  GetAgentContextToolInputSchema,
  GetEvidenceToolInputSchema,
  GetSymbolContextToolInputSchema,
  MapSystemToolInputSchema,
  ObservedTestRunToolInputSchema,
  PreflightChangeCoreInputSchema,
  StatusToolInputSchema,
  TraceToolInputSchema,
  VerifyChangeCoreInputSchema,
} from "../packages/mcp-server/src/schemas.js";
import {
  CORE_TOOL_NAMES,
  HISTORY_TOOL_NAMES,
  TOOL_NAMES,
  WIKI_TOOL_NAMES,
} from "../packages/mcp-server/src/version.js";

/**
 * Regression guard for the "installed skills call tools that do not exist in
 * the default profile" finding.
 *
 * `causoryn setup` registers the MCP server without `--tool-profile`, so every
 * host sees the default `core` profile. Every skill that ships with Causoryn
 * (repo `skills/`, every tracked copy under `integrations/`, the generated
 * `packages/causoryn/skills/` copy when present, and the files `setup`
 * actually installs) may only reference core tools — unless the very same
 * line names the `--tool-profile` that provides the tool.
 *
 * Tool-call examples written as `causoryn_x` `{...json...}` on one line, or as
 * a ```json block right after a line naming the tool, are parsed and
 * validated against the real core input schemas.
 *
 * The expected tool catalogs are pinned as literals below so this test does
 * not merely compare the source catalog with itself.
 */

const EXPECTED_CORE_TOOLS = [
  "causoryn_contracts",
  "causoryn_export_documentation",
  "causoryn_find_symbols",
  "causoryn_get_agent_context",
  "causoryn_get_evidence",
  "causoryn_get_symbol_context",
  "causoryn_map_system",
  "causoryn_preflight_change",
  "causoryn_status",
  "causoryn_trace",
  "causoryn_verify_change",
] as const;

const EXPECTED_HISTORY_TOOLS = [
  "causoryn_architecture_timeline",
  "causoryn_compare_architecture",
] as const;

const EXPECTED_WIKI_TOOLS = [
  "causoryn_wiki_build",
  "causoryn_wiki_diff",
  "causoryn_wiki_get_links",
  "causoryn_wiki_get_page",
  "causoryn_wiki_get_tree",
  "causoryn_wiki_get_versions",
  "causoryn_wiki_search",
] as const;

const CORE = new Set<string>(EXPECTED_CORE_TOOLS);
const HISTORY = new Set<string>(EXPECTED_HISTORY_TOOLS);
const WIKI = new Set<string>(EXPECTED_WIKI_TOOLS);
const LEGACY_FULL = new Set<string>(TOOL_NAMES);

/** Core input schemas exactly as registered for the default profile. */
const CORE_INPUT_SCHEMAS: Readonly<Record<(typeof EXPECTED_CORE_TOOLS)[number], ZodType>> = {
  causoryn_status: StatusToolInputSchema,
  causoryn_map_system: MapSystemToolInputSchema,
  causoryn_find_symbols: FindSymbolsToolInputSchema,
  causoryn_get_symbol_context: GetSymbolContextToolInputSchema,
  causoryn_trace: TraceToolInputSchema,
  causoryn_get_agent_context: GetAgentContextToolInputSchema,
  causoryn_preflight_change: PreflightChangeCoreInputSchema,
  causoryn_verify_change: VerifyChangeCoreInputSchema,
  causoryn_contracts: ContractsToolInputSchema,
  causoryn_get_evidence: GetEvidenceToolInputSchema,
  causoryn_export_documentation: ExportDocumentationCoreInputSchema,
};

const TOOL_TOKEN = /causoryn_[a-z_]+/g;
const PROFILE_MENTION =
  /(?:--tool-profile[\s=]+|CAUSORYN_TOOL_PROFILE\s*=\s*)[`"']?([a-z]+(?:,[a-z]+)*)/g;

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

interface SkillDocument {
  readonly label: string;
  readonly text: string;
}

interface Violation {
  readonly where: string;
  readonly message: string;
}

/** Profiles that provide `tool`; `null` means the tool is in the default core profile. */
function providingProfiles(tool: string): readonly string[] | null {
  if (CORE.has(tool)) return null;
  if (HISTORY.has(tool)) return ["history", "full"];
  if (WIKI.has(tool)) return ["wiki", "full"];
  if (LEGACY_FULL.has(tool)) return ["full"];
  return [];
}

function profilesNamedOnLine(line: string): ReadonlySet<string> {
  const named = new Set<string>();
  for (const match of line.matchAll(PROFILE_MENTION)) {
    for (const part of (match[1] ?? "").split(",")) {
      if (part.length > 0) named.add(part);
    }
  }
  return named;
}

function checkToolReferences(doc: SkillDocument): Violation[] {
  const violations: Violation[] = [];
  const lines = doc.text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const where = `${doc.label}:${String(index + 1)}`;
    for (const match of line.matchAll(TOOL_TOKEN)) {
      const tool = match[0];
      const profiles = providingProfiles(tool);
      if (profiles === null) continue;
      if (profiles.length === 0) {
        violations.push({ where, message: `${tool} is not a Causoryn tool in any profile` });
        continue;
      }
      const named = profilesNamedOnLine(line);
      if (!profiles.some((profile) => named.has(profile))) {
        violations.push({
          where,
          message: `${tool} is not in the default core profile; the line must name --tool-profile ${profiles.join(" or ")}`,
        });
      }
    }
  });
  return violations;
}

interface ToolCallExample {
  readonly where: string;
  readonly tool: string;
  readonly json: string;
}

/** Extracts `causoryn_x` `{...}` pairs (same line) and ```json blocks preceded by a tool line. */
function extractToolCallExamples(doc: SkillDocument): ToolCallExample[] {
  const examples: ToolCallExample[] = [];
  const lines = doc.text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const where = `${doc.label}:${String(index + 1)}`;

    if (line.trim() === "```json") {
      let prev = index - 1;
      while (prev >= 0 && (lines[prev] ?? "").trim().length === 0) prev -= 1;
      const previousTools = [...(lines[prev] ?? "").matchAll(/`(causoryn_[a-z_]+)`/g)].map(
        (m) => m[1] ?? "",
      );
      const end = lines.findIndex((candidate, i) => i > index && candidate.trim() === "```");
      if (previousTools.length === 1 && end > index) {
        examples.push({
          where,
          tool: previousTools[0] ?? "",
          json: lines.slice(index + 1, end).join("\n"),
        });
      }
      continue;
    }

    let currentTool: string | null = null;
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      const content = span[1] ?? "";
      if (/^causoryn_[a-z_]+$/.test(content)) {
        currentTool = content;
      } else if (currentTool !== null && content.startsWith("{") && content.endsWith("}")) {
        examples.push({ where, tool: currentTool, json: content });
        currentTool = null;
      }
    }
  }
  return examples;
}

function checkToolCallExamples(doc: SkillDocument): {
  readonly checked: number;
  readonly violations: Violation[];
} {
  const violations: Violation[] = [];
  const examples = extractToolCallExamples(doc);
  for (const example of examples) {
    const schema = CORE_INPUT_SCHEMAS[example.tool as (typeof EXPECTED_CORE_TOOLS)[number]];
    if (schema === undefined) {
      violations.push({
        where: example.where,
        message: `argument example for ${example.tool}, which is not a core tool`,
      });
      continue;
    }
    let args: unknown;
    try {
      args = JSON.parse(example.json) as unknown;
    } catch (error) {
      violations.push({
        where: example.where,
        message: `argument example for ${example.tool} is not valid JSON: ${String(error)}`,
      });
      continue;
    }
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      violations.push({
        where: example.where,
        message: `invalid ${example.tool} arguments: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; ")}`,
      });
      continue;
    }
    const record = args as Record<string, unknown>;
    if (example.tool === "causoryn_verify_change" && record["observedTestRun"] !== undefined) {
      const observed = ObservedTestRunToolInputSchema.safeParse(record["observedTestRun"]);
      if (!observed.success) {
        violations.push({
          where: example.where,
          message: `invalid observedTestRun: ${observed.error.issues.map((i) => i.message).join("; ")}`,
        });
      }
    }
    if (example.tool === "causoryn_export_documentation" && record["annotations"] !== undefined) {
      const annotations = ArchitectureAnnotationsSchema.safeParse(record["annotations"]);
      if (!annotations.success) {
        violations.push({
          where: example.where,
          message: `invalid annotations: ${annotations.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
        });
      }
    }
  }
  return { checked: examples.length, violations };
}

function readSkillDir(skillsRoot: string, labelPrefix: string): SkillDocument[] {
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsRoot, entry.name, "SKILL.md"))
    .filter((file) => existsSync(file) && statSync(file).isFile())
    .sort()
    .map((file) => ({
      label: `${labelPrefix}/${path.relative(skillsRoot, file).replace(/\\/g, "/")}`,
      text: readFileSync(file, "utf8"),
    }));
}

/** Every SKILL.md under integrations/ (generated bundles and node_modules excluded). */
function readIntegrationSkills(): SkillDocument[] {
  const out: SkillDocument[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        out.push({
          label: path.relative(REPO_ROOT, full).replace(/\\/g, "/"),
          text: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(path.join(REPO_ROOT, "integrations"));
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

const sandboxes: string[] = [];
let installedSkills: SkillDocument[] = [];

beforeAll(async () => {
  // Install the skills exactly as `causoryn setup` does, into an isolated HOME.
  const sandbox = mkdtempSync(path.join(os.tmpdir(), "causoryn-skills-core-"));
  sandboxes.push(sandbox);
  const fakeHome = path.join(sandbox, "home");
  mkdirSync(fakeHome, { recursive: true });
  await runSetup({
    homeDir: fakeHome,
    codexHomeDir: path.join(fakeHome, ".codex"),
    packageRoot: path.join(REPO_ROOT, "packages", "causoryn"),
    ephemeralTmpDir: path.join(sandbox, "unused-tmp"),
    clients: [...HOST_CLIENT_IDS],
    installSkills: true,
    nodeExecutable: process.execPath,
    yes: true,
  });
  installedSkills = HOST_CLIENT_IDS.flatMap((client) =>
    readSkillDir(
      getHostSkillsDir(fakeHome, client, null),
      `installed:${client}`,
    ),
  );
});

afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

function allSkillDocuments(): SkillDocument[] {
  return [
    ...readSkillDir(path.join(REPO_ROOT, "skills"), "skills"),
    ...readIntegrationSkills(),
    ...readSkillDir(path.join(REPO_ROOT, "packages", "causoryn", "skills"), "packages/causoryn/skills"),
    ...installedSkills,
  ];
}

describe("shipped skills only use the default core tool profile", () => {
  it("pins the 11-tool core catalog (and the optional history/wiki catalogs) independently of the source", () => {
    expect([...CORE_TOOL_NAMES].sort()).toEqual([...EXPECTED_CORE_TOOLS]);
    expect([...HISTORY_TOOL_NAMES].sort()).toEqual([...EXPECTED_HISTORY_TOOLS]);
    expect([...WIKI_TOOL_NAMES].sort()).toEqual([...EXPECTED_WIKI_TOOLS]);
    expect(Object.keys(CORE_INPUT_SCHEMAS).sort()).toEqual([...EXPECTED_CORE_TOOLS]);
  });

  it("covers the repo skills, the integration copies, and every skill setup installs", () => {
    const repoSkills = readSkillDir(path.join(REPO_ROOT, "skills"), "skills");
    expect(repoSkills.map((doc) => doc.label.split("/")[1]).sort()).toEqual(
      [...CANONICAL_SKILL_NAMES].sort(),
    );
    expect(readIntegrationSkills().map((doc) => doc.label)).toContain(
      "integrations/zcode/causoryn/skills/map-system/SKILL.md",
    );
    expect(installedSkills).toHaveLength(HOST_CLIENT_IDS.length * CANONICAL_SKILL_NAMES.length);
  });

  it("references only core tools unless the line names the --tool-profile that provides the tool", () => {
    const violations = allSkillDocuments().flatMap((doc) => checkToolReferences(doc));
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("uses argument names and values that the core input schemas accept", () => {
    let checked = 0;
    const violations: Violation[] = [];
    for (const doc of allSkillDocuments()) {
      const result = checkToolCallExamples(doc);
      checked += result.checked;
      violations.push(...result.violations);
    }
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    // Every repo skill carries concrete, schema-checked call examples.
    for (const doc of readSkillDir(path.join(REPO_ROOT, "skills"), "skills")) {
      expect(extractToolCallExamples(doc).length, `${doc.label} has no tool-call example`).toBeGreaterThan(0);
    }
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  it("is written in English (Turkish only in the intentional bilingual trigger list of a frontmatter description)", () => {
    const offenders: Violation[] = [];
    for (const doc of allSkillDocuments()) {
      doc.text.split(/\r?\n/).forEach((line, index) => {
        if (/[çğıöşüÇĞİÖŞÜ]/.test(line) && !line.startsWith("description:")) {
          offenders.push({ where: `${doc.label}:${String(index + 1)}`, message: line });
        }
      });
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  it("keeps the ZCode map-system copy byte-identical to the canonical skill", () => {
    const canonical = readFileSync(path.join(REPO_ROOT, "skills", "map-system", "SKILL.md"), "utf8");
    const zcodeCopy = readFileSync(
      path.join(REPO_ROOT, "integrations", "zcode", "causoryn", "skills", "map-system", "SKILL.md"),
      "utf8",
    );
    expect(zcodeCopy).toBe(canonical);
  });
});

describe("skill checker mechanism (synthetic documents)", () => {
  const doc = (text: string): SkillDocument => ({ label: "synthetic", text });

  it("rejects legacy and optional-profile tools on lines that do not name the profile", () => {
    expect(checkToolReferences(doc("Call `causoryn_index_status` first."))).toHaveLength(1);
    expect(checkToolReferences(doc("Use `causoryn_compare_architecture` for git refs."))).toHaveLength(1);
    expect(
      checkToolReferences(doc("`causoryn_compare_architecture` requires `--tool-profile wiki`.")),
    ).toHaveLength(1);
    expect(checkToolReferences(doc("Use `causoryn_tool_that_does_not_exist`."))).toHaveLength(1);
  });

  it("accepts core tools and optional tools whose line names a providing profile", () => {
    expect(checkToolReferences(doc("Call `causoryn_status` then `causoryn_trace`."))).toEqual([]);
    expect(
      checkToolReferences(doc("`causoryn_compare_architecture` requires `--tool-profile history`.")),
    ).toEqual([]);
    expect(
      checkToolReferences(doc("Legacy `causoryn_index_status` exists only under `--tool-profile full`.")),
    ).toEqual([]);
    expect(
      checkToolReferences(doc("Set CAUSORYN_TOOL_PROFILE=wiki,history to use `causoryn_wiki_search`.")),
    ).toEqual([]);
  });

  it("rejects call examples with unknown arguments, bad enum values, or invalid JSON", () => {
    expect(checkToolCallExamples(doc('Call `causoryn_status` `{"action": "rebuild"}`.')).violations).toHaveLength(1);
    expect(
      checkToolCallExamples(doc('Call `causoryn_preflight_change` `{"intent": "x", "includeTestPlan": true}`.'))
        .violations,
    ).toHaveLength(1);
    expect(checkToolCallExamples(doc("Call `causoryn_trace` `{mode: execution}`.")).violations).toHaveLength(1);
    expect(
      checkToolCallExamples(doc('Call `causoryn_get_agent_context` `{"task": "refactor auth"}`.')).violations,
    ).toHaveLength(1);
    const ok = checkToolCallExamples(
      doc('Call `causoryn_get_agent_context` `{"task": "refactor auth", "tokenBudget": 4000}`.'),
    );
    expect(ok).toEqual({ checked: 1, violations: [] });
  });
});
