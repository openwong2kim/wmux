import { describe, it, expect, beforeEach } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createA2aSlice, type A2aSlice } from '../a2aSlice';
import type { Message, CompletionEvidence } from '../../../../shared/types';
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

describe('a2aSlice — createA2aTask idempotency (A3: no completed-task resurrection)', () => {
  it('does not overwrite an existing task when re-created with the same id', () => {
    const store = createTestStore();
    const id = 'chmention-ch1-7'; // deterministic dedup key (channel-mention)
    store.getState().createA2aTask({
      id,
      title: 'mention',
      from: { workspaceId: 'ws-a', name: 'A' },
      to: { workspaceId: 'ws-b', name: 'B' },
      history: [makeMessage('hi')],
      artifacts: [],
    });
    // Drive it to a terminal state.
    store.getState().updateTaskStatus(id, 'working', 'ws-b');
    // Completion-evidence gate (PR-B) active: completed requires structured evidence — attach minimal client evidence.
    store.getState().updateTaskStatus(id, 'completed', 'ws-b', undefined, undefined, {
      summary: 'done',
      items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }],
    });
    expect(store.getState().a2aTasks[id].status.state).toBe('completed');
    // Re-delivery (reload / autoresponse re-flush) re-creates the SAME id. It
    // must NOT resurrect the completed task back to 'submitted'.
    const returned = store.getState().createA2aTask({
      id,
      title: 'mention (redelivered)',
      from: { workspaceId: 'ws-a', name: 'A' },
      to: { workspaceId: 'ws-b', name: 'B' },
      history: [makeMessage('hi again')],
      artifacts: [],
    });
    expect(returned).toBe(id);
    expect(store.getState().a2aTasks[id].status.state).toBe('completed'); // preserved
    expect(store.getState().a2aTasks[id].metadata.title).toBe('mention'); // not overwritten
  });

  it('still creates a fresh submitted task when the id is new', () => {
    const store = createTestStore();
    const id = store.getState().createA2aTask({
      title: 'fresh',
      from: { workspaceId: 'ws-a', name: 'A' },
      to: { workspaceId: 'ws-b', name: 'B' },
      history: [makeMessage('x')],
      artifacts: [],
    });
    expect(store.getState().a2aTasks[id].status.state).toBe('submitted');
  });
});

describe('a2aSlice — queryTasks updatedSince cursor (A9: incremental polling)', () => {
  it('returns only tasks updated strictly after the cursor; no cursor = all', () => {
    const store = createTestStore();
    const id = store.getState().createA2aTask({
      title: 't',
      from: { workspaceId: 'ws-a', name: 'A' },
      to: { workspaceId: 'ws-b', name: 'B' },
      history: [makeMessage('x')],
      artifacts: [],
    });
    const all = store.getState().queryTasks('ws-a', {});
    expect(all.map((t) => t.id)).toContain(id); // back-compat: no cursor → included
    // A cursor far in the past → the task is newer → included.
    expect(
      store.getState().queryTasks('ws-a', { updatedSince: '2000-01-01T00:00:00.000Z' }).map((t) => t.id),
    ).toContain(id);
    // A cursor in the future → nothing is newer → excluded.
    expect(store.getState().queryTasks('ws-a', { updatedSince: '2999-01-01T00:00:00.000Z' })).toHaveLength(0);
    // Cursor exactly at the task's updatedAt → strictly-after means excluded.
    const at = store.getState().a2aTasks[id].metadata.updatedAt;
    expect(store.getState().queryTasks('ws-a', { updatedSince: at })).toHaveLength(0);
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
    const done = store.getState().updateTaskStatus(taskId, 'completed', 'ws-receiver', undefined, undefined, {
      summary: 'done',
      items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }],
    });
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

describe('a2aSlice — updateTaskStatus completion-evidence persistence (§6.M P1 PR-D′, additive)', () => {
  let store: ReturnType<typeof createTestStore>;
  let taskId: string;

  const evidence: CompletionEvidence = {
    summary: 'done',
    items: [{ kind: 'inspection', status: 'unverified', summary: 'self-reported' }],
  };

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

  it('stores evidence verbatim on task.status.evidence when transition succeeds', () => {
    store.getState().updateTaskStatus(taskId, 'working', 'ws-receiver');
    const r = store.getState().updateTaskStatus(taskId, 'completed', 'ws-receiver', undefined, undefined, evidence);
    expect(r.ok).toBe(true);
    expect(store.getState().a2aTasks[taskId].status.evidence).toEqual(evidence);
  });

  it('omits status.evidence when evidence not provided (additive: absent on non-terminal transition)', () => {
    // Completion-evidence gate (PR-B) active: completed requires evidence, so test additive-absent
    // (omit when absent) on non-terminal transition (working), which gate does not cover.
    const r = store.getState().updateTaskStatus(taskId, 'working', 'ws-receiver');
    expect(r.ok).toBe(true);
    expect(store.getState().a2aTasks[taskId].status).not.toHaveProperty('evidence');
  });

  it('does not store evidence when transition is rejected (tied to success, not gate alone)', () => {
    // submitted -> completed is structurally rejected — status unchanged even with evidence passed.
    const r = store.getState().updateTaskStatus(taskId, 'completed', 'ws-receiver', undefined, undefined, evidence);
    expect(r.ok).toBe(false);
    expect(store.getState().a2aTasks[taskId].status.state).toBe('submitted');
    expect(store.getState().a2aTasks[taskId].status).not.toHaveProperty('evidence');
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
    const done = store.getState().updateTaskStatus(taskId, 'completed', 'ws-receiver', undefined, undefined, {
      summary: 'done',
      items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }],
    });
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

describe('a2aSlice — channel mention delivery tracking (P1 autoresponse)', () => {
  let store: ReturnType<typeof createTestStore>;
  beforeEach(() => { store = createTestStore(); });

  function mention(id: string, toWs = 'ws-me'): string {
    return store.getState().createA2aTask({
      id,
      title: '#general — mention from Alice',
      from: { workspaceId: 'ws-sender', name: 'Alice' },
      to: { workspaceId: toWs, name: 'Me' },
      history: [],
      artifacts: [],
    });
  }

  it('lists undelivered chmention- tasks addressed to the workspace', () => {
    mention('chmention-ch-1-5');
    const out = store.getState().getUndeliveredChannelMentionTasks('ws-me');
    expect(out.map((t) => t.id)).toEqual(['chmention-ch-1-5']);
  });

  it('excludes non-mention tasks (no chmention- prefix)', () => {
    mention('chmention-ch-1-5');
    store.getState().createA2aTask({
      id: 'task-normal',
      title: 'x',
      from: { workspaceId: 'ws-sender', name: 'A' },
      to: { workspaceId: 'ws-me', name: 'Me' },
      history: [],
      artifacts: [],
    });
    const out = store.getState().getUndeliveredChannelMentionTasks('ws-me');
    expect(out.map((t) => t.id)).toEqual(['chmention-ch-1-5']);
  });

  it('excludes a task once marked delivered (idempotency for the Stop flush)', () => {
    mention('chmention-ch-1-5');
    store.getState().markChannelMentionDelivered('chmention-ch-1-5');
    expect(store.getState().getUndeliveredChannelMentionTasks('ws-me')).toEqual([]);
  });

  it('excludes terminal-state mentions (already handled / canceled)', () => {
    mention('chmention-ch-1-5');
    store.getState().cancelTask('chmention-ch-1-5', 'ws-me'); // receiver denies → canceled
    expect(store.getState().getUndeliveredChannelMentionTasks('ws-me')).toEqual([]);
  });

  it('scopes to the receiver workspace (the sender ws does not see it as inbox)', () => {
    mention('chmention-ch-1-5', 'ws-me');
    expect(store.getState().getUndeliveredChannelMentionTasks('ws-sender')).toEqual([]);
  });

  it('prunes delivery markers for tasks removed by GC', () => {
    mention('chmention-ch-1-5');
    store.getState().markChannelMentionDelivered('chmention-ch-1-5');
    store.setState((s) => { delete s.a2aTasks['chmention-ch-1-5']; });
    store.getState().gcTerminalTasks();
    expect(store.getState().channelMentionDelivered['chmention-ch-1-5']).toBeUndefined();
  });
});

describe('a2aSlice — pendingExecuteApproval', () => {
  it('starts empty and round-trips through queue actions', () => {
    const store = createTestStore();
    expect(store.getState().pendingExecuteApproval).toBeNull();
    expect(store.getState().pendingExecuteApprovalOrder).toEqual([]);

    store.getState().enqueueExecuteApproval({
      approvalId: 'approval-1',
      taskId: 'task-1',
      senderWorkspaceId: 'ws-from',
      receiverWorkspaceId: 'ws-to',
      messagePreview: 'hi',
      cwd: '/tmp',
      expiresAt: Date.now() + 30_000,
    });
    expect(store.getState().pendingExecuteApproval?.taskId).toBe('task-1');
    expect(store.getState().pendingExecuteApprovalOrder).toEqual(['approval-1']);

    store.getState().removeExecuteApproval('approval-1');
    expect(store.getState().pendingExecuteApproval).toBeNull();
    expect(store.getState().pendingExecuteApprovalOrder).toEqual([]);
  });

  it('keeps the oldest approval as the legacy single prompt', () => {
    const store = createTestStore();
    store.getState().enqueueExecuteApproval({
      approvalId: 'approval-1',
      taskId: 'task-1',
      senderWorkspaceId: 'ws-from',
      receiverWorkspaceId: 'ws-to',
      messagePreview: 'one',
      cwd: null,
      expiresAt: Date.now() + 30_000,
    });
    store.getState().enqueueExecuteApproval({
      approvalId: 'approval-2',
      taskId: 'task-2',
      senderWorkspaceId: 'ws-from',
      receiverWorkspaceId: 'ws-to',
      messagePreview: 'two',
      cwd: null,
      expiresAt: Date.now() + 30_000,
    });

    expect(store.getState().pendingExecuteApproval?.approvalId).toBe('approval-1');
    store.getState().removeExecuteApproval('approval-1');
    expect(store.getState().pendingExecuteApproval?.approvalId).toBe('approval-2');
  });

  it('toggles global A2A execute auto-approve', () => {
    const store = createTestStore();
    expect(store.getState().a2aAutoApproveExecute).toBe(false);
    store.getState().setA2aAutoApproveExecute(true);
    expect(store.getState().a2aAutoApproveExecute).toBe(true);
  });
});

// ── envelope PR4(§6.M C6): verbatim cache apply of daemon commits ────────────────
// Contract: applyDaemonTaskUpdate re-runs neither authz, validateTransition, nor evidence —
// cache re-validation would reject daemon force-fail commits (out-of-graph transitions) and
// cause split-brain. Existing updateTaskStatus (validating writer) coexists as daemon-unavailable
// fallback (suites above keep pinning that semantic).
describe('a2aSlice — applyDaemonTaskUpdate (cache verbatim, C6)', () => {
  function makeTask(id: string, state: string, updatedAt: string) {
    return {
      kind: 'task' as const,
      id,
      status: { state: state as import('../../../../shared/types').TaskState, timestamp: updatedAt },
      history: [],
      artifacts: [],
      metadata: {
        title: 'T',
        from: { workspaceId: 'ws-sender', name: 'S' },
        to: { workspaceId: 'ws-receiver', name: 'R' },
        createdAt: updatedAt,
        updatedAt,
      },
    };
  }

  it('accepts out-of-graph transitions (submitted→failed, force-fail) without re-validation', () => {
    const store = createTestStore();
    const id = store.getState().createA2aTask({
      title: 'Test',
      from: { workspaceId: 'ws-sender', name: 'Sender' },
      to: { workspaceId: 'ws-receiver', name: 'Receiver' },
      history: [makeMessage('hello')],
      artifacts: [],
    });
    // Contrast: validating writer rejects this transition (VALID_TRANSITIONS: submitted→failed forbidden).
    const rejected = store.getState().updateTaskStatus(id, 'failed', 'ws-receiver');
    expect(rejected.ok).toBe(false);
    // Verbatim apply path accepts daemon commit as-is.
    store.getState().applyDaemonTaskUpdate(makeTask(id, 'failed', '2026-07-07T01:00:00.000Z'));
    expect(store.getState().getTask(id)?.status.state).toBe('failed');
    expect(store.getState().getTask(id)?.metadata.updatedAt).toBe('2026-07-07T01:00:00.000Z');
  });

  it('updates only status·updatedAt on existing tasks and preserves renderer-held history', () => {
    const store = createTestStore();
    const id = store.getState().createA2aTask({
      title: 'Test',
      from: { workspaceId: 'ws-sender', name: 'Sender' },
      to: { workspaceId: 'ws-receiver', name: 'Receiver' },
      history: [makeMessage('hello')],
      artifacts: [],
    });
    store.getState().addTaskMessage(id, makeMessage('increment'));
    const committed = makeTask(id, 'working', '2026-07-07T02:00:00.000Z');
    committed.status = {
      ...committed.status,
      evidence: { summary: 'ev', items: [] },
    } as (typeof committed)['status'];
    store.getState().applyDaemonTaskUpdate(committed);
    const task = store.getState().getTask(id);
    expect(task?.status.state).toBe('working');
    // Daemon commit evidence applied verbatim.
    expect(task?.status.evidence?.summary).toBe('ev');
    // Renderer-held incremental history (2 entries) is not overwritten by daemon snapshot (0 entries).
    expect(task?.history).toHaveLength(2);
  });

  it('upserts full snapshot on cache miss (daemon-restart survivor task)', () => {
    const store = createTestStore();
    store.getState().applyDaemonTaskUpdate(makeTask('task-survivor', 'completed', '2026-07-07T03:00:00.000Z'));
    const task = store.getState().getTask('task-survivor');
    expect(task).toBeDefined();
    expect(task?.status.state).toBe('completed');
    expect(task?.metadata.to.workspaceId).toBe('ws-receiver');
  });
});

// ── §6.M PR-B: completion-evidence gate (fallback writer) ──────────────────────────────
// When daemon soft-defers (pane-pin + senderPtyId, S-C2) or is unavailable, updateTaskStatus is
// final arbiter — forces structured evidence for completed/failed. Verbatim daemon commit apply
// (applyDaemonTaskUpdate) never gates (C6 — rejecting force-fail commit = split).
describe('a2aSlice — updateTaskStatus completion-evidence gate (§6.M PR-B, fallback writer)', () => {
  let store: ReturnType<typeof createTestStore>;
  let taskId: string;

  const compliant: CompletionEvidence = {
    summary: 'done',
    items: [{ kind: 'inspection', status: 'unverified', summary: 'ok' }],
  };

  beforeEach(() => {
    store = createTestStore();
    taskId = store.getState().createA2aTask({
      title: 'Test',
      from: { workspaceId: 'ws-sender', name: 'Sender' },
      to: { workspaceId: 'ws-receiver', name: 'Receiver' },
      history: [makeMessage('hello')],
      artifacts: [],
    });
    store.getState().updateTaskStatus(taskId, 'working', 'ws-receiver');
  });

  it('completed + no evidence → completion_evidence_missing rejection, state unchanged', () => {
    const r = store.getState().updateTaskStatus(taskId, 'completed', 'ws-receiver');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/completion_evidence_missing/);
    expect(store.getState().a2aTasks[taskId].status.state).toBe('working'); // no transition
  });

  it('completed + compliant evidence → pass + evidence stored', () => {
    const r = store.getState().updateTaskStatus(taskId, 'completed', 'ws-receiver', undefined, undefined, compliant);
    expect(r.ok).toBe(true);
    expect(store.getState().a2aTasks[taskId].status.state).toBe('completed');
    expect(store.getState().a2aTasks[taskId].status.evidence).toEqual(compliant);
  });

  it('failed + no evidence → failure_reason_missing rejection', () => {
    const r = store.getState().updateTaskStatus(taskId, 'failed', 'ws-receiver');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/failure_reason_missing/);
    expect(store.getState().a2aTasks[taskId].status.state).toBe('working');
  });

  it('failed + reason summary only (no items) → pass (asymmetric E3)', () => {
    const r = store.getState().updateTaskStatus(taskId, 'failed', 'ws-receiver', undefined, undefined, { summary: 'build broke', items: [] });
    expect(r.ok).toBe(true);
    expect(store.getState().a2aTasks[taskId].status.state).toBe('failed');
  });

  it('malformed evidence (unknown kind) rejected by fallback writer same as daemon (review GLM+Claude)', () => {
    // Assumes direct call bypassing bridge normalize — writer's own normalize is defense-in-depth.
    const hostile = { summary: 'x', items: [{ kind: 'bogus', status: 'passed', summary: 'y' }] } as unknown as CompletionEvidence;
    const r = store.getState().updateTaskStatus(taskId, 'completed', 'ws-receiver', undefined, undefined, hostile);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/completion_evidence_malformed/);
    expect(store.getState().a2aTasks[taskId].status.state).toBe('working');
  });

  it('writer normalize drops server-only stamp (recordedBy) before storage', () => {
    const withStamp = { ...compliant, recordedBy: 'forged:principal' } as CompletionEvidence;
    const r = store.getState().updateTaskStatus(taskId, 'completed', 'ws-receiver', undefined, undefined, withStamp);
    expect(r.ok).toBe(true);
    expect(store.getState().a2aTasks[taskId].status.evidence?.recordedBy).toBeUndefined();
  });

  it('applyDaemonTaskUpdate applies daemon force-fail commit verbatim without evidence (no gate, C6)', () => {
    // Fallback writer gates completed/failed, but daemon-committed force-fail snapshot (no evidence)
    // is applied verbatim without re-validation — re-validation would split-brain.
    store.getState().applyDaemonTaskUpdate({
      kind: 'task',
      id: taskId,
      status: { state: 'failed', timestamp: '2026-07-08T00:00:00.000Z' },
      history: [],
      artifacts: [],
      metadata: {
        title: 'Test',
        from: { workspaceId: 'ws-sender', name: 'Sender' },
        to: { workspaceId: 'ws-receiver', name: 'Receiver' },
        createdAt: '2026-07-08T00:00:00.000Z',
        updatedAt: '2026-07-08T00:00:00.000Z',
      },
    });
    expect(store.getState().a2aTasks[taskId].status.state).toBe('failed'); // accepted without evidence
  });
});
