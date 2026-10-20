// Taint by origin: which wakes carried outside text, and how a mark travels
// through a handoff.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Fact } from '../../../shared/facts';
import type { Handoff } from '../../../shared/handoff';
import type { LedgerEntry } from '../../../shared/ledger';
import type { WakeItem } from '../../../shared/wake';
import { __resetGuestWorkspacesForTesting, noteGuestRecordWorkspaces } from '../guestWorkspaces';
import { endConversation, startConversation } from '../conversationMarks';
import { GUEST_TURN_STARTS_NO_WORKERS, WakeTaint, expectWakeTaint, factVisibleToBot, guestTurnProbeOf, untrackedGuest, guestOfWake, guestTurnRefusal, runningWakeTainted, setWakeTaint, taskTainted, type WakeTaintPorts } from '../wakeTaint';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-taint-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const fact = (id: string, kind: Fact['kind'], ref: Fact['ref'] = {}): Fact => ({ id, seq: 1, kind, at: 1, dedupeKey: id, ref, payload: {} });
const handoff = (id: string, from: Handoff['from'], createdAt = 100): Handoff => ({
  version: 1, id, runId: 'run-1', threadId: 'general', depth: 1, hopsInRun: 1, from, to: { kind: 'bot', workspaceId: 'ws', botId: 'bot-b' },
  kind: 'dispatch', attribution: { originator: from, chain: [] }, landing: 'wake', payload: { title: 't', body: '' }, status: 'delivered', createdAt, updatedAt: createdAt,
});
const wake = (reason: WakeItem['reason']): WakeItem => ({ id: 'w-1', botId: 'bot-a', workspaceId: 'ws', reason, priority: 1, enqueuedAt: 1, attempts: 1, state: 'running' });
const row = (id: string, tainted = false): LedgerEntry => ({ id, dispatch: { origin: { kind: 'bot', botId: 'bot-a', tainted } } } as unknown as LedgerEntry);

function make(over: Partial<WakeTaintPorts> = {}, facts: Fact[] = [], handoffs: Handoff[] = [], rows: LedgerEntry[] = []) {
  const ports: WakeTaintPorts = {
    facts: (ids) => facts.filter((f) => ids.includes(f.id)),
    handoff: (id) => handoffs.find((h) => h.id === id) ?? null,
    taskRow: (id) => rows.find((r) => r.id === id) ?? null,
    runningWake: () => null,
    file: path.join(dir, 'factory', 'taint.json'),
    log: () => undefined,
    ...over,
  };
  return new WakeTaint(ports);
}

describe('WakeTaint', () => {
  it('owner words, buttons and timers are clean; an unknown reason is tainted', () => {
    const t = make();
    expect(t.reasonTainted({ kind: 'human', text: 'hi', source: 'desktop' })).toBe(false);
    expect(t.reasonTainted({ kind: 'manual', by: 'human' })).toBe(false);
    expect(t.reasonTainted({ kind: 'schedule', scheduleId: 's' })).toBe(false);
    expect(t.reasonTainted({ kind: 'routine', routineId: 'r', dueAt: 1 })).toBe(false);
    expect(t.reasonTainted({ kind: 'intro' })).toBe(false);
    // A held fan-out's wake: as its asking wake was marked.
    expect(t.reasonTainted({ kind: 'held_fanout', heldId: 'held-1', heldAt: 1, titles: ['x'], tainted: false })).toBe(false);
    expect(t.reasonTainted({ kind: 'held_fanout', heldId: 'held-2', heldAt: 1, titles: ['x'], tainted: true })).toBe(true);
    expect(t.reasonTainted({ kind: 'mystery' } as unknown as WakeItem['reason'])).toBe(true);
  });

  it('PR, issue, CI and verdict facts are outside text; a missing fact is tainted', () => {
    const t = make({}, [fact('f1', 'issue.opened'), fact('f2', 'ci.green'), fact('f3', 'verdict.recorded'), fact('f4', 'pr.opened'), fact('f5', 'merge.done'), fact('f6', 'schedule.fired')]);
    const facts = (ids: string[]) => ({ kind: 'facts' as const, factIds: ids, trigger: { kind: 'fact' } as never });
    expect(t.reasonTainted(facts(['f1']))).toBe(true);
    expect(t.reasonTainted(facts(['f4']))).toBe(true);
    expect(t.reasonTainted(facts(['f2']))).toBe(true);
    expect(t.reasonTainted(facts(['f3']))).toBe(true);
    expect(t.reasonTainted(facts(['gone']))).toBe(true);
    expect(t.reasonTainted(facts(['f5', 'f6']))).toBe(false);
  });

  it('a task fact is as tainted as its task; an unknown task is tainted', () => {
    const t = make({}, [fact('a', 'task.done', { taskId: 'clean' }), fact('b', 'task.done', { taskId: 'dirty' }), fact('c', 'task.failed', { taskId: 'gone' })], [], [row('clean'), row('dirty', true)]);
    const facts = (id: string) => ({ kind: 'facts' as const, factIds: [id], trigger: { kind: 'fact' } as never });
    expect(t.reasonTainted(facts('a'))).toBe(false);
    expect(t.reasonTainted(facts('b'))).toBe(true);
    expect(t.reasonTainted(facts('c'))).toBe(true);
    expect(taskTainted(row('x', true))).toBe(true);
    expect(taskTainted(row('x'))).toBe(false);
    // A bot task from before the mark, or a row with no dispatch: unknown.
    expect(taskTainted({ dispatch: { origin: { kind: 'bot', botId: 'bot-a' } } })).toBe(true);
    expect(taskTainted({})).toBe(true);
    expect(taskTainted({ dispatch: { origin: { kind: 'pane' } } })).toBe(false);
  });

  it('a bot task\'s own wake (task.<status>:<id>@<rev>, not in the log) is as tainted as that task', () => {
    const t = make({}, [], [], [row('clean'), row('dirty', true)]);
    const facts = (id: string) => ({ kind: 'facts' as const, factIds: [id], trigger: { kind: 'task.done' } as never });
    expect(t.reasonTainted(facts('task.done:clean@3'))).toBe(false);
    expect(t.reasonTainted(facts('task.gated:clean@4'))).toBe(false);
    expect(t.reasonTainted(facts('task.input_required:dirty@2'))).toBe(true);
    // An unknown task, or a ledger that cannot be read, stays tainted.
    expect(t.reasonTainted(facts('task.done:gone@1'))).toBe(true);
    expect(make({ taskRow: () => { throw new Error('x'); } }).reasonTainted(facts('task.done:clean@3'))).toBe(true);
    // A handoff sent from such a wake carries its mark.
    const fromBot = { kind: 'bot' as const, workspaceId: 'ws', botId: 'bot-a' };
    const running = { item: wake({ kind: 'facts', factIds: ['task.done:clean@3'], trigger: { kind: 'task.done' } as never }), startedAt: 50 };
    const t2 = make({ runningWake: () => running }, [], [handoff('h-1', fromBot)], [row('clean')]);
    t2.onFact(fact('x1', 'handoff.received', { handoffId: 'h-1' }));
    expect(t2.handoffTainted('h-1')).toBe(false);
  });

  it('workflow ready facts use current persisted taint, including when an older wake is delivered', () => {
    const id = 'wf-' + 'a'.repeat(24);
    const saved = { revision: 3, tainted: false };
    const t = make({ workflow: (workflowId) => workflowId === id ? saved : null });
    const facts = (revision: number) => ({ kind: 'facts' as const, factIds: [`workflow.ready:${id}@${revision}`], trigger: { kind: 'task.done' } as never });
    expect(t.reasonTainted(facts(3))).toBe(false);
    expect(t.reasonTainted(facts(1))).toBe(false);
    saved.tainted = true;
    expect(t.reasonTainted(facts(3))).toBe(true);
    expect(t.reasonTainted(facts(1))).toBe(true);
    // A clean workflow fact cannot clear outside text delivered in the same wake.
    saved.tainted = false;
    const mixed = make({ workflow: () => saved }, [fact('outside', 'issue.opened')]);
    expect(mixed.reasonTainted({ ...facts(3), factIds: [...facts(3).factIds, 'outside'] })).toBe(true);
  });

  it('unknown, malformed and future workflow ready facts fail closed, as does an unavailable store', () => {
    const id = 'wf-' + 'a'.repeat(24);
    const facts = (factId: string) => ({ kind: 'facts' as const, factIds: [factId], trigger: { kind: 'task.done' } as never });
    const t = make({ workflow: (workflowId) => workflowId === id ? { revision: 3, tainted: false } : null });
    for (const factId of [
      `workflow.ready:${id}@4`, `workflow.ready:wf-${'b'.repeat(24)}@1`,
      `workflow.ready:${id}@0`, `workflow.ready:${id}@01`, `workflow.ready:${id}@-1`,
      `workflow.ready:${id}@9007199254740992`, `workflow.ready:${id}@3trailing`,
      'workflow.ready:invalid@1',
    ]) expect(t.reasonTainted(facts(factId))).toBe(true);
    expect(make().reasonTainted(facts(`workflow.ready:${id}@1`))).toBe(true);
    expect(make({ workflow: () => null }).reasonTainted(facts(`workflow.ready:${id}@1`))).toBe(true);
    expect(make({ workflow: () => { throw new Error('unavailable'); } }).reasonTainted(facts(`workflow.ready:${id}@1`))).toBe(true);
  });

  it('a handoff takes its sender wake\'s mark at delivery, and keeps it across a restart', () => {
    const fromBot = { kind: 'bot' as const, workspaceId: 'ws', botId: 'bot-a' };
    const hs = [handoff('h-clean', fromBot), handoff('h-dirty', fromBot)];
    const issue = fact('f1', 'issue.opened');
    let running: { item: WakeItem; startedAt: number } | null = { item: wake({ kind: 'human', text: 'go', source: 'desktop' }), startedAt: 50 };
    const t = make({ runningWake: () => running }, [issue], hs);
    t.onFact(fact('x1', 'handoff.received', { handoffId: 'h-clean' }));
    running = { item: wake({ kind: 'facts', factIds: ['f1'], trigger: { kind: 'fact' } as never }), startedAt: 50 };
    t.onFact(fact('x2', 'handoff.received', { handoffId: 'h-dirty' }));
    expect(t.reasonTainted({ kind: 'handoff', handoffId: 'h-clean' })).toBe(false);
    expect(t.reasonTainted({ kind: 'mention', handoffId: 'h-dirty', cardId: 'c', fromBotId: 'bot-a' })).toBe(true);
    const again = make({ runningWake: () => null }, [], hs);
    expect(again.handoffTainted('h-clean')).toBe(false);
    expect(again.handoffTainted('h-dirty')).toBe(true);
  });

  it('an unmarked bot handoff, or one whose sender\'s turn began after it, is tainted; the owner\'s are clean', () => {
    const fromBot = { kind: 'bot' as const, workspaceId: 'ws', botId: 'bot-a' };
    const hs = [handoff('h-old', fromBot, 10), handoff('h-unmarked', fromBot), handoff('h-owner', { kind: 'human' })];
    const t = make({ runningWake: () => ({ item: wake({ kind: 'human', text: 'go', source: 'desktop' }), startedAt: 50 }) }, [], hs);
    t.onFact(fact('x1', 'handoff.received', { handoffId: 'h-old' }));
    expect(t.handoffTainted('h-old')).toBe(true);
    expect(t.handoffTainted('h-unmarked')).toBe(true);
    expect(t.handoffTainted('h-owner')).toBe(false);
    expect(t.handoffTainted('h-missing')).toBe(true);
  });

  it('a researcher\'s handoff is tainted even from a clean wake; an unknown sender is too', () => {
    const fromA = { kind: 'bot' as const, workspaceId: 'ws', botId: 'bot-a' };
    const fromB = { kind: 'bot' as const, workspaceId: 'ws', botId: 'bot-b' };
    const fromGone = { kind: 'bot' as const, workspaceId: 'ws', botId: 'bot-c' };
    const hs = [handoff('h-research', fromA), handoff('h-dev', fromB), handoff('h-gone', fromGone)];
    const profiles: Record<string, { role: 'lead'; template: 'researcher' | 'developer'; workspaceId: string }> = {
      'bot-a': { role: 'lead', template: 'researcher', workspaceId: 'ws' },
      'bot-b': { role: 'lead', template: 'developer', workspaceId: 'ws' },
    };
    const t = make({
      runningWake: () => ({ item: wake({ kind: 'human', text: 'go', source: 'desktop' }), startedAt: 50 }),
      bot: (id) => profiles[id] ?? null,
    }, [], hs);
    for (const id of ['h-research', 'h-dev', 'h-gone']) t.onFact(fact(`x-${id}`, 'handoff.received', { handoffId: id }));
    expect(t.handoffTainted('h-research')).toBe(true);
    expect(t.handoffTainted('h-dev')).toBe(false);
    expect(t.handoffTainted('h-gone')).toBe(true);
    // A directory that throws is not known to be clean (marks in memory only).
    const broken = make({ file: undefined, runningWake: () => ({ item: wake({ kind: 'human', text: 'go', source: 'desktop' }), startedAt: 50 }), bot: () => { throw new Error('x'); } }, [], hs);
    broken.onFact(fact('x', 'handoff.received', { handoffId: 'h-dev' }));
    expect(broken.handoffTainted('h-dev')).toBe(true);
  });

  it('a researcher\'s handoff marked clean before the rule existed reads tainted', () => {
    const fromA = { kind: 'bot' as const, workspaceId: 'ws', botId: 'bot-a' };
    fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'factory', 'taint.json'), JSON.stringify({ version: 1, handoffs: { 'h-old': false, 'h-dev': false } }));
    const t = make({ bot: (id) => (id === 'bot-a' ? { role: 'lead', template: 'researcher', workspaceId: 'ws' } : { role: 'lead', template: 'developer', workspaceId: 'ws' }) },
      [], [handoff('h-old', fromA), handoff('h-dev', { kind: 'bot', workspaceId: 'ws', botId: 'bot-b' })]);
    expect(t.handoffTainted('h-old')).toBe(true);
    expect(t.handoffTainted('h-dev')).toBe(false);
  });

  it('the owner\'s answer to a question asked mid-hop is as tainted as that hop', () => {
    const fromBot = { kind: 'bot' as const, workspaceId: 'ws', botId: 'bot-a' };
    const human = { kind: 'human' as const };
    const ask = (id: string, forHop?: string): Handoff => ({ ...handoff(id, fromBot), kind: 'ask_person', to: human, ...(forHop ? { forHop } : {}) });
    const answer = (id: string, askId: string): Handoff => ({ ...handoff(id, human), kind: 'answer', replyTo: askId });
    const hs = [handoff('h-dirty', fromBot), handoff('h-clean', fromBot), ask('a-dirty', 'h-dirty'), ask('a-clean', 'h-clean'), ask('a-none'),
      answer('ans-dirty', 'a-dirty'), answer('ans-clean', 'a-clean'), answer('ans-none', 'a-none')];
    const t = make({ file: undefined, runningWake: () => ({ item: wake({ kind: 'human', text: 'go', source: 'desktop' }), startedAt: 50 }) }, [], hs);
    t.onFact(fact('x1', 'handoff.received', { handoffId: 'h-clean' }));
    expect(t.handoffTainted('ans-dirty')).toBe(true);
    expect(t.handoffTainted('ans-clean')).toBe(false);
    expect(t.handoffTainted('ans-none')).toBe(false);
  });

  it('an answer whose question was pruned is handled like outside text, for every reader of the mark', () => {
    const fromBot = { kind: 'bot' as const, workspaceId: 'ws', botId: 'bot-a' };
    const human = { kind: 'human' as const };
    const answer = (id: string, askId?: string): Handoff => ({ ...handoff(id, human), kind: 'answer', to: fromBot, ...(askId ? { replyTo: askId } : {}) });
    const kept: Handoff = { ...handoff('a-kept', fromBot), kind: 'ask_person', to: human, guestSourced: false };
    // The pruned question's answer, an intact one with no hop, and owner text that answers no question.
    const hs = [kept, answer('ans-pruned', 'a-pruned'), answer('ans-kept', 'a-kept'), answer('ans-direct'), handoff('h-out', fromBot), handoff('h-out-2', fromBot)];
    let running: { item: WakeItem; startedAt: number } | null = null;
    const t = make({ file: undefined, runningWake: () => running }, [], hs);
    const on = (id: string) => wake({ kind: 'handoff', handoffId: id });
    // The mark itself, and the wake on it (approvals, job_set).
    expect(t.handoffTainted('ans-pruned')).toBe(true);
    expect(t.wakeTainted(on('ans-pruned'))).toBe(true);
    expect(t.wakeTainted(on('ans-kept'))).toBe(false);
    expect(t.wakeTainted(on('ans-direct'))).toBe(false);
    // Delivered as owner text, it is still tainted (its delivery mark is clean).
    t.onFact(fact('x1', 'handoff.received', { handoffId: 'ans-pruned' }));
    expect(t.handoffTainted('ans-pruned')).toBe(true);
    // A fact about it (a wake on handoff facts).
    expect(t.factTainted(fact('x2', 'handoff.received', { handoffId: 'ans-pruned' }))).toBe(true);
    expect(t.factTainted(fact('x3', 'handoff.received', { handoffId: 'ans-kept' }))).toBe(false);
    // A handoff the bot sends from that wake, and one answering it.
    running = { item: on('ans-pruned'), startedAt: 0 };
    t.markSent('h-out', 'bot-a');
    expect(t.handoffTainted('h-out')).toBe(true);
    running = { item: on('ans-kept'), startedAt: 0 };
    t.markSent('h-out-2', 'bot-a', ['ans-pruned']);
    expect(t.handoffTainted('h-out-2')).toBe(true);
    // Its question gone, it is also of unknown provenance: stamped guest.
    expect(t.markForward('h-fwd', { handoffIds: ['ans-pruned'] })).toBe('guest');
    expect(t.markForward('h-fwd-2', { handoffIds: ['ans-kept'] })).toBe(false);
    // The answer pruned in turn: its delivery mark says what it was.
    hs.push({ ...handoff('h-dirty', fromBot) }, { ...kept, id: 'a-dirty', forHop: 'h-dirty' }, answer('ans-dirty', 'a-dirty'));
    t.onFact(fact('x4', 'handoff.received', { handoffId: 'ans-kept' }));
    t.onFact(fact('x5', 'handoff.received', { handoffId: 'ans-dirty' }));
    for (const id of ['ans-pruned', 'ans-kept', 'ans-dirty', 'a-dirty']) hs.splice(hs.findIndex((h) => h.id === id), 1);
    expect(t.handoffTainted('ans-pruned')).toBe(true);
    expect(t.handoffTainted('ans-dirty')).toBe(true);
    expect(t.handoffTainted('ans-kept')).toBe(false);
    // An answer gone with no mark at all reads tainted.
    expect(t.handoffTainted('ans-never-seen')).toBe(true);
    hs.push(answer('ans-pruned', 'a-pruned'), answer('ans-kept', 'a-kept'));
    // The running wake's mark (worker_message's sender and a fan-out's origin).
    setWakeTaint(t, () => running);
    try {
      running = { item: on('ans-pruned'), startedAt: 0 };
      expect(runningWakeTainted('bot-a')).toBe(true);
      running = { item: on('ans-kept'), startedAt: 0 };
      expect(runningWakeTainted('bot-a')).toBe(false);
    } finally {
      setWakeTaint(null);
    }
  });

  it('a send is marked in the sender\'s turn, so a turn that ended before delivery does not taint it', () => {
    const fromBot = { kind: 'bot' as const, workspaceId: 'ws', botId: 'bot-a' };
    let running: { item: WakeItem; startedAt: number } | null = { item: wake({ kind: 'human', text: 'go', source: 'desktop' }), startedAt: 50 };
    const t = make({ file: undefined, runningWake: () => running }, [], [handoff('h-sent', fromBot)]);
    t.markSent('h-sent', 'bot-a');
    running = null;
    t.onFact(fact('x', 'handoff.received', { handoffId: 'h-sent' }));
    expect(t.handoffTainted('h-sent')).toBe(false);
    // With no running turn at the send, it is tainted.
    const t2 = make({ file: undefined, runningWake: () => null }, [], [handoff('h-late', fromBot)]);
    t2.markSent('h-late', 'bot-a');
    expect(t2.handoffTainted('h-late')).toBe(true);
  });

  it('an unreadable marks file starts empty', () => {
    fs.mkdirSync(path.join(dir, 'factory'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'factory', 'taint.json'), '{nope');
    const fromBot = { kind: 'bot' as const, workspaceId: 'ws', botId: 'bot-a' };
    expect(make({}, [], [handoff('h', fromBot)]).handoffTainted('h')).toBe(true);
  });
});

describe('handoffs follow the sender\'s conversation', () => {
  it('a handoff sent in a clean wake from a conversation that ran a tainted wake is tainted', () => {
    let conversationTainted = true;
    const running = { item: wake({ kind: 'human', text: 'status?', source: 'desktop' }), startedAt: 0 };
    const t = make({ runningWake: () => running, conversationTainted: () => conversationTainted });
    expect(t.wakeTainted(running.item)).toBe(false);
    expect(t.markSent('h-poisoned', 'bot-a')).toBe(true);
    expect(t.markForward('h-fwd', { senderBotId: 'bot-a', handoffIds: [] })).toBe(true);
    conversationTainted = false;
    expect(t.markSent('h-clean', 'bot-a')).toBe(false);
    // A conversation whose mark cannot be read counts as tainted.
    const broken = make({ runningWake: () => running, conversationTainted: () => { throw new Error('x'); } });
    expect(broken.markSent('h-unknown', 'bot-a')).toBe(true);
  });

  it('by default reads the conversation mark the runtime keeps', () => {
    const running = { item: { ...wake({ kind: 'human', text: 'hi', source: 'desktop' }), botId: 'bot-c' }, startedAt: 0 };
    const t = make({ runningWake: () => running });
    startConversation('bot-c', { tainted: true });
    try {
      expect(t.markSent('h-c1', 'bot-c')).toBe(true);
    } finally {
      endConversation('bot-c');
    }
    expect(t.markSent('h-c2', 'bot-c')).toBe(false);
  });
});

describe('guest provenance', () => {
  afterEach(() => setWakeTaint(null));
  const G = '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
  const guestReason = { kind: 'guest' as const, guestId: G, guestName: 'G', cardId: 'c', text: 'x' };
  const fromBot = { kind: 'bot' as const, workspaceId: 'ws', botId: 'bot-a' };

  it('is decided from the wake record: guest wakes, clean reasons, records that say, and unknown when nothing does', () => {
    const t = make({}, [
      { ...fact('f-task', 'task.done', { taskId: 't-guest' }) },
      { ...fact('f-notice', 'bot.notice'), payload: { topic: 'worker.started', title: 'x', guest: false } as never },
      { ...fact('f-old-notice', 'bot.notice'), payload: { topic: 'worker.started', title: 'x', tainted: true } as never },
      fact('f-pr', 'pr.opened'),
    ], [], [
      { id: 't-guest', dispatch: { origin: { kind: 'bot', botId: 'bot-a', tainted: true, guest: true } } } as unknown as LedgerEntry,
      row('t-clean', false),
      row('t-old-tainted', true),
    ]);
    expect(t.wakeGuest(wake(guestReason))).toBe(true);
    expect(t.wakeGuest(wake({ kind: 'human', text: 'hi', source: 'desktop' }))).toBe(false);
    expect(t.wakeGuest(wake({ kind: 'facts', factIds: ['f-task'], trigger: { kind: 'task.done' } }))).toBe(true);
    expect(t.wakeGuest(wake({ kind: 'facts', factIds: ['f-notice', 'f-pr'], trigger: { kind: 'fact' } as never }))).toBe(false);
    expect(t.wakeGuest(wake({ kind: 'facts', factIds: ['task.done:t-clean@2'], trigger: { kind: 'task.done' } }))).toBe(false);
    // A record that does not say and is not known clean: unknown, never clean.
    expect(t.wakeGuest(wake({ kind: 'facts', factIds: ['task.done:t-old-tainted@2'], trigger: { kind: 'task.done' } }))).toBe('unknown');
    expect(t.wakeGuest(wake({ kind: 'facts', factIds: ['f-old-notice'], trigger: { kind: 'fact' } as never }))).toBe('unknown');
    expect(t.wakeGuest(wake({ kind: 'facts', factIds: ['f-missing'], trigger: { kind: 'fact' } as never }))).toBe('unknown');
    expect(t.wakeGuest(wake({ kind: 'held_fanout', heldId: 'h', heldAt: 1, titles: ['x'], tainted: false }))).toBe(false);
    expect(t.wakeGuest(wake({ kind: 'held_fanout', heldId: 'h', heldAt: 1, titles: ['x'], tainted: true }))).toBe('unknown');
    expect(t.wakeGuest(wake({ kind: 'held_fanout', heldId: 'h', heldAt: 1, titles: ['x'], tainted: true, guest: false }))).toBe(false);
    expect(t.wakeGuest(wake({ kind: 'handoff', handoffId: 'h-gone' }))).toBe('unknown');
  });

  it('a send from a guest wake is marked guest on disk; the receiving wake is guest, also after a reload', () => {
    const handoffs = [handoff('h-1', fromBot)];
    const running = { item: wake(guestReason), startedAt: 1 };
    const t = make({ runningWake: () => running }, [], handoffs);
    expect(t.markSent('h-1', 'bot-a')).toBe('guest');
    expect(t.handoffTainted('h-1')).toBe(true);
    const receiving = wake({ kind: 'handoff', handoffId: 'h-1' });
    expect(t.wakeGuest(receiving)).toBe(true);
    expect(make({}, [], handoffs).wakeGuest(receiving)).toBe(true);
    // From a clean wake: a plain mark, never guest.
    const clean = make({ runningWake: () => ({ item: wake({ kind: 'human', text: 'hi', source: 'desktop' }), startedAt: 1 }) }, [], [handoff('h-2', fromBot)]);
    expect(clean.markSent('h-2', 'bot-a')).toBe(false);
    expect(clean.wakeGuest(wake({ kind: 'handoff', handoffId: 'h-2' }))).toBe(false);
  });

  it('a relay dispatch carrying a guest-sourced result is guest-sourced', () => {
    const result = { ...handoff('h-result', fromBot), kind: 'result' as const, guestSourced: true };
    const t = make({}, [], [result, handoff('h-parent', fromBot), handoff('h-relay', fromBot)]);
    expect(t.markForward('h-relay', { handoffIds: ['h-result', 'h-parent'] })).toBe('guest');
    expect(t.wakeGuest(wake({ kind: 'handoff', handoffId: 'h-relay' }))).toBe(true);
  });

  it('the owner\'s answer is as guest-sourced as its question; a question that does not say counts as one', () => {
    const ask = (id: string, guestSourced?: boolean): Handoff => ({ ...handoff(id, fromBot), kind: 'ask_person', to: { kind: 'human' }, ...(guestSourced !== undefined ? { guestSourced } : {}) });
    const answer = (id: string, askId: string): Handoff => ({ ...handoff(id, { kind: 'human' }), kind: 'answer', replyTo: askId, to: fromBot });
    const handoffs = [ask('q-guest', true), ask('q-clean', false), ask('q-old'), answer('a-guest', 'q-guest'), answer('a-clean', 'q-clean'), answer('a-old', 'q-old')];
    const t = make({}, [], handoffs);
    for (const id of ['a-guest', 'a-clean', 'a-old']) t.noteDelivered(id);
    expect(t.wakeGuest(wake({ kind: 'handoff', handoffId: 'a-guest' }))).toBe(true);
    expect(t.wakeGuest(wake({ kind: 'handoff', handoffId: 'a-clean' }))).toBe(false);
    expect(t.wakeGuest(wake({ kind: 'handoff', handoffId: 'a-old' }))).toBe(true);
  });

  it('a mention carrying a guest-sourced card is guest whatever turn routes it; a refused clean send wakes its sender clean', () => {
    const clean = { item: wake({ kind: 'human', text: 'hi', source: 'desktop' }), startedAt: 1 };
    const refused = { ...handoff('h-refused', fromBot), status: 'refused' as const, guestSourced: false };
    const t = make({ runningWake: () => clean }, [], [handoff('h-m', fromBot), refused]);
    expect(t.markSent('h-m', 'bot-a', [], true)).toBe('guest');
    expect(t.wakeGuest(wake({ kind: 'handoff', handoffId: 'h-m' }))).toBe(true);
    // A clean card routed after its wake ended: clean (tainted, as no turn vouches for it).
    const after = make({ runningWake: () => null }, [], [handoff('h-c', fromBot)]);
    expect(after.markSent('h-c', 'bot-a', [], false)).toBe(true);
    expect(after.wakeGuest(wake({ kind: 'handoff', handoffId: 'h-c' }))).toBe(false);
    const withFact = make({ runningWake: () => clean }, [{ ...fact('f-r', 'handoff.refused', { handoffId: 'h-refused' }) }], [refused]);
    expect(withFact.wakeGuest(wake({ kind: 'facts', factIds: ['f-r'], trigger: { kind: 'fact' } as never }))).toBe(false);
  });

  it('a bot\'s fact reads show only facts known clean, except in a guest-sourced wake', () => {
    const guestHop = { ...handoff('h-g', fromBot), guestSourced: true };
    const cleanHop = { ...handoff('h-c', fromBot), guestSourced: false };
    const facts = [fact('f-g', 'handoff.received', { handoffId: 'h-g' }), fact('f-c', 'handoff.received', { handoffId: 'h-c' }), fact('f-x', 'handoff.received', { handoffId: 'h-gone' }), fact('f-pr', 'pr.opened')];
    let running: { item: WakeItem; startedAt: number } | null = { item: wake({ kind: 'human', text: 'hi', source: 'desktop' }), startedAt: 1 };
    const t = make({ runningWake: () => running, bot: () => ({ role: 'lead', template: 'developer', workspaceId: 'ws' }) }, facts, [guestHop, cleanHop]);
    setWakeTaint(t, () => running);
    expect(facts.filter(factVisibleToBot('bot-a')).map((f) => f.id)).toEqual(['f-c', 'f-pr']);
    running = { item: wake(guestReason), startedAt: 1 };
    expect(facts.filter(factVisibleToBot('bot-a')).map((f) => f.id)).toEqual(['f-g', 'f-c', 'f-x', 'f-pr']);
    // No running wake: not known to be a guest one.
    running = null;
    expect(facts.filter(factVisibleToBot('bot-a')).map((f) => f.id)).toEqual(['f-c', 'f-pr']);
    // No tracker where one is expected: only facts that carry no bot's or guest's words.
    setWakeTaint(null);
    expectWakeTaint();
    try {
      expect(facts.filter(factVisibleToBot('bot-a')).map((f) => f.id)).toEqual(['f-pr']);
    } finally {
      expectWakeTaint(false);
    }
  });

  it('the room\'s turn probe: a guest or unknown wake, or none running, is not known clean; untracked reads fail closed only where a tracker is expected', () => {
    let running: { item: WakeItem; startedAt: number } | null = { item: wake({ kind: 'human', text: 'hi', source: 'desktop' }), startedAt: 1 };
    const t = make({ runningWake: () => running });
    const probe = guestTurnProbeOf(t, () => running);
    expect(probe('bot-a')).toBe(false);
    running = { item: wake(guestReason), startedAt: 1 };
    expect(probe('bot-a')).toBe(true);
    running = null;
    expect(probe('bot-a')).toBe(true);
    expect(untrackedGuest()).toBe(false);
    expectWakeTaint();
    try {
      expect(untrackedGuest()).toBe('unknown');
    } finally {
      expectWakeTaint(false);
    }
  });

  it('a guest mark that cannot be written fails the send', () => {
    fs.writeFileSync(path.join(dir, 'factory'), 'not a folder');
    const t = make({ runningWake: () => ({ item: wake(guestReason), startedAt: 1 }) }, [], [handoff('h-1', fromBot)]);
    expect(t.markSent('h-1', 'bot-a')).toBeNull();
  });

  it('by wake id: a guest or unknown wake may not start work; one whose record is gone is unknown', () => {
    const items = new Map<string, WakeItem>([['w-1', wake({ kind: 'human', text: 'hi', source: 'desktop' })], ['w-g', { ...wake(guestReason), id: 'w-g' }]]);
    const t = make();
    setWakeTaint(t, () => null, (id) => items.get(id) ?? null);
    expect(guestOfWake('w-1')).toBe(false);
    expect(guestTurnRefusal('w-1')).toBeNull();
    expect(guestTurnRefusal('w-g')).toBe(GUEST_TURN_STARTS_NO_WORKERS);
    items.delete('w-1');
    expect(guestOfWake('w-1')).toBe('unknown');
    expect(guestTurnRefusal('w-1')).toBe(GUEST_TURN_STARTS_NO_WORKERS);
  });
});

describe('a guest workspace is an island', () => {
  const human = { kind: 'human' as const, text: 'go', source: 'desktop' as const };
  it('every wake there is a guest wake and tainted, the owner\'s own message included', () => {
    const t = make({ guestWorkspace: (ws) => ws === 'ws-g', bot: () => ({ role: 'lead', template: 'developer', workspaceId: 'ws-g' }) });
    const item = { ...wake(human), workspaceId: 'ws-g' };
    expect(t.wakeGuest(item)).toBe(true);
    expect(t.wakeTainted(item)).toBe(true);
    // The bot's stored workspace decides too, whatever the item names.
    expect(t.wakeGuest({ ...item, workspaceId: 'ws-a' })).toBe(true);
  });

  it('a bot\'s fact reads stay on its side of the boundary, in any wake', () => {
    const facts: Fact[] = [{ ...fact('f-g', 'pr.opened'), workspaceId: 'ws-g' }, { ...fact('f-a', 'pr.opened'), workspaceId: 'ws-a' }, fact('f-none', 'pr.opened')];
    const guestWs = (ws: string) => ws === 'ws-g';
    let botWs = 'ws-a';
    const running = { item: wake(human), startedAt: 1 };
    const t = make({ runningWake: () => running, guestWorkspace: guestWs, bot: () => ({ role: 'lead', template: 'developer', workspaceId: botWs }) }, facts);
    setWakeTaint(t, () => running);
    try {
      // The predicate factInIsland reads (a daemon record's workspace).
      noteGuestRecordWorkspaces(['ws-g']);
      expect(facts.filter(factVisibleToBot('bot-a')).map((f) => f.id)).toEqual(['f-a', 'f-none']);
      botWs = 'ws-g';
      expect(facts.filter(factVisibleToBot('bot-g')).map((f) => f.id)).toEqual(['f-g']);
    } finally {
      setWakeTaint(null);
      __resetGuestWorkspacesForTesting();
    }
  });

  it('a clean workspace keeps the record\'s answer; a missing bot or an unknown workspace is unknown', () => {
    const clean = make({ guestWorkspace: () => false, bot: () => ({ role: 'lead', template: 'developer', workspaceId: 'ws' }) });
    expect(clean.wakeGuest(wake(human))).toBe(false);
    expect(clean.wakeTainted(wake(human))).toBe(false);
    expect(make({ guestWorkspace: () => false, bot: () => null }).wakeGuest(wake(human))).toBe('unknown');
    expect(make({ guestWorkspace: () => 'unknown' }).wakeGuest(wake(human))).toBe('unknown');
    // A guest's own wake stays a guest wake whatever the workspace says.
    expect(make({ guestWorkspace: () => 'unknown' }).wakeGuest(wake({ kind: 'guest', guestId: '0b5f6a7e-1c2d-4e3f-8a9b-0c1d2e3f4a5b', guestName: 'G', cardId: 'c', text: 'x' }))).toBe(true);
  });
});
