import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { setLocale as i18nSetLocale, type Locale } from '../../i18n';
import { markRetentionMigrationDone } from '../retentionMigration';
import type { FleetSortMode } from '../selectors/fleet';
import {
  generateId,
  createLeafPane,
  assignPaneOrdinals,
  type CustomKeybinding,
  type CustomThemeColors,
  type XtermThemeColors,
  type Company,
  type LayoutTemplate,
  type LayoutNode,
  type Pane,
  type PaneBranch,
  type PrefixConfig,
  type NotificationCategory,
  BUILTIN_TEMPLATES,
  DEFAULT_PREFIX_CONFIG,
  buildDefaultCustomKeybindings,
} from '../../../shared/types';
import {
  applyCustomCssVars,
  clearCustomCssVars,
  DEFAULT_CUSTOM_THEME,
  migrateCustomThemeColors,
  builtinToCustom,
  UI_THEME_TOKENS,
  type BuiltinThemeId,
  type UIThemeTokenKey,
  type TokenRole,
} from '../../themes';
import { sanitizeFontFamily } from '../../utils/terminalFont';

// String-valued tokens only. xtermOverrides is an object handled by separate
// setXtermOverride / clearXtermOverrides actions below.
type CustomThemeColorKey = Exclude<keyof CustomThemeColors, 'xtermOverrides'>;
type XtermColorKey = keyof XtermThemeColors;

// S-C2 — Fleet View cockpit tab. 'fleet' = the S-C1 agent grid; 'approvals' =
// the S-C2 unified approval inbox; 'remote' = LanLink PR-5 read-only remote-peer
// inbox (off-machine messages, rendered as text — never PTY-pasted).
export type FleetTab = 'fleet' | 'approvals' | 'remote';

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

  // Right-side channel dock (opposite the workspace sidebar). Default off so
  // users without channels pay no screen width; auto-opens on first channel
  // select/create (setActiveChannel) and is collapsible. Persisted.
  channelDockVisible: boolean;
  toggleChannelDock: () => void;
  setChannelDockVisible: (visible: boolean) => void;

  notificationPanelVisible: boolean;
  toggleNotificationPanel: () => void;
  setNotificationPanelVisible: (visible: boolean) => void;

  commandPaletteVisible: boolean;
  toggleCommandPalette: () => void;
  setCommandPaletteVisible: (visible: boolean) => void;

  // S-C1 Fleet View — full-screen cockpit overlay (Ctrl+Shift+A). Transient
  // UI state; never persisted (buildSessionData allowlist excludes it, like the
  // command palette / settings panel flags).
  fleetViewVisible: boolean;
  toggleFleetView: () => void;
  setFleetViewVisible: (visible: boolean) => void;

  // J3 §1 — 태스크 정리 목록(팔레트 진입). 전용 루트 디스크 정본 스캔 결과를
  // 4종(미물질화·디스크 결측·보존·무연결)으로 보여준다. 전이 UI 상태(미영속).
  worktaskCleanupVisible: boolean;
  setWorktaskCleanupVisible: (visible: boolean) => void;

  // S-C2 — which tab the Fleet View cockpit shows: the agent grid ('fleet',
  // S-C1) or the unified approval inbox ('approvals', S-C2). Lifted to uiSlice
  // (rather than FleetView-local) so the A2A / MCP approval modals can suppress
  // themselves while the inbox tab is open (one surface per item). Transient UI
  // state exactly like fleetViewVisible — never persisted (buildSessionData
  // allowlist excludes it; defaults fresh to 'fleet' on every load). FleetView
  // resets this to 'fleet' on unmount (mount-gated = close).
  fleetActiveTab: FleetTab;
  setFleetActiveTab: (tab: FleetTab) => void;

  // S-C1 follow-up — situational sort for the cockpit grid. Unlike the tab this
  // is NOT reset on unmount, so it persists across cockpit open/close within a
  // session. Not yet in buildSessionData's allowlist → resets to 'attention' on
  // app restart (cross-session persistence is a deliberate follow-up).
  fleetSortMode: FleetSortMode;
  setFleetSortMode: (mode: FleetSortMode) => void;

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

  // Orchestrator (deck brain) model override. '' = the subscription's default
  // model; otherwise a claude model alias/id ('opus' | 'sonnet' | 'haiku' | full
  // id) passed to the Agent SDK. Applied between turns — see deck.handler.
  deckBrainModel: string;
  setDeckBrainModel: (model: string) => void;

  // Orchestrator full-power mode (BYOB approach A): load the user's Claude
  // Code ecosystem (skills, CLAUDE.md, hooks) into brain turns. Default OFF —
  // raw mode is the documented safe default (hook storms, personal hooks in
  // brain turns); this is a deliberate opt-in. Applied between turns like the
  // model override — see deck.handler.
  deckBrainFullPower: boolean;
  setDeckBrainFullPower: (enabled: boolean) => void;

  // Orchestrator brain vendor (BYOB M0): which runtime the Command Deck brain
  // runs on. 'claude' (default) = Claude Agent SDK; 'hermes' = the generic
  // ACP adapter. Main-authoritative like fullPower — AppLayout syncs it.
  deckBrainVendor: 'claude' | 'hermes';
  setDeckBrainVendor: (vendor: 'claude' | 'hermes') => void;

  // Whether the deck shows the Channels tab (the human channel UI). Default
  // OFF: the orchestrator is the single interface and channels are its
  // internal wiring (PRD §4.1 — human channel UI frozen); the tab stays
  // available behind this setting as the read-only inspection surface.
  channelsTabVisible: boolean;
  setChannelsTabVisible: (visible: boolean) => void;

  // Whether each pane's tab strip shows the right-aligned action cluster
  // (new terminal / split right / split down / new browser). Default ON —
  // discoverable mouse affordances for the same actions the keyboard already
  // has; hideable for minimal-chrome, keyboard-only setups.
  paneActionsVisible: boolean;
  setPaneActionsVisible: (visible: boolean) => void;

  // Issue #174: split panes inherit the splitting pane's cwd (default on).
  splitInheritsCwd: boolean;
  setSplitInheritsCwd: (enabled: boolean) => void;

  // Idle-clearing of xterm's hidden IME textarea (issue #167, AutoGLM-style
  // voice injectors). Default OFF since v3.1.1: the programmatic wipe is the
  // prime suspect for field-reported IME claim storms that kill keyboard
  // input until the terminal remounts. Applies to newly created terminals.
  imeResidueGuardEnabled: boolean;
  setImeResidueGuardEnabled: (enabled: boolean) => void;

  // Phase 3 (hidden-pane retention, default OFF while dogfooding): hidden
  // panes' PTY output is queued but never parsed; overflowed panes are
  // re-synchronized from the daemon RingBuffer on reveal. Daemon-backed
  // sessions only — the flag is ignored in local PTY mode.
  hiddenPaneRetentionEnabled: boolean;
  setHiddenPaneRetentionEnabled: (enabled: boolean) => void;

  // #517 browser lightweight mode (default OFF while dogfooding): CPU-throttle
  // embedded browser guests that are effectively invisible (hidden workspace /
  // zoom-hidden / minimized window) and not under automation. CPU-only — does
  // NOT reduce memory. AppLayout mirrors this flag to main on every change.
  browserLightweightMode: boolean;
  setBrowserLightweightMode: (enabled: boolean) => void;

  // #517 slice C (default OFF): additionally DISCARD a guest that stays
  // invisible for several minutes — the <webview> unmounts, its renderer
  // process dies and memory is reclaimed; the page reloads on return.
  // Only effective while browserLightweightMode is also on.
  browserDiscardHidden: boolean;
  setBrowserDiscardHidden: (enabled: boolean) => void;

  // Issue #175: global default starting directory for new terminals.
  // '' = unset → os.homedir() fallback in the spawn layer.
  startupDirectory: string;
  setStartupDirectory: (dir: string) => void;

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

  // ─── Color inspect mode (PR2 foundation) ─────────────────────────────────
  // Top-level exclusive "point-and-style" mode. The InspectOverlay (separate
  // task) renders while inspectModeActive is true; this slice only owns the
  // state machine + invariants.
  //
  //   inspectModeActive — overlay mounted, hover/click reverse-maps to tokens.
  //   inspectMinimized  — Settings shrinks to a floating bar but stays mounted
  //                       (D-settings); ESC leaves inspect → full Settings.
  //   inspectTargetToken — the token/role a click selected, consumed by the
  //                       editor to scroll/flash the matching TokenRow.
  //
  // Invariants enforced by the actions below:
  //   inspectModeActive ⇒ settingsPanelVisible ∧ inspectMinimized            (D-settings)
  //   inspectModeActive ⇒ ¬commandPaletteVisible ∧ ¬notificationPanelVisible (D-exclusive)
  // Entering any competing modal, or switching workspaces, tears inspect down
  // first so an interrupt cannot leave the state machine half-open.
  inspectModeActive: boolean;
  inspectMinimized: boolean;
  inspectTargetToken: { token: UIThemeTokenKey; role: TokenRole } | null;
  // Set when a click lands on the terminal *area* (D-terminal v1): a single
  // background/foreground slot rather than a UI token. The SettingsPanel (a
  // separate task) reads this to scroll/open the xterm background/foreground
  // editor. Null when no terminal slot is the current inspect target. Reset to
  // null on exit alongside the other inspect fields.
  inspectXtermTarget: 'background' | 'foreground' | null;
  enterInspect: () => void;
  exitInspect: () => void;
  setInspectTarget: (token: UIThemeTokenKey, role: TokenRole) => void;
  setInspectXtermTarget: (target: 'background' | 'foreground' | null) => void;
  // Clear BOTH pending targets (UI token + xterm slot) without leaving inspect.
  // Integration contract: after a click commits a target the overlay yields its
  // capture and the full Settings modal re-expands to edit it; when the user
  // closes that editor we must clear the target so the overlay resumes hover
  // inspection (it stays paused while a target is pending). setInspectTarget can
  // only set a non-null token, so this is the only path back to "no target,
  // still inspecting" — without it a single click strands inspect forever.
  clearInspectTarget: () => void;

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

  // ─── Per-category notification mute (#516) ───────────────────────────────
  // The surface toggles above are all-or-nothing across event kinds: quieting
  // subagent chatter meant killing the "awaiting approval" signal too. This
  // list mutes by KIND instead of by surface. Muted categories still land in
  // the notification panel (same data-preservation contract as a muted
  // workspace) — only toast/sound/ring/flash are suppressed.
  // Persisted through SessionData.mutedNotificationCategories.
  mutedNotificationCategories: NotificationCategory[];
  setNotificationCategoryMuted: (category: NotificationCategory, muted: boolean) => void;

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
  /**
   * Move active-workspace focus to the spatially adjacent multiview tile.
   * No-op unless the multiview grid is actually showing (≥2 members AND the
   * active workspace is one of them — matches AppLayout's render gate). Column
   * count mirrors AppLayout's grid (≤4 tiles → 2 cols, else 3) so arrow nav
   * matches what the user sees on screen.
   */
  focusMultiviewDirection: (direction: 'up' | 'down' | 'left' | 'right') => void;

  // ─── Sidebar drag-reorder state ────────────────────────────────────────
  // Holds the source index of an in-flight sidebar reorder drag. We can't
  // encode this in dataTransfer because chat composers (Claude Desktop)
  // interpret extra vendor MIMEs or short payloads as attachment hints and
  // silently reject the actual markdown text drop. Keeping reorder state
  // out-of-band lets dataTransfer carry pure text/plain markdown.
  draggedWorkspaceIndex: number | null;
  setDraggedWorkspaceIndex: (index: number | null) => void;

  // ─── Terminal text-drop trust boundary ────────────────────────────────
  // Browser/Electron DataTransfer text is attacker-controlled across app and
  // web boundaries. Terminal.tsx only accepts text/plain drops while this
  // in-memory flag is set by a wmux-owned drag source (sidebar, surface tabs,
  // or file tree), preserving internal drag-paste without accepting external
  // page/application payloads.
  terminalTextDropDragActive: boolean;
  setTerminalTextDropDragActive: (active: boolean) => void;

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

  // ─── Plugin pane decorations (B-1 ui.pane-decoration) ─────────────
  // paneId → plugin → decoration. Written by the ui.decoratePane RPC push
  // (usePaneDecorationChannel); badge=null payloads delete the entry.
  // Not persisted: plugins re-assert decorations on reconnect.
  pluginPaneDecorations: Record<string, Record<string, { badge: string; tooltip?: string; color?: string }>>;
  setPluginPaneDecoration: (
    plugin: string,
    paneId: string,
    decoration: { badge: string; tooltip?: string; color?: string } | null,
  ) => void;

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

// ─── Inspect-mode teardown helper ────────────────────────────────────────────
// Shared so exitInspect, the exclusive-mode guards, and the workspaceSlice
// switch teardown (D-teardown) all reset the same three fields identically.
// Mutates an immer draft in place — call only inside a set() callback. The
// param is structurally typed (not the full StoreState) so workspaceSlice can
// import and apply it against its own draft without a circular slice import.
export interface InspectStateFields {
  inspectModeActive: boolean;
  inspectMinimized: boolean;
  inspectTargetToken: { token: UIThemeTokenKey; role: TokenRole } | null;
  inspectXtermTarget: 'background' | 'foreground' | null;
}

export function resetInspectState(state: InspectStateFields): void {
  state.inspectModeActive = false;
  state.inspectMinimized = false;
  state.inspectTargetToken = null;
  state.inspectXtermTarget = null;
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

  channelDockVisible: false,

  toggleChannelDock: () => set((state) => {
    state.channelDockVisible = !state.channelDockVisible;
  }),

  setChannelDockVisible: (visible) => set((state) => {
    state.channelDockVisible = visible;
  }),

  // ─── Notification panel ──────────────────────────────────────────────────
  notificationPanelVisible: false,

  toggleNotificationPanel: () => set((state) => {
    state.notificationPanelVisible = !state.notificationPanelVisible;
    if (state.notificationPanelVisible) {
      state.commandPaletteVisible = false;
      state.settingsPanelVisible = false;
      state.fleetViewVisible = false;
      // D-exclusive: opening a competing surface tears inspect down so the
      // top-level state machine can't coexist with another modal.
      if (state.inspectModeActive) resetInspectState(state);
    }
  }),

  setNotificationPanelVisible: (visible) => set((state) => {
    state.notificationPanelVisible = visible;
    if (visible && state.inspectModeActive) resetInspectState(state);
  }),

  // ─── J3 태스크 정리 목록 ──────────────────────────────────────────────────
  worktaskCleanupVisible: false,
  setWorktaskCleanupVisible: (visible) => set((state) => {
    state.worktaskCleanupVisible = visible;
  }),

  // ─── Command palette ─────────────────────────────────────────────────────
  commandPaletteVisible: false,

  toggleCommandPalette: () => set((state) => {
    state.commandPaletteVisible = !state.commandPaletteVisible;
    if (state.commandPaletteVisible) {
      state.notificationPanelVisible = false;
      state.settingsPanelVisible = false;
      state.fleetViewVisible = false;
      // D-exclusive: opening the palette tears inspect down (no coexistence).
      if (state.inspectModeActive) resetInspectState(state);
    }
  }),

  setCommandPaletteVisible: (visible) => set((state) => {
    state.commandPaletteVisible = visible;
    if (visible && state.inspectModeActive) resetInspectState(state);
  }),

  // ─── Fleet View (S-C1 cockpit) ───────────────────────────────────────────
  fleetViewVisible: false,

  toggleFleetView: () => set((state) => {
    state.fleetViewVisible = !state.fleetViewVisible;
    if (state.fleetViewVisible) {
      // Mutually exclusive with the other top-level overlays (same teardown the
      // command palette / settings paths use), and inspect can't coexist.
      state.commandPaletteVisible = false;
      state.notificationPanelVisible = false;
      state.settingsPanelVisible = false;
      if (state.inspectModeActive) resetInspectState(state);
    }
  }),

  setFleetViewVisible: (visible) => set((state) => {
    state.fleetViewVisible = visible;
    if (visible) {
      state.commandPaletteVisible = false;
      state.notificationPanelVisible = false;
      state.settingsPanelVisible = false;
      if (state.inspectModeActive) resetInspectState(state);
    }
  }),

  // S-C2 — cockpit tab. Defaults to the agent grid; FleetView resets it on
  // unmount so reopening the cockpit always lands on 'fleet'.
  fleetActiveTab: 'fleet',

  setFleetActiveTab: (tab) => set((state) => {
    state.fleetActiveTab = tab;
  }),

  fleetSortMode: 'attention',

  setFleetSortMode: (mode) => set((state) => {
    state.fleetSortMode = mode;
  }),

  // ─── Settings panel ──────────────────────────────────────────────────────
  settingsPanelVisible: false,

  toggleSettingsPanel: () => set((state) => {
    state.settingsPanelVisible = !state.settingsPanelVisible;
    if (state.settingsPanelVisible) {
      state.commandPaletteVisible = false;
      state.notificationPanelVisible = false;
      state.fleetViewVisible = false;
    } else if (state.inspectModeActive) {
      // D-exclusive invariant: inspect can only exist while Settings is open
      // (inspectModeActive ⇒ settingsPanelVisible). Toggling Settings shut
      // (true→false) while inspecting would strand a "Settings-less inspect"
      // overlay, so tear inspect down in lock-step — same reset the
      // command-palette / notification teardown paths use.
      resetInspectState(state);
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

  // Sanitize at the trust boundary so the stored value can never carry
  // CSS-injection characters into the xterm fontFamily string. An empty result
  // (name was blank/all-unsafe) falls back to the default so the terminal keeps
  // a valid monospace font. See utils/terminalFont.ts for the threat model.
  setTerminalFontFamily: (family) => set((state) => {
    const safe = sanitizeFontFamily(family);
    state.terminalFontFamily = safe || 'Cascadia Code';
  }),

  defaultShell: 'powershell',

  setDefaultShell: (shell) => set((state) => {
    state.defaultShell = shell;
  }),

  deckBrainModel: '',

  setDeckBrainModel: (model) => set((state) => {
    state.deckBrainModel = model;
  }),

  deckBrainFullPower: false,

  setDeckBrainFullPower: (enabled) => set((state) => {
    state.deckBrainFullPower = enabled;
  }),

  deckBrainVendor: 'claude',

  setDeckBrainVendor: (vendor) => set((state) => {
    state.deckBrainVendor = vendor;
  }),

  channelsTabVisible: false,

  setChannelsTabVisible: (visible) => set((state) => {
    state.channelsTabVisible = visible;
    // Hiding the tab while it is the active one must not leave the deck on an
    // unreachable surface — snap back to the orchestrator.
    if (!visible && state.activeDeckTab === 'channels') {
      state.activeDeckTab = 'commander';
    }
  }),


  paneActionsVisible: true,

  setPaneActionsVisible: (visible) => set((state) => {
    state.paneActionsVisible = visible;
  }),

  splitInheritsCwd: true,

  setSplitInheritsCwd: (enabled) => set((state) => {
    state.splitInheritsCwd = enabled;
  }),

  imeResidueGuardEnabled: false,

  setImeResidueGuardEnabled: (enabled) => set((state) => {
    state.imeResidueGuardEnabled = enabled;
  }),

  // Default ON since the app-weight P0 (2026-07-16): hidden panes queue PTY
  // output without parsing and re-sync from the daemon on reveal. The Settings
  // toggle remains the escape hatch; see retentionMigration.ts for how
  // pre-flip profiles (which persisted the old `false` default) are migrated
  // exactly once.
  hiddenPaneRetentionEnabled: true,

  setHiddenPaneRetentionEnabled: (enabled) => set((state) => {
    state.hiddenPaneRetentionEnabled = enabled;
    // Explicit user intent — stamp the migration ledger so this choice is
    // never overridden by the one-shot default-flip migration (covers the
    // fresh-install case where loadSession never ran a migration).
    markRetentionMigrationDone();
  }),

  // #517 — ship OFF, flip after Windows dogfood proves the automation-lease
  // path holds (a default-ON lease gap would be a silent blank-screenshot
  // regression, #353).
  browserLightweightMode: false,

  setBrowserLightweightMode: (enabled) => set((state) => {
    state.browserLightweightMode = enabled;
  }),

  browserDiscardHidden: false,

  setBrowserDiscardHidden: (enabled) => set((state) => {
    state.browserDiscardHidden = enabled;
  }),

  startupDirectory: '',

  setStartupDirectory: (dir) => set((state) => {
    state.startupDirectory = dir.trim();
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
  // Default = the amber design system (owner redesign decision 2026-07-11);
  // persisted choices in session.json are untouched.
  theme: 'amber',

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

  // ─── Color inspect mode (PR2 foundation) ─────────────────────────────────
  inspectModeActive: false,
  inspectMinimized: false,
  inspectTargetToken: null,
  inspectXtermTarget: null,

  enterInspect: () => {
    // D-builtin: live color edits are a silent no-op unless theme==='custom'
    // (applyCustomCssVars gates on it). When entering from a built-in theme we
    // seed a custom palette from the current built-in and switch to it FIRST,
    // before flipping the mode on, so the very first click already paints.
    // setCustomThemeColors + setTheme are run outside the immer draft because
    // they perform DOM side-effects (applyCustomCssVars / data-theme attr).
    const currentTheme = get().theme;
    if (currentTheme !== 'custom') {
      const seedId: BuiltinThemeId = currentTheme in UI_THEME_TOKENS
        ? (currentTheme as BuiltinThemeId)
        : 'catppuccin-mocha';
      get().setCustomThemeColors(builtinToCustom(seedId));
      get().setTheme('custom');
    }
    set((state) => {
      state.inspectModeActive = true;
      state.inspectMinimized = true;   // Settings shrinks to a floating bar.
      state.settingsPanelVisible = true; // ...but stays mounted (D-settings).
      // D-exclusive: inspect is the top-level mode — close competing surfaces.
      state.commandPaletteVisible = false;
      state.notificationPanelVisible = false;
    });
  },

  exitInspect: () => set((state) => {
    // Leave inspect only — settingsPanelVisible stays true so ESC/done returns
    // the user to the full Settings panel rather than closing it (D-settings).
    resetInspectState(state);
  }),

  setInspectTarget: (token, role) => set((state) => {
    state.inspectTargetToken = { token, role };
    // A UI-token target and a terminal-slot target are mutually exclusive —
    // picking a token clears any pending xterm slot so the editor opens exactly
    // one section.
    state.inspectXtermTarget = null;
  }),

  setInspectXtermTarget: (target) => set((state) => {
    state.inspectXtermTarget = target;
    // Symmetric to setInspectTarget: choosing a terminal slot clears the UI
    // token target so only the xterm background/foreground editor opens.
    if (target !== null) state.inspectTargetToken = null;
  }),

  clearInspectTarget: () => set((state) => {
    // Drop both pending targets but stay in inspect — the overlay resumes hover
    // (overlayShouldCapture goes back to true) so the user can keep picking.
    // Deliberately does NOT touch inspectModeActive / inspectMinimized /
    // settingsPanelVisible; only exitInspect tears the mode down.
    state.inspectTargetToken = null;
    state.inspectXtermTarget = null;
  }),

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

  // ─── Per-category notification mute (#516) ───────────────────────────────
  // Defaults to nothing muted: every category is loud until the user says
  // otherwise, so an upgrade never silently drops a signal they had before.
  mutedNotificationCategories: [],

  setNotificationCategoryMuted: (category, muted) => {
    const current = get().mutedNotificationCategories;
    const has = current.includes(category);
    if (muted === has) return;
    const next = muted ? [...current, category] : current.filter((c) => c !== category);
    // Mirror to main so the no-renderer toast fallback honors the mute too
    // (dispatchNotification → isCategoryMuted). Same pattern as toastEnabled.
    window.electronAPI.settings.setMutedNotificationCategories(next);
    set((state) => {
      state.mutedNotificationCategories = next;
    });
  },

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

  focusMultiviewDirection: (direction) => {
    const state = get();
    const ids = state.multiviewIds;
    // Only meaningful when the grid is actually rendered (matches AppLayout's
    // gate: ≥2 members AND the active workspace is one of them).
    if (ids.length < 2) return;
    const idx = ids.indexOf(state.activeWorkspaceId);
    if (idx < 0) return;
    // Column count mirrors AppLayout.tsx grid (≤4 tiles → 2 cols, else 3).
    const cols = ids.length <= 4 ? 2 : 3;
    const col = idx % cols;
    let target = -1;
    switch (direction) {
      case 'left': if (col > 0) target = idx - 1; break;
      case 'right': if (col < cols - 1 && idx + 1 < ids.length) target = idx + 1; break;
      case 'up': if (idx - cols >= 0) target = idx - cols; break;
      case 'down': if (idx + cols < ids.length) target = idx + cols; break;
    }
    if (target >= 0 && target < ids.length) {
      // Route through setActiveWorkspace so notification auto-read and any
      // other activation side-effects fire — never mutate activeWorkspaceId
      // directly here.
      state.setActiveWorkspace(ids[target]);
    }
  },

  draggedWorkspaceIndex: null as number | null,
  setDraggedWorkspaceIndex: (index) => set((state) => {
    state.draggedWorkspaceIndex = index;
  }),

  terminalTextDropDragActive: false,
  setTerminalTextDropDragActive: (active) => set((state) => {
    state.terminalTextDropDragActive = active;
  }),

  // ─── Custom keybindings ──────────────────────────────────────────────
  // Seed from the shared factory (single source of truth shared with the
  // workspaceSlice load-merge). Pass the current platform so macOS gets the
  // Ctrl+7 default — F7-based combos are swallowed by macOS (media keys /
  // the ^F7 system shortcut). The `typeof
  // window` guard keeps the store constructable in the node test env where
  // `window` is undefined (platform → undefined → F7 fallback); a bare `window`
  // reference would throw ReferenceError. Deep-copy each entry so the factory
  // output can never be mutated through store state.
  customKeybindings: buildDefaultCustomKeybindings(
    typeof window !== 'undefined' ? window.electronAPI?.platform : undefined,
  ).map((kb) => ({ ...kb })),

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

  // Deep-copy bindings so the module-level DEFAULT_PREFIX_CONFIG.bindings map
  // is never shared by reference with store state (matches resetPrefixConfig).
  prefixConfig: { ...DEFAULT_PREFIX_CONFIG, bindings: { ...DEFAULT_PREFIX_CONFIG.bindings } },

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

  // ─── Plugin pane decorations (B-1 ui.pane-decoration) ─────────────
  pluginPaneDecorations: {},

  setPluginPaneDecoration: (plugin, paneId, decoration) => set((state) => {
    if (decoration === null) {
      const forPane = state.pluginPaneDecorations[paneId];
      if (!forPane) return;
      delete forPane[plugin];
      if (Object.keys(forPane).length === 0) {
        delete state.pluginPaneDecorations[paneId];
      }
      return;
    }
    // Defense-in-depth cap (main already validates paneId against the live
    // pane tree, but a renderer-side bound means a bug there can't grow this
    // store without limit): at most MAX_DECORATED_PANES_PER_PLUGIN distinct
    // panes decorated by one plugin. New panes past the cap are dropped;
    // updates to already-decorated panes always apply.
    const MAX_DECORATED_PANES_PER_PLUGIN = 64;
    if (!state.pluginPaneDecorations[paneId]?.[plugin]) {
      let count = 0;
      for (const byPlugin of Object.values(state.pluginPaneDecorations)) {
        if (byPlugin[plugin]) count++;
      }
      if (count >= MAX_DECORATED_PANES_PER_PLUGIN) return;
    }
    if (!state.pluginPaneDecorations[paneId]) {
      state.pluginPaneDecorations[paneId] = {};
    }
    state.pluginPaneDecorations[paneId][plugin] = decoration;
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
    // P2: a template REPLACES the whole tree → number the new leaves fresh
    // 1..n (the old panes are gone) and restart the per-ws counter.
    ws.nextPaneOrdinal = assignPaneOrdinals(newRoot, 1);
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
