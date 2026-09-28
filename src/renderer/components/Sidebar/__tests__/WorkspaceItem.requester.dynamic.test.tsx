// @vitest-environment jsdom
//
// 2026-09-27 — the sidebar shows who asked for a fan-out task by nesting it
// under the requesting pane, so the task row carries no "by …" line of its
// own any more; the fan-out glyph's tooltip still names the requester.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WorkspaceItem from '../WorkspaceItem';
import { useStore } from '../../../stores';
import type { Pane, Surface, Workspace } from '../../../../shared/types';
import type { FanoutOrigin } from '../../../../shared/fanoutOrigin';

let container: HTMLDivElement;
let root: Root;

const surface = (id: string, ptyId: string): Surface => ({
  id, ptyId, title: '', shell: 'zsh', cwd: '/repo', surfaceType: 'terminal',
});
const leaf = (id: string, ordinal: number, s: Surface): Pane =>
  ({ id, type: 'leaf', ordinal, surfaces: [s], activeSurfaceId: s.id }) as Pane;

// The owner workspace w115 has two agent panes, 62 and 74.
const owner: Workspace = {
  id: 'ws-owner',
  name: 'app',
  wsOrdinal: 115,
  activePaneId: 'p62',
  rootPane: {
    id: 'split', type: 'branch', direction: 'horizontal', sizes: [50, 50],
    children: [leaf('p62', 62, surface('s62', 'pty-62')), leaf('p74', 74, surface('s74', 'pty-74'))],
  } as unknown as Pane,
} as Workspace;
const task: Workspace = {
  id: 'ws-task', name: 'wtask: compare', wsOrdinal: 200, activePaneId: 'tp',
  rootPane: leaf('tp', 1, surface('ts', 'pty-task')),
} as Workspace;

const noop = () => undefined;
let onSelect = vi.fn();

async function render(origin?: FanoutOrigin, opts: { isActive?: boolean } = {}): Promise<void> {
  useStore.setState({
    workspaces: [owner, task],
    activeWorkspaceId: 'ws-owner',
    paneLabel: { p74: 'Compare' },
    surfaceAgent: { 'pty-task': { name: 'Codex CLI', status: 'idle' } },
    fanoutLineage: { 'ws-task': 'ws-owner' },
    fanoutOrigin: origin ? { 'ws-task': origin } : {},
    fanoutProvenance: {},
  });
  await act(async () => {
    root.render(createElement(WorkspaceItem, {
      workspaceId: 'ws-task', isActive: opts.isActive ?? false, isMultiview: false, index: 1,
      onSelect, onCtrlSelect: noop, onRename: noop, onClose: noop, onArchive: noop,
      onCopyInfo: noop, onDuplicate: noop, onReorder: noop, taskRow: true,
    }));
  });
}


beforeEach(() => {
  onSelect = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('task row requester', () => {
  it('draws no requester line at rest, for any kind of requester', async () => {
    const origins: (FanoutOrigin | undefined)[] = [
      { kind: 'pane', paneId: 'p74', surfaceId: 's74', label: 'w115-74 · Compare' },
      { kind: 'pane', paneId: 'p-gone', surfaceId: 's-gone', label: 'w115-9 · Planner' },
      { kind: 'gui' },
      { kind: 'orchestrator' },
      undefined,
    ];
    for (const origin of origins) {
      await render(origin);
      expect(container.querySelector('[data-task-requester]')).toBeNull();
      const text = container.textContent ?? '';
      expect(text).not.toMatch(/\bby w115|Started by you|by Orchestrator|Requester unknown/);
    }
  });

  it('the glyph tooltip still names the requester, live', async () => {
    await render({ kind: 'pane', paneId: 'p74', surfaceId: 's74', label: 'w115-74 · Compare' });
    const tip = container.querySelector('[data-task-provenance]')?.getAttribute('title') ?? '';
    expect(tip).toContain('w115-74 · Compare');
    act(() => { useStore.setState({ paneLabel: { p74: 'Renamed' } }); });
    expect(container.querySelector('[data-task-provenance]')?.getAttribute('title')).toContain('w115-74 · Renamed');
  });
});
