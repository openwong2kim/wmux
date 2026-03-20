import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { createWorkspace, type Pane, type SessionData, type Workspace, type WorkspaceMetadata } from '../../../shared/types';
import { setLocale as i18nSetLocale, type Locale } from '../../i18n';

export interface WorkspaceSlice {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  addWorkspace: (name?: string) => void;
  removeWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  updateWorkspaceMetadata: (id: string, metadata: Partial<WorkspaceMetadata>) => void;
  reorderWorkspace: (fromIndex: number, toIndex: number) => void;
  loadSession: (data: SessionData) => void;
}

export const createWorkspaceSlice: StateCreator<StoreState, [['zustand/immer', never]], [], WorkspaceSlice> = (set) => {
  const initial = createWorkspace('Workspace 1');
  return {
    workspaces: [initial],
    activeWorkspaceId: initial.id,

    addWorkspace: (name) => set((state: StoreState) => {
      const ws = createWorkspace(name || `Workspace ${state.workspaces.length + 1}`);
      state.workspaces.push(ws);
      state.activeWorkspaceId = ws.id;
    }),

    // NOTE: PTY cleanup is the caller's responsibility (see Sidebar.handleClose, useKeyboard Ctrl+Shift+W)
    removeWorkspace: (id) => set((state: StoreState) => {
      if (state.workspaces.length <= 1) return;
      const idx = state.workspaces.findIndex((w: Workspace) => w.id === id);
      if (idx === -1) return;
      state.workspaces.splice(idx, 1);
      if (state.activeWorkspaceId === id) {
        state.activeWorkspaceId = state.workspaces[Math.min(idx, state.workspaces.length - 1)].id;
      }
    }),

    setActiveWorkspace: (id) => set((state: StoreState) => {
      if (state.workspaces.some((w: Workspace) => w.id === id)) {
        state.activeWorkspaceId = id;
      }
    }),

    renameWorkspace: (id, name) => set((state: StoreState) => {
      const ws = state.workspaces.find((w: Workspace) => w.id === id);
      if (ws) ws.name = name;
    }),

    updateWorkspaceMetadata: (id, metadata) => set((state: StoreState) => {
      const ws = state.workspaces.find((w: Workspace) => w.id === id);
      if (ws) {
        if (!ws.metadata) ws.metadata = {};
        Object.assign(ws.metadata, metadata);
      }
    }),

    reorderWorkspace: (fromIndex, toIndex) => set((state: StoreState) => {
      if (fromIndex === toIndex) return;
      if (fromIndex < 0 || fromIndex >= state.workspaces.length) return;
      if (toIndex < 0 || toIndex >= state.workspaces.length) return;
      const [removed] = state.workspaces.splice(fromIndex, 1);
      state.workspaces.splice(toIndex, 0, removed);
    }),

    loadSession: (data: SessionData) => set((state: StoreState) => {
      if (!data.workspaces || data.workspaces.length === 0) return;

      // Security: sanitize surfaces — clear ptyIds and block dangerous URLs
      const BLOCKED_URL_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'file:'];
      const sanitizePanes = (pane: Pane) => {
        if (pane.type === 'leaf') {
          for (const s of pane.surfaces) {
            if (s.surfaceType !== 'browser') {
              s.ptyId = '';
            }
            // Strip dangerous browserUrl schemes that could execute code on load
            if (s.browserUrl) {
              const normalized = s.browserUrl.trim().toLowerCase();
              if (BLOCKED_URL_SCHEMES.some((scheme) => normalized.startsWith(scheme))) {
                s.browserUrl = 'about:blank';
              }
            }
          }
        } else {
          for (const child of pane.children) sanitizePanes(child);
        }
      };
      for (const ws of data.workspaces) sanitizePanes(ws.rootPane);

      state.workspaces = data.workspaces;
      state.activeWorkspaceId = data.activeWorkspaceId;
      state.sidebarVisible = data.sidebarVisible;

      // Restore user preferences
      if (data.theme) {
        state.theme = data.theme;
        document.documentElement.setAttribute('data-theme', data.theme);
      }
      if (data.locale) {
        state.locale = data.locale as Locale;
        i18nSetLocale(data.locale as Locale);
      }
      if (data.terminalFontSize != null) state.terminalFontSize = data.terminalFontSize;
      if (data.terminalFontFamily) state.terminalFontFamily = data.terminalFontFamily;
      if (data.defaultShell) state.defaultShell = data.defaultShell;
      if (data.scrollbackLines != null) state.scrollbackLines = data.scrollbackLines;
      if (data.sidebarPosition) state.sidebarPosition = data.sidebarPosition;
      if (data.notificationSoundEnabled != null) state.notificationSoundEnabled = data.notificationSoundEnabled;
      if (data.toastEnabled != null) {
        state.toastEnabled = data.toastEnabled;
        window.electronAPI.settings.setToastEnabled(data.toastEnabled);
      }
      if (data.notificationRingEnabled != null) state.notificationRingEnabled = data.notificationRingEnabled;
      if (data.customKeybindings) state.customKeybindings = data.customKeybindings;
    }),
  };
};
