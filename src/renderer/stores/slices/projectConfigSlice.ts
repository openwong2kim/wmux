// Project config slice (X5 wmux.json) — renderer-side state for discovered
// per-project configs and the layout-apply machinery.
//
// All fields here are TRANSIENT: none enter buildSessionData's allowlist, so
// a saved session can never replay a stale trust verdict or a stale pane
// seed (same rule as splitCwdSeed / surfacePorts).
//
// Layout application reuses the applyLayoutTemplate strategy: replace the
// workspace's rootPane with a tree of EMPTY leaves and let AppLayout's
// empty-leaf funnel create the PTYs. Per-leaf startup commands / cwds / urls
// travel via `projectPaneSeed` (paneId-keyed, consumed-and-cleared by the
// funnel) — the exact splitCwdSeed pattern, extended to a richer payload.

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import { createLeafPane, assignPaneOrdinals, generateId, type Pane, type PaneBranch, type Workspace } from '../../../shared/types';
import type { ProjectConfigState, WmuxProjectLayoutNode } from '../../../shared/wmuxProjectConfig';

/** Per-pane bootstrap payload recorded at layout-apply time. `cwd` is already
 * resolved to an ABSOLUTE path (root + relative) so the funnel can pass it to
 * pty.create verbatim. */
export interface ProjectPaneSeed {
  command?: string;
  cwd?: string;
  url?: string;
  /** X8 supervision policy carried from the leaf (terminal leaves only). The
   * AppLayout funnel turns a set `restart` into an exec-style supervised
   * pty.create instead of an `initialCommand`. */
  restart?: 'on-failure' | 'always';
  restartLimit?: { burst?: number; healthyUptimeSec?: number };
  /**
   * U-PERM: the EFFECTIVE unattended permission-restore decision — the leaf's
   * `restorePermissionMode` intent AND the project's explicit unattended consent
   * (ProjectConfigState.unattended), computed at layout-apply time. The funnel
   * passes this into the supervised pty.create's supervision policy; the daemon
   * honors it verbatim at replay. Only ever set alongside `restart`.
   */
  restorePermissionMode?: boolean;
}

export interface ApplyProjectLayoutResult {
  ok: boolean;
  /** PTYs owned by the replaced tree — the CALLER must dispose them (slices
   * stay free of electronAPI so they remain unit-testable in node). */
  disposedPtyIds: string[];
}

export interface ProjectConfigSlice {
  /** Latest discovery result per workspace id. `undefined` = not probed yet. */
  projectConfigs: Record<string, ProjectConfigState>;
  setProjectConfig: (workspaceId: string, state: ProjectConfigState | null) => void;

  /** Auto-apply guard — a workspace gets at most ONE automatic layout apply
   * per app run, even if trust flips later. Manual applies are unlimited. */
  projectLayoutAutoApplied: Record<string, true>;
  markProjectLayoutAutoApplied: (workspaceId: string) => void;

  projectPaneSeed: Record<string, ProjectPaneSeed>;
  clearProjectPaneSeed: (paneId: string) => void;

  /** Workspace whose wmux.json dialog (review/trusted-actions) is open. */
  projectDialogWsId: string | null;
  setProjectDialogWsId: (workspaceId: string | null) => void;

  /**
   * Replace `workspaceId`'s pane tree with the trusted project layout.
   * Trust is re-checked HERE (not just at the call site) so no code path can
   * apply an untrusted layout. Returns the replaced tree's ptyIds for the
   * caller to dispose.
   */
  applyProjectLayout: (workspaceId: string) => ApplyProjectLayoutResult;
}

function collectPtyIds(pane: Pane): string[] {
  if (pane.type === 'leaf') {
    return pane.surfaces.map((s) => s.ptyId).filter((id): id is string => Boolean(id));
  }
  return pane.children.flatMap(collectPtyIds);
}

function firstLeafId(pane: Pane): string {
  if (pane.type === 'leaf') return pane.id;
  return firstLeafId(pane.children[0]);
}

/** Join the project root and a validated relative segment. Pure string math —
 * the schema layer already rejected absolute/`..` cwds, and the spawn layer's
 * validateCwd tolerantly falls back to homedir if the result doesn't exist. */
function joinProjectCwd(root: string, relative: string | undefined): string {
  if (relative === undefined || relative === '.' || relative === './') return root;
  const sep = root.includes('\\') ? '\\' : '/';
  const cleaned = relative.replace(/^\.\//, '').replace(/[\\/]+$/, '');
  if (cleaned.length === 0) return root;
  // Strip the root's trailing separator (drive roots like "c:\") so the join
  // never doubles it.
  const base = root.replace(/[\\/]+$/, '');
  return `${base}${sep}${cleaned.replace(/[/\\]+/g, sep)}`;
}

/** Build an empty pane tree from the layout, recording one seed per leaf.
 * `unattendedConsented` gates the per-leaf permission-restore bit: an unattended
 * leaf only restores its captured permission mode on reboot when the user gave
 * explicit unattended consent for this project (Minimal design 2026-07-01). */
function buildTree(
  node: WmuxProjectLayoutNode,
  root: string,
  seeds: Record<string, ProjectPaneSeed>,
  unattendedConsented: boolean,
): Pane {
  if (node.type === 'leaf') {
    const leaf = createLeafPane();
    const seed: ProjectPaneSeed = {};
    if (node.url !== undefined) {
      seed.url = node.url;
    } else {
      if (node.command !== undefined) seed.command = node.command;
      // Terminal leaves always pin cwd to the project (or its sub-dir) — that
      // IS the feature: "open this repo, panes start in it".
      seed.cwd = joinProjectCwd(root, node.cwd);
      // X8: carry supervision policy onto the seed (terminal leaves only — the
      // schema rejects url+restart, so a url leaf never has these). The funnel
      // reads `restart` to choose exec-style supervised create.
      if (node.restart !== undefined) {
        seed.restart = node.restart;
        if (node.restartLimit !== undefined) seed.restartLimit = node.restartLimit;
        // U-PERM: turn on captured-permission restore only when BOTH the leaf
        // declared `unattended` (normalized to restorePermissionMode) AND the
        // user consented. No consent → omitted → daemon D6 fail-safe on reboot.
        if (node.restorePermissionMode === true && unattendedConsented) {
          seed.restorePermissionMode = true;
        }
      }
    }
    seeds[leaf.id] = seed;
    return leaf;
  }
  const branch: PaneBranch = {
    id: generateId('pane'),
    type: 'branch',
    direction: node.direction,
    children: node.children.map((child) => buildTree(child, root, seeds, unattendedConsented)),
    ...(node.sizes ? { sizes: node.sizes } : {}),
  };
  return branch;
}

export const createProjectConfigSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  ProjectConfigSlice
> = (set, get) => ({
  projectConfigs: {},

  setProjectConfig: (workspaceId, state) => set((draft: StoreState) => {
    if (state === null) {
      delete draft.projectConfigs[workspaceId];
      return;
    }
    draft.projectConfigs[workspaceId] = state;
  }),

  projectLayoutAutoApplied: {},

  markProjectLayoutAutoApplied: (workspaceId) => set((draft: StoreState) => {
    draft.projectLayoutAutoApplied[workspaceId] = true;
  }),

  projectPaneSeed: {},

  clearProjectPaneSeed: (paneId) => set((draft: StoreState) => {
    delete draft.projectPaneSeed[paneId];
  }),

  projectDialogWsId: null,

  setProjectDialogWsId: (workspaceId) => set((draft: StoreState) => {
    draft.projectDialogWsId = workspaceId;
  }),

  applyProjectLayout: (workspaceId) => {
    const snapshot = get();
    const project = snapshot.projectConfigs[workspaceId];
    const layout = project?.config?.layout;
    if (!project || project.trust !== 'trusted' || !layout || !project.root) {
      return { ok: false, disposedPtyIds: [] };
    }
    let disposedPtyIds: string[] = [];
    let applied = false;
    set((draft: StoreState) => {
      const ws = draft.workspaces.find((w: Workspace) => w.id === workspaceId);
      if (!ws) return;
      disposedPtyIds = collectPtyIds(ws.rootPane);
      const seeds: Record<string, ProjectPaneSeed> = {};
      // Consent is re-read from the (trusted) project state here, so revoking it
      // (re-trust without the checkbox) makes the next layout-apply omit restore.
      const newRoot = buildTree(layout, project.root as string, seeds, project.unattended === true);
      // P2: full-tree replace → number leaves fresh 1..n (parallels applyLayoutTemplate).
      ws.nextPaneOrdinal = assignPaneOrdinals(newRoot, 1);
      ws.rootPane = newRoot;
      ws.activePaneId = firstLeafId(newRoot);
      for (const [paneId, seed] of Object.entries(seeds)) {
        draft.projectPaneSeed[paneId] = seed;
      }
      // Same hygiene as applyLayoutTemplate: a zoomed pane id from the old
      // tree must not survive into the new one.
      draft.zoomedPaneId = null;
      applied = true;
    });
    return { ok: applied, disposedPtyIds: applied ? disposedPtyIds : [] };
  },
});
