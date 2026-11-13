// A task another PC runs (ledger row with `remote`, task workspace
// `remote:<spawnId>`) reaches readers built for tasks that run here. Each
// returns early on it: no worker, no pane, no workspace here, and it does not
// count against this PC's live cap.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LedgerEntry } from '../../../shared/ledger';
import { computeHolders, holderCounts, type HolderSnapshot } from '../workerHolders';
import { WorkerSlots, WORKER_SLOTS_FILENAME } from '../workerSlots';
import { isReclaimableEnd, reclaimWorker, type WorkerReclaimPorts } from '../workerReclaim';
import { stopTaskWorker } from '../factoryWiring';
import { WorkerMessageLimiter, deliverWorkerMessage, type WorkerMessagePorts } from '../workerMessage';
import { botTaskView } from '../botTasks';
import { buildWorkspaceFacts } from '../../workspace/workspaceFactsFeed';
import type { TaskLedger } from '../../../daemon/ledger/TaskLedger';

const SPAWN = 'sp-0f6c1d2e-3a4b-4c5d-8e9f-0123456789ab';
const REMOTE: LedgerEntry = {
  schemaVersion: 1, id: 'wtask-r1', taskWorkspaceId: `remote:${SPAWN}`, ownerWorkspaceId: 'ws-owner', title: 'on the box',
  status: 'working', rev: 1, updatedAt: 1, updatedBy: { kind: 'system', workspaceId: 'daemon' },
  remote: { hostId: '0f1e2d3c-4b5a-4968-8776-655443322110', pc: 'box', spawnId: SPAWN, root: 'repo', state: 'started' },
} as LedgerEntry;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-remote-rows-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function snapshot(rows: LedgerEntry[]): HolderSnapshot {
  return {
    now: 10_000, rows, reclaimable: new Set(), catchupMs: 1_000, workspaces: new Set(['ws-other']), ptys: new Map(), stamps: new Map(),
    read: 'ok', readAt: 9_000, idle: new Set(), busy: new Set(), agentSeen: new Set(), gone: new Set(), records: [], verdicted: new Set(),
    taskOfWorkspace: () => null, taskOfPane: () => null, launchAt: () => undefined, launchOf: () => null, reservations: [], grants: [], heldWorkspaces: [],
  };
}

describe('a remote task row in readers of local tasks', () => {
  it('holds while open, outside the live cap', () => {
    const holders = computeHolders(snapshot([REMOTE]));
    expect(holders).toEqual([expect.objectContaining({ taskId: 'wtask-r1', state: 'held', why: 'remote' })]);
    expect(holderCounts(holders).live).toBe(0);
  });

  it('is not seeded as a worker slot', () => {
    const slots = new WorkerSlots(path.join(dir, 'factory', WORKER_SLOTS_FILENAME), () => [REMOTE], () => undefined);
    slots.load();
    expect(slots.launchOf('wtask-r1')).toBeNull();
    expect(slots.workspaceOf(REMOTE.taskWorkspaceId)).toBeNull();
  });

  it('is never reclaimed, stopped or written to as a bot worker', async () => {
    expect(isReclaimableEnd(REMOTE, 'cancelled')).toBe(false);
    const ports = { worktreeOf: () => { throw new Error('not reached'); } } as unknown as WorkerReclaimPorts;
    expect(await reclaimWorker(ports, REMOTE, 'cancelled')).toBeNull();
    expect(await stopTaskWorker(REMOTE, () => null)).toBe(0);
    const msgPorts = { row: () => REMOTE, livePane: async () => { throw new Error('not reached'); } } as unknown as WorkerMessagePorts;
    expect(await deliverWorkerMessage(msgPorts, new WorkerMessageLimiter(), 'bot-0000000b', { taskId: 'wtask-r1', text: 'hi' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(botTaskView(REMOTE, null)).toBeNull();
  });

  it('publishes no workspace fact', () => {
    const ledger = { list: () => [REMOTE] } as unknown as TaskLedger;
    const rows = buildWorkspaceFacts({ push: async () => undefined, ledger: () => ledger, autonomy: () => ({}) });
    expect(rows.some((r) => JSON.stringify(r).includes('remote:'))).toBe(false);
  });
});
