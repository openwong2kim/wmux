/**
 * Path link provider — Ctrl+click (mac: Cmd+click) an absolute filesystem path in the
 * terminal to open it in Explorer / Finder / xdg-open.
 *
 * Layered with xterm's existing WebLinksAddon (URLs). Path detection runs
 * line-by-line against `IBufferLine.translateToString(false)`, then is
 * narrowed by `findPathMatches` (pure, unit-tested) so the xterm-coupled
 * surface stays thin.
 *
 * Design notes:
 *   • Only absolute paths are matched. Relative paths require a per-pane
 *     cwd we cannot read reliably, and false positives there are common
 *     (e.g. "foo/bar" in prose).
 *   • POSIX matching is intentionally conservative: anchored at a word
 *     boundary and requires ≥ 1 non-root segment, so `/etc/hosts` matches
 *     but `12:34` (time) or `http://example.com/path` (URL — handled by
 *     WebLinksAddon) do not.
 *   • Trailing punctuation (".,:;!?)]}>\"'`") is trimmed off matches so
 *     "see /etc/hosts." opens "/etc/hosts" not "/etc/hosts.".
 *   • Source-location suffixes like ":42" or ":42:10" are stripped before
 *     opening — Electron's shell.openPath does not understand them and
 *     would otherwise reject the path. The line/column is dropped silently
 *     (future IDE-integration hook can read them back from the raw match).
 */

import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';

export interface PathMatch {
  /** Cleaned-up path (trailing punctuation + line:col suffix removed). */
  text: string;
  /** Inclusive start offset within the line text (0-based). */
  start: number;
  /** Exclusive end offset within the line text (0-based). */
  end: number;
}

/**
 * Bind a path activator to the PTY that produced the terminal output.
 *
 * The path itself is untrusted text. Main uses the PTY identity to resolve the
 * shell domain (host, WSL, MSYS) before deciding how that text maps onto a
 * host-accessible filesystem path.
 */
export function bindPathOpenToPty<TResult>(
  ptyId: string,
  openPath: (filePath: string, ptyId: string) => TResult,
): (filePath: string) => TResult {
  return (filePath) => openPath(filePath, ptyId);
}

/** Trailing characters trimmed off the right edge of a candidate path. */
const TRAILING_PUNCTUATION = /[.,:;!?)\]}>"'`]+$/;

// Trailing numeric/version-shaped suffix. Covers source locations
// (":42", ":42:10") and semver-shaped trailers (":1.2.3"). The class
// `[:.]` lets the second-and-later segments be joined by either `:` or
// `.`, so all of these strip in a single regex match:
//   /foo.ts:42          → /foo.ts
//   /foo.ts:42:10       → /foo.ts
//   /foo.ts:1.2.3       → /foo.ts
// The first separator is required to be `:` so plain filenames with dots
// ("/foo.tar.gz") are not eaten.
const SOURCE_LOCATION_SUFFIX = /:\d+(?:[:.]\d+)*$/;

// Windows drive-letter path: `C:\foo\bar` or `c:/foo/bar`. The negated
// character class blocks the path-illegal Windows characters plus
// whitespace/control so a path embedded in prose ends at the next space.
// no-control-regex is suppressed because matching control bytes is the
// point: any byte < 0x20 ends a path token.
// eslint-disable-next-line no-control-regex
const WINDOWS_DRIVE_PATH = /\b[A-Za-z]:[\\/][^\s"<>|?*\x00-\x1f]+/g;

// UNC share path: `\\server\share\...`. Server + share segments must look
// like hostnames (alnum + dot/hyphen/underscore); everything after is
// treated as path body.
// eslint-disable-next-line no-control-regex
const WINDOWS_UNC_PATH = /\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9._$-]+(?:\\[^\s"<>|?*\x00-\x1f]*)?/g;

// POSIX absolute path: leading `/`, then ≥ 1 segment of non-whitespace.
// Lookbehind anchor keeps it from chewing up the path component of an
// http URL while ensuring the match starts AT the `/` (not at the
// boundary char before it), so the recorded offset lines up with the
// cleaned text. Note: ALSO matches inside double-slashes like `//foo`
// (rare in prose; intentional for protocol-less server paths).
// eslint-disable-next-line no-control-regex
const POSIX_PATH = /(?<=^|[\s"'([<])\/[A-Za-z0-9._~-][^\s"<>|?*\x00-\x1f]*/g;

/**
 * Extract absolute-path matches from a line of terminal text.
 *
 * Returns matches sorted by `start`. Overlapping matches are deduplicated
 * (longer match wins) so a Windows path inside a UNC-shaped string doesn't
 * double-emit.
 */
export function findPathMatches(line: string, platform: NodeJS.Platform): PathMatch[] {
  if (!line) return [];

  const raw: PathMatch[] = [];

  const collect = (regex: RegExp) => {
    // Reset lastIndex defensively — the regex is module-scoped, so a prior
    // partial iteration on another caller's line would otherwise skip
    // matches near the start of this line.
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(line)) !== null) {
      const cleaned = trimPunctuation(m[0]);
      if (cleaned.length === 0) continue;
      raw.push({
        text: cleaned,
        start: m.index,
        end: m.index + cleaned.length,
      });
    }
  };

  if (platform === 'win32') {
    collect(WINDOWS_UNC_PATH);
    collect(WINDOWS_DRIVE_PATH);
  } else {
    // On POSIX hosts, also match Windows-style drive paths when they appear
    // in shared logs / docs. Cheap, no false-positive risk on Unix.
    collect(WINDOWS_DRIVE_PATH);
  }

  // POSIX-shaped matches everywhere — Windows shells routinely print
  // forward-slash paths (git, WSL output, msys tools).
  collect(POSIX_PATH);

  return dedupe(raw);
}

function trimPunctuation(text: string): string {
  // Iterate to a fixed point so wrapped suffixes ("(see /foo.ts:42)") and
  // semver-shaped trailers ("/foo.ts:1.2.3", which SOURCE_LOCATION_SUFFIX
  // peels off one segment at a time) both fully unwrap. Bounded at 8
  // iterations as a defense against pathological input — typical paths
  // converge in 1–2 passes.
  let prev = text;
  for (let i = 0; i < 8; i++) {
    let out = prev.replace(TRAILING_PUNCTUATION, '');
    out = out.replace(SOURCE_LOCATION_SUFFIX, '');
    if (out === prev) return out;
    prev = out;
  }
  return prev;
}

function dedupe(matches: PathMatch[]): PathMatch[] {
  if (matches.length <= 1) return matches.slice();
  const sorted = matches.slice().sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    // Same start → longer match first so the shorter (overlapping) one is
    // dropped by the loop below.
    return b.end - a.end;
  });
  const out: PathMatch[] = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && m.start < last.end) {
      // Overlap. Keep the longer one — already first by sort, so drop `m`.
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * Build an xterm ILinkProvider that opens absolute paths via the provided
 * `openPath` callback (typically `window.electronAPI.shell.openPath`).
 *
 * `platform` selects the matcher set (Windows-aware on win32). Defaults to
 * `process.platform` when available, otherwise 'linux' — which still
 * detects Windows drive paths, just without UNC support.
 */
export function createPathLinkProvider(
  terminal: Terminal,
  openPath: (filePath: string) => void,
  platform: NodeJS.Platform = (typeof process !== 'undefined' && process.platform) || 'linux',
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      // xterm passes 1-based line numbers; getLine wants 0-based.
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      // Soft-wrapped continuation rows are skipped: xterm's link range is
      // single-row, so a path split across rows can't be highlighted as
      // one link. The origin row's matcher only sees its own slice in
      // that case; users who hit this can right-click → copy → paste.
      // The cost of skipping wrap continuation rows is preventing false
      // matches when row N's prefix is the suffix of row N-1's path.
      if (line.isWrapped) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const matches = findPathMatches(text, platform);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      const links: ILink[] = matches.map((match) => ({
        // xterm coordinates are 1-based; range.end is inclusive (the last
        // cell containing the link, not one past it).
        range: {
          start: { x: match.start + 1, y: bufferLineNumber },
          end: { x: match.end, y: bufferLineNumber },
        },
        text: match.text,
        activate: () => openPath(match.text),
      }));
      callback(links);
    },
  };
}
