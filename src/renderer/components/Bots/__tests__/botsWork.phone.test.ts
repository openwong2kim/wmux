// The phone's work cards (shared/phoneBots.ts phoneConversationWork) read
// a conversation as the desktop's Bots page does: the same started
// threads, folded cards, delegate, state, title and newest message as the
// work card BotsChat draws, under the message that announced the hand-off.
import { describe, expect, it } from 'vitest';
import type { RoomCard, ThreadId } from '../../../../shared/room';
import type { BotTaskView } from '../../../../shared/botTask';
import { DEFAULT_BOT_BUDGETS, type BotProfile } from '../../../../shared/bot';
import * as shared from '../../../../shared/botsWork';
import { fitPhoneBots, parsePhoneBotsReply, phoneConversationWork, phoneWorkState, PHONE_BOTS_LIMITS, type PhoneBotsConversation, type PhoneBotsWork } from '../../../../shared/phoneBots';
import { livePlanIds, type Conversation } from '../botsModel';
import { buildTimeline, splitThreads, type TimelineItem } from '../botsTimeline';
import { conversationStartedThreads, workView, type WorkState } from '../botsWork';
import * as renderer from '../botsWork';
import { waitsOnOwner } from '../BotsChat';

const LEAD = 'bot-0000000a';
const DEV = 'bot-0000000b';
const DM = `dm:${LEAD}` as ThreadId;
const H1 = 'handoff:h-1' as ThreadId;
const H2 = 'handoff:h-2' as ThreadId;

let seq = 0;
function card(p: Partial<RoomCard> = {}): RoomCard {
  seq += 1;
  return { version: 1, id: `c${seq}`, seq, workspaceId: 'w1', threadId: DM, kind: 'opinion', at: 1_000 + seq * 1_000, actor: { kind: 'bot', workspaceId: 'w1', botId: LEAD }, title: `card ${seq}`, ...p };
}
const by = (botId: string) => ({ kind: 'bot' as const, workspaceId: 'w1', botId });
const SYS = { kind: 'system' as const };

function leadConversation(): Conversation {
  const bot: BotProfile = {
    version: 1, id: LEAD, workspaceId: 'w1', role: 'lead', name: 'Lead', engine: { kind: 'claude-sdk' }, triggers: [],
    budget: DEFAULT_BOT_BUDGETS.lead, enabled: true, createdAt: 1, updatedAt: 1,
  };
  return { kind: 'bot', id: `bot:${LEAD}`, workspaceId: 'w1', row: { bot, status: null }, last: null, lastAt: 0, needsYou: 0, openQuestions: 0, openApprovals: 0, workers: [], tree: [], lone: false };
}

/** The owner asks the lead twice; it hands each to Dev in a thread of its own. */
function scenario() {
  const ask = card({ actor: { kind: 'human' }, kind: 'human', title: 'Add a --json flag' });
  const hop = card({ threadId: H1, actor: SYS, kind: 'fact', title: 'dispatch → Dev: Add a --json flag', refs: { handoffId: 'h-1', botId: DEV, threadId: DM, requestCardId: ask.id } });
  const reply = card({ title: 'On it — handing this to Dev.' });
  const devSays = card({ threadId: H1, actor: by(DEV), title: 'Started on the flag', refs: { taskId: 't1' } });
  const devLast = card({ threadId: H1, actor: by(DEV), title: 'Opened https://github.com/acme/api/pull/12' });
  const ask2 = card({ actor: { kind: 'human' }, kind: 'human', title: 'And the docs' });
  const hop2 = card({ threadId: H2, actor: SYS, kind: 'fact', title: 'dispatch → Dev: Fix the docs', refs: { handoffId: 'h-2', botId: DEV, threadId: DM, requestCardId: ask2.id } });
  const question = card({ threadId: H2, actor: by(DEV), kind: 'question', state: 'open', title: 'Which page?' });
  const cards = [ask, hop, reply, devSays, devLast, ask2, hop2, question];
  return { cards, ask, hop, reply, devSays, devLast, ask2, hop2, question };
}

/** The desktop's work cards for a 1:1, as BotsChat derives and draws them. */
function desktopWork(cards: readonly RoomCard[], tasks: readonly BotTaskView[]) {
  const livePlans = livePlanIds(cards);
  const waits = (c: RoomCard) => waitsOnOwner(c, livePlans);
  const started = conversationStartedThreads(leadConversation(), cards);
  const { main, threads, surfaced, work } = splitThreads(cards, waits, started);
  const items = buildTimeline(main.map((c) => ({ kind: 'card' as const, card: c })), { waits, threads, surfaced, work, workAuthor: LEAD });
  return items.flatMap((item, i) => {
    if (item.kind !== 'work') return [];
    // The conversation's own card it follows.
    const above = items.slice(0, i).reverse().find((x): x is Extract<TimelineItem, { kind: 'message' }> => x.kind === 'message' && x.card.threadId === DM);
    return [{ item, root: above?.card.id, view: workView(item.work, { delegatorId: item.delegatorId, waits, tasks }) }];
  });
}

describe('phoneConversationWork', () => {
  it('reads each started thread as the desktop\'s work card', () => {
    const s = scenario();
    const tasks: BotTaskView[] = [{ taskId: 't1', taskWorkspaceId: 'tw', ownerWorkspaceId: 'w1', botId: LEAD, title: 'flag', status: 'review_requested', stage: 'coded', updatedAt: 1 }];
    const desktop = desktopWork(s.cards, tasks);
    const phone = phoneConversationWork({ owner: { botId: LEAD }, cards: s.cards, threads: {}, workAuthor: LEAD, tasks });
    expect(desktop).toHaveLength(2);
    const want = desktop.map(({ item, root, view }): PhoneBotsWork => ({
      threadId: item.work.threadId,
      rootCardId: root ?? '',
      ...(view.delegateId ? { delegateBotId: view.delegateId } : {}),
      state: phoneWorkState(view.state),
      title: view.title ?? '',
      ...(view.latest ? { latestCardId: view.latest.id, latestPreview: view.latest.title } : {}),
      steps: item.work.steps.length,
      lastAt: view.lastAt,
      ...(view.refUrl ? { refUrl: view.refUrl } : {}),
    })).sort((a, b) => b.lastAt - a.lastAt);
    expect(phone).toEqual(want);
    // The hand-off sits under the lead's announcing reply; the second, with
    // no announcement, under the owner's request before it.
    expect(phone.find((w) => w.threadId === H1)).toMatchObject({
      rootCardId: s.reply.id, delegateBotId: DEV, state: 'review', title: 'Add a --json flag',
      latestCardId: s.devLast.id, steps: 3, refUrl: 'https://github.com/acme/api/pull/12',
    });
    expect(phone.find((w) => w.threadId === H2)).toMatchObject({ rootCardId: s.ask2.id, state: 'waiting_on_you', title: 'Fix the docs', steps: 1 });
    // Newest first, and the reply parses to itself.
    expect(phone.map((w) => w.threadId)).toEqual([H2, H1]);
    const conversation = {
      kind: 'dm', threadId: DM, workspaceId: 'w1', name: 'Lead', botId: LEAD, memberBotIds: [LEAD], lastAt: 1, lastSeq: 1, unread: null, openQuestions: 0, work: phone,
    } as unknown as PhoneBotsConversation;
    expect(parsePhoneBotsReply({ factoryEnabled: true, bots: [], conversations: [conversation] })?.conversations[0].work).toEqual(phone);
  });

  it('is empty for a conversation that started no thread', () => {
    const s = scenario();
    expect(phoneConversationWork({ owner: { botId: DEV }, cards: s.cards, threads: {}, workAuthor: DEV })).toEqual([]);
    expect(phoneConversationWork({ owner: { threadId: 'group:grp-000000a1' as ThreadId }, cards: s.cards, threads: {} })).toEqual([]);
  });

  it('keeps the newest work cards only', () => {
    const cards: RoomCard[] = [];
    for (let i = 0; i < PHONE_BOTS_LIMITS.work + 5; i++) {
      cards.push(card({ threadId: `handoff:n-${i}` as ThreadId, actor: SYS, kind: 'fact', title: `dispatch → Dev: job ${i}`, refs: { handoffId: `n-${i}`, botId: DEV, threadId: DM } }));
    }
    const phone = phoneConversationWork({ owner: { botId: LEAD }, cards, threads: {}, workAuthor: LEAD });
    expect(phone).toHaveLength(PHONE_BOTS_LIMITS.work);
    expect(phone[0].title).toBe(`job ${PHONE_BOTS_LIMITS.work + 4}`);
  });
});

describe('the shared derivation', () => {
  it('is the one the desktop uses', () => {
    expect(renderer.workView).toBe(shared.workView);
    expect(renderer.workState).toBe(shared.workState);
    expect(splitThreads).toBe(shared.splitThreads);
    expect(livePlanIds).toBe(shared.livePlanIds);
  });

  it('waits on the owner for the same cards as the desktop', () => {
    const plan = card({ kind: 'plan', state: 'open' });
    const live = livePlanIds([plan]);
    const samples: RoomCard[] = [
      plan, card({ kind: 'question', state: 'open' }), card({ kind: 'question', state: 'resolved' }), card({ kind: 'proposal', state: 'open' }),
      card({ kind: 'approval', state: 'open' }), card({ kind: 'secret_request', state: 'open' }), card({ kind: 'login_request', state: 'open' }),
      card({ kind: 'plan', state: 'open', id: 'old-plan' }), card({ kind: 'status' }), card({ kind: 'approval', state: 'open', actor: SYS }),
    ];
    for (const c of samples) expect(shared.waitsOnOwner(c, live), `${c.kind}/${c.id}`).toBe(waitsOnOwner(c, live));
  });
});

describe('phoneWorkState', () => {
  it('maps every desktop state to the phone\'s', () => {
    const all: Record<WorkState, string> = { working: 'working', review: 'review', needsYou: 'waiting_on_you', done: 'done', failed: 'failed', cancelled: 'stopped' };
    for (const [state, phone] of Object.entries(all)) expect(phoneWorkState(state as WorkState)).toBe(phone);
  });
});

describe('fitPhoneBots with work', () => {
  it('never drops a conversation for its work, and gives back what fits, newest first', () => {
    const work = (n: number): PhoneBotsWork[] => Array.from({ length: n }, (_, i) => ({
      threadId: `handoff:w-${i}` as ThreadId, rootCardId: `c-${i}`, state: 'working', title: 'x'.repeat(200), latestCardId: `l-${i}`, latestPreview: 'y'.repeat(200), steps: 3, lastAt: 1000 - i,
    }));
    const conversations = Array.from({ length: 60 }, (_, i): PhoneBotsConversation => ({
      kind: 'dm', threadId: `dm:bot-${String(i).padStart(8, '0')}` as ThreadId, workspaceId: 'w1', name: `Bot ${i}`, botId: `bot-${String(i).padStart(8, '0')}`,
      memberBotIds: [`bot-${String(i).padStart(8, '0')}`], lastAt: 10_000 - i, lastSeq: 1, unread: null, openQuestions: 0, work: work(PHONE_BOTS_LIMITS.work),
    }));
    const bare = fitPhoneBots({ factoryEnabled: true, bots: [], conversations: conversations.map((c) => ({ ...c, work: undefined })) });
    const fitted = fitPhoneBots({ factoryEnabled: true, bots: [], conversations });
    expect(fitted.conversations).toHaveLength(bare.conversations.length);
    expect(new TextEncoder().encode(JSON.stringify(fitted)).length).toBeLessThanOrEqual(PHONE_BOTS_LIMITS.replyBytes);
    expect(fitted.conversations[0].work).toHaveLength(PHONE_BOTS_LIMITS.work);
    const last = fitted.conversations[fitted.conversations.length - 1];
    expect(last.work).toBeUndefined();
    // A list that fits keeps its work whole.
    const small = fitPhoneBots({ factoryEnabled: true, bots: [], conversations: conversations.slice(0, 2) });
    expect(small.conversations.map((c) => c.work?.length)).toEqual([PHONE_BOTS_LIMITS.work, PHONE_BOTS_LIMITS.work]);
  });
});
