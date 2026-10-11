import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import {
  installFanoutWorkerWatch,
  WORKER_EXIT_SUMMARY,
  WORKER_IDLE_SUMMARY,
  WORKER_PTY_ENDED_SUMMARY,
  type FanoutWorkerWatch,
  type FanoutWorkerWatchPorts,
} from '../fanoutWorkerWatch';
import { installFanoutCallerLedgerNotify, notifyFanoutCaller, type FanoutCallerEvent } from '../fanoutCallerNotify';

const IDLE_MS = 15 * 60_000;

let dir: string;
let clock: number;
let ledger: TaskLedger;
let daemon: EventEmitter;
let running: Set<string>;
let watch: FanoutWorkerWatch | null;

function start(overrides: Partial<FanoutWorkerWatchPorts> = {}): FanoutWorkerWatch {
  watch = installFanoutWorkerWatch({
    getDaemonClient: () => daemon,
    resolveWorkspace: async (ptyId) => ({ 'pty-w1': 'ws-task1', 'pty-w2': 'ws-task2', 'pty-x': 'ws-task1' })[ptyId] ?? null,
    workspacePtyIds: (ws) => ({ 'ws-task1': ['pty-w1'], 'ws-task2': ['pty-w2'] })[ws] ?? null,
    isRunning: (ptyId) => running.has(ptyId),
    hasBrain: () => false,
    ledger,
    now: () => clock,
    exitGraceMs: 0,
    diedGraceMs: 0,
    ...overrides,
  });
  return watch;
}

async function register(id: string, taskWs: string): Promise<void> {
  await ledger.register({ id, taskWorkspaceId: taskWs, ownerWorkspaceId: 'ws-parent', title: id });
}

/** Let the exit path (0 ms grace) run to its ledger write. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  await ledger.flush();
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fww-'));
  clock = 1_000_000;
  ledger = new TaskLedger({ dir, now: () => clock });
  daemon = new EventEmitter();
  running = new Set();
  watch = null;
  await register('wtask-1', 'ws-task1');
  await register('wtask-2', 'ws-task2');
});

afterEach(() => {
  watch?.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('fan-out worker watch — exits', () => {
  it('an agent exit of a working worker moves its row to input_required once', async () => {
    start();
    daemon.emit('session:agentProcessExit', { sessionId: 'pty-w1' });
    await settle();
    const e = ledger.get('wtask-1')!;
    expect(e.status).toBe('input_required');
    expect(e.summary).toBe(WORKER_EXIT_SUMMARY);
    expect(e.updatedBy.kind).toBe('system');
    expect(ledger.get('wtask-2')!.status).toBe('working');
  });

  it('never wakes twice for the same task, even after it goes back to working', async () => {
    start();
    daemon.emit('session:agentProcessExit', { sessionId: 'pty-w1' });
    daemon.emit('session:died', { sessionId: 'pty-w1' });
    await settle();
    const e = ledger.get('wtask-1')!;
    expect(e.rev).toBe(2);
    await ledger.update({ id: 'wtask-1', status: 'working', actor: { kind: 'worker', workspaceId: 'ws-task1' }, expectedRev: e.rev });
    daemon.emit('session:died', { sessionId: 'pty-w1' });
    await settle();
    expect(ledger.get('wtask-1')!.status).toBe('working');
  });

  it('a PTY end flags with its own summary', async () => {
    start();
    daemon.emit('session:died', { sessionId: 'pty-w2' });
    await settle();
    expect(ledger.get('wtask-2')!.summary).toBe(WORKER_PTY_ENDED_SUMMARY);
  });

  it('an exit after the row left working (review_requested, completed) changes nothing', async () => {
    start();
    await ledger.update({ id: 'wtask-1', status: 'review_requested', actor: { kind: 'worker', workspaceId: 'ws-task1' }, expectedRev: 1 });
    daemon.emit('session:agentProcessExit', { sessionId: 'pty-w1' });
    await settle();
    expect(ledger.get('wtask-1')!.status).toBe('review_requested');
    expect(ledger.get('wtask-1')!.rev).toBe(2);
    await ledger.closeTask('wtask-2');
    daemon.emit('session:died', { sessionId: 'pty-w2' });
    await settle();
    expect(ledger.get('wtask-2')!.status).toBe('cancelled');
    expect(ledger.get('wtask-2')!.rev).toBe(2);
  });

  it('ignores an unknown PTY and a PTY that is not the worker pane', async () => {
    start();
    daemon.emit('session:agentProcessExit', { sessionId: 'pty-nobody' });
    // pty-x lives in ws-task1 but is not its only terminal and never ended a turn there.
    daemon.emit('session:died', { sessionId: 'pty-x' });
    await settle();
    expect(ledger.get('wtask-1')!.status).toBe('working');
  });

  it('a row that moved during the grace (rev conflict) is skipped', async () => {
    let release!: () => void;
    const gate = new Promise<boolean | undefined>((r) => { release = () => r(undefined); });
    start({ agentRunning: () => gate });
    daemon.emit('session:agentProcessExit', { sessionId: 'pty-w1' });
    await settle();
    // The worker writes its own row while the exit is being confirmed.
    await ledger.update({ id: 'wtask-1', status: 'input_required', actor: { kind: 'worker', workspaceId: 'ws-task1' }, expectedRev: 1 });
    await ledger.update({ id: 'wtask-1', status: 'working', actor: { kind: 'worker', workspaceId: 'ws-task1' }, expectedRev: 2 });
    release();
    await settle();
    const e = ledger.get('wtask-1')!;
    expect(e.status).toBe('working');
    expect(e.rev).toBe(3);
  });

  it('an agent that is running again after the grace is not an exit', async () => {
    start({ agentRunning: async () => true });
    daemon.emit('session:agentProcessExit', { sessionId: 'pty-w1' });
    await settle();
    expect(ledger.get('wtask-1')!.status).toBe('working');
  });

  it('never for an owner with a brain', async () => {
    start({ hasBrain: () => true });
    daemon.emit('session:agentProcessExit', { sessionId: 'pty-w1' });
    await settle();
    expect(ledger.get('wtask-1')!.status).toBe('working');
  });

  it('a PTY that a supervised restart brings back within the grace is not an end', async () => {
    start({ diedGraceMs: 30 });
    daemon.emit('session:died', { sessionId: 'pty-w1' });
    daemon.emit('session:restarted', { sessionId: 'pty-w1' });
    await new Promise((r) => setTimeout(r, 60));
    await settle();
    expect(ledger.get('wtask-1')!.status).toBe('working');
    // Not restarted: the end counts.
    daemon.emit('session:died', { sessionId: 'pty-w1' });
    await new Promise((r) => setTimeout(r, 60));
    await settle();
    expect(ledger.get('wtask-1')!.summary).toBe(WORKER_PTY_ENDED_SUMMARY);
  });

  it('an agent exit whose pane starts a running turn during the grace is not an exit', async () => {
    let release!: () => void;
    const gate = new Promise<boolean | undefined>((r) => { release = () => r(undefined); });
    start({ agentRunning: () => gate });
    daemon.emit('session:agentProcessExit', { sessionId: 'pty-w1' });
    await settle();
    running.add('pty-w1'); // a relaunched agent took a turn
    release();
    await settle();
    expect(ledger.get('wtask-1')!.status).toBe('working');
  });

  it('a running status left over from the killed turn does not hide the exit', async () => {
    running.add('pty-w1');
    start();
    daemon.emit('session:agentProcessExit', { sessionId: 'pty-w1' });
    await settle();
    expect(ledger.get('wtask-1')!.summary).toBe(WORKER_EXIT_SUMMARY);
  });

  it('a worker pane moved to another workspace no longer speaks for its task', async () => {
    let owner = 'ws-task1';
    start({ resolveWorkspace: async () => owner });
    watch!.noteLifecycle({ workspaceId: 'ws-task1', ptyId: 'pty-w1', kind: 'agent.stop', source: 'hook' });
    owner = 'ws-elsewhere';
    daemon.emit('session:died', { sessionId: 'pty-w1' });
    await settle();
    expect(ledger.get('wtask-1')!.status).toBe('working');
  });

  it('follows a daemon client that connects later, and detaches on dispose', async () => {
    let client: EventEmitter | null = null;
    const w = start({ getDaemonClient: () => client });
    client = daemon;
    await w.tick();
    expect(daemon.listenerCount('session:died')).toBe(1);
    w.dispose();
    watch = null;
    expect(daemon.listenerCount('session:died')).toBe(0);
    expect(daemon.listenerCount('session:agentProcessExit')).toBe(0);
  });
});

describe('fan-out worker watch — idle', () => {
  const stop = (ptyId = 'pty-w1', workspaceId = 'ws-task1') =>
    watch!.noteLifecycle({ workspaceId, ptyId, kind: 'agent.stop', source: 'hook' });

  it('fires once at the threshold and not again on later ticks', async () => {
    start();
    stop();
    clock += IDLE_MS - 1;
    await watch!.tick();
    expect(ledger.get('wtask-1')!.status).toBe('working');
    clock += 1;
    await watch!.tick();
    const e = ledger.get('wtask-1')!;
    expect(e.status).toBe('input_required');
    expect(e.summary).toBe(WORKER_IDLE_SUMMARY);
    // Back to working, idle again: the idle wake was already spent for this task.
    await ledger.update({ id: 'wtask-1', status: 'working', actor: { kind: 'worker', workspaceId: 'ws-task1' }, expectedRev: e.rev });
    stop();
    clock += IDLE_MS * 3;
    await watch!.tick();
    await watch!.tick();
    expect(ledger.get('wtask-1')!.status).toBe('working');
  });

  it('a new turn end restarts the clock; a running turn is never flagged', async () => {
    start();
    stop();
    clock += IDLE_MS - 60_000;
    stop();
    clock += 60_000;
    await watch!.tick();
    expect(ledger.get('wtask-1')!.status).toBe('working');
    running.add('pty-w1');
    clock += IDLE_MS;
    await watch!.tick();
    expect(ledger.get('wtask-1')!.status).toBe('working');
    running.delete('pty-w1');
    await watch!.tick();
    expect(ledger.get('wtask-1')!.status).toBe('input_required');
  });

  it('a row that moved after the last turn end counts from the move', async () => {
    start();
    stop();
    clock += IDLE_MS - 60_000;
    await ledger.update({ id: 'wtask-1', status: 'input_required', actor: { kind: 'worker', workspaceId: 'ws-task1' }, expectedRev: 1 });
    await ledger.update({ id: 'wtask-1', status: 'working', actor: { kind: 'worker', workspaceId: 'ws-task1' }, expectedRev: 2 });
    clock += 60_000;
    await watch!.tick();
    expect(ledger.get('wtask-1')!.status).toBe('working');
    clock += IDLE_MS;
    await watch!.tick();
    expect(ledger.get('wtask-1')!.status).toBe('input_required');
  });

  it('a shell command end or a finished row starts no clock', async () => {
    start();
    watch!.noteLifecycle({ workspaceId: 'ws-task1', ptyId: 'pty-w1', kind: 'agent.stop', source: 'osc133' });
    await ledger.update({ id: 'wtask-2', status: 'review_requested', actor: { kind: 'worker', workspaceId: 'ws-task2' }, expectedRev: 1 });
    stop('pty-w2', 'ws-task2');
    clock += IDLE_MS * 2;
    await watch!.tick();
    expect(ledger.get('wtask-1')!.status).toBe('working');
    expect(ledger.get('wtask-2')!.status).toBe('review_requested');
  });

  it('a second agent pane in the task workspace never takes the worker binding over', async () => {
    start({ workspacePtyIds: () => ['pty-w1', 'pty-x'] });
    stop('pty-w1');
    watch!.noteLifecycle({ workspaceId: 'ws-task1', ptyId: 'pty-x', kind: 'agent.stop', source: 'hook' });
    daemon.emit('session:died', { sessionId: 'pty-x' });
    await settle();
    expect(ledger.get('wtask-1')!.status).toBe('working');
    // The worker is busy while the other pane idles: no idle wake either.
    running.add('pty-x');
    clock += IDLE_MS;
    await watch!.tick();
    expect(ledger.get('wtask-1')!.status).toBe('working');
  });

  it('a pane seen ending a turn counts as the worker even beside other terminals', async () => {
    start({ workspacePtyIds: () => ['pty-x', 'pty-w1'] });
    watch!.noteLifecycle({ workspaceId: 'ws-task1', ptyId: 'pty-x', kind: 'agent.stop', source: 'hook' });
    daemon.emit('session:died', { sessionId: 'pty-w1' });
    await settle();
    expect(ledger.get('wtask-1')!.status).toBe('working');
    daemon.emit('session:died', { sessionId: 'pty-x' });
    await settle();
    expect(ledger.get('wtask-1')!.status).toBe('input_required');
  });
});

describe('fan-out worker watch → caller notify (integration)', () => {
  it('a killed worker agent sends exactly one ledger.input_required pointer to the caller pane', async () => {
    const sent: FanoutCallerEvent[] = [];
    const origin = { kind: 'pane' as const, paneId: 'pane-a', surfaceId: 'surf-a', label: 'w1 · caller' };
    const lineage: Record<string, { owner: string; origin?: typeof origin }> = {
      'ws-task1': { owner: 'ws-parent', origin },
      'ws-task2': { owner: 'ws-parent', origin },
    };
    const notify = vi.fn((owner: string, taskWs: string, taskId: string, kind: string, seq: number) => {
      notifyFanoutCaller(owner, taskWs, taskId, kind, seq, {
        lineageOf: (ws) => lineage[ws],
        send: (ev) => {
          sent.push(ev);
          return true;
        },
      });
    });
    const off = installFanoutCallerLedgerNotify(() => false, notify, ledger);
    try {
      start();
      daemon.emit('session:agentProcessExit', { sessionId: 'pty-w1' });
      // The shell then ends too: still one wake for this task.
      daemon.emit('session:died', { sessionId: 'pty-w1' });
      await settle();
      daemon.emit('session:agentProcessExit', { sessionId: 'pty-w1' });
      await settle();
      expect(sent).toEqual([
        {
          ownerWorkspaceId: 'ws-parent',
          taskWorkspaceId: 'ws-task1',
          taskId: 'wtask-1',
          kind: 'ledger.input_required',
          seq: 2,
          origin: { paneId: 'pane-a', surfaceId: 'surf-a' },
        },
      ]);
    } finally {
      off();
    }
  });
});
