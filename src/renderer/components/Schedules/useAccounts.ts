import { useEffect, useState } from 'react';
import type { AutomationAgent } from '../../../shared/automation';

export interface AccountOption {
  id: string;
  name: string;
  vendor: AutomationAgent;
  /** Signs in only with a long-lived token from wmux's vault, which a
   *  scheduled run (started by the daemon) does not get. */
  tokenOnly?: true;
}

/** A registered account as the schedule editor offers it. Pure. */
export function accountOption(a: {
  id: string;
  name: string;
  vendor: AutomationAgent;
  status: { loggedIn: boolean };
  tokenSignIn?: unknown;
}): AccountOption {
  return { id: a.id, name: a.name, vendor: a.vendor, ...(a.tokenSignIn && !a.status.loggedIn ? { tokenOnly: true as const } : {}) };
}

/** Registered agent accounts (accounts.json via main), read once per mount. */
export function useAccounts(): AccountOption[] {
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  useEffect(() => {
    let alive = true;
    const api = window.electronAPI?.accounts;
    if (!api) return undefined;
    api.list()
      .then((res) => {
        if (!alive) return;
        setAccounts(res.accounts.map(accountOption));
      })
      .catch(() => { /* no accounts registered / older main: default account only */ });
    return () => { alive = false; };
  }, []);
  return accounts;
}
