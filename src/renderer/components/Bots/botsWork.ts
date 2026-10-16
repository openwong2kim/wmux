// ─── Work a conversation handed off, folded into one card (pure) ─────────
//
// Owner decision 2026-10-16: a thread a conversation started (a
// coordinator's request thread, opened from its 1:1 or a group chat;
// botsModel.ts dmStartedThreads / groupStartedThreads) shows in that
// conversation as one work card at the position of its root, instead of the
// thread's own cards: who it was handed to, the request, the delegate's
// newest message, its state, and the steps folded inside. A card that waits
// on the owner still shows in the timeline too; the side panel still shows
// the whole thread. This module reads the cards the card is built from;
// botsTimeline.ts places it and BotsWorkCard.tsx draws it.
import { dmThreadBot, groupThreadGroup, type RoomCard, type ThreadId, type ThreadSummary } from '../../../shared/room';
import type { BotTaskView } from '../../../shared/botTask';
import { dmStartedThreads, groupStartedThreads, type Conversation } from './botsModel';

type ThreadsByWorkspace = Readonly<Record<string, readonly ThreadSummary[] | undefined>>;

/** The thread keys (`workspaceId\0threadId`, botsTimeline threadKey) of the
 *  threads this conversation started. Pure. */
export function conversationStartedThreads(conversation: Conversation, cards: readonly RoomCard[], threads: ThreadsByWorkspace = {}): Set<string> {
  const out = new Set<string>();
  if (conversation.kind === 'bot') {
    for (const [key, botId] of dmStartedThreads(cards, threads)) if (botId === conversation.row.bot.id) out.add(key);
  } else {
    for (const [key, owner] of groupStartedThreads(cards, threads)) if (owner === conversation.threadId) out.add(key);
  }
  return out;
}

/** A started thread as the timeline holds it: its cards in order — `steps`,
 *  folded into the card (the thread's own cards and main's pointer lines
 *  about it in the conversation's thread, "Finished: …"), and `all`, the
 *  steps plus the cards that wait on the owner (shown in the timeline). */
export interface WorkThread {
  workspaceId: string;
  threadId: ThreadId;
  steps: RoomCard[];
  all: RoomCard[];
}

/** The work card's state: a task's worker at work (or no end yet), its
 *  report waiting for review, something waiting on the owner, or ended. */
export type WorkState = 'working' | 'review' | 'needsYou' | 'done' | 'failed' | 'cancelled';

export interface WorkView {
  /** The bot the work was handed to (the opening hop's addressee). */
  delegateId: string | null;
  /** The request's words (the owner's request, else the handoff's title);
   *  null: none known, the reader shows the kind word. */
  title: string | null;
  /** The delegate's newest message in the thread. */
  latest: RoomCard | null;
  state: WorkState;
  /** The newest card's time, waiting cards included. */
  lastAt: number;
  /** A GitHub pull request or issue the work is about. */
  refUrl: string | null;
}

/** main's opening hop line: `<kind> → <name>: <title>` (roomWriter.ts). */
const HOP_LINE = /^([a-z_]+) → [^:]+?: (.+)$/s;
/** main's line for a refused opening hop (roomWriter.ts). */
const REFUSED_LINE = /^Handoff refused \([^)]*\): (.+)$/s;
/** main's pointer in the conversation once the work came back (handoffRouter pointToThread). */
const POINTER_LINE = /^(Finished|Stopped): (.+)$/s;
const GITHUB_REF = /https?:\/\/github\.com\/[^/\s]+\/[^/\s#?]+\/(?:pull|issues)\/\d+/gi;
const FORWARDED = / \(forwarded by wmux\)$/;

/** General, a 1:1 or a group chat: a conversation's own thread. */
function isConversationThread(threadId: unknown): boolean {
  return threadId === 'general' || !!dmThreadBot(threadId) || !!groupThreadGroup(threadId);
}

/** Whether a card is main's line, in a conversation's own thread, about
 *  another thread (the pointer to a started thread: "Finished: …"). */
export function isPointerCard(card: RoomCard): boolean {
  const linked = card.refs?.threadId;
  return card.actor.kind === 'system' && !!linked && isConversationThread(card.threadId) && !isConversationThread(linked);
}

/** The bot a started thread was handed to: the addressee main names on the
 *  thread's opening hop (`refs.botId`), else the first bot other than the
 *  delegating one that wrote there. Pure. */
export function workDelegate(cards: readonly RoomCard[], delegatorId: string | null): string | null {
  for (const c of cards) {
    if (c.actor.kind === 'system' && c.threadId === `handoff:${c.refs?.handoffId}` && c.refs?.botId && HOP_LINE.test(c.title)) return c.refs.botId;
  }
  for (const c of cards) if (c.actor.kind === 'bot' && c.actor.botId !== delegatorId && !isPointerCard(c)) return c.actor.botId;
  return null;
}

/** The work's name for a started thread: the title the delegating bot gave
 *  the handoff, from main's opening hop (delivered or refused) or its
 *  pointer line, else the first line of the owner's request (roomFormat
 *  requestTitles; often only a short reply such as "go ahead"). Pure. */
export function workTitle(cards: readonly RoomCard[], threadId: ThreadId, requestTitle?: (threadId: ThreadId) => string | null): string | null {
  for (const c of cards) {
    if (c.actor.kind !== 'system') continue;
    const opening = c.threadId === threadId && threadId === `handoff:${c.refs?.handoffId}`;
    const hop = opening ? HOP_LINE.exec(c.title)?.[2] ?? REFUSED_LINE.exec(c.title)?.[1] : undefined;
    const pointer = !hop && isPointerCard(c) ? POINTER_LINE.exec(c.title)?.[2] : undefined;
    const line = (hop ?? pointer ?? '').replace(FORWARDED, '').split('\n')[0].trim();
    if (line) return line;
  }
  return requestTitle?.(threadId)?.trim() || null;
}

/** The delegate's newest message in the thread (any other bot's but the
 *  delegating one's when the delegate wrote none). Pure. */
export function workLatest(cards: readonly RoomCard[], delegateId: string | null, delegatorId: string | null): RoomCard | null {
  let other: RoomCard | null = null;
  for (let i = cards.length - 1; i >= 0; i--) {
    const c = cards[i];
    if (c.actor.kind !== 'bot' || isPointerCard(c)) continue;
    if (c.actor.botId === delegateId) return c;
    if (!other && c.actor.botId !== delegatorId) other = c;
  }
  return other;
}

/** The task stages whose task is not over. */
const LIVE_STAGE: ReadonlySet<BotTaskView['stage']> = new Set<BotTaskView['stage']>(['working', 'needs_input', 'waiting_slot', 'coded']);

/** An ended task's outcome. */
function endedState(stage: BotTaskView['stage']): WorkState {
  return stage === 'failed' ? 'failed' : stage === 'cancelled' ? 'cancelled' : 'done';
}

/** The state a card on its own says, in thread order (null: none). A
 *  worker's ask for input is not one: what waits on the owner is read from
 *  the open cards and the live tasks. */
function cardState(c: RoomCard): WorkState | null {
  if (c.kind === 'refusal') return 'failed';
  if (c.actor.kind !== 'system') return null;
  switch (c.notice?.code) {
    case 'task.reported': return 'review';
    case 'task.done': return 'done';
    case 'task.failed': return 'failed';
    case 'task.cancelled':
    case 'task.stoppedByOwner': return 'cancelled';
    default: break;
  }
  const pointer = isPointerCard(c) ? POINTER_LINE.exec(c.title) : null;
  if (pointer) return pointer[1] === 'Finished' ? 'done' : 'failed';
  const hop = HOP_LINE.exec(c.title);
  if (hop && hop[1] === 'dispatch') return 'working';
  return null;
}

/** A started thread's state. Something waiting on the owner wins (an open
 *  card, or a task's worker asking for input); then a live task of the
 *  thread (its cards' `refs.taskId`, in the bots' task lists): at work, or
 *  reported and waiting for review; else the newest word — a card's (a
 *  task's end, main's Finished or Stopped line, a refusal, a new dispatch)
 *  or the newest ended task's outcome (a task's end may write no card of
 *  its own) — and, with none, at work. Pure. */
export function workState(cards: readonly RoomCard[], waits: (card: RoomCard) => boolean, tasks: readonly BotTaskView[] = []): WorkState {
  if (cards.some(waits)) return 'needsYou';
  const ids = new Set(cards.map((c) => c.refs?.taskId).filter((id): id is string => !!id));
  const known = tasks.filter((task) => ids.has(task.taskId));
  const live = known.filter((task) => LIVE_STAGE.has(task.stage));
  if (live.some((task) => task.stage === 'needs_input')) return 'needsYou';
  if (live.some((task) => task.stage === 'working' || task.stage === 'waiting_slot')) return 'working';
  if (live.length > 0) return 'review';
  let state: WorkState = 'working';
  let saidAt = -Infinity;
  for (const c of cards) {
    const said = cardState(c);
    if (said) {
      state = said;
      saidAt = c.at;
    }
  }
  const ended = known.reduce<BotTaskView | null>((m, task) => (!m || task.updatedAt > m.updatedAt ? task : m), null);
  return ended && ended.updatedAt >= saidAt ? endedState(ended.stage) : state;
}

/** The GitHub pull request or issue a started thread is about: one its
 *  tasks opened (`prUrl`, by task id), else the newest one a card links. Pure. */
export function workRef(cards: readonly RoomCard[], prUrl?: (taskId: string) => string | null): string | null {
  for (let i = cards.length - 1; i >= 0; i--) {
    const taskId = cards[i].refs?.taskId;
    const url = taskId ? prUrl?.(taskId) : null;
    if (url) return url;
  }
  for (let i = cards.length - 1; i >= 0; i--) {
    const c = cards[i];
    const linked = c.refs?.url && /^https?:\/\/github\.com\/[^/\s]+\/[^/\s#?]+\/(?:pull|issues)\/\d+/i.test(c.refs.url) ? c.refs.url : null;
    if (linked) return linked;
    const found = `${c.title}\n${c.body ?? ''}`.match(GITHUB_REF);
    if (found) return found[found.length - 1];
  }
  return null;
}

/** Everything the work card shows for a started thread. Pure. */
export function workView(work: WorkThread, opts: {
  delegatorId: string | null;
  waits: (card: RoomCard) => boolean;
  tasks?: readonly BotTaskView[];
  requestTitle?: (threadId: ThreadId) => string | null;
  prUrl?: (taskId: string) => string | null;
}): WorkView {
  const delegateId = workDelegate(work.all, opts.delegatorId);
  return {
    delegateId,
    title: workTitle(work.all, work.threadId, opts.requestTitle),
    latest: workLatest(work.all, delegateId, opts.delegatorId),
    state: workState(work.all, opts.waits, opts.tasks),
    lastAt: work.all.reduce((m, c) => Math.max(m, c.at), 0),
    refUrl: workRef(work.all, opts.prUrl),
  };
}
