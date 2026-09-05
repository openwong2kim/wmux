// @vitest-environment jsdom
//
// The unverifiable rendition on the sidebar row: a workspace whose agent still
// claims to be running but has reported nothing for the hook-authority window
// draws a HOLLOW amber ring and says how long the silence has lasted. A pane
// that reported a moment ago keeps the ordinary filled dot, and the row's
// agentStatus (hence its order and its needs-you wash) is untouched either way.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WorkspaceItem from '../WorkspaceItem';
import { useStore } from '../../../stores';
import type { Pane, Surface, Workspace } from '../../../../shared/types';

let container: HTMLDivElement;
let root: Root;

const NOW = 1_700_000_000_000;

const surface = (id: string, ptyId: string): Surface => ({
  id, ptyId, title: id, shell: 'pwsh', cwd: '/repo', surfaceType: 'terminal',
});
const leaf = (id: string, surfaces: Surface[]): Pane => ({
  id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0].id,
});
const workspace = (id: string): Workspace => ({
  id,
  name: id,
  rootPane: leaf(`${id}-p`, [surface(`${id}-s`, `pty-${id}`)]),
  activePaneId: `${id}-p`,
});

const noop = () => undefined;

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(WorkspaceItem, {
      workspaceId: 'ws', isActive: false, isMultiview: false, index: 0,
      onSelect: noop, onCtrlSelect: noop, onRename: noop, onClose: noop,
      onCopyInfo: noop, onDuplicate: noop, onReorder: noop,
    }));
  });
}

/** A workspace with one pane the store believes is running. */
function seed(activityAt: number): void {
  useStore.setState({
    workspaces: [workspace('ws')],
    activeWorkspaceId: 'ws',
    surfaceAgentStatus: { 'pty-ws': 'running' },
    surfaceAgent: { 'pty-ws': { name: 'Claude Code', status: 'running' } },
    surfaceActivityAt: { 'pty-ws': activityAt },
    agentClockMs: NOW,
  });
}

function dot(): HTMLElement {
  const el = container.querySelector('.sidebar-dot');
  if (!el) throw new Error('no status dot rendered');
  return el as HTMLElement;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('WorkspaceItem unverifiable ring', () => {
  it('keeps the filled running dot while the agent is still reporting', async () => {
    seed(NOW - 30_000);
    await render();
    expect(dot().className).not.toContain('sidebar-dot-unverifiable');
    expect(dot().className).toContain('sidebar-dot-running');
    expect(dot().style.backgroundColor).not.toBe('');
    expect(dot().getAttribute('title')).toBeNull();
  });

  it('goes hollow and names the silence after 34 minutes with no signal', async () => {
    seed(NOW - 34 * 60_000);
    await render();
    expect(dot().className).toContain('sidebar-dot-unverifiable');
    // No glow: the ring is the absence of a claim, not a quieter version of one.
    expect(dot().className).not.toContain('sidebar-dot-running');
    expect(dot().style.backgroundColor).toBe('');
    expect(dot().getAttribute('title')).toBe('No update for 34m');
  });

  it('never rings a workspace that needs the user — that dot is red', async () => {
    seed(NOW - 34 * 60_000);
    useStore.setState({ surfaceAgentStatus: { 'pty-ws': 'awaiting_input' } });
    await render();
    expect(dot().className).not.toContain('sidebar-dot-unverifiable');
    expect(dot().getAttribute('title')).toBeNull();
  });
});
