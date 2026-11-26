// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WorkspaceAccountMenu from '../WorkspaceAccountMenu';
import { useStore } from '../../../stores';
import { resetDaemonModeForTests, setDaemonModeActive } from '../../../daemon/daemonMode';
import { beginSwitch, endSwitch, resetSwitchStateForTests } from '../switchWorkspacePanes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const surface = (ptyId: string, title: string) => ({ id: `s-${ptyId}`, ptyId, title, shell: '', cwd: '' });
const account = (id: string, name: string, loggedIn: boolean) => ({ id, name, vendor: 'claude', configDir: `/acc/${id}`, status: { loggedIn } });

let container: HTMLDivElement;
let root: Root;
let saved: ReturnType<typeof useStore.getState>;

function api(opts: { sessions: unknown[]; continuePane?: ReturnType<typeof vi.fn>; homeSignedIn?: boolean }) {
  const bindings: Record<string, Record<string, string>> = { ws1: { claude: 'b' } };
  const pty = { list: vi.fn().mockResolvedValue(opts.sessions), write: vi.fn(), kill: vi.fn(), resize: vi.fn() };
  const accounts = {
    list: vi.fn(async () => ({ accounts: [account('a', 'Work', true), account('b', 'Home', opts.homeSignedIn ?? false)], bindings })),
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
  resetSwitchStateForTests();
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
    const wsl = (id: string) => ({ id, shell: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] });
    api({ sessions: [wsl('c1'), wsl('sh'), wsl('c2')] });
    await render();
    expect(container.textContent).not.toContain('logged out');
    expect(container.querySelector('[data-account-menu-wsl-sign-in]')?.textContent).toBe('sign-in in WSL');
  });

  it('switches only the Claude panes after a confirm, skips one in a turn, and leaves the shell pane\'s process alone', async () => {
    const continuePane = vi.fn(async ({ ptyId }: { ptyId: string }) => (ptyId === 'c2' ? { ok: false, code: 'turn_open' } : { ok: true }));
    const { pty, accounts } = api({ sessions: [], continuePane, homeSignedIn: true });
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
    const skipped = useStore.getState().toasts.find((t) => t.message.startsWith('#w1-3: '));
    expect(skipped).toMatchObject({ level: 'warn', message: '#w1-3: Wait for Claude to finish its turn, then try again.' });
    expect(toasts).toContain('Open panes on Home: 1 switched, 0 already on it, 0 continued in a new pane beside, 1 skipped, 0 failed.');
  });

  it('keeps going after a failed pane and says the binding changed', async () => {
    const continuePane = vi.fn(async ({ ptyId }: { ptyId: string }) => {
      if (ptyId === 'c1') throw new Error('ipc gone');
      return { ok: true };
    });
    api({ sessions: [], continuePane, homeSignedIn: true });
    await render();
    await act(async () => { (container.querySelector('[data-account-menu-switch-panes]') as HTMLButtonElement).click(); });
    await act(async () => { (container.querySelector('[data-account-menu-switch-confirm] button') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); });
    expect(continuePane).toHaveBeenCalledTimes(2);
    const summary = useStore.getState().toasts.at(-1);
    expect(summary?.level).toBe('warn');
    expect(summary?.message).toBe('Open panes on Home: 1 switched, 0 already on it, 0 continued in a new pane beside, 0 skipped, 1 failed. The workspace now uses Home; new panes start on it.');
  });

  it('with the account signed out on Windows, switches only the WSL panes and skips the native ones', async () => {
    const continuePane = vi.fn().mockResolvedValue({ ok: true });
    api({ sessions: [{ id: 'c1', shell: 'pwsh.exe' }, { id: 'c2', shell: 'wsl.exe' }], continuePane });
    await render();
    await act(async () => { (container.querySelector('[data-account-menu-switch-panes]') as HTMLButtonElement).click(); });
    await act(async () => { (container.querySelector('[data-account-menu-switch-confirm] button') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); });
    expect(continuePane.mock.calls.map(([a]) => a.ptyId)).toEqual(['c2']);
    expect(useStore.getState().toasts.find((t) => t.message.startsWith('#w1-1: '))?.level).toBe('warn');
  });

  it('drops "now uses" when the binding changed during the run, and calls a broken copy a failure', async () => {
    let bindingsRef: Record<string, Record<string, string>> | null = null;
    const continuePane = vi.fn(async ({ ptyId }: { ptyId: string }) => {
      // Someone binds another account while the run is going.
      if (bindingsRef) bindingsRef.ws1 = { claude: 'a' };
      return ptyId === 'c1' ? { ok: false, code: 'diverged' } : { ok: true };
    });
    const { accounts } = api({ sessions: [], continuePane, homeSignedIn: true });
    const list = accounts.list;
    bindingsRef = (await list()).bindings;
    await render();
    await act(async () => { (container.querySelector('[data-account-menu-switch-panes]') as HTMLButtonElement).click(); });
    await act(async () => { (container.querySelector('[data-account-menu-switch-confirm] button') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); });
    const toasts = useStore.getState().toasts;
    expect(toasts.find((t) => t.message.startsWith('#w1-1: '))?.level).toBe('error');
    expect(toasts.at(-1)?.message).toBe('Open panes on Home: 1 switched, 0 already on it, 0 continued in a new pane beside, 0 skipped, 1 failed.');
  });

  it('a run in flight disables the action and the rows, and a reopened menu is enabled again when it ends', async () => {
    api({ sessions: [], homeSignedIn: true });
    expect(beginSwitch('ws1')).toBe(true);
    expect(beginSwitch('ws1')).toBe(false);
    await render();
    expect((container.querySelector('[data-account-menu-switch-panes]') as HTMLButtonElement).disabled).toBe(true);
    const rows = [...container.querySelectorAll('button')].filter((b) => b.textContent?.includes('Work'));
    expect(rows[0]?.disabled).toBe(true);
    await act(async () => { endSwitch('ws1'); });
    expect((container.querySelector('[data-account-menu-switch-panes]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers no switch where every pane is native and the account is signed out on Windows', async () => {
    api({ sessions: [{ id: 'c1', shell: 'pwsh.exe' }, { id: 'c2', shell: 'pwsh.exe' }] });
    await render();
    expect((container.querySelector('[data-account-menu-switch-panes]') as HTMLButtonElement).disabled).toBe(true);
  });
});
