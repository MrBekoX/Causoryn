/**
 * Lexical UNC and Win32 device path guard (ADR-008 + CWE-22 / SMB NTLM relay defense).
 *
 * MUST be called BEFORE any fs.realpathSync / fs.lstatSync / fs.statSync call.
 * On Windows, resolving a UNC path (`\\host\share`, `//host/share`, `\\?\UNC\...`)
 * via realpathSync/statSync triggers an outbound SMB/NTLM authentication handshake
 * before authorization policies can inspect the resolved path.
 */

const UNC_OR_DEVICE_PREFIX = /^(?:\\\\|\/\/|\/\\|\\\/)/;

/**
 * Returns true if `rawPath` is a UNC network path (`\\host\share`, `//host/share`),
 * Win32 extended/device path (`\\?\...`, `\\.\...`), or mixed-slash network prefix.
 * Purely lexical — performs zero filesystem or network I/O.
 */
export function isUncOrDevicePath(rawPath: string): boolean {
  if (rawPath.length < 2) {
    return false;
  }
  return UNC_OR_DEVICE_PREFIX.test(rawPath);
}

/**
 * Throws an Error with an actionable message if `rawPath` is a UNC or Win32
 * device path. Callers with typed policy errors can check `isUncOrDevicePath`
 * directly before calling `realpathSync` / `lstatSync`.
 */
export function assertNotUncOrDevicePath(rawPath: string, label = "path"): void {
  if (isUncOrDevicePath(rawPath)) {
    throw new Error(
      `Refusing UNC or Win32 device ${label} before filesystem access: ${rawPath}`,
    );
  }
}
