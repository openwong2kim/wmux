// Workspace account menu → "Switch open panes to <account>".
//
// A re-bind alone reaches new panes only. This runs the pane menu's
// "Continue on <account>" (the daemon's copy and resume, native and WSL) on
// each open pane of the workspace whose agent can continue, one after the
// other. Shell panes and other agents are not touched: the binding reaches
// what they launch next. A pane in a turn, or one the daemon refuses, is
// skipped without asking; a failure never stops the rest.

import { agentRow } from '../../../shared/agentIdentity';
import { isWslDistroSpawnArgs, isWslShellPath } from '../../../shared/wslDistro';
import { validWslTarget } from '../../../shared/wslTarget';
import type { WorkspacePaneOwner } from '../../../shared/paneUtils';
import { collectWorkspaceTerminalSurfaces } from '../../utils/paneTraversal';
import type { ContinueOutcome } from '../Pane/usePaneContinueOnAccount';

export interface SwitchPane { ptyId: string; title: string }

/** The workspace's open panes whose agent can continue on another account. */
export function workspaceContinuePanes(
  ws: WorkspacePaneOwner,
  surfaceAgent: Record<string, { slug?: string } | undefined>,
): SwitchPane[] {
  return collectWorkspaceTerminalSurfaces(ws)
    .filter((s) => s.ptyId && agentRow(surfaceAgent[s.ptyId]?.slug)?.continueOnAccount)
    .map((s) => ({ ptyId: s.ptyId, title: s.title }));
}

export interface SwitchResult extends SwitchPane { outcome: ContinueOutcome }

/** Continue each pane on the account, in order. A throw counts as that pane's failure. */
export async function switchWorkspacePanes(
  panes: SwitchPane[],
  run: (ptyId: string) => Promise<ContinueOutcome>,
): Promise<SwitchResult[]> {
  const out: SwitchResult[] = [];
  for (const pane of panes) {
    let outcome: ContinueOutcome;
    try { outcome = await run(pane.ptyId); } catch { outcome = { kind: 'failed' }; }
    out.push({ ...pane, outcome });
  }
  return out;
}

export type SwitchTally = { switched: number; already: number; skipped: number; failed: number };

/**
 * Switched: moved (in place or to a new pane). Already: it ran on the account.
 * Skipped: refused before anything stopped (a turn open, among others), so the
 * pane is as it was. Failed: the run broke, or Claude stopped and was not
 * relaunched.
 */
export function tallySwitch(results: SwitchResult[]): SwitchTally {
  const tally: SwitchTally = { switched: 0, already: 0, skipped: 0, failed: 0 };
  for (const { outcome } of results) {
    if (outcome.kind === 'done' || outcome.kind === 'new_pane') tally.switched++;
    else if (outcome.kind === 'refused' && outcome.code === 'same_account') tally.already++;
    else if (outcome.kind === 'refused') tally.skipped++;
    else tally.failed++;
  }
  return tally;
}

/**
 * Whether a workspace's panes run in WSL: any of its open panes does, or, with
 * none open, a new pane would (the Settings default shell is WSL).
 */
export function workspaceRunsInWsl(
  ptyIds: string[],
  sessions: { id: string; shell?: string; args?: unknown; wslTarget?: unknown }[],
  defaultShell: string | undefined,
): boolean {
  if (ptyIds.length === 0) return isWslShellPath(defaultShell);
  const ids = new Set(ptyIds);
  return sessions.some((s) => ids.has(s.id)
    && (validWslTarget(s.wslTarget) || isWslDistroSpawnArgs(s.shell, s.args) || isWslShellPath(s.shell)));
}

/**
 * The sign-in mark an account row shows. An account's status is its Windows
 * folder's; a WSL pane runs it on its home in the distro, which this does not
 * read, so there a signed-out Windows folder is `wsl` (neutral), never `out`.
 */
export function accountSignInMark(
  row: { status: { loggedIn: boolean }; tokenSignIn?: { usable: boolean } },
  inWsl: boolean,
): 'in' | 'out' | 'wsl' {
  if (row.status.loggedIn || row.tokenSignIn?.usable) return 'in';
  return inWsl ? 'wsl' : 'out';
}
