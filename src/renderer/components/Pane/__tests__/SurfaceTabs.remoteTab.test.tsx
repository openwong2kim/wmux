// @vitest-environment jsdom
//
// A remote tab has to look remote (#1140 dogfood).
//
// The finding: a remote-terminal tab was indistinguishable from a local one.
// Both carry the same status dot and the same close button, and the TITLE is
// no help at all — it is an OSC title the shell on the OTHER machine sets, so
// a Windows host renders `C:\Program Files\…\pwsh` exactly as a local pane
// does. The tooltip was worse than useless: it showed a cwd that is a real
// path on a machine that is not this one.
//
// Mounted against the real store, in the house style of
// SurfaceTabs.actions.test.tsx — `surfaces` is a prop, so the tab body renders
// without any fixture beyond a workspace.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import SurfaceTabs, { surfaceTabTooltip } from '../SurfaceTabs';
import { useStore } from '../../../stores';
import { createWorkspace, type Surface, type Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const localSurface: Surface = {
  id: 'surface-local',
  ptyId: 'pty-1',
  title: 'pwsh',
  shell: 'pwsh',
  cwd: 'D:\\wmux',
};

const remoteSurface: Surface = {
  id: 'surface-remote',
  ptyId: '',
  // Deliberately the SAME shape a local Windows pane produces — this is the
  // whole problem the glyph exists to solve.
  title: 'pwsh',
  shell: 'pwsh',
  cwd: 'C:\\Users\\someone',
  surfaceType: 'remote-terminal',
  remoteHostId: 'host-1',
  remoteSessionId: 'sess-1',
};

function activeWs(): Workspace {
  return useStore
    .getState()
    .workspaces.find((w) => w.id === useStore.getState().activeWorkspaceId)!;
}

function mount(surfaces: Surface[]): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ws = activeWs();
  act(() => {
    root.render(
      React.createElement(SurfaceTabs, {
        surfaces,
        activeSurfaceId: surfaces[0]?.id ?? '',
        workspace: ws,
        paneId: ws.rootPane.id,
        paneActive: true,
        onSelect: () => undefined,
        onClose: () => undefined,
        onSplitHorizontal: () => undefined,
        onSplitVertical: () => undefined,
        onAddTerminal: () => undefined,
        onAddBrowser: () => undefined,
      }),
    );
  });
}

/** The tab element carrying this surface's title. */
function tabFor(title: string): HTMLElement {
  const tabs = Array.from(container.querySelectorAll<HTMLElement>('[title]'));
  const tab = tabs.find((el) => el.getAttribute('title')?.includes(title));
  if (!tab) throw new Error(`no tab whose tooltip mentions "${title}"`);
  return tab;
}

beforeEach(() => {
  const ws = createWorkspace('Test', 1);
  useStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the remote glyph, rendered', () => {
  it('marks the remote tab and only the remote tab', () => {
    mount([localSurface, remoteSurface]);
    const glyphs = container.querySelectorAll('[role="img"]');
    expect(glyphs).toHaveLength(1);
    // …and it is inside the REMOTE tab, not merely somewhere in the strip.
    expect(tabFor('C:\\Users\\someone').querySelector('[role="img"]')).not.toBeNull();
    expect(tabFor('D:\\wmux').querySelector('[role="img"]')).toBeNull();
  });

  it('names itself, since the tab text says nothing about being remote', () => {
    mount([remoteSurface]);
    const glyph = container.querySelector('[role="img"]');
    // Both tabs would otherwise read "pwsh" to a screen reader.
    expect(glyph?.getAttribute('aria-label')).toBeTruthy();
    expect(glyph?.querySelector('svg')).not.toBeNull();
  });

  it('does not paint itself with the accent this strip uses for focus', () => {
    // --accent-blue underlines the ACTIVE pane's tab strip in this very
    // component; a provenance marker wearing it would read as "you are here".
    mount([remoteSurface]);
    const glyph = container.querySelector('[role="img"]') as HTMLElement;
    expect(glyph.className).not.toContain('accent-blue');
  });

  it('a local-only strip renders no glyph at all', () => {
    mount([localSurface]);
    expect(container.querySelector('[role="img"]')).toBeNull();
  });
});

describe('surfaceTabTooltip', () => {
  const t = ((key: string, vars?: Record<string, string | number>) =>
    key === 'surface.remoteTooltip' ? `Remote terminal — ${vars?.path}` : 'Terminal') as
    Parameters<typeof surfaceTabTooltip>[1];

  it('a local tab leads with its working directory, unchanged', () => {
    expect(surfaceTabTooltip({ cwd: 'D:\\wmux', title: 'pwsh' }, t)).toBe('D:\\wmux');
  });

  it('a local tab with no cwd yet falls back to the title, then the noun', () => {
    expect(surfaceTabTooltip({ title: 'pwsh' }, t)).toBe('pwsh');
    expect(surfaceTabTooltip({}, t)).toBe('Terminal');
  });

  it('a remote tab says so around the path, which belongs to another machine', () => {
    expect(
      surfaceTabTooltip(
        { surfaceType: 'remote-terminal', cwd: 'C:\\Users\\someone', title: 'pwsh' },
        t,
      ),
    ).toBe('Remote terminal — C:\\Users\\someone');
  });

  it('a remote tab still identifies itself when it has neither cwd nor title', () => {
    expect(surfaceTabTooltip({ surfaceType: 'remote-terminal' }, t))
      .toBe('Remote terminal — Terminal');
  });
});
