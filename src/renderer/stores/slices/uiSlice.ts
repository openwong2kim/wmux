import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { setLocale as i18nSetLocale, type Locale } from '../../i18n';
import { generateId, type CustomKeybinding } from '../../../shared/types';

export interface UISlice {
  sidebarVisible: boolean;
  toggleSidebar: () => void;
  setSidebarVisible: (visible: boolean) => void;

  notificationPanelVisible: boolean;
  toggleNotificationPanel: () => void;
  setNotificationPanelVisible: (visible: boolean) => void;

  commandPaletteVisible: boolean;
  toggleCommandPalette: () => void;
  setCommandPaletteVisible: (visible: boolean) => void;

  settingsPanelVisible: boolean;
  toggleSettingsPanel: () => void;
  setSettingsPanelVisible: (visible: boolean) => void;

  notificationSoundEnabled: boolean;
  toggleNotificationSound: () => void;
  setNotificationSoundEnabled: (enabled: boolean) => void;

  locale: Locale;
  setLocale: (locale: Locale) => void;

  viCopyModeActive: boolean;
  setViCopyModeActive: (active: boolean) => void;

  searchBarVisible: boolean;
  toggleSearchBar: () => void;
  setSearchBarVisible: (visible: boolean) => void;

  // ─── Terminal settings ───────────────────────────────────────────────────
  terminalFontSize: number;
  setTerminalFontSize: (size: number) => void;

  terminalFontFamily: string;
  setTerminalFontFamily: (family: string) => void;

  defaultShell: string;
  setDefaultShell: (shell: string) => void;

  scrollbackLines: number;
  setScrollbackLines: (lines: number) => void;

  // ─── Theme ──────────────────────────────────────────────────────────────
  theme: string;
  setTheme: (theme: string) => void;

  // ─── Layout ────────────────────────────────────────────────────────────
  sidebarPosition: 'left' | 'right';
  setSidebarPosition: (position: 'left' | 'right') => void;

  // ─── Toast / ring notification UI ────────────────────────────────────────
  toastEnabled: boolean;
  setToastEnabled: (enabled: boolean) => void;

  notificationRingEnabled: boolean;
  setNotificationRingEnabled: (enabled: boolean) => void;

  // ─── Multiview ─────────────────────────────────────────────────────────
  multiviewIds: string[];
  toggleMultiviewWorkspace: (wsId: string) => void;
  clearMultiview: () => void;

  // ─── Custom keybindings ──────────────────────────────────────────────
  customKeybindings: CustomKeybinding[];
  addKeybinding: (kb: Omit<CustomKeybinding, 'id'>) => void;
  updateKeybinding: (id: string, kb: Partial<Omit<CustomKeybinding, 'id'>>) => void;
  removeKeybinding: (id: string) => void;

  // ─── File tree ────────────────────────────────────────────────────────
  fileTreeVisible: boolean;
  toggleFileTree: () => void;
  setFileTreeVisible: (visible: boolean) => void;

}

export const createUISlice: StateCreator<StoreState, [['zustand/immer', never]], [], UISlice> = (set) => ({
  // ─── Sidebar ─────────────────────────────────────────────────────────────
  sidebarVisible: true,

  toggleSidebar: () => set((state) => {
    state.sidebarVisible = !state.sidebarVisible;
  }),

  setSidebarVisible: (visible) => set((state) => {
    state.sidebarVisible = visible;
  }),

  // ─── Notification panel ──────────────────────────────────────────────────
  notificationPanelVisible: false,

  toggleNotificationPanel: () => set((state) => {
    state.notificationPanelVisible = !state.notificationPanelVisible;
    if (state.notificationPanelVisible) {
      state.commandPaletteVisible = false;
      state.settingsPanelVisible = false;
    }
  }),

  setNotificationPanelVisible: (visible) => set((state) => {
    state.notificationPanelVisible = visible;
  }),

  // ─── Command palette ─────────────────────────────────────────────────────
  commandPaletteVisible: false,

  toggleCommandPalette: () => set((state) => {
    state.commandPaletteVisible = !state.commandPaletteVisible;
    if (state.commandPaletteVisible) {
      state.notificationPanelVisible = false;
      state.settingsPanelVisible = false;
    }
  }),

  setCommandPaletteVisible: (visible) => set((state) => {
    state.commandPaletteVisible = visible;
  }),

  // ─── Settings panel ──────────────────────────────────────────────────────
  settingsPanelVisible: false,

  toggleSettingsPanel: () => set((state) => {
    state.settingsPanelVisible = !state.settingsPanelVisible;
    if (state.settingsPanelVisible) {
      state.commandPaletteVisible = false;
      state.notificationPanelVisible = false;
    }
  }),

  setSettingsPanelVisible: (visible) => set((state) => {
    state.settingsPanelVisible = visible;
  }),

  // ─── Notification sound ──────────────────────────────────────────────────
  notificationSoundEnabled: true,

  toggleNotificationSound: () => set((state) => {
    state.notificationSoundEnabled = !state.notificationSoundEnabled;
  }),

  setNotificationSoundEnabled: (enabled) => set((state) => {
    state.notificationSoundEnabled = enabled;
  }),

  // ─── Locale / i18n ───────────────────────────────────────────────────────
  locale: 'en',

  setLocale: (locale) => {
    // Sync i18n module state immediately (outside immer — pure function call)
    i18nSetLocale(locale);
    set((state) => {
      state.locale = locale;
    });
  },

  // ─── VI copy mode ─────────────────────────────────────────────────────────
  viCopyModeActive: false,

  setViCopyModeActive: (active) => set((state) => {
    state.viCopyModeActive = active;
  }),

  // ─── Search bar ───────────────────────────────────────────────────────────
  searchBarVisible: false,

  toggleSearchBar: () => set((state) => {
    state.searchBarVisible = !state.searchBarVisible;
  }),

  setSearchBarVisible: (visible) => set((state) => {
    state.searchBarVisible = visible;
  }),

  // ─── Terminal settings ───────────────────────────────────────────────────
  terminalFontSize: 14,

  setTerminalFontSize: (size) => set((state) => {
    state.terminalFontSize = size;
  }),

  terminalFontFamily: 'Cascadia Code',

  setTerminalFontFamily: (family) => set((state) => {
    state.terminalFontFamily = family;
  }),

  defaultShell: 'powershell',

  setDefaultShell: (shell) => set((state) => {
    state.defaultShell = shell;
  }),

  scrollbackLines: 10000,

  setScrollbackLines: (lines) => set((state) => {
    state.scrollbackLines = lines;
  }),

  // ─── Theme ──────────────────────────────────────────────────────────────
  theme: 'catppuccin',

  setTheme: (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    set((state) => {
      state.theme = theme;
    });
  },

  // ─── Layout ────────────────────────────────────────────────────────────
  sidebarPosition: 'left',

  setSidebarPosition: (position) => set((state) => {
    state.sidebarPosition = position;
  }),

  // ─── Toast / ring notification UI ────────────────────────────────────────
  toastEnabled: true,

  setToastEnabled: (enabled) => {
    window.electronAPI.settings.setToastEnabled(enabled);
    set((state) => {
      state.toastEnabled = enabled;
    });
  },

  notificationRingEnabled: true,

  setNotificationRingEnabled: (enabled) => set((state) => {
    state.notificationRingEnabled = enabled;
  }),

  // ─── Multiview ─────────────────────────────────────────────────────────
  multiviewIds: [] as string[],

  toggleMultiviewWorkspace: (wsId) => set((state) => {
    const idx = state.multiviewIds.indexOf(wsId);
    if (idx >= 0) {
      state.multiviewIds.splice(idx, 1);
    } else {
      // Add active workspace too if first selection
      if (state.multiviewIds.length === 0) {
        state.multiviewIds.push(state.activeWorkspaceId);
      }
      if (!state.multiviewIds.includes(wsId)) {
        state.multiviewIds.push(wsId);
      }
    }
    // If only 1 or 0 left, clear multiview
    if (state.multiviewIds.length <= 1) {
      state.multiviewIds = [];
    }
  }),

  clearMultiview: () => set((state) => {
    state.multiviewIds = [];
  }),

  // ─── Custom keybindings ──────────────────────────────────────────────
  customKeybindings: [],

  addKeybinding: (kb) => set((state) => {
    state.customKeybindings.push({
      id: generateId('kb'),
      ...kb,
    });
  }),

  updateKeybinding: (id, updates) => set((state) => {
    const idx = state.customKeybindings.findIndex((k) => k.id === id);
    if (idx !== -1) Object.assign(state.customKeybindings[idx], updates);
  }),

  removeKeybinding: (id) => set((state) => {
    state.customKeybindings = state.customKeybindings.filter((k) => k.id !== id);
  }),

  // ─── File tree ────────────────────────────────────────────────────────
  fileTreeVisible: false,

  toggleFileTree: () => set((state) => {
    state.fileTreeVisible = !state.fileTreeVisible;
  }),

  setFileTreeVisible: (visible) => set((state) => {
    state.fileTreeVisible = visible;
  }),

});
