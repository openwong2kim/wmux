// @vitest-environment jsdom
//
// "Continue on <account>": which accounts the submenu offers. An account's
// sign-in status is its Windows folder's, so it gates a native pane only; a
// WSL pane runs the account on its own home in the distro, where Claude asks
// for a sign-in itself.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePaneContinueOnAccount } from '../usePaneContinueOnAccount';
import { useStore } from '../../../stores';
import { resetDaemonModeForTests, setDaemonModeActive } from '../../../daemon/daemonMode';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let hook: ReturnType<typeof usePaneContinueOnAccount> | undefined;

function Probe() {
  hook = usePaneContinueOnAccount({ ptyId: 'pty-1', allowed: true });
  return null;
}

const signedOut = { id: 'acc-b', name: 'B', vendor: 'claude', configDir: 'C:\\b', status: { loggedIn: false } };
const signedIn = { id: 'acc-c', name: 'C', vendor: 'claude', configDir: 'C:\\c', status: { loggedIn: true } };

function mount(session: Record<string, unknown>) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    accounts: { list: vi.fn(async () => ({ accounts: [signedOut, signedIn], bindings: {} })), continuePane: vi.fn() },
    pty: { list: vi.fn(async () => [{ id: 'pty-1', ...session }]), resources: vi.fn() },
  };
  act(() => root.render(createElement(Probe)));
}

async function reload(): Promise<Record<string, boolean>> {
  await act(async () => { hook?.reload(); await new Promise((r) => setTimeout(r, 0)); });
  return Object.fromEntries((hook?.subItems ?? []).map((i) => [i.key, i.disabled === true]));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  setDaemonModeActive(true);
  act(() => useStore.setState({ surfaceAgent: { 'pty-1': { name: 'Claude', status: 'idle', slug: 'claude' } } as never }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  hook = undefined;
  resetDaemonModeForTests();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  act(() => useStore.setState({ surfaceAgent: {} }));
});

describe('continue on account: sign-in gate', () => {
  it('greys out an account its Windows folder has no sign-in for, in a native pane', async () => {
    mount({ shell: 'pwsh.exe' });
    expect(await reload()).toEqual({ 'continue-account:acc-b': true, 'continue-account:acc-c': false });
  });

  it('offers every account in a WSL pane, whatever its Windows folder holds', async () => {
    mount({ shell: 'wsl.exe', wslTarget: { distribution: 'Ubuntu', user: 'me' } });
    expect(await reload()).toEqual({ 'continue-account:acc-b': false, 'continue-account:acc-c': false });
  });
});
