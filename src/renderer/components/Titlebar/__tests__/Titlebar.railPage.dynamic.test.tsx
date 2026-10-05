// @vitest-environment jsdom
// The titlebar's workspace chrome (name, branch, New workspace) has one home at
// a time: the open sidebar shows them (its header + and the highlighted row),
// so the titlebar carries them only while the sidebar is hidden. A rail page
// names itself instead. The command palette has no titlebar entry.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Titlebar, { BRAND_INSET, MAC_TRAFFIC_LIGHT_RESERVE } from '../Titlebar';
import { useStore } from '../../../stores';
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

const rootPane: Pane = { id: 'p', type: 'leaf', activeSurfaceId: 's', surfaces: [{ id: 's', ptyId: 'pty', title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }] };
const ws: Workspace = { id: 'a', name: 'Workspace 1', rootPane, activePaneId: 'p', metadata: { gitBranch: 'feat/x' } } as Workspace;
const title = () => container.querySelector('[data-titlebar-title]')?.textContent ?? null;
const plus = () => !!container.querySelector('[data-onboarding-target="add-workspace"]');
const branch = () => !!container.querySelector('[data-titlebar-branch]');
const search = () => !!container.querySelector('[data-command-pill]');
const dragGap = () => container.querySelector<HTMLElement>('[data-titlebar-drag-gap]');
const toggle = () => container.querySelector<HTMLButtonElement>('[data-sidebar-toggle]')!;
const mount = (state: Partial<ReturnType<typeof useStore.getState>>) => {
  act(() => useStore.setState({ workspaces: [ws], activeWorkspaceId: 'a', appRoute: 'workspaces', sidebarPosition: 'left', sidebarVisible: true, ...state }));
  act(() => root.render(<Titlebar />));
};

describe('titlebar workspace chrome', () => {
  it('sidebar shown: no name, branch, + or search pill; the toggle and the drag gap stay', () => {
    mount({});
    // The palette has no titlebar entry (⌘K and the More menu open it); the
    // freed space is one drag gap with nothing that opts out of dragging.
    expect(dragGap()).not.toBeNull();
    expect(dragGap()!.style.getPropertyValue('-webkit-app-region')).toBe('');
    expect([title(), plus(), branch(), search()]).toEqual([null, false, false, false]);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    // Settings keeps the Workspaces titlebar, so it follows the same rule.
    act(() => useStore.setState({ appRoute: 'settings' }));
    expect([title(), plus(), branch()]).toEqual([null, false, false]);
  });

  it('sidebar collapsed: the name and branch return; never a + (the rail has it)', () => {
    mount({ sidebarVisible: false });
    expect([title(), plus(), branch(), search()]).toEqual(['Workspace 1', false, true, false]);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    // Docked right too: owner decision, no + in the titlebar ever.
    act(() => useStore.setState({ sidebarPosition: 'right' }));
    expect([title(), plus(), branch()]).toEqual(['Workspace 1', false, true]);
  });

  it('rail pages name the page with no + or branch, whatever the sidebar does', () => {
    for (const sidebarVisible of [true, false]) {
      mount({ sidebarVisible, sidebarPosition: 'right' });
      for (const [route, name] of [['git', 'Git'], ['fleet', 'Fleet'], ['schedules', 'Schedules'], ['remote', 'Remote']] as const) {
        act(() => useStore.setState({ appRoute: route }));
        expect([title(), plus(), branch(), search()]).toEqual([name, false, false, false]);
      }
    }
  });

  it('the sidebar toggle shows and hides the sidebar and keeps one name, state in aria-pressed', () => {
    mount({});
    expect(toggle().getAttribute('aria-label')).toBe('Show sidebar');
    expect(toggle().getAttribute('title')).toBe('Hide sidebar (Ctrl+Shift+B)');
    act(() => toggle().click());
    expect(useStore.getState().sidebarVisible).toBe(false);
    expect(toggle().getAttribute('aria-label')).toBe('Show sidebar');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().getAttribute('title')).toBe('Show sidebar (Ctrl+Shift+B)');
    act(() => toggle().click());
    expect(useStore.getState().sidebarVisible).toBe(true);
  });

  it('orders wmux, then the toggle, and keeps the brand at one x, open or collapsed', () => {
    mount({});
    const segment = () => container.querySelector<HTMLElement>('.wmux-titlebar-segment')!;
    const header = () => container.querySelector<HTMLElement>('[data-testid="titlebar"]')!;
    const order = () => [...segment().children].map((el) => (el.hasAttribute('data-sidebar-toggle') ? 'toggle' : el.textContent?.trim()));
    const brandX = () => (parseFloat(header().style.paddingLeft) || 0) + (parseFloat(segment().style.paddingLeft) || 0);
    const open = brandX();
    expect(order()).toEqual(['wmux', 'toggle']);
    act(() => useStore.setState({ sidebarVisible: false }));
    expect(order()).toEqual(['wmux', 'toggle']);
    expect(brandX()).toBe(open);
    expect(open).toBe(MAC_TRAFFIC_LIGHT_RESERVE + BRAND_INSET);
  });

});
