import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createUISlice, type UISlice } from '../uiSlice';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createWorkspace, type Workspace } from '../../../../shared/types';

// S3 — color inspect-mode state machine (PR2 foundation). Covers enterInspect's
// D-builtin seed/switch, D-exclusive teardown of competing surfaces, the
// reverse-guard on palette/notification open, exitInspect reset, and the
// D-teardown hook on workspace switch (exercised through the real
// setActiveWorkspace path in workspaceSlice).

vi.mock('../../../i18n', () => ({
  setLocale: vi.fn(),
}));

// Mock themes so enterInspect's DOM side-effects (applyCustomCssVars / setTheme
// data-theme attr) are no-ops, while builtinToCustom + UI_THEME_TOKENS return
// realistic shapes so the seed/branch logic is genuinely exercised.
vi.mock('../../../themes', () => ({
  applyCustomCssVars: vi.fn(),
  clearCustomCssVars: vi.fn(),
  DEFAULT_CUSTOM_THEME: { bgBase: '#000000', xtermPaletteId: 'catppuccin-mocha' },
  migrateCustomThemeColors: (c: unknown) => c,
  builtinToCustom: (id: string) => ({ bgBase: `seed-${id}`, xtermPaletteId: 'catppuccin-mocha' }),
  UI_THEME_TOKENS: {
    amber: {}, forge: {}, 'catppuccin-mocha': {}, monochrome: {}, 'stars-and-stripes': {}, 'red-dynasty': {},
    nightowl: {}, void: {}, hinomaru: {}, taegeuk: {},
  },
}));

// Mock the events publisher pulled in transitively by workspaceSlice.
vi.mock('../../events/publisher', () => ({
  publishWorkspaceMetadataChanged: vi.fn(),
}));

const mockDocument = { documentElement: { setAttribute: vi.fn() } };
Object.defineProperty(globalThis, 'document', { value: mockDocument, writable: true });
Object.defineProperty(globalThis, 'window', {
  value: { electronAPI: { settings: { setToastEnabled: vi.fn(), setAutoUpdateEnabled: vi.fn() } } },
  writable: true,
});

function createUIStore() {
  return create<UISlice>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createUISlice(...args),
    }))
  );
}

describe('UISlice — inspect mode: defaults', () => {
  it('starts inactive with no target', () => {
    const store = createUIStore();
    expect(store.getState().inspectModeActive).toBe(false);
    expect(store.getState().inspectMinimized).toBe(false);
    expect(store.getState().inspectTargetToken).toBeNull();
  });
});

describe('UISlice — enterInspect (D-builtin seed + D-exclusive)', () => {
  let store: ReturnType<typeof createUIStore>;
  beforeEach(() => { store = createUIStore(); });

  it('seeds a custom theme + switches to custom when entering from a built-in', () => {
    // Default theme is 'forge' (a built-in) — entering must seed.
    expect(store.getState().theme).toBe('forge');
    store.getState().enterInspect();

    expect(store.getState().theme).toBe('custom');
    expect(store.getState().customThemeColors).toEqual({
      bgBase: 'seed-forge',
      xtermPaletteId: 'catppuccin-mocha', // mock builtinToCustom's fixed palette id
    });
    expect(store.getState().inspectModeActive).toBe(true);
  });

  it('falls back to catppuccin-mocha seed for an unknown current theme', () => {
    store.getState().setTheme('not-a-real-theme');
    store.getState().enterInspect();
    expect(store.getState().customThemeColors).toEqual({
      bgBase: 'seed-catppuccin-mocha',
      xtermPaletteId: 'catppuccin-mocha',
    });
    expect(store.getState().theme).toBe('custom');
  });

  it('does NOT re-seed when already on a custom theme', () => {
    store.getState().setTheme('custom');
    // @ts-expect-error — minimal custom shape for the test
    store.getState().setCustomThemeColors({ bgBase: 'user-picked', xtermPaletteId: 'catppuccin-mocha' });
    store.getState().enterInspect();
    // Untouched — no builtinToCustom overwrite.
    expect(store.getState().customThemeColors).toEqual({
      bgBase: 'user-picked', xtermPaletteId: 'catppuccin-mocha',
    });
    expect(store.getState().theme).toBe('custom');
  });

  it('sets the minimized Settings invariant (active ⇒ settings ∧ minimized)', () => {
    store.getState().enterInspect();
    expect(store.getState().inspectModeActive).toBe(true);
    expect(store.getState().inspectMinimized).toBe(true);
    expect(store.getState().settingsPanelVisible).toBe(true);
  });

  it('closes the command palette and notification panel on entry (D-exclusive)', () => {
    store.getState().setCommandPaletteVisible(true);
    store.getState().setNotificationPanelVisible(true);
    store.getState().enterInspect();
    expect(store.getState().commandPaletteVisible).toBe(false);
    expect(store.getState().notificationPanelVisible).toBe(false);
  });
});

describe('UISlice — inspect exclusivity (D-exclusive reverse guard)', () => {
  let store: ReturnType<typeof createUIStore>;
  beforeEach(() => { store = createUIStore(); });

  it('toggleCommandPalette open tears inspect down', () => {
    store.getState().enterInspect();
    expect(store.getState().inspectModeActive).toBe(true);
    store.getState().toggleCommandPalette();
    expect(store.getState().commandPaletteVisible).toBe(true);
    expect(store.getState().inspectModeActive).toBe(false);
    expect(store.getState().inspectMinimized).toBe(false);
  });

  it('setCommandPaletteVisible(true) tears inspect down', () => {
    store.getState().enterInspect();
    store.getState().setCommandPaletteVisible(true);
    expect(store.getState().inspectModeActive).toBe(false);
  });

  it('toggleNotificationPanel open tears inspect down', () => {
    store.getState().enterInspect();
    store.getState().toggleNotificationPanel();
    expect(store.getState().notificationPanelVisible).toBe(true);
    expect(store.getState().inspectModeActive).toBe(false);
  });

  it('setNotificationPanelVisible(true) tears inspect down', () => {
    store.getState().enterInspect();
    store.getState().setNotificationPanelVisible(true);
    expect(store.getState().inspectModeActive).toBe(false);
  });

  it('closing a surface (visible=false) does NOT touch inspect state', () => {
    store.getState().enterInspect();
    store.getState().setCommandPaletteVisible(false);
    store.getState().setNotificationPanelVisible(false);
    expect(store.getState().inspectModeActive).toBe(true);
  });

  it('toggleSettingsPanel SHUT while inspecting tears inspect down (no Settings-less inspect)', () => {
    store.getState().enterInspect();
    expect(store.getState().settingsPanelVisible).toBe(true);
    expect(store.getState().inspectModeActive).toBe(true);
    // Ctrl+, while inspecting → settingsPanelVisible true→false. The invariant
    // inspectModeActive ⇒ settingsPanelVisible would otherwise be violated.
    store.getState().toggleSettingsPanel();
    expect(store.getState().settingsPanelVisible).toBe(false);
    expect(store.getState().inspectModeActive).toBe(false);
    expect(store.getState().inspectMinimized).toBe(false);
    expect(store.getState().inspectTargetToken).toBeNull();
  });

  it('toggleSettingsPanel OPEN does not spuriously touch inspect (inspect was off)', () => {
    // Sanity: the teardown only runs on the shut branch. Opening Settings from
    // a clean state must not flip any inspect field.
    expect(store.getState().settingsPanelVisible).toBe(false);
    store.getState().toggleSettingsPanel();
    expect(store.getState().settingsPanelVisible).toBe(true);
    expect(store.getState().inspectModeActive).toBe(false);
  });
});

describe('UISlice — exitInspect + setInspectTarget', () => {
  let store: ReturnType<typeof createUIStore>;
  beforeEach(() => { store = createUIStore(); });

  it('setInspectTarget records the token/role pair', () => {
    store.getState().setInspectTarget('bgSurface', 'bg');
    expect(store.getState().inspectTargetToken).toEqual({ token: 'bgSurface', role: 'bg' });
  });

  it('exitInspect resets all three fields but keeps Settings open', () => {
    store.getState().enterInspect();
    store.getState().setInspectTarget('accent', 'accent');
    expect(store.getState().inspectModeActive).toBe(true);

    store.getState().exitInspect();
    expect(store.getState().inspectModeActive).toBe(false);
    expect(store.getState().inspectMinimized).toBe(false);
    expect(store.getState().inspectTargetToken).toBeNull();
    // Settings stays mounted → ESC/done returns to the full panel (D-settings).
    expect(store.getState().settingsPanelVisible).toBe(true);
  });
});

// ─── Integration glue (P0): a picked target must NOT tear inspect down ──────
// The overlay's pickToken/pickTerminal set a target and STAY in inspect so the
// Settings picker can open underneath (the overlay yields capture). Only ESC /
// Done (exitInspect) leaves the mode. These assert the store-side contract the
// overlay relies on; the pointer-events yield itself is overlayShouldCapture.
describe('UISlice — inspect target lifecycle (integration glue)', () => {
  let store: ReturnType<typeof createUIStore>;
  beforeEach(() => { store = createUIStore(); });

  it('a UI-token pick keeps inspect active with the target pending', () => {
    store.getState().enterInspect();
    // Mirrors overlay.pickToken — setInspectTarget WITHOUT exitInspect.
    store.getState().setInspectTarget('bgSurface', 'bg');
    expect(store.getState().inspectTargetToken).toEqual({ token: 'bgSurface', role: 'bg' });
    // Must NOT have torn inspect down (the old exitInspect-on-pick bug).
    expect(store.getState().inspectModeActive).toBe(true);
    expect(store.getState().inspectMinimized).toBe(true);
    expect(store.getState().settingsPanelVisible).toBe(true);
  });

  it('a terminal-slot pick keeps inspect active with the slot pending', () => {
    store.getState().enterInspect();
    store.getState().setInspectXtermTarget('background');
    expect(store.getState().inspectXtermTarget).toBe('background');
    expect(store.getState().inspectTargetToken).toBeNull(); // mutually exclusive
    expect(store.getState().inspectModeActive).toBe(true);
  });

  it('clearInspectTarget drops both targets but stays in inspect (hover resumes)', () => {
    store.getState().enterInspect();
    store.getState().setInspectTarget('accent', 'accent');
    store.getState().clearInspectTarget();
    expect(store.getState().inspectTargetToken).toBeNull();
    expect(store.getState().inspectXtermTarget).toBeNull();
    // Crucially still inspecting + minimized so the overlay re-arms hover and
    // the user can pick a second region (the "stranded after one click" bug).
    expect(store.getState().inspectModeActive).toBe(true);
    expect(store.getState().inspectMinimized).toBe(true);
    expect(store.getState().settingsPanelVisible).toBe(true);
  });

  it('clearInspectTarget also clears a pending terminal slot', () => {
    store.getState().enterInspect();
    store.getState().setInspectXtermTarget('foreground');
    store.getState().clearInspectTarget();
    expect(store.getState().inspectXtermTarget).toBeNull();
    expect(store.getState().inspectModeActive).toBe(true);
  });

  it('pick → clear → pick a second region round-trips (multi-pick session)', () => {
    store.getState().enterInspect();
    store.getState().setInspectTarget('bgBase', 'bg');
    store.getState().clearInspectTarget();      // user closed the first picker
    store.getState().setInspectTarget('textMain', 'text'); // hover-picks again
    expect(store.getState().inspectTargetToken).toEqual({ token: 'textMain', role: 'text' });
    expect(store.getState().inspectModeActive).toBe(true);
  });

  it('clearInspectTarget on a no-target inspect session is a safe no-op', () => {
    store.getState().enterInspect();
    store.getState().clearInspectTarget();
    expect(store.getState().inspectTargetToken).toBeNull();
    expect(store.getState().inspectModeActive).toBe(true);
  });
});

// D-teardown is implemented inside workspaceSlice.setActiveWorkspace via the
// shared resetInspectState helper, so we exercise the real switch path against
// a workspace store with the inspect fields overlaid.
describe('WorkspaceSlice — inspect teardown on workspace switch (D-teardown)', () => {
  type TestState = WorkspaceSlice & {
    inspectModeActive: boolean;
    inspectMinimized: boolean;
    inspectTargetToken: { token: string; role: string } | null;
  };

  function createWsStore(workspaces: Workspace[], activeId: string, inspectActive: boolean) {
    return create<TestState>()(
      immer((...args) => ({
        // @ts-expect-error — minimal test store doesn't match full StoreState
        ...createWorkspaceSlice(...args),
        workspaces,
        activeWorkspaceId: activeId,
        inspectModeActive: inspectActive,
        inspectMinimized: inspectActive,
        inspectTargetToken: inspectActive ? { token: 'bgSurface', role: 'bg' } : null,
      }))
    );
  }

  it('exits inspect when switching to a different workspace', () => {
    const a = createWorkspace('A');
    const b = createWorkspace('B');
    const store = createWsStore([a, b], a.id, true);

    store.getState().setActiveWorkspace(b.id);
    expect(store.getState().activeWorkspaceId).toBe(b.id);
    expect(store.getState().inspectModeActive).toBe(false);
    expect(store.getState().inspectMinimized).toBe(false);
    expect(store.getState().inspectTargetToken).toBeNull();
  });

  it('leaves inspect untouched when the switch is a no-op (unknown id)', () => {
    const a = createWorkspace('A');
    const store = createWsStore([a], a.id, true);
    store.getState().setActiveWorkspace('does-not-exist');
    // Early return before the teardown hook — inspect stays active.
    expect(store.getState().inspectModeActive).toBe(true);
  });

  it('does nothing inspect-related when inspect was already inactive', () => {
    const a = createWorkspace('A');
    const b = createWorkspace('B');
    const store = createWsStore([a, b], a.id, false);
    store.getState().setActiveWorkspace(b.id);
    expect(store.getState().inspectModeActive).toBe(false);
  });

  // D-teardown also fires on removeWorkspace — killing/closing a workspace
  // (sidebar X, Ctrl+Shift+W, prefix &) unmounts the marked-region DOM, so a
  // stale inspect overlay must not survive it.
  it('exits inspect when the active workspace is removed', () => {
    const a = createWorkspace('A');
    const b = createWorkspace('B');
    const store = createWsStore([a, b], a.id, true);

    store.getState().removeWorkspace(a.id);
    // a was active → activeWorkspaceId moves to the surviving workspace.
    expect(store.getState().activeWorkspaceId).toBe(b.id);
    expect(store.getState().inspectModeActive).toBe(false);
    expect(store.getState().inspectMinimized).toBe(false);
    expect(store.getState().inspectTargetToken).toBeNull();
  });

  it('exits inspect even when a NON-active workspace is removed', () => {
    // Removing any workspace can drop regions the overlay queried; tear down
    // regardless of whether the removed one was active.
    const a = createWorkspace('A');
    const b = createWorkspace('B');
    const store = createWsStore([a, b], a.id, true);

    store.getState().removeWorkspace(b.id);
    expect(store.getState().activeWorkspaceId).toBe(a.id); // active unchanged
    expect(store.getState().inspectModeActive).toBe(false);
  });

  it('leaves inspect untouched when removeWorkspace is a no-op (last workspace / unknown id)', () => {
    const a = createWorkspace('A');
    const store = createWsStore([a], a.id, true);
    // Single-workspace removal is refused early (workspaces.length <= 1).
    store.getState().removeWorkspace(a.id);
    expect(store.getState().inspectModeActive).toBe(true);
  });

  it('does nothing inspect-related on removeWorkspace when inspect was inactive', () => {
    const a = createWorkspace('A');
    const b = createWorkspace('B');
    const store = createWsStore([a, b], a.id, false);
    store.getState().removeWorkspace(a.id);
    expect(store.getState().inspectModeActive).toBe(false);
  });
});
