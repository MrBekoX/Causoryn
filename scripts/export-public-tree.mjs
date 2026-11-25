/**
 * export-public-tree — clean open-source tree exporter and published-tree leak
 * gate (F-P0-01, F-P1-02, K-022).
 *
 * What is published:
 * - GitHub: `git push` publishes every blob of the pushed commits, whatever
 *   `.gitattributes` says (`export-ignore` / `export-subst` only affect
 *   `git archive`).
 * - npm: the `packages/causoryn` pack, gated separately by
 *   `packages/causoryn/scripts/verify-package-ready.mjs`.
 *
 * This script therefore reads the committed tree directly (`git ls-tree -r`
 * + `git cat-file --batch`, read-only) instead of `git archive`, so the
 * scanned set is exactly the committed tree: files marked `export-ignore`
 * are scanned and `export-subst` placeholders are not expanded. The private
 * prefixes (`raw/`, `wiki/`, `docs/superpowers/`, internal prompt files and
 * `AGENTS.md`) are left out of the exported tree; with `--verify-temp` (the
 * CI gate for a ref that is pushed as is) a tracked private path is itself a
 * finding, because `git push` would publish it.
 *
 * The exported `.gitignore` / `eslint.config.js` drop the lines between
 * `causoryn-export:local-only begin` / `... end` marker comments
 * (`#` resp. `//`), so local-only tool entries never reach the public tree.
 *
 * Leak rules come from the shared scanner `scripts/lib/leak-scan.mjs`
 * (same rules as `npm run secret-scan`), including optional private terms
 * from `.git/info/causoryn-private-terms` and `CAUSORYN_PRIVATE_TERMS`.
 *
 * Usage:
 *   node scripts/export-public-tree.mjs --out <empty-dir> [--ref HEAD] [--repo <dir>]
 *   node scripts/export-public-tree.mjs --verify-temp [--ref HEAD] [--repo <dir>]
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatFindings, loadPrivateTerms, scanContent } from "./lib/leak-scan.mjs";

const DEFAULT_REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const EXCLUDED_DIR_PREFIXES = ["raw/", "wiki/", "docs/superpowers/"];
const EXCLUDED_EXACT_FILES = new Set([
  "START-PROMPT.md",
  "OPEN-SOURCE-READINESS-PROMPT.md",
  "AGENTS.md",
]);

const REQUIRED_PUBLIC_FILES = [
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "README.md",
  "CHANGELOG.md",
  "server.json",
  ".gitattributes",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  "packages/causoryn/package.json",
];

/** Files whose local-only marker blocks are stripped, with their comment prefix. */
const LOCAL_ONLY_BLOCK_FILES = new Map([
  [".gitignore", "#"],
  ["eslint.config.js", "//"],
]);
const LOCAL_ONLY_BEGIN = "causoryn-export:local-only begin";
const LOCAL_ONLY_END = "causoryn-export:local-only end";

const SAFE_GIT_REF_RE = /^(?!-)[A-Za-z0-9._/@~-]+$/;
const MAX_GIT_OUTPUT = 512 * 1024 * 1024;

function isExcludedRelPath(relPosix) {
  if (EXCLUDED_EXACT_FILES.has(relPosix)) return true;
  return EXCLUDED_DIR_PREFIXES.some(
    (prefix) => relPosix === prefix.slice(0, -1) || relPosix.startsWith(prefix),
  );
}

function git(repoRoot, args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    maxBuffer: MAX_GIT_OUTPUT,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
}

/** Committed tree entries of `ref` as `{ mode, type, oid, relPosix }`. */
function readTreeEntries(repoRoot, ref) {
  const treeOid = git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{tree}`])
    .toString("utf8")
    .trim();
  if (!/^[0-9a-f]{40,64}$/.test(treeOid)) {
    throw new Error(`Could not resolve Git ref to a tree (fail-closed): ${ref}`);
  }
  return git(repoRoot, ["ls-tree", "-r", "-z", "--full-tree", treeOid])
    .toString("utf8")
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => {
      const tab = record.indexOf("\t");
      const [mode = "", type = "", oid = ""] = record.slice(0, tab).split(" ");
      return { mode, type, oid, relPosix: record.slice(tab + 1) };
    });
}

/** Blob contents for `oids` via one `git cat-file --batch` call. */
function readBlobs(repoRoot, oids) {
  const unique = [...new Set(oids)];
  const blobs = new Map();
  if (unique.length === 0) return blobs;
  const out = git(repoRoot, ["cat-file", "--batch"], { input: `${unique.join("\n")}\n` });
  let pos = 0;
  for (const oid of unique) {
    const newline = out.indexOf(0x0a, pos);
    if (newline < 0) throw new Error(`git cat-file output truncated at ${oid}`);
    const [headerOid, headerType, headerSize] = out.toString("utf8", pos, newline).split(" ");
    const size = Number(headerSize);
    const start = newline + 1;
    const end = start + size;
    if (
      headerOid !== oid ||
      headerType !== "blob" ||
      !Number.isSafeInteger(size) ||
      end >= out.length ||
      out[end] !== 0x0a
    ) {
      throw new Error(`git cat-file returned an unexpected record for ${oid} (fail-closed)`);
    }
    blobs.set(oid, out.subarray(start, end));
    pos = end + 1;
  }
  return blobs;
}

/** Tree paths must stay inside the output directory on every platform. */
function isSafeTreePath(relPosix) {
  return relPosix.split("/").every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      segment.toLowerCase() !== ".git" &&
      !/[\\:]/.test(segment) &&
      ![...segment].some((char) => char.charCodeAt(0) < 0x20),
  );
}

/**
 * Removes the lines between local-only marker comments. Unbalanced markers
 * fail closed instead of exporting a half-sanitized file.
 */
function stripLocalOnlyBlocks(relPosix, buffer, commentPrefix) {
  const text = buffer.toString("utf8");
  const begin = `${commentPrefix} ${LOCAL_ONLY_BEGIN}`;
  const end = `${commentPrefix} ${LOCAL_ONLY_END}`;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const kept = [];
  let inBlock = false;
  let changed = false;
  for (const line of text.split(/\r?\n/)) {
    const normalized = line.trim().replace(/\s+/g, " ");
    if (normalized === begin) {
      if (inBlock) throw new Error(`nested local-only block in ${relPosix}`);
      inBlock = true;
      changed = true;
      continue;
    }
    if (normalized === end) {
      if (!inBlock) throw new Error(`local-only end marker without begin in ${relPosix}`);
      inBlock = false;
      continue;
    }
    if (!inBlock) kept.push(line);
  }
  if (inBlock) throw new Error(`unterminated local-only block in ${relPosix}`);
  return changed ? Buffer.from(kept.join(eol), "utf8") : buffer;
}

function walkExportedTree(rootDir, relDir, files, special) {
  const absDir = relDir ? path.join(rootDir, ...relDir.split("/")) : rootDir;
  for (const name of readdirSync(absDir).sort()) {
    const relPosix = relDir ? `${relDir}/${name}` : name;
    const stat = lstatSync(path.join(absDir, name));
    if (stat.isDirectory()) {
      walkExportedTree(rootDir, relPosix, files, special);
    } else if (stat.isFile()) {
      files.push(relPosix);
    } else {
      special.push(relPosix);
    }
  }
}

/**
 * Verifies an exported public tree (fail-closed).
 *
 * @param {string} exportedDir
 * @param {{ privateTerms?: readonly string[] }} [options]
 * @returns {{ ok: boolean, findings: string[], fileCount: number }}
 */
export function verifyPublicTree(exportedDir, options = {}) {
  const findings = [];
  if (!existsSync(exportedDir) || !statSync(exportedDir).isDirectory()) {
    return {
      ok: false,
      findings: [`target directory does not exist: ${exportedDir}`],
      fileCount: 0,
    };
  }
  const privateTerms = options.privateTerms ?? loadPrivateTerms();

  for (const requiredRel of REQUIRED_PUBLIC_FILES) {
    const full = path.join(exportedDir, ...requiredRel.split("/"));
    if (!existsSync(full) || !lstatSync(full).isFile()) {
      findings.push(`missing required open-source file: ${requiredRel}`);
    }
  }

  const files = [];
  const special = [];
  walkExportedTree(exportedDir, "", files, special);
  for (const relPosix of special) {
    findings.push(`unsupported entry in export (not a regular file): ${relPosix}`);
  }

  const leakFindings = [];
  for (const relPosix of files) {
    if (isExcludedRelPath(relPosix)) {
      findings.push(`excluded path leaked into export: ${relPosix}`);
      continue;
    }
    let content;
    try {
      content = readFileSync(path.join(exportedDir, ...relPosix.split("/")));
    } catch (error) {
      findings.push(
        `unreadable file in export: ${relPosix} (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    leakFindings.push(...scanContent(relPosix, content, { privateTerms }));
  }
  findings.push(...formatFindings(leakFindings));

  return {
    ok: findings.length === 0,
    findings,
    fileCount: files.length + special.length,
  };
}

/**
 * Exports the committed tree of a Git ref (minus private paths) into an empty
 * directory and verifies it fail-closed.
 *
 * @param {{ repoRoot?: string, outDir: string, ref?: string, rejectTrackedPrivatePaths?: boolean }} options
 * @returns {{ outDir: string, ref: string, exportedFiles: string[], verification: { ok: boolean, findings: string[], fileCount: number } }}
 */
export function exportPublicTree(options) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const outDir = path.resolve(options.outDir);
  const ref = options.ref ?? "HEAD";
  const rejectTrackedPrivatePaths = options.rejectTrackedPrivatePaths === true;

  if (typeof ref !== "string" || !SAFE_GIT_REF_RE.test(ref) || ref.includes("..")) {
    throw new Error(`Rejected invalid Git ref (fail-closed): ${String(ref)}`);
  }

  if (existsSync(outDir)) {
    if (!statSync(outDir).isDirectory()) {
      throw new Error(`Target path is not a directory: ${outDir}`);
    }
    if (readdirSync(outDir).length > 0) {
      throw new Error(`Target output directory must be empty (fail-closed): ${outDir}`);
    }
  } else {
    mkdirSync(outDir, { recursive: true });
  }

  const entries = readTreeEntries(repoRoot, ref);
  const problems = [];
  const toExport = [];
  for (const entry of entries) {
    if (!isSafeTreePath(entry.relPosix)) {
      problems.push(`unsafe tree path: ${JSON.stringify(entry.relPosix)}`);
      continue;
    }
    if (isExcludedRelPath(entry.relPosix)) {
      if (rejectTrackedPrivatePaths) {
        problems.push(`private path tracked in ref: ${entry.relPosix}`);
      }
      continue;
    }
    if (entry.type === "commit") {
      problems.push(`unsupported tree entry (submodule): ${entry.relPosix}`);
    } else if (entry.type !== "blob") {
      problems.push(`unsupported tree entry (${entry.type}): ${entry.relPosix}`);
    } else if (entry.mode === "120000") {
      problems.push(`unsupported tree entry (symbolic link): ${entry.relPosix}`);
    } else if (entry.mode !== "100644" && entry.mode !== "100755") {
      problems.push(`unsupported tree entry (mode ${entry.mode}): ${entry.relPosix}`);
    } else {
      toExport.push(entry);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `PUBLIC_EXPORT FAIL — tree check failed (${String(problems.length)} finding(s)):\n` +
        problems.map((problem) => `  - ${problem}`).join("\n"),
    );
  }

  const blobs = readBlobs(
    repoRoot,
    toExport.map((entry) => entry.oid),
  );
  for (const entry of toExport) {
    let content = blobs.get(entry.oid);
    if (content === undefined) {
      throw new Error(`Missing blob for ${entry.relPosix} (fail-closed)`);
    }
    const commentPrefix = LOCAL_ONLY_BLOCK_FILES.get(entry.relPosix);
    if (commentPrefix !== undefined) {
      content = stripLocalOnlyBlocks(entry.relPosix, content, commentPrefix);
    }
    const target = path.join(outDir, ...entry.relPosix.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    // "wx": never overwrite (a case-insensitive path collision fails closed).
    writeFileSync(target, content, { flag: "wx", mode: entry.mode === "100755" ? 0o755 : 0o644 });
  }

  const verification = verifyPublicTree(outDir, {
    privateTerms: loadPrivateTerms({ repoRoot }),
  });
  if (!verification.ok) {
    throw new Error(
      `PUBLIC_EXPORT FAIL — verification failed (${String(verification.findings.length)} finding(s)):\n` +
        verification.findings.map((finding) => `  - ${finding}`).join("\n"),
    );
  }

  return {
    outDir,
    ref,
    exportedFiles: toExport.map((entry) => entry.relPosix).sort(),
    verification,
  };
}

function parseCliArgs(argv) {
  let outDir = "";
  let ref = "HEAD";
  let repoRoot = DEFAULT_REPO_ROOT;
  let verifyTemp = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      outDir = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--ref") {
      ref = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--repo") {
      repoRoot = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--verify-temp") {
      verifyTemp = true;
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }

  if (verifyTemp && outDir) {
    throw new Error("--verify-temp and --out cannot be used together.");
  }
  if (!verifyTemp && !outDir) {
    throw new Error("Missing required --out <empty-target-dir> or --verify-temp option.");
  }

  return { outDir, ref, repoRoot, verifyTemp };
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  let tempDir = "";
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    if (cli.verifyTemp) {
      tempDir = mkdtempSync(path.join(os.tmpdir(), "causoryn-export-gate-"));
    }
    const targetOutDir = cli.verifyTemp ? tempDir : cli.outDir;
    const result = exportPublicTree({
      repoRoot: cli.repoRoot,
      outDir: targetOutDir,
      ref: cli.ref,
      rejectTrackedPrivatePaths: cli.verifyTemp,
    });
    console.log(
      `PUBLIC_EXPORT PASS — ref=${result.ref}, ${String(result.exportedFiles.length)} file(s) exported clean → ${result.outDir}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
