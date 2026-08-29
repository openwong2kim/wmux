// @vitest-environment jsdom
//
// Dynamic test for Multi Task (fan-out) on the agent toolbar. Spawn must exist
// at zero agents — the toolbar is not gated on the roster. ComposeHost portals
// FanOutDialog so it never mounts inside the bar's own stacking context.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Stub the pty write path (only mount/toggle is verified — nothing is fired).
vi.mock('../inject', () => ({
  injectText: () => Promise.resolve(),
  attachFilesToPty: () => Promise.resolve(),
  quotePathsForPrompt: (paths: string[]) => paths.join(' '),
}));

import { useStore } from '../../../stores';
import ToolbarHost from '../ToolbarHost';
import ComposeHost from '../ComposeHost';
import type { SessionData, Workspace } from '../../../../shared/types';

/** A workspace with one terminal and NO agents — the zero-fleet case. */
function seedWorkspace(): Workspace {
  return {
    id: 'ws-1',
    name: 'Alpha',
    rootPane: {
      id: 'leaf-a',
      type: 'leaf',
      activeSurfaceId: 'sa1',
      surfaces: [
        { id: 'sa1', ptyId: 'pty-1', title: 'shell', shell: 'bash', cwd: '/x', surfaceType: 'terminal' },
      ],
    },
    activePaneId: 'leaf-a',
  } as unknown as Workspace;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const data: SessionData = {
    workspaces: [seedWorkspace()],
    activeWorkspaceId: 'ws-1',
    sidebarVisible: true,
  };
  act(() => {
    useStore.getState().loadSession(data);
    useStore.setState({
      toolbarPopover: null,
      fanOutWorkspaceId: null,
      agentToolbarEnabled: true,
      // Pinned so the bar is on screen without simulating pointer approach —
      // reveal behaviour is covered by useHoverReveal's own test.
      agentToolbarPinned: true,
    });
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(): void {
  act(() => root.render(createElement(
    'div',
    null,
    createElement(ToolbarHost),
    createElement(ComposeHost),
  )));
}

const fanoutButton = (): HTMLButtonElement =>
  container.querySelector('[data-testid="fanout-button"]') as HTMLButtonElement;

describe('AgentToolbar — fan-out entry', () => {
  it('renders the fan-out button with no agents in the workspace (spawn a fleet from zero)', () => {
    mount();
    expect(fanoutButton()).not.toBeNull();
    expect(document.querySelector('[data-testid="fanout-dialog"]')).toBeNull();
  });

  it('keeps session schedule management reachable when no agent is detected', () => {
    mount();
    const schedule = container.querySelector(
      '[data-testid="session-schedule-button"]',
    ) as HTMLButtonElement | null;
    expect(schedule).not.toBeNull();
    expect(schedule?.disabled).toBe(false);
  });

  it('toggles the FanOutDialog open and closed on click', () => {
    mount();
    act(() => {
      fanoutButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="fanout-dialog"]')).not.toBeNull();
    act(() => {
      fanoutButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="fanout-dialog"]')).toBeNull();
  });

  it('anchors the dialog against the trigger rect, not the viewport pad', () => {
    mount();
    const btn = fanoutButton();
    // jsdom reports a zero rect, so stub one that sits far right: a correct
    // anchor right-aligns the 420px dialog under it, while the old
    // {top,left}-only shape collapsed every anchor onto the 8px left pad.
    btn.getBoundingClientRect = () => ({
      top: 700, left: 900, right: 1000, bottom: 736, width: 100, height: 36, x: 900, y: 700,
      toJSON: () => ({}),
    }) as DOMRect;
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const anchor = useStore.getState().fanOutAnchor;
    expect(anchor).toEqual({ top: 700, left: 900, right: 1000, bottom: 736 });
  });
});
