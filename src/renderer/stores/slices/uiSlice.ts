import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { setLocale as i18nSetLocale, type Locale } from '../../i18n';
import {
  generateId,
  createLeafPane,
  type CustomKeybinding,
  type CustomThemeColors,
  type Company,
  type LayoutTemplate,
  type LayoutNode,
  type Pane,
  type PaneBranch,
  type PrefixConfig,
  BUILTIN_TEMPLATES,
  DEFAULT_PREFIX_CONFIG,
} from '../../../shared/types';
import { applyCustomCssVars, clearCustomCssVars, DEFAULT_CUSTOM_THEME } from '../../themes';

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

  // ─── Company mode ──────────────────────────────────────────────────────
  sidebarMode: 'workspaces' | 'company';
  setSidebarMode: (mode: 'workspaces' | 'company') => void;

  company: Company | null;
  setCompany: (company: Company | null) => void;

  memberCosts: Record<string, number>;
  setMemberCosts: (costs: Record<string, number>) => void;

  sessionStartTime: number | null;
  setSessionStartTime: (time: number | null) => void;

  companyViewVisible: boolean;
  toggleCompanyView: () => void;
  setCompanyViewVisible: (visible: boolean) => void;

  messageFeedVisible: boolean;
  toggleMessageFeed: () => void;
  setMessageFeedVisible: (visible: boolean) => void;

  // ─── Custom theme ─────────────────────────────────────────────────────
  customThemeColors: CustomThemeColors | null;
  setCustomThemeColors: (colors: CustomThemeColors) => void;
  updateCustomThemeColor: (key: string, value: string) => void;

  // ─── Auto-update ──────────────────────────────────────────────────────
  autoUpdateEnabled: boolean;
  setAutoUpdateEnabled: (enabled: boolean) => void;

  // ─── Onboarding ─────────────────────────────────────────────────────
  onboardingActive: boolean;
  onboardingCompleted: boolean;
  startOnboarding: () => void;
  completeOnboarding: () => void;
  skipOnboarding: () => void;

  // ─── First-run wizard / cheat sheet (Plan 1.15 + 1.18) ────────────────
  firstRunCompleted: boolean;
  cheatSheetDismissed: boolean;
  setFirstRunCompleted: (value: boolean) => void;
  setCheatSheetDismissed: (value: boolean) => void;

  // ─── Prefix mode (tmux-style) ─────────────────────────────────────
  prefixMode: boolean;
  prefixError: string | null;
  setPrefixMode: (active: boolean) => void;
  setPrefixError: (msg: string | null) => void;
  prefixConfig: PrefixConfig;
  setPrefixKey: (keyCode: string) => void;
  setPrefixBinding: (key: string, actionId: string) => void;
  removePrefixBinding: (key: string) => void;
  resetPrefixConfig: () => void;

  // ─── Pane zoom ────────────────────────────────────────────────────
  zoomedPaneId: string | null;
  togglePaneZoom: (paneId: string) => void;

  // ─── Scrollback bookmarks ─────────────────────────────────────────
  terminalBookmarks: Record<string, number[]>;
  addBookmark: (ptyId: string, line: number) => void;
  removeBookmark: (ptyId: string, line: number) => void;
  clearBookmarks: (ptyId: string) => void;

  // ─── Floating pane ────────────────────────────────────────────────
  floatingPaneVisible: boolean;
  floatingPanePtyId: string | null;
  toggleFloatingPane: () => void;
  setFloatingPanePtyId: (ptyId: string) => void;

  // ─── Layout templates ─────────────────────────────────────────────
  layoutTemplates: LayoutTemplate[];
  saveLayoutTemplate: (name: string) => void;
  deleteLayoutTemplate: (id: string) => void;
  applyLayoutTemplate: (templateId: string, workspaceId?: string) => void;

  // ─── Recent terminal commands ─────────────────────────────────────
  recentCommands: string[];
  addRecentCommand: (cmd: string) => void;
  clearRecentCommands: () => void;

}

// ─── Layout template helpers ───────────────────────────────────────────────

function extractLayout(pane: Pane): LayoutNode {
  if (pane.type === 'leaf') return { type: 'leaf' };
  return {
    type: 'branch',
    direction: pane.direction,
    sizes: pane.sizes ?? pane.children.map(() => 100 / pane.children.length),
    children: pane.children.map(extractLayout),
  };
}

function buildPaneFromLayout(node: LayoutNode): Pane {
  if (node.type === 'leaf') return createLeafPane();
  const branch: PaneBranch = {
    id: generateId('pane'),
    type: 'branch',
    direction: node.direction,
    sizes: node.sizes,
    children: node.children.map(buildPaneFromLayout),
  };
  return branch;
}

function collectFirstLeafId(pane: Pane): string {
  if (pane.type === 'leaf') return pane.id;
  return collectFirstLeafId(pane.children[0]);
}

export const createUISlice: StateCreator<StoreState, [['zustand/immer', never]], [], UISlice> = (set, get) => ({
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
  theme: 'catppuccin-mocha',

  setTheme: (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    if (theme === 'custom') {
      const colors = get().customThemeColors ?? DEFAULT_CUSTOM_THEME;
      applyCustomCssVars(colors);
    } else {
      clearCustomCssVars();
    }
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
      // Seed with active when starting fresh, OR when a previously saved group
      // is still around but the user has navigated away from it (active is not
      // a member). The second case appears as "Ctrl-click does nothing" because
      // AppLayout gates the grid on active ∈ multiviewIds — without reseeding,
      // the new id gets appended to the stale group and the grid stays hidden.
      if (state.multiviewIds.length === 0 || !state.multiviewIds.includes(state.activeWorkspaceId)) {
        state.multiviewIds = [state.activeWorkspaceId];
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
  customKeybindings: [
    {
      id: 'kb-default-f7',
      key: 'F7',
      label: 'Claude (skip permissions)',
      command: 'claude --dangerously-skip-permissions',
      sendEnter: true,
    },
  ],

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

  // ─── Company mode ──────────────────────────────────────────────────────
  sidebarMode: 'workspaces',
  setSidebarMode: (mode) => set((state) => { state.sidebarMode = mode; }),

  company: null,
  setCompany: (company) => set((state) => { state.company = company; }),

  memberCosts: {},
  setMemberCosts: (costs) => set((state) => { state.memberCosts = costs; }),

  sessionStartTime: null,
  setSessionStartTime: (time) => set((state) => { state.sessionStartTime = time; }),

  companyViewVisible: false,
  toggleCompanyView: () => set((state) => { state.companyViewVisible = !state.companyViewVisible; }),
  setCompanyViewVisible: (visible) => set((state) => { state.companyViewVisible = visible; }),

  messageFeedVisible: false,
  toggleMessageFeed: () => set((state) => { state.messageFeedVisible = !state.messageFeedVisible; }),
  setMessageFeedVisible: (visible) => set((state) => { state.messageFeedVisible = visible; }),

  // ─── Custom theme ─────────────────────────────────────────────────────
  customThemeColors: null,

  setCustomThemeColors: (colors) => {
    set((state) => { state.customThemeColors = colors; });
    if (get().theme === 'custom') {
      applyCustomCssVars(colors);
    }
  },

  updateCustomThemeColor: (key, value) => {
    set((state) => {
      if (!state.customThemeColors) {
        state.customThemeColors = { ...DEFAULT_CUSTOM_THEME };
      }
      (state.customThemeColors as Record<string, string>)[key] = value;
    });
    if (get().theme === 'custom') {
      const colors = get().customThemeColors;
      if (colors) applyCustomCssVars(colors);
    }
  },

  // ─── Auto-update ──────────────────────────────────────────────────────
  autoUpdateEnabled: true,

  setAutoUpdateEnabled: (enabled) => set((state) => {
    state.autoUpdateEnabled = enabled;
  }),

  // ─── Onboarding ─────────────────────────────────────────────────────
  onboardingActive: false,
  onboardingCompleted: false,

  startOnboarding: () => set((state) => {
    state.onboardingActive = true;
  }),

  completeOnboarding: () => set((state) => {
    state.onboardingActive = false;
    state.onboardingCompleted = true;
  }),

  skipOnboarding: () => set((state) => {
    state.onboardingActive = false;
    state.onboardingCompleted = true;
  }),

  // ─── First-run wizard / cheat sheet (Plan 1.15 + 1.18) ────────────────
  // Mirrors onboardingCompleted: simple boolean flags persisted via SessionData.
  // workspaceSlice.loadSession reads these back; AppLayout.buildSessionData
  // (T8a) writes them out alongside other UI prefs.
  firstRunCompleted: false,
  cheatSheetDismissed: false,

  setFirstRunCompleted: (value) => set((state) => {
    state.firstRunCompleted = value;
  }),

  setCheatSheetDismissed: (value) => set((state) => {
    state.cheatSheetDismissed = value;
  }),

  // ─── Prefix mode (tmux-style) ─────────────────────────────────────
  prefixMode: false,
  prefixError: null,

  setPrefixMode: (active) => set((state) => {
    state.prefixMode = active;
    if (!active) state.prefixError = null;
  }),

  setPrefixError: (msg) => set((state) => {
    state.prefixError = msg;
  }),

  prefixConfig: { ...DEFAULT_PREFIX_CONFIG },

  setPrefixKey: (keyCode) => set((state) => {
    state.prefixConfig.key = keyCode;
  }),

  setPrefixBinding: (key, actionId) => set((state) => {
    state.prefixConfig.bindings[key] = actionId;
  }),

  removePrefixBinding: (key) => set((state) => {
    delete state.prefixConfig.bindings[key];
  }),

  resetPrefixConfig: () => set((state) => {
    state.prefixConfig = { ...DEFAULT_PREFIX_CONFIG, bindings: { ...DEFAULT_PREFIX_CONFIG.bindings } };
  }),

  // ─── Pane zoom ────────────────────────────────────────────────────
  zoomedPaneId: null,

  togglePaneZoom: (paneId) => set((state) => {
    state.zoomedPaneId = state.zoomedPaneId === paneId ? null : paneId;
  }),

  // ─── Scrollback bookmarks ─────────────────────────────────────────
  terminalBookmarks: {},

  addBookmark: (ptyId, line) => set((state) => {
    if (!state.terminalBookmarks[ptyId]) {
      state.terminalBookmarks[ptyId] = [];
    }
    const lines = state.terminalBookmarks[ptyId];
    if (!lines.includes(line)) {
      lines.push(line);
      lines.sort((a, b) => a - b);
    }
  }),

  removeBookmark: (ptyId, line) => set((state) => {
    if (!state.terminalBookmarks[ptyId]) return;
    state.terminalBookmarks[ptyId] = state.terminalBookmarks[ptyId].filter((l) => l !== line);
  }),

  clearBookmarks: (ptyId) => set((state) => {
    delete state.terminalBookmarks[ptyId];
  }),

  // ─── Floating pane ────────────────────────────────────────────────
  floatingPaneVisible: false,
  floatingPanePtyId: null,

  toggleFloatingPane: () => set((state) => {
    state.floatingPaneVisible = !state.floatingPaneVisible;
  }),

  setFloatingPanePtyId: (ptyId) => set((state) => {
    state.floatingPanePtyId = ptyId;
  }),

  // ─── Layout templates ─────────────────────────────────────────────
  layoutTemplates: [...BUILTIN_TEMPLATES],

  saveLayoutTemplate: (name) => set((state) => {
    const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const tree = extractLayout(ws.rootPane);
    const template: LayoutTemplate = {
      id: generateId('tmpl'),
      name: name.trim(),
      tree,
    };
    state.layoutTemplates.push(template);
  }),

  deleteLayoutTemplate: (id) => set((state) => {
    const tmpl = state.layoutTemplates.find((t) => t.id === id);
    if (!tmpl || tmpl.builtin) return;
    state.layoutTemplates = state.layoutTemplates.filter((t) => t.id !== id);
  }),

  applyLayoutTemplate: (templateId, workspaceId) => set((state) => {
    const targetWsId = workspaceId || state.activeWorkspaceId;
    const ws = state.workspaces.find((w) => w.id === targetWsId);
    if (!ws) return;
    const tmpl = state.layoutTemplates.find((t) => t.id === templateId);
    if (!tmpl) return;
    const newRoot = buildPaneFromLayout(tmpl.tree);
    ws.rootPane = newRoot;
    ws.activePaneId = collectFirstLeafId(newRoot);
    state.zoomedPaneId = null;
  }),

  // ─── Recent terminal commands ─────────────────────────────────────
  recentCommands: [],

  addRecentCommand: (cmd) => set((state) => {
    const idx = state.recentCommands.indexOf(cmd);
    if (idx >= 0) state.recentCommands.splice(idx, 1);
    state.recentCommands.push(cmd);
    if (state.recentCommands.length > 100) state.recentCommands.shift();
  }),

  clearRecentCommands: () => set((state) => {
    state.recentCommands = [];
  }),

});
