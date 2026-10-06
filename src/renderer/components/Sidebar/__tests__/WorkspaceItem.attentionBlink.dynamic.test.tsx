// @vitest-environment jsdom
//
// Owner decision 2026-10-07: a row waiting on a question or approval keeps the
// dashed needs-you border and pulses per the Attention blink setting; a turn
// that simply finished (even on a "?" in its closing message) draws no dash,
// only the done dot. Reduced motion and an on-screen workspace never pulse.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WorkspaceItem from '../WorkspaceItem';
import { useStore } from '../../../stores';
import type { Pane, Surface, Workspace } from '../../../../shared/types';

let container: HTMLDivElement;
let root: Root;
const savedMatchMedia = window.matchMedia;

const surface = (id: string, ptyId: string): Surface => ({
  id, ptyId, title: id, shell: 'zsh', cwd: '/repo', surfaceType: 'terminal',
});
const leaf = (id: string, surfaces: Surface[]): Pane => ({
  id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0].id,
});
const workspace = (id: string): Workspace => ({
  id, name: id, rootPane: leaf(`${id}-p`, [surface(`${id}-s`, `pty-${id}`)]), activePaneId: `${id}-p`,
});
const noop = () => undefined;

function setOsReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

async function render(isActive = false): Promise<void> {
  await act(async () => {
    root.render(createElement(WorkspaceItem, {
      workspaceId: 'ws', isActive, isMultiview: false, index: 0,
      onSelect: noop, onCtrlSelect: noop, onRename: noop, onClose: noop, onArchive: noop,
      onCopyInfo: noop, onDuplicate: noop, onReorder: noop,
    }));
  });
}

/** 'ws' is off screen ('other' is active) unless a test says otherwise. */
function seed(extra: Record<string, unknown>): void {
  useStore.setState({
    workspaces: [workspace('ws'), workspace('other')],
    activeWorkspaceId: 'other',
    multiviewIds: [],
    surfaceAgentStatus: {},
    surfacePendingQuestion: {},
    sidebarSeen: {},
    surfaceAgent: { 'pty-ws': { name: 'Claude Code', status: 'idle' } },
    attentionBlink: 'remind',
    attentionBlinkRemindMs: 60_000,
    attentionBlinkFinished: 'dot',
    ...extra,
  } as never);
}

/** A real dialog: the pane's lifecycle status says it is blocked on the user. */
const dialog = { surfaceAgent: { 'pty-ws': { name: 'Claude Code', status: 'awaiting_input' } } };

function card(): HTMLElement {
  const el = container.querySelector('.sidebar-row');
  if (!el) throw new Error('no row rendered');
  return el as HTMLElement;
}

beforeEach(() => {
  setOsReducedMotion(false);
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.matchMedia = savedMatchMedia;
});

describe('state split: needs you vs finished', () => {
  it('a turn that ended on a question gets the done dot, a dialog keeps the dash', async () => {
    const question = 'Want me to open a PR?';
    seed({
      surfaceAgent: { 'pty-ws': { name: 'Claude Code', status: 'waiting' } },
      surfaceAgentStatus: { 'pty-ws': 'waiting' },
      surfacePendingQuestion: { 'pty-ws': question },
      // Changed since it was last in view.
      sidebarSeen: { 'pty-ws': { entry: { status: 'waiting', question }, rev: 1, seenRev: 0 } },
    });
    await render();
    expect(card().className).not.toContain('sidebar-row-needs');
    expect(card().className).not.toContain('sidebar-row-pulse');
    expect(container.querySelector('[data-sidebar-done]')).not.toBeNull();

    // A question or approval dialog keeps the dash and has no done dot.
    seed(dialog);
    await render();
    expect(card().className).toContain('sidebar-row-needs');
    expect(container.querySelector('[data-sidebar-done]')).toBeNull();
  });
});

describe('Attention blink setting → classes', () => {
  it('Once + remind (default) pulses on the chosen interval', async () => {
    seed(dialog);
    await render();
    expect(card().className).toContain('sidebar-row-pulse-remind-60s');
    seed({ ...dialog, attentionBlinkRemindMs: 30_000 });
    await render();
    expect(card().className).toContain('sidebar-row-pulse-remind-30s');
  });

  it('Off keeps the dash only', async () => {
    seed(dialog);
    await render();
    expect(card().className).toContain('sidebar-row-pulse');
    seed({ ...dialog, attentionBlink: 'off' });
    await render();
    expect(card().className).toContain('sidebar-row-needs');
    expect(card().className).not.toContain('sidebar-row-pulse');
  });

  it('Once and Continuous pick their own class', async () => {
    seed({ ...dialog, attentionBlink: 'once' });
    await render();
    expect(card().className).toContain('sidebar-row-pulse-once');
    seed({ ...dialog, attentionBlink: 'continuous' });
    await render();
    expect(card().className).toContain('sidebar-row-pulse-continuous');
  });

  it('reduced motion forces every pulse off', async () => {
    seed({ ...dialog, attentionBlink: 'continuous' });
    await render();
    expect(card().className).toContain('sidebar-row-pulse-continuous');
    act(() => root.unmount());
    act(() => { root = createRoot(container); });
    setOsReducedMotion(true);
    await render();
    expect(card().className).toContain('sidebar-row-needs');
    expect(card().className).not.toContain('sidebar-row-pulse');
  });

  it('an active workspace never pulses', async () => {
    seed({ ...dialog, attentionBlink: 'continuous' });
    await render();
    expect(card().className).toContain('sidebar-row-pulse-continuous');
    seed({ ...dialog, attentionBlink: 'continuous', activeWorkspaceId: 'ws' });
    await render(true);
    expect(card().className).toContain('sidebar-row-needs');
    expect(card().className).not.toContain('sidebar-row-pulse');
  });
});
