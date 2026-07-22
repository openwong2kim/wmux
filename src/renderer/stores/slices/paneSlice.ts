import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { Pane, PaneLeaf, PaneBranch, Workspace, AgentStatus } from '../../../shared/types';
import type { AgentSlug } from '../../../shared/events';
import {
  createLeafPane,
  generateId,
} from '../../../shared/types';
import {
  publishPaneCreated,
  publishPaneClosed,
  publishPaneFocused,
} from '../../events/publisher';
import { t } from '../../i18n';
import { clearNudgesFor } from '../../hooks/channelMentionRateLimit';
import { panePrincipalId } from '../../../shared/principals';
import { computePaneAutoName } from '../../utils/paneNaming';

// Per-workspace leaf cap. xterm.js + node-pty memory scales linearly with
// pane count, and the project memory budget targets ~200 MB for 10 panes
// (TODOS.md "Pane split max depth/count guard"). 20 leaves keeps a runaway
// shortcut spam (Ctrl+D held, scripted splits, etc.) from exhausting RAM
// while still being far more than any sane manual layout needs.
export const MAX_PANES_PER_WORKSPACE = 20;

// M0-d: paneSlice is a read-only mirror for PaneLeaf.metadata. The
// authoritative writer is MetadataStore in the main process (M0-a + M0-b).
// `setPaneMetadata` / `getPaneMetadata` / `clearPaneMetadata` are intentionally
// *not* exposed here so no renderer code path can bypass the store. The
// `PaneLeaf.metadata` field remains on the shared type so UI components can
// read it directly (and so SessionManager hydration can populate it).
export interface PaneSlice {
  /**
   * Split a leaf pane into a new horizontal/vertical branch.
   * Returns the new pane's id on success, or `false` if the workspace is
   * at MAX_PANES_PER_WORKSPACE. Callers chaining `addBrowserSurface`, RPC
   * handlers, etc. must abort on `false` so they don't mutate the
   * still-active original pane; the returned id is the exact new leaf,
   * which for a BACKGROUND-workspace split is NOT `activePaneId` (focus
   * scoping #236 leaves the active selection untouched).
   */
  splitPane: (paneId: string, direction: 'horizontal' | 'vertical', workspaceId?: string, position?: 'before' | 'after') => string | false;
  /** Close a leaf pane. `workspaceId` lets RPC/CLI callers target a
   * non-active workspace (defaults to the active one — existing callers are
   * unchanged). */
  closePane: (paneId: string, workspaceId?: string) => void;
  setActivePane: (paneId: string) => void;
  /**
   * Focus a leaf pane (and optionally one of its surfaces) in an EXPLICIT
   * workspace — the address-resolution counterpart to `setActivePane`, used by
   * the `pane.focus` / `surface.focus` RPC so an external agent that owns a
   * BACKGROUND workspace can focus its own pane without the active-workspace
   * scoping `setActivePane` enforces.
   *
   * Resolves `workspaceId` exactly (no self-search, no `activeWorkspaceId`
   * fallback) and NEVER mutates `activeWorkspaceId` — bringing a workspace
   * on-screen is the separate `workspace.focus` RPC, so this is inherently
   * non-yank. Sets `activePaneId` and (when `surfaceId` is supplied and present
   * on the leaf) `activeSurfaceId` in ONE transaction. Emits `pane.focused`
   * when — and only when — the active pane actually changed (a surface-only
   * change on the already-active pane does not, since `pane.focused` is a pane
   * event); the emit is NOT gated on `activeWorkspaceId`, so a real focus change
   * in a background/multiview workspace is reported honestly.
   *
   * Returns `false` (no mutation, no emit) when the workspace is unknown or the
   * pane is missing / not a leaf (a branch); `true` otherwise.
   */
  focusPaneSurface: (workspaceId: string, paneId: string, surfaceId?: string) => boolean;
  focusPaneDirection: (direction: 'up' | 'down' | 'left' | 'right') => void;
  cyclePane: (direction: 'next' | 'prev') => void;
  updatePaneSizes: (branchId: string, sizes: number[]) => void;
  resizeActivePane: (direction: 'left' | 'right' | 'up' | 'down', amount: number) => void;
  equalizePaneSizes: () => void;
  // Sparse map of per-pane visual notification rings. Missing entry = no ring.
  // T11 will consume this for the flash→glow CSS treatment around each pane.
  paneNotificationRing: Record<string, 'flash' | 'glow'>;
  setPaneNotificationRing: (paneId: string, ring: 'flash' | 'glow' | null) => void;
  // B8: per-surface agent lifecycle status keyed by ptyId. Only the
  // "needs attention" statuses (complete / waiting / awaiting_input) are
  // retained; running / idle / error / null all clear the entry. Drives the
  // "completed terminal" blink on inactive panes (Pane.tsx) and the per-tab
  // status dot (SurfaceTabs). Populated from METADATA_UPDATE in
  // useNotificationListener; cleared when the owning pane is focused or the
  // agent resumes / the PTY exits (PTYBridge broadcasts running/idle).
  surfaceAgentStatus: Record<string, AgentStatus>;
  setSurfaceAgentStatus: (ptyId: string, status: AgentStatus | null) => void;
  // Part A — per-surface agent IDENTITY keyed by ptyId. Distinct from
  // surfaceAgentStatus (attention-only, clears on idle): this retains the
  // detected agent name + last status for the life of the PTY so a2a_discover /
  // surface_list / pane_list can label each pane individually — one workspace
  // can host >1 agent (gaps 1/3/8). Populated from METADATA_UPDATE in
  // useNotificationListener; cleared when the owning surface/pane closes.
  // Transient — never persisted (buildSessionData allowlist excludes it).
  surfaceAgent: Record<string, { name: string; status: AgentStatus; slug?: AgentSlug }>;
  setSurfaceAgent: (ptyId: string, name: string | undefined, status: AgentStatus | undefined, slug?: AgentSlug) => void;
  clearSurfaceAgent: (ptyId: string) => void;
  // P2 — per-pane user label (rename) mirror, keyed by paneId. Volatile and
  // never persisted (buildSessionData allowlist excludes it; MetadataStore /
  // metadata.json is the durable source). Fed by the pane.metadata.changed
  // relay (METADATA_UPDATE.paneLabel) + a one-shot boot snapshot. The pane's
  // displayName = paneLabel[paneId] ?? autoName.
  paneLabel: Record<string, string>;
  setPaneLabel: (paneId: string, label: string | undefined) => void;
  // Orchestrator pane role (operator-assigned "preferred role") mirror, keyed
  // by paneId. Same volatile/never-persisted contract as paneLabel: fed by the
  // pane.metadata.changed relay (METADATA_UPDATE.paneRole) + the boot snapshot.
  // MetadataStore/metadata.json (custom['orchestrator.role']) is the durable
  // source; this mirror only feeds the Fleet dropdown + the orchestrator's
  // per-turn workspace snapshot (deckBrain.buildWorkspaceContextSummary).
  paneRole: Record<string, string>;
  setPaneRole: (paneId: string, role: string | undefined) => void;
  // X1: per-surface listening ports keyed by ptyId. Main emits ports per PTY
  // (PID-tree scoped); the workspace-level sidebar value is the UNION over
  // the workspace's surfaces, computed at write time in
  // useNotificationListener. Without this map, multi-pane workspaces
  // last-writer-win on metadata.listeningPorts and the sidebar flickers
  // (pane A's [8123] erased by pane B's [] on every poll tick). Transient —
  // never persisted (buildSessionData allowlist excludes it).
  surfacePorts: Record<string, number[]>;
  setSurfacePorts: (ptyId: string, ports: number[] | null) => void;
  // Fleet View per-pane ACTIVITY line keyed by ptyId (fleet-activity-line-hook).
  // The string is derived + sanitized + throttled in the MAIN process
  // (hooks.rpc summarizeActivity, 3s leading-edge per-ptyId) and arrives on
  // METADATA_UPDATE.activity; the renderer only stores + renders it — never
  // re-throttles, never re-sanitizes. Kept across Stop so a finished card still
  // reads "✎ fleet.ts" rather than blank; cleared at the two real surface
  // teardown sites (closePane here + closeSurface). Transient — never persisted
  // (buildSessionData is an allowlist and deliberately omits it).
  surfaceActivity: Record<string, string>;
  setSurfaceActivity: (ptyId: string, activity: string | null) => void;
  // Per-surface "this agent ended its turn asking something" text, keyed by
  // ptyId. Populated from METADATA_UPDATE.pendingQuestion, which main derives
  // from the Stop hook's transcript — not from the rendered terminal, where a
  // printed question is indistinguishable from a line pending in the input box.
  // Every stop writes it, so a stop that asks nothing clears a stale question.
  // Read by pane.list so an orchestrator can tell "finished" from "blocked".
  // Transient — never persisted (buildSessionData allowlist excludes it).
  surfacePendingQuestion: Record<string, string>;
  setSurfacePendingQuestion: (ptyId: string, question: string | null) => void;
  // Stamp the "running" freshness clock for a pane WITHOUT an activity string —
  // the byte-based per-PTY 'running' broadcast has no tool name. Same 120s-TTL
  // decay as setSurfaceActivity's stamp; lights background dots from bytes.
  markSurfaceRunning: (ptyId: string) => void;
  // "running" freshness (orca-style): epoch-ms of each pane's last activity
  // signal. The fleet selector treats a fresh stamp (within HOOK_RUNNING_TTL_MS)
  // as 'running' even when the terminal has gone quiet — so an agent thinking
  // mid-turn (no output) is not misread as idle by the 5s byte-silence path,
  // AND a BACKGROUND pane (no ws-metadata status) lights its dot.
  //
  // Sources (2026-07-13): the DAEMON's byte-based per-PTY 'running' broadcast
  // (ActivityMonitor onActive → DaemonNotificationRouter → METADATA_UPDATE.
  // agentStatus='running' → markSurfaceRunning) is the primary source; this
  // replaced the per-tool-call PostToolUse hook (which spawned a ~110ms node
  // bridge on EVERY tool call). An agent that still emits PostToolUse also
  // stamps this via setSurfaceActivity (which carries the activity string too).
  // Cleared with the activity string (pane disposal); byte-'running' has no
  // string, so it stamps the timestamp only (markSurfaceRunning).
  surfaceActivityAt: Record<string, number>;
  // A coarse clock the status derivation re-reads so a fresh stamp DECAYS to
  // idle on its own with no new store event. Bumped ~every 2s by
  // useAgentActivityClock while any pane is recently active; membership in
  // state (not a raw Date.now() in the selector) keeps selectFleetPanes pure.
  agentClockMs: number;
  bumpAgentClock: () => void;
  // Last raw PTY output per surface, throttled at the useTerminal IPC seam
  // (~30 s). Deliberately SEPARATE from surfaceActivityAt: that map feeds the
  // fleet hook-'running' derivation, and folding plain shell bytes into it
  // would light status dots amber for a `ls` in a quiet pane. Only the sidebar
  // idle badge reads this (max with surfaceActivityAt). Transient — never
  // persisted; cleared on the same surface-teardown paths as surfaceActivity.
  surfaceOutputAt: Record<string, number>;
  stampSurfaceOutput: (ptyId: string) => void;
  // Issue #173: transient map of pane id → cwd inherited from the pane that
  // was split. Written by splitPane, consumed (and cleared) by the AppLayout
  // empty-leaf PTY funnel. Deliberately NOT persisted — buildSessionData's
  // allowlist never includes it, so a saved session can't replay stale seeds.
  splitCwdSeed: Record<string, string>;
  clearSplitCwdSeed: (paneId: string) => void;
}

// The agent statuses that mean "this terminal wants the user's attention"
// (the work finished or is paused waiting for input). Anything else clears.
const ATTENTION_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'complete',
  'waiting',
  'awaiting_input',
]);

function findPane(root: Pane, id: string): Pane | null {
  if (root.id === id) return root;
  if (root.type === 'branch') {
    for (const child of root.children) {
      const found = findPane(child, id);
      if (found) return found;
    }
  }
  return null;
}

function findParent(root: Pane, id: string): PaneBranch | null {
  if (root.type === 'branch') {
    for (const child of root.children) {
      if (child.id === id) return root;
      const found = findParent(child, id);
      if (found) return found;
    }
  }
  return null;
}

function collectLeafIds(pane: Pane): string[] {
  if (pane.type === 'leaf') return [pane.id];
  return pane.children.flatMap(collectLeafIds);
}

function getLeafPanes(root: Pane): PaneLeaf[] {
  if (root.type === 'leaf') return [root];
  return root.children.flatMap(getLeafPanes);
}

export const createPaneSlice: StateCreator<StoreState, [['zustand/immer', never]], [], PaneSlice> = (set, get) => ({
  paneNotificationRing: {},

  setPaneNotificationRing: (paneId, ring) => set((state: StoreState) => {
    if (ring === null) {
      delete state.paneNotificationRing[paneId];
      return;
    }
    state.paneNotificationRing[paneId] = ring;
  }),

  surfaceAgentStatus: {},

  setSurfaceAgentStatus: (ptyId, status) => set((state: StoreState) => {
    if (!ptyId) return;
    // Store only attention-worthy statuses; everything else (running, idle,
    // error, null) clears the entry so the blink stops as soon as the agent
    // resumes, goes idle, or the PTY exits.
    if (status && ATTENTION_STATUSES.has(status)) {
      state.surfaceAgentStatus[ptyId] = status;
    } else {
      delete state.surfaceAgentStatus[ptyId];
    }
  }),

  surfaceAgent: {},

  setSurfaceAgent: (ptyId, name, status, slug) => set((state: StoreState) => {
    if (!ptyId) return;
    const existing = state.surfaceAgent[ptyId];
    // Never overwrite a known agent name with an empty one. PTYBridge's
    // ActivityMonitor 'running' broadcasts carry agentName = getLastAgent() ??
    // '' which is '' until a gate matches; a status-only update must keep the
    // already-detected name. If no name is known yet, there is nothing to stamp.
    const resolvedName = name && name.length > 0 ? name : existing?.name;
    if (!resolvedName) return;
    // P2: same retention rule for the slug — a status-only update keeps the
    // previously-detected slug so the `(<agent>)` auto-name suffix is stable.
    const resolvedSlug = slug ?? existing?.slug;
    state.surfaceAgent[ptyId] = {
      name: resolvedName,
      status: status ?? existing?.status ?? 'running',
      ...(resolvedSlug ? { slug: resolvedSlug } : {}),
    };
  }),

  clearSurfaceAgent: (ptyId) => set((state: StoreState) => {
    if (!ptyId) return;
    delete state.surfaceAgent[ptyId];
  }),

  paneLabel: {},

  setPaneLabel: (paneId, label) => set((state: StoreState) => {
    if (!paneId) return;
    const trimmed = label?.trim();
    if (trimmed && trimmed.length > 0) {
      state.paneLabel[paneId] = trimmed;
    } else {
      // Empty/whitespace/undefined clears the entry (rename-to-empty, clear,
      // or the onPaneDeleted tombstone relayed as paneLabel='').
      delete state.paneLabel[paneId];
    }
  }),

  paneRole: {},

  setPaneRole: (paneId, role) => set((state: StoreState) => {
    if (!paneId) return;
    const trimmed = role?.trim();
    if (trimmed && trimmed.length > 0) {
      state.paneRole[paneId] = trimmed;
    } else {
      // Empty/whitespace/undefined clears the entry (unassigned sentinel or
      // the onPaneDeleted tombstone relayed as paneRole='').
      delete state.paneRole[paneId];
    }
  }),

  surfacePorts: {},

  setSurfacePorts: (ptyId, ports) => set((state: StoreState) => {
    if (!ptyId) return;
    if (ports && ports.length > 0) {
      state.surfacePorts[ptyId] = ports;
    } else {
      delete state.surfacePorts[ptyId];
    }
  }),

  surfaceActivity: {},
  surfaceActivityAt: {},
  surfacePendingQuestion: {},
  agentClockMs: Date.now(),

  bumpAgentClock: () => set((state: StoreState) => {
    state.agentClockMs = Date.now();
  }),

  setSurfaceActivity: (ptyId, activity) => set((state: StoreState) => {
    if (!ptyId) return;
    // The main side already sanitized + truncated the string; here we only
    // store a non-empty value and clear on null/empty. A same-string write
    // keeps the existing reference (immer), so React shallow-compares it away.
    if (activity) {
      state.surfaceActivity[ptyId] = activity;
      // The agent is demonstrably working again, so any question it was
      // blocked on has been answered. Without this the two fields disagree
      // exactly when a cross-pane orchestrator is most likely to read them:
      // "running" and "blocked on a question" at the same time, until the
      // NEXT stop finally clears it.
      delete state.surfacePendingQuestion[ptyId];
      // Stamp the arrival time for the hook-driven 'running' derivation. Always
      // updated (even on a same-string tool repeat) so the freshness window
      // tracks the LATEST tool, not the first.
      state.surfaceActivityAt[ptyId] = Date.now();
    } else {
      delete state.surfaceActivity[ptyId];
      delete state.surfaceActivityAt[ptyId];
    }
  }),

  setSurfacePendingQuestion: (ptyId, question) => set((state: StoreState) => {
    if (!ptyId) return;
    // Main already truncated the text. Empty/null clears — every stop writes
    // this field, so an answered pane drops its question on its next turn end.
    if (question) state.surfacePendingQuestion[ptyId] = question;
    else delete state.surfacePendingQuestion[ptyId];
  }),

  markSurfaceRunning: (ptyId) => set((state: StoreState) => {
    if (!ptyId) return;
    // Byte-based 'running' with no tool name: stamp only the freshness clock,
    // NOT the activity string (leave the card's raw-tail fallback in place).
    state.surfaceActivityAt[ptyId] = Date.now();
    // Bytes are moving in this pane — it is not sitting on an unanswered
    // question. Same reasoning as setSurfaceActivity; this is the path that
    // covers agents with no tool hooks at all.
    delete state.surfacePendingQuestion[ptyId];
  }),

  surfaceOutputAt: {},

  stampSurfaceOutput: (ptyId) => set((state: StoreState) => {
    if (!ptyId) return;
    state.surfaceOutputAt[ptyId] = Date.now();
  }),

  splitCwdSeed: {},

  clearSplitCwdSeed: (paneId) => set((state: StoreState) => {
    delete state.splitCwdSeed[paneId];
  }),

  splitPane: (paneId, direction, workspaceId, position = 'after') => {
    let event: { wsId: string; newPaneId: string; branchId: string; previousActiveId: string; focusMoved: boolean } | null = null;
    let blockedAtCap = false;
    let createdPaneId: string | false = false;
    set((state: StoreState) => {
      const targetWsId = workspaceId || state.activeWorkspaceId;
      const ws = state.workspaces.find((w: Workspace) => w.id === targetWsId);
      if (!ws) return;

      const targetPane = findPane(ws.rootPane, paneId);
      if (!targetPane || targetPane.type !== 'leaf') return;

      // Cap leaf growth — every callsite (Ctrl+D, prefix-mode split, palette,
      // browser-pane shortcut, sample-task wizard) funnels through here, so a
      // single guard is enough.
      if (collectLeafIds(ws.rootPane).length >= MAX_PANES_PER_WORKSPACE) {
        blockedAtCap = true;
        return;
      }

      // Issue #173: capture the splitting pane's live cwd (OSC 7-tracked on
      // its active surface) so the new pane's PTY can start there. Browser /
      // editor surfaces have no shell cwd to inherit; surfaces that never
      // emitted OSC 7 have cwd '' — both fall through to the startup-directory
      // chain in the AppLayout funnel.
      const srcSurface = targetPane.surfaces.find((s) => s.id === targetPane.activeSurfaceId);
      const inheritedCwd =
        srcSurface && (srcSurface.surfaceType ?? 'terminal') === 'terminal' && srcSurface.cwd
          ? srcSurface.cwd
          : undefined;

      // P2: assign the next monotonic per-workspace ordinal from the high-water
      // counter so a re-split after a close never recycles a number (the
      // ★critical stability property). Fallback (a pre-P2 ws not yet backfilled
      // by loadSession) derives the high-water from live leaves WITHOUT
      // renumbering the existing tree, so live panes keep their names.
      const paneOrdinal =
        ws.nextPaneOrdinal ??
        (getLeafPanes(ws.rootPane).reduce((m, l) => Math.max(m, l.ordinal ?? 0), 0) + 1);
      const newPane = createLeafPane(undefined, paneOrdinal);
      createdPaneId = newPane.id;
      ws.nextPaneOrdinal = paneOrdinal + 1;
      // `position` drives 4-way directional split from Ctrl+Shift+Arrow:
      // 'before' puts the new pane left/up of the target, 'after' (default)
      // right/down. Left/Up → before, Right/Down → after.
      const branch: PaneBranch = {
        id: generateId('pane'),
        type: 'branch',
        direction,
        children: position === 'before' ? [newPane, { ...targetPane }] : [{ ...targetPane }, newPane],
        sizes: [50, 50],
      };

      // Replace target with branch
      const parent = findParent(ws.rootPane, paneId);
      if (parent) {
        const idx = parent.children.findIndex((c) => c.id === paneId);
        if (idx !== -1) {
          parent.children[idx] = branch;
        }
      } else {
        // Target is the root
        ws.rootPane = branch;
      }

      const previousActiveId = ws.activePaneId;
      // Focus-scoping (#236): only move the active selection + emit pane.focused
      // when the split targets the GLOBALLY-active workspace. A background-ws
      // split (an external agent owns ws B while the user looks at ws A) must
      // NOT hijack ws A's focus or fire a focus event for a pane the user can't
      // see. The pane.created emit and the splitCwdSeed write below stay
      // UNCONDITIONAL — the pane really was created, and its PTY (the AppLayout
      // funnel, or the eager-spawn in the pane.split RPC handler) needs the
      // inherited cwd regardless of which workspace is active.
      const isActiveWsSplit = targetWsId === state.activeWorkspaceId;
      if (isActiveWsSplit) {
        ws.activePaneId = newPane.id;

        // Issue #182: splitting while a pane in this workspace is zoomed must
        // un-zoom (tmux behavior) — otherwise the freshly created sibling would
        // be born hidden behind the zoom and look like the split did nothing.
        // zoomedPaneId is a single global view-state field that only ever holds
        // a pane in the active workspace, so gating it here is correct.
        if (state.zoomedPaneId !== null && findPane(ws.rootPane, state.zoomedPaneId)) {
          state.zoomedPaneId = null;
        }
      }

      if (inheritedCwd) state.splitCwdSeed[newPane.id] = inheritedCwd;

      event = {
        wsId: targetWsId,
        newPaneId: newPane.id,
        branchId: branch.id,
        previousActiveId,
        focusMoved: isActiveWsSplit,
      };
    });
    if (event) {
      const e = event as { wsId: string; newPaneId: string; branchId: string; previousActiveId: string; focusMoved: boolean };
      publishPaneCreated(e.wsId, e.newPaneId, e.branchId);
      // pane.focused only when the active selection actually moved (active-ws
      // split). A background split leaves the active ws's activePaneId
      // untouched, so emitting a focus event would misreport the user's current
      // pane to external EventBus pollers.
      if (e.focusMoved && e.previousActiveId !== e.newPaneId) {
        publishPaneFocused(e.wsId, e.newPaneId, e.previousActiveId);
      }
    }
    if (blockedAtCap) {
      // Toast emitted outside the immer producer so the slice doesn't recurse
      // into another set() while the producer is still running.
      get().pushToast({
        message: t('pane.maxLeavesReached', { count: MAX_PANES_PER_WORKSPACE }),
        level: 'warn',
      });
    }
    return createdPaneId;
  },

  closePane: (paneId, workspaceId) => {
    let event: { wsId: string; closedPaneId: string; previousActiveId: string; newActiveId: string | null } | null = null;
    // R2: snapshot the principal coordinates of live agent panes in the closing
    // subtree outside the transaction — they must be collected before set()
    // clears surfaceAgent. Capture autoName too (review I5): legacy rows that
    // self-joined via MCP channel_join have no principalId, so principal matching
    // cannot sweep them — a (workspaceId, memberId=autoName) auxiliary purge
    // cleans those rows too. autoName is unique for a pane's lifetime (ordinals
    // are not reused), so there is no collateral purge.
    const principalTargets: { wsId: string; principalId: string; autoName: string }[] = [];
    {
      const s = get();
      const wsSnap = s.workspaces.find((w: Workspace) => w.id === (workspaceId || s.activeWorkspaceId));
      const parentSnap = wsSnap ? findParent(wsSnap.rootPane, paneId) : null;
      const subtree = parentSnap?.children.find((c) => c.id === paneId);
      if (wsSnap && subtree) {
        for (const leaf of getLeafPanes(subtree)) {
          const agentSurface = leaf.surfaces.find(
            (sf) => sf.surfaceType !== 'browser' && !!sf.ptyId && !!s.surfaceAgent[sf.ptyId]?.name,
          );
          if (agentSurface) {
            principalTargets.push({
              wsId: wsSnap.id,
              principalId: panePrincipalId(wsSnap.id, leaf.id),
              autoName: computePaneAutoName(
                wsSnap.wsOrdinal ?? 0,
                leaf.ordinal ?? 0,
                s.surfaceAgent[agentSurface.ptyId]?.slug,
              ),
            });
          }
        }
      }
    }
    set((state: StoreState) => {
      const ws = state.workspaces.find((w: Workspace) => w.id === (workspaceId || state.activeWorkspaceId));
      if (!ws) return;

      const parent = findParent(ws.rootPane, paneId);
      if (!parent) {
        // Can't close root pane, but can clear its surfaces
        return;
      }

      const idx = parent.children.findIndex((c) => c.id === paneId);
      if (idx === -1) return;

      // Part A: drop per-surface agent identity for every surface under the
      // closing subtree (leaf or branch) so the surfaceAgent map doesn't leak
      // entries for PTYs that no longer have a surface. The Fleet activity line
      // is keyed the same way and is one of the two REAL teardown sites (the
      // other is closeSurface) — clear it here too so a closed pane's last
      // activity string can't linger on a re-used ptyId.
      for (const leaf of getLeafPanes(parent.children[idx])) {
        // P2: drop the closed pane's label mirror immediately. The main-side
        // onPaneDeleted relay also clears it, but this keeps the renderer
        // consistent without waiting for the round-trip.
        delete state.paneLabel[leaf.id];
        // Drop the orchestrator-role mirror on the same teardown (mirrors label).
        delete state.paneRole[leaf.id];
        for (const s of leaf.surfaces) {
          if (s.ptyId) {
            delete state.surfaceAgent[s.ptyId];
            delete state.surfaceActivity[s.ptyId];
            delete state.surfacePendingQuestion[s.ptyId];
            delete state.surfaceActivityAt[s.ptyId];
            delete state.surfaceOutputAt[s.ptyId];
            clearNudgesFor(s.ptyId); // A5: don't let a reused ptyId inherit this pane's nudge cap
            // J3 F4: onExhausted 매핑도 이 ptyId 소멸과 함께 evict.
            if (state.taskPtyRegistry) delete state.taskPtyRegistry[s.ptyId];
          }
        }
      }

      const previousActiveId = ws.activePaneId;
      parent.children.splice(idx, 1);

      if (parent.children.length === 1) {
        // Collapse: replace parent with the remaining child
        const remaining = parent.children[0];
        const grandParent = findParent(ws.rootPane, parent.id);
        if (grandParent) {
          const parentIdx = grandParent.children.findIndex((c) => c.id === parent.id);
          if (parentIdx !== -1) {
            grandParent.children[parentIdx] = remaining;
          }
        } else {
          // Parent was root
          ws.rootPane = remaining;
        }
      }

      // Update active pane
      const leaves = getLeafPanes(ws.rootPane);
      if (leaves.length > 0 && !leaves.some((l) => l.id === ws.activePaneId)) {
        ws.activePaneId = leaves[0].id;
      }

      // CEO A7: drop ring state for the deleted pane so a re-used paneId (or stale
      // selector) can't render a phantom ring on a pane that no longer exists.
      delete state.paneNotificationRing[paneId];
      // A pane closed before its PTY spawned would leave a dangling cwd seed.
      delete state.splitCwdSeed[paneId];
      // Issue #182: closing the zoomed pane ends the zoom; a stale id would
      // make the next toggle on another pane read as an un-zoom.
      if (state.zoomedPaneId === paneId) {
        state.zoomedPaneId = null;
      }

      event = {
        wsId: ws.id,
        closedPaneId: paneId,
        previousActiveId,
        newActiveId: ws.activePaneId !== previousActiveId ? ws.activePaneId : null,
      };
    });
    if (event) {
      const e = event as { wsId: string; closedPaneId: string; previousActiveId: string; newActiveId: string | null };
      publishPaneClosed(e.wsId, e.closedPaneId);
      if (e.newActiveId) {
        publishPaneFocused(e.wsId, e.newActiveId, e.previousActiveId);
      }
      // R2: clean up the closed pane's channel member rows + principal. Only
      // when there is an event — if the set() guards (root pane, nonexistent id)
      // fired, nothing was actually closed. Matching on the canonical coordinate
      // (principalId) makes it immune to auto-name drift.
      // Optional call: the minimal test store has no channels slice.
      for (const t of principalTargets) {
        void get().purgeMembershipDaemon?.({ workspaceId: t.wsId, principalId: t.principalId });
        // Review I5: auxiliary cleanup for legacy rows (no principalId) — matched by autoName memberId.
        void get().purgeMembershipDaemon?.({ workspaceId: t.wsId, memberId: t.autoName });
        void get().principalRemoveDaemon?.(t.principalId);
      }
    }
  },

  setActivePane: (paneId) => {
    let event: { wsId: string; paneId: string; previousActiveId: string } | null = null;
    set((state: StoreState) => {
      const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
      if (!ws) return;
      if (!findPane(ws.rootPane, paneId)) return;
      if (ws.activePaneId === paneId) return; // No-op when already active.
      event = { wsId: ws.id, paneId, previousActiveId: ws.activePaneId };
      ws.activePaneId = paneId;
    });
    if (event) {
      const e = event as { wsId: string; paneId: string; previousActiveId: string };
      publishPaneFocused(e.wsId, e.paneId, e.previousActiveId);
    }
  },

  focusPaneSurface: (workspaceId, paneId, surfaceId) => {
    // Mirrors setActivePane's capture-outside-set / publish-after-set shape, but
    // resolves the workspace by EXPLICIT id (the RPC bridge already located the
    // owning workspace by globally-unique pane/surface id) instead of the
    // active one, and emits even for a background workspace (#236 follow-up).
    let event: { wsId: string; paneId: string; previousActiveId: string } | null = null;
    let ok = false;
    set((state: StoreState) => {
      const ws = state.workspaces.find((w: Workspace) => w.id === workspaceId);
      if (!ws) return; // unknown workspace → false, no mutation, no emit.

      // Only a leaf is focusable: a branch id (or a missing id) must not move the
      // active selection. findPane returns the node of either type, so assert leaf.
      const target = findPane(ws.rootPane, paneId);
      if (!target || target.type !== 'leaf') return;

      const previousActiveId = ws.activePaneId;
      const paneChanged = previousActiveId !== target.id;

      // Atomic: set the active pane and (when asked + present) the active surface
      // in the SAME producer, so an observer never sees the new pane with a stale
      // active surface (the two-write race the dedicated action exists to avoid).
      ws.activePaneId = target.id;
      if (surfaceId && target.surfaces.some((s) => s.id === surfaceId)) {
        target.activeSurfaceId = surfaceId;
      }

      ok = true;
      // pane.focused is a PANE event: emit only when the active pane actually
      // changed. A surface-only change on the already-active pane is a no-emit.
      // No activeWorkspaceId gate — a real focus change in a background/multiview
      // workspace is honest to report, and events are ws-scoped so there is no
      // cross-workspace leak.
      if (paneChanged) {
        event = { wsId: ws.id, paneId: target.id, previousActiveId };
      }
    });
    if (event) {
      const e = event as { wsId: string; paneId: string; previousActiveId: string };
      publishPaneFocused(e.wsId, e.paneId, e.previousActiveId);
    }
    return ok;
  },

  updatePaneSizes: (branchId, sizes) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const branch = findPane(ws.rootPane, branchId);
    if (branch && branch.type === 'branch') {
      branch.sizes = sizes;
    }
  }),

  resizeActivePane: (direction, amount) => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const parent = findParent(ws.rootPane, ws.activePaneId);
    if (!parent || parent.type !== 'branch') return;

    const idx = parent.children.findIndex((c) => {
      if (c.type === 'leaf') return c.id === ws.activePaneId;
      return collectLeafIds(c).includes(ws.activePaneId);
    });
    if (idx < 0) return;

    const isHorizontal = parent.direction === 'horizontal';
    const isGrow =
      (isHorizontal && direction === 'right') ||
      (!isHorizontal && direction === 'down');
    const isShrink =
      (isHorizontal && direction === 'left') ||
      (!isHorizontal && direction === 'up');

    if (!isGrow && !isShrink) return;

    const sizes = parent.sizes
      ? [...parent.sizes]
      : parent.children.map(() => 100 / parent.children.length);

    const neighborIdx = isGrow ? idx + 1 : idx - 1;
    if (neighborIdx < 0 || neighborIdx >= sizes.length) return;

    const delta = isGrow ? amount : -amount;
    const newSize = Math.max(10, sizes[idx] + delta);
    const newNeighborSize = Math.max(10, sizes[neighborIdx] - delta);

    sizes[idx] = newSize;
    sizes[neighborIdx] = newNeighborSize;
    parent.sizes = sizes;
  }),

  equalizePaneSizes: () => set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;
    const parent = findParent(ws.rootPane, ws.activePaneId);
    if (!parent || parent.type !== 'branch') return;
    const equal = 100 / parent.children.length;
    parent.sizes = parent.children.map(() => equal);
  }),

  focusPaneDirection: (direction) => {
    let event: { wsId: string; paneId: string; previousActiveId: string } | null = null;
    set((state: StoreState) => {
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return;

    const leaves = getLeafPanes(ws.rootPane);
    if (leaves.length <= 1) return;

    // Helper: get first leaf in a subtree (leftmost/topmost)
    const firstLeaf = (pane: Pane): PaneLeaf => {
      if (pane.type === 'leaf') return pane;
      return firstLeaf(pane.children[0]);
    };

    // Helper: get last leaf in a subtree (rightmost/bottommost)
    const lastLeaf = (pane: Pane): PaneLeaf => {
      if (pane.type === 'leaf') return pane;
      return lastLeaf(pane.children[pane.children.length - 1]);
    };

    // Tree-based spatial navigation
    const navigate = (paneId: string, dir: 'up' | 'down' | 'left' | 'right'): string | null => {
      const parent = findParent(ws.rootPane, paneId);
      if (!parent) return null; // at root

      const idx = parent.children.findIndex(c => c.id === paneId);
      const isAligned =
        (parent.direction === 'horizontal' && (dir === 'left' || dir === 'right')) ||
        (parent.direction === 'vertical' && (dir === 'up' || dir === 'down'));

      if (isAligned) {
        const delta = (dir === 'right' || dir === 'down') ? 1 : -1;
        const nextIdx = idx + delta;
        if (nextIdx >= 0 && nextIdx < parent.children.length) {
          // Move to adjacent sibling — descend to nearest leaf
          const sibling = parent.children[nextIdx];
          const leaf = delta > 0 ? firstLeaf(sibling) : lastLeaf(sibling);
          return leaf.id;
        }
      }

      // Direction not aligned or no sibling in that direction — go up
      return navigate(parent.id, dir);
    };

    const targetId = navigate(ws.activePaneId, direction);
    if (targetId && targetId !== ws.activePaneId) {
      event = { wsId: ws.id, paneId: targetId, previousActiveId: ws.activePaneId };
      ws.activePaneId = targetId;
    }
    });
    if (event) {
      const e = event as { wsId: string; paneId: string; previousActiveId: string };
      publishPaneFocused(e.wsId, e.paneId, e.previousActiveId);
    }
  },

  // Tab-style cycle through every leaf pane in the active workspace, wrapping
  // around at the ends. Tree traversal order matches getLeafPanes (depth-first,
  // left-to-right / top-to-bottom) so the cycle order mirrors what the user
  // sees on screen. Bare-Tab would conflict with shell completion, so this is
  // wired to Ctrl+Tab / Ctrl+Shift+Tab in useKeyboard.
  cyclePane: (direction) => {
    let event: { wsId: string; paneId: string; previousActiveId: string } | null = null;
    set((state: StoreState) => {
      const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
      if (!ws) return;

      const leaves = getLeafPanes(ws.rootPane);
      if (leaves.length <= 1) return;

      const currentIdx = leaves.findIndex((l) => l.id === ws.activePaneId);
      // Defensive: if active pane somehow isn't a leaf in the tree, jump to
      // the first/last leaf instead of throwing.
      const fallbackIdx = direction === 'next' ? 0 : leaves.length - 1;
      const baseIdx = currentIdx === -1 ? fallbackIdx : currentIdx;
      const delta = direction === 'next' ? 1 : -1;
      const nextIdx = (baseIdx + delta + leaves.length) % leaves.length;
      const targetId = leaves[nextIdx].id;
      if (targetId === ws.activePaneId) return;

      event = { wsId: ws.id, paneId: targetId, previousActiveId: ws.activePaneId };
      ws.activePaneId = targetId;
    });
    if (event) {
      const e = event as { wsId: string; paneId: string; previousActiveId: string };
      publishPaneFocused(e.wsId, e.paneId, e.previousActiveId);
    }
  },
});
