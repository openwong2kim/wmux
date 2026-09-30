// @vitest-environment jsdom
//
// Mount smoke for the browser build (wmux web `/app`): the desktop's Sidebar,
// MiniSidebar and pane tree, fed by the web hydration from a ptyId-less
// fixture, behind the deny-by-default electronAPI shim. The contract under
// test is the security one: mounting and polling issue GETs only, nothing
// reaches pty.*, and every electronAPI member the mounted tree touches is one
// the shim implements on purpose (the set below — widening it is a decision).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createElectronApiShim } from '../electronApiShim';
import { webElectronApiImpl } from '../webElectronApi';

const workspacesReply = {
  activeWorkspaceId: 'ws-a',
  workspaces: [
    {
      id: 'ws-a', name: 'alpha', order: 0, pinned: false, color: 'teal', gitBranch: 'main',
      panes: [],
      layout: {
        activePaneId: 'p2',
        unplaced: [],
        root: {
          kind: 'split', direction: 'horizontal', sizes: [50, 50], children: [
            { kind: 'leaf', paneId: 'p1', activeIndex: 1, surfaces: [
              { surfaceId: 's1', kind: 'terminal' },
              { surfaceId: 's2', kind: 'browser', title: 'Docs' },
            ] },
            { kind: 'split', direction: 'vertical', sizes: [60, 40], children: [
              { kind: 'leaf', paneId: 'p2', activeIndex: 0, surfaces: [{ surfaceId: 's3', kind: 'terminal' }] },
              { kind: 'leaf', paneId: 'p3', activeIndex: 0, surfaces: [{ surfaceId: 's4', kind: 'git', title: 'Git' }] },
            ] },
          ],
        },
      },
    },
    { id: 'ws-b', name: 'beta', order: 1, pinned: true, panes: [] },
  ],
};

const calls: { method: string; url: string }[] = [];
const denied: string[] = [];
let root: Root;
let container: HTMLDivElement;
let stop: () => void = () => undefined;

beforeAll(async () => {
  Object.defineProperty(window, 'electronAPI', {
    value: createElectronApiShim(webElectronApiImpl(navigator), (p) => denied.push(p)),
    configurable: true,
  });
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() { /* inert */ } unobserve() { /* inert */ } disconnect() { /* inert */ } } as unknown as typeof ResizeObserver;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url });
    const body = url === '/api/workspaces' ? workspacesReply : url === '/api/sessions' ? { sessions: [] } : {};
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchImpl);

  const { useStore } = await import('../../stores');
  const { WebApp } = await import('../WebApp');
  const { startWebSync } = await import('../webSync');
  useStore.setState({ readOnly: true, sidebarVisible: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    stop = startWebSync({ token: 't', fetchImpl: fetchImpl as unknown as typeof fetch, intervalMs: 60_000, onUnauthorized: () => undefined });
    root.render(<WebApp />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
});

afterAll(() => {
  stop();
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('web app mount (ptyId-less fixture)', () => {
  it('renders the desktop sidebar and pane tree from the hydrated store', () => {
    expect(container.textContent).toContain('alpha');
    expect(container.textContent).toContain('beta');
    expect(container.querySelectorAll('[data-surface-placeholder]').length).toBe(4);
  });

  it('issues GETs only — no network write', () => {
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(new Set(calls.map((c) => c.url))).toEqual(new Set(['/api/workspaces', '/api/sessions']));
  });

  it('never reaches pty.* and touches no unimplemented electronAPI member', () => {
    expect(denied.filter((p) => p.startsWith('pty.'))).toEqual([]);
    expect([...new Set(denied)].sort()).toEqual([]);
  });

  it('hides structure-changing chrome in read-only mode', () => {
    // The full sidebar and a split are on screen, so the absences below are real.
    expect(container.querySelector('.wmux-sidebar')).not.toBeNull();
    expect(container.querySelectorAll('[data-group] [role="separator"]').length).toBeGreaterThan(0);
    expect(container.querySelector('button[aria-label="New workspace"]')).toBeNull();
    expect(container.querySelector('[data-sidebar-nav], [data-onboarding-target="settings-button"]')).toBeNull();
    expect(container.querySelector('[data-group] [role="separator"]:not([aria-disabled="true"])')).toBeNull();
    expect(container.querySelector('[data-surface-tab-close], [data-workspace-actions], [data-pane-actions]')).toBeNull();
  });

  it('tab and pane clicks stay local: no write, no denied call', async () => {
    const before = calls.length;
    const tabs = [...container.querySelectorAll<HTMLElement>('.wmux-pane-header [title]')];
    expect(tabs.length).toBeGreaterThan(1);
    await act(async () => {
      for (const tab of tabs) tab.click();
      container.querySelectorAll<HTMLElement>('[data-wmux-pane-root]').forEach((p) => p.click());
    });
    expect(calls.slice(before).every((c) => c.method === 'GET')).toBe(true);
    expect(denied).toEqual([]);
  });
});
