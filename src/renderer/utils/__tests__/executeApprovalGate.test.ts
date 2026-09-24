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
  findPendingExecuteRequest,
  pauseApprovalCountdown,
  requestExecuteApproval,
  requestFanOutApproval,
} from '../executeApprovalGate';
import {
  EXECUTE_APPROVAL_HARD_CAP_MS,
  EXECUTE_APPROVAL_LAYER_MARGIN_MS,
  EXECUTE_APPROVAL_WINDOW_MS,
  EXECUTE_SEND_CLIENT_TIMEOUT_MS,
  EXECUTE_SEND_MAIN_TIMEOUT_MS,
} from '../../../shared/executeApprovalBounds';
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
      // operator's 30 seconds (up to the hard cap; see the queue test below).
      await vi.advanceTimersByTimeAsync(5_000);
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

  // #1462 — a caller that retried while its first request was still on the
  // prompt raised a second approval for the same work.
  const IDENTITY = {
    senderWorkspaceId: 'ws-from',
    senderPtyId: 'pty-sender',
    receiverWorkspaceId: 'ws-to',
    targetPtyId: 'pty-target',
    cwd: null,
    message: 'run the build',
  };

  it('lets a retry join the pending request and get its verdict, until it settles', async () => {
    const p = requestExecuteApproval({ ...INPUT, identity: IDENTITY });

    const pending = findPendingExecuteRequest(IDENTITY);
    expect(pending?.taskId).toBe('task-1');
    // Any difference in who, where or what is a different request.
    expect(findPendingExecuteRequest({ ...IDENTITY, message: 'run the build!' })).toBeUndefined();
    expect(findPendingExecuteRequest({ ...IDENTITY, senderPtyId: 'pty-other' })).toBeUndefined();
    expect(findPendingExecuteRequest({ ...IDENTITY, targetPtyId: 'pty-other' })).toBeUndefined();
    expect(findPendingExecuteRequest({ ...IDENTITY, receiverWorkspaceId: 'ws-other' })).toBeUndefined();
    expect(findPendingExecuteRequest({ ...IDENTITY, cwd: '/elsewhere' })).toBeUndefined();
    // Still exactly one prompt.
    expect(useStore.getState().pendingExecuteApprovalOrder).toHaveLength(1);

    resolveExecuteApproval(useStore.getState().pendingExecuteApprovalOrder[0], true);
    await expect(p).resolves.toBe(true);
    await expect(pending?.verdict).resolves.toBe(true);
    // Once answered, the same send is a new request again.
    expect(findPendingExecuteRequest(IDENTITY)).toBeUndefined();
  });

  // #1462 review — the dialog shows one prompt at a time and a queued prompt's
  // 30 s starts only when it is shown, so the second of two parallel sends
  // could stay pending past main's wait: a late approval would then create a
  // task with no worker. The cap ends it before main gives up.
  it('ends a queued prompt before main stops waiting, even if it was shown late', async () => {
    vi.useFakeTimers();
    try {
      const first = requestExecuteApproval({ ...INPUT, taskId: 'task-1' });
      const second = requestExecuteApproval({ ...INPUT, taskId: 'task-2', identity: IDENTITY });
      const [firstId, secondId] = useStore.getState().pendingExecuteApprovalOrder;

      // The first is on screen and answered after 20 s; only then is the
      // second shown.
      beginApprovalCountdown(firstId);
      await vi.advanceTimersByTimeAsync(20_000);
      resolveExecuteApproval(firstId, true);
      await expect(first).resolves.toBe(true);
      beginApprovalCountdown(secondId);

      // Its countdown shows what is actually left: the cap, not a fresh 30 s.
      expect(useStore.getState().pendingExecuteApprovals[secondId].expiresAt).toBe(
        Date.now() + (EXECUTE_APPROVAL_HARD_CAP_MS - 20_000),
      );

      let settledAt = 0;
      void second.then(() => { settledAt = Date.now(); });
      const queuedAt = Date.now() - 20_000;
      await vi.advanceTimersByTimeAsync(EXECUTE_APPROVAL_WINDOW_MS);
      await expect(second).resolves.toBe(false);
      // Answered inside main's wait, with margin to carry the reply there.
      expect(settledAt - queuedAt).toBe(EXECUTE_APPROVAL_HARD_CAP_MS);
      expect(settledAt - queuedAt).toBeLessThanOrEqual(
        EXECUTE_SEND_MAIN_TIMEOUT_MS - EXECUTE_APPROVAL_LAYER_MARGIN_MS,
      );
      // And the retry key went with it, so a resend raises a fresh prompt.
      expect(findPendingExecuteRequest(IDENTITY)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses a countdown when its surface goes away and restarts it fresh', async () => {
    vi.useFakeTimers();
    try {
      const p = requestExecuteApproval(INPUT);
      const [id] = useStore.getState().pendingExecuteApprovalOrder;
      beginApprovalCountdown(id);
      await vi.advanceTimersByTimeAsync(20_000);

      pauseApprovalCountdown(id);
      expect(useStore.getState().pendingExecuteApprovals[id].expiresAt).toBe(0);
      // Paused: the 30 s window cannot end it while nobody can see it.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(useStore.getState().pendingExecuteApprovalOrder).toEqual([id]);

      // Shown again at 35 s: the window would say 30 s, the cap leaves 5.
      beginApprovalCountdown(id);
      expect(useStore.getState().pendingExecuteApprovals[id].expiresAt).toBe(
        Date.now() + (EXECUTE_APPROVAL_HARD_CAP_MS - 35_000),
      );
      await vi.advanceTimersByTimeAsync(EXECUTE_APPROVAL_HARD_CAP_MS - 35_000);
      await expect(p).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

describe('execute approval bounds (#1462)', () => {
  it('orders the layers so each one answers before the one above gives up', () => {
    expect(EXECUTE_APPROVAL_WINDOW_MS).toBeLessThanOrEqual(EXECUTE_APPROVAL_HARD_CAP_MS);
    expect(EXECUTE_APPROVAL_HARD_CAP_MS + EXECUTE_APPROVAL_LAYER_MARGIN_MS).toBeLessThanOrEqual(
      EXECUTE_SEND_MAIN_TIMEOUT_MS,
    );
    expect(EXECUTE_SEND_MAIN_TIMEOUT_MS + EXECUTE_APPROVAL_LAYER_MARGIN_MS).toBeLessThanOrEqual(
      EXECUTE_SEND_CLIENT_TIMEOUT_MS,
    );
  });
});
