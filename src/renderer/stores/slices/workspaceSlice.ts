import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { createWorkspace, clonePaneTreeFresh, assignPaneOrdinals, generateId, BUILTIN_TEMPLATES, DEFAULT_PREFIX_CONFIG, buildDefaultCustomKeybindings, upgradeDefaultKeybindingsForPlatform, TERMINAL_STATES, type Pane, type PaneLeaf, type SessionData, type Workspace, type WorkspaceMetadata, type WorkspaceProfile } from '../../../shared/types';
import { normalizeWorkspaceProfile } from '../../../shared/workspaceProfile';
import { getPresetById } from '../../../shared/layoutPresets';
import { setLocale as i18nSetLocale, t as i18nT, type Locale } from '../../i18n';
import { applyCustomCssVars, migrateThemeId, migrateCustomThemeColors } from '../../themes';
import { resetInspectState } from './uiSlice';
import { sanitizeFontFamily } from '../../utils/terminalFont';
import { publishWorkspaceMetadataChanged, publishA2aTask } from '../../events/publisher';
import { retentionMigrationDone, markRetentionMigrationDone } from '../retentionMigration';

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
  /** P2 — global high-water for stable Workspace.wsOrdinal allocation. Never
   *  decremented; persisted in SessionData so numbers survive restart. */
  nextWorkspaceOrdinal: number;
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

export const createWorkspaceSlice: StateCreator<StoreState, [['zustand/immer', never]], [], WorkspaceSlice> = (set, get) => {
  const initial = createWorkspace('Workspace 1', 1);
  return {
    workspaces: [initial],
    activeWorkspaceId: initial.id,
    nextWorkspaceOrdinal: 2,

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
      const wsOrdinal = state.nextWorkspaceOrdinal ?? 1;
      const ws = createWorkspace(wsName, wsOrdinal);
      state.nextWorkspaceOrdinal = wsOrdinal + 1;
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
      const wsOrdinal = state.nextWorkspaceOrdinal ?? 1;
      const ws: Workspace = {
        id: generateId('ws'),
        name: wsName,
        rootPane,
        activePaneId: leaves[0]?.id || rootPane.id,
        wsOrdinal,
        // P2: number the preset's leaves fresh 1..n.
        nextPaneOrdinal: assignPaneOrdinals(rootPane, 1),
      };
      state.nextWorkspaceOrdinal = wsOrdinal + 1;
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

      const wsOrdinal = state.nextWorkspaceOrdinal ?? 1;
      const ws: Workspace = {
        id: generateId('ws'),
        name: nextCopyName(src.name, state.workspaces.map((w: Workspace) => w.name)),
        rootPane,
        activePaneId,
        wsOrdinal,
        // P2: the clone gets a FRESH 1..n pane sequence (clonePaneTreeFresh
        // intentionally drops source ordinals), so the duplicate's names don't
        // alias the source's.
        nextPaneOrdinal: assignPaneOrdinals(rootPane, 1),
        ...(profile ? { profile } : {}),
      };
      state.nextWorkspaceOrdinal = wsOrdinal + 1;
      // Insert right after the source for intuitive placement, then activate.
      state.workspaces.splice(idx + 1, 0, ws);
      state.activeWorkspaceId = ws.id;
    }),

    // NOTE: PTY cleanup is the caller's responsibility (see Sidebar.handleClose, useKeyboard Ctrl+Shift+W)
    removeWorkspace: (id) => {
      // A8: this workspace hosts the receiver side of any task delegated TO it.
      // It's going away, so fail its in-flight (non-terminal) received tasks —
      // otherwise the sender sees them stuck 'working' forever (silent break).
      // Collect the failed (id, from, to) inside the transaction, then emit the
      // a2a.task pointer AFTER it (review A8 P1) so a CROSS-process sender
      // (LanLink / separate window / durable inbox) also learns, not just
      // same-process queryTasks pollers.
      const failed: { id: string; from: string; to: string }[] = [];
      // R2: decide whether the removal will actually happen ahead of the
      // transaction — the same condition as the in-set() guards (last-workspace
      // protection, nonexistent id).
      const willRemove =
        get().workspaces.length > 1 && get().workspaces.some((w: Workspace) => w.id === id);
      set((state: StoreState) => {
        if (state.workspaces.length <= 1) return;
        const idx = state.workspaces.findIndex((w: Workspace) => w.id === id);
        if (idx === -1) return;
        const closedAt = new Date().toISOString();
        for (const task of Object.values(state.a2aTasks ?? {})) {
          if (
            task.metadata.to.workspaceId === id &&
            !(TERMINAL_STATES as readonly string[]).includes(task.status.state)
          ) {
            // Intentional teardown FORCE-fail: bypasses validateTransition (which
            // forbids submitted/input-required → failed) because the receiver is
            // gone — any non-terminal received task can no longer make progress.
            task.status = {
              state: 'failed',
              message: {
                kind: 'message',
                messageId: `wsclose-${task.id}`,
                role: 'agent', // synthetic teardown notice (no 'system' role in the A2A schema)
                parts: [
                  { kind: 'text', text: 'Receiver workspace closed before completing this task.' },
                ],
              },
              timestamp: closedAt,
            };
            task.metadata.updatedAt = closedAt;
            failed.push({
              id: task.id,
              from: task.metadata.from.workspaceId,
              to: task.metadata.to.workspaceId,
            });
          }
        }
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
      // J3 F4: 이 ws가 태스크 워크스페이스(paneGroupId=이 ws id)였다면 이탈 뱃지·
      // onExhausted 매핑을 evict(무한 성장 방지). departed는 ws id 키, registry는
      // ptyId 키라 제거 ws의 모든 surface ptyId를 훑는다. workTaskSlice 없이 조립된
      // 최소 목 스토어(단위 테스트)에선 두 맵이 부재하므로 존재 가드.
      if (state.departedPaneGroups) delete state.departedPaneGroups[id];
      if (state.taskPtyRegistry) {
        const removedWs = state.workspaces[idx];
        const collectPtyIds = (p: Pane): string[] =>
          p.type === 'leaf' ? p.surfaces.map((s) => s.ptyId).filter(Boolean) : p.children.flatMap(collectPtyIds);
        for (const pid of collectPtyIds(removedWs.rootPane)) delete state.taskPtyRegistry[pid];
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
      });
      // Cross-process failure pointer (publishA2aTask), so the teardown is
      // visible beyond same-process queryTasks (review A8 P1). NOTE: this is a
      // SECOND a2a.task emitter — emitA2aTaskEvent is the primary one but not the
      // only one (§6.M PR-C review, Codex). Teardown force-fail carries no
      // verified evidence (the receiver is gone; the daemon-native force-fail
      // synthesizes evidence with items:[] → grade 0), so stamp verifiedItemCount
      // = 0 here to keep the cross-process event consistent with the daemon canon.
      for (const f of failed) publishA2aTask(f.from, f.to, f.id, 'failed', 'updated', undefined, 0);
      // R2: clean up the dead workspace's channel member rows + principals (a
      // cross-cutting teardown at the same spot as the a2a force-fail).
      // Fire-and-forget — cleanup is idempotent, and even if it fails the stale
      // backfill / TTL reaper will converge.
      // Optional call: the minimal test store has no channels slice (in the
      // production store it always exists — same convention as the
      // paneNotificationRing guard).
      if (willRemove) {
        void get().purgeMembershipDaemon?.({ workspaceId: id });
        void get().principalMarkStaleWorkspaceDaemon?.(id);
      }
    },

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

      // ── P2 hydration backfill (checklist F) ──────────────────────────────
      // Pre-P2 sessions (and any drift) lack ordinals. Assign them here,
      // atomically within this same `set`, so the first split/duplicate after
      // load observes correct high-water counters and pane names stay stable.
      //
      // Pane ordinals: backfill a tree missing any leaf ordinal via DFS;
      // otherwise recompute the per-ws high-water from live leaves so a saved
      // nextPaneOrdinal can never sit below the actual max (which would recycle
      // a number on the next split).
      for (const ws of state.workspaces) {
        const wsLeaves = collectLeafPanes(ws.rootPane);
        // Backfill ONLY leaves missing an ordinal, numbering them PAST the current
        // max — a partial gap (e.g. one freshly-added leaf) must NOT renumber panes
        // that already have stable ordinals, which would shuffle their auto-names
        // and any labels keyed off them (CodeRabbit review). When every leaf already
        // has one this just recomputes the high-water; when all are missing (pre-P2)
        // it assigns 1..N in the same DFS order as assignPaneOrdinals.
        let maxLeaf = wsLeaves.reduce(
          (m, l) => Math.max(m, typeof l.ordinal === 'number' ? l.ordinal : 0),
          0,
        );
        for (const l of wsLeaves) {
          if (typeof l.ordinal !== 'number') {
            maxLeaf += 1;
            l.ordinal = maxLeaf;
          }
        }
        ws.nextPaneOrdinal = Math.max(ws.nextPaneOrdinal ?? 0, maxLeaf + 1);
      }
      // Workspace ordinals: honor existing wsOrdinals, assign any missing past
      // the high-water, then persist the advanced global counter.
      let nextWs = data.nextWorkspaceOrdinal ?? 1;
      for (const ws of state.workspaces) {
        if (typeof ws.wsOrdinal === 'number') nextWs = Math.max(nextWs, ws.wsOrdinal + 1);
      }
      for (const ws of state.workspaces) {
        if (typeof ws.wsOrdinal !== 'number') {
          ws.wsOrdinal = nextWs;
          nextWs += 1;
        }
      }
      state.nextWorkspaceOrdinal = nextWs;

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
      if (typeof data.deckBrainModel === 'string') state.deckBrainModel = data.deckBrainModel;
      // Fail closed to raw mode: only an explicit true enables full power.
      state.deckBrainFullPower = data.deckBrainFullPower === true;
      // Fail closed to the default brain: only known vendor ids are restored.
      state.deckBrainVendor = data.deckBrainVendor === 'hermes' ? 'hermes' : 'claude';
      // Fail closed to hidden: only an explicit boolean shows the (frozen)
      // human channel UI.
      if (typeof data.channelsTabVisible === 'boolean') {
        state.channelsTabVisible = data.channelsTabVisible;
      }
      // Git 탭은 기본 ON — 명시적 false만 숨긴다(정보성 표면, fail-closed 불요).
      if (typeof data.gitTabVisible === 'boolean') {
        state.gitTabVisible = data.gitTabVisible;
      }
      // Pane action cluster — default ON; only an explicit false hides it.
      if (typeof data.paneActionsVisible === 'boolean') {
        state.paneActionsVisible = data.paneActionsVisible;
      }
      if (data.splitInheritsCwd != null) state.splitInheritsCwd = data.splitInheritsCwd;
      if (data.imeResidueGuardEnabled != null) state.imeResidueGuardEnabled = data.imeResidueGuardEnabled;
      // Fail closed: only an explicit boolean is applied. A corrupted /
      // hand-edited value (e.g. the string "false") must not toggle the
      // retention/resync path either way.
      let retentionMigrationApplied = false;
      if (typeof data.hiddenPaneRetentionEnabled === 'boolean') {
        if (data.hiddenPaneRetentionEnabled === false && !retentionMigrationDone()) {
          // One-shot default-flip migration (app-weight P0-1, 2026-07-16):
          // every pre-flip build persisted the old `false` DEFAULT into
          // session.json, so a bare default change reaches nobody. A persisted
          // `false` without the ledger marker is treated as that old default
          // and flipped ON exactly once; the ledger (localStorage — survives
          // old-build session rewrites, see retentionMigration.ts) then makes
          // any later OFF permanent. Accepted, documented ambiguity: a
          // deliberate pre-flip OFF is flipped once too — Settings hatch +
          // release note cover it.
          console.log('[wmux:hidden-retention] one-shot default-ON migration applied (persisted false, no ledger marker)');
          state.hiddenPaneRetentionEnabled = true;
          retentionMigrationApplied = true;
          // One-time post-upgrade notice (DX review): the flip must be
          // announced, not discovered through a confusing reveal. setTimeout
          // escapes the immer set(); the action button is the escape hatch.
          setTimeout(() => {
            get().pushToast({
              message: i18nT('retention.migratedNotice'),
              level: 'info',
              action: {
                label: i18nT('retention.migratedNoticeTurnOff'),
                onClick: () => get().setHiddenPaneRetentionEnabled(false),
              },
            });
          }, 0);
        } else {
          state.hiddenPaneRetentionEnabled = data.hiddenPaneRetentionEnabled;
        }
      }
      // Stamp the ledger after a session load has been processed by a
      // default-ON build — from here on, persisted values are authoritative
      // user state. When a migration flip was applied JUST NOW, the flipped
      // value only exists in memory until the first session save lands (5 s
      // autosave / reconcile save); stamping immediately would make a crash
      // in that window lose the flip forever — disk still says false, ledger
      // says migrated (codex, PR #470). Defer the stamp past the first save
      // with wide margin; a crash inside the window simply re-runs the
      // idempotent migration next boot. A deliberate OFF inside the window is
      // protected regardless — the Settings setter stamps immediately.
      if (retentionMigrationApplied) {
        setTimeout(() => markRetentionMigrationDone(), 30_000);
      } else {
        markRetentionMigrationDone();
      }
      if (typeof data.startupDirectory === 'string') state.startupDirectory = data.startupDirectory.trim();
      if (data.scrollbackLines != null) state.scrollbackLines = data.scrollbackLines;
      if (data.scrollbackRestoreEnabled != null) state.scrollbackRestoreEnabled = data.scrollbackRestoreEnabled;
      // Fail closed: only an explicit boolean enables this security-sensitive
      // YOLO flag. A malformed persisted value (e.g. the string "false") must
      // not become truthy and silently auto-approve bypassPermissions execs.
      if (typeof data.a2aAutoApproveExecute === 'boolean') {
        state.a2aAutoApproveExecute = data.a2aAutoApproveExecute;
      }
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
        // `typeof window` 가드는 node 테스트 환경(window 미정의)에서 ReferenceError를 막는다.
        const platform = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined;
        // 손 안 댄 원본 F7 기본값을 현재 플랫폼 기본 키(Mac=Ctrl+F7)로 1회 승격.
        // macOS 미디어 키에 먹혀 안 뜨던 기존 사용자의 F7을 실제로 고친다.
        const migrated = upgradeDefaultKeybindingsForPlatform(data.customKeybindings, platform);
        const savedIds = new Set(migrated.map((k) => k.id));
        const savedKeys = new Set(migrated.map((k) => k.key));
        // 플랫폼별 기본값으로 백필 — Mac은 Ctrl+F7, 그 외 F7. 저장된 기본값은
        // id/key 매칭에 걸려 아래 filter에서 제외되므로 중복 추가되지 않는다.
        const missingDefaults = buildDefaultCustomKeybindings(platform).filter(
          (k) => !savedIds.has(k.id) && !savedKeys.has(k.key),
        );
        state.customKeybindings = [...migrated, ...missingDefaults.map((k) => ({ ...k }))];
      }
      if (data.autoUpdateEnabled != null) {
        state.autoUpdateEnabled = data.autoUpdateEnabled;
        window.electronAPI.settings.setAutoUpdateEnabled(data.autoUpdateEnabled);
      }
      if (data.sidebarMode) state.sidebarMode = data.sidebarMode;
      if (data.channelDockVisible != null) state.channelDockVisible = data.channelDockVisible;
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
      if (data.agentToolbarEnabled != null) state.agentToolbarEnabled = data.agentToolbarEnabled;
      if (data.agentToolbarSnippets != null) state.toolbarSnippets = data.agentToolbarSnippets;
      if (data.agentToolbarNewCommand != null) state.newConversationCommand = data.agentToolbarNewCommand;
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
            if (s.ptyId === ptyId && s.surfaceType !== 'browser' && s.surfaceType !== 'editor' && s.surfaceType !== 'diff') {
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
            if (s.surfaceType !== 'browser' && s.surfaceType !== 'editor' && s.surfaceType !== 'diff') {
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
      // X1 per-surface port map is ptyId-keyed — same wipe contract.
      if (state.surfacePorts) state.surfacePorts = {};

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
