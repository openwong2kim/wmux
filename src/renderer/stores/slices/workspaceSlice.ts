import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { createWorkspace, clonePaneTreeFresh, generateId, BUILTIN_TEMPLATES, DEFAULT_PREFIX_CONFIG, DEFAULT_CUSTOM_KEYBINDINGS, type Pane, type PaneLeaf, type SessionData, type Workspace, type WorkspaceMetadata, type WorkspaceProfile } from '../../../shared/types';
import { normalizeWorkspaceProfile } from '../../../shared/workspaceProfile';
import { getPresetById } from '../../../shared/layoutPresets';
import { setLocale as i18nSetLocale, type Locale } from '../../i18n';
import { applyCustomCssVars, migrateThemeId, migrateCustomThemeColors } from '../../themes';
import { resetInspectState } from './uiSlice';
import { sanitizeFontFamily } from '../../utils/terminalFont';
import { publishWorkspaceMetadataChanged } from '../../events/publisher';

/** Collect all leaf panes from a pane tree */
function collectLeafPanes(pane: Pane): PaneLeaf[] {
  if (pane.type === 'leaf') return [pane];
  return pane.children.flatMap(collectLeafPanes);
}

/**
 * Build a non-colliding "<base> (copy)" / "<base> (copy N)" name for a
 * duplicate. An existing copy-suffix on the source is stripped first so
 * duplicating a copy yields "Foo (copy 2)" rather than "Foo (copy) (copy)".
 * Locale-neutral by design — mirrors the hardcoded "Workspace N" scheme used
 * by addWorkspace.
 */
function nextCopyName(base: string, existing: string[]): string {
  const taken = new Set(existing);
  const root = base.replace(/ \(copy(?: \d+)?\)$/, '') || base;
  const first = `${root} (copy)`;
  if (!taken.has(first)) return first;
  let n = 2;
  while (taken.has(`${root} (copy ${n})`)) n++;
  return `${root} (copy ${n})`;
}

export interface WorkspaceSlice {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  addWorkspace: (name?: string) => void;
  addWorkspaceWithPreset: (presetId: string, name?: string) => void;
  /**
   * Duplicate an existing workspace's LAYOUT (pane tree, with fresh ids and
   * cleared ptyIds → new panes spawn their own PTYs) and its PROFILE (env +
   * startup command, re-normalized through the save-boundary secret policy).
   * The clone is named "<name> (copy [N])", inserted right after the source, and
   * activated. Company role/department membership is intentionally NOT copied.
   * No-op if the id is unknown.
   */
  duplicateWorkspace: (id: string) => void;
  removeWorkspace: (id: string) => void;
  setActiveWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  updateWorkspaceMetadata: (id: string, metadata: Partial<WorkspaceMetadata>) => void;
  /**
   * Set (or clear) a workspace's process profile. Deliberately does NOT publish
   * a metadata-change event — profile values may be secret-adjacent and must
   * not travel the metadata event/RPC bus. Pass undefined (or an empty profile)
   * to clear. Applies to NEW panes only; existing PTYs are untouched.
   */
  setWorkspaceProfile: (id: string, profile: WorkspaceProfile | undefined) => void;
  reorderWorkspace: (fromIndex: number, toIndex: number) => void;
  loadSession: (data: SessionData) => void;
  /**
   * Fix 0 fallback action. Clears every ptyId-keyed piece of renderer state
   * in one atomic immer set: terminal surface ptyId across all workspaces +
   * nested split panes, floatingPanePtyId, terminalBookmarks,
   * and company member.ptyId. Called from AppLayout startup catch when
   * reconcile aborts/times out, so Terminal.tsx self-create receives a
   * consistent blank slate and external RPC handlers don't have stale
   * pty-keyed maps lying around.
   */
  clearAllPtyState: () => void;
  /**
   * Fix 0 round 3 follow-up — surgical clear for a single dead ptyId.
   * useTerminal calls this when `pty.reconnect` returns { success: false }
   * (session died between AppLayout's liveness check and Terminal mount).
   * Clearing the surface ptyId triggers re-mount with externalPtyId='',
   * which falls into Terminal.tsx's self-create path. Without this, the
   * Terminal sits with a stale ptyId forever and reproduces input-mute.
   */
  clearSurfacePtyIdByPty: (ptyId: string) => void;
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

    duplicateWorkspace: (id) => set((state: StoreState) => {
      const idx = state.workspaces.findIndex((w: Workspace) => w.id === id);
      if (idx === -1) return;
      const src = state.workspaces[idx];

      const rootPane = clonePaneTreeFresh(src.rootPane);

      // Preserve the active pane by structural position: clonePaneTreeFresh
      // walks panes in the same order, so the source's active-pane index maps
      // onto the clone's leaves directly.
      const srcLeaves = collectLeafPanes(src.rootPane);
      const newLeaves = collectLeafPanes(rootPane);
      const activeIdx = srcLeaves.findIndex((p) => p.id === src.activePaneId);
      const activePaneId = newLeaves[activeIdx >= 0 ? activeIdx : 0]?.id ?? rootPane.id;

      // Re-normalize the cloned profile through the editor/save policy
      // (dropSecretKeys) so a copy never silently re-persists a secret-named
      // env value the source happened to retain from a pre-policy load.
      const profile = src.profile
        ? normalizeWorkspaceProfile({ ...src.profile, env: src.profile.env ? { ...src.profile.env } : undefined }, { dropSecretKeys: true })
        : undefined;

      const ws: Workspace = {
        id: generateId('ws'),
        name: nextCopyName(src.name, state.workspaces.map((w: Workspace) => w.name)),
        rootPane,
        activePaneId,
        ...(profile ? { profile } : {}),
      };
      // Insert right after the source for intuitive placement, then activate.
      state.workspaces.splice(idx + 1, 0, ws);
      state.activeWorkspaceId = ws.id;
    }),

    // NOTE: PTY cleanup is the caller's responsibility (see Sidebar.handleClose, useKeyboard Ctrl+Shift+W)
    removeWorkspace: (id) => set((state: StoreState) => {
      if (state.workspaces.length <= 1) return;
      const idx = state.workspaces.findIndex((w: Workspace) => w.id === id);
      if (idx === -1) return;
      // Drop ring state for every leaf pane in the removed workspace. closePane
      // covers the user-driven path; this mirrors the same invariant for
      // workspace-level deletion (Sidebar X, Ctrl+Shift+W, SettingsPanel reset)
      // so stale paneIds can't render a phantom ring after their tree is gone.
      if (state.paneNotificationRing) {
        const removedWs = state.workspaces[idx];
        const collectLeafIdsFromPane = (p: Pane): string[] =>
          p.type === 'leaf' ? [p.id] : p.children.flatMap(collectLeafIdsFromPane);
        for (const pid of collectLeafIdsFromPane(removedWs.rootPane)) {
          delete state.paneNotificationRing[pid];
        }
      }
      state.workspaces.splice(idx, 1);
      if (state.activeWorkspaceId === id) {
        state.activeWorkspaceId = state.workspaces[Math.min(idx, state.workspaces.length - 1)].id;
      }
      // D-teardown: removing a workspace (sidebar X, Ctrl+Shift+W, kill-pane)
      // unmounts the marked-region DOM the inspect overlay queries. setActiveWorkspace
      // already tears inspect down on a switch; mirror that here so killing/closing
      // the workspace while inspecting can't leave a stale overlay dangling.
      if (state.inspectModeActive) resetInspectState(state);
    }),

    setActiveWorkspace: (id) => set((state: StoreState) => {
      if (!state.workspaces.some((w: Workspace) => w.id === id)) return;
      state.activeWorkspaceId = id;
      // D-teardown: a workspace switch invalidates any marked-region queries
      // the inspect overlay is holding, so exit inspect explicitly rather than
      // letting it dangle against a now-unmounted DOM (inspect is preserved as
      // a stale no-target mode otherwise). Inlined into this draft via the
      // shared reset helper so the switch stays a single atomic mutation.
      if (state.inspectModeActive) resetInspectState(state);
      // Auto-mark this workspace's notifications as read on activation.
      // Without this the unread badge keeps climbing whenever the user
      // switches around without clicking into a specific terminal (the
      // per-Pane click handler is the only other read trigger).
      // Guarded for unit tests that exercise workspaceSlice without the
      // notification slice mounted.
      if (Array.isArray(state.notifications)) {
        for (const n of state.notifications) {
          if (n.workspaceId === id && !n.read) n.read = true;
        }
      }
      // Same lifecycle clear for the visual ring — once a workspace is
      // activated and its notifications auto-mark as read, the per-pane
      // ring state must also collapse, otherwise rings stay 'glow'
      // forever on the newly visible workspace. paneSlice is also
      // guarded for tests that mount workspaceSlice in isolation.
      if (state.paneNotificationRing) {
        const activatedWs = state.workspaces.find((w: Workspace) => w.id === id);
        if (activatedWs) {
          const collectLeafIdsFromPane = (p: Pane): string[] =>
            p.type === 'leaf' ? [p.id] : p.children.flatMap(collectLeafIdsFromPane);
          for (const pid of collectLeafIdsFromPane(activatedWs.rootPane)) {
            delete state.paneNotificationRing[pid];
          }
        }
      }
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

    setWorkspaceProfile: (id, profile) => set((state: StoreState) => {
      const ws = state.workspaces.find((w: Workspace) => w.id === id);
      if (!ws) return;
      // This is the editor/save boundary, so enforce the secret-name policy
      // (dropSecretKeys) in addition to dropping invalid/reserved entries. Load
      // is intentionally NOT dropSecretKeys (non-destructive — see loadSession).
      const normalized = normalizeWorkspaceProfile(profile, { dropSecretKeys: true });
      if (normalized) {
        ws.profile = normalized;
      } else {
        delete ws.profile;
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

      // Security + correctness: sanitize surfaces.
      //
      // HISTORICAL CONTEXT (Pre-Fix-0):
      //   This slice force-cleared every surface.ptyId = '' on load
      //   to dodge a Pane→Terminal propagation race: AppLayout
      //   reconcile would fallback-create a new PTY, call
      //   updateSurfacePtyId(newId), but the store update did not
      //   reach Terminal before the user's first keystroke. That
      //   keystroke went to the old ptyId, which the daemon no
      //   longer had a SessionPipe for, and `pty.write` dropped it
      //   silently ("PTY_WRITE drop reason=no-live-session-pipe").
      //   Terminal looked alive (PTY init output flowed in) but was
      //   input-dead. The wipe pushed every surface into the
      //   well-tested Terminal.tsx self-create path, at the cost of
      //   silently breaking scrollback restore for v2.8.x-v2.9.0.
      //
      // FIX 0 CONTRACT (current):
      //   Saved ptyIds are preserved here. AppLayout owns the
      //   reconcile cycle: it gates PaneContainer mount on a
      //   generation-tokened, AbortController-cancellable reconcile
      //   pass that either matches each saved ptyId to a live
      //   daemon session (reconnect, scrollback preserved) or
      //   clears the ptyId (Terminal self-create on mount). By the
      //   time Terminal mounts, ptyId is final. The
      //   store→Pane→Terminal race is impossible because mount
      //   happens AFTER the gate resolves.
      //
      //   AppLayout's reconcile no longer fallback-creates
      //   replacement PTYs (the original race source). It only
      //   reconnects-or-clears. Fresh PTY creation is owned
      //   entirely by Terminal.tsx — the well-tested path stays
      //   well-tested.
      //
      //   On any reconcile failure (abort, timeout, RPC reject),
      //   AppLayout's catch calls store.clearAllPtyState(), which
      //   reproduces the historical wipe — but as an explicit,
      //   logged, generation-guarded fallback, not an unconditional
      //   startup behavior. The wipe lives there, not here.
      //
      //   Side state (floatingPanePtyId, terminalBookmarks,
      //   company member.ptyId) is also cleared by
      //   clearAllPtyState — see workspaceSlice.clearAllPtyState
      //   below for the cross-slice fan-out.
      //
      //   External RPC handlers (useRpcBridge, companyRpcHandlers)
      //   guard on uiSlice.paneGate === 'ready' to prevent
      //   stale-ptyId writes during the pending window.
      //
      // Browser URL scheme sanitization stays here — it is an
      // orthogonal security boundary unrelated to ptyId lifecycle.
      const BLOCKED_URL_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'file:'];
      const sanitizePanes = (pane: Pane) => {
        if (pane.type === 'leaf') {
          for (const s of pane.surfaces) {
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

      // Sanitize each workspace profile from the (untrusted) saved session:
      // drop invalid env keys/values, reserved WMUX_* keys, and collapse an
      // empty profile so it doesn't linger as `{ env: {} }`. Deliberately NOT
      // dropSecretKeys — load is non-destructive, so a secret-named key saved
      // before the policy keeps working until the user re-saves the profile
      // (the editor flags it and drops it on save). Dropping here would
      // silently delete working config without un-storing the plaintext value.
      for (const ws of data.workspaces) {
        if (ws.profile === undefined) continue;
        const normalized = normalizeWorkspaceProfile(ws.profile);
        if (normalized) ws.profile = normalized;
        else delete ws.profile;
      }

      state.workspaces = data.workspaces;
      state.activeWorkspaceId = data.activeWorkspaceId;
      state.sidebarVisible = data.sidebarVisible;

      // Restore user preferences. Migrate legacy 37-field customThemeColors
      // shape to the new 10-token + xtermPaletteId form (idempotent).
      const migratedCustomTheme = data.customThemeColors
        ? migrateCustomThemeColors(data.customThemeColors)
        : null;
      if (migratedCustomTheme) {
        state.customThemeColors = migratedCustomTheme;
      }
      if (data.theme) {
        const theme = migrateThemeId(data.theme);
        state.theme = theme;
        document.documentElement.setAttribute('data-theme', theme);
        if (theme === 'custom' && migratedCustomTheme) {
          applyCustomCssVars(migratedCustomTheme);
        }
      }
      if (data.locale) {
        state.locale = data.locale as Locale;
        i18nSetLocale(data.locale as Locale);
      }
      if (data.terminalFontSize != null) state.terminalFontSize = data.terminalFontSize;
      // Sanitize on load too — session.json is untrusted (hand-editable), and
      // this path bypasses setTerminalFontFamily's write-time sanitize. Keeps
      // the "stored value is always clean" invariant (terminalFont.ts) intact
      // so a poisoned font string can't round-trip back to disk or reach a CSS
      // sink that forgets to re-sanitize.
      if (data.terminalFontFamily) {
        state.terminalFontFamily = sanitizeFontFamily(data.terminalFontFamily) || 'Cascadia Code';
      }
      if (data.defaultShell) state.defaultShell = data.defaultShell;
      if (data.splitInheritsCwd != null) state.splitInheritsCwd = data.splitInheritsCwd;
      if (typeof data.startupDirectory === 'string') state.startupDirectory = data.startupDirectory.trim();
      if (data.scrollbackLines != null) state.scrollbackLines = data.scrollbackLines;
      if (data.scrollbackRestoreEnabled != null) state.scrollbackRestoreEnabled = data.scrollbackRestoreEnabled;
      if (data.sidebarPosition) state.sidebarPosition = data.sidebarPosition;
      if (data.notificationSoundEnabled != null) state.notificationSoundEnabled = data.notificationSoundEnabled;
      if (data.toastEnabled != null) {
        state.toastEnabled = data.toastEnabled;
        window.electronAPI.settings.setToastEnabled(data.toastEnabled);
      }
      if (data.notificationRingEnabled != null) state.notificationRingEnabled = data.notificationRingEnabled;
      if (data.customKeybindings) {
        // Merge saved keybindings with current built-in defaults (mirrors the
        // layoutTemplates merge below). Built-in defaults (id 'kb-default-*')
        // the saved session predates are back-filled so shipping a new default
        // never silently drops it on a cross-version upgrade.
        //
        // The runtime lookup matches by KEY (useKeyboard:
        // customKeybindings.find((kb) => kb.key === pressed), first match
        // wins), so we (a) keep saved entries FIRST and (b) back-fill a default
        // only when neither its id NOR its key is already taken by a saved
        // entry. Otherwise resurrecting a default would shadow a user binding
        // that repurposed the same key under a different id. Trade-off (same as
        // the prefixConfig merge): a default the user deleted outright — with
        // no replacement on that key — is re-added on next load. Acceptable
        // until a removed-defaults tombstone schema exists.
        const savedIds = new Set(data.customKeybindings.map((k) => k.id));
        const savedKeys = new Set(data.customKeybindings.map((k) => k.key));
        const missingDefaults = DEFAULT_CUSTOM_KEYBINDINGS.filter(
          (k) => !savedIds.has(k.id) && !savedKeys.has(k.key),
        );
        state.customKeybindings = [...data.customKeybindings, ...missingDefaults.map((k) => ({ ...k }))];
      }
      if (data.autoUpdateEnabled != null) {
        state.autoUpdateEnabled = data.autoUpdateEnabled;
        window.electronAPI.settings.setAutoUpdateEnabled(data.autoUpdateEnabled);
      }
      if (data.sidebarMode) state.sidebarMode = data.sidebarMode;
      if (data.company !== undefined) state.company = data.company ?? null;
      if (data.memberCosts) state.memberCosts = data.memberCosts;
      if (data.sessionStartTime != null) state.sessionStartTime = data.sessionStartTime;
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
      if (data.prefixConfig) {
        // Merge the saved bindings ON TOP of DEFAULT_PREFIX_CONFIG instead of
        // wholesale replacement (mirrors the layoutTemplates merge above). A
        // session saved before a default binding existed — e.g. the arrow-key
        // pane-focus bindings (ArrowUp/Down/Left/Right) added in a later
        // release — carries a bindings map missing those keys; a wholesale
        // replace would overwrite the in-memory default and leave prefix+arrow
        // navigation permanently dead. Saved/rebound keys still win on
        // collision so user customizations are preserved. Trade-off: a default
        // the user deliberately removed is re-added on next load (acceptable
        // until a removed-defaults tombstone schema exists).
        state.prefixConfig = {
          key: data.prefixConfig.key ?? DEFAULT_PREFIX_CONFIG.key,
          bindings: { ...DEFAULT_PREFIX_CONFIG.bindings, ...data.prefixConfig.bindings },
        };
      }
    }),

    // ─── Fix 0 fallback (cross-slice atomic clear) ───────────────────────
    // Called from AppLayout startup catch when reconcile aborts or times
    // out. Reproduces the historical loadSession wipe as an explicit
    // fallback, plus the side-state fan-out the original wipe never
    // covered (floating pane, bookmarks, token data, company members).
    // After this runs, Terminal.tsx self-create sees externalPtyId='' on
    // mount and creates fresh PTYs — the well-tested new-pane path.
    clearSurfacePtyIdByPty: (ptyId: string) => set((state: StoreState) => {
      if (!ptyId) return;
      const walk = (pane: Pane) => {
        if (pane.type === 'leaf') {
          for (const s of pane.surfaces) {
            if (s.ptyId === ptyId && s.surfaceType !== 'browser' && s.surfaceType !== 'editor') {
              s.ptyId = '';
            }
          }
        } else {
          for (const child of pane.children) walk(child);
        }
      };
      for (const ws of state.workspaces) walk(ws.rootPane);
    }),

    clearAllPtyState: () => set((state: StoreState) => {
      // 1. Terminal surface ptyId across all workspaces + nested split panes.
      const walkAndClearPtyIds = (pane: Pane) => {
        if (pane.type === 'leaf') {
          for (const s of pane.surfaces) {
            if (s.surfaceType !== 'browser' && s.surfaceType !== 'editor') {
              s.ptyId = '';
            }
          }
        } else {
          for (const child of pane.children) walkAndClearPtyIds(child);
        }
      };
      for (const ws of state.workspaces) walkAndClearPtyIds(ws.rootPane);

      // 2. uiSlice fields (cross-slice mutation within the same immer set).
      state.floatingPanePtyId = null;
      state.terminalBookmarks = {};

      // 3. companySlice — member.ptyId across all departments.
      if (state.company) {
        for (const dept of state.company.departments) {
          for (const member of dept.members) {
            member.ptyId = undefined;
          }
        }
      }
    }),
  };
};
