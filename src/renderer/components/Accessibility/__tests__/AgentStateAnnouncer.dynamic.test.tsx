// @vitest-environment jsdom
// The agent-state announcer: a hidden polite live region, only while a screen
// reader is on, fed by the sidebar roster's per-pane state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AgentStateAnnouncer from '../AgentStateAnnouncer';
import { useStore } from '../../../stores';
import { setScreenReaderOn } from '../../../utils/screenReader';
import type { AgentStatus, Workspace } from '../../../../shared/types';

const NOW = 1_000_000;
const PTY = 'pty-1';

let container: HTMLDivElement;
let root: Root;

function region(): HTMLElement | null {
  return container.querySelector('[data-agent-state-announcer]');
}

function setAttention(status: AgentStatus | undefined) {
  act(() => useStore.setState((s) => {
    const next = { ...s.surfaceAgentStatus };
    if (status) next[PTY] = status; else delete next[PTY];
    return { surfaceAgentStatus: next };
  }));
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  const ws = {
    id: 'ws-1',
    name: 'one',
    wsOrdinal: 1,
    activePaneId: 'leaf-1',
    rootPane: {
      id: 'leaf-1',
      type: 'leaf',
      ordinal: 1,
      activeSurfaceId: 's-1',
      surfaces: [{ id: 's-1', ptyId: PTY, title: 'claude', shell: 'zsh', cwd: '/repo', surfaceType: 'terminal' }],
    },
  } as unknown as Workspace;
  act(() => useStore.setState({
    workspaces: [ws],
    activeWorkspaceId: 'ws-1',
    surfaceAgent: { [PTY]: { name: 'Claude Code', status: 'idle' } },
    surfaceAgentStatus: {},
    agentClockMs: NOW,
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<AgentStateAnnouncer />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => setScreenReaderOn(false));
  vi.useRealTimers();
});

describe('AgentStateAnnouncer', () => {
  it('renders nothing while no screen reader is on', () => {
    setAttention('awaiting_input');
    expect(container.innerHTML).toBe('');
  });

  it('is a hidden polite status region that says when an agent needs you', () => {
    act(() => setScreenReaderOn(true));
    const el = region();
    expect(el?.getAttribute('role')).toBe('status');
    expect(el?.getAttribute('aria-live')).toBe('polite');
    expect(el?.className).toBe('sr-only');
    expect(el?.textContent).toBe('');

    setAttention('awaiting_input');
    expect(region()?.textContent).toBe('#w1-1 Claude Code needs you');
  });

  it('holds a change that comes within 2 s and says it when the 2 s are up', () => {
    act(() => setScreenReaderOn(true));
    setAttention('awaiting_input');
    act(() => { vi.advanceTimersByTime(500); });
    setAttention('error');
    expect(region()?.textContent).toBe('#w1-1 Claude Code needs you');
    act(() => { vi.advanceTimersByTime(1500); });
    // The second announcement carries the trailing no-break space.
    expect(region()?.textContent?.trim()).toBe('#w1-1 Claude Code stopped with an error');
  });

  it('makes the same line said twice in a row new text, so it is spoken again', () => {
    act(() => setScreenReaderOn(true));
    setAttention('awaiting_input');
    const first = region()?.textContent;
    setAttention(undefined);
    act(() => { vi.advanceTimersByTime(2000); });
    setAttention('awaiting_input');
    const second = region()?.textContent;
    expect(second?.trim()).toBe(first);
    expect(second).not.toBe(first);
  });

  it('goes away when the screen reader is turned off', () => {
    act(() => setScreenReaderOn(true));
    expect(region()).not.toBeNull();
    act(() => setScreenReaderOn(false));
    expect(region()).toBeNull();
  });
});
