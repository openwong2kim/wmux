// IPC for "Continue on <account>": the renderer names a pane and a registered
// Claude account; main resolves the account to its config dir (the exact
// stored string, which the macOS keychain item is keyed on) and the daemon
// moves the pane's own conversation there (src/daemon/continueOnAccount.ts).
//
// An account that signs in with a token (CLAUDE_CODE_OAUTH_TOKEN in its vault)
// cannot take the same pane: the token reaches a process only at spawn and is
// never typed. The daemon then only copies the conversation, and the reply
// asks the renderer for a new pane beside the source one that resumes it on
// that account (`newPane`: the resume command and its folder, never a value
// of the vault). The source pane is left as is.

import { ipcMain } from 'electron';
import { IPC } from '../../shared/constants';
import type { DaemonClient } from '../DaemonClient';
import { getAccountStore, isAccessibleDir, isUnsafeKey, type Account } from './accountStore';
import { appAccountVault, type AccountVaultEntry } from './accountVault';
import { agentRow } from '../../shared/agentIdentity';
import { CHATV2_PROVIDER_SESSION_ID } from '../../shared/chatv2/ipc';
import { permissionFlagFor, type PermissionMode } from '../../shared/agentResume';

export type ContinuePaneResult =
  | { ok: true; newPane?: { accountId: string; command: string; cwd: string } }
  | { ok: false; code: string };

/** Stop grace (5 s) + prompt wait (5 s) + the copy of a large transcript, with room to spare. */
const CONTINUE_TIMEOUT_MS = 60_000;

const CLAUDE_TOKEN_NAME = 'CLAUDE_CODE_OAUTH_TOKEN';

/** Whether these vault entries sign the account in with a token its panes get. Pure. */
export function signsInWithToken(entries: ReadonlyArray<Pick<AccountVaultEntry, 'name' | 'inject' | 'usable'>>): boolean {
  return entries.some((e) => e.name === CLAUDE_TOKEN_NAME && e.inject && e.usable);
}

export interface ContinuePaneDeps {
  account: (id: string) => Account | undefined;
  vaultEntries: (accountId: string) => ReadonlyArray<Pick<AccountVaultEntry, 'name' | 'inject' | 'usable'>>;
  dirOk: (dir: string) => boolean;
  connected: () => boolean;
  rpc: (params: { sessionId: string; configDir: string; copyOnly?: true }) => Promise<unknown>;
}

export async function continuePane(deps: ContinuePaneDeps, args: { ptyId?: unknown; accountId?: unknown } | undefined): Promise<ContinuePaneResult> {
  const ptyId = typeof args?.ptyId === 'string' && args.ptyId.length < 256 ? args.ptyId : '';
  const accountId = typeof args?.accountId === 'string' && !isUnsafeKey(args.accountId) ? args.accountId : '';
  if (!ptyId || !accountId) return { ok: false, code: 'invalid' };
  const account = deps.account(accountId);
  if (!account || !agentRow(account.vendor)?.continueOnAccount) return { ok: false, code: 'invalid_account' };
  if (!deps.dirOk(account.configDir)) return { ok: false, code: 'invalid_account' };
  // Local PTY mode has no daemon to own the stop and the relaunch.
  if (!deps.connected()) return { ok: false, code: 'unavailable' };
  let newPane = false;
  try {
    newPane = signsInWithToken(deps.vaultEntries(account.id));
  } catch {
    newPane = false;
  }
  try {
    const res = await deps.rpc({ sessionId: ptyId, configDir: account.configDir, ...(newPane ? { copyOnly: true as const } : {}) }) as
      { ok?: unknown; code?: unknown; sessionId?: unknown; cwd?: unknown; permissionMode?: unknown } | null;
    if (res?.ok !== true) return { ok: false, code: typeof res?.code === 'string' ? res.code : 'unknown' };
    if (!newPane) return { ok: true };
    // A daemon from before copy-only moved the same pane: that is what happened.
    if (typeof res.cwd !== 'string') return { ok: true };
    if (typeof res.sessionId !== 'string' || !CHATV2_PROVIDER_SESSION_ID.test(res.sessionId) || !res.cwd) return { ok: false, code: 'unknown_session' };
    const flag = typeof res.permissionMode === 'string' ? permissionFlagFor(res.permissionMode as PermissionMode) : '';
    const command = ['claude', '--resume', res.sessionId, flag].filter(Boolean).join(' ');
    return { ok: true, newPane: { accountId: account.id, command, cwd: res.cwd } };
  } catch (err) {
    // A timeout is not a refusal: the daemon may still finish the move.
    return { ok: false, code: err instanceof Error && err.message.startsWith('RPC timeout') ? 'pending' : 'unavailable' };
  }
}

export function registerContinueOnAccountHandler(daemonClient: DaemonClient | undefined): () => void {
  ipcMain.removeHandler(IPC.ACCOUNT_CONTINUE_PANE);
  ipcMain.handle(IPC.ACCOUNT_CONTINUE_PANE, async (_event, args: { ptyId?: unknown; accountId?: unknown }): Promise<ContinuePaneResult> =>
    continuePane({
      account: (id) => getAccountStore().getAccount(id),
      vaultEntries: (id) => appAccountVault().list(id),
      dirOk: isAccessibleDir,
      connected: () => !!daemonClient?.isConnected,
      rpc: async (params) => daemonClient?.rpc('session.continueOnAccount', params, { timeoutMs: CONTINUE_TIMEOUT_MS }),
    }, args));
  return () => { ipcMain.removeHandler(IPC.ACCOUNT_CONTINUE_PANE); };
}
