// @vitest-environment jsdom
//
// The Git page's connect card: Connect → the code dialog → Copy & open
// (clipboard + GitHub's device page) → done reloads the page; cancel stops
// gh; a failure that cannot read gh offers the terminal-tab sign-in; no gh
// shows how to install it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GhLoginEvent, GhLoginStartResult } from '../../../../shared/ghDeviceLogin';

const openTab = vi.fn(async (_title: string) => false);
vi.mock('../connectGithub', () => ({
  GH_LOGIN_COMMAND: 'gh auth login --web',
  openGithubLoginTab: (title: string) => openTab(title),
}));

import { GhConnectPage } from '../GhConnectPage';

let container: HTMLDivElement;
let root: Root;
let emit: (e: GhLoginEvent) => void;
let startResult: GhLoginStartResult;
const loginStart = vi.fn(async () => startResult);
const loginCancel = vi.fn(async () => undefined);
const openExternal = vi.fn(async (_url: string) => undefined);
const writeText = vi.fn(async (_text: string) => undefined);
const onConnected = vi.fn();
const onRecheck = vi.fn();

function install(platform = 'darwin') {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform,
    shell: { openExternal },
    github: {
      loginStart,
      loginCancel,
      onLoginEvent: (cb: (e: GhLoginEvent) => void) => {
        emit = cb;
        return () => { emit = () => undefined; };
      },
    },
  };
  (window as unknown as { clipboardAPI: unknown }).clipboardAPI = { writeText };
}

beforeEach(() => {
  startResult = { ok: true };
  for (const f of [loginStart, loginCancel, openExternal, writeText, onConnected, onRecheck, openTab]) f.mockClear();
  install();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  delete (window as unknown as { clipboardAPI?: unknown }).clipboardAPI;
});

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const mount = async (gate: 'unauthenticated' | 'cli-missing' = 'unauthenticated') => {
  act(() => root.render(createElement(GhConnectPage, { gate, onRecheck, onConnected })));
  await flush();
};
const connect = async () => {
  await act(async () => { q('[data-gh-connect-button]')!.click(); });
  await flush();
};

describe('GhConnectPage', () => {
  it('Connect → code dialog → Copy & open → done calls onConnected', async () => {
    await mount();
    expect(q('[data-gh-connect]')?.textContent).toContain('wmux stores no token');
    await connect();
    expect(loginStart).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="gh-connect-dialog"]')?.textContent).toContain('Getting a sign-in code');
    act(() => emit({ kind: 'code', code: 'ABCD-1234', url: 'https://github.com/login/device' }));
    expect(q('[data-gh-connect-code]')?.textContent).toBe('ABCD-1234');
    expect(q('[data-testid="gh-connect-dialog"]')?.textContent).toContain('Waiting for GitHub');
    await act(async () => { q('[data-gh-connect-copy-open]')!.click(); });
    await flush();
    expect(writeText).toHaveBeenCalledWith('ABCD-1234');
    expect(openExternal).toHaveBeenCalledWith('https://github.com/login/device');
    act(() => emit({ kind: 'done' }));
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="gh-connect-dialog"]')).toBeNull();
  });

  it('opens GitHub even when the clipboard write fails', async () => {
    writeText.mockRejectedValueOnce(new Error('CLIPBOARD_WRITE_FAILED'));
    await mount();
    await connect();
    act(() => emit({ kind: 'code', code: 'ABCD-1234', url: 'https://github.com/login/device' }));
    await act(async () => { q('[data-gh-connect-copy-open]')!.click(); });
    await flush();
    expect(openExternal).toHaveBeenCalledWith('https://github.com/login/device');
  });

  it('Cancel stops the login and closes the dialog', async () => {
    await mount();
    await connect();
    act(() => emit({ kind: 'code', code: 'ABCD-1234', url: 'https://github.com/login/device' }));
    await act(async () => { q('[data-gh-connect-cancel]')!.click(); });
    expect(loginCancel).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="gh-connect-dialog"]')).toBeNull();
  });

  it('failed with fallback offers the terminal tab, then the command when no tab opens', async () => {
    await mount();
    await connect();
    act(() => emit({ kind: 'failed', message: 'gh did not show a sign-in code', fallback: true }));
    const dialog = q('[data-testid="gh-connect-dialog"]')!;
    expect(dialog.textContent).toContain('could not finish');
    expect(q('[data-testid="gh-connect-dialog-command"]')?.textContent).toContain('gh auth login --web');
    await act(async () => { q('[data-gh-connect-terminal]')!.click(); });
    await flush();
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="gh-connect-dialog"]')).toBeNull();
    expect(q('[data-testid="gh-connect-command"]')?.textContent).toContain('gh auth login --web');
  });

  it('timeout says so and Try again starts a new login', async () => {
    await mount();
    await connect();
    act(() => emit({ kind: 'timeout' }));
    expect(q('[data-testid="gh-connect-dialog"]')?.textContent).toContain('timed out');
    await act(async () => { q('[data-gh-connect-retry]')!.click(); });
    await flush();
    expect(loginStart).toHaveBeenCalledTimes(2);
  });

  it('gh missing at Connect switches to the install guidance', async () => {
    startResult = { ok: false, message: 'GitHub CLI (gh) is not installed', fallback: false };
    await mount();
    await connect();
    expect(q('[data-testid="gh-connect-dialog"]')).toBeNull();
    expect(q('[data-gh-connect-install]')).not.toBeNull();
  });

  it('cli-missing shows the install command for the OS, the site link and Check again', async () => {
    await mount('cli-missing');
    expect(q('[data-testid="gh-connect-install-cmd"]')?.textContent).toContain('brew install gh');
    await act(async () => { q('[data-gh-connect-site]')!.click(); });
    expect(openExternal).toHaveBeenCalledWith('https://cli.github.com');
    await act(async () => { q('[data-gh-connect-recheck]')!.click(); });
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it('cli-missing on Windows uses winget; on Linux links the install guide', async () => {
    install('win32');
    await mount('cli-missing');
    expect(q('[data-testid="gh-connect-install-cmd"]')?.textContent).toContain('winget install --id GitHub.cli');
    act(() => root.unmount());
    root = createRoot(container);
    install('linux');
    await mount('cli-missing');
    expect(q('[data-testid="gh-connect-install-cmd"]')).toBeNull();
    await act(async () => { q('[data-gh-connect-guide]')!.click(); });
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining('install_linux'));
  });
});
