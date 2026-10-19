// Rooms — keeps the room slice in step with main.
//
// `useRoomSync` (mounted once, in AppLayout) asks whether rooms run and the
// factory is on, again whenever the window regains focus, and applies every
// ROOM_EVENT push to the slice. The loaders below read pages by seq: a
// timeline's first read is the newest page; a catch-up read continues from
// its cursor (`nextSinceSeq`) page by page while `hasMore`, so a push missed
// while the window was away is filled in, then re-reads the newest page,
// whose cards may have changed in place (a question answered keeps its
// seq). A page never undoes a push that landed while it was read. Read
// positions go to main as `markThroughSeq`, forward only, and count once
// main took them.
import { useEffect } from 'react';
import { useStore } from '../stores';
import type { ElectronAPI } from '../../preload/preload';
import type { ThreadId } from '../../shared/room';
import { ALL_THREADS, timelineKey, type TimelineThread } from '../stores/slices/roomSlice';
import { noteRemovedBotHues } from '../components/Room/BotAvatar';

export type RoomsApi = ElectronAPI['rooms'];

let apiOverride: RoomsApi | null | undefined;

/** The preload's rooms bridge, or null outside the app window. */
export function roomsApi(): RoomsApi | null {
  if (apiOverride !== undefined) return apiOverride;
  return (globalThis as { electronAPI?: Partial<ElectronAPI> }).electronAPI?.rooms ?? null;
}

/** Tests: replace the bridge (undefined restores the preload's). */
export function setRoomsApiForTests(api: RoomsApi | null | undefined): void {
  apiOverride = api;
}

/** Catch-up stops after this many pages (ROOM_LIMITS.PAGE cards each). */
export const CATCH_UP_MAX_PAGES = 50;

export async function refreshRoomStatus(): Promise<void> {
  const api = roomsApi();
  const st = useStore.getState();
  if (!api) {
    st.setRoomStatus(null);
    return;
  }
  try {
    const r = await api.status();
    useStore.getState().setRoomStatus('ok' in r ? null : { running: r.running, enabled: r.enabled, hqWorkspaceId: r.hqWorkspaceId });
  } catch {
    // main gone: keep the last answer
  }
}

/** The bot authors main knows (role and name). */
export async function loadRoomActors(): Promise<void> {
  const api = roomsApi();
  if (!api?.actors) return;
  try {
    const r = await api.actors();
    if ('actors' in r) {
      noteRemovedBotHues(Object.entries(r.actors).flatMap(([id, a]) => (a.removed && a.hue !== undefined ? [[id, a.hue] as [string, number]] : [])));
      useStore.getState().setRoomActors(r.actors);
    }
  } catch {
    // keep the last answer
  }
}

/** A first read main refuses is tried again after each of these delays
 *  (about 95 s in all), then left for the next trigger. On a cold start the
 *  renderer loads in parallel with the daemon bootstrap, and main starts the
 *  rooms only after it; until then every read answers `not_started`. */
export const FIRST_READ_RETRY_MS: readonly number[] = [500, 1000, 2000, 4000, 8000, 16000, 16000, 16000, 16000, 16000];

interface RetryLoop {
  /** Ends the current wait, so the next try runs now. */
  wake: () => void;
  /** The callers' signals: no further try starts once all have aborted. */
  signals: Set<AbortSignal>;
  /** A caller passed no signal: only the retry bound ends the loop. */
  unbound: boolean;
  /** A refresh was asked for while a read was in flight: read once more. */
  again: boolean;
}

/** The retry loop running per read key. */
const firstReads = new Map<string, RetryLoop>();

/** A loaded timeline: its first read answered (a placeholder has not). */
export function isTimelineLoaded(tl: { loading?: boolean } | undefined): boolean {
  return !!tl && !tl.loading;
}

const live = (loop: RetryLoop): boolean => loop.unbound || [...loop.signals].some((s) => !s.aborted);

function join(loop: RetryLoop, signal: AbortSignal | undefined): void {
  if (!signal) {
    loop.unbound = true;
    return;
  }
  loop.signals.add(signal);
  signal.addEventListener('abort', () => {
    if (!live(loop)) loop.wake();
  }, { once: true });
}

/** Run `attempt` (true when main answered), and while it fails and `done`
 *  is false, again after each FIRST_READ_RETRY_MS delay. One loop per key:
 *  a call while one runs joins it and makes it try again now (or, when
 *  `done` already holds, read once more after the read in flight). The
 *  loop stops once every caller's signal has aborted. */
export async function readWithRetry(key: string, attempt: () => Promise<boolean>, done: () => boolean, signal?: AbortSignal): Promise<void> {
  const current = firstReads.get(key);
  if (current) {
    join(current, signal);
    if (done()) current.again = true;
    current.wake();
    return;
  }
  const loop: RetryLoop = { wake: () => undefined, signals: new Set(), unbound: false, again: false };
  join(loop, signal);
  firstReads.set(key, loop);
  try {
    for (let i = 0; ; ) {
      const ok = await attempt();
      if (loop.again && live(loop)) {
        loop.again = false;
        continue;
      }
      if (ok || i >= FIRST_READ_RETRY_MS.length || !live(loop) || done()) return;
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, FIRST_READ_RETRY_MS[i]);
        loop.wake = finish;
      });
      loop.wake = () => undefined;
      i += 1;
      if (!live(loop) || done()) return;
    }
  } finally {
    if (firstReads.get(key) === loop) firstReads.delete(key);
  }
}

export async function loadRoomThreads(workspaceId: string, signal?: AbortSignal): Promise<void> {
  const api = roomsApi();
  if (!api || !workspaceId) return;
  await readWithRetry(`threads\u0001${workspaceId}`, async () => {
    try {
      const r = await api.threads(workspaceId);
      if (!r.ok) return false;
      useStore.getState().setRoomThreads(workspaceId, r.threads);
      return true;
    } catch {
      // leave the last list
      return false;
    }
  }, () => !!useStore.getState().roomThreads[workspaceId], signal);
}

function threadParam(thread: TimelineThread): { threadId?: ThreadId } {
  return thread === ALL_THREADS ? {} : { threadId: thread };
}

/** First read of a timeline: the newest page. Until it answers, the
 *  timeline is a placeholder that collects pushes, so none is lost; a
 *  refused read is retried (readWithRetry) while it is still one. */
export async function loadRoomTimeline(workspaceId: string, thread: TimelineThread, signal?: AbortSignal): Promise<void> {
  const api = roomsApi();
  if (!api || !workspaceId) return;
  const key = timelineKey(workspaceId, thread);
  const st = useStore.getState();
  if (!st.roomTimelines[key]) {
    st.setRoomPage(workspaceId, thread, { cards: [], nextSinceSeq: 0, hasMore: false, loading: true }, 'replace');
  }
  await readWithRetry(key, async () => {
    const startedAt = useStore.getState().roomPushCount;
    try {
      const r = await api.read({ workspaceId, ...threadParam(thread) });
      if (!r.ok) return false;
      useStore.getState().setRoomPage(workspaceId, thread, { cards: r.cards, nextSinceSeq: r.nextSinceSeq, hasMore: r.hasMore }, 'replace', startedAt);
      return true;
    } catch {
      // leave what is shown
      return false;
    }
  }, () => isTimelineLoaded(useStore.getState().roomTimelines[key]), signal);
}

/** Read every card after the timeline's cursor, page by page. A timeline
 *  never read gets its first read instead. */
export async function catchUpRoomTimeline(workspaceId: string, thread: TimelineThread): Promise<void> {
  const api = roomsApi();
  if (!api || !workspaceId) return;
  const key = timelineKey(workspaceId, thread);
  const existing = useStore.getState().roomTimelines[key];
  if (!isTimelineLoaded(existing)) return loadRoomTimeline(workspaceId, thread);
  for (let page = 0; page < CATCH_UP_MAX_PAGES; page += 1) {
    const tl = useStore.getState().roomTimelines[key];
    if (!tl) return;
    const startedAt = useStore.getState().roomPushCount;
    let r: Awaited<ReturnType<RoomsApi['read']>>;
    try {
      r = await api.read({ workspaceId, ...threadParam(thread), sinceSeq: tl.nextSinceSeq });
    } catch {
      return;
    }
    if (!r.ok) return;
    useStore.getState().setRoomPage(workspaceId, thread, { cards: r.cards, nextSinceSeq: r.nextSinceSeq, hasMore: r.hasMore }, 'append', startedAt);
    if (!r.hasMore || r.cards.length === 0) break;
  }
  await refreshNewestPage(workspaceId, thread);
}

/** Re-read the newest page and merge it, so cards changed in place since
 *  they were read (same id and seq) show their current state. */
async function refreshNewestPage(workspaceId: string, thread: TimelineThread): Promise<void> {
  const api = roomsApi();
  if (!api) return;
  const startedAt = useStore.getState().roomPushCount;
  try {
    const r = await api.read({ workspaceId, ...threadParam(thread) });
    const tl = useStore.getState().roomTimelines[timelineKey(workspaceId, thread)];
    if (!r.ok || !tl) return;
    // Merged as a page after the cursor; the cursor and hasMore stay.
    useStore.getState().setRoomPage(workspaceId, thread, { cards: r.cards, nextSinceSeq: tl.nextSinceSeq, hasMore: tl.hasMore }, 'append', startedAt);
  } catch {
    // leave what is shown
  }
}

/** Tell main the owner has read a thread through `seq` (forward only), then
 *  re-read the thread list for its new unread count. */
export async function markRoomThreadRead(workspaceId: string, threadId: ThreadId, seq: number): Promise<void> {
  const api = roomsApi();
  if (!api || !workspaceId || !Number.isInteger(seq) || seq < 1) return;
  if ((useStore.getState().roomReadThrough[timelineKey(workspaceId, threadId)] ?? -1) >= seq) return;
  try {
    const r = await api.read({ workspaceId, threadId, markThroughSeq: seq, sinceSeq: seq, limit: 1 });
    if (!r.ok) return;
  } catch {
    return;
  }
  // Recorded only once main took it, so a failed call is retried.
  useStore.getState().noteRoomRead(workspaceId, threadId, seq);
  await loadRoomThreads(workspaceId);
}

/** Status on mount and on focus; every push into the slice. */
export function useRoomSync(): void {
  useEffect(() => {
    const api = roomsApi();
    if (!api) return;
    void refreshRoomStatus();
    const off = api.onEvent((payload) => useStore.getState().applyRoomEvent(payload));
    const onFocus = () => void refreshRoomStatus();
    window.addEventListener('focus', onFocus);
    return () => {
      off();
      window.removeEventListener('focus', onFocus);
    };
  }, []);
}
