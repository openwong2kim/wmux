// @vitest-environment jsdom
// On a rail page the titlebar names the page: the workspace's name, its branch
// and New workspace belong to the Workspaces page and come back with it. Search
// & commands is global and stays.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Titlebar from '../Titlebar';
import { useStore } from '../../../stores';
import { t } from '../../../i18n';
import type { Pane, Workspace } from '../../../../shared/types';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  // Every API call resolves to [] and doubles as an unsubscribe function.
  const call = () => {
    const p = Promise.resolve([]);
    return Object.assign(() => undefined, { then: p.then.bind(p), catch: p.catch.bind(p), finally: p.finally.bind(p) });
  };
  const stub = (): unknown => new Proxy(call, { get: (_t, key) => (key === 'then' ? undefined : stub()) });
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({ platform: 'darwin' } as Record<string, unknown>, {
    get: (t, key: string) => (key in t ? t[key] : stub()),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('titlebar on rail pages', () => {
  it('names the page and hides the workspace chrome, then restores it on Workspaces', () => {
    const rootPane: Pane = { id: 'p', type: 'leaf', activeSurfaceId: 's', surfaces: [{ id: 's', ptyId: 'pty', title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }] };
    const ws: Workspace = { id: 'a', name: 'Workspace 1', rootPane, activePaneId: 'p', metadata: { gitBranch: 'feat/x' } } as Workspace;
    act(() => useStore.setState({ workspaces: [ws], activeWorkspaceId: 'a', appRoute: 'workspaces', sidebarPosition: 'left', sidebarVisible: true }));
    act(() => root.render(<Titlebar />));
    const title = () => container.querySelector('[data-titlebar-title]')?.textContent;
    const plus = () => container.querySelector('[data-onboarding-target="add-workspace"]');
    const branch = () => container.querySelector('[data-titlebar-branch]');
    const search = () => container.querySelector('[data-command-pill]');

    expect([title(), !!plus(), !!branch(), !!search()]).toEqual(['Workspace 1', true, true, true]);

    for (const [route, name] of [['git', 'Git'], ['fleet', 'Fleet'], ['schedules', 'Schedules'], ['remote', 'Remote']] as const) {
      act(() => useStore.setState({ appRoute: route }));
      expect([title(), !!plus(), !!branch(), !!search()]).toEqual([name, false, false, true]);
    }

    act(() => useStore.setState({ appRoute: 'workspaces' }));
    expect([title(), !!plus(), !!branch(), !!search()]).toEqual(['Workspace 1', true, true, true]);
    // Settings is not a rail page here: it keeps the workspace's titlebar.
    act(() => useStore.setState({ appRoute: 'settings' }));
    expect([title(), !!plus()]).toEqual(['Workspace 1', true]);
  });

  it('closes an open New workspace picker when a rail page opens', () => {
    act(() => useStore.setState({ workspaces: [], activeWorkspaceId: undefined, appRoute: 'workspaces', sidebarPosition: 'left', sidebarVisible: true }));
    act(() => root.render(<Titlebar />));
    act(() => container.querySelector<HTMLButtonElement>('[data-onboarding-target="add-workspace"]')!.click());
    const pickerShown = () => container.textContent?.includes(t('sidebar.emptyWorkspace'));
    expect(pickerShown()).toBe(true);
    act(() => useStore.setState({ appRoute: 'git' }));
    act(() => useStore.setState({ appRoute: 'workspaces' }));
    expect(pickerShown()).toBe(false);
  });
});
