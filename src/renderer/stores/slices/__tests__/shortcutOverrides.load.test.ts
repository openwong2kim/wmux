import { describe, it, expect, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createWorkspace, type SessionData, type Workspace } from '../../../../shared/types';

// #1455 — loadSession must whitelist shortcutOverrides against the CURRENT
// keymap: a stale session (or a hand-edited session.json) must not carry an
// action that no longer exists, or a combo nobody can press, into the
// bindings forever. #1152 sessions stored a list of disabled combos instead;
// those migrate. Same combo-store harness as paneOrdinal.test.ts.
type ComboState = WorkspaceSlice & PaneSlice & {
  zoomedPaneId: string | null;
  pushToast: ReturnType<typeof vi.fn>;
  multiviewIds: string[];
  sidebarVisible: boolean;
  shortcutOverrides: Record<string, string | null>;
};

function createComboStore() {
  const seed: Workspace[] = [createWorkspace('Test', 1)];
  return create<ComboState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createPaneSlice(...args),
      workspaces: seed,
      activeWorkspaceId: seed[0].id,
      nextWorkspaceOrdinal: 2,
      zoomedPaneId: null,
      pushToast: vi.fn(),
      multiviewIds: [],
      sidebarVisible: false,
      shortcutOverrides: {},
    })),
  );
}

const baseSession = (): SessionData => ({
  workspaces: [createWorkspace('Loaded', 1)],
  activeWorkspaceId: '',
  sidebarVisible: false,
});

describe('loadSession — shortcut overrides', () => {
  it('keeps configurable actions with pressable combos, drops the rest', () => {
    const store = createComboStore();
    store.getState().loadSession({
      ...baseSession(),
      shortcutOverrides: {
        prevWorkspace: null,          // switched off — kept
        nextWorkspace: 'Ctrl+Alt+J',  // moved — kept
        newSurface: 'T',              // bare key would eat typing — dropped
        notAnAction: 'Ctrl+Q',        // unknown action — dropped
      },
    });
    expect(store.getState().shortcutOverrides).toEqual({ prevWorkspace: null, nextWorkspace: 'Ctrl+Alt+J' });
  });

  it('migrates a #1152 disabledShortcuts list', () => {
    const store = createComboStore();
    store.getState().loadSession({
      ...baseSession(),
      disabledShortcuts: [
        'Ctrl+T',            // real keymap entry — kept as newSurface: off
        'Ctrl+Shift+D',      // real keymap entry — kept as splitVertical: off
        'Ctrl+Alt+Delete',   // not in WMUX_KEYMAP — dropped
        42 as unknown as string, // junk from a hand-edited file — dropped
      ],
    });
    expect(store.getState().shortcutOverrides).toEqual({ newSurface: null, splitVertical: null });
  });

  it('prefers shortcutOverrides when a session carries both', () => {
    const store = createComboStore();
    store.getState().loadSession({
      ...baseSession(),
      disabledShortcuts: ['Ctrl+T'],
      shortcutOverrides: { richInput: null },
    });
    expect(store.getState().shortcutOverrides).toEqual({ richInput: null });
  });

  it('leaves the current value alone when the session has neither field (older save)', () => {
    const store = createComboStore();
    store.setState({ shortcutOverrides: { newSurface: null } });
    store.getState().loadSession(baseSession());
    expect(store.getState().shortcutOverrides).toEqual({ newSurface: null });
  });
});
