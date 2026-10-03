// @vitest-environment jsdom
// The sidebar Git section's height and folded state (2026-10-03): clamped like
// the sidebar width, and restored from the session file.
import { describe, expect, it } from 'vitest';
import {
  SIDEBAR_GIT_DEFAULT_HEIGHT,
  SIDEBAR_GIT_MIN_HEIGHT,
  clampSidebarGitHeight,
} from '../sidebarLayout';
import { useStore } from '../../stores';
import type { SessionData, Workspace } from '../../../shared/types';

describe('clampSidebarGitHeight', () => {
  it('keeps a height above the floor and rounds it', () => {
    expect(clampSidebarGitHeight(300.4)).toBe(300);
    expect(clampSidebarGitHeight(40)).toBe(SIDEBAR_GIT_MIN_HEIGHT);
  });

  it('never takes more than 45% of the sidebar it is given', () => {
    expect(clampSidebarGitHeight(600, 800)).toBe(360);
    // A sidebar too short for the share still gets the floor, not less.
    expect(clampSidebarGitHeight(600, 200)).toBe(SIDEBAR_GIT_MIN_HEIGHT);
  });

  it('falls back to the default for anything that is not a finite number', () => {
    expect(clampSidebarGitHeight(undefined)).toBe(SIDEBAR_GIT_DEFAULT_HEIGHT);
    expect(clampSidebarGitHeight('300')).toBe(SIDEBAR_GIT_DEFAULT_HEIGHT);
    expect(clampSidebarGitHeight(Number.NaN)).toBe(SIDEBAR_GIT_DEFAULT_HEIGHT);
  });
});

describe('Git section state across a session load', () => {
  const ws = {
    id: 'ws-1',
    name: 'One',
    rootPane: { id: 'p', type: 'leaf', activeSurfaceId: 's', surfaces: [{ id: 's', ptyId: 'pty', title: 't', shell: 'zsh', cwd: '/x', surfaceType: 'terminal' }] },
    activePaneId: 'p',
  } as unknown as Workspace;
  const base: SessionData = { workspaces: [ws], activeWorkspaceId: 'ws-1', sidebarVisible: true };

  it('restores the folded state and a clamped height', () => {
    useStore.getState().loadSession({ ...base, sidebarGitCollapsed: true, sidebarGitHeight: 20 });
    expect(useStore.getState().sidebarGitCollapsed).toBe(true);
    expect(useStore.getState().sidebarGitHeight).toBe(SIDEBAR_GIT_MIN_HEIGHT);
  });

  it('keeps the defaults for an older session without the fields', () => {
    useStore.setState({ sidebarGitCollapsed: false, sidebarGitHeight: SIDEBAR_GIT_DEFAULT_HEIGHT });
    useStore.getState().loadSession({ ...base, sidebarGitCollapsed: 'yes' as unknown as boolean });
    expect(useStore.getState().sidebarGitCollapsed).toBe(false);
    expect(useStore.getState().sidebarGitHeight).toBe(SIDEBAR_GIT_DEFAULT_HEIGHT);
  });
});
