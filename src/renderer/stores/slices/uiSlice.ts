import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { setLocale as i18nSetLocale, type Locale } from '../../i18n';
import {
  generateId,
  createLeafPane,
  type CustomKeybinding,
  type CustomThemeColors,
  type XtermThemeColors,
  type Company,
  type LayoutTemplate,
  type LayoutNode,
  type Pane,
  type PaneBranch,
  type PrefixConfig,
  BUILTIN_TEMPLATES,
  DEFAULT_PREFIX_CONFIG,
} from '../../../shared/types';
import { applyCustomCssVars, clearCustomCssVars, DEFAULT_CUSTOM_THEME, migrateCustomThemeColors } from '../../themes';

// String-valued tokens only. xtermOverrides is an object handled by separate
// setXtermOverride / clearXtermOverrides actions below.
type CustomThemeColorKey = Exclude<keyof CustomThemeColors, 'xtermOverrides'>;
type XtermColorKey = keyof XtermThemeColors;

export interface UISlice {
  // ─── Startup gate (Fix 0) ─────────────────────────────────────────────
  // Lifecycle marker promoted from local AppLayout state so RPC handlers
  // (useRpcBridge, companyRpcHandlers) can cheaply guard against stale
  // ptyId writes during the startup reconcile window. Flips from
  // 'pending' to 'ready' exactly once per renderer lifetime, in
  // AppLayout's mount effect finally block.
  paneGate: 'pending' | 'ready';
  setPaneGate: (state: 'pending' | 'ready') => void;

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

  // Fix 0 — user-facing toggle for scrollback restore behavior.
  // true (default): startup reconciles + reconnects to daemon SessionPipes
  //   so prior session output is restored on every launch.
  // false: startup calls clearAllPtyState and every Terminal mounts fresh.
  //   The daemon still dumps ringBuffers on graceful Quit (no extra RPC to
  //   suppress it), but the renderer never reads them — orphan .buf files
  //   are reaped by cleanOrphanedBuffers on the next launch.
  scrollbackRestoreEnabled: boolean;
  setScrollbackRestoreEnabled: (enabled: boolean) => void;

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

  // ─── Notification surface toggles (T5) ───────────────────────────────────
  // Distinct knobs so users can quiet individual surfaces without disabling
  // the underlying notification feature. Mirrors the non-persisting shape of
  // notificationRingEnabled / notificationSoundEnabled rather than the
  // IPC-persisting toastEnabled — the SettingsPanel reset path lives in the
  // same family as the other notification toggles.
  //
  // paneRingEnabled: master gate for the pane border ring animation that
  //   triggers on notifications. When false, NotifyEvents that would normally
  //   light up a pane border are dropped at the renderer dispatch layer.
  // paneFlashEnabled: controls the flash sub-animation on top of the ring.
  //   When false, the ring stays in a static glow rather than pulsing.
  //   Independent of paneRingEnabled — both can be on/off in any combo.
  // taskbarFlashEnabled: gates the Electron window.flashFrame() call from
  //   the main process. The main-side hook (T6) reads this flag through the
  //   notification dispatch payload.
  // notificationSoundChoice: 'default' picks the bundled cue; 'none' suppresses
  //   sound regardless of notificationSoundEnabled. We keep both flags because
  //   the boolean is the "feature gate" while the choice is the "selected cue".
  //   Per DESIGN review, the toggle UI exposes the choice; advanced users keep
  //   the boolean as a master mute.
  paneRingEnabled: boolean;
  setPaneRingEnabled: (enabled: boolean) => void;

  paneFlashEnabled: boolean;
  setPaneFlashEnabled: (enabled: boolean) => void;

  taskbarFlashEnabled: boolean;
  setTaskbarFlashEnabled: (enabled: boolean) => void;

  notificationSoundChoice: 'default' | 'none';
  setNotificationSoundChoice: (choice: 'default' | 'none') => void;

  // ─── Claude Code hook integration (Phase 1.5) ────────────────────────────
  // Driven by main process: whenever a hook signal arrives via the
  // wmux-claude-integration plugin, main pushes the updated signal-health
  // snapshot to the renderer (throttled to 1Hz in registerHooksRpc).
  // Renderer-local state lets us display the health card in Settings
  // without a hot RPC round-trip per render.
  //
  // Tri-state derivation in Settings → ClaudeIntegrationSection:
  //   - count === 0 → "Unknown / not yet observed" (plugin not installed,
  //     or installed but no hook fired yet)
  //   - count > 0 && !isStale(24h) → "Detected" (live stats)
  //   - count > 0 && isStale(24h) → "Stale"
  // workspaceMatchRate is a separate dimension: even when the plugin is
  // working, hook fires from outside any wmux workspace bump `missed`
  // without affecting the tri-state.
  hookSignalHealth: {
    total: number;
    count: number;
    p50: number | null;
    p95: number | null;
    lastSignalAt: number | null;
    perAgent: Record<string, number>;
    workspaceMatchRate: { matched: number; missed: number };
  };
  setHookSignalHealth: (health: {
    total: number;
    count: number;
    p50: number | null;
    p95: number | null;
    lastSignalAt: number | null;
    perAgent: Record<string, number>;
    workspaceMatchRate: { matched: number; missed: number };
  }) => void;

  /** User has dismissed the first-run "install wmux-claude-integration"
   *  banner. Persists across sessions via the same persisted-uiSlice
   *  fields pattern (see toastEnabled). */
  hookOnboardingDismissed: boolean;
  setHookOnboardingDismissed: (dismissed: boolean) => void;

  // ─── Phase 2 — Anthropic usage meter ────────────────────────────────────
  // Opt-in. When `anthropicUsageEnabled` flips to true, the renderer sends
  // IPC.USAGE_TOGGLE and main starts the UsagePoller. The poller pushes
  // PollerState snapshots via IPC.USAGE_UPDATE and they land here in
  // `anthropicUsage`. The access token itself is NEVER part of this state —
  // it stays in main process memory during a fetch and is discarded.
  anthropicUsageEnabled: boolean;
  setAnthropicUsageEnabled: (enabled: boolean) => void;
  anthropicUsage: {
    status:
      | 'idle'
      | 'ok'
      | 'token-missing'
      | 'unauthorized'
      | 'http-error'
      | 'network-error'
      | 'read-error';
    snapshot: {
      sessionPct: number;
      sessionResetEpochSec: number;
      weeklyPct: number;
      weeklyResetEpochSec: number;
      fetchedAtMs: number;
    } | null;
    lastError: string | null;
    subscriptionType: string | null;
  };
  setAnthropicUsage: (state: {
    status:
      | 'idle'
      | 'ok'
      | 'token-missing'
      | 'unauthorized'
      | 'http-error'
      | 'network-error'
      | 'read-error';
    snapshot: {
      sessionPct: number;
      sessionResetEpochSec: number;
      weeklyPct: number;
      weeklyResetEpochSec: number;
      fetchedAtMs: number;
    } | null;
    lastError: string | null;
    subscriptionType: string | null;
  }) => void;

  // ─── Multiview ─────────────────────────────────────────────────────────
  multiviewIds: string[];
  toggleMultiviewWorkspace: (wsId: string) => void;
  // Close-button primitive. Pure removal, never adds. Use this from the tile
  // X button so a stale-event toggle cannot re-add the workspace.
  removeMultiviewWorkspace: (wsId: string) => void;
  clearMultiview: () => void;

  // ─── Sidebar drag-reorder state ────────────────────────────────────────
  // Holds the source index of an in-flight sidebar reorder drag. We can't
  // encode this in dataTransfer because chat composers (Claude Desktop)
  // interpret extra vendor MIMEs or short payloads as attachment hints and
  // silently reject the actual markdown text drop. Keeping reorder state
  // out-of-band lets dataTransfer carry pure text/plain markdown.
  draggedWorkspaceIndex: number | null;
  setDraggedWorkspaceIndex: (index: number | null) => void;

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
  updateCustomThemeColor: (key: CustomThemeColorKey, value: string) => void;
  // Per-slot xterm color override on top of the chosen preset. Pass null to
  // clear a single slot (it falls back to the preset). Pass clearXtermOverrides
  // to wipe all overrides at once (e.g. "Reset to preset" button).
  setXtermOverride: (key: XtermColorKey, value: string | null) => void;
  clearXtermOverrides: () => void;

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
  /**
   * One-shot override that re-shows the cheat sheet even when the user has
   * permanently dismissed it. Set by the `?` prefix action; cleared when the
   * overlay is closed. Not persisted in SessionData — purely runtime UI state.
   */
  cheatSheetForceShown: boolean;
  setFirstRunCompleted: (value: boolean) => void;
  setCheatSheetDismissed: (value: boolean) => void;
  setCheatSheetForceShown: (value: boolean) => void;

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
  // ─── Startup gate (Fix 0) ─────────────────────────────────────────────
  paneGate: 'pending',

  setPaneGate: (gate) => set((state) => {
    state.paneGate = gate;
  }),

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

  scrollbackRestoreEnabled: true,

  setScrollbackRestoreEnabled: (enabled) => set((state) => {
    state.scrollbackRestoreEnabled = enabled;
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

  // ─── Notification surface toggles (T5) ───────────────────────────────────
  paneRingEnabled: true,

  setPaneRingEnabled: (enabled) => set((state) => {
    state.paneRingEnabled = enabled;
  }),

  paneFlashEnabled: true,

  setPaneFlashEnabled: (enabled) => set((state) => {
    state.paneFlashEnabled = enabled;
  }),

  taskbarFlashEnabled: true,

  setTaskbarFlashEnabled: (enabled) => set((state) => {
    state.taskbarFlashEnabled = enabled;
  }),

  notificationSoundChoice: 'default',

  setNotificationSoundChoice: (choice) => set((state) => {
    state.notificationSoundChoice = choice;
  }),

  // ─── Claude Code hook integration (Phase 1.5) ────────────────────────────
  hookSignalHealth: {
    total: 0,
    count: 0,
    p50: null,
    p95: null,
    lastSignalAt: null,
    perAgent: {},
    workspaceMatchRate: { matched: 0, missed: 0 },
  },

  setHookSignalHealth: (health) => set((state) => {
    state.hookSignalHealth = health;
  }),

  hookOnboardingDismissed: false,

  setHookOnboardingDismissed: (dismissed) => set((state) => {
    state.hookOnboardingDismissed = dismissed;
  }),

  // ─── Phase 2 — Anthropic usage meter ────────────────────────────────────
  anthropicUsageEnabled: false,
  setAnthropicUsageEnabled: (enabled) => {
    // Sync to main so the poller starts/stops. The IPC send is fire-and-
    // forget; main acknowledges via the next USAGE_UPDATE push.
    window.electronAPI.usage.setEnabled(enabled);
    set((state) => {
      state.anthropicUsageEnabled = enabled;
    });
  },
  anthropicUsage: {
    status: 'idle',
    snapshot: null,
    lastError: null,
    subscriptionType: null,
  },
  setAnthropicUsage: (next) => set((state) => {
    state.anthropicUsage = next;
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

  removeMultiviewWorkspace: (wsId) => set((state) => {
    const idx = state.multiviewIds.indexOf(wsId);
    if (idx < 0) return; // no-op on non-members
    state.multiviewIds.splice(idx, 1);
    // Same auto-clear rule as toggleMultiviewWorkspace: ≤1 left → collapse.
    if (state.multiviewIds.length <= 1) {
      state.multiviewIds = [];
    }
  }),

  clearMultiview: () => set((state) => {
    state.multiviewIds = [];
  }),

  draggedWorkspaceIndex: null as number | null,
  setDraggedWorkspaceIndex: (index) => set((state) => {
    state.draggedWorkspaceIndex = index;
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
    // Normalize through migrator so legacy callers (e.g. external code passing
    // a 37-field object) still work; idempotent on new shape.
    const normalized = migrateCustomThemeColors(colors);
    set((state) => { state.customThemeColors = normalized; });
    if (get().theme === 'custom') {
      applyCustomCssVars(normalized);
    }
  },

  updateCustomThemeColor: (key, value) => {
    set((state) => {
      if (!state.customThemeColors) {
        state.customThemeColors = { ...DEFAULT_CUSTOM_THEME };
      }
      (state.customThemeColors as unknown as Record<string, string>)[key] = value;
    });
    if (get().theme === 'custom') {
      const colors = get().customThemeColors;
      if (colors) applyCustomCssVars(colors);
    }
  },

  setXtermOverride: (key, value) => {
    set((state) => {
      if (!state.customThemeColors) {
        state.customThemeColors = { ...DEFAULT_CUSTOM_THEME };
      }
      const overrides = { ...(state.customThemeColors.xtermOverrides ?? {}) };
      if (value === null || value === '') {
        delete overrides[key];
      } else {
        overrides[key] = value;
      }
      // Drop the field entirely when empty so persisted state stays clean.
      state.customThemeColors.xtermOverrides = Object.keys(overrides).length > 0 ? overrides : undefined;
    });
    // Note: xterm theme changes are picked up by useTerminal's effect — no
    // CSS-var application needed here.
  },

  clearXtermOverrides: () => {
    set((state) => {
      if (state.customThemeColors) {
        state.customThemeColors.xtermOverrides = undefined;
      }
    });
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
  cheatSheetForceShown: false,

  setFirstRunCompleted: (value) => set((state) => {
    state.firstRunCompleted = value;
  }),

  setCheatSheetDismissed: (value) => set((state) => {
    state.cheatSheetDismissed = value;
  }),

  setCheatSheetForceShown: (value) => set((state) => {
    state.cheatSheetForceShown = value;
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
