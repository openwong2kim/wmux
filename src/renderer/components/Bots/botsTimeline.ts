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
// Work a conversation handed off (owner decision 2026-10-16): a thread the
// conversation started folds into one work card at its root's position —
// its cards and main's pointer lines about it ("Finished: …") — inside the
// delegating bot's run; a card in it that waits on the owner still shows
// (botsWork.ts).
//
// Pure; times are local.
import type { RoomCard, ThreadId } from '../../../shared/room';
import type { RoomEntry } from './botsModel';
import { RUN_WINDOW_MS, placeWork, threadKey, workDelegate, type ThreadView, type WorkThread } from '../../../shared/botsWork';
import { getLocale } from '../../i18n';

export { ANNOUNCE_WINDOW_MS, RUN_WINDOW_MS, placeWork, splitThreads, threadKey, type ThreadView } from '../../../shared/botsWork';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** A quiet this long brings a date and time separator, as a new day does. */
export const SEPARATOR_GAP_MS = 60 * 60_000;

/** The kinds that read as plain speech: no kind word in the bubble. */
const PLAIN_KINDS: ReadonlySet<RoomCard['kind']> = new Set<RoomCard['kind']>(['opinion', 'status', 'human']);

export type TimelineItem =
  | { kind: 'day'; key: string; at: number }
  | { kind: 'new'; key: string }
  | { kind: 'system'; key: string; cards: RoomCard[]; thread?: ThreadView }
  | { kind: 'message'; key: string; card: RoomCard; continuation: boolean; runEnd: boolean; waiting: boolean; thread?: ThreadView; inThread?: boolean }
  /** A thread the conversation started, folded into one card in the run of
   *  the bot that handed it off (`delegatorId`; null: not known). */
  | { kind: 'work'; key: string; work: WorkThread; at: number; delegatorId: string | null; continuation: boolean; runEnd: boolean };

/** A thread's own cards, and the cards elsewhere that link it (an approval
 *  posted in General about a PR), in order. */
export function threadCards(cards: readonly RoomCard[], workspaceId: string, threadId: ThreadId): RoomCard[] {
  return cards.filter((c) => c.workspaceId === workspaceId && (c.threadId === threadId || c.refs?.threadId === threadId));
}

/** Who wrote a card, as runs compare it. */
function author(card: RoomCard): string {
  return card.actor.kind === 'bot' ? `bot:${card.actor.botId}` : card.actor.kind;
}

/** Who a run item is by: a message's author, a work card's delegating bot. */
function itemAuthor(item: Extract<TimelineItem, { kind: 'message' | 'work' }>): string {
  if (item.kind === 'message') return author(item.card);
  return item.delegatorId ? `bot:${item.delegatorId}` : item.key;
}

function itemAt(item: Extract<TimelineItem, { kind: 'message' | 'work' }>): number {
  return item.kind === 'message' ? item.card.at : item.at;
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
 * else written after it (null: none). `work` maps the card standing for a
 * started thread to that thread (splitThreads): it becomes a work item in
 * the run of `workAuthor` (a 1:1's bot), else of the nearest bot above it
 * among `workCandidates` (a group's coordinators) other than the one the
 * work was handed to — none: a run of its own. A work item is new when a
 * card folded into it is. It follows the delegating bot's message that
 * announced the hand-off (placeWork).
 */
export function buildTimeline(entries: readonly RoomEntry[], opts: {
  waits: (card: RoomCard) => boolean;
  threads?: ReadonlyMap<string, ThreadView>;
  /** Thread replies shown in the main timeline (splitThreads). */
  surfaced?: ReadonlySet<string>;
  newAfter?: number | null;
  work?: ReadonlyMap<string, WorkThread>;
  workAuthor?: string;
  workCandidates?: ReadonlySet<string>;
}): TimelineItem[] {
  const out: TimelineItem[] = [];
  let day = '';
  let lastAt = -Infinity;
  let newPlaced = opts.newAfter == null;
  const placed = placeWork(entries, opts);
  for (const entry of placed.entries) {
    const at = placed.at.get(entry.card.id) ?? entryAt(entry);
    const d = dayKey(at);
    if (d !== day || at - lastAt >= SEPARATOR_GAP_MS) {
      day = d;
      out.push({ kind: 'day', key: `day:${at}:${out.length}`, at });
    }
    lastAt = Math.max(lastAt, at);
    const folded = opts.work?.get(entry.card.id);
    const fresh = folded
      ? folded.all.some((c) => c.actor.kind !== 'human' && c.at > (opts.newAfter as number))
      : entry.card.actor.kind !== 'human' && at > (opts.newAfter as number);
    if (!newPlaced && fresh) {
      newPlaced = true;
      out.push({ kind: 'new', key: 'new' });
    }
    const card = entry.card;
    const work = folded;
    if (work) {
      const delegatorId = opts.workAuthor ?? nearestBot(out, workDelegate(work.all, null), opts.workCandidates);
      const item: Extract<TimelineItem, { kind: 'work' }> = {
        kind: 'work', key: `work:${threadKey(work.workspaceId, work.threadId)}`, work, at, delegatorId, continuation: false, runEnd: true,
      };
      const above = out[out.length - 1];
      item.continuation = continues(above, item);
      if (item.continuation && (above?.kind === 'message' || above?.kind === 'work')) above.runEnd = false;
      out.push(item);
      // A first card that waits on the owner shows as itself too.
      if (work.steps.includes(card)) continue;
    }
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
    const thread = opts.threads?.get(card.id);
    const item: Extract<TimelineItem, { kind: 'message' }> = {
      kind: 'message', key: card.id, card, continuation: false, runEnd: true, waiting,
      ...(thread ? { thread } : {}),
      ...(opts.surfaced?.has(card.id) ? { inThread: true } : {}),
    };
    item.continuation = continues(prev, item);
    if (item.continuation && (prev?.kind === 'message' || prev?.kind === 'work')) prev.runEnd = false;
    out.push(item);
  }
  return out;
}

/** Whether a run item continues the run above it: the same author, less
 *  than RUN_WINDOW_MS later, nothing between. */
function continues(prev: TimelineItem | undefined, item: Extract<TimelineItem, { kind: 'message' | 'work' }>): boolean {
  if (prev?.kind !== 'message' && prev?.kind !== 'work') return false;
  return itemAuthor(prev) === itemAuthor(item) && itemAt(item) - itemAt(prev) < RUN_WINDOW_MS;
}

/** The newest bot above in the timeline other than `except`, among
 *  `among` when given, or null. */
function nearestBot(items: readonly TimelineItem[], except: string | null, among?: ReadonlySet<string>): string | null {
  const fits = (id: string) => id !== except && (!among || among.has(id));
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'message' && it.card.actor.kind === 'bot' && fits(it.card.actor.botId)) return it.card.actor.botId;
    if (it.kind === 'work' && it.delegatorId && fits(it.delegatorId)) return it.delegatorId;
  }
  return null;
}

/** Whether a card's kind gets a word in its run header (Verdict, Report…). */
export function hasKindWord(card: RoomCard): boolean {
  return !PLAIN_KINDS.has(card.kind);
}

/** A run header's time: the clock, in the app's language. */
export function clockTime(at: number, locale: string = getLocale()): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  return new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/** A time in full, for a tooltip, in the app's language. */
export function fullTime(at: number, locale: string = getLocale()): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  return new Date(at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
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
