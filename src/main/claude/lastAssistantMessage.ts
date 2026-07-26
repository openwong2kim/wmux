import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  prepareLocationCommand,
  toHostAccessiblePath,
  type ActiveSessionContext,
  type SessionLocation,
} from '../../shared/sessionLocation';

/**
 * Read the tail of a Claude Code transcript and extract the final assistant
 * message, plus whether that message ends by asking the human something.
 *
 * Why this exists: an `agent.stop` wake used to reach the orchestrator with no
 * content at all — just "this pane stopped". The orchestrator's only way to
 * learn WHY it stopped was to `terminal_read` and read the rendered screen,
 * which is ambiguous: a proposal the agent printed ("shall I merge?") looks
 * exactly like text sitting in the input box. Orchestrators mis-read that twice
 * in one session, reported "still running" for a pane that was actually blocked
 * on a question, and pressed Enter expecting to submit a line that was never
 * there.
 *
 * The Stop hook already hands us `transcript_path` (hooks.rpc.ts stores it on
 * the resume binding), so the agent's own last words are available as
 * structured data. Reading them here means the wake event can carry the
 * question itself — the same treatment `pr.review_comment` already gives
 * reviewer text.
 */

/** Cap the tail we read. Transcripts grow to megabytes; the last message is at
 *  the end, and a bounded read keeps a stop-hook off the slow path. */
const TAIL_BYTES = 256 * 1024;
const WSL_READ_TIMEOUT_MS = 750;
/** Cap what we hand to the orchestrator — enough to convey a question, not so
 *  much that one pane's essay dominates the wake prompt. */
const MAX_TEXT = 600;

export interface LastAssistantMessage {
  /** Trailing slice of the final assistant message, whitespace-collapsed. */
  text: string;
  /** True when the message reads as a question aimed at the human. */
  endsWithQuestion: boolean;
}

export interface TranscriptReadContext {
  /** Location of the PTY that originated the hook, never inferred from the path. */
  location: SessionLocation;
  /** Verified live daemon session used to bind WSL execution to its distro. */
  activeSession?: ActiveSessionContext;
}

export interface TranscriptCommandOptions {
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
}

export type TranscriptCommandRunner = (
  file: string,
  args: readonly string[],
  options: TranscriptCommandOptions,
) => Buffer;

const runTranscriptCommand: TranscriptCommandRunner = (file, args, options) =>
  execFileSync(file, [...args], options);

function resolveHostTranscriptPath(
  transcriptPath: string,
  context?: TranscriptReadContext,
): string | null {
  if (!context) return transcriptPath;
  const resolved = toHostAccessiblePath(context.location, transcriptPath);
  return resolved.ok ? resolved.path : null;
}

/**
 * The guest helper performs both checks at the point of use:
 * - lstat must report a regular file (symlinks/FIFOs/devices are rejected);
 * - open uses O_NOFOLLOW + O_NONBLOCK, then fstat re-checks the descriptor.
 *
 * It writes at most TAIL_BYTES and receives the path as argv, never interpolated
 * into source or a shell command.
 */
const WSL_TRANSCRIPT_SCRIPT = [
  'import os, stat, sys',
  'mode, p = sys.argv[1], sys.argv[2]',
  'try:',
  ' s = os.lstat(p)',
  ' if not stat.S_ISREG(s.st_mode): raise OSError()',
  ' flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)',
  ' fd = os.open(p, flags)',
  ' try:',
  '  opened = os.fstat(fd)',
  '  if not stat.S_ISREG(opened.st_mode): raise OSError()',
  '  if mode == "probe": os.write(1, b"1")',
  `  else: os.lseek(fd, max(0, opened.st_size - ${TAIL_BYTES}), os.SEEK_SET); os.write(1, os.read(fd, ${TAIL_BYTES}))`,
  ' finally: os.close(fd)',
  'except (OSError, ValueError):',
  ' pass',
].join('\n');

function runWslTranscriptOperation(
  transcriptPath: string,
  mode: 'probe' | 'tail',
  context: TranscriptReadContext,
  run: TranscriptCommandRunner,
): Buffer | null {
  const prepared = prepareLocationCommand(
    context.location,
    'python3',
    ['-c', WSL_TRANSCRIPT_SCRIPT, mode, transcriptPath],
    context.activeSession,
  );
  if (!prepared.ok) return null;
  try {
    return run(prepared.file, prepared.args, {
      timeout: WSL_READ_TIMEOUT_MS,
      maxBuffer: TAIL_BYTES,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/** Safe, best-effort transcript liveness/type probe for recovery and UI use. */
export function transcriptFileLives(
  transcriptPath: string,
  context?: TranscriptReadContext,
  run: TranscriptCommandRunner = runTranscriptCommand,
): boolean {
  if (context?.location.domain === 'wsl') {
    return runWslTranscriptOperation(transcriptPath, 'probe', context, run)?.toString() === '1';
  }
  const hostPath = resolveHostTranscriptPath(transcriptPath, context);
  if (!hostPath) return false;
  try {
    return fs.lstatSync(hostPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Does this message end by asking the human something?
 *
 * Deliberately conservative: it looks only at the LAST non-empty line, because
 * an agent that asks mid-report and then keeps working is not blocked, while an
 * agent whose final line is a question is waiting on an answer. Korean question
 * endings are included — this repo's agents are routinely driven in Korean, and
 * a Korean question mostly ends in `-kka/-na/-ji` with no `?` at all.
 */
export function endsWithQuestion(text: string): boolean {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return false;
  // Strip trailing markdown emphasis/quotes so bold-wrapped questions still match.
  const tail = last.replace(/[*_`"')\]]+$/, '').trim();
  if (tail.endsWith('?') || tail.endsWith('？')) return true;
  // A Korean question may still be punctuated with a period; strip it before
  // testing the ending so trailing-period forms match the same as bare endings.
  const bare = tail.replace(/[.!。]+$/, '');
  // Korean interrogative endings, which routinely carry no '?' at all.
  //
  // Deliberately narrow. -yo and -ni endings were removed after review: ordinary
  // declaratives end in them constantly and a false positive is worse than a miss —
  // it makes the orchestrator announce a block that does not exist and "answer" a
  // statement. -kka-yo is listed explicitly because -kka alone misses the most
  // common polite proposal form, which was the exact bug class this function exists to catch.
  return /(까|까요|나요|는지|을지|ㄹ지)$/.test(bare);
}

/** Collapse runs of blank lines and trim to MAX_TEXT from the END (the tail of
 *  a message carries the ask; the head is usually recap). */
function condense(raw: string): string {
  const cleaned = raw.replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length <= MAX_TEXT) return cleaned;
  // The ellipsis counts against the cap — `text` is documented as <= MAX_TEXT
  // and a consumer sizing a buffer off that number should not be surprised.
  return `…${cleaned.slice(-(MAX_TEXT - 1))}`;
}

/**
 * True when a `user` entry is real human input rather than a tool result.
 *
 * Claude Code records tool results as `user` entries too (content blocks of
 * type `tool_result`), so entry type alone cannot mark a human turn boundary.
 * Only an entry carrying actual text does.
 */
function isHumanTurn(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text',
  );
}

/** Pull the text out of one transcript entry's `message.content`. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('\n');
}

/**
 * Best-effort — every failure resolves to null and the caller falls back to the
 * old contentless event. A stop hook must never break because a transcript was
 * rotated, truncated mid-write, or written by an agent whose format we don't
 * know.
 */
export function readLastAssistantMessage(
  transcriptPath: string,
  context?: TranscriptReadContext,
  run: TranscriptCommandRunner = runTranscriptCommand,
): LastAssistantMessage | null {
  let raw: string;
  if (context?.location.domain === 'wsl') {
    const result = runWslTranscriptOperation(transcriptPath, 'tail', context, run);
    if (!result) return null;
    raw = result.toString('utf8');
  } else try {
    const hostPath = resolveHostTranscriptPath(transcriptPath, context);
    if (!hostPath) return null;
    // lstat, and only a regular file: `transcript_path` arrives from a hook
    // payload, and openSync on a FIFO blocks the MAIN process indefinitely —
    // there is no timeout to save us, the hook's budget cannot cancel a blocked
    // syscall, and the whole app stalls with it.
    const st = fs.lstatSync(hostPath);
    if (!st.isFile()) return null;
    const safeReadFlags =
      fs.constants.O_RDONLY
      | (fs.constants.O_NONBLOCK ?? 0)
      | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(hostPath, safeReadFlags);
    try {
      // Re-check the opened descriptor: the path could have been replaced
      // between lstat and open. O_NONBLOCK prevents a replacement FIFO from
      // hanging even on platforms without O_NOFOLLOW.
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) return null;
      const start = Math.max(0, opened.size - TAIL_BYTES);
      const buf = Buffer.alloc(opened.size - start);
      // Decode ONLY what was actually read. A transcript being truncated or
      // rotated concurrently would otherwise leave zero-fill in the tail and
      // corrupt the very last record — the one we came here for.
      const read = fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const lines = raw.split('\n');
  // A partial first line is expected whenever we seeked into the middle of the
  // file; JSON.parse rejects it and the loop moves on.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    // Stop at the last HUMAN turn. Walking past it would resurrect a question
    // the human has already answered: assistant asks -> human answers ->
    // assistant does tool-only work -> turn ends. Without this boundary the
    // reader walks back over the tool-only turns AND the answer, and
    // republishes the settled question as a fresh block.
    if (entry.type === 'user' || entry.message?.role === 'user') {
      if (isHumanTurn(entry.message?.content)) return null;
      continue; // tool_result — part of the assistant's own turn
    }
    if (entry.type !== 'assistant' && entry.message?.role !== 'assistant') continue;
    const text = textOf(entry.message?.content);
    // Tool-only assistant turns carry no text — keep walking back to the last
    // turn that actually said something to the human (bounded by the human
    // turn boundary above).
    if (!text.trim()) continue;
    return { text: condense(text), endsWithQuestion: endsWithQuestion(text) };
  }
  return null;
}
