import { isAccessibleDir, type AccountStore } from '../account/accountStore';
import { PANE_ACCOUNT_ENV_KEY, type AccountEnvForAccountResult } from '../../shared/phonePaneAccount';
import type { AccountUsageService } from '../account/AccountUsageService';

interface AccountDeps {
  store: Pick<AccountStore,'listAccounts'|'getBindings'|'setBinding'|'resolveWorkspaceAccountEnv'|'resolveAccountEnv'|'getAccount'>;
  usage: Pick<AccountUsageService,'getAll'|'refreshNow'>;
}

/** All account writes retain the desktop's single-writer queue. */
export async function handlePhoneAccounts(command: string, payload: Record<string,unknown>, deps: AccountDeps): Promise<unknown> {
  const workspaceId = payload.workspaceId;
  if (typeof workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId) ||
      ['__proto__','constructor','prototype'].includes(workspaceId)) throw new Error('invalid workspace');
  const {store,usage} = deps;
  if (command === 'accounts.env' && payload.typed === true) {
    // Typed form, sent only by a daemon that saw this desktop announce
    // accounts.envForAccount. A missing bound directory is an answer the
    // daemon can name, and `omitVendor` skips the binding a pane-chosen
    // account replaces, so a broken binding for it cannot block that pane.
    const omit = payload.omitVendor;
    if (omit !== undefined && omit !== 'claude' && omit !== 'codex') throw new Error('invalid vendor');
    let missing = false;
    const env: Record<string,string> = {};
    for (const vendor of ['claude','codex'] as const) {
      if (vendor !== omit) Object.assign(env,store.resolveAccountEnv(workspaceId,vendor,() => { missing = true; }));
    }
    return missing ? {ok:false,error:'workspace-account-missing'} : {ok:true,env};
  }
  if (command === 'accounts.env') {
    let missing = false;
    const env = store.resolveWorkspaceAccountEnv(workspaceId, () => { missing = true; });
    if (missing) throw new Error('bound account directory unavailable');
    return env;
  }
  if (command === 'accounts.envForAccount') {
    // One pane's account: resolved here from the desktop registry, never from
    // a path the phone sent. Read-only: the workspace binding is not touched.
    // Refusals are answers, not errors, so the daemon can tell them apart.
    const accountId = payload.accountId;
    const account = typeof accountId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(accountId) &&
      !['__proto__','constructor','prototype'].includes(accountId) ? store.getAccount(accountId) : undefined;
    let result: AccountEnvForAccountResult;
    if (!account) result = {ok:false,error:'unknown-account'};
    else if (!isAccessibleDir(account.configDir)) result = {ok:false,error:'account-directory-missing'};
    else result = {ok:true,vendor:account.vendor,env:{[PANE_ACCOUNT_ENV_KEY[account.vendor]]:account.configDir}};
    return result;
  }
  if (command === 'accounts.bind') {
    if (payload.vendor !== 'claude' && payload.vendor !== 'codex') throw new Error('invalid vendor');
    if (payload.accountId !== null && typeof payload.accountId !== 'string') throw new Error('invalid account');
    await store.setBinding(workspaceId,payload.vendor,payload.accountId === null ? undefined : payload.accountId as string);
  } else if (command === 'accounts.usage') {
    if (typeof payload.accountId !== 'string') throw new Error('invalid account');
    const account = store.getAccount(payload.accountId);
    if (!account || account.vendor !== 'claude') throw new Error('usage unsupported');
    await usage.refreshNow(account.id);
  } else if (command !== 'accounts.list') throw new Error('unsupported phone command');
  const accounts = store.listAccounts();
  const entries = new Map(usage.getAll().map(e => [e.accountId,e]));
  return {
    workspaceId,
    bindings:store.getBindings()[workspaceId] ?? {},
    accounts:accounts.map(a => {
      const u = entries.get(a.id);
      return {
        id:a.id,name:a.name,vendor:a.vendor,
        usageSupported:a.vendor === 'claude',
        usage:u ? {status:u.status,snapshot:u.snapshot,fetchedAtMs:u.fetchedAtMs} : null,
      };
    }),
  };
}
