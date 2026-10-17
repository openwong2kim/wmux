// ─── Bot notices — main tells a bot what became of its work ────────────────
//
// Some outcomes reach a bot through no fact it watches: a worker it asked
// for could not start (the fan-out was accepted, then its setup failed), or
// did start; an approval it asked for was decided; a pull request it was
// talking about merged. For each, main appends one `bot.notice` fact
// addressed to that bot (ref.botId, ref.messageId = the notice key, so one
// key is one notice) and queues one priority-1 wake carrying it, pinned to
// the thread the notice is about — except a worker that started, which is
// recorded only (its task's own wakes follow; a wake for it would cost the
// bot a turn per worker). When the owner should see it too
// (`card`), the room module writes the fact's card in that thread
// (roomWriter.systemCardForFact).
//
// The fact log drops a repeat key and the wake queue drops a fact id the bot
// already holds, so a notice sent twice (two paths observing one merge)
// wakes the bot once.

import type { BotNoticePayload, Fact, FactDraft } from '../../shared/facts';
import { parseThreadId, type CardNotice, type ThreadId } from '../../shared/room';
import type { FactLogApi } from './triggerEngine';
import type { WakeSinkApi } from './wakeQueue';

export const BOT_NOTICE_LIMITS = { TITLE_MAX: 200, BODY_MAX: 1200, DETAIL_MAX: 1200, KEY_MAX: 160 } as const;

export interface BotNoticeInput {
  /** Record it without waking the bot (it reads it with its next wake's
   *  facts or fact_poll). */
  quiet?: boolean;
  botId: string;
  workspaceId: string;
  /** One notice per key and bot. */
  key: string;
  topic: BotNoticePayload['topic'];
  title: string;
  body?: string;
  detail?: string;
  threadId?: ThreadId;
  card?: boolean;
  tainted?: boolean;
  repoKey?: string;
  pr?: number;
  taskId?: string;
  /** The card's stable code, so the reader's language words it (RoomCard.notice). */
  notice?: CardNotice;
}

export interface BotNoticePorts {
  factLog: () => Pick<FactLogApi, 'append'> | null | undefined;
  wakes: () => WakeSinkApi | null | undefined;
  now?: () => number;
  log?: (line: string) => void;
}

function clip(v: string | undefined, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

/** The fact draft of one notice. Pure. */
export function botNoticeDraft(n: BotNoticeInput, at: number): FactDraft<'bot.notice'> | null {
  const title = clip(n.title?.replace(/\s+/g, ' '), BOT_NOTICE_LIMITS.TITLE_MAX);
  const key = clip(n.key, BOT_NOTICE_LIMITS.KEY_MAX);
  if (!title || !key || !n.botId || !n.workspaceId) return null;
  const threadId = n.threadId ? parseThreadId(n.threadId) : null;
  const body = clip(n.body, BOT_NOTICE_LIMITS.BODY_MAX);
  const detail = clip(n.detail, BOT_NOTICE_LIMITS.DETAIL_MAX);
  const payload: BotNoticePayload = {
    topic: n.topic,
    title,
    ...(body ? { body } : {}),
    ...(detail ? { detail } : {}),
    ...(threadId ? { threadId } : {}),
    ...(n.card ? { card: true } : {}),
    ...(n.notice ? { notice: n.notice } : {}),
    // Text main did not write is outside text, whatever else says so.
    ...(n.tainted || detail ? { tainted: true } : {}),
  };
  return {
    kind: 'bot.notice',
    at,
    workspaceId: n.workspaceId,
    ...(n.repoKey ? { repoKey: n.repoKey } : {}),
    ref: {
      botId: n.botId,
      messageId: key,
      ...(typeof n.pr === 'number' ? { pr: n.pr } : {}),
      ...(n.taskId ? { taskId: n.taskId } : {}),
    },
    actor: { kind: 'system' },
    payload: payload as unknown as Record<string, unknown>,
  };
}

/**
 * Append the notice and wake its bot once with it. Returns the fact, or
 * null when it was not written (a repeat key, no fact log): a repeat wakes
 * nobody. Never throws.
 */
export function noticeBot(ports: BotNoticePorts, n: BotNoticeInput): Fact | null {
  const log = ports.log ?? ((l: string) => console.warn(l));
  const draft = botNoticeDraft(n, (ports.now ?? Date.now)());
  if (!draft) return null;
  let fact: Fact | null = null;
  try {
    fact = ports.factLog()?.append(draft) ?? null;
  } catch (err) {
    log(`[factory] bot notice ${n.key} not written: ${String(err)}`);
    return null;
  }
  if (!fact || n.quiet) return fact;
  const threadId = draft.payload.threadId as ThreadId | undefined;
  try {
    ports.wakes()?.enqueue({
      botId: n.botId,
      workspaceId: n.workspaceId,
      reason: { kind: 'facts', factIds: [fact.id], trigger: { kind: 'bot.notice' } },
      priority: 1,
      ...(threadId ? { threadId } : {}),
    });
  } catch (err) {
    log(`[factory] bot notice ${n.key}: wake not queued: ${String(err)}`);
  }
  return fact;
}

// ── A bot's workers: started, or could not start ───────────────────────────

/** What became of one accepted bot fan-out (fanout.rpc.ts tellBot). */
export interface BotWorkerStartOutcome {
  /** The bot's workspace (its room). */
  workspaceId: string;
  /** The thread the bot was talking in when it asked (general included). */
  threadId: ThreadId;
  /** The fan-out's idempotency key (one notice per task of it). */
  key: string;
  /** The asking wake carried outside text. */
  tainted: boolean;
  tasks: ReadonlyArray<{
    index: number;
    title: string;
    taskId?: string;
    started: boolean;
    /** Why it did not start, in main's words (plainStartFailure). */
    reason?: string;
    /** The raw error, for the bot only (data). */
    detail?: string;
  }>;
}

/** Why a worker could not start: what in the fan-out's error says so, the
 *  plain words, and their stable code (the notice's `cause`, roomFormat.ts),
 *  first match wins. */
const START_FAILURES: ReadonlyArray<{ test: RegExp; code: string; text: string }> = [
  { test: /fetch|pull\/\d+\/head|resolvecheckout|checkout/, code: 'fetch', text: 'the code it was to check could not be fetched from the repository' },
  { test: /worktree|branch .*exists|already exists/, code: 'worktree', text: 'its worktree could not be created' },
  { test: /preflight|not a git repository|repository/, code: 'repository', text: 'the repository was not ready for a new worker' },
  { test: /prompt file/, code: 'promptFile', text: 'its instructions could not be written' },
  { test: /slot/, code: 'slot', text: 'no agent slot freed up for it' },
  { test: /launch|spawn|workspace|pane/, code: 'pane', text: 'its pane could not be opened' },
  { test: /setup/, code: 'setupStep', text: 'the repository\'s setup step failed' },
  { test: /(?:)/, code: 'setup', text: 'its setup failed' },
];

/** Why a worker could not start, in plain words, from the fan-out's error
 *  text (which is never shown to the owner). Pure. */
export function plainStartFailure(error: string): string {
  // #2256: pty:create's own sentence for a path cmd cannot carry names the
  // cause and the remedy (promptFileArgument.cmdLaunchPathRefusal), as does
  // the merge-lane guard's for a data folder no shell can pass (#2268,
  // promptFileArgument.dataDirNoShellRefusal), in any shell.
  const cmd = /Command Prompt cannot pass [^\n]*/.exec(error);
  if (cmd) return cmd[0];
  const e = error.toLowerCase();
  return (START_FAILURES.find((f) => f.test.test(e)) ?? START_FAILURES[START_FAILURES.length - 1]).text;
}

/** The stable code of plainStartFailure's words, or null for words it did
 *  not choose (pty:create's own sentence): those keep their English. Pure. */
export function startFailureCode(reason: string): string | null {
  return START_FAILURES.find((f) => f.text === reason)?.code ?? null;
}

/** Per task: a worker that could not start wakes its bot and gets a card
 *  in the bot's thread; one that started is recorded without a wake. */
export function noticeWorkerStarts(ports: BotNoticePorts, botId: string, outcome: BotWorkerStartOutcome): void {
  for (const t of outcome.tasks) {
    const title = t.title.replace(/\s+/g, ' ').trim().slice(0, 120) || 'a task';
    if (t.started) {
      // Recorded, not woken for: a started worker costs its bot no turn; the
      // task's own wakes (done, failed, needs input) follow.
      noticeBot(ports, {
        quiet: true,
        botId,
        workspaceId: outcome.workspaceId,
        key: `worker.started:${t.taskId ?? `${outcome.key}#${t.index}`}`,
        topic: 'worker.started',
        title: `Your worker for "${title}" started${t.taskId ? ` (task ${t.taskId})` : ''}.`,
        body: 'It reports in its ledger row; you are woken when it finishes or needs input.',
        threadId: outcome.threadId,
        tainted: outcome.tainted,
        ...(t.taskId ? { taskId: t.taskId } : {}),
      });
      continue;
    }
    const reason = t.reason || 'its setup failed';
    const cause = startFailureCode(reason);
    // The task's title gives way so the reason reaches the card whole (#2256).
    const room = BOT_NOTICE_LIMITS.TITLE_MAX - 'Worker for "" could not start: '.length - reason.length;
    const named = title.length <= room ? title : room >= 2 ? `${title.slice(0, room - 1)}…` : null;
    noticeBot(ports, {
      botId,
      workspaceId: outcome.workspaceId,
      key: `worker.start_failed:${outcome.key}#${t.index}`,
      topic: 'worker.start_failed',
      title: named === null ? `Worker could not start: ${reason}` : `Worker for "${named}" could not start: ${reason}`,
      body: 'Nothing is running for it. Tell the owner plainly, then fix the cause or start it again.',
      ...(t.detail ? { detail: t.detail } : {}),
      ...(cause ? { notice: { code: 'worker.startFailed', args: { title, cause } } } : {}),
      threadId: outcome.threadId,
      card: true,
      tainted: outcome.tainted,
      ...(t.taskId ? { taskId: t.taskId } : {}),
    });
  }
}
