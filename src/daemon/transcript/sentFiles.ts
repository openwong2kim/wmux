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
// file's inode, size and mtime. Two checks keep that cache tied to the bytes
// on disk: before an incremental read, hashes of the scanned region's first
// and last few KiB must still match (otherwise the file was rewritten and is
// indexed again from scratch); and before a grant is used, the two lines it
// came from (the call and its result) are re-read and must hash the same. Reads
// are async and chunked because a long session's transcript can be many
// megabytes, and the daemon serves every pane on one event loop.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { statTranscript } from './readTail';
import { contentBlocks, isObject } from './pendingToolUse';

/** How long after the tool call a sent file stays servable. */
export const SENT_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Clock tolerance, both ways: a tool_use stamped slightly ahead of this clock
 * still counts, and a served file's mtime may be this far past the call.
 */
export const SENT_FILE_CLOCK_SKEW_MS = 5 * 60 * 1000;

const TOOL_NAME = 'SendUserFile';

/** One read from the transcript. */
const CHUNK_BYTES = 1024 * 1024;

/**
 * A line longer than this is skipped without parsing. Matches the ceiling the
 * projector puts on one transcript record (`MAX_OVERSIZED_SCAN_BYTES`); a
 * `SendUserFile` call is a few hundred bytes.
 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * How much of a transcript the first scan reads, from its end. Calls older than
 * 24 hours are refused anyway, so a long session's early history is not worth
 * reading.
 */
const DEFAULT_MAX_SCAN_BYTES = 64 * 1024 * 1024;

/** Size of each fingerprint window at the ends of the scanned region. */
const FINGERPRINT_BYTES = 4096;

/** Calls waiting for their tool_result. An interrupted call never gets one. */
const MAX_PENDING_CALLS = 256;

/** Sent paths remembered per transcript; the oldest are dropped first. */
const MAX_SENT_PATHS = 4096;

/** Transcripts indexed at once, least recently used dropped first. */
const DEFAULT_MAX_TRANSCRIPTS = 32;

/** Where one transcript line sits, and the hash of its bytes. */
interface LineRef {
  offset: number;
  length: number;
  hash: string;
}

interface PendingCall {
  files: string[];
  at: number;
  call: LineRef;
}

interface SentGrant {
  at: number;
  call: LineRef;
  result: LineRef;
}

interface TranscriptIndex {
  ino: number;
  /** Size and mtime the last scan saw; equal on the next read ⇒ no scan. */
  size: number;
  mtimeMs: number;
  /** Where the first scan started (0, or the cap window's start). */
  base: number;
  /** Byte offset just past the last complete line scanned. */
  offset: number;
  /** Hashes of `[base, base+4K)` and `[offset-4K, offset)` as last scanned. */
  headHash: string;
  tailHash: string;
  pending: Map<string, PendingCall>;
  /** Path → the newest successful call that sent it. */
  sent: Map<string, SentGrant>;
}

function emptyIndex(ino: number, base: number): TranscriptIndex {
  return {
    ino, size: -1, mtimeMs: -1, base, offset: base, headHash: '', tailHash: '',
    pending: new Map(), sent: new Map(),
  };
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * The parent and name to open for a requested sent path, or null when its
 * shape is not one this route serves: any `.` or `..` segment, or an empty
 * segment anywhere but the leading root (a doubled or trailing separator).
 * Both separators are split on, so a Windows path written with forward
 * slashes (`C:/Users/me/shot.png`) is accepted as written, and the byte match
 * against the transcript happens on the raw string, never a normalized one.
 */
export function sentFileParts(raw: string, p: path.PlatformPath = path): { dir: string; name: string } | null {
  const segments = raw.split(/[\\/]/);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if ((s === '' && i !== 0) || s === '.' || s === '..') return null;
  }
  const name = p.basename(raw);
  if (!name || name !== segments[segments.length - 1]) return null;
  return { dir: p.dirname(raw), name };
}

/**
 * Fold one transcript line into the index. Lines that cannot name a
 * `SendUserFile` call or answer a pending one are rejected on a substring test
 * before any JSON is parsed: tool results for other tools can be large.
 */
function absorbLine(index: TranscriptIndex, bytes: Buffer, offset: number): void {
  const line = bytes.toString('utf8');
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
  let ref: LineRef | undefined;
  const lineRef = (): LineRef => (ref ??= { offset, length: bytes.length, hash: sha256(bytes) });
  for (const block of contentBlocks(entry)) {
    if (type === 'assistant' && block['type'] === 'tool_use' && block['name'] === TOOL_NAME) {
      const id = block['id'];
      const input = block['input'];
      const at = typeof entry['timestamp'] === 'string' ? Date.parse(entry['timestamp']) : NaN;
      if (typeof id !== 'string' || !id || !isObject(input) || !Number.isFinite(at)) continue;
      const raw = input['files'];
      const files = Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string' && f.length > 0) : [];
      if (files.length === 0) continue;
      index.pending.set(id, { files, at, call: lineRef() });
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
        if (prev && prev.at > call.at) continue;
        // Re-inserted so the Map's order stays oldest-first for eviction.
        index.sent.delete(file);
        index.sent.set(file, { at: call.at, call: call.call, result: lineRef() });
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
 * scan, since the writer may still be appending to it. `skipHead` drops the
 * bytes up to the first newline: a scan that starts inside the file starts
 * inside a line.
 */
async function scanFrom(handle: fs.promises.FileHandle, index: TranscriptIndex, size: number, skipHead: boolean): Promise<void> {
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = index.offset;
  let lineStart = index.offset;
  let parts: Buffer[] = [];
  let partBytes = 0;
  let oversized = skipHead;
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
        if (line.length > 0) absorbLine(index, line, lineStart);
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
  // A skipped head that never ended leaves nothing scanned past the window start.
  index.offset = lineStart;
}

/** sha256 of `[start, start+length)`, or null when fewer bytes are there. */
async function hashRange(handle: fs.promises.FileHandle, start: number, length: number): Promise<string | null> {
  const buf = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buf, filled, length - filled, start + filled);
    if (bytesRead === 0) return null;
    filled += bytesRead;
  }
  return sha256(buf);
}

async function fingerprint(handle: fs.promises.FileHandle, index: TranscriptIndex): Promise<{ head: string; tail: string } | null> {
  const headLen = Math.min(FINGERPRINT_BYTES, index.offset - index.base);
  const tailStart = Math.max(index.base, index.offset - FINGERPRINT_BYTES);
  const head = await hashRange(handle, index.base, headLen);
  const tail = await hashRange(handle, tailStart, index.offset - tailStart);
  return head === null || tail === null ? null : { head, tail };
}

const READ_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * Per-transcript index of sent files. One instance per server; concurrent
 * questions about the same transcript share one scan.
 */
export class SentFileIndex {
  private readonly indexes = new Map<string, TranscriptIndex>();
  private readonly inflight = new Map<string, Promise<TranscriptIndex | null>>();
  private readonly maxScanBytes: number;
  private readonly maxTranscripts: number;
  /** Scans that read the file, for tests that pin the cache. */
  scans = 0;

  constructor(opts: { maxScanBytes?: number; maxTranscripts?: number } = {}) {
    this.maxScanBytes = opts.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
    this.maxTranscripts = opts.maxTranscripts ?? DEFAULT_MAX_TRANSCRIPTS;
  }

  /**
   * When `filePath` (compared byte for byte) was sent with a successful
   * `SendUserFile` call in `transcriptPath` no more than 24 hours before
   * `nowMs` — the call's timestamp — or null. The two transcript lines the
   * grant rests on are re-read first; if either changed, the transcript is
   * indexed again from scratch and the answer comes from that.
   */
  async sentAt(transcriptPath: string, filePath: string, nowMs: number): Promise<number | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const index = await this.refresh(transcriptPath);
      const grant = index?.sent.get(filePath);
      if (!index || !grant) return null;
      const age = nowMs - grant.at;
      if (age > SENT_FILE_MAX_AGE_MS || age < -SENT_FILE_CLOCK_SKEW_MS) return null;
      if (await this.grantStillOnDisk(transcriptPath, grant)) return grant.at;
      if (this.indexes.get(transcriptPath) === index) this.indexes.delete(transcriptPath);
    }
    return null;
  }

  private async grantStillOnDisk(transcriptPath: string, grant: SentGrant): Promise<boolean> {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(transcriptPath, READ_FLAGS);
    } catch {
      return false;
    }
    try {
      if (!(await handle.stat()).isFile()) return false;
      for (const ref of [grant.call, grant.result]) {
        if ((await hashRange(handle, ref.offset, ref.length)) !== ref.hash) return false;
      }
      return true;
    } catch {
      return false;
    } finally {
      await handle.close().catch(() => { /* already gone — nothing to release */ });
    }
  }

  private refresh(transcriptPath: string): Promise<TranscriptIndex | null> {
    const running = this.inflight.get(transcriptPath);
    if (running) return running;
    const next = this.update(transcriptPath).finally(() => this.inflight.delete(transcriptPath));
    this.inflight.set(transcriptPath, next);
    return next;
  }

  /** Mark `index` most recently used, dropping the least recently used past the cap. */
  private remember(transcriptPath: string, index: TranscriptIndex): void {
    this.indexes.delete(transcriptPath);
    this.indexes.set(transcriptPath, index);
    while (this.indexes.size > this.maxTranscripts) {
      const oldest = this.indexes.keys().next();
      if (oldest.done) break;
      this.indexes.delete(oldest.value);
    }
  }

  private async update(transcriptPath: string): Promise<TranscriptIndex | null> {
    // lstat first: a regular file only, so a FIFO is never opened.
    const stat = statTranscript(transcriptPath);
    if (!stat) {
      this.indexes.delete(transcriptPath);
      return null;
    }
    let index = this.indexes.get(transcriptPath);
    if (index && index.ino === stat.ino && index.size === stat.size && index.mtimeMs === stat.mtimeMs) {
      this.remember(transcriptPath, index);
      return index;
    }
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(transcriptPath, READ_FLAGS);
    } catch {
      this.indexes.delete(transcriptPath);
      return null;
    }
    try {
      // The handle is what gets read, so its stat decides.
      const opened = await handle.stat();
      if (!opened.isFile()) {
        this.indexes.delete(transcriptPath);
        return null;
      }
      const ino = Number(opened.ino) || 0;
      if (index && (index.ino !== ino || opened.size < index.offset)) index = undefined;
      if (index) {
        // Same file, not shorter: only an append if the scanned region's ends
        // still read the same.
        const now = await fingerprint(handle, index);
        if (!now || now.head !== index.headHash || now.tail !== index.tailHash) index = undefined;
      }
      let skipHead = false;
      if (!index) {
        const base = Math.max(0, opened.size - this.maxScanBytes);
        index = emptyIndex(ino, base);
        skipHead = base > 0;
      }
      this.scans += 1;
      await scanFrom(handle, index, opened.size, skipHead);
      const print = await fingerprint(handle, index);
      if (!print) {
        this.indexes.delete(transcriptPath);
        return null;
      }
      index.headHash = print.head;
      index.tailHash = print.tail;
      index.size = opened.size;
      index.mtimeMs = opened.mtimeMs;
      this.remember(transcriptPath, index);
      return index;
    } catch {
      this.indexes.delete(transcriptPath);
      return null;
    } finally {
      await handle.close().catch(() => { /* already gone — nothing to release */ });
    }
  }
}
