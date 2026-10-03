// The files a Claude pane handed to its user with the `SendUserFile` tool, read
// back from the pane's own transcript.
//
// `/turns/image` and `/turns/file` serve paths under the pane's spawn cwd and
// the uploads directory. A file the agent explicitly sent to the user is the
// one addition: it is served when the transcript bound to THAT pane holds a
// `SendUserFile` tool_use naming it byte for byte in `input.files[]`, the
// matching tool_result succeeded, and the call is under 24 hours old. The list
// always comes from the transcript, never from the request.
//
// Why not `parseEntry`: it projects a tool call into a display body (text,
// possibly truncated), and this needs the structured `input.files` array. The
// raw-entry walk is the one `pendingToolUse.ts` already does, and its block
// helpers are reused here.
//
// The scan is incremental. A transcript is append-only, so each read starts at
// the last line boundary already scanned and the result is cached against the
// file's inode, size and mtime; a replaced or truncated file is rescanned from
// the start. Reads are async and chunked because a long session's transcript
// can be many megabytes, and the daemon serves every pane on one event loop.

import fs from 'node:fs';
import { statTranscript } from './readTail';
import { contentBlocks, isObject } from './pendingToolUse';

/** How long after the tool call a sent file stays servable. */
export const SENT_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Tolerance for a tool_use stamped slightly ahead of this clock. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const TOOL_NAME = 'SendUserFile';

/** One read from the transcript. */
const CHUNK_BYTES = 1024 * 1024;

/**
 * A line longer than this is skipped without parsing. Matches the ceiling the
 * projector puts on one transcript record (`MAX_OVERSIZED_SCAN_BYTES`); a
 * `SendUserFile` call is a few hundred bytes.
 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Calls waiting for their tool_result. An interrupted call never gets one. */
const MAX_PENDING_CALLS = 256;

/** Sent paths remembered per transcript; the oldest are dropped first. */
const MAX_SENT_PATHS = 4096;

/** Transcripts indexed at once. The daemon outlives every pane it ran. */
const MAX_INDEXED_TRANSCRIPTS = 32;

interface PendingCall {
  files: string[];
  at: number;
}

interface TranscriptIndex {
  ino: number;
  /** Size and mtime the last scan saw; equal on the next read ⇒ no scan. */
  size: number;
  mtimeMs: number;
  /** Byte offset just past the last complete line scanned. */
  offset: number;
  pending: Map<string, PendingCall>;
  /** Path → time of the newest successful call that sent it. */
  sent: Map<string, number>;
}

function emptyIndex(ino: number): TranscriptIndex {
  return { ino, size: -1, mtimeMs: -1, offset: 0, pending: new Map(), sent: new Map() };
}

/**
 * Fold one transcript line into the index. Lines that cannot name a
 * `SendUserFile` call or answer a pending one are rejected on a substring test
 * before any JSON is parsed: tool results for other tools can be large.
 */
export function absorbSentFileLine(index: Pick<TranscriptIndex, 'pending' | 'sent'>, line: string): void {
  const mayCall = line.includes(TOOL_NAME);
  let mayAnswer = false;
  if (!mayCall) {
    for (const id of index.pending.keys()) {
      if (line.includes(id)) { mayAnswer = true; break; }
    }
    if (!mayAnswer) return;
  }
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (!isObject(entry)) return;
  const type = entry['type'];
  for (const block of contentBlocks(entry)) {
    if (type === 'assistant' && block['type'] === 'tool_use' && block['name'] === TOOL_NAME) {
      const id = block['id'];
      const input = block['input'];
      const at = typeof entry['timestamp'] === 'string' ? Date.parse(entry['timestamp']) : NaN;
      if (typeof id !== 'string' || !id || !isObject(input) || !Number.isFinite(at)) continue;
      const raw = input['files'];
      const files = Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string' && f.length > 0) : [];
      if (files.length === 0) continue;
      index.pending.set(id, { files, at });
      if (index.pending.size > MAX_PENDING_CALLS) {
        const oldest = index.pending.keys().next();
        if (!oldest.done) index.pending.delete(oldest.value);
      }
    } else if (type === 'user' && block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
      const call = index.pending.get(block['tool_use_id']);
      if (!call) continue;
      index.pending.delete(block['tool_use_id']);
      if (block['is_error'] === true) continue;
      for (const file of call.files) {
        const prev = index.sent.get(file);
        // Re-inserted so the Map's order stays oldest-first for eviction.
        index.sent.delete(file);
        index.sent.set(file, prev === undefined ? call.at : Math.max(prev, call.at));
        if (index.sent.size > MAX_SENT_PATHS) {
          const oldest = index.sent.keys().next();
          if (!oldest.done) index.sent.delete(oldest.value);
        }
      }
    }
  }
}

/**
 * Scan `[index.offset, size)` of the open transcript into `index`, advancing
 * `offset` past each complete line. An unterminated tail is left for the next
 * scan, since the writer may still be appending to it.
 */
async function scanFrom(handle: fs.promises.FileHandle, index: TranscriptIndex, size: number): Promise<void> {
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = index.offset;
  let lineStart = index.offset;
  let parts: Buffer[] = [];
  let partBytes = 0;
  let oversized = false;
  while (position < size) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(CHUNK_BYTES, size - position), position);
    if (bytesRead === 0) break;
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, from);
      if (nl < 0 || nl >= bytesRead) break;
      if (!oversized) {
        const tail = chunk.subarray(from, nl);
        const line = partBytes === 0 ? tail : Buffer.concat([...parts, tail]);
        if (line.length > 0) absorbSentFileLine(index, line.toString('utf8'));
      }
      parts = [];
      partBytes = 0;
      oversized = false;
      from = nl + 1;
      lineStart = position + from;
    }
    if (from < bytesRead && !oversized) {
      partBytes += bytesRead - from;
      if (partBytes > MAX_LINE_BYTES) {
        oversized = true;
        parts = [];
      } else {
        // Copied: `chunk` is reused by the next read.
        parts.push(Buffer.from(chunk.subarray(from, bytesRead)));
      }
    }
    position += bytesRead;
  }
  index.offset = lineStart;
}

/**
 * Per-transcript index of sent files. One instance per server; concurrent
 * questions about the same transcript share one scan.
 */
export class SentFileIndex {
  private readonly indexes = new Map<string, TranscriptIndex>();
  private readonly inflight = new Map<string, Promise<TranscriptIndex | null>>();
  /** Scans that read the file, for tests that pin the cache. */
  scans = 0;

  /**
   * Whether `filePath` (compared byte for byte) was sent with a successful
   * `SendUserFile` call in `transcriptPath` no more than 24 hours before `nowMs`.
   */
  async isSent(transcriptPath: string, filePath: string, nowMs: number): Promise<boolean> {
    const index = await this.refresh(transcriptPath);
    const at = index?.sent.get(filePath);
    if (at === undefined) return false;
    const age = nowMs - at;
    return age <= SENT_FILE_MAX_AGE_MS && age >= -FUTURE_SKEW_MS;
  }

  private refresh(transcriptPath: string): Promise<TranscriptIndex | null> {
    const running = this.inflight.get(transcriptPath);
    if (running) return running;
    const next = this.update(transcriptPath).finally(() => this.inflight.delete(transcriptPath));
    this.inflight.set(transcriptPath, next);
    return next;
  }

  private async update(transcriptPath: string): Promise<TranscriptIndex | null> {
    // lstat first: a regular file only, so a FIFO is never opened.
    const stat = statTranscript(transcriptPath);
    if (!stat) {
      this.indexes.delete(transcriptPath);
      return null;
    }
    let index = this.indexes.get(transcriptPath);
    if (index && index.ino === stat.ino && index.size === stat.size && index.mtimeMs === stat.mtimeMs) return index;
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(transcriptPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    } catch {
      this.indexes.delete(transcriptPath);
      return null;
    }
    try {
      // The handle is what gets read, so its stat decides.
      const opened = await handle.stat();
      if (!opened.isFile()) return null;
      const ino = Number(opened.ino) || 0;
      if (!index || index.ino !== ino || opened.size < index.offset) index = emptyIndex(ino);
      this.scans += 1;
      await scanFrom(handle, index, opened.size);
      index.size = opened.size;
      index.mtimeMs = opened.mtimeMs;
      this.indexes.delete(transcriptPath);
      this.indexes.set(transcriptPath, index);
      if (this.indexes.size > MAX_INDEXED_TRANSCRIPTS) {
        const oldest = this.indexes.keys().next();
        if (!oldest.done) this.indexes.delete(oldest.value);
      }
      return index;
    } catch {
      this.indexes.delete(transcriptPath);
      return null;
    } finally {
      await handle.close().catch(() => { /* already gone — nothing to release */ });
    }
  }
}
