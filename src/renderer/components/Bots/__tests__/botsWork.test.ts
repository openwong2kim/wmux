// Work a conversation handed off (owner decision 2026-10-16): the threads a
// 1:1 or a group chat started fold into one work card at the root's
// position — which cards fold, which stay, the card's state, the delegate's
// newest message, its title and its step count.
import { describe, expect, it } from 'vitest';
import type { RoomCard, ThreadId } from '../../../../shared/room';
import type { BotTaskView } from '../../../../shared/botTask';
import type { BotProfile } from '../../../../shared/bot';
import { DEFAULT_BOT_BUDGETS } from '../../../../shared/bot';
import type { BotGroup } from '../../../../shared/botGroup';
import type { Conversation } from '../botsModel';
import { buildTimeline, splitThreads, threadKey } from '../botsTimeline';
import { conversationStartedThreads, workDelegate, workLatest, workState, workTitle, workView, type WorkThread } from '../botsWork';

const LEAD = 'bot-0000000a';
const DEV = 'bot-0000000b';
const REVIEWER = 'bot-0000000c';
const DM = `dm:${LEAD}` as ThreadId;
const H1 = 'handoff:h-1' as ThreadId;
const H2 = 'handoff:h-2' as ThreadId;
const PR = 'pr:github.com/acme/api#12' as ThreadId;

let seq = 0;
function card(p: Partial<RoomCard> = {}): RoomCard {
  seq += 1;
  return { version: 1, id: `c${seq}`, seq, workspaceId: 'w1', threadId: DM, kind: 'opinion', at: 1_000 + seq * 1_000, actor: { kind: 'bot', workspaceId: 'w1', botId: LEAD }, title: `card ${seq}`, ...p };
}
const by = (botId: string) => ({ kind: 'bot' as const, workspaceId: 'w1', botId });
const SYS = { kind: 'system' as const };
const never = () => false;

function leadConversation(): Conversation {
  const bot: BotProfile = {
    version: 1, id: LEAD, workspaceId: 'w1', role: 'lead', name: 'Lead', engine: { kind: 'claude-sdk' }, triggers: [],
    budget: DEFAULT_BOT_BUDGETS.lead, enabled: true, createdAt: 1, updatedAt: 1,
  };
  return { kind: 'bot', id: `bot:${LEAD}`, workspaceId: 'w1', row: { bot, status: null }, last: null, lastAt: 0, needsYou: 0, openQuestions: 0, openApprovals: 0, workers: [], tree: [], lone: false };
}

function task(taskId: string, stage: BotTaskView['stage'], updatedAt = 1): BotTaskView {
  return { taskId, taskWorkspaceId: `t-${taskId}`, ownerWorkspaceId: 'w1', botId: DEV, title: taskId, status: 'working', stage, updatedAt };
}

/** A coordinator's 1:1: the owner asks, the lead answers and hands the work
 *  to Dev in its own thread, whose cards and pointer are the flood. */
function scenario() {
  const ask = card({ actor: { kind: 'human' }, kind: 'human', title: 'Add a --json flag\nwith tests' });
  const reply = card({ title: 'On it — handing this to Dev.' });
  const hop = card({ threadId: H1, actor: SYS, kind: 'fact', title: 'dispatch → Dev: Add a --json flag', refs: { handoffId: 'h-1', botId: DEV, threadId: DM, requestCardId: ask.id } });
  const devSays = card({ threadId: H1, actor: by(DEV), title: 'Started on the flag' });
  const reported = card({ threadId: H1, actor: SYS, kind: 'fact', title: 'Task reported · in review: flag', refs: { taskId: 't1' }, notice: { code: 'task.reported', args: { title: 'flag' } } });
  const question = card({ threadId: H1, actor: by(DEV), kind: 'question', state: 'open', title: 'Which output shape?' });
  const devLast = card({ threadId: H1, actor: by(DEV), title: 'Opened the PR\nbody text' });
  const relay = card({ threadId: H1, actor: SYS, kind: 'fact', title: 'dispatch → Reviewer: Add a --json flag', refs: { handoffId: 'h-9', botId: REVIEWER } });
  const revSays = card({ threadId: H1, actor: by(REVIEWER), title: 'Looks good' });
  const finished = card({ actor: SYS, kind: 'fact', title: 'Finished: Add a --json flag', refs: { handoffId: 'h-3', threadId: H1 } });
  const after = card({ title: 'Dev finished, the PR is ready.' });
  const prCard = card({ threadId: PR, actor: by(LEAD), title: 'About #12' });
  const prReply = card({ threadId: PR, actor: by(REVIEWER), title: 'Approved #12' });
  const cards = [ask, reply, hop, devSays, reported, question, devLast, relay, revSays, finished, after, prCard, prReply];
  return { cards, ask, reply, hop, devSays, reported, question, devLast, relay, revSays, finished, after, prCard, prReply };
}

describe('conversationStartedThreads', () => {
  it('names the threads this 1:1 started, not the ones it only mentions', () => {
    const s = scenario();
    const started = conversationStartedThreads(leadConversation(), s.cards);
    expect([...started]).toEqual([threadKey('w1', H1)]);
  });

  it('names the threads a group chat started', () => {
    const groupThread = 'group:grp-000000a1' as ThreadId;
    const group: BotGroup = { id: 'grp-000000a1', workspaceId: 'w1', name: 'Team', memberIds: [LEAD, DEV], threadId: groupThread, createdAt: 0, updatedAt: 0 };
    const hop = card({ threadId: H2, actor: SYS, kind: 'fact', title: 'dispatch → Dev: Fix docs', refs: { handoffId: 'h-2', botId: DEV, threadId: groupThread } });
    const conversation: Conversation = { kind: 'room', id: 'group:grp-000000a1', workspaceId: 'w1', group, threadId: groupThread, bots: [], workers: [], last: null, lastAt: 0, needsYou: 0 };
    expect([...conversationStartedThreads(conversation, [hop])]).toEqual([threadKey('w1', H2)]);
    expect([...conversationStartedThreads(leadConversation(), [hop])]).toEqual([]);
  });
});

describe('splitThreads with started threads', () => {
  it('folds a started thread and its pointer into one work card at the root; waiting cards and own-thread cards stay', () => {
    const s = scenario();
    const waits = (c: RoomCard) => c.id === s.question.id;
    const { main, work, surfaced, threads } = splitThreads(s.cards, waits, new Set([threadKey('w1', H1)]));
    // The root stands for the work card; the question waits on the owner and stays.
    expect(main.map((c) => c.id)).toEqual([s.ask.id, s.reply.id, s.hop.id, s.question.id, s.after.id, s.prCard.id, s.prReply.id]);
    const w = work.get(s.hop.id)!;
    expect(w.threadId).toBe(H1);
    expect(w.steps.map((c) => c.id)).toEqual([s.hop.id, s.devSays.id, s.reported.id, s.devLast.id, s.relay.id, s.revSays.id, s.finished.id]);
    expect(w.all).toContain(s.question);
    // A thread the 1:1 did not start keeps its root and its "in thread" reply.
    expect(threads.get(s.prCard.id)?.threadId).toBe(PR);
    expect([...surfaced]).toEqual([s.prReply.id]);
  });

  it('changes nothing without started threads', () => {
    const s = scenario();
    const before = splitThreads(s.cards, never);
    expect(before.work.size).toBe(0);
    expect(before.main).toContain(s.finished);
    expect(before.surfaced.has(s.revSays.id)).toBe(true);
  });

  it('places the work card in the delegating bot\'s run', () => {
    const s = scenario();
    const { main, work, threads, surfaced } = splitThreads(s.cards, never, new Set([threadKey('w1', H1)]));
    const items = buildTimeline(main.map((card) => ({ kind: 'card' as const, card })), { waits: never, threads, surfaced, work, workAuthor: LEAD });
    const workItem = items.find((i) => i.kind === 'work');
    expect(workItem?.kind === 'work' && workItem.delegatorId).toBe(LEAD);
    // It follows the lead's reply within ten minutes: the same run.
    expect(workItem?.kind === 'work' && workItem.continuation).toBe(true);
    const replyItem = items.find((i) => i.kind === 'message' && i.card.id === s.reply.id);
    expect(replyItem?.kind === 'message' && replyItem.runEnd).toBe(false);
    // In a group, the nearest bot above that is not the delegate.
    const groupItems = buildTimeline(main.map((card) => ({ kind: 'card' as const, card })), { waits: never, threads, surfaced, work });
    const g = groupItems.find((i) => i.kind === 'work');
    expect(g?.kind === 'work' && g.delegatorId).toBe(LEAD);
  });
});

describe('the work card view', () => {
  const folded = (): { s: ReturnType<typeof scenario>; w: WorkThread } => {
    const s = scenario();
    const { work } = splitThreads(s.cards, (c) => c.id === s.question.id, new Set([threadKey('w1', H1)]));
    return { s, w: work.get(s.hop.id)! };
  };

  it('is handed to the opening hop\'s addressee and titled by the owner\'s request', () => {
    const { s, w } = folded();
    expect(workDelegate(w.all, LEAD)).toBe(DEV);
    expect(workTitle(w.all, H1, (id) => (id === H1 ? 'Add a --json flag' : null))).toBe('Add a --json flag');
    // Without the owner's request: the handoff's own title, never its id.
    expect(workTitle(w.all, H1)).toBe('Add a --json flag');
    expect(workTitle([s.finished], H1)).toBe('Add a --json flag');
    expect(workTitle([s.devSays], H1)).toBeNull();
  });

  it('shows the delegate\'s newest message, not a later bot\'s', () => {
    const { s, w } = folded();
    expect(workLatest(w.all, DEV, LEAD)?.id).toBe(s.devLast.id);
    // A delegate that wrote nothing: another bot's newest, never the delegator's.
    expect(workLatest([s.hop, s.revSays, s.reply], DEV, LEAD)?.id).toBe(s.revSays.id);
    expect(workLatest([s.hop, s.reply], DEV, LEAD)).toBeNull();
  });

  it('derives its state: waiting on the owner, live tasks, then the newest word', () => {
    const { s, w } = folded();
    expect(workState(w.all, (c) => c.id === s.question.id)).toBe('needsYou');
    // With nothing waiting: the Finished line is the newest word.
    expect(workState(w.all, never)).toBe('done');
    // A live task wins over the cards' words.
    expect(workState(w.all, never, [task('t1', 'coded')])).toBe('review');
    expect(workState(w.all, never, [task('t1', 'working')])).toBe('working');
    expect(workState(w.all, never, [task('t1', 'needs_input')])).toBe('needsYou');
    // Card words alone.
    expect(workState([s.hop], never)).toBe('working');
    expect(workState([s.hop, s.reported], never)).toBe('review');
    const failed = card({ threadId: H1, actor: SYS, kind: 'fact', title: 'Task failed: flag', notice: { code: 'task.failed', args: { title: 'flag' } } });
    expect(workState([s.hop, failed], never)).toBe('failed');
    const cancelled = card({ threadId: H1, actor: SYS, kind: 'fact', title: 'Task cancelled: flag', notice: { code: 'task.cancelled', args: { title: 'flag' } } });
    expect(workState([s.hop, cancelled], never)).toBe('cancelled');
    const stopped = card({ actor: SYS, kind: 'fact', title: 'Stopped: Add a --json flag', refs: { handoffId: 'h-4', threadId: H1 } });
    expect(workState([s.hop, stopped], never)).toBe('failed');
    // A new dispatch after an end puts it back to work.
    expect(workState([s.hop, failed, s.relay], never)).toBe('working');
  });

  it('counts the folded cards as its steps, and finds the pull request a task opened', () => {
    const { s, w } = folded();
    const view = workView(w, { delegatorId: LEAD, waits: (c) => c.id === s.question.id, prUrl: (id) => (id === 't1' ? 'https://github.com/acme/api/pull/12' : null) });
    expect(w.steps).toHaveLength(7);
    expect(view.delegateId).toBe(DEV);
    expect(view.latest?.id).toBe(s.devLast.id);
    expect(view.state).toBe('needsYou');
    expect(view.lastAt).toBe(s.finished.at);
    expect(view.refUrl).toBe('https://github.com/acme/api/pull/12');
    // Else the newest PR or issue a card links.
    const linked = card({ threadId: H1, actor: by(DEV), title: 'PR up', body: 'See https://github.com/acme/api/pull/40 for it' });
    expect(workView({ ...w, all: [...w.all, linked] }, { delegatorId: LEAD, waits: never }).refUrl).toBe('https://github.com/acme/api/pull/40');
  });
});
