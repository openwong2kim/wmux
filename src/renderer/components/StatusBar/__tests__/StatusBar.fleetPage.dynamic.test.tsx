// @vitest-environment jsdom
// The titlebar's fleet vitals step aside on the Fleet page, whose own summary
// line says the same; everywhere else they stay.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import StatusBar from '../StatusBar';
import { useStore } from '../../../stores';
import type { Pane, Workspace } from '../../../../shared/types';

function ws(id: string): Workspace {
  const rootPane: Pane = {
    id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`,
    surfaces: [{ id: `${id}-s`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }],
  };
  return { id, name: id, rootPane, activePaneId: `${id}-p` };
}

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

describe('titlebar fleet vitals', () => {
  it('hide on the Fleet page and show elsewhere', () => {
    act(() => useStore.setState({
      workspaces: [ws('a'), ws('b')], activeWorkspaceId: 'a', appRoute: 'workspaces', fleetViewVisible: false,
      surfaceAgent: { 'pty-a': { name: 'Claude Code', status: 'running' }, 'pty-b': { name: 'Codex', status: 'awaiting_input' } },
      surfaceAgentStatus: { 'pty-a': 'running', 'pty-b': 'awaiting_input' },
    }));
    act(() => root.render(<StatusBar />));
    expect(container.querySelector('[data-statusbar-running]')).not.toBeNull();
    expect(container.querySelector('[data-statusbar-needs]')).not.toBeNull();
    act(() => useStore.getState().setAppRoute('fleet'));
    expect(container.querySelector('[data-statusbar-running]')).toBeNull();
    expect(container.querySelector('[data-statusbar-needs]')).toBeNull();
    act(() => useStore.getState().setAppRoute('settings'));
    expect(container.querySelector('[data-statusbar-running]')).not.toBeNull();
  });
});
