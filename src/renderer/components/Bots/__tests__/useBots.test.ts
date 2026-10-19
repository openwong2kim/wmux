// A thread with an open question is read from its first card, page by page,
// so a question older than the newest page still counts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import { timelineKey } from '../../../stores/slices/roomSlice';
import { setRoomsApiForTests, type RoomsApi } from '../../../hooks/useRoomSync';
import type { RoomCard } from '../../../../shared/room';
import { loadWholeThread, previewThreadsToRead, threadsToRead, withPreviews } from '../useBots';
import { roomCardsByWorkspace } from '../botsModel';
import { ALL_THREADS } from '../../../stores/slices/roomSlice';
import { DEFAULT_BOT_BUDGETS } from '../../../../shared/bot';
import type { FactoryBotRow } from '../../Room/factoryPorts';
import type { ThreadSummary } from '../../../../shared/room';

const THREAD = 'task:t1' as const;
const card = (seq: number, over: Partial<RoomCard> = {}): RoomCard => ({
  version: 1, id: `c${seq}`, seq, workspaceId: 'w1', threadId: THREAD, kind: 'status', at: seq,
  actor: { kind: 'bot', workspaceId: 'w1', botId: 'bot-0000000a' }, title: `c${seq}`, ...over,
});

afterEach(() => setRoomsApiForTests(undefined));

describe('loadWholeThread', () => {
  it('reads from seq 0 through every page, the first question included', async () => {
    const pages: Record<number, { cards: RoomCard[]; next: number; more: boolean }> = {
      0: { cards: [card(1, { kind: 'question', state: 'open' }), card(2)], next: 2, more: true },
      2: { cards: [card(3)], next: 3, more: false },
    };
    const read = vi.fn(async (p: { sinceSeq?: number }) => {
      const pg = pages[p.sinceSeq ?? -1];
      return { ok: true as const, workspaceId: 'w1', threadId: THREAD, cards: pg.cards, nextSinceSeq: pg.next, hasMore: pg.more };
    });
    setRoomsApiForTests({ read } as unknown as RoomsApi);
    useStore.setState({ roomTimelines: {} } as never);
    await loadWholeThread('w1', THREAD);
    expect(read.mock.calls.map((c) => (c[0] as { sinceSeq?: number }).sinceSeq)).toEqual([0, 2]);
    const tl = useStore.getState().roomTimelines[timelineKey('w1', THREAD)];
    expect(tl.cards.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(tl.loading).toBeUndefined();
    expect(tl.nextSinceSeq).toBe(3);
  });
});

describe('loadWholeThread refresh', () => {
  it('a refresh asked for while a read is in flight reads once more after it', async () => {
    useStore.setState({ roomTimelines: {}, roomPushCount: 0, roomPushedAt: {} } as never);
    useStore.getState().setRoomPage('w1', THREAD, { cards: [card(1, { kind: 'plan', state: 'open' })], nextSinceSeq: 1, hasMore: false }, 'replace');
    let state: RoomCard['state'] = 'open';
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.fn(async () => {
      const snapshot = card(1, { kind: 'plan', state });
      if (read.mock.calls.length === 1) await gate;
      return { ok: true as const, workspaceId: 'w1', threadId: THREAD, cards: [snapshot], nextSinceSeq: 1, hasMore: false };
    });
    setRoomsApiForTests({ read } as unknown as RoomsApi);
    const first = loadWholeThread('w1', THREAD);
    state = 'resolved';
    await loadWholeThread('w1', THREAD);
    release();
    await first;
    expect(read).toHaveBeenCalledTimes(2);
    expect(useStore.getState().roomTimelines[timelineKey('w1', THREAD)].cards[0].state).toBe('resolved');
  });
});

describe('threadsToRead', () => {
  const th = (threadId: ThreadSummary['threadId'], over: Partial<ThreadSummary> = {}): ThreadSummary => ({
    threadId, title: 't', lastAt: 1, lastSeq: 1, cardCount: 1, openQuestions: 0, lastKind: 'status', status: 'open', unread: null, ...over,
  });
  it('reads open-question threads, the newest plan and open proposal threads, each once', () => {
    const threads = {
      hq: [th('plan:p-old', { lastSeq: 3 }), th('plan:p-new', { lastSeq: 9 }), th('general')],
      w1: [
        th('task:t1', { openQuestions: 1 }),
        th('issue:github.com/a/b#4', { lastKind: 'proposal' }),
        th('issue:github.com/a/b#5', { lastKind: 'proposal', status: 'closed' }),
        th('task:t2'),
      ],
    };
    expect(threadsToRead(['hq', 'w1'], threads, {})).toEqual([
      timelineKey('hq', 'plan:p-new'), timelineKey('w1', 'task:t1'), timelineKey('w1', 'issue:github.com/a/b#4'),
    ]);
    // Already read: not again.
    expect(threadsToRead(['hq'], threads, { [timelineKey('hq', 'plan:p-new')]: {} })).toEqual([]);
  });
});

describe('previewThreadsToRead', () => {
  const botRow = (id: string, ws = 'w1'): FactoryBotRow => ({
    bot: { version: 1, id, workspaceId: ws, role: 'lead', name: id, engine: { kind: 'claude-sdk' }, triggers: [], budget: DEFAULT_BOT_BUDGETS.lead, enabled: true, createdAt: 1, updatedAt: 1 },
    status: null,
  });
  const th = (threadId: string, lastSeq: number, over: Partial<ThreadSummary> = {}): ThreadSummary => ({
    threadId: threadId as ThreadSummary['threadId'], title: threadId, lastAt: lastSeq, lastSeq, cardCount: 1, openQuestions: 0, lastKind: 'status', status: 'open', unread: null, ...over,
  });
  const quiet = botRow('bot-0000000a');
  const busy = botRow('bot-0000000b');
  const group = { id: 'grp-00000001', workspaceId: 'w1', threadId: 'group:grp-00000001' as const };
  // The room's newest page holds only the busy bot's 1:1.
  const room = { [timelineKey('w1', ALL_THREADS)]: { cards: [{ seq: 400 }, { seq: 401 }] } };

  it('reads the thread holding a quiet conversation\'s newest card, once per conversation, not one already read', () => {
    const threads = { w1: [
      th('dm:bot-0000000a', 12), th('handoff:h-1', 30, { dmBotId: 'bot-0000000a' }),
      th('dm:bot-0000000b', 401),
      th('group:grp-00000001', 7), th('handoff:h-2', 5, { groupId: 'grp-00000001' }),
      th('general', 399),
    ] };
    expect(previewThreadsToRead([quiet, busy], [group], threads, room)).toEqual([
      timelineKey('w1', 'handoff:h-1'),
      timelineKey('w1', 'group:grp-00000001'),
    ]);
    // Read (or being read): asked no more.
    const read = { ...room, [timelineKey('w1', 'handoff:h-1')]: { cards: [{ seq: 30 }] }, [timelineKey('w1', 'group:grp-00000001')]: { cards: [], loading: true } };
    expect(previewThreadsToRead([quiet, busy], [group], threads, read)).toEqual([timelineKey('w1', 'group:grp-00000001')]);
    expect(previewThreadsToRead([quiet, busy], [group], threads, { ...read, [timelineKey('w1', 'group:grp-00000001')]: { cards: [{ seq: 7 }] } })).toEqual([]);
    // A preview card read already covers its thread, until a newer card lands there.
    const previews = { [timelineKey('w1', 'handoff:h-1')]: { seq: 30 }, [timelineKey('w1', 'group:grp-00000001')]: { seq: 7 } };
    expect(previewThreadsToRead([quiet, busy], [group], threads, room, previews)).toEqual([]);
    expect(previewThreadsToRead([quiet, busy], [group], { w1: threads.w1.map((t) => (t.threadId === 'handoff:h-1' ? { ...t, lastSeq: 31 } : t)) }, room, previews)).toEqual([timelineKey('w1', 'handoff:h-1')]);
  });

  it('a thread read whole anyway (an open question) or with no card is left out; no summaries, nothing to read', () => {
    const threads = { w1: [th('dm:bot-0000000a', 12, { openQuestions: 1 }), th('group:grp-00000001', 0, { cardCount: 0 })] };
    expect(previewThreadsToRead([quiet], [group], threads, room)).toEqual([]);
    expect(previewThreadsToRead([quiet], [group], {}, room)).toEqual([]);
  });
});

describe('withPreviews', () => {
  it('preview cards join the model before the timelines, so a timeline\'s copy of the same card wins', () => {
    const preview = card(5, { title: 'old copy' });
    const timelines = { [timelineKey('w1', THREAD)]: { cards: [card(5, { title: 'fresh copy' })], nextSinceSeq: 5, hasMore: false } };
    const merged = withPreviews({ [timelineKey('w1', THREAD)]: preview }, timelines);
    expect(Object.keys(merged)).toEqual([`${timelineKey('w1', THREAD)}\u0000preview`, timelineKey('w1', THREAD)]);
    expect(roomCardsByWorkspace(merged).get('w1')?.map((c) => c.title)).toEqual(['fresh copy']);
    expect(withPreviews({}, timelines)).toBe(timelines);
  });
});
