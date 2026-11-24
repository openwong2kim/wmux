// IPC for "Continue on <account>": the renderer names a pane and a registered
// Claude account; main resolves the account to its config dir (the exact
// stored string, which the macOS keychain item is keyed on) and the daemon
// moves the pane's own conversation there (src/daemon/continueOnAccount.ts).
//
// A vault sign-in (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY or
// ANTHROPIC_AUTH_TOKEN) reaches a process only at spawn and is never typed.
// So when the target account holds one, or the source pane spawned with one
// (it would keep it over the new folder), the same pane cannot switch. The
// daemon records the latter on the session at every spawn and refuses the
// move in place (`env_sign_in`) for it, or when it does not know; nothing
// here guesses it from the workspace binding. The daemon then only copies the conversation (`session.copyToAccountV1`, a
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
import { notePoolPaneMoved } from '../worktask/fanoutAccountPool';
import { isLinuxCwd } from '../../shared/wslTarget';

/** The pane that resumes a copied conversation on a token account. `wslFrom`:
 *  the source is a WSL pane, so this one opens in its distro as its user
 *  (pty.handler resolves both from that live pane), at a Linux `cwd`. */
export interface ContinueNewPane { accountId: string; command: string; cwd: string; wslFrom?: string }

export type ContinuePaneResult =
  | { ok: true; newPane?: ContinueNewPane }
  /** `resumeCommand`: Claude stopped and the copy exists, but it was not
   *  relaunched; the line that resumes the copy in the source pane's shell. */
  | { ok: false; code: string; resumeCommand?: string };

// eslint-disable-next-line no-control-regex -- the line is shown and copied, never typed for the person
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Stop grace (5 s) + prompt wait (5 s) + the copy of a large transcript, with room to spare. */
const CONTINUE_TIMEOUT_MS = 60_000;

export interface ContinuePaneDeps {
  account: (id: string) => Account | undefined;
  vaultEntries: (accountId: string) => ReadonlyArray<Pick<AccountVaultEntry, 'name' | 'inject' | 'usable'>>;
  /** The source pane spawned with a Claude sign-in value from a vault, known
   *  in this main run (the daemon's `env_sign_in` covers the rest). May throw. */
  sourceSignedIn: (ptyId: string) => boolean;
  dirOk: (dir: string) => boolean;
  connected: () => boolean;
  rpc: (method: 'session.continueOnAccountV2' | 'session.copyToAccountV1', params: { sessionId: string; configDir: string; wslNewPane?: true }) => Promise<unknown>;
  /** The daemon moved the pane to the account in place (a fan-out task's
   *  launch record follows: fanoutAccountPool.ts notePoolPaneMoved). */
  movedInPlace?: (ptyId: string, accountId: string) => void;
}

export async function continuePane(
  deps: ContinuePaneDeps,
  args: { ptyId?: unknown; accountId?: unknown; workspaceId?: unknown } | undefined,
): Promise<ContinuePaneResult> {
  const ptyId = typeof args?.ptyId === 'string' && args.ptyId.length < 256 ? args.ptyId : '';
  const accountId = typeof args?.accountId === 'string' && !isUnsafeKey(args.accountId) ? args.accountId : '';
  if (!ptyId || !accountId) return { ok: false, code: 'invalid' };
  const account = deps.account(accountId);
  if (!account || !agentRow(account.vendor)?.continueOnAccount) return { ok: false, code: 'invalid_account' };
  if (!deps.dirOk(account.configDir)) return { ok: false, code: 'invalid_account' };
  // Local PTY mode has no daemon to own the stop and the relaunch.
  if (!deps.connected()) return { ok: false, code: 'unavailable' };
  let newPane: boolean;
  try {
    newPane = holdsClaudeSignIn(deps.vaultEntries(account.id)) || deps.sourceSignedIn(ptyId);
  } catch {
    // Unknown, so neither move is known to be right.
    return { ok: false, code: 'unavailable' };
  }
  try {
    type Reply = { ok?: unknown; code?: unknown; sessionId?: unknown; cwd?: unknown; permissionMode?: unknown; resumeCommand?: unknown; wsl?: unknown } | null;
    const params = { sessionId: ptyId, configDir: account.configDir };
    // `wslNewPane`: this main opens a WSL pane's copy as that pane runs (ContinueNewPane.wslFrom).
    const copyParams = { ...params, wslNewPane: true as const };
    let res = await deps.rpc(newPane ? 'session.copyToAccountV1' : 'session.continueOnAccountV2', newPane ? copyParams : params) as Reply;
    // The daemon knows the pane spawned with a sign-in (or cannot tell): it
    // refused before anything stopped, so copy only, to a new pane.
    if (!newPane && res?.ok !== true && res?.code === 'env_sign_in') {
      newPane = true;
      res = await deps.rpc('session.copyToAccountV1', copyParams) as Reply;
    }
    if (res?.ok !== true) {
      const code = typeof res?.code === 'string' ? res.code : 'unknown';
      const resume = res?.resumeCommand;
      return typeof resume === 'string' && resume.length > 0 && resume.length <= 8192 && !CONTROL.test(resume)
        ? { ok: false, code, resumeCommand: resume }
        : { ok: false, code };
    }
    if (!newPane) {
      // Only now that the daemon confirmed the move (not on its own undo).
      try { deps.movedInPlace?.(ptyId, account.id); } catch { /* the record keeps the old account */ }
      return { ok: true };
    }
    if (typeof res.sessionId !== 'string' || !CHATV2_PROVIDER_SESSION_ID.test(res.sessionId) || typeof res.cwd !== 'string' || !res.cwd) {
      return { ok: false, code: 'unknown_session' };
    }
    const wsl = res.wsl === true;
    if (wsl && (!isLinuxCwd(res.cwd) || !res.cwd.startsWith('/'))) return { ok: false, code: 'unknown_session' };
    const flag = typeof res.permissionMode === 'string' ? permissionFlagFor(res.permissionMode as PermissionMode) : '';
    const command = ['claude', '--resume', res.sessionId, flag].filter(Boolean).join(' ');
    return { ok: true, newPane: { accountId: account.id, command, cwd: res.cwd, ...(wsl ? { wslFrom: ptyId } : {}) } };
  } catch (err) {
    // A timeout is not a refusal: the daemon may still finish the move. A
    // daemon without the method answers Unknown method: nothing moved. Any
    // other error (the daemon gone mid-call) may land after Claude stopped:
    // `lost`, a failure, never read as nothing having happened.
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('RPC timeout')) return { ok: false, code: 'pending' };
    return { ok: false, code: message.includes('Unknown method') ? 'unavailable' : 'lost' };
  }
}

export function registerContinueOnAccountHandler(daemonClient: DaemonClient | undefined): () => void {
  ipcMain.removeHandler(IPC.ACCOUNT_CONTINUE_PANE);
  ipcMain.handle(IPC.ACCOUNT_CONTINUE_PANE, async (_event, args: { ptyId?: unknown; accountId?: unknown; workspaceId?: unknown }): Promise<ContinuePaneResult> =>
    continuePane({
      account: (id) => getAccountStore().getAccount(id),
      vaultEntries: (id) => appAccountVault().list(id),
      sourceSignedIn: paneHasVaultSignIn,
      dirOk: isAccessibleDir,
      connected: () => !!daemonClient?.isConnected,
      rpc: async (method, params) => daemonClient?.rpc(method, params, { timeoutMs: CONTINUE_TIMEOUT_MS }),
      movedInPlace: notePoolPaneMoved,
    }, args));
  return () => { ipcMain.removeHandler(IPC.ACCOUNT_CONTINUE_PANE); };
}
