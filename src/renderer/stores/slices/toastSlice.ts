/**
 * T4 — UI toast slice.
 *
 * Minimal transient toast system for surfacing IPC errors (and other
 * ephemeral messages) to the user. Consumed by the `useIpc` adapter hook
 * and rendered by `<ToastContainer />`.
 *
 * NOTE: This is a separate surface from the per-workspace `notifications`
 * list (which is persistent agent/CLI output). Toasts here are short-lived
 * UI affordances only.
 */
import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { generateId } from '../../../shared/types';

export type ToastLevel = 'info' | 'warn' | 'error';

export interface Toast {
  id: string;
  message: string;
  level: ToastLevel;
  /**
   * F5 — optional single action button (e.g. fan-out's "open diff"). When
   * present, ToastContainer renders a button that runs `onClick` then dismisses.
   */
  action?: {
    label: string;
    onClick: () => void;
  };
  /**
   * Click-jump target for notification-sourced toasts. When present,
   * clicking the toast body resolves via focusNotificationTarget (ptyId →
   * surfaceId → workspaceId) and lands on the originating pane — same
   * contract as clicking the OS toast or a notification-panel row.
   */
  target?: {
    ptyId?: string | null;
    workspaceId?: string | null;
    surfaceId?: string | null;
  };
}

export interface ToastSlice {
  toasts: Toast[];
  pushToast: (t: Omit<Toast, 'id'>) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

/** Cap to prevent runaway growth if many errors fire in a tight loop. */
const MAX_TOASTS = 10;

export const createToastSlice: StateCreator<StoreState, [['zustand/immer', never]], [], ToastSlice> = (set) => ({
  toasts: [],

  pushToast: (t) => {
    const id = generateId('toast');
    set((state: StoreState) => {
      state.toasts.push({ ...t, id });
      // Drop oldest if we exceed the cap.
      if (state.toasts.length > MAX_TOASTS) {
        state.toasts.splice(0, state.toasts.length - MAX_TOASTS);
      }
    });
    return id;
  },

  dismissToast: (id) => set((state: StoreState) => {
    const idx = state.toasts.findIndex((t) => t.id === id);
    if (idx !== -1) state.toasts.splice(idx, 1);
  }),

  clearToasts: () => set((state: StoreState) => {
    state.toasts = [];
  }),
});
