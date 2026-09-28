import { useEffect, useState } from 'react';
import type { AutomationAgent } from '../../../shared/automation';

export interface AccountOption {
  id: string;
  name: string;
  vendor: AutomationAgent;
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
        setAccounts(res.accounts.map((a) => ({ id: a.id, name: a.name, vendor: a.vendor })));
      })
      .catch(() => { /* no accounts registered / older main: default account only */ });
    return () => { alive = false; };
  }, []);
  return accounts;
}
