import { createHash } from "node:crypto";
import path from "node:path";

import { readRegularFileText } from "./fs-guard.js";
import type { CanonicalSkillName } from "./types.js";

/**
 * Ownership of installed skill files (CAU-10, CWE-732).
 *
 * A host skill directory such as `~/.claude/skills/map-system` may hold the
 * user's own skill with the same name. `causoryn setup` replaces and
 * `causoryn setup --uninstall` removes a SKILL.md only when it is provably
 * Causoryn's:
 * - its bytes are recorded in Causoryn's install record (`~/.causoryn/
 *   installed-skills.json`: path + SHA-256 of what setup wrote), or
 * - it is exactly a SKILL.md Causoryn shipped: the one setup would install
 *   now, or one of the versions in {@link SHIPPED_SKILL_SHA256} (every
 *   version in Causoryn's history up to 0.3.2, the last release without the
 *   install record), compared with LF line endings.
 * Anything else, including a Causoryn skill the user edited, is kept.
 */

/** Install record file name below `~/.causoryn`. */
export const SKILL_INSTALL_RECORD_FILE = "installed-skills.json";

/** Largest SKILL.md / install record setup reads (bytes). */
export const SKILL_FILE_MAX_BYTES = 1024 * 1024;

const RECORD_SCHEMA_VERSION = 1;

/**
 * SHA-256 (LF line endings) of every `skills/<name>/SKILL.md` version in
 * Causoryn's history through release 0.3.2 (tags v0.2.0 ... v0.3.2 and the
 * commits between them). Frozen: later versions are proven by the install
 * record that setup writes since then.
 */
const SHIPPED_SKILL_SHA256: Readonly<Record<CanonicalSkillName, readonly string[]>> = {
  causoryn: [
    "bbef8da5e9a0314a3080c41be22635d0807799196b119894ff0b63c6ebfdbe3e", // v0.3.0 - v0.3.2
    "3ce7b7bd89095b7d6d94ae6314c1b5e413bc04983f4881beb3c157a28c6671f9",
    "ca7c8c322676a744600959f109b3e49ccdcb6286a5f13c735ca50634879acdca", // v0.2.4
    "7ab11108aa3e8f9a0d8c17986bf4a7a8cbe1d53fa54eb538cc1af0e810b22a06", // v0.2.3
    "28b3a448a2def0bb4b38fe289672be871caac11ff359ab20f10b5103e6feba0b", // v0.2.2
    "b69ac8d9b55552bd1537aa5c290b6725797db4ca2aedfa79c5af24642a03f893", // v0.2.0 - v0.2.1
  ],
  "map-system": [
    "970367166a2d4e5bb700beb19b2aaf24627478b6687dd1bcfe43e2d31bbab024", // v0.3.0 - v0.3.2
    "2f92e6de1a894c1dc927c0da5f64a2971ffac9152d326650595a7d770cffb8c4",
    "a3a45fd38c3b6132edd6322fcec4cbe36b86e3c712ee387bc6c752f5c0c0af2a", // v0.2.4
    "00ffa842757dff1f76ba6f0853ee3354d95f83efc227370ba651ee36d864dbcd", // v0.2.3
    "62704d2014d22fe34c5d8e98232e40dad77b9a5bfef076ba949276742271426c", // v0.2.0 - v0.2.2
  ],
  "preflight-change": [
    "5c11e093312d73bd8c579c946c6def201bf2fe677251003ab9bf176811fed790", // v0.3.0 - v0.3.2
    "f4bcfce952dfd595569bbda529465feb31d7cdff0cb1401d19f50324a96bcf34",
    "63aa15288d9e48c05301ac09837ceecec028fe3ba4400251a5c3d54008a30a4b", // v0.2.0 - v0.2.4
  ],
  "verify-change": [
    "d29db80dd66a28ad79d91221182220020c2ffe48786bfd63078f737d421e1907", // v0.3.0 - v0.3.2
    "b23baae6412608299433e7e1fc25317c91854c69d6179ea63ed4762571e5123a",
    "74f91c93ed3393adef61c6c3847a7ca12dfce210ee1011df986a4702f15e64ee",
    "18faa208f57ae428b97368ff70a5de0b0cf7bd04dd11fe2309a97e8123ae48f5", // v0.2.0 - v0.2.4
  ],
  "architecture-blueprint": [
    "513aca8ee09ed632df9ec9612e890ffbaea9c8eaad1b1c4a7708aa60e8eebf1b", // v0.3.0 - v0.3.2
    "561924624a829e95ee80ea933b248142d2ee1159d559b90c44fcfb16fb650759",
    "28f7029b8c2aeab361db5e39ab25137419169b1477db85af7d91682b116b56cc",
    "01937fc1212fc3af5308169a6caae0afaa8413e12d054f60760e0d3a212b2774",
    "fb7b8932bbd9dfff777c21f62a74dd6015e5eeab69bc5dcbf3905684342f1bcb", // v0.2.4
    "88fe025f291a80b3cd4fe587e07575855c34342473d1240c584954df92c6ec85", // v0.2.3
    "04df028bd5672d29c3d09680c51b56ec3a1e97ba4c351f8d5fa4646272ba6004", // v0.2.2
  ],
};

/** SHA-256 (hex) of `text` as UTF-8: the bytes setup writes for a skill. */
export function sha256OfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** True when `text` is exactly (LF line endings) a SKILL.md Causoryn shipped for `skillName` up to 0.3.2. */
export function isShippedSkillVersion(skillName: CanonicalSkillName, text: string): boolean {
  return SHIPPED_SKILL_SHA256[skillName].includes(sha256OfText(toLf(text)));
}

/** Comparison key of a recorded path (case-insensitive on Windows). */
function recordKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether the record file could be used as ownership proof. */
export type SkillInstallRecordState = "missing" | "ok" | "unreadable" | "malformed";

/**
 * Causoryn's install record: SKILL.md paths setup wrote and the SHA-256 of
 * the bytes it wrote. Loaded once per run, changed in memory while planning
 * and serialized when it changed.
 */
export class SkillInstallRecord {
  private readonly entries = new Map<string, { readonly path: string; readonly sha256: string }>();
  private dirty = false;

  private constructor(readonly state: SkillInstallRecordState) {}

  /** An empty record that proves nothing (used when the record cannot be trusted). */
  static empty(state: SkillInstallRecordState = "missing"): SkillInstallRecord {
    return new SkillInstallRecord(state);
  }

  /**
   * Reads the record without following links (regular file, bounded). A
   * missing, unreadable or malformed record proves nothing; only well-formed
   * entries are kept.
   */
  static load(recordPath: string): SkillInstallRecord {
    const read = readRegularFileText(recordPath, SKILL_FILE_MAX_BYTES);
    if (read.kind === "missing") return new SkillInstallRecord("missing");
    if (read.kind !== "ok") return new SkillInstallRecord("unreadable");
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      return new SkillInstallRecord("malformed");
    }
    if (
      !isPlainRecord(parsed) ||
      !Object.hasOwn(parsed, "schemaVersion") ||
      parsed["schemaVersion"] !== RECORD_SCHEMA_VERSION ||
      !Object.hasOwn(parsed, "skills") ||
      !Array.isArray(parsed["skills"])
    ) {
      return new SkillInstallRecord("malformed");
    }
    const record = new SkillInstallRecord("ok");
    for (const item of parsed["skills"] as unknown[]) {
      if (!isPlainRecord(item) || !Object.hasOwn(item, "path") || !Object.hasOwn(item, "sha256")) continue;
      const filePath = item["path"];
      const sha256 = item["sha256"];
      if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.includes("\0")) continue;
      if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) continue;
      record.entries.set(recordKey(filePath), { path: path.resolve(filePath), sha256 });
    }
    return record;
  }

  /** Recorded SHA-256 of `filePath`, or undefined. */
  sha256Of(filePath: string): string | undefined {
    return this.entries.get(recordKey(filePath))?.sha256;
  }

  set(filePath: string, sha256: string): void {
    const key = recordKey(filePath);
    if (this.entries.get(key)?.sha256 === sha256) return;
    this.entries.set(key, { path: path.resolve(filePath), sha256 });
    this.dirty = true;
  }

  delete(filePath: string): void {
    if (this.entries.delete(recordKey(filePath))) this.dirty = true;
  }

  get changed(): boolean {
    return this.dirty;
  }

  /** File content for the current entries, or null when there are none (the file is then removed). */
  serialize(): string | null {
    if (this.entries.size === 0) return null;
    const skills = [...this.entries.values()]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((entry) => ({ path: entry.path, sha256: entry.sha256 }));
    return `${JSON.stringify(
      {
        schemaVersion: RECORD_SCHEMA_VERSION,
        description:
          "SKILL.md files written by `causoryn setup` (path and SHA-256 of the bytes written). Setup updates and uninstall removes only these files or files that exactly match a SKILL.md Causoryn shipped.",
        skills,
      },
      null,
      2,
    )}\n`;
  }
}

/** Ownership of an existing SKILL.md (see the module comment). */
export type SkillOwnership = "owned" | "modified" | "foreign";

export function classifySkillOwnership(params: {
  readonly skillName: CanonicalSkillName;
  readonly filePath: string;
  readonly text: string;
  /** The SKILL.md setup would install now (null when the package has none). */
  readonly shippedContent: string | null;
  readonly record: SkillInstallRecord;
}): SkillOwnership {
  const { skillName, filePath, text, shippedContent, record } = params;
  if (shippedContent !== null && toLf(text) === toLf(shippedContent)) return "owned";
  const recorded = record.sha256Of(filePath);
  if (recorded !== undefined && recorded === sha256OfText(text)) return "owned";
  if (isShippedSkillVersion(skillName, text)) return "owned";
  return recorded !== undefined ? "modified" : "foreign";
}
