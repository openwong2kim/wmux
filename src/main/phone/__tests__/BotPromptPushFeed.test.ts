import { afterEach, describe, expect, it, vi } from 'vitest';
import { botPromptPushRows, createBotPromptPushFeed, noteBotSetChanged, openBotPromptRows, setBotPromptPushFeed } from '../BotPromptPushFeed';
import type { RoomCard } from '../../../shared/room';

function card(id: string, over: Partial<RoomCard>): RoomCard {
  return {
    version: 1,
    id,
    seq: 1,
    workspaceId: 'ws-1',
    threadId: 'general',
    kind: 'question',
    at: 1,
    actor: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-1' },
    title: 'Which branch should I merge into: main or the release branch?',
    state: 'open',
    ...over,
  } as RoomCard;
}

describe('botPromptPushRows', () => {
  it('★ sends only open prompt cards a bot wrote, by their refs and never their words', () => {
    const rows = botPromptPushRows(
      [
        card('c-q1', {}),
        card('c-q2', { state: 'resolved' }),
        card('c-l1', { kind: 'login_request', refs: { label: 'claude' }, title: 'Log in to Claude' }),
        card('c-s1', { kind: 'secret_request', refs: { secretName: 'OPENAI_API_KEY' }, body: 'I need it for the eval run' }),
        card('c-a1', { kind: 'approval', refs: { approvalId: 'apr-abcdefgh12' } }),
        card('c-h1', { kind: 'question', actor: { kind: 'human' } }),
      ],
      () => 'Scout',
    );
    expect(rows).toEqual([
      { cardId: 'c-q1', promptKind: 'question', workspaceId: 'ws-1', threadId: 'general', botId: 'bot-1', botName: 'Scout' },
      { cardId: 'c-l1', promptKind: 'login_request', workspaceId: 'ws-1', threadId: 'general', botId: 'bot-1', botName: 'Scout', loginService: 'claude' },
      { cardId: 'c-s1', promptKind: 'secret_request', workspaceId: 'ws-1', threadId: 'general', botId: 'bot-1', botName: 'Scout', secretName: 'OPENAI_API_KEY' },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/Which branch|eval run/);
  });
});

describe('openBotPromptRows', () => {
  it('★ is not known (null) until the rooms run, so a connect before them sends no empty table', () => {
    const bots = { listEnabled: () => [{ workspaceId: 'ws-1', id: 'bot-1' }], get: () => ({ name: 'Scout' }) } as never;
    expect(openBotPromptRows(null, bots)).toBeNull();
    const pushes: unknown[] = [];
    const feed = createBotPromptPushFeed({ rows: () => openBotPromptRows(null, bots), push: async (rows) => { pushes.push(rows); } });
    feed.publishNow();
    expect(pushes).toEqual([]);
    const writer = { openCards: () => [card('c-q1', {})] };
    expect(openBotPromptRows(writer, bots)?.map((r) => r.cardId)).toEqual(['c-q1']);
  });

  it('★ pushes a card only while its own bot is enabled, though another bot of the room is on', () => {
    const enabled = new Set(['bot-1', 'bot-2']);
    const bots = {
      listEnabled: () => [...enabled].map((botId) => ({ workspaceId: 'ws-1', id: botId })),
      get: () => ({ name: 'Scout' }),
    } as never;
    const writer = { openCards: () => [card('c-q1', {}), card('c-q2', { actor: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-2' } })] };
    expect(openBotPromptRows(writer, bots)?.map((r) => r.cardId)).toEqual(['c-q1', 'c-q2']);
    enabled.delete('bot-2');
    expect(openBotPromptRows(writer, bots)?.map((r) => r.cardId)).toEqual(['c-q1']);
  });
});

describe('noteBotSetChanged', () => {
  afterEach(() => {
    setBotPromptPushFeed(null);
    vi.useRealTimers();
  });

  it('★ republishes when a bot is turned off, so its open card is retracted', async () => {
    vi.useFakeTimers();
    let on = true;
    const bots = { listEnabled: () => (on ? [{ workspaceId: 'ws-1', id: 'bot-1' }] : []), get: () => ({ name: 'Scout' }) } as never;
    const writer = { openCards: () => [card('c-q1', {})] };
    const pushes: string[][] = [];
    const feed = createBotPromptPushFeed({ rows: () => openBotPromptRows(writer, bots), push: async (rows) => { pushes.push(rows.map((r) => r.cardId)); } });
    setBotPromptPushFeed(feed);
    feed.publishNow();
    on = false;
    noteBotSetChanged();
    await vi.advanceTimersByTimeAsync(100);
    expect(pushes).toEqual([['c-q1'], []]);
  });
});
