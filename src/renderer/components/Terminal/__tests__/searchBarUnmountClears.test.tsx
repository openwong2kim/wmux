// @vitest-environment jsdom
//
// #1266 — render-level guard for the search-highlight teardown.
//
// The bug is a lifecycle/ownership gap, not a search bug. `searchBarVisible`
// is one global flag and Terminal.tsx gated the bar on `isActive`, which
// Pane.tsx passes as `surface.id === pane.activeSurfaceId` — the selected TAB
// inside a pane, not "this pane has focus". So every pane rendered its own
// search bar, and moving to another pane never unmounted the abandoned one's:
// its addon kept the cached term and went on re-creating highlight
// decorations on every later chunk of output, at coordinates that no longer
// matched anything (live dogfood measured them drawn outside the pane).
//
// These tests mount the real Terminal component and assert the addon's
// clearDecorations() actually ran — the behaviour, not the shape of the
// source.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** One stand-in SearchAddon per pty, as useTerminal owns one per terminal. */
type FakeAddon = { clearDecorations: ReturnType<typeof vi.fn<() => void>> };
const addons = new Map<string, FakeAddon>();
function addonFor(ptyId: string): FakeAddon {
  let a = addons.get(ptyId);
  if (!a) {
    a = { clearDecorations: vi.fn<() => void>() };
    addons.set(ptyId, a);
  }
  return a;
}
/** The single-pane cases use this one. */
const searchAddon = addonFor('pty-1');

vi.mock('../../../hooks/useTerminal', () => ({
  // Mirrors the real hook's three-line wrappers, so the assertion lands on
  // the addon call the production code makes.
  useTerminal: (_ref: unknown, options: { ptyId?: string }) => ({
    terminal: { current: null },
    terminalInstance: null,
    fit: vi.fn(),
    searchAddonRef: { current: addonFor(options.ptyId ?? 'pty-1') },
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    clearSearch: () => addonFor(options.ptyId ?? 'pty-1').clearDecorations(),
    getScrollPosition: () => 0,
    scrollToLine: vi.fn(),
  }),
  copySelectionWithFeedback: vi.fn(),
  getPaneSyncUi: () => null,
  subscribePaneSyncUi: () => (): void => undefined,
}));

vi.mock('../../../hooks/useIpc', () => ({ useIpc: () => ({ invoke: vi.fn() }) }));
vi.mock('../../../hooks/useT', () => ({ useT: () => (k: string) => k }));
vi.mock('../../../i18n', () => ({ t: (k: string) => k }));

// The overlays are exercised by their own tests; stub them so this file only
// depends on Terminal.tsx's own wiring.
vi.mock('../SearchBar', () => ({ default: () => <div data-testid="search-bar" /> }));
vi.mock('../ViCopyMode', () => ({ default: () => null }));
vi.mock('../BookmarkIndicator', () => ({ default: () => null }));
vi.mock('../ContextMenu', () => ({ default: () => null }));
vi.mock('../ScrollToBottomButton', () => ({ default: () => null }));

const state: Record<string, unknown> = {
  viCopyModeActive: false,
  setViCopyModeActive: vi.fn(),
  searchBarVisible: true,
  setSearchBarVisible: vi.fn(),
  pendingDeadPaneRecoveryBySurfaceId: {},
  terminalBookmarks: {},
  supervisionByPtyId: {},
  terminalTextDropDragActive: false,
  terminalFontSize: 13,
  terminalFontFamily: 'Cascadia Code',
  activeWorkspaceId: 'ws-1',
  defaultShell: 'pwsh',
  // Two panes side by side, each with one terminal surface. Pane A is
  // focused by default.
  workspaces: [
    {
      id: 'ws-1',
      activePaneId: 'pane-a',
      rootPane: {
        type: 'branch',
        id: 'root',
        children: [
          { type: 'leaf', id: 'pane-a', surfaces: [{ id: 'surf-a' }] },
          { type: 'leaf', id: 'pane-b', surfaces: [{ id: 'surf-b' }] },
        ],
      },
    },
  ],
  startupDirectory: '',
  updateSurfaceCwd: vi.fn(),
  pushToast: vi.fn(),
};

vi.mock('../../../stores', () => {
  const useStore = <T,>(selector: (s: Record<string, unknown>) => T): T => selector(state);
  useStore.getState = () => state;
  useStore.setState = (patch: unknown) => {
    Object.assign(state, typeof patch === 'function' ? {} : patch);
  };
  return { useStore };
});

import TerminalComponent from '../Terminal';

describe('Terminal.tsx tears down search highlights when the bar goes away (#1266)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    for (const a of addons.values()) a.clearDecorations.mockClear();
    state.searchBarVisible = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (isActive: boolean) => {
    act(() => {
      root.render(<TerminalComponent ptyId="pty-1" isActive={isActive} />);
    });
  };

  it('does not clear while the bar is up', () => {
    render(true);
    expect(host.querySelector('[data-testid="search-bar"]')).not.toBeNull();
    expect(searchAddon.clearDecorations).not.toHaveBeenCalled();
  });

  it('clears when the pane loses focus and the bar unmounts', () => {
    render(true);
    expect(searchAddon.clearDecorations).not.toHaveBeenCalled();

    // Focus moves to another pane. `searchBarVisible` is a single global
    // flag, so nothing else here changes — this is exactly the path that
    // used to leave the highlights behind.
    render(false);

    expect(host.querySelector('[data-testid="search-bar"]')).toBeNull();
    expect(searchAddon.clearDecorations).toHaveBeenCalled();
  });

  it('clears when the search bar is closed while the pane stays focused', () => {
    render(true);
    state.searchBarVisible = false;
    render(true);

    expect(host.querySelector('[data-testid="search-bar"]')).toBeNull();
    expect(searchAddon.clearDecorations).toHaveBeenCalled();
  });

  it("clears when this pane's surface is swapped out for another tab", () => {
    render(true);
    render(false);
    expect(searchAddon.clearDecorations).toHaveBeenCalled();
  });
});

/**
 * The reporter's exact scenario (#1266): search in pane A, click into pane B,
 * output keeps arriving in A. Before the focus gate, A's bar stayed mounted
 * (it is gated on A's own active TAB, which never changed), the effect never
 * ran, and A went on re-highlighting forever — searchDecorationLeak.test.ts
 * pins that the addon does exactly that once output arrives.
 */
describe("#1266 reporter scenario — focus moves to the other pane", () => {
  let host: HTMLDivElement;
  let rootA: Root;
  let rootB: Root;

  const renderBoth = () => {
    act(() => {
      rootA.render(<TerminalComponent ptyId="pty-a" surfaceId="surf-a" workspaceId="ws-1" isActive />);
      rootB.render(<TerminalComponent ptyId="pty-b" surfaceId="surf-b" workspaceId="ws-1" isActive />);
    });
  };

  beforeEach(() => {
    for (const a of addons.values()) a.clearDecorations.mockClear();
    state.searchBarVisible = true;
    (state.workspaces as Array<{ activePaneId: string }>)[0].activePaneId = 'pane-a';
    host = document.createElement('div');
    document.body.appendChild(host);
    const a = document.createElement('div');
    const b = document.createElement('div');
    host.append(a, b);
    rootA = createRoot(a);
    rootB = createRoot(b);
  });

  afterEach(() => {
    act(() => { rootA.unmount(); rootB.unmount(); });
    host.remove();
  });

  const bars = () => host.querySelectorAll('[data-testid="search-bar"]').length;

  it('shows exactly one search bar — the focused pane\'s', () => {
    renderBoth();
    expect(bars()).toBe(1);
  });

  it('clears the abandoned pane\'s highlights when focus moves', () => {
    renderBoth();
    expect(addonFor('pty-a').clearDecorations).not.toHaveBeenCalled();

    // User clicks into pane B. Nothing about pane A's own surfaces changes.
    (state.workspaces as Array<{ activePaneId: string }>)[0].activePaneId = 'pane-b';
    renderBoth();

    expect(addonFor('pty-a').clearDecorations).toHaveBeenCalled();
    expect(bars()).toBe(1);
  });
});
