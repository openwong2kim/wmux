/**
 * Moa (the HQ main bot) — the renderer's copy of main's Moa state: the master
 * switch and its settings, the HQ workspace and its state, and the archived-
 * decision notice. Main owns all of it (deckHqStore.ts); this slice mirrors
 * DECK_MOA_STATE and re-reads it on DECK_MOA_CHANGED (useMoaSync).
 *
 * The HQ workspace is app-owned: it is created here (never by the operator),
 * hidden from the normal workspace list, and cannot be closed or archived
 * (`isMoaHqWorkspace`, enforced in workspaceSlice).
 */
import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { createWorkspace } from '../../../shared/types';
import { MOA_WORKSPACE_NAME, type MoaState } from '../../../shared/moa';

export interface MoaSlice {
  /** null until the first read answers (or when the bridge is unavailable). */
  moa: MoaState | null;
  refreshMoa: () => Promise<void>;
  /** Create the app-owned "Moa" workspace (not activated) and make it the HQ.
   *  First run and "Recreate Moa workspace" both use this. The workspace is
   *  removed again when main refuses. */
  createMoaHq: () => Promise<{ ok: boolean; code?: string; archived?: number }>;
  /** Show the HQ workspace (the Moa rail entry). */
  openMoaHq: () => void;
}

/** True when `workspaceId` is the designated HQ. */
export function isMoaHqWorkspace(state: Pick<StoreState, 'moa'>, workspaceId: string): boolean {
  const hq = state.moa?.hq.workspaceId;
  return !!hq && hq === workspaceId;
}

export const createMoaSlice: StateCreator<StoreState, [['zustand/immer', never]], [], MoaSlice> = (set, get) => ({
  moa: null,

  refreshMoa: async () => {
    const api = window.electronAPI?.deck?.moa;
    if (!api?.state) return;
    try {
      const next = await api.state();
      set((state: StoreState) => { state.moa = next; });
    } catch {
      // keep the last known state
    }
  },

  createMoaHq: async () => {
    const api = window.electronAPI?.deck?.moa;
    if (!api?.setup) return { ok: false, code: 'unavailable' };
    let id = '';
    set((state: StoreState) => {
      const ordinal = state.nextWorkspaceOrdinal ?? 1;
      const ws = createWorkspace(MOA_WORKSPACE_NAME, ordinal);
      state.nextWorkspaceOrdinal = ordinal + 1;
      state.workspaces.push(ws);
      id = ws.id;
    });
    let result: { ok: boolean; code?: string; archived?: number };
    try {
      result = await api.setup(id);
    } catch {
      result = { ok: false, code: 'failed' };
    }
    if (!result.ok) {
      set((state: StoreState) => { state.workspaces = state.workspaces.filter((w) => w.id !== id); });
    }
    await get().refreshMoa();
    return result;
  },

  openMoaHq: () => {
    const hq = get().moa?.hq;
    if (!hq?.workspaceId || hq.state !== 'ok') return;
    get().setActiveWorkspace(hq.workspaceId);
  },
});
