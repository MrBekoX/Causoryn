import { TOOL_PROFILES, type ToolProfile } from "./version.js";

const TOOL_PROFILE_SET: ReadonlySet<string> = new Set<string>(TOOL_PROFILES);

/** Outcome of parsing a single or comma-separated tool profile string. */
export type ToolProfileParseResult =
  | { readonly ok: true; readonly profiles: readonly ToolProfile[] }
  | { readonly ok: false; readonly message: string };

/**
 * Parses a single or comma-separated tool profile string (for example "core",
 * "full", "wiki,history"). Every entry point (the `--tool-profile` flag, the
 * `CAUSORYN_TOOL_PROFILE` environment variable and the `CAUSORYN_CONFIG`
 * `toolProfile` field) validates through this one function, so the accepted
 * values and the error text stay identical. Duplicates are collapsed in
 * first-seen order; an empty entry or an unknown name is rejected.
 */
export function tryParseToolProfile(raw: string): ToolProfileParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      message: `tool profile cannot be empty; valid profiles: ${TOOL_PROFILES.join(", ")}`,
    };
  }
  const profiles: ToolProfile[] = [];
  const seen = new Set<string>();
  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (token.length === 0 || !TOOL_PROFILE_SET.has(token)) {
      return {
        ok: false,
        message: `Invalid tool profile "${token}"; valid profiles: ${TOOL_PROFILES.join(", ")} (or a comma-separated combination)`,
      };
    }
    if (!seen.has(token)) {
      seen.add(token);
      profiles.push(token as ToolProfile);
    }
  }
  return { ok: true, profiles };
}
