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
import { WakeTaint, runningWakeTainted, setWakeTaint, taskTainted, type WakeTaintPorts } from '../wakeTaint';

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
    const profiles: Record<string, { role: 'lead'; template: 'researcher' | 'developer' }> = {
      'bot-a': { role: 'lead', template: 'researcher' },
      'bot-b': { role: 'lead', template: 'developer' },
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
    const t = make({ bot: (id) => (id === 'bot-a' ? { role: 'lead', template: 'researcher' } : { role: 'lead', template: 'developer' }) },
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
    const kept: Handoff = { ...handoff('a-kept', fromBot), kind: 'ask_person', to: human };
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
    expect(t.markForward('h-fwd', { handoffIds: ['ans-pruned'] })).toBe(true);
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
