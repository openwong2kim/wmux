import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { createWorkspace, generateId, BUILTIN_TEMPLATES, type Pane, type PaneLeaf, type SessionData, type Workspace, type WorkspaceMetadata } from '../../../shared/types';
import { getPresetById } from '../../../shared/layoutPresets';
import { setLocale as i18nSetLocale, type Locale } from '../../i18n';
import { applyCustomCssVars, migrateThemeId } from '../../themes';
import { publishWorkspaceMetadataChanged } from '../../events/publisher';

/** Collect all leaf panes from a pane tree */
function collectLeafPanes(pane: Pane): PaneLeaf[] {
  if (pane.type === 'leaf') return [pane];
  return pane.children.flatMap(collectLeafPanes);
}

export interface WorkspaceSlice {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  addWorkspace: (name?: string) => void;
  addWorkspaceWithPreset: (presetId: string, name?: string) => void;
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
      let wsName = name;
      if (!wsName) {
        const usedNumbers = new Set(
          state.workspaces
            .map((w: Workspace) => {
              const m = w.name.match(/^Workspace (\d+)$/);
              return m ? parseInt(m[1], 10) : null;
            })
            .filter((n): n is number => n !== null),
        );
        let n = 1;
        while (usedNumbers.has(n)) n++;
        wsName = `Workspace ${n}`;
      }
      const ws = createWorkspace(wsName);
      state.workspaces.push(ws);
      state.activeWorkspaceId = ws.id;
    }),

    addWorkspaceWithPreset: (presetId, name) => set((state: StoreState) => {
      const preset = getPresetById(presetId);
      if (!preset) return;

      let wsName = name;
      if (!wsName) {
        const usedNumbers = new Set(
          state.workspaces
            .map((w: Workspace) => {
              const m = w.name.match(/^Workspace (\d+)$/);
              return m ? parseInt(m[1], 10) : null;
            })
            .filter((n): n is number => n !== null),
        );
        let n = 1;
        while (usedNumbers.has(n)) n++;
        wsName = `Workspace ${n}`;
      }

      const rootPane = preset.createRootPane();
      const leaves = collectLeafPanes(rootPane);
      const ws: Workspace = {
        id: generateId('ws'),
        name: wsName,
        rootPane,
        activePaneId: leaves[0]?.id || rootPane.id,
      };
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
      if (!state.workspaces.some((w: Workspace) => w.id === id)) return;
      state.activeWorkspaceId = id;
      // multiviewIds is intentionally preserved here. AppLayout renders the
      // grid only when activeWorkspaceId is part of multiviewIds, so switching
      // to a non-multiview workspace shows its single view while the saved
      // group survives — clicking any member restores the grid. Explicit
      // disband still works via the ✕ button or Ctrl+Shift+G (clearMultiview).
    }),

    renameWorkspace: (id, name) => set((state: StoreState) => {
      const ws = state.workspaces.find((w: Workspace) => w.id === id);
      if (ws) ws.name = name;
    }),

    updateWorkspaceMetadata: (id, metadata) => {
      let publishPayload: { wsId: string; full: WorkspaceMetadata; patch: Partial<WorkspaceMetadata> } | null = null;
      set((state: StoreState) => {
        const ws = state.workspaces.find((w: Workspace) => w.id === id);
        if (!ws) return;
        if (!ws.metadata) ws.metadata = {};
        Object.assign(ws.metadata, metadata);
        publishPayload = { wsId: ws.id, full: { ...ws.metadata }, patch: metadata };
      });
      if (publishPayload) {
        const p = publishPayload as { wsId: string; full: WorkspaceMetadata; patch: Partial<WorkspaceMetadata> };
        publishWorkspaceMetadataChanged(p.wsId, p.full, p.patch);
      }
    },

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
              // Keep ptyId intact — AppLayout will reconcile against active PTYs
              // and clear only those that are actually dead.
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
      if (data.customThemeColors) {
        state.customThemeColors = data.customThemeColors;
      }
      if (data.theme) {
        const theme = migrateThemeId(data.theme);
        state.theme = theme;
        document.documentElement.setAttribute('data-theme', theme);
        if (theme === 'custom' && data.customThemeColors) {
          applyCustomCssVars(data.customThemeColors);
        }
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
      if (data.autoUpdateEnabled != null) {
        state.autoUpdateEnabled = data.autoUpdateEnabled;
        window.electronAPI.settings.setAutoUpdateEnabled(data.autoUpdateEnabled);
      }
      if (data.sidebarMode) state.sidebarMode = data.sidebarMode;
      if (data.company !== undefined) state.company = data.company ?? null;
      if (data.memberCosts) state.memberCosts = data.memberCosts;
      if (data.sessionStartTime != null) state.sessionStartTime = data.sessionStartTime;
      if (data.tokenDataByPty) state.tokenDataByPty = data.tokenDataByPty;
      if (data.onboardingCompleted != null) state.onboardingCompleted = data.onboardingCompleted;
      // First-run wizard + cheat sheet (Plan 1.15 + 1.18). Mirrors onboardingCompleted
      // pattern: only overwrite when the saved field is present, otherwise leave the
      // uiSlice default (false). AppLayout.buildSessionData (T8a) writes the outbound
      // payload.
      if (data.firstRunCompleted != null) state.firstRunCompleted = data.firstRunCompleted;
      if (data.cheatSheetDismissed != null) state.cheatSheetDismissed = data.cheatSheetDismissed;
      if (data.floatingPanePtyId !== undefined) state.floatingPanePtyId = data.floatingPanePtyId ?? null;
      if (data.layoutTemplates) {
        // Restore user-saved templates merged with current builtins
        state.layoutTemplates = [
          ...BUILTIN_TEMPLATES,
          ...data.layoutTemplates.filter((t) => !t.builtin),
        ];
      }
      if (data.recentCommands) state.recentCommands = data.recentCommands;
      if (data.prefixConfig) state.prefixConfig = data.prefixConfig;
    }),
  };
};
