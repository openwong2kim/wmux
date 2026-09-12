// @vitest-environment jsdom
//
// #1266 — render-level guard for the search-highlight teardown.
//
// The bug was a lifecycle gap, not a search bug: Terminal.tsx renders the
// search bar under `searchBarVisible && isActive`, so focusing another pane
// unmounts it WITHOUT running the close handler. The addon then keeps its
// cached term and goes on re-creating highlight decorations on every later
// chunk of output. This mounts the real Terminal component, flips `isActive`
// so the bar goes away, and asserts the search addon's clearDecorations()
// actually ran — the behaviour, not the shape of the source.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** Stands in for the SearchAddon instance useTerminal owns. */
const searchAddon = { clearDecorations: vi.fn(), findNext: vi.fn(), findPrevious: vi.fn() };

vi.mock('../../../hooks/useTerminal', () => ({
  // Mirrors the real hook's three-line wrappers, so the assertion lands on
  // the addon call the production code makes.
  useTerminal: () => ({
    terminal: { current: null },
    terminalInstance: null,
    fit: vi.fn(),
    searchAddonRef: { current: searchAddon },
    findNext: (text: string) => searchAddon.findNext(text),
    findPrevious: (text: string) => searchAddon.findPrevious(text),
    clearSearch: () => searchAddon.clearDecorations(),
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
  workspaces: [],
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
    searchAddon.clearDecorations.mockClear();
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
});
