import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('../../stores', () => ({ useStore: { getState: () => store.state } }));

import {
  startAccountLogin,
  cancelAccountLogin,
  checkAccountLoginAgain,
  getPendingAccountLogins,
  LOGIN_POLL_INTERVAL_MS,
  LOGIN_TIMEOUT_MS,
} from '../accountLogin';

type Status = { loggedIn: boolean; stamp?: string | null };

let toastSeq = 0;

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
    create: vi.fn(async () => ({ id: 'pty-login', shell: '/bin/zsh', cwd: '/home/u' })),
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
    pushToast: vi.fn(() => `toast-${++toastSeq}`),
    dismissToast: vi.fn(),
  };
  (globalThis as unknown as { window: unknown }).window = { electronAPI: { accounts: api, pty } };
  return { api, pty, statuses, ws, state: store.state as Record<string, ReturnType<typeof vi.fn>> };
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
    statuses.push({ loggedIn: false }, { loggedIn: true, stamp: "s1" });
    await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS * 2);
    expect(api.add).toHaveBeenCalledWith({ name: 'Work', vendor: 'claude', configDir: '/acc/claude-1' });
    expect(getPendingAccountLogins()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(pty.dispose).toHaveBeenCalledWith('pty-login');
    expect(state.closeSurface).toHaveBeenCalledWith('pane-1', 'surf-login', 'ws-1');
  });

  it('a re-login waits for a NEW credential, not the stale one it replaces', async () => {
    const { api, statuses } = setup();
    statuses.push({ loggedIn: true, stamp: "old" }); // baseline read
    await startAccountLogin({ vendor: 'claude', name: 'Work', configDir: '/acc/claude-1', loginCommand: 'x', accountId: 'a1' });
    statuses.push({ loggedIn: true, stamp: "old" });
    await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS);
    expect(api.usageRefresh).not.toHaveBeenCalled();
    expect(getPendingAccountLogins()).toHaveLength(1);
    statuses.push({ loggedIn: true, stamp: "new" });
    await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS);
    expect(api.usageRefresh).toHaveBeenCalledWith('a1');
    expect(api.add).not.toHaveBeenCalled();
  });

  it('passes the real shell to addSurface, never the tab title (restore re-spawns it)', async () => {
    const { state } = setup();
    await startAccountLogin({ vendor: 'claude', name: 'Work', configDir: '/acc/claude-1', loginCommand: 'x' });
    expect(state.addSurface.mock.calls[0][2]).toBe('/bin/zsh');
  });

  it('a double click starts one watch and one tab', async () => {
    const { pty } = setup();
    const req = { vendor: 'claude' as const, name: 'Work', configDir: '/acc/claude-1', loginCommand: 'x' };
    await Promise.all([startAccountLogin(req), startAccountLogin(req)]);
    expect(pty.create).toHaveBeenCalledTimes(1);
    expect(getPendingAccountLogins()).toHaveLength(1);
  });

  it('disposes the pty when the target pane vanished during create', async () => {
    const { pty, ws, state } = setup();
    pty.create.mockImplementationOnce(async () => {
      ws.rootPane = { type: 'leaf', id: 'pane-other', surfaces: [] };
      return { id: 'pty-login', shell: '/bin/zsh', cwd: '/home/u' };
    });
    await startAccountLogin({ vendor: 'claude', name: 'Work', configDir: '/acc/claude-1', loginCommand: 'x' });
    expect(pty.dispose).toHaveBeenCalledWith('pty-login');
    expect(state.addSurface).not.toHaveBeenCalled();
    expect(getPendingAccountLogins()[0].tabOpen).toBe(false);
  });

  it('a re-login from a logged-out baseline completes on the first login', async () => {
    const { api, statuses } = setup();
    statuses.push({ loggedIn: false, stamp: null });
    await startAccountLogin({ vendor: 'claude', name: 'Work', configDir: '/acc/claude-1', loginCommand: 'x', accountId: 'a1' });
    statuses.push({ loggedIn: true, stamp: null });
    await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS);
    expect(api.usageRefresh).toHaveBeenCalledWith('a1');
  });

  it('a failed baseline read (after one retry) shows an error and opens no tab', async () => {
    const { api, pty } = setup();
    api.credentialStatus.mockRejectedValueOnce(new Error('ipc')).mockRejectedValueOnce(new Error('ipc'));
    await startAccountLogin({ vendor: 'claude', name: 'Work', configDir: '/acc/claude-1', loginCommand: 'x', accountId: 'a1' });
    expect(api.credentialStatus).toHaveBeenCalledTimes(2);
    expect(pty.create).not.toHaveBeenCalled();
    expect(getPendingAccountLogins()[0].phase).toBe('error');
    // Retrying starts over from the baseline read.
    checkAccountLoginAgain('/acc/claude-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(pty.create).toHaveBeenCalledTimes(1);
  });

  it('dismisses the persistent timeout toast once detection restarts or the watch ends', async () => {
    const { statuses, state } = setup();
    await startAccountLogin({ vendor: 'claude', name: 'Work', configDir: '/acc/claude-1', loginCommand: 'x' });
    await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS);
    expect(getPendingAccountLogins()[0].phase).toBe('timed-out');
    const timeoutToast = state.pushToast.mock.results.at(-1)?.value as string;
    expect(state.pushToast).toHaveBeenLastCalledWith(expect.objectContaining({ persist: true }));
    expect(state.dismissToast).not.toHaveBeenCalled();

    checkAccountLoginAgain('/acc/claude-1');
    expect(state.dismissToast).toHaveBeenCalledWith(timeoutToast);
    statuses.push({ loggedIn: true, stamp: 's1' });
    await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS);
    expect(getPendingAccountLogins()).toEqual([]);
    expect(state.dismissToast).toHaveBeenCalledTimes(1);

    // Cancelling after a timeout clears it too.
    const again = setup();
    await startAccountLogin({ vendor: 'claude', name: 'Work', configDir: '/acc/claude-2', loginCommand: 'x' });
    await vi.advanceTimersByTimeAsync(LOGIN_TIMEOUT_MS);
    const second = again.state.pushToast.mock.results.at(-1)?.value as string;
    cancelAccountLogin('/acc/claude-2');
    expect(again.state.dismissToast).toHaveBeenCalledWith(second);
  });

  it('cancelling a NEW-account login closes its tab; a re-login keeps it', async () => {
    const { pty, state } = setup();
    await startAccountLogin({ vendor: 'claude', name: 'Work', configDir: '/acc/claude-1', loginCommand: 'x' });
    cancelAccountLogin('/acc/claude-1');
    expect(pty.dispose).toHaveBeenCalledWith('pty-login');
    expect(state.closeSurface).toHaveBeenCalled();

    const again = setup();
    await startAccountLogin({ vendor: 'claude', name: 'Work', configDir: '/acc/claude-2', loginCommand: 'x', accountId: 'a2' });
    cancelAccountLogin('/acc/claude-2');
    expect(again.pty.dispose).not.toHaveBeenCalled();
  });
});
