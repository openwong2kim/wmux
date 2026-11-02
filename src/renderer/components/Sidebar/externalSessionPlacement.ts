/**
 * External sessions (agents started outside wmux, src/shared/externalSessions.ts)
 * placed in the sidebar — placement B, owner-approved 2026-11-01: a session
 * whose folder is a workspace's folder, or sits under it, joins that
 * workspace's agent roster; the rest go to the "Outside wmux" group at the
 * foot of the list. Pure, so the matching and the attach rule are tested
 * without a store.
 */
import type { ExternalSession, ExternalSessionState, ExternalSessionWhere } from '../../../shared/externalSessions';
import type { AgentStatus, Workspace } from '../../../shared/types';
import { isAtOrUnder } from '../FileTree/FileTreePanel';
import { quotePosixPath } from '../../../shared/imagePaste';
import { isValidWslDistroName } from '../../../shared/wslDistro';
import { isLinuxCwd } from '../../../shared/wslTarget';

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
 * The distro a session runs in, when it runs in WSL at a Linux folder (what a
 * WSL pane can open), else undefined.
 */
export function externalSessionWslDistro(session: Pick<ExternalSession, 'cwd' | 'where'>): string | undefined {
  const distro = session.where.wslDistro;
  return isValidWslDistroName(distro) && isLinuxCwd(session.cwd) && session.cwd.startsWith('/') ? distro : undefined;
}

/** `\\wsl.localhost\<distro>\…` or `\\wsl$\<distro>\…`: the distro, then the Linux path. */
const WSL_SHARE_FOLDER = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(.*)$/i;

/**
 * A workspace folder as a session in `wslDistro` names it. To a session in
 * WSL, a share (`\\wsl.localhost\Ubuntu\home\me`) is that distro's Linux path,
 * so it holds a session in that distro only. A session outside WSL sees the
 * share as the UNC path it is (a Windows agent can work in one). Any other
 * folder is compared as it is: a WSL pane's folder is already its Linux path.
 */
function folderAsSessionSees(folder: string, wslDistro: string | undefined): string | undefined {
  const share = WSL_SHARE_FOLDER.exec(folder);
  if (!share || !wslDistro) return folder;
  if (share[1].toLowerCase() !== wslDistro.toLowerCase()) return undefined;
  return share[2].replace(/\\/g, '/') || '/';
}

/**
 * The workspace whose folder holds `cwd`: the deepest one (longest folder),
 * the first in list order on a tie. A workspace whose folder sits under the
 * session's never matches — the session is not working in it. `wslDistro` is
 * the session's distro when it runs in WSL: a workspace opened on that
 * distro's `\\wsl.localhost` / `\\wsl$` share holds it too.
 */
export function matchExternalWorkspace(cwd: string, workspaces: readonly PlacementWorkspace[], wslDistro?: string): string | undefined {
  if (!cwd) return undefined;
  let best: string | undefined;
  let bestLength = -1;
  for (const ws of workspaces) {
    const folder = ws.folder ? folderAsSessionSees(ws.folder, wslDistro) : undefined;
    if (!folder || !isAtOrUnder(folder, cwd)) continue;
    const length = folder.replace(/[\\/]+$/, '').length;
    if (length > bestLength) {
      best = ws.id;
      bestLength = length;
    }
  }
  return best;
}

/** The status mark a session draws: the sidebar's own marks, an ended one none (like idle). */
export function externalAgentStatus(state: ExternalSessionState): AgentStatus {
  if (state === 'needs-you') return 'awaiting_input';
  if (state === 'running') return 'running';
  return 'idle';
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
    // The distro counts only for a Linux folder; a UNC cwd is matched as it is.
    const id = matchExternalWorkspace(session.cwd, workspaces, externalSessionWslDistro(session));
    if (id) (byWorkspace[id] ??= []).push(session);
    else outside.push(session);
  }
  return { byWorkspace, outside };
}

/**
 * The command that attaches to the session from another terminal: only when
 * the session runs inside tmux or screen and its session name is known.
 * A WSL session gets a command for a Windows shell (see wslAttachCommand).
 * Anything else (an ssh login, a terminal app) has nothing to attach to.
 */
export function externalAttachCommand(where: ExternalSessionWhere): string | undefined {
  const session = where.session?.trim();
  if (!session) return undefined;
  if (where.kind !== 'tmux' && where.kind !== 'screen') return undefined;
  if (where.wslDistro !== undefined) return wslAttachCommand(where.kind, where.wslDistro, session);
  if (where.kind === 'tmux') return `tmux attach -t ${quotePosixPath(session)}`;
  return `screen -r ${quotePosixPath(session)}`;
}

/**
 * A session inside WSL is attached to from a Windows shell, so the command
 * goes through wsl.exe. --exec skips the Linux shell, which leaves only the
 * Windows shell's quoting: a name with characters that cmd or PowerShell would
 * expand gets no command rather than a wrong one.
 */
function wslAttachCommand(kind: 'tmux' | 'screen', distro: string, session: string): string | undefined {
  if (!isValidWslDistroName(distro) || /["$`%]/.test(session)) return undefined;
  const name = /^[\w.:@+-]+$/.test(session) ? session : `"${session}"`;
  const tool = kind === 'tmux' ? `tmux attach -t ${name}` : `screen -r ${name}`;
  return `wsl.exe -d ${distro.includes(' ') ? `"${distro}"` : distro} --exec ${tool}`;
}

/** TERM_PROGRAM values as the apps name themselves; anything else shows as sent. */
const TERMINAL_APP_NAMES: Record<string, string> = {
  Apple_Terminal: 'Terminal',
  'iTerm.app': 'iTerm2',
  vscode: 'VS Code',
  WarpTerminal: 'Warp',
  ghostty: 'Ghostty',
  WezTerm: 'WezTerm',
  Hyper: 'Hyper',
  Tabby: 'Tabby',
};

export function terminalAppName(termProgram: string): string {
  return TERMINAL_APP_NAMES[termProgram] ?? termProgram;
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
      base = label ? terminalAppName(label) : undefined;
      break;
    default:
      base = undefined;
  }
  return base ?? (where.wslDistro ? `WSL ${where.wslDistro}` : undefined);
}
