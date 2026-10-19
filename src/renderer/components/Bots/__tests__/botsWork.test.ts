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
import { ANNOUNCE_WINDOW_MS, RUN_WINDOW_MS, buildTimeline, splitThreads, threadKey } from '../botsTimeline';
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
  // Later than a run: not the hand-off's announcement.
  const after = card({ title: 'Dev finished, the PR is ready.', at: 2_000_000 });
  const prCard = card({ threadId: PR, actor: by(LEAD), title: 'About #12', at: 2_001_000 });
  const prReply = card({ threadId: PR, actor: by(REVIEWER), title: 'Approved #12', at: 2_002_000 });
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
    // Only a group's coordinators hand work off: another bot above is not one.
    const other = card({ actor: by(REVIEWER), title: 'Unrelated', at: s.hop.at - 1 });
    const split = splitThreads([s.reply, other, s.hop], never, new Set([threadKey('w1', H1)]));
    const among = buildTimeline(split.main.map((card) => ({ kind: 'card' as const, card })), { waits: never, work: split.work, workCandidates: new Set([LEAD]) });
    const picked = among.find((i) => i.kind === 'work');
    expect(picked?.kind === 'work' && picked.delegatorId).toBe(LEAD);
    const none = buildTimeline(split.main.map((card) => ({ kind: 'card' as const, card })), { waits: never, work: split.work, workCandidates: new Set() });
    const lone = none.find((i) => i.kind === 'work');
    expect(lone?.kind === 'work' && lone.delegatorId).toBeNull();
    expect(lone?.kind === 'work' && lone.continuation).toBe(false);
  });

  it('puts the work card right after the delegating bot\'s message that announced it', () => {
    const at = 50_000_000;
    const ask = card({ actor: { kind: 'human' }, kind: 'human', title: 'Do it', at });
    const hop = card({ threadId: H1, actor: SYS, kind: 'fact', title: 'dispatch → Dev: Do it', refs: { handoffId: 'h-1', botId: DEV, threadId: DM }, at: at + 1_000 });
    const said = card({ kind: 'dispatch', title: '구현 봇에게 넘겼습니다', at: at + 1_004 });
    const later = card({ title: 'Anything else?', at: at + ANNOUNCE_WINDOW_MS + 5_000 });
    const order = (list: RoomCard[], workAuthor?: string) => {
      const { main, work } = splitThreads(list, never, new Set([threadKey('w1', H1)]));
      return buildTimeline(main.map((card) => ({ kind: 'card' as const, card })), { waits: never, work, ...(workAuthor ? { workAuthor } : {}) })
        .filter((i) => i.kind === 'message' || i.kind === 'work')
        .map((i) => (i.kind === 'work' ? 'work' : i.kind === 'message' ? i.card.id : ''));
    };
    expect(order([ask, hop, said, later], LEAD)).toEqual([ask.id, said.id, 'work', later.id]);
    // The card continues the bubble's run, and the bubble no longer ends it.
    const { main, work } = splitThreads([ask, hop, said], never, new Set([threadKey('w1', H1)]));
    const items = buildTimeline(main.map((card) => ({ kind: 'card' as const, card })), { waits: never, work, workAuthor: LEAD });
    const w = items.find((i) => i.kind === 'work');
    expect(w?.kind === 'work' && w.continuation).toBe(true);
    // A message naming the handoff later in the run counts too; one after a
    // minute that does not name it does not.
    const naming = card({ title: 'Handed it over', refs: { handoffId: 'h-1' }, at: at + 5 * 60_000 });
    expect(order([ask, hop, naming], LEAD)).toEqual([ask.id, naming.id, 'work']);
    expect(order([ask, hop, later], LEAD)).toEqual([ask.id, 'work', later.id]);
    // The owner's message ends the search, as does the run window.
    const owner = card({ actor: { kind: 'human' }, kind: 'human', title: 'wait', at: at + 1_002 });
    expect(order([ask, hop, owner, said], LEAD)).toEqual([ask.id, 'work', owner.id, said.id]);
    const late = card({ kind: 'dispatch', title: 'late', at: at + 1_000 + RUN_WINDOW_MS });
    expect(order([ask, hop, late], LEAD)).toEqual([ask.id, 'work', late.id]);
    // Another bot's message is not the announcement.
    const other = card({ actor: by(DEV), threadId: DM, title: 'dev here', at: at + 1_003 });
    expect(order([ask, hop, other], LEAD)).toEqual([ask.id, 'work', other.id]);
  });

  it('keeps the order of several cards after one announcement, its delegator, and its time', () => {
    const at = 60_000_000;
    const keyOf = (threadId: ThreadId) => threadKey('w1', threadId);
    const lead = card({ title: 'Splitting this', at });
    const hopA = card({ threadId: H1, actor: SYS, kind: 'fact', title: 'dispatch → Dev: A', refs: { handoffId: 'h-1', botId: DEV, threadId: DM }, at: at + 1_000 });
    const hopB = card({ threadId: H2, actor: SYS, kind: 'fact', title: 'dispatch → Dev: B', refs: { handoffId: 'h-2', botId: DEV, threadId: DM }, at: at + 1_001 });
    const said = card({ kind: 'dispatch', title: 'Handed both over', at: at + 9 * 60_000 });
    const next = card({ title: 'More soon', at: at + 9 * 60_000 + 60_000 });
    const { main, work } = splitThreads([lead, hopA, hopB, said, next], never, new Set([keyOf(H1), keyOf(H2)]));
    const items = buildTimeline(main.map((card) => ({ kind: 'card' as const, card })), { waits: never, work, workAuthor: LEAD })
      .filter((i) => i.kind === 'message' || i.kind === 'work');
    expect(items.map((i) => (i.kind === 'work' ? i.work.threadId : i.kind === 'message' ? i.card.id : ''))).toEqual([lead.id, said.id, H1, H2, next.id]);
    // Read at the announcement's time: the next message continues the run.
    expect(items.map((i) => (i.kind === 'message' || i.kind === 'work') && i.continuation)).toEqual([false, true, true, true, true]);
    // In a group with two coordinators, the one above the root handed it
    // off: another coordinator's message after it is not the announcement.
    const other = card({ actor: by(REVIEWER), title: 'Reviewer here', at: at + 1_500 });
    const g = splitThreads([lead, hopA, other], never, new Set([keyOf(H1)]));
    const groupItems = buildTimeline(g.main.map((card) => ({ kind: 'card' as const, card })), { waits: never, work: g.work, workCandidates: new Set([LEAD, REVIEWER]) })
      .filter((i) => i.kind === 'message' || i.kind === 'work');
    expect(groupItems.map((i) => i.kind)).toEqual(['message', 'work', 'message']);
    const w = groupItems[1];
    expect(w.kind === 'work' && w.delegatorId).toBe(LEAD);
  });

  it('a thread whose first card read waits on the owner still gets its work card, and the card shows too', () => {
    const q = card({ threadId: H1, actor: by(DEV), kind: 'question', state: 'open', title: 'Which shape?' });
    const later = card({ threadId: H1, actor: by(DEV), title: 'Working on it' });
    const { main, work } = splitThreads([q, later], (c) => c.id === q.id, new Set([threadKey('w1', H1)]));
    expect(main.map((c) => c.id)).toEqual([q.id]);
    expect(work.get(q.id)?.steps.map((c) => c.id)).toEqual([later.id]);
    const items = buildTimeline(main.map((card) => ({ kind: 'card' as const, card })), { waits: (c) => c.id === q.id, work });
    expect(items.filter((i) => i.kind !== 'day').map((i) => i.kind)).toEqual(['work', 'message']);
  });

  it('marks the work card new when a card folded into it is', () => {
    const s = scenario();
    const { main, work } = splitThreads(s.cards, never, new Set([threadKey('w1', H1)]));
    const items = buildTimeline(main.map((card) => ({ kind: 'card' as const, card })), { waits: never, work, newAfter: s.devSays.at - 1 });
    const at = items.findIndex((i) => i.kind === 'new');
    expect(items[at + 1]?.kind).toBe('work');
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
    // The handoff's own title wins over a short owner reply it points to.
    const reply = card({ actor: { kind: 'human' }, kind: 'human', title: '응 붙인다' });
    const named = card({ threadId: H2, actor: SYS, kind: 'fact', title: 'dispatch → 구현 봇: by-wmux-bot 라벨: #2272와 머지된 봇 PR #2257·#2258·#2260에 붙이기', refs: { handoffId: 'h-2', botId: DEV, threadId: DM, requestCardId: reply.id } });
    expect(workTitle([named], H2, (id) => (id === H2 ? '응 붙인다' : null))).toBe('by-wmux-bot 라벨: #2272와 머지된 봇 PR #2257·#2258·#2260에 붙이기');
    // A handoff with no title of its own: the owner's request.
    expect(workTitle([s.devSays], H1, () => '응 붙인다')).toBe('응 붙인다');
    // A refused opening hop keeps the request's words too.
    const refused = card({ threadId: H1, actor: SYS, kind: 'refusal', title: 'Handoff refused (no_addressee): Add a --json flag', refs: { handoffId: 'h-1', threadId: DM } });
    expect(workTitle([refused], H1)).toBe('Add a --json flag');
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
    // A task that ended after its report, with no card of its own: its outcome.
    expect(workState([s.hop, s.reported], never, [task('t1', 'checked', s.reported.at + 1)])).toBe('done');
    expect(workState([s.hop, s.reported], never, [task('t1', 'cancelled', s.reported.at + 1)])).toBe('cancelled');
    expect(workState([s.hop, s.reported], never, [task('t1', 'failed', s.reported.at + 1)])).toBe('failed');
    // A newer word in the thread than the task's end wins.
    expect(workState([s.hop, s.reported, s.relay], never, [task('t1', 'checked', s.reported.at + 1)])).toBe('working');
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
