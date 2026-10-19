import { describe, expect, it, vi } from 'vitest';
import { setLocale } from '../../../i18n';
import type { RoomCard } from '../../../../shared/room';
import type { RoomEntry } from '../botsModel';
import { LIVE_ARRIVAL_MS, RUN_WINDOW_MS, SEPARATOR_GAP_MS, buildTimeline, clockTime, elapsed, fullTime, liveNewAfter, separatorLabel, splitThreads, threadCards, unreadCount } from '../botsTimeline';

let seq = 0;
function card(p: Partial<RoomCard> = {}): RoomCard {
  seq += 1;
  return { version: 1, id: `c${seq}`, seq, workspaceId: 'w1', threadId: 'general', kind: 'opinion', at: 0, actor: { kind: 'bot', workspaceId: 'w1', botId: 'b1' }, title: `card ${seq}`, ...p };
}
const entries = (cards: RoomCard[]): RoomEntry[] => cards.map((c) => ({ kind: 'card', card: c }));
const T0 = new Date(2026, 9, 14, 9, 0).getTime();
const never = () => false;
const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}(${Object.values(vars).join('|')})` : key);

describe('buildTimeline', () => {
  it('continues a run for one author within ten minutes, and starts one otherwise', () => {
    const a = card({ at: T0 });
    const b = card({ at: T0 + RUN_WINDOW_MS - 1 });
    const c = card({ at: T0 + 2 * RUN_WINDOW_MS + 1 });
    const d = card({ at: T0 + 2 * RUN_WINDOW_MS + 2, actor: { kind: 'human' }, kind: 'human' });
    const msgs = buildTimeline(entries([a, b, c, d]), { waits: never }).filter((i) => i.kind === 'message');
    expect(msgs.map((i) => i.kind === 'message' && i.continuation)).toEqual([false, true, false, false]);
    // The run's avatar sits beside its last bubble.
    expect(msgs.map((i) => i.kind === 'message' && i.runEnd)).toEqual([false, true, true, true]);
  });

  it('a card that waits on the owner, or one with a kind word, stays inside its run', () => {
    const a = card({ at: T0 });
    const q = card({ at: T0 + 1, kind: 'question', state: 'open' });
    const verdict = card({ at: T0 + 3, kind: 'verdict' });
    const msgs = buildTimeline(entries([a, q, verdict]), { waits: (x) => x.id === q.id }).filter((i) => i.kind === 'message');
    expect(msgs.map((i) => i.kind === 'message' && i.continuation)).toEqual([false, true, true]);
    expect(msgs[1].kind === 'message' && msgs[1].waiting).toBe(true);
  });

  it('separates a new day and an hour\'s quiet with the date and time', () => {
    const a = card({ at: T0 });
    const b = card({ at: T0 + SEPARATOR_GAP_MS });
    const kinds = buildTimeline(entries([a, b]), { waits: never }).map((i) => i.kind);
    expect(kinds).toEqual(['day', 'message', 'day', 'message']);
  });

  it('divides days and merges consecutive system cards of one thread, never across threads', () => {
    const s1 = card({ at: T0, actor: { kind: 'system' }, kind: 'fact', threadId: 'task:t1' });
    const s2 = card({ at: T0 + 1, actor: { kind: 'system' }, kind: 'refusal', threadId: 'task:t1' });
    const s3 = card({ at: T0 + 2, actor: { kind: 'system' }, kind: 'fact', threadId: 'task:t2' });
    const next = card({ at: T0 + 24 * 3600_000 });
    const items = buildTimeline(entries([s1, s2, s3, next]), { waits: never });
    expect(items.map((i) => i.kind)).toEqual(['day', 'system', 'system', 'day', 'message']);
    expect(items[1].kind === 'system' && items[1].cards.map((c) => c.id)).toEqual([s1.id, s2.id]);
  });

  it('puts "New" above the first card from someone else after the read time, once', () => {
    const mine = card({ at: T0 + 10, actor: { kind: 'human' }, kind: 'human' });
    const old = card({ at: T0 });
    const fresh = card({ at: T0 + 20 });
    const fresher = card({ at: T0 + 30 });
    const kinds = buildTimeline(entries([old, mine, fresh, fresher]), { waits: never, newAfter: T0 + 5 }).map((i) => i.kind);
    expect(kinds).toEqual(['day', 'message', 'message', 'new', 'message', 'message']);
    expect(buildTimeline(entries([old]), { waits: never, newAfter: null }).some((i) => i.kind === 'new')).toBe(false);
  });

  it('draws no "New" above a reply that lands while the chat is in view', () => {
    const now = T0 + 30;
    const asked = card({ at: T0 + 10, actor: { kind: 'human' }, kind: 'human' });
    const read = card({ at: T0 });
    const reply = card({ at: T0 + 20 });
    // Opened with everything read (boundary T0); the reply arrives in view.
    const after = liveNewAfter([read, asked, reply], T0, T0 + 10, true, now);
    expect(after).toBe(T0 + 20);
    expect(buildTimeline(entries([read, asked, reply]), { waits: never, newAfter: after }).some((i) => i.kind === 'new')).toBe(false);
    // Out of view it stays new.
    expect(liveNewAfter([read, asked, reply], T0, T0 + 10, false, now)).toBe(T0);
    // What was unread when the chat opened keeps its divider.
    const unread = card({ at: T0 + 5 });
    expect(liveNewAfter([read, unread, asked, reply], T0, T0 + 10, true, now)).toBe(T0);
    // History read after the chat opened (nothing there before) stays new.
    expect(liveNewAfter([read, unread], T0 - 1, 0, true, T0 + LIVE_ARRIVAL_MS + 10)).toBe(T0 - 1);
    // A catch-up read of cards written while away stays new.
    expect(liveNewAfter([read, reply], T0, T0, true, T0 + 20 + LIVE_ARRIVAL_MS + 1)).toBe(T0);
  });
});

describe('splitThreads', () => {
  it('keeps General, each thread\'s root and any waiting card in the main timeline; counts the replies', () => {
    const root = card({ threadId: 'pr:x#1', at: T0 });
    const reply = card({ threadId: 'pr:x#1', at: T0 + 5, actor: { kind: 'system' }, kind: 'fact' });
    const ask = card({ threadId: 'pr:x#1', at: T0 + 9, kind: 'question', state: 'open' });
    const general = card({ at: T0 + 10 });
    const { main, threads } = splitThreads([root, reply, ask, general], (c) => c.id === ask.id);
    expect(main.map((c) => c.id)).toEqual([root.id, ask.id, general.id]);
    expect(threads.get(root.id)).toEqual({ workspaceId: 'w1', threadId: 'pr:x#1', replies: 2, lastAt: T0 + 9 });
    // The panel holds the thread and the cards that link it.
    const link = card({ refs: { threadId: 'pr:x#1' } });
    expect(threadCards([root, reply, general, link], 'w1', 'pr:x#1').map((c) => c.id)).toEqual([root.id, reply.id, link.id]);
  });

  it('shows a task thread\'s newest bot reply in the main timeline, marked, and a system root carries its summary', () => {
    const start = card({ threadId: 'task:t1', at: T0, actor: { kind: 'system' }, kind: 'fact', title: 'Task started' });
    const first = card({ threadId: 'task:t1', at: T0 + 1 });
    const done = card({ threadId: 'task:t1', at: T0 + 2, actor: { kind: 'system' }, kind: 'fact', title: 'Task done' });
    const answer = card({ threadId: 'task:t1', at: T0 + 3, title: 'Here is what I found' });
    const owner = card({ threadId: 'task:t1', at: T0 + 4, actor: { kind: 'human' }, kind: 'human' });
    const { main, threads, surfaced } = splitThreads([start, first, done, answer, owner], never);
    // Only the newest bot reply: an earlier one and the owner's stay in the panel.
    expect(main.map((c) => c.id)).toEqual([start.id, answer.id]);
    expect([...surfaced]).toEqual([answer.id]);
    const items = buildTimeline(entries(main), { waits: never, threads, surfaced });
    const system = items.find((i) => i.kind === 'system');
    expect(system?.kind === 'system' && system.thread?.replies).toBe(4);
    const msg = items.find((i) => i.kind === 'message');
    expect(msg?.kind === 'message' && msg.inThread).toBe(true);
  });
});

describe('time and counts', () => {
  it('a run header\'s clock and its tooltip use the app\'s language, not the system\'s (round 7)', () => {
    const at = new Date(2026, 9, 16, 5, 44).getTime();
    const time = vi.spyOn(Date.prototype, 'toLocaleTimeString');
    const full = vi.spyOn(Date.prototype, 'toLocaleString');
    try {
      setLocale('ko');
      expect(clockTime(at)).toBe(new Date(at).toLocaleTimeString('ko', { hour: '2-digit', minute: '2-digit' }));
      fullTime(at);
      expect(time.mock.calls[0][0]).toBe('ko');
      expect(full.mock.calls[0][0]).toBe('ko');
      expect(clockTime(0)).toBe('');
    } finally {
      setLocale('en');
      time.mockRestore();
      full.mockRestore();
    }
  });

  it('labels a separator with the weekday, date and time in the reader\'s language, and elapsed time as m:ss', () => {
    expect(separatorLabel(new Date(2026, 9, 11, 20, 37).getTime(), T0, t, 'en-US')).toBe('botsPage.chat.dateTime(Sun, Oct 11|8:37 PM)');
    // The day period's wording depends on the ICU data present (Electron's says 오후).
    expect(separatorLabel(new Date(2026, 9, 11, 20, 37).getTime(), T0, t, 'ko')).toMatch(/^botsPage\.chat\.dateTime\(10월 11일 \(일\)\|.*8:37\)$/);
    expect(separatorLabel(new Date(2025, 9, 11, 20, 37).getTime(), T0, t, 'en-US')).toContain('2025');
    expect(elapsed(14_000)).toBe('0:14');
    expect(elapsed(3_725_000)).toBe('1:02:05');
  });

  it('counts bot messages after the read time as unread, never the owner\'s or system lines', () => {
    const cards = [
      card({ at: T0 }),
      card({ at: T0 + 10 }),
      card({ at: T0 + 11, actor: { kind: 'human' }, kind: 'human' }),
      card({ at: T0 + 12, actor: { kind: 'system' }, kind: 'fact' }),
    ];
    expect(unreadCount(cards, T0 + 5)).toBe(1);
  });
});
