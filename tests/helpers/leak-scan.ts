import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Typed loader for the shared leak scanner (`scripts/lib/leak-scan.mjs`),
 * used by the secret-scan, public-export and documentation privacy tests.
 */

export interface LeakFinding {
  readonly location: string;
  readonly rule: string;
}

export interface LeakScanModule {
  readonly PRIVATE_TERMS_ENV: string;
  readonly PRIVATE_TERMS_GIT_PATH: string;
  readonly scanContent: (
    relPosix: string,
    content: Buffer | string,
    options?: { readonly privateTerms?: readonly string[] },
  ) => LeakFinding[];
  readonly countUserProfilePaths: (line: string) => number;
  readonly countLocalDrivePaths: (line: string) => number;
  readonly isDocumentLikePath: (relPosix: string) => boolean;
  readonly parsePrivateTerms: (raw: string, sourceLabel: string) => string[];
  readonly loadPrivateTerms: (options?: {
    readonly repoRoot?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  }) => string[];
}

export const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

export const LEAK_SCAN_MODULE_PATH = path.join(REPO_ROOT, "scripts", "lib", "leak-scan.mjs");

export async function loadLeakScan(): Promise<LeakScanModule> {
  return (await import(pathToFileURL(LEAK_SCAN_MODULE_PATH).href)) as LeakScanModule;
}

/**
 * Privacy findings (user-profile paths, local drive paths, private terms)
 * for a repository document. Private terms come from the local untracked
 * term file and `CAUSORYN_PRIVATE_TERMS`; secret rules are ignored here.
 */
let cachedPrivateTerms: readonly string[] | undefined;

export async function findDocumentPrivacyLeaks(relPosix: string, text: string): Promise<string[]> {
  const scanner = await loadLeakScan();
  cachedPrivateTerms ??= scanner.loadPrivateTerms({ repoRoot: REPO_ROOT });
  const privateTerms = cachedPrivateTerms;
  return scanner
    .scanContent(relPosix, text, { privateTerms })
    .filter(
      (finding) =>
        finding.rule === "local-user-profile-path" ||
        finding.rule === "local-drive-path" ||
        finding.rule.startsWith("private-term-"),
    )
    .map((finding) => `${finding.location} — ${finding.rule}`);
}
