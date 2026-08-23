// @vitest-environment jsdom
//
// Dynamic verification for issue #1002 — the surviving pane adopts its terminal
// across a split instead of rebuilding it.
//
// The fix rests on one claim about React that is easy to state and easy to get
// wrong: a restructure unmounts and remounts the surviving leaf inside ONE
// commit, and React flushes that commit's passive UNMOUNT effects before its
// passive MOUNT effects. If that order were reversed — or if the two landed in
// different commits — the mount would find nothing parked, adoption would never
// fire, and the whole change would degrade to "dispose the terminal 250 ms
// later" while the user still watched the conversation replay.
//
// So this mounts the REAL PaneContainer against the REAL store and splits with
// the REAL splitPane, with the leaf Pane mocked down to the one thing that
// matters: a mount that adopts and a teardown that parks, driving the REAL
// terminalPark module. What it asserts is the ordering, not xterm.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Terminal } from '@xterm/xterm';

import {
  parkTerminal,
  adoptTerminal,
  PARK_TTL_MS,
  __resetTerminalPark,
} from '../../../terminal/terminalPark';

/** Every park/adopt/dispose this render produced, in order, as `event:paneId`. */
const events: string[] = [];

// The leaf stands in for Pane → Terminal → useTerminal. Its ptyId is stable
// across a restructure exactly as the real one is (the surviving LEAF keeps its
// id; only the new branch above it gets a fresh one), so pane.id is the right
// stand-in for the park key.
vi.mock('../Pane', () => ({
  default: ({ pane }: { pane: { id: string } }) => {
    React.useEffect(() => {
      const adopted = adoptTerminal(pane.id);
      events.push(`${adopted ? 'adopt' : 'create'}:${pane.id}`);
      return () => {
        events.push(`park:${pane.id}`);
        parkTerminal(
          pane.id,
          {} as unknown as Terminal,
          document.createElement('div'),
          () => events.push(`dispose:${pane.id}`),
        );
      };
    }, [pane.id]);
    return React.createElement('div', { 'data-testid': `leaf-${pane.id}` });
  },
}));

import PaneContainer from '../PaneContainer';
import { useStore } from '../../../stores';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// react-resizable-panels observes group elements; jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe(): void { /* layout reflow is irrelevant under jsdom */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= ResizeObserverStub;

let host: HTMLDivElement;
let root: Root;

const activeWorkspace = () =>
  useStore.getState().workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;

function render(): void {
  const ws = activeWorkspace();
  act(() => {
    root.render(
      React.createElement(PaneContainer, {
        pane: ws.rootPane,
        workspace: ws,
        isWorkspaceVisible: true,
      }),
    );
  });
}

const only = (prefix: string) => events.filter((e) => e.startsWith(`${prefix}:`));

beforeEach(() => {
  const state = useStore.getState();
  for (const w of [...state.workspaces]) state.removeWorkspace(w.id);
  state.addWorkspace();
  useStore.setState({ zoomedPaneId: null });

  events.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  render();
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
  __resetTerminalPark();
  vi.useRealTimers();
});

describe('#1002 — terminal adoption across a pane-tree restructure', () => {
  it('parks the surviving leaf before the remount asks to adopt it', () => {
    const rootId = activeWorkspace().rootPane.id;
    expect(events).toEqual([`create:${rootId}`]);

    act(() => { useStore.getState().splitPane(rootId, 'horizontal'); });
    render();

    // The load-bearing order. React flushes passive unmount effects for the
    // whole commit before passive mount effects, so the park is already in
    // place when the remount looks for it.
    const survivor = events.filter((e) => e.endsWith(`:${rootId}`));
    expect(survivor).toEqual([`create:${rootId}`, `park:${rootId}`, `adopt:${rootId}`]);
  });

  it('never disposes the surviving leaf\'s terminal', () => {
    vi.useFakeTimers();
    const rootId = activeWorkspace().rootPane.id;

    act(() => { useStore.getState().splitPane(rootId, 'horizontal'); });
    render();
    act(() => { vi.advanceTimersByTime(PARK_TTL_MS * 4); });

    // Adoption cancelled the pending dispose. Without that, the adopting mount's
    // terminal would die a quarter-second into its life.
    expect(only('dispose')).toEqual([]);
    expect(only('adopt')).toEqual([`adopt:${rootId}`]);
  });

  it('builds the NEW pane from scratch — only the survivor is adopted', () => {
    const rootId = activeWorkspace().rootPane.id;

    act(() => { useStore.getState().splitPane(rootId, 'horizontal'); });
    render();

    const newPaneId = useStore.getState().workspaces
      .find((w) => w.id === useStore.getState().activeWorkspaceId)!.activePaneId;
    expect(newPaneId).not.toBe(rootId);
    expect(events).toContain(`create:${newPaneId}`);
    expect(events).not.toContain(`adopt:${newPaneId}`);
  });

  it('adopts across a sibling close that collapses the branch', () => {
    // Third path to the same restructure: closing one of two leaves collapses
    // the branch back into a leaf, moving the survivor's depth again.
    const rootId = activeWorkspace().rootPane.id;
    act(() => { useStore.getState().splitPane(rootId, 'horizontal'); });
    render();
    const newPaneId = activeWorkspace().activePaneId;

    events.length = 0;
    act(() => { useStore.getState().closePane(newPaneId); });
    render();

    expect(events).toContain(`park:${rootId}`);
    expect(events).toContain(`adopt:${rootId}`);
    expect(events.indexOf(`park:${rootId}`)).toBeLessThan(events.indexOf(`adopt:${rootId}`));
  });

  it('still disposes when the pane really goes away', () => {
    vi.useFakeTimers();
    const rootId = activeWorkspace().rootPane.id;

    act(() => { root.unmount(); });
    expect(only('dispose')).toEqual([]);
    act(() => { vi.advanceTimersByTime(PARK_TTL_MS); });

    // A closed pane never comes back for its terminal — the park window just
    // moves the dispose 250 ms later, it does not cancel it.
    expect(only('dispose')).toEqual([`dispose:${rootId}`]);
  });
});
