// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WorkspaceAccountMenu from '../WorkspaceAccountMenu';
import { useStore } from '../../../stores';
import { resetDaemonModeForTests, setDaemonModeActive } from '../../../daemon/daemonMode';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const surface = (ptyId: string, title: string) => ({ id: `s-${ptyId}`, ptyId, title, shell: '', cwd: '' });
const account = (id: string, name: string, loggedIn: boolean) => ({ id, name, vendor: 'claude', configDir: `/acc/${id}`, status: { loggedIn } });

let container: HTMLDivElement;
let root: Root;
let saved: ReturnType<typeof useStore.getState>;

function api(opts: { sessions: unknown[]; continuePane?: ReturnType<typeof vi.fn> }) {
  const bindings: Record<string, Record<string, string>> = { ws1: { claude: 'b' } };
  const pty = { list: vi.fn().mockResolvedValue(opts.sessions), write: vi.fn(), kill: vi.fn(), resize: vi.fn() };
  const accounts = {
    list: vi.fn(async () => ({ accounts: [account('a', 'Work', true), account('b', 'Home', false)], bindings })),
    setBinding: vi.fn(async ({ accountId }: { accountId?: string }) => { bindings.ws1 = accountId ? { claude: accountId } : {}; }),
    continuePane: opts.continuePane ?? vi.fn().mockResolvedValue({ ok: true }),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty, accounts };
  return { pty, accounts };
}

async function render() {
  await act(async () => { root.render(createElement(WorkspaceAccountMenu, { workspaceId: 'ws1', flipLeft: false })); });
  await act(async () => { await Promise.resolve(); });
  const vendor = container.querySelector('.relative') as HTMLElement;
  await act(async () => { vendor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
}

beforeEach(() => {
  saved = useStore.getState();
  useStore.setState({
    workspaces: [{
      id: 'ws1', name: 'ws', activePaneId: 'p1',
      rootPane: { type: 'leaf', id: 'p1', activeSurfaceId: 's-c1', surfaces: [surface('c1', '#w1-1'), surface('sh', '#w1-2'), surface('c2', '#w1-3')] },
    }] as never,
    surfaceAgent: { c1: { name: 'claude', status: 'idle', slug: 'claude' }, c2: { name: 'claude', status: 'running', slug: 'claude' } } as never,
    defaultShell: 'powershell',
  });
  setDaemonModeActive(true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useStore.setState(saved, true);
  resetDaemonModeForTests();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('WorkspaceAccountMenu', () => {
  it('marks an account signed out on Windows red in a native workspace, neutral in a WSL one', async () => {
    api({ sessions: [{ id: 'c1', shell: 'pwsh.exe' }] });
    await render();
    expect(container.textContent).toContain('logged out');
    expect(container.querySelector('[data-account-menu-wsl-sign-in]')).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    api({ sessions: [{ id: 'c1', shell: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] }] });
    await render();
    expect(container.textContent).not.toContain('logged out');
    expect(container.querySelector('[data-account-menu-wsl-sign-in]')?.textContent).toBe('sign-in in WSL');
  });

  it('switches only the Claude panes after a confirm, skips one in a turn, and leaves the shell pane\'s process alone', async () => {
    const continuePane = vi.fn(async ({ ptyId }: { ptyId: string }) => (ptyId === 'c2' ? { ok: false, code: 'turn_open' } : { ok: true }));
    const { pty, accounts } = api({ sessions: [], continuePane });
    await render();
    const action = container.querySelector('[data-account-menu-switch-panes]') as HTMLButtonElement;
    expect(action.textContent).toContain('Home');
    // Nothing runs on the first click: a confirm row first.
    await act(async () => { action.click(); });
    expect(continuePane).not.toHaveBeenCalled();
    const confirm = container.querySelector('[data-account-menu-switch-confirm]') as HTMLElement;
    expect(confirm.textContent).toContain('Continue 2 open Claude panes on Home');
    await act(async () => { (confirm.querySelector('button') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); });

    expect(accounts.setBinding).toHaveBeenCalledWith({ workspaceId: 'ws1', vendor: 'claude', accountId: 'b' });
    expect(continuePane.mock.calls.map(([a]) => a.ptyId)).toEqual(['c1', 'c2']);
    // The shell pane is never sent to the daemon, and no pty is written to, killed or resized.
    expect(continuePane.mock.calls.some(([a]) => a.ptyId === 'sh')).toBe(false);
    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.kill).not.toHaveBeenCalled();
    expect(pty.resize).not.toHaveBeenCalled();

    const toasts = useStore.getState().toasts.map((t) => t.message);
    expect(toasts).toContain('#w1-3: Wait for Claude to finish its turn, then try again.');
    expect(toasts).toContain('Open panes on Home: 1 switched, 1 skipped, 0 failed.');
  });

  it('keeps going after a failed pane and says the binding changed', async () => {
    const continuePane = vi.fn(async ({ ptyId }: { ptyId: string }) => {
      if (ptyId === 'c1') throw new Error('ipc gone');
      return { ok: true };
    });
    api({ sessions: [], continuePane });
    await render();
    await act(async () => { (container.querySelector('[data-account-menu-switch-panes]') as HTMLButtonElement).click(); });
    await act(async () => { (container.querySelector('[data-account-menu-switch-confirm] button') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); });
    expect(continuePane).toHaveBeenCalledTimes(2);
    const summary = useStore.getState().toasts.at(-1);
    expect(summary?.level).toBe('warn');
    expect(summary?.message).toBe('Open panes on Home: 1 switched, 0 skipped, 1 failed. The workspace now uses Home; the failed panes stay on their account.');
  });
});
