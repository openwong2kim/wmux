import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { Pane, PaneLeaf, PaneBranch, StashedPane, Workspace, AgentStatus } from '../../../shared/types';
import type { AgentSlug } from '../../../shared/events';
import {
  createLeafPane,
  generateId,
} from '../../../shared/types';
import {
  findPane,
  findParent,
  collectLeafIds,
  getLeafPanes,
  getWorkspaceLeafPanes,
} from '../../../shared/paneUtils';
import {
  canStashPaneSurfaces,
  findStashedEntry,
  type StashRefusal,
} from '../../../shared/paneStash';
import { isDaemonModeActive } from '../../daemon/daemonMode';
import {
  publishPaneCreated,
  publishPaneClosed,
  publishPaneFocused,
  publishPaneStashed,
  publishPaneUnstashed,
} from '../../events/publisher';
import { t } from '../../i18n';
import { clearNudgesFor } from '../../hooks/channelMentionRateLimit';
import { panePrincipalId } from '../../../shared/principals';
import { computePaneAutoName, paneDisplayName } from '../../utils/paneNaming';
import { saveSessionNow } from '../../utils/sessionSaveBridge';
import { recomputeWorkspacePorts } from './workspacePorts';

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
  /**
   * Take a leaf OUT of the layout without killing it (issue #977).
   *
   * The opposite of `closePane` in the one way that matters: none of the
   * destructive teardown runs. No `pty.dispose`, no `surfaceAgent` /
   * `surfaceActivity` / `surfacePorts` eviction, no label or role drop, no
   * principal or channel-membership purge. The daemon keeps the session, the
   * pane keeps its identity, and `unstashPane` puts it back.
   *
   * Refuses — with a toast explaining why — when the daemon is not connected
   * (without the ring, output produced while unmounted is simply lost), when
   * the target is the last visible leaf (nothing would be left to look at), or
   * when the pane holds an editor/diff/git/review surface (unmounting those
   * drops unsaved edits the ring cannot replay).
   */
  stashPane: (paneId: string, workspaceId?: string) => boolean;
  /**
   * Put a stashed pane back beside its former neighbour.
   *
   * Not "back where it was": `origin` records an anchor leaf and a direction,
   * not the original tree shape, so the pane is re-attached in a fresh branch
   * next to that anchor. When the anchor is gone it lands beside the active
   * pane instead. Idempotent for the undo-toast race — a pane that is no longer
   * stashed is a silent success, not an error.
   */
  unstashPane: (paneId: string, workspaceId?: string) => boolean;
  /**
   * One-shot "a pane just moved into the roster" signal for the sidebar.
   *
   * Stashing takes a pane off the screen; if the list it moved into is
   * collapsed, the whole gesture reads as a delete. The roster consumes this to
   * open itself and flash the new row once, then the pulse is cleared — it is
   * transient view state, never persisted.
   */
  stashPulse: { workspaceId: string; paneId: string; at: number } | null;
  clearStashPulse: () => void;
  /**
   * Issue #645 — move a leaf next to another leaf, tmux `join-pane` style.
   *
   * `workspaceId` is EXPLICIT and never inferred: a multiview drag can start in
   * a workspace that is not `activeWorkspaceId`, and the store cannot guess
   * which tile the gesture came from.
   *
   * `edge` picks the branch direction and the child order — left/right build a
   * horizontal branch, top/bottom a vertical one; left/top put the source
   * first. The insert always wraps the target in a FRESH binary `[50,50]`
   * branch, exactly like `splitPane`, so a moved tree is indistinguishable
   * from a split tree and every existing invariant keeps applying.
   *
   * `focusSource` defaults to false — the active pane is left alone. A drag of
   * an inactive pane passes true, because grabbing a pane means you meant it.
   * When the active pane really changes, `pane.focused` is emitted (the "no new
   * events" rule is about a `pane.moved` type, not about hiding a real focus
   * change).
   *
   * Returns false — with no mutation, no emit, no save — for every guard:
   * unknown workspace, unknown/non-leaf source or target, source === target,
   * or a source that has no parent (the root, i.e. the only pane).
   */
  movePane: (
    workspaceId: string,
    sourceId: string,
    targetId: string,
    edge: 'left' | 'right' | 'top' | 'bottom',
    opts?: { focusSource?: boolean },
  ) => boolean;
  /**
   * Issue #645 — exchange two leaves in place (tmux `swap-pane`). The tree
   * shape and every `sizes` array are untouched: only the two nodes trade
   * slots, so each pane inherits the geometry of the slot it lands in.
   * Returns false on the same guards as `movePane`.
   */
  swapPanes: (workspaceId: string, aId: string, bId: string) => boolean;
  /**
   * Issue #645 — move the active pane one step in a direction, reusing the
   * spatial traversal that `focusPaneDirection` already uses so navigation and
   * movement agree by construction. The pane lands on the FAR side of the
   * neighbour it displaces, so repeating the command walks it across the
   * layout instead of oscillating. No neighbour → false.
   */
  moveActivePaneDirection: (direction: 'up' | 'down' | 'left' | 'right') => boolean;
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

/** Normalized leaf rectangle in a 0–100 coordinate space (both axes). */
interface LeafRect { x: number; y: number; w: number; h: number }

/**
 * #1147 — geometry of every leaf, derived purely from the tree: each branch
 * splits its box along `direction` by `sizes` percentages, with the same
 * `100 / children.length` fallback PaneContainer renders, so these rects match
 * the screen without touching the DOM (navigateFrom is shared with
 * moveActivePaneDirection and runs in jsdom-free store tests; a DOM read would
 * also go stale for zoom-hidden panes).
 */
export function computeLeafRects(root: Pane): Map<string, LeafRect> {
  const rects = new Map<string, LeafRect>();
  const walk = (pane: Pane, x: number, y: number, w: number, h: number): void => {
    if (pane.type === 'leaf') {
      rects.set(pane.id, { x, y, w, h });
      return;
    }
    const n = pane.children.length;
    let offset = 0;
    for (let i = 0; i < n; i++) {
      const frac = (pane.sizes?.[i] ?? 100 / n) / 100;
      if (pane.direction === 'horizontal') walk(pane.children[i], x + offset * w, y, w * frac, h);
      else walk(pane.children[i], x, y + offset * h, w, h * frac);
      offset += frac;
    }
  };
  walk(root, 0, 0, 100, 100);
  return rects;
}

/**
 * Geometric spatial navigation (#1147): the leaf you reach by moving `dir` out
 * of `paneId` — the candidate whose facing edge is nearest, tie-broken by the
 * largest perpendicular overlap with the current pane, then by center
 * distance (tmux's pick, roughly). Replaces the tree-order walk that, in a
 * 2×2 grid built as [[TL,BL],[TR,BR]], sent focusLeft from TR to BL: the
 * old code descended to the sibling column's LAST leaf regardless of where
 * the cursor actually sat.
 *
 * Shared by `focusPaneDirection` and (issue #645) `moveActivePaneDirection`,
 * so "the pane to my right" means the same thing whether you are moving focus
 * or moving the pane itself. Returns null at the layout edge (no candidate).
 */
function navigateFrom(root: Pane, paneId: string, dir: 'up' | 'down' | 'left' | 'right'): string | null {
  const rects = computeLeafRects(root);
  const cur = rects.get(paneId);
  if (!cur) return null;
  // Float slack: sizes come from resize events and rarely sum to exactly 100.
  const EPS = 0.1;

  let best: string | null = null;
  let bestEdge = Infinity;
  let bestOverlap = -Infinity;
  let bestCenter = Infinity;
  const curCx = cur.x + cur.w / 2;
  const curCy = cur.y + cur.h / 2;

  for (const [id, r] of rects) {
    if (id === paneId) continue;
    let edge: number;
    if (dir === 'left') {
      if (r.x + r.w > cur.x + EPS) continue;
      edge = cur.x - (r.x + r.w);
    } else if (dir === 'right') {
      if (r.x < cur.x + cur.w - EPS) continue;
      edge = r.x - (cur.x + cur.w);
    } else if (dir === 'up') {
      if (r.y + r.h > cur.y + EPS) continue;
      edge = cur.y - (r.y + r.h);
    } else {
      if (r.y < cur.y + cur.h - EPS) continue;
      edge = r.y - (cur.y + cur.h);
    }
    const overlap = dir === 'left' || dir === 'right'
      ? Math.min(cur.y + cur.h, r.y + r.h) - Math.max(cur.y, r.y)
      : Math.min(cur.x + cur.w, r.x + r.w) - Math.max(cur.x, r.x);
    const center = dir === 'left' || dir === 'right'
      ? Math.abs(r.y + r.h / 2 - curCy)
      : Math.abs(r.x + r.w / 2 - curCx);

    if (
      edge < bestEdge - EPS ||
      (Math.abs(edge - bestEdge) <= EPS && (
        overlap > bestOverlap + EPS ||
        (Math.abs(overlap - bestOverlap) <= EPS && center < bestCenter)
      ))
    ) {
      best = id;
      bestEdge = edge;
      bestOverlap = overlap;
      bestCenter = center;
    }
  }
  return best;
}

/**
 * Detach a child from its parent branch and collapse the parent when only one
 * child is left — the structural half of both `closePane` and (issue #645)
 * `movePane`. Pure structure: it never touches surfaces, PTY maps, principals,
 * or focus, so a caller that wants a pane GONE must do that teardown itself.
 *
 *   before                    detach(B)              collapse
 *   ┌── branch ──┐            ┌── branch ──┐
 *   │  A   B   C │    ──▶     │  A     C   │   (3 children → no collapse)
 *   └────────────┘            └────────────┘
 *
 *   ┌── branch ──┐            ┌─ branch ─┐
 *   │   A    B   │    ──▶     │    A     │    ──▶   A replaces the branch
 *   └────────────┘            └──────────┘         (in the grandparent, or
 *                                                   as ws.rootPane)
 *
 * Returns the detached subtree, or null when the id is unknown or is the root
 * (the root has no parent, so there is nothing to detach it from).
 */
function detachPane(ws: Workspace, paneId: string): Pane | null {
  const parent = findParent(ws.rootPane, paneId);
  if (!parent) return null; // unknown id, or the root pane itself

  const idx = parent.children.findIndex((c) => c.id === paneId);
  if (idx === -1) return null;

  const [detached] = parent.children.splice(idx, 1);

  // Keep `sizes` aligned with `children`. Before this existed, closePane
  // spliced the child and left `sizes` untouched, so a branch with three or
  // more children rendered its survivors at the wrong widths after a close
  // (sizes[] was longer than children[] and the extra entry shifted every
  // panel one slot to the left). A two-child branch hid the bug because it
  // collapses away below.
  if (parent.sizes) {
    parent.sizes.splice(idx, 1);
    const total = parent.sizes.reduce((sum, s) => sum + s, 0);
    parent.sizes =
      total > 0
        ? parent.sizes.map((s) => (s / total) * 100)
        : parent.children.map(() => 100 / parent.children.length);
  }

  if (parent.children.length === 1) {
    // Collapse: replace the parent with its remaining child.
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

  return detached;
}

/**
 * Insert `node` next to the leaf `targetLeafId`, wrapping the target in a fresh
 * binary branch — the structural half of both `movePane` (#645) and
 * `unstashPane` (#977). The mirror image of `detachPane`, and the reason the
 * two features cannot drift: a moved pane and an unstashed pane land in exactly
 * the same shape.
 *
 * `sizes` is `[nodeShare, targetShare]` and is IGNORED unless it has exactly two
 * entries. A `sizes` array out of step with `children` is the precise bug
 * detachPane exists to prevent in the other direction (every survivor renders
 * one slot off), and origin sizes come from persisted, user-editable state.
 *
 * Returns false — having mutated nothing — when the target is no longer in the
 * tree, so the caller can keep the node where it was instead of dropping it.
 */
function attachBeside(
  ws: Workspace,
  targetLeafId: string,
  node: Pane,
  direction: 'horizontal' | 'vertical',
  sourceFirst: boolean,
  sizes?: number[],
): boolean {
  const targetParent = findParent(ws.rootPane, targetLeafId);
  const liveTarget = findPane(ws.rootPane, targetLeafId);
  if (!liveTarget) return false;

  const [nodeShare, targetShare] = sizes && sizes.length === 2 ? sizes : [50, 50];
  const branch: PaneBranch = {
    id: generateId('pane'),
    type: 'branch',
    direction,
    children: sourceFirst ? [node, liveTarget] : [liveTarget, node],
    sizes: sourceFirst ? [nodeShare, targetShare] : [targetShare, nodeShare],
  };

  if (targetParent) {
    const idx = targetParent.children.findIndex((c) => c.id === targetLeafId);
    if (idx === -1) return false;
    targetParent.children[idx] = branch;
  } else {
    ws.rootPane = branch;
  }
  return true;
}

/** Why a stash was refused. `notFound` is silent (a stale id, not a user error). */
type StashRefusalReason =
  | 'daemon'
  | 'lastPane'
  | 'notFound'
  | Extract<StashRefusal, { ok: false }>;

/**
 * Where a pane sat, recorded at stash time. Anchors on a LEAF: when the sibling
 * is a branch we take that branch's first leaf, which is why unstash promises
 * "next to its former neighbour" rather than "back where it was" — the parent
 * topology is not recoverable from this.
 */
function captureStashOrigin(ws: Workspace, paneId: string): StashedPane['origin'] {
  const parent = findParent(ws.rootPane, paneId);
  if (!parent) return undefined;
  const idx = parent.children.findIndex((c) => c.id === paneId);
  if (idx === -1) return undefined;
  // The adjacent sibling — the next child, or the previous one at the end.
  const siblingIdx = idx + 1 < parent.children.length ? idx + 1 : idx - 1;
  const sibling = parent.children[siblingIdx];
  if (!sibling) return undefined;
  const anchorLeaf = sibling.type === 'leaf' ? sibling : getLeafPanes(sibling)[0];
  if (!anchorLeaf) return undefined;
  const sizes = parent.sizes;
  return {
    anchorPaneId: anchorLeaf.id,
    direction: parent.direction,
    sourceFirst: idx < siblingIdx,
    ...(sizes && sizes.length === parent.children.length
      ? { sizes: [sizes[idx], sizes[siblingIdx]] }
      : {}),
  };
}

export const createPaneSlice: StateCreator<StoreState, [['zustand/immer', never]], [], PaneSlice> = (set, get) => ({
  paneNotificationRing: {},

  stashPulse: null,

  clearStashPulse: () => set((state: StoreState) => {
    state.stashPulse = null;
  }),

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
    let stashedAtCap = 0;
    let createdPaneId: string | false = false;
    set((state: StoreState) => {
      const targetWsId = workspaceId || state.activeWorkspaceId;
      const ws = state.workspaces.find((w: Workspace) => w.id === targetWsId);
      if (!ws) return;

      const targetPane = findPane(ws.rootPane, paneId);
      if (!targetPane || targetPane.type !== 'leaf') return;

      // Cap leaf growth — every callsite (Ctrl+D, prefix-mode split, palette,
      // browser-pane shortcut, sample-task wizard) funnels through here, so a
      // single guard is enough. Stashed panes COUNT: the cap exists to bound
      // xterm + node-pty memory, and a stashed pane's session is still running.
      if (getWorkspaceLeafPanes(ws).length >= MAX_PANES_PER_WORKSPACE) {
        blockedAtCap = true;
        stashedAtCap = (ws.stashedPanes ?? []).length;
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
        (getWorkspaceLeafPanes(ws).reduce((m, l) => Math.max(m, l.ordinal ?? 0), 0) + 1);
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
        // Name the stash when it is part of why the cap was hit — otherwise the
        // message points at panes the user can see and count, and the ones
        // actually consuming the budget are off-screen.
        message: stashedAtCap > 0
          ? t('pane.maxLeavesReachedWithStash', {
              count: MAX_PANES_PER_WORKSPACE,
              stashed: stashedAtCap,
            })
          : t('pane.maxLeavesReached', { count: MAX_PANES_PER_WORKSPACE }),
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
      // A stashed pane is still owned, so the roster's ✕ must be able to kill
      // it for real — same teardown, same principal purge. Falling back to the
      // stash here is what makes closePane the single destructive path.
      const subtree = parentSnap?.children.find((c) => c.id === paneId)
        ?? findStashedEntry(wsSnap?.stashedPanes, paneId)?.pane;
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
      const stashedIdx = parent
        ? -1
        : (ws.stashedPanes ?? []).findIndex((entry) => entry?.pane?.id === paneId);
      if (!parent && stashedIdx === -1) {
        // Can't close root pane, but can clear its surfaces
        return;
      }

      const idx = parent ? parent.children.findIndex((c) => c.id === paneId) : -1;
      if (parent && idx === -1) return;
      const closingSubtree: Pane = parent ? parent.children[idx] : ws.stashedPanes![stashedIdx].pane;

      // Part A: drop per-surface agent identity for every surface under the
      // closing subtree (leaf or branch) so the surfaceAgent map doesn't leak
      // entries for PTYs that no longer have a surface. The Fleet activity line
      // is keyed the same way and is one of the two REAL teardown sites (the
      // other is closeSurface) — clear it here too so a closed pane's last
      // activity string can't linger on a re-used ptyId.
      for (const leaf of getLeafPanes(closingSubtree)) {
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
            delete state.surfacePorts[s.ptyId];
            delete state.surfaceAgentStatus[s.ptyId];
            clearNudgesFor(s.ptyId); // A5: don't let a reused ptyId inherit this pane's nudge cap
            // J3 F4: onExhausted 매핑도 이 ptyId 소멸과 함께 evict.
            if (state.taskPtyRegistry) delete state.taskPtyRegistry[s.ptyId];
          }
        }
      }
      // #1135: the sidebar's listening-port chip is a union over surfacePorts.
      // Recompute it now that the closing pane's entries are gone, otherwise a
      // closed pane's ports stay pinned on the workspace forever (no surviving
      // surface's METADATA_UPDATE can subtract another surface's ports).
      recomputeWorkspacePorts(state.workspaces, state.surfacePorts);

      const previousActiveId = ws.activePaneId;
      // Structural removal lives in detachPane (shared with movePane, #645);
      // everything above and below this line is the destructive teardown that
      // only closing does. A stashed pane has no place in the tree to detach
      // from — dropping its stash entry IS the structural removal.
      if (parent) {
        detachPane(ws, paneId);
      } else {
        ws.stashedPanes!.splice(stashedIdx, 1);
        if (ws.stashedPanes!.length === 0) delete ws.stashedPanes;
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

  stashPane: (paneId, workspaceId) => {
    // Everything the post-producer effects need, captured as PLAIN values.
    // A draft leaks out of the producer as a revoked proxy, so the undo toast
    // must never close over `ws` or the pane node itself.
    let refusal: StashRefusalReason | null = null;
    let stashed: {
      wsId: string;
      paneId: string;
      paneName: string;
      previousActiveId: string;
      newActiveId: string | null;
    } | null = null;
    set((state: StoreState) => {
      const ws = state.workspaces.find((w: Workspace) => w.id === (workspaceId || state.activeWorkspaceId));
      if (!ws) { refusal = 'notFound'; return; }

      // Gate on the daemon CONNECTION, not on a "mode": without the ring, every
      // byte the pane produces while unmounted is gone. Same guarantee cold-park
      // relies on, asked for at pane granularity.
      if (!isDaemonModeActive()) { refusal = 'daemon'; return; }

      const target = findPane(ws.rootPane, paneId);
      if (!target || target.type !== 'leaf') { refusal = 'notFound'; return; }

      const visible = getLeafPanes(ws.rootPane);
      if (visible.length <= 1) { refusal = 'lastPane'; return; }

      // The daemon ring holds PTY bytes and nothing else — an editor/diff tab
      // would lose its unsaved buffer on unmount with nothing to replay it from.
      const allowed = canStashPaneSurfaces(target);
      if (!allowed.ok) { refusal = allowed; return; }

      // Every guard is above this line on purpose: past it the pane is out of
      // the tree, and a refusal that returns without re-homing it would delete
      // a live pane — the one outcome this whole feature exists to prevent.
      const origin = captureStashOrigin(ws, paneId);
      const detached = detachPane(ws, paneId);
      // Nothing was removed (unknown id, or the root) — the tree is untouched.
      if (!detached) { refusal = 'notFound'; return; }
      if (detached.type !== 'leaf') {
        // Unreachable: `target` was verified a leaf above and detachPane removes
        // exactly that node. Should it ever happen, the node has ALREADY left
        // the tree, so putting it back is the only non-destructive answer.
        const anchor = getLeafPanes(ws.rootPane)[0];
        if (anchor) attachBeside(ws, anchor.id, detached, 'horizontal', false);
        refusal = 'notFound';
        return;
      }

      // Created HERE rather than in createWorkspace: every workspace that has
      // never stashed anything stays byte-identical on disk, and the field's
      // absence keeps meaning "nothing stashed" instead of "empty array".
      if (!ws.stashedPanes) ws.stashedPanes = [];
      ws.stashedPanes.push({ pane: detached, origin, stashedAt: Date.now() });

      // Same hygiene split/move/close apply (#182): a zoom pinned to a pane
      // that just left the layout would read as an un-zoom on the next toggle.
      if (state.zoomedPaneId === paneId) state.zoomedPaneId = null;
      const previousActiveId = ws.activePaneId;
      if (ws.activePaneId === paneId) {
        const remaining = getLeafPanes(ws.rootPane);
        if (remaining.length > 0) ws.activePaneId = remaining[0].id;
      }

      // Nudge the sidebar: the pane just left the screen, so the roster it
      // moved into has to be open for the move to be legible at all.
      state.stashPulse = { workspaceId: ws.id, paneId, at: Date.now() };

      stashed = {
        wsId: ws.id,
        paneId,
        paneName: paneDisplayName(
          state.paneLabel[paneId],
          computePaneAutoName(ws.wsOrdinal ?? 0, detached.ordinal ?? 0),
        ),
        previousActiveId,
        newActiveId: ws.activePaneId !== previousActiveId ? ws.activePaneId : null,
      };
    });

    if (refusal) {
      const r = refusal as StashRefusalReason;
      if (r === 'notFound') return false;
      get().pushToast({
        level: 'warn',
        message:
          r === 'daemon' ? t('pane.stashNoDaemon')
          : r === 'lastPane' ? t('pane.stashLastPane')
          : r.reason === 'empty' ? t('pane.stashEmptyPane')
          : t('pane.stashBlockedSurface', { type: r.surfaceType }),
      });
      return false;
    }
    if (!stashed) return false;

    const done = stashed as {
      wsId: string;
      paneId: string;
      paneName: string;
      previousActiveId: string;
      newActiveId: string | null;
    };
    console.log(`[wmux:stash] stashed pane=${done.paneId} ws=${done.wsId}`);
    // NOT pane.closed — an external poller would read that as "this pane is
    // gone" and drop a session that is still running.
    publishPaneStashed(done.wsId, done.paneId);
    // Stashing the ACTIVE pane moves the selection, exactly as closing it does,
    // and closePane reports that. Staying silent here would leave a poller's
    // idea of the focused pane pointing at one that is no longer in the layout.
    if (done.newActiveId) {
      publishPaneFocused(done.wsId, done.newActiveId, done.previousActiveId);
    }
    // Pane-tree mutations otherwise ride only the 5s autosave (movePane's
    // reasoning): a stash followed by an immediate quit must not come back
    // as a pane that is both gone from the layout and missing from the stash.
    saveSessionNow();
    get().pushToast({
      level: 'info',
      message: t('pane.stashed', { name: done.paneName }),
      // Ten seconds, not five: undo is the whole reason the toast exists, and
      // the action it offers is the one thing five seconds is a coin flip on.
      durationMs: 10_000,
      action: {
        label: t('common.undo'),
        onClick: () => { get().unstashPane(done.paneId, done.wsId); },
      },
    });
    return true;
  },

  unstashPane: (paneId, workspaceId) => {
    let restored: { wsId: string; paneId: string; toOrigin: boolean } | null = null;
    let alreadyVisible = false;
    set((state: StoreState) => {
      const ws = state.workspaces.find((w: Workspace) => w.id === (workspaceId || state.activeWorkspaceId));
      if (!ws) return;

      const idx = (ws.stashedPanes ?? []).findIndex((entry) => entry?.pane?.id === paneId);
      if (idx === -1) {
        // Undo-toast race: the roster's ✕ already killed it, or another caller
        // already brought it back. Both are "the pane is not stashed", which is
        // what the caller asked for — a silent success, not an error.
        alreadyVisible = !!findPane(ws.rootPane, paneId);
        return;
      }
      const entry = ws.stashedPanes![idx];

      // Anchor resolution, most → least faithful: the recorded neighbour if it
      // is still a leaf on screen, then the active pane, then whatever is first.
      const originAnchor = entry.origin?.anchorPaneId;
      const anchorLive = originAnchor ? findPane(ws.rootPane, originAnchor) : null;
      const toOrigin = !!anchorLive && anchorLive.type === 'leaf';
      const fallback = findPane(ws.rootPane, ws.activePaneId);
      const anchorId = toOrigin
        ? originAnchor!
        : (fallback && fallback.type === 'leaf' ? fallback.id : getLeafPanes(ws.rootPane)[0]?.id);
      if (!anchorId) return;

      const attached = attachBeside(
        ws,
        anchorId,
        entry.pane,
        toOrigin ? (entry.origin?.direction ?? 'horizontal') : 'horizontal',
        toOrigin ? (entry.origin?.sourceFirst ?? false) : false,
        toOrigin ? entry.origin?.sizes : undefined,
      );
      // Splice ONLY after the re-attach lands. Removing first and failing to
      // attach would delete a live pane from both the tree and the stash — the
      // one outcome this whole feature exists to prevent.
      if (!attached) return;
      ws.stashedPanes!.splice(idx, 1);
      if (ws.stashedPanes!.length === 0) delete ws.stashedPanes;

      ws.activePaneId = paneId;
      // Scoped to THIS workspace's tree, like splitPane and movePane: a global
      // id belonging to another workspace must not be cleared by a re-attach
      // over here (zoomedPaneId is one global slot, and clearing a stranger's
      // would silently un-zoom a pane the user left zoomed elsewhere).
      if (
        state.zoomedPaneId !== null
        && state.zoomedPaneId !== paneId
        && findPane(ws.rootPane, state.zoomedPaneId)
      ) {
        state.zoomedPaneId = null;
      }
      restored = { wsId: ws.id, paneId, toOrigin };
    });

    if (!restored) return alreadyVisible;
    const done = restored as { wsId: string; paneId: string; toOrigin: boolean };
    console.log(`[wmux:stash] unstashed pane=${done.paneId} ws=${done.wsId} toOrigin=${done.toOrigin}`);
    publishPaneUnstashed(done.wsId, done.paneId);
    publishPaneFocused(done.wsId, done.paneId);
    saveSessionNow();
    get().pushToast({
      level: 'info',
      message: done.toOrigin ? t('pane.unstashedToNeighbor') : t('pane.unstashedFallback'),
    });
    return true;
  },

  movePane: (workspaceId, sourceId, targetId, edge, opts) => {
    let event: { wsId: string; paneId: string; previousActiveId: string } | null = null;
    let moved = false;
    set((state: StoreState) => {
      const ws = state.workspaces.find((w: Workspace) => w.id === workspaceId);
      if (!ws) return;
      if (sourceId === targetId) return;

      const source = findPane(ws.rootPane, sourceId);
      const target = findPane(ws.rootPane, targetId);
      if (!source || source.type !== 'leaf') return;
      if (!target || target.type !== 'leaf') return;
      // A leaf with no parent is the whole workspace — nothing to move it out of.
      if (!findParent(ws.rootPane, sourceId)) return;

      const detached = detachPane(ws, sourceId);
      if (!detached) return;

      // attachBeside re-resolves the target AFTER the detach: collapsing the
      // source's former parent can replace the node that held it, so a
      // reference captured before the splice may no longer be the one in the
      // tree.
      const direction = edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical';
      const sourceFirst = edge === 'left' || edge === 'top';
      if (!attachBeside(ws, targetId, detached, direction, sourceFirst)) return;

      // #182: a move re-flows the layout, so a pane hidden behind the zoom would
      // reappear somewhere unexpected. Same reasoning as splitPane.
      if (state.zoomedPaneId !== null && findPane(ws.rootPane, state.zoomedPaneId)) {
        state.zoomedPaneId = null;
      }

      if (opts?.focusSource) {
        const previousActiveId = ws.activePaneId;
        if (previousActiveId !== sourceId) {
          ws.activePaneId = sourceId;
          event = { wsId: ws.id, paneId: sourceId, previousActiveId };
        }
      }

      moved = true;
    });
    if (event) {
      const e = event as { wsId: string; paneId: string; previousActiveId: string };
      publishPaneFocused(e.wsId, e.paneId, e.previousActiveId);
    }
    // Pane-tree mutations otherwise ride only the 5s autosave, so a move
    // followed by an immediate quit would be lost. Flush outside the producer.
    if (moved) saveSessionNow();
    return moved;
  },

  swapPanes: (workspaceId, aId, bId) => {
    let swapped = false;
    set((state: StoreState) => {
      const ws = state.workspaces.find((w: Workspace) => w.id === workspaceId);
      if (!ws) return;
      if (aId === bId) return;

      const a = findPane(ws.rootPane, aId);
      const b = findPane(ws.rootPane, bId);
      if (!a || a.type !== 'leaf') return;
      if (!b || b.type !== 'leaf') return;

      const aParent = findParent(ws.rootPane, aId);
      const bParent = findParent(ws.rootPane, bId);
      // Neither can be the root: a root leaf is the only pane in the workspace.
      if (!aParent || !bParent) return;

      const aIdx = aParent.children.findIndex((c) => c.id === aId);
      const bIdx = bParent.children.findIndex((c) => c.id === bId);
      if (aIdx === -1 || bIdx === -1) return;

      // Only the two nodes trade places. `sizes` belongs to the SLOT, not to
      // the pane, so it is deliberately left alone — a pane swapped into a 70%
      // slot becomes 70% wide, which is what "swap" means on screen.
      aParent.children[aIdx] = b;
      bParent.children[bIdx] = a;

      swapped = true;
    });
    if (swapped) saveSessionNow();
    return swapped;
  },

  moveActivePaneDirection: (direction) => {
    const state = get();
    const ws = state.workspaces.find((w: Workspace) => w.id === state.activeWorkspaceId);
    if (!ws) return false;

    const neighbourId = navigateFrom(ws.rootPane, ws.activePaneId, direction);
    if (!neighbourId || neighbourId === ws.activePaneId) return false;

    // Land on the FAR side of the displaced neighbour: moving right past a
    // right-hand neighbour puts the pane to that neighbour's right, so the next
    // "move right" keeps walking instead of swapping back and forth.
    const edge =
      direction === 'left' ? 'left' : direction === 'right' ? 'right' : direction === 'up' ? 'top' : 'bottom';

    // The pane the user is moving is the one they are looking at, so it keeps
    // focus — otherwise focus would be left behind on whatever slot it vacated.
    return get().movePane(ws.id, ws.activePaneId, neighbourId, edge, { focusSource: true });
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

    // Spatial navigation lives in navigateFrom (module scope) so that moving a
    // pane and moving focus resolve "the pane to my right" identically (#645).
    const targetId = navigateFrom(ws.rootPane, ws.activePaneId, direction);
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
