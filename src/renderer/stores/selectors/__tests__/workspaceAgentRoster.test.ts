import { describe, it, expect } from 'vitest';
import {
  selectWorkspaceAgentRoster,
  createWorkspaceAgentRosterSelector,
} from '../workspaceAgentRoster';
import { HOOK_RUNNING_TTL_MS } from '../fleet';
import { BRAIN_PTY_ID_PREFIX } from '../../../../shared/constants';
import type { StoreState } from '../../index';
import type { Workspace, Pane, Surface, AgentStatus } from '../../../../shared/types';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function surface(id: string, ptyId: string, extra: Partial<Surface> = {}): Surface {
  return { id, ptyId, title: id, shell: 'pwsh', cwd: `C:\\repo\\${id}`, surfaceType: 'terminal', ...extra };
}
function leaf(id: string, surfaces: Surface[], activeSurfaceId?: string): Pane {
  return { id, type: 'leaf', surfaces, activeSurfaceId: activeSurfaceId ?? surfaces[0]?.id ?? '' };
}
function branch(id: string, children: Pane[]): Pane {
  return { id, type: 'branch', direction: 'horizontal', children };
}
function workspace(id: string, rootPane: Pane, activePaneId: string): Workspace {
  return { id, name: id, rootPane, activePaneId };
}

const NOW = 1_000_000;

interface StateOverrides {
  workspaces?: Workspace[];
  activeWorkspaceId?: string;
  surfaceAgent?: Record<string, { name?: string; status: AgentStatus }>;
  surfaceAgentStatus?: Record<string, AgentStatus>;
  surfacePendingQuestion?: Record<string, string>;
  surfaceActivity?: Record<string, string>;
  surfaceActivityAt?: Record<string, number>;
  surfaceTurnOpenAt?: Record<string, number>;
  paneLabel?: Record<string, string>;
  agentClockMs?: number;
}

function state(overrides: StateOverrides = {}): StoreState {
  return {
    workspaces: [],
    activeWorkspaceId: '',
    surfaceAgent: {},
    surfaceAgentStatus: {},
    surfacePendingQuestion: {},
    surfaceActivity: {},
    surfaceActivityAt: {},
    surfaceTurnOpenAt: {},
    paneLabel: {},
    agentClockMs: NOW,
    ...overrides,
  } as unknown as StoreState;
}

describe('selectWorkspaceAgentRoster', () => {
  it('returns an empty projection for an unknown workspace', () => {
    const r = selectWorkspaceAgentRoster(state(), 'nope');
    expect(r).toEqual({ rows: [], agentCount: 0, needsAttentionCount: 0, stashedCount: 0 });
  });

  it('lists only surfaces that actually carry a detected agent', () => {
    const ws = workspace('ws-1', leaf('p1', [surface('s1', 'pty-1'), surface('s2', 'pty-2')]), 'p1');
    const r = selectWorkspaceAgentRoster(
      state({
        workspaces: [ws],
        // pty-2 has no agent → not an agent row.
        surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'waiting' } },
      }),
      'ws-1',
    );
    expect(r.agentCount).toBe(1);
    expect(r.rows[0]).toMatchObject({ ptyId: 'pty-1', agentName: 'Claude Code', status: 'waiting' });
  });

  it('keeps status attached to the SAME pty, including a background surface', () => {
    // The whole reason this selector does not reuse selectFleetPanes: Fleet
    // aggregates the most urgent status in a leaf onto that leaf's ACTIVE
    // surface, which would report a background tab's status under the wrong
    // agent. Here each row's status must be its own pty's status.
    const ws = workspace(
      'ws-1',
      leaf('p1', [surface('s-bg', 'pty-bg'), surface('s-fg', 'pty-fg')], 's-fg'),
      'p1',
    );
    const r = selectWorkspaceAgentRoster(
      state({
        workspaces: [ws],
        surfaceAgent: {
          'pty-bg': { name: 'Codex', status: 'waiting' },
          'pty-fg': { name: 'Claude Code', status: 'waiting' },
        },
        surfaceAgentStatus: { 'pty-bg': 'awaiting_input' },
      }),
      'ws-1',
    );
    const bg = r.rows.find((x) => x.ptyId === 'pty-bg')!;
    const fg = r.rows.find((x) => x.ptyId === 'pty-fg')!;
    expect(bg.status).toBe('awaiting_input');
    expect(fg.status).toBe('waiting');
    expect(r.needsAttentionCount).toBe(2); // awaiting_input + waiting both need a human
  });

  it('walks nested branches, not just the root leaf', () => {
    const ws = workspace(
      'ws-1',
      branch('b', [
        leaf('p1', [surface('s1', 'pty-1')]),
        branch('b2', [leaf('p2', [surface('s2', 'pty-2')])]),
      ]),
      'p1',
    );
    const r = selectWorkspaceAgentRoster(
      state({
        workspaces: [ws],
        surfaceAgent: {
          'pty-1': { name: 'A', status: 'idle' },
          'pty-2': { name: 'B', status: 'idle' },
        },
      }),
      'ws-1',
    );
    expect(r.rows.map((x) => x.ptyId)).toEqual(['pty-1', 'pty-2']);
  });

  describe('status precedence', () => {
    const base = (extra: StateOverrides) => {
      const ws = workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1');
      return selectWorkspaceAgentRoster(state({ workspaces: [ws], ...extra }), 'ws-1').rows[0];
    };

    it('a transcript-derived pending question is the strongest evidence', () => {
      const row = base({
        surfaceAgent: { 'pty-1': { name: 'A', status: 'running' } },
        surfaceAgentStatus: { 'pty-1': 'complete' },
        surfacePendingQuestion: { 'pty-1': 'Shall I merge?' },
        surfaceActivityAt: { 'pty-1': NOW },
      });
      expect(row.status).toBe('awaiting_input');
      expect(row.pendingQuestion).toBe('Shall I merge?');
      expect(row.needsAttention).toBe(true);
    });

    it('an unseen attention state outranks the retained lifecycle state', () => {
      const row = base({
        surfaceAgent: { 'pty-1': { name: 'A', status: 'running' } },
        surfaceAgentStatus: { 'pty-1': 'error' },
        surfaceActivityAt: { 'pty-1': NOW },
      });
      expect(row.status).toBe('error');
      expect(row.hasAttention).toBe(true);
    });

    it('treats identity-only "running" with NO activity as idle (boot hydration)', () => {
      // A recovered pane is seeded `running` without any activity signal. Left
      // as-is it would pulse forever and disagree with the workspace aggregate.
      const row = base({ surfaceAgent: { 'pty-1': { name: 'A', status: 'running' } } });
      expect(row.status).toBe('idle');
      expect(row.needsAttention).toBe(false);
    });

    it('promotes idle to running on a FRESH activity stamp', () => {
      const row = base({
        surfaceAgent: { 'pty-1': { name: 'A', status: 'idle' } },
        surfaceActivityAt: { 'pty-1': NOW - 1_000 },
        surfaceActivity: { 'pty-1': '✎ fleet.ts' },
      });
      expect(row.status).toBe('running');
      expect(row.activity).toBe('✎ fleet.ts');
    });

    it('does NOT promote on a STALE activity stamp (older than the TTL)', () => {
      const row = base({
        surfaceAgent: { 'pty-1': { name: 'A', status: 'idle' } },
        surfaceActivityAt: { 'pty-1': NOW - HOOK_RUNNING_TTL_MS - 1 },
        surfaceActivity: { 'pty-1': '✎ old.ts' },
      });
      expect(row.status).toBe('idle');
      expect(row.activity).toBeUndefined();
    });

    it('stays running on an OPEN TURN whose activity stamp went stale', () => {
      // The latch is the agent's own claim ("a turn started, nothing ended
      // it"), so it does not decay. Without this the row said "Idle" under a
      // workspace dot that was still amber for the same pane — live-observed
      // as "Claude Code · w1-1 Idle" beside an amber ▶.
      const row = base({
        surfaceAgent: { 'pty-1': { name: 'A', status: 'idle' } },
        surfaceActivityAt: { 'pty-1': NOW - 10 * 60_000 },
        surfaceTurnOpenAt: { 'pty-1': NOW - 10 * 60_000 },
      });
      expect(row.status).toBe('running');
    });

    it('keeps a hydrated running state alive on an open turn', () => {
      // The synthetic-'running' demotion reads the same derivation: a latched
      // pane is working, so it must not be aged down to idle either.
      const row = base({
        surfaceAgent: { 'pty-1': { name: 'A', status: 'running' } },
        surfaceActivityAt: {},
        surfaceTurnOpenAt: { 'pty-1': NOW - 10 * 60_000 },
      });
      expect(row.status).toBe('running');
    });

    it('keeps an explicit complete state even with fresh activity', () => {
      const row = base({
        surfaceAgent: { 'pty-1': { name: 'A', status: 'idle' } },
        surfaceAgentStatus: { 'pty-1': 'complete' },
        surfaceActivityAt: { 'pty-1': NOW },
      });
      expect(row.status).toBe('complete');
    });

    it('hides the activity line for a non-running row', () => {
      const row = base({
        surfaceAgent: { 'pty-1': { name: 'A', status: 'idle' } },
        surfaceAgentStatus: { 'pty-1': 'complete' },
        surfaceActivityAt: { 'pty-1': NOW },
        surfaceActivity: { 'pty-1': '✎ fleet.ts' },
      });
      expect(row.activity).toBeUndefined();
    });
  });

  it('excludes orchestrator brain ptys — a brain is not a fleet agent', () => {
    const brainPty = `${BRAIN_PTY_ID_PREFIX}ws-1`;
    const ws = workspace('ws-1', leaf('p1', [surface('s1', brainPty), surface('s2', 'pty-1')]), 'p1');
    const r = selectWorkspaceAgentRoster(
      state({
        workspaces: [ws],
        surfaceAgent: {
          [brainPty]: { name: 'Claude Code', status: 'running' },
          'pty-1': { name: 'Codex', status: 'idle' },
        },
      }),
      'ws-1',
    );
    expect(r.rows.map((x) => x.ptyId)).toEqual(['pty-1']);
  });

  it('skips unspawned surfaces and non-terminal surfaces', () => {
    const ws = workspace(
      'ws-1',
      leaf('p1', [
        surface('s-empty', ''),
        surface('s-browser', 'pty-browser', { surfaceType: 'browser' }),
        surface('s-term', 'pty-term'),
      ]),
      'p1',
    );
    const r = selectWorkspaceAgentRoster(
      state({
        workspaces: [ws],
        surfaceAgent: {
          'pty-browser': { name: 'X', status: 'idle' },
          'pty-term': { name: 'Y', status: 'idle' },
        },
      }),
      'ws-1',
    );
    expect(r.rows.map((x) => x.ptyId)).toEqual(['pty-term']);
  });

  it('marks isFocused only for the focused surface of the focused pane in the ACTIVE workspace', () => {
    const ws = workspace('ws-1', leaf('p1', [surface('s1', 'pty-1'), surface('s2', 'pty-2')], 's2'), 'p1');
    const agents = {
      'pty-1': { name: 'A', status: 'idle' as AgentStatus },
      'pty-2': { name: 'B', status: 'idle' as AgentStatus },
    };

    const active = selectWorkspaceAgentRoster(
      state({ workspaces: [ws], activeWorkspaceId: 'ws-1', surfaceAgent: agents }),
      'ws-1',
    );
    expect(active.rows.find((x) => x.ptyId === 'pty-2')!.isFocused).toBe(true);
    expect(active.rows.find((x) => x.ptyId === 'pty-1')!.isFocused).toBe(false);

    // A background workspace has no focused row even though its own pane/surface
    // pointers still say so — focus is global.
    const background = selectWorkspaceAgentRoster(
      state({ workspaces: [ws], activeWorkspaceId: 'ws-other', surfaceAgent: agents }),
      'ws-1',
    );
    expect(background.rows.every((x) => !x.isFocused)).toBe(true);
  });

  it('counts only rows that genuinely need a human', () => {
    const ws = workspace(
      'ws-1',
      leaf('p1', [surface('s1', 'p1'), surface('s2', 'p2'), surface('s3', 'p3'), surface('s4', 'p4')]),
      'p1',
    );
    const r = selectWorkspaceAgentRoster(
      state({
        workspaces: [ws],
        surfaceAgent: {
          p1: { name: 'A', status: 'idle' },
          p2: { name: 'B', status: 'idle' },
          p3: { name: 'C', status: 'idle' },
          p4: { name: 'D', status: 'idle' },
        },
        surfaceAgentStatus: {
          p1: 'awaiting_input',
          p2: 'waiting',
          p3: 'error',
          p4: 'complete',
        },
      }),
      'ws-1',
    );
    expect(r.agentCount).toBe(4);
    expect(r.needsAttentionCount).toBe(3); // complete does not need a human
  });

  it('surfaces the pane label and multi-surface position for the row location', () => {
    const ws = workspace('ws-1', leaf('p1', [surface('s1', 'pty-1', { title: 'build' }), surface('s2', 'pty-2')]), 'p1');
    const r = selectWorkspaceAgentRoster(
      state({
        workspaces: [ws],
        paneLabel: { p1: 'api' },
        surfaceAgent: { 'pty-1': { name: 'A', status: 'idle' } },
      }),
      'ws-1',
    );
    expect(r.rows[0]).toMatchObject({
      paneName: 'api',
      surfaceTitle: 'build',
      surfaceIndex: 0,
      surfaceCount: 2,
    });
  });
});

describe('createWorkspaceAgentRosterSelector memoization', () => {
  const ws = workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1');
  const agents = { 'pty-1': { name: 'A', status: 'idle' as AgentStatus } };

  it('returns the SAME reference when nothing this workspace cares about changed', () => {
    // Every WorkspaceItem subscribes independently; without this a write in one
    // workspace would rerender every sidebar row.
    const select = createWorkspaceAgentRosterSelector('ws-1');
    const first = select(state({ workspaces: [ws], surfaceAgent: agents }));
    const second = select(state({
      workspaces: [ws],
      surfaceAgent: agents,
      // An unrelated write: another pane's activity.
      surfaceActivity: { 'pty-elsewhere': '$ noise' },
    }));
    expect(second).toBe(first);
  });

  it('returns a NEW reference when a row actually changes', () => {
    const select = createWorkspaceAgentRosterSelector('ws-1');
    const first = select(state({ workspaces: [ws], surfaceAgent: agents }));
    const second = select(state({
      workspaces: [ws],
      surfaceAgent: agents,
      surfaceAgentStatus: { 'pty-1': 'awaiting_input' },
    }));
    expect(second).not.toBe(first);
    expect(second.rows[0].status).toBe('awaiting_input');
    expect(second.needsAttentionCount).toBe(1);
  });

  it('returns a NEW reference when a row is added or removed', () => {
    const select = createWorkspaceAgentRosterSelector('ws-1');
    const first = select(state({ workspaces: [ws], surfaceAgent: agents }));
    const second = select(state({ workspaces: [ws], surfaceAgent: {} }));
    expect(second).not.toBe(first);
    expect(second.agentCount).toBe(0);
  });
});

// ─── Stashed panes (#977) ───────────────────────────────────────────────────
//
// Stashed rows differ from the visible ones in two deliberate ways: the agent
// gate is relaxed, and there is one row per PANE rather than per surface.

function stashed(pane: Pane, stashedAt = NOW - 7_200_000) {
  return { pane: pane as Extract<Pane, { type: 'leaf' }>, stashedAt };
}

describe('selectWorkspaceAgentRoster — stashed panes', () => {
  it('gives a stashed shell pane a row even with no detected agent', () => {
    // A visible shell pane is excluded so the roster does not flood with plain
    // terminals — the user can see those. A stashed one appears NOWHERE else in
    // the app, so excluding it would make a running session a ghost.
    const visibleShell = leaf('p1', [surface('s1', 'pty-1')]);
    const stashedShell = leaf('p2', [surface('s2', 'pty-2')]);
    const ws = { ...workspace('ws-1', visibleShell, 'p1'), stashedPanes: [stashed(stashedShell)] };

    const r = selectWorkspaceAgentRoster(state({ workspaces: [ws], activeWorkspaceId: 'ws-1' }), 'ws-1');

    expect(r.agentCount).toBe(0);
    expect(r.stashedCount).toBe(1);
    expect(r.rows.map((row) => row.paneId)).toEqual(['p2']);
    expect(r.rows[0].stashed).toBe(true);
    expect(r.rows[0].stashedAt).toBe(NOW - 7_200_000);
  });

  it('emits ONE row per stashed pane, not one per surface', () => {
    const stashedPane = leaf('p2', [surface('s2a', 'pty-2a'), surface('s2b', 'pty-2b')], 's2b');
    const ws = { ...workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1'), stashedPanes: [stashed(stashedPane)] };

    const r = selectWorkspaceAgentRoster(
      state({
        workspaces: [ws],
        activeWorkspaceId: 'ws-1',
        surfaceAgent: { 'pty-2a': { name: 'Claude Code', status: 'idle' }, 'pty-2b': { name: 'Codex', status: 'idle' } },
      }),
      'ws-1',
    );

    expect(r.stashedCount).toBe(1);
    // The pane's ACTIVE surface represents it, with the #n/m trailer showing
    // there is more behind the row.
    expect(r.rows[0].surfaceId).toBe('s2b');
    expect(r.rows[0].surfaceCount).toBe(2);
  });

  it('represents the pane with a LIVE tab, not a dead remembered-active one', () => {
    // activeSurfaceId points at whatever was on top when the pane left the
    // screen. If THAT session died while a sibling is still running, showing the
    // dead one reports the pane as exited while an agent works behind it.
    const stashedPane = leaf('p2', [surface('s2a', ''), surface('s2b', 'pty-2b')], 's2a');
    const ws = { ...workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1'), stashedPanes: [stashed(stashedPane)] };

    const r = selectWorkspaceAgentRoster(state({ workspaces: [ws], activeWorkspaceId: 'ws-1' }), 'ws-1');

    expect(r.rows[0].surfaceId).toBe('s2b');
    expect(r.rows[0].stashedLiveness).toBe('alive');
  });

  it('prefers a live tab with a detected agent when the active tab is dead', () => {
    const stashedPane = leaf('p2', [surface('s2a', 'pty-2a'), surface('s2b', 'pty-2b')], 's2-gone');
    const ws = { ...workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1'), stashedPanes: [stashed(stashedPane)] };

    const r = selectWorkspaceAgentRoster(
      state({
        workspaces: [ws],
        activeWorkspaceId: 'ws-1',
        surfaceAgent: { 'pty-2b': { name: 'Claude Code', status: 'idle' } },
      }),
      'ws-1',
    );

    expect(r.rows[0].surfaceId).toBe('s2b');
    expect(r.rows[0].agentName).toBe('Claude Code');
  });

  it('still falls back to the remembered active tab when nothing is live', () => {
    const stashedPane = leaf('p2', [surface('s2a', ''), surface('s2b', '')], 's2b');
    const ws = { ...workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1'), stashedPanes: [stashed(stashedPane)] };

    const r = selectWorkspaceAgentRoster(state({ workspaces: [ws], activeWorkspaceId: 'ws-1' }), 'ws-1');

    expect(r.rows[0].surfaceId).toBe('s2b');
    expect(r.rows[0].stashedLiveness).toBe('exited');
  });

  it('appends stashed rows AFTER the visible agents', () => {
    const visible = leaf('p1', [surface('s1', 'pty-1')]);
    const ws = {
      ...workspace('ws-1', visible, 'p1'),
      stashedPanes: [stashed(leaf('p2', [surface('s2', 'pty-2')]))],
    };

    const r = selectWorkspaceAgentRoster(
      state({
        workspaces: [ws],
        activeWorkspaceId: 'ws-1',
        surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'idle' } },
      }),
      'ws-1',
    );

    expect(r.rows.map((row) => row.paneId)).toEqual(['p1', 'p2']);
    expect(r.rows[0].stashed).toBeUndefined();
    expect(r.rows[1].stashed).toBe(true);
  });

  it('derives liveness from surface ptyIds, never from a stored field', () => {
    const alive = leaf('p2', [surface('s2', ''), surface('s3', 'pty-3')]);
    const dead = leaf('p3', [surface('s4', ''), surface('s5', '')]);
    const ws = {
      ...workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1'),
      stashedPanes: [stashed(alive), stashed(dead)],
    };

    const r = selectWorkspaceAgentRoster(state({ workspaces: [ws], activeWorkspaceId: 'ws-1' }), 'ws-1');

    // ONE live terminal is enough — same rule a visible multi-tab pane follows.
    expect(r.rows.find((row) => row.paneId === 'p2')!.stashedLiveness).toBe('alive');
    expect(r.rows.find((row) => row.paneId === 'p3')!.stashedLiveness).toBe('exited');
  });

  it('flags an exited pane as needing attention — the session died off-screen', () => {
    const dead = leaf('p2', [surface('s2', '')]);
    const ws = { ...workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1'), stashedPanes: [stashed(dead)] };

    const r = selectWorkspaceAgentRoster(state({ workspaces: [ws], activeWorkspaceId: 'ws-1' }), 'ws-1');

    expect(r.rows[0].needsAttention).toBe(true);
    expect(r.needsAttentionCount).toBe(1);
  });

  it('carries a stashed agent’s pending question through', () => {
    const stashedPane = leaf('p2', [surface('s2', 'pty-2')]);
    const ws = { ...workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1'), stashedPanes: [stashed(stashedPane)] };

    const r = selectWorkspaceAgentRoster(
      state({
        workspaces: [ws],
        activeWorkspaceId: 'ws-1',
        surfaceAgent: { 'pty-2': { name: 'Claude Code', status: 'idle' } },
        surfacePendingQuestion: { 'pty-2': 'Apply this patch?' },
      }),
      'ws-1',
    );

    expect(r.rows[0].status).toBe('awaiting_input');
    expect(r.rows[0].pendingQuestion).toBe('Apply this patch?');
    expect(r.rows[0].needsAttention).toBe(true);
  });

  it('never marks a stashed row focused — it is not on screen', () => {
    const stashedPane = leaf('p2', [surface('s2', 'pty-2')]);
    const ws = { ...workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1'), stashedPanes: [stashed(stashedPane)] };

    const r = selectWorkspaceAgentRoster(state({ workspaces: [ws], activeWorkspaceId: 'ws-1' }), 'ws-1');

    expect(r.rows[0].isFocused).toBe(false);
  });

  it('skips malformed stash entries instead of throwing', () => {
    const ws = {
      ...workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1'),
      stashedPanes: [
        null,
        { stashedAt: NOW },
        stashed(leaf('p2', [surface('s2', 'pty-2')])),
      ],
    } as unknown as Workspace;

    const r = selectWorkspaceAgentRoster(state({ workspaces: [ws], activeWorkspaceId: 'ws-1' }), 'ws-1');

    expect(r.stashedCount).toBe(1);
    expect(r.rows[0].paneId).toBe('p2');
  });

  it('keeps the memoised projection stable until the stash changes', () => {
    const stashedPane = leaf('p2', [surface('s2', 'pty-2')]);
    const ws = { ...workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1'), stashedPanes: [stashed(stashedPane)] };
    const select = createWorkspaceAgentRosterSelector('ws-1');
    const s = state({ workspaces: [ws], activeWorkspaceId: 'ws-1' });

    const first = select(s);
    expect(select(state({ workspaces: [ws], activeWorkspaceId: 'ws-1' }))).toBe(first);

    const unstashed = { ...ws, stashedPanes: [] };
    expect(select(state({ workspaces: [unstashed], activeWorkspaceId: 'ws-1' }))).not.toBe(first);
  });
});
