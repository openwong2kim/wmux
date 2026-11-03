// @vitest-environment jsdom
//
// A tab whose agent has used computer use carries that agent's marker colour
// as a dot before its title: read once from main through the bridge, then
// following every pushed list. A tab main does not list has no dot.
import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs from '../SurfaceTabs';
import { useStore } from '../../../stores';
import { useAgentMarkersBridge } from '../../../hooks/useAgentMarkersBridge';
import type { AgentMarkerEntry } from '../../../../shared/computer/agentMarker';
import type { Surface, Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let push: ((entries: AgentMarkerEntry[]) => void) | null = null;
const off = vi.fn();

const a: Surface = { id: 'surf-a', ptyId: 'pty-cu-a', title: 'A', shell: 'bash', cwd: '/repo' };
const b: Surface = { id: 'surf-b', ptyId: 'pty-cu-b', title: 'B', shell: 'bash', cwd: '/repo' };

function activeWs(): Workspace {
  const ws = useStore.getState().workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId);
  if (!ws) throw new Error('no active workspace');
  return ws;
}

function Harness({ ws }: { ws: Workspace }) {
  useAgentMarkersBridge();
  return React.createElement(SurfaceTabs, {
    surfaces: [a, b],
    activeSurfaceId: 'surf-a',
    workspace: ws,
    paneId: ws.rootPane.id,
    paneActive: true,
    onSelect: () => undefined,
    onClose: () => undefined,
    onSplitHorizontal: () => undefined,
    onSplitVertical: () => undefined,
    onAddTerminal: () => undefined,
    onAddBrowser: () => undefined,
  });
}

async function mount(initial: AgentMarkerEntry[]): Promise<void> {
  vi.stubGlobal('electronAPI', {
    computerUse: {
      agentMarkers: vi.fn(async () => initial),
      onAgentMarkers: vi.fn((cb: (entries: AgentMarkerEntry[]) => void) => { push = cb; return off; }),
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws = activeWs();
  await act(async () => { root.render(React.createElement(Harness, { ws })); });
}

/** surfaceId → the colour of its tab's dot. */
function tabDots(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const tab of container.querySelectorAll<HTMLElement>('[data-surface-tab-id]')) {
    const dot = tab.querySelector<HTMLElement>('[data-computer-use-color]');
    out[tab.dataset.surfaceTabId as string] = dot ? dot.dataset.computerUseColor as string : null;
  }
  return out;
}

describe('SurfaceTabs — computer-use colour dot', () => {
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    push = null;
    vi.unstubAllGlobals();
    act(() => useStore.getState().setAgentMarkers([]));
  });

  it('draws the listed tab\'s colour, active or not, and nothing on the others', async () => {
    await mount([{ ptyId: 'pty-cu-a', color: '#5AA2FF' }]);
    expect(tabDots()).toEqual({ 'surf-a': '#5AA2FF', 'surf-b': null });
    const dot = container.querySelector<HTMLElement>('[data-computer-use-color]');
    expect(dot?.getAttribute('aria-label')).toBe('Computer use color: blue');
    expect(dot?.style.backgroundColor).toBe('rgb(90, 162, 255)');
  });

  it('follows each pushed list whole', async () => {
    await mount([]);
    expect(tabDots()).toEqual({ 'surf-a': null, 'surf-b': null });

    act(() => push?.([{ ptyId: 'pty-cu-b', color: '#A98BFF' }]));
    expect(tabDots()).toEqual({ 'surf-a': null, 'surf-b': '#A98BFF' });

    act(() => push?.([{ ptyId: 'pty-cu-a', color: '#FF8A3D' }, { ptyId: 'pty-cu-b', color: '#A98BFF' }]));
    expect(tabDots()).toEqual({ 'surf-a': '#FF8A3D', 'surf-b': '#A98BFF' });

    act(() => push?.([]));
    expect(tabDots()).toEqual({ 'surf-a': null, 'surf-b': null });
  });

  it('stops listening on unmount', async () => {
    off.mockClear();
    await mount([]);
    act(() => root.unmount());
    expect(off).toHaveBeenCalledTimes(1);
    root = createRoot(container); // afterEach unmounts again
  });
});
