// The Bots page's model, read from the stores the room dock and Fleet
// already keep (botsModel.ts), and the reads that keep it filled.
//
// `useBotsSync` reads, for every room the page shows (each bot's
// workspace), its thread list and its whole-room timeline once, and
// each thread holding an open question in full (from its first card), and
// the room's newest plan thread, so a question or a plan older than any
// newest page still counts. The page reads them while the bots are paused
// too (`paused`: it shows them read-only); the rail, whose badge is clear
// then, does not. Pushes keep them current
// from then on. With `focus` it also catches up when the window comes back;
// the re-read thread summaries settle a question answered while away. The rail mounts it (with
// focus), so the rail badge is live before the page is ever opened.
import { useEffect, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, type StoreState } from '../../stores';
import { selectWorkspaceAttentionClasses, type FleetAttentionClass } from '../../stores/selectors/fleet';
import { selectWorkspaceIdName } from '../../stores/selectors/workspaceProjections';
import { ALL_THREADS, timelineKey, type RoomActorEntry, type RoomStatusView, type RoomTimeline } from '../../stores/slices/roomSlice';
import { CATCH_UP_MAX_PAGES, catchUpRoomTimeline, isTimelineLoaded, loadRoomActors, loadRoomThreads, loadRoomTimeline, readWithRetry, roomsApi } from '../../hooks/useRoomSync';
import { dmThreadId, type RoomCard, type ThreadId, type ThreadSummary } from '../../../shared/room';
import { getFactoryBotPort, type FactoryBotPort, type FactoryBotRow } from '../Room/factoryPorts';
import { useFactoryBots } from '../Room/useFactoryBots';
import { useBotGroups, type BotGroupPort } from '../Room/botGroups';
import type { BotGroup } from '../../../shared/botGroup';
import { buildBots, botsRooms, EMPTY_BOTS, latestThreadOf, roomCardsByWorkspace, type BotsModel, type RemovedBotRef } from './botsModel';
import { selectBotTaskOwners } from '../Sidebar/botTasks';
import { displayWorkspaceName } from '../../utils/fanoutProvenance';

const NO_CLASSES: Record<string, FleetAttentionClass> = {};

/** Bot workers' attention classes (open workspaces only); the same object
 *  while no bot worker exists, so nothing else is computed. */
export function selectBotWorkerClasses(state: StoreState): Record<string, FleetAttentionClass> {
  const ids = Object.keys(selectBotTaskOwners(state));
  if (ids.length === 0) return NO_CLASSES;
  const classes = selectWorkspaceAttentionClasses(state);
  const out: Record<string, FleetAttentionClass> = {};
  for (const id of ids) if (classes[id]) out[id] = classes[id];
  return out;
}

export interface BotsState {
  status: RoomStatusView | null;
  bots: readonly FactoryBotRow[];
  model: BotsModel;
  /** The factory is on (the bots run; off, the page is read-only). */
  on: boolean;
  /** The bot list has been read at least once (before that, an empty list
   *  does not mean there is no bot). */
  listed: boolean;
  /** The owner's group chats. */
  groups: readonly BotGroup[];
}

export function useBots(port?: FactoryBotPort, groupPort?: BotGroupPort): BotsState {
  const status = useStore((s) => s.roomStatus);
  const bots = useFactoryBots(null, port);
  // useFactoryBots hands back its initial empty list until the first read
  // answers (a fresh array, even when empty); a build without a bot runtime
  // never reads, and there is nothing to wait for.
  const initialBots = useRef(bots);
  const listed = bots !== initialBots.current || bots.length > 0 || !(port ?? getFactoryBotPort()).available;
  const timelines = useStore((s) => s.roomTimelines);
  const previews = useStore((s) => s.roomPreviewCards);
  const threads = useStore((s) => s.roomThreads);
  const botTaskOf = useStore(selectBotTaskOwners);
  const workerClass = useStore(useShallow(selectBotWorkerClasses));
  const names = useStore(useShallow(selectWorkspaceIdName));
  const on = !!status?.enabled;
  const { groups } = useBotGroups(groupPort);
  const actors = useStore((s) => s.roomActors);
  const removed = useMemo(() => removedBotRefs(actors), [actors]);
  const model = useMemo(() => {
    if (!status) return EMPTY_BOTS;
    // A worker's task workspace reads without its `wtask: ` prefix.
    const byId = new Map(names.map((w) => [w.id, displayWorkspaceName(w.name, true)]));
    return buildBots({
      bots,
      groups,
      cards: roomCardsByWorkspace(withPreviews(previews, timelines)),
      threads,
      botTaskOf,
      workerClass,
      workspaceName: (id) => byId.get(id) ?? null,
      readOnly: !on,
      removed,
    });
  }, [status, on, bots, groups, timelines, previews, threads, botTaskOf, workerClass, names, removed]);
  return { status, bots, model, on, listed, groups };
}

/** Read one thread from its first card, page by page (CATCH_UP_MAX_PAGES
 *  at most), into its timeline; pushes that land meanwhile are kept. A
 *  refused first page is retried (readWithRetry) while the thread is unread. */
export async function loadWholeThread(workspaceId: string, threadId: ThreadId, signal?: AbortSignal): Promise<void> {
  const api = roomsApi();
  if (!api || !workspaceId) return;
  const key = timelineKey(workspaceId, threadId);
  // A placeholder first: pushes collect in it meanwhile. It is not a read
  // thread (isTimelineLoaded) until the first page answers.
  if (!useStore.getState().roomTimelines[key]) {
    useStore.getState().setRoomPage(workspaceId, threadId, { cards: [], nextSinceSeq: 0, hasMore: false, loading: true }, 'replace');
  }
  await readWithRetry(key, async () => {
    let sinceSeq = 0;
    for (let page = 0; page < CATCH_UP_MAX_PAGES; page += 1) {
      const startedAt = useStore.getState().roomPushCount;
      let r: Awaited<ReturnType<typeof api.read>>;
      try {
        r = await api.read({ workspaceId, threadId, sinceSeq });
      } catch {
        return page > 0;
      }
      if (!r.ok) return page > 0;
      useStore.getState().setRoomPage(workspaceId, threadId, { cards: r.cards, nextSinceSeq: r.nextSinceSeq, hasMore: r.hasMore }, page === 0 ? 'replace' : 'append', startedAt);
      if (!r.hasMore || r.cards.length === 0) return true;
      sinceSeq = r.nextSinceSeq;
    }
    return true;
  }, () => isTimelineLoaded(useStore.getState().roomTimelines[key]), signal);
}

/** The threads to read whole, as timeline keys: per room, each thread
 *  holding an open question, the newest plan thread, and a thread whose
 *  newest card is a proposal not yet closed — those not read yet. Pure. */
export function threadsToRead(
  rooms: readonly string[],
  roomThreads: Readonly<Record<string, readonly ThreadSummary[] | undefined>>,
  roomTimelines: Readonly<Record<string, { loading?: boolean } | undefined>>,
): string[] {
  const out: string[] = [];
  for (const ws of rooms) {
    const list = roomThreads[ws] ?? [];
    const plan = latestThreadOf(list, 'plan:');
    for (const th of list) {
      const proposal = th.lastKind === 'proposal' && th.status !== 'closed';
      if ((th.openQuestions > 0 || th === plan || proposal) && !isTimelineLoaded(roomTimelines[timelineKey(ws, th.threadId)])) out.push(timelineKey(ws, th.threadId));
    }
  }
  return out;
}

/** The conversation threads to read for the list's previews, as timeline
 *  keys: per live bot's 1:1 and per group, the thread holding its newest
 *  card (by the thread summaries) when no card read so far is that card —
 *  a quiet conversation whose last card is older than the room's newest
 *  page. One one-card read each (loadPreviewCard), so the cost is bounded
 *  by the list. Threads read whole anyway (threadsToRead), threads already
 *  read and previews already read are left out. Pure. */
export function previewThreadsToRead(
  bots: readonly FactoryBotRow[],
  groups: readonly Pick<BotGroup, 'id' | 'workspaceId' | 'threadId'>[],
  roomThreads: Readonly<Record<string, readonly ThreadSummary[] | undefined>>,
  roomTimelines: Readonly<Record<string, { cards: readonly { seq: number }[]; loading?: boolean } | undefined>>,
  previews: Readonly<Record<string, { seq: number } | undefined>> = {},
): string[] {
  const whole = new Set(threadsToRead([...new Set([...bots.map((r) => r.bot.workspaceId), ...groups.map((g) => g.workspaceId)])], roomThreads, {}));
  // A thread's card is read when its own timeline is, or the room's is
  // holding it (no other timeline holds another thread's cards).
  const seen = new Map<string, Set<number>>();
  const seqsOf = (ws: string): Set<number> => {
    let seqs = seen.get(ws);
    if (!seqs) seen.set(ws, (seqs = new Set((roomTimelines[timelineKey(ws, ALL_THREADS)]?.cards ?? []).map((c) => c.seq))));
    return seqs;
  };
  const out = new Set<string>();
  const pick = (ws: string, mine: (th: ThreadSummary) => boolean) => {
    let newest: ThreadSummary | null = null;
    for (const th of roomThreads[ws] ?? []) if (mine(th) && th.cardCount > 0 && (!newest || th.lastSeq > newest.lastSeq)) newest = th;
    if (!newest || seqsOf(ws).has(newest.lastSeq)) return;
    const key = timelineKey(ws, newest.threadId);
    if (!whole.has(key) && !isTimelineLoaded(roomTimelines[key]) && (previews[key]?.seq ?? -1) < newest.lastSeq) out.add(key);
  };
  for (const r of bots) {
    const dm = dmThreadId(r.bot.id);
    pick(r.bot.workspaceId, (th) => th.threadId === dm || th.dmBotId === r.bot.id);
  }
  for (const g of groups) pick(g.workspaceId, (th) => th.threadId === g.threadId || th.groupId === g.id);
  return [...out];
}

/** The deleted bots the room's actors remember, with their workspace. Pure. */
export function removedBotRefs(actors: Readonly<Record<string, RoomActorEntry>>): RemovedBotRef[] {
  return Object.entries(actors).flatMap(([id, a]) => (a.removed && a.workspaceId
    ? [{ id, workspaceId: a.workspaceId, name: a.name, role: a.role, ...(a.avatar ? { avatar: a.avatar } : {}), ...(a.hue !== undefined ? { hue: a.hue } : {}) }]
    : []));
}

/** Keep the page's rooms read (see the file header). */
export function useBotsSync(state: Pick<BotsState, 'status' | 'bots' | 'on'> & { groups?: readonly BotGroup[] }, opts: { focus: boolean; paused?: boolean }): void {
  const known = !!state.status && (state.on || !!opts.paused);
  // A deleted bot's room too, so its 1:1 can still be read.
  const actors = useStore((s) => s.roomActors);
  const removedRooms = useMemo(() => [...new Set(removedBotRefs(actors).map((r) => r.workspaceId))].sort().join('\u0000'), [actors]);
  const rooms = useMemo(
    () => (known ? [...new Set([...botsRooms(state.bots), ...(removedRooms ? removedRooms.split('\u0000') : [])])] : []),
    [known, state.bots, removedRooms],
  );
  const roomsKey = rooms.join('\u0000');
  // Rooms that start after the page read them (a cold start) are read again.
  const running = !!state.status?.running;
  // The actors name the deleted bots, whose rooms join the list above: read
  // them even while no live bot gives a room.
  useEffect(() => {
    if (known) void loadRoomActors();
  }, [known]);
  useEffect(() => {
    const list = roomsKey ? roomsKey.split('\u0000') : [];
    if (list.length === 0) return;
    const st = useStore.getState();
    const reads = new AbortController();
    void loadRoomActors();
    for (const ws of list) {
      if (!st.roomThreads[ws]) void loadRoomThreads(ws, reads.signal);
      if (!isTimelineLoaded(st.roomTimelines[timelineKey(ws, ALL_THREADS)])) void loadRoomTimeline(ws, ALL_THREADS, reads.signal);
    }
    if (!opts.focus) return () => reads.abort();
    const onFocus = () => {
      void loadRoomActors();
      for (const ws of list) {
        void loadRoomThreads(ws);
        void catchUpRoomTimeline(ws, ALL_THREADS);
        // The newest plan is read again whole: an answer given while away
        // (its push missed) must not leave it counted as open.
        const plan = latestThreadOf(useStore.getState().roomThreads[ws] ?? [], 'plan:');
        if (plan) void loadWholeThread(ws, plan.threadId);
      }
    };
    window.addEventListener('focus', onFocus);
    return () => {
      reads.abort();
      window.removeEventListener('focus', onFocus);
    };
  }, [roomsKey, opts.focus, running]);

  // A thread holding an open question, the room's newest plan thread, and a
  // thread whose newest card is a proposal still open there: read them too,
  // so the question, plan or proposal is counted even when it is older than
  // the room's newest page.
  const questionThreads = useStore(useShallow((s) => threadsToRead(rooms, s.roomThreads, s.roomTimelines)));
  useEffect(() => {
    const reads = new AbortController();
    for (const key of questionThreads) {
      const cut = key.indexOf('\u0000');
      void loadWholeThread(key.slice(0, cut), key.slice(cut + 1) as ThreadId, reads.signal);
    }
    return () => reads.abort();
  }, [questionThreads, running]);

  // A quiet conversation's newest card, older than the room's newest page:
  // its thread's newest page, so the list's preview is not "No messages yet".
  const groups = known ? state.groups ?? NO_GROUPS : NO_GROUPS;
  const liveBots = known ? state.bots : NO_ROWS;
  const previewThreads = useStore(useShallow((s) => previewThreadsToRead(liveBots, groups, s.roomThreads, s.roomTimelines, s.roomPreviewCards)));
  useEffect(() => {
    for (const key of previewThreads) {
      const cut = key.indexOf('\u0000');
      void loadPreviewCard(key.slice(0, cut), key.slice(cut + 1) as ThreadId);
    }
  }, [previewThreads, running]);
}

/** Preview reads in flight (timeline keys): the rail and the page ask once. */
const previewReads = new Set<string>();

/** Read a thread's newest card alone into roomPreviewCards. Its timeline
 *  is left as it was (unread), so a later whole read still runs. A refused
 *  read is asked again when the list next needs it (the room starting). */
export async function loadPreviewCard(workspaceId: string, threadId: ThreadId): Promise<void> {
  const api = roomsApi();
  const key = timelineKey(workspaceId, threadId);
  if (!api || !workspaceId || previewReads.has(key)) return;
  previewReads.add(key);
  try {
    const r = await api.read({ workspaceId, threadId, limit: 1 });
    const card = r.ok ? r.cards[r.cards.length - 1] : undefined;
    if (card) useStore.getState().setRoomPreviewCard(workspaceId, threadId, card);
  } catch {
    // asked again on the next change
  } finally {
    previewReads.delete(key);
  }
}

/** The preview cards as one-card timelines placed before the real ones, so
 *  roomCardsByWorkspace keeps a timeline's copy of the same card. Pure. */
export function withPreviews(
  previews: Readonly<Record<string, RoomCard>>,
  timelines: Readonly<Record<string, RoomTimeline>>,
): Readonly<Record<string, RoomTimeline>> {
  const keys = Object.keys(previews);
  if (keys.length === 0) return timelines;
  const out: Record<string, RoomTimeline> = {};
  for (const key of keys) out[`${key}\u0000preview`] = { cards: [previews[key]], nextSinceSeq: previews[key].seq, hasMore: false };
  return Object.assign(out, timelines);
}

const NO_GROUPS: readonly BotGroup[] = [];
const NO_ROWS: readonly FactoryBotRow[] = [];
