/**
 * @causoryn/workspace — Workspace Gateway: WorkspaceAccessPolicy.
 *
 * Sorumluluk alanı (TŞ v2.1 §5 Pipeline + §9 + §19 + §20, Sprint-1 görev 2):
 * trusted root doğrulaması (explicit authorization, default deny),
 * gitignore benzeri minimal ignore eşleme, symlink/junction escape
 * koruması (realpath canonicalization) ve binary/boyut filtreleri.
 * Tüm kararlar deterministiktir; hata kodları TŞ §10.1'e eşlenecek şekilde
 * `workspace/...` ad alanındadır (MCP eşlemesi mcp-server katmanında).
 */

export type {
  PolicyAllow,
  PolicyDecision,
  PolicyDeny,
} from "./workspace-access-policy.js";
export { WorkspaceAccessPolicy } from "./workspace-access-policy.js";

export {
  DEFAULT_BINARY_EXTENSIONS,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_MAX_FILE_BYTES,
  effectiveIgnorePatterns,
  parseWorkspacePolicyConfig,
  workspacePolicyConfigSchema,
} from "./policy-config.js";
export type { ParsedPolicyConfig, WorkspacePolicyConfig } from "./policy-config.js";

export { WorkspacePolicyError } from "./policy-error.js";
export type { PolicyErrorCode } from "./policy-error.js";

export { findMatchingIgnorePattern, matchesIgnorePattern } from "./ignore-matcher.js";
