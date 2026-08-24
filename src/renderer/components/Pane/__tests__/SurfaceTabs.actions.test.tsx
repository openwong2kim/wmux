// @vitest-environment jsdom
//
// Dynamic verification for the pane-header action cluster and the new-terminal
// tab action (split right / split down / new browser / zoom).
// Mounts the REAL SurfaceTabs against the REAL zustand store, wiring the
// action callbacks to the same store actions Pane.tsx wires them to, then
// clicks each button and asserts the store effect:
//
//   • Split right → splitPane(_, 'horizontal') → root becomes a horizontal
//     branch (side-by-side columns), leaf count 1 → 2.
//   • Split down  → splitPane(_, 'vertical')   → root becomes a vertical branch
//     (stacked rows).
//   • New browser → addBrowserSurface           → a browser surface tab is added
//     to this pane.
//   • Zoom        → togglePaneZoom → zoomedPaneId toggles this pane on/off.
//   • The Settings toggle (paneActionsVisible=false) hides the whole cluster.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs from '../SurfaceTabs';
import { useStore } from '../../../stores';
import { getLeafPanes } from '../../../../shared/paneUtils';
import type { Pane, Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function activeWs(): Workspace {
  return useStore
    .getState()
    .workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
}

function rootLeafId(): string {
  return activeWs().rootPane.id;
}

function branchDirection(pane: Pane): string | undefined {
  return pane.type === 'branch' ? pane.direction : undefined;
}

function mount(paneId: string, props: { actionsVisible?: boolean } = {}): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws = activeWs();
  act(() => {
    root.render(
      React.createElement(SurfaceTabs, {
        surfaces: [],
        activeSurfaceId: '',
        workspace: ws,
        paneId,
        paneActive: true,
        ...props,
        onSelect: () => undefined,
        onClose: () => undefined,
        onSplitHorizontal: () => useStore.getState().splitPane(paneId, 'horizontal', ws.id),
        onSplitVertical: () => useStore.getState().splitPane(paneId, 'vertical', ws.id),
        onAddTerminal: () => useStore.getState().addSurface(paneId, 'test-pty', 'Terminal', 'D:/repo', ws.id),
        onAddBrowser: () => useStore.getState().addBrowserSurface(paneId, undefined, undefined, ws.id),
      }),
    );
  });
}

function click(action: string): void {
  const btn = container.querySelector<HTMLButtonElement>(`[data-pane-action="${action}"]`);
  expect(btn, `button [data-pane-action="${action}"] should be present`).not.toBeNull();
  act(() => {
    btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** The new-terminal `+` is opt-in, so a test that wants to press it has to
 *  turn the experimental setting on. The store drives the render, so flipping
 *  it inside `act` is enough — no remount. */
function clickNewTerminal(): void {
  act(() => {
    useStore.getState().setPaneNewTerminalButton(true);
  });
  click('new-terminal');
}

beforeEach(() => {
  const state = useStore.getState();
  for (const w of [...state.workspaces]) state.removeWorkspace(w.id);
  state.addWorkspace();
  state.setPaneActionsVisible(true);
  state.setPaneNewTerminalButton(false);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('SurfaceTabs pane action cluster', () => {
  // #451's rule, pinned: the pane offers no visible way to add a SECOND
  // terminal to itself. Splitting is the answer, and it has two buttons here.
  it('shows no new-terminal button by default', () => {
    mount(rootLeafId());
    const actions = Array.from(
      container.querySelectorAll('[data-pane-action]'),
    ).map((el) => el.getAttribute('data-pane-action'));
    expect(actions).toEqual(['split-right', 'split-down', 'new-browser', 'stash', 'zoom']);
    expect(container.querySelector('[data-pane-action="new-terminal"]')).toBeNull();
  });

  it('shows the + only once the experimental setting is on', () => {
    act(() => {
      useStore.getState().setPaneNewTerminalButton(true);
    });
    mount(rootLeafId());
    const actions = Array.from(
      container.querySelectorAll('[data-pane-action]'),
    ).map((el) => el.getAttribute('data-pane-action'));
    // On the tab strip, BEFORE the cluster — it adds a surface, it does not
    // act on the pane.
    expect(actions).toEqual(['new-terminal', 'split-right', 'split-down', 'new-browser', 'stash', 'zoom']);
    const btn = container.querySelector('[data-pane-action="new-terminal"]');
    // One click, no menu — with the browser back in the cluster there is only
    // one thing left for it to do.
    expect(btn?.getAttribute('aria-haspopup')).toBeNull();
    // The keyboard path stays advertised even to someone using the button.
    expect(btn?.getAttribute('title')).toContain('Ctrl+T');
  });

  it('Add terminal invokes the callback without selecting a tab', () => {
    const paneId = rootLeafId();
    let addTerminalCalls = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const ws = activeWs();
    act(() => {
      root.render(
        React.createElement(SurfaceTabs, {
          surfaces: [],
          activeSurfaceId: '',
          workspace: ws,
          paneId,
          paneActive: true,
          onSelect: () => { throw new Error('onSelect should not run'); },
          onClose: () => undefined,
          onSplitHorizontal: () => undefined,
          onSplitVertical: () => undefined,
          onAddTerminal: () => { addTerminalCalls += 1; },
          onAddBrowser: () => undefined,
        }),
      );
    });

    clickNewTerminal();

    expect(addTerminalCalls).toBe(1);
  });

  it('Add terminal creates a terminal surface in this pane', () => {
    const paneId = rootLeafId();
    mount(paneId);

    clickNewTerminal();

    const leaf = getLeafPanes(activeWs().rootPane).find((l) => l.id === paneId)!;
    const terminals = leaf.surfaces.filter((s) => s.ptyId === 'test-pty');
    expect(terminals).toHaveLength(1);
    expect(leaf.activeSurfaceId).toBe(terminals[0].id);
  });

  it('Split right splits the pane horizontally (side-by-side columns)', () => {
    const paneId = rootLeafId();
    mount(paneId);
    expect(getLeafPanes(activeWs().rootPane)).toHaveLength(1);

    click('split-right');

    expect(getLeafPanes(activeWs().rootPane)).toHaveLength(2);
    expect(branchDirection(activeWs().rootPane)).toBe('horizontal');
  });

  it('Split down splits the pane vertically (stacked rows)', () => {
    const paneId = rootLeafId();
    mount(paneId);

    click('split-down');

    expect(getLeafPanes(activeWs().rootPane)).toHaveLength(2);
    expect(branchDirection(activeWs().rootPane)).toBe('vertical');
  });

  it('New browser adds a browser surface tab to this pane', () => {
    const paneId = rootLeafId();
    mount(paneId);

    click('new-browser');

    const leaf = getLeafPanes(activeWs().rootPane).find((l) => l.id === paneId)!;
    const browsers = leaf.surfaces.filter((s) => s.surfaceType === 'browser');
    expect(browsers).toHaveLength(1);
    expect(leaf.activeSurfaceId).toBe(browsers[0].id);
  });

  it('Zoom toggles this pane in zoomedPaneId (maximize ⇄ restore)', () => {
    const paneId = rootLeafId();
    mount(paneId);
    expect(useStore.getState().zoomedPaneId).toBeNull();

    click('zoom');
    expect(useStore.getState().zoomedPaneId).toBe(paneId);

    click('zoom');
    expect(useStore.getState().zoomedPaneId).toBeNull();
  });

  it('hides the cluster when the Settings toggle is off', () => {
    act(() => {
      useStore.getState().setPaneActionsVisible(false);
    });
    mount(rootLeafId());

    expect(container.querySelector('[data-pane-actions]')).toBeNull();
    // Nothing left: the cluster is hidden and the `+` is off by default. That
    // is the minimal-chrome setup working as asked, not a missing affordance —
    // every action here still has a key.
    expect(container.querySelectorAll('[data-pane-action]')).toHaveLength(0);
  });

  // The two toggles are independent: hiding the cluster must not take away a
  // `+` the user explicitly turned on, and vice versa.
  it('keeps the opt-in + when the cluster is hidden', () => {
    act(() => {
      useStore.getState().setPaneActionsVisible(false);
      useStore.getState().setPaneNewTerminalButton(true);
    });
    mount(rootLeafId());

    expect(container.querySelector('[data-pane-actions]')).toBeNull();
    const actions = Array.from(container.querySelectorAll('[data-pane-action]'))
      .map((el) => el.getAttribute('data-pane-action'));
    expect(actions).toEqual(['new-terminal']);
  });
});

function mountWithTerminal(paneId: string, paneActive = true): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws = activeWs();
  const leaf = getLeafPanes(ws.rootPane).find((l) => l.id === paneId)!;
  const surfaces = leaf.surfaces.length > 0
    ? leaf.surfaces
    : [{ id: 's1', ptyId: 'pty-1', title: 't', shell: 'bash', cwd: '/x', surfaceType: 'terminal' as const }];
  act(() => {
    root.render(
      React.createElement(SurfaceTabs, {
        surfaces,
        activeSurfaceId: surfaces[0].id,
        workspace: ws,
        paneId,
        paneActive,
        onSelect: () => undefined,
        onClose: () => undefined,
        onSplitHorizontal: () => undefined,
        onSplitVertical: () => undefined,
        onAddTerminal: () => undefined,
        onAddBrowser: () => undefined,
      }),
    );
  });
}

// The agent verbs went back to the bottom toolbar (2026-08-18), so the pane
// cluster carries split / browser / zoom only. These guard that they did not
// come back: a verb here is owned by one pane in a split, which is what the
// workspace-spanning bar exists to avoid claiming.
describe('SurfaceTabs pane cluster', () => {
  it('carries no agent verbs on the focused pane', () => {
    act(() => { useStore.getState().setAgentToolbarEnabled(true); });
    mountWithTerminal(rootLeafId(), true);
    expect(container.querySelector('[data-pane-action="attach"]')).toBeNull();
    expect(container.querySelector('[data-pane-action="compose"]')).toBeNull();
    expect(container.querySelector('[data-pane-action="new-conversation"]')).toBeNull();
    expect(container.querySelector('[data-pane-action="split-right"]')).not.toBeNull();
  });

  it('renders nothing when pane actions are hidden', () => {
    act(() => {
      useStore.getState().setAgentToolbarEnabled(true);
      useStore.getState().setPaneActionsVisible(false);
    });
    mountWithTerminal(rootLeafId(), true);
    expect(container.querySelector('[data-pane-actions]')).toBeNull();
  });

  it('is unaffected by the inject-chrome setting', () => {
    act(() => { useStore.getState().setAgentToolbarEnabled(false); });
    mountWithTerminal(rootLeafId(), true);
    expect(container.querySelector('[data-pane-action="split-right"]')).not.toBeNull();
  });
});

// ─── Narrow panes drop the cluster entirely ─────────────────────────────────
//
// Pane.tsx measures itself and combines the Settings toggle with the width
// check; SurfaceTabs just honors the answer. The fallback is the EXISTING
// cluster-off chrome (Pane's hover-revealed corner ⤢), not a new small layout.

describe('SurfaceTabs — actionsVisible override', () => {
  it('renders no cluster when the pane cannot afford it', () => {
    mount(rootLeafId(), { actionsVisible: false });

    const actions = Array.from(
      container.querySelectorAll('[data-pane-action]'),
    ).map((el) => el.getAttribute('data-pane-action'));
    expect(actions).toEqual([]);
    // Including stash: it stays reachable from the sidebar, the palette and the
    // prefix key, which is why dropping the button here is affordable at all.
    expect(container.querySelector('[data-pane-action="stash"]')).toBeNull();
  });

  it('still renders the tab strip — the thing the collapse exists to protect', () => {
    mount(rootLeafId(), { actionsVisible: false });
    expect(container.querySelector('[data-pane-tab]') ?? container.textContent).toBeTruthy();
  });

  it('falls back to the Settings toggle when the prop is omitted', () => {
    mount(rootLeafId());
    expect(container.querySelector('[data-pane-action="stash"]')).not.toBeNull();
  });
});
