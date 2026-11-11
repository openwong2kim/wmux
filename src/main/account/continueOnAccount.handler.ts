// IPC for "Continue on <account>": the renderer names a pane and a registered
// Claude account; main resolves the account to its config dir (the exact
// stored string, which the macOS keychain item is keyed on) and the daemon
// moves the pane's own conversation there (src/daemon/continueOnAccount.ts).
//
// A vault sign-in (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY or
// ANTHROPIC_AUTH_TOKEN) reaches a process only at spawn and is never typed.
// So when the target account holds one, or the source pane spawned with one
// (it would keep it over the new folder), the same pane cannot switch. The
// daemon then only copies the conversation (`session.copyToAccountV1`, a
// method of its own, so an older daemon refuses it instead of moving the pane
// in place), and the reply asks the renderer for a new pane beside the source
// one that resumes it on that account (`newPane`: the resume command and its
// folder, never a value of the vault). The source pane is left as is.

import { ipcMain } from 'electron';
import { IPC } from '../../shared/constants';
import type { DaemonClient } from '../DaemonClient';
import { getAccountStore, isAccessibleDir, isUnsafeKey, type Account } from './accountStore';
import { appAccountVault, holdsClaudeSignIn, paneHasVaultSignIn, type AccountVaultEntry } from './accountVault';
import { agentRow } from '../../shared/agentIdentity';
import { CHATV2_PROVIDER_SESSION_ID } from '../../shared/chatv2/ipc';
import { permissionFlagFor, type PermissionMode } from '../../shared/agentResume';

export type ContinuePaneResult =
  | { ok: true; newPane?: { accountId: string; command: string; cwd: string } }
  | { ok: false; code: string };

/** Stop grace (5 s) + prompt wait (5 s) + the copy of a large transcript, with room to spare. */
const CONTINUE_TIMEOUT_MS = 60_000;

export interface ContinuePaneDeps {
  account: (id: string) => Account | undefined;
  vaultEntries: (accountId: string) => ReadonlyArray<Pick<AccountVaultEntry, 'name' | 'inject' | 'usable'>>;
  /** Whether the source pane spawned with a Claude sign-in value from a vault. May throw. */
  sourceSignedIn: (ptyId: string, workspaceId: string | undefined) => boolean;
  dirOk: (dir: string) => boolean;
  connected: () => boolean;
  rpc: (method: 'session.continueOnAccount' | 'session.copyToAccountV1', params: { sessionId: string; configDir: string }) => Promise<unknown>;
}

export async function continuePane(
  deps: ContinuePaneDeps,
  args: { ptyId?: unknown; accountId?: unknown; workspaceId?: unknown } | undefined,
): Promise<ContinuePaneResult> {
  const ptyId = typeof args?.ptyId === 'string' && args.ptyId.length < 256 ? args.ptyId : '';
  const accountId = typeof args?.accountId === 'string' && !isUnsafeKey(args.accountId) ? args.accountId : '';
  const workspaceId = typeof args?.workspaceId === 'string' && args.workspaceId.length < 256 && !isUnsafeKey(args.workspaceId)
    ? args.workspaceId : undefined;
  if (!ptyId || !accountId) return { ok: false, code: 'invalid' };
  const account = deps.account(accountId);
  if (!account || !agentRow(account.vendor)?.continueOnAccount) return { ok: false, code: 'invalid_account' };
  if (!deps.dirOk(account.configDir)) return { ok: false, code: 'invalid_account' };
  // Local PTY mode has no daemon to own the stop and the relaunch.
  if (!deps.connected()) return { ok: false, code: 'unavailable' };
  let newPane: boolean;
  try {
    newPane = holdsClaudeSignIn(deps.vaultEntries(account.id)) || deps.sourceSignedIn(ptyId, workspaceId);
  } catch {
    // Unknown, so neither move is known to be right.
    return { ok: false, code: 'unavailable' };
  }
  try {
    const res = await deps.rpc(newPane ? 'session.copyToAccountV1' : 'session.continueOnAccount', { sessionId: ptyId, configDir: account.configDir }) as
      { ok?: unknown; code?: unknown; sessionId?: unknown; cwd?: unknown; permissionMode?: unknown } | null;
    if (res?.ok !== true) return { ok: false, code: typeof res?.code === 'string' ? res.code : 'unknown' };
    if (!newPane) return { ok: true };
    if (typeof res.sessionId !== 'string' || !CHATV2_PROVIDER_SESSION_ID.test(res.sessionId) || typeof res.cwd !== 'string' || !res.cwd) {
      return { ok: false, code: 'unknown_session' };
    }
    const flag = typeof res.permissionMode === 'string' ? permissionFlagFor(res.permissionMode as PermissionMode) : '';
    const command = ['claude', '--resume', res.sessionId, flag].filter(Boolean).join(' ');
    return { ok: true, newPane: { accountId: account.id, command, cwd: res.cwd } };
  } catch (err) {
    // A timeout is not a refusal: the daemon may still finish the move. A
    // daemon without the copy method answers Unknown method: nothing moved.
    return { ok: false, code: err instanceof Error && err.message.startsWith('RPC timeout') ? 'pending' : 'unavailable' };
  }
}

/** The source pane spawned with a vault sign-in: recorded at its create in
 *  this main run, else its workspace's Claude account holds one (a pane from
 *  before this main started got that account's vault, if any). */
function sourceSignedIn(ptyId: string, workspaceId: string | undefined): boolean {
  if (paneHasVaultSignIn(ptyId)) return true;
  const bound = workspaceId ? getAccountStore().getBinding(workspaceId, 'claude') : undefined;
  return !!bound && holdsClaudeSignIn(appAccountVault().list(bound));
}

export function registerContinueOnAccountHandler(daemonClient: DaemonClient | undefined): () => void {
  ipcMain.removeHandler(IPC.ACCOUNT_CONTINUE_PANE);
  ipcMain.handle(IPC.ACCOUNT_CONTINUE_PANE, async (_event, args: { ptyId?: unknown; accountId?: unknown; workspaceId?: unknown }): Promise<ContinuePaneResult> =>
    continuePane({
      account: (id) => getAccountStore().getAccount(id),
      vaultEntries: (id) => appAccountVault().list(id),
      sourceSignedIn,
      dirOk: isAccessibleDir,
      connected: () => !!daemonClient?.isConnected,
      rpc: async (method, params) => daemonClient?.rpc(method, params, { timeoutMs: CONTINUE_TIMEOUT_MS }),
    }, args));
  return () => { ipcMain.removeHandler(IPC.ACCOUNT_CONTINUE_PANE); };
}
