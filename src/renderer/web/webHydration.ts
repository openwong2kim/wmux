/**
 * Store hydration for the browser build (wmux web `/app`).
 *
 * The desktop owns the workspace tree; the browser only mirrors it. Every
 * poll reads `GET /api/workspaces` (rows + the per-workspace `layout` tree,
 * docs/phone-client-contract.md "Workspace layout tree") and `GET /api/sessions`
 * (tab titles), and converts them into the renderer's own `Workspace` objects
 * so the desktop components render them unchanged.
 *
 * Two rules keep React from remounting anything between polls:
 *  - ids are the desktop's own (`paneId`, `surfaceId`), and a split's id is
 *    derived from its first leaf and depth, so an unchanged tree produces the
 *    same ids every time;
 *  - a workspace whose inputs did not change keeps its previous object, so
 *    its memoized slot bails out of the re-render entirely.
 *
 * Selection (active workspace / pane / tab) is shared between the desktop and
 * whoever taps in the browser: a server value is applied when it CHANGED since
 * the previous poll (the desktop user moved focus), otherwise the local choice
 * stands. A local id that no longer exists falls back to the server's.
 *
 * Only GETs are issued here. Nothing in this module writes to the daemon.
 */
import type { AgentStatus, GitSyncStatus, Pane, PaneLeaf, Surface, Workspace } from '../../shared/types';
import type { PhoneLayoutNode, PhoneLayoutSurface } from '../../shared/phoneFleetSidebar';
import { WORKSPACE_COLOR_IDS, type WorkspaceColorId } from '../../shared/workspaceColors';

/** One `panes[]` entry of `GET /api/workspaces`. */
export interface WebPaneRow {
  sessionId: string;
  shell?: string;
  cwd?: string;
  paneId?: string;
  agentName?: string;
  agentStatus?: string;
}

export interface WebWorkspaceRow {
  id: string;
  name: string;
  panes: WebPaneRow[];
  order?: number;
  pinned?: boolean;
  color?: string;
  gitBranch?: string;
  gitIsWorktree?: boolean;
  gitSync?: { ahead: number; behind: number; hasUpstream: boolean };
  layout?: { root: PhoneLayoutNode; activePaneId?: string; unplaced?: string[] };
}

export interface WebWorkspacesReply {
  workspaces: WebWorkspaceRow[];
  activeWorkspaceId?: string;
}

export interface WebSessionRow {
  id: string;
  surfaceTitle?: string;
  paneName?: string;
  paneId?: string;
}

export interface WebSessionsReply {
  sessions: WebSessionRow[];
}

/** The slice of store state hydration writes. */
export interface WebHydratedState {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  sidebarPinnedIds: string[];
  surfaceAgent: Record<string, { name: string; status: AgentStatus }>;
  /** Pane names the user typed on the desktop (not auto names), by pane id. */
  paneLabel: Record<string, string>;
}

/**
 * The desktop's pane name (`/api/sessions` `paneName`) is either its auto name
 * `w<ws>-<pane>` (with an optional `(<agent>)` suffix) or a user label. The
 * auto name carries the two ordinals the tab strip rebuilds it from.
 */
const AUTO_PANE_NAME = /^w(\d+)-(\d+)(?:\(.*\))?$/;
export function parsePaneName(name: string | undefined): { wsOrdinal: number; ordinal: number } | { label: string } | null {
  if (!name) return null;
  const m = AUTO_PANE_NAME.exec(name);
  return m ? { wsOrdinal: Number(m[1]), ordinal: Number(m[2]) } : { label: name };
}

/** Server-side selection seen on the previous poll, keyed per workspace / pane. */
export interface ServerSelection {
  activeWorkspaceId?: string;
  activePane: Record<string, string>;
  activeSurface: Record<string, string>;
}

const AGENT_STATUSES: ReadonlySet<string> = new Set(['running', 'complete', 'error', 'waiting', 'awaiting_input', 'idle']);
const COLOR_IDS: ReadonlySet<string> = new Set(WORKSPACE_COLOR_IDS);

function placeholderTitle(s: PhoneLayoutSurface): string {
  if (s.title) return s.title;
  return s.kind === 'terminal' ? 'Terminal' : s.kind;
}

function toSurface(s: PhoneLayoutSurface, panes: Map<string, WebPaneRow>, titles: Map<string, string>): Surface {
  const pane = s.ptyId ? panes.get(s.ptyId) : undefined;
  if (s.kind === 'terminal' && s.ptyId && pane) {
    return {
      id: s.surfaceId,
      ptyId: s.ptyId,
      title: titles.get(s.ptyId) ?? pane.shell ?? 'Terminal',
      shell: pane.shell ?? '',
      cwd: pane.cwd ?? '',
      surfaceType: 'terminal',
    };
  }
  // Anything the browser cannot show — a non-terminal tab, or a terminal slot
  // with no listed session — becomes a placeholder, so no component that owns
  // a PTY (or a webview, or a file) is ever mounted for it.
  return { id: s.surfaceId, ptyId: '', title: placeholderTitle(s), shell: '', cwd: '', surfaceType: 'placeholder' };
}

function firstLeafId(node: PhoneLayoutNode): string {
  return node.kind === 'leaf' ? node.paneId : firstLeafId(node.children[0]);
}

function toPane(
  node: PhoneLayoutNode,
  depth: number,
  panes: Map<string, WebPaneRow>,
  titles: Map<string, string>,
  ordinals: Map<string, number>,
): Pane {
  if (node.kind === 'leaf') {
    const surfaces = node.surfaces.map((s) => toSurface(s, panes, titles));
    const active = surfaces[node.activeIndex ?? 0] ?? surfaces[0];
    const ordinal = ordinals.get(node.paneId);
    return {
      id: node.paneId, type: 'leaf', surfaces, activeSurfaceId: active?.id ?? '',
      ...(ordinal !== undefined ? { ordinal } : {}),
    };
  }
  return {
    id: `web-split:${firstLeafId(node)}:${depth}`,
    type: 'branch',
    direction: node.direction,
    sizes: node.sizes,
    children: node.children.map((c) => toPane(c, depth + 1, panes, titles, ordinals)),
  };
}

/** A workspace without a layout tree (desktop off or too old): one pane, one tab per session. */
function flatPane(row: WebWorkspaceRow, titles: Map<string, string>): PaneLeaf {
  const surfaces: Surface[] = row.panes.map((p) => ({
    id: `web-surface:${p.sessionId}`,
    ptyId: p.sessionId,
    title: titles.get(p.sessionId) ?? p.shell ?? 'Terminal',
    shell: p.shell ?? '',
    cwd: p.cwd ?? '',
    surfaceType: 'terminal',
  }));
  return { id: `web-pane:${row.id}`, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
}

function leaves(pane: Pane, out: PaneLeaf[] = []): PaneLeaf[] {
  if (pane.type === 'leaf') out.push(pane);
  else for (const c of pane.children) leaves(c, out);
  return out;
}

function gitSyncOf(row: WebWorkspaceRow): GitSyncStatus | undefined {
  if (!row.gitSync) return undefined;
  return { dirty: 0, ahead: row.gitSync.ahead, behind: row.gitSync.behind, hasUpstream: row.gitSync.hasUpstream };
}

function buildWorkspace(
  row: WebWorkspaceRow,
  titles: Map<string, string>,
  paneNames: Map<string, string>,
): Workspace {
  const panes = new Map(row.panes.map((p) => [p.sessionId, p]));
  const ordinals = new Map<string, number>();
  let wsOrdinal: number | undefined;
  for (const [paneId, name] of paneNames) {
    const parsed = parsePaneName(name);
    if (parsed && 'ordinal' in parsed) {
      ordinals.set(paneId, parsed.ordinal);
      wsOrdinal ??= parsed.wsOrdinal;
    }
  }
  const rootPane = row.layout ? toPane(row.layout.root, 0, panes, titles, ordinals) : flatPane(row, titles);
  const leafIds = leaves(rootPane).map((l) => l.id);
  const activePaneId = row.layout?.activePaneId && leafIds.includes(row.layout.activePaneId)
    ? row.layout.activePaneId
    : leafIds[0] ?? '';
  const gitSync = gitSyncOf(row);
  return {
    id: row.id,
    name: row.name || 'Workspace',
    rootPane,
    activePaneId,
    ...(wsOrdinal !== undefined ? { wsOrdinal } : {}),
    ...(row.color && COLOR_IDS.has(row.color) ? { color: row.color as WorkspaceColorId } : {}),
    metadata: {
      ...(row.gitBranch ? { gitBranch: row.gitBranch } : {}),
      ...(row.gitIsWorktree !== undefined ? { gitIsWorktree: row.gitIsWorktree } : {}),
      ...(gitSync ? { gitSync } : {}),
    },
  };
}

/**
 * Apply the selection rule (see the module comment) to a freshly built
 * workspace, given the workspace currently in the store (if any).
 */
function mergeSelection(
  built: Workspace,
  current: Workspace | undefined,
  lastServer: ServerSelection,
  nextServer: ServerSelection,
): Workspace {
  nextServer.activePane[built.id] = built.activePaneId;
  const builtLeaves = leaves(built.rootPane);
  for (const leaf of builtLeaves) nextServer.activeSurface[leaf.id] = leaf.activeSurfaceId;
  if (!current) return built;

  const currentLeaves = new Map(leaves(current.rootPane).map((l) => [l.id, l]));
  const keepPane = lastServer.activePane[built.id] === built.activePaneId
    && builtLeaves.some((l) => l.id === current.activePaneId);
  let changed = false;
  const patchLeaf = (pane: Pane): Pane => {
    if (pane.type === 'branch') {
      const children = pane.children.map(patchLeaf);
      return children.every((c, i) => c === pane.children[i]) ? pane : { ...pane, children };
    }
    const local = currentLeaves.get(pane.id)?.activeSurfaceId;
    const keep = local !== undefined
      && local !== pane.activeSurfaceId
      && lastServer.activeSurface[pane.id] === pane.activeSurfaceId
      && pane.surfaces.some((s) => s.id === local);
    if (!keep) return pane;
    changed = true;
    return { ...pane, activeSurfaceId: local };
  };
  const rootPane = patchLeaf(built.rootPane);
  if (keepPane && current.activePaneId !== built.activePaneId) changed = true;
  if (!changed) return built;
  return { ...built, rootPane, activePaneId: keepPane ? current.activePaneId : built.activePaneId };
}

/** Workspaces sort pinned-first, then by the desktop's manual order. */
function sortRows(rows: WebWorkspaceRow[]): WebWorkspaceRow[] {
  return [...rows].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
  });
}

export interface HydrationInput {
  workspacesReply: WebWorkspacesReply;
  sessionsReply: WebSessionsReply | null;
  current: { workspaces: Workspace[]; activeWorkspaceId: string };
  lastServer: ServerSelection;
  /** Previously built workspace per id, with the JSON of the inputs it was built from. */
  cache: Map<string, { key: string; built: Workspace }>;
}

export function hydrateWebState(input: HydrationInput): { state: WebHydratedState; server: ServerSelection } {
  const { workspacesReply, sessionsReply, current, lastServer, cache } = input;
  const titles = new Map<string, string>();
  const paneNameBySession = new Map<string, { paneId: string; name: string }>();
  const paneLabel: Record<string, string> = {};
  for (const s of sessionsReply?.sessions ?? []) {
    if (s.surfaceTitle) titles.set(s.id, s.surfaceTitle);
    if (s.paneId && s.paneName) {
      paneNameBySession.set(s.id, { paneId: s.paneId, name: s.paneName });
      const parsed = parsePaneName(s.paneName);
      if (parsed && 'label' in parsed) paneLabel[s.paneId] = parsed.label;
    }
  }
  const server: ServerSelection = { activeWorkspaceId: workspacesReply.activeWorkspaceId, activePane: {}, activeSurface: {} };
  const currentById = new Map(current.workspaces.map((w) => [w.id, w]));
  const rows = sortRows(workspacesReply.workspaces);
  const workspaces = rows.map((row) => {
    const rowTitles = new Map<string, string>();
    const rowPaneNames = new Map<string, string>();
    for (const p of row.panes) {
      const title = titles.get(p.sessionId);
      if (title !== undefined) rowTitles.set(p.sessionId, title);
      const named = paneNameBySession.get(p.sessionId);
      if (named) rowPaneNames.set(named.paneId, named.name);
    }
    const key = JSON.stringify([row, [...rowTitles], [...rowPaneNames]]);
    const hit = cache.get(row.id);
    const built = hit && hit.key === key ? hit.built : buildWorkspace(row, rowTitles, rowPaneNames);
    cache.set(row.id, { key, built });
    const merged = mergeSelection(built, currentById.get(row.id), lastServer, server);
    // Nothing changed: hand back the very object the store already holds so
    // the memoized slot does not re-render.
    const prev = currentById.get(row.id);
    return prev && JSON.stringify(prev) === JSON.stringify(merged) ? prev : merged;
  });
  for (const id of [...cache.keys()]) if (!rows.some((r) => r.id === id)) cache.delete(id);

  const ids = workspaces.map((w) => w.id);
  const serverActive = workspacesReply.activeWorkspaceId;
  const localValid = ids.includes(current.activeWorkspaceId);
  const serverMoved = serverActive !== undefined && serverActive !== lastServer.activeWorkspaceId && ids.includes(serverActive);
  const activeWorkspaceId = serverMoved || !localValid
    ? (serverActive && ids.includes(serverActive) ? serverActive : ids[0] ?? '')
    : current.activeWorkspaceId;

  const surfaceAgent: WebHydratedState['surfaceAgent'] = {};
  for (const row of workspacesReply.workspaces) {
    for (const p of row.panes) {
      if (p.agentName && p.agentStatus && AGENT_STATUSES.has(p.agentStatus)) {
        surfaceAgent[p.sessionId] = { name: p.agentName, status: p.agentStatus as AgentStatus };
      }
    }
  }
  return {
    state: {
      workspaces,
      activeWorkspaceId,
      sidebarPinnedIds: rows.filter((r) => r.pinned).map((r) => r.id),
      surfaceAgent,
      paneLabel,
    },
    server,
  };
}
