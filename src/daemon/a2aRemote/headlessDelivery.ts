import crypto from 'node:crypto';
import type { SessionPromptScheduleResult } from '../../shared/sessionPromptSchedule';
import { sanitizeBracketedPastePayload } from '../../shared/ptyMessageDelivery';
import { localSideOf, type A2aRemoteTaskState } from '../../shared/a2aRemoteDelivery';
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
 * the agent's answer goes back as the task's reply.
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
/** Bound on one transcript read per tick. */
const READ_MAX_BYTES = 1024 * 1024;

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
    get(taskId: string): Task | undefined;
  };
  /** The daemon's own `a2a.remote.mark` (attempted / delivered / held), as main calls it. */
  mark(input: { taskId: string; attempted?: boolean; delivered?: true; held?: 'delivery-unconfirmed'; ptyId?: string }): Promise<{ ok: boolean; error?: string }>;
  /**
   * Type `prompt` into the session and press Enter (`deliverPromptToSessionNow`).
   * `authorized` is asked before the first write and before Enter.
   */
  deliver(sessionId: string, agent: HeadlessStartRecordV1['agent'], prompt: string, authorized: () => boolean): Promise<SessionPromptScheduleResult>;
  /** The agent's transcript file, once the daemon has bound the session to its conversation; null before. */
  transcriptPath(sessionId: string): string | null;
  /** Its size now (0 when it does not exist yet). */
  transcriptSize(path: string): number;
  /** The daemon's own `a2a.remote.reply`, as main calls it. */
  reply(input: { taskId: string; workspaceId: string; text: string; ptyId: string }): Promise<{ ok: boolean; error?: string }>;
  /** Commit a task state as its receiver and tell the peer (`transition` + sync). `summary`: the reason (failed). */
  transition(input: { taskId: string; workspaceId: string; to: 'working' | 'input-required' | 'failed'; summary?: string }): Promise<{ ok: boolean; error?: string }>;
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
  /** Where the transcript is read from next (bytes); the file may not exist yet. */
  offset: number;
  /** The prompt's own user entry was seen. */
  opened: boolean;
  /** A usage-limit stop was seen; the daemon's own continue keeps the episode open. */
  limitStopped: boolean;
  /** Text of the assistant entries since the last tool call: the answer so far. */
  answer: string[];
}

export type EpisodeOutcome =
  | { kind: 'answered'; text: string }
  | { kind: 'failed'; reason: string };

/** The hash a delivered prompt is recognized by in the transcript. */
export function promptHash(prompt: string): string {
  return crypto.createHash('sha256').update(normalizePrompt(sanitizeBracketedPastePayload(prompt))).digest('hex');
}

function normalizePrompt(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

/**
 * The episode after one transcript line (its raw text and the events the
 * projector's parser reads from it), and how it ended, if it did:
 *  - before the prompt's own user entry, any other user entry is input from
 *    this PC (ssh, a channel wake, an automation): the turn is not ours;
 *  - after it, the first turn end closes it with the assistant text since the
 *    last tool call as the answer;
 *  - an interrupt, or an API error other than a usage limit, fails it;
 *  - a usage-limit stop keeps it open, and so does the continue the daemon
 *    types once the limit resets (that exact prompt, after that stop);
 *  - any other user entry inside it is input from this PC: failed, no reply.
 * Compactions, slash commands and reminders parse as `meta`, not user text.
 */
export function stepEpisode(ep: Episode, line: string, events: readonly TurnEvent[]): EpisodeOutcome | null {
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
      const text = normalizePrompt(event.text);
      if (!ep.opened) {
        if (crypto.createHash('sha256').update(text).digest('hex') === ep.promptHash) {
          ep.opened = true;
          continue;
        }
        return { kind: 'failed', reason: 'the agent was given other input on this PC before the task' };
      }
      if (ep.limitStopped && text === USAGE_LIMIT_CONTINUE_PROMPT) {
        ep.limitStopped = false;
        continue;
      }
      return { kind: 'failed', reason: "the agent's turn was taken over by input on this PC" };
    }
    if (!ep.opened) continue;
    if (event.kind === 'tool_use' || event.kind === 'tool_result') ep.answer = [];
    else if (event.kind === 'meta' && event.subtype === 'turn_aborted') return { kind: 'failed', reason: "the agent's turn was interrupted on this PC" };
    else if (event.kind === 'meta' && event.subtype === 'turn_complete') return { kind: 'answered', text: ep.answer.join('\n\n') };
    else if (event.kind === 'assistant_text' && !event.thinking) {
      // One entry may parse to several events: its text is taken once.
      if (!answered) {
        const raw = assistantTextOf(line);
        if (raw !== null) ep.answer.push(raw);
        answered = true;
      }
      if (event.turnComplete) return { kind: 'answered', text: ep.answer.join('\n\n') };
    }
  }
  return null;
}

/**
 * The text blocks of a raw assistant entry, joined; thinking and tool calls
 * left out. Read from the raw line because the parser replaces fenced code
 * with markers (turnEvents.ts), and a reply needs the code itself.
 */
export function assistantTextOf(line: string): string | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const message = (entry as { message?: { content?: unknown } })?.message;
  const content = message?.content;
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
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(deps: HeadlessDeliveryDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), HEADLESS_DELIVERY_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: open episodes read, then owed tasks typed in. Never two at once. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const ep of [...this.episodes.values()]) await this.follow(ep);
      if (this.deps.mode.active()) for (const task of this.deps.tasks.pending()) await this.offer(task);
    } catch (err) {
      this.deps.log('warn', `[headless] delivery pass failed: ${errMsg(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * A start is ending (headlessStarter, before its link breaks): its tasks
   * that are not answered fail with `why`, while the peer can still hear it.
   */
  async startEnding(rec: HeadlessStartRecordV1, why: string): Promise<void> {
    this.episodes.delete(rec.sessionId);
    for (const task of this.deps.tasks.remote()) {
      const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
      if (marker?.direction !== 'inbound' || task.metadata[localSideOf(task)].workspaceId !== rec.workspaceId) continue;
      if (task.status.state !== 'submitted' && task.status.state !== 'working') continue;
      await this.fail(task.id, rec.workspaceId, why);
    }
  }

  /** The start that owns a task's local pane, when it is one of this run's live headless starts. */
  private ownerOf(task: Task): HeadlessStartRecordV1 | null {
    const local = task.metadata[localSideOf(task)];
    const rec = this.deps.starts.list().find((r) => r.workspaceId === local.workspaceId);
    if (!rec || rec.phase !== 'started' || rec.runId !== this.deps.runId || rec.survivors) return null;
    if (local.paneId && local.paneId !== rec.sessionId) return null;
    return rec;
  }

  /** Still the owner at this moment (asked again before the first write and before Enter). */
  private stillOwner(taskId: string, sessionId: string): boolean {
    if (!this.deps.mode.active()) return false;
    const task = this.deps.tasks.get(taskId);
    return !!task && this.ownerOf(task)?.sessionId === sessionId;
  }

  /** Type an owed task in, if it is this run's headless start's and its agent is free. */
  private async offer(task: Task): Promise<void> {
    const marker = task.metadata.remote as A2aRemoteTaskState | undefined;
    if (!marker || marker.direction !== 'inbound' || marker.delivered === true || marker.held) return;
    if ((TERMINAL_STATES as readonly string[]).includes(task.status.state)) return;
    const rec = this.ownerOf(task);
    if (!rec || this.episodes.has(rec.sessionId)) return;
    if (marker.attempted) {
      // A write was started and never confirmed (the daemon stopped mid-way): it may be in the agent's
      // input already, and nobody here can look. Never typed again.
      await this.deps.mark({ taskId: task.id, held: 'delivery-unconfirmed' });
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
    const started = await this.deps.mark({ taskId: task.id, attempted: true });
    if (!started.ok) {
      this.backoff(task.id);
      this.deps.log('warn', `[headless] task ${task.id}: the attempt was not recorded, not typed in: ${started.error ?? 'unknown'}`);
      return;
    }
    const path = this.deps.transcriptPath(rec.sessionId);
    const offset = path ? this.deps.transcriptSize(path) : 0;
    const agentMessages = task.history.filter((m) => m.role === 'agent').length;
    let result: SessionPromptScheduleResult;
    try {
      result = await this.deps.deliver(rec.sessionId, rec.agent, prompt, () => this.stillOwner(task.id, rec.sessionId));
    } catch (err) {
      result = 'error';
      this.deps.log('warn', `[headless] task ${task.id}: typing it in failed: ${errMsg(err)}`);
    }
    switch (result) {
      case 'sent': {
        this.retry.delete(task.id);
        this.episodes.set(rec.sessionId, {
          taskId: task.id, sessionId: rec.sessionId, workspaceId: rec.workspaceId, promptHash: promptHash(prompt),
          sentAt: this.now(), agentMessagesAtSend: agentMessages, offset, opened: false, limitStopped: false, answer: [],
        });
        await this.deps.mark({ taskId: task.id, delivered: true, ptyId: rec.sessionId });
        const working = await this.deps.transition({ taskId: task.id, workspaceId: rec.workspaceId, to: 'working' });
        if (!working.ok) this.deps.log('warn', `[headless] task ${task.id}: not marked working: ${working.error ?? 'unknown'}`);
        this.deps.log('info', `[headless] task ${task.id}: typed into ${rec.sessionId}`);
        return;
      }
      case 'busy':
      case 'unavailable':
        // Nothing was written (every refusal after a write is `error`): tried again later.
        await this.deps.mark({ taskId: task.id, attempted: false });
        this.backoff(task.id);
        return;
      case 'error':
        // It may have been written in part: never typed again.
        await this.deps.mark({ taskId: task.id, held: 'delivery-unconfirmed' });
        await this.fail(task.id, rec.workspaceId, 'the task may have reached the agent only in part');
        return;
      default:
        // `session_changed` / `folder_trust`: not expected for an agent this daemon started; nothing was written.
        await this.deps.mark({ taskId: task.id, attempted: false });
        await this.fail(task.id, rec.workspaceId, `the agent could not take the task (${result})`);
    }
  }

  /** Read what the agent wrote since the last pass; end the episode when its turn did. */
  private async follow(ep: Episode): Promise<void> {
    const path = this.deps.transcriptPath(ep.sessionId);
    if (!path) return;
    const lines: Array<{ line: string; events: TurnEvent[] }> = [];
    const delta = readTranscriptDelta(path, ep.offset, READ_MAX_BYTES, (line, offset) => {
      const events = parseTranscriptLine(line, offset);
      lines.push({ line, events });
      return events;
    });
    if (!delta) return;
    // The file was replaced (a new conversation): the turn cannot be followed any more.
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
   * `input-required`; or `failed` with the reason.
   */
  private async finish(ep: Episode, outcome: EpisodeOutcome): Promise<void> {
    this.episodes.delete(ep.sessionId);
    if (outcome.kind === 'failed') {
      this.deps.log('warn', `[headless] task ${ep.taskId}: ${outcome.reason}`);
      await this.fail(ep.taskId, ep.workspaceId, outcome.reason);
      return;
    }
    const task = this.deps.tasks.get(ep.taskId);
    if (!task || (TERMINAL_STATES as readonly string[]).includes(task.status.state)) return;
    const repliedItself = task.history.filter((m) => m.role === 'agent').length > ep.agentMessagesAtSend;
    if (!repliedItself) {
      const text = outcome.text.trim() || '(the agent ended its turn without text)';
      const sent = await this.deps.reply({ taskId: ep.taskId, workspaceId: ep.workspaceId, text, ptyId: ep.sessionId });
      if (!sent.ok) {
        await this.fail(ep.taskId, ep.workspaceId, sent.error === 'too-large'
          ? "the agent's answer is larger than a reply may be"
          : `the agent's answer could not be sent: ${sent.error ?? 'unknown'}`);
        return;
      }
    }
    if (this.deps.tasks.get(ep.taskId)?.status.state !== 'working') return;
    const moved = await this.deps.transition({ taskId: ep.taskId, workspaceId: ep.workspaceId, to: 'input-required' });
    if (!moved.ok) this.deps.log('warn', `[headless] task ${ep.taskId}: not moved to input-required: ${moved.error ?? 'unknown'}`);
  }

  private async fail(taskId: string, workspaceId: string, reason: string): Promise<void> {
    const res = await this.deps.transition({ taskId, workspaceId, to: 'failed', summary: reason });
    if (!res.ok) this.deps.log('warn', `[headless] task ${taskId}: not marked failed (${reason}): ${res.error ?? 'unknown'}`);
  }

  private backoff(taskId: string): void {
    const prev = this.retry.get(taskId);
    const waitMs = prev ? Math.min(prev.waitMs * 2, RETRY_MAX_MS) : RETRY_MIN_MS;
    this.retry.set(taskId, { at: this.now() + waitMs, waitMs });
  }
}
