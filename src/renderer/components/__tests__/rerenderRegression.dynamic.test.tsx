// @vitest-environment jsdom
//
// Re-render regression tests (NB2 wave 0 verification gate).
//
// Mount real store + real components in jsdom and measure "committed component count"
// via React <Profiler> onRender callback (spec Profiler metric). Verify:
//   (a) unrelated workspace title change does not re-render StatusBar·other WorkspaceItem
//       (A1 selector diet + A5 clock split effect).
//   (b) memo component (WorkspaceItem) re-renders 0 on identical props.
//   (c) active ws self change re-renders only that WorkspaceItem (self-subscribe).
//
// No @testing-library (repo dependency forbidden) — same as PaneContainer.zoom
// tests: drive directly with createRoot + act + Profiler.
import React, { Profiler, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Minimal electronAPI mock for StatusClock memory poll + WorkspaceItem shell/platform access.
// getMemoryUsage returns nothing (0) to avoid setState re-render noise in measurement.
(globalThis as unknown as { window: Window }).window ??= globalThis as unknown as Window;
Object.defineProperty(globalThis, 'electronAPI', { value: undefined, writable: true, configurable: true });
(window as unknown as { electronAPI: unknown }).electronAPI = {
  system: { getMemoryUsage: () => Promise.resolve(0) },
  platform: 'darwin',
  shell: { openExternal: () => undefined },
  // StatusBar → PluginStatusBarWidgets → usePlugins.list() called on mount.
  // Return empty list immediately to avoid unhandled rejection (measurement noise).
  plugins: { list: () => Promise.resolve({ plugins: [], failures: [] }) },
};

import { useStore } from '../../stores';
import StatusBar from '../StatusBar/StatusBar';
import WorkspaceItem from '../Sidebar/WorkspaceItem';
import type { SessionData, Workspace } from '../../../shared/types';

function makeWorkspace(id: string, name: string): Workspace {
  return {
    id,
    name,
    rootPane: {
      id: `${id}-pane`,
      type: 'leaf',
      surfaces: [{ id: `${id}-surf`, ptyId: `${id}-pty`, title: 'term', shell: 'bash', cwd: '/x' }],
      activeSurfaceId: `${id}-surf`,
    },
    activePaneId: `${id}-pane`,
  } as Workspace;
}

let container: HTMLDivElement;
let root: Root;

/** Profiler commit counter: counts onRender invocations per mounted subtree. */
const commits: Record<string, number> = {};
function reset(id: string) { commits[id] = 0; }
function onRender(id: string) { commits[id] = (commits[id] ?? 0) + 1; }

beforeEach(async () => {
  // Seed two workspaces (ws-1 active). loadSession to known store state.
  const data: SessionData = {
    workspaces: [makeWorkspace('ws-1', 'Alpha'), makeWorkspace('ws-2', 'Bravo')],
    activeWorkspaceId: 'ws-1',
    sidebarVisible: true,
  };
  act(() => { useStore.getState().loadSession(data); });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  for (const k of Object.keys(commits)) delete commits[k];
  reset('statusbar'); reset('item-1'); reset('item-2');

  const noop = () => undefined;
  act(() => {
    root.render(
      React.createElement(React.Fragment, null,
        React.createElement(Profiler, { id: 'statusbar', onRender: () => onRender('statusbar') },
          React.createElement(StatusBar),
        ),
        React.createElement(Profiler, { id: 'item-1', onRender: () => onRender('item-1') },
          React.createElement(WorkspaceItem, {
            workspaceId: 'ws-1', isActive: true, isMultiview: false, index: 0,
            onSelect: noop, onCtrlSelect: noop, onRename: noop, onClose: noop,
            onCopyInfo: noop, onDuplicate: noop, onReorder: noop,
          }),
        ),
        React.createElement(Profiler, { id: 'item-2', onRender: () => onRender('item-2') },
          React.createElement(WorkspaceItem, {
            workspaceId: 'ws-2', isActive: false, isMultiview: false, index: 1,
            onSelect: noop, onCtrlSelect: noop, onRename: noop, onClose: noop,
            onCopyInfo: noop, onDuplicate: noop, onReorder: noop,
          }),
        ),
      ),
    );
  });

  // Drain async side effects (usePlugins.list etc.) settling after mount —
  // so each test's reset baseline is clean.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
});

describe('re-render regression (NB2 wave 0)', () => {
  it('unrelated ws (ws-2) title change does not re-render StatusBar or ws-1 item', () => {
    // Reset counters after mount — measure only subsequent commits.
    reset('statusbar'); reset('item-1'); reset('item-2');

    // Change only ws-2 surface title (simulate unrelated workspace meta churn).
    act(() => { useStore.getState().updateSurfaceTitleByPty('ws-2-pty', 'changed-title'); });

    // A1/A5: StatusBar (subscribes active ws summary+unreadCount only) and ws-1 item (own ws only)
    // must not re-render on ws-2 change.
    expect(commits['statusbar']).toBe(0);
    expect(commits['item-1']).toBe(0);
    // Only self-subscribed ws-2 item re-renders (title actually changed).
    expect(commits['item-2']).toBeGreaterThanOrEqual(1);
  });

  it('unrelated ws (ws-2) cwd/git meta change also does not re-render StatusBar·ws-1', () => {
    reset('statusbar'); reset('item-1'); reset('item-2');

    act(() => { useStore.getState().updateWorkspaceMetadata('ws-2', { cwd: '/new/path', gitBranch: 'feature' }); });

    expect(commits['statusbar']).toBe(0);
    expect(commits['item-1']).toBe(0);
    expect(commits['item-2']).toBeGreaterThanOrEqual(1);
  });

  it('active ws (ws-1) self-change re-renders only that item (other items 0)', () => {
    reset('statusbar'); reset('item-1'); reset('item-2');

    act(() => { useStore.getState().renameWorkspace('ws-1', 'Alpha-renamed'); });

    // ws-1 item re-renders (own name changed). ws-2 item unrelated → 0.
    expect(commits['item-1']).toBeGreaterThanOrEqual(1);
    expect(commits['item-2']).toBe(0);
    // StatusBar shows active ws name so re-renders on name change (expected).
    expect(commits['statusbar']).toBeGreaterThanOrEqual(1);
  });

  it('note: unrelated slice (notifications) change re-renders none of the three components', () => {
    // StatusBar subscribes unreadCount (notifications derived) so verifying unrelated
    // slice updates without changing read state is ambiguous here with pure unrelated field
    // (prefixError=null→same value). Instead verify reference stability with no-op set:
    // same value set may create new immer reference but selector value compare
    // (number/useShallow) means no re-render.
    reset('statusbar'); reset('item-1'); reset('item-2');
    act(() => { useStore.setState({ prefixError: null }); });
    expect(commits['statusbar']).toBe(0);
    expect(commits['item-1']).toBe(0);
    expect(commits['item-2']).toBe(0);
  });
});
