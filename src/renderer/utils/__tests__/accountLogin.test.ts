import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('../../stores', () => ({ useStore: { getState: () => store.state } }));

import {
  startAccountLogin,
  cancelAccountLogin,
  getPendingAccountLogins,
  LOGIN_POLL_INTERVAL_MS,
} from '../accountLogin';

type Status = { loggedIn: boolean; stamp?: number | null };

function setup(profileEnv?: Record<string, string>) {
  const surfaces: Array<{ id: string; ptyId: string }> = [];
  const ws = {
    id: 'ws-1',
    activePaneId: 'pane-1',
    profile: profileEnv ? { env: profileEnv } : undefined,
    rootPane: { type: 'leaf', id: 'pane-1', surfaces },
  };
  const statuses: Status[] = [];
  const api = {
    credentialStatus: vi.fn(async () => statuses.shift() ?? { loggedIn: false }),
    add: vi.fn(async () => ({})),
    usageRefresh: vi.fn(),
  };
  const pty = {
    create: vi.fn(async () => ({ id: 'pty-login', cwd: '/home/u' })),
    dispose: vi.fn(async () => undefined),
  };
  store.state = {
    paneGate: 'ready',
    activeWorkspaceId: 'ws-1',
    workspaces: [ws],
    startupDirectory: '',
    defaultShell: '',
    addSurface: vi.fn((_p: string, ptyId: string) => { surfaces.push({ id: 'surf-login', ptyId }); }),
    updateSurfaceTitle: vi.fn(),
    setActivePane: vi.fn(),
    setSettingsPanelVisible: vi.fn(),
    closeSurface: vi.fn(),
    closePane: vi.fn(),
    pushToast: vi.fn(),
  };
  (globalThis as unknown as { window: unknown }).window = { electronAPI: { accounts: api, pty } };
  return { api, pty, statuses, state: store.state as Record<string, ReturnType<typeof vi.fn>> };
}

describe('startAccountLogin', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    for (const p of getPendingAccountLogins()) cancelAccountLogin(p.configDir);
    vi.useRealTimers();
  });

  it('opens a titled tab with the account dir in env, winning over the profile', async () => {
    const { pty, state } = setup({ CLAUDE_CONFIG_DIR: '/profile/dir', FOO: 'bar' });
    await startAccountLogin({ vendor: 'claude', name: 'Work', configDir: '/acc/claude-1', loginCommand: 'x' });
    const opts = (pty.create.mock.calls[0] as unknown[])[0] as { env: Record<string, string>; initialCommand: string };
    expect(opts.env).toEqual({ CLAUDE_CONFIG_DIR: '/acc/claude-1', FOO: 'bar' });
    expect(opts.initialCommand).toBe('claude auth login');
    expect(state.updateSurfaceTitle).toHaveBeenCalledWith('surf-login', 'Log in: Work');
    expect(state.setSettingsPanelVisible).toHaveBeenCalledWith(false);
  });

  it('uses CODEX_HOME + codex login for codex', async () => {
    const { pty } = setup();
    await startAccountLogin({ vendor: 'codex', name: 'C', configDir: '/acc/codex-1', loginCommand: 'x' });
    const opts = (pty.create.mock.calls[0] as unknown[])[0] as { env: Record<string, string>; initialCommand: string };
    expect(opts.env).toEqual({ CODEX_HOME: '/acc/codex-1' });
    expect(opts.initialCommand).toBe('codex login');
  });

  it('registers a new account and closes the tab once the login lands', async () => {
    const { api, pty, statuses, state } = setup();
    await startAccountLogin({ vendor: 'claude', name: 'Work', configDir: '/acc/claude-1', loginCommand: 'x' });
    statuses.push({ loggedIn: false }, { loggedIn: true, stamp: 1 });
    await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS * 2);
    expect(api.add).toHaveBeenCalledWith({ name: 'Work', vendor: 'claude', configDir: '/acc/claude-1' });
    expect(getPendingAccountLogins()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(pty.dispose).toHaveBeenCalledWith('pty-login');
    expect(state.closeSurface).toHaveBeenCalledWith('pane-1', 'surf-login', 'ws-1');
  });

  it('a re-login waits for a NEW credential, not the stale one it replaces', async () => {
    const { api, statuses } = setup();
    statuses.push({ loggedIn: true, stamp: 100 }); // baseline read
    await startAccountLogin({ vendor: 'claude', name: 'Work', configDir: '/acc/claude-1', loginCommand: 'x', accountId: 'a1' });
    statuses.push({ loggedIn: true, stamp: 100 });
    await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS);
    expect(api.usageRefresh).not.toHaveBeenCalled();
    expect(getPendingAccountLogins()).toHaveLength(1);
    statuses.push({ loggedIn: true, stamp: 200 });
    await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS);
    expect(api.usageRefresh).toHaveBeenCalledWith('a1');
    expect(api.add).not.toHaveBeenCalled();
  });
});
