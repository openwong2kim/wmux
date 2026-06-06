/**
 * Working-directory detection helpers shared by PTYBridge.
 *
 * Extracted as pure functions (no Electron / Node deps) so the two
 * notoriously fiddly parsers — OSC 7 URI decoding and prompt-pattern
 * scraping — have direct regression coverage. Both feed the same
 * `IPC.CWD_CHANGED` channel that drives the per-surface cwd shown in the tab
 * tooltip and the workspace "Working directories" menu.
 */

const PROMPT_CWD_RE = /(?:PS\s+([A-Za-z]:\\[^>]*?)>)|(?:\w+@[\w.-]+:([^$]+?)\$)/g;

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
  // Windows drive path by shape: "/C:/Users/me" → "C:\Users\me".
  if (/^\/[A-Za-z]:\//.test(p)) {
    return p.slice(1).replace(/\//g, '\\');
  }
  // Windows UNC path: "/" (host separator) + "//server/share" → "\\server\share".
  if (/^\/\/\//.test(p)) {
    return p.slice(1).replace(/\//g, '\\');
  }
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
export function detectPromptCwd(clean: string): string | null {
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
  const cwd = (last[1] || last[2] || '').trim();
  return cwd || null;
}
