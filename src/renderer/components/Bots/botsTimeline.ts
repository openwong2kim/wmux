// ─── A Bots conversation as a flat timeline (owner decision 2026-10-14) ────
//
// Messages are bubbles in runs, as the reference messenger draws them: the
// history becomes a list of items — a date and time separator, the
// session's "New" divider, a system line
// (consecutive system cards of one thread merged into one), and messages. A
// message continues the run above it when the same author wrote it less
// than ten minutes after the previous one with nothing between them; a run
// shows its author's name above its first bubble and the author's avatar
// once, beside its last (`runEnd`). A card that waits on the owner stays in
// its run as a distinct card. A separator comes at each new day and after an
// hour's quiet.
//
// Threads (owner decision 2026-10-14): a non-General thread shows in the main
// timeline as its first card (the root), with "N replies · last 14:02" under
// it that opens the thread in a side panel — a system root (a task's start)
// as much as a message. Its other cards live in that panel, except a card
// that waits on the owner, which always shows in the main timeline too, and
// the bot's newest reply in it, which shows there marked with its thread: the
// owner reads a finished task's answer without opening the thread.
//
// Pure; times are local.
import { dmThreadBot, groupThreadGroup, type RoomCard, type ThreadId } from '../../../shared/room';
import type { RoomEntry } from './botsModel';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** A run of one author's messages holds while each follows the last by less than this. */
export const RUN_WINDOW_MS = 10 * 60_000;

/** A quiet this long brings a date and time separator, as a new day does. */
export const SEPARATOR_GAP_MS = 60 * 60_000;

/** The kinds that read as plain speech: no kind word in the bubble. */
const PLAIN_KINDS: ReadonlySet<RoomCard['kind']> = new Set<RoomCard['kind']>(['opinion', 'status', 'human']);

/** A thread as its root's summary line shows it. */
export interface ThreadView {
  workspaceId: string;
  threadId: ThreadId;
  /** The thread's cards after its root. */
  replies: number;
  /** The newest reply's time (the root's when there is none). */
  lastAt: number;
}

export type TimelineItem =
  | { kind: 'day'; key: string; at: number }
  | { kind: 'new'; key: string }
  | { kind: 'system'; key: string; cards: RoomCard[]; thread?: ThreadView }
  | { kind: 'message'; key: string; card: RoomCard; continuation: boolean; runEnd: boolean; waiting: boolean; thread?: ThreadView; inThread?: boolean };

/** The key a thread is known by: a thread id is a room's own, so a 1:1
 *  (which spans rooms) keys it with its workspace. */
export function threadKey(workspaceId: string, threadId: ThreadId): string {
  return `${workspaceId}\u0000${threadId}`;
}

/** The main timeline's cards and the threads behind them: General cards
 *  (and a 1:1's or a group chat's thread: the conversation itself), each
 *  thread's root (first
 *  card) with its summary, any thread card that waits on the owner, and
 *  each thread's newest bot reply (`surfaced`). */
export function splitThreads(cards: readonly RoomCard[], waits: (card: RoomCard) => boolean): { main: RoomCard[]; threads: Map<string, ThreadView>; surfaced: Set<string> } {
  const main: RoomCard[] = [];
  const byKey = new Map<string, ThreadView>();
  const rootOf = new Map<string, string>();
  const lastBotReply = new Map<string, string>();
  const inMain = (card: RoomCard) => card.threadId === 'general' || dmThreadBot(card.threadId) !== null || groupThreadGroup(card.threadId) !== null;
  for (const card of cards) {
    if (inMain(card)) continue;
    const key = threadKey(card.workspaceId, card.threadId);
    if (!rootOf.has(key)) rootOf.set(key, card.id);
    else if (card.actor.kind === 'bot') lastBotReply.set(key, card.id);
  }
  const surfaced = new Set(lastBotReply.values());
  for (const card of cards) {
    if (inMain(card)) {
      main.push(card);
      continue;
    }
    const key = threadKey(card.workspaceId, card.threadId);
    const view = byKey.get(key);
    if (!view) {
      byKey.set(key, { workspaceId: card.workspaceId, threadId: card.threadId, replies: 0, lastAt: card.at });
      main.push(card);
      continue;
    }
    view.replies += 1;
    view.lastAt = Math.max(view.lastAt, card.at);
    if (waits(card) || surfaced.has(card.id)) main.push(card);
  }
  const threads = new Map<string, ThreadView>();
  for (const [key, view] of byKey) threads.set(rootOf.get(key)!, view);
  return { main, threads, surfaced };
}

/** A thread's own cards, and the cards elsewhere that link it (an approval
 *  posted in General about a PR), in order. */
export function threadCards(cards: readonly RoomCard[], workspaceId: string, threadId: ThreadId): RoomCard[] {
  return cards.filter((c) => c.workspaceId === workspaceId && (c.threadId === threadId || c.refs?.threadId === threadId));
}

/** Who wrote a card, as runs compare it. */
function author(card: RoomCard): string {
  return card.actor.kind === 'bot' ? `bot:${card.actor.botId}` : card.actor.kind;
}

/** The local day a time falls on. */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function entryAt(entry: RoomEntry): number {
  return entry.card.at;
}

/**
 * The timeline items for entries already in order. `waits` says which
 * cards wait on the owner; `threads` maps a root card's id to its thread;
 * `newAfter` places the "New" divider above the first card from someone
 * else written after it (null: none).
 */
export function buildTimeline(entries: readonly RoomEntry[], opts: {
  waits: (card: RoomCard) => boolean;
  threads?: ReadonlyMap<string, ThreadView>;
  /** Thread replies shown in the main timeline (splitThreads). */
  surfaced?: ReadonlySet<string>;
  newAfter?: number | null;
}): TimelineItem[] {
  const out: TimelineItem[] = [];
  let day = '';
  let lastAt = -Infinity;
  let newPlaced = opts.newAfter == null;
  for (const entry of entries) {
    const at = entryAt(entry);
    const d = dayKey(at);
    if (d !== day || at - lastAt >= SEPARATOR_GAP_MS) {
      day = d;
      out.push({ kind: 'day', key: `day:${at}:${out.length}`, at });
    }
    lastAt = Math.max(lastAt, at);
    if (!newPlaced && entry.kind === 'card' && entry.card.actor.kind !== 'human' && at > (opts.newAfter as number)) {
      newPlaced = true;
      out.push({ kind: 'new', key: 'new' });
    }
    const card = entry.card;
    const prev = out[out.length - 1];
    if (card.actor.kind === 'system') {
      const thread = opts.threads?.get(card.id);
      if (prev?.kind === 'system' && prev.cards[0].threadId === card.threadId && prev.cards[0].workspaceId === card.workspaceId) {
        prev.cards.push(card);
        prev.key = `system:${prev.cards[0].id}`;
        if (thread) prev.thread = thread;
      } else {
        out.push({ kind: 'system', key: `system:${card.id}`, cards: [card], ...(thread ? { thread } : {}) });
      }
      continue;
    }
    const waiting = opts.waits(card);
    const continuation = prev?.kind === 'message'
      && author(prev.card) === author(card)
      && card.at - prev.card.at < RUN_WINDOW_MS;
    if (continuation && prev.kind === 'message') prev.runEnd = false;
    const thread = opts.threads?.get(card.id);
    out.push({
      kind: 'message', key: card.id, card, continuation, runEnd: true, waiting,
      ...(thread ? { thread } : {}),
      ...(opts.surfaced?.has(card.id) ? { inThread: true } : {}),
    });
  }
  return out;
}

/** Whether a card's kind gets a word in its run header (Verdict, Report…). */
export function hasKindWord(card: RoomCard): boolean {
  return !PLAIN_KINDS.has(card.kind);
}

/** A run header's time: the clock. */
export function clockTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** A time in full, for a tooltip. */
export function fullTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A separator's label in the reader's language: the date with its weekday
 *  and the time ("Sun, Oct 11 · 8:37 PM", "10월 11일 (일) 오후 8:37"); the
 *  year only when it is not this year's. */
export function separatorLabel(at: number, now: number, t: T, locale?: string): string {
  const d = new Date(at);
  const date = d.toLocaleDateString(locale, {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}),
  });
  const time = d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  return t('botsPage.chat.dateTime', { date, time });
}

/** Elapsed time as m:ss (h:mm:ss past an hour). */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** The cards a reader has not seen: bot messages written after `since`. */
export function unreadCount(cards: readonly RoomCard[], since: number): number {
  let n = 0;
  for (const c of cards) if (c.actor.kind === 'bot' && c.at > since) n += 1;
  return n;
}

/** A card counts as arriving live only this soon after it was written: a
 *  page of history or a catch-up read brings older cards. */
export const LIVE_ARRIVAL_MS = 60_000;

/** The "New" divider's boundary after cards arrive in an open chat (`before`:
 *  the newest card's time before they came). A card that lands live (newer
 *  than `before`, written within LIVE_ARRIVAL_MS of `now`) while the owner
 *  has the chat in view is read as it arrives: when nothing else is new, the
 *  boundary moves past it, so no divider is drawn above a live reply. Out of
 *  view it stays new; history and catch-up reads (older cards) stay new; and
 *  a divider already drawn for what was unread when the chat opened stays
 *  where it is. Pure. */
export function liveNewAfter(cards: readonly RoomCard[], newAfter: number, before: number, inView: boolean, now: number): number {
  if (!inView) return newAfter;
  const live = (c: RoomCard): boolean => c.at > before && now - c.at <= LIVE_ARRIVAL_MS;
  if (cards.some((c) => c.actor.kind !== 'human' && c.at > newAfter && !live(c))) return newAfter;
  return cards.reduce((m, c) => Math.max(m, c.at), newAfter);
}
