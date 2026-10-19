import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '../../stores';
import type { RoomCard, RoomReadParams, ThreadId } from '../../../shared/room';
import { ALL_THREADS, timelineKey } from '../../stores/slices/roomSlice';
import {
  catchUpRoomTimeline,
  FIRST_READ_RETRY_MS,
  isTimelineLoaded,
  loadRoomTimeline,
  markRoomThreadRead,
  refreshRoomStatus,
  setRoomsApiForTests,
  type RoomsApi,
} from '../useRoomSync';

const WS = 'ws-a';
const PAGE = 100;

function card(seq: number, threadId: ThreadId = 'general'): RoomCard {
  return { version: 1, id: `c${seq}`, seq, workspaceId: WS, threadId, kind: 'status', at: seq, actor: { kind: 'system' }, title: `card ${seq}` };
}

/** A room of `count` cards behind a fake bridge that pages like RoomWriter.read. */
function fakeRoom(count: number) {
  const cards = Array.from({ length: count }, (_, i) => card(i + 1));
  const reads: (RoomReadParams & { workspaceId: string })[] = [];
  const api = {
    status: vi.fn(async () => ({ running: true, enabled: true, hqWorkspaceId: null })),
    threads: vi.fn(async () => ({ ok: true as const, workspaceId: WS, threads: [] })),
    read: vi.fn(async (p: RoomReadParams & { workspaceId: string }) => {
      reads.push(p);
      const scoped = p.threadId ? cards.filter((c) => c.threadId === p.threadId) : cards;
      const limit = Math.min(PAGE, p.limit ?? PAGE);
      if (p.sinceSeq === undefined) {
        const page = scoped.slice(-limit);
        return { ok: true as const, workspaceId: WS, threadId: p.threadId ?? null, cards: page, nextSinceSeq: page[page.length - 1]?.seq ?? 0, hasMore: false };
      }
      const after = scoped.filter((c) => c.seq > p.sinceSeq!);
      const page = after.slice(0, limit);
      return { ok: true as const, workspaceId: WS, threadId: p.threadId ?? null, cards: page, nextSinceSeq: page[page.length - 1]?.seq ?? p.sinceSeq, hasMore: after.length > limit };
    }),
    post: vi.fn(),
    resolve: vi.fn(),
    decision: vi.fn(),
    onEvent: vi.fn(() => () => undefined),
  };
  return { api: api as unknown as RoomsApi, raw: api, cards, reads };
}

beforeEach(() => {
  useStore.setState({ roomStatus: null, roomThreads: {}, roomTimelines: {}, roomSelectedThread: {}, roomReadThrough: {}, roomPushCount: 0, roomPushedAt: {} });
});
afterEach(() => setRoomsApiForTests(undefined));

describe('room paging by seq', () => {
  it('a first read is the newest page; a catch-up follows nextSinceSeq while hasMore, with no card twice or missing', async () => {
    const room = fakeRoom(30);
    setRoomsApiForTests(room.api);
    // An earlier session saw the first five cards only.
    useStore.getState().setRoomPage(WS, ALL_THREADS, { cards: room.cards.slice(0, 5), nextSinceSeq: 5, hasMore: false }, 'replace');
    room.cards.push(...Array.from({ length: 245 }, (_, i) => card(31 + i)));
    await catchUpRoomTimeline(WS, ALL_THREADS);
    const tl = useStore.getState().roomTimelines[timelineKey(WS, ALL_THREADS)];
    expect(tl.cards.map((c) => c.seq)).toEqual(Array.from({ length: 275 }, (_, i) => i + 1));
    expect(tl.hasMore).toBe(false);
    expect(tl.nextSinceSeq).toBe(275);
    // Three pages after the cursor, then the newest page again.
    expect(room.reads.map((r) => r.sinceSeq)).toEqual([5, 105, 205, undefined]);
  });

  it('a catch-up shows a card changed in place behind the cursor (an answered question)', async () => {
    const room = fakeRoom(3);
    setRoomsApiForTests(room.api);
    useStore.getState().setRoomPage(WS, ALL_THREADS, { cards: [...room.cards, ], nextSinceSeq: 3, hasMore: false }, 'replace');
    room.cards[1] = { ...room.cards[1], kind: 'question', state: 'resolved' };
    await catchUpRoomTimeline(WS, ALL_THREADS);
    const tl = useStore.getState().roomTimelines[timelineKey(WS, ALL_THREADS)];
    expect(tl.cards[1].state).toBe('resolved');
    expect(tl.cards).toHaveLength(3);
  });

  it('a page read in flight never undoes a push that landed meanwhile, nor drops it on replace', async () => {
    const room = fakeRoom(2);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const read = room.raw.read;
    room.raw.read = vi.fn(async (p) => { const out = await read(p); await gate; return out; }) as typeof read;
    setRoomsApiForTests(room.api);
    const pending = loadRoomTimeline(WS, ALL_THREADS);
    useStore.getState().applyRoomEvent({ workspaceId: WS, card: { ...room.cards[0], state: 'resolved' }, threadSummary: { threadId: 'general', title: 'g', lastAt: 0, lastSeq: 3, cardCount: 3, openQuestions: 0, lastKind: 'status', status: 'open', unread: null } });
    useStore.getState().applyRoomEvent({ workspaceId: WS, card: card(3), threadSummary: { threadId: 'general', title: 'g', lastAt: 0, lastSeq: 3, cardCount: 3, openQuestions: 0, lastKind: 'status', status: 'open', unread: null } });
    release();
    await pending;
    const tl = useStore.getState().roomTimelines[timelineKey(WS, ALL_THREADS)];
    expect(tl.cards.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(tl.cards[0].state).toBe('resolved');
  });

  it('a catch-up of a timeline never read makes its first read instead', async () => {
    const room = fakeRoom(150);
    setRoomsApiForTests(room.api);
    await catchUpRoomTimeline(WS, ALL_THREADS);
    const tl = useStore.getState().roomTimelines[timelineKey(WS, ALL_THREADS)];
    expect(room.reads).toEqual([{ workspaceId: WS }]);
    expect(tl.cards[0].seq).toBe(51);
    expect(tl.cards).toHaveLength(100);
  });

  it('a thread timeline reads that thread only', async () => {
    const room = fakeRoom(3);
    room.cards.push(card(4, 'task:t'));
    setRoomsApiForTests(room.api);
    await loadRoomTimeline(WS, 'task:t');
    expect(useStore.getState().roomTimelines[timelineKey(WS, 'task:t')].cards.map((c) => c.seq)).toEqual([4]);
    expect(room.reads[0]).toEqual({ workspaceId: WS, threadId: 'task:t' });
  });
});

describe('read position', () => {
  it('a refused mark is not remembered, so it is sent again', async () => {
    const room = fakeRoom(3);
    setRoomsApiForTests(room.api);
    room.raw.read.mockResolvedValueOnce({ ok: false, code: 'not_started', message: 'x' } as never);
    await markRoomThreadRead(WS, 'general', 3);
    await markRoomThreadRead(WS, 'general', 3);
    expect(room.raw.read.mock.calls.filter(([p]) => p.markThroughSeq === 3)).toHaveLength(2);
    expect(useStore.getState().roomReadThrough[timelineKey(WS, 'general')]).toBe(3);
  });

  it('sends markThroughSeq forward only and re-reads the thread list', async () => {
    const room = fakeRoom(3);
    setRoomsApiForTests(room.api);
    await markRoomThreadRead(WS, 'general', 3);
    await markRoomThreadRead(WS, 'general', 2);
    await markRoomThreadRead(WS, 'general', 0);
    expect(room.reads).toEqual([{ workspaceId: WS, threadId: 'general', markThroughSeq: 3, sinceSeq: 3, limit: 1 }]);
    expect(room.raw.threads).toHaveBeenCalledTimes(1);
  });
});

describe('status', () => {
  it('keeps the factory state; a refusal or no bridge reads as unknown (null)', async () => {
    const room = fakeRoom(0);
    setRoomsApiForTests(room.api);
    await refreshRoomStatus();
    expect(useStore.getState().roomStatus).toEqual({ running: true, enabled: true, hqWorkspaceId: null });
    room.raw.status.mockResolvedValueOnce({ ok: false, code: 'operator_only', message: 'no' } as never);
    await refreshRoomStatus();
    expect(useStore.getState().roomStatus).toBeNull();
    setRoomsApiForTests(null);
    useStore.getState().setRoomStatus({ running: true, enabled: true, hqWorkspaceId: null });
    await refreshRoomStatus();
    expect(useStore.getState().roomStatus).toBeNull();
  });
});

describe('a refused first read (cold start: rooms not started yet)', () => {
  const NOT_STARTED = { ok: false as const, code: 'not_started', message: 'rooms are not running yet' };
  const key = timelineKey(WS, ALL_THREADS);
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('is read again and shows the cards, with no focus event', async () => {
    const room = fakeRoom(19);
    room.raw.read.mockResolvedValueOnce(NOT_STARTED as never);
    setRoomsApiForTests(room.api);
    const done = loadRoomTimeline(WS, ALL_THREADS);
    await vi.advanceTimersByTimeAsync(0);
    expect(useStore.getState().roomTimelines[key].loading).toBe(true);
    await vi.advanceTimersByTimeAsync(FIRST_READ_RETRY_MS[0]);
    await done;
    const tl = useStore.getState().roomTimelines[key];
    expect(isTimelineLoaded(tl)).toBe(true);
    expect(tl.cards).toHaveLength(19);
    expect(room.raw.read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a first read that answers is read once and leaves no timer', async () => {
    const room = fakeRoom(3);
    setRoomsApiForTests(room.api);
    await loadRoomTimeline(WS, ALL_THREADS);
    expect(room.raw.read).toHaveBeenCalledTimes(1);
    expect(useStore.getState().roomTimelines[key].cards).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops after the bounded retries, still unread so a later trigger reads it', async () => {
    const room = fakeRoom(3);
    room.raw.read.mockResolvedValue(NOT_STARTED as never);
    setRoomsApiForTests(room.api);
    const done = loadRoomTimeline(WS, ALL_THREADS);
    await vi.advanceTimersByTimeAsync(FIRST_READ_RETRY_MS.reduce((a, b) => a + b, 0) * 2);
    await done;
    expect(room.raw.read).toHaveBeenCalledTimes(1 + FIRST_READ_RETRY_MS.length);
    expect(vi.getTimerCount()).toBe(0);
    expect(isTimelineLoaded(useStore.getState().roomTimelines[key])).toBe(false);
  });

  it('one loop per timeline: a second call joins it and tries again now; it ends once every caller aborted', async () => {
    const room = fakeRoom(3);
    room.raw.read.mockResolvedValue(NOT_STARTED as never);
    setRoomsApiForTests(room.api);
    const rail = new AbortController();
    const page = new AbortController();
    const done = loadRoomTimeline(WS, ALL_THREADS, rail.signal);
    await vi.advanceTimersByTimeAsync(0);
    await loadRoomTimeline(WS, ALL_THREADS, page.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(room.raw.read).toHaveBeenCalledTimes(2);
    // The page closes; the rail still wants the room.
    page.abort();
    await vi.advanceTimersByTimeAsync(FIRST_READ_RETRY_MS[1]);
    expect(room.raw.read).toHaveBeenCalledTimes(3);
    rail.abort();
    await done;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.raw.read).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a catch-up of a placeholder makes the first read try again now', async () => {
    const room = fakeRoom(4);
    room.raw.read.mockResolvedValueOnce(NOT_STARTED as never);
    setRoomsApiForTests(room.api);
    const done = loadRoomTimeline(WS, ALL_THREADS);
    await vi.advanceTimersByTimeAsync(0);
    await catchUpRoomTimeline(WS, ALL_THREADS);
    await done;
    expect(useStore.getState().roomTimelines[key].cards).toHaveLength(4);
    expect(room.raw.read).toHaveBeenCalledTimes(2);
  });
});
