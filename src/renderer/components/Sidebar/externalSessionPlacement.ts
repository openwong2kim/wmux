/**
 * External sessions (agents started outside wmux, src/shared/externalSessions.ts)
 * placed in the sidebar — placement B, owner-approved 2026-11-01: a session
 * whose folder is a workspace's folder, or sits under it, joins that
 * workspace's agent roster; the rest go to the "Outside wmux" group at the
 * foot of the list. Pure, so the matching and the attach rule are tested
 * without a store.
 */
import type { ExternalSession, ExternalSessionState, ExternalSessionWhere } from '../../../shared/externalSessions';
import type { Workspace } from '../../../shared/types';
import { isAtOrUnder } from '../FileTree/FileTreePanel';
import { quotePosixPath } from '../../../shared/imagePaste';

/**
 * The folder a workspace stands for: the one it was opened on, else its live
 * cwd. The live cwd follows the active pane's `cd`, so a session at the
 * repository root would read as a parent of `repo/src` and never match.
 */
export function workspaceFolder(ws: Pick<Workspace, 'profile' | 'metadata'>): string | undefined {
  return ws.profile?.startupCwd || ws.metadata?.cwd || undefined;
}

export interface PlacementWorkspace {
  id: string;
  folder?: string;
}

export interface ExternalPlacement {
  /** Sessions under each workspace's folder, most urgent first. */
  byWorkspace: Record<string, ExternalSession[]>;
  /** Sessions no workspace's folder holds, most urgent first. */
  outside: ExternalSession[];
}

/**
 * The workspace whose folder holds `cwd`: the deepest one (longest folder),
 * the first in list order on a tie. A workspace whose folder sits under the
 * session's never matches — the session is not working in it.
 */
export function matchExternalWorkspace(cwd: string, workspaces: readonly PlacementWorkspace[]): string | undefined {
  if (!cwd) return undefined;
  let best: string | undefined;
  let bestLength = -1;
  for (const ws of workspaces) {
    if (!ws.folder || !isAtOrUnder(ws.folder, cwd)) continue;
    const length = ws.folder.replace(/[\\/]+$/, '').length;
    if (length > bestLength) {
      best = ws.id;
      bestLength = length;
    }
  }
  return best;
}

const STATE_RANK: Record<ExternalSessionState, number> = { 'needs-you': 0, running: 1, idle: 2, ended: 3 };

/** Needs you first, then running, idle, ended; newest signal first within a state. */
export function compareExternalSessions(a: ExternalSession, b: ExternalSession): number {
  return STATE_RANK[a.state] - STATE_RANK[b.state] || b.lastSignalAt - a.lastSignalAt;
}

export function placeExternalSessions(
  sessions: readonly ExternalSession[],
  workspaces: readonly PlacementWorkspace[],
): ExternalPlacement {
  const byWorkspace: Record<string, ExternalSession[]> = {};
  const outside: ExternalSession[] = [];
  for (const session of [...sessions].sort(compareExternalSessions)) {
    const id = matchExternalWorkspace(session.cwd, workspaces);
    if (id) (byWorkspace[id] ??= []).push(session);
    else outside.push(session);
  }
  return { byWorkspace, outside };
}

/**
 * The command that attaches to the session from another terminal: only when
 * the session runs inside tmux or screen and its session name is known.
 * Anything else (an ssh login, a terminal app) has nothing to attach to.
 */
export function externalAttachCommand(where: ExternalSessionWhere): string | undefined {
  const session = where.session?.trim();
  if (!session) return undefined;
  if (where.kind === 'tmux') return `tmux attach -t ${quotePosixPath(session)}`;
  if (where.kind === 'screen') return `screen -r ${quotePosixPath(session)}`;
  return undefined;
}

/**
 * The row's short "where": `tmux api:2`, `screen build`, `zellij dev`,
 * `ssh 10.0.0.4`, the terminal app's name, or the WSL distro alone. Product
 * names are not translated. Undefined when nothing is known.
 */
export function externalWhereShort(where: ExternalSessionWhere): string | undefined {
  const session = where.session?.trim();
  const label = where.label?.trim();
  let base: string | undefined;
  switch (where.kind) {
    case 'tmux':
      base = session ? `tmux ${session}${where.window ? `:${where.window}` : ''}` : 'tmux';
      break;
    case 'screen':
      base = session ? `screen ${session}` : 'screen';
      break;
    case 'zellij':
      base = session ? `zellij ${session}` : 'zellij';
      break;
    case 'ssh':
      base = label ? `ssh ${label}` : 'ssh';
      break;
    case 'terminal':
      base = label || undefined;
      break;
    default:
      base = undefined;
  }
  return base ?? (where.wslDistro ? `WSL ${where.wslDistro}` : undefined);
}
