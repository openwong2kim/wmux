// Shared store fixture for the fleet.triage payload test and the FleetView
// parity test: one agent asking for input on its active tab, one asking on a
// BACKGROUND tab, one running, one remote agent in error, and two idle panes.
import { useStore } from '../../stores';
import type { Workspace, Pane, Surface } from '../../../shared/types';
import type { WorkTask } from '../../../shared/workTask';
import { remoteAgentKey } from '../../../shared/remoteHosts';

export const REMOTE_KEY = remoteAgentKey('host-1', 'rsession-9');

/** paneId → the pty the Fleet card is keyed on (its ACTIVE surface). */
export const ACTIVE_PTY_BY_PANE: Record<string, string> = {
  p1: 'pty-1', p2: 'pty-2a', p3: 'pty-3', pr: REMOTE_KEY, p4: 'pty-4', p5: 'pty-5',
};

function surface(id: string, ptyId: string, extra: Partial<Surface> = {}): Surface {
  return { id, ptyId, title: id, shell: 'zsh', cwd: `/repo/${id}`, surfaceType: 'terminal', ...extra };
}
function leaf(id: string, surfaces: Surface[]): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
}
function branch(id: string, children: Pane[]): Pane {
  return { id, type: 'branch', direction: 'horizontal', children };
}
function workspace(id: string, name: string, rootPane: Pane, activePaneId: string): Workspace {
  return { id, name, rootPane, activePaneId };
}

export function seedFleetTriageStore(now: number, extra: Partial<ReturnType<typeof useStore.getState>> = {}): void {
  useStore.setState({
    ...useStore.getInitialState(),
    // The API answers in English whatever the UI locale is.
    locale: 'ko',
    workspaces: [
      workspace('ws-1', 'alpha', leaf('p1', [surface('s1', 'pty-1', { title: 'migrate billing' })]), 'p1'),
      workspace('ws-2', 'beta', leaf('p2', [
        surface('s2a', 'pty-2a', { title: 'beta shell' }),
        surface('s2b', 'pty-2b', { title: 'beta agent' }),
      ]), 'p2'),
      workspace('ws-3', 'gamma', leaf('p3', [surface('s3', 'pty-3', { title: 'claude' })]), 'p3'),
      workspace('ws-r', 'remote proj', leaf('pr', [surface('rs-1', '', {
        surfaceType: 'remote-terminal', remoteHostId: 'host-1', remoteSessionId: 'rsession-9',
      })]), 'pr'),
      workspace('ws-4', 'delta', branch('b4', [
        leaf('p4', [surface('s4', 'pty-4', { title: 'delta old' })]),
        leaf('p5', [surface('s5', 'pty-5', { title: 'delta recent' })]),
      ]), 'p4'),
    ],
    surfaceAgentStatus: { 'pty-1': 'awaiting_input', 'pty-2b': 'awaiting_input' },
    surfacePendingQuestion: { 'pty-1': 'Run the migration now?', 'pty-2b': 'Which branch should I use?' },
    surfaceAgent: {
      'pty-1': { name: 'Claude Code', status: 'waiting' },
      'pty-3': { name: 'Claude Code', status: 'running' },
    },
    surfaceTurnOpenAt: { 'pty-3': now - 30_000 },
    agentClockMs: now,
    // Output stamps only (they never change a status): they order rows and
    // give idle time. pty-2b spoke more recently than pty-1.
    surfaceOutputAt: {
      'pty-1': now - 5 * 60_000,
      'pty-2b': now - 60_000,
      'pty-4': now - 3 * 3_600_000,
      'pty-5': now - 10 * 60_000,
    },
    missionByPaneGroup: { 'ws-3': { title: 'Ship fleet triage' } as WorkTask },
    remoteWorkspaces: [{
      key: 'host-1:rw-1', hostId: 'host-1', hostLabel: 'office-mac', workspaceId: 'rw-1', name: 'proj',
      panes: [{ sessionId: 'rsession-9', shell: 'zsh', agentName: 'Codex', agentStatus: 'error' }],
    }] as unknown as ReturnType<typeof useStore.getState>['remoteWorkspaces'],
    ...extra,
  });
}
