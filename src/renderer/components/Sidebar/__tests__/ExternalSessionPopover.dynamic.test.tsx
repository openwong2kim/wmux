// @vitest-environment jsdom
// The external session card (placement B, 2026-11-01): an attach command and
// its primary Copy only when tmux or screen is known; otherwise "Open a wmux
// pane here" is the one primary. Focus starts on that primary, Escape closes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ExternalSessionCard } from '../ExternalSessionPopover';
import type { ExternalSession } from '../../../../shared/externalSessions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 10 * 60_000;

function session(patch: Partial<ExternalSession>): ExternalSession {
  return {
    id: 'claude:s1',
    agent: 'claude',
    agentSessionId: 's1',
    title: 'Fix flaky login test',
    cwd: '/code/api-server',
    where: { kind: 'unknown' },
    state: 'needs-you',
    pendingQuestion: 'Allow Bash: npm run db:reset -- --force',
    pendingKind: 'approval',
    lastSignalAt: NOW - 60_000,
    startedAt: 0,
    ...patch,
  };
}

let container: HTMLDivElement;
let root: Root;
const onClose = vi.fn();

function render(s: ExternalSession, inWorkspace = true) {
  act(() => {
    root.render(createElement(ExternalSessionCard, {
      session: s,
      inWorkspace,
      anchor: { top: 10, bottom: 10, left: 270, right: 622 },
      now: NOW,
      onClose,
      onOpenPane: vi.fn(),
      onHide: vi.fn(),
    }));
  });
  return document.querySelector('[data-external-session-card]') as HTMLElement;
}

const action = (card: HTMLElement, name: string) => card.querySelector<HTMLButtonElement>(`[data-external-session-action="${name}"]`);

beforeEach(() => {
  onClose.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ExternalSessionCard', () => {
  it('offers the tmux attach command as the one primary', () => {
    const card = render(session({ where: { kind: 'tmux', session: 'api', window: '2' } }));
    expect(card.querySelector('[data-external-attach-command]')?.textContent).toBe('tmux attach -t api');
    expect(action(card, 'copy')?.className).toContain('ui-btn-primary');
    expect(action(card, 'open-pane')?.className).not.toContain('ui-btn-primary');
    expect(document.activeElement).toBe(action(card, 'copy'));
    expect(card.textContent).toContain('tmux · session api · window 2');
  });

  it('offers screen -r for a known screen session', () => {
    const card = render(session({ where: { kind: 'screen', session: 'build' } }));
    expect(card.querySelector('[data-external-attach-command]')?.textContent).toBe('screen -r build');
  });

  it('has no attach command for a terminal app; opening a pane is the primary', () => {
    const card = render(session({ state: 'idle', pendingQuestion: undefined, where: { kind: 'terminal', label: 'Terminal.app' } }));
    expect(card.querySelector('[data-external-attach-command]')).toBeNull();
    expect(action(card, 'copy')).toBeNull();
    expect(action(card, 'open-pane')?.className).toContain('ui-btn-primary');
    expect(document.activeElement).toBe(action(card, 'open-pane'));
  });

  it('has no attach command for tmux without a session name', () => {
    const card = render(session({ where: { kind: 'tmux' } }));
    expect(action(card, 'copy')).toBeNull();
    expect(action(card, 'open-pane')?.className).toContain('ui-btn-primary');
  });

  it('says the question, and that no workspace holds an unmatched folder', () => {
    const card = render(session({ where: { kind: 'ssh', label: 'MacBook' } }), false);
    expect(card.querySelector('[data-external-session-state]')?.textContent).toBe('Needs you · approval');
    expect(card.textContent).toContain('Allow Bash: npm run db:reset -- --force');
    expect(card.textContent).toContain('ssh from MacBook');
    expect(card.textContent).toContain('none for this folder');
  });

  it('closes on Escape and hands focus back', () => {
    render(session({}));
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onClose).toHaveBeenCalledWith(true);
  });
});
