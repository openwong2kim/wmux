import { describe, it, expect } from 'vitest';
import { selectWorkspaceAgentStatus, selectAllWorkspaceAgentStatus } from '../fleet';
import { selectWorkspaceAgentRoster } from '../workspaceAgentRoster';
import type { StoreState } from '../../index';
import type { Workspace, Pane, PaneLeaf, Surface, AgentStatus } from '../../../../shared/types';

// ─── #1168 — the sidebar dot and the roster underneath it must agree ─────────
//
// `selectWorkspaceAgentStatus` (the dot, and via selectAllWorkspaceAgentStatus
// the MiniSidebar, the titlebar vitals and the deck Fleet) rolls up
// `selectFleetPanes`; the row list under the same workspace comes from
// `selectWorkspaceAgentRoster`. They are separate derivations on purpose — the
// roster is per-surface and agent-gated, the fleet pass is per-leaf and gates on
// nothing — so this file does NOT assert they are equal.
//
// It asserts the one direction that is a real contract: when the roster says a
// row needs the user, the dot above it must say so too. The reverse does not
// hold (a non-agent pane can carry an attention status the roster excludes), and
// pinning it would be pinning a coincidence.
//
// Both selectors are fed the SAME state object in every case here. Deriving the
// expectation from a second, hand-written fixture is how the two drifted apart
// in the first place.

// Statuses the roster counts as needsAttention (workspaceAgentRoster's
// `needsAttention`). Spelled out rather than imported so a change to that
// predicate has to be made deliberately in both places.
const NEEDS_YOU: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'awaiting_input',
  'waiting',
  'error',
]);

function surface(id: string, ptyId: string, extra: Partial<Surface> = {}): Surface {
  return { id, ptyId, title: id, shell: 'pwsh', cwd: `C:\\repo\\${id}`, surfaceType: 'terminal', ...extra };
}
function leaf(id: string, surfaces: Surface[], activeSurfaceId?: string): PaneLeaf {
  return { id, type: 'leaf', surfaces, activeSurfaceId: activeSurfaceId ?? surfaces[0]?.id ?? '' };
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
    paneLabel: {},
    agentClockMs: NOW,
    ...overrides,
  } as unknown as StoreState;
}

/**
 * The contract, asserted against every consumer of the roll-up at once: if any
 * roster row wants the user, the single-workspace dot AND the all-workspaces map
 * (MiniSidebar's source) must both report a needs-you status.
 */
function expectDotCoversRoster(s: StoreState, workspaceId: string): void {
  const roster = selectWorkspaceAgentRoster(s, workspaceId);
  if (!roster.rows.some((row) => row.needsAttention)) return;
  const dot = selectWorkspaceAgentStatus(s, workspaceId);
  expect(NEEDS_YOU.has(dot)).toBe(true);
  const all = selectAllWorkspaceAgentStatus(s)[workspaceId] ?? 'idle';
  expect(NEEDS_YOU.has(all)).toBe(true);
}

describe('#1168 — workspace dot vs. roster', () => {
  it('reports the pane as awaiting input when a transcript-derived question is pending', () => {
    // The failure this pins: the stop payload settled the pane to 'complete'
    // (a green dot) while the transcript scan found an unanswered question. The
    // roster promotes that to awaiting_input and prints the question; the dot
    // read green over the top of it.
    const s = state({
      workspaces: [workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1')],
      surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'complete' } },
      surfaceAgentStatus: { 'pty-1': 'complete' },
      surfacePendingQuestion: { 'pty-1': 'Which branch should I target?' },
    });

    expect(selectWorkspaceAgentRoster(s, 'ws-1').rows[0]).toMatchObject({
      status: 'awaiting_input',
      needsAttention: true,
    });
    expect(selectWorkspaceAgentStatus(s, 'ws-1')).toBe('awaiting_input');
    expectDotCoversRoster(s, 'ws-1');
  });

  it('finds a pending question on a BACKGROUND tab of the active pane', () => {
    // The dot's whole reason to exist is the pane the user is not looking at.
    const s = state({
      workspaces: [
        workspace(
          'ws-1',
          leaf('p1', [surface('s-bg', 'pty-bg'), surface('s-fg', 'pty-fg')], 's-fg'),
          'p1',
        ),
      ],
      surfaceAgent: {
        'pty-bg': { name: 'Claude Code', status: 'complete' },
        'pty-fg': { name: 'Codex', status: 'idle' },
      },
      surfacePendingQuestion: { 'pty-bg': 'Overwrite the existing file?' },
    });

    expect(selectWorkspaceAgentStatus(s, 'ws-1')).toBe('awaiting_input');
    expectDotCoversRoster(s, 'ws-1');
  });

  it('reports a stashed pane whose session died as an error, not a neutral dot', () => {
    // Reconcile clears ptyId when the daemon confirms the session is gone, so
    // every terminal surface here is dead — `stashedPaneLiveness` → 'exited'.
    // The roster calls that error/needsAttention; the dot showed grey.
    const dead = leaf('p-st', [surface('s-st', '')]);
    const ws: Workspace = {
      ...workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1'),
      stashedPanes: [{ pane: dead, stashedAt: NOW - 60_000 }],
    };
    const s = state({
      workspaces: [ws],
      surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'idle' } },
    });

    const stashedRow = selectWorkspaceAgentRoster(s, 'ws-1').rows.find((r) => r.stashed);
    expect(stashedRow).toMatchObject({ stashedLiveness: 'exited', status: 'error', needsAttention: true });
    expect(selectWorkspaceAgentStatus(s, 'ws-1')).toBe('error');
    expectDotCoversRoster(s, 'ws-1');
  });

  it('lights the dot for a question asked by a pane that is stashed, not on screen', () => {
    // #977's rule ("a stashed agent is off-screen, not off-duty") meets #1168:
    // the stash is the one place where the dot is the ONLY thing that can carry
    // the signal, since the pane is on no other surface in the app.
    const stashed = leaf('p-st', [surface('s-st', 'pty-st')]);
    const ws: Workspace = {
      ...workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1'),
      stashedPanes: [{ pane: stashed, stashedAt: NOW - 60_000 }],
    };
    const s = state({
      workspaces: [ws],
      surfaceAgent: {
        'pty-1': { name: 'Claude Code', status: 'idle' },
        'pty-st': { name: 'Claude Code', status: 'complete' },
      },
      surfacePendingQuestion: { 'pty-st': 'Run the migration?' },
    });

    const stashedRow = selectWorkspaceAgentRoster(s, 'ws-1').rows.find((r) => r.stashed);
    expect(stashedRow).toMatchObject({ status: 'awaiting_input', needsAttention: true });
    expect(selectWorkspaceAgentStatus(s, 'ws-1')).toBe('awaiting_input');
    expectDotCoversRoster(s, 'ws-1');
  });

  it('leaves a live stashed pane alone', () => {
    // The guard on the fix above: only an EXITED stash is promoted. A stashed
    // pane that is still running keeps deriving its status normally, or every
    // stash gesture would light the workspace red.
    const alive = leaf('p-st', [surface('s-st', 'pty-st')]);
    const ws: Workspace = {
      ...workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1'),
      stashedPanes: [{ pane: alive, stashedAt: NOW - 60_000 }],
    };
    const s = state({
      workspaces: [ws],
      surfaceAgent: {
        'pty-1': { name: 'Claude Code', status: 'idle' },
        'pty-st': { name: 'Claude Code', status: 'idle' },
      },
    });

    expect(selectWorkspaceAgentStatus(s, 'ws-1')).toBe('idle');
  });

  it('leaves a quiet workspace neutral', () => {
    const s = state({
      workspaces: [workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1')],
      surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'idle' } },
    });

    expect(selectWorkspaceAgentStatus(s, 'ws-1')).toBe('idle');
    expect(selectAllWorkspaceAgentStatus(s)['ws-1']).toBeUndefined();
  });

  it('ignores a question left on a pty no surface holds any more', () => {
    // paneSlice deletes the entry when a surface closes, but the map is keyed by
    // ptyId and outlives a single render. A stale key must not light a dot for a
    // workspace that has nothing to answer.
    const s = state({
      workspaces: [workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1')],
      surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'idle' } },
      surfacePendingQuestion: { 'pty-gone': 'Anybody?' },
    });

    expect(selectWorkspaceAgentStatus(s, 'ws-1')).toBe('idle');
  });

  it('ignores a whitespace-only question the way the roster does', () => {
    const s = state({
      workspaces: [workspace('ws-1', leaf('p1', [surface('s1', 'pty-1')]), 'p1')],
      surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'idle' } },
      surfacePendingQuestion: { 'pty-1': '   ' },
    });

    expect(selectWorkspaceAgentRoster(s, 'ws-1').rows[0]?.status).toBe('idle');
    expect(selectWorkspaceAgentStatus(s, 'ws-1')).toBe('idle');
  });
});
