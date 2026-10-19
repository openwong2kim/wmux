// The turn end of a Claude Code turn that died on an API error, for installs
// that never registered the `StopFailure` hook.
//
// Claude Code fires `StopFailure` INSTEAD of `Stop` when a turn ends on an API
// error, and only when a StopFailure hook is registered. Installs made before
// that hook existed (and every account dir provisioned from one: the account's
// settings.json is a one-time copy) register `UserPromptSubmit` but not
// `StopFailure`, so the prompt hook opened the turn and nothing ever closed it:
// the pane read `running` forever after e.g. "organization has disabled Claude
// subscription access". The transcript records that turn end anyway, as an
// assistant entry with `isApiErrorMessage: true` and the same `error` code the
// hook would carry.
//
// This module reads no file of its own: TranscriptActivityWatcher's tail hands
// it every Claude line it reads. It decides when such an entry stands in for
// the missing hook, and the daemon then feeds HookIngest the exact
// `agent.stop_failure` the hook would have sent.
//
// Rules, each from a way this could go wrong:
//   - The hook wins. A StopFailure or Stop hook for the pane that arrived no
//     earlier than the entry was written, and after the turn's prompt, means
//     the install has the hook: nothing is sent. The previous turn's Stop
//     does not count.
//   - Only a turn end. A later assistant or user entry before the grace runs
//     out means the turn went on, so the entry was not its end. So does a new
//     prompt hook (a retry), and an entry older than that prompt is ignored.
//   - Only the pane that still reads the file. Two panes bound to one
//     transcript (a resumed session) read it one at a time; an entry the
//     losing pane read before the handover is not its turn end.
//   - Only the pane's current open turn. The entry's own timestamp must fall
//     in the turn that is open now (`isCurrentOpenTurn`), so an error from an
//     earlier turn, or one a new prompt has already moved past, closes nothing.

import type { AgentSignal, AgentSlug } from '../../shared/hooks/signal-types';

const PROMPT_ID = /"promptId":"([0-9a-f-]{8,64})"/;

/** How long the real hook gets to arrive before the transcript speaks. A hook
 *  fires right after Claude Code writes the entry and runs on a 2s budget. */
export const GRACE_MS = 5000;
/** Same bound the phone failure card clips Claude's text to. */
const MAX_MESSAGE_CHARS = 2000;

export interface ApiErrorTurnEnd {
  /** Claude Code's error code (`rate_limit`, `oauth_org_not_allowed`, …). */
  error: string;
  /** The text Claude showed for it. */
  message: string;
  /** The entry's own timestamp (ms). */
  at: number;
  /** The `promptId` of the turn's user entry, read before it in the same
   *  file: the `prompt_id` Claude Code puts on every hook of that turn. */
  promptId?: string;
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/**
 * The API-error turn end one transcript line records, or null. `error` is kept
 * only when it is code-shaped: the usage-limit registry and the phone failure
 * classifier switch on it, and `unknown` is what Claude Code itself reports
 * when it has none. An entry without a readable timestamp cannot be placed in
 * a turn, so it is not one.
 */
export function apiErrorFromTranscriptLine(line: string): ApiErrorTurnEnd | null {
  if (!line.includes('"isApiErrorMessage":true')) return null;
  let o: Record<string, unknown>;
  try {
    o = record(JSON.parse(line));
  } catch {
    return null;
  }
  // A subagent's failure is not the pane's turn end.
  if (o.type !== 'assistant' || o.isApiErrorMessage !== true || o.isSidechain === true) return null;
  const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
  if (!Number.isFinite(at)) return null;
  const error = typeof o.error === 'string' && /^[a-z0-9_]{1,64}$/.test(o.error) ? o.error : 'unknown';
  const content = record(o.message).content;
  let message = '';
  if (typeof content === 'string') message = content;
  else if (Array.isArray(content)) {
    message = content
      .map((block) => record(block).text)
      .filter((text): text is string => typeof text === 'string' && text.length > 0)
      .join('\n');
  }
  return { error, message: message.trim().slice(0, MAX_MESSAGE_CHARS), at };
}

/** A conversation entry of the pane's own turn that is not an API error: the
 *  turn is still going. So is a queued prompt Claude Code starts on its own
 *  (its UserPromptSubmit fired when it was queued). A subagent's entry is not:
 *  a background subagent can write after the lead turn already died. */
function isTurnProgress(line: string): boolean {
  return /"type":"(assistant|user|queued_command)"/.test(line)
    && !line.includes('"isApiErrorMessage":true')
    && !line.includes('"isSidechain":true');
}

export interface ApiErrorTurnEndDeps {
  /** The daemon's turn bookkeeping: a turn is open on the pane and `at` falls in it. */
  isCurrentOpenTurn: (sessionId: string, at: number) => boolean;
  /** The pane still reads `path`. A pane that lost a transcript it shared with
   *  another pane no longer speaks for what it read there; the pane that kept
   *  it has replayed the same entry for itself. */
  isReader: (sessionId: string, path: string) => boolean;
  /** Feed the synthesized signal into the hook ingest. Null: the pane's binding no longer vouches for `path`. */
  signalFor: (sessionId: string, path: string, end: ApiErrorTurnEnd) => AgentSignal | null;
  emit: (signal: AgentSignal) => void;
  now?: () => number;
}

interface Pending {
  end: ApiErrorTurnEnd;
  path: string;
  seenAt: number;
}

export class ApiErrorTurnEnds {
  private readonly pending = new Map<string, Pending>();
  /** Newest turn-closing hook (Stop / StopFailure) since the pane's last prompt. */
  private readonly turnEndHookAt = new Map<string, number>();
  /** When the pane's last prompt hook fired. Claude Code runs the hook before
   *  it sends the prompt, so an error of that turn is written after this; an
   *  older one belongs to a turn the prompt moved past. */
  private readonly promptAt = new Map<string, number>();
  /** The `promptId` of the latest lead entry that carried one, per pane. */
  private readonly lastPromptId = new Map<string, string>();
  /** The `prompt_id` of the pane's last prompt hook: the same id, for a turn
   *  whose user entry the watcher never read (it was before a replay window). */
  private readonly hookPromptId = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly deps: ApiErrorTurnEndDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** One complete line of the pane's Claude transcript, in file order. */
  noteLine(sessionId: string, path: string, line: string): void {
    const promptId = PROMPT_ID.exec(line)?.[1];
    if (promptId && !line.includes('"isSidechain":true')) this.lastPromptId.set(sessionId, promptId);
    const end = apiErrorFromTranscriptLine(line);
    if (end && end.at < (this.promptAt.get(sessionId) ?? -Infinity)) return;
    const turnPrompt = this.lastPromptId.get(sessionId);
    if (end) this.pending.set(sessionId, { end: turnPrompt ? { ...end, promptId: turnPrompt } : end, path, seenAt: this.now() });
    else if (this.pending.has(sessionId) && isTurnProgress(line)) this.pending.delete(sessionId);
  }

  /** The watcher skipped lines of the pane's transcript. A pending error may
   *  have been followed by the turn going on, so it no longer stands for the
   *  turn end; an error in what was read after the gap arrives as a line. */
  noteGap(sessionId: string): void {
    this.pending.delete(sessionId);
    // The turn's user entry may have been in what was skipped.
    this.lastPromptId.delete(sessionId);
  }

  /** Every resolved hook signal for the session; `ts` is when the hook fired,
   *  `promptId` its Claude Code `prompt_id`. */
  noteHookSignal(sessionId: string, kind: string, ts?: number, promptId?: string): void {
    // Compared with the entry's own time, so the hook's firing time, not its
    // arrival: a Stop delayed past a later error does not speak for it.
    const at = typeof ts === 'number' && Number.isFinite(ts) ? ts : this.now();
    if (kind === 'agent.stop' || kind === 'agent.stop_failure') this.turnEndHookAt.set(sessionId, at);
    // A new turn (a retry too): the last turn's end hook and its error speak
    // for nothing in it.
    else if (kind === 'agent.user_prompt_submit') {
      this.turnEndHookAt.delete(sessionId);
      // A hook ingested late (a stalled daemon) keeps its own turn's error.
      const p = this.pending.get(sessionId);
      if (p && p.end.at < at) this.pending.delete(sessionId);
      this.promptAt.set(sessionId, at);
      if (promptId) this.hookPromptId.set(sessionId, promptId);
      else this.hookPromptId.delete(sessionId);
    }
    // A new session: whatever the old one wrote is not this pane's turn now.
    else if (kind === 'agent.session_start') {
      this.pending.delete(sessionId);
      this.turnEndHookAt.delete(sessionId);
      this.lastPromptId.delete(sessionId);
      this.hookPromptId.delete(sessionId);
    }
  }

  /** The pane closed or its PTY died. */
  dropSession(sessionId: string): void {
    this.pending.delete(sessionId);
    this.turnEndHookAt.delete(sessionId);
    this.promptAt.delete(sessionId);
    this.lastPromptId.delete(sessionId);
    this.hookPromptId.delete(sessionId);
  }

  /** Decide every entry whose grace ran out. */
  settle(): void {
    const now = this.now();
    for (const [id, p] of [...this.pending]) {
      if (now - p.seenAt < GRACE_MS) continue;
      this.pending.delete(id);
      // A turn-end hook that came after the entry was written is the installed
      // hook speaking for it (the hook fires right after the write).
      const hookEnd = this.turnEndHookAt.get(id);
      if (hookEnd !== undefined && hookEnd >= p.end.at) continue;
      if (!this.deps.isReader(id, p.path)) continue;
      if (!this.deps.isCurrentOpenTurn(id, p.end.at)) continue;
      // With the turn's user entry unread (before a replay window), the latest
      // prompt hook that fired before the entry names the turn: same id. Read
      // here, so a prompt hook that arrives after the entry still counts.
      const hookPrompt = this.hookPromptId.get(id);
      const end = !p.end.promptId && hookPrompt && (this.promptAt.get(id) ?? Infinity) <= p.end.at
        ? { ...p.end, promptId: hookPrompt }
        : p.end;
      const signal = this.deps.signalFor(id, p.path, end);
      if (signal) this.deps.emit(signal);
    }
  }
}

/** The `agent.stop_failure` a StopFailure hook would have sent for `end`. */
export function stopFailureSignal(
  ptyId: string,
  binding: { agent: AgentSlug; sessionId: string; cwd: string },
  end: ApiErrorTurnEnd,
  ts: number,
): AgentSignal {
  return {
    kind: 'agent.stop_failure',
    agent: binding.agent,
    agentSessionId: binding.sessionId,
    cwd: binding.cwd,
    ptyId,
    // Sent now: the turn it ends was already matched on the entry's own time.
    ts,
    payload: { error: end.error, last_assistant_message: end.message, ...(end.promptId ? { prompt_id: end.promptId } : {}) },
  };
}
