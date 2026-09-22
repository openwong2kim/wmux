import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountStore } from '../../account/accountStore';
import { handlePhoneAccounts } from '../PhoneAccounts';
import { workspaceAccountEnv } from '../../../daemon/phone/workspaceAccountEnv';

describe('phone binding persistence and subsequent pane account', () => {
  it('persists the binding in the main store and resolves it after reload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-phone-account-'));
    try {
      const configDir = path.join(dir, 'config');
      fs.mkdirSync(configDir);
      const store = new AccountStore(dir);
      const account = await store.addAccount({ name: 'Work', vendor: 'claude', configDir });
      const usage = { getAll: () => [], refreshNow: vi.fn(async () => { /* noop */ }) };
      await handlePhoneAccounts('accounts.bind', { workspaceId: 'ws-1', vendor: 'claude', accountId: account.id }, { store, usage });
      const reloaded = new AccountStore(dir);
      expect(reloaded.getBindings()['ws-1']).toEqual({ claude: account.id });
      const desktop = { available: true, request: (command: string, payload: Record<string, unknown>) => handlePhoneAccounts(command, payload, { store: reloaded, usage }) };
      expect(await workspaceAccountEnv({ PATH: '/bin' }, 'ws-1', desktop)).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: account.configDir });
      fs.rmSync(configDir, { recursive: true });
      await expect(workspaceAccountEnv({}, 'ws-1', desktop)).rejects.toThrow('bound account directory unavailable');
      await handlePhoneAccounts('accounts.bind', { workspaceId: 'ws-1', vendor: 'claude', accountId: null }, { store: reloaded, usage });
      expect(await workspaceAccountEnv({ CLAUDE_CONFIG_DIR: '/inherited' }, 'ws-1', desktop)).toEqual({});
      expect(usage.refreshNow).not.toHaveBeenCalled();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
