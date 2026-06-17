import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createA2aSlice, type A2aSlice } from '../a2aSlice';
import type { Message } from '../../../../shared/types';
import type { PaneAddress } from '../../../hooks/a2aAddressing';

type TestState = A2aSlice;

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createA2aSlice(...args),
    }))
  );
}

function makeMessage(text: string): Message {
  return { kind: 'message', messageId: 'msg-1', role: 'user', parts: [{ kind: 'text', text }] };
}

describe('a2aSlice — cancelTask permissions', () => {
  let store: ReturnType<typeof createTestStore>;
  let taskId: string;

  beforeEach(() => {
    store = createTestStore();
    taskId = store.getState().createA2aTask({
      title: 'Test',
      from: { workspaceId: 'ws-sender', name: 'Sender' },
      to: { workspaceId: 'ws-receiver', name: 'Receiver' },
      history: [makeMessage('hello')],
      artifacts: [],
    });
  });

  it('allows the sender to cancel', () => {
    const result = store.getState().cancelTask(taskId, 'ws-sender');
    expect(result.ok).toBe(true);
    expect(store.getState().a2aTasks[taskId].status.state).toBe('canceled');
  });

  it('allows the receiver to cancel (deny incoming task)', () => {
    const result = store.getState().cancelTask(taskId, 'ws-receiver');
    expect(result.ok).toBe(true);
    expect(store.getState().a2aTasks[taskId].status.state).toBe('canceled');
  });

  it('rejects unrelated workspaces', () => {
    const result = store.getState().cancelTask(taskId, 'ws-stranger');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not sender or receiver/);
    expect(store.getState().a2aTasks[taskId].status.state).toBe('submitted');
  });

  it('rejects unknown task ids', () => {
    const result = store.getState().cancelTask('task-does-not-exist', 'ws-sender');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});

describe('a2aSlice — gcTerminalTasks hard cap (issue #99)', () => {
  // Mirrors the GC_MAX_TASKS constant in a2aSlice.ts (not exported).
  const GC_MAX_TASKS = 500;

  function seedTasks(store: ReturnType<typeof createTestStore>, count: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(
        store.getState().createA2aTask({
          title: `Task ${i}`,
          from: { workspaceId: 'ws-sender', name: 'Sender' },
          to: { workspaceId: 'ws-receiver', name: 'Receiver' },
          history: [makeMessage(`task ${i}`)],
          artifacts: [],
        }),
      );
    }
    return ids;
  }

  it('enforces GC_MAX_TASKS as a TRUE hard bound even when every task is non-terminal', () => {
    const store = createTestStore();
    const overflow = 10;
    seedTasks(store, GC_MAX_TASKS + overflow); // all 'submitted' (non-terminal)
    expect(Object.keys(store.getState().a2aTasks).length).toBe(GC_MAX_TASKS + overflow);

    store.getState().gcTerminalTasks();

    // Before the fix, the overflow branch only evicted terminal tasks, so a pile of
    // stuck non-terminal tasks could never be reclaimed. Now the cap is absolute.
    expect(Object.keys(store.getState().a2aTasks).length).toBe(GC_MAX_TASKS);
  });

  it('evicts terminal tasks before non-terminal ones when over the cap', () => {
    const store = createTestStore();
    const overflow = 10;
    const ids = seedTasks(store, GC_MAX_TASKS + overflow);

    // Cancel the first 5 → terminal ('canceled'). updatedAt is "now", so the 30-min
    // age prune does not touch them; only the overflow branch runs.
    const canceledIds = ids.slice(0, 5);
    for (const id of canceledIds) {
      const result = store.getState().cancelTask(id, 'ws-sender');
      expect(result.ok).toBe(true);
    }

    store.getState().gcTerminalTasks();

    const remaining = store.getState().a2aTasks;
    expect(Object.keys(remaining).length).toBe(GC_MAX_TASKS);
    // All 5 terminal tasks must be gone (evicted first), plus 5 oldest non-terminal.
    for (const id of canceledIds) {
      expect(remaining[id]).toBeUndefined();
    }
    const stillTerminal = Object.values(remaining).filter((t) =>
      ['completed', 'failed', 'canceled'].includes(t.status.state),
    );
    expect(stillTerminal.length).toBe(0);
  });
});

describe('a2aSlice — updateTaskStatus transitions (P3 message clarity)', () => {
  let store: ReturnType<typeof createTestStore>;
  let taskId: string;

  beforeEach(() => {
    store = createTestStore();
    taskId = store.getState().createA2aTask({
      title: 'Test',
      from: { workspaceId: 'ws-sender', name: 'Sender' },
      to: { workspaceId: 'ws-receiver', name: 'Receiver' },
      history: [makeMessage('hello')],
      artifacts: [],
    });
  });

  it('rejects submitted -> completed with allowed-next guidance (must go through working)', () => {
    const r = store.getState().updateTaskStatus(taskId, 'completed', 'ws-receiver');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid transition: submitted -> completed/);
    expect(r.error).toMatch(/working/); // surfaces the allowed next state
    expect(store.getState().a2aTasks[taskId].status.state).toBe('submitted'); // unchanged
  });

  it('allows submitted -> working (the gate is not over-tightened by the message change)', () => {
    const r = store.getState().updateTaskStatus(taskId, 'working', 'ws-receiver');
    expect(r.ok).toBe(true);
    expect(store.getState().a2aTasks[taskId].status.state).toBe('working');
  });

  it('allows working -> completed, then rejects completed -> working as terminal', () => {
    store.getState().updateTaskStatus(taskId, 'working', 'ws-receiver');
    const done = store.getState().updateTaskStatus(taskId, 'completed', 'ws-receiver');
    expect(done.ok).toBe(true);
    const r = store.getState().updateTaskStatus(taskId, 'working', 'ws-receiver');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/terminal state/);
  });

  it('keeps the receiver-permission gate ahead of the transition check', () => {
    const r = store.getState().updateTaskStatus(taskId, 'completed', 'ws-sender');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Permission denied/);
    expect(r.error).not.toMatch(/Invalid transition/); // permission fires first
  });
});

describe('a2aSlice — updateTaskStatus pane-granular authz (S-C2 P2)', () => {
  let store: ReturnType<typeof createTestStore>;
  const addrPaneB: PaneAddress = { ptyId: 'pty-B', paneId: 'pane-B', surfaceId: 'surf-B' };
  const addrPaneC: PaneAddress = { ptyId: 'pty-C', paneId: 'pane-C', surfaceId: 'surf-C' };

  // A pane-addressed task: receiver pinned to pane-B.
  function makePaneTask() {
    return store.getState().createA2aTask({
      title: 'Pane task',
      from: { workspaceId: 'ws-sender', name: 'Sender', paneId: 'pane-A', surfaceId: 'surf-A' },
      to: { workspaceId: 'ws-receiver', name: 'Receiver', paneId: 'pane-B', surfaceId: 'surf-B' },
      history: [makeMessage('hello')],
      artifacts: [],
    });
  }

  beforeEach(() => { store = createTestStore(); });

  it('WORKER-PATH (callerAddr absent) ⇒ ws-authz unconditionally — receiver ws completes a pane-addressed task', () => {
    // The headless ClaudeWorker reports working→completed with NO senderPtyId.
    // Gating on to.paneId would hang it in `working` forever; absent callerAddr
    // MUST fall through to ws-authz. This is the load-bearing P0/A5 guard.
    const taskId = makePaneTask();
    const working = store.getState().updateTaskStatus(taskId, 'working', 'ws-receiver'); // no callerAddr
    expect(working.ok).toBe(true);
    const done = store.getState().updateTaskStatus(taskId, 'completed', 'ws-receiver');
    expect(done.ok).toBe(true);
    expect(store.getState().a2aTasks[taskId].status.state).toBe('completed');
  });

  it('callerAddr on the ADDRESSED pane ⇒ allowed', () => {
    const taskId = makePaneTask();
    const r = store.getState().updateTaskStatus(taskId, 'working', 'ws-receiver', addrPaneB);
    expect(r.ok).toBe(true);
    expect(store.getState().a2aTasks[taskId].status.state).toBe('working');
  });

  it('callerAddr on a SIBLING pane (right ws, wrong pane) ⇒ rejected', () => {
    const taskId = makePaneTask();
    const r = store.getState().updateTaskStatus(taskId, 'working', 'ws-receiver', addrPaneC);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not the addressed receiver pane/);
    expect(store.getState().a2aTasks[taskId].status.state).toBe('submitted'); // unchanged
  });

  it('ws-only task (no to.paneId anchor) ⇒ ws-authz even when callerAddr is present', () => {
    const taskId = store.getState().createA2aTask({
      title: 'ws task',
      from: { workspaceId: 'ws-sender', name: 'Sender' },
      to: { workspaceId: 'ws-receiver', name: 'Receiver' },
      history: [makeMessage('hi')],
      artifacts: [],
    });
    const r = store.getState().updateTaskStatus(taskId, 'working', 'ws-receiver', addrPaneC);
    expect(r.ok).toBe(true);
  });

  it('wrong WORKSPACE is rejected before the pane check', () => {
    const taskId = makePaneTask();
    const r = store.getState().updateTaskStatus(taskId, 'working', 'ws-sender', addrPaneB);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not the receiver/);
  });
});

describe('a2aSlice — pendingExecuteApproval', () => {
  it('starts null and round-trips through setter', () => {
    const store = createTestStore();
    expect(store.getState().pendingExecuteApproval).toBeNull();

    store.getState().setPendingExecuteApproval({
      taskId: 'task-1',
      senderWorkspaceId: 'ws-from',
      receiverWorkspaceId: 'ws-to',
      messagePreview: 'hi',
      cwd: '/tmp',
      expiresAt: Date.now() + 30_000,
    });
    expect(store.getState().pendingExecuteApproval?.taskId).toBe('task-1');

    store.getState().setPendingExecuteApproval(null);
    expect(store.getState().pendingExecuteApproval).toBeNull();
  });
});
