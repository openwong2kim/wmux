// Bounded, crash-proof reads of a Claude Code transcript `.jsonl`.
//
// The discipline here is carried over verbatim from
// `src/main/claude/lastAssistantMessage.ts`, because every one of its rules was
// paid for:
//
//   - `lstatSync` + `st.isFile()` BEFORE `openSync`. `transcriptPath` arrives
//     from a hook payload, and `openSync` on a FIFO blocks the process
//     indefinitely — there is no timeout to save us and no way to cancel a
//     blocked syscall. In the daemon that would stall every pane at once.
//   - `readSync` into a right-sized buffer, then `buf.subarray(0, read)`.
//     Decoding the whole buffer would leave zero-fill in the tail when the file
//     is truncated or rotated mid-read, corrupting the very last record.
//   - a partial leading line is EXPECTED on any mid-file seek; it is dropped,
//     not repaired.
//   - every failure resolves to `null`. A transcript that was rotated, deleted,
//     or written by an agent whose format we do not know must degrade to "Chat
//     View unavailable", never to a daemon-side throw.
//
// Reads are bounded at TAIL_BYTES so a multi-megabyte transcript costs the same
// as a small one, and so a subscribe storm cannot turn into unbounded IO.

import fs from 'node:fs';
import { parseTranscriptLine } from './parseEntry';
import type {
  MetaEvent,
  TranscriptCursor,
  TranscriptPage,
  TurnEvent,
} from '../../shared/transcript/turnEvents';

/** Cap on any single read. Matches lastAssistantMessage.ts. */
export const TAIL_BYTES = 256 * 1024;

/** Cap on the single-line read that answers an on-expand code-body fetch. */
const LINE_READ_BYTES = 512 * 1024;

/**
 * How far past the cursor we will hunt for the newline that terminates an
 * oversized record. Bounded because the hunt is the only unbounded-looking read
 * in this file: an 8MB ceiling covers any plausible single transcript entry and
 * still costs at most 32 bounded reads.
 */
const MAX_OVERSIZED_SCAN_BYTES = 8 * 1024 * 1024;

export interface ReadPageOptions {
  /**
   * Page BACKWARD: return the window that ENDS at this byte offset. Callers
   * pass a previous `cursor.headOffset`, which is always a line boundary.
   */
  before?: number;
  maxBytes?: number;
}

export interface TranscriptDelta {
  events: TurnEvent[];
  cursor: TranscriptCursor;
  /** The file shrank or rotated — the caller must re-snapshot, not append. */
  reset: boolean;
  /**
   * The read consumed NOTHING because an oversized record at the cursor has no
   * newline yet: the writer is still mid-entry (or the entry is past the bounded
   * hunt). The cursor is unchanged on purpose — advancing into an unterminated
   * record would land it mid-line, where `isLineBoundary` fails on every
   * subsequent read and the consumer resets its view in a loop. Callers should
   * back off rather than re-read immediately.
   */
  stalled?: boolean;
}

/**
 * Last `maxBytes` of the file (or the window ending at `opts.before`), parsed
 * forward with the partial leading line discarded.
 *
 * Returns `null` when the path is not a readable regular file — including the
 * FIFO and directory cases, which are REFUSED rather than opened.
 */
export function readTranscriptPage(
  transcriptPath: string,
  opts?: ReadPageOptions,
): TranscriptPage | null {
  const stat = statRegularFile(transcriptPath);
  if (!stat) return null;

  const maxBytes = normalizeMaxBytes(opts?.maxBytes);
  const end = opts?.before === undefined
    ? stat.size
    : Math.max(0, Math.min(Math.floor(opts.before), stat.size));

  if (end <= 0) {
    // Nothing before this point — an empty page, not a failure. `hasMore:false`
    // is what stops the renderer's "Load earlier" from spinning forever.
    return {
      events: [],
      cursor: { headOffset: 0, tailOffset: 0, fileSize: stat.size, mtimeMs: stat.mtimeMs },
      hasMore: false,
      truncatedHead: false,
    };
  }

  const start = Math.max(0, end - maxBytes);
  const raw = readRange(transcriptPath, start, end - start);
  if (raw === null) return null;

  // `end` is either EOF or a caller-supplied line boundary. In the EOF case the
  // final line may be half-written, so an incomplete trailing line is dropped
  // (`atEof` = we cannot know more is coming).
  // A seek past byte 0 lands INSIDE a line, so that fragment is the head to
  // drop. A read from 0 has no fragment.
  const truncatedHead = start > 0;
  const scanned = scanLines(raw, start, { dropTrailingPartial: true, skipHead: truncatedHead });
  let headOffset = truncatedHead ? scanned.firstOffset : 0;
  // D1(c) — when the last complete record before `end` is OVERSIZED, the window
  // holds the fragment plus at most that record's terminating newline, so
  // `firstOffset` lands at `end` itself. The caller pages backward with
  // `before = headOffset`, so an unchanged head offset means "Load earlier"
  // returns the same empty page forever. Fall back to the window start, which is
  // strictly smaller than `end` and therefore always makes progress; the
  // fragment it points into is dropped by the same `skipHead` rule on the next
  // read.
  if (truncatedHead && headOffset >= end) headOffset = start;

  return {
    events: scanned.events,
    cursor: {
      headOffset,
      tailOffset: scanned.tailOffset,
      fileSize: stat.size,
      mtimeMs: stat.mtimeMs,
    },
    hasMore: headOffset > 0,
    truncatedHead,
  };
}

/**
 * Incremental read from `fromOffset` to EOF (capped at `maxBytes`).
 *
 * `reset:true` means the file shrank — truncated, rotated, or replaced by a
 * fresh session — so `fromOffset` no longer points at what the caller thinks it
 * does. The returned events are then a full tail SNAPSHOT, not a delta, and the
 * consumer must replace its rows rather than append them.
 */
export function readTranscriptDelta(
  transcriptPath: string,
  fromOffset: number,
  maxBytes?: number,
): TranscriptDelta | null {
  const stat = statRegularFile(transcriptPath);
  if (!stat) return null;

  const limit = normalizeMaxBytes(maxBytes);
  const from = Number.isFinite(fromOffset) && fromOffset > 0 ? Math.floor(fromOffset) : 0;

  if (stat.size < from) {
    const page = readTranscriptPage(transcriptPath, { maxBytes: limit });
    if (!page) return null;
    return { events: page.events, cursor: page.cursor, reset: true };
  }

  if (stat.size === from) {
    // A watch fires on mtime changes too, so "nothing new" is the common case.
    return {
      events: [],
      cursor: { headOffset: from, tailOffset: from, fileSize: stat.size, mtimeMs: stat.mtimeMs },
      reset: false,
    };
  }

  const length = Math.min(stat.size - from, limit);
  const raw = readRange(transcriptPath, from, length);
  if (raw === null) return null;

  const capped = length < stat.size - from;
  // `from` is a line boundary the caller got from a previous cursor, so there
  // is no partial head here — dropping one would silently lose an entry.
  const scanned = scanLines(raw, from, { dropTrailingPartial: true, skipHead: false });

  let events = scanned.events;
  let tailOffset = scanned.tailOffset;
  let stalled = false;

  if (scanned.tailOffset === from && capped) {
    // A window that is FULL and holds no line terminator means one entry is
    // larger than the read cap. Neither of the two obvious moves is acceptable:
    // advancing by `raw.length` lands the cursor INSIDE the record (the
    // line-boundary check then fails on every later read and the consumer
    // resets its rows in a flicker loop, D1(b)), and silently dropping the
    // record loses conversation content with nothing on screen to say so
    // (D1(a)).
    //
    // So: hunt for the record's terminating newline. Found ⇒ the record is
    // complete, and we skip exactly it, leaving one `meta` row that says a row
    // was skipped and a cursor that is still a true line boundary. Not found ⇒
    // the writer is mid-entry; hold the cursor and let the caller back off.
    const nl = findNextNewline(transcriptPath, from, stat.size);
    if (nl === null) {
      stalled = true;
    } else {
      events = [oversizedSkipped(from)];
      tailOffset = nl + 1;
    }
  }

  return {
    events,
    cursor: {
      headOffset: from,
      tailOffset,
      fileSize: stat.size,
      mtimeMs: stat.mtimeMs,
    },
    reset: false,
    ...(stalled ? { stalled: true } : {}),
  };
}

/**
 * The visible receipt for D1(a): a single entry too large to page is dropped,
 * but the conversation says so rather than developing a silent hole.
 */
function oversizedSkipped(offset: number): MetaEvent {
  return {
    id: `${offset}:oversized`,
    kind: 'meta',
    subtype: 'unknown',
    label: 'oversized entry skipped',
  };
}

/**
 * Byte offset of the first `\n` at or after `from`, or `null` when there is none
 * within `MAX_OVERSIZED_SCAN_BYTES` (or the file simply has not been written
 * that far yet). Reads in TAIL_BYTES chunks so the hunt stays bounded per read.
 */
function findNextNewline(transcriptPath: string, from: number, fileSize: number): number | null {
  const limit = Math.min(fileSize, from + MAX_OVERSIZED_SCAN_BYTES);
  let at = from;
  while (at < limit) {
    const chunk = readRange(transcriptPath, at, Math.min(TAIL_BYTES, limit - at));
    if (chunk === null || chunk.length === 0) return null;
    const nl = chunk.indexOf(0x0a);
    if (nl !== -1) return at + nl;
    at += chunk.length;
  }
  return null;
}

/**
 * The single transcript line that starts at `offset`, or `null`.
 *
 * This is how an on-expand code-body fetch stays O(1): the block ref carries
 * the byte offset of the line it came from, so the body is re-extracted from
 * that one line instead of being cached per subscriber.
 */
export function readTranscriptLineAt(transcriptPath: string, offset: number): string | null {
  const stat = statRegularFile(transcriptPath);
  if (!stat) return null;
  const from = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  if (from >= stat.size) return null;
  const raw = readRange(transcriptPath, from, Math.min(stat.size - from, LINE_READ_BYTES));
  if (raw === null) return null;
  const text = raw.toString('utf8');
  const nl = text.indexOf('\n');
  return nl === -1 ? text : text.slice(0, nl);
}

/**
 * Is `offset` still a line boundary in this file?
 *
 * Cursor-integrity check for the one rewrite neither a size comparison nor an
 * inode comparison catches: a transcript truncated and rewritten IN PLACE to a
 * length past the old cursor. Reading forward from a stale offset would then
 * splice the middle of an unrelated entry into the conversation. A single byte
 * read answers it: offset 0 is always a boundary, and any other valid cursor has
 * a newline immediately before it.
 */
export function isLineBoundary(transcriptPath: string, offset: number): boolean {
  if (offset <= 0) return true;
  const stat = statRegularFile(transcriptPath);
  if (!stat) return false;
  if (offset > stat.size) return false;
  const raw = readRange(transcriptPath, offset - 1, 1);
  return raw !== null && raw.length === 1 && raw[0] === 0x0a;
}

/**
 * Basename of a transcript path, correct for BOTH separators on BOTH platforms.
 *
 * `path.basename` is separator-aware only for the HOST platform, so a Windows
 * transcript path relayed to a POSIX daemon (or replayed from a state file
 * written on another machine) would come back whole. The basename is the
 * Claude Code session id, which is what the status payload and the resume
 * binding are keyed on, so getting it wrong is not cosmetic. UNC and
 * extended-length (`\\?\C:\…`) forms fall out of the same last-segment rule.
 */
export function transcriptBasename(transcriptPath: string): string {
  if (!transcriptPath) return '';
  const segments = transcriptPath.replace(/\\/g, '/').split('/');
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i]) return segments[i];
  }
  return '';
}

/** Strip the `.jsonl` suffix from a transcript basename (the agent session id). */
export function transcriptSessionId(transcriptPath: string): string {
  return transcriptBasename(transcriptPath).replace(/\.jsonl$/i, '');
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

export interface RegularFileStat {
  size: number;
  mtimeMs: number;
  /**
   * Inode (0 where the platform does not report one). A changed inode at the
   * same path means the file was REPLACED, which a size comparison misses when
   * the replacement is larger than the old cursor.
   */
  ino: number;
}

/**
 * Size + mtime of a transcript, or `null` when the path is not a readable
 * regular file. The cheap availability probe: a status RPC must not parse.
 */
export function statTranscript(transcriptPath: string): RegularFileStat | null {
  return statRegularFile(transcriptPath);
}

/**
 * `lstat` and only a regular file. The FIFO refusal is the load-bearing part
 * (see the file header); a directory and a dangling symlink are refused by the
 * same check.
 */
function statRegularFile(transcriptPath: string): RegularFileStat | null {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  try {
    const st = fs.lstatSync(transcriptPath);
    if (!st.isFile()) return null;
    return { size: st.size, mtimeMs: st.mtimeMs, ino: Number(st.ino) || 0 };
  } catch {
    return null;
  }
}

function normalizeMaxBytes(maxBytes: number | undefined): number {
  if (maxBytes === undefined || !Number.isFinite(maxBytes) || maxBytes <= 0) return TAIL_BYTES;
  return Math.min(Math.floor(maxBytes), TAIL_BYTES);
}

/** Read exactly `length` bytes at `start`, returning only what was READ. */
function readRange(transcriptPath: string, start: number, length: number): Buffer | null {
  if (length <= 0) return Buffer.alloc(0);
  let fd: number | null = null;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    // Decode ONLY what was actually read: a concurrent truncation would
    // otherwise leave zero-fill in the tail and corrupt the last record.
    return buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed / invalid fd — nothing to recover.
      }
    }
  }
}

interface ScannedLines {
  events: TurnEvent[];
  /** Byte offset of the first COMPLETE line in the window. */
  firstOffset: number;
  /** Byte offset just past the last complete line consumed. */
  tailOffset: number;
}

/**
 * Split a byte window into lines and parse each one, tracking byte offsets so
 * every event carries a stable id and every code block a re-fetchable offset.
 *
 * Newlines are located as BYTE indexes on the Buffer and each complete line is
 * decoded on its own. Deriving offsets from a whole-window `toString()` was
 * wrong in two ways that both skew every offset after the first occurrence, and
 * therefore every `tailOffset` cursor and every code block's `srcOffset`:
 *   - a multibyte sequence split across the window edge decodes to U+FFFD, whose
 *     re-encoded length (3 bytes) is not the length of the bytes it stood for;
 *   - an invalid byte anywhere in the window decodes to U+FFFD the same way,
 *     and a transcript containing one is exactly the corrupt-file case this
 *     reader is supposed to survive.
 * Byte indexes have neither problem: the offsets never depend on what the
 * decoder made of the bytes.
 */
function scanLines(
  raw: Buffer,
  windowStart: number,
  opts: { dropTrailingPartial: boolean; skipHead: boolean },
): ScannedLines {
  const events: TurnEvent[] = [];
  let firstOffset = windowStart;
  let tailOffset = windowStart;
  const { skipHead } = opts;

  let cursor = 0;
  let lineIndex = 0;
  while (cursor < raw.length) {
    const nl = raw.indexOf(0x0a, cursor);
    // No terminator left: the remainder is '' for a clean file and a
    // half-written entry otherwise. Either way it is not a complete line.
    if (nl === -1 && opts.dropTrailingPartial) break;
    const lineEnd = nl === -1 ? raw.length : nl;
    const next = nl === -1 ? raw.length : nl + 1;
    const lineOffset = windowStart + cursor;
    const advanced = windowStart + next;
    // A mid-file seek lands inside a line; that fragment is dropped, and the
    // first COMPLETE line is the one after it.
    if (skipHead && lineIndex === 0) {
      firstOffset = advanced;
      tailOffset = advanced;
    } else {
      events.push(...parseTranscriptLine(raw.toString('utf8', cursor, lineEnd), lineOffset));
      tailOffset = advanced;
    }
    cursor = next;
    lineIndex += 1;
  }

  return { events, firstOffset, tailOffset };
}
