import crypto from 'node:crypto';
import { A2A_REMOTE_BODY_MAX } from '../../shared/a2aRemote';
import { truncateUtf8 } from '../../shared/chatv2/limits';
import type { SessionPromptScheduleResult } from '../../shared/sessionPromptSchedule';
import { sanitizeBracketedPastePayload } from '../../shared/ptyMessageDelivery';
import { localSideOf, type A2aRemoteInboxItem, type A2aRemoteTaskState } from '../../shared/a2aRemoteDelivery';
import { spawnFirstMessageId, type SpawnLinkId } from '../../shared/a2aSpawn';
import { TERMINAL_STATES, type Task } from '../../shared/types';
import type { TurnEvent } from '../../shared/transcript/turnEvents';
import { claudeUsageLimitFromStopFailure, isClaudeUsageLimitText, USAGE_LIMIT_CONTINUE_PROMPT, USAGE_LIMIT_RESUME_GRACE_MS } from '../../shared/usageLimit';
import { apiErrorFromTranscriptLine } from '../transcript/apiErrorTurnEnd';
import { parseTranscriptLine } from '../transcript/parseEntry';
import { readTranscriptDelta } from '../transcript/readTail';
import { SUBAGENT_COUNTERS, type SubagentCounter } from '../transcript/subagentCount';
import type { HeadlessStartRecordV1 } from './headlessStartStore';
import { errMsg } from './storeFile';

/**
 * Headless remote spawn, part two: the task a paired PC sent with its request
 * is typed into the agent the daemon started for it (headlessStarter.ts), and
 * the agent's answer goes back as the task's reply. What the asking PC sends
 * after that (follow-ups: a new task on the same link, or a reply on a task
 * that waits for more) is typed in one at a time, in the order it reached this
 * PC, when the policy lets follow-ups through (`--follow-ups direct`); with
 * `ask` it would wait for a person, and there is none here, so it is refused
 * at once with the reason.
 *
 * Only here, only in headless mode and only into a session a `started` start
 * of this daemon run owns; the app's bridge leaves `hl-` workspaces alone
 * (RemoteA2aBridge), so one deliverer types into each pane. The pane, prompt
 * and task functions are given (index.ts); nothing here opens a pane.
 *
 * The answer is read from the agent's transcript (Claude Code), not hooks: a
 * server host has none installed. The delivered prompt opens an "episode" when
 * its own user entry shows up; the first turn end after it with no background
 * work of the turn's still running closes the episode, and its last assistant
 * text is the reply. A turn end while such work runs (a background command, an
 * async agent, a Monitor) is progress: its text goes back as a reply and the
 * task stays `working` until the agent hears the work ended and ends a turn
 * with nothing left running, or for BACKGROUND_WAIT_MS at most. See `stepEpisode` for what else can happen in
 * between. After the answer, a turn nothing on this PC started (background
 * work the agent was not waited for, a wake it set itself) is sent as a
 * further reply on the task, a few times at most.
 */

export const HEADLESS_DELIVERY_TICK_MS = 1000;
/** First retry after a refusal that wrote nothing (the agent still starting, busy); doubles up to the max. */
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 5 * 60 * 1000;
/** How often the screen is checked for a question (a render each time). */
export const QUESTION_PROBE_MS = 10 * 1000;
/** A question on screen this long: the asking PC is told once. */
export const QUESTION_NOTICE_MS = 60 * 1000;
/** A question on screen this long: the task ends (the agent is left running). */
export const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;
export const QUESTION_REASON = 'the agent waits on a question on its screen that nobody on this PC can answer';
const QUESTION_NOTICE = 'The agent on that PC waits on a question on its screen that nobody there can answer. '
  + 'The task ends if the question is still there 10 minutes after it appeared.';
export const ASK_REASON = 'follow-ups need approval on this PC, which runs without a person; '
  + 'its owner can allow them with `wmux remote allow … --follow-ups direct`';
/** Background work still runs this long after the first turn that left it running: the answer goes, at the agent's next pause. */
export const BACKGROUND_WAIT_MS = 30 * 60 * 1000;
export const BACKGROUND_NOTE = 'Background work the agent started is still running on that PC. '
  + 'What the agent says when it ends may follow as another reply on this task.';
/** Replies sent on a task besides its answers (progress, and turns nothing on this PC started): at most this many. */
export const FURTHER_REPLIES_MAX = 5;
/** A usage-limit stop not gone on this long after its reset ends the task. */
export const LIMIT_RESUME_MARGIN_MS = 15 * 60 * 1000;
/** A usage-limit stop with no known reset ends the task after this long (the registry holds 5 h at most). */
export const LIMIT_UNKNOWN_MAX_MS = 6 * 60 * 60 * 1000;
/** After the reset, the screen is read at most this often. */
export const LIMIT_PROBE_MS = 10 * 1000;
/** Escape is pressed on the limit menu at most this many times. */
const LIMIT_ESCAPES_MAX = 3;

/** What the asking PC is told, once, when the agent stops at its usage limit. */
export function limitNotice(resetsAt: number | null): string {
  return resetsAt != null
    ? `The agent on that PC is at its usage limit until ${new Date(resetsAt).toISOString()}; it goes on after that.`
    : "The agent on that PC is at its usage limit; when it resets is not known.";
}

/** Why the task ends when the agent did not go on after its usage limit. */
export function limitReason(resetsAt: number | null): string {
  return resetsAt != null
    ? `that PC's agent did not go on after its usage limit reset at ${new Date(resetsAt).toISOString()}`
    : "that PC's agent is at its usage limit, and when it resets is not known";
}

/** How long a stopping daemon waits for the asking PCs to take what it queued for them. */
export const HEADLESS_STOP_FLUSH_MS = 2000;
export const DAEMON_STOPPED_REASON = 'the daemon on that PC stopped';

type MarkInput = { taskId: string; messageId?: string; attempted?: boolean; delivered?: true; ptyId?: string };

/** What is typed in: an inbound task, or a reply the asking PC sent on one (an inbox item). */
type Unit = { task: Task; item?: A2aRemoteInboxItem };
const unitKey = (taskId: string, messageId?: string): string => (messageId ? `${taskId}#${messageId}` : taskId);

export interface HeadlessDeliveryDeps {
  mode: { active(): boolean };
  /** The start records (the delivery owner is the start, by its workspace). */
  starts: { list(): HeadlessStartRecordV1[] };
  /** This daemon run (a start of an earlier run is not delivered to). */
  runId: string;
  tasks: {
    /** Remote tasks with something owed here (`A2aTaskService.listRemotePending`). */
    pending(): Task[];
    /** Every remote task (`A2aTaskService.listRemote`). */
    remote(): Task[];
    /** Remote tasks held for a person (`A2aTaskService.listRemoteHeld`). */
    held(): Task[];
    get(taskId: string): Task | undefined;
  };
  /** The daemon's own `a2a.remote.mark` (attempted / delivered), as main calls it. */
  mark(input: MarkInput): Promise<{ ok: boolean; error?: string }>;
  /**
   * Type `prompt` into the session and press Enter (`deliverPromptToSessionNow`).
   * `authorized` is asked before the first write and before Enter; `onWrite`
   * is told each time something may have reached the session.
   */
  deliver(
    sessionId: string,
    agent: HeadlessStartRecordV1['agent'],
    prompt: string,
    authorized: () => boolean,
    onWrite: () => void,
  ): Promise<SessionPromptScheduleResult>;
  /**
   * Have the daemon look for the agent process of this session now (its
   * process tracker). On a host with no hooks, only the screen banner would
   * otherwise start that, and until it does the pane counts as having no
   * agent (`unavailable`) and is never bound to its conversation. Asked only
   * for a session this delivery owns.
   */
  armAgent?(sessionId: string): void;
  /**
   * The agent's transcript shows it stopped at its usage limit: the daemon's
   * usage-limit hold for the session, set from that line (no hook on this PC).
   */
  noteLimit?(sessionId: string, message: string, at: number | null): void;
  /**
   * What the screen shows after a usage-limit reset: Claude Code's limit menu
   * as the last thing drawn (daemon/usageLimit/limitMenu.ts), no dialog at all,
   * or anything else.
   */
  limitScreen?(sessionId: string): Promise<'menu' | 'clear' | 'other'>;
  /** Escape on the limit menu, only while it is still the screen. True when written. */
  pressEscape?(sessionId: string): Promise<boolean>;
  /** The agent's transcript file, once the daemon has bound the session to its conversation; null before. */
  transcriptPath(sessionId: string): string | null;
  /** Its size now (0 when it does not exist yet). */
  transcriptSize(path: string): number;
  /** The spawn policy lets follow-ups through without a person (`--follow-ups direct`). */
  followUpsDirect(): boolean;
  /** The daemon's own `a2a.remote.rejectHeld`: a held task ends here and its sender is told the reason. */
  rejectHeld(input: { taskId: string; reason: string }): Promise<{ ok: boolean; error?: string }>;
  /**
   * What the session's screen shows, read as the delivery guard reads it: a
   * question (a permission dialog, a selection menu, the folder-trust prompt),
   * nothing of the kind, or cells it could not read.
   */
  questionOnScreen?(sessionId: string): Promise<'dialog' | 'clear' | 'unknown'>;
  /** The daemon holds this session for a usage limit (its own limit menu is on screen, and waited out). */
  limitHeld?(sessionId: string): boolean;
  /** The daemon's own `a2a.remote.reply`, as main calls it. */
  reply(input: { taskId: string; workspaceId: string; text: string; ptyId?: string }): Promise<{ ok: boolean; error?: string }>;
  /**
   * Commit a task state as its receiver and tell the peer (`transition` + sync).
   * `summary`: the reason (failed, canceled).
   */
  transition(input: { taskId: string; workspaceId: string; to: 'working' | 'input-required' | 'failed' | 'canceled'; summary?: string }): Promise<{ ok: boolean; error?: string }>;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
  now?: () => number;
}

/** One delivered task, from the write until its turn ended. */
export interface Episode {
  taskId: string;
  sessionId: string;
  workspaceId: string;
  /** sha256 of the prompt as typed (sanitized, CRLF→LF, trimmed). */
  promptHash: string;
  sentAt: number;
  /** Agent messages the task held at the write (more later: the agent replied itself). */
  agentMessagesAtSend: number;
  /** The transcript `offset` counts in; null until the session is bound to one. */
  path: string | null;
  /** Where the transcript is read from next (bytes); the file may not exist yet. */
  offset: number;
  /** The prompt's own user entry was seen. */
  opened: boolean;
  /** A usage-limit stop was seen; the daemon's own continue keeps the episode open. */
  limitStopped: boolean;
  /**
   * That stop: its message and the entry's time (from the transcript), then
   * when it was seen and its reset, the notice, and the way back (Escape on
   * the limit menu, the one continue).
   */
  limit?: {
    message: string;
    at: number | null;
    seenAt?: number;
    resetsAt?: number | null;
    noticed?: boolean;
    probedAt?: number;
    escapes?: number;
    clearSince?: number | null;
    continued?: boolean;
  };
  /** Text of the assistant entries since the last tool call: the answer so far. */
  answer: string[];
  /** The task was moved to `working` (a failed move is tried again). */
  working: boolean;
  /** How the turn ended, kept until the reply and the task's move both went through. */
  outcome: EpisodeOutcome | null;
  /**
   * The turn's last message stopped, but the entry said so carried no text (Claude Code
   * writes a message's thinking as its own entry, with the message's final stop reason):
   * its text may follow in the next entry of the same message. `at`: when that was seen.
   */
  endPending?: { messageId: string | null; at: number };
  /** The work the agent's turns left running in the background (Claude Code); none read for another agent. */
  work?: SubagentCounter | null;
  /** When the first turn end that left background work running was read (the wait is bounded from there). */
  waitingSince?: number | null;
  /** The agent is in a turn (it wrote since its last turn end). */
  busy?: boolean;
  /** The text of that turn end, and whether it went back as a reply. */
  lastProgress?: { text: string; sent: boolean } | null;
  /**
   * After the answer: a later turn's text whose reply did not go through, tried again before anything
   * after it is read; `copies`: how many agent messages on the task were that text before the try.
   */
  unsaid?: { text: string; copies: number } | null;
}

/** A thinking-only turn end with nothing after it closes this long after it was read. */
export const TURN_END_SETTLE_MS = 2000;

export type EpisodeOutcome =
  | { kind: 'answered'; text: string }
  | { kind: 'failed'; reason: string };

/**
 * What one transcript line did to an episode: an outcome, or a turn end while
 * background work runs (`progress`). `again`: the line that showed the end was
 * not read yet; it is read once the progress is handled.
 */
export type EpisodeStep = (EpisodeOutcome | { kind: 'progress'; text: string }) & { again?: true };

/** A turn ended: the answer, or progress while work it left runs. The buffer starts over either way. */
function turnEnd(ep: Episode): { kind: 'answered'; text: string } | { kind: 'progress'; text: string } {
  const text = ep.answer.join('\n\n');
  ep.answer = [];
  ep.endPending = undefined;
  ep.busy = false;
  return (ep.work?.background ?? 0) > 0 ? { kind: 'progress', text } : { kind: 'answered', text };
}

/** The hash a delivered prompt is recognized by in the transcript. */
export function promptHash(prompt: string): string {
  return hashOf(sanitizeBracketedPastePayload(prompt));
}

/**
 * A reply within the body limit: the start of `text`, cut on a code point,
 * then a marker naming the bytes left out. The marker counts in the limit.
 */
export function cutReply(text: string, max = A2A_REMOTE_BODY_MAX): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= max) return text;
  const marker = (n: number): string => `\n\n[… cut: ${n} bytes not sent]`;
  // The marker for all of it is the longest one this cut can need.
  const kept = truncateUtf8(text, max - Buffer.byteLength(marker(bytes), 'utf8'));
  return kept + marker(bytes - Buffer.byteLength(kept, 'utf8'));
}

/** Oldest first (when each reached this PC), so follow-ups are typed in the order they were sent. */
function oldestFirst(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => a.metadata.createdAt.localeCompare(b.metadata.createdAt) || a.id.localeCompare(b.id));
}

function hashOf(text: string): string {
  return crypto.createHash('sha256').update(text.replace(/\r\n?/g, '\n').trim()).digest('hex');
}

/** The entry's `type`, `stop_reason`, content and sidechain flag, from its raw line (null: not JSON). */
function rawEntry(line: string): { type?: unknown; stopReason?: unknown; content?: unknown; messageId: string | null; sidechain: boolean; typed: boolean } | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as { type?: unknown; isSidechain?: unknown; origin?: { kind?: unknown }; promptSource?: unknown; message?: { id?: unknown; stop_reason?: unknown; content?: unknown } };
  const messageId = typeof e.message?.id === 'string' ? e.message.id : null;
  // Typed at the agent's prompt on this PC (a prompt, a slash command, a `!` command), as Claude Code 2.1 marks it.
  const typed = e.type === 'user' && (e.origin?.kind === 'human' || e.promptSource === 'typed');
  return { type: e.type, stopReason: e.message?.stop_reason, content: e.message?.content, messageId, sidechain: e.isSidechain === true, typed };
}

function textOfContent(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  const blocks = content.filter((b): b is { type: 'text'; text: string } =>
    !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string');
  // A tool result (no text block of the user's own) is not a prompt.
  if (blocks.length === 0 || blocks.length !== content.length) return null;
  const text = blocks.map((b) => b.text).join('\n');
  return text.trim() ? text : null;
}

/**
 * The episode after one transcript line (its raw text and the events the
 * projector's parser reads from it), and how it ended, if it did:
 *  - the prompt's own user entry opens it. It is recognized on the raw entry:
 *    the parser shortens long text and reads some as commands or notes;
 *  - before it, any other user entry is input from this PC (ssh, a channel
 *    wake, an automation): the turn is not ours;
 *  - after it, the first turn end closes it with the assistant text since the
 *    last tool call as the answer. An assistant entry that stopped for any
 *    reason other than a tool call is a turn end too (end_turn, max_tokens,
 *    refusal, a stop sequence). A turn end while background work the turns
 *    started still runs is `progress`, and the episode stays open: the agent
 *    is woken when that work ends (the notification parses as meta), and its
 *    next turn end is read the same way;
 *  - an interrupt, or an API error other than a usage limit, fails it;
 *  - a usage-limit stop keeps it open, and so does the continue the daemon
 *    types once the limit resets (that exact prompt, after that stop);
 *  - any other user entry inside it is input from this PC: failed, no reply.
 * Compactions, slash commands and reminders parse as `meta`, not user text.
 */
export function stepEpisode(ep: Episode, line: string, events: readonly TurnEvent[]): EpisodeStep | null {
  const raw = rawEntry(line);
  // A subagent's entry (in the lead's file): not the prompt, not input, and its turn end is not the lead's.
  if (raw?.sidechain) return null;
  if (ep.endPending) {
    // The stopped message goes on in its next entry; anything else means the turn is over.
    const sameMessage = raw?.type === 'assistant' && ep.endPending.messageId !== null && raw.messageId === ep.endPending.messageId;
    if (!sameMessage) {
      // Decided before this line is read (it may be what ends the background work, after the turn); read next.
      return { ...turnEnd(ep), again: true };
    }
  }
  ep.work?.noteLine(line);
  // A conversation entry after a turn end: the agent is in a turn again.
  if (raw?.type === 'assistant' || raw?.type === 'user') ep.busy = true;
  if (!ep.opened) {
    const text = raw?.type === 'user' ? textOfContent(raw.content) : null;
    if (text !== null && hashOf(text) === ep.promptHash) {
      ep.opened = true;
      return null;
    }
  }
  const apiError = apiErrorFromTranscriptLine(line);
  if (apiError && ep.opened) {
    if (apiError.error === 'rate_limit' && isClaudeUsageLimitText(apiError.message)) {
      // A new stop (not the same one read again): its own notice, its own one continue.
      if (!ep.limitStopped) ep.limit = { message: apiError.message, at: apiError.at };
      ep.limitStopped = true;
      return null;
    }
    return { kind: 'failed', reason: `the agent's turn ended on an error: ${apiError.message || apiError.error}` };
  }
  // The agent writes on after its limit stop (Claude Code went on by itself): no continue is owed.
  if (ep.limitStopped && raw?.type === 'assistant') {
    ep.limitStopped = false;
    ep.limit = undefined;
  }
  let answered = false;
  for (const event of events) {
    if (event.kind === 'user_text') {
      if (!ep.opened) return { kind: 'failed', reason: 'the agent was given other input on this PC before the task' };
      if (ep.limitStopped && event.text.trim() === USAGE_LIMIT_CONTINUE_PROMPT) {
        ep.limitStopped = false;
        ep.limit = undefined;
        continue;
      }
      return { kind: 'failed', reason: "the agent's turn was taken over by input on this PC" };
    }
    if (!ep.opened) continue;
    if (event.kind === 'tool_use' || event.kind === 'tool_result') ep.answer = [];
    else if (event.kind === 'meta' && event.subtype === 'turn_aborted') return { kind: 'failed', reason: "the agent's turn was interrupted on this PC" };
    else if (event.kind === 'meta' && event.subtype === 'turn_complete') return turnEnd(ep);
    else if (event.kind === 'assistant_text' && !event.thinking && !answered) {
      // One entry may parse to several events: its text is taken once.
      const text = assistantTextOf(line);
      if (text !== null) ep.answer.push(text);
      answered = true;
    }
  }
  // The turn ended when the entry stopped for anything but a tool call. An entry with no text of
  // its own (thinking only) leaves the end pending: the message's text may be in its next entry.
  if (ep.opened && raw?.type === 'assistant' && typeof raw.stopReason === 'string' && raw.stopReason !== 'tool_use') {
    if (answered) return turnEnd(ep);
    ep.endPending = { messageId: raw.messageId, at: 0 };
  }
  return null;
}

/**
 * The text blocks of a raw assistant entry, joined; thinking and tool calls
 * left out. Read from the raw line because the parser replaces fenced code
 * with markers (turnEvents.ts), and a reply needs the code itself.
 */
export function assistantTextOf(line: string): string | null {
  const content = rawEntry(line)?.content;
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text || null;
}

export class HeadlessDelivery {
  private readonly deps: HeadlessDeliveryDeps;
  private readonly now: () => number;
  /** Open episodes by session (one task at a time per agent). */
  private readonly episodes = new Map<string, Episode>();
  private readonly retry = new Map<string, { at: number; waitMs: number }>();
  /** Marks that did not go through: retried before anything else is done with their task. */
  private readonly unsentMarks = new Map<string, MarkInput>();
  /** Sessions whose start is ending: nothing more is typed into them. */
  private readonly ending = new Set<string>();
  /** The question clock of each session's current task (owed, or in its turn). */
  private readonly questions = new Map<string, { since: number | null; probedAt: number; noticedTask: string | null }>();
  /** After an answer, by session: the transcript read on for turns nothing on this PC started. */
  private readonly afterwards = new Map<string, Episode>();
  /** Replies sent on each task besides its answers (progress, later turns): bounded by FURTHER_REPLIES_MAX. */
  private readonly further = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** Stopped (the daemon shutting down): a pass under way types nothing more. */
  private stopped = false;

  constructor(deps: HeadlessDeliveryDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), HEADLESS_DELIVERY_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: open episodes read, then owed tasks typed in. Never two at once; one failing item never stops the rest. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      for (const ep of [...this.episodes.values()]) {
        try {
          await this.follow(ep);
        } catch (err) {
          this.deps.log('warn', `[headless] task ${ep.taskId}: reading the agent's turn failed: ${errMsg(err)}`);
        }
      }
      for (const w of [...this.afterwards.values()]) {
        try {
          await this.followAfter(w);
        } catch (err) {
          this.deps.log('warn', `[headless] task ${w.taskId}: reading the agent's later turns failed: ${errMsg(err)}`);
        }
      }
      if (!this.deps.mode.active()) return;
      const starts = this.deps.starts.list();
      await this.refuseAsked(starts);
      // The task each session works on, or waits to: its question clock runs.
      const current = new Map<string, { taskId: string; workspaceId: string }>();
      // Sessions whose oldest owed task was looked at: a newer one waits behind it.
      const taken = new Set<string>();
      for (const task of oldestFirst(this.deps.tasks.pending())) {
        for (const unit of this.unitsOf(task)) {
          if (this.stopped) return;
          const key = unitKey(task.id, unit.item?.messageId);
          try {
            const rec = this.ownerOf(task, starts);
            if (!rec || taken.has(rec.sessionId)) continue;
            // A state the asking PC sent, or anything on a task that ended: nothing to type, recorded as handled.
            if (unit.item && (unit.item.kind !== 'reply' || this.ended(task.id))) {
              await this.markOrKeep({ taskId: task.id, messageId: unit.item.messageId, delivered: true });
              continue;
            }
            if (!unit.item && this.ended(task.id)) continue;
            taken.add(rec.sessionId);
            const idle = !this.episodes.has(rec.sessionId);
            const unsent = this.unsentMarks.get(key);
            if (unsent) {
              // Only the mark is tried again: nothing is typed a second time for it.
              if ((await this.markSafely(unsent)).ok) this.unsentMarks.delete(key);
              if (idle) current.set(rec.sessionId, { taskId: task.id, workspaceId: rec.workspaceId });
              continue;
            }
            // One turn at a time per agent: a reply on a task goes in after its task's own turn (that comes first here).
            if (!idle) continue;
            await this.offer(unit, rec);
            if (!this.episodes.has(rec.sessionId) && !this.ended(task.id)) current.set(rec.sessionId, { taskId: task.id, workspaceId: rec.workspaceId });
          } catch (err) {
            this.deps.log('warn', `[headless] task ${key}: not typed in: ${errMsg(err)}`);
            this.backoff(key);
          }
        }
      }
      // A turn that ended and is only being finished (its reply or move tried again) has no question clock.
      for (const ep of this.episodes.values()) if (!ep.outcome) current.set(ep.sessionId, { taskId: ep.taskId, workspaceId: ep.workspaceId });
      for (const sessionId of [...this.questions.keys()]) if (!current.has(sessionId)) this.questions.delete(sessionId);
      // Each session's screen is read on its own, side by side: one slow read does not hold up the others.
      await Promise.all([...current].map(([sessionId, cur]) => this.watchQuestion(sessionId, cur.taskId, cur.workspaceId).catch((err: unknown) => {
        this.deps.log('warn', `[headless] task ${cur.taskId}: the screen could not be checked: ${errMsg(err)}`);
      })));
    } finally {
      this.ticking = false;
    }
  }

  /**
   * A start is ending (headlessStarter): nothing more is typed into its
   * session, and its tasks still open are told `why` (while its link can
   * still carry it, when it has one): one not answered yet fails, one that
   * was answered and waits for more is canceled.
   */
  async startEnding(rec: HeadlessStartRecordV1, why: string): Promise<void> {
    this.ending.add(rec.sessionId);
    this.episodes.delete(rec.sessionId);
    this.afterwards.delete(rec.sessionId);
    this.questions.delete(rec.sessionId);
    for (const task of this.deps.tasks.remote()) {
      const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
      if (marker?.direction !== 'inbound' || task.metadata[localSideOf(task)].workspaceId !== rec.workspaceId) continue;
      const state = task.status.state;
      if (state === 'submitted' || state === 'working') await this.fail(task.id, rec.workspaceId, why);
      else if (state === 'input-required') await this.end(task.id, rec.workspaceId, 'canceled', `the agent ended: ${why}`);
    }
  }

  /**
   * The daemon is stopping: every live start of this run ends now, while the
   * links can still tell the asking PCs (the sessions die later in the
   * shutdown, after the links closed). The tasks that were open: their ids.
   */
  async endAll(why: string): Promise<string[]> {
    this.stop();
    const live = this.deps.starts.list().filter((r) => r.phase === 'started' && r.runId === this.deps.runId && !this.ending.has(r.sessionId));
    const ids: string[] = [];
    for (const rec of live) {
      for (const task of this.deps.tasks.remote()) {
        const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
        if (marker?.direction === 'inbound' && task.metadata[localSideOf(task)].workspaceId === rec.workspaceId && !this.ended(task.id)) ids.push(task.id);
      }
      await this.startEnding(rec, why);
    }
    return ids;
  }

  /** The start that owns a task's local pane, when it is one of this run's live headless starts. */
  private ownerOf(task: Task, starts: readonly HeadlessStartRecordV1[]): HeadlessStartRecordV1 | null {
    const local = task.metadata[localSideOf(task)];
    const rec = starts.find((r) => r.workspaceId === local.workspaceId);
    if (!rec || rec.phase !== 'started' || rec.runId !== this.deps.runId || rec.survivors || this.ending.has(rec.sessionId)) return null;
    if (local.paneId && local.paneId !== rec.sessionId) return null;
    return rec;
  }

  /** Still the owner at this moment (asked again before the first write and before Enter). */
  private stillOwner(taskId: string, sessionId: string): boolean {
    if (this.stopped || !this.deps.mode.active() || this.ending.has(sessionId)) return false;
    const task = this.deps.tasks.get(taskId);
    // A task that ended meanwhile (canceled on the asking PC, say) is not typed in.
    if (!task || (TERMINAL_STATES as readonly string[]).includes(task.status.state)) return false;
    return this.ownerOf(task, this.deps.starts.list())?.sessionId === sessionId;
  }

  /** What an inbound task still owes this PC: itself (not delivered, not held), then each reply or state item not handled yet. */
  private unitsOf(task: Task): Unit[] {
    const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
    if (!marker || marker.direction !== 'inbound') return [];
    const out: Unit[] = [];
    if (marker.delivered !== true && !marker.held) out.push({ task });
    for (const item of marker.inbox ?? []) if (item.delivered !== true && !item.held) out.push({ task, item });
    return out;
  }

  private ended(taskId: string): boolean {
    const state = this.deps.tasks.get(taskId)?.status.state;
    return !state || (TERMINAL_STATES as readonly string[]).includes(state);
  }

  /**
   * A follow-up held for a person (`--follow-ups ask`) on one of this run's
   * live starts: nobody here can approve it, so it is refused at once and its
   * sender told why. Holds on any other pane are left alone.
   */
  private async refuseAsked(starts: readonly HeadlessStartRecordV1[]): Promise<void> {
    for (const task of this.deps.tasks.held()) {
      const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
      if (marker?.direction !== 'inbound' || marker.held !== 'awaiting-approval') continue;
      if (marker.messageId === spawnFirstMessageId(marker.linkId as SpawnLinkId) || !this.ownerOf(task, starts)) continue;
      const wait = this.retry.get(task.id);
      if (wait && wait.at > this.now()) continue;
      try {
        const res = await this.deps.rejectHeld({ taskId: task.id, reason: ASK_REASON });
        if (res.ok) {
          this.retry.delete(task.id);
          this.deps.log('info', `[headless] task ${task.id}: a follow-up refused (follow-ups need approval)`);
          continue;
        }
        this.deps.log('warn', `[headless] task ${task.id}: the follow-up could not be refused: ${res.error ?? 'unknown'}`);
      } catch (err) {
        this.deps.log('warn', `[headless] task ${task.id}: the follow-up could not be refused: ${errMsg(err)}`);
      }
      this.backoff(task.id);
    }
  }

  /**
   * The question clock of a session's current task: started by a question on
   * its screen, reset when the screen shows none, untouched by a screen it
   * could not read. The asking PC is told once at QUESTION_NOTICE_MS; at
   * QUESTION_TIMEOUT_MS the task ends (canceled if it was never typed in,
   * failed inside its turn). The agent itself is left running, nothing typed.
   */
  private async watchQuestion(sessionId: string, taskId: string, workspaceId: string): Promise<void> {
    if (!this.deps.questionOnScreen) return;
    const now = this.now();
    // The clock follows the screen, not the task: a question that outlasted one task ends the next one
    // waiting behind it at once, instead of making each wait its full time again.
    let q = this.questions.get(sessionId);
    if (!q) {
      q = { since: null, probedAt: Number.NEGATIVE_INFINITY, noticedTask: null };
      this.questions.set(sessionId, q);
    }
    if (now - q.probedAt < QUESTION_PROBE_MS) return;
    q.probedAt = now;
    const ep = this.episodes.get(sessionId);
    const inTurn = ep?.taskId === taskId ? ep : undefined;
    // A usage-limit stop shows the agent's own limit menu: that pause is waited out, not a question.
    if (inTurn?.limitStopped || this.deps.limitHeld?.(sessionId)) {
      q.since = null;
      return;
    }
    const seen = await this.deps.questionOnScreen(sessionId);
    if (seen === 'clear') q.since = null;
    if (seen !== 'dialog') return;
    q.since ??= now;
    const waited = now - q.since;
    if (waited >= QUESTION_TIMEOUT_MS) {
      this.deps.log('warn', `[headless] task ${taskId}: ${QUESTION_REASON}`);
      if (inTurn) return this.finish(inTurn, { kind: 'failed', reason: QUESTION_REASON });
      await this.fail(taskId, workspaceId, QUESTION_REASON);
      return;
    }
    if (waited >= QUESTION_NOTICE_MS && q.noticedTask !== taskId) {
      q.noticedTask = taskId;
      await this.notify({ taskId, workspaceId, sessionId }, QUESTION_NOTICE, 'of the question', inTurn);
    }
  }

  /** Type an owed task or reply in (its start found, and no turn is open there). */
  private async offer(unit: Unit, rec: HeadlessStartRecordV1): Promise<void> {
    const { task, item } = unit;
    const key = unitKey(task.id, item?.messageId);
    const ids = { taskId: task.id, ...(item ? { messageId: item.messageId } : {}) };
    const marker = task.metadata.remote as A2aRemoteTaskState;
    if (item && !this.deps.followUpsDirect()) {
      // As a new task on the link would be: nobody here can let it through.
      await this.markOrKeep({ ...ids, delivered: true });
      await this.end(task.id, rec.workspaceId, 'canceled', ASK_REASON);
      return;
    }
    if (item ? item.attempted : marker.attempted) {
      // A write was started and never confirmed (the daemon stopped mid-way): it may be in the agent's
      // input already, and nobody here can look. Never typed again.
      await this.fail(task.id, rec.workspaceId, 'the task may have reached the agent only in part');
      return;
    }
    const wait = this.retry.get(key);
    if (wait && wait.at > this.now()) return;
    const message = item ? task.history.find((m) => m.messageId === item.messageId) : task.history[0];
    const prompt = (message?.parts ?? []).flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('\n');
    if (!prompt.trim()) {
      await this.fail(task.id, rec.workspaceId, 'the task has no text to give the agent');
      return;
    }
    // Durable before the write: a daemon that dies after it does not type it again.
    const started = await this.markSafely({ ...ids, attempted: true });
    if (!started.ok) {
      this.backoff(key);
      this.deps.log('warn', `[headless] task ${task.id}: the attempt was not recorded, not typed in: ${started.error ?? 'unknown'}`);
      return;
    }
    this.deps.armAgent?.(rec.sessionId);
    const path = this.deps.transcriptPath(rec.sessionId);
    const offset = path ? this.deps.transcriptSize(path) : 0;
    const agentMessages = task.history.filter((m) => m.role === 'agent').length;
    let wrote = false;
    let result: SessionPromptScheduleResult;
    try {
      result = await this.deps.deliver(rec.sessionId, rec.agent, prompt, () => this.stillOwner(task.id, rec.sessionId), () => {
        wrote = true;
      });
    } catch (err) {
      result = 'error';
      wrote = true;
      this.deps.log('warn', `[headless] task ${task.id}: typing it in failed: ${errMsg(err)}`);
    }
    // Refused before anything was written (headless mode turned off, the start ending): as busy.
    if (result === 'error' && !wrote) result = 'busy';
    switch (result) {
      case 'sent': {
        this.retry.delete(key);
        // Typed in: what the agent says next is this turn's, not a later one of the task before.
        this.afterwards.delete(rec.sessionId);
        if (this.ending.has(rec.sessionId)) return;
        const ep: Episode = {
          taskId: task.id, sessionId: rec.sessionId, workspaceId: rec.workspaceId, promptHash: promptHash(prompt),
          sentAt: this.now(), agentMessagesAtSend: agentMessages, path, offset, opened: false, limitStopped: false, answer: [],
          working: false, outcome: null, work: SUBAGENT_COUNTERS[rec.agent]?.() ?? null,
        };
        this.episodes.set(rec.sessionId, ep);
        await this.markOrKeep({ ...ids, delivered: true, ...(item ? {} : { ptyId: rec.sessionId }) });
        await this.toWorking(ep);
        this.deps.log('info', `[headless] task ${key}: typed into ${rec.sessionId}`);
        return;
      }
      case 'busy':
      case 'unavailable':
        // Nothing was written (every refusal after a write is `error`): tried again later.
        await this.markOrKeep({ ...ids, attempted: false });
        this.backoff(key);
        return;
      case 'error':
        // It may have been written in part: never typed again, and the task fails (the reason goes with it).
        await this.fail(task.id, rec.workspaceId, 'the task may have reached the agent only in part');
        return;
      default:
        // `session_changed` / `folder_trust`: not expected for an agent this daemon started; nothing was written.
        await this.markOrKeep({ ...ids, attempted: false });
        await this.fail(task.id, rec.workspaceId, `the agent could not take the task (${result})`);
    }
  }

  /** The delivered task moved to `working`; tried again each pass until it is (never by typing it again). */
  private async toWorking(ep: Episode): Promise<void> {
    const state = this.deps.tasks.get(ep.taskId)?.status.state;
    // `submitted`: its first turn; `input-required`: a reply on it was typed in, its next turn.
    if (state !== 'submitted' && state !== 'input-required') {
      ep.working = state !== undefined;
      return;
    }
    const moved = await this.deps.transition({ taskId: ep.taskId, workspaceId: ep.workspaceId, to: 'working' })
      .catch((err: unknown) => ({ ok: false, error: errMsg(err) }));
    ep.working = moved.ok;
    if (!moved.ok) this.deps.log('warn', `[headless] task ${ep.taskId}: not marked working, tried again: ${moved.error ?? 'unknown'}`);
  }

  /** Read what the agent wrote since the last pass; end the episode when its turn did. */
  private async follow(ep: Episode): Promise<void> {
    // The turn ended already, and its reply or the task's move did not go through: only that is tried again.
    if (ep.outcome) return this.finish(ep, ep.outcome);
    // Ended on the asking PC (canceled, say): the session is free for the next one. At a usage limit, once the
    // limit menu is gone after the reset (it would refuse the next task), with no continue: the turn is nobody's now.
    if (this.ended(ep.taskId)) {
      this.further.delete(ep.taskId);
      if (ep.limitStopped && !(await this.limitCleared(ep))) return;
      return this.drop(ep);
    }
    if (!ep.working) await this.toWorking(ep);
    const path = this.deps.transcriptPath(ep.sessionId);
    if (!path) return;
    // Bound only after the write: read from where the file began. Bound to another file since: not this turn's.
    if (ep.path === null) ep.path = path;
    else if (ep.path !== path) return this.finish(ep, { kind: 'failed', reason: "the agent's conversation was replaced on this PC" });
    const lines = this.readNew(ep, path);
    // The file was cut or replaced: the turn cannot be followed any more.
    if (lines === null) return this.finish(ep, { kind: 'failed', reason: "the agent's conversation was replaced on this PC" });
    for (const { line, events, start, end } of lines) {
      for (let step = stepEpisode(ep, line, events); step;) {
        if (step.kind === 'progress' && !this.pastWait(ep)) {
          await this.progress(ep, step.text);
          step = step.again ? stepEpisode(ep, line, events) : null;
          continue;
        }
        // The episode ends here: what follows is read on from the line after the end (this one, when it was not read).
        ep.offset = step.again ? start : end;
        return this.finish(ep, step.kind === 'progress' ? this.stillRunning(ep, step.text, false) : step);
      }
    }
    if (ep.limitStopped) return this.atLimit(ep);
    // A thinking-only end with nothing after it: the message had no text to come.
    const end = this.settled(ep);
    if (end?.kind === 'answered') return this.finish(ep, end);
    if (end && this.pastWait(ep)) return this.finish(ep, this.stillRunning(ep, end.text, false));
    if (end) await this.progress(ep, end.text);
    // Past the wait, between the agent's turns: the answer goes, saying the work still runs.
    if (!ep.busy && this.pastWait(ep)) return this.finish(ep, this.stillRunning(ep, ep.lastProgress?.text ?? '', ep.lastProgress?.sent ?? true));
  }

  /** The episode's usage-limit stop, first seen now: its reset read from the entry, the daemon's hold set from it. */
  private limitOf(ep: Episode): NonNullable<Episode['limit']> | null {
    const limit = ep.limit;
    if (!limit) return null;
    if (limit.seenAt === undefined) {
      limit.seenAt = this.now();
      limit.resetsAt = claudeUsageLimitFromStopFailure({ error: 'rate_limit', last_assistant_message: limit.message }, limit.at ?? limit.seenAt)?.resetsAt ?? null;
      this.deps.noteLimit?.(ep.sessionId, limit.message, limit.at);
      this.deps.log('info', `[headless] task ${ep.taskId}: the agent is at its usage limit (${limit.resetsAt != null ? `resets ${new Date(limit.resetsAt).toISOString()}` : 'reset unknown'})`);
    }
    return limit;
  }

  private limitCapAt(limit: NonNullable<Episode['limit']>): number {
    return limit.resetsAt != null ? limit.resetsAt + LIMIT_RESUME_MARGIN_MS : (limit.seenAt ?? this.now()) + LIMIT_UNKNOWN_MAX_MS;
  }

  /**
   * After the reset, what the screen allows (read at most every LIMIT_PROBE_MS):
   * `settled` once no dialog was seen on two reads in a row. The limit menu,
   * matched exactly, gets Escape (LIMIT_ESCAPES_MAX presses at most, counted
   * when written, and only while this delivery may still write there).
   * `wait` for anything else, and before the reset.
   */
  private async limitScreenAfterReset(ep: Episode, limit: NonNullable<Episode['limit']>): Promise<'settled' | 'wait'> {
    const now = this.now();
    if (limit.resetsAt == null || now < limit.resetsAt + USAGE_LIMIT_RESUME_GRACE_MS) return 'wait';
    if (now - (limit.probedAt ?? Number.NEGATIVE_INFINITY) < LIMIT_PROBE_MS) return 'wait';
    limit.probedAt = now;
    const screen = this.deps.limitScreen ? await this.deps.limitScreen(ep.sessionId).catch(() => 'other' as const) : 'other';
    if (screen === 'menu') {
      limit.clearSince = null;
      const mayWrite = !this.stopped && this.deps.mode.active() && !this.ending.has(ep.sessionId);
      if (!mayWrite || (limit.escapes ?? 0) >= LIMIT_ESCAPES_MAX || !this.deps.pressEscape) return 'wait';
      const pressed = await this.deps.pressEscape(ep.sessionId).catch(() => false);
      if (pressed) limit.escapes = (limit.escapes ?? 0) + 1;
      this.deps.log('info', `[headless] task ${ep.taskId}: the usage-limit menu ${pressed ? 'was dismissed (Escape)' : 'could not be dismissed'}`);
      return 'wait';
    }
    if (screen !== 'clear') {
      limit.clearSince = null;
      return 'wait';
    }
    if (limit.clearSince == null) {
      limit.clearSince = now;
      return 'wait';
    }
    return 'settled';
  }

  /**
   * A task that ended on the asking PC while its agent is at its usage limit:
   * true once the session may take the next task (the limit menu dismissed
   * after the reset, or the stop's cap passed). Nothing is typed.
   */
  private async limitCleared(ep: Episode): Promise<boolean> {
    const limit = this.limitOf(ep);
    if (!limit || this.now() >= this.limitCapAt(limit)) return true;
    return (await this.limitScreenAfterReset(ep, limit)) === 'settled';
  }

  /**
   * A notice this delivery sends on a task itself. Inside a turn (`ep`) it is
   * not taken for the agent answering through its own tools.
   */
  private async notify(to: { taskId: string; workspaceId: string; sessionId: string }, text: string, what: string, ep?: Episode): Promise<void> {
    const before = this.said(to.taskId, text);
    try {
      const sent = await this.deps.reply({ taskId: to.taskId, workspaceId: to.workspaceId, text, ptyId: to.sessionId });
      if (!sent.ok) this.deps.log('warn', `[headless] task ${to.taskId}: the asking PC could not be told ${what}: ${sent.error ?? 'unknown'}`);
    } catch (err) {
      this.deps.log('warn', `[headless] task ${to.taskId}: the asking PC could not be told ${what}: ${errMsg(err)}`);
    }
    if (ep) this.countAsSaid(ep, text, before);
  }

  /**
   * The agent stopped at its usage limit, and nobody on this PC answers its
   * limit menu. The daemon holds the session from the transcript's own line,
   * and the asking PC is told once until when. After the reset: Escape on the
   * limit menu, only while it is exactly that menu; once no dialog is up for
   * a second read and the agent did not go on by itself (the transcript would
   * have cleared the stop), the one continue. Nothing else is ever typed. Not
   * gone on by the reset plus LIMIT_RESUME_MARGIN_MS (LIMIT_UNKNOWN_MAX_MS
   * when the reset is not known): the task ends with the reason, the agent is
   * left as it is.
   */
  private async atLimit(ep: Episode): Promise<void> {
    const limit = this.limitOf(ep);
    if (!limit) return;
    if (!limit.noticed) {
      limit.noticed = true;
      await this.notify(ep, limitNotice(limit.resetsAt ?? null), 'of the usage limit', ep);
    }
    const now = this.now();
    const resetsAt = limit.resetsAt ?? null;
    if (now >= this.limitCapAt(limit)) return this.finish(ep, { kind: 'failed', reason: limitReason(resetsAt) });
    if (limit.continued) return;
    // No dialog on two reads in a row after the reset, and the agent did not go on by itself meanwhile.
    if ((await this.limitScreenAfterReset(ep, limit)) !== 'settled') return;
    const rec = this.deps.starts.list().find((r) => r.sessionId === ep.sessionId);
    if (!rec) return;
    let wrote = false;
    let result: SessionPromptScheduleResult;
    try {
      result = await this.deps.deliver(ep.sessionId, rec.agent, USAGE_LIMIT_CONTINUE_PROMPT,
        () => ep.limitStopped && !limit.continued && this.stillOwner(ep.taskId, ep.sessionId), () => { wrote = true; });
    } catch (err) {
      result = 'error';
      wrote = true;
      this.deps.log('warn', `[headless] task ${ep.taskId}: the continue after the usage limit failed: ${errMsg(err)}`);
    }
    // Once something may have been written, never again: one continue at most.
    if (result === 'sent' || wrote) limit.continued = true;
    else limit.clearSince = null;
    this.deps.log('info', `[headless] task ${ep.taskId}: continue after the usage limit: ${result}`);
  }

  /** The wait on background work is over (BACKGROUND_WAIT_MS after the first turn that left it running). */
  private pastWait(ep: Episode): boolean {
    return ep.waitingSince != null && this.now() - ep.waitingSince >= BACKGROUND_WAIT_MS;
  }

  /** The answer while background work still runs: the turn's text, unless it went already, and the note. */
  private stillRunning(ep: Episode, text: string, sent: boolean): EpisodeOutcome {
    this.deps.log('info', `[headless] task ${ep.taskId}: answered while background work still runs`);
    const body = text.trim();
    return { kind: 'answered', text: (body && !sent ? `${body}\n\n` : '') + BACKGROUND_NOTE };
  }

  /**
   * The lines written since the episode's offset, each with where it starts and ends (bytes);
   * the offset moves past them. Null when the file was cut or replaced.
   */
  private readNew(ep: Episode, path: string): Array<{ line: string; events: TurnEvent[]; start: number; end: number }> | null {
    const lines: Array<{ line: string; events: TurnEvent[]; start: number; end: number }> = [];
    const delta = readTranscriptDelta(path, ep.offset, undefined, (line, offset) => {
      const events = parseTranscriptLine(line, offset);
      lines.push({ line, events, start: offset, end: offset });
      return events;
    });
    if (!delta) return [];
    if (delta.reset) return null;
    ep.offset = delta.cursor.tailOffset;
    // A line ends where the next one starts; the last one where the read ended.
    lines.forEach((l, i) => { l.end = lines[i + 1]?.start ?? ep.offset; });
    return lines;
  }

  /** A thinking-only end that nothing followed for TURN_END_SETTLE_MS: the turn's end, now. */
  private settled(ep: Episode): ReturnType<typeof turnEnd> | null {
    if (!ep.endPending) return null;
    if (ep.endPending.at === 0) {
      ep.endPending.at = this.now();
      return null;
    }
    return this.now() - ep.endPending.at >= TURN_END_SETTLE_MS ? turnEnd(ep) : null;
  }

  /**
   * A turn ended while work it left runs: its text goes back as a reply (the
   * task stays `working`), and the episode waits for the agent's next turn.
   */
  private async progress(ep: Episode, text: string): Promise<void> {
    ep.waitingSince ??= this.now();
    const body = text.trim();
    ep.lastProgress = { text: body, sent: false };
    if (!body || this.ended(ep.taskId) || !this.budgetLeft(ep.taskId)) return;
    const before = this.said(ep.taskId, cutReply(body));
    ep.lastProgress.sent = await this.sayFurther(ep, body);
    this.countAsSaid(ep, cutReply(body), before);
  }

  /** How many agent messages on the task are exactly `text`. */
  private said(taskId: string, text: string): number {
    const history = this.deps.tasks.get(taskId)?.history ?? [];
    return history.filter((m) => m.role === 'agent' && m.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('') === text).length;
  }

  /**
   * A reply this delivery sent on the task itself (a progress reply, the question notice) is not the agent
   * answering through its own tools: the copies of `text` it added (one that landed although the call
   * failed counts too) are counted as already there, so the answer still goes. A reply the agent sent itself
   * stays counted as its own.
   */
  private countAsSaid(ep: Episode, text: string, before: number): void {
    ep.agentMessagesAtSend += Math.max(0, this.said(ep.taskId, text) - before);
  }

  private budgetLeft(taskId: string): boolean {
    return (this.further.get(taskId) ?? 0) < FURTHER_REPLIES_MAX;
  }

  /** A reply on the task besides its answer. True when it was sent (only that counts in the task's budget). */
  private async sayFurther(ep: Episode, text: string): Promise<boolean> {
    try {
      const sent = await this.deps.reply({ taskId: ep.taskId, workspaceId: ep.workspaceId, text: cutReply(text), ptyId: ep.sessionId });
      if (sent.ok) {
        const n = (this.further.get(ep.taskId) ?? 0) + 1;
        this.further.set(ep.taskId, n);
        if (n === FURTHER_REPLIES_MAX) this.deps.log('info', `[headless] task ${ep.taskId}: last further reply (${FURTHER_REPLIES_MAX})`);
        return true;
      }
      this.deps.log('warn', `[headless] task ${ep.taskId}: a further reply was not sent: ${sent.error ?? 'unknown'}`);
    } catch (err) {
      this.deps.log('warn', `[headless] task ${ep.taskId}: a further reply was not sent: ${errMsg(err)}`);
    }
    return false;
  }

  /**
   * After the answer: a turn nothing on this PC started (background work the
   * agent was not waited for, a wake it set itself) goes back as a further
   * reply, the task's state unchanged. It stops at input on this PC (a
   * prompt, a slash command), at a new turn typed in, when the task is no
   * longer `input-required`, and at the budget.
   */
  private async followAfter(w: Episode): Promise<void> {
    const stop = (): void => {
      if (this.afterwards.get(w.sessionId) === w) this.afterwards.delete(w.sessionId);
      if (this.ended(w.taskId)) this.further.delete(w.taskId);
    };
    if (this.episodes.has(w.sessionId) || this.ending.has(w.sessionId)) return stop();
    if (this.deps.tasks.get(w.taskId)?.status.state !== 'input-required' || !this.budgetLeft(w.taskId)) return stop();
    const path = this.deps.transcriptPath(w.sessionId);
    if (!path || path !== w.path) return stop();
    // A reply that did not go through goes first (unless it landed after all); nothing after it is read until it did.
    const say = async (text: string): Promise<'sent' | 'stop' | 'held'> => {
      const body = text.trim();
      if (!body) return 'sent';
      if (!this.budgetLeft(w.taskId)) return 'stop';
      const copies = this.said(w.taskId, cutReply(body));
      if (w.unsaid?.text === body && copies > w.unsaid.copies) {
        // The try before landed although its call failed.
        this.further.set(w.taskId, (this.further.get(w.taskId) ?? 0) + 1);
      } else if (!(await this.sayFurther(w, body))) {
        w.unsaid = { text: body, copies };
        return 'held';
      }
      w.unsaid = null;
      return 'sent';
    };
    if (w.unsaid) {
      const r = await say(w.unsaid.text);
      if (r === 'stop') return stop();
      if (r === 'held') return;
    }
    const lines = this.readNew(w, path);
    if (lines === null) return stop();
    for (const { line, events, start, end } of lines) {
      // Typed on this PC (a slash command or a `!` command too, which do not parse as a prompt): its turns are not the task's.
      const raw = rawEntry(line);
      if (raw?.typed && !raw.sidechain) return stop();
      for (let step = stepEpisode(w, line, events); step;) {
        // An interrupt on this PC, an error: nothing more is said on the task.
        if (step.kind === 'failed') return stop();
        const r = await say(step.text);
        if (r === 'stop') return stop();
        if (r === 'held') {
          // Read on from after this turn end once its reply went (this line again, when it was not read).
          w.offset = step.again ? start : end;
          return;
        }
        step = step.again ? stepEpisode(w, line, events) : null;
      }
    }
    const end = this.settled(w);
    if (end && (await say(end.text)) === 'stop') stop();
  }

  /**
   * The one place an episode's end is decided: a reply (unless the agent
   * already answered through its own tools after the task was typed in), then
   * `input-required`; or `failed` with the reason. The episode is kept, with
   * its outcome, until that went through: a later pass tries again only what
   * did not. A reply that landed shows in the task's history, so it is never
   * sent twice.
   */
  private async finish(ep: Episode, outcome: EpisodeOutcome): Promise<void> {
    const first = ep.outcome === null;
    ep.outcome = outcome;
    if (outcome.kind === 'failed') {
      if (first) this.deps.log('warn', `[headless] task ${ep.taskId}: ${outcome.reason}`);
      if (await this.fail(ep.taskId, ep.workspaceId, outcome.reason)) this.drop(ep);
      return;
    }
    const task = this.deps.tasks.get(ep.taskId);
    if (!task || (TERMINAL_STATES as readonly string[]).includes(task.status.state)) return this.drop(ep);
    const replied = task.history.filter((m) => m.role === 'agent').length > ep.agentMessagesAtSend;
    if (!replied) {
      // Over the body limit: its start goes, with a marker (an answer leads with its result).
      const text = cutReply(outcome.text.trim() || '(the agent ended its turn without text)');
      let sent: { ok: boolean; error?: string };
      try {
        sent = await this.deps.reply({ taskId: ep.taskId, workspaceId: ep.workspaceId, text, ptyId: ep.sessionId });
      } catch (err) {
        // Not known whether it landed: the next pass looks at the task's history first.
        this.deps.log('warn', `[headless] task ${ep.taskId}: the reply failed, tried again: ${errMsg(err)}`);
        return;
      }
      if (!sent.ok) {
        const reason = `the agent's answer could not be sent: ${sent.error ?? 'unknown'}`;
        ep.outcome = { kind: 'failed', reason };
        if (await this.fail(ep.taskId, ep.workspaceId, reason)) this.drop(ep);
        return;
      }
    }
    if (!ep.working) await this.toWorking(ep);
    if (this.deps.tasks.get(ep.taskId)?.status.state !== 'working') return this.drop(ep);
    const moved = await this.deps.transition({ taskId: ep.taskId, workspaceId: ep.workspaceId, to: 'input-required' })
      .catch((err: unknown) => ({ ok: false, error: errMsg(err) }));
    if (!moved.ok) {
      this.deps.log('warn', `[headless] task ${ep.taskId}: not moved to input-required, tried again: ${moved.error ?? 'unknown'}`);
      return;
    }
    this.drop(ep);
    // Read on from here for turns nothing on this PC starts (only while nothing else took the session).
    if (ep.path !== null && !this.episodes.has(ep.sessionId) && !this.ending.has(ep.sessionId)) {
      this.afterwards.set(ep.sessionId, {
        ...ep, opened: true, answer: [], endPending: undefined, limitStopped: false, outcome: null, waitingSince: null, busy: false, lastProgress: null,
      });
    }
  }

  /** The episode is done with (only this one: another may have taken the session since). */
  private drop(ep: Episode): void {
    if (this.episodes.get(ep.sessionId) === ep) this.episodes.delete(ep.sessionId);
  }

  private fail(taskId: string, workspaceId: string, reason: string): Promise<boolean> {
    return this.end(taskId, workspaceId, 'failed', reason);
  }

  /**
   * A task that was never taken (still `submitted`) can only be canceled, with the same reason.
   * True when the task is ended (by this or before it).
   */
  private async end(taskId: string, workspaceId: string, wanted: 'failed' | 'canceled', reason: string): Promise<boolean> {
    const state = this.deps.tasks.get(taskId)?.status.state;
    if (!state || (TERMINAL_STATES as readonly string[]).includes(state)) {
      this.further.delete(taskId);
      return true;
    }
    // `failed` is not a move from `submitted` or `input-required` in the ledger: those are canceled, with the reason.
    const to = wanted === 'failed' && (state === 'submitted' || state === 'input-required') ? 'canceled' : wanted;
    // A cancel reaches the asking PC without its summary (a failure carries one): the reason goes first, as a reply, once.
    if (to === 'canceled') await this.sayOnce(taskId, workspaceId, `Canceled: ${reason}`);
    const res = await this.deps.transition({ taskId, workspaceId, to, summary: reason }).catch((err: unknown) => ({ ok: false, error: errMsg(err) }));
    if (!res.ok) this.deps.log('warn', `[headless] task ${taskId}: not marked ${to} (${reason}): ${res.error ?? 'unknown'}`);
    else this.further.delete(taskId);
    return res.ok;
  }

  /** A reply on the task, unless the task already holds that text (a retry). Best effort: the move goes on regardless. */
  private async sayOnce(taskId: string, workspaceId: string, text: string): Promise<void> {
    const said = this.deps.tasks.get(taskId)?.history.some((m) => m.parts.some((p) => p.kind === 'text' && p.text === text));
    if (said) return;
    try {
      const res = await this.deps.reply({ taskId, workspaceId, text });
      if (!res.ok) this.deps.log('warn', `[headless] task ${taskId}: the reason could not be sent before canceling: ${res.error ?? 'unknown'}`);
    } catch (err) {
      this.deps.log('warn', `[headless] task ${taskId}: the reason could not be sent before canceling: ${errMsg(err)}`);
    }
  }

  private async markSafely(input: MarkInput): Promise<{ ok: boolean; error?: string }> {
    try {
      return await this.deps.mark(input);
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  /** A mark that did not go through is kept and retried before the task is looked at again. */
  private async markOrKeep(input: MarkInput): Promise<void> {
    const res = await this.markSafely(input);
    if (res.ok) return;
    this.unsentMarks.set(unitKey(input.taskId, input.messageId), input);
    this.deps.log('warn', `[headless] task ${input.taskId}: mark not recorded, tried again: ${res.error ?? 'unknown'}`);
  }

  private backoff(taskId: string): void {
    const prev = this.retry.get(taskId);
    const waitMs = prev ? Math.min(prev.waitMs * 2, RETRY_MAX_MS) : RETRY_MIN_MS;
    this.retry.set(taskId, { at: this.now() + waitMs, waitMs });
  }
}

/** Waits until the asking PCs took what was queued for these tasks (`A2aRemoteDelivery.drain`). */
export interface HeadlessStopLinks {
  drain(taskIds: readonly string[], timeoutMs: number): Promise<boolean>;
}

/**
 * The daemon's stop, before it closes its links: this run's headless starts
 * end, and the asking PCs are told why while the links still carry it (the
 * sessions only die later in the shutdown, after the links closed, and the
 * asking PC would see the link break instead). Bounded by `timeoutMs` in all.
 */
export async function endHeadlessOnStop(
  delivery: HeadlessDelivery | null,
  links: HeadlessStopLinks | null,
  log: HeadlessDeliveryDeps['log'],
  timeoutMs = HEADLESS_STOP_FLUSH_MS,
): Promise<void> {
  if (!delivery) return;
  const deadline = Date.now() + timeoutMs;
  const bound = <T>(work: Promise<T>): Promise<T | 'late'> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), Math.max(0, deadline - Date.now()));
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  };
  const ids = await bound(delivery.endAll(DAEMON_STOPPED_REASON)).catch((err: unknown) => {
    log('warn', `[headless] the open tasks could not be ended before the stop: ${errMsg(err)}`);
    return [] as string[];
  });
  if (ids === 'late') {
    log('warn', '[headless] ending the open tasks before the stop took too long');
    return;
  }
  if (ids.length === 0 || !links) return;
  const done = await bound(links.drain(ids, Math.max(0, deadline - Date.now()))).catch(() => false);
  if (done !== true) log('warn', `[headless] ${ids.length} ended task(s) may not have reached the asking PC before the stop`);
}
