import { describe, it, expect } from 'vitest';
import { selectFleetSectionCounts, selectWorkspaceAttentionClasses } from '../fleet';
import type { StoreState } from '../../index';
import type { AgentStatus, Pane, Surface, Workspace } from '../../../../shared/types';

// Owner decision 2026-10-07: "needs you" means you must act — a question,
// approval or permission dialog is open. The sidebar's dash, Fleet's Needs you
// count and the titlebar count (both selectFleetSectionCounts) must agree on
// it, and a turn that merely ended on a question counts in none of them.

const surface = (id: string, ptyId: string): Surface => ({
  id, ptyId, title: id, shell: 'zsh', cwd: '/repo', surfaceType: 'terminal',
});
const workspace = (id: string): Workspace => ({
  id, name: id, activePaneId: `${id}-p`,
  rootPane: { id: `${id}-p`, type: 'leaf', surfaces: [surface(`${id}-s`, `pty-${id}`)], activeSurfaceId: `${id}-s` } as Pane,
});

function state(agents: Record<string, AgentStatus>, extra: Partial<Record<string, unknown>> = {}): StoreState {
  const ids = Object.keys(agents);
  return {
    workspaces: ids.map(workspace),
    activeWorkspaceId: '',
    surfaceAgent: Object.fromEntries(ids.map((id) => [`pty-${id}`, { name: 'Claude Code', status: agents[id] }])),
    surfaceAgentStatus: {},
    surfacePendingQuestion: {},
    surfaceActivity: {},
    surfaceActivityAt: {},
    paneLabel: {},
    agentClockMs: 1_000_000,
    remoteWorkspaces: [],
    ...extra,
  } as unknown as StoreState;
}

describe('needs-you counts agree with the sidebar', () => {
  it('a turn that ended on a question is finished everywhere; a dialog is needs you everywhere', () => {
    const s = state(
      { ended: 'waiting', dialog: 'awaiting_input' },
      {
        surfaceAgentStatus: { 'pty-ended': 'waiting' },
        surfacePendingQuestion: { 'pty-ended': 'Want me to open a PR?' },
      },
    );
    const classes = selectWorkspaceAttentionClasses(s);
    expect(classes.ended).toBe('finished');
    expect(classes.dialog).toBe('needsYou');
    // Fleet's Needs you section and the titlebar count read this.
    expect(selectFleetSectionCounts(s).needsYou).toBe(1);
  });
});
