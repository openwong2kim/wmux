// ─── Fan-out provenance for the sidebar (#1481) ──────────────────────────────
//
// Who fanned a task workspace out, from where, and when. Joined from two
// sources the renderer can already read:
//
//   - the fan-out audit log (main, `fanout-audit.jsonl`, read over the
//     existing `fanout.recentAudit` IPC): its `launched` records map each task
//     workspace to its owner and to how the caller proved who it was
//     (`gui` / `commander` / `pty`, plus the calling pane's ptyId on new
//     records);
//   - the task ledger (`missionByPaneGroup`): owner and creation time, and the
//     detached marker.
//
// Pure helpers only — the slice owns fetching and caching.

import type { WorkTask } from '../../shared/workTask';
import type { Workspace } from '../../shared/types';
import type { TranslationKey } from '../i18n/locales/en';
import { getWorkspaceLeafPanes } from '../../shared/paneUtils';
import { computePaneAutoName, paneDisplayName } from './paneNaming';
import type { FanoutOrigin } from '../../shared/fanoutOrigin';

/** The subset of a main-side FanOutAuditRecord this module reads. */
export interface FanoutAuditLike {
  at: number;
  kind?: 'start' | 'launched';
  ownerWorkspaceId: string;
  callerIdentity: 'pty' | 'commander' | 'gui';
  callerPtyId?: string;
  launched?: { title: string; workspaceId?: string; error?: string }[];
}

export interface FanoutProvenance {
  ownerWorkspaceId: string;
  callerIdentity: 'pty' | 'commander' | 'gui';
  callerPtyId?: string;
  at: number;
}

/**
 * task workspace id → provenance, from audit records in any order. The newest
 * `launched` record for a workspace wins (a workspace id is never reused, so
 * in practice there is exactly one).
 */
export function provenanceFromAudit(records: readonly FanoutAuditLike[]): Record<string, FanoutProvenance> {
  const out: Record<string, FanoutProvenance> = {};
  const launched = records
    .filter((r) => r && r.kind === 'launched' && Array.isArray(r.launched))
    .sort((a, b) => a.at - b.at);
  for (const record of launched) {
    for (const task of record.launched ?? []) {
      if (!task.workspaceId || task.error) continue;
      out[task.workspaceId] = {
        ownerWorkspaceId: record.ownerWorkspaceId,
        callerIdentity: record.callerIdentity,
        ...(record.callerPtyId ? { callerPtyId: record.callerPtyId } : {}),
        at: record.at,
      };
    }
  }
  return out;
}

export function sameProvenance(
  a: Record<string, FanoutProvenance>,
  b: Record<string, FanoutProvenance>,
): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) {
    const x = a[k];
    const y = b[k];
    if (!y || x.ownerWorkspaceId !== y.ownerWorkspaceId || x.callerIdentity !== y.callerIdentity
      || x.callerPtyId !== y.callerPtyId || x.at !== y.at) return false;
  }
  return true;
}

/** Prefix FanOutService gives every task workspace's stored name. */
export const TASK_WORKSPACE_PREFIX = 'wtask: ';

/**
 * The name a task workspace is SHOWN under: the stored name without the
 * `wtask: ` prefix. Render-side only — the stored name (and rename input)
 * keep it. A workspace the user renamed away from the prefix is shown as-is.
 */
export function displayWorkspaceName(name: string, isTask: boolean): string {
  if (!isTask || !name.startsWith(TASK_WORKSPACE_PREFIX)) return name;
  const stripped = name.slice(TASK_WORKSPACE_PREFIX.length).trim();
  return stripped || name;
}

/** How a task workspace relates to the workspace that fanned it out. */
export interface TaskLink {
  /** Owner workspace id, or '' when no source names one. */
  ownerId: string;
  /** Detached from its owner (task ledger marker) — renders top-level. */
  detached: boolean;
}

/**
 * Resolve a workspace's task link from durable evidence only. The ledger
 * record is authoritative (it knows about detach); main's lineage stamp —
 * written before the task's agent launched, kept on disk — answers when the
 * ledger record is not loaded (e.g. its owner is closed); the spawn stamp
 * bridges the moments before either exists. The audit log is NOT consulted:
 * it only names the caller, and its window is bounded. Nor is the name — a
 * workspace someone named `wtask: …` is not a task.
 */
export function resolveTaskLink(
  mission: WorkTask | undefined,
  lineageOwner?: string,
  spawnOwner?: string,
): TaskLink | null {
  if (mission) {
    return { ownerId: mission.owner?.verifiedWorkspaceId ?? '', detached: mission.detachedAt !== undefined };
  }
  if (lineageOwner) return { ownerId: lineageOwner, detached: false };
  if (spawnOwner) return { ownerId: spawnOwner, detached: false };
  return null;
}

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/**
 * The caller half of the tooltip: the GUI user, the orchestrator, or the pane
 * (its label, else its agent) that asked. A pane caller whose pane cannot be
 * found (closed since, or an older record without a ptyId) reads generically.
 */
export function provenanceCallerLabel(
  provenance: Pick<FanoutProvenance, 'callerIdentity' | 'callerPtyId'> | undefined,
  resolvePane: (ptyId: string) => string | undefined,
  t: T,
): string | undefined {
  if (!provenance) return undefined;
  switch (provenance.callerIdentity) {
    case 'gui':
      return t('sidebar.provenance.callerGui');
    case 'commander':
      return t('sidebar.provenance.callerOrchestrator');
    case 'pty': {
      const pane = provenance.callerPtyId ? resolvePane(provenance.callerPtyId) : undefined;
      return pane ?? t('sidebar.provenance.callerPane');
    }
    default:
      return undefined;
  }
}

/** "Fanned out by <owner> · <caller> · <time>", dropping the parts not known. */
export function provenanceTooltip(
  parts: { ownerName?: string; caller?: string; when?: string },
  t: T,
): string {
  const segments = [
    t('sidebar.provenance.by', { owner: parts.ownerName || t('sidebar.provenance.closedOwner') }),
    parts.caller,
    parts.when,
  ].filter((part): part is string => !!part);
  return segments.join(' · ');
}

/**
 * Name the pane behind a caller ptyId: its label (explicit, else the auto
 * `w<ws>-<pane>` coordinate) and, when an agent runs there, the agent's name.
 * Undefined when no open pane holds that ptyId any more.
 */
export function resolveCallerPane(
  state: {
    workspaces: readonly Workspace[];
    paneLabel?: Record<string, string | undefined>;
    surfaceAgent?: Record<string, { name?: string } | undefined>;
  },
  ptyId: string,
): string | undefined {
  for (const ws of state.workspaces) {
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      if (!leaf.surfaces.some((s) => s.ptyId === ptyId)) continue;
      const label = paneDisplayName(state.paneLabel?.[leaf.id], computePaneAutoName(ws.wsOrdinal ?? 0, leaf.ordinal ?? 0));
      const agent = state.surfaceAgent?.[ptyId]?.name;
      return agent ? `${label} (${agent})` : label;
    }
  }
  return undefined;
}

// ─── Requester: which pane asked for a task ─────────────────────────────────
//
// Only the lineage stamp's `origin` can name a requesting pane: it holds the
// pane's stable ids (surfaceId/paneId, recorded when the task pane was
// created) and a snapshot of its name. The audit record's caller ptyId is NOT
// resolved against the current layout — PTY ids are reused and rebound across
// restarts and recovery, so a match there can be an unrelated pane. For tasks
// without an origin the audit only says GUI or orchestrator; a pane caller
// there reads as unknown. Never guessed.

type RequesterState = {
  workspaces: readonly Workspace[];
  paneLabel?: Record<string, string | undefined>;
  surfaceAgent?: Record<string, { name?: string } | undefined>;
  fanoutOrigin?: Record<string, FanoutOrigin | undefined>;
  fanoutProvenance?: Record<string, FanoutProvenance | undefined>;
};

type Leaf = ReturnType<typeof getWorkspaceLeafPanes>[number];
type LeafSurface = Leaf['surfaces'][number];
interface SurfaceLoc { ws: Workspace; leaf: Leaf; surface: LeafSurface }
interface LayoutIndex {
  bySurface: Map<string, SurfaceLoc>;
  byPty: Map<string, SurfaceLoc>;
  byPane: Map<string, { ws: Workspace; leaf: Leaf }>;
}

/** Surface / pty / pane lookups over one layout, built once per workspaces
 *  array (the store replaces it on every layout change), so a row resolving
 *  its requester on each store update costs map lookups, not a tree walk. */
const layoutIndexCache = new WeakMap<readonly Workspace[], LayoutIndex>();

function layoutIndex(workspaces: readonly Workspace[]): LayoutIndex {
  const cached = layoutIndexCache.get(workspaces);
  if (cached) return cached;
  const index: LayoutIndex = { bySurface: new Map(), byPty: new Map(), byPane: new Map() };
  for (const ws of workspaces) {
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      index.byPane.set(leaf.id, { ws, leaf });
      for (const surface of leaf.surfaces) {
        const loc = { ws, leaf, surface };
        index.bySurface.set(surface.id, loc);
        if (surface.ptyId) index.byPty.set(surface.ptyId, loc);
      }
    }
  }
  layoutIndexCache.set(workspaces, index);
  return index;
}

/** `w<ws>-<pane> · <label or agent>`, or the bare coordinate. The coordinate
 *  leads: it is what tells two panes of one workspace apart, so a narrow row
 *  truncates the name, never it. One format for the launch-time snapshot and
 *  the live label, so the text does not change when the pane closes. */
export function formatRequesterPaneLabel(parts: { label?: string; agent?: string; coord: string }): string {
  const name = parts.label?.trim() || parts.agent?.trim();
  return name && name !== parts.coord ? `${parts.coord} · ${name}` : parts.coord;
}

/** Snapshots stamped before the coordinate led read `<name> · w<ws>-<pane>`;
 *  shown coordinate-first like every other requester label. */
const TRAILING_COORD = /^(.+) · (w\d+-\d+)$/;
export function coordinateFirst(label: string): string {
  const m = TRAILING_COORD.exec(label);
  return m ? `${m[2]} · ${m[1]}` : label;
}

interface PaneHit {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
  label: string;
}

function describe(state: RequesterState, loc: SurfaceLoc): PaneHit {
  const agent = loc.surface.ptyId ? state.surfaceAgent?.[loc.surface.ptyId]?.name : undefined;
  return {
    workspaceId: loc.ws.id,
    paneId: loc.leaf.id,
    surfaceId: loc.surface.id,
    label: formatRequesterPaneLabel({
      label: state.paneLabel?.[loc.leaf.id],
      agent,
      coord: computePaneAutoName(loc.ws.wsOrdinal ?? 0, loc.leaf.ordinal ?? 0),
    }),
  };
}

/**
 * The open surface an origin names. A recorded surfaceId is looked up on its
 * own, anywhere: if no pane holds it any more the requester is gone, even when
 * its old pane still exists with other tabs (that pane's active tab is not the
 * one that asked). Only an origin without a surfaceId falls back to its pane's
 * active tab.
 */
function findOriginSurface(state: RequesterState, origin: FanoutOrigin): PaneHit | undefined {
  const index = layoutIndex(state.workspaces);
  if (origin.surfaceId) {
    const loc = index.bySurface.get(origin.surfaceId);
    return loc ? describe(state, loc) : undefined;
  }
  if (!origin.paneId) return undefined;
  const pane = index.byPane.get(origin.paneId);
  if (!pane) return undefined;
  const surface = pane.leaf.surfaces.find((s) => s.id === pane.leaf.activeSurfaceId) ?? pane.leaf.surfaces[0];
  return surface ? describe(state, { ws: pane.ws, leaf: pane.leaf, surface }) : undefined;
}

/**
 * The origin to stamp for a fan-out caller, resolved from the renderer's
 * layout once, when the fan-out is requested. A pane caller no open pane
 * holds yields undefined — an origin without ids would be stamped for good and
 * could never name the pane, so the task reads as "requester unknown"
 * instead. So does a pane outside `ownerWorkspaceId` (when given): the
 * requester is a pane of the workspace that owns the fan-out, or nobody.
 */
export function originFromCaller(state: RequesterState, caller: unknown, ownerWorkspaceId?: string): FanoutOrigin | undefined {
  if (!caller || typeof caller !== 'object') return undefined;
  const c = caller as { kind?: unknown; ptyId?: unknown };
  if (c.kind === 'gui' || c.kind === 'orchestrator') return { kind: c.kind };
  if (c.kind !== 'pane' || typeof c.ptyId !== 'string' || !c.ptyId) return undefined;
  const loc = layoutIndex(state.workspaces).byPty.get(c.ptyId);
  if (!loc) return undefined;
  if (ownerWorkspaceId !== undefined && loc.ws.id !== ownerWorkspaceId) return undefined;
  const hit = describe(state, loc);
  return { kind: 'pane', paneId: hit.paneId, surfaceId: hit.surfaceId, label: hit.label };
}

export type TaskRequester =
  /** An open pane — `label` is its current name; click jumps there. */
  | { kind: 'pane'; live: true; label: string; workspaceId: string; paneId: string; surfaceId: string }
  /** The requesting pane is gone; `label` is its name at launch. */
  | { kind: 'pane'; live: false; label?: string }
  | { kind: 'gui' }
  | { kind: 'orchestrator' }
  | { kind: 'unknown' };

/** Who asked for task workspace `taskWorkspaceId`. */
export function resolveTaskRequester(state: RequesterState, taskWorkspaceId: string): TaskRequester {
  const origin = state.fanoutOrigin?.[taskWorkspaceId];
  if (origin) {
    if (origin.kind !== 'pane') return { kind: origin.kind };
    const hit = findOriginSurface(state, origin);
    if (hit) return { kind: 'pane', live: true, ...hit };
    return { kind: 'pane', live: false, ...(origin.label ? { label: coordinateFirst(origin.label) } : {}) };
  }
  // Audit-only (tasks stamped before origins existed): the caller KIND is
  // reliable, a ptyId matched against today's layout is not.
  const provenance = state.fanoutProvenance?.[taskWorkspaceId];
  if (provenance?.callerIdentity === 'gui') return { kind: 'gui' };
  if (provenance?.callerIdentity === 'commander') return { kind: 'orchestrator' };
  return { kind: 'unknown' };
}

/** The requester as a phrase ("w115-74 · Compare", "you (GUI)", …) — no verb. */
export function requesterName(requester: TaskRequester, t: T): string | undefined {
  switch (requester.kind) {
    case 'gui':
      return t('sidebar.provenance.callerGui');
    case 'orchestrator':
      return t('sidebar.requester.orchestrator');
    case 'pane':
      if (requester.live) return requester.label;
      return t('sidebar.requester.closedPane', { name: requester.label ?? t('sidebar.provenance.callerPane') });
    default:
      return undefined;
  }
}

/** The requester as one line of text (tooltips, accessible names, Fleet). */
export function requesterLine(requester: TaskRequester, t: T): string {
  switch (requester.kind) {
    case 'gui':
      return t('sidebar.requester.gui');
    case 'unknown':
      return t('sidebar.requester.unknown');
    default:
      return t('sidebar.requester.by', { name: requesterName(requester, t) ?? '' });
  }
}

type CountState = {
  workspaces: readonly Workspace[];
  fanoutOrigin?: Record<string, FanoutOrigin | undefined>;
  missionByPaneGroup?: Record<string, WorkTask | undefined>;
  fanoutLineage?: Record<string, string | undefined>;
  fanoutSpawnOwner?: Record<string, string | undefined>;
};

/** owner workspace id → requester key (`s:<surfaceId>` / `p:<paneId>`) → open tasks. */
export type RequestedCounts = Record<string, Record<string, number>>;

let requestedCountsCache: { inputs: readonly unknown[]; value: RequestedCounts } | null = null;

/**
 * Open fan-out tasks per requesting surface, grouped by the owner workspace
 * the task nests under. Memoized on the store slices it reads, so every
 * roster row can look its count up without a scan of its own. Detached tasks
 * do not count: they no longer nest under the owner the badge opens.
 */
export function selectRequestedCounts(state: CountState): RequestedCounts {
  const inputs = [state.workspaces, state.fanoutOrigin, state.missionByPaneGroup, state.fanoutLineage, state.fanoutSpawnOwner];
  const cached = requestedCountsCache;
  if (cached && inputs.every((v, i) => v === cached.inputs[i])) return cached.value;
  const value: RequestedCounts = {};
  for (const ws of state.workspaces) {
    const origin = state.fanoutOrigin?.[ws.id];
    if (origin?.kind !== 'pane') continue;
    const key = origin.surfaceId ? `s:${origin.surfaceId}` : origin.paneId ? `p:${origin.paneId}` : '';
    if (!key) continue;
    const link = resolveTaskLink(state.missionByPaneGroup?.[ws.id], state.fanoutLineage?.[ws.id], state.fanoutSpawnOwner?.[ws.id]);
    if (!link || link.detached || !link.ownerId) continue;
    const forOwner = (value[link.ownerId] ??= {});
    forOwner[key] = (forOwner[key] ?? 0) + 1;
  }
  // Layout churn (a title, a cwd) replaces `workspaces` without moving a
  // count: keep the previous object then, so no roster re-renders for it.
  const kept = cached && sameRequestedCounts(cached.value, value) ? cached.value : value;
  requestedCountsCache = { inputs, value: kept };
  return kept;
}

function sameRequestedCounts(a: RequestedCounts, b: RequestedCounts): boolean {
  const owners = Object.keys(a);
  if (owners.length !== Object.keys(b).length) return false;
  for (const owner of owners) {
    const x = a[owner];
    const y = b[owner];
    if (!y) return false;
    const keys = Object.keys(x);
    if (keys.length !== Object.keys(y).length || keys.some((k) => x[k] !== y[k])) return false;
  }
  return true;
}

/** A roster row's count: tasks whose origin names its surface, plus (only for
 *  origins recorded without a surface) tasks naming its pane. */
export function requestedCountFor(
  counts: RequestedCounts,
  ownerWorkspaceId: string,
  row: { surfaceId?: string; paneId: string },
): number {
  const forOwner = counts[ownerWorkspaceId];
  if (!forOwner) return 0;
  return (row.surfaceId ? forOwner[`s:${row.surfaceId}`] ?? 0 : 0) + (forOwner[`p:${row.paneId}`] ?? 0);
}

/**
 * Fleet: the requester as `by <coordinate · name> · <workspace>` — the part
 * that tells panes apart leads and the workspace comes last, so a narrow row
 * truncates the workspace first (`includesOwner`: the workspace is part of
 * it). Otherwise the plain requester line. Undefined for a workspace that is
 * not a fan-out task.
 */
export function fleetRequesterText(
  state: RequesterState & CountState,
  taskWorkspaceId: string,
  t: T,
): { text: string; includesOwner: boolean } | undefined {
  const link = resolveTaskLink(
    state.missionByPaneGroup?.[taskWorkspaceId],
    state.fanoutLineage?.[taskWorkspaceId],
    state.fanoutSpawnOwner?.[taskWorkspaceId],
  );
  if (!link && !state.fanoutOrigin?.[taskWorkspaceId]) return undefined;
  const requester = resolveTaskRequester(state, taskWorkspaceId);
  if (requester.kind === 'pane') {
    const wsId = requester.live ? requester.workspaceId : link?.ownerId;
    const wsName = state.workspaces.find((w) => w.id === wsId)?.name;
    const name = requesterName(requester, t) ?? '';
    return {
      text: t('sidebar.requester.by', { name: wsName ? `${name} · ${displayWorkspaceName(wsName, false)}` : name }),
      // Only when the named workspace IS the owner may the row drop its owner
      // line; a requester pane living elsewhere must not hide the real owner.
      includesOwner: !!wsName && !!link?.ownerId && wsId === link.ownerId,
    };
  }
  return { text: requesterLine(requester, t), includesOwner: false };
}
