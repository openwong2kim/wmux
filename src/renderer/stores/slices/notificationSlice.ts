import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { Notification } from '../../../shared/types';
import { generateId } from '../../../shared/types';

export interface NotificationSlice {
  notifications: Notification[];
  // O(S) index: unread count keyed by surfaceId. Maintained incrementally at
  // every mutation site so Pane's badge selector avoids the O(P×N×S) full-array
  // filter. Workspace-scoped notifications (no surfaceId) are intentionally not
  // keyed here — they carry no surface to attribute to.
  unreadBySurfaceId: Record<string, number>;
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp' | 'read'>) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  markAllReadForWorkspace: (workspaceId: string) => void;
  jumpToUnread: () => string | null;
  clearNotifications: () => void;
}

// Decrement a surfaceId bucket, clamping at 0 and deleting zeroed keys so the
// map stays small on long-running sessions. Exported so other slices that mark
// notifications read (e.g. workspaceSlice.setActiveWorkspace) keep the index in
// sync instead of drifting.
export function decUnread(map: Record<string, number>, surfaceId: string): void {
  const next = (map[surfaceId] ?? 0) - 1;
  if (next > 0) {
    map[surfaceId] = next;
  } else {
    delete map[surfaceId];
  }
}

// Dev-only invariant: recompute the true unread-by-surface count from the
// notifications array and console.error on any drift. `process.env.NODE_ENV` is
// statically replaced by the renderer bundler, so this whole block is dead-code
// eliminated in production builds.
function assertUnreadInvariant(state: StoreState): void {
  if (process.env.NODE_ENV === 'production') return;
  const truth: Record<string, number> = {};
  for (const n of state.notifications) {
    if (n.read || !n.surfaceId) continue;
    truth[n.surfaceId] = (truth[n.surfaceId] ?? 0) + 1;
  }
  const map = state.unreadBySurfaceId;
  const keys = new Set([...Object.keys(truth), ...Object.keys(map)]);
  for (const k of keys) {
    if ((truth[k] ?? 0) !== (map[k] ?? 0)) {
      // eslint-disable-next-line no-console
      console.error(
        `[notificationSlice] unreadBySurfaceId drift for surface "${k}": ` +
          `map=${map[k] ?? 0} truth=${truth[k] ?? 0}`,
      );
    }
  }
}

export const createNotificationSlice: StateCreator<StoreState, [['zustand/immer', never]], [], NotificationSlice> = (set, get) => ({
  notifications: [],
  unreadBySurfaceId: {},

  addNotification: (notification) => set((state: StoreState) => {
    const added: Notification = {
      ...notification,
      id: generateId('notif'),
      timestamp: Date.now(),
      read: false,
    };
    state.notifications.push(added);
    // New unread notification: index it (skip workspace-scoped entries that
    // have no surfaceId — they must not create an `undefined` key).
    if (added.surfaceId) {
      state.unreadBySurfaceId[added.surfaceId] =
        (state.unreadBySurfaceId[added.surfaceId] ?? 0) + 1;
    }
    // Cap 500 chosen for daemon long-running sessions; eviction prefers read entries (line 26-32).
    if (state.notifications.length > 500) {
      const readOld = state.notifications.findIndex((n) => n.read);
      if (readOld !== -1) {
        // Evicted entry is READ — no unread bookkeeping needed.
        state.notifications.splice(readOld, 1);
      } else {
        // 모두 unread면 가장 오래된 것 제거 — the evicted entry is UNREAD, so
        // its surface bucket must be decremented.
        const evicted = state.notifications.shift();
        if (evicted?.surfaceId) decUnread(state.unreadBySurfaceId, evicted.surfaceId);
      }
    }
    // Update workspace metadata lastNotification
    const ws = state.workspaces.find((w) => w.id === notification.workspaceId);
    if (ws) {
      if (!ws.metadata) ws.metadata = {};
      ws.metadata.lastNotification = Date.now();
    }
    assertUnreadInvariant(state);
  }),

  markRead: (id) => set((state: StoreState) => {
    const notif = state.notifications.find((n) => n.id === id);
    // Only decrement when the notification was actually unread (idempotent on
    // repeated markRead of the same id).
    if (notif && !notif.read) {
      notif.read = true;
      if (notif.surfaceId) decUnread(state.unreadBySurfaceId, notif.surfaceId);
    }
    assertUnreadInvariant(state);
  }),

  markAllRead: () => set((state: StoreState) => {
    for (const n of state.notifications) {
      n.read = true;
    }
    state.unreadBySurfaceId = {};
    // Global mark-all-read is the strongest "seen everything" signal we have;
    // the visual ring should collapse alongside. Guarded for unit tests that
    // mount notificationSlice without paneSlice (no paneNotificationRing
    // field on the test store).
    if (state.paneNotificationRing) {
      state.paneNotificationRing = {};
    }
    assertUnreadInvariant(state);
  }),

  markAllReadForWorkspace: (workspaceId) => set((state: StoreState) => {
    for (const n of state.notifications) {
      if (n.workspaceId === workspaceId && !n.read) {
        n.read = true;
        if (n.surfaceId) decUnread(state.unreadBySurfaceId, n.surfaceId);
      }
    }
    assertUnreadInvariant(state);
  }),

  jumpToUnread: () => {
    const state = get();
    const alive = new Set(state.workspaces.map((w) => w.id));
    let best: Notification | null = null;
    for (const n of state.notifications) {
      if (n.read) continue;
      if (!alive.has(n.workspaceId)) continue;
      if (best === null || n.timestamp > best.timestamp) {
        best = n;
      }
    }
    return best ? best.workspaceId : null;
  },

  clearNotifications: () => set((state: StoreState) => {
    state.notifications = [];
    state.unreadBySurfaceId = {};
    assertUnreadInvariant(state);
  }),
});
