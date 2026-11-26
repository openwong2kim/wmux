// #3068: a bulk cancel's dry run and the retention sweep, on the daemon's task log.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aTaskService } from '../A2aTaskService';

const DAY = 24 * 60 * 60 * 1000;
let dir: string;
let clock = Date.parse('2026-11-01T00:00:00Z');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-a2a-cleanup-'));
  clock = Date.parse('2026-11-01T00:00:00Z');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(): { log: AppendOnlyLog; svc: A2aTaskService } {
  const log = new AppendOnlyLog({ dir, fsync: () => undefined });
  log.open();
  return { log, svc: new A2aTaskService({ log, origin: { machineId: 'm1', daemonEpoch: 1 }, now: () => clock }) };
}

async function create(svc: A2aTaskService, id: string, from = 'ws-a', to = 'ws-b'): Promise<void> {
  const r = await svc.createTask({ id, title: id, from: { workspaceId: from, name: from }, to: { workspaceId: to, name: to } });
  expect(r.ok).toBe(true);
}

const cancels = (log: AppendOnlyLog) =>
  log.readAllRecords().filter((r) => (r.payload as { kind?: string }).kind === 'task.cancel');

describe('cancelTask dryRun', () => {
  it('runs the checks and appends nothing', async () => {
    const { log, svc } = setup();
    await create(svc, 't1');
    const r = await svc.cancelTask({ taskId: 't1', callerWorkspaceId: 'ws-a', dryRun: true });
    expect(r).toMatchObject({ ok: true, dryRun: true });
    expect(svc.getTask('t1')?.status.state).toBe('submitted');
    expect(cancels(log)).toHaveLength(0);
    // The same refusal as a real cancel for a workspace on neither side.
    const foreign = await svc.cancelTask({ taskId: 't1', callerWorkspaceId: 'ws-c', dryRun: true });
    expect(foreign).toEqual({ ok: false, error: 'a2a.task.cancel: caller ws-c is not sender or receiver' });
  });
});

describe('sweepStaleSubmitted', () => {
  it('closes old submitted tasks as their sender, leaves recent, reopened and started ones', async () => {
    const { log, svc } = setup();
    await create(svc, 'old');
    await create(svc, 'started');
    await create(svc, 'reopened');
    expect((await svc.transition({ taskId: 'started', to: 'working', callerWorkspaceId: 'ws-b' })).ok).toBe(true);
    clock += 10 * DAY;
    await create(svc, 'recent');
    // Ended, then reopened by its sender today: its clock starts again.
    expect((await svc.cancelTask({ taskId: 'reopened', callerWorkspaceId: 'ws-a' })).ok).toBe(true);
    expect((await svc.reopenTask({ taskId: 'reopened', callerWorkspaceId: 'ws-a' })).ok).toBe(true);
    clock += 1 * DAY;

    const swept = await svc.sweepStaleSubmitted(7 * DAY);

    expect(swept).toEqual({ closed: ['old'], refused: 0, seen: 1 });
    expect(svc.getTask('old')?.status.state).toBe('canceled');
    expect(svc.getTask('recent')?.status.state).toBe('submitted');
    expect(svc.getTask('reopened')?.status.state).toBe('submitted');
    expect(svc.getTask('started')?.status.state).toBe('working');
    // Logged as the workspace that sent it.
    const entry = cancels(log).find((r) => (r.payload as { taskId?: string }).taskId === 'old');
    expect(entry?.authContext.verifiedWorkspaceId).toBe('ws-a');
  });

  it('leaves a task another PC sent', async () => {
    const { svc } = setup();
    await create(svc, 'from-peer', 'remote:host1:ws-x');
    clock += 30 * DAY;
    expect(await svc.sweepStaleSubmitted(7 * DAY)).toEqual({ closed: [], refused: 0, seen: 0 });
    expect(svc.getTask('from-peer')?.status.state).toBe('submitted');
  });
});
