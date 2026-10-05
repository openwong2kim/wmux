// TranscriptActivityWatcher — the Fleet "now doing" line for agents that send
// no per-tool hook. A `wmux setup-hooks` install has no wide PostToolUse hook
// (removed for its per-tool-call cost), and Codex never had one, so those
// panes reported no tool activity at all. The agent writes every tool call to
// its own transcript anyway: this tails the APPENDED bytes of that file and
// reports the last tool's summary through the same `activity` metadata a
// PostToolUse hook would have produced.
//
// Rules, each from a way this could go wrong:
//   - A hook wins. A session that delivers any `agent.activity` hook is
//     hook-fed until its next session start; its watcher stops and stays off,
//     so the two sources never alternate on one row.
//   - Never revive a finished pane. An activity-only update marks the pane
//     running, so a line is sent only while the tail shows a turn in progress
//     (its newest event is a tool call or result). A tail that ends on the
//     agent's reply sends nothing; Codex's own turn-end record sends a clear.
//   - Appended bytes only, bounded. A watcher starts at the file's current end
//     (no history replay), reads at most READ_CAP_BYTES per tick, and skips to
//     the last JUMP_WINDOW_BYTES when it falls far behind. Per-session state is
//     a path, an offset and the last line sent.
//   - Lifecycle by reconcile. One unref'd timer; each tick re-derives the set
//     of sessions that should be watched (live agent, readable transcript,
//     supported agent, not hook-fed) and drops the rest, so an agent exit or a
//     closed pane can never leak a watcher.

import type { ResumeBinding } from '../../shared/agentResume';
import type { TurnEvent } from '../../shared/transcript/turnEvents';
import { parseTranscriptLine } from './parseEntry';
import { parseCodexLineDetailed } from './parseCodexEntry';
import { readTranscriptDelta, readTranscriptPage, statTranscript } from './readTail';
import { MAX_RAW_LEN, summarizeActivity } from '../../shared/activitySummary';

/** Most bytes read for one session in one tick. */
export const READ_CAP_BYTES = 256 * 1024;
/** When further behind than READ_CAP_BYTES, resume from this tail window. */
export const JUMP_WINDOW_BYTES = 64 * 1024;
const DEFAULT_POLL_MS = 1500;
/** Minimum spacing of two lines for one session (a clear is never held). */
const DEFAULT_MIN_GAP_MS = 2000;

type ParseLine = (line: string, offset: number) => TurnEvent[];

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
  /** True while the pane's agent process is alive. */
  isAgentAlive: (sessionId: string) => boolean;
  /** Report a line ('' clears) for the session. */
  emit: (sessionId: string, activity: string) => void;
  now?: () => number;
  pollMs?: number;
  minGapMs?: number;
}

interface Watch {
  path: string;
  parse: ParseLine;
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
  let lastTool: string | undefined;
  for (const event of events) if (event.kind === 'tool_use' && event.argSummary) lastTool = event.argSummary;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === 'meta') {
      if (event.subtype === 'turn_complete' || event.subtype === 'turn_aborted') return '';
      continue;
    }
    if (event.kind === 'tool_use' || event.kind === 'tool_result') return lastTool ?? null;
    // The agent's reply or a new prompt: not mid-tool, so nothing to report.
    return null;
  }
  return null;
}

export class TranscriptActivityWatcher {
  private readonly watches = new Map<string, Watch>();
  private readonly hookFed = new Set<string>();
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
  }

  /** Sessions currently tailed (tests and diagnostics). */
  watchedSessions(): string[] {
    return [...this.watches.keys()];
  }

  /** Every resolved hook signal for the session. */
  noteHookSignal(sessionId: string, kind: string): void {
    if (kind === 'agent.activity') {
      this.hookFed.add(sessionId);
      this.watches.delete(sessionId);
    } else if (kind === 'agent.session_start') {
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
  }

  tick(): void {
    const live = new Set(this.deps.listSessionIds());
    for (const id of [...this.hookFed]) if (!live.has(id)) this.hookFed.delete(id);
    for (const [id] of this.watches) if (!live.has(id)) this.watches.delete(id);
    for (const id of live) {
      try {
        this.reconcile(id);
        const watch = this.watches.get(id);
        if (watch) this.read(id, watch);
      } catch {
        // One unreadable transcript must never stop the others.
        this.watches.delete(id);
      }
    }
  }

  private reconcile(id: string): void {
    const binding = this.hookFed.has(id) || !this.deps.isAgentAlive(id) ? undefined : this.deps.getBinding(id);
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
    this.watches.set(id, { path, parse, offset: stat.size, sentAt: 0 });
  }

  private read(id: string, watch: Watch): void {
    const stat = statTranscript(watch.path);
    if (!stat) {
      this.watches.delete(id);
      return;
    }
    let events: TurnEvent[] = [];
    if (stat.size < watch.offset) {
      // Rewritten or rotated: re-seat at the new end, report nothing.
      watch.offset = stat.size;
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
    const next = activityFromEvents(events);
    if (next !== null) watch.pending = next;
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
