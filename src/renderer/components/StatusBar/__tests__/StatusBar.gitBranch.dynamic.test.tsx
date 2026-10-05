// @vitest-environment jsdom
// The titlebar's branch text is the shortcut to the Git page.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import StatusBar from '../StatusBar';
import { useStore } from '../../../stores';
import type { Pane, Workspace } from '../../../../shared/types';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const stub = (): unknown => new Proxy(() => Promise.resolve([]), { get: (_t, key) => (key === 'then' ? undefined : stub()) });
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

describe('titlebar branch', () => {
  // The branch shows while the sidebar is hidden (DESIGN.md "Titlebar").
  it('opens the Git page', () => {
    const rootPane: Pane = { id: 'p', type: 'leaf', activeSurfaceId: 's', surfaces: [{ id: 's', ptyId: 'pty', title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }] };
    const ws: Workspace = { id: 'a', name: 'a', rootPane, activePaneId: 'p', metadata: { gitBranch: 'feat/x' } } as Workspace;
    act(() => useStore.setState({ workspaces: [ws], activeWorkspaceId: 'a', appRoute: 'workspaces', sidebarVisible: false }));
    act(() => root.render(<StatusBar />));
    const branch = container.querySelector<HTMLButtonElement>('[data-titlebar-branch]')!;
    expect(branch.textContent).toContain('feat/x');
    act(() => branch.click());
    expect(useStore.getState().appRoute).toBe('git');
  });
});
