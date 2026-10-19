// What a wake prompt says about the room right now: approvals as they stand,
// the other bots' replies to a room message, the language, the clock.

import { describe, expect, it } from 'vitest';
import { DEFAULT_BOT_BUDGETS, type BotProfile } from '../../../shared/bot';
import type { RoomCard, ThreadId } from '../../../shared/room';
import type { WakeItem } from '../../../shared/wake';
import { latinUiLanguage, localeLanguageName, scriptLanguage, wakeApprovals, wakeClock, wakeContext, wakeGroup, wakeLanguage, wakeRunReplies, type WakeContextPorts } from '../wakeContext';

const me: BotProfile = {
  version: 1, id: 'bot-0000000a', workspaceId: 'ws1', role: 'lead', name: 'Wmux Dev', engine: { kind: 'claude-sdk' }, triggers: [],
  budget: { ...DEFAULT_BOT_BUDGETS.lead }, enabled: true, createdAt: 1, updatedAt: 1,
};
let seq = 0;
const card = (over: Partial<RoomCard>): RoomCard => ({ version: 1, id: `c-${++seq}`, seq, workspaceId: 'ws1', threadId: 'general', kind: 'status', at: seq, actor: { kind: 'system' }, title: 't', ...over });
const owner = (title: string, over: Partial<RoomCard> = {}) => card({ kind: 'human', actor: { kind: 'human' }, title, ...over });
const said = (botId: string, title: string, over: Partial<RoomCard> = {}) => card({ actor: { kind: 'bot', workspaceId: 'ws1', botId }, title, ...over });

function ports(cards: RoomCard[], over: Partial<WakeContextPorts> = {}): WakeContextPorts {
  return {
    cards: (_ws, threadId: ThreadId | null, limit, sinceSeq) => cards
      .filter((c) => (threadId ? c.threadId === threadId : true) && (sinceSeq === undefined || c.seq > sinceSeq))
      .slice(sinceSeq === undefined ? -limit : 0, sinceSeq === undefined ? undefined : limit),
    findCard: (_ws, match) => [...cards].reverse().find(match) ?? null,
    botName: (id) => ({ 'bot-0000000b': 'Wmux Reviewer', 'bot-0000000c': 'Wmux 대장' } as Record<string, string>)[id] ?? null,
    ...over,
  };
}
const wake = (reason: WakeItem['reason'], threadId?: ThreadId): WakeItem => ({ id: 'w', botId: me.id, workspaceId: 'ws1', reason, priority: 0, enqueuedAt: 1, attempts: 1, state: 'running', ...(threadId ? { threadId } : {}) });

describe('wakeContext', () => {
  it('a wake in a group chat\'s thread carries the group and whether the bot spoke there (across the whole room)', () => {
    const G = 'group:grp-00000001' as ThreadId;
    const group = (_ws: string, t: ThreadId) => (t === G ? { id: 'grp-00000001', workspaceId: 'ws1', name: 'Ship', memberIds: [me.id, 'bot-0000000b'], threadId: G, createdAt: 1, updatedAt: 1 } : null);
    const fresh = [owner('Hi team', { threadId: G }), said('bot-0000000b', 'Hello', { threadId: G }), said(me.id, 'elsewhere')];
    expect(wakeGroup(ports(fresh, { group }), me, wake({ kind: 'human', text: 'Hi team', source: 'desktop' }, G))).toEqual({ name: 'Ship', memberIds: [me.id, 'bot-0000000b'], spoke: false });
    // An introduction long ago (older than any newest page) still counts.
    const old = [said(me.id, 'I am Wmux Dev', { threadId: G }), ...Array.from({ length: 300 }, () => owner('x', { threadId: G }))];
    expect(wakeGroup(ports(old, { group }), me, wake({ kind: 'human', text: 'x', source: 'desktop' }, G))?.spoke).toBe(true);
    expect(wakeGroup(ports(fresh, { group }), me, wake({ kind: 'human', text: 'x', source: 'desktop' }, 'general'))).toBeNull();
    expect(wakeGroup(ports(fresh), me, wake({ kind: 'human', text: 'x', source: 'desktop' }, G))).toBeNull();
  });

  it('reads a language from the script; a UI locale as its English name', () => {
    expect(scriptLanguage('머지할거 머지해')).toBe('Korean');
    expect(scriptLanguage('マージして')).toBe('Japanese');
    expect(scriptLanguage('合并吧')).toBe('Chinese');
    expect(scriptLanguage('merge it')).toBeNull();
    expect(localeLanguageName('ko')).toBe('Korean');
    expect(localeLanguageName('zh-TW')).toMatch(/Chinese/);
  });

  it('writes in the language of the owner\'s latest words to this bot (the wake\'s own, else the thread\'s, else the room\'s), else the UI\'s', () => {
    const cards = [owner('Hi everyone'), owner('너는 이슈 담당이야', { refs: { botIds: [me.id], botId: me.id } }), owner('only for the reviewer', { refs: { botId: 'bot-0000000b', botIds: ['bot-0000000b'] } })];
    expect(wakeLanguage(ports(cards), me, wake({ kind: 'human', text: 'merge it', source: 'desktop' }))).toEqual({ name: null, source: 'owner', sample: 'merge it' });
    // Another wake: the language, never the earlier words (they would read
    // as a request for this wake), unless the script cannot name it.
    expect(wakeLanguage(ports(cards), me, wake({ kind: 'routine', routineId: 'r-1', dueAt: 1 }))).toEqual({ name: 'Korean', source: 'owner', earlier: true });
    expect(wakeLanguage(ports([owner('bonjour à tous')]), me, wake({ kind: 'routine', routineId: 'r-1', dueAt: 1 }))).toEqual({ name: null, source: 'owner', sample: 'bonjour à tous', earlier: true });
    expect(wakeLanguage(ports([], { uiLocale: () => 'ja' }), me, wake({ kind: 'intro' }))).toEqual({ name: 'Japanese', source: 'ui' });
    expect(wakeLanguage(ports([]), me, wake({ kind: 'intro' }))).toBeNull();
  });

  it('a delegate in a thread another bot started writes in the language the owner used with that bot', () => {
    const P = 'plan:p-1' as ThreadId;
    const coord = 'bot-0000000c';
    // The owner spoke English to this bot long ago and Korean to the coordinator, whose plan thread this is.
    const cards = [
      owner('run the e2e checks', { refs: { botId: me.id, botIds: [me.id] } }),
      owner('e2e-win 정리해줘', { refs: { botId: coord, botIds: [coord] } }),
      said(coord, 'Plan: clean up e2e-win', { threadId: P, kind: 'plan' }),
    ];
    expect(wakeLanguage(ports(cards, { uiLocale: () => 'en' }), me, wake({ kind: 'handoff', handoffId: 'h-1' }, P))).toEqual({ name: 'Korean', source: 'owner', earlier: true });
    // The owner's own words in the thread, to whichever bot, come first.
    const answered = [...cards, owner('좋아요, 진행해', { threadId: P, refs: { botId: coord, botIds: [coord] } })];
    expect(wakeLanguage(ports(answered, { uiLocale: () => 'en' }), me, wake({ kind: 'handoff', handoffId: 'h-1' }, P))).toEqual({ name: 'Korean', source: 'owner', earlier: true });
    // General (or a 1:1) is nobody's lead thread, whoever posted first.
    const general = [
      said(coord, 'Hello'),
      owner('e2e-win 정리해줘', { threadId: `dm:${coord}` as ThreadId, refs: { botId: coord, botIds: [coord] } }),
      owner('run the e2e checks', { threadId: `dm:${me.id}` as ThreadId, refs: { botId: me.id, botIds: [me.id] } }),
    ];
    expect(wakeLanguage(ports(general, { uiLocale: () => 'en' }), me, wake({ kind: 'facts', factIds: [], trigger: { kind: 'task.done' } }, 'general'))?.sample).toBe('run the e2e checks');
    // A thread this bot started keeps the owner's words to this bot.
    const mine = [...cards.slice(0, 2), said(me.id, 'Status', { threadId: P })];
    expect(wakeLanguage(ports(mine, { uiLocale: () => 'en' }), me, wake({ kind: 'handoff', handoffId: 'h-1' }, P))?.sample).toBe('run the e2e checks');
  });

  it('a bot added after the owner wrote to the other bots follows the owner, not the UI language', () => {
    const cards = [owner('머지할거 머지해', { refs: { botIds: ['bot-0000000b', 'bot-0000000c'] } })];
    expect(wakeLanguage(ports(cards, { uiLocale: () => 'en' }), me, wake({ kind: 'intro' }))).toEqual({ name: 'Korean', source: 'owner', earlier: true });
  });

  it('names the language of Latin-script words from the UI language when it could be theirs; the owner\'s script always wins', () => {
    const intro = wake({ kind: 'intro' });
    // en UI, English words: English (the greeting no longer guesses).
    expect(wakeLanguage(ports([owner('Hello, nice to meet you')], { uiLocale: () => 'en' }), me, intro))
      .toEqual({ name: 'English', source: 'owner', sample: 'Hello, nice to meet you', earlier: true });
    expect(wakeLanguage(ports([], { uiLocale: () => 'en' }), me, wake({ kind: 'human', text: 'Review my PRs', source: 'desktop' })))
      .toEqual({ name: 'English', source: 'owner', sample: 'Review my PRs' });
    // ko UI, Korean words: Korean.
    expect(wakeLanguage(ports([owner('반가워요')], { uiLocale: () => 'ko' }), me, intro)).toEqual({ name: 'Korean', source: 'owner', earlier: true });
    // en UI, Korean words: the owner's own language, Korean.
    expect(wakeLanguage(ports([owner('반가워요')], { uiLocale: () => 'en' }), me, intro)).toEqual({ name: 'Korean', source: 'owner', earlier: true });
    expect(wakeLanguage(ports([], { uiLocale: () => 'en' }), me, wake({ kind: 'human', text: 'PR 리뷰해줘', source: 'desktop' })))
      .toEqual({ name: 'Korean', source: 'owner', sample: 'PR 리뷰해줘' });
    // ko UI, Latin-script words: Korean is not theirs, so no name; the sample shows the language.
    expect(wakeLanguage(ports([owner('Hello there')], { uiLocale: () => 'ko' }), me, intro)).toEqual({ name: null, source: 'owner', sample: 'Hello there', earlier: true });
    // A script no language is named for that is not Latin (Greek): no name from the UI.
    expect(wakeLanguage(ports([owner('Γεια σου')], { uiLocale: () => 'en' }), me, intro)).toEqual({ name: null, source: 'owner', sample: 'Γεια σου', earlier: true });
    expect(latinUiLanguage('de')).toBe('German');
    expect(latinUiLanguage('ja')).toBeNull();
    expect(latinUiLanguage('zh-TW')).toBeNull();
  });

  it('the owner\'s clock in their zone', () => {
    expect(wakeClock(Date.UTC(2026, 9, 13, 14, 52), 'Asia/Seoul')).toEqual({ timeZone: 'Asia/Seoul', local: '2026-10-13 23:52', weekday: 'Tuesday' });
    expect(wakeClock(0, 'Not/AZone')).toBeNull();
  });

  it('lists open requests and those settled within a day, newest change first; the bot\'s own say "you"', () => {
    const now = 10 * 24 * 3_600_000;
    const rows = [
      { action: 'merge', prNumber: 1, repoKey: 'k', state: 'executed', botId: 'bot-0000000b', createdAt: 1, updatedAt: now - 60_000 },
      { action: 'merge', prNumber: 2, repoKey: 'k', state: 'pending', botId: me.id, createdAt: 1, updatedAt: 5 },
      { action: 'merge', prNumber: 3, repoKey: 'k', state: 'denied', botId: me.id, createdAt: 1, updatedAt: now - 2 * 24 * 3_600_000 },
      { action: 'issue_close', issueNumber: 4, repoKey: 'k', state: 'refused', refusal: 'x', botId: 'bot-0000000z', createdAt: 1, updatedAt: now - 1000 },
    ];
    expect(wakeApprovals(ports([], { approvals: () => rows }), me, now)).toEqual([
      { what: 'Close issue #4', state: 'refused', action: 'issue_close', askedBy: 'bot-0000000z', at: now - 1000, refusal: 'x' },
      { what: 'Merge PR #1', state: 'executed', action: 'merge', askedBy: 'Wmux Reviewer', at: now - 60_000 },
      { what: 'Merge PR #2', state: 'pending', action: 'merge', askedBy: 'you', at: 5 },
    ]);
    expect(wakeApprovals(ports([], { approvals: () => { throw new Error('x'); } }), me, now)).toEqual([]);
  });

  it('on a room message: the other bots\' cards after it in its thread; none for a message to one bot', () => {
    const before = said('bot-0000000b', 'old');
    const msg = owner('Hi', { clientPostId: 'cp-1' });
    const cards = [before, msg, said('bot-0000000b', 'Hello, I review PRs', { body: 'b'.repeat(900) }), said(me.id, 'my own'), said('bot-0000000c', '안녕', { threadId: 'pr:github.com/o/r#1' }), said('bot-0000000c', 'I coordinate', { refs: { botIds: [me.id] } })];
    const room = wake({ kind: 'human', text: 'Hi', source: 'desktop', clientMessageId: 'cp-1', runId: 'run-x', room: true }, 'general');
    const replies = wakeRunReplies(ports(cards), me, room);
    expect(replies.map((r) => [r.name, r.title])).toEqual([['Wmux Reviewer', 'Hello, I review PRs'], ['Wmux 대장', 'I coordinate']]);
    expect(replies[0].body).toHaveLength(600);
    // The reply that mentioned this bot is marked for it.
    expect(replies.map((r) => r.toYou ?? false)).toEqual([false, true]);
    expect(wakeRunReplies(ports(cards), me, wake({ kind: 'human', text: 'Hi', source: 'desktop', clientMessageId: 'cp-1' }, 'general'))).toEqual([]);
    expect(wakeRunReplies(ports(cards), me, wake({ kind: 'human', text: 'Hi', source: 'desktop', clientMessageId: 'nope', room: true }, 'general'))).toEqual([]);
  });

  it('puts it together, best effort', () => {
    const ctx = wakeContext(ports([], { uiLocale: () => 'en', timeZone: () => 'UTC', now: () => 0, approvals: () => [] }), me, wake({ kind: 'intro' }));
    expect(ctx).toMatchObject({ approvals: [], runReplies: [], language: { name: 'English', source: 'ui' }, clock: { timeZone: 'UTC', local: '1970-01-01 00:00' }, now: 0 });
  });
});
