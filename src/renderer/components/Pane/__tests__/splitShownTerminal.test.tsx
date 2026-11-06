// @vitest-environment jsdom
//
// The terminal column of a terminal/work split: the tab that last held the
// focus stays beside the work tab, and every reader of "which terminal does
// this pane show" names the same tab.

import { describe, it, expect } from 'vitest';
import type { PaneLeaf, Surface, Workspace } from '../../../../shared/types';
import { activateSurface, pickSplitShownSurfaces, splitShownTerminal } from '../surfaceKinds';
import { isSurfaceShown } from '../../../stores/selectors/surfaceShown';
import { selectFleetPanes } from '../../../stores/selectors/fleet';
import { paneForegroundProgram } from '../../../utils/surfaceProgram';
import { resolveHandoffTarget } from '../../Browser/BrowserPanel';
import { useStore } from '../../../stores';

const term = (id: string, ptyId: string): Surface => ({ id, ptyId, title: id, shell: 'zsh', cwd: '/w', surfaceType: 'terminal' });
const web: Surface = { id: 'web', ptyId: '', title: 'Browser', shell: '', cwd: '', surfaceType: 'browser' };

function leaf(over: Partial<PaneLeaf> = {}): PaneLeaf {
  return { id: 'p1', type: 'leaf', surfaces: [term('t1', 'pty-1'), term('t2', 'pty-2'), web], activeSurfaceId: 'web', ...over };
}

describe('splitShownTerminal', () => {
  it('the active tab when it is a terminal, whatever was recorded', () => {
    expect(splitShownTerminal(leaf({ activeSurfaceId: 't1', splitTerminalId: 't2' }))?.id).toBe('t1');
  });

  it('the recorded terminal while a work tab has the focus', () => {
    expect(splitShownTerminal(leaf({ splitTerminalId: 't2' }))?.id).toBe('t2');
  });

  it('the first terminal for a stale id, a closed tab, or an old session without the field', () => {
    expect(splitShownTerminal(leaf({ splitTerminalId: 'web' }))?.id).toBe('t1');
    expect(splitShownTerminal(leaf({ splitTerminalId: 'gone' }))?.id).toBe('t1');
    expect(splitShownTerminal(leaf({ surfaces: [term('t1', 'pty-1'), web], splitTerminalId: 't2' }))?.id).toBe('t1');
    expect(splitShownTerminal(leaf())?.id).toBe('t1');
  });
});

describe('activateSurface', () => {
  it('a terminal giving the focus to a work tab is recorded; work-to-work keeps it', () => {
    const l = leaf({ activeSurfaceId: 't2' });
    activateSurface(l, 'web');
    expect(l).toMatchObject({ activeSurfaceId: 'web', splitTerminalId: 't2' });
    l.surfaces.push({ ...web, id: 'web2' });
    activateSurface(l, 'web2');
    expect(l.splitTerminalId).toBe('t2');
  });
});

describe('the store records the terminal a file was opened from', () => {
  const stored = (): PaneLeaf => useStore.getState().workspaces[0].rootPane as PaneLeaf;

  it('opening a file from the second tab keeps that tab; closing it falls back to the first', () => {
    const l = leaf({ surfaces: [term('t1', ''), term('t2', '')], activeSurfaceId: 't1' });
    useStore.setState({ workspaces: [{ id: 'ws1', name: 'ws1', rootPane: l, activePaneId: 'p1' } as Workspace], activeWorkspaceId: 'ws1' });
    useStore.getState().setActiveSurface('p1', 't2', 'ws1');
    useStore.getState().addEditorSurface('p1', '/w/a.txt', { workspaceId: 'ws1' });
    expect(splitShownTerminal(stored())?.id).toBe('t2');
    useStore.getState().closeSurface('p1', 't2', 'ws1');
    expect(stored().splitTerminalId).toBeUndefined();
    expect(splitShownTerminal(stored())?.id).toBe('t1');
  });
});

describe('every reader names the same terminal in a two-terminal split', () => {
  // t2 had the focus when the browser opened; t1 is the first tab.
  const l = leaf({ splitTerminalId: 't2' });
  const ws = { id: 'ws1', name: 'ws1', rootPane: l, activePaneId: 'p1' } as Workspace;
  const surfaceAgent = { 'pty-1': { name: 'claude' }, 'pty-2': { name: 'codex' } };

  it('Pane', () => {
    const terminals = l.surfaces.filter((s) => s.surfaceType === 'terminal');
    expect(pickSplitShownSurfaces(terminals, [web], l.activeSurfaceId, undefined, l.splitTerminalId).shownTerminalId).toBe('t2');
  });

  it('the shown-surface selector', () => {
    const state = { workspaces: [ws], activeWorkspaceId: 'ws1', multiviewIds: [], appRoute: 'workspaces', botsWorkerPanel: null } as never;
    expect(isSurfaceShown(state, 'ws1', 't2')).toBe(true);
    expect(isSurfaceShown(state, 'ws1', 't1')).toBe(false);
  });

  it('Fleet', () => {
    const [row] = selectFleetPanes({ workspaces: [ws], surfaceAgentStatus: {}, surfaceActivity: {} });
    expect(row).toMatchObject({ surfaceId: 't2', ptyId: 'pty-2' });
  });

  it('the foreground program', () => {
    expect(paneForegroundProgram(l, surfaceAgent)).toBe('codex');
  });

  it('the browser hand-off', () => {
    const state = { workspaces: [ws], surfaceAgent } as never;
    expect(resolveHandoffTarget(state, 'ws1', 'web')).toEqual(['p1', 't2', 'pty-2', 'codex']);
  });
});
