import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from './slices/workspaceSlice';
import { createPaneSlice, type PaneSlice } from './slices/paneSlice';
import { createSurfaceSlice, type SurfaceSlice } from './slices/surfaceSlice';
import { createUISlice, type UISlice } from './slices/uiSlice';
import { createNotificationSlice, type NotificationSlice } from './slices/notificationSlice';
import { createA2aSlice, type A2aSlice } from './slices/a2aSlice';
import { createApprovalInboxSlice, type ApprovalInboxSlice } from './slices/approvalInboxSlice';
import { createBrowserHelpSlice, type BrowserHelpSlice } from './slices/browserHelpSlice';
import { createToastSlice, type ToastSlice } from './slices/toastSlice';
import { createSearchSlice, type SearchSlice } from './slices/searchSlice';
import { createProjectConfigSlice, type ProjectConfigSlice } from './slices/projectConfigSlice';
import { createSupervisionSlice, type SupervisionSlice } from './slices/supervisionSlice';
import { createResumeSlice, type ResumeSlice } from './slices/resumeSlice';
import { createAgentToolbarSlice, type AgentToolbarSlice } from './slices/agentToolbarSlice';
import { createChromePresetSlice, type ChromePresetSlice } from './slices/chromePresetSlice';
import { createRemoteInboxSlice, type RemoteInboxSlice } from './slices/remoteInboxSlice';
import { createChannelsSlice, type ChannelsSlice } from './slices/channelsSlice';
import { createWorkTaskSlice, type WorkTaskSlice } from './slices/workTaskSlice';
import { createRemoteWorkspacesSlice, type RemoteWorkspacesSlice } from './slices/remoteWorkspacesSlice';
import { createOrphanSessionsSlice, type OrphanSessionsSlice } from './slices/orphanSessionsSlice';
import { createSchedulesSlice, type SchedulesSlice } from './slices/schedulesSlice';
import { createUsageLimitSlice, type UsageLimitSlice } from './slices/usageLimitSlice';
import { createAgentAuthSlice, type AgentAuthSlice } from './slices/agentAuthSlice';
import { createWorkspaceSettleSlice, type WorkspaceSettleSlice } from './slices/workspaceSettleSlice';
import { createA2aRemoteSlice, type A2aRemoteSlice } from './slices/a2aRemoteSlice';
import { createPcRailSlice, type PcRailSlice } from './slices/pcRailSlice';
import { createRoomSlice, type RoomSlice } from './slices/roomSlice';
import { createPtyLifecycleSlice, type PtyLifecycleSlice } from './slices/ptyLifecycleSlice';
import { createExternalSessionsSlice, type ExternalSessionsSlice } from './slices/externalSessionsSlice';
import { registerCloseTabConfirmInvariant } from './closeTabConfirm';

export type StoreState = WorkspaceSlice & PaneSlice & SurfaceSlice & UISlice & NotificationSlice & A2aSlice & ApprovalInboxSlice & BrowserHelpSlice & ToastSlice & SearchSlice & ProjectConfigSlice & SupervisionSlice & ResumeSlice & AgentToolbarSlice & ChromePresetSlice & RemoteInboxSlice & ChannelsSlice & WorkTaskSlice & RemoteWorkspacesSlice & OrphanSessionsSlice & SchedulesSlice & UsageLimitSlice & AgentAuthSlice & WorkspaceSettleSlice & A2aRemoteSlice & PcRailSlice & RoomSlice & PtyLifecycleSlice & ExternalSessionsSlice;

export const useStore = create<StoreState>()(
  immer((...args) => ({
    ...createWorkspaceSlice(...args),
    ...createPaneSlice(...args),
    ...createSurfaceSlice(...args),
    ...createUISlice(...args),
    ...createNotificationSlice(...args),
    ...createA2aSlice(...args),
    ...createApprovalInboxSlice(...args),
    ...createBrowserHelpSlice(...args),
    ...createToastSlice(...args),
    ...createSearchSlice(...args),
    ...createProjectConfigSlice(...args),
    ...createSupervisionSlice(...args),
    ...createResumeSlice(...args),
    ...createAgentToolbarSlice(...args),
    ...createChromePresetSlice(...args),
    ...createRemoteInboxSlice(...args),
    ...createChannelsSlice(...args),
    ...createWorkTaskSlice(...args),
    ...createRemoteWorkspacesSlice(...args),
    ...createOrphanSessionsSlice(...args),
    ...createSchedulesSlice(...args),
    ...createUsageLimitSlice(...args),
    ...createAgentAuthSlice(...args),
    ...createWorkspaceSettleSlice(...args),
    ...createA2aRemoteSlice(...args),
    ...createPcRailSlice(...args),
    ...createRoomSlice(...args),
    ...createPtyLifecycleSlice(...args),
    ...createExternalSessionsSlice(...args),
  }))
);

registerCloseTabConfirmInvariant(useStore);
