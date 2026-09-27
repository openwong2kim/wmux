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
// The lineage stamp's `origin` (stable pane/surface ids + a display-name
// snapshot, recorded when the task pane was created) is preferred; the audit
// record's caller ptyId is the fallback for tasks stamped before origins
// existed. Never guessed: with neither, the requester is unknown.

type RequesterState = {
  workspaces: readonly Workspace[];
  paneLabel?: Record<string, string | undefined>;
  surfaceAgent?: Record<string, { name?: string } | undefined>;
  fanoutOrigin?: Record<string, FanoutOrigin | undefined>;
  fanoutProvenance?: Record<string, FanoutProvenance | undefined>;
};

/** `<label or agent> · w<ws>-<pane>`, or the bare coordinate. The one format
 *  for both the launch-time snapshot and the live label, so the text does not
 *  change when the pane closes. */
export function formatRequesterPaneLabel(parts: { label?: string; agent?: string; coord: string }): string {
  const name = parts.label?.trim() || parts.agent?.trim();
  return name && name !== parts.coord ? `${name} · ${parts.coord}` : parts.coord;
}

interface PaneHit {
  workspaceId: string;
  paneId: string;
  surfaceId?: string;
  label: string;
}

function describeLeaf(state: RequesterState, ws: Workspace, leaf: ReturnType<typeof getWorkspaceLeafPanes>[number], surfaceId?: string): PaneHit {
  const surface = (surfaceId ? leaf.surfaces.find((s) => s.id === surfaceId) : undefined)
    ?? leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId)
    ?? leaf.surfaces[0];
  const agent = surface?.ptyId ? state.surfaceAgent?.[surface.ptyId]?.name : undefined;
  return {
    workspaceId: ws.id,
    paneId: leaf.id,
    ...(surface ? { surfaceId: surface.id } : {}),
    label: formatRequesterPaneLabel({
      label: state.paneLabel?.[leaf.id],
      agent,
      coord: computePaneAutoName(ws.wsOrdinal ?? 0, leaf.ordinal ?? 0),
    }),
  };
}

function findPaneByPtyId(state: RequesterState, ptyId: string): PaneHit | undefined {
  if (!ptyId) return undefined;
  for (const ws of state.workspaces) {
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      const surface = leaf.surfaces.find((s) => s.ptyId === ptyId);
      if (surface) return describeLeaf(state, ws, leaf, surface.id);
    }
  }
  return undefined;
}

function findPaneByOrigin(state: RequesterState, origin: FanoutOrigin): PaneHit | undefined {
  for (const ws of state.workspaces) {
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      if (origin.paneId ? leaf.id === origin.paneId : !!origin.surfaceId && leaf.surfaces.some((s) => s.id === origin.surfaceId)) {
        return describeLeaf(state, ws, leaf, origin.surfaceId);
      }
    }
  }
  return undefined;
}

/**
 * The origin to stamp for a fan-out caller, resolved from the renderer's
 * layout at spawn time. A pane caller whose ptyId no open pane holds records
 * `{ kind: 'pane' }` without ids — it did come from a pane, which one is not
 * known.
 */
export function originFromCaller(state: RequesterState, caller: unknown): FanoutOrigin | undefined {
  if (!caller || typeof caller !== 'object') return undefined;
  const c = caller as { kind?: unknown; ptyId?: unknown };
  if (c.kind === 'gui' || c.kind === 'orchestrator') return { kind: c.kind };
  if (c.kind !== 'pane') return undefined;
  const hit = typeof c.ptyId === 'string' ? findPaneByPtyId(state, c.ptyId) : undefined;
  if (!hit) return { kind: 'pane' };
  return { kind: 'pane', paneId: hit.paneId, ...(hit.surfaceId ? { surfaceId: hit.surfaceId } : {}), label: hit.label };
}

export type TaskRequester =
  /** An open pane — `label` is its current name; click jumps there. */
  | { kind: 'pane'; live: true; label: string; workspaceId: string; paneId: string; surfaceId?: string }
  /** A pane that is gone (`label` = the launch snapshot), or one that cannot
   *  be named (an older audit record, or no snapshot) — no label then. */
  | { kind: 'pane'; live: false; label?: string; closed: boolean }
  | { kind: 'gui' }
  | { kind: 'orchestrator' }
  | { kind: 'unknown' };

/** Who asked for task workspace `taskWorkspaceId`. */
export function resolveTaskRequester(state: RequesterState, taskWorkspaceId: string): TaskRequester {
  const origin = state.fanoutOrigin?.[taskWorkspaceId];
  if (origin) {
    if (origin.kind !== 'pane') return { kind: origin.kind };
    const hit = origin.paneId || origin.surfaceId ? findPaneByOrigin(state, origin) : undefined;
    if (hit) return { kind: 'pane', live: true, label: hit.label, workspaceId: hit.workspaceId, paneId: hit.paneId, ...(hit.surfaceId ? { surfaceId: hit.surfaceId } : {}) };
    // Ids recorded but no pane holds them: it was closed. No ids: never known.
    const closed = !!(origin.paneId || origin.surfaceId);
    return { kind: 'pane', live: false, ...(origin.label ? { label: origin.label } : {}), closed };
  }
  const provenance = state.fanoutProvenance?.[taskWorkspaceId];
  if (!provenance) return { kind: 'unknown' };
  if (provenance.callerIdentity === 'gui') return { kind: 'gui' };
  if (provenance.callerIdentity === 'commander') return { kind: 'orchestrator' };
  const hit = provenance.callerPtyId ? findPaneByPtyId(state, provenance.callerPtyId) : undefined;
  if (hit) return { kind: 'pane', live: true, label: hit.label, workspaceId: hit.workspaceId, paneId: hit.paneId, ...(hit.surfaceId ? { surfaceId: hit.surfaceId } : {}) };
  // A ptyId no open pane holds may only have been rebound, so "closed" is not
  // claimed here.
  return { kind: 'pane', live: false, closed: false };
}

/** The requester as a phrase ("Compare · w115-74", "you", …) — no verb. */
export function requesterName(requester: TaskRequester, t: T): string | undefined {
  switch (requester.kind) {
    case 'gui':
      return t('sidebar.provenance.callerGui');
    case 'orchestrator':
      return t('sidebar.requester.orchestrator');
    case 'pane':
      if (requester.live) return requester.label;
      if (!requester.label) return t('sidebar.provenance.callerPane');
      return requester.closed ? t('sidebar.requester.closedPane', { name: requester.label }) : requester.label;
    default:
      return undefined;
  }
}

/** The always-visible line on a task row. */
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

/**
 * Open task workspaces whose requester is pane `paneId`. Detached tasks do not
 * count: they no longer nest under the owner the badge opens.
 */
export function countTasksRequestedByPane(
  state: RequesterState & { missionByPaneGroup?: Record<string, { detachedAt?: number } | undefined> },
  paneId: string,
): number {
  if (!paneId) return 0;
  let n = 0;
  for (const ws of state.workspaces) {
    if (!state.fanoutOrigin?.[ws.id] && !state.fanoutProvenance?.[ws.id]) continue;
    if (state.missionByPaneGroup?.[ws.id]?.detachedAt !== undefined) continue;
    const r = resolveTaskRequester(state, ws.id);
    if (r.kind === 'pane' && r.live && r.paneId === paneId) n++;
  }
  return n;
}
