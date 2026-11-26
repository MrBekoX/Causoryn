import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { CANONICAL_SKILL_NAMES, runCli, runSetup, type SetupAction } from "../src/index.js";
import {
  captureIo,
  causorynSkillBody,
  createSetupSandbox,
  removeSetupSandboxes,
  writeFakePackage,
  type SetupSandbox,
} from "./helpers/setup-sandbox.js";

/**
 * CAU-10 (CWE-732): a SKILL.md that has a canonical Causoryn skill name but
 * was not written by Causoryn (or was changed by the user after Causoryn
 * wrote it) is never overwritten by `causoryn setup` and never removed by
 * `causoryn setup --uninstall`. Ownership is proven by Causoryn's install
 * record (path + SHA-256 of the bytes it wrote) or by content that is
 * exactly a SKILL.md Causoryn shipped (current or an earlier release).
 */

afterEach(() => {
  removeSetupSandboxes();
});

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
/** `skills/preflight-change/SKILL.md` exactly as Causoryn 0.3.2 shipped it. */
const LEGACY_PREFLIGHT_0_3_2 = readFileSync(
  path.join(TEST_DIR, "fixtures", "legacy-skills", "preflight-change-v0.3.2.md.txt"),
  "utf8",
);

function zcodeSkillFile(sb: SetupSandbox, skillName: string): string {
  return path.join(sb.home, ".zcode", "skills", skillName, "SKILL.md");
}

function skillAction(actions: readonly SetupAction[], skillName: string): SetupAction {
  const action = actions.find(
    (a) => a.kind === "skill" && path.basename(path.dirname(a.targetPath)) === skillName,
  );
  if (action === undefined) throw new Error(`no skill action for ${skillName}`);
  return action;
}

function baseOptions(sb: SetupSandbox, packageRoot: string) {
  return {
    homeDir: sb.home,
    codexHomeDir: sb.codexHome,
    packageRoot,
    ephemeralTmpDir: sb.notTmp,
    clients: ["zcode"] as const,
    yes: true,
  };
}

describe("CAU-10: setup only upgrades skills Causoryn owns", () => {
  it("upgrades every skill Causoryn installed to the newly shipped version", async () => {
    const sb = createSetupSandbox("own-upgrade");
    const v1 = writeFakePackage(path.join(sb.root, "pkg-v1"), causorynSkillBody("v1"));
    const v2 = writeFakePackage(path.join(sb.root, "pkg-v2"), causorynSkillBody("v2"));

    await runSetup({ ...baseOptions(sb, v1), clients: ["zcode"] });
    const res = await runSetup({ ...baseOptions(sb, v2), clients: ["zcode"] });

    for (const skillName of CANONICAL_SKILL_NAMES) {
      expect(readFileSync(zcodeSkillFile(sb, skillName), "utf8")).toBe(causorynSkillBody("v2")(skillName));
      expect(skillAction(res.actions, skillName).operation).toBe("update");
    }
  });

  it("keeps a foreign SKILL.md with a canonical name byte-identical on setup and on uninstall, and says so", async () => {
    const sb = createSetupSandbox("foreign");
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
    // The user's own skill: same directory name, front matter names it, and it mentions causoryn.
    const foreign = "---\nname: map-system\n---\nMy own map-system notes; I sometimes use causoryn too.\n";
    mkdirSync(path.dirname(zcodeSkillFile(sb, "map-system")), { recursive: true });
    writeFileSync(zcodeSkillFile(sb, "map-system"), foreign, "utf8");

    const res = await runSetup({ ...baseOptions(sb, pkg), clients: ["zcode"] });
    expect(readFileSync(zcodeSkillFile(sb, "map-system"), "utf8")).toBe(foreign);
    const action = skillAction(res.actions, "map-system");
    expect(action.operation).toBe("noop");
    expect(action.detail).toMatch(/not created by Causoryn/);
    expect(action.detail).toMatch(/not installed/);
    // The other skills are installed as usual.
    expect(readFileSync(zcodeSkillFile(sb, "causoryn"), "utf8")).toBe(causorynSkillBody("v1")("causoryn"));

    const uninstall = await runSetup({ ...baseOptions(sb, pkg), clients: ["zcode"], uninstall: true });
    expect(readFileSync(zcodeSkillFile(sb, "map-system"), "utf8")).toBe(foreign);
    expect(skillAction(uninstall.actions, "map-system").detail).toMatch(/not created by Causoryn/);
    expect(existsSync(zcodeSkillFile(sb, "causoryn"))).toBe(false);
  });

  it("prints the skipped-skill warning in the CLI setup text output", async () => {
    const sb = createSetupSandbox("foreign-cli");
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
    const foreign = "---\nname: verify-change\n---\nMine.\n";
    mkdirSync(path.dirname(zcodeSkillFile(sb, "verify-change")), { recursive: true });
    writeFileSync(zcodeSkillFile(sb, "verify-change"), foreign, "utf8");

    const cap = captureIo();
    const exitCode = await runCli(["setup", "--client", "zcode", "--yes"], {
      io: cap.io,
      homeDir: sb.home,
      codexHomeDir: sb.codexHome,
      packageRoot: pkg,
      ephemeralTmpDir: sb.notTmp,
    });
    expect(exitCode).toBe(0);
    expect(cap.stdout()).toMatch(/verify-change.*not created by Causoryn/);
    expect(readFileSync(zcodeSkillFile(sb, "verify-change"), "utf8")).toBe(foreign);
  });

  it("preserves a skill the user changed after Causoryn installed it (setup and uninstall)", async () => {
    const sb = createSetupSandbox("modified");
    const v1 = writeFakePackage(path.join(sb.root, "pkg-v1"), causorynSkillBody("v1"));
    const v2 = writeFakePackage(path.join(sb.root, "pkg-v2"), causorynSkillBody("v2"));
    await runSetup({ ...baseOptions(sb, v1), clients: ["zcode"] });

    const edited = `${causorynSkillBody("v1")("map-system")}\nMy local edit.\n`;
    writeFileSync(zcodeSkillFile(sb, "map-system"), edited, "utf8");

    const res = await runSetup({ ...baseOptions(sb, v2), clients: ["zcode"] });
    expect(readFileSync(zcodeSkillFile(sb, "map-system"), "utf8")).toBe(edited);
    const action = skillAction(res.actions, "map-system");
    expect(action.operation).toBe("noop");
    expect(action.detail).toMatch(/changed after Causoryn installed it/);
    expect(readFileSync(zcodeSkillFile(sb, "causoryn"), "utf8")).toBe(causorynSkillBody("v2")("causoryn"));

    const uninstall = await runSetup({ ...baseOptions(sb, v2), clients: ["zcode"], uninstall: true });
    expect(readFileSync(zcodeSkillFile(sb, "map-system"), "utf8")).toBe(edited);
    expect(skillAction(uninstall.actions, "map-system").detail).toMatch(/changed after Causoryn installed it/);
    expect(existsSync(zcodeSkillFile(sb, "causoryn"))).toBe(false);
  });

  it("upgrades and uninstalls a legacy install (exact 0.3.2 content, no install record), also with CRLF line endings", async () => {
    for (const eol of ["\n", "\r\n"] as const) {
      const sb = createSetupSandbox(`legacy-${eol === "\n" ? "lf" : "crlf"}`);
      const legacy = LEGACY_PREFLIGHT_0_3_2.replace(/\r?\n/g, eol);
      const next = writeFakePackage(path.join(sb.root, "pkg-next"), causorynSkillBody("next"));

      mkdirSync(path.dirname(zcodeSkillFile(sb, "preflight-change")), { recursive: true });
      writeFileSync(zcodeSkillFile(sb, "preflight-change"), legacy, "utf8");
      const res = await runSetup({ ...baseOptions(sb, next), clients: ["zcode"] });
      expect(skillAction(res.actions, "preflight-change").operation).toBe("update");
      expect(readFileSync(zcodeSkillFile(sb, "preflight-change"), "utf8")).toBe(
        causorynSkillBody("next")("preflight-change"),
      );

      // A legacy file left from an old install is removed by uninstall as well.
      writeFileSync(zcodeSkillFile(sb, "preflight-change"), legacy, "utf8");
      const uninstall = await runSetup({ ...baseOptions(sb, next), clients: ["zcode"], uninstall: true });
      expect(skillAction(uninstall.actions, "preflight-change").operation).toBe("remove");
      expect(existsSync(zcodeSkillFile(sb, "preflight-change"))).toBe(false);
    }
  });

  it("does not treat another skill's shipped content as this skill's", async () => {
    const sb = createSetupSandbox("legacy-other-name");
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("next"));
    mkdirSync(path.dirname(zcodeSkillFile(sb, "verify-change")), { recursive: true });
    writeFileSync(zcodeSkillFile(sb, "verify-change"), LEGACY_PREFLIGHT_0_3_2, "utf8");

    const res = await runSetup({ ...baseOptions(sb, pkg), clients: ["zcode"] });
    expect(skillAction(res.actions, "verify-change").operation).toBe("noop");
    expect(readFileSync(zcodeSkillFile(sb, "verify-change"), "utf8")).toBe(LEGACY_PREFLIGHT_0_3_2);
  });

  it("removes nothing when a skill changes while the uninstall confirmation is pending", async () => {
    const sb = createSetupSandbox("toctou-uninstall");
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
    await runSetup({ ...baseOptions(sb, pkg), clients: ["zcode"] });
    const edited = `${causorynSkillBody("v1")("causoryn")}\nEdited during the prompt.\n`;

    await expect(
      runSetup({
        ...baseOptions(sb, pkg),
        clients: ["zcode"],
        uninstall: true,
        yes: false,
        confirm: () => {
          writeFileSync(zcodeSkillFile(sb, "causoryn"), edited, "utf8");
          return true;
        },
      }),
    ).rejects.toThrow(/changed while setup was running/);
    expect(readFileSync(zcodeSkillFile(sb, "causoryn"), "utf8")).toBe(edited);
    // Fail before any mutation: the other skills are still installed.
    expect(existsSync(zcodeSkillFile(sb, "map-system"))).toBe(true);
  });

  it("installs once when two hosts share one skills directory (CLAUDE_CONFIG_DIR = ~/.agents, Codex ~/.agents/skills)", async () => {
    const sb = createSetupSandbox("shared-skills-dir");
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
    const res = await runSetup({
      ...baseOptions(sb, pkg),
      claudeConfigDir: path.join(sb.home, ".agents"),
      clients: ["claude-code", "codex"],
    });
    expect(res.applied).toBe(true);
    for (const skillName of CANONICAL_SKILL_NAMES) {
      expect(readFileSync(path.join(sb.home, ".agents", "skills", skillName, "SKILL.md"), "utf8")).toBe(
        causorynSkillBody("v1")(skillName),
      );
    }
  });

  it("never renames over a skill path that was absent while planning (no-clobber publish)", async () => {
    const sb = createSetupSandbox("no-clobber");
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
    const target = zcodeSkillFile(sb, "causoryn");
    const foreign = "---\nname: causoryn\n---\nPlanted right before the rename.\n";
    let planted = false;
    await runSetup({
      ...baseOptions(sb, pkg),
      clients: ["zcode"],
      renameFile: (from, to) => {
        if (path.resolve(String(to)) === path.resolve(target)) {
          // Simulates a file appearing between the last check and the publish.
          writeFileSync(target, foreign, "utf8");
          planted = true;
        }
        renameSync(from, to);
      },
    }).catch(() => undefined);
    const clobbered = planted && readFileSync(target, "utf8") !== foreign;
    expect(clobbered).toBe(false);
  });

  it("overwrites nothing when a foreign skill appears while the setup confirmation is pending", async () => {
    const sb = createSetupSandbox("toctou-setup");
    const pkg = writeFakePackage(path.join(sb.root, "pkg"), causorynSkillBody("v1"));
    const foreign = "---\nname: causoryn\n---\nWritten by someone else.\n";

    await expect(
      runSetup({
        ...baseOptions(sb, pkg),
        clients: ["zcode"],
        yes: false,
        confirm: () => {
          mkdirSync(path.dirname(zcodeSkillFile(sb, "causoryn")), { recursive: true });
          writeFileSync(zcodeSkillFile(sb, "causoryn"), foreign, "utf8");
          return true;
        },
      }),
    ).rejects.toThrow(/changed while setup was running/);
    expect(readFileSync(zcodeSkillFile(sb, "causoryn"), "utf8")).toBe(foreign);
    // Fail before any mutation: the ZCode config was not written either.
    expect(existsSync(path.join(sb.home, ".zcode", "cli", "config.json"))).toBe(false);
  });
});
