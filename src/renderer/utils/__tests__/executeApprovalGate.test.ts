// @vitest-environment jsdom
//
// Runtime coverage for the renderer-side execute approval gate. The
// useRpcBridge.a2aPaneIdentity test is structural (source-regex); this drives
// the actual Promise/queue/timer behavior so the gate's security-critical paths
// (YOLO short-circuit, approve, deny, 30s auto-deny, concurrent independence)
// are exercised end-to-end.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  beginApprovalCountdown,
  requestExecuteApproval,
  requestFanOutApproval,
} from '../executeApprovalGate';
import { useStore } from '../../stores';
import { resolveExecuteApproval, hasPendingExecuteApproval } from '../executeApproval';

const INPUT = {
  taskId: 'task-1',
  senderWorkspaceId: 'ws-from',
  receiverWorkspaceId: 'ws-to',
  messagePreview: 'run the build',
  cwd: null,
};

function resetGate() {
  const s = useStore.getState();
  s.setA2aAutoApproveExecute(false);
  for (const id of [...s.pendingExecuteApprovalOrder]) s.removeExecuteApproval(id);
}

describe('requestExecuteApproval (renderer execute gate)', () => {
  beforeEach(resetGate);

  it('short-circuits to approved when YOLO is on, enqueuing nothing', async () => {
    useStore.getState().setA2aAutoApproveExecute(true);
    await expect(requestExecuteApproval(INPUT)).resolves.toBe(true);
    expect(useStore.getState().pendingExecuteApprovalOrder).toHaveLength(0);
  });

  it('enqueues a prompt and resolves true when the user approves', async () => {
    const p = requestExecuteApproval(INPUT);
    const order = useStore.getState().pendingExecuteApprovalOrder;
    expect(order).toHaveLength(1);
    const approvalId = order[0];
    expect(hasPendingExecuteApproval(approvalId)).toBe(true);

    resolveExecuteApproval(approvalId, true);
    await expect(p).resolves.toBe(true);
    // settle() clears both the queue row and the parked resolver.
    expect(useStore.getState().pendingExecuteApprovalOrder).toHaveLength(0);
    expect(hasPendingExecuteApproval(approvalId)).toBe(false);
  });

  it('resolves false when the user denies', async () => {
    const p = requestExecuteApproval(INPUT);
    const approvalId = useStore.getState().pendingExecuteApprovalOrder[0];
    resolveExecuteApproval(approvalId, false);
    await expect(p).resolves.toBe(false);
    expect(useStore.getState().pendingExecuteApprovalOrder).toHaveLength(0);
  });

  it('auto-denies after the 30s timeout, counted from when the dialog showed it', async () => {
    vi.useFakeTimers();
    try {
      const p = requestExecuteApproval(INPUT);
      expect(useStore.getState().pendingExecuteApprovalOrder).toHaveLength(1);
      // The clock does not run until the prompt is on screen — the dialog
      // starts it. Time spent QUEUED behind another prompt is not the
      // operator's 30 seconds.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(useStore.getState().pendingExecuteApprovalOrder).toHaveLength(1);

      beginApprovalCountdown(useStore.getState().pendingExecuteApprovalOrder[0]);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(p).resolves.toBe(false);
      expect(useStore.getState().pendingExecuteApprovalOrder).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // The bug this replaced: a prompt queued behind another one burned its whole
  // 30 s unseen and auto-denied — a refusal nobody made, reported to the caller
  // as if a person had let it lapse.
  it('does not expire a prompt that is still queued behind another', async () => {
    vi.useFakeTimers();
    try {
      const first = requestExecuteApproval({ ...INPUT, taskId: 'task-1' });
      const second = requestExecuteApproval({ ...INPUT, taskId: 'task-2' });
      const [firstId, secondId] = useStore.getState().pendingExecuteApprovalOrder;

      // Only the head is on screen, so only the head's clock runs.
      beginApprovalCountdown(firstId);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(first).resolves.toBe(false);
      expect(useStore.getState().pendingExecuteApprovalOrder).toEqual([secondId]);

      // The second one still has its full budget, starting now.
      beginApprovalCountdown(secondId);
      resolveExecuteApproval(secondId, true);
      await expect(second).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps two concurrent requests independent', async () => {
    const p1 = requestExecuteApproval({ ...INPUT, taskId: 'task-1' });
    const p2 = requestExecuteApproval({ ...INPUT, taskId: 'task-2' });
    const order = [...useStore.getState().pendingExecuteApprovalOrder];
    expect(order).toHaveLength(2);

    // Approve the second, deny the first — identities must not cross.
    resolveExecuteApproval(order[1], true);
    resolveExecuteApproval(order[0], false);
    await expect(p2).resolves.toBe(true);
    await expect(p1).resolves.toBe(false);
    expect(useStore.getState().pendingExecuteApprovalOrder).toHaveLength(0);
  });
});

// ── Fan-out gate ──────────────────────────────────────────────────────────
//
// Fan-out shares this queue, dialog and timer with the A2A execute gate but NOT
// its consent. `a2aAutoApproveExecute` is the user agreeing that an agent may
// spawn a background agent; it is not the user agreeing that an agent may
// create N git worktrees and branches in their repository.
const FANOUT_INPUT = {
  workspaceId: 'ws-caller',
  repoPath: '/repo',
  taskCount: 3,
  messagePreview: 'refactor the parser',
};

describe('requestFanOutApproval (pipe/MCP fan-out gate)', () => {
  beforeEach(resetGate);

  it('still asks even when the A2A auto-approve toggle is on', async () => {
    useStore.getState().setA2aAutoApproveExecute(true);
    const p = requestFanOutApproval(FANOUT_INPUT);
    const order = useStore.getState().pendingExecuteApprovalOrder;
    // The execute gate short-circuits here and enqueues nothing; fan-out must not.
    expect(order).toHaveLength(1);
    resolveExecuteApproval(order[0], true);
    await expect(p).resolves.toEqual({ approved: true, outcome: 'approved' });
  });

  it('carries the fan-out shape so the dialog can describe what really happens', async () => {
    const p = requestFanOutApproval(FANOUT_INPUT);
    const approvalId = useStore.getState().pendingExecuteApprovalOrder[0];
    const row = useStore.getState().pendingExecuteApproval;
    expect(row?.fanout).toEqual({ taskCount: 3, repoPath: '/repo' });
    resolveExecuteApproval(approvalId, false);
    await p;
  });

  it('reports a user denial as declined', async () => {
    const p = requestFanOutApproval(FANOUT_INPUT);
    resolveExecuteApproval(useStore.getState().pendingExecuteApprovalOrder[0], false);
    await expect(p).resolves.toEqual({ approved: false, outcome: 'declined' });
  });

  it('reports an unattended auto-deny as timeout, not declined', async () => {
    // The wire caller has already been told "accepted", so the distinction is
    // what a fleet running overnight sees on its next poll.
    vi.useFakeTimers();
    try {
      const p = requestFanOutApproval(FANOUT_INPUT);
      beginApprovalCountdown(useStore.getState().pendingExecuteApprovalOrder[0]);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(p).resolves.toEqual({ approved: false, outcome: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
