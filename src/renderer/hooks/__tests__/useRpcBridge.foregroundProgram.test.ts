// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { handleRpcMethod } from '../useRpcBridge';

function terminal(id: string): Surface {
  return { id, ptyId: `pty-${id}`, title: id, shell: 'Zsh', cwd: '/tmp' };
}

function seed(surfaces: Surface[], activeSurfaceId = surfaces[0].id): Workspace {
  const pane: PaneLeaf = { id: 'pane-program', type: 'leaf', surfaces, activeSurfaceId };
  const workspace: Workspace = { id: 'ws-program', name: 'Programs', rootPane: pane, activePaneId: pane.id };
  useStore.setState({ workspaces: [workspace], activeWorkspaceId: workspace.id });
  return workspace;
}

type SurfaceRow = { id: string; foregroundProgram: string | null; agentName: string | null; shell: string };
type PaneRow = { id: string; foregroundProgram: string | null; stashedLiveness?: string; agents: Array<{ agentName: string | null }> };

beforeEach(() => {
  useStore.setState({
    paneGate: 'ready', surfaceAgent: {}, surfacePendingQuestion: {},
    agentAliveByPtyId: {}, commandRunningByPtyId: {},
  });
});

describe('foreground program list metadata', () => {
  it('leaves undetected programs unknown and suppresses names only on explicit exit evidence', async () => {
    const surfaces = ['vim', 'ssh', 'repl', 'live', 'dead', 'shell', 'ended'].map(terminal);
    surfaces[6].ptyId = '';
    const workspace = seed(surfaces);
    const stashedPane: PaneLeaf = {
      id: 'stashed-ended', type: 'leaf', surfaces: [{ ...terminal('stashed'), ptyId: '' }], activeSurfaceId: 'stashed',
    };
    useStore.setState({
      workspaces: [{ ...workspace, stashedPanes: [{ pane: stashedPane, stashedAt: 1 }] }],
      surfaceAgent: Object.fromEntries(['pty-live', 'pty-dead', 'pty-shell', ''].map((ptyId) => [ptyId, { name: 'Codex CLI', status: 'running' as const }])),
      agentAliveByPtyId: { 'pty-dead': false },
      commandRunningByPtyId: { 'pty-vim': true, 'pty-ssh': true, 'pty-repl': true, 'pty-shell': false },
    });
    const rows = await handleRpcMethod('surface.list', { includeStashed: true }) as SurfaceRow[];
    expect(rows.map((row) => [row.id, row.foregroundProgram, row.agentName])).toEqual([
      ['vim', null, null], ['ssh', null, null], ['repl', null, null],
      ['live', 'Codex CLI', 'Codex CLI'], ['dead', null, null], ['shell', null, null],
      ['ended', null, null], ['stashed', null, null],
    ]);
    expect(rows.every((row) => row.shell === 'Zsh')).toBe(true);
    const panes = await handleRpcMethod('pane.list', { includeStashed: true }) as PaneRow[];
    expect(panes[0].foregroundProgram).toBeNull();
    expect(panes[0].agents.map((agent) => agent.agentName)).toEqual(['Codex CLI', null, null, null]);
    expect(panes[1]).toMatchObject({ foregroundProgram: null, stashedLiveness: 'exited' });
    expect(panes[1].agents[0].agentName).toBeNull();
  });

  it('uses the first local terminal behind browser or diff tabs and honors an active terminal', async () => {
    const agent = terminal('agent');
    const shell = { ...terminal('shell'), surfaceType: 'terminal' as const };
    const browser = { ...terminal('browser'), ptyId: '', surfaceType: 'browser' as const };
    const diff = { ...terminal('diff'), ptyId: '', surfaceType: 'diff' as const };
    useStore.setState({ surfaceAgent: { [agent.ptyId]: { name: 'Codex CLI', status: 'running' } } });
    for (const activeSurfaceId of [browser.id, diff.id, agent.id, shell.id]) {
      seed([diff, browser, agent, shell], activeSurfaceId);
      const rows = await handleRpcMethod('pane.list', {}) as PaneRow[];
      expect(rows[0].foregroundProgram).toBe(activeSurfaceId === shell.id ? null : 'Codex CLI');
      expect(rows[0].agents[0].agentName).toBe('Codex CLI');
    }
  });
});
