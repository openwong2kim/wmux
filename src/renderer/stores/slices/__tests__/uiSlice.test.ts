import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createUISlice, type UISlice } from '../uiSlice';

// Mock browser APIs that uiSlice touches
vi.mock('../../../i18n', () => ({
  setLocale: vi.fn(),
}));

vi.mock('../../../themes', () => ({
  applyCustomCssVars: vi.fn(),
  clearCustomCssVars: vi.fn(),
  DEFAULT_CUSTOM_THEME: {},
}));

// Mock DOM and electronAPI globals
const mockDocument = { documentElement: { setAttribute: vi.fn() } };
Object.defineProperty(globalThis, 'document', { value: mockDocument, writable: true });
Object.defineProperty(globalThis, 'window', {
  value: {
    electronAPI: {
      settings: {
        setToastEnabled: vi.fn(),
        setAutoUpdateEnabled: vi.fn(),
      },
    },
  },
  writable: true,
});

type TestState = UISlice;

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createUISlice(...args),
    }))
  );
}

describe('UISlice — prefix mode', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('setPrefixMode(true) sets prefixMode to true', () => {
    store.getState().setPrefixMode(true);
    expect(store.getState().prefixMode).toBe(true);
  });

  it('setPrefixMode(false) clears prefixMode AND prefixError', () => {
    // Set up some state first
    store.getState().setPrefixMode(true);
    store.getState().setPrefixError('unknown key');
    expect(store.getState().prefixMode).toBe(true);
    expect(store.getState().prefixError).toBe('unknown key');

    // Clearing prefix mode should also clear error
    store.getState().setPrefixMode(false);
    expect(store.getState().prefixMode).toBe(false);
    expect(store.getState().prefixError).toBeNull();
  });

  it('setPrefixError sets the error message', () => {
    store.getState().setPrefixError('bad key combo');
    expect(store.getState().prefixError).toBe('bad key combo');
  });
});

describe('UISlice — pane zoom', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('togglePaneZoom sets zoomedPaneId', () => {
    expect(store.getState().zoomedPaneId).toBeNull();
    store.getState().togglePaneZoom('pane-123');
    expect(store.getState().zoomedPaneId).toBe('pane-123');
  });

  it('togglePaneZoom same ID twice returns to null', () => {
    store.getState().togglePaneZoom('pane-abc');
    expect(store.getState().zoomedPaneId).toBe('pane-abc');

    store.getState().togglePaneZoom('pane-abc');
    expect(store.getState().zoomedPaneId).toBeNull();
  });
});

// First-run wizard (Plan 1.15) + cheat sheet (Plan 1.18) persistence flags.
// Mirrors the onboardingCompleted pattern: simple boolean flags backed by
// SessionData. Test the setters in isolation here; the load-back path is
// exercised via workspaceSlice.loadSession (covered separately when that
// path gets test coverage — see T5 report).
describe('UISlice — first-run + cheat sheet flags', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('initial state defaults firstRunCompleted and cheatSheetDismissed to false', () => {
    expect(store.getState().firstRunCompleted).toBe(false);
    expect(store.getState().cheatSheetDismissed).toBe(false);
  });

  it('setFirstRunCompleted(true) flips firstRunCompleted to true', () => {
    store.getState().setFirstRunCompleted(true);
    expect(store.getState().firstRunCompleted).toBe(true);
  });

  it('setCheatSheetDismissed(true) flips cheatSheetDismissed to true', () => {
    store.getState().setCheatSheetDismissed(true);
    expect(store.getState().cheatSheetDismissed).toBe(true);
  });

  // Settings reset path (D11 / T8b "Show keyboard cheat sheet" + Settings
  // "First-run setup" reset). The setters must accept false to undo a prior
  // dismiss/complete — otherwise the user can't reopen the cheat sheet or
  // restart the wizard.
  it('setFirstRunCompleted(false) resets firstRunCompleted after a true flip', () => {
    store.getState().setFirstRunCompleted(true);
    expect(store.getState().firstRunCompleted).toBe(true);

    store.getState().setFirstRunCompleted(false);
    expect(store.getState().firstRunCompleted).toBe(false);
  });

  it('setCheatSheetDismissed(false) resets cheatSheetDismissed after a true flip', () => {
    store.getState().setCheatSheetDismissed(true);
    expect(store.getState().cheatSheetDismissed).toBe(true);

    store.getState().setCheatSheetDismissed(false);
    expect(store.getState().cheatSheetDismissed).toBe(false);
  });

  it('flags are independent — setting one does not change the other', () => {
    store.getState().setCheatSheetDismissed(true);
    expect(store.getState().cheatSheetDismissed).toBe(true);
    expect(store.getState().firstRunCompleted).toBe(false);

    store.getState().setFirstRunCompleted(true);
    expect(store.getState().firstRunCompleted).toBe(true);
    // cheatSheetDismissed unchanged from earlier
    expect(store.getState().cheatSheetDismissed).toBe(true);
  });
});

describe('UISlice — multiview', () => {
  // toggleMultiviewWorkspace reads state.activeWorkspaceId, which lives on
  // WorkspaceSlice. The test store overlays an activeWorkspaceId field after
  // slice construction so we exercise the cross-slice behavior in isolation.
  function setActive(store: ReturnType<typeof createTestStore>, id: string) {
    // @ts-expect-error — augmenting TestState with cross-slice field
    store.setState({ activeWorkspaceId: id });
  }

  it('seeds the group with active when starting fresh', () => {
    const store = createTestStore();
    setActive(store, 'A');
    store.getState().toggleMultiviewWorkspace('B');
    expect(store.getState().multiviewIds).toEqual(['A', 'B']);
  });

  it('preserves Ctrl-click order across subsequent toggles', () => {
    const store = createTestStore();
    setActive(store, 'A');
    store.getState().toggleMultiviewWorkspace('C');
    store.getState().toggleMultiviewWorkspace('B');
    // Active seeded first, then C, then B — render iterates this exact order.
    expect(store.getState().multiviewIds).toEqual(['A', 'C', 'B']);
  });

  it('reseeds with new active when toggling outside a stale saved group', () => {
    // Regression: after preserving the saved group across setActiveWorkspace,
    // starting a fresh multiview from a non-member workspace must reset to
    // [newActive, newId] — otherwise AppLayout keeps the grid hidden because
    // the active id is not in multiviewIds. Caught by Codex 2026-05-12.
    const store = createTestStore();
    setActive(store, 'A');
    store.getState().toggleMultiviewWorkspace('B'); // multiview = [A, B]
    expect(store.getState().multiviewIds).toEqual(['A', 'B']);

    setActive(store, 'C'); // user plain-clicks C; group preserved but active outside
    store.getState().toggleMultiviewWorkspace('D'); // Ctrl-click D to start new multiview

    expect(store.getState().multiviewIds).toEqual(['C', 'D']);
  });

  it('clears multiview when toggling down to a single member', () => {
    const store = createTestStore();
    setActive(store, 'A');
    store.getState().toggleMultiviewWorkspace('B');
    expect(store.getState().multiviewIds).toEqual(['A', 'B']);

    store.getState().toggleMultiviewWorkspace('B'); // toggle B off
    expect(store.getState().multiviewIds).toEqual([]);
  });

  it('clearMultiview empties the saved group', () => {
    const store = createTestStore();
    setActive(store, 'A');
    store.getState().toggleMultiviewWorkspace('B');
    store.getState().toggleMultiviewWorkspace('C');
    expect(store.getState().multiviewIds).toEqual(['A', 'B', 'C']);

    store.getState().clearMultiview();
    expect(store.getState().multiviewIds).toEqual([]);
  });
});
