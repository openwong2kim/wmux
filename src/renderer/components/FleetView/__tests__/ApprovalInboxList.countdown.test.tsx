// @vitest-environment jsdom
//
// #1462 — with Fleet → Approvals open, AppLayout unmounts the execute dialog,
// which used to be the only thing that started an A2A prompt's auto-deny clock.
// The row read "auto-deny in 0s" from the moment it landed and never expired.
// This drives the real gate + store through a harness that derives the rows the
// way FleetView does, on fake timers so the countdown text is exact.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, useMemo } from 'react';
import ApprovalInboxList from '../ApprovalInboxList';
import { useStore } from '../../../stores';
import { selectApprovalInbox } from '../../../stores/selectors/approvalInbox';
import { requestExecuteApproval } from '../../../utils/executeApprovalGate';
import { resolveExecuteApproval } from '../../../utils/executeApproval';

/** Subscribes to the approval sources and derives the rows, as FleetView does. */
function Harness() {
  const mcpPrompts = useStore((s) => s.mcpPrompts);
  const mcpPromptOrder = useStore((s) => s.mcpPromptOrder);
  const pendingExecuteApprovals = useStore((s) => s.pendingExecuteApprovals);
  const pendingExecuteApprovalOrder = useStore((s) => s.pendingExecuteApprovalOrder);
  const browserHelpRequests = useStore((s) => s.browserHelpRequests);
  const browserHelpOrder = useStore((s) => s.browserHelpOrder);
  const items = useMemo(
    () => selectApprovalInbox({
      mcpPrompts, mcpPromptOrder, pendingExecuteApprovals, pendingExecuteApprovalOrder, browserHelpRequests, browserHelpOrder,
    }),
    [mcpPrompts, mcpPromptOrder, pendingExecuteApprovals, pendingExecuteApprovalOrder, browserHelpRequests, browserHelpOrder],
  );
  return <ApprovalInboxList items={items} focusedIdx={0} onResolve={() => undefined} />;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const r = createRoot(container);
  root = r;
  act(() => r.render(<Harness />));
  return container;
}

function unmount() {
  const r = root;
  if (r) act(() => r.unmount());
  container?.remove();
  root = null;
  container = null;
}

function requestExecute(taskId = 'task-1') {
  act(() => {
    void requestExecuteApproval({
      taskId,
      senderWorkspaceId: 'ws-from',
      receiverWorkspaceId: 'ws-to',
      messagePreview: 'run the build',
      cwd: null,
    });
  });
}

function resetGate() {
  const s = useStore.getState();
  s.setA2aAutoApproveExecute(false);
  for (const id of [...s.pendingExecuteApprovalOrder]) resolveExecuteApproval(id, false);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetGate();
});

afterEach(() => {
  unmount();
  resetGate();
  vi.useRealTimers();
});

describe('ApprovalInboxList — A2A execute countdown (#1462)', () => {
  it('starts the auto-deny clock itself and shows the same 30 s the dialog would', () => {
    const el = mount();
    requestExecute();

    const [approvalId] = useStore.getState().pendingExecuteApprovalOrder;
    // The inbox started the gate's clock (the dialog is not mounted)...
    expect(useStore.getState().pendingExecuteApprovals[approvalId].expiresAt).toBe(Date.now() + 30_000);
    // ...and never painted "0s" on the way there.
    expect(el.textContent).toContain('auto-deny in 30s');
    expect(el.textContent).not.toContain('auto-deny in 0s');
  });

  it('counts from the current time when the first deadline row arrives', async () => {
    // Open with nothing to count down: the tick is off, so the list's clock
    // is its mount time.
    const el = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });

    requestExecute();
    // Not "330s": the clock is refreshed before the first countdown paints.
    expect(el.textContent).toContain('auto-deny in 30s');
  });

  it('pauses the rows it was showing when it closes, so none expire unseen', () => {
    mount();
    requestExecute('task-1');
    requestExecute('task-2');
    const ids = [...useStore.getState().pendingExecuteApprovalOrder];
    for (const id of ids) expect(useStore.getState().pendingExecuteApprovals[id].expiresAt).toBeGreaterThan(0);

    unmount();
    for (const id of ids) expect(useStore.getState().pendingExecuteApprovals[id].expiresAt).toBe(0);
  });
});
