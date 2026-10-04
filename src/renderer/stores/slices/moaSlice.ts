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
import { MOA_WORKSPACE_NAME, type MoaSetupResult, type MoaState } from '../../../shared/moa';

/** localStorage key holding the last HQ id main reported. Read at boot so the
 *  HQ stays hidden and guarded before the first DECK_MOA_STATE answers. */
export const MOA_HQ_SEED_KEY = 'wmux.moa.hqWorkspaceId';

/** The last known HQ id, or null (no record, or storage unavailable). */
export function readMoaHqSeed(): string | null {
  try {
    const v = globalThis.localStorage?.getItem(MOA_HQ_SEED_KEY);
    return v ? v : null;
  } catch {
    return null;
  }
}

/** Remember the HQ id main just reported (or forget it when there is none). */
export function writeMoaHqSeed(id: string | null): void {
  try {
    if (id) globalThis.localStorage?.setItem(MOA_HQ_SEED_KEY, id);
    else globalThis.localStorage?.removeItem(MOA_HQ_SEED_KEY);
  } catch {
    // storage unavailable: the seed is a boot-time convenience only
  }
}

export interface MoaSlice {
  /** null until the first read answers (or when the bridge is unavailable). */
  moa: MoaState | null;
  /** The HQ id remembered from the last run. Stands in for `moa.hq.workspaceId`
   *  only while `moa` is null (boot); once main answers, main's value wins. */
  moaHqSeed: string | null;
  /** A workspace main already made the HQ while a later setup step failed
   *  (`committed: true`). Kept so a retry finishes the setup on the same
   *  workspace instead of creating another one. */
  moaHqPendingId: string | null;
  refreshMoa: () => Promise<void>;
  /** Create the app-owned "Moa" workspace (not activated) and make it the HQ.
   *  First run and "Recreate Moa workspace" both use this. With a pending
   *  workspace (see `moaHqPendingId`) it retries setup on that one instead.
   *  The new workspace is removed again when main refuses before committing. */
  createMoaHq: () => Promise<MoaSetupResult>;
  /** Show the HQ workspace (the Moa rail entry). */
  openMoaHq: () => void;
}

type HqView = Pick<StoreState, 'moa'> & { moaHqSeed?: string | null };

/** The HQ workspace id, or null when there is none. Before main's first
 *  answer this is the remembered id from the last run. */
export function moaHqId(state: HqView): string | null {
  if (state.moa) return state.moa.hq.workspaceId ?? null;
  return state.moaHqSeed ?? null;
}

/** True when `workspaceId` is the designated HQ. */
export function isMoaHqWorkspace(state: HqView, workspaceId: string): boolean {
  const hq = moaHqId(state);
  return !!hq && hq === workspaceId;
}

/** The workspaces the operator sees (and Ctrl+N counts): all but the HQ. */
export function listedWorkspaces<T extends { id: string }>(list: readonly T[], hqId: string | null): T[] {
  return hqId ? list.filter((w) => w.id !== hqId) : [...list];
}

export const createMoaSlice: StateCreator<StoreState, [['zustand/immer', never]], [], MoaSlice> = (set, get) => ({
  moa: null,
  moaHqSeed: readMoaHqSeed(),
  moaHqPendingId: null,

  refreshMoa: async () => {
    const api = window.electronAPI?.deck?.moa;
    if (!api?.state) return;
    let next: MoaState;
    try {
      next = await api.state();
    } catch {
      return; // keep the last known state
    }
    const prev = get().moa;
    set((state: StoreState) => { state.moa = next; });
    writeMoaHqSeed(next.hq.workspaceId);
    // Moa turned off while its workspace is on screen: the HQ is hidden from
    // the list, so leave it for the first listed workspace.
    const st = get();
    const hq = moaHqId(st);
    if (prev?.config.enabled && !next.config.enabled && hq && st.activeWorkspaceId === hq) {
      const first = listedWorkspaces(st.workspaces, hq)[0];
      if (first) st.setActiveWorkspace(first.id);
    }
  },

  createMoaHq: async () => {
    const api = window.electronAPI?.deck?.moa;
    if (!api?.setup) return { ok: false, code: 'unavailable' };
    const pending = get().moaHqPendingId;
    const reused = pending && get().workspaces.some((w) => w.id === pending) ? pending : null;
    const reuse = reused !== null;
    let id = reused ?? '';
    if (!reuse) {
      set((state: StoreState) => {
        const ordinal = state.nextWorkspaceOrdinal ?? 1;
        const ws = createWorkspace(MOA_WORKSPACE_NAME, ordinal);
        state.nextWorkspaceOrdinal = ordinal + 1;
        state.workspaces.push(ws);
        id = ws.id;
      });
    }
    let result: MoaSetupResult;
    try {
      result = await api.setup(id);
    } catch {
      result = { ok: false, code: 'failed' };
    }
    if (result.ok) {
      set((state: StoreState) => { state.moaHqPendingId = null; });
    } else if (result.committed === true) {
      // Main already made this workspace the HQ; only a later step failed.
      // Keep it, and let the retry finish setup on the same id.
      set((state: StoreState) => { state.moaHqPendingId = id; });
    } else {
      set((state: StoreState) => {
        // Failed before main committed anything: the workspace is ours to undo
        // (a reused pending one was committed earlier, so it stays).
        if (!reuse) state.workspaces = state.workspaces.filter((w) => w.id !== id);
      });
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
