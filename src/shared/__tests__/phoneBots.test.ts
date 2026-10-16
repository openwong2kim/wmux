import { describe, expect, it } from 'vitest';
import { fitPhoneBots, parsePhoneBotsConversation, parsePhoneBotsReply, type PhoneBotsConversation } from '../phoneBots';

const dm = (n: number): PhoneBotsConversation => ({
  kind: 'dm', threadId: `dm:bot-${n.toString(16).padStart(8, '0')}`, workspaceId: 'ws-1', name: 'Lead',
  botId: `bot-${n.toString(16).padStart(8, '0')}`, memberBotIds: [`bot-${n.toString(16).padStart(8, '0')}`],
  lastAt: 1000 - n, lastSeq: n, lastPreview: 'x'.repeat(200), lastActor: { kind: 'human' }, unread: null, openQuestions: 0,
});

describe('phoneBots allowlist', () => {
  it('a conversation must name its own thread: a 1:1 its bot, a group its own thread or General', () => {
    expect(parsePhoneBotsConversation({ ...dm(1), botId: 'bot-00000002' })).toBeNull();
    const group = { kind: 'group', threadId: 'group:grp-0000abcd', workspaceId: 'ws-1', name: 'Crew', groupId: 'grp-0000abcd', memberBotIds: [], lastAt: 1, lastSeq: 0, unread: 0, openQuestions: 0 };
    expect(parsePhoneBotsConversation(group)).toEqual(group);
    expect(parsePhoneBotsConversation({ ...group, threadId: 'general' })).toMatchObject({ threadId: 'general' });
    expect(parsePhoneBotsConversation({ ...group, threadId: 'group:grp-00000000' })).toBeNull();
    expect(parsePhoneBotsConversation({ ...group, threadId: 'pr:github.com/o/r#1' })).toBeNull();
    // No actor without a preview, and no field outside the list.
    expect(parsePhoneBotsConversation({ ...group, lastActor: { kind: 'human' }, secret: 1 })).toEqual(group);
  });

  it('fits the reply budget by dropping the oldest conversations, never a bot', () => {
    const conversations = Array.from({ length: 150 }, (_, i) => dm(i + 1));
    const fitted = fitPhoneBots({ factoryEnabled: true, bots: [], conversations }, 20 * 1024);
    expect(fitted.truncated).toBe(true);
    expect(fitted.conversations.length).toBeGreaterThan(0);
    expect(fitted.conversations).toEqual(conversations.slice(0, fitted.conversations.length));
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(20 * 1024);
    expect(fitPhoneBots({ factoryEnabled: true, bots: [], conversations: conversations.slice(0, 3) })).not.toHaveProperty('truncated');
  });
});

describe('docs/phone-client-contract.md — the Bots page example', () => {
  it('parses to itself through the allowlist the code uses', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'phone-client-contract.md'), 'utf8').replace(/\r\n/g, '\n');
    const start = doc.indexOf('#### The Bots page (');
    const section = doc.slice(start, doc.indexOf('\n#### ', start + 10));
    const [list] = [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
    expect(parsePhoneBotsReply(list)).toEqual(list);
  });
});
