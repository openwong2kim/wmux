import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { createWorkspace, clonePaneTreeFresh, assignPaneOrdinals, generateId, BUILTIN_TEMPLATES, DEFAULT_PREFIX_CONFIG, buildDefaultCustomKeybindings, upgradeDefaultKeybindingsForPlatform, TERMINAL_STATES, NOTIFICATION_CATEGORIES, type Pane, type PaneLeaf, type SessionData, type StashedPane, type Workspace, type WorkspaceMetadata, type WorkspaceProfile } from '../../../shared/types';
import { normalizeWorkspaceProfile } from '../../../shared/workspaceProfile';
import { ADVERTISED_SHORTCUTS } from '../../../shared/keymap';
import { normalizeWorkspaceColor, type WorkspaceColorId } from '../../../shared/workspaceColors';
import { normalizeRoleBindings } from '../../../shared/orchestratorRole';
import { getPresetById } from '../../../shared/layoutPresets';
import { setLocale as i18nSetLocale, t as i18nT, detectSupportedLocale, type Locale } from '../../i18n';
import { applyCustomCssVars, migrateThemeId, migrateCustomThemeColors } from '../../themes';
import { resetInspectState } from './uiSlice';
import { sanitizeFontFamily } from '../../utils/terminalFont';
import { sanitizeTerminalCursorStyle } from '../../../shared/terminalCursor';
import { MULTIVIEW_ARRANGEMENTS } from '../../utils/multiviewGrid';
import { publishWorkspaceMetadataChanged, publishA2aTask } from '../../events/publisher';
import { retentionMigrationDone, markRetentionMigrationDone } from '../retentionMigration';
import { decUnread } from './notificationSlice';
import { mergeDeadPaneRecovery, type DeadPaneRecovery } from '../../../shared/ptyRecovery';
import { stashedPaneLiveness } from '../../../shared/paneStash';
import {
  collectLeafIds,
  getLeafPanes,
  getWorkspaceLeafPanes,
  getWorkspacePtyIds,
} from '../../../shared/paneUtils';

/** Collect all leaf panes from a pane tree (canonical walk, aliased locally). */
const collectLeafPanes = getLeafPanes;

/**
 * Cold-park (TASK-9) is safe ONLY for terminal-only workspaces. Unmounting a
 * pane tree that holds a browser (live webview session), editor (unsaved local
 * scratch edits), or diff/git/review surface would lose that state — unlike a
 * terminal, whose bytes live in the daemon ring and replay on reveal. So a
 * workspace is parkable only when every surface is a terminal (surfaceType
 * absent defaults to terminal). Deeper per-surface parking is a follow-up.
 */
/**
 * Cold-park convergence helper: drop a workspace's parked / idle-clock entries.
 * Called wherever activeWorkspaceId is assigned OUTSIDE setActiveWorkspace
 * (removeWorkspace, company destroy/removeDept, loadSession) so a promoted-to-
 * visible workspace's park state converges immediately instead of lingering
 * until the next sweep. Guarded for stores/tests without the cold-park maps.
 */
export function clearColdParkEntry(
  state: { parkedWorkspaceIds?: Record<string, true>; lastVisibleAt?: Record<string, number> },
  id: string,
): void {
  if (state.parkedWorkspaceIds && state.parkedWorkspaceIds[id]) delete state.parkedWorkspaceIds[id];
  if (state.lastVisibleAt && state.lastVisibleAt[id] !== undefined) delete state.lastVisibleAt[id];
}

/**
 * Task 6 (Remote Workspace Attach) — same convention as clearColdParkEntry:
 * call at EVERY site that assigns activeWorkspaceId, so selecting/promoting
 * a local workspace always drops any remote mirror selection. Without this,
 * WorkspaceCenter (which checks activeRemoteKey first) keeps showing a remote
 * mirror while the sidebar highlights the newly-active local workspace.
 * Guarded for stores/tests without the remoteWorkspacesSlice mounted.
 */
export function clearRemoteSelection(state: { activeRemoteKey?: string | null }): void {
  if (state.activeRemoteKey !== undefined && state.activeRemoteKey !== null) state.activeRemoteKey = null;
}

/**
 * Drop multiview members whose workspace is gone, and disband a group left with
 * fewer than two. Call from every path where workspaces disappear — the same set
 * clearColdParkEntry covers (removeWorkspace, company destroy/removeDept,
 * loadSession) — because they fail the same way: the grid gate counts
 * `multiviewIds` while the tiles are filtered against live workspaces, so one
 * live member plus one stale id renders a one-tile "grid" with full multiview
 * chrome that nothing but Ctrl+Shift+G dismisses (#751).
 * Guarded for stores/tests mounted without uiSlice.
 */
export function pruneMultiviewMembership(state: {
  workspaces: Workspace[];
  multiviewIds?: string[];
}): void {
  if (!state.multiviewIds || state.multiviewIds.length === 0) return;
  const live = state.multiviewIds.filter((id) => state.workspaces.some((w) => w.id === id));
  state.multiviewIds = live.length <= 1 ? [] : live;
}

/**
 * Validate a persisted `StashedPane.origin` (#977).
 *
 * session.json is user-editable and can come from a newer build, so every field
 * is checked rather than trusted — a bad `direction` would build a branch in an
 * axis that does not exist, and a `sizes` array of the wrong length is exactly
 * the sizes/children mismatch that renders every survivor one slot off.
 * Returns undefined when anything is off, which degrades unstash to the
 * active-pane fallback instead of failing it.
 */
function normalizeStashOrigin(
  raw: unknown,
  wsId: string,
  paneId: string,
): StashedPane['origin'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Partial<NonNullable<StashedPane['origin']>>;
  if (typeof o.anchorPaneId !== 'string' || o.anchorPaneId.length === 0) {
    console.warn(`[wmux:stash] dropping origin on ws=${wsId} pane=${paneId}: bad anchorPaneId`);
    return undefined;
  }
  if (o.direction !== 'horizontal' && o.direction !== 'vertical') {
    console.warn(`[wmux:stash] dropping origin on ws=${wsId} pane=${paneId}: bad direction`);
    return undefined;
  }
  if (typeof o.sourceFirst !== 'boolean') {
    console.warn(`[wmux:stash] dropping origin on ws=${wsId} pane=${paneId}: bad sourceFirst`);
    return undefined;
  }
  const sizes = o.sizes;
  if (sizes !== undefined) {
    const usable =
      Array.isArray(sizes)
      && sizes.length === 2
      && sizes.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
    if (!usable) {
      // Keep the placement, drop the proportions — attachBeside already falls
      // back to [50,50] for anything that is not exactly two entries.
      console.warn(`[wmux:stash] dropping origin sizes on ws=${wsId} pane=${paneId}`);
      return { anchorPaneId: o.anchorPaneId, direction: o.direction, sourceFirst: o.sourceFirst };
    }
  }
  return {
    anchorPaneId: o.anchorPaneId,
    direction: o.direction,
    sourceFirst: o.sourceFirst,
    ...(sizes ? { sizes: [...sizes] } : {}),
  };
}

function isTerminalOnlyWorkspace(ws: Workspace): boolean {
  // Workspace-wide (#977): a stashed browser surface still belongs to this
  // workspace, and cold-parking on the strength of the visible tree alone would
  // unload it under an eligibility test that never looked at it.
  for (const leaf of getWorkspaceLeafPanes(ws)) {
    for (const s of leaf.surfaces) {
      if (s.surfaceType !== undefined && s.surfaceType !== 'terminal') return false;
    }
  }
  return true;
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
  // ─── Cold-park (TASK-9) — renderer-only, NOT persisted ───────────────────
  // Hidden workspaces idle past a threshold are "parked": WorkspaceViewport
  // renders a placeholder instead of PaneContainer, unmounting their terminals
  // (daemon PTY + store row survive). These maps are deliberately NOT part of
  // workspace metadata — metadata mutations publish over the RPC bus, and park
  // state is a local view concern that must never leave this renderer.
  /** Wall-clock ms a workspace was last visible (stamped when it goes hidden).
   *  Absent while a workspace is visible. */
  lastVisibleAt: Record<string, number>;
  /** Set membership (id → true) of currently cold-parked workspaces. */
  parkedWorkspaceIds: Record<string, true>;
  /** Immediately un-park a workspace (called synchronously on reveal so the
   *  same frame renders PaneContainer, not the placeholder). */
  unparkWorkspace: (id: string) => void;
  /** Idempotent periodic sweep: stamps newly-hidden workspaces, parks those
   *  idle past `thresholdMs`, and un-parks/clears any that are visible now.
   *  Visible = activeWorkspaceId OR a multiview member. Pure w.r.t. current
   *  state — safe to call on any cadence. */
  sweepColdPark: (nowTs: number, thresholdMs: number) => void;
  /** Create and activate a new workspace. An optional `profile` is normalized
   * (dropSecretKeys) and attached in the SAME immer set, so pane #1 spawns with
   * profile.startupCwd already present instead of a home fallback (#515). */
  addWorkspace: (name?: string, profile?: WorkspaceProfile) => void;
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
  /**
   * Set (or clear with undefined) the workspace's visual color tag. Purely a
   * sidebar label — no process, agent or git meaning is attached, so this
   * deliberately publishes no metadata event. Unknown ids are dropped by
   * normalizeWorkspaceColor rather than stored.
   */
  setWorkspaceColor: (id: string, color: WorkspaceColorId | undefined) => void;
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
   * Optional recovery metadata is staged on the matched surface first.
   */
  clearSurfacePtyIdByPty: (ptyId: string, recovery?: DeadPaneRecovery) => void;
}

export const createWorkspaceSlice: StateCreator<StoreState, [['zustand/immer', never]], [], WorkspaceSlice> = (set, get) => {
  const initial = createWorkspace('Workspace 1', 1);
  return {
    workspaces: [initial],
    activeWorkspaceId: initial.id,
    nextWorkspaceOrdinal: 2,
    lastVisibleAt: {},
    parkedWorkspaceIds: {},

    unparkWorkspace: (id) => set((state: StoreState) => {
      if (state.parkedWorkspaceIds[id]) delete state.parkedWorkspaceIds[id];
      // It's about to be visible — drop its idle stamp so the clock restarts
      // only once it goes hidden again.
      if (state.lastVisibleAt[id] !== undefined) delete state.lastVisibleAt[id];
    }),

    sweepColdPark: (nowTs, thresholdMs) => set((state: StoreState) => {
      const visible = new Set<string>([state.activeWorkspaceId, ...state.multiviewIds]);
      for (const ws of state.workspaces) {
        const id = ws.id;
        if (visible.has(id)) {
          // Visible now — never parked, no idle clock running.
          if (state.parkedWorkspaceIds[id]) delete state.parkedWorkspaceIds[id];
          if (state.lastVisibleAt[id] !== undefined) delete state.lastVisibleAt[id];
          continue;
        }
        if (state.parkedWorkspaceIds[id]) {
          // Already parked — but a parked workspace can GAIN a non-terminal
          // surface (e.g. browser.open targeting it), which would never mount
          // until manual reveal. Re-check and unpark so the new surface renders.
          if (!isTerminalOnlyWorkspace(ws)) {
            delete state.parkedWorkspaceIds[id];
            if (state.lastVisibleAt[id] !== undefined) delete state.lastVisibleAt[id];
          }
          continue;
        }
        // Never park a workspace holding a browser/editor/diff surface — those
        // carry live state a terminal doesn't (no daemon ring to replay from).
        if (!isTerminalOnlyWorkspace(ws)) continue;
        const since = state.lastVisibleAt[id];
        if (since === undefined) {
          // First time we observe it hidden — start the idle clock. (Covers
          // restored-but-never-viewed workspaces, which have no stamp.)
          state.lastVisibleAt[id] = nowTs;
        } else if (nowTs - since >= thresholdMs) {
          state.parkedWorkspaceIds[id] = true;
        }
      }
    }),

    addWorkspace: (name, profile) => set((state: StoreState) => {
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
      // #515: attach the profile BEFORE activation (same set) so pane #1's PTY
      // create sees profile.startupCwd. Editor/save boundary → dropSecretKeys.
      if (profile) {
        const normalized = normalizeWorkspaceProfile(profile, { dropSecretKeys: true });
        if (normalized) ws.profile = normalized;
      }
      state.nextWorkspaceOrdinal = wsOrdinal + 1;
      state.workspaces.push(ws);
      state.activeWorkspaceId = ws.id;
      clearRemoteSelection(state);
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
      clearRemoteSelection(state);
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
        // `color` is deliberately NOT carried over (owner decision, 2026-08-17).
        // The tag exists to tell workspaces apart; handing the copy the same one
        // would make the two rows identical at the exact moment they sit next to
        // each other, which defeats the label. The copy starts untagged and the
        // user assigns it — unlike `profile` above, which is configuration the
        // duplicate genuinely needs in order to behave like its source.
      };
      state.nextWorkspaceOrdinal = wsOrdinal + 1;
      // Insert right after the source for intuitive placement, then activate.
      state.workspaces.splice(idx + 1, 0, ws);
      state.activeWorkspaceId = ws.id;
      clearRemoteSelection(state);
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
        for (const leaf of getWorkspaceLeafPanes(removedWs)) {
          delete state.paneNotificationRing[leaf.id];
        }
      }
      // J3 F4: 이 ws가 태스크 워크스페이스(paneGroupId=이 ws id)였다면 이탈 뱃지·
      // onExhausted 매핑을 evict(무한 성장 방지). departed는 ws id 키, registry는
      // ptyId 키라 제거 ws의 모든 surface ptyId를 훑는다. workTaskSlice 없이 조립된
      // 최소 목 스토어(단위 테스트)에선 두 맵이 부재하므로 존재 가드.
      if (state.departedPaneGroups) delete state.departedPaneGroups[id];
      if (state.taskPtyRegistry) {
        const removedWs = state.workspaces[idx];
        for (const pid of getWorkspacePtyIds(removedWs)) delete state.taskPtyRegistry[pid];
      }
      // #650 recovery metadata is transient but hydration-sticky. A removed
      // workspace must evict both surface-keyed pending hand-offs and offers
      // rebound to its ptys, otherwise the normal list poll intentionally keeps
      // them alive forever.
      {
        const removedWs = state.workspaces[idx];
        const allSurfaces = getWorkspaceLeafPanes(removedWs).flatMap((leaf) =>
          leaf.surfaces.map((s) => ({ id: s.id, ptyId: s.ptyId })),
        );
        for (const surface of allSurfaces) {
          if (state.pendingDeadPaneRecoveryBySurfaceId) {
            delete state.pendingDeadPaneRecoveryBySurfaceId[surface.id];
          }
          if (surface.ptyId && state.deadPaneRecoveryOfferByPtyId?.[surface.ptyId]) {
            delete state.deadPaneRecoveryOfferByPtyId[surface.ptyId];
            delete state.resumeHintByPtyId[surface.ptyId];
            delete state.resumeBindingByPtyId[surface.ptyId];
          }
        }
      }
      // Order matters: capture the group BEFORE pruning so the promotion below
      // can still tell who this workspace's neighbours in the grid were.
      const mvBefore = state.multiviewIds ? [...state.multiviewIds] : [];
      state.workspaces.splice(idx, 1);
      // Drop it from the multiview group too (#751). This does NOT contradict
      // the "multiviewIds is intentionally preserved" note in setActiveWorkspace
      // — that is about switching AWAY from a group, which the user can undo by
      // clicking a member. A removed workspace can never come back.
      pruneMultiviewMembership(state);
      if (state.activeWorkspaceId === id) {
        // Promote a surviving GRID MEMBER when one exists. Promoting by array
        // position alone can land on a workspace outside the group, and the
        // render gate needs the active workspace to be a member — so closing
        // the active tile from the sidebar would take every remaining tile with
        // it. That is the same collapse #752 fixed for the toggle paths; this is
        // the third entry point into it.
        const mvNow = state.multiviewIds ?? [];
        let next: string | undefined;
        if (mvNow.length >= 2) {
          const i = mvBefore.indexOf(id);
          const neighbor = i >= 0 ? (mvBefore[i + 1] ?? mvBefore[i - 1]) : undefined;
          next = neighbor && mvNow.includes(neighbor) ? neighbor : mvNow[0];
        }
        state.activeWorkspaceId =
          next ?? state.workspaces[Math.min(idx, state.workspaces.length - 1)].id;
        // Cold-park: the newly-promoted workspace must not stay parked.
        clearColdParkEntry(state, state.activeWorkspaceId);
        clearRemoteSelection(state);
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
        // Missions are bound to the lifetime of their fan-out workspace: when
        // the workspace goes, the mission closes, which archives its mission
        // channel into the collapsed group. The CHANNEL SURVIVES — closing a
        // mission never deletes its record. Optional call (the minimal test
        // store has no workTask slice) and fire-and-forget: the sidebar's
        // visibility rule reads workspace existence directly, so it is already
        // correct whether or not this RPC lands.
        void get().closeMissionForRemovedWorkspace?.(id);
        // NOTE: deliberately NOT `clearMissionsFor(id)`. That bucket is keyed by
        // the fan-out PARENT, and its tasks' child workspaces routinely outlive
        // the parent — wiping it would hide live missions from the sidebar AND
        // leave `closeMissionForRemovedWorkspace` unable to find those tasks when
        // the children are deleted later. The orphan bucket is harmless: it is
        // capped per workspace, `selectLiveMissions` filters rows by child
        // workspace existence, and `refreshMissions` only ever visits workspaces
        // that still exist, so it never grows again.
      }
    },

    setActiveWorkspace: (id) => set((state: StoreState) => {
      if (!state.workspaces.some((w: Workspace) => w.id === id)) return;
      // Cold-park (TASK-9): the outgoing workspace is about to go hidden — start
      // its idle clock. The incoming one is un-parked synchronously in this same
      // mutation so WorkspaceViewport renders PaneContainer (not the placeholder)
      // on the very next frame. The outgoing stamp is skipped if it stays visible
      // as a multiview member.
      if (state.parkedWorkspaceIds && state.lastVisibleAt) {
        const prev = state.activeWorkspaceId;
        if (prev && prev !== id && !(state.multiviewIds ?? []).includes(prev)) {
          state.lastVisibleAt[prev] = Date.now();
        }
        if (state.parkedWorkspaceIds[id]) delete state.parkedWorkspaceIds[id];
        if (state.lastVisibleAt[id] !== undefined) delete state.lastVisibleAt[id];
      }
      state.activeWorkspaceId = id;
      clearRemoteSelection(state);
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
          if (n.workspaceId === id && !n.read) {
            n.read = true;
            // Keep the O(S) unread index in sync — bypassing it here left ghost
            // unread badges after visiting a workspace (Sprint-1 selector).
            // Guarded for tests that mount workspaceSlice without the index.
            if (n.surfaceId && state.unreadBySurfaceId) {
              decUnread(state.unreadBySurfaceId, n.surfaceId);
            }
          }
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
          for (const pid of collectLeafIds(activatedWs.rootPane)) {
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

    setWorkspaceColor: (id, color) => set((state: StoreState) => {
      const ws = state.workspaces.find((w: Workspace) => w.id === id);
      if (!ws) return;
      const normalized = normalizeWorkspaceColor(color);
      if (normalized) {
        ws.color = normalized;
      } else {
        delete ws.color;
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

      // Cold-park is renderer-only and non-persisted. loadSession replaces the
      // whole workspace list, so any parked/idle-clock entry keyed to an id no
      // longer in the new list would linger forever (the sweep only iterates
      // current workspaces). Reset both maps — the sweep re-derives park state
      // for the restored workspaces from scratch.
      state.parkedWorkspaceIds = {};
      state.lastVisibleAt = {};

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
          // 2026-07-20 워크스페이스 헤더 승격으로 페인 surface 폐지, 구 세션 정리:
          // git·review는 이제 페인 탭이 아니라 워크스페이스 헤더 탭+중앙 표면으로
          // 산다(surfaceType 유니온은 하위호환 위해 유지). 이미 저장된 세션에 남은
          // git/review surface를 여기서 걸러낸다 — 안 그러면 폐지된 렌더 분기가 없어
          // 빈 탭으로 남는다. activeSurfaceId가 걸러진 surface를 가리키면 재조정한다.
          const before = pane.surfaces;
          const filtered = before.filter(
            (s) => s.surfaceType !== 'git' && s.surfaceType !== 'review',
          );
          if (filtered.length !== before.length) {
            pane.surfaces = filtered;
            if (!filtered.some((s) => s.id === pane.activeSurfaceId)) {
              pane.activeSurfaceId = filtered[0]?.id ?? '';
            }
          }
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

      // ── Stashed panes (#977) ─────────────────────────────────────────────
      // session.json is user-editable and can come from a newer build, so the
      // array is validated entry by entry rather than trusted. A malformed
      // entry is DROPPED with a warning instead of failing the load: the whole
      // point of the feature is that a stashed pane is recoverable, and losing
      // the entire session over one bad row would be the opposite.
      for (const ws of data.workspaces) {
        const raw = (ws as { stashedPanes?: unknown }).stashedPanes;
        if (raw === undefined) continue;
        if (!Array.isArray(raw)) {
          console.warn(`[wmux:stash] dropping stashedPanes on ws=${ws.id}: not an array`);
          delete ws.stashedPanes;
          continue;
        }
        // Duplicate/collision guards (review). session.json is hand-editable:
        // a stashed id that ALSO lives in the visible tree would be reconciled
        // and rendered twice, and a duplicated ordinal makes two panes share an
        // auto-name — which is the A2A address. Duplicate ids are dropped (the
        // stash copy loses; the visible one is the one on screen), colliding
        // ordinals are reassigned past the workspace's high-water mark.
        const visibleLeaves = getLeafPanes(ws.rootPane);
        const visibleIds = new Set(visibleLeaves.map((l) => l.id));
        const seenStashIds = new Set<string>();
        const usedOrdinals = new Set<number>();
        let ordinalHigh = 0;
        for (const l of visibleLeaves) {
          if (typeof l.ordinal === 'number') {
            usedOrdinals.add(l.ordinal);
            if (l.ordinal > ordinalHigh) ordinalHigh = l.ordinal;
          }
        }
        const kept: StashedPane[] = [];
        for (const entry of raw as unknown[]) {
          const candidate = entry as Partial<StashedPane> | null;
          const pane = candidate?.pane as PaneLeaf | undefined;
          if (!pane || pane.type !== 'leaf' || typeof pane.id !== 'string' || !Array.isArray(pane.surfaces)) {
            console.warn(`[wmux:stash] dropping malformed stash entry on ws=${ws.id}`);
            continue;
          }
          if (pane.surfaces.length === 0) {
            // canStashPaneSurfaces refuses an empty pane at stash time for the
            // same reason this boundary must: the roster builds its row from a
            // surface, so an empty stashed pane is an unreachable ghost holding
            // an ordinal and a slot against the pane cap.
            console.warn(`[wmux:stash] dropping empty stash entry on ws=${ws.id} pane=${pane.id}`);
            continue;
          }
          if (visibleIds.has(pane.id) || seenStashIds.has(pane.id)) {
            console.warn(`[wmux:stash] dropping duplicate stash entry on ws=${ws.id} pane=${pane.id}`);
            continue;
          }
          seenStashIds.add(pane.id);
          if (typeof pane.ordinal === 'number' && usedOrdinals.has(pane.ordinal)) {
            const next = ordinalHigh + 1;
            console.warn(`[wmux:stash] reassigning colliding ordinal on ws=${ws.id} pane=${pane.id}: ${pane.ordinal} -> ${next}`);
            pane.ordinal = next;
          }
          if (typeof pane.ordinal === 'number') {
            usedOrdinals.add(pane.ordinal);
            if (pane.ordinal > ordinalHigh) ordinalHigh = pane.ordinal;
          }
          // The same pass the visible tree gets — a blocked browser URL scheme
          // or a retired git/review surface must not survive in the stash just
          // because it was off-screen when the rule landed.
          sanitizePanes(pane);
          // The origin is a HINT, not the pane. A malformed one costs the user
          // a placement ("next to the active pane" instead of "next to its
          // former neighbour"); dropping the whole entry over it would cost
          // them a running session. So it is validated separately and only it
          // is discarded.
          const origin = normalizeStashOrigin(candidate?.origin, ws.id, pane.id);
          kept.push({
            pane,
            ...(origin ? { origin } : {}),
            stashedAt: typeof candidate?.stashedAt === 'number' ? candidate.stashedAt : Date.now(),
          });
        }
        if (kept.length > 0) ws.stashedPanes = kept;
        else delete ws.stashedPanes;
      }

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

      // #1135: listening ports are a LIVE fact about running processes, never
      // a saved one. A session written while a dev server was up otherwise
      // restores its chip verbatim, and the daemon's PortWatcher never
      // contradicts it — its very first observation of an empty port set for a
      // session is deliberately a no-op ("nothing to clear"), so a stale chip
      // survived full app restarts. Drop it on load; the surfacePorts map that
      // feeds the union starts empty anyway.
      for (const ws of data.workspaces) {
        if (ws.metadata?.listeningPorts !== undefined) delete ws.metadata.listeningPorts;
      }

      state.workspaces = data.workspaces;
      // The previous session's group cannot describe this one's workspaces.
      pruneMultiviewMembership(state);
      state.activeWorkspaceId = data.activeWorkspaceId;
      clearRemoteSelection(state);
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
        // Workspace-wide (#977): a stashed pane holding the highest ordinal
        // would otherwise be invisible to the high-water recompute, and the
        // next split would reissue its number — two panes called `w1-4`, with
        // the auto name doubling as the A2A address.
        const wsLeaves = getWorkspaceLeafPanes(ws);
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

      // Color tags: session.json is user-editable and may come from a newer
      // build, so an unknown id is dropped rather than rendered. Dropping (not
      // rejecting the load) keeps a stray value from costing the user a session.
      for (const ws of state.workspaces) {
        const color = normalizeWorkspaceColor(ws.color);
        if (color) ws.color = color;
        else delete ws.color;
      }

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
      } else {
        // No locale in session.json: either a genuinely first-ever run, or a
        // session.json written before this field existed. Either way the
        // user has never made an explicit choice, so detect once from the
        // OS locale (falling back to English) rather than silently sitting
        // on the hardcoded 'en' default. A user who DOES pick a language in
        // Settings gets `data.locale` populated from then on (setLocale
        // writes it), so this branch never re-fires for them.
        // `typeof window` guard, not a bare reference: loadSession also runs
        // under node-environment suites (workspaceColor, workspaceProjections,
        // paneOrdinal, remoteWorkspacesSlice) where `window` does not exist at
        // all, so a bare read is a ReferenceError — the same reason the
        // preload half of this feature guards `typeof navigator`.
        const detected = detectSupportedLocale(
          (typeof window !== 'undefined' ? window.electronAPI?.systemLocale : undefined) ?? '',
        );
        state.locale = detected;
        i18nSetLocale(detected);
      }
      if (data.terminalFontSize != null) state.terminalFontSize = data.terminalFontSize;
      // UI scale: clamp on load so a hand-edited session.json (e.g. uiScale: 5)
      // can't leave the store, the Settings readout (Math.round(x*100)%), and
      // the next save diverging from what main actually applies — main's
      // applyUiZoom clamps the real zoom, but without this the stored/displayed
      // value drifts (5 → "500%" readout, re-saved as 5). Bounds mirror
      // UI_ZOOM_MIN/MAX in src/main/window/uiZoom.ts. Absent/invalid → default 1.
      if (typeof data.uiScale === 'number' && Number.isFinite(data.uiScale)) {
        state.uiScale = Math.min(1.6, Math.max(0.8, data.uiScale));
      }
      // Sanitize on load too — session.json is untrusted (hand-editable), and
      // this path bypasses setTerminalFontFamily's write-time sanitize. Keeps
      // the "stored value is always clean" invariant (terminalFont.ts) intact
      // so a poisoned font string can't round-trip back to disk or reach a CSS
      // sink that forgets to re-sanitize.
      if (data.terminalFontFamily) {
        state.terminalFontFamily = sanitizeFontFamily(data.terminalFontFamily) || 'Cascadia Code';
      }
      if (data.terminalCursorStyle !== undefined) {
        state.terminalCursorStyle = sanitizeTerminalCursorStyle(data.terminalCursorStyle);
      }
      if (data.defaultShell) state.defaultShell = data.defaultShell;
      if (typeof data.deckBrainModel === 'string') state.deckBrainModel = data.deckBrainModel;
      // D2 — re-normalize on load (session.json is hand-editable / untrusted).
      state.orchestratorRoleBindings = normalizeRoleBindings(data.orchestratorRoleBindings);
      // Fail closed to raw mode: only an explicit true enables full power.
      state.deckBrainFullPower = data.deckBrainFullPower === true;
      // Brain vendor. Fail closed to the default: only known ids are restored.
      //
      // The marker — not the value — decides whether a recorded 'claude' is a
      // CHOICE. AppLayout has always serialized deckBrainVendor unconditionally,
      // so "absent" describes no real install: every pre-migration session on
      // disk carries a literal 'claude' regardless of whether its user ever
      // opened Settings. Keying off the value alone would therefore pin the
      // entire existing install base to the SDK brain and leave the new default
      // reaching new profiles only.
      //
      // Pre-migration (no marker): 'claude' is read as the OLD DEFAULT and
      // upgraded once. 'hermes'/'claude-pty' were only ever reachable by an
      // explicit pick, so they are kept. Non-destructive — sessions are keyed
      // per vendor and nothing is cleared, so Settings restores the exact SDK
      // conversation. Post-migration: every recorded vendor is authoritative,
      // which is what lets a user pick the SDK brain back and keep it.
      const recordedVendor = data.deckBrainVendor;
      const explicitlyPicked = recordedVendor === 'hermes' || recordedVendor === 'claude-pty';
      // Strict boolean, like deckBrainFullPower above: session.json is
      // hand-editable, and a truthy non-boolean (`"false"`) would otherwise
      // pass as a migrated marker and lock a legacy 'claude' in as a choice.
      const alreadyMigrated = data.deckBrainVendorMigrated === true;
      state.deckBrainVendor = alreadyMigrated
        ? (recordedVendor === 'claude' || explicitlyPicked ? recordedVendor : 'claude-pty')
        : (explicitlyPicked ? recordedVendor : 'claude-pty');
      // Loading a session always leaves the profile migrated — the next save
      // records it, so the one-shot upgrade cannot run twice.
      state.deckBrainVendorMigrated = true;
      // Fail closed to hidden: only an explicit boolean shows the (frozen)
      // human channel UI.
      if (typeof data.channelsTabVisible === 'boolean') {
        state.channelsTabVisible = data.channelsTabVisible;
      }
      // Pane action cluster — default ON; only an explicit false hides it.
      if (typeof data.titlebarClockVisible === 'boolean') {
        state.titlebarClockVisible = data.titlebarClockVisible;
      }
      if (typeof data.paneActionsVisible === 'boolean') {
        state.paneActionsVisible = data.paneActionsVisible;
      }
      // Opt-in `+` — default OFF, so only an explicit true shows it. A session
      // written before this setting existed has no field, and must not be read
      // as consent to break one pane = one terminal.
      if (typeof data.paneNewTerminalButton === 'boolean') {
        state.paneNewTerminalButton = data.paneNewTerminalButton;
      }
      if (data.splitInheritsCwd != null) state.splitInheritsCwd = data.splitInheritsCwd;
      if (data.imeResidueGuardEnabled != null) state.imeResidueGuardEnabled = data.imeResidueGuardEnabled;
      // Fail closed: only an explicit boolean is applied. A corrupted /
      // hand-edited value (e.g. the string "false") must not toggle the
      // retention/resync path either way.
      // #517 — fail closed like the retention flag: only an explicit boolean.
      if (typeof data.browserLightweightMode === 'boolean') {
        state.browserLightweightMode = data.browserLightweightMode;
      }
      if (typeof data.browserDiscardHidden === 'boolean') {
        state.browserDiscardHidden = data.browserDiscardHidden;
      }
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
      // Cold-park (TASK-9): default ON; only an explicit persisted false opts out.
      if (typeof data.coldParkEnabled === 'boolean') state.coldParkEnabled = data.coldParkEnabled;
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
      // Whitelisted, not a bare truthiness check: a forward-version session file
      // that names a fourth arrangement must not park an unknown string in the
      // store, where the settings control would render with nothing selected.
      if (data.multiviewArrangement && MULTIVIEW_ARRANGEMENTS.includes(data.multiviewArrangement)) {
        state.multiviewArrangement = data.multiviewArrangement;
      }
      if (data.notificationSoundEnabled != null) state.notificationSoundEnabled = data.notificationSoundEnabled;
      // Whitelist + dedupe on the way in: a corrupted or forward-version
      // session file must not park unknown strings in the store, where the
      // Settings UI can't show them and every save writes them back out.
      // Copy rather than aliasing the caller's array (immer autoFreeze would
      // otherwise freeze the SessionData object the caller still holds).
      if (Array.isArray(data.mutedNotificationCategories)) {
        state.mutedNotificationCategories = [
          ...new Set(
            data.mutedNotificationCategories.filter((c) => NOTIFICATION_CATEGORIES.includes(c)),
          ),
        ];
        window.electronAPI.settings.setMutedNotificationCategories(
          state.mutedNotificationCategories,
        );
      }
      if (data.toastEnabled != null) {
        state.toastEnabled = data.toastEnabled;
        window.electronAPI.settings.setToastEnabled(data.toastEnabled);
      }
      if (data.notificationRingEnabled != null) state.notificationRingEnabled = data.notificationRingEnabled;
      if (typeof data.anthropicUsageEnabled === 'boolean') {
        state.anthropicUsageEnabled = data.anthropicUsageEnabled;
        window.electronAPI.usage.setEnabled(data.anthropicUsageEnabled);
      }
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
        // 손 안 댄 원본 F7/Ctrl+F7 기본값을 현재 플랫폼 기본 키(Mac=Ctrl+7)로 1회 승격.
        // macOS 미디어 키(F7)·시스템 단축키(^F7)에 먹혀 안 뜨던 바인딩을 실제로 고친다.
        const migrated = upgradeDefaultKeybindingsForPlatform(data.customKeybindings, platform);
        const savedIds = new Set(migrated.map((k) => k.id));
        const savedKeys = new Set(migrated.map((k) => k.key));
        // 플랫폼별 기본값으로 백필 — Mac은 Ctrl+7, 그 외 F7. 저장된 기본값은
        // id/key 매칭에 걸려 아래 filter에서 제외되므로 중복 추가되지 않는다.
        const missingDefaults = buildDefaultCustomKeybindings(platform).filter(
          (k) => !savedIds.has(k.id) && !savedKeys.has(k.key),
        );
        state.customKeybindings = [...migrated, ...missingDefaults.map((k) => ({ ...k }))];
      }
      if (Array.isArray(data.disabledShortcuts)) {
        // #1152 — whitelist against the ADVERTISED rows only, not the whole
        // keymap: only advertised rows render a re-enable toggle, so an
        // unadvertised combo (Ctrl+B prefix, Ctrl+Tab, …) planted by a
        // hand-edited or future-version session would be OFF with no way
        // back short of editing session.json.
        const known = new Set(ADVERTISED_SHORTCUTS.map((k) => k.combo));
        state.disabledShortcuts = data.disabledShortcuts.filter(
          (c): c is string => typeof c === 'string' && known.has(c),
        );
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
      // Typed, not just non-null: session.json is hand-editable, and `"false"`
      // or `{}` would pin the bar open with no way to read why.
      if (typeof data.agentToolbarPinned === 'boolean') {
        state.agentToolbarPinned = data.agentToolbarPinned;
      }
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
    clearSurfacePtyIdByPty: (ptyId: string, recovery?: DeadPaneRecovery) => set((state: StoreState) => {
      if (!ptyId) return;
      const walk = (pane: PaneLeaf, stashed: boolean) => {
        {
          for (const s of pane.surfaces) {
            // 유틸 surface(git·review)는 pty 없음 — 명시적으로 제외해 방어.
            if (s.ptyId === ptyId && s.surfaceType !== 'browser' && s.surfaceType !== 'editor' && s.surfaceType !== 'diff' && s.surfaceType !== 'git' && s.surfaceType !== 'review') {
              const previousOffer = state.deadPaneRecoveryOfferByPtyId?.[ptyId];
              if ((recovery || previousOffer) && state.pendingDeadPaneRecoveryBySurfaceId) {
                state.pendingDeadPaneRecoveryBySurfaceId[s.id] = mergeDeadPaneRecovery(
                  state.pendingDeadPaneRecoveryBySurfaceId[s.id] ?? previousOffer,
                  recovery ?? {},
                );
              }
              if (previousOffer) {
                delete state.deadPaneRecoveryOfferByPtyId[ptyId];
                delete state.resumeHintByPtyId[ptyId];
                delete state.resumeBindingByPtyId[ptyId];
              }
              s.ptyId = '';
              // #977 — a stashed pane's liveness is DERIVED from its surfaces'
              // ptyIds, so this clear IS the alive→exited transition. Log it:
              // the pane is off-screen, so without this line the only trace of
              // a stashed agent dying is a roster label nobody was watching.
              if (stashed && stashedPaneLiveness(pane) === 'exited') {
                console.warn(`[wmux:stash] stashed pane=${pane.id} is now exited (last terminal pty ${ptyId} confirmed gone)`);
              }
            }
          }
        }
      };
      for (const ws of state.workspaces) {
        // Workspace-wide (#977): reconcile can name a stashed pane's ptyId, and
        // a visible-tree-only clear would leave it bound to a session the
        // daemon has already confirmed dead.
        const visibleIds = new Set(getLeafPanes(ws.rootPane).map((l) => l.id));
        for (const leaf of getWorkspaceLeafPanes(ws)) walk(leaf, !visibleIds.has(leaf.id));
      }
    }),

    clearAllPtyState: () => set((state: StoreState) => {
      // 1. Terminal surface ptyId across all workspaces + nested split panes.
      const clearLeafPtyIds = (pane: PaneLeaf) => {
        for (const s of pane.surfaces) {
          // 유틸 surface(git·review)는 pty 없음 — 명시적으로 제외해 방어.
          if (s.surfaceType !== 'browser' && s.surfaceType !== 'editor' && s.surfaceType !== 'diff' && s.surfaceType !== 'git' && s.surfaceType !== 'review') {
            s.ptyId = '';
          }
        }
      };
      // Workspace-wide (#977): this is the "we could not reconcile anything"
      // fallback, so leaving stashed panes bound to ptyIds we just declared
      // untrustworthy would make them the ONLY surfaces still claiming a live
      // session.
      for (const ws of state.workspaces) {
        for (const leaf of getWorkspaceLeafPanes(ws)) clearLeafPtyIds(leaf);
      }

      // 2. uiSlice fields (cross-slice mutation within the same immer set).
      state.floatingPanePtyId = null;
      state.terminalBookmarks = {};
      // X1 per-surface port map is ptyId-keyed — same wipe contract.
      if (state.surfacePorts) state.surfacePorts = {};
      // #1135: the workspace chip is a union over that map — wipe it with it.
      for (const ws of state.workspaces) {
        if (ws.metadata?.listeningPorts !== undefined) delete ws.metadata.listeningPorts;
      }
      if (state.pendingDeadPaneRecoveryBySurfaceId) state.pendingDeadPaneRecoveryBySurfaceId = {};
      if (state.deadPaneRecoveryOfferByPtyId) state.deadPaneRecoveryOfferByPtyId = {};

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
