import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { createFanoutCallerStopNotify, type WorkerLifecycleEvent } from '../fanoutCallerStopNotify';

let dir: string;
let ledger: TaskLedger;
let handler: (ev: WorkerLifecycleEvent) => void;
let runtime: boolean;
let brain: boolean;
let sent: unknown[][];

const stop = (over: Record<string, unknown> = {}) =>
  handler({ workspaceId: 'ws-task', kind: 'agent.stop', source: 'hook', decision: 'emit', seq: 9, ...over } as WorkerLifecycleEvent);

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-csn-'));
  ledger = new TaskLedger({ dir });
  await ledger.register({ id: 'wtask-1', taskWorkspaceId: 'ws-task', ownerWorkspaceId: 'ws-parent', title: 't' });
  runtime = false;
  brain = false;
  sent = [];
  handler = createFanoutCallerStopNotify({
    deckRuntimeActive: () => runtime,
    hasBrain: () => brain,
    notify: (...a) => { sent.push(a); },
    ledger,
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createFanoutCallerStopNotify', () => {
  it('with the deck runtime off, a worker stop or stop_failure points the caller at the task', () => {
    stop();
    stop({ kind: 'agent.stop_failure', seq: 10 });
    expect(sent).toEqual([
      ['ws-parent', 'ws-task', 'wtask-1', 'agent.stop', 9],
      ['ws-parent', 'ws-task', 'wtask-1', 'agent.stop_failure', 10],
    ]);
  });

  it('stands down while the deck runtime runs (it sends the pointer then)', () => {
    runtime = true;
    stop();
    expect(sent).toEqual([]);
  });

  it('keeps the existing filters: shell command ends, repeats, rejected candidates, awaiting input', () => {
    stop({ source: 'osc133' });
    stop({ decision: 'dedup' });
    stop({ decision: 'internal' });
    stop({ kind: 'agent.awaiting_input' });
    stop({ kind: 'agent.subagent_stop' });
    expect(sent).toEqual([]);
  });

  it('nothing for a brain-owned parent, a non-task workspace or a finished task', async () => {
    brain = true;
    stop();
    brain = false;
    stop({ workspaceId: 'ws-plain' });
    await ledger.closeTask('wtask-1');
    stop();
    expect(sent).toEqual([]);
  });

  it('a fan-out workspace the ledger never heard of is reconciled once, then told if its task is open', async () => {
    let reconciles = 0;
    handler = createFanoutCallerStopNotify({
      deckRuntimeActive: () => runtime,
      hasBrain: () => brain,
      notify: (...a) => { sent.push(a); },
      reconcile: async () => {
        reconciles++;
        await ledger.register({ id: 'wtask-late', taskWorkspaceId: 'ws-late', ownerWorkspaceId: 'ws-parent', title: 'late' });
      },
      isFanoutTask: (ws) => ws === 'ws-late',
      ledger,
    });
    stop({ workspaceId: 'ws-plain' }); // no lineage: no reconcile
    expect(reconciles).toBe(0);
    stop({ workspaceId: 'ws-late', seq: 11 });
    await new Promise((r) => setTimeout(r, 0));
    await ledger.flush();
    expect(reconciles).toBe(1);
    expect(sent).toEqual([['ws-parent', 'ws-late', 'wtask-late', 'agent.stop', 11]]);
  });
});
