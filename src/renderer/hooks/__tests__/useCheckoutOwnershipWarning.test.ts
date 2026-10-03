import { describe, it, expect } from 'vitest';
import { collectForeignCheckoutAgents } from '../useCheckoutOwnershipWarning';
import type { Pane } from '../../../shared/types';

const leaf = (id: string, surfaces: Array<{ ptyId: string; cwd: string }>): Pane => ({
  id,
  type: 'leaf',
  activeSurfaceId: `${id}-s0`,
  surfaces: surfaces.map((s, i) => ({ id: `${id}-s${i}`, ptyId: s.ptyId, cwd: s.cwd, title: '', shell: 'zsh' })),
});

const WT = '/home/u/.wmux/worktrees/abc/fix-login';
const tasks = [{
  id: 'wtask-1', title: 'Fix login', status: 'open' as const,
  worktreePath: WT, paneGroupId: 'ws-task', owner: { verifiedWorkspaceId: 'ws-orch' },
}];

describe('collectForeignCheckoutAgents', () => {
  it('reports only agent panes inside the worktree from a foreign workspace, stashed panes included', () => {
    const workspaces = [
      { id: 'ws-task', rootPane: leaf('p1', [{ ptyId: 'pty-task', cwd: WT }]) },
      {
        id: 'ws-other',
        rootPane: leaf('p2', [{ ptyId: 'pty-shell', cwd: WT }, { ptyId: 'pty-elsewhere', cwd: '/repo' }]),
        stashedPanes: [{ pane: leaf('p3', [{ ptyId: 'pty-stashed', cwd: `${WT}/src` }]) }],
      },
    ];
    const surfaceAgent = {
      'pty-task': { name: 'Claude Code' },
      'pty-elsewhere': { name: 'Codex' },
      'pty-stashed': { name: 'Codex' },
      // pty-shell has no agent: a plain shell in the worktree is not warned about.
    };
    const hits = collectForeignCheckoutAgents(workspaces, surfaceAgent, tasks, false);
    expect(hits.map((h) => [h.ptyId, h.workspaceId, h.task.id])).toEqual([['pty-stashed', 'ws-other', 'wtask-1']]);
  });

  it('skips an agent stamp the daemon reported dead or whose shell is back at its prompt', () => {
    const workspaces = [{ id: 'ws-other', rootPane: leaf('p1', [{ ptyId: 'a', cwd: WT }, { ptyId: 'b', cwd: WT }, { ptyId: 'c', cwd: WT }]) }];
    const surfaceAgent = { a: { name: 'Claude Code' }, b: { name: 'Claude Code' }, c: { name: 'Claude Code' } };
    const hits = collectForeignCheckoutAgents(workspaces, surfaceAgent, tasks, false, {
      agentAlive: { a: false },
      commandRunning: { b: false, c: true },
    });
    expect(hits.map((h) => h.ptyId)).toEqual(['c']);
  });
});
