// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openTerminalTab = vi.hoisted(() => vi.fn(async () => ({ workspaceId: 'ws-1', ptyId: 'login-pty' }) as { workspaceId: string; ptyId: string } | null));
vi.mock('../../utils/accountLogin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/accountLogin')>()),
  openTerminalTab,
}));

import { useStore } from '../../stores';
import { workspaceHasAuthLost } from '../../stores/slices/agentAuthSlice';
import { applyAuthLostEntries, resetAgentAuthBridgeForTests, signInAgain } from '../useAgentAuthBridge';
import type { AuthLostEntry } from '../../../shared/agentAuthLost';
import type { SessionData, Workspace } from '../../../shared/types';

const entry = (over: Partial<AuthLostEntry> = {}): AuthLostEntry => ({ key: 'claude:', agent: 'claude', configDir: null, ptyIds: ['pty-1'], ...over });
const ws = () => ({
  id: 'ws-1', name: 'One', activePaneId: 'p',
  rootPane: { id: 'p', type: 'leaf', activeSurfaceId: 's', surfaces: [{ id: 's', ptyId: 'pty-1', title: 't', shell: 'zsh', cwd: '/x', surfaceType: 'terminal' }] },
}) as unknown as Workspace;
const loginState = vi.fn();

beforeEach(() => {
  resetAgentAuthBridgeForTests();
  useStore.getState().loadSession({ workspaces: [ws()], activeWorkspaceId: 'ws-1', sidebarVisible: true } as SessionData);
  useStore.getState().clearToasts();
  vi.stubGlobal('electronAPI', { agentAuth: { loginState } });
});
afterEach(() => { vi.unstubAllGlobals(); loginState.mockReset(); openTerminalTab.mockClear(); });

describe('lost sign-in bridge', () => {
  it('shows one [Sign in again] toast per agent and account and takes it and the sidebar mark away when the entry goes', () => {
    applyAuthLostEntries([entry(), entry({ key: 'codex:', agent: 'codex', ptyIds: [] })]);
    expect(useStore.getState().toasts.map((t) => t.action?.label)).toEqual(['Sign in again', 'Sign in again']);
    expect(workspaceHasAuthLost(useStore.getState(), 'ws-1')).toBe(true);
    // Another report for the same account: no second toast.
    applyAuthLostEntries([entry({ ptyIds: ['pty-1', 'pty-2'] }), entry({ key: 'codex:', agent: 'codex', ptyIds: [] })]);
    expect(useStore.getState().toasts).toHaveLength(2);
    applyAuthLostEntries([]);
    expect(useStore.getState().toasts).toEqual([]);
    expect(workspaceHasAuthLost(useStore.getState(), 'ws-1')).toBe(false);
  });

  it("opens the agent's own sign-in for that account and stops once the agent says signed in", async () => {
    const lost = entry({ configDir: '/acc/work', key: 'claude:/acc/work' });
    applyAuthLostEntries([lost]);
    loginState.mockResolvedValueOnce({ known: true, signedIn: false }).mockResolvedValueOnce({ known: true, signedIn: true });
    await signInAgain(lost, { sleep: async () => undefined });
    expect(openTerminalTab).toHaveBeenCalledWith(expect.objectContaining({
      plainEnv: true, env: { CLAUDE_CONFIG_DIR: '/acc/work' }, initialCommand: 'claude auth login',
    }));
    expect(loginState).toHaveBeenCalledTimes(2);
    // main drops the entry on that answer; the next snapshot clears the rest.
    applyAuthLostEntries([]);
    expect(useStore.getState().toasts).toEqual([]);
  });

  // A WSL pane on a bound account signed out of the account's Linux home (shared/wslAccountMark.ts).
  it('signs a WSL account home in again in that distro, and waits for the pane\'s own report', async () => {
    const lost = entry({ configDir: 'wsl:Ubuntu-24.04:C:\\acc\\work', key: 'claude:wsl:Ubuntu-24.04:C:\\acc\\work' });
    applyAuthLostEntries([lost]);
    // main cannot read that sign-in: "cannot tell" until the entry goes.
    loginState.mockResolvedValueOnce({ known: true, signedIn: null }).mockResolvedValueOnce({ known: false });
    await signInAgain(lost, { sleep: async () => undefined });
    expect(openTerminalTab).toHaveBeenCalledWith(expect.objectContaining({
      plainEnv: true, shell: 'wsl.exe', wslDistro: 'Ubuntu-24.04',
      env: { CLAUDE_CONFIG_DIR: 'C:\\acc\\work' }, wslAccountHomeKey: 'CLAUDE_CONFIG_DIR', initialCommand: 'claude auth login',
    }));
    expect(openTerminalTab).not.toHaveBeenCalledWith(expect.objectContaining({ wslAccountLoginEnvKey: expect.anything() }));
    expect(loginState).toHaveBeenCalledTimes(2);
  });

  it('offers the toast again when the sign-in tab cannot open, and only once', async () => {
    applyAuthLostEntries([entry()]);
    const press = async () => {
      const toast = useStore.getState().toasts[0];
      useStore.getState().dismissToast(toast.id); // the container dismisses after the action runs
      toast.action!.onClick();
      await vi.waitFor(() => expect(useStore.getState().toasts).toHaveLength(1), { timeout: 5_000 });
    };
    openTerminalTab.mockRejectedValueOnce(new Error('pty create failed'));
    await press();
    // The wait is over, so a second press starts a fresh one; still one toast.
    openTerminalTab.mockResolvedValueOnce(null);
    await press();
    expect(useStore.getState().toasts.map((t) => t.action?.label)).toEqual(['Sign in again']);
  });

  it("marks the workspace's row for a loss in a stashed pane", () => {
    const stashed = {
      ...ws(),
      stashedPanes: [{ pane: { id: 'p2', type: 'leaf', activeSurfaceId: 's2', surfaces: [{ id: 's2', ptyId: 'pty-stashed', title: 't', shell: 'zsh', cwd: '/x', surfaceType: 'terminal' }] }, stashedAt: 1 }],
    } as unknown as Workspace;
    useStore.getState().loadSession({ workspaces: [stashed], activeWorkspaceId: 'ws-1', sidebarVisible: true } as SessionData);
    applyAuthLostEntries([entry({ ptyIds: ['pty-stashed'] })]);
    expect(workspaceHasAuthLost(useStore.getState(), 'ws-1')).toBe(true);
  });
});
