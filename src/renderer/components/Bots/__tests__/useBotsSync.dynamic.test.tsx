// @vitest-environment jsdom
// A cold start: the page reads its rooms before main has started them, and
// every read is refused. The conversations must still fill in, with no
// window focus event, and with a bounded number of reads.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import { ALL_THREADS, timelineKey, type RoomStatusView } from '../../../stores/slices/roomSlice';
import { FIRST_READ_RETRY_MS, isTimelineLoaded, setRoomsApiForTests, type RoomsApi } from '../../../hooks/useRoomSync';
import type { FactoryBotRow } from '../../Room/factoryPorts';
import type { RoomCard } from '../../../../shared/room';
import { DEFAULT_BOT_BUDGETS } from '../../../../shared/bot';
import { useBotsSync } from '../useBots';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = 'w1';
const KEY = timelineKey(WS, ALL_THREADS);
const NOT_STARTED = { ok: false as const, code: 'not_started', message: 'rooms are not running yet' };

const row: FactoryBotRow = {
  bot: {
    version: 1, id: 'bot-0000000a', workspaceId: WS, role: 'lead', name: 'Lead', engine: { kind: 'claude-sdk' }, triggers: [],
    budget: DEFAULT_BOT_BUDGETS.lead, enabled: true, createdAt: 1, updatedAt: 1, repo: { repoKey: 'github.com/acme/api', repoPath: '/r/api' },
  },
  status: { botId: 'bot-0000000a', presence: 'idle', queueDepth: 0, budgetLeft: { turnsHour: 5, turnsDay: 30, workerHoursDay: 4 } },
};

const cards: RoomCard[] = Array.from({ length: 19 }, (_, i) => ({
  version: 1, id: `c${i + 1}`, seq: i + 1, workspaceId: WS, threadId: 'dm:bot-0000000a', kind: 'status', at: i + 1,
  actor: { kind: 'bot', workspaceId: WS, botId: 'bot-0000000a' }, title: `card ${i + 1}`,
}));

/** Main before and after its rooms start. */
function fakeMain() {
  const main = { started: false };
  const api = {
    status: vi.fn(async () => ({ running: main.started, enabled: true, hqWorkspaceId: null })),
    threads: vi.fn(async () => (main.started ? { ok: true as const, workspaceId: WS, threads: [] } : NOT_STARTED)),
    read: vi.fn(async () => (main.started
      ? { ok: true as const, workspaceId: WS, threadId: null, cards, nextSinceSeq: 19, hasMore: false }
      : NOT_STARTED)),
    actors: vi.fn(async () => ({ actors: {} })),
    onEvent: vi.fn(() => () => undefined),
  };
  return { main, api };
}

type SyncProps = { status: RoomStatusView; focus: boolean; paused?: boolean };
function Sync({ status, focus, paused }: SyncProps) {
  useBotsSync({ status, bots: [row], on: true }, { focus, paused });
  return null;
}

const status = (running: boolean): RoomStatusView => ({ running, enabled: true, hqWorkspaceId: null });
let container: HTMLDivElement;
let root: Root;
const render = (running: boolean) => act(async () => {
  root.render(<><Sync status={status(running)} focus /><Sync status={status(running)} focus={false} paused /></>);
});
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  useStore.setState({ roomStatus: null, roomThreads: {}, roomTimelines: {}, roomActors: {}, roomPushCount: 0, roomPushedAt: {}, roomPreviewCards: {} } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setRoomsApiForTests(undefined);
  vi.useRealTimers();
});

describe('useBotsSync on a cold start', () => {
  it('a refused first read is read again; the cards show with no focus event', async () => {
    const { main, api } = fakeMain();
    setRoomsApiForTests(api as unknown as RoomsApi);
    await render(false);
    await flush();
    // Both mounts (the rail's and the page's) share one read.
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(isTimelineLoaded(useStore.getState().roomTimelines[KEY])).toBe(false);
    main.started = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_READ_RETRY_MS[0]); });
    const tl = useStore.getState().roomTimelines[KEY];
    expect(isTimelineLoaded(tl)).toBe(true);
    expect(tl.cards).toHaveLength(19);
    expect(useStore.getState().roomThreads[WS]).toEqual([]);
    expect(api.read).toHaveBeenCalledTimes(2);
  });

  it('a room that becomes running is read again at once', async () => {
    const { main, api } = fakeMain();
    setRoomsApiForTests(api as unknown as RoomsApi);
    await render(false);
    await flush();
    expect(api.read).toHaveBeenCalledTimes(1);
    main.started = true;
    await render(true);
    await flush();
    // Well before the first retry delay.
    expect(useStore.getState().roomTimelines[KEY].cards).toHaveLength(19);
    expect(api.read).toHaveBeenCalledTimes(2);
  });

  it('a first read that answers is read once, with no retry left behind', async () => {
    const { main, api } = fakeMain();
    main.started = true;
    setRoomsApiForTests(api as unknown as RoomsApi);
    await render(true);
    await flush();
    expect(api.read).toHaveBeenCalledTimes(1);
    expect(useStore.getState().roomTimelines[KEY].cards).toHaveLength(19);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closing the page keeps the rail retrying', async () => {
    const { main, api } = fakeMain();
    setRoomsApiForTests(api as unknown as RoomsApi);
    await render(false);
    await flush();
    await act(async () => { root.render(<Sync status={status(false)} focus />); });
    main.started = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_READ_RETRY_MS[0]); });
    expect(useStore.getState().roomTimelines[KEY].cards).toHaveLength(19);
  });

  it('unmounting ends the retries: no timer left, no further read', async () => {
    const { api } = fakeMain();
    setRoomsApiForTests(api as unknown as RoomsApi);
    await render(false);
    await flush();
    act(() => root.unmount());
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.read).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });
});

describe('useBotsSync: a quiet conversation\'s preview', () => {
  it('a 1:1 whose newest card is older than the room\'s newest page: that card alone is read, once', async () => {
    const DM = 'dm:bot-0000000a';
    const old: RoomCard = { ...cards[0], id: 'c-old', seq: 3, threadId: DM, title: 'Last word, long ago' };
    const recent: RoomCard[] = cards.map((c) => ({ ...c, id: `g${c.seq}`, seq: c.seq + 100, threadId: 'general' }));
    const api = {
      status: vi.fn(async () => ({ running: true, enabled: true, hqWorkspaceId: null })),
      threads: vi.fn(async () => ({ ok: true as const, workspaceId: WS, threads: [
        { threadId: DM, title: 'x', lastAt: 3, lastSeq: 3, cardCount: 1, openQuestions: 0, lastKind: 'status', status: 'open', unread: null },
        { threadId: 'general', title: 'g', lastAt: 119, lastSeq: 119, cardCount: 19, openQuestions: 0, lastKind: 'status', status: 'open', unread: null },
      ] })),
      read: vi.fn(async (p: { threadId?: string }) => (p.threadId === DM
        ? { ok: true as const, workspaceId: WS, threadId: DM, cards: [old], nextSinceSeq: 3, hasMore: false }
        : { ok: true as const, workspaceId: WS, threadId: null, cards: recent, nextSinceSeq: 119, hasMore: false })),
      actors: vi.fn(async () => ({ actors: {} })),
      onEvent: vi.fn(() => () => undefined),
    };
    setRoomsApiForTests(api as unknown as RoomsApi);
    await render(true);
    await flush();
    await flush();
    const dmReads = () => api.read.mock.calls.filter(([p]) => (p as { threadId?: string }).threadId === DM);
    expect(dmReads()).toEqual([[{ workspaceId: WS, threadId: DM, limit: 1 }]]);
    expect(useStore.getState().roomPreviewCards[timelineKey(WS, DM)]?.id).toBe('c-old');
    // The thread itself still reads as unread: opening it reads it whole.
    expect(useStore.getState().roomTimelines[timelineKey(WS, DM)]).toBeUndefined();
    await render(true);
    await flush();
    expect(dmReads()).toHaveLength(1);
  });
});
