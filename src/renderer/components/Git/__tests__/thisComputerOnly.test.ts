// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { selectRemoteScopeName, selectSelectedRemotePcName } from '../thisComputerOnly';
import { repoCwdCandidates, selectActivePaneCwdCandidates } from '../GitTab';
import { DEFAULT_PC_RAIL_PERSISTED, formatShadowWorkspaceId } from '../../../../shared/pcRail';
import type { StoreState } from '../../../stores';
import type { Pane } from '../../../../shared/types';

const leaf = (cwd: string): Pane => ({
  id: 'p1', type: 'leaf', activeSurfaceId: 's1',
  surfaces: [{ id: 's1', ptyId: 'pty', title: 't', shell: 'zsh', cwd }],
} as unknown as Pane);

const SHADOW = formatShadowWorkspaceId('host-1', 'ws-remote')!;

function state(over: { activePcId?: string; activeWorkspaceId?: string | null; hosts?: { id: string; label: string }[] } = {}): StoreState {
  return {
    pcRail: { ...DEFAULT_PC_RAIL_PERSISTED, activePcId: over.activePcId ?? 'local' },
    pcRailHosts: over.hosts ?? [{ id: 'host-1', label: 'office-mac' }],
    activeWorkspaceId: over.activeWorkspaceId === undefined ? 'ws-local' : over.activeWorkspaceId,
    startupDirectory: '/home/me',
    workspaces: [
      { id: 'ws-local', rootPane: leaf('/code/local'), activePaneId: 'p1' },
      { id: SHADOW, rootPane: leaf('/Users/remote/repo'), activePaneId: 'p1', metadata: { cwd: '/Users/remote/repo' } },
    ],
  } as unknown as StoreState;
}

describe('This computer only selectors', () => {
  it('name the selected remote computer from the roster, nothing for this one', () => {
    expect(selectSelectedRemotePcName(state())).toBeNull();
    expect(selectSelectedRemotePcName(state({ activePcId: 'host-1' }))).toBe('office-mac');
    // Selected before the roster names it: still remote, just unnamed.
    expect(selectSelectedRemotePcName(state({ activePcId: 'host-9' }))).toBe('');
  });

  it('treat a shadow workspace left active as remote even with this computer selected', () => {
    expect(selectRemoteScopeName(state())).toBeNull();
    expect(selectRemoteScopeName(state({ activeWorkspaceId: SHADOW }))).toBe('office-mac');
    expect(selectRemoteScopeName(state({ activeWorkspaceId: 'shadow:bogus' }))).toBe('');
    expect(selectRemoteScopeName(state({ activeWorkspaceId: null }))).toBeNull();
  });
});

describe('Git never reads another computer\'s folders from this disk', () => {
  it('gives a shadow workspace no cwd candidates, not even the local startup folder', () => {
    const s = state();
    expect(repoCwdCandidates(s.workspaces[1], '/home/me', true)).toEqual([]);
    expect(repoCwdCandidates(s.workspaces[0], '/home/me', true)).toEqual(['/code/local', '/home/me']);
  });

  it('follows nothing while another computer is on screen', () => {
    expect(selectActivePaneCwdCandidates(state())).toBe('/code/local\0/home/me');
    expect(selectActivePaneCwdCandidates(state({ activePcId: 'host-1' }))).toBe('');
    expect(selectActivePaneCwdCandidates(state({ activeWorkspaceId: SHADOW }))).toBe('');
  });
});
