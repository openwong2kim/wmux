// @vitest-environment jsdom
//
// A workspace with one active agent and two silent ones: the sidebar row must
// not swap between the running dot and the "no update for 30m+" ring at every
// turn end of the active pane. Seeded through the same store actions
// useNotificationListener calls, as in fleet.turnLatch.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '../../index';
import { selectWorkspaceAgentStatus, selectWorkspaceUnverifiableMinutes, UNVERIFIABLE_AFTER_MS } from '../fleet';
import type { Pane, Surface, Workspace } from '../../../../shared/types';

const NOW = 1_700_000_000_000;
const ACTIVE = 'pty-active';
const STALE = ['pty-stale-1', 'pty-stale-2'];

const surface = (id: string, ptyId: string): Surface => ({
  id, ptyId, title: id, shell: 'zsh', cwd: '/repo', surfaceType: 'terminal',
});
const leaf = (id: string, ptyId: string): Pane => ({
  id, type: 'leaf', surfaces: [surface(`s-${id}`, ptyId)], activeSurfaceId: `s-${id}`,
});
const workspace = (): Workspace => ({
  id: 'ws', name: 'ws',
  rootPane: {
    id: 'root', type: 'branch', direction: 'horizontal',
    children: [leaf('a', ACTIVE), leaf('b', STALE[0]), leaf('c', STALE[1])],
  },
  activePaneId: 'a',
} as Workspace);

function openTurn(ptyId: string): void {
  const s = useStore.getState();
  s.setSurfaceAgentStatus(ptyId, 'running');
  s.markSurfaceRunning(ptyId);
  s.markSurfaceTurnOpen(ptyId);
}

/** A Stop the user has seen: complete, then the focus clear. */
function endTurn(ptyId: string): void {
  const s = useStore.getState();
  s.setSurfaceAgentStatus(ptyId, 'complete');
  s.setSurfaceAgentStatus(ptyId, null);
}

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
  useStore.getState().bumpAgentClock();
}

const row = () => ({
  status: selectWorkspaceAgentStatus(useStore.getState(), 'ws'),
  ring: selectWorkspaceUnverifiableMinutes(useStore.getState(), 'ws'),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const agent = { name: 'Claude Code', status: 'running' as const };
  useStore.setState({
    workspaces: [workspace()],
    activeWorkspaceId: 'ws',
    surfaceAgentStatus: {},
    surfaceActivityAt: {},
    surfaceTurnOpenAt: {},
    surfaceTurnEndAt: {},
    surfaceAgent: { [ACTIVE]: agent, [STALE[0]]: agent, [STALE[1]]: agent },
    surfacePendingQuestion: {},
    commandRunningByPtyId: {},
    agentAliveByPtyId: {},
    agentClockMs: NOW,
  });
  // Two turns that opened and then went silent past the window.
  for (const p of STALE) openTurn(p);
  advance(UNVERIFIABLE_AFTER_MS + 60_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('workspace rollup: one active pane beside stale ones', () => {
  it('shows the ring while only the stale panes are running and nothing else was heard', () => {
    expect(row()).toEqual({ status: 'running', ring: 31 });
  });

  it('does not flip to the ring between the active pane\'s turns', () => {
    for (let turn = 0; turn < 3; turn++) {
      openTurn(ACTIVE);
      advance(90_000);
      expect(row()).toEqual({ status: 'running', ring: 0 });
      endTurn(ACTIVE);
      // Between turns: the stale panes are the only running ones, but the
      // active pane was just heard from.
      expect(row()).toEqual({ status: 'running', ring: 0 });
      advance(4 * 60_000);
      expect(row()).toEqual({ status: 'running', ring: 0 });
    }
  });

  it('shows the ring again once the active pane has been quiet past the window', () => {
    openTurn(ACTIVE);
    advance(60_000);
    endTurn(ACTIVE);
    advance(UNVERIFIABLE_AFTER_MS + 60_000);
    expect(row().ring).toBeGreaterThan(0);
  });
});
