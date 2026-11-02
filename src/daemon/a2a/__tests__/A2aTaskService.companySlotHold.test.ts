// Company mode: a brief main held because every working seat slot on this PC
// was taken (`holdForSlot`). The daemon keeps a released marker with no
// blockers, so the task is owed from the start and main's release bridge
// writes it once a slot frees.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aTaskService, type A2aLogLike, type CreateTaskInput } from '../A2aTaskService';
import { COMPANY_BRIEF_KIND } from '../../../shared/company';
import { companyHoldOf, companyHoldPhase } from '../../../shared/companyHold';
import type { Message } from '../../../shared/types';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-a2a-slot-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function newLog(): AppendOnlyLog {
  const log = new AppendOnlyLog({ dir, fsync: () => undefined });
  log.open();
  return log;
}

function newService(log: A2aLogLike): A2aTaskService {
  return new A2aTaskService({ log, origin: { machineId: 'm1', daemonEpoch: 1 } });
}

const WS = 'ws-co';

function firstMessage(withBrief = true, blockedBy?: string[]): Message {
  return {
    kind: 'message',
    messageId: `m-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    parts: [
      { kind: 'text', text: 'please' },
      ...(withBrief
        ? [{ kind: 'data' as const, data: { kind: COMPANY_BRIEF_KIND, v: 1, goal: 'g', scope: 's', acceptance: 'a', verify: 'v', report: 'r', ...(blockedBy ? { blockedBy } : {}) } }]
        : []),
    ],
  };
}

function slotHeld(id: string, over: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    id,
    title: id,
    from: { workspaceId: WS, name: 'Co', paneId: 'pane-ceo' },
    to: { workspaceId: WS, name: 'Co', paneId: 'pane-s1' },
    history: [firstMessage()],
    holdForSlot: true,
    ...over,
  };
}

describe('holdForSlot on create', () => {
  it('keeps a released marker with no blockers, listed pending and kept from the seat', async () => {
    const svc = newService(newLog());
    const res = await svc.createTask(slotHeld('C'));
    expect(res.ok).toBe(true);
    const hold = companyHoldOf(svc.getTask('C'));
    expect(hold).toEqual({ blockedBy: [], waitingOn: [], releasedAt: svc.getTask('C')?.metadata.createdAt });
    expect(hold && companyHoldPhase(hold)).toBe('owed');
    expect(svc.listCompanyPending().map((t) => t.id)).toEqual(['C']);
    expect(svc.listCompanyHeld()).toEqual([]);
    expect(svc.withheldTaskIds(WS, { paneId: 'pane-s1' })).toEqual(['C']);
    expect(svc.withheldTaskIds(WS, { paneId: 'pane-ceo' })).toEqual([]);
  });

  it('keeps it across a restore, and a write left unconfirmed then waits for a person', async () => {
    const log = newLog();
    const svc = newService(log);
    await svc.createTask(slotHeld('C'));
    await svc.createTask(slotHeld('D'));
    expect((await svc.markCompany({ taskId: 'D', attempted: true })).ok).toBe(true);
    const again = newService(log);
    again.restoreFromLog();
    expect(companyHoldOf(again.getTask('C'))).toEqual(companyHoldOf(svc.getTask('C')));
    expect(again.listCompanyPending().map((t) => t.id)).toEqual(['C']);
    expect(companyHoldOf(again.getTask('D'))).toMatchObject({ held: 'delivery-unconfirmed' });
  });

  it('is delivered like any released task, and is then its seat\'s', async () => {
    const svc = newService(newLog());
    await svc.createTask(slotHeld('C'));
    expect((await svc.markCompany({ taskId: 'C', attempted: true })).ok).toBe(true);
    expect((await svc.markCompany({ taskId: 'C', delivered: true, ptyId: 'pty-s1' })).ok).toBe(true);
    expect(svc.listCompanyPending()).toEqual([]);
    expect(svc.withheldTaskIds(WS, { paneId: 'pane-s1' })).toEqual([]);
    expect((await svc.transition({ taskId: 'C', to: 'working', callerWorkspaceId: WS, callerAddr: { paneId: 'pane-s1' } })).ok).toBe(true);
  });

  it('gives no marker to a task with no brief, or one with another PC', async () => {
    const svc = newService(newLog());
    await svc.createTask(slotHeld('P', { history: [firstMessage(false)] }));
    await svc.createTask(slotHeld('R', { to: { workspaceId: 'remote:11111111-1111-4111-8111-111111111111', name: 'pc-b' } }));
    expect(companyHoldOf(svc.getTask('P'))).toBeUndefined();
    expect(companyHoldOf(svc.getTask('R'))).toBeUndefined();
    expect(svc.listCompanyPending()).toEqual([]);
  });

  it('leaves a hold from blockers as it is', async () => {
    const svc = newService(newLog());
    await svc.createTask(slotHeld('A', { holdForSlot: undefined }));
    await svc.createTask(slotHeld('C', { history: [firstMessage(true, ['A'])] }));
    expect(companyHoldOf(svc.getTask('C'))).toEqual({ blockedBy: ['A'], waitingOn: ['A'] });
  });
});
