/**
 * Hard-wrapped link provider — makes a URL or absolute path that an agent
 * wrapped onto the next row clickable as one link.
 *
 * Claude Code's fullscreen renderer wraps its own text: at the right margin it
 * moves the cursor to the next row and indents it to the paragraph's body
 * column. xterm therefore sees two separate rows (the second has
 * `isWrapped === false`), so WebLinksAddon, which only follows soft wraps, and
 * pathLinkProvider, which reads single rows, both link a cut-off prefix.
 * Claude does not tell the terminal where its soft wraps were and sends no
 * OSC 8 links to wmux, so the join is rebuilt here, for Claude panes only.
 *
 * Rows N and N+1 join when all of these hold:
 *   • row N's last non-blank cell is at the right margin (cols-1, or cols-2
 *     when a wide character could not fit in the last column),
 *   • row N+1 is not soft-wrapped and starts with exactly row N's body indent
 *     (row N's leading blanks plus a bullet marker such as `⏺ `, `⎿  `, `- `
 *     or `1. `; Claude continues a paragraph at its body column),
 *   • row N+1's first token (up to the first blank) looks like the middle of
 *     a URL or path: it holds a letter or digit AND a digit or one of
 *     `/ . - _ ? = & # %`, it is not a numbered-list marker, and it does not
 *     start a new token (`/`, `~`, `\`, `C:\`, `http://`, `https://`),
 *   • the URL matcher (WebLinksAddon's regex plus a URL parse) or
 *     findPathMatches accepts the joined text and the match crosses the seam.
 * At most 3 rows join. A link is reported only when it spans 2 or more rows;
 * single-row links stay with WebLinksAddon and pathLinkProvider.
 *
 * Known misses: a continuation whose first token is letters only
 * (`https://…/ab` + `cdef)`) stays cut, and so does a link that wraps exactly
 * before a `/` or `~`. Known false join: a URL or path that ends exactly at the
 * margin, followed by a row at the same indent whose first word has a digit or
 * punctuation in it (`v2`, `e.g.`).
 */

import type { ILink, ILinkProvider, IBufferRange } from '@xterm/xterm';
import type { AgentSlug } from '../../shared/agentIdentity';
import { findPathMatches } from './pathLinkProvider';

/** Agents whose renderer hard-wraps its own text at the right margin. */
const AGENTS_THAT_HARD_WRAP: ReadonlySet<AgentSlug> = new Set<AgentSlug>(['claude']);

export function agentHardWrapsText(slug: AgentSlug | undefined): boolean {
  return slug !== undefined && AGENTS_THAT_HARD_WRAP.has(slug);
}

/** Most rows one joined link may span. */
export const MAX_JOINED_ROWS = 3;

// Mirrors WebLinksAddon's default strictUrlRegex (not exported by the addon),
// so a joined URL ends where the addon would end it, e.g. before `)`.
const URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g;

const NEW_TOKEN_START = /^(?:[/~\\]|[A-Za-z]:[\\/]|https?:\/\/)/i;
const NUMBERED_MARKER = /^\d+[.)]$/;
const HAS_ALNUM = /[A-Za-z0-9]/;
const HAS_LINK_CHAR = /[/.\-_?=&#%0-9]/;
const BODY_MARKER = /^(?:[⏺●•◦▪‣·⎿*+-]|\d+[.)])\s+/;

interface CellLike {
  getChars(): string;
  getWidth(): number;
}

interface LineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number, cell?: CellLike): CellLike | undefined;
}

/** The slice of xterm's IBuffer this module reads (headless buffers fit too). */
export interface LinkBuffer {
  getLine(y: number): LineLike | undefined;
  getNullCell(): CellLike;
}

export interface HardWrappedLink {
  kind: 'url' | 'path';
  text: string;
  /** Buffer range, 1-based, end inclusive (xterm's ILink range). */
  range: IBufferRange;
}

interface Row {
  /** Row text up to its last non-blank character. */
  text: string;
  /** Cell column of each UTF-16 unit of `text`. */
  xs: number[];
  /** Cell width of each UTF-16 unit of `text`. */
  ws: number[];
  /** Leading blank cells. */
  lead: number;
  /** Exclusive cell end of the last non-blank character. */
  end: number;
  isWrapped: boolean;
}

function readRow(buffer: LinkBuffer, y: number, cell: CellLike): Row | undefined {
  if (y < 0) return undefined;
  const line = buffer.getLine(y);
  if (!line) return undefined;
  let text = '';
  const xs: number[] = [];
  const ws: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const c = line.getCell(x, cell);
    if (!c) break;
    const width = c.getWidth();
    if (width === 0) continue;
    const chars = c.getChars() || ' ';
    for (let i = 0; i < chars.length; i++) {
      text += chars[i];
      xs.push(x);
      ws.push(width);
    }
  }
  const trimmed = text.replace(/\s+$/, '');
  const len = trimmed.length;
  const leadMatch = /^\s*/.exec(trimmed);
  const leadChars = leadMatch ? leadMatch[0].length : 0;
  return {
    text: trimmed,
    xs: xs.slice(0, len),
    ws: ws.slice(0, len),
    lead: len === 0 ? 0 : xs[leadChars],
    end: len === 0 ? 0 : xs[len - 1] + ws[len - 1],
    isWrapped: line.isWrapped,
  };
}

/** Cell column where a row's body text starts (after its indent and bullet). */
function bodyIndent(row: Row): number {
  const leadChars = row.text.length - row.text.trimStart().length;
  const marker = BODY_MARKER.exec(row.text.slice(leadChars));
  if (!marker) return row.lead;
  const bodyChar = leadChars + marker[0].length;
  return bodyChar < row.text.length ? row.xs[bodyChar] : row.lead;
}

/** First character index of `row.text` that sits at or after cell `x`. */
function charAtCell(row: Row, x: number): number {
  let i = 0;
  while (i < row.xs.length && row.xs[i] < x) i++;
  return i;
}

/** Whether `lower` continues the token that `upper` ran into the margin with. */
function continues(upper: Row, lower: Row, cols: number): boolean {
  if (lower.isWrapped || upper.text.length === 0 || lower.text.length === 0) return false;
  if (upper.end < cols - 1) return false;
  if (lower.lead < 1 || lower.lead !== bodyIndent(upper)) return false;
  const token = /^\S+/.exec(lower.text.slice(charAtCell(lower, lower.lead)))?.[0] ?? '';
  if (!token || NEW_TOKEN_START.test(token) || NUMBERED_MARKER.test(token)) return false;
  return HAS_ALNUM.test(token) && HAS_LINK_CHAR.test(token);
}

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Links that cross a hard-wrap seam and touch buffer row `y` (0-based).
 * Returns an empty list when no such link exists.
 */
export function findHardWrappedLinks(
  buffer: LinkBuffer,
  cols: number,
  y: number,
  platform: NodeJS.Platform,
): HardWrappedLink[] {
  const cell = buffer.getNullCell();
  const rows = new Map<number, Row | undefined>();
  const row = (at: number): Row | undefined => {
    if (!rows.has(at)) rows.set(at, readRow(buffer, at, cell));
    return rows.get(at);
  };
  const seam = (upperY: number): boolean => {
    const upper = row(upperY);
    const lower = row(upperY + 1);
    return !!upper && !!lower && continues(upper, lower, cols);
  };

  const reach = MAX_JOINED_ROWS - 1;
  let top = y;
  while (top > y - reach && seam(top - 1)) top--;
  let bottom = y;
  while (bottom < y + reach && seam(bottom)) bottom++;
  if (top === bottom) return [];

  // Join the rows: the top row whole, each following row from its indent.
  let text = '';
  const pos: { y: number; x: number; w: number }[] = [];
  const seamAt: number[] = [];
  for (let r = top; r <= bottom; r++) {
    const current = row(r);
    if (!current) return [];
    const from = r === top ? 0 : charAtCell(current, current.lead);
    if (r !== top) seamAt.push(text.length);
    for (let i = from; i < current.text.length; i++) {
      text += current.text[i];
      pos.push({ y: r, x: current.xs[i], w: current.ws[i] });
    }
  }
  // The chain may run past the rows read: a match that starts at the top
  // row's fragment, or ends at the bottom row's end, is part of a link longer
  // than MAX_JOINED_ROWS.
  const topRow = row(top);
  const topFragment = topRow && seam(top - 1) ? charAtCell(topRow, topRow.lead) : -1;
  const bottomEnd = seam(bottom) ? text.length : -1;

  const links: HardWrappedLink[] = [];
  const accept = (kind: HardWrappedLink['kind'], matchText: string, start: number, end: number): void => {
    if (start === topFragment || end === bottomEnd) return;
    if (!seamAt.some((s) => start < s && end > s)) return;
    const first = pos[start];
    const last = pos[end - 1];
    if (last.y - first.y + 1 > MAX_JOINED_ROWS) return;
    if (y < first.y || y > last.y) return;
    links.push({
      kind,
      text: matchText,
      range: {
        start: { x: first.x + 1, y: first.y + 1 },
        end: { x: last.x + last.w, y: last.y + 1 },
      },
    });
  };

  const urlSpans: [number, number][] = [];
  URL_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_REGEX.exec(text)) !== null) {
    if (!isHttpUrl(m[0])) continue;
    urlSpans.push([m.index, m.index + m[0].length]);
    accept('url', m[0], m.index, m.index + m[0].length);
  }
  for (const match of findPathMatches(text, platform)) {
    if (urlSpans.some(([s, e]) => match.start < e && s < match.end)) continue;
    accept('path', match.text, match.start, match.end);
  }
  return links;
}

export interface HardWrappedLinkProviderOptions {
  /** Read per call: the pane's agent can change while the terminal lives. */
  getAgentSlug: () => AgentSlug | undefined;
  activateUrl: (event: MouseEvent, uri: string) => void;
  openPath: (filePath: string) => void;
  platform?: NodeJS.Platform;
}

/**
 * xterm link provider for links an agent hard-wrapped across rows. Register it
 * before WebLinksAddon and pathLinkProvider: xterm prefers the earliest
 * provider with a link under the mouse and drops later providers' links that
 * overlap it (Linkifier `_removeIntersectingLinks`), which is what retires the
 * cut-off single-row links on the first row.
 */
export function createHardWrappedLinkProvider(
  terminal: { readonly buffer: { readonly active: LinkBuffer }; readonly cols: number },
  options: HardWrappedLinkProviderOptions,
): ILinkProvider {
  const platform = options.platform
    ?? ((typeof process !== 'undefined' && process.platform) || 'linux');
  return {
    provideLinks(bufferLineNumber, callback) {
      if (!agentHardWrapsText(options.getAgentSlug())) {
        callback(undefined);
        return;
      }
      const found = findHardWrappedLinks(terminal.buffer.active, terminal.cols, bufferLineNumber - 1, platform);
      if (found.length === 0) {
        // undefined, not []: an empty reply still holds back the providers
        // registered after this one.
        callback(undefined);
        return;
      }
      const links: ILink[] = found.map((link) => ({
        range: link.range,
        text: link.text,
        activate: (event: MouseEvent) => {
          // #2901: xterm activates on mouseup of any button, and a path never
          // reaches activateUrl's own check. Only a left click opens.
          if (event.button !== 0) return;
          if (link.kind === 'url') options.activateUrl(event, link.text);
          else options.openPath(link.text);
        },
      }));
      callback(links);
    },
  };
}
