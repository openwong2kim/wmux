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
import { ALL_THREADS, timelineKey, type RoomActorEntry, type RoomStatusView } from '../../stores/slices/roomSlice';
import { CATCH_UP_MAX_PAGES, catchUpRoomTimeline, loadRoomActors, loadRoomThreads, loadRoomTimeline, roomsApi } from '../../hooks/useRoomSync';
import type { ThreadId, ThreadSummary } from '../../../shared/room';
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
      cards: roomCardsByWorkspace(timelines),
      threads,
      botTaskOf,
      workerClass,
      workspaceName: (id) => byId.get(id) ?? null,
      readOnly: !on,
      removed,
    });
  }, [status, on, bots, groups, timelines, threads, botTaskOf, workerClass, names, removed]);
  return { status, bots, model, on, listed, groups };
}

/** Read one thread from its first card, page by page (CATCH_UP_MAX_PAGES
 *  at most), into its timeline; pushes that land meanwhile are kept. */
export async function loadWholeThread(workspaceId: string, threadId: ThreadId): Promise<void> {
  const api = roomsApi();
  if (!api || !workspaceId) return;
  // A placeholder first: the thread counts as read (no second load starts)
  // and pushes collect in it meanwhile.
  if (!useStore.getState().roomTimelines[timelineKey(workspaceId, threadId)]) {
    useStore.getState().setRoomPage(workspaceId, threadId, { cards: [], nextSinceSeq: 0, hasMore: false, loading: true }, 'replace');
  }
  let sinceSeq = 0;
  for (let page = 0; page < CATCH_UP_MAX_PAGES; page += 1) {
    const startedAt = useStore.getState().roomPushCount;
    let r: Awaited<ReturnType<typeof api.read>>;
    try {
      r = await api.read({ workspaceId, threadId, sinceSeq });
    } catch {
      return;
    }
    if (!r.ok) return;
    useStore.getState().setRoomPage(workspaceId, threadId, { cards: r.cards, nextSinceSeq: r.nextSinceSeq, hasMore: r.hasMore }, page === 0 ? 'replace' : 'append', startedAt);
    if (!r.hasMore || r.cards.length === 0) return;
    sinceSeq = r.nextSinceSeq;
  }
}

/** The threads to read whole, as timeline keys: per room, each thread
 *  holding an open question, the newest plan thread, and a thread whose
 *  newest card is a proposal not yet closed — those not read yet. Pure. */
export function threadsToRead(
  rooms: readonly string[],
  roomThreads: Readonly<Record<string, readonly ThreadSummary[] | undefined>>,
  roomTimelines: Readonly<Record<string, unknown>>,
): string[] {
  const out: string[] = [];
  for (const ws of rooms) {
    const list = roomThreads[ws] ?? [];
    const plan = latestThreadOf(list, 'plan:');
    for (const th of list) {
      const proposal = th.lastKind === 'proposal' && th.status !== 'closed';
      if ((th.openQuestions > 0 || th === plan || proposal) && !roomTimelines[timelineKey(ws, th.threadId)]) out.push(timelineKey(ws, th.threadId));
    }
  }
  return out;
}

/** The deleted bots the room's actors remember, with their workspace. Pure. */
export function removedBotRefs(actors: Readonly<Record<string, RoomActorEntry>>): RemovedBotRef[] {
  return Object.entries(actors).flatMap(([id, a]) => (a.removed && a.workspaceId
    ? [{ id, workspaceId: a.workspaceId, name: a.name, role: a.role, ...(a.avatar ? { avatar: a.avatar } : {}), ...(a.hue !== undefined ? { hue: a.hue } : {}) }]
    : []));
}

/** Keep the page's rooms read (see the file header). */
export function useBotsSync(state: Pick<BotsState, 'status' | 'bots' | 'on'>, opts: { focus: boolean; paused?: boolean }): void {
  const known = !!state.status && (state.on || !!opts.paused);
  // A deleted bot's room too, so its 1:1 can still be read.
  const actors = useStore((s) => s.roomActors);
  const removedRooms = useMemo(() => [...new Set(removedBotRefs(actors).map((r) => r.workspaceId))].sort().join('\u0000'), [actors]);
  const rooms = useMemo(
    () => (known ? [...new Set([...botsRooms(state.bots), ...(removedRooms ? removedRooms.split('\u0000') : [])])] : []),
    [known, state.bots, removedRooms],
  );
  const roomsKey = rooms.join('\u0000');
  // The actors name the deleted bots, whose rooms join the list above: read
  // them even while no live bot gives a room.
  useEffect(() => {
    if (known) void loadRoomActors();
  }, [known]);
  useEffect(() => {
    const list = roomsKey ? roomsKey.split('\u0000') : [];
    if (list.length === 0) return;
    const st = useStore.getState();
    void loadRoomActors();
    for (const ws of list) {
      if (!st.roomThreads[ws]) void loadRoomThreads(ws);
      if (!st.roomTimelines[timelineKey(ws, ALL_THREADS)]) void loadRoomTimeline(ws, ALL_THREADS);
    }
    if (!opts.focus) return;
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
    return () => window.removeEventListener('focus', onFocus);
  }, [roomsKey, opts.focus]);

  // A thread holding an open question, the room's newest plan thread, and a
  // thread whose newest card is a proposal still open there: read them too,
  // so the question, plan or proposal is counted even when it is older than
  // the room's newest page.
  const questionThreads = useStore(useShallow((s) => threadsToRead(rooms, s.roomThreads, s.roomTimelines)));
  useEffect(() => {
    for (const key of questionThreads) {
      const cut = key.indexOf('\u0000');
      void loadWholeThread(key.slice(0, cut), key.slice(cut + 1) as ThreadId);
    }
  }, [questionThreads]);
}
