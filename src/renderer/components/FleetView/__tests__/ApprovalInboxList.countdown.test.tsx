// @vitest-environment jsdom
//
// #1462 — with Fleet → Approvals open, AppLayout unmounts the execute dialog,
// which used to be the only thing that started an A2A prompt's auto-deny clock.
// The row read "auto-deny in 0s" from the moment it landed and never expired.
// This drives the real gate + store: the inbox itself must start the clock, and
// must not print a countdown before it has one.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import ApprovalInboxList from '../ApprovalInboxList';
import { useStore } from '../../../stores';
import { selectApprovalInbox } from '../../../stores/selectors/approvalInbox';
import { requestExecuteApproval } from '../../../utils/executeApprovalGate';
import { resolveExecuteApproval } from '../../../utils/executeApproval';

const mounted: Array<() => void> = [];

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = () =>
    act(() =>
      root.render(
        <ApprovalInboxList items={selectApprovalInbox(useStore.getState())} focusedIdx={0} onResolve={() => undefined} />,
      ),
    );
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container, render };
}

function resetGate() {
  const s = useStore.getState();
  s.setA2aAutoApproveExecute(false);
  for (const id of [...s.pendingExecuteApprovalOrder]) resolveExecuteApproval(id, false);
}

beforeEach(resetGate);

afterEach(() => {
  while (mounted.length > 0) {
    try { mounted.pop()?.(); } catch { /* already unmounted */ }
  }
  resetGate();
});

describe('ApprovalInboxList — A2A execute countdown (#1462)', () => {
  it('starts the auto-deny clock itself and never shows "0s" for a fresh request', () => {
    void requestExecuteApproval({
      taskId: 'task-1',
      senderWorkspaceId: 'ws-from',
      receiverWorkspaceId: 'ws-to',
      messagePreview: 'run the build',
      cwd: null,
    });
    const [approvalId] = useStore.getState().pendingExecuteApprovalOrder;
    expect(useStore.getState().pendingExecuteApprovals[approvalId].expiresAt).toBe(0);

    const { container, render } = mount();
    render();
    // First paint: queued row, no deadline yet — no countdown rather than "0s".
    expect(container.textContent).not.toContain('auto-deny in 0s');

    // Mounting the inbox started the gate's clock (the dialog is not mounted).
    const expiresAt = useStore.getState().pendingExecuteApprovals[approvalId].expiresAt;
    expect(expiresAt).toBeGreaterThan(Date.now() + 25_000);

    // Next render reads the stamped deadline: the same ~30 s the dialog shows.
    render();
    // (29–31: the list's `now` is from mount until its first 250 ms tick.)
    expect(container.textContent).toMatch(/auto-deny in (29|30|31)s/);
  });
});
