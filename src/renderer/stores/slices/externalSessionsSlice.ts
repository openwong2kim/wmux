/**
 * External sessions: coding agents started outside wmux that report through
 * the hook bridge (src/shared/externalSessions.ts). The daemon owns the
 * registry and main pushes the whole list on every change; this slice only
 * mirrors it. wmux shows their status, never their terminal.
 */
import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { ExternalSession, ExternalSessionsApi } from '../../../shared/externalSessions';

/**
 * The preload's external sessions API, or undefined on a build or window
 * without it (an older preload, the web mirror). Every caller goes through
 * here, so the renderer never assumes the bridge is there.
 */
export function externalSessionsApi(): ExternalSessionsApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { electronAPI?: { externalSessions?: ExternalSessionsApi } }).electronAPI?.externalSessions;
}

export interface ExternalSessionsSlice {
  externalSessions: ExternalSession[];
  /** The "Outside wmux" group's fold, once the user toggled it (this app session). */
  externalSessionsGroupOpen: boolean | null;
  setExternalSessions: (sessions: ExternalSession[]) => void;
  /** Drop a session from the list until it sends a new signal. */
  hideExternalSession: (id: string) => Promise<void>;
  setExternalSessionsGroupOpen: (open: boolean) => void;
}

export const createExternalSessionsSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  ExternalSessionsSlice
> = (set, get) => ({
  externalSessions: [],
  externalSessionsGroupOpen: null,

  setExternalSessions: (sessions) => set((state) => {
    state.externalSessions = Array.isArray(sessions) ? sessions : [];
  }),

  hideExternalSession: async (id) => {
    // Gone from the list at once; the daemon's next push confirms it.
    set((state) => {
      state.externalSessions = state.externalSessions.filter((s) => s.id !== id);
    });
    const api = externalSessionsApi();
    if (!api) return;
    try {
      await api.hide(id);
    } catch {
      // Not hidden after all: show the daemon's list again rather than a row
      // that comes back on some later push.
      const sessions = await api.list().catch(() => undefined);
      if (sessions) get().setExternalSessions(sessions);
    }
  },

  setExternalSessionsGroupOpen: (open) => set((state) => {
    state.externalSessionsGroupOpen = open;
  }),
});
