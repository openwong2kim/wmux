import { describe, it, expect } from 'vitest';
import { evaluateStopGate, DEFAULT_MAX_SNAPSHOT_AGE_MS } from '../stopGate';
import type { FleetSnapshot, FleetSnapshotPane } from '../../../shared/workspaceMirror';

function pane(over: Partial<FleetSnapshotPane> = {}): FleetSnapshotPane {
  return {
    ptyId: 'pane-1',
    agentName: 'Claude Code',
    agentStatus: 'idle',
    isActivePane: false,
    ...over,
  };
}

function snapshot(panes: FleetSnapshotPane[]): FleetSnapshot {
  return { workspaceId: 'ws-1', ts: Date.now(), panes };
}

describe('evaluateStopGate', () => {
  it('blocks while a pane is still running', () => {
    const verdict = evaluateStopGate({
      snapshot: snapshot([pane({ agentStatus: 'running' })]),
      consecutiveBlocks: 0,
    });
    expect(verdict.block).toBe(true);
  });

  it('blocks while a pane is awaiting input', () => {
    const verdict = evaluateStopGate({
      snapshot: snapshot([pane({ agentStatus: 'awaiting_input' })]),
      consecutiveBlocks: 0,
    });
    expect(verdict.block).toBe(true);
  });

  it('allows when every pane is quiescent', () => {
    const verdict = evaluateStopGate({
      snapshot: snapshot([
        pane({ ptyId: 'a', agentStatus: 'idle' }),
        pane({ ptyId: 'b', agentStatus: 'complete' }),
        pane({ ptyId: 'c', agentStatus: 'error' }),
        pane({ ptyId: 'd', agentStatus: 'waiting' }),
      ]),
      consecutiveBlocks: 0,
    });
    expect(verdict.block).toBe(false);
  });

  it('allows on a null snapshot — a derived signal cannot prove absence', () => {
    expect(evaluateStopGate({ snapshot: null, consecutiveBlocks: 0 }).block).toBe(false);
  });

  it('allows once the consecutive-block cap is reached, so the gate cannot trap a turn', () => {
    const busy = snapshot([pane({ agentStatus: 'running' })]);
    expect(evaluateStopGate({ snapshot: busy, consecutiveBlocks: 2 }).block).toBe(true);
    expect(evaluateStopGate({ snapshot: busy, consecutiveBlocks: 3 }).block).toBe(false);
    expect(
      evaluateStopGate({ snapshot: busy, consecutiveBlocks: 1, maxConsecutiveBlocks: 1 }).block,
    ).toBe(false);
  });

  it('names the blocking panes and their statuses in the reason', () => {
    const verdict = evaluateStopGate({
      snapshot: snapshot([
        pane({ ptyId: 'pane-a', agentName: 'worker-a', agentStatus: 'running' }),
        pane({ ptyId: 'pane-b', agentName: null, agentStatus: 'awaiting_input' }),
        pane({ ptyId: 'pane-c', agentName: 'worker-c', agentStatus: 'idle' }),
      ]),
      consecutiveBlocks: 0,
    });
    if (!verdict.block) throw new Error('expected a block');
    expect(verdict.reason).toContain('worker-a (running)');
    // A pane with no agent name falls back to its pty id rather than vanishing.
    expect(verdict.reason).toContain('pane-b (awaiting_input)');
    expect(verdict.reason).not.toContain('worker-c');
  });

  it('allows on a STALE snapshot — a renderer that stopped pushing must not wedge the brain', () => {
    const now = 1_000_000;
    const busy: FleetSnapshot = {
      workspaceId: 'ws-1',
      ts: now - DEFAULT_MAX_SNAPSHOT_AGE_MS - 1,
      panes: [pane({ agentStatus: 'running' })],
    };
    expect(evaluateStopGate({ snapshot: busy, consecutiveBlocks: 0, now }).block).toBe(false);
  });

  it('still blocks on a snapshot that is exactly at the freshness limit', () => {
    const now = 1_000_000;
    const busy: FleetSnapshot = {
      workspaceId: 'ws-1',
      ts: now - DEFAULT_MAX_SNAPSHOT_AGE_MS,
      panes: [pane({ agentStatus: 'running' })],
    };
    expect(evaluateStopGate({ snapshot: busy, consecutiveBlocks: 0, now }).block).toBe(true);
  });

  it('honours an explicit freshness budget', () => {
    const now = 1_000_000;
    const busy: FleetSnapshot = {
      workspaceId: 'ws-1',
      ts: now - 5_000,
      panes: [pane({ agentStatus: 'running' })],
    };
    expect(evaluateStopGate({ snapshot: busy, consecutiveBlocks: 0, now, maxSnapshotAgeMs: 1_000 }).block).toBe(false);
    expect(evaluateStopGate({ snapshot: busy, consecutiveBlocks: 0, now, maxSnapshotAgeMs: 10_000 }).block).toBe(true);
  });

  it('treats renderer clock skew into the future as fresh, not stale', () => {
    const now = 1_000_000;
    const busy: FleetSnapshot = {
      workspaceId: 'ws-1',
      ts: now + 5_000,
      panes: [pane({ agentStatus: 'running' })],
    };
    expect(evaluateStopGate({ snapshot: busy, consecutiveBlocks: 0, now }).block).toBe(true);
  });

  it('cannot block on the orchestrator itself — brain ptys are not in the snapshot', () => {
    // The brain pty carries ENV_KEYS.BRAIN_PTY and is filtered out of every
    // pane listing upstream, so the gate only ever sees worker panes. An empty
    // snapshot is what a workspace whose ONLY session is the brain looks like.
    expect(evaluateStopGate({ snapshot: snapshot([]), consecutiveBlocks: 0 }).block).toBe(false);
  });
});

// A durable active-work record is stronger evidence than the renderer-derived
// pane snapshot: it survives a restart and does not depend on a pane being
// observable. Without it the commander could end its turn the moment every
// worker went quiet, reporting a delegated request as done without ever
// verifying it. The consecutive-block cap still bounds the gate so a broken
// store or tool cannot trap the TUI.
describe('evaluateStopGate — durable active work', () => {
  const work = { id: 'work-42' };
  const quiescent = () => snapshot([pane({ agentStatus: 'idle' })]);

  it('blocks with a finalize instruction when no worker is outstanding', () => {
    const verdict = evaluateStopGate({
      snapshot: quiescent(),
      activeWork: work,
      consecutiveBlocks: 0,
    });
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain('work-42');
    expect(verdict.reason).toContain('deck_complete_work');
  });

  it('blocks even with NO snapshot at all (durable state beats a missing signal)', () => {
    const verdict = evaluateStopGate({ snapshot: null, activeWork: work, consecutiveBlocks: 0 });
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain('deck_complete_work');
  });

  it('blocks on a STALE snapshot, where pane state proves nothing', () => {
    const now = 1_000_000;
    const stale: FleetSnapshot = {
      workspaceId: 'ws-1',
      ts: now - DEFAULT_MAX_SNAPSHOT_AGE_MS - 1,
      panes: [pane({ agentStatus: 'idle' })],
    };
    const verdict = evaluateStopGate({ snapshot: stale, activeWork: work, consecutiveBlocks: 0, now });
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain('deck_complete_work');
  });

  it('appends the finalize instruction to an outstanding-worker refusal', () => {
    const verdict = evaluateStopGate({
      snapshot: snapshot([pane({ agentStatus: 'running' })]),
      activeWork: work,
      consecutiveBlocks: 0,
    });
    expect(verdict.block).toBe(true);
    // Both facts must reach the model: who is still busy AND how to close out.
    expect(verdict.reason).toMatch(/worker/);
    expect(verdict.reason).toContain('deck_complete_work');
    // …and it must NOT fall back to the "just stop again" wording, which is what
    // let the commander end the turn without finalizing.
    expect(verdict.reason).not.toContain('say so and stop again');
  });

  it('still yields to the consecutive-block cap (no unbounded trap)', () => {
    // The cap is 3: block at 2, release at 3 — same boundary as the
    // outstanding-worker path, so a broken store cannot wedge the TUI.
    expect(
      evaluateStopGate({ snapshot: quiescent(), activeWork: work, consecutiveBlocks: 2 }).block,
    ).toBe(true);
    expect(
      evaluateStopGate({ snapshot: quiescent(), activeWork: work, consecutiveBlocks: 3 }).block,
    ).toBe(false);
    expect(
      evaluateStopGate({ snapshot: null, activeWork: work, consecutiveBlocks: 3 }).block,
    ).toBe(false);
    expect(
      evaluateStopGate({
        snapshot: null, activeWork: work, consecutiveBlocks: 1, maxConsecutiveBlocks: 1,
      }).block,
    ).toBe(false);
  });

  it('changes nothing when there is no active work', () => {
    for (const activeWork of [null, undefined]) {
      expect(evaluateStopGate({ snapshot: quiescent(), activeWork, consecutiveBlocks: 0 }).block)
        .toBe(false);
      expect(evaluateStopGate({ snapshot: null, activeWork, consecutiveBlocks: 0 }).block)
        .toBe(false);
    }
  });
});
