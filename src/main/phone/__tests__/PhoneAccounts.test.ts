import { describe, expect, it, vi } from 'vitest';
import { handlePhoneAccounts } from '../PhoneAccounts';

function fixture() {
  const account = { id: 'a1', name: 'Work', vendor: 'claude' as const, configDir: '/private/account', createdAt: 1 };
  return {
    store: {
      listAccounts: () => [account], getAccount: (id: string) => id === 'a1' ? account : undefined,
      getBindings: () => ({ 'ws-1': { claude: 'a1' } }), setBinding: vi.fn(async () => { /* noop */ }),
      resolveWorkspaceAccountEnv: vi.fn(() => ({ CLAUDE_CONFIG_DIR: '/private/account' })),
    },
    usage: { getAll: () => [{ accountId: 'a1', status: 'error' as const, snapshot: null, fetchedAtMs: 1, lastError: 'private diagnostic' }], refreshNow: vi.fn(async () => { /* noop */ }) },
  };
}
describe('phone account projection', () => {
  it('returns cached usage without probing or disclosing local paths and diagnostics', async () => {
    const deps = fixture();
    const value = await handlePhoneAccounts('accounts.list', { workspaceId: 'ws-1' }, deps);
    expect(value).toEqual({ workspaceId: 'ws-1', bindings: { claude: 'a1' }, accounts: [{ id: 'a1', name: 'Work', vendor: 'claude', usageSupported: true, usage: { status: 'error', snapshot: null, fetchedAtMs: 1 } }] });
    expect(JSON.stringify(value)).not.toContain('private');
    expect(deps.usage.refreshNow).not.toHaveBeenCalled();
  });
  it('routes a binding through the existing desktop writer', async () => {
    const deps = fixture();
    await handlePhoneAccounts('accounts.bind', { workspaceId: 'ws-1', vendor: 'claude', accountId: null }, deps);
    expect(deps.store.setBinding).toHaveBeenCalledWith('ws-1', 'claude', undefined);
  });
  it('probes usage only for an explicitly requested known account', async () => {
    const deps = fixture();
    await expect(handlePhoneAccounts('accounts.usage', { workspaceId: 'ws-1', accountId: 'unknown' }, deps)).rejects.toThrow();
    expect(deps.usage.refreshNow).not.toHaveBeenCalled();
    await handlePhoneAccounts('accounts.usage', { workspaceId: 'ws-1', accountId: 'a1' }, deps);
    expect(deps.usage.refreshNow).toHaveBeenCalledExactlyOnceWith('a1');
  });
  it('rejects prototype keys and arbitrary commands before mutating', async () => {
    const deps = fixture();
    await expect(handlePhoneAccounts('accounts.bind', { workspaceId: '__proto__' }, deps)).rejects.toThrow();
    await expect(handlePhoneAccounts('shell.exec', { workspaceId: 'ws-1' }, deps)).rejects.toThrow();
    expect(deps.store.setBinding).not.toHaveBeenCalled();
  });
});
