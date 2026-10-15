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

export async function loadRoomThreads(workspaceId: string): Promise<void> {
  const api = roomsApi();
  if (!api || !workspaceId) return;
  try {
    const r = await api.threads(workspaceId);
    if (r.ok) useStore.getState().setRoomThreads(workspaceId, r.threads);
  } catch {
    // leave the last list
  }
}

function threadParam(thread: TimelineThread): { threadId?: ThreadId } {
  return thread === ALL_THREADS ? {} : { threadId: thread };
}

/** First read of a timeline: the newest page. Until it answers, the
 *  timeline is a placeholder that collects pushes, so none is lost. */
export async function loadRoomTimeline(workspaceId: string, thread: TimelineThread): Promise<void> {
  const api = roomsApi();
  if (!api || !workspaceId) return;
  const st = useStore.getState();
  if (!st.roomTimelines[timelineKey(workspaceId, thread)]) {
    st.setRoomPage(workspaceId, thread, { cards: [], nextSinceSeq: 0, hasMore: false, loading: true }, 'replace');
  }
  const startedAt = useStore.getState().roomPushCount;
  try {
    const r = await api.read({ workspaceId, ...threadParam(thread) });
    if (r.ok) useStore.getState().setRoomPage(workspaceId, thread, { cards: r.cards, nextSinceSeq: r.nextSinceSeq, hasMore: r.hasMore }, 'replace', startedAt);
  } catch {
    // leave what is shown
  }
}

/** Read every card after the timeline's cursor, page by page. A timeline
 *  never read gets its first read instead. */
export async function catchUpRoomTimeline(workspaceId: string, thread: TimelineThread): Promise<void> {
  const api = roomsApi();
  if (!api || !workspaceId) return;
  const key = timelineKey(workspaceId, thread);
  const existing = useStore.getState().roomTimelines[key];
  if (!existing || existing.loading) return loadRoomTimeline(workspaceId, thread);
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
