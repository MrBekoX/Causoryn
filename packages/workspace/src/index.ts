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
  IgnoreWorkMeter,
  PolicyAllow,
  PolicyCheckOptions,
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

// Export çıktı yetkilendirmesi — sprint-3 C6 (TŞ §16 "yalnızca explicit
// izinli output dizini"). WorkspaceAccessPolicy'den bilerek bağımsız,
// ayrı beyanlı output kök listesiyle çalışır.
export { OutputAccessPolicy, OutputPolicyError } from "./output-policy.js";
export type {
  OutputAllow,
  OutputDecision,
  OutputDeny,
  OutputPolicyErrorCode,
} from "./output-policy.js";

export {
  compileIgnoreRuleSet,
  findMatchingIgnorePattern,
  IGNORE_MATCH_WORK_BUDGET,
  LOOK_ALIKE_DENY_PATTERNS,
  matchesIgnorePattern,
} from "./ignore-matcher.js";
export type { AncestorIgnoreMatch, IgnoreMatchBudget, IgnoreRuleSet } from "./ignore-matcher.js";

// Descriptor-based bounded reader shared by inventory, contract discovery and
// MCP optional reads (CAU-02 / CAU-05: top-down path verification, the
// authorization decision bound to the opened descriptor's identity).
export { readBoundedTextFile, readBoundedTextFileSync } from "./bounded-file-read.js";
export type {
  BoundedFileReadOptions,
  BoundedFileReadRejection,
  BoundedFileReadResult,
  FileIdentity,
  OpenedFileInfo,
} from "./bounded-file-read.js";

export {
  assertNotUncOrDevicePath,
  describeLinkInspectionFailure,
  describeWindowsPathSegmentIssue,
  findWindowsUnsafePathSegment,
  inspectLinkTargets,
  isUncOrDevicePath,
  isWindowsDriveAbsolutePath,
  LINK_TARGET_INSPECTION_ENABLED,
} from "./path-safety.js";
export type {
  LinkInspectionFs,
  LinkInspectionOptions,
  LinkInspectionResult,
  WindowsPathSegmentFinding,
  WindowsPathSegmentIssue,
} from "./path-safety.js";
