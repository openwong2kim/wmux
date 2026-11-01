import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aTaskService, type A2aLogLike } from '../A2aTaskService';
import type { A2aCompanyMarkPayload } from '../../../shared/a2aEventlog';
import { COMPANY_BRIEF_KIND } from '../../../shared/company';
import { companyHoldOf, companyHoldPhase } from '../../../shared/companyHold';
import type { EventEnvelopeDraft } from '../../../shared/eventlog';
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
    expect(holdOf(svc, 'C')).toEqual({ blockedBy: ['A'], waitingOn: ['A'], blockerEnded: [{ id: 'A', state: 'failed' }] });
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
    expect(hold?.blockerEnded).toEqual([{ id: 'A', state: 'failed' }, { id: 'B', state: 'canceled' }]);
    expect(phaseOf(svc, 'C')).toBe('waiting');
    expect(svc.getTask('C')?.status.state).toBe('submitted');
    expect(companyMarks(log, 'C')).toHaveLength(2);
  });

  it('a failed blocker reopened and then completed releases the dependent and stops explaining the hold', async () => {
    const svc = newService(newLog());
    await assign(svc, 'A');
    await assign(svc, 'C', ['A']);
    await fail(svc, 'A');
    expect(holdOf(svc, 'C')?.blockerEnded).toEqual([{ id: 'A', state: 'failed' }]);
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
    expect(holdOf(svc, 'C')?.blockerEnded).toEqual([{ id: 'A', state: 'failed' }]);
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
