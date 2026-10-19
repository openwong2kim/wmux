// The Bots page's conversations, derived from the room, bot and fan-out
// stores: who belongs in a 1:1, live vs finished workers, the order (HQ
// first, then activity) and the needs-you count the rail badge shows.
import { describe, expect, it } from 'vitest';
import type { RoomCard, ThreadId } from '../../../../shared/room';
import type { BotProfile, BotRole } from '../../../../shared/bot';
import { DEFAULT_BOT_BUDGETS } from '../../../../shared/bot';
import type { FactoryBotRow } from '../../Room/factoryPorts';
import { timelineKey, ALL_THREADS } from '../../../stores/slices/roomSlice';
import type { BotGroup } from '../../../../shared/botGroup';
import {
  awaitsApproval, botConversationCards, botWorkScope, botWorkerTree, botWorkers, buildBots, botsNeedsYou, botsRooms, conversationCards, groupViewCards, isBotSystemCard,
  livePlanIds, openApprovalsBy, openQuestionsBy, roomCardsByWorkspace, roomViewCards, taskBubbles,
  type BotsInput,
} from '../botsModel';

const LEAD = 'bot-0000000a';
const VERIFIER = 'bot-0000000b';
const MOA = 'bot-0000000c';

function botRow(id: string, role: BotRole, workspaceId: string, createdAt: number, name = role): FactoryBotRow {
  const bot: BotProfile = {
    version: 1, id, workspaceId, role, name, engine: { kind: 'claude-sdk' }, triggers: [],
    budget: DEFAULT_BOT_BUDGETS[role], enabled: true, createdAt, updatedAt: createdAt,
  };
  return { bot, status: null };
}

let seq = 0;
function card(partial: Partial<RoomCard> & Pick<RoomCard, 'workspaceId' | 'actor'>): RoomCard {
  seq += 1;
  return { version: 1, id: `c${seq}`, seq, threadId: 'general', kind: 'status', at: 1000 + seq, title: `card ${seq}`, ...partial };
}
const bot = (workspaceId: string, botId: string) => ({ kind: 'bot' as const, workspaceId, botId });

const BOTS = [botRow(MOA, 'moa', 'hq', 1), botRow(LEAD, 'lead', 'w1', 2), botRow(VERIFIER, 'verifier', 'w1', 3)];
/** w1's room, made a group chat (it had the owner's messages): it lives in General. */
const W1_ROOM: BotGroup = { id: 'grp-000000a1', workspaceId: 'w1', name: '', memberIds: [LEAD, VERIFIER], threadId: 'general', createdAt: 0, updatedAt: 0 };
const W1 = 'group:grp-000000a1';

function input(over: Partial<BotsInput> = {}): BotsInput {
  return {
    bots: BOTS,
    cards: new Map(),
    threads: {},
    botTaskOf: {},
    workerClass: {},
    workspaceName: (id) => ({ hq: 'HQ', w1: 'api', t1: 'wtask: fix', t2: 'wtask: docs', t3: 'wtask: old' } as Record<string, string>)[id] ?? null,
    ...over,
  };
}

describe('conversationCards', () => {
  it('holds the bot\'s own cards, the owner\'s messages addressed to it and the system cards naming it', () => {
    const mine = card({ workspaceId: 'w1', actor: bot('w1', LEAD), title: 'lead says' });
    const toMe = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', refs: { botId: LEAD } });
    const toOther = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', refs: { botId: VERIFIER } });
    const unaddressed = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human' });
    const other = card({ workspaceId: 'w1', actor: bot('w1', VERIFIER) });
    const fact = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', refs: { botId: LEAD } });
    const otherFact = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'refusal', refs: { botId: VERIFIER } });
    const generalFact = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact' });
    expect(conversationCards([mine, toMe, toOther, unaddressed, other, fact, otherFact, generalFact], LEAD).map((c) => c.id))
      .toEqual([mine.id, toMe.id, fact.id]);
  });

  it('a system card about the bot\'s own work joins its 1:1: its PR\'s or task\'s thread, or its task by id', () => {
    const pr: ThreadId = 'pr:github.com/acme/api#1';
    const asked = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open', threadId: pr });
    const dispatch = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'dispatch', refs: { taskId: 'task-9' } });
    const refused = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'refusal', threadId: pr, title: 'Merge refused for #1', body: 'No required checks' });
    const gate = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', threadId: 'task:task-9', refs: { taskId: 'task-9' }, title: 'Task done: x', body: 'gate exit 0' });
    // The same PR's thread in a room the bot never wrote in, another task,
    // and General with no bot named: not its work.
    const elsewhere = card({ workspaceId: 'w2', actor: { kind: 'system' }, kind: 'refusal', threadId: pr });
    const otherTask = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', threadId: 'task:task-3', refs: { taskId: 'task-3' } });
    const general = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', title: 'CI green' });
    const all = [asked, dispatch, refused, gate, elsewhere, otherTask, general];
    expect(conversationCards(all, LEAD).map((c) => c.id)).toEqual([asked.id, dispatch.id, refused.id, gate.id]);
    // The verifier wrote nowhere: none of them is its.
    expect(conversationCards(all, VERIFIER)).toEqual([]);
    const scope = botWorkScope(all, LEAD);
    expect(isBotSystemCard(refused, LEAD, scope)).toBe(true);
    expect(isBotSystemCard(asked, LEAD, scope)).toBe(false);
  });

  it('an open copy does not count once its thread summary says nothing is open there', () => {
    const q = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open', threadId: 'task:t1' });
    const summary = (open: number) => ({ w1: [{ threadId: 'task:t1' as const, title: 't', lastAt: 1, lastSeq: q.seq, cardCount: 1, openQuestions: open, lastKind: 'question' as const, status: 'open' as const, unread: null }] });
    expect(openQuestionsBy([q], LEAD, summary(1))).toBe(1);
    expect(openQuestionsBy([q], LEAD, summary(0))).toBe(0);
    // No summary read yet: the card's own state answers.
    expect(openQuestionsBy([q], LEAD, {})).toBe(1);
  });

  it('counts only the bot\'s own open questions', () => {
    const cards = [
      card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open' }),
      card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'resolved' }),
      card({ workspaceId: 'w1', actor: bot('w1', VERIFIER), kind: 'question', state: 'open' }),
      card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'proposal', state: 'open' }),
    ];
    expect(openQuestionsBy(cards, LEAD)).toBe(1);
    expect(openQuestionsBy(cards, VERIFIER)).toBe(1);
  });
});

describe('botWorkers', () => {
  it('lists running and waiting workers of that bot; finished, idle, closed and other bots\' leave', () => {
    const owners = { t1: LEAD, t2: LEAD, t3: LEAD, t4: LEAD, t5: VERIFIER };
    const classes = { t1: 'running', t2: 'needsYou', t3: 'finished', t5: 'running', t6: 'running' } as const;
    const ws = botWorkers(LEAD, owners, classes, (id) => ({ t1: 'b-fix', t2: 'a-docs' } as Record<string, string>)[id] ?? null);
    expect(ws.map((w) => [w.workspaceId, w.cls, w.waiting])).toEqual([['t2', 'needsYou', true], ['t1', 'running', false]]);
    // An error waits on the owner too (Fleet counts it under Needs you).
    expect(botWorkers(LEAD, { t1: LEAD }, { t1: 'error' }, () => null)[0].waiting).toBe(true);
  });
});

describe('botWorkers from the bot\'s tasks', () => {
  const view = (taskId: string, taskWorkspaceId: string, stage: 'working' | 'needs_input' | 'coded' | 'closed', over: Record<string, unknown> = {}) => ({
    taskId, taskWorkspaceId, ownerWorkspaceId: 'w1', botId: LEAD, title: `task ${taskId}`, status: 'working' as const, stage, updatedAt: 1, ...over,
  });
  const names = (id: string) => (['t1', 't2', 't3', 't4', 't5'].includes(id) ? `wtask: ${id}` : null);

  it('a task at work or waiting on input is a live worker while its pane is open, whatever its pane\'s attention class', () => {
    const tasks = [
      view('a', 't1', 'needs_input'),
      view('b', 't2', 'working'),
      view('c', 't3', 'coded'),
      view('d', 'gone', 'working'),
      view('e', 't4', 'working', { workerWorkspaceId: 't5' }),
      view('f', 't4', 'working', { botId: VERIFIER }),
    ];
    // t1's stopped agent reads idle: the ledger still says it waits on input.
    const ws = botWorkers(LEAD, {}, { t1: 'idle', t2: 'running' }, names, tasks);
    expect(ws.map((w) => [w.workspaceId, w.name, w.waiting, !!w.needsInput, w.taskId])).toEqual([
      ['t1', 'task a', true, true, 'a'],
      ['t2', 'task b', false, false, 'b'],
      ['t5', 'task e', false, false, 'e'],
    ]);
  });

  it('the list\'s tree: live workers, then ended tasks whose workspace is open (newest first); a cleared one drops off', () => {
    const tasks = [
      view('a', 't1', 'working'),
      view('b', 't2', 'coded', { updatedAt: 5, worker: 'resumable' }),
      view('c', 't3', 'closed', { updatedAt: 9, stage: 'failed' }),
      view('d', 'gone', 'closed', { updatedAt: 10 }),
      view('e', 't4', 'closed', { botId: VERIFIER }),
    ];
    const live = botWorkers(LEAD, { t5: LEAD }, { t1: 'running', t5: 'error' }, names, tasks);
    const tree = botWorkerTree(LEAD, live, tasks, names);
    expect(tree.map((r) => [r.workspaceId, r.title, r.state, r.resumable])).toEqual([
      ['t1', 'task a', 'running', false],
      ['t5', 'wtask: t5', 'error', false],
      ['t3', 'task c', 'failed', false],
      ['t2', 'task b', 'review', true],
    ]);
  });

  it('Stop worker: only a live worker whose task is still open can be stopped, not a resumed worker of an ended task nor an ended row', () => {
    const tasks = [
      view('a', 't1', 'working'),
      view('b', 't2', 'needs_input'),
      view('c', 't3', 'closed', { status: 'completed', worker: 'resumed' }),
      view('d', 't4', 'coded', { status: 'review_requested', worker: 'resumable' }),
    ];
    const live = botWorkers(LEAD, { t5: LEAD }, { t1: 'running', t2: 'idle', t3: 'running', t5: 'running' }, names, tasks);
    const tree = botWorkerTree(LEAD, live, tasks, names, { t5: LEAD }, { t5: 'running' });
    expect(tree.map((r) => [r.workspaceId, r.state, !!r.stoppable])).toEqual([
      ['t1', 'running', true],
      ['t2', 'needsYou', true],
      ['t3', 'running', false],
      ['t5', 'running', false],
      ['t4', 'review', false],
    ]);
  });

  it('a task reported for review is open, not done: In review, with its worker paused once it was stopped', () => {
    const tasks = [
      view('a', 't1', 'coded', { status: 'review_requested', worker: 'resumable', updatedAt: 3 }),
      view('b', 't2', 'coded', { status: 'review_requested', updatedAt: 2 }),
      view('c', 't3', 'closed', { status: 'completed', stage: 'checked', worker: 'resumable', updatedAt: 1 }),
    ];
    const tree = botWorkerTree(LEAD, [], tasks, names);
    expect(tree.map((r) => [r.workspaceId, r.state, !!r.workerPaused])).toEqual([
      ['t1', 'review', true],
      ['t2', 'review', false],
      ['t3', 'done', false],
    ]);
  });

  it('an ended task whose folder was kept for uncommitted changes says so on its row while its workspace is open', () => {
    const tasks = [
      view('a', 't1', 'closed', { status: 'cancelled', stage: 'cancelled', folder: 'kept_dirty', updatedAt: 2 }),
      view('b', 't2', 'closed', { status: 'cancelled', stage: 'cancelled', updatedAt: 1 }),
    ];
    const tree = botWorkerTree(LEAD, [], tasks, names);
    expect(tree.map((r) => [r.workspaceId, r.state, !!r.folderKept])).toEqual([['t1', 'cancelled', true], ['t2', 'cancelled', false]]);
  });

  it('a task the owner stopped is cancelled, a neutral state with no error mark; a failed one stays failed', () => {
    const tasks = [
      view('a', 't1', 'closed', { updatedAt: 2, stage: 'cancelled', status: 'cancelled' }),
      view('b', 't2', 'closed', { updatedAt: 1, stage: 'failed', status: 'failed' }),
    ];
    const tree = botWorkerTree(LEAD, [], tasks, names);
    expect(tree.map((r) => [r.workspaceId, r.state])).toEqual([['t1', 'cancelled'], ['t2', 'failed']]);
  });

  it('a reported task\'s pane whose agent still reads running is in review, not a live worker (one state for row, panel and chat)', () => {
    const tasks = [view('a', 't1', 'coded', { status: 'review_requested' })];
    const live = botWorkers(LEAD, { t1: LEAD }, { t1: 'running' }, names, tasks);
    expect(live).toEqual([]);
    expect(botWorkerTree(LEAD, live, tasks, names).map((r) => [r.workspaceId, r.state])).toEqual([['t1', 'review']]);
  });

  it('every open workspace the bot\'s fan-out made is listed, even one whose task is older than the task list', () => {
    // t3's task is not in the bot's (newest-first, capped) task list; its worker failed and waits to be seen.
    const tree = botWorkerTree(LEAD, [], [], names, { t3: LEAD, t4: VERIFIER, gone: LEAD }, { t3: 'idle' });
    expect(tree.map((r) => [r.workspaceId, r.state])).toEqual([['t3', 'done']]);
    expect(botWorkerTree(LEAD, [], [], names, { t3: LEAD }, { t3: 'error' })[0].state).toBe('error');
  });

  it('a resumed worker of a reported task is live while its pane\'s agent runs, in review once it stops', () => {
    const tasks = [view('a', 't1', 'coded', { worker: 'resumed', workerWorkspaceId: 't2' })];
    expect(botWorkers(LEAD, {}, { t2: 'needsYou' }, names, tasks).map((w) => [w.workspaceId, w.waiting])).toEqual([['t2', true]]);
    const stopped = botWorkers(LEAD, {}, { t2: 'idle' }, names, tasks);
    expect(stopped).toEqual([]);
    expect(botWorkerTree(LEAD, stopped, tasks, names).map((r) => [r.workspaceId, r.state])).toEqual([['t2', 'review']]);
  });

  it('a task workspace already listed from its task is not listed again from its origin', () => {
    const ws = botWorkers(LEAD, { t1: LEAD, t2: LEAD }, { t1: 'running', t2: 'needsYou' }, names, [view('a', 't1', 'working')]);
    expect(ws.map((w) => [w.workspaceId, w.taskId ?? null])).toEqual([['t1', 'a'], ['t2', null]]);
  });

  it('a bot\'s row previews its newest message, never a system line about it, which still orders the list', () => {
    const said = card({ workspaceId: 'w1', actor: bot('w1', LEAD), title: 'Built it', at: 2000 });
    const relay = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', title: 'result → Lead: Built it', refs: { botId: LEAD }, at: 2100 });
    const row = buildBots(input({ cards: new Map([['w1', [said, relay]]]) })).conversations.find((c) => c.id === `bot:${LEAD}`)!;
    expect(row.last?.id).toBe(said.id);
    expect(row.lastAt).toBe(2100);
    // Only system lines: no preview yet.
    const quiet = buildBots(input({ cards: new Map([['w1', [relay]]]) })).conversations.find((c) => c.id === `bot:${LEAD}`)!;
    expect(quiet.last).toBeNull();
  });

  it('a waiting task counts on its bot\'s row, and a group lists its bots\' workers', () => {
    const lead = { ...BOTS[1], tasks: [view('a', 't1', 'needs_input')] };
    const m = buildBots(input({ bots: [BOTS[0], lead, BOTS[2]], groups: [W1_ROOM] }));
    const row = m.conversations.find((c) => c.id === `bot:${LEAD}`);
    expect(row?.needsYou).toBe(1);
    const room = m.conversations.find((c) => c.id === W1);
    expect(room?.kind === 'room' && room.workers.map((w) => w.workspaceId)).toEqual(['t1']);
    expect(room?.needsYou).toBe(0);
    // No workspace has a room by itself: only the groups the owner made.
    expect(m.conversations.filter((c) => c.kind === 'room').map((c) => c.id)).toEqual([W1]);
    expect(m.needsYou).toBe(1);
  });
});

describe('a 1:1 and the room are separate (owner decision 2026-10-15)', () => {
  const dm = (id: string) => `dm:${id}` as ThreadId;

  it('a team: the 1:1 is its dm thread and the threads it started; the room never shows them', () => {
    // From before 1:1 threads: the lead's room post and a 1:1 message stay in the lead's 1:1.
    const oldPost = card({ workspaceId: 'w1', actor: bot('w1', LEAD), title: 'old status', at: 100 });
    const oldDm = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', refs: { botId: LEAD }, title: 'old 1:1', at: 110 });
    // The lead's greeting and the owner's request, in its 1:1.
    const greet = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', threadId: dm(LEAD), greeting: true, state: 'open', at: 200 });
    const ask = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', threadId: dm(LEAD), refs: { botId: LEAD }, title: 'Add a flag', at: 210 });
    // The work it started: the opening hop links the request; a hop in it.
    const open = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', threadId: 'handoff:h-1' as ThreadId, refs: { handoffId: 'h-1', requestCardId: ask.id }, at: 220 });
    const hop = card({ workspaceId: 'w1', actor: bot('w1', VERIFIER), threadId: 'handoff:h-1' as ThreadId, at: 230 });
    const done = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', threadId: dm(LEAD), refs: { threadId: 'handoff:h-1' as ThreadId, handoffId: 'h-2' }, title: 'Finished: Add a flag', at: 240 });
    // A team greeting the lead posts in the room, after 1:1 threads exist.
    const roomPost = card({ workspaceId: 'w1', actor: bot('w1', LEAD), title: 'Team, hello', at: 300 });
    // The verifier's own 1:1.
    const vdm = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', threadId: dm(VERIFIER), refs: { botId: VERIFIER }, at: 310 });
    const all = [oldPost, oldDm, greet, ask, open, hop, done, roomPost, vdm];
    expect(conversationCards(all, LEAD).map((c) => c.id)).toEqual([oldPost, oldDm, greet, ask, open, hop, done].map((c) => c.id));
    expect(conversationCards(all, VERIFIER).map((c) => c.id)).toEqual([vdm.id]);
    expect(roomViewCards(all).map((c) => c.id)).toEqual([oldPost, oldDm, roomPost].map((c) => c.id));
    // A thread opened from a 1:1 is known by its opening hop alone (no owner message behind it).
    const own = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', threadId: 'handoff:h-9' as ThreadId, refs: { handoffId: 'h-9', threadId: dm(LEAD) }, at: 400 });
    expect(roomViewCards([...all, own]).map((c) => c.id)).not.toContain(own.id);
    expect(conversationCards([...all, own], LEAD).map((c) => c.id)).toContain(own.id);
    // A bot's card cannot move a thread into a 1:1; a PR thread an approval links stays the room's.
    const spoof = card({ workspaceId: 'w1', actor: bot('w1', VERIFIER), threadId: 'handoff:h-7' as ThreadId, refs: { threadId: dm(LEAD) }, at: 410 });
    const approval = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'approval', threadId: dm(LEAD), refs: { threadId: 'pr:github.com/a/b#1' as ThreadId }, at: 420 });
    const pr = card({ workspaceId: 'w1', actor: bot('w1', VERIFIER), threadId: 'pr:github.com/a/b#1' as ThreadId, at: 430 });
    expect(roomViewCards([...all, spoof, approval, pr]).map((c) => c.id)).toEqual([oldPost, oldDm, roomPost, spoof, pr].map((c) => c.id));
  });

  it('main\'s thread summaries keep the split when the page of cards misses the 1:1 or its opening hop', () => {
    // Only room activity is loaded, but the room has 1:1 threads since t=200.
    const before = card({ workspaceId: 'w1', actor: bot('w1', LEAD), title: 'old', at: 100 });
    const after = card({ workspaceId: 'w1', actor: bot('w1', LEAD), title: 'room post', at: 300 });
    // A hop of a request thread whose opening card is off the page.
    const hop = card({ workspaceId: 'w1', actor: bot('w1', VERIFIER), threadId: 'handoff:h-5' as ThreadId, at: 310 });
    const sum = (threadId: string, extra: Record<string, unknown>) => ({ threadId: threadId as ThreadId, title: 't', lastAt: 1, lastSeq: 1, cardCount: 1, openQuestions: 0, lastKind: 'status' as const, status: 'open' as const, unread: null, ...extra });
    const threads = { w1: [sum(dm(LEAD), { dmBotId: LEAD, firstAt: 200 }), sum('handoff:h-5', { dmBotId: LEAD })] };
    const all = [before, after, hop];
    expect(conversationCards(all, LEAD, { threads }).map((c) => c.id)).toEqual([before.id, hop.id]);
    expect(roomViewCards(all, threads).map((c) => c.id)).toEqual([before.id, after.id]);
    // Without them the page alone decides (no 1:1 read: all legacy).
    expect(conversationCards(all, LEAD).map((c) => c.id)).toEqual([before.id, after.id]);
  });

  it('a lone bot keeps everything it says in its 1:1, and the model has no room for it', () => {
    const post = card({ workspaceId: 'hq', actor: bot('hq', MOA), title: 'morning', at: 500 });
    const dmCard = card({ workspaceId: 'hq', actor: { kind: 'human' }, kind: 'human', threadId: dm(MOA), refs: { botId: MOA }, at: 400 });
    expect(conversationCards([dmCard, post], MOA, { lone: true }).map((c) => c.id)).toEqual([dmCard.id, post.id]);
    // As a team member the newer room post is the room's only.
    expect(conversationCards([dmCard, post], MOA).map((c) => c.id)).toEqual([dmCard.id]);
    const m = buildBots(input({ cards: new Map([['hq', [dmCard, post]]]) }));
    const row = m.conversations.find((c) => c.id === `bot:${MOA}`);
    expect(row?.kind === 'bot' && row.lone).toBe(true);
    expect(row?.last?.id).toBe(post.id);
    expect(m.conversations.some((c) => c.kind === 'room')).toBe(false);
  });

  it('a group in General reads the room\'s own cards and threads only: a 1:1 is neither its preview nor its time', () => {
    const roomMsg = card({ workspaceId: 'w1', actor: bot('w1', VERIFIER), title: 'room', at: 100 });
    const dmMsg = card({ workspaceId: 'w1', actor: bot('w1', LEAD), threadId: dm(LEAD), title: 'private', at: 900 });
    const threads = { w1: [
      { threadId: dm(LEAD), title: 'x', lastAt: 900, lastSeq: 2, cardCount: 1, openQuestions: 0, lastKind: 'status' as const, status: 'open' as const, unread: null },
    ] };
    const room = buildBots(input({ cards: new Map([['w1', [roomMsg, dmMsg]]]), threads, groups: [W1_ROOM] })).conversations.find((c) => c.id === W1)!;
    expect([room.last?.id, room.lastAt]).toEqual([roomMsg.id, 100]);
  });
});

describe('needs you: a waiting worker its bot already asked about counts once', () => {
  it('drops a needs-input worker whose task an open question names', () => {
    const view = (taskId: string, ws: string) => ({ taskId, taskWorkspaceId: ws, ownerWorkspaceId: 'w1', botId: LEAD, title: taskId, status: 'input_required' as const, stage: 'needs_input' as const, updatedAt: 1 });
    const lead = { ...BOTS[1], tasks: [view('wtask-a', 't1'), view('wtask-b', 't2')] };
    const asks = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open', threadId: 'task:wtask-a' as ThreadId, refs: { taskId: 'wtask-a' } });
    const m = buildBots(input({ bots: [BOTS[0], lead, BOTS[2]], cards: new Map([['w1', [asks]]]) }));
    // One question (about wtask-a) + one worker not asked about (wtask-b).
    expect(m.conversations.find((c) => c.id === `bot:${LEAD}`)?.needsYou).toBe(2);
    // Once the question is answered, both workers count.
    const answered = { ...asks, state: 'resolved' as const };
    expect(buildBots(input({ bots: [BOTS[0], lead, BOTS[2]], cards: new Map([['w1', [answered]]]) })).conversations.find((c) => c.id === `bot:${LEAD}`)?.needsYou).toBe(2);
  });
});

describe('group chats the owner made (owner decision 2026-10-15)', () => {
  const G = 'group:grp-000000c1' as ThreadId;
  const SHIP: BotGroup = { id: 'grp-000000c1', workspaceId: 'w1', name: 'Ship it', memberIds: [LEAD, VERIFIER], threadId: G, createdAt: 3_000, updatedAt: 3_000 };

  it('a group shows its thread and the threads it started; General and the 1:1s never show them', () => {
    const ask = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', threadId: G, refs: { botIds: [LEAD, VERIFIER] }, at: 3_100 });
    const intro = card({ workspaceId: 'w1', actor: bot('w1', LEAD), threadId: G, title: 'I am Lead', at: 3_110 });
    // The lead's request thread, opened from the group (main's opening hop links it), and a hop in it.
    const open = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', threadId: 'handoff:h-1' as ThreadId, refs: { handoffId: 'h-1', requestCardId: ask.id }, at: 3_120 });
    const hop = card({ workspaceId: 'w1', actor: bot('w1', VERIFIER), threadId: 'handoff:h-1' as ThreadId, at: 3_130 });
    const done = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', threadId: G, refs: { threadId: 'handoff:h-1' as ThreadId }, title: 'Finished: x', at: 3_140 });
    const general = card({ workspaceId: 'w1', actor: bot('w1', VERIFIER), title: 'General talk', at: 3_150 });
    const dmCard = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', threadId: `dm:${LEAD}` as ThreadId, refs: { botId: LEAD }, at: 3_160 });
    // A bot's card cannot pull a thread into a group.
    const spoof = card({ workspaceId: 'w1', actor: bot('w1', VERIFIER), threadId: 'handoff:h-7' as ThreadId, refs: { threadId: G }, at: 3_170 });
    const all = [ask, intro, open, hop, done, general, dmCard, spoof];
    expect(groupViewCards(all, SHIP).map((c) => c.id)).toEqual([ask, intro, open, hop, done].map((c) => c.id));
    expect(groupViewCards(all, W1_ROOM).map((c) => c.id)).toEqual([general, spoof].map((c) => c.id));
    expect(roomViewCards(all).map((c) => c.id)).toEqual([general, spoof].map((c) => c.id));
    expect(conversationCards(all, LEAD).map((c) => c.id)).toEqual([dmCard.id]);
    // Main's summaries keep the link when the opening hop is off the page.
    const sum = { threadId: 'handoff:h-1' as ThreadId, title: 't', lastAt: 1, lastSeq: 1, cardCount: 1, openQuestions: 0, lastKind: 'status' as const, status: 'open' as const, unread: null, groupId: 'grp-000000c1' };
    expect(groupViewCards([hop], SHIP, { w1: [sum] }).map((c) => c.id)).toEqual([hop.id]);
    expect(groupViewCards([hop], W1_ROOM, { w1: [sum] })).toEqual([]);
  });

  it('a group shows no greeting (its bot\'s 1:1 keeps it)', () => {
    const greet = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open', greeting: true, at: 10 });
    const said = card({ workspaceId: 'w1', actor: bot('w1', LEAD), at: 20 });
    expect(groupViewCards([greet, said], W1_ROOM).map((c) => c.id)).toEqual([said.id]);
    expect(conversationCards([greet, said], LEAD).map((c) => c.id)).toContain(greet.id);
  });

  it('a group row is named by the owner and sorted by its newest card, else by when it was made; its bots are its members', () => {
    const m = buildBots(input({ groups: [SHIP], bots: [...BOTS, botRow('bot-0000000d', 'triage', 'w1', 4)] }));
    const row = m.conversations.find((c) => c.id === 'group:grp-000000c1');
    expect(row?.kind === 'room' && [row.group.name, row.threadId, row.lastAt]).toEqual(['Ship it', G, 3_000]);
    expect(row?.kind === 'room' && row.bots.map((b) => b.bot.id)).toEqual([LEAD, VERIFIER]);
    // A team with no group in General: each 1:1 shows what its bot says in General.
    expect(m.conversations.find((c) => c.id === `bot:${LEAD}`)?.kind === 'bot' && (m.conversations.find((c) => c.id === `bot:${LEAD}`) as { lone: boolean }).lone).toBe(true);
    const withRoom = buildBots(input({ groups: [SHIP, W1_ROOM] }));
    expect((withRoom.conversations.find((c) => c.id === `bot:${LEAD}`) as { lone: boolean }).lone).toBe(false);
  });

  it('a question a bot asks in a group needs the owner on that bot\'s row, counted once', () => {
    const q = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open', threadId: G, at: 3_200 });
    const m = buildBots(input({ groups: [SHIP, W1_ROOM], cards: new Map([['w1', [q]]]) }));
    expect(m.conversations.find((c) => c.id === `bot:${LEAD}`)?.needsYou).toBe(1);
    expect(m.conversations.find((c) => c.id === 'group:grp-000000c1')?.needsYou).toBe(0);
    expect(m.needsYou).toBe(1);
  });

  it('a bot row whose question is only in a group\'s handoff thread leads there, and previews its group post', () => {
    const ask = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', threadId: G, refs: { botIds: [LEAD] }, at: 3_100 });
    const open = card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'fact', threadId: 'handoff:h-1' as ThreadId, refs: { handoffId: 'h-1', requestCardId: ask.id }, at: 3_120 });
    const q = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open', threadId: 'handoff:h-1' as ThreadId, title: 'Which branch?', at: 3_200 });
    const m = buildBots(input({ groups: [SHIP], cards: new Map([['w1', [ask, open, q]]]) }));
    const lead = m.conversations.find((c) => c.id === `bot:${LEAD}`);
    expect(lead?.kind === 'bot' && lead.last).toBeNull();
    expect(lead?.kind === 'bot' && lead.needsAt).toEqual({ conversationId: 'group:grp-000000c1', workspaceId: 'w1', threadId: 'handoff:h-1' });
    expect(lead?.kind === 'bot' && lead.elsewhere).toEqual({ card: q, conversationId: 'group:grp-000000c1' });
    // Something it waits on in its 1:1 keeps the row there.
    const dmQ = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open', threadId: `dm:${LEAD}` as ThreadId, at: 3_300 });
    const both = buildBots(input({ groups: [SHIP], cards: new Map([['w1', [ask, open, q, dmQ]]]) })).conversations.find((c) => c.id === `bot:${LEAD}`);
    expect(both?.kind === 'bot' && both.needsAt).toBeUndefined();
    expect(both?.kind === 'bot' && both.elsewhere).toBeUndefined();
    expect(both?.needsYou).toBe(2);
  });
});

describe('buildBots', () => {
  it('orders groups and bots by latest activity; nothing is pinned; no workspace has a room by itself', () => {
    const cards = new Map<string, RoomCard[]>([
      ['hq', [card({ workspaceId: 'hq', actor: bot('hq', MOA), at: 100 })]],
      ['w1', [
        card({ workspaceId: 'w1', actor: bot('w1', VERIFIER), at: 500 }),
        card({ workspaceId: 'w1', actor: bot('w1', LEAD), at: 900 }),
      ]],
    ]);
    const m = buildBots(input({ cards, groups: [W1_ROOM] }));
    expect(m.conversations.map((c) => c.id)).toEqual([
      `bot:${LEAD}`, // 900 — ties break by id
      W1, // 900
      `bot:${VERIFIER}`, // 500
      `bot:${MOA}`, // 100
    ]);
    expect(buildBots(input({ cards })).conversations.some((c) => c.kind === 'room')).toBe(false);
    const room = m.conversations.find((c) => c.id === W1);
    expect(room?.kind === 'room' && room.bots.map((b) => b.bot.id)).toEqual([LEAD, VERIFIER]);
  });

  it('a bot with no message yet sorts by its creation; a team gets no room row by itself', () => {
    const m = buildBots(input({ bots: [botRow(LEAD, 'lead', 'w1', 5000)] }));
    expect(m.conversations.map((c) => [c.id, c.lastAt])).toEqual([[`bot:${LEAD}`, 5000]]);
    const team = buildBots(input({ bots: [botRow(LEAD, 'lead', 'w1', 5000), botRow(VERIFIER, 'verifier', 'w1', 6000)] }));
    expect(team.conversations.map((c) => [c.id, c.lastAt])).toEqual([[`bot:${VERIFIER}`, 6000], [`bot:${LEAD}`, 5000]]);
  });

  it('needs you: a bot\'s open questions plus its waiting workers; the badge sums the 1:1 rows only', () => {
    const cards = new Map<string, RoomCard[]>([['w1', [
      card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open' }),
      card({ workspaceId: 'w1', actor: bot('w1', VERIFIER), kind: 'question', state: 'open' }),
      card({ workspaceId: 'w1', actor: bot('w1', VERIFIER), kind: 'question', state: 'resolved' }),
    ]]]);
    const m = buildBots(input({
      cards,
      groups: [W1_ROOM],
      botTaskOf: { t1: LEAD, t2: LEAD },
      workerClass: { t1: 'needsYou', t2: 'running' },
    }));
    const row = (id: string) => m.conversations.find((c) => c.id === id);
    expect(row(`bot:${LEAD}`)?.needsYou).toBe(2);
    expect(row(`bot:${VERIFIER}`)?.needsYou).toBe(1);
    expect(row(W1)?.needsYou).toBe(0);
    expect(m.needsYou).toBe(3);
    expect(botsNeedsYou(m.conversations)).toBe(m.needsYou);
  });

  it('needs you counts the live plan and open proposals too; the badge is still the sum of the rows', () => {
    const cards = new Map<string, RoomCard[]>([
      ['hq', [
        card({ workspaceId: 'hq', actor: bot('hq', MOA), kind: 'plan', state: 'open', threadId: 'plan:p-old', at: 10 }),
        card({ workspaceId: 'hq', actor: bot('hq', MOA), kind: 'plan', state: 'open', threadId: 'plan:p-new', at: 20 }),
      ]],
      ['w1', [
        card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'proposal', state: 'open' }),
        card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'proposal', state: 'resolved' }),
        card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open' }),
        // A system-written proposal never waits on the owner's answer.
        card({ workspaceId: 'w1', actor: { kind: 'system' }, kind: 'proposal', state: 'open' }),
      ]],
    ]);
    const m = buildBots(input({ cards }));
    const row = (id: string) => m.conversations.find((c) => c.id === id);
    // Moa: only its newest plan waits (the older open one is superseded).
    expect(row(`bot:${MOA}`)?.needsYou).toBe(1);
    expect(row(`bot:${LEAD}`)?.needsYou).toBe(2);
    expect(m.needsYou).toBe(3);
    expect(botsNeedsYou(m.conversations)).toBe(m.needsYou);
    // Answered, the plan no longer counts.
    const answered = new Map(cards);
    answered.set('hq', cards.get('hq')!.map((c) => (c.threadId === 'plan:p-new' ? { ...c, state: 'resolved' as const } : c)));
    expect(buildBots(input({ cards: answered })).conversations.find((c) => c.id === `bot:${MOA}`)?.needsYou).toBe(0);
  });

  it('livePlanIds / awaitsApproval: each bot\'s newest plan when open, and open bot proposals', () => {
    const old = card({ workspaceId: 'hq', actor: bot('hq', MOA), kind: 'plan', state: 'open', at: 10 });
    const fresh = card({ workspaceId: 'hq', actor: bot('hq', MOA), kind: 'plan', state: 'open', at: 20 });
    const live = livePlanIds([fresh, old]);
    expect([...live]).toEqual([fresh.id]);
    expect(awaitsApproval(fresh, live)).toBe(true);
    expect(awaitsApproval(old, live)).toBe(false);
    const prop = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'proposal', state: 'open' });
    expect(awaitsApproval(prop, live)).toBe(true);
    expect(awaitsApproval({ ...prop, state: 'resolved' }, live)).toBe(false);
    expect(openApprovalsBy([old, fresh, prop], MOA)).toBe(1);
    expect(openApprovalsBy([old, fresh, prop], LEAD)).toBe(1);
  });

  it('read-only (bots paused): the rows are kept, nothing is counted', () => {
    const cards = new Map<string, RoomCard[]>([['w1', [card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open' })]]]);
    const m = buildBots(input({ cards, readOnly: true, botTaskOf: { t1: LEAD }, workerClass: { t1: 'needsYou' } }));
    const lead = m.conversations.find((c) => c.id === `bot:${LEAD}`);
    expect(lead?.kind === 'bot' && lead.workers.length).toBe(1);
    expect(lead?.needsYou).toBe(0);
    expect(m.needsYou).toBe(0);
  });

  it('a 1:1 spans rooms: a message to Moa posted in a workspace room is in Moa\'s conversation', () => {
    const hello = card({ workspaceId: 'hq', actor: bot('hq', MOA), at: 10 });
    const fromW1 = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', refs: { botId: MOA }, at: 20, title: 'to moa from api' });
    const m = buildBots(input({ cards: new Map([['hq', [hello]], ['w1', [fromW1]]]) }));
    const moa = m.conversations.find((c) => c.id === `bot:${MOA}`);
    expect(moa?.last?.id).toBe(fromW1.id);
    expect(botConversationCards(new Map([['hq', [hello]], ['w1', [fromW1]]]), MOA).map((c) => c.id)).toEqual([hello.id, fromW1.id]);
  });

  it('botsRooms: each bot workspace once; with no bot there is no room (no pre-made HQ)', () => {
    expect(botsRooms(BOTS)).toEqual(['hq', 'w1']);
    expect(botsRooms([])).toEqual([]);
    expect(buildBots(input({ bots: [] })).conversations).toEqual([]);
  });
});

describe('a deleted bot\'s 1:1', () => {
  const GONE = 'bot-0000000d';
  const SILENT = 'bot-0000000e';
  it('stays as a read-only row below every live conversation, when it holds messages', () => {
    const asked = card({ workspaceId: 'w1', actor: { kind: 'human' }, kind: 'human', threadId: `dm:${GONE}`, refs: { botId: GONE }, at: 9_000 });
    const answer = card({ workspaceId: 'w1', actor: bot('w1', GONE), threadId: `dm:${GONE}`, at: 9_001 });
    const m = buildBots(input({
      cards: new Map([['w1', [asked, answer]]]),
      removed: [
        { id: GONE, workspaceId: 'w1', name: 'Old', role: 'lead', hue: 2 },
        { id: SILENT, workspaceId: 'w1', name: 'Silent', role: 'lead' },
      ],
    }));
    const ids = m.conversations.map((c) => c.id);
    // Newest message of all, yet last; a deleted bot that never spoke has no row.
    expect(ids.at(-1)).toBe(`bot:${GONE}`);
    expect(ids).not.toContain(`bot:${SILENT}`);
    const gone = m.conversations.at(-1);
    expect(gone).toMatchObject({ kind: 'bot', removed: true, needsYou: 0, tree: [], row: { bot: { id: GONE, name: 'Old', hue: 2, enabled: false } } });
    expect(gone?.last?.id).toBe(answer.id);
  });

  it('a live bot is never shown as deleted', () => {
    const m = buildBots(input({ removed: [{ id: LEAD, workspaceId: 'w1', name: 'lead', role: 'lead' }] }));
    expect(m.conversations.filter((c) => c.id === `bot:${LEAD}`)).toHaveLength(1);
    expect(m.conversations.some((c) => c.kind === 'bot' && c.removed)).toBe(false);
  });
});

describe('roomCardsByWorkspace', () => {
  it('merges the whole-room and thread timelines by id in seq order; an answer is never undone by an older copy', () => {
    const thread: ThreadId = 'task:t1';
    const q = card({ workspaceId: 'w1', actor: bot('w1', LEAD), kind: 'question', state: 'open', threadId: thread });
    const answered = { ...q, state: 'resolved' as const };
    const later = card({ workspaceId: 'w1', actor: bot('w1', LEAD) });
    const timelines = {
      [timelineKey('w1', ALL_THREADS)]: { cards: [answered, later], nextSinceSeq: later.seq, hasMore: false },
      [timelineKey('w1', thread)]: { cards: [q], nextSinceSeq: q.seq, hasMore: false },
      [timelineKey('hq', ALL_THREADS)]: { cards: [], nextSinceSeq: 0, hasMore: false },
    };
    const byWs = roomCardsByWorkspace(timelines);
    expect(byWs.get('w1')?.map((c) => [c.id, c.state])).toEqual([[q.id, 'resolved'], [later.id, undefined]]);
    expect(byWs.get('hq')).toEqual([]);
  });
});

describe('taskBubbles', () => {
  const view = (taskId: string, over: Partial<import('../../../../shared/botTask').BotTaskView>) => ({
    taskId, taskWorkspaceId: `${taskId}-ws`, ownerWorkspaceId: 'ws-1', botId: LEAD, title: taskId, status: 'completed' as const, stage: 'checked' as const, updatedAt: 1_000, ...over,
  });
  it('lists every worker waiting for a slot, then the three newest resumable workers of the last day', () => {
    const now = 100_000_000;
    const tasks = [
      view('old', { worker: 'resumable', updatedAt: now - 25 * 3_600_000 }),
      view('r1', { worker: 'resumable', updatedAt: now - 4 }),
      view('r2', { worker: 'resumable', updatedAt: now - 3 }),
      view('r3', { worker: 'resumable', updatedAt: now - 2 }),
      view('r4', { worker: 'resumable', updatedAt: now - 1 }),
      view('stopped', { worker: 'stopped', updatedAt: now }),
      view('live', { status: 'working', stage: 'working', updatedAt: now }),
      view('wait', { status: 'working', stage: 'waiting_slot', taskWorkspaceId: '', updatedAt: now }),
    ];
    expect(taskBubbles(tasks, now).map((t) => t.taskId)).toEqual(['wait', 'r4', 'r3', 'r2']);
    expect(taskBubbles(undefined, now)).toEqual([]);
  });

  it('also lists an ended task whose folder was kept for uncommitted changes, though its worker cannot resume', () => {
    const now = 100_000_000;
    const tasks = [view('kept', { worker: 'stopped', folder: 'kept_dirty', updatedAt: now - 1 }), view('plain', { worker: 'stopped', updatedAt: now })];
    expect(taskBubbles(tasks, now).map((t) => t.taskId)).toEqual(['kept']);
  });
});
