import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from './slices/workspaceSlice';
import { createPaneSlice, type PaneSlice } from './slices/paneSlice';
import { createSurfaceSlice, type SurfaceSlice } from './slices/surfaceSlice';
import { createUISlice, type UISlice } from './slices/uiSlice';
import { createNotificationSlice, type NotificationSlice } from './slices/notificationSlice';
import { createA2aSlice, type A2aSlice } from './slices/a2aSlice';
import { createApprovalInboxSlice, type ApprovalInboxSlice } from './slices/approvalInboxSlice';
import { createCompanySlice, type CompanySlice } from './slices/companySlice';
import { createToastSlice, type ToastSlice } from './slices/toastSlice';
import { createSearchSlice, type SearchSlice } from './slices/searchSlice';
import { createProjectConfigSlice, type ProjectConfigSlice } from './slices/projectConfigSlice';
import { createSupervisionSlice, type SupervisionSlice } from './slices/supervisionSlice';
import { createResumeSlice, type ResumeSlice } from './slices/resumeSlice';
import { createAgentToolbarSlice, type AgentToolbarSlice } from './slices/agentToolbarSlice';
import { createRemoteInboxSlice, type RemoteInboxSlice } from './slices/remoteInboxSlice';
import { createChannelsSlice, type ChannelsSlice } from './slices/channelsSlice';
import { createWorkTaskSlice, type WorkTaskSlice } from './slices/workTaskSlice';
import { createDeckSlice, type DeckSlice } from './slices/deckSlice';

export type StoreState = WorkspaceSlice & PaneSlice & SurfaceSlice & UISlice & NotificationSlice & A2aSlice & ApprovalInboxSlice & CompanySlice & ToastSlice & SearchSlice & ProjectConfigSlice & SupervisionSlice & ResumeSlice & AgentToolbarSlice & RemoteInboxSlice & ChannelsSlice & WorkTaskSlice & DeckSlice;

export const useStore = create<StoreState>()(
  immer((...args) => ({
    ...createWorkspaceSlice(...args),
    ...createPaneSlice(...args),
    ...createSurfaceSlice(...args),
    ...createUISlice(...args),
    ...createNotificationSlice(...args),
    ...createA2aSlice(...args),
    ...createApprovalInboxSlice(...args),
    ...createCompanySlice(...args),
    ...createToastSlice(...args),
    ...createSearchSlice(...args),
    ...createProjectConfigSlice(...args),
    ...createSupervisionSlice(...args),
    ...createResumeSlice(...args),
    ...createAgentToolbarSlice(...args),
    ...createRemoteInboxSlice(...args),
    ...createChannelsSlice(...args),
    ...createWorkTaskSlice(...args),
    ...createDeckSlice(...args),
  }))
);
