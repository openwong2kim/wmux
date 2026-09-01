import { describe, it, expect, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice } from '../paneSlice';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { createWorkspace, type SessionData, type Workspace } from '../../../../shared/types';

// #1152 — loadSession must whitelist disabledShortcuts against the CURRENT
// keymap: a stale session (or a hand-edited session.json) must not carry a
// combo that no longer exists into the disabled set forever, and junk types
// must not poison the string array. Same combo-store harness as
// paneOrdinal.test.ts.
type ComboState = WorkspaceSlice & PaneSlice & {
  zoomedPaneId: string | null;
  pushToast: ReturnType<typeof vi.fn>;
  multiviewIds: string[];
  sidebarVisible: boolean;
  disabledShortcuts: string[];
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
      disabledShortcuts: [],
    })),
  );
}

const baseSession = (): SessionData => ({
  workspaces: [createWorkspace('Loaded', 1)],
  activeWorkspaceId: '',
  sidebarVisible: false,
});

describe('#1152 loadSession — disabledShortcuts whitelist', () => {
  it('keeps known combos, drops unknown ones and non-strings', () => {
    const store = createComboStore();
    store.getState().loadSession({
      ...baseSession(),
      disabledShortcuts: [
        'Ctrl+T',            // real keymap entry — kept
        'Ctrl+Shift+D',      // real keymap entry — kept
        'Ctrl+Alt+Delete',   // not in WMUX_KEYMAP — dropped
        42 as unknown as string, // junk from a hand-edited file — dropped
      ],
    });
    expect(store.getState().disabledShortcuts).toEqual(['Ctrl+T', 'Ctrl+Shift+D']);
  });

  it('leaves the current value alone when the session has no field (older save)', () => {
    const store = createComboStore();
    store.setState({ disabledShortcuts: ['Ctrl+T'] });
    store.getState().loadSession(baseSession());
    expect(store.getState().disabledShortcuts).toEqual(['Ctrl+T']);
  });
});
