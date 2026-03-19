import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from './slices/workspaceSlice';
import { createPaneSlice, type PaneSlice } from './slices/paneSlice';
import { createSurfaceSlice, type SurfaceSlice } from './slices/surfaceSlice';
import { createUISlice, type UISlice } from './slices/uiSlice';
import { createNotificationSlice, type NotificationSlice } from './slices/notificationSlice';

export type StoreState = WorkspaceSlice & PaneSlice & SurfaceSlice & UISlice & NotificationSlice;

export const useStore = create<StoreState>()(
  immer((...args) => ({
    ...createWorkspaceSlice(...args),
    ...createPaneSlice(...args),
    ...createSurfaceSlice(...args),
    ...createUISlice(...args),
    ...createNotificationSlice(...args),
  }))
);
