/**
 * Whether a filesystem path that a web or phone client supplied may be handed
 * to ANY filesystem call (realpath, stat, open, ...). Run it before the first
 * one, and answer a refusal exactly as the route answers a missing file.
 *
 * On Windows the rule is positive, not a blocklist: only a plain
 * drive-absolute path (`C:\...` or `C:/...`) passes. On Windows a lookup on
 * a UNC path (`\\host\share`, `//host/share`, and any mix such as `\/host` or
 * `/\host`) opens an SMB session to the host the path names, and Windows answers
 * that host's challenge with the logged-on user's NTLM response (#1976).
 * The drive-prefix test also refuses, without listing them:
 *
 * - the device and extended prefixes `\\?\`, `\\.\` and `\\?\UNC\`;
 * - the NT object-namespace prefix `\??\`, which starts with ONE separator,
 *   so a "two leading separators" rule alone would let it through;
 * - a rooted path with no drive (`\x`, `/x`) and a drive-relative one (`C:x`).
 *
 * A drive prefix cannot be steered off the drive: `..` stops at the drive's
 * root (`C:\a\..\..\\host\x` is `C:\host\x`), and `?` or `.` after it are
 * plain (invalid) name characters. `path.toNamespacedPath` turns `C:\x` into
 * `\\?\C:\x`, a local path; a client that sends a namespaced form itself
 * fails the drive-prefix test. A drive LETTER that the user mapped to a
 * network share is their own mapping and is out of scope here.
 *
 * Other platforms keep the checks each route already makes; this adds none.
 */
export function isLocalClientPath(raw: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return true;
  return /^[A-Za-z]:[\\/]/.test(raw);
}
