// What a bot on My Hermes is sent: the owner's own words in its 1:1 only.

import { describe, expect, it } from 'vitest';
import type { RoomCard } from '../../../shared/room';
import type { WakeItem } from '../../../shared/wake';
import { ownHermesPrompt, ownHermesRoomClean, ownHermesWakeRefusal } from '../myHermesTurn';

const BOT = 'bot-0000000a';
const item = (reason: WakeItem['reason'], threadId = `dm:${BOT}`) => ({ id: 'w-1', botId: BOT, workspaceId: 'ws-1', reason, threadId } as unknown as WakeItem);
const human = { kind: 'human' as const, text: 'hi', source: 'desktop' as const };

describe('ownHermesWakeRefusal', () => {
  const base = { botId: BOT, attended: true, routineClean: true, roomClean: true as boolean | null, routine: null };
  const why = (over: Partial<Parameters<typeof ownHermesWakeRefusal>[0]> & { item: WakeItem }) => ownHermesWakeRefusal({ ...base, ...over })?.why ?? null;

  it('passes only the owner\'s attended message in a clean 1:1', () => {
    expect(why({ item: item(human) })).toBeNull();
    expect(why({ item: item({ kind: 'schedule', scheduleId: 's-1' }) })).toMatch(/only your own messages/);
    expect(why({ item: item({ kind: 'manual', by: 'human' }) })).toMatch(/only your own messages/);
    expect(why({ item: item(human, 'general') })).toMatch(/one to one/);
    expect(why({ item: item({ ...human, roomWide: true }) })).toMatch(/one to one/);
    expect(why({ item: item(human), attended: false })).toMatch(/yours alone/);
    expect(why({ item: item(human), roomClean: false })).toMatch(/Another bot or a guest/);
    // An unreadable chat refuses too, saying so rather than blaming a writer.
    expect(why({ item: item(human), roomClean: null })).toMatch(/could not read this chat/);
    // A refused message is never a paused routine.
    expect(ownHermesWakeRefusal({ ...base, item: item(human), attended: false })).toMatchObject({ pause: false, note: true });
  });

  it('passes a slot of the owner\'s own routine of this bot, in its 1:1, over a clean wake and room', () => {
    const slot = item({ kind: 'routine', routineId: 'r-aaaaaaaa', dueAt: 1 });
    const owners = { prompt: 'check the build', author: 'owner' as const, botId: BOT, workspaceId: 'ws-1', threadId: `dm:${BOT}` as const };
    expect(ownHermesWakeRefusal({ ...base, item: slot, routine: owners, attended: false })).toBeNull();
    // A bot's routine (the bot wrote its text): paused, with a note.
    expect(ownHermesWakeRefusal({ ...base, item: slot, routine: { ...owners, author: undefined } })).toMatchObject({ why: expect.stringMatching(/a bot wrote this one/), pause: true, note: true });
    // Tainted wake or conversation, or signed-in data: paused.
    expect(ownHermesWakeRefusal({ ...base, item: slot, routine: owners, routineClean: false })).toMatchObject({ why: expect.stringMatching(/outside text/), pause: true });
    // A room another bot or a guest wrote in: paused.
    expect(ownHermesWakeRefusal({ ...base, item: slot, routine: owners, roomClean: false })).toMatchObject({ why: expect.stringMatching(/Another bot or a guest/), pause: true });
    // Outside its 1:1: paused.
    expect(ownHermesWakeRefusal({ ...base, item: slot, routine: { ...owners, threadId: 'general' } })).toMatchObject({ pause: true });
    // Gone, or another bot's: refused with no pause and no note.
    expect(ownHermesWakeRefusal({ ...base, item: slot, routine: null })).toMatchObject({ pause: false, note: false });
    expect(ownHermesWakeRefusal({ ...base, item: slot, routine: { ...owners, botId: 'bot-0000000b' } })).toMatchObject({ pause: false, note: false });
    expect(ownHermesWakeRefusal({ ...base, item: slot, routine: { ...owners, workspaceId: 'ws-2' } })).toMatchObject({ pause: false, note: false });
  });

  it('gives every refusal the owner is told of a code its card is worded by', () => {
    const slot = item({ kind: 'routine', routineId: 'r-aaaaaaaa', dueAt: 1 });
    const owners = { prompt: 'p', author: 'owner' as const, botId: BOT, workspaceId: 'ws-1', threadId: `dm:${BOT}` as const };
    const code = (over: Partial<Parameters<typeof ownHermesWakeRefusal>[0]> & { item: WakeItem }) => ownHermesWakeRefusal({ ...base, ...over })?.code;
    expect(code({ item: item({ kind: 'manual', by: 'human' }) })).toBe('notOwnerMessage');
    expect(code({ item: item(human, 'general') })).toBe('outsideDm');
    expect(code({ item: item(human), attended: false })).toBe('notAttended');
    expect(code({ item: item(human), roomClean: null })).toBe('roomUnreadable');
    expect(code({ item: item(human), roomClean: false })).toBe('roomDirty');
    expect(code({ item: slot, routine: { ...owners, author: undefined } })).toBe('routineBotWritten');
    expect(code({ item: slot, routine: { ...owners, threadId: 'general' } })).toBe('routineOutsideDm');
    expect(code({ item: slot, routine: owners, routineClean: null })).toBe('routineCleanUnknown');
    expect(code({ item: slot, routine: owners, routineClean: false })).toBe('routineTainted');
    expect(code({ item: slot, routine: owners, roomClean: false })).toBe('roomDirtyPaused');
    expect(code({ item: slot, routine: owners, roomClean: null })).toBe('roomUnreadable');
    // No note, no code.
    expect(code({ item: slot, routine: null })).toBeNull();
  });

  it('escapes a leading slash only', () => {
    expect(ownHermesPrompt('/tools')).toBe('\\/tools');
    expect(ownHermesPrompt('  /model x')).toBe('  \\/model x');
    expect(ownHermesPrompt('a /b')).toBe('a /b');
  });
});

describe('ownHermesRoomClean', () => {
  const card = (over: Partial<RoomCard>): RoomCard => ({ threadId: `dm:${BOT}`, kind: 'message', actor: { kind: 'human' }, ...over } as RoomCard);
  const writer = (cards: RoomCard[]) => ({ find: (_ws: string, match: (c: RoomCard) => boolean) => [...cards].reverse().find(match) ?? null });

  it('is clean with the owner\'s, its own and wmux\'s cards; never after another bot or a guest wrote there', () => {
    const own = card({ actor: { kind: 'bot', workspaceId: 'ws-1', botId: BOT } });
    expect(ownHermesRoomClean(writer([card({}), own, card({ actor: { kind: 'system' } })]), 'ws-1', BOT)).toBe(true);
    expect(ownHermesRoomClean(writer([card({}), card({ actor: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-0000000b' } })]), 'ws-1', BOT)).toBe(false);
    expect(ownHermesRoomClean(writer([card({ kind: 'guest' })]), 'ws-1', BOT)).toBe(false);
    expect(ownHermesRoomClean(writer([card({ origin: 'guest' } as Partial<RoomCard>)]), 'ws-1', BOT)).toBe(false);
    // Another thread's cards do not count; an unreadable room refuses.
    expect(ownHermesRoomClean(writer([card({ threadId: 'general', actor: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-0000000b' } })]), 'ws-1', BOT)).toBe(true);
    expect(ownHermesRoomClean(null, 'ws-1', BOT)).toBeNull();
  });
});
