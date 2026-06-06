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

  // The `?` prefix action sets cheatSheetForceShown to override a previously
  // permanent dismissal. The flag must be independently togglable and start
  // false so the overlay's default lifetime is unchanged on fresh installs.
  it('cheatSheetForceShown defaults to false and toggles via setter', () => {
    expect(store.getState().cheatSheetForceShown).toBe(false);

    store.getState().setCheatSheetForceShown(true);
    expect(store.getState().cheatSheetForceShown).toBe(true);

    store.getState().setCheatSheetForceShown(false);
    expect(store.getState().cheatSheetForceShown).toBe(false);
  });

  it('setCheatSheetForceShown does not flip the permanent dismissal flag', () => {
    store.getState().setCheatSheetDismissed(true);
    store.getState().setCheatSheetForceShown(true);
    expect(store.getState().cheatSheetDismissed).toBe(true);
    expect(store.getState().cheatSheetForceShown).toBe(true);
  });
});

// Notification surface toggles (T5). Distinct knobs so users can quiet
// individual surfaces (pane ring / ring flash / taskbar flash / sound choice)
// without flipping the underlying notification feature flag. Mirrors the
// non-persisting shape of notificationRingEnabled / notificationSoundEnabled
// rather than the IPC-persisting toastEnabled. The dispatch layer (T3/T4)
// and main flashFrame hook (T6) read these flags before firing their
// respective side effects.
describe('UISlice — notification surface toggles (T5)', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  // ─── Defaults ───────────────────────────────────────────────────────────
  // Defaults must light up every surface so notifications "just work" on a
  // fresh install. Users opt out per surface from SettingsPanel; we never
  // ship with notifications dark by default.
  it('paneRingEnabled defaults to true', () => {
    expect(store.getState().paneRingEnabled).toBe(true);
  });

  it('paneFlashEnabled defaults to true', () => {
    expect(store.getState().paneFlashEnabled).toBe(true);
  });

  it('taskbarFlashEnabled defaults to true', () => {
    expect(store.getState().taskbarFlashEnabled).toBe(true);
  });

  it('notificationSoundChoice defaults to \'default\'', () => {
    expect(store.getState().notificationSoundChoice).toBe('default');
  });

  // ─── Setter flips ───────────────────────────────────────────────────────
  // Each setter must accept false to actually quiet its surface — without
  // this round-trip the SettingsPanel toggle is purely cosmetic.
  it('setPaneRingEnabled(false) flips paneRingEnabled to false', () => {
    store.getState().setPaneRingEnabled(false);
    expect(store.getState().paneRingEnabled).toBe(false);
  });

  it('setPaneFlashEnabled(false) flips paneFlashEnabled to false', () => {
    store.getState().setPaneFlashEnabled(false);
    expect(store.getState().paneFlashEnabled).toBe(false);
  });

  it('setTaskbarFlashEnabled(false) flips taskbarFlashEnabled to false', () => {
    store.getState().setTaskbarFlashEnabled(false);
    expect(store.getState().taskbarFlashEnabled).toBe(false);
  });

  // ─── notificationSoundChoice accepts both literals ─────────────────────
  // 'none' is the user-facing "mute the cue but keep the feature on" knob;
  // 'default' returns to the bundled cue. The setter is the only path that
  // mutates this field, so both literals must round-trip cleanly.
  it('setNotificationSoundChoice(\'none\') stores \'none\'', () => {
    store.getState().setNotificationSoundChoice('none');
    expect(store.getState().notificationSoundChoice).toBe('none');
  });

  it('setNotificationSoundChoice(\'default\') restores \'default\' after \'none\'', () => {
    store.getState().setNotificationSoundChoice('none');
    expect(store.getState().notificationSoundChoice).toBe('none');

    store.getState().setNotificationSoundChoice('default');
    expect(store.getState().notificationSoundChoice).toBe('default');
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

  // ─── focusMultiviewDirection (grid spatial nav) ────────────────────────
  // Regression: multiview arrow-nav was unimplemented. focusPaneDirection only
  // walks ONE workspace's pane tree (and bails at leaves<=1), so the arrows
  // were dead in the multiview grid. focusMultiviewDirection routes through
  // setActiveWorkspace, which the UISlice-only test store lacks — inject a spy
  // that also moves activeWorkspaceId so chained navigation works.
  function withMvNav(ids: string[], active: string) {
    const store = createTestStore();
    const setActiveWorkspace = vi.fn((id: string) => store.setState({
      // @ts-expect-error — cross-slice field overlaid for the test
      activeWorkspaceId: id,
    }));
    store.setState({
      multiviewIds: ids,
      // @ts-expect-error — cross-slice fields injected for the test
      activeWorkspaceId: active,
      setActiveWorkspace,
    });
    return { store, setActiveWorkspace };
  }

  it('2-tile row: right/left move between tiles, up/down no-op', () => {
    const { store, setActiveWorkspace } = withMvNav(['A', 'B'], 'A');
    store.getState().focusMultiviewDirection('right');
    expect(setActiveWorkspace).toHaveBeenLastCalledWith('B');
    store.getState().focusMultiviewDirection('left');
    expect(setActiveWorkspace).toHaveBeenLastCalledWith('A');
    setActiveWorkspace.mockClear();
    store.getState().focusMultiviewDirection('up');
    store.getState().focusMultiviewDirection('down');
    expect(setActiveWorkspace).not.toHaveBeenCalled();
  });

  it('2x2 grid: spatial nav in all four directions', () => {
    // Layout (2 cols): A B / C D
    const { store, setActiveWorkspace } = withMvNav(['A', 'B', 'C', 'D'], 'A');
    store.getState().focusMultiviewDirection('right'); // A→B
    expect(setActiveWorkspace).toHaveBeenLastCalledWith('B');
    store.getState().focusMultiviewDirection('down');  // B→D
    expect(setActiveWorkspace).toHaveBeenLastCalledWith('D');
    store.getState().focusMultiviewDirection('left');  // D→C
    expect(setActiveWorkspace).toHaveBeenLastCalledWith('C');
    store.getState().focusMultiviewDirection('up');    // C→A
    expect(setActiveWorkspace).toHaveBeenLastCalledWith('A');
  });

  it('no-op at the top-left grid edge', () => {
    const { store, setActiveWorkspace } = withMvNav(['A', 'B', 'C', 'D'], 'A');
    store.getState().focusMultiviewDirection('left'); // col 0 → no-op
    store.getState().focusMultiviewDirection('up');   // row 0 → no-op
    expect(setActiveWorkspace).not.toHaveBeenCalled();
  });

  it('no-op when fewer than 2 tiles or active is not a member', () => {
    const single = withMvNav(['A'], 'A');
    single.store.getState().focusMultiviewDirection('right');
    expect(single.setActiveWorkspace).not.toHaveBeenCalled();

    const orphan = withMvNav(['A', 'B'], 'Z');
    orphan.store.getState().focusMultiviewDirection('right');
    expect(orphan.setActiveWorkspace).not.toHaveBeenCalled();
  });

  // ─── removeMultiviewWorkspace (close-button primitive) ─────────────────
  // Regression set for the multiview-X bug. Before the fix, the tile X
  // button called clearMultiview() so any tile collapsed the whole group.
  // The fix introduces a dedicated remove primitive so close intent cannot
  // accidentally re-add the workspace through toggle semantics.

  it('removeMultiviewWorkspace removes only the targeted workspace from a 3+ group', () => {
    // [A, B, C] active A. Click X on inactive B → grid stays as [A, C].
    // Pre-fix this collapsed to []; the active-tile case still collapses
    // unless AppLayout reassigns active, but the slice itself must leave
    // the remaining members alone.
    const store = createTestStore();
    setActive(store, 'A');
    store.getState().toggleMultiviewWorkspace('B');
    store.getState().toggleMultiviewWorkspace('C');
    expect(store.getState().multiviewIds).toEqual(['A', 'B', 'C']);

    store.getState().removeMultiviewWorkspace('B');
    expect(store.getState().multiviewIds).toEqual(['A', 'C']);
  });

  it('removeMultiviewWorkspace auto-collapses when only one member would remain', () => {
    // [A, B] active A. Removing either side leaves a single member, which
    // is meaningless for a multiview, so multiviewIds is cleared. The
    // render gate then falls through to single view, matching the
    // toggleMultiviewWorkspace auto-clear rule.
    const store = createTestStore();
    setActive(store, 'A');
    store.getState().toggleMultiviewWorkspace('B');
    expect(store.getState().multiviewIds).toEqual(['A', 'B']);

    store.getState().removeMultiviewWorkspace('B');
    expect(store.getState().multiviewIds).toEqual([]);
  });

  it('removeMultiviewWorkspace is a no-op for non-members', () => {
    // A stray X click on a workspace that was never in the multiview group
    // (e.g. a sidebar event firing into the slice) must not mutate state.
    const store = createTestStore();
    setActive(store, 'A');
    store.getState().toggleMultiviewWorkspace('B');
    store.getState().toggleMultiviewWorkspace('C');
    expect(store.getState().multiviewIds).toEqual(['A', 'B', 'C']);

    store.getState().removeMultiviewWorkspace('Z'); // not a member
    expect(store.getState().multiviewIds).toEqual(['A', 'B', 'C']);
  });
});

describe('UISlice — terminal text-drop trust boundary', () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  it('terminalTextDropDragActive defaults to false', () => {
    expect(store.getState().terminalTextDropDragActive).toBe(false);
  });

  it('setTerminalTextDropDragActive toggles the internal drag marker', () => {
    store.getState().setTerminalTextDropDragActive(true);
    expect(store.getState().terminalTextDropDragActive).toBe(true);

    store.getState().setTerminalTextDropDragActive(false);
    expect(store.getState().terminalTextDropDragActive).toBe(false);
  });
});
