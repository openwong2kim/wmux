// Pane actions menu and usage-limit chip → "Continue on <account>".
//
// Moves the pane's own Claude conversation to another registered Claude
// account: the daemon stops the pane's Claude, copies the transcript into the
// account's config dir and resumes the same session id there, in the same
// pane (src/daemon/continueOnAccount.ts). Offered only while the pane runs
// Claude Code under the daemon and at least one Claude account is registered.
// When the target account or this pane signs in from a vault (a token), the
// conversation goes to a new pane beside this one instead
// (continueOnAccount.handler.ts), and this pane is left as is.

import { useCallback, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { useDaemonModeActive } from '../../hooks/useDaemonMode';
import { IconUsers } from '../icons';
import type { PaneActionItem } from './PaneActionsMenu';
import { agentRow } from '../../../shared/agentIdentity';
import { accountGroupOf, groupAccountsBoundFirst } from '../../../shared/accountGroup';
import { findWorkspaceSurfaceByPtyId } from '../../utils/paneTraversal';
import type { Toast } from '../../stores/slices/toastSlice';
import { paneWslSession } from '../../terminal/paneForegroundProbe';

/**
 * A new pane beside the one running `ptyId` (the workspace's active pane when
 * that one is stashed) that runs `command` in `cwd` on the account: the funnel
 * creates it from the seed, through the normal create (from a WSL pane, as
 * that pane's distro and user: `wslFrom`). False when there is no
 * such workspace or the split was refused (the pane cap says so itself).
 */
export function openContinuePane(ptyId: string, pane: { accountId: string; command: string; cwd: string; wslFrom?: string }): boolean {
  const st = useStore.getState();
  const ws = st.workspaces.find((w) => findWorkspaceSurfaceByPtyId(w, ptyId));
  const hit = ws ? findWorkspaceSurfaceByPtyId(ws, ptyId) : null;
  if (!ws || !hit) return false;
  const source = hit.stashed ? ws.activePaneId : hit.paneId;
  // The funnel fills only the active workspace's empty leaves.
  st.setActiveWorkspace(ws.id);
  const paneId = useStore.getState().splitPane(source, 'horizontal', ws.id);
  if (!paneId) return false;
  useStore.setState((s) => {
    s.projectPaneSeed[paneId] = { command: pane.command, cwd: pane.cwd, accountId: pane.accountId, ...(pane.wslFrom ? { wslFrom: pane.wslFrom } : {}) };
    delete s.splitCwdSeed[paneId];
  });
  return true;
}

/** Key of the main-menu item that opens the account submenu. */
export const PANE_CONTINUE_ACCOUNT_KEY = 'continue-on-account';

/** Daemon refusal code → message key. Anything else reads as the generic failure. */
const REFUSAL_KEYS: Record<string, string> = {
  not_claude: 'pane.continueOnAccountNotClaude',
  unknown_session: 'pane.continueOnAccountUnknownSession',
  same_account: 'pane.continueOnAccountSameAccount',
  turn_open: 'pane.continueOnAccountTurnOpen',
  busy: 'pane.continueOnAccountInProgress',
  pending: 'pane.continueOnAccountPending',
  lost: 'pane.continueOnAccountLost',
  still_running: 'pane.continueOnAccountStillRunning',
  copy_failed: 'pane.continueOnAccountCopyFailed',
  diverged: 'pane.continueOnAccountDiverged',
  unsupported: 'pane.continueOnAccountUnsupported',
  unavailable: 'pane.continueOnAccountUnsupported',
  invalid_account: 'pane.continueOnAccountInvalidAccount',
  shell_busy: 'pane.continueOnAccountShellBusy',
  folder_trust: 'pane.launchAtFolderTrust',
};

/** Why Claude, once stopped and its conversation copied, was not relaunched → message key. */
const STOPPED_KEYS: Record<string, string> = {
  shell_busy: 'pane.continueOnAccountStoppedShellBusy',
  shell_typed: 'pane.continueOnAccountStoppedShellTyped',
  shell_running: 'pane.continueOnAccountStoppedShellRunning',
  save_failed: 'pane.continueOnAccountStoppedSaveFailed',
};

/**
 * Claude stopped and the copy exists, but nothing was typed: the reason, and
 * the line that resumes the copy as a block of its own, kept until dismissed
 * (the pane is left at its shell), with the line to copy.
 */
export function stoppedNotRelaunchedToast(
  code: string,
  resumeCommand: string,
  accountName: string,
  t: (key: string, vars?: Record<string, string>) => string,
): Omit<Toast, 'id'> {
  return {
    level: 'error',
    persist: true,
    message: t(STOPPED_KEYS[code] ?? 'pane.continueOnAccountStopped', { name: accountName }),
    code: resumeCommand,
    action: {
      label: t('resume.copyCommand'),
      onClick: () => { void navigator.clipboard?.writeText(resumeCommand).catch(() => undefined); },
    },
  };
}

/** What one "Continue on <account>" run did to its pane. */
export type ContinueOutcome =
  | { kind: 'done' }
  /** The conversation went to a new pane beside it (a token sign-in). */
  | { kind: 'new_pane' }
  /** Refused before anything stopped: the pane is as it was. */
  | { kind: 'refused'; code: string }
  /** Claude stopped and the copy exists, but it was not relaunched. */
  | { kind: 'stopped'; code: string; resumeCommand: string }
  | { kind: 'failed' };

/**
 * Continue the pane's Claude conversation on the account, through the
 * daemon's copy and resume (the pane menu and the workspace account menu's
 * "switch open panes" both run this). Never throws.
 */
export async function continuePaneOnAccount(ptyId: string, accountId: string, workspaceId?: string): Promise<ContinueOutcome> {
  const api = window.electronAPI?.accounts;
  if (!api?.continuePane) return { kind: 'failed' };
  try {
    const res = await api.continuePane({ ptyId, accountId, ...(workspaceId ? { workspaceId } : {}) });
    if (res.ok && res.newPane) return openContinuePane(ptyId, res.newPane) ? { kind: 'new_pane' } : { kind: 'failed' };
    if (res.ok) return { kind: 'done' };
    if (res.resumeCommand) return { kind: 'stopped', code: res.code, resumeCommand: res.resumeCommand };
    return { kind: 'refused', code: res.code };
  } catch {
    return { kind: 'failed' };
  }
}

/** The toast that tells the owner what a continue did. */
export function continueOutcomeToast(
  outcome: ContinueOutcome,
  accountName: string,
  t: (key: string, vars?: Record<string, string>) => string,
): Omit<Toast, 'id'> {
  switch (outcome.kind) {
    case 'done': return { level: 'info', message: t('pane.continueOnAccountDone', { name: accountName }) };
    case 'new_pane': return { level: 'info', message: t('pane.continueOnAccountNewPane', { name: accountName }) };
    case 'stopped': return stoppedNotRelaunchedToast(outcome.code, outcome.resumeCommand, accountName, t);
    case 'refused': return { level: outcome.code === 'pending' ? 'warn' : 'error', message: t(REFUSAL_KEYS[outcome.code] ?? 'pane.continueOnAccountFailed') };
    default: return { level: 'error', message: t('pane.continueOnAccountFailed') };
  }
}

export function usePaneContinueOnAccount(opts: {
  ptyId: string | undefined;
  /** False for a read-only mirror, whose ptyIds are not this main's panes. */
  allowed: boolean;
  /** The pane's workspace: its bound Claude account's group is listed first
   *  (the pane itself may run on a rotated account of that group). */
  workspaceId?: string;
  /** Switch the open menu to the account submenu (pane menu only). */
  openSubmenu?: () => void;
}): {
  enabled: boolean;
  reload: () => void;
  mainItems: PaneActionItem[];
  subItems: PaneActionItem[];
} {
  const { ptyId, allowed, openSubmenu, workspaceId } = opts;
  const t = useT();
  const daemon = useDaemonModeActive();
  const isClaude = useStore((s) => (ptyId ? !!agentRow(s.surfaceAgent[ptyId]?.slug)?.continueOnAccount : false));
  const [accounts, setAccounts] = useState<{ id: string; name: string; group?: string; loggedIn: boolean }[]>([]);
  /** Index of the first account outside the bound account's group; -1 when none or nothing is bound. */
  const [otherFrom, setOtherFrom] = useState(-1);
  const ready = allowed && daemon && isClaude && !!ptyId && !!window.electronAPI?.accounts?.continuePane;

  // Fetched when a menu opens, not per pane mount.
  const reload = useCallback(() => {
    const api = window.electronAPI?.accounts;
    if (!api || !ready) return;
    // An account's sign-in status is its Windows folder's. A WSL pane runs
    // the account on its own home in the distro, where Claude asks for a
    // sign-in itself when there is none, so the Windows one does not gate it.
    const pty = window.electronAPI?.pty;
    const wsl = pty && ptyId ? paneWslSession(ptyId, pty).then((s) => s.wsl) : Promise.resolve(false);
    void Promise.all([api.list(), wsl]).then(([res, wslPane]) => {
      const rows = res.accounts.filter((a) => agentRow(a.vendor)?.continueOnAccount);
      const bound = workspaceId ? rows.find((a) => a.id === res.bindings[workspaceId]?.claude) : undefined;
      const buckets = groupAccountsBoundFirst(rows, bound ? accountGroupOf(bound) : null);
      setAccounts(buckets.flatMap((b) => b.accounts).map((a) => ({
        id: a.id, name: a.name, group: a.group, loggedIn: wslPane || a.status.loggedIn || a.tokenSignIn?.usable === true,
      })));
      setOtherFrom(bound && buckets.length > 1 ? buckets[0].accounts.length : -1);
    }).catch(() => { /* menu keeps the last rows */ });
  }, [ready, workspaceId, ptyId]);

  const continueOn = useCallback(async (account: { id: string; name: string }) => {
    if (!ptyId) return;
    const outcome = await continuePaneOnAccount(ptyId, account.id, workspaceId);
    useStore.getState().pushToast(continueOutcomeToast(outcome, account.name, t));
  }, [ptyId, workspaceId, t]);

  const enabled = ready && accounts.length > 0;

  const mainItems: PaneActionItem[] = useMemo(() => (enabled && openSubmenu ? [{
    key: PANE_CONTINUE_ACCOUNT_KEY,
    label: t('pane.continueOnAccount'),
    icon: <IconUsers size={14} />,
    hasPopup: true,
    onSelect: openSubmenu,
  }] : []), [enabled, openSubmenu, t]);

  // Once any account has a group: the bound account's group first, one
  // divider before the other groups, and each account's group under its name.
  // A logged-out account cannot take the conversation (in a native pane).
  const subItems: PaneActionItem[] = useMemo(() => {
    const sectioned = accounts.some((a) => accountGroupOf(a) !== '');
    return accounts.map((account, i) => ({
      key: `continue-account:${account.id}`,
      label: t('pane.continueOnAccountNamed', { name: account.name }),
      onSelect: () => { void continueOn(account); },
      ...(sectioned ? { detail: accountGroupOf(account) || t('accounts.noGroup') } : {}),
      ...(i > 0 && i === otherFrom ? { separatorBefore: true } : {}),
      ...(account.loggedIn ? {} : { disabled: true, title: t('accounts.notLoggedIn') }),
    }));
  }, [accounts, otherFrom, continueOn, t]);

  return { enabled, reload, mainItems, subItems };
}
