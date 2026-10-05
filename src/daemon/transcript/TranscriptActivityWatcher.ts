// TranscriptActivityWatcher — the Fleet "now doing" line for agents that send
// no per-tool hook. A `wmux setup-hooks` install has no wide PostToolUse hook
// (removed for its per-tool-call cost), and Codex never had one, so those
// panes reported no tool activity at all. The agent writes every tool call to
// its own transcript anyway: this tails the APPENDED bytes of that file and
// reports the last tool's summary through the same `activity` metadata a
// PostToolUse hook would have produced.
//
// Rules, each from a way this could go wrong:
//   - A hook wins. A session whose hooks report its tools (HOOK_ACTIVITY_KINDS,
//     the same set main uses) is hook-fed until its next session start or its
//     agent's death; its watcher stops and stays off, so the two sources never
//     alternate on one row.
//   - Never revive a finished pane. An activity-only update marks the pane
//     running, so a line is sent only while the tail shows a turn in progress
//     (its newest event is a tool call or result). A batch that ends on the
//     agent's reply or a new prompt sends nothing and drops any line held back
//     by the gap; Codex's own turn-end record sends a clear.
//   - Positive liveness only. A pane is tailed while the process tracker says
//     its agent is alive, or (no attribution yet) while it has sent a live hook
//     (a prompt, a session start, a tool). After a death only a new session
//     start revives it: a late Stop from the dead agent does not. Two panes
//     bound to one transcript (a resumed session) keep only the one whose agent
//     spoke last.
//   - Appended bytes only, bounded. A watcher starts at the file's current end
//     (no history replay), reads at most READ_CAP_BYTES per tick, and skips to
//     the last JUMP_WINDOW_BYTES when it falls far behind. A replaced file (new
//     inode, or an offset that is no longer a line boundary) re-seats at the
//     end. Per-session state is a path, an inode, an offset and the last line.
//   - Lifecycle by reconcile. One unref'd timer; each tick re-derives the set
//     of sessions that should be watched and drops the rest, so an agent exit
//     or a closed pane can never leak a watcher.

import type { ResumeBinding } from '../../shared/agentResume';
import type { TurnEvent } from '../../shared/transcript/turnEvents';
import { parseTranscriptLine } from './parseEntry';
import { parseCodexLineDetailed } from './parseCodexEntry';
import { isLineBoundary, readTranscriptDelta, readTranscriptPage, statTranscript } from './readTail';
import { HOOK_ACTIVITY_KINDS } from '../../shared/hooks/hookActivityKinds';
import { MAX_RAW_LEN, summarizeActivity } from '../../shared/activitySummary';

/** Most bytes read for one session in one tick. */
export const READ_CAP_BYTES = 256 * 1024;
/** When further behind than READ_CAP_BYTES, resume from this tail window. */
export const JUMP_WINDOW_BYTES = 64 * 1024;
const DEFAULT_POLL_MS = 1500;
/** Minimum spacing of two lines for one session (a clear is never held). */
const DEFAULT_MIN_GAP_MS = 2000;

type ParseLine = (line: string, offset: number) => TurnEvent[];

/** Hook kinds that prove an agent is running in the pane (not a turn end). */
const LIVE_HOOK_KINDS: ReadonlySet<string> = new Set(['agent.session_start', 'agent.user_prompt_submit']);

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** The file a patch touches first (`*** Update File: …` / `*** Add File: …`).
 *  Inside an `exec` script the patch is a JS string, so its line breaks are a
 *  literal backslash-n and it ends at a quote. */
function patchedFile(text: string): string {
  return /\*\*\* (?:Update|Add|Delete) File: (.+?)(?:\\n|\n|["'`]|$)/.exec(text)?.[1]?.trim() ?? '';
}

/**
 * Codex names its tools differently from Claude (and current versions wrap
 * every call in one `exec` script), so the generic summary would read
 * "exec". Map a Codex call onto the Claude-shaped input summarizeActivity
 * already knows, so the line uses the same glyphs and the same caps.
 */
export function codexToolSummary(name: string, rawInput: unknown): string {
  const text = typeof rawInput === 'string' ? rawInput.slice(0, MAX_RAW_LEN) : '';
  const input = typeof rawInput === 'string' ? (() => { try { return record(JSON.parse(rawInput)); } catch { return {}; } })() : record(rawInput);
  const bash = (command: string) => summarizeActivity('Bash', { command });
  if (name === 'apply_patch') return summarizeActivity('Edit', { file_path: patchedFile(text || String(input.input ?? '')) });
  if (name === 'shell' || name === 'local_shell') {
    const argv = Array.isArray(input.command) ? input.command.filter((a): a is string => typeof a === 'string') : [];
    // `bash -lc "<script>"` → the script is the command.
    const script = argv.length >= 3 && /sh$/.test(argv[0]) && argv[1].startsWith('-') ? argv[2] : argv.join(' ');
    return script ? bash(script) : summarizeActivity(name, undefined);
  }
  if (name === 'exec_command' && typeof input.cmd === 'string') return bash(input.cmd);
  if (name === 'exec' && text) {
    // A script calling the host tools: the first call names the work.
    const patch = patchedFile(text);
    if (/tools\.apply_patch\b/.test(text) && patch) return summarizeActivity('Edit', { file_path: patch });
    const cmd = /tools\.exec_command\(\s*\{[^}]*?\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(text)?.[1];
    if (cmd) {
      let value = cmd.slice(1, -1);
      try { value = JSON.parse(cmd.startsWith('"') ? cmd : `"${value.replace(/"/g, '\\"')}"`) as string; } catch { /* keep the raw text */ }
      return bash(value);
    }
    const tool = /tools\.([A-Za-z_][\w]*)\s*\(/.exec(text)?.[1];
    if (tool) return summarizeActivity(tool, undefined);
  }
  return summarizeActivity(name, input);
}

/** Codex lines: the shared projection, with tool summaries in Codex terms. */
function parseCodexForActivity(line: string, offset: number): TurnEvent[] {
  const events = parseCodexLineDetailed(line, offset).events;
  if (!events.some((event) => event.kind === 'tool_use')) return events;
  const payload = (() => { try { return record(record(JSON.parse(line)).payload); } catch { return {}; } })();
  const summary = codexToolSummary(String(payload.name ?? ''), payload.arguments ?? payload.input);
  return events.map((event) => (event.kind === 'tool_use' ? { ...event, argSummary: summary } : event));
}

const PARSERS: Readonly<Record<string, ParseLine>> = {
  claude: parseTranscriptLine,
  codex: parseCodexForActivity,
};

export interface TranscriptActivityDeps {
  /** Live session ids (attached or detached PTYs). */
  listSessionIds: () => string[];
  /** The session's transcript binding — the projector's own resolver. */
  getBinding: (sessionId: string) => ResumeBinding | undefined;
  /**
   * The process tracker's word on the pane's agent: true alive, false died,
   * undefined never attributed. A false is sticky until the tracker re-arms,
   * so a hook signal from the pane after the death counts as a live agent
   * (a new `claude` in the same pane).
   */
  isAgentAlive: (sessionId: string) => boolean | undefined;
  /** Report a line ('' clears) for the session. */
  emit: (sessionId: string, activity: string) => void;
  now?: () => number;
  pollMs?: number;
  minGapMs?: number;
}

interface Watch {
  path: string;
  parse: ParseLine;
  /** The file's identity when the watch started; a new one means replaced. */
  ino: number;
  offset: number;
  /** The line last sent ('' after a clear, undefined at a turn's start). */
  sent?: string;
  sentAt: number;
  /** A line held back by the gap, sent on a later tick. */
  pending?: string;
}

/**
 * What a batch of new transcript events says about the activity line:
 * the newest tool summary while a turn is in progress, '' when the agent's
 * own turn-end record arrived, or null when there is nothing to say.
 */
export function activityFromEvents(events: readonly TurnEvent[]): string | null {
  return readBatch(events).line;
}

/**
 * The batch's verdict: `line` as activityFromEvents, and `quiet` when the
 * newest event says no tool is running (a reply, a prompt or a turn end), so
 * a line still held back must not be sent.
 */
function readBatch(events: readonly TurnEvent[]): { line: string | null; quiet: boolean } {
  let lastTool: string | undefined;
  for (const event of events) if (event.kind === 'tool_use' && event.argSummary) lastTool = event.argSummary;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === 'meta') {
      if (event.subtype === 'turn_complete' || event.subtype === 'turn_aborted') return { line: '', quiet: true };
      continue;
    }
    if (event.kind === 'tool_use' || event.kind === 'tool_result') return { line: lastTool ?? null, quiet: false };
    // The agent's reply or a new prompt: not mid-tool, so nothing to report.
    return { line: null, quiet: true };
  }
  return { line: null, quiet: false };
}

export class TranscriptActivityWatcher {
  private readonly watches = new Map<string, Watch>();
  private readonly hookFed = new Set<string>();
  /** Newest live hook (prompt, session start, tool) and session start per pane. */
  private readonly liveHookAt = new Map<string, number>();
  private readonly sessionStartAt = new Map<string, number>();
  /** When the tracker first reported the pane's agent dead. */
  private readonly deadSince = new Map<string, number>();
  /** Monotonic stamp, so two signals in one millisecond still order. */
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: TranscriptActivityDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.deps.pollMs ?? DEFAULT_POLL_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watches.clear();
    this.hookFed.clear();
    this.liveHookAt.clear();
    this.sessionStartAt.clear();
    this.deadSince.clear();
  }

  /** Sessions currently tailed (tests and diagnostics). */
  watchedSessions(): string[] {
    return [...this.watches.keys()];
  }

  /** Every resolved hook signal for the session. */
  noteHookSignal(sessionId: string, kind: string): void {
    const at = ++this.seq;
    if (LIVE_HOOK_KINDS.has(kind) || HOOK_ACTIVITY_KINDS.has(kind)) this.liveHookAt.set(sessionId, at);
    if (HOOK_ACTIVITY_KINDS.has(kind)) {
      this.hookFed.add(sessionId);
      this.watches.delete(sessionId);
    } else if (kind === 'agent.session_start') {
      this.sessionStartAt.set(sessionId, at);
      this.hookFed.delete(sessionId);
      this.watches.delete(sessionId);
    } else if (kind === 'agent.stop' || kind === 'agent.stop_failure' || kind === 'agent.user_prompt_submit') {
      // The hook cleared (or is about to replace) the line: the next tool is new.
      const watch = this.watches.get(sessionId);
      if (watch) { watch.sent = undefined; watch.pending = undefined; }
    }
  }

  /** The pane closed or its PTY died. */
  dropSession(sessionId: string): void {
    this.watches.delete(sessionId);
    this.hookFed.delete(sessionId);
    this.liveHookAt.delete(sessionId);
    this.sessionStartAt.delete(sessionId);
    this.deadSince.delete(sessionId);
  }

  /**
   * Positive evidence that this pane's agent runs: the tracker says alive,
   * or, unattributed, a live hook from the pane. After a recorded death only
   * the tracker or a session start newer than the death counts — a late Stop
   * from the dead agent does not.
   */
  private agentAlive(id: string): boolean {
    const tracked = this.deps.isAgentAlive(id);
    if (tracked === true) {
      this.deadSince.delete(id);
      return true;
    }
    if (tracked === false && !this.deadSince.has(id)) {
      this.deadSince.set(id, ++this.seq);
      // The dead agent's hooks no longer speak for this pane.
      this.hookFed.delete(id);
    }
    const dead = this.deadSince.get(id);
    if (dead !== undefined) return (this.sessionStartAt.get(id) ?? 0) > dead;
    return this.liveHookAt.has(id);
  }

  tick(): void {
    const live = new Set(this.deps.listSessionIds());
    for (const id of [...this.hookFed]) if (!live.has(id)) this.hookFed.delete(id);
    for (const map of [this.liveHookAt, this.sessionStartAt, this.deadSince]) {
      for (const id of [...map.keys()]) if (!live.has(id)) map.delete(id);
    }
    for (const [id] of this.watches) if (!live.has(id)) this.watches.delete(id);
    for (const id of live) {
      try {
        this.reconcile(id);
      } catch {
        this.watches.delete(id);
      }
    }
    this.dropSharedTranscripts();
    for (const [id, watch] of [...this.watches]) {
      try {
        this.read(id, watch);
      } catch {
        // One unreadable transcript must never stop the others.
        this.watches.delete(id);
      }
    }
  }

  /** One transcript, one pane: the pane whose agent spoke last keeps it. */
  private dropSharedTranscripts(): void {
    const byPath = new Map<string, string>();
    for (const [id, watch] of this.watches) {
      const other = byPath.get(watch.path);
      if (other === undefined) { byPath.set(watch.path, id); continue; }
      const keep = (this.liveHookAt.get(id) ?? 0) > (this.liveHookAt.get(other) ?? 0) ? id : other;
      this.watches.delete(keep === id ? other : id);
      byPath.set(watch.path, keep);
    }
  }

  private reconcile(id: string): void {
    const binding = this.hookFed.has(id) || !this.agentAlive(id) ? undefined : this.deps.getBinding(id);
    const parse = binding ? PARSERS[binding.agent] : undefined;
    const path = binding?.transcriptPath;
    const current = this.watches.get(id);
    if (!parse || !path) {
      this.watches.delete(id);
      return;
    }
    if (current && current.path === path) return;
    const stat = statTranscript(path);
    if (!stat) {
      this.watches.delete(id);
      return;
    }
    // Start at the end: only what the agent writes from now on.
    this.watches.set(id, { path, parse, ino: stat.ino, offset: stat.size, sentAt: 0 });
  }

  private read(id: string, watch: Watch): void {
    const stat = statTranscript(watch.path);
    if (!stat) {
      this.watches.delete(id);
      return;
    }
    let events: TurnEvent[] = [];
    const replaced = stat.ino !== watch.ino
      || (watch.offset > 0 && watch.offset <= stat.size && !isLineBoundary(watch.path, watch.offset));
    if (replaced || stat.size < watch.offset) {
      // Rewritten, replaced or rotated: re-seat at the new end, report nothing.
      watch.ino = stat.ino;
      watch.offset = stat.size;
      watch.pending = undefined;
    } else if (stat.size - watch.offset > READ_CAP_BYTES) {
      const page = readTranscriptPage(watch.path, { maxBytes: JUMP_WINDOW_BYTES, parseLine: watch.parse });
      if (!page) { this.watches.delete(id); return; }
      events = page.events;
      watch.offset = page.cursor.tailOffset;
    } else if (stat.size > watch.offset) {
      const delta = readTranscriptDelta(watch.path, watch.offset, READ_CAP_BYTES, watch.parse);
      if (!delta) { this.watches.delete(id); return; }
      if (delta.reset) watch.offset = stat.size;
      else {
        events = delta.events;
        watch.offset = delta.cursor.tailOffset;
      }
    }
    if (events.some((event) => event.kind === 'user_text')) watch.sent = undefined;
    const { line, quiet } = readBatch(events);
    // A turn that moved past its tools must not have a held-back line sent
    // later: nothing (an interrupt sends no Stop) would ever clear it.
    if (quiet) watch.pending = undefined;
    if (line !== null) watch.pending = line;
    this.flush(id, watch);
  }

  private flush(id: string, watch: Watch): void {
    const next = watch.pending;
    if (next === undefined) return;
    if (next === watch.sent) { watch.pending = undefined; return; }
    const now = this.now();
    if (next !== '' && now - watch.sentAt < (this.deps.minGapMs ?? DEFAULT_MIN_GAP_MS)) return;
    watch.pending = undefined;
    // A clear for a line never sent is noise.
    if (next === '' && !watch.sent) { watch.sent = ''; return; }
    watch.sent = next;
    watch.sentAt = now;
    this.deps.emit(id, next);
  }
}
