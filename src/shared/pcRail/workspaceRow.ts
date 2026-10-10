/**
 * One row of a web-paired computer's workspace list, as the PC rail scopes the
 * sidebar to it.
 *
 * The base is the existing `/api/workspaces` row (RemoteWorkspaceSummary, whose
 * id/name/panes the desktop normalizer already validates). The host also sends
 * the sidebar fields below, which the desktop drops today; PR2's normalizer
 * keeps them through parsePcRailWorkspaceExtras. `layout` is validated by the
 * layout bounds check (PHONE_SIDEBAR_LIMITS.layout), not here.
 *
 * `/api/workspaces` lists only workspaces with at least one live pane. A later
 * host wire change adds rows for workspaces with no terminal, flagged
 * `empty: true` with `panes: []`. No host sends that flag today; the parser
 * accepts it now so a newer host works with this desktop unchanged.
 */

import type { RemoteWorkspaceSummary } from '../remoteHosts';
import type { PhoneWorkspaceLayout } from '../phoneFleetSidebar';
import { PHONE_SIDEBAR_LIMITS, clampSidebarString } from '../phoneFleetSidebar';
import { normalizeWorkspaceColor, type WorkspaceColorId } from '../workspaceColors';

export interface PcRailWorkspaceRow extends RemoteWorkspaceSummary {
  /** Position in the host's manual workspace order (pinned rows lowest). */
  order?: number;
  pinned?: boolean;
  color?: WorkspaceColorId;
  gitBranch?: string;
  /** The branch is a linked worktree on the host. */
  gitIsWorktree?: boolean;
  /** The host's split tree, after the layout bounds check. Absent when the host desktop sent none. */
  layout?: PhoneWorkspaceLayout;
  /**
   * The workspace exists on the host but has no live terminal. Only ever
   * `true`, and then `panes` is empty. Absent on every row hosts send today.
   */
  empty?: true;
}

/** `GET /api/workspaces` as the PC rail reads it. */
export interface PcRailWorkspacesResponse {
  workspaces: PcRailWorkspaceRow[];
  /** The host desktop's focused workspace, when it is one of `workspaces`. */
  activeWorkspaceId?: string;
}

export type PcRailWorkspaceExtras = Pick<PcRailWorkspaceRow, 'order' | 'pinned' | 'color' | 'gitBranch' | 'gitIsWorktree' | 'empty'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The sidebar fields of one raw host row, validated and capped. `paneCount` is
 * the number of panes the normalizer kept for the row. Returns null when the
 * row must be dropped: a row with no panes is only listable when the host marks
 * it `empty`, and an `empty` row must carry no panes.
 */
export function parsePcRailWorkspaceExtras(raw: unknown, paneCount: number): PcRailWorkspaceExtras | null {
  if (!isRecord(raw)) return null;
  const empty = raw.empty === true;
  if (empty ? paneCount !== 0 : paneCount === 0) return null;
  const out: PcRailWorkspaceExtras = {};
  const order = raw.order;
  if (typeof order === 'number' && Number.isSafeInteger(order) && order >= 0 && order <= PHONE_SIDEBAR_LIMITS.count) {
    out.order = order;
  }
  if (typeof raw.pinned === 'boolean') out.pinned = raw.pinned;
  const color = normalizeWorkspaceColor(raw.color);
  if (color) out.color = color;
  const gitBranch = clampSidebarString(typeof raw.gitBranch === 'string' ? raw.gitBranch : undefined, PHONE_SIDEBAR_LIMITS.gitBranch);
  if (gitBranch) out.gitBranch = gitBranch;
  if (typeof raw.gitIsWorktree === 'boolean') out.gitIsWorktree = raw.gitIsWorktree;
  if (empty) out.empty = true;
  return out;
}

/**
 * Sidebar order for one host's rows: the host's own order first (rows that
 * carry none go last, by name), so the list reads as it does on that computer.
 */
export function comparePcRailRows(a: PcRailWorkspaceRow, b: PcRailWorkspaceRow): number {
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao < bo ? -1 : 1;
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}
