/**
 * Path link provider — Ctrl+click (mac: Cmd+click) an absolute filesystem path in the
 * terminal to open it in Explorer / Finder / xdg-open.
 *
 * Layered with xterm's existing WebLinksAddon (URLs). Path detection runs per
 * logical line (the rows a soft wrap joins), then is narrowed by
 * `findPathMatches` (pure, unit-tested) so the xterm-coupled surface stays
 * thin.
 *
 * Design notes:
 *   • Absolute paths and `file://` URLs always match. Relative paths match
 *     only with a `./` / `../` prefix or as `dir/name.ext`; the click handler
 *     resolves them against the pane cwd and does nothing when it is unknown.
 *   • POSIX matching is intentionally conservative: anchored at a word
 *     boundary and requires ≥ 1 non-root segment, so `/etc/hosts` matches
 *     but `12:34` (time) or `http://example.com/path` (URL — handled by
 *     WebLinksAddon) do not.
 *   • Trailing punctuation (".,:;!?)]}>\"'`") is trimmed off matches so
 *     "see /etc/hosts." opens "/etc/hosts" not "/etc/hosts.".
 *   • Source-location suffixes like ":42" or ":42:10" are stripped from the
 *     path (shell.openPath would reject them) and reported separately as
 *     `line` / `col` so an in-app viewer can scroll to them.
 */

import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm';

export interface PathMatch {
  /** Cleaned-up path (trailing punctuation + line:col suffix removed). */
  text: string;
  /** Inclusive start offset within the line text (0-based). */
  start: number;
  /**
   * Exclusive end offset within the line text (0-based). Covers a recognised
   * `:line[:col]` suffix, so the underline/hit area includes it even though
   * `text` does not.
   */
  end: number;
  /** 1-based line from a `:42` / `:42:10` suffix, when the match had one. */
  line?: number;
  /** 1-based column from a `:42:10` suffix. */
  col?: number;
}

/** Where a clicked path should land, parsed from its `:line:col` suffix. */
export interface PathLocation {
  line?: number;
  col?: number;
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

// Strict `:line` / `:line:col` tail. Unlike SOURCE_LOCATION_SUFFIX it does not
// accept semver-shaped trailers, so ":1.2.3" never yields a line number.
const LINE_COL_TAIL = /:(\d+)(?::(\d+))?$/;

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

// `file://` URLs. WebLinksAddon only knows http(s), so these are ours.
// eslint-disable-next-line no-control-regex
const FILE_URL = /(?<=^|[\s"'([<])file:\/\/[^\s"<>|*\x00-\x1f]+/gi;

// Relative paths, kept conservative to avoid prose false positives: either an
// explicit `./` / `../` prefix, or `dir/.../name.ext` whose first segment has
// no dot (so `example.com/x.html` and bare words never match) and whose last
// segment carries a short extension.
// eslint-disable-next-line no-control-regex
const RELATIVE_PREFIXED = /(?<=^|[\s"'([<])\.{1,2}[\\/][^\s"<>|?*\x00-\x1f]+/g;
// eslint-disable-next-line no-control-regex
const RELATIVE_BARE = /(?<=^|[\s"'([<])\.?[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._@+-]+)*\/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?(?![A-Za-z0-9._/\\-])/g;

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
      const { text: cleaned, spanLength, line: ln, col } = trimPunctuation(m[0]);
      if (cleaned.length === 0) continue;
      raw.push({
        text: cleaned,
        start: m.index,
        end: m.index + spanLength,
        ...(ln !== undefined && { line: ln }),
        ...(col !== undefined && { col }),
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
  collect(FILE_URL);
  collect(RELATIVE_PREFIXED);
  collect(RELATIVE_BARE);

  return dedupe(raw);
}

function trimPunctuation(text: string): { text: string; spanLength: number; line?: number; col?: number } {
  // Iterate to a fixed point so wrapped suffixes ("(see /foo.ts:42)") and
  // semver-shaped trailers ("/foo.ts:1.2.3", which SOURCE_LOCATION_SUFFIX
  // peels off one segment at a time) both fully unwrap. Bounded at 8
  // iterations as a defense against pathological input — typical paths
  // converge in 1–2 passes.
  let prev = text;
  let line: number | undefined;
  let col: number | undefined;
  // Length of the text up to and including a recognised `:line[:col]` tail.
  let locationSpan: number | undefined;
  for (let i = 0; i < 8; i++) {
    let out = prev.replace(TRAILING_PUNCTUATION, '');
    // Remember the first strict ":line[:col]" tail before it is stripped.
    if (line === undefined) {
      const loc = LINE_COL_TAIL.exec(out);
      if (loc) {
        line = Number(loc[1]);
        col = loc[2] !== undefined ? Number(loc[2]) : undefined;
        locationSpan = out.length;
      }
    }
    out = out.replace(SOURCE_LOCATION_SUFFIX, '');
    if (out === prev) break;
    prev = out;
  }
  return {
    text: prev,
    spanLength: locationSpan ?? prev.length,
    ...(line !== undefined && { line }),
    ...(col !== undefined && { col }),
  };
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

/** The `:line:col` a match carried, or undefined when it had none. */
export function locationOf(match: PathMatch): PathLocation | undefined {
  if (match.line === undefined) return undefined;
  return { line: match.line, ...(match.col !== undefined && { col: match.col }) };
}

/**
 * Rows of one soft-wrapped line read for a link, at most. A longer line is
 * read one row at a time, as before, so every row sees the same text.
 */
const MAX_WRAPPED_ROWS = 32;

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
  openPath: (filePath: string, location?: PathLocation) => void,
  platform: NodeJS.Platform = (typeof process !== 'undefined' && process.platform) || 'linux',
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      // xterm passes 1-based line numbers; getLine wants 0-based.
      const buffer = terminal.buffer.active;
      const row = bufferLineNumber - 1;
      if (!buffer.getLine(row)) {
        callback(undefined);
        return;
      }
      // A narrow pane soft-wraps a long path over several rows: read the
      // whole logical line (its first row and the wrapped rows after it), so
      // the path matches whole on any of its rows and a click opens all of it.
      let first = row;
      while (first > 0 && row - first <= MAX_WRAPPED_ROWS && buffer.getLine(first)?.isWrapped) first--;
      let last = row;
      while (last - first <= MAX_WRAPPED_ROWS && buffer.getLine(last + 1)?.isWrapped) last++;
      if (last - first >= MAX_WRAPPED_ROWS) {
        first = row;
        last = row;
      }
      // Offset in `text` where each row starts; a row that wraps on keeps its
      // trailing cells (they are part of the line), the last one is trimmed.
      const rowStarts: number[] = [];
      let text = '';
      for (let y = first; y <= last; y++) {
        rowStarts.push(text.length);
        const line = buffer.getLine(y);
        let part = line?.translateToString(y === last) ?? '';
        // A wide character that did not fit in the last column moved to the
        // next row and left that cell empty (width 1): padding, not a space.
        // The width-0 right half of a wide character that did fit is empty
        // too, and translateToString already skipped it.
        const lastCell = y < last && line && line.length > 0 ? line.getCell(line.length - 1) : undefined;
        if (lastCell?.getChars() === '' && lastCell.getWidth() === 1) {
          part = part.slice(0, -1);
        }
        text += part;
      }
      // 1-based cell of a text offset (one cell per character, as before).
      const cellAt = (offset: number): { x: number; y: number } => {
        let i = rowStarts.length - 1;
        while (i > 0 && rowStarts[i] > offset) i--;
        return { x: offset - rowStarts[i] + 1, y: first + i + 1 };
      };
      const matches = findPathMatches(text, platform).filter((match) => {
        const start = cellAt(match.start).y;
        const end = cellAt(match.end - 1).y;
        return start <= bufferLineNumber && bufferLineNumber <= end;
      });
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      const links: ILink[] = matches.map((match) => ({
        // xterm coordinates are 1-based; range.end is inclusive (the last
        // cell containing the link, not one past it).
        range: {
          start: cellAt(match.start),
          end: cellAt(match.end - 1),
        },
        text: match.text,
        // #2901: xterm activates on mouseup of any button; only a left click opens.
        activate: (event: MouseEvent) => {
          if (event.button !== 0) return;
          const location = locationOf(match);
          if (location) openPath(match.text, location);
          else openPath(match.text);
        },
      }));
      callback(links);
    },
  };
}
