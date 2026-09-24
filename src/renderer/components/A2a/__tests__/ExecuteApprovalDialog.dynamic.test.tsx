// @vitest-environment jsdom
//
// The execute / fan-out / task approval prompt on the shared Dialog: it is an
// alertdialog answered only by its buttons (no Escape dismiss), focus starts
// on Deny so a stray Enter can only refuse, and the auto-deny countdown stays
// visible.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../../utils/executeApproval', () => ({ resolveExecuteApproval: vi.fn() }));
vi.mock('../../../utils/executeApprovalGate', () => ({ beginApprovalCountdown: vi.fn(), pauseApprovalCountdown: vi.fn() }));

import { useStore } from '../../../stores';
import { resolveExecuteApproval } from '../../../utils/executeApproval';
import ExecuteApprovalDialog from '../ExecuteApprovalDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const approval = {
  approvalId: 'ap-1',
  taskId: 'task-1',
  senderWorkspaceId: 'ws-a',
  receiverWorkspaceId: 'ws-b',
  messagePreview: 'run the tests',
  cwd: null,
  expiresAt: Date.now() + 20_000,
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(resolveExecuteApproval).mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.setState({ pendingExecuteApproval: null }));
});

describe('ExecuteApprovalDialog', () => {
  it('is an alertdialog with focus on Deny and a visible countdown', () => {
    act(() => useStore.setState({ pendingExecuteApproval: approval }));
    act(() => root.render(createElement(ExecuteApprovalDialog)));
    const panel = container.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement?.textContent).toBe('Deny');
    expect(container.querySelector('[data-approval-countdown]')?.textContent).toMatch(/\d+s/);
  });

  it('ignores Escape — the prompt is answered with a button', () => {
    act(() => useStore.setState({ pendingExecuteApproval: approval }));
    act(() => root.render(createElement(ExecuteApprovalDialog)));
    act(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(resolveExecuteApproval).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();

    const approve = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Approve')!;
    act(() => approve.click());
    expect(resolveExecuteApproval).toHaveBeenCalledWith('ap-1', true);
  });

  it('offers the auto-approve checkbox only for a plain execute request', () => {
    act(() => useStore.setState({ pendingExecuteApproval: approval }));
    act(() => root.render(createElement(ExecuteApprovalDialog)));
    expect(container.querySelector('[data-approval-auto-approve]')?.getAttribute('role')).toBe('checkbox');

    act(() => useStore.setState({ pendingExecuteApproval: { ...approval, fanout: { taskCount: 2, repoPath: '/repo' } } }));
    expect(container.querySelector('[data-approval-auto-approve]')).toBeNull();
  });
});
