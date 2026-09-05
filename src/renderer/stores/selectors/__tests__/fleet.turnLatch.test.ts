// @vitest-environment jsdom
//
// The hook TURN LATCH, driven through the REAL store.
//
// These cases deliberately do not hand `selectFleetPanes` a literal fixture:
// the bug they pin was that the renderer had no way to STORE 'running' at all
// (`setSurfaceAgentStatus` keeps only the attention statuses, `markSurfaceRunning`
// stamps a timestamp that decays in 120 s), so a fixture seeding
// `surfaceAgentStatus['x'] = 'running'` tested a state the store rejects. Every
// seed below goes through the same actions `useNotificationListener` calls on a
// METADATA_UPDATE, so what the selector sees is what the app can actually hold.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '../../index';
import {
  selectFleetPanes,
  selectWorkspaceUnverifiableMinutes,
  selectUnverifiablePaneMinutes,
  formatStaleMinutes,
  isPaneAgentBusy,
  HOOK_RUNNING_TTL_MS,
  UNVERIFIABLE_AFTER_MS,
} from '../fleet';
import type { AgentStatus, Pane, Surface, Workspace } from '../../../../shared/types';

const NOW = 1_700_000_000_000;
const PTY = 'pty-run';

const surface = (id: string, ptyId: string): Surface => ({
  id, ptyId, title: id, shell: 'pwsh', cwd: '/repo', surfaceType: 'terminal',
});
const leaf = (id: string, surfaces: Surface[]): Pane => ({
  id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0].id,
});
// Two leaves under a branch: the closePane case below needs the pane to HAVE a
// parent (the root leaf has none), and a sibling also proves the latch is
// per-pty rather than per-workspace.
const workspace = (): Workspace => ({
  id: 'ws', name: 'ws',
  rootPane: {
    id: 'root', type: 'branch', direction: 'horizontal',
    children: [leaf('pane', [surface('surf', PTY)]), leaf('pane2', [surface('surf2', 'pty-other')])],
  },
  activePaneId: 'pane',
});

/**
 * The renderer half of a METADATA_UPDATE, in the order useNotificationListener
 * applies it: the status write first (which withdraws the turn latch on every
 * status that ends a turn), then the running stamps, then the latch itself —
 * opened ONLY when the payload carries the turn-start hook kind.
 */
function applyMetadata(payload: {
  agentStatus: AgentStatus;
  hookKind?: string;
}): void {
  const s = useStore.getState();
  s.setSurfaceAgentStatus(PTY, payload.agentStatus);
  if (payload.agentStatus === 'running') {
    s.markSurfaceRunning(PTY);
    if (payload.hookKind === 'agent.user_prompt_submit') s.markSurfaceTurnOpen(PTY);
  }
}

/** Move the read-time clock forward without moving the stamps already written. */
function advance(ms: number): void {
  vi.setSystemTime(NOW + ms);
  useStore.getState().bumpAgentClock();
}

function pane() {
  const p = selectFleetPanes(useStore.getState()).find((x) => x.ptyId === PTY);
  if (!p) throw new Error('pane missing from the fleet');
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  useStore.setState({
    workspaces: [workspace()],
    activeWorkspaceId: 'ws',
    surfaceAgentStatus: {},
    surfaceActivityAt: {},
    surfaceTurnOpenAt: {},
    surfaceAgent: { [PTY]: { name: 'Claude Code', status: 'running' } },
    surfacePendingQuestion: {},
    commandRunningByPtyId: {},
    agentAliveByPtyId: {},
    agentClockMs: NOW,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('hook turn latch — the pane stays running while the turn is open', () => {
  it('survives ten minutes of total silence', () => {
    applyMetadata({ agentStatus: 'running', hookKind: 'agent.user_prompt_submit' });
    expect(pane().agentStatus).toBe('running');
    // Five times the activity TTL. A long bash, a web search, silent reasoning:
    // the byte heuristic no longer broadcasts anything on a governed pane, so
    // before the latch this pane went idle MID-TURN and could not come back.
    advance(10 * 60_000);
    expect(pane().agentStatus).toBe('running');
    expect(pane().unverifiable).toBe(false);
  });

  it('still decays at the 120 s TTL when no hook opened a turn', () => {
    // The byte-rate path: `running` with no turn-start hook behind it.
    applyMetadata({ agentStatus: 'running' });
    expect(pane().agentStatus).toBe('running');
    advance(HOOK_RUNNING_TTL_MS + 1_000);
    expect(pane().agentStatus).toBe('idle');
  });

  it('flips to unverifiable at 31 minutes, without changing the status', () => {
    applyMetadata({ agentStatus: 'running', hookKind: 'agent.user_prompt_submit' });
    advance(UNVERIFIABLE_AFTER_MS - 60_000);
    expect(pane().unverifiable).toBe(false);
    advance(31 * 60_000);
    const p = pane();
    // A rendition, not a sixth AgentStatus: the roll-up ranking and the
    // needs-you ordering must be untouched.
    expect(p.agentStatus).toBe('running');
    expect(p.unverifiable).toBe(true);
    expect(p.staleForMs).toBe(31 * 60_000);
    expect(selectWorkspaceUnverifiableMinutes(useStore.getState(), 'ws')).toBe(31);
    expect(selectUnverifiablePaneMinutes(useStore.getState())).toEqual({ [PTY]: 31 });
  });

  it('a Stop closes the latch and the pane settles', () => {
    applyMetadata({ agentStatus: 'running', hookKind: 'agent.user_prompt_submit' });
    advance(5 * 60_000);
    expect(pane().agentStatus).toBe('running');
    // The turn end. 'complete' is an attention status, so it shows as itself…
    applyMetadata({ agentStatus: 'complete' });
    expect(useStore.getState().surfaceTurnOpenAt[PTY]).toBeUndefined();
    expect(pane().agentStatus).toBe('complete');
    // …and once the user has seen it (the focus clear in Pane.tsx), the pane is
    // idle rather than snapping back to a running dot the latch would restore.
    useStore.getState().setSurfaceAgentStatus(PTY, null);
    advance(6 * 60_000);
    expect(pane().agentStatus).toBe('idle');
  });

  it('an idle broadcast (process death, or main’s turn expiry) closes it too', () => {
    applyMetadata({ agentStatus: 'running', hookKind: 'agent.user_prompt_submit' });
    applyMetadata({ agentStatus: 'idle' });
    expect(useStore.getState().surfaceTurnOpenAt[PTY]).toBeUndefined();
    advance(5 * 60_000);
    expect(pane().agentStatus).toBe('idle');
  });

  it('a dead agent process is idle, not unverifiable', () => {
    applyMetadata({ agentStatus: 'running', hookKind: 'agent.user_prompt_submit' });
    useStore.setState({ agentAliveByPtyId: { [PTY]: false } });
    advance(31 * 60_000);
    expect(pane().unverifiable).toBe(false);
  });

  it('closing the pane drops the latch so a reused ptyId cannot inherit it', () => {
    applyMetadata({ agentStatus: 'running', hookKind: 'agent.user_prompt_submit' });
    useStore.getState().closePane('pane');
    expect(useStore.getState().surfaceTurnOpenAt[PTY]).toBeUndefined();
  });

  it('keeps the resume chip away while a quiet turn is open', () => {
    // isPaneAgentBusy tier 3 — the chip would otherwise pop over a live TUI as
    // soon as the activity stamp aged out.
    expect(isPaneAgentBusy({
      activityAt: NOW - 10 * 60_000,
      agentClockMs: NOW,
      status: undefined,
      turnOpen: true,
    })).toBe(true);
    expect(isPaneAgentBusy({
      activityAt: NOW - 10 * 60_000,
      agentClockMs: NOW,
      status: undefined,
      turnOpen: false,
    })).toBe(false);
  });

  it('caps the silence label at the horizon it can stand behind', () => {
    expect(formatStaleMinutes(29)).toBe('29m');
    expect(formatStaleMinutes(30)).toBe('30m+');
    expect(formatStaleMinutes(125)).toBe('30m+');
  });
});
