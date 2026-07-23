/**
 * Working-directory detection helpers shared by PTYBridge.
 *
 * Extracted as pure functions (no Electron / Node deps) so the two
 * notoriously fiddly parsers — OSC 7 URI decoding and prompt-pattern
 * scraping — have direct regression coverage. Both feed the same
 * `IPC.CWD_CHANGED` channel that drives the per-surface cwd shown in the tab
 * tooltip and the workspace "Working directories" menu.
 */

import { isPlausibleCwd } from '../../shared/cwdShape';

// Three prompt shapes, one per capture group:
//   group 1 — PowerShell:  "PS C:\path>"
//   group 2 — bash/zsh:     "user@host:/path$"  (may carry a git-prompt " (branch)")
//   group 3 — cmd.exe:      "C:\path>"  anchored at line start so a bare Windows
//             path echoed mid-line (docs, `type file.txt`) isn't mistaken for a
//             prompt. cmd has no scriptable prompt hook, so on the daemon spawn
//             path (which injects no OSC 7 hook) scraping is cmd's only cwd signal.
const PROMPT_CWD_RE =
  /(?:PS\s+([A-Za-z]:\\[^>]*?)>)|(?:\w+@[\w.-]+:([^$]+?)\$)|(?:(?:^|[\r\n])([A-Za-z]:\\[^\r\n>]*)>)/g;

/**
 * Normalize an OSC 7 payload (`file://<host>/<path>`) into a native path.
 *
 * The shell hook emits `file://COMPUTERNAME/C:/Users/me` on Windows and
 * `file://host/home/me` on POSIX. The previous one-liner only stripped the
 * scheme+host, leaving Windows paths as `/C:/Users/me` — a leading slash with
 * forward slashes that renders as a broken path in the UI. We instead:
 *   - strip `file://<host>` (host is everything up to the first `/`),
 *   - percent-decode (paths with spaces arrive as `%20`),
 *   - collapse a Windows drive path (`/C:/Users/me` → `C:\Users\me`) by shape,
 *     not by host platform, so the result is correct regardless of where the
 *     code runs and is unit-testable without mocking `process.platform`.
 *   - reconstruct a UNC path: the hook emits a `\\server\share` cwd as
 *     `file://<host>///server/share` (the leading `//` of the UNC becomes the
 *     `///` after the host separator), which we collapse back to
 *     `\\server\share`.
 * POSIX paths (`/home/me`) pass through unchanged.
 */
export function parseOsc7Cwd(data: string): string {
  let p = data.replace(/^file:\/\/[^/]*/, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    // Malformed percent-encoding — keep the raw (still better than dropping it).
  }
  // Windows drive path by shape: "/C:/Users/me" or "/C:\Users\me" → "C:\Users\me".
  // The separator after the drive can be either slash: the pwsh/bash hooks emit
  // forward slashes, but CMD's `PROMPT` hook expands `$P` with native backslashes
  // (…/C:\Users\me), so accept both and normalize any forward slashes to `\`.
  if (/^\/[A-Za-z]:[\\/]/.test(p)) {
    return p.slice(1).replace(/\//g, '\\');
  }
  // Windows UNC path: "/" (host separator) + "//server/share" → "\\server\share".
  if (/^\/\/\//.test(p)) {
    return p.slice(1).replace(/\//g, '\\');
  }
  // Deliberately NOT NFC-normalized here: this value doubles as the split-
  // inheritance spawn seed, and on normalization-SENSITIVE filesystems
  // (Linux ext4; NFS/macFUSE mounts on macOS) the NFC spelling may not name
  // the real directory — validateCwd would reject it and the new pane would
  // fall back to home (Codex review, PR #479). Raw spelling is kept for
  // state/spawning; the DISPLAY boundary (tab tooltip / working-directories
  // menu) normalizes for rendering instead — see displayPath().
  return p;
}

/**
 * Scrape the current working directory from a (already ANSI-stripped) prompt
 * buffer, returning the LAST match or null when no prompt is present.
 *
 * Why the last match, not the first: after `cd`, the buffer routinely holds the
 * echoed command line carrying the OLD prompt (`PS C:\old> cd D:\new`) BEFORE
 * the freshly rendered new prompt (`PS D:\new>`). Taking the first match locked
 * onto the stale cwd — and because the caller clears the buffer on any match,
 * the new prompt was discarded, freezing the reported cwd at the shell's
 * startup directory. The last prompt in the buffer is always the live one.
 */
export function detectPromptCwd(
  clean: string,
  platform: NodeJS.Platform | string = process.platform,
): string | null {
  PROMPT_CWD_RE.lastIndex = 0;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = PROMPT_CWD_RE.exec(clean)) !== null) {
    last = m;
    // Guard against a zero-width match looping forever (defensive; the
    // patterns always consume, but lastIndex hygiene is cheap insurance).
    if (m.index === PROMPT_CWD_RE.lastIndex) PROMPT_CWD_RE.lastIndex++;
  }
  if (!last) return null;
  let cwd = (last[1] || last[2] || last[3] || '').trim();
  if (!cwd) return null;
  // Strip a bash/zsh git-prompt decoration (2026-07-21): a git-aware prompt
  // (`__git_ps1`, default format ` (%s)`) renders "user@host:/path (branch)$",
  // so the `:…$` scrape captures "/path (branch)". Left in, that polluted cwd
  // was previously harmless (a Linux cwd on Windows just fell back to home),
  // but `wsl.exe --cd <cwd>` now uses it verbatim and CreateProcess/chdir fails
  // (ERROR 2) on the non-existent "…/locus (feat/locus-v1)". Only the bash
  // group (last[2]) carries this; PowerShell's `>`-terminated group is left
  // untouched. A real dir literally ending in " (…)" is rarer than a git prompt
  // and would still be recovered by OSC 7 when available.
  if (last[2]) cwd = cwd.replace(/\s+\([^)]*\)$/, '').trimEnd();
  if (!cwd) return null;
  // False-positive guard (2026-07-20): screen text like "PS C:\…>" was mistaken for a
  // prompt and overwrote a POSIX pane's cwd with a Windows path — discard shapes that
  // cannot exist on this platform.
  if (!isPlausibleCwd(cwd, platform)) return null;
  return cwd;
}
