// @vitest-environment jsdom
//
// The execute / fan-out / task approval prompt on the shared Dialog. It opens
// by itself, so it must never be answered by keys or clicks the user meant for
// something else: it leaves focus where it was, ignores activation for a short
// window after it appears, starts fresh for each queued prompt, and never
// takes the keyboard from a dialog the user has open.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../../utils/executeApproval', () => ({ resolveExecuteApproval: vi.fn() }));
vi.mock('../../../utils/executeApprovalGate', () => ({ beginApprovalCountdown: vi.fn(), pauseApprovalCountdown: vi.fn() }));

import { useStore } from '../../../stores';
import { resolveExecuteApproval } from '../../../utils/executeApproval';
import { APPROVAL_ACTIVATION_DELAY_MS } from '../../Approval/useActivationGuard';
import Dialog, { DialogFooter, DialogHeader } from '../../ui/Dialog';
import ExecuteApprovalDialog from '../ExecuteApprovalDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Records the countdown text of every commit that shows a prompt, including
// commits a later effect would correct before the next tick.
const committedCountdowns: string[] = [];
function CountdownProbe() {
  useStore((s) => s.pendingExecuteApproval);
  useLayoutEffect(() => {
    const text = container.querySelector('[data-approval-countdown]')?.textContent;
    if (text) committedCountdowns.push(text);
  });
  return null;
}

let container: HTMLDivElement;
let root: Root;
let terminal: HTMLTextAreaElement;

const approval = (id: string, extra: Record<string, unknown> = {}) => ({
  approvalId: id,
  taskId: `task-${id}`,
  senderWorkspaceId: 'ws-a',
  receiverWorkspaceId: 'ws-b',
  messagePreview: 'run the tests',
  cwd: null,
  expiresAt: Date.now() + 20_000,
  ...extra,
});

const show = (a: ReturnType<typeof approval> | null) => act(() => useStore.setState({ pendingExecuteApproval: a } as never));
const button = (label: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement;
const press = (k: string) => {
  const target = (document.activeElement ?? document.body) as HTMLElement;
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
  // jsdom does not activate a focused button on Enter / Space; do what a
  // browser would, so a focused button left over from an earlier prompt shows.
  if ((k === 'Enter' || k === ' ') && target instanceof HTMLButtonElement) act(() => target.click());
};
const later = () => vi.setSystemTime(Date.now() + APPROVAL_ACTIVATION_DELAY_MS + 50);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  terminal = document.createElement('textarea');
  terminal.className = 'xterm-helper-textarea';
  document.body.appendChild(terminal);
  terminal.focus();
  vi.mocked(resolveExecuteApproval).mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  terminal.remove();
  show(null);
  vi.useRealTimers();
});

describe('ExecuteApprovalDialog', () => {
  it('arrives as an alertdialog without taking focus from the terminal', () => {
    act(() => root.render(createElement(ExecuteApprovalDialog)));
    show(approval('a'));
    const panel = container.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(terminal);
    expect(container.querySelector('[data-approval-countdown]')?.textContent).toMatch(/\d+s/);

    // Keys meant for the terminal answer nothing — including Escape.
    press('Enter');
    press(' ');
    press('Escape');
    expect(resolveExecuteApproval).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(terminal);
  });

  it('ignores a click that lands just as it appears, then accepts one', () => {
    act(() => root.render(createElement(ExecuteApprovalDialog)));
    show(approval('a'));
    act(() => button('Approve').click());
    act(() => button('Deny').click());
    expect(resolveExecuteApproval).not.toHaveBeenCalled();
    later();
    act(() => button('Approve').click());
    expect(resolveExecuteApproval).toHaveBeenCalledWith('a', true);
  });

  it('starts fresh for the next queued prompt: an Enter after approving A does not approve B', () => {
    act(() => root.render(createElement(ExecuteApprovalDialog)));
    show(approval('a'));
    later();
    const approveA = button('Approve');
    approveA.focus();
    act(() => approveA.click());
    expect(resolveExecuteApproval).toHaveBeenLastCalledWith('a', true);

    // The next prompt in the queue takes the dialog's place.
    show(approval('b', { fanout: { taskCount: 3, repoPath: '/repo' } }));
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('/repo');
    // Past B's own activation window, so only focus decides what Enter does.
    later();
    expect(container.contains(document.activeElement)).toBe(false);
    press('Enter');
    expect(resolveExecuteApproval).toHaveBeenCalledTimes(1);
  });

  it('does not take the keyboard from a dialog the user has open', () => {
    const closeUserDialog = vi.fn();
    const userDialog = createElement(
      Dialog,
      { onClose: closeUserDialog, zIndexClassName: 'z-[var(--z-modal-top)]' },
      createElement(DialogHeader, { title: 'Paired devices', closeLabel: 'Close' }),
      createElement(DialogFooter, null, createElement('button', { 'data-id': 'done' }, 'Done')),
    );
    act(() => root.render(createElement('div', null, userDialog)));
    const done = container.querySelector('[data-id="done"]') as HTMLButtonElement;
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');

    act(() => root.render(createElement('div', null, userDialog, createElement(ExecuteApprovalDialog))));
    show(approval('a'));
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    // Focus, Tab and Escape all stay with the user's dialog.
    done.focus();
    press('Tab');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    press('Escape');
    expect(closeUserDialog).toHaveBeenCalledTimes(1);
    expect(resolveExecuteApproval).not.toHaveBeenCalled();
  });

  it('counts the next prompt down from a fresh clock, not the one the last prompt left', () => {
    act(() => root.render(createElement('div', null, createElement(ExecuteApprovalDialog), createElement(CountdownProbe))));
    show(approval('a', { expiresAt: Date.now() + 30_000 }));
    show(null);
    // No prompt on screen, so the dialog's tick is off for these 100 s.
    vi.setSystemTime(Date.now() + 100_000);
    committedCountdowns.length = 0;
    show(approval('b', { expiresAt: Date.now() + 30_000 }));
    expect(committedCountdowns[0]).toMatch(/\b30s$/);
    expect(committedCountdowns.every((text) => /\b30s$/.test(text))).toBe(true);
  });

  it('counts a queued prompt down from a fresh clock once its countdown starts', () => {
    act(() => root.render(createElement('div', null, createElement(ExecuteApprovalDialog), createElement(CountdownProbe))));
    show(approval('a', { expiresAt: Date.now() + 30_000 }));
    show(null);
    vi.setSystemTime(Date.now() + 100_000);
    committedCountdowns.length = 0;
    // The usual path: the prompt arrives with its countdown not started, and
    // the dialog starts it.
    show(approval('c', { expiresAt: 0 }));
    show(approval('c', { expiresAt: Date.now() + 30_000 }));
    expect(committedCountdowns[0]).toMatch(/\b30s$/);
    expect(committedCountdowns.every((text) => /\b30s$/.test(text))).toBe(true);
  });

  it('offers the auto-approve checkbox only for a plain execute request', () => {
    act(() => root.render(createElement(ExecuteApprovalDialog)));
    show(approval('a'));
    expect(container.querySelector('[data-approval-auto-approve]')?.getAttribute('role')).toBe('checkbox');
    show(approval('a', { fanout: { taskCount: 2, repoPath: '/repo' } }));
    expect(container.querySelector('[data-approval-auto-approve]')).toBeNull();
  });
});
