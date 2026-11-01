import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aTaskService, type A2aLogLike } from '../A2aTaskService';
import type { A2aCompanyMarkPayload } from '../../../shared/a2aEventlog';
import { COMPANY_BRIEF_KIND } from '../../../shared/company';
import { COMPANY_BLOCKED_BY_REFUSAL, COMPANY_BLOCKERS_MAX, companyHoldOf, companyHoldPhase } from '../../../shared/companyHold';
import { makeEnvelope, type EventEnvelopeDraft } from '../../../shared/eventlog';
import type { CompletionEvidence, Message } from '../../../shared/types';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-a2a-hold-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function newLog(): AppendOnlyLog {
  const log = new AppendOnlyLog({ dir, fsync: () => undefined });
  log.open();
  return log;
}

function newService(log: A2aLogLike, now?: () => number): A2aTaskService {
  return new A2aTaskService({ log, origin: { machineId: 'm1', daemonEpoch: 1 }, ...(now ? { now } : {}) });
}

const WS = 'ws-co';
const DONE: CompletionEvidence = { summary: 'done', items: [{ kind: 'inspection', status: 'verified', summary: 'checked' }] };

function brief(blockedBy?: string[]): Message {
  return {
    kind: 'message',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    parts: [
      { kind: 'text', text: 'please' },
      { kind: 'data', data: { kind: COMPANY_BRIEF_KIND, v: 1, goal: 'g', scope: 's', acceptance: 'a', verify: 'v', report: 'r', ...(blockedBy ? { blockedBy } : {}) } },
    ],
  };
}

/** The CEO (pane-ceo) briefs a seat (pane-s1) of the same company. */
async function assign(svc: A2aTaskService, id: string, blockedBy?: string[], to: { workspaceId: string; paneId?: string } = { workspaceId: WS, paneId: 'pane-s1' }) {
  const res = await svc.createTask({
    id,
    title: id,
    from: { workspaceId: WS, name: 'Co', paneId: 'pane-ceo' },
    to: { ...to, name: 'Co' },
    history: [brief(blockedBy)],
  });
  expect(res.ok).toBe(true);
  return res;
}

async function start(svc: A2aTaskService, id: string, ws = WS): Promise<void> {
  expect((await svc.transition({ taskId: id, to: 'working', callerWorkspaceId: ws })).ok).toBe(true);
}

/** Working, then marked done by the human's lane. */
async function complete(svc: A2aTaskService, id: string, ws = WS): Promise<void> {
  if (svc.getTask(id)?.status.state === 'submitted') await start(svc, id, ws);
  expect((await svc.transition({ taskId: id, to: 'completed', callerWorkspaceId: ws, trustedLane: true, evidence: DONE })).ok).toBe(true);
}

async function fail(svc: A2aTaskService, id: string, ws = WS): Promise<void> {
  if (svc.getTask(id)?.status.state === 'submitted') await start(svc, id, ws);
  expect((await svc.transition({ taskId: id, to: 'failed', callerWorkspaceId: ws, evidence: { summary: 'broke', items: [] } })).ok).toBe(true);
}

function companyMarks(log: A2aLogLike, taskId: string): A2aCompanyMarkPayload[] {
  return log
    .readAllRecords()
    .filter((r) => r.domain === 'a2a')
    .map((r) => r.payload as A2aCompanyMarkPayload)
    .filter((p) => p.kind === 'company.mark' && p.taskId === taskId);
}

const holdOf = (svc: A2aTaskService, id: string) => companyHoldOf(svc.getTask(id));
const endedAt = (svc: A2aTaskService, id: string) => svc.getTask(id)?.status.timestamp;
const phaseOf = (svc: A2aTaskService, id: string) => {
  const hold = holdOf(svc, id);
  return hold ? companyHoldPhase(hold) : undefined;
};

describe('company hold: at create', () => {
  it('holds a company task on its open blockers, deduped, with completed ones dropped', async () => {
    const svc = newService(newLog());
    await assign(svc, 'A');
    await assign(svc, 'B');
    await complete(svc, 'B');
    await assign(svc, 'C', ['A', 'B', 'A', 'ghost']);
    expect(holdOf(svc, 'C')).toEqual({ blockedBy: ['A', 'B', 'ghost'], waitingOn: ['A', 'ghost'] });
    expect(phaseOf(svc, 'C')).toBe('waiting');
  });

  it('does not hold a task with no blockers, with every blocker completed, or sent to another PC', async () => {
    const svc = newService(newLog());
    await assign(svc, 'A');
    await complete(svc, 'A');
    await assign(svc, 'free');
    await assign(svc, 'after', ['A']);
    await assign(svc, 'remote', ['ghost'], { workspaceId: 'remote:11111111-1111-4111-8111-111111111111' });
    for (const id of ['free', 'after', 'remote']) expect(svc.getTask(id)?.metadata.companyHold).toBeUndefined();
  });

  it('does not hold a task without a complete brief', async () => {
    const svc = newService(newLog());
    const res = await svc.createTask({
      id: 'plain',
      title: 'plain',
      from: { workspaceId: WS, name: 'Co' },
      to: { workspaceId: WS, name: 'Co' },
      history: [{ kind: 'message', messageId: 'm', role: 'user', parts: [{ kind: 'data', data: { kind: COMPANY_BRIEF_KIND, v: 1, goal: 'g', blockedBy: ['x'] } }] }],
    });
    expect(res.ok && res.task.metadata.companyHold).toBeUndefined();
  });

  it('notes a blocker that already ended failed', async () => {
    const svc = newService(newLog());
    await assign(svc, 'A');
    await fail(svc, 'A');
    await assign(svc, 'C', ['A']);
    expect(holdOf(svc, 'C')).toEqual({ blockedBy: ['A'], waitingOn: ['A'], blockerEnded: [{ id: 'A', state: 'failed', at: endedAt(svc, 'A') }] });
  });

  it('rides in the create payload', async () => {
    const log = newLog();
    const svc = newService(log);
    await assign(svc, 'A');
    await assign(svc, 'C', ['A']);
    const create = log.readAllRecords().map((r) => r.payload as { kind: string; task?: { id: string; metadata: Record<string, unknown> } })
      .find((p) => p.kind === 'task.create' && p.task?.id === 'C');
    expect(create?.task?.metadata.companyHold).toEqual({ blockedBy: ['A'], waitingOn: ['A'] });
  });
});

describe('company hold: release', () => {
  it('A and B in parallel, C on both: each completion appends one mark, the last releases', async () => {
    const log = newLog();
    const svc = newService(log);
    await assign(svc, 'A');
    await assign(svc, 'B');
    await assign(svc, 'C', ['A', 'B']);

    await complete(svc, 'A');
    expect(holdOf(svc, 'C')?.waitingOn).toEqual(['B']);
    expect(holdOf(svc, 'C')?.releasedAt).toBeUndefined();
    expect(companyMarks(log, 'C')).toHaveLength(1);

    await complete(svc, 'B');
    expect(holdOf(svc, 'C')?.waitingOn).toEqual([]);
    expect(holdOf(svc, 'C')?.releasedAt).toEqual(expect.any(String));
    expect(phaseOf(svc, 'C')).toBe('owed');
    expect(companyMarks(log, 'C').map((m) => m.drop)).toEqual(['A', 'B']);
  });

  it('two blockers completing back to back release once', async () => {
    const log = newLog();
    const svc = newService(log);
    await assign(svc, 'A');
    await assign(svc, 'B');
    await start(svc, 'A');
    await start(svc, 'B');
    await assign(svc, 'C', ['A', 'B']);
    const done = (id: string) => svc.transition({ taskId: id, to: 'completed', callerWorkspaceId: WS, trustedLane: true, evidence: DONE });
    const [a, b] = await Promise.all([done('A'), done('B')]);
    expect(a.ok && b.ok).toBe(true);
    const marks = companyMarks(log, 'C');
    expect(marks.map((m) => m.drop).sort()).toEqual(['A', 'B']);
    expect(holdOf(svc, 'C')?.waitingOn).toEqual([]);
    expect(holdOf(svc, 'C')?.releasedAt).toBe(marks[1].timestamp);
  });

  it('a blocker completing while the dependent is being created still releases it', async () => {
    const inner = newLog();
    let gateOpen: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const reachedP = new Promise<void>((r) => { reached = r; });
    const gated: A2aLogLike = {
      append(draft: EventEnvelopeDraft) {
        const p = draft.payload as { kind?: string; task?: { id?: string } };
        if (p.kind === 'task.create' && p.task?.id === 'C') {
          reached();
          return new Promise<boolean>((resolve) => { gateOpen = () => resolve(inner.append(draft)); });
        }
        return inner.append(draft);
      },
      readAllRecords: () => inner.readAllRecords(),
    };
    const svc = newService(gated);
    await assign(svc, 'A');
    await start(svc, 'A');
    const creating = svc.createTask({
      id: 'C', title: 'C', from: { workspaceId: WS, name: 'Co', paneId: 'pane-ceo' }, to: { workspaceId: WS, name: 'Co', paneId: 'pane-s1' }, history: [brief(['A'])],
    });
    await reachedP;
    // A completes while C's create is still being written: C is not in the projection yet.
    await complete(svc, 'A');
    expect(svc.getTask('C')).toBeUndefined();
    gateOpen();
    const created = await creating;
    expect(created.ok).toBe(true);
    expect(holdOf(svc, 'C')?.waitingOn).toEqual([]);
    expect(holdOf(svc, 'C')?.releasedAt).toEqual(expect.any(String));
    expect(companyMarks(gated, 'C').map((m) => m.drop)).toEqual(['A']);
  });

  it('a failed or canceled blocker is noted on the dependent, which stays held', async () => {
    const log = newLog();
    const svc = newService(log);
    await assign(svc, 'A');
    await assign(svc, 'B');
    await assign(svc, 'C', ['A', 'B']);
    await fail(svc, 'A');
    expect((await svc.cancelTask({ taskId: 'B', callerWorkspaceId: WS, callerPaneId: 'pane-ceo' })).ok).toBe(true);
    const hold = holdOf(svc, 'C');
    expect(hold?.waitingOn).toEqual(['A', 'B']);
    expect(hold?.blockerEnded).toEqual([{ id: 'A', state: 'failed', at: endedAt(svc, 'A') }, { id: 'B', state: 'canceled', at: endedAt(svc, 'B') }]);
    expect(phaseOf(svc, 'C')).toBe('waiting');
    expect(svc.getTask('C')?.status.state).toBe('submitted');
    expect(companyMarks(log, 'C')).toHaveLength(2);
  });

  it('a failed blocker reopened and then completed releases the dependent and stops explaining the hold', async () => {
    const svc = newService(newLog());
    await assign(svc, 'A');
    await assign(svc, 'C', ['A']);
    await fail(svc, 'A');
    expect(holdOf(svc, 'C')?.blockerEnded).toEqual([{ id: 'A', state: 'failed', at: endedAt(svc, 'A') }]);
    const reopened = await svc.reopenTask({ taskId: 'A', callerWorkspaceId: WS, callerPaneId: 'pane-ceo' });
    expect(reopened.ok && reopened.reopened).toBe(true);
    await complete(svc, 'A');
    const hold = holdOf(svc, 'C');
    expect(hold?.waitingOn).toEqual([]);
    expect(hold?.blockerEnded).toBeUndefined();
    expect(hold?.releasedAt).toEqual(expect.any(String));
  });

  it('a blocker failed by its workspace going away is noted too', async () => {
    const svc = newService(newLog());
    await assign(svc, 'A', undefined, { workspaceId: 'ws-gone', paneId: 'pane-x' });
    await assign(svc, 'C', ['A']);
    expect(await svc.failTasksForWorkspaceRemoved('ws-gone', 'workspace closed')).toBe(1);
    expect(holdOf(svc, 'C')?.blockerEnded).toEqual([{ id: 'A', state: 'failed', at: endedAt(svc, 'A') }]);
  });

  it('leaves an ended dependent alone', async () => {
    const log = newLog();
    const svc = newService(log);
    await assign(svc, 'A');
    await assign(svc, 'C', ['A']);
    expect((await svc.cancelTask({ taskId: 'C', callerWorkspaceId: WS, callerPaneId: 'pane-ceo' })).ok).toBe(true);
    await complete(svc, 'A');
    expect(companyMarks(log, 'C')).toHaveLength(0);
    expect(holdOf(svc, 'C')?.waitingOn).toEqual(['A']);
  });
});

describe('company hold: marks from main', () => {
  async function released(log: AppendOnlyLog) {
    const svc = newService(log);
    await assign(svc, 'A');
    await assign(svc, 'C', ['A']);
    await complete(svc, 'A');
    return svc;
  }

  it('attempted, then delivered with the pty written to', async () => {
    const log = newLog();
    const svc = await released(log);
    expect(svc.listCompanyPending().map((t) => t.id)).toEqual(['C']);
    expect((await svc.markCompany({ taskId: 'C', attempted: true })).ok).toBe(true);
    expect(holdOf(svc, 'C')?.attempted).toBe(true);
    // Still listed: main sees the attempt and never writes it again on its own.
    expect(svc.listCompanyPending().map((t) => t.id)).toEqual(['C']);
    expect((await svc.markCompany({ taskId: 'C', delivered: true, ptyId: 'pty-7' })).ok).toBe(true);
    expect(holdOf(svc, 'C')).toMatchObject({ delivered: true, ptyId: 'pty-7' });
    expect(holdOf(svc, 'C')?.attempted).toBeUndefined();
    expect(phaseOf(svc, 'C')).toBe('delivered');
    expect(svc.listCompanyPending()).toEqual([]);
    expect(svc.listCompanyHeld()).toEqual([]);
  });

  it('a refused write clears the attempt, and the task is owed again', async () => {
    const svc = await released(newLog());
    await svc.markCompany({ taskId: 'C', attempted: true });
    expect((await svc.markCompany({ taskId: 'C', attempted: false })).ok).toBe(true);
    expect(holdOf(svc, 'C')?.attempted).toBeUndefined();
    expect(svc.listCompanyPending().map((t) => t.id)).toEqual(['C']);
  });

  it('held leaves the pending list for the held list; a person can still have it delivered', async () => {
    const svc = await released(newLog());
    await svc.markCompany({ taskId: 'C', attempted: true });
    expect((await svc.markCompany({ taskId: 'C', held: 'no-agent' })).ok).toBe(true);
    expect(holdOf(svc, 'C')).toMatchObject({ held: 'no-agent' });
    expect(holdOf(svc, 'C')?.attempted).toBeUndefined();
    expect(svc.listCompanyPending()).toEqual([]);
    expect(svc.listCompanyHeld().map((t) => t.id)).toEqual(['C']);
    // An attempt does not matter on a held task.
    await svc.markCompany({ taskId: 'C', attempted: true });
    expect(holdOf(svc, 'C')?.attempted).toBeUndefined();
    expect((await svc.markCompany({ taskId: 'C', delivered: true })).ok).toBe(true);
    expect(holdOf(svc, 'C')?.held).toBeUndefined();
    expect(svc.listCompanyHeld()).toEqual([]);
  });

  it('retries append nothing, and delivered is final', async () => {
    const log = newLog();
    const svc = await released(log);
    const before = companyMarks(log, 'C').length;
    await svc.markCompany({ taskId: 'C', attempted: true });
    await svc.markCompany({ taskId: 'C', attempted: true });
    await svc.markCompany({ taskId: 'C', delivered: true, ptyId: 'pty-1' });
    await svc.markCompany({ taskId: 'C', delivered: true, ptyId: 'pty-1' });
    const late = await svc.markCompany({ taskId: 'C', held: 'pane-missing' });
    expect(late.ok).toBe(true);
    expect(holdOf(svc, 'C')?.held).toBeUndefined();
    expect(companyMarks(log, 'C')).toHaveLength(before + 2);
  });

  it('refuses a task still waiting, an ended task, and one that was never held', async () => {
    const svc = newService(newLog());
    await assign(svc, 'A');
    await assign(svc, 'C', ['A']);
    await assign(svc, 'free');
    const waiting = await svc.markCompany({ taskId: 'C', attempted: true });
    expect(!waiting.ok && waiting.error).toContain('still waiting on A');
    const never = await svc.markCompany({ taskId: 'free', delivered: true });
    expect(!never.ok && never.error).toContain('no held company task');
    await complete(svc, 'A');
    expect((await svc.cancelTask({ taskId: 'C', callerWorkspaceId: WS, callerPaneId: 'pane-ceo' })).ok).toBe(true);
    const ended = await svc.markCompany({ taskId: 'C', delivered: true });
    expect(!ended.ok && ended.error).toContain('has ended');
  });

  it('lists: a waiting task is held, not pending; ended tasks are never listed', async () => {
    const svc = newService(newLog());
    await assign(svc, 'A');
    await assign(svc, 'B');
    await assign(svc, 'C', ['A']);
    await assign(svc, 'D', ['B']);
    expect(svc.listCompanyHeld().map((t) => t.id).sort()).toEqual(['C', 'D']);
    expect(svc.listCompanyPending()).toEqual([]);
    await fail(svc, 'B');
    // D stays held on a blocker that failed; it is not owed a delivery.
    expect(svc.listCompanyHeld().map((t) => t.id).sort()).toEqual(['C', 'D']);
    expect(svc.listCompanyPending()).toEqual([]);
    expect((await svc.cancelTask({ taskId: 'D', callerWorkspaceId: WS, callerPaneId: 'pane-ceo' })).ok).toBe(true);
    expect(svc.listCompanyHeld().map((t) => t.id)).toEqual(['C']);
  });
});

describe('company hold: replay', () => {
  function restored(log: A2aLogLike, now?: () => number): A2aTaskService {
    const svc = newService(log, now);
    svc.restoreFromLog();
    return svc;
  }

  it('restores every marker as it was', async () => {
    const log = newLog();
    const svc = newService(log);
    await assign(svc, 'A');
    await assign(svc, 'B');
    await assign(svc, 'X');
    await assign(svc, 'C', ['A', 'B']);
    await assign(svc, 'D', ['A']);
    await assign(svc, 'E', ['X']);
    await assign(svc, 'F', ['A']);
    await complete(svc, 'A');
    await fail(svc, 'X');
    await svc.markCompany({ taskId: 'D', attempted: true });
    await svc.markCompany({ taskId: 'D', delivered: true, ptyId: 'pty-d' });
    await svc.markCompany({ taskId: 'F', held: 'pane-missing' });

    const again = restored(log);
    for (const id of ['C', 'D', 'E', 'F']) expect(holdOf(again, id)).toEqual(holdOf(svc, id));
    expect(again.listCompanyPending()).toEqual([]);
    expect(again.listCompanyHeld().map((t) => t.id).sort()).toEqual(['C', 'E', 'F']);
  });

  it('reconciles a drop mark that never reached the log', async () => {
    const inner = newLog();
    // The log refuses every company mark: the drop is lost, as if the daemon died before writing it.
    const lossy: A2aLogLike = {
      append: (draft) => ((draft.payload as { kind?: string }).kind === 'company.mark' ? Promise.resolve(false) : inner.append(draft)),
      readAllRecords: () => inner.readAllRecords(),
    };
    const svc = newService(lossy);
    await assign(svc, 'A');
    await assign(svc, 'B');
    await assign(svc, 'C', ['A']);
    await assign(svc, 'D', ['B']);
    await complete(svc, 'A');
    await fail(svc, 'B');
    expect(holdOf(svc, 'C')?.waitingOn).toEqual(['A']);
    expect(holdOf(svc, 'D')?.blockerEnded).toBeUndefined();

    const again = restored(inner);
    expect(holdOf(again, 'C')?.waitingOn).toEqual([]);
    expect(holdOf(again, 'C')?.releasedAt).toBe(again.getTask('A')?.status.timestamp);
    expect(again.listCompanyPending().map((t) => t.id)).toEqual(['C']);
    expect(holdOf(again, 'D')?.blockerEnded).toEqual([{ id: 'B', state: 'failed', at: endedAt(again, 'B') }]);
    // The same answer on every restore.
    expect(holdOf(restored(inner), 'C')).toEqual(holdOf(again, 'C'));
  });

  it('a task left attempted is not pending after a restore: it is held as delivery-unconfirmed', async () => {
    const log = newLog();
    const svc = newService(log);
    await assign(svc, 'A');
    await assign(svc, 'C', ['A']);
    await complete(svc, 'A');
    await svc.markCompany({ taskId: 'C', attempted: true });

    const again = restored(log);
    expect(again.listCompanyPending()).toEqual([]);
    expect(again.listCompanyHeld().map((t) => t.id)).toEqual(['C']);
    expect(holdOf(again, 'C')).toMatchObject({ held: 'delivery-unconfirmed' });
    expect(holdOf(again, 'C')?.attempted).toBeUndefined();
    // A person had it sent: delivered is taken on the held task.
    expect((await again.markCompany({ taskId: 'C', delivered: true })).ok).toBe(true);
    expect(holdOf(restored(log), 'C')).toMatchObject({ delivered: true });
  });

  it('evicting a completed blocker after the release leaves the dependent as it was', async () => {
    let clock = Date.parse('2026-11-01T00:00:00.000Z');
    const now = () => clock;
    const log = newLog();
    const svc = newService(log, now);
    await assign(svc, 'A');
    await assign(svc, 'C', ['A']);
    await complete(svc, 'A');
    const hold = structuredClone(holdOf(svc, 'C'));
    clock += 31 * 60 * 1000;
    svc.gcTerminalTasks();
    expect(svc.getTask('A')).toBeUndefined();
    expect(holdOf(svc, 'C')).toEqual(hold);

    const again = restored(log, now);
    expect(again.getTask('A')).toBeUndefined();
    expect(holdOf(again, 'C')).toEqual(hold);
    expect(again.listCompanyPending().map((t) => t.id)).toEqual(['C']);
  });

  it('records of a kind this build does not know, and marks for tasks without a hold, replay without error', async () => {
    const log = newLog();
    const svc = newService(log);
    await assign(svc, 'A');
    await assign(svc, 'C', ['A']);
    const auth = { principalId: WS, verifiedWorkspaceId: WS, trustTier: 'semi-trusted' as const };
    const origin = { machineId: 'm1', daemonEpoch: 1 };
    const ts = new Date().toISOString();
    for (const payload of [
      { kind: 'company.someday', taskId: 'C', timestamp: ts },
      { kind: 'company.mark', taskId: 'A', delivered: true, timestamp: ts },
      { kind: 'company.mark', taskId: 'nobody', drop: 'A', timestamp: ts },
    ]) {
      expect(await log.append(makeEnvelope({ domain: 'a2a', payload, origin, authContext: auth }))).toBe(true);
    }
    const again = restored(log);
    expect(again.getTask('A')?.metadata.companyHold).toBeUndefined();
    expect(holdOf(again, 'C')).toEqual({ blockedBy: ['A'], waitingOn: ['A'] });
    expect(again.getTask('nobody')).toBeUndefined();
  });
});

describe('company hold: the receiving side does not have a waiting task yet', () => {
  const ids = (tasks: { id: string }[]) => tasks.map((t) => t.id).sort();

  it('a query from the receiving side leaves it out; its sender and the human still see it with the marker', async () => {
    const svc = newService(newLog());
    await assign(svc, 'A');
    await assign(svc, 'C', ['A']);
    // The seat it is for, another seat, and a caller whose pane is unknown.
    for (const caller of [{ paneId: 'pane-s1' }, { paneId: 'pane-s2' }, {}]) {
      expect(ids(svc.queryTasks(WS, {}, caller))).toEqual(['A']);
      expect(svc.withheldTaskIds(WS, caller)).toEqual(['C']);
    }
    expect(svc.queryTasks(WS, { role: 'agent' }, { paneId: 'pane-s1' }).map((t) => t.id)).toEqual(['A']);
    const fromCeo = svc.queryTasks(WS, {}, { paneId: 'pane-ceo' }).find((t) => t.id === 'C');
    expect(fromCeo?.metadata.companyHold).toEqual({ blockedBy: ['A'], waitingOn: ['A'] });
    expect(svc.withheldTaskIds(WS, { paneId: 'pane-ceo' })).toEqual([]);
    expect(ids(svc.queryTasks(WS, {}, { trusted: true }))).toEqual(['A', 'C']);
  });

  it('once released the receiver sees it as any other task', async () => {
    const svc = newService(newLog());
    await assign(svc, 'A');
    await assign(svc, 'C', ['A']);
    await complete(svc, 'A');
    expect(ids(svc.queryTasks(WS, {}, { paneId: 'pane-s1' }))).toEqual(['A', 'C']);
    expect(svc.withheldTaskIds(WS, { paneId: 'pane-s1' })).toEqual([]);
  });

  it('across workspaces: the sending workspace sees it, the receiving one does not', async () => {
    const svc = newService(newLog());
    await assign(svc, 'A');
    const res = await svc.createTask({
      id: 'X',
      title: 'X',
      from: { workspaceId: 'ws-out', name: 'Out', paneId: 'pane-o' },
      to: { workspaceId: WS, name: 'Co', paneId: 'pane-ceo' },
      history: [brief(['A'])],
    });
    expect(res.ok).toBe(true);
    expect(ids(svc.queryTasks('ws-out', {}, {}))).toEqual(['X']);
    expect(ids(svc.queryTasks(WS, {}, { paneId: 'pane-ceo' }))).toEqual(['A']);
  });

  it('a state move from the receiving side is refused; the sender can still cancel it', async () => {
    const log = newLog();
    const svc = newService(log);
    await assign(svc, 'Atask123456');
    await assign(svc, 'C', ['Atask123456']);
    for (const to of ['working', 'input-required', 'failed'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one at a time
      const res = await svc.transition({
        taskId: 'C', to, callerWorkspaceId: WS, callerAddr: { paneId: 'pane-s1' }, callerCompanySeat: 'staff', evidence: { summary: 'x', items: [] },
      });
      expect(!res.ok && res.error).toBe('a2a.task.update: this task waits on Atask123; it is not yours until it completes');
    }
    // No pane: refused too, before any deferral.
    const noPane = await svc.transition({ taskId: 'C', to: 'working', callerWorkspaceId: WS, callerHasPaneIdentity: true });
    expect(!noPane.ok && noPane.error).toContain('it is not yours until it completes');
    expect(svc.getTask('C')?.status.state).toBe('submitted');
    expect((await svc.cancelTask({ taskId: 'C', callerWorkspaceId: WS, callerPaneId: 'pane-ceo' })).ok).toBe(true);
    expect(svc.getTask('C')?.status.state).toBe('canceled');
  });

  it('the receiver moves it once released, and the human lane at any time', async () => {
    const svc = newService(newLog());
    await assign(svc, 'A');
    await assign(svc, 'B');
    await assign(svc, 'C', ['A']);
    await assign(svc, 'D', ['B']);
    expect((await svc.transition({ taskId: 'D', to: 'working', callerWorkspaceId: WS, trustedLane: true })).ok).toBe(true);
    await complete(svc, 'A');
    expect((await svc.transition({ taskId: 'C', to: 'working', callerWorkspaceId: WS, callerAddr: { paneId: 'pane-s1' } })).ok).toBe(true);
  });
});

describe('company hold: a send main held for its blockers (holdForBlockers)', () => {
  async function heldSend(svc: A2aTaskService, id: string, blockedBy: string[]) {
    const res = await svc.createTask({
      id,
      title: id,
      from: { workspaceId: WS, name: 'Co', paneId: 'pane-ceo' },
      to: { workspaceId: WS, name: 'Co', paneId: 'pane-s1' },
      history: [brief(blockedBy)],
      holdForBlockers: true,
    });
    expect(res.ok).toBe(true);
    return res;
  }

  it('every blocker completed meanwhile: released at create and listed pending, the same after a restore', async () => {
    const log = newLog();
    const svc = newService(log);
    await assign(svc, 'A');
    await assign(svc, 'B');
    await complete(svc, 'A');
    await complete(svc, 'B');
    const res = await heldSend(svc, 'C', ['A', 'B']);
    const created = res.ok ? res.task.metadata.createdAt : '';
    expect(holdOf(svc, 'C')).toEqual({ blockedBy: ['A', 'B'], waitingOn: [], releasedAt: created });
    expect(svc.listCompanyPending().map((t) => t.id)).toEqual(['C']);
    expect(svc.listCompanyHeld()).toEqual([]);
    expect(companyMarks(log, 'C')).toEqual([]);

    const again = newService(log);
    again.restoreFromLog();
    expect(holdOf(again, 'C')).toEqual(holdOf(svc, 'C'));
    expect(again.listCompanyPending().map((t) => t.id)).toEqual(['C']);
  });

  it('one blocker still open: waiting as before', async () => {
    const svc = newService(newLog());
    await assign(svc, 'A');
    await assign(svc, 'B');
    await complete(svc, 'A');
    await heldSend(svc, 'C', ['A', 'B']);
    expect(holdOf(svc, 'C')).toEqual({ blockedBy: ['A', 'B'], waitingOn: ['B'] });
    expect(svc.listCompanyPending()).toEqual([]);
  });

  it('no flag and every blocker completed: no marker; the flag without blockers: no marker', async () => {
    const svc = newService(newLog());
    await assign(svc, 'A');
    await complete(svc, 'A');
    await assign(svc, 'C', ['A']);
    expect(svc.getTask('C')?.metadata.companyHold).toBeUndefined();
    await heldSend(svc, 'D', []);
    expect(svc.getTask('D')?.metadata.companyHold).toBeUndefined();
  });
});

describe('company hold: review fixes', () => {
  it('D1: a delivered task is never read as waiting, even when a lost drop and a compacted log leave a blocker in waitingOn', async () => {
    const log = newLog();
    const svc = newService(log);
    await assign(svc, 'A');
    await assign(svc, 'C', ['A']);
    await complete(svc, 'A');
    await svc.markCompany({ taskId: 'C', attempted: true });
    await svc.markCompany({ taskId: 'C', delivered: true, ptyId: 'pty-c' });
    // The log as a compaction could leave it: A's records and C's drop are gone.
    const compacted: A2aLogLike = {
      append: (draft) => log.append(draft),
      readAllRecords: () => log.readAllRecords().filter((r) => {
        const p = r.payload as { kind?: string; taskId?: string; task?: { id?: string }; drop?: string };
        return p.taskId !== 'A' && p.task?.id !== 'A' && p.drop === undefined;
      }),
    };
    const again = newService(compacted);
    again.restoreFromLog();
    expect(holdOf(again, 'C')).toMatchObject({ waitingOn: ['A'], delivered: true });
    expect(phaseOf(again, 'C')).toBe('delivered');
    expect(again.queryTasks(WS, {}, { paneId: 'pane-s1' }).map((t) => t.id)).toEqual(['C']);
    expect(again.withheldTaskIds(WS, { paneId: 'pane-s1' })).toEqual([]);
    expect(again.listCompanyHeld()).toEqual([]);
    expect((await again.markCompany({ taskId: 'C', delivered: true })).ok).toBe(true);
    expect((await again.transition({ taskId: 'C', to: 'working', callerWorkspaceId: WS, callerAddr: { paneId: 'pane-s1' } })).ok).toBe(true);
  });

  it('D2: a held send naming a blocker the daemon no longer has is refused; without the flag it is held as before', async () => {
    let clock = Date.parse('2026-11-01T00:00:00.000Z');
    const svc = newService(newLog(), () => clock);
    await assign(svc, 'A');
    await complete(svc, 'A');
    clock += 31 * 60 * 1000;
    svc.gcTerminalTasks();
    expect(svc.getTask('A')).toBeUndefined();
    const res = await svc.createTask({
      id: 'C', title: 'C', from: { workspaceId: WS, name: 'Co', paneId: 'pane-ceo' }, to: { workspaceId: WS, name: 'Co', paneId: 'pane-s1' },
      history: [brief(['A'])], holdForBlockers: true,
    });
    expect(!res.ok && res.error).toBe(`a2a.task.create: ${COMPANY_BLOCKED_BY_REFUSAL.gone('A')}`);
    expect(svc.getTask('C')).toBeUndefined();
    await assign(svc, 'D', ['A']);
    expect(holdOf(svc, 'D')?.waitingOn).toEqual(['A']);
  });

  it('D4: a drop the log refused is picked up by the next list, in memory', async () => {
    const inner = newLog();
    const lossy: A2aLogLike = {
      append: (draft) => ((draft.payload as { drop?: string }).drop !== undefined ? Promise.resolve(false) : inner.append(draft)),
      readAllRecords: () => inner.readAllRecords(),
    };
    const svc = newService(lossy);
    await assign(svc, 'A');
    await assign(svc, 'B');
    await assign(svc, 'C', ['A']);
    await assign(svc, 'D', ['B']);
    await complete(svc, 'A');
    await fail(svc, 'B');
    expect(holdOf(svc, 'C')?.waitingOn).toEqual(['A']);
    expect(svc.listCompanyHeld().map((t) => t.id)).toEqual(['D']);
    expect(holdOf(svc, 'C')).toMatchObject({ waitingOn: [], releasedAt: endedAt(svc, 'A') });
    expect(svc.listCompanyPending().map((t) => t.id)).toEqual(['C']);
    expect(companyMarks(inner, 'C')).toEqual([]);
    expect((await svc.markCompany({ taskId: 'C', attempted: true })).ok).toBe(true);
  });

  it('D5: more blockers than the limit, or the task itself, are refused for any caller', async () => {
    const svc = newService(newLog());
    const nine = Array.from({ length: COMPANY_BLOCKERS_MAX + 1 }, (_, i) => `t${i}`);
    const tooMany = await svc.createTask({
      id: 'C', title: 'C', from: { workspaceId: WS, name: 'Co', paneId: 'pane-ceo' }, to: { workspaceId: WS, name: 'Co', paneId: 'pane-s1' },
      history: [brief(nine)],
    });
    expect(!tooMany.ok && tooMany.error).toBe(`a2a.task.create: ${COMPANY_BLOCKED_BY_REFUSAL.tooMany(COMPANY_BLOCKERS_MAX + 1)}`);
    // Repeats count once.
    await assign(svc, 'D', [...nine.slice(0, COMPANY_BLOCKERS_MAX), 't0']);
    expect(holdOf(svc, 'D')?.blockedBy).toHaveLength(COMPANY_BLOCKERS_MAX);
    const self = await svc.createTask({
      id: 'E', title: 'E', from: { workspaceId: WS, name: 'Co', paneId: 'pane-ceo' }, to: { workspaceId: WS, name: 'Co', paneId: 'pane-s1' },
      history: [brief(['E'])],
    });
    expect(!self.ok && self.error).toBe(`a2a.task.create: ${COMPANY_BLOCKED_BY_REFUSAL.self('E')}`);
    expect(svc.getTask('C')).toBeUndefined();
    expect(svc.getTask('E')).toBeUndefined();
  });

  it('D6: each end of a blocker is noted with its time; an end after a reopen is a new note', async () => {
    let clock = Date.parse('2026-11-01T00:00:00.000Z');
    const log = newLog();
    const svc = newService(log, () => clock);
    await assign(svc, 'A');
    await assign(svc, 'C', ['A']);
    await fail(svc, 'A');
    const first = endedAt(svc, 'A');
    expect(holdOf(svc, 'C')?.blockerEnded).toEqual([{ id: 'A', state: 'failed', at: first }]);
    clock += 60_000;
    await svc.reopenTask({ taskId: 'A', callerWorkspaceId: WS, callerPaneId: 'pane-ceo' });
    await fail(svc, 'A');
    const second = endedAt(svc, 'A');
    expect(second).not.toBe(first);
    expect(holdOf(svc, 'C')?.blockerEnded).toEqual([{ id: 'A', state: 'failed', at: second }]);
    expect(companyMarks(log, 'C').map((m) => m.blockerEnded?.at)).toEqual([first, second]);
  });

  it('D6: a note written without its time still replays', async () => {
    const inner = newLog();
    // An older build: its notes carry no time.
    const older: A2aLogLike = {
      append: (draft) => {
        const p = draft.payload as { blockerEnded?: { at?: string } };
        if (p.blockerEnded) delete p.blockerEnded.at;
        return inner.append(draft);
      },
      readAllRecords: () => inner.readAllRecords(),
    };
    const svc = newService(older);
    await assign(svc, 'A');
    await assign(svc, 'C', ['A']);
    await fail(svc, 'A');
    expect(holdOf(svc, 'C')?.blockerEnded).toEqual([{ id: 'A', state: 'failed' }]);
    const again = newService(inner);
    again.restoreFromLog();
    expect(holdOf(again, 'C')).toMatchObject({ waitingOn: ['A'] });
    // Restore reads the old note, then notes the end again with its time.
    expect(holdOf(again, 'C')?.blockerEnded).toEqual([{ id: 'A', state: 'failed', at: endedAt(again, 'A') }]);
  });
});
