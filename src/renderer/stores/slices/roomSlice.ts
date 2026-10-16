/**
 * Rooms — renderer state for the Bots page's rooms (contract: shared/room.ts).
 *
 *   main RoomWriter ──ROOM_EVENT──▶ useRoomSync ──▶ this slice ──▶ Room/*
 *                  ◀──room:read / room:threads (pages by seq)──┘
 *
 * Memory only. Cards are kept per timeline: the whole room (`ALL_THREADS`)
 * or one thread. A card is identified by its id; a changed card (a question
 * answered) comes back with the same id and seq and replaces the old one, so
 * a timeline never holds a card twice. Order is seq (arrival order), never
 * the card's own time.
 */
import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { RoomCard, ThreadId, ThreadSummary } from '../../../shared/room';
import type { BotRole } from '../../../shared/bot';
import { isTerminalOnlyWorkspace } from './workspaceSlice';

/** The timeline key for "every card of the room". */

/** A card author main knows (room.handler.ts RoomActor). */
export interface RoomActorEntry { role: BotRole; name: string; removed?: true; avatar?: string; hue?: number; workspaceId?: string }

export const ALL_THREADS = '*' as const;
export type TimelineThread = ThreadId | typeof ALL_THREADS;

export interface RoomTimeline {
  cards: RoomCard[];
  /** The seq to read after (room.read sinceSeq). */
  nextSinceSeq: number;
  /** More cards follow nextSinceSeq on the server. */
  hasMore: boolean;
  /** The first read has not answered yet (pushes already collect here). */
  loading?: boolean;
}

/** What the dock knows about the factory (room:status). */
export interface RoomStatusView {
  running: boolean;
  enabled: boolean;
  hqWorkspaceId: string | null;
}

export interface RoomSlice {
  /** null until main answered (or when there is no rooms bridge). */
  roomStatus: RoomStatusView | null;
  roomThreads: Record<string, ThreadSummary[]>;
  /** key: timelineKey(workspaceId, thread). */
  roomTimelines: Record<string, RoomTimeline>;
  /** The thread shown per workspace; absent = the whole room. */
  roomSelectedThread: Record<string, TimelineThread>;
  /** The owner's read position per thread as main accepted it (key: timelineKey). */
  roomReadThrough: Record<string, number>;
  /** Pushes applied so far (a counter), and the count at which each card
   *  was last pushed: a page read that started before a push never undoes it. */
  roomPushCount: number;
  roomPushedAt: Record<string, number>;
  /** Bot authors by id (role and name), from main's bot store; a removed
   *  bot from its tombstone (marked `removed`, with its picture and colour
   *  slot). */
  roomActors: Record<string, RoomActorEntry>;
  /** A conversation thread's newest card, read on its own for the Bots
   *  list's preview when no timeline holds it (key: timelineKey). Not a
   *  timeline: the thread still reads as unread (isTimelineLoaded). */
  roomPreviewCards: Record<string, RoomCard>;
  setRoomPreviewCard: (workspaceId: string, threadId: ThreadId, card: RoomCard) => void;
  setRoomActors: (actors: Record<string, RoomActorEntry>) => void;
  setRoomStatus: (status: RoomStatusView | null) => void;
  setRoomThreads: (workspaceId: string, threads: ThreadSummary[]) => void;
  /** Store a page: `replace` for a first read, `append` for a page after
   *  nextSinceSeq. `startedAt` = roomPushCount when the read was sent: cards
   *  pushed since then win over the page's copies and survive a replace. */
  setRoomPage: (workspaceId: string, thread: TimelineThread, page: RoomTimeline, mode: 'replace' | 'append', startedAt?: number) => void;
  /** A card main wrote or changed, with its thread's new summary. */
  applyRoomEvent: (payload: { workspaceId: string; card: RoomCard; threadSummary: ThreadSummary }) => void;
  selectRoomThread: (workspaceId: string, thread: TimelineThread) => void;
  /** Record a read position; false when it would not move forward. */
  noteRoomRead: (workspaceId: string, threadId: ThreadId, seq: number) => boolean;
  /** The bot worker whose terminal shows beside a Bots conversation, or
   *  null. While the Bots page hosts it, the Workspaces viewport leaves that
   *  workspace unmounted (selectWorkerPanelHost), so its terminal has one
   *  mount; the active workspace never changes. */
  botsWorkerPanel: BotsWorkerPanel | null;
  setBotsWorkerPanel: (panel: BotsWorkerPanel | null) => void;
  /** When each Bots conversation was last read to its newest card, this
   *  session (memory only; absent: BOTS_SESSION_START). A list row counts
   *  the bot messages after it as unread; a chat opened again marks the
   *  first of them "New". */
  botsSeenAt: Record<string, number>;
  /** Move a conversation's read time forward (never back). */
  markBotsSeen: (conversationId: string, at: number) => void;
}

/** Before this session nothing counts as unread on the Bots page: the read
 *  position is not kept across restarts. */
export const BOTS_SESSION_START = Date.now();

export interface BotsWorkerPanel {
  /** The worker's (task) workspace. */
  workspaceId: string;
  /** The Bots conversation it was opened from (Conversation.id). */
  conversationId: string;
}

/** The workspace the Bots page hosts in its worker panel right now, else
 *  null: only while Bots is the page, and only a terminal-only workspace.
 *  Moving a workspace between the viewport and the panel remounts its panes
 *  (terminals replay from the daemon), so one holding a browser or an editor
 *  stays in the viewport, as cold-park leaves it (its state has no replay).
 *  Pure. */
export function selectWorkerPanelHost(s: Pick<StoreState, 'appRoute' | 'botsWorkerPanel' | 'workspaces'>): string | null {
  const id = s.appRoute === 'bots' ? s.botsWorkerPanel?.workspaceId : undefined;
  if (!id) return null;
  const ws = s.workspaces.find((w) => w.id === id);
  return ws && isTerminalOnlyWorkspace(ws) ? id : null;
}

export function timelineKey(workspaceId: string, thread: TimelineThread): string {
  return `${workspaceId}\u0000${thread}`;
}

/** Cards by id (the incoming copy wins), in seq order. */
export function mergeCards(existing: readonly RoomCard[], incoming: readonly RoomCard[]): RoomCard[] {
  const byId = new Map<string, RoomCard>();
  for (const c of existing) byId.set(c.id, c);
  for (const c of incoming) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

const STATUS_RANK: Readonly<Record<ThreadSummary['status'], number>> = { open: 0, quiet: 1, closed: 2 };

/** Threads with an open question first, then open, quiet and closed ones,
 *  each newest (highest last seq) first. */
export function orderThreads(threads: readonly ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) =>
    (b.openQuestions > 0 ? 1 : 0) - (a.openQuestions > 0 ? 1 : 0)
    || STATUS_RANK[a.status] - STATUS_RANK[b.status]
    || b.lastSeq - a.lastSeq,
  );
}

/** The thread list with one summary replaced (or added). */
export function upsertThread(threads: readonly ThreadSummary[], summary: ThreadSummary): ThreadSummary[] {
  const i = threads.findIndex((t) => t.threadId === summary.threadId);
  if (i < 0) return [...threads, summary];
  const next = [...threads];
  next[i] = summary;
  return next;
}

export const createRoomSlice: StateCreator<StoreState, [['zustand/immer', never]], [], RoomSlice> = (set, get) => ({
  roomStatus: null,
  roomThreads: {},
  roomTimelines: {},
  roomSelectedThread: {},
  roomReadThrough: {},
  roomPushCount: 0,
  roomPushedAt: {},
  roomActors: {},
  roomPreviewCards: {},
  botsWorkerPanel: null,
  botsSeenAt: {},
  setRoomActors: (actors) => set((s) => { s.roomActors = actors; }),
  setRoomPreviewCard: (workspaceId, threadId, card) => set((s) => {
    const key = timelineKey(workspaceId, threadId);
    const prev = s.roomPreviewCards[key];
    if (!prev || prev.seq <= card.seq) s.roomPreviewCards[key] = card;
  }),
  setRoomStatus: (status) => set((s) => { s.roomStatus = status; }),
  setRoomThreads: (workspaceId, threads) => set((s) => { s.roomThreads[workspaceId] = threads; }),
  setRoomPage: (workspaceId, thread, page, mode, startedAt) => set((s) => {
    const key = timelineKey(workspaceId, thread);
    const prev = s.roomTimelines[key];
    const pushedSince = (id: string) => startedAt !== undefined && (s.roomPushedAt[`${workspaceId}\u0000${id}`] ?? -1) > startedAt;
    const fresh = prev ? prev.cards.filter((c) => pushedSince(c.id)) : [];
    const incoming = page.cards.filter((c) => !pushedSince(c.id));
    const base = mode === 'append' && prev ? prev.cards : [];
    const cards = mergeCards(mergeCards(base, incoming), fresh);
    // An append never moves the cursor back (a live card may already be past it).
    const nextSinceSeq = mode === 'append' && prev ? Math.max(prev.nextSinceSeq, page.nextSinceSeq) : page.nextSinceSeq;
    s.roomTimelines[key] = { cards, nextSinceSeq, hasMore: page.hasMore, ...(page.loading ? { loading: true } : {}) };
  }),
  applyRoomEvent: ({ workspaceId, card, threadSummary }) => set((s) => {
    s.roomPushCount += 1;
    s.roomPushedAt[`${workspaceId}\u0000${card.id}`] = s.roomPushCount;
    if (s.roomThreads[workspaceId]) s.roomThreads[workspaceId] = upsertThread(s.roomThreads[workspaceId], threadSummary);
    // A preview card changed in place (a question answered) follows.
    const previewKey = timelineKey(workspaceId, card.threadId);
    if (s.roomPreviewCards[previewKey]?.id === card.id) s.roomPreviewCards[previewKey] = card;
    // Only timelines already loaded take the card; an unloaded one reads it
    // when it is first shown.
    for (const thread of [ALL_THREADS, card.threadId] as TimelineThread[]) {
      const key = timelineKey(workspaceId, thread);
      const tl = s.roomTimelines[key];
      if (!tl) continue;
      // The cursor stays where the last read left it: a catch-up read from
      // there returns what a missed push skipped, and cards it repeats merge
      // by id.
      tl.cards = mergeCards(tl.cards, [card]);
    }
  }),
  selectRoomThread: (workspaceId, thread) => set((s) => { s.roomSelectedThread[workspaceId] = thread; }),
  noteRoomRead: (workspaceId, threadId, seq) => {
    const key = timelineKey(workspaceId, threadId);
    if ((get().roomReadThrough[key] ?? -1) >= seq) return false;
    set((s) => { s.roomReadThrough[key] = seq; });
    return true;
  },
  setBotsWorkerPanel: (panel) => set((s) => { s.botsWorkerPanel = panel; }),
  markBotsSeen: (conversationId, at) => {
    if (!Number.isFinite(at) || (get().botsSeenAt[conversationId] ?? -Infinity) >= at) return;
    set((s) => { s.botsSeenAt[conversationId] = at; });
  },
});
