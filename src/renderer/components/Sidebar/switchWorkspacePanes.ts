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

/** The workspace's open panes running the vendor's agent, when that agent can continue on another account. */
export function workspaceContinuePanes(
  ws: WorkspacePaneOwner,
  surfaceAgent: Record<string, { slug?: string } | undefined>,
  vendor: string,
): SwitchPane[] {
  return collectWorkspaceTerminalSurfaces(ws)
    .filter((s) => {
      const slug = s.ptyId ? surfaceAgent[s.ptyId]?.slug : undefined;
      return slug === vendor && !!agentRow(slug)?.continueOnAccount;
    })
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

export type SwitchTally = { switched: number; opened: number; already: number; skipped: number; failed: number };

/** A refusal that leaves the pane as it was: "skipped", not "failed". */
export function isSkip(outcome: ContinueOutcome): boolean {
  return outcome.kind === 'refused' && outcome.code !== 'same_account';
}

/** Refused here, before the daemon: a native pane cannot take an account its Windows folder is not signed in to. */
export const NOT_SIGNED_IN = 'not_signed_in';

/**
 * Switched: moved in place. Opened: a token sign-in continued it in a new
 * pane beside it, the original left running. Already: it ran on the account.
 * Skipped: refused before anything stopped (a turn open, among others), so the
 * pane is as it was. Failed: the run broke, or Claude stopped and was not
 * relaunched.
 */
export function tallySwitch(results: SwitchResult[]): SwitchTally {
  const tally: SwitchTally = { switched: 0, opened: 0, already: 0, skipped: 0, failed: 0 };
  for (const { outcome } of results) {
    if (outcome.kind === 'done') tally.switched++;
    else if (outcome.kind === 'new_pane') tally.opened++;
    else if (outcome.kind === 'refused' && outcome.code === 'same_account') tally.already++;
    else if (isSkip(outcome)) tally.skipped++;
    else tally.failed++;
  }
  return tally;
}

/** Which of the panes run in WSL, by the daemon's session list. */
export function paneWslMap(
  ptyIds: string[],
  sessions: ReadonlyArray<{ id: string; shell?: string; args?: unknown; wslTarget?: unknown }>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of ptyIds) {
    const s = sessions.find((x) => x.id === id);
    out[id] = !!s && (validWslTarget(s.wslTarget) || isWslDistroSpawnArgs(s.shell, s.args) || isWslShellPath(s.shell));
  }
  return out;
}

/**
 * Whether the workspace's panes all run in WSL: every open pane does, or,
 * with none open, a new pane would (`newPaneShell`: the default shell under
 * the workspace profile, as a create resolves it). One native pane needs the
 * Windows sign-in, so a mixed workspace is not.
 */
export function workspaceRunsInWsl(wsl: Record<string, boolean>, newPaneShell: string | undefined): boolean {
  const ids = Object.keys(wsl);
  if (ids.length === 0) return isWslShellPath(newPaneShell);
  return ids.every((id) => wsl[id]);
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
