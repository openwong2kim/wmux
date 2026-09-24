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
