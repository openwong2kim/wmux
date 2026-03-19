import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { Notification } from '../../../shared/types';
import { generateId } from '../../../shared/types';

export interface NotificationSlice {
  notifications: Notification[];
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp' | 'read'>) => void;
  markRead: (id: string) => void;
  markAllReadForWorkspace: (workspaceId: string) => void;
  clearNotifications: () => void;
}

export const createNotificationSlice: StateCreator<StoreState, [['zustand/immer', never]], [], NotificationSlice> = (set) => ({
  notifications: [],

  addNotification: (notification) => set((state: StoreState) => {
    state.notifications.push({
      ...notification,
      id: generateId('notif'),
      timestamp: Date.now(),
      read: false,
    });
    // 500개 초과 시 읽은 오래된 알림 제거
    if (state.notifications.length > 500) {
      const readOld = state.notifications.findIndex((n) => n.read);
      if (readOld !== -1) {
        state.notifications.splice(readOld, 1);
      } else {
        // 모두 unread면 가장 오래된 것 제거
        state.notifications.shift();
      }
    }
    // Update workspace metadata lastNotification
    const ws = state.workspaces.find((w) => w.id === notification.workspaceId);
    if (ws) {
      if (!ws.metadata) ws.metadata = {};
      ws.metadata.lastNotification = Date.now();
    }
  }),

  markRead: (id) => set((state: StoreState) => {
    const notif = state.notifications.find((n) => n.id === id);
    if (notif) notif.read = true;
  }),

  markAllReadForWorkspace: (workspaceId) => set((state: StoreState) => {
    for (const n of state.notifications) {
      if (n.workspaceId === workspaceId) n.read = true;
    }
  }),

  clearNotifications: () => set((state: StoreState) => {
    state.notifications = [];
  }),
});
