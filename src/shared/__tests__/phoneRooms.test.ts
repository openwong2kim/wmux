import { describe, it, expect } from 'vitest';
import {
  PHONE_ROOM_LIMITS,
  fitPhoneRoomPage,
  fitPhoneRoomThreads,
  isPhoneRoomWorkspaceId,
  parsePhoneRoomCard,
  parsePhoneRoomCardsReply,
  parsePhoneRoomThreadsReply,
  phoneRoomCard,
  type PhoneRoomCardsReply,
} from '../phoneRooms';
import type { RoomCard } from '../room';
import { CARD_KINDS } from '../../main/factory/roomWriter';

const card = (seq: number, over: Partial<RoomCard> = {}): RoomCard => ({
  version: 1, id: `c-${seq}`, seq, workspaceId: 'ws-1', threadId: 'general', kind: 'status', at: 1000 + seq,
  actor: { kind: 'bot', workspaceId: 'ws-1', botId: 'bot-1111bbbb' }, title: `card ${seq}`, ...over,
});

describe('phone room cards', () => {
  it('projects a card: bot role and name resolved, idempotency key and workspace left out', () => {
    const out = phoneRoomCard(card(3, { clientPostId: 'phone:abc:1', body: 'line 1\nline 2‮', refs: { pr: 7, url: 'javascript:alert(1)', check: 'ci' } }), () => ({ role: 'lead', name: 'Lead' }));
    expect(out).toEqual({
      id: 'c-3', seq: 3, threadId: 'general', kind: 'status', at: 1003,
      actor: { kind: 'bot', botId: 'bot-1111bbbb', role: 'lead', name: 'Lead' },
      title: 'card 3', body: 'line 1\nline 2', refs: { pr: 7, check: 'ci' },
    });
    expect(parsePhoneRoomCard(out)).toEqual(out);
  });

  it("carries an owner card's photos without their upload names; no other card carries any", () => {
    const photo = { id: 'a'.repeat(32), mediaType: 'image/jpeg' as const, bytes: 1234, width: 1568, height: 1176, upload: 'photo-2026-10-18T01-02-03-456Z-0a1b2c3d.jpg' };
    const owner = phoneRoomCard(card(7, { kind: 'human', actor: { kind: 'human' }, attachments: [photo] }), () => null);
    expect(owner?.attachments).toEqual([{ id: photo.id, mediaType: 'image/jpeg', bytes: 1234, width: 1568, height: 1176 }]);
    expect(parsePhoneRoomCard(owner)).toEqual(owner);
    expect(phoneRoomCard(card(8, { attachments: [photo] }), () => null)).not.toHaveProperty('attachments');
  });

  it("gives an owner card a phone sent its clientMessageId, and no other card any id", () => {
    const human = { kind: 'human' as const, actor: { kind: 'human' as const } };
    const owner = phoneRoomCard(card(4, { ...human, clientPostId: 'phone:0123456789abcdef:msg-1' }), () => null);
    expect(owner?.clientMessageId).toBe('msg-1');
    expect(parsePhoneRoomCard(owner)).toEqual(owner);
    expect(phoneRoomCard(card(5, { ...human, clientPostId: 'desktop-7' }), () => null)?.clientMessageId).toBeUndefined();
    expect(phoneRoomCard(card(6, { kind: 'human', clientPostId: 'phone:0123456789abcdef:msg-2' }), () => null)?.clientMessageId).toBeUndefined();
    expect(parsePhoneRoomCard({ ...owner, clientMessageId: 'a\nb' })?.clientMessageId).toBeUndefined();
  });

  it('passes every card kind main writes, and a later kind by its name; a malformed kind is refused', () => {
    for (const kind of CARD_KINDS) expect(phoneRoomCard(card(1, { kind }), () => null)?.kind, kind).toBe(kind);
    expect(parsePhoneRoomCard({ ...card(1), kind: 'some_later_kind' })?.kind).toBe('some_later_kind');
    for (const kind of [undefined, 7, '', 'Status', 'a b', 'x'.repeat(41)]) expect(parsePhoneRoomCard({ ...card(1), kind }), String(kind)).toBeNull();
    const t = { threadId: 'general', title: 'General', lastAt: 0, lastSeq: 1, cardCount: 1, openQuestions: 0, lastKind: 'routine', status: 'open', unread: null };
    expect(parsePhoneRoomThreadsReply({ workspaceId: 'ws-1', threads: [t] }, 'ws-1')?.threads.map((x) => x.lastKind)).toEqual(['routine']);
  });

  it('carries the refs a phone reads and the greeting mark; a secret_request names its secret, never a value', () => {
    const refs = {
      botIds: ['bot-1111bbbb', 'bot-1111bbbb', 'nope'], threadId: 'pr:github.com/o/r#3', routineId: 'rt-1', label: 'github',
      secretName: 'NPM_TOKEN', approvalId: 'apr-aaaaaaaa1', ptyId: 'p-1', messageId: 'm-1', value: 'hunter2', secret: 'hunter2',
    };
    expect(phoneRoomCard(card(1, { kind: 'secret_request', refs: refs as never }), () => null)?.refs).toEqual({
      botIds: ['bot-1111bbbb'], threadId: 'pr:github.com/o/r#3', routineId: 'rt-1', label: 'github', secretName: 'NPM_TOKEN', approvalId: 'apr-aaaaaaaa1',
    });
    expect(parsePhoneRoomCard({ ...card(1), kind: 'secret_request', refs: { secretName: 'not a name' } })?.refs).toBeUndefined();
    expect(phoneRoomCard(card(2, { kind: 'question', greeting: true }), () => null)?.greeting).toBe(true);
    expect(parsePhoneRoomCard({ ...card(2), greeting: true })?.greeting).toBeUndefined();
    // The desktop's Undo record of a job change stays on the desktop.
    expect(phoneRoomCard(card(3, { kind: 'job_changed', jobChange: { botId: 'bot-1111bbbb', previous: null, next: 'x' } }), () => null)).not.toHaveProperty('jobChange');
  });

  it('refuses a card without identity, a kind or a valid thread', () => {
    expect(parsePhoneRoomCard({ ...card(1), threadId: 'nope' })).toBeNull();
    expect(parsePhoneRoomCard({ ...card(1), id: 'a b' })).toBeNull();
    expect(parsePhoneRoomCard({ ...card(1), actor: { kind: 'bot' } })).toBeNull();
  });

  it('the cards reply must answer the workspace and thread asked for; cards out of seq order or thread are dropped', () => {
    const reply = { workspaceId: 'ws-1', threadId: 'general', nextSinceSeq: 3, hasMore: false, cards: [card(1), card(1), card(2, { threadId: 'task:t1' }), card(3)] };
    expect(parsePhoneRoomCardsReply(reply, 'ws-2', 'general')).toBeNull();
    expect(parsePhoneRoomCardsReply(reply, 'ws-1', null)).toBeNull();
    expect(parsePhoneRoomCardsReply(reply, 'ws-1', 'general')?.cards.map((c) => c.seq)).toEqual([1, 3]);
  });

  it('the threads reply is bounded and marks truncation', () => {
    const t = { threadId: 'general', title: 'General', lastAt: 0, lastSeq: 0, cardCount: 0, openQuestions: 0, lastKind: 'fact', status: 'open', unread: null };
    const many = Array.from({ length: PHONE_ROOM_LIMITS.threads + 5 }, (_, i) => ({ ...t, threadId: `task:t${i}` }));
    const out = parsePhoneRoomThreadsReply({ workspaceId: 'ws-1', threads: many }, 'ws-1');
    expect(out?.threads).toHaveLength(PHONE_ROOM_LIMITS.threads);
    expect(out?.truncated).toBe(true);
  });

  it('workspace ids follow the room store rule', () => {
    expect(isPhoneRoomWorkspaceId('ws-1')).toBe(true);
    for (const bad of ['', '..', 'a/b', 'x'.repeat(81), 5]) expect(isPhoneRoomWorkspaceId(bad)).toBe(false);
  });
});

describe('phone room cards — notice and approvalAction', () => {
  const sys = { actor: { kind: 'system' as const }, kind: 'fact' as const };

  it('passes a system card\'s notice for a published code, its title kept in English', () => {
    const c = card(1, { ...sys, title: 'Task done: Add a flag', notice: { code: 'task.done', args: { title: 'Add a flag' } } });
    const out = phoneRoomCard(c, () => null);
    expect(out?.notice).toEqual({ code: 'task.done', args: { title: 'Add a flag' } });
    expect(out?.title).toBe('Task done: Add a flag');
    expect(parsePhoneRoomCard(out)).toEqual(out);
    expect(phoneRoomCard(card(2, { ...sys, notice: { code: 'gate.passed' } }), () => null)?.notice).toEqual({ code: 'gate.passed' });
  });

  it('drops a notice with an unpublished code, on a card that is not the system\'s, or that is no object', () => {
    for (const code of ['task.later', 'constructor', '__proto__', 'toString', '', 7]) {
      expect(parsePhoneRoomCard({ ...card(1, sys), notice: { code } })?.notice, String(code)).toBeUndefined();
    }
    expect(phoneRoomCard(card(1, { notice: { code: 'task.done', args: { title: 'x' } } }), () => null)?.notice).toBeUndefined();
    expect(parsePhoneRoomCard({ ...card(1, sys), notice: 'task.done' })?.notice).toBeUndefined();
    expect(parsePhoneRoomCard({ ...card(1, sys), notice: ['task.done'] })?.notice).toBeUndefined();
  });

  it('keeps only the code\'s own args, each of its type, strings bounded and without control characters', () => {
    const out = parsePhoneRoomCard({
      ...card(1, sys),
      notice: { code: 'worker.waiting', args: {
        title: `a\u0007b‮${'x'.repeat(600)}`, inUse: 2, cap: '3', bots: 'Lead\nDev', botCount: Number.NaN, secret: 'hunter2', constructor: 'x',
      } },
    });
    expect(Object.keys(out?.notice?.args ?? {}).sort()).toEqual(['bots', 'inUse', 'title']);
    expect(out?.notice?.args?.inUse).toBe(2);
    expect(out?.notice?.args?.bots).toBe('Lead\nDev');
    const title = out?.notice?.args?.title as string;
    expect(title.startsWith('abx')).toBe(true);
    expect(title).toHaveLength(500);
    expect(parsePhoneRoomCard(out)).toEqual(out);
    // No arg left: the code alone.
    expect(parsePhoneRoomCard({ ...card(1, sys), notice: { code: 'gate.failed', args: { exit: 'one' } } })?.notice).toEqual({ code: 'gate.failed' });
  });

  it('gives an approval card its request\'s action, and no other card one', () => {
    const approval = card(1, { kind: 'approval', refs: { approvalId: 'apr-aaaaaaaa1' } });
    const asked: string[] = [];
    const action = (id: string) => (asked.push(id), 'merge');
    const out = phoneRoomCard(approval, () => null, action);
    expect(out?.approvalAction).toBe('merge');
    expect(asked).toEqual(['apr-aaaaaaaa1']);
    expect(parsePhoneRoomCard(out)).toEqual(out);
    // A later action passes by its name (the app shows it as desktop-only).
    expect(phoneRoomCard(approval, () => null, () => 'skill')?.approvalAction).toBe('skill');
    expect(phoneRoomCard(approval, () => null, () => null)?.approvalAction).toBeUndefined();
    expect(phoneRoomCard(approval, () => null)?.approvalAction).toBeUndefined();
    expect(phoneRoomCard(card(2, { kind: 'status', refs: { approvalId: 'apr-aaaaaaaa1' } }), () => null, action)?.approvalAction).toBeUndefined();
    expect(phoneRoomCard(card(3, { kind: 'approval' }), () => null, action)?.approvalAction).toBeUndefined();
    for (const v of ['Merge', 'a b', '', 'x'.repeat(41), 3]) expect(parsePhoneRoomCard({ ...approval, approvalAction: v })?.approvalAction, String(v)).toBeUndefined();
    expect(parsePhoneRoomCard({ ...card(4), approvalAction: 'merge' })?.approvalAction).toBeUndefined();
  });

  it('leaves every other field as it was', () => {
    const c = card(5, { ...sys, body: 'evidence', refs: { taskId: 't1' }, notice: { code: 'task.done', args: { title: 't' } } });
    const { notice, ...rest } = phoneRoomCard(c, () => null, () => 'merge') ?? {};
    expect(notice).toBeDefined();
    expect(rest).toEqual(phoneRoomCard({ ...c, notice: undefined }, () => null));
  });
});

describe('fitPhoneRoomPage', () => {
  const big = (seq: number) => parsePhoneRoomCard(card(seq, { body: 'x'.repeat(8000) }))!;
  const page = (n: number): PhoneRoomCardsReply => ({
    workspaceId: 'ws-1', threadId: null, cards: Array.from({ length: n }, (_, i) => big(i + 1)), nextSinceSeq: n, hasMore: false,
  });
  const size = (r: unknown) => new TextEncoder().encode(JSON.stringify(r)).length;

  it('a forward page keeps its oldest cards under the budget and says hasMore at the last kept seq', () => {
    const out = fitPhoneRoomPage(page(40), true);
    expect(size(out)).toBeLessThanOrEqual(PHONE_ROOM_LIMITS.replyBytes);
    expect(out.cards[0].seq).toBe(1);
    expect(out.hasMore).toBe(true);
    expect(out.nextSinceSeq).toBe(out.cards[out.cards.length - 1].seq);
  });

  it('the newest page keeps its newest cards', () => {
    const out = fitPhoneRoomPage(page(40), false);
    expect(size(out)).toBeLessThanOrEqual(PHONE_ROOM_LIMITS.replyBytes);
    expect(out.cards[out.cards.length - 1].seq).toBe(40);
    expect(out.nextSinceSeq).toBe(40);
  });

  it('a page that fits is unchanged', () => {
    const small = page(2);
    expect(fitPhoneRoomPage(small, true)).toBe(small);
  });
});

describe('fitPhoneRoomThreads', () => {
  const t = (id: string, title = 't') => ({ threadId: id as never, title, lastAt: 1, lastSeq: 1, cardCount: 1, openQuestions: 1, lastKind: 'question' as const, status: 'open' as const, unread: null });

  it('keeps general even when 100 other threads rank ahead of it, and marks truncation', () => {
    const threads = [...Array.from({ length: 120 }, (_, i) => t(`task:t${i}`)), t('general')];
    const out = fitPhoneRoomThreads({ workspaceId: 'ws-1', threads });
    expect(out.threads).toHaveLength(PHONE_ROOM_LIMITS.threads);
    expect(out.threads[out.threads.length - 1].threadId).toBe('general');
    expect(out.truncated).toBe(true);
  });

  it('stays under the byte budget when titles escape to six bytes a unit', () => {
    const lone = '\ud800'.repeat(200);
    const threads = [t('general'), ...Array.from({ length: 99 }, (_, i) => t(`task:t${i}`, lone))];
    const out = fitPhoneRoomThreads({ workspaceId: 'ws-1', threads });
    expect(new TextEncoder().encode(JSON.stringify(out)).length).toBeLessThanOrEqual(PHONE_ROOM_LIMITS.replyBytes);
    expect(out.threads[0].threadId).toBe('general');
    expect(out.truncated).toBe(true);
  });

  it('a list that fits is whole and not truncated', () => {
    const out = fitPhoneRoomThreads({ workspaceId: 'ws-1', threads: [t('general'), t('task:a')] });
    expect(out).toEqual({ workspaceId: 'ws-1', threads: [t('general'), t('task:a')] });
  });
});

describe('docs/phone-client-contract.md — the agent factory examples', () => {
  // The JSON examples of the section, with the doc's `…` placeholders filled in.
  const examples = async (): Promise<unknown[]> => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    // A Windows checkout may hold the doc with CRLF line ends.
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'phone-client-contract.md'), 'utf8').replace(/\r\n/g, '\n');
    const start = doc.indexOf('#### The agent factory (`factory`, `rooms`, `/api/rooms`)');
    const section = doc.slice(start, doc.indexOf('\n#### ', start + 10));
    return [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1].replace(/\[ … \]/g, '[]').replace(/…/g, 'x')));
  };

  it('every example parses to itself through the allowlists the code uses', async () => {
    const [row, threads, cards] = await examples() as [Record<string, unknown>, { workspaceId: string }, { workspaceId: string; threadId: string }];
    const { parsePhoneSidebarSnapshot } = await import('../phoneFleetSidebar');
    const snap = parsePhoneSidebarSnapshot({ activeWorkspaceId: null, panes: [], workspaces: [{ id: row.id, order: 0, pinned: false, bots: row.bots, openQuestions: row.openQuestions }] });
    expect(snap?.workspaces[0]).toEqual({ id: row.id, order: 0, pinned: false, bots: row.bots, openQuestions: row.openQuestions });
    expect(parsePhoneRoomThreadsReply(threads, threads.workspaceId)).toEqual(threads);
    expect(parsePhoneRoomCardsReply(cards, cards.workspaceId, cards.threadId as never)).toEqual(cards);
  });
});
