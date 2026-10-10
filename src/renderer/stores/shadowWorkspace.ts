/**
 * PC rail, PR4: shadow workspaces.
 *
 * A shadow is the local projection of one workspace on a web-paired computer:
 * an ordinary `Workspace` in `state.workspaces` whose id is in the shadow
 * namespace (`shadow:<hostId>:<remoteId>`, shared/pcRail/shadowId.ts) and
 * whose leaves hold non-owned remote-terminal surfaces. It is never persisted;
 * reopening rebuilds it from the host's row.
 *
 *   host row (pcRailFeeds) ──buildShadowWorkspace──▶ Workspace (shadow:…)
 *                         ──reconcileShadowWorkspace──▶ same tree, host-owned membership
 *
 * Every id the tree carries is namespaced under the workspace id, so nothing a
 * host sends (pane, split or surface ids) can equal a local id or another
 * host's id, whatever it reports. The host's tree has already passed the
 * layout bounds (parseRemoteLayout) and been narrowed to the row's own
 * sessions (pcRailFeed.ts) before it reaches the renderer.
 *
 * Pure functions only; the store actions that apply them live in
 * workspaceSlice.ts.
 */

import type { Pane, PaneLeaf, SessionData, Surface, Workspace } from '../../shared/types';
import { createRemoteSurface } from '../../shared/types';
import type { PhoneLayoutNode, PhoneLayoutSurface } from '../../shared/phoneFleetSidebar';
import {
  LOCAL_PC_ID,
  formatShadowWorkspaceId,
  isShadowWorkspaceId,
  parseShadowWorkspaceId,
  type PcRailWorkspaceRow,
  type ShadowWorkspaceRef,
} from '../../shared/pcRail';

/** Live shadows kept at once. Opening one more closes the least recently used inactive one. */
export const SHADOW_WORKSPACE_LIMIT = 3;

/** One predicate for every exclusion (sidebar, keys, save, archive, agents, phone). */
export function isShadowWorkspace(ws: { id: string } | null | undefined): boolean {
  return !!ws && isShadowWorkspaceId(ws.id);
}

/** The host and remote workspace a shadow projects, or null for any other id. */
export function shadowBinding(ws: { id: string } | null | undefined): ShadowWorkspaceRef | null {
  return ws ? parseShadowWorkspaceId(ws.id) : null;
}

/** Copy the tree uses for tabs it cannot show. */
export interface ShadowCopy {
  /** "Browser on office-mac — not shown". */
  browserNotShown: string;
  /** "Open in {workspace}" for a session already open as a tab elsewhere. */
  openElsewhere: (workspaceName: string) => string;
  /** A terminal slot the host listed no session for. */
  terminal: string;
}

/** Where a (host, session) pair is already open as a remote-terminal tab. */
export interface RemoteSurfaceHit {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
}

function leavesOf(pane: Pane, out: PaneLeaf[] = []): PaneLeaf[] {
  if (pane.type === 'leaf') out.push(pane);
  else for (const child of pane.children) leavesOf(child, out);
  return out;
}

/**
 * The duplicate-attach guard: the first remote-terminal tab showing
 * `sessionId` of `hostId`, in any workspace (visible tree or stash).
 */
export function findRemoteSurface(
  state: { workspaces: readonly Workspace[] },
  hostId: string,
  sessionId: string,
): RemoteSurfaceHit | null {
  for (const ws of state.workspaces) {
    const leaves = leavesOf(ws.rootPane);
    for (const entry of ws.stashedPanes ?? []) if (entry?.pane?.type === 'leaf') leaves.push(entry.pane);
    for (const leaf of leaves) {
      for (const s of leaf.surfaces) {
        if (s.surfaceType === 'remote-terminal' && s.remoteHostId === hostId && s.remoteSessionId === sessionId) {
          return { workspaceId: ws.id, paneId: leaf.id, surfaceId: s.id };
        }
      }
    }
  }
  return null;
}

interface BuildContext {
  wsId: string;
  hostId: string;
  row: PcRailWorkspaceRow;
  copy: ShadowCopy;
  /** Sessions open as a tab outside this shadow, with that workspace's name. */
  elsewhere: (sessionId: string) => string | null;
  placed: Set<string>;
}

function placeholder(id: string, title: string): Surface {
  return { id, ptyId: '', title, shell: '', cwd: '', surfaceType: 'placeholder' };
}

function remoteTab(ctx: BuildContext, sessionId: string): Surface {
  const pane = ctx.row.panes.find((p) => p.sessionId === sessionId);
  const surface = createRemoteSurface(ctx.hostId, sessionId, pane?.shell ?? '', pane?.cwd ?? '', false, ctx.row.id);
  // Namespaced like every other id in the tree.
  surface.id = `${ctx.wsId}#s:${sessionId}`;
  return surface;
}

/** One tab of the host's tree, or a placeholder when this desktop cannot show it. */
function toSurface(ctx: BuildContext, s: PhoneLayoutSurface): Surface {
  const id = `${ctx.wsId}#t:${s.surfaceId}`;
  if (s.kind !== 'terminal') return placeholder(id, ctx.copy.browserNotShown);
  const sessionId = s.ptyId;
  if (!sessionId || ctx.placed.has(sessionId) || !ctx.row.panes.some((p) => p.sessionId === sessionId)) {
    return placeholder(id, s.title || ctx.copy.terminal);
  }
  ctx.placed.add(sessionId);
  const other = ctx.elsewhere(sessionId);
  // `#u:<session>` marks the slot so reconcile does not add the session again.
  if (other !== null) return placeholder(`${ctx.wsId}#u:${sessionId}`, ctx.copy.openElsewhere(other));
  return remoteTab(ctx, sessionId);
}

function toPane(ctx: BuildContext, node: PhoneLayoutNode, path: string, depth = 0): Pane | null {
  // parseRemoteLayout already bounds depth; this keeps the recursion finite on its own.
  if (depth > 32) return null;
  if (node.kind === 'leaf') {
    const surfaces = node.surfaces.map((s) => toSurface(ctx, s));
    if (surfaces.length === 0) return null;
    const active = surfaces[node.activeIndex ?? 0] ?? surfaces[0];
    return { id: `${ctx.wsId}#p:${node.paneId}`, type: 'leaf', surfaces, activeSurfaceId: active.id };
  }
  const kept: { pane: Pane; size: number | undefined }[] = [];
  node.children.forEach((child, i) => {
    const pane = toPane(ctx, child, `${path}.${i}`, depth + 1);
    if (pane) kept.push({ pane, size: node.sizes[i] });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0].pane;
  const total = kept.reduce((sum, k) => sum + (k.size ?? 0), 0);
  const sizes = kept.every((k) => typeof k.size === 'number') && total > 0
    ? kept.map((k) => ((k.size as number) / total) * 100)
    : undefined;
  return {
    id: `${ctx.wsId}#b:${path}`,
    type: 'branch',
    direction: node.direction,
    children: kept.map((k) => k.pane),
    ...(sizes ? { sizes } : {}),
  };
}

/** Sessions of the row no leaf placed: appended to the first leaf, in row order. */
function appendUnplaced(ctx: BuildContext, root: Pane | null): Pane {
  const rest = ctx.row.panes.filter((p) => !ctx.placed.has(p.sessionId));
  const extra: Surface[] = [];
  for (const p of rest) {
    ctx.placed.add(p.sessionId);
    const other = ctx.elsewhere(p.sessionId);
    extra.push(other !== null
      ? placeholder(`${ctx.wsId}#u:${p.sessionId}`, ctx.copy.openElsewhere(other))
      : remoteTab(ctx, p.sessionId));
  }
  if (root) {
    if (extra.length > 0) leavesOf(root)[0].surfaces.push(...extra);
    return root;
  }
  // No layout (the host's window is locked, occluded or headless) or nothing
  // usable in it: one leaf, one tab per pane.
  return {
    id: `${ctx.wsId}#p:flat`,
    type: 'leaf',
    surfaces: extra,
    activeSurfaceId: extra[0]?.id ?? '',
  };
}

/**
 * Build the shadow of one host row. Null when the ids cannot form a shadow id
 * or the row has nothing to show (an `empty` row, or no pane this desktop
 * could attach). `elsewhere` reports sessions already open as a tab in another
 * workspace; those become "Open in …" placeholders so no second viewer opens.
 */
export function buildShadowWorkspace(
  hostId: string,
  row: PcRailWorkspaceRow,
  copy: ShadowCopy,
  elsewhere: (sessionId: string) => string | null,
): Workspace | null {
  const wsId = formatShadowWorkspaceId(hostId, row.id);
  if (!wsId || row.panes.length === 0) return null;
  const ctx: BuildContext = { wsId, hostId, row, copy, elsewhere, placed: new Set() };
  const root = appendUnplaced(ctx, row.layout ? toPane(ctx, row.layout.root, 'r') : null);
  const leaves = leavesOf(root);
  if (!leaves.some((l) => l.surfaces.some((s) => s.surfaceType === 'remote-terminal'))) return null;
  const preferred = row.layout?.activePaneId ? `${wsId}#p:${row.layout.activePaneId}` : undefined;
  const activePaneId = leaves.find((l) => l.id === preferred)?.id ?? leaves[0].id;
  return {
    id: wsId,
    // A host that sends no name (an old host, or a locked desktop) is named by its id.
    name: row.name || row.id,
    rootPane: root,
    activePaneId,
  };
}

/** Drop empty leaves and fold single-child branches. Null when nothing is left. */
function collapse(pane: Pane): Pane | null {
  if (pane.type === 'leaf') return pane.surfaces.length > 0 ? pane : null;
  const children: Pane[] = [];
  const sizes: number[] = [];
  pane.children.forEach((child, i) => {
    const kept = collapse(child);
    if (!kept) return;
    children.push(kept);
    if (pane.sizes) sizes.push(pane.sizes[i] ?? 0);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0);
  return {
    ...pane,
    children,
    ...(pane.sizes && total > 0 ? { sizes: sizes.map((s) => (s / total) * 100) } : {}),
  };
}

export type ShadowReconcile =
  | { kind: 'unchanged' }
  | { kind: 'close' }
  | { kind: 'update'; rootPane: Pane; activePaneId: string; name: string };

/**
 * The host owns membership. Against the host's current row (the last
 * successful list; a failed tick keeps it, so a transient failure never
 * removes a tab):
 *
 *   - a remote tab whose session the row no longer lists is removed
 *   - a listed session no tab shows is added to the first leaf
 *   - empty leaves collapse; a tree with no remote tab left closes the shadow
 *   - a row the list no longer carries (`row` null) closes it
 *
 * Placeholders and local browser tabs are kept while a remote tab remains.
 */
export function reconcileShadowWorkspace(
  ws: Workspace,
  hostId: string,
  row: PcRailWorkspaceRow | null,
): ShadowReconcile {
  if (!row || row.panes.length === 0) return { kind: 'close' };
  const listed = new Set(row.panes.map((p) => p.sessionId));
  let changed = false;
  const shown = new Set<string>();
  const prune = (pane: Pane): Pane => {
    if (pane.type === 'branch') return { ...pane, children: pane.children.map(prune) };
    const surfaces = pane.surfaces.filter((s) => {
      if (s.surfaceType !== 'remote-terminal') return true;
      if (s.remoteHostId === hostId && s.remoteSessionId && listed.has(s.remoteSessionId)) {
        shown.add(s.remoteSessionId);
        return true;
      }
      changed = true;
      return false;
    });
    if (surfaces.length === pane.surfaces.length) return pane;
    const activeSurfaceId = surfaces.some((s) => s.id === pane.activeSurfaceId) ? pane.activeSurfaceId : (surfaces[0]?.id ?? '');
    return { ...pane, surfaces, activeSurfaceId };
  };
  let root: Pane | null = collapse(prune(ws.rootPane));
  // A local split leaves an empty leaf behind (EmptyLeafFunnel gives it no shell).
  if (root && leavesOf(root).length !== leavesOf(ws.rootPane).length) changed = true;
  // Sessions shown as an "Open in …" placeholder count as shown: they are open elsewhere.
  const placeholders = new Set<string>();
  if (root) {
    for (const leaf of leavesOf(root)) {
      for (const s of leaf.surfaces) {
        const m = s.surfaceType === 'placeholder' ? /#u:(.+)$/.exec(s.id) : null;
        if (m) placeholders.add(m[1]);
      }
    }
  }
  const added = row.panes.filter((p) => !shown.has(p.sessionId) && !placeholders.has(p.sessionId));
  if (added.length > 0 && root) {
    const first = leavesOf(root)[0];
    const tabs = added.map((p) => {
      const surface = createRemoteSurface(hostId, p.sessionId, p.shell ?? '', p.cwd ?? '', false, row.id);
      surface.id = `${ws.id}#s:${p.sessionId}`;
      return surface;
    });
    root = replaceLeaf(root, first.id, { ...first, surfaces: [...first.surfaces, ...tabs] });
    changed = true;
  }
  if (!root || !leavesOf(root).some((l) => l.surfaces.some((s) => s.surfaceType === 'remote-terminal'))) {
    return { kind: 'close' };
  }
  const name = row.name || row.id;
  if (!changed && name === ws.name) return { kind: 'unchanged' };
  const leaves = leavesOf(root);
  const activePaneId = leaves.some((l) => l.id === ws.activePaneId) ? ws.activePaneId : leaves[0].id;
  return { kind: 'update', rootPane: changed ? root : ws.rootPane, activePaneId, name };
}

function replaceLeaf(pane: Pane, id: string, next: PaneLeaf): Pane {
  if (pane.type === 'leaf') return pane.id === id ? next : pane;
  return { ...pane, children: pane.children.map((c) => replaceLeaf(c, id, next)) };
}

/**
 * Which shadows to close so at most `limit` stay live, least recently used
 * first. The active workspace is never chosen. `usedAt` maps a shadow id to
 * when it was last active (absent counts as oldest).
 */
export function shadowsToEvict(
  shadowIds: readonly string[],
  activeId: string,
  usedAt: Readonly<Record<string, number>>,
  limit = SHADOW_WORKSPACE_LIMIT,
): string[] {
  if (shadowIds.length <= limit) return [];
  const candidates = shadowIds
    .filter((id) => id !== activeId)
    .sort((a, b) => (usedAt[a] ?? 0) - (usedAt[b] ?? 0));
  return candidates.slice(0, shadowIds.length - limit);
}

/**
 * A session.json snapshot with every shadow left out: shadows are projections
 * of another computer and are never persisted. With a shadow active, the save
 * names the local workspace the PC rail remembers, else the first local one.
 */
export function withoutShadowWorkspaces(
  data: SessionData,
  state: { pcRail?: { lastWorkspaceByPc: Record<string, string> } },
): SessionData {
  const workspaces = data.workspaces.filter((ws) => !isShadowWorkspaceId(ws.id));
  if (workspaces.length === data.workspaces.length && !isShadowWorkspaceId(data.activeWorkspaceId)) return data;
  const remembered = state.pcRail?.lastWorkspaceByPc[LOCAL_PC_ID];
  const activeWorkspaceId = isShadowWorkspaceId(data.activeWorkspaceId)
    ? (workspaces.find((w) => w.id === remembered) ?? workspaces[0])?.id ?? ''
    : data.activeWorkspaceId;
  return { ...data, workspaces, activeWorkspaceId };
}
