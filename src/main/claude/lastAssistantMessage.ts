import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import {
  locationIdentity,
  prepareLocationCommand,
  toHostAccessiblePath,
  type ActiveSessionContext,
  type LocationError,
  type SessionLocation,
} from '../../shared/sessionLocation';
import { createTranscriptProbeCache, type ProbeOutcome } from './transcriptProbeCache';

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

export type AsyncTranscriptCommandRunner = (
  file: string,
  args: readonly string[],
  options: TranscriptCommandOptions,
) => Promise<Buffer>;

/**
 * The two ways this module runs a guest command, injected as one unit.
 *
 * Call sites that need an answer now are synchronous; the probe cache's
 * out-of-band refresh is not, and must not be, or it would block the daemon
 * event loop it exists to protect. Binding both halves together is what lets a
 * test replace the real pair wholesale — the previous design compared the
 * injected runner against the real one by identity to decide whether a refresh
 * was allowed to spawn, which put a production-vs-test check in production.
 */
export interface TranscriptProber {
  sync: TranscriptCommandRunner;
  async: AsyncTranscriptCommandRunner;
}

const runTranscriptCommand: TranscriptCommandRunner = (file, args, options) =>
  execFileSync(file, [...args], options);

const runTranscriptCommandAsync: AsyncTranscriptCommandRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { ...options, encoding: 'buffer' }, (error, stdout, stderr) => {
      // A non-zero exit that still produced output is an answer: the guest helper
      // writes '1' and exits, and a warning on stderr must not discard that.
      if (error && !stdout?.length) {
        reject(Object.assign(error, { stderr }));
        return;
      }
      resolve(stdout);
    });
  });

const defaultProber: TranscriptProber = {
  sync: runTranscriptCommand,
  async: runTranscriptCommandAsync,
};

/**
 * Accept either half-seam for backwards compatibility with call sites that only
 * inject a synchronous runner.
 *
 * A lone injected runner also drives the refresh, on a microtask — so a caller
 * that replaced the command execution never reaches a real `wsl.exe`, and the
 * decision rests on the shape of what was passed rather than on comparing it to
 * the production function.
 */
function toProber(run?: TranscriptCommandRunner | TranscriptProber): TranscriptProber {
  if (!run) return defaultProber;
  if (typeof run !== 'function') return run;
  return {
    sync: run,
    async: (file, args, options) => Promise.resolve().then(() => run(file, args, options)),
  };
}

function resolveHostTranscriptPath(
  transcriptPath: string,
  context?: TranscriptReadContext,
): string | null {
  if (!context) return transcriptPath;
  const resolved = toHostAccessiblePath(context.location, transcriptPath);
  return resolved.ok ? resolved.path : null;
}

function hostTranscriptLives(hostPath: string): boolean {
  try {
    return fs.lstatSync(hostPath).isFile();
  } catch {
    return false;
  }
}

function readHostTranscriptTail(hostPath: string): Buffer | null {
  try {
    const st = fs.lstatSync(hostPath);
    if (!st.isFile()) return null;
    const safeReadFlags =
      fs.constants.O_RDONLY
      | (fs.constants.O_NONBLOCK ?? 0)
      | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(hostPath, safeReadFlags);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) return null;
      const start = Math.max(0, opened.size - TAIL_BYTES);
      const buf = Buffer.alloc(opened.size - start);
      const read = fs.readSync(fd, buf, 0, buf.length, start);
      return buf.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function missingGuestPython(error: unknown, stderr?: Buffer | string): boolean {
  const detail = [
    error instanceof Error ? error.message : String(error),
    stderr?.toString() ?? '',
    (error as { stderr?: Buffer | string } | null)?.stderr?.toString() ?? '',
  ].join('\n');
  return /(?:execvpe\(python3\) failed|python3.*(?:not found|no such file))/i.test(detail);
}

/**
 * WSL guarantees the host UNC bridge, but not guest Python. Keep the
 * timeout-bounded guest helper as the primary path; if that one dependency is
 * absent, use the same no-follow/non-blocking host reader via \\wsl.localhost
 * rather than discarding the exact resume binding.
 *
 * The two ways this can fail are not the same answer. An `lstat` through the
 * bridge that says "not a regular file" IS evidence of absence; failing to map
 * the guest path to a host one at all is not, and must not be recorded as
 * though the transcript were gone.
 */
function hostWslProbeOutcome(
  transcriptPath: string,
  context: TranscriptReadContext,
): ProbeOutcome {
  const hostPath = resolveHostTranscriptPath(transcriptPath, context);
  if (!hostPath) return { status: 'unreachable' };
  return { status: 'answered', lives: hostTranscriptLives(hostPath) };
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

const TRANSCRIPT_COMMAND_OPTIONS: TranscriptCommandOptions = {
  timeout: WSL_READ_TIMEOUT_MS,
  maxBuffer: TAIL_BYTES,
  windowsHide: true,
};

/**
 * The one place a guest transcript command is constructed.
 *
 * The probe and the tail differ only by the mode argument handed to the helper
 * script, and both must carry the same distro binding and the same bounds — so
 * spelling the command twice let the two paths drift, which is how the async
 * refresh ended up bypassing the injected runner entirely.
 */
function buildTranscriptCommand(
  transcriptPath: string,
  mode: 'probe' | 'tail',
  context: TranscriptReadContext,
) {
  return prepareLocationCommand(
    context.location,
    'python3',
    ['-c', WSL_TRANSCRIPT_SCRIPT, mode, transcriptPath],
    context.activeSession,
  );
}

/**
 * Refusals are not all the same answer.
 *
 * A distro mismatch is real evidence: this location cannot own that file, and no
 * retry will change it. The rest fire *before* any distro is known — a durable
 * location that has not resolved its distribution yet, or a caller with no
 * active session context — which is the ordinary state of a WSL pane recovered
 * after a reboot, exactly the case that must not be read as absence.
 */
function outcomeForRefusal(error: LocationError): ProbeOutcome {
  if (error === 'WSL_DISTRO_MISMATCH') return { status: 'answered', lives: false };
  return { status: 'unreachable' };
}

/** The one rule for a probe that threw: only a missing guest Python earns the
 *  host fallback, and everything else is unproven rather than absent. */
function outcomeForProbeFailure(
  error: unknown,
  stderr: Buffer | string | undefined,
  transcriptPath: string,
  context: TranscriptReadContext,
): ProbeOutcome {
  if (missingGuestPython(error, stderr)) return hostWslProbeOutcome(transcriptPath, context);
  return { status: 'unreachable' };
}

/** The guest helper writes '1' only after both of its checks pass, so anything
 *  else is a probe that ran and found no usable regular file. */
function outcomeForProbeOutput(stdout: Buffer): ProbeOutcome {
  return { status: 'answered', lives: stdout.toString() === '1' };
}

function probeWslTranscript(
  transcriptPath: string,
  context: TranscriptReadContext,
  run: TranscriptCommandRunner,
): ProbeOutcome {
  const prepared = buildTranscriptCommand(transcriptPath, 'probe', context);
  if (!prepared.ok) return outcomeForRefusal(prepared.error);
  try {
    return outcomeForProbeOutput(run(prepared.file, prepared.args, TRANSCRIPT_COMMAND_OPTIONS));
  } catch (error) {
    return outcomeForProbeFailure(error, undefined, transcriptPath, context);
  }
}

async function probeWslTranscriptAsync(
  transcriptPath: string,
  context: TranscriptReadContext,
  run: AsyncTranscriptCommandRunner,
): Promise<ProbeOutcome> {
  const prepared = buildTranscriptCommand(transcriptPath, 'probe', context);
  if (!prepared.ok) return outcomeForRefusal(prepared.error);
  try {
    return outcomeForProbeOutput(
      await run(prepared.file, prepared.args, TRANSCRIPT_COMMAND_OPTIONS),
    );
  } catch (error) {
    return outcomeForProbeFailure(
      error,
      (error as { stderr?: Buffer | string } | null)?.stderr,
      transcriptPath,
      context,
    );
  }
}

function readWslTranscriptTail(
  transcriptPath: string,
  context: TranscriptReadContext,
  run: TranscriptCommandRunner,
): Buffer | null {
  const prepared = buildTranscriptCommand(transcriptPath, 'tail', context);
  if (!prepared.ok) return null;
  try {
    return run(prepared.file, prepared.args, TRANSCRIPT_COMMAND_OPTIONS);
  } catch (error) {
    if (!missingGuestPython(error)) return null;
    const hostPath = resolveHostTranscriptPath(transcriptPath, context);
    return hostPath ? readHostTranscriptTail(hostPath) : null;
  }
}

/**
 * The WSL probe cache — TTL, bound, single-flight and the error-retention rule
 * all live in `transcriptProbeCache`. Created with its own defaults so the
 * production TTL and cap cannot drift from the ones its tests pin.
 */
const wslProbeCache = createTranscriptProbeCache();

function probeCacheKey(transcriptPath: string, context: TranscriptReadContext): string {
  // The active session's distro participates in the answer (a mismatch against
  // the location's own distro refuses to execute), so it participates in the key.
  return [
    locationIdentity(context.location),
    context.activeSession?.distro ?? '',
    transcriptPath,
  ].join('\0');
}

/** Test seam — the probe cache outlives a single call by design. */
export function __resetTranscriptProbeCache(): void {
  wslProbeCache.reset();
}

/** Settle in-flight probe refreshes — for tests that assert post-refresh state. */
export function __whenTranscriptProbesIdle(): Promise<void> {
  return wslProbeCache.whenIdle();
}

/** Safe, best-effort transcript liveness/type probe for recovery and UI use. */
export function transcriptFileLives(
  transcriptPath: string,
  context?: TranscriptReadContext,
  run?: TranscriptCommandRunner | TranscriptProber,
): boolean {
  if (context?.location.domain === 'wsl') {
    const prober = toProber(run);
    return wslProbeCache.lives(
      probeCacheKey(transcriptPath, context),
      () => probeWslTranscript(transcriptPath, context, prober.sync),
      () => probeWslTranscriptAsync(transcriptPath, context, prober.async),
    );
  }
  const hostPath = resolveHostTranscriptPath(transcriptPath, context);
  return hostPath ? hostTranscriptLives(hostPath) : false;
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
  run?: TranscriptCommandRunner | TranscriptProber,
): LastAssistantMessage | null {
  let raw: string;
  if (context?.location.domain === 'wsl') {
    // The tail has no assume-alive rule: a read that could not run has no
    // message to report, so an unreachable guest still resolves to null here.
    const result = readWslTranscriptTail(transcriptPath, context, toProber(run).sync);
    if (!result) return null;
    raw = result.toString('utf8');
  } else {
    const hostPath = resolveHostTranscriptPath(transcriptPath, context);
    if (!hostPath) return null;
    const result = readHostTranscriptTail(hostPath);
    if (!result) return null;
    raw = result.toString('utf8');
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
