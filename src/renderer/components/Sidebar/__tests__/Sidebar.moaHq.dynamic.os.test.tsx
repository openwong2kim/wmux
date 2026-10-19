// @vitest-environment jsdom
// The workspace an earlier version made Moa's HQ is an ordinary workspace now:
// listed, counted and numbered like the rest, and closed like any other, even
// when an earlier run left its id in localStorage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Sidebar from '../Sidebar';
import MiniSidebar from '../MiniSidebar';
import { useKeyboard } from '../../../hooks/useKeyboard';
import { useStore } from '../../../stores';
import { setLocale } from '../../../i18n';
import type { Pane, Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function ws(id: string): Workspace {
  const rootPane: Pane = {
    id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`,
    surfaces: [{ id: `${id}-s`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }],
  };
  return { id, name: id, rootPane, activePaneId: `${id}-p` };
}
/** `a`, the legacy HQ (`moa`) and `b`, in that stored order. */
function seed(active = 'a') {
  act(() => useStore.setState({
    workspaces: ['a', 'moa', 'b'].map(ws),
    activeWorkspaceId: active,
    activeRemoteKey: null,
    appRoute: 'workspaces',
    readOnly: false,
    sidebarSortMode: 'manual',
    sidebarAttentionFirst: false,
    sidebarPinnedIds: [],
    sidebarNewAt: {},
    sidebarFilter: { status: [], kind: [], agent: [], other: [] },
    archivedWorkspaces: [],
    toasts: [],
    missionByPaneGroup: {},
    fanoutLineage: {},
    fanoutSpawnOwner: {},
    moa: null,
  } as never));
}
const rows = () => [...document.querySelectorAll('.sidebar-row')].map((r) => r.textContent?.match(/^[a-z]+/)?.[0]);

let container: HTMLDivElement;
let root: Root;
let dispose: ReturnType<typeof vi.fn>;
beforeEach(() => {
  setLocale('en');
  localStorage.setItem('wmux.moa.hqWorkspaceId', 'moa');
  dispose = vi.fn();
  const stub = (): unknown => new Proxy(() => Promise.resolve([]), { get: (_t, key) => (key === 'then' ? undefined : stub()) });
  const own: Record<string, unknown> = { platform: 'win32', pty: { dispose } };
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(own, {
    get: (t, key: string) => (key in t ? t[key] : stub()),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

describe("an earlier version's HQ workspace", () => {
  it('is listed, counted and numbered like any workspace', () => {
    seed();
    act(() => root.render(<Sidebar />));
    expect(rows()).toEqual(['a', 'moa', 'b']);
    expect(container.querySelector('[data-sidebar-total]')?.textContent).toBe('3');
    expect(document.querySelector('[data-moa-hq-row]')).toBeNull();
  });

  it('is on the collapsed rail', () => {
    seed();
    act(() => root.render(<MiniSidebar />));
    const titles = [...container.querySelectorAll('button[title]')].map((b) => b.getAttribute('title'))
      .filter((t) => /\(Ctrl\+\d\)$/.test(t ?? ''));
    expect(titles).toEqual(['a (Ctrl+1)', 'moa (Ctrl+2)', 'b (Ctrl+3)']);
  });

  it('closes with Ctrl+Shift+W like any other', () => {
    seed('moa');
    function Harness(): null { useKeyboard(); return null; }
    act(() => root.render(<Harness />));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, shiftKey: true, key: 'W', code: 'KeyW' }));
    });
    expect(dispose).toHaveBeenCalledWith('pty-moa');
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['a', 'b']);
  });
});
