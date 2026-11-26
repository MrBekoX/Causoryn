import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CANONICAL_SKILL_NAMES, type CliIo } from "../../src/index.js";

/**
 * Isolated sandboxes for `causoryn setup` / `doctor` tests: a fake home, a
 * fake Codex home and a fake `causoryn` package under `os.tmpdir()`. No test
 * using these helpers touches the real user's host configuration.
 */

const createdRoots: string[] = [];

export interface SetupSandbox {
  readonly root: string;
  readonly home: string;
  readonly codexHome: string;
  /** A directory that is never the package's parent: passing it as `ephemeralTmpDir` disables runtime staging. */
  readonly notTmp: string;
}

export function createSetupSandbox(prefix: string): SetupSandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), `causoryn-sec-${prefix}-`));
  createdRoots.push(root);
  const home = path.join(root, "home");
  mkdirSync(home, { recursive: true });
  const notTmp = path.join(root, "not-tmp");
  mkdirSync(notTmp, { recursive: true });
  return { root, home, codexHome: path.join(home, ".codex"), notTmp };
}

export function removeSetupSandboxes(): void {
  while (createdRoots.length > 0) {
    const dir = createdRoots.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes a minimal stageable `causoryn` package whose skills have the given bodies. */
export function writeFakePackage(
  dir: string,
  skillBody: (skillName: string) => string,
): string {
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "dist"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "causoryn", version: "0.3.2" }), "utf8");
  writeFileSync(path.join(dir, "scripts", "causoryn.mjs"), "#!/usr/bin/env node\n", "utf8");
  writeFileSync(path.join(dir, "dist", "mcp-server.mjs"), "// bundle\n", "utf8");
  for (const skillName of CANONICAL_SKILL_NAMES) {
    const skillDir = path.join(dir, "skills", skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), skillBody(skillName), "utf8");
  }
  return dir;
}

/** A Causoryn-looking skill body: front matter names the skill and the text mentions Causoryn. */
export function causorynSkillBody(release: string): (skillName: string) => string {
  return (skillName) =>
    `---\nname: ${skillName}\ndescription: Causoryn ${release} routing skill for ${skillName}\n---\n\nUse the causoryn MCP tools (${release}).\n`;
}

export interface CapturedIo {
  readonly io: CliIo;
  stdout(): string;
  stderr(): string;
}

export function captureIo(): CapturedIo {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      isInteractive: false,
    },
    stdout: () => out,
    stderr: () => err,
  };
}
