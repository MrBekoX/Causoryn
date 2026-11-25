/**
 * `CAUSORYN_ASSET_ROOT` validation shared by the published entry points
 * (`scripts/causoryn.mjs mcp` and `scripts/plugin-mcp-launcher.mjs`).
 *
 * The asset root decides where the server loads sidecar worker sources from
 * (`native/`). Unset or blank, it is bound to the entry point's own package.
 * An inherited value (a development override) is kept only when it is an
 * absolute path to an existing directory that holds the same
 * `causoryn@<version>` package with a `native/` directory; anything else is
 * refused so an inherited environment cannot redirect the server to another
 * tree.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * @param {string | undefined} rawValue inherited CAUSORYN_ASSET_ROOT value
 * @param {string} packageRoot the entry point's own package root
 * @param {string} expectedVersion version of that package
 * @returns {{ ok: true, root: string } | { ok: false, reason: string }}
 */
export function resolveAssetRootOverride(rawValue, packageRoot, expectedVersion) {
  const value = rawValue?.trim();
  if (value === undefined || value.length === 0) {
    return { ok: true, root: packageRoot };
  }
  if (!path.isAbsolute(value)) {
    return { ok: false, reason: "must be an absolute path" };
  }
  let resolved;
  try {
    resolved = realpathSync(value);
  } catch {
    return { ok: false, reason: "does not exist" };
  }
  if (!statSync(resolved).isDirectory()) {
    return { ok: false, reason: "is not a directory" };
  }
  let marker;
  try {
    marker = JSON.parse(readFileSync(path.join(resolved, "package.json"), "utf8"));
  } catch {
    return { ok: false, reason: "has no readable package.json" };
  }
  if (
    typeof marker !== "object" ||
    marker === null ||
    marker.name !== "causoryn" ||
    marker.version !== expectedVersion
  ) {
    return { ok: false, reason: `is not the causoryn@${expectedVersion} package` };
  }
  const nativeDir = path.join(resolved, "native");
  if (!existsSync(nativeDir) || !statSync(nativeDir).isDirectory()) {
    return { ok: false, reason: "has no native/ directory" };
  }
  return { ok: true, root: resolved };
}
