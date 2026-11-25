/**
 * secret-scan — working-tree credential and privacy-leak gate (F-P2-01, K-022).
 *
 * Coverage: every file Git would publish or is about to publish:
 *   - tracked files (`git ls-files --cached`), including files that match an
 *     ignore rule but were force-added, and
 *   - untracked files that are not ignored (`--others --exclude-standard`),
 *     so a leak is caught before `git add`.
 *   `--tracked-only` limits the scan to the index (exactly what a commit of
 *   the current index would contain).
 * Ignored files (`.gitignore`, `.git/info/exclude`, `core.excludesFile`) are
 * not scanned: build outputs (`dist/`, `target/`, `bin/`, `obj/`,
 * `node_modules/`, staged plugin scripts) and local-only directories never
 * reach the repository.
 *
 * Rules live in `scripts/lib/leak-scan.mjs`, shared with the published-tree
 * gate `scripts/export-public-tree.mjs`. Binary files are detected by NUL
 * bytes and scanned through their printable strings; there is no extension
 * allowlist. Optional private terms are read from
 * `.git/info/causoryn-private-terms` (untracked, one term per line) and the
 * `CAUSORYN_PRIVATE_TERMS` environment variable; findings never echo them.
 *
 * SCAN_ROOTS / ROOT_TEXT_FILES are the declared minimum coverage: each must
 * exist, otherwise the gate fails (protects against running from a partial
 * checkout).
 *
 * Exit codes: 0 clean; 1 on any finding, missing declared root, unreadable
 * entry, Git failure or invalid argument (fail-closed).
 */
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatFindings,
  listRepoFiles,
  loadPrivateTerms,
  readWorkingTreeFile,
  scanContent,
} from "./lib/leak-scan.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SCAN_ROOTS = [
  "packages",
  "adapters",
  "apps",
  "native",
  "scripts",
  path.join("integrations", "zcode", "causoryn"),
  path.join("integrations", "zcode", ".claude-plugin"),
  path.join("integrations", "antigravity", "causoryn"),
  ".github",
  ".claude-plugin",
  ".agents",
  "docs",
  "skills",
];

const ROOT_TEXT_FILES = [
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "package.json",
  "marketplace.json",
  "plugin.json",
  "mcp.json",
  "mcp_config.json",
  "server.json",
  ".gitattributes",
  ".gitignore",
];

function parseArgs(argv) {
  let trackedOnly = false;
  for (const arg of argv) {
    if (arg === "--tracked-only") {
      trackedOnly = true;
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  return { trackedOnly };
}

function isExisting(targetPath, kind) {
  try {
    const stat = statSync(targetPath);
    return kind === "dir" ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

function toNative(relPosix) {
  return relPosix.split("/").join(path.sep);
}

function main() {
  const { trackedOnly } = parseArgs(process.argv.slice(2));

  const missingRoots = [
    ...SCAN_ROOTS.filter((root) => !isExisting(path.join(REPO_ROOT, root), "dir")),
    ...ROOT_TEXT_FILES.filter((file) => !isExisting(path.join(REPO_ROOT, file), "file")),
  ];
  if (missingRoots.length > 0) {
    console.error("SECRET_SCAN FAIL — declared root directory/file not found:");
    for (const missing of missingRoots) console.error("  " + missing);
    return 1;
  }

  const privateTerms = loadPrivateTerms({ repoRoot: REPO_ROOT });
  const { files, deleted } = listRepoFiles(REPO_ROOT, { trackedOnly });

  const findings = [];
  const unreadable = [];
  let scannedFiles = 0;
  for (const relPosix of files) {
    let content;
    try {
      content = readWorkingTreeFile(REPO_ROOT, relPosix, deleted);
    } catch (error) {
      unreadable.push(`${toNative(relPosix)} — ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (content === null) continue;
    scannedFiles += 1;
    for (const finding of scanContent(relPosix, content, { privateTerms })) {
      findings.push({
        location: toNative(relPosix) + finding.location.slice(relPosix.length),
        rule: finding.rule,
      });
    }
  }

  if (unreadable.length > 0) {
    console.error("SECRET_SCAN FAIL — entries could not be read (fail-closed):");
    for (const entry of unreadable) console.error("  " + entry);
    return 1;
  }
  if (findings.length > 0) {
    console.error("SECRET_SCAN FAIL — matching lines:");
    for (const line of formatFindings(findings)) console.error("  " + line);
    return 1;
  }
  console.log(
    `SECRET_SCAN PASS — ${String(SCAN_ROOTS.length)} roots scanned (+ ${String(ROOT_TEXT_FILES.length)} root files), ` +
      `${String(scannedFiles)} ${trackedOnly ? "tracked" : "tracked/untracked"} files, ` +
      `${String(privateTerms.length)} private term(s), 0 matches.`,
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`SECRET_SCAN FAIL — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
