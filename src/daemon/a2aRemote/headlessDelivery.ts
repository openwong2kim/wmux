import crypto from 'node:crypto';
import { A2A_REMOTE_BODY_MAX } from '../../shared/a2aRemote';
import { truncateUtf8 } from '../../shared/chatv2/limits';
import type { SessionPromptScheduleResult } from '../../shared/sessionPromptSchedule';
import { sanitizeBracketedPastePayload } from '../../shared/ptyMessageDelivery';
import { localSideOf, type A2aRemoteTaskState } from '../../shared/a2aRemoteDelivery';
import { spawnFirstMessageId, type SpawnLinkId } from '../../shared/a2aSpawn';
import { TERMINAL_STATES, type Task } from '../../shared/types';
import type { TurnEvent } from '../../shared/transcript/turnEvents';
import { isClaudeUsageLimitText, USAGE_LIMIT_CONTINUE_PROMPT } from '../../shared/usageLimit';
import { apiErrorFromTranscriptLine } from '../transcript/apiErrorTurnEnd';
import { parseTranscriptLine } from '../transcript/parseEntry';
import { readTranscriptDelta } from '../transcript/readTail';
import type { HeadlessStartRecordV1 } from './headlessStartStore';
import { errMsg } from './storeFile';

/**
 * Headless remote spawn, part two: the task a paired PC sent with its request
 * is typed into the agent the daemon started for it (headlessStarter.ts), and
 * the agent's answer goes back as the task's reply. Later tasks on the same
 * link (follow-ups) are typed in one at a time, oldest first, when the start's
 * policy lets them through (`--follow-ups direct`); with `ask` they wait for a
 * person, and there is none here, so they are refused at once with the reason.
 *
 * Only here, only in headless mode and only into a session a `started` start
 * of this daemon run owns; the app's bridge leaves `hl-` workspaces alone
 * (RemoteA2aBridge), so one deliverer types into each pane. The pane, prompt
 * and task functions are given (index.ts); nothing here opens a pane.
 *
 * The answer is read from the agent's transcript (Claude Code), not hooks: a
 * server host has none installed. The delivered prompt opens an "episode" when
 * its own user entry shows up; the first turn end after it closes the episode
 * and its last assistant text is the reply. See `stepEpisode` for what else
 * can happen in between.
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

type MarkInput = { taskId: string; attempted?: boolean; delivered?: true; ptyId?: string };

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
  /** The agent's transcript file, once the daemon has bound the session to its conversation; null before. */
  transcriptPath(sessionId: string): string | null;
  /** Its size now (0 when it does not exist yet). */
  transcriptSize(path: string): number;
  /** The daemon's own `a2a.remote.rejectHeld`: a held task ends here and its sender is told the reason. */
  rejectHeld(input: { taskId: string; reason: string }): Promise<{ ok: boolean; error?: string }>;
  /**
   * What the session's screen shows, read as the delivery guard reads it: a
   * question (a permission dialog, a selection menu, the folder-trust prompt),
   * nothing of the kind, or cells it could not read.
   */
  questionOnScreen?(sessionId: string): Promise<'dialog' | 'clear' | 'unknown'>;
  /** The daemon's own `a2a.remote.reply`, as main calls it. */
  reply(input: { taskId: string; workspaceId: string; text: string; ptyId: string }): Promise<{ ok: boolean; error?: string }>;
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
  /** Text of the assistant entries since the last tool call: the answer so far. */
  answer: string[];
  /** The task was moved to `working` (a failed move is tried again). */
  working: boolean;
  /** How the turn ended, kept until the reply and the task's move both went through. */
  outcome: EpisodeOutcome | null;
}

export type EpisodeOutcome =
  | { kind: 'answered'; text: string }
  | { kind: 'failed'; reason: string };

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
function rawEntry(line: string): { type?: unknown; stopReason?: unknown; content?: unknown; sidechain: boolean } | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as { type?: unknown; isSidechain?: unknown; message?: { stop_reason?: unknown; content?: unknown } };
  return { type: e.type, stopReason: e.message?.stop_reason, content: e.message?.content, sidechain: e.isSidechain === true };
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
 *    refusal, a stop sequence);
 *  - an interrupt, or an API error other than a usage limit, fails it;
 *  - a usage-limit stop keeps it open, and so does the continue the daemon
 *    types once the limit resets (that exact prompt, after that stop);
 *  - any other user entry inside it is input from this PC: failed, no reply.
 * Compactions, slash commands and reminders parse as `meta`, not user text.
 */
export function stepEpisode(ep: Episode, line: string, events: readonly TurnEvent[]): EpisodeOutcome | null {
  const raw = rawEntry(line);
  // A subagent's entry (in the lead's file): not the prompt, not input, and its turn end is not the lead's.
  if (raw?.sidechain) return null;
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
      ep.limitStopped = true;
      return null;
    }
    return { kind: 'failed', reason: `the agent's turn ended on an error: ${apiError.message || apiError.error}` };
  }
  let answered = false;
  for (const event of events) {
    if (event.kind === 'user_text') {
      if (!ep.opened) return { kind: 'failed', reason: 'the agent was given other input on this PC before the task' };
      if (ep.limitStopped && event.text.trim() === USAGE_LIMIT_CONTINUE_PROMPT) {
        ep.limitStopped = false;
        continue;
      }
      return { kind: 'failed', reason: "the agent's turn was taken over by input on this PC" };
    }
    if (!ep.opened) continue;
    if (event.kind === 'tool_use' || event.kind === 'tool_result') ep.answer = [];
    else if (event.kind === 'meta' && event.subtype === 'turn_aborted') return { kind: 'failed', reason: "the agent's turn was interrupted on this PC" };
    else if (event.kind === 'meta' && event.subtype === 'turn_complete') return { kind: 'answered', text: ep.answer.join('\n\n') };
    else if (event.kind === 'assistant_text' && !event.thinking && !answered) {
      // One entry may parse to several events: its text is taken once.
      const text = assistantTextOf(line);
      if (text !== null) ep.answer.push(text);
      answered = true;
    }
  }
  // The turn ended when the entry stopped for anything but a tool call.
  if (ep.opened && raw?.type === 'assistant' && typeof raw.stopReason === 'string' && raw.stopReason !== 'tool_use') {
    return { kind: 'answered', text: ep.answer.join('\n\n') };
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
  private readonly questions = new Map<string, { taskId: string; since: number | null; probedAt: number; noticed: boolean }>();
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
      if (!this.deps.mode.active()) return;
      const starts = this.deps.starts.list();
      await this.refuseAsked(starts);
      // The task each session works on, or waits to: its question clock runs.
      const current = new Map<string, { taskId: string; workspaceId: string }>();
      // Sessions whose oldest owed task was looked at: a newer one waits behind it.
      const taken = new Set<string>();
      for (const task of oldestFirst(this.deps.tasks.pending())) {
        if (this.stopped) return;
        try {
          const rec = this.headOf(task, starts);
          if (rec && taken.has(rec.sessionId)) continue;
          if (rec) taken.add(rec.sessionId);
          const unsent = this.unsentMarks.get(task.id);
          if (unsent) {
            // Only the mark is tried again: the task is never typed in a second time for it.
            if ((await this.markSafely(unsent)).ok) this.unsentMarks.delete(task.id);
            continue;
          }
          if (!rec || this.episodes.has(rec.sessionId)) continue;
          await this.offer(task, rec);
          if (!this.episodes.has(rec.sessionId) && !this.ended(task.id)) current.set(rec.sessionId, { taskId: task.id, workspaceId: rec.workspaceId });
        } catch (err) {
          this.deps.log('warn', `[headless] task ${task.id}: not typed in: ${errMsg(err)}`);
          this.backoff(task.id);
        }
      }
      // A turn that ended and is only being finished (its reply or move tried again) has no question clock.
      for (const ep of this.episodes.values()) if (!ep.outcome) current.set(ep.sessionId, { taskId: ep.taskId, workspaceId: ep.workspaceId });
      for (const sessionId of [...this.questions.keys()]) if (!current.has(sessionId)) this.questions.delete(sessionId);
      for (const [sessionId, cur] of current) {
        try {
          await this.watchQuestion(sessionId, cur.taskId, cur.workspaceId);
        } catch (err) {
          this.deps.log('warn', `[headless] task ${cur.taskId}: the screen could not be checked: ${errMsg(err)}`);
        }
      }
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
    this.questions.delete(rec.sessionId);
    for (const task of this.deps.tasks.remote()) {
      const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
      if (marker?.direction !== 'inbound' || task.metadata[localSideOf(task)].workspaceId !== rec.workspaceId) continue;
      const state = task.status.state;
      if (state === 'submitted' || state === 'working') await this.fail(task.id, rec.workspaceId, why);
      else if (state === 'input-required') await this.end(task.id, rec.workspaceId, 'canceled', `the agent ended: ${why}`);
    }
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

  /** The start an owed task is to be typed into: an inbound task not delivered, held or ended, of this run's live start. */
  private headOf(task: Task, starts: readonly HeadlessStartRecordV1[]): HeadlessStartRecordV1 | null {
    const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
    if (!marker || marker.direction !== 'inbound' || marker.delivered === true || marker.held) return null;
    if ((TERMINAL_STATES as readonly string[]).includes(task.status.state)) return null;
    return this.ownerOf(task, starts);
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
    let q = this.questions.get(sessionId);
    if (!q || q.taskId !== taskId) {
      q = { taskId, since: null, probedAt: Number.NEGATIVE_INFINITY, noticed: false };
      this.questions.set(sessionId, q);
    }
    if (now - q.probedAt < QUESTION_PROBE_MS) return;
    q.probedAt = now;
    const seen = await this.deps.questionOnScreen(sessionId);
    if (seen === 'clear') q.since = null;
    if (seen !== 'dialog') return;
    q.since ??= now;
    const waited = now - q.since;
    const ep = this.episodes.get(sessionId);
    const inTurn = ep?.taskId === taskId ? ep : undefined;
    if (waited >= QUESTION_TIMEOUT_MS) {
      this.questions.delete(sessionId);
      this.retry.delete(taskId);
      this.deps.log('warn', `[headless] task ${taskId}: ${QUESTION_REASON}`);
      if (inTurn) return this.finish(inTurn, { kind: 'failed', reason: QUESTION_REASON });
      return this.fail(taskId, workspaceId, QUESTION_REASON);
    }
    if (waited >= QUESTION_NOTICE_MS && !q.noticed) {
      q.noticed = true;
      const sent = await this.deps.reply({ taskId, workspaceId, text: QUESTION_NOTICE, ptyId: sessionId });
      if (!sent.ok) this.deps.log('warn', `[headless] task ${taskId}: the asking PC could not be told of the question: ${sent.error ?? 'unknown'}`);
      // This notice is not the agent answering through its own tools.
      else if (inTurn) inTurn.agentMessagesAtSend += 1;
    }
  }

  /** Type an owed task in (`headOf` found its start, and no turn is open there). */
  private async offer(task: Task, rec: HeadlessStartRecordV1): Promise<void> {
    const marker = task.metadata.remote as A2aRemoteTaskState;
    if (marker.attempted) {
      // A write was started and never confirmed (the daemon stopped mid-way): it may be in the agent's
      // input already, and nobody here can look. Never typed again.
      await this.fail(task.id, rec.workspaceId, 'the task may have reached the agent only in part');
      return;
    }
    const wait = this.retry.get(task.id);
    if (wait && wait.at > this.now()) return;
    const first = task.history[0]?.parts.find((p) => p.kind === 'text');
    const prompt = first && first.kind === 'text' ? first.text : '';
    if (!prompt.trim()) {
      await this.fail(task.id, rec.workspaceId, 'the task has no text to give the agent');
      return;
    }
    // Durable before the write: a daemon that dies after it does not type it again.
    const started = await this.markSafely({ taskId: task.id, attempted: true });
    if (!started.ok) {
      this.backoff(task.id);
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
        this.retry.delete(task.id);
        if (this.ending.has(rec.sessionId)) return;
        const ep: Episode = {
          taskId: task.id, sessionId: rec.sessionId, workspaceId: rec.workspaceId, promptHash: promptHash(prompt),
          sentAt: this.now(), agentMessagesAtSend: agentMessages, path, offset, opened: false, limitStopped: false, answer: [],
          working: false, outcome: null,
        };
        this.episodes.set(rec.sessionId, ep);
        await this.markOrKeep({ taskId: task.id, delivered: true, ptyId: rec.sessionId });
        await this.toWorking(ep);
        this.deps.log('info', `[headless] task ${task.id}: typed into ${rec.sessionId}`);
        return;
      }
      case 'busy':
      case 'unavailable':
        // Nothing was written (every refusal after a write is `error`): tried again later.
        await this.markOrKeep({ taskId: task.id, attempted: false });
        this.backoff(task.id);
        return;
      case 'error':
        // It may have been written in part: never typed again, and the task fails (the reason goes with it).
        await this.fail(task.id, rec.workspaceId, 'the task may have reached the agent only in part');
        return;
      default:
        // `session_changed` / `folder_trust`: not expected for an agent this daemon started; nothing was written.
        await this.markOrKeep({ taskId: task.id, attempted: false });
        await this.fail(task.id, rec.workspaceId, `the agent could not take the task (${result})`);
    }
  }

  /** The delivered task moved to `working`; tried again each pass until it is (never by typing it again). */
  private async toWorking(ep: Episode): Promise<void> {
    const state = this.deps.tasks.get(ep.taskId)?.status.state;
    if (state !== 'submitted') {
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
    if (!ep.working) await this.toWorking(ep);
    const path = this.deps.transcriptPath(ep.sessionId);
    if (!path) return;
    // Bound only after the write: read from where the file began. Bound to another file since: not this turn's.
    if (ep.path === null) ep.path = path;
    else if (ep.path !== path) return this.finish(ep, { kind: 'failed', reason: "the agent's conversation was replaced on this PC" });
    const lines: Array<{ line: string; events: TurnEvent[] }> = [];
    const delta = readTranscriptDelta(path, ep.offset, undefined, (line, offset) => {
      const events = parseTranscriptLine(line, offset);
      lines.push({ line, events });
      return events;
    });
    if (!delta) return;
    // The file was cut or replaced: the turn cannot be followed any more.
    if (delta.reset) return this.finish(ep, { kind: 'failed', reason: "the agent's conversation was replaced on this PC" });
    ep.offset = delta.cursor.tailOffset;
    for (const { line, events } of lines) {
      const outcome = stepEpisode(ep, line, events);
      if (outcome) return this.finish(ep, outcome);
    }
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
        const reason = sent.error === 'too-large'
          ? "the agent's answer is larger than a reply may be"
          : `the agent's answer could not be sent: ${sent.error ?? 'unknown'}`;
        ep.outcome = { kind: 'failed', reason };
        if (await this.fail(ep.taskId, ep.workspaceId, reason)) this.drop(ep);
        return;
      }
    }
    if (!ep.working) await this.toWorking(ep);
    if (this.deps.tasks.get(ep.taskId)?.status.state !== 'working') return this.drop(ep);
    const moved = await this.deps.transition({ taskId: ep.taskId, workspaceId: ep.workspaceId, to: 'input-required' })
      .catch((err: unknown) => ({ ok: false, error: errMsg(err) }));
    if (moved.ok) this.drop(ep);
    else this.deps.log('warn', `[headless] task ${ep.taskId}: not moved to input-required, tried again: ${moved.error ?? 'unknown'}`);
  }

  /** The episode is done with (only this one: another may have taken the session since). */
  private drop(ep: Episode): void {
    if (this.episodes.get(ep.sessionId) === ep) this.episodes.delete(ep.sessionId);
    if (this.questions.get(ep.sessionId)?.taskId === ep.taskId) this.questions.delete(ep.sessionId);
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
    if (!state || (TERMINAL_STATES as readonly string[]).includes(state)) return true;
    const to = wanted === 'failed' && state === 'submitted' ? 'canceled' : wanted;
    const res = await this.deps.transition({ taskId, workspaceId, to, summary: reason }).catch((err: unknown) => ({ ok: false, error: errMsg(err) }));
    if (!res.ok) this.deps.log('warn', `[headless] task ${taskId}: not marked ${to} (${reason}): ${res.error ?? 'unknown'}`);
    return res.ok;
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
    this.unsentMarks.set(input.taskId, input);
    this.deps.log('warn', `[headless] task ${input.taskId}: mark not recorded, tried again: ${res.error ?? 'unknown'}`);
  }

  private backoff(taskId: string): void {
    const prev = this.retry.get(taskId);
    const waitMs = prev ? Math.min(prev.waitMs * 2, RETRY_MAX_MS) : RETRY_MIN_MS;
    this.retry.set(taskId, { at: this.now() + waitMs, waitMs });
  }
}
